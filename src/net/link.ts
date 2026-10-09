import type { Room } from 'trystero';
import { APP_ID, PROTOCOL, type InputMsg, type LobbyMsg, type Role, type SnapMsg } from './protocol';

export type LinkStatus = 'connecting' | 'waiting' | 'connected' | 'lost' | 'error';

/** How long a guest waits for the host to show up before giving up. */
const FIND_TIMEOUT_MS = 30_000;
/** Snapshots dropped (not queued) once this many sends are still in flight — keeps latency bounded. */
const MAX_INFLIGHT = 4;

/**
 * A two-player peer-to-peer link. Peers find each other through public Nostr relays (Trystero) using
 * the room code, then talk directly over an encrypted WebRTC data channel.
 */
export class NetLink {
  status: LinkStatus = 'connecting';
  detail = '';
  rtt = 0;
  peerId: string | null = null;
  onStatus: ((s: LinkStatus, detail: string) => void) | null = null;
  onLobby: ((m: LobbyMsg) => void) | null = null;
  onInput: ((m: InputMsg) => void) | null = null;
  onSnap: ((m: SnapMsg) => void) | null = null;

  private room: Room | null = null;
  private lb: ((m: LobbyMsg, target?: string) => void) | null = null;
  private inp: ((m: InputMsg) => void) | null = null;
  private st: ((m: SnapMsg) => Promise<void>) | null = null;
  private inflight = 0;
  private findTimer = 0;
  private pingTimer = 0;
  private closed = false;

  private constructor(
    readonly role: Role,
    readonly code: string,
  ) {}

  static open(role: Role, code: string) {
    const link = new NetLink(role, code);
    void link.start();
    return link;
  }

  get connected() {
    return this.status === 'connected';
  }

  private owner: object | null = null;

  /**
   * Hand the link's callbacks to a screen. Screens overlap for a frame during transitions, so only
   * the current owner may detach — the outgoing screen can't clobber the incoming one's handlers.
   */
  attach(
    owner: object,
    h: {
      onStatus?: (s: LinkStatus, detail: string) => void;
      onLobby?: (m: LobbyMsg) => void;
      onInput?: (m: InputMsg) => void;
      onSnap?: (m: SnapMsg) => void;
    },
  ) {
    this.owner = owner;
    this.onStatus = h.onStatus ?? null;
    this.onLobby = h.onLobby ?? null;
    this.onInput = h.onInput ?? null;
    this.onSnap = h.onSnap ?? null;
  }

  detach(owner: object) {
    if (this.owner !== owner) return;
    this.owner = null;
    this.onStatus = this.onLobby = null;
    this.onInput = null;
    this.onSnap = null;
  }

  private setStatus(s: LinkStatus, detail = '') {
    if (this.closed && s !== 'lost') return;
    this.status = s;
    this.detail = detail;
    this.onStatus?.(s, detail);
  }

  private fail(detail: string) {
    this.setStatus('error', detail);
    this.close();
  }

  private async start() {
    let joinRoom: typeof import('trystero').joinRoom;
    try {
      ({ joinRoom } = await import('trystero'));
    } catch {
      this.fail('Could not load the networking module. Check your connection and try again.');
      return;
    }
    if (this.closed) return;
    try {
      const room = joinRoom({ appId: APP_ID, relayConfig: { warnOnRelayFailure: false } }, `room-${this.code}`, {
        onJoinError: (d) => {
          if (!this.peerId) this.fail(`Couldn't open a direct link to your rival (${String(d.error ?? 'blocked')}). Joining the same Wi-Fi usually fixes this.`);
        },
      });
      this.room = room;
      const lb = room.makeAction<LobbyMsg>('lb');
      const inp = room.makeAction<InputMsg>('in');
      const st = room.makeAction<SnapMsg>('st');
      lb.onMessage = (data, ctx) => this.recvLobby(data, ctx.peerId);
      inp.onMessage = (data, ctx) => {
        if (ctx.peerId === this.peerId) this.onInput?.(data);
      };
      st.onMessage = (data, ctx) => {
        if (ctx.peerId === this.peerId) this.onSnap?.(data);
      };
      this.lb = (m, target) => void lb.send(m, target ? { target } : this.peerId ? { target: this.peerId } : undefined).catch(() => undefined);
      this.inp = (m) => void inp.send(m, { target: this.peerId! }).catch(() => undefined);
      this.st = (m) => st.send(m, { target: this.peerId! });
      room.onPeerJoin = (id) => this.lb?.({ t: 'hello', v: PROTOCOL, role: this.role }, id);
      room.onPeerLeave = (id) => {
        if (id === this.peerId) this.setStatus('lost', 'Your rival disconnected.');
      };
      this.setStatus('waiting');
      if (this.role === 'guest') {
        this.findTimer = window.setTimeout(() => {
          if (!this.peerId) this.fail(`Nobody is hosting room ${this.code}. Check the code — the host's screen should be showing it.`);
        }, FIND_TIMEOUT_MS);
      }
    } catch (err) {
      console.error('[virtual-off] versus', err);
      this.fail('Versus could not start in this browser.');
    }
  }

  private recvLobby(m: LobbyMsg, from: string) {
    if (m.t === 'hello') {
      if (this.peerId && this.peerId !== from) {
        this.lb?.({ t: 'full' }, from);
        return;
      }
      if (this.peerId === from) return;
      if (m.v !== PROTOCOL) {
        this.fail('Your rival is running a different version of the game — reload both pages.');
        return;
      }
      if (m.role === this.role) {
        // two hosts on one code (or a guest finding a guest): not a valid pairing
        if (this.role === 'host') this.fail('Another host picked the same room code. Host again to get a new one.');
        return;
      }
      this.peerId = from;
      window.clearTimeout(this.findTimer);
      // answer in case our hello crossed theirs before they knew us
      this.lb?.({ t: 'hello', v: PROTOCOL, role: this.role }, from);
      this.pingTimer = window.setInterval(() => void this.ping(), 2000);
      void this.ping();
      this.setStatus('connected');
      return;
    }
    if (m.t === 'full') {
      if (!this.peerId) this.fail('That room already has two pilots.');
      return;
    }
    if (from === this.peerId) this.onLobby?.(m);
  }

  private async ping() {
    if (!this.room || !this.peerId) return;
    try {
      const ms = await this.room.ping(this.peerId);
      this.rtt = this.rtt ? this.rtt * 0.7 + ms * 0.3 : ms;
    } catch {
      // ignore — a lost peer is reported through onPeerLeave
    }
  }

  sendLobby(m: LobbyMsg) {
    if (this.peerId) this.lb?.(m);
  }

  sendInput(m: InputMsg) {
    if (this.connected) this.inp?.(m);
  }

  /** Returns false when the snapshot was dropped because the link is backed up. */
  sendSnap(m: SnapMsg) {
    if (!this.connected || !this.st) return false;
    if (this.inflight >= MAX_INFLIGHT) return false;
    this.inflight++;
    this.st(m)
      .catch(() => undefined)
      .finally(() => this.inflight--);
    return true;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    window.clearTimeout(this.findTimer);
    window.clearInterval(this.pingTimer);
    const room = this.room;
    this.room = null;
    if (room) {
      try {
        if (this.peerId) this.lb?.({ t: 'bye' });
      } catch {
        // ignore
      }
      setTimeout(() => void room.leave().catch(() => undefined), 150);
    }
  }
}
