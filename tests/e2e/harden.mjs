import puppeteer from 'puppeteer-core';
import { CHROME, OUT, url, startCpuBattle } from './harness.mjs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--no-sandbox','--mute-audio'], defaultViewport: { width: 960, height: 540 } });
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(`[pageerror] ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errs.push(`[console.error] ${m.text().slice(0, 200)}`); });
await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
await page.evaluateOnNewDocument(() => localStorage.setItem('virtualoff.settings.v1', JSON.stringify({ perf: 'high', voice: false })));
await page.goto(url(), { waitUntil: 'networkidle0' });
const press = async (k) => { await page.keyboard.down(k); await sleep(60); await page.keyboard.up(k); };
const st = () => page.evaluate(() => { const s = window.__vo.app.screen; return { screen: s?.constructor?.name, phase: s?.phase, paused: s?.paused, lost: window.__vo.app.renderer.lost }; });
const waitFor = async (fn, max = 25000) => { const t0 = Date.now(); while (Date.now() - t0 < max) { if (await fn()) return true; await sleep(150); } return false; };
await startCpuBattle(page, { fight: false });
await waitFor(async () => (await st()).phase === 'fight');
console.log('1 fight', JSON.stringify(await st()));
// --- window blur pauses a live fight
await page.evaluate(() => window.dispatchEvent(new Event('blur')));
await sleep(200);
console.log('2 after blur', JSON.stringify(await st()));
await press('Escape'); await sleep(300);
console.log('3 resumed', JSON.stringify(await st()));
// --- GPU context loss and restore
const lose = await page.evaluate(() => { const gl = window.__vo.app.renderer.gl.getContext(); const ext = gl.getExtension('WEBGL_lose_context'); window.__ext = ext; ext.loseContext(); return !!ext; });
await sleep(400);
console.log('4 context lost', lose, JSON.stringify(await st()), await page.evaluate(() => !document.querySelector('.context-lost').classList.contains('hidden')));
await page.evaluate(() => window.__ext.restoreContext());
await sleep(1500);
console.log('5 restored', JSON.stringify(await st()));
await page.screenshot({ path: `${OUT}/harden-after-restore.png` });
// --- resize storm mid-fight
for (const [w, h] of [[640, 360], [1280, 720], [400, 800], [960, 540]]) { await page.setViewport({ width: w, height: h }); await sleep(250); }
console.log('6 after resizes', JSON.stringify(await st()), await page.evaluate(() => [window.__vo.app.renderer.width, window.__vo.app.renderer.height]));
// --- a screen that keeps throwing gets replaced by the title
await page.evaluate(() => { const s = window.__vo.app.screen; s.update = () => { throw new Error('test explosion'); }; });
await sleep(1500);
console.log('7 after crash loop', JSON.stringify(await st()));
// reduced motion: full-screen flash disabled
console.log('8 reducedMotion', await page.evaluate(async () => (await import('/src/core/settings.ts')).reducedMotion));
console.log('--- errors (expected: test explosion x5 + context lost warning) ---');
console.log(errs.map((e) => e.slice(0, 160)).join('\n') || 'none');
await browser.close();
