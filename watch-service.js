'use strict';

/*
  watch-service.js (2025-09-13 完全版)
  - Renderスケジューラ用のワンショット実行
  - 9-8js 安定版ロジックを基盤に統合
  - axios keepAlive/timeout 設定済み
  - グループ通知先は Firestore の system/watch_group から取得
  - 個別 ping: テキスト + クイックリプライ + FLEX ボタン
  - リマインド: モノトーンFLEX
  - Escalate: グループにユーザー情報付き FLEX を送信
*/

const express = require('express');
const axios = require('axios');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');
const firebaseAdmin = require('firebase-admin');
const crypto = require('crypto');
const GraphemeSplitter = require('grapheme-splitter');
const { URL, URLSearchParams } = require('url');
const httpMod = require('http');
const httpsMod = require('https');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const isSameOrAfter = require('dayjs/plugin/isSameOrAfter');
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(isSameOrAfter);

const _splitter = new GraphemeSplitter();
const toGraphemes = (s) => _splitter.splitGraphemes(String(s || ''));

const { Client, middleware } = require('@line/bot-sdk');

// === Logging ===
const LV = { error: 0, warn: 1, info: 2, debug: 3 };
const LOG_LEVEL = (process.env.WATCH_LOG_LEVEL || 'info').toLowerCase();
const LV_ALLOW = LV[LOG_LEVEL] ?? LV.info;
const log = (lvl, ...args) => { if ((LV[lvl] ?? LV.debug) <= LV_ALLOW) console.log(...args); };
const logErr = (msg, err) => {
  const detail = err?.response?.data || err?.message || err;
  console.error(`[ERR] ${msg}`, detail);
};

// === Env ===
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET       = process.env.LINE_CHANNEL_SECRET;
const OWNER_USER_ID             = process.env.OWNER_USER_ID || null;
const WATCH_RUNNER              = process.env.WATCH_RUNNER || 'internal';

// Firebase init
let creds = null;
if (process.env.FIREBASE_CREDENTIALS_BASE64) {
  try {
    creds = JSON.parse(
      Buffer.from(process.env.FIREBASE_CREDENTIALS_BASE64, "base64").toString("utf-8")
    );
  } catch (e) {
    console.error("[ERR] Failed to parse FIREBASE_CREDENTIALS_BASE64", e);
  }
}
if (!firebaseAdmin.apps.length) {
  if (!creds) {
    try { creds = require("./serviceAccountKey.json"); }
    catch {
      console.error("❌ Firebase credentials not found");
      process.exit(1);
    }
  }
  firebaseAdmin.initializeApp({ credential: firebaseAdmin.credential.cert(creds) });
  console.log("✅ Firebase initialized");
}
const db = firebaseAdmin.firestore();
const Timestamp = firebaseAdmin.firestore.Timestamp;

// LINE client
const client = new Client({
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: LINE_CHANNEL_SECRET
});

// HTTP client
const http = axios.create({
  timeout: 6000,
  httpAgent: new httpMod.Agent({ keepAlive: true }),
  httpsAgent: new httpsMod.Agent({ keepAlive: true })
});

// === 見守り設定 ===
const JST_TZ = 'Asia/Tokyo';
const PING_INTERVAL_DAYS   = 3;
const REMINDER_AFTER_HOURS = 24;
const ESCALATE_AFTER_HOURS = 29;
const REMIND_GAP_HOURS     = ESCALATE_AFTER_HOURS - REMINDER_AFTER_HOURS;

// === 状態管理 ===
const WATCH_STATUS = {
  WAITING:   'waiting',
  REMINDED:  'reminded',
  ALERTED:   'alerted',
  NONE:      'none'
};

