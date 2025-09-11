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

const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const OFFICER_GROUP_ID = process.env.OFFICER_GROUP_ID;
const EMERGENCY_CONTACT_PHONE_NUMBER = process.env.EMERGENCY_CONTACT_PHONE_NUMBER;

let creds = null;
if (process.env.FIREBASE_CREDENTIALS_BASE64) {
  creds = JSON.parse(Buffer.from(process.env.FIREBASE_CREDENTIALS_BASE64, "base64").toString("utf-8"));
}
if (!firebaseAdmin.apps.length) {
  if (!creds) {
    creds = require("./serviceAccountKey.json");
  }
  firebaseAdmin.initializeApp({
    credential: firebaseAdmin.credential.cert(creds),
  });
  console.log("✅ Firebase initialized");
}
const db = firebaseAdmin.firestore();
const Timestamp = firebaseAdmin.firestore.Timestamp;
const client = new Client({
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: LINE_CHANNEL_SECRET,
});

const PORT = process.env.PORT || 3000;
const app = express();

const JST_TZ = 'Asia/Tokyo';
const PING_INTERVAL_DAYS = 3;
const REMINDER_AFTER_HOURS = 24;
const ESCALATE_AFTER_HOURS = 29;

// === 状態管理 ===
const WATCH_STATUS = {
  NONE: 'none',
  WAITING: 'waiting',
  REMINDED: 'reminded',
  ALERTED: 'alerted'
};
const REMIND_GAP_HOURS = ESCALATE_AFTER_HOURS - REMINDER_AFTER_HOURS; // 5h

const pickWatchMsg = () => {
  const msgs = [
    "こんにちは🌸 こころちゃんだよ！ 今日も元気にしてるかな？💖",
    "やっほー！ こころだよ😊 いつも応援してるね！",
    "元気にしてる？✨ こころちゃん、あなたのこと応援してるよ💖",
    "いつもがんばってるあなたへ、こころからメッセージを送るね💖",
    "やっほー🌸 こころだよ！何かあったら、こころに教えてね💖",
    "元気出してね！こころちゃん、あなたの味方だよ😊",
    "こんにちは😊 困ったことはないかな？いつでも相談してね！",
  ];
  return msgs[Math.floor(Math.random() * msgs.length)];
};

const nextPingAtFrom = (fromDate) =>
  dayjs(fromDate).tz(JST_TZ).add(PING_INTERVAL_DAYS, 'day').hour(15).minute(0).second(0).millisecond(0).toDate();

async function scheduleNextPing(userId, fromDate = new Date()) {
  const nextAt = nextPingAtFrom(fromDate);
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
    console.error('[ERR] LINE push failed', err?.response?.data || err);
  }
}

const maskPhone = (raw = '') => {
  const s = String(raw).replace(/[^0-9+]/g, '');
  if (!s) return '';
  const tail = s.slice(-4);
  const head = s.slice(0, -4).replace(/[0-9]/g, '＊');
  return head + tail;
};

const buildWatchFlex = (u, userId, elapsedHours, telRaw) => {
  const name = u?.profile?.displayName || '(不明)';
  const tel = String(telRaw || '').trim();
  const masked = tel ? maskPhone(tel) : '未登録';
  return {
    type: 'flex',
    altText: `🚨未応答: ${name} / ${elapsedHours}時間`,
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', spacing: 'md',
        contents: [
          { type: 'text', text: '🚨 見守り未応答', weight: 'bold', size: 'xl' },
          { type: 'text', text: `ユーザー名：${name}`, wrap: true },
          { type: 'text', text: `UserID：${userId}`, size: 'sm', color: '#888', wrap: true },
          { type: 'text', text: `経過：${elapsedHours}時間`, wrap: true },
          { type: 'separator', margin: 'md' },
          { type: 'text', text: `連絡先（マスク）：${masked}`, wrap: true },
        ]
      },
      footer: {
        type: 'box', layout: 'vertical', spacing: 'md',
        contents: tel ? [{
          type: 'button', style: 'primary',
          action: { type: 'uri', label: '📞 発信する', uri: `tel:${tel}` }
        }] : [{ type: 'text', text: '※TEL未登録', size: 'sm', color: '#888' }]
      }
    }
  };
};

