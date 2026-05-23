/* ═══════════════════════════════════════════════════════════════════════════
   CHAT-RIX  —  app.js  (SUPER FAST + ALL BUGS FIXED)
   ═══════════════════════════════════════════════════════════════════════════ */
'use strict';

// ─── ICE / TURN config ───────────────────────────────────────────────────────
const ICE_CFG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    {
      urls:       'turn:openrelay.metered.ca:80',
      username:   'openrelayproject',
      credential: 'openrelayproject',
    },
    {
      urls:       'turn:openrelay.metered.ca:443',
      username:   'openrelayproject',
      credential: 'openrelayproject',
    },
    {
      urls:       'turn:openrelay.metered.ca:443?transport=tcp',
      username:   'openrelayproject',
      credential: 'openrelayproject',
    },
  ],
  iceCandidatePoolSize: 4,       // PERF: reduced from 8
  bundlePolicy:  'max-bundle',
  rtcpMuxPolicy: 'require',
};

// ─── Global state ────────────────────────────────────────────────────────────
let socket         = null;
let localStream    = null;
let peerConnection = null;   // stranger-mode only
let myName         = '';
let isMuted        = false;
let isCamOff       = false;

// Room state
let currentRoomId    = null;
let lastRoomPassword = '';
let roomMembers      = [];
let currentMaxMembers = 2;
let mySocketId       = null;
let focusedPeerId    = null;
let roomMuted        = false;
let roomCamOff       = false;

// roomPeers[peerId]  → RTCPeerConnection
// roomStreams[peerId] → MediaStream
// iceQueue[peerId]   → RTCIceCandidateInit[]
// peerState[peerId]  → 'idle'|'offering'|'answering'
// offerRetries[peerId] → number
const roomPeers    = {};
const roomStreams   = {};
const iceQueue     = {};
const peerState    = {};
const offerRetries = {};
const silenceState     = {};
const remoteAudioMuted = {};
const remoteVideoOff   = {};

// FIX: Prevent multiple simultaneous offer initiations to same peer
const pendingOffers = {};

let rebuildTimer = null;

// ─── DOM shortcuts ───────────────────────────────────────────────────────────
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
const lobbyMaxCount      = $('lobby-max-count');
const lobbyStatusText    = $('lobby-status-text');
const lobbyAutostartFill = $('lobby-autostart-fill');
const lobbyAutostartHint = $('lobby-autostart-hint');
const roomVideoPanel     = $('room-video-panel');
const roomMsgContainer   = $('room-messages-container');
const roomChatInput      = $('room-chat-input');
const btnRoomSend        = $('btn-room-send');
const roomIdDisplay      = $('room-id-display');
const roomMemberCountEl  = $('room-member-count-display');
const btnRoomMute        = $('btn-room-mute');
const btnRoomCam         = $('btn-room-cam');
const btnRoomLeave       = $('btn-room-leave');

let selectedMaxMembers = 2;

// ─── Screen ──────────────────────────────────────────────────────────────────
function showScreen(name) {
  Object.values(screens).forEach(el => {
    el.classList.remove('active', 'fade-in');
    el.style.display = 'none';
  });
  const t = screens[name];
  t.style.display = 'flex';
  requestAnimationFrame(() => t.classList.add('active', 'fade-in'));
}

// ─── Toast ───────────────────────────────────────────────────────────────────
let toastTmr = null;
function showToast(msg, ms = 2800) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTmr);
  toastTmr = setTimeout(() => toastEl.classList.remove('show'), ms);
}

// ─── Particles (PERF: fewer particles, skip on mobile) ────────────────────────
(function () {
  const cv = $('particleCanvas'); if (!cv) return;
  // PERF: Skip heavy particle animation on low-end/mobile devices
  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  if (isMobile) { cv.style.display = 'none'; return; }

  const cx = cv.getContext('2d');
  const N = 25; // PERF: reduced from 40
  const D = 70;
  const CLR = ['#00ffff','#ff00aa','#00ff88','#fff'];
  let W, H, pts = [], run = true, raf = null;
  const resize = () => { W = cv.width = innerWidth; H = cv.height = innerHeight; };
  const rp = () => ({
    x:Math.random()*W, y:Math.random()*H,
    r:Math.random()*1.2+.3,
    dx:(Math.random()-.5)*.3, dy:(Math.random()-.5)*.3,
    c:CLR[0|Math.random()*4], a:Math.random()*.35+.1,
  });
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
    cx.globalAlpha=1; cx.lineWidth=.4;
    for (let i=0;i<N;i++) for (let j=i+1;j<N;j++) {
      const dx=pts[i].x-pts[j].x, dy=pts[i].y-pts[j].y, d2=dx*dx+dy*dy;
      if (d2<D*D) {
        cx.beginPath(); cx.moveTo(pts[i].x,pts[i].y); cx.lineTo(pts[j].x,pts[j].y);
        cx.strokeStyle=`rgba(0,255,255,${.05*(1-Math.sqrt(d2)/D)})`; cx.stroke();
      }
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { run=false; } else { run=true; if(!raf) draw(); }
  });
  addEventListener('resize', resize);
  resize(); pts = Array.from({length:N},rp); draw();
})();

