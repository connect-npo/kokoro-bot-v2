// --- dotenvを読み込んで環境変数を安全に管理 ---
require('dotenv').config();

// --- 必要なモジュールのインポート ---
const admin = require('firebase-admin');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { getApps } = require('firebase-admin/app');
const { Client } = require('@line/bot-sdk');
const crypto = require('crypto');
const axios = require('axios');
const nodemailer = require('nodemailer');
const cron = require('node-cron'); // cronモジュールを追加

// --- 環境変数 ---
const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const FIREBASE_CREDENTIALS_BASE64 = process.env.FIREBASE_CREDENTIALS_BASE64;
const OFFICER_GROUP_ID = process.env.OFFICER_GROUP_ID;
const EMERGENCY_CONTACT_PHONE_NUMBER = process.env.EMERGENCY_CONTACT_PHONE_NUMBER || '09048393313';
const WATCH_MESSAGE_ENABLED = process.env.WATCH_MESSAGE_ENABLED === 'true';

// ⭐--- 30通りの見守りメッセージを直接コードに定義 ---⭐
// これでwatch-db.jsonがなくてもメッセージを送信できます
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
    "やっほー！気分転換に何か楽しいこと見つかったかな？�",
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
    console.log("✅ watch-service.js: Firebase Admin SDKを初期化しました。");
} catch (error) {
    console.error("❌ watch-service.js: Firebase Admin SDKの初期化エラー:", error);
    process.exit(1);
}

// --- LINEクライアントの初期化 ---
const client = new Client({
    channelAccessToken: CHANNEL_ACCESS_TOKEN,
    channelSecret: CHANNEL_SECRET,
});

// --- Firestoreコレクション参照 ---
const usersCollection = db.collection('users');
const logsCollection = db.collection('logs');
const watchMessagesCollection = db.collection('watch_messages');

// ログ用ヘルパー関数
async function logToDb(userId, userMessage, botResponse, moduleName, type) {
    try {
        await logsCollection.add({
            userId,
            userMessage,
            botResponse,
            module: moduleName,
            type,
            timestamp: Timestamp.now()
        });
    } catch (error) {
        console.error("❌ ログ書き込みエラー:", error.message);
    }
}

// エラーログ用ヘルパー関数
async function logErrorToDb(userId, errorMessage, details) {
    try {
        await logsCollection.add({
            userId,
            error: errorMessage,
            details: JSON.stringify(details),
            timestamp: Timestamp.now(),
            type: 'error'
        });
    } catch (error) {
        console.error("❌ エラーログ書き込みエラー:", error.message);
    }
}

// メッセージ送信キュー関連
const messageQueue = [];
let isProcessingQueue = false;
const MESSAGE_SEND_INTERVAL_MS = 1500;

async function startMessageQueueWorker() {
    if (isProcessingQueue) {
        return;
    }
    isProcessingQueue = true;
    while (messageQueue.length > 0) {
        const { to, messages } = messageQueue.shift();
        const maxRetries = 3;
        const initialDelayMs = MESSAGE_SEND_INTERVAL_MS;
        for (let i = 0; i <= maxRetries; i++) {
            const currentDelay = initialDelayMs * (2 ** i);
            if (i > 0) console.warn(`⚠️ キューからの送信リトライ中 (ユーザー: ${to}, 残りリトライ: ${maxRetries - i}, ディレイ: ${currentDelay}ms)`);
            await new Promise(resolve => setTimeout(resolve, currentDelay));
            try {
                await client.pushMessage(to, messages);
                if (i > 0) console.log(`✅ キューからのメッセージ送信リトライ成功 to: ${to}`);
                break;
            } catch (error) {
                if (error.statusCode === 429) {
                    if (i === maxRetries) {
                        console.error(`🚨 キューからのメッセージ送信リトライ失敗: 最大リトライ回数に達しました (ユーザー: ${to})`);
                        await logErrorToDb(to, `キューメッセージ送信429エラー (最終リトライ失敗)`, { error: error.message, messages: JSON.stringify(messages) });
                    }
                } else {
                    console.error(`❌ キューからのメッセージ送信失敗 (ユーザー: ${to}):`, error.message);
                    await logErrorToDb(to, 'キューメッセージ送信エラー', { error: error.message, messages: JSON.stringify(messages) });
                    break;
                }
            }
        }
    }
    isProcessingQueue = false;
}

function safePushMessage(to, messages) {
    messageQueue.push({ to, messages: Array.isArray(messages) ? messages : [messages] });
    startMessageQueueWorker();
}

