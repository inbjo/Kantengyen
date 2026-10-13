import { test, expect } from "@playwright/test";

test.use({ serviceWorkers: "block" });

test("game and outcome music switch at sixty percent and respect mute and visibility", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("kantengyen.speech_enabled", "false");
    const state = window as typeof window & { music: { track: string; loop: boolean; volume: number; stopped: boolean }[] };
    state.music = [];
    Object.defineProperty(window, "AudioContext", { value: class {
      state = "running"; sampleRate = 24000; destination = {}; currentTime = 0;
      resume() { return Promise.resolve(); }
      createBuffer() { return {}; }
      decodeAudioData(data: ArrayBuffer) { return Promise.resolve({ music: new TextDecoder().decode(data) }); }
      createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
      createBufferSource() {
        let record: { track: string; loop: boolean; volume: number; stopped: boolean } | undefined;
        let gain: { gain: { value: number } };
        return {
          buffer: null as { music?: string } | null, loop: false, onended: null,
          connect(node: typeof gain) { gain = node; }, disconnect() {},
          start() {
            if (!this.buffer?.music) return;
            record = { track: this.buffer.music, loop: this.loop, volume: gain.gain.value, stopped: false };
            state.music.push(record);
          },
          stop() { if (record) record.stopped = true; },
        };
      }
    } });
  });
  await page.route("**/assets/*.mp3", route => route.fulfill({
    body: new URL(route.request().url()).pathname.match(/\/(bg|winner|failed)-/)![1], contentType: "audio/mpeg",
  }));
  let publish: (phase: string, winner?: number | null) => void = () => {};
  await page.routeWebSocket("**/api/ws", socket => {
    let version = 0;
    publish = (phase, winner = 0) => socket.send(JSON.stringify({
      type: "snapshot", code: "1234", practice: true, host: "me", seat: 0, round: 1,
      version: ++version, phase, deadline_ms: 0, completed_rounds: 0, round_limit: 3,
      abandoned_round: false, final_scores: [], auto_pass_available: false,
      players: ["me", "bot"].map(id => ({ id, name: id, avatar_seed: id, bot: id === "bot", ready: true, online: true, score: 0, count: 5 })),
      hand: [0, 1, 2], turn: 0, last: null, deck_count: 8, multiplier: 1,
      winner: phase === "finished" ? winner : null, result: [0, 0], message: "音乐测试", history: [],
      settlement: phase === "ended" && winner !== null ? {
        round: 1, multiplier: 1, winner,
        entries: ["me", "bot"].map(id => ({ id, name: id, remaining: 0, closed: false, delta: 0, contribution: 0 })),
      } : null,
    }));
    socket.onMessage(raw => { if (JSON.parse(String(raw)).token) publish("waiting"); });
  });
  const music = () => page.evaluate(() => (window as typeof window & { music: { track: string; loop: boolean; volume: number; stopped: boolean }[] }).music);
  const activeMusic = () => music().then(tracks => tracks.filter(track => !track.stopped));
  await page.goto("/");
  await page.getByRole("button", { name: "我会玩了，直接去大厅" }).click();
  await page.getByRole("button", { name: /先练三把/ }).click();
  await expect(page.locator(".waiting-center")).toBeVisible();
  expect(await music()).toEqual([]);
  publish("playing");
  await expect.poll(activeMusic).toEqual([{ track: "bg", loop: true, volume: .6, stopped: false }]);
  publish("finished");
  await expect(page.locator(".result-card")).toBeVisible();
  await expect.poll(activeMusic).toEqual([{ track: "winner", loop: false, volume: .6, stopped: false }]);
  publish("finished", 1);
  await expect.poll(activeMusic).toEqual([{ track: "failed", loop: false, volume: .6, stopped: false }]);
  publish("finished", -1);
  await expect.poll(activeMusic).toEqual([]);
  publish("playing");
  await expect(page.locator(".result-card")).not.toBeVisible();
  await expect.poll(activeMusic).toEqual([{ track: "bg", loop: true, volume: .6, stopped: false }]);
  await page.getByRole("button", { name: "关闭音效" }).click();
  await expect.poll(async () => (await music()).at(-1)?.stopped).toBe(true);
  await page.getByRole("button", { name: "开启音效" }).click();
  await expect.poll(async () => (await music()).filter(m => !m.stopped).length).toBe(1);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(async () => (await music()).every(m => m.stopped)).toBe(true);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(async () => (await music()).filter(m => !m.stopped).length).toBe(1);
  publish("ended");
  await expect.poll(activeMusic).toEqual([{ track: "winner", loop: false, volume: .6, stopped: false }]);
  await page.getByRole("button", { name: "返回大厅", exact: true }).click();
  await expect.poll(async () => (await music()).every(m => m.stopped)).toBe(true);
});
