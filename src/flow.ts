import type { App } from './app';
import { settings } from './core/settings';
import { Battle, type BattleResult } from './game/battle';
import { FUJIN, JEBE, ROSTER, type MechId, type MechSpec, type Palette, type StageId } from './game/specs';
import type { NetLink } from './net/link';
import { EndingScreen, SelectScreen, TitleScreen } from './ui/screens';
import { VersusScreen } from './ui/versus';

interface Fight {
  cpu: MechSpec;
  palette: Palette;
  stage: StageId;
}

const SPECS: Record<MechId, MechSpec> = { jebe: JEBE, fujin: FUJIN };

/** Screen-to-screen flow: arcade ladder, and two-player versus over a peer link. */
export class Flow {
  private player: MechSpec = ROSTER[0];
  private ladder: Fight[] = [];
  private stageNo = 0;

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
      if (this.stageNo >= this.ladder.length) this.app.setScreen(new EndingScreen(this.app, this, this.player));
      else this.battle();
    } else if (r === 'continue') {
      this.battle();
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
