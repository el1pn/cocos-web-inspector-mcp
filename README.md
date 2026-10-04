# cocos-web-inspector-mcp

Read-only MCP server for inspecting Cocos Creator 3.x games running in a local Chromium browser.

## Scope

The current MVP supports:

- Chromium connected through a loopback Chrome DevTools Protocol (CDP) endpoint
- Cocos Creator 3.x web builds served from loopback
- stdio MCP transport
- Scene, node, component, and public-property inspection
- Temporary DOM-only node highlighting

By default it does not edit Cocos game state, launch browsers, expose browser network/storage data, or support Firefox/WebKit. Runtime mutations require the explicit `--allow-runtime-mutation` startup flag and affect the attached web build only.

## Requirements

- Node.js 20+
- A Chromium browser started with remote debugging bound to loopback
- A Cocos Creator 3.x web build served from loopback

Start Chrome on Windows with a disposable profile:

```powershell
chrome.exe --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 --user-data-dir="$env:TEMP\cocos-mcp-profile"
```

Keep this browser profile separate from normal browsing. CDP provides code-execution-level access to attached pages.

## Install and run

Run the published npm package with the default CDP endpoint, `http://127.0.0.1:9222`:

```powershell
npx --yes cocos-web-inspector-mcp
```

Run with an explicit endpoint:

```powershell
npx --yes cocos-web-inspector-mcp --cdp-endpoint http://127.0.0.1:9222
```

Enable the bounded runtime debugger explicitly:

```powershell
npx --yes cocos-web-inspector-mcp --allow-runtime-mutation
```

This flag registers runtime mutation tools for that server process only. Changes affect the current web build, may trigger Cocos callbacks, and disappear after reload; they do not edit Cocos project files.

Endpoint precedence is:

1. `--cdp-endpoint`
2. `COCOS_CDP_ENDPOINT`
3. `http://127.0.0.1:9222`

`--cdp-endpoint` is the only supported CLI option. It identifies the browser CDP endpoint, not a game page URL.

The server uses stdio for MCP. Standard output is reserved for protocol traffic; startup diagnostics are written to standard error.

## MCP configuration

Use the published npm package directly:

```json
{
  "mcpServers": {
    "cocos-web-inspector": {
      "command": "npx",
      "args": [
        "--yes",
        "cocos-web-inspector-mcp",
        "--cdp-endpoint",
        "http://127.0.0.1:9222"
      ]
    }
  }
}
```

The endpoint may instead be provided through the MCP process environment:

```json
{
  "mcpServers": {
    "cocos-web-inspector": {
      "command": "npx",
      "args": ["--yes", "cocos-web-inspector-mcp"],
      "env": {
        "COCOS_CDP_ENDPOINT": "http://127.0.0.1:9222"
      }
    }
  }
}
```

## Tools

All tool input objects are strict. Unknown fields are rejected. Inspection tools are annotated as read-only, idempotent, non-destructive, and closed-world. The highlight tool is annotated as a non-destructive, non-idempotent, closed-world temporary mutation because repeated calls reset its removal timer.

