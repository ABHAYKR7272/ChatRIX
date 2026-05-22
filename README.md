# CHAT-RIX 🔥
### Random Video & Text Chat Platform — Cyber RGB Edition

---

## 🚀 LOCAL SETUP (2 minutes)

```bash
# 1. Install dependencies
npm install

# 2. Start server
npm start

# 3. Open in browser
http://localhost:3000
```

For development with auto-restart:
```bash
npm run dev
```

---

## 🌐 FREE DEPLOYMENT OPTIONS

### Option 1: Render.com (RECOMMENDED — Free forever)
1. Push this folder to a GitHub repo
2. Go to [render.com](https://render.com) → New → Web Service
3. Connect your GitHub repo
4. Settings:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Environment:** Node
5. Click **Deploy** → Get your live URL!

### Option 2: Railway.app
1. Go to [railway.app](https://railway.app)
2. New Project → Deploy from GitHub repo
3. It auto-detects Node.js → Deploy!

### Option 3: Fly.io (Free tier)
```bash
npm install -g flyctl
fly auth login
fly launch
fly deploy
```

### Option 4: Glitch.com (Instant — no account needed)
1. Go to [glitch.com](https://glitch.com) → New Project → Import from GitHub
2. Paste your repo URL → Done!

---

## 📁 PROJECT STRUCTURE

```
chat-rix/
├── server.js          # Node.js + Express + Socket.io backend
├── package.json       # Dependencies
├── README.md          # This file
└── public/
    ├── index.html     # Main UI (all screens)
    ├── css/
    │   └── style.css  # Cyber RGB stylesheet
    └── js/
        └── app.js     # WebRTC + Socket.io client logic
```

---

## ⚙️ HOW IT WORKS

```
User A enters name → gets local camera/mic
       ↓
Socket.io connects → joins waiting queue
       ↓
Server finds User B → sends 'matched' event to both
       ↓
User A (initiator) creates WebRTC offer → sends via socket
       ↓
User B receives offer → creates answer → sends back
       ↓
ICE candidates exchanged → P2P video established
       ↓
Text messages routed through server (Socket.io)
```

---

## 🔧 ENVIRONMENT VARIABLES

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT`   | `3000`  | Server port |

For production, set `PORT` via your hosting platform's env settings.

---

## 🎮 FEATURES

- ✅ Random stranger matching (queue-based)
- ✅ P2P video via WebRTC (no bandwidth cost)
- ✅ Real-time text chat via Socket.io
- ✅ Mute / Unmute microphone
- ✅ Camera On / Off toggle
- ✅ Skip to next stranger
- ✅ Disconnect / End session
- ✅ Live online user count
- ✅ Cyber RGB UI with particle effects
- ✅ Fully responsive (mobile + desktop)
- ✅ No database required
- ✅ 100% free stack

---

## 📱 BROWSER SUPPORT

| Browser | Support |
|---------|---------|
| Chrome 80+ | ✅ Full |
| Firefox 78+ | ✅ Full |
| Safari 14+ | ✅ Full |
| Edge 80+ | ✅ Full |
| Mobile Chrome | ✅ Full |
| Mobile Safari | ✅ Full |

> **Note:** HTTPS is required for camera/mic access in production.
> All the free hosting options above (Render, Railway, Fly.io) provide HTTPS automatically.

---

## 🛠️ TECH STACK

- **Backend:** Node.js + Express + Socket.io
- **Frontend:** Vanilla HTML/CSS/JS (no framework)
- **Video:** WebRTC (browser-native, P2P)
- **Signaling:** Socket.io WebSocket
- **STUN/TURN:** Google STUN + OpenRelay TURN (free)
- **Fonts:** Google Fonts (Orbitron, Share Tech Mono, Rajdhani)

---

*Built with ❤️ — Chat-Rix v1.0*
