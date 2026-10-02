// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createJavaDetector,
  defaultJavaRoots,
  findMinecraftJava,
  parseJavaVersion,
} from '../../src/java/runtime.js';
import { ConfigError, JavaRuntimeError, ValidationError } from '../../src/core/errors.js';

const BIN = 'java';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tml-java-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function writeBinary(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(file, 0o755);
  return file;
}

function writeScript(file, script) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, script, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
  return file;
}

const openjdk17 = 'openjdk version "17.0.8" 2023-07-18\nOpenJDK Runtime Environment\n';
const legacy8 = 'java version "1.8.0_202"\nJava(TM) SE Runtime Environment\n';

test('parseJavaVersion understands modern, legacy and bare outputs', () => {
  assert.deepEqual(parseJavaVersion(openjdk17), { major: 17, raw: '17.0.8' });
  assert.deepEqual(parseJavaVersion(legacy8), { major: 8, raw: '1.8.0_202' });
  assert.deepEqual(parseJavaVersion('openjdk 21.0.1 2023-10-17\nOpenJDK Runtime Environment'), {
    major: 21,
    raw: '21.0.1',
  });
  assert.deepEqual(
    parseJavaVersion('Picked up JAVA_TOOL_OPTIONS: -Xmx1G\nopenjdk version "16.0.1" 2021-04-20'),
    { major: 16, raw: '16.0.1' },
  );
  assert.deepEqual(parseJavaVersion('java version "17"'), { major: 17, raw: '17' });
  assert.deepEqual(parseJavaVersion('GraalVM CE 17.0.5+8.1\nopenjdk version "17.0.5"'), {
    major: 17,
    raw: '17.0.5',
  });
  assert.equal(parseJavaVersion('bash: java: command not found'), null);
  assert.equal(parseJavaVersion('version "abc"'), null);
  assert.equal(parseJavaVersion(''), null);
  assert.equal(parseJavaVersion(null), null);
});

test('defaultJavaRoots returns only Linux launcher and managed runtimes', () => {
  const roots = defaultJavaRoots({ env: { HOME: '/home/tester' } });
  assert.deepEqual(
    roots.map((root) => root.path),
    [
      '/usr/share/minecraft-launcher/runtime',
      '/opt/minecraft-launcher/runtime',
      '/usr/lib/minecraft-launcher/runtime',
      '/home/tester/.minecraft/runtime',
      '/home/tester/snap/minecraft/common/.minecraft/runtime',
    ],
  );
  assert.deepEqual(
    roots.map((root) => root.source),
    ['official-launcher', 'official-launcher', 'official-launcher', 'minecraft-managed', 'minecraft-managed'],
  );

  const injected = defaultJavaRoots({ env: { HOME: '/home/tester' }, minecraftDir: '/data/minecraft' });
  assert.equal(injected.at(-1).path, '/data/minecraft/runtime');
  assert.equal(injected.filter((root) => root.source === 'minecraft-managed').length, 1);

  for (const root of roots) {
    assert.ok(!/Program Files|javaw|\.exe|AppData|jre\.bundle|Applications/i.test(root.path));
  }
});

test('findMinecraftJava refuses to run on non-Linux platforms', async () => {
  await assert.rejects(
    () => findMinecraftJava({ platform: 'win32', roots: [] }),
    (err) => {
      assert.ok(err instanceof ConfigError);
      assert.equal(err.code, 'UNSUPPORTED_PLATFORM');
      assert.equal(err.status, 500);
      assert.deepEqual(err.details, { platform: 'win32', supported: 'linux' });
      return true;
    },
  );
  await assert.rejects(
    () => findMinecraftJava({ platform: 'darwin', roots: [] }),
    (err) => err instanceof ConfigError && err.code === 'UNSUPPORTED_PLATFORM',
  );
  await assert.rejects(
    () => findMinecraftJava({ platform: 'freebsd', roots: [] }),
    (err) => err instanceof ConfigError && err.code === 'UNSUPPORTED_PLATFORM',
  );
});

test('findMinecraftJava fails cleanly when nothing is installed', async () => {
  const dir = tmpDir();
  try {
    await assert.rejects(
      () => findMinecraftJava({ roots: [path.join(dir, 'nothing')], env: {} }),
      (err) => {
        assert.ok(err instanceof JavaRuntimeError);
        assert.equal(err.code, 'JAVA_RUNTIME_NOT_FOUND');
        assert.equal(err.status, 404);
        assert.equal(err.details.roots.length, 1);
        assert.deepEqual(err.attempts, []);
        return true;
      },
    );
    await assert.rejects(
      () => findMinecraftJava({ roots: [] }),
      (err) => err instanceof JavaRuntimeError && err.code === 'JAVA_RUNTIME_NOT_FOUND',
    );
  } finally {
    cleanup(dir);
  }
});

