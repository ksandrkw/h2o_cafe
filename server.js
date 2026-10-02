import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

// Load local .env without requiring an extra package.
function loadLocalEnv() {
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('\"') && value.endsWith('\"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) process.env[key] = value;
  }
}

loadLocalEnv();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BOT_PASSWORD = process.env.H2O_BOT_PASSWORD;
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');

if (!BOT_TOKEN) throw new Error('Missing TELEGRAM_BOT_TOKEN');
if (!BOT_PASSWORD || BOT_PASSWORD.length < 32) throw new Error('H2O_BOT_PASSWORD must be at least 32 characters.');
console.log(`H2O_BOT_PASSWORD loaded: ${BOT_PASSWORD.length} characters.`);
if (!WEBHOOK_SECRET || WEBHOOK_SECRET.length < 16) throw new Error('TELEGRAM_WEBHOOK_SECRET must be at least 16 characters.');

const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'h2o.sqlite'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS bot_users (
    chat_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    username TEXT,
    authorized_at TEXT NOT NULL,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER NOT NULL DEFAULT 0
  );
`);

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));

function telegramUrl(method) {
  return `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
}

async function telegram(method, payload = {}) {
  const response = await fetch(telegramUrl(method), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) {
    throw new Error(`Telegram ${method} failed: ${result.description || response.statusText}`);
  }
  return result.result;
}

function safe(value) {
  return String(value ?? '').replace(/[<>]/g, '').trim();
}

function money(value) {
  return `${new Intl.NumberFormat('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value || 0))} грн`;
}

