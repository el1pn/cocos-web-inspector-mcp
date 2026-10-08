# Changelog

All notable changes are documented here.

## Unreleased

### Added

- `doctor --native` finds a native debug build's inspector port in logcat, runs `adb forward`, checks the Cocos scene, and prints the `claude mcp add` command.
- Native mode re-runs `adb forward` once when the inspector endpoint stops answering, so an adb server restart or a USB drop no longer needs a manual forward.
- Native mode registers `cocos_network_requests` and `cocos_network_request` with `--allow-browser-data`: hooks installed on the first call record XHR, `fetch`, and WebSocket traffic with frames, masked like web traffic.
- Native mode registers `cocos_storage` for `localStorage`; `session` and `cookies` report `available: false`.

## 2.2.1

### Fixed

- Native builds: `cocos_asset_report` no longer marks every asset a scene renderer uses as `unused`; native assets keep their uuid behind an accessor, so the report now names them by their asset-cache key.
- Native builds: `cocos_asset_report` returns `textureBytes: null` with `unavailableMetrics.textureBytes: UNSUPPORTED_PUBLIC_API` instead of `0`, because native GFX textures expose no byte size to JavaScript.
- Native builds: `cocos_get_properties` on a node, and so `cocos_wait_for_property`, returns `name`, `active`, and `activeInHierarchy`, which native nodes keep behind accessors.

## 2.2.0

### Added

- `--native-endpoint` attaches to the V8 inspector of a Cocos native debug build (Android over `adb forward`) instead of Chromium. Graph inspection, reports, runtime mutation, and `cocos_call_method` work; `cocos_click_node`, `cocos_drag_node`, and `cocos_type_text` tap, swipe, and type through `adb shell input`; `cocos_console_messages` reads the app's `Cocos` logcat lines. Tools that need a browser page are not registered.

### Fixed

- `cocos_explain_click` hit-tests with the window id of the node's camera, so taps resolve on native builds, whose window id is 1.

## 2.1.0

### Added

- `cocos_type_text` (debugger mode): taps an EditBox and types with real keyboard input, so `text-changed` and editing events fire; `submit` presses Enter. Password boxes report `redacted`.
- `cocos_drag_node` (debugger mode): drags from a node's center by `dx`/`dy` with real pointer input, for ScrollView, PageView, and Slider.
- `cocos_analyze_batches` (debugger mode): captures one frame's 2D draw batches with the node that starts each and why the previous batch broke; `tintMs` overlays each batch's nodes on the canvas in its own color.
- `cocos_dynamic_atlas`: reports dynamic atlas pages, packed textures with position and owner node, fill, GPU bytes, and why visible sprites were not packed.
- `cocos_asset_report`: lists cached assets with refCount, bundle, texture GPU bytes, and used/dependency/builtin/unused status for leak hunting.
- `cocos_explain_click`: explains why a tap does or does not reach a node by replaying the engine's touch dispatch order, without dispatching.
- `cocos_listener_report`: reports timers, tweens, and global listeners that outlive their owner, including unowned callbacks grouped with counts for leak comparison.
- `cocos_set_time_scale` (debugger mode): scales each frame's delta time to speed up or slow down the game.
- Every single-node tool accepts `path` as an alternative to `uuid`; a path matching several nodes fails with `AMBIGUOUS_NODE` and the candidate UUIDs.
- `--allow-method-call` flag registering `cocos_call_method`: calls one public node or component method with JSON or live-object arguments and returns the serialized result or thrown error; private, secret-like, `constructor`, and `destroy` members are refused.
- `--allow-browser-data` flag registering `cocos_console_messages`, `cocos_network_requests`, `cocos_network_request`, and `cocos_storage`, with best-effort redaction of secret-like keys, auth and cookie headers, JWTs, bearer tokens, and all cookie values.
- `cocos_get_properties` returns `EditBox.string`, except for password boxes.

### Fixed

- `cocos_emulate_device` returns after the canvas resizes, so a click right after it no longer reports `OUTSIDE_VIEWPORT`.
- `cocos_click_node` no longer hangs under mobile touch emulation; it taps through CDP touch events instead of mouse events Chrome never acknowledges.

### Changed

- Supported range is Cocos Creator 3.7.4 through 3.8.8, the versions CI guards. 3.6.3 is no longer supported: its license forbids vendoring a build, so CI could not guard it, and the 2.0 tools never ran on it.

## 2.0.1

### Fixed

- `cocos_get_selection` skips layout-only containers and nodes at zero opacity. On a real game, an invisible full-screen popup blocker had swallowed every pick.
- `cocos_emulate_device` presets also set `navigator.platform`, so Cocos reports Android for Android presets instead of iOS (it treats a touch-enabled `MacIntel` platform as iPad).
- `doctor` no longer suggests `launch --port` with a privileged port.
- Release (minified) builds: component types read from the registered Cocos class name instead of the minified constructor name, which had turned every engine component into `e`. This broke `componentType` search and properties lookup, and made `cocos_get_selection` treat Buttons and Labels as layout-only.

## 2.0.0

### Added

- `launch` command: starts a local Chrome with loopback remote debugging, a dedicated profile, the game URL, and optional device emulation, then prints the `claude mcp add` command.
- `doctor` command: checks the CDP endpoint, port owner, localhost pages, Cocos detection, and active scene, with a fix for each failure.
- `cocos_emulate_device` (debugger mode): device presets or custom viewport, DPR, touch, user agent, orientation, CPU slowdown, and network throttling, with `reset`.
- `cocos_show_stats` (debugger mode): toggles the engine's FPS, draw-call, and triangle overlay.
- `cocos_get_selection`: Alt+click a node on the game canvas to select it; the tool returns the node, its path, and the hit stack. The game never receives the Alt+click.

