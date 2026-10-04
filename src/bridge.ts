import type { Page } from 'playwright-core';

export type BridgeRequest =
  | { action: 'sceneTree'; maxDepth?: number | undefined; maxNodes?: number | undefined }
  | { action: 'findNode'; uuid?: string | undefined; name?: string | undefined; path?: string | undefined; limit?: number | undefined }
  | { action: 'getComponents'; uuid: string }
  | { action: 'getProperties'; uuid: string; componentType?: string | undefined; maxDepth?: number | undefined }
  | { action: 'highlightNode'; uuid: string; durationMs?: number | undefined };

const MAX_BYTES = 200_000;

export async function runBridge(page: Page, request: BridgeRequest): Promise<unknown> {
  const result = await page.evaluate(inspectCocos, request);
  const text = JSON.stringify(result);
  const encoded = JSON.stringify({ content: [{ type: 'text', text }], structuredContent: result });
  if (Buffer.byteLength(encoded, 'utf8') > MAX_BYTES - 4_096) {
    return { truncated: true, reason: `Response exceeded ${MAX_BYTES} bytes` };
  }
  return result;
}

export function inspectCocos(request: BridgeRequest): unknown {
  const root = globalThis as typeof globalThis & {
    cc?: Record<string, any>;
    CC?: Record<string, any>;
    document?: Document;
    __cocosWebInspectorHighlightTimer?: ReturnType<typeof setTimeout>;
    __cocosWebInspectorOverlay?: HTMLElement | undefined;
  };
  if (root.location) {
    const target = new URL(root.location.href);
    const host = target.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    const loopback = host === 'localhost' || host.endsWith('.localhost') || host === '::1'
      || !!ipv4 && ipv4.slice(1).every(part => Number(part) <= 255) && ipv4[1] === '127';
    if (!['http:', 'https:'].includes(target.protocol) || !loopback) throw new Error('Only localhost pages are allowed');
  }
  const cc = root.cc ?? root.CC;
  const version = String(cc?.ENGINE_VERSION ?? cc?.version ?? '');
  if (!cc || !version.startsWith('3.')) throw new Error('Cocos Creator 3.x runtime not found');
  const scene = cc.director?.getScene?.();
  if (!scene) throw new Error('Active Cocos scene not found');

  const sensitiveParts = ['token', 'cookie', 'authorization', 'password', 'secret', 'credential', 'storage', 'jwt', 'apikey', 'privatekey', 'accesskey', 'signingkey', 'authheader'];
  const isSensitiveKey = (key: string): boolean => {
    const normalized = key.toLowerCase().replace(/[^a-z]/g, '');
    return sensitiveParts.some(part => normalized.includes(part))
      || normalized.includes('bearer')
      || normalized.startsWith('session') && ['id', 'key', 'token'].some(part => normalized.includes(part));
  };
  const dataProperty = (value: object, key: string): any => {
    let current: object | null = value;
    const prototypes = new Set<object>();
    for (let depth = 0; current && depth < 20 && !prototypes.has(current); depth++) {
      prototypes.add(current);
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor) return 'value' in descriptor ? descriptor.value : undefined;
      current = Object.getPrototypeOf(current);
    }
    return undefined;
  };
  const componentName = (component: any): string => {
    // ponytail: constructor metadata is the compatibility ceiling; add explicit engine adapters if minified builds need more.
    const name = dataProperty(component, 'constructor')?.name || dataProperty(component, '__classname__') || 'Component';
    return String(name).replace(/^cc\./, '').slice(0, 120);
  };
  const components = (node: any): any[] => {
    const value = node?.components;
    return Array.isArray(value) ? value.filter(Boolean) : [];
  };
  const children = (node: any): any[] => {
    const value = node?.children;
    return Array.isArray(value) ? value.filter(Boolean) : [];
  };
  const summary = (node: any) => ({
    uuid: String(node?.uuid ?? ''),
    name: String(node?.name ?? '').slice(0, 500),
    active: node?.active !== false,
    activeInHierarchy: node?.activeInHierarchy !== false,
    componentTypes: components(node).slice(0, 100).map(componentName),
  });
  const walk = (visit: (node: any, path: string, depth: number) => boolean | void, limit = 5_000): { truncated: boolean } => {
    const stack = [{ node: scene, path: `/${String(scene.name ?? '')}`, depth: 0 }];
    const seen = new Set<any>();
    let count = 0;
    let truncated = false;
    while (stack.length && count < limit) {
      const current = stack.pop()!;
      if (!current.node || seen.has(current.node)) continue;
      seen.add(current.node);
      count++;
      if (visit(current.node, current.path, current.depth) === false) return { truncated: false };
      const next = children(current.node);
      const start = Math.max(0, next.length - (limit - stack.length));
      if (start > 0) truncated = true;
      for (let index = next.length - 1; index >= start; index--) {
        const child = next[index];
        const childName = String(child?.name ?? '').slice(0, 500);
        const childPath = `${current.path}/${childName}`;
        stack.push({ node: child, path: childPath.length <= 10_000 ? childPath : `${childPath.slice(0, 9_999)}…`, depth: current.depth + 1 });
      }
    }
    return { truncated: truncated || stack.length > 0 };
  };
  const findByUuid = (uuid: string): any => {
    let match: any;
    const traversal = walk(node => {
      if (node?.uuid === uuid) {
        match = node;
        return false;
      }
    });
    if (!match) throw new Error(traversal.truncated ? 'Node not found within traversal limit' : 'Node not found');
    return match;
  };

  if (request.action === 'sceneTree') {
    const maxDepth = Math.min(Math.max(request.maxDepth ?? 6, 0), 20);
    const maxNodes = Math.min(Math.max(request.maxNodes ?? 500, 1), 5_000);
    let count = 0;
    let truncated = false;
    const build = (node: any, depth: number, seen: Set<any>): any => {
      if (count >= maxNodes) {
        truncated = true;
        return undefined;
      }
      count++;
      const item: any = summary(node);
      if (depth >= maxDepth) {
        if (children(node).length) truncated = true;
        return item;
      }
      if (seen.has(node)) return { ...item, circular: true };
      seen.add(node);
      item.children = [];
      for (const child of children(node)) {
        if (count >= maxNodes) {
          truncated = true;
          break;
        }
        const built = build(child, depth + 1, seen);
        if (built) item.children.push(built);
      }
      seen.delete(node);
      return item;
    };
    return { version, scene: build(scene, 0, new Set()), nodeCount: count, truncated };
  }

  if (request.action === 'findNode') {
    if (![request.uuid, request.name, request.path].filter(Boolean).length) throw new Error('uuid, name, or path is required');
    const limit = Math.min(Math.max(request.limit ?? 20, 1), 100);
    const matches: unknown[] = [];
    let more = false;
    const traversal = walk((node, path) => {
      const matched = request.uuid ? node?.uuid === request.uuid
        : request.path ? path === request.path
          : node?.name === request.name;
      if (matched) {
        if (matches.length < limit) matches.push({ ...summary(node), path });
        else {
          more = true;
          return false;
        }
      }
    });
    return { version, matches, ambiguous: matches.length > 1 || more, truncated: more || traversal.truncated };
  }

  if (request.action === 'getComponents') {
    const node = findByUuid(request.uuid);
    return {
      version,
      node: summary(node),
      components: components(node).slice(0, 200).map(component => ({
        type: componentName(component),
        uuid: String(component.uuid ?? ''),
        enabled: component.enabled !== false,
      })),
      truncated: components(node).length > 200,
    };
  }

  if (request.action === 'getProperties') {
    const node = findByUuid(request.uuid);
    const selected = request.componentType
      ? components(node).find(component => componentName(component) === request.componentType)
      : node;
    if (!selected) throw new Error('Component not found');
    const maxDepth = Math.min(Math.max(request.maxDepth ?? 3, 0), 6);
    let propertyCount = 0;
    let truncated = false;
    const seen = new WeakSet<object>();
    const serialize = (value: any, depth: number, reference = true): any => {
      if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
      if (typeof value === 'string') {
        if (value.length > 2_000) truncated = true;
        return value.slice(0, 2_000);
      }
      if (typeof value !== 'object') return undefined;
      const uuid = dataProperty(value, 'uuid');
      if (reference && uuid && Array.isArray(dataProperty(value, 'children'))) {
        return { $type: 'Node', uuid: String(uuid), name: String(dataProperty(value, 'name') ?? '').slice(0, 500) };
      }
      if (reference && uuid && dataProperty(value, 'node')) return { $type: 'Component', uuid: String(uuid), type: componentName(value) };
      if (depth >= maxDepth) {
        truncated = true;
        return '[MaxDepth]';
      }
      if (seen.has(value)) {
        truncated = true;
        return '[Circular]';
      }
      seen.add(value);
      const output: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : {};
      let inspected = 0;
      for (const key in value) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        inspected++;
        if (inspected > 1_000) {
          truncated = true;
          break;
        }
        if (propertyCount >= 1_000) {
          truncated = true;
          break;
        }
        propertyCount++;
        if (key.startsWith('_') || isSensitiveKey(key)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !('value' in descriptor)) continue;
        const item = serialize(descriptor.value, depth + 1);
        if (item !== undefined) {
          if (Array.isArray(output)) {
            const index = Number(key);
            if (Number.isInteger(index) && index >= 0 && index < 1_000) output[index] = item;
            else truncated = true;
          } else output[key] = item;
        }
      }
      seen.delete(value);
      return output;
    };
    return { version, node: summary(node), componentType: request.componentType, properties: serialize(selected, 0, false), truncated, propertyCount };
  }

  const node = findByUuid(request.uuid);
  const document = root.document;
  if (!document?.body) throw new Error('Page document is unavailable');
  const transform = components(node).find(component => componentName(component) === 'UITransform');
  if (!transform?.contentSize || !transform?.anchorPoint) throw new Error('Node has no UITransform');
  const canvas = cc.game?.canvas ?? document.querySelector('#GameCanvas');
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Cocos canvas not found');
  const canvasRect = canvas.getBoundingClientRect();
  const visible = cc.view?.getVisibleSize?.() ?? { width: canvasRect.width, height: canvasRect.height };
  const position = node.worldPosition ?? node.getWorldPosition?.();
  if (!position) throw new Error('Node world position is unavailable');
  const scale = node.worldScale ?? node.scale ?? { x: 1, y: 1 };
  const localWidth = Number(transform.contentSize.width);
  const localHeight = Number(transform.contentSize.height);
  const anchorX = Number(transform.anchorPoint.x);
  const anchorY = Number(transform.anchorPoint.y);
  const left = -localWidth * anchorX;
  const bottom = -localHeight * anchorY;
  const points = typeof transform.convertToWorldSpaceAR === 'function' && cc.Vec3
    ? [[left, bottom], [left + localWidth, bottom], [left, bottom + localHeight], [left + localWidth, bottom + localHeight]]
      .map(([x, y]) => transform.convertToWorldSpaceAR(new cc.Vec3(x, y, 0)))
    : [{ x: Number(position.x) + left * Number(scale.x ?? 1), y: Number(position.y) + bottom * Number(scale.y ?? 1) },
      { x: Number(position.x) + (left + localWidth) * Number(scale.x ?? 1), y: Number(position.y) + (bottom + localHeight) * Number(scale.y ?? 1) }];
  const worldX = Math.min(...points.map(point => Number(point.x)));
  const worldY = Math.min(...points.map(point => Number(point.y)));
  const width = Math.max(...points.map(point => Number(point.x))) - worldX;
  const height = Math.max(...points.map(point => Number(point.y))) - worldY;
  const visibleOrigin = cc.view?.getVisibleOrigin?.() ?? { x: 0, y: 0 };
  const scaleX = canvasRect.width / Number(visible.width);
  const scaleY = canvasRect.height / Number(visible.height);
  const bounds = {
    x: canvasRect.left + (worldX - Number(visibleOrigin.x ?? 0)) * scaleX,
    y: canvasRect.top + (Number(visibleOrigin.y ?? 0) + Number(visible.height) - worldY - height) * scaleY,
    width: width * scaleX,
    height: height * scaleY,
  };
  let overlay = root.__cocosWebInspectorOverlay;
  if (!overlay?.isConnected) {
    overlay = document.createElement('div');
    root.__cocosWebInspectorOverlay = overlay;
    document.body.appendChild(overlay);
  }
  Object.assign(overlay.style, {
    position: 'fixed', pointerEvents: 'none', zIndex: '2147483647', boxSizing: 'border-box',
    border: '2px solid #27c2ff', background: 'rgba(39, 194, 255, 0.2)',
    left: `${bounds.x}px`, top: `${bounds.y}px`, width: `${bounds.width}px`, height: `${bounds.height}px`,
  });
  clearTimeout(root.__cocosWebInspectorHighlightTimer);
  root.__cocosWebInspectorHighlightTimer = setTimeout(() => {
    overlay?.remove();
    if (root.__cocosWebInspectorOverlay === overlay) root.__cocosWebInspectorOverlay = undefined;
  }, Math.min(Math.max(request.durationMs ?? 2_000, 100), 10_000));
  return { version, uuid: request.uuid, highlighted: true, bounds };
}
