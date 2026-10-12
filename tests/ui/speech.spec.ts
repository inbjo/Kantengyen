import { test, expect, type Page } from "@playwright/test";
import { readdirSync, readFileSync } from "node:fs";
import type { Snapshot } from "../../web/src/types";
test.use({ serviceWorkers: "block" });

async function mockAudio(page: Page, autoEnd = false, touchOnly = false) {
  await page.addInitScript(({ autoEnd, touchOnly }) => {
    const state = window as typeof window & {
      spoken: string[]; speechCancels: number; completeAudioResume: () => void; interruptAudio: () => void;
    };
    state.spoken = []; state.speechCancels = 0;
    let activated = false;
    const contexts: { state: string }[] = [];
    const pending: (() => void)[] = [];
    state.completeAudioResume = () => { for (const resume of pending.splice(0)) resume(); };
    state.interruptAudio = () => { for (const context of contexts) context.state = "interrupted"; };
    const touch = (event: Event) => {
      if (event.type === "pointerup" && (event as PointerEvent).pointerType !== "touch") return;
      activated = true;
      setTimeout(() => { activated = false; }, 0);
    };
    document.addEventListener("pointerup", touch, true);
    document.addEventListener("touchend", touch, true);
    Object.defineProperty(window, "speechSynthesis", { configurable: true, value: undefined });
    Object.defineProperty(window, "AudioContext", { configurable: true, value: class {
      state = touchOnly ? "suspended" : "running"; sampleRate = 24000; currentTime = 0; destination = {};
      constructor() { contexts.push(this); }
      resume() {
        if (!touchOnly) return Promise.resolve();
        if (!activated) return Promise.reject(new Error("Touch activation required"));
        return new Promise<void>(resolve => { pending.push(() => { this.state = "running"; resolve(); }); });
      }
      createBuffer() { return {}; }
      decodeAudioData(data: ArrayBuffer) { return Promise.resolve({ key: new TextDecoder().decode(data) }); }
      createBufferSource() {
        return { buffer: null as { key?: string } | null, loop: false, onended: null as (() => void) | null,
          connect() {}, disconnect() {},
          start() {
            if (this.buffer?.key && !this.loop) state.spoken.push(this.buffer.key);
            if (autoEnd) setTimeout(() => this.onended?.(), 0);
          },
          stop() { if (this.buffer?.key) state.speechCancels++; },
        };
      }
      createGain() { return { connect() {}, disconnect() {}, gain: {
        value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {},
      } }; }
    } });
  }, { autoEnd, touchOnly });
}

