# cocos-web-inspector-mcp

Read-only MCP server for inspecting Cocos Creator 3.x games running in a local Chromium browser.

## Scope

The current MVP supports:

- Chromium connected through a loopback Chrome DevTools Protocol (CDP) endpoint
- Cocos Creator 3.x web builds served from loopback
- stdio MCP transport
- Scene, node, component, and public-property inspection
- Temporary DOM-only node highlighting

By default it does not edit Cocos game state, launch browsers, expose browser console/network/storage data, or support Firefox/WebKit. Runtime mutations require the explicit `--allow-runtime-mutation` startup flag and affect the attached web build only. Console, network, and storage tools require the separate `--allow-browser-data` flag.

## Requirements

- Node.js 22+
- A Chromium browser started with remote debugging bound to loopback
- A Cocos Creator 3.x web build served from loopback

The quickest start launches a locally installed Chrome with a disposable profile, loopback-only remote debugging, and the game URL, then prints the matching `claude mcp add` command:

```powershell
npx --yes cocos-web-inspector-mcp launch http://localhost:7456/
npx --yes cocos-web-inspector-mcp launch http://localhost:7456/ --port 9223 --device iphone-14 --landscape --cpu-slowdown 4 --network fast-3g
```

`launch` options: `--port` (default `9222`), `--profile <dir>` (default a per-port directory under the system temp folder), `--chrome-path` (or `CHROME_PATH`), and the `cocos_emulate_device` settings `--device`, `--landscape`, `--cpu-slowdown`, and `--network`. Chrome drops emulation when its controlling CDP session closes, so with emulation flags the command stays attached; press Ctrl+C to close Chrome. The MCP server itself never launches a browser.

Check a setup step by step, with a fix for each failure:

```powershell
npx --yes cocos-web-inspector-mcp doctor --cdp-endpoint http://127.0.0.1:9222
```

`doctor` checks the endpoint policy, what answers on the port, eligible localhost pages, Cocos 3.x detection, and the active scene. It exits with status 1 when a check fails.

Or start Chrome manually on Windows with a disposable profile:

```powershell
chrome.exe --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 --user-data-dir="$env:TEMP\cocos-mcp-profile"
```

Keep this browser profile separate from normal browsing. CDP provides code-execution-level access to attached pages.

### Native builds (Android)

A Cocos native build with **Debug** checked runs a V8 inspector inside the app; release builds do not. Attach to it over adb instead of Chromium:

```sh
adb logcat -d -s Cocos | grep "Debugger listening" -A1   # prints ws=IP_ADDR_OF_THIS_DEVICE:<port>/...
adb forward tcp:<port> tcp:<port>
npx --yes cocos-web-inspector-mcp --native-endpoint http://127.0.0.1:<port>
```

The template asks for port 6086, but on Android the engine moves it above 37000 when it cannot list network interfaces (43086 on a Creator 3.8.8 build), so read the port from logcat. `--native-endpoint` must be loopback, and it replaces `--cdp-endpoint` for that server process.

The V8 inspector has no page, so native mode registers only the tools that read or change the Cocos graph, plus adb-backed input and logs:

- `cocos_click_node` and `cocos_drag_node` tap and swipe with `adb shell input`, at the node's viewport center, which equals screen pixels for a full-screen game. `steps` does not apply to a native drag. Set `ANDROID_SERIAL` when several devices are attached.
- `cocos_type_text` taps the EditBox, waits for the engine's Android input activity (`CocosEditBoxActivity`), clears it, and types with `adb shell input text`, so `text-changed` fires per character. Text must be printable ASCII without `%s`. The device keyboard still processes the keys, so autocorrect or a Vietnamese Telex layout can rewrite them (`test` becomes `tét`); the result reports `matches: false` with the text the game received. `submit` presses Enter, which closes a single-line box with `editing-did-ended`; `editing-return` fires only from the activity's confirm button. Clearing uses `input keycombination`, Android 12+.
- `cocos_console_messages` (with `--allow-browser-data`) reads the app process's `Cocos`-tagged logcat lines, so it includes logs from before the server attached, bounded by the device log buffer. `console.log` and `console.debug` both report as `log`; an uncaught error spans several `error` lines.
- Not registered: `cocos_capture_node`, `cocos_emulate_device`, `cocos_highlight_node`, `cocos_get_selection` (DOM overlays draw nothing), `cocos_analyze_batches` (the native 2D batcher runs in C++), `cocos_step_frame` (stepping from the inspector renders outside the native frame loop and crashed the app), and the network and storage tools.

