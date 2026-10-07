# Roadmap

## Product direction

`cocos-web-inspector-mcp` should support two explicit operating modes:

- **Inspector mode** is the default. It exposes bounded, read-only inspection tools.
- **Runtime debugger mode** is opt-in. It exposes a small allowlist of bounded runtime mutations.

Runtime debugging changes the attached web build only. It does not edit Cocos Creator scenes, prefabs, assets, or source files. Changes may disappear after a reload and may trigger application callbacks or other runtime side effects.

Arbitrary JavaScript evaluation, remote CDP targets, and cookie values remain out of scope. Console, network, and storage data are available only behind the separate `--allow-browser-data` flag, with redaction.

## Guiding principles

1. Preserve the loopback-only CDP and page policy.
2. Keep every input schema strict and every output bounded.
3. Never act on an ambiguous target. Node tools take a UUID or an absolute path; a path that matches more than one node is refused with `AMBIGUOUS_NODE` and the candidate UUIDs, so nothing is mutated by guess. Names alone never select a mutation target.
4. Keep inspector tools available without mutation privileges.
5. Require an explicit startup flag before registering mutation tools.
6. Return the previous and resulting values for each mutation where practical.
7. Never claim a general rollback guarantee; setters, lifecycle callbacks, and engine systems may produce side effects.
8. Prefer specific debugger commands; method invocation stays behind its own `--allow-method-call` flag.

## Phase 0 — Reliability baseline — Complete

### Live Chromium and Cocos integration tests

Add a minimal Cocos 3.x web fixture and exercise the complete path through Chromium, CDP, MCP, and the in-page bridge.

Coverage should include:

- Runtime discovery.
- Single-page and multiple-page selection.
- All existing inspector tools.
- Browser disconnect and reconnect.
- Highlight bounds at multiple viewport sizes.
- Startup with inspector mode and runtime debugger mode.

**Done when:** CI can detect regressions that unit tests with a fake Cocos graph cannot detect.

### Compatibility matrix

Verify supported Cocos Creator releases, including at least one production/minified build. Document the supported range and known limitations.

**Done when:** component identification and debugger operations have deterministic behavior on every documented version.

### Version consistency

Use one package version source for both the npm package and MCP server metadata.

**Done when:** the installed-package smoke test verifies the reported MCP server version.

## Phase 1 — Target discovery and diagnostics — Complete

### `cocos_list_pages`

Return bounded summaries for eligible loopback pages:

- Sanitized URL.
- Bounded title.
- Cocos 3.x detection status.
- Engine version when available.
- Active scene name when available.

The tool must not expose URL credentials, headers, storage, or other browser data.

### `cocos_runtime_info`

Return bounded runtime information:

- Engine version.
- Scene name and UUID.
- Canvas size.
- Visible size and origin.
- Director paused/running state when available.
- Bounded node count.

### Structured errors

Return stable error codes alongside human-readable messages. Initial codes:

- `CDP_UNAVAILABLE`
- `NO_LOCAL_PAGE`
- `MULTIPLE_PAGES`
- `PAGE_NOT_FOUND`
- `COCOS_NOT_FOUND`
- `SCENE_NOT_READY`
- `NODE_NOT_FOUND`
- `COMPONENT_NOT_FOUND`
- `AMBIGUOUS_COMPONENT`
- `MUTATION_DISABLED`
- `INVALID_MUTATION`
- `OUTPUT_TRUNCATED`

**Done when:** an MCP client can select a page and recover from common failures without parsing error-message text.

## Phase 2 — Runtime debugger foundation

Enable this phase only with an explicit startup option:

```powershell
npx cocos-web-inspector-mcp --allow-runtime-mutation
```

When the flag is absent, mutation tools should not be registered. A tool call must never enable debugger mode.

Every successful mutation should follow a common result shape:

```json
{
  "changed": true,
  "target": {
    "nodeUuid": "node-id",
    "componentUuid": "component-id"
  },
  "before": {},
  "after": {},
  "runtimeOnly": true
}
```

Optional target fields should be omitted when they do not apply.

### `cocos_set_node_active` — Complete

Set one node's active state.

Requirements:

- Select the node by exact UUID or by an absolute path that matches exactly one node.
- Accept only a boolean value.
- Return the previous and resulting active states.
- Report whether the value actually changed.

### `cocos_set_transform` — Complete

Update selected transform fields:

- Position.
- Rotation.
- Scale.

Requirements:

