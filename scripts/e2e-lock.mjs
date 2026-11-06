// Kilitli dolap testi: dolaba yaklaşan video yüklenir; kilitli çerçeve her an gerçek köşelerle
// karşılaştırılır, sonunda yakın çekimlerden oluşan düz dolap görüntüsü kontrol edilir.
// Kullanım: node scripts/e2e-lock.mjs <video.mp4> <gercek-koseler.json> [çıktı] [sonuç-oranı, ör. [1.25,1.45]]
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
const { chromium } = createRequire(import.meta.url)('playwright');

const [video, truthFile, outDir = '.', resultJson = '[1.25,1.45]'] = process.argv.slice(2);
if (!video || !truthFile) { console.error('Kullanım: node scripts/e2e-lock.mjs <video.mp4> <truth.json> [çıktı] [oran]'); process.exit(2); }
const truth = JSON.parse(fs.readFileSync(truthFile, 'utf8'));
fs.mkdirSync(outDir, { recursive: true });
const port = 8127;
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
  if (await page.isVisible('#whatsnew')) await page.click('#wn-ok');
  await page.setInputFiles('#file-input', path.resolve(video));
  await page.waitForFunction(() => window.__neocortex.mode === 'upload' && window.__neocortex.recording, null, { timeout: 10000 });

  const samples = [];
  const shots = { 1.3: 'L1-kilit', 3.6: 'L2-yaklasma', 6.5: 'L3-yakin-cekim' };
  const taken = new Set();
  for (;;) {
    const s = await page.evaluate(() => {
      const v = document.getElementById('preview');
      const L = window.__neocortex.lock;
      return { t: v.currentTime, ended: v.ended, state: L ? L.state : 'off', q: L && L.quad ? L.quad.map((p) => ({ ...p })) : null, w: L ? L.w : 0, h: L ? L.h : 0 };
    });
    if (s.ended) break;
    samples.push(s);
    for (const [t, name] of Object.entries(shots)) {
      if (!taken.has(name) && s.t >= +t) { taken.add(name); await page.screenshot({ path: `${outDir}/${name}.png` }); }
    }
    await page.waitForTimeout(150);
  }
  // Çerçeve doğruluğu: kilitli çerçeve köşeleri vs gerçek köşeler (gerçek dörtgen köşegenine oranla)
  const errs = [];
  for (const s of samples) {
    if (s.state !== 'on' || !s.q) continue;
    const k = Math.min(truth.quads.length - 1, Math.round(s.t * truth.fps));
    const tq = truth.quads[k];
    const sx = truth.w / s.w, sy = truth.h / s.h;
    const diag = Math.hypot(tq[2][0] - tq[0][0], tq[2][1] - tq[0][1]);
    const e = Math.max(...s.q.map((p, i) => Math.hypot(p.x * sx - tq[i][0], p.y * sy - tq[i][1]))) / diag;
    errs.push({ t: s.t, e });
  }
  const lockedAt = samples.find((s) => s.state === 'on');
  const after = samples.filter((s) => lockedAt && s.t >= lockedAt.t);
  const onRatio = after.filter((s) => s.state === 'on').length / Math.max(1, after.length);
  const maxE = Math.max(...errs.map((x) => x.e));
  const late = errs.filter((x) => x.t > 6);
  console.log(`kilitlenme: ${lockedAt ? lockedAt.t.toFixed(2) + ' sn' : 'yok'}, kilitli kalma oranı %${(onRatio * 100).toFixed(0)}, örnek ${errs.length}`);
  console.log('hata (köşegenin %):', errs.filter((_, i) => i % 4 === 0).map((x) => `${x.t.toFixed(1)}s:${(x.e * 100).toFixed(1)}`).join(' '));
  check(!!lockedAt && lockedAt.t < 2.0, 'dolap uzaktan görünürken kilitlendi');
  check(onRatio > 0.95, 'yaklaşma ve yakın çekim boyunca kilit korundu');
  check(maxE < 0.06, `kilitli çerçeve gerçek dolaba oturuyor (en büyük sapma köşegenin %${(maxE * 100).toFixed(1)}'i)`);
  check(late.length > 0, 'yakın çekim aşamasında da ölçüldü');
  // Kapaksız dolap: yaklaşma/kaydırma kapak olayı üretmemeli
  const doorEv = await page.evaluate(() => (window.__neocortex.door ? window.__neocortex.door.events.map((e) => `${e.t.toFixed(1)}:${e.type}`) : []));
  check(doorEv.length === 0, `yaklaşırken yanlış kapak olayı yok ${doorEv.length ? JSON.stringify(doorEv) : ''}`);

  await page.click('#btn-finish');
  await page.waitForSelector('#screen-result:not(.hidden)', { timeout: 60000 });
  await page.waitForTimeout(500);
  const res = await page.evaluate(() => ({ rect: window.__neocortex.rectified, size: window.__neocortex.resultSize, filled: window.__neocortex.rectFilled, kfs: window.__neocortex.lock.kfs.length, cov: window.__neocortex.lock.coverage(), an: window.__neocortex.analysis.metrics.map((m) => `${m.label}=${m.value}`).join(', ') }));
  console.log('sonuç:', JSON.stringify(res));
  const [lo, hi] = JSON.parse(resultJson);
  const ar = res.size.width / res.size.height;
  check(res.rect, 'yakın çekimlerden düz dolap görüntüsü oluşturuldu');
  check(ar >= lo && ar <= hi, `düz dolap oranı ${ar.toFixed(2)} (beklenen ${lo}–${hi})`);
  check(res.filled > 0.85, `dolabın %${(res.filled * 100).toFixed(0)}'i görüntüde dolu`);
  // Uzaktan kare her yeri boyamamalı: kapsama yalnız yakın çekimden gelir
  check(res.cov > 0.3 && res.cov < 0.98, `yakın çekim kapsaması %${(res.cov * 100).toFixed(0)} (uzaktan çekim sayılmıyor)`);
  await page.screenshot({ path: `${outDir}/L4-sonuc.png` });
  fs.writeFileSync(`${outDir}/L5-duz-dolap.png`, Buffer.from((await page.evaluate(() => document.getElementById('result-canvas').toDataURL('image/png'))).split(',')[1], 'base64'));
} catch (e) { ok = false; console.error(e); }
finally {
  if (errors.length) { ok = false; console.log('sayfa hataları:', errors); }
  await browser.close(); server.kill();
}
process.exit(ok ? 0 : 1);
