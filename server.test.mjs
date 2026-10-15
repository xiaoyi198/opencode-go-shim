import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createServer, sessionID } from './server.mjs';

const payload = { model: 'test', messages: [{ role: 'system', content: 'rules' }, { role: 'user', content: 'first' }] };
const headers = { authorization: 'Bearer upstream', 'x-go-shim-principal': 'Bearer caller' };
const derive = (p = payload, h = headers) => sessionID(h, p, 'secret');

test('prefix remains stable as turns and model change', () => {
  assert.deepEqual(derive(), derive({ ...payload, model: 'other', messages: [...payload.messages, { role: 'assistant', content: 'answer' }, { role: 'user', content: 'next' }] }));
});

test('different opening, system, credential, principal and HMAC secret isolate sessions', () => {
  const base = derive().id;
  for (const id of [derive({ messages: [{ role: 'user', content: 'different' }] }).id, derive({ ...payload, system: 'different rules' }).id, derive(payload, { ...headers, authorization: 'different' }).id, derive(payload, { ...headers, 'x-go-shim-principal': 'different' }).id, sessionID(headers, payload, 'different').id]) assert.notEqual(id, base);
});

test('native headers are stable, namespaced by caller; invalid values ignored', () => {
  for (const header of ['x-opencode-session', 'x-session-id', 'session_id', 'session-id', 'thread_id', 'thread-id', 'x-conversation-id']) {
    const session = derive(payload, { ...headers, [header]: 'session-1' });
    assert.equal(session.source, 'header');
    assert.equal(session.id, derive({ session_id: 'session-1' }).id);
    assert.notEqual(session.id, derive(payload, { ...headers, [header]: 'session-1', 'x-go-shim-principal': 'other caller' }).id);
  }
  assert.equal(derive(payload, { ...headers, 'x-opencode-session': 'bad\nvalue' }).source, 'fingerprint');
  assert.equal(derive(payload, { ...headers, 'x-opencode-session': 'x'.repeat(257) }).source, 'fingerprint');
});

test('body IDs are stable even when history is truncated', () => {
  assert.equal(derive({ ...payload, prompt_cache_key: 'thread-1' }).id, derive({ prompt_cache_key: 'thread-1', input: 'new turn' }).id);
  assert.equal(derive({ session_id: 'thread-1' }).source, 'body');
  assert.notEqual(derive({ session_id: 'thread-1' }).id, derive({ session_id: 'thread-2' }).id);
});

test('Anthropic, Responses and string inputs have prefix support', () => {
  for (const p of [{ system: 'rules', messages: [{ role: 'user', content: [{ type: 'text', text: 'first' }] }] }, { instructions: 'rules', input: [{ role: 'user', content: [{ type: 'input_text', text: 'first' }] }] }, { instructions: 'rules', input: 'first' }]) assert.equal(derive(p).id, derive().id);
});

test('multimodal content distinguishes media and supports media-only opening', () => {
  const a = { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'private-a' } }] }] };
  const b = { messages: [{ role: 'user', content: [{ image_url: { url: 'private-a' }, type: 'image_url' }] }] };
  assert.equal(derive(a).id, derive(b).id);
  assert.notEqual(derive(a).id, derive({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'private-b' } }] }] }).id);
  assert.equal(derive(a).source, 'fingerprint');
  assert.equal(derive({ input: [] }), null);
});

async function fixture(t, handler, config = {}) {
  const upstream = http.createServer(handler);
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const logs = [];
  const proxy = createServer({ upstream: `http://127.0.0.1:${upstream.address().port}/zen/go`, proxyToken: 'internal', hmacSecret: 'secret', log: record => logs.push(record), ...config });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  t.after(async () => {
    proxy.closeAllConnections();
    upstream.closeAllConnections();
    await Promise.all([new Promise(resolve => proxy.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
  });
  const url = `http://127.0.0.1:${proxy.address().port}`;
  const request = (path = '/v1/chat/completions', data = payload, customHeaders = {}) => fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-go-shim-token': 'internal', ...headers, ...customHeaders }, body: typeof data === 'string' ? data : JSON.stringify(data), redirect: 'manual' });
  return { url, request, logs };
}

test('transparent body, credentials, query, error status; no internal headers or cookies leak', async t => {
  let captured;
  const { request, logs } = await fixture(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    captured = { url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() };
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '10', 'x-opencode-log-id': 'upstream-log' });
    res.end('{"error":"original"}');
  });
  const raw = JSON.stringify(payload, null, 2);
  const response = await request('/v1/chat/completions?beta=true', raw, { cookie: 'secret=private', 'x-go-shim-unused': 'private' });
  assert.equal(response.status, 429);
  assert.equal(await response.text(), '{"error":"original"}');
  assert.equal(response.headers.get('retry-after'), '10');
  assert.equal(response.headers.get('x-opencode-log-id'), 'upstream-log');
  assert.equal(captured.url, '/zen/go/v1/chat/completions?beta=true');
  assert.equal(captured.body, raw);
  assert.equal(captured.headers.authorization, headers.authorization);
  assert.equal(captured.headers['x-opencode-session'], derive().id);
  for (const key of ['cookie', 'x-go-shim-token', 'x-go-shim-principal', 'x-go-shim-unused']) assert.equal(captured.headers[key], undefined);
  const logText = JSON.stringify(logs);
  for (const secret of ['Bearer', 'first', 'private', derive().id]) assert.ok(!logText.includes(secret));
});

