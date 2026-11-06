import { toGray, estimateShift, refinePositions } from './tracker.js';
import { stitchPanorama, rectifyMosaic } from './stitcher.js';
import { warpPerspective, suggestOutputSize, isConvexQuad, phoneFocal } from './perspective.js';
import { mergeClips, pickMimeType, extensionFor } from './merger.js';
import { bridge } from './bridge.js';
import { analyze } from './analysis.js';
import { detectQuad } from './detector.js';
import { APP_VERSION, CHANGELOG, entriesToShow } from './changelog.js';
import { CabinetLock } from './cabinetlock.js';
import { applyH } from './homotrack.js';
import { DoorMonitor, sampleRect } from './door.js';

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
const DET_W = 384; // dolap algılama ve kilit takibi karesi genişliği
const DET_MS = 500; // canlı algılama aralığı (kilitliyken 2 katı: yalnız kayma düzeltmesi için)
const CLOSE_AREA = 2.0; // kare en fazla 2 dolap alanı görüyorsa (dolap ekranın yarısından fazlası) "yakın çekim": mavi boyanır
const DET_COLOR = '#34C759';

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
  mode: 'camera', upload: null, stats: null, analysis: null, lastT: 0,
  det: null, lastDet: 0, detCtx: null, detGray: null, cornersAuto: false, cornersTouched: false,
  lock: null, lockNewClip: false, lockArmed: true, rectified: false, rectFilled: 0,
  door: null, detRGBA: null, doorTick: 0,
};
const newDet = () => ({ q: null, pos: { x: 0, y: 0 }, hits: 0, misses: 0, shown: false });
S.det = newDet();
const newStats = () => ({ frames: 0, okFrames: 0, fastFrames: 0, speeds: [], ys: [] });
S.stats = newStats();
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
  // Yüklenen videoda video zamanı, kamerada gerçek zaman
  const t = S.mode === 'upload' ? v.currentTime : performance.now() / 1000;
  const dt = t - S.lastT;
  S.lastT = t;
  if (S.hasPrev) {
    const r = estimateShift(S.prev, S.cur, S.PW, S.PH, { radius: RADIUS });
    if (S.recording) collectStats(r, dt);
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
  lockAndDetect(v);
  drawOverlay();
  drawMinimap();
  $('chip-speed').classList.toggle('hidden', !(S.recording && S.speed > RADIUS * 0.6));
}

function collectStats(r, dt) {
  const st = S.stats;
  st.frames++;
  if (r.ok) {
    st.okFrames++;
    if (dt > 0 && dt < 0.5) st.speeds.push(Math.hypot(r.sx / S.PW, r.sy / S.PH) / dt);
  }
  if (r.ok && Math.hypot(r.sx, r.sy) > RADIUS * 0.6) st.fastFrames++;
  st.ys.push(S.pos.y / S.PH);
}

// ---------------- Dolap algılama (canlı) ----------------

function grayOf(source, w, h) {
  if (!S.detCtx || S.detCtx.canvas.width !== w || S.detCtx.canvas.height !== h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    S.detCtx = c.getContext('2d', { willReadFrequently: true });
    S.detGray = new Uint8Array(w * h);
  }
  const ctx = S.detCtx;
  ctx.fillStyle = '#808080'; // panoramadaki saydam alanlar sahte kenar üretmesin
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(source, 0, 0, w, h);
  const rgba = ctx.getImageData(0, 0, w, h).data;
  S.detRGBA = rgba; // kapak tespiti renkli örnek alır
  return toGray(rgba, S.detGray);
}

