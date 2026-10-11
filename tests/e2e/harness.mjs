// Shared helpers for the end-to-end tests. Menus are driven by waiting on the game's own state, never
// on fixed sleeps, so tests stay reliable when many run in parallel on a busy machine.
import fs from 'node:fs';
import path from 'node:path';

/** Chrome/Chromium binary (puppeteer-core brings no browser of its own). */
export const CHROME = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';
/** Dev server root; run.mjs starts one and passes it in. */
export const BASE = process.env.E2E_BASE ?? 'http://127.0.0.1:5173/';
/** Screenshots and logs (git-ignored). */
export const OUT = path.join(path.dirname(new URL(import.meta.url).pathname), '.out');
fs.mkdirSync(OUT, { recursive: true });

/**
 * Versus pairs through a handful of public Nostr relays, and one of them being down is normal: pairing
 * goes through the others, but the browser logs every failed connection attempt. Not a game error.
 */
export const relayNoise = (text) => /WebSocket connection to 'wss:\/\/[^']+' failed/.test(text);

/** The game URL with the dev-only test switches: always ?fast, plus ?noaudio unless the test listens. */
export const url = ({ audio = false } = {}) => `${BASE}?fast${audio ? '' : '&noaudio'}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const screen = (page) =>
  page.evaluate(() => {
    const s = window.__vo?.app?.screen;
    return s ? { name: s.constructor.name, started: s.started, phase: s.phase, chosen: s.chosen } : null;
  });
/** Label of the highlighted title-menu item ('' off the title). */
const titleItem = (page) =>
  page.evaluate(() => {
    const s = window.__vo?.app?.screen;
    return s?.constructor?.name === 'TitleScreen' && s.started ? (s.items?.[s.sel]?.label?.() ?? '') : '';
  });
const key = async (page, k) => {
  await page.keyboard.down(k);
  await sleep(50);
  await page.keyboard.up(k);
};
/** Wait (up to `ms`) for `read()` to differ from `prev` — i.e. for the page to act on a key. */
async function settle(read, prev, ms = 2000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if ((await read()) !== prev) return;
    await sleep(60);
  }
}

async function until(fn, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return;
    await sleep(100);
  }
  throw new Error(`harness timed out waiting for ${label}`);
}

/** Open the title menu (PRESS START), from wherever the title is. */
async function openTitleMenu(page) {
  await until(async () => (await screen(page))?.name === 'TitleScreen', 30000, 'title screen');
  await until(async () => {
    const s = await screen(page);
    if (s.name !== 'TitleScreen' || s.started) return true;
    // one press, then wait for it to land: a second Enter would pick the top menu item
    await key(page, 'Enter');
    await settle(async () => (await screen(page))?.started, false, 3000);
    return false;
  }, 30000, 'title menu');
  await sleep(500); // the freshly opened menu ignores input for a moment
}

/** Title → ARCADE → pick (JEBE, or FUJIN) → battle; resolves in the fight phase unless `fight: false`. */
export async function startCpuBattle(page, { fujin = false, fight = true } = {}) {
  if ((await screen(page))?.name === 'TitleScreen') await openTitleMenu(page);
  await until(async () => {
    const s = await screen(page);
    if (s.name === 'SelectScreen' || s.name === 'Battle') return true;
    const item = await titleItem(page);
    if (!item || item.includes('ARCADE')) {
      await key(page, 'Enter');
      await settle(async () => (await screen(page))?.name, s.name);
    } else {
      await key(page, 'ArrowUp');
      await settle(() => titleItem(page), item);
    }
    return false;
  }, 30000, 'select screen');
  if (fujin && (await screen(page)).name === 'SelectScreen') {
    await sleep(300);
    await key(page, 'ArrowRight');
  }
  await until(async () => {
    const s = await screen(page);
    if (s.name === 'Battle') return true;
    if (s.name === 'SelectScreen' && !s.chosen) {
      await sleep(250);
      await key(page, 'Enter');
    }
    await sleep(300);
    return false;
  }, 30000, 'battle');
  if (fight) await until(async () => (await screen(page))?.phase === 'fight', 30000, 'fight phase');
}

/** Title → VERSUS → HOST A MATCH; resolves with the room code. */
export async function openVersusHost(page) {
  await openTitleMenu(page);
  await until(async () => {
    const s = await screen(page);
    if (s.name === 'VersusScreen') return true;
    if (s.name !== 'TitleScreen') {
      // wandered into another menu (e.g. arcade select): back out to the title
      await key(page, 'Escape');
      await settle(async () => (await screen(page))?.name, s.name, 3000);
      if ((await screen(page))?.name === 'TitleScreen') await openTitleMenu(page);
      return false;
    }
    // steer by what's highlighted, and let each key land before the next: a busy page acts late
    const item = await titleItem(page);
    if (item.includes('VERSUS')) {
      await key(page, 'Enter');
      await settle(async () => (await screen(page))?.name, s.name);
    } else {
      await key(page, 'ArrowDown');
      await settle(() => titleItem(page), item);
    }
    return false;
  }, 30000, 'versus lobby');
  let code = null;
  await until(async () => {
    code = await page.evaluate(() => document.querySelector('.vs-code')?.textContent?.trim());
    if (code && /^[A-Z0-9]{4}$/.test(code)) return true;
    const hostBtn = await page.evaluate(() => !!document.querySelector('[data-act="host"]'));
    if (hostBtn) await key(page, 'Enter');
    await sleep(500);
    return false;
  }, 30000, 'room code');
  return code;
}
