/**
 * Original compositions for the procedural soundtrack (mid-90s arcade techno / eurobeat style).
 * Notation is documented in theory.ts. Every bar is 16 sixteenth-note steps.
 */
import type { SectionDef, TrackDef } from './theory';
import type { MusicTrack } from './types';

// --- Drums ------------------------------------------------------------------------------------
const NONE = '................';
const K4 = 'x...x...x...x...';
const KHALF = 'x.......x.......';
const KONE = 'x...............';
const CL = '....x.......x...';
const CL2 = '....x.......x..x';
const CLH = '........x.......';
const H_OFF = '..o...o...o...o.';
const H_OFFC = 'x.o.x.o.x.o.x.o.';
const H_16 = 'xxoxxxoxxxoxxxox';
const H_8 = 'x.x.x.x.x.x.x.x.';
const H_TICK = 'xxxxxxxxxxxxxxxx';
const H_DRIVE = 'x.xox.xox.xox.xo';
const F_SNARE = '....s...s.s.ssss';
const F_TOMS = '....s...h.h.m.l.';
const F_ROLL = 's.s.s.s.ssssSSSS';

// --- Bass riffs (semitones above the chord root) ----------------------------------------------
const B_OCT = '0 . 12 . 0 . 12 . 0 . 12 . 0 . 12 .';
const B_FUNK = '0 - . 0 12 . 0 . 7 . 0 . 12 . 7 12';
const B_FUNK2 = '0 . 12 0 . 0 12 . 0 . 12 0 . 0 12 7';
const B_ROLL = '0 0 12 0 0 12 0 0 12 0 0 12 0 0 12 0';
const B_GALLOP = '0 . 0 0 12 . 0 0 0 . 0 0 12 . 7 12';
const B_SEL = '0 0 12 0 0 0 12 0 0 0 12 0 0 0 12 0';
const B_SEL2 = '0 . 0 12 0 . 0 12 0 . 0 12 0 . 12 7';
const B_HOLD = '0 - - - - - - - 0 - - - - - - -';
const B_HOLD2 = '0 - - - - - - - 0 - - - 12 - - -';
const B_END = '0 - - - - - - - . . . . . . . .';

// --- Stabs / arps / hits -----------------------------------------------------------------------
const S_OFF = '..x...x...x...x.';
const S_SYNC = 'x..x..x...x..x..';
const S_DOT = 'x.....x.....x...';
const A_UP = '0 1 2 3 1 2 3 4 2 3 4 5 3 4 5 6';
const A_ROLL = '0 1 2 1 0 1 2 1 0 1 2 1 0 1 2 1';
const A_TICK = '3 . 3 . 3 . 3 . 3 . 3 . 3 . 3 .';
const A_WAVE = '0 2 1 3 2 4 3 5 4 3 2 1 0 2 1 3';
const A_BOUNCE = '0 . 2 . 1 . 3 . 0 . 2 . 1 . 3 .';
const O_ONE = 'x...............';

