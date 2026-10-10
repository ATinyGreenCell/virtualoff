# VIRTUAL-OFF

**Play it: https://atinygreencell.github.io/virtualoff/**

A browser-based love letter to mid-90s arcade mech duels in the spirit of *Cyber Troopers Virtual-On*:
low-poly flat-shaded robots, Sega-blue skies, chunky arcade HUD, 1-on-1 lock-on battles, twin-stick
controls, synthesized techno. TypeScript + Three.js (WebGL), no build-time assets — every mech, stage,
texture, sound effect and music track is generated in code. Runs on desktop and phones, and two people
can battle each other on their own devices.

> Unofficial fan tribute. Not affiliated with SEGA. All names, mechs, stages and music are original.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # typecheck + production build into dist/
npm run preview    # serve the production build
```

## Deploy to GitHub Pages

1. Push this folder to a GitHub repository (branch `main`).
2. In the repo: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Every push to `main` runs `.github/workflows/deploy.yml` and publishes to
   `https://<user>.github.io/<repo>/`. Paths are relative (`base: './'`), so any repo name works.

## Versus (two players, two devices)

Title → **VERSUS · 2 PLAYERS**. One player picks **HOST A MATCH** and gets a 4-letter room code (and a
**SEND INVITE LINK** button — opening the link joins automatically). The other picks **JOIN A MATCH** and
types the code. Both choose a VR, hit **READY**, and fight best-of-three; **REMATCH** keeps you linked.

- Devices find each other through public Nostr relays ([Trystero](https://github.com/dmotz/trystero)),
  then talk directly over an encrypted WebRTC data channel — there is no game server.
- Being on the **same Wi-Fi** is the most reliable. Some mobile networks block direct peer-to-peer links;
  if a pairing won't connect, joining the same Wi-Fi (or a phone hotspot) fixes it.
- The host's device runs the fight and streams it ~60×/s; the guest's device sends its inputs and draws
  the host's snapshots with a short interpolation buffer, so both screens always agree on every hit.

## Controls

| Keyboard | Action |
| --- | --- |
| `W A S D` | walk / strafe (your VR auto-faces the enemy) |
| `Q` `E` (or `←` `→`) | quick turn |
| `Space` | jump |
| `Shift` + direction | dash (hold to extend; in the air = air dash) |
| `J` / `L` | left weapon (LW) / right weapon (RW) |
| `K` or `J`+`L` together | center weapon (CW) |
| `C` | guard |
| Mouse | left = RW, right = LW, middle = CW |
| `Esc` | pause (vs CPU) / leave menu (versus) |
| `` ` `` | FPS / performance meter |

**Touch:** on phones and tablets an on-screen arcade layout appears — floating stick on the left, LW /
RW / CW / JUMP / DASH / GUARD on the right, pause at the top. Play in landscape.

**Gamepad — Modern:** left stick move, right stick turn, A jump, B/LB/RB dash, LT/RT = LW/RW
(both = CW), Y = CW, X = guard.

**Gamepad — Twin Stick** (Settings → GAMEPAD): each analog stick is one arcade lever. Both forward to
walk, opposite directions to turn, pull apart to jump, push together to guard. LB/RB are the turbo
buttons (dash), LT/RT the triggers.

Shooting doesn't stop you: **walking shots** keep you moving at nearly full speed, while **planted
shots** (standing still) home in better. Heavy center-weapon shots plant your feet, but whatever momentum
you had slides out, as do dash endings and landings. Shots fire on the press; hit the second trigger
right after the first to turn it into the center weapon. Jump/dash/fire pressed during a shot's recovery
is buffered and comes out right after it.

Fire near the enemy for a melee attack. Shots change while dashing or airborne (spread shots, dropped
bombs, air shots that keep your jump arc). Big hits knock you down — you're invincible while getting up.
Weapon gauges recharge independently.

## What's in it

- **Two VRs:** JEBE (balanced assault: beam rifle, pulse bomb, hyper beam, beam saber) and FUJIN
  (heavy artillery: shoulder cannons, homing cluster missiles, sweeping gale laser, hammer knuckle).
- **Two stages:** AQUA HARBOR (daytime docks) and DUSK FOUNDRY (sunset industrial), each with its own
  layout, scenery and battle theme.
- **Arcade mode:** fight the other VR on its home stage, then your own mirror image in alternate
  colors. Best of three rounds, 60-second timer, continue countdown.
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

## Code map

```
src/
  main.ts / app.ts / flow.ts   boot, frame loop (sub-steps, quality governor), screen flow
  core/        input (keyboard, mouse, gamepad, twin-stick), touch controls, settings, math & collision
  render/      low-res renderer, canvas-generated textures, tapered-box geometry
  game/
    specs.ts       mech stats, weapons, palettes
    mechModel.ts   procedural mech meshes (baked per joint) + procedural animation rig
    mech.ts        movement state machine, weapons, damage, knockdowns, versus snapshots
    weapons.ts     projectiles, homing, splash, the sustained laser, weapon timelines
    ai.ts          CPU pilot
    arena.ts       stages, static batching, collision, occluding-block fading
    battle.ts      round flow, HUD, cameras — vs CPU, versus host and versus guest
  net/         room codes, wire protocol, WebRTC link (Trystero)
  audio/       WebAudio engine: instruments and sfx synthesized once offline at boot, then played as
               samples — song sequencer (chords, sidechain pump, echo), master bus, original tracks
  ui/          HUD, title / select / ending screens, versus lobby
```
