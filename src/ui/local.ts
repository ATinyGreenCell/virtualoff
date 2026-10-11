import { audio } from '../audio/audio';
import type { App, Screen } from '../app';
import { deviceLabel, type DeviceId } from '../core/input';
import { IS_XBOX, XBOX_HINT } from '../core/platform';
import { ceremony } from '../core/testmode';
import type { Flow, LocalPick } from '../flow';
import { MechModel, makePose } from '../game/mechModel';
import { MECH_IDS, SPECS, type MechId } from '../game/specs';
import { Hangar } from './screens';

type Mode = LocalPick['mode'];

interface Seat {
  /** the controller this player is on (null: nobody has joined this side yet) */
  device: DeviceId | null;
  /** its connection generation when claimed: a reconnect (maybe someone else's pad) frees the side */
  gen: number;
  pick: MechId;
  ready: boolean;
}

const IDS = MECH_IDS;

const MODE_INFO: Record<Mode, { title: string; line: string }> = {
  versus: { title: 'VERSUS · BEST OF THREE', line: '1P vs 2P on one screen · random stage' },
  coop: { title: 'CO-OP · 2 ON 1', line: '1P + 2P team up against a tougher CPU through the arcade stages · no friendly fire' },
};

/**
 * Split-screen lobby. Pick VERSUS or CO-OP, then each player presses A (or ENTER on the keyboard) on
 * their own controller to take a side, chooses a VR with left/right and readies up.
 */
export class LocalScreen implements Screen {
  private readonly hangar: Hangar;
  private readonly el: HTMLDivElement;
  private readonly panel: HTMLDivElement;
  private readonly offResize: () => void;
  private state: 'mode' | 'pick' = 'mode';
  private mode: Mode = 'versus';
  private sel = 0;
  private readonly seats: [Seat, Seat] = [
    { device: null, gen: 0, pick: 'jebe', ready: false },
    { device: null, gen: 0, pick: 'fujin', ready: false },
  ];
  private starting = false;
  private startT = 0;
  private t = 0;
  private leaving = false;
  private models: [MechModel | null, MechModel | null] = [null, null];
  private modelKeys: [string, string] = ['', ''];
  private readonly pose = makePose();
  private readonly readyPose = makePose();

  constructor(
    private readonly app: App,
    private readonly flow: Flow,
    pick?: LocalPick,
  ) {
    this.hangar = new Hangar(app.renderer.aspect, [-7.5, 7.5]);
    this.offResize = app.renderer.onResize(() => {
      this.hangar.cam.aspect = app.renderer.aspect;
      this.hangar.cam.updateProjectionMatrix();
    });
    this.readyPose.aimR = 1;
    this.readyPose.charge = 0.6;
    this.el = document.createElement('div');
    this.el.className = 'screen vs-screen lc-screen';
    this.el.innerHTML = `
      <div class="sel-header"><div class="sel-kicker">ONE SCREEN · TWO PILOTS</div><div class="sel-title">SPLIT SCREEN</div></div>
      <div class="vs-panel lc-panel"></div>`;
    this.panel = this.el.querySelector('.vs-panel') as HTMLDivElement;
    this.panel.addEventListener('click', (e) => {
      const target = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
      if (target && !target.classList.contains('off')) this.click(target.dataset.act!);
    });
    app.ui.appendChild(this.el);
    audio.playMusic('select');
    if (pick) {
      // back from a match: same sides, same VRs — two presses of A and you're off again
      this.mode = pick.mode;
      pick.devices.forEach((d, i) => {
        this.seats[i].device = d;
        this.seats[i].gen = pick.gens[i];
        this.seats[i].pick = pick.mechs[i];
      });
      this.state = 'pick';
    }
    this.renderPanel();
  }

  // ------------------------------------------------------------------ panel

  private renderPanel() {
    const p = this.panel;
    if (this.state === 'mode') {
      p.innerHTML = `
        <p class="vs-note">Two players, one screen, top and bottom — each on their own controller<br>(a keyboard counts as one).</p>
        <div class="vs-btn" data-act="versus">VERSUS <small>1P vs 2P</small></div>
        <div class="vs-btn" data-act="coop">CO-OP <small>1P + 2P vs CPU</small></div>
        <div class="vs-btn small" data-act="title">BACK</div>
        <div class="lc-desc"></div>
        ${IS_XBOX ? `<div class="xbox-hint">${XBOX_HINT}</div>` : ''}`;
      this.highlight();
      return;
    }
    const join = this.mode === 'coop' ? '&amp;' : 'VS';
    const side = (i: number) => `
      <div class="vs-side lc-seat s${i}${i === 1 ? ' rival' : ''}">
        <div class="vs-tag">${i === 0 ? '1P · TOP' : '2P · BOTTOM'}</div>
        <div class="vs-name"><span class="arr" data-act="prev${i}">◀</span><b class="lc-name"></b><span class="arr" data-act="next${i}">▶</span></div>
        <div class="vs-state lc-state" data-act="ready${i}"></div>
        <div class="lc-dev"></div>
      </div>`;
    p.innerHTML = `
      <div class="vs-label lc-mode">${MODE_INFO[this.mode].title}</div>
      <div class="vs-pick">${side(0)}<div class="vs-vs">${join}</div>${side(1)}</div>
      <div class="lc-hint">◀ ▶ choose VR · A / ENTER ready · B / ESC back</div>
      <div class="vs-btn small" data-act="back">BACK</div>`;
    this.refreshSeats();
  }