- Select the node by exact UUID or by an absolute path that matches exactly one node.
- Update only explicitly supplied fields.
- Reject `NaN`, infinity, invalid vector shapes, and excessive numeric values.
- Use public Cocos APIs where available.
- Return bounded before/after values.

### `cocos_set_property` — Complete

Update one public component data property.

Requirements:

- Select the node by UUID or unambiguous path, and the component by exact UUID.
- Reject private-prefixed and secret-like keys.
- Reject accessors, functions, symbols, and arbitrary object graphs.
- Initially accept only booleans, finite numbers, bounded strings, enums represented by primitive values, vectors, sizes, and colors.
- Validate the incoming shape against the current property shape.
- Return the previous and resulting serialized values.

A component type may be used for discovery, but not as a mutation target when multiple components share that type.

### `cocos_pause` and `cocos_resume` — Complete

Pause or resume the Cocos director through supported public APIs.

Requirements:

- Be idempotent where the engine permits.
- Return the previous and resulting director states.
- Fail clearly when the current Cocos version lacks a supported API.

**Done when:** users can inspect, modify, verify, and manually restore common runtime state without arbitrary evaluation.

## Phase 3 — Better inspection workflows — Complete

### `cocos_get_node`

Return one bounded node context:

- Node summary and absolute scene path.
- Parent summary.
- Direct child summaries.
- Component summaries.
- UI bounds when available.

### Component selection by UUID

Extend property inspection with `componentUuid`. Keep `componentType` for discovery and backward compatibility. Return `AMBIGUOUS_COMPONENT` when a type matches more than one component.

### Expanded node search

Add bounded filters only when backed by concrete workflows:

- Name substring.
- Component type.
- Active state.
- Path prefix.

Do not add regular-expression search unless a measured use case justifies its complexity and cost.

### Truncation metadata

Replace a single ambiguous truncation flag with bounded reason codes such as:

- `MAX_DEPTH`
- `NODE_LIMIT`
- `PROPERTY_LIMIT`
- `STRING_LIMIT`
- `RESPONSE_LIMIT`

Include counts for inspected, skipped, redacted, and returned properties without exposing secret keys or values.

## Phase 4 — Visual debugging — Complete

### `cocos_get_node_bounds`

Extract bounds calculation from highlighting and return:

- Canvas-space bounds.
- Viewport-space bounds.
- Anchor.
- World position.
- Visibility.
- A bounded reason when bounds cannot be calculated.

### Improved highlighting

Support and test:

- Rotation and skew.
- Negative scale.
- Canvas resize.
- Device pixel ratio.
- Non-default camera or viewport behavior where public APIs permit.
- Nodes outside the viewport.

Optionally show a bounded label containing the node name and shortened UUID.

### `cocos_capture_node`

Capture a bounded PNG region around one UI node only after bounds are reliable.

Requirements:

- Use the selected loopback page only.
- Limit dimensions and encoded bytes.
- Do not save files by default.
- Do not capture a full page as an implicit fallback.

## Phase 5 — Debugging workflows — Complete

### `cocos_step_frame` — Complete

Advance one frame while paused only if a stable public API exists across the supported compatibility matrix. Implemented on `cc.game.step`, verified on 3.7.4, 3.8.3, and 3.8.8.

### Stateless snapshot comparison

Add a bounded subtree snapshot format. Prefer client-side diffing before adding server-side snapshot storage.

A snapshot should include only the same safe, bounded values exposed by inspection tools.

### Restore workflow

Mutation results should contain enough previous state for the client to request an inverse mutation. Document that this restores values, not arbitrary side effects.

Prefer narrowly scoped commands for validated use cases. General method invocation exists only as `cocos_call_method` behind `--allow-method-call` (Phase 8d).

## Phase 6 — Runtime diagnostics — Complete

Add only metrics available through stable, public Cocos APIs:

- FPS and frame time.
- Draw calls and triangles.
- Bounded node and component counts.
- Duplicate node names.
- Maximum hierarchy depth.
- References to destroyed nodes and components, read from the `_objFlags` Destroyed bit behind `isValid`. (Done.)

Unassigned (`null`) properties, missing scripts, and deleted assets are not flagged: at runtime an intentional `null` is indistinguishable from a forgotten one, and deleted assets surface only in console output, available through `cocos_console_messages` with `--allow-browser-data`.

Diagnostics must remain observational. They must not silently enable profiling systems or modify game configuration.

## Phase 7 — Release readiness — Complete in 1.0.0; 3.7.4–3.8.8 in CI, 3.6.3 dropped (license forbids vendoring, so CI cannot guard it)

Before `1.0.0`:

