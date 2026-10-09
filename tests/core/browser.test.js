// Owner: Time And Time Studio
// Date: 2026-10-05 20:01 +0700
// License: GPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { openBrowser } from '../../src/core/browser.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function makeFakeChild() {
  const handlers = {};
  return {
    handlers,
    unrefCalled: false,
    on(event, handler) {
      handlers[event] = handler;
    },
    unref() {
      this.unrefCalled = true;
    },
  };
}

test('openBrowser spawns xdg-open with the url on linux', () => {
  const calls = [];
  const child = makeFakeChild();
  const result = openBrowser('http://127.0.0.1:8620', {
    platform: 'linux',
    env: {},
    spawnFn: (...args) => {
      calls.push(args);
      return child;
    },
  });

  assert.equal(result, true);
  assert.equal(calls.length, 1);
  const [command, args, options] = calls[0];
  assert.equal(command, 'xdg-open');
  assert.deepEqual(args, ['http://127.0.0.1:8620']);
  assert.equal(options.stdio, 'ignore');
  assert.equal(options.detached, true);
  assert.equal(child.unrefCalled, true, 'spawned opener must not keep the process alive');
});

test('openBrowser skips on non-linux platforms', () => {
  let spawned = false;
  const result = openBrowser('http://127.0.0.1:8620', {
    platform: 'darwin',
    env: {},
    spawnFn: () => {
      spawned = true;
      return makeFakeChild();
    },
  });

  assert.equal(result, false);
  assert.equal(spawned, false);
});

test('openBrowser honors TML_NO_BROWSER=1', () => {
  let spawned = false;
  const result = openBrowser('http://127.0.0.1:8620', {
    platform: 'linux',
    env: { TML_NO_BROWSER: '1' },
    spawnFn: () => {
      spawned = true;
      return makeFakeChild();
    },
  });

  assert.equal(result, false);
  assert.equal(spawned, false);
});

test('openBrowser rejects non-http urls', () => {
  let spawned = false;
  const spawnFn = () => {
    spawned = true;
    return makeFakeChild();
  };
  assert.equal(openBrowser('file:///etc/passwd', { platform: 'linux', env: {}, spawnFn }), false);
  assert.equal(openBrowser('', { platform: 'linux', env: {}, spawnFn }), false);
  assert.equal(openBrowser(undefined, { platform: 'linux', env: {}, spawnFn }), false);
  assert.equal(spawned, false);
});

test('openBrowser swallows spawn failures and async opener errors', () => {
  // spawn โยนเอง (เช่น binary ไม่มีใน PATH บางเวอร์ชีของ spawn)
  assert.equal(
    openBrowser('http://127.0.0.1:8620', {
      platform: 'linux',
      env: {},
      spawnFn: () => {
        throw new Error('ENOENT');
      },
    }),
    false
  );

  // child emit error ทีหลัง (ENOENT แบบ async) — ห้าม throw
  const child = makeFakeChild();
  const result = openBrowser('http://127.0.0.1:8620', {
    platform: 'linux',
    env: {},
    spawnFn: () => child,
  });
  assert.equal(result, true);
  assert.ok(child.handlers.error, 'an error handler must be attached');
  assert.doesNotThrow(() => child.handlers.error(new Error('spawn xdg-open ENOENT')));
});

test('running tml auto-opens the printed URL through xdg-open', { skip: process.platform !== 'linux' }, async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tml-open-'));
  const binDir = path.join(workDir, 'bin');
  const marker = path.join(workDir, 'opened-url.txt');
  fs.mkdirSync(binDir, { recursive: true });
  // xdg-open เปล่า (เขียน URL ที่ได้รับลงไฟล์แทนการเปิดเบราว์เซอร์จริง)
  const fakeXdgOpen = path.join(binDir, 'xdg-open');
  fs.writeFileSync(fakeXdgOpen, `#!/bin/sh\nprintf '%s' "$1" > "${marker}"\n`, { mode: 0o755 });

  const child = spawn(process.execPath, [path.join('src', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      TML_DATA_DIR: path.join(workDir, 'data'),
      TML_PORT: '0',
      TML_LOG_LEVEL: 'silent',
      TML_NO_BROWSER: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });

  try {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (fs.existsSync(marker)) break;
      if (child.exitCode !== null) {
        throw new Error(`tml exited early (code ${child.exitCode}): ${stderr}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(fs.existsSync(marker), 'xdg-open must be invoked after the server starts');
    const opened = fs.readFileSync(marker, 'utf8');
    assert.match(opened, /^http:\/\/127\.0\.0\.1:\d+$/, 'the printed server URL must be opened');
    assert.ok(!opened.endsWith(':0'), 'the real bound port must be used, not 0');
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 3000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});
