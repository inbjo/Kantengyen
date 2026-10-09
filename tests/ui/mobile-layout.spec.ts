import { test, expect } from "@playwright/test";

test("Safari-sized landscape keeps played cards separate from the hand and simplifies takeover", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(document, "fullscreenEnabled", { value: false });
    Object.defineProperty(navigator, "userAgent", { value: "iPhone Safari" });
  });
  await page.routeWebSocket("**/api/ws", socket => {
    let code = "1234", version = 0, managed = false;
    const publish = () => socket.send(JSON.stringify({
      type: "snapshot", code, practice: false, host: "me", seat: 0, round: 3, round_limit: 8,
      version: ++version, phase: "playing", deadline_ms: Date.now() + 30000,
      completed_rounds: 2, abandoned_round: false, final_scores: [],
      players: ["me", "bot1", "bot2", "bot3", "bot4"].map(id => ({
        id, name: id, avatar_seed: id, bot: id !== "me", managed: id === "me" && managed,
        auto_play: id !== "me" || managed,
        ready: true, online: true, score: 0, count: 5,
      })),
      hand: [0, 15, 30, 20, 49], turn: 0, auto_pass_available: false,
      last: { seat: 4, cards: [1], pattern: { kind: "single", rank: 4, len: 1 } },
      deck_count: 28, multiplier: 1, winner: null, result: [], message: "出牌成功", history: [],
    }));
    socket.onMessage(raw => {
      const message = JSON.parse(String(raw));
      if (message.token) { code = message.code; publish(); }
      if (message.action === "takeover" || message.action === "resume") {
        managed = message.action === "takeover";
        publish();
      }
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "我会玩了，直接去大厅" }).click();
  await page.getByRole("button", { name: /创建房间/ }).click();
  await page.getByRole("button", { name: "确认开桌" }).click();
  await expect(page.locator(".hand-cards .playing-card")).toHaveCount(5);
  for (const [width, height] of [[844, 292], [667, 280], [1024, 342], [844, 390], [390, 844]]) {
    await page.setViewportSize({ width, height });
    const discard = await page.locator(".play-center").boundingBox();
    const caption = await page.locator(".turn-caption").boundingBox();
    expect(discard!.y + discard!.height).toBeLessThanOrEqual(caption!.y);
    const meta = await page.locator(".table-meta").boundingBox();
    expect(meta!.height).toBeLessThan(32);
    for (const selector of [".hand-cards", ".hand-actions", ".self-seat"]) {
      const rect = await page.locator(selector).boundingBox();
      expect(rect!.y + rect!.height).toBeLessThanOrEqual(height);
      expect(rect!.x).toBeGreaterThanOrEqual(0);
      expect(rect!.x + rect!.width).toBeLessThanOrEqual(width);
    }
    if (height === 292) await page.screenshot({ path: "test-results/safari-short-landscape.png" });
  }
  await page.getByRole("button", { name: "开启托管", exact: true }).click();
  await expect(page.getByRole("button", { name: "取消托管", exact: true })).toBeVisible();
  await expect(page.locator(".table-meta")).not.toContainText("机器正在代打");
  await page.getByRole("button", { name: "取消托管", exact: true }).click();
  await expect(page.getByRole("button", { name: "开启托管", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "切换全屏" }).click();
  await expect(page.locator(".toast")).toContainText("添加到主屏幕");
});
