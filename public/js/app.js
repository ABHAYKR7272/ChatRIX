/* ═══════════════════════════════════════════════════════
   CHAT-RIX — app.js
   Architecture: Server tells each client exactly WHO to
   call and WHETHER to send offer or wait for one.
   Event: rtc_connect { peerId, initiator: bool }
   No timing races. Works for late join, rejoin, any order.
   ═══════════════════════════════════════════════════════ */
'use strict';

const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'turn:openrelay.metered.ca:80',  username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  ],
  iceCandidatePoolSize: 4,
  bundlePolicy: 'max-bundle',
  rtcpMuxPolicy: 'require',
};

// ─── Global state ─────────────────────────────────────
let socket            = null;
let localStream       = null;
let peerConnection    = null;   // stranger 1:1
let myName            = '';
let isMuted           = false;
let isCamOff          = false;
let isConnectedToPeer = false;

let currentRoomId    = null;
let roomPeers        = {};   // peerId → RTCPeerConnection
let roomStreams       = {};   // peerId → MediaStream
let silenceState     = {};
let roomMembers      = [];
let mySocketId       = null;
let focusedPeerId    = null;
let roomMuted        = false;
let roomCamOff       = false;
let remoteAudioMuted = {};
let remoteVideoOff   = {};

const iceQueues  = {};   // peerId → RTCIceCandidateInit[]
let rebuildTimer = null;

// ─── DOM ──────────────────────────────────────────────
const screens = {
  landing:      document.getElementById('screen-landing'),
  nameStranger: document.getElementById('screen-name-stranger'),
  createRoom:   document.getElementById('screen-create-room'),
  joinRoom:     document.getElementById('screen-join-room'),
  waiting:      document.getElementById('screen-waiting'),
  roomLobby:    document.getElementById('screen-room-lobby'),
  chat:         document.getElementById('screen-chat'),
  roomChat:     document.getElementById('screen-room-chat'),
};
const $ = id => document.getElementById(id);

const toastEl        = $('toast');
const onlineCountEls = { landing: $('online-count-landing'), wait: $('online-count-wait'), chat: $('online-count-chat') };

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

const createNameInput = $('create-name-input');
const createPassInput = $('create-pass-input');
const joinNameInput   = $('join-name-input');
const joinRoomIdInput = $('join-roomid-input');
const joinPassInput   = $('join-pass-input');

const lobbyRoomId            = $('lobby-room-id');
const lobbyMembersList       = $('lobby-members-list');
const lobbyMemberCount       = $('lobby-member-count');
const btnStartRoom           = $('btn-start-room');
const roomVideoPanel         = $('room-video-panel');
const roomMessagesContainer  = $('room-messages-container');
const roomChatInput          = $('room-chat-input');
const btnRoomSend            = $('btn-room-send');
const roomIdDisplay          = $('room-id-display');
const roomMemberCountDisplay = $('room-member-count-display');
const btnRoomMute            = $('btn-room-mute');
const btnRoomCam             = $('btn-room-cam');
const btnRoomLeave           = $('btn-room-leave');

// ─── Screens ──────────────────────────────────────────
function showScreen(name) {
  Object.values(screens).forEach(el => { el.classList.remove('active','fade-in'); el.style.display='none'; });
  const t = screens[name];
  t.style.display = 'flex';
  requestAnimationFrame(() => t.classList.add('active','fade-in'));
}

// ─── Toast ────────────────────────────────────────────
let toastTimer = null;
function showToast(msg, dur = 2800) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), dur);
}

// ─── Particles ────────────────────────────────────────
(function initParticles() {
  const canvas = $('particleCanvas'); if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let W, H, particles=[], animRunning=true, rafId=null;
  const COLORS=['#00ffff','#ff00aa','#00ff88','#ffffff'], COUNT=40, LINK_D=80;
  function resize(){ W=canvas.width=window.innerWidth; H=canvas.height=window.innerHeight; }
  function rp(){ return { x:Math.random()*W, y:Math.random()*H, r:Math.random()*1.2+0.3, dx:(Math.random()-.5)*.35, dy:(Math.random()-.5)*.35, color:COLORS[Math.floor(Math.random()*COLORS.length)], alpha:Math.random()*.4+.1 }; }
  function draw(){
    if(!animRunning){rafId=null;return;} rafId=requestAnimationFrame(draw);
    ctx.clearRect(0,0,W,H);
    for(let i=0;i<COUNT;i++){const p=particles[i];ctx.beginPath();ctx.arc(p.x,p.y,p.r,0,Math.PI*2);ctx.fillStyle=p.color;ctx.globalAlpha=p.alpha;ctx.fill();p.x+=p.dx;p.y+=p.dy;if(p.x<0)p.x=W;if(p.x>W)p.x=0;if(p.y<0)p.y=H;if(p.y>H)p.y=0;}
    ctx.globalAlpha=1;ctx.lineWidth=.5;
    for(let i=0;i<COUNT;i++)for(let j=i+1;j<COUNT;j++){const dx=particles[i].x-particles[j].x,dy=particles[i].y-particles[j].y,d2=dx*dx+dy*dy;if(d2<LINK_D*LINK_D){ctx.beginPath();ctx.moveTo(particles[i].x,particles[i].y);ctx.lineTo(particles[j].x,particles[j].y);ctx.strokeStyle=`rgba(0,255,255,${.06*(1-Math.sqrt(d2)/LINK_D)})`;ctx.stroke();}}
  }
  document.addEventListener('visibilitychange',()=>{animRunning=!document.hidden;if(animRunning&&!rafId)draw();});
  window.addEventListener('resize',resize); resize();
  particles=Array.from({length:COUNT},rp); draw();
})();

