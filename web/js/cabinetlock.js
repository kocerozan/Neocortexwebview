// Kilitli dolap: algılanan dolap çerçevesi kilitlenir ve kamera yaklaşsa / kaysa / açı değiştirse
// de dolabın üstünde kalır. Dolap koordinatları birim karedir ([0,1]²): sol-üst (0,0), sağ-alt (1,1).
// Takip kaybolursa veriler korunur; dolap yeniden bulununca aynı koordinatlarla devam edilir
// (dört köşe aynı dolabı tanımladığı için).

import { QuadTracker, applyH, mul3 } from './homotrack.js';
import { computeHomography, estimateAspect, phoneFocal, isConvexQuad } from './perspective.js';

const UNIT = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];
const MASK_RES = 256;

function polyArea(p) {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[(i + 1) % p.length];
    a += p[i].x * q.y - q.x * p[i].y;
  }
  return Math.abs(a) / 2;
}

const centroid = (p) => ({ x: p.reduce((s, v) => s + v.x, 0) / p.length, y: p.reduce((s, v) => s + v.y, 0) / p.length });

export class CabinetLock {
  /** w,h: takip karesinin boyutu (piksel) */
  constructor(w, h, { lostAfter = 15 } = {}) {
    this.w = w;
    this.h = h;
    this.lostAfter = lostAfter;
    this.state = 'off'; // off | on | lost
    this.tracker = new QuadTracker(w, h);
    this.aspectSum = 0;
    this.aspectN = 0;
    this.polys = []; // ekranda gösterilecek kapsama çokgenleri (birim koordinat)
    this.lastPolyC = null;
    this.mask = null; // kapsama oranı için birim kare maskesi
    this.maskCtx = null;
    this.kfs = []; // { blob, G, area, ready }
    this.lastKf = null;
    this.okThisFrame = false;
    this.frames = 0;
  }

  get active() {
    return this.state === 'on';
  }

  get used() {
    return this.state !== 'off';
  }

  get quad() {
    return this.tracker.quad;
  }

  get aspect() {
    return this.aspectN ? this.aspectSum / this.aspectN : 4 / 3;
  }

  /** Kare pikseli → dolap birim karesi */
  G() {
    return this.quad ? computeHomography(this.quad, UNIT) : null;
  }

  /** Dolap birim karesi → kare pikseli */
  Ginv() {
    return this.quad ? computeHomography(UNIT, this.quad) : null;
  }

  _addAspect(quad) {
    const est = estimateAspect(quad, { x: this.w / 2, y: this.h / 2 }, phoneFocal(this.w, this.h));
    if (est && est.aspect > 0.15 && est.aspect < 8) {
      this.aspectSum += est.aspect;
      this.aspectN++;
    }
  }

  _ensureMask() {
    if (this.mask || typeof document === 'undefined') return;
    this.mask = document.createElement('canvas');
    this.mask.width = MASK_RES;
    this.mask.height = MASK_RES;
    this.maskCtx = this.mask.getContext('2d', { willReadFrequently: true });
    this.maskCtx.fillStyle = '#2F80ED';
  }

  /** Algılama sonucu geldiğinde çağrılır (quad: kare pikseli). Döner: 'locked' | 'relocked' | 'corrected' | null */
  onDetection(quad, gray) {
    if (this.state === 'off' || this.state === 'lost') {
      const was = this.state;
      this.tracker.lock(quad, gray);
      this.state = 'on';
      this._addAspect(quad);
      this._ensureMask();
      return was === 'off' ? 'locked' : 'relocked';
    }
    // Kilitliyken: algılama takip edilen dörtgene yakınsa kaymayı düzelt
    const q = this.quad;
    const diag = Math.hypot(q[2].x - q[0].x, q[2].y - q[0].y);
    const d = Math.max(...quad.map((p, i) => Math.hypot(p.x - q[i].x, p.y - q[i].y)));
    if (d < 0.08 * diag) {
      // Yumuşak düzeltme: ani sıçrama kapak tespitini ve mavi katmanı oynatmasın
      this.tracker.quad = q.map((p, i) => ({ x: p.x * 0.7 + quad[i].x * 0.3, y: p.y * 0.7 + quad[i].y * 0.3 }));
      this._addAspect(quad);
      return 'corrected';
    }
    return null;
  }

