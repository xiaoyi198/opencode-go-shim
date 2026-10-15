# OpenCode Go Session Proxy

Standalone, dependency-free Node 22 reverse proxy. No New API source changes or custom New API image. The deployed container is `opencode-go-shim`, connected to the external `newapi-net` network. It publishes no host ports.

## Deployment

On the server, installation lives at `<REMOTE_INSTALL_DIR>`. New API channels 19 (OpenAI Chat) and 36 (Anthropic Messages) use `http://go-shim:8080`. Other channels are unchanged. Their original priority 19 is preserved, below the existing DeepSeek priority 25.

The Node image is pinned by digest in `compose.yaml`. The server-side `.env` contains a persistent HMAC secret and an internal proxy token, with permissions 0600. Keep it across proxy upgrades; replacing the HMAC secret changes generated session IDs. Do not upload this file to a repository or paste it into chat.

```sh
cd <REMOTE_INSTALL_DIR>
docker compose ps
docker compose logs --tail 50
python3 manage.py verify
python3 verify.py end-to-end
```

Verification performs small billable generation requests on channels 19/36, including streaming. It never prints API keys. Logs contain only path, status, session-source category, elapsed time and interruption state, not prompts, credentials or session IDs.

## Session Policy

1. HMAC a valid native session header (`x-opencode-session`, `x-session-id`, `session_id`, `session-id`, `x-conversation-id`, `thread_id`, `thread-id`), namespaced by upstream credential and original caller credential. Native ID bytes are not sent upstream as-is.
2. Otherwise HMAC a body-level session/conversation ID or `prompt_cache_key`, with the same caller isolation.
3. Otherwise HMAC the system/developer content and first user content, including canonical media descriptors/data digests. Appending assistant/user turns and changing models does not change this prefix fingerprint.
4. If there is no explicit ID and no first user content, return 422 rather than inventing a new random session on every request.

A content fingerprint is a heuristic, not a true conversation ID. Two conversations from the same caller starting with identical content share a fingerprint. Trimming/replacing the opening or system prompt changes it. Changing a media URL also changes the fingerprint. Requests without the opening content require an explicit ID. For strict isolation, give different apps separate New API tokens or eventually send real conversation IDs. Gemini endpoints are deliberately out of scope; this deployment supports OpenAI Chat/Responses and Anthropic Messages.

The proxy supplies the missing routing header; it does not override OpenCode Go's usage policies. Go is intended for coding-agent traffic and monitors abuse. Non-coding applications may still be unsupported regardless of headers. The User-Agent identifies this proxy honestly; it does not impersonate OpenCode or another approved client.

## Safety and Limits

- Only supported `/v1` inference endpoints and `/v1/models` are forwarded, to one fixed upstream. No arbitrary-target proxying or redirects.
- JSON request bytes, upstream status/body and SSE events are preserved. SSE flushes immediately with backpressure; a downstream disconnect cancels upstream.
- Internal `X-Go-Shim-*` headers, original caller identity and cookies are removed before forwarding. Upstream credentials pass through unchanged.
- 4 MiB maximum request body; 8 MiB total in-flight raw-body budget; four concurrent requests. Overload returns 503 with `Retry-After: 2`. Body reservations remain held for the lifetime of each response; limits bound raw buffers but parsed JSON can still use multiples of raw size.
- Before JSON parsing, reject nesting above 64 levels or more than 20,000 structural tokens outside strings. This prevents dense small JSON from causing disproportionate object allocation; invalid JSON is still checked by the JSON parser.
- 90-second first-response deadline, 180-second upstream idle timeout, 120-second incoming-body deadline. No automatic upstream retries.
- Non-root container, read-only filesystem, dropped capabilities, 256 MiB RAM, bounded logs and restart policy.
- `/healthz` checks local process health only, not upstream service availability. Requests require a private `X-Go-Shim-Token` configured on the two New API channels.

## New API Header Configuration

Existing channel-header overrides are retained except the invalid `x-opencode-session` default-expression rule on channel 19. Added header rules forward native session headers and supply the private proxy token. Parameter-override `copy_header` operations copy the original caller Authorization into `X-Go-Shim-Principal` and preserve the existing optional `X-Foo` passthrough only on inference requests. This avoids client-header placeholders during context-free model-list synchronization; the proxy removes all internal headers before forwarding to Go.

This New API version supports `{client_header:NAME}` but not `|default:...`. Operation JSON belongs in parameter override, not the plain header-override map. The deployment uses ordinary header overrides plus one verified `copy_header` parameter operation. The correct `copy_header` source/target names are plain header names (without the `header:` namespace, which belongs to `sync_fields`).

## Updates

Updating/recreating New API with the official image does not rebuild or stop the proxy. Its MySQL-backed channel configuration remains. The external `newapi-net` network must remain available. After an update, run the end-to-end verification above.

To update the proxy source, run tests first, upload `server.mjs`, then:

```sh
cd <REMOTE_INSTALL_DIR>
docker compose restart go-shim
python3 verify.py end-to-end
```

## Rollback

The private `channel-backup.json` stores the original base URLs, status and header overrides for channels 19/36 and their original ability-enable flags. The supplemental `channel-backup-v2.json` also preserves the inspected original parameter overrides; rollback uses this complete backup when present and retains the original backup. Before rollback, the script checks that no later channel edits would be overwritten.

```sh
cd <REMOTE_INSTALL_DIR>
python3 manage.py rollback
# New API reloads database channel configuration on its next periodic sync.
# Keep the proxy running until that sync has occurred and old URLs are active.
python3 manage.py verify
docker compose stop go-shim
```

Rollback restores both Go channels to their original disabled status, not merely their upstream URLs. It leaves unrelated channel configurations untouched. Do not delete `.env` or the backup until rollback is verified.

## Tests

```sh
node --test
```

19 Node tests cover session stability/isolation, API families, body/status transparency, private-header filtering, authentication, request-size and structural limits, SSE first-chunk delivery, redirects, idle/first-response deadlines, concurrency admission and downstream cancellation. Five Python tests cover model-sync-safe configuration, row locks, stale-state assertions and rollback restoration/refusal. Run `python3 -m unittest manage_test.py` for these. Local mock tests never contact OpenCode or consume quota.