// Takip karesi (DET_W genişlik): kilitliyken her karede, değilse algılama zamanında alınır.
function lockAndDetect(v) {
  const dw = DET_W;
  const dh = Math.round((DET_W * S.vh) / S.vw);
  if (!S.lock || S.lock.w !== dw || S.lock.h !== dh) {
    S.lock = new CabinetLock(dw, dh);
    updateLockChip();
  }
  const L = S.lock;
  const now = performance.now();
  const detDue = now - S.lastDet >= (L.active ? DET_MS * 2 : DET_MS);
  if (!L.active && !detDue) return;
  const g = grayOf(v, dw, dh);
  if (L.active) {
    L.update(g);
    if (L.okThisFrame) checkDoor(v, dw, dh);
    if (L.state === 'lost') {
      updateLockChip();
      toast('Dolap takibi kayboldu. Dolabın tamamını kadraja al, kendiliğinden devam eder.');
    } else if (S.recording) {
      // Yakın çekim kapsaması ve anahtar kareler (dolap koordinatlarında)
      const zone = [
        { x: INSET * dw, y: INSET * dh },
        { x: (1 - INSET) * dw, y: INSET * dh },
        { x: (1 - INSET) * dw, y: (1 - INSET) * dh },
        { x: INSET * dw, y: (1 - INSET) * dh },
      ];
      const frame = [
        { x: 0, y: 0 },
        { x: dw, y: 0 },
        { x: dw, y: dh },
        { x: 0, y: dh },
      ];
      // Mavi kapsama yalnız yakın çekimde: dolap ekranı dolduruyorsa
      const close = L.viewArea(frame) <= CLOSE_AREA;
      if (close) L.paint(zone);
      setLockHint(close ? 'close' : 'far');
      const k = L.keyframeNeeded(frame, S.lockNewClip);
      if (k) {
        S.lockNewClip = false;
        captureLockKeyframe(v, k);
      }
    }
  }
  if (detDue) {
    S.lastDet = now;
    maybeDetect(g, dw, dh);
  }
}

// Kapak durumu: kilitli dolabın düz görüntüsünden 2 karede bir örnek (≈15/sn)
function checkDoor(v, dw, dh) {
  if (!S.door || !S.detRGBA) return;
  if (++S.doorTick % 2) return;
  const t = S.mode === 'upload' ? v.currentTime : performance.now() / 1000;
  // Kameranın dolaba göre son ~1 sn'deki hareketi (yansıma ancak kamera kıpırdayınca ayırt edilir)
  const q = S.lock.quad;
  const c = { x: (q[0].x + q[1].x + q[2].x + q[3].x) / 4, y: (q[0].y + q[1].y + q[2].y + q[3].y) / 4 };
  const diag = Math.hypot(q[2].x - q[0].x, q[2].y - q[0].y);
  S.quadHist = (S.quadHist || []).filter((e) => t - e.t < 1.2 && e.t <= t);
  S.quadHist.push({ t, c, diag });
  let motion = 0;
  for (const e of S.quadHist) motion = Math.max(motion, Math.hypot(e.c.x - c.x, e.c.y - c.y) / diag + Math.abs(Math.log(e.diag / diag)));
  const ev = S.door.update(sampleRect(S.detRGBA, dw, dh, S.lock.Ginv(), 64, 48), t, motion);
  if (ev === 'opened') toast('Kapak açıldı');
  if (ev === 'closed') toast('Kapak kapandı');
  if (ev === 'glare') toast('Camda yansıma görüldü: kapak kapalı');
  updateDoorChip();
}

function updateDoorChip() {
  const chip = $('chip-door');
  const D = S.door;
  chip.classList.toggle('hidden', !(S.lock && S.lock.used && D));
  if (!D) return;
  const txt = D.moving
    ? 'Kapak hareket ediyor…'
    : D.state === 'open'
      ? 'Kapak: açık'
      : D.state === 'closed'
        ? D.reason === 'yansıma' ? 'Kapak: kapalı · yansıma' : 'Kapak: kapalı'
        : 'Kapak: ?';
  chip.classList.toggle('paused', D.paused); // yakın çekimde değerlendirme duraklar
  if ($('chip-door-text').textContent !== txt) $('chip-door-text').textContent = txt;
  chip.classList.toggle('open', D.state === 'open' && !D.moving);
  chip.title = D.reason === 'yansıma' ? 'Camda kamera ile kayan yansıma görüldü' : D.reason === 'hareket' ? 'Kapak hareketi görüldü' : 'Kapak hareketi ya da cam yansıması henüz görülmedi';
}

function captureLockKeyframe(v, k) {
  const c = document.createElement('canvas');
  c.width = S.KW;
  c.height = S.KH;
  c.getContext('2d').drawImage(v, 0, 0, S.KW, S.KH);
  const kf = { G: S.lock.keyframeG(k.G, S.KW, S.KH), area: k.area, blob: null };
  kf.ready = new Promise((res) =>
    c.toBlob(
      (b) => {
        kf.blob = b;
        res();
      },
      'image/jpeg',
      0.92,
    ),
  );
  S.lock.kfs.push(kf);
}

let lockHint = null;
function setLockHint(kind) {
  if (lockHint === kind) return;
  lockHint = kind;
  if (kind === 'far') setHint('Dolap kilitli. Yaklaş; dolap ekranı doldurunca çektiğin yerler maviye boyanır.');
  else if (kind === 'close') setHint('Yakın çekim. Mini haritada mavi olmayan yerleri de çek.');
}

