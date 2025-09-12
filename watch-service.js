'use strict';

/*
 watch-service.js (refined 2025-09-12 full version)
 - Renderスケジューラ向けワンショット実行
 - 9-8版の安定ロジックをベースに統合
 - axiosにkeepAlive/timeoutを設定
 - グループ通知は Firestore `system/watch_group` を参照
 - 見守り個別通知: カラーボタン / グループ通知FLEX: モノトーン + ユーザー情報表示
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
dayjs.extend(utc);
dayjs.extend(timezone);

const _splitter = new GraphemeSplitter();
const toGraphemes = (s) => _splitter.splitGraphemes(String(s || ''));

const { Client, middleware } = require('@line/bot-sdk');

// === Logging ===
const LV = { error: 0, warn: 1, info: 2, debug: 3 };
const LOG_LEVEL = (process.env.WATCH_LOG_LEVEL || 'info').toLowerCase();
const LV_ALLOW = LV[LOG_LEVEL] ?? LV.info;
const log = (lvl, ...args) => { if ((LV[lvl] ?? LV.debug) <= LV_ALLOW) console.log(...args) };
const logErr = (msg, err) => {
  const detail = err?.response?.data || err?.message || err;
  console.error(`[ERR] ${msg}`, detail);
};

// === Env ===
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET       = process.env.LINE_CHANNEL_SECRET;
const OWNER_USER_ID             = process.env.OWNER_USER_ID || null;

const WATCH_RUNNER = process.env.WATCH_RUNNER || 'internal';

let creds = null;
if (process.env.FIREBASE_CREDENTIALS_BASE64) {
  creds = JSON.parse(Buffer.from(process.env.FIREBASE_CREDENTIALS_BASE64, "base64").toString("utf-8"));
}
if (!firebaseAdmin.apps.length) {
  if (!creds) {
    try { creds = require("./serviceAccountKey.json"); }
    catch { throw new Error("FIREBASE_CREDENTIALS_BASE64 or serviceAccountKey.json required"); }
  }
  firebaseAdmin.initializeApp({ credential: firebaseAdmin.credential.cert(creds) });
  console.log("✅ Firebase initialized");
}
const db = firebaseAdmin.firestore();
const Timestamp = firebaseAdmin.firestore.Timestamp;

// LINE client
const client = new Client({ channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN, channelSecret: LINE_CHANNEL_SECRET });

// HTTP client
const httpAgent = new httpMod.Agent({ keepAlive: true });
const httpsAgent = new httpsMod.Agent({ keepAlive: true });
const http = axios.create({ timeout: 6000, httpAgent, httpsAgent });

// === 見守り設定 ===
const JST_TZ = 'Asia/Tokyo';
const PING_INTERVAL_DAYS   = 3;
const REMINDER_AFTER_HOURS = 24;
const ESCALATE_AFTER_HOURS = 29;
const REMIND_GAP_HOURS     = ESCALATE_AFTER_HOURS - REMINDER_AFTER_HOURS;

// === 定型文 ===
const watchMessages = [
  "こんにちは🌸 こころちゃんだよ！ 今日も元気にしてるかな？💖",
  "やっほー！ こころだよ😊 いつも応援してるね！",
  "元気にしてる？✨ こころちゃん、あなたのこと応援してるよ💖",
  "ねぇねぇ、こころだよ🌸 今日はどんな一日だった？",
  "いつもがんばってるあなたへ、こころからメッセージを送るね💖",
  "こんにちは😊 困ったことはないかな？いつでも相談してね！",
  "やっほー🌸 こころだよ！何かあったら、こころに教えてね💖",
  "元気出してね！こころちゃん、あなたの味方だよ😊",
  "こころちゃんだよ🌸 今日も一日お疲れ様💖",
  "やっほー！ こころだよ🌸 素敵な日になりますように💖",
];
const pickWatchMsg = () =>
  watchMessages[Math.floor(Math.random() * watchMessages.length)];

const nextPingAtFrom = (fromDate) =>
  dayjs(fromDate).tz(JST_TZ).add(PING_INTERVAL_DAYS, 'day')
    .hour(15).minute(0).second(0).millisecond(0).toDate();

// === Firestore: watch_group ===
const getWatchGroupDoc = () => db.collection('system').doc('watch_group');
async function getActiveWatchGroupId() {
  const snap = await getWatchGroupDoc().get();
  const gid = snap.exists ? (snap.data().groupId || '') : '';
  return /^C[0-9A-Za-z]+$/.test(gid) ? gid : null;
}

// === FLEX生成 ===
const telBtn = (label, tel) => {
  if (!tel) return null;
  return { type:'button', style:'primary', height:'sm',
           action:{ type:'uri', label, uri:`tel:${tel}` } };
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
      { type:'text', text:'【見守りリマインド】', weight:'bold', size:'lg', color:'#555555' },
      { type:'text', text:'24時間以内にお返事がないよ。体調は大丈夫？', wrap:true, margin:'md', color:'#666666' }
    ]},
    styles:{ body:{ backgroundColor:'#f5f5f5' } },
    footer:{ type:'box', layout:'vertical', spacing:'sm', contents:[
      { type:'button', style:'secondary', action:{ type:'postback', label:'OKだよ💖', data:'watch:ok' } }
    ]}
  }
});

const buildGroupAlertFlex = (info) => ({
  type:'flex',
  altText:'見守りアラート',
  contents:{
    type:'bubble',
    size:'mega',
    body:{
      type:'box', layout:'vertical', spacing:'sm', contents:[
        { type:'text', text:'🚨未応答アラート', weight:'bold', size:'lg', color:'#CC0000' },
        { type:'text', text:`ユーザー名: ${info.name || '未登録'}`, wrap:true },
        { type:'text', text:`住所: ${info.selfAddress || '未登録'}`, wrap:true },
        { type:'text', text:`本人TEL: ${maskPhone(info.selfPhone)}`, wrap:true },
        { type:'text', text:`緊急連絡先: ${maskPhone(info.kinPhone)}`, wrap:true },
        { type:'text', text:`最後のメッセージ: ${info.excerpt}`, wrap:true, wrap:true }
      ]
    },
    styles:{ body:{ backgroundColor:'#eeeeee' } }
  }
});

function maskPhone(num){
  if(!num) return '未登録';
  return num.replace(/(\d{3})(\d+)(\d{2})/, (m,a,b,c)=>`${a}****${c}`);
}

// === スケジュール管理 ===
async function scheduleNextPing(userId, fromDate = new Date()) {
  const nextAt = dayjs(fromDate).tz(JST_TZ).add(PING_INTERVAL_DAYS,'day')
    .hour(15).minute(0).second(0).millisecond(0).toDate();
  await db.collection('users').doc(userId).set({
    watchService:{
      nextPingAt: Timestamp.fromDate(nextAt),
      awaitingReply:false,
      status:WATCH_STATUS.NONE,
      lastPingAt: firebaseAdmin.firestore.FieldValue.delete(),
      lastReminderAt: firebaseAdmin.firestore.FieldValue.delete(),
      lastNotifiedAt: firebaseAdmin.firestore.FieldValue.delete(),
      notifyLockExpiresAt: firebaseAdmin.firestore.FieldValue.delete()
    }
  },{merge:true});
}

// === 安全Push ===
async function safePush(to, messages){
  const arr = Array.isArray(messages)?messages:[messages];
  try{
    await client.pushMessage(to, arr);
    log('info','[OK] push sent',to);
  }catch(e){ logErr('LINE push failed',e); }
}

// === 見守り処理 ===
async function checkAndSendPing(){
  const now = dayjs().tz(JST_TZ);
  const usersRef = db.collection('users');
  const snap = await usersRef.where('watchService.enabled','==',true).limit(200).get();
  if(snap.empty) return;

  const officerGid = await getWatchGroupDoc().then(s=>s.exists?(s.data().groupId||''):'');

  await Promise.all(snap.docs.map(async (doc)=>{
    const ref = doc.ref;
    const u = doc.data() || {};
    const ws = u.watchService || {};
    const awaiting   = !!ws.awaitingReply;
    const lastPingAt = ws.lastPingAt?.toDate?.()? dayjs(ws.lastPingAt.toDate()).tz(JST_TZ): null;
    const lastRemindAt = ws.lastReminderAt?.toDate?.()? dayjs(ws.lastReminderAt.toDate()).tz(JST_TZ): null;
    const lastNotifiedAt = ws.lastNotifiedAt?.toDate?.()? dayjs(ws.lastNotifiedAt.toDate()): null;
    const status = ws.status || WATCH_STATUS.NONE;

    let mode = (!awaiting)? 'ping':'noop';
    if(awaiting && lastPingAt){
      const hrsSincePing = now.diff(lastPingAt,'hour');
      if(status===WATCH_STATUS.WAITING && hrsSincePing>=REMINDER_AFTER_HOURS){
        mode='remind';
      }
      if(status===WATCH_STATUS.REMINDED){
        const hrsSinceRemind = lastRemindAt? now.diff(lastRemindAt,'hour'):0;
        if((hrsSinceRemind>=REMIND_GAP_HOURS || hrsSincePing>=ESCALATE_AFTER_HOURS)){
          mode='escalate';
        }
      }
    }

    if(mode==='ping'){
      await safePush(doc.id, [
        { type:'text', text:`${pickWatchMsg()} 大丈夫なら「OKだよ💖」を押してね！` },
        buildUserPingFlex(pickWatchMsg())
      ]);
      await ref.set({
        watchService:{
          lastPingAt: Timestamp.fromDate(now.toDate()),
          awaitingReply:true,
          status:WATCH_STATUS.WAITING,
          lastReminderAt: firebaseAdmin.firestore.FieldValue.delete(),
          lastNotifiedAt: firebaseAdmin.firestore.FieldValue.delete(),
          notifyLockExpiresAt: firebaseAdmin.firestore.FieldValue.delete()
        }
      },{merge:true});
    } else if(mode==='remind'){
      if(status===WATCH_STATUS.REMINDED) return;
      await safePush(doc.id, [
        { type:'text', text:`${pickWatchMsg()} 昨日の見守りのOKまだ受け取れてないの… 大丈夫ならボタン押してね！` },
        buildRemindFlex()
      ]);
      await ref.set({
        watchService:{ lastReminderAt: Timestamp.fromDate(now.toDate()), status:WATCH_STATUS.REMINDED }
      },{merge:true});
    } else if(mode==='escalate'){
      if(!officerGid) return;
      const alertFlex = buildGroupAlertFlex({
        kind:'未応答',
        name: u.name || '未登録',
        selfAddress: u.address || '',
        selfPhone: u.phone || '',
        kinName: u.emergencyContactName || '',
        kinPhone: u.emergencyContactPhone || '',
        excerpt: text || ''
      });
      await safePush(officerGid,[alertFlex]);
      await ref.set({
        watchService:{
          lastNotifiedAt: Timestamp.fromDate(now.toDate()),
          awaitingReply:false,
          status:WATCH_STATUS.ALERTED,
          nextPingAt: Timestamp.fromDate(nextPingAtFrom(now.toDate()))
        }
      },{merge:true});
    }
  }));
}

// === Webhook (受信専用) ===
const lineMiddleware = middleware({ channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN, channelSecret: LINE_CHANNEL_SECRET });

app.post('/webhook', lineMiddleware, async (req,res)=>{
  res.sendStatus(200);
  const events=req.body.events||[];
  for(const ev of events){
    if(ev.type==='postback') await handlePostbackEvent(ev,ev.source.userId);
    if(ev.type==='message')  await handleEvent(ev);
  }
});

// === Postback Handler ===
async function handlePostbackEvent(event,userId){
  if(event.postback.data==='watch:ok'){
    const ref=db.collection('users').doc(userId);
    await ref.set({
      watchService:{ awaitingReply:false, lastReplyAt:Timestamp.now(), status:WATCH_STATUS.NONE }
    },{merge:true});
    await scheduleNextPing(userId);
    await client.replyMessage(event.replyToken,[{type:'text',text:'OK、受け取ったよ！💖 ありがとう😊'}]);
  }
}

// === Message Handler ===
async function handleEvent(event){
  const userId=event.source.userId;
  const text=event.message.type==='text'?event.message.text:'';
  const stickerId=event.message.type==='sticker'?event.message.stickerId:'';

  const u=(await db.collection('users').doc(userId).get()).data()||{};
  if(u.watchService?.enabled && u.watchService?.awaitingReply){
    const okByText=/^(ok|okだよ|大丈夫|はい|元気)/i.test(text);
    const okBySticker=/^(11537|11538|52002734|52002735)$/.test(stickerId);
    if(okByText||okBySticker){
      const ref=db.collection('users').doc(userId);
      await ref.set({
        watchService:{awaitingReply:false,lastReplyAt:Timestamp.now(),status:WATCH_STATUS.NONE}
      },{merge:true});
      await scheduleNextPing(userId);
      await client.replyMessage(event.replyToken,[{type:'text',text:'OK、受け取ったよ！💖 ありがとう😊'}]);
    }
  }
}

// === エントリーポイント ===
if (WATCH_RUNNER === 'external') {
  (async()=>{
    log('info','▶ watch-service one-shot start');
    try {
      await checkAndSendPing();
      log('info','✅ watch-service done');
      process.exit(0);
    } catch(e){
      logErr('❌ watch-service failed',e);
      process.exit(1);
    }
  })();
} else {
  app.listen(PORT,()=>console.log(`Listening on port ${PORT}`));
}
