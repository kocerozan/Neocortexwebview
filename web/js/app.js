import { toGray, estimateShift, refinePositions } from './tracker.js';
import { stitchPanorama } from './stitcher.js';
import { warpPerspective, suggestOutputSize, isConvexQuad } from './perspective.js';
import { mergeClips, pickMimeType, extensionFor } from './merger.js';
import { bridge } from './bridge.js';

const $ = (id) => document.getElementById(id);

// ---- Ayarlar ----
const PROC_W = 160; // takip karesi genişliği (px)
const KF_W = 720; // panorama için anahtar kare genişliği
const RADIUS = 24; // kare başına en büyük kayma (proc px)
const INSET = 0.15; // mavi boyanan "çekim bölgesi" kenar payı
const KF_STEP = 0.3; // bu kadar kare kayınca yeni anahtar kare
const MAX_KF = 160;
const MASK_W = 3200;
const MASK_H = 2400;
const COVER_COLOR = '#2F80ED';
const COVER_ALPHA = 0.42;

const S = {
  stream: null,
  vw: 0, vh: 0, PW: PROC_W, PH: 120, KW: KF_W, KH: 540,
  procCtx: null, prev: null, cur: null, hasPrev: false,
  pos: { x: 0, y: 0 }, speed: 0, lost: 0,
  mask: null, maskCtx: null, maskOX: 0, maskOY: 0, cover: null,
  recording: false, recorder: null, recStart: 0, stopPromise: Promise.resolve(), newClip: false,
  clips: [], keyframes: [], lastKf: null, mimeType: undefined,
  pano: null, corners: null, view: null,
  mergeGen: 0, mergePromise: null, merged: null, resultBlob: null, resultSize: null,
};
window.__neocortex = S; // test / hata ayıklama

// ---------------- Kamera ----------------

async function startCamera() {
  $('cam-error').classList.add('hidden');
  if (!navigator.mediaDevices?.getUserMedia) {
    return showCamError('Bu görünümde kamera desteklenmiyor. Sayfa HTTPS üzerinden açılmalı ve uygulamada kamera izni verilmeli.');
  }
  try {
    S.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    });
  } catch (err) {
    const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
    return showCamError(denied ? 'Kamera izni verilmedi. Ayarlardan kamera iznini açıp tekrar dene.' : `Kamera başlatılamadı (${err?.name || err}).`);
  }
  const v = $('preview');
  v.srcObject = S.stream;
  await v.play().catch(() => {});
  if (!v.videoWidth) await new Promise((r) => v.addEventListener('loadedmetadata', r, { once: true }));
  setupProc(v.videoWidth, v.videoHeight);
  scheduleTick();
  updateUI();
}

function showCamError(text) {
  $('cam-error-text').textContent = text;
  $('cam-error').classList.remove('hidden');
}

function setupProc(vw, vh) {
  S.vw = vw;
  S.vh = vh;
  S.PW = PROC_W;
  S.PH = Math.round((PROC_W * vh) / vw);
  const c = document.createElement('canvas');
  c.width = S.PW;
  c.height = S.PH;
  S.procCtx = c.getContext('2d', { willReadFrequently: true });
  S.prev = new Uint8Array(S.PW * S.PH);
  S.cur = new Uint8Array(S.PW * S.PH);
  S.hasPrev = false;
  S.KW = Math.min(KF_W, vw);
  S.KH = Math.round((S.KW * vh) / vw);
  if (!S.mask) {
    S.mask = document.createElement('canvas');
    S.mask.width = MASK_W;
    S.mask.height = MASK_H;
    S.maskCtx = S.mask.getContext('2d');
    S.maskCtx.fillStyle = COVER_COLOR;
  }
  S.maskOX = MASK_W / 2 - S.PW / 2;
  S.maskOY = MASK_H / 2 - S.PH / 2;
}

let rafPending = false;
function scheduleTick() {
  if (rafPending) return;
  rafPending = true;
  const v = $('preview');
  const run = () => {
    rafPending = false;
    try {
      tick();
    } catch (e) {
      console.error(e);
    }
    scheduleTick();
  };
  if (typeof v.requestVideoFrameCallback === 'function') v.requestVideoFrameCallback(run);
  else requestAnimationFrame(run);
}

