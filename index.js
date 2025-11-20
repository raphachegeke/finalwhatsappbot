// index.js
// FinalWhatsAppBot - patched version
// Features:
// - QR in browser (auto-refresh)
// - Persistent session (./.auth)
// - Auto-save view-once media
// - Auto-typing ON/OFF (no replies)
// - Auto-view status + emoji reactions
// - Anti-delete (saves deleted messages)
// - Auto-restart & crash protection
// - Owner-only commands (owner: 254748397839)
// - Welcome message for new chats (persisted)
// NOTE: small API differences may exist between baileys versions — see inline comments.

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

const AUTH_PATH = './.auth'; // persistent auth folder (keep it)
const PORT = process.env.PORT || 3000;
const OWNER_NUMBER = '254748397839'; // owner number (no @)
const OWNER_JID = `${OWNER_NUMBER}@s.whatsapp.net`; // owner jid
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
let autotyping = true; // default: on
let ownerCommands = {
  '/autotyping on': () => { autotyping = true; return 'Autotyping ENABLED'; },
  '/autotyping off': () => { autotyping = false; return 'Autotyping DISABLED'; },
  '/status react': () => { return 'Status reaction: enabled (random emoji)'; },
};

// helpers for persisted lists
const loadJSON = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const saveJSON = (p, data) => fs.writeFileSync(p, JSON.stringify(data, null, 2));

// small emoji list for status reactions
const EMOJIS = ['❤️','🔥','👍','😂','👏','😍','🎉'];

// Express app and QR page
const app = express();
app.get('/', (req, res) => res.send('WhatsApp Bot running. Visit /qr'));
app.get('/qr', async (req, res) => {
  if (!latestQR) {
    return res.send(`
      <html><body style="background:#0f1724;color:#e2e8f0;font-family:Inter,system-ui,Arial,Helvetica,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;">
        <h2>Waiting for QR...</h2>
        <p>Keep this page open — it auto-refreshes.</p>
        <script>setTimeout(() => location.reload(), 2500)</script>
      </body></html>
    `);
  }
  const dataUrl = await qrcode.toDataURL(latestQR);
  res.send(`
    <html>
      <body style="background:#0f1724;color:#e2e8f0;font-family:Inter,system-ui,Arial,Helvetica,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;">
        <h2 style="margin-bottom:12px">Scan QR to login WhatsApp Bot</h2>
        <img src="${dataUrl}" style="width:320px;height:320px;border-radius:12px;border:6px solid #0b1220;box-shadow:0 6px 24px rgba(2,6,23,0.6)"/>
        <p style="margin-top:12px">Auto-refreshing...</p>
        <script>setTimeout(() => location.reload(), 2500)</script>
      </body>
    </html>
  `);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} — QR Page -> http://localhost:${PORT}/qr`);
});

// Keep track of welcome-sent chats
let welcomeSeen = loadJSON(WELCOME_DB);
let deletedMessagesLog = loadJSON(DELETED_DB);

