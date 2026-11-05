import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../web/js/analysis.js';

const base = { duration: 10, clips: 1, keyframes: 8, frames: 300, okFrames: 300, fastFrames: 0, speeds: Array(300).fill(0.4), ys: Array(300).fill(0), coverW: 4, coverH: 1.1, fill: 0.97 };

test('temiz çekim yüksek puan alır', () => {
  const a = analyze(base);
  assert.equal(a.level, 'good');
  assert.ok(a.score >= 90, `puan ${a.score}`);
  assert.equal(a.tips.length, 1);
  assert.equal(a.metrics.length, 8);
});

test('boşluk, hız ve takip kaybı puanı düşürür ve öneri üretir', () => {
  const a = analyze({ ...base, fill: 0.7, fastFrames: 60, okFrames: 210 });
  assert.equal(a.level, 'poor');
  assert.ok(a.tips.some((t) => t.includes('boş kaldı')));
  assert.ok(a.tips.some((t) => t.includes('hızlı')));
  assert.ok(a.tips.some((t) => t.includes('takip edilemedi')));
});

test('az alan taranırsa uyarır, Türkçe sayı biçimi kullanır', () => {
  const a = analyze({ ...base, coverW: 1.1, coverH: 1.05 });
  assert.ok(a.tips.some((t) => t.includes('Çok az alan')));
  assert.equal(a.metrics.find((m) => m.label === 'Taranan alan').value, '1,1 × 1,1');
  assert.equal(a.metrics.find((m) => m.label === 'Kapsama').value, '%97');
});