function tick() {
  const v = $('preview');
  if (v.readyState < 2 || !v.videoWidth) return;
  if (v.videoWidth !== S.vw || v.videoHeight !== S.vh) setupProc(v.videoWidth, v.videoHeight);

  S.procCtx.drawImage(v, 0, 0, S.PW, S.PH);
  toGray(S.procCtx.getImageData(0, 0, S.PW, S.PH).data, S.cur);
  if (S.hasPrev) {
    const r = estimateShift(S.prev, S.cur, S.PW, S.PH, { radius: RADIUS });
    if (r.ok) {
      S.pos.x -= r.sx;
      S.pos.y -= r.sy;
      S.speed = Math.hypot(r.sx, r.sy);
      S.lost = 0;
    } else {
      S.speed = 0;
      S.lost++;
    }
  }
  [S.prev, S.cur] = [S.cur, S.prev]; // S.prev = bu kare
  S.hasPrev = true;

  if (S.recording) {
    paintCoverage();
    maybeKeyframe(v);
    updateTimer();
  }
  drawOverlay();
  drawMinimap();
  $('chip-speed').classList.toggle('hidden', !(S.recording && S.speed > RADIUS * 0.6));
}

// ---------------- Mavi kapsama katmanı ----------------

function zoneRect() {
  return {
    x: S.pos.x + INSET * S.PW,
    y: S.pos.y + INSET * S.PH,
    w: (1 - 2 * INSET) * S.PW,
    h: (1 - 2 * INSET) * S.PH,
  };
}

function paintCoverage() {
  const z = zoneRect();
  S.maskCtx.fillRect(S.maskOX + z.x, S.maskOY + z.y, z.w, z.h);
  const c = S.cover || { minX: z.x, minY: z.y, maxX: z.x + z.w, maxY: z.y + z.h };
  S.cover = {
    minX: Math.min(c.minX, z.x),
    minY: Math.min(c.minY, z.y),
    maxX: Math.max(c.maxX, z.x + z.w),
    maxY: Math.max(c.maxY, z.y + z.h),
  };
}

let ovCtx = null;
function drawOverlay() {
  const cv = $('overlay');
  const dpr = window.devicePixelRatio || 1;
  const dw = cv.clientWidth;
  const dh = cv.clientHeight;
  if (cv.width !== Math.round(dw * dpr) || cv.height !== Math.round(dh * dpr)) {
    cv.width = Math.round(dw * dpr);
    cv.height = Math.round(dh * dpr);
  }
  ovCtx ||= cv.getContext('2d');
  const ctx = ovCtx;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, dw, dh);
  if (!S.vw) return;
  // object-fit: contain eşlemesi
  const sc = Math.min(dw / S.vw, dh / S.vh);
  const fw = S.vw * sc;
  const fh = S.vh * sc;
  const ox = (dw - fw) / 2;
  const oy = (dh - fh) / 2;

  if (S.cover) {
    ctx.globalAlpha = COVER_ALPHA;
    ctx.imageSmoothingEnabled = true;
    drawImageClipped(ctx, S.mask, S.maskOX + S.pos.x, S.maskOY + S.pos.y, S.PW, S.PH, ox, oy, fw, fh);
    ctx.globalAlpha = 1;
  }

  // Kadraj köşeleri (çekim bölgesi)
  const zx = ox + INSET * fw;
  const zy = oy + INSET * fh;
  const zw = (1 - 2 * INSET) * fw;
  const zh = (1 - 2 * INSET) * fh;
  const L = Math.min(28, zw / 4, zh / 4);
  ctx.strokeStyle = S.recording ? '#FFFFFF' : 'rgba(255,255,255,.75)';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (const [x, y, dx, dy] of [
    [zx, zy, 1, 1],
    [zx + zw, zy, -1, 1],
    [zx + zw, zy + zh, -1, -1],
    [zx, zy + zh, 1, -1],
  ]) {
    ctx.moveTo(x + dx * L, y);
    ctx.lineTo(x, y);
    ctx.lineTo(x, y + dy * L);
  }
  ctx.stroke();
}

