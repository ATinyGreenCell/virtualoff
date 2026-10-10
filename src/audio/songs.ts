/**
 * The soundtrack — original compositions in the spirit of mid-90s Sega arcade techno:
 * four-on-the-floor drums, sidechained supersaw pads, funky or acid basslines, synth brass and
 * catchy leads. Melodies put chord tones on the strong beats; sections build and drop.
 */
import type { MusicTrack } from './types';
import type { Section, Song } from './sequencer';

// ---------------------------------------------------------------- shared drum patterns
const K4 = 'x...x...x...x...';
const CLAP = '....x.......x...';
const OHAT = '..x...x...x...x.';
const HAT16 = 'xoxoxoxoxoxoxoxo';
const CRASH = 'X...............';
const ROLL = ['x...x...x...x...', 'x.x.x.x.xxxxXXXX'];
const FILL = 'o.o.x.x.xxxxXXXX';

const bars = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);

// ================================================================= TITLE — "Virtual Skies"
// uplifting trance-house, A minor, 128 BPM

const titleProg = ['Am', 'F', 'C', 'G', 'Am', 'F', 'C', 'E'];

const titleHook = [
  '0:E5:3 3:E5:3 6:D5:2 8:E5:3 11:G5:3 14:E5:2',
  '0:F5:3 3:E5:3 6:C5:2 8:A4:4 12:C5:4',
  '0:G5:3 3:G5:3 6:E5:2 8:G5:3 11:C6:3 14:B5:2',
  '0:B5:3 3:A5:3 6:G5:2 8:D5:6 14:E5:2',
  '0:E5:3 3:E5:3 6:D5:2 8:E5:3 11:G5:3 14:A5:2',
  '0:C6:3 3:A5:3 6:F5:2 8:A5:4 12:C6:4',
  '0:G5:3 3:E5:3 6:C5:2 8:E5:3 11:G5:3 14:E5:2',
  '0:G#5:4 4:B5:4 8:E5:8',
];

const titleCalm = [
  '0:E5:8 8:C5:8',
  '0:F5:8 8:A4:8',
  '0:G5:8 8:E5:8',
  '0:D5:16',
  '0:E5:8 8:G5:8',
  '0:A5:8 8:F5:8',
  '0:G5:8 8:C5:8',
  '0:B4:16',
];

const titleDrop = (): Section => ({
  bars: 16,
  chords: titleProg,
  parts: {
    kick: { drum: K4 },
    clap: { drum: CLAP },
    hat: { drum: HAT16, vel: 0.55 },
    ohat: { drum: OHAT },
    crash: { drum: CRASH, only: [0, 8] },
    snare: { drum: FILL, only: [15] },
    bass: { bass: [[2, 0, 2], [6, 0, 2], [10, 0, 2], [14, 0, 2]], oct: 2 },
    sub: { bass: [[2, 0, 2], [6, 0, 2], [10, 0, 2], [14, 0, 2]], oct: 1 },
    pad: { chords: [[0, 16]], lo: 52, hi: 69 },
    arp: { arp: [0, 1, 2, 1, 3, 1, 2, 1, 0, 1, 2, 1, 3, 1, 2, 1], lo: 64, hi: 84, vel: 0.8 },
    lead: { notes: titleHook },
  },
});

