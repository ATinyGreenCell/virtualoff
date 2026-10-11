// Split screen on one device. `versus`: two (fake) gamepads join the lobby and fight on their own
// controllers — pause, a controller dropping out and coming back, the keyboard taking over, rematch,
// back to VR select. `coop`: they team up against the boss (no friendly fire, partner cam).
import puppeteer from 'puppeteer-core';
import { CHROME, OUT, url } from './harness.mjs';

const part = process.argv[2] ?? 'versus';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox', '--mute-audio'], defaultViewport: { width: 640, height: 360 } });
const page = await browser.newPage();
const logs = [];
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack}`));
// (the edges part throws one frame on purpose; that error is expected)
page.on('console', (m) => { if ((m.type() === 'error' || m.type() === 'warn' || m.type() === 'warning') && !m.text().includes('planned split-render failure')) logs.push(`[${m.type()}] ${m.text()}`); });
// two standard-mapping pads; __padsOn[i] = false unplugs one
await page.evaluateOnNewDocument(() => {
  const mk = (i) => ({ index: i, id: `Test Pad ${i}`, mapping: 'standard', connected: true, timestamp: 0, buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })), axes: [0, 0, 0, 0] });
  window.__pads = [mk(0), mk(1)];
  window.__padsOn = [true, true];
  navigator.getGamepads = () => [0, 1, 2, 3].map((i) => (window.__padsOn[i] && window.__pads[i]) || null);
});
await page.goto(url(), { waitUntil: 'networkidle0' });

const A = 0, DOWN = 13, RIGHT = 15, RT = 7, START = 9;
// Gamepads are polled once a frame, and a busy page can drop to a few fps — so hold every press (and
// every stick push) for whole frames rather than milliseconds, or the game may never see it.
const frames = (n) => page.evaluate((n) => new Promise((done) => { const step = (k) => (k ? requestAnimationFrame(() => step(k - 1)) : done()); step(n); }), n);
const press = async (i, b) => {
  await page.evaluate((i, b) => { window.__pads[i].buttons[b] = { pressed: true, touched: true, value: 1 }; }, i, b);
  await frames(2);
  await page.evaluate((i, b) => { window.__pads[i].buttons[b] = { pressed: false, touched: false, value: 0 }; }, i, b);
  await frames(2);
};
const stick = (i, x, y) => page.evaluate((i, x, y) => { window.__pads[i].axes[0] = x; window.__pads[i].axes[1] = y; }, i, x, y);
const key = async (k) => { await page.keyboard.down(k); await sleep(60); await page.keyboard.up(k); };
const screen = () => page.evaluate(() => window.__vo.app.screen.constructor.name);
const waitFor = async (fn, ms, label) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(80); }
  console.log(`timed out: ${label}`);
  return null;
};
const phase = () => page.evaluate(() => window.__vo.app.screen.phase);
const waitPhase = (ph, ms = 20000) => waitFor(async () => (await phase()) === ph, ms, `phase ${ph}`);
const pos = () => page.evaluate(() => window.__vo.app.screen.mechs.map((m) => [m.pos.x, m.pos.z]));
const moved = (a, b, i) => Math.hypot(a[i][0] - b[i][0], a[i][1] - b[i][1]);
const kill = (i) => page.evaluate((i) => {
  const s = window.__vo.app.screen;
  const m = s.mechs[i];
  m.invuln = 0;
  if (m.state === 'down' || m.state === 'getup') m.state = 'ground';
  m.takeHit({ damage: 99999, knock: 'down', dir: m.pos.clone().set(0, 0, 1), source: null, pos: m.pos.clone(), heavy: true }, s.world);
}, i);
// face 1P and 2P down a lane that's clear of blocks on both stages (x = 38), 60 apart
const lane = () => page.evaluate(() => {
  const [a, b] = window.__vo.app.screen.mechs;
  a.pos.set(38, 0, 40);
  a.yaw = Math.PI;
  b.pos.set(38, 0, -20);
  b.yaw = 0;
  for (const m of [a, b]) m.vel.set(0, 0, 0);
});
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push(ok);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` ${detail}` : ''}`);
};

const lobby = () => page.evaluate(() => { const s = window.__vo.app.screen; return { state: s.state, mode: s.mode, seats: s.seats?.map((x) => ({ ...x })) }; });

await waitFor(async () => (await screen()) === 'TitleScreen', 20000, 'title');

