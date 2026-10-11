import { clamp } from './math';
import type { PadMode } from './settings';

/** One frame of pilot intent. Produced by Input (human) or AIController (CPU) — Mech consumes it. */
export interface ControlFrame {
  /** strafe, right positive (-1..1) */
  moveX: number;
  /** forward positive (-1..1) */
  moveY: number;
  /** manual quick-turn, right positive (-1..1) */
  turn: number;
  jump: boolean;
  jumpPressed: boolean;
  dash: boolean;
  dashPressed: boolean;
  guard: boolean;
  fireLW: boolean;
  fireRW: boolean;
  fireCW: boolean;
}

export function makeControls(): ControlFrame {
  return {
    moveX: 0,
    moveY: 0,
    turn: 0,
    jump: false,
    jumpPressed: false,
    dash: false,
    dashPressed: false,
    guard: false,
    fireLW: false,
    fireRW: false,
    fireCW: false,
  };
}

export function resetControls(c: ControlFrame) {
  c.moveX = c.moveY = c.turn = 0;
  c.jump = c.jumpPressed = c.dash = c.dashPressed = c.guard = false;
  c.fireLW = c.fireRW = c.fireCW = false;
}

/** Which kind of device the player touched last — drives whether the touch overlay is shown. */
export type InputDevice = 'keyboard' | 'pad' | 'touch';

/**
 * Written by the on-screen touch controls (src/core/touch.ts) and merged in Input.update like a gamepad.
 * moveX/moveY and the held buttons are levels; lw/rw/cw are press edges that Input consumes each frame.
 */
export interface TouchState {
  moveX: number;
  moveY: number;
  jump: boolean;
  dash: boolean;
  /** a press since the last frame — a tap shorter than one frame still counts (quick boosts are taps) */
  jumpTap: boolean;
  dashTap: boolean;
  guard: boolean;
  lw: boolean;
  rw: boolean;
  cw: boolean;
}

export interface MenuInput {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  confirm: boolean;
  back: boolean;
  pause: boolean;
  any: boolean;
}

const makeMenu = (): MenuInput => ({ up: false, down: false, left: false, right: false, confirm: false, back: false, pause: false, any: false });

function clearMenu(m: MenuInput) {
  m.up = m.down = m.left = m.right = m.confirm = m.back = m.pause = m.any = false;
}

function orMenu(into: MenuInput, m: MenuInput) {
  into.up ||= m.up;
  into.down ||= m.down;
  into.left ||= m.left;
  into.right ||= m.right;
  into.confirm ||= m.confirm;
  into.back ||= m.back;
  into.pause ||= m.pause;
  into.any ||= m.any;
}

/** A control source a local player can own: the keyboard + mouse, or one gamepad. */
export type DeviceId = 'keys' | `pad${number}`;

export interface Device {
  readonly id: DeviceId;
  /** this frame's gameplay intent from this device alone */
  readonly controls: ControlFrame;
  /** this frame's menu presses from this device alone */
  readonly menu: MenuInput;
  /** gamepads come and go; the keyboard is always there */
  readonly connected: boolean;
  /**
   * Bumps each time a gamepad (re)connects in this slot. Slots are handed out in connection order and
   * identical pads report identical ids, so after a reconnect the slot may hold someone else's pad: a
   * player bound to an older generation has to press a button to claim it again.
   */
  readonly generation: number;
}

/** Name of a device for the screen ('KEYBOARD', 'PAD 2'). */
export const deviceLabel = (id: DeviceId) => (id === 'keys' ? 'KEYBOARD' : `PAD ${Number(id.slice(3)) + 1}`);

/**
 * Shots fire on the press, with no waiting. A second trigger within this window sends fireCW, which
 * the mech treats as "upgrade the shot that just started to the center weapon" (both triggers = CW).
 */
const COMBINE_WINDOW = 0.08;

const BLOCK_DEFAULT = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'ShiftLeft']);

const deadzone = (v: number, dz = 0.22) => (Math.abs(v) < dz ? 0 : (Math.sign(v) * (Math.abs(v) - dz)) / (1 - dz));

/** Connected gamepads. Chromium only offers them on secure (HTTPS) pages and may throw elsewhere. */
function readPads(): readonly (Gamepad | null)[] {
  try {
    return navigator.getGamepads ? navigator.getGamepads() : [];
  } catch {
    return [];
  }
}

