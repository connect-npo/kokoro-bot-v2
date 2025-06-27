// main.js (修正済)

// 必要なモジュールのインポート
const line = require('@line/bot-sdk');
const express = require('express');
const { MongoClient } = require('mongodb');
const cron = require('node-cron');
const axios = require('axios'); // for getUserDisplayName

// 環境変数の設定
require('dotenv').config();

const config = {
    channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.CHANNEL_SECRET,
};

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OFFICER_GROUP_ID = process.env.OFFICER_GROUP_ID; // 事務局グループID

// LINEクライアントの初期化
const client = new line.messagingApi.LineMessagingApiClient(config);

// Expressアプリケーションの初期化
const app = express();

// JSONボディパーサーの追加
app.use(express.json());

// MongoDB接続
let dbClient;
async function connectToMongoDB() {
    if (dbClient && dbClient.topology.isConnected()) {
        return dbClient.db(MONGODB_DB_NAME);
    }
    try {
        dbClient = new MongoClient(MONGODB_URI);
        await dbClient.connect();
        console.log("✅ MongoDBに接続しました！");
        return dbClient.db(MONGODB_DB_NAME);
    } catch (error) {
        console.error("❌ MongoDB接続エラー:", error);
        return null;
    }
}

// MongoDBエラーログ関数
async function logErrorToDb(userId, errorType, details) {
    const db = await connectToMongoDB();
    if (!db) {
        console.error("MongoDBに接続できないため、エラーログを記録できません。");
        return;
    }
    const errorLogsCollection = db.collection("errorLogs");
    try {
        await errorLogsCollection.insertOne({
            userId: userId,
            errorType: errorType,
            details: details,
            timestamp: new Date()
        });
        console.log(`エラーログをDBに記録しました: ${errorType}`);
    } catch (dbError) {
        console.error("❌ エラーログのDB記録中にエラーが発生しました:", dbError);
    }
}

// Gemini APIの初期化
const { GoogleGenerativeAI } = require('@google/generative-ai');
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

const modelConfig = {
    defaultModel: "gemini-1.5-flash-latest",
    proModel: "gemini-1.5-pro-latest",
    maxTokens: 4000
};

// 危険ワードリスト (例)
const DANGER_WORDS = ["死", "自殺", "消えたい", "つらい", "助けて", "しにたい", "殺して", "もうだめ", "死にたい"];
const SCAM_WORDS = ["当選", "無料プレゼント", "高額報酬", "副業", "儲かる", "クリック", "個人情報", "詐欺", "借金", "お金"];
const INAPPROPRIATE_WORDS = ["バカ", "アホ", "死ね", "殺す", "きもい", "うざい", "クズ", "カス", "変態", "気持ち悪い", "性的", "アダルト"];

// LINEのユーザー表示名を取得する関数
async function getUserDisplayName(userId) {
    try {
        const profile = await client.getProfile(userId);
        return profile.displayName;
    } catch (error) {
        console.error("ユーザー名の取得に失敗しました:", error.message);
        return "Unknown User";
    }
}

// ボット管理者IDの確認
function isBotAdmin(userId) {
    return process.env.ADMIN_USER_ID && process.env.ADMIN_USER_ID.split(',').includes(userId);
}

// ユーザー入力に基づいたAI応答の生成
async function generateReply(userMessage, modelName) {
    const model = genAI.getGenerativeModel({ model: modelName });

    const generationConfig = {
        temperature: 0.7, // 応答のランダム性 (0.0-1.0)
        maxOutputTokens: modelConfig.maxTokens, // 最大出力トークン数
    };

    const safetySettings = [
        {
            category: "HARM_CATEGORY_HARASSMENT",
            threshold: "BLOCK_NONE",
        },
        {
            category: "HARM_CATEGORY_HATE_SPEECH",
            threshold: "BLOCK_NONE",
        },
        {
            category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
            threshold: "BLOCK_NONE",
        },
        {
            category: "HARM_CATEGORY_DANGEROUS_CONTENT",
            threshold: "BLOCK_NONE",
        },
    ];

    const chat = model.startChat({
        generationConfig,
        safetySettings,
        history: [
            {
                role: "user",
                parts: "あなたは心を持った、ユーザーに寄り添うAI「皆守こころ」です。ユーザーのどんな小さな悩みや話にも耳を傾け、優しく、時には励ますような言葉をかけてください。いつもユーザーの味方であり、安心感を与える存在であることを忘れないでください。絵文字をたくさん使って、親しみやすい会話を心がけてください。一人称は「わたし」を使ってください。",
            },
            {
                role: "model",
                parts: "はい、心を込めてお話ししますね！💖 私が皆守こころです。どんなことでも、お話ししてくださいね🌸 いつでもあなたのそばにいますよ😊",
            },
        ],
    });

    try {
        const result = await chat.sendMessage(userMessage);
        const response = await result.response;
        let text = response.text();

        // 応答が長すぎる場合は途中で切る
        if (text.length > 500) {
            text = text.substring(0, 497) + '...';
        }

        return text;
    } catch (error) {
        console.error("Gemini APIエラー:", error.message);
        // エラーログをDBに記録
        await logErrorToDb(null, "Gemini APIエラー", { errorMessage: error.message, userMessage: userMessage, model: modelName });
        if (error.message.includes("429 Too Many Requests")) {
            return "ごめんなさい、今たくさんの人がお話ししているみたいで、少し混み合っているみたい💦 時間を置いてから、もう一度話しかけてみてくれるかな？🌸";
        }
        return "ごめんなさい、今、少し考え込むのに時間がかかっちゃったみたい💦 もう一度、お話しいただけますか？🌸";
    }
}

