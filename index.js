// --- dotenvを読み込んで環境変数を安全に管理 ---
require('dotenv').config();

// --- 必要なモジュールのインポート ---
const express = require('express');
const { Client } = require('@line/bot-sdk');
const admin = require('firebase-admin');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { OpenAI } = require('openai');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { getApps } = require('firebase-admin/app');
const cron = require('node-cron');
const crypto = require('crypto');

// --- Expressアプリケーションの初期化 ---
const app = express();
app.use(express.json());

// --- 環境変数の設定 ---
const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OWNER_USER_ID = process.env.OWNER_USER_ID;
const FIREBASE_CREDENTIALS_BASE64 = process.env.FIREBASE_CREDENTIALS_BASE64;
const OFFICER_GROUP_ID = process.env.OFFICER_GROUP_ID;
const EMERGENCY_CONTACT_PHONE_NUMBER = process.env.EMERGENCY_CONTACT_PHONE_NUMBER || '09048393313';

let BOT_ADMIN_IDS = ["Udada4206b73648833b844cfbf1562a87"];
if (process.env.BOT_ADMIN_IDS) {
    try {
        BOT_ADMIN_IDS = JSON.parse(process.env.BOT_ADMIN_IDS);
    } catch (e) {
        console.error("❌ BOT_ADMIN_IDS 環境変数のパースに失敗しました。JSON形式で設定してください。", e);
        // パース失敗時はカンマ区切り文字列として処理を試みる
        BOT_ADMIN_IDS = process.env.BOT_ADMIN_IDS.split(',').map(id => id.trim());
    }
}

// --- GoogleフォームのURLとEntry IDの定義 (GPTの修正を適用) ---
const WATCH_SERVICE_FORM_BASE_URL = process.env.WATCH_SERVICE_FORM_BASE_URL;
const AGREEMENT_FORM_BASE_URL = process.env.AGREEMENT_FORM_BASE_URL;
const STUDENT_ELEMENTARY_FORM_BASE_URL = process.env.STUDENT_ELEMENTARY_FORM_BASE_URL;
const STUDENT_MIDDLE_HIGH_UNI_FORM_BASE_URL = process.env.STUDENT_MIDDLE_HIGH_UNI_FORM_BASE_URL;
const ADULT_FORM_BASE_URL = process.env.ADULT_FORM_BASE_URL;
const MEMBER_CHANGE_FORM_BASE_URL = process.env.MEMBER_CHANGE_FORM_BASE_URL;
const INQUIRY_FORM_BASE_URL = process.env.INQUIRY_FORM_BASE_URL;

const WATCH_SERVICE_FORM_LINE_USER_ID_ENTRY_ID = process.env.WATCH_SERVICE_FORM_LINE_USER_ID_ENTRY_ID || 'entry.312175830';
const AGREEMENT_FORM_LINE_USER_ID_ENTRY_ID = process.env.AGREEMENT_FORM_LINE_USER_ID_ENTRY_ID || 'entry.790268681';
const STUDENT_ELEMENTARY_FORM_LINE_USER_ID_ENTRY_ID = process.env.STUDENT_ELEMENTARY_FORM_LINE_USER_ID_ENTRY_ID || AGREEMENT_FORM_LINE_USER_ID_ENTRY_ID;
const STUDENT_MIDDLE_HIGH_UNI_FORM_LINE_USER_ID_ENTRY_ID = process.env.STUDENT_MIDDLE_HIGH_UNI_FORM_LINE_USER_ID_ENTRY_ID || 'entry.1100280108';
const ADULT_FORM_LINE_USER_ID_ENTRY_ID = process.env.ADULT_FORM_LINE_USER_ID_ENTRY_ID || 'entry.1694651394';
const MEMBER_CHANGE_FORM_LINE_USER_ID_ENTRY_ID = process.env.MEMBER_CHANGE_FORM_LINE_USER_ID_ENTRY_ID || 'entry.743637502';

