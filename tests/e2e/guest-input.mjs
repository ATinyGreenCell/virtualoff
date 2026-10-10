import puppeteer from 'puppeteer-core';
import { CHROME, url, openVersusHost } from './harness.mjs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BASE = url();
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

// ---- the guest's EN gauge follows its own boosting (the guest's mech is simulated on the host)
const enOf = (p) => p.evaluate(() => ({ fill: document.querySelector('.en-fill')?.style.transform, cls: document.querySelector('.en')?.className }));
console.log('guest EN before', JSON.stringify(await enOf(guest)));
await guest.evaluate(() => {
  window.__kd = 0; window.__dp = 0;
  window.addEventListener('keydown', (e) => { if (e.code === 'ShiftLeft') window.__kd++; }, true);
  const inp = window.__vo.app.input; const up = inp.update.bind(inp);
  inp.update = (dt, pad) => { up(dt, pad); if (inp.controls.dashPressed) window.__dp++; };
});
await guest.evaluate(() => { const l = window.__vo.app.screen.net; window.__sent = 0; const si = l.sendInput.bind(l); l.sendInput = (m) => { if (m[4] & 8) window.__sent++; return si(m); }; });
await host.evaluate(() => {
  const s = window.__vo.app.screen; const m = s.mechs[1]; window.__qb = []; window.__got = 0;
  const qb = m.quickBoost.bind(m); m.quickBoost = (c, w, air) => { const before = m.en; qb(c, w, air); window.__qb.push([+before.toFixed(2), +m.en.toFixed(2), m.state, air]); };
  const l = s.net; const oi = l.onInput; l.onInput = (im) => { if (im[4] & 8) window.__got++; return oi(im); };
});
for (let i = 0; i < 3; i++) { await press(guest, 'ShiftLeft', 40); await sleep(650); }
await sleep(300);
const hostView = await host.evaluate(() => +window.__vo.app.screen.mechs[1].en.toFixed(2));
console.log('guest EN after 3 quick boosts', JSON.stringify(await enOf(guest)), '| host sim says', hostView);
console.log('guest keydowns', await guest.evaluate(() => window.__kd), '| guest dashPressed frames', await guest.evaluate(() => window.__dp), '| guest dash edges sent', await guest.evaluate(() => window.__sent), '| host edges received (incl. redundant copies)', await host.evaluate(() => window.__got), '| host quickBoost calls [enBefore, enAfter, state, air]', JSON.stringify(await host.evaluate(() => window.__qb)));
console.log('--- errors ---\n' + (errs.join('\n') || 'none'));
await bh.close(); await bg.close();
