// Perspektif (homografi) hesapları — DOM yok, Node'da test edilebilir.
// Köşe sırası her yerde: sol-üst, sağ-üst, sağ-alt, sol-alt.

export function solveLinear(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-12) throw new Error('Köşeler geçersiz (tekil matris)');
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      if (f === 0) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/** src[i] → dst[i] eşleyen 3x3 homografi (satır düzeninde 9 eleman). */
export function computeHomography(src, dst) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: X, y: Y } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -X * x, -X * y]);
    b.push(X);
    A.push([0, 0, 0, x, y, 1, -Y * x, -Y * y]);
    b.push(Y);
  }
  const h = solveLinear(A, b);
  return [...h, 1];
}

export function applyHomography(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return { x: (H[0] * x + H[1] * y + H[2]) / w, y: (H[3] * x + H[4] * y + H[5]) / w };
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * Çapraz çekilmiş dikdörtgenin gerçek en/boy oranını tahmin eder
 * (Zhang & He, "Whiteboard scanning and image enhancement", 2004).
 * Kamera odak uzaklığı dörtgenden bulunur; asal nokta = görüntü merkezi.
 * Telefon dik tutulup yatayda çapraz çekildiğinde dikey kenarlar paralel kalır ve odak
 * dörtgenden bulunamaz; o zaman fPrior (tipik telefon kamerası) kullanılır.
 * quad: sol-üst, sağ-üst, sağ-alt, sol-alt. Döner: { aspect, focal, focalSource } ya da null.
 */
export function estimateAspect(quad, center, fPrior = null) {
  const [tl, tr, br, bl] = quad;
  const m1 = [tl.x, tl.y, 1];
  const m2 = [tr.x, tr.y, 1];
  const m3 = [bl.x, bl.y, 1];
  const m4 = [br.x, br.y, 1];
  const c14 = cross(m1, m4);
  const k2 = dot3(c14, m3) / dot3(cross(m2, m4), m3);
  const k3 = dot3(c14, m2) / dot3(cross(m3, m4), m2);
  if (!Number.isFinite(k2) || !Number.isFinite(k3)) return null;
  const n2 = m2.map((v, i) => k2 * v - m1[i]);
  const n3 = m3.map((v, i) => k3 * v - m1[i]);
  const h2 = Math.hypot(n2[0], n2[1]);
  const h3 = Math.hypot(n3[0], n3[1]);
  const affine = h2 / h3;
  const { x: u0, y: v0 } = center;
  let f2 = NaN;
  let focalSource = 'prior';
  // İki kaybolma noktası da sonlu ise (≲1e6 px) odak dörtgenden hesaplanabilir
  if (Math.abs(n2[2] * n3[2]) > 1e-12 * h2 * h3) {
    f2 =
      -(
        n2[0] * n3[0] - (n2[0] * n3[2] + n2[2] * n3[0]) * u0 + n2[2] * n3[2] * u0 * u0 +
        (n2[1] * n3[1] - (n2[1] * n3[2] + n2[2] * n3[1]) * v0 + n2[2] * n3[2] * v0 * v0)
      ) / (n2[2] * n3[2]);
    // Hesaplanan odak varsayılanla çok çelişiyorsa (gürültülü köşeler) güvenme
    if (f2 > 0 && (!fPrior || (f2 > (fPrior * 0.4) ** 2 && f2 < (fPrior * 2.5) ** 2))) focalSource = 'quad';
    else f2 = NaN;
  }
  if (!(f2 > 0)) {
    if (!fPrior) return { aspect: affine, focal: null, focalSource: 'none' };
    f2 = fPrior * fPrior;
  }
  const norm2 = (n) => ((n[0] - u0 * n[2]) ** 2 + (n[1] - v0 * n[2]) ** 2) / f2 + n[2] * n[2];
  const aspect = Math.sqrt(norm2(n2) / norm2(n3));
  if (!Number.isFinite(aspect) || aspect <= 0) return { aspect: affine, focal: null, focalSource: 'none' };
  return { aspect, focal: Math.sqrt(f2), focalSource };
}

/** Tipik telefon ana kamerası (~26 mm eşdeğer, video kırpması dahil): f ≈ 0,75 × kare köşegeni */
export function phoneFocal(frameW, frameH) {
  return 0.75 * Math.hypot(frameW, frameH);
}

/**
 * Seçilen dörtgenden çıktı boyutu önerir. center verilirse çapraz çekimde gerçek
 * en/boy oranı kullanılır (uzaktaki kenarın kısalması telafi edilir).
 */
export function suggestOutputSize(quad, maxSide = 3000, center = null, fPrior = null) {
  const [tl, tr, br, bl] = quad;
  let W = Math.max(dist(tl, tr), dist(bl, br));
  let H = Math.max(dist(tl, bl), dist(tr, br));
  if (center) {
    const est = estimateAspect(quad, center, fPrior);
    // Saçma sonuçlara karşı: kenar oranının 1/4'ü ile 4 katı arasında kalsın
    if (est && est.aspect > (W / H) / 4 && est.aspect < (W / H) * 4) {
      const area = W * H;
      W = Math.sqrt(area * est.aspect);
      H = W / est.aspect;
    }
  }
  const s = Math.min(1, maxSide / Math.max(W, H));
  W = Math.max(1, Math.round(W * s));
  H = Math.max(1, Math.round(H * s));
  return { width: W, height: H };
}

/** Dörtgenin dışbükey olup olmadığını kontrol eder (çapraz köşe hatası için). */
export function isConvexQuad(q) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    const c = q[(i + 2) % 4];
    const z = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(z) < 1e-9) return false;
    const s = Math.sign(z);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/**
 * src (ImageData benzeri {data,width,height}) içindeki dörtgeni outW×outH
 * dikdörtgene düzleştirir. Saydam/dış alanlar beyaz olur.
 */
