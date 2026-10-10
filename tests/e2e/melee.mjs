import puppeteer from 'puppeteer-core';
import { CHROME, OUT, url, startCpuBattle } from './harness.mjs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true,
  args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--no-sandbox','--mute-audio'], defaultViewport: { width: 640, height: 360 } });
const page = await browser.newPage();
const logs = [];
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack}`));
await page.goto(url(), { waitUntil: 'networkidle0' });
const press = async (k) => { await page.keyboard.down(k); await sleep(60); await page.keyboard.up(k); };
await startCpuBattle(page);
// wait for fight
for (let i = 0; i < 60; i++) { const ph = await page.evaluate(() => window.__vo.app.screen.phase); if (ph === 'fight') break; await sleep(200); }
// freeze the CPU and put it right in front of the player
const setup = () => page.evaluate(() => {
  const s = window.__vo.app.screen;
  s.mechs[1].controlsEnabled = false;
  s.mechs[0].pos.set(38, 0, 32); s.mechs[0].vel.set(0, 0, 0); s.mechs[0].yaw = Math.PI;
  s.mechs[1].pos.set(38, 0, 23); s.mechs[1].vel.set(0, 0, 0); s.mechs[1].yaw = 0; s.mechs[1].invuln = 0; s.mechs[1].state = 'ground'; s.mechs[1].hp = s.mechs[1].spec.hp;
  return { d: s.mechs[0].pos.distanceTo(s.mechs[1].pos), locked: s.mechs[0].lockedOn };
});
console.log('setup', JSON.stringify(await setup()));
await press('KeyL');
const samples = [];
for (let i = 0; i < 10; i++) {
  await sleep(90);
  samples.push(await page.evaluate(() => { const s = window.__vo.app.screen; return { a: s.mechs[0].action?.kind, t: s.mechs[0].action ? +s.mechs[0].action.t.toFixed(2) : null, hp2: s.mechs[1].hp, st2: s.mechs[1].state, d: +s.mechs[0].pos.distanceTo(s.mechs[1].pos).toFixed(1) }; }));
  if (i === 3) await page.screenshot({ path: `${OUT}/melee-slash.png` });
}
console.log(samples.map((x) => JSON.stringify(x)).join('\n'));
await sleep(1500);
// guard test: CPU attacks the guarding player with a rifle shot
console.log('guard', JSON.stringify(await page.evaluate(() => { const s = window.__vo.app.screen; s.mechs[0].pos.set(0,0,40); s.mechs[0].yaw = Math.PI; s.mechs[1].pos.set(0,0,0); s.mechs[1].yaw = 0; s.mechs[1].state='ground'; s.mechs[1].invuln=0; s.mechs[0].invuln=0; s.mechs[0].state='ground'; return s.mechs[0].hp; })));
await page.keyboard.down('KeyC'); await sleep(300);
await page.evaluate(() => { const s = window.__vo.app.screen; s.mechs[1].controlsEnabled = true; s.mechs[1].yaw = 0; const c = { moveX:0, moveY:0, turn:0, jump:false, jumpPressed:false, dash:false, dashPressed:false, guard:false, fireLW:false, fireRW:true, fireCW:false }; s.mechs[1].update(1/60, c, s.world); s.mechs[1].controlsEnabled = false; });
await sleep(1200);
console.log('after guard', JSON.stringify(await page.evaluate(() => { const s = window.__vo.app.screen; return { hp1: s.mechs[0].hp, st1: s.mechs[0].state }; })));
await page.keyboard.up('KeyC');
console.log(logs.join('\n') || 'no errors');
await browser.close();
