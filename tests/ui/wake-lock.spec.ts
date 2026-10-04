import { test, expect, type Page } from "@playwright/test";

async function createRoom(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "我会玩了，直接去大厅" }).click();
  await page.getByRole("button", { name: /创建房间/ }).click();
  await page.getByRole("button", { name: "确认开桌" }).click();
  await expect(page.locator(".waiting-center h2")).toBeVisible();
}

async function mockWakeLock(page: Page, deferred = false) {
  await page.addInitScript(({ deferred }) => {
    const state = window as typeof window & {
      wakeRequests: number; wakeReleases: number; grantWakeLock?: () => void;
      revokeWakeLock?: () => void; setPageVisible?: (visible: boolean) => void;
    };
    state.wakeRequests = 0;
    state.wakeReleases = 0;
    let visible = true;
    Object.defineProperty(document, "visibilityState", { get: () => visible ? "visible" : "hidden" });
    state.setPageVisible = value => {
      visible = value;
      document.dispatchEvent(new Event("visibilitychange"));
    };
    Object.defineProperty(navigator, "wakeLock", { value: {
      request: async (type: string) => {
        if (type !== "screen") throw new Error("wrong wake lock type");
        state.wakeRequests++;
        const sentinel = Object.assign(new EventTarget(), {
          released: false,
          release: async () => {
            if (sentinel.released) return;
            sentinel.released = true;
            state.wakeReleases++;
            sentinel.dispatchEvent(new Event("release"));
          },
        });
        state.revokeWakeLock = () => void sentinel.release();
        if (deferred) await new Promise<void>(resolve => { state.grantWakeLock = resolve; });
        return sentinel;
      },
    }, configurable: true });
  }, { deferred });
}

test("screen stays awake only at the table, restores on visibility and remembers the toggle", async ({ page }) => {
  await mockWakeLock(page);
  await createRoom(page);
  const state = () => page.evaluate(() => {
    const w = window as typeof window & { wakeRequests: number; wakeReleases: number };
    return { requests: w.wakeRequests, releases: w.wakeReleases };
  });
  await expect(page.getByRole("button", { name: "关闭屏幕常亮" })).toHaveText("常亮开");
  expect(await state()).toEqual({ requests: 1, releases: 0 });
  await page.getByRole("button", { name: "关闭屏幕常亮" }).click();
  await expect.poll(state).toEqual({ requests: 1, releases: 1 });
  await page.reload();
  await expect(page.getByRole("button", { name: "开启屏幕常亮" })).toHaveText("常亮关");
  expect(await state()).toEqual({ requests: 0, releases: 0 });
  await page.getByRole("button", { name: "开启屏幕常亮" }).click();
  await expect.poll(state).toEqual({ requests: 1, releases: 0 });
  for (const visible of [false, true]) {
    await page.evaluate(value => (window as typeof window & { setPageVisible: (visible: boolean) => void }).setPageVisible(value), visible);
  }
  await expect.poll(state).toEqual({ requests: 2, releases: 1 });
  await page.evaluate(() => (window as typeof window & { revokeWakeLock: () => void }).revokeWakeLock());
  await expect(page.getByRole("button", { name: "关闭屏幕常亮" })).toHaveText("常亮待开启");
  await page.locator(".waiting-center h2").click();
  await expect.poll(state).toEqual({ requests: 3, releases: 2 });
  await page.getByRole("button", { name: "结束游戏", exact: true }).click();
  await page.getByRole("button", { name: "确认结束游戏" }).click();
  await expect(page.getByRole("heading", { name: "总计分" })).toBeVisible();
  await expect.poll(state).toEqual({ requests: 3, releases: 3 });
});

test("a wake lock granted after the room ends is released immediately", async ({ page }) => {
  await mockWakeLock(page, true);
  await createRoom(page);
  await expect(page.getByRole("button", { name: "关闭屏幕常亮" })).toHaveText("常亮待开启");
  await page.getByRole("button", { name: "结束游戏", exact: true }).click();
  await page.getByRole("button", { name: "确认结束游戏" }).click();
  await expect(page.getByRole("heading", { name: "总计分" })).toBeVisible();
  await page.evaluate(() => (window as typeof window & { grantWakeLock: () => void }).grantWakeLock());
  await expect.poll(() => page.evaluate(() => (window as typeof window & { wakeReleases: number }).wakeReleases)).toBe(1);
});

test("unsupported browsers can still create and end rooms", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, "wakeLock", { value: undefined }));
  await createRoom(page);
  await expect(page.getByRole("button", { name: "关闭屏幕常亮" })).toHaveText("常亮不支持");
  await expect(page.getByRole("button", { name: "关闭屏幕常亮" })).toBeDisabled();
  await page.getByRole("button", { name: "结束游戏", exact: true }).click();
  await page.getByRole("button", { name: "确认结束游戏" }).click();
  await expect(page.getByRole("heading", { name: "总计分" })).toBeVisible();
});

test("portrait entry suggests landscape once; rotating or dismissing keeps play available", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockWakeLock(page);
  await createRoom(page);
  const prompt = page.getByRole("dialog", { name: "横屏打牌更舒服" });
  await expect(prompt).toBeVisible();
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(prompt).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(prompt).toHaveCount(0);
  await page.getByRole("button", { name: "结束游戏", exact: true }).click();
  await page.getByRole("button", { name: "确认结束游戏" }).click();
  await page.getByRole("button", { name: "返回大厅", exact: true }).click();
  await page.getByRole("button", { name: /创建房间/ }).click();
  await page.getByRole("button", { name: "确认开桌" }).click();
  await expect(prompt).toBeVisible();
  await page.getByRole("button", { name: "知道了，继续玩" }).click();
  await expect(prompt).toHaveCount(0);
  await page.getByRole("button", { name: "结束游戏", exact: true }).click();
  await page.getByRole("button", { name: "确认结束游戏" }).click();
  await expect(page.getByRole("heading", { name: "总计分" })).toBeVisible();
});
