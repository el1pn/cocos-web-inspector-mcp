import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Page } from 'playwright-core';
import { z } from 'zod';
import { BrowserConnection, InspectorError, sanitizeUrl } from './browser.js';
import { nativeClick, nativeConsoleMessages, nativeDrag, nativeTypeText, type NativeConnection } from './native.js';
import { consoleMessages, networkRequest, networkRequests, storage } from './browser-data.js';
import { captureNode, clickNode, devicePresetNames, dragNode, emulateDevice, inspectCocosPage, networkProfileNames, runBridge, typeText, type BridgeRequest } from './bridge.js';

const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
const pageUrl = z.url().optional();
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const temporaryMutation = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const runtimeMutation = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const finiteNumber = z.number().finite().min(-1_000_000).max(1_000_000);
const vector3 = z.object({ x: finiteNumber, y: finiteNumber, z: finiteNumber }).strict();
const quaternion = z.object({ x: finiteNumber, y: finiteNumber, z: finiteNumber, w: finiteNumber }).strict();
const propertyValue = z.union([
  z.boolean(),
  finiteNumber,
  z.string().max(2_000),
  z.object({ x: finiteNumber, y: finiteNumber }).strict(),
  vector3,
  z.object({ x: finiteNumber, y: finiteNumber, z: finiteNumber, w: finiteNumber }).strict(),
  z.object({ width: finiteNumber, height: finiteNumber }).strict(),
  z.object({ r: finiteNumber, g: finiteNumber, b: finiteNumber, a: finiteNumber }).strict(),
]);

// Every node tool takes uuid or path. Paths survive reloads but are not unique, so a path must match exactly one node.
const target = { uuid: z.string().min(1).max(200).optional(), path: z.string().min(1).max(10_000).optional() };
const oneTarget = (value: { uuid?: string | undefined; path?: string | undefined }) => (value.uuid === undefined) !== (value.path === undefined);
const oneTargetMessage = 'Provide uuid or path, not both';
type Target = { pageUrl?: string | undefined; uuid?: string | undefined; path?: string | undefined };

async function resolveUuid(page: Page, input: Target): Promise<string> {
  if (input.uuid) return input.uuid;
  const found = await runBridge(page, { action: 'findNode', path: input.path, limit: 10 }) as { matches?: Array<{ uuid: string }>; truncated?: boolean };
  const matches = found.matches ?? [];
  if (matches.length === 0) throw new Error(found.truncated ? 'Node not found within traversal limit' : 'Node not found');
  if (matches.length > 1) throw new InspectorError('AMBIGUOUS_NODE', `Path matches ${found.truncated ? 'more than 10' : matches.length} nodes; pass one uuid: ${matches.map(match => match.uuid).join(', ')}`);
  return matches[0]!.uuid;
}

function response(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data) }],
    structuredContent: data as Record<string, unknown>,
  };
}

function failure(error: unknown) {
  if (error instanceof InspectorError) return { ...response({ code: error.code, message: error.message }), isError: true };
  const raw = error instanceof Error ? error.message : 'Inspector request failed';
  // Playwright wraps in-page errors as "page.evaluate: Error: <message>\n<stack>".
  const message = raw.replace(/^page\.evaluate: (?:Error: )?/, '').split('\n')[0]!;
  const code = message === 'Cocos Creator 3.x runtime not found' ? 'COCOS_NOT_FOUND'
    : message === 'Active Cocos scene not found' ? 'SCENE_NOT_READY'
      : message.startsWith('Node not found') ? 'NODE_NOT_FOUND'
        : message === 'Component not found' ? 'COMPONENT_NOT_FOUND'
          : message === 'Ambiguous component type' ? 'AMBIGUOUS_COMPONENT'
            : message.startsWith('Invalid mutation') ? 'INVALID_MUTATION'
            : 'CDP_UNAVAILABLE';
  return { ...response({ code, message }), isError: true };
}

