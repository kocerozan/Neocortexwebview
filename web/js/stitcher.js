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
  return pano;
}
