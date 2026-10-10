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

// ---- 30% loss on the fast channel, both directions; count what makes it through
await host.evaluate(() => {
  const l = window.__vo.app.screen.net; const c = window.__cnt = { S: 0, Sdrop: 0, evSent: 0, fireSeen: 0, reliableSnaps: 0 };
  const send = l.rt.send.bind(l.rt);
  l.rt.send = (d) => { if (d[0] === 'S') { c.S++; if (Math.random() < 0.3) { c.Sdrop++; return; } } return send(d); };
  const ev = l.ev; l.ev = (m) => { c.evSent += m.e.length; return ev(m); };
  const st = l.st; l.st = (m) => { c.reliableSnaps++; return st(m); };
  const seen = new Set(); const onInput = l.onInput;
  l.onInput = (m) => { if (!seen.has(m[0]) && (m[4] & (32 | 64 | 128))) c.fireSeen++; seen.add(m[0]); return onInput(m); };
});
await guest.evaluate(() => {
  const l = window.__vo.app.screen.net; const c = window.__cnt = { I: 0, Idrop: 0, evGot: 0, fireSent: 0, snapsGot: 0 };
  const send = l.rt.send.bind(l.rt);
  l.rt.send = (d) => { if (d[0] === 'I') { c.I++; if (Math.random() < 0.3) { c.Idrop++; return; } } return send(d); };
  const seen = new Set(); const sendInput = l.sendInput.bind(l);
  l.sendInput = (m) => { if ((m[4] & (32 | 64 | 128)) && !seen.has(m[0])) { seen.add(m[0]); c.fireSent++; } return sendInput(m); };
  const onEvents = l.onEvents; l.onEvents = (m) => { c.evGot += m.e.length; return onEvents(m); };
  const onSnap = l.onSnap; l.onSnap = (m) => { c.snapsGot++; return onSnap(m); };
});
await guest.keyboard.down('KeyW'); await host.keyboard.down('KeyD');
for (let i = 0; i < 10; i++) { await press(guest, i % 2 ? 'KeyL' : 'KeyJ'); await sleep(260); await press(host, 'KeyL'); await sleep(240); }
await guest.keyboard.up('KeyW'); await host.keyboard.up('KeyD');
await sleep(1500);
const ch = await host.evaluate(() => window.__cnt), cg = await guest.evaluate(() => window.__cnt);
console.log(`loss test  snapshots: ${ch.S} sent fast, ${ch.Sdrop} dropped (${Math.round(ch.Sdrop / ch.S * 100)}%), guest got ${cg.snapsGot}; reliable fallback used ${ch.reliableSnaps}x`);
console.log(`           events: host sent ${ch.evSent}, guest received ${cg.evGot}  ${ch.evSent === cg.evGot ? 'OK (none lost)' : 'MISMATCH'}`);
console.log(`           guest fire presses: sent ${cg.fireSent}, host saw ${ch.fireSeen} (${cg.Idrop}/${cg.I} input packets dropped)  ${cg.fireSent === ch.fireSeen ? 'OK (none lost)' : 'MISMATCH'}`);

// ---- connection drop mid-fight: close Trystero's channel on the guest; both sides must hold, re-pair and resume
const before = await host.evaluate(() => window.__vo.app.screen.netClock);
const t0 = Date.now();
await guest.evaluate(() => { for (const c of window.__dcs) if (c.label === 'data' && c.readyState === 'open') c.close(); });
const held = await waitFor(async () => { const h = await linkState(host), g = await linkState(guest); return h.status === 'reconnecting' && g.status === 'reconnecting' ? [h, g] : null; }, 15000);
const overlay = await host.evaluate(() => !!document.querySelector('.overlay.reconnect')) && await guest.evaluate(() => !!document.querySelector('.overlay.reconnect'));
const frozen = await host.evaluate(() => window.__vo.app.screen.netClock);
await sleep(1000);
const stillFrozen = (await host.evaluate(() => window.__vo.app.screen.netClock)) === frozen;
console.log(`drop test  both reconnecting: ${!!held} after ${((Date.now() - t0) / 1000).toFixed(1)} s | overlay on both: ${overlay} | host clock frozen: ${stillFrozen}`);
const back = await waitFor(async () => { const h = await linkState(host), g = await linkState(guest); return h.status === 'connected' && g.status === 'connected' ? [h, g] : null; }, 25000);
console.log(`           resumed: ${!!back} after ${((Date.now() - t0) / 1000).toFixed(1)} s total`);
await sleep(2500);
const after = await host.evaluate(() => ({ clock: window.__vo.app.screen.netClock, phase: window.__vo.app.screen.phase, overlay: !!document.querySelector('.overlay.reconnect') }));
const gs = await guest.evaluate(() => { const s = window.__vo.app.screen; const l = s.net; return { phase: s.phase, overlay: !!document.querySelector('.overlay.reconnect'), snaps: s.snaps.length, delayMs: Math.round((s.snaps.at(-1)?.ht - s.renderT) * 1000), rt: l.rt?.readyState ?? null, rtReady: l.rtReady }; });
console.log(`           after resume host ${JSON.stringify(after)} (clock ${before.toFixed(1)} -> ${after.clock.toFixed(1)}) | guest ${JSON.stringify(gs)}`);
console.log('--- errors ---\n' + (errs.join('\n') || 'none'));
await bh.close(); await bg.close();
