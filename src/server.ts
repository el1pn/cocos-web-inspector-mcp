import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BrowserConnection } from './browser.js';
import { runBridge, type BridgeRequest } from './bridge.js';

const pageUrl = z.url().optional();
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const temporaryMutation = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

function response(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data) }],
    structuredContent: data as Record<string, unknown>,
  };
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : 'Inspector request failed';
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

export function createServer(browser: BrowserConnection): McpServer {
  const server = new McpServer({ name: 'cocos-web-inspector-mcp', version: '0.1.1' });
  const execute = async (request: BridgeRequest, selectedPage?: string) => {
    try {
      return response(await runBridge(await browser.page(selectedPage), request));
    } catch (error) {
      return failure(error);
    }
  };

  server.registerTool('cocos_scene_tree', {
    description: 'Return a bounded Cocos Creator 3.x scene tree from a localhost Chromium page.',
    inputSchema: z.object({ pageUrl, maxDepth: z.number().int().min(0).max(20).optional(), maxNodes: z.number().int().min(1).max(5_000).optional() }).strict(),
    annotations: readOnly,
  }, input => execute({ action: 'sceneTree', maxDepth: input.maxDepth, maxNodes: input.maxNodes }, input.pageUrl));

  server.registerTool('cocos_find_node', {
    description: 'Find Cocos nodes by exact UUID, name, or absolute scene path.',
    inputSchema: z.object({ pageUrl, uuid: z.string().min(1).optional(), name: z.string().min(1).optional(), path: z.string().min(1).optional(), limit: z.number().int().min(1).max(100).optional() }).strict()
      .refine(value => [value.uuid, value.name, value.path].filter(Boolean).length === 1, 'Provide exactly one of uuid, name, or path'),
    annotations: readOnly,
  }, input => execute({ action: 'findNode', uuid: input.uuid, name: input.name, path: input.path, limit: input.limit }, input.pageUrl));

  server.registerTool('cocos_get_components', {
    description: 'List bounded component summaries for one Cocos node UUID.',
    inputSchema: z.object({ pageUrl, uuid: z.string().min(1) }).strict(),
    annotations: readOnly,
  }, input => execute({ action: 'getComponents', uuid: input.uuid }, input.pageUrl));

  server.registerTool('cocos_get_properties', {
    description: 'Read bounded, cycle-safe public properties from a Cocos node or component.',
    inputSchema: z.object({ pageUrl, uuid: z.string().min(1), componentType: z.string().min(1).optional(), maxDepth: z.number().int().min(0).max(6).optional() }).strict(),
    annotations: readOnly,
  }, input => execute({ action: 'getProperties', uuid: input.uuid, componentType: input.componentType, maxDepth: input.maxDepth }, input.pageUrl));

  server.registerTool('cocos_highlight_node', {
    description: 'Temporarily draw a pointer-transparent DOM overlay around one Cocos UI node.',
    inputSchema: z.object({ pageUrl, uuid: z.string().min(1), durationMs: z.number().int().min(100).max(10_000).optional() }).strict(),
    annotations: temporaryMutation,
  }, input => execute({ action: 'highlightNode', uuid: input.uuid, durationMs: input.durationMs }, input.pageUrl));

  return server;
}
