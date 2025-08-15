// --- dotenvを読み込んで環境変数を安全に管理 ---
require('dotenv').config();

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, Timestamp, FieldValue } = require('firebase-admin/firestore');
const { Client } = require('@line/bot-sdk');
const cron = require('node-cron');
const admin = require('firebase-admin');

// --- 環境変数の設定 ---
const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const OFFICER_GROUP_ID = process.env.OFFICER_GROUP_ID;
const FIREBASE_CREDENTIALS_BASE64 = process.env.FIREBASE_CREDENTIALS_BASE64;
const EMERGENCY_CONTACT_PHONE_NUMBER = process.env.EMERGENCY_CONTACT_PHONE_NUMBER || '09048393313';

// --- Firebase Admin SDKの初期化 ---
let db;
try {
    if (!getApps().length) {
        if (!FIREBASE_CREDENTIALS_BASE64) {
            throw new Error("FIREBASE_CREDENTIALS_BASE64 環境変数が設定されていません。");
        }
        const serviceAccount = JSON.parse(Buffer.from(FIREBASE_CREDENTIALS_BASE64, 'base64').toString('ascii'));
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            databaseURL: `https://${serviceAccount.project_id}.firebaseio.com`
        });
    }
    db = getFirestore();
    console.log("✅ Firebase Admin SDKを初期化しました。");
} catch (error) {
    console.error("❌ Firebase Admin SDKの初期化エラー:", error);
    process.exit(1);
}

// --- LINEクライアントの初期化 ---
const client = new Client({
    channelAccessToken: CHANNEL_ACCESS_TOKEN,
    channelSecret: CHANNEL_SECRET,
});

// --- ユーティリティ関数 ---
async function safePushMessage(to, messages) {
    const messagesArray = Array.isArray(messages) ? messages : [messages];
    try {
        await client.pushMessage({ to, messages: messagesArray });
        console.log(`✅ メッセージを ${to} に送信しました。`);
    } catch (error) {
        console.error(`❌ メッセージ送信エラー (${to}):`, error.message);
    }
}

// --- 見守りサービスの定期実行処理 (cron) ---
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

// --- cronジョブ定義 ---
// 3日に一度、見守りサービス登録ユーザーにランダムメッセージを送信
cron.schedule('0 12 */3 * *', async () => {
    try {
        console.log("⏰ cron: 見守りサービスのメッセージ送信を開始します...");
        const usersRef = db.collection('users').where('watchServiceEnabled', '==', true);
        const snapshot = await usersRef.get();
        for (const doc of snapshot.docs) {
            const userData = doc.data();
            const randomIndex = Math.floor(Math.random() * watchMessages.length);
            const randomMessage = watchMessages[randomIndex];
            await safePushMessage(doc.id, { type: 'text', text: randomMessage });
            await doc.ref.update({ lastScheduledWatchMessageSent: Timestamp.now() });
        }
        console.log("✅ cron: 見守りサービスのメッセージ送信が完了しました。");
    } catch (error) {
        console.error("❌ cron: 見守りサービスのメッセージ送信中にエラーが発生しました:", error);
    }
}, {
    timezone: "Asia/Tokyo"
});

// 24時間後にリマインダーを送信
cron.schedule('0 */1 * * *', async () => {
    try {
        console.log("⏰ cron: 24時間後リマインダーをチェックします...");
        const now = Timestamp.now().toDate();
        const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        const usersRef = db.collection('users').where('watchServiceEnabled', '==', true);
        const snapshot = await usersRef.get();
        for (const doc of snapshot.docs) {
            const userData = doc.data();
            const lastActivity = userData.lastOkResponse ? userData.lastOkResponse.toDate() : new Date(0);
            if (lastActivity < oneDayAgo && !userData.firstReminderSent) {
                await safePushMessage(doc.id, { type: 'text', text: '前回のメッセージから24時間経ちました。大丈夫ですか？' });
                await doc.ref.update({ firstReminderSent: true });
            }
        }
        console.log("✅ cron: 24時間後リマインダーのチェックが完了しました。");
    } catch (error) {
        console.error("❌ cron: 24時間後リマインダーのチェック中にエラーが発生しました:", error);
    }
}, {
    timezone: "Asia/Tokyo"
});

// 5時間後に緊急通知を送信
cron.schedule('0 */1 * * *', async () => {
    try {
        console.log("⏰ cron: 5時間後緊急通知をチェックします...");
        const now = Timestamp.now().toDate();
        const fiveHoursAgo = new Date(now.getTime() - 5 * 60 * 60 * 1000);
        const usersRef = db.collection('users').where('watchServiceEnabled', '==', true).where('firstReminderSent', '==', true);
        const snapshot = await usersRef.get();
        for (const doc of snapshot.docs) {
            const userData = doc.data();
            const lastActivity = userData.lastOkResponse ? userData.lastOkResponse.toDate() : new Date(0);
            if (lastActivity < fiveHoursAgo && !userData.emergencyNotificationSent) {
                const flexMessage = {
                    type: 'flex',
                    altText: '緊急通知',
                    contents: {
                        type: 'bubble',
                        body: {
                            type: 'box',
                            layout: 'vertical',
                            contents: [{ type: 'text', text: `🚨 緊急通知 🚨\n\nユーザー: ${doc.id}と5時間以上連絡が取れていません。\n\n緊急連絡先: ${EMERGENCY_CONTACT_PHONE_NUMBER}`, wrap: true }]
                        }
                    }
                };
                if (OFFICER_GROUP_ID) {
                    await safePushMessage(OFFICER_GROUP_ID, flexMessage);
                }
                await doc.ref.update({ emergencyNotificationSent: true });
            }
        }
        console.log("✅ cron: 5時間後緊急通知のチェックが完了しました。");
    } catch (error) {
        console.error("❌ cron: 5時間後緊急通知のチェック中にエラーが発生しました:", error);
    }
}, {
    timezone: "Asia/Tokyo"
});

// 危険・詐欺ワードの定期チェック
cron.schedule('*/5 * * * *', async () => {
    // ログデータは5分間隔でチェック
    // ...
}, {
    timezone: "Asia/Tokyo"
});

// ファイルが直接実行された場合にcronジョブを有効化
if (require.main === module) {
    console.log("▶️ watch-service.js が起動しました。cronジョブが実行されます。");
}