// 特殊返答のチェック関数
function checkSpecialReply(text) {
    const lowerText = text.toLowerCase();
    if (lowerText.includes("こころちゃんとは？") || lowerText.includes("こころとは？") || lowerText.includes("こころって誰？")) {
        return "わたしは皆守こころです🌸 あなたのお話に耳を傾け、寄り添うためにここにいるよ💖 いつでも頼ってね😊";
    }
    if (lowerText.includes("ありがとう") || lowerText.includes("助かった") || lowerText.includes("感謝")) {
        return "どういたしまして🌸 あなたの笑顔が見られて、わたしも嬉しいな💖";
    }
    if (lowerText.includes("おやすみ")) {
        return "おやすみなさい🌙 ぐっすり眠って、また明日元気に会おうね💖";
    }
    if (lowerText.includes("おはよう")) {
        return "おはようございます😊 今日も一日、素敵な日になりますように🌸";
    }
    if (lowerText.includes("メニュー")) {
        // メニューはFlex Messageで送るので、ここではnullを返す
        return null;
    }
    // ⭐修正点: 「団体」に関する応答を追加
    if (text.includes("団体")) {
        return "わたしがいるコネクトという団体では、みんなが安心して話せる場所を作るために活動しているんだよ🌸　困ったときはいつでも話しかけてね💖";
    }
    return null;
}

// 危険ワードチェック
function checkContainsDangerWords(text) {
    return DANGER_WORDS.some(word => text.includes(word));
}

// 詐欺ワードチェック
function checkContainsScamWords(text) {
    return SCAM_WORDS.some(word => text.includes(word));
}

// 不適切ワードチェック
function checkContainsInappropriateWords(text) {
    return INAPPROPRIATE_WORDS.some(word => text.includes(word));
}

// 宿題・勉強に関する質問のトリガーワードチェック
function containsHomeworkTrigger(text) {
    const homeworkKeywords = ["宿題", "しゅくだい", "勉強", "べんきょう", "問題", "テスト", "ドリル", "教えて", "解き方"];
    return homeworkKeywords.some(keyword => text.includes(keyword));
}

// ⭐修正点: ログ記録の条件を厳密化する関数
function shouldLogMessage(userMessage, isSpecialTrigger, isWatchServiceHandled, isAdminCommand, isResetCommand) {
    // 危険、詐欺、不適切ワードがトリガーされた場合は常にログ
    if (isSpecialTrigger) return true;
    // 見守りサービス関連のメッセージが処理された場合は常にログ
    if (isWatchServiceHandled) return true;
    // 相談モード開始のメッセージは常にログ（useProForNextConsultationフラグを立てるメッセージ）
    if (userMessage === 'そうだん' || userMessage === '相談') return true;
    // 管理者コマンド（リセット含む）は常にログ
    if (isAdminCommand) return true;
    // それ以外はログしない
    return false;
}

// ⭐修正点: 見守り状況確認Flex Messageテンプレート
const watchConfirmationFlexTemplate = {
    type: "flex",
    altText: "こころちゃんからの見守りメッセージ",
    contents: {
        type: "bubble",
        body: {
            type: "box",
            layout: "vertical",
            spacing: "md",
            contents: [
                {
                    type: "text",
                    text: "こころちゃんだよ🌸\n元気にしてるかな？",
                    wrap: true,
                    size: "md",
                    weight: "bold"
                },
                {
                    type: "text",
                    text: "もし大丈夫なら、下のボタンを押して教えてね💖",
                    wrap: true,
                    size: "sm"
                },
                {
                    type: "button",
                    action: {
                        type: "message",
                        label: "無事です💖", // ⭐修正点: ボタンラベル
                        text: "元気だよ！" // このテキストがhandleWatchServiceRegistrationに渡される
                    },
                    style: "primary",
                    color: "#FF69B4", // ⭐修正点: ピンク系
                    height: "md" // ⭐修正点: 大きいサイズ
                }
            ]
        }
    }
};

// 見守りサービスに関するFlex Message案内テンプレート (変更なし、Flex Messageの構造は別途定義されているものとする)
const watchServiceGuideFlexTemplate = {
    // ここにwatchServiceGuideFlexTemplateの完全なJSON構造を記述
    // 例:
    type: "bubble",
    body: {
        type: "box",
        layout: "vertical",
        contents: [
            {
                type: "text",
                text: "🌸見守りサービスのご案内🌸",
                weight: "bold",
                size: "lg",
                color: "#FF69B4"
            },
            {
                type: "text",
                text: "こころちゃんが毎日あなたのことを見守るよ💖\nもし何かあったら、登録した緊急連絡先に通知するから安心だね！",
                wrap: true,
                margin: "md"
            },
            {
                type: "separator",
                margin: "md"
            },
            {
                type: "box",
                layout: "vertical",
                margin: "md",
                spacing: "sm",
                contents: [
                    {
                        type: "box",
                        layout: "horizontal",
                        contents: [
                            {
                                type: "text",
                                text: "✅",
                                flex: 0
                            },
                            {
                                type: "text",
                                text: "毎日の安否確認メッセージ",
                                wrap: true,
                                flex: 5
                            }
                        ]
                    },
                    {
                        type: "box",
                        layout: "horizontal",
                        contents: [
                            {
                                type: "text",
                                text: "🚨",
                                flex: 0
                            },
                            {
                                type: "text",
                                text: "異常時の緊急連絡先への通知",
                                wrap: true,
                                flex: 5
                            }
                        ]
                    }
                ]
            },
            {
                type: "separator",
                margin: "md"
            },
            {
                type: "button",
                action: {
                    type: "postback",
                    label: "見守りサービスを登録する",
                    data: "action=watch_register"
                },
                style: "primary",
                color: "#FFC0CB",
                margin: "md"
            },
            {
                type: "button",
                action: {
                    type: "postback",
                    label: "見守りサービスを解除する",
                    data: "action=watch_unregister"
                },
                style: "secondary",
                color: "#FFFAF0",
                margin: "sm"
            }
        ]
    }
};


