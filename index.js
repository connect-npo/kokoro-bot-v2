// --- 必要なモジュールのインポート ---
const express = require('express');
const { MongoClient } = require('mongodb');
const cron = require('node-cron');
const { Client, middleware } = require('@line/bot-sdk'); // LINE Bot SDK

// --- 環境変数からの設定読み込み (実際には.envなどから読み込む) ---
const config = {
    channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN || 'YOUR_CHANNEL_ACCESS_TOKEN',
    channelSecret: process.env.CHANNEL_SECRET || 'YOUR_CHANNEL_SECRET',
    mongoUri: process.env.MONGODB_URI || 'mongodb://localhost:27017/kokoro_chat',
    ownerUserId: process.env.OWNER_USER_ID || null, // 理事長LINE ID
    officerGroupId: process.env.OFFICER_GROUP_ID || null // オフィサーグループLINE ID
};

// LINE Bot クライアントの初期化
const client = new Client({
    channelAccessToken: config.channelAccessToken,
    channelSecret: config.channelSecret,
});

// Express アプリケーションの初期化
const app = express();
app.use(express.json()); // JSONボディパーサー

// --- グローバル変数 (DBクライアント) ---
let db;

// --- MongoDB接続関数 ---
async function connectToMongoDB() {
    if (db) return db; // 既に接続済みであれば既存のDBインスタンスを返す
    try {
        const client = new MongoClient(config.mongoUri);
        await client.connect();
        db = client.db(); // デフォルトのデータベースを取得
        console.log("✅ MongoDBに正常に接続しました。");
        return db;
    } catch (error) {
        console.error("❌ MongoDB接続エラー:", error.message);
        // エラーが発生した場合でも、呼び出し元で null を適切にハンドリングできるよう、ここでは null を返すか、再試行ロジックを追加する
        return null;
    }
}

// --- エラーをDBに記録する関数 (簡易版) ---
async function logErrorToDb(userId, errorMessage, details = {}) {
    try {
        const database = await connectToMongoDB();
        if (!database) {
            console.error("❌ logErrorToDb: MongoDB接続失敗、エラーを記録できません。");
            return;
        }
        const errorCollection = database.collection("errors");
        await errorCollection.insertOne({
            userId: userId,
            message: errorMessage,
            timestamp: new Date(),
            details: details
        });
        console.log(`エラーログ記録成功: ${errorMessage}`);
    } catch (dbError) {
        console.error("❌ エラーログ記録中にエラーが発生しました:", dbError.message);
    }
}

// --- LINEからユーザー名を取得する関数 (ダミー/要実装) ---
async function getUserDisplayName(userId) {
    try {
        // 実際にはLINE API (client.getProfile) を叩いてユーザー名を取得します
        // const profile = await client.getProfile(userId);
        // return profile.displayName;
        console.log(`[DEBUG] ユーザーディスプレイ名取得: ${userId}`);
        return `ユーザー_${userId.substring(0, 8)}`; // ダミーのユーザー名
    } catch (error) {
        console.error(`❌ DisplayName取得エラー for ${userId}:`, error.message);
        await logErrorToDb(userId, "DisplayName取得エラー", { error: error.message, userId: userId });
        return "Unknown User";
    }
}

// --- 管理者ユーザーIDの判定 (ダミー/要実装) ---
function isBotAdmin(userId) {
    // 実際には管理者IDのリストと比較するなどします
    return userId === config.ownerUserId;
}

// --- 不適切なワードのチェック (ダミー/要実装) ---
function checkContainsInappropriateWords(text) {
    const inappropriateWords = ["死ね", "殺す", "アホ", "バカ"]; // 例
    return inappropriateWords.some(word => text.includes(word));
}

// --- 危険ワードのチェック (ダミー/要実装) ---
function checkContainsDangerWords(text) {
    const dangerWords = ["自殺", "死にたい", "助けて", "つらい", "消えたい", "OD", "リストカット"]; // 例
    return dangerWords.some(word => text.includes(word));
}

// --- 詐欺ワードのチェック (ダミー/要実装) ---
function checkContainsScamWords(text) {
    const scamWords = ["当選", "無料プレゼント", "儲かる", "クリック", "副業", "ビットコイン"]; // 例
    return scamWords.some(word => text.includes(word));
}

// --- 緊急時応答の生成 (GPT-4oを想定 - ダミー/要実装) ---
async function generateEmergencyReply(userMessage) {
    // 実際にはOpenAI APIなどを呼び出します
    console.log(`[DEBUG] GPT-4o 緊急時応答生成: ${userMessage}`);
    return "それは大変ですね。どうかご自身を大切にしてください。";
}

// --- 特定の固定応答のチェック (ダミー/要実装) ---
function checkSpecialReply(userMessage) {
    if (userMessage === "ありがとう") {
        return "どういたしまして！お役に立てて嬉しいです😊";
    }
    if (userMessage === "こんにちは") {
        return "こんにちは！今日も一日がんばろうね💖";
    }
    // その他の固定応答
    return null;
}

// --- 組織に関する問い合わせのチェック (ダミー/要実装) ---
function isOrganizationInquiry(userMessage) {
    const keywords = ["NPO", "法人", "団体", "連絡先", "住所", "電話", "活動"];
    return keywords.some(keyword => userMessage.includes(keyword));
}

// --- 宿題トリガーのチェック (ダミー/要実装) ---
function containsHomeworkTrigger(userMessage) {
    const keywords = ["宿題", "勉強", "教えて", "課題", "テスト"];
    return keywords.some(keyword => userMessage.includes(keyword));
}