// --- 汎用関数 ---
function getRandomInt(min, max) {
  min = Math.ceil(min);
  max = Math.floor(max);
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ユーザー情報取得ヘルパー
async function getUserData(userId) {
  const userDoc = await usersCollection.doc(userId).get();
  if (!userDoc.exists) return null;
  return { id: userDoc.id, ...userDoc.data() };
}

// ⭐--- ランダムな見守りメッセージを取得する関数を修正 ---⭐
// watchMessages配列からランダムにメッセージを取得するように変更
async function getRandomWatchMessage() {
  if (watchMessages.length > 0) {
    const randomIndex = Math.floor(Math.random() * watchMessages.length);
    return watchMessages[randomIndex];
  }
  return null;
}

// 緊急通知を送信する関数
async function sendEmergencyNotification(user) {
    console.log(`🚨 緊急通知を送信します。ユーザーID: ${user.id}`);
    const logDetails = {
        userId: user.id,
        type: 'emergency_notification'
    };

    const emergencyMessage = {
        type: 'text',
        text: `🚨【緊急】${user.name}さんからの応答がありません。緊急事態が懸念されます。\n緊急連絡先: ${user.guardianName}様\n電話番号: ${user.guardianPhoneNumber}\n`
    };

    const pushEmergencyMessage = async (targetId) => {
        try {
            await client.pushMessage(targetId, emergencyMessage);
            console.log(`✅ 緊急通知を ${targetId} に送信しました。`);
            logDetails.pushMessageTo = targetId;
            await logToDb(user.id, '緊急通知送信', '緊急通知を送信しました', 'watch-service', 'emergency_push_success');
        } catch (e) {
            console.error(`❌ 緊急通知の送信失敗 to ${targetId}:`, e);
            logDetails.pushMessageError = e.message;
            await logErrorToDb(user.id, `緊急通知送信失敗 to ${targetId}`, { error: e.message });
        }
    };

    // 担当者グループへ通知
    if (OFFICER_GROUP_ID) {
        await pushEmergencyMessage(OFFICER_GROUP_ID);
    }

    // 緊急連絡先へメッセージを送信（LINE）
    if (user.guardianLineUserId) {
        await pushEmergencyMessage(user.guardianLineUserId);
    }

    // 最後の緊急通知時間を記録
    await usersCollection.doc(user.id).update({
        lastEmergencyNotificationSent: admin.firestore.FieldValue.serverTimestamp(),
        emergencyNotificationSent: true
    });
}

// --- 本体 ---
async function runWatchService() {
    console.log("⏰ 見守りステータス確認開始");
    try {
        const activeUsers = await usersCollection
            .where('watchServiceEnabled', '==', true)
            .get();

        if (activeUsers.empty) {
            console.log("✅ 見守り対象のユーザーがいません。");
            return;
        }

        const now = new Date();

        for (const userDoc of activeUsers.docs) {
            const user = { id: userDoc.id, ...userDoc.data() };
            const lastMessageSentAt = user.lastScheduledWatchMessageSent ? user.lastScheduledWatchMessageSent.toDate() : null;

            // 定期見守りメッセージの送信
            const nextScheduledTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0); // 毎日12:00に設定
            if (now >= nextScheduledTime && (!lastMessageSentAt || now.getDate() !== lastMessageSentAt.getDate())) {
                console.log(`💬 定期見守りメッセージを送信します。ユーザーID: ${user.id}`);
                const message = await getRandomWatchMessage() || 'こんにちは！今日も一日、元気で過ごしてるかな？何か困ったことがあったら、いつでも話しかけてね🌸';
                await safePushMessage(user.id, {
                    type: 'text',
                    text: message
                });
                await usersCollection.doc(user.id).update({
                    lastScheduledWatchMessageSent: admin.firestore.FieldValue.serverTimestamp()
                });
                await logToDb(user.id, '定期見守りメッセージ送信', message, 'watch-service', 'scheduled_message_sent');
            }

            // 1回目のリマインダー通知
            const firstReminderDue = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 13, 0, 0); // 毎日13:00に設定
            if (now >= firstReminderDue && !user.firstReminderSent) {
                console.log(`🔔 1回目のリマインダーを送信します。ユーザーID: ${user.id}`);
                await safePushMessage(user.id, {
                    type: 'text',
                    text: '🌸おーい、元気？\n何かあったかな？よかったらスタンプでも送ってくれると嬉しいな😊'
                });
                await usersCollection.doc(user.id).update({
                    firstReminderSent: true
                });
                await logToDb(user.id, '1stリマインダー送信', 'リマインダーメッセージを送信しました', 'watch-service', 'first_reminder_sent');
            }

            // 2回目のリマインダー通知
            const secondReminderDue = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 14, 0, 0); // 毎日14:00に設定
            if (now >= secondReminderDue && user.firstReminderSent && !user.emergencyNotificationSent) {
                console.log(`🔔 2回目のリマインダーを送信します。ユーザーID: ${user.id}`);
                await safePushMessage(user.id, {
                    type: 'text',
                    text: 'もしもし、大丈夫？\nまだ返信がないみたいだけど、心配だな…\nもし、いま話せるならスタンプ一つでもいいから送ってくれると、とっても嬉しいな。'
                });
                await usersCollection.doc(user.id).update({
                    emergencyNotificationSent: true // 緊急通知フラグを立てて、今後の通知を防ぐ
                });
                await logToDb(user.id, '2ndリマインダー送信', '2ndリマインダーメッセージを送信しました', 'watch-service', 'second_reminder_sent');
            }

            // 緊急通知
            const emergencyDue = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 15, 0, 0); // 毎日15:00に設定
            if (now >= emergencyDue && user.emergencyNotificationSent) {
                await sendEmergencyNotification(user);
                await logToDb(user.id, '緊急通知', '緊急通知を送信しました', 'watch-service', 'emergency_notification_sent');
            }
        }
    } catch (error) {
        console.error("💥 見守りサービス実行中エラー:", error.message);
        await logErrorToDb(null, "見守りサービス実行中エラー", { error: error.message });
        throw error; // エラーを再スローしてジョブを失敗させる
    }
}

// スクリプトが直接実行された場合にのみ実行
if (require.main === module) {
  runWatchService()
    .then(() => {
      console.log("🏁 watch-service.js 正常終了");
      process.exit(0);
    })
    .catch(err => {
      console.error("💥 watch-service.js 実行中エラー:", err);
      process.exit(1);
    });
}
