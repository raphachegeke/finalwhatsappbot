// index.js
// FinalWhatsAppBot - upgraded version
// Features:
// - QR in browser (auto-refresh)
// - Persistent session (./.auth)
// - Auto-save view-once media + forward to owner
// - Auto-typing ON/OFF (no replies)
// - Auto-view status + emoji reactions
// - Anti-delete (sends deleted messages to owner)
// - Auto-restart & crash protection
// - Owner-only commands (owner: 254748397839)
// - Welcome message for new chats (persisted)

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
  if (!latestQR) return res.send(`<html><body><h2>Waiting for QR...</h2></body></html>`);
  const dataUrl = await qrcode.toDataURL(latestQR);
  res.send(`<html><body><h2>Scan QR</h2><img src="${dataUrl}"/></body></html>`);
});

app.listen(PORT, () => console.log(`Server running on port ${PORT} — QR Page -> http://localhost:${PORT}/qr`));

let welcomeSeen = loadJSON(WELCOME_DB);
let deletedMessagesLog = loadJSON(DELETED_DB);

async function startBot() {
  if (restarting) return;
  restarting = true;
  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_PATH);
    const sock = makeWASocket({ auth: state, logger: P({ level: 'silent' }) });
    currentSock = sock;
    restarting = false;

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
      if (qr) latestQR = qr;
      if (connection === 'open') latestQR = '';
      if (connection === 'close') {
        const shouldReconnect = lastDisconnect?.error instanceof Boom &&
          lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut;
        if (shouldReconnect) { cleanupSock(); setTimeout(startBot, 2000); }
      }
    });

    const ensurePresence = async (jid) => { try { await sock.presenceSubscribe(jid); } catch {} };

    sock.ev.on('messages.upsert', async (m) => {
      if (!m.messages || !m.messages.length) return;
      const msg = m.messages[0];
      if (msg.key.fromMe || !msg.message) return;

      const sender = msg.key.remoteJid;
      const from = msg.key.participant || msg.key.remoteJid;
      const normalizedSender = jidNormalizedUser(from);

      const body = msg.message.conversation ||
                   msg.message.extendedTextMessage?.text ||
                   msg.message.imageMessage?.caption ||
                   msg.message.videoMessage?.caption || '';

      // OWNER COMMANDS
      if (normalizedSender === OWNER_JID) {
        const cmd = body.trim().toLowerCase();
        if (cmd in ownerCommands) {
          const reply = ownerCommands[cmd]();
          try { await sock.sendMessage(sender, { text: `[owner] ${reply}` }); } catch {}
          return;
        }
      }

      // WELCOME MESSAGE
      if (!welcomeSeen.includes(sender)) {
        const welcomeTxt = 'Hey! I saw your message 👋\nThis is an automated bot. No replies are sent except by owner.';
        try { await sock.sendMessage(sender, { text: welcomeTxt }); } catch {}
        welcomeSeen.push(sender); saveJSON(WELCOME_DB, welcomeSeen);
      }

      // AUTOTYPING
      if (autotyping) {
        await ensurePresence(sender);
        try { await sock.sendPresenceUpdate('composing', sender); await new Promise(r => setTimeout(r, 1200)); await sock.sendPresenceUpdate('paused', sender); } catch {}
      }

      // AUTO-SAVE VIEW-ONCE & FORWARD TO OWNER
      try {
        const im = msg.message.imageMessage;
        const vm = msg.message.videoMessage;
        const doc = msg.message.documentMessage;
        const viewOnce = msg.message.viewOnceMessage || (im?.viewOnce) || (vm?.viewOnce);

        if (viewOnce || msg.message?.viewOnceMessage) {
          try {
            const buffer = await downloadMediaMessage(msg.message, 'buffer', {}, { logger: P({ level: 'silent' }) });
            let ext = 'dat'; if (im) ext = 'jpg'; if (vm) ext = 'mp4'; if (doc) ext = doc.mimetype?.split('/')[1] || 'bin';
            const filename = path.join(MEDIA_DIR, `viewonce_${Date.now()}.${ext}`);
            fs.writeFileSync(filename, buffer);
            console.log('Saved view-once media to', filename);
            // forward to owner
            await sock.sendMessage(OWNER_JID, { [im ? 'image' : vm ? 'video' : 'document']: { url: filename } });
          } catch (err) { console.log('View-once save/forward error:', err?.message || err); }
        }
      } catch {}

      // AUTO-VIEW STATUS + EMOJI
      if (msg.key.remoteJid === 'status@broadcast') {
        try {
          await sock.readMessages([msg.key]);
          const statusSender = msg.key.participant || msg.key.remoteJid;
          const emoji = EMOJIS[Math.floor(Math.random() * EMOJIS.length)];
          try { await sock.sendMessage(statusSender, { react: { text: emoji, key: msg.key } }); } catch {}
        } catch {}
        return;
      }

    });

    // ANTI-DELETE & FORWARD TO OWNER
    sock.ev.on('messages.update', async (updates) => {
      try {
        for (const upd of updates) {
          let deletedKey = upd.key || upd.message?.protocolMessage?.key;
          if (!deletedKey) continue;

          let record = { key: deletedKey, time: new Date().toISOString() };
          deletedMessagesLog.push(record); saveJSON(DELETED_DB, deletedMessagesLog);

          // Forward original message to owner
          try {
            const origMsg = upd.message?.message || upd.message?.protocolMessage?.key;
            if (upd.message?.message) await sock.sendMessage(OWNER_JID, { text: `🛑 Deleted message detected from ${jidNormalizedUser(deletedKey.participant || deletedKey.remoteJid)}: ${JSON.stringify(upd.message)}` });
          } catch {}
        }
      } catch (e) { console.error('messages.update err:', e); }
    });

    process.removeAllListeners('unhandledRejection');
    process.removeAllListeners('uncaughtException');
    process.on('unhandledRejection', (r) => { console.error('UnhandledRejection:', r); safeRestart(); });
    process.on('uncaughtException', (e) => { console.error('UncaughtException:', e); safeRestart(); });

  } catch (err) { console.error('startBot error:', err); restarting = false; setTimeout(startBot, 2000); }
}

function cleanupSock() {
  try {
    if (currentSock) { try { currentSock.ev.removeAllListeners(); } catch {} try { currentSock.ws?.close(); } catch {} try { currentSock.end?.(); } catch {} }
  } catch {} currentSock = null;
}

function safeRestart() { if (restarting) return; restarting = true; cleanupSock(); setTimeout(() => { restarting = false; startBot().catch(e => setTimeout(startBot,3000)); }, 2000); }

startBot().catch(err => { console.error('Initial bot start error:', err); setTimeout(startBot, 2000); });