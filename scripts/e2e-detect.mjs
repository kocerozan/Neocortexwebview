// Dolap algılama testi: dolaplı bir video yüklenir; canlı yeşil çerçeve ve
// perspektif ekranında otomatik köşeler kontrol edilir.
// Kullanım: node scripts/e2e-detect.mjs <dolap-video.mp4> [çıktı] [beklenen-oran-aralığı-json, ör. [1.25,1.45]]
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
const { chromium } = createRequire(import.meta.url)('playwright');

const [video, outDir = '.', expectJson] = process.argv.slice(2);
if (!video) { console.error('Kullanım: node scripts/e2e-detect.mjs <video.mp4> [çıktı] [beklenen]'); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });
const port = 8124;
const server = spawn(process.execPath, [path.resolve('scripts/serve.mjs'), String(port)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 400));
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
let ok = true;
const check = (c, m) => { console.log(`${c ? 'OK  ' : 'FAIL'} ${m}`); if (!c) ok = false; };
try {
  await page.goto(`http://localhost:${port}/?title=Dik%20dolap%20%238069`);
  await page.waitForFunction(() => window.NeoCortex, null, { timeout: 10000 });
  await page.setInputFiles('#file-input', path.resolve(video));
  await page.waitForFunction(() => window.__neocortex.mode === 'upload' && window.__neocortex.recording, null, { timeout: 10000 });
  const seen = await page.waitForFunction(() => window.__neocortex.det.shown, null, { timeout: 15000 }).then(() => true, () => false);
  check(seen, 'canlı görüntüde dolap algılandı (yeşil çerçeve)');
  if (seen) {
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${outDir}/d1-canli-cerceve.png` });
  }
  await page.waitForFunction(() => document.getElementById('preview').ended, null, { timeout: 30000 });
  await page.click('#btn-finish');
  await page.waitForSelector('#screen-perspective:not(.hidden)', { timeout: 20000 });
  await page.waitForTimeout(300);
  const st = await page.evaluate(() => ({ auto: window.__neocortex.cornersAuto, c: window.__neocortex.corners, w: window.__neocortex.pano.width, h: window.__neocortex.pano.height, info: document.getElementById('persp-info').textContent }));
  check(st.auto, `perspektifte köşeler otomatik yerleşti — "${st.info}"`);
  const rel = st.c.map((p) => ({ x: +(p.x / st.w).toFixed(3), y: +(p.y / st.h).toFixed(3) }));
  console.log('otomatik köşeler (oransal):', JSON.stringify(rel));
  if (expectJson) {
    // Panorama genişliği takibe bağlı (dokusuz duvarda daralır), o yüzden dolabın
    // en-boy oranını karşılaştır: beklenen [min, max]
    const [lo, hi] = JSON.parse(expectJson);
    const c = st.c;
    const wq = (Math.hypot(c[1].x - c[0].x, c[1].y - c[0].y) + Math.hypot(c[2].x - c[3].x, c[2].y - c[3].y)) / 2;
    const hq = (Math.hypot(c[3].x - c[0].x, c[3].y - c[0].y) + Math.hypot(c[2].x - c[1].x, c[2].y - c[1].y)) / 2;
    check(wq / hq >= lo && wq / hq <= hi, `dolap en-boy oranı ${(wq / hq).toFixed(2)} (beklenen ${lo}–${hi})`);
  }
  await page.screenshot({ path: `${outDir}/d2-otomatik-kose.png` });
  await page.click('#btn-apply');
  await page.waitForSelector('#screen-result:not(.hidden)', { timeout: 20000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${outDir}/d3-sonuc.png` });
} catch (e) { ok = false; console.error(e); }
finally {
  if (errors.length) { ok = false; console.log('sayfa hataları:', errors); }
  await browser.close(); server.kill();
}
process.exit(ok ? 0 : 1);
