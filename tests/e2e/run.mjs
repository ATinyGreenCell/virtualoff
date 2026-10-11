// End-to-end suite: npm run test:e2e [-- -j 8] [-- --only versus,flow]
// Starts a Vite dev server, runs the browser tests in parallel (longest first), checks each one's
// pass markers and prints a summary. Needs Chrome (CHROME_PATH overrides /usr/bin/google-chrome);
// the versus tests also need internet access (they pair through public Nostr relays).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(DIR, '../..');
const argv = process.argv.slice(2);
const opt = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const jobs = Number(opt('-j')) || 8;
const only = opt('--only')?.split(',');
const PORT = 5199;

const noErrors = (o) => /--- errors ---\s*\nnone/.test(o);
const TESTS = [
  { name: 'versus', file: 'versus.mjs', est: 65, pass: (o) => /second match started: true/.test(o) && /guest reached title: true/.test(o) && /guest saw the new kit: \{"kinds":\[[^\]]*"mine"[^\]]*"net"[^\]]*"orb"[^\]]*\],"snared":[1-9]/.test(o) && noErrors(o) },
  { name: 'outage', file: 'outage.mjs', est: 60, pass: (o) => /\(FROZEN\)/.test(o) && /lost\/lost/.test(o) && noErrors(o) },
  { name: 'net-loss', file: 'net-loss.mjs', est: 45, pass: (o) => (o.match(/OK \(none lost\)/g) || []).length === 2 && /resumed: true/.test(o) && noErrors(o) },
  { name: 'cpu-vs-cpu', file: 'cpu-vs-cpu.mjs', args: ['jebe', 'hard'], est: 45, pass: (o) => /"phase":"result"/.test(o) && /no errors/.test(o) },
  { name: 'guest-input', file: 'guest-input.mjs', est: 40, pass: (o) => /dashPressed frames 3 \| guest dash edges sent 3/.test(o) && noErrors(o) },
  { name: 'flow', file: 'flow.mjs', est: 40, pass: (o) => /lose result/.test(o) && /lose2 \{[^\n]*"phase":"result"/.test(o) && /end \{"screen":"TitleScreen"\}/.test(o) && noErrors(o) },
  { name: 'harden', file: 'harden.mjs', est: 35, pass: (o) => /8 reducedMotion true/.test(o) && !/pageerror/.test(o) },
  { name: 'move', file: 'move.mjs', est: 30, pass: (o) => /no errors/.test(o) },
  { name: 'stress', file: 'stress.mjs', est: 30, pass: (o) => /"peak":40/.test(o) && /11 left stick right/.test(o) && noErrors(o) },
  { name: 'melee', file: 'melee.mjs', est: 25, pass: (o) => /after guard/.test(o) && /no errors/.test(o) },
  { name: 'audio', file: 'audio.mjs', est: 25, pass: (o) => /after combat .*"ctx":"running"/.test(o) && !/pageerror/.test(o) },
  { name: 'movement', file: 'movement.mjs', est: 20, pass: (o) => /boostSteady\s+41\b/.test(o) && /errors: none/.test(o) },
  { name: 'move-edges', file: 'movement-edges.mjs', est: 20, pass: (o) => /edges OK/.test(o) && noErrors(o) },
  { name: 'touch', file: 'touch.mjs', est: 30, pass: (o) => /touch OK/.test(o) && noErrors(o) },
  { name: 'split-vs', file: 'local.mjs', args: ['versus'], est: 75, pass: (o) => /local OK/.test(o) && noErrors(o) },
  { name: 'split-coop', file: 'local.mjs', args: ['coop'], est: 40, pass: (o) => /local OK/.test(o) && noErrors(o) },
  { name: 'split-edge', file: 'local.mjs', args: ['edges'], est: 110, pass: (o) => /local OK/.test(o) && noErrors(o) },
  { name: 'roster', file: 'roster.mjs', est: 45, pass: (o) => /roster OK/.test(o) && noErrors(o) },
].filter((t) => !only || only.includes(t.name));

async function startServer() {
  if (process.env.E2E_BASE) return { base: process.env.E2E_BASE, stop() {} };
  const vite = spawn(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
  const base = `http://127.0.0.1:${PORT}/`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(base)).ok) return { base, stop: () => vite.kill() };
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  vite.kill();
  throw new Error('dev server did not start');
}

const server = await startServer();
/** each test runs in its own process group, so its browsers die with it even if the test crashes */
const groups = new Set();
const killGroup = (pid) => {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // already gone
  }
};
for (const sig of ['SIGINT', 'SIGTERM'])
  process.on(sig, () => {
    for (const pid of groups) killGroup(pid);
    server.stop();
    process.exit(130);
  });
fs.mkdirSync(path.join(DIR, '.out/logs'), { recursive: true });
const t0 = Date.now();
const results = [];
const queue = [...TESTS].sort((a, b) => b.est - a.est);

function run(t) {
  return new Promise((resolve) => {
    const start = Date.now();
    const p = spawn(process.execPath, [t.file, ...(t.args ?? [])], { cwd: DIR, env: { ...process.env, E2E_BASE: server.base }, detached: true });
    groups.add(p.pid);
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    const killer = setTimeout(() => killGroup(p.pid), 240_000);
    p.on('close', () => {
      clearTimeout(killer);
      // sweep up any browser the test left behind (a crash skips its browser.close())
      killGroup(p.pid);
      groups.delete(p.pid);
      const secs = (Date.now() - start) / 1000;
      fs.writeFileSync(path.join(DIR, '.out/logs', `${t.name}.log`), out);
      const ok = t.pass(out);
      results.push({ ok, secs });
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${t.name.padEnd(12)} ${secs.toFixed(1).padStart(6)} s${ok ? '' : `   (tests/e2e/.out/logs/${t.name}.log)`}`);
      resolve();
    });
  });
}

await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => {
  while (queue.length) await run(queue.shift());
}));
server.stop();
const wall = (Date.now() - t0) / 1000;
const sum = results.reduce((a, r) => a + r.secs, 0);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed · ${wall.toFixed(0)} s wall (${sum.toFixed(0)} s of tests, ${jobs} at a time)`);
process.exit(failed ? 1 : 0);
