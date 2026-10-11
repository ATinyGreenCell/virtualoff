import { audio } from '../audio/audio';
import type { App, Screen } from '../app';
import type { MenuInput } from '../core/input';
import type { Flow } from '../flow';
import { MechModel, makePose } from '../game/mechModel';
import { MECH_IDS, SPECS, type MechId, type StageId } from '../game/specs';
import { ceremony } from '../core/testmode';
import { NetLink, preloadNet, type LinkStatus } from '../net/link';
import { isValidCode, makeRoomCode, normalizeCode, type LobbyMsg } from '../net/protocol';
import { Hangar } from './screens';

type State = 'menu' | 'host' | 'join' | 'connecting' | 'pick' | 'error';

const IDS = MECH_IDS;
const STAGE_IDS: StageId[] = ['harbor', 'foundry'];

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Versus lobby: host or join a room, pick VRs, ready up. */
export class VersusScreen implements Screen {
  private readonly hangar: Hangar;
  private readonly el: HTMLDivElement;
  private readonly panel: HTMLDivElement;
  private readonly offResize: () => void;
  private state: State = 'menu';
  private link: NetLink | null = null;
  private sel = 0;
  private myPick: MechId = 'jebe';
  private rivalPick: MechId | null = null;
  private myReady = false;
  private rivalReady = false;
  private starting = false;
  private startT = 0;
  private heartbeat = 0;
  private t = 0;
  private models: [MechModel | null, MechModel | null] = [null, null];
  /** what each hangar model shows: VR id and paint ('' = none) */
  private modelKeys: [string, string] = ['', ''];
  private readonly pose = makePose();
  private readonly readyPose = makePose();
  private errorMsg = '';
  private codeInput: HTMLInputElement | null = null;
  private leaving = false;

  constructor(
    private readonly app: App,
    private readonly flow: Flow,
    opts: { link?: NetLink; joinCode?: string; pick?: MechId },
  ) {
    // back for a rematch: the VR you flew last
    if (opts.pick && IDS.includes(opts.pick)) this.myPick = opts.pick;
    this.hangar = new Hangar(app.renderer.aspect, [-7.5, 7.5]);
    this.offResize = app.renderer.onResize(() => {
      this.hangar.cam.aspect = app.renderer.aspect;
      this.hangar.cam.updateProjectionMatrix();
    });
    this.readyPose.aimR = 1;
    this.readyPose.charge = 0.6;
    this.el = document.createElement('div');
    this.el.className = 'screen vs-screen';
    this.el.innerHTML = `
      <div class="sel-header"><div class="sel-kicker">LINK BATTLE · 2 PILOTS</div><div class="sel-title">VERSUS</div></div>
      <div class="vs-panel"></div>`;
    this.panel = this.el.querySelector('.vs-panel') as HTMLDivElement;
    this.panel.addEventListener('click', (e) => {
      const target = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
      if (target && !target.classList.contains('off')) this.act(target.dataset.act!);
    });
    app.ui.appendChild(this.el);
    audio.playMusic('select');
    // the player is heading for a link battle: have the networking code ready before they pick
    void preloadNet().catch(() => undefined);
    if (opts.link?.connected) {
      this.adopt(opts.link);
      this.go('pick');
      this.sendPick();
    } else if (opts.joinCode && isValidCode(opts.joinCode)) {
      this.join(opts.joinCode);
    } else {
      this.go('menu');
    }
  }

  // ------------------------------------------------------------------ state machine

  private go(s: State) {
    this.state = s;
    this.sel = 0;
    this.codeInput = null;
    this.renderPanel();
  }

