# Roadmap

## Product direction

`cocos-web-inspector-mcp` should support two explicit operating modes:

- **Inspector mode** is the default. It exposes bounded, read-only inspection tools.
- **Runtime debugger mode** is opt-in. It exposes a small allowlist of bounded runtime mutations.

Runtime debugging changes the attached web build only. It does not edit Cocos Creator scenes, prefabs, assets, or source files. Changes may disappear after a reload and may trigger application callbacks or other runtime side effects.

Arbitrary JavaScript evaluation, remote CDP targets, cookies, storage, network data, console data, and authorization data remain out of scope in both modes.

## Guiding principles

1. Preserve the loopback-only CDP and page policy.
2. Keep every input schema strict and every output bounded.
3. Require UUIDs for mutation targets; never mutate a target selected by an ambiguous name.
4. Keep inspector tools available without mutation privileges.
5. Require an explicit startup flag before registering mutation tools.
6. Return the previous and resulting values for each mutation where practical.
7. Never claim a general rollback guarantee; setters, lifecycle callbacks, and engine systems may produce side effects.
8. Prefer specific debugger commands over arbitrary method invocation.

## Phase 0 — Reliability baseline

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

## Phase 1 — Target discovery and diagnostics

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

### `cocos_set_node_active`

Set one node's active state.

Requirements:

- Select the node by exact UUID.
- Accept only a boolean value.
- Return the previous and resulting active states.
- Report whether the value actually changed.

### `cocos_set_transform`

Update selected transform fields:

- Position.
- Rotation.
- Scale.

Requirements:

- Select the node by exact UUID.
- Update only explicitly supplied fields.
- Reject `NaN`, infinity, invalid vector shapes, and excessive numeric values.
- Use public Cocos APIs where available.
- Return bounded before/after values.

### `cocos_set_property`

Update one public component data property.

Requirements:

- Select the node and component by exact UUID.
- Reject private-prefixed and secret-like keys.
- Reject accessors, functions, symbols, and arbitrary object graphs.
- Initially accept only booleans, finite numbers, bounded strings, enums represented by primitive values, vectors, sizes, and colors.
- Validate the incoming shape against the current property shape.
- Return the previous and resulting serialized values.

A component type may be used for discovery, but not as a mutation target when multiple components share that type.

### `cocos_pause` and `cocos_resume`

Pause or resume the Cocos director through supported public APIs.

Requirements:

- Be idempotent where the engine permits.
- Return the previous and resulting director states.
- Fail clearly when the current Cocos version lacks a supported API.

**Done when:** users can inspect, modify, verify, and manually restore common runtime state without arbitrary evaluation.

## Phase 3 — Better inspection workflows

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

## Phase 4 — Visual debugging

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

## Phase 5 — Debugging workflows

### `cocos_step_frame`

Advance one frame while paused only if a stable public API exists across the supported compatibility matrix.

### Stateless snapshot comparison

Add a bounded subtree snapshot format. Prefer client-side diffing before adding server-side snapshot storage.

A snapshot should include only the same safe, bounded values exposed by inspection tools.

### Restore workflow

Mutation results should contain enough previous state for the client to request an inverse mutation. Document that this restores values, not arbitrary side effects.

Do not add a general `cocos_invoke_method` tool. Add narrowly scoped commands for validated use cases instead.

## Phase 6 — Runtime diagnostics

Add only metrics available through stable, public Cocos APIs:

- FPS and frame time.
- Draw calls and triangles.
- Bounded node and component counts.
- Duplicate node names.
- Maximum hierarchy depth.
- Missing or invalid component references where reliably detectable.

Diagnostics must remain observational. They must not silently enable profiling systems or modify game configuration.

## Phase 7 — 1.0 release readiness

Before `1.0.0`:

- Live integration tests pass on supported platforms.
- The Cocos compatibility matrix is documented and verified.
- Inspector and debugger modes have separate, accurate MCP annotations.
- Every mutation requires startup-time opt-in.
- Every tool has strict schemas and bounded output.
- Production/minified web builds are covered.
- Windows and Linux CI run the complete local gate.
- Node.js LTS versions supported by the package are tested.
- `CHANGELOG.md`, `SECURITY.md`, troubleshooting, and release instructions exist.
- npm releases use a reviewed automated workflow and provenance where supported.

## Non-goals

The project should not add:

- Arbitrary JavaScript evaluation.
- Arbitrary component method invocation.
- Mutation of Cocos project files, scenes, prefabs, or assets.
- Cookies, browser storage, request or response data, authorization headers, or console-log inspection.
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
