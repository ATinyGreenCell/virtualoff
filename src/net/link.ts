import type { Room } from 'trystero';
import { APP_ID, PROTOCOL, type EventsMsg, type InputMsg, type LobbyMsg, type Role, type SnapMsg } from './protocol';

export type LinkStatus = 'connecting' | 'waiting' | 'connected' | 'reconnecting' | 'lost' | 'error';

/** How long a guest waits for the host to show up before giving up. */
const FIND_TIMEOUT_MS = 30_000;
/** Snapshots dropped (not queued) once this many sends are still in flight — keeps latency bounded. */
const MAX_INFLIGHT = 4;
/** How long a dropped rival has to come back (Wi-Fi blip, app switch) before the match is given up. */
const RECONNECT_GRACE_MS = 20_000;
/** Stream id of the real-time channel both peers open on Trystero's connection (its own channel is auto-numbered from 0). */
const RT_ID = 77;
/** Never queue real-time packets behind a congested link: the next one supersedes them anyway. */
const RT_MAX_BUFFERED = 32 * 1024;
/** Inputs repeated in every real-time packet, so one lost packet can't swallow a press. */
const INPUT_REDUNDANCY = 4;

let trystero: Promise<typeof import('trystero')> | null = null;

/** Start fetching the networking code before it's needed (versus menu, invite link): joining never waits on it. */
export function preloadNet() {
  if (!trystero) {
    trystero = import('trystero');
    trystero.catch(() => (trystero = null));
  }
  return trystero;
}