The inspector accepts one session at a time, so the server connects per call; Chrome DevTools can attach between calls, and a call made while DevTools is attached fails with `CDP_UNAVAILABLE`. If calls start failing with `CDP_UNAVAILABLE` while the app runs, the adb server restarted or the device dropped off USB, which takes the forward with it; run `adb forward` again. When a phone keeps dropping off USB (common through hubs), switch adb to Wi-Fi with `adb tcpip 5555` and `adb connect <phone-ip>:5555`, then forward and set `ANDROID_SERIAL=<phone-ip>:5555`; the endpoint stays `127.0.0.1`.

Only a build with the inspector compiled in can attach. If a game's Debug build fails, setting `USE_V8_DEBUGGER_FORCE` and `CC_DEBUG_FORCE` to `ON` in `native/engine/common/CMakeLists.txt` keeps the inspector in a release build; never ship such a build.

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

`--native-endpoint` attaches to a native debug build instead (see Native builds).

`--cdp-endpoint`, `--native-endpoint`, and the `--allow-*` flags are the server options; `launch` and `doctor` are separate commands. `--cdp-endpoint` identifies the browser CDP endpoint, not a game page URL.

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

Add `--allow-runtime-mutation` for debugger tools, `--allow-browser-data` for console, network, and storage tools, and `--allow-method-call` for `cocos_call_method`; each flag registers only its own tools.

## Tools

All tool input objects are strict. Unknown fields are rejected. Inspection tools are annotated as read-only, idempotent, non-destructive, and closed-world. The highlight tool is annotated as a non-destructive, non-idempotent, closed-world temporary mutation because repeated calls reset its removal timer. Runtime debugger tools are non-read-only and closed-world; `cocos_click_node`, `cocos_drag_node`, and `cocos_type_text` are additionally destructive and open-world because game input handlers can reach real servers or make irreversible changes, and they, `cocos_step_frame`, and `cocos_analyze_batches` are non-idempotent.