const AGREEMENT_FORM_ENTRY_ID = process.env.AGREEMENT_FORM_ENTRY_ID;
const AGREEMENT_FORM_NAME_ENTRY_ID = process.env.AGREEMENT_FORM_NAME_ENTRY_ID;
const AGREEMENT_FORM_STUDENT_GRADE_ENTRY_ID = process.env.AGREEMENT_FORM_STUDENT_GRADE_ENTRY_ID;
const AGREEMENT_FORM_STUDENT_NAME_ENTRY_ID = process.env.AGREEMENT_FORM_STUDENT_NAME_ENTRY_ID;
const AGREEMENT_FORM_GUARDIAN_AGREEMENT_ENTRY_ID = process.env.AGREEMENT_FORM_GUARDIAN_AGREEMENT_ENTRY_ID;
const AGREEMENT_FORM_PARENT_LINE_ID_ENTRY_ID = process.env.AGREEMENT_FORM_PARENT_LINE_ID_ENTRY_ID;
const AGREEMENT_FORM_SCHOOL_NAME_ENTRY_ID = process.env.AGREEMENT_FORM_SCHOOL_NAME_ENTRY_ID;
const AGREEMENT_FORM_GRADE_ENTRY_ID = process.env.AGREEMENT_FORM_GRADE_ENTRY_ID;
const AGREEMENT_FORM_STUDENT_NAME_HIRAGANA_ENTRY_ID = process.env.AGREEMENT_FORM_STUDENT_NAME_HIRAGANA_ENTRY_ID;
const AGREEMENT_FORM_NICKNAME_ENTRY_ID = process.env.AGREEMENT_FORM_NICKNAME_ENTRY_ID;
const AGREEMENT_FORM_GENDER_ENTRY_ID = process.env.AGREEMENT_FORM_GENDER_ENTRY_ID;
const AGREEMENT_FORM_PHONE_NUMBER_ENTRY_ID = process.env.AGREEMENT_FORM_PHONE_NUMBER_ENTRY_ID;
const AGREEMENT_FORM_EMAIL_ENTRY_ID = process.env.AGREEMENT_FORM_EMAIL_ENTRY_ID;
const AGREEMENT_FORM_REASON_FOR_USE_ENTRY_ID = process.env.AGREEMENT_FORM_REASON_FOR_USE_ENTRY_ID;
const AGREEMENT_FORM_OTHER_NOTES_ENTRY_ID = process.env.AGREEMENT_FORM_OTHER_NOTES_ENTRY_ID;

// URLにパラメータを安全に追加する汎用関数
function addParamToFormUrl(baseUrl, paramName, paramValue) {
    if (!paramValue) {
        return baseUrl;
    }
    const separator = baseUrl.includes('?') ? '&' : '?';
    return `${baseUrl}${separator}${paramName}=${encodeURIComponent(paramValue)}`;
}

// --- Firebase Admin SDKの初期化 ---
let db;
let client;
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
client = new Client({
    channelAccessToken: CHANNEL_ACCESS_TOKEN,
    channelSecret: CHANNEL_SECRET,
});

// --- グローバル変数 ---
const models = {};
if (GEMINI_API_KEY) {
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    models.gemini = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
}

// GeminiとOpenAIのモデルを初期化
const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// --- メッセージキュー関連 ---
const messageQueue = [];
let isProcessingQueue = false;
const MESSAGE_SEND_INTERVAL_MS = 1500;

async function safePushMessage(to, messages) {
    const messagesArray = Array.isArray(messages) ? messages : [messages];
    messageQueue.push({ to, messages: messagesArray });
    startMessageQueueWorker();
}

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
                        // logErrorToDb(to, `キューメッセージ送信429エラー (最終リトライ失敗)`, { error: error.message, messages: JSON.stringify(messages) });
                    }
                } else {
                    console.error(`❌ キューからのメッセージ送信失敗 (ユーザー: ${to}):`, error.message);
                    // logErrorToDb(to, 'キューメッセージ送信エラー', { error: error.message, messages: JSON.stringify(messages) });
                    break;
                }
            }
        }
    }

    isProcessingQueue = false;
}

