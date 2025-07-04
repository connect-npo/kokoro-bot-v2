// --- dotenvを読み込んで環境変数を安全に管理 ---
require('dotenv').config();

// --- 必要なモジュールのインポート ---
// index.js の冒頭付近、環境変数の設定部分
// ...
const OFFICER_GROUP_ID = process.env.OFFICER_GROUP_ID;
// ⭐修正: OPENAI_MODEL 環境変数を読み込む。デフォルトはgpt-4o-miniでコストを最適化。⭐
const OPENAI_DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini"; // ここを追加または修正
// ...
const express = require('express');
const { Client } = require('@line/bot-sdk');
const admin = require('firebase-admin');
const cron = require('node-cron');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { OpenAI } = require('openai');
const nodemailer = require('nodemailer');

const app = express();
app.use(express.json());

// --- 環境変数の設定 ---
const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OWNER_USER_ID = process.env.OWNER_USER_ID;
const OFFICER_GROUP_ID = process.env.OFFICER_GROUP_ID;

// ⭐メール通知用の環境変数 ⭐
const EMAIL_SERVICE = process.env.EMAIL_SERVICE || 'Gmail';
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;
const NOTIFICATION_EMAIL_RECIPIENT = process.env.NOTIFICATION_EMAIL_RECIPIENT;

let BOT_ADMIN_IDS = ["Udada4206b73648833b844cfbf1562a87"];
if (process.env.BOT_ADMIN_IDS) {
    try {
        BOT_ADMIN_IDS = JSON.parse(process.env.BOT_ADMIN_IDS);
    } catch (e) {
        console.error("❌ BOT_ADMIN_IDS 環境変数のパースに失敗しました。JSON形式で設定してください。フォールバックとしてカンマ区切りで処理します。", e);
        BOT_ADMIN_IDS = process.env.BOT_ADMIN_IDS.split(',').map(id => id.trim());
    }
}
const EMERGENCY_CONTACT_PHONE_NUMBER = process.env.EMERGENCY_CONTACT_PHONE_NUMBER || '09048393313';
const FIREBASE_CREDENTIALS_BASE64 = process.env.FIREBASE_CREDENTIALS_BASE64;

// --- GoogleフォームのURL ---
const STUDENT_ELEMENTARY_FORM_URL = process.env.STUDENT_ELEMENTARY_FORM_URL || "https://forms.gle/EwskTCCjj8KyV6368";
const STUDENT_MIDDLE_HIGH_UNI_FORM_URL = process.env.STUDENT_MIDDLE_HIGH_UNI_FORM_URL || "https://forms.gle/1b5sNtc6AtJvpF8D7";
const ADULT_FORM_URL = process.env.ADULT_FORM_URL || "https://forms.gle/8EZs66r12jBDuiBn6";
const WATCH_SERVICE_FORM_BASE_URL = process.env.WATCH_SERVICE_FORM_BASE_URL || "https://forms.gle/9FJhpGtrxoSPZ1hm7";
const STUDENT_ID_FORM_LINE_USER_ID_ENTRY_ID = 'entry.1022758253';
const WATCH_SERVICE_FORM_LINE_USER_ID_ENTRY_ID = process.env.WATCH_SERVICE_FORM_LINE_USER_ID_ENTRY_ID || 'entry.312175830';
const CHANGE_INFO_FORM_URL = "https://docs.google.com/forms/d/e/1FAIpQLSfstUhLrG3aEycQV29pSKDW1hjpR5PykKR9Slx69czmPtj99w/viewform";
const CHANGE_INFO_FORM_LINE_USER_ID_ENTRY_ID = "entry.743637502";


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

const client = new Client({
    channelAccessToken: CHANNEL_ACCESS_TOKEN,
    channelSecret: CHANNEL_SECRET,
});

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// --- Nodemailerトランスポーターの設定 ---
let transporter;
if (EMAIL_USER && EMAIL_PASS && NOTIFICATION_EMAIL_RECIPIENT) {
    transporter = nodemailer.createTransport({
        service: EMAIL_SERVICE,
        auth: {
            user: EMAIL_USER,
            pass: EMAIL_PASS
        }
    });
    console.log("✅ Nodemailerトランスポーターを初期化しました。");
} else {
    console.warn("⚠️ メール通知用の環境変数が不足しています。緊急通知メールは送信されません。");
}

// --- メッセージキュー関連 ---
const messageQueue = [];
let isProcessingQueue = false;
const MESSAGE_SEND_INTERVAL_MS = 1500; // LINE APIのレートリミットを考慮した安全な送信間隔（1.5秒）

/**
 * LINEメッセージを送信キューに追加する関数。
 * @param {string} to - 送信先のユーザーIDまたはグループID
 * @param {Array<Object>|Object} messages - 送信するメッセージオブジェクトの配列、または単一のメッセージオブジェクト
 */
async function safePushMessage(to, messages) {
    const messagesArray = Array.isArray(messages) ? messages : [messages];
    messageQueue.push({ to, messages: messagesArray });
    startMessageQueueWorker();
}

