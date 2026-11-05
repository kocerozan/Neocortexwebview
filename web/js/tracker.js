// Kamera hareket takibi (DOM yok, saf fonksiyonlar — Node'da test edilebilir).
//
// Kural: estimateShift(prev, curr) içerik kaymasını (s) döndürür:
//   curr(x, y) ≈ prev(x - sx, y - sy)
// Kamera sağa dönerse içerik sola kayar (sx < 0). Kameranın sahnedeki
// konumu bu yüzden her karede  pos -= s  ile güncellenir.

export function toGray(rgba, out) {
  const n = out.length;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    out[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
  }
  return out;
}

export function downsample2(src, w, h) {
  const w2 = w >> 1;
  const h2 = h >> 1;
  const out = new Uint8Array(w2 * h2);
  for (let y = 0; y < h2; y++) {
    const r0 = 2 * y * w;
    const r1 = r0 + w;
    for (let x = 0; x < w2; x++) {
      const i = 2 * x;
      out[y * w2 + x] = (src[r0 + i] + src[r0 + i + 1] + src[r1 + i] + src[r1 + i + 1] + 2) >> 2;
    }
  }
  return { data: out, w: w2, h: h2 };
}

// Sabit merkez bölgede ortalama mutlak fark. m >= |sx|,|sy| olmalı.
function costCentral(prev, curr, w, h, sx, sy, m) {
  let s = 0;
  let n = 0;
  for (let y = m; y < h - m; y++) {
    const rc = y * w;
    const rp = (y - sy) * w - sx;
    for (let x = m; x < w - m; x++) {
      const d = curr[rc + x] - prev[rp + x];
      s += d < 0 ? -d : d;
      n++;
    }
  }
  return s / n;
}

// Yalnız örtüşen bölgede ortalama mutlak fark (büyük kaymalar için).
function costOverlap(prev, curr, w, h, sx, sy, m) {
  const x0 = Math.max(m, sx + m);
  const x1 = Math.min(w - m, w + sx - m);
  const y0 = Math.max(m, sy + m);
  const y1 = Math.min(h - m, h + sy - m);
  if (x1 - x0 < 8 || y1 - y0 < 8) return Infinity;
  let s = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    const rc = y * w;
    const rp = (y - sy) * w - sx;
    for (let x = x0; x < x1; x++) {
      const d = curr[rc + x] - prev[rp + x];
      s += d < 0 ? -d : d;
      n++;
    }
  }
  return s / n;
}

function gridSearch(costFn, cx, cy, r) {
  const n = 2 * r + 1;
  const costs = new Float64Array(n * n);
  let best = Infinity;
  let bi = 0;
  let sum = 0;
  let cnt = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const c = costFn(cx + i - r, cy + j - r);
      costs[j * n + i] = c;
      if (Number.isFinite(c)) {
        sum += c;
        cnt++;
      }
      if (c < best) {
        best = c;
        bi = j * n + i;
      }
    }
  }
  return {
    x: cx + (bi % n) - r,
    y: cy + Math.floor(bi / n) - r,
    best,
    mean: cnt ? sum / cnt : Infinity,
    costs,
    n,
    bi,
  };
}

// SAD maliyeti V şeklindedir; eşaçılı (V) uydurma parabolden daha az tamsayıya kayar.
function vfit(a, b, c) {
  if (!Number.isFinite(a) || !Number.isFinite(c)) return 0;
  const d = Math.max(a, c) - b;
  if (d <= 1e-9) return 0;
  const o = (a - c) / (2 * d);
  return Math.max(-0.5, Math.min(0.5, o));
}

function subpixel(g) {
  const { costs, n, bi } = g;
  const i = bi % n;
  const j = Math.floor(bi / n);
  const fx = i > 0 && i < n - 1 ? vfit(costs[bi - 1], costs[bi], costs[bi + 1]) : 0;
  const fy = j > 0 && j < n - 1 ? vfit(costs[bi - n], costs[bi], costs[bi + n]) : 0;
  return { x: g.x + fx, y: g.y + fy };
}

/**
 * Ardışık iki gri kare arasındaki içerik kaymasını bulur (kaba→ince piramit).
 * @returns {{sx:number, sy:number, ok:boolean, confidence:number}}
 */
export function estimateShift(prev, curr, w, h, { radius = 24, deadband = 0.08, maxRatio = 0.8, minTexture = 2 } = {}) {
  const p1 = downsample2(prev, w, h);
  const c1 = downsample2(curr, w, h);
  const r1 = Math.ceil(radius / 2);
  const m1 = r1 + 1;
  if (p1.w - 2 * m1 < 8 || p1.h - 2 * m1 < 8) throw new Error('Kare, arama yarıçapı için çok küçük');

  const coarse = gridSearch((sx, sy) => costCentral(p1.data, c1.data, p1.w, p1.h, sx, sy, m1), 0, 0, r1);
  const confidence = coarse.mean > 0 ? 1 - coarse.best / coarse.mean : 0;
  // Dokusuz sahne (duvar, kapalı lens): kaymaya güvenme, kaydırma.
  if (!(coarse.mean >= minTexture && coarse.best <= coarse.mean * maxRatio)) return { sx: 0, sy: 0, ok: false, confidence };

  const m0 = 2 * r1 + 3;
  const fine = gridSearch((sx, sy) => costCentral(prev, curr, w, h, sx, sy, m0), coarse.x * 2, coarse.y * 2, 2);
  let { x: sx, y: sy } = subpixel(fine);
  if (Math.abs(sx) < deadband) sx = 0;
  if (Math.abs(sy) < deadband) sy = 0;
  return { sx, sy, ok: true, confidence };
}

/** Tahmini (gx, gy) kaymasını ±r içinde, örtüşen bölgede iyileştirir. */
export function refineShift(prev, curr, w, h, gx, gy, r = 4) {
  const g = gridSearch(
    (sx, sy) => costOverlap(prev, curr, w, h, sx, sy, 2),
    Math.round(gx),
    Math.round(gy),
    r,
  );
  if (!Number.isFinite(g.best) || !(g.best <= g.mean * 0.85)) return { ok: false, sx: gx, sy: gy };
  const p = subpixel(g);
  return { ok: true, sx: p.x, sy: p.y };
}

/**
 * Anahtar karelerin konumlarını komşu kareyle eşleştirerek düzeltir
 * (kare-kare takipte biriken kaymayı azaltır).
 * kfs: [{x, y, gray, w, h}] — x,y kameranın sahnedeki sol-üst konumu.
 */
export function refinePositions(kfs, { radius = 4, minOverlap = 0.35 } = {}) {
  const out = [];
  for (let i = 0; i < kfs.length; i++) {
    const k = kfs[i];
    if (i === 0) {
      out.push({ x: k.x, y: k.y });
      continue;
    }
    const p = kfs[i - 1];
    const dx = k.x - p.x;
    const dy = k.y - p.y;
    let d = { x: dx, y: dy };
    const overlap = Math.max(0, 1 - Math.abs(dx) / k.w) * Math.max(0, 1 - Math.abs(dy) / k.h);
    if (overlap >= minOverlap && p.w === k.w && p.h === k.h && p.gray && k.gray) {
      // kamera d kadar giderse içerik -d kadar kayar
      const r = refineShift(p.gray, k.gray, k.w, k.h, -dx, -dy, radius);
      if (r.ok) d = { x: -r.sx, y: -r.sy };
    }
    out.push({ x: out[i - 1].x + d.x, y: out[i - 1].y + d.y });
  }
  return out;
}
