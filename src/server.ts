import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BrowserConnection, InspectorError, sanitizeUrl } from './browser.js';
import { captureNode, inspectCocosPage, runBridge, type BridgeRequest } from './bridge.js';

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
  const message = error instanceof Error ? error.message : 'Inspector request failed';
  const code = message === 'Cocos Creator 3.x runtime not found' ? 'COCOS_NOT_FOUND'
    : message === 'Active Cocos scene not found' ? 'SCENE_NOT_READY'
      : message.startsWith('Node not found') ? 'NODE_NOT_FOUND'
        : message === 'Component not found' ? 'COMPONENT_NOT_FOUND'
          : message === 'Ambiguous component type' ? 'AMBIGUOUS_COMPONENT'
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

    for (const action of ['pause', 'resume'] as const) {
      server.registerTool(`cocos_${action}`, {
        description: `${action === 'pause' ? 'Pause' : 'Resume'} the Cocos director through its public API.`,
        inputSchema: z.object({ pageUrl }).strict(),
        annotations: runtimeMutation,
      }, input => execute({ action }, input.pageUrl));
    }
  }

  server.registerTool('cocos_highlight_node', {
    description: 'Temporarily draw a pointer-transparent DOM overlay around one Cocos UI node.',
    inputSchema: z.object({ pageUrl, uuid: z.string().min(1), durationMs: z.number().int().min(100).max(10_000).optional() }).strict(),
    annotations: temporaryMutation,
  }, input => execute({ action: 'highlightNode', uuid: input.uuid, durationMs: input.durationMs }, input.pageUrl));

  return server;
}