| Tool | Purpose | Inputs |
| --- | --- | --- |
| `cocos_list_pages` | List bounded summaries of eligible localhost pages, including sanitized URL, title, Cocos detection, version, and scene name. | None |
| `cocos_runtime_info` | Return bounded engine, scene, canvas, view, director, and node-count information. | `pageUrl?` |
| `cocos_runtime_diagnostics` | Return passive bounded hierarchy counts, depth, duplicate names, and render metrics (FPS, frame time, draw calls, triangles, instances). | `pageUrl?` |
| `cocos_set_node_active` | Set one node's active state. Registered only with `--allow-runtime-mutation`; returns before/after state. | `pageUrl?`; `uuid`; `active` boolean |
| `cocos_set_transform` | Update supplied position, rotation, and/or scale fields for one node. | `pageUrl?`; `uuid`; `position?`, `rotation?`, `scale?` finite vectors |
| `cocos_set_property` | Update one bounded public component data property. | `pageUrl?`; node `uuid`; `componentUuid`; `key`; primitive/vector/size/color `value` matching current shape |
| `cocos_click_node` | Dispatch a real click at the visible center of one UI node so Button/touch handlers run (a tap under mobile emulation). Registered only with `--allow-runtime-mutation`. | `pageUrl?`; `uuid` |
| `cocos_drag_node` | Drag from the visible center of one UI node with real pointer input (touch under mobile emulation), to scroll a ScrollView, flip a PageView, or move a Slider. | `pageUrl?`; `uuid`; `dx`, `dy` CSS pixels `-4000..4000`, not both zero; `steps?` `1..60`, default `10`; `durationMs?` `0..5000`, default `300` |
| `cocos_type_text` | Tap one EditBox and type with real keyboard input, replacing its content, so `text-changed` and editing events fire. Returns the resulting text, or `redacted` for password boxes. | `pageUrl?`; `uuid`; `text` up to 2,000 chars; `submit?` presses Enter |
| `cocos_analyze_batches` | Capture the 2D draw batches of the next rendered frame: the node that starts each batch and why the previous one broke. | `pageUrl?`; `limit?` `1..500`, default `100`; `tintMs?` `100..30000` overlays each batch in its own color |
| `cocos_pause` | Pause the Cocos director when its public API supports it. | `pageUrl?` |
| `cocos_resume` | Resume the Cocos director when its public API supports it. | `pageUrl?` |
| `cocos_step_frame` | Advance a paused game by 1–60 fixed-delta frames through `cc.game.step`, then stay paused. Fails unless paused first. | `pageUrl?`, `frames?` |
| `cocos_set_time_scale` | Speed up or slow down the whole game by scaling each frame's delta time; `1` restores it, no `scale` reads it. Registered only with `--allow-runtime-mutation`. | `pageUrl?`; `scale?` `(0, 100]` |
| `cocos_show_stats` | Show or hide the engine's FPS, draw-call, and triangle overlay through the public `profiler` API. | `pageUrl?`; `visible` boolean |
| `cocos_emulate_device` | Emulate a mobile device like the Chrome device toolbar: viewport, DPR, touch (mouse input arrives as touch), user agent and `navigator.platform`, and orientation; optionally slow the CPU or network. Settings merge across calls. | `pageUrl?`; `preset?` (`iphone-se`, `iphone-14`, `iphone-14-pro-max`, `pixel-7`, `galaxy-s20`, `ipad-mini`) or `width`+`height` `200..4000` with `deviceScaleFactor?` `1..4` and `mobile?`; `orientation?`; `cpuSlowdown?` `1..20`; `network?` (`online`, `offline`, `slow-3g`, `fast-3g`, `fast-4g`); `reload?`; or `reset: true` |
| `cocos_scene_tree` | Return a bounded scene tree with node and component summaries. | `pageUrl?`; `maxDepth?` integer `0..20`, default `6`; `maxNodes?` integer `1..5000`, default `500` |
| `cocos_find_node` | Find nodes with exact or combined bounded filters. | `pageUrl?`; at least one of `uuid`, `name`, `path`, `nameContains`, `componentType`, `active`, `pathPrefix`; `limit?` integer `1..100`, default `20` |
| `cocos_get_components` | Return bounded component summaries for a node. | `pageUrl?`; `uuid` |
| `cocos_get_node` | Return one node's path, parent, bounded direct children, and components. | `pageUrl?`; `uuid` |
| `cocos_snapshot_subtree` | Return a bounded stateless hierarchy snapshot; clients compare snapshots. | `pageUrl?`; `uuid`; `maxDepth?`; `maxNodes?` |
| `cocos_get_node_bounds` | Return bounded canvas/viewport bounds, anchor, world position, and visibility for one UI node. | `pageUrl?`; `uuid` |
| `cocos_capture_node` | Return an in-memory viewport-clipped image for one visible UI node: PNG, falling back to JPEG when PNG exceeds the response limit; no file is written. | `pageUrl?`; `uuid` |
| `cocos_get_properties` | Serialize public properties for a node or one component selected by type or UUID. | `pageUrl?`; `uuid`; `componentType?` or `componentUuid?`; `maxDepth?` integer `0..6`, default `3`; `0` returns top-level primitives |
| `cocos_wait_for_property` | Poll one top-level property until it strictly equals a primitive value or the timeout passes. | `pageUrl?`; `uuid`; `componentType?` or `componentUuid?`; `key`; `equals`; `timeoutMs?` `100..30000`, default `5000`; `intervalMs?` `50..5000`, default `200` |
| `cocos_explain_click` | Explain whether a tap reaches a node, or what a tap at a viewport point would hit, by replaying the engine's touch dispatch order without dispatching anything: the claiming node, the hit stack, and reasons. | `pageUrl?`; `uuid` or `path`, and/or `x`+`y` viewport CSS pixels |
| `cocos_listener_report` | Report timers, update callbacks, tweens, and director/game/view listeners that outlive their owner: on destroyed or detached nodes and components, and unowned callbacks (arrow functions, `bind`) grouped by event and name. | `pageUrl?`; `limit?` `1..500`, default `100` |
| `cocos_dynamic_atlas` | Report the dynamic atlas: config, each page with its packed textures (position, size, a node that draws each), fill ratio and GPU bytes, and why visible sprites stayed out. | `pageUrl?`; `limit?` `1..500`, default `100` |
| `cocos_asset_report` | List assets in the asset cache with type, `refCount`, bundle, texture GPU bytes, and a `status`: `used` (a live renderer references it), `dependency` (reached from one, the scene, or a persist-root node), `builtin`, or `unused`. Unused assets sort first. | `pageUrl?`; `type?` asset class such as `Texture2D`; `unusedOnly?`; `limit?` `1..500`, default `100` |
| `cocos_call_method` | Call one public method of a node or component and return its bounded result or thrown error. Runs game code. Registered only with `--allow-method-call`. | `pageUrl?`; node `uuid`; `componentUuid?` (omit to call on the node); `method` identifier; `args?` up to 20 JSON values, where `{"$node": uuid}`, `{"$component": uuid}`, and `{"$asset": uuid}` pass live objects; `awaitMs?` `0..30000` waits for a returned promise; `maxDepth?` `0..6`, default `2` |
| `cocos_console_messages` | Recent console messages and uncaught page errors since the server attached, newest last, with secrets masked. Registered only with `--allow-browser-data`. | `pageUrl?`; `types?` (`log`, `debug`, `info`, `error`, `warning`, `assert`, `trace`, `pageerror`); `textContains?`; `limit?` `1..200`, default `50` |
| `cocos_network_requests` | Recent requests since the server attached: id, method, masked URL, resource type, status, failure, duration. | `pageUrl?`; `urlContains?`; `resourceType?`; `failedOnly?` (network failures and HTTP 4xx/5xx); `limit?` `1..200`, default `50` |
| `cocos_network_request` | One request by id: masked headers, status, timing, and with `includeBody` the request and text response bodies, masked by key, up to 20 KB. | `pageUrl?`; `id`; `includeBody?` |
| `cocos_storage` | `localStorage` or `sessionStorage` entries with secret-like keys and JSON fields masked, or cookie names and attributes without values. | `pageUrl?`; `area` (`local`, `session`, `cookies`); `keyContains?`; `limit?` `1..500`, default `100` |
| `cocos_get_selection` | Return the node the user last Alt+clicked on the game canvas: node summary and path, viewport box, and the hit stack under the point (topmost first). The first call installs the picker. | `pageUrl?`; `disable?` removes the picker, overlay, and selection |
| `cocos_highlight_node` | Draw a temporary pointer-transparent overlay around a UI node. | `pageUrl?`; `uuid`; `durationMs?` integer `100..10000`, default `2000` |

