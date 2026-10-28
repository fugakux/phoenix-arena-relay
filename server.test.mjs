import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import {createRelay,PROTOCOL} from './server.mjs';

// Each test gets its own relay on a free port; clients connect as a local page would.
async function relay(options={}){const r=createRelay({port:0,log:()=>{},...options});const port=await r.ready;return {...r,port};}
function client(port,origin='http://localhost:4179'){
  const ws=new WebSocket(`ws://127.0.0.1:${port}/ws`,{origin}),inbox=[],waiters=[];
  ws.on('message',d=>{const m=JSON.parse(d);const i=waiters.findIndex(w=>w.t===m.t);if(i>=0)waiters.splice(i,1)[0].resolve(m);else inbox.push(m);});
  const next=t=>{const i=inbox.findIndex(m=>m.t===t);if(i>=0)return Promise.resolve(inbox.splice(i,1)[0]);return new Promise((resolve,reject)=>{const w={t,resolve};waiters.push(w);setTimeout(()=>reject(new Error('timeout waiting for '+t)),2000);});};
  const opened=new Promise((resolve,reject)=>{ws.on('open',resolve);ws.on('error',reject);ws.on('unexpected-response',(_,res)=>reject(new Error('HTTP '+res.statusCode)));});
  return {ws,next,opened,send:m=>ws.send(JSON.stringify(m)),inbox};
}
async function pair(port,code){
  const a=client(port),b=client(port);await Promise.all([a.opened,b.opened]);
  a.send({t:'hello',v:PROTOCOL,name:'Alpha',agent:'Phoenix'});b.send({t:'hello',v:PROTOCOL,name:'Bravo',agent:'Clay'});
  a.send({t:'queue',code});await a.next('queued');b.send({t:'queue',code});
  return {a,b,ma:await a.next('match'),mb:await b.next('match')};
}

test('two queued players are matched on opposite sides and see each other',async()=>{
  const r=await relay();
  try{
    const {ma,mb}=await pair(r.port);
    assert.equal(ma.room,mb.room);assert.deepEqual([ma.side,mb.side],['attack','defend']);
    assert.equal(ma.foe.name,'Bravo');assert.equal(ma.foe.agent,'Clay');assert.equal(mb.foe.name,'Alpha');assert.equal(ma.firstTo,30);assert.equal(ma.timeLimit,600);
    assert.equal(ma.you.agent,'Phoenix');assert.equal(ma.foe.skin,'standard');
    assert.equal(r.stats().rooms,1);
  }finally{await r.close();}
});

test('a room code only pairs players who share it',async()=>{
  const r=await relay();
  try{
    const a=client(r.port),b=client(r.port),c=client(r.port);await Promise.all([a.opened,b.opened,c.opened]);
    a.send({t:'queue',code:'ab-12'});assert.equal((await a.next('queued')).code,'AB12');
    c.send({t:'queue'});await c.next('queued');          // public queue: no match with the coded player
    b.send({t:'queue',code:'AB12'});
    const [ma,mb]=await Promise.all([a.next('match'),b.next('match')]);assert.equal(ma.room,mb.room);
    assert.equal(c.inbox.some(m=>m.t==='match'),false);
  }finally{await r.close();}
});

test('state is relayed as sent; hits are validated; deaths score for the opponent up to firstTo',async()=>{
  const r=await relay({firstTo:2});
  try{
    const {a,b}=await pair(r.port);
    const state={t:'s',x:1.5,y:3,z:-4,yaw:.5,hp:100};a.send(state);assert.deepEqual(await b.next('s'),state);
    a.send({t:'hit',dmg:40,region:'head',w:'Vandal',extra:'dropped'});assert.deepEqual(await b.next('hit'),{t:'hit',dmg:40,region:'head',w:'Vandal'});
    a.send({t:'hit',dmg:20,region:'body',w:'Vandal',at:12.5});assert.deepEqual(await b.next('hit'),{t:'hit',dmg:20,region:'body',w:'Vandal',at:12.5});
    a.send({t:'hit',dmg:-5});a.send({t:'hit',dmg:1e9});b.send({t:'dead',by:'foe'});
    assert.deepEqual(await a.next('kill'),{t:'kill'});
    const sa=await a.next('score'),sb=await b.next('score');
    assert.deepEqual([sa.you,sa.foe,sa.deaths],[1,0,{you:0,foe:1}]);assert.deepEqual([sb.you,sb.foe,sb.deaths],[0,1,{you:1,foe:0}]);assert.ok(sa.left>590&&sa.left<=600);
    assert.equal(b.inbox.some(m=>m.t==='hit'),false,'out-of-range hits are not relayed');
    b.send({t:'dead',by:'self'});const self=await a.next('score');assert.deepEqual([self.you,self.foe,self.deaths.foe],[1,0,2]);
    b.send({t:'dead',by:'foe'});
    const end=await a.next('end');assert.equal(end.reason,'score');assert.equal(end.you,2);assert.deepEqual(end.deaths,{you:0,foe:3});
    assert.equal((await b.next('end')).foe,2);assert.equal(r.stats().rooms,0);
  }finally{await r.close();}
});

