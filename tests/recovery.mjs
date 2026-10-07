import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let i=0;i<150;i++) { if (await check()) return; await sleep(50); }
  throw new Error("等待恢复状态超时");
}
class Player {
  constructor(base, session, code) {
    this.messages = [];
    this.ws = new WebSocket(base.replace("http", "ws") + "/api/ws");
    this.ws.onopen = () => this.ws.send(JSON.stringify({code, token:session.token}));
    this.ws.onmessage = event => {
      const message=JSON.parse(event.data);this.messages.push(message);
      if (message.type==="snapshot") this.state=message;
    };
  }
  send(action, cards=[], extra={}) {
    const command={action,cards,version:this.state.version,request_id:crypto.randomUUID(),...extra};
    this.ws.send(JSON.stringify(command)); return command;
  }
  close(){this.ws.close();}
}
test("force-stop restores hands, settled scores, identities and deduplication; dissolution survives restart", {timeout:120_000}, async () => {
  const folderRoot=resolve("test-results");await mkdir(folderRoot,{recursive:true});
  const folder=await mkdtemp(join(folderRoot,"recovery-"));
  const statePath=join(folder,"state.json");
  const probe=createServer();await new Promise(done=>probe.listen(0,"127.0.0.1",done));
  const port=probe.address().port;await new Promise(done=>probe.close(done));
  const base=`http://127.0.0.1:${port}`;
  const binary=resolve("target/debug/kantengyen-server"+(process.platform==="win32"?".exe":""));
  let server, closed;const clients=[];
  const start=async()=>{
    server=spawn(binary,[],{cwd:folder,env:{...process.env,STATE_PATH:statePath,TURN_ENABLED:"false",BIND_ADDR:`127.0.0.1:${port}`},stdio:"ignore"});
    closed=new Promise(done=>server.once("close",done));
    await until(async()=>{try{return (await fetch(base+"/api/health")).ok;}catch{return false;}});
  };
  const stop=async()=>{server.kill("SIGKILL");await closed;};
  const api=async(path,body,token)=>{
    const response=await fetch(base+path,{method:"POST",headers:{"Content-Type":"application/json",...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body)});
    return {status:response.status,data:await response.json()};
  };
  const saved=async()=>JSON.parse(await readFile(statePath,"utf8"));
  try {
    await start();
    const a=(await api("/api/session",{name:"恢复房主",avatar_seed:"a"})).data;
    const b=(await api("/api/session",{name:"恢复朋友",avatar_seed:"b"})).data;
    const code=(await api("/api/rooms",{round_limit:16},a.token)).data.code;
    assert.equal((await api(`/api/rooms/${code}/join`,{},b.token)).status,200);
    const first=[new Player(base,a,code),new Player(base,b,code)];clients.push(...first);
    await until(()=>first.every(p=>p.state?.players.every(p=>p.online)));
    const ready=first[1].send("ready_on",[],{version:0});
    await until(()=>first[0].state.players[1].ready);
    first[1].send("ready_on",[],ready);
    await sleep(200);assert.equal(first[1].state.players[1].ready,true);
    first[0].send("start");await until(()=>first.every(p=>p.state.phase==="playing"));
    for(let turn=0;turn<500&&first[0].state.phase!=="finished";turn++) {
      const p=first[first[0].state.turn];
      await until(()=>p.state.version===first[0].state.version);
      const count=p.messages.length;p.send("hint");
      await until(()=>p.messages.slice(count).some(m=>m.type==="hint"));
      const hint=p.messages.slice(count).find(m=>m.type==="hint");
      const version=p.state.version;p.send(hint.cards.length?"play":"pass",hint.cards);
      await until(()=>first.every(c=>c.state.version>version));await sleep(210);
    }
    assert.equal(first[0].state.phase,"finished");
    const scores=first[0].state.players.map(p=>p.score);
    assert.equal(scores.reduce((sum,n)=>sum+n,0),0);
    assert.ok(scores.some(n=>n!==0));
    assert.equal(first[0].state.settlement.round,1);
    first[0].send("next");await until(()=>first.every(p=>p.state.round===2));
    const leader=first[first[0].state.turn];
    const play=leader.send("play",[leader.state.hand.find(c=>c<52)]);
    await until(()=>first.every(p=>p.state.last?.cards.includes(play.cards[0])));
    await until(async()=> (await saved()).rooms.find(r=>r.state.code===code)?.state.game.discarded.includes(play.cards[0]));
    const before=(await saved()).rooms.find(r=>r.state.code===code).state;
    await stop();
    await start();
    const identity=await api("/api/session",{token:a.token,name:a.profile.name,avatar_seed:a.profile.avatar_seed});
    assert.equal(identity.data.token,a.token);assert.equal(identity.data.profile.id,a.profile.id);
    const restored=[new Player(base,a,code),new Player(base,b,code)];clients.push(...restored);
    await until(()=>restored.every(p=>p.state?.players.every(p=>p.online)));
    assert.deepEqual(restored.map(p=>p.state.hand),before.game.hands);
    assert.deepEqual(restored[0].state.players.map(p=>p.score),scores);
    assert.equal(restored[0].state.round,2);assert.equal(restored[0].state.settlement.round,1);
    assert.ok(restored[0].state.players.every(p=>p.managed));
    restored[0].send("resume");restored[1].send("resume");
    await until(()=>restored[0].state.players.every(p=>!p.managed));
    const currentHands=restored.map(p=>p.state.hand);
    restored[before.game.dealer].send("play",[],play);
    await sleep(200);assert.deepEqual(restored.map(p=>p.state.hand),currentHands);
    restored[0].send("takeover");await until(()=>restored[0].state.players[0].managed);
    restored[0].send("resume");await until(()=>!restored[0].state.players[0].managed);
    restored[1].close();await until(()=>!restored[0].state.players[1].online);
    const returned=new Player(base,b,code);clients.push(returned);
    await until(()=>returned.state?.players[1].online);
    assert.equal(returned.state.players[1].managed,true);
    returned.send("resume");await until(()=>!returned.state.players[1].managed);
    restored[0].send("end");await until(()=>restored[0].state.phase==="ended");
    await until(async()=> !(await saved()).rooms.some(r=>r.state.code===code));
    await stop();await start();
    assert.equal((await fetch(base+`/api/rooms/${code}`)).status,404);
    assert.equal((await api(`/api/rooms/${code}/join`,{},a.token)).status,404);
    assert.equal((await api("/api/rooms",{},a.token)).status,200);
  } finally {
    clients.forEach(p=>p.close());
    if(server&&server.exitCode===null)await stop();
    // Only the isolated, canonical test directory generated above is removed.
    assert.ok(folder.startsWith(folderRoot+"\\")||folder.startsWith(folderRoot+"/"));
    await rm(folder,{recursive:true,force:true});
  }
});
