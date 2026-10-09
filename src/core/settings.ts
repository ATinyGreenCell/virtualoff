export type VideoMode = 'pixel' | 'crt' | 'sharp';
export type Difficulty = 'easy' | 'normal' | 'hard';
export type PadMode = 'modern' | 'twin';
export type PerfMode = 'auto' | 'high' | 'low';

export interface Settings {
  video: VideoMode;
  difficulty: Difficulty;
  pad: PadMode;
  perf: PerfMode;
  voice: boolean;
  music: number;
  sfx: number;
}

const KEY = 'virtualoff.settings.v1';

const defaults: Settings = {
  video: 'pixel',
  difficulty: 'normal',
  pad: 'modern',
  perf: 'auto',
  voice: true,
  music: 0.8,
  sfx: 0.9,
};

function load(): Settings {
  const s: Settings = { ...defaults };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return s;
    const v = JSON.parse(raw) as Partial<Settings>;
    if (v.video === 'pixel' || v.video === 'crt' || v.video === 'sharp') s.video = v.video;
    if (v.difficulty === 'easy' || v.difficulty === 'normal' || v.difficulty === 'hard') s.difficulty = v.difficulty;
    if (v.pad === 'modern' || v.pad === 'twin') s.pad = v.pad;
    if (v.perf === 'auto' || v.perf === 'high' || v.perf === 'low') s.perf = v.perf;
    if (typeof v.voice === 'boolean') s.voice = v.voice;
    if (typeof v.music === 'number') s.music = Math.min(1, Math.max(0, v.music));
    if (typeof v.sfx === 'number') s.sfx = Math.min(1, Math.max(0, v.sfx));
  } catch {
    // storage unavailable (private mode etc.) — defaults are fine
  }
  return s;
}

export const settings: Settings = load();

export function saveSettings() {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // ignore
  }
}

/** Users who ask the OS for reduced motion get gentler screen shake and no full-screen flashes. */
export const reducedMotion = (() => {
  try {
    return matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
})();