// ─── Media ────────────────────────────────────────────
async function getLocalMedia() {
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { width:{ideal:1280}, height:{ideal:720}, frameRate:{ideal:30}, facingMode:'user' },
      audio: { echoCancellation:true, noiseSuppression:true, sampleRate:16000 }
    });
    localVideo.srcObject = localStream;
  } catch {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio:true });
      localVideo.srcObject = null;
      showToast('⚠ Camera unavailable — audio only');
    } catch {
      showToast('⚠ No media access — text only');
      localStream = null;
    }
  }
}

function stopLocalMedia() {
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  localVideo.srcObject = null;
}

// ─── ICE queue ────────────────────────────────────────
function enqueueIce(peerId, c) { if (!iceQueues[peerId]) iceQueues[peerId]=[]; iceQueues[peerId].push(c); }
async function flushIceQueue(peerId, pc) {
  const q = iceQueues[peerId]; if (!q||!q.length) return;
  for (const c of q.splice(0)) { try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch(e){} }
}
function clearIceQueue(peerId) { delete iceQueues[peerId]; }

// ─── Stranger WebRTC ──────────────────────────────────
function createPeerConnection() {
  if (peerConnection) { peerConnection.close(); peerConnection = null; }
  clearIceQueue('_stranger');
  peerConnection = new RTCPeerConnection(ICE_SERVERS);
  if (localStream) localStream.getTracks().forEach(t => peerConnection.addTrack(t, localStream));
  peerConnection.ontrack = e => { if(e.streams?.[0]){remoteVideo.srcObject=e.streams[0];remoteStatus.classList.add('hidden');} };
  peerConnection.onicecandidate = e => { if(e.candidate) socket.emit('webrtc_ice',{candidate:e.candidate}); };
  peerConnection.onconnectionstatechange = () => {
    const s = peerConnection?.connectionState;
    if(s==='connected'){remoteStatus.classList.add('hidden');isConnectedToPeer=true;}
    else if(s==='failed'||s==='disconnected'){remoteStatus.textContent='Connection lost...';remoteStatus.classList.remove('hidden');}
  };
  return peerConnection;
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
  clearIceQueue('_stranger');
  remoteVideo.srcObject = null;
  remoteStatus.textContent = 'Connecting...';
  remoteStatus.classList.remove('hidden');
  isConnectedToPeer = false;
}

// ══════════════════════════════════════════════════════
//  ROOM WebRTC
//
//  Server sends: rtc_connect { peerId, initiator: bool }
//  initiator=true  → createOffer and send
//  initiator=false → just create PC and wait for offer
//
//  This removes ALL client-side timing logic.
//  Server decides pairing order always.
// ══════════════════════════════════════════════════════

async function createRoomPC(peerId) {
  // Tear down any existing connection first
  if (roomPeers[peerId]) {
    const old = roomPeers[peerId];
    old.onicecandidate = null; old.ontrack = null; old.onconnectionstatechange = null;
    old.close();
    delete roomPeers[peerId];
    delete roomStreams[peerId];
  }
  clearIceQueue(peerId);

  const pc = new RTCPeerConnection(ICE_SERVERS);
  roomPeers[peerId] = pc;

  if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

  pc.ontrack = e => {
    if (e.streams?.[0]) {
      roomStreams[peerId] = e.streams[0];
      const vid = document.getElementById(`rv-${peerId}`);
      if (vid) vid.srcObject = e.streams[0];
    }
  };

  pc.onicecandidate = e => {
    if (e.candidate) socket.emit('room_ice', { targetId: peerId, candidate: e.candidate });
  };

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    const ind = document.getElementById(`ri-${peerId}`);
    if (ind) ind.style.background = s==='connected' ? '#00ff88' : (s==='failed' ? '#ff2244' : '#ffaa00');
    if (s === 'failed') {
      console.warn(`[Room] PC failed for ${peerId}`);
      // Don't auto-retry here — server will re-pair if needed
    }
  };

  return pc;
}

