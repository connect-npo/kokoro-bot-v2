// watch-service.js
"use strict";

// ✅ 修正: Renderのような本番環境ではdotenvは不要。
// ローカルでの開発も考慮し、try-catchで安全に読み込むようにしました。
try {
  require("dotenv").config();
} catch (e) {
  // 環境変数はRenderから直接注入されるため、dotenvがなくても問題ありません。
}

const { Client } = require("@line/bot-sdk");
const admin = require("firebase-admin");

// ---------- Firebase ----------
let creds = null;
if (process.env.FIREBASE_CREDENTIALS_BASE64) {
  creds = JSON.parse(Buffer.from(process.env.FIREBASE_CREDENTIALS_BASE64, "base64").toString("utf-8"));
}
if (!admin.apps.length) {
  if (!creds) {
    try {
      creds = require("./serviceAccountKey.json");
    } catch {
      throw new Error("FIREBASE_CREDENTIALS_BASE64 か serviceAccountKey.json が必要です");
    }
  }
  admin.initializeApp({
    credential: admin.credential.cert(creds)
  });
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

async function push(to, msg) {
  try {
    await client.pushMessage(to, Array.isArray(msg) ? msg : [msg]);
  } catch (e) {
    console.error("push error:", e.response?.data || e.message);
  }
}

async function run() {
  console.log("⏰ watch-service tick");
  // ✅ 修正: Firestoreのwhere句をindex.jsと統一
  const snap = await db.collection("users").where("watchService.isEnabled", "==", true).get();
  if (snap.empty) {
    console.log("🏁 watch-service done: No users to watch.");
    return;
  }

  const nowMs = Date.now();
  const now = new Date(nowMs);

  const THREE_D = 3 * 24 * 60 * 60 * 1000;
  const ONE_D = 24 * 60 * 60 * 1000;
  
  // ✅ 修正: 2回目の通知ロジックをシンプルに
  const TWENTY_NINE_H = 29 * 60 * 60 * 1000;
  // オフィサー通知はindex.jsの毎時ジョブに任せるので、このファイルでは実施しない
  // const FIVE_H = 5 * 60 * 60 * 1000;

  for (const doc of snap.docs) {
    const userId = doc.id;
    const u = doc.data();

    // ✅ 修正: Firestoreのフィールド名をindex.jsと統一
    const lastResp = u.watchService?.lastRepliedAt?.toDate()?.getTime() ?? u.followedAt?.toDate()?.getTime() ?? nowMs;
    const firstAt = u.watchService?.firstReminderSentAt?.toDate()?.getTime() ?? null;
    const secondAt = u.watchService?.secondReminderSentAt?.toDate()?.getTime() ?? null;

    // ユーザーが既に返信していれば（lastRepliedAtが各ステップ後）、ここでは何もしない
    // ✅ 修正: 最終応答が最新であることを確認
    if (firstAt && lastResp > firstAt) {
      console.log(`ℹ️ User ${userId} responded after first reminder.`);
      continue;
    }
    if (secondAt && lastResp > secondAt) {
      console.log(`ℹ️ User ${userId} responded after second reminder.`);
      continue;
    }

    // Step 1: 3日 (72時間) 経過で初回メッセージを送信
    // RenderのCronが毎日15時に動くことを前提
    if (!firstAt && (nowMs - lastResp >= THREE_D)) {
      console.log(`💬 first reminder -> ${userId}`);
      await push(userId, {
        type: "text",
        text: rand(watchMessages)
      });
      // ✅ 修正: フィールド名をindex.jsと統一
      await doc.ref.set({
        'watchService.firstReminderSentAt': Timestamp.now()
      }, {
        merge: true
      });
      continue;
    }

    // Step 2: 初回送信から24時間経過で2回目メッセージを送信
    if (firstAt && !secondAt && (nowMs - firstAt >= ONE_D)) {
      console.log(`🔔 second reminder -> ${userId}`);
      await push(userId, {
        type: "text",
        text: "こんにちは！昨日のメッセージ見てくれたかな？心配してるよ。スタンプでもOKだよ🌸"
      });
      // ✅ 修正: フィールド名をindex.jsと統一
      await doc.ref.set({
        'watchService.secondReminderSentAt': Timestamp.now()
      }, {
        merge: true
      });
      continue;
    }
    
    // このCronジョブではオフィサー通知は行いません
    // オフィサー通知は、index.jsの29時間監視に任せます。
  }
}

if (require.main === module) {
  run()
    .then(() => {
      console.log("🏁 watch-service done");
      process.exit(0);
    })
    .catch(e => {
      console.error("watch-service failed:", e);
      process.exit(1);
    });
}
