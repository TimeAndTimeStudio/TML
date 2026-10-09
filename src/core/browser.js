// Owner: Time And Time Studio
// Date: 2026-10-05 20:01 +0700
// License: GPL-3.0-or-later

import { spawn } from 'node:child_process';

// เปิด URL ในเบราว์เซอร์ของระบบผ่าน xdg-open — ใช้ได้บน Linux เท่านั้น
// คืน true เมื่อสั่งเปิดแล้ว / false เมื่อข้าม (platform อื่น, TML_NO_BROWSER=1, หรือ spawn ล้มเหลว)
export function openBrowser(url, { platform = process.platform, env = process.env, spawnFn = spawn } = {}) {
  if (platform !== 'linux') return false;
  if (env.TML_NO_BROWSER === '1') return false;
  if (typeof url !== 'string' || !/^https?:\/\//.test(url)) return false;
  try {
    const child = spawnFn('xdg-open', [url], { stdio: 'ignore', detached: true });
    child.on('error', () => {
      // xdg-open ไม่มี/เปิดไม่ได้ (หัวเซิร์ฟเวอร์, เวทีไร้ GUI) — เงียบไว้ UI เปิดผ่าน URL แทน
    });
    child.unref?.();
    return true;
  } catch {
    return false;
  }
}
