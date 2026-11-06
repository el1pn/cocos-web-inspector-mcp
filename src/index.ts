#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { BrowserConnection } from './browser.js';
import { ChromeLauncher } from './chrome.js';
import { NativeConnection } from './native.js';
import { createServer } from './server.js';

function optionsFromArgs(args: string[]): { endpoint: string; nativeEndpoint: string | undefined; allowRuntimeMutation: boolean; allowBrowserData: boolean; allowWebPages: boolean; allowMethodCall: boolean; allowRecording: boolean; allowLaunch: boolean; explicitEndpoint: boolean; logFile: string | undefined } {
  let endpoint = process.env.COCOS_CDP_ENDPOINT ?? 'http://127.0.0.1:9222';
  let nativeEndpoint: string | undefined;
  let allowRuntimeMutation = false;
  let allowBrowserData = false;
  let allowWebPages = false;
  let allowMethodCall = false;
  let allowRecording = false;
  let allowLaunch = false;
  let logFile: string | undefined;
  let explicitEndpoint = !!process.env.COCOS_CDP_ENDPOINT;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--allow-runtime-mutation') {
      allowRuntimeMutation = true;
      continue;
    }
    if (arg === '--allow-browser-data') {
      allowBrowserData = true;
      continue;
    }
    if (arg === '--allow-web-pages') {
      allowWebPages = true;
      continue;
    }
    if (arg === '--allow-method-call') {
      allowMethodCall = true;
      continue;
    }
    if (arg === '--allow-recording') {
      allowRecording = true;
      continue;
    }
    if (arg === '--allow-launch') {
      allowLaunch = true;
      continue;
    }
    if (arg === '--log-file') {
      logFile = args[++index];
      if (!logFile) throw new Error('--log-file requires a value');
      continue;
    }
    if (arg === '--cdp-endpoint') {
      const value = args[++index];
      if (!value) throw new Error('--cdp-endpoint requires a value');
      endpoint = value;
      explicitEndpoint = true;
      continue;
    }
    if (arg === '--native-endpoint') {
      nativeEndpoint = args[++index];
      if (!nativeEndpoint) throw new Error('--native-endpoint requires a value');
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`Unknown argument: ${arg}`);
  }
  return { endpoint, nativeEndpoint, allowRuntimeMutation, allowBrowserData, allowWebPages, allowMethodCall, allowRecording, allowLaunch, explicitEndpoint, logFile };
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'launch' || command === 'doctor') return (await import('./cli.js')).commands[command]!(rest);
  const options = optionsFromArgs(process.argv.slice(2));
  if (options.allowLaunch && options.nativeEndpoint) throw new Error('--allow-launch cannot be combined with --native-endpoint');
  if (options.allowWebPages && options.nativeEndpoint) throw new Error('--allow-web-pages cannot be combined with --native-endpoint');
  const browser = options.nativeEndpoint ? new NativeConnection(options.nativeEndpoint) : new BrowserConnection(options.endpoint);
  const launcher = options.allowLaunch && browser instanceof BrowserConnection ? new ChromeLauncher(options.explicitEndpoint ? options.endpoint : undefined, browser) : undefined;
  const server = createServer(browser, { allowRuntimeMutation: options.allowRuntimeMutation, allowBrowserData: options.allowBrowserData, allowWebPages: options.allowWebPages, allowMethodCall: options.allowMethodCall, allowRecording: options.allowRecording, ...(launcher && { launcher }), ...(options.logFile && { logFile: options.logFile }), native: !!options.nativeEndpoint });
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await Promise.allSettled([browser.close(), server.close(), launcher?.close()]);
  };
  process.once('SIGINT', () => void close());
  process.once('SIGTERM', () => void close());
  await server.connect(new StdioServerTransport());
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Failed to start server'}\n`);
  process.exitCode = 1;
});
