// Çekilen video parçalarını tek videoda birleştirir.
// Tarayıcıda kodlayıcı olmadığı için parçalar sırayla bir tuvale oynatılır ve
// tuvalin akışı MediaRecorder ile kaydedilir (süre ≈ toplam çekim süresi).

const CANDIDATES = [
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4;codecs=avc1',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
];

export function pickMimeType() {
  if (typeof MediaRecorder === 'undefined') return null;
  if (typeof MediaRecorder.isTypeSupported !== 'function') return '';
  return CANDIDATES.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

export function extensionFor(mime) {
  return /mp4/.test(mime || '') ? 'mp4' : 'webm';
}

function once(el, ev) {
  return new Promise((resolve, reject) => {
    const ok = () => {
      el.removeEventListener('error', fail);
      resolve();
    };
    const fail = () => {
      el.removeEventListener(ev, ok);
      reject(new Error('Video açılamadı'));
    };
    el.addEventListener(ev, ok, { once: true });
    el.addEventListener('error', fail, { once: true });
  });
}

function fit(sw, sh, dw, dh) {
  const s = Math.min(dw / sw, dh / sh);
  const w = sw * s;
  const h = sh * s;
  return [(dw - w) / 2, (dh - h) / 2, w, h];
}

/**
 * @param {{blob: Blob, duration: number}[]} clips
 * @returns {Promise<{blob: Blob, mimeType: string, duration: number, width: number, height: number}>}
 */
export async function mergeClips(clips, { mimeType, onProgress = () => {}, fps = 30, maxSide = 1280, isCancelled = () => false } = {}) {
  if (!clips.length) throw new Error('Birleştirilecek video yok');
  const total = clips.reduce((s, c) => s + c.duration, 0) || 1;

  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.setAttribute('playsinline', '');
  v.setAttribute('muted', '');
  v.preload = 'auto';
  // Bazı WebView'ler görünmeyen videoyu çözmez; sayfa dışında ama DOM'da tut.
  Object.assign(v.style, { position: 'fixed', left: '-10px', top: '-10px', width: '2px', height: '2px', opacity: '0', pointerEvents: 'none' });
  document.body.appendChild(v);

  const urls = clips.map((c) => URL.createObjectURL(c.blob));
  try {
    v.src = urls[0];
    await once(v, 'loadeddata');
    const s = Math.min(1, maxSide / Math.max(v.videoWidth, v.videoHeight));
    const W = Math.round((v.videoWidth * s) / 2) * 2;
    const H = Math.round((v.videoHeight * s) / 2) * 2;

    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    const stream = canvas.captureStream(fps);
    const rec = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: 4_000_000 } : undefined);
    const chunks = [];
    rec.ondataavailable = (e) => e.data && e.data.size && chunks.push(e.data);
    const stopped = new Promise((r) => (rec.onstop = r));

    let done = 0;
    for (let i = 0; i < clips.length; i++) {
      if (isCancelled()) break;
      if (i > 0) {
        v.src = urls[i];
        await once(v, 'loadeddata');
      }
      const draw = () => {
        ctx.fillRect(0, 0, W, H);
        ctx.drawImage(v, ...fit(v.videoWidth, v.videoHeight, W, H));
      };
      draw();
      if (i === 0) rec.start(500);
      else rec.resume();
      await v.play();
      await new Promise((resolve) => {
        const finish = () => {
          draw();
          resolve();
        };
        v.onended = finish;
        const loop = () => {
          if (v.ended) return finish();
          if (isCancelled()) {
            v.pause();
            return finish();
          }
          draw();
          onProgress(Math.min(0.99, (done + Math.min(v.currentTime, clips[i].duration)) / total));
          requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
      });
      v.onended = null;
      // Parçalar arasında kaydı duraklat — siyah boşluk oluşmasın.
      if (rec.state === 'recording') rec.pause();
      done += clips[i].duration;
    }
    if (rec.state === 'paused') rec.resume();
    if (rec.state !== 'inactive') rec.stop();
    await stopped;
    stream.getTracks().forEach((t) => t.stop());
    onProgress(1);
    const type = rec.mimeType || mimeType || 'video/webm';
    return { blob: new Blob(chunks, { type }), mimeType: type, duration: total, width: W, height: H };
  } finally {
    urls.forEach((u) => URL.revokeObjectURL(u));
    v.remove();
  }
}
