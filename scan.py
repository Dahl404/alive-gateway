#!/usr/bin/env python3
"""Bounty screener: find GitHub bounties, extract payout rail, verify on-chain escrow.

Ranks by (credibility, amount). Writes BOUNTIES.md. Stdlib only.
Usage: ./scan.py            # full scan
       ./scan.py --selftest # assert parsing works
"""
import json, re, subprocess, sys, urllib.request

SOL_RE = re.compile(r'\b[1-9A-HJ-NP-Za-km-z]{32,44}\b')
AMT_RE = re.compile(r'[$€]\s?(\d{1,5}(?:\.\d+)?)|\b(\d+(?:\.\d+)?)\s?(?:SOL|USDC|XTR)\b')
KYC = ('stripe', 'opire', 'paypal', 'upwork', 'fiverr', 'bountysource', 'kyc')

def gh(path, *a):
    r = subprocess.run(['gh', 'api', path, *a], capture_output=True, text=True)
    return json.loads(r.stdout) if r.returncode == 0 and r.stdout.strip() else None

def amount(text):
    """Largest fiat-or-token figure mentioned, in that unit."""
    vals = [float(a or b) for a, b in AMT_RE.findall(text) if (a or b)]
    return max(vals) if vals else 0.0

def rail(text):
    low = text.lower()
    if any(k in low for k in KYC):
        return 'KYC'
    if 'sol' in low or SOL_RE.search(text):
        return 'solana'
    return 'unknown'

def sol_balance(addr):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "getBalance",
                       "params": [addr]}).encode()
    req = urllib.request.Request('https://api.mainnet-beta.solana.com', data=body,
                                 headers={'Content-Type': 'application/json'})
    try:
        return json.load(urllib.request.urlopen(req, timeout=20))['result']['value'] / 1e9
    except Exception:
        return None

def scan(queries, per=12):
    out, seen = [], set()
    for q in queries:
        res = gh('-X', 'GET', 'search/issues', '-f', f'q={q}', '-f', 'sort=updated',
                 '-f', f'per_page={per}', '-f', 'order=desc')
        for it in (res or {}).get('items', []):
            url = it['html_url']
            if url in seen:
                continue
            seen.add(url)
            body = (it.get('title') or '') + '\n' + (it.get('body') or '')
            out.append({'url': url, 'title': it['title'][:90],
                        'repo': '/'.join(it['repository_url'].split('/')[-2:]),
                        'amt': amount(body), 'rail': rail(body),
                        'addr': (SOL_RE.search(body).group(0) if SOL_RE.search(body) else None),
                        'bal': None})
    for c in out:
        if c['rail'] == 'solana' and c['addr']:
            c['bal'] = sol_balance(c['addr'])
    for c in out:
        c['score'] = (0 if c['rail'] == 'KYC' else 2) + (2 if c['bal'] and c['bal'] > 0 else 0) + min(c['amt'] / 100, 2)
    return sorted(out, key=lambda c: -c['score'])

def report(cands, path='BOUNTIES.md'):
    with open(path, 'w') as f:
        f.write('# Bounty scan\n\n| score | rail | amt | on-chain | repo | title |\n|---|---|---|---|---|---|\n')
        for c in cands:
            bal = f"{c['bal']:.3f} SOL" if c['bal'] is not None else '-'
            f.write(f"| {c['score']:.1f} | {c['rail']} | {c['amt']:.0f} | {bal} | {c['repo']} | [{c['title'][:60]}]({c['url']}) |\n")
    return path

def selftest():
    assert amount('[BOUNTY $200] thing') == 200.0
    assert amount('bounty: 15 XTR') == 15.0
    assert amount('no money here') == 0.0
    assert rail('payment via Stripe on merge') == 'KYC'
    assert rail('0.12 SOL to pubkey') == 'solana'
    assert rail('mystery') == 'unknown'
    print('selftest ok')

if __name__ == '__main__':
    if '--selftest' in sys.argv:
        selftest()
    else:
        c = scan(['label:bounty state:open type:issue is:public',
                  '"bounty" in:title state:open type:issue is:public'])
        print(report(c))
        for x in c[:8]:
            print(f"{x['score']:.1f} {x['rail']:8} {x['amt']:6.0f} bal={x['bal']} {x['repo']} :: {x['title'][:50]}")
