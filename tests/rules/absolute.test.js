// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { OFFICIAL_SOURCES } from '../../src/security/urls.js';
import { EXPORT_FORBIDDEN_KEY_PATTERN } from '../../src/instance/export.js';
import { SESSION_FILE_NAME } from '../../src/auth/token-store.js';
import { createInstanceExporter } from '../../src/instance/export.js';
import { createInstanceImporter } from '../../src/instance/import.js';
import { writeZipFile } from '../../src/archive/zip.js';
import { createInstanceManager } from '../../src/instance/manager.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SRC = path.join(ROOT, 'src');
const WEB = path.join(ROOT, 'web');

function walk(dir, filter) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(abs, filter));
    else if (filter(abs)) out.push(abs);
  }
  return out;
}

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[^'"\n]*?from\s+['"]([^'"]+)['"]/g;

test('rules 1-2: no npm dependencies and only built-in or relative imports', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0, 'runtime dependencies are forbidden');
  assert.equal(Object.keys(pkg.devDependencies ?? {}).length, 0, 'dev dependencies are forbidden');

  for (const file of walk(SRC, (abs) => abs.endsWith('.js'))) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(IMPORT_RE)) {
      const spec = match[1];
      const ok =
        spec.startsWith('node:') ||
        spec.startsWith('./') ||
        spec.startsWith('../') ||
        spec.startsWith('/');
      assert.ok(ok, `${path.relative(ROOT, file)} imports a non-builtin module: ${spec}`);
    }
  }
});

test('rules 3-4: web UI is self-contained vanilla HTML/CSS/JS', () => {
  const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
  const externalTag = /(?:src|href)\s*=\s*["']https?:\/\//i;
  const stripped = html.replace(/<a\s[^>]*href\s*=\s*["']https?:\/\/[^"']*["'][^>]*>/gi, '');
  assert.ok(!externalTag.test(stripped), 'no external scripts/stylesheets/links in index.html');
  assert.ok(!/<script[^>]+src=["']https?:/i.test(html), 'scripts must be served from self');

  const app = fs.readFileSync(path.join(WEB, 'js', 'app.js'), 'utf8');
  assert.ok(!/from\s+["'](?:react|vue|svelte|jquery|axios)/i.test(app), 'no UI frameworks');
  for (const match of app.matchAll(/fetch\(\s*["'`]([^"'`]+)/g)) {
    const target = match[1];
    assert.ok(
      target.startsWith('/') || target.startsWith('${') || target === '',
      `fetch target must be same-origin: ${target}`
    );
  }
});

test('rules 7-11: official sources are exactly minecraft, fabric, modrinth and microsoft', () => {
  assert.deepEqual(Object.keys(OFFICIAL_SOURCES).sort(), ['fabric', 'microsoft', 'minecraft', 'modrinth']);
  for (const [name, source] of Object.entries(OFFICIAL_SOURCES)) {
    const hosts = source.hosts ?? source;
    const list = Array.isArray(hosts) ? hosts : [];
    for (const host of list) {
      if (typeof host !== 'string') continue;
      assert.ok(
        !host.includes('mirror') && !host.includes('thirdparty'),
        `${name} must not contain mirror hosts: ${host}`
      );
    }
  }
});

test('rule 20: instance code never creates symlinks or hard links', () => {
  for (const file of walk(SRC, (abs) => abs.endsWith('.js'))) {
    const source = fs.readFileSync(file, 'utf8');
    assert.ok(!/\bfs\.symlinkSync\s*\(/.test(source), `${path.relative(ROOT, file)} uses fs.symlinkSync`);
    assert.ok(!/\bsymlinkSync\s*\(/.test(source), `${path.relative(ROOT, file)} uses symlinkSync`);
    assert.ok(!/\blinkSync\s*\(/.test(source), `${path.relative(ROOT, file)} uses linkSync (hard link)`);
    assert.ok(
      !/\.symlink\s*\(/.test(source) && !/\bfsPromises\.symlink/.test(source),
      `${path.relative(ROOT, file)} calls promise symlink`
    );
  }
});

test('rule 31: linux only — no win32 or darwin code paths', () => {
  const platform = fs.readFileSync(path.join(SRC, 'core', 'platform.js'), 'utf8');
  assert.match(platform, /UNSUPPORTED_PLATFORM/);
  assert.match(platform, /'linux'/);

  for (const file of walk(SRC, (abs) => abs.endsWith('.js'))) {
    const source = fs.readFileSync(file, 'utf8');
    assert.ok(!/['"]win32['"]/.test(source), `${path.relative(ROOT, file)} contains a win32 branch`);
    assert.ok(!/['"]darwin['"]/.test(source), `${path.relative(ROOT, file)} contains a darwin branch`);
  }
});

test('rule 27: auth secrets live outside instances and are export-forbidden', async () => {
  assert.ok(!SESSION_FILE_NAME.startsWith('instances/'));
  assert.ok(!SESSION_FILE_NAME.includes('/'), 'session file must sit at the data dir root');

  for (const key of ['accessToken', 'refreshToken', 'clientSecret', 'authorization']) {
    assert.ok(
      EXPORT_FORBIDDEN_KEY_PATTERN.test(key),
      `export secret scan must match ${key}`
    );
  }

  const exports = { createInstanceExporter, createInstanceImporter, writeZipFile, createInstanceManager };
  for (const [name, value] of Object.entries(exports)) {
    assert.equal(typeof value, 'function', `${name} must exist for export/import workflows`);
  }
});