/** One source's raw intent for a frame, before press edges and trigger combining. */
interface Intent {
  mx: number;
  my: number;
  turn: number;
  /** held levels */
  jump: boolean;
  dash: boolean;
  guard: boolean;
  /** presses since the last frame (key-downs and touch taps; polled pads get their edges from the levels) */
  jumpTap: boolean;
  dashTap: boolean;
  /** trigger press edges: LW, RW, CW */
  l: boolean;
  r: boolean;
  c: boolean;
}

const makeIntent = (): Intent => ({ mx: 0, my: 0, turn: 0, jump: false, dash: false, guard: false, jumpTap: false, dashTap: false, l: false, r: false, c: false });

function clearIntent(i: Intent) {
  i.mx = i.my = i.turn = 0;
  i.jump = i.dash = i.guard = i.jumpTap = i.dashTap = i.l = i.r = i.c = false;
}

/** The stick value pushed furthest, of two. */
const stronger = (a: number, b: number) => (Math.abs(b) > Math.abs(a) ? b : a);

/** Merge another source's buttons in (the sticks are merged by the caller). */
function addButtons(into: Intent, i: Intent) {
  into.jump ||= i.jump;
  into.dash ||= i.dash;
  into.guard ||= i.guard;
  into.jumpTap ||= i.jumpTap;
  into.dashTap ||= i.dashTap;
  into.l ||= i.l;
  into.r ||= i.r;
  into.c ||= i.c;
}

/** Turns one source's intent into a ControlFrame: press edges for polled buttons, LW + RW => CW. */
class Shaper {
  readonly out = makeControls();
  private prevJump = false;
  private prevDash = false;
  private sinceL = 9;
  private sinceR = 9;

  shape(i: Intent, dt: number) {
    const c = this.out;
    c.moveX = clamp(i.mx, -1, 1);
    c.moveY = clamp(i.my, -1, 1);
    c.turn = clamp(i.turn, -1, 1);
    // gamepads are polled, so for them a press is an up→down change between frames
    const jump = i.jump || i.jumpTap;
    const dash = i.dash || i.dashTap;
    c.jumpPressed = i.jumpTap || (jump && !this.prevJump);
    c.jump = jump;
    this.prevJump = jump;
    c.dashPressed = i.dashTap || (dash && !this.prevDash);
    c.dash = dash;
    this.prevDash = dash;
    c.guard = i.guard;

    // triggers: fire instantly; LW + RW together (or K / middle mouse / Y) => CW
    this.sinceL += dt;
    this.sinceR += dt;
    c.fireLW = c.fireRW = c.fireCW = false;
    if (i.c || (i.l && i.r)) c.fireCW = true;
    else if (i.l) {
      if (this.sinceR < COMBINE_WINDOW) c.fireCW = true;
      else c.fireLW = true;
    } else if (i.r) {
      if (this.sinceL < COMBINE_WINDOW) c.fireCW = true;
      else c.fireRW = true;
    }
    if (i.l) this.sinceL = 0;
    if (i.r) this.sinceR = 0;
  }

  /** One-shot presses must only be seen by the first physics sub-step of a frame. */
  clearEdges() {
    const c = this.out;
    c.jumpPressed = c.dashPressed = c.fireLW = c.fireRW = c.fireCW = false;
  }

  /** Let go of everything (held levels stay remembered, so a held button doesn't re-press). */
  reset() {
    resetControls(this.out);
    this.sinceL = this.sinceR = 9;
  }
}

/** One gamepad slot (navigator.getGamepads() index): its own presses, stick edges and control frame. */
class Pad implements Device {
  readonly id: DeviceId;
  readonly intent = makeIntent();
  readonly menu = makeMenu();
  readonly shaper = new Shaper();
  connected = false;
  generation = 0;
  /** a button went down (or the left stick was pushed) this poll */
  active = false;
  /** identity of the pad the axis mask below was taken from */
  private key = '';
  /** axes that rested far from center when a non-standard pad appeared (triggers reported as axes) */
  private deadAxes: boolean[] = [];
  private prev: boolean[] = [];
  private stickPrev = { x: 0, y: 0 };

