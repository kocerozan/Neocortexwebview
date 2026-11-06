// Sürüm notları. Yeni sürüm çıkınca en üste ekle ve APP_VERSION'ı güncelle.
// Sayfa açılınca, bu cihazda son görülen sürümden yeni olan maddeler üstte gösterilir.

export const APP_VERSION = '1.6';

export const CHANGELOG = [
  {
    version: '1.6',
    date: '6 Kasım 2026',
    items: [
      'Kilitli dolap: dolap bulununca çerçeve kilitlenir; yaklaştıkça, kaydıkça dolabın üstünde kalır.',
      'Yakın çekim kapsaması: dolap ekranı doldurunca çektiğin yerler dolabın üstünde maviye boyanır; mini harita dolabı gösterir.',
      'Yakın çekimlerden düz dolap: Bitir’e basınca kareler doğrudan dolabın düz görünümüne yerleşir, daha detaylı sonuç.',
      'Kilidi kaldırmak için yeşil "Dolap kilitli" etiketine dokun.',
    ],
  },
  {
    version: '1.5',
    date: '5 Kasım 2026',
    items: [
      'Çapraz çekimde perspektif: yandan çektiğin dolap düz, karşıdan bakış haline getirilir.',
      'Gerçek oran: uzaktaki kenarın kısa görünmesi telafi edilir, dolap basık çıkmaz.',
      'Yamuk görünen dolaplar da otomatik bulunur; bulunamazsa köşeleri sürükleme uyarısı çıkar.',
    ],
  },
  {
    version: '1.4',
    date: '5 Kasım 2026',
    items: [
      'Dolap algılama: dolap kadraja girince yeşil çerçeve ve "Dolap algılandı" etiketi.',
      'Perspektif ekranında köşeler dolabın köşelerine otomatik yerleşir; "Otomatik bul" ile yeniden aranır.',
    ],
  },
  {
    version: '1.3',
    date: '5 Kasım 2026',
    items: [
      'Video yükle: galeriden seçtiğin video kamera gibi oynar; mavi katman ve takip canlı çalışır.',
      'Analiz: kalite puanı, kapsama, hız, takip kaybı, kapsama haritası ve öneriler.',
    ],
  },
  {
    version: '1.2',
    date: '5 Kasım 2026',
    items: ['Fotoğrafı ve videoyu kaydet: telefonda paylaşım menüsünden galeriye kaydedebilirsin.'],
  },
  {
    version: '1.0',
    date: '5 Kasım 2026',
    items: ['İlk sürüm: video çekimi, mavi kapsama katmanı, videoları birleştirme ve perspektif düzeltme.'],
  },
];

const parts = (v) => String(v).split('.').map((n) => parseInt(n, 10) || 0);

export function compareVersions(a, b) {
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

/**
 * Gösterilecek sürüm notları. İlk ziyarette yalnız son sürüm; sonra son görülenden yeniler.
 * lastSeen güncel ya da daha yeniyse boş dizi döner.
 */
export function entriesToShow(lastSeen, { max = 3 } = {}) {
  if (!lastSeen) return CHANGELOG.slice(0, 1);
  return CHANGELOG.filter((e) => compareVersions(e.version, lastSeen) > 0).slice(0, max);
}
