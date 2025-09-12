'use strict';

/*
  watch-service.js (2025-09-12)
  - Render の Cron Job 用ワンショット対応（WATCH_RUNNER=external）
  - 見守り：ping → 24h後remind → 29h後group通知
  - 通知先は WATCH_GROUP_ID（env > Firestore system/watch_group）
  - LINE pushのエラーは握りつぶさずログ出力
*/

const express = require('express');
const axios = require('axios');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const firebaseAdmin = require('firebase-admin');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezone);

const { Client, middleware } = require('@line/bot-sdk');

// ====== ENV ======
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET       = process.env.LINE_CHANNEL_SECRET;
const WATCH_RUNNER              = (process.env.WATCH_RUNNER || 'internal').toLowerCase();
const WATCH_LOG_LEVEL           = (process.env.WATCH_LOG_LEVEL || 'info').toLowerCase();

// ====== LOG ======
const LV = { error: 0, warn: 1, info: 2, debug: 3 };
const LV_ALLOW = LV[WATCH_LOG_LEVEL] ?? LV.info;
const log  = (lvl, ...a) => { if ((LV[lvl] ?? 9) <= LV_ALLOW) console.log(...a); };
const errp = (msg, e) => {
  const d = e?.originalError?.response?.data || e?.response?.data || e?.message || e;
  console.error(`[ERR] ${msg}:`, typeof d === 'string' ? d : JSON.stringify(d, null, 2));
};

// ====== Express（external でも app は定義必須）======
const app = express();
const PORT = process.env.PORT || 3000;
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 2));
app.use(helmet());
app.use('/webhook', rateLimit({ windowMs: 60_000, max: 100 }));

// ====== Firebase ======
let creds = null;
if (process.env.FIREBASE_CREDENTIALS_BASE64) {
  creds = JSON.parse(Buffer.from(process.env.FIREBASE_CREDENTIALS_BASE64, 'base64').toString('utf-8'));
}
if (!firebaseAdmin.apps.length) {
  if (!creds) creds = require('./serviceAccountKey.json'); // ローカル用
  firebaseAdmin.initializeApp({ credential: firebaseAdmin.credential.cert(creds) });
  console.log('✅ Firebase initialized');
}
const db = firebaseAdmin.firestore();
const Timestamp = firebaseAdmin.firestore.Timestamp;

// ====== LINE Client ======
const client = new Client({ channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN, channelSecret: LINE_CHANNEL_SECRET });

// ====== 見守りパラメータ ======
const JST_TZ = 'Asia/Tokyo';
const PING_INTERVAL_DAYS   = 3;
const REMINDER_AFTER_HOURS = 24;
const ESCALATE_AFTER_HOURS = 29;
const REMIND_GAP_HOURS     = ESCALATE_AFTER_HOURS - REMINDER_AFTER_HOURS;

const WATCH_STATUS = {
  WAITING:   'waiting',
  REMINDED:  'reminded',
  ALERTED:   'alerted',
  NONE:      'none',
};

// ====== 文面 ======
const watchMessages = [
  'こんにちは🌸 こころちゃんだよ！ 今日も元気にしてるかな？💖',
  'やっほー！ こころだよ😊 いつも応援してるね！',
  '元気にしてる？✨ こころちゃん、あなたのこと応援してるよ💖',
  'ねぇねぇ、こころだよ🌸 今日はどんな一日だった？',
  'いつもがんばってるあなたへ、こころからメッセージを送るね💖',
  'こんにちは😊 困ったことはないかな？いつでも相談してね！',
  'やっほー🌸 こころだよ！何かあったら、こころに教えてね💖',
  '元気出してね！こころちゃん、あなたの味方だよ😊',
  'こころちゃんだよ🌸 今日も一日お疲れ様💖',
  'やっほー！ こころだよ🌸 素敵な日になりますように💖',
];
const pickWatchMsg = () => watchMessages[Math.floor(Math.random() * watchMessages.length)];
const nextPingAtFrom = (fromDate) =>
  dayjs(fromDate).tz(JST_TZ).add(PING_INTERVAL_DAYS, 'day').hour(15).minute(0).second(0).millisecond(0).toDate();

