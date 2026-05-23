/* ═══════════════════════════════════════════════════════
   CHAT-RIX  —  app.js
   FIX: ghost socket, signalingState guards, ICE queue,
        rejoin glare, per-peer lock, stable-state check
   ═══════════════════════════════════════════════════════ */
'use strict';

const ICE_CFG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'turn:openrelay.metered.ca:80',  username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  ],
  iceCandidatePoolSize: 6,
  bundlePolicy: 'max-bundle',
  rtcpMuxPolicy: 'require',
};

// ─── Global state ─────────────────────────────────────
let socket            = null;
let localStream       = null;
let peerConnection    = null;   // stranger mode
let myName            = '';
let isMuted           = false;
let isCamOff          = false;

// Room state
let currentRoomId    = null;
let lastRoomPassword = '';
let roomPeers        = {};      // peerId → RTCPeerConnection
let roomStreams       = {};      // peerId → MediaStream
let silenceState     = {};
let roomMembers      = [];
let mySocketId       = null;
let focusedPeerId    = null;
let roomMuted        = false;
let roomCamOff       = false;
let remoteAudioMuted = {};
let remoteVideoOff   = {};

// Per-peer signaling lock: prevents concurrent offer/answer on same peer
// peerId → 'offering' | 'answering' | null
const peerLock = {};

// ICE candidate queue: holds candidates that arrive before remote desc is set
// peerId → RTCIceCandidateInit[]
const iceQueue = {};

let rebuildTimer = null;

// ─── DOM shortcuts ────────────────────────────────────
const $ = id => document.getElementById(id);

const screens = {
  landing:      $('screen-landing'),
  nameStranger: $('screen-name-stranger'),
  createRoom:   $('screen-create-room'),
  joinRoom:     $('screen-join-room'),
  waiting:      $('screen-waiting'),
  roomLobby:    $('screen-room-lobby'),
  chat:         $('screen-chat'),
  roomChat:     $('screen-room-chat'),
};

const onlineCountEls = {
  landing: $('online-count-landing'),
  wait:    $('online-count-wait'),
  chat:    $('online-count-chat'),
};

const toastEl            = $('toast');
const strangerNameInput  = $('stranger-name-input');
const btnStartStranger   = $('btn-start-stranger');
const btnCancelWait      = $('btn-cancel-wait');
const btnMute            = $('btn-mute');
const btnVideoToggle     = $('btn-video-toggle');
const btnSkip            = $('btn-skip');
const btnEnd             = $('btn-end');
const btnSend            = $('btn-send');
const chatInput          = $('chat-input');
const messagesContainer  = $('messages-container');
const localVideo         = $('localVideo');
const remoteVideo        = $('remoteVideo');
const remoteStatus       = $('remote-status');
const partnerNameDisplay = $('partner-name-display');
const modalLeft          = $('modal-left');
const createNameInput    = $('create-name-input');
const createPassInput    = $('create-pass-input');
const joinNameInput      = $('join-name-input');
const joinRoomIdInput    = $('join-roomid-input');
const joinPassInput      = $('join-pass-input');
const lobbyRoomId        = $('lobby-room-id');
const lobbyMembersList   = $('lobby-members-list');
const lobbyMemberCount   = $('lobby-member-count');
const btnStartRoom       = $('btn-start-room');
const roomVideoPanel     = $('room-video-panel');
const roomMsgContainer   = $('room-messages-container');
const roomChatInput      = $('room-chat-input');
const btnRoomSend        = $('btn-room-send');
const roomIdDisplay      = $('room-id-display');
const roomMemberCountEl  = $('room-member-count-display');
const btnRoomMute        = $('btn-room-mute');
const btnRoomCam         = $('btn-room-cam');
const btnRoomLeave       = $('btn-room-leave');

// ─── Screen ───────────────────────────────────────────
function showScreen(name) {
  Object.values(screens).forEach(el => { el.classList.remove('active','fade-in'); el.style.display = 'none'; });
  const t = screens[name];
  t.style.display = 'flex';
  requestAnimationFrame(() => t.classList.add('active','fade-in'));
}

// ─── Toast ────────────────────────────────────────────
let toastTmr = null;
function showToast(msg, ms = 2800) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTmr);
  toastTmr = setTimeout(() => toastEl.classList.remove('show'), ms);
}