`cocos_runtime_diagnostics` does not enable profiler/statistics systems. Render metrics are read from the values `Root` and the GFX device already update every frame (the same sources as `root.fps` and `device.numDrawCalls`), whether or not the profiler is shown; draw calls include the profiler overlay when it is visible. Generic invalid-reference checks still return `UNSUPPORTED_PUBLIC_API`. `cocos_get_selection` lets the user point at a node instead of describing it: it installs a capture-phase listener that consumes only Alt+clicks on the game canvas, so the game never sees them, and draws a labelled pointer-transparent overlay. It picks the topmost active node whose box contains the point and that draws or takes input (a 2D renderer such as Sprite or Label, or a Button, Toggle, EditBox, or Slider). Inactive nodes, layout-only containers, and nodes at zero opacity (including through a parent) are skipped, so invisible full-screen blockers do not swallow picks. The selection is reported `stale` once that node leaves the scene, and the picker disappears on reload. `cocos_highlight_node` temporarily mutates the page DOM only. It does not mutate the Cocos node/component graph or game state. `cocos_capture_node` clips only to the visible browser viewport, never falls back to full-page capture, bounds captures by the visible viewport and encoded response size rather than a fixed pixel cap, returns PNG (or JPEG fallback) base64 in-memory, downscales down to 0.25× (reported as `scale`) when JPEG quality steps are not enough, and rejects responses still oversized after that. Mutation results provide `before` values for manual inverse calls, but restoration cannot undo lifecycle callbacks or other runtime side effects. `cocos_step_frame` uses the public `cc.game.step` (fixed `game.frameTime` delta); because `director.tick` skips logic while the director is paused, it resumes the director only for the synchronous step call and pauses it again. `cocos_show_stats` is an explicit configuration change; while the overlay is visible, draw-call metrics include it. `cocos_emulate_device` holds a CDP session per page: emulation ends on `reset`, when the server disconnects, or when the server process exits, and `reset` also clears viewport overrides set by other CDP clients on that page. Cocos reads the user agent and touch support at startup, so pass `reload: true` for the game to see a new device class. The tool returns after the canvas has resized to the new viewport, so a following click or capture sees the new layout. Network throttling only delays traffic; it never reads requests or responses.

