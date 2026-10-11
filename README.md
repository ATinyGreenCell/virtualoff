# VIRTUAL-OFF

**Play it: https://atinygreencell.github.io/virtualoff/**

A browser-based love letter to mid-90s arcade mech duels in the spirit of *Cyber Troopers Virtual-On*:
low-poly flat-shaded robots, Sega-blue skies, chunky arcade HUD, 1-on-1 lock-on battles, twin-stick
controls, synthesized techno. TypeScript + Three.js (WebGL), no build-time assets — every mech, stage,
texture, sound effect and music track is generated in code. Runs on desktop, phones and TV browsers;
two people can battle each other on their own devices, or share one screen split top and bottom — head
to head or as a team against the CPU.

> Unofficial fan tribute. Not affiliated with SEGA. All names, mechs, stages and music are original.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # typecheck + production build into dist/
npm run preview    # serve the production build
npm run test:e2e   # end-to-end browser suite (see Tests)
```

## Tests

`npm run test:e2e` runs 19 browser tests against a dev server it starts itself, 8 at a time — about
two minutes:

- arcade flow (stages, continues, game over)
- CPU vs CPU
- movement physics and edge cases
- melee
- touch controls on an emulated phone, including boost + fire with one thumb
- audio engine stress
- crash/context-loss hardening
- two-device versus, including 30 % packet loss, dropped-link recovery, a rival whose page freezes,
  and a rematch (both pilots still in control, VR picks kept)
- split screen with two (emulated) gamepads: joining, each pad flying its own VR, pause, a controller
  dropping out and another taking over, rematch, and co-op (teams, no friendly fire, partner cam)
- split-screen edge cases: double KO, resizing mid-fight, a frame failing mid-draw, co-op time-ups,
  continue through to the two-pilot ending
- the roster: every VR's model, and each weapon of KESTREL, KONGO and ARACHNE doing its job (the
  versus test also flies ARACHNE vs KONGO, so mines, drones and the snare go over the network)
- menus: the VR select screen on a phone held sideways, the lobbies driven by a controller, and
  Xbox's browsing mode

Dev-only URL switches keep it quick: `?fast` speeds up non-gameplay waits, `?noaudio` skips building
the sound library, and `?grace=N` shortens the versus reconnect window. Production builds strip
these out.

The suite needs Chrome (`CHROME_PATH` to point elsewhere), and the versus tests need internet access
because they pair through public Nostr relays. Logs and screenshots go to `tests/e2e/.out/`. Run
part of it with `npm run test:e2e -- --only versus,split-vs`.

## Deploy to GitHub Pages

1. Push this folder to a GitHub repository (branch `main`).
2. In the repo: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Every push to `main` runs `.github/workflows/deploy.yml` and publishes to
   `https://<user>.github.io/<repo>/`. Paths are relative (`base: './'`), so any repo name works.

## Split screen (two players, one screen)

Title → **SPLIT SCREEN · 2 PLAYERS**. The screen splits top (1P) and bottom (2P), each half with its own
camera and HUD, and each player flies with their own controller.

- **VERSUS** — 1P vs 2P, best of three on a random stage. **REMATCH** keeps the VRs; **VR SELECT** goes back
  to the picks.
- **CO-OP** — 1P and 2P take the arcade stages together, 2-on-1 against each VR. The boss (in black and
  gold or crimson) has more armor, hits harder, recharges faster and shrugs off light hits, so two
  players can't just stagger it in turns; heavy hits and melee still knock it down. Shots pass through
  your partner. Lose the round only when you're both down — until then, a destroyed player's camera
  rides along with their partner. Lose a match and either of you can continue.
- **Joining:** whoever picks the mode is 1P; the other player presses **A** (or **ENTER** on the keyboard,
  which can be a player too) to take 2P. Left/right picks a VR, A readies up, B backs out.
- **Controllers:** if one disconnects mid-fight the match pauses, and that player presses **A** (or
  **ENTER** on the keyboard) on the controller they'll use — their own once it's back, or any free one.
  Because a pad that reconnects may land in the other player's slot, a returning pad always has to be
  claimed this way, 1P first when both dropped. Either player's **START** pauses.

