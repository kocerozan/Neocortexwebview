// Dolap kapağı açık mı kapalı mı? (kural tabanlı prototip; DOM yok, Node'da test edilebilir)
//
// Kilitli dolabın düz görüntüsünden düzenli küçük örnekler alınır (dolap koordinatında olduğu
// için kamera hareketi telafi edilmiştir). Sinyaller:
//   - Kapak hareketi: örnekler arasında kısa süreli büyük değişim (kapak dolabın önünde döner).
//   - Görünüm: cam kapak kapalıyken ürünler puslu görünür (düşük kontrast ve doygunluk) ve
//     yansıma lekeleri vardır; kapak açılınca kontrast/doygunluk artar, yansımalar kaybolur.
// Hareket bitince önceki ve sonraki görünüm karşılaştırılır: artış → açıldı, düşüş → kapandı.
// Kapak hareketi görülmeden durum "bilinmiyor" kalır (mutlak görünüm ürünlere göre değişir).

/** Dolap birim karesini (Ginv: birim → piksel) RW×RH RGBA örneğe çevirir. */
export function sampleRect(rgba, w, h, Ginv, RW = 64, RH = 48) {
  const out = new Uint8ClampedArray(RW * RH * 4);
  let inside = 0;
  for (let y = 0; y < RH; y++) {
    const v = (y + 0.5) / RH;
    for (let x = 0; x < RW; x++) {
      const u = (x + 0.5) / RW;
      const d = Ginv[6] * u + Ginv[7] * v + Ginv[8];
      const o = (y * RW + x) * 4;
      out[o + 3] = 255;
      if (!(d > 1e-9)) continue;
      const px = Math.round((Ginv[0] * u + Ginv[1] * v + Ginv[2]) / d - 0.5);
      const py = Math.round((Ginv[3] * u + Ginv[4] * v + Ginv[5]) / d - 0.5);
      if (px < 0 || py < 0 || px >= w || py >= h) continue;
      const i = (py * w + px) * 4;
      out[o] = rgba[i];
      out[o + 1] = rgba[i + 1];
      out[o + 2] = rgba[i + 2];
      out[o + 3] = 254; // görünür piksel işareti
      inside++;
    }
  }
  return { data: out, w: RW, h: RH, visible: inside / (RW * RH) };
}

/** Görünüm özellikleri: kontrast, doygunluk, yansıma oranı (yalnız görünür iç bölgede). */
export function features(sample, { margin = 0.1 } = {}) {
  const { data, w, h } = sample;
  const x0 = Math.floor(w * margin);
  const x1 = Math.ceil(w * (1 - margin));
  const y0 = Math.floor(h * margin);
  const y1 = Math.ceil(h * (1 - margin));
  const lum = (i) => 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  let n = 0;
  let sat = 0;
  let hi = 0;
  let con = 0;
  let cn = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4;
      if (data[i + 3] !== 254) continue;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      const s = mx > 0 ? (mx - mn) / mx : 0;
      const L = lum(i);
      n++;
      sat += s;
      if (L > 225 && s < 0.12) hi++;
      if (x + 1 < x1 && data[i + 7] === 254) {
        con += Math.abs(L - lum(i + 4));
        cn++;
      }
      if (y + 1 < y1 && data[i + w * 4 + 3] === 254) {
        con += Math.abs(L - lum(i + w * 4));
        cn++;
      }
    }
  }
  if (n < 20) return null;
  return { contrast: cn ? con / cn : 0, saturation: sat / n, highlights: hi / n };
}

/** İki örnek arasındaki fark (2x küçültülmüş parlaklık, ortalama mutlak fark). */
export function sampleDiff(a, b) {
  const { w, h } = a;
  let s = 0;
  let n = 0;
  for (let y = 0; y + 1 < h; y += 2) {
    for (let x = 0; x + 1 < w; x += 2) {
      let la = 0;
      let lb = 0;
      let ok = true;
      for (const [dx, dy] of [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ]) {
        const i = ((y + dy) * w + x + dx) * 4;
        if (a.data[i + 3] !== 254 || b.data[i + 3] !== 254) ok = false;
        la += a.data[i] * 0.299 + a.data[i + 1] * 0.587 + a.data[i + 2] * 0.114;
        lb += b.data[i] * 0.299 + b.data[i + 1] * 0.587 + b.data[i + 2] * 0.114;
      }
      if (!ok) continue;
      s += Math.abs(la - lb) / 4;
      n++;
    }
  }
  return n ? s / n : 0;
}

const avgF = (fs) => ({
  contrast: fs.reduce((s, f) => s + f.contrast, 0) / fs.length,
  saturation: fs.reduce((s, f) => s + f.saturation, 0) / fs.length,
  highlights: fs.reduce((s, f) => s + f.highlights, 0) / fs.length,
});

