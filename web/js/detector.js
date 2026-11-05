// Dolap / teşhir çerçevesi algılama (DOM yok, Node'da test edilebilir).
//
// Yöntem: gri görüntü → bulanıklaştır → Sobel kenarları → Hough doğruları →
// yatay ve dikey doğru çiftlerinden dörtgen adayları → kenar desteği ve alana göre
// en iyi dörtgen. Dolabın dış çerçevesi genelde güçlü kenarları olan en büyük dörtgendir.
// Köşe sırası: sol-üst, sağ-üst, sağ-alt, sol-alt.

function blur121(src, w, h) {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const r = y * w;
    for (let x = 0; x < w; x++) {
      const a = src[r + Math.max(0, x - 1)];
      const b = src[r + x];
      const c = src[r + Math.min(w - 1, x + 1)];
      tmp[r + x] = (a + 2 * b + c) * 0.25;
    }
  }
  for (let y = 0; y < h; y++) {
    const r0 = Math.max(0, y - 1) * w;
    const r1 = y * w;
    const r2 = Math.min(h - 1, y + 1) * w;
    for (let x = 0; x < w; x++) out[r1 + x] = (tmp[r0 + x] + 2 * tmp[r1 + x] + tmp[r2 + x]) * 0.25;
  }
  return out;
}

function dilate(m, w, h) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!m[y * w + x]) continue;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < w) out[yy * w + xx] = 1;
        }
      }
    }
  }
  return out;
}

function intersect(a, b) {
  const det = a.c * b.s - a.s * b.c;
  if (Math.abs(det) < 1e-6) return null;
  return { x: (a.r * b.s - a.s * b.r) / det, y: (a.c * b.r - a.r * b.c) / det };
}

// Kenar desteği ve polaritesi. A→B saat yönünde (ekran koordinatı) verilir;
// iç normal (-dy, dx). pol > 0: iç taraf daha açık, pol < 0: iç taraf daha koyu.
// Ürün/raf kenarlarından oluşan sahte doğrularda polarite sürekli değişir (pol ≈ 0).
function support(map, G, w, h, A, B) {
  const len = Math.hypot(B.x - A.x, B.y - A.y);
  const n = Math.max(16, Math.floor(len / 2));
  const nx = -(B.y - A.y) / len;
  const ny = (B.x - A.x) / len;
  let hit = 0;
  let pos = 0;
  let neg = 0;
  let cSum = 0;
  let cN = 0;
  let iJ = 0; // ardışık örnekler arası mutlak fark toplamı (iç / dış şerit)
  let oJ = 0;
  let pi = -1;
  let po = -1;
  const off = 3;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = Math.round(A.x + (B.x - A.x) * t);
    const y = Math.round(A.y + (B.y - A.y) * t);
    // Kenarın iki yanındaki parlaklık farkı (iç - dış)
    const xi = Math.round(x + nx * off);
    const yi = Math.round(y + ny * off);
    const xo = Math.round(x - nx * off);
    const yo = Math.round(y - ny * off);
    if (xi >= 0 && yi >= 0 && xi < w && yi < h && xo >= 0 && yo >= 0 && xo < w && yo < h) {
      const vi = G.g[yi * w + xi];
      const vo = G.g[yo * w + xo];
      cSum += vi - vo;
      cN++;
      if (pi >= 0) {
        iJ += Math.abs(vi - pi);
        oJ += Math.abs(vo - po);
      }
      pi = vi;
      po = vo;
    }
    if (x < 0 || y < 0 || x >= w || y >= h || !map[y * w + x]) continue;
    hit++;
    // 3x3 komşulukta en güçlü kenar pikselinin gradyan yönü
    let bi = -1;
    let bm = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const j = yy * w + xx;
        if (G.mag[j] > bm) {
          bm = G.mag[j];
          bi = j;
        }
      }
    }
    if (bi < 0) continue;
    const d = G.gx[bi] * nx + G.gy[bi] * ny;
    if (d > 0) pos++;
    else if (d < 0) neg++;
  }
  // Kenar boyunca tekdüzelik: gerçek çerçevede en az bir yan düz renkli şerittir (kasa ya da duvar).
  // Ardışık fark kullanılır: yavaş ışık geçişlerini cezalandırmaz, ürün sınırlarındaki sıçramaları yakalar.
  const flat = cN > 1 ? Math.min(iJ, oJ) / (cN - 1) : 255;
  return { s: hit / (n + 1), pol: hit ? (pos - neg) / hit : 0, contrast: cN ? cSum / cN : 0, flat };
}

function polyArea(q) {
  let a = 0;
  for (let i = 0; i < 4; i++) {
    const p = q[i];
    const n = q[(i + 1) % 4];
    a += p.x * n.y - n.x * p.y;
  }
  return Math.abs(a) / 2;
}

function convex(q) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    const c = q[(i + 2) % 4];
    const z = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    const s = Math.sign(z);
    if (!s) return false;
    if (!sign) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