test("confirmed plays are narrated once, independently muted and never replayed on refresh", async ({ page }) => {
  let release: () => void = () => {};
  const delayed = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/assets/*.wav", async route => {
    const key = new URL(route.request().url()).pathname.match(/\/(single-\d+|pair-\d+|[a-z_]+)-/)![1];
    if (key === "pair-6") await delayed;
    if (key === "single-8") return route.fulfill({ status: 503 });
    return route.fulfill({ status: 200, body: key, contentType: "audio/wav" });
  });
  await mockAudio(page);
  let publish: (kind: string, rank: number, cards: number[], phase?: string) => void = () => {};
  await page.routeWebSocket("**/api/ws", socket => {
    let version = 0;
    publish = (kind, rank, cards, phase = "playing") => socket.send(JSON.stringify({
      type: "snapshot", code: "1234", practice: true, host: "host", seat: 0, round: 1,
      version: ++version, phase, deadline_ms: 0, auto_pass_available: false,
      round_limit: null, completed_rounds: 0, abandoned_round: false, final_scores: [],
      players: ["host", "friend"].map(id => ({ id, name: id, avatar_seed: id, bot: false, ready: true, online: true, score: 0, count: 5 })),
      hand: [0, 1, 2, 12, 52, 53], turn: 1,
      last: { seat: 1, cards, pattern: { kind, rank, len: cards.length } },
      deck_count: 8, multiplier: 1, winner: null, result: [], message: "播报测试", history: [],
    }));
    socket.onMessage(raw => { if (JSON.parse(String(raw)).token) publish("single", 3, [0]); });
  });
  const spoken = () => page.evaluate(() => (window as typeof window & { spoken: string[] }).spoken);
  await page.setViewportSize({ width: 667, height: 375 });
  await page.goto("/");
  await page.getByRole("button", { name: "我会玩了，直接去大厅" }).click();
  await page.getByRole("button", { name: /先练三把/ }).click();
  await expect(page.getByRole("button", { name: "关闭出牌播报" })).toBeVisible();
  expect(await spoken()).toEqual([]);
  await page.getByRole("button", { name: "关闭音效" }).click();
  const samples = [
    ["single", 4, [1], "single-4"], ["single", 11, [8], "single-11"],
    ["single", 12, [9], "single-12"], ["single", 13, [10], "single-13"],
    ["single", 14, [11], "single-14"], ["single", 15, [12], "single-15"],
    ["pair", 3, [0, 52], "pair-3"], ["straight", 3, [0, 1, 2], "straight"],
    ["bomb", 6, [3, 16, 29], "bomb"], ["deep_bomb", 7, [4, 17, 30, 43], "deep_bomb"],
  ] as const;
  for (const [kind, rank, cards, text] of samples) {
    const before = (await spoken()).length;
    publish(kind, rank, [...cards]);
    await expect.poll(async () => (await spoken()).at(-1)).toBe(text);
    publish(kind, rank, [...cards]); // pass, heartbeat or duplicate snapshot
    await page.waitForTimeout(60);
    expect((await spoken()).length).toBe(before + 1);
  }
  await page.getByRole("button", { name: "关闭出牌播报" }).click();
  const count = (await spoken()).length;
  publish("single", 5, [2]);
  await page.waitForTimeout(100);
  expect((await spoken()).length).toBe(count);
  await page.getByRole("button", { name: "开启出牌播报" }).click();
  expect((await spoken()).length).toBe(count); // toggling does not narrate the old play
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, value: true }); });
  publish("pair", 8, [5, 18]);
  await page.waitForTimeout(100);
  expect((await spoken()).length).toBe(count);
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, value: false }); });
  publish("pair", 6, [3, 16]); // Still downloading: the next play must invalidate it.
  await page.waitForTimeout(60);
  publish("single", 7, [4]);
  await expect.poll(async () => (await spoken()).at(-1)).toBe("single-7");
  release();
  await page.waitForTimeout(100);
  expect((await spoken()).length).toBe(count + 1);
  publish("single", 8, [5]); // An unavailable clip silently skips playback.
  await page.waitForTimeout(100);
  expect((await spoken()).length).toBe(count + 1);
  await page.getByRole("button", { name: "关闭出牌播报" }).click();
  await page.reload();
  await expect(page.getByRole("button", { name: "开启出牌播报" })).toHaveAttribute("aria-pressed", "false");
  expect(await spoken()).toEqual([]);
  await page.getByRole("button", { name: "开启出牌播报" }).click();
  publish("single", 4, [1]);
  await expect.poll(spoken).toEqual(["single-4"]);
  const cancels = await page.evaluate(() => (window as typeof window & { speechCancels: number }).speechCancels);
  publish("single", 4, [1], "ended");
  await expect.poll(() => page.evaluate(() => (window as typeof window & { speechCancels: number }).speechCancels)).toBeGreaterThan(cancels);
  expect(await spoken()).toEqual(["single-4"]);
  await page.reload();
  await expect(page.getByRole("button", { name: /返回上次的房间/ })).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("kantengyen.speech_enabled")!))).toBe(true);
  expect(await spoken()).toEqual([]);
});

test("all bundled recordings are served as audio and decode in a real browser", async ({ page, browserName }) => {
  test.skip(browserName === "webkit" && process.platform === "win32", "Windows WebKit port does not provide Web Audio; native Safari playback needs a device check");
  const files = readdirSync("web/dist/assets").filter(name => name.endsWith(".wav"));
  const manifest = JSON.parse(readFileSync("web/src/assets/announcements/manifest.json", "utf8"));
  expect(manifest.reference).toBe("a2668620c00aa49383255473ec31e483.wav");
  expect(manifest.reference_sha256).toBe("9b30f62e7dac882a26113ac9efb13d0ebbed3a2a64ca36766d70e22c0f92bffb");
  expect(files).toHaveLength(Object.keys(manifest.clips).length);
  expect(manifest.clips).toMatchObject({ "single-11": "勾", "single-12": "圈", "single-14": "尖", "pair-11": "对勾", "pair-12": "对圈", "pair-14": "对尖", deep_bomb: "四张炸弹" });
  await page.goto("/");
  const clips = await page.evaluate(async names => {
    const context = new AudioContext();
    try {
      return await Promise.all(names.map(async name => {
        const response = await fetch(`/assets/${name}`);
        if (!response.ok || response.headers.get("content-type") !== "audio/wav") throw new Error(name);
        const buffer = await context.decodeAudioData(await response.arrayBuffer());
        return { duration: buffer.duration, audible: buffer.getChannelData(0).some(sample => Math.abs(sample) > .01) };
      }));
    } finally { await context.close(); }
  }, files);
  for (const clip of clips) {
    expect(clip.duration).toBeGreaterThan(.1);
    expect(clip.duration).toBeLessThan(6);
    expect(clip.audible).toBe(true);
  }
});

