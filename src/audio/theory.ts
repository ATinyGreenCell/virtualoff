/**
 * Pure music helpers and the track mini-language parser.
 * No DOM / WebAudio dependencies, so it can be validated in plain Node.
 *
 * Track data is written as 16-step bars:
 *  - rhythm rows: 16 chars, e.g. 'x...x...x...x...'  ('.' rest, '-' hold previous hit)
 *  - note rows:   16 space-separated tokens, e.g. 'E5 - . A5 - . C#6 - B5 - . A5 - . E5 -'
 *                 ('.' rest, '-' hold previous note, otherwise a note name)
 *  - int rows:    same as note rows but tokens are integers (bass semitone offsets from the
 *                 chord root, or chord-tone indices for arpeggios)
 */

export const STEPS_PER_BAR = 16;

export type Wave = 'sine' | 'square' | 'sawtooth' | 'triangle';

export function mtof(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

const LETTER_PC: Readonly<Record<string, number>> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** 'C4' -> 60, 'F#5' -> 78, 'Bb3' -> 58. Returns null when the token is not a note. */
export function parseNote(tok: string): number | null {
  const m = /^([A-G])([#b]?)(-?\d)$/.exec(tok);
  if (!m) return null;
  let pc = LETTER_PC[m[1]];
  if (m[2] === '#') pc += 1;
  else if (m[2] === 'b') pc -= 1;
  return 12 * (Number(m[3]) + 1) + pc;
}

const QUALITIES: Readonly<Record<string, readonly number[]>> = {
  '': [0, 4, 7],
  m: [0, 3, 7],
  '5': [0, 7],
  '6': [0, 4, 7, 9],
  m6: [0, 3, 7, 9],
  '7': [0, 4, 7, 10],
  m7: [0, 3, 7, 10],
  maj7: [0, 4, 7, 11],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  add9: [0, 4, 7, 14],
  madd9: [0, 3, 7, 14],
  dim: [0, 3, 6],
  aug: [0, 4, 8],
};

export interface Chord {
  /** Root pitch class 0..11. */
  readonly root: number;
  /** Semitone intervals above the root (first is always 0). */
  readonly tones: readonly number[];
}

export function parseChord(sym: string): Chord | null {
  const m = /^([A-G])([#b]?)(.*)$/.exec(sym);
  if (!m) return null;
  const tones = QUALITIES[m[3]];
  if (!tones) return null;
  let pc = LETTER_PC[m[1]];
  if (m[2] === '#') pc += 1;
  else if (m[2] === 'b') pc -= 1;
  return { root: ((pc % 12) + 12) % 12, tones };
}

/** Lowest MIDI note >= `low` whose pitch class is the chord root. */
export function rootAbove(ch: Chord, low: number): number {
  return low + ((ch.root - (low % 12) + 12) % 12);
}

/** Close-position voicing of the chord starting at the first root >= `low`. */
export function voiceChord(ch: Chord, low: number): number[] {
  const r = rootAbove(ch, low);
  return ch.tones.map((i) => r + i);
}

/** One parsed step: an event starting here, lasting `len` steps. */
export interface StepEvent {
  readonly len: number;
  /** MIDI note, semitone offset, chord-tone index or hit code depending on the row type. */
  readonly v: number;
}
export type StepRow = ReadonlyArray<StepEvent | null>;

/** Hit codes used by rhythm rows. */
export const HIT = {
  hit: 1,
  accent: 2,
  open: 3,
  snare: 11,
  snareAccent: 12,
  tomLow: 13,
  tomMid: 14,
  tomHigh: 15,
  clap: 16,
} as const;

const HIT_CODES: Readonly<Record<string, number>> = {
  x: HIT.hit,
  X: HIT.accent,
  o: HIT.open,
  s: HIT.snare,
  S: HIT.snareAccent,
  l: HIT.tomLow,
  m: HIT.tomMid,
  h: HIT.tomHigh,
  c: HIT.clap,
};

function holdLen(next: (i: number) => string, i: number): number {
  let len = 1;
  while (i + len < STEPS_PER_BAR && next(i + len) === '-') len++;
  return len;
}

/** Parse a 16-char rhythm row. `allowed` lists the hit characters valid for this row type. */
export function parseHits(pattern: string, allowed: string): StepRow {
  if (pattern.length !== STEPS_PER_BAR) {
    throw new Error(`rhythm "${pattern}" has ${pattern.length} steps (want ${STEPS_PER_BAR})`);
  }
  if (pattern[0] === '-') throw new Error(`rhythm "${pattern}" starts with a hold`);
  const row: (StepEvent | null)[] = [];
  for (let i = 0; i < STEPS_PER_BAR; i++) {
    const ch = pattern[i];
    if (ch === '.' || ch === '-') {
      row.push(null);
      continue;
    }
    if (!allowed.includes(ch)) {
      throw new Error(`rhythm "${pattern}": '${ch}' not allowed here (allowed: "${allowed}")`);
    }
    row.push({ len: holdLen((k) => pattern[k], i), v: HIT_CODES[ch] });
  }
  return row;
}

/** Parse a 16-token note row ('note') or integer row ('int'). */
export function parseLine(line: string, kind: 'note' | 'int'): StepRow {
  const toks = line.trim().split(/\s+/);
  if (toks.length !== STEPS_PER_BAR) {
    throw new Error(`line "${line}" has ${toks.length} steps (want ${STEPS_PER_BAR})`);
  }
  if (toks[0] === '-') throw new Error(`line "${line}" starts with a tie (ties across bars are not supported)`);
  const row: (StepEvent | null)[] = [];
  for (let i = 0; i < STEPS_PER_BAR; i++) {
    const tk = toks[i];
    if (tk === '.' || tk === '-') {
      row.push(null);
      continue;
    }
    const v = kind === 'note' ? parseNote(tk) : /^-?\d+$/.test(tk) ? Number(tk) : null;
    if (v === null) throw new Error(`line "${line}": bad token '${tk}'`);
    row.push({ len: holdLen((k) => toks[k], i), v });
  }
  return row;
}

// ---------------------------------------------------------------------------------------------
// Track definitions
// ---------------------------------------------------------------------------------------------

export interface LeadPreset {
  readonly w1: Wave;
  readonly w2: Wave;
  /** Detune of the second oscillator, cents. */
  readonly detune: number;
  readonly cutoff: number;
  readonly q: number;
  /** Vibrato depth, cents. */
  readonly vib: number;
  readonly level: number;
}

export interface SectionDef {
  readonly name: string;
  readonly bars: number;
  /** One chord symbol per bar (cycled). 'F|G' splits a bar into halves. */
  readonly chords: readonly string[];
  readonly kick?: readonly string[];
  readonly clap?: readonly string[];
  /** 'x' closed, 'X' accented closed, 'o' open. */
  readonly hat?: readonly string[];
  /** Extra percussion: s/S snare, l/m/h toms, c clap. */
  readonly perc?: readonly string[];
  /** Replaces clap/hat/perc on the last bar of the section (same chars as perc). */
  readonly fill?: string;
  /** Crash cymbal on the first step of the section. */
  readonly crash?: boolean;
  /** Semitone offsets from the chord root (int rows). */
  readonly bass?: readonly string[];
  readonly lead?: readonly string[];
  /** Chord stabs: 'x'/'X' with '-' holds. */
  readonly stab?: readonly string[];
  /** Chord-tone indices (int rows); index >= chord size wraps up an octave. */
  readonly arp?: readonly string[];
  /** Override of the track's arp octave shift (semitones). */
  readonly arpOct?: number;
  readonly orch?: readonly string[];
  /** Sustained pad chord for each chord of each bar. */
  readonly pad?: boolean;
}

export interface TrackDef {
  readonly bpm: number;
  readonly loop: boolean;
  /** Section index to jump back to when looping. */
  readonly loopStart: number;
  readonly bassKind: 'fm' | 'saw';
  /** Lowest MIDI note for the bass root. */
  readonly bassLow: number;
  /** Semitones added to arpeggio notes (voiced from C4 upwards). */
  readonly arpOctave: number;
  readonly lead: LeadPreset;
  readonly sections: readonly SectionDef[];
}

export interface ParsedSection {
  readonly name: string;
  readonly bars: number;
  readonly chords: ReadonlyArray<readonly Chord[]>;
  readonly kick: readonly StepRow[];
  readonly clap: readonly StepRow[];
  readonly hat: readonly StepRow[];
  readonly perc: readonly StepRow[];
  readonly fill: StepRow | null;
  readonly crash: boolean;
  readonly bass: readonly StepRow[];
  readonly lead: readonly StepRow[];
  readonly stab: readonly StepRow[];
  readonly arp: readonly StepRow[];
  readonly arpOct: number;
  readonly orch: readonly StepRow[];
  readonly pad: boolean;
}

export interface ParsedTrack {
  readonly bpm: number;
  readonly stepDur: number;
  readonly loop: boolean;
  readonly loopStart: number;
  readonly bassKind: 'fm' | 'saw';
  readonly bassLow: number;
  readonly lead: LeadPreset;
  readonly sections: readonly ParsedSection[];
  readonly totalBars: number;
}

const PERC_CHARS = 'sSlmhc';

function parseRows(
  where: string,
  rows: readonly string[] | undefined,
  parse: (r: string) => StepRow,
): StepRow[] {
  if (!rows) return [];
  return rows.map((r, i) => {
    try {
      return parse(r);
    } catch (e) {
      throw new Error(`${where}[${i}]: ${(e as Error).message}`);
    }
  });
}

/** Parse + validate a track. Throws a descriptive Error on any malformed data. */
export function parseTrack(name: string, def: TrackDef): ParsedTrack {
  if (!(def.bpm > 0)) throw new Error(`${name}: bad bpm`);
  if (def.sections.length === 0) throw new Error(`${name}: no sections`);
  if (def.loopStart < 0 || def.loopStart >= def.sections.length) throw new Error(`${name}: bad loopStart`);
  const sections = def.sections.map((s, si): ParsedSection => {
    const w = `${name}.${s.name || si}`;
    if (!(s.bars >= 1) || !Number.isInteger(s.bars)) throw new Error(`${w}: bad bar count`);
    if (s.chords.length === 0) throw new Error(`${w}: no chords`);
    const chords = s.chords.map((sym, i) => {
      const parts = sym.split('|');
      if (parts.length > 2 && parts.length !== 4) throw new Error(`${w}.chords[${i}]: split into 1, 2 or 4 parts`);
      return parts.map((p) => {
        const c = parseChord(p.trim());
        if (!c) throw new Error(`${w}.chords[${i}]: bad chord '${p}'`);
        return c;
      });
    });
    let fill: StepRow | null = null;
    if (s.fill !== undefined) {
      try {
        fill = parseHits(s.fill, PERC_CHARS);
      } catch (e) {
        throw new Error(`${w}.fill: ${(e as Error).message}`);
      }
    }
    return {
      name: s.name,
      bars: s.bars,
      chords,
      kick: parseRows(`${w}.kick`, s.kick, (r) => parseHits(r, 'xX')),
      clap: parseRows(`${w}.clap`, s.clap, (r) => parseHits(r, 'xX')),
      hat: parseRows(`${w}.hat`, s.hat, (r) => parseHits(r, 'xXo')),
      perc: parseRows(`${w}.perc`, s.perc, (r) => parseHits(r, PERC_CHARS)),
      fill,
      crash: s.crash === true,
      bass: parseRows(`${w}.bass`, s.bass, (r) => parseLine(r, 'int')),
      lead: parseRows(`${w}.lead`, s.lead, (r) => parseLine(r, 'note')),
      stab: parseRows(`${w}.stab`, s.stab, (r) => parseHits(r, 'xX')),
      arp: parseRows(`${w}.arp`, s.arp, (r) => parseLine(r, 'int')),
      arpOct: s.arpOct ?? def.arpOctave,
      orch: parseRows(`${w}.orch`, s.orch, (r) => parseHits(r, 'xX')),
      pad: s.pad === true,
    };
  });
  return {
    bpm: def.bpm,
    stepDur: 60 / def.bpm / 4,
    loop: def.loop,
    loopStart: def.loopStart,
    bassKind: def.bassKind,
    bassLow: def.bassLow,
    lead: def.lead,
    sections,
    totalBars: sections.reduce((n, s) => n + s.bars, 0),
  };
}

/** Soft checks (row arrays that don't cycle evenly over their section, etc.). */
export function lintTrack(name: string, def: TrackDef): string[] {
  const out: string[] = [];
  for (const s of def.sections) {
    const fields = ['chords', 'kick', 'clap', 'hat', 'perc', 'bass', 'lead', 'stab', 'arp', 'orch'] as const;
    for (const f of fields) {
      const arr = s[f];
      if (arr && arr.length > 0 && s.bars % arr.length !== 0) {
        out.push(`${name}.${s.name}.${f}: ${arr.length} rows don't cycle evenly over ${s.bars} bars`);
      }
    }
  }
  return out;
}

/** The chord sounding at `step` of bar `bar` within a section. */
export function chordAt(sec: ParsedSection, bar: number, step: number): Chord {
  const parts = sec.chords[bar % sec.chords.length];
  const idx = Math.min(parts.length - 1, Math.floor((step * parts.length) / STEPS_PER_BAR));
  return parts[idx];
}

/** Row for bar `bar`, cycling through the list; undefined when the list is empty. */
export function rowAt(rows: readonly StepRow[], bar: number): StepRow | undefined {
  return rows.length ? rows[bar % rows.length] : undefined;
}