test('leaving or disconnecting ends the match for the other player',async()=>{
  const r=await relay();
  try{
    const {a,b}=await pair(r.port);a.send({t:'leave'});assert.equal((await b.next('end')).reason,'left');
    const second=await pair(r.port);second.b.ws.close();assert.equal((await second.a.next('end')).reason,'disconnect');
  }finally{await r.close();}
});

test('other origins and paths are refused; status is public; ping echoes',async()=>{
  const r=await relay();
  try{
    await assert.rejects(client(r.port,'https://evil.example').opened,/403/);
    const ok=client(r.port,'https://phoenix-ascent-arena.vercel.app');await ok.opened;
    ok.send({t:'ping',c:123});assert.equal((await ok.next('pong')).c,123);
    const status=await fetch(`http://127.0.0.1:${r.port}/`).then(x=>x.json());assert.equal(status.service,'phoenix-arena-relay');assert.equal(status.online,1);
    assert.equal(await fetch(`http://127.0.0.1:${r.port}/health`).then(x=>x.text()),'ok');
  }finally{await r.close();}
});

test('a flooding socket is throttled and eventually closed',async()=>{
  const r=await relay();
  try{
    const {a,b}=await pair(r.port);const closed=new Promise(resolve=>a.ws.on('close',(code)=>resolve(code)));
    for(let i=0;i<3000;i++)a.send({t:'s',i});
    assert.equal(await closed,1008);
    await new Promise(resolve=>setTimeout(resolve,100));
    assert.ok(b.inbox.filter(m=>m.t==='s').length<=150+50,'at most a bucket of state got through');
  }finally{await r.close();}
});

test('a queued player who went silent is never matched; the newcomer waits instead',async()=>{
  const r=await relay({staleMs:300});
  try{
    const a=client(r.port),b=client(r.port);await Promise.all([a.opened,b.opened]);
    a.send({t:'queue'});await a.next('queued');
    await new Promise(resolve=>setTimeout(resolve,400));   // a sends nothing (a closed tab whose socket lingers)
    b.send({t:'queue'});assert.equal((await b.next('queued')).position,1);
    assert.equal(a.inbox.some(m=>m.t==='match')||b.inbox.some(m=>m.t==='match'),false);
  }finally{await r.close();}
});

test('the queue request carries the agent and skin the player actually plays',async()=>{
  const r=await relay();
  try{
    const a=client(r.port),b=client(r.port);await Promise.all([a.opened,b.opened]);
    a.send({t:'hello',v:PROTOCOL,name:'Alpha',agent:'Phoenix'});b.send({t:'hello',v:PROTOCOL,name:'Bravo',agent:'Phoenix'});
    // Alpha switched to Raze and a skin after connecting; the queue request says so.
    a.send({t:'queue',agent:'Clay',skin:'/Game/Equippables/Guns/Rifles/AK/Dragon/AK_Dragon_PrimaryAsset',name:'Alpha2'});await a.next('queued');
    b.send({t:'queue',agent:'Bogus'});
    const [ma,mb]=await Promise.all([a.next('match'),b.next('match')]);
    assert.equal(mb.foe.agent,'Clay');assert.equal(mb.foe.name,'Alpha2');assert.equal(mb.foe.skin,'/Game/Equippables/Guns/Rifles/AK/Dragon/AK_Dragon_PrimaryAsset');
    assert.equal(ma.foe.agent,'Phoenix','an unknown agent keeps the last valid one');assert.equal(ma.you.agent,'Clay');
  }finally{await r.close();}
});

test('the match ends when time runs out: higher score wins, a tie is a draw',async()=>{
  const r=await relay({timeLimit:.3});
  try{
    const {a,b}=await pair(r.port);b.send({t:'dead',by:'foe'});await a.next('score');
    const end=await a.next('end');assert.equal(end.reason,'time');assert.equal(end.you,1);assert.notEqual(end.winner,null);
    assert.equal((await b.next('end')).winner,end.winner);
    const second=await pair(r.port,'TIE');const tie=await second.a.next('end');assert.equal(tie.reason,'time');assert.equal(tie.winner,null);
  }finally{await r.close();}
});
