'use strict';

const express = require('express');
const axios = require('axios');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const firebaseAdmin = require('firebase-admin');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc); dayjs.extend(timezone);

const { Client, middleware } = require('@line/bot-sdk');

// ===== app 初期化（必須！）=====
const app = express();
const PORT = process.env.PORT || 3000;
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 2));
app.use(helmet());
app.use('/webhook', rateLimit({ windowMs: 60_000, max: 100 }));

// ===== ENV / LOG =====
const WATCH_RUNNER = (process.env.WATCH_RUNNER || 'internal').toLowerCase();
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;

// ===== Firebase =====
let creds = null;
if (process.env.FIREBASE_CREDENTIALS_BASE64) {
  creds = JSON.parse(Buffer.from(process.env.FIREBASE_CREDENTIALS_BASE64, 'base64').toString('utf-8'));
}
if (!firebaseAdmin.apps.length) {
  if (!creds) creds = require('./serviceAccountKey.json');
  firebaseAdmin.initializeApp({ credential: firebaseAdmin.credential.cert(creds) });
  console.log('✅ Firebase initialized');
}
const db = firebaseAdmin.firestore();
const Timestamp = firebaseAdmin.firestore.Timestamp;

// ===== LINE =====
const client = new Client({ channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN, channelSecret: LINE_CHANNEL_SECRET });

// ===== 見守り設定 =====
const JST_TZ = 'Asia/Tokyo';
const PING_INTERVAL_DAYS = 3;
const REMINDER_AFTER_HOURS = 24;
const ESCALATE_AFTER_HOURS = 29;
const REMIND_GAP_HOURS = ESCALATE_AFTER_HOURS - REMINDER_AFTER_HOURS;
const WATCH_STATUS = { WAITING:'waiting', REMINDED:'reminded', ALERTED:'alerted', NONE:'none' };

const msgs = [
  'こんにちは🌸 こころちゃんだよ！ 今日も元気にしてるかな？💖',
  'やっほー！ こころだよ😊 いつも応援してるね！',
  '元気にしてる？✨ こころちゃん、あなたのこと応援してるよ💖',
  'ねぇねぇ、こころだよ🌸 今日はどんな一日だった？',
  'いつもがんばってるあなたへ、こころからメッセージを送るね💖',
];
const pickMsg = () => msgs[Math.floor(Math.random()*msgs.length)];
const nextPingAtFrom = (from) => dayjs(from).tz(JST_TZ).add(PING_INTERVAL_DAYS,'day').hour(15).minute(0).second(0).millisecond(0).toDate();

// ===== 通知先（env > Firestore）=====
const getWatchGroupDoc = () => db.collection('system').doc('watch_group');
async function getActiveWatchGroupId(){
  const envGid = (process.env.WATCH_GROUP_ID || '').trim();
  if (/^C[0-9A-Za-z]+$/.test(envGid)) return envGid;
  const snap = await getWatchGroupDoc().get();
  const gid = snap.exists ? (snap.data().groupId || '') : '';
  return /^C[0-9A-Za-z]+$/.test(gid) ? gid : '';
}

// ===== FLEX =====
const userPingFlex = (msg) => ({
  type:'flex', altText:'見守りチェック',
  contents:{ type:'bubble',
    body:{ type:'box', layout:'vertical', contents:[
      { type:'text', text: msg, weight:'bold', size:'md', wrap:true },
      { type:'button', style:'primary', action:{ type:'postback', label:'OKだよ💖', data:'watch:ok' } },
    ]},
  },
});
const remindFlex = () => ({
  type:'flex', altText:'見守りリマインド',
  contents:{ type:'bubble', body:{ type:'box', layout:'vertical', contents:[
    { type:'text', text:'【見守りリマインド】', weight:'bold', size:'lg', color:'#555' },
    { type:'text', text:'24時間以内にお返事がないよ。体調は大丈夫？', wrap:true, margin:'md', color:'#666' },
  ]},
  footer:{ type:'box', layout:'vertical', contents:[
    { type:'button', style:'secondary', action:{ type:'postback', label:'OKだよ💖', data:'watch:ok' } },
  ]}},
});
const maskPhone = v => v ? String(v).replace(/(\d{3})(\d+)(\d{2})/, (_,a,b,c)=>`${a}****${c}`) : '未登録';
const groupAlertFlex = (u) => ({
  type:'flex', altText:'見守りアラート',
  contents:{ type:'bubble', body:{ type:'box', layout:'vertical', spacing:'sm', contents:[
    { type:'text', text:'🚨未応答アラート', weight:'bold', size:'lg', color:'#C00' },
    { type:'text', text:`ユーザー名: ${u.name || '未登録'}`, wrap:true },
    { type:'text', text:`住所: ${u.address || '未登録'}`, wrap:true },
    { type:'text', text:`本人TEL: ${maskPhone(u.phone)}`, wrap:true },
    { type:'text', text:`緊急連絡先: ${maskPhone(u.emergencyContactPhone)}`, wrap:true },
  ]}}},
});

