# NeoCortex WebView: Kamera Modülü

iOS (WKWebView) ve Android (WebView) uygulamalarına gömülen kamera ekranı:

1. **Video çekimi:** Kamera açılır, deklanşöre basınca kayıt başlar, tekrar basınca durur. Birden çok parça çekebilirsin.
2. **Mavi katman:** Kayıt sırasında kamera hareketi takip edilir. Kadrajın içinden geçen (çekilmiş) alanlar canlı görüntünün üzerinde **maviye boyanır**. Sağ üstteki mini harita toplam kapsamayı ve şu anki kadrajı gösterir. Eksik kalan yer boş görünür, yeni bir çekimle tamamlarsın.
3. **Birleştirme:** "Bitir"e basınca
   - çekilen tüm video parçaları **tek bir videoda birleştirilir** (MP4, desteklenmiyorsa WebM),
   - videolardan alınan anahtar kareler tek bir **panorama görüntüsünde** birleştirilir.
4. **Perspektif:** Dört köşe dolaba otomatik yerleşir ya da elle taşınır (büyüteç yardımcı olur). "Perspektifi uygula" çapraz çekilmiş dolabı **düz, karşıdan bakış** haline getirir. Uzaktaki kenarın kısa görünmesi telafi edilir: gerçek en/boy oranı kamera geometrisinden hesaplanır (Zhang & He yöntemi). Odak uzaklığı dörtgenden bulunamazsa tipik telefon kamerası varsayılır.
5. **Video yükleme:** "Video yükle" ile galeriden bir video seçersin. Video kamera açıkmış gibi oynatılır: takip, mavi katman ve mini harita canlı çalışır. Kırmızı buton oynatmayı durdurur ya da devam ettirir. Bitir'den sonra akış aynıdır.
6. **Dolap algılama:** Kamera ya da yüklenen video ekranında dolap kadraja tam girince yeşil çerçeve ve "Dolap algılandı" etiketi çıkar. Çerçeve kamera hareketiyle birlikte kayar. Perspektif ekranında dört köşe otomatik olarak dolabın köşelerine yerleşir ("Otomatik bul" ile yeniden aranır). Yöntem makine öğrenmesi değildir: kenar ve doğru tespitiyle güçlü, tutarlı kenarları olan en büyük dörtgen aranır. Ürün kenarlarından oluşan sahte çerçeveler kenar yönü, kontrast ve tekdüzelik kontrolleriyle elenir.
7. **Kilitli dolap ve yakın çekim:** Dolap bulununca çerçeve kilitlenir ("Dolap kilitli"). Kare kare nokta takibi ve RANSAC homografi ile çerçeve dolaba yaklaşırken, kayarken ve açı değişirken dolabın üstünde kalır, ekranın dışına taşabilir. Dolap ekranın yarısından fazlasını kapladığında çekilen yerler dolabın üstünde maviye boyanır, mini harita dolabın hangi kısmının çekildiğini gösterir. Bitir'de yakın çekim kareleri doğrudan dolabın düz görünümüne yerleştirilir (perspektif adımı gerekmez, sonradan ayarlanabilir). Takip kaybolursa veriler korunur, dolabın tamamı yeniden kadraja girince aynı koordinatlarla devam edilir. Kilidi kaldırmak için yeşil etikete dokunulur.
8. **Analiz:** Sonuç ekranında kalite puanı (0-100), taranan alan, kapsama oranı, ortalama hız, hızlı anlar, takip kaybı, dikey sapma, kapsama haritası ve öneriler gösterilir.
9. **Gönder / Kaydet:** Perspektif görüntüsü (JPEG) ve birleştirilmiş video native uygulamaya köprüyle aktarılır. Native köprü yoksa (tarayıcıda) cihaza indirilir.

Görsel dil NeoCortex mobil kurallarına göre hazırlandı: lacivert `#0B4A8B`, kamera barı `#2A2E35`, 88px deklanşör, alttan açılan onay paneli.

