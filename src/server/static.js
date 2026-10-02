// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { resolveWithin } from '../core/filesystem.js';
import { NotFoundError, ValidationError } from '../core/errors.js';

const CONTENT_TYPES = new Map(
  Object.entries({
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.txt': 'text/plain; charset=utf-8',
    '.wasm': 'application/wasm',
  })
);

function contentTypeFor(file) {
  return CONTENT_TYPES.get(path.extname(file).toLowerCase()) ?? 'application/octet-stream';
}

function cacheControlFor(file) {
  const ext = path.extname(file).toLowerCase();
  // no-cache = ขอไฟล์ใหม่ทุกครั้ง (ไม่มี ETag/Last-Modified ให้ revalidate) — กัน UI เก่าค้างหลังอัปเดตโค้ด
  if (ext === '.html' || ext === '.js' || ext === '.css') return 'no-cache';
  return 'public, max-age=3600';
}

async function statFile(file) {
  try {
    const stat = await fsp.stat(file);
    return stat.isFile() ? stat : null;
  } catch {
    return null;
  }
}

async function sendFile(req, res, file) {
  const stat = await statFile(file);
  if (!stat) throw new NotFoundError(`Static file not found: ${path.basename(file)}`);

  res.statusCode = 200;
  res.setHeader('Content-Type', contentTypeFor(file));
  res.setHeader('Content-Length', stat.size);
  res.setHeader('Cache-Control', cacheControlFor(file));

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    res.on('close', () => stream.destroy());
    stream.on('end', resolve);
    stream.pipe(res);
  });
}

export async function serveStatic({ req, res, pathname, webDir }) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch (err) {
    throw new ValidationError('Malformed URL encoding in path', { cause: err });
  }

  if (decoded.includes('\0')) {
    throw new ValidationError('Invalid character in path');
  }

  const relative = decoded.replace(/^[/\\]+/, '');
  let filePath = resolveWithin(webDir, relative);

  let stat = await fsp.stat(filePath).catch(() => null);
  if (stat?.isDirectory()) {
    filePath = path.join(filePath, 'index.html');
    stat = await fsp.stat(filePath).catch(() => null);
  }

  if (!stat?.isFile()) {
    if (path.extname(relative) === '') {
      const fallback = path.join(webDir, 'index.html');
      if (await statFile(fallback)) {
        await sendFile(req, res, fallback);
        return;
      }
    }
    throw new NotFoundError(`Not found: ${decoded}`);
  }

  await sendFile(req, res, filePath);
}
