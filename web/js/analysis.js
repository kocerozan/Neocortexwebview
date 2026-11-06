// Çekim kalitesi analizi (DOM yok, Node'da test edilebilir).
//
// Girdi (kayıt sırasında toplanan istatistikler):
//   duration     toplam süre (sn)
//   clips        parça sayısı
//   keyframes    panoramaya giren kare sayısı
//   frames       kayıt sırasında işlenen kare sayısı
//   okFrames     takibin güvenilir olduğu kare sayısı
//   fastFrames   çok hızlı kaydırılan kare sayısı
//   speeds       kadraj/sn cinsinden anlık hızlar
//   ys           kadraj yüksekliği cinsinden dikey konumlar
//   coverW/H     taranan alanın boyutu (kadraj cinsinden)
//   fill         taranan alanın içinde gerçekten boyanan oran (0..1)

const nf = (n, d = 1) => n.toLocaleString('tr-TR', { minimumFractionDigits: 0, maximumFractionDigits: d });
const pct = (r) => `%${nf(r * 100, 0)}`;

function mean(a) {
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
}

function std(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
}

export function analyze(st) {
  const frames = Math.max(1, st.frames || 0);
  const fastRatio = (st.fastFrames || 0) / frames;
  const lostRatio = 1 - (st.okFrames || 0) / frames;
  const avgSpeed = mean(st.speeds || []);
  const yDrift = std(st.ys || []);
  const fill = Math.max(0, Math.min(1, st.fill ?? 0));
  const coverW = st.coverW || 0;
  const coverH = st.coverH || 0;

  const tips = [];
  let score = 100;

  const gapPenalty = Math.min(35, (1 - fill) * 150);
  score -= gapPenalty;
  if (1 - fill > 0.08)
    tips.push(
      st.cabinet
        ? `Dolabın ${pct(1 - fill)} kadarı yakından çekilmedi. Mini haritada mavi olmayan yerlere yaklaşıp çek.`
        : `Taranan alanın ${pct(1 - fill)} kadarı boş kaldı. Mavi olmayan yerleri yeni çekimle tamamla.`,
    );

  const fastPenalty = Math.min(25, fastRatio * 100);
  score -= fastPenalty;
  if (fastRatio > 0.05) tips.push(`Çekimin ${pct(fastRatio)} kadarında kamera çok hızlı kaydırıldı. Daha yavaş ve sabit hızla kaydır.`);

  const lostPenalty = Math.min(25, lostRatio * 80);
  score -= lostPenalty;
  if (lostRatio > 0.1) tips.push(`Çekimin ${pct(lostRatio)} kadarında görüntü takip edilemedi (bulanık, karanlık ya da düz yüzey). Işığı iyi bir yerde, rafa yakın çek.`);

  const driftPenalty = yDrift > 0.15 ? Math.min(15, (yDrift - 0.15) * 60) : 0;
  score -= driftPenalty;
  if (yDrift > 0.25 && coverW >= coverH) tips.push('Kamera yukarı-aşağı fazla oynadı. Telefonu aynı yükseklikte tutarak yatay kaydır.');

  if (!st.cabinet && coverW < 1.3 && coverH < 1.3) {
    score -= 10;
    tips.push('Çok az alan tarandı. Teşhirin tamamı için kamerayı bir uçtan diğer uca götür.');
  }

  score = Math.round(Math.max(0, Math.min(100, score)));
  const level = score >= 80 ? 'good' : score >= 55 ? 'medium' : 'poor';
  const label = { good: 'İyi', medium: 'Orta', poor: 'Zayıf' }[level];
  if (!tips.length) tips.push('Çekim kaliteli. Panorama ve perspektif sonucu güvenilir.');

  const metrics = [
    { label: 'Süre', value: `${nf(st.duration || 0)} sn`, hint: `${st.clips || 0} çekim` },
    { label: 'Taranan alan', value: `${nf(coverW)} × ${nf(coverH)}`, hint: 'kadraj (en × boy)' },
    { label: 'Kapsama', value: pct(fill), hint: st.cabinet ? 'dolabın çekilen kısmı' : 'mavi boyanan oran' },
    { label: 'Ortalama hız', value: nf(avgSpeed, 2), hint: 'kadraj / sn' },
    { label: 'Hızlı anlar', value: pct(fastRatio), hint: 'çok hızlı kaydırma' },
    { label: 'Takip kaybı', value: pct(lostRatio), hint: 'takip edilemeyen kare' },
    { label: 'Dikey sapma', value: nf(yDrift, 2), hint: 'kadraj (düşük = düz)' },
    { label: 'Anahtar kare', value: String(st.keyframes || 0), hint: 'panoramaya giren' },
  ];

  return { score, level, label, metrics, tips, raw: { fill, fastRatio, lostRatio, avgSpeed, yDrift, coverW, coverH } };
}
