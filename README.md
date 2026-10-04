# cocos-web-inspector-mcp

Read-only MCP server for inspecting Cocos Creator 3.x games running in a local Chromium browser.

## Scope

The current MVP supports:

- Chromium connected through a loopback Chrome DevTools Protocol (CDP) endpoint
- Cocos Creator 3.x web builds served from loopback
- stdio MCP transport
- Scene, node, component, and public-property inspection
- Temporary DOM-only node highlighting

It does not edit Cocos game state, launch browsers, expose browser network/storage data, or support Firefox/WebKit.

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

Clone the repository, then install and build it:

```powershell
npm install
npm run build
```

Run with the default CDP endpoint, `http://127.0.0.1:9222`:

```powershell
npm start
```

Run with an explicit endpoint:

```powershell
npm start -- --cdp-endpoint http://127.0.0.1:9222
```

Endpoint precedence is:

1. `--cdp-endpoint`
2. `COCOS_CDP_ENDPOINT`
3. `http://127.0.0.1:9222`

`--cdp-endpoint` is the only supported CLI option. It identifies the browser CDP endpoint, not a game page URL.

The server uses stdio for MCP. Standard output is reserved for protocol traffic; startup diagnostics are written to standard error.

## MCP configuration

Build the project first, then replace `<absolute-path-to-repository>` with the cloned repository path:

```json
{
  "mcpServers": {
    "cocos-web-inspector": {
      "command": "node",
      "args": [
        "<absolute-path-to-repository>/dist/src/index.js",
        "--cdp-endpoint",
        "http://127.0.0.1:9222"
      ]
    }
  }
}
```

Forward slashes work in Windows JSON paths. If backslashes are used, escape each one as `\\`.

The endpoint may instead be provided through the MCP process environment:

```json
{
  "mcpServers": {
    "cocos-web-inspector": {
      "command": "node",
      "args": ["<absolute-path-to-repository>/dist/src/index.js"],
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
| `cocos_scene_tree` | Return a bounded scene tree with node and component summaries. | `pageUrl?`; `maxDepth?` integer `0..20`, default `6`; `maxNodes?` integer `1..5000`, default `500` |
| `cocos_find_node` | Find nodes by exact UUID, name, or absolute scene path. | `pageUrl?`; exactly one of `uuid`, `name`, or `path`; `limit?` integer `1..100`, default `20` |
| `cocos_get_components` | Return bounded component summaries for a node. | `pageUrl?`; `uuid` |
| `cocos_get_properties` | Serialize public properties for a node or one component type. | `pageUrl?`; `uuid`; `componentType?`; `maxDepth?` integer `0..6`, default `3` |
| `cocos_highlight_node` | Draw a temporary pointer-transparent overlay around a UI node. | `pageUrl?`; `uuid`; `durationMs?` integer `100..10000`, default `2000` |

`cocos_highlight_node` temporarily mutates the page DOM only. It does not mutate the Cocos node/component graph or game state.

### Page selection

Eligible game pages must use HTTP or HTTPS on a loopback host.

- With one eligible page, `pageUrl` may be omitted.
- With multiple eligible pages, `pageUrl` is required.
- `pageUrl` must exactly match the full URL reported by the browser, including path, query, and fragment.

Tool validation, connection, selection, and inspection failures are returned as MCP tool errors.

### Output bounds

Responses are intentionally bounded:

- Total encoded JSON response: 200,000 UTF-8 bytes
- Scene traversal: caller-selected depth and node limits within the schema ranges above
- Property serialization: maximum depth `6`, maximum `1,000` properties
- Serialized strings: maximum `2,000` characters
- Node names: maximum `500` characters

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
npm run check
```

`npm run check` type-checks, builds, runs the self-contained Node.js tests, packs the npm tarball, installs it into a temporary project, and smoke-tests the installed binary. Use it before pushing. `npm test` remains available for build plus self-tests only.

The test suite covers URL policy, CDP connection reuse and recovery, scene traversal, property redaction and cycle handling, output bounds, Cocos version rejection, strict tool schemas, and exact tool annotations. CI runs the full check on Ubuntu and Windows and rejects high-severity production dependency advisories.

The repository currently has no live Chromium/Cocos integration test.

## Architectural references

This is a clean implementation, not a fork. No source module was copied from these projects:

- [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp), Apache-2.0, inspected at `b2f522c8ba0fd2e00a679159b4aa5243de5f1b78`.
- [Playwright MCP](https://github.com/microsoft/playwright-mcp), Apache-2.0, inspected at `f183dad4a52965583e3cc1d59b88cdc279e2e57d`.
- [CC Inspector](https://github.com/qq790git/cc-inspector), MIT, inspected at `ef5ef0ae033ee6a6ae496cf566fe5d91cf05aafd`.

They informed MCP tool design, CDP connection constraints, Cocos runtime discovery, bounded responses, and highlight behavior. Their license files remain in separate read-only reference clones and are not redistributed here because this repository contains independently written code.
