import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const base = process.env.TEST_BASE_URL ?? "http://127.0.0.1:3000";
async function api(path, body, token) {
  const response = await fetch(base + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
async function guest(name) {
  return (await api("/api/session", { name, avatar_seed: name })).body;
}
class Client {
  constructor(session, code) {
    this.snapshots = [];
    this.messages = [];
    this.waiters = [];
    this.ws = new WebSocket(base.replace("http", "ws") + "/api/ws");
    this.ws.onopen = () =>
      this.ws.send(JSON.stringify({ token: session.token, code }));
    this.ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      this.messages.push(message);
      if (message.type === "snapshot") {
        this.snapshot = message;
        this.snapshots.push(message);
      }
      for (const check of this.waiters) check();
    };
  }
  async wait(predicate) {
    if (predicate()) return;
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("等待服务器消息超时"));
      }, 10_000);
      const check = () => {
        if (predicate()) {
          cleanup();
          resolve();
        }
      };
      const cleanup = () => {
        clearTimeout(timeout);
        this.waiters = this.waiters.filter((w) => w !== check);
      };
      this.waiters.push(check);
    });
  }
  send(action, cards = [], overrides = {}) {
    this.ws.send(
      JSON.stringify({
        action,
        cards,
        version: this.snapshot.version,
        request_id: crypto.randomUUID(),
        ...overrides,
      }),
    );
  }
  close() {
    this.ws.close();
  }
}

test("browser WASM validates exactly the same rules", async () => {
  const { instance } = await WebAssembly.instantiate(
    await readFile("web/public/rules.wasm"),
  );
  const check = instance.exports.check_play;
  assert.equal(check(1, 0, 0, 0, 0), 65536 + 3 * 256 + 1);
  assert.equal(check(0, 1 << 20, 0, 0, 0), 0); // wildcard alone
  assert.notEqual(check(2, 0, 1, 3, 1), 0); // 4 over 3
  assert.equal(check(4, 0, 1, 3, 1), 0); // 5 cannot follow 3
  assert.equal(check(0, 1 << 24, 0, 0, 0), 0); // out of range
  assert.equal(check(1, 1 << 22, 0, 0, 0), 0); // no third joker (card 54)
  assert.notEqual(check(1, 1 << 21, 0, 0, 0), 0); // big joker completes a pair
});

test("room authentication, readiness, private hands, stale/repeated actions and reconnect", async () => {
  const a = await guest("测试房主");
  const b = await guest("测试朋友");
  const outsider = await guest("旁观身份");
  assert.equal((await api("/api/rooms", {}, "wrong-token")).status, 401);
  const created = await api("/api/rooms", {}, a.token);
  assert.match(created.body.code, /^[1-9]\d{3}$/);
  const code = created.body.code;
  assert.equal((await api(`/api/rooms/${code}/join`, {}, b.token)).status, 200);
  const ca = new Client(a, code);
  const cb = new Client(b, code);
  try {
    await ca.wait(() => ca.snapshot?.players.every((p) => p.online));
    await cb.wait(() => cb.snapshot?.players.every((p) => p.online));
    ca.send("start");
    await ca.wait(() => ca.messages.some((m) => m.type === "error"));
    assert.equal(ca.snapshot.phase, "waiting");
    const version = cb.snapshot.version;
    cb.send("ready");
    await ca.wait(() => ca.snapshot.version > version);
    ca.send("start");
    await ca.wait(() => ca.snapshot.phase === "playing");
    await cb.wait(() => cb.snapshot.phase === "playing");
    assert.equal(ca.snapshot.hand.length, 6);
    assert.equal(cb.snapshot.hand.length, 5);
    assert.equal(ca.snapshot.deck_count, 43); // 54 cards minus 6 + 5 dealt
    assert.equal("hands" in ca.snapshot, false);
    assert.equal("deck" in ca.snapshot, false);
    assert.ok(ca.snapshot.hand.every((c) => !cb.snapshot.hand.includes(c)));
    const foreign = cb.snapshot.hand[0];
    const beforeErrors = ca.messages.filter((m) => m.type === "error").length;
    ca.send("play", [foreign]);
    await ca.wait(
      () => ca.messages.filter((m) => m.type === "error").length > beforeErrors,
    );
    assert.equal(ca.snapshot.hand.length, 6);
    const card = ca.snapshot.hand.find((c) => c < 52);
    const id = crypto.randomUUID();
    const actionVersion = ca.snapshot.version;
    ca.send("play", [card], { request_id: id });
    await ca.wait(() => ca.snapshot.hand.length === 5);
    const afterVersion = ca.snapshot.version;
    ca.send("play", [card], { request_id: id, version: actionVersion });
    await ca.wait(
      () => ca.snapshots.filter((s) => s.version === afterVersion).length > 1,
    );
    assert.equal(ca.snapshot.hand.length, 5);
    const errorsB = cb.messages.filter((m) => m.type === "error").length;
    cb.send("pass", [], { version: 0 });
    await cb.wait(
      () => cb.messages.filter((m) => m.type === "error").length > errorsB,
    );
    assert.equal(
      (await api(`/api/rooms/${code}/join`, {}, outsider.token)).status,
      409,
    );
    assert.equal(
      (await api(`/api/rooms/${code}/leave`, {}, a.token)).status,
      409,
    );
    cb.close();
    await ca.wait(() => ca.snapshot.players.some((p) => !p.online));
    const reconnected = new Client(b, code);
    try {
      await reconnected.wait(() => reconnected.snapshot?.phase === "playing");
      assert.equal(reconnected.snapshot.seat, 1);
      assert.deepEqual(reconnected.snapshot.hand, cb.snapshot.hand);
    } finally {
      reconnected.close();
    }
  } finally {
    ca.close();
    cb.close();
  }
});