`cocos_type_text` exists because `EditBox.string` is an accessor that `cocos_set_property` refuses, and assigning it would skip the `text-changed` and `editing-did-ended` events that login forms listen for. It taps the EditBox, waits for the DOM input the engine opens, selects its content, and inserts the text through the browser keyboard. `submit` presses Enter: single-line boxes fire `editing-return` and close; multi-line boxes (the default `InputMode.ANY`) insert a newline instead. Password boxes (`InputFlag.PASSWORD`) report `redacted`, and `cocos_get_properties` omits their text. `cocos_drag_node` and `cocos_click_node` send mouse events normally and CDP touch events under mobile emulation, where Chrome would otherwise convert and never acknowledge the mouse input; Cocos only listens for touch once it detected a touch device at startup, so emulate with `reload: true` first.

`cocos_analyze_batches` explains draw calls. The 2D batcher merges consecutive renderers that share texture, material, stencil state, and layer into one draw call; anything else in between splits them. Batches are rebuilt every frame and keep no node reference, so the tool wraps the batcher's `commitComp`, `commitModel`, `commitMiddleware`, and `commitIA` for one rendered frame (from `EVENT_BEFORE_DRAW` to `EVENT_AFTER_DRAW`), then restores them. Each batch reports the node and component that started it and a reason: `TEXTURE`, `MATERIAL`, `STENCIL`, `LAYER`, `MASK` (a Mask enters a stencil level), `MODEL` (Graphics and UIMeshRenderer draw on their own), `MIDDLEWARE` (Spine or DragonBones that cannot merge), `CUSTOM_IA`, `BUFFER` (the vertex buffer filled up or the render data changed), `FIRST`, `STATE_RESET`, or `AFTER_MODEL`. With `tintMs`, a pointer-transparent DOM overlay outlines every node of each batch in that batch's color, labels the first node with its index and reason, and removes itself after `tintMs`; each batch reports its `color` and the result reports how many nodes were `tinted` (up to 1,000; nodes without a UI transform or off screen are skipped). The game must be running; a paused director renders no frames. Reasons are read from private `Batcher2D` fields verified on Creator 3.7.4 through 3.8.8, and `drawCalls` from the GFX device also includes non-2D passes and the stats overlay.

### Node targets

Every tool that acts on one node takes either `uuid` or `path`, never both. A path is the absolute scene path that `cocos_find_node` and `cocos_scene_tree` report, such as `/LoginScene/Canvas/panLogin/btnLogin`. Paths survive scene reloads, while node UUIDs created at runtime change on each load, so agents can act in one call instead of looking the UUID up first. Sibling nodes may share a name, so a path that matches more than one node fails with `AMBIGUOUS_NODE` and lists the candidate UUIDs; no tool acts on an ambiguous path. `cocos_call_method` arguments accept `{"$path": path}` the same way.

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

The server never exposes arbitrary JavaScript evaluation or cookie values. `cocos_call_method` (only with `--allow-method-call`) runs existing public methods of game objects; it cannot run new code, refuses `_`-prefixed, secret-like, `constructor`, and `destroy` members, and returns results through the property serializer, so getters are not invoked and secret-like keys are dropped. A called method still runs with the game's full privileges.