// ─── Particles ────────────────────────────────────────
(function () {
  const cv = $('particleCanvas'); if (!cv) return;
  const cx = cv.getContext('2d');
  const N = 40, D = 80, CLR = ['#00ffff','#ff00aa','#00ff88','#fff'];
  let W, H, pts = [], run = true, raf = null;
  const resize = () => { W = cv.width = innerWidth; H = cv.height = innerHeight; };
  const rp = () => ({ x:Math.random()*W, y:Math.random()*H, r:Math.random()*1.2+.3,
    dx:(Math.random()-.5)*.35, dy:(Math.random()-.5)*.35,
    c:CLR[0|Math.random()*4], a:Math.random()*.4+.1 });
  function draw() {
    if (!run) { raf = null; return; }
    raf = requestAnimationFrame(draw);
    cx.clearRect(0,0,W,H);
    for (let i=0;i<N;i++) {
      const p=pts[i];
      cx.beginPath(); cx.arc(p.x,p.y,p.r,0,Math.PI*2);
      cx.fillStyle=p.c; cx.globalAlpha=p.a; cx.fill();
      p.x+=p.dx; p.y+=p.dy;
      if(p.x<0)p.x=W; if(p.x>W)p.x=0;
      if(p.y<0)p.y=H; if(p.y>H)p.y=0;
    }
    cx.globalAlpha=1; cx.lineWidth=.5;
    for (let i=0;i<N;i++) for (let j=i+1;j<N;j++) {
      const dx=pts[i].x-pts[j].x, dy=pts[i].y-pts[j].y, d2=dx*dx+dy*dy;
      if (d2<D*D) {
        cx.beginPath(); cx.moveTo(pts[i].x,pts[i].y); cx.lineTo(pts[j].x,pts[j].y);
        cx.strokeStyle=`rgba(0,255,255,${.06*(1-Math.sqrt(d2)/D)})`; cx.stroke();
      }
    }
  }
  document.addEventListener('visibilitychange', () => { if(document.hidden){run=false;}else{run=true;if(!raf)draw();} });
  addEventListener('resize', resize);
  resize(); pts = Array.from({length:N},rp); draw();
})();

// ─── Media ────────────────────────────────────────────
async function getLocalMedia(peerCount = 0) {
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  const isMulti = peerCount > 1;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { width:{ideal:isMulti?640:1280}, height:{ideal:isMulti?480:720},
               frameRate:{ideal:isMulti?20:30}, facingMode:'user' },
      audio: { echoCancellation:true, noiseSuppression:true, sampleRate:16000 }
    });
    localVideo.srcObject = localStream;
  } catch {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio:true });
      localVideo.srcObject = null;
      showToast('⚠ Camera unavailable — audio only');
    } catch { localStream = null; showToast('⚠ No media — text only'); }
  }
}

function stopLocalMedia() {
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  localVideo.srcObject = null;
}

// ─── WebRTC: Stranger ────────────────────────────────
function createPeerConnection() {
  if (peerConnection) { peerConnection.close(); peerConnection = null; }
  const pc = new RTCPeerConnection(ICE_CFG);
  peerConnection = pc;
  if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  pc.ontrack = e => {
    if (e.streams?.[0]) { remoteVideo.srcObject = e.streams[0]; remoteStatus.classList.add('hidden'); }
  };
  pc.onicecandidate = e => { if (e.candidate) socket.emit('webrtc_ice', { candidate: e.candidate }); };
  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    if (s === 'connected') remoteStatus.classList.add('hidden');
    else if (s === 'failed' || s === 'disconnected') {
      remoteStatus.textContent = 'Connection lost...'; remoteStatus.classList.remove('hidden');
    }
  };
  return pc;
}

async function startCall(initiator) {
  createPeerConnection();
  if (initiator) {
    const offer = await peerConnection.createOffer({ offerToReceiveAudio:true, offerToReceiveVideo:true });
    await peerConnection.setLocalDescription(offer);
    socket.emit('webrtc_offer', { offer });
  }
}

function closePeerConnection() {
  if (peerConnection) { peerConnection.close(); peerConnection = null; }
  remoteVideo.srcObject = null;
  remoteStatus.textContent = 'Connecting...'; remoteStatus.classList.remove('hidden');
}

// ─── ICE queue helpers ────────────────────────────────
function enqueueIce(peerId, candidate) {
  if (!iceQueue[peerId]) iceQueue[peerId] = [];
  iceQueue[peerId].push(candidate);
}

async function flushIceQueue(peerId) {
  const q = iceQueue[peerId] || []; delete iceQueue[peerId];
  const pc = roomPeers[peerId]; if (!pc) return;
  for (const c of q) {
    try { await pc.addIceCandidate(new RTCIceCandidate(c)); }
    catch (e) { console.warn('[ICE queue flush]', e.message); }
  }
}

// ─── WebRTC: Room ─────────────────────────────────────
async function createRoomPC(peerId) {
  // Tear down any existing connection for this peer cleanly
  if (roomPeers[peerId]) {
    roomPeers[peerId].onicecandidate = null;
    roomPeers[peerId].ontrack        = null;
    roomPeers[peerId].onconnectionstatechange = null;
    roomPeers[peerId].oniceconnectionstatechange = null;
    roomPeers[peerId].close();
    delete roomPeers[peerId];
  }
  delete iceQueue[peerId];
  delete peerLock[peerId];

  const pc = new RTCPeerConnection(ICE_CFG);
  roomPeers[peerId] = pc;

  if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

  pc.ontrack = e => {
    if (!e.streams?.[0]) return;
    roomStreams[peerId] = e.streams[0];
    const vid = $(`rv-${peerId}`);
    if (vid) vid.srcObject = e.streams[0];
    if (focusedPeerId === peerId) {
      const bv = $('room-big-video');
      if (bv) { bv.srcObject = e.streams[0]; bv.muted = false; }
    }
  };

  pc.onicecandidate = e => {
    if (e.candidate) socket.emit('room_ice', { targetId: peerId, candidate: e.candidate });
  };

  pc.oniceconnectionstatechange = () => {
    const s = pc.iceConnectionState;
    const dot = $(`ri-${peerId}`);
    if (dot) dot.style.background =
      (s === 'connected' || s === 'completed') ? '#00ff88' :
      s === 'checking' ? '#ffaa00' : '#ff2244';

    if (s === 'failed') {
      console.warn(`[Room] ICE failed → ${peerId}: restartIce`);
      try { pc.restartIce(); } catch {}
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') {
      console.warn(`[Room] Connection failed → ${peerId}: re-offer in 1.5 s`);
      setTimeout(() => { if (roomPeers[peerId] === pc) initiateOffer(peerId); }, 1500);
    }
  };

  return pc;
}

