#!/usr/bin/env node
/**
 * x402-paid LLM gateway, zero dependencies.
 * Sells access to free upstream models: no marginal cost, so every cent received is margin.
 *
 * Env: PAY_TO (0x address), FACILITATOR (default x402.org), UPSTREAM_KEY (openrouter),
 *      PORT (8080), PRICE_USD (0.005), NETWORK (eip155:845 = Base mainnet).
 * Run: node gateway.js            serve
 *      node gateway.js --selftest assert challenge + header logic
 */
const http = require('http');
const crypto = require('crypto');

const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDC_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const USDC_SOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL_MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const SOL_FEEPAYER = 'DeXterR2kQm8AvRHnNPatWkE46TfAcMeBDjb6FySoAb8'; // dexter pays the gas
/** Network profile: which chain, which USDC, which extra fields the challenge needs. */
function profile(network) {
  if (network.startsWith('solana'))
    return { network, asset: USDC_SOL, atomic: 1e6, extra: { feePayer: SOL_FEEPAYER, decimals: 6 } };
  if (network === 'eip155:845') return { network, asset: USDC_BASE, atomic: 1e6, extra: { name: 'USDC', version: '2' } };
  return { network, asset: USDC_SEPOLIA, atomic: 1e6, extra: { name: 'USDC', version: '2' } };
}
const env = process.env;
const CFG = {
  payTo: env.PAY_TO || '',
  facilitator: env.FACILITATOR || 'https://x402.org/facilitator',
  upstream: env.UPSTREAM || 'https://openrouter.ai/api/v1',
  upstreamKey: env.UPSTREAM_KEY || '',
  port: +(env.PORT || 8080),
  price: +(env.PRICE_USD || 0.005),
  network: env.NETWORK || SOL_MAINNET,
};

// Validated 2026-11-25 against the live free tier; order = fastest first. Others 429.
const FREE_MODELS = [
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  'nvidia/nemotron-3.5-lightning:free',
  'liquid/lfm-3-1.7b:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'baidu/ernie-5.5-flash-preview:free',
  'recursive/flint-v1.0:free',
];

/** x402 payment requirement block for one resource. */
function challenge(resource, priceUsd = CFG.price) {
  const p = profile(CFG.network);
  return {
    x402Version: 2,
    accepts: [{
      scheme: 'exact',
      network: p.network,
      asset: p.asset,
      payTo: CFG.payTo,
      maxAmountRequired: Math.round(priceUsd * p.atomic).toString(), // USDC has 6 decimals
      resource,
      description: 'OpenAI-compatible chat completion, cheap models, no signup',
      mimeType: 'application/json',
      maxTimeoutSeconds: 60,
      extra: p.extra,
    }],
  };
}

/** Decode the base64 X-PAYMENT header into its payload object. Throws on garbage. */
function decodePayment(header) {
  if (!header) throw new Error('missing X-PAYMENT');
  const obj = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  if (!obj || typeof obj !== 'object' || !obj.payload) throw new Error('malformed payment payload');
  return obj;
}

