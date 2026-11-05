import test from 'node:test';
import assert from 'node:assert/strict';
import { computeHomography, applyHomography, warpPerspective, suggestOutputSize, isConvexQuad } from '../web/js/perspective.js';

const rect = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }];
const quad = [{ x: 10, y: 5 }, { x: 180, y: 20 }, { x: 170, y: 140 }, { x: 25, y: 120 }];

test('homografi köşeleri birebir eşler', () => {
  const H = computeHomography(rect, quad);
  rect.forEach((p, i) => {
    const q = applyHomography(H, p.x, p.y);
    assert.ok(Math.abs(q.x - quad[i].x) < 1e-6 && Math.abs(q.y - quad[i].y) < 1e-6);
  });
});

test('tam görüntü dörtgeni kimlik dönüşümü verir', () => {
  const w = 20, h = 10, data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { data[i * 4] = (i * 7) % 256; data[i * 4 + 1] = (i * 13) % 256; data[i * 4 + 2] = i % 256; data[i * 4 + 3] = 255; }
  const out = warpPerspective({ data, width: w, height: h }, [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }], w, h);
  for (let i = 0; i < data.length; i++) assert.ok(Math.abs(out.data[i] - data[i]) <= 1, `i=${i}`);
});

test('çıktı boyutu ve dışbükeylik', () => {
  assert.deepEqual(suggestOutputSize(rect), { width: 100, height: 50 });
  assert.equal(isConvexQuad(quad), true);
  assert.equal(isConvexQuad([quad[0], quad[2], quad[1], quad[3]]), false);
});