const title: Song = {
  bpm: 128,
  loop: true,
  loopFrom: 1,
  delay: 3,
  channels: {
    kick: { inst: 'kick', gain: 0.9 },
    clap: { inst: 'clap', gain: 0.57, rev: 0.15 },
    hat: { inst: 'hat', gain: 0.77, pan: 0.3 },
    ohat: { inst: 'ohat', gain: 0.35, pan: -0.3 },
    snare: { inst: 'snare', gain: 0.29, rev: 0.1 },
    crash: { inst: 'crash', gain: 0.22, rev: 0.2 },
    fx: { inst: 'riser', gain: 0.24 },
    bass: { inst: 'bass', gain: 0.84, pump: 1, rel: 0.04 },
    sub: { inst: 'sub', gain: 0.39, pump: 1, rel: 0.05 },
    pad: { inst: 'pad', gain: 0.33, rev: 0.4, pump: 2, rel: 0.5 },
    arp: { inst: 'pluck', gain: 0.45, pan: 0.35, rev: 0.25, dly: 0.35, pump: 2, rel: 0.05 },
    lead: { inst: 'lead', gain: 0.55, rev: 0.3, dly: 0.2, pump: 1, rel: 0.12 },
    piano: { inst: 'piano', gain: 0.46, rev: 0.35, rel: 0.3 },
    bell: { inst: 'bell', gain: 0.43, rev: 0.4, dly: 0.35, rel: 0.4 },
  },
  sections: [
    // intro: pads and a filtered arp opening up, sparkle bells, riser into the drop
    {
      bars: 8,
      chords: titleProg,
      parts: {
        pad: { chords: [[0, 16]], lo: 52, hi: 69, vel: 0.9 },
        arp: { arp: [0, 1, 2, 1, 3, 1, 2, 1, 0, 1, 2, 1, 3, 1, 2, 1], lo: 64, hi: 84, vel: 0.7 },
        bell: {
          notes: ['0:E6:6 8:A5:6', '0:C6:6 8:F5:6', '0:G6:6 8:E6:6', '0:D6:6 8:B5:6', '0:E6:6 8:C6:6', '0:A5:6 8:C6:6', '0:G5:6 8:E6:6', '0:G#5:6 8:B5:6'],
        },
        fx: { drum: CRASH, only: [6] },
        snare: { drum: ROLL, only: [6, 7], vel: 0.8 },
      },
      auto: [{ p: 'lp', from: 900, to: 18000, bars: 8 }],
    },
    titleDrop(),
    // breakdown: piano and a calm lead over the pads, then the build
    {
      bars: 8,
      chords: titleProg,
      parts: {
        pad: { chords: [[0, 16]], lo: 52, hi: 69 },
        piano: { chords: [[0, 4], [6, 2], [8, 4], [14, 2]], lo: 57, hi: 76, vel: 0.9 },
        lead: { notes: titleCalm, vel: 0.65 },
        bass: { bass: [[0, 0, 16]], oct: 1, only: bars(0, 6) },
        fx: { drum: CRASH, only: [6] },
        snare: { drum: ROLL, only: [6, 7] },
        kick: { drum: 'x...x...x...x...', only: [7], vel: 0.7 },
      },
      auto: [
        { p: 'hp', from: 20, to: 20, bars: 0 },
        { p: 'hp', from: 20, to: 700, at: 6, bars: 2 },
      ],
    },
    {
      ...titleDrop(),
      parts: {
        ...titleDrop().parts,
        bass: { bass: [[2, 0, 1], [3, 0, 1], [6, 0, 1], [7, 0, 1], [10, 0, 1], [11, 0, 1], [14, 0, 1], [15, 12, 1]], oct: 2 },
        lead: { notes: titleHook, tr: 0 },
        bell: { notes: titleHook, tr: 12, vel: 0.35, only: bars(8, 16) },
      },
      auto: [{ p: 'hp', from: 20, to: 20, bars: 0 }],
    },
  ],
};

// ================================================================= SELECT — "Pilot Registration"
// tense minimal groove, E minor, 120 BPM

