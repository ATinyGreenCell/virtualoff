import puppeteer from 'puppeteer-core';
import { CHROME, OUT, url, openVersusHost } from './harness.mjs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const launch = () => puppeteer.launch({ executablePath: CHROME, headless: true,
  args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--no-sandbox','--mute-audio','--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows'] });
const browsers = [await launch(), await launch()];
let bi = 0;
const browser = { close: async () => { for (const b of browsers) await b.close(); } };
const errs = [];
const mk = async (name) => {
  const p = await browsers[bi++].newPage();
  await p.setViewport({ width: 640, height: 360 });
  await p.evaluateOnNewDocument(() => localStorage.setItem('virtualoff.settings.v1', JSON.stringify({ perf: 'low', voice: false })));
  p.on('pageerror', (e) => errs.push(`[${name} pageerror] ${e.message}\n${(e.stack || '').split('\n').slice(0, 3).join('\n')}`));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(`[${name} console.error] ${m.text().slice(0, 200)}`); });
  return p;
};
const press = async (p, k, hold = 60) => { await p.keyboard.down(k); await sleep(hold); await p.keyboard.up(k); };
const scr = (p) => p.evaluate(() => { const s = window.__vo?.app?.screen; return { screen: s?.constructor?.name, state: s?.state, phase: s?.phase, code: document.querySelector('.vs-code')?.textContent, status: s?.link?.status ?? s?.net?.status, detail: s?.link?.detail ?? s?.net?.detail }; });
const waitFor = async (fn, max, label) => { const t0 = Date.now(); while (Date.now() - t0 < max) { const v = await fn(); if (v) return v; await sleep(250); } console.log('TIMEOUT', label); return null; };