// Called by rtc_connect event from server
async function handleRtcConnect(peerId, initiator) {
  console.log(`[Room] rtc_connect peerId=${peerId} initiator=${initiator}`);

  // Make sure we're on the chat screen and have media
  if (!screens.roomChat.classList.contains('active')) {
    console.warn('[Room] rtc_connect received but not on chat screen yet — queuing');
    // Wait a moment and retry — this handles race where event arrives before screen switch
    setTimeout(() => handleRtcConnect(peerId, initiator), 500);
    return;
  }

  const pc = await createRoomPC(peerId);

  if (initiator) {
    try {
      const offer = await pc.createOffer({ offerToReceiveAudio:true, offerToReceiveVideo:true });
      await pc.setLocalDescription(offer);
      socket.emit('room_offer', { targetId: peerId, offer: pc.localDescription });
      console.log(`[Room] Sent offer to ${peerId}`);
    } catch (e) {
      console.error(`[Room] createOffer failed for ${peerId}:`, e);
    }
  }
  // Non-initiator: just wait for the offer to arrive via room_offer event
}

function closeRoomPC(peerId) {
  const pc = roomPeers[peerId];
  if (pc) { pc.onicecandidate=null; pc.ontrack=null; pc.onconnectionstatechange=null; pc.close(); }
  delete roomPeers[peerId];
  delete roomStreams[peerId];
  clearIceQueue(peerId);
}

function closeAllRoomPeers() {
  Object.keys(roomPeers).forEach(id => closeRoomPC(id));
}

function reassignStreams() {
  Object.entries(roomStreams).forEach(([peerId, stream]) => {
    const vid = document.getElementById(`rv-${peerId}`);
    if (vid) vid.srcObject = stream;
  });
}

// ─── Room Video Layout ────────────────────────────────
function buildRoomVideoLayout() {
  const panel = roomVideoPanel;
  panel.innerHTML = '';
  panel.className = 'video-panel room-video-panel';
  const others = roomMembers.filter(m => m.socketId !== mySocketId);
  const total  = roomMembers.length;
  if (total <= 2) {
    panel.classList.add('layout-split');
    panel.appendChild(makeMyVideoBox());
    others.forEach(m => panel.appendChild(makeRemoteVideoBox(m)));
  } else {
    panel.classList.add('layout-multi');
    const bigWrap = document.createElement('div'); bigWrap.className='room-big-wrap'; bigWrap.id='room-big-wrap';
    const bigVid = document.createElement('video'); bigVid.id='room-big-video'; bigVid.autoplay=true; bigVid.playsInline=true; bigVid.muted=true;
    if (localStream) bigVid.srcObject = localStream;
    bigWrap.appendChild(bigVid);
    const bigLbl = document.createElement('div'); bigLbl.id='room-big-label'; bigLbl.className='video-label local-label'; bigLbl.textContent='YOU';
    bigWrap.appendChild(bigLbl);
    ['tl','tr','bl','br'].forEach(c=>{const d=document.createElement('div');d.className=`video-corner ${c}`;bigWrap.appendChild(d);});
    panel.appendChild(bigWrap);
    const strip = document.createElement('div'); strip.className='room-strip'; strip.id='room-strip';
    strip.appendChild(makeMyThumb());
    others.forEach(m => strip.appendChild(makeRemoteThumb(m)));
    panel.appendChild(strip);
  }
}

function scheduleBuildRoomVideoLayout() {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => { buildRoomVideoLayout(); reassignStreams(); }, 150);
}

function makeMyVideoBox() {
  const box=document.createElement('div'); box.className='video-box local-box';
  const vid=document.createElement('video'); vid.autoplay=true; vid.playsInline=true; vid.muted=true;
  if(localStream) vid.srcObject=localStream; box.appendChild(vid);
  const lbl=document.createElement('div'); lbl.className='video-label local-label'; lbl.textContent='YOU'; box.appendChild(lbl);
  ['tl','tr','bl','br'].forEach(c=>{const d=document.createElement('div');d.className=`video-corner ${c}`;box.appendChild(d);});
  return box;
}

function makeRemoteVideoBox(member) {
  const box=document.createElement('div'); box.className='video-box remote-box'; box.id=`rbox-${member.socketId}`;
  const vid=document.createElement('video'); vid.id=`rv-${member.socketId}`; vid.autoplay=true; vid.playsInline=true; box.appendChild(vid);
  const lbl=document.createElement('div'); lbl.className='video-label remote-label'; lbl.textContent=member.name.toUpperCase(); box.appendChild(lbl);
  const ind=document.createElement('div'); ind.id=`ri-${member.socketId}`; ind.className='conn-indicator'; box.appendChild(ind);
  ['tl','tr','bl','br'].forEach(c=>{const d=document.createElement('div');d.className=`video-corner ${c}`;box.appendChild(d);});
  return box;
}

