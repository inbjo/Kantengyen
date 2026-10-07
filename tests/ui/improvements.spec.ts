import { test, expect } from "@playwright/test";

test("ready retry keeps one request id and desired state; native share includes room details", async ({page}) => {
  await page.addInitScript(() => Object.defineProperty(navigator,"share", {value:async (data:ShareData) => {
    (window as any).sharedInvite=data;
  }}));
  const commands:any[]=[];
  await page.routeWebSocket("**/api/ws", socket => {
    let code="", version=1;
    const publish=(ready:boolean) => socket.send(JSON.stringify({
      type:"snapshot",code,practice:false,host:"friend",seat:0,round:0,version:version++,phase:"waiting",deadline_ms:0,
      round_limit:16,completed_rounds:0,abandoned_round:false,final_scores:[],
      players:[{id:"me",name:"自己",avatar_seed:"me",bot:false,online:true,ready,score:0,count:0},
        {id:"friend",name:"等待的朋友",avatar_seed:"friend",bot:false,online:true,ready:false,score:0,count:0}],
      hand:[],turn:0,auto_pass_available:false,last:null,deck_count:54,multiplier:1,winner:null,result:[],message:"等待",history:[],
    }));
    socket.onMessage(raw => {
      const message=JSON.parse(String(raw));
      if(message.token) {code=message.code;publish(false);return;}
      if(message.action==="ready_on") {
        commands.push(message);
        if(commands.length===1) publish(false); // another snapshot must not acknowledge readiness
        else publish(true);
      }
    });
  });
  await page.goto("/");
  await page.getByRole("button",{name:"我会玩了，直接去大厅"}).click();
  await page.getByRole("button",{name:/创建房间/}).click();
  await page.getByRole("button",{name:"确认开桌"}).click();
  await expect(page.locator(".ready-summary")).toHaveText("已准备 0/2 人");
  await expect(page.locator(".ready-waiting")).toContainText("等待的朋友");
  await page.getByRole("button",{name:"我准备好了"}).click();
  await expect(page.locator(".ready-summary")).toHaveText("已准备 1/2 人");
  expect(commands).toHaveLength(2);
  expect(commands[1].request_id).toBe(commands[0].request_id);
  await page.getByRole("button",{name:"一键分享邀请"}).click();
  const data=await page.evaluate(()=>(window as any).sharedInvite);
  const code=new URL(page.url()).searchParams.get("room");
  expect(data.url).toContain(`/?room=${code}`);
  expect(data.text).toContain(`${code} · 2/8 人 · 16 局`);
});

test("expired invite explains the problem and returns to a clean lobby URL", async ({page}) => {
  await page.route("**/api/rooms/1234", route => route.fulfill({status:404,json:{error:"房间已解散或不存在，请联系房主获取新的邀请"}}));
  await page.goto("/?room=1234");
  const intro=page.getByRole("button",{name:"我会玩了，直接去大厅"});
  if(await intro.isVisible()) await intro.click();
  await expect(page.getByRole("dialog")).toContainText("房间已解散或不存在");
  await page.getByRole("button",{name:"返回大厅",exact:true}).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("button",{name:/创建房间/})).toBeVisible();
});

test("manual takeover stays active after refresh until explicit resume", async ({page,context}) => {
  await page.setViewportSize({width:844,height:390});
  await page.goto("/");
  await page.getByRole("button",{name:"我会玩了，直接去大厅"}).click();
  await page.getByRole("button",{name:/创建房间/}).click();
  await page.getByRole("button",{name:"确认开桌"}).click();
  const code=await page.locator(".waiting-center h2 span").innerText();
  const friend=await context.newPage();
  await friend.goto(`/?room=${code}`);
  await friend.getByRole("button",{name:"加入房间",exact:true}).click();
  await friend.getByRole("button",{name:"我准备好了"}).click();
  await page.getByRole("button",{name:"开始游戏"}).click();
  await page.getByRole("button",{name:"开启托管"}).click();
  await expect(page.getByRole("button",{name:"恢复自己出牌"})).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button",{name:"恢复自己出牌"})).toBeVisible();
  await page.getByRole("button",{name:"恢复自己出牌"}).click();
  await expect(page.getByRole("button",{name:"开启托管"})).toBeVisible();
});

