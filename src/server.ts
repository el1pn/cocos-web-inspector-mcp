import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Page } from 'playwright-core';
import { z } from 'zod';
import { BrowserConnection, InspectorError, sanitizeUrl } from './browser.js';
import { nativeCaptureNode, nativeClick,nativeConsoleMessages, nativeDrag, nativeNetworkRequest, nativeNetworkRequests, nativePressKey, nativeTypeText, type NativeConnection } from './native.js';
import { consoleMessages, networkRequest, networkRequests, storage } from './browser-data.js';
import { captureNode, clickNode, devicePresetNames, dragNode, emulateDevice, fitsResponse, inspectCocosPage, networkProfileNames, keyPattern, pressKey, runBridge, typeText, type BridgeRequest } from './bridge.js';

const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
// Agents send "" for unused optional fields; treat it as omitted.
const blank = <T extends z.ZodType>(schema: T) => z.preprocess(value => value === '' ? undefined : value, schema.optional());
// Keys agents guess, mapped to the real keys they probably meant. Applied only for tools whose schema has the real key.
const keyGuesses: Record<string, string[]> = {
  level: ['types'], type: ['types'], activeOnly: ['active'], value: ['equals'], property: ['key'], propertyPath: ['key'], depth: ['maxDepth'],
  component: ['componentType', 'componentUuid'],
};
// Strict object whose unknown-key error also lists the accepted keys, likely intended keys, and per-tool hints.
const obj = <T extends z.ZodRawShape>(shape: T, hints: Record<string, string> = {}) => z.object(shape, { error: issue => {
  if (issue.code !== 'unrecognized_keys') return undefined;
  const advice = issue.keys.flatMap(key => {
    const maybe = (keyGuesses[key] ?? []).filter(real => real in shape);
    return hints[key] ? [`${key}: ${hints[key]}`] : maybe.length ? [`${key}: did you mean ${maybe.join(' or ')}`] : [];
  });
  return `Unrecognized key(s): ${issue.keys.join(', ')}; accepted: ${Object.keys(shape).join(', ')}${advice.length ? `; ${advice.join('; ')}` : ''}`;
} }).strict();
const pageUrl = blank(z.url());
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
const target = { uuid: blank(z.string().min(1).max(200)), path: blank(z.string().min(1).max(10_000)) };
const oneTarget = (value: { uuid?: string | undefined; path?: string | undefined }) => (value.uuid === undefined) !== (value.path === undefined);
const oneTargetMessage = { error: (issue: { input?: unknown }) => (issue.input as Target | undefined)?.uuid === undefined && (issue.input as Target | undefined)?.path === undefined ? 'Provide uuid or path' : 'Provide uuid or path, not both' };
type Target = { pageUrl?: string | undefined; uuid?: string | undefined; path?: string | undefined };

async function resolveUuid(page: Page, input: Target): Promise<string> {
  if (input.uuid) return input.uuid;
  const found = await runBridge(page, { action: 'findNode', path: input.path, limit: 10 }) as { matches?: Array<{ uuid: string }>; truncated?: boolean };
  const matches = found.matches ?? [];
  if (matches.length === 0) throw new Error(found.truncated ? 'Node not found within traversal limit' : 'Node not found');
  if (matches.length > 1) throw new InspectorError('AMBIGUOUS_NODE', `Path matches ${found.truncated ? 'more than 10' : matches.length} nodes; pass one uuid: ${matches.map(match => match.uuid).join(', ')}`);
  return matches[0]!.uuid;
}

// Agents pass "true" or "8000" for a boolean or number property: compare primitives of different types by their string form.
const looseEquals = (value: unknown, expected: unknown) => value === expected
  || ['string', 'number', 'boolean'].includes(typeof value) && ['string', 'number', 'boolean'].includes(typeof expected) && String(value) === String(expected);

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
  const code = message === 'Cocos Creator 2.x/3.x runtime not found' ? 'COCOS_NOT_FOUND'
    : message.startsWith('Unsupported on Cocos 2.x') ? 'UNSUPPORTED_ENGINE_VERSION'
    : message.startsWith('Active Cocos scene not found') ? 'SCENE_NOT_READY'
      : message.startsWith('Node not found') ? 'NODE_NOT_FOUND'
        : message.startsWith('Component not found') ? 'COMPONENT_NOT_FOUND'
          : message.startsWith('Ambiguous component type') ? 'AMBIGUOUS_COMPONENT'
            : message.startsWith('Invalid mutation') ? 'INVALID_MUTATION'
            : 'CDP_UNAVAILABLE';
  return { ...response({ code, message }), isError: true };
}