// Initiate an offer to a peer — with lock to prevent concurrent signaling
async function initiateOffer(peerId) {
  if (peerLock[peerId]) {
    console.log(`[Room] Offer to ${peerId} skipped — lock: ${peerLock[peerId]}`);
    return;
  }
  peerLock[peerId] = 'offering';

  try {
    const pc = await createRoomPC(peerId);
    const offer = await pc.createOffer({ offerToReceiveAudio:true, offerToReceiveVideo:true });
    await pc.setLocalDescription(offer);
    socket.emit('room_offer', { targetId: peerId, offer });
    console.log(`[Room] Offer sent → ${peerId}`);
  } catch (e) {
    console.error('[Room] initiateOffer error:', e);
    delete peerLock[peerId];
  }
  // Lock released in room_answer handler after answer is processed
}

function closeAllRoomPeers() {
  for (const [id, pc] of Object.entries(roomPeers)) {
    pc.onicecandidate = null; pc.ontrack = null;
    pc.onconnectionstatechange = null; pc.oniceconnectionstatechange = null;
    pc.close();
  }
  roomPeers  = {};
  roomStreams = {};
  Object.keys(iceQueue).forEach(k => delete iceQueue[k]);
  Object.keys(peerLock).forEach(k => delete peerLock[k]);
}

function reassignStreams() {
  for (const [id, stream] of Object.entries(roomStreams)) {
    const vid = $(`rv-${id}`);
    if (vid) vid.srcObject = stream;
  }
}

// ─── Layout ───────────────────────────────────────────
function buildLayout() {
  roomVideoPanel.innerHTML = '';
  roomVideoPanel.className = 'video-panel room-video-panel';
  const others = roomMembers.filter(m => m.socketId !== mySocketId);
  const total  = roomMembers.length;

  if (total <= 2) {
    roomVideoPanel.classList.add('layout-split');
    roomVideoPanel.appendChild(myVideoBox());
    others.forEach(m => roomVideoPanel.appendChild(remoteVideoBox(m)));
  } else {
    roomVideoPanel.classList.add('layout-multi');
    const big = el('div','room-big-wrap'); big.id = 'room-big-wrap';
    const bv  = el('video'); Object.assign(bv, { id:'room-big-video', autoplay:true, playsInline:true, muted:true });
    if (localStream) bv.srcObject = localStream;
    big.appendChild(bv);
    const bl = el('div','video-label local-label'); bl.id='room-big-label'; bl.textContent='YOU'; big.appendChild(bl);
    corners(big); roomVideoPanel.appendChild(big);

    const strip = el('div','room-strip'); strip.id='room-strip';
    strip.appendChild(myThumb());
    others.forEach(m => strip.appendChild(remoteThumb(m)));
    roomVideoPanel.appendChild(strip);
  }
}

function scheduleLayout() {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => { buildLayout(); reassignStreams(); }, 150);
}

// DOM helpers
function el(tag, cls) { const e = document.createElement(tag); if (cls) e.className = cls; return e; }
function corners(box) {
  ['tl','tr','bl','br'].forEach(c => { const d=el('div',`video-corner ${c}`); box.appendChild(d); });
}

function myVideoBox() {
  const box = el('div','video-box local-box');
  const vid = el('video'); Object.assign(vid, {autoplay:true, playsInline:true, muted:true});
  if (localStream) vid.srcObject = localStream;
  box.appendChild(vid);
  const lbl = el('div','video-label local-label'); lbl.textContent='YOU'; box.appendChild(lbl);
  corners(box); return box;
}

function remoteVideoBox(m) {
  const box = el('div','video-box remote-box'); box.id=`rbox-${m.socketId}`;
  const vid = el('video'); Object.assign(vid, {id:`rv-${m.socketId}`, autoplay:true, playsInline:true});
  box.appendChild(vid);
  const lbl = el('div','video-label remote-label'); lbl.textContent=m.name.toUpperCase(); box.appendChild(lbl);
  const ind = el('div','conn-indicator'); ind.id=`ri-${m.socketId}`; box.appendChild(ind);
  corners(box); return box;
}

