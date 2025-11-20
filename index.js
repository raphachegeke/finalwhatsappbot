// index.js
// FinalWhatsAppBot - patched for owner inbox forwarding
// Features unchanged, plus:
// - Deleted messages sent to owner inbox
// - View-once media sent to owner inbox

import express from 'express';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  jidNormalizedUser
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import P from 'pino';
import qrcode from 'qrcode';
import fs from 'fs';
import path from 'path';

const AUTH_PATH = './.auth';
const PORT = process.env.PORT || 3000;
const OWNER_NUMBER = '254748397839';
const OWNER_JID = `${OWNER_NUMBER}@s.whatsapp.net`;
const MEDIA_DIR = './media';
const DATA_DIR = './data';
const WELCOME_DB = path.join(DATA_DIR, 'welcome_seen.json');
const DELETED_DB = path.join(DATA_DIR, 'deleted_messages.json');

if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(WELCOME_DB)) fs.writeFileSync(WELCOME_DB, JSON.stringify([]));
if (!fs.existsSync(DELETED_DB)) fs.writeFileSync(DELETED_DB, JSON.stringify([]));

let latestQR = '';
let currentSock = null;
let restarting = false;
let autotyping = true;

let ownerCommands = {
  '/autotyping on': () => { autotyping = true; return 'Autotyping ENABLED'; },
  '/autotyping off': () => { autotyping = false; return 'Autotyping DISABLED'; },
  '/status react': () => { return 'Status reaction: enabled (random emoji)'; },
};

const loadJSON = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const saveJSON = (p, data) => fs.writeFileSync(p, JSON.stringify(data, null, 2));
const EMOJIS = ['❤️','🔥','👍','😂','👏','😍','🎉'];

const app = express();
app.get('/', (req, res) => res.send('WhatsApp Bot running. Visit /qr'));
app.get('/qr', async (req, res) => {
  if (!latestQR) return res.send(`<html><body style="background:#0f1724;color:#e2e8f0;font-family:Inter,system-ui,Arial,Helvetica,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;"><h2>Waiting for QR...</h2><p>Keep this page open — it auto-refreshes.</p><script>setTimeout(() => location.reload(), 2500)</script></body></html>`);
  const dataUrl = await qrcode.toDataURL(latestQR);
  res.send(`<html><body style="background:#0f1724;color:#e2e8f0;font-family:Inter,system-ui,Arial,Helvetica,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;"><h2 style="margin-bottom:12px">Scan QR to login WhatsApp Bot</h2><img src="${dataUrl}" style="width:320px;height:320px;border-radius:12px;border:6px solid #0b1220;box-shadow:0 6px 24px rgba(2,6,23,0.6)"/><p style="margin-top:12px">Auto-refreshing...</p><script>setTimeout(() => location.reload(), 2500)</script></body></html>`);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} — QR Page -> http://localhost:${PORT}/qr`);
});

let welcomeSeen = loadJSON(WELCOME_DB);
let deletedMessagesLog = loadJSON(DELETED_DB);

