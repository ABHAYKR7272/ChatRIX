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
  transports: ['websocket', 'polling'],
  upgrade: true,
  pingTimeout:  15000,
  pingInterval:  5000,
  maxHttpBufferSize: 256 * 1024,
  httpCompression: true,
  perMessageDeflate: { threshold: 256, zlibDeflateOptions: { level: 1 } },
  connectionStateRecovery: {
    maxDisconnectionDuration: 3 * 60 * 1000,
    skipMiddlewares: true,
  },
});

// ─── Static files ────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1d', etag: true, lastModified: true,
}));
app.get('*', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── In-memory state ─────────────────────────────────────────────────────────
const waitingQueue = [];
const activePairs  = new Map();
const userNames    = new Map();
const onlineCount  = { value: 0 };

// roomId → {
//   password, host, originalHost,
//   members:[{socketId,name}],
//   started:bool,
//   joinedIds:Set,    // all socket IDs ever seen (for reconnect)
//   knownNames:Map    // name → socketId (tracks who has ever been in room)
// }
const rooms      = new Map();
const roomTimers = new Map();

// Rate limiting
const msgRateMap    = new Map();
const MSG_RATE_LIMIT  = 12;
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

let bcTimer = null;
function broadcastOnlineCount() {
  if (bcTimer) return;
  bcTimer = setTimeout(() => {
    io.emit('online_count', onlineCount.value);
    bcTimer = null;
  }, 300);
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
  // CHANGED: maxMembers always = 2, no selector
  socket.on('create_room', ({ name, password }) => {
    const safeName = String(name || '').trim().slice(0, 24) || 'Host';
    const safePass = String(password || '').trim().slice(0, 32);
    const roomId   = generateRoomId();
    userNames.set(socket.id, safeName);

    const knownNames = new Map();
    knownNames.set(safeName, socket.id);

    rooms.set(roomId, {
      password:     safePass,
      host:         socket.id,
      originalHost: socket.id,
      maxMembers:   2,
      members:      [{ socketId: socket.id, name: safeName }],
      started:      false,
      joinedIds:    new Set([socket.id]),
      knownNames,
    });
    socket.join(roomId);
    socket.emit('room_created', {
      roomId, name: safeName,
      members: [{ socketId: socket.id, name: safeName }],
      maxMembers: 2,
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

    const isCurrentMember = room.members.some(m => m.socketId === socket.id);
    const wasEverMember   = room.joinedIds && room.joinedIds.has(socket.id);

    // Check if this name was ever in the room (for creator/member returning with same name)
    const isKnownName = room.knownNames && room.knownNames.has(safeName);

    // Only truly new strangers are blocked after session started
    if (room.started && !isCurrentMember && !wasEverMember && !isKnownName) {
      socket.emit('room_error', {
        msg: 'Session already started — this room is closed to new members.',
        code: 'SESSION_STARTED',
      });
      return;
    }

    // Full room check only for truly new joiners (not returning members)
    if (!isCurrentMember && !wasEverMember && !isKnownName && room.members.length >= room.maxMembers) {
      socket.emit('room_error', { msg: 'Room is full (max 2)' });
      return;
    }

    // Clear any pending close timer
    if (roomTimers.has(roomId)) {
      clearTimeout(roomTimers.get(roomId));
      roomTimers.delete(roomId);
    }

    // Remove stale entry for this socket
    const staleIdx = room.members.findIndex(m => m.socketId === socket.id);
    if (staleIdx !== -1) room.members.splice(staleIdx, 1);

    userNames.set(socket.id, safeName);
    room.members.push({ socketId: socket.id, name: safeName });
    if (room.joinedIds) room.joinedIds.add(socket.id);
    if (room.knownNames) room.knownNames.set(safeName, socket.id);
    socket.join(roomId);

    // If this is the original host rejoining, restore host role
    // (name-based identification since socket ID changes on reconnect)
    const origHostName = room.knownNames ? [...room.knownNames.entries()].find(([,id]) => id === room.originalHost)?.[0] : null;
    if (origHostName === safeName && room.host !== socket.id) {
      // Check if original host is no longer connected
      const origSock = io.sockets.sockets.get(room.host);
      if (!origSock) {
        // Original host reconnected — give them host back
        room.originalHost = socket.id;
        room.host = socket.id;
        console.log(`[ROOM] ${safeName} reclaimed host in ${roomId}`);
      }
    }

    socket.emit('room_joined', {
      roomId, name: safeName,
      members:    room.members,
      maxMembers: room.maxMembers,
      started:    room.started,
      isHost:     room.host === socket.id,
    });

    socket.to(roomId).emit('room_member_joined', {
      socketId:      socket.id,
      name:          safeName,
      members:       room.members,
      maxMembers:    room.maxMembers,
      sessionActive: room.started,
    });

    console.log(`[ROOM] ${safeName}(${socket.id}) joined ${roomId} | members=${room.members.length}/2 started=${room.started}`);

    // Auto-start when both members present
    if (!room.started && room.members.length >= room.maxMembers) {
      room.started = true;
      console.log(`[ROOM] ${roomId} auto-starting — both members present`);
      setTimeout(() => {
        io.to(roomId).emit('room_auto_start', {
          members:    room.members,
          maxMembers: room.maxMembers,
        });
      }, 150);
    }
  });

  socket.on('room_start', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.started) return;
    room.started = true;
    console.log(`[ROOM] ${roomId} marked as started`);
  });

  // ── Room: WebRTC signaling ──────────────────────────────────────────────────
  socket.on('room_offer', ({ targetId, offer }) => {
    if (!offer || !targetId) return;
    io.to(targetId).emit('room_offer', { fromId: socket.id, offer });
  });
  socket.on('room_answer', ({ targetId, answer }) => {
    if (!answer || !targetId) return;
    io.to(targetId).emit('room_answer', { fromId: socket.id, answer });
  });
  socket.on('room_ice', ({ targetId, candidate }) => {
    if (!targetId) return;
    io.to(targetId).emit('room_ice', { fromId: socket.id, candidate });
  });
  socket.on('room_request_offer', ({ targetId }) => {
    if (!targetId) return;
    io.to(targetId).emit('room_request_offer', { fromId: socket.id });
  });

  // ── Room: Chat ──────────────────────────────────────────────────────────────
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
      // Transfer host if needed
      if (room.host === socket.id) {
        room.host = room.members[0].socketId;
        console.log(`[ROOM] ${roomId} host transferred to ${room.members[0].name}`);
      }

      io.to(roomId).emit('room_member_left', {
        socketId: socket.id,
        name: leftName,
        members: room.members,
        newHost: room.host,
      });

      // FEATURE: When one person leaves a 2-person room session,
      // notify remaining person to go to waiting screen
      if (room.started && room.members.length === 1) {
        // Tell remaining member: partner left, go wait for them to rejoin
        io.to(room.members[0].socketId).emit('partner_left_rejoin', {
          leftName,
          roomId,
          msg: `${leftName} left. Waiting for them to rejoin…`,
        });

        // Set a 5-min timer to close room if no one rejoins
        if (roomTimers.has(roomId)) clearTimeout(roomTimers.get(roomId));
        const timer = setTimeout(() => {
          const r = rooms.get(roomId);
          if (r && r.members.length <= 1) {
            if (r.members.length === 1)
              io.to(r.members[0].socketId).emit('room_closed', { msg: 'Room closed — partner did not rejoin.' });
            rooms.delete(roomId);
            roomTimers.delete(roomId);
            console.log(`[ROOM] ${roomId} closed (timeout, partner never rejoined)`);
          }
        }, 5 * 60 * 1000);
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
