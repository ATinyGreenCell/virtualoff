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

/**
 * Shots fire on the press, with no waiting. A second trigger within this window sends fireCW, which
 * the mech treats as "upgrade the shot that just started to the center weapon" (both triggers = CW).
 */
const COMBINE_WINDOW = 0.08;

const BLOCK_DEFAULT = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'ShiftLeft']);

const deadzone = (v: number, dz = 0.22) => (Math.abs(v) < dz ? 0 : (Math.sign(v) * (Math.abs(v) - dz)) / (1 - dz));

export class Input {
  readonly controls = makeControls();
  readonly menu: MenuInput = {
    up: false,
    down: false,
    left: false,
    right: false,
    confirm: false,
    back: false,
    pause: false,
    any: false,
  };
  readonly touch: TouchState = { moveX: 0, moveY: 0, jump: false, dash: false, guard: false, lw: false, rw: false, cw: false };
  padConnected = false;
  lastDevice: InputDevice = 'keyboard';
  /** Called when the gamepad the player was using disconnects (e.g. to auto-pause). */
  onDeviceLost: (() => void) | null = null;

  private down = new Set<string>();
  private pressed = new Set<string>();
  private mousePressed = [false, false, false];
  /** mouse buttons currently held (PointerEvent.buttons bitmask) — chorded presses only arrive as pointermove */
  private mouseButtons = 0;
  /** a touch/pen tap since the last update — counts as "any button" for PRESS START, never as a weapon */
  private touchTap = false;
  private padIndex = -1;
  /** identity of the pad the axis mask below was taken from */
  private padKey = '';
  /** axes that rested far from center when a non-standard pad appeared (triggers reported as axes) */
  private padDeadAxes: boolean[] = [];
  private padPrev: boolean[] = [];
  private stickPrev = { x: 0, y: 0 };
  private sinceL = 9;
  private sinceR = 9;
  private prevJump = false;
  private prevDash = false;