const select: Song = {
  bpm: 120,
  loop: true,
  delay: 3,
  channels: {
    kick: { inst: 'kick', gain: 0.85 },
    hat: { inst: 'hat', gain: 0.79, pan: 0.3 },
    perc: { inst: 'perc', gain: 0.74, pan: -0.45, rev: 0.15 },
    clap: { inst: 'clap', gain: 0.59, rev: 0.25 },
    bass: { inst: 'bass', gain: 0.63, pump: 1, rel: 0.03 },
    stab: { inst: 'stab', gain: 0.57, rev: 0.25, dly: 0.3, pump: 2, rel: 0.05 },
    arp: { inst: 'pluck', gain: 0.55, pan: 0.35, dly: 0.4, rev: 0.2, pump: 2, rel: 0.04 },
    pad: { inst: 'choir', gain: 0.46, rev: 0.4, pump: 2, rel: 0.5 },
    lead: { inst: 'squareLead', gain: 0.47, rev: 0.25, dly: 0.25, rel: 0.08 },
  },
  sections: [
    {
      bars: 16,
      chords: ['Em', 'Em', 'Cmaj7', 'B7'],
      parts: {
        kick: { drum: 'x.....x...x.....' },
        hat: { drum: HAT16, vel: 0.5 },
        perc: { drum: '....x.......x..o', vel: 0.7 },
        clap: { drum: '............x...', only: bars(8, 16), vel: 0.7 },
        bass: { bass: [[0, 0, 2], [2, 0, 2], [4, 12, 2], [6, 0, 2], [8, 0, 2], [10, 0, 2], [12, 12, 2], [14, 7, 2]], oct: 2 },
        stab: { chords: [[0, 2], [6, 2], [11, 3]], lo: 59, hi: 76, vel: 0.7, only: bars(4, 16) },
        arp: { arp: [0, 2, 1, 3, 2, 1, 3, 2, 0, 2, 1, 3, 2, 1, 3, 2], lo: 71, hi: 88, vel: 0.45 },
        pad: { chords: [[0, 16]], lo: 52, hi: 67, vel: 0.6, only: bars(8, 16) },
        lead: {
          notes: [
            '0:B4:6 6:G4:2 8:E5:6 14:D5:2',
            '0:B4:12 12:G4:4',
            '0:G5:6 6:E5:2 8:B4:6 14:C5:2',
            '0:B4:6 6:D#5:2 8:F#5:6 14:A5:2',
            '0:B4:6 6:G4:2 8:E5:6 14:F#5:2',
            '0:G5:12 12:E5:4',
            '0:E5:6 6:G5:2 8:B5:6 14:A5:2',
            '0:F#5:8 8:D#5:8',
          ],
          only: bars(8, 16),
        },
      },
    },
  ],
};

// ================================================================= STAGE A — "Harbor Showdown"
// bright, funky Sega techno-house, D mixolydian, 142 BPM

const harborA = ['D', 'C', 'G', 'A'];
const harborB = ['Bm', 'G', 'D', 'A', 'Bm', 'G', 'Em', 'A'];
const harborBreak = ['G', 'A', 'Bm', 'Bm', 'G', 'A', 'D', 'A'];

const FUNK: [number, number, number][] = [
  [0, 0, 2],
  [3, 12, 1],
  [4, 0, 1],
  [6, 12, 1],
  [8, 0, 1],
  [10, 12, 1],
  [11, 0, 1],
  [13, 7, 1],
  [14, 12, 1],
];

const harborHook = [
  '0:F#5:2 2:A5:2 4:D6:3 7:C#6:1 8:D6:2 10:A5:2 12:F#5:4',
  '0:E5:2 2:G5:2 4:C6:3 7:B5:1 8:C6:2 10:G5:2 12:E5:4',
  '0:D5:2 2:G5:2 4:B5:3 7:A5:1 8:B5:2 10:D6:2 12:B5:4',
  '0:C#6:3 3:B5:1 4:A5:2 6:E5:2 8:A5:6 14:G5:2',
  '0:F#5:2 2:A5:2 4:D6:3 7:C#6:1 8:D6:2 10:A5:2 12:F#5:4',
  '0:E5:2 2:G5:2 4:C6:3 7:B5:1 8:C6:2 10:G5:2 12:E5:4',
  '0:D6:2 2:B5:2 4:G5:2 6:B5:2 8:D6:3 11:E6:3 14:D6:2',
  '0:C#6:4 4:E6:4 8:A5:8',
];

const harborSong = [
  '0:D6:6 6:C#6:2 8:B5:4 12:F#5:4',
  '0:G5:6 6:A5:2 8:B5:4 12:D6:4',
  '0:A5:6 6:F#5:2 8:D5:4 12:F#5:4',
  '0:E5:8 8:C#6:4 12:E6:4',
  '0:F#6:6 6:E6:2 8:D6:4 12:B5:4',
  '0:D6:6 6:B5:2 8:G5:4 12:B5:4',
  '0:E6:4 4:D6:2 6:B5:2 8:G5:4 12:B5:4',
  '0:C#6:4 4:E6:4 8:A6:6 14:G6:2',
];

