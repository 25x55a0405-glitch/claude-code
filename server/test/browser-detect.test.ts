import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { findSystemBrowser } from '../src/browser/browser.ts';

test('findSystemBrowser returns an installed Chrome or Chromium, or nothing', () => {
  const found = findSystemBrowser();
  assert.ok(found === null || existsSync(found));
});
