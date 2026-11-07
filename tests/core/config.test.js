// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, publicConfig } from '../../src/core/config.js';
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
    assert.equal(config.server.port, 8653);
    assert.equal(config.log.level, 'warn');
    assert.ok(!('window' in config), 'the game window setting is gone — on Windows the launcher page runs in a browser');
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
      JSON.stringify({ host: '0.0.0.0', port: 1111, log: 'debug' })
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
    assert.equal(typeof view.log, 'string', 'the log level is a flat string, not a group');
    assert.ok(!json.includes('tml.log'), 'the log file path must stay private');
    assert.ok(!('projectRoot' in view));
    assert.equal(view.paths.exportsDir, config.paths.exportsDir, 'exportsDir is public so the export modal can default to it');
    assert.ok(!('window' in view));
    assert.ok(!json.includes('configFile'));
    assert.ok(!/token|password|secret/i.test(json));
  } finally {
    cleanup(dir);
  }
});

test('offlineName is loaded from the config file and exposed publicly', () => {
  const dir = tmpDir();
  try {
    const none = loadConfig({ env: { TML_DATA_DIR: dir } });
    assert.equal(none.auth.offlineName, null, 'no offline name is configured by default');
    assert.equal(publicConfig(none).offlineName, null);

    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ offlineName: '  Steve_1  ' }));
    const fromFile = loadConfig({ env: { TML_DATA_DIR: dir } });
    assert.equal(fromFile.auth.offlineName, 'Steve_1', 'the value is trimmed before use');
    assert.equal(publicConfig(fromFile).offlineName, 'Steve_1');
  } finally {
    cleanup(dir);
  }
});

test('invalid offline names raise ConfigError', () => {
  const dir = tmpDir();
  try {
    for (const bad of ['ab', 'a'.repeat(17), 'with space', 'bad!name']) {
      fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ offlineName: bad }));
      assert.throws(() => loadConfig({ env: { TML_DATA_DIR: dir } }), ConfigError);
    }
  } finally {
    cleanup(dir);
  }
});

test('a legacy window.platform key in config.json is ignored', () => {
  const dir = tmpDir();
  try {
    assert.ok(!('window' in loadConfig({ env: { TML_DATA_DIR: dir } })));

    for (const platform of ['wayland', 'auto', 'x11', 'mir']) {
      fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ window: { platform } }));
      const config = loadConfig({ env: { TML_DATA_DIR: dir } });
      assert.ok(!('window' in config), `window.platform=${platform} must be ignored, not an error`);
      assert.ok(!('window' in publicConfig(config)), 'the public view must not resurface it either');
    }
  } finally {
    cleanup(dir);
  }
});

