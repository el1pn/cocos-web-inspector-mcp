#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { BrowserConnection } from './browser.js';
import { createServer } from './server.js';

function endpointFromArgs(args: string[]): string {
  const index = args.indexOf('--cdp-endpoint');
  if (index !== -1) {
    const value = args[index + 1];
    if (!value) throw new Error('--cdp-endpoint requires a value');
    return value;
  }
  const unknown = args.find(arg => arg.startsWith('-'));
  if (unknown) throw new Error(`Unknown argument: ${unknown}`);
  return process.env.COCOS_CDP_ENDPOINT ?? 'http://127.0.0.1:9222';
}

async function main(): Promise<void> {
  const browser = new BrowserConnection(endpointFromArgs(process.argv.slice(2)));
  const server = createServer(browser);
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
