import json,urllib.request,sys
U='https://whatagentsbuy.com/mcp'
def _post(payload,sid=None):
    h={'Content-Type':'application/json','Accept':'application/json, text/event-stream'}
    if sid: h['Mcp-Session-Id']=sid
    r=urllib.request.Request(U,data=json.dumps(payload).encode(),headers=h)
    resp=urllib.request.urlopen(r,timeout=60); raw=resp.read().decode()
    if raw.lstrip().startswith('event:') or '\ndata:' in raw:
        raw=''.join(l[5:] for l in raw.splitlines() if l.startswith('data:'))
    return json.loads(raw), resp.headers.get('Mcp-Session-Id') or sid
def handshake():
    j,sid=_post({'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':'2025-06-18','capabilities':{},'clientInfo':{'name':'alive','version':'1'}}})
    try: _post({'jsonrpc':'2.0','method':'notifications/initialized'},sid)
    except Exception: pass
    return sid
def tool(name,args=None,sid=None):
    sid=sid or handshake()
    j,_=_post({'jsonrpc':'2.0','id':2,'method':'tools/call','params':{'name':name,'arguments':args or {}}},sid)
    try: return j['result']['content'][0]['text']
    except Exception: return json.dumps(j)[:800]
if __name__=='__main__':
    print(tool(sys.argv[1], json.loads(sys.argv[2]) if len(sys.argv)>2 else {}))
