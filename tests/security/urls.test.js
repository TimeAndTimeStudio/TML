// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_OFFICIAL_HOSTS,
  OFFICIAL_SOURCES,
  inferSource,
  isAllowedHost,
  isAllowedUrl,
  isKnownSource,
  listSources,
  validateUrl,
} from '../../src/security/urls.js';
import { SourceNotAllowedError, ValidationError } from '../../src/core/errors.js';

test('official Minecraft / Mojang hosts are allowed', () => {
  const urls = [
    'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
    'https://launchermeta.mojang.com/1.20.1/client.json',
    'https://piston-data.mojang.com/v1/objects/abc/client.jar',
    'https://libraries.minecraft.net/net/minecraft/client.jar',
    'https://resources.download.minecraft.net/ab/abcdef.jar',
  ];

  for (const url of urls) {
    assert.equal(validateUrl(url).hostname, new URL(url).hostname);
    assert.equal(isAllowedUrl(url, { source: 'minecraft' }), true);
  }
});

test('official Fabric hosts are allowed', () => {
  const urls = [
    'https://meta.fabricmc.net/v2/versions/loader',
    'https://maven.fabricmc.net/net/fabricmc/fabric-loader/maven-metadata.xml',
  ];

  for (const url of urls) {
    assert.equal(isAllowedUrl(url, { source: 'fabric' }), true);
  }
});

test('official Modrinth hosts are allowed', () => {
  const urls = [
    'https://api.modrinth.com/v2/search?query=sodium',
    'https://cdn.modrinth.com/data/AAAA/versions/1.0.0/mod.jar',
  ];

  for (const url of urls) {
    assert.equal(isAllowedUrl(url, { source: 'modrinth' }), true);
  }
});

test('third-party mirrors are rejected', () => {
  const mirrors = [
    'https://mirror.example.com/minecraft/1.20.1/client.jar',
    'http://mc-mirror.ru/minecraft.jar',
    'https://github.com/Example/releases/download/v1/mod.jar',
    'https://raw.githubusercontent.com/Example/repo/main/mod.jar',
    'https://mediafire.com/file/abc/mod.jar',
    'http://93.184.216.34/piston-data.jar',
    'https://objects.githubusercontent.com/abc/file',
    'https://drive.google.com/uc?id=abc',
    'https://bitbucket.org/Example/repo/downloads/mod.jar',
  ];

  for (const url of mirrors) {
    assert.throws(() => validateUrl(url), SourceNotAllowedError, `expected rejection: ${url}`);
    assert.equal(isAllowedUrl(url), false);
  }
});

test('a category only accepts its own hosts', () => {
  assert.throws(
    () => validateUrl('https://cdn.modrinth.com/data/x/mod.jar', { source: 'minecraft' }),
    SourceNotAllowedError
  );
  assert.throws(
    () => validateUrl('https://piston-data.mojang.com/client.jar', { source: 'modrinth' }),
    SourceNotAllowedError
  );
  assert.throws(
    () => validateUrl('https://maven.fabricmc.net/loader.jar', { source: 'minecraft' }),
    SourceNotAllowedError
  );
  assert.equal(isAllowedUrl('https://maven.fabricmc.net/loader.jar', { source: 'fabric' }), true);
});

test('trick hosts and lookalike domains are rejected', () => {
  const tricks = [
    'https://launchermeta.mojang.com.evil.com/version.json',
    'https://evillaunchermeta.mojang.com/version.json',
    'https://launchermeta.mojang.com@evil.com/version.json',
    'https://login.live.com.evil.tld/authorize',
    'https://api.modrinth.com.malware.net/v2/project',
    'https://modrinth.com.attacker.example/',
  ];

  for (const url of tricks) {
    assert.throws(() => validateUrl(url), SourceNotAllowedError, `expected rejection: ${url}`);
  }

  assert.equal(isAllowedUrl('https://xn--pypi-yua.example/mod.jar'), false);
});

test('protocol, port and credential rules are enforced', () => {
  assert.throws(() => validateUrl('file:///etc/passwd'), SourceNotAllowedError);
  assert.throws(() => validateUrl('ftp://piston-meta.mojang.com/file'), SourceNotAllowedError);
  assert.throws(() => validateUrl('javascript:alert(1)'), (err) => err instanceof ValidationError || err instanceof SourceNotAllowedError);
  assert.throws(() => validateUrl('http://api.modrinth.com/v2/search'), SourceNotAllowedError, 'plain HTTP is rejected everywhere');
  assert.throws(() => validateUrl('http://libraries.minecraft.net/client.jar'), SourceNotAllowedError, 'even on an allowed host');
  assert.throws(() => validateUrl('https://api.modrinth.com:8443/v2/search'), SourceNotAllowedError);
  assert.throws(() => validateUrl('https://api.modrinth.com:80/v2/search'), SourceNotAllowedError, 'only port 443 is accepted');
  assert.throws(() => validateUrl('https://user:pass@api.modrinth.com/v2/search'), SourceNotAllowedError);
  assert.equal(isAllowedUrl('https://api.modrinth.com/v2/search'), true);
  assert.equal(isAllowedUrl('https://api.modrinth.com:443/v2/search'), true, 'the explicit default TLS port is fine');
  assert.equal(isAllowedUrl('http://api.modrinth.com/v2/search'), false);
});