// Kaynak dikdörtgen tuval dışına taşarsa kırp (Safari taşan kaynakta hiç çizmeyebilir).
function drawImageClipped(ctx, img, sx, sy, sw, sh, dx, dy, dw, dh) {
  const kx = dw / sw;
  const ky = dh / sh;
  const x0 = Math.max(0, sx);
  const y0 = Math.max(0, sy);
  const x1 = Math.min(img.width, sx + sw);
  const y1 = Math.min(img.height, sy + sh);
  if (x1 <= x0 || y1 <= y0) return;
  ctx.drawImage(img, x0, y0, x1 - x0, y1 - y0, dx + (x0 - sx) * kx, dy + (y0 - sy) * ky, (x1 - x0) * kx, (y1 - y0) * ky);
}

let mmCtx = null;
function drawMinimap() {
  const cv = $('minimap');
  mmCtx ||= cv.getContext('2d');
  const ctx = mmCtx;
  ctx.clearRect(0, 0, cv.width, cv.height);
  const view = { minX: S.pos.x, minY: S.pos.y, maxX: S.pos.x + S.PW, maxY: S.pos.y + S.PH };
  const b = S.cover
    ? {
        minX: Math.min(S.cover.minX, view.minX),
        minY: Math.min(S.cover.minY, view.minY),
        maxX: Math.max(S.cover.maxX, view.maxX),
        maxY: Math.max(S.cover.maxY, view.maxY),
      }
    : view;
  const pad = 8;
  const bw = b.maxX - b.minX;
  const bh = b.maxY - b.minY;
  const s = Math.min((cv.width - 2 * pad) / bw, (cv.height - 2 * pad) / bh);
  const ox = (cv.width - bw * s) / 2;
  const oy = (cv.height - bh * s) / 2;
  if (S.cover) {
    drawImageClipped(ctx, S.mask, S.maskOX + b.minX, S.maskOY + b.minY, bw, bh, ox, oy, bw * s, bh * s);
  }
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 3;
  ctx.strokeRect(ox + (view.minX - b.minX) * s, oy + (view.minY - b.minY) * s, S.PW * s, S.PH * s);
}

// ---------------- Kayıt ----------------

function maybeKeyframe(v) {
  const last = S.lastKf;
  const moved = last && (Math.abs(S.pos.x - last.x) > KF_STEP * S.PW || Math.abs(S.pos.y - last.y) > KF_STEP * S.PH);
  if (!(S.newClip || !last || moved) || S.keyframes.length >= MAX_KF) return;
  S.newClip = false;
  const c = document.createElement('canvas');
  c.width = S.KW;
  c.height = S.KH;
  c.getContext('2d').drawImage(v, 0, 0, S.KW, S.KH);
  const kf = { x: S.pos.x, y: S.pos.y, gray: S.prev.slice(), w: S.PW, h: S.PH, clip: S.clips.length, blob: null };
  kf.ready = new Promise((res) =>
    c.toBlob(
      (b) => {
        kf.blob = b;
        res();
      },
      'image/jpeg',
      0.9,
    ),
  );
  S.keyframes.push(kf);
  S.lastKf = kf;
}

function startClip() {
  if (!S.stream || S.recording) return;
  if (typeof MediaRecorder === 'undefined') {
    toast('Bu cihazda video kaydı desteklenmiyor.');
    return;
  }
  if (S.mimeType === undefined) S.mimeType = pickMimeType();
  let rec;
  try {
    rec = new MediaRecorder(S.stream, S.mimeType ? { mimeType: S.mimeType, videoBitsPerSecond: 5_000_000 } : undefined);
  } catch {
    rec = new MediaRecorder(S.stream);
  }
  const chunks = [];
  rec.ondataavailable = (e) => e.data && e.data.size && chunks.push(e.data);
  S.stopPromise = new Promise((resolve) => {
    rec.onstop = () => {
      const type = rec.mimeType || S.mimeType || 'video/webm';
      S.clips.push({ blob: new Blob(chunks, { type }), duration: rec._duration || 0, mimeType: type });
      updateUI();
      resolve();
    };
  });
  rec.start(1000);
  S.recorder = rec;
  S.recording = true;
  S.newClip = true;
  S.recStart = performance.now();
  invalidateResults();
  updateUI();
}

function stopClip() {
  if (!S.recording) return S.stopPromise;
  S.recording = false;
  S.recorder._duration = (performance.now() - S.recStart) / 1000;
  S.recorder.stop();
  updateUI();
  return S.stopPromise;
}