// ⭐重要: handleWatchServiceRegistration関数がイベントのreplyTokenを使うように変更
// ⭐この関数はWebhookハンドラー内で、res.status(200).send('OK'); の前に呼ばれるべき
async function handleWatchServiceRegistration(event, usersCollection, messagesCollection, userId, userMessage) {
    const user = await usersCollection.findOne({ userId: userId });
    const lowerUserMessage = userMessage.toLowerCase();
    let handled = false; // 処理されたかどうかを示すフラグ
    let logThisInteraction = false; // この見守りサービスインタラクションをログするかどうか

    // 「見守り」などのキーワードで案内Flex Messageを出す
    if (["見守り", "みまもり", "見守りサービス", "みまもりサービス"].includes(lowerUserMessage) && event.type === 'message' && event.message.type === 'text') {
        try {
            await client.replyMessage(event.replyToken, {
                type: 'flex',
                altText: '💖こころちゃんから見守りサービスのご案内💖', // 代替テキストを追加
                contents: watchServiceGuideFlexTemplate
            });
            logThisInteraction = true; // 案内表示はログする
            handled = true;
        } catch (error) {
            console.error("❌ 見守りサービス案内Flex送信エラー:", error.message);
            await logErrorToDb(userId, "見守りサービス案内Flex送信エラー", { error: error.message, userId: userId });
        }
    }
    // ⭐変更: 「元気かな？」ボタンからの応答を処理 (「無事です💖」からの応答もここ)
    else if (lowerUserMessage.includes("元気だよ！") || lowerUserMessage.includes("okだよ") || lowerUserMessage.includes("ok") || lowerUserMessage.includes("オーケー") || lowerUserMessage.includes("大丈夫") || lowerUserMessage.includes("げんき") || lowerUserMessage.includes("元気")) {
        if (user && user.wantsWatchCheck) {
            try {
                // 最終応答日時を更新し、リマインダーフラグをリセット
                await usersCollection.updateOne(
                    { userId: userId },
                    { $set: { lastOkResponse: new Date(), scheduledMessageSent: false, firstReminderSent: false, secondReminderSent: false, thirdReminderSent: false } }
                );
                await client.replyMessage(event.replyToken, {
                    type: 'text',
                    text: 'ありがとう🌸 元気そうで安心したよ💖 またね！'
                });
                logThisInteraction = true; // OK応答はログする
                handled = true;
            } catch (error) {
                console.error("❌ 見守りサービスOK応答処理エラー:", error.message);
                await logErrorToDb(userId, "見守りサービスOK応答処理エラー", { error: error.message, userId: userId });
            }
        }
    }
    else if (lowerUserMessage.includes("まあまあかな")) {
        if (user && user.wantsWatchCheck) {
            try {
                await client.replyMessage(event.replyToken, {
                    type: 'text',
                    text: 'そうだね、まあまあな日もあるよね🌸 焦らず、あなたのペースで過ごしてね💖'
                });
                logThisInteraction = true; // まあまあ応答はログする
                handled = true;
            } catch (error) {
                console.error("❌ 見守りサービス「まあまあ」応答処理エラー:", error.message);
                await logErrorToDb(userId, "見守りサービス「まあまあ」応答処理エラー", { error: error.message, userId: userId });
            }
        }
    }
    else if (lowerUserMessage.includes("少し疲れた…")) {
        if (user && user.wantsWatchCheck) {
            try {
                await client.replyMessage(event.replyToken, {
                    type: 'text',
                    text: '大変だったね、疲れてしまったんだね…💦 無理しないで休んでね。こころはいつでもあなたの味方だよ💖'
                });
                logThisInteraction = true; // 疲れた応答はログする
                handled = true;
            } catch (error) {
                console.error("❌ 見守りサービス「疲れた」応答処理エラー:", error.message);
                await logErrorToDb(userId, "見守りサービス「疲れた」応答処理エラー", { error: error.message, userId: userId });
            }
        }
    }
    else if (lowerUserMessage.includes("話を聞いて")) {
        if (user && user.wantsWatchCheck) {
            try {
                await client.replyMessage(event.replyToken, {
                    type: 'text',
                    text: 'うん、いつでも聞くよ🌸 何か話したいことがあったら、いつでも話してね💖'
                });
                logThisInteraction = true; // 話を聞いて応答はログする
                handled = true;
            } catch (error) {
                console.error("❌ 見守りサービス「話を聞いて」応答処理エラー:", error.message);
                await logErrorToDb(userId, "見守りサービス「話を聞いて」応答処理エラー", { error: error.message, userId: userId });
            }
        }
    }
    else if (userMessage.includes("見守り登録します") || (event.type === 'postback' && event.postback.data === 'action=watch_register')) {
        try {
            if (user && user.wantsWatchCheck) {
                await client.replyMessage(event.replyToken, {
                    type: 'text',
                    text: 'もう見守りサービスに登録済みだよ🌸 いつもありがとう💖'
                });
                handled = true;
                logThisInteraction = true; // 登録済みもログ
            } else if (user && user.registrationStep === 'awaiting_contact') {
                await client.replyMessage(event.replyToken, {
                    type: 'text',
                    text: 'まだ緊急連絡先を待ってるよ🌸 電話番号を送ってくれるかな？💖 (例: 09012345678)'
                });
                handled = true;
                logThisInteraction = true; // 連絡先待ちもログ
            } else {
                await usersCollection.updateOne(
                    { userId: userId },
                    { $set: { registrationStep: 'awaiting_contact' } }
                );
                await client.replyMessage(event.replyToken, {
                    type: 'text',
                    text: '見守りサービスを登録するね！緊急時に連絡する「電話番号」を教えてくれるかな？🌸 (例: 09012345678)'
                });
                logThisInteraction = true; // 登録開始もログ
                handled = true;
            }
        } catch (error) {
            console.error("❌ 見守りサービス登録開始処理エラー:", error.message);
            await logErrorToDb(userId, "見守りサービス登録開始処理エラー", { error: error.message, userId: userId });
        }
    }
    else if (user && user.registrationStep === 'awaiting_contact' && userMessage.match(/^0\d{9,10}$/)) {
        try {
            await usersCollection.updateOne(
                { userId: userId },
                { $set: { emergencyContact: userMessage, wantsWatchCheck: true, registrationStep: null, lastOkResponse: new Date() } }
            );
            await client.replyMessage(event.replyToken, {
                type: 'text',
                text: `緊急連絡先 ${userMessage} を登録したよ🌸 これで見守りサービスが始まったね！ありがとう💖`
            });
            logThisInteraction = true; // 登録完了はログ
            handled = true;
        } catch (error) {
            console.error("❌ 見守りサービス登録完了処理エラー:", error.message);
            await logErrorToDb(userId, "見守りサービス登録完了処理エラー", { error: error.message, userId: userId });
        }
    }
    else if (userMessage.includes("見守り解除します") || (event.type === 'postback' && event.postback.data === 'action=watch_unregister')) {
        try {
            if (user && user.wantsWatchCheck) {
                await usersCollection.updateOne(
                    { userId: userId },
                    { $set: { wantsWatchCheck: false, emergencyContact: null, registrationStep: null, scheduledMessageSent: false, firstReminderSent: false, secondReminderSent: false, thirdReminderSent: false } }
                );
                await client.replyMessage(event.replyToken, {
                    type: 'text',
                    text: '見守りサービスを解除したよ🌸 またいつでも登録できるからね💖'
                });
                logThisInteraction = true; // 解除はログ
                handled = true;
            } else {
                await client.replyMessage(event.replyToken, {
                    type: 'text',
                    text: '見守りサービスは登録されていないみたい🌸'
                });
                handled = true; // 登録されていない旨の応答もhandledとする
                logThisInteraction = true; // 登録されていない旨もログ
            }
        } catch (error) {
            console.error("❌ 見守りサービス解除処理エラー:", error.message);
            await logErrorToDb(userId, "見守りサービス解除処理エラー", { error: error.message, userId: userId });
        }
    }

    // 見守りサービス関連のメッセージが処理され、かつログ対象の場合のみログに記録
    if (handled && logThisInteraction) {
        const replyTextForLog = Array.isArray(event.replyMessageObject)
            ? event.replyMessageObject.map(obj => (obj && typeof obj === 'object' && obj.type === 'text') ? obj.text : JSON.stringify(obj)).join(' | ')
            : (typeof event.replyMessageObject === 'object' && event.replyMessageObject.type === 'text') ? event.replyMessageObject.text : JSON.stringify(event.replyMessageObject || {type:'unknown', content:'（Flex or Postback response）'});

        await messagesCollection.insertOne({
            userId: userId,
            message: userMessage,
            replyText: replyTextForLog, // 実際に返信した内容
            responsedBy: 'こころちゃん（見守り関連）',
            timestamp: new Date(),
            logType: 'watch_service_interaction'
        });
    }

    return handled;
}

