// Camda yansıma testi: tavan lambası yansıyan camlı dolap (kamera elde sallanır).
// Kapak açılmadan önce yansımadan "kapalı" anlaşılmalı, açılınca "açık" olmalı.
// Kullanım: node scripts/e2e-glare.mjs <video.mp4> [çıktı]
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
const { chromium } = createRequire(import.meta.url)('playwright');

const [video, outDir = '.'] = process.argv.slice(2);
if (!video) { console.error('Kullanım: node scripts/e2e-glare.mjs <video.mp4> [çıktı]'); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });
const port = 8130;
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
  let shot = false;
  for (;;) {
    const s = await page.evaluate(() => {
      const v = document.getElementById('preview');
      const D = window.__neocortex.door;
      return { t: v.currentTime, ended: v.ended, state: D ? D.state : 'none', reason: D ? D.reason : null, glare: D ? D.glare.state : '-', frac: D ? D.glare.lastFrac : 0, chip: document.getElementById('chip-door-text').textContent };
    });
    if (s.ended) break;
    samples.push(s);
    if (!shot && s.reason === 'yansıma') { shot = true; await page.screenshot({ path: `${outDir}/Y1-yansima.png` }); }
    await page.waitForTimeout(120);
  }
  const at = (t) => samples.reduce((b, s) => (Math.abs(s.t - t) < Math.abs(b.t - t) ? s : b));
  console.log('zaman çizelgesi:', samples.filter((_, i) => i % 3 === 0).map((s) => `${s.t.toFixed(1)}:${s.state}/${s.glare}(${(s.frac * 100).toFixed(1)}%)`).join(' '));
  const ev = await page.evaluate(() => (window.__neocortex.door ? window.__neocortex.door.events : []));
  console.log('olaylar:', JSON.stringify(ev.map((e) => ({ t: +e.t.toFixed(2), type: e.type }))));
  const g = ev.find((e) => e.type === 'glare');
  check(g && g.t < 3.0, `kapak açılmadan yansımadan "kapalı" anlaşıldı (${g ? g.t.toFixed(2) + ' sn' : 'yok'})`);
  check(at(2.8).state === 'closed' && at(2.8).chip.includes('yansıma'), `2,8 sn: etiket "${at(2.8).chip}"`);
  const op = ev.find((e) => e.type === 'opened');
  check(op && op.t > 3.0 && op.t < 5.0, `kapak açıldı olayı (${op ? op.t.toFixed(2) + ' sn' : 'yok'}; gerçek 3-4 sn)`);
  check(at(6.8).state === 'open', `kapak açıkken sonda: ${at(6.8).state} — "${at(6.8).chip}"`);
} catch (e) { ok = false; console.error(e); }
finally {
  if (errors.length) { ok = false; console.log('sayfa hataları:', errors); }
  await browser.close(); server.kill();
}
process.exit(ok ? 0 : 1);
