'use strict';

/*
 watch-service.js (9-8js 安定ロジック)
 - Renderスケジューラから "node watch-service.js" で呼び出す
 - 3日に1度 15:00 に見守りメッセージ送信
 - OKなら3日後に再スケジュール
 - OKがない場合 24時間後にリマインド
 - リマインド後さらに5時間反応がなければグループ通知
*/

const axios = require('axios');
const firebaseAdmin = require('firebase-admin');
const { Client } = require('@line/bot-sdk');
const httpMod = require('http');
const httpsMod = require('https');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const GraphemeSplitter = require('grapheme-splitter');
dayjs.extend(utc);
dayjs.extend(timezone);

const splitter = new GraphemeSplitter();
const toGraphemes = (s) => splitter.splitGraphemes(String(s || ''));

// === Env ===
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET       = process.env.LINE_CHANNEL_SECRET;
const OWNER_USER_ID             = process.env.OWNER_USER_ID || null;

let creds = null;
if (process.env.FIREBASE_CREDENTIALS_BASE64) {
  try {
    creds = JSON.parse(Buffer.from(process.env.FIREBASE_CREDENTIALS_BASE64, "base64").toString("utf-8"));
  } catch (e) {
    console.error("❌ FIREBASE_CREDENTIALS_BASE64 をパースできません:", e);
    process.exit(1);
  }
}
if (!firebaseAdmin.apps.length) {
  if (!creds) {
    try { creds = require("./serviceAccountKey.json"); }
    catch {
      console.error("❌ Firebase 認証情報が見つかりません");
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

// === 設定値 ===
const JST_TZ = 'Asia/Tokyo';
const PING_INTERVAL_DAYS   = 3;
const REMINDER_AFTER_HOURS = 24;
const ESCALATE_AFTER_HOURS = 29;
const REMIND_GAP_HOURS     = ESCALATE_AFTER_HOURS - REMINDER_AFTER_HOURS;

const WATCH_STATUS = {
  WAITING:   'waiting',   // ping直後
  REMINDED:  'reminded',  // リマインド送信済
  ALERTED:   'alerted',   // 通報済
  NONE:      'none'
};

// === メッセージ候補 ===
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
  "やっほー！こころだよ🌸 よく頑張ってるね！",
  "水分補給は忘れずにね💧",
  "少し休憩して深呼吸しよ🌿",
  "無理しなくていいんだよ😉",
  "あなたのがんばり、見てるよ👀",
  "大丈夫？ いつでも声かけてね📱",
  "気分転換にお散歩どう？🚶",
  "リラックスする時間も大事だよ🛋️",
  "今日も一歩ずつ進んでるよ✨",
  "笑顔は最高の魔法だよ😊",
  "こころちゃんがそばにいるよ💖",
  "一緒にがんばろうね！🤝",
  "今日もよく頑張ってる！🌸",
  "お水飲んだ？🍵",
  "ちょっと休んでね☕",
  "心配してるよ、大丈夫かな？",
  "きっと明日はもっと良い日になるよ🌞",
  "いつでも相談してね💬",
  "今日も素敵な自分でいよう✨",
  "無理せずマイペースでね🐢",
  "こころから応援してるよ💖"
];
const pickWatchMsg = () =>
  watchMessages[Math.floor(Math.random() * watchMessages.length)];

// === 共通部品 ===
const okQuickReply = {
  items: [
    { type:'action', action:{ type:'message', label:'OKだよ💖', text:'OKだよ' } }
  ]
};

function buildUserPingFlex(msg){
  return {
    type:'flex',
    altText:'見守りチェック',
    contents:{
      type:'bubble',
      body:{ type:'box', layout:'vertical', contents:[
        { type:'text', text:msg, weight:'bold', size:'md', wrap:true },
        { type:'button', style:'primary', height:'sm',
          action:{ type:'postback', label:'OKだよ💖', data:'watch:ok' } }
      ]}
    }
  };
}

function buildRemindFlex(){
  return {
    type:'flex',
    altText:'見守りリマインド',
    contents:{
      type:'bubble',
      size:'mega',
      body:{
        type:'box', layout:'vertical', spacing:'sm', contents:[
          { type:'text', text:'【見守りリマインド】', weight:'bold', size:'lg', color:'#555' },
          { type:'text', text:'24時間以内にお返事がないよ。大丈夫ならOK押してね！', wrap:true, margin:'md', color:'#666' },
          { type:'button', style:'secondary',
            action:{ type:'postback', label:'OKだよ💖', data:'watch:ok' } }
        ]
      },
      styles:{ body:{ backgroundColor:'#f5f5f5' } }
    }
  };
}

function maskPhone(num){
  if(!num) return '未登録';
  return num.replace(/(\d{3})(\d+)(\d{2})/, (m,a,b,c)=>`${a}****${c}`);
}

const getWatchGroupDoc = () => db.collection('system').doc('watch_group');
async function getActiveWatchGroupId(){
  const snap = await getWatchGroupDoc().get();
  const gid  = snap.exists ? (snap.data().groupId||''): '';
  return /^C[0-9A-Za-z]+$/.test(gid)? gid : null;
}

function nextPingAtFrom(fromDate){
  return dayjs(fromDate).tz(JST_TZ)
    .add(PING_INTERVAL_DAYS,'day')
    .hour(15).minute(0).second(0).millisecond(0)
    .toDate();
}

async function safePush(to,messages){
  const arr = Array.isArray(messages)?messages:[messages];
  try{
    await client.pushMessage(to,arr);
    log('info','[OK] push sent',to);
  }catch(e){ logErr('LINE push failed',e); }
}

// === 見守り処理 ===
async function checkAndSendPing(){
  const now = dayjs().tz(JST_TZ);
  const snap = await db.collection('users')
    .where('watchService.enabled','==',true)
    .limit(200).get();
  if(snap.empty) return;

  const groupId = await getWatchGroupDoc().then(s=>s.exists?(s.data().groupId||''):'');

  await Promise.all(snap.docs.map(async (doc)=>{
    const ref = doc.ref;
    const u = doc.data() || {};
    const ws = u.watchService || {};
    const awaiting = !!ws.awaitingReply;
    const lastPingAt = ws.lastPingAt?.toDate?.()? dayjs(ws.lastPingAt.toDate()).tz(JST_TZ): null;
    const lastRemindAt = ws.lastReminderAt?.toDate?.()? dayjs(ws.lastReminderAt.toDate()).tz(JST_TZ): null;
    const lastNotifiedAt = ws.lastNotifiedAt?.toDate?.()? dayjs(ws.lastNotifiedAt.toDate()): null;
    const status = ws.status || WATCH_STATUS.NONE;
    const nextPingAt = ws.nextPingAt?.toDate?.()? dayjs(ws.nextPingAt.toDate()).tz(JST_TZ): null;

    let mode='noop';
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
    else if(mode==='remind'){
      if(status===WATCH_STATUS.REMINDED) return;
      await safePush(doc.id, [
        { type:'text', text:`リマインド🌸 昨日のOKまだ受け取れてないの… 大丈夫なら押してね！`, quickReply: okQuickReply },
        buildRemindFlex()
      ]);
      await ref.set({
        watchService:{ lastReminderAt: Timestamp.fromDate(now.toDate()), status:WATCH_STATUS.REMINDED }
      },{merge:true});
    }
    else if(mode==='escalate'){
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
  }));
}

// === 実行エントリポイント ===
if (WATCH_RUNNER === 'external') {
  (async()=>{
    console.log("▶ ウォッチサービス 一発スタート");
    try {
      await checkAndSendPing();
      console.log("✅ 見守りサービス 完了");
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
      if(ev.type==='message')  await handleMessageEvent(ev);
    }
  });

  async function handlePostbackEvent(event,userId){
    if(event.postback.data==='watch:ok'){
      const ref=db.collection('users').doc(userId);
      await ref.set({
        watchService:{ awaitingReply:false,lastReplyAt:Timestamp.now(),status:WATCH_STATUS.NONE }
      },{merge:true});
      await scheduleNextPing(userId);
      await client.replyMessage(event.replyToken,[{type:'text',text:'OK、受け取ったよ！💖 ありがとう😊'}]);
    }
  }

  async function handleMessageEvent(event){
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
          watchService:{awaitingReply:false,lastReplyAt:Timestamp.fromDate(dayjs().tz(JST_TZ).toDate()),status:WATCH_STATUS.NONE}
        },{merge:true});
        await scheduleNextPing(userId);
        await client.replyMessage(event.replyToken,[{type:'text',text:'OK、受け取ったよ💖 ありがとう😊'}]);
      }
    }
  }

  app.listen(PORT,()=>console.log(`Listening on port ${PORT}`));
}