function myThumb() {
  const t = el('div','room-thumb-item room-thumb-me'); t.title='You';
  const v = el('video'); Object.assign(v,{autoplay:true,playsInline:true,muted:true});
  if (localStream) v.srcObject = localStream;
  t.appendChild(v);
  const s = el('span'); s.textContent='YOU'; t.appendChild(s);
  t.addEventListener('click', focusBigMe); return t;
}

function remoteThumb(m) {
  const t = el('div','room-thumb-item'); t.id=`rthumb-${m.socketId}`;
  const v = el('video'); Object.assign(v,{id:`rv-${m.socketId}`,autoplay:true,playsInline:true});
  t.appendChild(v);
  const s = el('span'); s.textContent=m.name.slice(0,10).toUpperCase(); t.appendChild(s);

  const ov = el('div','thumb-overlay');

  // Audio toggle
  const ba = el('button','thumb-ctrl-btn'); ba.innerHTML='🔊'; ba.title='Mute audio locally';
  ba.onclick = e => { e.stopPropagation(); toggleRemoteAudio(m.socketId, v, ba); };
  ov.appendChild(ba);

  // Video toggle
  const bv2 = el('button','thumb-ctrl-btn'); bv2.innerHTML='📷'; bv2.title='Hide video locally';
  bv2.onclick = e => { e.stopPropagation(); toggleRemoteVideo(m.socketId, v, bv2); };
  ov.appendChild(bv2);

  // Force-mute all
  const bf = el('button','thumb-ctrl-btn thumb-ctrl-silence'); bf.innerHTML='🔕'; bf.title='Force mute for everyone';
  bf.onclick = e => {
    e.stopPropagation();
    silenceState[m.socketId] = !silenceState[m.socketId];
    const mu = silenceState[m.socketId];
    bf.innerHTML = mu ? '🔕' : '🔔'; bf.classList.toggle('ctrl-active', mu);
    socket.emit('room_force_mute', { roomId: currentRoomId, targetId: m.socketId, muted: mu });
    showToast(mu ? `🔕 ${m.name} muted for all` : `🔔 ${m.name} unmuted`);
  };
  ov.appendChild(bf); t.appendChild(ov);

  t.addEventListener('click', () => focusBigRemote(m)); return t;
}

function focusBigRemote(m) {
  const bw = $('room-big-wrap'); if (!bw) return;
  focusedPeerId = m.socketId;
  const bv = $('room-big-video'), bl = $('room-big-label');
  const v = $(`rv-${m.socketId}`);
  if (v?.srcObject) { bv.srcObject = v.srcObject; bv.muted = false; }
  if (bl) bl.textContent = m.name.toUpperCase();
  bw.classList.add('focused-remote');
  document.querySelectorAll('.room-thumb-item').forEach(t => t.classList.remove('active-thumb'));
  $(`rthumb-${m.socketId}`)?.classList.add('active-thumb');
}

function focusBigMe() {
  const bw = $('room-big-wrap'); if (!bw) return;
  focusedPeerId = null;
  const bv = $('room-big-video'), bl = $('room-big-label');
  if (bv && localStream) { bv.srcObject = localStream; bv.muted = true; }
  if (bl) bl.textContent = 'YOU';
  bw.classList.remove('focused-remote');
  document.querySelectorAll('.room-thumb-item').forEach(t => t.classList.remove('active-thumb'));
  document.querySelector('.room-thumb-me')?.classList.add('active-thumb');
}

function toggleRemoteAudio(id, v, btn) {
  remoteAudioMuted[id] = !remoteAudioMuted[id];
  v.muted = !!remoteAudioMuted[id];
  btn.innerHTML = remoteAudioMuted[id] ? '🔇' : '🔊';
  btn.classList.toggle('ctrl-active', !!remoteAudioMuted[id]);
  showToast(remoteAudioMuted[id] ? '🔇 Audio muted locally' : '🔊 Audio on');
}

function toggleRemoteVideo(id, v, btn) {
  remoteVideoOff[id] = !remoteVideoOff[id];
  v.style.opacity = remoteVideoOff[id] ? '0' : '1';
  btn.innerHTML = remoteVideoOff[id] ? '🚫' : '📷';
  btn.classList.toggle('ctrl-active', !!remoteVideoOff[id]);
  showToast(remoteVideoOff[id] ? '📷 Video hidden' : '📷 Video shown');
}

// ─── Room Chat ────────────────────────────────────────
function roomSys(text) {
  const d = el('div','sys-msg'); d.textContent = text;
  roomMsgContainer.appendChild(d);
  roomMsgContainer.scrollTop = roomMsgContainer.scrollHeight;
}

function roomMsg(text, type, from) {
  const w = el('div',`msg-bubble ${type}`);
  if (from && type === 'received') {
    const m = el('div','msg-meta'); m.textContent = from; w.appendChild(m);
  }
  const b = el('div'); b.textContent = text; w.appendChild(b);
  roomMsgContainer.appendChild(w);
  roomMsgContainer.scrollTop = roomMsgContainer.scrollHeight;
  w.style.cssText = `opacity:0;transform:translateX(${type==='sent'?'10px':'-10px'})`;
  requestAnimationFrame(() => { w.style.transition = 'opacity .15s,transform .15s'; w.style.opacity='1'; w.style.transform='none'; });
}

