import puppeteer from 'puppeteer-core';
import { CHROME, url, startCpuBattle } from './harness.mjs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox', '--autoplay-policy=no-user-gesture-required'], defaultViewport: { width: 640, height: 360 } });
const page = await browser.newPage();
const logs = [];
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`); });
// a fake non-standard pad: triggers exposed as axes 2 and 5 resting at -1
await page.evaluateOnNewDocument(() => {
  const btn = () => ({ pressed: false, touched: false, value: 0 });
  const fake = { index: 0, id: 'Fake Generic Pad', mapping: '', connected: true, timestamp: 0, buttons: Array.from({ length: 11 }, btn), axes: [0, 0, -1, 0, 0, -1] };
  window.__fakePad = fake;
  window.__usePad = false;
  const orig = navigator.getGamepads.bind(navigator);
  navigator.getGamepads = () => (window.__usePad ? [fake, null, null, null] : orig());
});
await page.goto(url({ audio: true }), { waitUntil: 'networkidle0' });
const press = async (k) => { await page.keyboard.down(k); await sleep(60); await page.keyboard.up(k); };
const st = () => page.evaluate(() => { const a = window.__vo.audio; let v = 0; for (const l of a.voices.values()) v += l.length; return { ctx: a.ctx?.state, track: a.current, players: a.players.length, live: a.players.filter((p) => !p.finished).length, voices: v, muted: a.muted, master: +a.mixer?.master.gain.value.toFixed(2) }; });
await sleep(600); await press('Enter');
for (let i = 0; i < 40; i++) { const s = await st(); if (s.ctx === 'running' && s.live) break; await sleep(250); }
console.log('1 title          ', JSON.stringify(await st()));

// a) rapid track switching
await page.evaluate(async () => { const a = window.__vo.audio; const t = ['title', 'select', 'stageA', 'stageB']; for (let i = 0; i < 40; i++) { a.playMusic(t[i % 4]); await new Promise((r) => setTimeout(r, 40)); } });
console.log('2 after 40 switches', JSON.stringify(await st()));
await sleep(2500);
console.log('3 2.5s later       ', JSON.stringify(await st()));

// b) SFX flood: 1000 random effects in ~1 s
const flood = await page.evaluate(async () => {
  const a = window.__vo.audio; const names = [...a.lib.sfx.keys()]; let peak = 0, errors = 0;
  for (let i = 0; i < 1000; i++) {
    try { a.play(names[i % names.length], { pan: Math.random() * 2 - 1, pitch: 0.8 + Math.random() * 0.4 }); } catch { errors++; }
    let v = 0; for (const l of a.voices.values()) v += l.length; peak = Math.max(peak, v);
    if (i % 20 === 0) await new Promise((r) => setTimeout(r, 20));
  }
  return { peak, errors };
});
console.log('4 sfx flood        ', JSON.stringify(flood));

// c) mute spam ends unmuted with master restored
await page.evaluate(() => { const a = window.__vo.audio; for (let i = 0; i < 21; i++) a.toggleMute(); a.muted = false; });
await sleep(300);
console.log('5 mute spam        ', JSON.stringify(await st()));

// d) hide / show
await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
await sleep(400);
const hidden = await st();
await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
await sleep(600);
console.log('6 hidden -> shown  ', hidden.ctx, '->', (await st()).ctx);

// e) the browser closes the context: next gesture rebuilds it and the music comes back
await page.evaluate(async () => { await window.__vo.audio.ctx.close(); });
console.log('7 closed           ', JSON.stringify(await st()));
await press('Shift');
for (let i = 0; i < 20; i++) { const s = await st(); if (s.ctx === 'running' && s.live) break; await sleep(200); }
console.log('8 after gesture    ', JSON.stringify(await st()));
const after = await page.evaluate(() => { const a = window.__vo.audio; a.play('rifle'); let v = 0; for (const l of a.voices.values()) v += l.length; return v; });
console.log('9 sfx on new ctx: voices =', after);

// f) non-standard pad with triggers resting at -1 must not steer
await startCpuBattle(page);
await page.evaluate(() => { window.__usePad = true; window.__fakePad.buttons[0] = { pressed: true, touched: true, value: 1 }; });
await sleep(150);
await page.evaluate(() => { window.__fakePad.buttons[0] = { pressed: false, touched: false, value: 0 }; });
await sleep(700);
const c = await page.evaluate(() => { const c = window.__vo.app.input.controls; return { moveX: c.moveX, moveY: c.moveY, turn: c.turn, padConnected: window.__vo.app.input.padConnected }; });
console.log('10 resting fake pad ', JSON.stringify(c));
await page.evaluate(() => { window.__fakePad.axes[0] = 0.9; });
await sleep(200);
console.log('11 left stick right', JSON.stringify(await page.evaluate(() => { const c = window.__vo.app.input.controls; return { moveX: +c.moveX.toFixed(2), turn: c.turn }; })));
console.log('--- errors ---\n' + (logs.join('\n') || 'none'));
await browser.close();
