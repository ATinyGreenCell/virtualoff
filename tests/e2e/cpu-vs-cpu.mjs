import puppeteer from 'puppeteer-core';
import { CHROME, url, startCpuBattle } from './harness.mjs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = process.argv[2] ?? 'jebe';
const diff = process.argv[3] ?? 'normal';
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true,
  args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--no-sandbox','--mute-audio'], defaultViewport: { width: 640, height: 360 } });
const page = await browser.newPage();
const logs = [];
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack}`));
await page.goto(url(), { waitUntil: 'networkidle0' });
const press = async (k) => { await page.keyboard.down(k); await sleep(60); await page.keyboard.up(k); };
await startCpuBattle(page, { fujin: pick === 'fujin', fight: false });
await sleep(2500);
await page.evaluate(async (diff) => {
  const { AIController } = await import('/src/game/ai.ts');
  const s = window.__vo.app.screen;
  const ai1 = new AIController(diff, 0);
  const orig = s.update.bind(s);
  window.__sim = { events: [], counts: { p1: {}, p2: {} } };
  const count = (who, k) => { const c = window.__sim.counts[who]; c[k] = (c[k] || 0) + 1; };
  let last1 = null, last2 = null, st1 = '', st2 = '';
  s.update = (dt) => {
    for (let i = 0; i < 4; i++) {
      const c = ai1.update(dt, s.mechs[0], s.mechs[1], s.world);
      Object.assign(s.app.input.controls, c);
      if (s.mechs[0].action && s.mechs[0].action !== last1) count('p1', s.mechs[0].action.kind + ':' + s.mechs[0].action.slot + ':' + s.mechs[0].action.variant);
      if (s.mechs[1].action && s.mechs[1].action !== last2) count('p2', s.mechs[1].action.kind + ':' + s.mechs[1].action.slot + ':' + s.mechs[1].action.variant);
      last1 = s.mechs[0].action; last2 = s.mechs[1].action;
      if (s.mechs[0].state !== st1) { if (['down','dash','air','guard','stagger'].includes(s.mechs[0].state)) count('p1', 'state:' + s.mechs[0].state); st1 = s.mechs[0].state; }
      if (s.mechs[1].state !== st2) { if (['down','dash','air','guard','stagger'].includes(s.mechs[1].state)) count('p2', 'state:' + s.mechs[1].state); st2 = s.mechs[1].state; }
      orig(dt);
      if (s.phase === 'result') break;
    }
  };
}, diff);
const t0 = Date.now();
let lastKey = '';
while (Date.now() - t0 < 300000) {
  const i = await page.evaluate(() => { const s = window.__vo.app.screen; return { phase: s.phase, round: s.round, wins: s.wins, hp: [Math.round(s.mechs[0].hp), Math.round(s.mechs[1].hp)], t: Math.round(s.timeLeft), kind: s.finishKind }; });
  const key = `${i.phase}:${i.round}`;
  if (key !== lastKey) { console.log(((Date.now() - t0) / 1000).toFixed(0) + 's', JSON.stringify(i)); lastKey = key; }
  if (i.phase === 'result') break;
  await sleep(500);
}
console.log(JSON.stringify(await page.evaluate(() => window.__sim.counts), null, 0));
console.log(logs.join('\n') || 'no errors');
await browser.close();