function makeMyThumb() {
  const thumb=document.createElement('div'); thumb.className='room-thumb-item room-thumb-me';
  const vid=document.createElement('video'); vid.autoplay=true; vid.playsInline=true; vid.muted=true;
  if(localStream) vid.srcObject=localStream; thumb.appendChild(vid);
  const lbl=document.createElement('span'); lbl.textContent='YOU'; thumb.appendChild(lbl);
  thumb.addEventListener('click', focusBigMe); return thumb;
}

function makeRemoteThumb(member) {
  const thumb=document.createElement('div'); thumb.className='room-thumb-item'; thumb.id=`rthumb-${member.socketId}`;
  const vid=document.createElement('video'); vid.id=`rv-${member.socketId}`; vid.autoplay=true; vid.playsInline=true; thumb.appendChild(vid);
  const lbl=document.createElement('span'); lbl.textContent=member.name.slice(0,10).toUpperCase(); thumb.appendChild(lbl);
  const overlay=document.createElement('div'); overlay.className='thumb-overlay';
  const btnAud=document.createElement('button'); btnAud.className='thumb-ctrl-btn'; btnAud.title='Mute audio locally'; btnAud.innerHTML='🔊';
  btnAud.addEventListener('click',e=>{e.stopPropagation();toggleRemoteAudio(member.socketId,vid,btnAud);}); overlay.appendChild(btnAud);
  const btnVid=document.createElement('button'); btnVid.className='thumb-ctrl-btn'; btnVid.title='Hide video locally'; btnVid.innerHTML='📷';
  btnVid.addEventListener('click',e=>{e.stopPropagation();toggleRemoteVideo(member.socketId,vid,btnVid);}); overlay.appendChild(btnVid);
  const btnSil=document.createElement('button'); btnSil.className='thumb-ctrl-btn thumb-ctrl-silence'; btnSil.title='Mute for everyone'; btnSil.innerHTML='🔕';
  btnSil.addEventListener('click',e=>{
    e.stopPropagation(); silenceState[member.socketId]=!silenceState[member.socketId];
    const m=silenceState[member.socketId]; btnSil.innerHTML=m?'🔕':'🔔'; btnSil.classList.toggle('ctrl-active',m);
    socket.emit('room_force_mute',{roomId:currentRoomId,targetId:member.socketId,muted:m});
    showToast(m?`🔕 Muted ${member.name} for all`:`🔔 Unmuted ${member.name} for all`);
  }); overlay.appendChild(btnSil);
  thumb.appendChild(overlay);
  thumb.addEventListener('click',()=>focusBigRemote(member)); return thumb;
}

function focusBigRemote(member) {
  const bigWrap=$('room-big-wrap'); if(!bigWrap)return;
  focusedPeerId=member.socketId;
  const bv=$('room-big-video'),bl=$('room-big-label');
  const vid=document.getElementById(`rv-${member.socketId}`);
  if(vid?.srcObject){bv.srcObject=vid.srcObject;bv.muted=false;}
  if(bl) bl.textContent=member.name.toUpperCase();
  bigWrap.classList.add('focused-remote');
  document.querySelectorAll('.room-thumb-item').forEach(t=>t.classList.remove('active-thumb'));
  document.getElementById(`rthumb-${member.socketId}`)?.classList.add('active-thumb');
}

function focusBigMe() {
  const bigWrap=$('room-big-wrap'); if(!bigWrap)return;
  focusedPeerId=null;
  const bv=$('room-big-video'),bl=$('room-big-label');
  if(bv&&localStream){bv.srcObject=localStream;bv.muted=true;}
  if(bl) bl.textContent='YOU';
  bigWrap.classList.remove('focused-remote');
  document.querySelectorAll('.room-thumb-item').forEach(t=>t.classList.remove('active-thumb'));
  document.querySelector('.room-thumb-me')?.classList.add('active-thumb');
}

function toggleRemoteAudio(socketId,vid,btn){
  remoteAudioMuted[socketId]=!remoteAudioMuted[socketId]; vid.muted=!!remoteAudioMuted[socketId];
  btn.innerHTML=remoteAudioMuted[socketId]?'🔇':'🔊'; btn.classList.toggle('ctrl-active',!!remoteAudioMuted[socketId]);
  showToast(remoteAudioMuted[socketId]?'🔇 Audio muted locally':'🔊 Audio unmuted');
}
function toggleRemoteVideo(socketId,vid,btn){
  remoteVideoOff[socketId]=!remoteVideoOff[socketId]; vid.style.opacity=remoteVideoOff[socketId]?'0':'1';
  btn.innerHTML=remoteVideoOff[socketId]?'🚫':'📷'; btn.classList.toggle('ctrl-active',!!remoteVideoOff[socketId]);
  showToast(remoteVideoOff[socketId]?'📷 Video hidden locally':'📷 Video shown');
}