export function warpPerspective(src, quad, outW, outH) {
  const rect = [
    { x: 0, y: 0 },
    { x: outW, y: 0 },
    { x: outW, y: outH },
    { x: 0, y: outH },
  ];
  const H = computeHomography(rect, quad); // çıktı → kaynak
  const { data: sd, width: sw, height: sh } = src;
  const out = new Uint8ClampedArray(outW * outH * 4);
  let o = 0;
  for (let y = 0; y < outH; y++) {
    const py = y + 0.5;
    let nx = H[0] * 0.5 + H[1] * py + H[2];
    let ny = H[3] * 0.5 + H[4] * py + H[5];
    let nw = H[6] * 0.5 + H[7] * py + H[8];
    for (let x = 0; x < outW; x++, o += 4, nx += H[0], ny += H[3], nw += H[6]) {
      const fx = nx / nw - 0.5;
      const fy = ny / nw - 0.5;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      if (x0 < -1 || y0 < -1 || x0 >= sw || y0 >= sh) {
        out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 255;
        continue;
      }
      const ax = fx - x0;
      const ay = fy - y0;
      const xa = Math.min(sw - 1, Math.max(0, x0));
      const xb = Math.min(sw - 1, Math.max(0, x0 + 1));
      const ya = Math.min(sh - 1, Math.max(0, y0));
      const yb = Math.min(sh - 1, Math.max(0, y0 + 1));
      const i00 = (ya * sw + xa) * 4;
      const i10 = (ya * sw + xb) * 4;
      const i01 = (yb * sw + xa) * 4;
      const i11 = (yb * sw + xb) * 4;
      const w00 = (1 - ax) * (1 - ay);
      const w10 = ax * (1 - ay);
      const w01 = (1 - ax) * ay;
      const w11 = ax * ay;
      const a = (sd[i00 + 3] * w00 + sd[i10 + 3] * w10 + sd[i01 + 3] * w01 + sd[i11 + 3] * w11) / 255;
      for (let c = 0; c < 3; c++) {
        const v = sd[i00 + c] * w00 + sd[i10 + c] * w10 + sd[i01 + c] * w01 + sd[i11 + c] * w11;
        out[o + c] = v * a + 255 * (1 - a);
      }
      out[o + 3] = 255;
    }
  }
  return { data: out, width: outW, height: outH };
}
