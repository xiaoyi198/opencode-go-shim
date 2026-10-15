#!/usr/bin/env python3
"""Private on-server verification; credentials stay in process memory."""
import hashlib
import http.client
import json
import subprocess
import sys
import time

from manage import credentials, mysql


def call(host, port, path, headers, payload=None, stream=False):
    connection = http.client.HTTPConnection(host, port, timeout=100)
    started = time.monotonic()
    body = None if payload is None else json.dumps(payload).encode()
    connection.request('GET' if payload is None else 'POST', path, body=body, headers={**headers, 'Content-Type': 'application/json'})
    response = connection.getresponse()
    if stream and response.status == 200:
        lines = []
        first_ms = None
        done = False
        while True:
            line = response.readline()
            if not line:
                break
            if first_ms is None and line.strip():
                first_ms = int((time.monotonic() - started) * 1000)
            lines.append(line)
            if b'[DONE]' in line or b'"type":"message_stop"' in line or b'"type": "message_stop"' in line:
                done = True
        data = b''.join(lines)
        report = {'status': response.status, 'first_byte_ms': first_ms, 'bytes': len(data), 'events': sum(line.startswith(b'data:') for line in lines), 'done': done}
    else:
        data = response.read()
        report = {'status': response.status, 'bytes': len(data)}
    connection.close()
    if response.status != 200:
        try:
            error = json.loads(data).get('error', {})
            report['error_type'] = error.get('type')
            report['error_message'] = error.get('message', '')[:350]
        except Exception:
            report['error_type'] = 'non_json_error'
    return report, data


def main(mode):
    proxy = json.loads(subprocess.check_output(['docker', 'inspect', 'opencode-go-shim']))[0]
    host = proxy['NetworkSettings']['Networks']['newapi-net']['IPAddress']
    token = credentials()['PROXY_TOKEN']
    direct = {'X-Go-Shim-Token': token}
    health, _ = call(host, 8080, '/healthz', {})
    models, _ = call(host, 8080, '/v1/models', direct)
    print(json.dumps({'health': health, 'models': models}))
    if health['status'] != 200 or models['status'] != 200:
        return 1
    channels = [json.loads(line) for line in mysql("SELECT JSON_OBJECT('id',id,'key',`key`,'models',models) FROM channels WHERE id IN (19,36) ORDER BY id;").splitlines()]
    if mode == 'end-to-end':
        caller = mysql('SELECT `key` FROM tokens WHERE id=1 AND status=1;')
        if not caller:
            raise RuntimeError('No existing active admin API token')
    failed = False
    for channel in channels:
        channel_id = channel['id']
        model = 'glm-5.3-flash' if channel_id == 19 else 'qwen3.8-max'
        if model not in channel['models'].split(','):
            raise RuntimeError('Expected test model is not enabled')
        path = '/v1/chat/completions' if channel_id == 19 else '/v1/messages'
        payload = {'model': model, 'max_tokens': 32, 'messages': [{'role': 'user', 'content': 'For a JavaScript source file, write only the code: const answer = 42;'}]}
        if mode == 'direct':
            request_headers = {**direct, 'Authorization': 'Bearer ' + channel['key']} if channel_id == 19 else {**direct, 'x-api-key': channel['key'], 'anthropic-version': '2023-06-01'}
            destination, port = host, 8080
        else:
            request_headers = {'Authorization': 'Bearer sk-' + caller + '-' + str(channel_id)}
            if channel_id == 36:
                request_headers = {'x-api-key': 'sk-' + caller + '-' + str(channel_id), 'anthropic-version': '2023-06-01'}
            destination, port = '127.0.0.1', 3000
        for streaming in [False, True]:
            payload['stream'] = streaming
            report, data = call(destination, port, path, request_headers, payload, streaming)
            print(json.dumps({'mode': mode, 'channel': channel_id, 'model': model, 'stream': streaming, **report}, ensure_ascii=False), flush=True)
            if report['status'] != 200 or (streaming and (not report['events'] or not report['done'])):
                failed = True
    return 1 if failed else 0


if __name__ == '__main__':
    try:
        sys.exit(main(sys.argv[1]))
    except Exception as error:
        print(f'Verification failed ({type(error).__name__}); no credential output', file=sys.stderr)
        sys.exit(1)