**On Xbox (Edge):** open the game, then **hold the ☰ Menu button and choose "Use game controls"** —
otherwise Edge keeps the controller for its cursor and B goes back a page. Hold **View** for full screen.
Both controllers then reach the game; go to SPLIT SCREEN and have each player press A. (Edge's
"browsing controls" also take B as *back*; the game keeps an extra history entry on Xbox so a stray B
doesn't leave the page.)

## Versus (two players, two devices)

Title → **VERSUS · 2 DEVICES**. One player picks **HOST A MATCH** and gets a 4-letter room code (and a
**SEND INVITE LINK** button — opening the link joins automatically). The other picks **JOIN A MATCH** and
types the code. Both choose a VR, hit **READY**, and fight best-of-three; **REMATCH** keeps you linked.

- Devices find each other through public Nostr relays ([Trystero](https://github.com/dmotz/trystero)),
  then talk directly over an encrypted WebRTC data channel — there is no game server.
- Being on the **same Wi-Fi** is the most reliable. Some mobile networks block direct peer-to-peer links;
  if a pairing won't connect, joining the same Wi-Fi (or a phone hotspot) fixes it.
- The host's device runs the fight and streams it ~60×/s; the guest's device sends its inputs and draws
  the host's snapshots with a short interpolation buffer, so both screens always agree on every hit.
  State and inputs travel on an unordered, no-retransmit channel (a lost packet never stalls the ones
  behind it; inputs repeat the last few presses so none get lost), while one-shot events — hits,
  announcer calls — go on the reliable channel.
- If the link drops mid-match (Wi-Fi blip, switching apps), both screens freeze within a couple of
  seconds of the rival going quiet and the match picks up where it stopped as soon as the devices
  re-pair — up to 20 seconds.

## Controls

| Keyboard | Action |
| --- | --- |
| `W A S D` | walk / strafe (your VR auto-faces the enemy) |
| `Q` `E` (or `←` `→`) | quick turn |
| `Space` | jump — hold to keep climbing on thrusters (EN) |
| `Shift` + direction | tap: **quick boost** burst (EN) · hold: **boost** glide (free on the ground, EN in the air) |
| `J` / `L` | left weapon (LW) / right weapon (RW) |
| `K` or `J`+`L` together | center weapon (CW) |
| `C` | guard |
| Mouse | left = RW, right = LW, middle = CW |
| `Esc` | pause (vs CPU) / leave menu (versus) |
| `` ` `` | FPS / performance meter |

**Split screen:** each player's keyboard or gamepad drives only their own VR (one player can use the
keyboard). In one-player modes every connected gamepad controls 1P.

**Touch:** on phones and tablets an on-screen arcade layout appears — floating stick on the left, LW /
RW / CW / JUMP / BOOST / GUARD on the right, pause at the top. Play in landscape. For a boosting shot
with one thumb (KONGO's shoulder ram), hold BOOST, slide onto the weapon and lift there.

**Gamepad — Modern:** left stick move, right stick turn, A jump, B/LB/RB dash, LT/RT = LW/RW
(both = CW), Y = CW, X = guard.

**Gamepad — Twin Stick** (Settings → GAMEPAD): each analog stick is one arcade lever. Both forward to
walk, opposite directions to turn, pull apart to jump, push together to guard. LB/RB are the turbo
buttons (dash), LT/RT the triggers.

**Movement carries momentum.** Tap BOOST for a quick-boost burst (chain them to zig-zag), hold it to glide
at high speed and steer — at speed you carve arcs rather than snapping round. Jump out of a boost and the
whole speed goes up with you; hold JUMP to climb, hold BOOST in the air to hover-glide, and you land
without losing pace (only a long fall crouches you for a beat). Quick boosts, climbing and air boosting
spend **EN** (the bar above the weapon gauges); run it dry and it locks out until it recovers.

Shooting doesn't stop you: **walking shots** keep you moving at nearly full speed, while **planted
shots** (standing still) home in better. Heavy center-weapon shots plant your feet, but whatever momentum
you had slides out. Shots fire on the press; hit the second trigger
right after the first to turn it into the center weapon. Jump/dash/fire pressed during a shot's recovery
is buffered and comes out right after it.

Fire near the enemy for a melee attack. Shots change while boosting or airborne (spread shots, dropped
bombs, air shots that keep your jump arc). Big hits knock you down — you're invincible while getting up.
Weapon gauges recharge independently.

## What's in it

- **Five VRs, each playing its own way:**
  - **JEBE** — balanced assault: beam rifle, pulse bomb, homing hyper beam, beam saber.
  - **FUJIN** — heavy artillery: shoulder cannons, homing cluster missiles, sweeping gale laser,
    hammer knuckle.
  - **KESTREL** — aerial interceptor: the fastest and lightest frame, and climbing and air boosting
    cost it about half the EN, so it can stay up. Three-needle laser bursts, a fan of six swarm darts,
    and a rail lance (a short charge, then a near-instant shot that knocks down). Wing-edge blade up
    close.
  - **KONGO** — brawler: a seven-pellet scatter gun that fades out past mid range; **boosting turns RW
    into a shoulder ram** that charges about 35 units and knocks down; a homing rocket fist; and a quake
    slam (a two-fisted smash on the ground; in the air, a straight-down dive that lands it) whose
    shockwave runs along the ground: jump over it, or keep a wall in between. Its rams, uppercut and
    slam shrug off light hits.
  - **ARACHNE** — trapper: hunter drones that keep circling back at you (and swat bullets out of the
    air), web mines that dig into the ground, blink for a moment, then go off when you walk near
    (thrown across your path, or ringed around ARACHNE when you get close), and a snare net that pins
    you in place for a couple of seconds: you can still turn, guard and shoot, but not move, boost,
    jump or lunge (a front guard blocks it).
- **Two stages:** AQUA HARBOR (daytime docks) and DUSK FOUNDRY (sunset industrial), each with its own
  layout, scenery and battle theme.
- **Arcade mode:** fight every other VR on its home stage, then your own mirror image in alternate
  colors. Best of three rounds, 60-second timer, continue countdown.
- **Split-screen versus and co-op** on one screen with two controllers (see above).
- **Versus mode** over a direct peer-to-peer link (see above).
- **Video modes:** ARCADE PIXELS (~Model 2 resolution, integer-scaled), CRT SCANLINES, SHARP HD.
- **Performance:** AUTO (default) watches frame times and trades resolution for smoothness on weak
  devices, then restores it when there's headroom; HIGH pins full quality; LOW / BATTERY runs lighter.
  Static geometry is batched (~80 draw calls per frame), every shader is compiled during screen
  transitions, and physics sub-steps keep the game identical from 20 fps to 240 fps.
- CPU opponent with three difficulty levels that dodges, dashes, rushes in for melee and punishes
  landings — it uses the exact same control frame as the player.
- Hardened for real-world use: GPU context loss recovery, auto-pause when the tab is hidden, focus is
  lost or a gamepad unplugs, crash-loop recovery back to the title, and reduced-motion support.
- Fast return visits: the synthesized sound library is cached in IndexedDB after the first visit (keyed
  to a hash of the audio code), and three.js ships as its own long-lived file.

## Code map

```
src/
  main.ts / app.ts / flow.ts   boot, frame loop (sub-steps, quality governor), screen flow
  core/        input (keyboard, mouse, gamepads — merged or per player, twin-stick), touch controls,
               settings, math & collision, Xbox detection
  render/      low-res renderer, canvas-generated textures, tapered-box geometry
  game/
    specs.ts       mech stats, weapons, melee, CPU-pilot hints, palettes
    mechModel.ts   procedural mech meshes (baked per joint) + procedural animation rig
    mech.ts        movement state machine, weapons, damage, knockdowns, versus snapshots
    weapons.ts     projectiles, homing, splash, the sustained laser, weapon timelines
    ai.ts          CPU pilot
    arena.ts       stages, static batching, collision, occluding-block fading
    battle.ts      round flow, HUD, cameras — vs CPU, versus host/guest, split-screen versus and co-op
  net/         room codes, wire protocol, WebRTC link (Trystero)
  audio/       WebAudio engine: instruments and sfx synthesized once offline at boot, then played as
               samples — song sequencer (chords, sidechain pump, echo), master bus, original tracks
  ui/          HUD, title / select / ending screens, versus lobby, split-screen lobby
```
