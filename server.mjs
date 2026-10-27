// Phoenix Arena relay: matchmaking and message relay for the browser range's 1v1 battle mode.
// Clients are trusted (each simulates its own movement and shooting and reports its own hits and deaths, see
// PROTOCOL.md); the server pairs two players (public queue or a shared room code), relays their messages, keeps the
// kill score and ends the match at FIRST_TO kills. No game state is simulated here, so a free instance is plenty.
import http from 'node:http';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {WebSocketServer} from 'ws';

export const PROTOCOL=1;
const RATE=150;           // messages per second per socket (token bucket size and refill)
const HEARTBEAT_MS=15000; // ping interval; a socket that misses one pong is dropped

export function createRelay({port=Number(process.env.PORT||8787),staleMs=6000,firstTo=Number(process.env.FIRST_TO||5),maxClients=Number(process.env.MAX_CLIENTS||200),
  origins=(process.env.ALLOWED_ORIGINS||'https://phoenix-ascent-arena.vercel.app').split(',').map(s=>s.trim()).filter(Boolean),log=console.log}={}){
  const clients=new Set(),publicQueue=[],privateQueue=new Map(),rooms=new Map();let nextId=1,matches=0;
  // Browsers send Origin: only the deployed site and local development pages may connect.
  const allowedOrigin=origin=>{try{const u=new URL(origin);return u.hostname==='localhost'||u.hostname==='127.0.0.1'||origins.includes(u.origin);}catch{return false;}};
  const send=(c,msg)=>{if(c.ws.readyState===1)c.ws.send(typeof msg==='string'?msg:JSON.stringify(msg));};
  const foeOf=c=>c.room?.players.find(p=>p!==c)||null;
  // A closed tab can leave its socket open here until the heartbeat notices; never pair a player with one (staleMs:
  // clients ping every 2 s, so a waiting player silent for 6 s is gone).
  const live=c=>c.ws.readyState===1&&Date.now()-c.lastSeen<staleMs;
  const stats=()=>({service:'phoenix-arena-relay',protocol:PROTOCOL,online:clients.size,queued:publicQueue.length+privateQueue.size,rooms:rooms.size,matches,firstTo});

  function dequeue(c){
    const i=publicQueue.indexOf(c);if(i>=0)publicQueue.splice(i,1);
    if(c.code&&privateQueue.get(c.code)===c)privateQueue.delete(c.code);
    c.code=null;
  }
  function startMatch(a,b){
    const room={id:randomBytes(4).toString('hex'),players:[a,b],score:new Map([[a,0],[b,0]]),ended:false,seed:randomBytes(4).readUInt32LE()};
    rooms.set(room.id,room);matches++;
    [a,b].forEach((c,i)=>{c.room=room;const foe=i?a:b;send(c,{t:'match',room:room.id,side:i?'defend':'attack',foe:{id:foe.id,name:foe.name,agent:foe.agent},firstTo,seed:room.seed});});
    log(`match ${room.id} (${rooms.size} running)`);
  }
  function endRoom(room,reason,winner){
    if(room.ended)return;room.ended=true;rooms.delete(room.id);
    for(const p of room.players){if(p.room!==room)continue;p.room=null;const foe=room.players.find(x=>x!==p);
      send(p,{t:'end',reason,winner:winner?.id??null,you:room.score.get(p),foe:room.score.get(foe)});}
    log(`end ${room.id} ${reason}`);
  }
  function take(c){
    const now=Date.now();c.tokens=Math.min(RATE,c.tokens+(now-c.last)*RATE/1000);c.last=now;
    if(c.tokens<1){if(++c.drops>RATE*10)c.ws.close(1008,'rate');return false;}
    c.tokens--;return true;
  }
  const finite=v=>typeof v==='number'&&Number.isFinite(v);
  function onMessage(c,data,isBinary){
    c.lastSeen=Date.now();
    if(isBinary||!take(c))return;
    let m;try{m=JSON.parse(data);}catch{return;}
    if(!m||typeof m.t!=='string')return;
    switch(m.t){
      case 'hello':
        c.name=String(m.name??'').replace(/[^\w .-]/g,'').trim().slice(0,16)||'Player '+c.id;c.agent=m.agent==='Clay'?'Clay':'Phoenix';
        if(m.v!==PROTOCOL)send(c,{t:'error',code:'protocol',want:PROTOCOL});
        return;
      case 'queue':{
        if(c.room)return;dequeue(c);
        const code=typeof m.code==='string'?m.code.toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,8):'';
        if(code){
          const other=privateQueue.get(code);
          if(other&&other!==c&&live(other)){privateQueue.delete(code);other.code=null;startMatch(other,c);}
          else{privateQueue.set(code,c);c.code=code;send(c,{t:'queued',code});}
        }else{
          let other;while((other=publicQueue.shift())&&!live(other));
          if(other)startMatch(other,c);else{publicQueue.push(c);send(c,{t:'queued',position:publicQueue.length});}
        }
        return;
      }
      case 'leave':
        dequeue(c);if(c.room)endRoom(c.room,'left',foeOf(c));
        return;
      case 's':case 'ev':{
        // State and effect events go to the opponent as sent (size is capped by maxPayload).
        const foe=foeOf(c);if(foe)send(foe,typeof data==='string'?data:data.toString());
        return;
      }
      case 'hit':{
        const foe=foeOf(c);if(!foe||!finite(m.dmg)||m.dmg<=0||m.dmg>1000)return;
        send(foe,{t:'hit',dmg:m.dmg,region:['head','body','legs'].includes(m.region)?m.region:'body',w:typeof m.w==='string'?m.w.slice(0,32):null});
        return;
      }
      case 'dead':{
        // The victim reports its own death; a death by the opponent scores for the opponent.
        const room=c.room;if(!room)return;const foe=foeOf(c);
        if(m.by==='foe'&&foe){room.score.set(foe,room.score.get(foe)+1);send(foe,{t:'kill'});}
        for(const p of room.players)send(p,{t:'score',you:room.score.get(p),foe:room.score.get(room.players.find(x=>x!==p))});
        if(foe&&room.score.get(foe)>=firstTo)endRoom(room,'score',foe);
        return;
      }
      case 'ping':
        if(finite(m.c))send(c,{t:'pong',c:m.c,s:Date.now()});
        return;
    }
  }

  const wss=new WebSocketServer({noServer:true,maxPayload:4096,perMessageDeflate:false});
  wss.on('connection',ws=>{
    const c={ws,id:nextId++,name:null,agent:'Phoenix',room:null,code:null,tokens:RATE,last:Date.now(),lastSeen:Date.now(),drops:0,alive:true};
    clients.add(c);
    ws.on('pong',()=>{c.alive=true;});
    ws.on('message',(data,isBinary)=>onMessage(c,data,isBinary));
    ws.on('close',()=>{clients.delete(c);dequeue(c);if(c.room)endRoom(c.room,'disconnect',foeOf(c));});
    ws.on('error',()=>{});
    send(c,{t:'welcome',id:c.id,protocol:PROTOCOL,online:clients.size});
  });
  const heartbeat=setInterval(()=>{for(const c of clients){if(!c.alive){c.ws.terminate();continue;}c.alive=false;c.ws.ping();}},HEARTBEAT_MS);

  const server=http.createServer((req,res)=>{
    const path=new URL(req.url,'http://relay').pathname;
    // Public, read-only status; any page may poll it (the client uses it to wake a sleeping free instance).
    const headers={'Access-Control-Allow-Origin':'*','Cache-Control':'no-store'};
    if(path==='/health'){res.writeHead(200,{...headers,'Content-Type':'text/plain'}).end('ok');return;}
    if(path==='/'||path==='/status'){res.writeHead(200,{...headers,'Content-Type':'application/json'}).end(JSON.stringify(stats()));return;}
    res.writeHead(404,headers).end();
  });
  server.on('upgrade',(req,socket,head)=>{
    const path=new URL(req.url,'http://relay').pathname;
    if(path!=='/ws'||!allowedOrigin(req.headers.origin)||clients.size>=maxClients){socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');socket.destroy();return;}
    wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req));
  });
  const ready=new Promise(resolve=>server.listen(port,()=>{log(`relay on :${server.address().port}`);resolve(server.address().port);}));
  async function close(){
    clearInterval(heartbeat);
    for(const room of [...rooms.values()])endRoom(room,'server-restart',null);
    for(const c of clients)c.ws.close(1001,'restart');
    await new Promise(resolve=>server.close(()=>resolve()));
  }
  return {server,ready,close,stats};
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
  const relay=createRelay();
  // Render sends SIGTERM before replacing or sleeping an instance: tell running matches.
  for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>relay.close().then(()=>process.exit(0)));
}