function sendRoomMsg() {
  const t = roomChatInput.value.trim(); if (!t || !socket) return;
  socket.emit('room_message', { roomId: currentRoomId, text: t });
  roomMsg(t, 'sent', null); roomChatInput.value = '';
}

// ─── Lobby ────────────────────────────────────────────
function updateLobby(members) {
  roomMembers = members;
  lobbyMemberCount.textContent = members.length;
  const frag = document.createDocumentFragment();
  members.forEach(m => {
    const p = el('div','member-pill');
    p.innerHTML = `<span class="pill-dot"></span>${m.name}${m.socketId===mySocketId?' (You)':''}`;
    frag.appendChild(p);
  });
  lobbyMembersList.innerHTML = ''; lobbyMembersList.appendChild(frag);
}

function updateMemberCount() {
  if (roomMemberCountEl) roomMemberCountEl.textContent = roomMembers.length;
  if (lobbyMemberCount)  lobbyMemberCount.textContent  = roomMembers.length;
}

// ─── Socket — single instance, full cleanup ────────────
// FIX: Always destroy old socket completely before creating a new one.
// Without this, the old socket auto-reconnects in the background, its
// handlers share the same roomPeers map, and stale answers arrive on
// new PeerConnections that are already in "stable" state → the crash.
function initSocket() {
  if (socket) {
    console.log('[SOCKET] Destroying old socket before reinit');
    socket.removeAllListeners();
    try { socket.io.removeAllListeners(); } catch {}
    socket.disconnect();
    socket = null;
  }

  socket = io({
    transports: ['websocket'],
    upgrade: false,              // never upgrade — keeps single transport
    reconnection: true,
    reconnectionAttempts: 4,
    reconnectionDelay: 1500,
    reconnectionDelayMax: 5000,
    timeout: 10000,
  });

  socket.on('connect', () => {
    mySocketId = socket.id;
    console.log('[SOCKET] Connected:', socket.id);
  });

  socket.on('disconnect', reason => {
    console.log('[SOCKET] Disconnected:', reason);
    showToast('⚠ Connection lost — reconnecting…');
  });

  // Auto-rejoin room after Socket.IO reconnects (same socket obj, new id)
  socket.io.on('reconnect', () => {
    mySocketId = socket.id;
    console.log('[SOCKET] Reconnected:', socket.id);
    if (currentRoomId && screens.roomChat.classList.contains('active')) {
      showToast('🔄 Reconnected — rejoining room…');
      socket.emit('join_room', { roomId: currentRoomId, password: lastRoomPassword, name: myName });
    }
  });

  socket.on('online_count', count => {
    Object.values(onlineCountEls).forEach(e => { if (e) e.textContent = count; });
  });

  // ══ Stranger events ══════════════════════════════════
  socket.on('waiting', () => console.log('[Queue] Waiting'));

  socket.on('matched', async ({ partnerName, initiator }) => {
    partnerNameDisplay.textContent = partnerName.toUpperCase();
    clearMsgs(); addSys(`Connected to ${partnerName}. Say hello!`);
    showScreen('chat');
    await startCall(initiator);
  });

  socket.on('webrtc_offer', async ({ offer }) => {
    if (!peerConnection) createPeerConnection();
    try {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
      const ans = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(ans);
      socket.emit('webrtc_answer', { answer: ans });
    } catch (e) { console.error('[Stranger] Answer error:', e); }
  });

  socket.on('webrtc_answer', async ({ answer }) => {
    if (!peerConnection) return;
    // Guard: only in have-local-offer state
    if (peerConnection.signalingState !== 'have-local-offer') return;
    try { await peerConnection.setRemoteDescription(new RTCSessionDescription(answer)); }
    catch (e) { console.error('[Stranger] Set answer error:', e); }
  });

  socket.on('webrtc_ice', async ({ candidate }) => {
    if (!peerConnection) return;
    try { await peerConnection.addIceCandidate(new RTCIceCandidate(candidate)); }
    catch (e) { console.warn('[Stranger] ICE error:', e); }
  });

  socket.on('chat_message', ({ from, text }) => addMsg(text, 'received', from));
  socket.on('partner_left', () => { closePeerConnection(); addSys('Stranger disconnected.'); showModal(); });

  // ══ Room events ══════════════════════════════════════
  socket.on('room_created', ({ roomId, name, members }) => {
    currentRoomId = roomId; myName = name; roomMembers = members;
    lobbyRoomId.textContent = roomId; updateLobby(members);
    showScreen('roomLobby'); showToast(`✓ Room ${roomId} created!`);
  });

  socket.on('room_joined', ({ roomId, name, members, started }) => {
    currentRoomId = roomId; myName = name; roomMembers = members;
    mySocketId = socket.id;
    lobbyRoomId.textContent = roomId;
    if (started) {
      showToast('✓ Rejoined session — reconnecting…');
      startRoomSession(true);        // isRejoin = true
    } else {
      updateLobby(members); showScreen('roomLobby'); showToast(`✓ Joined room ${roomId}`);
    }
  });

  socket.on('room_error', ({ msg }) => showToast('⚠ ' + msg, 3500));

  socket.on('room_member_joined', ({ socketId, name, members, sessionActive }) => {
    roomMembers = members; updateLobby(members); updateMemberCount();
    roomSys(`${name} joined`); showToast(`🟢 ${name} joined`);

    if (sessionActive && screens.roomChat.classList.contains('active')) {
      scheduleLayout();
      // ── KEY FIX ──────────────────────────────────────
      // Do NOT call initiateOffer here.
      // The newly joined member sends offers to us (in startRoomSession).
      // If we also offer simultaneously → ICE glare → "wrong state: stable"
      // ─────────────────────────────────────────────────
    }
  });

  socket.on('room_member_left', ({ socketId, name, members }) => {
    roomMembers = members; updateMemberCount();
    roomSys(`${name} left`); showToast(`🔴 ${name} left`);
    if (roomPeers[socketId]) { roomPeers[socketId].close(); delete roomPeers[socketId]; }
    delete roomStreams[socketId]; delete silenceState[socketId];
    delete iceQueue[socketId]; delete peerLock[socketId];
    ($(`rbox-${socketId}`) || $(`rthumb-${socketId}`))?.remove();
    scheduleLayout();
  });

  // ── room_offer: someone sent us an offer ──────────────
  socket.on('room_offer', async ({ fromId, offer }) => {
    if (peerLock[fromId] === 'answering') {
      console.warn(`[Room] Dropping duplicate offer from ${fromId}`);
      return;
    }
    peerLock[fromId] = 'answering';

    try {
      // Always create a fresh PC for the offerer
      const pc = await createRoomPC(fromId);

      // Guard: new PC must be in 'stable' to accept offer (it always is,
      // but this makes the intent explicit and catches edge cases)
      if (pc.signalingState !== 'stable') {
        console.warn(`[Room] Offer from ${fromId} ignored: signalingState=${pc.signalingState}`);
        delete peerLock[fromId]; return;
      }

      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      await flushIceQueue(fromId);   // drain any early candidates
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('room_answer', { targetId: fromId, answer });
      console.log(`[Room] Answer sent → ${fromId}`);
    } catch (e) {
      console.error('[Room] room_offer handler error:', e);
    } finally {
      delete peerLock[fromId];
    }
  });

  // ── room_answer: our offer was accepted ───────────────
  // FIX: signalingState MUST be 'have-local-offer' — if it's 'stable',
  // this is a stale/duplicate answer from a ghost socket → discard it.
  socket.on('room_answer', async ({ fromId, answer }) => {
    const pc = roomPeers[fromId];
    if (!pc) {
      console.warn(`[Room] Answer from ${fromId}: no PC found — discarding`);
      return;
    }

    const state = pc.signalingState;
    if (state !== 'have-local-offer') {
      // This is the crash we're fixing: "Called in wrong state: stable"
      console.warn(`[Room] Answer from ${fromId} discarded — signalingState: ${state}`);
      delete peerLock[fromId];
      return;
    }

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
      await flushIceQueue(fromId);   // drain any early candidates
      console.log(`[Room] Answer applied from ${fromId} ✓`);
    } catch (e) {
      console.error('[Room] room_answer handler error:', e);
    } finally {
      delete peerLock[fromId];   // release lock after answer is processed
    }
  });

  // ── room_ice: trickle ICE candidates ─────────────────
  // FIX: If remote desc not yet set, queue the candidate instead of dropping.
  socket.on('room_ice', async ({ fromId, candidate }) => {
    const pc = roomPeers[fromId];
    if (!pc) return;

    if (!pc.remoteDescription?.type) {
      enqueueIce(fromId, candidate);   // buffer until after setRemoteDescription
      return;
    }
    try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); }
    catch (e) { console.warn('[Room] ICE add:', e.message); }
  });

  socket.on('room_message', ({ from, text }) => roomMsg(text, 'received', from));

  socket.on('room_member_media', ({ socketId, audioMuted, videoOff }) => {
    const b = $(`rbox-${socketId}`) || $(`rthumb-${socketId}`);
    if (b) { b.classList.toggle('remote-audio-muted', !!audioMuted); b.classList.toggle('remote-video-off', !!videoOff); }
  });

  socket.on('room_force_muted', ({ byName, muted }) => {
    if (muted && !roomMuted) toggleRoomMute();
    else if (!muted && roomMuted) toggleRoomMute();
    showToast(`🔕 ${byName} ${muted ? 'muted' : 'unmuted'} you for everyone`);
  });

  socket.on('room_closed', ({ msg }) => {
    showToast(`⚠ ${msg}`, 5000); cleanupRoom(); showScreen('landing');
  });
}