test("a replaced connection receives a terminal reason instead of reconnecting", async () => {
  const session = await guest("重复连接测试");
  const { body: { code } } = await api("/api/rooms", {}, session.token);
  const old = new Client(session, code);
  let replacement;
  try {
    await old.wait(() => !!old.snapshot);
    replacement = new Client(session, code);
    await replacement.wait(() => !!replacement.snapshot);
    await old.wait(() => old.messages.some(m => m.type === "fatal"));
    assert.match(old.messages.find(m => m.type === "fatal").error, /另一页/);
    replacement.send("ping");
    await replacement.wait(() => replacement.messages.some(m => m.type === "pong"));
  } finally {
    old.close();
    replacement?.close();
  }
});

test("host ends a live room, freezes totals, rejects new seats and permits leaving", async () => {
  const host = await guest("结束测试房主");
  const friend = await guest("结束测试朋友");
  const outsider = await guest("新玩家");
  const { body: { code } } = await api("/api/rooms", {}, host.token);
  await api(`/api/rooms/${code}/join`, {}, friend.token);
  const b = new Client(friend, code);
  let a;
  try {
    // Connect the guest first to cover either WebSocket connection order.
    // Its initial snapshot predates the host's connection and has an old version.
    await b.wait(() => !!b.snapshot);
    a = new Client(host, code);
    await a.wait(() => a.snapshot?.players.every(p => p.online));
    await b.wait(() => b.snapshot?.players.every(p => p.online));
    b.send("ready");
    await a.wait(() => a.snapshot.players.every(p => p.ready));
    a.send("start");
    await b.wait(() => b.snapshot.phase === "playing");
    b.send("end");
    await b.wait(() => b.messages.some(m => m.type === "error" && /只有房主/.test(m.error)));
    await a.wait(() => a.snapshot.phase === "playing");
    const id = crypto.randomUUID();
    a.send("end", [], { request_id: id });
    await a.wait(() => a.snapshot.phase === "ended");
    await b.wait(() => b.snapshot.phase === "ended");
    const scores = a.snapshot.final_scores;
    assert.equal(a.snapshot.abandoned_round, true);
    assert.equal(a.snapshot.completed_rounds, 0);
    assert.equal(a.snapshot.hand, null);
    assert.equal(a.snapshot.auto_pass_available, false);
    assert.deepEqual(scores.map(p => p.score), [0, 0]);
    assert.deepEqual(scores.map(p => p.rank), [1, 1]);
    assert.deepEqual(b.snapshot.final_scores, scores);
    const before = a.snapshots.length;
    a.send("end", [], { request_id: id });
    await a.wait(() => a.snapshots.length > before);
    a.send("next");
    await a.wait(() => a.messages.some(m => m.type === "error" && /游戏已结束/.test(m.error)));
    assert.equal((await api(`/api/rooms/${code}/join`, {}, outsider.token)).status, 409);
    assert.equal((await api(`/api/rooms/${code}/join`, {}, host.token)).status, 200);
    const version = a.snapshot.version;
    assert.equal((await api(`/api/rooms/${code}/leave`, {}, friend.token)).status, 200);
    await a.wait(() => a.snapshot.version > version);
    assert.equal(a.snapshot.phase, "ended");
    assert.deepEqual(a.snapshot.final_scores, scores);
    assert.equal((await api(`/api/rooms/${code}/leave`, {}, host.token)).status, 200);
  } finally {
    a?.close(); b.close();
  }
});

test("private three-round practice cannot be joined by another guest", async () => {
  const a = await guest("练习玩家");
  const b = await guest("另一个人");
  const created = await api("/api/rooms", { practice: true }, a.token);
  assert.equal(
    (await api(`/api/rooms/${created.body.code}/join`, {}, b.token)).status,
    403,
  );
  const client = new Client(a, created.body.code);
  try {
    await client.wait(() => !!client.snapshot);
    assert.equal(client.snapshot.practice, true);
    assert.equal(client.snapshot.players.filter((p) => p.bot).length, 2);
    assert.deepEqual(client.snapshot.hand, [0, 2, 15, 8, 12, 52]);
  } finally {
    client.close();
    await api(`/api/rooms/${created.body.code}/leave`, {}, a.token);
  }
});

test("host transfer keeps the next host ready and a guest cannot open another seat websocket", async () => {
  const a = await guest("离开的房主");
  const b = await guest("继任房主");
  const c = await guest("外来访客");
  const {
    body: { code },
  } = await api("/api/rooms", {}, a.token);
  await api(`/api/rooms/${code}/join`, {}, b.token);
  const outsider = new Client(c, code);
  try {
    await outsider.wait(() =>
      outsider.messages.some((m) => m.type === "fatal"),
    );
    assert.equal(outsider.snapshots.length, 0);
  } finally {
    outsider.close();
  }
  assert.equal(
    (await api(`/api/rooms/${code}/leave`, {}, a.token)).status,
    200,
  );
  const successor = new Client(b, code);
  try {
    await successor.wait(() => !!successor.snapshot);
    assert.equal(successor.snapshot.host, b.profile.id);
    assert.equal(successor.snapshot.players[0].ready, true);
  } finally {
    successor.close();
    await api(`/api/rooms/${code}/leave`, {}, b.token);
  }
});