- Live integration tests pass on supported platforms. (Done: Ubuntu and Windows.)
- The Cocos compatibility matrix is documented and verified. (Done: 3.7.4, 3.8.3, 3.8.8 debug and 3.8.8 production in CI.)
- Inspector and debugger modes have separate, accurate MCP annotations. (Done: inspectors read-only; debugger tools mutate runtime state; `cocos_click_node` destructive and open-world.)
- Every mutation requires startup-time opt-in. (Done: `--allow-runtime-mutation`.)
- Every tool has strict schemas and bounded output. (Done.)
- Production/minified web builds are covered. (Cocos Creator 3.8.8 Web Mobile fixture verified.)
- Windows and Linux CI run the complete local gate. (Done: `npm run check`.)
- Node.js LTS versions supported by the package are tested. (Done: CI runs Node.js 22 and 24 on Ubuntu and Windows; Node.js 20 dropped after its April 2026 end of life.)
- `CHANGELOG.md`, `SECURITY.md`, troubleshooting, and release instructions exist. (Done.)
- npm releases use a reviewed automated workflow and provenance where supported. (Done: reviewed `npm` environment, tag-only deploys, provenance.)

## Phase 8 — User-facing tooling without an extension — Complete

Earlier phases serve agents. This phase serves the developer at the keyboard. Build on `playwright-core`, CDP sessions, and self-contained in-page JavaScript. Features may borrow ideas from other browser MCP servers such as chrome-devtools-mcp, but must not require them to be installed.

### `launch` command — Complete

```powershell
npx cocos-web-inspector-mcp launch http://localhost:7456 --device "iPhone 14" --port 9223 --profile project-a
```

Spawn a locally installed Chrome with loopback remote debugging, a dedicated profile, and the game URL, then print the matching `claude mcp add` command. Locate Chrome per OS with a `--chrome-path` override. The MCP server itself still never launches a browser.

### `doctor` command — Complete

Check CDP reachability, port ownership, eligible pages, Cocos detection, engine version, and active scene. Print one readable line per check with the structured error code and a fix.

### `cocos_emulate_device` — Complete

Debugger mode only. Emulate a mobile viewport like the Cocos preview device list or the Chrome device toolbar through `Emulation.setDeviceMetricsOverride`, `setTouchEmulationEnabled`, and `setUserAgentOverride`.

- Accept a preset from a small table owned by this package, or explicit width, height, device pixel ratio, and mobile flag.
- Support orientation and `reset`.
- Optionally slow the page down like a low-end phone: a bounded CPU slowdown factor through `Emulation.setCPUThrottlingRate`, and a network profile (offline, slow 3G, fast 3G, slow 4G) through `Network.emulateNetworkConditions`. Throttling only delays traffic; it never reads requests or responses.
- Document that emulation belongs to the CDP session and ends when the server disconnects.

### `cocos_show_stats` — Complete

Debugger mode only. Toggle the engine's FPS, draw-call, and triangle overlay through the public `profiler.showStats()` and `hideStats()` APIs. This is an explicit, opt-in configuration change, unlike the observational Phase 6 diagnostics.

### Node picker — Complete

Let the user Alt+click the game canvas to select a node. A pointer-transparent overlay shows its name, path, and shortened UUID; `cocos_get_selection` returns the selection so the user can point instead of describing a node. The picker listener may only read the scene and draw its overlay.

### Batch-break analysis — Complete

`cocos_analyze_batches` lists each 2D draw batch of one frame with the node that started it and why the previous batch broke: texture, material, stencil, mask, layer, model, middleware, or buffer. It wraps the batcher commit methods between `EVENT_BEFORE_DRAW` and `EVENT_AFTER_DRAW` and restores them, reads private `Batcher2D` fields verified on every matrix version, and is gated behind debugger mode. `tintMs` tints each batch's nodes on the canvas through a pointer-transparent DOM overlay.

### Real input: drag and text — Complete

`cocos_drag_node` drags with real pointer input for ScrollView, PageView, and Slider. `cocos_type_text` types into an EditBox through the DOM input the engine opens, because `EditBox.string` is an accessor and assigning it skips the events game forms listen for. Under mobile emulation both, and `cocos_click_node`, send CDP touch events.

## Phase 8b — Memory and atlas debugging — Complete

### `cocos_dynamic_atlas` — Complete

Read-only. Report dynamic atlas configuration, pages, packed textures with position and owner node, fill ratios, GPU bytes, and the reason each visible sprite was not packed, in the order the engine checks them.

### `cocos_asset_report` — Complete

