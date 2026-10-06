import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BrowserConnection, InspectorError, sanitizeUrl } from './browser.js';
import { captureNode, clickNode, devicePresetNames, emulateDevice, inspectCocosPage, networkProfileNames, runBridge, type BridgeRequest } from './bridge.js';

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

export function createServer(browser: BrowserConnection, options: { allowRuntimeMutation?: boolean } = {}): McpServer {
  const server = new McpServer({ name: 'cocos-web-inspector-mcp', version });
  const execute = async (request: BridgeRequest, selectedPage?: string) => {
    try {
      return response(await runBridge(await browser.page(selectedPage), request));
    } catch (error) {
      return failure(error);
    }
  };

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
    inputSchema: z.object({ pageUrl, uuid: z.string().min(1) }).strict(),
    annotations: readOnly,
  }, input => execute({ action: 'getNode', uuid: input.uuid }, input.pageUrl));

  server.registerTool('cocos_snapshot_subtree', {
    description: 'Return a bounded stateless subtree snapshot for one exact Cocos node UUID.',
    inputSchema: z.object({ pageUrl, uuid: z.string().min(1), maxDepth: z.number().int().min(0).max(20).optional(), maxNodes: z.number().int().min(1).max(5_000).optional() }).strict(),
    annotations: readOnly,
  }, input => execute({ action: 'snapshotSubtree', uuid: input.uuid, maxDepth: input.maxDepth, maxNodes: input.maxNodes }, input.pageUrl));

  server.registerTool('cocos_get_node_bounds', {
    description: 'Return bounded canvas and viewport bounds for one Cocos UI node UUID.',
    inputSchema: z.object({ pageUrl, uuid: z.string().min(1) }).strict(),
    annotations: readOnly,
  }, input => execute({ action: 'getNodeBounds', uuid: input.uuid }, input.pageUrl));

  server.registerTool('cocos_capture_node', {
    description: 'Capture a bounded viewport-clipped PNG for one visible Cocos UI node UUID.',
    inputSchema: z.object({ pageUrl, uuid: z.string().min(1) }).strict(),
    annotations: readOnly,
  }, async input => {
    try {
      return response(await captureNode(await browser.page(input.pageUrl), input.uuid));
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool('cocos_get_components', {
    description: 'List bounded component summaries for one Cocos node UUID.',
    inputSchema: z.object({ pageUrl, uuid: z.string().min(1) }).strict(),
    annotations: readOnly,
  }, input => execute({ action: 'getComponents', uuid: input.uuid }, input.pageUrl));

  server.registerTool('cocos_get_properties', {
    description: 'Read bounded, cycle-safe public properties from a Cocos node or one component.',
    inputSchema: z.object({ pageUrl, uuid: z.string().min(1), componentType: z.string().min(1).optional(), componentUuid: z.string().min(1).optional(), maxDepth: z.number().int().min(0).max(6).optional() }).strict()
      .refine(value => !(value.componentType && value.componentUuid), 'Provide componentType or componentUuid, not both'),
    annotations: readOnly,
  }, input => execute({ action: 'getProperties', uuid: input.uuid, componentType: input.componentType, componentUuid: input.componentUuid, maxDepth: input.maxDepth }, input.pageUrl));

  server.registerTool('cocos_wait_for_property', {
    description: 'Poll one top-level property of a Cocos node or component until it equals a value or the timeout passes.',
    inputSchema: z.object({ pageUrl, uuid: z.string().min(1), componentType: z.string().min(1).optional(), componentUuid: z.string().min(1).optional(), key: z.string().min(1).max(200), equals: z.union([z.boolean(), finiteNumber, z.string().max(2_000), z.null()]), timeoutMs: z.number().int().min(100).max(30_000).optional(), intervalMs: z.number().int().min(50).max(5_000).optional() }).strict()
      .refine(value => !(value.componentType && value.componentUuid), 'Provide componentType or componentUuid, not both'),
    annotations: readOnly,
  }, async input => {
    try {
      const page = await browser.page(input.pageUrl);
      const request: BridgeRequest = { action: 'getProperties', uuid: input.uuid, componentType: input.componentType, componentUuid: input.componentUuid, maxDepth: 0 };
      const deadline = Date.now() + (input.timeoutMs ?? 5_000);
      let polls = 0;
      let value: unknown;
      for (;;) {
        polls++;
        value = ((await runBridge(page, request)) as { properties?: Record<string, unknown> }).properties?.[input.key];
        if (value === input.equals || Date.now() >= deadline) break;
        await new Promise(resolve => setTimeout(resolve, input.intervalMs ?? 200));
      }
      return response({ matched: value === input.equals, key: input.key, value: value ?? null, polls });
    } catch (error) {
      return failure(error);
    }
  });

  if (options.allowRuntimeMutation) {
    server.registerTool('cocos_set_node_active', {
      description: 'Set the active state of one Cocos node selected by exact UUID.',
      inputSchema: z.object({ pageUrl, uuid: z.string().min(1), active: z.boolean() }).strict(),
      annotations: runtimeMutation,
    }, input => execute({ action: 'setNodeActive', uuid: input.uuid, active: input.active }, input.pageUrl));

    server.registerTool('cocos_set_transform', {
      description: 'Update selected Cocos node position, rotation, or scale by exact UUID.',
      inputSchema: z.object({ pageUrl, uuid: z.string().min(1), position: vector3.optional(), rotation: quaternion.optional(), scale: vector3.optional() }).strict()
        .refine(value => !!value.position || !!value.rotation || !!value.scale, 'Provide position, rotation, or scale'),
      annotations: runtimeMutation,
    }, input => execute({ action: 'setTransform', uuid: input.uuid, position: input.position, rotation: input.rotation, scale: input.scale }, input.pageUrl));

    server.registerTool('cocos_set_property', {
      description: 'Update one bounded public data property selected by node and component UUID.',
      inputSchema: z.object({ pageUrl, uuid: z.string().min(1), componentUuid: z.string().min(1), key: z.string().min(1).max(200), value: propertyValue }).strict(),
      annotations: runtimeMutation,
    }, input => execute({ action: 'setProperty', uuid: input.uuid, componentUuid: input.componentUuid, key: input.key, value: input.value }, input.pageUrl));

    server.registerTool('cocos_click_node', {
      description: 'Dispatch a real mouse click at the visible center of one Cocos UI node, so Button and touch handlers run. Handlers may call game servers or make irreversible changes.',
      inputSchema: z.object({ pageUrl, uuid: z.string().min(1) }).strict(),
      // Game click handlers run arbitrary code: a login button reaches real servers, a buy button spends currency.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    }, async input => {
      try {
        return response(await clickNode(await browser.page(input.pageUrl), input.uuid));
      } catch (error) {
        return failure(error);
      }
    });

    for (const action of ['pause', 'resume'] as const) {
      server.registerTool(`cocos_${action}`, {
        description: `${action === 'pause' ? 'Pause' : 'Resume'} the Cocos director through its public API.`,
        inputSchema: z.object({ pageUrl }).strict(),
        annotations: runtimeMutation,
      }, input => execute({ action }, input.pageUrl));
    }

    server.registerTool('cocos_step_frame', {
      description: 'Advance a paused Cocos game by fixed-delta frames through cc.game.step; requires cocos_pause first.',
      inputSchema: z.object({ pageUrl, frames: z.number().int().min(1).max(60).optional() }).strict(),
      annotations: { ...runtimeMutation, idempotentHint: false },
    }, input => execute({ action: 'stepFrame', frames: input.frames }, input.pageUrl));

    server.registerTool('cocos_show_stats', {
      description: 'Show or hide the Cocos profiler overlay (FPS, draw calls, triangles) through the public profiler API.',
      inputSchema: z.object({ pageUrl, visible: z.boolean() }).strict(),
      annotations: runtimeMutation,
    }, input => execute({ action: 'showStats', visible: input.visible }, input.pageUrl));

    server.registerTool('cocos_emulate_device', {
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

  server.registerTool('cocos_highlight_node', {
    description: 'Temporarily draw a pointer-transparent DOM overlay around one Cocos UI node.',
    inputSchema: z.object({ pageUrl, uuid: z.string().min(1), durationMs: z.number().int().min(100).max(10_000).optional() }).strict(),
    annotations: temporaryMutation,
  }, input => execute({ action: 'highlightNode', uuid: input.uuid, durationMs: input.durationMs }, input.pageUrl));

  return server;
}
