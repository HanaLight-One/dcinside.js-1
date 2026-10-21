# Hanabit experimental fork

Fork of green1052/dcinside.js, upstream base 0074157834839000b1aa75ac503f3888dfb7a52c. GPL-3.0-only and original attribution retained.

This fork is not an official API and does not establish that current DC publishing works. It is not installed in the production Hub. No authentication challenge handling or version impersonation changes are introduced.

## Initial changes

- Article write/modify/validate requests never automatically refresh authentication and replay. Reads retain upstream behavior.
- Article responses must be JSON with an affirmative result. Even an affirmative result is not independent public publication proof.
- beforeSubmit runs after authentication preparation and immediately before transport; a caller can persist an exclusive durable intent. Cross-process deduplication and public reconciliation remain the caller's responsibility.
- Empty content and empty image blobs fail locally.
- publicationDiagnostic returns fixed categories/status without raw server content, credentials or URLs. `try-later-unspecified` must not be interpreted as proven rate limiting or CAPTCHA.

Do not log original Error objects: upstream ApiError.response and HTTPError.body may contain sensitive content. Use publicationDiagnostic instead.

## Validation

Run `bun test`, `bun run typecheck`, `bun run build`. All tests use synthetic credentials and mock transport. No live posting is part of the suite.

## Still unresolved

### Structured pilot diagnostics

`articles.write({..., onDiagnostic: async event => persist(event)})` emits prepared image/block counts and credential-presence booleans, then HTTP status, JSON/result classifications and fixed reason categories. It never passes raw headers, URLs, server fields, body or credentials. A failed prepared journal prevents transport; a failed response journal rejects without retry, so retain the caller's durable intent. Transport failures distinguish whether headers were received. Unknown server messages are deliberately not exported.

Run `node --test tools/node-publication-smoke.mjs` after building to check the actual Node artifact. It uses synthetic credentials and a mock transport with real native multipart serialization, including 24 files. Server acceptance remains untested. Store final approved HTML/images separately in the caller's protected job directory before the durable intent; this callback does not save content or reconstruct the previous failed request.

The observed registration rejection is not fixed by these safeguards. Current server requirements, WebP acceptance, source-card handling and any version drift require separate evidence. Do not resume publication schedules or retry an uncertain submission automatically.