// ─── Room Chat ────────────────────────────────────────
function addRoomSysMessage(text) {
  const div=document.createElement('div'); div.className='sys-msg'; div.textContent=text;
  roomMessagesContainer.appendChild(div); roomMessagesContainer.scrollTop=roomMessagesContainer.scrollHeight;
}
function addRoomMessage(text,type,from) {
  const wrap=document.createElement('div'); wrap.className=`msg-bubble ${type}`;
  if(from&&type==='received'){const meta=document.createElement('div');meta.className='msg-meta';meta.textContent=from;wrap.appendChild(meta);}
  const body=document.createElement('div'); body.textContent=text; wrap.appendChild(body);
  roomMessagesContainer.appendChild(wrap); roomMessagesContainer.scrollTop=roomMessagesContainer.scrollHeight;
  wrap.style.cssText=`opacity:0;transform:translateX(${type==='sent'?'10px':'-10px'})`;
  requestAnimationFrame(()=>{wrap.style.transition='opacity .15s,transform .15s';wrap.style.opacity='1';wrap.style.transform='none';});
}
function sendRoomMessage() {
  const text=roomChatInput.value.trim(); if(!text||!socket)return;
  socket.emit('room_message',{roomId:currentRoomId,text}); addRoomMessage(text,'sent',null); roomChatInput.value='';
}

// ─── Lobby ────────────────────────────────────────────
function updateLobbyUI(members) {
  roomMembers=members; lobbyMemberCount.textContent=members.length;
  const frag=document.createDocumentFragment();
  members.forEach(m=>{
    const pill=document.createElement('div'); pill.className='member-pill';
    pill.innerHTML=`<span class="pill-dot"></span>${m.name}${m.socketId===mySocketId?' (You)':''}`;
    frag.appendChild(pill);
  });
  lobbyMembersList.innerHTML=''; lobbyMembersList.appendChild(frag);
}
function updateRoomMemberCountDisplay() {
  if(roomMemberCountDisplay) roomMemberCountDisplay.textContent=roomMembers.length;
  if(lobbyMemberCount) lobbyMemberCount.textContent=roomMembers.length;
}

// ─── Enter room chat screen ───────────────────────────
async function enterRoomChat(isRejoin) {
  await getLocalMedia();
  roomIdDisplay.textContent = currentRoomId;
  showScreen('roomChat');
  buildRoomVideoLayout();
  reassignStreams();
  updateRoomMemberCountDisplay();
  addRoomSysMessage(isRejoin ? 'Reconnected! Establishing connections…' : 'Session started! Establishing connections…');
}

