// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createSkinService,
  validateSkinImage,
  readPngSize,
  buildSkinMultipart,
  SKIN_UPLOAD_URL,
  SKIN_RESET_URL,
  SKIN_MAX_BYTES,
} from '../../src/minecraft/skin.js';
import { validateUrl } from '../../src/security/urls.js';

const TOKEN = 'mc-access-token-secret';

// PNG ปลอมที่พอให้ validation อ่าน IHDR ได้ (ไม่ต้องเป็น image จริง)
function fakePng(width = 64, height = 64, { withIhdr = true, extraBytes = 0 } = {}) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  if (withIhdr) {
    ihdr.write('IHDR', 0, 'ascii');
    ihdr.writeUInt32BE(width, 4);
    ihdr.writeUInt32BE(height, 8);
  }
  const length = Buffer.alloc(4);
  length.writeUInt32BE(13, 0);
  const body = Buffer.concat([signature, length, ihdr, Buffer.alloc(8)]);
  return extraBytes > 0 ? Buffer.concat([body, Buffer.alloc(extraBytes)]) : body;
}

function createFakeHttp(responses) {
  const calls = [];
  const queue = [...responses];
  return {
    calls,
    async request(url, opts = {}) {
      calls.push({ url: String(url), ...opts });
      const next = queue.shift();
      if (next === undefined) throw new Error(`Unexpected request: ${opts.method} ${url}`);
      return { status: next.status ?? 200, body: Buffer.from(next.body ?? '', 'utf8') };
    },
  };
}

test('the skin endpoints are on the minecraft source allowlist', () => {
  validateUrl(SKIN_UPLOAD_URL, 'microsoft');
  validateUrl(SKIN_RESET_URL, 'microsoft');
});

test('readPngSize reads the IHDR width and height', () => {
  assert.deepEqual(readPngSize(fakePng(64, 32)), { width: 64, height: 32 });
  assert.equal(readPngSize(Buffer.from('not a png at all............')), null);
  assert.equal(readPngSize(Buffer.from([0x89, 0x50])), null, 'too short');
});

test('validateSkinImage accepts real skin sizes and rejects everything else', () => {
  const png64 = fakePng(64, 64);
  assert.deepEqual(validateSkinImage(png64), png64, 'a valid image passes through unchanged');
  validateSkinImage(fakePng(64, 32));

  const cases = [
    [undefined, 'missing image'],
    [Buffer.alloc(0), 'empty'],
    [Buffer.from('hello'), 'not a buffer'],
    [Buffer.from('GIF89a not a png........'), 'wrong format'],
    [fakePng(32, 32), 'wrong size'],
    [fakePng(128, 128), 'wrong size'],
    [fakePng(64, 64, { withIhdr: false }), 'missing IHDR'],
    [fakePng(64, 64, { extraBytes: SKIN_MAX_BYTES }), 'too large'],
  ];
  for (const [value, why] of cases) {
    assert.throws(
      () => validateSkinImage(value),
      (err) => err.code === 'INVALID_SKIN' && err.status === 400,
      `expected INVALID_SKIN for ${why}`,
    );
  }
});

test('buildSkinMultipart frames the variant and the PNG file', () => {
  const png = fakePng();
  const { body, contentType } = buildSkinMultipart({ variant: 'slim', data: png, filename: 'my skin.png' });

  assert.match(contentType, /^multipart\/form-data; boundary=/);
  const boundary = contentType.split('boundary=')[1];
  const text = body.toString('latin1');
  assert.ok(text.includes(`name="variant"\r\n\r\nslim\r\n`), 'variant field present');
  assert.ok(text.includes('filename="myskin.png"'), 'filename is sanitized (spaces dropped)');
  assert.ok(text.startsWith(`--${boundary}\r\n`));
  assert.ok(text.endsWith(`--${boundary}--\r\n`));
  assert.ok(body.includes(png), 'the raw PNG bytes ride between the multipart headers');
});

test('buildSkinMultipart neutralizes header injection in the filename', () => {
  const { body } = buildSkinMultipart({
    variant: 'classic',
    data: fakePng(),
    filename: 'evil\r\ncontent-type: text/html\r\n\r\n.png',
  });
  const text = body.toString('latin1');
  assert.equal(text.split('content-type:').length, 2, 'only one content-type header (for the file)');
  assert.ok(!text.includes('\r\ncontent-type: text/html'), 'CRLF injection stripped');
});

test('upload sends a POST with the bearer token and multipart body', async () => {
  const http = createFakeHttp([{ status: 200, body: '{"status":"SUCCESS"}' }]);
  const skin = createSkinService({ http });
  const png = fakePng();

  const result = await skin.upload({ token: TOKEN, data: png, variant: 'classic', filename: 'skin.png' });

  assert.equal(result.changed, true);
  assert.equal(result.variant, 'classic');

  const call = http.calls[0];
  assert.equal(call.method, 'POST');
  assert.equal(call.url, SKIN_UPLOAD_URL);
  assert.equal(call.source, 'microsoft');
  assert.equal(call.headers.authorization, `Bearer ${TOKEN}`);
  assert.match(call.headers['content-type'], /^multipart\/form-data; boundary=/);
  assert.ok(call.body.includes(png));
});

