// Kilitli dolap takibi için nokta takibi ve homografi (DOM yok, Node'da test edilebilir).
//
// Akış (her kare):
//   1. Önceki karede seçilmiş köşe noktaları (Shi-Tomasi) bu karede blok eşleme ile bulunur
//      (kaba→ince piramit, önceki hareketten tahminle).
//   2. Eşleşmelerden RANSAC ile kare→kare homografi bulunur (yaklaşma, kaydırma, açı değişimi).
//   3. Kilitli dörtgen bu homografi ile taşınır.

import { downsample2 } from './tracker.js';
import { computeHomography, solveLinear } from './perspective.js';

// ---------- 3x3 matris yardımcıları (satır düzeni, 9 eleman) ----------

export function mul3(A, B) {
  const C = new Array(9);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++) C[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
  return C;
}

export function inv3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-14) return null;
  const k = 1 / det;
  return [A * k, -(b * i - c * h) * k, (b * f - c * e) * k, B * k, (a * i - c * g) * k, -(a * f - c * d) * k, C * k, -(a * h - b * g) * k, (a * e - b * d) * k];
}

/** Homografi uygula; nokta ufuk çizgisinin arkasına düşerse null. */
export function applyH(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  if (!(w > 1e-9)) return null;
  return { x: (H[0] * x + H[1] * y + H[2]) / w, y: (H[3] * x + H[4] * y + H[5]) / w };
}

export const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

// ---------- Nokta seçimi (Shi-Tomasi) ----------

function insidePoly(poly, x, y) {
  let ins = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) ins = !ins;
  }
  return ins;
}

/**
 * İyi takip edilebilir noktalar seçer: ızgaranın her hücresinde en güçlü köşe.
 * region: (isteğe bağlı) yalnız bu çokgenin içinden seç. existing: dolu hücreleri atla.
 */
export function selectPoints(gray, w, h, { grid = 9, border = 10, region = null, existing = [], win = 2 } = {}) {
  const n = w * h;
  const W1 = w + 1;
  const Sxx = new Float64Array(W1 * (h + 1));
  const Syy = new Float64Array(W1 * (h + 1));
  const Sxy = new Float64Array(W1 * (h + 1));
  // Gradyan çarpımlarının integral görüntüleri
  for (let y = 0; y < h; y++) {
    let rxx = 0;
    let ryy = 0;
    let rxy = 0;
    for (let x = 0; x < w; x++) {
      let ix = 0;
      let iy = 0;
      if (x > 0 && x < w - 1 && y > 0 && y < h - 1) {
        const i = y * w + x;
        ix = (gray[i + 1] - gray[i - 1]) * 0.5;
        iy = (gray[i + w] - gray[i - w]) * 0.5;
      }
      rxx += ix * ix;
      ryy += iy * iy;
      rxy += ix * iy;
      const k = (y + 1) * W1 + x + 1;
      Sxx[k] = Sxx[k - W1] + rxx;
      Syy[k] = Syy[k - W1] + ryy;
      Sxy[k] = Sxy[k - W1] + rxy;
    }
  }
  void n;
  const box = (S, x0, y0, x1, y1) => S[(y1 + 1) * W1 + x1 + 1] - S[y0 * W1 + x1 + 1] - S[(y1 + 1) * W1 + x0] + S[y0 * W1 + x0];
  const score = (x, y) => {
    const a = box(Sxx, x - win, y - win, x + win, y + win);
    const c = box(Syy, x - win, y - win, x + win, y + win);
    const b = box(Sxy, x - win, y - win, x + win, y + win);
    return (a + c) / 2 - Math.sqrt(((a - c) / 2) ** 2 + b * b); // küçük özdeğer
  };
  const cw = (w - 2 * border) / grid;
  const ch = (h - 2 * border) / grid;
  const occupied = new Uint8Array(grid * grid);
  for (const p of existing) {
    const gx = Math.floor((p.x - border) / cw);
    const gy = Math.floor((p.y - border) / ch);
    if (gx >= 0 && gy >= 0 && gx < grid && gy < grid) occupied[gy * grid + gx] = 1;
  }
  const cand = [];
  let maxS = 0;
  for (let gy = 0; gy < grid; gy++) {
    for (let gx = 0; gx < grid; gx++) {
      if (occupied[gy * grid + gx]) continue;
      let best = 0;
      let bx = 0;
      let by = 0;
      const x0 = Math.round(border + gx * cw);
      const y0 = Math.round(border + gy * ch);
      for (let y = y0; y < y0 + ch; y += 2) {
        for (let x = x0; x < x0 + cw; x += 2) {
          const s = score(x, y);
          if (s > best) {
            best = s;
            bx = x;
            by = y;
          }
        }
      }
      if (best > 0 && (!region || insidePoly(region, bx, by))) {
        cand.push({ x: bx, y: by, s: best });
        maxS = Math.max(maxS, best);
      }
    }
  }
  // Zayıf köşeleri ele (en güçlünün %3'ü ve mutlak bir alt sınır)
  const thr = Math.max(25 * (2 * win + 1) ** 2, maxS * 0.03);
  return cand.filter((c) => c.s >= thr).map(({ x, y }) => ({ x, y }));
}