// ─── Socket ───────────────────────────────────────────
function initSocket() {
  if (socket?.connected) return;
  socket = io({
    transports: ['websocket'],
    upgrade: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 500,
    reconnectionDelayMax: 3000,
    timeout: 8000,
  });

  socket.on('connect', () => {
    mySocketId = socket.id;
    console.log('[SOCKET] Connected:', socket.id);
    if (socket._pendingAction) { socket._pendingAction(); socket._pendingAction = null; }
  });

  socket.on('disconnect', () => showToast('⚠ Server connection lost'));

  socket.on('online_count', count => {
    Object.values(onlineCountEls).forEach(el => { if(el) el.textContent=count; });
  });

  // ── Stranger ──
  socket.on('waiting', () => console.log('[SOCKET] In queue'));

  socket.on('matched', async ({ partnerName, initiator }) => {
    partnerNameDisplay.textContent = partnerName.toUpperCase();
    clearMessages(); addSysMessage(`Connected to ${partnerName}. Say hello!`);
    showScreen('chat');
    await startCall(initiator);
  });

  socket.on('webrtc_offer', async ({ offer }) => {
    if (!peerConnection) createPeerConnection();
    try {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
      await flushIceQueue('_stranger', peerConnection);
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      socket.emit('webrtc_answer', { answer });
    } catch(e) { console.error('[WebRTC] answer error:', e); }
  });

  socket.on('webrtc_answer', async ({ answer }) => {
    if (!peerConnection) return;
    try {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
      await flushIceQueue('_stranger', peerConnection);
    } catch(e) { console.error('[WebRTC] set answer error:', e); }
  });

  socket.on('webrtc_ice', async ({ candidate }) => {
    if (!peerConnection) return;
    if (!peerConnection.remoteDescription) { enqueueIce('_stranger', candidate); return; }
    try { await peerConnection.addIceCandidate(new RTCIceCandidate(candidate)); } catch(e){}
  });

  socket.on('chat_message', ({ from, text }) => addMessage(text, 'received', from));
  socket.on('partner_left', () => { closePeerConnection(); addSysMessage('Stranger has disconnected.'); showModal(); });

  // ── Room ──────────────────────────────────────────────────────────────────

  socket.on('room_created', ({ roomId, name, members }) => {
    currentRoomId=roomId; myName=name; roomMembers=members; mySocketId=socket.id;
    lobbyRoomId.textContent=roomId; updateLobbyUI(members);
    showScreen('roomLobby'); showToast(`✓ Room ${roomId} created!`);
  });

  socket.on('room_joined', ({ roomId, name, members, started }) => {
    currentRoomId=roomId; myName=name; roomMembers=members; mySocketId=socket.id;
    lobbyRoomId.textContent=roomId;
    if (started) {
      // Session is already running — go to chat screen
      // Server will send rtc_connect events to pair us with everyone
      showToast(`✓ Joined active session in room ${roomId}`);
      closeAllRoomPeers();
      enterRoomChat(true);
      // rtc_connect events will arrive from server shortly
    } else {
      updateLobbyUI(members);
      showScreen('roomLobby');
      showToast(`✓ Joined room ${roomId}`);
    }
  });

  socket.on('room_error', ({ msg }) => showToast('⚠ ' + msg, 3500));

  socket.on('room_member_joined', ({ socketId, name, members, sessionActive }) => {
    roomMembers = members;
    // Update lobby list if in lobby
    if (!screens.roomChat.classList.contains('active')) {
      updateLobbyUI(members);
    } else {
      updateRoomMemberCountDisplay();
      // Rebuild layout to add new member's video box
      scheduleBuildRoomVideoLayout();
    }
    addRoomSysMessage(`${name} joined the room`);
    showToast(`🟢 ${name} joined`);
    // If session active, server already sent rtc_connect to both parties — no action needed here
  });

  socket.on('room_member_left', ({ socketId, name, members }) => {
    roomMembers=members; updateRoomMemberCountDisplay();
    addRoomSysMessage(`${name} left the room`); showToast(`🔴 ${name} left`);
    closeRoomPC(socketId);
    const box=$(`rbox-${socketId}`)||$(`rthumb-${socketId}`); if(box) box.remove();
    scheduleBuildRoomVideoLayout();
  });

  // ── room_session_started: ALL clients enter chat screen ──────────────────
  socket.on('room_session_started', async ({ members }) => {
    console.log('[Room] room_session_started received');
    roomMembers = members; mySocketId = socket.id;
    closeAllRoomPeers();
    await enterRoomChat(false);
    // rtc_connect events will arrive right after this from server
  });

  // ── THE KEY EVENT: server tells exactly who connects to whom ─────────────
  socket.on('rtc_connect', async ({ peerId, initiator }) => {
    console.log(`[Room] rtc_connect: peer=${peerId} initiator=${initiator}`);
    await handleRtcConnect(peerId, initiator);
  });

  // ── Room signaling ────────────────────────────────────────────────────────
  socket.on('room_offer', async ({ fromId, offer }) => {
    console.log(`[Room] Got offer from ${fromId}`);
    let pc = roomPeers[fromId];
    // If PC doesn't exist yet, create it (handles timing where offer arrives before rtc_connect)
    if (!pc || pc.signalingState === 'closed') {
      pc = await createRoomPC(fromId);
    }
    if (pc.signalingState !== 'stable') {
      console.warn(`[Room] offer from ${fromId} in state ${pc.signalingState} — creating fresh PC`);
      pc = await createRoomPC(fromId);
    }
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      await flushIceQueue(fromId, pc);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('room_answer', { targetId: fromId, answer: pc.localDescription });
      console.log(`[Room] Sent answer to ${fromId}`);
    } catch(e) { console.error(`[Room] handle offer error from ${fromId}:`, e); }
  });

  socket.on('room_answer', async ({ fromId, answer }) => {
    console.log(`[Room] Got answer from ${fromId}`);
    const pc = roomPeers[fromId];
    if (!pc) { console.warn(`[Room] no PC for ${fromId} on answer`); return; }
    if (pc.signalingState !== 'have-local-offer') {
      console.warn(`[Room] ignoring answer from ${fromId} in state ${pc.signalingState}`); return;
    }
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
      await flushIceQueue(fromId, pc);
    } catch(e) { console.error(`[Room] set answer error from ${fromId}:`, e); }
  });

  socket.on('room_ice', async ({ fromId, candidate }) => {
    const pc = roomPeers[fromId];
    if (!pc || !pc.remoteDescription) { enqueueIce(fromId, candidate); return; }
    try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch(e){}
  });

  socket.on('room_message', ({ from, text }) => addRoomMessage(text, 'received', from));

  socket.on('room_member_media', ({ socketId, audioMuted, videoOff }) => {
    const box=$(`rbox-${socketId}`)||$(`rthumb-${socketId}`);
    if(box){box.classList.toggle('remote-audio-muted',!!audioMuted);box.classList.toggle('remote-video-off',!!videoOff);}
  });

  socket.on('room_force_muted', ({ byName, muted }) => {
    if(muted&&!roomMuted) toggleRoomMute();
    else if(!muted&&roomMuted) toggleRoomMute();
    showToast(`🔕 ${byName} ${muted?'muted':'unmuted'} you for everyone`);
  });

  socket.on('room_closed', ({ msg }) => {
    showToast(`⚠ ${msg}`, 5000); closeAllRoomPeers(); stopLocalMedia();
    if(socket){socket.disconnect();socket=null;}
    currentRoomId=null;roomMembers=[];silenceState={};roomMuted=false;roomCamOff=false;
    showScreen('landing');
  });
}