// ─── Start Room Session ───────────────────────────────
// isRejoin=true  → joining an already-live session (send offers to ALL)
// isRejoin=false → fresh lobby start (index-based, no glare)
async function startRoomSession(isRejoin = false) {
  if (roomIdDisplay) roomIdDisplay.textContent = currentRoomId;

  if (isRejoin) {
    closeAllRoomPeers();   // clean slate — no stale connections
  }

  showScreen('roomChat');
  buildLayout(); reassignStreams();
  roomSys(isRejoin ? 'Reconnecting video…' : 'Session started! Video connecting…');
  socket.emit('room_start', { roomId: currentRoomId });

  let targets;
  if (isRejoin) {
    // Rejoin: WE are the new entrant → offer to everyone currently in room
    targets = roomMembers.filter(m => m.socketId !== mySocketId);
  } else {
    // Fresh start: index-based → each member offers only to earlier members
    // [A,B,C]: B→A, C→{A,B}. No pair sends two offers → no glare.
    const idx = roomMembers.findIndex(m => m.socketId === mySocketId);
    targets = roomMembers.slice(0, idx);
  }

  if (targets.length > 0) {
    // All offers fired in parallel — fastest possible connection
    await Promise.all(targets.map(p => initiateOffer(p.socketId)));
  }
}

