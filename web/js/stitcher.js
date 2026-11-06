// Anahtar kareleri tek bir panoramaya birleştirir (öteleme modeli + yumuşak dikiş).

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function featherMask(w, h, feather) {
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(w, h);
  const f = Math.max(1, feather * Math.min(w, h));
  for (let y = 0; y < h; y++) {
    const dy = Math.min(y, h - 1 - y);
    for (let x = 0; x < w; x++) {
      const d = Math.min(dy, x, w - 1 - x);
      img.data[(y * w + x) * 4 + 3] = Math.min(255, (d / f) * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/**
 * items: [{ image: CanvasImageSource, x, y }] — x,y işlem (proc) birimiyle kamera konumu.
 * procW/procH: işlem karesi boyutu, scale: görüntü pikseli / proc birimi.
 * @returns {HTMLCanvasElement}
 */
export function stitchPanorama(items, { procW, procH, scale, maxSide = 4096, maxArea = 12e6, feather = 0.12 }) {
  if (!items.length) throw new Error('Birleştirilecek kare yok');
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const it of items) {
    minX = Math.min(minX, it.x);
    minY = Math.min(minY, it.y);
    maxX = Math.max(maxX, it.x + procW);
    maxY = Math.max(maxY, it.y + procH);
  }
  const W0 = (maxX - minX) * scale;
  const H0 = (maxY - minY) * scale;
  const f = Math.min(1, maxSide / W0, maxSide / H0, Math.sqrt(maxArea / (W0 * H0)));
  const s = scale * f;
  const W = Math.ceil((maxX - minX) * s);
  const H = Math.ceil((maxY - minY) * s);
  const tw = Math.round(procW * s);
  const th = Math.round(procH * s);

  const pano = makeCanvas(W, H);
  const ctx = pano.getContext('2d');
  ctx.imageSmoothingQuality = 'high';

  // 1. geçiş: opak — boşluk kalmasın.
  for (const it of items) ctx.drawImage(it.image, (it.x - minX) * s, (it.y - minY) * s, tw, th);

  // 2. geçiş: kenarları yumuşatılmış kareler — dikişleri gizler.
  const mask = featherMask(tw, th, feather);
  const tmp = makeCanvas(tw, th);
  const tctx = tmp.getContext('2d');
  for (const it of items) {
    tctx.globalCompositeOperation = 'source-over';
    tctx.clearRect(0, 0, tw, th);
    tctx.drawImage(it.image, 0, 0, tw, th);
    tctx.globalCompositeOperation = 'destination-in';
    tctx.drawImage(mask, 0, 0);
    ctx.drawImage(tmp, (it.x - minX) * s, (it.y - minY) * s);
  }
  // Tek bir kamera karesinin panoramadaki boyutu (perspektifte odak uzaklığı tahmini için)
  pano.tileW = tw;
  pano.tileH = th;
  return pano;
}

// ---------------- Kilitli dolap: yakın çekimlerden düz dolap görüntüsü ----------------

/**
 * Saf çekirdek (Node'da test edilebilir). sources: [{ data, width, height, G }]
 * G: görüntü pikseli → dolap birim karesi ([0,1]²) homografisi.
 * Kaynaklar sırayla üst üste konur (sonraki üstte); kenarlar yumuşak geçişli.
 * Döner: { data: RGBA, filled: dolu piksel oranı }.
 */
export function rectifyCore(sources, outW, outH, { feather = 0.04 } = {}) {
  const out = new Float32Array(outW * outH * 3);
  const acc = new Float32Array(outW * outH); // birikmiş örtme (0..1)
  for (const s of sources) {
    const Hinv = invert3(s.G); // birim → görüntü pikseli
    if (!Hinv) continue;
    // Kaynağın dolap üzerindeki izdüşümünün sınırları
    const corners = [
      [0, 0],
      [s.width, 0],
      [s.width, s.height],
      [0, s.height],
    ].map(([x, y]) => projectPt(s.G, x, y));
    if (corners.some((c) => !c)) continue;
    const x0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c.x)) * outW));
    const x1 = Math.min(outW, Math.ceil(Math.max(...corners.map((c) => c.x)) * outW));
    const y0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c.y)) * outH));
    const y1 = Math.min(outH, Math.ceil(Math.max(...corners.map((c) => c.y)) * outH));
    if (x1 <= x0 || y1 <= y0) continue;
    const { data: sd, width: sw, height: sh } = s;
    const fpx = Math.max(2, feather * Math.min(sw, sh));
    for (let y = y0; y < y1; y++) {
      const v = (y + 0.5) / outH;
      for (let x = x0; x < x1; x++) {
        const u = (x + 0.5) / outW;
        const w = Hinv[6] * u + Hinv[7] * v + Hinv[8];
        if (!(w > 1e-12)) continue;
        const fx = (Hinv[0] * u + Hinv[1] * v + Hinv[2]) / w - 0.5;
        const fy = (Hinv[3] * u + Hinv[4] * v + Hinv[5]) / w - 0.5;
        if (fx < 0 || fy < 0 || fx > sw - 1 || fy > sh - 1) continue;
        const ix = Math.floor(fx);
        const iy = Math.floor(fy);
        const ax = fx - ix;
        const ay = fy - iy;
        const ix1 = Math.min(sw - 1, ix + 1);
        const iy1 = Math.min(sh - 1, iy + 1);
        const a = Math.min(1, Math.min(fx, sw - 1 - fx, fy, sh - 1 - fy) / fpx);
        const o = y * outW + x;
        for (let c = 0; c < 3; c++) {
          const val =
            sd[(iy * sw + ix) * 4 + c] * (1 - ax) * (1 - ay) +
            sd[(iy * sw + ix1) * 4 + c] * ax * (1 - ay) +
            sd[(iy1 * sw + ix) * 4 + c] * (1 - ax) * ay +
            sd[(iy1 * sw + ix1) * 4 + c] * ax * ay;
          // Henüz boş piksele tam yaz, dolu pikselde yumuşak geçiş
          const k = acc[o] > 0 ? a : 1;
          out[o * 3 + c] = out[o * 3 + c] * (1 - k) + val * k;
        }
        acc[o] = Math.min(1, acc[o] + a);
      }
    }
  }
  const rgba = new Uint8ClampedArray(outW * outH * 4);
  let filled = 0;
  for (let i = 0; i < outW * outH; i++) {
    if (acc[i] > 0) {
      filled++;
      rgba[i * 4] = out[i * 3];
      rgba[i * 4 + 1] = out[i * 3 + 1];
      rgba[i * 4 + 2] = out[i * 3 + 2];
    } else rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = 255; // çekilmemiş yer beyaz
    rgba[i * 4 + 3] = 255;
  }
  return { data: rgba, filled: filled / (outW * outH) };
}

