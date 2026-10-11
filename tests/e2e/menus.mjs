// Menu edge cases: the VR select screen on a phone held sideways (fits; only deliberate taps confirm),
// the online lobby with a controller (it can leave the room-code box; B takes back READY before it
// leaves the room) and the split-screen lobby on Xbox (a click — the controller's A in browsing mode —
// never seats the keyboard).
import puppeteer from 'puppeteer-core';
import { CHROME, OUT, url } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox', '--mute-audio'] });
const logs = [];
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push(ok);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` ${detail}` : ''}`);
};
const waitFor = async (fn, ms, label) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(60); }
  console.log(`timed out: ${label}`);
  return null;
};
const open = async (viewport, ua) => {
  const page = await browser.newPage();
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack}`));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warn' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`); });
  if (ua) await page.setUserAgent(ua);
  // one standard-mapping pad
  await page.evaluateOnNewDocument(() => {
    window.__pad = { index: 0, id: 'Test Pad', mapping: 'standard', connected: true, timestamp: 0, buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })), axes: [0, 0, 0, 0] };
    navigator.getGamepads = () => [window.__pad, null, null, null];
  });
  await page.setViewport(viewport);
  await page.goto(url(), { waitUntil: 'networkidle0' });
  await waitFor(() => page.evaluate(() => window.__vo?.app?.screen?.constructor.name === 'TitleScreen'), 20000, 'title');
  return page;
};
const frames = (page, n) => page.evaluate((n) => new Promise((done) => { const step = (k) => (k ? requestAnimationFrame(() => step(k - 1)) : done()); step(n); }), n);
// held for whole frames: gamepads are polled once a frame
const pad = async (page, b) => {
  await page.evaluate((b) => { window.__pad.buttons[b] = { pressed: true, touched: true, value: 1 }; }, b);
  await frames(page, 2);
  await page.evaluate((b) => { window.__pad.buttons[b] = { pressed: false, touched: false, value: 0 }; }, b);
  await frames(page, 2);
};
const A = 0, B = 1;

// ---- VR select on a phone held sideways
{
  const page = await open({ width: 844, height: 390, deviceScaleFactor: 1, isMobile: true, hasTouch: true, isLandscape: true });
  await page.evaluate(() => window.__vo.flow.select());
  // a tap landing as the screen comes up (the tail of a double tap) doesn't pick the first VR
  await waitFor(() => page.evaluate(() => window.__vo.app.screen.constructor.name === 'SelectScreen'), 5000, 'select');
  // (the screen's clock runs on frames: set it rather than race a busy machine)
  await page.evaluate(() => { window.__vo.app.screen.t = 0.1; document.querySelector('.sel-name')?.click(); });
  const early = await page.evaluate(() => window.__vo.app.screen.chosen);
  await page.evaluate(() => { const s = window.__vo.app.screen; s.t = 1; s.show(3); });
  await frames(page, 4);
  // nothing overlaps: the whole panel sits between the title and the chips, on screen
  const geo = await page.evaluate(() => {
    const r = (sel) => document.querySelector(sel).getBoundingClientRect();
    return { titleBottom: Math.round(r('.sel-title').bottom), infoTop: Math.round(r('.sel-info').top), infoBottom: Math.round(r('.sel-info').bottom), chipsTop: Math.round(r('.sel-roster').top), chipsRight: Math.round(r('.sel-roster').right), vw: innerWidth };
  });
  await page.screenshot({ path: `${OUT}/menus-select-phone.png` });
  check('select screen fits a phone held sideways', geo.infoTop >= geo.titleBottom && geo.infoBottom <= geo.chipsTop && geo.chipsRight <= geo.vw, JSON.stringify(geo));
  // taps on the panel (not the name) don't confirm; a tap on another chip picks it; a second tap confirms
  await page.evaluate(() => document.querySelector('.sel-stats')?.click());
  const panelTap = await page.evaluate(() => window.__vo.app.screen.chosen);
  await page.evaluate(() => document.querySelectorAll('.sel-roster .chip')[4].click());
  const picked = await page.evaluate(() => ({ idx: window.__vo.app.screen.idx, chosen: window.__vo.app.screen.chosen }));
  await page.evaluate(() => document.querySelectorAll('.sel-roster .chip')[4].click());
  const confirmed = await page.evaluate(() => window.__vo.app.screen.chosen);
  check('select screen confirms only on purpose', !early && !panelTap && picked.idx === 4 && !picked.chosen && confirmed, JSON.stringify({ early, panelTap, picked, confirmed }));
  await page.close();
}

