# Deployment Result

Date: 2026-10-14 (Asia/Shanghai)
Target: <SERVER_IP>
Remote install: <REMOTE_INSTALL_DIR>
Service: opencode-go-shim, private newapi-net Docker network
New API image: unchanged, v1.0.0-rc.43; container not restarted

## Active Integration

| Channel | Protocol | Base URL | Status | Priority |
| --- | --- | --- | --- | --- |
| 19 | OpenAI Chat | http://go-shim:8080 | Enabled | 19, unchanged |
| 36 | Anthropic Messages | http://go-shim:8080 | Enabled | 19, unchanged |

Existing DeepSeek priority remains 25, so Go does not replace the current preferred DeepSeek route. Clients retain their existing New API endpoint and token. If two providers offer the same model, existing New API priority/routing rules still apply.

Other channels' base URLs, status, header overrides and parameter overrides match the pre-deployment fingerprint. No new host port is published. The Node image is digest-pinned and independent of the official New API image.

## Verified

- 19 Node unit/HTTP integration tests pass locally and on-server.
- 5 Python configuration/rollback tests pass locally and on-server.
- Independent read-only audit completed; demonstrated resource amplification, deep JSON exceptions, native-session alias leaks and protocol-scope errors fixed and regression-tested.
- Live OpenCode Go calls through the proxy and then through New API succeed without client session headers.
- Channel 19 glm-5.3-flash: non-stream 200; SSE 200, DONE received.
- Channel 36 qwen3.8-max: non-stream 200; SSE 200, message_stop received. Final test uses X-Api-Key ingress; New API normalizes it to Authorization for caller isolation.
- Authenticated model-list request for each channel: 200, 40 models returned.
- Final GLM SSE first byte: 15,084 ms; earlier checks approximately 778-934 ms. Final Qwen SSE first byte: 1,640 ms. Upstream latency varies; no latency SLA is inferred.
- Rollback SQL executed in a transaction with final ROLLBACK, not COMMIT. Assertions and restoration statements succeeded, and live channel state was unchanged after rehearsal.
- Final process state: running / healthy, zero automatic restarts, approximately 16.24 MiB of 256 MiB RAM.
- New API start timestamp remained 2026-10-12T05:38:27.704828957Z, confirming it was not restarted by this deployment.

Live verification used small authenticated generation requests and can consume OpenCode Go usage and New API quota; these were not free-only probes.

## Limits and Remaining Boundaries

- Four simultaneous requests; 4 MiB per request and 8 MiB total in-flight raw-body budget. Excess concurrency/body budget returns 503; oversized bodies return 413.
- Depth cap 64 and 20,000 structural tokens before parsing; structurally abusive inputs return 400.
- Requests without a real ID use a caller-isolated content-prefix fingerprint. Identical openings from the same caller can share an ID; truncated or rewritten history can change it. It is not a substitute for a true client conversation identifier.
- Supported deployment: OpenAI Chat/Responses and Anthropic Messages. Responses has mock coverage but no real Go Responses model was exercised. Gemini is explicitly excluded.
- All models were not generation-tested; verified representative GLM/Qwen paths only. Existing model subscriptions, opt-in settings, rate limits and OpenCode Go coding-use policy still apply.
- Healthcheck verifies the local process, not upstream availability. No upstream retry is performed automatically.

See README.md for operating, updating and rollback commands. Preserve the private remote .env and backup files. No secrets are included in this local report.
