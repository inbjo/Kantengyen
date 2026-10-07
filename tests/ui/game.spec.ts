import { test, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";

test("welcome is remembered as soon as shown, including refresh and another tab", async ({ page, context }) => {
  await page.goto("/");
  await expect(page.getByRole("dialog", { name: "第一把？我们陪你。" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const other = await context.newPage();
  await other.goto("/");
  await expect(other.getByRole("dialog")).toHaveCount(0);
  await expect(other.getByRole("button", { name: /先练三把/ })).toBeVisible();
  await other.close();
  await page.getByRole("button", { name: /先练三把/ }).click();
  await expect(page.locator(".lesson-card")).toBeVisible();
  await page.locator(".lesson-heading").click();
  await expect(page.locator(".lesson-card")).toHaveClass(/collapsed/);
  await page.reload();
  await expect(page.locator(".lesson-card")).toHaveClass(/collapsed/);
});

test("selected cards leave every adjacent rank visible and clickable in portrait and landscape", async ({ page }) => {
  await page.routeWebSocket("**/api/ws", socket => {
    socket.onMessage(raw => {
      const auth = JSON.parse(String(raw));
      if (!auth.token) return;
      socket.send(JSON.stringify({
        type:"snapshot",code:auth.code,practice:true,host:"host",seat:0,round:1,version:1,phase:"playing",deadline_ms:0,
        round_limit:null,completed_rounds:0,abandoned_round:false,final_scores:[],
        players:["host","other"].map(id=>({id,name:id,avatar_seed:id,bot:false,online:true,ready:true,score:0,count:5})),
        hand:[2,6,9,10,11],turn:0,auto_pass_available:false,last:null,deck_count:43,multiplier:1,winner:null,result:[],message:"自由领出",history:[],
      }));
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name:"我会玩了，直接去大厅" }).click();
  await page.getByRole("button", { name:/先练三把/ }).click();
  const cards = page.locator(".hand-cards .playing-card");
  await expect(cards).toHaveCount(5);
  for (const [width,height] of [[390,844],[844,390],[667,375]]) {
    await page.setViewportSize({width,height});
    while (await page.locator(".hand-cards .selected").count())
      await page.locator(".hand-cards .selected .card-corner").first().click();
    await cards.nth(1).locator(".card-corner").click();
    await expect(cards.nth(1)).toHaveAttribute("aria-pressed","true");
    for (let i=0;i<5;i++) {
      await expect.poll(() => cards.nth(i).locator(".card-corner").evaluate(el=>{
        const r=el.getBoundingClientRect();
        return document.elementFromPoint(r.x+3,r.y+5)?.closest(".playing-card")===el.closest(".playing-card");
      })).toBe(true);
    }
    await cards.nth(2).locator(".card-corner").click();
    await expect(cards.nth(2)).toHaveAttribute("aria-pressed","true");
    await cards.nth(1).locator(".card-corner").click();
    await expect(cards.nth(1)).toHaveAttribute("aria-pressed","false");
    await cards.nth(2).locator(".card-corner").click();
    const corners = await cards.locator(".card-corner").evaluateAll(elements => elements.map(el => {
      const r = el.getBoundingClientRect(); return { x:r.left+5, y:r.top+8 };
    }));
    await page.mouse.move(corners[0].x,corners[0].y);
    await page.mouse.down();
    await page.mouse.move(corners[3].x,corners[0].y,{steps:12});
    for (let i=0;i<4;i++) await expect(cards.nth(i)).toHaveAttribute("aria-pressed","true");
    await page.mouse.move(corners[1].x,corners[0].y,{steps:8});
    await expect(cards.nth(2)).toHaveAttribute("aria-pressed","false");
    await expect(cards.nth(3)).toHaveAttribute("aria-pressed","false");
    await page.mouse.up();
    await expect(cards.nth(0)).toHaveAttribute("aria-pressed","true");
    await expect(cards.nth(1)).toHaveAttribute("aria-pressed","true");
    if (height > width) {
      await cards.nth(0).locator(".card-corner").click();
      await cards.nth(1).locator(".card-corner").click();
      const touch = await page.context().newCDPSession(page);
      const dispatch = (type:string,x:number) => touch.send("Input.dispatchTouchEvent",{
        type,touchPoints:type==="touchEnd"?[]:[{x,y:corners[0].y,id:1}],
      });
      await dispatch("touchStart",corners[0].x);
      await dispatch("touchMove",corners[3].x);
      await expect(cards.nth(3)).toHaveAttribute("aria-pressed","true");
      await dispatch("touchMove",corners[1].x);
      await dispatch("touchEnd",corners[1].x);
      await expect(cards.nth(1)).toHaveAttribute("aria-pressed","true");
      await expect(cards.nth(2)).toHaveAttribute("aria-pressed","false");
      await touch.detach();
    }
    await page.screenshot({path:`test-results/card-selection-${width}.png`});
    if (height>width) await expect(page.getByText("建议手机用户使用横屏，体验更佳 ↻")).toBeVisible();
  }
});

test("creation offers default eight, presets, unlimited and validated custom rounds", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "我会玩了，直接去大厅" }).click();
  for (const [label, text] of [["8 局", "8 局"], ["16 局", "16 局"], ["20 局", "20 局"], ["血战到底", "血战到底"], ["自定义", "3 局"]]) {
    await page.getByRole("button", { name: /创建房间/ }).click();
    if (label === "8 局") await expect(page.getByRole("radio", { name: "8 局", exact: true })).toBeChecked();
    await page.getByRole("radio", { name: label, exact: true }).check();
    if (label === "自定义") {
      await page.getByLabel("自定义局数", { exact: true }).fill("0");
      await page.getByRole("button", { name: "确认开桌" }).click();
      await expect(page.getByRole("dialog")).toContainText("正整数");
      await page.getByLabel("自定义局数", { exact: true }).fill("3");
    }
    await page.getByRole("button", { name: "确认开桌" }).click();
    await expect(page.locator(".waiting-center p").first()).toContainText(text);
    await page.getByRole("button", { name: "结束游戏", exact: true }).click();
    await page.getByRole("button", { name: "确认结束游戏" }).click();
    await expect(page.getByRole("heading", { name: "总计分" })).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
    expect(await page.evaluate(() => sessionStorage.getItem("kantengyen.room"))).toBe('""');
    await page.getByRole("button", { name: "返回大厅", exact: true }).click();
  }
});

test("eight seats occupy distinct visible positions on desktop, tablet and phones", async ({ page }) => {
  await page.routeWebSocket("**/api/ws", socket => {
    socket.onMessage(raw => {
      const auth = JSON.parse(String(raw));
      if (!auth.token) return;
      socket.send(JSON.stringify({
        type: "snapshot", code: auth.code, practice: false, host: "p0", seat: 0, round: 1, round_limit: 8,
        version: 1, phase: "playing", deadline_ms: Date.now() + 30000, completed_rounds: 0, abandoned_round: false, final_scores: [],
        players: Array.from({ length: 8 }, (_, i) => ({ id: `p${i}`, name: `八人玩家${i}`, avatar_seed: `p${i}`, bot: false, ready: true, online: true, score: 0, count: 5 })),
        hand: [0,1,2,3,4,5], turn: 0, auto_pass_available: false, last: null, deck_count: 13, multiplier: 1, winner: null, result: [], message: "请出牌", history: [],
      }));
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "我会玩了，直接去大厅" }).click();
  await page.getByRole("button", { name: /先练三把/ }).click();
  await expect(page.locator(".opponent")).toHaveCount(7);
  for (const [width, height] of [[1280,800], [1024,768], [844,390], [667,375], [390,844]]) {
    await page.setViewportSize({ width, height });
    const boxes = await page.locator(".opponent").evaluateAll(elements => elements.map(el => { const r = el.getBoundingClientRect(); return { x:r.x,y:r.y,right:r.right,bottom:r.bottom }; }));
    for (const box of boxes) { expect(box.x).toBeGreaterThanOrEqual(0); expect(box.right).toBeLessThanOrEqual(width); expect(box.y).toBeGreaterThanOrEqual(0); expect(box.bottom).toBeLessThanOrEqual(height); }
    for (let i=0; i<boxes.length; i++) for (let j=i+1; j<boxes.length; j++) {
      const a=boxes[i], b=boxes[j];
      expect(a.right <= b.x || b.right <= a.x || a.bottom <= b.y || b.bottom <= a.y).toBe(true);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/eight-seats-${width}.png` });
  }
});

test("automatic pass defaults on, can be disabled, and never skips a playable or leading turn", async ({ page }) => {
  let automatic = 0;
  let manual = 0;
  let publish: (available: boolean, leading?: boolean) => void = () => {};
  await page.routeWebSocket("**/api/ws", (socket) => {
    let version = 0;
    let code = "1234";
    const snapshot = (available: boolean, leading = false, turn = 0) => socket.send(JSON.stringify({
      type: "snapshot", code, practice: true, host: "human", seat: 0, round: 1,
      version: ++version, phase: "playing", deadline_ms: 0,
      players: ["human", "bot"].map(id => ({ id, name: id, avatar_seed: id, bot: id === "bot", ready: true, online: true, score: 0, count: 2 })),
      hand: [2, 8], turn, auto_pass_available: available,
      last: leading ? null : { seat: 1, cards: [0], pattern: { kind: "single", rank: 3, len: 1 } },
      deck_count: 8, multiplier: 1, winner: null, result: [], message: "自动过牌测试", history: [],
    }));
    publish = (available, leading) => snapshot(available, leading);
    socket.onMessage(raw => {
      const message = JSON.parse(String(raw));
      if (message.token) { code = message.code; snapshot(true); }
      if (message.action === "auto_pass" || message.action === "pass") {
        if (message.action === "auto_pass") automatic++; else manual++;
        snapshot(false, false, 1);
      }
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "我会玩了，直接去大厅" }).click();
  await page.getByRole("button", { name: /先练三把/ }).click();
  const toggle = page.getByRole("checkbox", { name: "要不起过牌", exact: true });
  await expect(toggle).toBeChecked();
  await page.waitForTimeout(1000);
  expect(automatic).toBe(0);
  await expect.poll(() => automatic).toBe(1);
  await toggle.uncheck();
  publish(true);
  await page.waitForTimeout(2300);
  expect(automatic).toBe(1);
  await page.getByRole("button", { name: "过牌", exact: true }).click();
  await expect.poll(() => manual).toBe(1);
  await toggle.check();
  publish(false); // a playable response is not skipped
  await page.waitForTimeout(2300);
  expect(automatic).toBe(1);
  publish(false, true); // the leader must play
  await page.waitForTimeout(2300);
  expect(automatic).toBe(1);
  publish(true);
  await expect.poll(() => automatic).toBe(2);
  await toggle.uncheck();
  await page.reload();
  await expect(toggle).not.toBeChecked();
});

test("first visit can skip or learn, profiles randomize, all three practice rounds complete", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await mkdir("test-results", { recursive: true });
  await page.setViewportSize({ width: 844, height: 390 });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "我会玩了，直接去大厅" }).click();
  await page.screenshot({ path: "test-results/lobby-phone.png" });
  await page.getByRole("button", { name: "修改名字与头像" }).click();
  await page.getByLabel("你的名字").fill("认真练习的小鹿");
  await page.getByRole("button", { name: "换个头像", exact: true }).click();
  await page.getByRole("button", { name: "就用这个名字" }).click();
  await page.getByRole("button", { name: /先练三把/ }).click();
  await expect(page.getByText("练习 1 / 3", { exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/practice-phone.png" });
  for (let round = 1; round <= 3; round++) {
    for (let turn = 0; turn < 500; turn++) {
      if (await page.locator(".result-card").isVisible()) break;
      const hint = page.getByRole("button", { name: "提示", exact: true });
      if (await hint.isEnabled()) {
        await hint.click();
        await page.waitForTimeout(80);
        const play = page.getByRole("button", { name: /^出牌/ });
        if (await play.isEnabled()) await play.click();
        else if (
          await page
            .getByRole("button", { name: "过牌", exact: true })
            .isEnabled()
        )
          await page.getByRole("button", { name: "过牌", exact: true }).click();
      }
      await page.waitForTimeout(200);
    }
    await expect(page.locator(".result-card")).toBeVisible({ timeout: 10000 });
    if (round < 3) {
      await page.getByRole("button", { name: "进入下一课" }).click();
      await expect(
        page.getByText(`练习 ${round + 1} / 3`, { exact: true }),
      ).toBeVisible();
    }
  }
  await page.getByRole("button", { name: "练习完成，去和朋友玩" }).click();
  await expect(page.getByRole("button", { name: /创建房间/ })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  expect(errors).toEqual([]);
});

test("two browsers create, join, ready, play and reload into the same seat", async ({
  browser,
}) => {
  const a = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const b = await browser.newContext({ viewport: { width: 844, height: 390 } });
  const host = await a.newPage();
  const friend = await b.newPage();
  for (const page of [host, friend]) {
    await page.goto("/");
    await page.getByRole("button", { name: "我会玩了，直接去大厅" }).click();
  }
  await host.getByRole("button", { name: /创建房间/ }).click();
  await host.getByRole("button", { name: "确认开桌" }).click();
  await expect(host.locator(".waiting-center h2")).toBeVisible();
  const code = await host.locator(".waiting-center h2 span").innerText();
  await friend.getByRole("button", { name: /加入房间/ }).click();
  await friend.getByLabel("四位房间号").fill(code);
  await friend.getByRole("button", { name: "加入房间", exact: true }).click();
  await friend.getByRole("button", { name: "我准备好了" }).click();
  await expect(host.getByRole("button", { name: "开始游戏" })).toBeEnabled();
  await host.getByRole("button", { name: "开始游戏" }).click();
  await expect(host.locator(".hand-cards .playing-card")).toHaveCount(6);
  await expect(friend.locator(".hand-cards .playing-card")).toHaveCount(5);
  await host.screenshot({ path: "test-results/table-desktop.png" });
  await host.getByRole("button", { name: "提示", exact: true }).click();
  await expect(host.locator(".playing-card.selected").first()).toBeVisible();
  await host.getByRole("button", { name: /^出牌/ }).click();
  await expect(
    friend.getByRole("button", { name: "提示", exact: true }),
  ).toBeEnabled();
  await friend.reload();
  await friend.getByRole("button", { name: "恢复自己出牌", exact: true }).click();
  await expect(friend.locator(".hand-cards .playing-card")).toHaveCount(5);
  await expect(
    friend.getByRole("button", { name: "提示", exact: true }),
  ).toBeEnabled();
  await friend.screenshot({ path: "test-results/table-phone.png" });
  await a.close();
  await b.close();
});

test("invite in a new tab uses an independent seat and refreshing preserves it", async ({ page: host, context }) => {
  await host.goto("/");
  await host.getByRole("button", { name: "我会玩了，直接去大厅" }).click();
  await host.getByRole("button", { name: /创建房间/ }).click();
  await host.getByRole("button", { name: "确认开桌" }).click();
  const code = await host.locator(".waiting-center h2 span").innerText();
  const friend = await context.newPage();
  await expect(host).toHaveURL(new RegExp(`\\/\\?room=${code}$`));
  await friend.goto(`/?room=${code}`);
  await expect(friend.getByLabel("四位房间号")).toHaveValue(code);
  await friend.getByRole("button", { name: "加入房间", exact: true }).click();
  await expect(friend.getByRole("button", { name: "我准备好了" })).toBeVisible();
  const identity = (page: typeof host) => page.evaluate(() => JSON.parse(sessionStorage.getItem("kantengyen.session")!).token);
  const original = await identity(friend);
  expect(original).not.toBe(await identity(host));
  await friend.getByRole("button", { name: "我准备好了" }).click();
  await expect(host.getByRole("button", { name: "开始游戏" })).toBeEnabled();
  await host.getByRole("button", { name: "开始游戏" }).click();
  await expect(host.locator(".hand-cards .playing-card")).toHaveCount(6);
  await expect(friend.locator(".hand-cards .playing-card")).toHaveCount(5);
  await friend.reload();
  await friend.getByRole("button", { name: "恢复自己出牌", exact: true }).click();
  await expect(friend.locator(".hand-cards .playing-card")).toHaveCount(5);
  await expect(friend.getByRole("dialog")).toHaveCount(0);
  expect(await identity(friend)).toBe(original);
  await friend.waitForTimeout(1500);
  await expect(host.locator(".connection-banner")).toHaveCount(0);
  await expect(friend.locator(".connection-banner")).toHaveCount(0);
});

test("host can end mid-round; everyone sees frozen totals and can leave", async ({ page: host, context }) => {
  await host.setViewportSize({ width: 667, height: 375 });
  await host.goto("/");
  await host.getByRole("button", { name: "我会玩了，直接去大厅" }).click();
  await host.getByRole("button", { name: /创建房间/ }).click();
  await host.getByRole("button", { name: "确认开桌" }).click();
  const code = await host.locator(".waiting-center h2 span").innerText();
  const friend = await context.newPage();
  await friend.setViewportSize({ width: 844, height: 390 });
  await friend.goto(`/?room=${code}`);
  await friend.getByRole("button", { name: "加入房间", exact: true }).click();
  await expect(friend.getByRole("button", { name: "结束游戏", exact: true })).toHaveCount(0);
  await friend.getByRole("button", { name: "我准备好了" }).click();
  await host.getByRole("button", { name: "开始游戏" }).click();
  await expect(host.locator(".hand-cards .playing-card")).toHaveCount(6);
  for (const [width, height] of [[390, 844], [1024, 768], [667, 375]]) {
    await host.setViewportSize({ width, height });
    const end = await host.getByRole("button", { name: "结束游戏", exact: true }).boundingBox();
    expect(end!.x).toBeGreaterThanOrEqual(0);
    expect(end!.x + end!.width).toBeLessThanOrEqual(width);
    expect(await host.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await host.getByRole("button", { name: "结束游戏", exact: true }).click();
  await expect(host.getByRole("dialog")).toContainText("当前这一局尚未完成，不计分");
  await host.getByRole("button", { name: "继续玩", exact: true }).click();
  await expect(host.locator(".hand-cards .playing-card")).toHaveCount(6);
  await host.getByRole("button", { name: "结束游戏", exact: true }).click();
  await host.getByRole("button", { name: "确认结束游戏" }).click();
  for (const page of [host, friend]) {
    await expect(page.getByRole("heading", { name: "总计分" })).toBeVisible();
    await expect(page.getByText("已完成 0 局 · 未完成的本局不计分")).toBeVisible();
    await expect(page.locator(".score-list > div")).toHaveCount(2);
    await expect(page.locator(".score-list b")).toHaveText(["0", "0"]);
    await expect(page.getByRole("button", { name: "再来一把" })).toHaveCount(0);
  }
  await host.screenshot({ path: "test-results/final-scores-phone.png" });
  await host.getByRole("button", { name: "返回大厅", exact: true }).click();
  await expect(host.getByRole("button", { name: /创建房间/ })).toBeVisible();
  await expect(friend.locator(".score-list > div")).toHaveCount(2);
  await expect(friend.getByRole("heading", { name: "总计分" })).toBeVisible();
  await friend.getByRole("button", { name: "返回大厅", exact: true }).click();
  await expect(friend.getByRole("button", { name: /创建房间/ })).toBeVisible();
});

test("portrait and tablet layouts fit the viewport and retain usable actions", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(Crypto.prototype, "randomUUID", { value: undefined, configurable: true });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "我会玩了，直接去大厅" }).click();
  for (const [width, height] of [
    [390, 844],
    [1024, 768],
    [667, 375],
  ]) {
    await page.setViewportSize({ width, height });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await expect(page.getByRole("button", { name: /创建房间/ })).toBeVisible();
  }
  await page.getByRole("button", { name: /先练三把/ }).click();
  for (const [width, height] of [
    [390, 844],
    [1024, 768],
    [667, 375],
  ]) {
    await page.setViewportSize({ width, height });
    await expect(
      page.getByRole("button", { name: "提示", exact: true }),
    ).toBeVisible();
    const box = await page
      .getByRole("button", { name: "提示", exact: true })
      .boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(height);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/table-${width}x${height}.png`,
    });
  }
});