// ====== 通知先（env > Firestore）======
const getWatchGroupDoc = () => db.collection('system').doc('watch_group');
async function getActiveWatchGroupId() {
  const envGid = (process.env.WATCH_GROUP_ID || '').trim();
  if (/^C[0-9A-Za-z]+$/.test(envGid)) return envGid;
  const snap = await getWatchGroupDoc().get();
  const gid  = snap.exists ? (snap.data().groupId || '') : '';
  return /^C[0-9A-Za-z]+$/.test(gid) ? gid : '';
}

// ====== FLEX ======
function maskPhone(num) {
  if (!num) return '未登録';
  return String(num).replace(/(\d{3})(\d+)(\d{2})/, (_, a, b, c) => `${a}****${c}`);
}
const buildUserPingFlex = (msg) => ({
  type:'flex', altText:'見守りチェック',
  contents:{
    type:'bubble',
    body:{ type:'box', layout:'vertical', contents:[
      { type:'text', text: msg, weight:'bold', size:'md', wrap:true },
      { type:'button', style:'primary', height:'sm', action:{ type:'postback', label:'OKだよ💖', data:'watch:ok' } },
    ]},
  },
});
const buildRemindFlex = () => ({
  type:'flex', altText:'見守りリマインド',
  contents:{
    type:'bubble', size:'mega',
    body:{ type:'box', layout:'vertical', contents:[
      { type:'text', text:'【見守りリマインド】', weight:'bold', size:'lg', color:'#555555' },
      { type:'text', text:'24時間以内にお返事がないよ。体調は大丈夫？', wrap:true, margin:'md', color:'#666666' },
    ]},
    styles:{ body:{ backgroundColor:'#f5f5f5' } },
    footer:{ type:'box', layout:'vertical', spacing:'sm', contents:[
      { type:'button', style:'secondary', action:{ type:'postback', label:'OKだよ💖', data:'watch:ok' } },
    ]},
  },
});
const buildGroupAlertFlex = (u) => ({
  type:'flex', altText:'見守りアラート',
  contents:{
    type:'bubble', size:'mega',
    body:{ type:'box', layout:'vertical', spacing:'sm', contents:[
      { type:'text', text:'🚨未応答アラート', weight:'bold', size:'lg', color:'#CC0000' },
      { type:'text', text:`ユーザー名: ${u.name || '未登録'}`, wrap:true },
      { type:'text', text:`住所: ${u.address || '未登録'}`, wrap:true },
      { type:'text', text:`本人TEL: ${maskPhone(u.phone)}`, wrap:true },
      { type:'text', text:`緊急連絡先: ${maskPhone(u.emergencyContactPhone)}`, wrap:true },
      { type:'text', text:`メモ: ${u.note || '—'}`, wrap:true },
    ]},
    styles:{ body:{ backgroundColor:'#eeeeee' } },
  },
});

// ====== 共通ユーティリティ ======
async function safePush(to, messages) {
  const arr = Array.isArray(messages) ? messages : [messages];
  try {
    await client.pushMessage(to, arr);
    log('info', '[push OK]', to);
  } catch (e) { errp('LINE push failed', e); }
}
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
    },
  }, { merge: true });
}

