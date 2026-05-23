'use strict';
const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');

const app    = express();
const server = http.createServer(app);

// ─── Socket.IO ───────────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },

  // Render: always start with polling so the HTTP upgrade can complete
  transports: ['polling', 'websocket'],

  // Generous timeouts for Render's cold-start / sleep behaviour
  pingTimeout:  30000,
  pingInterval: 10000,

  // Allow reasonably-large signaling payloads (SDP can be ~8 KB each)
  maxHttpBufferSize: 128 * 1024,   // 128 KB

  httpCompression: true,
  perMessageDeflate: { threshold: 512, zlibDeflateOptions: { level: 1 } },
});

// ─── Static files ────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1d', etag: true, lastModified: true,
}));
app.get('*', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── In-memory state ─────────────────────────────────────────────────────────
const waitingQueue = [];
const activePairs  = new Map();          // socketId → partnerId
const userNames    = new Map();          // socketId → name
const onlineCount  = { value: 0 };

// roomId → { password, host, members:[{socketId,name}], started:bool }
const rooms      = new Map();
const roomTimers = new Map();

// Rate limiting — per-socket message counter
const msgRateMap    = new Map();
const MSG_RATE_LIMIT  = 8;
const MSG_RATE_WINDOW = 2000;

function isRateLimited(socketId) {
  const now = Date.now();
  let e = msgRateMap.get(socketId);
  if (!e || now > e.resetAt) {
    msgRateMap.set(socketId, { count: 1, resetAt: now + MSG_RATE_WINDOW });
    return false;
  }
  return ++e.count > MSG_RATE_LIMIT;
}

function generateRoomId() {
  let id;
  do { id = String(Math.floor(100000 + Math.random() * 900000)); }
  while (rooms.has(id));
  return id;
}

// Throttled online-count broadcast (max once per 500 ms)
let bcTimer = null;
function broadcastOnlineCount() {
  if (bcTimer) return;
  bcTimer = setTimeout(() => {
    io.emit('online_count', onlineCount.value);
    bcTimer = null;
  }, 500);
}

function tryMatch() {
  while (waitingQueue.length >= 2) {
    const uA = waitingQueue.shift();
    const uB = waitingQueue.shift();
    const sA = io.sockets.sockets.get(uA.socketId);
    const sB = io.sockets.sockets.get(uB.socketId);
    if (!sA || !sB) {
      if (sA) waitingQueue.unshift(uA);
      if (sB) waitingQueue.unshift(uB);
      continue;
    }
    activePairs.set(uA.socketId, uB.socketId);
    activePairs.set(uB.socketId, uA.socketId);
    sA.emit('matched', { partnerName: uB.name, initiator: true  });
    sB.emit('matched', { partnerName: uA.name, initiator: false });
    console.log(`[MATCH] ${uA.name} ↔ ${uB.name}`);
  }
}

// ─── Connection handler ───────────────────────────────────────────────────────
io.on('connection', (socket) => {
  onlineCount.value++;
  broadcastOnlineCount();
  console.log(`[CONNECT] ${socket.id} | online=${onlineCount.value} transport=${socket.conn.transport.name}`);

  // Log transport upgrades (polling → websocket)
  socket.conn.on('upgrade', (t) =>
    console.log(`[UPGRADE] ${socket.id} → ${t.name}`));

  // ── Stranger queue ──────────────────────────────────────────────────────────
  socket.on('join_queue', ({ name }) => {
    const safeName = String(name || '').trim().slice(0, 24) || 'Stranger';
    userNames.set(socket.id, safeName);
    const idx = waitingQueue.findIndex(u => u.socketId === socket.id);
    if (idx !== -1) waitingQueue.splice(idx, 1);
    waitingQueue.push({ socketId: socket.id, name: safeName });
    socket.emit('waiting');
    tryMatch();
  });

  // ── Room: Create ────────────────────────────────────────────────────────────
  socket.on('create_room', ({ name, password }) => {
    const safeName = String(name || '').trim().slice(0, 24) || 'Host';
    const safePass = String(password || '').trim().slice(0, 32);
    const roomId   = generateRoomId();
    userNames.set(socket.id, safeName);
    rooms.set(roomId, {
      password: safePass,
      host:     socket.id,
      members:  [{ socketId: socket.id, name: safeName }],
      started:  false,
    });
    socket.join(roomId);
    socket.emit('room_created', {
      roomId, name: safeName,
      members: [{ socketId: socket.id, name: safeName }],
    });
    console.log(`[ROOM] Created ${roomId} by ${safeName}`);
  });

  // ── Room: Join ──────────────────────────────────────────────────────────────
  socket.on('join_room', ({ roomId, password, name }) => {
    const safeName = String(name || '').trim().slice(0, 24) || 'User';
    const room     = rooms.get(roomId);

    if (!room)  { socket.emit('room_error', { msg: 'Room not found or expired' }); return; }
    if (room.password !== String(password || '').trim())
                { socket.emit('room_error', { msg: 'Wrong password' }); return; }
    if (room.members.length >= 6)
                { socket.emit('room_error', { msg: 'Room is full (max 6)' }); return; }

    // Clear any pending close timer (rejoin within 30 s)
    if (roomTimers.has(roomId)) {
      clearTimeout(roomTimers.get(roomId));
      roomTimers.delete(roomId);
    }

    // If this socket is already in the member list (fast reconnect / duplicate join),
    // remove the stale entry so we get a clean slot.
    const staleIdx = room.members.findIndex(m => m.socketId === socket.id);
    if (staleIdx !== -1) room.members.splice(staleIdx, 1);

    userNames.set(socket.id, safeName);
    room.members.push({ socketId: socket.id, name: safeName });
    socket.join(roomId);

    socket.emit('room_joined', {
      roomId, name: safeName,
      members: room.members,
      started: room.started,
    });

    // Tell others: new member arrived; pass sessionActive so they know whether
    // the call is already live (and they need to wait for offers from the newcomer)
    socket.to(roomId).emit('room_member_joined', {
      socketId:      socket.id,
      name:          safeName,
      members:       room.members,
      sessionActive: room.started,
    });

    console.log(`[ROOM] ${safeName}(${socket.id}) joined ${roomId} | members=${room.members.length} started=${room.started}`);
  });

  // ── Room: Mark session started ─────────────────────────────────────────────
  // Only the host calls this on the very first "Start" click; rejoining users
  // never emit room_start — the server uses room.started to gate this.
  socket.on('room_start', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    // Prevent duplicate marking from reconnects
    if (!room.started) {
      room.started = true;
      console.log(`[ROOM] ${roomId} marked as started`);
    }
  });

  // ── Room: WebRTC mesh signaling ─────────────────────────────────────────────
  socket.on('room_offer', ({ targetId, offer }) => {
    if (!offer || !targetId) return;
    io.to(targetId).emit('room_offer', { fromId: socket.id, offer });
    console.log(`[SIG] offer ${socket.id} → ${targetId}`);
  });

  socket.on('room_answer', ({ targetId, answer }) => {
    if (!answer || !targetId) return;
    io.to(targetId).emit('room_answer', { fromId: socket.id, answer });
    console.log(`[SIG] answer ${socket.id} → ${targetId}`);
  });

  socket.on('room_ice', ({ targetId, candidate }) => {
    if (!targetId) return;
    io.to(targetId).emit('room_ice', { fromId: socket.id, candidate });
  });

  // ── Room: Request re-offer (peer asks us to re-offer after reconnect) ───────
  socket.on('room_request_offer', ({ targetId }) => {
    if (!targetId) return;
    io.to(targetId).emit('room_request_offer', { fromId: socket.id });
    console.log(`[SIG] re-offer request: ${socket.id} → ${targetId}`);
  });

  // ── Room: Chat (rate-limited) ───────────────────────────────────────────────
  socket.on('room_message', ({ roomId, text }) => {
    if (isRateLimited(socket.id)) return;
    const name     = userNames.get(socket.id) || 'User';
    const safeText = String(text || '').trim().slice(0, 500);
    if (safeText) socket.to(roomId).emit('room_message', { from: name, text: safeText, timestamp: Date.now() });
  });

  socket.on('room_force_mute', ({ roomId, targetId, muted }) => {
    const byName = userNames.get(socket.id) || 'Someone';
    io.to(targetId).emit('room_force_muted', { byName, muted });
    socket.to(roomId).emit('room_member_media', { socketId: targetId, audioMuted: muted, videoOff: false });
  });

  socket.on('room_media_state', ({ roomId, audioMuted, videoOff }) => {
    socket.to(roomId).emit('room_member_media', { socketId: socket.id, audioMuted, videoOff });
  });

  // ── Stranger: WebRTC signaling ──────────────────────────────────────────────
  socket.on('webrtc_offer', ({ offer }) => {
    const pid = activePairs.get(socket.id);
    if (pid) io.to(pid).emit('webrtc_offer', { offer });
  });
  socket.on('webrtc_answer', ({ answer }) => {
    const pid = activePairs.get(socket.id);
    if (pid) io.to(pid).emit('webrtc_answer', { answer });
  });
  socket.on('webrtc_ice', ({ candidate }) => {
    const pid = activePairs.get(socket.id);
    if (pid) io.to(pid).emit('webrtc_ice', { candidate });
  });

  // ── Stranger: Chat ──────────────────────────────────────────────────────────
  socket.on('chat_message', ({ text }) => {
    if (isRateLimited(socket.id)) return;
    const pid      = activePairs.get(socket.id);
    const sender   = userNames.get(socket.id) || 'Stranger';
    const safeText = String(text || '').trim().slice(0, 500);
    if (pid && safeText) io.to(pid).emit('chat_message', { from: sender, text: safeText, timestamp: Date.now() });
  });

  socket.on('skip', () => handleDisconnectFromPair(socket, true));

  // ── Disconnect ──────────────────────────────────────────────────────────────
  socket.on('disconnect', (reason) => {
    onlineCount.value = Math.max(0, onlineCount.value - 1);
    broadcastOnlineCount();
    handleDisconnectFromPair(socket, false);
    handleRoomLeave(socket);
    userNames.delete(socket.id);
    msgRateMap.delete(socket.id);
    console.log(`[DISCONNECT] ${socket.id} reason=${reason} | online=${onlineCount.value}`);
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────
function handleDisconnectFromPair(socket, requeue) {
  const pid = activePairs.get(socket.id);
  if (pid) {
    activePairs.delete(socket.id);
    activePairs.delete(pid);
    const ps = io.sockets.sockets.get(pid);
    if (ps) ps.emit('partner_left');
  }
  const idx = waitingQueue.findIndex(u => u.socketId === socket.id);
  if (idx !== -1) waitingQueue.splice(idx, 1);
  if (requeue) {
    const name = userNames.get(socket.id) || 'Stranger';
    waitingQueue.push({ socketId: socket.id, name });
    socket.emit('waiting');
    tryMatch();
  }
}

function handleRoomLeave(socket) {
  for (const [roomId, room] of rooms.entries()) {
    const idx = room.members.findIndex(m => m.socketId === socket.id);
    if (idx === -1) continue;

    const leftName = room.members[idx].name;
    room.members.splice(idx, 1);

    if (room.members.length === 0) {
      if (roomTimers.has(roomId)) { clearTimeout(roomTimers.get(roomId)); roomTimers.delete(roomId); }
      rooms.delete(roomId);
      console.log(`[ROOM] ${roomId} deleted (empty)`);
    } else {
      if (room.host === socket.id) room.host = room.members[0].socketId;
      io.to(roomId).emit('room_member_left', {
        socketId: socket.id, name: leftName, members: room.members,
      });

      if (room.members.length === 1) {
        if (roomTimers.has(roomId)) clearTimeout(roomTimers.get(roomId));
        const timer = setTimeout(() => {
          const r = rooms.get(roomId);
          if (r && r.members.length <= 1) {
            if (r.members.length === 1)
              io.to(r.members[0].socketId).emit('room_closed', { msg: 'Room closed — you were alone for 30 s.' });
            rooms.delete(roomId);
            roomTimers.delete(roomId);
          }
        }, 30_000);
        roomTimers.set(roomId, timer);
      }
    }
    break;
  }
}

// ─── Start ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════╗`);
  console.log(`║  CHAT-RIX  :${PORT}              ║`);
  console.log(`╚══════════════════════════════╝\n`);
});
