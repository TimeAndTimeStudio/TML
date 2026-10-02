// Owner: Time And Time Studio
// Date: 2026-10-01 19:50 +0700
// License: GPL-3.0-or-later

import test from 'node:test';
import assert from 'node:assert/strict';
import { SUPPORTED_PLATFORM, assertLinuxPlatform, isSupportedPlatform } from '../../src/core/platform.js';
import { ConfigError } from '../../src/core/errors.js';

test('only Linux is a supported platform', () => {
  assert.equal(SUPPORTED_PLATFORM, 'linux');
  assert.equal(isSupportedPlatform('linux'), true);
  assert.equal(isSupportedPlatform('win32'), false);
  assert.equal(isSupportedPlatform('darwin'), false);
  assert.equal(isSupportedPlatform('freebsd'), false);
});

test('assertLinuxPlatform passes on linux and rejects every other platform', () => {
  assert.doesNotThrow(() => assertLinuxPlatform('linux'));

  for (const platform of ['win32', 'darwin', 'freebsd', 'sunos']) {
    assert.throws(
      () => assertLinuxPlatform(platform),
      (err) => {
        assert.ok(err instanceof ConfigError);
        assert.equal(err.code, 'UNSUPPORTED_PLATFORM');
        assert.equal(err.status, 500);
        assert.equal(err.expose, true);
        assert.deepEqual(err.details, { platform, supported: 'linux' });
        assert.match(err.message, /linux only/);
        return true;
      },
    );
  }
});

test('assertLinuxPlatform defaults to the current process platform', () => {
  assert.doesNotThrow(() => assertLinuxPlatform());
});