/**
 * A two-player peer-to-peer link. Peers find each other through public Nostr relays (Trystero) using
 * the room code, then talk directly over WebRTC: lobby messages, one-shot events and the fallback
 * path on Trystero's reliable channel; the 60 Hz state stream and inputs on an unordered,
 * no-retransmit channel, so one lost packet never stalls the ones behind it. A dropped connection
 * gets a grace period to come back before the match is lost.
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
  onEvents: ((m: EventsMsg) => void) | null = null;
  /** while reconnecting: when the grace period runs out (performance.now ms) */
  reconnectDeadline = 0;

  private room: Room | null = null;
  private lb: ((m: LobbyMsg, target?: string) => void) | null = null;
  private inp: ((m: InputMsg) => void) | null = null;
  private st: ((m: SnapMsg) => Promise<void>) | null = null;
  private ev: ((m: EventsMsg) => void) | null = null;
  private inflight = 0;
  private findTimer = 0;
  private pingTimer = 0;
  private graceTimer = 0;
  private closed = false;
  /** the rival said goodbye: a disconnect after that is final */
  private farewell = false;
  /** real-time channel, and whether the rival's end of it has been heard from */
  private rt: RTCDataChannel | null = null;
  /** the connection `rt` was opened on (Trystero replaces it when a peer re-pairs) */
  private rtPc: RTCPeerConnection | null = null;
  private rtReady = false;
  private rtProbe = 0;
  private readonly sentInputs: InputMsg[] = [];

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
      onEvents?: (m: EventsMsg) => void;
    },
  ) {
    this.owner = owner;
    this.onStatus = h.onStatus ?? null;
    this.onLobby = h.onLobby ?? null;
    this.onInput = h.onInput ?? null;
    this.onSnap = h.onSnap ?? null;
    this.onEvents = h.onEvents ?? null;
  }

  detach(owner: object) {
    if (this.owner !== owner) return;
    this.owner = null;
    this.onStatus = this.onLobby = null;
    this.onInput = null;
    this.onSnap = null;
    this.onEvents = null;
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
      ({ joinRoom } = await preloadNet());
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
      const ev = room.makeAction<EventsMsg>('ev');
      lb.onMessage = (data, ctx) => this.recvLobby(data, ctx.peerId);
      inp.onMessage = (data, ctx) => {
        if (ctx.peerId === this.peerId) this.onInput?.(data);
      };
      st.onMessage = (data, ctx) => {
        if (ctx.peerId === this.peerId) this.onSnap?.(data);
      };
      ev.onMessage = (data, ctx) => {
        if (ctx.peerId === this.peerId) this.onEvents?.(data);
      };
      this.lb = (m, target) => void lb.send(m, target ? { target } : this.peerId ? { target: this.peerId } : undefined).catch(() => undefined);
      this.inp = (m) => void inp.send(m, { target: this.peerId! }).catch(() => undefined);
      this.st = (m) => st.send(m, { target: this.peerId! });
      this.ev = (m) => void ev.send(m, { target: this.peerId! }).catch(() => undefined);
      room.onPeerJoin = (id) => this.lb?.({ t: 'hello', v: PROTOCOL, role: this.role }, id);
      room.onPeerLeave = (id) => {
        if (id === this.peerId) this.peerDropped();
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

  /** The connection to the rival closed: hold the seat for a while — Trystero re-pairs us if they're still around. */
  private peerDropped() {
    this.closeRt();
    if (this.farewell || this.closed) {
      this.setStatus('lost', 'Your rival disconnected.');
      return;
    }
    if (this.status === 'reconnecting') return;
    this.reconnectDeadline = performance.now() + RECONNECT_GRACE_MS;
    window.clearTimeout(this.graceTimer);
    this.graceTimer = window.setTimeout(() => this.setStatus('lost', 'Your rival disconnected.'), RECONNECT_GRACE_MS);
    this.setStatus('reconnecting');
  }

  private recvLobby(m: LobbyMsg, from: string) {
    if (m.t === 'hello') {
      if (this.peerId && this.peerId !== from) {
        this.lb?.({ t: 'full' }, from);
        return;
      }
      if (this.peerId === from) {
        // the same rival on a fresh connection (theirs dropped, maybe ours too)
        if (!m.ack) this.lb?.({ t: 'hello', v: PROTOCOL, role: this.role, ack: 1 }, from);
        if (this.status === 'reconnecting') {
          window.clearTimeout(this.graceTimer);
          this.openRt();
          this.setStatus('connected');
        } else this.healRt();
        return;
      }
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
      if (!m.ack) this.lb?.({ t: 'hello', v: PROTOCOL, role: this.role, ack: 1 }, from);
      this.pingTimer = window.setInterval(() => void this.ping(), 2000);
      void this.ping();
      this.openRt();
      this.setStatus('connected');
      return;
    }
    if (m.t === 'full') {
      if (!this.peerId) this.fail('That room already has two pilots.');
      return;
    }
    if (from === this.peerId) {
      if (m.t === 'bye') this.farewell = true;
      this.onLobby?.(m);
    }
  }

  // ------------------------------------------------------------------ real-time channel

  /** Open the unordered, no-retransmit channel on the rival's connection (both sides do; it's pre-negotiated). */
  private openRt() {
    this.closeRt();
    const pc = this.peerId ? this.room?.getPeers()[this.peerId] : undefined;
    if (!pc?.createDataChannel) return;
    let ch: RTCDataChannel;
    try {
      ch = pc.createDataChannel('vo-rt', { negotiated: true, id: RT_ID, ordered: false, maxRetransmits: 0 });
    } catch {
      return; // stay on the reliable channel
    }
    this.rt = ch;
    this.rtPc = pc;
    ch.onmessage = (e) => this.recvRt(e.data);
    ch.onclose = () => {
      if (this.rt === ch) this.closeRt();
    };
    // knock until the rival's end answers; until then everything rides the reliable channel
    const knock = () => {
      if (this.rtReady || this.rt !== ch) window.clearInterval(this.rtProbe);
      else if (ch.readyState === 'open') {
        try {
          ch.send('P');
        } catch {
          // the connection went away between the check and the send
        }
      }
    };
    ch.onopen = knock;
    this.rtProbe = window.setInterval(knock, 200);
  }

  /** Reopen the fast channel if it's gone or sits on a connection Trystero has since replaced. */
  private healRt() {
    if (!this.connected || !this.peerId) return;
    const pc = this.room?.getPeers()[this.peerId];
    if (pc && (!this.rt || this.rtPc !== pc)) this.openRt();
  }

  private closeRt() {
    window.clearInterval(this.rtProbe);
    const ch = this.rt;
    this.rt = null;
    this.rtPc = null;
    this.rtReady = false;
    if (ch) {
      ch.onmessage = ch.onclose = ch.onopen = null;
      try {
        ch.close();
      } catch {
        // already closed
      }
    }
  }

  private recvRt(data: unknown) {
    if (typeof data !== 'string' || !data) return;
    this.rtReady = true;
    const kind = data[0];
    if (kind === 'P') return;
    try {
      const m: unknown = JSON.parse(data.slice(1));
      if (kind === 'S') this.onSnap?.(m as SnapMsg);
      else if (kind === 'I' && Array.isArray(m)) for (const im of m as InputMsg[]) this.onInput?.(im);
    } catch {
      // a mangled packet is just a lost packet
    }
  }

  /** The real-time channel, when both ends are up and it isn't backed up. */
  private fast() {
    const ch = this.rt;
    return ch && this.rtReady && ch.readyState === 'open' && ch.bufferedAmount <= RT_MAX_BUFFERED ? ch : null;
  }

  private async ping() {
    if (!this.room || !this.peerId) return;
    this.healRt();
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
    if (!this.connected) return;
    const recent = this.sentInputs;
    recent.push(m);
    if (recent.length > INPUT_REDUNDANCY) recent.shift();
    const fast = this.fast();
    if (fast) {
      try {
        // the last few inputs ride along; the host skips the sequence numbers it already has
        fast.send('I' + JSON.stringify(recent));
        return;
      } catch {
        // fall back below
      }
    }
    this.inp?.(m);
  }

  /** Returns false when the snapshot was dropped because the link is backed up. */
  sendSnap(m: SnapMsg) {
    if (!this.connected || !this.st) return false;
    const fast = this.fast();
    if (fast) {
      try {
        fast.send('S' + JSON.stringify(m.e.length ? { ...m, e: [] } : m));
      } catch {
        return false;
      }
      // one-shot events (hits, announcer, sounds) must arrive: they go reliably, tagged with the snapshot time
      if (m.e.length) this.ev?.({ ht: m.ht, e: m.e });
      return true;
    }
    // fast channel up but backed up: drop this one, the next snapshot supersedes it
    if (this.rt && this.rtReady) return false;
    // fast channel not (yet) available: the reliable one, with a cap on what's in flight
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
    window.clearTimeout(this.graceTimer);
    window.clearInterval(this.pingTimer);
    this.closeRt();
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
