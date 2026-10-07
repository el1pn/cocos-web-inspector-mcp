# Security Policy

## Supported versions

Security fixes target the latest published package version. Pre-release or local working-tree builds are not supported releases.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub private vulnerability reporting (Security tab, "Report a vulnerability"). Include reproduction steps, affected version, impact, and any proposed mitigation.

Do not include credentials, tokens, cookies, browser profiles, private game assets, or customer data.

## Scope

The server intentionally limits CDP and page targets to loopback URLs and never exposes arbitrary evaluation or cookie values. Console messages, network requests and bodies, and storage are exposed only when the server starts with `--allow-browser-data`; their redaction (secret-like keys, authorization and cookie headers, JWTs, bearer tokens) is best effort, and a secret in free text that matches no pattern can be returned. A redaction miss under that flag is in scope for reports.

`--allow-method-call` registers `cocos_call_method`, which runs any public method of a node or component in the attached game. That is game code execution: it can change state, reach servers, spend currency, or read data the method returns. Results pass through the property serializer (no getters, secret-like keys dropped), but a method can still return a secret under an innocuous name. Enable it only against a disposable profile and test accounts. CDP remains powerful: use a disposable profile, bind debugging to loopback, and avoid sensitive accounts.

Redaction is key-based: properties whose names look like secrets are dropped, but string values are returned as-is, so a token embedded in a URL-valued property (for example a WebSocket `url` with a query token) is visible. `cocos_capture_node` returns pixels of whatever the game renders. `cocos_click_node` (runtime debugger mode only) runs the game's own handlers, which can reach real servers or make irreversible changes.

Reports are acknowledged after triage. Fix timing depends on impact and reproducibility; public disclosure follows a patch or a documented mitigation.