// ─── Stranger helpers ─────────────────────────────────
function clearMessages() { messagesContainer.innerHTML=''; }
function addSysMessage(text) {
  const div=document.createElement('div'); div.className='sys-msg'; div.textContent=text;
  messagesContainer.appendChild(div); messagesContainer.scrollTop=messagesContainer.scrollHeight;
}
function addMessage(text,type,from) {
  const wrap=document.createElement('div'); wrap.className=`msg-bubble ${type}`;
  if(from&&type==='received'){const meta=document.createElement('div');meta.className='msg-meta';meta.textContent=from;wrap.appendChild(meta);}
  const body=document.createElement('div'); body.textContent=text; wrap.appendChild(body);
  messagesContainer.appendChild(wrap); messagesContainer.scrollTop=messagesContainer.scrollHeight;
  wrap.style.cssText=`opacity:0;transform:translateX(${type==='sent'?'10px':'-10px'})`;
  requestAnimationFrame(()=>{wrap.style.transition='opacity .15s,transform .15s';wrap.style.opacity='1';wrap.style.transform='none';});
}
function sendMessage() {
  const text=chatInput.value.trim(); if(!text||!socket?.connected)return;
  socket.emit('chat_message',{text}); addMessage(text,'sent',null); chatInput.value='';
}

// ─── Modal ────────────────────────────────────────────
function showModal() { modalLeft.style.display='flex'; }
function hideModal() { modalLeft.style.display='none'; }

// ─── Stranger controls ────────────────────────────────
function toggleMute() {
  isMuted=!isMuted; if(localStream) localStream.getAudioTracks().forEach(t=>t.enabled=!isMuted);
  btnMute.classList.toggle('active',isMuted);
  btnMute.querySelector('.icon-unmuted').style.display=isMuted?'none':'block';
  btnMute.querySelector('.icon-muted').style.display=isMuted?'block':'none';
  showToast(isMuted?'🎤 Mic muted':'🎤 Mic on');
}
function toggleCamera() {
  isCamOff=!isCamOff; if(localStream) localStream.getVideoTracks().forEach(t=>t.enabled=!isCamOff);
  btnVideoToggle.classList.toggle('active',isCamOff);
  btnVideoToggle.querySelector('.icon-cam-on').style.display=isCamOff?'none':'block';
  btnVideoToggle.querySelector('.icon-cam-off').style.display=isCamOff?'block':'none';
  showToast(isCamOff?'📷 Camera off':'📷 Camera on');
}
function skipStranger() {
  closePeerConnection(); addSysMessage('Searching for next stranger...');
  socket.emit('skip'); showScreen('waiting');
}
function endSession() {
  closePeerConnection(); stopLocalMedia();
  if(socket){socket.disconnect();socket=null;}
  isMuted=false;isCamOff=false;
  btnMute.classList.remove('active');
  btnMute.querySelector('.icon-unmuted').style.display='block';
  btnMute.querySelector('.icon-muted').style.display='none';
  btnVideoToggle.classList.remove('active');
  btnVideoToggle.querySelector('.icon-cam-on').style.display='block';
  btnVideoToggle.querySelector('.icon-cam-off').style.display='none';
  showScreen('landing');
}

// ─── Room controls ────────────────────────────────────
function toggleRoomMute() {
  roomMuted=!roomMuted; if(localStream) localStream.getAudioTracks().forEach(t=>t.enabled=!roomMuted);
  btnRoomMute.classList.toggle('active',roomMuted);
  btnRoomMute.querySelector('.icon-unmuted').style.display=roomMuted?'none':'block';
  btnRoomMute.querySelector('.icon-muted').style.display=roomMuted?'block':'none';
  socket.emit('room_media_state',{roomId:currentRoomId,audioMuted:roomMuted,videoOff:roomCamOff});
  showToast(roomMuted?'🎤 Mic muted':'🎤 Mic on');
}
function toggleRoomCam() {
  roomCamOff=!roomCamOff; if(localStream) localStream.getVideoTracks().forEach(t=>t.enabled=!roomCamOff);
  btnRoomCam.classList.toggle('active',roomCamOff);
  btnRoomCam.querySelector('.icon-cam-on').style.display=roomCamOff?'none':'block';
  btnRoomCam.querySelector('.icon-cam-off').style.display=roomCamOff?'block':'none';
  socket.emit('room_media_state',{roomId:currentRoomId,audioMuted:roomMuted,videoOff:roomCamOff});
  showToast(roomCamOff?'📷 Camera off':'📷 Camera on');
}
function leaveRoom() {
  closeAllRoomPeers(); stopLocalMedia();
  if(socket){socket.disconnect();socket=null;}
  currentRoomId=null;roomMembers=[];silenceState={};roomMuted=false;roomCamOff=false;
  showScreen('landing');
}