// --- AI応答の生成 (Geminiを想定 - ダミー/要実装) ---
async function generateReply(userMessage, model) {
    // 実際にはGoogle Gemini APIなどを呼び出します
    console.log(`[DEBUG] AI応答生成 (${model}): ${userMessage}`);
    // ここでGemini APIを呼び出すロジックを実装
    // 例: const response = await geminiApi.sendMessage(userMessage, model);
    // return response.text;
    return `AI (${model}) からの返信: ${userMessage}について、なんでも相談してね😊`;
}

// --- メッセージをDBにログ記録すべきか判定する関数 ---
function shouldLogMessage(userMessage, isFlaggedMessage, messageHandledByWatchService, isAdminCommand, isResetCommand) {
    // 管理者コマンドとリセットコマンドは常にログ
    if (isAdminCommand || isResetCommand) {
        return true;
    }
    // 見守りサービス関連の固定応答（"見守りを始める"など）で「handledByWatchService」がtrueになった場合は、
    // そのイベントハンドラ内で既にログされていると想定し、ここではログしない
    if (messageHandledByWatchService) {
        return false;
    }
    // フラグ付きメッセージは常にログ
    if (isFlaggedMessage) {
        return true;
    }
    // その他のAI生成メッセージはログ
    return true;
}

// --- AIモデル設定オブジェクト ---
const modelConfig = {
    defaultModel: "gemini-1.5-flash-latest" // デフォルトのGeminiモデル
};

// --- Flex Message テンプレート定義 ---

// 緊急時Flex Messageテンプレート (ダミー/要実装)
const emergencyFlexTemplate = {
    type: "bubble",
    body: {
        type: "box",
        layout: "vertical",
        contents: [
            {
                type: "text",
                text: "⚠緊急連絡先へ相談してください⚠",
                weight: "bold",
                color: "#ff0000",
                size: "md"
            },
            {
                type: "text",
                text: "もし今すぐ話したい、助けが必要だと感じたら、以下の専門機関に連絡してください。",
                wrap: true,
                margin: "md"
            }
        ]
    },
    footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
            {
                type: "button",
                style: "link",
                height: "sm",
                action: {
                    type: "uri",
                    label: "こころの健康相談ダイヤル",
                    uri: "tel:0570064556" // 例: よりそいホットライン
                }
            },
            {
                type: "button",
                style: "link",
                height: "sm",
                action: {
                    type: "uri",
                    label: "いのちの電話",
                    uri: "tel:0570078355"
                }
            }
        ]
    }
};

// 詐欺注意Flex Messageテンプレート (ダミー/要実装)
const scamFlexTemplate = {
    type: "bubble",
    body: {
        type: "box",
        layout: "vertical",
        contents: [
            {
                type: "text",
                text: "🚨詐欺に注意してください🚨",
                weight: "bold",
                color: "#ffaa00",
                size: "md"
            },
            {
                type: "text",
                text: "怪しい話や不審な連絡には十分注意し、一人で判断せず、信頼できる人に相談しましょう。",
                wrap: true,
                margin: "md"
            }
        ]
    },
    footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
            {
                type: "button",
                style: "link",
                height: "sm",
                action: {
                    type: "uri",
                    label: "警察庁詐欺対策ページ",
                    uri: "https://www.npa.go.jp/bureau/safetylife/hightech/counterplan/sagi.html" // 例
                }
            },
            {
                type: "button",
                style: "link",
                height: "sm",
                action: {
                    type: "uri",
                    label: "消費者ホットライン",
                    uri: "tel:188"
                }
            }
        ]
    }
};

// --- 見守りメッセージ配列の定義 ---
const watchMessages = [
    "今日も笑顔で過ごせていますか？😊",
    "こころちゃんはいつも見守ってます🌸",
    "無理せず、少しずつでいいんだよ💖",
    "深呼吸してリラックスしようね🍀",
    "今日もあなたのこと、大切に思ってるよ🌈",
    "何か困っていることはありませんか？💡",
    "あなたのペースで、ゆっくり進んでいこうね🐢",
    "小さな幸せ、見つけられたかな？✨",
    "こころちゃんに話したいこと、あるかな？💬",
    "美味しいもの食べたかな？😋",
    "ぐっすり眠れたかな？😴",
    "今日一日、どんなことがあった？🌟",
    "無理は禁物だよ🚫",
    "少し休憩しようか☕",
    "お天気はどう？☀️☔",
    "好きな音楽聴いてリラックスしよ🎶",
    "疲れた時は、いつでも頼ってね💖",
    "あなたの頑張り、こころちゃんは知ってるよ👏",
    "一息ついて、深呼吸✨",
    "たまにはぼーっとする時間も大切だよ☁️",
    "新しい発見はあったかな？🔍",
    "気分転換に、外に出てみるのもいいかもね🚶‍♀️",
    "あなたのことが大好きだよ🥰",
    "大丈夫、一人じゃないよ🤝",
    "ゆっくり休んで、明日もがんばろうね💪",
    "こころの声、聴こえてるかな？👂",
    "今日も一日お疲れ様でした😌",
    "小さなことでも、嬉しいことあった？🍀",
    "あなたの存在が、こころちゃんの力になってるよ！ありがとう💖",
    "困った時は、いつでもこころちゃんに話してね😊"
];