  constructor(index: number) {
    this.id = `pad${index}`;
  }

  get controls() {
    return this.shaper.out;
  }

  read(pad: Gamepad | null, padMode: PadMode) {
    const it = this.intent;
    clearIntent(it);
    clearMenu(this.menu);
    this.active = false;
    if (!pad || !pad.connected) {
      if (this.connected) this.drop();
      return;
    }
    if (!this.connected) this.generation++;
    this.connected = true;
    const key = `${pad.index}:${pad.id}`;
    if (key !== this.key) {
      this.key = key;
      // Non-standard mappings can expose analog triggers as axes resting at -1. A stick never rests
      // there, so mask those axes rather than let the mech spin on its own.
      this.deadAxes = pad.mapping === 'standard' ? [] : pad.axes.map((a) => Math.abs(a) > 0.5);
    }
    const b = (i: number) => !!pad.buttons[i]?.pressed;
    const bp = (i: number) => b(i) && !this.prev[i];
    const raw = (i: number) => (this.deadAxes[i] ? 0 : (pad.axes[i] ?? 0));
    const ax = (i: number) => deadzone(raw(i));
    let any = false;
    for (let i = 0; i < pad.buttons.length; i++) if (bp(i)) any = true;

    if (padMode === 'twin') {
      // Twin-stick emulation: each analog stick is one arcade lever.
      const lx = ax(0);
      const ly = -ax(1);
      const rx = ax(2);
      const ry = -ax(3);
      const leversApart = lx < -0.55 && rx > 0.55;
      const leversTogether = lx > 0.55 && rx < -0.55;
      if (!leversApart && !leversTogether) {
        it.mx = (lx + rx) / 2;
        it.my = (ly + ry) / 2;
        it.turn = (ly - ry) / 2;
      }
      it.jump = leversApart;
      it.guard = leversTogether;
      it.dash = b(4) || b(5);
    } else {
      it.mx = ax(0) + (b(15) ? 1 : 0) - (b(14) ? 1 : 0);
      it.my = -ax(1) + (b(12) ? 1 : 0) - (b(13) ? 1 : 0);
      it.turn = ax(2);
      it.jump = b(0);
      it.dash = b(1) || b(4) || b(5);
      it.guard = b(2);
    }
    it.l = bp(6);
    it.r = bp(7);
    it.c = bp(3);

    // menu navigation from d-pad and left stick edges
    const m = this.menu;
    const sx = raw(0);
    const sy = raw(1);
    const T = 0.6;
    m.up = bp(12) || (sy < -T && this.stickPrev.y >= -T);
    m.down = bp(13) || (sy > T && this.stickPrev.y <= T);
    m.left = bp(14) || (sx < -T && this.stickPrev.x >= -T);
    m.right = bp(15) || (sx > T && this.stickPrev.x <= T);
    m.confirm = bp(0) || bp(9);
    m.back = bp(1);
    m.pause = bp(9);
    m.any = any;
    this.stickPrev.x = sx;
    this.stickPrev.y = sy;
    this.active = any || Math.abs(ax(0)) + Math.abs(ax(1)) > 0.5;

    this.prev.length = pad.buttons.length;
    for (let i = 0; i < pad.buttons.length; i++) this.prev[i] = !!pad.buttons[i]?.pressed;
  }

  /** The pad went away: forget its buttons so it starts clean if it comes back. */
  drop() {
    this.connected = false;
    this.key = '';
    this.prev.length = 0;
    this.stickPrev.x = this.stickPrev.y = 0;
    this.shaper.reset();
  }
}

/**
 * Keyboard, mouse, gamepads and the touch overlay. `controls` / `menu` merge every source (one
 * player on this screen); `device(id)` gives one keyboard or pad on its own (split screen).
 */
export class Input {
  readonly menu: MenuInput = makeMenu();
  readonly touch: TouchState = { moveX: 0, moveY: 0, jump: false, dash: false, jumpTap: false, dashTap: false, guard: false, lw: false, rw: false, cw: false };
  padConnected = false;
  lastDevice: InputDevice = 'keyboard';
  /** Called when the gamepad the player was using disconnects (e.g. to auto-pause). */
  onDeviceLost: (() => void) | null = null;