// ---- online lobby with a controller
{
  const page = await open({ width: 960, height: 540 });
  await page.evaluate(() => window.__vo.flow.versus());
  await waitFor(() => page.evaluate(() => window.__vo.app.screen.constructor.name === 'VersusScreen'), 5000, 'versus lobby');
  await page.evaluate(() => window.__vo.app.screen.act('join'));
  await waitFor(() => page.evaluate(() => document.activeElement?.classList.contains('vs-input')), 3000, 'code box focused');
  // the keyboard types into the box...
  await page.keyboard.type('ab');
  const typed = await page.evaluate(() => ({ value: document.querySelector('.vs-input')?.value, state: window.__vo.app.screen.state }));
  // ...while a controller's B leaves it (it can't type, and used to be stuck there)
  await pad(page, B);
  const left = await waitFor(() => page.evaluate(() => (window.__vo.app.screen.state === 'menu' ? 'menu' : null)), 3000, 'pad leaves the code box');
  check('a controller can leave the room-code box', typed.value === 'AB' && typed.state === 'join' && left === 'menu', JSON.stringify({ typed, left }));
  // the pick panel: B takes back READY first, and only then leaves the room
  await page.evaluate(() => { const s = window.__vo.app.screen; s.go('pick'); s.myReady = true; s.refreshPick(); });
  await frames(page, 2);
  await pad(page, B);
  const unready = await page.evaluate(() => ({ state: window.__vo.app.screen.state, ready: window.__vo.app.screen.myReady }));
  await pad(page, B);
  const gone = await waitFor(() => page.evaluate(() => (window.__vo.app.screen.constructor.name === 'TitleScreen' ? 'title' : null)), 5000, 'left the room');
  check('B in the lobby: un-ready first, then leave', unready.state === 'pick' && unready.ready === false && gone === 'title', JSON.stringify({ unready, gone }));
  await page.close();
}

// ---- split-screen lobby on Xbox
{
  const XBOX_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; Xbox; Xbox Series X) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0';
  const page = await open({ width: 960, height: 540 }, XBOX_UA);
  await page.evaluate(() => window.__vo.flow.local());
  await waitFor(() => page.evaluate(() => window.__vo.app.screen.constructor.name === 'LocalScreen'), 5000, 'split lobby');
  await page.evaluate(() => window.__vo.app.screen.chooseMode('versus', null));
  await frames(page, 2);
  // A in browsing controls arrives as a click on "PRESS A / ENTER TO JOIN"
  const at = await page.evaluate(() => { const r = document.querySelector('.lc-seat.s0 .lc-state').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.click(at.x, at.y);
  await frames(page, 2);
  const afterClick = await page.evaluate(() => ({ seat: window.__vo.app.screen.seats[0].device, nudged: !!document.querySelector('.lc-panel .xbox-hint.nudge') }));
  // with game controls on, the controller's own A takes the side
  await pad(page, A);
  const padSeat = await waitFor(() => page.evaluate(() => window.__vo.app.screen.seats.find((s) => s.device)?.device ?? null), 3000, 'pad joins');
  check('Xbox: a click never seats the keyboard', afterClick.seat === null && afterClick.nudged && padSeat === 'pad0', JSON.stringify({ ...afterClick, padSeat }));
  await page.close();
}

console.log(checks.length && checks.every(Boolean) ? 'menus OK' : 'menus FAILED');
console.log('--- errors ---\n' + (logs.join('\n') || 'none'));
await browser.close();
