import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Page } from 'playwright-core';
import { nodeCenter, runBridge } from './bridge.js';
import { InspectorError, validateLocalUrl } from './browser.js';
import { redactText } from './browser-data.js';

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

  async #evaluate(fn: (arg: unknown) => unknown, arg: unknown): Promise<unknown> {
    let targets: Array<{ webSocketDebuggerUrl?: string }>;
    try {
      const response = await fetch(new URL('/json/list', this.#http), { signal: AbortSignal.timeout(10_000) });
      targets = await response.json() as typeof targets;
    } catch (error) {
      throw new InspectorError('CDP_UNAVAILABLE', `Unable to reach the native inspector at ${this.#http.host}: ${error instanceof Error ? error.message : 'unknown error'}; run the debug build, find its port in logcat "Debugger listening", then adb forward tcp:<port> tcp:<port>`);
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
async function adb(args: string[]): Promise<string> {
  try {
    return (await run('adb', args, { timeout: 15_000, maxBuffer: 16 * 1024 * 1024 })).stdout;
  } catch (error) {
    const message = error instanceof Error ? error.message.split('\n')[0]! : 'unknown error';
    throw new InspectorError('CDP_UNAVAILABLE', `adb ${args[0]} failed: ${message.slice(0, 300)}; check adb devices, and set ANDROID_SERIAL when several are attached`);
  }
}

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

// The app's own process, from its files directory, so logs of other Cocos apps on the device never mix in.
async function appProcess(page: Page): Promise<string> {
  const path = String(await page.evaluate(() => (globalThis as any).jsb?.fileUtils?.getWritablePath?.() ?? ''));
  const name = /^\/data\/(?:user\/\d+|data)\/([A-Za-z][\w.]{0,200})\//.exec(path)?.[1];
  if (!name) throw new InspectorError('CDP_UNAVAILABLE', 'Unable to identify the app package from the native runtime');
  const pid = (await adb(['shell', 'pidof', name]).catch(() => '')).trim().split(/\s+/)[0] ?? '';
  if (!/^\d+$/.test(pid)) throw new InspectorError('CDP_UNAVAILABLE', `App ${name} is not running`);
  return pid;
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
