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

All tool input objects are strict. Unknown fields are rejected. Inspection tools are annotated as read-only, idempotent, non-destructive, and closed-world. The highlight tool is annotated as a non-destructive, non-idempotent, closed-world temporary mutation because repeated calls reset its removal timer. Runtime debugger tools are non-read-only and closed-world; `cocos_click_node` is additionally destructive and open-world because game click handlers can reach real servers or make irreversible changes, and it and `cocos_step_frame` are non-idempotent.

| Tool | Purpose | Inputs |
| --- | --- | --- |
| `cocos_list_pages` | List bounded summaries of eligible localhost pages, including sanitized URL, title, Cocos detection, version, and scene name. | None |
| `cocos_runtime_info` | Return bounded engine, scene, canvas, view, director, and node-count information. | `pageUrl?` |
| `cocos_runtime_diagnostics` | Return passive bounded hierarchy counts, depth, duplicate names, and render metrics (FPS, frame time, draw calls, triangles, instances). | `pageUrl?` |
| `cocos_set_node_active` | Set one node's active state. Registered only with `--allow-runtime-mutation`; returns before/after state. | `pageUrl?`; `uuid`; `active` boolean |
| `cocos_set_transform` | Update supplied position, rotation, and/or scale fields for one node. | `pageUrl?`; `uuid`; `position?`, `rotation?`, `scale?` finite vectors |
| `cocos_set_property` | Update one bounded public component data property. | `pageUrl?`; node `uuid`; `componentUuid`; `key`; primitive/vector/size/color `value` matching current shape |
| `cocos_click_node` | Dispatch a real mouse click at the visible center of one UI node so Button/touch handlers run. Registered only with `--allow-runtime-mutation`. | `pageUrl?`; `uuid` |
| `cocos_pause` | Pause the Cocos director when its public API supports it. | `pageUrl?` |
| `cocos_resume` | Resume the Cocos director when its public API supports it. | `pageUrl?` |
| `cocos_step_frame` | Advance a paused game by 1–60 fixed-delta frames through `cc.game.step`, then stay paused. Fails unless paused first. | `pageUrl?`, `frames?` |
| `cocos_scene_tree` | Return a bounded scene tree with node and component summaries. | `pageUrl?`; `maxDepth?` integer `0..20`, default `6`; `maxNodes?` integer `1..5000`, default `500` |
| `cocos_find_node` | Find nodes with exact or combined bounded filters. | `pageUrl?`; at least one of `uuid`, `name`, `path`, `nameContains`, `componentType`, `active`, `pathPrefix`; `limit?` integer `1..100`, default `20` |
| `cocos_get_components` | Return bounded component summaries for a node. | `pageUrl?`; `uuid` |
| `cocos_get_node` | Return one node's path, parent, bounded direct children, and components. | `pageUrl?`; `uuid` |
| `cocos_snapshot_subtree` | Return a bounded stateless hierarchy snapshot; clients compare snapshots. | `pageUrl?`; `uuid`; `maxDepth?`; `maxNodes?` |
| `cocos_get_node_bounds` | Return bounded canvas/viewport bounds, anchor, world position, and visibility for one UI node. | `pageUrl?`; `uuid` |
| `cocos_capture_node` | Return an in-memory viewport-clipped image for one visible UI node: PNG, falling back to JPEG when PNG exceeds the response limit; no file is written. | `pageUrl?`; `uuid` |
| `cocos_get_properties` | Serialize public properties for a node or one component selected by type or UUID. | `pageUrl?`; `uuid`; `componentType?` or `componentUuid?`; `maxDepth?` integer `0..6`, default `3`; `0` returns top-level primitives |
| `cocos_wait_for_property` | Poll one top-level property until it strictly equals a primitive value or the timeout passes. | `pageUrl?`; `uuid`; `componentType?` or `componentUuid?`; `key`; `equals`; `timeoutMs?` `100..30000`, default `5000`; `intervalMs?` `50..5000`, default `200` |
| `cocos_highlight_node` | Draw a temporary pointer-transparent overlay around a UI node. | `pageUrl?`; `uuid`; `durationMs?` integer `100..10000`, default `2000` |

