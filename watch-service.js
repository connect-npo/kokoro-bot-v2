const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');
const { Line } = require('@line/bot-sdk');
const cron = require('node-cron');
// 環境変数からFirebase認証情報を取得して初期化
const firebaseCredentialsBase64 = process.env.FIREBASE_CREDENTIALS_BASE64;
if (!firebaseCredentialsBase64) {
    console.error('FIREBASE_CREDENTIALS_BASE64 環境変数が設定されていません。');
    process.exit(1);
}
const serviceAccount = JSON.parse(Buffer.from(firebaseCredentialsBase64, 'base64').toString());
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}
const db = getFirestore();

// LINEのクライアントを初期化
const client = new Line({
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN
});

// メッセージ送信関数
// index.jsから safePushMessage 関数をコピーして貼り付ける
// この関数内で client.pushMessage を使っているはず
async function safePushMessage(userId, message) {
  try {
    await client.pushMessage(userId, message);
  } catch (error) {
    console.error('Push Message Error:', error);
  }
}
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

// ⭐ 最終修正版: 見守りサービスの定期実行処理 ⭐

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

            // 修正: 最後にOK応答があってから3日以上経過していて、OK応答確認中ではない場合
            if (diffDays >= 3 && !userData.firstReminderSent) {
                const randomMessage = watchMessages[Math.floor(Math.random() * watchMessages.length)];
                await safePushMessage(userId, { type: 'text', text: randomMessage });
                await db.collection('users').doc(userId).update({
                    lastScheduledWatchMessageSent: admin.firestore.Timestamp.fromDate(now),
                    firstReminderSent: true // OK応答確認状態に設定
                });
                console.log(`✅ 定期見守りメッセージを送信しました: ${userId}`);
            }
        }
    } catch (error) {
        console.error('❌ Cronジョブ: 定期見守りメッセージ送信中にエラーが発生しました:', error);
    }
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
            // firstReminderSentがtrue、緊急通知が未送信、最後にメッセージを送信した記録がある
            if (userData.firstReminderSent && !userData.emergencyNotificationSent && userData.lastScheduledWatchMessageSent) {
                const lastSentTime = userData.lastScheduledWatchMessageSent.toDate().getTime();
                const diffHours = (now.getTime() - lastSentTime) / (1000 * 60 * 60);

                // 初回送信から24時間以上経過していて、OK応答がない場合
                if (diffHours >= 24) {
                    const message = "あれ？こころからのメッセージ見てくれたかな？何かあったのかな？少し心配だよ💦　よかったら、元気だよって返信してくれないかな？";
                    await safePushMessage(userId, { type: 'text', text: message });

                    await db.collection('users').doc(userId).update({
                        // 再送信日時を記録
                        lastScheduledWatchMessageSent: admin.firestore.Timestamp.fromDate(now)
                    });
                    console.log(`✅ 24時間後リマインダーを送信しました: ${userId}`);
                }
            }
        }
    } catch (error) {
        console.error('❌ Cronジョブ: 24時間後リマインダー送信中にエラーが発生しました:', error);
    }
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

                // 24時間後リマインダー送信から5時間以上経過していて、OK応答がない場合
                if (diffHours >= 5) {
                    const emergencyMessage = `🚨緊急通知🚨\n[ユーザーID: ${userId}]\n[ユーザー名: ${userData.name || '不明'}]\n[電話番号: ${userData.phoneNumber || '不明'}]\n[住所: ${userData.address?.city || '不明'}]\n\n見守りサービス応答なし。\n${userData.guardianName || '緊急連絡先様'}様、ご確認をお願いします。\n[緊急連絡先: ${userData.guardianPhoneNumber || '不明'}]`;
                    const officerGroupId = process.env.OFFICER_GROUP_ID;
                    if (officerGroupId) {
                        await safePushMessage(officerGroupId, { type: 'text', text: emergencyMessage });
                        console.log(`🚨 緊急通知を送信しました: GroupId=${officerGroupId}, UserId=${userId}`);
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
});
