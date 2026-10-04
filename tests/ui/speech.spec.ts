import { test, expect } from "@playwright/test";

test("confirmed plays are narrated once, independently muted and never replayed on refresh", async ({ page }) => {
  await page.addInitScript(() => {
    const state = window as typeof window & { spoken: string[]; speechCancels: number; noChinese: boolean };
    state.spoken = []; state.speechCancels = 0; state.noChinese = false;
    Object.defineProperty(window, "speechSynthesis", { configurable: true, value: {
      getVoices: () => state.noChinese ? [] : [{ lang: "zh-CN", name: "测试中文", localService: true }],
      speak: (utterance: SpeechSynthesisUtterance) => { if (utterance.text.trim()) state.spoken.push(utterance.text); },
      cancel: () => { state.speechCancels++; },
    } });
    Object.defineProperty(window, "SpeechSynthesisUtterance", { configurable: true, value: class { constructor(public text: string) {} } });
  });
  let publish: (kind: string, rank: number, cards: number[], phase?: string) => void = () => {};
  await page.routeWebSocket("**/api/ws", socket => {
    let version = 0;
    publish = (kind, rank, cards, phase = "playing") => socket.send(JSON.stringify({
      type: "snapshot", code: "1234", practice: true, host: "host", seat: 0, round: 1,
      version: ++version, phase, deadline_ms: 0, auto_pass_available: false,
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
    ["single", 4, [1], "四"], ["single", 11, [8], "J"],
    ["single", 12, [9], "Q"], ["single", 13, [10], "K"],
    ["single", 14, [11], "A"], ["single", 15, [12], "二"],
    ["pair", 3, [0, 52], "对三"], ["straight", 3, [0, 1, 2], "顺子"],
    ["bomb", 6, [3, 16, 29], "炸弹"], ["deep_bomb", 7, [4, 17, 30, 43], "深水炸弹"],
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
  await page.evaluate(() => { (window as typeof window & { noChinese: boolean }).noChinese = true; });
  publish("pair", 6, [3, 16]);
  await page.waitForTimeout(100);
  expect((await spoken()).length).toBe(count);
  await page.evaluate(() => { Object.defineProperty(window, "speechSynthesis", { configurable: true, value: undefined }); });
  publish("single", 7, [4]); // Browser without a working synthesis service still plays normally.
  await page.waitForTimeout(100);
  expect((await spoken()).length).toBe(count);
  await page.getByRole("button", { name: "关闭出牌播报" }).click();
  await page.reload();
  await page.getByRole("button", { name: /返回上次的房间/ }).click();
  await expect(page.getByRole("button", { name: "开启出牌播报" })).toHaveAttribute("aria-pressed", "false");
  expect(await spoken()).toEqual([]);
  await page.getByRole("button", { name: "开启出牌播报" }).click();
  publish("single", 4, [1]);
  await expect.poll(spoken).toEqual(["四"]);
  const cancels = await page.evaluate(() => (window as typeof window & { speechCancels: number }).speechCancels);
  publish("single", 4, [1], "ended");
  await expect.poll(() => page.evaluate(() => (window as typeof window & { speechCancels: number }).speechCancels)).toBeGreaterThan(cancels);
  expect(await spoken()).toEqual(["四"]);
  await page.reload();
  await page.getByRole("button", { name: /返回上次的房间/ }).click();
  await expect(page.getByRole("button", { name: "关闭出牌播报" })).toHaveAttribute("aria-pressed", "true");
  expect(await spoken()).toEqual([]);
});