export function createServer(browser: BrowserConnection | NativeConnection, options: { allowRuntimeMutation?: boolean; allowBrowserData?: boolean; allowMethodCall?: boolean; native?: boolean } = {}): McpServer {
  const server = new McpServer({ name: 'cocos-web-inspector-mcp', version });
  // A native (JSB) runtime has no page: screenshots and device emulation need a browser,
  // the DOM overlays draw nothing, the 2D batcher runs in C++ where analyze_batches cannot observe it,
  // and game.step renders outside the native frame loop, which crashed a 3.8.8 Android build in the GFX pipeline.
  const web = !options.native;
  const pageIds = new WeakMap<object, number>();
  const baselines = new Map<string, { snapshot: any; revision: number }>();
  let nextPageId = 1;
  let revision = 0;
  const pageId = (page: object) => {
    let id = pageIds.get(page);
    if (id === undefined) { id = nextPageId++; pageIds.set(page, id); }
    return id;
  };
  const observeChanges = async (input: Target & { reset?: boolean | undefined; maxDepth?: number | undefined; maxNodes?: number | undefined }) => {
    try {
      const page = await browser.page(input.pageUrl);
      const uuid = input.uuid ?? (input.path ? await resolveUuid(page, input) : undefined);
      const snapshot = JSON.parse(JSON.stringify(await runBridge(page, { action: 'semanticSnapshot', uuid, maxDepth: input.maxDepth, maxNodes: input.maxNodes }))) as any;
      const selector = input.uuid ? `uuid:${input.uuid}` : input.path ? `path:${input.path}` : 'scene';
      const key = JSON.stringify([pageId(page), page.url(), snapshot.documentId ?? null, selector, input.maxDepth ?? 6, input.maxNodes ?? 500]);
      const prior = baselines.get(key);
      if (input.reset) baselines.delete(key);
      const baseline = input.reset ? undefined : prior;
      const full = (reason: string) => {
        const next = { snapshot, revision: ++revision };
        baselines.delete(key);
        baselines.set(key, next);
        while (baselines.size > 32) baselines.delete(baselines.keys().next().value!);
        return { mode: 'full', reason, revision: next.revision, snapshot };
      };
      if (!baseline) return response(full(input.reset ? 'RESET' : 'BASELINE_MISSING'));
      baselines.delete(key);
      baselines.set(key, baseline);
      const before = new Map((baseline.snapshot.nodes ?? []).map((node: any) => [node.uuid, node]));
      const after = new Map((snapshot.nodes ?? []).map((node: any) => [node.uuid, node]));
      const nodes = [...after.values()] as any[];
      const added = nodes.filter(node => !before.has(node.uuid));
      const removed = [...before.keys()].filter(uuid => !after.has(uuid));
      const changed = nodes.flatMap(node => {
        const old: any = before.get(node.uuid);
        if (!old) return [];
        const changes = Object.fromEntries([...new Set([...Object.keys(old), ...Object.keys(node)])]
          .filter(field => field !== 'uuid' && JSON.stringify(node[field]) !== JSON.stringify(old[field]))
          .map(field => [field, field in node ? node[field] : null]));
        return Object.keys(changes).length ? [{ uuid: node.uuid, changes }] : [];
      });
      const metadataChanged = JSON.stringify({ truncated: snapshot.truncated, truncationReasons: snapshot.truncationReasons }) !== JSON.stringify({ truncated: baseline.snapshot.truncated, truncationReasons: baseline.snapshot.truncationReasons });
      if (!added.length && !removed.length && !changed.length && !metadataChanged) return response({ mode: 'unchanged', revision: baseline.revision });
      if (metadataChanged) return response(full('TRUNCATION_CHANGED'));
      const delta = { added, removed, changed };
      const deltaResult = { mode: 'delta', revision: revision + 1, delta };
      if (JSON.stringify(delta).length >= JSON.stringify(snapshot).length || !fitsResponse(deltaResult)) return response(full('DELTA_NOT_SMALLER_THAN_FULL'));
      const next = { snapshot, revision: ++revision };
      baselines.delete(key);
      baselines.set(key, next);
      return response({ ...deltaResult, revision: next.revision });
    } catch (error) {
      return failure(error);
    }
  };
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
    inputSchema: obj({}),
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
    description: 'Return bounded runtime information for one localhost Cocos Creator 2.x or 3.x page.',
    inputSchema: obj({ pageUrl }),
    annotations: readOnly,
  }, input => execute({ action: 'runtimeInfo' }, input.pageUrl));

  server.registerTool('cocos_runtime_diagnostics', {
    description: 'Return bounded passive Cocos scene hierarchy diagnostics.',
    inputSchema: obj({ pageUrl }),
    annotations: readOnly,
  }, input => execute({ action: 'runtimeDiagnostics' }, input.pageUrl));

  server.registerTool('cocos_scene_tree', {
    description: 'Return a bounded Cocos Creator 2.x or 3.x scene tree from a localhost Chromium page.',
    inputSchema: obj({ pageUrl, maxDepth: z.number().int().min(0).max(20).optional(), maxNodes: z.number().int().min(1).max(5_000).optional() }, { path: 'cocos_scene_tree has no subtree root; use cocos_snapshot_subtree with path or uuid', uuid: 'cocos_scene_tree has no subtree root; use cocos_snapshot_subtree with path or uuid' }),
    annotations: readOnly,
  }, input => execute({ action: 'sceneTree', maxDepth: input.maxDepth, maxNodes: input.maxNodes }, input.pageUrl));

  server.registerTool('cocos_find_node', {
    description: 'Find Cocos nodes with bounded exact and filter criteria.',
    inputSchema: obj({ pageUrl, uuid: blank(z.string().min(1).max(200)), name: blank(z.string().min(1).max(500)), path: blank(z.string().min(1).max(10_000)), nameContains: blank(z.string().min(1).max(500)), componentType: blank(z.string().min(1).max(120)), active: z.boolean().optional(), pathPrefix: blank(z.string().min(1).max(10_000)), limit: z.number().int().min(1).max(100).optional() }).strict()
      .refine(value => [value.uuid, value.name, value.path, value.nameContains, value.componentType, value.active, value.pathPrefix].some(item => item !== undefined), 'Provide at least one filter'),
    annotations: readOnly,
  }, input => execute({ action: 'findNode', uuid: input.uuid, name: input.name, path: input.path, nameContains: input.nameContains, componentType: input.componentType, active: input.active, pathPrefix: input.pathPrefix, limit: input.limit }, input.pageUrl));

  server.registerTool('cocos_get_node', {
    description: 'Return bounded context for one exact Cocos node UUID.',
    inputSchema: obj({ pageUrl, ...target }).refine(oneTarget, oneTargetMessage),
    annotations: readOnly,
  }, input => executeNode(input, uuid => ({ action: 'getNode', uuid })));

  server.registerTool('cocos_snapshot_subtree', {
    description: 'Return a bounded stateless subtree snapshot for one exact Cocos node UUID.',
    inputSchema: obj({ pageUrl, ...target, maxDepth: z.number().int().min(0).max(20).optional(), maxNodes: z.number().int().min(1).max(5_000).optional() }).refine(oneTarget, oneTargetMessage),
    annotations: readOnly,
  }, input => executeNode(input, uuid => ({ action: 'snapshotSubtree', uuid, maxDepth: input.maxDepth, maxNodes: input.maxNodes })));

  server.registerTool('cocos_observe_changes', {
    description: 'Observe bounded semantic scene changes since the prior matching call.',
    inputSchema: obj({ pageUrl, ...target, reset: z.boolean().optional(), maxDepth: z.number().int().min(0).max(20).optional(), maxNodes: z.number().int().min(1).max(5_000).optional() }).refine(value => !(value.uuid && value.path), oneTargetMessage),
    annotations: readOnly,
  }, input => observeChanges(input));

  server.registerTool('cocos_get_node_bounds', {
    description: 'Return bounded canvas and viewport bounds for one Cocos UI node UUID.',
    inputSchema: obj({ pageUrl, ...target }).refine(oneTarget, oneTargetMessage),
    annotations: readOnly,
  }, input => executeNode(input, uuid => ({ action: 'getNodeBounds', uuid })));

  server.registerTool('cocos_capture_node', {
    description: 'Capture a bounded viewport-clipped PNG for one visible Cocos UI node UUID. Pass maxBytes to cap the base64 image size when the client rejects large results.',
    inputSchema: obj({ pageUrl, ...target, maxBytes: z.number().int().min(1_000).max(200_000).optional() }).refine(oneTarget, oneTargetMessage),
    annotations: readOnly,
  }, input => withNode(input, (page, uuid) => (web ? captureNode : nativeCaptureNode)(page, uuid, input.maxBytes)));

  server.registerTool('cocos_get_components', {
    description: 'List bounded component summaries for one Cocos node UUID.',
    inputSchema: obj({ pageUrl, ...target }).refine(oneTarget, oneTargetMessage),
    annotations: readOnly,
  }, input => executeNode(input, uuid => ({ action: 'getComponents', uuid })));

  server.registerTool('cocos_get_properties', {
    description: 'Read bounded, cycle-safe public properties from a Cocos node or one component.',
    inputSchema: obj({ pageUrl, ...target, componentType: blank(z.string().min(1)), componentUuid: blank(z.string().min(1)), maxDepth: z.number().int().min(0).max(6).optional() }, { properties: 'not supported: every public property is returned; pick one component with componentType or componentUuid and bound it with maxDepth', keys: 'not supported: every public property is returned; pick one component with componentType or componentUuid and bound it with maxDepth', maxProperties: 'not supported: every public property is returned; pick one component with componentType or componentUuid and bound it with maxDepth' }).refine(oneTarget, oneTargetMessage)
      .refine(value => !(value.componentType && value.componentUuid), 'Provide componentType or componentUuid, not both'),
    annotations: readOnly,
  }, input => executeNode(input, uuid => ({ action: 'getProperties', uuid, componentType: input.componentType, componentUuid: input.componentUuid, maxDepth: input.maxDepth })));

  server.registerTool('cocos_wait_for_property', {
    description: 'Poll one top-level property of a Cocos node or component until it equals a value or the timeout passes. Booleans, numbers, and strings of different types match by string form ("true" matches true, "8000" matches 8000).',
    inputSchema: obj({ pageUrl, ...target, componentType: blank(z.string().min(1)), componentUuid: blank(z.string().min(1)), key: z.string().min(1).max(200), equals: z.union([z.boolean(), finiteNumber, z.string().max(2_000), z.null()]), timeoutMs: z.number().int().min(100).max(30_000, 'timeoutMs max is 30000').optional(), intervalMs: z.number().int().min(50).max(5_000, 'intervalMs max is 5000').optional() }).refine(oneTarget, oneTargetMessage)
      .refine(value => !(value.componentType && value.componentUuid), 'Provide componentType or componentUuid, not both'),
    annotations: readOnly,
  }, async input => {
    try {
      const page = await browser.page(input.pageUrl);
      const deadline = Date.now() + (input.timeoutMs ?? 5_000);
      let polls = 0;
      let value: unknown;
      let gone: string | undefined;
      // A path is resolved on every poll so a scene switch or a node still being created does not end the wait early.
      for (let uuid = input.uuid;;) {
        polls++;
        try {
          uuid ??= await resolveUuid(page, input);
          value = ((await runBridge(page, { action: 'getProperties', uuid, componentType: input.componentType, componentUuid: input.componentUuid, maxDepth: 0 })) as { properties?: Record<string, unknown> }).properties?.[input.key];
          gone = undefined;
        } catch (error) {
          const message = error instanceof Error ? error.message : '';
          if (!/Node not found|Active Cocos scene not found|Component not found/.test(message)) throw error;
          gone = message.replace(/^page\.evaluate: (?:Error: )?/, '').split('\n')[0]!;
          value = undefined;
          if (!input.uuid) uuid = undefined;
        }
        if (gone === undefined && looseEquals(value, input.equals) || Date.now() >= deadline) break;
        await new Promise(resolve => setTimeout(resolve, input.intervalMs ?? 200));
      }
      return response({ matched: gone === undefined && looseEquals(value, input.equals), key: input.key, value: value ?? null, polls, ...(gone ? { gone } : {}) });
    } catch (error) {
      return failure(error);
    }
  });

  if (options.allowRuntimeMutation) {
    server.registerTool('cocos_set_node_active', {
      description: 'Set the active state of one Cocos node selected by exact UUID.',
      inputSchema: obj({ pageUrl, ...target, active: z.boolean() }).refine(oneTarget, oneTargetMessage),
      annotations: runtimeMutation,
    }, input => executeNode(input, uuid => ({ action: 'setNodeActive', uuid, active: input.active })));

    server.registerTool('cocos_set_transform', {
      description: 'Update selected Cocos node position, rotation, or scale by exact UUID.',
      inputSchema: obj({ pageUrl, ...target, position: vector3.optional(), rotation: quaternion.optional(), scale: vector3.optional() }).refine(oneTarget, oneTargetMessage)
        .refine(value => !!value.position || !!value.rotation || !!value.scale, 'Provide position, rotation, or scale'),
      annotations: runtimeMutation,
    }, input => executeNode(input, uuid => ({ action: 'setTransform', uuid, position: input.position, rotation: input.rotation, scale: input.scale })));

    server.registerTool('cocos_set_property', {
      description: 'Update one bounded public data property selected by node and component UUID.',
      inputSchema: obj({ pageUrl, ...target, componentUuid: z.string().min(1), key: z.string().min(1).max(200), value: propertyValue }).refine(oneTarget, oneTargetMessage),
      annotations: runtimeMutation,
    }, input => executeNode(input, uuid => ({ action: 'setProperty', uuid, componentUuid: input.componentUuid, key: input.key, value: input.value })));

    server.registerTool('cocos_click_node', {
      description: 'Dispatch a real mouse click at the visible center of one Cocos UI node, so Button and touch handlers run. Handlers may call game servers or make irreversible changes.',
      inputSchema: obj({ pageUrl, ...target }).refine(oneTarget, oneTargetMessage),
      // Game click handlers run arbitrary code: a login button reaches real servers, a buy button spends currency.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    }, input => withNode(input, web ? clickNode : nativeClick));

    // Like click: game drag and input handlers run arbitrary code.
    const realInput = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
    server.registerTool('cocos_drag_node', {
      description: 'Drag from the visible center of one Cocos UI node by dx/dy CSS pixels with real pointer input, to scroll a ScrollView, flip a PageView, or move a Slider. Under touch emulation the drag arrives as touch. Handlers may call game servers.',
      inputSchema: obj({ pageUrl, ...target, dx: z.number().min(-4_000).max(4_000), dy: z.number().min(-4_000).max(4_000), steps: z.number().int().min(1).max(60).optional(), durationMs: z.number().int().min(0).max(5_000).optional() }).refine(oneTarget, oneTargetMessage)
        .refine(value => value.dx !== 0 || value.dy !== 0, 'Provide a non-zero dx or dy'),
      annotations: realInput,
    }, input => withNode(input, (page, uuid) => web ? dragNode(page, uuid, input.dx, input.dy, input.steps, input.durationMs) : nativeDrag(page, uuid, input.dx, input.dy, input.durationMs)));

    server.registerTool('cocos_type_text', {
      description: 'Tap one Cocos EditBox and type text with real keyboard input, replacing its content, so text-changed and editing events fire; submit presses Enter (editing-return on single-line boxes, a newline in multi-line ones). Password text is never echoed back.',
      inputSchema: obj({ pageUrl, ...target, text: z.string().max(2_000), submit: z.boolean().optional() }).refine(oneTarget, oneTargetMessage),
      annotations: realInput,
    }, input => withNode(input, (page, uuid) => (web ? typeText : nativeTypeText)(page, uuid, input.text, input.submit ?? false)));

    server.registerTool('cocos_press_key', {
      description: 'Press and release one key with real keyboard input, for game keyboard handlers and focused inputs: Enter, Escape, Tab, Backspace, Delete, Space, arrows, Home, End, PageUp, PageDown, a letter, or a digit. To fill an EditBox use cocos_type_text. Handlers may call game servers.',
      inputSchema: obj({ pageUrl, key: z.string().regex(keyPattern, 'Use Enter, Escape, Tab, Backspace, Delete, Space, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, or one letter or digit') }),
      annotations: realInput,
    }, async input => {
      try {
        return response(await (web ? pressKey : nativePressKey)(await browser.page(input.pageUrl), input.key));
      } catch (error) {
        return failure(error);
      }
    });

    if (web) server.registerTool('cocos_analyze_batches', {
      description: 'Capture the 2D draw batches of the next rendered frame: the node that starts each batch and why the previous batch broke (TEXTURE, MATERIAL, MASK, STENCIL, LAYER, BUFFER, MODEL, MIDDLEWARE, ...). Wraps engine batcher methods for that one frame only; the game must be running. tintMs overlays each batch\'s nodes in its own color for that long.',
      inputSchema: obj({ pageUrl, limit: z.number().int().min(1).max(500).optional(), tintMs: z.number().int().min(100).max(30_000).optional() }),
      annotations: { ...runtimeMutation, idempotentHint: false },
    }, input => execute({ action: 'analyzeBatches', limit: input.limit, tintMs: input.tintMs }, input.pageUrl));

    server.registerTool('cocos_event_trace', {
      description: 'Count Node events (emit calls) per event name and node for a bounded window, to find event storms such as a TRANSFORM_CHANGED or custom event fired every frame. Wraps Node.prototype.emit for durationMs and restores it; arguments are never recorded.',
      inputSchema: obj({ pageUrl, durationMs: z.number().int().min(100).max(10_000).optional(), limit: z.number().int().min(1).max(200).optional() }),
      annotations: { ...runtimeMutation, idempotentHint: false },
    }, input => execute({ action: 'eventTrace', durationMs: input.durationMs, limit: input.limit }, input.pageUrl));

    for (const action of ['pause', 'resume'] as const) {
      server.registerTool(`cocos_${action}`, {
        description: `${action === 'pause' ? 'Pause' : 'Resume'} the Cocos director through its public API.`,
        inputSchema: obj({ pageUrl }),
        annotations: runtimeMutation,
      }, input => execute({ action }, input.pageUrl));
    }

    if (web) server.registerTool('cocos_step_frame', {
      description: 'Advance a paused Cocos game by fixed-delta frames through cc.game.step; requires cocos_pause first.',
      inputSchema: obj({ pageUrl, frames: z.number().int().min(1).max(60).optional() }),
      annotations: { ...runtimeMutation, idempotentHint: false },
    }, input => execute({ action: 'stepFrame', frames: input.frames }, input.pageUrl));

    server.registerTool('cocos_set_time_scale', {
      description: 'Speed up or slow down the whole game by scaling the delta time of every frame (components, scheduler, tweens, animation, physics). 1 restores normal speed; omit scale to read it.',
      inputSchema: obj({ pageUrl, scale: z.number().gt(0).max(100).optional() }),
      annotations: runtimeMutation,
    }, input => execute({ action: 'timeScale', scale: input.scale }, input.pageUrl));

    server.registerTool('cocos_show_stats', {
      description: 'Show or hide the Cocos profiler overlay (FPS, draw calls, triangles) through the public profiler API.',
      inputSchema: obj({ pageUrl, visible: z.boolean() }),
      annotations: runtimeMutation,
    }, input => execute({ action: 'showStats', visible: input.visible }, input.pageUrl));

    if (web) server.registerTool('cocos_emulate_device', {
      description: 'Emulate a mobile device (viewport, DPR, touch, user agent, orientation) and optionally slow the CPU or network (preset `network` such as offline or slow-3g, plus custom latencyMs, downloadKbps, uploadKbps; packet loss is not supported by Chrome for HTTP), like the Chrome device toolbar. Settings merge across calls and last until reset or server disconnect; reload lets the game re-detect touch and user agent.',
      inputSchema: obj({
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
        latencyMs: z.number().min(0).max(60_000).optional(),
        downloadKbps: z.number().min(1).max(1_000_000).optional(),
        uploadKbps: z.number().min(1).max(1_000_000).optional(),
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
    inputSchema: obj({ pageUrl, ...target, x: z.number().min(0).max(20_000).optional(), y: z.number().min(0).max(20_000).optional() }).strict()
      .refine(value => (value.x === undefined) === (value.y === undefined), 'Provide x and y together')
      .refine(value => value.x !== undefined
        ? value.uuid === undefined && value.path === undefined
        : oneTarget(value), 'Provide uuid, path, or x and y'),
    annotations: readOnly,
  }, input => input.uuid === undefined && input.path === undefined
    ? execute({ action: 'explainClick', x: input.x, y: input.y }, input.pageUrl)
    : executeNode(input, uuid => ({ action: 'explainClick', uuid, x: input.x, y: input.y })));

  server.registerTool('cocos_listener_report', {
    description: 'Report scheduler timers, update callbacks, tweens, and director/game/view listeners that outlive their owner: those on destroyed or detached nodes and components, and unowned ones (arrow functions, bind(this), plain objects) the engine can never purge, grouped by event and name with counts. Compare two calls around opening and closing a popup; a growing count is a leak.',
    inputSchema: obj({ pageUrl, limit: z.number().int().min(1).max(500).optional() }),
    annotations: readOnly,
  }, input => execute({ action: 'listenerReport', limit: input.limit }, input.pageUrl));

  for (const [name, action, description] of [
    ['cocos_explain_visibility', 'explainVisibility', 'Explain why a node is not visible: inactive ancestors, disabled or transparent renderer, missing spriteFrame, empty Label, zero opacity/scale/size, a layer no active camera renders, outside the viewport, clipped by a Mask, or possibly covered by an opaque Sprite. Returns reasons (definite) and warnings (possible) without changing anything.'],
    ['cocos_explain_layout', 'explainLayout', 'Explain why a node has its size and position: its Widget edges and align mode, a parent Layout that places or resizes it, Label/Sprite size modes, ancestor scale, and the resulting viewport rectangle. Pair with cocos_emulate_device to compare resolutions.'],
  ] as const) {
    server.registerTool(name, {
      description,
      inputSchema: obj({ pageUrl, ...target }).refine(oneTarget, oneTargetMessage),
      annotations: readOnly,
    }, input => executeNode(input, uuid => ({ action, uuid }) as BridgeRequest));
  }

  server.registerTool('cocos_animation_report', {
    description: 'List what is animating now: Animation components with playing states (speed, wrap mode, time), Spine/DragonBones components with their current animation, and tween targets with action counts. Read-only; nothing is played or stopped.',
    inputSchema: obj({ pageUrl, limit: z.number().int().min(1).max(500).optional() }),
    annotations: readOnly,
  }, input => execute({ action: 'animationReport', limit: input.limit }, input.pageUrl));

  server.registerTool('cocos_frame_profile', {
    description: 'Sample real frames for a while and report frame time (avg, p50, p95, max), fps, spike count, the worst frames, and draw call and triangle ranges. Needs the game running (not paused). Subscribes to the director for the sample window only.',
    inputSchema: obj({ pageUrl, frames: z.number().int().min(2).max(600).optional(), timeoutMs: z.number().int().min(100).max(30_000).optional() }),
    annotations: { ...readOnly, idempotentHint: false },
  }, input => execute({ action: 'frameProfile', frames: input.frames, timeoutMs: input.timeoutMs }, input.pageUrl));

  server.registerTool('cocos_dynamic_atlas', {
    description: 'Report the Cocos dynamic atlas: config, each atlas page with its packed textures, positions, fill ratio, and GPU bytes, plus why visible sprites stayed out of it (DISABLED, COMPRESSED, TOO_LARGE, FILTER, NOT_PACKABLE, ATLAS_FULL, ...).',
    inputSchema: obj({ pageUrl, limit: z.number().int().min(1).max(500).optional() }),
    annotations: readOnly,
  }, input => execute({ action: 'dynamicAtlas', limit: input.limit }, input.pageUrl));

  server.registerTool('cocos_asset_report', {
    description: 'List assets held in the Cocos asset cache with type, refCount, bundle, texture GPU bytes, and which scene nodes use them; unused marks assets no active renderer references. Compare two calls (before and after a scene or popup closes) to find leaks.',
    inputSchema: obj({ pageUrl, type: blank(z.string().min(1).max(120)), unusedOnly: z.boolean().optional(), limit: z.number().int().min(1).max(500).optional() }),
    annotations: readOnly,
  }, input => execute({ action: 'assetReport', type: input.type, unusedOnly: input.unusedOnly, limit: input.limit }, input.pageUrl));

  if (options.allowMethodCall) {
    // Not finiteNumber: method arguments include bitmasks such as node layers (1 << 25), which that +-1e6 transform bound rejects.
    const jsonValue: z.ZodType<unknown> = z.lazy(() => z.union([z.null(), z.boolean(), z.number().finite(), z.string().max(10_000), z.array(jsonValue).max(100), z.record(z.string().max(200), jsonValue)]));
    server.registerTool('cocos_call_method', {
      description: 'Call one public method on a Cocos node or component selected by UUID, with JSON arguments; {"$node": uuid}, {"$path": path}, {"$component": uuid}, and {"$asset": uuid} pass live objects. Runs arbitrary game code: it can change state, reach servers, or spend currency. Returns the bounded result or the thrown error; awaitMs waits for a returned promise.',
      inputSchema: obj({ pageUrl, ...target, componentUuid: blank(z.string().min(1)), method: z.string().min(1).max(200).regex(/^[A-Za-z$][\w$]*$/), args: z.array(jsonValue).max(20).optional(), awaitMs: z.number().int().min(0).max(30_000).optional(), maxDepth: z.number().int().min(0).max(6).optional() }, { componentType: 'only componentUuid is accepted; list it with cocos_get_components' }).refine(oneTarget, oneTargetMessage),
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
      inputSchema: obj({ pageUrl, types: z.array(z.enum(['log', 'debug', 'info', 'error', 'warning', 'assert', 'trace', 'pageerror'])).max(8).optional(), textContains: blank(z.string().min(1).max(200)), limit: z.number().int().min(1).max(200).optional() }),
      annotations: browserData,
    }, input => run(async () => (web ? consoleMessages : nativeConsoleMessages)(await browser.page(input.pageUrl), input)));

    server.registerTool('cocos_network_requests', {
      description: 'List recent network requests since the server attached: id, method, URL with secret query values masked, resource type, status, failure, and duration. Use cocos_network_request for headers and bodies.',
      inputSchema: obj({ pageUrl, urlContains: blank(z.string().min(1).max(500)), resourceType: blank(z.string().min(1).max(40)), failedOnly: z.boolean().optional(), limit: z.number().int().min(1).max(200).optional() }),
      annotations: browserData,
    }, input => run(async () => (web ? networkRequests : nativeNetworkRequests)(await browser.page(input.pageUrl), input)));

    server.registerTool('cocos_network_request', {
      description: 'Return one request by id from cocos_network_requests: headers with authorization and cookies masked, status, timing, and optionally text bodies up to 20 KB with secret-like JSON and form fields masked.',
      inputSchema: obj({ pageUrl, id: z.number().int().min(1), includeBody: z.boolean().optional() }),
      annotations: browserData,
    }, input => run(async () => (web ? networkRequest : nativeNetworkRequest)(await browser.page(input.pageUrl), input.id, input.includeBody ?? false)));

    server.registerTool('cocos_storage', {
      description: 'Read localStorage or sessionStorage entries, or cookie names and attributes for the page. Secret-like keys and every cookie value are masked; JSON values are masked by key.',
      inputSchema: obj({ pageUrl, area: z.enum(['local', 'session', 'cookies']), keyContains: blank(z.string().min(1).max(200)), limit: z.number().int().min(1).max(500).optional() }),
      annotations: browserData,
    }, input => run(async () => storage(await browser.page(input.pageUrl), input.area, input.keyContains, input.limit)));
  }

  if (web) server.registerTool('cocos_get_selection', {
    description: 'Return the node the user last Alt+clicked on the game canvas. The first call installs the picker; Alt+clicks are kept from the game, other input is untouched. disable removes the picker, overlay, and selection.',
    inputSchema: obj({ pageUrl, disable: z.boolean().optional() }),
    // Installs a page-level listener and DOM overlay only; never touches the Cocos graph.
    annotations: { ...readOnly, readOnlyHint: false },
  }, input => execute({ action: 'selection', disable: input.disable }, input.pageUrl));

  if (web) server.registerTool('cocos_highlight_node', {
    description: 'Temporarily draw a pointer-transparent DOM overlay around one Cocos UI node.',
    inputSchema: obj({ pageUrl, ...target, durationMs: z.number().int().min(100).max(10_000).optional() }).refine(oneTarget, oneTargetMessage),
    annotations: temporaryMutation,
  }, input => executeNode(input, uuid => ({ action: 'highlightNode', uuid, durationMs: input.durationMs })));

  // Agents guess parameter names and pass both uuid and path. Normalize the arguments before the strict schema runs, so the schemas stay strict.
  // ponytail: reads the SDK's private tool registry and call handler (no public hook for pre-validation); revisit when the SDK adds one.
  type ToolCall = { params: { name: string; arguments?: Record<string, unknown> } };
  type ToolResult = { content?: unknown[] };
  const registry = (server as unknown as { _registeredTools: Record<string, { inputSchema?: { shape?: Record<string, unknown> }; description?: string }> })._registeredTools;
  const handlers = (server.server as unknown as { _requestHandlers: Map<string, (request: ToolCall, extra: unknown) => Promise<ToolResult>> })._requestHandlers;
  const callTool = handlers.get('tools/call')!;
  const idNote = ' Node.N and Comp.N ids are runtime-assigned and change on reload or scene switch: re-resolve by path.';
  for (const tool of Object.values(registry)) if (tool.inputSchema?.shape?.['uuid'] && tool.description) tool.description += idNote;
  handlers.set('tools/call', async (request, extra) => {
    const shape = registry[request.params.name]?.inputSchema?.shape;
    const given = request.params.arguments;
    if (!shape || !given || typeof given !== 'object' || Array.isArray(given)) return callTool(request, extra);
    const args = { ...given };
    const notes: string[] = [];
    const present = (key: string) => args[key] !== undefined && args[key] !== '';
    for (const [guess, reals] of Object.entries(keyGuesses)) {
      const real = reals[0]!;
      if (reals.length !== 1 || guess in shape || !(real in shape) || !(guess in args) || present(real)) continue;
      let value = args[guess];
      delete args[guess];
      if (real === 'types') value = (Array.isArray(value) ? value : [value]).map(item => item === 'warn' ? 'warning' : item);
      args[real] = value;
      notes.push(`${guess} was read as ${real}; use ${real}`);
    }
    if (shape['uuid'] && shape['path'] && request.params.name !== 'cocos_find_node' && present('uuid') && present('path')) {
      delete args['path'];
      notes.push('uuid and path were both given; used uuid and ignored path');
    }
    if (typeof args['uuid'] === 'string' && args['uuid'].startsWith('Comp.')) {
      return failure(new InspectorError('NODE_NOT_FOUND', `${args['uuid']} is a component id, not a node id${shape['componentUuid'] ? '; pass it as componentUuid together with the node uuid or path' : '; pass the uuid or path of the node that owns it'}`)) as ToolResult;
    }
    const result = await callTool({ ...request, params: { ...request.params, arguments: args } }, extra);
    if (notes.length && Array.isArray(result.content)) result.content.push({ type: 'text', text: `Note: ${notes.join('; ')}` });
    return result;
  });

  return server;
}