// ====== 見守り本体 ======
async function checkAndSendPing() {
  const now = dayjs().tz(JST_TZ);
  const snap = await db.collection('users')
    .where('watchService.enabled', '==', true)
    .limit(200)
    .get();
  if (snap.empty) return;

  const groupId = await getActiveWatchGroupId(); // 通知先

  await Promise.all(snap.docs.map(async (d) => {
    const ref = d.ref;
    const u   = d.data() || {};
    const ws  = u.watchService || {};
    const awaiting       = !!ws.awaitingReply;
    const lastPingAt     = ws.lastPingAt?.toDate?.()     ? dayjs(ws.lastPingAt.toDate()).tz(JST_TZ)     : null;
    const lastReminderAt = ws.lastReminderAt?.toDate?.() ? dayjs(ws.lastReminderAt.toDate()).tz(JST_TZ) : null;
    const status         = ws.status || WATCH_STATUS.NONE;

    // 進行モード判定
    let mode = (!awaiting) ? 'ping' : 'noop';
    if (awaiting && lastPingAt) {
      const hrsSincePing = now.diff(lastPingAt, 'hour');
      if (status === WATCH_STATUS.WAITING && hrsSincePing >= REMINDER_AFTER_HOURS) mode = 'remind';
      if (status === WATCH_STATUS.REMINDED) {
        const hrsSinceRemind = lastReminderAt ? now.diff(lastReminderAt, 'hour') : 0;
        if (hrsSinceRemind >= REMIND_GAP_HOURS || hrsSincePing >= ESCALATE_AFTER_HOURS) mode = 'escalate';
      }
    }

    if (mode === 'ping') {
      await safePush(d.id, [
        { type:'text', text:`${pickWatchMsg()} 大丈夫なら「OKだよ💖」を押してね！` },
        buildUserPingFlex(pickWatchMsg()),
      ]);
      await ref.set({
        watchService: {
          lastPingAt: Timestamp.fromDate(now.toDate()),
          awaitingReply: true,
          status: WATCH_STATUS.WAITING,
          lastReminderAt: firebaseAdmin.firestore.FieldValue.delete(),
          lastNotifiedAt: firebaseAdmin.firestore.FieldValue.delete(),
          notifyLockExpiresAt: firebaseAdmin.firestore.FieldValue.delete(),
        },
      }, { merge: true });

    } else if (mode === 'remind') {
      if (status === WATCH_STATUS.REMINDED) return;
      await safePush(d.id, [
        { type:'text', text:`${pickWatchMsg()} 昨日のOKまだ受け取れてないの… 大丈夫ならボタン押してね！` },
        buildRemindFlex(),
      ]);
      await ref.set({ watchService: { lastReminderAt: Timestamp.fromDate(now.toDate()), status: WATCH_STATUS.REMINDED } }, { merge: true });

    } else if (mode === 'escalate') {
      if (!groupId) return; // 通知先なしならスキップ
      await safePush(groupId, buildGroupAlertFlex({
        name: u.name, address: u.address, phone: u.phone,
        emergencyContactPhone: u.emergencyContactPhone, note: u.note,
      }));
      await ref.set({
        watchService: {
          lastNotifiedAt: Timestamp.fromDate(now.toDate()),
          awaitingReply: false,
          status: WATCH_STATUS.ALERTED,
          nextPingAt: Timestamp.fromDate(nextPingAtFrom(now.toDate())),
        },
      }, { merge: true });
    }
  }));
}

// ====== Webhook（常駐時のみ実用）======
const lineMiddleware = middleware({ channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN, channelSecret: LINE_CHANNEL_SECRET });
app.post('/webhook', lineMiddleware, async (req, res) => {
  res.sendStatus(200);
  const events = req.body.events || [];
  for (const ev of events) {
    if (ev.type === 'postback') await handlePostbackEvent(ev, ev.source.userId);
    if (ev.type === 'message')  await handleEvent(ev);
  }
});

async function handlePostbackEvent(event, userId) {
  if (event.postback.data === 'watch:ok') {
    const ref = db.collection('users').doc(userId);
    await ref.set({ watchService: { awaitingReply: false, lastReplyAt: Timestamp.now(), status: WATCH_STATUS.NONE } }, { merge: true });
    await scheduleNextPing(userId);
    await client.replyMessage(event.replyToken, [{ type:'text', text:'OK、受け取ったよ！💖 ありがとう😊' }]);
  }
}
async function handleEvent(event) {
  const userId    = event.source.userId;
  const text      = event.message.type === 'text'    ? event.message.text      : '';
  const stickerId = event.message.type === 'sticker' ? event.message.stickerId : '';
  const u = (await db.collection('users').doc(userId).get()).data() || {};
  if (u.watchService?.enabled && u.watchService?.awaitingReply) {
    const okByText    = /^(ok|okだよ|大丈夫|はい|元気)/i.test(text);
    const okBySticker = /^(11537|11538|52002734|52002735)$/.test(stickerId);
    if (okByText || okBySticker) {
      const ref = db.collection('users').doc(userId);
      await ref.set({ watchService: { awaitingReply: false, lastReplyAt: Timestamp.now(), status: WATCH_STATUS.NONE } }, { merge: true });
      await scheduleNextPing(userId);
      await client.replyMessage(event.replyToken, [{ type:'text', text:'OK、受け取ったよ！💖 ありがとう😊' }]);
    }
  }
}

// ====== エントリーポイント ======
if (WATCH_RUNNER === 'external') {
  (async () => {
    log('info', '▶ watch-service one-shot start');
    try {
      await checkAndSendPing();
      log('info', '✅ watch-service done');
      process.exit(0);                // ← Cron Job の肝：終了させる
    } catch (e) {
      errp('watch-service failed', e);
      process.exit(1);
    }
  })();
} else {
  app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
}