test('findMinecraftJava prefers the official launcher runtime', async () => {
  const dir = tmpDir();
  try {
    const official = path.join(dir, 'official', 'runtime');
    const managed = path.join(dir, 'game', 'runtime');
    writeBinary(path.join(official, 'jre-x64', 'bin', BIN));
    writeBinary(path.join(managed, 'java-runtime-gamma', 'linux', 'java-runtime-gamma', 'bin', BIN));

    const probed = [];
    const result = await findMinecraftJava({
      roots: [
        { path: official, source: 'official-launcher' },
        { path: managed, source: 'minecraft-managed' },
      ],
      probe: async (binary) => {
        probed.push(binary);
        return openjdk17;
      },
    });

    assert.equal(result.source, 'official-launcher');
    assert.ok(result.path.startsWith(official));
    assert.equal(result.major, 17);
    assert.equal(result.root, official);
    assert.equal(result.component, 'jre-x64');
    assert.equal(probed.length, 1);
  } finally {
    cleanup(dir);
  }
});

test('findMinecraftJava falls back to the minecraft-managed runtime', async () => {
  const dir = tmpDir();
  try {
    const managed = path.join(dir, '.minecraft', 'runtime');
    const binary = writeBinary(
      path.join(managed, 'java-runtime-gamma', 'linux', 'java-runtime-gamma', 'bin', BIN),
    );

    const result = await findMinecraftJava({
      roots: [
        { path: path.join(dir, 'missing-launcher'), source: 'official-launcher' },
        { path: managed, source: 'minecraft-managed' },
      ],
      probe: () => openjdk17,
    });

    assert.equal(result.source, 'minecraft-managed');
    assert.equal(result.path, binary);
    assert.equal(result.component, 'java-runtime-gamma');
    assert.equal(result.major, 17);
  } finally {
    cleanup(dir);
  }
});

test('findMinecraftJava validates the Java major version', async () => {
  const dir = tmpDir();
  try {
    const root = path.join(dir, 'runtimes');
    const legacy = writeBinary(path.join(root, 'jre-legacy', 'bin', BIN));
    const gamma = writeBinary(path.join(root, 'java-runtime-gamma', 'bin', BIN));
    const probe = (binary) => (binary.startsWith(gamma) ? openjdk17 : legacy8);

    const matched = await findMinecraftJava({ roots: [root], probe, requiredMajor: 17 });
    assert.equal(matched.path, gamma);
    assert.equal(matched.major, 17);

    const legacyMatch = await findMinecraftJava({ roots: [root], probe, requiredMajor: 8 });
    assert.equal(legacyMatch.path, legacy);
    assert.equal(legacyMatch.major, 8);

    await assert.rejects(
      () => findMinecraftJava({ roots: [root], probe, requiredMajor: 21 }),
      (err) => {
        assert.ok(err instanceof JavaRuntimeError);
        assert.equal(err.code, 'JAVA_VERSION_MISMATCH');
        assert.equal(err.status, 409);
        assert.equal(err.details.requiredMajor, 21);
        assert.ok(err.attempts.every((attempt) => attempt.reason === 'major-mismatch'));
        assert.deepEqual(
          err.attempts.map((attempt) => attempt.major).sort((a, b) => a - b),
          [8, 17],
        );
        return true;
      },
    );
  } finally {
    cleanup(dir);
  }
});

test('findMinecraftJava prefers the requested runtime component', async () => {
  const dir = tmpDir();
  try {
    const root = path.join(dir, 'runtimes');
    const custom = writeBinary(path.join(root, 'custom-jvm', 'bin', BIN));
    const gamma = writeBinary(path.join(root, 'java-runtime-gamma', 'bin', BIN));
    const probe = () => openjdk17;

    const result = await findMinecraftJava({
      roots: [root],
      probe,
      requiredComponent: 'java-runtime-gamma',
    });
    assert.equal(result.path, gamma);
    assert.equal(result.component, 'java-runtime-gamma');

    const anyResult = await findMinecraftJava({ roots: [root], probe });
    assert.ok([custom, gamma].includes(anyResult.path));
  } finally {
    cleanup(dir);
  }
});

test('findMinecraftJava rejects non-executable and unparsable runtimes', async () => {
  const dir = tmpDir();
  try {
    const root = path.join(dir, 'runtimes');
    const broken = writeBinary(path.join(root, 'a-jvm', 'bin', BIN));
    fs.chmodSync(broken, 0o644);
    const garbage = writeBinary(path.join(root, 'b-jvm', 'bin', BIN));

    await assert.rejects(
      () => findMinecraftJava({ roots: [root], probe: () => 'not a java at all' }),
      (err) => {
        assert.equal(err.code, 'JAVA_RUNTIME_NOT_FOUND');
        const reasons = err.attempts.map((attempt) => attempt.reason);
        assert.ok(reasons.includes('not-executable'));
        assert.ok(reasons.includes('invalid-version'));
        const paths = err.attempts.map((attempt) => attempt.path);
        assert.ok(paths.includes(garbage));
        assert.ok(paths.includes(broken));
        return true;
      },
    );
  } finally {
    cleanup(dir);
  }
});

