// index.js
// Minimal WhatsApp Bot: QR login + auto-view status + react

import express from 'express';
import makeWASocket, { useMultiFileAuthState, jidNormalizedUser } from '@whiskeysockets/baileys';
import P from 'pino';
import qrcode from 'qrcode';

const AUTH_PATH = './.auth';
const PORT = process.env.PORT || 3000;
const EMOJIS = ['🦋','💡','🏆','🎖️','💎','✨','🚀','🌟','📈','📝','🤝','🎯','⚡','💼','🌐','😉','😍','💞','💌','🔥'];

let latestQR = '';
let currentSock = null;

const app = express();
app.get('/', (req, res) => res.send('WhatsApp Bot running. Visit /qr'));
app.get('/qr', async (req, res) => {
  if (!latestQR) return res.send('<h2>Waiting for QR...</h2><p>Keep this page open — it auto-refreshes.</p><script>setTimeout(() => location.reload(), 2500)</script>');
  const dataUrl = await qrcode.toDataURL(latestQR);
  res.send(`<h2>Scan QR to login WhatsApp Bot</h2><img src="${dataUrl}" /><p>Auto-refreshing...</p><script>setTimeout(() => location.reload(), 2500)</script>`);
});

app.listen(PORT, () => console.log(`Server running on port ${PORT} — QR Page -> http://localhost:${PORT}/qr`));

async function startBot() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_PATH);
    const sock = makeWASocket({ auth: state, logger: P({ level: 'silent' }) });
    currentSock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', ({ connection, qr, lastDisconnect }) => {
      if (qr) { latestQR = qr; console.log('New QR received — open /qr in browser'); }
      if (connection === 'open') { latestQR = ''; console.log('Bot connected'); }
      if (connection === 'close') {
        console.log('Connection closed, restarting...');
        setTimeout(startBot, 2000);
      }
    });

// Owner command: .status
const owner = "254748397839@s.whatsapp.net"; // <-- your number in JID format

if (msg.key.remoteJid === owner && msg.message?.conversation) {
  const text = msg.message.conversation.trim().toLowerCase();

  if (text === '.status') {
    await sock.sendMessage(owner, { text: "Bot is alive and running 🚀" });
  }
}

    // Auto-view status + react
    sock.ev.on('messages.upsert', async (m) => {
      try {
        if (!m.messages) return;
        const msg = m.messages[0];
        if (msg.key.remoteJid === 'status@broadcast') {
          await sock.readMessages([msg.key]);
          const statusSender = msg.key.participant || msg.key.remoteJid;
          const emoji = EMOJIS[Math.floor(Math.random() * EMOJIS.length)];
          try { await sock.sendMessage(statusSender, { react: { text: emoji, key: msg.key } }); } catch {}
        }
      } catch {}
    });

    sock.ev.on('message-info.update', async (updates) => {
      if (!updates) return;
      const list = Array.isArray(updates) ? updates : [updates];
      for (const u of list) {
        if (u.key?.remoteJid === 'status@broadcast') {
          await sock.readMessages([u.key]);
          const emoji = EMOJIS[Math.floor(Math.random() * EMOJIS.length)];
          try { await sock.sendMessage(u.key.participant || u.key.remoteJid, { react: { text: emoji, key: u.key } }); } catch {}
        }
      }
    });

  } catch (err) {
    console.error('Bot start error:', err);
    setTimeout(startBot, 2000);
  }
}

startBot();