test("full invite previews occupancy and rounds without exposing private state", async ({page}) => {
  await page.route("**/api/rooms/1234", route => route.fulfill({json:{code:"1234",count:8,round_limit:20,available:false,reason:"房间已满，请联系房主"}}));
  await page.goto("/?room=1234");
  const intro=page.getByRole("button",{name:"我会玩了，直接去大厅"});
  if(await intro.isVisible()) await intro.click();
  await expect(page.locator(".invite-preview")).toContainText("8/8 人 · 20 局");
  await expect(page.locator(".invite-preview")).toContainText("房间已满");
});

test("final settlement preserves remaining-card calculations and winner contributions", async ({page}) => {
  await page.routeWebSocket("**/api/ws", socket => socket.onMessage(raw => {
    const auth=JSON.parse(String(raw));if(!auth.token)return;
    const players=[{id:"me",name:"赢家",avatar_seed:"me",score:10},{id:"friend",name:"朋友",avatar_seed:"friend",score:-10}];
    socket.send(JSON.stringify({type:"snapshot",code:auth.code,practice:false,host:"me",seat:0,round:8,round_limit:8,
      version:1,phase:"ended",deadline_ms:0,completed_rounds:8,abandoned_round:false,
      players:players.map(p=>({...p,bot:false,online:true,ready:true,count:0})),
      final_scores:players.map((p,i)=>({...p,rank:i+1})),hand:[],turn:null,last:null,
      auto_pass_available:false,deck_count:0,multiplier:1,winner:null,result:[],message:"结束",history:[],
      settlement:{round:8,multiplier:2,winner:0,entries:[{id:"me",name:"赢家",remaining:0,delta:10,contribution:0},{id:"friend",name:"朋友",remaining:5,delta:-10,contribution:10}]},
    }));
  }));
  await page.goto("/");
  await page.getByRole("button",{name:"我会玩了，直接去大厅"}).click();
  await page.getByRole("button",{name:/创建房间/}).click();
  await page.getByRole("button",{name:"确认开桌"}).click();
  await expect(page.locator(".settlement-detail")).toContainText("第 8 局计分明细");
  await expect(page.locator(".settlement-detail")).toContainText("剩余 5 张 × 2，扣 10 分");
  await expect(page.locator(".settlement-detail")).toContainText("收取 朋友 10 分 = +10 分");
});

test("host adjusts robots and invite arrivals wait without hands or controls", async ({page:host,context}) => {
  await host.setViewportSize({width:667,height:375});
  await host.goto("/");
  await host.getByRole("button",{name:"我会玩了，直接去大厅"}).click();
  await host.getByRole("button",{name:/创建房间/}).click();
  await host.getByRole("button",{name:"确认开桌"}).click();
  const code=await host.locator(".waiting-center h2 span").innerText();
  const robots=host.getByLabel("机器人数量");
  await robots.selectOption("7");
  await expect(host.locator(".waiting-center p").first()).toContainText("8 / 8 人");
  await expect(host.getByRole("button",{name:"开始游戏"})).toBeEnabled();
  await robots.selectOption("2");
  await expect(host.locator(".waiting-center p").first()).toContainText("3 / 8 人");
  await host.getByRole("button",{name:"开始游戏"}).click();
  await expect(host.locator(".hand-cards .playing-card")).toHaveCount(6);
  const friend=await context.newPage();
  await friend.setViewportSize({width:844,height:390});
  await friend.goto(`/?room=${code}`);
  await expect(friend.locator(".invite-preview")).toContainText("下一局");
  await friend.getByRole("button",{name:"加入房间",exact:true}).click();
  await expect(friend.locator(".queue-notice")).toContainText("等待下一局发牌");
  await expect(friend.locator(".hand-cards .playing-card")).toHaveCount(0);
  await expect(friend.getByRole("button",{name:"提示",exact:true})).toBeDisabled();
  await expect(friend.getByLabel("机器人数量")).toHaveCount(0);
  await friend.reload();
  await expect(friend.locator(".queue-notice")).toBeVisible();
  await friend.getByRole("button",{name:"退出房间",exact:true}).click();
  await friend.getByRole("dialog").getByRole("button",{name:"退出房间",exact:true}).click();
  await expect(friend.getByRole("button",{name:/创建房间/})).toBeVisible();
  await robots.selectOption("0");
  await expect(robots).toHaveValue("0");
  await expect(host.locator(".bot-control")).toContainText("下一局");
  await expect(host.locator(".opponent")).toHaveCount(2);
  expect(await host.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await host.getByRole("button",{name:"结束游戏",exact:true}).click();
  await host.getByRole("button",{name:"确认结束游戏"}).click();
});
