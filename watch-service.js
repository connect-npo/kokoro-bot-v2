// --- index.jsから共有されたオブジェクトをインポート ---
const { db, admin, client } = require('./index.js');
const { getFirestore, Timestamp, FieldValue } = require('firebase-admin/firestore');
const cron = require('node-cron');

// --- 環境変数 ---
const EMERGENCY_CONTACT_PHONE_NUMBER = process.env.EMERGENCY_CONTACT_PHONE_NUMBER || '09048393313';
const OFFICER_GROUP_ID = process.env.OFFICER_GROUP_ID;

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
// 毎日12時に見守りサービスのチェックを実行
cron.schedule('0 12 * * *', async () => {
    try {
        console.log("⏰ cron: 見守りサービスのステータスをチェックします...");
        const now = Timestamp.now().toDate();
        const oneDayMs = 24 * 60 * 60 * 1000;
        const fiveHoursMs = 5 * 60 * 60 * 1000;

        const usersRef = db.collection('users').where('watchServiceEnabled', '==', true);
        const snapshot = await usersRef.get();

        for (const doc of snapshot.docs) {
            const userData = doc.data();
            const userId = doc.id;
            const lastActivityTime = userData.lastOkResponse ? userData.lastOkResponse.toDate() : new Date(0);
            const lastScheduledTime = userData.lastScheduledWatchMessageSent ? userData.lastScheduledWatchMessageSent.toDate() : new Date(0);
            const lastActionTime = lastActivityTime > lastScheduledTime ? lastActivityTime : lastScheduledTime;
            const timeSinceLastAction = now.getTime() - lastActionTime.getTime();

            // 3日経過したユーザーに新しい見守りメッセージを送信
            if (timeSinceLastAction > 3 * oneDayMs) {
                const randomIndex = Math.floor(Math.random() * watchMessages.length);
                const randomMessage = watchMessages[randomIndex];
                await safePushMessage(userId, { type: 'text', text: randomMessage });
                await doc.ref.update({ lastScheduledWatchMessageSent: Timestamp.now(), firstReminderSent: false, emergencyNotificationSent: false });
                continue;
            }

            // 3日以内のメッセージに返信がない場合のリマインダーと緊急通知
            if (timeSinceLastAction > 24 * 60 * 60 * 1000 && !userData.firstReminderSent) {
                await safePushMessage(userId, { type: 'text', text: '前回のメッセージから24時間経ちました。大丈夫ですか？' });
                await doc.ref.update({ firstReminderSent: true });
            } else if (timeSinceLastAction > 29 * 60 * 60 * 1000 && userData.firstReminderSent && !userData.emergencyNotificationSent) {
                // 24時間後リマインダーから5時間経過
                const flexMessage = {
                    type: 'flex',
                    altText: '緊急通知',
                    contents: {
                        type: 'bubble',
                        body: {
                            type: 'box',
                            layout: 'vertical',
                            contents: [
                                { type: 'text', text: '🚨 【見守りサービス緊急通知】 🚨', weight: 'bold', color: '#ff0000', size: 'md' },
                                { type: 'separator', margin: 'md' },
                                { type: 'box', layout: 'vertical', margin: 'md', contents: [
                                    { type: 'text', text: `👤 氏名：${userData.name || '不明'}`, size: 'sm', wrap: true },
                                    { type: 'text', text: `📱 電話番号：${userData.phone || '不明'}`, size: 'sm', wrap: true },
                                    { type: 'text', text: `📞 緊急連絡先：${userData.emergencyContact || EMERGENCY_CONTACT_PHONE_NUMBER}`, size: 'sm', wrap: true }
                                ]}
                            ]
                        }
                    }
                };
                if (OFFICER_GROUP_ID) {
                    await safePushMessage(OFFICER_GROUP_ID, flexMessage);
                }
                await doc.ref.update({ emergencyNotificationSent: true });
            }
        }
        console.log("✅ cron: 見守りサービスのチェックが完了しました。");
    } catch (error) {
        console.error("❌ cron: 見守りサービスのチェック中にエラーが発生しました:", error);
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
