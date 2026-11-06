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
export function opennessDelta(before, after) {
  const r = Math.log((after.contrast + 1) / (before.contrast + 1));
  const s = Math.log((after.saturation + 0.02) / (before.saturation + 0.02));
  const h = (after.highlights - before.highlights) * 8;
  return r + s - h;
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
  // Eşikler ölçümle seçildi: kapak dönerken fark 10-17, açıklık değişimi ±0,6-0,9; kapaksız
  // dolaba yaklaşırken fark ≤8, değişim ≤0,21.
  constructor({ moveDiff = 10, decide = 0.35, confirm = 4, swingWindow = 2.5, minVisible = 0.85 } = {}) {
    Object.assign(this, { moveDiff, decide, confirm, swingWindow, minVisible });
    this.paused = false;
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

  /** Arayüz için: kapak hareket ediyor mu (son 0,6 sn'de en az iki sıçrama; tek sıçrama titreme sayılır) */
  get moving() {
    return this.spikes.filter((s) => this.t - s < 0.6).length >= 2;
  }

  update(sample, t = 0) {
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
    if (ev) this.events.push({ t, type: ev });
    return ev;
  }
}