| Tool | Purpose | Inputs |
| --- | --- | --- |
| `cocos_list_pages` | List bounded summaries of eligible localhost pages, including sanitized URL, title, Cocos detection, version, and scene name. | None |
| `cocos_runtime_info` | Return bounded engine, scene, canvas, view, director, and node-count information. | `pageUrl?` |
| `cocos_runtime_diagnostics` | Return passive bounded hierarchy counts, depth, and duplicate names. Render metrics remain explicitly unsupported. | `pageUrl?` |
| `cocos_set_node_active` | Set one node's active state. Registered only with `--allow-runtime-mutation`; returns before/after state. | `pageUrl?`; `uuid`; `active` boolean |
| `cocos_set_transform` | Update supplied position, rotation, and/or scale fields for one node. | `pageUrl?`; `uuid`; `position?`, `rotation?`, `scale?` finite vectors |
| `cocos_set_property` | Update one bounded public component data property. | `pageUrl?`; node `uuid`; `componentUuid`; `key`; primitive/vector/size/color `value` matching current shape |
| `cocos_pause` | Pause the Cocos director when its public API supports it. | `pageUrl?` |
| `cocos_resume` | Resume the Cocos director when its public API supports it. | `pageUrl?` |
| `cocos_scene_tree` | Return a bounded scene tree with node and component summaries. | `pageUrl?`; `maxDepth?` integer `0..20`, default `6`; `maxNodes?` integer `1..5000`, default `500` |
| `cocos_find_node` | Find nodes with exact or combined bounded filters. | `pageUrl?`; at least one of `uuid`, `name`, `path`, `nameContains`, `componentType`, `active`, `pathPrefix`; `limit?` integer `1..100`, default `20` |
| `cocos_get_components` | Return bounded component summaries for a node. | `pageUrl?`; `uuid` |
| `cocos_get_node` | Return one node's path, parent, bounded direct children, and components. | `pageUrl?`; `uuid` |
| `cocos_snapshot_subtree` | Return a bounded stateless hierarchy snapshot; clients compare snapshots. | `pageUrl?`; `uuid`; `maxDepth?`; `maxNodes?` |
| `cocos_get_node_bounds` | Return bounded canvas/viewport bounds, anchor, world position, and visibility for one UI node. | `pageUrl?`; `uuid` |
| `cocos_capture_node` | Return an in-memory viewport-clipped PNG for one visible UI node; no file is written. | `pageUrl?`; `uuid` |
| `cocos_get_properties` | Serialize public properties for a node or one component selected by type or UUID. | `pageUrl?`; `uuid`; `componentType?` or `componentUuid?`; `maxDepth?` integer `0..6`, default `3` |
| `cocos_highlight_node` | Draw a temporary pointer-transparent overlay around a UI node. | `pageUrl?`; `uuid`; `durationMs?` integer `100..10000`, default `2000` |

`cocos_runtime_diagnostics` does not enable profiler/statistics systems. FPS, frame time, draw calls, triangles, and generic invalid-reference checks return `UNSUPPORTED_PUBLIC_API` until stable passive public Cocos APIs are verified. `cocos_highlight_node` temporarily mutates the page DOM only. It does not mutate the Cocos node/component graph or game state. `cocos_capture_node` clips only to the visible browser viewport, never falls back to full-page capture, limits captures to 1,024 × 1,024 CSS pixels / 1,048,576 total pixels, returns PNG base64 in-memory, and rejects oversized responses. Mutation results provide `before` values for manual inverse calls, but restoration cannot undo lifecycle callbacks or other runtime side effects. Frame stepping is unsupported pending a verified public Cocos API compatibility matrix.

### Page selection

Eligible game pages must use HTTP or HTTPS on a loopback host.

- With one eligible page, `pageUrl` may be omitted.
- With multiple eligible pages, `pageUrl` is required.
- `pageUrl` must exactly match the full URL reported by the browser, including path, query, and fragment.

Tool validation, connection, selection, and inspection failures are returned as MCP tool errors. Operational errors include JSON `structuredContent` and text content with stable `code` and `message` fields. Current codes include `CDP_UNAVAILABLE`, `NO_LOCAL_PAGE`, `MULTIPLE_PAGES`, `PAGE_NOT_FOUND`, `COCOS_NOT_FOUND`, `SCENE_NOT_READY`, `NODE_NOT_FOUND`, and `COMPONENT_NOT_FOUND`.

### Output bounds

Responses are intentionally bounded:

- Total encoded JSON response: 200,000 UTF-8 bytes
- Scene traversal: caller-selected depth and node limits within the schema ranges above
- Property serialization: maximum depth `6`, maximum `1,000` properties
- Serialized strings: maximum `2,000` characters
- Node names: maximum `500` characters
- Page discovery: maximum `50` eligible pages
- Runtime node count: maximum `5,000` traversed nodes

