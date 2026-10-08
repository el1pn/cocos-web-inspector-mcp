#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { BrowserConnection } from './browser.js';
import { NativeConnection } from './native.js';
import { createServer } from './server.js';

function optionsFromArgs(args: string[]): { endpoint: string; nativeEndpoint: string | undefined; allowRuntimeMutation: boolean; allowBrowserData: boolean; allowMethodCall: boolean } {
  let endpoint = process.env.COCOS_CDP_ENDPOINT ?? 'http://127.0.0.1:9222';
  let nativeEndpoint: string | undefined;
  let allowRuntimeMutation = false;
  let allowBrowserData = false;
  let allowMethodCall = false;
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
    if (arg === '--allow-method-call') {
      allowMethodCall = true;
      continue;
    }
    if (arg === '--cdp-endpoint') {
      const value = args[++index];
      if (!value) throw new Error('--cdp-endpoint requires a value');
      endpoint = value;
      continue;
    }
    if (arg === '--native-endpoint') {
      nativeEndpoint = args[++index];
      if (!nativeEndpoint) throw new Error('--native-endpoint requires a value');
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`Unknown argument: ${arg}`);
  }
  return { endpoint, nativeEndpoint, allowRuntimeMutation, allowBrowserData, allowMethodCall };
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'launch' || command === 'doctor') return (await import('./cli.js')).commands[command]!(rest);
  const options = optionsFromArgs(process.argv.slice(2));
  const browser = options.nativeEndpoint ? new NativeConnection(options.nativeEndpoint) : new BrowserConnection(options.endpoint);
  const server = createServer(browser, { allowRuntimeMutation: options.allowRuntimeMutation, allowBrowserData: options.allowBrowserData, allowMethodCall: options.allowMethodCall, native: !!options.nativeEndpoint });
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await Promise.allSettled([browser.close(), server.close()]);
  };
  process.once('SIGINT', () => void close());
  process.once('SIGTERM', () => void close());
  await server.connect(new StdioServerTransport());
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Failed to start server'}\n`);
  process.exitCode = 1;
});
