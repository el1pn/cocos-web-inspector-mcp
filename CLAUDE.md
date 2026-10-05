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

## Fixture builds

`fixture/` is the Cocos Creator project behind the vendored integration snapshots in `test/fixtures/`. Creator cannot run in CI, so CI tests the vendored builds; contributors with Creator rebuild them locally.

1. Regenerate the scene with `cd fixture && python3 tools/gen-scene.py tools/samples.json` when the canary contract changes.
2. Commit `fixture/`, close every Cocos Creator, then run `fixture/build.sh` (3.8.8 by default). It builds headlessly outside `/tmp`, rejects broken imports, and rewrites the vendored files and checksums.
3. Update the provenance notes beside each snapshot and run `npm run check`.

Vendored Cocos builds are generated artifacts. Do not hand-edit them; rebuild with `fixture/build.sh` and record the fixture source commit in their provenance.