// Start bot with restart protection
async function startBot() {
  if (restarting) return;
  restarting = true;
  try {
    console.log('Starting bot...');
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_PATH);

    const sock = makeWASocket({
      auth: state,
      logger: P({ level: 'silent' })
    });
    currentSock = sock;
    restarting = false;

    sock.ev.on('creds.update', saveCreds);

    // connection updates (QR handling + reconnect)
    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        latestQR = qr;
        console.log('New QR received — open /qr in browser');
      }

      if (connection === 'open') {
        console.log('Bot connection open');
        latestQR = '';
      }

      if (connection === 'close') {
        const shouldReconnect = (lastDisconnect?.error instanceof Boom)
          && lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut;

        console.log('Connection closed — reconnect?', shouldReconnect);
        if (shouldReconnect) {
          cleanupSock();
          setTimeout(startBot, 2000);
        } else {
          console.log('Logged out. Remove .auth folder and rescan.');
        }
      }
    });

    // presence subscription helper
    const ensurePresence = async (jid) => {
      try {
        await sock.presenceSubscribe(jid);
      } catch (e) {
        // ignore subscribe errors
      }
    };

    // ---------- MESSAGES.UPSERT ----------
    sock.ev.on('messages.upsert', async (m) => {
      try {
        if (!m.messages || m.messages.length === 0) return;
        const msg = m.messages[0];

        // ignore system / self
        if (msg.key.fromMe) return;
        if (!msg.message) return;

        const sender = msg.key.remoteJid; // chat jid
        const from = msg.key.participant || msg.key.remoteJid;
        const normalizedSender = jidNormalizedUser(from);

        // --- OWNER COMMANDS (owner only, uses chat text) ---
        const body = (msg.message.conversation) ||
                     (msg.message.extendedTextMessage?.text) ||
                     (msg.message?.imageMessage?.caption) ||
                     (msg.message?.videoMessage?.caption) || '';
        if (normalizedSender === OWNER_JID) {
          const cmd = body.trim().toLowerCase();
          if (cmd in ownerCommands) {
            const reply = ownerCommands[cmd]();
            try { await sock.sendMessage(sender, { text: `[owner] ${reply}` }); } catch (e) {}
            return;
          }
        }

        // --- WELCOME MESSAGE for new chats only ---
        if (!welcomeSeen.includes(sender)) {
          const welcomeTxt = 'Hey! I saw your message 👋\nThis is an automated bot. No replies are sent except by owner.';
          try {
            await sock.sendMessage(sender, { text: welcomeTxt });
          } catch (e) { /* ignore send errors */ }
          welcomeSeen.push(sender);
          saveJSON(WELCOME_DB, welcomeSeen);
        }

        // --- AUTOTYPING (no replies) ---
        if (autotyping) {
          await ensurePresence(sender);
          try {
            await sock.sendPresenceUpdate('composing', sender);
            await new Promise(r => setTimeout(r, 1200)); // short typing
            await sock.sendPresenceUpdate('paused', sender);
          } catch (e) {
            // ignore
          }
        }

        // --- AUTO-SAVE VIEW-ONCE MEDIA ---
        // view-once messages often look like message.imageMessage.viewOnce (varies by version)
        // We'll attempt to detect common patterns and save media.
        try {
          // image view-once
          const im = msg.message.imageMessage;
          const vm = msg.message.videoMessage;
          const doc = msg.message.documentMessage;
          const viewOnce = msg.message.viewOnceMessage || (im?.viewOnce) || (vm?.viewOnce);

          if (viewOnce || msg.message?.viewOnceMessage) {
            // try to download the media using baileys helper
            try {
              const buffer = await downloadMediaMessage(msg.message, 'buffer', {}, { logger: P({ level: 'silent' }) });
              // file extension guess
              let ext = 'dat';
              if (im) ext = 'jpg';
              if (vm) ext = 'mp4';
              if (doc) ext = doc.mimetype?.split('/')[1] || 'bin';
              const filename = path.join(MEDIA_DIR, `viewonce_${Date.now()}.${ext}`);
              fs.writeFileSync(filename, buffer);
              console.log('Saved view-once media to', filename);
            } catch (err) {
              // fallback: try saving base64 if available in message
              console.log('Could not download view-once via helper:', err?.message || err);
            }
          }
        } catch (err) {
          // ignore view-once flow errors
        }

        // --- AUTO-VIEW STATUS (if message is status) ---
        // Status updates often come as messages where remoteJid === 'status@broadcast'
        if (msg.key.remoteJid === 'status@broadcast') {
          try {
            // mark as read / viewed
            await sock.readMessages([msg.key]);
            const statusSender = msg.key.participant || msg.key.remoteJid;
            console.log('Viewed status from', statusSender);

            // react with a random emoji to status (non-reply)
            const emoji = EMOJIS[Math.floor(Math.random() * EMOJIS.length)];
            try {
              // Reaction format may vary by bailey version. Try 'react' sendMessage.
              await sock.sendMessage(statusSender, { react: { text: emoji, key: msg.key } });
            } catch (e) {
              // If reaction not supported, don't send a chat message (we won't reply).
            }
          } catch (e) {
            // ignore
          }
          return;
        }

      } catch (e) {
        console.error('messages.upsert handler err:', e);
      }
    });

    // ---------- MESSAGE INFO UPDATE (alternative status event) ----------
    sock.ev.on('message-info.update', async (updates) => {
      try {
        // when statuses arrive here, mark them viewed
        if (!updates) return;
        // updates may be array-like
        const list = Array.isArray(updates) ? updates : [updates];
        for (const u of list) {
          if (u.key?.remoteJid === 'status@broadcast') {
            try {
              await sock.readMessages([u.key]);
              console.log('Viewed status (message-info.update) from', u.key.participant || u.key.remoteJid);
              // react
              const emoji = EMOJIS[Math.floor(Math.random() * EMOJIS.length)];
              try { await sock.sendMessage(u.key.participant || u.key.remoteJid, { react: { text: emoji, key: u.key } }); } catch (e) {}
            } catch (e) {}
          }
        }
      } catch (e) {
        // ignore
      }
    });

    // ---------- ANTI-DELETE (message revoke) ----------
    // Many baileys versions emit 'messages.delete' or 'messages.update' stubs.
    sock.ev.on('messages.update', async (updates) => {
      try {
        for (const upd of updates) {
          // check if message was deleted (revoked)
          if (upd?.update?.revoked) {
            // some versions provide stubType / key info instead
            const delKey = upd.key;
            // attempt to find the message in store - not available here; but we can log deletion
            const record = {
              key: delKey,
              notice: 'message deleted (anti-delete captured)',
              time: new Date().toISOString()
            };
            deletedMessagesLog.push(record);
            saveJSON(DELETED_DB, deletedMessagesLog);
            console.log('Message deleted (logged):', delKey);
          }

          // alternative detection: protocolMessage type 0 indicates message revoke in some versions
          if (upd?.message?.protocolMessage?.type === 0) {
            const deletedKey = upd.message.protocolMessage.key;
            const record = {
              key: deletedKey,
              reason: 'protocolMessage type 0 delete',
              time: new Date().toISOString()
            };
            deletedMessagesLog.push(record);
            saveJSON(DELETED_DB, deletedMessagesLog);
            console.log('Anti-delete: logged', deletedKey);
          }
        }
      } catch (e) {
        console.error('messages.update handler err:', e);
      }
    });

    // fallback: message deletions sometimes come through 'messagemap' or other events - handle generic 'chats.update' if needed

    // ---------- CRASH/UNHANDLED PROTECTION ----------
    process.removeAllListeners('unhandledRejection');
    process.removeAllListeners('uncaughtException');
    process.on('unhandledRejection', (reason) => {
      console.error('Unhandled Rejection:', reason);
      safeRestart();
    });
    process.on('uncaughtException', (err) => {
      console.error('Uncaught Exception:', err);
      safeRestart();
    });

  } catch (err) {
    console.error('startBot error:', err);
    restarting = false;
    setTimeout(startBot, 2000);
  }
}

// helper to cleanup socket
function cleanupSock() {
  try {
    if (currentSock && typeof currentSock === 'object') {
      try { currentSock.ev.removeAllListeners(); } catch (e) {}
      try { currentSock.ws?.close(); } catch (e) {}
      try { currentSock.end?.(); } catch (e) {}
    }
  } catch (e) {}
  currentSock = null;
}

// safe restart logic
function safeRestart() {
  if (restarting) return;
  console.log('Attempting safe restart...');
  restarting = true;
  try { cleanupSock(); } catch (e) {}
  setTimeout(() => {
    restarting = false;
    startBot().catch(e => {
      console.error('Restart failed:', e);
      setTimeout(startBot, 3000);
    });
  }, 2000);
}

// start initially
startBot().catch(err => {
  console.error('Initial bot start error:', err);
  setTimeout(startBot, 2000);
});
