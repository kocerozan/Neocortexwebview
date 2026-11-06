// Kapak tespiti testi: kapağı açılıp kapanan dolap videosu yüklenir, etiket gerçek durumla karşılaştırılır.
// Kullanım: node scripts/e2e-door.mjs <video.mp4> <gercek-durum.json> [çıktı]
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
const { chromium } = createRequire(import.meta.url)('playwright');

const [video, truthFile, outDir = '.'] = process.argv.slice(2);
if (!video || !truthFile) { console.error('Kullanım: node scripts/e2e-door.mjs <video.mp4> <truth.json> [çıktı]'); process.exit(2); }
const truth = JSON.parse(fs.readFileSync(truthFile, 'utf8'));
fs.mkdirSync(outDir, { recursive: true });
const port = 8128;
const server = spawn(process.execPath, [path.resolve('scripts/serve.mjs'), String(port)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 400));
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
let ok = true;
const check = (c, m) => { console.log(`${c ? 'OK  ' : 'FAIL'} ${m}`); if (!c) ok = false; };
try {
  await page.goto(`http://localhost:${port}/`);
  await page.waitForFunction(() => window.NeoCortex, null, { timeout: 10000 });
  if (await page.isVisible('#whatsnew')) await page.click('#wn-ok');
  await page.setInputFiles('#file-input', path.resolve(video));
  await page.waitForFunction(() => window.__neocortex.mode === 'upload' && window.__neocortex.recording, null, { timeout: 10000 });
  const samples = [];
  const shots = { 1.8: 'K1-kapali', 4.0: 'K2-acik', 6.6: 'K3-kapandi' };
  const taken = new Set();
  for (;;) {
    const s = await page.evaluate(() => {
      const v = document.getElementById('preview');
      const D = window.__neocortex.door;
      const L = window.__neocortex.lock;
      return { t: v.currentTime, ended: v.ended, lock: L ? L.state : 'off', state: D ? D.state : 'none', moving: D ? D.moving : false, chip: document.getElementById('chip-door-text').textContent, diff: D ? D.lastDiff : 0 };
    });
    if (s.ended) break;
    samples.push(s);
    for (const [t, name] of Object.entries(shots)) if (!taken.has(name) && s.t >= +t) { taken.add(name); await page.screenshot({ path: `${outDir}/${name}.png` }); }
    await page.waitForTimeout(120);
  }
  const at = (t) => samples.reduce((b, s) => (Math.abs(s.t - t) < Math.abs(b.t - t) ? s : b));
  console.log('zaman çizelgesi:', samples.filter((_, i) => i % 3 === 0).map((s) => `${s.t.toFixed(1)}:${s.state}${s.moving ? '*' : ''}(${s.diff.toFixed(0)})`).join(' '));
  const ev = await page.evaluate(() => (window.__neocortex.door ? window.__neocortex.door.events : []));
  console.log('olaylar:', JSON.stringify(ev.map((e) => ({ t: +e.t.toFixed(2), type: e.type }))));
  check(at(1.8).lock === 'on', 'dolap kilitli');
  check(['closed', 'unknown'].includes(at(1.8).state), `kapak açılmadan önce: ${at(1.8).state} (kapalı ya da bilinmiyor olmalı)`);
  check(at(4.2).state === 'open', `kapak açıkken: ${at(4.2).state} — etiket "${at(4.2).chip}"`);
  check(at(6.8).state === 'closed', `kapak kapandıktan sonra: ${at(6.8).state} — etiket "${at(6.8).chip}"`);
  const types = ev.map((e) => e.type);
  check(types.join(',') === 'opened,closed', `olay sırası: ${types.join(', ') || '(yok)'}`);
  const op = ev.find((e) => e.type === 'opened');
  // Karar hareket bitince verilir: gerçek hareket 2-3 sn, bildirim en geç ~1 sn sonra
  check(op && op.t > 2.0 && op.t < 4.2, `açılma bildirimi ${op ? op.t.toFixed(2) : '-'} sn (kapak 2-3 sn arası açılıyor)`);
  const cl = ev.find((e) => e.type === 'closed');
  check(cl && cl.t > 4.5 && cl.t < 6.7, `kapanma bildirimi ${cl ? cl.t.toFixed(2) : '-'} sn (kapak 4,5-5,5 sn arası kapanıyor)`);
  const flicker = samples.filter((s) => s.t > 3.8 && s.t < 4.4 && s.moving).length;
  check(flicker === 0, 'kapak açık dururken "hareket ediyor" titremesi yok');
} catch (e) { ok = false; console.error(e); }
finally {
  if (errors.length) { ok = false; console.log('sayfa hataları:', errors); }
  await browser.close(); server.kill();
}
process.exit(ok ? 0 : 1);