function updateLockChip() {
  const chip = $('chip-det');
  const st = S.lock ? S.lock.state : 'off';
  chip.classList.toggle('warn', st === 'lost');
  chip.classList.toggle('det', st !== 'lost');
  $('chip-det-text').textContent = st === 'on' ? 'Dolap kilitli' : st === 'lost' ? 'Dolap aranıyor…' : 'Dolap algılandı';
  chip.classList.toggle('hidden', st === 'off' && !S.det.shown);
}

async function askUnlock() {
  if (!S.lock || !S.lock.used) return;
  const yes = await confirmSheet({
    title: 'Dolap kilidi kaldırılsın mı?',
    text: 'Çerçeve dolaptan ayrılır. Başka bir dolap çekeceksen kaldır.',
    warn: 'Bu dolap için yaptığın yakın çekim kapsaması ve dolap kareleri silinir.',
    ok: 'Kilidi kaldır',
  });
  if (!yes) return;
  S.lock = null;
  S.door = null;
  S.lockArmed = false; // dolap kadrajdan çıkana kadar yeniden kilitleme
  S.det = newDet();
  updateLockChip();
  updateDoorChip();
}

function maybeDetect(g, dw, dh) {
  const r = detectQuad(g, dw, dh);
  const d = S.det;
  // Önceki çerçeveyi kamera hareketi kadar kaydır (karşılaştırma için)
  const sx = -(S.pos.x - d.pos.x) / S.PW;
  const sy = -(S.pos.y - d.pos.y) / S.PH;
  const prev = d.q && d.q.map((p) => ({ x: p.x + sx, y: p.y + sy }));
  d.pos = { ...S.pos };
  if (r) {
    const q = r.corners.map((p) => ({ x: p.x / dw, y: p.y / dh }));
    const close = prev && q.every((p, i) => Math.hypot(p.x - prev[i].x, p.y - prev[i].y) < 0.08);
    d.q = close ? prev.map((p, i) => ({ x: (p.x + q[i].x) / 2, y: (p.y + q[i].y) / 2 })) : q;
    d.hits = close ? d.hits + 1 : 1;
    d.misses = 0;
  } else {
    d.q = prev;
    if (++d.misses >= 3) {
      d.hits = 0;
      d.q = null;
    }
  }
  const shown = d.hits >= 2 && !!d.q;
  d.shown = shown;
  if (!shown && d.misses >= 3) S.lockArmed = true; // dolap kadrajdan çıktı: yeniden kilitlenebilir
  // Kilitleme / yeniden yakalama / kayma düzeltme
  const L = S.lock;
  if (r && L) {
    if (L.state === 'on') L.onDetection(r.corners, g);
    else if (shown && S.lockArmed) {
      const res = L.onDetection(r.corners, g);
      if (res === 'locked') {
        S.door = new DoorMonitor();
        toast('Dolap kilitlendi. Yaklaşıp yakın çekim yapabilirsin, çerçeve dolabın üstünde kalır.');
      }
      if (res === 'relocked') toast('Dolap yeniden bulundu.');
    }
  }
  updateLockChip();
  updateDoorChip();
}

function drawDetection(ctx, ox, oy, fw, fh) {
  const d = S.det;
  if (!d.shown || !d.q || (S.lock && S.lock.active)) return;
  // Algılamalar arasında çerçeve kamera hareketiyle birlikte kayar
  const sx = -(S.pos.x - d.pos.x) / S.PW;
  const sy = -(S.pos.y - d.pos.y) / S.PH;
  const pts = d.q.map((p) => ({ x: ox + (p.x + sx) * fw, y: oy + (p.y + sy) * fh }));
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
  ctx.fillStyle = 'rgba(52,199,89,0.10)';
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = DET_COLOR;
  ctx.stroke();
  ctx.fillStyle = DET_COLOR;
  for (const p of pts) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
    ctx.fill();
  }
  const label = 'Dolap';
  ctx.font = '600 13px Roboto, system-ui, sans-serif';
  const tw = ctx.measureText(label).width + 16;
  const lx = Math.max(4, Math.min(pts[0].x, fw + ox - tw - 4));
  const ly = Math.max(4, pts[0].y - 28);
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(lx, ly, tw, 22, 11);
  else ctx.rect(lx, ly, tw, 22);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.fillText(label, lx + 8, ly + 15.5);
}