// ─── Flows ────────────────────────────────────────────
async function startStrangerFlow() {
  const rawName=strangerNameInput.value.trim();
  myName=rawName.length>0?rawName.slice(0,24):'Stranger';
  showScreen('waiting'); await getLocalMedia();
  ensureSocket(()=>socket.emit('join_queue',{name:myName}));
}
async function startCreateRoomFlow() {
  const name=createNameInput.value.trim()||'Host';
  const pass=createPassInput.value.trim();
  if(!pass){showToast('⚠ Please set a password for the room');return;}
  await getLocalMedia();
  ensureSocket(()=>socket.emit('create_room',{name,password:pass}));
}
async function startJoinRoomFlow() {
  const name=joinNameInput.value.trim()||'User';
  const roomId=joinRoomIdInput.value.trim();
  const pass=joinPassInput.value.trim();
  if(!roomId||roomId.length!==6){showToast('⚠ Enter a valid 6-digit room ID');return;}
  if(!pass){showToast('⚠ Enter the room password');return;}
  await getLocalMedia();
  ensureSocket(()=>socket.emit('join_room',{roomId,password:pass,name}));
}

function ensureSocket(action) {
  if (!socket?.connected) {
    initSocket();
    if(socket.connected){mySocketId=socket.id;action();}
    else socket.once('connect',()=>{mySocketId=socket.id;action();});
  } else { mySocketId=socket.id; action(); }
}

// ─── Start session (host clicks "Start Session") ─────
async function startRoomSession() {
  await getLocalMedia();
  // Tell server — it will broadcast room_session_started + rtc_connect pairs to everyone
  socket.emit('room_start', { roomId: currentRoomId });
}

// ─── Event listeners ──────────────────────────────────
$('btn-mode-stranger').addEventListener('click',()=>showScreen('nameStranger'));
$('btn-mode-create').addEventListener('click',()=>showScreen('createRoom'));
$('btn-mode-join').addEventListener('click',()=>showScreen('joinRoom'));
$('btn-back-stranger').addEventListener('click',()=>showScreen('landing'));
$('btn-back-create').addEventListener('click',()=>showScreen('landing'));
$('btn-back-join').addEventListener('click',()=>showScreen('landing'));

btnStartStranger.addEventListener('click',startStrangerFlow);
strangerNameInput.addEventListener('keydown',e=>{if(e.key==='Enter')startStrangerFlow();});

$('btn-do-create-room').addEventListener('click',startCreateRoomFlow);
$('btn-do-join-room').addEventListener('click',startJoinRoomFlow);
joinRoomIdInput.addEventListener('input',e=>{e.target.value=e.target.value.replace(/\D/g,'').slice(0,6);});

btnStartRoom.addEventListener('click',startRoomSession);
$('btn-cancel-room').addEventListener('click',leaveRoom);
$('btn-copy-room-id').addEventListener('click',()=>{
  navigator.clipboard.writeText(lobbyRoomId.textContent)
    .then(()=>showToast('✓ Room ID copied!'))
    .catch(()=>showToast('Room ID: '+lobbyRoomId.textContent));
});

btnCancelWait.addEventListener('click',()=>{endSession();showScreen('landing');});
btnMute.addEventListener('click',toggleMute);
btnVideoToggle.addEventListener('click',toggleCamera);
btnSkip.addEventListener('click',skipStranger);
btnEnd.addEventListener('click',endSession);
btnSend.addEventListener('click',sendMessage);
chatInput.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMessage();}});

btnRoomMute.addEventListener('click',toggleRoomMute);
btnRoomCam.addEventListener('click',toggleRoomCam);
btnRoomLeave.addEventListener('click',leaveRoom);
btnRoomSend.addEventListener('click',sendRoomMessage);
roomChatInput.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendRoomMessage();}});

$('modal-next').addEventListener('click',()=>{
  hideModal();closePeerConnection();showScreen('waiting');
  if(socket?.connected) socket.emit('join_queue',{name:myName});
  else{initSocket();socket.once('connect',()=>{mySocketId=socket.id;socket.emit('join_queue',{name:myName});});}
});
$('modal-home').addEventListener('click',()=>{hideModal();endSession();});

window.addEventListener('popstate',e=>e.preventDefault());
showScreen('landing');