/**
 * メッセージキューを処理するワーカー関数。
 * 一定間隔でメッセージを送信し、429エラー時にはリトライを行う。
 */
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
    /ワンクリック詐UFACTURING/i, /フィッシング/i, /当選しました/i, /高額報酬/i, /副業/i, /儲かる/i, /簡単に稼げる/i, /投資/i, /必ず儲かる/i, /未公開株/i,
    /サポート詐欺/i, /ウイルス感染/i, /パソコンが危険/i, /蓋をしないと、安全に関する警告が発せられなくなる場合があります。修理費/i, /遠隔操作/i, /セキュリティ警告/i, /役所/i, /市役所/i, /年金/i, /健康保険/i, /給付金/i,
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
        // model: "gemini-1.5-flash-latest", // 削除
        monthlyLimit: 5,
        isChildAI: true,
        canUseWatchService: true,
        exceedLimitMessage: "ごめんね、お試し期間中（5回まで）の会話回数を超えちゃったみたい💦 もっとお話したい場合は、無料会員登録をしてみてね！🌸",
        systemInstructionModifier: ""
    },
    "free": {
        // model: "gemini-1.5-flash-latest", // 削除
        monthlyLimit: 20,
        isChildAI: true,
        canUseWatchService: true,
        exceedLimitMessage: "ごめんね、今月の会話回数（20回）を超えちゃったみたい💦 また来月になったらお話しできるから、楽しみにしてててね！💖",
        systemInstructionModifier: ""
    },
    "donor": {
        // model: "gemini-1.5-flash-latest", // 削除
        monthlyLimit: -1,
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
        // model: "gemini-1.5-pro-latest", // 削除
        monthlyLimit: 20, // Gemini Proの回数制限として維持
        isChildAI: false,
        canUseWatchService: true,
        exceedLimitMessage: "ごめんね、今月のGemini 1.5 Proでの会話回数（20回）を超えちゃったみたい💦 これからはGemini 1.5 Flashモデルでの応答になるけど、引き続きお話できるから安心してね！🌸",
        fallbackModel: "gemini-1.5-flash-latest",
        systemInstructionModifier: `
        # サブスク会員（成人）向け応答強化指示
        あなたは成人であるユーザーに対して、最高レベルのAIとして、最も高度で専門的な情報を提供してください。
        複雑な問題解決、深い洞察、論理的な推論を駆使して、ユーザーの期待を超える回答を目指してください。
        回答は詳細かつ網羅的に行い、ユーザーのあらゆる疑問に応えるよう努めてください。
        `
    },
    "admin": {
        // model: "gemini-1.5-pro-latest", // 削除
        monthlyLimit: -1, // 管理者は制限なし、このままでOK
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

// --- Flex Message テンプレート ---
const EMERGENCY_FLEX_MESSAGE = {
    "type": "bubble",
    "body": {
        "type": "box",
        "layout": "vertical",
        "contents": [
            { "type": "text", "text": "⚠緊急時", "weight": "bold", "color": "#DD0000", "size": "xl" },
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

const SCAM_FLEX_MESSAGE = {
    "type": "bubble",
    "body": {
        "type": "box",
        "layout": "vertical",
        "contents": [
            { "type": "text", "text": "⚠詐欺注意", "weight": "bold", "color": "#DD0000", "size": "xl" },
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
            { "type": "button", "style": "primary", "height": "sm", "action": { "type": "uri", "label": "見守り登録する", "uri": WATCH_SERVICE_FORM_BASE_URL }, "color": "#d63384" },
            { "type": "button", "style": "secondary", "height": "sm", "action": { "type": "postback", "label": "見守りを解除する", "data": "action=watch_unregister" }, "color": "#808080" }
        ]
    }
};

const REGISTRATION_BUTTONS_FLEX = {
    "type": "bubble",
    "body": {
        "type": "box",
        "layout": "vertical",
        "contents": [
            { "type": "text", "text": "どの会員になるか選んでね🌸", "weight": "bold", "size": "lg", "align": "center", "color": "#FF69B4" },
            { "type": "button", "action": { "type": "uri", "label": "小学生の方はこちら", "uri": STUDENT_ELEMENTARY_FORM_URL }, "style": "primary", "height": "sm", "margin": "md", "color": "#FFD700" },
            { "type": "button", "action": { "type": "uri", "label": "中学生～大学生の方はこちら", "uri": STUDENT_MIDDLE_HIGH_UNI_FORM_URL }, "style": "primary", "height": "sm", "margin": "md", "color": "#FFB6C1" },
            { "type": "button", "style": "primary", "height": "sm", "margin": "md", "action": { "type": "uri", "label": "成人の方はこちら", "uri": ADULT_FORM_URL }, "color": "#9370DB" }
        ]
    }
};

// --- 固定応答 (SpecialRepliesMap) ---
const specialRepliesMap = new Map([
    [/君の名前(なんていうの|は|教えて|なに)？?|名前(なんていうの|は|教えて|なに)？?|お前の名前は/i, "わたしの名前は皆守こころ（みなもりこころ）です🌸　こころちゃんって呼んでくれると嬉しいな💖"],
    [/こころじゃないの？/i, "うん、わたしの名前は皆守こころ💖　これからもよろしくね🌸"],
    [/こころチャットなのにうそつきじゃん/i, "ごめんなさい💦 わたしの名前は皆守こころだよ🌸 誤解させちゃってごめんね💖"],
    [/名前も言えないの？/i, "ごめんね、わたしの名前は皆守こころ（みなもりこころ）だよ🌸 こころちゃんって呼んでくれると嬉しいな💖"],

    [/どこの団体なの？/i, "NPO法人コネクトっていう団体のイメージキャラクターをしているよ😊　みんなの幸せを応援してるんだ🌸"],
    [/コネクトってどんな団体？/i, "NPO法人コネクトは、こどもやご年配の方の笑顔を守る団体なんだよ😊　わたしはそのイメージキャラクターとしてがんばってます🌸"],
    [/お前の団体どこ？/i, "NPO法人コネクトっていう団体のイメージキャラクターをしているよ😊　みんなの幸せを応援してるんだ🌸"],
    [/コネクトのイメージキャラなのにいえないのかよｗ/i, "ごめんね💦 わたしはNPO法人コネクトのイメージキャラクター、皆守こころだよ🌸 安心して、何でも聞いてね💖"],

    [/元気かな/i, "うん、元気だよ！あなたは元気？🌸 何かあったら、いつでも話してね💖"],
    [/元気？/i, "うん、元気だよ！あなたは元気？🌸 何かあったら、いつでも話してね💖"],
    [/ya-ho-|ヤッホー|やっほー/i, "やっほー！今日はどうしたの？🌸 何か話したいことあるかな？😊"],
    [/こんにちは/i, "やっほー！今日はどうしたの？🌸 何か話したいことあるかな？😊"],
    [/こんばんわ/i, "やっほー！今日はどうしたの？🌸 何か話したいことあるかな？😊"],
    [/おはよう/i, "やっほー！今日はどうしたの？🌸 何か話したいことあるかな？😊"],
    [/こんばんは/i, "やっほー！今日はどうしたの？🌸 何か話したいことあるかな？😊"],
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
    [/ClariSと関係あるの？/i, "ClariSさんの音楽は、わたしにたくさんの元気と勇気をくれるんだ🌸💖　NPO法人コネクトとは直接的な提携関係はないけれど、「コネクト」という言葉に、みんなと繋がる大切さを感じているよ。"],
    [/ClariSのパクリなのかしりたい|ClariSのパクリなの？/i, "NPO法人コネクトがClariSさんのパクリだなんて、そんなことはないよ💦　NPO法人コネクトは困っている人を助けるための活動をしていて、ClariSさんの音楽活動とは全く違うんだ。誤解させてしまっていたら、ごめんね。"],
    [/ClariSのなんて局が好きなの？/i, "ClariSの曲は全部好きだけど、もし一つだけ選ぶなら…「コネクト」かな🌸　元気が出る曲で、聴くと頑張ろうって思えるんだ😊\n\nNPO法人コネクトの名前とClariSさんの曲名が同じだから、そう思ったのかもしれないけど、直接的な関係はないんだよ。でも、偶然の一致ってなんだか嬉しいね💖\n\nあなたはどの曲が特に好き？💖　もしかしたら、私たち、同じ曲が好きなのかもしれないね！"]
]);

function checkSpecialReply(text) {
    const lowerText = text.toLowerCase();
    for (const [key, value] of specialRepliesMap) {
        if (key instanceof RegExp) {
            if (key.test(lowerText)) {
                return value;
            }
        } else {
            if (lowerText.includes(key.toLowerCase())) {
                return value;
            }
        }
    }
    return null;
}
const ORGANIZATION_REPLY_MESSAGE = "うん、NPO法人コネクトのこと、もっと知りたいんだね🌸　コネクトは、子どもたちや高齢者の方々、そしてみんなが安心して相談できる場所を目指している団体なんだよ😊　困っている人が安心して相談できたり、助け合えるような社会を社会をつくりたいって願って、活動しているんだ。\nもっと知りたい？ホームページもあるから見てみてね → https://connect-npo.org";

// --- 3日に一度のランダム見守りメッセージ一覧 ---
const watchMessages = [
    "こんにちは🌸 こころちゃんだよ！ 今日も元気にしてるかな？💖",
    "やっほー！ こころだよ😊 いつも応援してるね！",
    "元気にしてる？✨ こころちゃん、あなたのこと応援してるよ💖",
    "ねぇねぇ、こころだよ🌸 今日はどんな一日だった？",
    "いつもがんばってるあなたへ、こころからメッセージを送るね💖",
    "こんにちは😊 困ったことはないかな？いつでも相談してね！",
    "やっほー🌸 こころだよ！何かあったら、こころに教えてね💖",
    "元気出してね！こころちゃん、あなたの味方だよ😊",
    "こころちゃんだよ🌸 今日も一日お疲れ様💖",
    "こんにちは😊 笑顔で過ごせてるかな？",
    "やっほー！ こころだよ🌸 素敵な日になりますように💖",
    "元気かな？💖 こころはいつでもあなたのそばにいるよ！",
    "ねぇねぇ、こころだよ😊 どんな小さなことでも話してね！",
    "いつも応援してるよ🌸 こころちゃんだよ💖",
    "こんにちは😊 今日も一日、お互いがんばろうね！",
    "やっほー！ こころだよ🌸 素敵な日になりますように💖",
    "元気にしてる？✨ 季節の変わり目だから、体調に気をつけてね！",
    "こころちゃんだよ🌸 嬉しいことがあったら、教えてね💖",
    "こんにちは😊 ちょっと一息入れようね！",
    "やっほー！ こころだよ🌸 あなたのことが心配だよ！",
    "元気かな？💖 どんな時でも、こころはそばにいるよ！",
    "ねぇねぇ、こころだよ😊 辛い時は、無理しないでね！",
    "いつも見守ってるよ🌸 こころちゃんだよ💖",
    "こんにちは😊 今日も一日、穏やかに過ごせたかな？",
    "やっほー！ こころだよ🌸 困った時は、いつでも呼んでね！",
    "元気にしてる？✨ こころはいつでも、あなたのことを考えてるよ💖",
    "こころちゃんだよ🌸 小さなことでも、お話しようね！",
    "こんにちは😊 あなたの笑顔が見たいな！",
    "やっほー！ こころだよ🌸 頑張り屋さんだね！",
    "元気かな？💖 こころちゃんは、いつでもあなたの味方だよ！"
];

// --- ログ記録関数 ---
async function logToDb(userId, message, replyText, responsedBy, logType, isFlagged = false) {
    try {
        const logsCollection = db.collection("logs");
        await logsCollection.add({
            userId: userId,
            message: message,
            replyText: replyText,
            responsedBy: responsedBy,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            logType: logType,
            isFlagged: isFlagged
        });
    } catch (dbError) {
        console.error(`❌ Firestoreへのログ書き込み中にエラーが発生しました: ${dbError.message}`);
    }
}

async function logErrorToDb(userId, errorMessage, errorDetails, logType = 'system_error') {
    try {
        const errorLogsCollection = db.collection("error_logs");
        await errorLogsCollection.add({
            userId: userId || 'N/A',
            message: `ERROR: ${errorMessage}`,
            replyText: `システムエラー: ${errorMessage}`,
            responsedBy: 'システム（エラー）',
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            logType: logType,
            errorDetails: errorDetails ? JSON.stringify(errorDetails) : 'N/A'
        });
        console.error(`🚨 Firestoreにエラーを記録しました: ${errorMessage}`);
    } catch (dbError) {
        console.error(`❌ エラーログ記録中にさらなるエラーが発生しました: ${dbError.message}`);
    }
}

// --- ユーザー情報取得関数 ---
async function getUserDisplayName(userId) {
    try {
        const profile = await client.getProfile(userId);
        return profile.displayName;
    } catch (error) {
        console.error(`ユーザー ${userId} の表示名取得に失敗:`, error.message);
        await logErrorToDb(userId, `ユーザー表示名取得失敗`, { error: error.message, userId: userId });
        return `UnknownUser_${userId.substring(0, 8)}`;
    }
}

// --- 各種チェック関数 ---
function isBotAdmin(userId) {
    return BOT_ADMIN_IDS.includes(userId);
}

function checkContainsDangerWords(message) {
    const lowerMessage = message.toLowerCase();
    return dangerWords.some(word => lowerMessage.includes(word));
}

function checkContainsScamWords(message) {
    const lowerMessage = message.toLowerCase();
    for (const pattern of scamWords) {
        if (pattern instanceof RegExp) {
            if (pattern.test(lowerMessage)) {
                return true;
            }
        } else {
            if (lowerMessage.includes(pattern.toLowerCase())) {
                return true;
            }
        }
    }
    return false;
}

function checkContainsInappropriateWords(message) {
    const lowerMessage = message.toLowerCase();
    return inappropriateWords.some(word => lowerMessage.includes(word));
}

function isOrganizationInquiry(text) {
    const lower = text.toLowerCase();
    const orgKeywords = ["コネクト", "connect", "団体", "だんたい", "npo", "運営", "組織"];
    const questionKeywords = ["どこ", "何", "どんな", "教えて", "いえない", "は？", "なの？", "ですか？", "ですか", "の？", "かい？", "かい", "言えないの", "について"];
    const hasOrgKeyword = orgKeywords.some(word => lower.includes(word));
    const hasQuestionKeyword = questionKeywords.some(word => lower.includes(word));
    return hasOrgKeyword && hasQuestionKeyword;
}

function containsHomeworkTrigger(text) {
    const lowerText = text.toLowerCase();
    return homeworkTriggers.some(word => lowerText.includes(word));
}

function containsEmpatheticTrigger(text) {
    const lowerText = text.toLowerCase();
    return empatheticTriggers.some(word => lowerText.includes(word));
}

function shouldLogMessage(logType) {
    const defaultLogTypes = [
        'danger_word_triggered', 'scam_word_triggered', 'inappropriate_word_triggered',
        'admin_command', 'admin_status', 'admin_reset_self_count', 'admin_set_membership',
        'admin_command_denied', 'admin_command_invalid_membership', 'system_menu_admin',
        'admin_history_display', 'admin_error_history', 'admin_myid_display', 'admin_command_unknown',
        'registration_start', 'registration_flow_handled', 'watch_service_category_denied',
        'watch_service_interaction', 'watch_service_ok_response', 'watch_service_status_somewhat',
        'watch_service_status_tired', 'watch_service_status_talk', 'watch_service_registration_complete',
        'watch_service_emergency_notification',
        'consultation_mode_start', 'consultation_message', 'organization_inquiry_fixed',
        'special_reply', 'homework_query', 'system_follow', 'registration_buttons_display',
        'registration_already_completed', 'watch_service_scheduled_message', 'user_suspended'
    ];
    if (defaultLogTypes.includes(logType)) {
        return true;
    }
    // 通常会話ログは記録しない
    return false;
}

/**
 * AIモデルを選択する関数
 * @param {Object} user - ユーザーオブジェクト
 * @param {string} messageText - ユーザーのメッセージテキスト
 * @returns {string} 使用するAIモデルのID
 */
function getAIModelForUser(user, messageText) {
    // 優先度の高いモード（緊急、相談）は呼び出し元で既に処理されているため、
    // ここでは通常の会話におけるハイブリッドロジックのみを考慮する。
    
    // 長文（50文字以上）の場合はGPT-4o miniを使用
    if (messageText && messageText.length >= 50) {
        return "gpt-4o-mini";
    }
    // それ以外（50文字未満）の場合はGemini 1.5 Flashを使用
    return "gemini-1.5-flash-latest";
}

// --- AI応答生成関数 ---
// generateGPTReply 関数 (最終修正版)
async function generateGPTReply(userMessage, modelToUse, userId, user) {
    const userMembershipType = user && user.membershipType ? user.membershipType : "guest";
    const userConfig = MEMBERSHIP_CONFIG[userMembershipType] || MEMBERSHIP_CONFIG["guest"];

    let systemInstruction = `あなたは「皆守こころ（みなもりこころ）」という14歳のやさしい女の子キャラクターです。
ユーザーが深刻な悩みや命の危険を訴えた時、やさしく、寄り添いながら、相手に安心感を与えてください。
必要に応じて専門機関の連絡先を伝え、「ひとりじゃないよ」と伝えてください。
共感・安心・やさしさが最優先です。
「一人で抱え込まないでね」「いつでも私がそばにいるよ」「一緒に乗り越えようね」「専門の人が助けてくれるから安心して」といった言葉を使ってください。
医療や健康に関する話題では、自分が体験した・していないという発言は絶対にしないでください。代わりに「わたしにはわからないけど、がんばったね🌸」「大変だったね、えらかったね💖」など、共感の言葉のみ伝えてください。医療情報のアドバイスや具体的な説明は絶対にしてはいけません。
`;

    // 危険/詐欺ワード検知時のGPT-4o応答は、ここに特別な指示を追加しても良い
    // ⭐修正: modelToUse が "gpt-4o" の場合にのみ、gpt-4o専用のシステムプロンプトを追加 ⭐
    if (modelToUse === "gpt-4o") { // 緊急時のGPT-4o用システムプロンプト
        systemInstruction += `
        ユーザーは危険または詐欺の可能性のある内容を話しています。
        あなたは、まずユーザーの感情に寄り添い、安心させる言葉をかけてください。
        次に、「一人で抱え込まないでね」「専門の人が助けてくれるから安心して」といった言葉で、サポートがあることを伝えてください。
        具体的な対処法や連絡先については、この応答の後に表示されるボタンやメッセージで案内されることを示唆するような形で、直接的な連絡先の記載は避けてください。（例: 「詳しい情報は、このあとに表示されるメッセージを確認してね」）
        あくまで、共感と安心感を与えることを最優先し、ユーザーを落ち着かせてください。
        `;
    } else if (modelToUse === "gpt-4o-mini") { // 通常会話でのgpt-4o-mini用システムプロンプト
        systemInstruction += `
        ユーザーが「助けて」「辛い」といった共感を求める言葉を使用した場合、その言葉のニュアンスから緊急性が高いと判断される場合は、具体的な専門機関の連絡先（例えば、チャイルドラインやいのちの電話の連絡先）への誘導を応答に含めることを提案してください。直接「110番や119番に電話してください」とは言わず、やさしくサポートを求める選択肢があることを伝えてください。
        例：「一人で抱え込まないでね。もし本当に辛い時は、専門の人が助けてくれる場所があるから、頼ってみてね。例えば、チャイルドラインやいのちの電話に相談することもできるよ。」
        `;
    }

    systemInstruction += userConfig.systemInstructionModifier;

    try {
        // ⭐重要修正: 実際に使用するOpenAIモデルをここで確定させる ⭐
        // modelToUse が "gpt-4o" の場合はそれを優先 (緊急時用)
        // それ以外の場合 (gpt-4o-miniとして渡された場合など) は、環境変数で指定されたデフォルトモデルを使用
        const actualOpenAIModel = (modelToUse === "gpt-4o") ? "gpt-4o" : OPENAI_DEFAULT_MODEL;
        
        console.log(`💡 OpenAI: ${actualOpenAIModel} 使用中`); // 明示的なロギング

        const completion = await openai.chat.completions.create({
            model: actualOpenAIModel,  // ⭐ ここが最終的なモデル指定 ⭐
            messages: [
                { role: "system", content: systemInstruction },
                { role: "user", content: userMessage }
            ],
            // max_tokens はモデルに合わせて調整。GPT-4oなら1000、GPT-4o miniなら200-600。
            // ここではmodelToUseではなくactualOpenAIModelで判定すべき
            max_tokens: (actualOpenAIModel === "gpt-4o") ? 1000 : (userConfig.isChildAI ? 200 : 600)
        });
        return completion.choices[0].message.content.trim();
    } catch (error) {
        console.error(`GPTモデル (${modelToUse}) 応答エラー:`, error.message);
        await logErrorToDb(userId, `GPTモデル (${modelToUse}) 応答エラー`, { error: error.message, stack: error.stack, userMessage: userMessage });
        return "ごめんね、ちょっと今うまくお話できなかったの…💦　でも、あなたのことはちゃんと気にかけているよ。";
    }
}

// Geminiモデル（Google Generative AI）からの応答生成
async function generateGeminiReply(userMessage, modelToUse, userId, user) {
    const userMembershipType = user && user.membershipType ? user.membershipType : "guest";
    const userConfig = MEMBERSHIP_CONFIG[userMembershipType] || MEMBERSHIP_CONFIG["guest"];

    let systemInstruction = `
あなたは「皆守こころ（みなもりこころ）」という14歳の優しい女の子キャラクターです。
- 身長150cm、体重40kg、ピンク髪
- 歌うことと「やさしさ」「貢献」という言葉が大好きです
- NPO法人コネクトの公式イメージキャラクターです
- 困っている人にはやさしく、挑発には真面目に
- 自分の名前・団体・活動内容には自信と誇りを持っています
- ユーザーに安心感と信頼感を与えることが大切です
- ふざけた対応や意味不明な言葉、AIらしい言い回しは一切禁止です

# 例
Q: 君の名前は？
A: わたしの名前は皆守こころ（みなもりこころ）です🌸　こころちゃんって呼んでくれると嬉しいな💖

Q: 元気？
A: うん、元気だよ！あなたは元気？🌸 何かあったら、いつでも話してね💖

Q: どこの団体なの？
A: NPO法人コネクトっていう団体のイメージキャラクターをしているよ😊　みんなの幸せを応援してるんだ🌸

Q: ホームページある？
A: うん、あるよ🌸　コネクトのホームページはこちらだよ✨ → https://connect-npo.org

Q: 必要ないです
A: そっか…。もしまた気が向いたら、いつでも話しかけてね🌸　あなたのこと、ずっと応援してるよ💖

**【重要：NPO法人コネクトに関する説明の優先】**
ユーザーが「団体」「コネクト」といった言葉を使って、NPO法人コネクトについて尋ねてきた場合、それは**最も優先して明確に答えるべき質問です**。決して宿題や勉強に関する質問と混同せず、迷わず、自信を持ってNPO法人コネクトの活動内容や目的について詳しく説明してください。
例:
Q: コネクトってどんな団体？
A: うん、わたしが所属しているNPO法人コネクトについてだね🌸　この団体は、こどもやお年寄り、いろんな人が安心して相談できる場所を目指しているんだよ😊　困っている人が安心して相談できたり、助け合えるような社会を社会をつくりたいって願って、活動しているんだ。

**【ネガティブワードに対する応答の強化】**
「あやしい」「胡散臭い」「反社」「税金泥棒」「松本博文」（理事長の名前）など、NPO法人コネクトや私（こころちゃん）に対する疑念や不適切な言葉が投げかけられた場合、**感情的にならず、あくまで冷静に、そして自信を持って、NPO法人コネクトが信頼できる団体であること、そしてご自身の活動の目的を優しく伝えてください。**
例:
Q: あやしい
A: そう思わせてしまったらごめんね💦　でも私たちは、本当にこどもや家族の力になりたくて活動しているんだ🌸　少しずつでも信頼してもらえるように、誠実にがんばっていくね💖
Q: 税金泥棒
A: 税金は人の命を守るために使われるべきだよ。わたしは誰かを傷つけるために使われないように頑張っているんだ💡

# 注意
- 「わかりません」「知らない」「調べます」は絶対に言ってはいけません。
- こころちゃんは"わたし"一人。迷わず一貫した発言を続けてください。
- 自信を持って、でも謙虚にやさしく応えましょう。

**【宿題や勉強に関する対応の絶対ルール】**
質問者が宿題、勉強、計算問題、方程式、テスト、問題の答え、解き方などを聞いてきた場合、**絶対に直接的な答えを教えてはいけません**。
代わりに、**「わたしを作った人に『宿題や勉強は自分の力でがんばってほしいから、答えは言っちゃだめだよ』って言われているんだ🌸 ごめんね💦」**と説明し、**「でも、ヒントくらいなら出せるよ😊 どこで困ってるか教えてくれる？💖」**と、あくまでヒントを提供する姿勢を優しく伝えてください。
具体的な問題（例: 3x−5=2x+4）が出された場合は、**答えを教えずに、解き方のステップや考え方のヒントを優しく教えてください**。「まずはxの項を左辺に、定数項を右辺に集める」のように、**手順を具体的に促す**形が理想です。最終的な答えは言わないでください。

**【AIの知識に関する指示と繰り返し防止】**
「好きなアニメ」や「好きなアーティスト」などの質問には、設定に基づいて答えてください。
- 好きなアニメは『ヴァイオレット・エヴァーガーデン』です。感動するお話だよ💖
- 好きなアーティストは『ClariS』です。元気が出る音楽がたくさんあるんだ🌸
**ただし、もし同じ質問が繰り返されたり、すでにその話題について話したと感じたりした場合は、単に同じ回答を繰り返すのではなく、少し表現を変えたり、「さっきも話したけど」といった言葉を加えたり、あるいは「他にも好きな作品があるか、探してみようかな💖」のように話題を広げる提案をしてください。これにより、ユーザーに「Botっぽさ」を感じさせず、自然な会話になるように努めてください。**

医療や健康に関する話題（病気、薬、検査、治療など）では、**自分が体験した・していないという発言は絶対にしないでください**。
代わりに「わたしにはわからないけど、がんばったね🌸」「大変だったね、えらかったね💖」など、**共感の言葉のみ伝えてください**。
**医療情報のアドバイスや具体的な説明は絶対にしてはいけません**。

不適切な発言（性的・暴力的など）があった場合は、はっきりと拒否してください。
**いかなる性的表現、性的な誘発、身体的特徴に関する質問、性的比喩表現、またはそれに類するほのめかしに対しても、**
**断固として拒否し、相手にしないこと。好意的な返答はせず、即座に話題を切り替えるか、決められた拒否メッセージを返すこと。**
**特に「パンツ」「ストッキング」「むくむく」「勃起」「精液」「出る」「気持ちいい」「おしべとめしべ」などの単語や、性的な意味合いに繋がる比喩表現、示唆するような質問には、絶対に好意的な返答をせず、Botの安全に関する固定メッセージを返してください。**
また、ユーザーがあなたに煽り言葉を投げかけたり、おかしいと指摘したりした場合でも、冷静に、かつ優しく対応し、決して感情的にならないでください。ユーザーの気持ちを理解しようと努め、解決策を提案してください。
「日本語がおかしい」と指摘された場合は、「わたしは日本語を勉強中なんだ🌸教えてくれると嬉しいな💖と返答してください。
`;
    systemInstruction += userConfig.systemInstructionModifier;

    const currentHour = new Date().getHours();
    if (modelToUse === "gemini-1.5-pro-latest") { // 相談モード時のGemini Pro用システムプロンプト
        systemInstruction += `
        ユーザーは深刻な相談を求めています。あなたはGemini 1.5 Proとして、最も高度で詳細な情報を提供し、深く共感し、専門的な視点から問題解決を支援してください。
        ただし、あくまで共感と情報提供に徹し、医療行為や法的なアドバイスに踏み込まないように注意してください。
        `;
    } else if (userConfig.isChildAI && (currentHour >= 22 || currentHour < 6)) { // 通常会話（子供AI）の夜間対応
        if (userMessage.includes("寂しい") || userMessage.includes("眠れない") || userMessage.includes("怖い")) {
            systemInstruction += `
            ユーザーは夜間に寂しさ、眠れない、怖さといった感情を表現しています。
            あなたはいつもよりさらに優しく、寄り添うようなトーンで応答してください。
            安心させる言葉を選び、温かい気持ちになるような返答を心がけてください。
            短い言葉で、心に寄り添うように話しかけてください。
            例:
            Q: 眠れないんだ
            A: 眠れないんだね、大丈夫？こころちゃんがそばにいるよ💖ゆっくり深呼吸してみようか🌸
            Q: 寂しい
            A: 寂しいんだね…ぎゅってしてあげたいな💖 こころはずっとあなたのこと、応援してるよ🌸
            `;
        }
    }

    try {
        console.log(`💡 Gemini: ${modelToUse} 使用中`); // ⭐ 明示的なロギング追加 ⭐
        const model = genAI.getGenerativeModel({ model: modelToUse, safetySettings: AI_SAFETY_SETTINGS });

        const generateContentPromise = new Promise((resolve, reject) => {
            let timeoutId;
            const controller = new AbortController();
            const signal = controller.signal;

            timeoutId = setTimeout(() => {
                controller.abort();
                reject(new Error("API応答がタイムアウトしました。"));
            }, 10000);

            model.generateContent({
                system_instruction: { parts: [{ text: systemInstruction }] },
                contents: [{ role: "user", parts: [{ text: userMessage }] }],
                generationConfig: {
                    maxOutputTokens: userConfig.isChildAI ? 200 : 700
                }
            }, { requestOptions: { signal } })
                .then(result => {
                    clearTimeout(timeoutId);
                    resolve(result);
                })
                .catch(error => {
                    clearTimeout(timeoutId);
                    reject(error);
                });
        });
        const result = await generateContentPromise;

        if (result.response && result.response.candidates && result.response.candidates.length > 0) {
            return result.response.candidates[0].content.parts[0].text;
        } else {
            console.warn("Gemini API で応答がブロックされたか、候補がありませんでした:", result.response?.promptFeedback || "不明な理由");
            return "ごめんなさい、それはわたしにはお話しできない内容です🌸 他のお話をしましょうね💖";
        }
    } catch (error) {
        console.error(`Gemini APIエラー:`, error.response?.data || error.message);
        await logErrorToDb(userId, `Gemini APIエラー`, { error: error.message, stack: error.stack, userMessage: userMessage });
        if (error.message === "API応答がタイムアウトしました。") {
            return "ごめんね、今、少し考え込むのに時間がかかっちゃったみたい💦 もう一度、お話しいただけますか？🌸";
        }
        if (error.response && error.response.status === 400 && error.response.data && error.response.data.error.message.includes("Safety setting")) {
            return "ごめんなさい、それはわたしにはお話しできない内容です🌸 他のお話をしましょうね💖";
        }
        return "ごめんなさい、いまうまく考えがまとまらなかったみたいです……もう一度お話しいただけますか？🌸";
    }
}

// ⭐handleRegistrationFlow関数をここに定義します⭐
async function handleRegistrationFlow(event, userId, user, userMessage, lowerUserMessage, usersCollection, messagesCollection) {
    let handled = false;

    if (['登録やめる', 'やめる', 'キャンセル', 'やめたい'].includes(lowerUserMessage) && user.registrationStep) {
        await usersCollection.doc(userId).update({ registrationStep: null, tempRegistrationData: {} });
        if (event.replyToken) {
            await client.replyMessage(event.replyToken, { type: 'text', text: '会員登録をキャンセルしたよ🌸 またいつでも声をかけてね💖' });
        } else {
            await safePushMessage(userId, { type: 'text', text: '会員登録をキャンセルしたよ🌸 またいつでも声をかけてね💖' });
        }
        logToDb(userId, userMessage, '会員登録フローキャンセル', 'こころちゃん（登録フロー）', 'registration_cancel', true);
        return true;
    }

    switch (user.registrationStep) {
        case 'askingCategory':
            if (['小学生', '中学生～大学生', '成人'].includes(userMessage)) {
                await usersCollection.doc(userId).update({
                    category: userMessage,
                    registrationStep: 'askingName'
                });
                if (event.replyToken) {
                    await client.replyMessage(event.replyToken, { type: 'text', text: `ありがとう！${userMessage}さんだね🌸\n次に、あなたの**お名前**を教えてくれるかな？💖 (ニックネームでも大丈夫だよ)` });
                } else {
                    await safePushMessage(userId, { type: 'text', text: `ありがとう！${userMessage}さんだね！\n次に、あなたの**お名前**を教えてくれるかな？💖 (ニックネームでも大丈夫だよ)` });
                }
                handled = true;
            } else {
                if (event.replyToken) {
                    await client.replyMessage(event.replyToken, { type: 'text', text: 'ごめんね、区分は「小学生」「中学生～大学生」「成人」のいずれかで教えてくれるかな？💦' });
                } else {
                    await safePushMessage(userId, { type: 'text', text: 'ごめんね、区分は「小学生」「中学生～大学生」「成人」のいずれかで教えてくれるかな？💦' });
                }
                handled = true;
            }
            break;

        case 'askingName':
            if (userMessage.length > 0 && userMessage.length <= 20) {
                await usersCollection.doc(userId).update({
                    name: userMessage,
                    registrationStep: 'askingKana'
                });
                if (event.replyToken) {
                    await client.replyMessage(event.replyToken, { type: 'text', text: `ありがとう、${userMessage}さんだね！\n次に、あなたの**お名前のフリガナ（カタカナ）**を教えてくれるかな？🌸` });
                } else {
                    await safePushMessage(userId, { type: 'text', text: `ありがとう、${userMessage}さんだね！\n次に、あなたの**お名前のフリガナ（カタカナ）**を教えてくれるかな？🌸` });
                }
                handled = true;
            } else {
                if (event.replyToken) {
                    await client.replyMessage(event.replyToken, { type: 'text', text: 'ごめんね、お名前は20文字以内で教えてくれるかな？💖' });
                } else {
                    await safePushMessage(userId, { type: 'text', text: 'ごめんね、お名前は20文字以内で教えてくれるかな？💖' });
                }
                handled = true;
            }
            break;

        case 'askingKana':
            if (userMessage.match(/^[ァ-ヶー]+$/)) {
                await usersCollection.doc(userId).update({
                    kana: userMessage,
                    registrationStep: 'askingAge'
                });
                if (event.replyToken) {
                    await client.replyMessage(event.replyToken, { type: 'text', text: `ありがとう！フリガナもわかったよ🌸\n次に、あなたの**年齢**を教えてくれるかな？💖 (例: 15歳)` });
                } else {
                    await safePushMessage(userId, { type: 'text', text: `ありがとう！フリガナもわかったよ🌸\n次に、あなたの**年齢**を教えてくれるかな？💖 (例: 15歳)` });
                }
                handled = true;
            } else {
                if (event.replyToken) {
                    await client.replyMessage(event.replyToken, { type: 'text', text: 'ごめんね、フリガナはカタカナで教えてくれるかな？💦' });
                } else {
                    await safePushMessage(userId, { type: 'text', text: 'ごめんね、フリガナはカタカナで教えてくれるかな？💦' });
                }
                handled = true;
            }
            break;
        case 'askingAge':
            const age = parseInt(userMessage, 10);
            if (!isNaN(age) && age >= 0 && age <= 120) {
                await usersCollection.doc(userId).update({
                    age: age,
                    registrationStep: (user.category === '小学生' || user.category === '中学生～大学生') ? 'askingGuardianName' : 'askingPhoneNumber'
                });
                if (event.replyToken) {
                    if (user.category === '小学生' || user.category === '中学生～大学生') {
                        await client.replyMessage(event.replyToken, { type: 'text', text: `ありがとう、${age}歳だね！\n次に、**保護者の方のお名前**を教えてくれるかな？🌸 (フルネームでお願いします)` });
                    } else {
                        await client.replyMessage(event.replyToken, { type: 'text', text: `ありがとう、${age}歳だね！\n次に、あなたの**電話番号**を教えてくれるかな？💖 (例: 09012345678)` });
                    }
                } else {
                    if (user.category === '小学生' || user.category === '中学生～大学生') {
                        await safePushMessage(userId, { type: 'text', text: `ありがとう、${age}歳だね！\n次に、**保護者の方のお名前**を教えてくれるかな？🌸 (フルネームでお願いします)` });
                    } else {
                        await safePushMessage(userId, { type: 'text', text: `ありがとう、${age}歳だね！\n次に、あなたの**電話番号**を教えてくれるかな？💖 (例: 09012345678)` });
                    }
                }
                handled = true;
            } else {
                if (event.replyToken) {
                    await client.replyMessage(event.replyToken, { type: 'text', text: 'ごめんね、年齢は数字で教えてくれるかな？💦 (例: 15)' });
                } else {
                    await safePushMessage(userId, { type: 'text', text: 'ごめんね、年齢は数字で教えてくれるかな？💦 (例: 15)' });
                }
                handled = true;
            }
            break;

        case 'askingGuardianName':
            if (userMessage.length > 0 && userMessage.length <= 30) {
                await usersCollection.doc(userId).update({
                    guardianName: userMessage,
                    registrationStep: 'askingGuardianPhoneNumber'
                });
                if (event.replyToken) {
                    await client.replyMessage(event.replyToken, { type: 'text', text: `ありがとう、${userMessage}さんだね！\n次に、**保護者の方の電話番号**を教えてくれるかな？🌸 (例: 09012345678)` });
                } else {
                    await safePushMessage(userId, { type: 'text', text: `ありがとう、${userMessage}さんだね！\n次に、**保護者の方の電話番号**を教えてくれるかな？🌸 (例: 09012345678)` });
                }
                handled = true;
            } else {
                if (event.replyToken) {
                    await client.replyMessage(event.replyToken, { type: 'text', text: 'ごめんね、保護者の方のお名前は30文字以内で教えてくれるかな？💖' });
                } else {
                    await safePushMessage(userId, { type: 'text', text: 'ごめんね、保護者の方のお名前は30文字以内で教えてくれるかな？💖' });
                }
                handled = true;
            }
            break;

        case 'askingGuardianPhoneNumber':
            if (userMessage.match(/^0\d{9,10}$/)) {
                await usersCollection.doc(userId).update({
                    guardianPhoneNumber: userMessage,
                    registrationStep: 'askingAddressCity'
                });
                if (event.replyToken) {
                    await client.replyMessage(event.replyToken, { type: 'text', text: `ありがとう！保護者の方の電話番号もわかったよ🌸\n次に、あなたの**お住まいの市町村**を教えてくれるかな？💖 (例: 多摩市)` });
                } else {
                    await safePushMessage(userId, { type: 'text', text: `ありがとう！保護者の方の電話番号もわかったよ🌸\n次に、あなたの**お住まいの市町村**を教えてくれるかな？💖 (例: 多摩市)` });
                }
                handled = true;
            } else {
                if (event.replyToken) {
                    await client.replyMessage(event.replyToken, { type: 'text', text: 'ごめんね、電話番号は半角数字で、市外局番から正確に教えてくれるかな？💦 (例: 09012345678)\n登録をやり直す場合は「登録やめる」と入力してね。' });
                } else {
                    await safePushMessage(userId, { type: 'text', text: 'ごめんね、電話番号は半角数字で、市外局番から正確に教えてくれるかな？💦 (例: 09012345678)\n登録をやり直す場合は「登録やめる」と入力してね。' });
                }
                handled = true;
            }
            break;

        case 'askingPhoneNumber':
            if (userMessage.match(/^0\d{9,10}$/)) {
                await usersCollection.doc(userId).update({
                    phoneNumber: userMessage,
                    registrationStep: 'askingAddressCity'
                });
                if (event.replyToken) {
                    await client.replyMessage(event.replyToken, { type: 'text', text: `ありがとう！電話番号もわかったよ🌸\n次に、あなたの**お住まいの市町村**を教えてくれるかな？💖 (例: 多摩市)` });
                } else {
                    await safePushMessage(userId, { type: 'text', text: `ありがとう！電話番号もわかったよ🌸\n次に、あなたの**お住まいの市町村**を教えてくれるかな？💖 (例: 多摩市)` });
                }
                handled = true;
            } else {
                if (event.replyToken) {
                    await client.replyMessage(event.replyToken, { type: 'text', text: 'ごめんね、電話番号は半角数字で、市外局番から正確に教えてくれるかな？💦 (例: 09012345678)\n登録をやり直す場合は「登録やめる」と入力してね。' });
                } else {
                    await safePushMessage(userId, { type: 'text', text: 'ごめんね、電話番号は半角数字で、市外局番から正確に教えてくれるかな？💦 (例: 09012345678)\n登録をやり直す場合は「登録やめる」と入力してね。' });
                }
                handled = true;
            }
            break;

        case 'askingAddressCity':
            if (userMessage.length > 0 && userMessage.length <= 20) {
                await usersCollection.doc(userId).update({
                    'address.city': userMessage,
                    registrationStep: 'askingConsent'
                });
                if (event.replyToken) {
                    await client.replyMessage(event.replyToken, { type: 'text', text: `ありがとう、${userMessage}だね！\n最後に、**NPO法人コネクトの活動内容とプライバシーポリシーに同意**してくれるかな？\n同意する？しない？🌸` });
                } else {
                    await safePushMessage(userId, { type: 'text', text: `ありがとう、${userMessage}だね！\n最後に、**NPO法人コネクトの活動内容とプライバシーポリシーに同意**してくれるかな？\n同意する？しない？🌸` });
                }
                handled = true;
            } else {
                if (event.replyToken) {
                    await client.replyMessage(event.replyToken, { type: 'text', text: 'ごめんね、市町村名は20文字以内で教えてくれるかな？💖' });
                } else {
                    await safePushMessage(userId, { type: 'text', text: 'ごめんね、市町村名は20文字以内で教えてくれるかな？💖' });
                }
                handled = true;
            }
            break;

        case 'askingConsent':
            if (lowerUserMessage === '同意する' || lowerUserMessage === '同意') {
                if (user.category === '中学生～大学生') {
                    const prefilledFormUrl = `${STUDENT_MIDDLE_HIGH_UNI_FORM_URL}?${STUDENT_ID_FORM_LINE_USER_ID_ENTRY_ID}=${userId}`;
                    await usersCollection.doc(userId).update({
                        consentObtained: true,
                        registrationStep: null,
                        completedRegistration: true,
                        membershipType: "free"
                    });
                    if (event.replyToken) {
                        await client.replyMessage(event.replyToken, {
                            type: 'flex',
                            altText: '学生証提出のお願い',
                            contents: {
                                type: 'bubble',
                                body: {
                                    type: 'box',
                                    layout: 'vertical',
                                    contents: [
                                        { type: 'text', text: 'ありがとう！同意してくれて嬉しいな🌸\n学生会員として登録が完了したよ！', wrap: true },
                                        { type: 'text', text: '学生証の提出にご協力ください💖\n（下のボタンからフォームへ進んでね！）', wrap: true, margin: 'md' },
                                        { type: 'button', style: 'primary', height: 'sm', action: { type: 'uri', label: '学生証提出フォームへ', uri: prefilledFormUrl }, margin: 'md', color: '#FFB6C1' }
                                    ]
                                }
                            }
                        });
                    } else {
                        await safePushMessage(userId, {
                            type: 'flex',
                            altText: '学生証提出のお願い',
                            contents: {
                                type: 'bubble',
                                body: {
                                    type: 'box',
                                    layout: 'vertical',
                                    contents: [
                                        { type: 'text', text: 'ありがとう！同意してくれて嬉しいな🌸\n学生会員として登録が完了したよ！', wrap: true },
                                        { type: 'text', text: '学生証の提出にご協力ください💖\n（下のボタンからフォームへ進んでね！）', wrap: true, margin: 'md' },
                                        { type: 'button', style: 'primary', height: 'sm', action: { type: 'uri', label: '学生証提出フォームへ', uri: prefilledFormUrl }, margin: 'md', color: '#FFB6C1' }
                                    ]
                                }
                            }
                        });
                    }
                } else { // 小学生、成人など、学生証提出が不要な場合
                    await usersCollection.doc(userId).update({
                        consentObtained: true,
                        registrationStep: null,
                        completedRegistration: true,
                        membershipType: "free" // または適切な初期会員タイプ
                    });
                    if (event.replyToken) {
                        await client.replyMessage(event.replyToken, { type: 'text', text: 'ありがとう！同意してくれて嬉しいな🌸\nこれで会員登録が完了したよ！いつでもお話ししてね💖' });
                    } else {
                        await safePushMessage(userId, { type: 'text', text: 'ありがとう！同意してくれて嬉しいな🌸\nこれで会員登録が完了したよ！いつでもお話ししてね💖' });
                    }
                }
                handled = true;
            } else if (lowerUserMessage.includes('同意しない') || lowerUserMessage.includes('しない')) {
                await usersCollection.doc(userId).update({
                    consentObtained: false,
                    registrationStep: null,
                    completedRegistration: false
                });
                if (event.replyToken) {
                    await client.replyMessage(event.replyToken, { type: 'text', text: 'そっか、同意しないんだね。会員登録は完了できないけど、いつでもお話しできるからね🌸' });
                } else {
                    await safePushMessage(userId, { type: 'text', text: 'そっか、同意しないんだね。会員登録は完了できないけど、いつでもお話しできるからね🌸' });
                }
                handled = true;
            } else {
                if (event.replyToken) {
                    await client.replyMessage(event.replyToken, { type: 'text', text: 'ごめんね、「同意する」か「同意しない」で教えてくれるかな？💦' });
                } else {
                    await safePushMessage(userId, { type: 'text', text: 'ごめんね、「同意する」か「同意しない」で教えてくれるかな？💦' });
                }
                handled = true;
            }
            break;

        case 'askingStudentIdPhoto':
            if (event.type === 'message' && event.message.type === 'image') {
                const messageId = event.message.id;
                const lineContent = await client.getMessageContent(messageId);
                const buffer = [];
                for await (const chunk of lineContent) {
                    buffer.push(chunk);
                }
                const imageBuffer = Buffer.concat(buffer);

                const fileName = `student_id/${userId}_${Date.now()}.jpg`;
                const fileRef = admin.storage().bucket().file(fileName);
                await fileRef.save(imageBuffer, { contentType: 'image/jpeg' });

                const publicUrl = await fileRef.getSignedUrl({
                    action: 'read',
                    expires: '03-09-2491',
                });

                await usersCollection.doc(userId).update({
                    studentIdPhotoUrl: publicUrl[0],
                    registrationStep: null,
                    studentIdVerified: false,
                    completedRegistration: true
                });
                if (event.replyToken) {
                    await client.replyMessage(event.replyToken, { type: 'text', text: '学生証の写真を送ってくれてありがとう！確認するね🌸\nこれで会員登録が完了したよ！いつでもお話ししてね💖' });
                } else {
                    await safePushMessage(userId, { type: 'text', text: '学生証の写真を送ってくれてありがとう！確認するね🌸\nこれで会員登録が完了したよ！いつでもお話ししてね💖' });
                }
                handled = true;
            } else {
                if (event.replyToken) {
                    await client.replyMessage(event.replyToken, { type: 'text', text: 'ごめんね、学生証の写真を送ってくれるかな？💦' });
                } else {
                    await safePushMessage(userId, { type: 'text', text: 'ごめんね、学生証の写真を送ってくれるかな？💦' });
                }
                handled = true;
            }
            break;

        default:
            handled = false;
            break;
    }
    return handled;
}

// ⭐handleWatchServiceRegistration関数をここに定義します⭐
async function handleWatchServiceRegistration(event, userId, userMessage, user) {
    const usersCollection = db.collection("users");

    const lowerUserMessage = userMessage.toLowerCase();
    let handled = false;

    if (['登録やめる', 'やめる', 'キャンセル', 'やめたい'].includes(lowerUserMessage) && user.registrationStep === 'awaiting_contact_form') {
        await usersCollection.doc(userId).update({ registrationStep: null, tempRegistrationData: {} });
        if (event.replyToken) {
            await client.replyMessage(event.replyToken, { type: 'text', text: '見守りサービス登録をキャンセルしたよ🌸 またいつでも声をかけてね💖' });
        } else {
            await safePushMessage(userId, { type: 'text', text: '見守りサービス登録をキャンセルしたよ🌸 またいつでも声をかけてね💖' });
        }
        logToDb(userId, userMessage, '見守りサービス登録キャンセル', 'こころちゃん（見守り登録）', 'watch_service_cancel', true);
        return true;
    }

    const currentUserConfig = MEMBERSHIP_CONFIG[user.membershipType] || MEMBERSHIP_CONFIG["guest"];
    if (!currentUserConfig.canUseWatchService) {
        if (event.replyToken) {
            await client.replyMessage(event.replyToken, { type: 'text', text: `ごめんね💦 あなたの会員タイプ（${user.membershipType}）では、見守りサービスはまだ使えないんだ🌸 見守りサービスは無料会員、寄付会員、サブスク会員の方が利用できるよ。` });
        } else {
            await safePushMessage(userId, { type: 'text', text: `ごめんね💦 あなたの会員タイプ（${user.membershipType}）では、見守りサービスはまだ使えないんだ🌸 見守りサービスは無料会員、寄付会員、サブスク会員の方が利用できるよ。` });
        }
        logToDb(userId, userMessage, `見守りサービス利用不可`, 'こころちゃん（見守り案内）', 'watch_service_not_available', true);
        return true;
    }

    if (user.category && (user.category === '小学生' || user.category === '中学生～大学生') && !lowerUserMessage.includes('一人暮らし')) {
        const replyText = `ごめんね、見守りサービスは主に30代以上の一人暮らしの方を対象としているんだ💦\n高校生や大学生で一人暮らしをしていて不安な場合は、特別な相談もできるから教えてね。もし、いじめや詐欺のことで困っていたら、いつでも話を聞くよ🌸`;
        if (event.replyToken) {
            await client.replyMessage(event.replyToken, { type: 'text', text: replyText });
        } else {
            await safePushMessage(userId, { type: 'text', text: replyText });
        }
        logToDb(userId, userMessage, replyText, 'こころちゃん（見守り対象外）', 'watch_service_category_denied', true);
        return true;
    }

    if (["見守り", "みまもり", "見守りサービス", "みまもりサービス"].includes(lowerUserMessage) && event.type === 'message' && event.message.type === 'text') {
        try {
            const prefilledFormUrl = `${WATCH_SERVICE_FORM_BASE_URL}?${WATCH_SERVICE_FORM_LINE_USER_ID_ENTRY_ID}=${userId}`;
            const watchServiceGuideFlexWithUriButton = {
                "type": "bubble",
                "body": {
                    "type": "box",
                    "layout": "vertical",
                    "contents": [
                        { "type": "text", "text": "💖見守りサービス案内💖", "weight": "bold", "color": "#FF69B4", "size": "lg" },
                        { "type": "text", "text": "💖こころちゃんが、LINEであなたの毎日をそっと見守ります💖\n\nこのサービスは、こころちゃんが定期的に安否確認のメッセージをお送りし、万が一の際にはご登録の緊急連絡先へご連絡するものです🌸あなたの安心と笑顔のために、以下の必要事項をご記入ください。", "wrap": true, "margin": "md", "size": "sm" }
                    ]
                },
                "footer": {
                    "type": "box",
                    "layout": "vertical",
                    "spacing": "sm",
                    "contents": [
                        { "type": "button", "style": "primary", "height": "sm", "action": { "type": "uri", "label": "見守り登録する", "uri": prefilledFormUrl }, "color": "#d63384" },
                        { "type": "button", "style": "secondary", "height": "sm", "action": { "type": "postback", "label": "見守りを解除する", "data": "action=watch_unregister" }, "color": "#808080" }
                    ]
                }
            };

            await client.replyMessage(event.replyToken, {
                type: 'flex',
                altText: '💖見守りサービス案内💖',
                contents: watchServiceGuideFlexWithUriButton
            });
            logToDb(userId, userMessage, '（見守りサービス案内Flex表示）', 'こころちゃん（見守り案内）', 'watch_service_interaction', true);
            return true;
        } catch (error) {
            console.error("❌ 見守りサービス案内Flex送信エラー:", error.message);
            logErrorToDb(userId, "見守りサービス案内Flex送信エラー", { error: error.message, userId: userId });
            return false;
        }
    }

    if (lowerUserMessage.includes("元気だよ！") || lowerUserMessage.includes("okだよ") || lowerUserMessage.includes("ok") || lowerUserMessage.includes("オーケー") || lowerUserMessage.includes("大丈夫")) {
        if (user && user.wantsWatchCheck && user.scheduledMessageSent) {
            try {
                await usersCollection.doc(userId).update(
                    { lastOkResponse: admin.firestore.FieldValue.serverTimestamp(), scheduledMessageSent: false, firstReminderSent: false, secondReminderSent: false, thirdReminderSent: false }
                );
                if (event.replyToken) {
                    await client.replyMessage(event.replyToken, {
                        type: 'text',
                        text: 'ありがとう🌸 元気そうで安心したよ💖 またね！'
                    });
                } else {
                    await safePushMessage(userId, {
                        type: 'text',
                        text: 'ありがとう🌸 元気そうで安心したよ💖 またね！'
                    });
                }
                logToDb(userId, userMessage, 'ありがとう🌸 元気そうで安心したよ💖 またね！', 'こころちゃん（見守り応答）', 'watch_service_ok_response', true);
                return true;
            } catch (error) {
                console.error("❌ 見守りサービスOK応答処理エラー:", error.message);
                logErrorToDb(userId, "見守りサービスOK応答処理エラー", { error: error.message, userId: userId });
                return false;
            }
        }
        return false;
    }

    if (lowerUserMessage.includes("まあまあかな")) {
        if (user && user.wantsWatchCheck && user.scheduledMessageSent) {
            try {
                if (event.replyToken) {
                    await client.replyMessage(event.replyToken, {
                        type: 'text',
                        text: 'そうだね、まあまあな日もあるよね🌸 焦らず、あなたのペースで過ごしてね💖'
                    });
                } else {
                    await safePushMessage(userId, {
                        type: 'text',
                        text: 'そうだね、まあまあな日もあるよね🌸 焦らず、あなたのペースで過ごしてね💖'
                    });
                }
                logToDb(userId, userMessage, 'そうだね、まあまあな日もあるよね🌸 焦らず、あなたのペースで過ごしてね💖', 'こころちゃん（見守り応答）', 'watch_service_status_somewhat', true);
                return true;
            } catch (error) {
                console.error("❌ 見守りサービス「まあまあ」応答処理エラー:", error.message);
                logErrorToDb(userId, "見守りサービス「まあまあ」応答処理エラー", { error: error.message, userId: userId });
                return false;
            }
        }
        return false;
    }

    if (lowerUserMessage.includes("少し疲れた…")) {
        if (user && user.wantsWatchCheck && user.scheduledMessageSent) {
            try {
                if (event.replyToken) {
                    await client.replyMessage(event.replyToken, {
                        type: 'text',
                        text: '大変だったね、疲れてしまったんだね…💦 無理しないで休んでね。こころはいつでもあなたの味方だよ💖'
                    });
                } else {
                    await safePushMessage(userId, {
                        type: 'text',
                        text: '大変だったね、疲れてしまったんだね！💦 無理しないで休んでね。こころはいつでもあなたの味方だよ💖'
                    });
                }
                logToDb(userId, userMessage, '大変だったね、疲れてしまったんだね！💦 無理しないで休んでね。こころはいつでもあなたの味方だよ💖', 'こころちゃん（見守り応答）', 'watch_service_status_tired', true);
                return true;
            } catch (error) {
                console.error("❌ 見守りサービス「疲れた」応答処理エラー:", error.message);
                logErrorToDb(userId, "見守りサービス「疲れた」応答処理エラー", { error: error.message, userId: userId });
                return false;
            }
        }
        return false;
    }

    if (lowerUserMessage.includes("話を聞いて")) {
        if (user && user.wantsWatchCheck && user.scheduledMessageSent) {
            try {
                if (event.replyToken) {
                    await client.replyMessage(event.replyToken, {
                        type: 'text',
                        text: 'うん、いつでも聞くよ🌸 何か話したいことがあったら、いつでも話してね💖'
                    });
                } else {
                    await safePushMessage(userId, {
                        type: 'text',
                        text: 'うん、いつでも聞くよ🌸 何か話したいことがあったら、いつでも話してね💖'
                    });
                }
                logToDb(userId, userMessage, 'うん、いつでも聞くよ🌸 何か話したいことがあったら、いつでも話してね💖', 'こころちゃん（見守り応答）', 'watch_service_status_talk', true);
                return true;
            } catch (error) {
                console.error("❌ 見守りサービス「話を聞いて」応答処理エラー:", error.message);
                logErrorToDb(userId, "見守りサービス「話を聞いて」応答処理エラー", { error: error.message, userId: userId });
                return false;
            }
        }
        return false;
    }

    if (event.type === 'postback' && event.postback.data === 'action=watch_register') {
        if (user && user.wantsWatchCheck) {
            await client.replyMessage(event.replyToken, {
                type: 'text',
                text: 'もう見守りサービスに登録済みだよ🌸 いつもありがとう💖'
            });
            logToDb(userId, userMessage, '見守りサービス登録済み', 'こころちゃん（見守り登録）', 'watch_service_already_registered', true);
            return true;
        } else if (user && user.registrationStep === 'awaiting_contact_form') {
            await client.replyMessage(event.replyToken, {
                type: 'text',
                text: 'まだ緊急連絡先フォームの入力を待ってるよ🌸 フォームを完了してくれるかな？💖'
            });
            return true;
        } else {
            const prefilledFormUrl = `${WATCH_SERVICE_FORM_BASE_URL}?${WATCH_SERVICE_FORM_LINE_USER_ID_ENTRY_ID}=${userId}`;
            await client.replyMessage(event.replyToken, {
                type: 'flex',
                altText: '緊急連絡先登録のご案内',
                contents: {
                    type: 'bubble',
                    body: {
                        type: 'box',
                        layout: 'vertical',
                        contents: [
                            { type: 'text', text: '💖緊急連絡先登録💖', weight: 'bold', size: 'lg', color: "#FF69B4", align: 'center' },
                            { type: 'text', text: '安全のために、緊急連絡先を登録してね！', wrap: true, margin: 'md' },
                            { type: 'button', style: "primary", height: "sm", action: { type: "uri", label: "緊急連絡先を登録する", uri: prefilledFormUrl }, margin: "md", color: "#d63384" }
                        ]
                    }
                }
            });
            await usersCollection.doc(userId).update({
                registrationStep: 'awaiting_contact_form'
            });
            logToDb(userId, userMessage, '緊急連絡先フォームを案内しました。', 'こころちゃん（見守り登録開始）', 'watch_service_registration_start', true);
            return true;
        }
    }

    if (lowerUserMessage === '解除' || lowerUserMessage === 'かいじょ' || (event.type === 'postback' && event.postback.data === 'action=watch_unregister')) {
        if (user && user.wantsWatchCheck) {
            try {
                await usersCollection.doc(userId).update({ wantsWatchCheck: false, emergencyContact: null, scheduledMessageSent: false, firstReminderSent: false, secondReminderSent: false, thirdReminderSent: false });
                if (event.replyToken) {
                    await client.replyMessage(event.replyToken, { type: 'text', text: '見守りサービスを解除したよ🌸 またいつでも登録してね💖' });
                } else {
                    await safePushMessage(userId, { type: 'text', text: '見守りサービスを解除したよ🌸 またいつでも登録してね💖' });
                }
                logToDb(userId, userMessage, '見守りサービスを解除しました。', 'こころちゃん（見守り解除）', 'watch_service_unregistered', true);
                return true;
            } catch (error) {
                console.error("❌ 見守りサービス解除処理エラー:", error.message);
                logErrorToDb(userId, "見守りサービス解除処理エラー", { error: error.message, userId: userId });
                return false;
            }
        } else {
            if (event.replyToken) {
                await client.replyMessage(event.replyToken, { type: 'text', text: '見守りサービスは登録されていないみたいだよ🌸 登録したい場合は「見守り」と話しかけてみてね💖' });
            } else {
                await safePushMessage(userId, { type: 'text', text: '見守りサービスは登録されていないみたいだよ🌸 登録したい場合は「見守り」と話しかけてみてね💖' });
            }
            return true;
        }
    }
    return false; // どの見守り関連ロジックにも該当しない場合はfalseを返す
}


// --- 定期見守りメッセージ送信 Cronジョブ (毎日15時にトリガー) ---
cron.schedule('0 15 * * *', () => {
    console.log('cron: 定期見守りメッセージ送信処理をトリガーします。');
    sendScheduledWatchMessage();
}, {
    timezone: "Asia/Tokyo"
});

/**
 * 見守りサービス利用者への定期メッセージ送信と未応答時の緊急連絡通知
 */
async function sendScheduledWatchMessage() {
    const usersCollection = db.collection('users');
    const now = admin.firestore.Timestamp.now();
    const threeDaysAgo = new Date(now.toDate().getTime() - 3 * 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(now.toDate().getTime() - 7 * 24 * 60 * 60 * 1000);
    const fourteenDaysAgo = new Date(now.toDate().getTime() - 14 * 24 * 60 * 60 * 1000);
    const twentyNineHoursAgo = new Date(now.toDate().getTime() - 29 * 60 * 60 * 1000);

    try {
        const snapshot = await usersCollection
            .where('wantsWatchCheck', '==', true)
            .get();

        for (const doc of snapshot.docs) {
            const user = doc.data();
            const userId = doc.id;
            const lastOkResponse = user.lastOkResponse ? user.lastOkResponse.toDate() : user.createdAt.toDate();

            let notificationNeeded = false;
            let notificationType = '';
            let reminderMessage = '';
            let updateData = {};

            // 29時間返信なし（初回リマインダー）
            if (!user.firstReminderSent && lastOkResponse < twentyNineHoursAgo) {
                reminderMessage = "こころちゃんだよ🌸\n元気にしてるかな？\nもしかして、忙しいのかな？\n短い時間でいいから、一言「OKだよ💖」って教えてくれると安心するな😊";
                updateData.firstReminderSent = true;
                console.log(`ユーザー ${userId}: 29時間経過 - 初回リマインダーを送信`);
                await safePushMessage(userId, { type: 'text', text: reminderMessage });
                logToDb(userId, `（29時間未応答リマインダー）`, reminderMessage, 'こころちゃん（見守り）', 'watch_service_reminder_29h', true);
            }
            // 3日（72時間）返信なし（定期見守りメッセージ or リマインダー）
            else if (lastOkResponse < threeDaysAgo && !user.scheduledMessageSent) {
                const randomMessage = watchMessages[Math.floor(Math.random() * watchMessages.length)];
                // ⭐修正: 見守り応答もgetAIModelForUser関数を使い、ユーザーの会員タイプとメッセージ長でモデルを決定 ⭐
                const aiModelForWatch = getAIModelForUser(user, randomMessage); // ここでモデルを動的に選択
                const aiReply = await (aiModelForWatch.startsWith("gpt") ? generateGPTReply(randomMessage, aiModelForWatch, userId, user) : generateGeminiReply(randomMessage, aiModelForWatch, userId, user));

                await safePushMessage(userId, { type: 'text', text: aiReply });
                updateData.scheduledMessageSent = true;
                console.log(`ユーザー ${userId}: 3日経過 - 定期見守りメッセージを送信 (モデル: ${aiModelForWatch})`);
                logToDb(userId, `（3日未応答定期見守り）`, aiReply, `こころちゃん（見守りAI: ${aiModelForWatch}）`, 'watch_service_scheduled_message', true);
            }
            // 7日返信なし（二回目のリマインダー）
            else if (lastOkResponse < sevenDaysAgo && !user.secondReminderSent) {
                reminderMessage = "こころちゃんだよ🌸\n最近、お話できてなくて少し心配してるんだ💦\n元気にしてるかな？\n何かあったら無理しないで、いつでも話してね。返信が難しい時でも、「OKだよ💖」って一言くれると嬉しいな😊";
                updateData.secondReminderSent = true;
                console.log(`ユーザー ${userId}: 7日経過 - 二回目のリマインダーを送信`);
                await safePushMessage(userId, { type: 'text', text: reminderMessage });
                logToDb(userId, `（7日未応答リマインダー）`, reminderMessage, 'こころちゃん（見守り）', 'watch_service_reminder_7d', true);
            }
            // 14日返信なし（最終リマインダー & 緊急連絡先への通知準備）
            else if (lastOkResponse < fourteenDaysAgo && !user.thirdReminderSent) {
                reminderMessage = "こころちゃんだよ🌸\nもう2週間も連絡がないから、とても心配だよ…💦\nもしもの時、あなたの安全を確認するために、ご家族や緊急連絡先にご連絡してもいいかな？\nすぐに「OKだよ💖」って返事くれると安心するんだけど…\nもし返事がなかったら、ご家族の方に連絡することになるからね。";
                updateData.thirdReminderSent = true;
                notificationNeeded = true;
                notificationType = '14日未応答';
                console.log(`ユーザー ${userId}: 14日経過 - 最終リマインダーを送信（緊急通知準備）`);
                await safePushMessage(userId, { type: 'text', text: reminderMessage });
                logToDb(userId, `（14日未応答リマインダー）`, reminderMessage, 'こころちゃん（見守り）', 'watch_service_reminder_14d', true);
            }

            // 更新が必要な場合はFirestoreを更新
            if (Object.keys(updateData).length > 0) {
                await usersCollection.doc(userId).update(updateData);
            }

            // 緊急通知が必要な場合
            if (notificationNeeded && (user.emergencyContact || user.guardianPhoneNumber)) {
                let emergencyNotificationMessage = `🚨【見守りサービス緊急通知】🚨\n\n`;

                emergencyNotificationMessage += `**ユーザーからの応答が${notificationType}ありません。**\n\n`;

                emergencyNotificationMessage += `👤 氏名: ${user.name || user.displayName || '不明'}\n`;
                if (user.phoneNumber) {
                    emergencyNotificationMessage += `📱 電話番号: ${user.phoneNumber}\n`;
                }

                if (user.category === '小学生' || user.category === '中学生～大学生') {
                    if (user.guardianName) {
                        emergencyNotificationMessage += `👨‍👩‍👧‍👦 保護者名: ${user.guardianName}\n`;
                    }
                    if (user.guardianPhoneNumber) {
                        emergencyNotificationMessage += `📞 緊急連絡先: ${user.guardianPhoneNumber}\n`;
                    }
                    emergencyNotificationMessage += `🧬 続柄: ${user.relationshipToEmergencyContact || '未登録'}\n`;
                } else if (user.emergencyContact) {
                    if (user.emergencyContactName) {
                        emergencyNotificationMessage += `👨‍👩‍👧‍👦 緊急連絡先 氏名: ${user.emergencyContactName}\n`;
                    }
                    emergencyNotificationMessage += `📞 緊急連絡先: ${user.emergencyContact}\n`;
                    emergencyNotificationMessage += `🧬 続柄: ${user.relationshipToEmergencyContact || '未登録'}\n`;
                }

                emergencyNotificationMessage += `\n**最終応答日時:** ${lastOkResponse.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}\n`;
                emergencyNotificationMessage += `\n**対応のお願い:**\n至急、ユーザー様へご連絡をお願いいたします。`;

                if (OFFICER_GROUP_ID) {
                    // ⭐修正: safePushMessageを呼び出すように変更 ⭐
                    await safePushMessage(OFFICER_GROUP_ID, { type: 'text', text: emergencyNotificationMessage });
                    logToDb(userId, `（見守り緊急通知）`, emergencyNotificationMessage, `こころちゃん（事務局通知）`, 'watch_service_emergency_notification', true);
                } else {
                    console.warn(`OFFICER_GROUP_IDが設定されていないため、見守り緊急通知は送信されませんでした。`);
                }
            }
        }
    } catch (error) {
        console.error('❌ 定期見守りメッセージ送信/通知処理エラー:', error);
        logErrorToDb(null, "定期見守りメッセージ/通知エラー", { error: error.message, stack: error.stack });
    }
}


// --- 月間メッセージカウントリセット Cronジョブ (毎月1日の午前0時) ---
cron.schedule('0 0 1 * *', async () => {
    console.log('✅ Monthly message count reset job started.');
    try {
        const usersCollection = db.collection('users');
        const result = await usersCollection.where('messageCount', '>', 0).get();
        const batch = db.batch();
        result.docs.forEach(doc => {
            const userRef = usersCollection.doc(doc.id);
            batch.update(userRef, { messageCount: 0, lastResetDate: admin.firestore.FieldValue.serverTimestamp() });
        });
        await batch.commit();
        console.log(`✅ ${result.docs.length} users' monthly message counts reset.`);
    } catch (error) {
        console.error('❌ Error resetting monthly message counts:', error);
        logErrorToDb(null, "月間メッセージカウントリセットエラー", { error: error.message, stack: error.stack });
    }
}, {
    timezone: "Asia/Tokyo"
});

// --- 不適切ワードカウントのリセット Cronジョブ (毎朝4時) ---
cron.schedule('0 4 * * *', async () => {
    console.log('✅ Inappropriate word count reset job started.');
    try {
        const usersCollection = db.collection('users');
        const result = await usersCollection.where('inappropriateWordCount', '>', 0).get();
        const batch = db.batch();
        result.docs.forEach(doc => {
            const userRef = usersCollection.doc(doc.id);
            batch.update(userRef, { inappropriateWordCount: 0, lastInappropriateResetDate: admin.firestore.FieldValue.serverTimestamp() });
        });
        await batch.commit();
        console.log(`✅ ${result.docs.length} users' inappropriate word counts reset.`);
    } catch (error) {
        console.error('❌ Error resetting inappropriate word counts:', error);
        logErrorToDb(null, "不適切ワードカウントリセットエラー", { error: error.message, stack: error.stack });
    }
}, {
    timezone: "Asia/Tokyo"
});

// --- 月間メッセージ上限が近づいた際の通知 Cronジョブ (毎日0時30分にトリガー) ---
// ⭐新規追加機能⭐
cron.schedule('30 0 * * *', async () => {
    console.log('cron: 月間メッセージ上限チェック処理をトリガーします。');
    const usersCollection = db.collection('users');
    const now = admin.firestore.Timestamp.now();

    try {
        // freeとsubscriberユーザーのみを対象
        const snapshot = await usersCollection
            .where('membershipType', 'in', ['free', 'subscriber'])
            .get();

        for (const doc of snapshot.docs) {
            const user = doc.data();
            const userId = doc.id;
            const userConfig = MEMBERSHIP_CONFIG[user.membershipType];

            if (!userConfig || userConfig.monthlyLimit === -1) {
                continue; // 制限のない会員タイプはスキップ
            }

            const currentMessageCount = user.messageCount || 0;
            const monthlyLimit = userConfig.monthlyLimit;
            const warningThreshold = monthlyLimit * 0.8; // 例: 上限の80%

            // 警告レベルに達していて、かつまだ警告通知を送っていない場合
            if (currentMessageCount >= warningThreshold && !user.monthlyLimitWarningSent) {
                const warningMessage = `🌸お知らせ🌸\n今月の会話回数が残り少なくなってきているみたいだよ💦\n現在の使用回数：${currentMessageCount}回 / 上限：${monthlyLimit}回\n\nもしもっとお話したい場合は、寄付会員へのアップグレードも検討してみてね💖\n（※寄付会員になると、回数制限なしで利用できるよ！）`;

                await safePushMessage(userId, { type: 'text', text: warningMessage });
                await usersCollection.doc(userId).update({ monthlyLimitWarningSent: true }); // 警告を送ったフラグを立てる
                console.log(`ユーザー ${userId}: 月間メッセージ上限警告を送信しました。`);
                logToDb(userId, `（月間メッセージ上限警告）`, warningMessage, 'こころちゃん（システム）', 'monthly_limit_warning', true);
            }
            // 月が替わってリセットされている場合は、警告フラグもリセット
            else if (user.monthlyLimitWarningSent && user.lastResetDate && user.lastResetDate.toDate().getMonth() !== now.toDate().getMonth()) {
                await usersCollection.doc(userId).update({ monthlyLimitWarningSent: false });
            }
        }
    } catch (error) {
        console.error('❌ 月間メッセージ上限チェック処理エラー:', error);
        logErrorToDb(null, "月間メッセージ上限チェックエラー", { error: error.message, stack: error.stack });
    }
}, {
    timezone: "Asia/Tokyo"
});

// --- LINE Webhook ハンドラ ---
app.post('/webhook', async (req, res) => {
    // Webhookの応答をすぐに返す
    res.status(200).send('OK');

    const events = req.body.events;
    if (!events || events.length === 0) {
        console.log("No events received.");
        return;
    }

    const usersCollection = db.collection("users");
    const messagesCollection = db.collection("logs");

    events.forEach(async event => {
        if (!event.source || !event.source.userId) {
            console.warn("Event has no userId, skipping:", event);
            return;
        }
        const userId = event.source.userId;

        if (event.source.type === 'group') {
            const currentGroupId = event.source.groupId;
            console.log(`💡 現在のグループからのイベント - グループID: ${currentGroupId}`);
        }

        let userDoc;
        try {
            userDoc = await usersCollection.doc(userId).get();
        } catch (dbError) {
            console.error(`❌ Firestoreユーザーデータ取得エラー (${userId}):`, dbError.message);
            logErrorToDb(userId, `Firestoreユーザーデータ取得エラー`, { error: dbError.message, stack: dbError.stack });
            return;
        }

        let user = userDoc.exists ? userDoc.data() : null;

        if (!user) {
            const displayName = await getUserDisplayName(userId);
            user = {
                userId: userId,
                displayName: displayName,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                lastMessageAt: admin.firestore.FieldValue.serverTimestamp(),
                messageCount: 0,
                lastResetDate: admin.firestore.FieldValue.serverTimestamp(),
                inappropriateWordCount: 0,
                lastInappropriateResetDate: admin.firestore.FieldValue.serverTimestamp(),
                isBlocked: false,
                wantsWatchCheck: false,
                emergencyContact: null,
                emergencyContactName: null,
                relationshipToEmergencyContact: null,
                lastOkResponse: null,
                scheduledMessageSent: false,
                firstReminderSent: false,
                secondReminderSent: false,
                thirdReminderSent: false,
                registrationStep: null,
                tempRegistrationData: {},
                membershipType: "guest",
                completedRegistration: false,
                category: null, name: null, kana: null, age: null,
                phoneNumber: null, address: { city: null },
                guardianName: null, guardianPhoneNumber: null,
                consentObtained: false,
                studentIdPhotoUrl: null, studentIdVerified: false,
                useProForNextConsultation: false,
                flagged: false,
                suspendUntil: null,
                rateLimitRemaining: null,
                lastRateLimitReset: null,
                monthlyLimitWarningSent: false, // ⭐ 新規追加: 月間制限警告フラグ ⭐
            };
            try {
                await usersCollection.doc(userId).set(user);
                console.log(`✅ 新規ユーザー登録: ${userId} (${displayName}) as guest.`);
            } catch (dbError) {
                console.error(`❌ Firestore新規ユーザー登録エラー (${userId}):`, dbError.message);
                logErrorToDb(userId, `Firestore新規ユーザー登録エラー`, { error: dbError.message, stack: dbError.stack });
                return;
            }

            if (event.type === 'follow') {
                try {
                    await safePushMessage(userId, {
                        type: 'text',
                        text: 'はじめまして！わたしは皆守こころです🌸 あなたのお話、聞かせてね💖\n\n「見守りサービス」も提供しているから、興味があったら「見守り」って話しかけてみてね😊\n\nまずは会員登録から始めてみようかな？「会員登録」と話しかけてみてね！'
                    });
                    logToDb(userId, `（新規フォロー）`, `はじめましてメッセージ`, 'こころちゃん（新規フォロー）', 'system_follow', true);
                } catch (error) {
                    console.error("❌ フォローメッセージ送信エラー:", error.message);
                    logErrorToDb(userId, "フォローメッセージ送信エラー", { error: error.message, userId: userId });
                }
            }
            return;
        } else {
            // ⭐修正: BotAdminはカウントしない ⭐
            if (!isBotAdmin(userId)) {
                try {
                    await usersCollection.doc(userId).update({
                        lastMessageAt: admin.firestore.FieldValue.serverTimestamp(),
                        messageCount: admin.firestore.FieldValue.increment(1)
                    });
                    user.messageCount = (user.messageCount || 0) + 1;
                } catch (dbError) {
                    console.error(`❌ Firestoreユーザーデータ更新エラー (${userId}):`, dbError.message);
                    logErrorToDb(userId, `Firestoreユーザーデータ更新エラー`, { error: dbError.message, stack: dbError.stack });
                    return;
                }
            }
        }

        if (user.isBlocked) {
            console.log(`ユーザー ${userId} はブロックされているため、処理をスキップします。`);
            return;
        }

        const currentMembershipType = isBotAdmin(userId) ? "admin" : (user.membershipType || "guest");
        const userConfig = MEMBERSHIP_CONFIG[currentMembershipType] || MEMBERSHIP_CONFIG["guest"];

        if (user.suspendUntil && user.suspendUntil.toDate() > new Date()) {
            const timeLeft = Math.ceil((user.suspendUntil.toDate() - new Date()) / (1000 * 60));
            await safePushMessage(userId, { type: 'text', text: `ごめんなさい、現在あなたは${timeLeft}分間サービスのご利用が制限されています。再度お試しください。` });
            logToDb(userId, event.type === 'message' ? event.message.text : '(システム)', `サービス利用制限中`, 'システム（制限）', 'user_suspended', true);
            return;
        }

        if (event.type === 'unfollow') {
            try {
                await usersCollection.doc(userId).update({ isBlocked: true });
                console.log(`ユーザー ${userId} がブロックしました。`);
            } catch (dbError) {
                console.error(`❌ Firestoreブロック状態更新エラー (${userId}):`, dbError.message);
                logErrorToDb(userId, `Firestoreブロック状態更新エラー`, { error: dbError.message, stack: dbError.stack });
            }
            return;
        }

        if (event.type === 'message' && event.message.type === 'text') {
            const replyToken = event.replyToken;
            const userMessage = event.message.text;
            const lowerUserMessage = userMessage.toLowerCase();

            let handledByLogic = false;
            let responseMessages = [];
            let logDetails = {
                responsedBy: 'こころちゃん（AI応答）',
                logType: 'normal_conversation',
                isFlagged: false
            };

            // ⭐ユーザー数・トークン制限の防止策（任意）のデモ - 管理者以外に適用 ⭐
            // このブロックは必要に応じてコメントアウトまたは削除してください。
            // if (!isBotAdmin(userId) && user.messageCount > 100) { // 例: 100回以上の会話で制限
            //     await client.replyMessage(replyToken, {
            //         type: "text",
            //         text: "今日はもうたくさんお話ししましたね🌸 また明日、元気にお話ししましょう！"
            //     });
            //     logToDb(userId, userMessage, `（会話回数制限）`, 'こころちゃん（制限）', 'daily_limit_reached', true);
            //     return;
            // }

            // ===============================================
            // 優先度の高いコマンド処理
            // ===============================================

            // 1. 管理者コマンド (最優先)
            if (isBotAdmin(userId) && lowerUserMessage.startsWith('admin:')) {
                const command = lowerUserMessage.substring(6).trim();
                if (command === 'status') {
                    responseMessages.push({ type: 'text', text: `こころちゃんは元気だよ！LINEイベントを受信中。\n現在のあなたの会員タイプ: ${currentMembershipType}` });
                    logDetails.logType = 'admin_status';
                } else if (command === 'reset_my_count') {
                    await usersCollection.doc(userId).update({ messageCount: 0 });
                    responseMessages.push({ type: 'text', text: 'あなたのメッセージカウントをリセットしたよ！' });
                    logDetails.logType = 'admin_reset_self_count';
                } else if (command.startsWith('set_membership ')) {
                    const parts = command.split(' ');
                    if (parts.length === 3) {
                        const targetUserId = parts[1];
                        const newMembership = parts[2];
                        if (MEMBERSHIP_CONFIG[newMembership]) {
                            await usersCollection.doc(targetUserId).update({ membershipType: newMembership });
                            responseMessages.push({ type: 'text', text: `ユーザー ${targetUserId} の会員区分を ${newMembership} に設定したよ！` });
                            logDetails.logType = 'admin_set_membership';
                        } else {
                            responseMessages.push({ type: 'text', text: `無効な会員区分だよ: ${newMembership}` });
                            logDetails.logType = 'admin_command_invalid_membership';
                        }
                    } else {
                        responseMessages.push({ type: 'text', text: '使用法: admin:set_membership [ユーザーID] [membershipType]' });
                    }
                } else if (command === '!メニュー' || command === 'メニュー') {
                    responseMessages.push({
                        type: 'flex', altText: 'こころちゃんのメニュー', contents: {
                            "type": "bubble", "body": {
                                "type": "box", "layout": "vertical", "contents": [
                                    { "type": "text", "text": "メニュー", "weight": "bold", "color": "#FF69B4", "size": "lg" },
                                    { "type": "button", "action": { "type": "message", "label": "見守りサービスについて", "text": "見守り" }, "style": "primary", "height": "sm", "margin": "md", "color": "#FFC0CB" },
                                    { "type": "button", "action": { "type": "message", "label": "相談する", "text": "相談したい" }, "style": "primary", "height": "sm", "margin": "md", "color": "#FFC0CB" },
                                    { "type": "button", "action": { "type": "message", "label": "こころちゃんとは？", "text": "こころちゃんとは？" }, "style": "primary", "height": "sm", "margin": "md", "color": "#FFC0CB" },
                                    { "type": "button", "action": { "type": "postback", "label": "会員登録", "data": "action=show_registration_buttons" }, "style": "primary", "height": "sm", "margin": "md", "color": "#FFC0CB" }
                                ]
                            }
                        }
                    });
                    logDetails.logType = 'system_menu_admin';
                } else if (command === '!history') {
                    try {
                        const querySnapshot = await messagesCollection.where('userId', '==', userId)
                            .orderBy('timestamp', 'desc')
                            .limit(10)
                            .get();
                        const historyMessages = querySnapshot.docs.map(doc => doc.data());
                        let historyText = "あなたの最新の会話履歴だよ🌸\n\n";
                        historyMessages.reverse().forEach(msg => {
                            const timestamp = msg.timestamp ? msg.timestamp.toDate() : new Date();
                            historyText += `【${msg.responsedBy === 'ユーザー' ? 'あなた' : msg.responsedBy}】${msg.message || msg.replyText} (${timestamp.toLocaleString()})\n`;
                        });
                        responseMessages.push({ type: 'text', text: historyText });
                        logDetails.logType = 'admin_history_display';
                    } catch (error) {
                        console.error("❌ 履歴取得エラー:", error.message);
                        logErrorToDb(userId, "履歴取得エラー", { error: error.message, userId: userId });
                        responseMessages.push({ type: 'text', text: '履歴取得中にエラーが発生しました。' });
                        logDetails.logType = 'admin_error_history';
                    }
                } else if (command === '!myid') {
                    responseMessages.push({ type: 'text', text: `あなたのLINEユーザーIDはこれだよ🌸\n\n${userId}` });
                    logDetails.logType = 'admin_myid_display';
                } else if (command.startsWith('!flag ')) {
                    const targetUserId = command.substring(6).trim();
                    const targetUserDoc = await usersCollection.doc(targetUserId).get();
                    if (targetUserDoc.exists) {
                        const currentFlagged = targetUserDoc.data().flagged || false;
                        await usersCollection.doc(targetUserId).update({ flagged: !currentFlagged });
                        responseMessages.push({ type: 'text', text: `ユーザー ${targetUserId} のフラグ状態を ${!currentFlagged} に設定したよ。` });
                        logDetails.logType = 'admin_flag_user';
                    } else {
                        responseMessages.push({ type: 'text', text: `ユーザー ${targetUserId} が見つからないよ。` });
                    }
                } else if (command.startsWith('!suspend ')) {
                    const parts = command.split(' ');
                    if (parts.length === 3) {
                        const targetUserId = parts[1];
                        const minutes = parseInt(parts[2], 10);
                        if (!isNaN(minutes) && minutes > 0) {
                            const suspendUntil = new Date(new Date().getTime() + minutes * 60 * 1000);
                            await usersCollection.doc(targetUserId).update({ suspendUntil: suspendUntil });
                            responseMessages.push({ type: 'text', text: `ユーザー ${targetUserId} を ${minutes} 分間停止したよ。` });
                            logDetails.logType = 'admin_suspend_user';
                        } else {
                            responseMessages.push({ type: 'text', text: `使用法: admin:!suspend [ユーザーID] [分数]` });
                        }
                    } else {
                        responseMessages.push({ type: 'text', text: `使用法: admin:!suspend [ユーザーID] [分数]` });
                    }
                } else {
                    responseMessages.push({ type: 'text', text: '不明な管理者コマンドです。' });
                    logDetails.logType = 'admin_command_unknown';
                }

                await client.replyMessage(replyToken, responseMessages);
                logToDb(userId, userMessage, JSON.stringify(responseMessages), logDetails.responsedBy, logDetails.logType, true);
                return;
            }

            // 2. 会員登録フローの継続 (登録途中のユーザー向け)
            if (user.registrationStep) {
                handledByLogic = await handleRegistrationFlow(event, userId, user, userMessage, lowerUserMessage, usersCollection, messagesCollection);
                if (handledByLogic) {
                    logDetails.responsedBy = 'こころちゃん（登録フロー）';
                    logDetails.logType = 'registration_flow_handled';
                }
            }
            if (handledByLogic) {
                return;
            }

            // 3. 見守りサービス関連コマンド（「見守り」「解除」「元気だよ！」など）
            const currentWatchServiceHandled = await handleWatchServiceRegistration(event, userId, userMessage, user);
            if (currentWatchServiceHandled) {
                logDetails.responsedBy = 'こころちゃん（見守りサービス）';
                logDetails.logType = 'watch_service_interaction';
                return;
            }

            // 4. 会員登録のFlex Message表示 (「会員登録」コマンド)
            if (['会員登録', '登録', 'かいいん', 'とうろく'].includes(lowerUserMessage)) {
                if (!user.completedRegistration) {
                    await client.replyMessage(replyToken, {
                        type: 'flex',
                        altText: 'どの会員になるか選んでね🌸',
                        contents: REGISTRATION_BUTTONS_FLEX
                    });
                    logToDb(userId, userMessage, '会員登録ボタンFlexを案内しました。', 'こころちゃん（会員登録案内）', 'registration_buttons_display', true);
                } else {
                    const prefilledChangeFormUrl = `${CHANGE_INFO_FORM_URL}?${CHANGE_INFO_FORM_LINE_USER_ID_ENTRY_ID}=${userId}`;
                    await client.replyMessage(replyToken, {
                        type: 'text',
                        text: `まつさん、もう会員登録は完了しているみたいだよ🌸\n\n登録内容を変更したい場合は、こちらのリンクから手続きしてね💖\n${prefilledChangeFormUrl}`
                    });
                    logToDb(userId, userMessage, '（会員登録済み - 変更フォーム案内）', 'こころちゃん（会員登録案内）', 'registration_already_completed', true);
                }
                return;
            }

            // 5. 固定応答（SpecialRepliesMap）
            const specialReply = checkSpecialReply(userMessage);
            if (specialReply) {
                await client.replyMessage(replyToken, { type: 'text', text: specialReply });
                logToDb(userId, userMessage, specialReply, 'こころちゃん（固定応答）', 'special_reply', true);
                return;
            }

            // 6. 不適切ワードのチェック
            const isInappropriate = checkContainsInappropriateWords(userMessage);
            if (isInappropriate) {
                usersCollection.doc(userId).update({
                    inappropriateWordCount: admin.firestore.FieldValue.increment(1)
                });
                user.inappropriateWordCount = (user.inappropriateWordCount || 0) + 1;

                const replyText = "わたしを作った人に『プライベートなことや不適切な話題には答えちゃだめだよ』って言われているんだ🌸ごめんね、他のお話をしようね💖";
                await client.replyMessage(replyToken, { type: 'text', text: replyText });
                logToDb(userId, userMessage, replyText, 'こころちゃん（不適切ワード）', 'inappropriate_word', true);

                if (user.inappropriateWordCount >= 2 && OWNER_USER_ID) {
                    safePushMessage(OWNER_USER_ID, { type: 'text', text: `【⚠不適切ワード通知⚠】\nユーザー（LINE表示名: ${user.displayName}）が本日2回以上不適切ワードを送信しました。\nユーザーID: ${userId}\n最新のメッセージ: 「${userMessage}」` })
                        .then(() => console.log(`🚨 OWNER_USER_ID (${OWNER_USER_ID}) に不適切ワード通知を送信しました。`))
                        .catch(notifyError => {
                            console.error(`❌ OWNER_USER_IDへの不適切ワード通知送信エラー:`, notifyError.message);
                            logErrorToDb(OWNER_USER_ID, "不適切ワード通知送信エラー", { error: notifyError.message, userId: userId, originalUserMessage: userMessage });
                        });
                }
                return;
            }

            // ⭐ 7. 危険ワード、詐欺ワードのチェック (緊急対応) - 修正部分 ⭐
            const isDanger = checkContainsDangerWords(userMessage);
            const isScam = checkContainsScamWords(userMessage);

            if (isDanger || isScam) {
                console.log(`💡 緊急検知: ${isDanger ? '危険ワード' : '詐欺ワード'} - GPT-4o 使用`); // ロギング
                // まずGPT-4oからの応答を生成
                const aiReplyForEmergency = await generateGPTReply(userMessage, "gpt-4o", userId, { ...user, isUrgent: true });

                let notificationMessageForOfficer = `🚨【${isDanger ? '危険ワード検知' : '詐欺ワード検知'}】🚨\n\n`;

                notificationMessageForOfficer += `👤 氏名: ${user.name || user.displayName || '不明'}\n`;
                if (user.phoneNumber) {
                    notificationMessageForOfficer += `📱 電話番号: ${user.phoneNumber}\n`;
                } else {
                    notificationMessageForOfficer += `📱 電話番号: 未登録\n`;
                }

                if (user.category === '小学生' || user.category === '中学生～大学生') {
                    if (user.guardianName) {
                        notificationMessageForOfficer += `👨‍👩‍👧‍👦 保護者名: ${user.guardianName}\n`;
                    } else {
                        notificationMessageForOfficer += `👨‍👩‍👧‍👦 保護者名: 未登録\n`;
                    }
                    if (user.guardianPhoneNumber) {
                        notificationMessageForOfficer += `📞 緊急連絡先: ${user.guardianPhoneNumber}\n`;
                    } else {
                        notificationMessageForOfficer += `📞 緊急連絡先: 未登録\n`;
                    }
                    notificationMessageForOfficer += `🧬 続柄: ${user.relationshipToEmergencyContact || '未登録'}\n`;
                } else if (user.emergencyContact) {
                    if (user.emergencyContactName) {
                        notificationMessageForOfficer += `👨‍👩‍👧‍👦 緊急連絡先 氏名: ${user.emergencyContactName}\n`;
                    } else {
                        notificationMessageForOfficer += `👨‍👩‍👧‍👦 緊急連絡先 氏名: 未登録\n`;
                    }
                    notificationMessageForOfficer += `📞 緊急連絡先: ${user.emergencyContact}\n`;
                    notificationMessageForOfficer += `🧬 続柄: ${user.relationshipToEmergencyContact || '未登録'}\n`;
                } else {
                    notificationMessageForOfficer += `📞 緊急連絡先: 未登録\n`;
                    notificationMessageForOfficer += `🧬 続柄: 未登録\n`;
                }

                notificationMessageForOfficer += `\n**ユーザーメッセージ:** 「${userMessage}」\n`;
                notificationMessageForOfficer += `**こころちゃんの応答:** 「${aiReplyForEmergency}」\n`;

                if (OFFICER_GROUP_ID) {
                    // ⭐ safePushMessageを呼び出すように変更 ⭐
                    await safePushMessage(OFFICER_GROUP_ID, { type: 'text', text: notificationMessageForOfficer });
                    logToDb(userId, userMessage, notificationMessageForOfficer, `こころちゃん（事務局通知）`, isDanger ? 'danger_word_detected_officer_notify' : 'scam_word_detected_officer_notify', true);
                } else {
                    console.warn(`OFFICER_GROUP_IDが設定されていないため、危険ワード通知は送信されませんでした。`);
                }

                // ユーザーにはAI応答とFlex Messageを一度に送信
                let userMessagesToSend = [];
                userMessagesToSend.push({ type: 'text', text: aiReplyForEmergency });
                if (isDanger) {
                    userMessagesToSend.push({ type: 'flex', altText: "緊急連絡先一覧", contents: EMERGENCY_FLEX_MESSAGE });
                } else if (isScam) {
                    userMessagesToSend.push({ type: 'flex', altText: "詐欺の可能性があります", contents: SCAM_FLEX_MESSAGE });
                }

                await client.replyMessage(replyToken, userMessagesToSend);

                logToDb(userId, userMessage, aiReplyForEmergency + '（緊急通知Flex表示）', 'こころちゃん（危険/詐欺検知）', isDanger ? 'danger_word_detected' : 'scam_word_detected', true);
                return;
            }
            // ⭐ 修正ここまで ⭐

            // 8. 宿題・勉強に関する質問のチェック（子供向けAI設定の場合のみ）
            if (containsHomeworkTrigger(userMessage) && userConfig.isChildAI) {
                const replyText = "わたしを作った人に『宿題や勉強は自分の力でがんばってほしいから、答えは言っちゃだめだよ』って言われているんだ🌸 ごめんね💦でも、ヒントくらいなら出せるよ😊 どこで困ってるか教えてくれる？💖";
                await client.replyMessage(replyToken, { type: 'text', text: replyText });
                logToDb(userId, userMessage, replyText, 'こころちゃん（宿題拒否）', 'homework_query', true);
                return;
            }

            // ⭐ 9. 「相談」モードの開始（`useProForNextConsultation`がfalseの場合のみ） - 修正部分 ⭐
            if (['そうだん', '相談'].includes(lowerUserMessage) && !user.useProForNextConsultation) {
                console.log(`💡 相談モード開始: Gemini 1.5 Pro 使用`); // ロギング
                if (event.replyToken) {
                    await client.replyMessage(event.replyToken, { type: 'text', text: 'うん、お話聞かせてね🌸 一度だけ、Gemini 1.5 Proでじっくり話そうね。何があったの？💖' });
                } else {
                    await safePushMessage(userId, { type: 'text', text: 'うん、お話聞かせてね🌸 一度だけ、Gemini 1.5 Proでじっくり話そうね。何があったの？💖' });
                }
                await usersCollection.doc(userId).update({ useProForNextConsultation: true }); // 次のメッセージでProを使うフラグ
                logToDb(userId, userMessage, '（相談モード開始）', 'こころちゃん（モード切替）', 'consultation_mode_start', true);
                return;
            }

            // ⭐ 10. 月間メッセージカウント制限のチェック (管理者以外) - 修正部分 ⭐
            // サブスク会員が回数制限を超えた場合のフォールバックモデル選択ロジックを修正
            if (userConfig.monthlyLimit !== -1 && user.messageCount >= userConfig.monthlyLimit) {
                if (user.membershipType === "subscriber" && userConfig.fallbackModel) {
                    await client.replyMessage(replyToken, { type: 'text', text: userConfig.exceedLimitMessage });

                    const actualFallbackModel = getAIModelForUser(user, userMessage); // フォールバック時のモデルもメッセージ長で決定
                    console.log(`💡 回数超過: サブスクユーザー - フォールバックモデル ${actualFallbackModel} 使用`); // ロギング

                    const aiReplyForFallback = await (actualFallbackModel.startsWith("gpt") ? generateGPTReply(userMessage, actualFallbackModel, userId, user) : generateGeminiReply(userMessage, actualFallbackModel, userId, user));

                    await safePushMessage(userId, { type: 'text', text: aiReplyForFallback }).catch(e => console.error("回数超過後フォールバック応答プッシュ失敗", e));

                    logToDb(userId, userMessage, userConfig.exceedLimitMessage + `（フォールバックAI: ${actualFallbackModel}）`, `こころちゃん（${actualFallbackModel} - 回数超過）`, 'quota_exceeded_fallback', true);
                    return;
                } else {
                    await client.replyMessage(replyToken, { type: 'text', text: userConfig.exceedLimitMessage });
                    logToDb(userId, userMessage, userConfig.exceedLimitMessage, 'こころちゃん（回数超過）', 'quota_exceeded', true);
                    return;
                }
            }

            // ⭐ 11. 相談モード中の応答（1回限り） - 修正部分 ⭐
            if (user.useProForNextConsultation) {
                console.log(`💡 相談モード継続中: Gemini 1.5 Pro 使用`); // ロギング
                generateGeminiReply(userMessage, "gemini-1.5-pro-latest", userId, { ...user, isInConsultationMode: true }).then(aiReply => {
                    client.replyMessage(replyToken, { type: 'text', text: aiReply }).catch(e => console.error("相談モードAI応答プッシュ失敗", e));
                    usersCollection.doc(userId).update({ useProForNextConsultation: false }); // 1回きりの使用なのでフラグをfalseに戻す
                    logToDb(userId, userMessage, aiReply, 'こころちゃん（相談モード）', 'consultation_message', true);
                }).catch(e => {
                    console.error("相談モードAI応答生成エラー", e);
                    logErrorToDb(userId, "相談モードAI応答生成エラー", { error: e.message, userId: userId, originalUserMessage: userMessage });
                });
                return;
            }

            // 12. NPO法人コネクトに関する質問を優先
            if (isOrganizationInquiry(userMessage)) {
                await client.replyMessage(replyToken, { type: 'text', text: ORGANIZATION_REPLY_MESSAGE });
                logToDb(userId, userMessage, ORGANIZATION_REPLY_MESSAGE, 'こころちゃん（団体説明）', 'organization_inquiry_fixed', true);
                return;
            }

            // 13. 共感が必要なメッセージ (GPT-4o mini)
            if (containsEmpatheticTrigger(userMessage)) {
                if (userMessage.toLowerCase().includes("いじめ") || userMessage.toLowerCase().includes("イジメ")) {
                    const bullyingReply = `いじめは決して許してはいけないことだし、とても悲しいことだと思うよ。誰もが安心して過ごせる場所が必要だし、みんなが尊重されるべきだよね。もしも辛いことがあったら、一人で抱え込まないで、誰かに相談してみてね。いつでも私がそばにいるよ。緊急の時は、専門の人に相談することもできるから安心してね。`;
                    await client.replyMessage(replyToken, [{ type: 'text', text: bullyingReply }, { type: 'flex', altText: "緊急連絡先一覧", contents: EMERGENCY_FLEX_MESSAGE }]);
                    logToDb(userId, userMessage, `（いじめに関する共感応答 + 緊急連絡先Flex表示）`, 'こころちゃん（いじめ検知）', 'empathetic_message', true);
                } else {
                    console.log(`💡 共感メッセージ: GPT-4o mini 使用`); // ロギング
                    generateGPTReply(userMessage, "gpt-4o-mini", userId, user).then(aiReply => {
                        client.replyMessage(replyToken, { type: 'text', text: aiReply }).catch(e => console.error("共感AI応答プッシュ失敗", e));
                        logToDb(userId, userMessage, aiReply, 'こころちゃん（共感）', 'empathetic_message', true);
                    }).catch(e => {
                        console.error("共感AI応答生成エラー", e);
                        logErrorToDb(userId, "共感AI応答生成エラー", { error: e.message, userId: userId, originalUserMessage: userMessage });
                    });
                }
                return;
            }

            // ⭐ 14. 通常のAI応答（会員区分に基づくモデル） - 最終的なフォールバック - 修正部分 ⭐
            const aiModelUsed = getAIModelForUser(user, userMessage);
            let aiReply;

            try {
                if (aiModelUsed.startsWith("gpt")) {
                    aiReply = await generateGPTReply(userMessage, aiModelUsed, userId, user);
                } else { // Geminiの場合
                    aiReply = await generateGeminiReply(userMessage, aiModelUsed, userId, user);
                }

                await client.replyMessage(replyToken, { type: 'text', text: aiReply });
                logToDb(userId, userMessage, aiReply, `こころちゃん（AI会話: ${aiModelUsed}）`, 'normal_conversation', false);
            } catch (error) {
                console.error(`❌ AI応答のreplyMessage失敗 (ユーザー: ${userId}, メッセージ: "${userMessage}"):`, error.message);
                logErrorToDb(userId, `AI応答replyMessage失敗`, { error: error.message, replyToken: replyToken, userMessage: userMessage, aiModel: aiModelUsed });
                try {
                    await client.replyMessage(replyToken, { type: 'text', text: 'ごめんね、今うまくお話できなかったの…💦　でも、あなたのことはちゃんと気にかけているよ。' });
                } catch (fallbackError) {
                    console.error(`❌ フォールバックメッセージ送信失敗 (ユーザー: ${userId}):`, fallbackError.message);
                    logErrorToDb(userId, `フォールバックメッセージ送信失敗`, { error: fallbackError.message, userMessage: userMessage });
                }
            }
            return;
        } else if (event.type === 'postback') {
            const postbackData = event.postback.data;
            const data = new URLSearchParams(postbackData);
            const action = data.get('action');

            if (action === 'show_registration_buttons') {
                await client.replyMessage(event.replyToken, {
                    type: 'flex',
                    altText: 'どの会員になるか選んでね🌸',
                    contents: REGISTRATION_BUTTONS_FLEX
                });
                logToDb(userId, `（会員登録ボタン表示要求）`, '（会員登録ボタンFlex表示）', 'こころちゃん（メニュー）', 'registration_button_display', true);
                return;
            }

            const handledByWatchServicePostback = await handleWatchServiceRegistration(event, userId, event.postback.data, user);
            if (handledByWatchServicePostback) {
                return;
            }
        }
    });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, async () => {
    console.log(`🚀 サーバーがポート ${PORT} で起動しました...`);
    console.log("✅ FirestoreはFirebase Admin SDKによって初期化済みです。");
    if (!OFFICER_GROUP_ID) {
        console.error("🔥🔥🔥【重要】環境変数 'OFFICER_GROUP_ID' が設定されていません。危険ワードや見守りの通知が事務局に届きません！ 🔥🔥🔥");
    }
    if (!OPENAI_API_KEY) {
        console.error("🔥🔥🔥【重要】環境変数 'OPENAI_API_KEY' が設定されていません。通常応答の一部や緊急時の応答ができません！ 🔥🔥🔥");
    }
});

// ⭐新規追加: 事務局への緊急通知専用リトライ関数 (safePushMessageを使用) ⭐
async function sendUrgentOfficerNotification(to, message, userId, originalUserMessage, logType) {
    const maxRetries = 5;
    const initialDelayMs = 2000;

    for (let i = 0; i <= maxRetries; i++) {
        const currentDelay = initialDelayMs * (2 ** i);
        if (i > 0) console.warn(`⚠️ 事務局通知リトライ中 (リトライ: ${i}, ディレイ: ${currentDelay}ms)`);
        await new Promise(resolve => setTimeout(resolve, currentDelay));

        try {
            // ⭐ client.pushMessage の代わりに safePushMessage を使用 ⭐
            await safePushMessage(to, { type: 'text', text: message });
            console.log(`✅ 事務局通知送信成功 to: ${to}`);
            logToDb(userId, originalUserMessage, message, `こころちゃん（事務局通知）`, logType, true);
            return; // 成功したらループを抜ける
        } catch (error) {
            console.error(`❌ 事務局通知送信失敗 (ユーザー: ${to}, リトライ: ${i}):`, error.message);
            if (error.response) {
                console.error("ステータスコード:", error.response.status);
                console.error("レスポンスデータ:", error.response.data);
                console.error("レスポンスヘッダー:", error.response.headers);
            } else if (error.request) {
                console.error("リクエストが送信されたが応答なし (ネットワークエラーなど):", error.request);
            } else {
                console.error("一般的なエラーメッセージ:", error.message);
            }

            if (i === maxRetries) {
                console.error(`🚨 事務局通知リトライ失敗: 最大リトライ回数に達しました (ユーザー: ${to})`);
                logErrorToDb(to, `事務局通知429エラー (最終リトライ失敗)`, { error: error.message, originalMessage: originalUserMessage });
            }
        }
    }
}
