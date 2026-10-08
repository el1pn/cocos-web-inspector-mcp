import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { crc32, deflateSync, gunzipSync } from 'node:zlib';
import type { Page } from 'playwright-core';
import { type Clip, fitsImage, fitsResponse, nodeCenter, runBridge, visibleClip } from './bridge.js';
import { InspectorError, validateLocalUrl } from './browser.js';
import { redactBody, redactHeaders, redactText, redactUrl, selectRequests } from './browser-data.js';

type Evaluate = (webSocketUrl: string, expression: string, timeout: number) => Promise<unknown>;

// Cocos native debug builds (V8) run a Node-style inspector: Runtime and Debugger domains only, no pages, one session at a time.
// ponytail: one WebSocket per call so Chrome DevTools can attach between calls; keep a socket open if per-call latency matters.
export class NativeConnection {
  readonly #http: URL;
  readonly #page: Page;

  constructor(endpoint: string, private readonly timeout = 60_000, private readonly evaluateExpression: Evaluate = evaluateOverWebSocket) {
    const url = validateLocalUrl(endpoint);
    url.protocol = url.protocol === 'wss:' || url.protocol === 'https:' ? 'https:' : 'http:';
    url.pathname = '/';
    this.#http = url;
    // Only the evaluate/url subset of Page that runBridge and cocos_list_pages use.
    this.#page = { url: () => this.#http.href, evaluate: (fn: (arg: unknown) => unknown, arg?: unknown) => this.#evaluate(fn, arg) } as unknown as Page;
  }

  async pages(): Promise<Page[]> {
    return [this.#page];
  }

  async page(_pageUrl?: string): Promise<Page> {
    return this.#page;
  }

  async close(): Promise<void> {}

  async #targets(): Promise<Array<{ webSocketDebuggerUrl?: string }>> {
    const response = await fetch(new URL('/json/list', this.#http), { signal: AbortSignal.timeout(10_000) });
    return await response.json() as Array<{ webSocketDebuggerUrl?: string }>;
  }

  async #evaluate(fn: (arg: unknown) => unknown, arg: unknown): Promise<unknown> {
    let targets: Array<{ webSocketDebuggerUrl?: string }>;
    try {
      targets = await this.#targets();
    } catch (error) {
      // An adb server restart or a USB drop takes the forward with it; restore it once, only to the device port this endpoint names.
      const restored = await forwardInspector(Number(this.#http.port)).catch(() => undefined);
      targets = restored === undefined ? [] : await this.#targets().catch(() => []);
      if (!targets.length) throw new InspectorError('CDP_UNAVAILABLE', `Unable to reach the native inspector at ${this.#http.host}: ${error instanceof Error ? error.message : 'unknown error'}; check that the debug build is running and adb sees the device (run doctor --native)`);
    }
    if (!Array.isArray(targets) || targets.length === 0) throw new InspectorError('NO_LOCAL_PAGE', 'Native inspector lists no target');
    const debuggerUrl = targets.find(target => target.webSocketDebuggerUrl)?.webSocketDebuggerUrl;
    if (!debuggerUrl) throw new InspectorError('CDP_UNAVAILABLE', 'Native inspector already has a session; close Chrome DevTools attached to the game');
    // Connect to the validated endpoint host, never to the host the target list names.
    const socketUrl = new URL(new URL(debuggerUrl).pathname, this.#http);
    socketUrl.protocol = this.#http.protocol === 'https:' ? 'wss:' : 'ws:';
    // Functions passed here are self-contained (inspectCocos, inspectCocosPage), so their source runs as is.
    return this.evaluateExpression(socketUrl.href, `(${fn.toString()})(${arg === undefined ? '' : JSON.stringify(arg)})`, this.timeout);
  }
}

async function evaluateOverWebSocket(webSocketUrl: string, expression: string, timeout: number): Promise<unknown> {
  const socket = new WebSocket(webSocketUrl);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new InspectorError('CDP_UNAVAILABLE', 'Native inspector did not answer in time')), timeout);
      socket.onerror = () => reject(new InspectorError('CDP_UNAVAILABLE', 'Native inspector connection failed'));
      socket.onclose = () => reject(new InspectorError('CDP_UNAVAILABLE', 'Native inspector closed the connection'));
      socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
      socket.onmessage = event => {
        const message = JSON.parse(String(event.data));
        if (message.id !== 1) return;
        if (message.error) return reject(new InspectorError('CDP_UNAVAILABLE', `Native inspector error: ${String(message.error.message).slice(0, 500)}`));
        const exception = message.result?.exceptionDetails;
        // Match Playwright's in-page error text, so the server maps bridge errors to the same codes.
        if (exception) return reject(new Error(String(exception.exception?.description ?? exception.text ?? 'Evaluation failed').split('\n')[0]!.replace(/^Error: /, '')));
        resolve(message.result?.result?.value);
      };
    });
  } finally {
    clearTimeout(timer);
    socket.close();
  }
}