// Kilitli dolap çerçevesi ve dolabın üstündeki mavi kapsama
function drawLock(ctx, ox, oy, fw, fh) {
  const L = S.lock;
  if (!L || !L.active || !L.quad) return;
  const kx = fw / L.w;
  const ky = fh / L.h;
  const toD = (p) => ({ x: ox + p.x * kx, y: oy + p.y * ky });
  const qd = L.quad.map(toD);
  const quadPath = () => {
    ctx.beginPath();
    qd.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
  };
  if (L.polys.length) {
    const Gi = L.Ginv();
    ctx.save();
    quadPath();
    ctx.clip();
    ctx.beginPath();
    for (const poly of L.polys) {
      const pts = poly.map((u) => applyH(Gi, u.x, u.y));
      if (pts.some((p) => !p)) continue;
      pts.forEach((p, i) => {
        const d = toD(p);
        if (i) ctx.lineTo(d.x, d.y);
        else ctx.moveTo(d.x, d.y);
      });
      ctx.closePath();
    }
    ctx.globalAlpha = COVER_ALPHA;
    ctx.fillStyle = COVER_COLOR;
    ctx.fill('nonzero');
    ctx.restore();
    ctx.globalAlpha = 1;
  }
  quadPath();
  ctx.lineWidth = 4;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = DET_COLOR;
  ctx.stroke();
  ctx.fillStyle = DET_COLOR;
  const onScreen = qd.filter((p) => p.x >= ox && p.y >= oy && p.x <= ox + fw && p.y <= oy + fh);
  for (const p of onScreen) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
    ctx.fill();
  }
  // Etiket: görünen sol-üst köşede, köşe ekran dışındaysa ekranın sol üstünde
  const label = 'Dolap · kilitli';
  ctx.font = '600 13px Roboto, system-ui, sans-serif';
  const tw = ctx.measureText(label).width + 16;
  const anchor = qd[0].x >= ox && qd[0].y >= oy + 30 && qd[0].x <= ox + fw && qd[0].y <= oy + fh ? qd[0] : { x: ox + 8, y: oy + 36 };
  const lx = Math.max(ox + 4, Math.min(anchor.x, ox + fw - tw - 4));
  const ly = Math.max(oy + 4, anchor.y - 28);
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(lx, ly, tw, 22, 11);
  else ctx.rect(lx, ly, tw, 22);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.fillText(label, lx + 8, ly + 15.5);
}

function drawLockMinimap(ctx, cv) {
  const L = S.lock;
  const a = L.aspect;
  const pad = 8;
  const aw = cv.width - 2 * pad;
  const ah = cv.height - 2 * pad;
  const dw = Math.min(aw, ah * a);
  const dh = dw / a;
  const ox = (cv.width - dw) / 2;
  const oy = (cv.height - dh) / 2;
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  ctx.fillRect(ox, oy, dw, dh);
  if (L.mask) ctx.drawImage(L.mask, ox, oy, dw, dh);
  ctx.strokeStyle = DET_COLOR;
  ctx.lineWidth = 3;
  ctx.strokeRect(ox, oy, dw, dh);
  if (L.active) {
    const v = L.viewOnCabinet([
      { x: 0, y: 0 },
      { x: L.w, y: 0 },
      { x: L.w, y: L.h },
      { x: 0, y: L.h },
    ]);
    if (v) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(2, 2, cv.width - 4, cv.height - 4);
      ctx.clip();
      ctx.beginPath();
      v.forEach((p, i) => (i ? ctx.lineTo(ox + p.x * dw, oy + p.y * dh) : ctx.moveTo(ox + p.x * dw, oy + p.y * dh)));
      ctx.closePath();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.restore();
    }
  }
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

  if (S.cover && !(S.lock && S.lock.used)) {
    ctx.globalAlpha = COVER_ALPHA;
    ctx.imageSmoothingEnabled = true;
    drawImageClipped(ctx, S.mask, S.maskOX + S.pos.x, S.maskOY + S.pos.y, S.PW, S.PH, ox, oy, fw, fh);
    ctx.globalAlpha = 1;
  }
  drawDetection(ctx, ox, oy, fw, fh);
  drawLock(ctx, ox, oy, fw, fh);

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
  if (S.lock && S.lock.used) return drawLockMinimap(ctx, cv);
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
  S.lockNewClip = true;
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
  if (S.mode === 'upload') return $('preview').currentTime || 0;
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
  lockHint = null;
  const cam = $('screen-camera');
  cam.classList.toggle('is-recording', S.recording);
  $('btn-record').setAttribute('aria-label', S.recording ? 'Kaydı durdur' : 'Kaydı başlat');
  $('btn-record').disabled = !S.stream;
  $('chip-rec').classList.toggle('hidden', !S.recording);
  $('chip-rec-text').textContent = S.mode === 'upload' ? 'VİDEO' : 'KAYIT';
  const n = S.clips.length + (S.recording ? 1 : 0);
  $('chip-clips').textContent = S.mode === 'upload' ? 'Yüklenen video' : `${n} çekim`;
  const uploadReady = S.mode === 'upload' && S.keyframes.length > 0;
  $('btn-finish').disabled = S.recording || (S.clips.length === 0 && !uploadReady);
  $('btn-reset').disabled = S.recording || (S.clips.length === 0 && !S.cover && S.mode !== 'upload');
  $('btn-record').disabled = !S.stream && S.mode !== 'upload';
  $('btn-upload').disabled = S.recording;
  updateTimer();
  if (S.mode === 'upload') {
    const v = $('preview');
    if (S.recording) setHint('Video oynatılıyor; kamera gibi takip ediliyor. Durdurmak için kırmızı butona bas.');
    else if (v.ended) setHint('Video bitti. Analiz ve sonuç için Bitir’e bas.');
    else setHint('Video durdu. Devam için kırmızı butona, sonuç için Bitir’e bas.');
  } else if (S.recording) setHint('Yavaşça kaydır. Mavi alanlar çekildi; boş kalan yerleri tamamla.');
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
  S.stats = newStats();
  S.analysis = null;
  S.det = newDet();
  S.cornersAuto = false;
  S.cornersTouched = false;
  S.lock = null;
  S.door = null;
  S.lockArmed = true;
  S.rectified = false;
  updateLockChip();
  updateDoorChip();
  S.hasPrev = false;
  if (S.mode === 'upload') leaveUpload();
  showScreen('camera');
  updateUI();
}