## Canlı test linki

**https://kocerozan.github.io/Neocortexwebview/** (kısa link, kamera sayfasına yönlendirir; `?title=...&hint=...` parametreleri korunur). Doğrudan adres: https://kocerozan.github.io/Neocortexwebview/web/

## Klasörler

```
web/                  Webview içeriği (derleme gerektirmez, saf ES modülleri)
  index.html, styles.css
  js/app.js           Ekran akışı, kamera, kayıt, mavi katman
  js/tracker.js       Kamera hareket takibi (kaba→ince blok eşleme, alt-piksel)
  js/stitcher.js      Anahtar karelerden panorama (yumuşak dikiş)
  js/merger.js        Video parçalarını birleştirme (canvas + MediaRecorder)
  js/perspective.js   Homografi ve perspektif düzeltme
  js/detector.js      Dolap çerçevesi algılama (Hough doğruları + dörtgen seçimi)
  js/analysis.js      Çekim kalitesi analizi
  js/changelog.js     Sürüm notları (Yenilikler kartı)
  js/homotrack.js     Nokta takibi + RANSAC homografi (kilitli çerçeve)
  js/cabinetlock.js   Kilitli dolap: kilit, kayıp/yeniden yakalama, yakın çekim kapsaması
  js/bridge.js        iOS/Android mesaj köprüsü
ios/NeoCortexWebView/ Swift: NeoCortexWebViewController + örnek kullanım
android/              Kotlin örnek uygulama (web/ klasörü APK'ya gömülür)
tests/                Node birim testleri
scripts/serve.mjs     Yerel sunucu, scripts/e2e.mjs uçtan uca test
```

## Çalıştırma

```bash
npm start            # http://localhost:8080
npm test             # birim testleri (takip, homografi)
node scripts/e2e.mjs <sahte-kamera.y4m> e2e-out [video.mp4]
node scripts/e2e-detect.mjs <dolapli-video.mp4> e2e-out '[1.25,1.45]'        # dolap algılama
node scripts/e2e-detect.mjs <capraz-dolap.mp4> e2e-out - '[1.25,1.45]'      # çapraz çekimi düzleştirme
node scripts/e2e-lock.mjs <yaklasan.mp4> <gercek-koseler.json> e2e-out      # kilitli dolap + yakın çekim   # Chromium + sahte kamera (+ video yükleme) ile tüm akış
```

> Kamera (getUserMedia) yalnız **güvenli bağlamda** çalışır: `https://` ya da `localhost`. Telefonda denemek için sayfayı HTTPS bir sunucuya koy (veya bir HTTPS tünel kullan).

Sahte kamera videosu üretmek için:
```bash
ffmpeg -f lavfi -i "mandelbrot=size=2560x720" -frames:v 1 scene.png
ffmpeg -loop 1 -i scene.png -vf "crop=960:720:'min(t*200,1600)':0,scale=640:480,fps=30,format=yuv420p" -t 9 pan.y4m
```

## iOS entegrasyonu

1. `ios/NeoCortexWebView/NeoCortexWebViewController.swift` dosyasını projeye ekle.
2. Info.plist'e `NSCameraUsageDescription` ekle (bkz. `Info.plist.snippet.xml`).
3. `web/` klasörünü HTTPS bir adreste yayınla, `NeoCortexConfig.webURL` değerini o adres yap.
4. Aç:
   ```swift
   let vc = NeoCortexWebViewController(url: NeoCortexConfig.webURL, title: "Gondol #8069")
   vc.onResult = { r in /* r.imageURL, r.videoURL (geçici klasörde) */ }
   present(vc, animated: true)
   ```
- `allowsInlineMediaPlayback = true` ayarlı. Bu olmazsa iOS videoyu tam ekrana atar.
- iOS 15+ için ikinci izin penceresi çıkmaz, izin yalnız kendi alan adına verilir.
- Gereksinim: iOS 14.3+ (WKWebView getUserMedia), önerilen iOS 15+.