// Real input and logs go through adb on the device the inspector is forwarded from. adb picks the device itself;
// with several attached, set ANDROID_SERIAL. Arguments are numbers or a validated package name, never free text.
const run = promisify(execFile);
async function adbBuffer(args: string[]): Promise<Buffer> {
  try {
    return (await run('adb', args, { encoding: 'buffer', timeout: 15_000, maxBuffer: 16 * 1024 * 1024 })).stdout;
  } catch (error) {
    const message = error instanceof Error ? error.message.split('\n')[0]! : 'unknown error';
    throw new InspectorError('CDP_UNAVAILABLE', `adb ${args[0]} failed: ${message.slice(0, 300)}; check adb devices, and set ANDROID_SERIAL when several are attached`);
  }
}
const adb = async (args: string[]) => (await adbBuffer(args)).toString();

// ponytail: viewport coordinates equal screen pixels only for a full-screen game (the Cocos default); add the window offset for windowed apps.
const pixel = (value: number) => String(Math.round(value));
const settle = () => new Promise(resolve => setTimeout(resolve, 300));

export async function nativeClick(page: Page, uuid: string): Promise<unknown> {
  const point = await nodeCenter(page, uuid);
  if ('reason' in point) return { clicked: false, reason: point.reason };
  await adb(['shell', 'input', 'tap', pixel(point.x), pixel(point.y)]);
  // adb returns once the event is injected; the game handles it on its next frames.
  await settle();
  return { clicked: true, target: { nodeUuid: uuid }, point, input: 'adb', runtimeOnly: true };
}

export async function nativeDrag(page: Page, uuid: string, dx: number, dy: number, durationMs = 300): Promise<unknown> {
  const from = await nodeCenter(page, uuid);
  if ('reason' in from) return { dragged: false, reason: from.reason };
  const to = { x: from.x + dx, y: from.y + dy };
  // input swipe interpolates its own moves, so steps does not apply.
  await adb(['shell', 'input', 'swipe', pixel(from.x), pixel(from.y), pixel(to.x), pixel(to.y), String(Math.max(durationMs, 1))]);
  await settle();
  return { dragged: true, target: { nodeUuid: uuid }, from, to, input: 'adb', runtimeOnly: true };
}

// Raw `screencap` output: width, height, and pixel format as uint32 LE, a colorspace word on Android 12+, then RGBA rows
// in the current display rotation. The device gzips it (18 MB raw takes ~20 s over Wi-Fi adb, ~1.5 s gzipped), and cropping
// raw pixels needs only zlib here, where decoding `screencap -p` would need a PNG decoder.
export async function nativeCaptureNode(page: Page, uuid: string): Promise<unknown> {
  const clip = await visibleClip(page, uuid);
  if ('reason' in clip) return { captured: false, reason: clip.reason };
  const raw = gunzipSync(await adbBuffer(['exec-out', 'screencap | gzip -1']), { maxOutputLength: 256 * 1024 * 1024 });
  return cropPng(raw, clip);
}