  private renderPanel() {
    const p = this.panel;
    const L = this.link;
    switch (this.state) {
      case 'menu':
        p.innerHTML = `
          <p class="vs-note">Fight a friend on another phone, tablet or computer.<br>Being on the same Wi-Fi is the most reliable.</p>
          <div class="vs-btn" data-act="host">HOST A MATCH</div>
          <div class="vs-btn" data-act="join">JOIN A MATCH</div>
          <div class="vs-btn small" data-act="title">BACK</div>`;
        break;
      case 'host':
        p.innerHTML = `
          <div class="vs-label">ROOM CODE</div>
          <div class="vs-code">${esc(L?.code ?? '----')}</div>
          <p class="vs-note">Tell your rival the code — or send the invite link and they'll drop straight in.</p>
          <div class="vs-btn" data-act="share">SEND INVITE LINK</div>
          <div class="vs-status"><span class="spinner"></span><span class="vs-status-text">${L?.status === 'connecting' ? 'OPENING THE ROOM…' : 'WAITING FOR YOUR RIVAL…'}</span></div>
          <div class="vs-btn small" data-act="cancel">CANCEL</div>`;
        break;
      case 'join':
        p.innerHTML = `
          <div class="vs-label">ENTER ROOM CODE</div>
          <input class="vs-input" maxlength="4" autocomplete="off" autocorrect="off" autocapitalize="characters" spellcheck="false" enterkeyhint="go" placeholder="····" aria-label="Room code">
          <div class="vs-btn" data-act="go">JOIN</div>
          <div class="vs-btn small" data-act="menu">BACK</div>`;
        this.codeInput = p.querySelector('.vs-input');
        this.codeInput?.addEventListener('input', () => {
          if (this.codeInput) this.codeInput.value = normalizeCode(this.codeInput.value);
        });
        this.codeInput?.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.key === 'Enter') this.act('go');
          if (e.key === 'Escape') this.codeInput?.blur();
        });
        setTimeout(() => this.codeInput?.focus(), 50);
        break;
      case 'connecting':
        p.innerHTML = `
          <div class="vs-label">ROOM ${esc(L?.code ?? '')}</div>
          <div class="vs-status"><span class="spinner"></span><span class="vs-status-text">LOOKING FOR THE HOST…</span></div>
          <div class="vs-btn small" data-act="cancel">CANCEL</div>`;
        break;
      case 'pick':
        p.innerHTML = `
          <div class="vs-pick">
            <div class="vs-side me"><div class="vs-tag">YOU</div><div class="vs-name"><span class="arr" data-act="prev">◀</span><b class="vs-my"></b><span class="arr" data-act="next">▶</span></div><div class="vs-state vs-my-state"></div></div>
            <div class="vs-vs">VS</div>
            <div class="vs-side rival"><div class="vs-tag">RIVAL</div><div class="vs-name"><b class="vs-rival"></b></div><div class="vs-state vs-rival-state"></div></div>
          </div>
          <div class="vs-btn" data-act="ready">READY</div>
          <div class="vs-btn small" data-act="leave">LEAVE</div>
          <div class="vs-ping"></div>`;
        this.refreshPick();
        break;
      case 'error':
        p.innerHTML = `
          <div class="vs-label">NO LINK</div>
          <p class="vs-note">${esc(this.errorMsg)}</p>
          <div class="vs-btn" data-act="menu">TRY AGAIN</div>
          <div class="vs-btn small" data-act="title">BACK TO TITLE</div>`;
        break;
    }
    this.highlight();
  }

  private refreshPick() {
    if (this.state !== 'pick') return;
    const q = (c: string) => this.panel.querySelector(c) as HTMLElement | null;
    const my = q('.vs-my');
    if (my) my.textContent = SPECS[this.myPick].name;
    const rv = q('.vs-rival');
    if (rv) rv.textContent = this.rivalPick ? SPECS[this.rivalPick].name : '· · ·';
    const ms = q('.vs-my-state');
    if (ms) {
      ms.textContent = this.myReady ? 'READY' : 'CHOOSING';
      ms.classList.toggle('on', this.myReady);
    }
    const rs = q('.vs-rival-state');
    if (rs) {
      rs.textContent = this.starting ? 'GET SET!' : this.rivalReady ? 'READY' : 'CHOOSING';
      rs.classList.toggle('on', this.rivalReady);
    }
    const btn = this.panel.querySelector('[data-act="ready"]');
    if (btn) btn.textContent = this.myReady ? 'CANCEL READY' : 'READY';
    this.panel.querySelectorAll('.arr').forEach((a) => a.classList.toggle('off', this.myReady));
  }

  private buttons() {
    return [...this.panel.querySelectorAll<HTMLElement>('.vs-btn')];
  }

  private highlight() {
    this.buttons().forEach((b, i) => b.classList.toggle('sel', i === this.sel));
  }

  private act(a: string) {
    if (this.leaving) return;
    switch (a) {
      case 'host': {
        audio.play('uiSelect');
        const link = NetLink.open('host', makeRoomCode());
        this.adopt(link);
        this.go('host');
        break;
      }
      case 'join':
        audio.play('uiSelect');
        this.go('join');
        break;
      case 'go': {
        const code = normalizeCode(this.codeInput?.value ?? '');
        if (!isValidCode(code)) {
          audio.play('empty');
          this.codeInput?.classList.remove('bad');
          void this.codeInput?.offsetWidth;
          this.codeInput?.classList.add('bad');
          return;
        }
        audio.play('uiSelect');
        this.codeInput?.blur();
        this.join(code);
        break;
      }
      case 'share':
        void this.share();
        break;
      case 'cancel':
        audio.play('uiBack');
        this.dropLink();
        this.go('menu');
        break;
      case 'menu':
        audio.play('uiBack');
        this.dropLink();
        this.go('menu');
        break;
      case 'title':
      case 'leave':
        audio.play('uiBack');
        this.leaving = true;
        this.dropLink();
        this.flow.title();
        break;
      case 'prev':
      case 'next':
        if (this.myReady) return;
        audio.play('uiMove');
        this.myPick = IDS[(IDS.indexOf(this.myPick) + (a === 'next' ? 1 : IDS.length - 1)) % IDS.length];
        this.sendPick();
        this.refreshPick();
        break;
      case 'ready':
        this.myReady = !this.myReady;
        audio.play(this.myReady ? 'uiConfirmBig' : 'uiBack');
        if (this.myReady) audio.speak(SPECS[this.myPick].name);
        this.sendPick();
        this.refreshPick();
        this.maybeStart();
        break;
    }
  }

  private join(code: string) {
    const link = NetLink.open('guest', code);
    this.adopt(link);
    this.go('connecting');
  }

  private async share() {
    const code = this.link?.code;
    if (!code) return;
    const url = `${location.origin}${location.pathname}#vs=${code}`;
    const status = this.panel.querySelector('.vs-status-text');
    try {
      if (navigator.share) {
        await navigator.share({ title: 'VIRTUAL-OFF', text: `Battle me in VIRTUAL-OFF! Room ${code}`, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      if (status) status.textContent = 'INVITE LINK COPIED — WAITING FOR YOUR RIVAL…';
    } catch {
      if (status) status.textContent = `SHARE THIS LINK: ${url}`;
    }
  }

  private adopt(link: NetLink) {
    this.link = link;
    link.attach(this, { onStatus: (s, d) => this.onStatus(s, d), onLobby: (m) => this.onLobby(m) });
  }

  private dropLink() {
    if (!this.link) return;
    this.link.detach(this);
    this.link.close();
    this.link = null;
    this.rivalPick = null;
    this.myReady = this.rivalReady = this.starting = false;
  }

  private onStatus(s: LinkStatus, detail: string) {
    if (s === 'connected') {
      audio.play('lockOn');
      this.rivalPick = null;
      this.rivalReady = false;
      this.go('pick');
      this.sendPick();
    } else if (s === 'error' || s === 'lost') {
      this.errorMsg = s === 'lost' ? 'Your rival disconnected.' : detail;
      this.dropLink();
      audio.play('uiBack');
      this.go('error');
    } else if (s === 'reconnecting') {
      // hold the lobby: Trystero re-pairs us if the rival is still around
      this.starting = false;
      const ping = this.panel.querySelector('.vs-ping');
      if (ping) ping.textContent = 'LINK LOST — RECONNECTING…';
    } else if (this.state === 'host') {
      const t = this.panel.querySelector('.vs-status-text');
      if (t && s === 'waiting') t.textContent = 'WAITING FOR YOUR RIVAL…';
    }
  }

  private onLobby(m: LobbyMsg) {
    if (m.t === 'pick') {
      if (!IDS.includes(m.mech)) return;
      this.rivalPick = m.mech;
      const wasReady = this.rivalReady;
      this.rivalReady = m.ready;
      if (m.ready && !wasReady) audio.play('uiSelect');
      if (!m.ready) this.starting = false;
      this.refreshPick();
      this.maybeStart();
    } else if (m.t === 'start' && this.link?.role === 'guest') {
      if (!IDS.includes(m.mech0) || !IDS.includes(m.mech1) || !STAGE_IDS.includes(m.stage)) return;
      this.launch(m.mech0, m.mech1, m.stage);
    } else if (m.t === 'bye') {
      this.errorMsg = 'Your rival left the lobby.';
      this.dropLink();
      this.go('error');
    }
  }

  private sendPick() {
    this.link?.sendLobby({ t: 'pick', mech: this.myPick, ready: this.myReady });
  }

  private maybeStart() {
    if (this.link?.role !== 'host' || this.starting) return;
    if (this.myReady && this.rivalReady && this.rivalPick) {
      this.starting = true;
      this.startT = 0;
      this.refreshPick();
    }
  }

  private launch(mech0: MechId, mech1: MechId, stage: StageId) {
    if (this.leaving || !this.link) return;
    this.leaving = true;
    const link = this.link;
    link.detach(this);
    this.link = null;
    audio.play('uiConfirmBig');
    this.flow.versusBattle(link, mech0, mech1, stage);
  }

  // ------------------------------------------------------------------ frame

  update(dt: number) {
    this.t += dt;
    this.hangar.update(this.t);
    let m = this.app.input.menu;
    const typing = this.codeInput !== null && document.activeElement === this.codeInput;
    if (typing) {
      // the keyboard belongs to the code box, but a controller (which can't type) still steers: any
      // press of one takes it out of the box, back to the buttons
      m = this.padMenu();
      if (m.any) this.codeInput?.blur();
    }
    if (!this.leaving) {
      if (this.state === 'pick') {
        if (m.left) this.act('prev');
        if (m.right) this.act('next');
        if (m.confirm) this.act('ready');
        // B takes back a READY first; only when you're not ready does it leave the room
        if (m.back) this.act(this.myReady ? 'ready' : 'leave');
      } else {
        const btns = this.buttons();
        if ((m.up || m.down) && btns.length) {
          this.sel = (this.sel + (m.down ? 1 : btns.length - 1)) % btns.length;
          audio.play('uiMove');
          this.highlight();
        }
        if (m.confirm && btns[this.sel]) this.act(btns[this.sel].dataset.act!);
        else if (m.back) {
          if (this.state === 'menu') this.act('title');
          else if (this.state === 'error' || this.state === 'join') this.act('menu');
          else this.act('cancel');
        }
      }
    }

    // keep picks in sync (a message can be lost while a battle screen is tearing down)
    if (this.state === 'pick' && this.link?.connected) {
      this.heartbeat -= dt;
      if (this.heartbeat <= 0) {
        this.heartbeat = 1.5;
        this.sendPick();
        const ping = this.panel.querySelector('.vs-ping');
        if (ping && this.link.rtt) ping.textContent = `LINK ${Math.round(this.link.rtt)} ms`;
      }
    }
    if (this.starting && this.link?.role === 'host' && this.link.connected) {
      this.startT += ceremony(dt);
      if (!(this.myReady && this.rivalReady)) this.starting = false;
      else if (this.startT > 0.9 && this.rivalPick) {
        const stage = STAGE_IDS[Math.floor(Math.random() * STAGE_IDS.length)];
        this.link.sendLobby({ t: 'start', mech0: this.myPick, mech1: this.rivalPick, stage });
        this.launch(this.myPick, this.rivalPick, stage);
        return;
      }
    }
    this.updateModels(dt);
  }

  private updateModels(dt: number) {
    const showRival = this.state === 'pick' && this.rivalPick !== null;
    const wanted: [MechId | null, MechId | null] = [this.myPick, showRival ? this.rivalPick : null];
    // a mirror match paints the guest in the alternate colors, as the fight will
    const mirror = wanted[0] === wanted[1];
    const guestSide = this.link?.role === 'guest' ? 0 : 1;
    for (let i = 0; i < 2; i++) {
      const id = wanted[i];
      const alt = mirror && i === guestSide;
      const key = id ? `${id}${alt ? ':alt' : ''}` : '';
      if (this.modelKeys[i] !== key) {
        const old = this.models[i];
        if (old) this.hangar.retire(old);
        this.models[i] = id ? new MechModel(SPECS[id], alt ? SPECS[id].altPalette : SPECS[id].palette) : null;
        if (this.models[i]) {
          this.models[i]!.root.position.y = 0.9;
          this.hangar.platforms[i].add(this.models[i]!.root);
        }
        this.modelKeys[i] = key;
      }
      const model = this.models[i];
      if (!model) continue;
      const ready = i === 0 ? this.myReady : this.rivalReady;
      model.root.rotation.y = ready ? (i === 0 ? 0.7 : -0.7) : this.t * 0.5 + i * Math.PI;
      model.update(ready ? this.readyPose : this.pose, dt);
    }
    const c = this.hangar.cam;
    c.position.set(0, 7, 33);
    c.lookAt(0, 4.2, 0);
  }

  /** Menu presses from the controllers alone (not the keyboard). */
  private padMenu(): MenuInput {
    const out: MenuInput = { up: false, down: false, left: false, right: false, confirm: false, back: false, pause: false, any: false };
    for (const d of this.app.input.devices()) {
      if (d.id === 'keys') continue;
      for (const k of Object.keys(out) as (keyof MenuInput)[]) out[k] ||= d.menu[k];
    }
    return out;
  }

  render() {
    this.app.renderer.render(this.hangar.scene, this.hangar.cam);
  }

  dispose() {
    this.offResize();
    if (this.link && !this.leaving) this.dropLink();
    for (const m of this.models) m?.dispose();
    this.hangar.dispose();
    this.el.remove();
  }
}