if (part === 'versus') {
  // ---- title → SPLIT SCREEN, driven by pad 1 alone
  await waitFor(async () => {
    if (await page.evaluate(() => window.__vo.app.screen.started)) return true;
    await press(0, A);
    return false;
  }, 10000, 'title menu');
  await waitFor(async () => {
    const s = await page.evaluate(() => { const s = window.__vo.app.screen; return { name: s.constructor.name, item: s.items?.[s.sel]?.label?.() ?? '' }; });
    if (s.name === 'LocalScreen') return true;
    if (s.name !== 'TitleScreen') return false;
    if (!s.item.includes('SPLIT')) await press(0, DOWN);
    else {
      // one press, then let the title fade out: a second A would land on the lobby
      await press(0, A);
      await waitFor(async () => (await screen()) !== 'TitleScreen', 5000, 'title fade');
    }
    return false;
  }, 15000, 'split-screen lobby');

  // ---- lobby: pad 1 picks VERSUS and is 1P; pad 2 joins as 2P; both ready
  await waitFor(async () => (await lobby()).state === 'mode', 5000, 'mode choice');
  await sleep(300);
  await press(0, A);
  await waitFor(async () => (await lobby()).state === 'pick', 5000, 'pick state');
  await press(1, A);
  const l1 = await lobby();
  check('lobby seats', l1.mode === 'versus' && l1.seats[0].device === 'pad0' && l1.seats[1].device === 'pad1', JSON.stringify(l1));
  await press(0, A);
  await press(1, A);
  await waitFor(async () => (await screen()) === 'Battle', 10000, 'versus battle');
  const split = await page.evaluate(() => {
    const s = window.__vo.app.screen;
    return { mode: s.mode, split: s.split, views: window.__vo.app.renderer.views, huds: document.querySelectorAll('.hud-view .hud.split').length, mechs: s.mechs.map((m) => m.spec.name), devices: s.views.map((v) => v.device) };
  });
  check('split battle', split.mode === 'local' && split.split && split.views === 2 && split.huds === 2, JSON.stringify(split));

  // ---- each controller flies its own VR
  await waitPhase('fight');
  await lane();
  let p0 = await pos();
  await stick(0, 0, -1);
  await frames(30);
  await stick(0, 0, 0);
  let p1 = await pos();
  check('pad 1 moves 1P only', moved(p0, p1, 0) > 3 && moved(p0, p1, 1) < 0.5, `1P ${moved(p0, p1, 0).toFixed(1)} 2P ${moved(p0, p1, 1).toFixed(1)}`);
  await lane();
  p0 = await pos();
  await stick(1, 0, -1);
  await frames(30);
  await stick(1, 0, 0);
  p1 = await pos();
  check('pad 2 moves 2P only', moved(p0, p1, 1) > 3 && moved(p0, p1, 0) < 0.5, `2P ${moved(p0, p1, 1).toFixed(1)} 1P ${moved(p0, p1, 0).toFixed(1)}`);
  const shots0 = await page.evaluate(() => window.__vo.app.screen.mechs.map((m) => m.stats.shots));
  await press(1, RT);
  await frames(20);
  const shots1 = await page.evaluate(() => window.__vo.app.screen.mechs.map((m) => m.stats.shots));
  check('2P trigger fires 2P weapon', shots1[1] > shots0[1] && shots1[0] === shots0[0], JSON.stringify([shots0, shots1]));
  await page.screenshot({ path: `${OUT}/local-versus.png` });

  // ---- pause from 2P's START, resume
  await press(1, START);
  const paused = await waitFor(() => page.evaluate(() => window.__vo.app.screen.paused), 3000, 'pause');
  await press(1, START);
  const resumed = await waitFor(() => page.evaluate(() => !window.__vo.app.screen.paused), 3000, 'resume');
  check('2P pauses and resumes', !!paused && !!resumed);

  // ---- 2P's controller drops out: the match pauses and won't resume until it's back
  await page.evaluate(() => { window.__padsOn[1] = false; });
  const lostNote = await waitFor(() => page.evaluate(() => window.__vo.app.screen.paused && document.querySelector('.pause-note.alert')?.textContent), 3000, 'lost-controller pause');
  await press(0, A);
  const stillPaused = await page.evaluate(() => window.__vo.app.screen.paused);
  // back in its slot it still has to claim the side (the slot could hold the other player's pad)
  await page.evaluate(() => { window.__padsOn[1] = true; });
  await frames(3);
  const stillLost = await page.evaluate(() => !!document.querySelector('.pause-note.alert'));
  await press(1, START);
  const claimed = await waitFor(() => page.evaluate(() => !document.querySelector('.pause-note.alert') && window.__vo.app.screen.paused), 3000, 'claimed, still paused');
  await press(1, START);
  const back = await waitFor(() => page.evaluate(() => !window.__vo.app.screen.paused), 3000, 'resume after reconnect');
  check('lost controller pauses until it returns', !!lostNote?.includes('2P CONTROLLER LOST') && stillPaused && stillLost && !!claimed && !!back, JSON.stringify(lostNote));

  // ---- ... or another controller (here the keyboard) takes over
  await page.evaluate(() => { window.__padsOn[1] = false; });
  await waitFor(() => page.evaluate(() => window.__vo.app.screen.paused), 3000, 'pause again');
  await key('Enter');
  await waitFor(() => page.evaluate(() => window.__vo.app.screen.views[1].device === 'keys'), 3000, 'keyboard claims 2P');
  await key('Enter');
  const adopted = await waitFor(() => page.evaluate(() => { const s = window.__vo.app.screen; return !s.paused && s.views[1].device === 'keys' ? s.views[1].device : null; }), 3000, 'keyboard takes over');
  await page.evaluate(() => { window.__padsOn[1] = true; });
  await lane();
  p0 = await pos();
  await page.keyboard.down('KeyW');
  await frames(30);
  await page.keyboard.up('KeyW');
  p1 = await pos();
  check('keyboard takes over 2P', adopted === 'keys' && moved(p0, p1, 1) > 3, `2P moved ${moved(p0, p1, 1).toFixed(1)}`);

  // ---- 1P wins two rounds → result → REMATCH
  await kill(1);
  await waitPhase('roundEnd');
  await waitPhase('fight');
  await kill(1);
  await waitPhase('result');
  await waitFor(() => page.evaluate(() => window.__vo.app.screen.resultT > 1), 10000, 'result menu live');
  const result = await page.evaluate(() => document.querySelector('.overlay.result .ov-title')?.textContent);
  await page.evaluate(() => { window.__oldBattle = window.__vo.app.screen; });
  await press(0, A);
  const rematch = await waitFor(() => page.evaluate(() => { const s = window.__vo.app.screen; return s.constructor.name === 'Battle' && s !== window.__oldBattle ? s.views.map((v) => v.device) : null; }), 8000, 'rematch');
  check('result and rematch', result === '1P WINS!!' && JSON.stringify(rematch) === '["pad0","keys"]', `${result} ${JSON.stringify(rematch)}`);

  // ---- 2P wins the rematch → VR SELECT keeps sides and picks
  await waitPhase('fight');
  await kill(0);
  await waitPhase('roundEnd');
  await waitPhase('fight');
  await kill(0);
  await waitPhase('result');
  await waitFor(() => page.evaluate(() => window.__vo.app.screen.resultT > 1), 10000, 'result menu live');
  const result2 = await page.evaluate(() => document.querySelector('.overlay.result .ov-title')?.textContent);
  await press(0, DOWN);
  await press(0, A);
  await waitFor(async () => (await screen()) === 'LocalScreen', 8000, 'back to lobby');
  const l2 = await lobby();
  check('VR select keeps the sides', result2 === '2P WINS!!' && l2.state === 'pick' && l2.seats[0].device === 'pad0' && l2.seats[1].device === 'keys' && !l2.seats[0].ready, `${result2} ${JSON.stringify(l2)}`);
}