const harborDrums = {
  kick: { drum: K4 },
  clap: { drum: CLAP },
  hat: { drum: HAT16, vel: 0.5 },
  ohat: { drum: OHAT, vel: 0.9 },
  crash: { drum: CRASH, only: [0, 8] },
  snare: { drum: FILL, only: [15] },
};

const stageA: Song = {
  bpm: 142,
  loop: true,
  loopFrom: 1,
  delay: 3,
  channels: {
    kick: { inst: 'kick', gain: 0.9 },
    clap: { inst: 'clap', gain: 0.57, rev: 0.12 },
    hat: { inst: 'hat', gain: 0.8, pan: 0.3 },
    ohat: { inst: 'ohat', gain: 0.38, pan: -0.3 },
    perc: { inst: 'perc', gain: 0.66, pan: 0.45, rev: 0.12 },
    crash: { inst: 'crash', gain: 0.25, rev: 0.2 },
    snare: { inst: 'snare', gain: 0.27, rev: 0.1 },
    fx: { inst: 'riser', gain: 0.24 },
    bass: { inst: 'bassFunk', gain: 0.92, pump: 1, rel: 0.03 },
    brass: { inst: 'brass', gain: 0.27, rev: 0.2, pan: -0.1, rel: 0.08 },
    piano: { inst: 'piano', gain: 0.54, rev: 0.25, pan: 0.15, rel: 0.15 },
    pad: { inst: 'pad', gain: 0.26, rev: 0.35, pump: 2, rel: 0.4 },
    lead: { inst: 'squareLead', gain: 0.47, rev: 0.22, dly: 0.18, rel: 0.06 },
    lead2: { inst: 'lead', gain: 0.5, rev: 0.3, dly: 0.2, pump: 1, rel: 0.1 },
    bell: { inst: 'bell', gain: 0.55, rev: 0.35, dly: 0.3, rel: 0.3 },
  },
  sections: [
    {
      bars: 8,
      chords: harborA,
      parts: {
        kick: { drum: K4 },
        hat: { drum: HAT16, vel: 0.5, only: bars(4, 8) },
        crash: { drum: CRASH, only: [0] },
        bass: { bass: FUNK, oct: 2 },
        fx: { drum: CRASH, only: [6] },
        snare: { drum: ROLL, only: [6, 7], vel: 0.8 },
      },
      auto: [{ p: 'lp', from: 1200, to: 18000, bars: 8 }],
    },
    {
      bars: 16,
      chords: harborA,
      parts: {
        ...harborDrums,
        perc: { drum: '..x..x....x..x..', vel: 0.6, only: bars(8, 16) },
        bass: { bass: FUNK, oct: 2 },
        brass: [
          { chords: [[0, 2], [3, 2], [6, 3], [10, 2], [12, 3]], lo: 62, hi: 79, only: bars(0, 8) },
          { chords: [[0, 2], [6, 3], [12, 3]], lo: 62, hi: 79, only: bars(8, 16), vel: 0.8 },
        ],
        pad: { chords: [[0, 16]], lo: 54, hi: 69, vel: 0.7 },
        lead: { notes: harborHook },
      },
    },
    {
      bars: 16,
      chords: harborB,
      parts: {
        ...harborDrums,
        bass: { bass: FUNK, oct: 2 },
        piano: { chords: [[2, 2], [6, 2], [10, 2], [14, 2]], lo: 59, hi: 76, vel: 0.85 },
        pad: { chords: [[0, 16]], lo: 54, hi: 69, vel: 0.8 },
        lead2: { notes: harborSong, tr: -12 },
        bell: { notes: harborSong, only: bars(8, 16), vel: 0.4 },
      },
    },
    {
      bars: 8,
      chords: harborBreak,
      parts: {
        pad: { chords: [[0, 16]], lo: 54, hi: 69 },
        piano: { chords: [[0, 8], [8, 8]], lo: 59, hi: 76, vel: 0.8 },
        lead: { notes: harborHook, vel: 0.55, only: bars(0, 4) },
        bass: { bass: [[0, 0, 8], [8, 0, 8]], oct: 2, only: bars(0, 6), vel: 0.7 },
        fx: { drum: CRASH, only: [6] },
        snare: { drum: ROLL, only: [6, 7] },
      },
      auto: [
        { p: 'hp', from: 20, to: 20, bars: 0 },
        { p: 'hp', from: 20, to: 650, at: 6, bars: 2 },
      ],
    },
    {
      bars: 16,
      chords: harborA,
      parts: {
        ...harborDrums,
        perc: { drum: '..x..x....x..x..', vel: 0.6 },
        bass: { bass: FUNK, oct: 2 },
        brass: { chords: [[0, 2], [3, 2], [6, 3], [10, 2], [12, 3]], lo: 62, hi: 79 },
        pad: { chords: [[0, 16]], lo: 54, hi: 69, vel: 0.7 },
        lead: { notes: harborHook },
        lead2: { notes: harborHook, tr: -12, vel: 0.7 },
      },
      auto: [{ p: 'hp', from: 20, to: 20, bars: 0 }],
    },
  ],
};