function totalDuration() {
  const base = S.clips.reduce((s, c) => s + c.duration, 0);
  return base + (S.recording ? (performance.now() - S.recStart) / 1000 : 0);
}

const fmt = (sec) => {
  const s = Math.floor(sec);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

function updateTimer() {
  $('chip-time').textContent = fmt(totalDuration());
}

function updateUI() {
  const cam = $('screen-camera');
  cam.classList.toggle('is-recording', S.recording);
  $('btn-record').setAttribute('aria-label', S.recording ? 'Kaydı durdur' : 'Kaydı başlat');
  $('btn-record').disabled = !S.stream;
  $('chip-rec').classList.toggle('hidden', !S.recording);
  const n = S.clips.length + (S.recording ? 1 : 0);
  $('chip-clips').textContent = `${n} çekim`;
  $('btn-finish').disabled = S.recording || S.clips.length === 0;
  $('btn-reset').disabled = S.recording || (S.clips.length === 0 && !S.cover);
  updateTimer();
  if (S.recording) setHint('Yavaşça kaydır. Mavi alanlar çekildi; boş kalan yerleri tamamla.');
  else if (S.clips.length) setHint('Eksik yerleri yeni çekimle tamamla ya da Bitir’e bas.');
  else setHint(S.defaultHint);
}

function setHint(t) {
  $('info-hint').textContent = t;
}

function resetAll() {
  if (S.recording) return;
  S.mergeGen++;
  S.clips = [];
  S.keyframes = [];
  S.lastKf = null;
  S.cover = null;
  S.maskCtx?.clearRect(0, 0, MASK_W, MASK_H);
  S.pos = { x: 0, y: 0 };
  S.pano = null;
  S.corners = null;
  S.merged = null;
  S.mergePromise = null;
  S.resultBlob = null;
  showScreen('camera');
  updateUI();
}

function invalidateResults() {
  S.mergeGen++;
  S.merged = null;
  S.mergePromise = null;
  S.resultBlob = null;
}

// ---------------- Bitir: birleştir + panorama ----------------

async function finish() {
  await stopClip();
  if (!S.clips.length) return;
  showBusy('Çekimler birleştiriliyor…');
  startMerge();
  try {
    S.pano = await buildPanorama();
  } catch (e) {
    console.error(e);
    hideBusy();
    toast('Görüntü birleştirilemedi. Biraz daha yavaş tekrar çek.');
    return;
  }
  hideBusy();
  openPerspective();
}

function startMerge() {
  if (S.mergePromise) return S.mergePromise;
  const gen = S.mergeGen;
  const clips = S.clips.slice();
  setMergeState('running', 0);
  S.mergePromise = mergeClips(clips, {
    mimeType: S.mimeType,
    isCancelled: () => gen !== S.mergeGen,
    onProgress: (p) => gen === S.mergeGen && setMergeState('running', p),
  })
    .then((r) => {
      if (gen !== S.mergeGen) return null;
      S.merged = r;
      setMergeState('done', 1);
      return r;
    })
    .catch((e) => {
      console.error(e);
      if (gen !== S.mergeGen) return null;
      // Birleştirme olmazsa tek parça varsa onu kullan.
      if (clips.length === 1) {
        S.merged = { blob: clips[0].blob, mimeType: clips[0].mimeType, duration: clips[0].duration };
        setMergeState('done', 1);
        return S.merged;
      }
      setMergeState('error', 0, e.message);
      return null;
    });
  return S.mergePromise;
}

let mergedUrl = null;
function setMergeState(state, p, msg) {
  $('merge-bar').style.width = `${Math.round(p * 100)}%`;
  $('merge-progress').classList.toggle('hidden', state !== 'running');
  const badge = $('merge-badge');
  badge.className = 'badge' + (state === 'done' ? ' ok' : state === 'error' ? ' err' : '');
  badge.textContent = state === 'done' ? 'Videolar birleştirildi' : state === 'error' ? 'Birleştirilemedi' : `Videolar birleştiriliyor %${Math.round(p * 100)}`;
  $('merge-error').classList.toggle('hidden', state !== 'error');
  $('merge-error').textContent = msg || '';
  const vid = $('merged-video');
  $('btn-save-video').disabled = !(state === 'done' && S.merged);
  $('btn-save-video-text').textContent =
    state === 'running' ? `Video hazırlanıyor %${Math.round(p * 100)}` : state === 'error' ? 'Video hazırlanamadı' : 'Videoyu kaydet';
  if (state === 'done' && S.merged) {
    if (mergedUrl) URL.revokeObjectURL(mergedUrl);
    mergedUrl = URL.createObjectURL(S.merged.blob);
    vid.src = mergedUrl;
    vid.classList.remove('hidden');
    $('merge-meta').textContent = `${S.clips.length} çekim · ${fmt(S.merged.duration)} · ${(S.merged.blob.size / 1048576).toFixed(1)} MB`;
  } else {
    vid.classList.add('hidden');
    $('merge-meta').textContent = `${S.clips.length} çekim`;
  }
}

async function decodeImage(blob) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob);
    } catch {
      /* aşağıdaki yola düş */
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

async function buildPanorama() {
  await Promise.all(S.keyframes.map((k) => k.ready));
  const kfs = S.keyframes.filter((k) => k.blob);
  if (!kfs.length) throw new Error('Anahtar kare yok');
  const positions = refinePositions(kfs);
  const images = await Promise.all(kfs.map((k) => decodeImage(k.blob)));
  return stitchPanorama(
    images.map((image, i) => ({ image, x: positions[i].x, y: positions[i].y })),
    { procW: S.PW, procH: S.PH, scale: S.KW / S.PW },
  );
}

// ---------------- Perspektif ----------------

const handles = [...document.querySelectorAll('.handle')];

function openPerspective() {
  const c = $('pano');
  c.width = S.pano.width;
  c.height = S.pano.height;
  c.getContext('2d').drawImage(S.pano, 0, 0);
  if (!S.corners) {
    const w = S.pano.width;
    const h = S.pano.height;
    const m = 0.04;
    S.corners = [
      { x: w * m, y: h * m },
      { x: w * (1 - m), y: h * m },
      { x: w * (1 - m), y: h * (1 - m) },
      { x: w * m, y: h * (1 - m) },
    ];
  }
  showScreen('perspective');
  layoutStage();
}

function layoutStage() {
  if (!S.pano) return;
  const st = $('stage');
  const pad = 26;
  const sw = st.clientWidth - 2 * pad;
  const sh = st.clientHeight - 2 * pad;
  const s = Math.min(sw / S.pano.width, sh / S.pano.height);
  const w = S.pano.width * s;
  const h = S.pano.height * s;
  S.view = { s, left: (st.clientWidth - w) / 2, top: (st.clientHeight - h) / 2 };
  const c = $('pano');
  Object.assign(c.style, { width: `${w}px`, height: `${h}px`, left: `${S.view.left}px`, top: `${S.view.top}px` });
  positionHandles();
}

function toStage(p) {
  return { x: S.view.left + p.x * S.view.s, y: S.view.top + p.y * S.view.s };
}

function positionHandles() {
  const pts = S.corners.map(toStage);
  handles.forEach((h, i) => (h.style.transform = `translate(${pts[i].x}px, ${pts[i].y}px)`));
  $('quad-poly').setAttribute('points', pts.map((p) => `${p.x},${p.y}`).join(' '));
  const ok = isConvexQuad(S.corners);
  const info = $('persp-info');
  info.classList.toggle('error', !ok);
  if (ok) {
    const { width, height } = suggestOutputSize(S.corners);
    info.textContent = `Çıktı: ${width} × ${height} px`;
  } else info.textContent = 'Köşeler çaprazlandı. Sırayı koru: sol-üst, sağ-üst, sağ-alt, sol-alt.';
  $('btn-apply').disabled = !ok;
}

function drawLoupe(i) {
  const lp = $('loupe');
  const p = S.corners[i];
  const sp = toStage(p);
  const ctx = lp.getContext('2d');
  const zoom = 3; // ekran büyütmesine göre
  const srcR = lp.width / 2 / (zoom * S.view.s * 2); // loupe iki kat çözünürlüklü
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, lp.width, lp.height);
  ctx.drawImage($('pano'), p.x - srcR, p.y - srcR, srcR * 2, srcR * 2, 0, 0, lp.width, lp.height);
  ctx.strokeStyle = COVER_COLOR;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(lp.width / 2 - 16, lp.height / 2);
  ctx.lineTo(lp.width / 2 + 16, lp.height / 2);
  ctx.moveTo(lp.width / 2, lp.height / 2 - 16);
  ctx.lineTo(lp.width / 2, lp.height / 2 + 16);
  ctx.stroke();
  const st = $('stage');
  const size = 112;
  let x = sp.x - size / 2;
  let y = sp.y - size - 40;
  if (y < 4) y = sp.y + 40;
  x = Math.max(4, Math.min(st.clientWidth - size - 4, x));
  Object.assign(lp.style, { left: `${x}px`, top: `${y}px` });
  lp.classList.remove('hidden');
}

