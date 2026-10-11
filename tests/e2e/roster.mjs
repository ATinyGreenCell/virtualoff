// The newer VRs: every model builds, the select screen lists the whole roster, and each weapon of
// KESTREL, KONGO and ARACHNE does its thing — fired from the keyboard at a frozen CPU.
import puppeteer from 'puppeteer-core';
import { CHROME, OUT, url } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox', '--mute-audio'], defaultViewport: { width: 640, height: 360 } });
const page = await browser.newPage();
const logs = [];
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack}`));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warn' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`); });
await page.goto(url(), { waitUntil: 'networkidle0' });

const frames = (n) => page.evaluate((n) => new Promise((done) => { const step = (k) => (k ? requestAnimationFrame(() => step(k - 1)) : done()); step(n); }), n);
const key = async (k) => { await page.keyboard.down(k); await frames(2); await page.keyboard.up(k); await frames(2); };
const waitFor = async (fn, ms, label) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(60); }
  console.log(`timed out: ${label}`);
  return null;
};
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push(ok);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` ${detail}` : ''}`);
};

// ---- the select screen lists every VR, and each one's model builds
await waitFor(() => page.evaluate(() => window.__vo?.app?.screen?.constructor.name === 'TitleScreen'), 20000, 'title');
await page.evaluate(() => window.__vo.flow.select());
await waitFor(() => page.evaluate(() => window.__vo.app.screen.constructor.name === 'SelectScreen'), 5000, 'select');
const roster = await page.evaluate(async () => {
  const s = window.__vo.app.screen;
  const names = [];
  for (let i = 0; i < 5; i++) {
    s.show(i);
    names.push(document.querySelector('.sel-name')?.textContent);
  }
  return { chips: [...document.querySelectorAll('.sel-roster .chip')].map((c) => c.textContent), names };
});
check('select screen lists the roster', JSON.stringify(roster.chips) === '["JEBE","FUJIN","KESTREL","KONGO","ARACHNE"]' && JSON.stringify(roster.names) === JSON.stringify(roster.chips), JSON.stringify(roster));

// ---- one arcade battle per VR, the CPU frozen in front of it
const start = async (id) => {
  await page.evaluate(() => { window.__prev = window.__vo.app.screen; });
  await page.evaluate(async (id) => { const { SPECS } = await import('/src/game/specs.ts'); window.__vo.flow.start(SPECS[id]); }, id);
  await waitFor(() => page.evaluate(() => { const s = window.__vo.app.screen; return s !== window.__prev && s.constructor.name === 'Battle' && s.phase === 'fight'; }), 30000, `${id} fight`);
};
const place = (d) => page.evaluate((d) => {
  const s = window.__vo.app.screen;
  const [a, b] = s.mechs;
  b.controlsEnabled = false;
  s.world.projectiles.clear();
  // a lane clear of blocks on both stages
  a.pos.set(38, 0, 40); a.vel.set(0, 0, 0); a.yaw = Math.PI; a.state = 'ground'; a.action = null; a.invuln = 0; a.snareT = 0;
  b.pos.set(38, 0, 40 - d); b.vel.set(0, 0, 0); b.yaw = 0; b.state = 'ground'; b.action = null; b.hp = b.spec.hp; b.invuln = 0; b.snareT = 0; b.downValue = 0;
  for (const k of ['lw', 'rw', 'cw']) a.gauges[k] = 1;
  a.en = 1;
}, d);
const look = () => page.evaluate(() => {
  const s = window.__vo.app.screen;
  const [a, b] = s.mechs;
  return {
    pose: a.action?.pose ?? null,
    kinds: s.world.projectiles.list.filter((p) => p.owner === a).map((p) => p.kind + (p.stuck ? '*' : '')),
    hp: Math.round(b.spec.hp - b.hp),
    state: b.state,
    snare: +b.snareT.toFixed(2),
  };
});
const count = (kinds, k) => kinds.filter((x) => x.startsWith(k)).length;

const shots = () => page.evaluate(() => window.__vo.app.screen.mechs[0].stats.shots);

// KESTREL: three needles, six darts, a lance that floors; and thrusting costs half the EN
await start('kestrel');
await place(40);
const shots0 = await shots();
await key('KeyL');
// the first needles land before the last one leaves the gun, so count shots fired rather than in flight
const needles = await waitFor(async () => ((await shots()) - shots0 >= 3 ? { kinds: Array(3) } : null), 3000, 'needles');
await place(45);
await key('KeyJ');
const darts = await waitFor(async () => { const v = await look(); return count(v.kinds, 'missile') >= 6 ? v : null; }, 3000, 'darts');
await place(50);
await key('KeyK');
const lance = await waitFor(async () => { const v = await look(); return v.state === 'down' ? v : null; }, 4000, 'lance knockdown');
const en = await page.evaluate(() => ({ airEN: window.__vo.app.screen.mechs[0].spec.airEN }));
// EN spent per second of game time while climbing on thrusters (a standard frame spends 0.3). The
// jump itself rises faster than the climb, so the thrusters only take over about half a second in.
await place(40);
const gameTime = () => page.evaluate(() => window.__vo.app.screen.world.time);
const jumped = await gameTime();
await page.keyboard.down('Space');
await waitFor(async () => (await gameTime()) - jumped > 0.7, 5000, 'climbing');
const t0 = await page.evaluate(() => { const s = window.__vo.app.screen; return { en: s.mechs[0].en, t: s.world.time }; });
await waitFor(async () => (await gameTime()) - t0.t > 0.3, 5000, 'climb window');
const t1 = await page.evaluate(() => { const s = window.__vo.app.screen; return { en: s.mechs[0].en, t: s.world.time, climbing: s.mechs[0].vel.y > 0 }; });
await page.keyboard.up('Space');
const thrustEN = +((t0.en - t1.en) / Math.max(1e-3, t1.t - t0.t)).toFixed(3);
await page.screenshot({ path: `${OUT}/roster-kestrel.png` });
check('KESTREL: needle burst, swarm darts, rail lance', !!needles && !!darts && !!lance && lance.hp >= 100, JSON.stringify({ needles: needles?.kinds.length, darts: darts?.kinds.length, lance }));
check('KESTREL: light thrusters', en.airEN < 1 && thrustEN > 0.1 && thrustEN < 0.22 && t1.climbing, JSON.stringify({ ...en, thrustEN }));

// KONGO: a seven-pellet scatter, the boosting shoulder ram, the rocket fist and the quake slam
await start('kongo');
await place(20);
const kongoShots = await shots();
await key('KeyL');
// pellets fly fast and die young, so count shots fired rather than in flight
const scatter = await waitFor(async () => ((await shots()) - kongoShots >= 7 ? { kinds: Array(7) } : null), 3000, 'scatter');
// boost, then fire with the target 30 ahead (up close the same button throws the uppercut instead;
// how far a few frames of boosting carry depends on the frame rate, so set the range by hand)
await place(60);
await page.keyboard.down('KeyW');
await page.keyboard.down('ShiftLeft');
await frames(3);
await page.evaluate(() => {
  const [a, b] = window.__vo.app.screen.mechs;
  b.pos.set(a.pos.x + Math.sin(a.yaw) * 30, 0, a.pos.z + Math.cos(a.yaw) * 30);
});
await key('KeyL');
const ram = await waitFor(async () => { const v = await look(); return v.pose === 'ram' ? v : null; }, 2000, 'ram');
const rammed = await waitFor(async () => { const v = await look(); return v.state === 'down' ? v : null; }, 3000, 'ram knockdown');
await page.keyboard.up('ShiftLeft');
await page.keyboard.up('KeyW');
await place(40);
await key('KeyJ');
const fist = await waitFor(async () => { const v = await look(); return count(v.kinds, 'fist') ? v : null; }, 3000, 'rocket fist');
const fisted = await waitFor(async () => { const v = await look(); return v.state === 'down' ? v : null; }, 4000, 'fist knockdown');
await place(10);
await key('KeyK');
const slam = await waitFor(async () => { const v = await look(); return v.state === 'down' ? v : null; }, 4000, 'slam knockdown');
// the slam's shockwave stops at a wall: KONGO and its target either side of a pillar (AQUA HARBOR's,
// the stage of KONGO's first arcade opponent), 16 apart, well inside the slam's reach
const walled = await page.evaluate(() => {
  const s = window.__vo.app.screen;
  const [a, b] = s.mechs;
  for (const k of ['lw', 'rw', 'cw']) a.gauges[k] = 1;
  a.pos.set(24, 0, 32); a.vel.set(0, 0, 0); a.yaw = Math.PI; a.state = 'ground'; a.action = null;
  b.pos.set(24, 0, 16); b.vel.set(0, 0, 0); b.yaw = 0; b.state = 'ground'; b.action = null; b.hp = b.spec.hp; b.invuln = 0;
  return s.setup.stage;
});
await key('KeyK');
await waitFor(() => page.evaluate(() => !window.__vo.app.screen.mechs[0].action), 4000, 'slam over');
const behindWall = await look();
await page.screenshot({ path: `${OUT}/roster-kongo.png` });
check('KONGO: the quake slam stops at walls', walled === 'harbor' && behindWall.hp === 0, JSON.stringify({ stage: walled, hp: behindWall.hp }));

// from the air the slam is a dive that lands its blow on the ground — even with JUMP held, which used
// to hold it up so the shockwave went off overhead and missed anyone standing below
await place(10);
await page.evaluate(() => { const a = window.__vo.app.screen.mechs[0]; a.pos.y = 15; a.state = 'air'; a.vel.set(0, 0, 0); });
await page.keyboard.down('Space');
await frames(2);
await key('KeyK');
const airSlam = await waitFor(async () => { const v = await look(); return v.state === 'down' ? v : null; }, 4000, 'air slam lands');
await page.keyboard.up('Space');
const kongoY = await page.evaluate(() => +window.__vo.app.screen.mechs[0].pos.y.toFixed(2));
check('KONGO: an air slam dives and lands its blow', !!airSlam && airSlam.hp > 50 && kongoY < 1, JSON.stringify({ hp: airSlam?.hp, kongoY }));
check('KONGO: scatter gun, shoulder ram, rocket fist, quake slam', !!scatter && !!ram && !!rammed && !!fist && !!fisted && !!slam && slam.hp >= 100, JSON.stringify({ scatter: scatter?.kinds.length, ram: !!ram, rammed: rammed?.hp, fisted: fisted?.hp, slam: slam?.hp }));

// ARACHNE: hunter drones, web mines that dig in, a snare net that pins
await start('arachne');
await place(40);
await key('KeyL');
const drones = await waitFor(async () => { const v = await look(); return count(v.kinds, 'orb') >= 2 ? v : null; }, 3000, 'drones');
await place(60);
await key('KeyJ');
const mines = await waitFor(async () => { const v = await look(); return v.kinds.some((k) => k === 'mine*') ? v : null; }, 4000, 'mines planted');
await place(45);
await key('KeyK');
const net = await waitFor(async () => { const v = await look(); return v.snare > 0 ? v : null; }, 4000, 'snared');
// a snared VR can't walk out of it
const before = await page.evaluate(() => { const b = window.__vo.app.screen.mechs[1]; b.controlsEnabled = true; return [b.pos.x, b.pos.z]; });
await frames(20);
const after = await page.evaluate(() => { const b = window.__vo.app.screen.mechs[1]; b.controlsEnabled = false; return [b.pos.x, b.pos.z, b.snareT]; });
const drift = Math.hypot(after[0] - before[0], after[1] - before[1]);
await page.screenshot({ path: `${OUT}/roster-arachne.png` });
check('ARACHNE: hunter drones, web mines, snare net', !!drones && !!mines && !!net && net.snare > 1 && drift < 1, JSON.stringify({ drones: drones?.kinds.length, mines: mines?.kinds, snare: net?.snare, drift: +drift.toFixed(2) }));

// snared yourself: the HUD says so, and a melee strike swings in place instead of lunging out
await place(9);
await page.evaluate(() => { window.__vo.app.screen.mechs[0].snareT = 2; });
await frames(3);
const hudSnared = await page.evaluate(() => document.querySelector('.status')?.textContent);
const p0 = await page.evaluate(() => { const a = window.__vo.app.screen.mechs[0]; return [a.pos.x, a.pos.z]; });
await key('KeyL');
await waitFor(() => page.evaluate(() => window.__vo.app.screen.mechs[0].action?.kind === 'melee' && window.__vo.app.screen.mechs[0].action.t > 0.3), 3000, 'snared melee');
const p1 = await page.evaluate(() => { const a = window.__vo.app.screen.mechs[0]; return [a.pos.x, a.pos.z]; });
const lunge = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
check('a snared VR is told so and cannot lunge out', hudSnared === 'SNARED' && lunge < 0.5, JSON.stringify({ hud: hudSnared, lunge: +lunge.toFixed(2) }));

// a mine arms a moment after it lands, not while it's still flying: one dropped beside a VR waits
await place(40);
const armed = await page.evaluate(() => new Promise((done) => {
  const s = window.__vo.app.screen;
  const [a, b] = s.mechs;
  s.world.projectiles.spawn(a, { kind: 'mine', pos: b.pos.clone().set(b.pos.x + 3, 3, b.pos.z), vel: b.pos.clone().set(0, -12, 0), radius: 0.9, damage: 80, knock: 'down', gravity: 42, splash: 7.5, life: 10, stick: true, trigger: 6.5, arm: 0.35 });
  const mine = s.world.projectiles.list[s.world.projectiles.list.length - 1];
  let landed = -1;
  const step = () => {
    if (landed < 0 && mine.stuck) landed = s.world.time;
    if (!mine.alive) return done({ waited: landed < 0 ? -1 : +(s.world.time - landed).toFixed(2), hurt: Math.round(b.spec.hp - b.hp) });
    requestAnimationFrame(step);
  };
  step();
}));
check('a mine arms after it lands', armed.waited >= 0.3 && armed.hurt > 0, JSON.stringify(armed));

// a dash pressed just before the net hits doesn't fire once it's on
await place(40);
const buffered = await page.evaluate(() => {
  const a = window.__vo.app.screen.mechs[0];
  a.snareT = 2;
  a.bufDash = 0.25;
  a.qbGap = 0;
  return new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => done({ state: a.state, speed: +Math.hypot(a.vel.x, a.vel.z).toFixed(2) })))));
});
check('a buffered dash does not escape a snare', buffered.state !== 'dash' && buffered.speed < 1, JSON.stringify(buffered));

// a poised frame (the co-op boss) shakes a net off in half the time
await place(45);
await page.evaluate(() => { window.__vo.app.screen.mechs[1].poise = 2; });
await key('KeyK');
const bossNet = await waitFor(async () => { const v = await look(); return v.snare > 0 ? v : null; }, 4000, 'boss snared');
await page.evaluate(() => { window.__vo.app.screen.mechs[1].poise = 1; });
check('the co-op boss shakes nets off sooner', !!bossNet && bossNet.snare <= 1.25, JSON.stringify({ snare: bossNet?.snare }));

// a mine that hits a wall mid-air drops to the ground instead of sticking up there
await place(40);
await page.evaluate(() => {
  const s = window.__vo.app.screen;
  const a = s.mechs[0];
  s.world.projectiles.spawn(a, { kind: 'mine', pos: a.pos.clone().set(38, 8, -88), vel: a.pos.clone().set(0, 0, -80), radius: 0.9, damage: 80, knock: 'down', gravity: 42, splash: 7.5, life: 10, stick: true, trigger: 6.5, arm: 0.45 });
});
const dropped = await waitFor(() => page.evaluate(() => {
  const p = window.__vo.app.screen.world.projectiles.list.find((q) => q.kind === 'mine' && q.stuck);
  return p ? +p.pos.y.toFixed(2) : null;
}), 4000, 'mine settled');
check('a mine that hits a wall drops to the ground', dropped !== null && dropped < 1, JSON.stringify({ y: dropped }));

// once a round is decided nothing can hurt anyone: the winner can't be shot down by stray drones
const decided = await page.evaluate(() => {
  const s = window.__vo.app.screen;
  const [a, b] = s.mechs;
  b.invuln = 0;
  b.state = 'ground';
  b.takeHit({ damage: 99999, knock: 'down', dir: b.pos.clone().set(0, 0, 1), source: a, pos: b.pos.clone(), heavy: true }, s.world);
  return null;
});
await waitFor(() => page.evaluate(() => window.__vo.app.screen.phase === 'finish'), 5000, 'finish');
const afterKo = await page.evaluate(() => {
  const s = window.__vo.app.screen;
  const a = s.mechs[0];
  const hp = a.hp;
  a.invuln = 0;
  const landed = a.takeHit({ damage: 500, knock: 'down', dir: a.pos.clone().set(0, 0, 1), source: s.mechs[1], pos: a.pos.clone(), heavy: true }, s.world);
  return { landed, lost: hp - a.hp };
});
check('nothing lands after the round is decided', decided === null && afterKo.landed === false && afterKo.lost === 0, JSON.stringify(afterKo));

// the CPU sharpens along the arcade ladder to the same edge on the last stage, however many stages
const ramp = await page.evaluate(async () => {
  const { SPECS } = await import('/src/game/specs.ts');
  const f = window.__vo.flow;
  window.__prev = window.__vo.app.screen;
  f.start(SPECS.jebe);
  f.stageNo = f.ladder.length - 1;
  f.battle();
  return f.ladder.length;
});
const tune = await waitFor(() => page.evaluate(() => { const s = window.__vo.app.screen; return s !== window.__prev && s.constructor.name === 'Battle' && s.setup.stageNo > 0 ? { stage: s.setup.stageNo, reaction: +s.ai.tune.reaction.toFixed(4) } : null; }), 8000, 'last stage');
check('the last arcade stage is as sharp as before, not sharper', ramp === 5 && tune?.reaction === +(0.28 * (1 - 0.6 * 0.25)).toFixed(4), JSON.stringify({ stages: ramp, ...tune }));

console.log(checks.every(Boolean) ? 'roster OK' : 'roster FAILED');
console.log('--- errors ---\n' + (logs.join('\n') || 'none'));
await browser.close();