  private buttons() {
    return [...this.panel.querySelectorAll<HTMLElement>('.vs-btn')];
  }

  private highlight() {
    const btns = this.buttons();
    btns.forEach((b, i) => b.classList.toggle('sel', i === this.sel));
    const desc = this.panel.querySelector('.lc-desc');
    const act = btns[this.sel]?.dataset.act;
    if (desc) desc.textContent = act === 'versus' || act === 'coop' ? MODE_INFO[act].line : '';
  }

  private refreshSeats() {
    if (this.state !== 'pick') return;
    this.seats.forEach((s, i) => {
      const root = this.panel.querySelector(`.lc-seat.s${i}`);
      if (!root) return;
      const open = !s.device;
      root.classList.toggle('open', open);
      (root.querySelector('.lc-name') as HTMLElement).textContent = open ? '· · ·' : SPECS[s.pick].name;
      const st = root.querySelector('.lc-state') as HTMLElement;
      st.textContent = open ? 'PRESS A / ENTER TO JOIN' : this.starting ? 'GET SET!' : s.ready ? 'READY' : 'CHOOSING';
      st.classList.toggle('on', s.ready);
      st.classList.toggle('blink', open);
      (root.querySelector('.lc-dev') as HTMLElement).textContent = s.device ? deviceLabel(s.device) : '';
      root.querySelectorAll('.arr').forEach((a) => a.classList.toggle('off', open || s.ready));
    });
  }

  // ------------------------------------------------------------------ actions

  /** Mouse / touch on the panel. */
  private click(a: string) {
    if (this.leaving) return;
    if (a === 'versus' || a === 'coop') this.chooseMode(a, null);
    else if (a === 'title') this.toTitle();
    else if (a === 'back') this.back();
    else {
      const i = Number(a.slice(-1));
      const seat = this.seats[i];
      if (!seat.device) {
        // a click claims an open side for the keyboard
        if (!this.seats.some((s) => s.device === 'keys')) this.join('keys', i);
        return;
      }
      if (a.startsWith('ready')) this.toggleReady(seat);
      else this.cycle(seat, a.startsWith('next') ? 1 : -1);
    }
  }

  private chooseMode(mode: Mode, device: DeviceId | null) {
    audio.play('uiSelect');
    this.mode = mode;
    for (const s of this.seats) {
      s.device = null;
      s.ready = false;
    }
    // whoever picked the mode is 1P
    if (device) this.claim(this.seats[0], device);
    this.state = 'pick';
    this.renderPanel();
  }

  private toTitle() {
    audio.play('uiBack');
    this.leaving = true;
    this.flow.title();
  }

  /** BACK on the pick screen: to the mode choice (everyone leaves their side). */
  private back() {
    audio.play('uiBack');
    this.starting = false;
    this.state = 'mode';
    this.sel = this.mode === 'coop' ? 1 : 0;
    this.renderPanel();
  }

  private claim(seat: Seat, device: DeviceId) {
    seat.device = device;
    seat.gen = this.app.input.device(device)?.generation ?? 0;
    seat.ready = false;
  }

  private join(device: DeviceId, at?: number) {
    const i = at ?? this.seats.findIndex((s) => !s.device);
    if (i < 0) return;
    this.claim(this.seats[i], device);
    audio.play('lockOn');
    this.refreshSeats();
  }

  private cycle(seat: Seat, dir: number) {
    if (seat.ready) return;
    audio.play('uiMove');
    seat.pick = IDS[(IDS.indexOf(seat.pick) + dir + IDS.length) % IDS.length];
    this.refreshSeats();
  }

  private toggleReady(seat: Seat) {
    seat.ready = !seat.ready;
    audio.play(seat.ready ? 'uiConfirmBig' : 'uiBack');
    if (seat.ready) audio.speak(SPECS[seat.pick].name);
    else this.starting = false;
    if (seat.ready && this.seats.every((s) => s.device && s.ready)) {
      this.starting = true;
      this.startT = 0;
    }
    this.refreshSeats();
  }

  // ------------------------------------------------------------------ frame