async function startBot() {
  if (restarting) return;
  restarting = true;
  try {
    console.log('Starting bot...');
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_PATH);

    const sock = makeWASocket({ auth: state, logger: P({ level: 'silent' }) });
    currentSock = sock;
    restarting = false;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) { latestQR = qr; console.log('New QR received — open /qr in browser'); }
      if (connection === 'open') { latestQR = ''; console.log('Bot connection open'); }
      if (connection === 'close') {
        const shouldReconnect = (lastDisconnect?.error instanceof Boom)
          && lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut;
        console.log('Connection closed — reconnect?', shouldReconnect);
        if (shouldReconnect) { cleanupSock(); setTimeout(startBot, 2000); } else console.log('Logged out. Remove .auth folder and rescan.');
      }
    });

    const ensurePresence = async (jid) => {
      try { await sock.presenceSubscribe(jid); } catch {}
    };

    sock.ev.on('messages.upsert', async (m) => {
      try {
        if (!m.messages || m.messages.length === 0) return;
        const msg = m.messages[0];
        if (msg.key.fromMe || !msg.message) return;

        const sender = msg.key.remoteJid;
        const from = msg.key.participant || msg.key.remoteJid;
        const normalizedSender = jidNormalizedUser(from);

        const body = (msg.message.conversation) ||
                     (msg.message.extendedTextMessage?.text) ||
                     (msg.message?.imageMessage?.caption) ||
                     (msg.message?.videoMessage?.caption) || '';

        // --- OWNER COMMANDS ---
        if (normalizedSender === OWNER_JID) {
          const cmd = body.trim().toLowerCase();
          if (cmd in ownerCommands) {
            const reply = ownerCommands[cmd]();
            try { await sock.sendMessage(sender, { text: `[owner] ${reply}` }); } catch {}
            return;
          }
        }

        // --- WELCOME MESSAGE ---
        if (!welcomeSeen.includes(sender)) {
          const welcomeTxt = 'Hey! I saw your message 👋\nThis is an automated bot. No replies are sent except by owner.';
          try { await sock.sendMessage(sender, { text: welcomeTxt }); } catch {}
          welcomeSeen.push(sender);
          saveJSON(WELCOME_DB, welcomeSeen);
        }

        // --- AUTOTYPING ---
        if (autotyping) {
          await ensurePresence(sender);
          try {
            await sock.sendPresenceUpdate('composing', sender);
            await new Promise(r => setTimeout(r, 1200));
            await sock.sendPresenceUpdate('paused', sender);
          } catch {}
        }

        // --- AUTO-SAVE VIEW-ONCE MEDIA + SEND TO OWNER ---
        try {
          const im = msg.message.imageMessage;
          const vm = msg.message.videoMessage;
          const doc = msg.message.documentMessage;
          const viewOnce = msg.message.viewOnceMessage || (im?.viewOnce) || (vm?.viewOnce);

          if (viewOnce || msg.message?.viewOnceMessage) {
            const buffer = await downloadMediaMessage(msg.message, 'buffer', {}, { logger: P({ level: 'silent' }) });
            let ext = 'dat';
            if (im) ext = 'jpg';
            if (vm) ext = 'mp4';
            if (doc) ext = doc.mimetype?.split('/')[1] || 'bin';
            const filename = path.join(MEDIA_DIR, `viewonce_${Date.now()}.${ext}`);
            fs.writeFileSync(filename, buffer);
            console.log('Saved view-once media to', filename);

            // send to owner
            await sock.sendMessage(OWNER_JID, { 
              text: `👁️‍🗨️ View-Once media received from ${sender}`, 
              contextInfo: { externalAdReply: { showAdAttribution: true } } 
            });
            await sock.sendMessage(OWNER_JID, { [im ? 'image' : vm ? 'video' : 'document']: { url: filename } });
          }
        } catch {}

        // --- AUTO-VIEW STATUS ---
        if (msg.key.remoteJid === 'status@broadcast') {
          try {
            await sock.readMessages([msg.key]);
            const statusSender = msg.key.participant || msg.key.remoteJid;
            const emoji = EMOJIS[Math.floor(Math.random() * EMOJIS.length)];
            try { await sock.sendMessage(statusSender, { react: { text: emoji, key: msg.key } }); } catch {}
          } catch {}
          return;
        }

      } catch (e) { console.error('messages.upsert handler err:', e); }
    });

    // ---------- MESSAGE INFO UPDATE ----------
    sock.ev.on('message-info.update', async (updates) => {
      try {
        if (!updates) return;
        const list = Array.isArray(updates) ? updates : [updates];
        for (const u of list) {
          if (u.key?.remoteJid === 'status@broadcast') {
            try {
              await sock.readMessages([u.key]);
              const emoji = EMOJIS[Math.floor(Math.random() * EMOJIS.length)];
              try { await sock.sendMessage(u.key.participant || u.key.remoteJid, { react: { text: emoji, key: u.key } }); } catch {}
            } catch {}
          }
        }
      } catch {}
    });

    // ---------- ANTI-DELETE + FORWARD TO OWNER ----------
    sock.ev.on('messages.update', async (updates) => {
      try {
        for (const upd of updates) {
          if (upd?.update?.revoked || upd?.message?.protocolMessage?.type === 0) {
            const delKey = upd.key || upd.message.protocolMessage.key;
            const record = { key: delKey, notice: 'message deleted (captured)', time: new Date().toISOString() };
            deletedMessagesLog.push(record);
            saveJSON(DELETED_DB, deletedMessagesLog);
            console.log('Anti-delete: logged', delKey);

            // fetch original message content if available
            const originalMsg = upd.message?.conversation || upd.message?.extendedTextMessage?.text || '';
            await sock.sendMessage(OWNER_JID, { text: `🛑 Deleted message from ${delKey.remoteJid || 'unknown'}:\n${originalMsg}` });
          }
        }
      } catch (e) { console.error('messages.update handler err:', e); }
    });

    // ---------- CRASH PROTECTION ----------
    process.removeAllListeners('unhandledRejection');
    process.removeAllListeners('uncaughtException');
    process.on('unhandledRejection', (reason) => { console.error('Unhandled Rejection:', reason); safeRestart(); });
    process.on('uncaughtException', (err) => { console.error('Uncaught Exception:', err); safeRestart(); });

  } catch (err) { console.error('startBot error:', err); restarting = false; setTimeout(startBot, 2000); }
}

function cleanupSock() {
  try {
    if (currentSock && typeof currentSock === 'object') {
      try { currentSock.ev.removeAllListeners(); } catch {}
      try { currentSock.ws?.close(); } catch {}
      try { currentSock.end?.(); } catch {}
    }
  } catch {}
  currentSock = null;
}

function safeRestart() {
  if (restarting) return;
  console.log('Attempting safe restart...');
  restarting = true;
  try { cleanupSock(); } catch {}
  setTimeout(() => {
    restarting = false;
    startBot().catch(e => { console.error('Restart failed:', e); setTimeout(startBot, 3000); });
  }, 2000);
}

startBot().catch(err => { console.error('Initial bot start error:', err); setTimeout(startBot, 2000); });