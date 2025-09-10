const WebSocket = require('ws');

const PORT = 3322;
const rooms = new Map();   // roomKey -> Set<WebSocket>
let serverInstance = null;

function broadcast(room, data, except) {
  const set = rooms.get(room);
  if(!set) return;
  const msg = JSON.stringify(data);
  set.forEach(ws=> { if(ws!==except && ws.readyState===1) ws.send(msg); });
}

function attach(ws) {
  let roomKey = null;
  let id = Math.random().toString(36).slice(2,9);

  ws.on('message', raw=> {
    let msg;
    try { msg = JSON.parse(raw); } catch(_) { return; }
    if(msg.type==='join') {
      roomKey = msg.room;
      if(!rooms.has(roomKey)) rooms.set(roomKey,new Set());
      rooms.get(roomKey).add(ws);
      broadcast(roomKey,{type:'roster', size: rooms.get(roomKey).size});
    }
    if(msg.type==='signal' && roomKey) {
      broadcast(roomKey,{type:'signal', from: msg.from, data: msg.data}, ws);
    }
  });

  ws.on('close', ()=> {
    if(roomKey && rooms.get(roomKey)) {
      rooms.get(roomKey).delete(ws);
      broadcast(roomKey,{type:'roster', size: rooms.get(roomKey).size});
    }
  });
}

function startSignalServer(port = 3322) {
  if (serverInstance) {
    console.log('[SignalServer] Reusing existing instance on port', serverInstance.address().port);
    return serverInstance;
  }

  try {
    serverInstance = new WebSocket.Server({ port });
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      console.warn(`[SignalServer] Port ${port} already in use – assuming server is already running`);
      return null; // silently ignore
    }
    throw err;
  }

  console.log(`[SignalServer] Listening on ws://localhost:${port}`);
  serverInstance.on('connection', attach);

  return serverInstance;
}

module.exports = { startSignalServer }; 