test('health, models, all inference families, and invalid paths/methods', async t => {
  const { url, request } = await fixture(t, (req, res) => res.end('ok'));
  assert.equal((await fetch(url + '/healthz')).status, 200);
  assert.equal((await fetch(url + '/v1/models', { headers: { 'x-go-shim-token': 'internal' } })).status, 200);
  for (const path of ['/v1/chat/completions', '/v1/messages', '/v1/responses']) assert.equal((await request(path)).status, 200);
  assert.equal((await request('/v1beta/models/gemini:generateContent')).status, 404);
  assert.equal((await request('/v1/models/gemini:generateContent')).status, 404);
  assert.equal((await request('/admin')).status, 404);
  assert.equal((await request('/v1/../admin')).status, 404);
  assert.equal((await fetch(url + '/v1/messages', { headers: { 'x-go-shim-token': 'internal' } })).status, 404);
});

test('internal authentication, missing credential, JSON, encoding and session failures', async t => {
  let calls = 0;
  const { request } = await fixture(t, (req, res) => { calls++; res.end('ok'); });
  assert.equal((await request(undefined, payload, { 'x-go-shim-token': 'wrong' })).status, 403);
  assert.equal((await request(undefined, payload, { authorization: '' })).status, 401);
  assert.equal((await request(undefined, '{broken')).status, 400);
  assert.equal((await request(undefined, 'null')).status, 400);
  assert.equal((await request(undefined, payload, { 'content-encoding': 'gzip' })).status, 415);
  assert.equal((await request(undefined, { messages: [] })).status, 422);
  assert.equal(calls, 0);
});

test('deep media JSON is rejected without crashing or leaking native session aliases', async t => {
  let captured;
  const { request } = await fixture(t, (req, res) => { captured = req.headers; res.end('ok'); });
  const deep = '{"messages":[{"role":"user","content":[{"type":"image","source":' + '['.repeat(12000) + '0' + ']'.repeat(12000) + '}]}]}';
  assert.equal((await request(undefined, deep)).status, 400);
  const response = await request(undefined, payload, { 'x-session-id': 'raw-client-id', thread_id: 'raw-thread-id' });
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(captured['x-session-id'], undefined);
  assert.equal(captured.thread_id, undefined);
  assert.match(captured['x-opencode-session'], /^go_[a-f0-9]{64}$/);
});

test('dense JSON is rejected before parsing; quoted structure characters are allowed', async t => {
  const { request } = await fixture(t, (req, res) => res.end('ok'));
  const dense = '{"messages":[{"role":"user","content":[{"type":"image","source":[' + '{},'.repeat(30000) + '{}]}]}]}';
  assert.equal((await request(undefined, dense)).status, 400);
  const normal = { messages: [{ role: 'user', content: '{[,]}\\\"'.repeat(30000) }] };
  const response = await request(undefined, normal);
  assert.equal(response.status, 200);
  await response.text();
});

test('large bodies are rejected before upstream receives a request', async t => {
  let calls = 0;
  const { request } = await fixture(t, (req, res) => { calls++; res.end('ok'); }, { maxBody: 50 });
  const response = await request();
  assert.equal(response.status, 413);
  assert.equal(calls, 0);
});

test('SSE is flushed before upstream finishes, byte-for-byte intact', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const { request } = await fixture(t, async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: first\n\n');
    await gate;
    res.end('data: [DONE]\n\n');
  });
  const response = await request();
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.equal(Buffer.from(first.value).toString(), 'data: first\n\n');
  assert.equal(response.headers.get('x-accel-buffering'), 'no');
  release();
  let rest = '';
  for (;;) { const chunk = await reader.read(); if (chunk.done) break; rest += Buffer.from(chunk.value); }
  assert.equal(rest, 'data: [DONE]\n\n');
});

test('upstream redirects are not followed (credential leak protection)', async t => {
  const { request } = await fixture(t, (req, res) => { res.writeHead(307, { location: 'https://untrusted.example/' }); res.end(); });
  const response = await request();
  assert.equal(response.status, 307);
  assert.equal(response.headers.get('location'), 'https://untrusted.example/');
});

test('idle timeout is bounded and does not retry a billable request', async t => {
  let calls = 0;
  const { request } = await fixture(t, () => { calls++; }, { idleMs: 40 });
  assert.equal((await request()).status, 504);
  assert.equal(calls, 1);
});

test('concurrency limit is enforced and released', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const { request } = await fixture(t, async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: first\n\n');
    await gate;
    res.end();
  }, { maxConcurrent: 1 });
  const first = await request();
  assert.equal((await request()).status, 503);
  release();
  await first.text();
  const next = await request();
  assert.equal(next.status, 200);
  await next.text();
});

test('aggregate body budget blocks bursts and recovers after streams finish', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const { request } = await fixture(t, async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: first\n\n');
    await gate;
    res.end();
  }, { maxBufferedBytes: Buffer.byteLength(JSON.stringify(payload)), maxConcurrent: 4 });
  const first = await request();
  assert.equal((await request()).status, 503);
  release();
  await first.text();
  const next = await request();
  assert.equal(next.status, 200);
  await next.text();
});

test('first response timeout is bounded separately from idle timeout', async t => {
  const { request } = await fixture(t, () => {}, { firstByteMs: 40, idleMs: 500 });
  assert.equal((await request()).status, 504);
});

test('client disconnect cancels upstream streaming', async t => {
  let closed;
  const done = new Promise(resolve => { closed = resolve; });
  const { url } = await fixture(t, (req, res) => {
    res.on('close', closed);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: first\n\n');
  });
  await new Promise((resolve, reject) => {
    const req = http.request(url + '/v1/messages', { method: 'POST', headers: { 'x-go-shim-token': 'internal', ...headers } }, response => {
      response.once('data', () => { req.destroy(); response.destroy(); resolve(); });
    });
    req.on('error', reject);
    req.end(JSON.stringify(payload));
  });
  await Promise.race([done, new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('upstream not cancelled')), 1000); timer.unref(); })]);
});