## Android entegrasyonu

`android/` klasörü Android Studio ile açılır. `web/` klasörü derlemede `assets/web` olarak APK'ya kopyalanır ve `https://appassets.androidplatform.net/assets/web/index.html` adresinden sunulur (WebViewAssetLoader). Bu adres güvenli bağlam sayıldığı için kamera çalışır, sunucu gerekmez.

```kotlin
val launcher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { res ->
    val image = res.data?.getStringExtra(NeoCortexWebViewActivity.EXTRA_IMAGE_PATH)
    val video = res.data?.getStringExtra(NeoCortexWebViewActivity.EXTRA_VIDEO_PATH)
}
launcher.launch(Intent(this, NeoCortexWebViewActivity::class.java)
    .putExtra(NeoCortexWebViewActivity.EXTRA_TITLE, "Gondol #8069"))
```
- `CAMERA` izni çalışma anında istenir. WebView izin isteği yalnız güvenilen kaynağa verilir.
- Köprü `WebViewCompat.addWebMessageListener` ile kurulu ve sadece güvenilen kaynaktan mesaj kabul eder.
- minSdk 26. Güncel "Android System WebView" gerekir.

## Köprü protokolü (Web → Native)

| Mesaj | Alanlar |
|---|---|
| `ready` | `version`, `platform` |
| `file.begin` | `id`, `kind` (`image`/`video`), `mimeType`, `size`, `chunks`, `meta` |
| `file.chunk` | `id`, `index`, `data` (base64, her parça bağımsız çözülür, 192 KB) |
| `file.end` | `id` |
| `result.complete` | `imageId`, `videoId`, `clips` |
| `close` | (kapat butonu) |

iOS: `window.webkit.messageHandlers.neocortex.postMessage(obj)` · Android: `window.NeoCortexAndroid.postMessage(JSON.stringify(obj))`

Native → Web: `window.NeoCortex.reset()`, `window.NeoCortex.setInfo({ title, hint })`. URL parametreleri: `?title=...&hint=...`

## Yenilikler kartı ve sürümler

Sayfa açılınca üstte "Yenilikler" kartı çıkar. Kart, o cihazda son görülen sürümden bu yana eklenenleri gösterir (ilk ziyarette yalnız son sürüm). "Tamam" deyince bir sonraki sürüme kadar çıkmaz. Kamera ekranındaki sürüm etiketine (ör. `v1.5`) dokununca tüm sürüm notları açılır.

Yeni sürüm çıkarırken `web/js/changelog.js` dosyasında `APP_VERSION` değerini artır ve `CHANGELOG` listesinin en üstüne o sürümün maddelerini ekle. `npm test` sıralamayı ve sürüm tutarlılığını kontrol eder.

## Teknik notlar ve sınırlar

- **Takip:** 160px genişliğe küçültülmüş gri karelerde kaba→ince blok eşleme yapılır, alt-piksel doğrulukla. Telefonda kare başına birkaç ms sürer. Dokusuz yüzeylerde (düz duvar) takip kendini durdurur, kayma birikmez. Model yalnız **öteleme** içindir: kamerayı rafa paralel kaydırarak çekim en iyi sonucu verir. Yerinde dönerek çekmek panoramada bozulma yapar, perspektif adımı bunu kısmen düzeltir.
- **Çok hızlı kaydırma** (kare başına ~14px'ten fazla) olursa "Çok hızlı, yavaşla" uyarısı çıkar.
- **Video birleştirme** tarayıcıda gerçek zamanlı yapılır: 30 sn'lik çekimi birleştirmek ~30 sn sürer. Bu süre perspektif ayarlanırken arka planda geçer.
- Ekran yönü değişirse takip sıfırlanır, native tarafta dikey kilit önerilir.
- Ses kaydedilmez (mikrofon izni istenmez).