async function checkAndSendPing() {
  const now = dayjs().tz('UTC');
  console.log(`[watch-service] start ${now.format('YYYY/MM/DD HH:mm:ss')} (UTC)`);

  const snap = await db.collection('users')
    .where('watchService.enabled', '==', true)
    .limit(200)
    .get();

  for (const doc of snap.docs) {
    const ref = doc.ref;
    const u = doc.data() || {};
    const ws = u.watchService || {};
    const awaiting = !!ws.awaitingReply;
    const status = ws.status || WATCH_STATUS.NONE;
    const lastPingAt = ws.lastPingAt?.toDate ? dayjs(ws.lastPingAt.toDate()) : null;
    const lastReminderAt = ws.lastReminderAt?.toDate ? dayjs(ws.lastReminderAt.toDate()) : null;

    let mode = 'noop';

    if (!awaiting && (!ws.nextPingAt || ws.nextPingAt.toDate() <= now.toDate())) {
      mode = 'ping';
    } else if (awaiting && lastPingAt) {
      const hrsSincePing = dayjs().utc().diff(lastPingAt.utc(), 'hour');
      if (status === WATCH_STATUS.WAITING && hrsSincePing >= REMINDER_AFTER_HOURS) {
        mode = 'remind';
      }
      if (status === WATCH_STATUS.REMINDED) {
        const hrsSinceRemind = lastReminderAt ? dayjs().utc().diff(lastReminderAt.utc(), 'hour') : 0;
        if (hrsSinceRemind >= REMIND_GAP_HOURS || hrsSincePing >= ESCALATE_AFTER_HOURS) {
          mode = 'escalate';
        }
      }
    }

    if (mode === 'ping') {
      await safePush(doc.id, [{
        type: 'text',
        text: `${pickWatchMsg()} 大丈夫なら「OKだよ💖」を押してね！`
      }, {
        type: 'flex',
        altText: '見守りチェック',
        contents: {
          type: 'bubble',
          body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: '見守りチェック', weight: 'bold', size: 'xl' }] },
          footer: {
            type: 'box', layout: 'vertical',
            contents: [{
              type: 'button', style: 'primary',
              action: { type: 'postback', label: 'OKだよ💖', data: 'watch:ok', displayText: 'OKだよ💖' }
            }]
          }
        }
      }]);
      await ref.set({
        watchService: {
          lastPingAt: Timestamp.now(),
          awaitingReply: true,
          status: WATCH_STATUS.WAITING
        }
      }, { merge: true });
    }

    if (mode === 'remind') {
      await safePush(doc.id, [{
        type: 'text',
        text: `${pickWatchMsg()} 昨日の見守りのOKまだ受け取れてないの… 大丈夫ならボタン押してね！`
      }]);
      await ref.set({
        watchService: {
          lastReminderAt: Timestamp.now(),
          status: WATCH_STATUS.REMINDED
        }
      }, { merge: true });
    }

    if (mode === 'escalate') {
      const tel = u?.profile?.phone || u?.emergency?.contactPhone || EMERGENCY_CONTACT_PHONE_NUMBER || '';
      const elapsedH = lastPingAt ? dayjs().utc().diff(lastPingAt.utc(), 'hour') : ESCALATE_AFTER_HOURS;
      const flex = buildWatchFlex(u, doc.id, elapsedH, tel);

      if (OFFICER_GROUP_ID) {
        await safePush(OFFICER_GROUP_ID, [
          { type: 'text', text: '🚨見守り未応答が発生しました。対応お願いします。' },
          flex
        ]);
      }

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

  console.log(`[watch-service] end ${dayjs().tz('UTC').format('YYYY/MM/DD HH:mm:ss')} (UTC)`);
}

cron.schedule('*/5 * * * *', () => {
  checkAndSendPing().catch(err => console.error('Cron job error:', err));
}, { scheduled: true, timezone: 'UTC' });

app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