  private readonly main = new Shaper();
  private readonly keysShaper = new Shaper();
  private readonly keysMenu = makeMenu();
  private readonly keys: Device;
  private readonly pads: Pad[] = [];
  private readonly kb = makeIntent();
  private readonly all = makeIntent();
  private down = new Set<string>();
  /** key-downs not yet consumed, per key: two presses inside one slow frame come out over two frames */
  private pressed = new Map<string, number>();
  private mousePressed = [false, false, false];
  /** mouse buttons currently held (PointerEvent.buttons bitmask) — chorded presses only arrive as pointermove */
  private mouseButtons = 0;
  /** a touch/pen tap since the last update — counts as "any button" for PRESS START, never as a weapon */
  private touchTap = false;
  /** the gamepad that last had input (its disconnect auto-pauses a one-player game) */
  private lastPad = -1;

  constructor(target: HTMLElement) {
    const keysMenu = this.keysMenu;
    const keysShaper = this.keysShaper;
    this.keys = {
      id: 'keys',
      menu: keysMenu,
      connected: true,
      generation: 0,
      get controls() {
        return keysShaper.out;
      },
    };
    window.addEventListener('keydown', (e) => {
      if (BLOCK_DEFAULT.has(e.code)) e.preventDefault();
      if (!e.repeat) this.pressed.set(e.code, (this.pressed.get(e.code) ?? 0) + 1);
      this.down.add(e.code);
      this.lastDevice = 'keyboard';
    });
    window.addEventListener('keyup', (e) => {
      this.down.delete(e.code);
    });
    window.addEventListener('blur', () => {
      this.down.clear();
      this.mouseButtons = 0;
    });
    // Mouse buttons come from pointer events so touch taps never fire weapons. Pressing a second button
    // while one is held doesn't fire pointerdown (only pointermove), so diff the buttons bitmask.
    const onPointer = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') {
        if (e.type === 'pointerdown') {
          this.touchTap = true;
          this.lastDevice = 'touch';
        }
        return;
      }
      const newly = e.buttons & ~this.mouseButtons;
      this.mouseButtons = e.buttons;
      if (!newly) return;
      // buttons bitmask: 1 = left, 2 = right, 4 = middle; mousePressed is indexed like MouseEvent.button
      if (newly & 1) this.mousePressed[0] = true;
      if (newly & 4) this.mousePressed[1] = true;
      if (newly & 2) this.mousePressed[2] = true;
      this.lastDevice = 'keyboard';
    };
    target.addEventListener('pointerdown', onPointer);
    target.addEventListener('pointermove', onPointer);
    window.addEventListener('pointerup', (e) => {
      if (e.pointerType === 'mouse') this.mouseButtons = e.buttons;
    });
    target.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('gamepaddisconnected', (e) => {
      this.pads[e.gamepad.index]?.drop();
      if (e.gamepad.index !== this.lastPad) return;
      this.lastPad = -1;
      if (this.lastDevice === 'pad') {
        this.lastDevice = 'keyboard';
        this.onDeviceLost?.();
      }
    });
  }

  /** The merged control frame (every keyboard, mouse, pad and touch input together). */
  get controls(): ControlFrame {
    return this.main.out;
  }

  /** One keyboard or gamepad on its own (null for a pad slot that has never been seen). */
  device(id: DeviceId): Device | null {
    if (id === 'keys') return this.keys;
    return this.pads[Number(id.slice(3))] ?? null;
  }

  /** Every device that could join a game right now: the keyboard plus each connected pad. */
  devices(): Device[] {
    return [this.keys, ...this.pads.filter((p) => p.connected)];
  }

  /** Simulate a one-frame key press (e.g. the touch PAUSE button sends 'Escape'). */
  injectPress(code: string) {
    this.pressed.set(code, (this.pressed.get(code) ?? 0) + 1);
  }

  /** Drop any buffered presses (e.g. the click that started a battle). */
  flush() {
    this.pressed.clear();
    this.mousePressed.fill(false);
    this.touchTap = false;
    this.touch.lw = this.touch.rw = this.touch.cw = false;
    this.main.reset();
    this.keysShaper.reset();
    for (const p of this.pads) p.shaper.reset();
  }

  /** One-shot presses (and menu edges) must only be seen by the first physics sub-step of a frame. */
  clearEdges() {
    this.main.clearEdges();
    this.keysShaper.clearEdges();
    clearMenu(this.menu);
    clearMenu(this.keysMenu);
    for (const p of this.pads) {
      p.shaper.clearEdges();
      clearMenu(p.menu);
    }
  }

  isDown(code: string) {
    return this.down.has(code);
  }

  wasPressed(code: string) {
    return this.pressed.has(code);
  }

  update(dt: number, padMode: PadMode) {
    const k = (code: string) => this.down.has(code);
    const kp = (code: string) => (this.pressed.get(code) ?? 0) > 0;

    // --- keyboard + mouse ---
    // Every key-down is its own press: a tap that's already back up still counts, and two quick taps
    // landing in consecutive slow frames stay two presses (quick boosts are taps).
    const kb = this.kb;
    kb.mx = (k('KeyD') ? 1 : 0) - (k('KeyA') ? 1 : 0);
    kb.my = (k('KeyW') ? 1 : 0) - (k('KeyS') ? 1 : 0);
    kb.turn = (k('KeyE') || k('ArrowRight') ? 1 : 0) - (k('KeyQ') || k('ArrowLeft') ? 1 : 0);
    kb.jumpTap = kp('Space');
    kb.dashTap = kp('ShiftLeft') || kp('ShiftRight');
    kb.jump = k('Space');
    kb.dash = k('ShiftLeft') || k('ShiftRight');
    kb.guard = k('KeyC');
    kb.l = kp('KeyJ') || this.mousePressed[2];
    kb.r = kp('KeyL') || this.mousePressed[0];
    kb.c = kp('KeyK') || this.mousePressed[1];

    const km = this.keysMenu;
    km.up = kp('ArrowUp') || kp('KeyW');
    km.down = kp('ArrowDown') || kp('KeyS');
    km.left = kp('ArrowLeft') || kp('KeyA');
    km.right = kp('ArrowRight') || kp('KeyD');
    km.confirm = kp('Enter') || kp('Space') || kp('KeyJ') || kp('KeyK') || kp('KeyL');
    km.back = kp('Escape') || kp('Backspace');
    km.pause = kp('Escape') || kp('KeyP');
    km.any = this.pressed.size > 0 || this.mousePressed.some(Boolean);

    // --- gamepads: each slot on its own, and all of them merged for a one-player game. Sticks merge
    // by whichever is pushed furthest, not summed: a pad some drivers expose twice must not double its
    // deflection, and an idle pad mustn't drag on the one in use. ---
    const all = this.all;
    Object.assign(all, kb);
    const m = this.menu;
    Object.assign(m, km);
    m.any ||= this.touchTap;
    const list = readPads();
    const n = Math.max(list.length, this.pads.length);
    let connected = false;
    let px = 0;
    let py = 0;
    let pt = 0;
    for (let i = 0; i < n; i++) {
      const pad = (this.pads[i] ??= new Pad(i));
      pad.read(list[i] ?? null, padMode);
      if (!pad.connected) continue;
      connected = true;
      px = stronger(px, pad.intent.mx);
      py = stronger(py, pad.intent.my);
      pt = stronger(pt, pad.intent.turn);
      addButtons(all, pad.intent);
      orMenu(m, pad.menu);
      pad.shaper.shape(pad.intent, dt);
      if (pad.active) {
        this.lastDevice = 'pad';
        this.lastPad = i;
      }
    }
    this.padConnected = connected;
    all.mx += px;
    all.my += py;
    all.turn += pt;

    // --- on-screen touch controls ---
    const t = this.touch;
    all.mx += t.moveX;
    all.my += t.moveY;
    all.jumpTap ||= t.jumpTap;
    all.dashTap ||= t.dashTap;
    all.jump ||= t.jump;
    all.dash ||= t.dash;
    all.guard ||= t.guard;
    all.l ||= t.lw;
    all.r ||= t.rw;
    all.c ||= t.cw;
    t.lw = t.rw = t.cw = t.jumpTap = t.dashTap = false;

    this.main.shape(all, dt);
    this.keysShaper.shape(kb, dt);

    for (const [code, count] of this.pressed) {
      if (count > 1) this.pressed.set(code, count - 1);
      else this.pressed.delete(code);
    }
    this.mousePressed.fill(false);
    this.touchTap = false;
  }
}