export function createServer(browser: BrowserConnection | NativeConnection, options: { allowRuntimeMutation?: boolean; allowBrowserData?: boolean; allowMethodCall?: boolean; native?: boolean } = {}): McpServer {
  const server = new McpServer({ name: 'cocos-web-inspector-mcp', version });
  // A native (JSB) runtime has no page: screenshots, device emulation, and network/cookie readers need a browser,
  // the DOM overlays draw nothing, the 2D batcher runs in C++ where analyze_batches cannot observe it,
  // and game.step renders outside the native frame loop, which crashed a 3.8.8 Android build in the GFX pipeline.
  const web = !options.native;
  const execute = async (request: BridgeRequest, selectedPage?: string) => {
    try {
      return response(await runBridge(await browser.page(selectedPage), request));
    } catch (error) {
      return failure(error);
    }
  };
  const withNode = async (input: Target, work: (page: Page, uuid: string) => Promise<unknown>) => {
    try {
      const page = await browser.page(input.pageUrl);
      return response(await work(page, await resolveUuid(page, input)));
    } catch (error) {
      return failure(error);
    }
  };
  const executeNode = (input: Target, build: (uuid: string) => BridgeRequest) => withNode(input, (page, uuid) => runBridge(page, build(uuid)));

  server.registerTool('cocos_list_pages', {
    description: 'List bounded summaries of eligible localhost Chromium pages.',
    inputSchema: z.object({}).strict(),
    annotations: readOnly,
  }, async () => {
    try {
      const pages = await browser.pages();
      const summaries = await Promise.all(pages.slice(0, 50).map(async page => ({
        url: sanitizeUrl(page.url()),
        ...(await page.evaluate(inspectCocosPage) as Record<string, unknown>),
      })));
      return response({ pages: summaries, truncated: pages.length > 50 });
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool('cocos_runtime_info', {
    description: 'Return bounded runtime information for one localhost Cocos Creator 3.x page.',
    inputSchema: z.object({ pageUrl }).strict(),
    annotations: readOnly,
  }, input => execute({ action: 'runtimeInfo' }, input.pageUrl));

  server.registerTool('cocos_runtime_diagnostics', {
    description: 'Return bounded passive Cocos scene hierarchy diagnostics.',
    inputSchema: z.object({ pageUrl }).strict(),
    annotations: readOnly,
  }, input => execute({ action: 'runtimeDiagnostics' }, input.pageUrl));

  server.registerTool('cocos_scene_tree', {
    description: 'Return a bounded Cocos Creator 3.x scene tree from a localhost Chromium page.',
    inputSchema: z.object({ pageUrl, maxDepth: z.number().int().min(0).max(20).optional(), maxNodes: z.number().int().min(1).max(5_000).optional() }).strict(),
    annotations: readOnly,
  }, input => execute({ action: 'sceneTree', maxDepth: input.maxDepth, maxNodes: input.maxNodes }, input.pageUrl));

  server.registerTool('cocos_find_node', {
    description: 'Find Cocos nodes with bounded exact and filter criteria.',
    inputSchema: z.object({ pageUrl, uuid: z.string().min(1).max(200).optional(), name: z.string().min(1).max(500).optional(), path: z.string().min(1).max(10_000).optional(), nameContains: z.string().min(1).max(500).optional(), componentType: z.string().min(1).max(120).optional(), active: z.boolean().optional(), pathPrefix: z.string().min(1).max(10_000).optional(), limit: z.number().int().min(1).max(100).optional() }).strict()
      .refine(value => [value.uuid, value.name, value.path, value.nameContains, value.componentType, value.active, value.pathPrefix].some(item => item !== undefined), 'Provide at least one filter'),
    annotations: readOnly,
  }, input => execute({ action: 'findNode', uuid: input.uuid, name: input.name, path: input.path, nameContains: input.nameContains, componentType: input.componentType, active: input.active, pathPrefix: input.pathPrefix, limit: input.limit }, input.pageUrl));

  server.registerTool('cocos_get_node', {
    description: 'Return bounded context for one exact Cocos node UUID.',
    inputSchema: z.object({ pageUrl, ...target }).strict().refine(oneTarget, oneTargetMessage),
    annotations: readOnly,
  }, input => executeNode(input, uuid => ({ action: 'getNode', uuid })));

  server.registerTool('cocos_snapshot_subtree', {
    description: 'Return a bounded stateless subtree snapshot for one exact Cocos node UUID.',
    inputSchema: z.object({ pageUrl, ...target, maxDepth: z.number().int().min(0).max(20).optional(), maxNodes: z.number().int().min(1).max(5_000).optional() }).strict().refine(oneTarget, oneTargetMessage),
    annotations: readOnly,
  }, input => executeNode(input, uuid => ({ action: 'snapshotSubtree', uuid, maxDepth: input.maxDepth, maxNodes: input.maxNodes })));

  server.registerTool('cocos_get_node_bounds', {
    description: 'Return bounded canvas and viewport bounds for one Cocos UI node UUID.',
    inputSchema: z.object({ pageUrl, ...target }).strict().refine(oneTarget, oneTargetMessage),
    annotations: readOnly,
  }, input => executeNode(input, uuid => ({ action: 'getNodeBounds', uuid })));

  if (web) server.registerTool('cocos_capture_node', {
    description: 'Capture a bounded viewport-clipped PNG for one visible Cocos UI node UUID.',
    inputSchema: z.object({ pageUrl, ...target }).strict().refine(oneTarget, oneTargetMessage),
    annotations: readOnly,
  }, input => withNode(input, captureNode));

  server.registerTool('cocos_get_components', {
    description: 'List bounded component summaries for one Cocos node UUID.',
    inputSchema: z.object({ pageUrl, ...target }).strict().refine(oneTarget, oneTargetMessage),
    annotations: readOnly,
  }, input => executeNode(input, uuid => ({ action: 'getComponents', uuid })));

  server.registerTool('cocos_get_properties', {
    description: 'Read bounded, cycle-safe public properties from a Cocos node or one component.',
    inputSchema: z.object({ pageUrl, ...target, componentType: z.string().min(1).optional(), componentUuid: z.string().min(1).optional(), maxDepth: z.number().int().min(0).max(6).optional() }).strict().refine(oneTarget, oneTargetMessage)
      .refine(value => !(value.componentType && value.componentUuid), 'Provide componentType or componentUuid, not both'),
    annotations: readOnly,
  }, input => executeNode(input, uuid => ({ action: 'getProperties', uuid, componentType: input.componentType, componentUuid: input.componentUuid, maxDepth: input.maxDepth })));

  server.registerTool('cocos_wait_for_property', {
    description: 'Poll one top-level property of a Cocos node or component until it equals a value or the timeout passes.',
    inputSchema: z.object({ pageUrl, ...target, componentType: z.string().min(1).optional(), componentUuid: z.string().min(1).optional(), key: z.string().min(1).max(200), equals: z.union([z.boolean(), finiteNumber, z.string().max(2_000), z.null()]), timeoutMs: z.number().int().min(100).max(30_000).optional(), intervalMs: z.number().int().min(50).max(5_000).optional() }).strict().refine(oneTarget, oneTargetMessage)
      .refine(value => !(value.componentType && value.componentUuid), 'Provide componentType or componentUuid, not both'),
    annotations: readOnly,
  }, input => withNode(input, async (page, uuid) => {
    const request: BridgeRequest = { action: 'getProperties', uuid, componentType: input.componentType, componentUuid: input.componentUuid, maxDepth: 0 };
    const deadline = Date.now() + (input.timeoutMs ?? 5_000);
    let polls = 0;
    let value: unknown;
    for (;;) {
      polls++;
      value = ((await runBridge(page, request)) as { properties?: Record<string, unknown> }).properties?.[input.key];
      if (value === input.equals || Date.now() >= deadline) break;
      await new Promise(resolve => setTimeout(resolve, input.intervalMs ?? 200));
    }
    return { matched: value === input.equals, key: input.key, value: value ?? null, polls };
  }));

  if (options.allowRuntimeMutation) {
    server.registerTool('cocos_set_node_active', {
      description: 'Set the active state of one Cocos node selected by exact UUID.',
      inputSchema: z.object({ pageUrl, ...target, active: z.boolean() }).strict().refine(oneTarget, oneTargetMessage),
      annotations: runtimeMutation,
    }, input => executeNode(input, uuid => ({ action: 'setNodeActive', uuid, active: input.active })));

    server.registerTool('cocos_set_transform', {
      description: 'Update selected Cocos node position, rotation, or scale by exact UUID.',
      inputSchema: z.object({ pageUrl, ...target, position: vector3.optional(), rotation: quaternion.optional(), scale: vector3.optional() }).strict().refine(oneTarget, oneTargetMessage)
        .refine(value => !!value.position || !!value.rotation || !!value.scale, 'Provide position, rotation, or scale'),
      annotations: runtimeMutation,
    }, input => executeNode(input, uuid => ({ action: 'setTransform', uuid, position: input.position, rotation: input.rotation, scale: input.scale })));

    server.registerTool('cocos_set_property', {
      description: 'Update one bounded public data property selected by node and component UUID.',
      inputSchema: z.object({ pageUrl, ...target, componentUuid: z.string().min(1), key: z.string().min(1).max(200), value: propertyValue }).strict().refine(oneTarget, oneTargetMessage),
      annotations: runtimeMutation,
    }, input => executeNode(input, uuid => ({ action: 'setProperty', uuid, componentUuid: input.componentUuid, key: input.key, value: input.value })));

    server.registerTool('cocos_click_node', {
      description: 'Dispatch a real mouse click at the visible center of one Cocos UI node, so Button and touch handlers run. Handlers may call game servers or make irreversible changes.',
      inputSchema: z.object({ pageUrl, ...target }).strict().refine(oneTarget, oneTargetMessage),
      // Game click handlers run arbitrary code: a login button reaches real servers, a buy button spends currency.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    }, input => withNode(input, web ? clickNode : nativeClick));

    // Like click: game drag and input handlers run arbitrary code.
    const realInput = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
    server.registerTool('cocos_drag_node', {
      description: 'Drag from the visible center of one Cocos UI node by dx/dy CSS pixels with real pointer input, to scroll a ScrollView, flip a PageView, or move a Slider. Under touch emulation the drag arrives as touch. Handlers may call game servers.',
      inputSchema: z.object({ pageUrl, ...target, dx: z.number().min(-4_000).max(4_000), dy: z.number().min(-4_000).max(4_000), steps: z.number().int().min(1).max(60).optional(), durationMs: z.number().int().min(0).max(5_000).optional() }).strict().refine(oneTarget, oneTargetMessage)
        .refine(value => value.dx !== 0 || value.dy !== 0, 'Provide a non-zero dx or dy'),
      annotations: realInput,
    }, input => withNode(input, (page, uuid) => web ? dragNode(page, uuid, input.dx, input.dy, input.steps, input.durationMs) : nativeDrag(page, uuid, input.dx, input.dy, input.durationMs)));

    server.registerTool('cocos_type_text', {
      description: 'Tap one Cocos EditBox and type text with real keyboard input, replacing its content, so text-changed and editing events fire; submit presses Enter (editing-return on single-line boxes, a newline in multi-line ones). Password text is never echoed back.',
      inputSchema: z.object({ pageUrl, ...target, text: z.string().max(2_000), submit: z.boolean().optional() }).strict().refine(oneTarget, oneTargetMessage),
      annotations: realInput,
    }, input => withNode(input, (page, uuid) => (web ? typeText : nativeTypeText)(page, uuid, input.text, input.submit ?? false)));

    if (web) server.registerTool('cocos_analyze_batches', {
      description: 'Capture the 2D draw batches of the next rendered frame: the node that starts each batch and why the previous batch broke (TEXTURE, MATERIAL, MASK, STENCIL, LAYER, BUFFER, MODEL, MIDDLEWARE, ...). Wraps engine batcher methods for that one frame only; the game must be running. tintMs overlays each batch\'s nodes in its own color for that long.',
      inputSchema: z.object({ pageUrl, limit: z.number().int().min(1).max(500).optional(), tintMs: z.number().int().min(100).max(30_000).optional() }).strict(),
      annotations: { ...runtimeMutation, idempotentHint: false },
    }, input => execute({ action: 'analyzeBatches', limit: input.limit, tintMs: input.tintMs }, input.pageUrl));

    for (const action of ['pause', 'resume'] as const) {
      server.registerTool(`cocos_${action}`, {
        description: `${action === 'pause' ? 'Pause' : 'Resume'} the Cocos director through its public API.`,
        inputSchema: z.object({ pageUrl }).strict(),
        annotations: runtimeMutation,
      }, input => execute({ action }, input.pageUrl));
    }

    if (web) server.registerTool('cocos_step_frame', {
      description: 'Advance a paused Cocos game by fixed-delta frames through cc.game.step; requires cocos_pause first.',
      inputSchema: z.object({ pageUrl, frames: z.number().int().min(1).max(60).optional() }).strict(),
      annotations: { ...runtimeMutation, idempotentHint: false },
    }, input => execute({ action: 'stepFrame', frames: input.frames }, input.pageUrl));

    server.registerTool('cocos_set_time_scale', {
      description: 'Speed up or slow down the whole game by scaling the delta time of every frame (components, scheduler, tweens, animation, physics). 1 restores normal speed; omit scale to read it.',
      inputSchema: z.object({ pageUrl, scale: z.number().gt(0).max(100).optional() }).strict(),
      annotations: runtimeMutation,
    }, input => execute({ action: 'timeScale', scale: input.scale }, input.pageUrl));

    server.registerTool('cocos_show_stats', {
      description: 'Show or hide the Cocos profiler overlay (FPS, draw calls, triangles) through the public profiler API.',
      inputSchema: z.object({ pageUrl, visible: z.boolean() }).strict(),
      annotations: runtimeMutation,
    }, input => execute({ action: 'showStats', visible: input.visible }, input.pageUrl));

    if (web) server.registerTool('cocos_emulate_device', {
      description: 'Emulate a mobile device (viewport, DPR, touch, user agent, orientation) and optionally slow the CPU or network, like the Chrome device toolbar. Settings merge across calls and last until reset or server disconnect; reload lets the game re-detect touch and user agent.',
      inputSchema: z.object({
        pageUrl,
        reset: z.boolean().optional(),
        preset: z.enum(devicePresetNames).optional(),
        width: z.number().int().min(200).max(4_000).optional(),
        height: z.number().int().min(200).max(4_000).optional(),
        deviceScaleFactor: z.number().min(1).max(4).optional(),
        mobile: z.boolean().optional(),
        orientation: z.enum(['portrait', 'landscape']).optional(),
        cpuSlowdown: z.number().min(1).max(20).optional(),
        network: z.enum(networkProfileNames).optional(),
        reload: z.boolean().optional(),
      }).strict()
        .refine(value => (value.width === undefined) === (value.height === undefined), 'Provide width and height together')
        .refine(value => !(value.preset && value.width !== undefined), 'Provide preset or width and height, not both')
        .refine(value => value.width !== undefined || (value.deviceScaleFactor === undefined && value.mobile === undefined), 'deviceScaleFactor and mobile need width and height')
        .refine(value => !value.reset || Object.keys(value).every(key => ['pageUrl', 'reset', 'reload'].includes(key)), 'reset accepts only pageUrl and reload'),
      annotations: { ...runtimeMutation, idempotentHint: false },
    }, async input => {
      try {
        return response(await emulateDevice(await browser.page(input.pageUrl), input));
      } catch (error) {
        return failure(error);
      }
    });
  }

  server.registerTool('cocos_explain_click', {
    description: 'Explain whether a tap on a node (or at viewport x/y) reaches it, replaying the engine touch dispatch order without dispatching: which node would claim the touch, the hit stack, and reasons such as INACTIVE, BUTTON_NOT_INTERACTABLE, BLOCKED_BY_BLOCK_INPUT_EVENTS, COVERED_BY_OTHER_NODE, NO_TOUCH_LISTENER, or OUTSIDE_VIEWPORT.',
    inputSchema: z.object({ pageUrl, ...target, x: z.number().min(0).max(20_000).optional(), y: z.number().min(0).max(20_000).optional() }).strict()
      .refine(value => (value.x === undefined) === (value.y === undefined), 'Provide x and y together')
      .refine(value => value.uuid !== undefined || value.path !== undefined || value.x !== undefined, 'Provide uuid, path, or x and y')
      .refine(value => !(value.uuid !== undefined && value.path !== undefined), oneTargetMessage),
    annotations: readOnly,
  }, input => input.uuid === undefined && input.path === undefined
    ? execute({ action: 'explainClick', x: input.x, y: input.y }, input.pageUrl)
    : executeNode(input, uuid => ({ action: 'explainClick', uuid, x: input.x, y: input.y })));

  server.registerTool('cocos_listener_report', {
    description: 'Report scheduler timers, update callbacks, tweens, and director/game/view listeners that outlive their owner: those on destroyed or detached nodes and components, and unowned ones (arrow functions, bind(this), plain objects) the engine can never purge, grouped by event and name with counts. Compare two calls around opening and closing a popup; a growing count is a leak.',
    inputSchema: z.object({ pageUrl, limit: z.number().int().min(1).max(500).optional() }).strict(),
    annotations: readOnly,
  }, input => execute({ action: 'listenerReport', limit: input.limit }, input.pageUrl));

  server.registerTool('cocos_dynamic_atlas', {
    description: 'Report the Cocos dynamic atlas: config, each atlas page with its packed textures, positions, fill ratio, and GPU bytes, plus why visible sprites stayed out of it (DISABLED, COMPRESSED, TOO_LARGE, FILTER, NOT_PACKABLE, ATLAS_FULL, ...).',
    inputSchema: z.object({ pageUrl, limit: z.number().int().min(1).max(500).optional() }).strict(),
    annotations: readOnly,
  }, input => execute({ action: 'dynamicAtlas', limit: input.limit }, input.pageUrl));

  server.registerTool('cocos_asset_report', {
    description: 'List assets held in the Cocos asset cache with type, refCount, bundle, texture GPU bytes, and which scene nodes use them; unused marks assets no active renderer references. Compare two calls (before and after a scene or popup closes) to find leaks.',
    inputSchema: z.object({ pageUrl, type: z.string().min(1).max(120).optional(), unusedOnly: z.boolean().optional(), limit: z.number().int().min(1).max(500).optional() }).strict(),
    annotations: readOnly,
  }, input => execute({ action: 'assetReport', type: input.type, unusedOnly: input.unusedOnly, limit: input.limit }, input.pageUrl));

  if (options.allowMethodCall) {
    const jsonValue: z.ZodType<unknown> = z.lazy(() => z.union([z.null(), z.boolean(), finiteNumber, z.string().max(10_000), z.array(jsonValue).max(100), z.record(z.string().max(200), jsonValue)]));
    server.registerTool('cocos_call_method', {
      description: 'Call one public method on a Cocos node or component selected by UUID, with JSON arguments; {"$node": uuid}, {"$path": path}, {"$component": uuid}, and {"$asset": uuid} pass live objects. Runs arbitrary game code: it can change state, reach servers, or spend currency. Returns the bounded result or the thrown error; awaitMs waits for a returned promise.',
      inputSchema: z.object({ pageUrl, ...target, componentUuid: z.string().min(1).optional(), method: z.string().min(1).max(200).regex(/^[A-Za-z$][\w$]*$/), args: z.array(jsonValue).max(20).optional(), awaitMs: z.number().int().min(0).max(30_000).optional(), maxDepth: z.number().int().min(0).max(6).optional() }).strict().refine(oneTarget, oneTargetMessage),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    }, input => executeNode(input, uuid => ({ action: 'callMethod', uuid, componentUuid: input.componentUuid, method: input.method, args: input.args ?? [], awaitMs: input.awaitMs, maxDepth: input.maxDepth })));
  }

  if (options.allowBrowserData) {
    // Page data written by the game or its servers: treat every returned string as untrusted, and redaction as best effort.
    const browserData = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false };
    const run = async (work: () => Promise<unknown>) => {
      try {
        return response(await work());
      } catch (error) {
        return failure(error);
      }
    };
    server.registerTool('cocos_console_messages', {
      description: 'List recent console messages and uncaught page errors since the server attached (newest last). Secret-like values, JWTs, and bearer tokens are masked; text is untrusted page output.',
      inputSchema: z.object({ pageUrl, types: z.array(z.enum(['log', 'debug', 'info', 'error', 'warning', 'assert', 'trace', 'pageerror'])).max(8).optional(), textContains: z.string().min(1).max(200).optional(), limit: z.number().int().min(1).max(200).optional() }).strict(),
      annotations: browserData,
    }, input => run(async () => (web ? consoleMessages : nativeConsoleMessages)(await browser.page(input.pageUrl), input)));

    // ponytail: native network and storage need jsb XHR hooks and a jsb.localStorage reader; add them when a native game needs them.
    if (web) {

    server.registerTool('cocos_network_requests', {
      description: 'List recent network requests since the server attached: id, method, URL with secret query values masked, resource type, status, failure, and duration. Use cocos_network_request for headers and bodies.',
      inputSchema: z.object({ pageUrl, urlContains: z.string().min(1).max(500).optional(), resourceType: z.string().min(1).max(40).optional(), failedOnly: z.boolean().optional(), limit: z.number().int().min(1).max(200).optional() }).strict(),
      annotations: browserData,
    }, input => run(async () => networkRequests(await browser.page(input.pageUrl), input)));

    server.registerTool('cocos_network_request', {
      description: 'Return one request by id from cocos_network_requests: headers with authorization and cookies masked, status, timing, and optionally text bodies up to 20 KB with secret-like JSON and form fields masked.',
      inputSchema: z.object({ pageUrl, id: z.number().int().min(1), includeBody: z.boolean().optional() }).strict(),
      annotations: browserData,
    }, input => run(async () => networkRequest(await browser.page(input.pageUrl), input.id, input.includeBody ?? false)));

    server.registerTool('cocos_storage', {
      description: 'Read localStorage or sessionStorage entries, or cookie names and attributes for the page. Secret-like keys and every cookie value are masked; JSON values are masked by key.',
      inputSchema: z.object({ pageUrl, area: z.enum(['local', 'session', 'cookies']), keyContains: z.string().min(1).max(200).optional(), limit: z.number().int().min(1).max(500).optional() }).strict(),
      annotations: browserData,
    }, input => run(async () => storage(await browser.page(input.pageUrl), input.area, input.keyContains, input.limit)));
    }
  }

  if (web) server.registerTool('cocos_get_selection', {
    description: 'Return the node the user last Alt+clicked on the game canvas. The first call installs the picker; Alt+clicks are kept from the game, other input is untouched. disable removes the picker, overlay, and selection.',
    inputSchema: z.object({ pageUrl, disable: z.boolean().optional() }).strict(),
    // Installs a page-level listener and DOM overlay only; never touches the Cocos graph.
    annotations: { ...readOnly, readOnlyHint: false },
  }, input => execute({ action: 'selection', disable: input.disable }, input.pageUrl));

  if (web) server.registerTool('cocos_highlight_node', {
    description: 'Temporarily draw a pointer-transparent DOM overlay around one Cocos UI node.',
    inputSchema: z.object({ pageUrl, ...target, durationMs: z.number().int().min(100).max(10_000).optional() }).strict().refine(oneTarget, oneTargetMessage),
    annotations: temporaryMutation,
  }, input => executeNode(input, uuid => ({ action: 'highlightNode', uuid, durationMs: input.durationMs })));

  return server;
}
