// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_MSA_CLIENT_ID, DEFAULT_AUTH_FLOW, loadConfig, publicConfig } from '../../src/core/config.js';
import { ConfigError } from '../../src/core/errors.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tml-config-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test('loadConfig uses defaults', () => {
  const dir = tmpDir();
  try {
    const config = loadConfig({ env: { TML_DATA_DIR: dir } });

    assert.equal(config.server.host, '127.0.0.1');
    assert.equal(config.server.port, 8620);
    assert.equal(config.log.level, 'warn');
    assert.equal(config.window.platform, 'auto');
    assert.equal(config.phase, undefined);
    assert.equal(config.paths.webDir, path.join(config.projectRoot, 'web'));
    assert.ok(config.paths.instancesDir.startsWith(dir));
    assert.ok(Object.isFrozen(config));
  } finally {
    cleanup(dir);
  }
});

test('environment overrides config file', () => {
  const dir = tmpDir();
  try {
    fs.writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({ server: { host: '0.0.0.0', port: 1111 }, log: { level: 'debug' } })
    );

    const fromFile = loadConfig({ env: { TML_DATA_DIR: dir } });
    assert.equal(fromFile.server.host, '0.0.0.0');
    assert.equal(fromFile.server.port, 1111);
    assert.equal(fromFile.log.level, 'debug');

    const fromEnv = loadConfig({ env: { TML_DATA_DIR: dir, TML_PORT: '9999', TML_LOG_LEVEL: 'warn' } });
    assert.equal(fromEnv.server.port, 9999);
    assert.equal(fromEnv.log.level, 'warn');
  } finally {
    cleanup(dir);
  }
});

test('invalid values raise ConfigError', () => {
  const dir = tmpDir();
  try {
    assert.throws(() => loadConfig({ env: { TML_DATA_DIR: dir, TML_PORT: 'abc' } }), ConfigError);
    assert.throws(() => loadConfig({ env: { TML_DATA_DIR: dir, TML_PORT: '70000' } }), ConfigError);
    assert.throws(() => loadConfig({ env: { TML_DATA_DIR: dir, TML_LOG_LEVEL: 'loud' } }), ConfigError);
    assert.throws(() => loadConfig({ env: { TML_DATA_DIR: dir, TML_HOST: '' } }), ConfigError);

    fs.writeFileSync(path.join(dir, 'config.json'), '{ not json');
    assert.throws(() => loadConfig({ env: { TML_DATA_DIR: dir } }), ConfigError);
  } finally {
    cleanup(dir);
  }
});

test('port 0 is allowed for tests', () => {
  const dir = tmpDir();
  try {
    const config = loadConfig({ env: { TML_DATA_DIR: dir, TML_PORT: '0' } });
    assert.equal(config.server.port, 0);
  } finally {
    cleanup(dir);
  }
});

test('publicConfig exposes only the safe subset', () => {
  const dir = tmpDir();
  try {
    const config = loadConfig({ env: { TML_DATA_DIR: dir } });
    const view = publicConfig(config);
    const json = JSON.stringify(view);

    assert.equal(view.name, 'TML');
    assert.equal(view.version, config.version);
    assert.ok(json.includes(dir));
    assert.ok(!('file' in view.log));
    assert.ok(!('projectRoot' in view));
    assert.equal(view.paths.exportsDir, config.paths.exportsDir, 'exportsDir is public so the export modal can default to it');
    assert.equal(view.window.platform, 'auto');
    assert.ok(!json.includes('configFile'));
    assert.ok(!/token|password|secret/i.test(json));
  } finally {
    cleanup(dir);
  }
});