if (part === 'coop') {
  // ---- co-op: pad 1 picks CO-OP, pad 2 joins and switches to JEBE (a mirror pick)
  await page.evaluate(() => window.__vo.flow.local());
  await waitFor(async () => (await lobby()).state === 'mode', 5000, 'fresh lobby');
  await sleep(200);
  await press(0, DOWN);
  await press(0, A);
  await waitFor(async () => (await lobby()).mode === 'coop', 5000, 'co-op picked');
  await press(1, A);
  await press(1, RIGHT);
  await press(0, A);
  await press(1, A);
  await waitFor(async () => (await screen()) === 'Battle', 10000, 'co-op battle');
  const coop = await page.evaluate(() => {
    const s = window.__vo.app.screen;
    const [a, b, boss] = s.mechs;
    return { mode: s.mode, mechs: s.mechs.map((m) => m.spec.name), teams: s.mechs.map((m) => m.team), targets: [a.target === boss, b.target === boss], bossHp: boss.spec.hp, power: boss.power, mirror: a.palette !== b.palette };
  });
  check('co-op 2-on-1', coop.mode === 'coop' && coop.mechs.length === 3 && JSON.stringify(coop.teams) === '[0,0,1]' && coop.targets.every(Boolean) && coop.power > 1 && coop.mirror, JSON.stringify(coop));

  // ---- no friendly fire: a 1P shot flies through 2P and hits the boss
  await waitPhase('fight');
  const ff = await page.evaluate(async () => {
    const s = window.__vo.app.screen;
    const [a, b, boss] = s.mechs;
    for (const m of s.mechs) m.controlsEnabled = false;
    // a lane clear of blocks on both stages
    b.pos.set(38, 0, 0);
    boss.pos.set(38, 0, -30);
    for (const m of [b, boss]) { m.vel.set(0, 0, 0); m.invuln = 0; m.state = 'ground'; }
    const hp = [b.hp, boss.hp];
    s.world.projectiles.spawn(a, { kind: 'bolt', pos: b.pos.clone().set(38, 4, 25), vel: b.pos.clone().set(0, 0, -160), radius: 0.8, damage: 60, knock: 'stagger', life: 2 });
    // ~0.35 s of flight: wait it out in frames (each advances the fight at most 0.1 s)
    await new Promise((done) => { const step = (k) => (k ? requestAnimationFrame(() => step(k - 1)) : done()); step(40); });
    return { partner: [hp[0], b.hp], boss: [hp[1], boss.hp] };
  });
  check('no friendly fire', ff.partner[0] === ff.partner[1] && ff.boss[1] < ff.boss[0], JSON.stringify(ff));
  await page.evaluate(() => { for (const m of window.__vo.app.screen.mechs) m.controlsEnabled = true; });
  await page.screenshot({ path: `${OUT}/local-coop.png` });

  // ---- 2P goes down: the round goes on, and 2P's camera rides with 1P
  await kill(1);
  const cam = await waitFor(() => page.evaluate(() => { const s = window.__vo.app.screen; return s.views[1].follow === s.mechs[0] ? document.querySelectorAll('.hud-view .status')[1]?.textContent : null; }), 20000, 'partner cam');
  check('partner cam', cam === 'PARTNER CAM' && (await phase()) === 'fight', JSON.stringify(cam));
  await page.screenshot({ path: `${OUT}/local-coop-partner.png` });

  // ---- both down: the boss takes the round
  await kill(0);
  await waitPhase('roundEnd');
  const rw = await page.evaluate(() => window.__vo.app.screen.roundWinner);
  check('boss wins when both players are down', rw === 1, `roundWinner ${rw}`);
}

