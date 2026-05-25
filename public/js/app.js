/* ═══════════════════════════════════════════════════════════════════════════
   CHAT-RIX  —  app.js  v3.0  (Multi-Person Rooms 2-6)
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
  iceCandidatePoolSize: 4,
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
let mySocketId       = null;
let roomMuted        = false;
let roomCamOff       = false;
let isVideoSwapped   = false;
let strangerFullscreen = null;
let strangerRemoteAudioMuted = false;
let strangerRemoteVideoHidden = false;

// Multi-person room: which box is "focused" (shown big)
let focusedPeerId = null;    // null = auto (first remote), or socketId
let fullscreenPeerId = null; // null or socketId for full screen

// Room peer connections
const roomPeers    = {};
const roomStreams   = {};
const iceQueue     = {};
const peerState    = {};
const offerRetries = {};
const pendingOffers = {};

// Per-peer local mute/hide toggles (what WE see of them)
const peerAudioMuted = {};
const peerVideoHidden = {};

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
  roomWait:     $('screen-room-wait'),
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
const roomVideoPanel     = $('room-video-panel');
const roomMsgContainer   = $('room-messages-container');
const roomChatInput      = $('room-chat-input');
const btnRoomSend        = $('btn-room-send');
const roomIdDisplay      = $('room-id-display');
const roomMemberCountEl  = $('room-member-count-display');
const btnRoomMute        = $('btn-room-mute');
const btnRoomCam         = $('btn-room-cam');
const btnRoomLeave       = $('btn-room-leave');

// Member selector state
let selectedMaxMembers = 2;

// ─── Screen ──────────────────────────────────────────────────────────────────
function showScreen(name) {
  Object.values(screens).forEach(el => {
    if (!el) return;
    el.classList.remove('active', 'fade-in');
    el.style.display = 'none';
  });
  const t = screens[name];
  if (!t) return;
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

// ─── Particles ───────────────────────────────────────────────────────────────
(function () {
  const cv = $('particleCanvas'); if (!cv) return;
  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  if (isMobile) { cv.style.display = 'none'; return; }
  const cx = cv.getContext('2d');
  const N = 25;
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
const IS_MOBILE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

async function getLocalMedia() {
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: IS_MOBILE
        ? { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }
        : { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 }, facingMode: 'user' },
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        sampleRate: 16000,
        channelCount: 1,
      },
    });
    localVideo.srcObject = localStream;
  } catch {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
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

// ─── Stranger panel: double-tap fullscreen + overlay controls ────────────────
function initStrangerPanel() {
  strangerFullscreen = null;
  strangerRemoteAudioMuted = false;
  strangerRemoteVideoHidden = false;

  const bigBox  = $('stranger-big-box');
  const pipBox  = $('stranger-pip-box');
  const panel   = $('video-panel-stranger');
  const overlay = $('stranger-overlay');
  const audioBtn = $('stranger-ctrl-audio');
  const videoBtn = $('stranger-ctrl-video');

  if (!bigBox || !pipBox || !panel) return;

  addDoubleTapListener(bigBox, (e) => {
    if (e.target && e.target.closest('.duo-ctrl-btn')) return;
    toggleStrangerFullscreen('big');
  });
  addDoubleTapListener(pipBox, () => toggleStrangerFullscreen('pip'));

  if (overlay) {
    overlay.addEventListener('click', e => e.stopPropagation());
    overlay.addEventListener('dblclick', e => e.stopPropagation());
    overlay.addEventListener('touchend', e => e.stopPropagation());
  }

  if (audioBtn) {
    audioBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleStrangerAudio(); });
    audioBtn.addEventListener('touchend', (e) => e.stopPropagation());
  }
  if (videoBtn) {
    videoBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleStrangerVideo(); });
    videoBtn.addEventListener('touchend', (e) => e.stopPropagation());
  }
}

function toggleStrangerFullscreen(panel) {
  const panelEl = $('video-panel-stranger');
  if (!panelEl) return;
  if (strangerFullscreen === panel) {
    panelEl.classList.remove('fullscreen-big', 'fullscreen-pip');
    strangerFullscreen = null;
    showToast('↩ Back to split view');
  } else {
    panelEl.classList.remove('fullscreen-big', 'fullscreen-pip');
    panelEl.classList.add(panel === 'big' ? 'fullscreen-big' : 'fullscreen-pip');
    strangerFullscreen = panel;
    showToast(panel === 'big' ? '🔍 Stranger — fullscreen' : '🔍 Your video — fullscreen');
  }
}

function toggleStrangerAudio() {
  strangerRemoteAudioMuted = !strangerRemoteAudioMuted;
  const vid = $('remoteVideo');
  const btn = $('stranger-ctrl-audio');
  if (vid) vid.muted = strangerRemoteAudioMuted;
  if (btn) {
    btn.classList.toggle('ctrl-active', strangerRemoteAudioMuted);
    btn.title = strangerRemoteAudioMuted ? 'Unmute stranger audio' : 'Mute stranger audio';
    btn.innerHTML = strangerRemoteAudioMuted
      ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line></svg>`
      : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>`;
  }
  showToast(strangerRemoteAudioMuted ? '🔇 Stranger audio muted' : '🔊 Stranger audio on');
}

function toggleStrangerVideo() {
  strangerRemoteVideoHidden = !strangerRemoteVideoHidden;
  const vid = $('remoteVideo');
  const btn = $('stranger-ctrl-video');
  if (vid) vid.style.opacity = strangerRemoteVideoHidden ? '0' : '1';
  if (btn) {
    btn.classList.toggle('ctrl-active', strangerRemoteVideoHidden);
    btn.title = strangerRemoteVideoHidden ? 'Show stranger video' : 'Hide stranger video';
    btn.innerHTML = strangerRemoteVideoHidden
      ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2m5.66 0H14a2 2 0 0 1 2 2v3.34l1 1L23 7v10"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`
      : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg>`;
  }
  showToast(strangerRemoteVideoHidden ? '📷 Stranger video hidden' : '📷 Stranger video shown');
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
    old.onicecandidate = old.ontrack = old.onconnectionstatechange =
      old.oniceconnectionstatechange = old.onnegotiationneeded = null;
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
    attachRemoteStream(peerId, stream);
  };

  pc.onicecandidate = e => {
    if (e.candidate) socket.emit('room_ice', { targetId: peerId, candidate: e.candidate });
  };

  pc.oniceconnectionstatechange = () => {
    const s = pc.iceConnectionState;
    updateConnIndicator(peerId, s);
    if (s === 'failed') {
      try { pc.restartIce(); } catch {}
    }
  };

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    console.log(`[Room] connectionState ${peerId}: ${s}`);
    if (s === 'connected') {
      offerRetries[peerId] = 0;
      delete pendingOffers[peerId];
      if (roomStreams[peerId]) attachRemoteStream(peerId, roomStreams[peerId]);
    }
    if (s === 'failed') {
      const retries = (offerRetries[peerId] || 0);
      if (retries < 3) {
        offerRetries[peerId] = retries + 1;
        const delay = 1500 + retries * 1000;
        setTimeout(() => {
          if (roomPeers[peerId] === pc) {
            peerState[peerId] = 'idle';
            delete pendingOffers[peerId];
            initiateOffer(peerId);
          }
        }, delay);
      } else {
        showToast('⚠ Peer connection failed — try re-joining');
      }
    }
  };
  return pc;
}

// ─── Multi-Person Layout ─────────────────────────────────────────────────────
// Layout rules:
//   1 remote  → big (like duo: 1 big + 1 small local pip)
//   2 remotes → 1 big top + 2 small bottom row (+ local pip)
//   3 remotes → 1 big top + 3 small bottom (+ local pip)
//   4 remotes → 1 big top + 4 small bottom (+ local pip)
//   5 remotes → 1 big top + 5 small bottom (+ local pip)
//
// "focused" peer = shown in big slot (default = first remote)
// Single click any small box → it becomes focused (big)
// Double click any box → full screen overlay
// Double click fullscreen → exit
// Clicking focused peer box → no change (already big)

function addDoubleTapListener(el, cb) {
  el.addEventListener('dblclick', (e) => cb(e));
  let lastTap = 0;
  el.addEventListener('touchend', (e) => {
    const now = Date.now();
    const gap = now - lastTap;
    if (gap < 300 && gap > 30) {
      e.preventDefault();
      cb(e);
    }
    lastTap = now;
  }, { passive: false });
}

function buildLayout() {
  if (!roomVideoPanel) return;
  roomVideoPanel.innerHTML = '';
  roomVideoPanel.className = 'video-panel room-video-panel';

  fullscreenPeerId = null;

  const others = roomMembers.filter(m => m.socketId !== mySocketId);

  // Determine focused peer
  if (!focusedPeerId || !others.find(m => m.socketId === focusedPeerId)) {
    focusedPeerId = others.length > 0 ? others[0].socketId : null;
  }

  if (others.length === 0) {
    // Only me in the room — show just local
    buildSoloLayout();
    return;
  }

  if (others.length === 1) {
    buildDuoLayout(others[0]);
  } else {
    buildMultiLayout(others);
  }
}

function buildSoloLayout() {
  roomVideoPanel.className += ' layout-solo';
  const box = el('div', 'video-box solo-box local-box');
  const vid = el('video');
  Object.assign(vid, { autoplay: true, playsInline: true, muted: true });
  if (localStream) vid.srcObject = localStream;
  box.appendChild(vid);
  const lbl = el('div', 'video-label local-label'); lbl.textContent = 'YOU';
  box.appendChild(lbl);
  corners(box);
  roomVideoPanel.appendChild(box);
}

function buildDuoLayout(partner) {
  roomVideoPanel.className += ' layout-duo';

  // Big box (focused = partner)
  const bigBox = createRemoteBox(partner, true);
  bigBox.id = 'room-big-box';
  roomVideoPanel.appendChild(bigBox);

  // PiP (local)
  const pipBox = createLocalPip();
  roomVideoPanel.appendChild(pipBox);
}

function buildMultiLayout(others) {
  roomVideoPanel.className += ' layout-multi';

  // Top: big focused box
  const focusedMember = others.find(m => m.socketId === focusedPeerId) || others[0];

  const bigWrap = el('div', 'multi-top-row');
  const bigBox = createRemoteBox(focusedMember, true);
  bigBox.id = 'room-big-box';
  bigWrap.appendChild(bigBox);
  roomVideoPanel.appendChild(bigWrap);

  // Bottom: all others (non-focused remotes + local)
  const bottomRow = el('div', 'multi-bottom-row');
  bottomRow.id = 'multi-bottom-row';

  // Non-focused remotes
  others.forEach(m => {
    if (m.socketId === focusedMember.socketId) return;
    const box = createRemoteBox(m, false);
    bottomRow.appendChild(box);
  });

  // Local pip at end of bottom row
  const localBox = createLocalPip();
  localBox.classList.add('bottom-local');
  bottomRow.appendChild(localBox);

  roomVideoPanel.appendChild(bottomRow);
}

function createRemoteBox(member, isBig) {
  const box = el('div', `video-box remote-box ${isBig ? 'multi-big' : 'multi-small'}`);
  box.dataset.peerId = member.socketId;

  const vid = el('video');
  vid.id = `room-vid-${member.socketId}`;
  Object.assign(vid, { autoplay: true, playsInline: true, muted: false });
  box.appendChild(vid);

  // Attach stream if available
  if (roomStreams[member.socketId]) {
    vid.srcObject = roomStreams[member.socketId];
    vid.muted = peerAudioMuted[member.socketId] || false;
    vid.style.opacity = peerVideoHidden[member.socketId] ? '0' : '1';
  }

  // Name label
  const lbl = el('div', 'video-label remote-label');
  lbl.textContent = member.name.toUpperCase();
  box.appendChild(lbl);

  // Connection indicator (only on big)
  if (isBig) {
    const ind = el('div', 'conn-indicator');
    ind.id = `conn-ind-${member.socketId}`;
    box.appendChild(ind);
  }

  // Controls overlay (audio + video mute for this peer) — show on big box
  if (isBig) {
    const overlay = el('div', 'duo-overlay');
    overlay.id = `overlay-${member.socketId}`;
    overlay.innerHTML = buildPeerControls(member.socketId);
    overlay.addEventListener('click', e => e.stopPropagation());
    overlay.addEventListener('dblclick', e => e.stopPropagation());
    overlay.addEventListener('touchend', e => e.stopPropagation());
    overlay.querySelector('.room-ctrl-audio').addEventListener('click', () => togglePeerAudio(member.socketId));
    overlay.querySelector('.room-ctrl-video').addEventListener('click', () => togglePeerVideo(member.socketId));
    box.appendChild(overlay);
  }

  corners(box);

  // Single click small box → focus it (make it big)
  if (!isBig) {
    box.addEventListener('click', (e) => {
      if (e.target.closest('.duo-ctrl-btn')) return;
      focusedPeerId = member.socketId;
      scheduleLayout();
    });
    box.style.cursor = 'pointer';
  }

  // Double click big → fullscreen; double click small → also fullscreen
  addDoubleTapListener(box, (e) => {
    if (e.target && e.target.closest('.duo-ctrl-btn')) return;
    togglePeerFullscreen(member.socketId);
  });

  return box;
}

function createLocalPip() {
  const pipBox = el('div', 'video-box duo-pip local-box');
  pipBox.id = 'duo-pip-box';

  const pipVid = el('video');
  pipVid.id = 'duo-pip-vid';
  Object.assign(pipVid, { autoplay: true, playsInline: true, muted: true });
  if (localStream) pipVid.srcObject = localStream;
  pipBox.appendChild(pipVid);

  const pipLbl = el('div', 'video-label local-label');
  pipLbl.textContent = 'YOU';
  pipBox.appendChild(pipLbl);

  // Double click local pip → fullscreen
  addDoubleTapListener(pipBox, () => toggleLocalFullscreen());

  corners(pipBox);
  return pipBox;
}

function buildPeerControls(peerId) {
  const audioMuted = peerAudioMuted[peerId] || false;
  const videoHidden = peerVideoHidden[peerId] || false;
  return `
    <button class="duo-ctrl-btn room-ctrl-audio ${audioMuted ? 'ctrl-active' : ''}" title="${audioMuted ? 'Unmute' : 'Mute'} audio">
      ${audioMuted
        ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line></svg>`
        : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>`
      }
    </button>
    <button class="duo-ctrl-btn room-ctrl-video ${videoHidden ? 'ctrl-active' : ''}" title="${videoHidden ? 'Show' : 'Hide'} video">
      ${videoHidden
        ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2m5.66 0H14a2 2 0 0 1 2 2v3.34l1 1L23 7v10"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`
        : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg>`
      }
    </button>
  `;
}

function togglePeerAudio(peerId) {
  peerAudioMuted[peerId] = !peerAudioMuted[peerId];
  const vid = $(`room-vid-${peerId}`);
  if (vid) vid.muted = peerAudioMuted[peerId];
  // Update overlay
  const overlay = $(`overlay-${peerId}`);
  if (overlay) overlay.innerHTML = buildPeerControls(peerId);
  if (overlay) {
    overlay.querySelector('.room-ctrl-audio').addEventListener('click', () => togglePeerAudio(peerId));
    overlay.querySelector('.room-ctrl-video').addEventListener('click', () => togglePeerVideo(peerId));
  }
  showToast(peerAudioMuted[peerId] ? '🔇 Audio muted' : '🔊 Audio on');
}

function togglePeerVideo(peerId) {
  peerVideoHidden[peerId] = !peerVideoHidden[peerId];
  const vid = $(`room-vid-${peerId}`);
  if (vid) vid.style.opacity = peerVideoHidden[peerId] ? '0' : '1';
  const overlay = $(`overlay-${peerId}`);
  if (overlay) overlay.innerHTML = buildPeerControls(peerId);
  if (overlay) {
    overlay.querySelector('.room-ctrl-audio').addEventListener('click', () => togglePeerAudio(peerId));
    overlay.querySelector('.room-ctrl-video').addEventListener('click', () => togglePeerVideo(peerId));
  }
  showToast(peerVideoHidden[peerId] ? '📷 Video hidden' : '📷 Video shown');
}

function togglePeerFullscreen(peerId) {
  const fsOverlay = $('fullscreen-overlay');
  if (fullscreenPeerId === peerId) {
    // Exit fullscreen
    exitFullscreen();
  } else {
    // Enter fullscreen for this peer
    fullscreenPeerId = peerId;
    showFullscreenOverlay(peerId, false);
  }
}

function toggleLocalFullscreen() {
  if (fullscreenPeerId === 'local') {
    exitFullscreen();
  } else {
    fullscreenPeerId = 'local';
    showFullscreenOverlay('local', true);
  }
}

function showFullscreenOverlay(peerId, isLocal) {
  let fsOverlay = $('fullscreen-overlay');
  if (!fsOverlay) {
    fsOverlay = el('div', 'fullscreen-overlay');
    fsOverlay.id = 'fullscreen-overlay';
    document.body.appendChild(fsOverlay);
  }
  fsOverlay.innerHTML = '';
  fsOverlay.style.display = 'flex';

  const vid = el('video');
  Object.assign(vid, { autoplay: true, playsInline: true });

  if (isLocal) {
    vid.srcObject = localStream || null;
    vid.muted = true;
  } else {
    vid.srcObject = roomStreams[peerId] || null;
    vid.muted = peerAudioMuted[peerId] || false;
  }

  // Name label
  let name = 'YOU';
  if (!isLocal) {
    const member = roomMembers.find(m => m.socketId === peerId);
    if (member) name = member.name.toUpperCase();
  }
  const lbl = el('div', 'fs-label'); lbl.textContent = name;

  const hint = el('div', 'fs-hint'); hint.textContent = 'Double-tap to exit fullscreen';

  fsOverlay.appendChild(vid);
  fsOverlay.appendChild(lbl);
  fsOverlay.appendChild(hint);

  // Double tap/click exits
  addDoubleTapListener(fsOverlay, () => exitFullscreen());
  fsOverlay.addEventListener('click', (e) => {
    // Single click: just show/hide hint briefly
  });

  showToast('🔍 Fullscreen — double-tap to exit');
}

function exitFullscreen() {
  fullscreenPeerId = null;
  const fsOverlay = $('fullscreen-overlay');
  if (fsOverlay) {
    fsOverlay.style.display = 'none';
    fsOverlay.innerHTML = '';
  }
  showToast('↩ Back to room view');
}

function attachRemoteStream(peerId, stream) {
  roomStreams[peerId] = stream;
  const vid = $(`room-vid-${peerId}`);
  if (vid) {
    vid.srcObject = stream;
    vid.muted = peerAudioMuted[peerId] || false;
    vid.style.opacity = peerVideoHidden[peerId] ? '0' : '1';
    vid.play().catch(() => {});
  }
  // Also update fullscreen overlay if it's showing this peer
  if (fullscreenPeerId === peerId) {
    const fsOverlay = $('fullscreen-overlay');
    if (fsOverlay) {
      const fsvid = fsOverlay.querySelector('video');
      if (fsvid) { fsvid.srcObject = stream; fsvid.play().catch(() => {}); }
    }
  }
}

function updateConnIndicator(peerId, iceState) {
  const dot = $(`conn-ind-${peerId}`);
  if (!dot) return;
  dot.style.background =
    (iceState === 'connected' || iceState === 'completed') ? '#00ff88' :
    iceState === 'checking'                                ? '#ffaa00' : '#ff2244';
}

function scheduleLayout() {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => { buildLayout(); }, 120);
}

// ─── Legacy compat ───────────────────────────────────────────────────────────
function swapVideos() {
  // In multi-person mode, single click on a box focuses it.
  showToast('↔ Click any box to focus');
}

// ─── DOM helpers ─────────────────────────────────────────────────────────────
function el(tag, cls) { const e = document.createElement(tag); if (cls) e.className = cls; return e; }
function corners(box) {
  ['tl','tr','bl','br'].forEach(c => { const d=el('div',`video-corner ${c}`); box.appendChild(d); });
}

// ─── Offer/Answer ─────────────────────────────────────────────────────────────
async function initiateOffer(peerId) {
  if (peerState[peerId] === 'offering' || peerState[peerId] === 'answering') return;
  if (pendingOffers[peerId]) return;

  peerState[peerId] = 'offering';
  pendingOffers[peerId] = true;

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
    pc.onicecandidate = pc.ontrack = pc.onconnectionstatechange =
      pc.oniceconnectionstatechange = pc.onnegotiationneeded = null;
    try { pc.close(); } catch {}
  }
  for (const k of Object.keys(roomPeers))    delete roomPeers[k];
  for (const k of Object.keys(roomStreams))   delete roomStreams[k];
  for (const k of Object.keys(iceQueue))      delete iceQueue[k];
  for (const k of Object.keys(peerState))     delete peerState[k];
  for (const k of Object.keys(offerRetries))  delete offerRetries[k];
  for (const k of Object.keys(pendingOffers)) delete pendingOffers[k];
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
  const max = maxMembers || selectedMaxMembers || 2;
  if (lobbyMemberCount) lobbyMemberCount.textContent = members.length;
  if (lobbyMaxCount)    lobbyMaxCount.textContent    = max;
  const pct = Math.min(100, Math.round((members.length / max) * 100));
  if (lobbyAutostartFill) lobbyAutostartFill.style.width = pct + '%';
  const remaining = 2 - members.length; // starts at 2
  if (lobbyStatusText) {
    if (members.length >= 2) {
      lobbyStatusText.textContent = 'SESSION STARTING…';
    } else {
      lobbyStatusText.textContent = `WAITING FOR ${2 - members.length} MORE PERSON${2 - members.length > 1 ? 'S' : ''}`;
    }
  }
  const frag = document.createDocumentFragment();
  members.forEach(m => {
    const p = el('div','member-pill');
    p.innerHTML = `<span class="pill-dot"></span>${m.name}${m.socketId===mySocketId?' (You)':''}`;
    frag.appendChild(p);
  });
  lobbyMembersList.innerHTML = ''; lobbyMembersList.appendChild(frag);
}

// ─── Room Wait Screen ────────────────────────────────────────────────────────
function showRoomWaitScreen(memberName) {
  const msgEl = $('room-wait-msg');
  const subEl = $('room-wait-sub');
  const ridEl = $('wait-room-id-display');
  if (msgEl) msgEl.textContent = 'MEMBER DISCONNECTED';
  if (subEl) subEl.textContent = `Waiting for ${memberName} to reconnect...`;
  if (ridEl && currentRoomId) ridEl.textContent = currentRoomId;
  showScreen('roomWait');
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
    transports:             ['websocket', 'polling'],
    upgrade:                false,
    reconnection:           true,
    reconnectionAttempts:   Infinity,
    reconnectionDelay:      600,
    reconnectionDelayMax:   4000,
    randomizationFactor:    0.3,
    timeout:                12000,
  });

  socket.on('connect', () => {
    mySocketId = socket.id;
    console.log('[SOCKET] connected id=', socket.id);
  });

  socket.on('disconnect', reason => {
    console.log('[SOCKET] disconnected reason=', reason);
    if (reason !== 'io client disconnect') showToast('⚠ Connection lost — reconnecting…');
  });

  socket.on('connect_error', err => console.warn('[SOCKET] connect_error:', err.message));

  socket.io.on('reconnect', attempt => {
    mySocketId = socket.id;
    console.log('[SOCKET] reconnected attempt=', attempt);
    if (currentRoomId) {
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
    const lbl = $('stranger-big-label');
    if (lbl) lbl.textContent = partnerName.toUpperCase();

    if (localStream && localVideo) {
      localVideo.srcObject = localStream;
      localVideo.muted = true;
    }

    const remVid = $('remoteVideo');
    if (remVid) { remVid.style.opacity = '1'; remVid.srcObject = null; }
    if (remoteStatus) {
      remoteStatus.textContent = 'Connecting…';
      remoteStatus.classList.remove('hidden');
    }

    clearMsgs(); addSys(`Connected to ${partnerName}. Say hello!`);
    showScreen('chat');
    initStrangerPanel();
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
  socket.on('partner_left', () => {
    closePeerConnection();
    addSys('Stranger disconnected.');
    const remVid = $('remoteVideo');
    if (remVid) { remVid.style.opacity = '1'; }
    showModal();
  });

  // ══ Room events ════════════════════════════════════════════════════════════
  socket.on('room_created', ({ roomId, name, members, maxMembers }) => {
    currentRoomId = roomId; myName = name; roomMembers = members;
    selectedMaxMembers = maxMembers;
    if (lobbyRoomId) lobbyRoomId.textContent = roomId;
    updateLobby(members, maxMembers);
    showScreen('roomLobby'); showToast(`✓ Room ${roomId} created! (max ${maxMembers})`);
  });

  socket.on('room_joined', ({ roomId, name, members, maxMembers, started }) => {
    currentRoomId = roomId; myName = name; roomMembers = members;
    mySocketId = socket.id;
    selectedMaxMembers = maxMembers || 2;
    if (lobbyRoomId) lobbyRoomId.textContent = roomId;
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
    roomMembers = members;
    updateLobby(members, maxMembers);
    setTimeout(() => startRoomSession(false), 500);
  });

  socket.on('room_member_joined', ({ socketId, name, members, maxMembers, sessionActive }) => {
    roomMembers = members;
    updateLobby(members, maxMembers);
    if (roomMemberCountEl) roomMemberCountEl.textContent = `${members.length}/${maxMembers || selectedMaxMembers}`;
    roomSys(`${name} joined`); showToast(`🟢 ${name} joined`);

    if (sessionActive && screens.roomChat.classList.contains('active')) {
      // Connect WebRTC to new member
      const newMember = members.find(m => m.socketId === socketId);
      if (newMember && socketId !== mySocketId) {
        // Request offer from all existing members
        socket.emit('room_request_offer', { targetId: socketId });
      }
      scheduleLayout();
    }
    // If we were on wait screen and someone rejoined, start session
    if (screens.roomWait && screens.roomWait.classList.contains('active') && sessionActive) {
      showToast(`🟢 ${name} rejoined!`);
      startRoomSession(true);
    }
  });

  socket.on('room_member_left', ({ socketId, name, members, maxMembers, newHost }) => {
    roomMembers = members;
    if (roomMemberCountEl) roomMemberCountEl.textContent = `${members.length}/${maxMembers || selectedMaxMembers}`;
    roomSys(`${name} left`); showToast(`🔴 ${name} left`);

    // Clean up peer connection
    if (roomPeers[socketId]) {
      const old = roomPeers[socketId];
      old.onicecandidate = old.ontrack = old.onconnectionstatechange =
        old.oniceconnectionstatechange = null;
      old.close();
      delete roomPeers[socketId];
    }
    delete roomStreams[socketId];
    delete iceQueue[socketId]; delete peerState[socketId];
    delete offerRetries[socketId]; delete pendingOffers[socketId];
    delete peerAudioMuted[socketId]; delete peerVideoHidden[socketId];

    // If focused peer left, reset focus
    if (focusedPeerId === socketId) focusedPeerId = null;

    if (screens.roomChat.classList.contains('active')) scheduleLayout();
  });

  // Someone disconnected mid-session — they may rejoin
  socket.on('room_member_disconnected', ({ leftName, roomId, remainingCount, maxMembers }) => {
    // Keep session going, just update layout
    showToast(`🔴 ${leftName} disconnected — may rejoin`, 4000);
    // If only 1 person left and that's me, show wait screen
    if (remainingCount === 1) {
      const others = roomMembers.filter(m => m.socketId !== mySocketId);
      if (others.length === 0) {
        closeAllRoomPeers();
        showRoomWaitScreen(leftName);
      }
    }
  });

  // ── room_offer ──────────────────────────────────────────────────────────────
  socket.on('room_offer', async ({ fromId, offer }) => {
    if (peerState[fromId] === 'offering') {
      if (mySocketId > fromId) return;
      else { peerState[fromId] = 'idle'; delete pendingOffers[fromId]; }
    }
    if (peerState[fromId] === 'answering') return;
    peerState[fromId] = 'answering';

    try {
      const pc = await createRoomPC(fromId);
      if (pc.signalingState !== 'stable') { peerState[fromId] = 'idle'; return; }
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

  socket.on('room_answer', async ({ fromId, answer }) => {
    const pc = roomPeers[fromId];
    if (!pc) return;
    if (pc.signalingState !== 'have-local-offer') {
      peerState[fromId] = 'idle'; delete pendingOffers[fromId]; return;
    }
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
      await flushIceQueue(fromId);
    } catch (e) {
      console.error('[Room] room_answer handler error:', e);
    } finally {
      peerState[fromId] = 'idle'; delete pendingOffers[fromId];
    }
  });

  socket.on('room_ice', async ({ fromId, candidate }) => {
    const pc = roomPeers[fromId];
    if (!pc || !pc.remoteDescription?.type) { enqueueIce(fromId, candidate); return; }
    try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); }
    catch (e) { if (candidate?.candidate !== '') console.warn('[Room] ICE addCandidate error:', e.message); }
  });

  socket.on('room_request_offer', ({ fromId }) => {
    peerState[fromId] = 'idle'; delete pendingOffers[fromId]; initiateOffer(fromId);
  });

  socket.on('room_message', ({ from, text }) => roomMsg(text, 'received', from));

  socket.on('room_member_media', ({ socketId, audioMuted, videoOff }) => {
    const vid = $(`room-vid-${socketId}`);
    if (vid) {
      if (audioMuted !== undefined) vid.muted = audioMuted;
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
  if (roomMemberCountEl) roomMemberCountEl.textContent = `${roomMembers.length}/${selectedMaxMembers}`;
  focusedPeerId = null;
  fullscreenPeerId = null;

  if (isRejoin) closeAllRoomPeers();

  showScreen('roomChat');
  buildLayout();

  roomSys(isRejoin ? 'Reconnecting video…' : 'Session started! Video connecting…');
  if (!isRejoin) socket.emit('room_start', { roomId: currentRoomId });

  const others = roomMembers.filter(m => m.socketId !== mySocketId);
  let targets;
  if (isRejoin) {
    targets = others;
  } else {
    const myIdx = roomMembers.findIndex(m => m.socketId === mySocketId);
    targets = roomMembers.slice(0, myIdx);
  }

  for (let i = 0; i < targets.length; i++) {
    const p = targets[i];
    setTimeout(() => {
      if (!peerState[p.socketId] || peerState[p.socketId] === 'idle') {
        initiateOffer(p.socketId);
      }
    }, i * 80);
  }
}

// ─── Room cleanup ─────────────────────────────────────────────────────────────
function cleanupRoom() {
  closeAllRoomPeers();
  stopLocalMedia();
  currentRoomId    = null;
  lastRoomPassword = '';
  roomMembers      = [];
  roomMuted        = false;
  roomCamOff       = false;
  isVideoSwapped   = false;
  focusedPeerId    = null;
  fullscreenPeerId = null;
  for (const k of Object.keys(peerAudioMuted))  delete peerAudioMuted[k];
  for (const k of Object.keys(peerVideoHidden)) delete peerVideoHidden[k];
  exitFullscreen();
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
function showModal() { if (modalLeft) modalLeft.style.display = 'flex'; }
function hideModal() { if (modalLeft) modalLeft.style.display = 'none'; }

// ─── Stranger controls ───────────────────────────────────────────────────────
function toggleMute() {
  if (!localStream) { showToast('⚠ No microphone available'); return; }
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach(t => { t.enabled = !isMuted; });
  btnMute.classList.toggle('active', isMuted);
  btnMute.querySelector('.icon-unmuted').style.display = isMuted ? 'none' : 'block';
  btnMute.querySelector('.icon-muted').style.display   = isMuted ? 'block' : 'none';
  showToast(isMuted ? '🎤 Muted' : '🎤 Mic on');
}
function toggleCamera() {
  if (!localStream) { showToast('⚠ No camera available'); return; }
  isCamOff = !isCamOff;
  localStream.getVideoTracks().forEach(t => { t.enabled = !isCamOff; });
  btnVideoToggle.classList.toggle('active', isCamOff);
  btnVideoToggle.querySelector('.icon-cam-on').style.display  = isCamOff ? 'none' : 'block';
  btnVideoToggle.querySelector('.icon-cam-off').style.display = isCamOff ? 'block' : 'none';
  showToast(isCamOff ? '📷 Camera off' : '📷 Camera on');
}
function skipStranger() {
  closePeerConnection();
  strangerFullscreen = null;
  strangerRemoteAudioMuted = false;
  strangerRemoteVideoHidden = false;
  const panelEl = $('video-panel-stranger');
  if (panelEl) panelEl.classList.remove('fullscreen-big', 'fullscreen-pip');
  const remVid = $('remoteVideo');
  if (remVid) { remVid.style.opacity = '1'; remVid.srcObject = null; }
  isMuted = false; isCamOff = false;
  if (localStream) {
    localStream.getAudioTracks().forEach(t => { t.enabled = true; });
    localStream.getVideoTracks().forEach(t => { t.enabled = true; });
  }
  if (btnMute) {
    btnMute.classList.remove('active');
    const u = btnMute.querySelector('.icon-unmuted');
    const m = btnMute.querySelector('.icon-muted');
    if (u) u.style.display = 'block';
    if (m) m.style.display = 'none';
  }
  if (btnVideoToggle) {
    btnVideoToggle.classList.remove('active');
    const on  = btnVideoToggle.querySelector('.icon-cam-on');
    const off = btnVideoToggle.querySelector('.icon-cam-off');
    if (on)  on.style.display  = 'block';
    if (off) off.style.display = 'none';
  }
  if (localStream && localVideo) localVideo.srcObject = localStream;
  if (remoteStatus) {
    remoteStatus.textContent = 'Connecting…';
    remoteStatus.classList.remove('hidden');
  }
  addSys('Searching for next stranger…');
  socket.emit('skip');
  showScreen('waiting');
}
function endSession() {
  closePeerConnection(); stopLocalMedia();
  if (socket) { socket.removeAllListeners(); socket.disconnect(); socket = null; }
  isMuted = false; isCamOff = false;
  strangerFullscreen = null; strangerRemoteAudioMuted = false; strangerRemoteVideoHidden = false;
  const panelEl = $('video-panel-stranger');
  if (panelEl) panelEl.classList.remove('fullscreen-big', 'fullscreen-pip');
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
  if (!localStream) { showToast('⚠ No microphone available'); return; }
  roomMuted = !roomMuted;
  localStream.getAudioTracks().forEach(t => { t.enabled = !roomMuted; });
  btnRoomMute.classList.toggle('active', roomMuted);
  btnRoomMute.querySelector('.icon-unmuted').style.display = roomMuted ? 'none' : 'block';
  btnRoomMute.querySelector('.icon-muted').style.display   = roomMuted ? 'block' : 'none';
  socket.emit('room_media_state', { roomId: currentRoomId, audioMuted: roomMuted, videoOff: roomCamOff });
  showToast(roomMuted ? '🎤 Muted' : '🎤 Mic on');
}
function toggleRoomCam() {
  if (!localStream) { showToast('⚠ No camera available'); return; }
  roomCamOff = !roomCamOff;
  localStream.getVideoTracks().forEach(t => { t.enabled = !roomCamOff; });
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
  myName = name;
  lastRoomPassword = pass;
  await getLocalMedia();
  initSocket();
  const go = () => {
    mySocketId = socket.id;
    socket.emit('create_room', { name, password: pass, maxMembers: selectedMaxMembers });
  };
  socket.on('connect', go);
  if (socket.connected) go();
}

async function startJoinRoomFlow() {
  const name   = joinNameInput.value.trim() || 'User';
  const roomId = joinRoomIdInput.value.trim();
  const pass   = joinPassInput.value.trim();
  if (roomId.length !== 6) { showToast('⚠ Enter a valid 6-digit room ID'); return; }
  if (!pass)               { showToast('⚠ Enter the room password'); return; }
  myName = name;
  lastRoomPassword = pass;
  await getLocalMedia();
  initSocket();
  const go = () => { mySocketId = socket.id; socket.emit('join_room', { roomId, password: pass, name }); };
  socket.on('connect', go);
  if (socket.connected) go();
}

// ─── Member selector ──────────────────────────────────────────────────────────
function initMemberSelector() {
  const display = $('member-count-display');
  const btnMinus = $('btn-member-minus');
  const btnPlus  = $('btn-member-plus');

  if (!display || !btnMinus || !btnPlus) return;

  function updateDisplay() {
    display.textContent = selectedMaxMembers;
    btnMinus.disabled = selectedMaxMembers <= 2;
    btnPlus.disabled  = selectedMaxMembers >= 6;
    btnMinus.style.opacity = selectedMaxMembers <= 2 ? '0.4' : '1';
    btnPlus.style.opacity  = selectedMaxMembers >= 6 ? '0.4' : '1';
  }

  btnMinus.addEventListener('click', () => {
    if (selectedMaxMembers > 2) { selectedMaxMembers--; updateDisplay(); }
  });
  btnPlus.addEventListener('click', () => {
    if (selectedMaxMembers < 6) { selectedMaxMembers++; updateDisplay(); }
  });

  updateDisplay();
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

$('btn-cancel-room').addEventListener('click', leaveRoom);
$('btn-copy-room-id').addEventListener('click', () => {
  const roomIdText = lobbyRoomId.textContent;
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(roomIdText)
      .then(() => showToast('✓ Room ID copied!'))
      .catch(() => showToast('Room ID: ' + roomIdText));
  } else {
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

const btnRoomWaitLeave = $('btn-room-wait-leave');
if (btnRoomWaitLeave) btnRoomWaitLeave.addEventListener('click', leaveRoom);

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

// Init member selector
initMemberSelector();

showScreen('landing');

// ── Android keyboard layout fix ──
(function () {
  if (!window.visualViewport) return;
  const IS_TOUCH = ('ontouchstart' in window);
  if (!IS_TOUCH) return;
  function onViewportResize() {
    const vh = window.visualViewport.height;
    const chatEl   = document.getElementById('screen-chat');
    const roomEl   = document.getElementById('screen-room-chat');
    const activeEl = (chatEl && chatEl.classList.contains('active')) ? chatEl
                   : (roomEl && roomEl.classList.contains('active')) ? roomEl
                   : null;
    if (!activeEl) return;
    const layout = activeEl.querySelector('.chat-layout');
    if (!layout) return;
    layout.style.height = vh + 'px';
  }
  window.visualViewport.addEventListener('resize', onViewportResize);
  window.visualViewport.addEventListener('scroll', onViewportResize);
})();
