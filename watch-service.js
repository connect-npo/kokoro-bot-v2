// watch-service.js — 見守りサービス、定期実行用スクリプト
"use strict";

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
  "ねぇ、こころだよ� 困ったことがあったらいつでも話してね！",
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
  const snap = await db.collection("users").where("watchService.isEnabled", "==", true).get();
  if (snap.empty) {
    console.log("🏁 watch-service done: No users to watch.");
    return;
  }
  
  let scannedUsers = 0;
  let sentFirstReminder = 0;
  let sentSecondReminder = 0;
  let skippedUsers = 0;

  const nowMs = Date.now();
  
  const THREE_D = 3 * 24 * 60 * 60 * 1000;
  const ONE_D = 24 * 60 * 60 * 1000;

  for (const doc of snap.docs) {
    scannedUsers++;
    const userId = doc.id;
    const u = doc.data();

    const lastRepliedAt = u.watchService?.lastRepliedAt?.toDate()?.getTime() ?? u.followedAt?.toDate()?.getTime() ?? nowMs;
    const firstReminderSentAt = u.watchService?.firstReminderSentAt?.toDate()?.getTime() ?? null;
    const secondReminderSentAt = u.watchService?.secondReminderSentAt?.toDate()?.getTime() ?? null;

    if (firstReminderSentAt && lastRepliedAt > firstReminderSentAt) {
      skippedUsers++;
      continue;
    }
    if (secondReminderSentAt && lastRepliedAt > secondReminderSentAt) {
      skippedUsers++;
      continue;
    }

    if (!firstReminderSentAt && (nowMs - lastRepliedAt >= THREE_D)) {
      console.log(`💬 first reminder -> ${userId}`);
      await push(userId, {
        type: "text",
        text: rand(watchMessages)
      });
      await doc.ref.set({
        'watchService.firstReminderSentAt': Timestamp.now()
      }, {
        merge: true
      });
      sentFirstReminder++;
      continue;
    }

    if (firstReminderSentAt && !secondReminderSentAt && (nowMs - firstReminderSentAt >= ONE_D)) {
      console.log(`🔔 second reminder -> ${userId}`);
      await push(userId, {
        type: "text",
        text: "こんにちは！昨日のメッセージ見てくれたかな？心配してるよ。スタンプでもOKだよ🌸"
      });
      await doc.ref.set({
        'watchService.secondReminderSentAt': Timestamp.now()
      }, {
        merge: true
      });
      sentSecondReminder++;
      continue;
    }
  }
  
  console.log(`✅ ${scannedUsers} users scanned. Sent: first=${sentFirstReminder}, second=${sentSecondReminder}, skipped=${skippedUsers}`);
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

// ユーザーIDを自動入力するGoogleフォームURLを構築
const buildWatchFormUrl = (userId) => {
  // WATCH_FORM_URLまたはWATCH_SERVICE_FORM_BASE_URL環境変数を取得
  const WATCH_FORM_URL = process.env.WATCH_FORM_URL || process.env.WATCH_SERVICE_FORM_BASE_URL || 'https://forms.gle/g5HoWNf1XX9UZK2CA';
  const uidParam = process.env.WATCH_FORM_UID_PARAM;
  
  // uidParamが設定されていれば、ユーザーIDをURLに追加
  if (uidParam) {
    return `${WATCH_FORM_URL}?${uidParam}=${userId}`;
  }
  // 設定されていなければ、元のURLを返す
  return WATCH_FORM_URL;
};

// プライバシーポリシーのURLを環境変数から取得
const WATCH_PRIVACY_URL = process.env.WATCH_PRIVACY_URL || 'https://gamma.app/docs/-iwcjofrc870g681?mode=doc';

// 見守りメニューのFLEXメッセージを構築
const WATCH_MENU_FLEX = {
  type: "bubble",
  body: {
    type: "box",
    layout: "vertical",
    contents: [
      { type: "text", text: "見守りサービス", weight: "bold", size: "lg", align: "center", color: "#FF69B4" },
      { type: "text", text: "24〜29時間応答が無い時に事務局へ通知するよ。ON/OFFを選んでね。", wrap: true, margin: "md", size: "sm", align: "center" }
    ]
  },
  footer: {
    type: "box",
    layout: "vertical",
    spacing: "sm",
    contents: [
      { type: "button", action: { type: "postback", label: "見守りサービスをONにする", data: "action=enable_watch" }, style: "primary", height: "sm", margin: "md", color: "#32CD32" },
      { type: "button", action: { type: "postback", label: "見守りサービスをOFFにする", data: "action=disable_watch" }, style: "primary", height: "sm", margin: "md", color: "#FF4500" },
      { type: "button", action: { type: "uri", label: "プライバシーポリシー", uri: WATCH_PRIVACY_URL }, style: "secondary", height: "sm", margin: "md" }
    ]
  }
};

// 会員登録メニューのFLEXメッセージを構築
const buildRegistrationFlex = () => {
  const url = process.env.ADULT_FORM_BASE_URL || 'https://connect-npo.or.jp';
  const privacyPolicyUrl = WATCH_PRIVACY_URL; // 環境変数を直接使用
  return {
    type: "bubble",
    body: {
      type: "box",
      layout: "vertical",
      contents: [
        { type: "text", text: "会員登録メニュー", weight: "bold", size: "lg", align: "center" }
      ]
    },
    footer: {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      contents: [
        { type: "button", action: { type: "uri", label: "新たに会員登録する", uri: url }, style: "primary", height: "sm", margin: "md", color: "#FFD700" },
        { type: "button", action: { type: "uri", label: "登録情報を修正する", uri: url }, style: "primary", height: "sm", margin: "md", color: "#9370DB" },
        { type: "button", action: { type: "uri", label: "プライバシーポリシー", uri: privacyPolicyUrl }, style: "secondary", height: "sm", margin: "md", color: "#FF69B4" },
        { type: "button", action: { type: "postback", label: "退会する", data: "action=request_withdrawal" }, style: "secondary", height: "sm", margin: "md", color: "#FF0000" }
      ]
    }
  };
};

// 緊急通知のテキストテンプレートの修正
// ` 続柄` は `🧬 続柄` に変更済みと認識
const EMERGENCY_TEMPLATE = (userId, message) => {
  return `【⚠️緊急】見守りサービス通知\n\nLINEユーザーID: ${userId}\n最終受信メッセージ: ${message}\n\n事務局様は対象者の状況を確認し、必要に応じてご連絡をお願いします。\n\n---自動応答メッセージ---\n🧬 続柄\n`;
};
