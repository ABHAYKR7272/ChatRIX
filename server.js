const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── State ───────────────────────────────────────────────────────────────────
const waitingQueue = [];
const activePairs  = new Map();
const userNames    = new Map();
const onlineCount  = { value: 0 };

// Room state: roomId → { password, host, members:[{socketId,name}], started:bool }
const rooms = new Map();
// Auto-close timers: roomId → setTimeout handle (fires when only 1 member left)
const roomTimers = new Map();

function generateRoomId() {
  let id;
  do { id = String(Math.floor(100000 + Math.random() * 900000)); }
  while (rooms.has(id));
  return id;
}

function broadcastOnlineCount() {
  io.emit('online_count', onlineCount.value);
}

function tryMatch() {
  while (waitingQueue.length >= 2) {
    const userA = waitingQueue.shift();
    const userB = waitingQueue.shift();
    const socketA = io.sockets.sockets.get(userA.socketId);
    const socketB = io.sockets.sockets.get(userB.socketId);
    if (!socketA || !socketB) {
      if (socketA) waitingQueue.unshift(userA);
      if (socketB) waitingQueue.unshift(userB);
      continue;
    }
    activePairs.set(userA.socketId, userB.socketId);
    activePairs.set(userB.socketId, userA.socketId);
    socketA.emit('matched', { partnerName: userB.name, initiator: true });
    socketB.emit('matched', { partnerName: userA.name, initiator: false });
    console.log(`[MATCH] ${userA.name} ↔ ${userB.name}`);
  }
}

// ─── Socket Events ───────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  onlineCount.value++;
  broadcastOnlineCount();
  console.log(`[CONNECT] ${socket.id} | Online: ${onlineCount.value}`);

  // ── Stranger mode ──
  socket.on('join_queue', ({ name }) => {
    const safeName = String(name).trim().slice(0, 24) || 'Stranger';
    userNames.set(socket.id, safeName);
    const existingIdx = waitingQueue.findIndex(u => u.socketId === socket.id);
    if (existingIdx !== -1) waitingQueue.splice(existingIdx, 1);
    waitingQueue.push({ socketId: socket.id, name: safeName });
    socket.emit('waiting');
    console.log(`[QUEUE] ${safeName} waiting | Queue: ${waitingQueue.length}`);
    tryMatch();
  });

  // ── Room: Create ──
  socket.on('create_room', ({ name, password }) => {
    const safeName = String(name).trim().slice(0, 24) || 'Host';
    const safePass = String(password).trim().slice(0, 32);
    const roomId   = generateRoomId();
    userNames.set(socket.id, safeName);
    rooms.set(roomId, {
      password: safePass,
      host: socket.id,
      members: [{ socketId: socket.id, name: safeName }],
      started: false
    });
    socket.join(roomId);
    socket.emit('room_created', {
      roomId,
      name: safeName,
      members: [{ socketId: socket.id, name: safeName }]
    });
    console.log(`[ROOM] Created ${roomId} by ${safeName}`);
  });

  // ── Room: Start (host clicks Start) ──
  socket.on('room_start', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (room) {
      room.started = true;
      console.log(`[ROOM] ${roomId} session started`);
    }
  });

  // ── Room: Join ──
  socket.on('join_room', ({ roomId, password, name }) => {
    const safeName = String(name).trim().slice(0, 24) || 'User';
    const room = rooms.get(roomId);
    if (!room) { socket.emit('room_error', { msg: 'Room not found or expired' }); return; }
    if (room.password !== String(password).trim()) { socket.emit('room_error', { msg: 'Wrong password' }); return; }
    if (room.members.length >= 6) { socket.emit('room_error', { msg: 'Room is full (max 6)' }); return; }

    // Cancel auto-close timer if running (someone rejoined!)
    if (roomTimers.has(roomId)) {
      clearTimeout(roomTimers.get(roomId));
      roomTimers.delete(roomId);
      console.log(`[ROOM] Auto-close cancelled for ${roomId} — new member joined`);
    }

    userNames.set(socket.id, safeName);
    room.members.push({ socketId: socket.id, name: safeName });
    socket.join(roomId);

    // Tell joiner who is already there + whether session is live
    socket.emit('room_joined', {
      roomId,
      name: safeName,
      members: room.members,
      started: room.started
    });

    // Tell others someone joined
    socket.to(roomId).emit('room_member_joined', {
      socketId: socket.id,
      name: safeName,
      members: room.members,
      sessionActive: room.started
    });

    console.log(`[ROOM] ${safeName} joined ${roomId} | Members: ${room.members.length} | Started: ${room.started}`);
  });

  // ── Room: WebRTC mesh signaling ──
  socket.on('room_offer', ({ targetId, offer }) => {
    io.to(targetId).emit('room_offer', { fromId: socket.id, offer });
  });

  socket.on('room_answer', ({ targetId, answer }) => {
    io.to(targetId).emit('room_answer', { fromId: socket.id, answer });
  });

  socket.on('room_ice', ({ targetId, candidate }) => {
    io.to(targetId).emit('room_ice', { fromId: socket.id, candidate });
  });

  // ── Room: Chat ──
  socket.on('room_message', ({ roomId, text }) => {
    const name = userNames.get(socket.id) || 'User';
    if (text && String(text).trim().length > 0) {
      const safeText = String(text).trim().slice(0, 500);
      // socket.to() — excludes sender so they don't see duplicate (sender adds locally)
      socket.to(roomId).emit('room_message', { from: name, text: safeText, timestamp: Date.now() });
    }
  });

  // ── Room: Force mute/unmute someone for all ──
  socket.on('room_force_mute', ({ roomId, targetId, muted }) => {
    const byName = userNames.get(socket.id) || 'Someone';
    // Tell target to mute/unmute themselves
    io.to(targetId).emit('room_force_muted', { byName, muted });
    // Tell everyone the target's media state changed (for UI indicators)
    socket.to(roomId).emit('room_member_media', { socketId: targetId, audioMuted: muted, videoOff: false });
    console.log(`[ROOM] ${byName} ${muted ? 'muted' : 'unmuted'} ${targetId} for all`);
  });

  // ── Room: Per-user mute/video status ──
  socket.on('room_media_state', ({ roomId, audioMuted, videoOff }) => {
    socket.to(roomId).emit('room_member_media', {
      socketId: socket.id,
      audioMuted,
      videoOff
    });
  });

  // ── Stranger WebRTC ──
  socket.on('webrtc_offer', ({ offer }) => {
    const partnerId = activePairs.get(socket.id);
    if (partnerId) io.to(partnerId).emit('webrtc_offer', { offer });
  });
  socket.on('webrtc_answer', ({ answer }) => {
    const partnerId = activePairs.get(socket.id);
    if (partnerId) io.to(partnerId).emit('webrtc_answer', { answer });
  });
  socket.on('webrtc_ice', ({ candidate }) => {
    const partnerId = activePairs.get(socket.id);
    if (partnerId) io.to(partnerId).emit('webrtc_ice', { candidate });
  });

  // ── Stranger Chat ──
  socket.on('chat_message', ({ text }) => {
    const partnerId = activePairs.get(socket.id);
    const senderName = userNames.get(socket.id) || 'Stranger';
    if (partnerId && text && String(text).trim().length > 0) {
      const safeText = String(text).trim().slice(0, 500);
      io.to(partnerId).emit('chat_message', { from: senderName, text: safeText, timestamp: Date.now() });
    }
  });

  socket.on('skip', () => handleDisconnectFromPair(socket, true));

  socket.on('disconnect', () => {
    onlineCount.value = Math.max(0, onlineCount.value - 1);
    broadcastOnlineCount();
    handleDisconnectFromPair(socket, false);
    handleRoomLeave(socket);
    userNames.delete(socket.id);
    console.log(`[DISCONNECT] ${socket.id} | Online: ${onlineCount.value}`);
  });
});