// Doğruyu yakınındaki kenar noktalarına en küçük kareler (toplam) ile oturt.
// Hough'un 1° / 1px nicemleme hatasını giderir.
function refineLine(L, pts, cls, band = 2.5) {
  let n = 0;
  let sx = 0;
  let sy = 0;
  for (let k = 0; k < pts.length; k += 3) {
    if (!(pts[k + 2] & cls)) continue;
    const x = pts[k];
    const y = pts[k + 1];
    if (Math.abs(x * L.c + y * L.s - L.r) > band) continue;
    n++;
    sx += x;
    sy += y;
  }
  if (n < 20) return L;
  const mx = sx / n;
  const my = sy / n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let k = 0; k < pts.length; k += 3) {
    if (!(pts[k + 2] & cls)) continue;
    const x = pts[k];
    const y = pts[k + 1];
    if (Math.abs(x * L.c + y * L.s - L.r) > band) continue;
    const dx = x - mx;
    const dy = y - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  // En küçük özdeğerin özvektörü = doğrunun normali
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy); // doğrultu açısı
  let c = -Math.sin(th);
  let s = Math.cos(th);
  if (c * L.c + s * L.s < 0) {
    c = -c;
    s = -s;
  }
  return { ...L, c, s, r: c * mx + s * my };
}

/** Hough doğruları: [{c, s, r, theta(derece), votes}] */
export function houghLines(gray, w, h, { edgeQuantile = 0.88, minVotesFrac = 0.15, maxLines = 60 } = {}) {
  const g = blur121(gray, w, h);
  const n = w * h;
  const gxA = new Float32Array(n);
  const gyA = new Float32Array(n);
  const mag = new Float32Array(n);
  const hist = new Uint32Array(1024);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = g[i - w + 1] + 2 * g[i + 1] + g[i + w + 1] - g[i - w - 1] - 2 * g[i - 1] - g[i + w - 1];
      const gy = g[i + w - 1] + 2 * g[i + w] + g[i + w + 1] - g[i - w - 1] - 2 * g[i - w] - g[i - w + 1];
      const m = Math.hypot(gx, gy);
      gxA[i] = gx;
      gyA[i] = gy;
      mag[i] = m;
      hist[Math.min(1023, m | 0)]++;
    }
  }
  // Uyarlanır eşik: en güçlü %12 kenar (en az 24)
  let acc = 0;
  let thr = 1023;
  const target = n * edgeQuantile;
  for (let i = 0; i < 1024; i++) {
    acc += hist[i];
    if (acc >= target) {
      thr = i;
      break;
    }
  }
  thr = Math.max(24, thr);

  const pts = []; // [x, y, sınıf] — sınıf: 1 yatay kenar, 2 dikey kenar, 3 ikisi
  const eH = new Uint8Array(n); // yatay kenar (dikey gradyan)
  const eV = new Uint8Array(n); // dikey kenar (yatay gradyan)
  const nT = 180;
  const diag = Math.ceil(Math.hypot(w, h));
  const nR = 2 * diag + 1;
  const votes = new Uint32Array(nT * nR);
  const cos = new Float64Array(nT);
  const sin = new Float64Array(nT);
  for (let t = 0; t < nT; t++) {
    cos[t] = Math.cos((t * Math.PI) / 180);
    sin[t] = Math.sin((t * Math.PI) / 180);
  }
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (mag[i] < thr) continue;
      const ax = Math.abs(gxA[i]);
      const ay = Math.abs(gyA[i]);
      if (ay >= ax * 0.7) eH[i] = 1;
      if (ax >= ay * 0.7) eV[i] = 1;
      pts.push(x, y, eH[i] | (eV[i] << 1));
      let th = Math.atan2(gyA[i], gxA[i]);
      if (th < 0) th += Math.PI;
      const ti = Math.round((th * 180) / Math.PI) % 180;
      for (let d = -2; d <= 2; d++) {
        const t = (ti + d + nT) % nT;
        const r = Math.round(x * cos[t] + y * sin[t]) + diag;
        votes[t * nR + r]++;
      }
    }
  }

  const minVotes = Math.max(10, minVotesFrac * Math.min(w, h));
  const peaks = [];
  for (let t = 0; t < nT; t++) {
    for (let r = 0; r < nR; r++) {
      const v = votes[t * nR + r];
      if (v < minVotes) continue;
      let isMax = true;
      for (let dt = -3; dt <= 3 && isMax; dt++) {
        const tt = t + dt;
        if (tt < 0 || tt >= nT) continue;
        for (let dr = -3; dr <= 3; dr++) {
          const rr = r + dr;
          if (rr < 0 || rr >= nR || (dt === 0 && dr === 0)) continue;
          const u = votes[tt * nR + rr];
          if (u > v || (u === v && (dt < 0 || (dt === 0 && dr < 0)))) {
            isMax = false;
            break;
          }
        }
      }
      if (isMax) peaks.push({ t, r: r - diag, v });
    }
  }
  peaks.sort((a, b) => b.v - a.v);

  // Benzer doğruları ele (0°/180° sarmasını da hesaba kat)
  const lines = [];
  for (const p of peaks) {
    const dup = lines.some((l) => {
      let dt = Math.abs(l.theta - p.t);
      let dr = Math.abs(l.r - p.r);
      if (dt > 90) {
        dt = 180 - dt;
        dr = Math.abs(l.r + p.r);
      }
      return dt <= 4 && dr <= 3;
    });
    if (dup) continue;
    lines.push({ c: cos[p.t], s: sin[p.t], r: p.r, theta: p.t, votes: p.v });
    if (lines.length >= maxLines) break;
  }
  return { lines, pts, eH: dilate(eH, w, h), eV: dilate(eV, w, h), G: { gx: gxA, gy: gyA, mag, g } };
}

