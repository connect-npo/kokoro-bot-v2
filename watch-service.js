// --- Firebase & LINE 初期化 ---
// この部分は、このJSファイルが独立して動作するようにするためのものです。
// Node.jsの環境で実行することを想定しています。
const admin = require('firebase-admin');
const { Timestamp } = require('firebase-admin/firestore');
const line = require('@line/bot-sdk');

// Firebase
if (!admin.apps.length) {
  try {
    const credentials = JSON.parse(
      Buffer.from(process.env.FIREBASE_CREDENTIALS_BASE64, 'base64').toString()
    );
    admin.initializeApp({ credential: admin.credential.cert(credentials) });
  } catch (err) {
    console.error("❌ Firebaseの初期化に失敗しました。環境変数FIREBASE_CREDENTIALS_BASE64を確認してください。", err);
    process.exit(1);
  }
}
const db = admin.firestore();

// LINE
const client = new line.Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
});

// --- 環境変数 ---
const EMERGENCY_CONTACT_PHONE_NUMBER = process.env.EMERGENCY_CONTACT_PHONE_NUMBER || '09048393313';
const OFFICER_GROUP_ID = process.env.OFFICER_GROUP_ID;

// --- ユーティリティ ---
async function safePushMessage(to, messages) {
  const arr = Array.isArray(messages) ? messages : [messages];
  try {
    await client.pushMessage(to, arr);
    console.log(`✅ メッセージを ${to} に送信しました。`);
  } catch (e) {
    console.error(`❌ メッセージ送信エラー (${to}):`, e);
  }
}

// --- 見守りメッセージ（30種類） ---
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
  "こんにちは✨ こころだよ！もし疲れたら無理しないでね�",
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

// --- 本体 ---
async function runWatchService() {
  try {
    console.log("⏰ 見守りサービスのステータスをチェックします...");
    const now = Timestamp.now().toDate();
    const oneDayMs = 24 * 60 * 60 * 1000;

    const q = db.collection('users').where('watchServiceEnabled', '==', true);
    const snapshot = await q.get();

    for (const doc of snapshot.docs) {
      const user = doc.data();
      const userId = doc.id;

      // lastOkResponseとlastScheduledWatchMessageSentのうち、新しい方の日時を取得
      const lastOk = user.lastOkResponse ? user.lastOkResponse.toDate() : new Date(0);
      const lastSched = user.lastScheduledWatchMessageSent ? user.lastScheduledWatchMessageSent.toDate() : new Date(0);
      const lastAction = lastOk > lastSched ? lastOk : lastSched;
      const diffMs = now.getTime() - lastAction.getTime();

      // 3日経過（=72h）: 新規メッセージ送信
      if (diffMs >= 3 * oneDayMs) {
        const msg = watchMessages[Math.floor(Math.random() * watchMessages.length)];
        await safePushMessage(userId, { type: 'text', text: msg });
        await doc.ref.update({
          lastScheduledWatchMessageSent: Timestamp.now(),
          firstReminderSent: false,
          emergencyNotificationSent: false
        });
        continue;
      }

      // 24時間経過: リマインドメッセージ送信
      if (diffMs >= oneDayMs && !user.firstReminderSent) {
        await safePushMessage(userId, { type: 'text', text: '前回のメッセージから24時間経ちました。大丈夫ですか？' });
        await doc.ref.update({ firstReminderSent: true });
      }

      // 29時間経過: 緊急通知（管理者グループへ）
      else if (diffMs >= 29 * 60 * 60 * 1000 && user.firstReminderSent && !user.emergencyNotificationSent) {
        const text = [
          '🚨【見守りサービス緊急通知】🚨',
          `👤 氏名：${user.name || '未登録'}`,
          `📱 電話番号：${user.phone || '未登録'}`,
          `📞 緊急連絡先：${user.emergencyContact || '未登録'}`,
          `\n✅ この通知は、${user.name || '未登録'}さんが29時間以上応答がないため送信されました。`
        ].join('\n');

        if (OFFICER_GROUP_ID) {
          await safePushMessage(OFFICER_GROUP_ID, { type: 'text', text });
        }
        await doc.ref.update({ emergencyNotificationSent: true });
      }
    }
    console.log("✅ 見守りサービスのチェックが完了しました。");
  } catch (err) {
    console.error("❌ エラーが発生しました:", err);
  }
}

// --- 実行（RenderのCronから呼ばれる想定） ---
if (require.main === module) {
  runWatchService().then(() => {
    console.log("見守りサービス実行が正常に終了しました。");
    process.exit(0);
  }).catch((err) => {
    console.error("見守りサービス実行中にエラーが発生しました:", err);
    process.exit(1);
  });
}
