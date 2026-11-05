// Uçtan uca duman testi: sahte kamera (kaydırılan görüntü) ile tüm akış.
// Kullanım: node scripts/e2e.mjs <sahte-video.mjpeg|y4m> [çıktı-klasörü]
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright'); // global veya yerel kurulum
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const video = process.argv[2];
const outDir = process.argv[3] || '.';
if (!video) { console.error('Kullanım: node scripts/e2e.mjs <video.mjpeg> [çıktı]'); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });

const port = 8123;
const server = spawn(process.execPath, [path.resolve('scripts/serve.mjs'), String(port)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 400));

const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${path.resolve(video)}`],
});
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
const messages = [];
await page.exposeFunction('__collect', (m) => messages.push(m));
await page.addInitScript(() => window.addEventListener('neocortex:message', (e) => {
  const { data, ...rest } = e.detail; window.__collect({ ...rest, dataLen: data ? data.length : undefined });
}));

const wait = (ms) => page.waitForTimeout(ms);
const pos = () => page.evaluate(() => ({ ...window.__neocortex.pos, t: performance.now() }));
let ok = true;
const check = (cond, msg) => { console.log(`${cond ? 'OK  ' : 'FAIL'} ${msg}`); if (!cond) ok = false; };

try {
  await page.goto(`http://localhost:${port}/?title=Gondol%20%238069`);
  await page.waitForFunction(() => window.__neocortex.vw > 0, null, { timeout: 10000 });
  await wait(500);
  const p0 = await pos();
  await page.click('#btn-record');
  await wait(3000);
  await page.screenshot({ path: `${outDir}/1-kayit.png` });
  await page.click('#btn-record');
  await wait(1000);
  await page.click('#btn-record');
  await wait(2500);
  await page.click('#btn-record');
  const p1 = await pos();
  const rate = (p1.x - p0.x) / ((p1.t - p0.t) / 1000);
  console.log(`takip hızı: ${rate.toFixed(1)} proc px/s (beklenen ≈ -33 … +33 aralığında, |33|), y kayması ${(p1.y - p0.y).toFixed(1)}`);
  check(Math.abs(Math.abs(rate) - 33.3) < 6, 'kamera kaydırması doğru izleniyor');
  check(Math.abs(p1.y - p0.y) < 8, 'dikey kayma küçük');
  await wait(300);
  const st = await page.evaluate(() => ({ clips: window.__neocortex.clips.length, kfs: window.__neocortex.keyframes.length, cover: window.__neocortex.cover }));
  console.log('durum:', JSON.stringify(st));
  check(st.clips === 2, '2 video parçası kaydedildi');
  check(st.kfs >= 4, 'anahtar kareler alındı');

  await page.click('#btn-finish');
  await page.waitForSelector('#screen-perspective:not(.hidden)', { timeout: 20000 });
  await wait(300);
  const pano = await page.evaluate(() => ({ w: window.__neocortex.pano.width, h: window.__neocortex.pano.height }));
  console.log('panorama:', pano);
  check(pano.w > pano.h * 1.5, 'yatay panorama oluştu');
  // bir köşeyi sürükle
  const hb = await page.locator('.handle[data-i="1"]').boundingBox();
  await page.mouse.move(hb.x + 22, hb.y + 22);
  await page.mouse.down();
  await page.mouse.move(hb.x + 10, hb.y + 40, { steps: 5 });
  await page.screenshot({ path: `${outDir}/2-perspektif.png` });
  await page.mouse.up();

  await page.click('#btn-apply');
  await page.waitForSelector('#screen-result:not(.hidden)', { timeout: 20000 });
  await page.waitForFunction(() => !!window.__neocortex.merged, null, { timeout: 30000 });
  await wait(500);
  const res = await page.evaluate(() => ({ img: window.__neocortex.resultSize, vid: { size: window.__neocortex.merged.blob.size, type: window.__neocortex.merged.mimeType, dur: window.__neocortex.merged.duration } }));
  console.log('sonuç:', JSON.stringify(res));
  check(res.vid.size > 10000, 'birleştirilmiş video üretildi');
  const vd = await page.evaluate(() => new Promise((r) => {
    const v = document.getElementById('merged-video');
    if (v.readyState >= 1) return r({ w: v.videoWidth, h: v.videoHeight });
    v.onloadedmetadata = () => r({ w: v.videoWidth, h: v.videoHeight });
    setTimeout(() => r(null), 5000);
  }));
  check(vd && vd.w > 0, `birleştirilmiş video oynatılabilir ${JSON.stringify(vd)}`);
  await page.screenshot({ path: `${outDir}/3-sonuc.png` });
  fs.writeFileSync(`${outDir}/perspektif.png`, Buffer.from((await page.evaluate(() => document.getElementById('result-canvas').toDataURL('image/png'))).split(',')[1], 'base64'));
  const vb64 = await page.evaluate(async () => { const b = window.__neocortex.merged.blob; const r = new FileReader(); return await new Promise((ok) => { r.onload = () => ok(String(r.result).split(',')[1]); r.readAsDataURL(b); }); });
  fs.writeFileSync(`${outDir}/birlesik.${res.vid.type.includes('mp4') ? 'mp4' : 'webm'}`, Buffer.from(vb64, 'base64'));

  // Köprü mesajları (tarayıcıda native yok → indirme yolu; olayları yine de doğrula)
  await page.evaluate(() => { window.NeoCortexAndroid = { postMessage() {} }; });
  await page.click('#btn-send');
  await page.waitForFunction(() => document.getElementById('busy').classList.contains('hidden'), null, { timeout: 30000 });
  const types = messages.map((m) => m.type);
  console.log('köprü mesajları:', [...new Set(types)].join(', '), `(${messages.length})`);
  check(types.includes('ready') && types.includes('file.end') && types.includes('result.complete'), 'köprü protokolü çalışıyor');
} catch (e) {
  ok = false;
  console.error(e);
} finally {
  const errs = logs.filter((l) => /error/i.test(l));
  if (errs.length) console.log('konsol hataları:\n' + errs.join('\n'));
  await browser.close();
  server.kill();
}
process.exit(ok ? 0 : 1);
