import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateShift, refinePositions } from '../web/js/tracker.js';

// Pürüzsüz rastgele doku (büyük sahne)
function makeScene(W, H, seed = 7) {
  let a = seed >>> 0;
  const rnd = () => { // mulberry32
    a = (a + 0x6D2B79F5) >>> 0; let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const raw = new Float64Array(W * H).map(() => rnd() * 255);
  const out = new Float64Array(W * H);
  const r = 2;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let sum = 0, n = 0;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const xx = Math.min(W - 1, Math.max(0, x + dx)), yy = Math.min(H - 1, Math.max(0, y + dy));
      sum += raw[yy * W + xx]; n++;
    }
    out[y * W + x] = sum / n;
  }
  return { data: out, W, H };
}

// Kamera (cx, cy) konumundayken görülen kare (bilinear, alt-piksel)
function view(scene, cx, cy, w, h) {
  const f = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const fx = cx + x, fy = cy + y, x0 = Math.floor(fx), y0 = Math.floor(fy), ax = fx - x0, ay = fy - y0;
    const g = (xx, yy) => scene.data[yy * scene.W + xx];
    f[y * w + x] = Math.round(g(x0, y0) * (1 - ax) * (1 - ay) + g(x0 + 1, y0) * ax * (1 - ay) + g(x0, y0 + 1) * (1 - ax) * ay + g(x0 + 1, y0 + 1) * ax * ay);
  }
  return f;
}

const W = 160, H = 120;
const scene = makeScene(700, 400);

test('tamsayı ve büyük kaymaları bulur', () => {
  for (const [dx, dy] of [[0, 0], [3, -2], [-7, 4], [15, 0], [-20, 9]]) {
    const a = view(scene, 200, 120, W, H);
    const b = view(scene, 200 + dx, 120 + dy, W, H);
    const r = estimateShift(a, b, W, H, { radius: 24 });
    assert.ok(r.ok);
    // kamera +d giderse içerik -d kayar
    assert.ok(Math.abs(r.sx + dx) < 0.35, `sx=${r.sx} beklenen ${-dx}`);
    assert.ok(Math.abs(r.sy + dy) < 0.35, `sy=${r.sy} beklenen ${-dy}`);
  }
});

test('alt-piksel kaymayı yaklaşık bulur', () => {
  const a = view(scene, 200, 120, W, H);
  const b = view(scene, 202.5, 119.3, W, H);
  const r = estimateShift(a, b, W, H);
  assert.ok(Math.abs(r.sx + 2.5) < 0.3, `sx=${r.sx}`);
  assert.ok(Math.abs(r.sy - 0.7) < 0.3, `sy=${r.sy}`);
});

test('dokusuz sahnede kaydırmaz', () => {
  const flat = new Uint8Array(W * H).fill(128);
  const r = estimateShift(flat, flat, W, H);
  assert.equal(r.ok, false);
  assert.equal(r.sx, 0);
});

test('uzun kaydırmada birikimli konum doğru kalır ve refinePositions bozmaz', () => {
  let pos = { x: 0, y: 0 };
  let prev = view(scene, 50, 100, W, H);
  const kfs = [{ x: 0, y: 0, gray: prev, w: W, h: H }];
  let last = kfs[0];
  for (let i = 1; i <= 120; i++) {
    const cx = 50 + i * 3.3, cy = 100 + Math.sin(i / 10) * 6;
    const cur = view(scene, cx, cy, W, H);
    const r = estimateShift(prev, cur, W, H);
    pos = { x: pos.x - r.sx, y: pos.y - r.sy };
    prev = cur;
    if (Math.abs(pos.x - last.x) > 0.3 * W) { last = { x: pos.x, y: pos.y, gray: cur, w: W, h: H }; kfs.push(last); }
  }
  const trueX = 120 * 3.3, trueY = Math.sin(12) * 6;
  assert.ok(Math.abs(pos.x - trueX) < 6, `x=${pos.x} gerçek ${trueX}`);
  assert.ok(Math.abs(pos.y - trueY) < 4, `y=${pos.y} gerçek ${trueY}`);
  const ref = refinePositions(kfs);
  const end = ref[ref.length - 1];
  const lastTrueX = kfs[kfs.length - 1].x; // takip değeri
  assert.ok(Math.abs(end.x - lastTrueX) < 6);
});
