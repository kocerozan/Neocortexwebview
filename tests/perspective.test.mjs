import test from 'node:test';
import assert from 'node:assert/strict';
import { computeHomography, applyHomography, warpPerspective, suggestOutputSize, isConvexQuad, estimateAspect } from '../web/js/perspective.js';

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

// Gerçek kamera izdüşümü: W×H dikdörtgen, yatayda açılı (yaw) ve hafif yukarıdan (pitch)
function project(Wr, Hr, { yaw, pitch = 0, dist = 6, f = 500, cx = 320, cy = 240 }) {
  const pts = [[-Wr / 2, -Hr / 2], [Wr / 2, -Hr / 2], [Wr / 2, Hr / 2], [-Wr / 2, Hr / 2]];
  const cyw = Math.cos(yaw), syw = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  return pts.map(([X, Y]) => {
    let x = X * cyw, y = Y, z = X * syw + dist; // yaw (dikey eksen)
    const y2 = y * cp - z * sp, z2 = y * sp + z * cp; // pitch
    return { x: cx + (f * x) / z2, y: cy + (f * y2) / z2 };
  });
}

test('yukarıdan/aşağıdan da açılı çekimde odak ve oran dörtgenden bulunur', () => {
  for (const [yaw, pitch] of [[0.9, 0.15], [-0.7, -0.1], [0.3, 0.3]]) {
    const q = project(4, 3, { yaw, pitch });
    const est = estimateAspect(q, { x: 320, y: 240 }, 600);
    assert.equal(est.focalSource, 'quad');
    assert.ok(Math.abs(est.aspect - 4 / 3) < 0.03, `yaw=${yaw} pitch=${pitch}: oran ${est.aspect.toFixed(3)}`);
    assert.ok(Math.abs(est.focal - 500) < 25, `odak ${est.focal}`);
  }
});

test('yalnız yatayda çapraz çekimde varsayılan odakla düzleştirir', () => {
  // yaw: yatayda çapraz; [0, pitch]: yalnız yukarıdan bakış (yatay kenarlar paralel)
  for (const [yaw, pitch] of [[0.4, 0], [0.6, 0], [-0.8, 0], [0, 0.5]]) {
    const q = project(4, 3, { yaw, pitch });
    const exact = estimateAspect(q, { x: 320, y: 240 }, 500);
    assert.equal(exact.focalSource, 'prior');
    assert.ok(Math.abs(exact.aspect - 4 / 3) < 0.01, `doğru odakla oran ${exact.aspect.toFixed(3)}`);
    // Varsayılan odak %20 yanlış olsa bile oran hatası küçük kalır (kenar oranı ise çok yanılır)
    const rough = estimateAspect(q, { x: 320, y: 240 }, 600);
    const naive = Math.max(Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y), Math.hypot(q[2].x - q[3].x, q[2].y - q[3].y)) / Math.max(Math.hypot(q[3].x - q[0].x, q[3].y - q[0].y), Math.hypot(q[2].x - q[1].x, q[2].y - q[1].y));
    const roughErr = Math.abs(rough.aspect - 4 / 3);
    assert.ok(roughErr < Math.max(0.08, Math.abs(naive - 4 / 3) / 3), `yaw=${yaw} pitch=${pitch}: tahmin ${rough.aspect.toFixed(3)}, kenar oranı ${naive.toFixed(3)}`);
    if (Math.abs(yaw) >= 0.6) assert.ok(Math.abs(naive - 4 / 3) > 0.15, `kenar oranı zaten doğru çıktı: ${naive.toFixed(3)}`);
    const { width, height } = suggestOutputSize(q, 3000, { x: 320, y: 240 }, 500);
    assert.ok(Math.abs(width / height - 4 / 3) < 0.02, `çıktı ${width}×${height}`);
  }
});

test('karşıdan çekimde de oran doğru', () => {
  const est = estimateAspect(rect, { x: 50, y: 25 });
  assert.ok(Math.abs(est.aspect - 2) < 1e-6, `oran ${est.aspect}`);
});
