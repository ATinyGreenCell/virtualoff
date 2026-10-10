/** Note names, chord symbols and voice-led chord voicings for the song data. */

const PC: Record<string, number> = {
  C: 0,
  'C#': 1,
  Db: 1,
  D: 2,
  'D#': 3,
  Eb: 3,
  E: 4,
  F: 5,
  'F#': 6,
  Gb: 6,
  G: 7,
  'G#': 8,
  Ab: 8,
  A: 9,
  'A#': 10,
  Bb: 10,
  B: 11,
};

/** 'C4' → 60, 'F#5' → 78, 'Bb3' → 58 */
export function midi(name: string): number {
  const m = /^([A-G])([#b]?)(-?\d)$/.exec(name);
  if (!m) throw new Error(`bad note '${name}'`);
  return PC[m[1] + m[2]] + (Number(m[3]) + 1) * 12;
}

const QUALITY: Record<string, number[]> = {
  '': [0, 4, 7],
  m: [0, 3, 7],
  '5': [0, 7],
  '7': [0, 4, 7, 10],
  maj7: [0, 4, 7, 11],
  m7: [0, 3, 7, 10],
  m9: [0, 3, 7, 10, 14],
  '9': [0, 4, 7, 10, 14],
  add9: [0, 4, 7, 14],
  madd9: [0, 3, 7, 14],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  '7sus4': [0, 5, 7, 10],
  '6': [0, 4, 7, 9],
  m6: [0, 3, 7, 9],
  dim: [0, 3, 6],
};

export interface Chord {
  /** pitch class of the root (0..11) */
  root: number;
  /** intervals above the root */
  ivals: number[];
  /** pitch class played by the bass (slash chords) */
  bass: number;
}

const chordCache = new Map<string, Chord>();

/** 'Am', 'F#m7', 'Cmaj7', 'C/E', 'Bbsus2' … */
export function chord(sym: string): Chord {
  let c = chordCache.get(sym);
  if (c) return c;
  const m = /^([A-G][#b]?)([^/]*)(?:\/([A-G][#b]?))?$/.exec(sym);
  if (!m || PC[m[1]] === undefined || !QUALITY[m[2]]) throw new Error(`bad chord '${sym}'`);
  c = { root: PC[m[1]], ivals: QUALITY[m[2]], bass: m[3] ? PC[m[3]] : PC[m[1]] };
  chordCache.set(sym, c);
  return c;
}

/** Bass note for a chord in a given octave (octave 2 → C2..B2). */
export const bassNote = (c: Chord, octave: number) => c.bass + 12 * (octave + 1);

/**
 * Voice a chord with `count` notes inside [lo, hi], choosing the inversion whose average pitch sits
 * closest to the previous voicing — smooth voice leading instead of parallel block jumps.
 */
export function voicing(c: Chord, lo: number, hi: number, count = 4, prev?: number[]): number[] {
  let iv = c.ivals.slice(0, count);
  while (iv.length < count) iv = iv.concat(iv.map((x) => x + 12)).slice(0, count);
  const target = prev && prev.length ? prev.reduce((a, b) => a + b, 0) / prev.length : (lo + hi) / 2;
  let best: number[] = [];
  let bestScore = Infinity;
  for (let inv = 0; inv < iv.length; inv++) {
    const shape = iv.map((x, i) => (i < inv ? x + 12 : x)).sort((a, b) => a - b);
    for (let base = c.root + 12 * Math.floor((lo - 24 - c.root) / 12); base <= hi; base += 12) {
      const notes = shape.map((x) => base + x);
      if (notes[0] < lo || notes[notes.length - 1] > hi) continue;
      const avg = notes.reduce((a, b) => a + b, 0) / notes.length;
      const score = Math.abs(avg - target) + (notes[notes.length - 1] - notes[0]) * 0.05;
      if (score < bestScore) {
        bestScore = score;
        best = notes;
      }
    }
  }
  if (best.length) return best;
  // range too narrow for the full chord: stack what fits above lo
  const base = lo + ((c.root - lo + 120) % 12);
  return iv.map((x) => base + x).filter((n) => n <= hi);
}