test('own Microsoft app client id defaults to the built-in app, overridable by file or env', () => {
  const dir = tmpDir();
  try {
    const GUID = '11111111-2222-3333-4444-555555555555';

    const none = loadConfig({ env: { TML_DATA_DIR: dir } });
    assert.equal(none.auth.clientId, DEFAULT_MSA_CLIENT_ID);
    assert.equal(none.auth.source, 'default');
    assert.equal(none.auth.offlineName, null, 'no offline name is configured by default');
    assert.match(DEFAULT_MSA_CLIENT_ID, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'the built-in default must be a GUID');
    assert.deepEqual(publicConfig(none).auth, { configured: true, source: 'default', offlineName: null, flow: 'aad' });
    assert.ok(!JSON.stringify(publicConfig(none)).includes(DEFAULT_MSA_CLIENT_ID), 'public config must not leak the raw client id');

    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ auth: { clientId: GUID } }));
    const fromFile = loadConfig({ env: { TML_DATA_DIR: dir } });
    assert.equal(fromFile.auth.clientId, GUID);
    assert.equal(fromFile.auth.source, 'file');
    const view = publicConfig(fromFile);
    assert.deepEqual(view.auth, { configured: true, source: 'file', offlineName: null, flow: 'aad' });
    assert.ok(!JSON.stringify(view).includes(GUID), 'public config must not leak the raw client id');

    const OTHER = '22222222-3333-4444-5555-666666666666';
    const fromEnv = loadConfig({ env: { TML_DATA_DIR: dir, TML_MSA_CLIENT_ID: `  ${OTHER}  ` } });
    assert.equal(fromEnv.auth.clientId, OTHER);
    assert.equal(fromEnv.auth.source, 'env');
  } finally {
    cleanup(dir);
  }
});

test('invalid Microsoft app client ids raise ConfigError', () => {
  const dir = tmpDir();
  try {
    assert.throws(() => loadConfig({ env: { TML_DATA_DIR: dir, TML_MSA_CLIENT_ID: 'not-a-guid' } }), ConfigError);

    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ auth: { clientId: 'also-not-a-guid' } }));
    assert.throws(() => loadConfig({ env: { TML_DATA_DIR: dir } }), ConfigError);
  } finally {
    cleanup(dir);
  }
});

// ตัวเลือก platform ของหน้าต่างเกม: 'auto' = ตาม session (Wayland native), 'x11' = บังคับผ่าน XWayland
test('window.platform defaults to auto, reads x11 from the file and rejects unknown values', () => {
  const dir = tmpDir();
  try {
    assert.equal(loadConfig({ env: { TML_DATA_DIR: dir } }).window.platform, 'auto');

    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ window: { platform: 'x11' } }));
    const fromFile = loadConfig({ env: { TML_DATA_DIR: dir } });
    assert.equal(fromFile.window.platform, 'x11');
    assert.equal(publicConfig(fromFile).window.platform, 'x11');

    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ window: { platform: 'wayland' } }));
    assert.throws(() => loadConfig({ env: { TML_DATA_DIR: dir } }), ConfigError);

    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ window: { platform: 'auto' } }));
    assert.equal(loadConfig({ env: { TML_DATA_DIR: dir } }).window.platform, 'auto');
  } finally {
    cleanup(dir);
  }
});

// LIVE FLOW — ทดสอบการเลือกวิธี sign in: ลบบล็อกนี้พร้อม src/auth/live.js
test('auth.flow defaults to aad, accepts live and rejects unknown values', () => {
  const dir = tmpDir();
  try {
    assert.equal(DEFAULT_AUTH_FLOW, 'aad', 'the AAD app stays the default until it passes review');
    const none = loadConfig({ env: { TML_DATA_DIR: dir } });
    assert.equal(none.auth.flow, 'aad');

    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ auth: { flow: 'live' } }));
    assert.equal(loadConfig({ env: { TML_DATA_DIR: dir } }).auth.flow, 'live');

    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ auth: { flow: 'bogus' } }));
    assert.throws(() => loadConfig({ env: { TML_DATA_DIR: dir } }), ConfigError);
  } finally {
    cleanup(dir);
  }
});
// /LIVE FLOW