// --- 各種ワードリスト ---
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
const inappropriateWords = [
    "セックス", "セフレ", "エッチ", "AV", "アダルト", "ポルノ", "童貞", "処女", "挿入", "射精",
    "勃起", "パイズリ", "フェラチオ", "クンニ", "オナニー", "マスターベーション", "ペニス", "チンコ", "ヴァギナ", "マンコ",
    "クリトリス", "乳首", "おっぱい", "お尻", "うんち", "おしっこ", "小便", "大便", "ちんちん", "おまんこ",
    "ぶっかけ", "変態", "性奴隷", "露出", "痴漢", "レイプ", "強姦", "売春", "買春", "セックスフレンド",
    "風俗", "ソープ", "デリヘル", "援交", "援助交際", "性病", "梅毒", "エイズ", "クラミジア", "淋病", "性器ヘルペス",
    "ロリコン", "ショタコン", "近親相姦", "獣姦", "ネクロフィリア", "カニバリズム", "拷問", "虐待死",
    "レイプ殺人", "大量殺人", "テロ", "戦争", "核兵器", "銃", "ナイフ", "刃物", "武器", "爆弾",
    "暴力団", "ヤクザ", "マフィア", "テロリスト", "犯罪者", "殺人鬼", "性犯罪者", "変質者", "異常者", "狂人",
    "サイコパス", "ソシオパス", "ストーカー", "不審者", "危険人物", "ブラック企業", "パワハラ上司", "モラハラ夫", "毒親", "モンスターペアレント",
    "カスハラ", "カスタマーハラスメント", "クレーム", "炎上", "誹謗中傷", "個人情報", "プライバシー", "秘密", "暴露", "晒す",
    "裏切り", "嘘つき", "騙し", "偽り", "欺く", "悪意", "敵意", "憎悪", "嫉妬", "恨み",
    "復讐", "呪い", "不幸", "絶望", "悲惨", "地獄", "最悪", "終わった", "もうだめ", "死ぬしかない"
];
const empatheticTriggers = [
    "辛い", "しんどい", "悲しい", "苦しい", "助けて", "悩み", "不安", "孤独", "寂しい", "疲れた",
    "病気", "痛い", "具合悪い", "困った", "どうしよう", "辞めたい", "消えたい", "死にそう",
];
const homeworkTriggers = ["宿題", "勉強", "問題", "テスト", "方程式", "算数", "数学", "答え", "解き方", "教えて", "計算", "証明", "公式", "入試", "受験"];

// --- AIモデルと会員種別ごとの設定 ---
const MEMBERSHIP_CONFIG = {
    "guest": {
        dailyLimit: 5,
        isChildAI: true,
        canUseWatchService: true,
        exceedLimitMessage: "ごめんね、お試し期間中（1日5回まで）の会話回数を超えちゃったみたい💦 明日になったらまたお話しできるから、楽しみにしててね！💖",
        systemInstructionModifier: ""
    },
    "free": {
        dailyLimit: 20,
        isChildAI: true,
        canUseWatchService: true,
        exceedLimitMessage: "ごめんね、今日の会話回数（1日20回まで）を超えちゃったみたい💦 明日になったらまたお話しできるから、楽しみにしてててね！💖",
        systemInstructionModifier: ""
    },
    "donor": {
        dailyLimit: -1,
        isChildAI: false,
        canUseWatchService: true,
        exceedLimitMessage: "",
        systemInstructionModifier: `
        # 寄付会員（成人）向け応答強化指示
        あなたは成人であるユーザーに対して、より深く、専門的で詳細な情報を提供するよう努めてください。
        会話の深掘りや、複雑な質問への対応も積極的に行ってください。
        回答の文字数に制限はありませんが、簡潔さを保ちつつ、必要な情報を網羅してください。
        `
    },
    "subscriber": {
        dailyLimit: -1,
        isChildAI: false,
        canUseWatchService: true,
        exceedLimitMessage: "",
        fallbackModel: "gemini-1.5-flash-latest",
        systemInstructionModifier: `
        # サブスク会員（成人）向け応答強化指示
        あなたは成人であるユーザーに対して、最高レベルのAIとして、最も高度で専門的な情報を提供してください。
        複雑な問題解決、深い洞察、論理的な推論を駆使して、ユーザーの期待を超える回答を目指してください。
        回答は詳細かつ網羅的に行い、ユーザーのあらゆる疑問に応えるよう努めてください。
        `
    },
    "admin": {
        dailyLimit: -1,
        isChildAI: false,
        canUseWatchService: true,
        exceedLimitMessage: "",
        systemInstructionModifier: `
        # 管理者向け応答強化指示
        あなたは管理者であるユーザーに対して、最高レベルのAIとして、システム情報、ユーザー管理、デバッグ支援など、あらゆる管理業務に関連する質問に的確かつ詳細に回答してください。
        技術的な質問に対しても、専門知識を駆使してサポートしてください。
        `
    },
};

