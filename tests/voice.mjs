import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const base = process.env.TEST_BASE_URL ?? "http://127.0.0.1:3000";
async function api(path, body, token) {
  const response = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
}
async function guest(name) { return (await api("/api/session", { name, avatar_seed: name })).data; }
class Socket {
  messages = [];
  constructor(path, session, code) {
    this.ws = new WebSocket(base.replace("http", "ws") + path);
    this.ws.onopen = () => this.send({ token: session.token, code });
    this.ws.onmessage = event => this.messages.push(JSON.parse(event.data));
  }
  send(message) { this.ws.send(JSON.stringify(message)); }
  async wait(predicate) {
    for (let i = 0; i < 100; i++) {
      const result = predicate(this.messages);
      if (result) return result;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error("等待语音消息超时");
  }
  close() { this.ws.close(); }
}
test("voice verifies membership, routes only within the room, leaves game version unchanged and closes on end", async () => {
  const a = await guest("语音房主");
  const b = await guest("语音朋友");
  const c = await guest("其他房间");
  const code = (await api("/api/rooms", {}, a.token)).data.code;
  const otherCode = (await api("/api/rooms", {}, c.token)).data.code;
  await api(`/api/rooms/${code}/join`, {}, b.token);
  const sockets = [];
  const open = (path, session, room) => { const socket = new Socket(path, session, room); sockets.push(socket); return socket; };
  const ga = open("/api/ws", a, code);
  const gb = open("/api/ws", b, code);
  const gc = open("/api/ws", c, otherCode);
  try {
    await ga.wait(messages => messages.find(m => m.type === "snapshot" && m.players.every(p => p.online)));
    await gb.wait(messages => messages.find(m => m.type === "snapshot"));
    await gc.wait(messages => messages.find(m => m.type === "snapshot"));
    const rejected = open("/api/voice", c, code);
    await rejected.wait(messages => messages.find(m => m.type === "closed"));
    const va = open("/api/voice", a, code);
    const vb = open("/api/voice", b, code);
    const vc = open("/api/voice", c, otherCode);
    const welcomeA = await va.wait(messages => messages.find(m => m.type === "welcome"));
    await vb.wait(messages => messages.find(m => m.type === "welcome"));
    await vc.wait(messages => messages.find(m => m.type === "welcome"));
    await va.wait(messages => messages.find(m => m.type === "members" && m.members.length === 2));
    const version = ga.messages.filter(m => m.type === "snapshot").at(-1).version;
    const data = { description: { type: "offer", sdp: "v=0\r\n" } };
    va.send({ type: "signal", target: b.profile.id, from: "forged-id", data });
    const delivered = await vb.wait(messages => messages.find(m => m.type === "signal"));
    assert.equal(delivered.from, a.profile.id);
    assert.deepEqual(delivered.data, data);
    assert.equal(delivered.from_session, welcomeA.members.find(p => p.id === a.profile.id).session);
    const beforeStale = va.messages.length;
    const deliveredBeforeStale = vb.messages.filter(m => m.type === "signal").length;
    va.send({ type: "signal", target: b.profile.id, target_session: "obsolete-connection", data });
    await va.wait(messages => messages.slice(beforeStale).find(m => m.type === "error"));
    assert.equal(vb.messages.filter(m => m.type === "signal").length, deliveredBeforeStale);
    assert.equal(vc.messages.some(m => m.type === "signal"), false);
    va.send({ type: "signal", target: c.profile.id, data });
    await va.wait(messages => messages.find(m => m.type === "error"));
    assert.equal(vc.messages.some(m => m.type === "signal"), false);
    va.send({ type: "mute", muted: true });
    await vb.wait(messages => messages.find(m => m.type === "members" && m.members.some(p => p.id === a.profile.id && p.muted)));
    assert.equal(ga.messages.filter(m => m.type === "snapshot").at(-1).version, version);
    va.send({ type: "ping" });
    await va.wait(messages => messages.find(m => m.type === "pong"));
    const previous = va.messages.length;
    va.send({ type: "signal", target: b.profile.id, data: { arbitrary: "invalid" } });
    await va.wait(messages => messages.slice(previous).find(m => m.type === "error"));
    ga.send({ action: "end", version, cards: [], request_id: crypto.randomUUID() });
    await ga.wait(messages => messages.find(m => m.type === "snapshot" && m.phase === "ended"));
    await va.wait(messages => messages.find(m => m.type === "closed"));
    await vb.wait(messages => messages.find(m => m.type === "closed"));
    const afterEnd = open("/api/voice", a, code);
    await afterEnd.wait(messages => messages.find(m => m.type === "closed"));
    const practice = await guest("练习语音");
    const practiceCode = (await api("/api/rooms", { practice: true }, practice.token)).data.code;
    const gp = open("/api/ws", practice, practiceCode);
    await gp.wait(messages => messages.find(m => m.type === "snapshot"));
    await open("/api/voice", practice, practiceCode).wait(messages => messages.find(m => m.type === "closed"));
  } finally { for (const socket of sockets) socket.close(); }
});

test("HTTPS proxy permits same-origin microphones while blocking cameras", async () => {
  const caddy = await readFile(new URL("../deploy/Caddyfile", import.meta.url), "utf8");
  assert.match(caddy, /Permissions-Policy "microphone=\(self\), camera=\(\)"/);
});