// ---------------- Video yükleme (kamera gibi oynat) ----------------

async function askUpload() {
  if (S.recording) return;
  if (S.clips.length || S.cover) {
    const yes = await confirmSheet({
      title: 'Video yüklensin mi?',
      text: 'Yüklenen video yeni bir çekim gibi baştan analiz edilir.',
      warn: 'Mevcut çekimler ve mavi kapsama alanı silinecek.',
      ok: 'Sil ve video seç',
    });
    if (!yes) return;
  }
  $('file-input').click();
}

async function loadUpload(file) {
  resetAll();
  const v = $('preview');
  const url = URL.createObjectURL(file);
  S.mode = 'upload';
  S.upload = { file, url };
  $('cam-error').classList.add('hidden');
  v.pause();
  v.srcObject = null;
  v.muted = true;
  v.loop = false;
  v.src = url;
  try {
    await new Promise((resolve, reject) => {
      v.addEventListener('loadeddata', resolve, { once: true });
      v.addEventListener('error', () => reject(v.error), { once: true });
    });
  } catch {
    toast('Bu video açılamadı. MP4 (H.264) formatında bir video dene.');
    leaveUpload();
    updateUI();
    return;
  }
  setupProc(v.videoWidth, v.videoHeight);
  v.onended = onUploadEnded;
  scheduleTick();
  startUploadPlayback();
}

function startUploadPlayback() {
  const v = $('preview');
  if (v.ended) return;
  S.recording = true;
  S.newClip = true; // devamda ilk kare anahtar kare olsun
  S.lockNewClip = true;
  S.hasPrev = false;
  invalidateResults();
  v.play().catch(() => {
    S.recording = false;
    updateUI();
  });
  updateUI();
}

function toggleUploadPlayback() {
  const v = $('preview');
  if (S.recording) {
    v.pause();
    S.recording = false;
    updateUI();
  } else startUploadPlayback();
}

function onUploadEnded() {
  S.recording = false;
  ensureUploadClip();
  updateUI();
}

function ensureUploadClip() {
  if (S.mode !== 'upload' || S.clips.length) return;
  const v = $('preview');
  const f = S.upload.file;
  S.clips.push({ blob: f, duration: v.duration || v.currentTime || 0, mimeType: f.type || 'video/mp4', uploaded: true });
}

function leaveUpload() {
  const v = $('preview');
  v.onended = null;
  v.pause();
  v.removeAttribute('src');
  if (S.upload) URL.revokeObjectURL(S.upload.url);
  S.upload = null;
  S.mode = 'camera';
  S.recording = false;
  if (S.stream) {
    v.srcObject = S.stream;
    v.play().catch(() => {});
  } else if ($('cam-error-text').textContent) {
    $('cam-error').classList.remove('hidden'); // kamera yoksa hata ekranına dön
  }
}

