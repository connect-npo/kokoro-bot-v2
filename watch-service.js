// --- dotenvを読み込んで環境変数を安全に管理 ---
require('dotenv').config();

// --- 必要なモジュールのインポート ---
const admin = require('firebase-admin');
const { Client } = require('@line/bot-sdk');
const cron = require('node-cron');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { OpenAI } = require('openai');

// --- 環境変数の設定 ---
const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const OFFICER_GROUP_ID = process.env.OFFICER_GROUP_ID;
const FIREBASE_CREDENTIALS_BASE64 = process.env.FIREBASE_CREDENTIALS_BASE64;

// --- Firebase Admin SDKの初期化 ---
let db;
try {
    if (!FIREBASE_CREDENTIALS_BASE64) {
        throw new Error("FIREBASE_CREDENTIALS_BASE64 環境変数が設定されていません。");
    }
    const serviceAccount = JSON.parse(Buffer.from(FIREBASE_CREDENTIALS_BASE64, 'base64').toString('ascii'));
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        storageBucket: serviceAccount.project_id + '.appspot.com'
    });
    db = admin.firestore();
    console.log("✅ Firebase Admin SDKを初期化しました。");
} catch (error) {
    console.error("❌ Firebase Admin SDKの初期化エラー:", error);
    console.error("FIREBASE_CREDENTIALS_BASE64が正しく設定されているか、またはJSON形式に問題がないか確認してください。");
    process.exit(1);
}

// --- LINEボットSDKの初期化 ---
const client = new Client({
    channelAccessToken: CHANNEL_ACCESS_TOKEN
});


// --- 3日に一度のランダム見守りメッセージ一覧（30通り） ---
const watchMessages = [
    "こんにちは🌸 こころちゃんだよ！ 今日も元気にしてるかな？💖", "やっほー！ こころだよ😊 いつも応援してるね！", "元気にしてる？✨ こころちゃん、あなたのこと応援してるよ💖", "ねぇねぇ、こころだよ🌸 今日はどんな一日だった？", "いつもがんばってるあなたへ、こころからメッセージを送るね💖", "お元気ですか？こころちゃんです😊 素敵な一日を過ごせていますように！", "こんにちは！こころだよ🌸 毎日がんばっていて偉いね✨", "やっほー！今日も一日お疲れ様💖 少しでもホッとできる時間がありますように。", "ねぇ、こころだよ😊 困ったことがあったらいつでも話してね！", "こんにちは🌸 あなたのことが気になってメッセージしちゃった💖", "やっほー！こころちゃんです😊 元気に過ごしてるかな？", "元気出してね！こころちゃんはいつもあなたの味方だよ💖", "こんにちは✨ こころちゃん、あなたのことを想ってるよ😊", "やっほー！気分転換に何か楽しいこと見つかったかな？💖", "元気かな？🌸 こころだよ！もしよかったらお話しようね😊", "こんにちは💖 こころちゃんです！あなたの笑顔が見たいな✨", "やっほー😊 久しぶりにメッセージしちゃった！元気にしてる？", "ねぇ、こころだよ🌸 今、何してるのかな？💖", "元気？😊 こころちゃんです！何か良いことあった？", "こんにちは✨ こころだよ！もし疲れたら無理しないでね💖", "やっほー！今日も一日お疲れ様🌸 ゆっくり休んでね😊", "ねぇねぇ、こころだよ💖 忙しい毎日だけど、息抜きも大切だよ✨", "元気にしてるかな？こころちゃんはいつもここにいるよ😊", "こんにちは！🌸 こころだよ！あなたのこと、いつも考えてるよ💖", "やっほー！こころちゃんです😊 お話するの、楽しみにしているね！", "元気？💖 もしよかったら、最近のことを話してくれないかな？", "こんにちは✨ こころだよ！何か手伝えることがあったら言ってね😊", "やっほー！今日もがんばってるね🌸 応援してるよ💖", "ねぇ、こころだよ😊 あなたの存在が、私にとって大切だよ✨", "元気かな？💖 こころちゃんです！あなたの毎日が幸せでありますように！"
];

