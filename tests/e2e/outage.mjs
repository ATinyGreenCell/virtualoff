import puppeteer from 'puppeteer-core';
import { CHROME, url, openVersusHost } from './harness.mjs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// a 10 s grace (dev-only switch) keeps the test short; both the resume and the give-up paths still run
const BASE = `${url()}&grace=10`;
const launch = () => puppeteer.launch({ executablePath: CHROME, headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox', '--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
const [bh, bg] = [await launch(), await launch()];
const errs = [];
const mk = async (b, name) => {
  const p = await b.newPage();
  await p.setViewport({ width: 640, height: 360 });
  await p.evaluateOnNewDocument(() => {
    localStorage.setItem('virtualoff.settings.v1', JSON.stringify({ perf: 'low', voice: false }));
    window.__dcs = [];
    const cdc = RTCPeerConnection.prototype.createDataChannel;
    RTCPeerConnection.prototype.createDataChannel = function (...a) { const c = cdc.apply(this, a); window.__dcs.push(c); return c; };
    const RPC = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends RPC { constructor(c) { super(c); this.addEventListener('datachannel', (e) => window.__dcs.push(e.channel)); } };
  });
  p.on('pageerror', (e) => errs.push(`[${name} pageerror] ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(`[${name} console.error] ${m.text().slice(0, 200)}`); });
  return p;
};
const press = async (p, k, hold = 60) => { await p.keyboard.down(k); await sleep(hold); await p.keyboard.up(k); };
const scr = (p) => p.evaluate(() => { const s = window.__vo?.app?.screen; return { screen: s?.constructor?.name, state: s?.state, phase: s?.phase, code: document.querySelector('.vs-code')?.textContent }; });
const waitFor = async (fn, max) => { const t0 = Date.now(); while (Date.now() - t0 < max) { const v = await fn(); if (v) return v; await sleep(100); } return null; };
const host = await mk(bh, 'host');
await host.goto(BASE, { waitUntil: 'networkidle0' });
const code = await openVersusHost(host);
const guest = await mk(bg, 'guest');
await guest.goto(`${BASE}#vs=${code}`, { waitUntil: 'domcontentloaded' });
await waitFor(async () => (await scr(guest)).state === 'pick' && (await scr(host)).state === 'pick', 45000);
await press(guest, 'Enter'); await sleep(200); await press(host, 'Enter');
await waitFor(async () => (await scr(host)).phase === 'fight' && (await scr(guest)).phase === 'fight', 30000);
const linkState = (p) => p.evaluate(() => { const l = window.__vo.app.screen.net; return { status: l.status, rt: l.rt?.readyState ?? null, rtReady: l.rtReady }; });
console.log('channels   host', JSON.stringify(await linkState(host)), '| guest', JSON.stringify(await linkState(guest)));

// ---- outage the peers can't immediately repair: block the guest's signaling (relays) while the link is down
const gcdp = await guest.createCDPSession();
const offline = (on) => gcdp.send('Network.emulateNetworkConditions', { offline: on, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
const clock = () => host.evaluate(() => window.__vo.app.screen.netClock);
const status = async () => [(await linkState(host)).status, (await linkState(guest)).status].join('/');
const cut = () => guest.evaluate(() => { for (const c of window.__dcs) if (c.readyState === 'open') c.close(); });
// 1) a 6 s outage: the match freezes, then picks up where it stopped
await offline(true); await cut();
await waitFor(async () => (await status()) === 'reconnecting/reconnecting', 15000);
const c1 = await clock(); await sleep(2000); const c2 = await clock();
const ov = (await host.evaluate(() => document.querySelector('.overlay.reconnect .rc-left')?.textContent)) + '/' + (await guest.evaluate(() => document.querySelector('.overlay.reconnect .rc-left')?.textContent));
console.log(`outage 6s  status ${await status()} | countdown host/guest ${ov} s | host clock ${c1.toFixed(2)} -> ${c2.toFixed(2)} over 2 s (${c1 === c2 ? 'FROZEN' : 'running!'})`);
await sleep(4000); await offline(false);
const t1 = Date.now();
const back = await waitFor(async () => (await status()) === 'connected/connected', 20000);
await sleep(2000);
const c3 = await clock();
const g = await guest.evaluate(() => { const s = window.__vo.app.screen; return { phase: s.phase, overlay: !!document.querySelector('.overlay.reconnect'), hp: s.mechs.map((m) => Math.round(m.hp)) }; });
console.log(`           back online -> resumed ${back ? 'in ' + ((Date.now() - t1 - 2000) / 1000).toFixed(1) + ' s' : 'NO'} | host clock now ${c3.toFixed(2)} (running) | guest ${JSON.stringify(g)}`);
// 2) an outage past the 20 s grace: the match ends cleanly as CONNECTION LOST on both sides
await offline(true); await cut();
await waitFor(async () => (await status()) === 'reconnecting/reconnecting', 15000);
const t2 = Date.now();
const lost = await waitFor(async () => (await status()) === 'lost/lost', 30000);
const titles = [await host.evaluate(() => document.querySelector('.overlay.result .ov-title')?.textContent), await guest.evaluate(() => document.querySelector('.overlay.result .ov-title')?.textContent)];
console.log(`outage 25s gave up after ${((Date.now() - t2) / 1000).toFixed(1)} s: ${lost ? 'lost/lost' : await status()} | overlays: ${JSON.stringify(titles)}`);
await offline(false);
console.log('--- errors ---\n' + (errs.join('\n') || 'none'));
await bh.close(); await bg.close();
