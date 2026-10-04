import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const npm = process.env.npm_execpath;
assert.ok(npm, 'npm_execpath is required; run this test through npm');
const runNpm = (args, cwd) => execFileSync(process.execPath, [npm, ...args], { cwd, encoding: 'utf8' });
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = mkdtempSync(join(tmpdir(), 'cocos-web-inspector-package-'));

try {
  const packResult = JSON.parse(runNpm(['pack', '--json', '--pack-destination', temporary], root));
  const packed = Array.isArray(packResult) ? packResult[0] : Object.values(packResult)[0];
  assert.ok(packed, 'npm pack returned no package');
  const files = packed.files.map(file => file.path).sort();
  for (const required of ['README.md', 'dist/src/index.js', 'package.json']) assert.ok(files.includes(required), `${required} is missing from package`);
  assert.ok(files.every(file => ['LICENSE', 'README.md', 'package.json'].includes(file) || file.startsWith('dist/src/')), `Unexpected package files: ${files.join(', ')}`);

  writeFileSync(join(temporary, 'package.json'), '{"private":true}');
  const tarball = join(temporary, packed.filename);
  runNpm(['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], temporary);
  const installed = JSON.parse(readFileSync(join(temporary, 'node_modules', 'cocos-web-inspector-mcp', 'package.json'), 'utf8'));
  assert.equal(installed.bin['cocos-web-inspector-mcp'], 'dist/src/index.js');

  const executable = join(temporary, 'node_modules', 'cocos-web-inspector-mcp', installed.bin['cocos-web-inspector-mcp']);
  const result = spawnSync(process.execPath, [executable, '--invalid-smoke-option'], { cwd: temporary, encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /Unknown argument: --invalid-smoke-option/);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
