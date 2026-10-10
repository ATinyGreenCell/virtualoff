import puppeteer from 'puppeteer-core';
import { CHROME, OUT, url, startCpuBattle } from './harness.mjs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true,
  args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--no-sandbox'], defaultViewport: { width: 640, height: 360 } });
const page = await browser.newPage();
const logs = [];
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack}`));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warn' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`); });
await page.goto(url(), { waitUntil: 'networkidle0' });
const press = async (k) => { await page.keyboard.down(k); await sleep(60); await page.keyboard.up(k); };
const info = () => page.evaluate(() => { const s = window.__vo.app.screen; return { screen: s.constructor.name, phase: s.phase, round: s.round, wins: s.wins && [...s.wins], hp: s.mechs ? [Math.round(s.mechs[0].hp), Math.round(s.mechs[1].hp)] : null, stageNo: s.setup?.stageNo, stage: s.setup?.stage, cpu: s.setup?.mech1?.name }; });
const kill = (who) => page.evaluate((who) => { const s = window.__vo.app.screen; const m = who === 1 ? s.mechs[0] : s.mechs[1]; const THREE_dir = { x: 0, y: 0, z: 1, clone() { return this; } }; m.invuln = 0; m.takeHit({ damage: 99999, knock: 'down', dir: m.pos.clone().set(0,0,1), source: m.target, pos: m.pos.clone(), heavy: true }, s.world); }, who);
const waitFor = async (fn, max) => { const t0 = Date.now(); while (Date.now() - t0 < max) { const v = await fn(); if (v) return v; await sleep(150); } return null; };
const waitPhase = async (ph, max = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < max) { const i = await info(); if (i.phase === ph) return i; await sleep(200); } return await info(); };
let n = 0; const shot = async (name) => page.screenshot({ path: `${OUT}/flow-${String(n++).padStart(2,'0')}-${name}.png` });

await startCpuBattle(page, { fight: false });
console.log('battle', JSON.stringify(await waitPhase('fight')));
await kill(2); await sleep(400); await shot('ko-slowmo');
console.log('after ko', JSON.stringify(await waitPhase('roundEnd')));
await sleep(250); await shot('round-win');
console.log('r2', JSON.stringify(await waitPhase('fight')));
// round 2: time-up path with player ahead
await page.evaluate(() => { const s = window.__vo.app.screen; s.mechs[1].hp -= 300; s.timeLeft = 1.0; });
console.log('timeup', JSON.stringify(await waitPhase('finish')));
await sleep(500); await shot('timeup');
console.log('result', JSON.stringify(await waitPhase('result', 15000)));
await sleep(400); await shot('stage-clear');
await press('Enter'); await sleep(700);
console.log('stage2', JSON.stringify(await info()));
await shot('stage2-intro');
console.log('s2 fight', JSON.stringify(await waitPhase('fight')));
await sleep(400); await shot('stage2-fight');
// lose both rounds
await kill(1); console.log(JSON.stringify(await waitPhase('roundEnd')));
console.log(JSON.stringify(await waitPhase('fight'))); await kill(1);
console.log('lose result', JSON.stringify(await waitPhase('result', 15000)));
await sleep(400); await shot('continue');
await press('Enter'); await sleep(700);
console.log('after continue', JSON.stringify(await info()));
console.log(JSON.stringify(await waitPhase('fight')));
// lose both rounds again: wait for each KO to land before the next one
await kill(1); await waitPhase('roundEnd'); await waitPhase('fight'); await kill(1);
console.log('lose2', JSON.stringify(await waitPhase('result', 15000)));
// let continue timer run out (press Escape repeatedly to skip)
for (let i = 0; i < 12; i++) { await press('Escape'); await sleep(250); }
await sleep(400); await shot('gameover');
await sleep(900);
const end = await waitFor(async () => { const s = await page.evaluate(() => window.__vo.app.screen.constructor.name); return s === 'TitleScreen' ? s : null; }, 15000);
console.log('end', JSON.stringify({ screen: end }));
await shot('back-to-title');
console.log('--- errors ---'); console.log(logs.join('\n') || 'none');
await browser.close();
