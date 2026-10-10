import puppeteer from 'puppeteer-core';
import { CHROME, url, startCpuBattle } from './harness.mjs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true,
  args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--no-sandbox','--mute-audio'], defaultViewport: { width: 640, height: 360 } });
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(`[pageerror] ${e.message}\n${e.stack}`));
await page.goto(url(), { waitUntil: 'networkidle0' });
const press = async (k, hold = 50) => { await page.keyboard.down(k); await sleep(hold); await page.keyboard.up(k); };
await startCpuBattle(page);
await page.evaluate(() => {
  const s = window.__vo.app.screen;
  window.__rec = [];
  const orig = s.update.bind(s);
  s.update = (dt) => {
    orig(dt);
    const m = s.mechs[0];
    window.__rec.push({ t: performance.now(), hs: Math.hypot(m.vel.x, m.vel.z), vy: m.vel.y, y: m.pos.y, st: m.state, act: m.action ? m.action.slot + ':' + m.action.kind : '', at: m.action ? m.action.t : 0, nproj: s.world.projectiles.list.filter((p) => p.owner === m).length, g: { ...m.gauges } });
  };
  window.__reset = () => {
    s.mechs[1].controlsEnabled = false;
    s.mechs[0].reset(s.mechs[0].pos.set(-40, 0, 60).clone(), Math.PI); s.mechs[0].controlsEnabled = true;
    s.mechs[1].reset(s.mechs[1].pos.set(-40, 0, -60).clone(), 0);
    s.timeLeft = 60;
    window.__rec.length = 0;
  };
});
const reset = () => page.evaluate(() => window.__reset());
const mark = () => page.evaluate(() => performance.now());
const rec = (from) => page.evaluate((from) => window.__rec.filter((r) => r.t >= from).map((r) => ({ ...r, t: Math.round(r.t - from) })), from);
const fmt = (rows, keys) => rows.map((r) => keys.map((k) => (typeof r[k] === 'number' ? r[k].toFixed(1) : r[k])).join(' ')).join(' | ');
const every = (rows, n) => rows.filter((_, i) => i % n === 0);

// 1. walking shot
await reset(); await page.keyboard.down('KeyW'); await sleep(700);
let t0 = await mark(); await press('KeyL'); await sleep(600); await page.keyboard.up('KeyW');
let r = await rec(t0);
console.log('WALKING SHOT  t/speed/action:', fmt(every(r, 3), ['t', 'hs', 'act']));
const firstProj = r.find((x) => x.nproj > 0); console.log('  press->bolt latency ms:', firstProj?.t);

// 2. planted CW while walking sideways
await reset(); await page.keyboard.down('KeyD'); await sleep(600);
t0 = await mark(); await press('KeyK'); await sleep(900); await page.keyboard.up('KeyD');
r = await rec(t0);
console.log('PLANTED CW    t/speed/action:', fmt(every(r, 4), ['t', 'hs', 'act']));

// 3. dash end skid
await reset(); await page.keyboard.down('KeyW'); await page.keyboard.down('ShiftLeft'); await sleep(450); 
t0 = await mark(); await page.keyboard.up('ShiftLeft'); await page.keyboard.up('KeyW'); await sleep(700);
r = await rec(t0);
console.log('DASH RELEASE  t/speed/state:', fmt(every(r, 3), ['t', 'hs', 'st']));

// 4. air shot keeps the arc
await reset(); await press('Space'); await sleep(450);
t0 = await mark(); await press('KeyL'); await sleep(800);
r = await rec(t0);
console.log('AIR SHOT      t/vy/y/state:', fmt(every(r, 4), ['t', 'vy', 'y', 'st']));

// 5. CW upgrade: L then J 45ms later
await reset(); await sleep(200);
t0 = await mark(); await press('KeyL', 20); await sleep(25); await press('KeyJ', 20); await sleep(500);
r = await rec(t0);
console.log('UPGRADE       t/action/gauges:', fmt(every(r, 3).slice(0, 8), ['t', 'act']), '| final gauges', JSON.stringify(r[r.length - 1].g));

// 6. buffered dash during a shot
await reset(); await page.keyboard.down('KeyD'); await sleep(400);
t0 = await mark(); await press('KeyL', 20); await sleep(10); await press('ShiftLeft', 220); await sleep(500); await page.keyboard.up('KeyD');
r = await rec(t0);
console.log('BUFFERED DASH t/state/action/speed:', fmt(every(r, 2).slice(0, 14), ['t', 'st', 'act', 'hs']));
console.log(errs.join('\n') || 'no errors');
await browser.close();
