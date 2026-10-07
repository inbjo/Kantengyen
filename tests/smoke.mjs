import test from "node:test";
import assert from "node:assert/strict";

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
  const response = await fetch(`${base}/rules.wasm`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /application\/wasm/);
  const { instance } = await WebAssembly.instantiate(await response.arrayBuffer());
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
      200,
    );
    assert.equal(
      (await api(`/api/rooms/${code}/leave`, {}, a.token)).status,
      409,
    );
    cb.close();
    await ca.wait(() => !ca.snapshot.players[1].online);
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
    assert.equal((await api(`/api/rooms/${code}/join`, {}, outsider.token)).status, 404);
    assert.equal((await api(`/api/rooms/${code}/join`, {}, host.token)).status, 404);
    // Both identities can immediately create a fresh room without leaving the dissolved one.
    for (const session of [host, friend]) {
      const fresh = await api("/api/rooms", {}, session.token);
      assert.equal(fresh.status, 200);
      await api(`/api/rooms/${code}/leave`, {}, session.token);
      assert.equal((await api("/api/rooms", {}, session.token)).status, 409);
      await api(`/api/rooms/${fresh.body.code}/leave`, {}, session.token);
    }
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

test("eight seats can start, ninth seat is rejected, and disconnected players are taken over", async () => {
  const sessions = await Promise.all(Array.from({ length: 9 }, (_, i) => guest(`八人玩家${i}`)));
  const { body: { code } } = await api("/api/rooms", { round_limit: 16 }, sessions[0].token);
  for (const session of sessions.slice(1, 8)) assert.equal((await api(`/api/rooms/${code}/join`, {}, session.token)).status, 200);
  assert.equal((await api(`/api/rooms/${code}/join`, {}, sessions[8].token)).status, 409);
  const clients = sessions.slice(0, 8).map(session => new Client(session, code));
  try {
    await Promise.all(clients.map(client => client.wait(() => client.snapshot?.players.every(p => p.online))));
    assert.equal(clients[0].snapshot.round_limit, 16);
    assert.equal(clients[0].snapshot.players.length, 8);
    for (const client of clients.slice(1)) {
      await client.wait(() => client.snapshot.version === clients[0].snapshot.version);
      client.send("ready");
      await clients[0].wait(() => clients[0].snapshot.players[clients.indexOf(client)].ready);
    }
    clients[0].send("start");
    await Promise.all(clients.map(client => client.wait(() => client.snapshot.phase === "playing")));
    assert.equal(clients[0].snapshot.deck_count, 13);
    assert.deepEqual(clients.map(client => client.snapshot.hand.length), [6,5,5,5,5,5,5,5]);
    clients[0].close();
    await clients[1].wait(() => clients[1].snapshot.players[0].auto_play);
    await clients[1].wait(() => clients[1].snapshot.last?.seat === 0);
    const replacement = new Client(sessions[0], code);
    clients.push(replacement);
    await replacement.wait(() => replacement.snapshot?.players[0].online);
    assert.equal(replacement.snapshot.players[0].auto_play, true);
    replacement.send("resume");
    await replacement.wait(() => !replacement.snapshot.players[0].managed);
    replacement.send("end");
    await clients[1].wait(() => clients[1].snapshot.phase === "ended");
  } finally {
    clients.forEach(client => client.close());
  }
});

