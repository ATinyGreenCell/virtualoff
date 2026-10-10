import puppeteer from 'puppeteer-core';
import { CHROME, url, startCpuBattle } from './harness.mjs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox', '--autoplay-policy=no-user-gesture-required'], defaultViewport: { width: 640, height: 360 } });
const page = await browser.newPage();
const logs = [];
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
page.on('console', (m) => { const t = m.text(); if (m.type() === 'error' || m.type() === 'warning' || /\[audio\]/.test(t)) logs.push(`[${m.type()}] ${t}`); });
await page.goto(url({ audio: true }), { waitUntil: 'networkidle0' });
const press = async (k) => { await page.keyboard.down(k); await sleep(60); await page.keyboard.up(k); };
const state = () => page.evaluate(async () => {
  const a = window.__vo?.audio;
  if (!a) return { missing: true };
  if (!a.__counted) { a.__counted = {}; const orig = a.play.bind(a); a.play = (n, o) => { a.__counted[n] = (a.__counted[n] || 0) + 1; return orig(n, o); }; }
  const s = window.__vo?.app?.screen;
  return { ctx: a.ctx?.state, ready: a.ready, musicReady: a.lib.musicReady, libDone: a.lib.done, track: a.current, playing: a.players.filter((p) => !p.finished).length,
    screen: s?.constructor?.name, phase: s?.phase, sfx: a.__counted, voices: [...a.voices.values()].reduce((n, l) => n + l.length, 0) };
});
await sleep(800);
await press('Enter');
const t0 = Date.now();
let st = await state();
while (Date.now() - t0 < 15000 && !(st.ready && st.musicReady && st.playing)) { await sleep(250); st = await state(); }
console.log('title', JSON.stringify(st), `after ${Date.now() - t0} ms`);
await startCpuBattle(page, { fight: false });
for (let i = 0; i < 60; i++) { st = await state(); if (st.phase === 'fight') break; await sleep(250); }
console.log('battle', JSON.stringify(st));
for (let i = 0; i < 24; i++) {
  await page.keyboard.down('KeyW'); await press(i % 3 === 0 ? 'KeyJ' : 'KeyL'); if (i % 6 === 0) await press('Space'); await sleep(180); await page.keyboard.up('KeyW');
}
await sleep(1500);
st = await state();
console.log('after combat', JSON.stringify(st));
console.log('--- logs ---\n' + (logs.join('\n') || 'none'));
await browser.close();