// ================================================================= STAGE B — "Dusk Foundry"
// dark driving acid techno, F minor, 146 BPM

const foundryA = ['Fm', 'Fm', 'Db', 'Eb'];
const foundryB = ['Bbm', 'Fm', 'Db', 'C'];

const ACID: [number, number, number, number][] = [
  [0, 0, 1, 2],
  [1, 0, 1, 0],
  [2, 12, 1, 1],
  [3, 0, 1, 0],
  [4, 0, 1, 2],
  [5, 10, 1, 0],
  [6, 12, 1, 1],
  [7, 0, 1, 0],
  [8, 0, 1, 2],
  [9, 0, 1, 0],
  [10, 15, 1, 1],
  [11, 12, 1, 0],
  [12, 0, 1, 2],
  [13, 7, 1, 0],
  [14, 10, 1, 1],
  [15, 12, 1, 0],
];
const ACID_SAMPLES = ['acid1', 'acid2', 'acid3'];

const foundryHook = [
  '0:C6:3 3:Ab5:3 6:F5:2 8:Ab5:2 10:G5:2 12:F5:4',
  '0:Db6:3 3:C6:3 6:Ab5:2 8:F5:6 14:G5:2',
  '0:Ab5:3 3:F5:3 6:Db5:2 8:F5:2 10:Ab5:2 12:Db6:4',
  '0:Eb6:3 3:Db6:3 6:Bb5:2 8:G5:6 14:Bb5:2',
  '0:C6:3 3:Ab5:3 6:F5:2 8:Ab5:2 10:G5:2 12:F5:4',
  '0:F6:3 3:Eb6:3 6:C6:2 8:Ab5:6 14:G5:2',
  '0:F5:3 3:Ab5:3 6:Db6:2 8:Db6:2 10:C6:2 12:Ab5:4',
  '0:G5:4 4:Bb5:4 8:Eb6:8',
];

const foundrySong = [
  '0:F5:4 4:Db6:4 8:Bb5:4 12:F5:4',
  '0:Ab5:4 4:C6:4 8:F6:4 12:Eb6:2 14:C6:2',
  '0:Db6:6 6:C6:2 8:Ab5:4 12:F5:4',
  '0:E5:4 4:G5:4 8:C6:4 12:Bb5:2 14:G5:2',
  '0:Bb5:4 4:F6:4 8:Db6:4 12:Bb5:4',
  '0:C6:4 4:Ab5:4 8:F5:4 12:Ab5:2 14:C6:2',
  '0:F6:6 6:Eb6:2 8:Db6:4 12:Ab5:4',
  '0:G5:4 4:C6:4 8:E6:8',
];

const foundryDrums = {
  kick: { drum: K4 },
  clap: { drum: CLAP },
  hat: { drum: HAT16, vel: 0.5 },
  ohat: { drum: OHAT, vel: 0.85 },
  perc: { drum: '..x..x..x..x.x..', vel: 0.5 },
  crash: { drum: CRASH, only: [0, 8] },
};

