import { test, expect } from "@playwright/test";

test("room-not-found feedback stays inside the modal and avatar credit is removed", async ({ page }) => {
  await page.setViewportSize({ width: 667, height: 375 });
  await page.route("**/api/rooms/9999/join", route => route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "没有找到这个房间，请检查四位房间号" }) }));
  await page.goto("/");
  await page.getByRole("button", { name: "我会玩了，直接去大厅" }).click();
  await expect(page.getByText(/头像由|Multiavatar/)).toHaveCount(0);
  await page.getByRole("button", { name: /加入房间/ }).click();
  await page.getByLabel("四位房间号").fill("9999");
  await page.getByRole("button", { name: "加入房间", exact: true }).click();
  const feedback = page.getByRole("dialog").getByRole("alert");
  await expect(feedback).toHaveText("没有找到这个房间，请检查四位房间号");
  expect(await feedback.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
  })).toBe(true);
  await page.waitForTimeout(4700);
  await expect(feedback).toBeVisible();
  await page.screenshot({ path: "test-results/join-error-phone.png" });
  await page.getByLabel("四位房间号").fill("1234");
  await expect(feedback).toHaveCount(0);
});

test("card effects are distinct, do not repeat on pass, and sound toggle persists", async ({ page }) => {
  await page.addInitScript(() => {
    const state = window as typeof window & { audioNotes: number };
    state.audioNotes = 0;
    const create = AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator = function () {
      state.audioNotes++;
      return create.call(this);
    };
  });
  let publish: (kind: string, rank: number, cards: number[]) => void = () => {};
  await page.routeWebSocket("**/api/ws", socket => {
    let version = 0;
    const snapshot = (kind: string, rank: number, cards: number[]) => socket.send(JSON.stringify({
      type: "snapshot", code: "1234", practice: true, host: "host", seat: 0, round: 1,
      version: ++version, phase: "playing", deadline_ms: 0, auto_pass_available: false,
      players: ["host", "friend"].map(id => ({ id, name: id, avatar_seed: id, bot: false, ready: true, online: true, score: 0, count: 5 })),
      hand: [0, 1, 2, 12, 52, 53], turn: 1,
      last: { seat: 1, cards, pattern: { kind, rank, len: cards.length } },
      deck_count: 8, multiplier: 1, winner: null, result: [], message: "特效测试", history: [],
    }));
    publish = snapshot;
    socket.onMessage(raw => {
      if (JSON.parse(String(raw)).token) snapshot("single", 3, [0]);
    });
  });
  await page.setViewportSize({ width: 844, height: 390 });
  await page.goto("/");
  await page.getByRole("button", { name: "我会玩了，直接去大厅" }).click();
  await page.getByRole("button", { name: /先练三把/ }).click();
  await expect(page.getByRole("img", { name: "房主", exact: true })).toHaveCount(1);
  const smallJoker = page.getByRole("button", { name: "小王（万能牌）", exact: true });
  const bigJoker = page.getByRole("button", { name: "大王（万能牌）", exact: true });
  await expect(smallJoker.locator(".mono-joker")).toBeVisible();
  await expect(bigJoker.locator(".color-joker")).toBeVisible();
  for (const [width, height] of [[1280, 800], [844, 390], [667, 375], [390, 844]]) {
    await page.setViewportSize({ width, height });
    for (const joker of [smallJoker, bigJoker]) {
      expect(await joker.locator(".joker-corner").evaluate(element =>
        getComputedStyle(element).fontSize === getComputedStyle(element.querySelector("small")!).fontSize
      )).toBe(true);
    }
  }
  await page.setViewportSize({ width: 844, height: 390 });
  await smallJoker.click();
  await expect(smallJoker).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "重选", exact: true }).click();
  await page.locator(".hand-cards").screenshot({ path: "test-results/jokers-phone.png" });
  await expect(page.locator(".play-effect")).toHaveCount(0);
  for (const [kind, rank, cards, effect] of [
    ["bomb", 6, [3, 16, 29], "bomb"],
    ["deep_bomb", 7, [4, 17, 30, 43], "deep_bomb"],
    ["single", 15, [12], "two"],
    ["straight", 3, [0, 1, 2], "straight"],
    ["pair", 8, [5, 18], "pair"],
  ] as const) {
    publish(kind, rank, [...cards]);
    const animation = page.locator(`[data-effect="${effect}"]`);
    await expect(animation).toBeVisible();
    if (effect === "two") {
      for (const [card, name] of [[52, "小王（万能牌）"], [53, "大王（万能牌）"]] as const) {
        publish("pair", 3, [0, card]);
        const tableJoker = page.getByRole("img", { name, exact: true });
        await expect(tableJoker).toBeVisible();
        expect(await tableJoker.locator(".joker-corner").evaluate(element =>
          getComputedStyle(element).fontSize === getComputedStyle(element.querySelector("small")!).fontSize
        )).toBe(true);
      }
      publish(kind, rank, [...cards]);
    }
    if (effect === "bomb") {
      await page.waitForTimeout(240);
      await page.screenshot({ path: "test-results/bomb-effect-phone.png" });
    }
    await expect(animation).toHaveCount(0, { timeout: 2500 });
    publish(kind, rank, [...cards]); // Same last play, as with a pass or reconnect.
    await page.waitForTimeout(120);
    await expect(page.locator(".play-effect")).toHaveCount(0);
  }
  expect(await page.evaluate(() => (window as typeof window & { audioNotes: number }).audioNotes)).toBeGreaterThan(0);
  await page.getByRole("button", { name: "关闭音效" }).click();
  await expect(page.getByRole("button", { name: "开启音效" })).toHaveAttribute("aria-pressed", "false");
  const notes = await page.evaluate(() => (window as typeof window & { audioNotes: number }).audioNotes);
  publish("single", 15, [25]);
  await expect(page.locator('[data-effect="two"]')).toBeVisible();
  expect(await page.evaluate(() => (window as typeof window & { audioNotes: number }).audioNotes)).toBe(notes);
  await page.reload();
  await expect(page.getByRole("button", { name: "开启音效" })).toBeVisible();
  await page.getByRole("button", { name: /返回上次的房间/ }).click();
  await expect(page.locator(".hand-cards .playing-card")).toHaveCount(6);
  await expect(page.locator(".play-effect")).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  publish("bomb", 9, [6, 19, 32]);
  await expect(page.locator(".play-effect")).toBeVisible();
  expect(await page.locator(".effect-ring").first().evaluate(element => getComputedStyle(element).display)).toBe("none");
});