test("room creation validates round counts and exposes the default, custom, and unlimited options", async () => {
  for (const [options, limit] of [[{}, 8], [{ round_limit: 20 }, 20], [{ round_limit: 3 }, 3], [{ round_limit: null }, null]]) {
    const session = await guest("局数玩家");
    const created = await api("/api/rooms", options, session.token);
    assert.equal(created.status, 200);
    const client = new Client(session, created.body.code);
    try {
      await client.wait(() => !!client.snapshot);
      assert.equal(client.snapshot.round_limit, limit);
    } finally {
      client.close();
      await api(`/api/rooms/${created.body.code}/leave`, {}, session.token);
    }
  }
  const session = await guest("无效局数");
  for (const round_limit of [0, -1, 1.5, "8"]) {
    const response = await fetch(`${base}/api/rooms`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.token}` }, body: JSON.stringify({ round_limit }) });
    assert.ok(response.status >= 400);
  }
});

test("two-player settlement uses remaining cards and bombs, balances totals, and retains a departing seat", async () => {
  const sessions = await Promise.all([guest("计分房主"), guest("计分朋友"), guest("替补玩家")]);
  const { body: { code } } = await api("/api/rooms", { round_limit: 8 }, sessions[0].token);
  await api(`/api/rooms/${code}/join`, {}, sessions[1].token);
  const clients = sessions.slice(0, 2).map(session => new Client(session, code));
  try {
    await Promise.all(clients.map(c => c.wait(() => c.snapshot?.players.every(p => p.online))));
    assert.deepEqual(clients[0].snapshot.players.map(p => p.score), [0,0]);
    clients[1].send("ready");
    await clients[0].wait(() => clients[0].snapshot.players.every(p => p.ready));
    clients[0].send("start");
    await Promise.all(clients.map(c => c.wait(() => c.snapshot.phase === "playing")));
    for (let turn=0; turn<500 && clients[0].snapshot.phase === "playing"; turn++) {
      // Keep the automated test below the server's per-connection input rate limit.
      await new Promise(resolve => setTimeout(resolve, 200));
      const actor = clients[clients[0].snapshot.turn];
      await actor.wait(() => actor.snapshot.version === clients[0].snapshot.version);
      const count = actor.messages.length;
      actor.send("hint");
      await actor.wait(() => actor.messages.slice(count).some(m => m.type === "hint"));
      const cards = actor.messages.slice(count).find(m => m.type === "hint").cards;
      const version = actor.snapshot.version;
      actor.send(cards.length ? "play" : "pass", cards);
      await Promise.all(clients.map(c => c.wait(() => c.snapshot.version > version)));
    }
    const result = clients[0].snapshot;
    assert.equal(result.phase, "finished");
    assert.equal(result.result.reduce((sum,score) => sum+score,0), 0);
    assert.equal(result.players.reduce((sum,p) => sum+p.score,0), 0);
    if (result.winner !== -1) {
      const loser = 1-result.winner;
      const loss = result.players[loser].count * result.multiplier;
      assert.equal(result.result[loser], -loss);
      assert.equal(result.result[result.winner], loss);
    }
    const scores = result.players.map(p => p.score);
    await api(`/api/rooms/${code}/leave`, {}, sessions[1].token);
    await clients[0].wait(() => !clients[0].snapshot.players[1].online);
    assert.equal(clients[0].snapshot.players.length, 2);
    assert.deepEqual(clients[0].snapshot.players.map(p => p.score), scores);
    assert.equal((await api(`/api/rooms/${code}/join`, {}, sessions[2].token)).status, 200);
    const waiting = new Client(sessions[2], code);
    clients.push(waiting);
    await waiting.wait(() => waiting.snapshot?.players[2].pending);
    assert.equal(waiting.snapshot.hand, null);
    assert.equal(waiting.snapshot.players[2].score, 0);
    await clients[0].wait(() => clients[0].snapshot.players[2]?.online);
    clients[0].send("next");
    await waiting.wait(() => waiting.snapshot.phase === "playing" && !waiting.snapshot.players[2].pending);
    assert.ok(waiting.snapshot.hand.length >= 5);
    await clients[0].wait(() => clients[0].snapshot.round === 2);
    clients[0].send("end");
    await clients[0].wait(() => clients[0].snapshot.phase === "ended");
    assert.equal(clients[0].snapshot.final_scores.reduce((sum,p) => sum+p.score,0), 0);
  } finally {
    clients.forEach(c => c.close());
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

test("host controls robots and mid-round arrivals wait privately and may leave", async () => {
  const host=await guest("机器人房主"), visitor=await guest("等待朋友");
  const {body:{code}}=await api("/api/rooms",{},host.token);
  const a=new Client(host,code), clients=[a];
  try {
    await a.wait(()=>!!a.snapshot);
    a.send("set_bots",[],{bot_count:2});
    await a.wait(()=>a.snapshot.players.length===3);
    assert.equal(a.snapshot.players.filter(p=>p.bot).length,2);
    a.send("start");await a.wait(()=>a.snapshot.phase==="playing");
    const hand=a.snapshot.hand;
    assert.equal((await api(`/api/rooms/${code}/join`,{},visitor.token)).status,200);
    const b=new Client(visitor,code);clients.push(b);
    await b.wait(()=>b.snapshot?.players[3].pending);
    await a.wait(()=>a.snapshot.players.length===4);
    assert.deepEqual(a.snapshot.hand,hand);
    assert.equal(b.snapshot.hand,null);
    b.send("hint");await b.wait(()=>b.messages.some(m=>m.error?.includes("下一局")));
    assert.equal((await api(`/api/rooms/${code}/leave`,{},visitor.token)).status,200);
    await a.wait(()=>a.snapshot.players.length===3);
    a.send("set_bots",[],{bot_count:0});
    await a.wait(()=>a.snapshot.bot_target===0);
    assert.equal(a.snapshot.players.filter(p=>p.bot).length,2);
    a.send("end");await a.wait(()=>a.snapshot.phase==="ended");
  } finally {clients.forEach(c=>c.close());}
});