test("confirmed passes, round cues and two private deadline reminders play without replay", async ({ page }) => {
  await page.addInitScript(() => {
    Math.random = () => (window as typeof window & { passVoiceRandom?: number }).passVoiceRandom ?? 0;
  });
  await mockAudio(page, true);
  await page.route("**/assets/*.wav", route => {
    const key = new URL(route.request().url()).pathname.match(/\/(single-\d+|pair-\d+|[a-z_]+)-/)![1];
    return route.fulfill({ status: 200, body: key, contentType: "audio/wav" });
  });
  let snapshot: Snapshot = {
    type: "snapshot", code: "1234", practice: false, host: "host", seat: 0, round: 1,
    version: 0, phase: "waiting", deadline_ms: 0, auto_pass_available: false,
    round_limit: 8, completed_rounds: 0, abandoned_round: false, final_scores: [],
    players: ["host", "friend"].map(id => ({ id, name: id, avatar_seed: id, bot: false, ready: true, online: true, score: 0, count: 5 })),
    hand: [0, 1, 2, 12, 52, 53], turn: 1, last: null,
    deck_count: 8, multiplier: 1, winner: null, result: [], message: "播报测试", history: [],
  };
  let publish: (patch?: Partial<Snapshot>) => void = () => {};
  await page.routeWebSocket("**/api/ws", socket => {
    publish = (patch = {}) => {
      snapshot = { ...snapshot, ...patch, version: snapshot.version + 1 };
      socket.send(JSON.stringify(snapshot));
    };
    socket.onMessage(raw => { if (JSON.parse(String(raw)).token) publish(); });
  });
  const spoken = () => page.evaluate(() => (window as typeof window & { spoken: string[] }).spoken);
  await page.goto("/");
  await page.getByRole("button", { name: "我会玩了，直接去大厅" }).click();
  await page.getByRole("button", { name: /先练三把/ }).click();
  await expect(page.locator(".waiting-center h2")).toBeVisible();
  await page.getByRole("button", { name: "关闭音效" }).click();
  publish({ phase: "playing" });
  await expect.poll(spoken).toEqual(["game_start"]);
  publish({ turn: 0, last: { seat: 1, cards: [8, 21], pattern: { kind: "pair", rank: 11, len: 2 } },
    players: snapshot.players.map((player, seat) => ({ ...player, count: seat === 1 ? 1 : 5 })) });
  await expect.poll(spoken).toEqual(["game_start", "pair-11", "one_left", "your_turn"]);
  publish({ turn: 1, history: ["host 要不起，自动过牌"] });
  await expect.poll(async () => (await spoken()).at(-1)).toBe("pass");
  await page.evaluate(() => { (window as typeof window & { passVoiceRandom: number }).passVoiceRandom = .5; });
  publish({ turn: 0, last: null, history: ["host 要不起，自动过牌", "friend 过牌"] });
  await expect.poll(async () => (await spoken()).at(-1)).toBe("your_turn");
  expect((await spoken()).at(-2)).toBe("cannot_play");
  publish({ turn: 1, last: { seat: 0, cards: [0], pattern: { kind: "single", rank: 3, len: 1 } } });
  await expect.poll(async () => (await spoken()).at(-1)).toBe("single-3");
  await page.evaluate(() => { (window as typeof window & { passVoiceRandom: number }).passVoiceRandom = .99; });
  publish({ turn: 0, auto_pass_available: true, history: ["friend 要不起，自动过牌"] });
  await expect.poll(async () => (await spoken()).at(-1)).toBe("decline");
  publish({ phase: "finished", winner: 0,
    last: { seat: 0, cards: [11], pattern: { kind: "single", rank: 14, len: 1 } } });
  await expect.poll(async () => (await spoken()).slice(-3)).toEqual(["single-14", "round_end", "you_win"]);
  await page.clock.install();
  const deadline = await page.evaluate(() => Date.now() + 30_000);
  publish({ phase: "playing", round: 2, last: null, winner: null, deadline_ms: deadline, auto_pass_available: false });
  await expect.poll(async () => (await spoken()).slice(-2)).toEqual(["again", "your_turn"]);
  await page.clock.runFor(20_100);
  await expect.poll(async () => (await spoken()).at(-1)).toBe("hurry");
  await page.clock.runFor(5_000);
  await expect.poll(async () => (await spoken()).at(-1)).toBe("time_warning");
  const count = (await spoken()).length;
  publish();
  await page.clock.runFor(2_000);
  expect((await spoken()).length).toBe(count);
  publish({ turn: 1 });
  await page.waitForTimeout(100);
  const beforeUnplayable = (await spoken()).length;
  publish({ turn: 0, auto_pass_available: true });
  await page.waitForTimeout(100);
  expect((await spoken()).slice(beforeUnplayable)).not.toContain("your_turn");
  publish({ auto_pass_available: false, players: snapshot.players.map((p, i) => ({ ...p, managed: i === 0, auto_play: i === 0 })) });
  await page.waitForTimeout(100);
  expect((await spoken()).slice(beforeUnplayable)).not.toContain("your_turn");
  publish({ players: snapshot.players.map(p => ({ ...p, managed: false, auto_play: false })) });
  await expect.poll(async () => (await spoken()).at(-1)).toBe("your_turn");
  await page.reload();
  await expect(page.getByRole("button", { name: "关闭出牌播报" })).toBeVisible();
  expect(await spoken()).toEqual([]);
});