// ---------- Nokta takibi (blok eşleme) ----------

function sadPatch(A, B, w, ax, ay, bx, by, half) {
  let s = 0;
  for (let dy = -half; dy <= half; dy++) {
    const ra = (ay + dy) * w + ax;
    const rb = (by + dy) * w + bx;
    for (let dx = -half; dx <= half; dx++) {
      const d = A[ra + dx] - B[rb + dx];
      s += d < 0 ? -d : d;
    }
  }
  return s;
}

function vfit(a, b, c) {
  const d = Math.max(a, c) - b;
  if (!(d > 1e-9)) return 0;
  return Math.max(-0.5, Math.min(0.5, (a - c) / (2 * d)));
}

export function pyramid(gray, w, h) {
  const l1 = downsample2(gray, w, h);
  return { l0: { data: gray, w, h }, l1 };
}

/**
 * pts: önceki karedeki noktalar; pred: her nokta için bu karedeki tahmini konum.
 * Döner: her nokta için {x, y} ya da null (kayıp).
 */
export function trackPoints(prevPyr, currPyr, pts, pred, { radius = 12, half0 = 4, half1 = 3, maxCost = 22 } = {}) {
  const { l0: P0, l1: P1 } = prevPyr;
  const { l0: C0, l1: C1 } = currPyr;
  const r1 = Math.ceil(radius / 2);
  const out = new Array(pts.length);
  for (let k = 0; k < pts.length; k++) {
    const p = pts[k];
    const q = pred[k] || p;
    // Kaba seviye
    const ax = Math.round(p.x / 2);
    const ay = Math.round(p.y / 2);
    if (ax < half1 || ay < half1 || ax >= P1.w - half1 || ay >= P1.h - half1) {
      out[k] = null;
      continue;
    }
    const cx = Math.round(q.x / 2);
    const cy = Math.round(q.y / 2);
    let best = Infinity;
    let bx = cx;
    let by = cy;
    let sum = 0;
    let cnt = 0;
    for (let dy = -r1; dy <= r1; dy++) {
      const y = cy + dy;
      if (y < half1 || y >= C1.h - half1) continue;
      for (let dx = -r1; dx <= r1; dx++) {
        const x = cx + dx;
        if (x < half1 || x >= C1.w - half1) continue;
        const s = sadPatch(P1.data, C1.data, P1.w, ax, ay, x, y, half1);
        sum += s;
        cnt++;
        if (s < best) {
          best = s;
          bx = x;
          by = y;
        }
      }
    }
    if (!cnt || best > (sum / cnt) * 0.7) {
      out[k] = null; // belirsiz eşleşme (tekdüze bölge)
      continue;
    }
    // İnce seviye
    const px = Math.round(p.x);
    const py = Math.round(p.y);
    if (px < half0 || py < half0 || px >= P0.w - half0 || py >= P0.h - half0) {
      out[k] = null;
      continue;
    }
    const gx = bx * 2; // ince aramanın merkezi
    const gy = by * 2;
    let fb = Infinity;
    let fx = gx;
    let fy = gy;
    const costs = new Float64Array(25).fill(Infinity);
    for (let dy = -2; dy <= 2; dy++) {
      const y = gy + dy;
      if (y < half0 || y >= C0.h - half0) continue;
      for (let dx = -2; dx <= 2; dx++) {
        const x = gx + dx;
        if (x < half0 || x >= C0.w - half0) continue;
        const s = sadPatch(P0.data, C0.data, P0.w, px, py, x, y, half0);
        costs[(dy + 2) * 5 + dx + 2] = s;
        if (s < fb) {
          fb = s;
          fx = x;
          fy = y;
        }
      }
    }
    const npx = (2 * half0 + 1) ** 2;
    if (!Number.isFinite(fb) || fb / npx > maxCost) {
      out[k] = null;
      continue;
    }
    const ix = fx - gx + 2;
    const iy = fy - gy + 2;
    const sx = ix > 0 && ix < 4 ? vfit(costs[iy * 5 + ix - 1], fb, costs[iy * 5 + ix + 1]) : 0;
    const sy = iy > 0 && iy < 4 ? vfit(costs[(iy - 1) * 5 + ix], fb, costs[(iy + 1) * 5 + ix]) : 0;
    // Noktanın tam sayı olmayan kısmını koru
    out[k] = { x: fx + sx + (p.x - px), y: fy + sy + (p.y - py) };
  }
  return out;
}

