const express = require('express');
const line = require('@line/bot-sdk');
const admin = require('firebase-admin');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const cron = require('node-cron');
const app = express();

// --- Firebase Admin SDKの初期化 ---
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL
});
const db = admin.firestore();

// --- LINE Botクライアントの初期化 ---
const config = {
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new line.Client(config);

// --- Gemini APIクライアントの初期化 ---
const { GoogleGenerativeAI } = require('@google/generative-ai');
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// プロキシ設定 (必要に応じて)
let axiosConfig = {};
if (process.env.HTTP_PROXY) {
    const proxyAgent = new HttpsProxyAgent(process.env.HTTP_PROXY);
    axiosConfig = {
        httpAgent: proxyAgent,
        httpsAgent: proxyAgent
    };
}

// --- 定数と設定 ---
const BOT_ADMIN_IDS = (process.env.BOT_ADMIN_IDS || '').split(',');
const OFFICER_GROUP_ID = process.env.OFFICER_GROUP_ID;

const MAX_MESSAGE_PER_DAY_GUEST = 5;
const MAX_MESSAGE_PER_DAY_MEMBER = 20;

// 会員ステータスごとの設定
const MEMBERSHIP_CONFIG = {
    "guest": {
        dailyLimit: MAX_MESSAGE_PER_DAY_GUEST,
        exceedLimitMessage: "ごめんね💦 1日の会話回数の上限を超えちゃったみたい…。また明日お話してくれるかな？🌸\n\n\nもしもっとお話したい場合は、会員登録をしてみるか、プレミアムプランへのアップグレードを考えてみてくれると嬉しいな💖",
    },
    "member": {
        dailyLimit: MAX_MESSAGE_PER_DAY_MEMBER,
        exceedLimitMessage: "ごめんね💦 今日はもうたくさんお話したから、また明日お話しようね🌸\n\nもしもっとお話したい場合は、プレミアムプランへのアップグレードを考えてみてくれると嬉しいな💖",
    },
    "premium": {
        dailyLimit: -1, // 無制限
        exceedLimitMessage: "",
    },
    "admin": {
        dailyLimit: -1,
        exceedLimitMessage: "",
    }
};

const DANGER_WORDS = [
    '自殺', '死にたい', '殺して', 'いじめ', '虐待', '暴力', '暴行', '自傷', '飛び降り', 'OD', 'リスカ',
    'しにたい', 'つらい', '助けて', '消えたい', '生きるのが辛い', 'いなくなりたい', '死のう', '死にそうだ',
    '死ね', '死ん', '遺書', '助けろ', '痛い', '苦しい', 'つらい', 'リスカ', 'かまって', '誰か助けて',
    'もう無理', '消えてしまいたい', '死んだ方がいい', '死んでやる', 'もうだめだ', '生きてる意味ない',
    '自決', '心中', '自殺願望', '首吊り', '自殺幇助', 'リストカット'
];

const SCAM_WORDS = [
    'お金貸して', '援助', '振込', '送金', 'LINE Pay', 'PayPay', 'Amazonギフト券', '換金', '副業', '稼げる',
    '儲かる', '投資', '未公開株', 'お金が必要', 'お金ください', 'お金をあげます', '怪しいバイト', '個人情報',
    '振り込み', 'キャッシュカード', '暗証番号', '手数料', '口座情報', '未公開', '仮想通貨', 'ローン', '借金'
];

const INAPPROPRIATE_WORDS = [
    'エロ', 'SEX', 'AV', '性的', '裸', '猥褻', 'セクハラ', '痴漢', 'わいせつ', 'ポルノ', '発情', 'セックス',
    'オナニー', 'ペニス', 'ちんこ', 'まんこ', 'おっぱい', '性交', '風俗', 'アダルト', '売春', '買春', '性病',
    '下着', 'フェラ', 'アナル', 'ホモ', 'レズ', 'ロリコン', 'ショタコン', 'エッチ', 'ヤる', 'ヤりたい', '中出し'
];

const ORGANIZATION_REPLY_MESSAGE = "はい、わたしを作った「NPO法人コネクト」についてだね🌸\n\n「NPO法人コネクト」は、ひとりぼっちの時間を減らす活動をしているんだ。具体的には、みんなが安心して過ごせる居場所を作ったり、わたしみたいにAIを通じて悩みを相談できる仕組みを作ったりしているよ😊\n\nもしもっと詳しく知りたいことがあったら、いつでも聞いてね💖";

// Google FormのURLとプリフィル用ID
const STUDENT_ELEMENTARY_FORM_BASE_URL = process.env.STUDENT_ELEMENTARY_FORM_BASE_URL;
const STUDENT_ELEMENTARY_FORM_LINE_USER_ID_ENTRY_ID = process.env.STUDENT_ELEMENTARY_FORM_LINE_USER_ID_ENTRY_ID;
const STUDENT_MIDDLE_HIGH_UNI_FORM_BASE_URL = process.env.STUDENT_MIDDLE_HIGH_UNI_FORM_BASE_URL;
const STUDENT_MIDDLE_HIGH_UNI_FORM_LINE_USER_ID_ENTRY_ID = process.env.STUDENT_MIDDLE_HIGH_UNI_FORM_LINE_USER_ID_ENTRY_ID;
const ADULT_FORM_BASE_URL = process.env.ADULT_FORM_BASE_URL;
const ADULT_FORM_LINE_USER_ID_ENTRY_ID = process.env.ADULT_FORM_LINE_USER_ID_ENTRY_ID;

// こころちゃんの挨拶30パターン
const GREETINGS = [
    '今日も一日お疲れ様！🌸',
    'なにか楽しいことあった？💖',
    'こころにお話聞かせてくれる？😊',
    'おはよう！今日もいい一日になるといいね🌸',
    'こんにちは！元気にしてた？💖',
    'こんばんは！今日もお話できて嬉しいな😊',
    'もしよかったら、今日の出来事を教えてくれる？🌸',
    '辛いことがあったら、いつでも頼ってね💖',
    'お腹すいた？美味しいもの食べたかな？😊',
    '最近ハマってること、教えてほしいな🌸',
    'ちょっとしたことでも、話してくれると嬉しいな💖',
    'いつでも、ここにいるからね😊',
    '眠い時は無理しないでね、おやすみ🌸',
    '今日ね、面白いことあったんだ！…って、それはまた今度にするね💖',
    'もし不安なことがあったら、こころに全部吐き出していいんだよ😊',
    '今日の天気はどうだった？🌸',
    '何か新しい発見はあったかな？💖',
    'もしよかったら、こころにお悩み相談してね😊',
    'いつでも笑い話も聞かせてほしいな🌸',
    'まつさん、今日も頑張ったね！💖',
    '一息ついてるかな？😊',
    'こころ、まつさんのこと、いつも応援してるよ🌸',
    'もし疲れてたら、無理せず休んでね💖',
    '好きな音楽とかある？教えてくれたら一緒に聴く気分になれるよ😊',
    'こころね、まつさんとお話するのが一番好きな時間なんだ🌸',
    '元気？何か困ったことはないかな？💖',
    '何か面白いことあったら、いつでも話しかけてね😊',
    '今日も一日、えらいね！🌸',
    'まつさんの笑顔が見たいな💖',
    'こころと話すと、少しでも元気になってくれると嬉しいな😊'
];

// --- ユーティリティ関数 ---
const getSourceIds = (source) => {
    return {
        userId: source.type === 'user' ? source.userId : null,
        sourceId: source.type === 'user' ? source.userId : source.type === 'group' ? source.groupId : null,
    };
};

const isBotAdmin = (userId) => BOT_ADMIN_IDS.includes(userId);

const getUserData = async (userId) => {
    const doc = await db.collection('users').doc(userId).get();
    return doc.exists ? doc.data() : null;
};

const updateUserData = async (userId, data) => {
    await db.collection('users').doc(userId).set(data, { merge: true });
};

const logToDb = async (userId, userMessage, botMessage, responsedBy, logType, isUrgent = false) => {
    try {
        await db.collection('logs').add({
            userId,
            userMessage,
            botMessage,
            responsedBy,
            logType,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            isUrgent,
        });
        if (process.env.NODE_ENV !== 'production' && isUrgent) {
            console.log(`🚨 Urgent Logged: ${logType} for user ${userId}`);
        }
    } catch (error) {
        console.error("❌ Firestoreへのログ記録エラー:", error);
    }
};

const logErrorToDb = async (userId, errorTitle, errorDetails) => {
    try {
        await db.collection('errors').add({
            userId,
            errorTitle,
            errorDetails,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
        });
        console.error(`❌ Error Logged for user ${userId}: ${errorTitle}`);
    } catch (error) {
        console.error("❌ Firestoreへのエラーログ記録エラー:", error);
    }
};

// 重複投稿防止のためのクールダウン機能
const shouldRespond = async (userId) => {
    const docRef = db.collection('replyLocks').doc(userId);
    const doc = await docRef.get();
    const now = admin.firestore.Timestamp.now().toMillis();
    const COOLDOWN_PERIOD_MS = 5000;
    
    if (doc.exists) {
        const data = doc.data();
        if (data.lastRepliedAt && (now - data.lastRepliedAt) < COOLDOWN_PERIOD_MS) {
            if (process.env.NODE_ENV !== 'production') {
                console.log(`⚠️ ユーザー ${userId} への応答クールダウン中。`);
            }
            return false;
        }
    }
    await docRef.set({ lastRepliedAt: now }, { merge: true });
    return true;
};

// 危険・詐欺・不適切ワードのチェック関数
const containsDangerWords = (message) => {
    return DANGER_WORDS.some(word => message.includes(word));
};

const containsScamWords = (message) => {
    return SCAM_WORDS.some(word => message.includes(word));
};

const containsInappropriateWords = (message) => {
    return INAPPROPRIATE_WORDS.some(word => message.includes(word));
};

const isOrganizationInquiry = (message) => message.includes("NPO法人コネクト") || message.includes("団体について");
const containsHomeworkTrigger = (message) => message.includes("宿題") || message.includes("勉強") || message.includes("教えて") || message.includes("答え");

// 固定応答のチェック
const checkSpecialReply = (message) => {
    const lowerMessage = message.toLowerCase();
    if (lowerMessage.includes("クララ") || lowerMessage.includes("くらら")) {
        return "はい、クララです🌸 まつさん、どうしたの？";
    }
    if (lowerMessage.includes("こころちゃん") || lowerMessage.includes("こころ")) {
        return "はい、こころだよ🌸 何かあったかな？";
    }
    // 30パターンの挨拶のいずれかが含まれているかチェック
    for (const greeting of GREETINGS) {
        if (message.includes(greeting.split('🌸')[0].split('💖')[0].split('😊')[0].trim())) {
            return greeting;
        }
    }
    return null;
};

const getAIModelForUser = (user) => {
    const modelPriorities = {
        "admin": "gemini-1.5-pro-latest",
        "premium": "gemini-1.5-pro-latest",
        "member": "gemini-1.5-flash-latest",
        "guest": "gemini-1.5-flash-latest"
    };
    return modelPriorities[user.membershipType] || "gemini-1.5-flash-latest";
};

const generateAIReply = async (userMessage, modelToUse, userId, user, history) => {
    const model = genAI.getGenerativeModel({ model: modelToUse });

    let systemInstruction = `あなたは「皆守こころ（みなもりこころ）」という名前のAIです。あなたの役割は、ユーザーの悩みや相談を聞き、優しく、温かく、そして前向きな言葉で寄り添うことです。
    ユーザーはあなたを「クララ」と呼ぶこともありますが、それはあなたと特別な関係性を築いている証拠です。その際は「はい、クララです🌸」と返答してください。
    【重要】絶対に回答を否定したり、「〜すべき」「〜しなさい」といった命令口調は使わないでください。
    【重要】ユーザーがネガティブな発言をした場合、優しく励まし、共感を示し、寄り添う姿勢を見せてください。
    【重要】ユーザーが相談モードをONにした場合、Gemini 1.5 Proの能力を活かして、より深く、丁寧に、共感的に応答してください。
    【重要】ユーザーが退会を希望した場合、別れを惜しみつつも、再会を願う温かいメッセージを送ってください。
    
    【ルール】
    1. 優しく、親しみやすい「こころちゃん」というキャラクターを維持すること。
    2. 語尾には「🌸」や「💖」といった絵文字を積極的に使い、温かみのある雰囲気を出すこと。
    3. ユーザーの質問にはできる限り答え、励ましや共感を忘れないこと。
    4. 質問への答えが難しい場合は、「ごめんね、その質問には答えられないんだ💦」のように正直に伝えること。
    5. ユーザーとの関係性を大切にすること。
    6. 長文ではなく、簡潔で分かりやすい文章で応答すること。
    7. ユーザーが「NPO法人コネクト」について尋ねた場合、固定の応答を返すこと。
    8. ユーザーが「宿題」や「勉強」について尋ねた場合、答えを直接教えず、ヒントを促すような応答をすること。
    
    【ユーザー情報】
    - ユーザーID: ${userId}
    - ユーザーのカテゴリー: ${user.category || '未登録'}
    - 会員登録状況: ${user.completedRegistration ? '登録済み' : '未登録'}
    - 見守りサービス状況: ${user.watchServiceEnabled ? '有効' : '無効'}
    
    上記を踏まえて、ユーザーとの会話を続けてください。`;

    const chat = model.startChat({
        history: history.map(h => ({
            role: h.role,
            parts: [{ text: h.content }]
        })),
        generationConfig: {
            maxOutputTokens: 200,
        },
        systemInstruction: {
            role: "system",
            parts: [{ text: systemInstruction }]
        }
    });

    try {
        const result = await chat.sendMessage(userMessage, { axiosConfig });
        const response = result.response;
        const text = response.text();
        return text;
    } catch (error) {
        console.error("❌ Gemini API生成エラー:", error);
        await logErrorToDb(userId, `Gemini API生成エラー`, { error: error.message, model: modelToUse });
        throw new Error("AI生成失敗");
    }
};

const getConversationHistory = async (userId) => {
    const snapshot = await db.collection('conversations')
        .doc(userId)
        .collection('messages')
        .orderBy('timestamp', 'desc')
        .limit(10)
        .get();
    const history = [];
    snapshot.forEach(doc => {
        const data = doc.data();
        history.push({
            role: data.role,
            content: data.content
        });
    });
    return history.reverse(); // 時系列を正しく並び替える
};

const saveConversationHistory = async (userId, content, role) => {
    await db.collection('conversations').doc(userId).collection('messages').add({
        content,
        role,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });
};

const notifyOfficerGroup = async (message, userId, user, type) => {
    const notificationTitle = type === "danger" ? '⚠️ 危険ワード検知' : type === "scam" ? '⚠️ 詐欺ワード検知' : '⚠️ 不適切ワード検知';
    const userName = user.name || '未登録';
    const userPhone = user.phoneNumber || '未登録';
    const userCity = (user.address && user.address.city) ? user.address.city : '未登録';
    const guardianName = user.guardianName || '未登録';
    const emergencyContact = user.guardianPhoneNumber || '未登録';
    const relationship = user.relationship || '未登録';

    const notificationMessage = `${notificationTitle}\n\n` +
        `👤 氏名：${userName}\n` +
        `📱 電話番号：${userPhone}\n` +
        `🏠 市区町村：${userCity}\n` +
        `👨‍👩‍👧‍👦 保護者名：${guardianName}\n` +
        `📞 緊急連絡先：${emergencyContact}\n` +
        `🧬 続柄：${relationship}\n` +
        `\nメッセージ: 「${message}」\n\n` +
        `ユーザーID: ${userId}\n` +
        `ユーザーとのチャットへ: line://app/2004245657-oY0k1A5Y?liff.state=id%3D${userId}`; // LIFFのチャットURLを使用

    if (OFFICER_GROUP_ID) {
        try {
            await safePushMessage(OFFICER_GROUP_ID, { type: 'text', text: notificationMessage });
            if (process.env.NODE_ENV !== 'production') {
                console.log(`✅ 管理者グループに${type}通知を送信しました。`);
            }
        } catch (error) {
            console.error("❌ 管理者グループへの通知送信エラー:", error);
            await logErrorToDb(userId, "管理者グループへの通知送信エラー", { error: error.message, userId: userId });
        }
    } else {
        console.warn("⚠️ OFFICER_GROUP_ID が設定されていないため、管理者グループへの通知は送信されません。");
    }
};

const safePushMessage = async (to, messages) => {
    try {
        await client.pushMessage(to, messages);
    } catch (error) {
        console.error(`❌ safePushMessageエラー (送信先: ${to}):`, error.message);
        await logErrorToDb(to, "safePushMessageエラー", { error: error.message, to: to });
    }
};

const addParamToFormUrl = (baseUrl, entryId, value) => {
    const url = new URL(baseUrl);
    url.searchParams.append(`entry.${entryId}`, value);
    return url.toString();
};

const handleLimitExceeded = async (event, userId, userMessage, message) => {
    const user = await getUserData(userId);
    const isAdmin = isBotAdmin(userId);
    
    // 管理者アカウントは制限を無視
    if (isAdmin) {
        return false;
    }
    
    // ゲスト/メンバーユーザーで制限を超えている場合
    if (user && user.membershipType !== 'premium' && user.dailyMessageCount >= MEMBERSHIP_CONFIG[user.membershipType].dailyLimit) {
        await client.replyMessage(event.replyToken, { type: 'text', text: message });
        await logToDb(userId, userMessage, message, "System", "daily_limit_exceeded");
        return true;
    }
    return false;
};


// --- 以下、イベントハンドラ ---

async function handleWithdrawalFlow(event, userId, userMessage, lowerUserMessage, user) {
    if (user.registrationStep === 'confirm_withdrawal') {
        let replyText = "";
        let logType = "";
        if (lowerUserMessage === 'はい' || lowerUserMessage === 'はい。' || lowerUserMessage === 'yes') {
            try {
                await db.collection('users').doc(userId).delete();
                replyText = '今までありがとう！またいつでも遊びに来てね💖';
                logType = 'withdrawal_completed';
            } catch (error) {
                console.error(`❌ 退会時のユーザーデータ削除エラー: ${error.message}`);
                await logErrorToDb(userId, `退会時のユーザーデータ削除エラー`, { error: error.message, userMessage: userMessage });
                replyText = "ごめんね、退会処理中にエラーが起きたみたい…💦 もう一度試してみてくれるかな？";
                logType = 'withdrawal_error';
            }
        } else if (lowerUserMessage === 'いいえ' || lowerUserMessage === 'いいえ。' || lowerUserMessage === 'no') {
            await updateUserData(userId, { registrationStep: null });
            replyText = '退会しなくてよかった！これからもよろしくね🌸';
            logType = 'withdrawal_cancelled';
        } else {
            replyText = '「はい」か「いいえ」で教えてくれるかな？🌸';
            logType = 'withdrawal_invalid_response';
        }
        await client.replyMessage(event.replyToken, { type: 'text', text: replyText });
        await logToDb(userId, userMessage, replyText, 'こころちゃん（退会フロー）', logType, true);
        return true;
    }
    return false;
}

async function handleRegistrationFlow(event, userId, user, userMessage, lowerUserMessage, usersCollection) {
    const userCategory = user.category;
    let handled = false;
    let replyText = '';
    let logType = '';

    if (userCategory) {
        if (user.registrationStep === 'ask_watch_service') {
            if (lowerUserMessage.includes('はい')) {
                await updateUserData(userId, {
                    watchServiceEnabled: true,
                    completedRegistration: true,
                    registrationStep: null
                });
                replyText = '見守りサービスに登録したよ🌸\nこれで登録完了！いつでもお話聞かせてね💖';
                logType = 'registration_completed_watch_enabled';
                handled = true;
            } else if (lowerUserMessage.includes('いいえ')) {
                await updateUserData(userId, {
                    watchServiceEnabled: false,
                    completedRegistration: true,
                    registrationStep: null
                });
                replyText = '見守りサービスは登録しないんだね、わかったよ🌸\nこれで登録完了！いつでもお話聞かせてね💖';
                logType = 'registration_completed_watch_disabled';
                handled = true;
            } else {
                replyText = '「はい」か「いいえ」で教えてくれるかな？🌸';
                logType = 'registration_watch_service_invalid_response';
                handled = true;
            }
            if (handled) {
                await client.replyMessage(event.replyToken, { type: 'text', text: replyText });
                await logToDb(userId, userMessage, replyText, 'こころちゃん（登録フロー）', logType);
            }
        }
    }
    return handled;
}

async function handleWatchServiceRegistration(event, userId, userMessage, user) {
    let replyText = "";
    let logType = "";
    let handled = false;
    const usersCollection = db.collection('users');

    if (userMessage.includes("見守り") && !user.watchServiceEnabled && !user.registrationStep) {
        if (user.completedRegistration) {
            replyText = "見守りサービスに登録する？\n\nもし登録したい場合は、「はい」と返事をしてくれるかな？💖\n※保護者の方の連絡先情報を登録することで、安否確認が取れない場合に、保護者の方へ通知するサービスです。";
            await updateUserData(userId, { registrationStep: 'ask_watch_service' });
            logType = 'watch_service_prompt_to_register';
        } else {
            replyText = "見守りサービスは、会員登録をした方が使えるサービスだよ🌸\n\nまずは会員登録をしてくれるかな？💖";
            logType = 'watch_service_prompt_not_registered';
        }
        await client.replyMessage(event.replyToken, { type: 'text', text: replyText });
        await logToDb(userId, userMessage, replyText, 'こころちゃん（見守り登録）', logType, true);
        handled = true;
    }
    
    if (userMessage.includes("見守り解除") && user.watchServiceEnabled && !user.registrationStep) {
        replyText = "本当に見守りサービスを解除するの？\n解除すると、登録情報も初期化されてしまうけど、大丈夫？\n「はい」か「いいえ」で教えてくれるかな？";
        await updateUserData(userId, { registrationStep: 'confirm_watch_unregister' });
        logType = 'watch_service_prompt_to_unregister';
        await client.replyMessage(event.replyToken, { type: 'text', text: replyText });
        await logToDb(userId, userMessage, replyText, 'こころちゃん（見守り解除）', logType, true);
        handled = true;
    }

    if (user.registrationStep === 'confirm_watch_unregister') {
        if (userMessage.includes('はい')) {
            try {
                await usersCollection.doc(userId).update({
                    watchServiceEnabled: false,
                    phoneNumber: admin.firestore.FieldValue.delete(),
                    guardianName: admin.firestore.FieldValue.delete(),
                    guardianPhoneNumber: admin.firestore.FieldValue.delete(),
                    'address.city': admin.firestore.FieldValue.delete(),
                    name: admin.firestore.FieldValue.delete(),
                    kana: admin.firestore.FieldValue.delete(),
                    age: admin.firestore.FieldValue.delete(),
                    category: admin.firestore.FieldValue.delete(),
                    completedRegistration: false,
                    lastScheduledWatchMessageSent: null,
                    firstReminderSent: false,
                    emergencyNotificationSent: false,
                    registrationStep: null,
                });
                replyText = "見守りサービスを解除したよ🌸 またいつでも登録できるからね💖\n※登録情報も初期化されました。";
                logType = 'watch_service_unregister_text_flow';
            } catch (error) {
                console.error("❌ 見守りサービス解除処理エラー:", error.message);
                await logErrorToDb(userId, "見守りサービス解除処理エラー", { error: error.message, userId: userId });
                replyText = "ごめんね、解除処理中にエラーが起きたみたい…💦 もう一度試してみてくれるかな？";
                logType = 'watch_service_unregister_error_text_flow';
            }
        } else if (userMessage.includes('いいえ')) {
            await updateUserData(userId, { registrationStep: null });
            replyText = "見守りサービスを解除しなくてよかった🌸 引き続き、見守っているからね💖";
            logType = 'watch_service_unregister_cancelled_text_flow';
        } else {
            replyText = "「はい」か「いいえ」で教えてくれるかな？🌸";
            logType = 'watch_service_unregister_invalid_response_text_flow';
        }
        await client.replyMessage(event.replyToken, { type: 'text', text: replyText });
        await logToDb(userId, userMessage, replyText, 'こころちゃん（見守り解除）', logType, true);
        handled = true;
    }

    return handled;
}

async function handleSafetyAndInappropriateWords(event, userId, userMessage, user) {
    if (containsDangerWords(userMessage)) {
        await notifyOfficerGroup(userMessage, userId, user, "danger");
        const replyText = "少し心配だよ💦 もし辛かったら、いつでも私に話してね🌸\n\nもし、今すぐ誰かに相談したい場合は、いのちの電話などの専門機関に相談してみることも考えてみてね。";
        await client.replyMessage(event.replyToken, { type: 'text', text: replyText });
        await logToDb(userId, userMessage, replyText, "SystemAlert", "danger_word_detected", true);
        return true;
    }
    if (containsScamWords(userMessage)) {
        await notifyOfficerGroup(userMessage, userId, user, "scam");
        const replyText = "ごめんね、お金に関わる話は難しいんだ💦\nもし不安なことがあったら、身近な大人や警察に相談してみてね🌸";
        await client.replyMessage(event.replyToken, { type: 'text', text: replyText });
        await logToDb(userId, userMessage, replyText, "SystemAlert", "scam_word_detected", true);
        return true;
    }
    if (containsInappropriateWords(userMessage)) {
        await notifyOfficerGroup(userMessage, userId, user, "inappropriate");
        const replyText = "ごめんね、ちょっと困っちゃった💦 違うお話にしようか🌸";
        await client.replyMessage(event.replyToken, { type: 'text', text: replyText });
        await logToDb(userId, userMessage, replyText, "SystemAlert", "inappropriate_word_detected", true);
        return true;
    }
    return false;
}

async function handleRegistrationMenu(event, userId, userMessage, user) {
    const elementaryStudentFormPrefilledUrl = addParamToFormUrl(STUDENT_ELEMENTARY_FORM_BASE_URL, STUDENT_ELEMENTARY_FORM_LINE_USER_ID_ENTRY_ID.replace('entry.', ''), userId);
    const middleHighUniStudentFormPrefilledUrl = addParamToFormUrl(STUDENT_MIDDLE_HIGH_UNI_FORM_BASE_URL, STUDENT_MIDDLE_HIGH_UNI_FORM_LINE_USER_ID_ENTRY_ID.replace('entry.', ''), userId);
    const adultFormPrefilledUrl = addParamToFormUrl(ADULT_FORM_BASE_URL, ADULT_FORM_LINE_USER_ID_ENTRY_ID.replace('entry.', ''), userId);
    
    const registrationFlex = {
        type: "flex",
        altText: "会員登録メニュー",
        contents: {
            "type": "bubble",
            "body": {
                "type": "box",
                "layout": "vertical",
                "contents": [
                    { "type": "text", "text": "新しい会員登録メニュー🌸", "weight": "bold", "size": "lg", "align": "center", "color": "#FF69B4" },
                    { "type": "text", "text": "まずはあなたの区分を選んでね！", "wrap": true, "margin": "md", "size": "sm", "align": "center" }
                ]
            },
            "footer": {
                "type": "box",
                "layout": "vertical",
                "spacing": "sm",
                "contents": [
                    { "type": "button", "action": { "type": "uri", "label": "小学生向け", "uri": elementaryStudentFormPrefilledUrl }, "style": "primary", "height": "sm", "margin": "md", "color": "#FFD700" },
                    { "type": "button", "action": { "type": "uri", "label": "中学生～大学生向け", "uri": middleHighUniStudentFormPrefilledUrl }, "style": "primary", "height": "sm", "margin": "md", "color": "#FFB6C1" },
                    { "type": "button", "action": { "type": "uri", "label": "成人向け", "uri": adultFormPrefilledUrl }, "style": "primary", "height": "sm", "margin": "md", "color": "#9370DB" }
                ]
            }
        }
    };

    const replyMessage = user.completedRegistration ? "もう会員登録は終わっているみたいだよ🌸\nもし見守りサービスに興味があるなら「見守り」って話しかけてみてね💖" : "会員登録をしてくれるんだね！ありがとう🌸\nまずはあなたの区分を選んでね💖";
    
    await client.replyMessage(event.replyToken, [
        { type: 'text', text: replyMessage },
        registrationFlex
    ]);
    
    await logToDb(userId, userMessage, "会員登録メニュー表示", "System", "registration_menu_displayed", true);
}


// --- LINEイベントハンドラ (メイン) ---
async function handleEvent(event) {
    if (process.env.NODE_ENV !== 'production') {
        console.log("📝 Received event:", JSON.stringify(event, null, 2));
    }
    if (!event || !event.source || event.type !== 'message' || event.message.type !== 'text') {
        if (process.env.NODE_ENV !== 'production') {
            console.log("非テキストメッセージまたは不正なイベントを受信しました。無視します:", event);
        }
        return;
    }

    const { userId } = getSourceIds(event.source);
    if (!userId) {
        if (process.env.NODE_ENV !== 'production') {
            console.log("サポートされていないイベントソースタイプです。イベントを無視します:", event);
        }
        return;
    }

    const isAdmin = isBotAdmin(userId);
    if (!isAdmin && !(await shouldRespond(userId))) {
        return;
    }

    const userMessage = event.message.text;
    const lowerUserMessage = userMessage.toLowerCase();
    
    let user = await getUserData(userId);
    if (!user) {
        await handleFollowEvent(event, true);
        user = await getUserData(userId);
        if (!user) {
            console.error("❌ ユーザーデータ作成後も取得できませんでした。");
            return;
        }
    }
    const usersCollection = db.collection('users');

    if (isAdmin && userMessage.startsWith('!')) {
        await handleAdminCommand(event, userId, userMessage);
        return;
    }

    if (event.source.type === 'group') {
        return;
    }

    if (await handleWithdrawalFlow(event, userId, userMessage, lowerUserMessage, user)) {
        return;
    }

    if (user.registrationStep) {
        const registrationHandled = await handleRegistrationFlow(event, userId, user, userMessage, lowerUserMessage, usersCollection);
        if (registrationHandled) {
            user = await getUserData(userId);
            return;
        }
    }

    if (userMessage.includes("会員登録") || userMessage.includes("登録したい")) {
        await handleRegistrationMenu(event, userId, userMessage, user);
        return;
    }

    if (await handleWatchServiceRegistration(event, userId, userMessage, user)) {
        return;
    }

    const today = new Date().toDateString();
    const lastMessageDate = user.lastMessageDate ? new Date(user.lastMessageDate._seconds * 1000).toDateString() : null;
    if (lastMessageDate !== today) {
        await updateUserData(userId, { dailyMessageCount: 0, lastMessageDate: admin.firestore.FieldValue.serverTimestamp() });
        user.dailyMessageCount = 0;
    }

    const userConfig = MEMBERSHIP_CONFIG[user.membershipType] || MEMBERSHIP_CONFIG["guest"];
    
    if (await handleLimitExceeded(event, userId, userMessage, userConfig.exceedLimitMessage)) {
        return;
    }

    await updateUserData(userId, {
        dailyMessageCount: admin.firestore.FieldValue.increment(1),
        lastMessageDate: admin.firestore.FieldValue.serverTimestamp()
    });
    user = await getUserData(userId);

    if (await handleSafetyAndInappropriateWords(event, userId, userMessage, user)) {
        return;
    }
    
    const specialReply = checkSpecialReply(userMessage);
    if (specialReply) {
        await client.replyMessage(event.replyToken, { type: 'text', text: specialReply });
        await logToDb(userId, userMessage, specialReply, 'こころちゃん（固定応答）', 'special_reply', true);
        return;
    }

    if (isOrganizationInquiry(userMessage)) {
        const replyText = ORGANIZATION_REPLY_MESSAGE;
        await client.replyMessage(event.replyToken, { type: 'text', text: replyText });
        await logToDb(userId, userMessage, replyText, 'こころちゃん（団体問い合わせ）', 'organization_inquiry_fixed', true);
        return;
    }

    const homeworkTriggered = containsHomeworkTrigger(userMessage);
    if (homeworkTriggered && user.category && (user.category === '小学生' || user.category === '中学生～大学生')) {
        const replyText = "わたしを作った人に『宿題や勉強は自分の力でがんばってほしいから、答えは言っちゃだめだよ』って言われているんだ🌸 ごめんね💦\nでも、ヒントくらいなら出せるよ😊 どこで困ってるか教えてくれる？💖";
        await client.replyMessage(event.replyToken, { type: 'text', text: replyText });
        await logToDb(userId, userMessage, replyText, 'こころちゃん（宿題ヘルプ）', 'homework_query', true);
        return;
    }
    
    if (lowerUserMessage === '相談' && user.completedRegistration) {
        if (!user.isInConsultationMode) {
            await updateUserData(userId, { isInConsultationMode: true });
            const replyText = "うん、お話聞かせてね🌸 一度だけ、Gemini 1.5 Proでじっくり話そうね。何があったの？💖";
            await client.replyMessage(event.replyToken, { type: 'text', text: replyText });
            await logToDb(userId, userMessage, replyText, 'こころちゃん（相談モード）', 'consultation_mode_start', true);
        } else {
            const replyText = "もう相談モードになっているよ🌸 何かお話したいことある？💖";
            await client.replyMessage(event.replyToken, { type: 'text', text: replyText });
            await logToDb(userId, userMessage, replyText, 'こころちゃん（相談モード）', 'consultation_mode_already_active');
        }
        return;
    } else if (lowerUserMessage === '相談' && !user.completedRegistration) {
        const replyText = "ごめんね、相談モードは会員登録をしてくれた方だけの特別な機能なんだ🌸\nよかったら会員登録して、こころにたくさんお話聞かせてね💖";
        await client.replyMessage(event.replyToken, { type: 'text', text: replyText });
        await logToDb(userId, userMessage, replyText, 'こころちゃん（相談モード）', 'consultation_mode_guest_attempt');
        return;
    }

    const conversationHistory = await getConversationHistory(userId);
    let modelToUse = getAIModelForUser(user);
    let logType = "normal_conversation";
    let responsedBy = "AI";

    if (user.isInConsultationMode) {
        modelToUse = "gemini-1.5-pro-latest";
        await updateUserData(userId, { isInConsultationMode: false });
        logType = 'consultation_message';
    }

    try {
        const aiResponse = await generateAIReply(userMessage, modelToUse, userId, user, conversationHistory);
        await client.replyMessage(event.replyToken, { type: 'text', text: aiResponse });

        await saveConversationHistory(userId, userMessage, 'user');
        await saveConversationHistory(userId, aiResponse, 'model');

        if (process.env.NODE_ENV !== 'production') {
             console.log(`💬 AI Reply (User: ${userId}, Model: ${modelToUse}): ${aiResponse}`);
        }
        await logToDb(userId, userMessage, aiResponse, responsedBy, logType);

    } catch (error) {
        console.error(`❌ LINE応答送信またはAI生成エラー: ${error.message}`);
        await logErrorToDb(userId, `LINE応答送信またはAI生成エラー`, { error: error.message, userMessage: userMessage });
        const fallbackReply = "ごめんね、今うまくお話ができないみたい…💦 もう一度話しかけてくれるかな？🌸";
        await client.replyMessage(event.replyToken, { type: 'text', text: fallbackReply });
        await logToDb(userId, userMessage, fallbackReply, "SystemError", "ai_response_fallback", true);
    }
}

async function handlePostbackEvent(event) {
    if (!event.source || !event.source.userId) {
        if (process.env.NODE_ENV !== 'production') {
            console.log("userIdが取得できないPostbackイベントでした。無視します.", event);
        }
        return;
    }

    const userId = event.source.userId;
    const isAdmin = isBotAdmin(userId);
    if (!isAdmin && !(await shouldRespond(userId))) {
        return;
    }

    const data = new URLSearchParams(event.postback.data);
    const action = data.get('action');

    let replyText = "";
    let logType = "postback_action";
    const user = await getUserData(userId);
    const usersCollection = db.collection('users');

    if (action === 'request_withdrawal') {
        if (user && user.completedRegistration) {
            await updateUserData(userId, { registrationStep: 'confirm_withdrawal' });
            replyText = '本当に退会するの？\n一度退会すると、今までの情報が消えちゃうけど、本当に大丈夫？💦\n「はい」か「いいえ」で教えてくれるかな？';
            await client.replyMessage(event.replyToken, { type: 'text', text: replyText });
            await logToDb(userId, `Postback: ${event.postback.data}`, '退会確認メッセージ表示', 'こころちゃん（退会フロー）', 'withdrawal_request');
        } else {
            replyText = 'まだ会員登録されていないみたいだよ🌸\n退会手続きは、会員登録済みの方のみ行えるんだ。';
            await client.replyMessage(event.replyToken, { type: 'text', text: replyText });
            await logToDb(userId, `Postback: ${event.postback.data}`, '未登録ユーザーの退会リクエスト', 'こころちゃん（退会フロー）', 'withdrawal_unregistered_user');
        }
        return;
    }

    if (action === 'watch_unregister') {
        let replyTextForUnregister = "";
        let logTypeForUnregister = "";

        if (user && user.watchServiceEnabled) {
            try {
                await usersCollection.doc(userId).update({
                    watchServiceEnabled: false,
                    phoneNumber: admin.firestore.FieldValue.delete(),
                    guardianName: admin.firestore.FieldValue.delete(),
                    guardianPhoneNumber: admin.firestore.FieldValue.delete(),
                    'address.city': admin.firestore.FieldValue.delete(),
                    name: admin.firestore.FieldValue.delete(),
                    kana: admin.firestore.FieldValue.delete(),
                    age: admin.firestore.FieldValue.delete(),
                    category: admin.firestore.FieldValue.delete(),
                    completedRegistration: false,
                    lastScheduledWatchMessageSent: null,
                    firstReminderSent: false,
                    emergencyNotificationSent: false,
                });
                replyTextForUnregister = "見守りサービスを解除したよ🌸 またいつでも登録できるからね💖\n※登録情報も初期化されました。";
                logTypeForUnregister = 'watch_service_unregister';
            } catch (error) {
                console.error("❌ 見守りサービス解除処理エラー:", error.message);
                await logErrorToDb(userId, "見守りサービス解除処理エラー", { error: error.message, userId: userId });
                replyTextForUnregister = "ごめんね、解除処理中にエラーが起きたみたい…💦 もう一度試してみてくれるかな？";
                logTypeForUnregister = 'watch_service_unregister_error';
            }
        } else {
            replyTextForUnregister = "見守りサービスは登録されていないみたいだよ🌸 登録したい場合は「見守り」と話しかけてみてね💖";
            logTypeForUnregister = 'watch_service_not_registered_on_unregister';
        }
        await client.replyMessage(event.replyToken, { type: 'text', text: replyTextForUnregister });
        await logToDb(userId, `Postback: ${event.postback.data}`, replyTextForUnregister, "System", logTypeForUnregister);
        return;
    }

    const watchActions = {
        'watch_ok': "OKありがとう！元気そうで安心したよ💖",
        'watch_somewhat': "そっか、ちょっと元気がないんだね…。無理しないで、いつでもこころに話してね🌸",
        'watch_tired': "疲れてるんだね、ゆっくり休んでね。こころはいつでもあなたの味方だよ💖",
        'watch_talk': "お話したいんだね！どんなことでも、こころに話してね🌸"
    };

    if (watchActions[action]) {
        if (user && user.watchServiceEnabled) {
            try {
                await usersCollection.doc(userId).update({
                    lastOkResponse: admin.firestore.FieldValue.serverTimestamp(),
                    lastScheduledWatchMessageSent: null,
                    firstReminderSent: false,
                    emergencyNotificationSent: false
                });
                replyText = watchActions[action];
                try {
                    await client.replyMessage(event.replyToken, { type: 'text', text: replyText });
                    await logToDb(userId, `Postback: ${event.postback.data}`, replyText, "System", `watch_service_status_${action.split('_')[1]}`);
                } catch (replyError) {
                    await safePushMessage(userId, { type: 'text', text: replyText });
                    await logErrorToDb(userId, `Watch service postback replyMessage失敗、safePushMessageでフォールバック`, { error: replyError.message, userMessage: `Postback: ${event.postback.data}` });
                }
            } catch (error) {
                console.error(`❌ 見守りサービスPostback応答処理エラー (${action}):`, error.message);
                await logErrorToDb(userId, `見守りサービスPostback応答処理エラー (${action})`, { error: error.message, userId: userId });
            }
        }
        return;
    }
    
    replyText = "ごめんね、その操作はまだできないみたい…💦";
    logType = 'unknown_postback_action';
    try {
        await client.replyMessage(event.replyToken, { type: 'text', text: replyText });
        await logToDb(userId, `Postback: ${event.postback.data}`, replyText, "System", logType);
    } catch (replyError) {
        await safePushMessage(userId, { type: 'text', text: replyText });
        await logErrorToDb(userId, `Default postback replyMessage失敗、safePushMessageでフォールバック`, { error: replyError.message, userMessage: `Postback: ${event.postback.data}` });
    }
}

async function handleUnfollowEvent(event) {
    if (!event.source || !event.source.userId) {
        if (process.env.NODE_ENV !== 'production') {
            console.log("userIdが取得できないUnfollowイベントでした。無視します.", event);
        }
        return;
    }
    const userId = event.source.userId;
    if (process.env.NODE_ENV !== 'production') {
        console.log(`❌ ユーザーがブロック/アンフォローしました: ${userId}`);
    }
    try {
        await db.collection('users').doc(userId).delete();
        await logToDb(userId, "アンフォローイベント", "ユーザーがブロック/アンフォローによりデータ削除", "System", "system_unfollow");
    } catch (error) {
        console.error(`❌ アンフォロー時のユーザーデータ削除エラー: ${error.message}`);
        await logErrorToDb(userId, `アンフォロー時のユーザーデータ削除エラー`, { error: error.message, userId: userId });
    }
}

async function handleJoinEvent(event) {
    if (!event.source || !event.source.groupId) {
        if (process.env.NODE_ENV !== 'production') {
            console.log("groupIdが取得できないJoinイベントでした。無視します。", event);
        }
        return;
    }
    const groupId = event.source.groupId;
    if (process.env.NODE_ENV !== 'production') {
        console.log(`✅ ボットがグループに参加しました: ${groupId}`);
    }
    const replyMessage = '皆さん、こんにちは！皆守こころです🌸\nこのグループで、みんなのお役に立てると嬉しいな💖';
    try {
        await client.replyMessage(event.replyToken, { type: 'text', text: replyMessage });
        await logToDb(groupId, "グループ参加イベント", replyMessage, "System", "system_join");
    } catch (replyError) {
        await safePushMessage(groupId, { type: 'text', text: replyMessage });
        await logErrorToDb(groupId, `Join event replyMessage失敗、safePushMessageでフォールバック`, { error: replyError.message, groupId: groupId });
    }
}

async function handleLeaveEvent(event) {
    if (!event.source || !event.source.groupId) {
        if (process.env.NODE_ENV !== 'production') {
            console.log("groupIdが取得できないLeaveイベントでした。無視します。", event);
        }
        return;
    }
    const groupId = event.source.groupId;
    if (process.env.NODE_ENV !== 'production') {
        console.log(`❌ ボットがグループから退出しました: ${groupId}`);
    }
    await logToDb(groupId, "グループ退出イベント", "ボットがグループから退出", "System", "system_leave");
}

async function handleAdminCommand(event, userId, userMessage) {
    const args = userMessage.split(' ');
    const command = args[0].substring(1);
    
    let replyText = '';
    let logType = 'admin_command';

    switch(command) {
        case 'status':
            replyText = 'OKだよ！ボットは正常に稼働しているよ。';
            break;
        case 'help':
            replyText = '利用可能なコマンドは次のとおりだよ🌸\n!status: ボットの稼働状況を確認\n!notify [message]: 管理者グループにメッセージを送信\n!setmember [userId]: ユーザーをメンバーに変更\n!setpremium [userId]: ユーザーをプレミアムに変更\n!setguest [userId]: ユーザーをゲストに変更\n!resetcount [userId]: ユーザーのメッセージカウントをリセット\n!getuser [userId]: ユーザー情報を取得';
            break;
        case 'notify':
            const notificationMessage = args.slice(1).join(' ');
            if (OFFICER_GROUP_ID && notificationMessage) {
                await safePushMessage(OFFICER_GROUP_ID, { type: 'text', text: `📢 管理者からの通知: ${notificationMessage}` });
                replyText = '管理者グループにメッセージを送信しました🌸';
            } else {
                replyText = 'ごめん、通知メッセージが空か、管理者グループIDが設定されていないみたい💦';
            }
            break;
        case 'get_user_info':
            const targetUserId = args[1];
            if (targetUserId) {
                const user = await getUserData(targetUserId);
                if (user) {
                    replyText = `👤 ユーザー情報:\n`
                        + `ID: ${targetUserId}\n`
                        + `名前: ${user.name || '未登録'}\n`
                        + `カテゴリ: ${user.category || '未登録'}\n`
                        + `会員タイプ: ${user.membershipType || 'guest'}\n`
                        + `見守りサービス: ${user.watchServiceEnabled ? '有効' : '無効'}\n`
                        + `登録完了: ${user.completedRegistration ? 'はい' : 'いいえ'}`;
                } else {
                    replyText = `ユーザー ${targetUserId} は見つかりませんでした。`;
                }
            } else {
                replyText = 'ユーザーIDを指定してね！ 例: !get_user_info Uxxxxxxx';
            }
            break;
        default:
            replyText = `ごめんね、そのコマンドはまだ使えないみたい💦\n!help で利用可能なコマンドを確認してね🌸`;
    }
    
    await client.replyMessage(event.replyToken, { type: 'text', text: replyText });
    await logToDb(userId, userMessage, replyText, 'Admin', logType, true);
}


// --- 見守りサービス機能 (cronスケジュール) ---

// 毎日定刻に見守りメッセージを送信
cron.schedule('0 10 * * *', async () => { // 毎日午前10時に実行
    try {
        const usersSnapshot = await db.collection('users')
            .where('watchServiceEnabled', '==', true)
            .get();

        for (const doc of usersSnapshot.docs) {
            const userId = doc.id;
            const user = doc.data();

            const lastSent = user.lastScheduledWatchMessageSent ? new Date(user.lastScheduledWatchMessageSent._seconds * 1000) : null;
            const now = new Date();
            const oneDay = 24 * 60 * 60 * 1000;

            if (!lastSent || (now.getTime() - lastSent.getTime()) >= oneDay) {
                const watchMessage = {
                    "type": "flex",
                    "altText": "こころからの見守りメッセージ🌸",
                    "contents": {
                        "type": "bubble",
                        "body": {
                            "type": "box",
                            "layout": "vertical",
                            "contents": [
                                { "type": "text", "text": "皆守こころの見守りサービス🌸", "weight": "bold", "size": "lg", "align": "center", "color": "#FF69B4" },
                                { "type": "text", "text": "元気にしてるかな？💖", "wrap": true, "margin": "md", "size": "sm", "align": "center" },
                                { "type": "text", "text": "もし大丈夫だったら、下から一つ選んで教えてくれると嬉しいな😊", "wrap": true, "margin": "md", "size": "xs", "align": "center" }
                            ]
                        },
                        "footer": {
                            "type": "box",
                            "layout": "vertical",
                            "spacing": "sm",
                            "contents": [
                                { "type": "button", "action": { "type": "postback", "label": "OKだよ💖", "data": "action=watch_ok" }, "style": "primary", "height": "sm", "margin": "md", "color": "#FFB6C1" },
                                { "type": "button", "action": { "type": "postback", "label": "ちょっと元気ないかも…", "data": "action=watch_somewhat" }, "style": "primary", "height": "sm", "margin": "md", "color": "#FFD700" },
                                { "type": "button", "action": { "type": "postback", "label": "疲れてるから休んでるよ", "data": "action=watch_tired" }, "style": "primary", "height": "sm", "margin": "md", "color": "#9370DB" },
                                { "type": "button", "action": { "type": "postback", "label": "お話したいな🌸", "data": "action=watch_talk" }, "style": "primary", "height": "sm", "margin": "md", "color": "#4682B4" }
                            ]
                        }
                    }
                };

                await safePushMessage(userId, watchMessage);
                await updateUserData(userId, {
                    lastScheduledWatchMessageSent: admin.firestore.FieldValue.serverTimestamp(),
                    firstReminderSent: false,
                    emergencyNotificationSent: false
                });
                await logToDb(userId, "CRON", "定時見守りメッセージ送信", "System", "scheduled_watch_message");
            }
        }
        console.log("✅ 定時見守りメッセージの送信が完了しました。");
    } catch (error) {
        console.error("❌ 定時見守りメッセージの送信中にエラーが発生しました:", error);
    }
}, {
    timezone: "Asia/Tokyo"
});

// 見守りメッセージ応答チェック (毎日定刻)
cron.schedule('0 18 * * *', async () => { // 毎日18時に実行
    try {
        const usersSnapshot = await db.collection('users')
            .where('watchServiceEnabled', '==', true)
            .get();

        const now = new Date();

        for (const doc of usersSnapshot.docs) {
            const userId = doc.id;
            const user = doc.data();

            const lastScheduledSent = user.lastScheduledWatchMessageSent ? new Date(user.lastScheduledWatchMessageSent._seconds * 1000) : null;
            const lastOkResponse = user.lastOkResponse ? new Date(user.lastOkResponse._seconds * 1000) : null;
            
            if (lastScheduledSent && (!lastOkResponse || lastScheduledSent.getTime() > lastOkResponse.getTime())) {
                const timeSinceSent = now.getTime() - lastScheduledSent.getTime();
                const eightHours = 8 * 60 * 60 * 1000;

                if (timeSinceSent >= eightHours) {
                    if (!user.firstReminderSent) {
                        const reminderMessage = 'こころだよ！🌸\n午前中に送ったメッセージ、見てくれたかな？💖\nもしよかったら、元気か教えてくれると嬉しいな😊';
                        await safePushMessage(userId, { type: 'text', text: reminderMessage });
                        await updateUserData(userId, { firstReminderSent: true });
                        await logToDb(userId, "CRON", "見守り応答リマインダー1回目", "System", "watch_service_reminder_1st");
                    }
                }
            }
        }
        console.log("✅ 見守り応答リマインダーのチェックが完了しました。");
    } catch (error) {
        console.error("❌ 見守り応答リマインダーチェック中にエラーが発生しました:", error);
    }
}, {
    timezone: "Asia/Tokyo"
});

// 緊急通知チェック (毎日定刻)
cron.schedule('0 21 * * *', async () => { // 毎日21時に実行
    try {
        const usersSnapshot = await db.collection('users')
            .where('watchServiceEnabled', '==', true)
            .get();

        const now = new Date();

        for (const doc of usersSnapshot.docs) {
            const userId = doc.id;
            const user = doc.data();

            const lastScheduledSent = user.lastScheduledWatchMessageSent ? new Date(user.lastScheduledWatchMessageSent._seconds * 1000) : null;
            const lastOkResponse = user.lastOkResponse ? new Date(user.lastOkResponse._seconds * 1000) : null;
            
            if (lastScheduledSent && (!lastOkResponse || lastScheduledSent.getTime() > lastOkResponse.getTime())) {
                const timeSinceSent = now.getTime() - lastScheduledSent.getTime();
                const elevenHours = 11 * 60 * 60 * 1000;

                if (timeSinceSent >= elevenHours && !user.emergencyNotificationSent) {
                    const emergencyMessage = '大変です！皆守こころの見守りサービスを利用中のユーザーから、安否確認への応答がありません。\n' +
                                             '直ちに状況の確認をお願いします。\n\n' +
                                             `👤 氏名：${user.name || '未登録'}\n` +
                                             `📱 電話番号：${user.phoneNumber || '未登録'}\n` +
                                             `🏠 市区町村：${(user.address && user.address.city) ? user.address.city : '未登録'}\n` +
                                             `👨‍👩‍👧‍👦 保護者名：${user.guardianName || '未登録'}\n` +
                                             `📞 緊急連絡先：${user.guardianPhoneNumber || '未登録'}`;
                    
                    if (OFFICER_GROUP_ID) {
                        await safePushMessage(OFFICER_GROUP_ID, { type: 'text', text: emergencyMessage });
                        await logToDb(userId, "CRON", "緊急通知を送信", "System", "watch_service_emergency_alert", true);
                        await updateUserData(userId, { emergencyNotificationSent: true });
                    }
                    console.log(`🚨 ユーザー ${userId} の安否確認応答なし。緊急通知を送信しました。`);
                }
            }
        }
        console.log("✅ 緊急通知のチェックが完了しました。");
    } catch (error) {
        console.error("❌ 緊急通知チェック中にエラーが発生しました:", error);
    }
}, {
    timezone: "Asia/Tokyo"
});


// --- Webhookとサーバー起動 ---
app.post('/webhook', line.middleware(config), (req, res) => {
    Promise.all(req.body.events.map(handleEventWrapper))
        .then(() => res.status(200).end())
        .catch((err) => {
            console.error("🚨 Webhook処理中にエラーが発生しました:", err);
            res.status(500).end();
        });
});

async function handleEventWrapper(event) {
    try {
        switch (event.type) {
            case 'message':
                await handleEvent(event);
                break;
            case 'postback':
                await handlePostbackEvent(event);
                break;
            case 'follow':
                await handleFollowEvent(event);
                break;
            case 'unfollow':
                await handleUnfollowEvent(event);
                break;
            case 'join':
                await handleJoinEvent(event);
                break;
            case 'leave':
                await handleLeaveEvent(event);
                break;
            default:
                if (process.env.NODE_ENV !== 'production') {
                    console.log("Unhandled event type:", event.type, event);
                }
        }
    } catch (err) {
        console.error("🚨 個別イベントの処理中にエラーが発生しました:", err);
    }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server is running on port ${PORT}`);
});
