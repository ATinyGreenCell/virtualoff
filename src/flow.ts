import type { App } from './app';
import type { DeviceId } from './core/input';
import { settings } from './core/settings';
import { Battle, type BattleResult } from './game/battle';
import { BOSS_PALETTES, FUJIN, JEBE, ROSTER, type MechId, type MechSpec, type Palette, type StageId } from './game/specs';
import type { NetLink } from './net/link';
import { LocalScreen } from './ui/local';
import { EndingScreen, SelectScreen, TitleScreen } from './ui/screens';
import { VersusScreen } from './ui/versus';

interface Fight {
  cpu: MechSpec;
  palette: Palette;
  stage: StageId;
}

/** Split screen: what the two players chose in the lobby (kept for rematches and the way back). */
export interface LocalPick {
  mode: 'versus' | 'coop';
  /** [1P (top view), 2P (bottom view)] */
  devices: [DeviceId, DeviceId];
  /** each controller's connection generation when its player claimed it (see Device.generation) */
  gens: [number, number];
  mechs: [MechId, MechId];
}

const SPECS: Record<MechId, MechSpec> = { jebe: JEBE, fujin: FUJIN };
const STAGE_IDS: StageId[] = ['harbor', 'foundry'];

/** Screen-to-screen flow: arcade ladder, split-screen versus and co-op, and versus over a peer link. */
export class Flow {
  private player: MechSpec = ROSTER[0];
  private ladder: Fight[] = [];
  private stageNo = 0;
  private coop: LocalPick | null = null;

  constructor(private readonly app: App) {
    // if a screen keeps crashing, fall back to the title instead of a frozen game
    app.onRecover = () => this.title();
  }

  title() {
    this.app.setScreen(new TitleScreen(this.app, this));
  }

  select() {
    this.app.setScreen(new SelectScreen(this.app, this));
  }

  // ------------------------------------------------------------------ arcade

  /** Arcade mode: fight every other VR on its home stage, then your own mirror image. */
  start(player: MechSpec) {
    this.player = player;
    this.ladder = [
      ...ROSTER.filter((m) => m !== player).map((m) => ({ cpu: m, palette: m.palette, stage: m.homeStage })),
      { cpu: player, palette: player.altPalette, stage: player.homeStage },
    ];
    this.stageNo = 0;
    this.battle();
  }

  private battle() {
    const f = this.ladder[this.stageNo];
    this.app.setScreen(
      new Battle(
        this.app,
        {
          mech0: this.player,
          palette0: this.player.palette,
          mech1: f.cpu,
          palette1: f.palette,
          stage: f.stage,
          stageNo: this.stageNo,
          stageCount: this.ladder.length,
          difficulty: settings.difficulty,
        },
        (r) => this.onBattle(r),
      ),
    );
  }

  private onBattle(r: BattleResult) {
    if (r === 'win') {
      this.stageNo++;
      if (this.stageNo >= this.ladder.length) this.app.setScreen(new EndingScreen(this.app, this, [{ spec: this.player, palette: this.player.palette }]));
      else this.battle();
    } else if (r === 'continue') {
      this.battle();
    } else {
      this.title();
    }
  }

  // ------------------------------------------------------------------ split screen

  /** The split-screen lobby: pick VERSUS or CO-OP, join on a controller each, choose VRs. */
  local(pick?: LocalPick) {
    this.app.setScreen(new LocalScreen(this.app, this, pick));
  }

  /** The two players' VRs and paint: a mirror pick gives 2P the alternate colors. */
  private localPilots(pick: LocalPick) {
    const a = SPECS[pick.mechs[0]];
    const b = SPECS[pick.mechs[1]];
    return { a, b, palB: a === b ? b.altPalette : b.palette };
  }

  /** Split-screen versus: one random stage, best of three. REMATCH keeps the picks. */
  localVersus(pick: LocalPick) {
    const { a, b, palB } = this.localPilots(pick);
    this.app.setScreen(
      new Battle(
        this.app,
        {
          mech0: a,
          palette0: a.palette,
          mech1: b,
          palette1: palB,
          stage: STAGE_IDS[Math.floor(Math.random() * STAGE_IDS.length)],
          stageNo: 0,
          stageCount: 1,
          difficulty: settings.difficulty,
          local: { mode: 'versus', devices: pick.devices, gens: pick.gens },
        },
        (r) => {
          if (r === 'rematch') this.localVersus(pick);
          else if (r === 'select') this.local(pick);
          else this.title();
        },
      ),
    );
  }

  /** Split-screen co-op: the two players take the arcade stages together, 2-on-1 against each VR. */
  coopStart(pick: LocalPick) {
    this.coop = pick;
    // VRs neither player is flying come first
    const flown = (m: MechSpec) => (pick.mechs.includes(m.id) ? 1 : 0);
    this.ladder = [...ROSTER]
      .sort((x, y) => flown(x) - flown(y))
      .map((m) => ({ cpu: m, palette: BOSS_PALETTES[m.id], stage: m.homeStage }));
    this.stageNo = 0;
    this.coopBattle();
  }

  private coopBattle() {
    const pick = this.coop!;
    const { a, b, palB } = this.localPilots(pick);
    const f = this.ladder[this.stageNo];
    this.app.setScreen(
      new Battle(
        this.app,
        {
          mech0: a,
          palette0: a.palette,
          mech1: b,
          palette1: palB,
          stage: f.stage,
          stageNo: this.stageNo,
          stageCount: this.ladder.length,
          difficulty: settings.difficulty,
          local: { mode: 'coop', devices: pick.devices, gens: pick.gens, boss: { spec: f.cpu, palette: f.palette } },
        },
        (r) => this.onCoop(r),
      ),
    );
  }

  private onCoop(r: BattleResult) {
    if (r === 'win') {
      this.stageNo++;
      if (this.stageNo < this.ladder.length) {
        this.coopBattle();
        return;
      }
      const { a, b, palB } = this.localPilots(this.coop!);
      this.app.setScreen(
        new EndingScreen(this.app, this, [
          { spec: a, palette: a.palette },
          { spec: b, palette: palB },
        ]),
      );
    } else if (r === 'continue') {
      this.coopBattle();
    } else {
      this.title();
    }
  }

  // ------------------------------------------------------------------ versus

  /** Open the versus lobby: fresh (host/join choice), joining a code, or back with a live link. */
  versus(opts: { link?: NetLink; joinCode?: string } = {}) {
    this.app.setScreen(new VersusScreen(this.app, this, opts));
  }

  versusBattle(link: NetLink, mech0: MechId, mech1: MechId, stage: StageId) {
    const a = SPECS[mech0];
    const b = SPECS[mech1];
    // a mirror match gives the guest the alternate paint job so the two are easy to tell apart
    const pal1 = mech0 === mech1 ? b.altPalette : b.palette;
    this.app.setScreen(
      new Battle(
        this.app,
        {
          mech0: a,
          palette0: a.palette,
          mech1: b,
          palette1: pal1,
          stage,
          stageNo: 0,
          stageCount: 1,
          difficulty: settings.difficulty,
          net: { link, role: link.role },
        },
        (r) => {
          if (r === 'rematch' && link.connected) this.versus({ link });
          else {
            link.close();
            this.title();
          }
        },
      ),
    );
  }
}
