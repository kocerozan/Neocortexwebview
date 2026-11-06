import test from 'node:test';
import assert from 'node:assert/strict';
import { APP_VERSION, CHANGELOG, entriesToShow, compareVersions } from '../web/js/changelog.js';

test('sürüm notları tutarlı', () => {
  assert.equal(CHANGELOG[0].version, APP_VERSION, 'en üstteki not şu anki sürüm olmalı');
  for (let i = 1; i < CHANGELOG.length; i++) assert.equal(compareVersions(CHANGELOG[i - 1].version, CHANGELOG[i].version), 1, 'yeniden eskiye sıralı olmalı');
});

test('gösterilecek notlar', () => {
  assert.deepEqual(entriesToShow(null).map((e) => e.version), [APP_VERSION]); // ilk ziyaret
  assert.deepEqual(entriesToShow(APP_VERSION), []); // güncel
  assert.deepEqual(entriesToShow('1.3').map((e) => e.version), ['1.8', '1.7', '1.6']);
  assert.equal(entriesToShow('0.1').length, 3); // en fazla 3 sürüm
  assert.equal(compareVersions('1.10', '1.9'), 1);
});