// --- ログ関数と補助関数 ---
async function logErrorToDb(userId, errorType, errorDetails) {
    try {
        await db.collection('errors').add({
            userId, errorType, errorDetails,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
    } catch (error) {
        console.error("❌ エラーログの書き込み中にエラーが発生しました:", error);
    }
}
async function safePushMessage(userId, messages) {
    try {
        if (!userId) {
            console.error("Push Message Error: userIdがありません。");
            return;
        }
        await client.pushMessage(userId, messages);
    } catch (error) {
        console.error('❌ Push Message Error:', error);
    }
}
async function notifyOfficerGroup(message, userId, userInfo, type, notificationDetailType = '') {
    const userName = userInfo.name || '未登録';
    const userPhone = userInfo.phoneNumber || '未登録';
    const guardianName = userInfo.guardianName || '未登録';
    const emergencyContact = userInfo.guardianPhoneNumber || '未登録';
    const relationship = userInfo.relationship || '未登録';
    const userCity = (userInfo.address && userInfo.address.city) ? userInfo.address.city : '未登録';

    let notificationTitle = "";
    if (type === "danger") {
        notificationTitle = "🚨【危険ワード検知】🚨";
    } else if (type === "scam") {
        notificationTitle = "🚨【詐欺注意】🚨";
    }

    const simpleNotificationMessage = `${notificationTitle}\n\n` +
        `👤 氏名：${userName}\n` +
        `📱 電話番号：${userPhone}\n` +
        `🏠 市区町村：${userCity}\n` +
        `👨‍👩‍👧‍👦 保護者名：${guardianName}\n` +
        `📞 緊急連絡先：${emergencyContact}\n` +
        `🧬 続柄：${relationship}\n` +
        `\nメッセージ: 「${message}」\n\n` +
        `ユーザーID: ${userId}\n` +
        `ユーザーとのチャットへ: https://line.me/ti/p/~${userId}\n` +
        `LINEで個別相談を促すには、上記のURLをタップしてチャットを開き、手動でメッセージを送信してください。\n` +
        `※ LINE公式アカウントID:@201nxobx`;

    if (OFFICER_GROUP_ID) {
        await client.pushMessage(OFFICER_GROUP_ID, { type: 'text', text: simpleNotificationMessage });
    } else {
        console.warn("⚠️ OFFICER_GROUP_ID が設定されていないため、管理者グループへの通知は送信されません。");
    }
}

// --- cronジョブ本体 ---
// 3日に一度、午後3時に見守りメッセージを送信するジョブ
cron.schedule('0 15 */3 * *', async () => {
    console.log('✅ Cronジョブ: 定期見守りメッセージの送信処理を開始します。');
    try {
        const usersSnapshot = await db.collection('users').where('watchServiceEnabled', '==', true).get();
        const now = new Date();
        for (const userDoc of usersSnapshot.docs) {
            const userId = userDoc.id;
            const userData = userDoc.data();
            const lastOkResponse = userData.lastOkResponse?.toDate?.() || userData.createdAt?.toDate?.() || new Date(0);
            const diffDays = (now.getTime() - lastOkResponse.getTime()) / (1000 * 60 * 60 * 24);
            if (diffDays >= 3 && !userData.firstReminderSent) {
                const randomMessage = watchMessages[Math.floor(Math.random() * watchMessages.length)];
                await safePushMessage(userId, { type: 'text', text: randomMessage });
                await db.collection('users').doc(userId).update({
                    lastScheduledWatchMessageSent: admin.firestore.Timestamp.fromDate(now),
                    firstReminderSent: true
                });
                console.log(`✅ 定期見守りメッセージを送信しました: ${userId}`);
            }
        }
    } catch (error) {
        console.error('❌ Cronジョブ: 定期見守りメッセージ送信中にエラーが発生しました:', error);
    }
}, {
    timezone: "Asia/Tokyo"
});

// 24時間後リマインダーを送信するジョブ（毎日午後3時にチェック）
cron.schedule('0 15 * * *', async () => {
    console.log('✅ Cronジョブ: 24時間後リマインダーの送信処理を開始します。');
    try {
        const usersSnapshot = await db.collection('users').where('watchServiceEnabled', '==', true).get();
        const now = new Date();
        for (const userDoc of usersSnapshot.docs) {
            const userId = userDoc.id;
            const userData = userDoc.data();
            if (userData.firstReminderSent && !userData.emergencyNotificationSent && userData.lastScheduledWatchMessageSent) {
                const lastSentTime = userData.lastScheduledWatchMessageSent.toDate().getTime();
                const diffHours = (now.getTime() - lastSentTime) / (1000 * 60 * 60);
                if (diffHours >= 24) {
                    const message = "あれ？こころからのメッセージ見てくれたかな？何かあったのかな？少し心配だよ💦　よかったら、元気だよって返信してくれないかな？";
                    await safePushMessage(userId, { type: 'text', text: message });
                    await db.collection('users').doc(userId).update({
                        lastScheduledWatchMessageSent: admin.firestore.Timestamp.fromDate(now)
                    });
                    console.log(`✅ 24時間後リマインダーを送信しました: ${userId}`);
                }
            }
        }
    } catch (error) {
        console.error('❌ Cronジョブ: 24時間後リマインダー送信中にエラーが発生しました:', error);
    }
}, {
    timezone: "Asia/Tokyo"
});

// 24時間後リマインダー送信後5時間経過したユーザーに緊急通知を送信するジョブ（毎日午後8時にチェック）
cron.schedule('0 20 * * *', async () => {
    console.log('✅ Cronジョブ: 緊急通知の送信処理を開始します。');
    try {
        const usersSnapshot = await db.collection('users').where('watchServiceEnabled', '==', true).get();
        const now = new Date();
        for (const userDoc of usersSnapshot.docs) {
            const userId = userDoc.id;
            const userData = userDoc.data();
            if (userData.firstReminderSent && !userData.emergencyNotificationSent && userData.lastScheduledWatchMessageSent) {
                const lastSentTime = userData.lastScheduledWatchMessageSent.toDate().getTime();
                const diffHours = (now.getTime() - lastSentTime) / (1000 * 60 * 60);
                if (diffHours >= 5) {
                    const emergencyMessage = `🚨緊急通知🚨\n[ユーザーID: ${userId}]\n[ユーザー名: ${userData.name || '不明'}]\n[電話番号: ${userData.phoneNumber || '不明'}]\n[住所: ${userData.address?.city || '不明'}]\n\n見守りサービス応答なし。\n${userData.guardianName || '緊急連絡先様'}様、ご確認をお願いします。\n[緊急連絡先: ${userData.guardianPhoneNumber || '不明'}]`;
                    if (OFFICER_GROUP_ID) {
                        await safePushMessage(OFFICER_GROUP_ID, { type: 'text', text: emergencyMessage });
                        console.log(`🚨 緊急通知を送信しました: GroupId=${OFFICER_GROUP_ID}, UserId=${userId}`);
                    } else {
                        console.error('❌ 環境変数OFFICER_GROUP_IDが設定されていないため、緊急通知を送信できませんでした。');
                    }
                    await db.collection('users').doc(userId).update({
                        emergencyNotificationSent: true
                    });
                }
            }
        }
    } catch (error) {
        console.error('❌ Cronジョブ: 緊急通知送信中にエラーが発生しました:', error);
    }
}, {
    timezone: "Asia/Tokyo"
});

// 危険ワード・詐欺ワードをチェックして通知するCronジョブ
cron.schedule('*/5 * * * *', async () => {
    const dangerWords = [
        "しにたい", "死にたい", "自殺", "消えたい", "殴られる", "たたかれる", "リストカット", "オーバードーズ",
        "虐待", "パワハラ", "お金がない", "お金足りない", "貧乏", "死にそう", "DV", "無理やり",
        "いじめ", "イジメ", "ハラスメント",
        "つけられてる", "追いかけられている", "ストーカー", "すとーかー"
    ];
    const scamWords = [
        /詐欺(かも|だ|です|ですか|かもしれない)?/i,
        /騙(す|される|された)/i,
        /特殊詐欺/i, /オレオレ詐欺/i, /架空請求/i, /未払い/i, /電子マネー/i, /換金/i, /返金/i, /税金/i, /還付金/i,
        /アマゾン/i, /amazon/i, /振込/i, /カード利用確認/i, /利用停止/i, /未納/i, /請求書/i, /コンビニ/i, /支払い番号/i, /支払期限/i,
        /息子拘留/i, /保釈金/i, /拘留/i, /逮捕/i, /電話番号お知らせください/i, /自宅に取り/i, /自宅に伺い/i, /自宅訪問/i, /自宅に現金/i, /自宅を教え/i,
        /現金書留/i, /コンビニ払い/i, /ギフトカード/i, /プリペイドカード/i, /支払って/i, /振込先/i, /名義変更/i, /口座凍結/i, /個人情報/i, /暗証番号/i,
        /ワンクリック詐欺/i, /フィッシング/i, /当選しました/i, /高額報酬/i, /副業/i, /儲かる/i, /簡単に稼げる/i, /投資/i, /必ず儲かる/i, /未公開株/i,
        /サポート詐欺/i, /ウイルス感染/i, /パソコンが危険/i, /蓋をしないと、安全に関する警告が発せられなくなる場合があります。修理費/i, /遠隔操作/i, /セキュリティ警告/i, /年金/i, /健康保険/i, /給付金/i,
        /弁護士/i, /警察/i, /緊急/i, /トラブル/i, /解決/i, /至急/i, /すぐに/i, /今すぐ/i, /連絡ください/i, /電話ください/i, /訪問します/i,
        /lineで送金/i, /lineアカウント凍結/i, /lineアカウント乗っ取り/i, /line不正利用/i, /lineから連絡/i, /line詐欺/i, /snsで稼ぐ/i, /sns投資/i, /sns副業/i,
        /urlをクリック/i, /クリックしてください/i, /通知からアクセス/i, /メールに添付/i, /個人情報要求/i, /認証コード/i, /電話番号を教えて/i, /lineのidを教えて/i, /パスワードを教えて/i
    ];
    
    // 過去5分間のチャットログを取得
    const fiveMinutesAgo = admin.firestore.Timestamp.fromDate(new Date(Date.now() - 5 * 60 * 1000));
    const chatSnapshot = await db.collection('chats')
        .where('timestamp', '>', fiveMinutesAgo)
        .where('sender', '==', 'user')
        .get();

    for (const chatDoc of chatSnapshot.docs) {
        const chatData = chatDoc.data();
        const userMessage = chatData.userMessage;
        const userId = chatData.userId;
        const isDanger = dangerWords.some(word => userMessage.includes(word));
        const isScam = scamWords.some(regex => regex.test(userMessage));

        if (isDanger || isScam) {
            let userInfo = {};
            try {
                const userDoc = await db.collection('users').doc(userId).get();
                if (userDoc.exists) {
                    userInfo = userDoc.data();
                }
            } catch (error) {
                console.error("❌ ユーザー情報取得エラー:", error);
            }
            if (isDanger) {
                await notifyOfficerGroup(userMessage, userId, userInfo, 'danger', '危険ワード検知');
            }
            if (isScam) {
                await notifyOfficerGroup(userMessage, userId, userInfo, 'scam', '詐欺ワード検知');
            }
        }
    }
}, {
    timezone: "Asia/Tokyo"
});