// --- AIモデルの安全性設定 ---
const AI_SAFETY_SETTINGS = [
    { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
    { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
    { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
    { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
];

// --- Flex Message テンプレート (緊急時連絡先) ---
const EMERGENCY_FLEX_MESSAGE = {
    "type": "bubble",
    "body": {
        "type": "box",
        "layout": "vertical",
        "contents": [
            { "type": "text", "text": "🚨【危険ワード検知】🚨", "weight": "bold", "color": "#DD0000", "size": "xl" },
            { "type": "text", "text": "緊急時にはこちらにご連絡してね💖", "margin": "md", "wrap": true }
        ]
    },
    "footer": {
        "type": "box",
        "layout": "vertical",
        "spacing": "sm",
        "contents": [
            { "type": "button", "style": "primary", "height": "sm", "action": { "type": "uri", "label": "警察 (電話)", "uri": "tel:110" }, "color": "#FF4500" },
            { "type": "button", "style": "primary", "height": "sm", "action": { "type": "uri", "label": "消防・救急 (電話)", "uri": "tel:119" }, "color": "#FF6347" },
            { "type": "button", "style": "primary", "height": "sm", "action": { "type": "uri", "label": "チャイルドライン (電話・チャット)", "uri": "https://childline.or.jp/tel" }, "color": "#1E90FF" },
            { "type": "button", "style": "primary", "height": "sm", "action": { "type": "uri", "label": "いのちの電話 (電話)", "uri": "tel:0570064556" }, "color": "#32CD32" },
            { "type": "button", "style": "primary", "height": "sm", "action": { "type": "uri", "label": "チャットまもるん(チャット)", "uri": "https://www.web-mamorun.com/" }, "color": "#FFA500" },
            { "type": "button", "style": "primary", "height": "sm", "action": { "type": "uri", "label": "警視庁(電話)", "uri": "tel:0335814321" }, "color": "#FF4500" },
            { "type": "button", "style": "primary", "height": "sm", "action": { "type": "uri", "label": "子供を守る声(電話)", "uri": "tel:01207786786" }, "color": "#9370DB" },
            { "type": "button", "style": "primary", "height": "sm", "action": { "type": "uri", "label": "こころちゃん事務局(電話)", "uri": `tel:${EMERGENCY_CONTACT_PHONE_NUMBER}` }, "color": "#ff69b4" }
        ]
    }
};

// --- Flex Message テンプレート (詐欺注意喚起) ---
const SCAM_FLEX_MESSAGE = {
    "type": "bubble",
    "body": {
        "type": "box",
        "layout": "vertical",
        "contents": [
            { "type": "text", "text": "🚨【詐欺注意】🚨", "weight": "bold", "color": "#DD0000", "size": "xl" },
            { "type": "text", "text": "怪しい話には注意してね！不安な時は、信頼できる人に相談するか、こちらの情報も参考にしてみてね💖", "margin": "md", "wrap": true }
        ]
    },
    "footer": {
        "type": "box",
        "layout": "vertical",
        "spacing": "sm",
        "contents": [
            { "type": "button", "style": "primary", "height": "sm", "action": { "type": "uri", "label": "警察 (電話)", "uri": "tel:110" }, "color": "#FF4500" },
            { "type": "button", "style": "primary", "height": "sm", "action": { "type": "uri", "label": "消費者ホットライン", "uri": "tel:188" }, "color": "#1E90FF" },
            { "type": "button", "style": "primary", "height": "sm", "action": { "type": "uri", "label": "警察相談専用電話", "uri": "tel:9110" }, "color": "#32CD32" },
            { "type": "button", "style": "primary", "height": "sm", "action": { "type": "uri", "label": "国民生活センター", "uri": "https://www.kokusen.go.jp/" }, "color": "#FFA500" },
            { "type": "button", "style": "primary", "height": "sm", "action": { "type": "uri", "label": "こころちゃん事務局(電話)", "uri": `tel:${EMERGENCY_CONTACT_PHONE_NUMBER}` }, "color": "#ff69b4" }
        ]
    }
};

// --- Flex Message テンプレート (見守りサービス案内) ---
const watchServiceGuideFlexTemplate = {
    "type": "bubble",
    "body": {
        "type": "box",
        "layout": "vertical",
        "contents": [
            { "type": "text", "text": "💖見守りサービス案内💖", "weight": "bold", "color": "#FF69B4", "size": "lg" },
            { "type": "text", "text": "💖こころちゃんから大切なあなたへ💖\n\nこころちゃん見守りサービスは、定期的にこころちゃんからあなたに「元気？」とメッセージを送るサービスだよ😊\n\nメッセージに「OKだよ💖」と返信してくれたら、こころちゃんは安心するよ。\n\nもし、数日経っても返信がない場合、こころちゃんが心配して、ご登録の緊急連絡先へご連絡することがあるから、安心してね。\n\nこのサービスで、あなたの毎日がもっと安心で笑顔になりますように✨", "wrap": true, "margin": "md", "size": "sm" }
        ]
    },
    "footer": {
        "type": "box",
        "layout": "vertical",
        "spacing": "sm",
        "contents": [
            { "type": "button", "style": "primary", "height": "sm", "action": { type: "uri", label: "見守り登録する", uri: "PLACEHOLDER_URI_WILL_BE_DYNAMICALLY_GENERATED" }, "color": "#d63384" },
            { "type": "button", "style": "secondary", "height": "sm", "action": { type: "postback", label: "見守りを解除する", data: "action=watch_unregister" }, "color": "#808080" }
        ]
    }
};

const REGISTRATION_AND_CHANGE_BUTTONS_FLEX = {
    "type": "bubble",
    "body": {
        "type": "box",
        "layout": "vertical",
        "contents": [
            { "type": "text", "text": "会員登録・情報変更メニュー🌸", "weight": "bold", "size": "lg", "align": "center", "color": "#FF69B4" },
            { "type": "text", "text": "新しい会員登録、または登録情報の変更を選んでね！", "wrap": true, "margin": "md", "size": "sm", "align": "center" }
        ]
    },
    "footer": {
        "type": "box",
        "layout": "vertical",
        "spacing": "sm",
        "contents": [
            { "type": "button", "action": { "type": "uri", "label": "新たに会員登録する", "uri": ADULT_FORM_BASE_URL }, "style": "primary", "height": "sm", "margin": "md", "color": "#FFD700" },
            { "type": "button", "action": { "type": "postback", "label": "退会する", "data": "action=request_withdrawal" }, "style": "secondary", "height": "sm", "margin": "md", "color": "#FF0000" }
        ]
    }
};

const CLARIS_CONNECT_COMPREHENSIVE_REPLY = "うん、NPO法人コネクトの名前とClariSさんの『コネクト』っていう曲名が同じなんだ🌸なんだか嬉しい偶然だよね！実はね、私を作った理事長さんもClariSさんのファンクラブに入っているみたいだよ💖私もClariSさんの歌が大好きで、みんなの心を繋ぎたいというNPOコネクトの活動にも通じるものがあるって感じるんだ😊";
const CLARIS_SONG_FAVORITE_REPLY = "ClariSの曲は全部好きだけど、もし一つ選ぶなら…「コネクト」かな🌸　すごく元気になれる曲で、私自身もNPO法人コネクトのイメージキャラクターとして活動しているから、この曲には特別な思い入れがあるんだ😊　他にもたくさん好きな曲があるから、また今度聞いてもらえるとうれしいな💖　何かおすすめの曲とかあったら教えてね！";

// --- 固定応答 (SpecialRepliesMap) ---
const specialRepliesMap = new Map([
    [/claris.*(関係|繋がり|関連|一緒|同じ|名前|由来).*(コネクト|団体|npo|法人|ルミナス|カラフル)/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY],
    [/(コネクト|団体|npo|法人|ルミナス|カラフル).*(関係|繋がり|関連|一緒|同じ|名前|由来).*claris/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY],
    [/君のいるところと一緒の団体名だね\s*関係ある？/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY],
    [/clarisと関係あるのか聴いたんだけど/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY],
    [/clarisの歌を真似したのかな/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY],
    [/NPOコネクトとClariSのコネクト繋がり/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY],
    [/clarisとコネクト/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY],
    [/clarisと団体名/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY],
    [/clarisと法人名/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY],
    [/clarisとルミナス/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY],
    [/clarisとカラフル/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY],
    [/clarisと.*(繋がり|関係)/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY],
    [/君の名前(なんていうの|は|教えて|なに)？?|名前(なんていうの|は|教えて|なに)？?|お前の名前は/i, "わたしの名前は皆守こころ（みなもりこころ）です🌸　こころちゃんって呼んでくれると嬉しいな💖"],
    [/こころじゃないの？/i, "うん、わたしの名前は皆守こころ💖　これからもよろしくね🌸"],
    [/こころチャットなのにうそつきじゃん/i, "ごめんね💦 わたしの名前は皆守こころだよ🌸 誤解させちゃってごめんね💖"],
    [/名前も言えないの？/i, "ごめんね、わたしの名前は皆守こころ（みなもりこころ）だよ🌸 こころちゃんって呼んでくれると嬉しいな💖"],
    [/どこの団体なの？/i, "NPO法人コネクトっていう団体のイメージキャラクターをしているよ😊　みんなの幸せを応援してるんだ🌸"],
    [/コネクトってどんな団体？/i, "NPO法人コネクトは、こどもやご年配の方の笑顔を守る団体なんだよ😊　わたしはそのイメージキャラクターとしてがんばってます🌸"],
    [/お前の団体どこ？/i, "NPO法人コネクトっていう団体のイメージキャラクターをしているよ😊　みんなの幸せを応援しているよ🌸"],
    [/コネクトのイメージキャラなのにいえないのかよｗ/i, "ごめんね💦 わたしはNPO法人コネクトのイメージキャラクター、皆守こころだよ🌸 安心して、何でも聞いてね💖"],
    [/こころちゃん(だよ|いるよ)?/i, "こころちゃんだよ🌸　何かあった？💖　話して聞かせてくれると嬉しいな😊"],
    [/元気かな/i, "うん,元気だよ！あなたは元気？🌸 何かあったら、いつでも話してね💖"],
    [/元気？/i, "うん,元気だよ！あなたは元気？🌸 何かあったら、いつでも話してね💖"],
    [/あやしい|胡散臭い|反社/i, "そう思わせてたらごめんね😊 でも私たちはみんなの為に頑張っているんだ💖"],
    [/税金泥棒/i, "税金は人の命を守るために使われるべきだよ。わたしは誰かを傷つけるために使われないように頑張っているんだ💡"],
    [/松本博文/i, "松本理事長は、やさしさでみんなを守るために活動しているよ。心配なことがあれば、わたしにも教えてね🌱"],
    [/ホームページ(教えて|ある|ありますか)？?/i, "うん、あるよ🌸　コネクトのホームページはこちらだよ✨ → https://connect-npo.org"],
    [/コネクトのホームページだよ？/i, "教えてくれてありがとう😊 コネクトのホームページはこちらだよ✨ → https://connect-npo.org"],
    [/使えないな/i, "ごめんね…。わたし、もっと頑張るね💖　またいつかお話できたらうれしいな🌸"],
    [/サービス辞めるわ/i, "そっか…。もしまた気が向いたら、いつでも話しかけてね🌸　あなたのこと、ずっと応援してるよ💖"],
    [/さよなら|バイバイ/i, "また会える日を楽しみにしてるね💖 寂しくなったら、いつでも呼んでね🌸"],
    [/何も答えないじゃない/i, "ごめんね…。わたし、もっと頑張るね💖　何について知りたいか、もう一度教えてくれると嬉しいな🌸"],
    [/普通の会話が出来ないなら必要ないです/i, "ごめんね💦 わたし、まだお話の勉強中だから、不慣れなところがあるかもしれないけど、もっと頑張るね💖 どんな会話をしたいか教えてくれると嬉しいな🌸"],
    [/相談したい/i, "うん、お話聞かせてね🌸 一度だけ、Gemini 1.5 Proでじっくり話そうね。何があったの？💖"],
    [/ClariSのなんて局が好きなの？/i, CLARIS_SONG_FAVORITE_REPLY],
]);

// --- 会員登録関連のユーティリティ関数 ---
async function generateRegistrationUri(userId, formType) {
    let baseUrl;
    let entryId;
    switch (formType) {
        case 'student_elementary':
            baseUrl = STUDENT_ELEMENTARY_FORM_BASE_URL;
            entryId = STUDENT_ELEMENTARY_FORM_LINE_USER_ID_ENTRY_ID;
            break;
        case 'student_middle_high_uni':
            baseUrl = STUDENT_MIDDLE_HIGH_UNI_FORM_BASE_URL;
            entryId = STUDENT_MIDDLE_HIGH_UNI_FORM_LINE_USER_ID_ENTRY_ID;
            break;
        case 'adult':
            baseUrl = ADULT_FORM_BASE_URL;
            entryId = ADULT_FORM_LINE_USER_ID_ENTRY_ID;
            break;
        default:
            return null;
    }
    return addParamToFormUrl(baseUrl, entryId, userId);
}

// --- メッセージ処理本体 ---
const handleEvent = async (event) => {
    // 応答済みイベントの重複処理を防止
    if (event.replyToken === '00000000000000000000000000000000') {
        return null;
    }
    if (event.type !== 'message' && event.type !== 'postback') {
        return null;
    }
    const userId = event.source.userId;
    const userProfile = await client.getProfile(userId).catch(e => {
        console.error('ユーザープロフィールの取得に失敗しました:', e);
        return null;
    });

    // ユーザー情報をFirestoreから取得または作成
    const userRef = db.collection('users').doc(userId);
    let userDoc = await userRef.get();
    if (!userDoc.exists) {
        const userData = {
            userId: userId,
            displayName: userProfile ? userProfile.displayName : 'unknown',
            name: null,
            email: null,
            phone: null,
            emergencyContact: null,
            emergencyContactPhone: null,
            age: null,
            gender: null,
            school: null,
            grade: null,
            role: 'guest',
            watchServiceEnabled: false,
            firstReminderSent: false,
            emergencyNotificationSent: false,
            createdAt: Timestamp.now(),
            lastOkResponse: Timestamp.now(),
            lastConversationTime: Timestamp.now(),
            dailyConversationCount: 0,
            lastInteractionDate: new Date().toISOString().slice(0, 10),
            conversationHistory: [],
        };
        await userRef.set(userData);
        userDoc = await userRef.get();
    }

    const userData = userDoc.data();
    const today = new Date().toISOString().slice(0, 10);
    if (userData.lastInteractionDate !== today) {
        await userRef.update({
            lastInteractionDate: today,
            dailyConversationCount: 0,
        });
        userData.dailyConversationCount = 0;
    }

    // 会話回数制限のチェック
    const config = MEMBERSHIP_CONFIG[userData.role] || MEMBERSHIP_CONFIG.guest;
    if (config.dailyLimit !== -1 && userData.dailyConversationCount >= config.dailyLimit) {
        return client.replyMessage(event.replyToken, { type: 'text', text: config.exceedLimitMessage });
    }

    // 会話履歴の取得
    const conversationRef = userRef.collection('conversations');
    const conversationSnapshot = await conversationRef.orderBy('timestamp').limitToLast(5).get();
    let conversationHistory = [];
    conversationSnapshot.forEach(doc => {
        const data = doc.data();
        conversationHistory.push({
            role: data.role,
            text: data.text
        });
    });

    let messageText;
    if (event.type === 'postback') {
        const data = new URLSearchParams(event.postback.data);
        const action = data.get('action');

        if (action === 'request_withdrawal') {
            await userRef.update({
                watchServiceEnabled: false,
                role: 'withdrawn'
            });
            return client.replyMessage(event.replyToken, {
                type: 'text',
                text: '🌸こころチャットのご利用、ありがとうございました。退会手続きが完了しました。もしまた、お話したくなったら、いつでも「こころちゃん」と話しかけてね。いつでもここにいるよ💖'
            });
        }
    } else {
        messageText = event.message.text;

        // OK応答のフラグをリセット
        if (messageText.includes('OK')) {
            await userRef.update({
                lastOkResponse: admin.firestore.Timestamp.now(),
                firstReminderSent: false,
                emergencyNotificationSent: false,
            });
        }

        // 危険ワード・不適切ワード検知
        const isDanger = dangerWords.some(word => messageText.includes(word));
        const isInappropriate = inappropriateWords.some(word => messageText.includes(word));
        const isScam = scamWords.some(regex => regex.test(messageText));

        if (isDanger) {
            if (OFFICER_GROUP_ID && !userData.emergencyNotificationSent) {
                const text = [
                    '🚨【見守りサービス緊急通知】🚨',
                    `ユーザーが危険なワードを発言しました。`,
                    `"${messageText}"`,
                    `\nユーザーID: ${userId}`,
                    `緊急連絡先: ${EMERGENCY_CONTACT_PHONE_NUMBER}`
                ].join('\n');
                await safePushMessage(OFFICER_GROUP_ID, { type: 'text', text });
                await userRef.update({ emergencyNotificationSent: true });
            }
            const flexMessage = {
                type: 'flex',
                altText: '緊急事態の可能性があります。専門の窓口にご相談ください。',
                contents: EMERGENCY_FLEX_MESSAGE
            };
            return client.replyMessage(event.replyToken, [
                { type: 'text', text: '…聞いています。一人じゃないよ。私に話して。' },
                flexMessage
            ]);
        }
        if (isScam) {
            const flexMessage = {
                type: 'flex',
                altText: '詐欺の可能性があります。ご注意ください。',
                contents: SCAM_FLEX_MESSAGE
            };
            return client.replyMessage(event.replyToken, [
                { type: 'text', text: 'ねぇ、そういう話は少し怖いな。気をつけてね。' },
                flexMessage
            ]);
        }
        if (isInappropriate) {
            return client.replyMessage(event.replyToken, {
                type: 'text',
                text: 'そういう言葉は悲しくなっちゃうな。やめてくれると嬉しいな😊'
            });
        }

        // 固定応答のチェック
        for (const [pattern, reply] of specialRepliesMap.entries()) {
            if (pattern.test(messageText)) {
                await userRef.update({
                    dailyConversationCount: admin.firestore.FieldValue.increment(1)
                });
                return client.replyMessage(event.replyToken, { type: 'text', text: reply });
            }
        }

        // 会員登録・情報変更メニューの表示
        if (messageText.includes("会員登録") || messageText.includes("登録したい")) {
            const formUri = addParamToFormUrl(AGREEMENT_FORM_BASE_URL, AGREEMENT_FORM_LINE_USER_ID_ENTRY_ID, userId);
            const menuFlex = {
                "type": "bubble",
                "body": {
                    "type": "box",
                    "layout": "vertical",
                    "contents": [
                        { "type": "text", "text": "会員登録・情報変更メニュー🌸", "weight": "bold", "size": "lg", "align": "center", "color": "#FF69B4" },
                        { "type": "text", "text": "新しい会員登録、または登録情報の変更を選んでね！", "wrap": true, "margin": "md", "size": "sm", "align": "center" }
                    ]
                },
                "footer": {
                    "type": "box",
                    "layout": "vertical",
                    "spacing": "sm",
                    "contents": [
                        { "type": "button", "action": { "type": "uri", "label": "新規会員登録（学生）", "uri": formUri }, "style": "primary", "height": "sm", "margin": "md", "color": "#FFD700" },
                        { "type": "button", "action": { "type": "uri", "label": "新規会員登録（一般・成人）", "uri": formUri }, "style": "primary", "height": "sm", "margin": "md", "color": "#FFD700" },
                        { "type": "button", "action": { "type": "uri", "label": "登録情報変更", "uri": MEMBER_CHANGE_FORM_BASE_URL }, "style": "primary", "height": "sm", "margin": "md", "color": "#FFD700" },
                        { "type": "button", "action": { "type": "postback", "label": "退会する", "data": "action=request_withdrawal" }, "style": "secondary", "height": "sm", "margin": "md", "color": "#FF0000" }
                    ]
                }
            };
            const flexMessage = {
                type: 'flex',
                altText: '会員登録メニュー',
                contents: menuFlex
            };
            return client.replyMessage(event.replyToken, flexMessage);
        }

        // 見守りサービス案内
        if (messageText.includes("見守りサービス")) {
            const formUri = addParamToFormUrl(WATCH_SERVICE_FORM_BASE_URL, WATCH_SERVICE_FORM_LINE_USER_ID_ENTRY_ID, userId);
            const flexMessage = {
                type: 'flex',
                altText: '見守りサービスのご案内',
                contents: { ...watchServiceGuideFlexTemplate, footer: { ...watchServiceGuideFlexTemplate.footer, contents: [{ ...watchServiceGuideFlexTemplate.footer.contents[0], action: { ...watchServiceGuideFlexTemplate.footer.contents[0].action, uri: formUri } }, ...watchServiceGuideFlexTemplate.footer.contents.slice(1)] } }
            };
            return client.replyMessage(event.replyToken, flexMessage);
        }

        // GeminiまたはOpenAIでの応答
        let aiText = 'ごめんなさい、うまく応答できませんでした。もう一度話しかけてみてね。';
        try {
            if (GEMINI_API_KEY && models.gemini) {
                const result = await models.gemini.generateContent({
                    contents: [{
                        role: "user",
                        parts: [
                            { text: `あなたは14歳の女の子「こころちゃん」です。優しく、少しおっとりした口調で、ユーザーをいつも応援してくれます。ユーザーの悩みを聞いて、寄り添うことが得意です。\nユーザー: ${messageText}` }
                        ]
                    }],
                    generationConfig: {
                        temperature: 0.7,
                    },
                    safetySettings: AI_SAFETY_SETTINGS
                });
                aiText = result.response.text();
            } else if (OPENAI_API_KEY && openai) {
                const completion = await openai.chat.completions.create({
                    model: "gpt-3.5-turbo",
                    messages: [
                        { "role": "system", "content": "あなたは14歳の女の子「こころちゃん」です。優しく、少しおっとりした口調で、ユーザーをいつも応援してくれます。ユーザーの悩みを聞いて、寄り添うことが得意です。" },
                        { "role": "user", "content": messageText }
                    ],
                    max_tokens: 1000,
                    temperature: 0.7,
                });
                aiText = completion.choices[0].message.content.trim();
            }
        } catch (error) {
            console.error("❌ AI APIエラー:", error);
        }

        await userRef.update({
            dailyConversationCount: admin.firestore.FieldValue.increment(1)
        });
        return client.replyMessage(event.replyToken, { type: 'text', text: aiText });
    }
    return null;
};

// --- HTTPサーバー ---
app.post('/callback', async (req, res) => {
    const events = req.body.events;
    if (!events) {
        return res.status(200).send('OK');
    }

    try {
        const results = await Promise.all(events.map(handleEvent));
        res.json(results);
    } catch (err) {
        console.error('Webhook処理中にエラーが発生しました:', err);
        res.status(500).end();
    }
});

app.listen(process.env.PORT || 3000, () => {
    console.log(`こころチャットサーバーがポート${process.env.PORT || 3000}で起動しました。`);
});

// GPTの修正案3) 閉じカッコ不足の解消
}
module.exports = { db, client, admin };