handles.forEach((h, i) => {
  let dragging = false;
  let grab = { x: 0, y: 0 };
  h.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    h.setPointerCapture(e.pointerId);
    dragging = true;
    const r = $('stage').getBoundingClientRect();
    const sp = toStage(S.corners[i]);
    grab = { x: e.clientX - r.left - sp.x, y: e.clientY - r.top - sp.y };
    drawLoupe(i);
  });
  h.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const r = $('stage').getBoundingClientRect();
    const x = (e.clientX - r.left - grab.x - S.view.left) / S.view.s;
    const y = (e.clientY - r.top - grab.y - S.view.top) / S.view.s;
    S.corners[i] = {
      x: Math.max(0, Math.min(S.pano.width, x)),
      y: Math.max(0, Math.min(S.pano.height, y)),
    };
    positionHandles();
    drawLoupe(i);
  });
  const end = () => {
    dragging = false;
    $('loupe').classList.add('hidden');
  };
  h.addEventListener('pointerup', end);
  h.addEventListener('pointercancel', end);
});

let resultUrl = null;
async function applyPerspective() {
  if (!isConvexQuad(S.corners)) return;
  showBusy('Perspektif düzeltiliyor…');
  await new Promise((r) => setTimeout(r, 30));
  try {
    const pc = $('pano');
    const src = pc.getContext('2d').getImageData(0, 0, pc.width, pc.height);
    const { width, height } = suggestOutputSize(S.corners, 3000);
    const out = warpPerspective(src, S.corners, width, height);
    const rc = $('result-canvas');
    rc.width = width;
    rc.height = height;
    rc.getContext('2d').putImageData(new ImageData(out.data, width, height), 0, 0);
    S.resultBlob = await new Promise((r) => rc.toBlob(r, 'image/jpeg', 0.9));
    S.resultSize = { width, height };
    $('result-size').textContent = `${width} × ${height} px`;
    $('result-sub').textContent = `${S.clips.length} çekim · ${fmt(S.clips.reduce((s, c) => s + c.duration, 0))}`;
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    resultUrl = URL.createObjectURL(S.resultBlob);
    $('result-img').src = resultUrl;
    // Native uygulamada "Gönder", tarayıcıda "Kaydet" butonları
    $('btn-send').classList.toggle('hidden', !bridge.available);
    $('btn-save-photo').classList.toggle('hidden', bridge.available);
    $('btn-save-video').classList.toggle('hidden', bridge.available);
    $('save-hint').classList.toggle('hidden', bridge.available);
    startMerge();
    if (S.merged) setMergeState('done', 1);
    showScreen('result');
  } catch (e) {
    console.error(e);
    toast('Perspektif uygulanamadı.');
  } finally {
    hideBusy();
  }
}

