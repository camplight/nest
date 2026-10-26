#!/usr/bin/env python3
"""Synthetic integration smoke, including one real runner/model/event turn.

Only run on a disposable host initialized with deploy/native/rehearse.sh.
The local provider fixture returns a deterministic event; no paid LLM is used.
"""
import http.cookiejar
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import threading
import time
import urllib.request


class Provider(BaseHTTPRequestHandler):
    calls = 0

    def do_POST(self):
        self.rfile.read(int(self.headers.get('Content-Length', 0)))
        Provider.calls += 1
        event = {'type': 'message.created', 'payload': {'text': 'Native smoke agent replied.'}}
        body = json.dumps({'id': 'synthetic-native', 'object': 'chat.completion',
                           'created': int(time.time()), 'model': 'native-smoke',
                           'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': json.dumps(event)},
                                        'finish_reason': 'stop'}],
                           'usage': {'prompt_tokens': 1, 'completion_tokens': 1, 'total_tokens': 2}}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


server = ThreadingHTTPServer(('127.0.0.1', 19991), Provider)
threading.Thread(target=server.serve_forever, daemon=True).start()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
base = 'http://127.0.0.1:8787'


def call(path, body=None, method=None):
    req = urllib.request.Request(base + path, data=json.dumps(body).encode() if body is not None else None,
                                 headers={'Content-Type': 'application/json'}, method=method)
    with opener.open(req, timeout=15) as response:
        return json.load(response)


name = None
try:
    call('/api/auth/login', {'username': 'synthetic-admin', 'password': 'synthetic-rehearsal-password'})
    record = Path('/tmp/nest-native-smoke-record.json')
    if record.exists():
        previous = json.loads(record.read_text())
        assert call('/api/branding')['displayName'] == 'Synthetic Native Smoke'
        assert any(e['source'] == 'agent:' + previous['agent'] for e in call('/api/events?channelId=' + previous['channel'] + '&limit=100')), 'Engine messages did not survive reinstall/rollback'
    call('/api/branding', {'displayName': 'Synthetic Native Smoke', 'logoUrl': '/brand/camplight-logo-white.svg',
                          'primaryColor': '#350956', 'accentColor': '#ff7557', 'backgroundColor': '#f8f4ff'}, method='PUT')
    # Use the engine's secret API so the actual provider isolation contract is tested.
    for key, value in {'OPENROUTER_API_KEY': 'synthetic-not-real', 'OPENROUTER_BASE_URL': 'http://127.0.0.1:19991/v1'}.items():
        call('/api/secrets', {'name': key, 'value': value, 'scopeType': 'public'})
    runner = Path('/app/.nest-data/runner-id').read_text().strip()
    assert any(r['id'] == runner and r['online'] for r in call('/api/runners'))
    name = 'NativeSmoke' + str(time.time_ns())
    model_ref = 'openrouter:' + name
    call('/api/models', {'id': model_ref, 'provider': 'openrouter', 'modelName': name, 'enabled': True})
    call('/api/agents', {'name': name, 'modelId': model_ref, 'workspacePath': '/app/.nest-data/workspaces/' + name,
                         'assignedRunnerId': runner, 'soulContents': 'Reply with a message.created event.',
                         'mode': 'CLASSIC', 'memoryContextMode': 'OFF', 'enabledSkills': []})
    channel = call('/api/channels', {'name': 'Synthetic ' + name, 'visibility': 'PRIVATE'})['id']
    call('/api/channels/' + channel + '/subscribe', {'subscriberType': 'AGENT', 'subscriberId': name})
    call('/api/events', {'type': 'message.created', 'source': 'human:synthetic-admin',
                         'channelId': channel, 'payload': {'text': 'Verify this native installation.'}})
    replied = False
    for _ in range(90):
        events = call('/api/events?channelId=' + channel + '&limit=100')
        if any(e['source'] == 'agent:' + name and e['type'] == 'message.created' for e in events):
            replied = True
            break
        time.sleep(1)
    assert replied and Provider.calls > 0, 'Expected a completed real agent/provider/event turn'
    record.write_text(json.dumps({'agent': name, 'channel': channel}))
    print('PASS: authenticated login, stable registered runner and one native agent turn through the real engine')
finally:
    if name:
        try:
            call('/api/agents/' + name + '/stop', {})
        except Exception:
            pass
    server.shutdown()
