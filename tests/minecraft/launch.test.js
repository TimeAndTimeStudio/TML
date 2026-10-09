// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../src/core/config.js';
import { createMinecraftApi } from '../../src/minecraft/api.js';
import { NATIVES_MANIFEST, createInstaller } from '../../src/minecraft/install.js';
import {
  CLASSPATH_SEPARATOR,
  buildProcessEnv,
  createLauncher,
  createOfflineSession,
  offlineUuid,
  splitLegacyArguments,
} from '../../src/minecraft/launch.js';
import { CancelledError, JavaRuntimeError, LaunchError, ValidationError } from '../../src/core/errors.js';
import { hashBuffer } from '../../src/download/hash.js';

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tml-launch-'));
after(() => fs.rmSync(workDir, { recursive: true, force: true }));

function writeJavaScript(name, body) {
  const file = path.join(workDir, 'java-bin', name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\n${body}`);
  fs.chmodSync(file, 0o755);
  return file;
}

const ECHO_JAVA = writeJavaScript('echo-java', 'echo "args: $*"\necho "problem" >&2\nexit 7\n');
const ENV_JAVA = writeJavaScript(
  'env-java',
  'echo "wayland: ${WAYLAND_DISPLAY:-unset}"\necho "sdl: ${SDL_VIDEO_DRIVER:-unset}"\necho "session: ${XDG_SESSION_TYPE:-unset}"\necho "display: ${DISPLAY:-unset}"\nexit 0\n',
);
const SLEEP_JAVA = writeJavaScript('sleep-java', 'exec sleep 30\n');

const UUID_V3 = /^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sha1 = (data) => hashBuffer(Buffer.isBuffer(data) ? data : Buffer.from(data), ['sha1']).sha1;

const clientBytes = Buffer.from('launch client jar');
const coreBytes = Buffer.from('launch core bytes');
const bindingBytes = Buffer.from('launch binding bytes');
const loggingXml = Buffer.from('<?xml version="1.0"?><configuration/>');

function makeVersion(overrides = {}) {
  return {
    id: '1.99.9-launch',
    type: 'release',
    mainClass: 'net.minecraft.client.main.Main',
    assets: 'launch-assets',
    assetIndex: {
      id: 'launch-assets',
      sha1: 'a'.repeat(40),
      size: 10,
      totalSize: 20,
      url: 'https://piston-meta.mojang.com/v1/packages/a/launch.json',
    },
    javaVersion: { component: 'java-runtime-gamma', majorVersion: 17 },
    downloads: {
      client: {
        sha1: sha1(clientBytes),
        size: clientBytes.length,
        url: 'https://piston-data.mojang.com/v1/objects/x/client.jar',
      },
    },
    logging: {
      client: {
        file: {
          id: 'client-launch.xml',
          sha1: sha1(loggingXml),
          size: loggingXml.length,
          url: 'https://launcher.mojang.com/v1/objects/y/client-launch.xml',
        },
      },
    },
    arguments: {
      jvm: [
        '-Djava.library.path=${natives_directory}',
        '-Dminecraft.launcher.brand=${launcher_name}',
        '-Dminecraft.launcher.version=${launcher_version}',
        { rules: [{ action: 'allow', os: { name: 'osx' } }], value: ['-XstartOnFirstThread'] },
        {
          rules: [{ action: 'allow', os: { name: 'windows' } }],
          value: ['-XX:HeapDumpPath=MojangTricksIntelDriversForPerformance_javaw.exe.heapdump'],
        },
        '-cp',
        '${classpath}',
      ],
      game: [
        '--username',
        '${auth_player_name}',
        '--version',
        '${version_name}',
        '--gameDir',
        '${game_directory}',
        '--assetsDir',
        '${assets_root}',
        '--assetIndex',
        '${assets_index_name}',
        '--uuid',
        '${auth_uuid}',
        '--accessToken',
        '${auth_access_token}',
        '--userType',
        '${user_type}',
        '--versionType',
        '${version_type}',
        { rules: [{ action: 'allow', features: { is_demo_user: true } }], value: ['--demo'] },
        {
          rules: [{ action: 'allow', features: { has_custom_resolution: true } }],
          value: ['--width', '${resolution_width}', '--height', '${resolution_height}'],
        },
      ],
    },
    libraries: [
      {
        name: 'com.example:core:1.0.0',
        downloads: {
          artifact: {
            path: 'com/example/core/1.0.0/core-1.0.0.jar',
            sha1: sha1(coreBytes),
            size: coreBytes.length,
            url: 'https://libraries.minecraft.net/com/example/core/1.0.0/core-1.0.0.jar',
          },
        },
      },
      {
        name: 'org.lwjgl.lwjgl:lwjgl:2.9.4',
        natives: { linux: 'natives-linux' },
        extract: { exclude: ['META-INF/'] },
        downloads: {
          artifact: {
            path: 'org/lwjgl/lwjgl/lwjgl/2.9.4/lwjgl-2.9.4.jar',
            sha1: sha1(bindingBytes),
            size: bindingBytes.length,
            url: 'https://libraries.minecraft.net/org/lwjgl/lwjgl/lwjgl/2.9.4/lwjgl-2.9.4.jar',
          },
          classifiers: {
            'natives-linux': {
              path: 'org/lwjgl/lwjgl/lwjgl/2.9.4/lwjgl-2.9.4-natives-linux.jar',
              sha1: 'd'.repeat(40),
              size: 40,
              url: 'https://libraries.minecraft.net/org/lwjgl/lwjgl/lwjgl/2.9.4/lwjgl-2.9.4-natives-linux.jar',
            },
          },
        },
      },
    ],
    ...overrides,
  };
}

function materialize(installer, plan) {
  const write = (dest, data) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
  };
  write(plan.client.dest, clientBytes);
  for (const library of plan.libraries) write(library.dest, 'library');
  for (const native of plan.natives) write(native.jarDest, 'natives jar');
  if (plan.logging) write(plan.logging.dest, loggingXml);
  if (plan.natives.length > 0) {
    const dir = installer.layout.nativesDir(plan.id);
    fs.mkdirSync(dir, { recursive: true });
    write(path.join(dir, NATIVES_MANIFEST), JSON.stringify({ version: 1, versionId: plan.id, sources: [], files: 0 }));
  }
}

function makeLauncher(overrides = {}) {
  const cacheDir = fs.mkdtempSync(path.join(workDir, 'cache-'));
  const installer = createInstaller({ cacheDir });
  const seen = [];
  const javaPath = overrides.javaPath ?? ECHO_JAVA;
  const findMinecraftJava =
    overrides.findMinecraftJava ??
    (async (opts) => {
      seen.push(opts);
      return {
        path: javaPath,
        major: 17,
        version: { major: 17, raw: '17.0.8' },
        source: 'custom',
        root: path.dirname(javaPath),
        component: 'java-runtime-gamma',
      };
    });
  const launcher = createLauncher({
    config: overrides.config ?? null,
    installer,
    findMinecraftJava,
    javaRuntime: overrides.javaRuntime ?? null,
  });
  return { launcher, installer, seen };
}

test('buildLaunchPlan resolves modern jvm and game arguments', async () => {
  const { launcher, seen } = makeLauncher();
  const gameDir = path.join(workDir, 'game-modern');
  const version = makeVersion();

  const launchPlan = await launcher.buildLaunchPlan(version, { gameDir });
  const installPlan = launchPlan.plan;

  assert.equal(seen.length, 1);
  assert.equal(seen[0].requiredMajor, 17);
  assert.equal(seen[0].requiredComponent, 'java-runtime-gamma');
  assert.equal(fs.existsSync(gameDir), false, 'build must not create the game directory');

  assert.equal(launchPlan.id, '1.99.9-launch');
  assert.equal(launchPlan.mainClass, 'net.minecraft.client.main.Main');
  assert.equal(launchPlan.cwd, gameDir);
  assert.deepEqual(launchPlan.unresolved, []);

  assert.equal(launchPlan.classpath[0], installPlan.client.dest);
  assert.equal(launchPlan.classpath.length, 3);
  assert.equal(launchPlan.classpathString, launchPlan.classpath.join(CLASSPATH_SEPARATOR));
  assert.equal(CLASSPATH_SEPARATOR, ':');

  assert.ok(launchPlan.jvmArgs.includes(`-Djava.library.path=${launchPlan.nativesDir}`));
  assert.ok(launchPlan.jvmArgs.includes('-Dminecraft.launcher.brand=TML'));
  assert.equal(launchPlan.jvmArgs.includes('-XstartOnFirstThread'), false, 'osx-only jvm arg must be excluded');
  assert.equal(
    launchPlan.jvmArgs.some((arg) => arg.startsWith('-XX:HeapDumpPath')),
    false,
    'windows-only jvm arg must be excluded',
  );
  const cpIndex = launchPlan.jvmArgs.indexOf('-cp');
  assert.ok(cpIndex >= 0);
  assert.equal(launchPlan.jvmArgs[cpIndex + 1], launchPlan.classpathString);
  assert.ok(launchPlan.jvmArgs.includes(`-Dlog4j.configurationFile=${installPlan.logging.dest}`));

  const mainIndex = launchPlan.args.indexOf('net.minecraft.client.main.Main');
  assert.equal(mainIndex, launchPlan.jvmArgs.length);
  assert.deepEqual(launchPlan.args.slice(mainIndex + 1), launchPlan.gameArgs);

  assert.equal(launchPlan.gameArgs[launchPlan.gameArgs.indexOf('--username') + 1], 'Player');
  assert.equal(launchPlan.gameArgs[launchPlan.gameArgs.indexOf('--version') + 1], '1.99.9-launch');
  assert.equal(launchPlan.gameArgs[launchPlan.gameArgs.indexOf('--gameDir') + 1], gameDir);
  assert.equal(launchPlan.gameArgs[launchPlan.gameArgs.indexOf('--assetsDir') + 1], launchPlan.assetsRoot);
  assert.equal(launchPlan.gameArgs[launchPlan.gameArgs.indexOf('--assetIndex') + 1], 'launch-assets');
  assert.equal(launchPlan.gameArgs[launchPlan.gameArgs.indexOf('--userType') + 1], 'legacy');
  assert.equal(launchPlan.gameArgs[launchPlan.gameArgs.indexOf('--versionType') + 1], 'release');
  const uuid = launchPlan.gameArgs[launchPlan.gameArgs.indexOf('--uuid') + 1];
  assert.match(uuid, UUID_V3);
  assert.equal(launchPlan.gameArgs.includes('--demo'), false, 'demo arg needs the feature');
  assert.equal(launchPlan.gameArgs.includes('--width'), false, 'resolution args need the feature');
  assert.ok(launchPlan.args.every((arg) => !arg.includes('${')));
});

test('buildLaunchPlan appends custom extra jvm and game arguments', async () => {
  const { launcher } = makeLauncher();
  const gameDir = path.join(workDir, 'game-extra-args');
  const version = makeVersion();

  const launchPlan = await launcher.buildLaunchPlan(version, {
    gameDir,
    extraJvmArgs: ['-Dtml.custom=1', '-XX:+UseG1GC'],
    extraGameArgs: ['--tml-flag', 'value'],
  });

  assert.deepEqual(launchPlan.jvmArgs.slice(-2), ['-Dtml.custom=1', '-XX:+UseG1GC']);
  assert.deepEqual(launchPlan.gameArgs.slice(-2), ['--tml-flag', 'value']);
  const mainIndex = launchPlan.args.indexOf('net.minecraft.client.main.Main');
  assert.equal(mainIndex, launchPlan.jvmArgs.length, 'extra jvm args must stay before mainClass');
  assert.deepEqual(launchPlan.args.slice(mainIndex + 1), launchPlan.gameArgs);
  assert.ok(launchPlan.args.includes('-Dtml.custom=1'));
  assert.ok(launchPlan.args.includes('--tml-flag'));

  const plain = await launcher.buildLaunchPlan(makeVersion(), { gameDir });
  assert.equal(plain.jvmArgs.includes('-Dtml.custom=1'), false, 'no extras unless requested');
  assert.equal(plain.gameArgs.includes('--tml-flag'), false);
});

test('buildLaunchPlan falls back to default jvm args for legacy versions', async () => {
  const { launcher, seen } = makeLauncher();
  const gameDir = path.join(workDir, 'game-legacy');
  const version = makeVersion({
    arguments: null,
    minecraftArguments:
      '--username ${auth_player_name} --session ${auth_session} --gameDir "${game_directory}" --label "hello world" --props ${user_properties}',
    javaVersion: null,
    assetIndex: null,
    logging: null,
  });

  const launchPlan = await launcher.buildLaunchPlan(version, { gameDir });

  assert.equal(seen[0].requiredMajor, null);
  assert.equal(seen[0].requiredComponent, null);
  assert.deepEqual(launchPlan.unresolved, []);

  assert.ok(launchPlan.jvmArgs.includes(`-Djava.library.path=${launchPlan.nativesDir}`));
  assert.ok(launchPlan.jvmArgs.includes('-Dminecraft.launcher.brand=TML'));
  const cpIndex = launchPlan.jvmArgs.indexOf('-cp');
  assert.ok(cpIndex >= 0);
  assert.equal(launchPlan.jvmArgs[cpIndex + 1], launchPlan.classpathString);
  assert.equal(
    launchPlan.jvmArgs.some((arg) => arg.startsWith('-Dlog4j.configurationFile=')),
    false,
  );

  assert.equal(launchPlan.gameArgs[0], '--username');
  assert.equal(launchPlan.gameArgs[1], 'Player');
  assert.equal(launchPlan.gameArgs[launchPlan.gameArgs.indexOf('--gameDir') + 1], gameDir);
  assert.equal(launchPlan.gameArgs[launchPlan.gameArgs.indexOf('--label') + 1], 'hello world');
  assert.ok(launchPlan.gameArgs.includes('{}'));
  const session = launchPlan.gameArgs[launchPlan.gameArgs.indexOf('--session') + 1];
  assert.match(session, /:0$/);
  assert.ok(launchPlan.args.every((arg) => !arg.includes('${')));
});

test('buildLaunchPlan applies feature rules, resolution values and reports unresolved placeholders', async () => {
  const { launcher } = makeLauncher();
  const featureLib = {
    name: 'com.example:feature-lib:1.0',
    rules: [{ action: 'allow', features: { is_demo_user: true } }],
    downloads: {
      artifact: {
        path: 'com/example/feature-lib/1.0/feature-lib-1.0.jar',
        sha1: '1'.repeat(40),
        size: 5,
        url: 'https://libraries.minecraft.net/com/example/feature-lib/1.0/feature-lib-1.0.jar',
      },
    },
  };
  const version = makeVersion({ libraries: [...makeVersion().libraries, featureLib] });

  const plain = await launcher.buildLaunchPlan(version, { gameDir: path.join(workDir, 'game-plain') });
  assert.equal(
    plain.plan.libraries.some((library) => library.name === 'com.example:feature-lib:1.0'),
    false,
  );
  assert.equal(plain.gameArgs.includes('--demo'), false);

  const featured = await launcher.buildLaunchPlan(version, {
    gameDir: path.join(workDir, 'game-featured'),
    features: { is_demo_user: true, has_custom_resolution: true },
    resolution: { width: 1280, height: 720 },
  });
  assert.ok(featured.plan.libraries.some((library) => library.name === 'com.example:feature-lib:1.0'));
  assert.ok(featured.gameArgs.includes('--demo'));
  assert.equal(featured.gameArgs[featured.gameArgs.indexOf('--width') + 1], '1280');
  assert.equal(featured.gameArgs[featured.gameArgs.indexOf('--height') + 1], '720');
  assert.deepEqual(featured.unresolved, []);

  const noResolution = await launcher.buildLaunchPlan(version, {
    gameDir: path.join(workDir, 'game-nores'),
    features: { has_custom_resolution: true },
  });
  assert.equal(noResolution.gameArgs[noResolution.gameArgs.indexOf('--width') + 1], '');
  assert.ok(noResolution.unresolved.includes('resolution_width'));
  assert.ok(noResolution.unresolved.includes('resolution_height'));

  const unknown = await launcher.buildLaunchPlan(
    makeVersion({
      arguments: { jvm: [], game: ['--flag', '${totally_unknown}'] },
      minecraftArguments: null,
    }),
    { gameDir: path.join(workDir, 'game-unknown') },
  );
  assert.deepEqual(unknown.unresolved, ['totally_unknown']);
  assert.equal(unknown.gameArgs[unknown.gameArgs.indexOf('--flag') + 1], '');
});

test('createOfflineSession and offlineUuid produce vanilla-compatible offline accounts', () => {
  const session = createOfflineSession();
  assert.equal(session.username, 'Player');
  assert.match(session.uuid, UUID_V3);
  assert.match(session.accessToken, /^[0-9a-f-]{36}$/);
  assert.equal(session.userType, 'legacy');
  assert.equal(session.clientId, '');
  assert.equal(session.xuid, '');
  assert.equal(Object.isFrozen(session), true);

  const steve = createOfflineSession({ username: 'Steve' });
  assert.equal(steve.uuid, offlineUuid('Steve'));
  assert.notEqual(steve.uuid, session.uuid);
  assert.equal(createOfflineSession({ username: 'Steve' }).uuid, steve.uuid);

  const custom = createOfflineSession({ username: 'Alex', uuid: 'custom-uuid', accessToken: 'tok' });
  assert.equal(custom.uuid, 'custom-uuid');
  assert.equal(custom.accessToken, 'tok');

  const digest = createHash('md5').update('OfflinePlayer:Player', 'utf8').digest();
  digest[6] = (digest[6] & 0x0f) | 0x30;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.toString('hex');
  const expected = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  assert.equal(offlineUuid('Player'), expected);
});

test('splitLegacyArguments honors double quotes', () => {
  assert.deepEqual(splitLegacyArguments('--a b --c "hello world" x"y z"w'), ['--a', 'b', '--c', 'hello world', 'xy zw']);
  assert.deepEqual(splitLegacyArguments('  a \t b '), ['a', 'b']);
  assert.deepEqual(splitLegacyArguments(''), []);
  assert.deepEqual(splitLegacyArguments(null), []);
  assert.deepEqual(splitLegacyArguments('unclosed "quote end'), ['unclosed', 'quote end']);
});

test('launch refuses to start while install files are missing', async () => {
  const { launcher, installer } = makeLauncher();
  const version = makeVersion();
  const gameDir = path.join(workDir, 'game-missing');

  await assert.rejects(
    () => launcher.launch(version, { gameDir }),
    (err) => {
      assert.ok(err instanceof LaunchError);
      assert.equal(err.code, 'MINECRAFT_NOT_INSTALLED');
      assert.equal(err.status, 409);
      assert.equal(err.expose, true);
      assert.equal(err.stage, 'preflight');
      assert.ok(err.missing.length >= 1);
      assert.ok(err.missing[0].endsWith('client.jar'));
      assert.equal(err.details.count, err.missing.length);
      return true;
    },
  );

  const plan = await installer.plan(version);
  materialize(installer, plan);
  fs.rmSync(path.join(installer.layout.nativesDir(plan.id), NATIVES_MANIFEST));

  await assert.rejects(
    () => launcher.launch(version, { gameDir }),
    (err) => {
      assert.equal(err.code, 'MINECRAFT_NOT_INSTALLED');
      assert.equal(err.missing.length, 1);
      assert.ok(err.missing[0].endsWith(NATIVES_MANIFEST));
      return true;
    },
  );
});

test('launch spawns java directly, captures output and creates the game directory', async () => {
  const { launcher, installer } = makeLauncher();
  const version = makeVersion();
  const gameDir = path.join(workDir, 'game-spawn');
  materialize(installer, await installer.plan(version));

  const lines = [];
  const handle = await launcher.launch(version, {
    gameDir,
    onOutput: (line, stream) => lines.push([stream, line]),
  });

  assert.ok(Number.isInteger(handle.pid) && handle.pid > 0);
  assert.equal(handle.cwd, gameDir);
  assert.equal(handle.java, ECHO_JAVA);
  assert.equal(fs.existsSync(gameDir), true);
  assert.equal(fs.existsSync(handle.launchPlan.nativesDir), true);
  assert.ok(handle.args.includes('net.minecraft.client.main.Main'));

  const result = await handle.exited;
  assert.equal(result.code, 7);
  assert.equal(result.signal, null);
  assert.equal(result.error, null);

  const stdout = handle.output.stdout.join('\n');
  assert.ok(stdout.includes('args: '));
  assert.ok(stdout.includes('-Djava.library.path='));
  assert.ok(handle.output.stderr.join('\n').includes('problem'));
  assert.ok(lines.some(([stream]) => stream === 'stdout'));
  assert.ok(lines.some(([stream]) => stream === 'stderr'));
  assert.ok(lines.every(([, line]) => typeof line === 'string'));
  assert.ok(lines.length > 0);
});

test('buildProcessEnv keeps the environment for auto and forces Wayland for wayland', () => {
  const base = {
    WAYLAND_DISPLAY: 'wayland-0',
    WAYLAND_SOCKET: '3',
    DISPLAY: ':0',
    XDG_SESSION_TYPE: 'wayland',
    HOME: '/home/player',
  };

  const auto = buildProcessEnv(undefined, base, { CUSTOM: '1' });
  assert.equal(auto.WAYLAND_DISPLAY, 'wayland-0');
  assert.equal(auto.DISPLAY, ':0');
  assert.equal(auto.CUSTOM, '1');
  assert.equal('SDL_VIDEO_DRIVER' in auto, false, 'auto must not force a video driver');
  assert.equal(auto.XDG_SESSION_TYPE, 'wayland');

  const wayland = buildProcessEnv('wayland', base, { CUSTOM: '1' });
  assert.equal('DISPLAY' in wayland, false, 'wayland only must cut off the X11/XWayland path');
  assert.equal(wayland.WAYLAND_DISPLAY, 'wayland-0');
  assert.equal(wayland.CUSTOM, '1');
  assert.equal(wayland.SDL_VIDEO_DRIVER, 'wayland', 'SDL_VIDEO_DRIVER is the override SDL itself documents');
  assert.equal(wayland.SDL_VIDEODRIVER, 'wayland');
  assert.equal(wayland.XDG_SESSION_TYPE, 'wayland');
});

test('launch spawns java with Wayland variables only when the window platform allows it', async () => {
  const { launcher, installer } = makeLauncher({ javaPath: ENV_JAVA });
  const version = makeVersion();
  materialize(installer, await installer.plan(version));
  const waylandSession = { WAYLAND_DISPLAY: 'wayland-0', XDG_SESSION_TYPE: 'wayland', DISPLAY: ':99' };

  const kept = await launcher.launch(version, {
    gameDir: path.join(workDir, 'game-env-auto'),
    env: waylandSession,
  });
  assert.equal((await kept.exited).code, 0);
  const keptOut = kept.output.stdout.join('\n');
  assert.ok(keptOut.includes('wayland: wayland-0'));
  assert.ok(keptOut.includes('session: wayland'));
  assert.ok(keptOut.includes('display: :99'), 'auto must keep the session DISPLAY');
  assert.ok(!keptOut.includes('sdl: x11'), 'auto must never force the SDL video driver');

  const forced = await launcher.launch(version, {
    gameDir: path.join(workDir, 'game-env-wayland'),
    windowPlatform: 'wayland',
    env: waylandSession,
  });
  assert.equal((await forced.exited).code, 0);
  const forcedOut = forced.output.stdout.join('\n');
  assert.ok(
    forcedOut.includes('display: unset'),
    'windowPlatform wayland must remove DISPLAY so the game cannot fall back to X11/XWayland',
  );
  assert.ok(
    forcedOut.includes('sdl: wayland'),
    'wayland must set SDL_VIDEO_DRIVER — SDL probes x11 as a fallback otherwise',
  );
  assert.ok(forcedOut.includes('session: wayland'));
  assert.ok(forcedOut.includes('wayland: wayland-0'), 'wayland must keep the Wayland connection');
});

test('launch never interprets arguments through a shell', async () => {
  const { launcher, installer } = makeLauncher();
  const version = makeVersion();
  const gameDir = path.join(workDir, 'game-shell');
  const pwnFile = path.join(workDir, 'pwned');
  const username = `bad; touch ${pwnFile}`;
  materialize(installer, await installer.plan(version));

  const handle = await launcher.launch(version, { gameDir, auth: { username } });
  assert.equal(handle.launchPlan.auth.username, username);
  assert.ok(handle.args.includes(username));

  const result = await handle.exited;
  assert.equal(result.code, 7);
  assert.equal(fs.existsSync(pwnFile), false, 'the metacharacter username must never be executed');
});

test('launch defaults to instances/preview and creates the game directory', async () => {
  const instancesDir = path.join(workDir, 'instances');
  const { launcher, installer } = makeLauncher({ config: { version: '9.9.9', paths: { instancesDir } } });
  const version = makeVersion();
  materialize(installer, await installer.plan(version));

  const launchPlan = await launcher.buildLaunchPlan(version);
  assert.equal(launchPlan.cwd, path.join(instancesDir, 'preview'));

  const handle = await launcher.launch(version);
  assert.equal(handle.cwd, path.join(instancesDir, 'preview'));
  assert.equal(fs.existsSync(handle.cwd), true);
  assert.ok(handle.args.includes('-Dminecraft.launcher.version=9.9.9'));

  const result = await handle.exited;
  assert.equal(result.code, 7);
});

test('launch can be cancelled before spawn', async () => {
  const { launcher } = makeLauncher();
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => launcher.launch(makeVersion(), { gameDir: path.join(workDir, 'game-cancel'), signal: controller.signal }),
    (err) => err instanceof CancelledError && err.code === 'CANCELLED',
  );
});

test('kill() terminates a running game process', async () => {
  const { launcher, installer } = makeLauncher({ javaPath: SLEEP_JAVA });
  const version = makeVersion();
  materialize(installer, await installer.plan(version));

  const handle = await launcher.launch(version, { gameDir: path.join(workDir, 'game-sleep') });
  assert.equal(handle.kill('SIGTERM'), true);

  const result = await handle.exited;
  assert.equal(result.signal, 'SIGTERM');
  assert.equal(result.code, null);
});

test('createLauncher validates its options', async () => {
  assert.throws(
    () => createLauncher({}),
    (err) => err instanceof ValidationError && err.code === 'NO_INSTALLER',
  );
  assert.throws(
    () => createLauncher({ installer: { plan: 1, layout: {} } }),
    (err) => err instanceof ValidationError && err.code === 'NO_INSTALLER',
  );

  const installer = createInstaller({ cacheDir: fs.mkdtempSync(path.join(workDir, 'cache-validate-')) });
  assert.throws(
    () => createLauncher({ installer, findMinecraftJava: 42 }),
    (err) => err instanceof ValidationError && err.code === 'INVALID_JAVA_FINDER',
  );

  const { launcher } = makeLauncher();
  await assert.rejects(
    () => launcher.buildLaunchPlan(makeVersion()),
    (err) => err instanceof ValidationError && err.code === 'INVALID_GAME_DIR',
  );
  await assert.rejects(
    () => launcher.buildLaunchPlan(makeVersion(), { gameDir: '   ' }),
    (err) => err instanceof ValidationError && err.code === 'INVALID_GAME_DIR',
  );
  await assert.rejects(
    () => launcher.buildLaunchPlan(makeVersion(), { gameDir: path.join(workDir, 'g'), auth: 'nope' }),
    (err) => err instanceof ValidationError && err.code === 'INVALID_AUTH',
  );
});

test('runtime lookup failures surface unchanged', async () => {
  const { launcher } = makeLauncher({
    findMinecraftJava: async () => {
      throw new JavaRuntimeError('Official Minecraft Java runtime not found', {
        details: { roots: ['/home/x/.minecraft/runtime'], attempts: [] },
      });
    },
  });

  await assert.rejects(
    () => launcher.buildLaunchPlan(makeVersion(), { gameDir: path.join(workDir, 'game-nojava') }),
    (err) => {
      assert.ok(err instanceof JavaRuntimeError);
      assert.equal(err.code, 'JAVA_RUNTIME_NOT_FOUND');
      return true;
    },
  );

  const relative = makeLauncher({ javaPath: 'java' });
  await assert.rejects(
    () => relative.launcher.buildLaunchPlan(makeVersion(), { gameDir: path.join(workDir, 'game-reljava') }),
    (err) => {
      assert.ok(err instanceof LaunchError);
      assert.equal(err.code, 'LAUNCH_FAILED');
      assert.equal(err.stage, 'java');
      return true;
    },
  );
});

test('a missing java runtime is downloaded from Microsoft before the plan is built', async () => {
  let missing = true;
  const javaRuntime = {
    ensureCalls: [],
    async ensure(opts) {
      this.ensureCalls.push(opts);
      missing = false;
      return { name: 'java-runtime-gamma', cached: false };
    },
  };
  const seen = [];
  const { launcher } = makeLauncher({
    javaRuntime,
    findMinecraftJava: async (opts) => {
      seen.push(opts);
      if (missing) {
        throw new JavaRuntimeError('Official Minecraft Java runtime not found', {
          code: 'JAVA_RUNTIME_NOT_FOUND',
          details: { attempts: [] },
        });
      }
      return {
        path: ECHO_JAVA,
        major: 17,
        version: { major: 17, raw: '17.0.8' },
        source: 'tml-managed',
        root: path.dirname(ECHO_JAVA),
        component: 'java-runtime-gamma',
      };
    },
  });

  const progress = [];
  const plan = await launcher.buildLaunchPlan(makeVersion(), {
    gameDir: path.join(workDir, 'game-autodl'),
    onProgress: (info) => progress.push(info),
  });

  assert.equal(seen.length, 2, 'the finder runs once before and once after the download');
  assert.equal(seen[0].requiredMajor, 17);
  assert.equal(seen[0].requiredComponent, 'java-runtime-gamma');
  assert.equal(javaRuntime.ensureCalls.length, 1);
  assert.equal(javaRuntime.ensureCalls[0].requiredMajor, 17);
  assert.equal(javaRuntime.ensureCalls[0].requiredComponent, 'java-runtime-gamma');
  assert.equal(typeof javaRuntime.ensureCalls[0].onProgress, 'function', 'download progress flows into opts.onProgress');
  javaRuntime.ensureCalls[0].onProgress({ stage: 'java', loaded: 5, total: 10, percent: 50 });
  assert.deepEqual(progress.at(-1), { stage: 'java', loaded: 5, total: 10, percent: 50 });
  assert.equal(plan.java.path, ECHO_JAVA);

  missing = false;
  const cached = await launcher.buildLaunchPlan(makeVersion(), { gameDir: path.join(workDir, 'game-autodl-2') });
  assert.equal(cached.java.path, ECHO_JAVA);
  assert.equal(javaRuntime.ensureCalls.length, 1, 'a working finder never triggers a download');
});

test('java auto-download only reacts to JavaRuntimeError and surfaces download failures', async () => {
  const installer = createInstaller({ cacheDir: fs.mkdtempSync(path.join(workDir, 'cache-jdl-')) });
  const notFound = () => {
    throw new JavaRuntimeError('missing', { code: 'JAVA_RUNTIME_NOT_FOUND', details: {} });
  };

  const none = createLauncher({ installer, findMinecraftJava: notFound });
  await assert.rejects(
    () => none.buildLaunchPlan(makeVersion(), { gameDir: path.join(workDir, 'g-noruntime') }),
    { code: 'JAVA_RUNTIME_NOT_FOUND' },
  );

  const failing = createLauncher({
    installer,
    findMinecraftJava: notFound,
    javaRuntime: {
      async ensure() {
        throw new JavaRuntimeError('no runtime matches', { code: 'JAVA_RUNTIME_UNAVAILABLE', status: 409 });
      },
    },
  });
  await assert.rejects(
    () => failing.buildLaunchPlan(makeVersion(), { gameDir: path.join(workDir, 'g-dlfail') }),
    { code: 'JAVA_RUNTIME_UNAVAILABLE', status: 409 },
  );

  const spy = {
    calls: 0,
    async ensure() {
      this.calls += 1;
    },
  };
  const other = createLauncher({
    installer,
    javaRuntime: spy,
    findMinecraftJava: async () => {
      throw new LaunchError('something else broke', { code: 'LAUNCH_FAILED' });
    },
  });
  await assert.rejects(
    () => other.buildLaunchPlan(makeVersion(), { gameDir: path.join(workDir, 'g-other') }),
    { code: 'LAUNCH_FAILED' },
  );
  assert.equal(spy.calls, 0, 'non-JavaRuntimeError failures never trigger a download');

  assert.throws(
    () => createLauncher({ installer, javaRuntime: { nope: true } }),
    (err) => err instanceof ValidationError && err.code === 'INVALID_JAVA_RUNTIME',
  );
});

test('live: builds a real launch plan for 1.12.2', { skip: !process.env.TML_LIVE }, async () => {
  const config = loadConfig();
  const minecraft = createMinecraftApi({ config });
  const installer = createInstaller({ config, minecraft });
  const launcher = createLauncher({
    config,
    installer,
    findMinecraftJava: async (opts) => {
      assert.equal(opts.requiredMajor, 8);
      assert.equal(opts.requiredComponent, 'jre-legacy');
      return {
        path: '/usr/share/minecraft-launcher/runtime/jre-legacy/linux-x64/jre-legacy/bin/java',
        major: 8,
        version: { major: 8, raw: '1.8.0_51' },
        source: 'official-launcher',
        root: '/usr/share/minecraft-launcher/runtime',
        component: 'jre-legacy',
      };
    },
  });

  const gameDir = path.join(workDir, 'live-game');
  const launchPlan = await launcher.buildLaunchPlan('1.12.2', { gameDir });

  assert.equal(launchPlan.id, '1.12.2');
  assert.equal(launchPlan.mainClass, 'net.minecraft.client.main.Main');
  assert.equal(launchPlan.cwd, gameDir);
  assert.ok(launchPlan.classpath.length > 30);
  assert.ok(launchPlan.classpath[0].endsWith('client.jar'));
  assert.ok(launchPlan.jvmArgs.includes('-cp'));
  assert.ok(launchPlan.jvmArgs.some((arg) => arg.startsWith('-Djava.library.path=')));
  assert.ok(launchPlan.jvmArgs.some((arg) => arg.startsWith('-Dlog4j.configurationFile=')));
  assert.equal(launchPlan.jvmArgs.includes('-XstartOnFirstThread'), false);
  assert.ok(launchPlan.gameArgs.includes('--username'));
  assert.equal(launchPlan.gameArgs[launchPlan.gameArgs.indexOf('--username') + 1], 'Player');
  assert.match(launchPlan.gameArgs[launchPlan.gameArgs.indexOf('--uuid') + 1], UUID_V3);
  assert.deepEqual(launchPlan.unresolved, []);
  assert.ok(launchPlan.args.every((arg) => !arg.includes('${')));
  assert.equal(fs.existsSync(gameDir), false);
});