const host = await mk('host');
await host.goto(url(), { waitUntil: 'networkidle0' });
const code = await openVersusHost(host);
console.log('room code', code);
const t0 = Date.now();
const guest = await mk('guest');
await guest.goto(`${url()}#vs=${code}`, { waitUntil: 'networkidle0' });
const ok = await waitFor(async () => (await scr(guest)).state === 'pick' && (await scr(host)).state === 'pick', 45000, 'connect');
console.log('connected in', ((Date.now() - t0) / 1000).toFixed(1), 's', JSON.stringify(await scr(host)), JSON.stringify(await scr(guest)));
if (!ok) { console.log('host', JSON.stringify(await scr(host)), 'guest', JSON.stringify(await scr(guest))); console.log(errs.join('\n')); await browser.close(); process.exit(0); }
await host.screenshot({ path: `${OUT}/vs-lobby-host.png` });
// guest picks FUJIN, both ready
await press(guest, 'ArrowRight'); await sleep(300);
await press(guest, 'Enter'); await sleep(200); await press(host, 'Enter');
await sleep(600);
const lobby = (p) => p.evaluate(() => { const s = window.__vo.app.screen; return { screen: s.constructor.name, state: s.state, my: s.myPick, myReady: s.myReady, rival: s.rivalPick, rivalReady: s.rivalReady, starting: s.starting, leaving: s.leaving, linkRole: s.link?.role, linkStatus: s.link?.status }; });
console.log('host lobby', JSON.stringify(await lobby(host)));
console.log('guest lobby', JSON.stringify(await lobby(guest)));
const fight = await waitFor(async () => (await scr(host)).phase === 'fight' && (await scr(guest)).phase === 'fight', 30000, 'fight');
console.log('both fighting:', !!fight);
await guest.screenshot({ path: `${OUT}/vs-guest-go.png` });
// guest walks forward + strafes and fires; host strafes
await guest.keyboard.down('KeyW'); await guest.keyboard.down('KeyA'); await host.keyboard.down('KeyD');
for (let i = 0; i < 6; i++) { await press(guest, 'KeyL'); await sleep(300); await press(host, 'KeyL'); await sleep(250); }
const sample = async () => {
  const h = await host.evaluate(() => { const s = window.__vo.app.screen; return s.mechs.map((m) => [m.pos.x, m.pos.z, m.hp]); });
  const g = await guest.evaluate(() => { const s = window.__vo.app.screen; return { m: s.mechs.map((m) => [m.pos.x, m.pos.z, m.hp]), snaps: s.snaps.length, jitter: s.jitter, delayMs: Math.round((s.snaps.at(-1)?.ht - s.renderT) * 1000), rtt: s.net.rtt, proj: s.world.projectiles.list.length }; });
  return { h, g };
};
for (let i = 0; i < 3; i++) { console.log(JSON.stringify(await sample())); await sleep(400); }
await guest.screenshot({ path: `${OUT}/vs-guest-fight.png` });
await host.screenshot({ path: `${OUT}/vs-host-fight.png` });
await guest.keyboard.up('KeyW'); await guest.keyboard.up('KeyA'); await host.keyboard.up('KeyD');
// fast-forward: KO the guest on the host and confirm both see the round end
await host.evaluate(() => { const s = window.__vo.app.screen; const m = s.mechs[1]; m.invuln = 0; m.takeHit({ damage: 99999, knock: 'down', dir: m.pos.clone().set(0, 0, 1), source: s.mechs[0], pos: m.pos.clone() }, s.world); });
const re = await waitFor(async () => (await scr(guest)).phase === 'roundEnd', 15000, 'guest roundEnd');
console.log('guest saw round end:', !!re, JSON.stringify(await guest.evaluate(() => ({ ann: document.querySelector('.ann-text')?.textContent, wins: window.__vo.app.screen.wins }))));
await guest.screenshot({ path: `${OUT}/vs-guest-roundend.png` });
// round 2: KO the host's mech this time, then round 3 decides
const ko = (idx) => host.evaluate((idx) => { const s = window.__vo.app.screen; const m = s.mechs[idx]; m.invuln = 0; m.takeHit({ damage: 99999, knock: 'down', dir: m.pos.clone().set(0, 0, 1), source: s.mechs[1 - idx], pos: m.pos.clone() }, s.world); }, idx);
await waitFor(async () => (await scr(host)).phase === 'fight', 20000, 'r2');
await ko(0);
await waitFor(async () => (await scr(host)).phase === 'ready', 20000, 'r3 ready');
await waitFor(async () => (await scr(host)).phase === 'fight', 20000, 'r3');
await ko(1);
const res = await waitFor(async () => (await scr(guest)).phase === 'result' && (await scr(host)).phase === 'result', 20000, 'result');
console.log('match result shown on both:', !!res, JSON.stringify(await host.evaluate(() => document.querySelector('.result .ov-title')?.textContent)), JSON.stringify(await guest.evaluate(() => document.querySelector('.result .ov-title')?.textContent)));
await guest.screenshot({ path: `${OUT}/vs-guest-result.png` });
await sleep(1200);
await press(host, 'Enter'); await sleep(400); await press(guest, 'Enter');
const back = await waitFor(async () => (await scr(host)).state === 'pick' && (await scr(guest)).state === 'pick', 15000, 'rematch lobby');
console.log('both back in lobby for rematch:', !!back);
await sleep(800);
await press(guest, 'Enter'); await sleep(300); await press(host, 'Enter');
const f2 = await waitFor(async () => (await scr(host)).phase === 'fight' && (await scr(guest)).phase === 'fight', 30000, 'fight 2');
console.log('second match started:', !!f2);
// guest leaves mid-fight
await press(guest, 'Escape'); await sleep(300); await press(guest, 'ArrowDown'); await sleep(200); await press(guest, 'Enter');
const left = await waitFor(async () => (await host.evaluate(() => document.querySelector('.result .ov-title')?.textContent || '')).includes('LEFT'), 15000, 'host sees leave');
const tl = Date.now();
const gTitle = await waitFor(async () => (await scr(guest)).screen === 'TitleScreen', 8000, 'guest back at title');
const gLink = await guest.evaluate(() => window.__vo.flow?.link ?? null);
console.log('host notified of leave:', JSON.stringify(left), '| guest reached title:', !!gTitle, gTitle ? `${Date.now() - tl} ms after the host saw it` : JSON.stringify(await scr(guest)));
await host.screenshot({ path: `${OUT}/vs-host-rivalleft.png` });
console.log('--- errors ---'); console.log(errs.join('\n') || 'none');
await browser.close();
