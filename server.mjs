import http from 'node:http';
import https from 'node:https';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { pipeline } from 'node:stream';
import { pathToFileURL } from 'node:url';

const SESSION_HEADERS = ['x-opencode-session', 'x-session-id', 'session_id', 'session-id', 'x-conversation-id', 'thread_id', 'thread-id'];
const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length']);
const INFERENCE_PATH = /^\/v1\/(chat\/completions|messages|responses)$/;

function safeJSONStructure(body) {
  let quoted = false;
  let escaped = false;
  let depth = 0;
  let structures = 0;
  for (const byte of body) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (byte === 92) escaped = true;
      else if (byte === 34) quoted = false;
    } else if (byte === 34) quoted = true;
    else if (byte === 123 || byte === 91) {
      if (++depth > 64 || ++structures > 20000) return false;
    } else if (byte === 125 || byte === 93) depth--;
    else if (byte === 44 || byte === 58) {
      if (++structures > 20000) return false;
    }
  }
  return true;
}

function equalSecret(actual, expected) {
  const a = Buffer.from(actual || '');
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function validID(value) {
  return typeof value === 'string' && /^[\x21-\x7e]{1,256}$/.test(value);
}

function textParts(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content.flatMap(part => typeof part === 'string' ? [part] :
    typeof part?.text === 'string' ? [part.text] : []).join('\n').trim();
}

function canonical(value, depth = 0) {
  if (depth > 64) throw new Error('Content nesting exceeds safe limit');
  if (Array.isArray(value)) return '[' + value.map(item => canonical(item, depth + 1)).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key], depth + 1)).join(',') + '}';
  return JSON.stringify(value);
}

function contentFingerprint(content) {
  const textOnly = typeof content === 'string' || (Array.isArray(content) && content.every(part => typeof part === 'string' || ['text', 'input_text'].includes(part?.type) || (part?.text !== undefined && !part?.type)));
  if (textOnly) return textParts(content);
  if (content == null || (Array.isArray(content) && !content.length)) return '';
  // Hash complete media descriptors/data locally, without forwarding them as IDs.
  return 'media_' + createHash('sha256').update(canonical(content)).digest('hex');
}

// Prefix fingerprinting survives appended turns, but cannot identify identical
// openings or survive truncation. Prefer explicit conversation IDs whenever possible.
export function sessionID(headers, payload, secret) {
  const credential = headers.authorization || headers['x-api-key'] || '';
  const principal = headers['x-go-shim-principal'] || '';
  const digest = value => `go_${createHmac('sha256', secret).update(JSON.stringify([credential, principal, value])).digest('hex')}`;
  for (const header of SESSION_HEADERS) {
    if (validID(headers[header])) return { id: digest(['explicit', headers[header]]), source: 'header' };
  }
  for (const id of [payload.conversation_id, payload.session_id, payload.prompt_cache_key, payload.metadata?.session_id, payload.metadata?.conversation_id]) {
    if (validID(id)) return { id: digest(['explicit', id]), source: 'body' };
  }
  let messages = payload.messages ?? payload.input ?? payload.contents;
  if (typeof messages === 'string') messages = [{ role: 'user', content: messages }];
  if (!Array.isArray(messages)) messages = [];
  const system = contentFingerprint(payload.system ?? payload.instructions ?? payload.systemInstruction?.parts) ||
    messages.filter(m => m?.role === 'system' || m?.role === 'developer').map(m => contentFingerprint(m.content)).join('\n');
  const firstUser = messages.find(m => m?.role === 'user');
  const opening = firstUser ? contentFingerprint(firstUser.content ?? firstUser.parts) : '';
  if (!opening) return null;
  return { id: digest(['prefix', system, opening]), source: 'fingerprint' };
}

function filteredHeaders(headers) {
  const blocked = new Set(HOP_HEADERS);
  for (const token of (headers.connection || '').split(',')) blocked.add(token.trim().toLowerCase());
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !blocked.has(key) && !key.startsWith('x-go-shim-') && key !== 'cookie' && key !== 'set-cookie'));
}

function sendError(res, status, type, message) {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) return res.destroy();
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ error: { type, message } }));
}

