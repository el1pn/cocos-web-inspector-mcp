import { execFile, spawn } from 'node:child_process';
import { access, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import type { Page } from 'playwright-core';
import { InspectorError, sanitizeUrl } from './browser.js';

export type RecordingResult = { recording: true; pageUrl: string; path: string; mode: 'web' | 'android' };
export type RecordingStopResult = { recording: false; saved: true; path: string; mode: 'web' | 'android'; frames?: number | undefined };

type ActiveRecording = {
  pageUrl: string;
  path: string;
  stop: () => Promise<RecordingStopResult>;
  abort: () => Promise<void>;
};

const run = promisify(execFile);
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.mp4$/;
const wait = (milliseconds: number) => new Promise(resolveWait => setTimeout(resolveWait, milliseconds));

async function command(name: string, args: string[], timeout: number): Promise<string> {
  try {
    return (await run(name, args, { timeout, maxBuffer: 1024 * 1024 })).stdout;
  } catch (error) {
    const failed = error as Error & { stderr?: string | Buffer | undefined };
    const detail = String(failed.stderr ?? '').trim().split('\n').at(-1) || failed.message.split('\n')[0]!;
    throw new InspectorError('CDP_UNAVAILABLE', `${name} ${args[0] ?? ''} failed: ${detail.slice(0, 300)}`);
  }
}

function outputPath(outputDir: string, fileName?: string): string {
  const name = fileName ?? `cocos-recording-${new Date().toISOString().replace(/[:.]/g, '-')}.mp4`;
  if (!FILE_NAME.test(name) || basename(name) !== name) throw new Error('Invalid recording: fileName must be a simple .mp4 file name');
  return join(outputDir, name);
}

export class RecordingManager {
  #active: ActiveRecording | undefined;

  constructor(
    private readonly native: boolean,
    private readonly outputDir = resolve(process.env.COCOS_RECORDING_DIR ?? join(tmpdir(), 'cocos-web-inspector-recordings')),
  ) {}

  async start(page: Page, fileName?: string): Promise<RecordingResult> {
    if (this.#active) throw new Error(`Invalid recording: already recording ${this.#active.pageUrl}`);
    await mkdir(this.outputDir, { recursive: true });
    const path = outputPath(this.outputDir, fileName);
    await access(path).then(() => { throw new Error(`Invalid recording: file already exists: ${path}`); }, () => undefined);
    const active = this.native ? await startAndroidRecording(page.url(), path) : await startWebRecording(page, path);
    this.#active = active;
    return { recording: true, pageUrl: sanitizeUrl(active.pageUrl), path, mode: this.native ? 'android' : 'web' };
  }

  async stop(pageUrl?: string): Promise<RecordingStopResult> {
    const active = this.#active;
    if (!active) throw new Error('Invalid recording: no recording is active');
    if (pageUrl && new URL(pageUrl).href !== new URL(active.pageUrl).href) throw new Error(`Invalid recording: active page is ${sanitizeUrl(active.pageUrl)}`);
    this.#active = undefined;
    try {
      return await active.stop();
    } catch (error) {
      await active.abort().catch(() => undefined);
      throw error;
    }
  }

  async close(): Promise<void> {
    const active = this.#active;
    this.#active = undefined;
    await active?.abort().catch(() => undefined);
  }
}

async function startWebRecording(page: Page, path: string): Promise<ActiveRecording> {
  const session = await page.context().newCDPSession(page);
  const framesDir = `${path}.frames`;
  await mkdir(framesDir, { recursive: true });
  let frames = 0;
  let firstTimestamp: number | undefined;
  let lastTimestamp: number | undefined;
  let stopping = false;
  let chain = Promise.resolve();
  const onFrame = (event: { data: string; sessionId: number; metadata?: { timestamp?: number } }) => {
    if (stopping) return;
    const timestamp = event.metadata?.timestamp;
    if (typeof timestamp === 'number') {
      firstTimestamp ??= timestamp;
      lastTimestamp = timestamp;
    }
    const index = frames++;
    chain = chain.then(async () => {
      await writeFile(join(framesDir, `${String(index).padStart(8, '0')}.jpg`), Buffer.from(event.data, 'base64'));
      await session.send('Page.screencastFrameAck', { sessionId: event.sessionId });
    });
  };
  session.on('Page.screencastFrame', onFrame);
  try {
    await session.send('Page.startScreencast', { format: 'jpeg', quality: 85, everyNthFrame: 1 });
  } catch (error) {
    session.off('Page.screencastFrame', onFrame);
    await session.detach().catch(() => undefined);
    await rm(framesDir, { recursive: true, force: true });
    throw error;
  }
  const cleanup = async () => {
    stopping = true;
    session.off('Page.screencastFrame', onFrame);
    await session.send('Page.stopScreencast').catch(() => undefined);
    await chain;
    await session.detach().catch(() => undefined);
  };
  return {
    pageUrl: page.url(),
    path,
    abort: async () => { await cleanup(); await rm(framesDir, { recursive: true, force: true }); },
    stop: async () => {
      await cleanup();
      if (frames === 0) { await rm(framesDir, { recursive: true, force: true }); throw new Error('Invalid recording: Chromium produced no frames'); }
      try {
        const duration = firstTimestamp === undefined || lastTimestamp === undefined ? undefined : lastTimestamp - firstTimestamp;
        const frameRate = duration && duration > 0 ? Math.min(120, Math.max(1, frames / duration)) : 30;
        await command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-framerate', frameRate.toFixed(3), '-i', join(framesDir, '%08d.jpg'), '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path], 120_000);
      } catch (error) {
        await rm(path, { force: true });
        throw error;
      } finally {
        await rm(framesDir, { recursive: true, force: true });
      }
      return { recording: false, saved: true, path, mode: 'web', frames };
    },
  };
}

async function startAndroidRecording(pageUrl: string, path: string): Promise<ActiveRecording> {
  const remote = `/sdcard/Download/.cocos-recording-${randomUUID()}.mp4`;
  const process = spawn('adb', ['shell', 'screenrecord', '--time-limit', '180', remote], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  process.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-1_000); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolveExit => process.once('exit', (code, signal) => resolveExit({ code, signal })));
  await Promise.race([
    exited.then(({ code }) => { throw new Error(`Invalid recording: adb screenrecord exited before starting${stderr ? `: ${stderr.trim()}` : ` with code ${code}`}`); }),
    wait(500),
  ]);
  const finish = async (save: boolean) => {
    if (process.exitCode === null && process.signalCode === null) process.kill('SIGINT');
    let ended = await Promise.race([exited, wait(5_000).then(() => undefined)]);
    if (!ended) { process.kill('SIGKILL'); ended = await exited; }
    if (!save) { await command('adb', ['shell', 'rm', '-f', remote], 15_000).catch(() => ''); return; }
    if (ended.code !== 0 && !stderr.includes('interrupted')) throw new Error(`Invalid recording: adb screenrecord failed${stderr ? `: ${stderr.trim()}` : ` with code ${ended.code}`}`);
    const partial = `${path}.partial`;
    try {
      await command('adb', ['pull', remote, partial], 120_000);
      await rename(partial, path);
    } finally {
      await rm(partial, { force: true });
      await command('adb', ['shell', 'rm', '-f', remote], 15_000).catch(() => '');
    }
  };
  return {
    pageUrl,
    path,
    abort: () => finish(false),
    stop: async () => { await finish(true); return { recording: false, saved: true, path, mode: 'android' }; },
  };
}
