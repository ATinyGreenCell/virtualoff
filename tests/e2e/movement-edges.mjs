// Movement edge cases on the real stage, stepped deterministically (battle loop frozen, 60 Hz steps).
import puppeteer from 'puppeteer-core';
import { CHROME, url, startCpuBattle } from './harness.mjs';

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--mute-audio'], defaultViewport: { width: 640, height: 360 } });
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(url(), { waitUntil: 'networkidle0' });
await startCpuBattle(page);
const res = await page.evaluate(() => {
  const s = window.__vo.app.screen;
  s.update = () => {};
  const w = s.world;
  const m = s.mechs[0];
  const foe = s.mechs[1];
  const DT = 1 / 60;
  const C = () => ({ moveX: 0, moveY: 0, turn: 0, jump: false, jumpPressed: false, dash: false, dashPressed: false, guard: false, fireLW: false, fireRW: false, fireCW: false });
  let prev = { jump: false, dash: false };
  let finite = true;
  let maxY = 0;
  let maxSpeed = 0;
  const step = (ctl = {}, dt = DT) => {
    const c = Object.assign(C(), ctl);
    c.jumpPressed = c.jump && !prev.jump;
    c.dashPressed = c.dash && !prev.dash;
    prev = { jump: c.jump, dash: c.dash };
    foe.update(dt, C(), w);
    m.update(dt, c, w);
    for (const v of [m.pos.x, m.pos.y, m.pos.z, m.vel.x, m.vel.y, m.vel.z, m.en]) if (!Number.isFinite(v)) finite = false;
    maxY = Math.max(maxY, m.pos.y);
    maxSpeed = Math.max(maxSpeed, Math.hypot(m.vel.x, m.vel.z));
  };
  const place = (x, y, z, yaw = 0) => {
    m.reset(m.pos.set(x, y, z).clone(), yaw);
    m.controlsEnabled = true;
    foe.reset(foe.pos.set(-x, 0, -z).clone(), Math.PI);
    foe.controlsEnabled = false;
    prev = { jump: false, dash: false };
  };
  const r = {};

  // 1. climb from the top of the tallest pillar: the ceiling is absolute, not relative to the pillar
  const top = w.arena.boxes.reduce((a, b) => (b.max.y > a.max.y ? b : a));
  place((top.min.x + top.max.x) / 2, top.max.y + 0.5, (top.min.z + top.max.z) / 2);
  maxY = 0;
  for (let i = 0; i < 360; i++) step({ jump: true });
  r.pillarTop = +top.max.y.toFixed(1);
  r.jumpApex = +((m.spec.jumpVel * m.spec.jumpVel) / (2 * m.spec.gravity)).toFixed(1);
  r.climbFromPillarMaxY = +maxY.toFixed(1);

  // 2. quick boost at full tilt into the arena wall: stays inside the bounds
  const lim = w.arena.half - m.spec.radius + 0.01;
  place(0, 0, w.arena.half - 20, 0);
  let outside = false;
  for (let i = 0; i < 120; i++) {
    step({ moveY: 1, dash: i % 12 < 2 });
    if (Math.abs(m.pos.x) > lim || Math.abs(m.pos.z) > lim) outside = true;
  }
  r.wallStaysInside = !outside;

  // 3. knocked down mid-burst: the burst is cancelled (no lingering burst flames)
  place(0, 0, 0, 0);
  step({ moveY: 1, dash: true });
  m.takeHit({ damage: 1, knock: 'down', dir: m.pos.clone().set(0, 0, 1), source: foe, pos: m.pos.clone(), heavy: true }, w);
  step();
  r.downState = m.state;
  r.thrustAfterKnockdown = +m.pose.thrust.toFixed(2);

  // 4. guard out of a boost: switches to guard and skids to a stop
  place(0, 0, 0, 0);
  for (let i = 0; i < 40; i++) step({ moveY: 1, dash: true });
  for (let i = 0; i < 2; i++) step({ moveY: 1, dash: true, guard: true });
  r.guardFromBoost = m.state;
  for (let i = 0; i < 60; i++) step({ guard: true });
  r.guardSpeedAfter1s = +Math.hypot(m.vel.x, m.vel.z).toFixed(2);

  // 5. overheat: climbing and air boosting until EN runs dry locks bursts and boosting out, then recovers
  //    (taps alone stop just short: a quick boost needs its full cost, AC6-style)
  place(0, 0, 0, 0);
  let overheated = false;
  for (let i = 0; i < 400 && !overheated; i++) {
    step({ jump: true, dash: i > 5, moveY: 1 });
    if (m.enEmpty) overheated = true;
  }
  r.overheated = overheated;
  // while locked: a quick-boost press and a held boost do nothing
  step({ dash: false });
  step({ dash: true, moveX: 1 });
  for (let i = 0; i < 5; i++) step({ dash: true, moveX: 1 });
  r.lockedState = m.state;
  r.noBurstWhileLocked = m.state !== 'airdash' && m.pose.thrust < 1.5;
  let recoveredAt = -1;
  for (let i = 0; i < 300; i++) {
    step();
    if (!m.enEmpty) {
      recoveredAt = i;
      break;
    }
  }
  r.recoversInMs = Math.round(((recoveredAt + 7) / 60) * 1000);

  // 6. round reset in mid-air, mid-boost: everything back to a clean start
  place(0, 0, 0, 0);
  for (let i = 0; i < 30; i++) step({ jump: true, dash: i > 10, moveY: 1 });
  m.reset(m.pos.set(0, 0, 0).clone(), 0);
  r.afterReset = { state: m.state, en: m.en, speed: +Math.hypot(m.vel.x, m.vel.z).toFixed(2), empty: m.enEmpty };

  // 7. a frame hitch: 15 fps steps for a second of hard manoeuvring stay stable and bounded
  place(0, 0, 0, 0);
  maxSpeed = 0;
  for (let i = 0; i < 15; i++) step({ moveX: i % 4 < 2 ? 1 : -1, moveY: 1, dash: i % 3 === 0, jump: i % 5 === 0 }, 1 / 15);
  r.hitchMaxSpeed = +maxSpeed.toFixed(1);
  r.qbSpeed = m.spec.qbSpeed;

  // 8. a slow hover glide down to the floor always touches down, wherever its last step ends: from 40
  //    heights a few mm apart, every one lands (it used to hang a hair above the floor in the air state)
  let landed = 0;
  for (let i = 0; i < 40; i++) {
    place(0, 2 + i * 0.0137, 0, 0);
    for (let k = 0; k < 240 && !(m.state === 'dash' && m.pos.y === 0); k++) step({ dash: k > 0 });
    if (m.state === 'dash' && m.pos.y === 0) landed++;
  }
  r.hoverGlidesLanded = landed;
  // and a VR left a hair above the floor with no fall speed comes down at once
  place(0, 0, 0, 0);
  m.state = 'air';
  m.pos.y = 0.005;
  m.vel.y = 0;
  for (let i = 0; i < 5; i++) step();
  r.hairAbove = { state: m.state, y: m.pos.y };
  r.allFinite = finite;
  return r;
});
for (const [k, v] of Object.entries(res)) console.log(`  ${k.padEnd(22)} ${typeof v === 'object' ? JSON.stringify(v) : v}`);
const ok =
  // thrust stops at the ceiling; from a pillar top all you get is a plain jump arc
  res.climbFromPillarMaxY <= res.pillarTop + res.jumpApex + 0.5 &&
  res.wallStaysInside &&
  res.downState === 'down' &&
  res.thrustAfterKnockdown < 0.3 &&
  res.guardFromBoost === 'guard' &&
  res.guardSpeedAfter1s < 1 &&
  res.overheated &&
  res.noBurstWhileLocked &&
  res.recoversInMs >= 1000 &&
  res.recoversInMs < 3000 &&
  res.afterReset.state === 'ground' &&
  res.afterReset.en === 1 &&
  !res.afterReset.empty &&
  // a burst keeps half your sideways momentum, so the ceiling is ~1.12x the burst speed
  res.hitchMaxSpeed <= res.qbSpeed * 1.12 &&
  res.hoverGlidesLanded === 40 &&
  res.hairAbove.state === 'ground' &&
  res.hairAbove.y === 0 &&
  res.allFinite;
console.log(ok ? 'edges OK' : 'edges FAILED');
console.log('--- errors ---');
console.log(errs.join('\n') || 'none');
await browser.close();