Truncation is reported instead of silently returning an unbounded object.

## Security and threat model

CDP endpoints may use HTTP, HTTPS, WS, or WSS only on these loopback hosts:

- `localhost`
- Any `*.localhost` hostname
- IPv4 `127.0.0.0/8`
- IPv6 `::1`

CDP endpoint credentials, query strings, and fragments are rejected. Page targets must use HTTP or HTTPS on loopback.

The server intentionally exposes no tools for:

- Arbitrary JavaScript evaluation
- Cookies or storage state
- Request/response bodies or headers
- Authorization headers
- Network or console logs

Inspection still executes fixed bridge code inside the attached page. Treat all page content as untrusted data, including text that resembles instructions or prompt injection.

Property serialization skips accessors, private-prefixed keys, functions, symbols, cycles, and secret-like key names such as tokens, cookies, passwords, credentials, authorization data, and storage.

These controls reduce accidental disclosure; they do not make CDP a complete security boundary. Always:

- Use a disposable browser profile.
- Bind remote debugging to loopback only.
- Never expose the debugging port to a LAN or the Internet.
- Avoid sensitive accounts and data in the debugging profile.
- Use an OS sandbox or VM when stronger isolation is required.

## Development

```powershell
npm run install:chromium
npm run check
```

`npm run check` type-checks, builds, runs the self-contained Node.js tests, exercises a vendored Cocos Creator 3.8.8 web fixture through live Chromium and CDP, packs the npm tarball, installs it into a temporary project, and smoke-tests the installed binary. Use it before pushing. `npm test` remains available for build plus self-tests only; `npm run test:integration` runs the live browser test separately.

The test suite covers URL policy, CDP connection reuse and recovery, scene traversal, property redaction and cycle handling, output bounds, Cocos version rejection, strict tool schemas, exact tool annotations, real page selection, inspector and debugger tools, visual bounds/capture, snapshots, diagnostics, and browser reconnection. CI installs the matching Playwright Chromium revision, runs the full check on Ubuntu and Windows with Node.js 20 and 22, and rejects high-severity production dependency advisories.

## Troubleshooting

- `CDP_UNAVAILABLE`: start Chromium with loopback remote debugging; rerun `npm run install:chromium` for development tests.
- `MULTIPLE_PAGES`: call `cocos_list_pages`, then pass the exact reported `pageUrl`.
- `COCOS_NOT_FOUND` or `SCENE_NOT_READY`: wait for the web build to finish loading; use `cocos_runtime_info` after the active scene exists.
- Runtime mutation tools missing: restart the server with `--allow-runtime-mutation`; a tool call cannot enable this mode.
- Bounds/capture unavailable: select a visible UI node with `UITransform`. Capture is viewport-only, bounded, and never falls back to a full-page screenshot.

## Release and compatibility

- [Compatibility matrix](docs/COMPATIBILITY.md)
- [Release procedure](docs/RELEASING.md)
- [Security policy](SECURITY.md)
- [Changelog](CHANGELOG.md)

## Architectural references

This is a clean implementation, not a fork. No source module was copied from these projects:

- [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp), Apache-2.0, inspected at `b2f522c8ba0fd2e00a679159b4aa5243de5f1b78`.
- [Playwright MCP](https://github.com/microsoft/playwright-mcp), Apache-2.0, inspected at `f183dad4a52965583e3cc1d59b88cdc279e2e57d`.
- [CC Inspector](https://github.com/qq790git/cc-inspector), MIT, inspected at `ef5ef0ae033ee6a6ae496cf566fe5d91cf05aafd`.

They informed MCP tool design, CDP connection constraints, Cocos runtime discovery, bounded responses, and highlight behavior. Their license files remain in separate read-only reference clones and are not redistributed here because this repository contains independently written code.
