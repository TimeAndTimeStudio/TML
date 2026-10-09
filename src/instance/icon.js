// Owner: Time And Time Studio
// Date: 2026-10-07 14:20 +0700
// License: GPL-3.0-or-later

import fsp from 'node:fs/promises';

export const ICON_MAX_BYTES = 2 * 1024 * 1024;
export const ICON_MIME = Object.freeze({
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
});

// ไฟล์ไอคอนเก็บเป็น icon.<ext> ชั้นบนสุดของ instance dir — ไม่พึ่ง meta.json (export/import โยกไฟล์ตรงๆ ได้)
const ICON_NAME_RE = /^icon\.(png|jpe?g|gif|webp)$/;

export function isIconFilename(name) {
  return typeof name === 'string' && ICON_NAME_RE.test(name);
}

// ตรวจชนิดจาก magic bytes — ไม่เชื่อ file extension ที่ client ส่งมา
export function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    return 'png';
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.toString('ascii', 0, 4) === 'GIF8') return 'gif';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

// คืนชื่อไฟล์ไอคอน (icon.<ext>) ของ instance dir — null เมื่อไม่มี/dir ยังไม่ถูกสร้าง
export async function findInstanceIcon(dir) {
  let names;
  try {
    names = await fsp.readdir(dir);
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
  return names.filter(isIconFilename).sort()[0] ?? null;
}