/** Crops a raw screencap to the clip and encodes an RGB PNG, sampling every n-th pixel until it fits the response. */
export function cropPng(raw: Buffer, clip: Clip): unknown {
  if (raw.length < 12) return { captured: false, reason: 'SCREENCAP_FAILED' };
  const screenWidth = raw.readUInt32LE(0);
  const screenHeight = raw.readUInt32LE(4);
  const header = raw.length - screenWidth * screenHeight * 4;
  // 1 is RGBA_8888 and 2 is RGBX_8888; other formats are not 4 bytes per pixel.
  if (![1, 2].includes(raw.readUInt32LE(8)) || (header !== 12 && header !== 16)) return { captured: false, reason: 'UNSUPPORTED_PIXEL_FORMAT' };
  // ponytail: viewport pixels equal screen pixels only for a full-screen game, as for adb taps; add the window offset for windowed apps.
  const left = Math.max(0, Math.floor(clip.x));
  const top = Math.max(0, Math.floor(clip.y));
  const right = Math.min(screenWidth, Math.ceil(clip.x + clip.width));
  const bottom = Math.min(screenHeight, Math.ceil(clip.y + clip.height));
  if (right <= left || bottom <= top) return { captured: false, reason: 'OUTSIDE_VIEWPORT' };
  // ponytail: nearest-pixel sampling keeps this dependency-free; box filtering would read text better when downscaled.
  for (const step of [1, 2, 3, 4, 6, 8]) {
    const width = Math.ceil((right - left) / step);
    const height = Math.ceil((bottom - top) / step);
    const rows = Buffer.alloc((width * 3 + 1) * height);
    for (let y = 0; y < height; y++) {
      const out = y * (width * 3 + 1) + 1;
      const source = header + ((top + y * step) * screenWidth + left) * 4;
      for (let x = 0; x < width; x++) raw.copy(rows, out + x * 3, source + x * step * 4, source + x * step * 4 + 3);
    }
    const data = png(width, height, rows).toString('base64');
    if (fitsImage(data)) return { captured: true, mimeType: 'image/png', data, width: right - left, height: bottom - top, ...(step > 1 ? { scale: 1 / step } : {}) };
  }
  return { captured: false, reason: 'RESPONSE_LIMIT' };
}

function png(width: number, height: number, rows: Buffer): Buffer {
  const chunk = (type: string, body: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body, crc32(type)), 0);
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB, no interlace
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// The app's own process, from its files directory, so logs of other Cocos apps on the device never mix in.
async function appProcess(page: Page): Promise<string> {
  const path = String(await page.evaluate(() => (globalThis as any).jsb?.fileUtils?.getWritablePath?.() ?? ''));
  const name = /^\/data\/(?:user\/\d+|data)\/([A-Za-z][\w.]{0,200})\//.exec(path)?.[1];
  if (!name) throw new InspectorError('CDP_UNAVAILABLE', 'Unable to identify the app package from the native runtime');
  const pid = (await adb(['shell', 'pidof', name]).catch(() => '')).trim().split(/\s+/)[0] ?? '';
  if (!/^\d+$/.test(pid)) throw new InspectorError('CDP_UNAVAILABLE', `App ${name} is not running`);
  return pid;
}

/**
 * The inspector port from the engine's own "Debugger listening" logcat lines: the latest one, or `expected` only when
 * some line names it. Any app can log under the Cocos tag, so reconnects pass the port they already used.
 */
export function inspectorPort(logcat: string, expected?: number): number | undefined {
  const ports = [...logcat.matchAll(/js_app\.html\?v8only=true&ws=[^:\s]+:(\d{2,5})\//g)].map(match => Number(match[1])).filter(port => port >= 1_024 && port <= 65_535);
  return expected === undefined ? ports.at(-1) : ports.includes(expected) ? expected : undefined;
}

/** Forwards the device's inspector port to the same loopback port; returns it, or undefined when no debug build has logged one. */
export async function forwardInspector(expected?: number): Promise<number | undefined> {
  const port = inspectorPort(await adb(['logcat', '-d', '-s', 'Cocos:D']), expected);
  if (port !== undefined) await adb(['forward', `tcp:${port}`, `tcp:${port}`]);
  return port;
}

const levels: Record<string, string> = { V: 'debug', D: 'log', I: 'info', W: 'warning', E: 'error', F: 'error' };

/** Parses `logcat -v epoch` lines of the Cocos tag; console.log and console.debug share one level there and map to log. */
export function parseCocosLogcat(output: string): Array<{ type: string; text: string; time: number }> {
  const messages: Array<{ type: string; text: string; time: number }> = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+\.\d+)\s+\d+\s+\d+\s+([VDIWEF])\s+Cocos\s*:\s?(?:\d\d:\d\d:\d\d \[\w+\]: )?(.*)$/.exec(line);
    if (match) messages.push({ type: levels[match[2]!]!, text: match[3]!, time: Number(match[1]) });
  }
  return messages;
}

export async function nativeConsoleMessages(page: Page, options: { types?: string[] | undefined; textContains?: string | undefined; limit?: number | undefined }): Promise<unknown> {
  const limit = options.limit ?? 50;
  const output = await adb(['logcat', '-d', '-v', 'epoch', `--pid=${await appProcess(page)}`, '-s', 'Cocos:V']);
  const items = parseCocosLogcat(output)
    .filter(item => !options.types?.length || options.types.includes(item.type))
    .filter(item => !options.textContains || item.text.includes(options.textContains));
  const selected = items.slice(-limit).map(item => ({ type: item.type, text: redactText(item.text), time: new Date(item.time * 1_000).toISOString() }));
  return {
    messages: selected,
    matched: items.length,
    truncated: items.length > limit,
    note: 'Cocos-tagged logcat lines of the app process since it started, bounded by the device log buffer. Engine lines start with D/ or E/; an uncaught JS error spans several error lines (message, then stack).',
  };
}

