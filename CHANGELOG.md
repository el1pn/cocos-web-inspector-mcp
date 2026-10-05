# Changelog

All notable changes are documented here.

## Unreleased

### Changed

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
