'use strict';

const express = require('express');
const axios = require('axios');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');
const firebaseAdmin = require('firebase-admin');
const crypto = require('crypto');
const GraphemeSplitter = require('grapheme-splitter');
const { URL, URLSearchParams } = require('url');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezone);

const _splitter = new GraphemeSplitter();
const toGraphemes = (s) => _splitter.splitGraphemes(String(s || ''));
const { Client, middleware } = require('@line/bot-sdk');

const normalizeFormUrl = s => {
  let v = String(s || '').trim();
  if (!v) return '';
  v = v.replace(/^usp=header\s*/i, '');
  if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
  try {
    new URL(v);
    return v;
  } catch {
    console.warn('[WARN] Invalid form URL in env:', s);
    return '';
  }
};
const prefillUrl = (base, params) => {
  if (!base) return '#';
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }
  return url.toString();
};

// === Env ===
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const EMERGENCY_CONTACT_PHONE_NUMBER = process.env.EMERGENCY_CONTACT_PHONE_NUMBER;
const OFFICER_GROUP_ID = process.env.OFFICER_GROUP_ID;
const OWNER_USER_ID = process.env.OWNER_USER_ID || null;
const WATCH_RUNNER = process.env.WATCH_RUNNER || 'internal';

let creds = null;
if (process.env.FIREBASE_CREDENTIALS_BASE64) {
  creds = JSON.parse(Buffer.from(process.env.FIREBASE_CREDENTIALS_BASE64, "base64").toString("utf-8"));
}
if (!firebaseAdmin.apps.length) {
  if (!creds) {
    creds = require("./serviceAccountKey.json");
  }
  firebaseAdmin.initializeApp({ credential: firebaseAdmin.credential.cert(creds) });
  console.log("✅ Firebase initialized");
}
const db = firebaseAdmin.firestore();
const Timestamp = firebaseAdmin.firestore.Timestamp;
const client = new Client({ channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN, channelSecret: LINE_CHANNEL_SECRET });

const app = express();
const PORT = process.env.PORT || 3000;
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 2));
app.use(helmet());
app.use('/webhook', rateLimit({ windowMs: 60_000, max: 100 }));

// === 見守り設定 ===
const JST_TZ = 'Asia/Tokyo';
const PING_INTERVAL_DAYS = 3;
const REMINDER_AFTER_HOURS = 24;
const ESCALATE_AFTER_HOURS = 29;

// 状態管理
const WATCH_STATUS = {
  WAITING: 'waiting',   // ping直後
  REMINDED: 'reminded', // 24hリマインド済
  ALERTED: 'alerted',   // 29h通報済
  NONE: 'none'
};
const REMIND_GAP_HOURS = ESCALATE_AFTER_HOURS - REMINDER_AFTER_HOURS; // 5h

// === ユーティリティ ===
const pickWatchMsg = () => "こころちゃんだよ🌸";
const nextPingAtFrom = (fromDate) =>
  dayjs(fromDate).tz(JST_TZ).add(PING_INTERVAL_DAYS, 'day').hour(15).minute(0).second(0).millisecond(0).toDate();

async function scheduleNextPing(userId, fromDate = new Date()) {
  const nextAt = dayjs(fromDate).tz(JST_TZ).add(PING_INTERVAL_DAYS, 'day')
    .hour(15).minute(0).second(0).millisecond(0).toDate();
  await db.collection('users').doc(userId).set({
    watchService: {
      nextPingAt: Timestamp.fromDate(nextAt),
      awaitingReply: false,
      status: WATCH_STATUS.NONE,
      lastPingAt: firebaseAdmin.firestore.FieldValue.delete(),
      lastReminderAt: firebaseAdmin.firestore.FieldValue.delete(),
      lastNotifiedAt: firebaseAdmin.firestore.FieldValue.delete(),
      notifyLockExpiresAt: firebaseAdmin.firestore.FieldValue.delete(),
    }
  }, { merge: true });
}

async function safePush(to, messages) {
  const arr = Array.isArray(messages) ? messages : [messages];
  try {
    await client.pushMessage(to, arr);
  } catch (err) {
    console.error('[ERR] LINE push failed', err?.response?.data || err.message);
  }
}