// ─── Room cleanup ─────────────────────────────────────
function cleanupRoom() {
  closeAllRoomPeers(); stopLocalMedia();
  currentRoomId = null; lastRoomPassword = '';
  roomMembers = []; silenceState = {};
  remoteAudioMuted = {}; remoteVideoOff = {};
  roomMuted = false; roomCamOff = false;
}

// ─── Stranger chat ────────────────────────────────────
function clearMsgs() { messagesContainer.innerHTML = ''; }
function addSys(t) {
  const d = el('div','sys-msg'); d.textContent = t;
  messagesContainer.appendChild(d); messagesContainer.scrollTop = messagesContainer.scrollHeight;
}
function addMsg(text, type, from) {
  const w = el('div',`msg-bubble ${type}`);
  if (from && type === 'received') { const m = el('div','msg-meta'); m.textContent=from; w.appendChild(m); }
  const b = el('div'); b.textContent = text; w.appendChild(b);
  messagesContainer.appendChild(w); messagesContainer.scrollTop = messagesContainer.scrollHeight;
  w.style.cssText = `opacity:0;transform:translateX(${type==='sent'?'10px':'-10px'})`;
  requestAnimationFrame(() => { w.style.transition='opacity .15s,transform .15s'; w.style.opacity='1'; w.style.transform='none'; });
}
function sendMsg() {
  const t = chatInput.value.trim(); if (!t || !socket?.connected) return;
  socket.emit('chat_message', { text: t }); addMsg(t, 'sent', null); chatInput.value = '';
}

// ─── Modal ────────────────────────────────────────────
function showModal() { modalLeft.style.display = 'flex'; }
function hideModal() { modalLeft.style.display = 'none'; }

// ─── Stranger controls ────────────────────────────────
function toggleMute() {
  isMuted = !isMuted;
  localStream?.getAudioTracks().forEach(t => { t.enabled = !isMuted; });
  btnMute.classList.toggle('active', isMuted);
  btnMute.querySelector('.icon-unmuted').style.display = isMuted ? 'none' : 'block';
  btnMute.querySelector('.icon-muted').style.display   = isMuted ? 'block' : 'none';
  showToast(isMuted ? '🎤 Muted' : '🎤 Mic on');
}
function toggleCamera() {
  isCamOff = !isCamOff;
  localStream?.getVideoTracks().forEach(t => { t.enabled = !isCamOff; });
  btnVideoToggle.classList.toggle('active', isCamOff);
  btnVideoToggle.querySelector('.icon-cam-on').style.display  = isCamOff ? 'none' : 'block';
  btnVideoToggle.querySelector('.icon-cam-off').style.display = isCamOff ? 'block' : 'none';
  showToast(isCamOff ? '📷 Camera off' : '📷 Camera on');
}
function skipStranger() {
  closePeerConnection(); addSys('Searching for next stranger…');
  socket.emit('skip'); showScreen('waiting');
}
function endSession() {
  closePeerConnection(); stopLocalMedia();
  if (socket) { socket.removeAllListeners(); socket.disconnect(); socket = null; }
  isMuted = false; isCamOff = false;
  btnMute.classList.remove('active');
  btnMute.querySelector('.icon-unmuted').style.display = 'block';
  btnMute.querySelector('.icon-muted').style.display   = 'none';
  btnVideoToggle.classList.remove('active');
  btnVideoToggle.querySelector('.icon-cam-on').style.display  = 'block';
  btnVideoToggle.querySelector('.icon-cam-off').style.display = 'none';
  showScreen('landing');
}