Read-only. List cached assets with type, refCount, bundle, and texture GPU bytes, and classify each as used by a live renderer, reached through the loaded dependency graph from one, the scene, or a persist-root node, an engine built-in, or unused. Leaks are found by comparing two snapshots; the server keeps no snapshot state.

## Phase 8c — Browser data for agent debugging — Complete

Agents debugging a game need its console errors, failed requests, and stored state. These tools are opt-in through `--allow-browser-data`, separate from `--allow-runtime-mutation`, and implemented in this package on Playwright page APIs rather than delegated to another MCP server.

- `cocos_console_messages`: console messages and uncaught page errors since the server attached.
- `cocos_network_requests` and `cocos_network_request`: request list, then headers, status, timing, and text bodies of one request.
- `cocos_storage`: localStorage and sessionStorage, and cookie names and attributes.

Redaction runs before data leaves the server and is best effort: secret-like keys in JSON, form data, and query strings, authorization and cookie headers, JWTs, bearer tokens, and every cookie value. Free-text secrets that match no pattern can still be returned, which `SECURITY.md` states.

## Phase 8d — Method calls — Complete

`cocos_call_method` calls one public method on a node or component selected by UUID. Agents need it for what narrow tools cannot reach: game-specific actions, engine methods with no dedicated tool, and checking a hypothesis by calling the code directly.

It registers only with `--allow-method-call`, separate from the mutation and browser-data flags, and is annotated destructive and open-world. Method names must be identifiers; private, secret-like, `constructor`, and `destroy` members are refused. Arguments are JSON, with `{"$node": uuid}`, `{"$component": uuid}`, and `{"$asset": uuid}` resolved to live objects. Results and thrown errors go through the property serializer, so getters stay uninvoked and secret-like keys stay hidden. `awaitMs` waits up to 30 s for a returned promise.

## Phase 8e — Tap, callback, and time debugging — Complete

- `cocos_explain_click` (read-only): replays the pointer dispatcher's order and the engine's `hitTest` to say which node would claim a tap and why the intended one does not get it. Dispatches nothing.
- `cocos_listener_report` (read-only): finds timers, tweens, and global listeners outliving their owner. Unowned callbacks, which the engine can never purge, are grouped with counts so two snapshots expose growth.
- `cocos_set_time_scale` (debugger mode): scales `director.tick`'s delta time; `1` removes the wrapper.

## Not planned: scripted flows

A `cocos_run_flow` tool that runs a fixed list of steps was considered and dropped. Agents calling tools one by one adapt to unexpected popups and server errors, and repeatable smoke flows belong in the game's own test suite. Path targets removed most of the round-trip cost that motivated it.

## Phase 9 — Browser extension — Proposed

Some workflows need UI that an MCP server cannot provide. Build them as an optional Chrome extension that reuses the self-contained `inspectCocos` bridge, not as a second implementation.

Candidate features:

- A DevTools panel with a live scene tree, node search, and component properties.
- Persistent node picker and selection highlight without a CDP connection.
- Property editing from the panel, limited to the Phase 2 allowlist.
- Device preset and orientation switcher.

Open decisions before starting:

- How the extension and the MCP server share selection without native messaging or a new network listener.
- Whether the extension runs in the user's normal profile, which the CDP path deliberately avoids.
- Publishing, review, and update cost for the Chrome Web Store compared with an unpacked developer build.

Existing extensions such as ccc-devtools and cocos-inspector already cover the basic tree view. Start this phase only for features they lack.

## Non-goals

The project should not add:

- Arbitrary JavaScript evaluation.
- Method invocation without `--allow-method-call`, or on private (`_`-prefixed), secret-like, constructor, or `destroy` members.
- Mutation of Cocos project files, scenes, prefabs, or assets.
- Cookie values, or console, network, and storage data without `--allow-browser-data` and redaction.
- Remote CDP hosts outside loopback.
- Automatic attachment to a normal browsing profile.
- A promise of transactional rollback for runtime mutations.

## Recommended delivery order

1. Live integration tests and compatibility matrix.
2. Page discovery, runtime information, and structured errors.
3. Debugger startup flag.
4. Node active-state mutation.
5. Transform mutation.
6. Public component-property mutation.
7. Pause and resume.
8. Component UUID inspection and richer node context.
9. Reliable bounds and visual debugging.
10. Frame stepping, snapshots, and runtime diagnostics based on demonstrated demand.
11. `launch`, `doctor`, `cocos_emulate_device`, and `cocos_show_stats`.
12. Node picker.
13. Batch-break analysis, drag, and text input.
14. The browser extension based on demonstrated demand.
