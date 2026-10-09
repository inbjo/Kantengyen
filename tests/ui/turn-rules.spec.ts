import { test, expect } from "@playwright/test";

test("current player stays prominent on desktop and phone, including automated seats", async ({ page }) => {
  let publish: (turn: number) => void = () => {};
  await page.routeWebSocket("**/api/ws", socket => {
    let version = 0;
    let code = "1234";
    publish = turn => socket.send(JSON.stringify({
      type: "snapshot", code, practice: true, host: "human", seat: 0, round: 1,
      version: ++version, phase: "playing", deadline_ms: Date.now() + 3000,
      completed_rounds: 0, abandoned_round: false, final_scores: [],
      players: ["human", "bot", "offline"].map(id => ({ id, name: id, avatar_seed: id,
        bot: id === "bot", ready: true, online: id !== "offline", score: 0, count: 5 })),
      hand: [0, 1, 2, 3, 4], turn, auto_pass_available: false, last: null,
      deck_count: 38, multiplier: 1, winner: null, result: [], message: "出牌测试", history: [],
    }));
    socket.onMessage(raw => {
      const auth = JSON.parse(String(raw));
      if (auth.token) { code = auth.code; publish(0); }
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "我会玩了，直接去大厅" }).click();
  await page.getByRole("button", { name: /先练三把/ }).click();
  for (const [width, height] of [[1280, 800], [844, 390], [390, 844]]) {
    await page.setViewportSize({ width, height });
    for (const turn of [0, 1, 2]) {
      publish(turn);
      const active = page.locator(turn === 0 ? ".self-seat.active" : ".opponent.active");
      await expect(active).toHaveCount(1);
      await expect(active.locator(".turn-badge")).toHaveText("出牌中");
      await expect(page.locator(".turn-badge")).toHaveCount(1);
      expect(await active.evaluate(el => getComputedStyle(el).outlineWidth)).toBe("2px");
      expect(await active.evaluate(el => getComputedStyle(el).opacity)).toBe("1");
      const badge = await active.locator(".turn-badge").boundingBox();
      expect(badge).not.toBeNull();
      expect(badge!.x).toBeGreaterThanOrEqual(0);
      expect(badge!.y).toBeGreaterThanOrEqual(0);
      expect(badge!.x + badge!.width).toBeLessThanOrEqual(width);
      expect(badge!.y + badge!.height).toBeLessThanOrEqual(height);
    }
    await page.screenshot({ path: `test-results/turn-highlight-${width}.png` });
  }
});

test("closed-hand settlement explains ten points times bomb multiplier", async ({ page }) => {
  await page.routeWebSocket("**/api/ws", socket => socket.onMessage(raw => {
    const auth = JSON.parse(String(raw));
    if (!auth.token) return;
    const players = [{ id: "me", name: "赢家", score: 40 }, { id: "friend", name: "朋友", score: -40 }];
    socket.send(JSON.stringify({ type: "snapshot", code: auth.code, practice: false, host: "me", seat: 0,
      round: 8, version: 1, phase: "ended", deadline_ms: 0, completed_rounds: 8, abandoned_round: false,
      players: players.map(p => ({ ...p, avatar_seed: p.id, bot: false, online: true, ready: true, count: 0 })),
      final_scores: players.map((p, i) => ({ ...p, avatar_seed: p.id, rank: i + 1 })),
      hand: [], turn: null, last: null, auto_pass_available: false, deck_count: 0, multiplier: 1,
      winner: null, result: [], message: "结束", history: [], settlement: { round: 8, multiplier: 4, winner: 0,
        entries: [{ ...players[0], remaining: 0, delta: 40, contribution: 0, closed: false },
          { ...players[1], remaining: 5, delta: -40, contribution: 40, closed: true }] },
    }));
  }));
  await page.goto("/");
  await page.getByRole("button", { name: "我会玩了，直接去大厅" }).click();
  await page.getByRole("button", { name: /创建房间/ }).click();
  await page.getByRole("button", { name: "确认开桌" }).click();
  await expect(page.locator(".settlement-detail")).toContainText("关门 10 分 × 4，扣 40 分");
  await expect(page.locator(".settlement-detail")).toContainText("收取 朋友 40 分 = +40 分");
});