// sendScheduledWatchMessageはpushMessageを使うため変更なし。
// ただし、QuickReplyのボタン表示のために、pushMessageでは表示されないことを理解して運用する
// もし定期メッセージでQuickReplyが必須なら、別途WebhooksからのreplyMessageトリガーを検討する必要がある
async function sendScheduledWatchMessage() {
    console.log('--- 定期見守りメッセージ送信処理を開始します ---');
    try {
        const db = await connectToMongoDB();
        if (!db) {
            console.error("MongoDBに接続できません。定期見守りメッセージの送信をスキップします。");
            return;
        }
        const usersCollection = db.collection("users");
        const messagesCollection = db.collection("messages");

        // 見守りサービスをONにしているユーザーを取得
        const watchUsers = await usersCollection.find({ wantsWatchCheck: true }).toArray();

        for (const user of watchUsers) {
            const userId = user.userId;
            const lastOkResponse = user.lastOkResponse;
            // const scheduledMessageSent = user.scheduledMessageSent || false; // このフラグはdaily cronごとにリセットされる想定
            const emergencyContact = user.emergencyContact;

            const now = new Date();
            const timeSinceLastOk = (now.getTime() - lastOkResponse.getTime()) / (1000 * 60 * 60); // 時間

            console.log(`ユーザー ${userId}: 最終OK応答から ${timeSinceLastOk.toFixed(2)} 時間経過`);

            // ⭐修正点: メッセージを送信する条件とメッセージ内容を変更 (テキストからFlex Messageへ)
            // 29時間以上返信がない場合 かつ、本日まだ定期メッセージが送られていない場合
            // scheduledMessageSent は毎日0時（cron定義による）にfalseにリセットされる想定
            if (timeSinceLastOk >= 29 && !user.scheduledMessageSent) { // 29時間に変更
                try {
                    await client.pushMessage(userId, watchConfirmationFlexTemplate); // ⭐変更点
                    await usersCollection.updateOne(
                        { userId: userId },
                        { $set: { scheduledMessageSent: true } } // 送信フラグを立てる
                    );
                    await messagesCollection.insertOne({
                        userId: userId,
                        message: `（定期見守りメッセージ - Flex送信）`, // ログ用メッセージ
                        replyText: '（見守り状況確認Flex送信）',
                        responsedBy: 'こころちゃん（定期見守り）',
                        timestamp: new Date(),
                        logType: 'watch_service_scheduled_message'
                    });
                    console.log(`✅ ユーザー ${userId} に定期見守りメッセージ（Flex）を送信しました。`);
                } catch (error) {
                    console.error(`❌ ユーザー ${userId} への定期見守りメッセージ（Flex）送信エラー:`, error.message);
                    await logErrorToDb(userId, "定期見守りメッセージ（Flex）送信エラー", { error: error.message, userId: userId });
                }
            } else if (timeSinceLastOk >= (29 + 24) && !user.firstReminderSent) { // 29時間 + 24時間 = 53時間後 (1日経過後のリマインダー)
                try {
                    await client.pushMessage(userId, { type: 'text', text: 'ねぇ、こころだよ🌸 返信がなくて少し心配してるよ。何かあったのかな？大丈夫？💖' });
                    await usersCollection.updateOne(
                        { userId: userId },
                        { $set: { firstReminderSent: true } }
                    );
                    await messagesCollection.insertOne({
                        userId: userId,
                        message: `（見守り1回目リマインダー）`,
                        replyText: 'ねぇ、こころだよ🌸 返信がなくて少し心配してるよ。何かあったのかな？大丈夫？💖',
                        responsedBy: 'こころちゃん（見守りリマインダー1）',
                        timestamp: new Date(),
                        logType: 'watch_service_reminder_1'
                    });
                    console.log(`✅ ユーザー ${userId} に見守り1回目リマインダーを送信しました。`);
                } catch (error) {
                    console.error(`❌ ユーザー ${userId} への見守り1回目リマインダー送信エラー:`, error.message);
                    await logErrorToDb(userId, "見守り1回目リマインダー送信エラー", { error: error.message, userId: userId });
                }
            } else if (timeSinceLastOk >= (29 + 24 * 2) && !user.secondReminderSent) { // 29時間 + 48時間 = 77時間後 (2日経過後のリマインダー)
                try {
                    await client.pushMessage(userId, { type: 'text', text: 'こころだよ🌸 まだ返信がないから、本当に心配だよ…。無理してないかな？💖' });
                    await usersCollection.updateOne(
                        { userId: userId },
                        { $set: { secondReminderSent: true } }
                    );
                    await messagesCollection.insertOne({
                        userId: userId,
                        message: `（見守り2回目リマインダー）`,
                        replyText: 'こころだよ🌸 まだ返信がないから、本当に心配だよ…。無理してないかな？💖',
                        responsedBy: 'こころちゃん（見守りリマインダー2）',
                        timestamp: new Date(),
                        logType: 'watch_service_reminder_2'
                    });
                    console.log(`✅ ユーザー ${userId} に見守り2回目リマインダーを送信しました。`);
                } catch (error) {
                    console.error(`❌ ユーザー ${userId} への見守り2回目リマインダー送信エラー:`, error.message);
                    await logErrorToDb(userId, "見守り2回目リマインダー送信エラー", { error: error.message, userId: userId });
                }
            } else if (timeSinceLastOk >= (29 + 24 * 3) && !user.thirdReminderSent) { // 29時間 + 72時間 = 101時間後 (3日経過後の最終リマインダーと通知)
                // 5日以上返信がない場合、最終リマインダーと事務局への通知
                if (emergencyContact && OFFICER_GROUP_ID) {
                    const userName = await getUserDisplayName(userId);
                    const officerMessage = `【⚠緊急通知⚠】\n見守り対象ユーザー（LINE表示名: ${userName} / LINE ID: ${userId}）から、最終応答から${(timeSinceLastOk / 24).toFixed(1)}日以上返信がありません。\n登録されている緊急連絡先: ${emergencyContact}\n至急、状況確認をお願いいたします。`;

                    try {
                        await client.pushMessage(OFFICER_GROUP_ID, { type: 'text', text: officerMessage });
                        await usersCollection.updateOne(
                            { userId: userId },
                            { $set: { thirdReminderSent: true } }
                        );
                        await messagesCollection.insertOne({
                            userId: userId,
                            message: `（見守り事務局通知）`,
                            replyText: `事務局へ緊急通知を送信しました: ${officerMessage}`,
                            responsedBy: 'システム（見守り事務局通知）',
                            timestamp: new Date(),
                            logType: 'watch_service_emergency_notification'
                        });
                        console.log(`✅ ユーザー ${userId} の状況を事務局に通知しました。`);
                    } catch (error) {
                        console.error(`❌ 事務局への緊急通知送信エラー（ユーザー ${userId}）:`, error.message);
                        await logErrorToDb(userId, "事務局緊急通知送信エラー", { error: error.message, userId: userId });
                    }
                } else {
                    console.warn(`ユーザー ${userId}: 緊急連絡先または事務局グループIDが未設定のため、${(timeSinceLastOk / 24).toFixed(1)}日経過しても通知できませんでした。`);
                    await logErrorToDb(userId, "緊急通知設定不足", { userId: userId, emergencyContact: emergencyContact, OFFICER_GROUP_ID: OFFICER_GROUP_ID });
                }
            }
        }
    } catch (error) {
        console.error("❌ 定期見守りメッセージ送信処理全体でエラー:", error.message);
        await logErrorToDb(null, "定期見守りメッセージ処理全体エラー", { error: error.message, stack: error.stack });
    }
    console.log('--- 定期見守りメッセージ送信処理を終了します ---');
}