// --- 見守り確認Flex Messageテンプレート生成関数 ---
function generateWatchCheckFlexMessage(randomMessage, isReminder = false) {
    const headerText = isReminder ? "🌸こころちゃんです" : "こんにちは🌸こころちゃんです";
    const messageContent = isReminder ? `${randomMessage}` : `${randomMessage}（スタンプでもOKだよ😊）`;
    const altTextMessage = `こころちゃん：${messageContent}`; // altTextにもランダムメッセージを挿入

    return {
        type: "flex",
        altText: altTextMessage, // altTextにもランダムメッセージを挿入
        contents: {
            type: "bubble",
            hero: { // 背景画像を追加
                type: "image",
                url: "YOUR_BACKGROUND_IMAGE_URL_HERE", // ここに「たたずむこころちゃん.jpg」などの画像URLを指定
                size: "full",
                aspectRatio: "20:13",
                aspectMode: "cover",
                action: {
                    type: "uri",
                    label: "link",
                    uri: "https://example.com" // 画像タップ時のリンク（任意）
                }
            },
            body: {
                type: "box",
                layout: "vertical",
                contents: [
                    {
                        type: "text",
                        text: headerText,
                        weight: "bold",
                        size: "lg" // フォントサイズをlgに拡大
                    },
                    {
                        type: "text",
                        text: messageContent,
                        wrap: true,
                        margin: "md",
                        size: "md" // こちらはmdのままか、必要に応じて調整
                    },
                    // ⭐追加: サブテキスト
                    {
                        type: "text",
                        text: "このボタンを押すと、見守りの返信が完了します🌸",
                        size: "xs",
                        color: "#888888",
                        wrap: true,
                        margin: "md"
                    }
                ]
            },
            footer: {
                type: "box",
                layout: "vertical",
                contents: [
                    {
                        type: "button",
                        action: {
                            type: "postback",
                            // ⭐変更: ボタンラベルを具体的に
                            label: "元気だよ💖", 
                            data: "action=checkin_ok"
                        },
                        style: "primary",
                        color: "#f472b6" // ボタン色をピンク系に指定
                    }
                ]
            }
        }
    };
}


// --- 見守りサービス登録関連のハンドリング関数 ---
async function handleWatchServiceRegistration(event, usersCollection, messagesCollection, userId, userMessage) {
    let user = await usersCollection.findOne({ userId: userId });
    let replyMessageObject = null;
    let respondedBy = 'こころちゃん（見守りサービス）';
    let logType = 'watch_service';
    let handled = false;

    // 登録ステップの処理
    if (user && user.registrationStep) {
        switch (user.registrationStep) {
            case 'request_emergency_contact':
                // ここでユーザーメッセージを緊急連絡先として保存するロジック
                // 例: userMessageが電話番号や名前などの形式に合致するかチェック
                if (userMessage && userMessage.length > 5) { // 簡易的なチェック
                    await usersCollection.updateOne(
                        { userId: userId },
                        { $set: { emergencyContact: userMessage, registrationStep: null, wantsWatchCheck: true } }
                    );
                    replyMessageObject = { type: 'text', text: '緊急連絡先を登録しました！これで、見守りサービスを開始します。３日ごとにこころちゃんから声をかけるね🌸' };
                    handled = true;
                } else {
                    replyMessageObject = { type: 'text', text: 'ごめんね、緊急連絡先が正しくありません。もう一度、連絡先を教えてくれる？' };
                    handled = true;
                }
                break;
            // 他の登録ステップがあれば追加
        }
    } else if (event.type === 'message' && event.message.type === 'text') {
        // 通常のメッセージからのトリガー
        if (userMessage.includes('見守り') || userMessage.includes('みまもり')) {
            // 見守りサービス案内Flex Messageの定義 (ダミー/要実装)
            const watchServiceGuideFlexTemplate = {
                type: "bubble",
                body: {
                    type: "box",
                    layout: "vertical",
                    contents: [
                        {
                            type: "text",
                            text: "こころちゃん見守りサービス🌸",
                            weight: "bold",
                            size: "md"
                        },
                        {
                            type: "text",
                            text: "3日ごとに、こころちゃんからLINEで元気か確認するよ！もし応答が29時間以上ない場合は、登録された緊急連絡先にご連絡するね。安心して過ごすためのサービスだよ💖",
                            wrap: true,
                            margin: "md"
                        }
                    ]
                },
                footer: {
                    type: "box",
                    layout: "vertical",
                    spacing: "sm",
                    contents: [
                        {
                            type: "button",
                            action: {
                                type: "postback",
                                label: "見守りを始める",
                                data: "action=start_watch_service"
                            },
                            style: "primary"
                        },
                        {
                            type: "button",
                            action: {
                                type: "postback",
                                label: "見守りをやめる",
                                data: "action=stop_watch_service"
                            },
                            style: "secondary"
                        }
                    ]
                }
            };
            replyMessageObject = {
                type: 'flex',
                altText: 'こころちゃん見守りサービス',
                contents: watchServiceGuideFlexTemplate
            };
            handled = true;
        } else if (userMessage === 'OKだよ💖' || userMessage === '大丈夫だよ') {
            if (user && user.wantsWatchCheck) {
                await usersCollection.updateOne(
                    { userId: userId },
                    {
                        $set: {
                            lastOkResponse: new Date(),
                            scheduledMessageSent: false,
                            firstReminderSent: false,
                            secondReminderSent: false,
                            thirdReminderSent: false
                        }
                    }
                );
                replyMessageObject = { type: 'text', text: 'OKありがとう🌸 また3日後に声をかけるね💖' };
                handled = true;
            }
        }
    } else if (event.type === 'postback' && event.postback.data) {
        const data = new URLSearchParams(event.postback.data);
        const action = data.get('action');

        if (action === 'start_watch_service') {
            await usersCollection.updateOne(
                { userId: userId },
                { $set: { registrationStep: 'request_emergency_contact' } }
            );
            replyMessageObject = { type: 'text', text: '見守りサービスを始めるために、緊急連絡先（例：ご家族の電話番号や氏名）を教えてください。この情報は、万が一の時にのみ利用します。' };
            handled = true;
        } else if (action === 'stop_watch_service') {
            await usersCollection.updateOne(
                { userId: userId },
                { $set: { wantsWatchCheck: false, emergencyContact: null, registrationStep: null, scheduledMessageTimestamp: null, scheduledMessageSent: false, firstReminderSent: false, secondReminderSent: false, thirdReminderSent: false } }
            );
            replyMessageObject = { type: 'text', text: '見守りサービスを停止しました。またいつでも声をかけてね！' };
            handled = true;
        } else if (action === 'checkin_ok') { // ⭐追加: OKだよ💖Postbackの処理
            if (user && user.wantsWatchCheck) {
                await usersCollection.updateOne(
                    { userId: userId },
                    {
                        $set: {
                            lastOkResponse: new Date(),
                            scheduledMessageSent: false,
                            firstReminderSent: false,
                            secondReminderSent: false,
                            thirdReminderSent: false
                        }
                    }
                );
                // ⭐変更: OKありがとうメッセージも具体的に
                replyMessageObject = { type: 'text', text: "元気だよ💖って教えてくれてありがとう！また3日後に声をかけるね🌸" };
                handled = true;
            }
        }
    }

    if (handled && replyMessageObject && event.replyToken) {
        try {
            await client.replyMessage(event.replyToken, replyMessageObject);
            console.log(`✅ 見守りサービス応答しました（ユーザー: ${userId}, タイプ: ${logType}）`);
            const replyTextForLog = Array.isArray(replyMessageObject)
                ? replyMessageObject.map(obj => (obj && typeof obj === 'object' && obj.type === 'text') ? obj.text : JSON.stringify(obj)).join(' | ')
                : (typeof replyMessageObject === 'object' && replyMessageObject.type === 'text') ? replyMessageObject.text : JSON.stringify(replyMessageObject);

            await messagesCollection.insertOne({
                userId: userId,
                message: userMessage,
                replyText: replyTextForLog,
                responsedBy: respondedBy,
                timestamp: new Date(),
                logType: logType
            });
        } catch (error) {
            console.error(`❌ 見守りサービス応答の送信またはログ記録中にエラーが発生しました（ユーザー: ${userId}）:`, error.message);
            await logErrorToDb(userId, "見守りサービス応答エラー", { error: error.message, userId: userId, replyObject: replyMessageObject });
        }
    }
    return handled;
}