// ---------- Homografi (RANSAC + en küçük kareler) ----------

function normalizer(pts) {
  let mx = 0;
  let my = 0;
  for (const p of pts) {
    mx += p.x;
    my += p.y;
  }
  mx /= pts.length;
  my /= pts.length;
  let d = 0;
  for (const p of pts) d += Math.hypot(p.x - mx, p.y - my);
  d /= pts.length;
  const s = d > 1e-9 ? Math.SQRT2 / d : 1;
  return { T: [s, 0, -s * mx, 0, s, -s * my, 0, 0, 1], f: (p) => ({ x: (p.x - mx) * s, y: (p.y - my) * s }) };
}

/** Tüm eşleşmelerle (normalize edilmiş) en küçük kareler homografisi. */
export function fitHomographyLS(src, dst) {
  if (src.length < 4) return null;
  const ns = normalizer(src);
  const nd = normalizer(dst);
  const AtA = Array.from({ length: 8 }, () => new Array(8).fill(0));
  const Atb = new Array(8).fill(0);
  for (let i = 0; i < src.length; i++) {
    const { x, y } = ns.f(src[i]);
    const { x: X, y: Y } = nd.f(dst[i]);
    for (const [row, b] of [
      [[x, y, 1, 0, 0, 0, -X * x, -X * y], X],
      [[0, 0, 0, x, y, 1, -Y * x, -Y * y], Y],
    ]) {
      for (let r = 0; r < 8; r++) {
        Atb[r] += row[r] * b;
        for (let c = 0; c < 8; c++) AtA[r][c] += row[r] * row[c];
      }
    }
  }
  let h;
  try {
    h = solveLinear(AtA, Atb);
  } catch {
    return null;
  }
  const Hn = [...h, 1];
  const Tdi = inv3(nd.T);
  if (!Tdi) return null;
  const H = mul3(mul3(Tdi, Hn), ns.T);
  const k = H[8];
  return Math.abs(k) > 1e-12 ? H.map((v) => v / k) : null;
}

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a * 1664525 + 1013904223) >>> 0;
    return a / 4294967296;
  };
}

/**
 * RANSAC ile sağlam homografi. Döner: { H, inliers: bool[], count } ya da null.
 */
export function fitHomographyRansac(src, dst, { iters = 120, thresh = 1.5, seed = 1 } = {}) {
  const n = src.length;
  if (n < 4) return null;
  const rand = rng(seed);
  const t2 = thresh * thresh;
  let bestH = null;
  let bestCount = 0;
  const countInliers = (H) => {
    let c = 0;
    for (let i = 0; i < n; i++) {
      const q = applyH(H, src[i].x, src[i].y);
      if (q && (q.x - dst[i].x) ** 2 + (q.y - dst[i].y) ** 2 < t2) c++;
    }
    return c;
  };
  for (let it = 0; it < iters; it++) {
    const idx = new Set();
    while (idx.size < 4) idx.add(Math.floor(rand() * n));
    const ids = [...idx];
    const s4 = ids.map((i) => src[i]);
    const d4 = ids.map((i) => dst[i]);
    // Neredeyse doğrusal örnekleri atla
    const area = Math.abs((s4[1].x - s4[0].x) * (s4[2].y - s4[0].y) - (s4[2].x - s4[0].x) * (s4[1].y - s4[0].y));
    if (area < 4) continue;
    let H;
    try {
      H = computeHomography(s4, d4);
    } catch {
      continue;
    }
    const c = countInliers(H);
    if (c > bestCount) {
      bestCount = c;
      bestH = H;
      if (c === n) break;
    }
  }
  if (!bestH) return null;
  // İç noktalarla yeniden oturt (iki tur)
  let H = bestH;
  let inl = null;
  for (let round = 0; round < 2; round++) {
    inl = src.map((p, i) => {
      const q = applyH(H, p.x, p.y);
      return !!q && (q.x - dst[i].x) ** 2 + (q.y - dst[i].y) ** 2 < t2;
    });
    const s = src.filter((_, i) => inl[i]);
    const d = dst.filter((_, i) => inl[i]);
    const Hr = s.length >= 4 ? fitHomographyLS(s, d) : null;
    if (!Hr) break;
    H = Hr;
  }
  inl = src.map((p, i) => {
    const q = applyH(H, p.x, p.y);
    return !!q && (q.x - dst[i].x) ** 2 + (q.y - dst[i].y) ** 2 < t2;
  });
  return { H, inliers: inl, count: inl.filter(Boolean).length };
}