function passwordMatches(input) {
  const a = Buffer.from(String(input || ''), 'utf8');
  const b = Buffer.from(BOT_PASSWORD, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isAuthorized(chatId) {
  // A row with user_id='pending' means the chat is waiting for a password and is NOT authorized.
  return Boolean(db.prepare("SELECT 1 FROM bot_users WHERE chat_id = ? AND user_id != 'pending'").get(String(chatId)));
}

function ensureRow(chatId, userId, username) {
  db.prepare(`
    INSERT INTO bot_users(chat_id, user_id, username, authorized_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET user_id = excluded.user_id, username = excluded.username
  `).run(String(chatId), String(userId), username || null, new Date().toISOString());
}

function authorize(chatId, userId, username) {
  ensureRow(chatId, userId, username);
  db.prepare(`UPDATE bot_users SET authorized_at = ?, failed_attempts = 0, locked_until = 0 WHERE chat_id = ?`)
    .run(new Date().toISOString(), String(chatId));
}

function removeAuthorization(chatId) {
  db.prepare('DELETE FROM bot_users WHERE chat_id = ?').run(String(chatId));
}

function registerFailure(chatId) {
  const row = db.prepare('SELECT failed_attempts FROM bot_users WHERE chat_id = ?').get(String(chatId));
  const failed = Number(row?.failed_attempts || 0) + 1;
  const lockUntil = failed >= 5 ? Date.now() + 60_000 : 0;
  if (row) {
    db.prepare('UPDATE bot_users SET failed_attempts = ?, locked_until = ? WHERE chat_id = ?')
      .run(failed, lockUntil, String(chatId));
  } else {
    db.prepare(`INSERT INTO bot_users(chat_id, user_id, username, authorized_at, failed_attempts, locked_until) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(String(chatId), 'pending', null, new Date().toISOString(), failed, lockUntil);
  }
  return { failed, lockUntil };
}

function clearPending(chatId) {
  db.prepare('DELETE FROM bot_users WHERE chat_id = ? AND user_id = ?').run(String(chatId), 'pending');
}

function getPending(chatId) {
  return db.prepare('SELECT failed_attempts, locked_until FROM bot_users WHERE chat_id = ? AND user_id = ?')
    .get(String(chatId), 'pending');
}

function orderText(data) {
  const firstOrder = String(data.firstOrder || '') === 'on' || data.firstOrder === true;
  const qty = Number(data.quantity || 0);
  const bottlesCost = Number(data.bottles || 0);
  const waterTotal = Number(data.waterTotal || 0);
  const delivery = Number(data.delivery || 0);
  const total = Number(data.total || 0);

  return [
    '🔔 НОВЕ ЗАМОВЛЕННЯ H2O',
    '',
    `👤 Ім’я: ${safe(data.name)}`,
    `📞 Телефон: ${safe(data.phone)}`,
    `📍 Адреса: ${safe(data.address)}`,
    `💧 Вода: H2O ${safe(data.waterType)}`,
    `📦 Формат: 18,9 л × ${qty || safe(data.quantity || '1')}`,
    `📅 Дата / час: ${safe(data.date)}, ${safe(data.time)}`,
    `💳 Розрахунок: ${safe(data.payment)}`,
    `🆕 Перше замовлення: ${firstOrder ? 'так' : 'ні'}`,
    '',
    `💧 Вода: ${money(waterTotal)}`,
    `🚚 Доставка: ${money(delivery)}`,
    bottlesCost ? `🪣 Бутлі: ${money(bottlesCost)}` : '',
    `💰 Разом: ${money(total)}`,
    data.comment ? `💬 Коментар: ${safe(data.comment)}` : ''
  ].filter(Boolean).join('\n');
}

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/api/order', async (req, res) => {
  try {
    const data = req.body || {};
    const required = ['name', 'phone', 'address', 'waterType', 'date', 'time', 'payment'];
    const missing = required.filter((key) => !String(data[key] || '').trim());
    if (missing.length) return res.status(400).json({ message: `Missing fields: ${missing.join(', ')}` });

    const chats = db.prepare("SELECT chat_id FROM bot_users WHERE user_id != 'pending'").all();
    if (!chats.length) {
      return res.status(503).json({ message: 'Telegram admin is not authorized yet.' });
    }

    const text = orderText(data);
    for (const { chat_id: chatId } of chats) {
      await telegram('sendMessage', {
        chat_id: chatId,
        text,
        disable_web_page_preview: true
      });
    }

    return res.json({ ok: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: 'Не вдалося надіслати замовлення.' });
  }
});

async function handleTelegramUpdate(update) {
  const message = update?.message;
  if (!message?.chat?.id || message.chat.type !== 'private') return;

  const chatId = String(message.chat.id);
  const userId = String(message.from?.id || chatId);
  const username = message.from?.username || '';
  const text = String(message.text || '').trim();

  try {
    if (text === '/start') {
      if (isAuthorized(chatId)) {
        await telegram('sendMessage', { chat_id: chatId, text: '✅ Ви вже авторизовані. Нові замовлення надходитимуть сюди автоматично.' });
      } else {
        db.prepare(`INSERT INTO bot_users(chat_id, user_id, username, authorized_at, failed_attempts, locked_until) VALUES (?, ?, ?, ?, 0, 0)
          ON CONFLICT(chat_id) DO UPDATE SET user_id = excluded.user_id, username = excluded.username`)
          .run(chatId, 'pending', username || null, new Date().toISOString());
        await telegram('sendMessage', { chat_id: chatId, text: 'Введіть пароль:' });
      }
      return;
    }

    if (text === '/logout') {
      removeAuthorization(chatId);
      await telegram('sendMessage', { chat_id: chatId, text: '🔒 Доступ скасовано. Щоб увійти знову, надішліть /start.' });
      return;
    }

    if (isAuthorized(chatId)) {
      await telegram('sendMessage', { chat_id: chatId, text: '✅ Бот активний. Тут з’являтимуться нові замовлення H2O.' });
      return;
    }

    const pending = getPending(chatId) || { failed_attempts: 0, locked_until: 0 };
    if (pending.locked_until && Date.now() < pending.locked_until) {
      const seconds = Math.ceil((pending.locked_until - Date.now()) / 1000);
      await telegram('sendMessage', { chat_id: chatId, text: `Спробуйте ще раз через ${seconds} с.` });
      return;
    }

    if (passwordMatches(text)) {
      clearPending(chatId);
      authorize(chatId, userId, username);
      await telegram('sendMessage', { chat_id: chatId, text: '✅ Доступ надано. Нові замовлення H2O надходитимуть сюди.' });
    } else {
      const result = registerFailure(chatId);
      if (result.lockUntil) {
        await telegram('sendMessage', { chat_id: chatId, text: '❌ Невірний пароль. Спробуйте ще раз через 60 с.' });
      } else {
        await telegram('sendMessage', { chat_id: chatId, text: '❌ Невірний пароль. Спробуйте ще раз.' });
      }
    }
  } catch (error) {
    console.error('Telegram update handling failed:', error);
  }
}

app.post('/telegram/webhook', async (req, res) => {
  if (req.get('X-Telegram-Bot-Api-Secret-Token') !== WEBHOOK_SECRET) {
    return res.status(401).send('Unauthorized');
  }
  await handleTelegramUpdate(req.body);
  return res.sendStatus(200);
});

let pollingRunning = false;
async function startPolling() {
  if (pollingRunning) return;
  pollingRunning = true;
  try {
    await telegram('deleteWebhook', { drop_pending_updates: false });
    console.log('Telegram polling mode enabled.');
    let offset = 0;
    while (true) {
      try {
        const updates = await telegram('getUpdates', {
          offset,
          timeout: 25,
          allowed_updates: ['message']
        });
        for (const update of updates) {
          offset = update.update_id + 1;
          await handleTelegramUpdate(update);
        }
      } catch (error) {
        console.error('Telegram polling error:', error.message);
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
    }
  } catch (error) {
    console.error('Telegram polling setup failed:', error.message);
  }
}

async function configureTelegram() {
  await telegram('setMyCommands', {
    commands: [
      { command: 'start', description: 'Увійти в адмін-бот' },
      { command: 'logout', description: 'Вийти з адмін-бота' }
    ]
  });

  if (PUBLIC_BASE_URL) {
    await telegram('setWebhook', {
      url: `${PUBLIC_BASE_URL}/telegram/webhook`,
      secret_token: WEBHOOK_SECRET,
      allowed_updates: ['message']
    });
    console.log(`Telegram webhook set: ${PUBLIC_BASE_URL}/telegram/webhook`);
  } else {
    void startPolling();
  }
}

app.listen(PORT, async () => {
  console.log(`H2O server running on port ${PORT}`);
  try {
    await configureTelegram();
  } catch (error) {
    console.error('Telegram setup failed:', error.message);
  }
});