const stageB: Song = {
  bpm: 146,
  loop: true,
  loopFrom: 1,
  delay: 3,
  channels: {
    kick: { inst: 'kick', gain: 0.95 },
    clap: { inst: 'clap', gain: 0.52, rev: 0.15 },
    hat: { inst: 'hat', gain: 0.75, pan: 0.3 },
    ohat: { inst: 'ohat', gain: 0.42, pan: -0.3 },
    perc: { inst: 'perc', gain: 0.65, pan: -0.45, rev: 0.15 },
    tom: { inst: 'tom', gain: 0.36, rev: 0.1 },
    crash: { inst: 'crash', gain: 0.26, rev: 0.2 },
    snare: { inst: 'snare', gain: 0.28, rev: 0.1 },
    fx: { inst: 'riser', gain: 0.25 },
    boom: { inst: 'impact', gain: 0.44 },
    acid: { inst: 'acid2', gain: 0.94, pump: 1, rel: 0.02, dly: 0.08 },
    sub: { inst: 'sub', gain: 0.36, pump: 1, rel: 0.05 },
    stab: { inst: 'stab', gain: 0.39, rev: 0.25, dly: 0.2, pump: 2, rel: 0.05 },
    choir: { inst: 'choir', gain: 0.31, rev: 0.4, pump: 2, rel: 0.5 },
    lead: { inst: 'lead', gain: 0.53, rev: 0.28, dly: 0.2, pump: 1, rel: 0.1 },
    brass: { inst: 'brass', gain: 0.34, rev: 0.2, rel: 0.08 },
    arp: { inst: 'pluck', gain: 0.44, pan: 0.35, dly: 0.35, rev: 0.2, pump: 2, rel: 0.04 },
    bell: { inst: 'bell', gain: 0.37, rev: 0.4, dly: 0.3, rel: 0.3 },
  },
  sections: [
    {
      bars: 8,
      chords: foundryA,
      parts: {
        boom: { drum: CRASH, only: [0] },
        kick: { drum: K4 },
        hat: { drum: HAT16, vel: 0.5, only: bars(4, 8) },
        acid: { bass: ACID, oct: 2, samples: ACID_SAMPLES },
        sub: { bass: [[0, 0, 4], [8, 0, 4]], oct: 1 },
        fx: { drum: CRASH, only: [6] },
        snare: { drum: ROLL, only: [6, 7], vel: 0.8 },
      },
      auto: [{ p: 'lp', from: 500, to: 18000, bars: 8 }],
    },
    {
      bars: 16,
      chords: foundryA,
      parts: {
        ...foundryDrums,
        tom: { drum: 'x.x.x.x.xxxxxxxx', only: [15], vel: 0.8 },
        acid: { bass: ACID, oct: 2, samples: ACID_SAMPLES },
        sub: { bass: [[0, 0, 4], [8, 0, 4]], oct: 1 },
        stab: { chords: [[0, 3], [6, 2], [10, 3]], lo: 60, hi: 77, vel: 0.75 },
        choir: { chords: [[0, 16]], lo: 53, hi: 68, only: bars(8, 16) },
        lead: { notes: foundryHook },
      },
    },
    {
      bars: 16,
      chords: foundryB,
      parts: {
        ...foundryDrums,
        snare: { drum: FILL, only: [15] },
        acid: { bass: ACID, oct: 2, samples: ACID_SAMPLES, vel: 0.8 },
        sub: { bass: [[0, 0, 4], [8, 0, 4]], oct: 1 },
        arp: { arp: [0, 1, 2, 3, 2, 1, 2, 3, 4, 3, 2, 1, 2, 3, 2, 1], lo: 65, hi: 89 },
        choir: { chords: [[0, 16]], lo: 53, hi: 68 },
        brass: { chords: [[0, 4], [8, 2], [12, 4]], lo: 58, hi: 74, vel: 0.75 },
        lead: { notes: foundrySong },
      },
    },
    {
      bars: 8,
      chords: foundryA,
      parts: {
        choir: { chords: [[0, 16]], lo: 53, hi: 68 },
        bell: { notes: foundryHook, vel: 0.8 },
        sub: { bass: [[0, 0, 8], [8, 0, 8]], oct: 1 },
        acid: { bass: ACID, oct: 2, samples: ACID_SAMPLES, vel: 0.6, only: bars(4, 8) },
        fx: { drum: CRASH, only: [6] },
        snare: { drum: ROLL, only: [6, 7] },
      },
      auto: [
        { p: 'lp', from: 18000, to: 700, bars: 1 },
        { p: 'lp', from: 700, to: 18000, at: 4, bars: 4 },
      ],
    },
    {
      bars: 16,
      chords: foundryA,
      parts: {
        ...foundryDrums,
        tom: { drum: 'x.x.x.x.xxxxxxxx', only: [15], vel: 0.8 },
        acid: { bass: ACID, oct: 2, samples: ACID_SAMPLES },
        sub: { bass: [[0, 0, 4], [8, 0, 4]], oct: 1 },
        stab: { chords: [[0, 3], [6, 2], [10, 3]], lo: 60, hi: 77, vel: 0.75 },
        choir: { chords: [[0, 16]], lo: 53, hi: 68 },
        lead: { notes: foundryHook },
        brass: { notes: foundryHook, tr: -12, vel: 0.6 },
      },
      auto: [{ p: 'lp', from: 18000, to: 18000, bars: 0 }],
    },
  ],
};