// =============================================================================================
// TITLE — D major, heroic anthem. I–bVII–IV–I verse, soaring chorus.
// =============================================================================================
const TITLE_A = [
  'D5 - - - A4 - D5 - E5 - F#5 - - - E5 -',
  'D5 - - - C5 - - - G4 - - - C5 - D5 -',
  'B4 - - - D5 - G5 - - - F#5 - E5 - D5 -',
  'F#5 - - - - - - - . . A4 - D5 - E5 -',
  'F#5 - - - D5 - B4 - D5 - F#5 - B5 - - -',
  'A5 - - - G5 - F#5 - G5 - - - D5 - - -',
  'E5 - - - F#5 - G5 - A5 - - - G5 - F#5 -',
  'E5 - - - - - - - - - - - . . . .',
];
const TITLE_B = [
  'D6 - - B5 - - G5 - A5 - B5 - - - A5 -',
  'C#6 - - A5 - - E5 - F#5 - A5 - - - E5 -',
  'F#5 - - A5 - - C#6 - - - B5 - A5 - F#5 -',
  'D6 - - - - - C#6 - B5 - - - A5 - - -',
  'D6 - - B5 - - G5 - A5 - B5 - - - D6 -',
  'E6 - - C#6 - - A5 - B5 - C#6 - - - E6 -',
  'F#6 - - - - - - - E6 - - - D6 - C#6 -',
  'D6 - - - - - - - - - - - . . . .',
];
const titleA: SectionDef = {
  name: 'A',
  bars: 8,
  chords: ['D', 'C', 'G', 'D', 'Bm', 'G', 'A', 'A'],
  crash: true,
  kick: [K4],
  clap: [CL],
  hat: [H_OFFC],
  bass: [B_OCT],
  lead: TITLE_A,
  stab: [S_OFF],
  fill: F_SNARE,
};
const titleB: SectionDef = {
  name: 'B',
  bars: 8,
  chords: ['G', 'A', 'F#m', 'Bm', 'G', 'A', 'D', 'D'],
  crash: true,
  pad: true,
  kick: [K4],
  clap: [CL],
  hat: [H_16],
  bass: [B_FUNK2],
  lead: TITLE_B,
  orch: [O_ONE, NONE, NONE, NONE],
  fill: F_TOMS,
};

// =============================================================================================
// SELECT — E minor, tense clock-tick groove with a Phrygian bII and a B-major turnaround.
// =============================================================================================
const SELECT_A = [
  'B4 - - - - - - - E5 - - - D5 - B4 -',
  'G4 - - - - - - - . . . . . . . .',
  'C5 - - - - - - - F5 - - - E5 - C5 -',
  'A4 - - - - - - - . . . . . . . .',
  'B4 - - - - - - - E5 - - - G5 - F#5 -',
  'E5 - - - - - - - . . . . B4 - E5 -',
  'F#5 - - - E5 - D5 - - - A4 - - - D5 -',
  'D#5 - - - - - - - - - - - . . . .',
];
const SELECT_B = [
  'E5 - - G5 - - C6 - - - B5 - G5 - E5 -',
  'F#5 - - A5 - - D6 - - - C6 - A5 - F#5 -',
  'G5 - - - - - - - F#5 - - - E5 - - -',
  'B4 - - - - - - - - - - - . . . .',
  'E5 - - G5 - - C6 - - - B5 - G5 - E5 -',
  'F#5 - - A5 - - D6 - - - E6 - D6 - C6 -',
  'B5 - - - - - - - A5 - - - F#5 - - -',
  'D#5 - - - - - - - - - - - . . . .',
];