function invalidateResults() {
  S.mergeGen++;
  S.merged = null;
  S.mergePromise = null;
  S.resultBlob = null;
}

// ---------------- Bitir: birleştir + panorama ----------------

async function finish() {
  if (S.mode === 'upload') {
    $('preview').pause();
    S.recording = false;
    ensureUploadClip();
  } else await stopClip();
  if (!S.clips.length) return;
  showBusy('Çekimler birleştiriliyor…');
  startMerge();
  try {
    S.rectified = !!(S.lock && S.lock.kfs.length);
    if (S.rectified) {
      // Kilitli dolap: yakın çekim kareleri doğrudan düz dolap görüntüsüne yerleştirilir
      setBusyText('Dolap görüntüsü oluşturuluyor…');
      await new Promise((r) => setTimeout(r, 30));
      S.pano = await buildRectified();
    } else {
      S.pano = await buildPanorama();
      S.corners = null; // yeni panorama: köşeler yeniden bulunsun
    }
    S.analysis = computeAnalysis();
  } catch (e) {
    console.error(e);
    hideBusy();
    toast('Görüntü birleştirilemedi. Biraz daha yavaş tekrar çek.');
    return;
  }
  hideBusy();
  if (S.rectified) {
    // Görüntü zaten düz: köşeler tam görüntü, doğrudan sonuca geç (köşeler istenirse sonradan ayarlanır)
    const w = S.pano.width;
    const h = S.pano.height;
    S.corners = [
      { x: 0, y: 0 },
      { x: w, y: 0 },
      { x: w, y: h },
      { x: 0, y: h },
    ];
    S.cornersAuto = true;
    S.cornersTouched = false;
    openPerspective();
    await applyPerspective();
  } else openPerspective();
}

async function buildRectified() {
  const L = S.lock;
  await Promise.all(L.kfs.map((k) => k.ready));
  const kfs = L.kfs.filter((k) => k.blob);
  if (!kfs.length) throw new Error('Dolap karesi yok');
  const images = await Promise.all(kfs.map((k) => decodeImage(k.blob)));
  // Çıktı çözünürlüğü: en yakın çekimin detayına göre (dolap genişliği başına piksel)
  let ppu = 0;
  kfs.forEach((k, i) => {
    const im = images[i];
    const pts = [
      [0, 0],
      [im.width, 0],
      [im.width, im.height],
      [0, im.height],
    ].map(([x, y]) => applyH(k.G, x, y));
    if (pts.some((p) => !p)) return;
    const wU = Math.max(...pts.map((p) => p.x)) - Math.min(...pts.map((p) => p.x));
    if (wU > 0.02) ppu = Math.max(ppu, im.width / wU);
  });
  const aspect = L.aspect;
  let OW = Math.round(Math.min(2400, Math.max(900, ppu || 1200)));
  let OH = Math.round(OW / aspect);
  if (OW * OH > 6e6) {
    const f = Math.sqrt(6e6 / (OW * OH));
    OW = Math.round(OW * f);
    OH = Math.round(OH * f);
  }
  const { canvas, filled } = rectifyMosaic(
    kfs.map((k, i) => ({ image: images[i], G: k.G, area: k.area })),
    OW,
    OH,
  );
  S.rectFilled = filled;
  return canvas;
}

function startMerge() {
  if (S.mergePromise) return S.mergePromise;
  const gen = S.mergeGen;
  const clips = S.clips.slice();
  if (clips.length === 1 && clips[0].uploaded) {
    // Yüklenen video zaten tek parça: yeniden kodlamaya gerek yok.
    S.merged = { blob: clips[0].blob, mimeType: clips[0].mimeType, duration: clips[0].duration };
    S.mergePromise = Promise.resolve(S.merged);
    setMergeState('done', 1);
    return S.mergePromise;
  }
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

// ---------------- Analiz ----------------

function coverageFill() {
  const c = S.cover;
  if (!c) return 0;
  const x = Math.max(0, Math.floor(S.maskOX + c.minX));
  const y = Math.max(0, Math.floor(S.maskOY + c.minY));
  const w = Math.min(MASK_W - x, Math.ceil(c.maxX - c.minX));
  const h = Math.min(MASK_H - y, Math.ceil(c.maxY - c.minY));
  if (w <= 0 || h <= 0) return 0;
  const d = S.maskCtx.getImageData(x, y, w, h).data;
  let on = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 0) on++;
  return on / (w * h);
}