// ---------------- Gönder / indir ----------------

async function send() {
  if (!S.resultBlob) return;
  const btn = $('btn-send');
  btn.disabled = true;
  try {
    if (!S.merged) {
      showBusy('Videolar birleştiriliyor…');
      await startMerge();
    }
    const merged = S.merged;
    showBusy('Gönderiliyor…');
    const imageId = await bridge.sendBlob('image', S.resultBlob, { ...S.resultSize });
    let videoId = null;
    if (merged) {
      videoId = await bridge.sendBlob('video', merged.blob, { duration: merged.duration, clips: S.clips.length }, (p) =>
        setBusyText(`Video gönderiliyor %${Math.round(p * 100)}`),
      );
    }
    bridge.post({ type: 'result.complete', imageId, videoId, clips: S.clips.length });
    toast('Gönderildi');
  } catch (e) {
    console.error(e);
    toast('Gönderilemedi, tekrar dene.');
  } finally {
    hideBusy();
    btn.disabled = false;
  }
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

// Telefonda paylaşım menüsü açılır ("Görüntüyü Kaydet" / "Videoyu Kaydet" ile galeriye),
// desteklenmezse dosya indirilir.
async function saveFile(blob, name) {
  try {
    const file = new File([blob], name, { type: blob.type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file] });
      return true;
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return false; // kullanıcı vazgeçti
    console.warn('Paylaşım açılamadı, indirmeye geçiliyor', e);
  }
  download(blob, name);
  toast('İndirildi');
  return true;
}

