// watch-service.js — 見守りサービス、定期実行用スクリプト
"use strict";

try {
  require("dotenv").config();
} catch (e) {
  // 環境変数はRenderから直接注入されるため、dotenvがなくても問題ありません。
}

const { Client } = require("@line/bot-sdk");
const admin = require("firebase-admin");
const axios = require("axios");
const { toGraphemes } = require('grapheme-splitter');

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

// ---------- Messages (30 variations) ----------
const watchMessages = [
  "こんにちは🌸 こころちゃんだよ！ 今日も元気にしてるかな？💖",
  "やっほー！ こころだよ😊 いつも応援してるね！",
  "元気にしてる？✨ こころちゃん、あなたのこと応援してるよ💖",
  "ねぇねぇ、こころだよ🌸 今日はどんな一日だった？",
  "いつもがんばってるあなたへ、こころからメッセージを送るね💌", // <-- 破損文字修正済み
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
const JST_TZ = 'Asia/Tokyo';
const PING_HOUR_JST = 15;
const PING_INTERVAL_DAYS = 3;
const REMINDER_AFTER_HOURS = 24;
const ESCALATE_AFTER_HOURS = 29;

const EMERGENCY_TEMPLATE = (userId, message) => `
【⚠️緊急】見守りサービス通知
LINEユーザーID: ${userId}
最終受信メッセージ: ${message}

事務局様は対象者の状況を確認し、必要に応じてご連絡をお願いします。

---自動応答メッセージ---
🧬 続柄
`;

// === ヘルパー関数 ===
async function push(to, msg) {
  try {
    await client.pushMessage(to, Array.isArray(msg) ? msg : [msg]);
  } catch (e) {
    console.error("push error:", e.response?.data || e.message);
  }
}

function toJstParts(date) {
  const jst = new Date(date.getTime() + 9*60*60*1000);
  return { y: jst.getUTCFullYear(), m: jst.getUTCMonth(), d: jst.getUTCDate() };
}

function makeDateAtJst(y, m, d, hourJst=0, min=0, sec=0) {
  const utcHour = hourJst - 9;
  return new Date(Date.UTC(y, m, d, utcHour, min, sec, 0));
}

function nextPingAtFrom(baseDate) {
  const { y, m, d } = toJstParts(baseDate);
  return makeDateAtJst(y, m, d + PING_INTERVAL_DAYS, PING_HOUR_JST, 0, 0);
}

async function scheduleNextPing(docRef, fromDate=new Date()) {
  const nextAt = nextPingAtFrom(fromDate);
  await docRef.set({
    watchService: {
      nextPingAt: Timestamp.fromDate(nextAt),
      awaitingReply: false,
      lastReminderAt: admin.firestore.FieldValue.delete(),
    }
  }, { merge: true });
}

function buildOkFlex() {
  return {
    type: "bubble",
    body: { type: "box", layout: "vertical", contents: [
      { type: "text", text: "見守りチェック", weight: "bold", size: "xl" },
      { type: "separator", margin: "md" },
      { type: "text", text: "OKならボタンを押してね💖\n返信やスタンプでもOKだよ！", wrap: true, margin: "lg" },
    ]},
    footer: { type: "box", layout: "vertical", spacing: "sm", contents: [
      { type: "button", style: "primary",
        action: { type: "postback", label: "OKだよ💖", data: "watch:ok", displayText: "OKだよ💖" } }
    ]}
  };
}

async function sendPing(userId, docRef) {
  const text = rand(watchMessages);
  await push(userId, [
    { type: "text", text },
    { type: "flex", altText: "見守りチェック", contents: buildOkFlex() }
  ]);
  await docRef.set({
    watchService: {
      lastPingAt: Timestamp.now(),
      awaitingReply: true,
      nextPingAt: admin.firestore.FieldValue.delete(),
    }
  }, { merge: true });
}

async function sendReminder(userId, docRef) {
  await push(userId, [
    { type: "text", text: "こころちゃんだよ🌸 昨日の見守りのOKまだ受け取れてないの…\n大丈夫なら「OKだよ💖」を押すか、一言だけ返信してね。" },
    { type: "flex", altText: "見守りリマインド", contents: buildOkFlex() }
  ]);
  await docRef.set({ watchService: { lastReminderAt: Timestamp.now() } }, { merge: true });
}

async function lock(ref, seconds=120) {
  try {
    let ok = false;
    await db.runTransaction(async tx => {
      const s = await tx.get(ref);
      const ws = s.data()?.watchService || {};
      const until = ws.notifyLockExpiresAt?.toDate?.()?.getTime?.() || 0;
      if (until > Date.now()) return;
      tx.set(ref, { watchService: { notifyLockExpiresAt: Timestamp.fromDate(new Date(Date.now()+seconds*1000)) } }, { merge: true });
      ok = true;
    });
    return ok;
  } catch { return false; }
}

async function unlock(ref) {
  await ref.set({ watchService: { notifyLockExpiresAt: admin.firestore.FieldValue.delete() } }, { merge: true });
}

// === メインの実行ロジック ===
async function run() {
  console.log("⏰ watch-service tick");
  const snap = await db.collection("users").where("watchService.isEnabled","==",true).get();
  if (snap.empty) {
    console.log("🏁 watch-service done: No users.");
    return;
  }

  const now = new Date();

  for (const doc of snap.docs) {
    const userId = doc.id;
    const ref = doc.ref;
    const u = doc.data() || {};
    const ws = u.watchService || {};

    if (!ws.awaitingReply && !ws.nextPingAt) {
      await scheduleNextPing(ref, now);
      continue;
    }

    const nextPingAt = ws.nextPingAt?.toDate?.() || null;
    const lastPingAt = ws.lastPingAt?.toDate?.() || null;
    const lastReminderAt = ws.lastReminderAt?.toDate?.() || null;

    if (!ws.awaitingReply && nextPingAt && now >= nextPingAt) {
      const ok = await lock(ref, 120);
      if (!ok) continue;
      try { await sendPing(userId, ref); }
      finally { await unlock(ref); }
      continue;
    }

    if (!ws.awaitingReply || !lastPingAt) continue;

    const hrsSincePing = (now - lastPingAt) / (1000*60*60);

    if (hrsSincePing >= REMINDER_AFTER_HOURS && !lastReminderAt) {
      const ok = await lock(ref, 120);
      if (!ok) continue;
      try { await sendReminder(userId, ref); }
      finally { await unlock(ref); }
      continue;
    }

    if (hrsSincePing >= ESCALATE_AFTER_HOURS) {
      const ok = await lock(ref, 120);
      if (!ok) continue;

      try {
        const OFFICER_GROUP_ID = process.env.OFFICER_GROUP_ID;
        if (OFFICER_GROUP_ID) {
          const anonymize = process.env.OFFICER_ANON !== '0';
          const text = anonymize
            ? `🚨【見守りサービス通知】🚨\n\n見守り定期メッセージから ${ESCALATE_AFTER_HOURS} 時間未応答です。\n（匿名モードで通知中）`
            : `🚨【見守りサービス通知】🚨\n\nユーザーID: ${userId}\n最終Ping: ${lastPingAt.toLocaleString('ja-JP',{timeZone:JST_TZ})}\n\n${EMERGENCY_TEMPLATE(userId, u.watchService?.lastRepliedMessage || '（未記録）')}`;
          await push(OFFICER_GROUP_ID, { type: "text", text });
        }
        await ref.set({
          watchService: {
            lastNotifiedAt: Timestamp.now(),
            awaitingReply: false,
            lastReminderAt: admin.firestore.FieldValue.delete(),
          }
        }, { merge: true });
        await scheduleNextPing(ref, now);
      } finally {
        await unlock(ref);
      }
    }
  }
  console.log("🏁 watch-service done");
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
