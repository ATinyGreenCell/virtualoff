// Deterministic movement probe: freeze the battle loop, step the real Mech code at 60 Hz with scripted controls.
import puppeteer from 'puppeteer-core';
import { CHROME, url, startCpuBattle } from './harness.mjs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--mute-audio'], defaultViewport: { width: 640, height: 360 } });
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(url(), { waitUntil: 'networkidle0' });
const press = async (k) => { await page.keyboard.down(k); await sleep(50); await page.keyboard.up(k); };
await startCpuBattle(page);
const res = await page.evaluate(() => {
  const s = window.__vo.app.screen;
  s.update = () => {}; // freeze the live loop; we step by hand
  const w = s.world;
  // flat, open test floor: measure the movement model, not the stage's blocks
  w.arena.resolve = () => false;
  w.arena.groundAt = () => 0;
  const DT = 1 / 60;
  const out = {};
  const C = () => ({ moveX: 0, moveY: 0, turn: 0, jump: false, jumpPressed: false, dash: false, dashPressed: false, guard: false, fireLW: false, fireRW: false, fireCW: false });
  for (const idx of [0, 1]) {
    const m = s.mechs[idx];
    const foe = s.mechs[1 - idx];
    const name = m.spec.name;
    const reset = (x = 0, z = -300) => {
      // target far ahead (+z) so auto-facing stays put; open floor
      foe.reset(foe.pos.set(x, 0, 900).clone(), Math.PI);
      foe.controlsEnabled = false;
      m.reset(m.pos.set(x, 0, z).clone(), 0);
      m.controlsEnabled = true;
    };
    const run = (frames, ctlFn) => {
      const rows = [];
      let prev = { jump: false, dash: false };
      for (let i = 0; i < frames; i++) {
        const c = C();
        Object.assign(c, ctlFn(i, m) || {});
        c.jumpPressed = c.jump && !prev.jump;
        c.dashPressed = c.dash && !prev.dash;
        prev = { jump: c.jump, dash: c.dash };
        foe.update(DT, C(), w);
        m.update(DT, c, w);
        rows.push({ i, hs: Math.hypot(m.vel.x, m.vel.z), vy: m.vel.y, y: m.pos.y, x: m.pos.x, z: m.pos.z, st: m.state, en: m.en, out: m.enEmpty, head: Math.atan2(m.vel.x, m.vel.z) });
      }
      return rows;
    };
    const r = {};
    // 1. quick boost from standstill (one-frame tap, forward)
    reset();
    let rows = run(90, (i) => ({ moveY: 1, dash: i === 0 }));
    const peak = Math.max(...rows.map((x) => x.hs));
    r.qbPeak = peak;
    r.qbBelowBoostMs = Math.round((rows.findIndex((x, i) => i > 5 && x.hs <= m.spec.boostSpeed) / 60) * 1000);
    r.qbBackToWalkMs = Math.round((rows.findIndex((x, i) => i > 5 && x.hs <= m.spec.walkSpeed + 0.5) / 60) * 1000);
    r.qbDistance1s = Math.hypot(rows[59].x - rows[0].x, rows[59].z - rows[0].z);
    r.qbEN = rows[2].en;
    // 2. hold boost 1.5 s, then let go (keep pushing forward) — how far the momentum carries
    reset();
    rows = run(180, (i) => ({ moveY: 1, dash: i < 90 }));
    r.boostSteady = rows[85].hs;
    const rel = rows.slice(90);
    r.releaseToWalkMs = Math.round((rel.findIndex((x) => x.hs <= m.spec.walkSpeed + 0.5) / 60) * 1000);
    // 2b. let go of everything at boost speed: coast to a stop
    reset();
    rows = run(180, (i) => (i < 90 ? { moveY: 1, dash: true } : {}));
    const coast = rows.slice(90);
    const stopI = coast.findIndex((x) => x.hs < 0.5);
    r.coastStopMs = Math.round((stopI / 60) * 1000);
    r.coastDist = Math.hypot(coast[Math.max(0, stopI)].x - coast[0].x, coast[Math.max(0, stopI)].z - coast[0].z);
    // 3. carving: full boost forward, then stick hard right — time to swing the line 90°
    reset(0, -300);
    rows = run(200, (i) => (i < 80 ? { moveY: 1, dash: true } : { moveX: 1, dash: true }));
    const h0 = rows[79].head;
    const turned = rows.slice(80).findIndex((x) => Math.abs(((x.head - h0 + Math.PI * 3) % (Math.PI * 2)) - Math.PI) >= Math.PI / 2 - 0.02);
    r.carve90Ms = Math.round((turned / 60) * 1000);
    r.carveSpeedKept = rows[80 + Math.max(0, turned)].hs;
    // 4. boost-jump: boost to full speed, tap jump (let go of dash) — momentum through the air and the landing
    reset();
    rows = run(240, (i) => ({ moveY: 1, dash: i < 70, jump: i === 70 }));
    const air = rows.slice(71);
    const landI = air.findIndex((x, k) => k > 3 && x.st !== 'air' && x.st !== 'airdash');
    r.jumpTakeoffSpeed = rows[70].hs;
    r.jumpApex = Math.max(...air.map((x) => x.y));
    r.jumpLandSpeed = landI > 0 ? air[landI].hs : null;
    r.jumpLandState = landI > 0 ? air[landI].st : null;
    r.jumpDistance = landI > 0 ? Math.hypot(air[landI].x - rows[70].x, air[landI].z - rows[70].z) : null;
    // 5. thrust: jump and keep holding JUMP until EN runs dry
    reset();
    rows = run(420, () => ({ jump: true }));
    r.climbMaxY = Math.max(...rows.map((x) => x.y));
    const dryI = rows.findIndex((x) => x.out);
    r.climbSecsToDry = dryI > 0 ? +(dryI / 60).toFixed(2) : null;
    reset();
    rows = run(360, (i) => ({ jump: i < 150 }));
    r.fallFromY = Math.max(...rows.map((x) => x.y));
    r.fallLanding = rows.some((x) => x.st === 'land') ? 'hard (crouch)' : 'soft';
    reset();
    rows = run(120, (i) => ({ jump: i === 0 }));
    r.plainJumpLanding = rows.some((x) => x.st === 'land') ? 'hard (crouch)' : 'soft';
    // 6. chained quick boosts from full EN (tap every 0.25 s, alternating left/right)
    reset();
    let n = 0, last = 1;
    rows = run(240, (i, mm) => { const tap = i % 15 === 0; if (tap) { const before = mm.en; return { moveX: (i / 15) % 2 ? 1 : -1, dash: true, _b: before }; } return { moveX: (i / 15) % 2 ? 1 : -1 }; });
    for (let i = 1; i < rows.length; i++) { if (rows[i].en < rows[i - 1].en - 0.05) n++; }
    r.qbChainCount = n;
    const outAt = rows.findIndex((x) => x.out);
    r.overheatAfterQBs = outAt >= 0 ? 'yes' : 'no';
    // EN recovery: after overheat, how long until boosting is allowed again and until full
    reset();
    run(120, (i) => ({ dash: i % 9 === 0, moveX: (i % 18) < 9 ? 1 : -1 }));
    const recov = run(400, () => ({}));
    const unlock = recov.findIndex((x) => !x.out);
    const full = recov.findIndex((x) => x.en >= 0.999);
    r.overheatLockMs = Math.round((unlock / 60) * 1000);
    r.refillFullMs = Math.round((full / 60) * 1000);
    // 7. air boost glide: jump, then hold DASH (no burst) — how long and how far it glides
    reset();
    rows = run(420, (i) => ({ moveY: 1, jump: i < 2, dash: i > 20 && i < 400, }));
    const glide = rows.filter((x) => x.st === 'airdash');
    r.airGlideSecs = +(glide.length / 60).toFixed(2);
    r.airGlideSpeed = glide.length ? glide[Math.floor(glide.length / 2)].hs : 0;
    // 8. strafe reversal at walking pace: left full speed, then right — time until moving right at full speed
    reset();
    rows = run(120, (i) => ({ moveX: i < 50 ? -1 : 1 }));
    const hL = rows[49].head;
    const flip = rows.slice(50).findIndex((x) => x.hs >= m.spec.walkSpeed - 0.5 && Math.cos(x.head - hL) < -0.95);
    r.strafeFlipMs = Math.round((flip / 60) * 1000);
    out[name] = r;
  }
  return out;
});
for (const [name, r] of Object.entries(res)) {
  console.log(`== ${name}`);
  for (const [k, v] of Object.entries(r)) console.log(`  ${k.padEnd(18)} ${typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(2)) : v}`);
}
console.log('errors:', errs.length ? errs.join('\n') : 'none');
await browser.close();