/**
 * En olası dolap çerçevesini bulur.
 * @returns {null | {corners: {x,y}[], score, support, areaFrac}}
 */
export function detectQuad(gray, w, h, { maxPerAxis = 12, minAreaFrac = 0.12, minEdgeSupport = 0.5, minPolarity = 0.6, minContrastRatio = 0.35, maxFlatRatio = 0.12, margin = 0.03 } = {}) {
  const { lines, pts, eH, eV, G } = houghLines(gray, w, h);
  // Doğrunun normal açısı ~90° → yatay doğru, ~0°/180° → dikey doğru
  const H = lines.filter((l) => l.theta >= 55 && l.theta <= 125).slice(0, maxPerAxis).map((l) => refineLine(l, pts, 1));
  const V = lines.filter((l) => l.theta <= 35 || l.theta >= 145).slice(0, maxPerAxis).map((l) => refineLine(l, pts, 2));
  if (H.length < 2 || V.length < 2) return null;
  H.sort((a, b) => (a.r - a.c * (w / 2)) / a.s - (b.r - b.c * (w / 2)) / b.s);
  V.sort((a, b) => (a.r - a.s * (h / 2)) / a.c - (b.r - b.s * (h / 2)) / b.c);

  const mx = w * margin;
  const my = h * margin;
  const inside = (p) => p && p.x >= -mx && p.y >= -my && p.x <= w + mx && p.y <= h + my;
  let best = null;
  for (let i = 0; i < H.length; i++) {
    for (let j = i + 1; j < H.length; j++) {
      for (let k = 0; k < V.length; k++) {
        for (let l = k + 1; l < V.length; l++) {
          const q = [intersect(H[i], V[k]), intersect(H[i], V[l]), intersect(H[j], V[l]), intersect(H[j], V[k])];
          if (!q.every(inside) || !convex(q)) continue;
          if (Math.min(q[1].x - q[0].x, q[2].x - q[3].x) < 0.15 * w) continue;
          if (Math.min(q[3].y - q[0].y, q[2].y - q[1].y) < 0.15 * h) continue;
          const areaFrac = polyArea(q) / (w * h);
          if (areaFrac < minAreaFrac) continue;
          const e = [
            support(eH, G, w, h, q[0], q[1]),
            support(eV, G, w, h, q[1], q[2]),
            support(eH, G, w, h, q[2], q[3]),
            support(eV, G, w, h, q[3], q[0]),
          ];
          const s = e.map((x) => x.s);
          const minS = Math.min(...s);
          if (minS < minEdgeSupport) continue;
          // Dört kenarda da iç taraf aynı yönde (hep koyu ya da hep açık) olmalı
          const pol = e.map((x) => x.pol);
          const sign = Math.sign(pol[0]);
          if (!sign || pol.some((p) => Math.sign(p) !== sign || Math.abs(p) < minPolarity)) continue;
          // Dört kenarın kontrastı birbirine benzemeli (gerçek kasa her yanda aynı geçişi yapar)
          const con = e.map((x) => x.contrast * sign);
          const cMin = Math.min(...con);
          const cMax = Math.max(...con);
          if (cMin < 12 || cMin < minContrastRatio * cMax) continue;
          if (e.some((x, k) => x.flat > Math.max(4, maxFlatRatio * con[k]))) continue;
          const mean = (s[0] + s[1] + s[2] + s[3]) / 4;
          const polMean = pol.reduce((a, p) => a + Math.abs(p), 0) / 4;
          const score = mean * polMean * (0.6 + 0.4 * minS) * Math.sqrt(areaFrac);
          if (!best || score > best.score) best = { corners: q, score, support: mean, polarity: polMean, areaFrac };
        }
      }
    }
  }
  if (!best) return null;
  best.corners = best.corners.map((p) => ({ x: Math.max(0, Math.min(w, p.x)), y: Math.max(0, Math.min(h, p.y)) }));
  return best;
}