### Breaking

- Requires Node.js 22 or later. Node.js 20 reached end of life in April 2026 and is no longer tested.

## 1.1.0

### Changed

- `cocos_get_properties` marks references to destroyed nodes and components as `{ "$type", "uuid", "destroyed": true }` instead of reporting them as live. It reads the `_objFlags` bit behind `isValid` without invoking the getter.

## 1.0.0

First stable release. Every Phase 7 release-readiness criterion in `ROADMAP.md` is met; the tool surface is unchanged from 0.1.9.

### Changed

- CI runs the live integration test against vendored Cocos Creator 3.7.4 and 3.8.3 fixtures in addition to 3.8.8.
- `fixture/build.sh` runs under Git Bash on Windows.

## 0.1.9

### Changed

- Releases publish with npm provenance and require reviewer approval of the `npm` environment; the repository is public.
- Package description covers both inspector and runtime debugger modes.

## 0.1.8

### Added

- `cocos_step_frame` advances a paused game by 1–60 fixed-delta frames through the public `cc.game.step`, then stays paused; registered only with `--allow-runtime-mutation`. Verified on Creator 3.6.3, 3.7.4, 3.8.3, and 3.8.8.

### Changed

- `cocos_click_node` is annotated destructive and open-world: game click handlers can call real servers or make irreversible changes.
- CI runs the full check on Node.js 24 in addition to 20 and 22.
- `cocos_runtime_diagnostics` returns `render.fps`, `frameTimeMs`, `drawCalls`, `triangles`, and `instances` from the counters Root and the GFX device update every frame, without enabling the profiler or invoking getters.
- Compatibility matrix lists Cocos Creator 3.6.3, 3.7.4, and 3.8.3 as manually verified with every tool; only 3.8.8 remains vendored in CI.

## 0.1.7

### Changed

- `cocos_capture_node` drops the arbitrary 1,024 px / 1,048,576 px cap; captures stay bounded by the visible viewport and the encoded response limit. Degenerate clips now report `INVALID_GEOMETRY` instead of `CAPTURE_LIMIT`.
- `cocos_capture_node` downscales through CDP (`scale` 0.75 → 0.25, JPEG) when quality steps alone exceed the response limit, so large or high-DPI viewports still capture; the result reports the applied `scale`.

### Fixed

- `cocos_get_properties` returns real Cocos 3.x node and component references as `{ $type, uuid, ... }` instead of `"[MaxDepth]"`; engine `uuid`/`children`/`name` are accessors, so references now read `_id`/`_children`/`_name`.
- Node property reads include `name`, `active`, and `activeInHierarchy`, so `cocos_wait_for_property` can wait on a node's `active` state.
- Asset references (`SpriteFrame`, ...) inside component properties collapse to `{ $type, name, uuid }` instead of dumping vertex/UV data.
- `cocos_snapshot_subtree` stops at a byte budget and returns the partial tree with `RESPONSE_LIMIT`, instead of an empty response on large scenes.
- Bounds of nodes inactive in hierarchy report `visible: false` with reason `INACTIVE`; capture and click refuse them instead of hitting whatever renders underneath.

## 0.1.6

### Added

- `cocos_get_properties` returns allowlisted display fields read without getters: `Label.string`, `RichText.string`, `Button.interactable`, `Toggle.isChecked`, and `Sprite.spriteFrame` name/UUID.
- `cocos_wait_for_property` polls one top-level property until it equals a primitive value or times out.
- `cocos_click_node` dispatches a real mouse click at a visible UI node's center; registered only with `--allow-runtime-mutation`.
- `cocos_capture_node` falls back to JPEG when the PNG exceeds the response limit.
- CDP connection retries `[::1]` when `127.0.0.1` refuses or returns 404, and hints at Chrome's built-in remote debugging toggle on 404.

### Fixed

- In-page errors now map to their stable codes (`NODE_NOT_FOUND`, `INVALID_MUTATION`, ...) instead of `CDP_UNAVAILABLE`.
- `maxDepth: 0` returns top-level primitives instead of `"[MaxDepth]"`.
- Node bounds project through the Canvas camera, so highlight, capture, and click stay aligned after the viewport aspect ratio changes.
- Duplicate-URL `MULTIPLE_PAGES` errors explain how to separate projects.

### Changed

- Vendored Cocos 3.8.8 fixtures rebuilt from the recreated fixture project with Sprite, Toggle, and RichText canaries.

## 0.1.5

### Fixed

- Publish from Node 24 so npm trusted publishing authenticates the release; 0.1.2 through 0.1.4 were tagged but never reached npm.
- Drop `--provenance`: sigstore verification requires a public source repository, and this repo is private.

## 0.1.4

### Fixed

- Preserve production fixture bytes and parse its UTF-8 BOM checksum manifest on Linux CI.

## 0.1.3

### Fixed

- Preserve the production fixture bytes so its SHA-256 handoff verifies after a Linux checkout.

## 0.1.2

### Added

- Bounded Cocos runtime inspection, discovery, diagnostics, visual bounds, and viewport-clipped node capture.
- Opt-in runtime debugger tools for node activation, transforms, public properties, pause, and resume.
- Stateless subtree snapshots for client-side comparison.

### Security

- Loopback-only CDP/page policy, strict tool schemas, bounded output, and startup-only mutation opt-in.

## 0.1.1

- Initial npm package metadata and MCP server version consistency.
