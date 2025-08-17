// watch-service.js — 3d -> 24h -> +5h escalator
"use strict";
require("dotenv").config();
const { Client } = require("@line/bot-sdk");
const admin = require("firebase-admin");

// ---------- Firebase ----------
let creds = null;
if (process.env.FIREBASE_CREDENTIALS_BASE64) {
  creds = JSON.parse(Buffer.from(process.env.FIREBASE_CREDENTIALS_BASE64, "base64").toString("utf-8"));
}
if (!admin.apps.length) {
  if (!creds) {
    // ローカル鍵が無ければ明示エラー
    try { creds = require("./serviceAccountKey.json"); }
    catch { throw new Error("FIREBASE_CREDENTIALS_BASE64 か serviceAccountKey.json が必要です"); }
  }
  admin.initializeApp({ credential: admin.credential.cert(creds) });
  console.log("✅ Firebase initialized (watch)");
}
const db = admin.firestore();
const Timestamp = admin.firestore.Timestamp;

// ---------- LINE ----------
const client = new Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET || process.env.CHANNEL_SECRET,
});
const OFFICER_GROUP_ID = process.env.OFFICER_GROUP_ID || process.env.OWNER_USER_ID;

// ---------- Messages (30 variations) ----------
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

const rand = a => a[Math.floor(Math.random() * a.length)];
const jstHour = d => (d.getUTCHours() + 9) % 24;

async function push(to, msg) {
  try { await client.pushMessage(to, Array.isArray(msg) ? msg : [msg]); }
  catch (e) { console.error("push error:", e.response?.data || e.message); }
}

async function run() {
  console.log("⏰ watch-service tick");
  const snap = await db.collection("users").where("watchServiceEnabled", "==", true).get();
  if (snap.empty) return;

  const nowMs = Date.now();
  const now = new Date(nowMs);
  const isJST15 = jstHour(now) === 15;

  const THREE_D = 3 * 24 * 60 * 60 * 1000;
  const ONE_D   = 24 * 60 * 60 * 1000;
  const FIVE_H  = 5  * 60 * 60 * 1000;

  for (const doc of snap.docs) {
    const userId = doc.id;
    const u = doc.data();

    const lastResp = u.lastResponseAt?.toMillis?.() ?? u.createdAt?.toMillis?.() ?? nowMs;
    const firstAt  = u.firstReminderSentAt?.toMillis?.() ?? null;
    const secondAt = u.secondReminderSentAt?.toMillis?.() ?? null;

    // ユーザーが既に返信していれば（lastResponse が各ステップ後）、ここでは何もしない
    if (firstAt && lastResp > firstAt) continue;
    if (secondAt && lastResp > secondAt) continue;

    // Step 1: 3日経過 & JST 15:00 で初回
    if (!firstAt && (nowMs - lastResp >= THREE_D) && isJST15) {
      console.log(`💬 first reminder -> ${userId}`);
      await push(userId, { type: "text", text: rand(watchMessages) });
      await doc.ref.set({ firstReminderSentAt: Timestamp.now() }, { merge: true });
      continue;
    }

    // Step 2: 初回から24h（いつでも）
    if (firstAt && !secondAt && (nowMs - firstAt >= ONE_D)) {
      console.log(`🔔 second reminder -> ${userId}`);
      await push(userId, { type: "text", text: "こんにちは！昨日のメッセージ見てくれたかな？心配してるよ。スタンプでもOKだよ🌸" });
      await doc.ref.set({ secondReminderSentAt: Timestamp.now() }, { merge: true });
      continue;
    }

    // Step 3: 2回目から5h → オフィサー通知 & 停止
    if (secondAt && (nowMs - secondAt >= FIVE_H)) {
      console.log(`🚨 emergency notify -> ${userId}`);
      if (OFFICER_GROUP_ID) {
        await push(OFFICER_GROUP_ID, { type: "text", text: `【緊急】ユーザー ${u.displayName || userId} さんが29時間応答なし。ご確認ください。` });
      }
      await doc.ref.set({ watchServiceEnabled: false }, { merge: true });
      continue;
    }
  }
}

if (require.main === module) {
  run()
    .then(() => { console.log("🏁 watch-service done"); process.exit(0); })
    .catch(e => { console.error("watch-service failed:", e); process.exit(1); });
}
