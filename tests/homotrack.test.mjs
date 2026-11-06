import test from 'node:test';
import assert from 'node:assert/strict';
import { fitHomographyRansac, applyH, QuadTracker, mul3 } from '../web/js/homotrack.js';
import { computeHomography } from '../web/js/perspective.js';

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

test('RANSAC homografi %25 hatalı eşleşmeye rağmen doğru', () => {
  const rnd = rng(1);
  const H = [1.05, 0.02, 6, -0.01, 1.04, -3, 0.0002, -0.0001, 1];
  const src = [], dst = [];
  for (let i = 0; i < 80; i++) {
    const p = { x: rnd() * 300, y: rnd() * 220 };
    src.push(p);
    const q = applyH(H, p.x, p.y);
    dst.push(i % 4 === 0 ? { x: rnd() * 300, y: rnd() * 220 } : { x: q.x + (rnd() - 0.5) * 0.4, y: q.y + (rnd() - 0.5) * 0.4 });
  }
  const r = fitHomographyRansac(src, dst);
  assert.ok(r.count >= 58 && r.count <= 62, `iç nokta ${r.count}`);
  for (const p of [{ x: 0, y: 0 }, { x: 300, y: 220 }, { x: 150, y: 100 }]) {
    const a = applyH(H, p.x, p.y), b = applyH(r.H, p.x, p.y);
    assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < 0.5, `hata ${Math.hypot(a.x - b.x, a.y - b.y)}`);
  }
});

// Dokulu düzlem (ürün dolu dolap gibi) ve onu belli homografiyle gösteren kare
const TW = 900, TH = 700;
const tex = (() => {
  const rnd = rng(7);
  const t = new Uint8Array(TW * TH).fill(200);
  for (let k = 0; k < 900; k++) {
    const x0 = Math.floor(rnd() * TW), y0 = Math.floor(rnd() * TH), w = 6 + Math.floor(rnd() * 40), h = 6 + Math.floor(rnd() * 40), g = Math.floor(rnd() * 255);
    for (let y = y0; y < Math.min(TH, y0 + h); y++) for (let x = x0; x < Math.min(TW, x0 + w); x++) t[y * TW + x] = g;
  }
  return t;
})();
function render(Hplane2img, w, h) {
  const Hinv = computeHomography(
    [{ x: 0, y: 0 }, { x: TW, y: 0 }, { x: TW, y: TH }, { x: 0, y: TH }].map((p) => applyH(Hplane2img, p.x, p.y)),
    [{ x: 0, y: 0 }, { x: TW, y: 0 }, { x: TW, y: TH }, { x: 0, y: TH }],
  );
  const img = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = applyH(Hinv, x + 0.5, y + 0.5);
    const u = p ? Math.floor(p.x) : -1, v = p ? Math.floor(p.y) : -1;
    img[y * w + x] = u >= 0 && v >= 0 && u < TW && v < TH ? tex[v * TW + u] : 120;
  }
  // hafif bulanıklık (kamera gibi)
  const out = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    out[i] = (img[i] * 4 + img[i - 1] + img[i + 1] + img[i - w] + img[i + w]) >> 3;
  }
  return out;
}

test('yaklaşırken (yakınlaştırma + kaydırma) dörtgeni doğru taşır', () => {
  const w = 256, h = 192;
  // Başlangıç: düzlem görüntüye sığıyor, hafif perspektif
  const base = computeHomography(
    [{ x: 0, y: 0 }, { x: TW, y: 0 }, { x: TW, y: TH }, { x: 0, y: TH }],
    [{ x: 40, y: 30 }, { x: 215, y: 38 }, { x: 212, y: 165 }, { x: 44, y: 160 }],
  );
  const corners = [{ x: 0, y: 0 }, { x: TW, y: 0 }, { x: TW, y: TH }, { x: 0, y: TH }];
  const truth = (Hk) => corners.map((p) => applyH(Hk, p.x, p.y));
  const t = new QuadTracker(w, h);
  t.lock(truth(base), render(base, w, h));
  let Hk = base;
  for (let f = 1; f <= 60; f++) {
    // Kare başına %2,5 yakınlaşma, merkez sola-yukarı kayar
    const z = 1.025, cx = 128 + 30, cy = 96 - 10;
    const step = [z, 0, cx - z * cx - 1.2, 0, z, cy - z * cy + 0.4, 0, 0, 1];
    Hk = mul3(step, Hk);
    const r = t.update(render(Hk, w, h));
    assert.ok(r.ok, `kare ${f}: takip kayboldu (iç nokta ${r.inliers})`);
  }
  const q = truth(Hk);
  const size = Math.hypot(q[2].x - q[0].x, q[2].y - q[0].y);
  const err = Math.max(...q.map((p, i) => Math.hypot(p.x - t.quad[i].x, p.y - t.quad[i].y)));
  // 60 karede ~4,4 kat yakınlaştı; dörtgen artık ekranın çok dışında
  assert.ok(size > 900, `beklenen büyük dörtgen, köşegen ${size.toFixed(0)}`);
  assert.ok(err / size < 0.03, `köşe hatası köşegenin %${((err / size) * 100).toFixed(1)}'i`);
});

test('yakın çekimlerden düz dolap görüntüsü (rectifyCore)', async () => {
  const { rectifyCore } = await import('../web/js/stitcher.js');
  // Dolap: sol yarı siyah, sağ yarı beyaz. İki "yakın çekim" karesi, her biri bir yarıyı görüyor.
  const mk = (val) => {
    const w = 64, h = 48, d = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) { d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = val; d[i * 4 + 3] = 255; }
    return { data: d, width: w, height: h };
  };
  const unit = [{ x: 0, y: 0 }, { x: 64, y: 0 }, { x: 64, y: 48 }, { x: 0, y: 48 }];
  const left = { ...mk(0), G: computeHomography(unit, [{ x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 0.5, y: 1 }, { x: 0, y: 1 }]) };
  const right = { ...mk(255), G: computeHomography(unit, [{ x: 0.5, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0.5, y: 1 }]) };
  const r = rectifyCore([left, right], 100, 75);
  assert.ok(r.filled > 0.97, `dolu oran ${r.filled}`);
  const px = (x, y) => r.data[(y * 100 + x) * 4];
  assert.ok(px(20, 37) < 30, `sol taraf koyu olmalı: ${px(20, 37)}`);
  assert.ok(px(80, 37) > 225, `sağ taraf açık olmalı: ${px(80, 37)}`);
});