function projectPt(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  if (!(w > 1e-12)) return null;
  return { x: (H[0] * x + H[1] * y + H[2]) / w, y: (H[3] * x + H[4] * y + H[5]) / w };
}

function invert3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-18) return null;
  const k = 1 / det;
  return [A * k, -(b * i - c * h) * k, (b * f - c * e) * k, B * k, (a * i - c * g) * k, -(a * f - c * d) * k, C * k, -(a * h - b * g) * k, (a * e - b * d) * k];
}

/**
 * Tarayıcı sarmalayıcısı. items: [{ image, G, area }] — area: karenin dolapta kapladığı alan.
 * Geniş kareler önce, yakın çekimler en üstte. Döner: { canvas, filled }.
 */
export function rectifyMosaic(items, outW, outH) {
  const sorted = items.slice().sort((a, b) => b.area - a.area);
  const sources = sorted.map((it) => {
    const w = it.image.width;
    const h = it.image.height;
    const c = makeCanvas(w, h);
    const ctx = c.getContext('2d');
    ctx.drawImage(it.image, 0, 0);
    return { data: ctx.getImageData(0, 0, w, h).data, width: w, height: h, G: it.G };
  });
  const { data, filled } = rectifyCore(sources, outW, outH);
  const canvas = makeCanvas(outW, outH);
  canvas.getContext('2d').putImageData(new ImageData(data, outW, outH), 0, 0);
  canvas.tileW = outW;
  canvas.tileH = outH;
  return { canvas, filled };
}