Console messages, network requests, and storage are available only with `--allow-browser-data`, as `cocos_console_messages`, `cocos_network_requests`, `cocos_network_request`, and `cocos_storage`. Without the flag those tools are not registered. With it, redaction is best effort and runs before data leaves the server:

- Authorization, cookie, set-cookie, API-key, and CSRF headers are replaced with `[redacted]`.
- URL credentials are dropped and secret-like query parameters masked.
- JSON and form bodies, and JSON storage values, are masked by key name with the same secret-like key list as property serialization.
- Free text (console messages, plain-text bodies) is masked for JWTs, `Bearer`/`Basic` tokens, and `key=value` or `"key": value` pairs with secret-like keys.
- Cookie values are never returned; names and attributes are.
- Bodies are text only and capped at 20 KB; binary responses report their content type.

Secrets in free-form text that match none of these patterns can still be returned. Use the flag only against a disposable profile and test accounts, and treat everything these tools return as untrusted page output.

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

`npm run check` type-checks, builds, runs the self-contained Node.js tests, exercises vendored Cocos Creator 3.7.4, 3.8.3, and 3.8.8 web fixtures through live Chromium and CDP, packs the npm tarball, installs it into a temporary project, and smoke-tests the installed binary. Use it before pushing. `npm test` remains available for build plus self-tests only; `npm run test:integration` runs the live browser test separately.

The test suite covers URL policy, CDP connection reuse and recovery, scene traversal, property redaction and cycle handling, output bounds, Cocos version rejection, strict tool schemas, exact tool annotations, real page selection, inspector and debugger tools, visual bounds/capture, snapshots, diagnostics, and browser reconnection. CI installs the matching Playwright Chromium revision, runs the full check on Ubuntu and Windows with Node.js 20, 22, and 24, and rejects high-severity production dependency advisories.

### Tap and callback debugging

`cocos_explain_click` answers "why does tapping this do nothing". It rebuilds the order the engine's pointer dispatcher uses (higher camera priority first, then nodes drawn later before what they cover), runs the engine's own `UITransform.hitTest` (which also applies Masks) on every node listening for touch, and reports the first that would claim the tap. Reasons: `INACTIVE`, `ZERO_SIZE`, `OUTSIDE_VIEWPORT`, `BUTTON_NOT_INTERACTABLE`, `BUTTON_DISABLED`, `NO_TOUCH_LISTENER`, `BLOCKED_BY_BLOCK_INPUT_EVENTS`, `COVERED_BY_OTHER_NODE`, and `MASKED_OR_OUTSIDE_HIT_AREA`. A tap claimed by a descendant still counts, because touch events bubble up to the target. Nothing is dispatched.

`cocos_listener_report` complements `cocos_asset_report`. The engine purges callbacks bound to a destroyed Cocos object on its own (listeners on the next emit, tweens on the next frame, component timers on destroy), so those rarely leak. What it can never purge is a callback whose target is not a Cocos object: an arrow function or `bind(this)` registered on `director`, `game`, `view`, or `systemEvent` each time a popup opens keeps the popup's closure alive and runs again. The report groups such unowned callbacks by kind, event, and function name with a count; compare two calls around opening and closing a popup, and a growing count is the leak. Callbacks on destroyed objects are listed as `destroyed`, and those on nodes outside the scene as `detached`, which pooled nodes legitimately are.

`cocos_set_time_scale` multiplies the delta time `director.tick` passes to components, the scheduler, tweens, animation, physics, and rendering, so the whole game runs faster or slower; frame stepping with `cocos_step_frame` still uses the fixed frame time. Reload or `scale: 1` restores normal speed.

### Dynamic atlas and asset leaks

`cocos_dynamic_atlas` answers why sprites do or do not batch through the dynamic atlas. Each page lists its packed textures with their position, size, and one node that draws each, its `fill` (packed texture area over page area) and `shelfFill` (the height the shelf packer has used), and its GPU bytes. Runtime textures, such as Label text rendered in bitmap cache mode, have no asset uuid and report `runtime: true`. For every visible sprite outside the atlas it gives the reason, checked in the engine's own order: `DISABLED`, `NOT_TEXTURE2D`, `COMPRESSED`, `TOO_LARGE` (over `maxFrameSize`), `NOT_PACKABLE`, `FILTER` (not linear, or mipmapped), `ATLAS_FULL`, or `NOT_YET_RENDERED`. Pages are never compacted: removed textures leave holes until the atlas resets on scene change, so a high `shelfFill` with a low `fill` means wasted space.

