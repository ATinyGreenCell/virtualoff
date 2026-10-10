import type { ControlFrame } from '../core/input';
import type { MechId, StageId } from '../game/specs';

/** Bump whenever messages change shape; peers with different versions refuse to play. */
export const PROTOCOL = 2;
export const APP_ID = 'virtual-off/versus/v1';

export type Role = 'host' | 'guest';

export type LobbyMsg =
  /** `ack` marks a reply, which is never answered (so two hellos can't ping-pong) */
  | { t: 'hello'; v: number; role: Role; ack?: 1 }
  | { t: 'full' }
  | { t: 'pick'; mech: MechId; ready: boolean }
  | { t: 'start'; mech0: MechId; mech1: MechId; stage: StageId }
  | { t: 'again' }
  | { t: 'bye' };

// ------------------------------------------------------------------ input (guest -> host)

/** [seq, moveX, moveY, turn, buttons] with axes scaled to -100..100 */
export type InputMsg = [number, number, number, number, number];

const JUMP = 1;
const JUMP_P = 2;
const DASH = 4;
const DASH_P = 8;
const GUARD = 16;
const FIRE_LW = 32;
const FIRE_RW = 64;
const FIRE_CW = 128;

export function packInput(seq: number, c: ControlFrame, edges: number): InputMsg {
  let b = edges;
  if (c.jump) b |= JUMP;
  if (c.dash) b |= DASH;
  if (c.guard) b |= GUARD;
  return [seq, Math.round(c.moveX * 100), Math.round(c.moveY * 100), Math.round(c.turn * 100), b];
}

/** Edge flags (one-shot presses) of a control frame as a bitmask. */
export function edgeBits(c: ControlFrame) {
  return (c.jumpPressed ? JUMP_P : 0) | (c.dashPressed ? DASH_P : 0) | (c.fireLW ? FIRE_LW : 0) | (c.fireRW ? FIRE_RW : 0) | (c.fireCW ? FIRE_CW : 0);
}

/** Apply held state from the latest message; one-shot presses come from the accumulated `edges`. */
export function unpackInput(m: InputMsg, edges: number, out: ControlFrame) {
  out.moveX = m[1] / 100;
  out.moveY = m[2] / 100;
  out.turn = m[3] / 100;
  out.jump = (m[4] & JUMP) !== 0;
  out.dash = (m[4] & DASH) !== 0;
  out.guard = (m[4] & GUARD) !== 0;
  out.jumpPressed = (edges & JUMP_P) !== 0;
  out.dashPressed = (edges & DASH_P) !== 0;
  out.fireLW = (edges & FIRE_LW) !== 0;
  out.fireRW = (edges & FIRE_RW) !== 0;
  out.fireCW = (edges & FIRE_CW) !== 0;
}

export const EDGE_MASK = JUMP_P | DASH_P | FIRE_LW | FIRE_RW | FIRE_CW;

// ------------------------------------------------------------------ state (host -> guest)

/** Mech state, positional layout (see Mech.writeNet / readNet). */
export type MechSnap = number[];
/** [id, kind, ownerIdx, x, y, z, vx, vy, vz, color] */
export type ProjSnap = number[];
/** [ownerIdx, ox, oy, oz, dx, dy, dz, length, t, duration, width] */
export type BeamSnap = number[];
/** First element names the event; the rest are its arguments. */
export type NetEvent = (string | number)[];

/** One-shot events of a snapshot sent over the real-time channel; these travel reliably on their own. */
export type EventsMsg = { ht: number; e: NetEvent[] };

// a type alias (not an interface) so it satisfies Trystero's JSON payload constraint
export type SnapMsg = {
  /** host battle clock (s) — the guest renders slightly behind it */
  ht: number;
  ph: number;
  pt: number;
  tl: number;
  rd: number;
  w: [number, number];
  rw: number;
  /** finish kind: 0 = knockout, 1 = time up */
  fk: number;
  m: MechSnap[];
  p: ProjSnap[];
  b: BeamSnap[];
  e: NetEvent[];
};

export const PHASES = ['intro', 'ready', 'fight', 'finish', 'roundEnd', 'result'] as const;
export const STATES = ['ground', 'dash', 'air', 'airdash', 'land', 'guard', 'stagger', 'down', 'getup', 'dead'] as const;
export const SLOTS = ['lw', 'rw', 'cw'] as const;
export const POSES = ['aimR', 'aimBoth', 'throwL', 'beam', 'cannon', 'missile', 'melee'] as const;
export const PROJ_KINDS = ['bolt', 'shell', 'bomb', 'hyper', 'missile'] as const;

export const r1 = (v: number) => Math.round(v * 10) / 10;
export const r2 = (v: number) => Math.round(v * 100) / 100;
export const r3 = (v: number) => Math.round(v * 1000) / 1000;

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Short, unambiguous room code (no 0/O or 1/I). */
export function makeRoomCode() {
  let s = '';
  const buf = new Uint32Array(4);
  crypto.getRandomValues(buf);
  for (const n of buf) s += CODE_ALPHABET[n % CODE_ALPHABET.length];
  return s;
}

export function normalizeCode(raw: string) {
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 4);
}

export const isValidCode = (c: string) => c.length === 4 && [...c].every((ch) => CODE_ALPHABET.includes(ch));
