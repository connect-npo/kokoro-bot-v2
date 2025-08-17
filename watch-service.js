// watch-service.js — 3d -> 24h -> +5h escalator
"use strict";
require("dotenv").config();
const { Client } = require("@line/bot-sdk");
const admin = require("firebase-admin");

// Firebase
let creds = null;
if (process.env.FIREBASE_CREDENTIALS_BASE64) {
  creds = JSON.parse(Buffer.from(process.env.FIREBASE_CREDENTIALS_BASE64, "base64").toString("utf-8"));
}
if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(creds || require("./serviceAccountKey.json")) });
  console.log("✅ Firebase initialized (watch)");
}
const db = admin.firestore();
const Timestamp = admin.firestore.Timestamp;

// LINE
const client = new Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET || process.env.CHANNEL_SECRET,
});

const OFFICER_GROUP_ID = process.env.OFFICER_GROUP_ID || process.env.OWNER_USER_ID;

// ⭐見守りサービスの定期実行処理 (cron) - ここから貼り付け⭐
// 3日に一度のランダム見守りメッセージ一覧（30通り）
const watchMessages = [
    "こんにちは🌸 こころちゃんだよ！ 今日も元気にしてるかな？💖",
    "やっほー！ こころだよ😊 いつも応援してるね！",
    "元気にしてる？✨ こころちゃん、あなたのこと応援してるよ💖",
    "ねぇねぇ、こころだよ🌸 今日はどんな一日だった？",
    "いつもがんばってるあなたへ、こころからメッセージを送るね💖",
    "お元気ですか？こころちゃんです😊 素敵な一日を過ごせていますように！",
    "こんにちは！こころだよ🌸 毎日がんばっていて偉いね✨",
    "やっほー！今日も一日お疲れ様💖 少しでもホッとできる時間がありますように。",
    "ねぇ、こころだよ😊 困ったことがあったらいつでも話してね！",
    "こんにちは🌸 あなたのことが気になってメッセージしちゃった💖",
    "やっほー！こころちゃんです😊 元気に過ごしてるかな？",
    "元気出してね！こころちゃんはいつもあなたの味方だよ💖",
    "こんにちは✨ こころちゃん、あなたのことを想ってるよ😊",
    "やっほー！気分転換に何か楽しいこと見つかったかな？💖",
    "元気かな？🌸 こころだよ！もしよかったらお話しようね😊",
    "こんにちは💖 こころちゃんです！あなたの笑顔が見たいな✨",
    "やっほー😊 久しぶりにメッセージしちゃった！元気にしてる？",
    "ねぇ、こころだよ🌸 今、何してるのかな？💖",
    "元気？😊 こころちゃんです！何か良いことあった？",
    "こんにちは✨ こころだよ！もし疲れたら無理しないでね💖",
    "やっほー！今日も一日お疲れ様🌸 ゆっくり休んでね😊",
    "ねぇねぇ、こころだよ💖 忙しい毎日だけど、息抜きも大切だよ✨",
    "元気にしてるかな？こころちゃんはいつもここにいるよ😊",
    "こんにちは！🌸 こころだよ！あなたのこと、いつも考えてるよ💖",
    "やっほー！こころちゃんです😊 お話するの、楽しみにしているね！",
    "元気？💖 もしよかったら、最近のことを話してくれないかな？",
    "こんにちは✨ こころだよ！何か手伝えることがあったら言ってね😊",
    "やっほー！今日もがんばってるね🌸 応援してるよ💖",
    "ねぇ、こころだよ😊 あなたの存在が、私にとって大切だよ✨",
    "元気かな？💖 こころちゃんです！あなたの毎日が幸せでありますように！"
];


function jstHour(date = new Date()) { return (date.getUTCHours() + 9) % 24; }

async function push(to, message) {
  try { await client.pushMessage(to, Array.isArray(message) ? message : [message]); }
  catch (e) { console.error("push error:", e.message); }
}

async function run() {
  console.log("⏰ watch-service tick");
  const users = await db.collection("users").where("watchServiceEnabled", "==", true).get();
  const now = Date.now();
  const THREE_D = 3*24*60*60*1000;
  const ONE_D  = 24*60*60*1000;
  const FIVE_H = 5*60*60*1000;

  for (const d of users.docs) {
    const userId = d.id;
    const u = d.data();
    const lastResponse = (u.lastResponseAt?.toMillis?.() ?? u.createdAt?.toMillis?.() ?? now);
    const firstAt = u.firstReminderSentAt?.toMillis?.() ?? null;
    const secondAt = u.secondReminderSentAt?.toMillis?.() ?? null;

    // Step 1: 3日経過 & JST 15:00 で初回
    if (!firstAt && now - lastResponse >= THREE_D && jstHour() === 15) {
      const msg = WATCH_MESSAGES[Math.floor(Math.random()*WATCH_MESSAGES.length)];
      console.log(`💬 first reminder -> ${userId}`);
      await push(userId, { type:"text", text: msg });
      await db.collection("users").doc(userId).set({ firstReminderSentAt: Timestamp.now() }, { merge:true });
      continue;
    }

    // Step 2: 初回から24h（いつの時刻でも可）
    if (firstAt && !secondAt && now - firstAt >= ONE_D) {
      console.log(`🔔 second reminder -> ${userId}`);
      await push(userId, { type:"text", text:"こんにちは！昨日のメッセージ見てくれたかな？心配してるよ。スタンプでもOKだよ🌸" });
      await db.collection("users").doc(userId).set({ secondReminderSentAt: Timestamp.now() }, { merge:true });
      continue;
    }

    // Step 3: 2回目から5h → オフィサー通知 & 停止
    if (secondAt && now - secondAt >= FIVE_H) {
      console.log(`🚨 emergency notify -> ${userId}`);
      if (OFFICER_GROUP_ID) {
        await push(OFFICER_GROUP_ID, { type:"text", text:`【緊急】ユーザー ${u.displayName || userId} さんが29時間応答なし。ご確認ください。` });
      }
      await db.collection("users").doc(userId).set({ watchServiceEnabled:false }, { merge:true });
      continue;
    }
  }
}

if (require.main === module) {
  run().then(()=>{ console.log("🏁 watch-service done"); process.exit(0); })
      .catch(e=>{ console.error("watch-service failed:", e); process.exit(1); });
}