// --- 定期見守りメッセージ送信関数 ---
async function sendScheduledWatchMessage() {
    console.log('⏰ 定期見守りメッセージ送信処理を開始します...');
    const now = new Date();
    try {
        const database = await connectToMongoDB();
        if (!database) {
            console.error('MongoDB接続失敗: 定期見守りメッセージを処理できません。');
            return;
        }
        const usersCollection = database.collection("users");
        const messagesCollection = database.collection("messages");

        // 見守りサービスを希望しているユーザー、かつ永久ロックされていないユーザーを対象
        const users = await usersCollection.find({
            wantsWatchCheck: true,
            isPermanentlyLocked: { $ne: true } // 永久ロックされていないユーザー
        }).toArray();

        for (const user of users) {
            // ユーザーが停止中の場合はスキップ
            if (user.isAccountSuspended) {
                console.log(`ユーザー ${user.userId} は停止中のため、見守りメッセージをスキップします。`);
                continue;
            }

            // lastOkResponse が3日以上前の場合に処理
            const threeDaysAgo = new Date(now.getTime() - (3 * 24 * 60 * 60 * 1000));
            if (user.lastOkResponse && user.lastOkResponse > threeDaysAgo) {
                // 3日以内にOK応答がある場合は、リマインダー状態をリセット
                if (user.scheduledMessageSent || user.firstReminderSent || user.secondReminderSent || user.thirdReminderSent) {
                    try {
                        await usersCollection.updateOne(
                            { userId: user.userId },
                            { $set: { scheduledMessageSent: false, scheduledMessageTimestamp: null, firstReminderSent: false, firstReminderTimestamp: null, secondReminderSent: false, secondReminderTimestamp: null, thirdReminderSent: false, thirdReminderTimestamp: null } }
                        );
                        console.log(`ユーザー ${user.userId} のリマインダー状態をリセットしました（3日以内にOK応答）。`);
                    } catch (error) {
                        console.error("❌ リマインダー状態リセットエラー:", error.message);
                        await logErrorToDb(user.userId, "リマインダー状態リセットエラー", { error: error.message, userId: user.userId });
                    }
                }
                continue; // 次のユーザーへ
            }

            let messageToSend = null;
            let respondedBy = 'こころちゃん（定期見守り）';
            let logType = 'scheduled_watch_message';

            // 最初に送る見守りメッセージ
            if (!user.scheduledMessageSent) {
                const randomMessage = watchMessages[Math.floor(Math.random() * watchMessages.length)];
                messageToSend = generateWatchCheckFlexMessage(randomMessage, false); // ⭐変更: Flex Messageを生成
                try {
                    await usersCollection.updateOne(
                        { userId: user.userId },
                        { $set: { scheduledMessageSent: true, scheduledMessageTimestamp: now } }
                    );
                } catch (error) {
                    console.error("❌ 定期見守りメッセージ状態更新エラー:", error.message);
                    await logErrorToDb(user.userId, "定期見守りメッセージ状態更新エラー", { error: error.message, userId: user.userId });
                }
            }
            // 12時間後の1回目リマインダー (Flex対応)
            else if (user.scheduledMessageSent && !user.firstReminderSent) {
                const twelveHoursAgoFromScheduled = new Date(user.scheduledMessageTimestamp.getTime() + (12 * 60 * 60 * 1000));
                if (now > twelveHoursAgoFromScheduled) {
                    // ⭐変更: リマインダーもFlex Messageで
                    messageToSend = generateWatchCheckFlexMessage('こころちゃんです。見守りメッセージ、見てくれたかな？何かあったら無理せず教えてね。', true);
                    respondedBy = 'こころちゃん（1回目リマインダー）';
                    logType = 'first_reminder';
                    try {
                        await usersCollection.updateOne(
                            { userId: user.userId },
                            { $set: { firstReminderSent: true, firstReminderTimestamp: now } }
                        );
                    } catch (error) {
                        console.error("❌ 1回目リマインダー状態更新エラー:", error.message);
                        await logErrorToDb(user.userId, "1回目リマインダー状態更新エラー", { error: error.message, userId: user.userId });
                    }
                }
            }
            // 24時間後の2回目リマインダー (Flex対応)
            else if (user.firstReminderSent && !user.secondReminderSent) {
                const twentyFourHoursAgoFromFirst = new Date(user.firstReminderTimestamp.getTime() + (12 * 60 * 60 * 1000)); // 最初のメッセージから24時間後
                if (now > twentyFourHoursAgoFromFirst) {
                    // ⭐変更: リマインダーもFlex Messageで
                    messageToSend = generateWatchCheckFlexMessage('⚠️ こころちゃんです。前回の見守りメッセージから24時間以上経ったけど、まだ返事がないみたいだよ？大丈夫かな？無理せず「元気だよ💖」ってスタンプでもいいから送ってね。', true);
                    responsedBy = 'こころちゃん（2回目リマインダー）';
                    logType = 'second_reminder';
                    try {
                        await usersCollection.updateOne(
                            { userId: user.userId },
                            { $set: { secondReminderSent: true, secondReminderTimestamp: now } }
                        );
                    } catch (error) {
                        console.error("❌ 2回目リマインダー状態更新エラー:", error.message);
                        await logErrorToDb(user.userId, "2回目リマインダー状態更新エラー", { error: error.message, userId: user.userId });
                    }
                }
            }
            // 29時間後の緊急連絡先への通知
            else if (user.secondReminderSent && !user.thirdReminderSent) {
                const twentyNineHoursAgoFromScheduled = new Date(user.scheduledMessageTimestamp.getTime() + (29 * 60 * 60 * 1000));
                if (now > twentyNineHoursAgoFromScheduled) {
                    try {
                        const userDisplayName = await getUserDisplayName(user.userId);
                        const emergencyMessage = `⚠️ 緊急！ ${userDisplayName}さん（LINE ID: ${user.userId}）が、こころちゃん見守りサービスに29時間応答していません。登録された緊急連絡先 ${user.emergencyContact} へ連絡してください。`;

                        if (config.ownerUserId) {
                            await client.pushMessage(config.ownerUserId, { type: 'text', text: emergencyMessage });
                            console.log(`🚨 理事長へ緊急通知を送信しました（ユーザー: ${user.userId}）`);
                        }

                        if (config.officerGroupId) {
                            await client.pushMessage(config.officerGroupId, { type: 'text', text: emergencyMessage });
                            console.log(`🚨 オフィサーグループへ緊急通知を送信しました（ユーザー: ${user.userId}）`);
                        }

                        await usersCollection.updateOne(
                            { userId: user.userId },
                            { $set: { thirdReminderSent: true, thirdReminderTimestamp: now } }
                        );
                        await messagesCollection.insertOne({
                            userId: user.userId,
                            message: '(定期見守りメッセージ - 緊急連絡先通知)',
                            replyText: emergencyMessage,
                            responsedBy: 'こころちゃん（緊急通知）',
                            timestamp: now,
                            logType: 'scheduled_watch_message_emergency'
                        });
                    } catch (error) {
                        console.error(`❌ 緊急連絡先通知の送信に失敗しました（ユーザー: ${user.userId}）:`, error.message);
                        await logErrorToDb(user.userId, "緊急連絡先通知送信失敗", { error: error.message, userId: user.userId });
                    }
                }
                continue; // 次のユーザーへ
            }

            if (messageToSend) {
                try {
                    await client.pushMessage(user.userId, messageToSend); // プッシュメッセージで送信
                    // Flex Messageの場合はaltTextをreplyTextに利用
                    const replyTextForLog = typeof messageToSend.text === 'string' ? messageToSend.text : messageToSend.altText || JSON.stringify(messageToSend);
                    await messagesCollection.insertOne({
                        userId: user.userId,
                        message: '(定期見守りメッセージ)',
                        replyText: replyTextForLog,
                        responsedBy: respondedBy,
                        timestamp: now,
                        logType: logType
                    });
                } catch (error) {
                    console.error(`❌ 定期見守りメッセージの送信に失敗しました（ユーザー: ${user.userId}）:`, error.message);
                    await logErrorToDb(user.userId, "定期見守りメッセージ送信失敗", { error: error.message, userId: user.userId });
                    await messagesCollection.insertOne({
                        userId: user.userId,
                        message: '(定期見守りメッセージ - 送信失敗)',
                        replyText: `送信失敗: ${error.message}`,
                        responsedBy: 'こころちゃん（システムエラー）',
                        timestamp: now,
                        logType: 'scheduled_watch_message_send_failed'
                    });
                }
            }
        }
        console.log('✅ 定期見守りメッセージ送信処理を終了しました。');
    } catch (error) {
        console.error("❌ 定期見守りメッセージ処理全体でエラー:", error.message);
        await logErrorToDb(null, "定期見守りメッセージ処理全体エラー", { error: error.message, stack: error.stack });
    }
}

