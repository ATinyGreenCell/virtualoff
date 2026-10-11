// Phone controls: real multi-touch on the on-screen stick and buttons (landscape phone emulation).
import puppeteer from 'puppeteer-core';
import { CHROME, url, startCpuBattle } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox', '--mute-audio'] });
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(`[pageerror] ${e.message}`));
await page.setViewport({ width: 844, height: 390, deviceScaleFactor: 1, isMobile: true, hasTouch: true, isLandscape: true });
await page.goto(url(), { waitUntil: 'networkidle0' });
const cdp = await page.createCDPSession();
const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y, id]) => ({ x, y, id, radiusX: 8, radiusY: 8, force: 1 })) });
const center = (sel) => page.evaluate((sel) => { const r = document.querySelector(sel)?.getBoundingClientRect(); return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; }, sel);
const me = () => page.evaluate(() => { const m = window.__vo.app.screen.mechs[0]; return { st: m.state, speed: +Math.hypot(m.vel.x, m.vel.z).toFixed(1), vy: +m.vel.y.toFixed(1), y: +m.pos.y.toFixed(1), en: +m.en.toFixed(2), act: m.action ? m.action.slot : null, paused: window.__vo.app.screen.paused }; });
const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(60); } return null; };

await startCpuBattle(page);
await page.evaluate(() => { const s = window.__vo.app.screen; s.mechs[1].controlsEnabled = false; window.__voTouch.setBattleActive(true); });
// a tap on open ground makes touch the active device and shows the overlay
await touch('touchStart', [[422, 200, 9]]);
await touch('touchEnd', []);
await waitFor(() => page.evaluate(() => document.querySelector('.tc')?.style.display !== 'none'), 5000);
const r = {};
const jx = 140, jy = 300;

// 1. stick forward moves the mech
await touch('touchStart', [[jx, jy, 1]]);
await touch('touchMove', [[jx, jy - 60, 1]]);
r.stickForward = await waitFor(async () => { const s = await me(); return s.speed > 5 ? s : null; }, 4000);

// 2. a BOOST tap shorter than a frame still fires a full quick boost
const boost = await center('.tc-dash');
const en0 = (await me()).en;
await touch('touchStart', [[jx, jy - 60, 1], [boost.x, boost.y, 2]]);
await touch('touchMove', [[jx, jy - 60, 1]]);
await touch('touchEnd', [[jx, jy - 60, 1]]);
const qb = await waitFor(async () => { const s = await me(); return s.en < en0 - 0.1 ? s : null; }, 3000);
r.boostTap = { fired: !!qb, enBefore: en0, enAfter: qb?.en ?? null };

// 3. hold BOOST with the stick right: a sustained boost
await touch('touchMove', [[jx + 60, jy, 1]]);
await sleep(500);
await touch('touchStart', [[jx + 60, jy, 1], [boost.x, boost.y, 3]]);
r.boostHold = await waitFor(async () => { const s = await me(); return s.st === 'dash' && s.speed > 25 ? s : null; }, 3000);
await touch('touchEnd', [[jx + 60, jy, 1]]);

// 4. RW while steering with the other thumb
const rw = await center('.tc-rw');
await sleep(400);
await touch('touchStart', [[jx + 60, jy, 1], [rw.x, rw.y, 4]]);
r.fireWhileMoving = await waitFor(async () => { const s = await me(); return s.act ? s : null; }, 3000);
await touch('touchEnd', [[jx + 60, jy, 1]]);
await touch('touchEnd', []);

// 5. hold JUMP: thrusters climb
await waitFor(async () => (await me()).st === 'ground', 4000);
const jump = await center('.tc-jump');
await touch('touchStart', [[jump.x, jump.y, 5]]);
await sleep(1200);
r.jumpHold = await me();
await touch('touchEnd', []);

// 6. pause and resume
await waitFor(async () => (await me()).st === 'ground', 6000);
const pause = await center('.tc-pause');
await touch('touchStart', [[pause.x, pause.y, 6]]);
await touch('touchEnd', []);
r.paused = !!(await waitFor(async () => (await me()).paused, 3000));
const resume = await waitFor(() => center('.overlay.pause .item'), 3000);
await touch('touchStart', [[resume.x, resume.y, 7]]);
await touch('touchEnd', []);
r.resumed = !!(await waitFor(async () => !(await me()).paused, 3000));

// 7. one thumb for boost + fire: hold BOOST, slide across onto RW and lift there — as KONGO, the shoulder ram
await page.evaluate(async () => { const { SPECS } = await import('/src/game/specs.ts'); window.__prevB = window.__vo.app.screen; window.__vo.flow.start(SPECS.kongo); });
await waitFor(() => page.evaluate(() => { const s = window.__vo.app.screen; return s !== window.__prevB && s.constructor.name === 'Battle' && s.phase === 'fight'; }), 30000);
await page.evaluate(() => { window.__vo.app.screen.mechs[1].controlsEnabled = false; window.__voTouch.setBattleActive(true); });
await waitFor(() => page.evaluate(() => document.querySelector('.tc')?.style.display !== 'none'), 5000);
const boost2 = await center('.tc-dash');
const rw2 = await center('.tc-rw');
await touch('touchStart', [[jx, jy, 1]]);
await touch('touchMove', [[jx, jy - 60, 1]]);
await touch('touchStart', [[jx, jy - 60, 1], [boost2.x, boost2.y, 8]]);
await waitFor(async () => (await me()).st === 'dash', 3000);
// the rival straight ahead, in ramming range
await page.evaluate(() => { const [a, b] = window.__vo.app.screen.mechs; b.pos.set(a.pos.x + Math.sin(a.yaw) * 30, 0, a.pos.z + Math.cos(a.yaw) * 30); b.vel.set(0, 0, 0); });
// (LW sits on the way: sliding over it mustn't launch the rocket fist)
for (let k = 1; k <= 6; k++) await touch('touchMove', [[jx, jy - 60, 1], [boost2.x + ((rw2.x - boost2.x) * k) / 6, boost2.y + ((rw2.y - boost2.y) * k) / 6, 8]]);
await sleep(150);
const crossed = await page.evaluate(() => window.__vo.app.screen.mechs[0].action?.pose ?? null);
// lift the thumb there (CDP's touchEnd lifts every finger; the stick thumb doesn't matter here)
await touch('touchEnd', []);
r.slideRam = crossed ? `${crossed}!` : await waitFor(() => page.evaluate(() => { const a = window.__vo.app.screen.mechs[0].action; return a?.pose === 'ram' ? 'ram' : a?.pose === 'punchL' ? 'fist!' : null; }), 3000);

// 8. portrait: the rotate prompt appears
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true, isLandscape: false });
r.rotatePrompt = !!(await waitFor(() => page.evaluate(() => { const el = document.querySelector('.tc-rotate'); return el && getComputedStyle(el).display !== 'none'; }), 5000));

for (const [k, v] of Object.entries(r)) console.log(`  ${k.padEnd(16)} ${JSON.stringify(v)}`);
const ok = !!r.stickForward && r.boostTap.fired && !!r.boostHold && !!r.fireWhileMoving && r.jumpHold.y > 8 && r.paused && r.resumed && r.slideRam === 'ram' && r.rotatePrompt;
console.log(ok ? 'touch OK' : 'touch FAILED');
console.log('--- errors ---');
console.log(errs.join('\n') || 'none');
await browser.close();
