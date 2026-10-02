// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../../src/core/config.js';
import { createMinecraftApi } from '../../src/minecraft/api.js';
import { createInstaller } from '../../src/minecraft/install.js';

const skip = !process.env.TML_LIVE;
const NO_NETWORK = { skip };

let config;
let installer;

before(() => {
  config = loadConfig();
  const minecraft = createMinecraftApi({ config });
  installer = createInstaller({ config, minecraft });
});

test('live: installs 1.12.2 client, libraries, natives and logging', NO_NETWORK, async () => {
  const include = ['client', 'libraries', 'logging', 'natives'];
  const plan = await installer.plan('1.12.2');
  assert.ok(plan.natives.length > 0, '1.12.2 must expose native classifiers');

  const events = [];
  const first = await installer.install('1.12.2', {
    include,
    onProgress: (event) => events.push(event),
  });

  assert.equal(
    first.files.total,
    1 + plan.libraries.length + plan.natives.length + (plan.logging ? 1 : 0),
  );
  assert.equal(first.files.failed, 0);
  assert.ok(first.natives, 'expected a natives result');
  assert.ok(first.natives.files > 0, 'expected extracted native files');
  assert.ok(fs.existsSync(first.path.client));
  assert.ok(fs.existsSync(first.path.logging));
  assert.ok(!fs.existsSync(path.join(installer.layout.nativesDir('1.12.2'), 'META-INF')));

  const status = await installer.status('1.12.2', { include, deep: true });
  assert.equal(status.ready, true);
  assert.equal(status.sections.natives.ready, true);

  assert.ok(events.length > 0);
  assert.equal(events.at(-1).stage, 'done');
  assert.equal(events.at(-1).percent, 100);

  const second = await installer.install('1.12.2', { include });
  assert.equal(second.files.total, first.files.total);
  assert.equal(second.files.downloaded, 0);
  assert.equal(second.files.cached, first.files.total);
  assert.equal(second.natives.skipped, true);
});

test('live: downloads the 1.0 asset index and every asset object', NO_NETWORK, async () => {
  const include = ['assets'];
  const plan = await installer.plan('1.0');
  assert.ok(plan.assetIndex, '1.0 must declare an asset index');

  const first = await installer.install('1.0', { include });
  assert.ok(first.files.total >= 10, 'expected a real asset set');
  assert.equal(first.natives, null);
  assert.equal(first.files.failed, 0);

  const status = await installer.status('1.0', { include });
  assert.equal(status.ready, true);
  assert.equal(status.sections.assets.index.installed, true);
  assert.equal(status.sections.assets.objects.missingCount, 0);
  assert.equal(status.sections.assets.objects.planned, first.files.total - 1);

  const second = await installer.install('1.0', { include });
  assert.equal(second.files.total, first.files.total);
  assert.equal(second.files.downloaded, 0);
  assert.equal(second.files.cached, first.files.total);
});