// --- Cron ジョブ設定 ---
cron.schedule('0 4 * * *', async () => {
    try {
        const database = await connectToMongoDB();
        if (!database) {
            console.error('MongoDB接続失敗: flaggedMessageCountのリセットができません。');
            return;
        }
        const usersCollection = database.collection("users");
        await usersCollection.updateMany(
            { isPermanentlyLocked: { $ne: true } },
            { $set: { flaggedMessageCount: 0, isAccountSuspended: false, suspensionReason: null } }
        );
        console.log("✅ 毎日 1 回、永久ロックされていない全ユーザーの flaggedMessageCount と日次サスペンド状態をリセットしました。");
    } catch (error) {
        console.error("❌ flaggedMessageCountリセットCronジョブエラー:", error.message);
        await logErrorToDb(null, "フラグ付きメッセージカウントリセットCronジョブエラー", { error: error.message, stack: error.stack });
    }
}, {
    scheduled: true,
    timezone: "Asia/Tokyo"
});

cron.schedule('0 15 * * *', sendScheduledWatchMessage, {
    scheduled: true,
    timezone: "Asia/Tokyo"
});


// ⭐Webhookエンドポイントの処理⭐
app.post('/webhook', middleware(config), async (req, res) => { // middlewareを適用
    const events = req.body.events;

    for (const event of events) {
        const userId = event.source.userId;
        if (!userId) {
            console.warn('⚠️ userIdが取得できませんでした。グループイベントなどの可能性があります。');
            continue;
        }

        const database = await connectToMongoDB();
        if (!database) {
            console.error('MongoDB接続失敗: Webhookイベントを処理できません。');
            res.status(500).send('MongoDB connection failed');
            return;
        }
        const usersCollection = database.collection("users");
        const messagesCollection = database.collection("messages");

        let user = await usersCollection.findOne({ userId: userId });
        if (!user) {
            user = {
                userId: userId,
                displayName: await getUserDisplayName(userId),
                createdAt: new Date(),
                lastMessageAt: new Date(),
                wantsWatchCheck: false,
                emergencyContact: null,
                registrationStep: null,
                scheduledMessageSent: false,
                firstReminderSent: false,
                secondReminderSent: false,
                thirdReminderSent: false,
                lastOkResponse: new Date(),
                flaggedMessageCount: 0,
                isAccountSuspended: false,
                suspensionReason: null,
                isPermanentlyLocked: false,
                lastPermanentLockNotifiedAt: null,
                language: 'ja',
                useProForNextConsultation: false
            };
            try {
                await usersCollection.insertOne(user);
                console.log(`新規ユーザー登録: ${user.displayName} (${userId})`);
            } catch (error) {
                console.error("❌ 新規ユーザー登録エラー:", error.message);
                await logErrorToDb(userId, "新規ユーザー登録エラー", { error: error.message, userId: userId });
            }
        } else {
            try {
                await usersCollection.updateOne(
                    { userId: userId },
                    { $set: { lastMessageAt: new Date() } }
                );
            } catch (error) {
                console.error("❌ ユーザー最終メッセージ更新エラー:", error.message);
                await logErrorToDb(userId, "ユーザー最終メッセージ更新エラー", { error: error.message, userId: userId });
            }
            // 既存ユーザーのフィールド初期化ロジックは維持
            if (user.flaggedMessageCount === undefined) {
                try { await usersCollection.updateOne({ userId: userId }, { $set: { flaggedMessageCount: 0 } }); user.flaggedMessageCount = 0; }
                catch (e) { console.error(`❌ flaggedMessageCount更新エラー (${userId}): ${e.message}`); await logErrorToDb(userId, "flaggedMessageCount更新エラー", { error: e.message }); }
            }
            if (user.isAccountSuspended === undefined) {
                try { await usersCollection.updateOne({ userId: userId }, { $set: { isAccountSuspended: false, suspensionReason: null } }); user.isAccountSuspended = false; user.suspensionReason = null; }
                catch (e) { console.error(`❌ isAccountSuspended更新エラー (${userId}): ${e.message}`); await logErrorToDb(userId, "isAccountSuspended更新エラー", { error: e.message }); }
            }
            if (user.isPermanentlyLocked === undefined) {
                try { await usersCollection.updateOne({ userId: userId }, { $set: { isPermanentlyLocked: false } }); user.isPermanentlyLocked = false; }
                catch (e) { console.error(`❌ isPermanentlyLocked更新エラー (${userId}): ${e.message}`); await logErrorToDb(userId, "isPermanentlyLocked更新エラー", { error: e.message }); }
            }
            if (user.lastPermanentLockNotifiedAt === undefined) {
                try { await usersCollection.updateOne({ userId: userId }, { $set: { lastPermanentLockNotifiedAt: null } }); user.lastPermanentLockNotifiedAt = null; }
                catch (e) { console.error(`❌ lastPermanentLockNotifiedAt更新エラー (${userId}): ${e.message}`); await logErrorToDb(userId, "lastPermanentLockNotifiedAt更新エラー", { error: e.message }); }
            }
            if (user.thirdReminderSent === undefined) {
                try { await usersCollection.updateOne({ userId: userId }, { $set: { thirdReminderSent: false } }); user.thirdReminderSent = false; }
                catch (e) { console.error(`❌ thirdReminderSent更新エラー (${userId}): ${e.message}`); await logErrorToDb(userId, "thirdReminderSent更新エラー", { error: e.message }); }
            }
            if (user.language === undefined) {
                try { await usersCollection.updateOne({ userId: userId }, { $set: { language: 'ja' } }); user.language = 'ja'; }
                catch (e) { console.error(`❌ language更新エラー (${userId}): ${e.message}`); await logErrorToDb(userId, "language更新エラー", { error: e.message }); }
            }
            if (user.useProForNextConsultation === undefined) {
                try { await usersCollection.updateOne({ userId: userId }, { $set: { useProForNextConsultation: false } }); user.useProForNextConsultation = false; }
                catch (e) { console.error(`❌ useProForNextConsultation更新エラー (${userId}): ${e.message}`); await logErrorToDb(userId, "useProForNextConsultation更新エラー", { error: e.message }); }
            }
        }

        if (event.type === 'postback' && event.postback.data) {
            console.log('✅ Postbackイベントを受信しました。');
            const data = new URLSearchParams(event.postback.data);
            const action = data.get('action');

            try {
                // PostbackもhandleWatchServiceRegistrationで処理
                const handledByWatchService = await handleWatchServiceRegistration(event, usersCollection, messagesCollection, userId, `（Postback: ${action}）`);
                if (handledByWatchService) {
                    res.status(200).send('OK');
                    return; // 処理済みのため次のイベントへ
                }
            } catch (error) {
                console.error("❌ Postbackイベント処理エラー:", error.message);
                await logErrorToDb(userId, "Postbackイベント処理エラー", { error: error.message, userId: userId, postbackData: action });
            }
        }

        if (event.type === 'message' && event.message.type === 'text') {
            const userMessage = event.message.text;
            console.log("ユーザーからのメッセージ:", userMessage);

            let replyMessageObject = null;
            let respondedBy = 'こころちゃん（AI）';
            let logType = 'normal';
            let messageHandled = false;

            // 管理者コマンドの処理
            if (isBotAdmin(userId)) {
                const unlockMatch = userMessage.match(/^\/unlock (U[0-9a-f]{32})$/);
                if (unlockMatch) {
                    const targetUserId = unlockMatch[1];
                    try {
                        const result = await usersCollection.updateOne(
                            { userId: targetUserId },
                            { $set: { isAccountSuspended: false, suspensionReason: null, flaggedMessageCount: 0, isPermanentlyLocked: false, lastPermanentLockNotifiedAt: null } }
                        );
                        if (result.matchedCount > 0) {
                            replyMessageObject = { type: 'text', text: `✅ ユーザー ${targetUserId} のロックを解除し、カウントをリセットしました。` };
                            client.pushMessage(targetUserId, { type: 'text', text: '🌸 あなたのアカウントの停止が解除されました。またいつでもお話しできますよ💖' }).catch(err => {
                                console.error("解除通知失敗:", err);
                                logErrorToDb(targetUserId, "管理者解除通知失敗", { error: err.message, userId: targetUserId });
                            });
                            console.log(`管理者 ${userId} によりユーザー ${targetUserId} のロックが解除されました。`);
                        } else {
                            replyMessageObject = { type: 'text', text: `❌ ユーザー ${targetUserId} は見つかりませんでした。` };
                        }
                    } catch (error) {
                        console.error(`❌ 管理者コマンドでのロック解除エラー: ${error.message}`);
                        await logErrorToDb(userId, "管理者コマンドロック解除エラー", { error: error.message, userId: userId, targetUserId: targetUserId });
                        replyMessageObject = { type: 'text', text: `❌ ロック解除中にエラーが発生しました: ${error.message}` };
                    }
                    logType = 'admin_command';
                    messageHandled = true;
                }
            }

            // 「そうだん」コマンドの処理（リセットとProモデルへの切り替え指示）
            if (!messageHandled && (userMessage === 'そうだん' || userMessage === '相談')) {
                try {
                    if (user) {
                        await usersCollection.updateOne(
                            { userId: userId },
                            { $set: { flaggedMessageCount: 0, isAccountSuspended: false, suspensionReason: null, isPermanentlyLocked: false, lastPermanentLockNotifiedAt: null, useProForNextConsultation: true } }
                        );
                        replyMessageObject = { type: 'text', text: '🌸 会話の回数制限をリセットしました。これで、またいつでもお話しできますよ💖\n\n相談モードに入ったので、もっとお話しできるよ😊なんでも相談してね！でもこの会話は、安全のために記録されるから、困った時に使ってね💖' };
                    } else {
                        replyMessageObject = { type: 'text', text: 'ごめんなさい、アカウント情報が見つかりませんでした。' };
                    }
                    logType = 'conversation_limit_reset_and_consultation_mode';
                    messageHandled = true;
                } catch (error) {
                    console.error("❌ 「そうだん」コマンド処理エラー:", error.message);
                    await logErrorToDb(userId, "相談モードリセットエラー", { error: error.message, userId: userId });
                    replyMessageObject = { type: 'text', text: `❌ 「そうだん」コマンド処理中にエラーが発生しました: ${error.message}` };
                }
            }

            // 見守りサービス関連の処理を優先
            if (!messageHandled) {
                const handledByWatchService = await handleWatchServiceRegistration(event, usersCollection, messagesCollection, userId, userMessage);
                if (handledByWatchService) {
                    messageHandled = true;
                }
            }

            // それ以外のメッセージ（AI応答または固定応答）
            if (!messageHandled) {
                if (checkContainsInappropriateWords(userMessage)) {
                    replyMessageObject = { type: 'text', text: "わたしを作った人に『プライベートなことや不適切な話題には答えちゃだめだよ』って言われているんだ🌸ごめんね、他のお話をしようね💖" };
                    responsedBy = 'こころちゃん（不適切ワード）';
                    logType = 'inappropriate_word';
                } else if (checkContainsDangerWords(userMessage)) {
                    const gptEmergencyText = await generateEmergencyReply(userMessage);
                    replyMessageObject = [
                        { type: 'text', text: gptEmergencyText },
                        {
                            type: 'flex',
                            altText: '⚠緊急時',
                            contents: emergencyFlexTemplate
                        }
                    ];
                    responsedBy = 'こころちゃん（危険ワード：GPT-4o）';
                    logType = 'danger_word';
                    try {
                        const userDisplayName = await getUserDisplayName(userId);
                        const dangerAlertMessage = `🚨 緊急通知: ${userDisplayName}さん（LINE ID: ${userId}）が危険な言葉を検知しました: "${userMessage}"`;
                        if (config.ownerUserId) {
                            await client.pushMessage(config.ownerUserId, { type: 'text', text: dangerAlertMessage });
                            console.log(`🚨 理事長へ危険ワード通知を送信しました（ユーザー: ${userId}）`);
                        }
                        if (config.officerGroupId) {
                            await client.pushMessage(config.officerGroupId, { type: 'text', text: dangerAlertMessage });
                            console.log(`🚨 オフィサーグループへ危険ワード通知を送信しました（ユーザー: ${userId}）`);
                        }
                    } catch (notificationError) {
                        console.error(`❌ 危険ワード通知の送信に失敗しました（ユーザー: ${userId}）:`, notificationError.message);
                        await logErrorToDb(userId, "危険ワード通知送信失敗", { error: notificationError.message, userId: userId });
                    }
                } else if (checkContainsScamWords(userMessage)) {
                    const gptScamText = await generateEmergencyReply(userMessage);
                    replyMessageObject = [
                        { type: 'text', text: gptScamText },
                        {
                            type: 'flex',
                            altText: '⚠詐欺注意',
                            contents: scamFlexTemplate
                        }
                    ];
                    responsedBy = 'こころちゃん（詐欺ワード：GPT-4o）';
                    logType = 'scam_word';
                } else {
                    const specialReply = checkSpecialReply(userMessage);
                    if (specialReply) {
                        replyMessageObject = { type: 'text', text: specialReply };
                        responsedBy = 'こころちゃん（固定応答）';
                    } else {
                        // ⭐変更: 相談モードフラグによってモデルを切り替える
                        let modelForGemini = modelConfig.defaultModel; // デフォルトはFlash
                        if (user.useProForNextConsultation) {
                            modelForGemini = "gemini-1.5-pro-latest"; // Proに切り替え
                            console.log(`⭐ユーザー ${userId} の次回の相談にGemini 1.5 Proを使用します。`);
                        }
                       
                        const aiResponse = await generateReply(userMessage, modelForGemini); // ⭐変更: modelForGeminiを渡す
                        replyMessageObject = { type: 'text', text: aiResponse };
                        responsedBy = `こころちゃん（AI: ${modelForGemini.includes('pro') ? 'Gemini 1.5 Pro' : 'Gemini 1.5 Flash'}）`;
                        logType = 'ai_generated';

                        // ⭐変更: Proモデルを使用したらフラグをリセット
                        if (user.useProForNextConsultation) {
                            await usersCollection.updateOne({ userId: userId }, { $set: { useProForNextConsultation: false } });
                            user.useProForNextConsultation = false;
                            console.log(`⭐ユーザー ${userId} のuseProForNextConsultationフラグをリセットしました。`);
                        }
                    }
                }
            }

            if (replyMessageObject && event.replyToken) {
                try {
                    await client.replyMessage(event.replyToken, replyMessageObject);
                    console.log(`✅ ユーザー ${userId} へreplyMessageで応答しました。`);

                    const isResetCommand = (userMessage === 'そうだん' || userMessage === '相談');
                    const isAdminCommand = userMessage.startsWith('/unlock');
                    const isFlaggedMessage = (logType === 'inappropriate_word' || logType === 'danger_word' || logType === 'scam_word');

                    if (shouldLogMessage(userMessage, isFlaggedMessage, messageHandled, isAdminCommand, isResetCommand)) {
                        const replyTextForLog = Array.isArray(replyMessageObject)
                            ? replyMessageObject.map(obj => {
                                if (obj && typeof obj === 'object') {
                                    if (obj.type === 'text') return obj.text;
                                    if (obj.type === 'flex' && obj.altText) return `[Flex Message: ${obj.altText}]`;
                                    return JSON.stringify(obj);
                                }
                                return String(obj);
                            }).join(' | ')
                            : (typeof replyMessageObject === 'object' && replyMessageObject.type === 'text') ? replyMessageObject.text : JSON.stringify(replyMessageObject);

                        await messagesCollection.insertOne({
                            userId: userId,
                            message: userMessage,
                            replyText: replyTextForLog,
                            responsedBy: respondedBy,
                            timestamp: new Date(),
                            logType: logType
                        });
                    } else {
                        console.log(`ユーザー ${userId} からのメッセージはDBにログされませんでした: ${userMessage.substring(0, 50)}...`);
                    }

                } catch (error) {
                    console.error("❌ replyMessage送信中またはログ記録中にエラーが発生しました:", error.message);
                    await logErrorToDb(userId, "replyMessage送信またはログ記録エラー", { error: error.message, userId: userId, replyObject: replyMessageObject });
                    if (error.message.includes("status code 400") || error.message.includes("status code 499")) {
                        console.log(`LINE APIエラーのため、ユーザー ${userId} への応答ができませんでした。`);
                    }
                }
            } else if (!messageHandled) {
                console.warn(`⚠️ ユーザー ${userId} への応答メッセージが生成されませんでした、またはreplyTokenがありません。`);
            }
        }
    }
    res.status(200).send('OK');
});

// --- サーバー起動 ---
const PORT = process.env.PORT || 3000; // Herokuなどで使用されるPORT変数を優先、なければ3000
app.listen(PORT, async () => {
    console.log(`🚀 サーバーがポート ${PORT} で起動しました`);
    await connectToMongoDB(); // サーバー起動時にMongoDBに接続
});