function computeAnalysis() {
  const c = S.cover;
  const zw = (1 - 2 * INSET) * S.PW;
  const zh = (1 - 2 * INSET) * S.PH;
  // Taranan alan: boyanan bölge + kenar payları = gerçekten görüntülenen alan (kadraj cinsinden)
  const coverW = c ? (c.maxX - c.minX + (S.PW - zw)) / S.PW : 0;
  const coverH = c ? (c.maxY - c.minY + (S.PH - zh)) / S.PH : 0;
  return analyze({
    ...S.stats,
    duration: S.clips.reduce((s, k) => s + k.duration, 0),
    clips: S.mode === 'upload' ? 1 : S.clips.length,
    coverW,
    coverH,
    fill: S.rectified ? S.lock.coverage() : coverageFill(),
    cabinet: S.rectified,
    door: S.door
      ? {
          state: S.door.state,
          opened: S.door.events.filter((e) => e.type === 'opened').length,
          closed: S.door.events.filter((e) => e.type === 'closed').length,
          confident: S.door.confidence === 'high',
          reason: S.door.reason,
        }
      : null,
    keyframes: S.rectified ? S.lock.kfs.length : S.keyframes.length,
  });
}

function renderAnalysis() {
  const a = S.analysis;
  $('analysis-card').classList.toggle('hidden', !a);
  if (!a) return;
  const sc = $('score');
  sc.textContent = a.score;
  sc.className = `score ${a.level}`;
  $('score-label').textContent = `Çekim kalitesi: ${a.label}`;
  $('score-label').className = `badge ${a.level}`;
  $('analysis-source').textContent = S.mode === 'upload' ? 'Yüklenen video analizi' : 'Kamera çekimi analizi';
  const grid = $('metrics');
  grid.replaceChildren(
    ...a.metrics.map((m) => {
      const el = document.createElement('div');
      el.className = 'metric';
      const l = document.createElement('div');
      l.className = 'metric-label';
      l.textContent = m.label;
      const v = document.createElement('div');
      v.className = 'metric-value';
      v.textContent = m.value;
      const h = document.createElement('div');
      h.className = 'metric-hint';
      h.textContent = m.hint;
      el.append(l, v, h);
      return el;
    }),
  );
  $('tips').replaceChildren(
    ...a.tips.map((t) => {
      const li = document.createElement('li');
      li.textContent = t;
      return li;
    }),
  );
  drawCoverageMap();
}

// Panorama üzerine mavi kapsama haritası (boş kalan yerler mavisiz görünür).
function drawCoverageMap() {
  const cv = $('coverage-map');
  if (!S.pano || !S.cover || !S.keyframes.length) return;
  const maxW = 1200;
  const k = Math.min(1, maxW / S.pano.width);
  cv.width = Math.round(S.pano.width * k);
  cv.height = Math.round(S.pano.height * k);
  const ctx = cv.getContext('2d');
  ctx.drawImage(S.pano, 0, 0, cv.width, cv.height);
  // Panorama sınırları (takip koordinatında)
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const f of S.keyframes) {
    minX = Math.min(minX, f.x);
    minY = Math.min(minY, f.y);
    maxX = Math.max(maxX, f.x + S.PW);
    maxY = Math.max(maxY, f.y + S.PH);
  }
  ctx.globalAlpha = 0.45;
  drawImageClipped(ctx, S.mask, S.maskOX + minX, S.maskOY + minY, maxX - minX, maxY - minY, 0, 0, cv.width, cv.height);
  ctx.globalAlpha = 1;
}

// ---------------- Perspektif ----------------

const handles = [...document.querySelectorAll('.handle')];

