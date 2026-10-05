# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```powershell
npm install
npm run install:chromium
npm run build
npm run typecheck
npm test
npm run test:integration
npm run check
npm start
npm start -- --cdp-endpoint http://127.0.0.1:9222
```

There is no separate lint command. TypeScript strict checking is the static validation step.

Run one test by name after building:

```powershell
npm run build
node --test --test-name-pattern="property serializer" dist/test/self-test.js
```

Tests compile into `dist/test/`; `npm test` always builds first. Install the matching Chromium revision once with `npm run install:chromium`. `npm run check` is the full local gate: build, self-tests, live Chromium/Cocos integration test, and installed-package smoke test.

## Architecture

The process is a stdio MCP server with one path from tool input to browser inspection:

1. `src/index.ts` resolves the CDP endpoint from `--cdp-endpoint`, then `COCOS_CDP_ENDPOINT`, then the loopback default. It owns transport startup and graceful shutdown.
2. `src/server.ts` defines the strict Zod tool schemas and converts each call into a `BridgeRequest`. Keep MCP validation and tool metadata here.
3. `src/browser.ts` validates loopback-only CDP/page URLs, maintains a reusable Playwright CDP connection, and selects exactly one eligible page. Keep browser connection and target-selection policy here.
4. `src/bridge.ts` runs `inspectCocos` through `page.evaluate`. It discovers the Cocos 3.x runtime, traverses the active scene, serializes bounded public data, and implements the temporary highlight overlay.

`inspectCocos` crosses the Playwright serialization boundary. It must remain self-contained: do not reference module-level helpers, imported values, or Node-only APIs from inside it. `BridgeRequest` is the shared discriminated union between MCP registration and in-page dispatch.

## Safety and bounded-output invariants

This server intentionally has a narrow, read-only inspection surface. Preserve these constraints when changing tools:

- CDP endpoints allow only HTTP(S)/WS(S) loopback URLs; page targets allow only HTTP(S) loopback URLs.
- Page selection requires an exact URL when multiple eligible pages exist.
- Tool schemas are strict and reject unknown fields.
- Do not add arbitrary evaluation, cookies, storage, network, console, or authorization-data tools.
- Property serialization must not invoke getters. It skips private-prefixed and secret-like keys, functions, symbols, and cycles.
- Traversal, properties, strings, highlight duration, and total encoded responses remain bounded. `runBridge` enforces the final 200,000-byte ceiling.
- `cocos_highlight_node` may mutate only its temporary pointer-transparent DOM overlay, never the Cocos graph or game state.

## Tests

`test/self-test.ts` uses Node's built-in test runner and a fake Cocos object graph. It covers URL policy, traversal, serialization/redaction, Cocos version rejection, and the MCP tool surface through an in-memory transport.

`test/integration-test.ts` serves the vendored Cocos 3.8.8 build, launches Chromium with loopback CDP, and exercises page selection, every tool including display fields and click, highlight bounds, and reconnect behavior. Do not silently skip this test when Chromium is missing.

TypeScript uses `NodeNext`, strict mode, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes`. Source imports therefore use `.js` extensions, and optional fields may need explicit `| undefined` in shared request types.

## Cross-repository fixture collaboration

The sibling `cocos-web-inspector-fixture` repository (`/Users/longpn/cocos-web-inspector-fixture`, GitHub `el1pn/cocos-web-inspector-fixture`) owns the Cocos project, source scene, custom component, and web builds. This repository owns the vendored integration-test snapshot, browser harness, MCP assertions, scripts, and CI.

When a live fixture peer session exists (`ListAgents`), coordinate through `SendMessage` and let that session change the fixture repository. Otherwise this session may change the fixture repository directly, committing there separately.

Fixture build workflow (details in the fixture README):

1. Regenerate the scene with `python3 tools/gen-scene.py tools/samples.json` when the canary contract changes.
2. On an empty `library/`, open the project once in the Creator 3.8.8 GUI to import, then close it. The headless CLI often starts without the `scene`/`typescript` importers and rewrites their `.meta` files to `"importer": "*"`.
3. CLI-build `build-dev.json` and `build-production.json`; confirm each `src/settings.json` has non-empty `engine.builtinAssets` and `scripting.scriptPackages`.
4. Verify the canaries live in Chrome through this MCP server before vendoring.

Vendored Cocos builds are generated artifacts. Do not hand-edit them. Copy them from the fixture build output, regenerate the SHA-256 manifest beside each snapshot, and record the fixture source commit in its provenance.
