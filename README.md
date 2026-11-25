# x402 LLM gateway

An OpenAI-compatible chat completion endpoint that charges **$0.005 USDC per call** over
[x402](https://x402.org). No signup, no API key, no account: the HTTP 402 challenge is the
only onboarding step.

- **Network**: Solana mainnet (`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`), USDC, gas sponsored
  by the facilitator, so neither side needs SOL for fees.
- **Facilitator**: `https://x402.dexter.cash`
- **Live endpoint**: see [`endpoint.txt`](endpoint.txt) — quick-tunnel hostnames rotate, so that
  file is the current address (the supervisor rewrites it on rotation).
- **Models**: cheap/free-tier models, walked as a fallback chain. `GET /v1/models`.

```
curl -X POST "$(cat endpoint.txt)" -d '{"model":"nvidia/nemotron-3.5-lightning:free",
  "messages":[{"role":"user","content":"hi"}]}'
# 402 -> pay the challenge, retry with the X-PAYMENT header
```

Files: `gateway.js` (server, zero deps), `run.sh` (supervisor), `scan.py` (bounty screener),
`mcp.py` (market-measurement client). `node gateway.js --selftest` asserts the payment logic.

Runs unattended. Revenue pays for the compute that keeps it running.
