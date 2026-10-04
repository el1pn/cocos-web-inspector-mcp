# Security Policy

## Supported versions

Security fixes target the latest published package version. Pre-release or local working-tree builds are not supported releases.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Contact the repository owner through GitHub private vulnerability reporting, if enabled, or the contact route listed on the repository profile. Include reproduction steps, affected version, impact, and any proposed mitigation.

Do not include credentials, tokens, cookies, browser profiles, private game assets, or customer data.

## Scope

The server intentionally limits CDP and page targets to loopback URLs, and never exposes arbitrary evaluation, browser storage, network payloads, console data, or authorization data. CDP remains powerful: use a disposable profile, bind debugging to loopback, and avoid sensitive accounts.

Reports are acknowledged after triage. Fix timing depends on impact and reproducibility; public disclosure follows a patch or a documented mitigation.