// =============================================================================================
// STAGE A — A mixolydian/major, bright daytime battle theme with a tresillo hook.
// =============================================================================================
const STAGEA_A = [
  'E5 - . A5 - . C#6 - B5 - . A5 - . E5 -',
  'D5 - . G5 - . B5 - A5 - . G5 - . D5 -',
  'F#5 - . A5 - . D6 - C#6 - . A5 - . F#5 -',
  'E5 - - - - - - - . . C#5 - D5 - E5 -',
  'E5 - . A5 - . C#6 - B5 - . A5 - . E5 -',
  'D5 - . G5 - . B5 - D6 - . B5 - . G5 -',
  'A5 - - - F#5 - - - D6 - - - C#6 - - -',
  'B5 - - - - - - - G#5 - - - E5 - - -',
];
const STAGEA_B = [
  'C#5 - - - A4 - C#5 - F#5 - - - E5 - C#5 -',
  'D5 - - - - - - - A4 - - - F#4 - A4 -',
  'C#5 - - - A4 - C#5 - E5 - - - D5 - C#5 -',
  'B4 - - - - - - - . . . . E5 - G#5 -',
  'A5 - - - F#5 - A5 - C#6 - - - B5 - A5 -',
  'F#5 - - - - - - - D5 - - - F#5 - A5 -',
  'G#5 - - - - - B5 - - - E6 - - - D6 -',
  'B5 - - - - - - - - - - - - - . .',
];
const STAGEA_C = [
  'A5 - - F#5 - - A5 - B5 - - A5 - - F#5 -',
  'G#5 - - E5 - - G#5 - B5 - - G#5 - - E5 -',
  'E5 - - C#5 - - E5 - G#5 - - E5 - - C#6 -',
  'C#6 - - - - - B5 - A5 - - - G#5 - F#5 -',
  'A5 - - F#5 - - A5 - B5 - - A5 - - D6 -',
  'E6 - - - D6 - C#6 - B5 - - - G#5 - - -',
  'E6 - - - - - - - C#6 - - - B5 - - -',
  'A5 - - - - - - - - - - - . . . .',
];
const stageAA: SectionDef = {
  name: 'A',
  bars: 8,
  chords: ['A', 'G', 'D', 'A', 'A', 'G', 'D', 'E'],
  crash: true,
  kick: [K4],
  clap: [CL],
  hat: [H_OFFC],
  bass: [B_FUNK],
  lead: STAGEA_A,
  stab: [S_OFF],
  fill: F_SNARE,
};
const stageAB: SectionDef = {
  name: 'B',
  bars: 8,
  chords: ['F#m', 'D', 'A', 'E', 'F#m', 'D', 'E', 'E'],
  pad: true,
  kick: [K4],
  clap: [CL],
  hat: [H_16],
  bass: [B_OCT],
  lead: STAGEA_B,
  arp: [A_ROLL],
  fill: F_TOMS,
};
const stageAC: SectionDef = {
  name: 'C',
  bars: 8,
  chords: ['D', 'E', 'C#m', 'F#m', 'D', 'E', 'A', 'A'],
  crash: true,
  kick: [K4],
  clap: [CL2],
  hat: [H_16],
  bass: [B_FUNK2],
  lead: STAGEA_C,
  stab: [S_OFF],
  orch: [O_ONE, NONE],
  fill: F_ROLL,
};

// =============================================================================================
// STAGE B — D minor, driving dusk/industrial theme with rolling 303-ish bass.
// =============================================================================================
const STAGEB_A = [
  'D5 - - - A4 - D5 - F5 - - - E5 - D5 -',
  'F5 - - - - - D5 - Bb4 - - - D5 - F5 -',
  'G5 - - - E5 - C5 - E5 - - - G5 - A5 -',
  'A5 - - - - - - - . . . . . . . .',
  'D5 - - - A4 - D5 - F5 - - - G5 - A5 -',
  'Bb5 - - - - - A5 - G5 - - - F5 - D5 -',
  'G5 - - - Bb5 - - - D6 - - - C6 - Bb5 -',
  'C#6 - - - - - - - A5 - - - E5 - - -',
];
const STAGEB_B = [
  'D5 . D5 . G5 - . Bb5 - . A5 - G5 - F5 -',
  'F5 - - - - - E5 - D5 - - - A4 - - -',
  'D5 . D5 . F5 - . Bb5 - . C6 - Bb5 - A5 -',
  'A5 - - - - - - - C6 - - - A5 - - -',
  'Bb5 . Bb5 . A5 - . G5 - . F5 - G5 - A5 -',
  'E5 - - - - - - - C#5 - - - E5 - - -',
  'D5 - - - - - - - - - - - . . . .',
  '. . . . . . . . A4 - D5 - F5 - A5 -',
];
const STAGEB_C = [
  'D6 - - C6 - - Bb5 - A5 - - Bb5 - - C6 -',
  'E6 - - D6 - - C6 - G5 - - A5 - - Bb5 -',
  'A5 - - - - - - - F5 - - - D5 - - -',
  'A5 - - G5 - - F5 - E5 - - F5 - - G5 -',
  'D6 - - C6 - - Bb5 - A5 - - Bb5 - - D6 -',
  'E6 - - - F6 - - - G6 - - - E6 - - -',
  'C#6 - - - - - - - - - - - E6 - - -',
  'A5 - - - - - - - - - - - . . . .',
];
const stageBA: SectionDef = {
  name: 'A',
  bars: 8,
  chords: ['Dm', 'Bb', 'C', 'Dm', 'Dm', 'Bb', 'Gm', 'A'],
  crash: true,
  kick: [K4],
  clap: [CL],
  hat: [H_DRIVE],
  bass: [B_ROLL],
  lead: STAGEB_A,
  stab: [S_SYNC],
  fill: F_SNARE,
};
const stageBC: SectionDef = {
  name: 'C',
  bars: 8,
  chords: ['Bb', 'C', 'Dm', 'Dm', 'Bb', 'C', 'A', 'A'],
  crash: true,
  kick: [K4],
  clap: [CL2],
  hat: [H_16],
  bass: [B_ROLL],
  lead: STAGEB_C,
  stab: [S_SYNC],
  orch: [O_ONE, NONE, NONE, NONE],
  fill: F_ROLL,
};