// ─── Media ───────────────────────────────────────────────────────────────────
async function getLocalMedia(peerCount = 0) {
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  const isMulti = peerCount > 1;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: {
        width:     { ideal: isMulti ? 480  : 1280 },  // PERF: smaller in multi
        height:    { ideal: isMulti ? 360  : 720  },
        frameRate: { ideal: isMulti ? 15   : 30   },  // PERF: 15fps in multi
        facingMode: 'user',
      },
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        sampleRate: 16000,
        channelCount: 1,                               // PERF: mono saves bandwidth
      },
    });
    localVideo.srcObject = localStream;
  } catch {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localVideo.srcObject = null;
      showToast('⚠ Camera unavailable — audio only');
    } catch {
      localStream = null;
      showToast('⚠ No media — text only');
    }
  }
}

function stopLocalMedia() {
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  localVideo.srcObject = null;
}

// ─── WebRTC: Stranger ────────────────────────────────────────────────────────
function createPeerConnection() {
  if (peerConnection) { peerConnection.close(); peerConnection = null; }
  const pc = new RTCPeerConnection(ICE_CFG);
  peerConnection = pc;
  if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  pc.ontrack = e => {
    if (e.streams?.[0]) {
      remoteVideo.srcObject = e.streams[0];
      remoteStatus.classList.add('hidden');
    }
  };
  pc.onicecandidate = e => { if (e.candidate) socket.emit('webrtc_ice', { candidate: e.candidate }); };
  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    if (s === 'connected') remoteStatus.classList.add('hidden');
    else if (s === 'failed' || s === 'disconnected') {
      remoteStatus.textContent = 'Connection lost…';
      remoteStatus.classList.remove('hidden');
    }
  };
  return pc;
}

async function startCall(initiator) {
  createPeerConnection();
  if (initiator) {
    const offer = await peerConnection.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
    await peerConnection.setLocalDescription(offer);
    socket.emit('webrtc_offer', { offer });
  }
}

function closePeerConnection() {
  if (peerConnection) { peerConnection.close(); peerConnection = null; }
  remoteVideo.srcObject = null;
  remoteStatus.textContent = 'Connecting…';
  remoteStatus.classList.remove('hidden');
}

// ─── ICE queue helpers ───────────────────────────────────────────────────────
function enqueueIce(peerId, candidate) {
  if (!iceQueue[peerId]) iceQueue[peerId] = [];
  iceQueue[peerId].push(candidate);
}

async function flushIceQueue(peerId) {
  const q = iceQueue[peerId] || [];
  delete iceQueue[peerId];
  if (!q.length) return;
  const pc = roomPeers[peerId];
  if (!pc || !pc.remoteDescription?.type) return;
  for (const c of q) {
    try { await pc.addIceCandidate(new RTCIceCandidate(c)); }
    catch (e) { console.warn('[ICE] flush error:', e.message); }
  }
}