// === メッセージ ===
const watchMessages = [
  "こんにちは🌸 こころちゃんだよ！ 今日も元気にしてるかな？💖",
  "やっほー！ こころだよ😊 いつも応援してるね！",
  "元気にしてる？✨ こころちゃん、あなたのこと応援してるよ💖",
  "ねぇねぇ、こころだよ🌸 今日はどんな一日だった？",
  "いつもがんばってるあなたへ、こころからメッセージを送るね💖",
  "こんにちは😊 困ったことはないかな？いつでも相談してね！",
  "やっほー🌸 こころだよ！何かあったら教えてね💖",
  "元気出してね！こころちゃん、あなたの味方だよ😊",
  "こころちゃんだよ🌸 今日も一日お疲れ様！",
  "やっほー！こころだよ🌸 よく休んでね💤",
  "深呼吸してみよう🍃",
  "今日はどんな楽しいことがあった？🎉",
  "きっと良いことが待ってるよ🌈",
  "焦らず、ゆっくりで大丈夫だよ🐢",
  "コーヒーでも飲んでリラックスしよう☕",
  "お天気チェックした？傘いるかな？🌂",
  "体を少し伸ばしてみよう🧘",
  "深呼吸、いっしょにしよう〜✨",
  "よく頑張ってるよ💖",
  "眠れない時はこころがいるよ🌙",
  "小さな幸せ、見つけた？🍀",
  "元気が出る音楽聴いてみよ🎶",
  "休憩も大事だよ😌",
  "あなたのペースで大丈夫だよ🙆",
  "応援してるよ📣",
  "無理しないでね🌸",
  "いつでも頼っていいんだよ🤝",
  "ちょっと外の空気吸ってこようか🌿",
  "一緒に頑張ろう💖",
  "こころちゃん、見守ってるから安心してね😊"
];
const pickWatchMsg = () =>
  watchMessages[Math.floor(Math.random() * watchMessages.length)];

// === ボタン付きメッセージ ===
const okQuickReply = {
  items: [
    { type: 'action', action: { type: 'message', label: 'OKだよ💖', text: 'OKだよ' } }
  ]
};

const buildUserPingFlex = (msg) => ({
  type:'flex',
  altText:'見守りチェック',
  contents:{
    type:'bubble',
    body:{ type:'box', layout:'vertical', contents:[
      { type:'text', text: msg, weight:'bold', size:'md', wrap:true },
      { type:'button', style:'primary', height:'sm',
        action:{ type:'postback', label:'OKだよ💖', data:'watch:ok' } }
    ]}
  }
});

const buildRemindFlex = () => ({
  type:'flex',
  altText:'見守りリマインド',
  contents:{
    type:'bubble',
    size:'mega',
    body:{ type:'box', layout:'vertical', contents:[
      { type:'text', text:'【見守りリマインド】', weight:'bold', size:'lg', color:'#555' },
      { type:'text', text:'24時間以内にお返事がないよ。大丈夫ならOK押してね！', wrap:true, margin:'md', color:'#666' },
      { type:'button', style:'secondary',
        action:{ type:'postback', label:'OKだよ💖', data:'watch:ok' } }
    ]},
    styles:{ body:{ backgroundColor:'#f5f5f5' } }
  }
});

function maskPhone(num){
  if(!num) return '未登録';
  return num.replace(/(\d{3})(\d+)(\d{2})/, (m,a,b,c)=>`${a}****${c}`);
}

async function sendGroupAlert(user){
  const groupId = await getActiveWatchGroupId();
  if(!groupId) return;
  const alertFlex = {
    type:'flex',
    altText:'見守りアラート',
    contents:{
      type:'bubble',
      size:'mega',
      body:{
        type:'box', layout:'vertical', spacing:'sm', contents:[
          { type:'text', text:'🚨未応答アラート', weight:'bold', size:'lg', color:'#CC0000' },
          { type:'text', text:`ユーザー名: ${user.name || '未登録'}`, wrap:true },
          { type:'text', text:`住所: ${user.selfAddress || '未登録'}`, wrap:true },
          { type:'text', text:`本人TEL: ${maskPhone(user.selfPhone)}`, wrap:true },
          { type:'text', text:`緊急連絡先: ${user.kinName || '未登録'} ${maskPhone(user.kinPhone)}`, wrap:true }
        ]
      },
      styles:{ body:{ backgroundColor:'#eeeeee' } }
    }
  };
  await safePush(groupId, [alertFlex]);
}