// === 見守りロジック ===
async function checkAndSendPing() {
  const now = dayjs().tz('UTC');
  const usersRef = db.collection('users');
  const snap = await usersRef.where('watchService.enabled', '==', true).limit(200).get();
  if (snap.empty) return;

  for (const doc of snap.docs) {
    const ref = doc.ref;
    const u = doc.data() || {};
    const ws = u.watchService || {};
    const awaiting = !!ws.awaitingReply;
    const lastPingAt = ws.lastPingAt?.toDate?.() ? dayjs(ws.lastPingAt.toDate()) : null;
    const lastReminderAt = ws.lastReminderAt?.toDate?.() ? dayjs(ws.lastReminderAt.toDate()) : null;
    const lastNotifiedAt = ws.lastNotifiedAt?.toDate?.() ? dayjs(ws.lastNotifiedAt.toDate()) : null;
    const status = ws.status || WATCH_STATUS.NONE;

    let mode = (!awaiting) ? 'ping' : 'noop';
    if (awaiting && lastPingAt) {
      const hrsSincePing = dayjs().utc().diff(dayjs(lastPingAt).utc(), 'hour');
      if (status === WATCH_STATUS.WAITING && hrsSincePing >= REMINDER_AFTER_HOURS) {
        mode = 'remind';
      }
      if (status === WATCH_STATUS.REMINDED) {
        const hrsSinceRemind = lastReminderAt ? dayjs().utc().diff(dayjs(lastReminderAt).utc(), 'hour') : 0;
        if (hrsSinceRemind >= REMIND_GAP_HOURS || hrsSincePing >= ESCALATE_AFTER_HOURS) {
          mode = 'escalate';
        }
      }
    }

    if (mode === 'ping') {
      await safePush(doc.id, { type: 'text', text: `${pickWatchMsg()} 大丈夫なら「OKだよ💖」を押してね！` });
      await ref.set({
        watchService: {
          lastPingAt: Timestamp.now(),
          awaitingReply: true,
          status: WATCH_STATUS.WAITING,
        }
      }, { merge: true });
    } else if (mode === 'remind') {
      if (status === WATCH_STATUS.REMINDED) continue; // 1回だけ
      await safePush(doc.id, { type: 'text', text: `${pickWatchMsg()} 昨日のOKまだ受け取れてないの…` });
      await ref.set({
        watchService: { lastReminderAt: Timestamp.now(), status: WATCH_STATUS.REMINDED }
      }, { merge: true });
    } else if (mode === 'escalate') {
      if (!OFFICER_GROUP_ID) continue;
      await safePush(OFFICER_GROUP_ID, { type: 'text', text: `🚨未応答ユーザー: ${doc.id}` });
      await ref.set({
        watchService: {
          lastNotifiedAt: Timestamp.now(),
          awaitingReply: false,
          status: WATCH_STATUS.ALERTED,
          nextPingAt: Timestamp.fromDate(nextPingAtFrom(dayjs().tz(JST_TZ).toDate()))
        }
      }, { merge: true });
    }
  }
}

// === Cron ===
if (WATCH_RUNNER !== 'external') {
  cron.schedule('*/5 * * * *', () => checkAndSendPing().catch(console.error), { timezone: 'UTC' });
}

// === Webhook ===
const lineMiddleware = middleware({ channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN, channelSecret: LINE_CHANNEL_SECRET });
app.post('/webhook', lineMiddleware, async (req, res) => {
  res.sendStatus(200);
  const events = req.body.events || [];
  for (const ev of events) {
    if (ev.type === 'postback') await handlePostbackEvent(ev, ev.source.userId);
    if (ev.type === 'message') await handleEvent(ev);
  }
});

// === Postback Handler ===
async function handlePostbackEvent(event, userId) {
  if (event.postback.data === 'watch:ok') {
    const ref = db.collection('users').doc(userId);
    await ref.set({
      watchService: {
        awaitingReply: false,
        lastReplyAt: Timestamp.now(),
        status: WATCH_STATUS.NONE
      }
    }, { merge: true });
    await scheduleNextPing(userId);
    await client.replyMessage(event.replyToken, [
      { type: 'text', text: 'OK、受け取ったよ！💖 ありがとう😊' }
    ]);
  }
}

// === Message Handler ===
async function handleEvent(event) {
  const userId = event.source.userId;
  const text = event.message.type === 'text' ? event.message.text : '';
  const stickerId = event.message.type === 'sticker' ? event.message.stickerId : '';

  const u = (await db.collection('users').doc(userId).get()).data() || {};
  if (u.watchService?.enabled && u.watchService?.awaitingReply) {
    const okByText = /^(ok|okだよ|大丈夫|はい|元気)/i.test(text);
    const okBySticker = /^(11537|11538|52002734|52002735)$/.test(stickerId);
    if (okByText || okBySticker) {
      const ref = db.collection('users').doc(userId);
      await ref.set({
        watchService: { awaitingReply: false, lastReplyAt: Timestamp.now(), status: WATCH_STATUS.NONE }
      }, { merge: true });
      await scheduleNextPing(userId);
      await client.replyMessage(event.replyToken, [
        { type: 'text', text: 'OK、受け取ったよ！💖 ありがとう😊' }
      ]);
    }
  }
}

app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
