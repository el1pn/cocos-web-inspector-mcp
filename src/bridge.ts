import type { CDPSession, Page } from 'playwright-core';

export type BridgeRequest =
  | { action: 'sceneTree'; maxDepth?: number | undefined; maxNodes?: number | undefined }
  | { action: 'findNode'; uuid?: string | undefined; name?: string | undefined; path?: string | undefined; nameContains?: string | undefined; componentType?: string | undefined; active?: boolean | undefined; pathPrefix?: string | undefined; limit?: number | undefined }
  | { action: 'getNode'; uuid: string }
  | { action: 'getNodeBounds'; uuid: string }
  | { action: 'snapshotSubtree'; uuid: string; maxDepth?: number | undefined; maxNodes?: number | undefined }
  | { action: 'getComponents'; uuid: string }
  | { action: 'getProperties'; uuid: string; componentType?: string | undefined; componentUuid?: string | undefined; maxDepth?: number | undefined }
  | { action: 'highlightNode'; uuid: string; durationMs?: number | undefined }
  | { action: 'runtimeInfo' }
  | { action: 'runtimeDiagnostics' }
  | { action: 'setNodeActive'; uuid: string; active: boolean }
  | { action: 'setTransform'; uuid: string; position?: Vector3 | undefined; rotation?: Quaternion | undefined; scale?: Vector3 | undefined }
  | { action: 'setProperty'; uuid: string; componentUuid: string; key: string; value: PropertyValue }
  | { action: 'pause' }
  | { action: 'resume' }
  | { action: 'stepFrame'; frames?: number | undefined }
  | { action: 'showStats'; visible: boolean }
  | { action: 'selection'; disable?: boolean | undefined }
  | { action: 'pickAt'; x: number; y: number };

type Vector3 = { x: number; y: number; z: number };
type Quaternion = { x: number; y: number; z: number; w: number };
type PropertyValue = boolean | number | string | { x: number; y: number; z?: number | undefined; w?: number | undefined } | { width: number; height: number } | { r: number; g: number; b: number; a?: number | undefined };

const MAX_BYTES = 200_000;

export async function runBridge(page: Page, request: BridgeRequest): Promise<unknown> {
  const result = await page.evaluate(inspectCocos, request);
  const text = JSON.stringify(result);
  const encoded = JSON.stringify({ content: [{ type: 'text', text }], structuredContent: result });
  if (Buffer.byteLength(encoded, 'utf8') > MAX_BYTES - 4_096) {
    return { truncated: true, truncationReasons: ['RESPONSE_LIMIT'] };
  }
  return result;
}

export async function captureNode(page: Page, uuid: string): Promise<unknown> {
  const result = await page.evaluate(inspectCocos, { action: 'getNodeBounds', uuid } satisfies BridgeRequest) as any;
  if (!result.available || !result.visible) return { captured: false, reason: result.reason ?? 'OUTSIDE_VIEWPORT' };
  const clip = result.clippedViewport;
  if (!clip || !Number.isFinite(clip.x) || !Number.isFinite(clip.y) || !Number.isFinite(clip.width) || !Number.isFinite(clip.height) || clip.width <= 0 || clip.height <= 0) return { captured: false, reason: 'INVALID_GEOMETRY' };
  const fits = (data: string) => Buffer.byteLength(JSON.stringify({ data }), 'utf8') <= MAX_BYTES - 4_096;
  const size = { width: Math.round(clip.width), height: Math.round(clip.height) };
  // Device-pixel PNG, then CSS-pixel JPEG quality steps.
  const attempts: Array<{ type: 'png' | 'jpeg'; quality?: number; scale: 'device' | 'css' }> = [{ type: 'png', scale: 'device' }, ...[80, 60, 40].map(quality => ({ type: 'jpeg' as const, quality, scale: 'css' as const }))];
  for (const options of attempts) {
    const data = (await page.screenshot({ ...options, clip })).toString('base64');
    if (fits(data)) return { captured: true, mimeType: `image/${options.type}`, data, ...size };
  }
  // Playwright has no output scale, so downscale through CDP; its clip is document-relative.
  const session = await page.context().newCDPSession(page);
  try {
    const [scrollX, scrollY] = await page.evaluate(() => [window.scrollX, window.scrollY]);
    for (const scale of [0.75, 0.5, 0.35, 0.25]) {
      const { data } = await session.send('Page.captureScreenshot', { format: 'jpeg', quality: 60, clip: { x: clip.x + scrollX, y: clip.y + scrollY, width: clip.width, height: clip.height, scale } });
      if (fits(data)) return { captured: true, mimeType: 'image/jpeg', data, ...size, scale };
    }
  } finally {
    await session.detach().catch(() => {});
  }
  return { captured: false, reason: 'RESPONSE_LIMIT' };
}

export async function clickNode(page: Page, uuid: string): Promise<unknown> {
  const result = await page.evaluate(inspectCocos, { action: 'getNodeBounds', uuid } satisfies BridgeRequest) as any;
  if (!result.available || !result.visible) return { clicked: false, reason: result.reason ?? 'OUTSIDE_VIEWPORT' };
  const clip = result.clippedViewport;
  const point = { x: clip.x + clip.width / 2, y: clip.y + clip.height / 2 };
  await page.mouse.click(point.x, point.y);
  return { clicked: true, target: { nodeUuid: uuid }, point, runtimeOnly: true };
}