function savePhoto() {
  if (S.resultBlob) saveFile(S.resultBlob, `neocortex-perspektif-${stamp()}.jpg`);
}

function saveVideo() {
  const m = S.merged;
  if (m) saveFile(m.blob, `neocortex-video-${stamp()}.${extensionFor(m.mimeType)}`);
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// ---------------- Ekranlar ve katmanlar ----------------

function showScreen(name) {
  for (const n of ['perspective', 'result']) $(`screen-${n}`).classList.toggle('hidden', n !== name);
  S.screen = name;
}

function showBusy(text) {
  setBusyText(text);
  $('busy').classList.remove('hidden');
}
function setBusyText(text) {
  $('busy-text').textContent = text;
}
function hideBusy() {
  $('busy').classList.add('hidden');
}

let toastTimer = 0;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2600);
}

function confirmSheet({ title, text, warn, ok }) {
  return new Promise((resolve) => {
    $('sheet-title').textContent = title;
    $('sheet-text').textContent = text;
    $('sheet-warn').textContent = warn;
    $('sheet-ok').textContent = ok;
    $('sheet').classList.remove('hidden');
    const done = (v) => {
      $('sheet').classList.add('hidden');
      $('sheet-ok').onclick = $('sheet-cancel').onclick = $('sheet').onclick = null;
      resolve(v);
    };
    $('sheet-ok').onclick = () => done(true);
    $('sheet-cancel').onclick = () => done(false);
    $('sheet').onclick = (e) => e.target === $('sheet') && done(false);
  });
}

async function askReset() {
  const yes = await confirmSheet({
    title: 'Çekimler silinsin mi?',
    text: `${S.clips.length} çekim ve mavi kapsama alanı silinecek.`,
    warn: 'Bu işlem geri alınamaz. Baştan çekmen gerekecek.',
    ok: 'Sil ve baştan başla',
  });
  if (yes) resetAll();
}

// ---------------- Olaylar ----------------

$('btn-record').addEventListener('click', () => (S.recording ? stopClip() : startClip()));
$('btn-finish').addEventListener('click', finish);
$('btn-reset').addEventListener('click', askReset);
$('btn-retry').addEventListener('click', startCamera);
$('btn-close').addEventListener('click', () => bridge.post({ type: 'close' }));
$('btn-apply').addEventListener('click', applyPerspective);
$('btn-continue').addEventListener('click', () => showScreen('camera'));
$('btn-persp-back').addEventListener('click', () => showScreen('camera'));
$('btn-result-back').addEventListener('click', () => {
  showScreen('perspective');
  layoutStage();
});
$('btn-send').addEventListener('click', send);
$('btn-save-photo').addEventListener('click', savePhoto);
$('btn-save-video').addEventListener('click', saveVideo);
$('btn-restart').addEventListener('click', askReset);
window.addEventListener('resize', () => S.screen === 'perspective' && layoutStage());

// Native → Web API
window.NeoCortex = {
  reset: resetAll,
  setInfo({ title, hint } = {}) {
    if (title) $('info-title').textContent = title;
    if (hint) {
      S.defaultHint = hint;
      updateUI();
    }
  },
  state: () => ({ clips: S.clips.length, recording: S.recording, screen: S.screen }),
};

// URL parametreleri: ?title=...&hint=...
const params = new URLSearchParams(location.search);
S.defaultHint = params.get('hint') || $('info-hint').textContent;
if (params.get('title')) $('info-title').textContent = params.get('title');
S.screen = 'camera';

startCamera().then(() => bridge.post({ type: 'ready', version: 1, platform: bridge.platform }));