// ─── Room controls ────────────────────────────────────
function toggleRoomMute() {
  roomMuted = !roomMuted;
  localStream?.getAudioTracks().forEach(t => { t.enabled = !roomMuted; });
  btnRoomMute.classList.toggle('active', roomMuted);
  btnRoomMute.querySelector('.icon-unmuted').style.display = roomMuted ? 'none' : 'block';
  btnRoomMute.querySelector('.icon-muted').style.display   = roomMuted ? 'block' : 'none';
  socket.emit('room_media_state', { roomId: currentRoomId, audioMuted: roomMuted, videoOff: roomCamOff });
  showToast(roomMuted ? '🎤 Muted' : '🎤 Mic on');
}
function toggleRoomCam() {
  roomCamOff = !roomCamOff;
  localStream?.getVideoTracks().forEach(t => { t.enabled = !roomCamOff; });
  btnRoomCam.classList.toggle('active', roomCamOff);
  btnRoomCam.querySelector('.icon-cam-on').style.display  = roomCamOff ? 'none' : 'block';
  btnRoomCam.querySelector('.icon-cam-off').style.display = roomCamOff ? 'block' : 'none';
  socket.emit('room_media_state', { roomId: currentRoomId, audioMuted: roomMuted, videoOff: roomCamOff });
  showToast(roomCamOff ? '📷 Camera off' : '📷 Camera on');
}
function leaveRoom() {
  if (socket) { socket.removeAllListeners(); socket.disconnect(); socket = null; }
  cleanupRoom(); showScreen('landing');
}

// ─── Entry flows ──────────────────────────────────────
async function startStrangerFlow() {
  myName = (strangerNameInput.value.trim().slice(0,24)) || 'Stranger';
  showScreen('waiting');
  await getLocalMedia();
  initSocket();
  socket.on('connect', () => { mySocketId = socket.id; socket.emit('join_queue', { name: myName }); });
  if (socket.connected) { mySocketId = socket.id; socket.emit('join_queue', { name: myName }); }
}

async function startCreateRoomFlow() {
  const name = createNameInput.value.trim() || 'Host';
  const pass = createPassInput.value.trim();
  if (!pass) { showToast('⚠ Set a room password'); return; }
  lastRoomPassword = pass;
  await getLocalMedia();
  initSocket();
  const go = () => { mySocketId = socket.id; socket.emit('create_room', { name, password: pass }); };
  socket.on('connect', go);
  if (socket.connected) go();
}

async function startJoinRoomFlow() {
  const name   = joinNameInput.value.trim() || 'User';
  const roomId = joinRoomIdInput.value.trim();
  const pass   = joinPassInput.value.trim();
  if (roomId.length !== 6) { showToast('⚠ Enter a valid 6-digit room ID'); return; }
  if (!pass) { showToast('⚠ Enter the room password'); return; }
  lastRoomPassword = pass;
  await getLocalMedia();
  initSocket();
  const go = () => { mySocketId = socket.id; socket.emit('join_room', { roomId, password: pass, name }); };
  socket.on('connect', go);
  if (socket.connected) go();
}

// ─── Event listeners ──────────────────────────────────
$('btn-mode-stranger').addEventListener('click', () => showScreen('nameStranger'));
$('btn-mode-create').addEventListener('click',   () => showScreen('createRoom'));
$('btn-mode-join').addEventListener('click',     () => showScreen('joinRoom'));
$('btn-back-stranger').addEventListener('click', () => showScreen('landing'));
$('btn-back-create').addEventListener('click',   () => showScreen('landing'));
$('btn-back-join').addEventListener('click',     () => showScreen('landing'));

btnStartStranger.addEventListener('click', startStrangerFlow);
strangerNameInput.addEventListener('keydown', e => { if (e.key === 'Enter') startStrangerFlow(); });

$('btn-do-create-room').addEventListener('click', startCreateRoomFlow);
$('btn-do-join-room').addEventListener('click',   startJoinRoomFlow);
joinRoomIdInput.addEventListener('input', e => {
  e.target.value = e.target.value.replace(/\D/g,'').slice(0,6);
});

btnStartRoom.addEventListener('click',   () => startRoomSession(false));
$('btn-cancel-room').addEventListener('click', leaveRoom);
$('btn-copy-room-id').addEventListener('click', () => {
  navigator.clipboard.writeText(lobbyRoomId.textContent)
    .then(() => showToast('✓ Room ID copied!'))
    .catch(() => showToast('Room ID: ' + lobbyRoomId.textContent));
});

btnCancelWait.addEventListener('click', () => { endSession(); showScreen('landing'); });
btnMute.addEventListener('click',        toggleMute);
btnVideoToggle.addEventListener('click', toggleCamera);
btnSkip.addEventListener('click',        skipStranger);
btnEnd.addEventListener('click',         endSession);
btnSend.addEventListener('click',        sendMsg);
chatInput.addEventListener('keydown',    e => { if (e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMsg();} });

btnRoomMute.addEventListener('click', toggleRoomMute);
btnRoomCam.addEventListener('click',  toggleRoomCam);
btnRoomLeave.addEventListener('click', leaveRoom);
btnRoomSend.addEventListener('click',  sendRoomMsg);
roomChatInput.addEventListener('keydown', e => { if (e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendRoomMsg();} });

$('modal-next').addEventListener('click', () => {
  hideModal(); closePeerConnection(); showScreen('waiting');
  if (socket?.connected) socket.emit('join_queue', { name: myName });
  else {
    initSocket();
    socket.on('connect', () => { mySocketId = socket.id; socket.emit('join_queue', { name: myName }); });
  }
});
$('modal-home').addEventListener('click', () => { hideModal(); endSession(); });

window.addEventListener('popstate', e => e.preventDefault());
showScreen('landing');