// ================================================================= jingles

const victory: Song = {
  bpm: 150,
  loop: false,
  tail: 2,
  channels: {
    brass: { inst: 'brass', gain: 0.5, rev: 0.3, rel: 0.2 },
    lead: { inst: 'lead', gain: 0.34, rev: 0.35, rel: 0.4 },
    timp: { inst: 'timp', gain: 0.55, rev: 0.2 },
    crash: { inst: 'crash', gain: 0.42, rev: 0.25 },
    kick: { inst: 'kick', gain: 0.7 },
    orch: { inst: 'orch', gain: 0.5, rev: 0.3, rel: 0.4 },
    bell: { inst: 'bell', gain: 0.3, rev: 0.4, rel: 0.6 },
  },
  sections: [
    {
      bars: 2,
      chords: ['C'],
      parts: {
        brass: {
          notes: [
            '0:C4:3 0:E4:3 0:G4:3 3:C4:1 3:E4:1 3:G4:1 4:F4:4 4:A4:4 4:C5:4 8:G4:4 8:B4:4 8:D5:4 12:G4:4 12:B4:4 12:D5:4',
            '0:C4:16 0:E4:16 0:G4:16 0:C5:16',
          ],
        },
        lead: { notes: ['0:G5:3 3:G5:1 4:A5:4 8:B5:4 12:D6:4', '0:C6:16'] },
        timp: { drum: ['o.o.o.o.xxxxXXXX', 'X...............'] },
        crash: { drum: ['................', CRASH] },
        kick: { drum: ['................', CRASH] },
        orch: { notes: ['', '0:C4:8'] },
        bell: { notes: ['', '0:C6:2 2:E6:2 4:G6:2 6:C7:8'] },
      },
    },
  ],
};

const defeat: Song = {
  bpm: 110,
  loop: false,
  tail: 2,
  channels: {
    pad: { inst: 'pad', gain: 0.42, rev: 0.45, rel: 0.6 },
    brass: { inst: 'brass', gain: 0.28, rev: 0.35, rel: 0.4 },
    lead: { inst: 'squareLead', gain: 0.3, rev: 0.4, dly: 0.25, rel: 0.5 },
    sub: { inst: 'sub', gain: 0.4, rel: 0.4 },
    boom: { inst: 'impact', gain: 0.35 },
  },
  sections: [
    {
      bars: 2,
      chords: ['Am'],
      parts: {
        pad: { notes: ['0:A3:8 0:C4:8 0:E4:8 8:F3:4 8:A3:4 8:C4:4 12:E3:4 12:G#3:4 12:B3:4', '0:A3:16 0:C4:16 0:E4:16'] },
        brass: { notes: ['0:A3:8 0:E4:8 8:F3:4 8:C4:4 12:E3:4 12:B3:4', '0:A3:16 0:E4:16'], vel: 0.8 },
        lead: { notes: ['0:E5:4 4:D5:4 8:C5:4 12:B4:4', '0:A4:16'] },
        sub: { notes: ['0:A1:8 8:F1:4 12:E1:4', '0:A1:16'] },
        boom: { drum: [CRASH, '................'] },
      },
    },
  ],
};

export const SONGS: Record<MusicTrack, Song> = { title, select, stageA, stageB, victory, defeat };