`cocos_runtime_diagnostics` does not enable profiler/statistics systems. Render metrics are read from the values `Root` and the GFX device already update every frame (the same sources as `root.fps` and `device.numDrawCalls`), whether or not the profiler is shown; draw calls include the profiler overlay when it is visible. Generic invalid-reference checks still return `UNSUPPORTED_PUBLIC_API`. `cocos_highlight_node` temporarily mutates the page DOM only. It does not mutate the Cocos node/component graph or game state. `cocos_capture_node` clips only to the visible browser viewport, never falls back to full-page capture, bounds captures by the visible viewport and encoded response size rather than a fixed pixel cap, returns PNG (or JPEG fallback) base64 in-memory, downscales down to 0.25× (reported as `scale`) when JPEG quality steps are not enough, and rejects responses still oversized after that. Mutation results provide `before` values for manual inverse calls, but restoration cannot undo lifecycle callbacks or other runtime side effects. `cocos_step_frame` uses the public `cc.game.step` (fixed `game.frameTime` delta); because `director.tick` skips logic while the director is paused, it resumes the director only for the synchronous step call and pauses it again.

### Page selection

Eligible game pages must use HTTP or HTTPS on a loopback host.

- With one eligible page, `pageUrl` may be omitted.
- With multiple eligible pages, `pageUrl` is required.
- `pageUrl` must exactly match the full URL reported by the browser, including path, query, and fragment.
- Tabs with identical URLs cannot be told apart; close duplicates before inspecting.

Every MCP client pointed at the same CDP endpoint sees every loopback tab in that browser. When several projects run at once, give each project its own Chromium, port, and profile, then configure the server at project scope:

```sh
chrome --remote-debugging-address=127.0.0.1 --remote-debugging-port=9223 --user-data-dir="$HOME/.cocos-mcp/project-a"
claude mcp add cocos-web-inspector npx -- -y cocos-web-inspector-mcp@latest --cdp-endpoint http://127.0.0.1:9223
```

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

An allowlist of display fields is read directly from their backing data fields, still without invoking getters: `Label.string`, `RichText.string`, `Button.interactable`, `Toggle.isChecked`, and `Sprite.spriteFrame` (name and UUID only).

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

The test suite covers URL policy, CDP connection reuse and recovery, scene traversal, property redaction and cycle handling, output bounds, Cocos version rejection, strict tool schemas, exact tool annotations, real page selection, inspector and debugger tools, visual bounds/capture, snapshots, diagnostics, and browser reconnection. CI installs the matching Playwright Chromium revision, runs the full check on Ubuntu and Windows with Node.js 20, 22, and 24, and rejects high-severity production dependency advisories.

## Troubleshooting

- `CDP_UNAVAILABLE`: start Chromium with loopback remote debugging; rerun `npm run install:chromium` for development tests. A `404` usually means Chrome's built-in remote debugging toggle (`chrome://inspect/#remote-debugging`) holds the port; turn it off or use another port, and check listeners with `lsof -nP -iTCP:9222 -sTCP:LISTEN`. When `127.0.0.1` returns 404 or refuses the connection, the server retries `[::1]` on the same port.
- `MULTIPLE_PAGES`: call `cocos_list_pages`, then pass the exact reported `pageUrl`. If tabs share one URL, close duplicates or use a separate Chromium per project (see Page selection).
- `COCOS_NOT_FOUND` or `SCENE_NOT_READY`: wait for the web build to finish loading; use `cocos_runtime_info` after the active scene exists.
- Runtime mutation tools missing: restart the server with `--allow-runtime-mutation`; a tool call cannot enable this mode.
- Bounds/capture unavailable: select a visible UI node with `UITransform`. `INACTIVE` means the node or an ancestor is inactive. Capture is viewport-only, bounded, and never falls back to a full-page screenshot; `RESPONSE_LIMIT` means even a 0.25× JPEG exceeded the response budget, so capture a smaller node.
- `cocos_snapshot_subtree` returns `RESPONSE_LIMIT` with a partial tree: snapshot a deeper node, or lower `maxDepth`.
- `cocos_step_frame` returns `INVALID_MUTATION`: call `cocos_pause` first.
- Render metrics `fps` reads 0: the engine publishes FPS once per elapsed second, so read again after the scene has run for a second.

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