// ─── Peer connection lifecycle ───────────────────────────────────────────────
async function createRoomPC(peerId) {
  if (roomPeers[peerId]) {
    const old = roomPeers[peerId];
    old.onicecandidate           = null;
    old.ontrack                  = null;
    old.onconnectionstatechange  = null;
    old.oniceconnectionstatechange = null;
    old.onnegotiationneeded      = null;
    try { old.close(); } catch {}
    delete roomPeers[peerId];
  }
  delete iceQueue[peerId];

  const pc = new RTCPeerConnection(ICE_CFG);
  roomPeers[peerId] = pc;

  if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

  pc.ontrack = e => {
    if (!e.streams?.[0]) return;
    const stream = e.streams[0];
    roomStreams[peerId] = stream;
    attachStream(peerId, stream);
  };

  pc.onicecandidate = e => {
    if (e.candidate) {
      socket.emit('room_ice', { targetId: peerId, candidate: e.candidate });
    }
  };

  pc.oniceconnectionstatechange = () => {
    const s = pc.iceConnectionState;
    setIndicator(peerId, s);

    if (s === 'failed') {
      console.warn(`[Room] ICE failed for ${peerId} — restartIce`);
      try { pc.restartIce(); } catch {}
    }
  };

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    console.log(`[Room] connectionState ${peerId}: ${s}`);

    if (s === 'connected') {
      offerRetries[peerId] = 0;
      delete pendingOffers[peerId];
      if (roomStreams[peerId]) attachStream(peerId, roomStreams[peerId]);
    }

    if (s === 'failed') {
      const retries = (offerRetries[peerId] || 0);
      if (retries < 3) {
        offerRetries[peerId] = retries + 1;
        const delay = 1500 + retries * 1000;
        console.warn(`[Room] Conn failed for ${peerId} — retry ${offerRetries[peerId]} in ${delay}ms`);
        setTimeout(() => {
          if (roomPeers[peerId] === pc) {
            peerState[peerId] = 'idle';
            delete pendingOffers[peerId];
            initiateOffer(peerId);
          }
        }, delay);
      } else {
        console.error(`[Room] Conn permanently failed for ${peerId}`);
        showToast('⚠ Peer connection failed — try re-joining');
      }
    }
  };

  return pc;
}

function attachStream(peerId, stream) {
  const vid = $(`rv-${peerId}`);
  if (vid) {
    vid.srcObject = stream;
    vid.play().catch(() => {});
  }
  if (focusedPeerId === peerId) {
    const bv = $('room-big-video');
    if (bv) { bv.srcObject = stream; bv.muted = false; bv.play().catch(() => {}); }
  }
}

function setIndicator(peerId, iceState) {
  const dot = $(`ri-${peerId}`);
  if (!dot) return;
  dot.style.background =
    (iceState === 'connected' || iceState === 'completed') ? '#00ff88' :
    iceState === 'checking'                                ? '#ffaa00' : '#ff2244';
}

// FIX: Proper guard with pendingOffers to prevent duplicate simultaneous offers
async function initiateOffer(peerId) {
  if (peerState[peerId] === 'offering' || peerState[peerId] === 'answering') {
    console.log(`[Room] initiateOffer(${peerId}) skipped — state=${peerState[peerId]}`);
    return;
  }
  if (pendingOffers[peerId]) {
    console.log(`[Room] initiateOffer(${peerId}) skipped — already pending`);
    return;
  }

  peerState[peerId] = 'offering';
  pendingOffers[peerId] = true;
  console.log(`[Room] initiateOffer → ${peerId}`);

  try {
    const pc    = await createRoomPC(peerId);
    const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
    await pc.setLocalDescription(offer);
    socket.emit('room_offer', { targetId: peerId, offer });
  } catch (e) {
    console.error('[Room] initiateOffer error:', e);
    peerState[peerId] = 'idle';
    delete pendingOffers[peerId];
  }
}

function closeAllRoomPeers() {
  for (const [id, pc] of Object.entries(roomPeers)) {
    pc.onicecandidate          = null;
    pc.ontrack                 = null;
    pc.onconnectionstatechange = null;
    pc.oniceconnectionstatechange = null;
    pc.onnegotiationneeded     = null;
    try { pc.close(); } catch {}
  }
  for (const k of Object.keys(roomPeers))    delete roomPeers[k];
  for (const k of Object.keys(roomStreams))   delete roomStreams[k];
  for (const k of Object.keys(iceQueue))      delete iceQueue[k];
  for (const k of Object.keys(peerState))     delete peerState[k];
  for (const k of Object.keys(offerRetries))  delete offerRetries[k];
  for (const k of Object.keys(pendingOffers)) delete pendingOffers[k];
}

function reassignStreams() {
  for (const [id, stream] of Object.entries(roomStreams)) attachStream(id, stream);
}