  update(dt: number) {
    this.t += dt;
    this.hangar.update(this.t);
    if (!this.leaving) {
      if (this.state === 'mode') this.updateMode();
      else this.updatePick(dt);
    }
    this.updateModels(dt);
  }

  private updateMode() {
    const input = this.app.input;
    const m = input.menu;
    const btns = this.buttons();
    if ((m.up || m.down) && btns.length) {
      this.sel = (this.sel + (m.down ? 1 : btns.length - 1)) % btns.length;
      audio.play('uiMove');
      this.highlight();
    }
    if (m.confirm && btns[this.sel]) {
      const act = btns[this.sel].dataset.act!;
      if (act === 'versus' || act === 'coop') {
        const by = input.devices().find((d) => d.menu.confirm);
        this.chooseMode(act, by?.id ?? null);
      } else this.toTitle();
    } else if (m.back) this.toTitle();
  }

  private updatePick(dt: number) {
    const input = this.app.input;
    // a controller that drops out gives up its side (and one that dropped and came back must join again:
    // the slot it reappears in may be the other player's)
    for (const s of this.seats) {
      const d = s.device ? input.device(s.device) : null;
      if (s.device && (!d?.connected || d.generation !== s.gen)) {
        s.device = null;
        s.ready = this.starting = false;
        audio.play('uiBack');
        this.refreshSeats();
      }
    }
    // One join per frame, and none in a frame where a seated player pressed A: a pad some drivers
    // expose twice must not take both sides (its twin presses along with every press it makes).
    const devices = input.devices();
    let joined = devices.some((d) => d.menu.confirm && this.seats.some((s) => s.device === d.id));
    for (const d of devices) {
      const m = d.menu;
      const seat = this.seats.find((s) => s.device === d.id);
      if (!seat) {
        if (m.confirm && !joined) {
          this.join(d.id);
          joined = true;
        }
        // with nobody seated, B / ESC on any controller backs out to the mode choice
        else if (m.back && !this.seats.some((s) => s.device)) {
          this.back();
          return;
        }
        continue;
      }
      if (seat.ready) {
        if (m.back || m.confirm) this.toggleReady(seat);
        continue;
      }
      if (m.left) this.cycle(seat, -1);
      if (m.right) this.cycle(seat, 1);
      if (m.confirm) this.toggleReady(seat);
      else if (m.back) {
        // leave your side; the last one out goes back to the mode choice
        seat.device = null;
        audio.play('uiBack');
        if (!this.seats.some((s) => s.device)) {
          this.back();
          return;
        }
        this.refreshSeats();
      }
    }
    if (this.starting) {
      this.startT += ceremony(dt);
      if (!this.seats.every((s) => s.device && s.ready)) this.starting = false;
      else if (this.startT > 0.9) this.launch();
    }
  }

  private launch() {
    const [a, b] = this.seats;
    if (!a.device || !b.device) return;
    this.leaving = true;
    audio.play('uiConfirmBig');
    const pick: LocalPick = { mode: this.mode, devices: [a.device, b.device], gens: [a.gen, b.gen], mechs: [a.pick, b.pick] };
    if (this.mode === 'versus') this.flow.localVersus(pick);
    else this.flow.coopStart(pick);
  }

  private updateModels(dt: number) {
    for (let i = 0; i < 2; i++) {
      const seat = this.seats[i];
      const shown = this.state === 'pick' && seat.device;
      const id = seat.pick;
      // a mirror pick: 2P wears the alternate colors, as in the fight
      const alt = i === 1 && id === this.seats[0].pick;
      const key = shown ? `${id}:${alt}` : '';
      if (this.modelKeys[i] !== key) {
        const old = this.models[i];
        if (old) {
          this.hangar.platforms[i].remove(old.root);
          old.dispose();
        }
        this.models[i] = key ? new MechModel(SPECS[id], alt ? SPECS[id].altPalette : SPECS[id].palette) : null;
        if (this.models[i]) {
          this.models[i]!.root.position.y = 0.9;
          this.hangar.platforms[i].add(this.models[i]!.root);
        }
        this.modelKeys[i] = key;
      }
      const model = this.models[i];
      if (!model) continue;
      model.root.rotation.y = seat.ready ? (i === 0 ? 0.7 : -0.7) : this.t * 0.5 + i * Math.PI;
      model.update(seat.ready ? this.readyPose : this.pose, dt);
    }
    const c = this.hangar.cam;
    c.position.set(0, 7, 33);
    c.lookAt(0, 4.2, 0);
  }

  render() {
    this.app.renderer.render(this.hangar.scene, this.hangar.cam);
  }

  dispose() {
    this.offResize();
    for (const m of this.models) m?.dispose();
    this.hangar.dispose();
    this.el.remove();
  }
}