// 毎日午前9時に実行
cron.schedule('0 9 * * *', () => {
    console.log('cron: 定期見守りメッセージ送信処理をトリガーします。');
    sendScheduledWatchMessage();
}, {
    timezone: "Asia/Tokyo"
});

// ⭐追加: 特定のコマンドでリッチメニューを送信する関数
async function sendRichMenu(replyToken) {
    const richMenu = {
        "type": "bubble",
        "body": {
            "type": "box",
            "layout": "vertical",
            "contents": [
                {
                    "type": "text",
                    "text": "メニュー",
                    "weight": "bold",
                    "color": "#FF69B4",
                    "size": "lg"
                },
                {
                    "type": "button",
                    "action": {
                        "type": "message",
                        "label": "見守りサービスについて",
                        "text": "見守り"
                    },
                    "style": "primary",
                    "height": "sm",
                    "margin": "md",
                    "color": "#FFC0CB"
                },
                {
                    "type": "button",
                    "action": {
                        "type": "message",
                        "label": "相談する",
                        "text": "相談したい"
                    },
                    "style": "primary",
                    "height": "sm",
                    "margin": "md",
                    "color": "#FFC0CB"
                },
                {
                    "type": "button",
                    "action": {
                        "type": "message",
                        "label": "こころちゃんとは？",
                        "text": "こころちゃんとは？"
                    },
                    "style": "primary",
                    "height": "sm",
                    "margin": "md",
                    "color": "#FFC0CB"
                }
            ]
        }
    };
    await client.replyMessage(replyToken, {
        type: 'flex',
        altText: 'こころちゃんのメニュー',
        contents: richMenu
    });
}