if (part === 'edges') {
  // a lobby pick for pads 1 and 2 as they are now (their current connection generations)
  const pick = (mode) => page.evaluate((mode) => {
    const gen = (id) => window.__vo.app.input.device(id).generation;
    const p = { mode, devices: ['pad0', 'pad1'], gens: [gen('pad0'), gen('pad1')], mechs: ['jebe', 'fujin'] };
    if (mode === 'coop') window.__vo.flow.coopStart(p);
    else window.__vo.flow.localVersus(p);
  }, mode);
  const startVs = () => pick('versus');
  const startCoop = () => pick('coop');
  const isBattle = () => page.evaluate(() => window.__vo.app.screen.constructor.name === 'Battle');
  const battle = () => page.evaluate(() => { const s = window.__vo.app.screen; return { round: s.round, wins: [...s.wins], winner: s.roundWinner, stageNo: s.setup?.stageNo, hp: s.mechs?.map((m) => Math.round(m.hp)) }; });
  const resultTitle = () => page.evaluate(() => document.querySelector('.overlay.result .ov-title')?.textContent ?? null);
  const resultLive = () => waitFor(() => page.evaluate(() => window.__vo.app.screen.resultT > 1.2), 10000, 'result menu live');
  // mark the current screen, do something that starts a battle, then wait for that new battle
  const mark = () => page.evaluate(() => { window.__prev = window.__vo.app.screen; });
  const freshBattle = () => waitFor(() => page.evaluate(() => window.__vo.app.screen !== window.__prev && window.__vo.app.screen.constructor.name === 'Battle'), 10000, 'new battle');

  // ---- one-player input: two pads' sticks merge by the strongest, not the sum
  await page.evaluate(() => { window.__pads[0].axes[1] = -0.6; window.__pads[1].axes[1] = 0; });
  await frames(3);
  const one = await page.evaluate(() => window.__vo.app.input.controls.moveY);
  await page.evaluate(() => { window.__pads[1].axes[1] = -0.6; });
  await frames(3);
  const two = await page.evaluate(() => window.__vo.app.input.controls.moveY);
  await page.evaluate(() => { window.__pads[1].axes[1] = -0.3; });
  await frames(3);
  const mixed = await page.evaluate(() => window.__vo.app.input.controls.moveY);
  await page.evaluate(() => { window.__pads[0].axes[1] = 0; window.__pads[1].axes[1] = 0; });
  check('pad sticks merge by the strongest', one > 0.3 && one < 0.7 && Math.abs(two - one) < 1e-6 && Math.abs(mixed - one) < 1e-6, `${one} ${two} ${mixed}`);

  // ---- a pad exposed twice (both slots press together) can't take both sides of the lobby
  const twin = async (b) => {
    await page.evaluate((b) => { for (const p of window.__pads) p.buttons[b] = { pressed: true, touched: true, value: 1 }; }, b);
    await frames(2);
    await page.evaluate((b) => { for (const p of window.__pads) p.buttons[b] = { pressed: false, touched: false, value: 0 }; }, b);
    await frames(2);
  };
  await page.evaluate(() => window.__vo.flow.local());
  await waitFor(async () => (await lobby()).state === 'mode', 5000, 'lobby (twin)');
  await sleep(200);
  await twin(A); // picks VERSUS: one of the twins becomes 1P
  await waitFor(async () => (await lobby()).state === 'pick', 5000, 'pick (twin)');
  const t1 = (await lobby()).seats.map((x) => x.device);
  await twin(A); // 1P readies; the twin must not join
  await twin(A); // 1P un-readies; still no join
  const t2 = await lobby();
  check('a twinned pad holds one side', t1.filter(Boolean).length === 1 && t2.seats.filter((x) => x.device).length === 1, JSON.stringify([t1, t2.seats]));

  // ---- one press of A on two pads in the same frame takes one side, not both
  await page.evaluate(() => window.__vo.flow.local());
  await waitFor(async () => (await lobby()).state === 'mode', 5000, 'lobby');
  await sleep(200);
  await press(0, A);
  await waitFor(async () => (await lobby()).state === 'pick', 5000, 'pick');
  await press(0, 1); // B: 1P leaves its side again, back to the mode choice
  await waitFor(async () => (await lobby()).state === 'mode', 5000, 'back to mode');
  await page.evaluate(() => window.__vo.flow.local());
  await sleep(300);
  // mode choice by mouse (no controller becomes 1P), then both pads press A together
  await page.evaluate(() => document.querySelector('[data-act="versus"]').click());
  await waitFor(async () => (await lobby()).state === 'pick', 5000, 'pick by click');
  await page.evaluate(() => { for (const p of window.__pads) p.buttons[0] = { pressed: true, touched: true, value: 1 }; });
  await frames(3);
  await page.evaluate(() => { for (const p of window.__pads) p.buttons[0] = { pressed: false, touched: false, value: 0 }; });
  await frames(3);
  const sameFrame = (await lobby()).seats.filter((x) => x.device).length;
  await press(1, A);
  const after = (await lobby()).seats.map((x) => x.device);
  check('one press, one side', sameFrame === 1 && after.includes('pad0') && after.includes('pad1'), `${sameFrame} ${JSON.stringify(after)}`);

  // ---- split versus: a double KO is a drawn round
  await startVs();
  await waitFor(isBattle, 10000, 'versus');
  await waitPhase('fight');
  await page.evaluate(() => {
    const s = window.__vo.app.screen;
    for (const m of s.mechs) { m.invuln = 0; m.takeHit({ damage: 99999, knock: 'down', dir: m.pos.clone().set(0, 0, 1), source: null, pos: m.pos.clone(), heavy: true }, s.world); }
  });
  await waitPhase('roundEnd');
  const draw = await battle();
  await waitPhase('fight');
  const r2 = await battle();
  check('double KO draws the round', draw.winner === 2 && JSON.stringify(draw.wins) === '[0,0]' && r2.round === 2 && r2.hp.every((h) => h > 0), JSON.stringify([draw, r2]));

  // ---- resize mid-fight: both views and HUDs follow
  await page.setViewport({ width: 800, height: 600 });
  await frames(5);
  const fit = await page.evaluate(() => {
    const s = window.__vo.app.screen;
    const r = window.__vo.app.renderer;
    return { views: r.views, even: r.height % 2 === 0, aspect: s.views.map((v) => +v.cam.cam.aspect.toFixed(2)), want: +r.viewAspect(2).toFixed(2), hudH: s.views.map((v) => v.hud.viewH), boxH: [...document.querySelectorAll('.hud-view')].map((b) => b.getBoundingClientRect().height) };
  });
  await page.setViewport({ width: 640, height: 360 });
  check('resize keeps the split', fit.views === 2 && fit.even && fit.aspect.every((a) => a === fit.want) && fit.hudH.every((h) => h === 300) && fit.boxH.every((h) => Math.abs(h - 300) < 1), JSON.stringify(fit));

  // ---- the split draw failing halfway on every frame: the app's crash recovery takes over and the
  // title it falls back to must be drawn full-screen, not into the half the last split frame left set
  await page.evaluate(() => {
    const w = window.__vo.app.screen.world;
    const orig = w.prepareView.bind(w);
    w.prepareView = (i, h) => {
      if (i === 1) throw new Error('planned split-render failure');
      return orig(i, h);
    };
  });
  await waitFor(async () => (await screen()) === 'TitleScreen', 10000, 'crash recovery to the title');
  await frames(3);
  const gl = await page.evaluate(() => {
    const r = window.__vo.app.renderer;
    const c = r.gl.getContext();
    return { scissor: c.isEnabled(c.SCISSOR_TEST), viewport: [...c.getParameter(c.VIEWPORT)], size: [r.width, r.height], views: r.views, divider: getComputedStyle(document.querySelector('.split-divider')).display };
  });
  check('no split state leaks to the title', !gl.scissor && gl.viewport[2] === gl.size[0] && gl.viewport[3] === gl.size[1] && gl.views === 1 && gl.divider === 'none', JSON.stringify(gl));

  // ---- split pause → RETIRE → title
  await startVs();
  await waitFor(isBattle, 10000, 'versus 2');
  await waitPhase('fight');
  await press(0, START);
  await waitFor(() => page.evaluate(() => window.__vo.app.screen.paused), 3000, 'paused');
  await press(0, DOWN);
  await press(0, A);
  const retired = await waitFor(async () => (await screen()) === 'TitleScreen', 5000, 'retire to title');
  check('RETIRE from split pause', !!retired);

  // ---- both pads drop and come back in each other's slot: 1P claims first, so nobody is swapped
  await startVs();
  await waitFor(isBattle, 10000, 'versus 3');
  await waitPhase('fight');
  await press(0, START);
  await waitFor(() => page.evaluate(() => window.__vo.app.screen.paused), 3000, 'paused (both drop)');
  await page.evaluate(() => { window.__padsOn[0] = window.__padsOn[1] = false; });
  // lost while already paused: the note says so straight away
  const noteWhilePaused = await waitFor(() => page.evaluate(() => document.querySelector('.pause-note.alert')?.textContent ?? null), 3000, 'note while paused');
  await page.evaluate(() => { window.__padsOn[0] = window.__padsOn[1] = true; });
  await frames(3);
  // RETIRE highlighted, then 1P's controller (now in slot 2) presses A: that claims 1P and does nothing else
  await press(0, DOWN);
  await press(1, A);
  const after1 = await page.evaluate(() => { const s = window.__vo.app.screen; return { paused: s.paused, finished: s.finished, devices: s.views.map((v) => v.device), note: document.querySelector('.pause-note')?.textContent }; });
  await press(0, A);
  const after2 = await page.evaluate(() => { const s = window.__vo.app.screen; return { paused: s.paused, devices: s.views.map((v) => v.device), note: document.querySelector('.pause-note')?.textContent }; });
  await press(0, START);
  await waitFor(() => page.evaluate(() => !window.__vo.app.screen.paused), 3000, 'resume after both claimed');
  await lane();
  const q0 = await pos();
  await stick(1, 0, -1);
  await frames(30);
  await stick(1, 0, 0);
  const q1 = await pos();
  check('pads that came back swapped are claimed in order', !!noteWhilePaused?.startsWith('1P CONTROLLER LOST') && after1.paused && !after1.finished && after1.devices[0] === 'pad1' && after1.note.startsWith('2P CONTROLLER LOST') && after2.paused && JSON.stringify(after2.devices) === '["pad1","pad0"]' && after2.note === '' && moved(q0, q1, 0) > 3 && moved(q0, q1, 1) < 0.5, JSON.stringify({ noteWhilePaused, after1, after2, moved: [moved(q0, q1, 0), moved(q0, q1, 1)] }));
  await page.evaluate(() => window.__vo.flow.title());
  await waitFor(async () => (await screen()) === 'TitleScreen', 5000, 'title again');

  // ---- co-op: 2P down, 1P finishes the boss → the team takes the round; 2P is back next round
  await startCoop();
  await waitFor(isBattle, 10000, 'co-op');
  await waitPhase('fight');
  await kill(1);
  await sleep(300);
  await kill(2);
  await waitPhase('roundEnd');
  const solo = await battle();
  await waitPhase('fight');
  const back = await page.evaluate(() => { const s = window.__vo.app.screen; const m = s.mechs[1]; return { alive: m.alive, visible: m.model.root.visible, hp: m.hp, follow: s.views[1].follow === m }; });
  check('one player can win the round for the team', solo.winner === 0 && JSON.stringify(solo.wins) === '[1,0]' && back.alive && back.visible && back.follow, JSON.stringify([solo, back]));

  // ---- co-op time-up: the team's average armor against the boss's
  const timeUp = async (team, boss) => {
    await page.evaluate(({ team, boss }) => {
      const s = window.__vo.app.screen;
      s.mechs[0].hp = s.mechs[0].spec.hp * team[0];
      s.mechs[1].hp = s.mechs[1].spec.hp * team[1];
      s.mechs[2].hp = s.mechs[2].spec.hp * boss;
      for (const m of s.mechs) m.controlsEnabled = false;
      s.timeLeft = 0.05;
    }, { team, boss });
    await waitPhase('roundEnd');
    return (await battle()).winner;
  };
  // (the team leads 1-0: the boss takes round 2 on time, the team round 3 and the match)
  const tu1 = await timeUp([0.9, 0.0], 0.5); // team 0.45 vs 0.5
  await waitPhase('fight');
  const tu2 = await timeUp([0.9, 0.3], 0.5); // team 0.6 vs 0.5
  await waitPhase('result');
  await resultLive();
  const clear = await resultTitle();
  check('co-op time-up compares average armor', tu1 === 1 && tu2 === 0 && clear === 'STAGE CLEAR', `${tu1} ${tu2} ${clear}`);

  // ---- lose a co-op match → CONTINUE → clear both stages → the two-pilot ending
  await mark();
  await startCoop();
  await freshBattle();
  for (let r = 0; r < 2; r++) {
    await waitPhase('fight');
    await kill(0);
    await kill(1);
    await waitPhase(r === 0 ? 'roundEnd' : 'result');
  }
  await resultLive();
  const cont = await resultTitle();
  await mark();
  await press(1, A);
  await freshBattle();
  const again = await battle();
  for (let stage = 0; stage < 2; stage++) {
    for (let r = 0; r < 2; r++) {
      await waitPhase('fight');
      await kill(2);
      await waitPhase(r === 0 ? 'roundEnd' : 'result');
    }
    await resultLive();
    const t = await resultTitle();
    console.log(`stage ${stage + 1} result: ${t}`);
    await mark();
    await press(0, A);
    if (stage === 0) await freshBattle();
  }
  const ending = await waitFor(() => page.evaluate(() => { const s = window.__vo.app.screen; return s.constructor.name === 'EndingScreen' ? { models: s.models.length, sub: document.querySelector('.end-sub')?.textContent } : null; }), 8000, 'ending');
  check('continue, stage clear, two-pilot ending', cont === 'CONTINUE?' && again.stageNo === 0 && JSON.stringify(again.wins) === '[0,0]' && ending?.models === 2 && !!ending?.sub.includes('PILOTS'), JSON.stringify({ cont, again, ending }));
}

console.log(checks.every(Boolean) ? 'local OK' : 'local FAILED');
console.log('--- errors ---\n' + (logs.join('\n') || 'none'));
await browser.close();