// Tapping an EditBox on Android opens CocosEditBoxActivity, a native EditText whose every change fires text-changed in the game.
export async function nativeTypeText(page: Page, uuid: string, text: string, submit: boolean): Promise<unknown> {
  // input text only types printable ASCII and turns "%s" into a space, so refuse what it would silently mangle.
  if (!/^[\x20-\x7e]*$/.test(text) || text.includes('%s')) throw new Error('Invalid mutation: native typing supports printable ASCII without "%s"');
  const { components } = await runBridge(page, { action: 'getComponents', uuid }) as { components?: Array<{ type: string }> };
  if (!components?.some(component => component.type === 'EditBox')) throw new Error('Component not found');
  const clicked = await nativeClick(page, uuid) as { clicked: boolean; reason?: string };
  if (!clicked.clicked) return { typed: false, reason: clicked.reason };
  let focused = false;
  for (let attempt = 0; attempt < 10 && !focused; attempt++) {
    focused = (await adb(['shell', 'dumpsys window | grep mCurrentFocus'])).includes('CocosEditBoxActivity');
    if (!focused) await settle();
  }
  if (!focused) return { typed: false, reason: 'NOT_FOCUSED' };
  // End, Shift+Home, Delete: select the current content and remove it. keycombination needs Android 12+.
  await adb(['shell', 'input', 'keyevent', 'KEYCODE_MOVE_END']);
  await adb(['shell', 'input', 'keycombination', 'KEYCODE_SHIFT_LEFT', 'KEYCODE_MOVE_HOME']);
  await adb(['shell', 'input', 'keyevent', 'KEYCODE_DEL']);
  // adb shell joins its arguments into one device shell command line: single-quote the text so it stays one literal word.
  if (text) await adb(['shell', `input text '${text.replace(/ /g, '%s').replace(/'/g, `'\\''`)}'`]);
  // Enter closes a single-line box (editing-did-ended); only the activity's confirm button fires editing-return.
  if (submit) await adb(['shell', 'input', 'keyevent', 'KEYCODE_ENTER']);
  await settle();
  const { properties } = await runBridge(page, { action: 'getProperties', uuid, componentType: 'EditBox', maxDepth: 0 }) as { properties?: { string?: string } };
  const after = typeof properties?.string === 'string' ? { string: properties.string } : { redacted: true };
  // The device keyboard still sees the keys: autocorrect or a Telex layout can rewrite "test" as "tét".
  const matches = typeof properties?.string === 'string' ? properties.string === text : undefined;
  return { typed: true, target: { nodeUuid: uuid }, length: text.length, submitted: submit, after, ...(matches === undefined ? {} : { matches }), ...(matches === false ? { hint: 'The device keyboard changed the text; switch it to a plain English layout without autocorrect' } : {}), input: 'adb', runtimeOnly: true };
}

// Native network capture. Native builds have no DevTools Network domain, so the first network call installs hooks on
// XMLHttpRequest (which the jsb fetch polyfill also uses) and WebSocket, keeping a bounded ring of recent traffic in the
// game's own memory. Only requests and frames after that first call are seen. Self-contained: it runs inside the game.
type NetworkQuery = { action: 'list' } | { action: 'get'; id: number };

function nativeNetwork(query: NetworkQuery): unknown {
  const root = globalThis as any;
  const MAX_ENTRIES = 200;
  const MAX_BODY = 100_000;
  const clip = (value: unknown): string => typeof value === 'string' ? value.slice(0, MAX_BODY)
    : value instanceof ArrayBuffer ? `[binary ${value.byteLength} bytes]` : value == null ? '' : `[${typeof value}]`;
  let state = root.__cocosWebInspectorNetwork as { entries: any[]; nextId: number; installedAt: number } | undefined;
  const installedNow = !state;
  if (!state) {
    state = root.__cocosWebInspectorNetwork = { entries: [], nextId: 1, installedAt: Date.now() };
    const record = (entry: any) => {
      entry.id = state!.nextId++;
      state!.entries.push(entry);
      if (state!.entries.length > MAX_ENTRIES) state!.entries.shift();
      return entry;
    };
    const Xhr = root.XMLHttpRequest;
    if (typeof Xhr === 'function') {
      const proto = Xhr.prototype;
      const open = proto.open;
      const send = proto.send;
      const setHeader = proto.setRequestHeader;
      proto.open = function (this: any, method: string, url: string, ...rest: unknown[]) {
        this.__cwi = { method: String(method).toUpperCase(), url: String(url), headers: {} as Record<string, string> };
        return open.call(this, method, url, ...rest);
      };
      proto.setRequestHeader = function (this: any, name: string, value: string) {
        // The ring lives in game memory that other game code can read, so credential headers are masked as they are captured.
        // ponytail: bodies stay raw in the ring and are redacted only when returned; redact here too if third-party SDKs are a concern.
        if (this.__cwi) this.__cwi.headers[String(name)] = /auth|cookie|token|secret|api-?key|password|session/i.test(String(name)) ? '[redacted]' : String(value);
        return setHeader.call(this, name, value);
      };
      proto.send = function (this: any, body?: unknown) {
        const meta = this.__cwi;
        if (meta) {
          const entry = record({ kind: 'xhr', method: meta.method, url: meta.url, requestHeaders: meta.headers, requestBody: clip(body), startedAt: Date.now() });
          this.__cwiDone = (failure?: string) => {
            if (entry.endedAt) return;
            entry.endedAt = Date.now();
            entry.status = Number(this.status) || null;
            if (failure) entry.failure = failure;
            try { entry.responseHeaders = String(this.getAllResponseHeaders() ?? '').slice(0, 10_000); } catch { /* not ready */ }
            try { entry.responseBody = clip(this.responseType === '' || this.responseType === 'text' ? this.responseText : this.response); } catch { /* unreadable */ }
          };
          // Native XHR dispatches only through on* properties, and its addEventListener just assigns them, so listeners
          // would replace the game's handlers. Chain through accessors instead; the native side reads them with a plain get.
          // ponytail: reading xhr.onload returns the chain, not the game's function; keep a handler map if identity matters.
          if (!this.__cwiHooked) {
            this.__cwiHooked = true;
            const xhr = this;
            for (const [name, failure] of [['onload', undefined], ['onerror', 'error'], ['ontimeout', 'timeout'], ['onabort', 'abort']] as const) {
              let handler: unknown = this[name];
              const chain = function (this: unknown, event: unknown) {
                try { xhr.__cwiDone(failure); } catch { /* never break the game */ }
                return typeof handler === 'function' ? handler.call(this, event) : undefined;
              };
              Object.defineProperty(this, name, { configurable: true, get: () => chain, set: (fn: unknown) => { handler = fn; } });
            }
          }
        }
        return send.call(this, body);
      };
    }
    const NativeSocket = root.WebSocket;
    if (typeof NativeSocket === 'function') {
      // Pass every argument through: native WebSocket takes (url, protocols, caFilePath), and dropping the CA file
      // changes how the game's TLS connection is verified.
      const Wrapped = function (this: any, ...args: unknown[]) {
        const socket = new NativeSocket(...args);
        const entry = record({ kind: 'websocket', method: 'GET', url: String(args[0]), startedAt: Date.now(), frames: [] as any[], framesSeen: 0 });
        const frame = (direction: 'sent' | 'received', data: unknown) => {
          entry.framesSeen++;
          entry.frames.push({ direction, at: Date.now(), data: clip(data).slice(0, 2_000) });
          if (entry.frames.length > 50) entry.frames.shift();
        };
        const send = socket.send;
        socket.send = function (data: unknown) { frame('sent', data); return send.call(socket, data); };
        // Native sockets dispatch only through on* properties; wrap each handler as the game assigns it.
        for (const [name, hook] of [
          ['onopen', () => { entry.status = 101; }],
          ['onmessage', (event: any) => frame('received', event?.data)],
          ['onerror', () => { entry.failure = 'error'; }],
          ['onclose', (event: any) => { entry.endedAt = Date.now(); entry.closeCode = Number(event?.code) || null; }],
        ] as const) {
          let handler: unknown = null;
          Object.defineProperty(socket, name, {
            configurable: true,
            get: () => handler,
            set: (fn: unknown) => { handler = typeof fn === 'function' ? function (this: unknown, event: unknown) { try { (hook as (event: unknown) => void)(event); } catch { /* never break the game */ } return (fn as (event: unknown) => unknown).call(this, event); } : fn; },
          });
        }
        return socket;
      } as any;
      Wrapped.prototype = NativeSocket.prototype;
      for (const key of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) Wrapped[key] = NativeSocket[key];
      root.WebSocket = Wrapped;
    }
  }
  if (query.action === 'list') return { installedAt: state.installedAt, installedNow, entries: state.entries.map(({ requestBody: _b, responseBody: _r, frames: _f, requestHeaders: _h, responseHeaders: _rh, ...summary }) => summary) };
  const entry = state.entries.find(candidate => candidate.id === query.id);
  return entry ? { installedAt: state.installedAt, entry } : { installedAt: state.installedAt, entry: null };
}

const sinceNote = (installedAt: number, installedNow: boolean) => installedNow
  ? 'Capture started with this call; make the game send traffic, then list again.'
  : `Requests and WebSocket frames since capture started at ${new Date(installedAt).toISOString()}; the game keeps the last 200.`;

export async function nativeNetworkRequests(page: Page, options: Parameters<typeof selectRequests>[1]): Promise<unknown> {
  const { installedAt, installedNow, entries } = await page.evaluate(nativeNetwork, { action: 'list' } satisfies NetworkQuery) as { installedAt: number; installedNow: boolean; entries: any[] };
  const rows = entries.map(entry => ({
    id: entry.id,
    method: entry.method,
    url: redactUrl(entry.url),
    resourceType: entry.kind,
    status: entry.status ?? null,
    ...(entry.failure ? { failure: String(entry.failure).slice(0, 300) } : {}),
    ...(entry.endedAt ? { durationMs: entry.endedAt - entry.startedAt } : {}),
    ...(entry.kind === 'websocket' ? { frames: entry.framesSeen } : {}),
  }));
  return selectRequests(rows, options, sinceNote(installedAt, installedNow));
}

export async function nativeNetworkRequest(page: Page, id: number, includeBody: boolean): Promise<unknown> {
  const { entry } = await page.evaluate(nativeNetwork, { action: 'get', id } satisfies NetworkQuery) as { entry: any };
  if (!entry) throw new InspectorError('REQUEST_NOT_FOUND', `Request ${id} not found; list requests again, older entries are dropped`);
  // Split each "name: value" line at its first colon only; dates and URLs carry more.
  const headers = (raw: string): Record<string, string> => Object.fromEntries(raw.split(/\r?\n/).map(line => /^([^:]+):\s*(.*)$/.exec(line)).filter(match => !!match).map(match => [match![1]!.trim().toLowerCase(), match![2]!]));
  const frames = entry.kind === 'websocket' && includeBody ? entry.frames.map((frame: any) => ({ direction: frame.direction, at: new Date(frame.at).toISOString(), data: redactBody(frame.data).body })) : undefined;
  // Native results skip runBridge, so enforce the response ceiling here: drop the oldest frames, then the bodies.
  let result = detail(entry, id, includeBody, headers, frames);
  while (frames?.length && !fitsResponse(result)) {
    frames.splice(0, Math.max(1, Math.ceil(frames.length / 4)));
    result = { ...detail(entry, id, includeBody, headers, frames), framesDropped: true };
  }
  return fitsResponse(result) ? result : { ...detail(entry, id, false, headers, undefined), truncated: true, truncationReasons: ['RESPONSE_LIMIT'] };
}

function detail(entry: any, id: number, includeBody: boolean, headers: (raw: string) => Record<string, string>, frames: unknown[] | undefined): Record<string, unknown> {
  return {
    id,
    method: entry.method,
    url: redactUrl(entry.url),
    resourceType: entry.kind,
    ...(entry.requestHeaders ? { requestHeaders: redactHeaders(entry.requestHeaders) } : {}),
    ...(includeBody && entry.requestBody ? { requestBody: redactBody(entry.requestBody) } : {}),
    status: entry.status ?? null,
    ...(entry.responseHeaders ? { responseHeaders: redactHeaders(headers(entry.responseHeaders)) } : {}),
    ...(entry.failure ? { failure: String(entry.failure).slice(0, 300) } : {}),
    ...(entry.closeCode ? { closeCode: entry.closeCode } : {}),
    ...(includeBody && entry.responseBody ? { responseBody: redactBody(entry.responseBody) } : {}),
    ...(entry.kind === 'websocket' ? { framesSeen: entry.framesSeen, ...(frames ? { frames } : {}) } : {}),
    timing: { startedAt: new Date(entry.startedAt).toISOString(), ...(entry.endedAt ? { durationMs: entry.endedAt - entry.startedAt } : {}) },
  };
}