const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const IPAD_UA = 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const androidUa = (model: string) => `Mozilla/5.0 (Linux; Android 14; ${model}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36`;
export const devicePresets = {
  'iphone-se': { width: 375, height: 667, deviceScaleFactor: 2, mobile: true, userAgent: IOS_UA, platform: 'iPhone' },
  'iphone-14': { width: 390, height: 844, deviceScaleFactor: 3, mobile: true, userAgent: IOS_UA, platform: 'iPhone' },
  'iphone-14-pro-max': { width: 430, height: 932, deviceScaleFactor: 3, mobile: true, userAgent: IOS_UA, platform: 'iPhone' },
  'pixel-7': { width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true, userAgent: androidUa('Pixel 7'), platform: 'Linux armv81' },
  'galaxy-s20': { width: 360, height: 800, deviceScaleFactor: 3, mobile: true, userAgent: androidUa('SM-G981B'), platform: 'Linux armv81' },
  'ipad-mini': { width: 768, height: 1024, deviceScaleFactor: 2, mobile: true, userAgent: IPAD_UA, platform: 'iPad' },
} as const;
export type DevicePreset = keyof typeof devicePresets;
export const devicePresetNames = Object.keys(devicePresets) as [DevicePreset, ...DevicePreset[]];
// Chrome DevTools throttling presets, in bytes per second and milliseconds.
const networkProfiles = {
  online: { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
  offline: { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
  'slow-3g': { offline: false, latency: 2_000, downloadThroughput: 50_000, uploadThroughput: 50_000 },
  'fast-3g': { offline: false, latency: 562.5, downloadThroughput: 180_000, uploadThroughput: 84_375 },
  'fast-4g': { offline: false, latency: 165, downloadThroughput: 1_012_500, uploadThroughput: 168_750 },
} as const;
export type NetworkProfile = keyof typeof networkProfiles;
export const networkProfileNames = Object.keys(networkProfiles) as [NetworkProfile, ...NetworkProfile[]];

export type EmulationRequest = {
  reset?: boolean | undefined;
  preset?: DevicePreset | undefined;
  width?: number | undefined;
  height?: number | undefined;
  deviceScaleFactor?: number | undefined;
  mobile?: boolean | undefined;
  orientation?: 'portrait' | 'landscape' | undefined;
  cpuSlowdown?: number | undefined;
  network?: NetworkProfile | undefined;
  reload?: boolean | undefined;
};
type EmulationState = {
  device?: { preset?: DevicePreset; width: number; height: number; deviceScaleFactor: number; mobile: boolean; orientation: 'portrait' | 'landscape'; userAgent?: string; platform?: string };
  cpuSlowdown?: number;
  network?: NetworkProfile;
};
// Chrome drops every override when the owning CDP session detaches, so the session lives as long as the emulation.
const emulations = new WeakMap<Page, { session: CDPSession; state: EmulationState }>();

export async function emulateDevice(page: Page, request: EmulationRequest): Promise<unknown> {
  const current = emulations.get(page);
  const before = current?.state ?? {};
  let after: EmulationState = {};
  if (request.reset) {
    emulations.delete(page);
    if (current) {
      await applyEmulation(current.session, {});
      await current.session.detach().catch(() => {});
    }
  } else {
    after = { ...before };
    const base = request.preset ? { preset: request.preset, ...devicePresets[request.preset] }
      : request.width !== undefined && request.height !== undefined ? { width: request.width, height: request.height, deviceScaleFactor: request.deviceScaleFactor ?? 1, mobile: request.mobile ?? false }
        : before.device;
    if (request.orientation && !base) throw new Error('Invalid mutation: orientation needs a preset or width and height');
    if (base) after.device = { ...base, orientation: request.orientation ?? (base === before.device ? before.device.orientation : 'portrait') };
    if (request.cpuSlowdown !== undefined) after.cpuSlowdown = request.cpuSlowdown;
    if (request.network) after.network = request.network;
    const session = current?.session ?? await page.context().newCDPSession(page);
    emulations.set(page, { session, state: after });
    await applyEmulation(session, after);
  }
  if (request.reload) await page.reload();
  const report = (state: EmulationState) => {
    if (!state.device) return state;
    const { userAgent: _userAgent, platform: _platform, ...device } = state.device;
    const landscape = device.orientation === 'landscape';
    return { ...state, device: { ...device, width: landscape ? device.height : device.width, height: landscape ? device.width : device.height } };
  };
  return { changed: JSON.stringify(before) !== JSON.stringify(after), target: {}, before: report(before), after: report(after), reloaded: !!request.reload, runtimeOnly: true };
}

async function applyEmulation(session: CDPSession, state: EmulationState): Promise<void> {
  const device = state.device;
  if (device) {
    const landscape = device.orientation === 'landscape';
    await session.send('Emulation.setDeviceMetricsOverride', {
      width: landscape ? device.height : device.width,
      height: landscape ? device.width : device.height,
      deviceScaleFactor: device.deviceScaleFactor,
      mobile: device.mobile,
      screenOrientation: { type: landscape ? 'landscapePrimary' : 'portraitPrimary', angle: landscape ? 90 : 0 },
    });
  } else await session.send('Emulation.clearDeviceMetricsOverride');
  const touch = !!device?.mobile;
  await session.send('Emulation.setTouchEmulationEnabled', touch ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
  // Like the Chrome device toolbar: mouse input arrives as touch, which mobile Cocos builds listen for.
  await session.send('Emulation.setEmitTouchEventsForMouse', { enabled: touch, configuration: 'mobile' });
  // Engines such as Cocos read navigator.platform too: a touch-enabled MacIntel counts as iPad, whatever the user agent says.
  await session.send('Emulation.setUserAgentOverride', device?.userAgent
    ? { userAgent: device.userAgent, platform: device.platform ?? '' }
    : { userAgent: (await session.send('Browser.getVersion')).userAgent });
  await session.send('Emulation.setCPUThrottlingRate', { rate: state.cpuSlowdown ?? 1 });
  await session.send('Network.emulateNetworkConditions', networkProfiles[state.network ?? 'online']);
}

export function inspectCocosPage(): unknown {
  const root = globalThis as typeof globalThis & { cc?: Record<string, any>; CC?: Record<string, any>; document?: Document };
  const cc = root.cc ?? root.CC;
  const version = String(cc?.ENGINE_VERSION ?? cc?.version ?? '');
  const scene = cc?.director?.getScene?.();
  return {
    title: String(root.document?.title ?? '').slice(0, 500),
    cocos: {
      detected: version.startsWith('3.'),
      version: version.startsWith('3.') ? version : undefined,
      sceneName: version.startsWith('3.') && scene ? String(scene.name ?? '').slice(0, 500) : undefined,
    },
  };
}

export function inspectCocos(request: BridgeRequest): unknown {
  const root = globalThis as typeof globalThis & {
    cc?: Record<string, any>;
    CC?: Record<string, any>;
    document?: Document;
    __cocosWebInspectorHighlightTimer?: ReturnType<typeof setTimeout>;
    __cocosWebInspectorOverlay?: HTMLElement | undefined;
    __cocosWebInspectorPicker?: ((event: Event) => void) | undefined;
    __cocosWebInspectorSelection?: unknown;
    __cocosWebInspectorSelectionOverlay?: HTMLElement | undefined;
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
  const nodeBounds = (node: any): any => {
    const document = root.document;
    const transform = components(node).find(component => componentName(component) === 'UITransform');
    if (!transform?.contentSize || !transform?.anchorPoint) return { available: false, reason: 'NO_UI_TRANSFORM' };
    const canvas = cc.game?.canvas ?? document?.querySelector('#GameCanvas');
    if (typeof HTMLCanvasElement === 'undefined' || !(canvas instanceof HTMLCanvasElement)) return { available: false, reason: 'NO_CANVAS' };
    const canvasRect = canvas.getBoundingClientRect();
    const visible = cc.view?.getVisibleSize?.() ?? { width: canvasRect.width, height: canvasRect.height };
    const position = node.worldPosition ?? node.getWorldPosition?.();
    const values = [canvasRect.left, canvasRect.top, canvasRect.width, canvasRect.height, visible.width, visible.height, position?.x, position?.y, transform.contentSize.width, transform.contentSize.height, transform.anchorPoint.x, transform.anchorPoint.y];
    if (!position) return { available: false, reason: 'NO_WORLD_POSITION' };
    if (!values.every(Number.isFinite) || visible.width <= 0 || visible.height <= 0 || canvasRect.width <= 0 || canvasRect.height <= 0) return { available: false, reason: 'INVALID_GEOMETRY' };
    const left = -Number(transform.contentSize.width) * Number(transform.anchorPoint.x);
    const bottom = -Number(transform.contentSize.height) * Number(transform.anchorPoint.y);
    const scale = node.worldScale ?? node.scale ?? { x: 1, y: 1 };
    const points = typeof transform.convertToWorldSpaceAR === 'function' && cc.Vec3
      ? [[left, bottom], [left + Number(transform.contentSize.width), bottom], [left, bottom + Number(transform.contentSize.height)], [left + Number(transform.contentSize.width), bottom + Number(transform.contentSize.height)]].map(([x, y]) => transform.convertToWorldSpaceAR(new cc.Vec3(x, y, 0)))
      : [{ x: Number(position.x) + left * Number(scale.x ?? 1), y: Number(position.y) + bottom * Number(scale.y ?? 1) }, { x: Number(position.x) + (left + Number(transform.contentSize.width)) * Number(scale.x ?? 1), y: Number(position.y) + (bottom + Number(transform.contentSize.height)) * Number(scale.y ?? 1) }];
    if (!points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y))) return { available: false, reason: 'INVALID_GEOMETRY' };
    const worldX = Math.min(...points.map(point => Number(point.x)));
    const worldY = Math.min(...points.map(point => Number(point.y)));
    const worldWidth = Math.max(...points.map(point => Number(point.x))) - worldX;
    const worldHeight = Math.max(...points.map(point => Number(point.y))) - worldY;
    // Project through the owning Canvas camera; the visible-area mapping is wrong once the camera no longer centers on it.
    let camera: any;
    for (let current = node, depth = 0; current && !camera && depth < 100; current = current.parent, depth++) {
      camera = components(current).find(component => componentName(component) === 'Canvas')?.cameraComponent;
    }
    const screen = typeof camera?.worldToScreen === 'function' && cc.Vec3 && canvas.width > 0 && canvas.height > 0
      ? points.map(point => camera.worldToScreen(new cc.Vec3(Number(point.x), Number(point.y), 0), new cc.Vec3()))
      : undefined;
    const origin = cc.view?.getVisibleOrigin?.() ?? { x: 0, y: 0 };
    const viewport = screen?.every(point => Number.isFinite(point.x) && Number.isFinite(point.y))
      ? (() => {
        const xs = screen.map(point => Number(point.x));
        const ys = screen.map(point => Number(point.y));
        const sx = canvasRect.width / canvas.width;
        const sy = canvasRect.height / canvas.height;
        return { x: canvasRect.left + Math.min(...xs) * sx, y: canvasRect.top + (canvas.height - Math.max(...ys)) * sy, width: (Math.max(...xs) - Math.min(...xs)) * sx, height: (Math.max(...ys) - Math.min(...ys)) * sy };
      })()
      : { x: canvasRect.left + (worldX - Number(origin.x ?? 0)) * canvasRect.width / Number(visible.width), y: canvasRect.top + (Number(origin.y ?? 0) + Number(visible.height) - worldY - worldHeight) * canvasRect.height / Number(visible.height), width: worldWidth * canvasRect.width / Number(visible.width), height: worldHeight * canvasRect.height / Number(visible.height) };
    if (!Object.values(viewport).every(Number.isFinite) || viewport.width <= 0 || viewport.height <= 0) return { available: false, reason: 'INVALID_GEOMETRY' };
    const clipped = { x: Math.max(0, viewport.x), y: Math.max(0, viewport.y), width: Math.max(0, Math.min(innerWidth, viewport.x + viewport.width) - Math.max(0, viewport.x)), height: Math.max(0, Math.min(innerHeight, viewport.y + viewport.height) - Math.max(0, viewport.y)) };
    const inactive = node.activeInHierarchy === false;
    return { available: true, canvas: { x: worldX, y: worldY, width: worldWidth, height: worldHeight }, viewport, clippedViewport: clipped, anchor: { x: Number(transform.anchorPoint.x), y: Number(transform.anchorPoint.y) }, worldPosition: { x: Number(position.x), y: Number(position.y), z: Number(position.z ?? 0) }, visible: !inactive && clipped.width > 0 && clipped.height > 0, outsideViewport: clipped.width === 0 || clipped.height === 0, ...(inactive ? { reason: 'INACTIVE' } : {}) };
  };

  if (request.action === 'runtimeInfo') {
    const canvas = cc.game?.canvas ?? root.document?.querySelector('#GameCanvas');
    const canvasSize = typeof HTMLCanvasElement !== 'undefined' && canvas instanceof HTMLCanvasElement ? { width: canvas.width, height: canvas.height } : undefined;
    const visibleSize = cc.view?.getVisibleSize?.();
    const visibleOrigin = cc.view?.getVisibleOrigin?.();
    let nodeCount = 0;
    const traversal = walk(() => { nodeCount++; });
    const paused = typeof cc.director?.isPaused === 'function' ? Boolean(cc.director.isPaused()) : undefined;
    return {
      version,
      scene: { name: String(scene.name ?? '').slice(0, 500), uuid: String(scene.uuid ?? '') },
      canvasSize,
      visibleSize: visibleSize ? { width: Number(visibleSize.width), height: Number(visibleSize.height) } : undefined,
      visibleOrigin: visibleOrigin ? { x: Number(visibleOrigin.x), y: Number(visibleOrigin.y) } : undefined,
      director: paused === undefined ? undefined : { paused, running: !paused },
      nodeCount,
      truncated: traversal.truncated,
    };
  }

  if (request.action === 'runtimeDiagnostics') {
    let nodeCount = 0;
    let componentCount = 0;
    let maxDepth = 0;
    const names = new Map<string, string[]>();
    const traversal = walk((node, _path, depth) => {
      nodeCount++;
      componentCount += components(node).length;
      maxDepth = Math.max(maxDepth, depth);
      const name = String(node?.name ?? '').slice(0, 500);
      if (name) {
        const uuids = names.get(name) ?? [];
        if (uuids.length < 100) uuids.push(String(node?.uuid ?? ''));
        names.set(name, uuids);
      }
    });
    const duplicateNames = [...names.entries()].filter(([, uuids]) => uuids.length > 1).slice(0, 100).map(([name, uuids]) => ({ name, uuids, count: uuids.length }));
    // Root and the GFX device update these every frame whether or not the profiler is shown; read backing fields, never getters.
    const renderRoot = cc.director && typeof cc.director === 'object' ? dataProperty(cc.director, '_root') : undefined;
    const device = renderRoot && typeof renderRoot === 'object' ? dataProperty(renderRoot, '_device') : undefined;
    const metric = (owner: unknown, key: string) => {
      const value = owner && typeof owner === 'object' ? dataProperty(owner, key) : undefined;
      return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    };
    const render = { fps: metric(renderRoot, '_fps'), frameTimeMs: metric(renderRoot, '_frameTime'), drawCalls: metric(device, '_numDrawCalls'), triangles: metric(device, '_numTris'), instances: metric(device, '_numInstances') };
    if (render.frameTimeMs !== undefined) render.frameTimeMs *= 1_000;
    const unavailableMetrics: Record<string, string> = { invalidComponentReferences: 'UNSUPPORTED_PUBLIC_API' };
    for (const [key, value] of Object.entries(render)) if (value === undefined) unavailableMetrics[key] = 'UNSUPPORTED_PUBLIC_API';
    return {
      version,
      nodeCount,
      componentCount,
      maxHierarchyDepth: maxDepth,
      duplicateNames,
      render: Object.fromEntries(Object.entries(render).filter(([, value]) => value !== undefined)),
      unavailableMetrics,
      truncated: traversal.truncated || duplicateNames.length >= 100,
      truncationReasons: traversal.truncated || duplicateNames.length >= 100 ? ['NODE_LIMIT'] : [],
    };
  }

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
    if (![request.uuid, request.name, request.path, request.nameContains, request.componentType, request.active, request.pathPrefix].some(value => value !== undefined)) throw new Error('At least one node filter is required');
    const limit = Math.min(Math.max(request.limit ?? 20, 1), 100);
    const matches: unknown[] = [];
    let more = false;
    const traversal = walk((node, path) => {
      const matched = (request.uuid === undefined || node?.uuid === request.uuid)
        && (request.name === undefined || node?.name === request.name)
        && (request.path === undefined || path === request.path)
        && (request.nameContains === undefined || String(node?.name ?? '').includes(request.nameContains))
        && (request.componentType === undefined || components(node).some(component => componentName(component) === request.componentType))
        && (request.active === undefined || (node?.active !== false) === request.active)
        && (request.pathPrefix === undefined || path.startsWith(request.pathPrefix));
      if (matched) {
        if (matches.length < limit) matches.push({ ...summary(node), path });
        else {
          more = true;
          return false;
        }
      }
    });
    return { version, matches, ambiguous: matches.length > 1 || more, truncated: more || traversal.truncated, truncationReasons: more || traversal.truncated ? ['NODE_LIMIT'] : [] };
  }

  if (request.action === 'getNode') {
    const node = findByUuid(request.uuid);
    let parent: any;
    let path = '';
    walk((candidate, candidatePath) => {
      if (children(candidate).includes(node)) parent = candidate;
      if (candidate === node) path = candidatePath;
    });
    const directChildren = children(node);
    const nodeComponents = components(node);
    return {
      version,
      node: { ...summary(node), path },
      parent: parent ? summary(parent) : undefined,
      children: directChildren.slice(0, 200).map(summary),
      components: nodeComponents.slice(0, 200).map(component => ({ type: componentName(component), uuid: String(component.uuid ?? ''), enabled: component.enabled !== false })),
      truncated: directChildren.length > 200 || nodeComponents.length > 200,
      truncationReasons: directChildren.length > 200 || nodeComponents.length > 200 ? ['NODE_LIMIT'] : [],
    };
  }

  if (request.action === 'pickAt') {
    // Cocos draws 2D nodes in pre-order, so the last hit in traversal order is the topmost one.
    const hits: Array<{ node: any; path: string; viewport: any }> = [];
    // Full-screen blockers often sit on top at opacity 0; read the backing field, never the computing getter.
    const transparent = (node: any): boolean => {
      for (let current = node, depth = 0; current && depth < 100; current = current.parent, depth++) {
        const local = dataProperty(dataProperty(current, '_uiProps') ?? {}, '_localOpacity');
        if (typeof local === 'number' && local <= 0) return true;
      }
      return false;
    };
    // Full-screen layout containers draw nothing; only nodes that render or take input can be what the user pointed at.
    const Renderable = cc.internal?.Renderable2D;
    const pickable = (node: any): boolean => components(node).some(component => typeof Renderable === 'function' && component instanceof Renderable
      || /^(Sprite|Label|RichText|Graphics|Button|Toggle|EditBox|Slider)$/.test(componentName(component)));
    walk((node, path) => {
      if (node === scene || node.activeInHierarchy === false || !pickable(node) || transparent(node)) return;
      const bounds = nodeBounds(node);
      const box = bounds.available ? bounds.viewport : undefined;
      if (box && request.x >= box.x && request.x <= box.x + box.width && request.y >= box.y && request.y <= box.y + box.height) hits.push({ node, path, viewport: box });
    });
    const overlay = root.__cocosWebInspectorSelectionOverlay;
    const top = hits.at(-1);
    if (!top) {
      overlay?.remove();
      return { version, point: { x: request.x, y: request.y }, node: null };
    }
    const selection = {
      point: { x: request.x, y: request.y },
      node: { ...summary(top.node), path: top.path },
      viewport: top.viewport,
      // Parents and siblings under the point, topmost first, for when the pick lands on a child.
      stack: hits.slice(-10).reverse().map(hit => ({ uuid: String(hit.node.uuid ?? ''), name: String(hit.node.name ?? '').slice(0, 500), path: hit.path })),
    };
    const document = root.document;
    if (document?.body) {
      let box = overlay;
      if (!box?.isConnected) {
        box = document.createElement('div');
        box.appendChild(document.createElement('span'));
        root.__cocosWebInspectorSelectionOverlay = box;
        document.body.appendChild(box);
      }
      Object.assign(box.style, {
        position: 'fixed', pointerEvents: 'none', zIndex: '2147483647', boxSizing: 'border-box',
        border: '2px solid #ff9f1a', background: 'rgba(255, 159, 26, 0.15)',
        left: `${top.viewport.x}px`, top: `${top.viewport.y}px`, width: `${top.viewport.width}px`, height: `${top.viewport.height}px`,
      });
      const label = box.firstElementChild as HTMLElement;
      Object.assign(label.style, {
        position: 'absolute', left: '0', bottom: '100%', maxWidth: '480px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        font: '12px/1.4 monospace', color: '#1a1a1a', background: '#ff9f1a', padding: '1px 4px',
      });
      label.textContent = `${selection.node.name} · ${selection.node.path.slice(0, 200)} · ${selection.node.uuid.slice(0, 8)}`;
    }
    return selection;
  }

  if (request.action === 'selection') {
    const events = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'touchstart', 'touchend'];
    const installed = root.__cocosWebInspectorPicker;
    if (request.disable) {
      if (installed) for (const type of events) root.removeEventListener?.(type, installed, true);
      root.__cocosWebInspectorPicker = undefined;
      root.__cocosWebInspectorSelection = undefined;
      root.__cocosWebInspectorSelectionOverlay?.remove();
      root.__cocosWebInspectorSelectionOverlay = undefined;
      return { version, picker: false, selection: null };
    }
    if (!installed && typeof root.addEventListener === 'function') {
      const picker = (event: Event) => {
        const pointer = event as MouseEvent;
        const canvas = cc.game?.canvas ?? root.document?.querySelector('#GameCanvas');
        if (!pointer.altKey || event.target !== canvas) return;
        // Alt+click selects; the game must not also receive it as a tap.
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.type !== 'pointerdown') return;
        try {
          // The named function expression is in scope inside the page, so the picker reruns the bridge with a fresh scene.
          root.__cocosWebInspectorSelection = inspectCocos({ action: 'pickAt', x: pointer.clientX, y: pointer.clientY });
        } catch (error) {
          root.__cocosWebInspectorSelection = { error: String(error instanceof Error ? error.message : error).slice(0, 500) };
        }
      };
      for (const type of events) root.addEventListener(type, picker, true);
      root.__cocosWebInspectorPicker = picker;
    }
    const selection = root.__cocosWebInspectorSelection as { node?: { uuid?: string } | null } | undefined;
    let stale = false;
    if (selection?.node?.uuid) {
      try { findByUuid(selection.node.uuid); } catch { stale = true; }
    }
    return {
      version,
      picker: true,
      selection: selection ?? null,
      ...(stale ? { stale: true } : {}),
      ...(selection ? {} : { hint: 'Alt+click a node on the game canvas, then call again' }),
    };
  }

  if (request.action === 'snapshotSubtree') {
    const rootNode = findByUuid(request.uuid);
    const maxDepth = Math.min(Math.max(request.maxDepth ?? 6, 0), 20);
    const maxNodes = Math.min(Math.max(request.maxNodes ?? 500, 1), 5_000);
    let count = 0;
    // ponytail: the MCP response carries text and structuredContent, so ~70 KB of JSON (escaped text + structured copy) fits runBridge's ceiling; stop early instead of dropping everything.
    let bytes = 0;
    const reasons = new Set<string>();
    const build = (node: any, depth: number): any => {
      if (count >= maxNodes) {
        reasons.add('NODE_LIMIT');
        return undefined;
      }
      const item: any = {
        ...summary(node),
        components: components(node).slice(0, 200).map(component => ({ type: componentName(component), uuid: String(component.uuid ?? ''), enabled: component.enabled !== false })),
      };
      bytes += JSON.stringify(item).length;
      if (bytes > 70_000) {
        reasons.add('RESPONSE_LIMIT');
        return undefined;
      }
      count++;
      if (components(node).length > 200) reasons.add('NODE_LIMIT');
      if (depth >= maxDepth) {
        if (children(node).length) reasons.add('MAX_DEPTH');
        return item;
      }
      item.children = children(node).map(child => build(child, depth + 1)).filter(Boolean);
      return item;
    };
    const snapshot = build(rootNode, 0);
    return { version, rootUuid: request.uuid, snapshot, nodeCount: count, truncated: reasons.size > 0, truncationReasons: [...reasons] };
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
    const matches = request.componentType ? components(node).filter(component => componentName(component) === request.componentType) : [];
    if (matches.length > 1) throw new Error('Ambiguous component type');
    const selected = request.componentUuid
      ? components(node).find(component => component?.uuid === request.componentUuid)
      : request.componentType ? matches[0] : node;
    if (!selected) throw new Error('Component not found');
    const maxDepth = Math.min(Math.max(request.maxDepth ?? 3, 0), 6);
    let propertyCount = 0;
    let skipped = 0;
    let redacted = 0;
    let returned = 0;
    const truncationReasons = new Set<string>();
    let truncated = false;
    const truncate = (reason: string) => { truncated = true; truncationReasons.add(reason); };
    const seen = new WeakSet<object>();
    const serialize = (value: any, depth: number, reference = true): any => {
      if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
      if (typeof value === 'string') {
        if (value.length > 2_000) truncate('STRING_LIMIT');
        return value.slice(0, 2_000);
      }
      if (typeof value !== 'object') return undefined;
      // Cocos 3.x exposes uuid/children/name as accessors; read their backing fields instead.
      const uuid = dataProperty(value, 'uuid') ?? dataProperty(value, '_id');
      // CCObject.isValid is a getter over this flag (Destroyed = 1 << 0 in 3.6-3.8); destroy also nulls _children/node.
      const flags = dataProperty(value, '_objFlags');
      if (reference && typeof flags === 'number' && flags & 1) return { $type: typeof cc.Node === 'function' && value instanceof cc.Node ? 'Node' : componentName(value), uuid: String(uuid ?? ''), destroyed: true };
      if (reference && uuid && Array.isArray(dataProperty(value, 'children') ?? dataProperty(value, '_children'))) {
        return { $type: 'Node', uuid: String(uuid), name: String(dataProperty(value, 'name') ?? dataProperty(value, '_name') ?? '').slice(0, 500) };
      }
      if (reference && uuid && dataProperty(value, 'node')) return { $type: 'Component', uuid: String(uuid), type: componentName(value) };
      if (reference && typeof cc.Asset === 'function' && value instanceof cc.Asset) {
        return { $type: componentName(value), name: String(dataProperty(value, '_name') ?? '').slice(0, 500), uuid: String(dataProperty(value, '_uuid') ?? '') };
      }
      if (depth > 0 && depth >= maxDepth) {
        truncate('MAX_DEPTH');
        return '[MaxDepth]';
      }
      if (seen.has(value)) {
        truncate('MAX_DEPTH');
        return '[Circular]';
      }
      seen.add(value);
      const output: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : {};
      let inspected = 0;
      for (const key in value) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        inspected++;
        if (inspected > 1_000) {
          truncate('PROPERTY_LIMIT');
          break;
        }
        if (propertyCount >= 1_000) {
          truncate('PROPERTY_LIMIT');
          break;
        }
        propertyCount++;
        if (key.startsWith('_') || isSensitiveKey(key)) {
          redacted++;
          continue;
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !('value' in descriptor)) {
          skipped++;
          continue;
        }
        const item = serialize(descriptor.value, depth + 1);
        if (item !== undefined) {
          if (Array.isArray(output)) {
            const index = Number(key);
            if (Number.isInteger(index) && index >= 0 && index < 1_000) {
              output[index] = item;
              returned++;
            } else truncate('PROPERTY_LIMIT');
          } else {
            output[key] = item;
            returned++;
          }
        }
      }
      seen.delete(value);
      return output;
    };
    // ponytail: fixed allowlist of display backing fields, read without getters; extend per component when smoke tests need more.
    const displayFields: Record<string, unknown> = {};
    const readDisplay = (type: string, key: string, backing: string) => {
      if (typeof cc[type] !== 'function' || !(selected instanceof cc[type])) return;
      const value = dataProperty(selected, backing);
      if (typeof value === 'string') {
        if (value.length > 2_000) truncate('STRING_LIMIT');
        displayFields[key] = value.slice(0, 2_000);
      } else if (value === null || typeof value === 'boolean' || typeof value === 'number') displayFields[key] = value;
    };
    readDisplay('Label', 'string', '_string');
    readDisplay('RichText', 'string', '_string');
    readDisplay('Button', 'interactable', '_interactable');
    readDisplay('Toggle', 'isChecked', '_isChecked');
    if (selected === node) {
      for (const key of ['name', 'active', 'activeInHierarchy']) {
        const value = dataProperty(node, key) ?? dataProperty(node, `_${key}`);
        if (typeof value === 'string' || typeof value === 'boolean') displayFields[key] = typeof value === 'string' ? value.slice(0, 500) : value;
      }
    }
    if (typeof cc.Sprite === 'function' && selected instanceof cc.Sprite) {
      const frame = dataProperty(selected, '_spriteFrame');
      displayFields.spriteFrame = frame && typeof frame === 'object'
        ? { $type: 'SpriteFrame', name: String(dataProperty(frame, '_name') ?? '').slice(0, 500), uuid: String(dataProperty(frame, '_uuid') ?? '') }
        : null;
    }
    const properties = serialize(selected, 0, false);
    Object.assign(properties, displayFields);
    returned += Object.keys(displayFields).length;
    return {
      version,
      node: summary(node),
      componentType: request.componentType ?? (selected === node ? undefined : componentName(selected)),
      componentUuid: selected === node ? undefined : String(selected.uuid ?? ''),
      properties,
      truncated,
      truncationReasons: [...truncationReasons],
      propertyCount,
      inspected: propertyCount,
      skipped,
      redacted,
      returned,
    };
  }

  const invalidMutation = (message: string): never => { throw new Error(`Invalid mutation: ${message}`); };
  const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1_000_000;
  const vector = (value: any, keys: string[]): Record<string, number> => {
    if (!value || typeof value !== 'object' || Object.keys(value).some(key => !keys.includes(key)) || !keys.every(key => finite(value[key]))) invalidMutation(`expected finite ${keys.join('/')}`);
    return Object.fromEntries(keys.map(key => [key, value[key]]));
  };
  const snapshot = (value: any, keys: string[]): Record<string, number> => Object.fromEntries(keys.map(key => [key, Number(value?.[key] ?? 0)]));
  const componentByUuid = (node: any, uuid: string): any => {
    const component = components(node).find(candidate => candidate?.uuid === uuid);
    if (!component) throw new Error('Component not found');
    return component;
  };
  const directorState = () => {
    if (typeof cc.director?.isPaused !== 'function') invalidMutation('director pause state is unavailable');
    const paused = Boolean(cc.director.isPaused());
    return { paused, running: !paused };
  };

  if (request.action === 'pause' || request.action === 'resume') {
    const before = directorState();
    const method = request.action === 'pause' ? 'pause' : 'resume';
    if (typeof cc.director?.[method] !== 'function') invalidMutation(`director.${method} is unavailable`);
    if (request.action === 'pause' ? !before.paused : before.paused) cc.director[method]();
    const after = directorState();
    return { changed: before.paused !== after.paused, target: {}, before, after, runtimeOnly: true };
  }

  if (request.action === 'stepFrame') {
    const game = cc.game;
    if (typeof game?.step !== 'function' || typeof game.isPaused !== 'function' || typeof cc.director?.getTotalFrames !== 'function') invalidMutation('game.step is unavailable');
    const directorPaused = directorState().paused;
    if (!directorPaused && !game.isPaused()) invalidMutation('pause the game before stepping');
    const before = cc.director.getTotalFrames();
    // game.step ticks the director, which skips logic while director-paused; unpause only inside this synchronous call.
    for (let frame = 0; frame < (request.frames ?? 1); frame++) {
      if (directorPaused) cc.director.resume();
      try { game.step(); } finally { if (directorPaused) cc.director.pause(); }
    }
    const after = cc.director.getTotalFrames();
    return { changed: after !== before, target: {}, before: { totalFrames: before }, after: { totalFrames: after }, runtimeOnly: true };
  }

  if (request.action === 'showStats') {
    const profiler = cc.profiler;
    if (typeof profiler?.isShowingStats !== 'function' || typeof profiler.showStats !== 'function' || typeof profiler.hideStats !== 'function') invalidMutation('profiler stats API is unavailable');
    const before = Boolean(profiler.isShowingStats());
    if (before !== request.visible) request.visible ? profiler.showStats() : profiler.hideStats();
    const after = Boolean(profiler.isShowingStats());
    return { changed: before !== after, target: {}, before: { visible: before }, after: { visible: after }, runtimeOnly: true };
  }

  if (request.action === 'setNodeActive') {
    const node = findByUuid(request.uuid);
    const before = node.active !== false;
    if (before !== request.active) node.active = request.active;
    const after = node.active !== false;
    return { changed: before !== after, target: { nodeUuid: request.uuid }, before: { active: before }, after: { active: after }, runtimeOnly: true };
  }

  if (request.action === 'setTransform') {
    if (!request.position && !request.rotation && !request.scale) invalidMutation('provide position, rotation, or scale');
    const node = findByUuid(request.uuid);
    const before = {
      ...(request.position ? { position: snapshot(node.position, ['x', 'y', 'z']) } : {}),
      ...(request.rotation ? { rotation: snapshot(node.rotation, ['x', 'y', 'z', 'w']) } : {}),
      ...(request.scale ? { scale: snapshot(node.scale, ['x', 'y', 'z']) } : {}),
    };
    if (request.position) {
      const position = vector(request.position, ['x', 'y', 'z']);
      if (typeof node.setPosition !== 'function') invalidMutation('node.setPosition is unavailable');
      node.setPosition(position.x, position.y, position.z);
    }
    if (request.rotation) {
      const rotation = vector(request.rotation, ['x', 'y', 'z', 'w']);
      if (typeof node.setRotation !== 'function') invalidMutation('node.setRotation is unavailable');
      node.setRotation(rotation.x, rotation.y, rotation.z, rotation.w);
    }
    if (request.scale) {
      const scale = vector(request.scale, ['x', 'y', 'z']);
      if (typeof node.setScale !== 'function') invalidMutation('node.setScale is unavailable');
      node.setScale(scale.x, scale.y, scale.z);
    }
    const after = {
      ...(request.position ? { position: snapshot(node.position, ['x', 'y', 'z']) } : {}),
      ...(request.rotation ? { rotation: snapshot(node.rotation, ['x', 'y', 'z', 'w']) } : {}),
      ...(request.scale ? { scale: snapshot(node.scale, ['x', 'y', 'z']) } : {}),
    };
    return { changed: JSON.stringify(before) !== JSON.stringify(after), target: { nodeUuid: request.uuid }, before, after, runtimeOnly: true };
  }

  if (request.action === 'setProperty') {
    if (request.key.startsWith('_') || isSensitiveKey(request.key)) invalidMutation('property key is not writable');
    const node = findByUuid(request.uuid);
    const component = componentByUuid(node, request.componentUuid);
    let owner: any = component;
    let descriptor: PropertyDescriptor | undefined;
    for (let depth = 0; owner && depth < 20 && !descriptor; depth++, owner = Object.getPrototypeOf(owner)) descriptor = Object.getOwnPropertyDescriptor(owner, request.key);
    if (!descriptor || !('value' in descriptor)) invalidMutation('property is not a data property');
    const current = (descriptor as PropertyDescriptor & { value: any }).value;
    const keys = current && typeof current === 'object'
      ? 'width' in current && 'height' in current ? ['width', 'height'] : 'r' in current && 'g' in current && 'b' in current ? ['r', 'g', 'b', 'a'] : ['x', 'y', ...('z' in current ? ['z'] : []), ...('w' in current ? ['w'] : [])]
      : undefined;
    const safe = (value: any) => keys ? snapshot(value, keys) : value;
    const before = safe(current);
    if (typeof current === 'boolean' || typeof current === 'number' || typeof current === 'string') {
      if (typeof current !== typeof request.value || typeof request.value === 'number' && !finite(request.value) || typeof request.value === 'string' && request.value.length > 2_000) invalidMutation('property value shape does not match');
      component[request.key] = request.value;
    } else if (keys && request.value && typeof request.value === 'object' && !Array.isArray(request.value)) {
      Object.assign(current, vector(request.value, keys));
    } else invalidMutation('property value shape does not match');
    const after = safe(component[request.key]);
    return { changed: JSON.stringify(before) !== JSON.stringify(after), target: { nodeUuid: request.uuid, componentUuid: request.componentUuid }, before: { value: before }, after: { value: after }, runtimeOnly: true };
  }

  if (request.action === 'getNodeBounds') return { version, uuid: request.uuid, ...nodeBounds(findByUuid(request.uuid)) };
  if (request.action !== 'highlightNode') throw new Error('Unsupported bridge request');
  const bounds = nodeBounds(findByUuid(request.uuid));
  if (!bounds.available) return { version, uuid: request.uuid, highlighted: false, ...bounds };
  const document = root.document;
  if (!document?.body) return { version, uuid: request.uuid, highlighted: false, available: false, reason: 'NO_DOCUMENT' };
  let overlay = root.__cocosWebInspectorOverlay;
  if (!overlay?.isConnected) {
    overlay = document.createElement('div');
    root.__cocosWebInspectorOverlay = overlay;
    document.body.appendChild(overlay);
  }
  Object.assign(overlay.style, {
    position: 'fixed', pointerEvents: 'none', zIndex: '2147483647', boxSizing: 'border-box',
    border: '2px solid #27c2ff', background: 'rgba(39, 194, 255, 0.2)',
    left: `${bounds.viewport.x}px`, top: `${bounds.viewport.y}px`, width: `${bounds.viewport.width}px`, height: `${bounds.viewport.height}px`,
  });
  clearTimeout(root.__cocosWebInspectorHighlightTimer);
  root.__cocosWebInspectorHighlightTimer = setTimeout(() => {
    overlay?.remove();
    if (root.__cocosWebInspectorOverlay === overlay) root.__cocosWebInspectorOverlay = undefined;
  }, Math.min(Math.max(request.durationMs ?? 2_000, 100), 10_000));
  return { version, uuid: request.uuid, highlighted: true, ...bounds, bounds: bounds.viewport };
}