export function createServer(options) {
  const upstream = new URL(options.upstream || 'https://opencode.ai/zen/go');
  if (!['https:', 'http:'].includes(upstream.protocol) || upstream.username || upstream.password || upstream.search || upstream.hash) throw new Error('Invalid upstream URL');
  if (!options.proxyToken || !options.hmacSecret) throw new Error('Proxy token and HMAC secret are required');
  const maxBody = options.maxBody ?? 4 * 1024 * 1024;
  const maxBufferedBytes = options.maxBufferedBytes ?? 8 * 1024 * 1024;
  let bufferedBytes = 0;
  const maxConcurrent = options.maxConcurrent ?? 4;
  const firstByteMs = options.firstByteMs ?? 90000;
  let active = 0;
  const idleMs = options.idleMs ?? 180000;
  const log = options.log ?? (record => console.log(JSON.stringify(record)));
  const agent = upstream.protocol === 'https:' ? new https.Agent({ keepAlive: true, maxSockets: maxConcurrent }) : new http.Agent({ keepAlive: true, maxSockets: maxConcurrent });
  const server = http.createServer(async (req, res) => {
    let requestURL;
    try { requestURL = new URL(req.url, 'http://local'); } catch { return sendError(res, 400, 'invalid_path', 'Invalid request path'); }
    if (req.method === 'GET' && requestURL.pathname === '/healthz' && !requestURL.search) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"status":"ok"}');
    }
    if (!equalSecret(req.headers['x-go-shim-token'], options.proxyToken)) return sendError(res, 403, 'forbidden', 'Internal proxy authentication required');
    const isModels = req.method === 'GET' && requestURL.pathname === '/v1/models';
    if (!isModels && !(req.method === 'POST' && INFERENCE_PATH.test(requestURL.pathname))) return sendError(res, 404, 'not_found', 'Unsupported API path or method');
    if (!isModels && !req.headers.authorization && !req.headers['x-api-key']) return sendError(res, 401, 'missing_credential', 'Upstream credential required');
    if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') return sendError(res, 415, 'unsupported_encoding', 'Compressed request bodies are not supported');
    if (active >= maxConcurrent) {
      res.setHeader('retry-after', '2');
      return sendError(res, 503, 'proxy_busy', 'Proxy concurrency limit reached; retry later');
    }
    active++;
    let reservedBytes = 0;
    let released = false;
    const release = () => {
      if (!released) { released = true; active--; bufferedBytes -= reservedBytes; }
    };
    res.once('close', release);
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > maxBody) {
          sendError(res, 413, 'body_too_large', 'Request body exceeds proxy limit');
          return;
        }
        if (released) return;
        if (bufferedBytes + chunk.length > maxBufferedBytes) {
          res.setHeader('retry-after', '2');
          sendError(res, 503, 'proxy_busy', 'Proxy request-body budget reached; retry later');
          return;
        }
        bufferedBytes += chunk.length;
        reservedBytes += chunk.length;
        chunks.push(chunk);
      }
    } catch { return sendError(res, 400, 'incomplete_body', 'Could not read request body'); }
    if (res.destroyed) return;
    const body = Buffer.concat(chunks);
    let session;
    if (!isModels) {
      if (!safeJSONStructure(body)) return sendError(res, 400, 'invalid_content', 'Request JSON exceeds safe structural limits');
      let payload;
      try {
        payload = JSON.parse(body.toString('utf8'));
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error();
      } catch { return sendError(res, 400, 'invalid_json', 'Expected a JSON object'); }
      try { session = sessionID(req.headers, payload, options.hmacSecret); }
      catch { return sendError(res, 400, 'invalid_content', 'Request content exceeds safe nesting or structure limits'); }
      if (!session) return sendError(res, 422, 'session_unavailable', 'No session ID or first user content; a stable session header is required for this request');
    }
    const headers = filteredHeaders(req.headers);
    headers['accept-encoding'] = 'identity';
    headers['content-length'] = String(body.length);
    for (const header of SESSION_HEADERS) delete headers[header];
    if (session) headers['x-opencode-session'] = session.id;
    // Identify this proxy honestly; preserve a caller-provided application UA.
    if (!headers['user-agent'] || /^(Go-http-client|NewAPI|python-requests|curl|node|undici)/i.test(headers['user-agent'])) headers['user-agent'] = 'opencode-go-session-proxy/1.0';
    const target = new URL(upstream);
    target.pathname = upstream.pathname.replace(/\/$/, '') + requestURL.pathname;
    target.search = requestURL.search;
    const started = Date.now();
    const transport = upstream.protocol === 'https:' ? https : http;
    const outbound = transport.request(target, { method: req.method, headers, agent }, incoming => {
      clearTimeout(firstByteTimer);
      if (res.destroyed) { incoming.destroy(); return; }
      const responseHeaders = filteredHeaders(incoming.headers);
      // Disable downstream nginx buffering without interpreting SSE or JSON.
      responseHeaders['x-accel-buffering'] = 'no';
      res.writeHead(incoming.statusCode, responseHeaders);
      res.flushHeaders();
      pipeline(incoming, res, err => {
        log({ event: 'request', path: requestURL.pathname, status: incoming.statusCode, session_source: session?.source ?? 'none', elapsed_ms: Date.now() - started, interrupted: Boolean(err) });
      });
    });
    const firstByteTimer = setTimeout(() => {
      sendError(res, 504, 'upstream_timeout', 'Upstream did not send response headers in time');
      outbound.destroy();
    }, firstByteMs);
    firstByteTimer.unref();
    outbound.once('close', () => clearTimeout(firstByteTimer));
    outbound.setTimeout(idleMs, () => {
      sendError(res, 504, 'upstream_timeout', 'Upstream connection exceeded idle timeout');
      outbound.destroy();
    });
    outbound.on('error', () => {
      log({ event: 'upstream_error', path: requestURL.pathname });
      sendError(res, 502, 'upstream_error', 'Could not connect to upstream');
    });
    res.on('close', () => { if (!res.writableFinished) outbound.destroy(); });
    outbound.end(body);
  });
  server.requestTimeout = 120000;
  server.headersTimeout = 30000;
  server.keepAliveTimeout = 65000;
  server.on('close', () => agent.destroy());
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createServer({ upstream: process.env.UPSTREAM_URL, proxyToken: process.env.PROXY_TOKEN, hmacSecret: process.env.SESSION_HMAC_SECRET });
  server.listen(Number(process.env.PORT || 8080), '0.0.0.0', () => console.log('{"event":"ready","port":8080}'));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 15000).unref();
  });
}