/** Açıklık göstergesi: önceki → sonraki görünüm değişimi (pozitif = daha "açık") */
// Not: parlak piksel oranı kullanılmaz: dolabın beyaz içi kapak açılınca "parlak" sayılıyor ve
// sonucu ters çeviriyordu. Kontrast da yansıma bantlarından etkilendiği için yarım ağırlıkta.
export function opennessDelta(before, after) {
  const r = Math.log((after.contrast + 1) / (before.contrast + 1));
  const s = Math.log((after.saturation + 0.02) / (before.saturation + 0.02));
  return s + 0.5 * r;
}

/**
 * Kapak durumu izleyicisi. Her örnekte update(sample, t) çağrılır.
 * state: 'unknown' | 'closed' | 'open'; confidence: 'low' | 'high'
 * Döner: olay ('opened' | 'closed') ya da null.
 *
 * Mantık: referans görünüm (son kararlı durum) ile güncel görünüm sürekli karşılaştırılır.
 * Açıklık değişimi üst üste birkaç örnekte aynı yönde ve eşikten büyükse, ve son birkaç
 * saniyede kapak hareketi (örnekler arası ani sıçrama) görüldüyse durum değişir.
 * Yaklaşma / ışık değişimi gibi yavaş değişimler sıçrama üretmediği için olay üretmez.
 */
export class DoorMonitor {
  // Eşikler sentetik videolarda ölçülerek seçildi: kapak dönerken örnek farkı 10-17 (kapaksız dolaba
  // yaklaşırken ≤8); yansımalı camda kapak açılınca açıklık değişimi ≈ +0,3. Sahada ayar gerekebilir.
  constructor({ moveDiff = 10, decide = 0.25, confirm = 4, swingWindow = 2.5, minVisible = 0.85 } = {}) {
    Object.assign(this, { moveDiff, decide, confirm, swingWindow, minVisible });
    this.paused = false;
    this.glare = new GlareDetector();
    this.reason = null; // 'hareket' | 'yansıma'
    this.glareSince = null;
    this.lastDecision = -Infinity; // son kapak olayı kararı zamanı
    this.state = 'unknown';
    this.confidence = 'low';
    this.prev = null;
    this.noise = 3; // sakin dönemdeki örnek farkı; hareket eşiği buna uyarlanır
    this.recent = []; // son örneklerin özellikleri
    this.ref = null; // referans görünüm (son kararlı durum)
    this.refN = 0;
    this.lastSwing = -Infinity;
    this.spikes = []; // son sıçrama zamanları
    this.run = 0; // aynı yönde üst üste eşik aşımı (+ açılma, − kapanma)
    this.events = []; // { t, type }
    this.lastDiff = 0;
    this.lastDelta = 0;
    this.t = 0;
  }

  /** Arayüz için: kapak hareket ediyor mu — son 0,6 sn'de en az iki sıçrama VE görünüm değişiyor
   *  (kayan yansıma da sıçrama yapar ama görünümü kalıcı değiştirmez) */
  get moving() {
    return this.spikes.filter((s) => this.t - s < 0.6).length >= 2 && Math.abs(this.lastDelta) > 0.2;
  }