// ===== UTIL =====
async function safePush(to, messages){
  const arr = Array.isArray(messages) ? messages : [messages];
  try { await client.pushMessage(to, arr); }
  catch(e){ console.error('[ERR] LINE push failed:', e?.response?.data || e?.message || e); }
}
async function scheduleNextPing(userId, from=new Date()){
  const nextAt = nextPingAtFrom(from);
  await db.collection('users').doc(userId).set({
    watchService:{
      nextPingAt: Timestamp.fromDate(nextAt),
      awaitingReply:false,
      status:WATCH_STATUS.NONE,
      lastPingAt: firebaseAdmin.firestore.FieldValue.delete(),
      lastReminderAt: firebaseAdmin.firestore.FieldValue.delete(),
      lastNotifiedAt: firebaseAdmin.firestore.FieldValue.delete(),
      notifyLockExpiresAt: firebaseAdmin.firestore.FieldValue.delete(),
    }
  },{merge:true});
}

// ===== 本処理 =====
async function checkAndSendPing(){
  const now = dayjs().tz(JST_TZ);
  const snap = await db.collection('users').where('watchService.enabled','==',true).limit(200).get();
  if (snap.empty) return;
  const groupId = await getActiveWatchGroupId();

  await Promise.all(snap.docs.map(async (doc)=>{
    const ref = doc.ref;
    const u = doc.data() || {};
    const ws = u.watchService || {};
    const awaiting = !!ws.awaitingReply;
    const lastPingAt = ws.lastPingAt?.toDate?.()? dayjs(ws.lastPingAt.toDate()).tz(JST_TZ): null;
    const lastReminderAt = ws.lastReminderAt?.toDate?.()? dayjs(ws.lastReminderAt.toDate()).tz(JST_TZ): null;
    const status = ws.status || WATCH_STATUS.NONE;

    let mode = (!awaiting) ? 'ping' : 'noop';
    if (awaiting && lastPingAt) {
      const hrs = now.diff(lastPingAt, 'hour');
      if (status===WATCH_STATUS.WAITING  && hrs>=REMINDER_AFTER_HOURS) mode='remind';
      if (status===WATCH_STATUS.REMINDED){
        const hrsRem = lastReminderAt ? now.diff(lastReminderAt,'hour') : 0;
        if (hrsRem>=REMIND_GAP_HOURS || hrs>=ESCALATE_AFTER_HOURS) mode='escalate';
      }
    }

    if (mode==='ping') {
      await safePush(doc.id, [
        { type:'text', text:`${pickMsg()} 大丈夫なら「OKだよ💖」を押してね！` },
        userPingFlex(pickMsg()),
      ]);
      await ref.set({
        watchService:{ lastPingAt: Timestamp.fromDate(now.toDate()), awaitingReply:true, status:WATCH_STATUS.WAITING,
          lastReminderAt: firebaseAdmin.firestore.FieldValue.delete(),
          lastNotifiedAt: firebaseAdmin.firestore.FieldValue.delete(),
          notifyLockExpiresAt: firebaseAdmin.firestore.FieldValue.delete(),
        }
      },{merge:true});

    } else if (mode==='remind') {
      if (status===WATCH_STATUS.REMINDED) return;
      await safePush(doc.id, [
        { type:'text', text:`${pickMsg()} 昨日のOKまだ受け取れてないの… 大丈夫ならボタン押してね！` },
        remindFlex(),
      ]);
      await ref.set({ watchService:{ lastReminderAt: Timestamp.fromDate(now.toDate()), status:WATCH_STATUS.REMINDED } },{merge:true});

    } else if (mode==='escalate') {
      if (!groupId) return;
      await safePush(groupId, groupAlertFlex(u));
      await ref.set({
        watchService:{ lastNotifiedAt: Timestamp.fromDate(now.toDate()), awaitingReply:false, status:WATCH_STATUS.ALERTED,
          nextPingAt: Timestamp.fromDate(nextPingAtFrom(now.toDate())) }
      },{merge:true});
    }
  }));
}

// ===== Webhook（常駐時）=====
const lineMiddleware = middleware({ channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN, channelSecret: LINE_CHANNEL_SECRET });
app.post('/webhook', lineMiddleware, async (req,res)=>{
  res.sendStatus(200);
  const events = req.body.events || [];
  for (const ev of events) {
    if (ev.type==='postback' && ev.postback?.data==='watch:ok') {
      const userId = ev.source.userId;
      const ref = db.collection('users').doc(userId);
      await ref.set({ watchService:{ awaitingReply:false, lastReplyAt:Timestamp.now(), status:WATCH_STATUS.NONE } },{merge:true});
      await scheduleNextPing(userId);
      await client.replyMessage(ev.replyToken, [{ type:'text', text:'OK、受け取ったよ！💖 ありがとう😊' }]);
    }
  }
});

// ===== エントリーポイント =====
if (WATCH_RUNNER === 'external') {
  (async () => {
    console.log('▶ watch-service one-shot start');
    try { await checkAndSendPing(); console.log('✅ watch-service done'); process.exit(0); }
    catch (e){ console.error('❌ watch-service failed', e?.response?.data || e?.message || e); process.exit(1); }
  })();
} else {
  app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
}
