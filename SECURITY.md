# Security Policy

## Supported versions

Security fixes target the latest published package version. Pre-release or local working-tree builds are not supported releases.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub private vulnerability reporting (Security tab, "Report a vulnerability"). Include reproduction steps, affected version, impact, and any proposed mitigation.

Do not include credentials, tokens, cookies, browser profiles, private game assets, or customer data.

## Scope

The server intentionally limits CDP and page targets to loopback URLs, and never exposes arbitrary evaluation, browser storage, network payloads, console data, or authorization data. CDP remains powerful: use a disposable profile, bind debugging to loopback, and avoid sensitive accounts.

Redaction is key-based: properties whose names look like secrets are dropped, but string values are returned as-is, so a token embedded in a URL-valued property (for example a WebSocket `url` with a query token) is visible. `cocos_capture_node` returns pixels of whatever the game renders. `cocos_click_node` (runtime debugger mode only) runs the game's own handlers, which can reach real servers or make irreversible changes.

Reports are acknowledged after triage. Fix timing depends on impact and reproducibility; public disclosure follows a patch or a documented mitigation.