  /** motion: son ~1 sn'de kameranın dolaba göre hareketi (dolap köşegeni oranı) */
  update(sample, t = 0, motion = 0) {
    this.t = t;
    if (sample.visible < this.minVisible) {
      // Dolabın tamamı görünmüyor (yakın çekim): kapak değerlendirmesi duraklar, durum korunur
      this.prev = null;
      this.recent = [];
      this.run = 0;
      this.paused = true;
      return null;
    }
    if (this.paused) {
      // Yakın çekimden dönüş: görünüm değişti, referansı yeniden kur (olay üretme)
      this.paused = false;
      this.glare.reset();
      this.prev = null;
      this.recent = [];
      this.ref = null;
      this.lastSwing = -Infinity;
      this.spikes = [];
      return null;
    }
    const f = features(sample);
    const d = this.prev ? sampleDiff(this.prev, sample) : 0;
    this.prev = sample;
    this.lastDiff = d;
    if (!f) return null;
    this.recent.push(f);
    if (this.recent.length > 4) this.recent.shift();
    const cur = avgF(this.recent);

    // Kapak hareketi: gürültünün belirgin üstünde ani sıçrama
    const moveThr = Math.max(this.moveDiff, 2 * this.noise);
    if (d > moveThr) {
      this.lastSwing = t;
      this.spikes.push(t);
      if (this.spikes.length > 6) this.spikes.shift();
    }
    else if (d < 1.5 * this.noise + 1) this.noise = 0.92 * this.noise + 0.08 * d;
    const swingRecent = t - this.lastSwing < this.swingWindow;

    // Referans: ilk sakin örneklerin ortalaması
    if (!this.ref) {
      if (this.recent.length >= 4 && !swingRecent) {
        // Not: hareket görmeden mutlak tahmin yapılmaz. Ölçümde yansıma oranı açık renkli dolap
        // içinde de yüksek çıktı, doygunluk ise ürünlere bağlı; ikisi de kapak için güvenilir değil.
        this.ref = cur;
      }
      return null;
    }

    // Camda yansıma (kayan yansıma da sıçrama ürettiği için hareketten bağımsız güncellenir)
    let glareEv = null;
    if (t - this.lastDecision > 2) {
      this.glare.update(sample, motion);
      if (this.glare.state === 'seen') {
        if (this.glareSince === null) this.glareSince = t;
        const longGlare = t - this.glareSince > 3 && this.glare.ema > 0.7;
        // Bilinmiyorsa → kapalı; açık sanılıyorken uzun süre yansıma → kapanma kaçırılmış
        if (this.state === 'unknown' || (this.state === 'open' && longGlare)) {
          this.state = 'closed';
          this.confidence = 'medium';
          this.reason = 'yansıma';
          glareEv = 'glare';
        }
      } else this.glareSince = null;
    }

    const delta = opennessDelta(this.ref, cur);
    this.lastDelta = delta;
    if (delta > this.decide) this.run = this.run > 0 ? this.run + 1 : 1;
    else if (delta < -this.decide) this.run = this.run < 0 ? this.run - 1 : -1;
    else this.run = 0;

    let ev = null;
    if (swingRecent && Math.abs(this.run) >= this.confirm && this.moving === false) {
      const dir = this.run > 0 ? 'open' : 'closed';
      if (this.state !== dir) {
        this.state = dir;
        ev = dir === 'open' ? 'opened' : 'closed';
      }
      this.confidence = 'high';
      this.reason = 'hareket';
      this.lastDecision = t;
      this.glare.reset(); // kapak durumu değişti: yansıma geçmişi geçersiz
      this.ref = cur; // yeni kararlı durum
      this.run = 0;
    } else if (!swingRecent && Math.abs(delta) < this.decide / 2) {
      // Sakin dönemde referansı yavaşça güncelle (ışık değişimi, yaklaşma)
      this.ref = {
        contrast: this.ref.contrast * 0.9 + cur.contrast * 0.1,
        saturation: this.ref.saturation * 0.9 + cur.saturation * 0.1,
        highlights: this.ref.highlights * 0.9 + cur.highlights * 0.1,
      };
    }
    if (!ev && glareEv) ev = glareEv;
    if (ev) this.events.push({ t, type: ev });
    return ev;
  }
}

// ---------------- Camda yansıma ----------------

/**
 * Camdaki yansımayı bulur. Yansıma (tavan lambası, pencere) camın üstünde sabit durmaz:
 * kamera kıpırdadıkça dolabın içeriğine göre kayar. Dolap koordinatındaki örneklerde
 * ürünler yerinde kalır, yansıma gezinir. Son ~1 sn'de her pikselin en koyu hali
 * "yansımasız" görüntüdür; güncel kare bundan belirgin parlak + renksiz + geniş ise yansımadır.
 * İnce kenar titreşimleri (morfolojik açma) ve küçük ışıltılar (konserve, şişe) elenir.
 * Kamera yeterince kıpırdamadıysa karar verilmez.
 */
export class GlareDetector {
  // maxSat: yansıma alttaki ürün rengiyle karışır (doygunluk ~0,3); sabit beyaz ürünler zaten zamanla değişmediği için elenir
  constructor({ win = 28, minFrames = 12, resid = 28, maxSat = 0.45, minL = 150, minBlob = 0.008, minFrac = 0.004, maxStep = 10, minMotion = 0.012 } = {}) {
    Object.assign(this, { win, minFrames, resid, maxSat, minL, minBlob, minFrac, maxStep, minMotion });
    this.reset();
  }

  reset() {
    this.buf = []; // { L: Float32Array, vis: Uint8Array }
    this.ema = 0; // yansıma görülen örnek oranı (hareketli örneklerde)
    this.n = 0;
    this.state = 'unknown'; // unknown | seen | none
    this.lastFrac = 0;
    this.seenRun = 0;
  }

  update(sample, motion) {
    const { data, w, h } = sample;
    const n = w * h;
    const L = new Float32Array(n);
    const S = new Float32Array(n);
    const vis = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const r = data[i * 4];
      const g = data[i * 4 + 1];
      const b = data[i * 4 + 2];
      vis[i] = data[i * 4 + 3] === 254 ? 1 : 0;
      L[i] = 0.299 * r + 0.587 * g + 0.114 * b;
      const mx = Math.max(r, g, b);
      S[i] = mx > 0 ? (mx - Math.min(r, g, b)) / mx : 0;
    }
    this.buf.push({ L, S, vis });
    if (this.buf.length > this.win) this.buf.shift();
    if (this.buf.length < this.minFrames) return null;