// === 見守り処理 ===
async function checkAndSendPing(){
  const now = dayjs().tz(JST_TZ);
  const snap = await db.collection('users')
    .where('watchService.enabled','==',true).limit(200).get();
  if(snap.empty) return;

  for(const doc of snap.docs){
    const ref = doc.ref;
    const u = doc.data() || {};
    const ws = u.watchService || {};
    const awaiting       = !!ws.awaitingReply;
    const lastPingAt     = ws.lastPingAt?.toDate?.()? dayjs(ws.lastPingAt.toDate()).tz(JST_TZ): null;
    const lastRemindAt   = ws.lastReminderAt?.toDate?.()? dayjs(ws.lastReminderAt.toDate()).tz(JST_TZ): null;
    const lastNotifiedAt = ws.lastNotifiedAt?.toDate?.()? dayjs(ws.lastNotifiedAt.toDate()): null;
    const status         = ws.status || WATCH_STATUS.NONE;
    const nextPingAt     = ws.nextPingAt?.toDate?.()? dayjs(ws.nextPingAt.toDate()).tz(JST_TZ): null;

    let mode = 'noop';
    const due = !nextPingAt || now.isSameOrAfter(nextPingAt);

    if(!awaiting && due){
      mode='ping';
    } else if(awaiting && lastPingAt){
      const hrsSincePing   = now.diff(lastPingAt,'hour');
      const hrsSinceRemind = lastRemindAt? now.diff(lastRemindAt,'hour'):0;
      if(status===WATCH_STATUS.WAITING && hrsSincePing>=REMINDER_AFTER_HOURS){
        mode='remind';
      }else if(status===WATCH_STATUS.REMINDED && (hrsSinceRemind>=REMIND_GAP_HOURS || hrsSincePing>=ESCALATE_AFTER_HOURS)){
        mode='escalate';
      }
    }

    if(mode==='ping'){
      const msg = pickWatchMsg();
      await safePush(doc.id, [
        { type:'text', text:`${msg} 大丈夫なら「OKだよ💖」を押してね！`, quickReply: okQuickReply },
        buildUserPingFlex(msg)
      ]);
      await ref.set({
        watchService:{
          lastPingAt: Timestamp.fromDate(now.toDate()),
          awaitingReply:true,
          status:WATCH_STATUS.WAITING,
          lastReminderAt: firebaseAdmin.firestore.FieldValue.delete(),
          lastNotifiedAt: firebaseAdmin.firestore.FieldValue.delete()
        }
      },{merge:true});
    }

    if(mode==='remind'){
      await safePush(doc.id, [
        { type:'text', text:`リマインド🌸 昨日のOKまだ受け取れてないの… 大丈夫なら押してね！`, quickReply: okQuickReply },
        buildRemindFlex()
      ]);
      await ref.set({
        watchService:{ lastReminderAt: Timestamp.fromDate(now.toDate()), status:WATCH_STATUS.REMINDED }
      },{merge:true});
    }

    if(mode==='escalate'){
      if(groupId){
        await sendGroupAlert(u);
        await ref.set({
          watchService:{
            lastNotifiedAt: Timestamp.fromDate(now.toDate()),
            awaitingReply:false,
            status:WATCH_STATUS.ALERTED,
            nextPingAt: Timestamp.fromDate(nextPingAtFrom(now.toDate()))
          }
        },{merge:true});
      }
    }
  }
}

// === エントリーポイント ===
if (WATCH_RUNNER === 'external') {
  (async()=>{
    console.log("▶ ウォッチサービス 一発 スタート");
    try {
      await checkAndSendPing();
      console.log("✅ 時計サービス 完了");
      process.exit(0);
    } catch(e){
      console.error("❌ watch-service failed", e);
      process.exit(1);
    }
  })();
} else {
  const app = express();
  const PORT = process.env.PORT || 3000;
  app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 2));
  app.use(helmet());
  app.use('/webhook', rateLimit({ windowMs: 60_000, max: 100 }));

  const lineMiddleware = middleware({ channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN, channelSecret: LINE_CHANNEL_SECRET });
  app.post('/webhook', lineMiddleware, async (req,res)=>{
    res.sendStatus(200);
    const events=req.body.events||[];
    for(const ev of events){
      if(ev.type==='postback') await handlePostbackEvent(ev,ev.source.userId);
      if(ev.type==='message')  await handleEvent(ev);
    }
  });

  app.listen(PORT,()=>console.log(`Listening on port ${PORT}`));
}