// ---------- Kilitli dörtgen takipçisi ----------

/**
 * Kare kare dörtgeni taşıyan takipçi.
 * const t = new QuadTracker(w, h); t.lock(quad, gray); her karede t.update(gray)
 */
export class QuadTracker {
  constructor(w, h, { minInliers = 8, reseedBelow = 30 } = {}) {
    this.w = w;
    this.h = h;
    this.minInliers = minInliers;
    this.reseedBelow = reseedBelow;
    this.quad = null;
    this.pts = [];
    this.prevPyr = null;
    this.Hlast = IDENTITY;
    this.lost = 0;
    this.frame = 0;
    this.lastInliers = 0;
  }

  lock(quad, gray) {
    this.quad = quad.map((p) => ({ ...p }));
    this.prevPyr = pyramid(Uint8Array.from(gray), this.w, this.h);
    this.pts = this._seed(this.prevPyr.l0.data, []);
    this.Hlast = IDENTITY;
    this.lost = 0;
    this.frame = 0;
  }

  _region() {
    // Dolap bölgesi (biraz genişletilmiş) — düzlemdeki noktalar homografiye uyar
    const q = this.quad;
    const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4;
    const cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
    return q.map((p) => ({ x: cx + (p.x - cx) * 1.04, y: cy + (p.y - cy) * 1.04 }));
  }

  _seed(gray, existing) {
    const fresh = selectPoints(gray, this.w, this.h, { region: this._region(), existing });
    return existing.concat(fresh);
  }

  /** Döner: { ok, inliers, H } — ok=false ise bu karede dörtgen güncellenmedi. */
  update(gray) {
    if (!this.quad) return { ok: false, inliers: 0 };
    this.frame++;
    const curr = pyramid(Uint8Array.from(gray), this.w, this.h);
    const pts = this.pts;
    const pred = pts.map((p) => applyH(this.Hlast, p.x, p.y) || p);
    const found = pts.length ? trackPoints(this.prevPyr, curr, pts, pred) : [];
    const src = [];
    const dst = [];
    for (let i = 0; i < pts.length; i++) {
      if (found[i]) {
        src.push(pts[i]);
        dst.push(found[i]);
      }
    }
    const fit = src.length >= this.minInliers ? fitHomographyRansac(src, dst, { seed: this.frame }) : null;
    let ok = false;
    let next = [];
    if (fit && fit.count >= this.minInliers) {
      const q2 = this.quad.map((p) => applyH(fit.H, p.x, p.y));
      if (q2.every(Boolean)) {
        this.quad = q2;
        this.Hlast = fit.H;
        ok = true;
        next = dst.filter((p, i) => fit.inliers[i] && p.x > 6 && p.y > 6 && p.x < this.w - 6 && p.y < this.h - 6);
      }
    }
    this.lastInliers = fit ? fit.count : 0;
    if (ok) this.lost = 0;
    else {
      this.lost++;
      this.Hlast = IDENTITY;
      next = []; // kayıpta noktaları baştan seç
    }
    // Nokta azaldıysa ya da düzenli aralıklarla yeni nokta ekle
    if (ok && (next.length < this.reseedBelow || this.frame % 10 === 0)) next = this._seed(curr.l0.data, next);
    if (!ok) next = this._seed(curr.l0.data, []);
    this.pts = next;
    this.prevPyr = curr;
    return { ok, inliers: this.lastInliers, H: ok ? this.Hlast : null };
  }
}