    // Pencere içindeki parlaklık aralığı: yansıma son ~2 sn'de pikselin üstünden geçtiyse
    // (bir an parlak + renksiz, bir an değil) aralık büyük olur. Yansımanın şu an görünmesi gerekmez.
    // Ürünler yerinde durduğu için aralıkları küçüktür.
    const mask = new Uint8Array(n);
    let visN = 0;
    for (let i = 0; i < n; i++) {
      if (!vis[i]) continue;
      visN++;
      let mn = Infinity;
      let mx = -Infinity;
      let sAtMax = 1;
      let ok = true;
      for (const f of this.buf) {
        if (!f.vis[i]) {
          ok = false;
          break;
        }
        const l = f.L[i];
        if (l < mn) mn = l;
        if (l > mx) {
          mx = l;
          sAtMax = f.S[i];
        }
      }
      if (ok && mx - mn > this.resid && sAtMax < this.maxSat && mx > this.minL) mask[i] = 1;
    }
    // Morfolojik açma (3x3): ince kenar titreşimlerini sil
    const er = new Uint8Array(n);
    for (let y = 1; y < h - 1; y++)
      for (let x = 1; x < w - 1; x++) {
        let all = 1;
        for (let dy = -1; dy <= 1 && all; dy++) for (let dx = -1; dx <= 1; dx++) if (!mask[(y + dy) * w + x + dx]) { all = 0; break; }
        er[y * w + x] = all;
      }
    const op = new Uint8Array(n);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        if (!er[y * w + x]) continue;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const yy = y + dy;
            const xx = x + dx;
            if (yy >= 0 && xx >= 0 && yy < h && xx < w) op[yy * w + xx] = 1;
          }
      }
    // Yeterince büyük bölgeler (küçük ışıltıları ele)
    const seen = new Uint8Array(n);
    const minArea = this.minBlob * Math.max(1, visN);
    let kept = 0;
    const stack = [];
    for (let i = 0; i < n; i++) {
      if (!op[i] || seen[i]) continue;
      let area = 0;
      stack.push(i);
      seen[i] = 1;
      while (stack.length) {
        const k = stack.pop();
        area++;
        const x = k % w;
        const y = (k - x) / w;
        for (const [nx, ny] of [
          [x + 1, y],
          [x - 1, y],
          [x, y + 1],
          [x, y - 1],
        ]) {
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (op[j] && !seen[j]) {
            seen[j] = 1;
            stack.push(j);
          }
        }
      }
      if (area >= minArea) kept += area;
    }
    const frac = visN ? kept / visN : 0;
    this.lastFrac = frac;
    // Kalıcı genel değişim mi (kapak açıldı, ışık değişti)? Pencerenin ilk ve son örneklerini
    // karşılaştır: dolabın çoğunda fark varsa adım değişimidir; gezinen yansıma ise yalnız bandın
    // bulunduğu yerleri değiştirir (fark ortancası küçük kalır).
    const k = Math.min(4, Math.floor(this.buf.length / 3));
    const hist = new Uint32Array(256);
    let hn = 0;
    for (let i = 0; i < n; i++) {
      if (!vis[i]) continue;
      let a = 0;
      let b = 0;
      let ok = true;
      for (let j = 0; j < k; j++) {
        const fa = this.buf[j];
        const fb = this.buf[this.buf.length - 1 - j];
        if (!fa.vis[i] || !fb.vis[i]) {
          ok = false;
          break;
        }
        a += fa.L[i];
        b += fb.L[i];
      }
      if (!ok) continue;
      hist[Math.min(255, Math.round(Math.abs(b - a) / k))]++;
      hn++;
    }
    let acc = 0;
    let step = 0;
    for (; step < 256; step++) {
      acc += hist[step];
      if (acc >= hn / 2) break;
    }
    this.lastStep = step;
    // Karar yalnız kamera kıpırdadıysa (sabit kamerada yansıma da sabit kalır, ayırt edilemez).
    // Kalıcı genel değişim (kapak açıldı, ışık değişti) yansıma değildir: o anı sayma.
    if (motion >= this.minMotion && step <= this.maxStep) {
      const hit = frac > this.minFrac ? 1 : 0;
      this.ema = this.n ? 0.85 * this.ema + 0.15 * hit : hit;
      this.n++;
      this.seenRun = hit ? this.seenRun + 1 : 0;
      if (this.n >= 8 && this.ema > 0.5) this.state = 'seen';
      else if (this.n >= 20 && this.ema < 0.1) this.state = 'none';
    }
    return frac;
  }
}