function handleDisconnectFromPair(socket, requeue) {
  const partnerId = activePairs.get(socket.id);
  if (partnerId) {
    activePairs.delete(socket.id);
    activePairs.delete(partnerId);
    const partnerSocket = io.sockets.sockets.get(partnerId);
    if (partnerSocket) partnerSocket.emit('partner_left');
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
    if (idx !== -1) {
      const leftName = room.members[idx].name;
      room.members.splice(idx, 1);
      if (room.members.length === 0) {
        // Cancel any pending timer, delete room
        if (roomTimers.has(roomId)) { clearTimeout(roomTimers.get(roomId)); roomTimers.delete(roomId); }
        rooms.delete(roomId);
        console.log(`[ROOM] ${roomId} deleted (empty)`);
      } else {
        if (room.host === socket.id) room.host = room.members[0].socketId;
        io.to(roomId).emit('room_member_left', {
          socketId: socket.id,
          name: leftName,
          members: room.members
        });
        console.log(`[ROOM] ${leftName} left ${roomId} | Members: ${room.members.length}`);

        // Auto-close room after 30s if only 1 person remains alone
        if (room.members.length === 1) {
          if (roomTimers.has(roomId)) clearTimeout(roomTimers.get(roomId));
          const timer = setTimeout(() => {
            const r = rooms.get(roomId);
            if (r && r.members.length <= 1) {
              if (r.members.length === 1) {
                io.to(r.members[0].socketId).emit('room_closed', {
                  msg: 'Room closed — you were alone for 30 seconds. Room ID has expired.'
                });
              }
              rooms.delete(roomId);
              roomTimers.delete(roomId);
              console.log(`[ROOM] ${roomId} auto-closed (solo timeout)`);
            }
          }, 30000);
          roomTimers.set(roomId, timer);
          console.log(`[ROOM] Auto-close timer started for ${roomId} (30s)`);
        }
      }
      break;
    }
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════╗`);
  console.log(`║  CHAT-RIX SERVER  :${PORT}     ║`);
  console.log(`╚══════════════════════════════╝\n`);
});