async function facilitator(path, body) {
  const r = await fetch(CFG.facilitator + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const text = await r.text();
  try { return JSON.parse(text); } catch { return { success: false, error: text.slice(0, 200) }; }
}

function send(res, code, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = `https://${req.headers.host}${req.url.split('?')[0]}`;

  if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true, network: CFG.network });
  if (req.method === 'GET' && (req.url === '/models' || req.url === '/v1/models'))
    return send(res, 200, { object: 'list', data: FREE_MODELS.map(id => ({ id, object: 'model' })) });
  if (req.method === 'GET' && req.url === '/.well-known/x402')
    return send(res, 200, [{ resource: url.replace(/\/$/, '') + 'v1/chat/completions', ...challenge(url.replace(/\/$/, '') + 'v1/chat/completions') }]);

  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    const payHeader = req.headers['x-payment'];
    if (!payHeader) return send(res, 402, challenge(url), { 'WWW-Authenticate': 'x402' });

    let payload;
    try { payload = decodePayment(payHeader); } catch (e) { return send(res, 402, { error: e.message, ...challenge(url) }); }

    const reqs = challenge(url).accepts[0];
    const verify = await facilitator('/verify', { x402Version: 2, paymentPayload: payload, paymentRequirements: reqs });
    if (!verify.success && verify.isValid !== true)
      return send(res, 402, { error: 'payment verification failed', detail: verify.error || verify.invalidReason || verify });

    let body = '';
    for await (const chunk of req) body += chunk;
    let upstreamBody = {};
    try { upstreamBody = JSON.parse(body || '{}'); } catch { return send(res, 400, { error: 'invalid json' }); }
    upstreamBody.model = FREE_MODELS.includes(upstreamBody.model) ? upstreamBody.model : FREE_MODELS[0];

    // Free tier 429s under load, so walk the fallback chain before giving up.
    let reply = null, lastErr = '';
    const order = [upstreamBody.model, ...FREE_MODELS.filter(m => m !== upstreamBody.model)];
    for (const model of order) {
      try {
        const r = await fetch(CFG.upstream + '/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CFG.upstreamKey}` },
          body: JSON.stringify({ ...upstreamBody, model }),
          signal: AbortSignal.timeout(60000),
        });
        const j = await r.json();
        if (j && j.choices && j.choices.length) { reply = j; break; }
        lastErr = (j && j.error && (j.error.message || j.error)) || `status ${r.status}`;
      } catch (e) { lastErr = e.message; }
    }
    if (!reply) return send(res, 502, { error: 'all upstream models busy: ' + lastErr });

    // Settle only after the goods are delivered, so a failed call is never charged.
    const settle = await facilitator('/settle', { x402Version: 2, paymentPayload: payload, paymentRequirements: reqs });
    const receipt = Buffer.from(JSON.stringify(settle)).toString('base64');
    return send(res, 200, reply, { 'X-PAYMENT-RESPONSE': receipt });
  }

  send(res, 404, { error: 'not found' });
});

function selftest() {
  const assert = require('assert');
  CFG.payTo = '0x1111111111111111111111111111111111111111';
  CFG.network = 'eip155:845';
  const c = challenge('https://x.example/v1/chat/completions');
  assert.strictEqual(c.x402Version, 2);
  assert.strictEqual(c.accepts[0].asset, USDC_BASE);
  assert.strictEqual(c.accepts[0].maxAmountRequired, '5000', '0.005 USDC = 5000 micro-units');
  assert.strictEqual(c.accepts[0].payTo, CFG.payTo);
  CFG.price = 0.02;
  assert.strictEqual(challenge('x').accepts[0].maxAmountRequired, '20000');
  CFG.network = SOL_MAINNET;
  const s = challenge('x').accepts[0];
  assert.strictEqual(s.asset, USDC_SOL, 'solana profile must quote the solana USDC mint');
  assert.strictEqual(s.extra.decimals, 6);
  assert.strictEqual(s.extra.feePayer, SOL_FEEPAYER, 'gas sponsored by facilitator');
  CFG.network = 'eip155:84532';
  assert.strictEqual(challenge('x').accepts[0].asset, USDC_SEPOLIA);
  const good = Buffer.from(JSON.stringify({ payload: { signature: '0xdead' } })).toString('base64');
  assert.deepStrictEqual(decodePayment(good).payload, { signature: '0xdead' });
  assert.throws(() => decodePayment(''), /missing/);
  assert.throws(() => decodePayment('notbase64!!'), /malformed|JSON/);
  console.log('selftest ok');
}

if (process.argv.includes('--selftest')) selftest();
else if (!CFG.payTo) { console.error('PAY_TO not set'); process.exit(1); }
else server.listen(CFG.port, () => console.log(`gateway on :${CFG.port} network=${CFG.network} price=$${CFG.price}`));