test('upload validates the token, variant and image before any request', async () => {
  const http = createFakeHttp([]);
  const skin = createSkinService({ http });

  await assert.rejects(
    skin.upload({ token: '', data: fakePng() }),
    (err) => err.code === 'AUTH_NO_SESSION' && err.status === 401,
  );
  await assert.rejects(
    skin.upload({ token: TOKEN, data: fakePng(), variant: 'blocky' }),
    (err) => err.code === 'INVALID_SKIN_VARIANT' && err.details.known.includes('slim'),
  );
  await assert.rejects(
    skin.upload({ token: TOKEN, data: Buffer.from('nope') }),
    (err) => err.code === 'INVALID_SKIN',
  );
  assert.equal(http.calls.length, 0, 'invalid input must not hit the network');
});

test('upload maps Minecraft Services failures to readable errors', async () => {
  const cases = [
    [{ status: 400, body: '{"errorMessage":"Invalid skin dimensions"}' }, 'SKIN_REJECTED', 400, /Invalid skin dimensions/],
    [{ status: 401, body: '' }, 'AUTH_TOKEN_EXPIRED', 401, /expired/i],
    [{ status: 403, body: '{"errorMessage":"FORBIDDEN"}' }, 'SKIN_REFUSED', 403, /FORBIDDEN/],
    [{ status: 429, body: '' }, 'SKIN_THROTTLED', 429, /wait a moment/i],
    [{ status: 500, body: '' }, 'SKIN_FAILED', 502, /Skin change failed/],
  ];
  for (const [response, code, status, messageRe] of cases) {
    const skin = createSkinService({ http: createFakeHttp([response]) });
    await assert.rejects(
      skin.upload({ token: TOKEN, data: fakePng() }),
      (err) =>
        err.code === code &&
        err.status === status &&
        messageRe.test(err.message),
      `expected ${code} for upstream ${response.status}`,
    );
  }
});

test('reset sends a DELETE to the active-skin endpoint', async () => {
  const http = createFakeHttp([{ status: 200, body: '' }]);
  const skin = createSkinService({ http });

  const result = await skin.reset({ token: TOKEN });
  assert.deepEqual(result, { changed: true });

  const call = http.calls[0];
  assert.equal(call.method, 'DELETE');
  assert.equal(call.url, SKIN_RESET_URL);
  assert.equal(call.headers.authorization, `Bearer ${TOKEN}`);

  const failing = createSkinService({ http: createFakeHttp([{ status: 403, body: '' }]) });
  await assert.rejects(
    failing.reset({ token: TOKEN }),
    (err) => err.code === 'SKIN_REFUSED' && err.status === 403,
  );
});

test('texture() reads the local skin cache only — it never fetches from the network', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tml-skin-cache-'));
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tml-skin-empty-'));
  const hash = 'a'.repeat(40);
  const png = fakePng(64, 64);
  fs.mkdirSync(path.join(dir, hash.slice(0, 2)), { recursive: true });
  fs.writeFileSync(path.join(dir, hash.slice(0, 2), hash), png);

  const http = createFakeHttp([]); // queue ว่าง — ถ้า service ยิง request ออกแม้ครั้งเดียวจะ throw ทันที
  const skin = createSkinService({ http, dir });

  const exact = await skin.texture({ hash });
  assert.equal(exact.source, 'exact');
  assert.equal(exact.hash, hash);
  assert.deepEqual(exact.data, png);

  // hash ใน profile ไม่ตรงชื่อไฟล์ใน cache (Mojang คนละ id แต่รูปเดียวกัน) → เอาไฟล์ใหม่สุดใน cache แทน
  const newest = await skin.texture({ hash: 'b'.repeat(40) });
  assert.equal(newest.source, 'newest');
  assert.equal(newest.hash, hash);
  assert.deepEqual(newest.data, png);

  // cache ว่าง → 404 SKIN_NOT_CACHED (ไม่ใช่ไปโหลดจากเน็ต)
  const empty = createSkinService({ http, dir: emptyDir });
  await assert.rejects(
    empty.texture({ hash }),
    (err) => err.code === 'SKIN_NOT_CACHED' && err.status === 404,
  );

  // hash ผิดรูป (กัน path traversal) → 400
  await assert.rejects(
    skin.texture({ hash: '../etc/passwd' }),
    (err) => err.code === 'INVALID_SKIN_HASH' && err.status === 400,
  );

  assert.equal(http.calls.length, 0, 'the local cache reader must never call the network');

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(emptyDir, { recursive: true, force: true });
});