test.describe("touch audio activation", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 844, height: 390 } });

  async function room(page: Page) {
    let publish: (rank: number) => void = () => {};
    await page.routeWebSocket("**/api/ws", socket => {
      let version = 0;
      publish = rank => socket.send(JSON.stringify({
        type: "snapshot", code: "1234", practice: true, host: "host", seat: 0, round: 1,
        version: ++version, phase: "playing", deadline_ms: 0, auto_pass_available: false,
        round_limit: null, completed_rounds: 0, abandoned_round: false, final_scores: [],
        players: ["host", "friend"].map(id => ({ id, name: id, avatar_seed: id, bot: false, ready: true, online: true, score: 0, count: 5 })),
        hand: [0, 1, 2, 12, 52, 53], turn: 1,
        last: { seat: 1, cards: [rank - 3], pattern: { kind: "single", rank, len: 1 } },
        deck_count: 8, multiplier: 1, winner: null, result: [], message: "触摸播报测试", history: [],
      }));
      socket.onMessage(raw => { if (JSON.parse(String(raw)).token) publish(3); });
    });
    await page.goto("/");
    await page.getByRole("button", { name: "我会玩了，直接去大厅" }).tap();
    await page.getByRole("button", { name: /先练三把/ }).tap();
    await expect(page.getByRole("button", { name: "关闭出牌播报" })).toBeVisible();
    await page.getByRole("button", { name: "关闭音效" }).tap();
    return (rank: number) => publish(rank);
  }

  test("touch-up unlock waits for resume and recovers from iOS interrupted state", async ({ page }) => {
    await mockAudio(page, false, true);
    await page.route("**/assets/*.wav", route => {
      const key = new URL(route.request().url()).pathname.match(/\/(single-\d+|pair-\d+|[a-z_]+)-/)![1];
      return route.fulfill({ status: 200, body: key, contentType: "audio/wav" });
    });
    const publish = await room(page);
    const spoken = () => page.evaluate(() => (window as typeof window & { spoken: string[] }).spoken);
    publish(4);
    await page.waitForTimeout(100);
    expect(await spoken()).toEqual([]);
    await page.evaluate(() => (window as typeof window & { completeAudioResume: () => void }).completeAudioResume());
    await expect.poll(spoken).toEqual(["single-4"]);
    await page.evaluate(() => (window as typeof window & { interruptAudio: () => void }).interruptAudio());
    await page.locator(".room-label").tap();
    publish(5);
    await page.waitForTimeout(100);
    expect(await spoken()).toEqual(["single-4"]);
    await page.evaluate(() => (window as typeof window & { completeAudioResume: () => void }).completeAudioResume());
    await expect.poll(spoken).toEqual(["single-4", "single-5"]);
  });

  test("native audio context runs and plays decoded recordings after a real tap", async ({ page, browserName }) => {
    test.skip(browserName === "webkit" && process.platform === "win32", "Windows WebKit port does not provide Web Audio; native Safari playback needs a device check");
    await page.addInitScript(() => {
      const state = window as typeof window & { recordedStarts: number; recordedStates: string[] };
      state.recordedStarts = 0; state.recordedStates = [];
      const start = AudioBufferSourceNode.prototype.start;
      AudioBufferSourceNode.prototype.start = function (...args: Parameters<typeof start>) {
        if (this.buffer && this.buffer.duration > .1) {
          state.recordedStarts++;
          state.recordedStates.push(this.context.state);
        }
        return start.apply(this, args);
      };
    });
    const publish = await room(page);
    publish(4);
    await expect.poll(() => page.evaluate(() => (window as typeof window & { recordedStarts: number }).recordedStarts)).toBe(1);
    expect(await page.evaluate(() => (window as typeof window & { recordedStates: string[] }).recordedStates)).toEqual(["running"]);
  });
});
