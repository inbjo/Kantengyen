import { test, expect, chromium, type Page } from "@playwright/test";

async function openLobby(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "我会玩了，直接去大厅" }).click();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
}

test("installed shell opens offline with invite code and never caches API responses", async ({ page, context }) => {
  // Chromium's protocol-level offline simulation may not change navigator.onLine
  // after a worker-served navigation. Simulate the OS connectivity signal too.
  await page.addInitScript(() => Object.defineProperty(navigator, "onLine", {
    configurable: true, get: () => sessionStorage.getItem("pwa-test-offline") !== "yes",
  }));
  await openLobby(page);
  await page.evaluate(() => fetch("/api/health"));
  const cached = await page.evaluate(async () => {
    const names = (await caches.keys()).filter(name => name.startsWith("kantengyen-pwa-"));
    return (await Promise.all(names.map(async name => (await (await caches.open(name)).keys()).map(r => new URL(r.url).pathname)))).flat();
  });
  expect(cached).toContain("/index.html");
  expect(cached).toContain("/rules.wasm");
  expect(cached.some(path => path.startsWith("/api"))).toBe(false);
  await page.evaluate(() => sessionStorage.setItem("pwa-test-offline", "yes"));
  await context.route("**/*", route => route.abort("internetdisconnected"));
  await context.setOffline(true);
  await page.goto("/?room=1234");
  await expect(page.getByLabel("四位房间号")).toHaveValue("1234");
  await expect(page.locator(".pwa-notice")).toContainText("当前没有网络");
  expect(await page.evaluate(() => fetch("/api/health").then(() => true).catch(() => false))).toBe(false);
  expect(await page.evaluate(async () => {
    const response = await fetch("/rules.wasm");
    const { instance } = await WebAssembly.instantiate(await response.arrayBuffer());
    return typeof instance.exports.check_play === "function";
  })).toBe(true);
  await page.getByRole("button", { name: "加入房间", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("当前没有网络，请联网后再入座");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await context.unrouteAll();
  await context.setOffline(false);
  await page.evaluate(() => {
    sessionStorage.removeItem("pwa-test-offline");
    window.dispatchEvent(new Event("online"));
  });
  await expect(page.locator(".pwa-notice")).toHaveCount(0);
});

test("browser installation prompt is triggered only by the install button", async ({ page }) => {
  await openLobby(page);
  await page.evaluate(() => {
    const event = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
      prompt: async () => sessionStorage.setItem("pwa-test-prompted", "yes"),
      userChoice: Promise.resolve({ outcome: "accepted" }),
    });
    window.dispatchEvent(event);
  });
  expect(await page.evaluate(() => sessionStorage.getItem("pwa-test-prompted"))).toBeNull();
  await page.getByRole("button", { name: "安装到桌面" }).click();
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("pwa-test-prompted"))).toBe("yes");
  await expect(page.getByRole("button", { name: "安装到桌面" })).toHaveCount(0);
});

test("manual install instructions cover iPhone, Android and WeChat", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => window.addEventListener("beforeinstallprompt", e => e.stopImmediatePropagation()));
  await openLobby(page);
  await page.getByRole("button", { name: "安装到桌面" }).click();
  const dialog = page.getByRole("dialog", { name: "把牌桌放到桌面" });
  await expect(dialog).toContainText("Safari");
  await expect(dialog).toContainText("Chrome");
  await expect(dialog).toContainText("在浏览器中打开");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/pwa-install-phone.png" });
  await page.getByRole("button", { name: "知道了", exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test("updates wait while playing and reload only after confirmation in the lobby", async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("pwa-test-loads", String(Number(sessionStorage.getItem("pwa-test-loads") || 0) + 1)));
  await openLobby(page);
  await page.getByRole("button", { name: /先练三把/ }).click();
  await expect(page.locator(".hand-cards .playing-card")).toHaveCount(6);
  await page.evaluate(async () => {
    await navigator.serviceWorker.register("/sw.js?update-test=2", { scope: "/", updateViaCache: "none" });
  });
  await expect.poll(() => page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.waiting)).toBe(true);
  await expect(page.getByRole("button", { name: "新版本已就绪，刷新更新" })).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem("pwa-test-loads"))).toBe("1");
  await page.getByRole("button", { name: "离开房间", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "退出房间", exact: true }).click();
  const update = page.getByRole("button", { name: "新版本已就绪，刷新更新" });
  await expect(update).toBeVisible();
  await Promise.all([page.waitForEvent("load"), update.click()]);
  await expect(page.getByRole("button", { name: /创建房间/ })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("pwa-test-loads"))).toBe("2");
});

test("Chromium recognizes the PWA as installable with valid application icons", async ({}, testInfo) => {
  // Ordinary Playwright contexts are incognito, where installation is forbidden.
  const context = await chromium.launchPersistentContext(testInfo.outputPath("pwa-profile"), {
    executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH,
    baseURL: testInfo.project.use.baseURL,
  });
  try {
    const page = context.pages()[0];
    await openLobby(page);
    const protocol = await context.newCDPSession(page);
    const manifest = await protocol.send("Page.getAppManifest");
    expect(manifest.errors).toEqual([]);
    const metadata = JSON.parse(manifest.data!);
    expect(metadata.start_url).toBe("/");
    expect(metadata.display).toBe("standalone");
    expect((await protocol.send("Page.getInstallabilityErrors")).installabilityErrors).toEqual([]);
  } finally { await context.close(); }
});