// ─── Layout ──────────────────────────────────────────────────────────────────
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
    const bv  = el('video');
    Object.assign(bv, { id:'room-big-video', autoplay:true, playsInline:true, muted:true });
    if (localStream) bv.srcObject = localStream;
    big.appendChild(bv);
    const bl = el('div','video-label local-label'); bl.id='room-big-label'; bl.textContent='YOU';
    big.appendChild(bl);
    corners(big); roomVideoPanel.appendChild(big);

    const strip = el('div','room-strip'); strip.id='room-strip';
    strip.appendChild(myThumb());
    others.forEach(m => strip.appendChild(remoteThumb(m)));
    roomVideoPanel.appendChild(strip);
  }
}

function scheduleLayout() {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => { buildLayout(); reassignStreams(); }, 100); // PERF: 100ms
}

// ─── DOM helpers ─────────────────────────────────────────────────────────────
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
  const vid = el('video');
  Object.assign(vid, {id:`rv-${m.socketId}`, autoplay:true, playsInline:true});
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

  const ba = el('button','thumb-ctrl-btn'); ba.innerHTML='🔊'; ba.title='Mute audio locally';
  ba.onclick = e => { e.stopPropagation(); toggleRemoteAudio(m.socketId, v, ba); };
  ov.appendChild(ba);

  const bv2 = el('button','thumb-ctrl-btn'); bv2.innerHTML='📷'; bv2.title='Hide video locally';
  bv2.onclick = e => { e.stopPropagation(); toggleRemoteVideo(m.socketId, v, bv2); };
  ov.appendChild(bv2);

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
  const v  = $(`rv-${m.socketId}`);
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

// ─── Room Chat ───────────────────────────────────────────────────────────────
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
  requestAnimationFrame(() => { w.style.transition='opacity .15s,transform .15s'; w.style.opacity='1'; w.style.transform='none'; });
}

function sendRoomMsg() {
  const t = roomChatInput.value.trim(); if (!t || !socket) return;
  socket.emit('room_message', { roomId: currentRoomId, text: t });
  roomMsg(t, 'sent', null); roomChatInput.value = '';
}

// ─── Lobby ───────────────────────────────────────────────────────────────────
function updateLobby(members, maxMembers) {
  roomMembers = members;
  if (maxMembers !== undefined) currentMaxMembers = maxMembers;
  const max = currentMaxMembers || 2;

  lobbyMemberCount.textContent = members.length;
  if (lobbyMaxCount) lobbyMaxCount.textContent = max;

  const pct = Math.min(100, Math.round((members.length / max) * 100));
  if (lobbyAutostartFill) lobbyAutostartFill.style.width = pct + '%';

  const remaining = max - members.length;
  if (lobbyStatusText) {
    lobbyStatusText.textContent = remaining > 0
      ? `WAITING FOR ${remaining} MORE MEMBER${remaining !== 1 ? 'S' : ''}`
      : 'ALL MEMBERS PRESENT — STARTING…';
  }

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
  if (lobbyMaxCount)     lobbyMaxCount.textContent     = currentMaxMembers || 2;
}

