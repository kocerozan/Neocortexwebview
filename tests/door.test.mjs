import test from 'node:test';
import assert from 'node:assert/strict';
import { DoorMonitor, features, opennessDelta } from '../web/js/door.js';

// 64x48 örnek: ürünler (renkli bloklar); kapalıysa cam pusu + yansıma şeridi
function sample({ closed, shift = 0, sweep = null }) {
  const w = 64, h = 48, data = new Uint8ClampedArray(w * h * 4);
  const cols = [[200, 30, 40], [240, 180, 20], [30, 140, 60], [20, 90, 200], [235, 235, 235]];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    let c = (y % 12 < 2) ? [150, 155, 165] : cols[Math.floor((x + shift + Math.floor(y / 12) * 3) / 5) % cols.length];
    if (closed) {
      c = c.map((v, k) => v * 0.7 + [232, 238, 244][k] * 0.3);
      if ((x * 0.6 + y + 60) % 26 < 3) c = c.map((v) => v * 0.4 + 255 * 0.6);
    }
    if (sweep !== null && Math.abs(x - sweep) < 6) c = [95, 100, 108]; // dönen kapak kenarı
    data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 254;
  }
  return { data, w, h, visible: 1 };
}

test('cam kapalıyken kontrast ve doygunluk düşük', () => {
  const fc = features(sample({ closed: true })), fo = features(sample({ closed: false }));
  // Yansıma oranı yardımcı ipucu: beyaz ürünler de parlak olduğu için tek başına ayırt etmez
  assert.ok(fc.contrast < fo.contrast && fc.saturation < fo.saturation, JSON.stringify({ fc, fo }));
  assert.ok(opennessDelta(fc, fo) > 0.3 && opennessDelta(fo, fc) < -0.3);
});

test('kapak açılıp kapanınca olaylar doğru', () => {
  const m = new DoorMonitor();
  let t = 0;
  const feed = (s) => m.update(s, (t += 1 / 15));
  for (let i = 0; i < 12; i++) feed(sample({ closed: true }));
  for (let x = 0; x <= 64; x += 6) feed(sample({ closed: x < 32, sweep: x })); // kapak döner
  for (let i = 0; i < 12; i++) feed(sample({ closed: false }));
  assert.equal(m.state, 'open', `durum ${m.state}`);
  for (let x = 64; x >= 0; x -= 6) feed(sample({ closed: x < 32, sweep: x }));
  for (let i = 0; i < 12; i++) feed(sample({ closed: true }));
  assert.equal(m.state, 'closed');
  assert.deepEqual(m.events.map((e) => e.type), ['opened', 'closed']);
});

test('küçük titreşim kapak olayı üretmez', () => {
  const m = new DoorMonitor();
  for (let i = 0; i < 60; i++) m.update(sample({ closed: false, shift: i % 2 }), i / 15);
  assert.equal(m.events.length, 0);
});

// ---- Camda yansıma ----
import { GlareDetector } from '../web/js/door.js';

// Ürünlü örnek + isteğe bağlı parlak bant (yansıma) — bant kamera hareketiyle kayar
function prod({ band = null, bandW = 10, jitter = 0, whiteBlock = false }) {
  const w = 64, h = 48, data = new Uint8ClampedArray(w * h * 4);
  const cols = [[200, 30, 40], [240, 180, 20], [30, 140, 60], [20, 90, 200], [235, 235, 235]];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    let c = y % 12 < 2 ? [150, 155, 165] : cols[Math.floor((x + jitter + Math.floor(y / 12) * 3) / 5) % cols.length];
    if (whiteBlock && x > 20 && x < 36 && y > 14 && y < 30) c = [240, 240, 240]; // beyaz ürün (sabit)
    if (band !== null) {
      const dd = Math.abs(x + 0.5 * y - band);
      if (dd < bandW / 2) c = c.map((v) => v * 0.35 + 255 * 0.65);
    }
    data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 254;
  }
  return { data, w, h, visible: 1 };
}

test('kamerayla kayan geniş parlak bant yansıma sayılır', () => {
  const g = new GlareDetector();
  for (let k = 0; k < 30; k++) g.update(prod({ band: 20 + 4 * k }), 0.05);
  assert.equal(g.state, 'seen', `durum ${g.state}, oran ${g.lastFrac}`);
});

test('sabit beyaz ürün ve kenar titreşimi yansıma sayılmaz', () => {
  const g = new GlareDetector();
  for (let k = 0; k < 40; k++) g.update(prod({ whiteBlock: true, jitter: k % 2 }), 0.05);
  assert.equal(g.state, 'none', `durum ${g.state}, oran ${g.lastFrac}`);
});

test('kamera kıpırdamazsa karar verilmez', () => {
  const g = new GlareDetector();
  for (let k = 0; k < 30; k++) g.update(prod({ band: 20 + 4 * k }), 0);
  assert.equal(g.state, 'unknown');
});