`cocos_asset_report` is for leak hunting. One call is a snapshot, so compare two: take one, open and close the popup or scene under test, take another, and look for assets whose status is `unused` or whose `refCount` grew. An `unused` asset is still cached although no active renderer, scene dependency, or persist-root node reaches it; it usually means a missing `decRef` or `releaseAsset`. Asset names come from `_name` and are empty in release builds, so identify assets by `uuid`, `type`, and `bundle`. `gpuMemory` comes from the GFX device and covers every texture and buffer, including atlases and render targets the asset cache does not list. Both tools are read-only: they read backing fields such as `_ref`, `_atlases`, and `Cache._map`, call no getters except the side-effect-free `isCompressed`, and verified on Creator 3.7.4 through 3.8.8.

## Troubleshooting

- `CDP_UNAVAILABLE`: start Chromium with loopback remote debugging; rerun `npm run install:chromium` for development tests. A `404` usually means Chrome's built-in remote debugging toggle (`chrome://inspect/#remote-debugging`) holds the port; turn it off or use another port, and check listeners with `lsof -nP -iTCP:9222 -sTCP:LISTEN`. When `127.0.0.1` returns 404 or refuses the connection, the server retries `[::1]` on the same port.
- `MULTIPLE_PAGES`: call `cocos_list_pages`, then pass the exact reported `pageUrl`. If tabs share one URL, close duplicates or use a separate Chromium per project (see Page selection).
- `COCOS_NOT_FOUND` or `SCENE_NOT_READY`: wait for the web build to finish loading; use `cocos_runtime_info` after the active scene exists.
- Runtime mutation tools missing: restart the server with `--allow-runtime-mutation`; a tool call cannot enable this mode.
- Bounds/capture unavailable: select a visible UI node with `UITransform`. `INACTIVE` means the node or an ancestor is inactive. Capture is viewport-only, bounded, and never falls back to a full-page screenshot; `RESPONSE_LIMIT` means even a 0.25× JPEG exceeded the response budget, so capture a smaller node.
- `cocos_snapshot_subtree` returns `RESPONSE_LIMIT` with a partial tree: snapshot a deeper node, or lower `maxDepth`.
- `cocos_step_frame` returns `INVALID_MUTATION`: call `cocos_pause` first.
- `cocos_explain_click` says `NO_TOUCH_LISTENER` for a node that reacts in the game: the game may listen on an ancestor or through a global `input.on`; check the ancestors in `hitStack` or explain the tap by `x`/`y`.
- `cocos_call_method` returns `pending: true`: the method returned a promise; pass `awaitMs` to wait for it.
- `cocos_console_messages` or `cocos_network_requests` misses startup output: they list only what happened after the server attached; reload the page and call again.
- `cocos_network_request` returns `REQUEST_NOT_FOUND`: Playwright drops old requests and bodies to bound memory; list requests again and inspect recent ones promptly.
- `cocos_asset_report` lists an asset as `unused` right after a scene change: the previous scene's assets stay cached until `autoReleaseAssets` or the game's own release runs; take the comparison snapshot a moment later.
- `cocos_dynamic_atlas` reports `NOT_YET_RENDERED`: the sprite packs on its first render; check again after a frame.
- `cocos_analyze_batches` returns `INVALID_MUTATION` with "no frame rendered": call `cocos_resume`; batches are captured from a live frame.
- `cocos_type_text` returns `NOT_FOCUSED`: the EditBox did not open its input, usually because another node covers it or it is disabled.
- `cocos_drag_node` moves nothing under mobile emulation: call `cocos_emulate_device` with `reload: true` so Cocos starts listening for touch.
- `doctor` reports HTTP 404 on the port: Chrome's built-in remote debugging holds it; see `CDP_UNAVAILABLE` above.
- Game still behaves like desktop after `cocos_emulate_device`: call it again with `reload: true`; Cocos detects mobile and touch at startup.
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