  /** Her karede (kilitliyken). Döner: true ise dörtgen bu karede güncellendi. */
  update(gray) {
    this.okThisFrame = false;
    if (this.state !== 'on') return false;
    this.frames++;
    const r = this.tracker.update(gray);
    if (r.ok && !isConvexQuad(this.quad)) r.ok = false;
    if (!r.ok && this.tracker.lost >= this.lostAfter) this.state = 'lost';
    this.okThisFrame = r.ok;
    return r.ok;
  }

  /** Görünen kare bölgesinin (kare pikseli çokgen) dolap üzerindeki izdüşümü */
  viewOnCabinet(polyPx) {
    const G = this.G();
    if (!G) return null;
    const out = polyPx.map((p) => applyH(G, p.x, p.y));
    return out.every(Boolean) ? out : null;
  }

  /** Karenin dolap üzerindeki alanı (dolap = 1). Ufuk arkası ya da kayıpsa Infinity. */
  viewArea(framePx) {
    const poly = this.viewOnCabinet(framePx);
    return poly ? polyArea(poly) : Infinity;
  }

  /** Kayıt sırasında: çekim bölgesini dolabın üstünde maviye boya */
  paint(zonePx) {
    if (!this.okThisFrame) return;
    const poly = this.viewOnCabinet(zonePx);
    if (!poly) return;
    if (this.maskCtx) {
      const c = this.maskCtx;
      c.beginPath();
      poly.forEach((p, i) => (i ? c.lineTo(p.x * MASK_RES, p.y * MASK_RES) : c.moveTo(p.x * MASK_RES, p.y * MASK_RES)));
      c.closePath();
      c.fill();
    }
    // Ekran için seyrek çokgen listesi (her karede değil, bölge kaydıkça)
    const c = centroid(poly);
    if (!this.lastPolyC || Math.hypot(c.x - this.lastPolyC.x, c.y - this.lastPolyC.y) > 0.01 || this.frames % 6 === 0) {
      this.polys.push(poly);
      this.lastPolyC = c;
      if (this.polys.length > 1500) this.polys = this.polys.filter((_, i) => i % 2 === 0);
    }
  }

  /** Dolabın çekilen oranı (0..1) */
  coverage() {
    if (!this.maskCtx) return 0;
    const d = this.maskCtx.getImageData(0, 0, MASK_RES, MASK_RES).data;
    let on = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) on++;
    return on / (MASK_RES * MASK_RES);
  }

  /**
   * Yakın çekim anahtar karesi gerekiyor mu? framePx: tüm karenin köşeleri (kare pikseli).
   * Döner: { G (kare pikseli → birim), area } ya da null.
   */
  keyframeNeeded(framePx, force = false) {
    if (!this.okThisFrame || this.kfs.length >= 120) return null;
    const poly = this.viewOnCabinet(framePx);
    if (!poly) return null;
    const area = polyArea(poly);
    const c = centroid(poly);
    const s = Math.sqrt(area);
    const L = this.lastKf;
    const moved = L && Math.hypot(c.x - L.c.x, c.y - L.c.y) > 0.25 * Math.min(s, L.s);
    const zoomed = L && (s / L.s > 1.25 || s / L.s < 0.8);
    if (!(force || !L || moved || zoomed)) return null;
    // Dolabın neredeyse hiç görünmediği kareleri alma
    const visible = poly.some((p) => p.x > -0.05 && p.x < 1.05 && p.y > -0.05 && p.y < 1.05) || (c.x > 0 && c.x < 1 && c.y > 0 && c.y < 1);
    if (!visible) return null;
    this.lastKf = { c, s };
    return { G: this.G(), area };
  }

  /** Anahtar kare görüntü pikselini (kw×kh) kare pikseline ölçekleyip birime eşleyen G */
  keyframeG(G, kw, kh) {
    return mul3(G, [this.w / kw, 0, 0, 0, this.h / kh, 0, 0, 0, 1]);
  }
}