test('upload stores the skin in the uploaded cache so a restart still shows it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tml-skin-up-'));
  const hash = 'e'.repeat(40);
  const png = fakePng(64, 64);
  const http = createFakeHttp([
    { status: 200, body: '{"status":"SUCCESS"}' },
    {
      status: 200,
      body: JSON.stringify({
        name: 'Steve',
        skins: [{ url: `https://textures.minecraft.net/texture/${hash}`, state: 'ACTIVE' }],
      }),
    },
  ]);
  const skin = createSkinService({ http, dir });

  const result = await skin.upload({ token: TOKEN, data: png, variant: 'classic', filename: 'skin.png' });

  assert.equal(result.changed, true);
  assert.equal(result.hash, hash);
  const stored = path.join(dir, 'uploaded', hash.slice(0, 2), hash);
  assert.ok(fs.existsSync(stored), 'uploaded image is written into the uploaded cache');
  assert.deepEqual(fs.readFileSync(stored), png);

  // เกมยังไม่เคยโหลดรูปนี้ → texture() อ่านจาก uploaded cache ได้ทันที (ไม่ต้องเล่นเกม ไม่ต้องยิง network)
  const tex = await skin.texture({ hash });
  assert.equal(tex.source, 'uploaded');
  assert.deepEqual(tex.data, png);
  assert.equal(http.calls.length, 2, 'only the upload POST + profile lookup');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('once the game cache has the same image, the uploaded copy is deleted and the game file is used', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tml-skin-switch-'));
  const hash = 'f'.repeat(40);
  const png = fakePng(64, 64);
  const gameName = crypto.createHash('sha1').update(png).digest('hex');

  // TML เก็บรูปไว้แล้ว (ขั้นตอน "อัปโหลดก่อน")
  fs.mkdirSync(path.join(dir, 'uploaded', hash.slice(0, 2)), { recursive: true });
  fs.writeFileSync(path.join(dir, 'uploaded', hash.slice(0, 2), hash), png);
  // ต่อมาเกมเล่นแล้วเขียนรูปชุดเดียวกันลง cache ของตัวเอง (ชื่อ sha1)
  fs.mkdirSync(path.join(dir, gameName.slice(0, 2)), { recursive: true });
  fs.writeFileSync(path.join(dir, gameName.slice(0, 2), gameName), png);

  const skin = createSkinService({ http: createFakeHttp([]), dir });
  const tex = await skin.texture({ hash });

  assert.equal(tex.source, 'newest', 'served from the game cache');
  assert.equal(tex.hash, gameName);
  assert.deepEqual(tex.data, png);
  assert.ok(
    !fs.existsSync(path.join(dir, 'uploaded', hash.slice(0, 2), hash)),
    'uploaded copy is deleted once the game cache updates',
  );

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a game-written file for the same hash wins over the uploaded copy', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tml-skin-exact-'));
  const hash = 'a1'.repeat(20);
  const png = fakePng(64, 64);

  fs.mkdirSync(path.join(dir, hash.slice(0, 2)), { recursive: true });
  fs.writeFileSync(path.join(dir, hash.slice(0, 2), hash), png);
  fs.mkdirSync(path.join(dir, 'uploaded', hash.slice(0, 2)), { recursive: true });
  fs.writeFileSync(path.join(dir, 'uploaded', hash.slice(0, 2), hash), png);

  const skin = createSkinService({ http: createFakeHttp([]), dir });
  const tex = await skin.texture({ hash });

  assert.equal(tex.source, 'exact');
  assert.deepEqual(tex.data, png);
  assert.ok(!fs.existsSync(path.join(dir, 'uploaded', hash.slice(0, 2), hash)), 'uploaded copy removed');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('each new upload keeps only the latest uploaded skin', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tml-skin-prune-'));
  const first = '11'.repeat(20);
  const second = '22'.repeat(20);
  const png = fakePng(64, 64);
  const profileFor = (hash) => ({
    status: 200,
    body: JSON.stringify({ name: 'Steve', skins: [{ url: `https://textures.minecraft.net/texture/${hash}`, state: 'ACTIVE' }] }),
  });
  const http = createFakeHttp([
    { status: 200, body: '{"status":"SUCCESS"}' },
    profileFor(first),
    { status: 200, body: '{"status":"SUCCESS"}' },
    profileFor(second),
  ]);
  const skin = createSkinService({ http, dir });

  await skin.upload({ token: TOKEN, data: png, variant: 'classic', filename: 'a.png' });
  const second2 = await skin.upload({ token: TOKEN, data: png, variant: 'slim', filename: 'b.png' });

  assert.equal(second2.hash, second);
  assert.ok(!fs.existsSync(path.join(dir, 'uploaded', first.slice(0, 2), first)), 'stale upload removed');
  assert.ok(fs.existsSync(path.join(dir, 'uploaded', second.slice(0, 2), second)), 'latest upload kept');

  fs.rmSync(dir, { recursive: true, force: true });
});