  constructor(target: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (BLOCK_DEFAULT.has(e.code)) e.preventDefault();
      if (!e.repeat) this.pressed.add(e.code);
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
      if (e.gamepad.index !== this.padIndex) return;
      this.padIndex = -1;
      this.padKey = '';
      this.padPrev.length = 0;
      if (this.lastDevice === 'pad') {
        this.lastDevice = 'keyboard';
        this.onDeviceLost?.();
      }
    });
  }

  /** Simulate a one-frame key press (e.g. the touch PAUSE button sends 'Escape'). */
  injectPress(code: string) {
    this.pressed.add(code);
  }

  /** Drop any buffered presses (e.g. the click that started a battle). */
  flush() {
    this.pressed.clear();
    this.mousePressed.fill(false);
    this.touchTap = false;
    this.touch.lw = this.touch.rw = this.touch.cw = false;
    this.sinceL = this.sinceR = 9;
    resetControls(this.controls);
  }

  isDown(code: string) {
    return this.down.has(code);
  }

  wasPressed(code: string) {
    return this.pressed.has(code);
  }

  update(dt: number, padMode: PadMode) {
    const c = this.controls;
    const k = (code: string) => this.down.has(code);
    const kp = (code: string) => this.pressed.has(code);

    // --- keyboard + mouse ---
    let mx = (k('KeyD') ? 1 : 0) - (k('KeyA') ? 1 : 0);
    let my = (k('KeyW') ? 1 : 0) - (k('KeyS') ? 1 : 0);
    let turn = (k('KeyE') || k('ArrowRight') ? 1 : 0) - (k('KeyQ') || k('ArrowLeft') ? 1 : 0);
    let jump = k('Space');
    let dash = k('ShiftLeft') || k('ShiftRight');
    let guard = k('KeyC');
    let lEdge = kp('KeyJ') || this.mousePressed[2];
    let rEdge = kp('KeyL') || this.mousePressed[0];
    let cEdge = kp('KeyK') || this.mousePressed[1];

    const m = this.menu;
    m.up = kp('ArrowUp') || kp('KeyW');
    m.down = kp('ArrowDown') || kp('KeyS');
    m.left = kp('ArrowLeft') || kp('KeyA');
    m.right = kp('ArrowRight') || kp('KeyD');
    m.confirm = kp('Enter') || kp('Space') || kp('KeyJ') || kp('KeyK') || kp('KeyL');
    m.back = kp('Escape') || kp('Backspace');
    m.pause = kp('Escape') || kp('KeyP');
    m.any = this.pressed.size > 0 || this.mousePressed.some(Boolean) || this.touchTap;

    // --- gamepad ---
    const pad = this.pollPad();
    this.padConnected = !!pad;
    if (pad) {
      const key = `${pad.index}:${pad.id}`;
      if (key !== this.padKey) {
        this.padKey = key;
        // Non-standard mappings can expose analog triggers as axes resting at -1. A stick never rests
        // there, so mask those axes rather than let the mech spin on its own.
        this.padDeadAxes = pad.mapping === 'standard' ? [] : pad.axes.map((a) => Math.abs(a) > 0.5);
      }
      const b = (i: number) => !!pad.buttons[i]?.pressed;
      const bp = (i: number) => b(i) && !this.padPrev[i];
      const raw = (i: number) => (this.padDeadAxes[i] ? 0 : (pad.axes[i] ?? 0));
      const ax = (i: number) => deadzone(raw(i));
      let padAny = false;
      for (let i = 0; i < pad.buttons.length; i++) if (bp(i)) padAny = true;

      if (padMode === 'twin') {
        // Twin-stick emulation: each analog stick is one arcade lever.
        const lx = ax(0);
        const ly = -ax(1);
        const rx = ax(2);
        const ry = -ax(3);
        const leversApart = lx < -0.55 && rx > 0.55;
        const leversTogether = lx > 0.55 && rx < -0.55;
        if (!leversApart && !leversTogether) {
          mx += (lx + rx) / 2;
          my += (ly + ry) / 2;
          turn += (ly - ry) / 2;
        }
        jump ||= leversApart;
        guard ||= leversTogether;
        dash ||= b(4) || b(5);
        lEdge ||= bp(6);
        rEdge ||= bp(7);
        cEdge ||= bp(3);
      } else {
        mx += ax(0);
        my -= ax(1);
        turn += ax(2);
        if (b(14)) mx -= 1;
        if (b(15)) mx += 1;
        if (b(12)) my += 1;
        if (b(13)) my -= 1;
        jump ||= b(0);
        dash ||= b(1) || b(4) || b(5);
        guard ||= b(2);
        lEdge ||= bp(6);
        rEdge ||= bp(7);
        cEdge ||= bp(3);
      }

      // menu navigation from d-pad and left stick edges
      const sx = raw(0);
      const sy = raw(1);
      const T = 0.6;
      m.up ||= bp(12) || (sy < -T && this.stickPrev.y >= -T);
      m.down ||= bp(13) || (sy > T && this.stickPrev.y <= T);
      m.left ||= bp(14) || (sx < -T && this.stickPrev.x >= -T);
      m.right ||= bp(15) || (sx > T && this.stickPrev.x <= T);
      m.confirm ||= bp(0) || bp(9);
      m.back ||= bp(1);
      m.pause ||= bp(9);
      m.any ||= padAny;
      this.stickPrev.x = sx;
      this.stickPrev.y = sy;
      if (padAny || Math.abs(ax(0)) + Math.abs(ax(1)) > 0.5) this.lastDevice = 'pad';

      this.padPrev.length = pad.buttons.length;
      for (let i = 0; i < pad.buttons.length; i++) this.padPrev[i] = !!pad.buttons[i]?.pressed;
    }

    // --- on-screen touch controls ---
    const t = this.touch;
    mx += t.moveX;
    my += t.moveY;
    jump ||= t.jump;
    dash ||= t.dash;
    guard ||= t.guard;
    lEdge ||= t.lw;
    rEdge ||= t.rw;
    cEdge ||= t.cw;
    t.lw = t.rw = t.cw = false;

    c.moveX = clamp(mx, -1, 1);
    c.moveY = clamp(my, -1, 1);
    c.turn = clamp(turn, -1, 1);
    c.jumpPressed = jump && !this.prevJump;
    c.jump = jump;
    this.prevJump = jump;
    c.dashPressed = dash && !this.prevDash;
    c.dash = dash;
    this.prevDash = dash;
    c.guard = guard;

    // --- triggers: fire instantly; LW + RW together (or K / middle mouse / Y) => CW ---
    this.sinceL += dt;
    this.sinceR += dt;
    c.fireLW = c.fireRW = c.fireCW = false;
    if (cEdge || (lEdge && rEdge)) c.fireCW = true;
    else if (lEdge) {
      if (this.sinceR < COMBINE_WINDOW) c.fireCW = true;
      else c.fireLW = true;
    } else if (rEdge) {
      if (this.sinceL < COMBINE_WINDOW) c.fireCW = true;
      else c.fireRW = true;
    }
    if (lEdge) this.sinceL = 0;
    if (rEdge) this.sinceR = 0;

    this.pressed.clear();
    this.mousePressed.fill(false);
    this.touchTap = false;
  }

  private pollPad(): Gamepad | null {
    if (!navigator.getGamepads) return null;
    for (const p of navigator.getGamepads()) {
      if (p && p.connected) {
        this.padIndex = p.index;
        return p;
      }
    }
    return null;
  }
}
