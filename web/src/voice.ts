export interface VoiceMember { id: string; name: string; muted: boolean; session: string; connection: RTCPeerConnectionState }
interface Peer {
  session: string;
  pc: RTCPeerConnection;
  audio: HTMLAudioElement;
  makingOffer: boolean;
  ignoreOffer: boolean;
  settingAnswer: boolean;
  candidates: RTCIceCandidateInit[];
  queue: Promise<void>;
  retries: number;
  restart?: ReturnType<typeof setTimeout>;
}
interface Callbacks {
  ready: () => void;
  closed: (reason?: string) => void;
  members: (members: VoiceMember[]) => void;
  relay: (available: boolean) => void;
  blocked: (blocked: boolean) => void;
  error: (message: string) => void;
}

export class RoomVoice {
  private socket: WebSocket;
  private disposed = false;
  private peers = new Map<string, Peer>();
  private roster: Omit<VoiceMember, "connection">[] = [];
  private id = "";
  private config: RTCConfiguration = {};
  private speakerMuted = false;
  private lastMessage = Date.now();
  private heartbeat?: ReturnType<typeof setInterval>;
  private timeout: ReturnType<typeof setTimeout>;

  constructor(private stream: MediaStream, code: string, token: string, private callbacks: Callbacks) {
    this.socket = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/voice`);
    this.timeout = setTimeout(() => this.fail("语音连接超时，请重新开启"), 12_000);
    this.socket.onopen = () => {
      this.socket.send(JSON.stringify({ code, token }));
      this.heartbeat = setInterval(() => {
        if (Date.now() - this.lastMessage > 45_000) this.fail("语音连接中断，请重新开启");
        else this.send({ type: "ping" });
      }, 20_000);
    };
    this.socket.onmessage = event => {
      if (this.disposed) return;
      this.lastMessage = Date.now();
      try {
        const message = JSON.parse(event.data);
        if (message.type === "welcome") {
          clearTimeout(this.timeout);
          this.id = message.id;
          this.config = message.configuration;
          this.callbacks.relay(message.has_relay);
          this.updateMembers(message.members);
          this.callbacks.ready();
        } else if (message.type === "members") this.updateMembers(message.members);
        else if (message.type === "signal") {
          const peer = this.peers.get(message.from);
          if (!peer || peer.session !== message.from_session) return;
          peer.queue = peer.queue.then(() => this.receive(peer, message.from, message.data))
            .catch(() => { if (!this.disposed && peer.pc.signalingState !== "closed") this.callbacks.error("语音协商失败，请退出语音后重试"); });
        } else if (message.type === "config") {
          this.config = message.configuration;
          for (const [id, peer] of this.peers) {
            peer.pc.setConfiguration(this.config);
            if (this.id < id) peer.pc.restartIce();
          }
        } else if (message.type === "closed") this.fail(message.error);
        else if (message.type === "error") this.callbacks.error(message.error);
      } catch { this.fail("无法处理语音连接，请重新开启"); }
    };
    this.socket.onclose = () => { if (!this.disposed) this.fail("语音已断开，请重新开启"); };
    this.socket.onerror = () => this.fail("无法连接房间语音，请稍后重试");
    document.addEventListener("pointerdown", this.resumePlayback);
    document.addEventListener("keydown", this.resumePlayback);
  }
  private send(message: unknown) {
    if (!this.disposed && this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }
  private signal(target: string, data: unknown) { this.send({ type: "signal", target, target_session: this.peers.get(target)?.session, data }); }
  private emitMembers() {
    this.callbacks.members(this.roster.filter(member => member.id !== this.id).map(member => ({
      ...member, connection: this.peers.get(member.id)?.pc.connectionState ?? "new",
    })));
  }
  private updateMembers(members: Omit<VoiceMember, "connection">[]) {
    this.roster = members;
    const active = new Set(members.map(member => member.id));
    for (const [id, peer] of this.peers) {
      if (!active.has(id) || members.find(member => member.id === id)?.session !== peer.session) { this.closePeer(peer); this.peers.delete(id); }
    }
    for (const member of members) {
      if (member.id !== this.id && !this.peers.has(member.id)) this.createPeer(member.id, member.session);
    }
    this.emitMembers();
  }
  private createPeer(id: string, session: string) {
    const pc = new RTCPeerConnection(this.config);
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.muted = this.speakerMuted;
    audio.hidden = true;
    audio.setAttribute("playsinline", "");
    audio.dataset.voicePeer = id;
    document.body.appendChild(audio);
    const peer: Peer = { session, pc, audio, makingOffer: false, ignoreOffer: false, settingAnswer: false, candidates: [], queue: Promise.resolve(), retries: 0 };
    this.peers.set(id, peer);
    pc.onicecandidate = ({ candidate }) => { if (candidate) this.signal(id, { candidate: candidate.toJSON() }); };
    pc.onnegotiationneeded = async () => {
      // One deterministic caller per pair also avoids rollback/gathering races in mobile browsers.
      if (this.id > id || this.disposed) return;
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        this.signal(id, { description: pc.localDescription });
      } catch { if (!this.disposed && pc.signalingState !== "closed") this.callbacks.error("语音协商失败，请重试"); }
      finally { peer.makingOffer = false; }
    };
    pc.ontrack = ({ track, streams }) => {
      if (this.disposed || pc.signalingState === "closed") return;
      if (track.kind !== "audio") { track.stop(); return; }
      audio.srcObject = streams[0] ?? new MediaStream([track]);
      void audio.play().catch(() => this.callbacks.blocked(true));
    };
    pc.onconnectionstatechange = () => {
      this.emitMembers();
      if (pc.connectionState === "connected") {
        peer.retries = 0;
        clearTimeout(peer.restart);
      } else if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
        clearTimeout(peer.restart);
        peer.restart = setTimeout(() => {
          if (pc.signalingState === "closed" || pc.connectionState === "connected") return;
          if (peer.retries++ < 2) {
            if (this.id < id) pc.restartIce();
            else this.signal(id, { restart: true });
          }
          else this.callbacks.error("部分语音连接失败，请重试；跨网络部署请检查 TURN");
        }, pc.connectionState === "failed" ? 1000 : 5000);
      }
    };
    for (const track of this.stream.getAudioTracks()) pc.addTrack(track, this.stream);
  }
  private async receive(peer: Peer, id: string, data: { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit; restart?: boolean }) {
    const pc = peer.pc;
    if (this.disposed || pc.signalingState === "closed") return;
    if (data.restart) {
      if (this.id < id) pc.restartIce();
    } else if (data.description) {
      const description = data.description;
      const ready = !peer.makingOffer && (pc.signalingState === "stable" || peer.settingAnswer);
      const collision = description.type === "offer" && !ready;
      // Stable per-pair roles; the polite peer rolls back automatically on an incoming offer.
      peer.ignoreOffer = this.id < id && collision;
      if (peer.ignoreOffer) return;
      peer.settingAnswer = description.type === "answer";
      try { await pc.setRemoteDescription(description); }
      finally { peer.settingAnswer = false; }
      for (const candidate of peer.candidates.splice(0)) await pc.addIceCandidate(candidate);
      if (description.type === "offer") {
        await pc.setLocalDescription();
        this.signal(id, { description: pc.localDescription });
      }
    } else if (data.candidate && !peer.ignoreOffer) {
      if (!pc.remoteDescription) {
        if (peer.candidates.length < 64) peer.candidates.push(data.candidate);
      } else await pc.addIceCandidate(data.candidate);
    }
  }
  setMuted(muted: boolean) {
    for (const track of this.stream.getAudioTracks()) track.enabled = !muted;
    this.send({ type: "mute", muted });
  }
  setSpeakerMuted(muted: boolean) {
    this.speakerMuted = muted;
    for (const peer of this.peers.values()) peer.audio.muted = muted;
  }
  resumePlayback = () => {
    if (this.disposed) return;
    void Promise.all([...this.peers.values()].filter(peer => peer.audio.srcObject).map(peer => peer.audio.play().then(() => true).catch(() => false)))
      .then(results => { if (!this.disposed) this.callbacks.blocked(results.some(ok => !ok)); });
  };
  private closePeer(peer: Peer) {
    clearTimeout(peer.restart);
    peer.pc.onconnectionstatechange = null;
    peer.pc.onnegotiationneeded = null;
    peer.pc.onicecandidate = null;
    peer.pc.ontrack = null;
    peer.pc.close();
    peer.audio.pause();
    peer.audio.srcObject = null;
    peer.audio.remove();
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.heartbeat);
    clearTimeout(this.timeout);
    document.removeEventListener("pointerdown", this.resumePlayback);
    document.removeEventListener("keydown", this.resumePlayback);
    this.socket.close();
    for (const peer of this.peers.values()) this.closePeer(peer);
    this.peers.clear();
    for (const track of this.stream.getTracks()) track.stop();
  }
  private fail(message: string) {
    if (this.disposed) return;
    this.dispose();
    this.callbacks.closed(message);
  }
}
