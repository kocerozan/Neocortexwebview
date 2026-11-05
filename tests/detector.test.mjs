import test from 'node:test';
import assert from 'node:assert/strict';
import { detectQuad } from '../web/js/detector.js';
import { computeHomography, applyHomography } from '../web/js/perspective.js';

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Duvar önünde perspektifli dolap: koyu kasa, açık iç, raflar ve ürün blokları.
function renderCabinet(w, h, quad, seed = 3) {
  const rnd = rng(seed);
  const products = Array.from({ length: 40 }, () => ({ u: rnd(), v: rnd(), s: 0.03 + rnd() * 0.05, g: 60 + rnd() * 150 }));
  const Hm = computeHomography(quad, [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]);
  const img = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const { x: u, y: v } = applyHomography(Hm, x + 0.5, y + 0.5);
      let g;
      if (u < 0 || u > 1 || v < 0 || v > 1) g = 150 + 25 * Math.sin(x / 37) * Math.cos(y / 53) + rnd() * 10; // duvar
      else if (u < 0.04 || u > 0.96 || v < 0.04 || v > 0.96) g = 35; // kasa
      else {
        g = 215;
        for (const sh of [0.27, 0.5, 0.73]) if (Math.abs(v - sh) < 0.012) g = 90; // raf
        for (const p of products) if (Math.abs(u - p.u) < p.s * 0.6 && Math.abs(v - p.v) < p.s) g = p.g;
      }
      img[y * w + x] = Math.max(0, Math.min(255, g));
    }
  }
  return img;
}

const maxErr = (a, b) => Math.max(...a.map((p, i) => Math.hypot(p.x - b[i].x, p.y - b[i].y)));

test('perspektifli dolabın dış çerçevesini bulur', () => {
  const w = 320, h = 240;
  const quad = [{ x: 60, y: 30 }, { x: 255, y: 42 }, { x: 250, y: 215 }, { x: 66, y: 222 }];
  const r = detectQuad(renderCabinet(w, h, quad), w, h);
  assert.ok(r, 'dörtgen bulunamadı');
  const err = maxErr(r.corners, quad);
  assert.ok(err < 8, `köşe hatası ${err.toFixed(1)} px: ${JSON.stringify(r.corners)}`);
});

test('dikey (portre) dolapta da çalışır', () => {
  const w = 240, h = 360;
  const quad = [{ x: 40, y: 50 }, { x: 200, y: 40 }, { x: 205, y: 330 }, { x: 35, y: 320 }];
  const r = detectQuad(renderCabinet(w, h, quad, 9), w, h);
  assert.ok(r, 'dörtgen bulunamadı');
  assert.ok(maxErr(r.corners, quad) < 8, JSON.stringify(r.corners));
});

test('dolap yoksa bir şey uydurmaz', () => {
  const w = 320, h = 240, rnd = rng(5);
  const img = new Uint8Array(w * h).map((_, i) => 140 + 25 * Math.sin((i % w) / 37) * Math.cos(Math.floor(i / w) / 53) + rnd() * 10);
  assert.equal(detectQuad(img, w, h), null);
});