// ─── Socket initialisation ───────────────────────────────────────────────────
function initSocket() {
  if (socket) {
    socket.removeAllListeners();
    try { socket.io.removeAllListeners(); } catch {}
    socket.disconnect();
    socket = null;
  }

  socket = io({
    // PERF: websocket first for speed
    transports:             ['websocket', 'polling'],
    upgrade:                false,   // already starting with WS, no upgrade needed
    reconnection:           true,
    reconnectionAttempts:   Infinity,
    reconnectionDelay:      800,     // FIX: faster reconnect (was 1500)
    reconnectionDelayMax:   5000,    // FIX: shorter max (was 8000)
    randomizationFactor:    0.3,
    timeout:                15000,   // FIX: shorter timeout (was 20000)
  });

  socket.on('connect', () => {
    mySocketId = socket.id;
    console.log('[SOCKET] connected id=', socket.id);
  });

  socket.on('disconnect', reason => {
    console.log('[SOCKET] disconnected reason=', reason);
    if (reason !== 'io client disconnect') showToast('⚠ Connection lost — reconnecting…');
  });

  socket.on('connect_error', err => {
    console.warn('[SOCKET] connect_error:', err.message);
  });

  socket.io.on('reconnect', attempt => {
    mySocketId = socket.id;
    console.log('[SOCKET] reconnected attempt=', attempt);
    if (currentRoomId && (screens.roomChat.classList.contains('active') || screens.roomLobby.classList.contains('active'))) {
      showToast('🔄 Reconnected — rejoining room…');
      socket.emit('join_room', { roomId: currentRoomId, password: lastRoomPassword, name: myName });
    }
  });

  socket.on('online_count', count => {
    Object.values(onlineCountEls).forEach(e => { if (e) e.textContent = count; });
  });

  // ══ Stranger events ════════════════════════════════════════════════════════
  socket.on('waiting', () => console.log('[Queue] waiting'));

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
    } catch (e) { console.error('[Stranger] answer error:', e); }
  });

  socket.on('webrtc_answer', async ({ answer }) => {
    if (!peerConnection) return;
    if (peerConnection.signalingState !== 'have-local-offer') return;
    try { await peerConnection.setRemoteDescription(new RTCSessionDescription(answer)); }
    catch (e) { console.error('[Stranger] set-answer error:', e); }
  });

  socket.on('webrtc_ice', async ({ candidate }) => {
    if (!peerConnection) return;
    try { await peerConnection.addIceCandidate(new RTCIceCandidate(candidate)); }
    catch (e) { console.warn('[Stranger] ICE error:', e); }
  });

  socket.on('chat_message', ({ from, text }) => addMsg(text, 'received', from));
  socket.on('partner_left', () => { closePeerConnection(); addSys('Stranger disconnected.'); showModal(); });

  // ══ Room events ════════════════════════════════════════════════════════════
  socket.on('room_created', ({ roomId, name, members, maxMembers }) => {
    currentRoomId = roomId; myName = name; roomMembers = members;
    currentMaxMembers = maxMembers || 2;
    lobbyRoomId.textContent = roomId; updateLobby(members, maxMembers);
    showScreen('roomLobby'); showToast(`✓ Room ${roomId} created!`);
  });

  socket.on('room_joined', ({ roomId, name, members, maxMembers, started }) => {
    currentRoomId = roomId; myName = name; roomMembers = members;
    currentMaxMembers = maxMembers || currentMaxMembers;
    mySocketId = socket.id;
    lobbyRoomId.textContent = roomId;
    if (started) {
      showToast('✓ Rejoined — reconnecting video…');
      startRoomSession(true);
    } else {
      updateLobby(members, maxMembers); showScreen('roomLobby'); showToast(`✓ Joined room ${roomId}`);
    }
  });

  socket.on('room_error', ({ msg, code }) => {
    if (code === 'SESSION_STARTED') {
      showToast('⛔ Session already started — you cannot join this room.', 5000);
    } else {
      showToast('⚠ ' + msg, 3500);
    }
  });

  socket.on('room_auto_start', ({ members, maxMembers }) => {
    roomMembers = members; currentMaxMembers = maxMembers;
    updateLobby(members, maxMembers);
    setTimeout(() => startRoomSession(false), 600); // slightly faster
  });

  socket.on('room_member_joined', ({ socketId, name, members, maxMembers, sessionActive }) => {
    roomMembers = members; updateLobby(members, maxMembers); updateMemberCount();
    roomSys(`${name} joined`); showToast(`🟢 ${name} joined`);

    if (sessionActive && screens.roomChat.classList.contains('active')) {
      scheduleLayout();
      // New member sends offers to us, we wait — glare prevention
      console.log(`[Room] member_joined(${socketId}) sessionActive — waiting for their offers`);
    }
  });

  socket.on('room_member_left', ({ socketId, name, members }) => {
    roomMembers = members; updateMemberCount();
    roomSys(`${name} left`); showToast(`🔴 ${name} left`);
    if (roomPeers[socketId]) {
      const old = roomPeers[socketId];
      old.onicecandidate = old.ontrack = old.onconnectionstatechange = old.oniceconnectionstatechange = null;
      old.close();
      delete roomPeers[socketId];
    }
    delete roomStreams[socketId];
    delete silenceState[socketId];
    delete iceQueue[socketId];
    delete peerState[socketId];
    delete offerRetries[socketId];
    delete pendingOffers[socketId];
    ($(`rbox-${socketId}`) || $(`rthumb-${socketId}`))?.remove();
    scheduleLayout();
  });

  // ── room_offer ──────────────────────────────────────────────────────────────
  socket.on('room_offer', async ({ fromId, offer }) => {
    console.log(`[Room] room_offer from ${fromId} | our peerState=${peerState[fromId]}`);

    // Glare resolution
    if (peerState[fromId] === 'offering') {
      if (mySocketId > fromId) {
        console.log(`[Room] Glare: we win vs ${fromId} — ignoring their offer`);
        return;
      } else {
        console.log(`[Room] Glare: they win vs ${fromId} — rolling back`);
        peerState[fromId] = 'idle';
        delete pendingOffers[fromId];
      }
    }

    if (peerState[fromId] === 'answering') {
      console.warn(`[Room] Duplicate offer from ${fromId} while answering — dropping`);
      return;
    }

    peerState[fromId] = 'answering';

    try {
      const pc = await createRoomPC(fromId);

      if (pc.signalingState !== 'stable') {
        console.warn(`[Room] offer from ${fromId}: bad state ${pc.signalingState}`);
        peerState[fromId] = 'idle';
        return;
      }

      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      await flushIceQueue(fromId);

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('room_answer', { targetId: fromId, answer });
    } catch (e) {
      console.error('[Room] room_offer handler error:', e);
    } finally {
      peerState[fromId] = 'idle';
    }
  });

  // ── room_answer ─────────────────────────────────────────────────────────────
  socket.on('room_answer', async ({ fromId, answer }) => {
    const pc = roomPeers[fromId];
    if (!pc) { console.warn(`[Room] room_answer from ${fromId}: no PC`); return; }

    const ss = pc.signalingState;
    if (ss !== 'have-local-offer') {
      console.warn(`[Room] room_answer from ${fromId} discarded — state: ${ss}`);
      peerState[fromId] = 'idle';
      delete pendingOffers[fromId];
      return;
    }

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
      await flushIceQueue(fromId);
    } catch (e) {
      console.error('[Room] room_answer handler error:', e);
    } finally {
      peerState[fromId] = 'idle';
      delete pendingOffers[fromId];
    }
  });

  // ── room_ice ─────────────────────────────────────────────────────────────────
  socket.on('room_ice', async ({ fromId, candidate }) => {
    const pc = roomPeers[fromId];
    if (!pc || !pc.remoteDescription?.type) {
      enqueueIce(fromId, candidate);
      return;
    }

    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
      if (candidate && candidate.candidate !== '') {
        console.warn('[Room] ICE addCandidate error:', e.message);
      }
    }
  });

  socket.on('room_request_offer', ({ fromId }) => {
    peerState[fromId] = 'idle';
    delete pendingOffers[fromId];
    initiateOffer(fromId);
  });

  socket.on('room_message', ({ from, text }) => roomMsg(text, 'received', from));

  socket.on('room_member_media', ({ socketId, audioMuted, videoOff }) => {
    const b = $(`rbox-${socketId}`) || $(`rthumb-${socketId}`);
    if (b) {
      b.classList.toggle('remote-audio-muted', !!audioMuted);
      b.classList.toggle('remote-video-off',   !!videoOff);
    }
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

// ─── Start / rejoin room session ─────────────────────────────────────────────
async function startRoomSession(isRejoin = false) {
  if (roomIdDisplay) roomIdDisplay.textContent = currentRoomId;

  if (isRejoin) {
    closeAllRoomPeers();
  }

  showScreen('roomChat');
  buildLayout();
  reassignStreams();
  roomSys(isRejoin ? 'Reconnecting video…' : 'Session started! Video connecting…');

  if (!isRejoin) {
    socket.emit('room_start', { roomId: currentRoomId });
  }

  const others = roomMembers.filter(m => m.socketId !== mySocketId);

  let targets;
  if (isRejoin) {
    targets = others;
  } else {
    // FIX: Index-based ordering — lower index offers to higher, prevents glare
    const myIdx = roomMembers.findIndex(m => m.socketId === mySocketId);
    targets = roomMembers.slice(0, myIdx);
  }

  console.log(`[Room] startRoomSession isRejoin=${isRejoin} | offering to ${targets.length} peers`);

  // FIX: Stagger offers slightly to prevent simultaneous negotiation overload
  // especially important for 3+ members
  if (targets.length > 0) {
    for (let i = 0; i < targets.length; i++) {
      const p = targets[i];
      // Small stagger: 0ms, 100ms, 200ms, etc.
      setTimeout(() => {
        if (peerState[p.socketId] === 'idle' || !peerState[p.socketId]) {
          initiateOffer(p.socketId);
        }
      }, i * 100);
    }
  }
}

// ─── Room cleanup ─────────────────────────────────────────────────────────────
function cleanupRoom() {
  closeAllRoomPeers();
  stopLocalMedia();
  currentRoomId    = null;
  lastRoomPassword = '';
  roomMembers      = [];
  currentMaxMembers = 2;
  focusedPeerId    = null;
  roomMuted        = false;
  roomCamOff       = false;
  for (const k of Object.keys(silenceState))     delete silenceState[k];
  for (const k of Object.keys(remoteAudioMuted)) delete remoteAudioMuted[k];
  for (const k of Object.keys(remoteVideoOff))   delete remoteVideoOff[k];
}

// ─── Stranger chat ────────────────────────────────────────────────────────────
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

// ─── Modal ───────────────────────────────────────────────────────────────────
function showModal() { modalLeft.style.display = 'flex'; }
function hideModal() { modalLeft.style.display = 'none'; }

// ─── Stranger controls ───────────────────────────────────────────────────────
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

// ─── Room controls ────────────────────────────────────────────────────────────
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

// ─── Entry flows ──────────────────────────────────────────────────────────────
async function startStrangerFlow() {
  myName = (strangerNameInput.value.trim().slice(0,24)) || 'Stranger';
  showScreen('waiting');
  await getLocalMedia();
  initSocket();
  const go = () => { mySocketId = socket.id; socket.emit('join_queue', { name: myName }); };
  socket.on('connect', go);
  if (socket.connected) go();
}

async function startCreateRoomFlow() {
  const name = createNameInput.value.trim() || 'Host';
  const pass = createPassInput.value.trim();
  if (!pass) { showToast('⚠ Set a room password'); return; }
  lastRoomPassword = pass;
  currentMaxMembers = selectedMaxMembers;
  await getLocalMedia(selectedMaxMembers > 2 ? selectedMaxMembers : 0);
  initSocket();
  const go = () => { mySocketId = socket.id; socket.emit('create_room', { name, password: pass, maxMembers: selectedMaxMembers }); };
  socket.on('connect', go);
  if (socket.connected) go();
}

async function startJoinRoomFlow() {
  const name   = joinNameInput.value.trim() || 'User';
  const roomId = joinRoomIdInput.value.trim();
  const pass   = joinPassInput.value.trim();
  if (roomId.length !== 6) { showToast('⚠ Enter a valid 6-digit room ID'); return; }
  if (!pass)               { showToast('⚠ Enter the room password'); return; }
  lastRoomPassword = pass;
  await getLocalMedia();
  initSocket();
  const go = () => { mySocketId = socket.id; socket.emit('join_room', { roomId, password: pass, name }); };
  socket.on('connect', go);
  if (socket.connected) go();
}

// ─── Event listeners ──────────────────────────────────────────────────────────
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

// FIX: Member count +/- selector — robust cross-browser implementation
(function() {
  const MIN = 2, MAX = 8;  // FIX: max raised to 8
  const valueEl  = $('member-count-value');
  const minusBtn = $('member-count-minus');
  const plusBtn  = $('member-count-plus');

  function render() {
    if (valueEl) {
      valueEl.textContent = selectedMaxMembers;
      valueEl.setAttribute('data-value', selectedMaxMembers);
    }
    if (minusBtn) {
      minusBtn.disabled = selectedMaxMembers <= MIN;
      minusBtn.setAttribute('aria-disabled', selectedMaxMembers <= MIN);
    }
    if (plusBtn) {
      plusBtn.disabled  = selectedMaxMembers >= MAX;
      plusBtn.setAttribute('aria-disabled', selectedMaxMembers >= MAX);
    }
  }

  if (minusBtn) {
    minusBtn.addEventListener('click', (e) => {
      e.preventDefault();
      if (selectedMaxMembers > MIN) { selectedMaxMembers--; render(); }
    });
  }
  if (plusBtn) {
    plusBtn.addEventListener('click', (e) => {
      e.preventDefault();
      if (selectedMaxMembers < MAX) { selectedMaxMembers++; render(); }
    });
  }
  render();
})();

$('btn-cancel-room').addEventListener('click', leaveRoom);
$('btn-copy-room-id').addEventListener('click', () => {
  const roomIdText = lobbyRoomId.textContent;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(roomIdText)
      .then(() => showToast('✓ Room ID copied!'))
      .catch(() => showToast('Room ID: ' + roomIdText));
  } else {
    // Fallback for older browsers
    const ta = document.createElement('textarea');
    ta.value = roomIdText;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select(); ta.setSelectionRange(0,99999);
    try { document.execCommand('copy'); showToast('✓ Room ID copied!'); }
    catch { showToast('Room ID: ' + roomIdText); }
    document.body.removeChild(ta);
  }
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