test('findMinecraftJava records probe failures', async () => {
  const dir = tmpDir();
  try {
    const root = path.join(dir, 'runtimes');
    writeBinary(path.join(root, 'jvm', 'bin', BIN));

    await assert.rejects(
      () =>
        findMinecraftJava({
          roots: [root],
          probe: () => {
            throw new Error('boom');
          },
        }),
      (err) => {
        assert.equal(err.code, 'JAVA_RUNTIME_NOT_FOUND');
        assert.equal(err.attempts.length, 1);
        assert.equal(err.attempts[0].reason, 'probe-failed');
        assert.equal(err.attempts[0].message, 'boom');
        return true;
      },
    );
  } finally {
    cleanup(dir);
  }
});

test('findMinecraftJava never falls back to system Java (JAVA_HOME / PATH)', async () => {
  const dir = tmpDir();
  try {
    const systemJdk = path.join(dir, 'system-jdk');
    writeBinary(path.join(systemJdk, 'bin', BIN));
    let probed = 0;

    await assert.rejects(
      () =>
        findMinecraftJava({
          roots: [path.join(dir, 'nothing')],
          env: {
            JAVA_HOME: systemJdk,
            PATH: `${path.join(systemJdk, 'bin')}${path.delimiter}${process.env.PATH ?? ''}`,
          },
          probe: () => {
            probed += 1;
            return openjdk17;
          },
        }),
      (err) => {
        assert.equal(err.code, 'JAVA_RUNTIME_NOT_FOUND');
        assert.deepEqual(err.attempts, []);
        return true;
      },
    );
    assert.equal(probed, 0);
  } finally {
    cleanup(dir);
  }
});

test('findMinecraftJava executes the runtime binary to read its version', async () => {
  const dir = tmpDir();
  try {
    const binary = writeScript(
      path.join(dir, 'jvm', 'bin', 'java'),
      '#!/bin/sh\necho \'openjdk version "17.0.8" 2023-07-18\' >&2\nexit 0\n',
    );

    const result = await findMinecraftJava({ roots: [dir] });
    assert.equal(result.path, binary);
    assert.equal(result.major, 17);
    assert.equal(result.version.raw, '17.0.8');
  } finally {
    cleanup(dir);
  }
});

test('findMinecraftJava survives symlink loops without hanging', async () => {
  const dir = tmpDir();
  try {
    fs.symlinkSync(dir, path.join(dir, 'loop'));
    let probed = 0;

    await assert.rejects(
      () =>
        findMinecraftJava({
          roots: [dir],
          probe: () => {
            probed += 1;
            return openjdk17;
          },
        }),
      (err) => err instanceof JavaRuntimeError && err.code === 'JAVA_RUNTIME_NOT_FOUND',
    );
    assert.equal(probed, 0);
  } finally {
    cleanup(dir);
  }
});

test('createJavaDetector binds defaults for repeated lookups', async () => {
  const dir = tmpDir();
  try {
    const root = path.join(dir, 'runtimes');
    writeBinary(path.join(root, 'java-runtime-delta', 'bin', BIN));
    const detector = createJavaDetector({ roots: [root], probe: () => 'openjdk version "21.0.1"' });

    const first = await detector.findMinecraftJava();
    assert.equal(first.major, 21);

    const second = await detector.findMinecraftJava({ requiredMajor: 21 });
    assert.equal(second.path, first.path);

    await assert.rejects(
      () => detector.findMinecraftJava({ requiredMajor: 17 }),
      (err) => err.code === 'JAVA_VERSION_MISMATCH',
    );
  } finally {
    cleanup(dir);
  }
});

test('findMinecraftJava validates its options', async () => {
  await assert.rejects(
    () => findMinecraftJava({ roots: 'nope' }),
    (err) => err instanceof ValidationError && err.code === 'INVALID_JAVA_ROOTS',
  );
  await assert.rejects(
    () => findMinecraftJava({ roots: [42] }),
    (err) => err instanceof ValidationError && err.code === 'INVALID_JAVA_ROOTS',
  );
  await assert.rejects(
    () => findMinecraftJava({ requiredMajor: 0 }),
    (err) => err instanceof ValidationError && err.code === 'INVALID_JAVA_MAJOR',
  );
  await assert.rejects(
    () => findMinecraftJava({ requiredMajor: 17.5 }),
    (err) => err instanceof ValidationError && err.code === 'INVALID_JAVA_MAJOR',
  );
});

test('live: default roots resolve on this machine', { skip: !process.env.TML_LIVE }, async () => {
  try {
    const result = await findMinecraftJava();
    assert.ok(result.major >= 8);
    assert.ok(['official-launcher', 'minecraft-managed'].includes(result.source));
    assert.equal(fs.existsSync(result.path), true);
  } catch (err) {
    assert.ok(err instanceof JavaRuntimeError);
    assert.equal(err.code, 'JAVA_RUNTIME_NOT_FOUND');
    assert.ok(err.details.roots.length > 0);
    assert.ok(err.details.roots.every((root) => root.startsWith('/')));
  }
});