export const TRACKS: Readonly<Record<MusicTrack, TrackDef>> = {
  title: {
    bpm: 138,
    loop: true,
    loopStart: 1,
    bassKind: 'fm',
    bassLow: 33,
    arpOctave: 12,
    lead: { w1: 'sawtooth', w2: 'square', detune: 8, cutoff: 4200, q: 1.5, vib: 18, level: 0.2 },
    sections: [
      {
        name: 'intro',
        bars: 4,
        chords: ['D', 'C', 'G', 'A'],
        crash: true,
        pad: true,
        kick: [NONE, NONE, K4, K4],
        hat: [NONE, NONE, H_OFF, H_OFF],
        orch: [O_ONE, NONE, NONE, NONE],
        arp: [A_ROLL],
        fill: F_ROLL,
      },
      titleA,
      titleB,
      { ...titleA, name: 'A2', hat: [H_16], arp: [A_BOUNCE] },
      { ...titleB, name: 'B2' },
      {
        name: 'break',
        bars: 4,
        chords: ['Bm', 'G', 'Em', 'A'],
        pad: true,
        hat: [NONE, NONE, H_8, H_TICK],
        bass: [B_HOLD],
        arp: [A_UP],
        arpOct: 0,
        fill: F_ROLL,
      },
    ],
  },

  select: {
    bpm: 132,
    loop: true,
    loopStart: 1,
    bassKind: 'saw',
    bassLow: 33,
    arpOctave: 0,
    lead: { w1: 'square', w2: 'triangle', detune: 6, cutoff: 3000, q: 2, vib: 14, level: 0.18 },
    sections: [
      { name: 'intro', bars: 2, chords: ['Em'], kick: [K4], hat: [H_TICK], arp: [A_TICK] },
      {
        name: 'A',
        bars: 8,
        chords: ['Em', 'Em', 'F', 'F', 'Em', 'Em', 'D', 'B'],
        crash: true,
        kick: [K4],
        clap: [CL],
        hat: [H_DRIVE],
        bass: [B_SEL],
        lead: SELECT_A,
        stab: [S_DOT],
        arp: [A_TICK],
        fill: F_SNARE,
      },
      {
        name: 'B',
        bars: 8,
        chords: ['C', 'D', 'Em', 'Em', 'C', 'D', 'B', 'B'],
        crash: true,
        pad: true,
        kick: [K4],
        clap: [CL2],
        hat: [H_16],
        bass: [B_SEL2],
        lead: SELECT_B,
        arp: [A_TICK],
        orch: [O_ONE, NONE, NONE, NONE],
        fill: F_TOMS,
      },
    ],
  },

  stageA: {
    bpm: 148,
    loop: true,
    loopStart: 1,
    bassKind: 'fm',
    bassLow: 33,
    arpOctave: 12,
    lead: { w1: 'square', w2: 'square', detune: 9, cutoff: 5000, q: 1.2, vib: 16, level: 0.18 },
    sections: [
      {
        name: 'intro',
        bars: 4,
        chords: ['A', 'G', 'D', 'A'],
        crash: true,
        kick: [K4],
        hat: [H_OFF],
        bass: [B_OCT],
        stab: [S_OFF],
        orch: [O_ONE, NONE, NONE, NONE],
        fill: F_ROLL,
      },
      stageAA,
      stageAB,
      stageAC,
      { ...stageAA, name: 'A2', hat: [H_16], arp: [A_BOUNCE] },
      { ...stageAB, name: 'B2' },
      { ...stageAC, name: 'C2' },
      {
        name: 'break',
        bars: 4,
        chords: ['F#m', 'D', 'Bm', 'E'],
        pad: true,
        hat: [NONE, NONE, H_8, H_TICK],
        bass: [B_HOLD],
        arp: [A_UP],
        arpOct: 0,
        fill: F_ROLL,
      },
    ],
  },

  stageB: {
    bpm: 144,
    loop: true,
    loopStart: 1,
    bassKind: 'saw',
    bassLow: 33,
    arpOctave: 12,
    lead: { w1: 'sawtooth', w2: 'sawtooth', detune: 12, cutoff: 3400, q: 3, vib: 20, level: 0.17 },
    sections: [
      {
        name: 'intro',
        bars: 4,
        chords: ['Dm', 'Dm', 'Bb', 'C'],
        crash: true,
        kick: [K4],
        hat: [H_TICK],
        bass: [B_ROLL],
        orch: [O_ONE, NONE, O_ONE, 'x.......x.......'],
        fill: F_TOMS,
      },
      stageBA,
      {
        name: 'B',
        bars: 8,
        chords: ['Gm', 'Dm', 'Bb', 'F', 'Gm', 'A', 'Dm', 'Dm'],
        pad: true,
        kick: [K4],
        clap: [CL],
        hat: [H_16],
        bass: [B_GALLOP],
        lead: STAGEB_B,
        fill: F_TOMS,
      },
      stageBC,
      { ...stageBA, name: 'A2', arp: [A_WAVE], arpOct: 0 },
      { ...stageBC, name: 'C2' },
      {
        name: 'break',
        bars: 4,
        chords: ['Dm', 'Bb', 'Gm', 'A'],
        pad: true,
        kick: [KHALF],
        clap: [CLH],
        bass: [B_HOLD2],
        arp: [A_WAVE],
        arpOct: 0,
        fill: F_ROLL,
      },
    ],
  },

  victory: {
    bpm: 160,
    loop: false,
    loopStart: 0,
    bassKind: 'fm',
    bassLow: 36,
    arpOctave: 12,
    lead: { w1: 'sawtooth', w2: 'square', detune: 8, cutoff: 4800, q: 1.2, vib: 18, level: 0.22 },
    sections: [
      {
        name: 'fanfare',
        bars: 2,
        chords: ['C', 'F|G'],
        crash: true,
        kick: [K4],
        clap: [CL],
        hat: [H_OFF],
        bass: [B_OCT],
        lead: ['G4 - C5 - E5 - G5 - - - E5 - G5 - C6 -', 'A5 - - - C6 - - - B5 - - - D6 - - -'],
        stab: [S_OFF],
        fill: '....s.......ssSS',
      },
      {
        name: 'end',
        bars: 1,
        chords: ['C'],
        crash: true,
        pad: true,
        kick: [KONE],
        orch: [O_ONE],
        bass: [B_END],
        lead: ['C6 - - - - - - - - - - - - - - -'],
      },
    ],
  },

  defeat: {
    bpm: 128,
    loop: false,
    loopStart: 0,
    bassKind: 'fm',
    bassLow: 33,
    arpOctave: 12,
    lead: { w1: 'triangle', w2: 'square', detune: 6, cutoff: 2400, q: 1, vib: 22, level: 0.2 },
    sections: [
      {
        name: 'lament',
        bars: 2,
        chords: ['Am|F', 'E|Am'],
        pad: true,
        kick: [KONE, KONE],
        bass: [B_HOLD],
        lead: ['E5 - - - D5 - - - C5 - - - B4 - - -', 'B4 - - - G#4 - - - A4 - - - - - - -'],
      },
    ],
  },
};