function openPerspective() {
  const c = $('pano');
  c.width = S.pano.width;
  c.height = S.pano.height;
  c.getContext('2d').drawImage(S.pano, 0, 0);
  if (!S.corners && !autoCorners()) {
    S.cornersAuto = false;
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

// Çıktı boyutu: çapraz çekimde gerçek en/boy oranı (uzaktaki kenarın kısalması telafi edilir).
// Asal nokta panorama merkezi, varsayılan odak tek kamera karesinin boyutundan.
function outputSize(maxSide = 3000) {
  const center = { x: S.pano.width / 2, y: S.pano.height / 2 };
  const f = phoneFocal(S.pano.tileW || S.pano.width, S.pano.tileH || S.pano.height);
  return suggestOutputSize(S.corners, maxSide, center, f);
}

// Panoramada dolabı bul ve köşeleri oraya koy.
function autoCorners() {
  if (!S.pano) return false;
  const k = Math.min(1, 480 / Math.max(S.pano.width, S.pano.height));
  const w = Math.max(16, Math.round(S.pano.width * k));
  const h = Math.max(16, Math.round(S.pano.height * k));
  const r = detectQuad(grayOf(S.pano, w, h), w, h, { margin: 0.01 });
  if (!r) return false;
  S.corners = r.corners.map((p) => ({ x: p.x / k, y: p.y / k }));
  S.cornersAuto = true;
  S.cornersTouched = false;
  return true;
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
  $('quad').classList.toggle('auto', S.cornersAuto);
  const ok = isConvexQuad(S.corners);
  const info = $('persp-info');
  info.classList.toggle('error', !ok);
  const notFound = ok && !S.cornersAuto && !S.cornersTouched;
  info.classList.toggle('warn', notFound);
  if (notFound) {
    info.textContent = 'Dolap otomatik bulunamadı. Dört köşeyi dolabın köşelerine sürükle; çapraz çekimde dolap düz, karşıdan görünüme çevrilir.';
  } else if (ok) {
    const { width, height } = outputSize();
    info.textContent = `${S.cornersAuto ? 'Dolap otomatik bulundu, köşeleri kontrol et · ' : ''}Çıktı: ${width} × ${height} px`;
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
    S.cornersAuto = false;
    S.cornersTouched = true;
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
    const { width, height } = outputSize(3000);
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
    renderAnalysis();
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

$('btn-record').addEventListener('click', () => {
  if (S.mode === 'upload') return toggleUploadPlayback();
  return S.recording ? stopClip() : startClip();
});
$('btn-upload').addEventListener('click', askUpload);
$('chip-det').addEventListener('click', askUnlock);
$('btn-upload-err').addEventListener('click', askUpload);
$('file-input').addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (f) loadUpload(f);
});
$('btn-finish').addEventListener('click', finish);
$('btn-reset').addEventListener('click', askReset);
$('btn-retry').addEventListener('click', startCamera);
$('btn-close').addEventListener('click', () => bridge.post({ type: 'close' }));
$('btn-apply').addEventListener('click', applyPerspective);
$('btn-auto').addEventListener('click', () => {
  if (autoCorners()) {
    positionHandles();
    toast('Dolap bulundu');
  } else toast('Dolap bulunamadı. Köşeleri elle ayarla.');
});
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

// ---------------- Yenilikler ----------------

const SEEN_KEY = 'neocortex.lastSeenVersion';
const readSeen = () => {
  try {
    return localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
};
const writeSeen = (v) => {
  try {
    localStorage.setItem(SEEN_KEY, v);
  } catch {
    /* gizli sekme vb. — her açılışta yeniden gösterilir */
  }
};

function showWhatsNew(entries, { all = false } = {}) {
  if (!entries.length) return;
  $('wn-title').textContent = all ? 'Sürüm notları' : 'Yenilikler';
  $('wn-sub').textContent = all ? `Şu anki sürüm v${APP_VERSION}` : `v${APP_VERSION} sürümüne güncellendi`;
  $('wn-body').replaceChildren(
    ...entries.map((e) => {
      const box = document.createElement('div');
      box.className = 'wn-version';
      const head = document.createElement('div');
      head.className = 'wn-version-head';
      const b = document.createElement('span');
      b.className = 'badge';
      b.textContent = `v${e.version}`;
      const d = document.createElement('span');
      d.className = 'muted';
      d.textContent = e.date;
      head.append(b, d);
      const ul = document.createElement('ul');
      for (const it of e.items) {
        const li = document.createElement('li');
        li.textContent = it;
        ul.append(li);
      }
      box.append(head, ul);
      return box;
    }),
  );
  $('whatsnew').classList.remove('hidden');
}

function closeWhatsNew() {
  $('whatsnew').classList.add('hidden');
  writeSeen(APP_VERSION);
}

$('wn-ok').addEventListener('click', closeWhatsNew);
$('wn-close').addEventListener('click', closeWhatsNew);
$('chip-version').textContent = `v${APP_VERSION}`;
$('chip-version').addEventListener('click', () => showWhatsNew(CHANGELOG, { all: true }));
showWhatsNew(entriesToShow(readSeen()));
window.NeoCortex.version = APP_VERSION;

startCamera().then(() => bridge.post({ type: 'ready', version: 1, appVersion: APP_VERSION, platform: bridge.platform }));