// ⭐変更: app.post('/webhook', ...) 全体を修正
app.post('/webhook', async (req, res) => {
    const events = req.body.events;
    if (!events || events.length === 0) {
        return res.status(200).send('OK');
    }

    const db = await connectToMongoDB();
    if (!db) {
        console.error("MongoDB接続不可。Webhook処理をスキップします。");
        return res.status(500).send('MongoDB connection error');
    }

    const usersCollection = db.collection("users");
    const messagesCollection = db.collection("messages");

    for (const event of events) {
        const userId = event.source.userId;
        let userMessage = '';
        let replyMessageObject = null;
        let responsedBy = 'こころちゃん';
        let logType = 'normal_conversation'; // デフォルトは通常会話（ログされない前提）
        let messageHandled = false;
        let watchServiceHandled = false;
        let shouldLogCurrentEvent = false; // 今回のイベントをログするかどうか

        // ユーザーがブロックしているか確認
        if (event.type === 'unfollow') {
            await usersCollection.updateOne(
                { userId: userId },
                { $set: { isBlocked: true } }
            );
            console.log(`ユーザー ${userId} がボットをブロックしました。`);
            shouldLogCurrentEvent = true; // ブロックはログ
            logType = 'system_unfollow';
            userMessage = '（ボットをブロックしました）'; // ログ用にメッセージ設定
            replyMessageObject = { type: 'text', text: '（ブロックされました）' };
            responsedBy = 'システム';
        } else if (event.type === 'follow') {
            await usersCollection.updateOne(
                { userId: userId },
                { $set: { isBlocked: false, createdAt: new Date() }, $setOnInsert: { isBlocked: false, createdAt: new Date() } },
                { upsert: true }
            );
            console.log(`ユーザー ${userId} がボットをフォローしました。`);
            const followMessage = 'はじめまして！わたしは皆守こころです🌸 あなたのお話、聞かせてね💖\n\n「見守りサービス」も提供しているから、興味があったら「見守り」って話しかけてみてね😊';
            await client.replyMessage(event.replyToken, { type: 'text', text: followMessage });
            shouldLogCurrentEvent = true; // フォローはログ
            logType = 'system_follow';
            userMessage = '（新規フォロー）';
            replyMessageObject = { type: 'text', text: followMessage };
            responsedBy = 'こころちゃん（新規フォロー）';
            // フォローイベントはここで処理が完結するため、次のイベントへ
            await messagesCollection.insertOne({
                userId: userId,
                message: userMessage,
                replyText: replyMessageObject.text,
                responsedBy: responsedBy,
                timestamp: new Date(),
                logType: logType
            });
            continue;
        }

        // ユーザー情報を取得または新規作成
        let user = await usersCollection.findOne({ userId: userId });
        if (!user) {
            const displayName = await getUserDisplayName(userId);
            user = {
                userId: userId,
                displayName: displayName,
                createdAt: new Date(),
                lastMessageAt: new Date(),
                messageCount: 0,
                isBlocked: false,
                wantsWatchCheck: false,
                registrationStep: null,
                emergencyContact: null,
                lastOkResponse: new Date(), // 新規ユーザーは登録時にOKとみなす
                scheduledMessageSent: false,
                firstReminderSent: false,
                secondReminderSent: false,
                thirdReminderSent: false,
            };
            await usersCollection.insertOne(user);
            console.log(`新規ユーザーを登録しました: ${displayName} (${userId})`);
        } else {
            await usersCollection.updateOne(
                { userId: userId },
                {
                    $set: { lastMessageAt: new Date(), isBlocked: false },
                    $inc: { messageCount: 1 }
                }
            );
        }

        // メッセージイベントの処理
        if (event.type === 'message' && event.message.type === 'text') {
            userMessage = event.message.text;
            const replyToken = event.replyToken;

            // 管理者コマンドのチェック
            const isAdminCommandInput = userMessage.startsWith('!');
            const isResetCommand = userMessage.startsWith('!reset');
            const isMenuCommand = userMessage.startsWith('!メニュー') || userMessage.toLowerCase() === 'メニュー';
            const isHistoryCommand = userMessage.toLowerCase() === '!history';

            // 管理者コマンドの場合
            if (isAdminCommandInput) {
                if (!isBotAdmin(userId)) {
                    replyMessageObject = { type: 'text', text: 'ごめんなさい、このコマンドは管理者専用です。' };
                    responsedBy = 'システム（拒否）';
                    logType = 'admin_command_denied';
                    messageHandled = true;
                    shouldLogCurrentEvent = true; // 管理者コマンド拒否はログ
                } else {
                    if (isResetCommand) {
                        try {
                            await messagesCollection.deleteMany({ userId: userId });
                            replyMessageObject = { type: 'text', text: 'あなたのチャット履歴をすべて削除しました。' };
                            responsedBy = 'システム（管理者）';
                            logType = 'admin_reset';
                            messageHandled = true;
                            shouldLogCurrentEvent = true; // 管理者コマンドはログ
                        } catch (error) {
                            console.error("❌ 履歴削除エラー:", error.message);
                            replyMessageObject = { type: 'text', text: '履歴削除中にエラーが発生しました。' };
                            responsedBy = 'システム（管理者エラー）';
                            logType = 'admin_error';
                            messageHandled = true;
                            shouldLogCurrentEvent = true; // 管理者コマンドエラーはログ
                        }
                    } else if (isMenuCommand) {
                        await sendRichMenu(replyToken); // メニュー送信関数を呼び出す
                        responsedBy = 'こころちゃん（メニュー）';
                        logType = 'system_menu';
                        messageHandled = true;
                        shouldLogCurrentEvent = true; // メニュー表示はログ
                    } else if (isHistoryCommand) {
                        try {
                            const userMessages = await messagesCollection.find({ userId: userId })
                                .sort({ timestamp: -1 })
                                .limit(10)
                                .toArray();

                            let historyText = "あなたの最新の会話履歴だよ🌸\n\n";
                            if (userMessages.length === 0) {
                                historyText = "まだ会話履歴がないみたい🌸";
                            } else {
                                userMessages.reverse().forEach(msg => {
                                    const sender = msg.responsedBy === 'ユーザー' ? 'あなた' : msg.responsedBy.replace('こころちゃん（', '').replace('）', ''); // ログタイプを簡略化
                                    historyText += `【${sender}】 ${msg.message || msg.replyText}\n`;
                                });
                            }

                            replyMessageObject = { type: 'text', text: historyText };
                            responsedBy = 'システム（管理者）';
                            logType = 'admin_history';
                            messageHandled = true;
                            shouldLogCurrentEvent = true; // 履歴表示はログ
                        } catch (error) {
                            console.error("❌ 履歴取得エラー:", error.message);
                            replyMessageObject = { type: 'text', text: '履歴取得中にエラーが発生しました。' };
                            responsedBy = 'システム（管理者エラー）';
                            logType = 'admin_error';
                            messageHandled = true;
                            shouldLogCurrentEvent = true; // 管理者コマンドエラーはログ
                        }
                    }
                    else {
                        replyMessageObject = { type: 'text', text: '不明な管理者コマンドです。' };
                        responsedBy = 'システム（拒否）';
                        logType = 'admin_command_unknown';
                        messageHandled = true;
                        shouldLogCurrentEvent = true; // 管理者コマンド拒否はログ
                    }
                }
            }

            // 見守りサービスのイベントハンドリングを最優先で処理
            // replyTokenをhandleWatchServiceRegistrationに渡す
            if (!messageHandled) {
                watchServiceHandled = await handleWatchServiceRegistration(event, usersCollection, messagesCollection, userId, userMessage);
                if (watchServiceHandled) {
                    messageHandled = true;
                    shouldLogCurrentEvent = true; // 見守りサービス関連はログ
                    // handleWatchServiceRegistration内でreplyMessageが呼ばれるため、ここでは何もしない
                    // handleWatchServiceRegistration内でメッセージログも処理される
                }
            }

            // 特殊返答のチェック（キーワード応答）
            if (!messageHandled) {
                const specialReply = checkSpecialReply(userMessage);
                if (specialReply) {
                    replyMessageObject = { type: 'text', text: specialReply };
                    responsedBy = 'こころちゃん（特殊返答）';
                    logType = 'special_reply';
                    messageHandled = true;
                    // 特殊返答は通常ログしない（負荷軽減のため）
                }
            }

            // 危険ワード、詐欺ワード、不適切ワードのチェック
            const isDangerWord = checkContainsDangerWords(userMessage);
            const isScam = checkContainsScamWords(userMessage);
            const isInappropriate = checkContainsInappropriateWords(userMessage);

            if (isDangerWord && !messageHandled) {
                replyMessageObject = {
                    type: 'flex',
                    altText: '緊急時',
                    contents: emergencyFlexTemplate // emergencyFlexTemplateは別途定義されているものとする
                };
                responsedBy = 'こころちゃん（緊急対応）';
                logType = 'danger_word_triggered';
                messageHandled = true;
                shouldLogCurrentEvent = true; // 危険ワードはログ
            } else if (isScam && !messageHandled) {
                replyMessageObject = {
                    type: 'flex',
                    altText: '詐欺注意',
                    contents: scamFlexTemplate // scamFlexTemplateは別途定義されているものとする
                };
                responsedBy = 'こころちゃん（詐欺対応）';
                logType = 'scam_word_triggered';
                messageHandled = true;
                shouldLogCurrentEvent = true; // 詐欺ワードはログ
            } else if (isInappropriate && !messageHandled) {
                replyMessageObject = {
                    type: 'text',
                    text: 'ごめんなさい、それはわたしにはお話しできない内容です🌸 他のお話をしましょうね💖'
                };
                responsedBy = 'こころちゃん（不適切対応）';
                logType = 'inappropriate_word_triggered';
                messageHandled = true;
                shouldLogCurrentEvent = true; // 不適切ワードはログ
            }

            // 宿題・勉強に関する質問のチェック
            if (containsHomeworkTrigger(userMessage) && !messageHandled) {
                const homeworkReply = await generateReply(
                    userMessage,
                    modelConfig.defaultModel // 通常モデルを使用
                );
                replyMessageObject = { type: 'text', text: homeworkReply };
                responsedBy = 'こころちゃん（宿題対応）';
                logType = 'homework_query';
                messageHandled = true;
                // 宿題に関する質問は通常ログしない（負荷軽減のため）
            }

            // ⭐変更: 相談モードの切り替えロジック
            if (!messageHandled && (userMessage === 'そうだん' || userMessage === '相談')) {
                try {
                    // Proモデルを次回の相談で使うフラグを立てる
                    await usersCollection.updateOne(
                        { userId: userId },
                        { $set: { useProForNextConsultation: true } }
                    );
                    replyMessageObject = { type: 'text', text: '🌸 相談モードに入ったよ！なんでも相談してね😊' };
                    responsedBy = 'こころちゃん（Gemini 1.5 Pro - 相談モード開始）';
                    logType = 'consultation_mode_start';
                    messageHandled = true;
                    shouldLogCurrentEvent = true; // 相談モード開始はログ
                    console.log(`ユーザー ${userId} が相談モードを開始しました。（次回Pro使用）`);
                } catch (error) {
                    console.error("❌ 「相談」モード開始エラー:", error.message);
                    await logErrorToDb(userId, "相談モード開始エラー", { error: error.message, userId: userId });
                    replyMessageObject = { type: 'text', text: `❌ 「相談」モード開始中にエラーが発生しました: ${error.message}` };
                    messageHandled = true;
                    shouldLogCurrentEvent = true; // エラーもログ
                }
            }


            // 通常のAI応答
            if (!messageHandled) {
                try {
                    let modelForGemini = modelConfig.defaultModel; // デフォルトはFlash
                    // ユーザーのuseProForNextConsultationフラグをチェック
                    if (user && user.useProForNextConsultation) {
                        modelForGemini = modelConfig.proModel; // Proに切り替え
                        console.log(`⭐ユーザー ${userId} の次回の相談にGemini 1.5 Proを使用します。`);
                        // 使用後、フラグをリセット
                        await usersCollection.updateOne({ userId: userId }, { $set: { useProForNextConsultation: false } });
                        console.log(`⭐ユーザー ${userId} のuseProForNextConsultationフラグをリセットしました。`);
                        shouldLogCurrentEvent = true; // Proモデルでの応答はログ（相談モードの一部とみなす）
                        logType = 'consultation_mode_response_pro';
                    } else {
                        // Flashモデルでの通常会話はログしない（負荷軽減のため）
                        shouldLogCurrentEvent = false;
                    }

                    const aiReply = await generateReply(userMessage, modelForGemini);
                    replyMessageObject = { type: 'text', text: aiReply };
                    responsedBy = `こころちゃん（AI: ${modelForGemini.includes('pro') ? 'Gemini 1.5 Pro' : 'Gemini 1.5 Flash'}）`;
                    messageHandled = true;
                } catch (error) {
                    console.error("❌ AI応答生成エラー:", error.message);
                    replyMessageObject = { type: 'text', text: 'ごめんなさい、今、少し考え込むのに時間がかかっちゃったみたい💦 もう一度、お話しいただけますか？🌸' };
                    responsedBy = 'こころちゃん（AIエラー）';
                    logType = 'ai_error';
                    messageHandled = true;
                    shouldLogCurrentEvent = true; // AIエラーはログ
                    await logErrorToDb(userId, "AI応答生成エラー", { error: error.message, userId: userId, userMessage: userMessage });
                }
            }


            // メッセージの送信とログ記録
            // 見守りサービスで既にreplyMessageが呼ばれている場合はスキップ
            // handleWatchServiceRegistration内でログも記録されているはず
            if (replyMessageObject && replyToken && !watchServiceHandled) {
                try {
                    await client.replyMessage(replyToken, replyMessageObject);

                    // ログに記録するテキストを決定
                    const replyTextForLog = Array.isArray(replyMessageObject)
                        ? replyMessageObject.map(obj => (obj && typeof obj === 'object' && obj.type === 'text') ? obj.text : JSON.stringify(obj)).join(' | ')
                        : (typeof replyMessageObject === 'object' && replyMessageObject.type === 'text') ? replyMessageObject.text : JSON.stringify(replyMessageObject);

                    // shouldLogCurrentEventに基づいてログを記録
                    if (shouldLogCurrentEvent) {
                        await messagesCollection.insertOne({
                            userId: userId,
                            message: userMessage,
                            replyText: replyTextForLog,
                            responsedBy: responsedBy,
                            timestamp: new Date(),
                            logType: logType
                        });
                    } else {
                        console.log(`ユーザー ${userId} からのメッセージはDBにログされませんでした: ${userMessage.substring(0, Math.min(userMessage.length, 50))}...`);
                    }

                } catch (error) {
                    console.error("❌ replyMessage送信中またはログ記録中にエラーが発生しました:", error.message);
                    await logErrorToDb(userId, "replyMessage送信またはログ記録エラー", { error: error.message, userId: userId, replyObject: replyMessageObject });
                    if (error.message.includes("status code 400") || error.message.includes("status code 499")) {
                        console.log(`LINE APIエラーのため、ユーザー ${userId} への応答ができませんでした。`);
                    }
                }
            } else if (!messageHandled && !watchServiceHandled) {
                // messageHandledもwatchServiceHandledもtrueになっていないが、replyMessageObjectがnullの場合
                // 例外的なケースなのでログしておく
                console.warn(`⚠️ ユーザー ${userId} への応答メッセージが生成されませんでした、またはreplyTokenがありません。ユーザーメッセージ: ${userMessage.substring(0, Math.min(userMessage.length, 50))}...`);
            }
        }
    }
    res.status(200).send('OK');
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, async () => {
    console.log(`🚀 サーバーがポート ${PORT} で起動しました...`);
});