test('malformed input and unknown source ids fail loudly', () => {
  assert.throws(() => validateUrl('not a url'), (err) => err.code === 'INVALID_URL');
  assert.throws(() => validateUrl(null), (err) => err.code === 'INVALID_URL');
  assert.throws(() => validateUrl('https://api.modrinth.com/x', { source: 'forge' }), (err) => err.code === 'UNKNOWN_SOURCE');
  assert.equal(isKnownSource('minecraft'), true);
  assert.equal(isKnownSource('forge'), false);
});

test('error messages never leak the full URL', () => {
  try {
    validateUrl('https://mirror.example.com/download?access_token=super-secret');
    assert.fail('expected rejection');
  } catch (err) {
    assert.equal(err.code, 'URL_NOT_ALLOWED');
    assert.equal(err.status, 403);
    assert.ok(!err.message.includes('super-secret'));
    assert.ok(!JSON.stringify(err.toJSON()).includes('super-secret'));
  }
});

test('host comparison is normalized', () => {
  assert.equal(validateUrl('HTTPS://API.MODRINTH.COM/v2/search').hostname, 'api.modrinth.com');
  assert.equal(isAllowedHost('Api.Modrinth.Com', 'modrinth'), true);
  assert.equal(isAllowedHost('api.modrinth.com.', 'modrinth'), true);
  assert.equal(isAllowedHost('api.modrinth.com', 'fabric'), false);
});

test('sources are exported as a frozen allowlist', () => {
  const sources = listSources();
  assert.equal(sources.length, Object.keys(OFFICIAL_SOURCES).length);
  for (const source of sources) {
    assert.ok(source.id);
    assert.ok(source.label);
    assert.ok(Array.isArray(source.hosts) && source.hosts.length > 0);
    for (const host of source.hosts) assert.ok(ALL_OFFICIAL_HOSTS.includes(host));
  }
  assert.ok(Object.isFrozen(OFFICIAL_SOURCES));
  assert.ok(Object.isFrozen(OFFICIAL_SOURCES.minecraft.hosts));
});

test('hosts the launcher never fetches are no longer allowed', () => {
  const removed = [
    'https://textures.minecraft.net/texture/abc', // preview สกินอ่านจาก cache บนเครื่อง — ไม่ยิงไปโหลดจาก CDN
    'https://sessionserver.mojang.com/session/minecraft/hasJoined',
    'https://api.mojang.com/player',
    'https://authserver.mojang.com/authenticate',
    'https://www.mojang.com/',
    'https://mojang.com/',
    'https://www.minecraft.net/',
    'https://minecraft.net/',
    'https://help.mojang.com/',
    'https://launcher.mojangusercontent.com/x',
    'https://www.fabricmc.net/',
    'https://fabricmc.net/',
    'https://media.modrinth.com/x.png',
    'https://static.modrinth.com/x.png',
    'https://www.modrinth.com/',
    'https://modrinth.com/',
    'https://account.live.com/',
    'https://xbox.auth.xboxlive.com/',
  ];

  for (const url of removed) {
    assert.equal(isAllowedUrl(url), false, `expected rejection: ${url}`);
    assert.equal(inferSource(url), null, `expected no source: ${url}`);
  }

  // ที่ยังใช้จริงต้องผ่านเหมือนเดิม
  assert.equal(isAllowedUrl('https://launchermeta.mojang.com/1.20.1/client.json'), true);
  assert.equal(isAllowedUrl('https://launcher.mojang.com/v1/objects/x/logs/client.xml'), true);
  assert.equal(isAllowedUrl('https://piston-data.mojang.com/v1/objects/abc/client.jar'), true);
});

test('inferSource maps official urls back to their source id', () => {
  assert.equal(inferSource('https://piston-meta.mojang.com/v2/version_manifest.json'), 'minecraft');
  assert.equal(inferSource('https://libraries.minecraft.net/net/minecraft/client.jar'), 'minecraft');
  assert.equal(inferSource('https://resources.download.minecraft.net/ab/abcdef.jar'), 'minecraft');
  assert.equal(inferSource('https://maven.fabricmc.net/net/fabricmc/fabric-loader/0.15.7/fabric-loader-0.15.7.jar'), 'fabric');
  assert.equal(inferSource('https://meta.fabricmc.net/v2/versions/loader'), 'fabric');
  assert.equal(inferSource('https://cdn.modrinth.com/data/abc/mod.jar'), 'modrinth');
  assert.equal(inferSource('https://login.microsoftonline.com/consumers/oauth2/v2.0/token'), 'microsoft');
  assert.equal(inferSource('https://evil.example.com/mod.jar'), null);
  assert.equal(inferSource('not a url'), null);
  assert.equal(inferSource(undefined), null);
});
