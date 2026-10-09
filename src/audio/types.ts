/** Public audio types (re-exported from audio.ts). */

export type SfxName =
  | 'rifle' | 'rifleDash' | 'cannon' | 'bombThrow' | 'missileLaunch'
  | 'hyperCharge' | 'hyperShot' | 'laserCharge'
  | 'explosionSmall' | 'explosionBig' | 'mechExplode'
  | 'hit' | 'hitHeavy' | 'guardHit' | 'down'
  | 'dash' | 'airDash' | 'jump' | 'land' | 'step'
  | 'swing' | 'slash'
  | 'lockOn' | 'empty' | 'alarm'
  | 'uiMove' | 'uiSelect' | 'uiBack' | 'uiConfirmBig'
  | 'announceRound' | 'announceReady' | 'announceGo' | 'announceFinish'
  | 'announceWin' | 'announceLose' | 'announceTimeUp';

export type MusicTrack = 'title' | 'select' | 'stageA' | 'stageB' | 'victory' | 'defeat';

export type LoopName = 'laser' | 'thruster';

/** volume 0..1+ (default 1), pan -1..1 (default 0), pitch multiplier (default 1). */
export interface PlayOpts {
  volume?: number;
  pan?: number;
  pitch?: number;
}

export interface LoopHandle {
  set(p: { volume?: number; pitch?: number; pan?: number }): void;
  stop(fade?: number): void;
}
