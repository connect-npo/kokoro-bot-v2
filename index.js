// --- dotenvを読み込んで環境変数を安全に管理 ---
require('dotenv').config();

// --- 必要なモジュールのインポート ---
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
        // model: "gemini-1.5-flash-latest", // 削除済みだが、ゲストはgetAIModelForUserを通らないためここでモデル指定
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
            { "type": "text", "text": "🚨【危険ワード検知】🚨", "weight": "bold", "color": "#DD0000", "size": "xl" }, // Updated title
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
            { "type": "text", "text": "🚨【詐欺注意】🚨", "weight": "bold", "color": "#DD0000", "size": "xl" }, // Updated title
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
    [/ClariSのなんて局が好きなの？/i, "ClariSの曲は全部好きだけど、もし一つだけ選ぶなら…「コネクト」かな🌸　元気が出る曲で、聴くと頑張ろうって思えるんだ�\n\nNPO法人コネクトの名前とClariSさんの曲名が同じだから、そう思ったのかもしれないけど、直接的な関係はないんだよ。でも、偶然の一致ってなんだか嬉しいね💖\n\nあなたはどの曲が特に好き？💖　もしかしたら、私たち、同じ曲が好きなのかもしれないね！"]
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
        console.log(`✅ Logged to Firestore: Type=${logType}, UserId=${userId}`);
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
        console.log("AI Model Selected: gpt-4o-mini (Long message)");
        return "gpt-4o-mini";
    }
    // それ以外（50文字未満）の場合はGemini 1.5 Flashを使用
    console.log("AI Model Selected: gemini-1.5-flash-latest (Short message)");
    return "gemini-1.5-flash-latest";
}

// --- AI応答生成関数 ---
// GPTモデル（OpenAI）からの応答生成
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
        console.log(`💡 OpenAI: ${modelToUse} 使用中`); // ⭐ 明示的なロギング追加 ⭐
        const completion = await openai.chat.completions.create({
            model: modelToUse,  // ⭐ これを明示 ⭐
            messages: [
                { role: "system", content: systemInstruction },
                { role: "user", content: userMessage }
            ],
            max_tokens: modelToUse === "gpt-4o" ? 1000 : (userConfig.isChildAI ? 200 : 600)
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
async function handleRegistrationFlow(event, userId, user, userMessage, lowerUserMessage, usersCollection) {
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
    const twentyNineHoursAgo = new Date(now.toDate().getTime() - 29 * 60 * 60 * 1000);
    const threeDaysAgo = new Date(now.toDate().getTime() - 3 * 24 * 60 * 60 * 1000); // 72時間
    const sevenDaysAgo = new Date(now.toDate().getTime() - 7 * 24 * 60 * 60 * 1000);
    const fourteenDaysAgo = new Date(now.toDate().getTime() - 14 * 24 * 60 * 60 * 1000);
    const twentyOneDaysAgo = new Date(now.toDate().getTime() - 21 * 24 * 60 * 60 * 1000); // 21日

    try {
        const snapshot = await usersCollection
            .where('watchServiceEnabled', '==', true)
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
            // 21日返信なし（最終通知 - 緊急連絡先への通知）
            else if (lastOkResponse < twentyOneDaysAgo && !user.finalNotificationSent) {
                notificationNeeded = true;
                notificationType = '21日未応答';
                updateData.finalNotificationSent = true;
                console.log(`ユーザー ${userId}: 21日経過 - 最終緊急通知をトリガー`);
                logToDb(userId, `（21日未応答最終通知）`, `緊急連絡先へ通知をトリガー`, 'こころちゃん（見守り）', 'watch_service_final_notification', true);
            }

            // 必要な場合に通知を送信
            if (notificationNeeded) {
                const userInfo = user.registeredInfo || {};
                const userName = userInfo.name || '不明なユーザー';
                const subject = `🚨見守りサービス最終緊急通知: ${userName} 様が${notificationType}未応答です`;
                const text = `ユーザーID: ${userId}\n氏名: ${userName}\n電話番号: ${userInfo.phoneNumber || 'N/A'}\n保護者名: ${userInfo.guardianName || 'N/A'}\n緊急連絡先: ${userInfo.emergencyContact || 'N/A'}\n続柄: ${userInfo.relationship || 'N/A'}\n\n最終応答日時: ${lastOkResponse.toLocaleString()}\n\nこのユーザーの安否確認をしてください。緊急性が非常に高いです。`;
                await sendEmailNotification(subject, text);
                await notifyOfficerGroup(`ユーザー ${userName} (${userId}) が見守りサービスで${notificationType}未応答です。緊急対応が必要です。`, userId, userInfo, "watch_unresponsive", notificationType);
            }

            // ユーザーデータの更新を反映
            if (Object.keys(updateData).length > 0) {
                await usersCollection.doc(userId).update(updateData);
            }
        }
        console.log('✅ 見守りサービス定期チェックが完了しました。');
    } catch (error) {
        console.error("❌ 見守りサービス Cron ジョブ実行中にエラーが発生しました:", error.message);
        await logErrorToDb(null, "見守りサービス Cron ジョブエラー", { error: error.message, stack: error.stack });
    }
}

/**
 * 管理者グループに通知メッセージを送信する関数。
 * @param {string} message - 送信するメッセージ
 * @param {string} userId - 通知対象のユーザーID
 * @param {Object} userInfo - ユーザーの登録情報
 * @param {string} type - 通知の種類 (例: "danger", "scam", "watch_unresponsive")
 * @param {string} [notificationDetailType=''] - 見守りサービス未応答時の詳細タイプ (例: "14日未応答", "21日未応答")
 */
async function notifyOfficerGroup(message, userId, userInfo, type, notificationDetailType = '') {
    const userName = userInfo.name || '不明なユーザー';
    const userPhone = userInfo.phoneNumber || '不明';
    const guardianName = userInfo.guardianName || '不明';
    const emergencyContact = userInfo.emergencyContact || '不明';
    const relationship = userInfo.relationship || '不明';

    let flexContent;
    if (type === "danger") {
        flexContent = {
            "type": "bubble",
            "body": {
                "type": "box",
                "layout": "vertical",
                "contents": [
                    { "type": "text", "text": "🚨【危険ワード検知】🚨", "weight": "bold", "color": "#DD0000", "size": "xl" },
                    { "type": "separator", "margin": "md" },
                    { "type": "box", "layout": "vertical", "margin": "md", "spacing": "sm", "contents": [
                        { "type": "box", "layout": "baseline", "contents": [ { "type": "text", "text": "👤 氏名：", "flex": 2, "size": "sm", "color": "#555555" }, { "type": "text", "text": userName, "flex": 5, "size": "sm", "wrap": true } ] },
                        { "type": "box", "layout": "baseline", "contents": [ { "type": "text", "text": "📱 電話番号：", "flex": 2, "size": "sm", "color": "#555555" }, { "type": "text", "text": userPhone, "flex": 5, "size": "sm", "wrap": true } ] },
                        { "type": "box", "layout": "baseline", "contents": [ { "type": "text", "text": "👨‍👩‍👧‍👦 保護者名：", "flex": 2, "size": "sm", "color": "#555555" }, { "type": "text", "text": guardianName, "flex": 5, "size": "sm", "wrap": true } ] },
                        { "type": "box", "layout": "baseline", "contents": [ { "type": "text", "text": "📞 緊急連絡先：", "flex": 2, "size": "sm", "color": "#555555" }, { "type": "text", "text": emergencyContact, "flex": 5, "size": "sm", "wrap": true } ] },
                        { "type": "box", "layout": "baseline", "contents": [ { "type": "text", "text": "🧬 続柄：", "flex": 2, "size": "sm", "color": "#555555" }, { "type": "text", "text": relationship, "flex": 5, "size": "sm", "wrap": true } ] }
                    ] },
                    { "type": "separator", "margin": "md" },
                    { "type": "text", "text": `メッセージ: 「${message}」`, "margin": "md", "wrap": true, "size": "sm" }
                ]
            },
            "footer": {
                "type": "box",
                "layout": "vertical",
                "spacing": "sm",
                "contents": [
                    { "type": "button", "style": "primary", "height": "sm", "action": { "type": "uri", "label": "ユーザーとのチャットへ", "uri": `https://line.me/ti/p/~${userId}` }, "color": "#1E90FF" }
                ]
            }
        };
    } else if (type === "scam") {
        flexContent = {
            "type": "bubble",
            "body": {
                "type": "box",
                "layout": "vertical",
                "contents": [
                    { "type": "text", "text": "🚨【詐欺注意】🚨", "weight": "bold", "color": "#DD0000", "size": "xl" },
                    { "type": "separator", "margin": "md" },
                    { "type": "box", "layout": "vertical", "margin": "md", "spacing": "sm", "contents": [
                        { "type": "box", "layout": "baseline", "contents": [ { "type": "text", "text": "👤 氏名：", "flex": 2, "size": "sm", "color": "#555555" }, { "type": "text", "text": userName, "flex": 5, "size": "sm", "wrap": true } ] },
                        { "type": "box", "layout": "baseline", "contents": [ { "type": "text", "text": "📱 電話番号：", "flex": 2, "size": "sm", "color": "#555555" }, { "type": "text", "text": userPhone, "flex": 5, "size": "sm", "wrap": true } ] },
                        { "type": "box", "layout": "baseline", "contents": [ { "type": "text", "text": "👨‍👩‍👧‍👦 保護者名：", "flex": 2, "size": "sm", "color": "#555555" }, { "type": "text", "text": guardianName, "flex": 5, "size": "sm", "wrap": true } ] },
                        { "type": "box", "layout": "baseline", "contents": [ { "type": "text", "text": "📞 緊急連絡先：", "flex": 2, "size": "sm", "color": "#555555" }, { "type": "text", "text": emergencyContact, "flex": 5, "size": "sm", "wrap": true } ] },
                        { "type": "box", "layout": "baseline", "contents": [ { "type": "text", "text": "🧬 続柄：", "flex": 2, "size": "sm", "color": "#555555" }, { "type": "text", "text": relationship, "flex": 5, "size": "sm", "wrap": true } ] }
                    ] },
                    { "type": "separator", "margin": "md" },
                    { "type": "text", "text": `メッセージ: 「${message}」`, "margin": "md", "wrap": true, "size": "sm" }
                ]
            },
            "footer": {
                "type": "box",
                "layout": "vertical",
                "spacing": "sm",
                "contents": [
                    { "type": "button", "style": "primary", "height": "sm", "action": { "type": "uri", "label": "ユーザーとのチャットへ", "uri": `https://line.me/ti/p/~${userId}` }, "color": "#1E90FF" }
                ]
            }
        };
    } else if (type === "watch_unresponsive") {
        flexContent = {
            "type": "bubble",
            "body": {
                "type": "box",
                "layout": "vertical",
                "contents": [
                    { "type": "text", "text": `🚨【見守りサービス未応答 (${notificationDetailType})】🚨`, "weight": "bold", "color": "#DD0000", "size": "xl" },
                    { "type": "separator", "margin": "md" },
                    { "type": "box", "layout": "vertical", "margin": "md", "spacing": "sm", "contents": [
                        { "type": "box", "layout": "baseline", "contents": [ { "type": "text", "text": "👤 氏名：", "flex": 2, "size": "sm", "color": "#555555" }, { "type": "text", "text": userName, "flex": 5, "size": "sm", "wrap": true } ] },
                        { "type": "box", "layout": "baseline", "contents": [ { "type": "text", "text": "📱 電話番号：", "flex": 2, "size": "sm", "color": "#555555" }, { "type": "text", "text": userPhone, "flex": 5, "size": "sm", "wrap": true } ] },
                        { "type": "box", "layout": "baseline", "contents": [ { "type": "text", "text": "👨‍👩‍👧‍👦 保護者名：", "flex": 2, "size": "sm", "color": "#555555" }, { "type": "text", "text": guardianName, "flex": 5, "size": "sm", "wrap": true } ] },
                        { "type": "box", "layout": "baseline", "contents": [ { "type": "text", "text": "📞 緊急連絡先：", "flex": 2, "size": "sm", "color": "#555555" }, { "type": "text", "text": emergencyContact, "flex": 5, "size": "sm", "wrap": true } ] },
                        { "type": "box", "layout": "baseline", "contents": [ { "type": "text", "text": "🧬 続柄：", "flex": 2, "size": "sm", "color": "#555555" }, { "type": "text", "text": relationship, "flex": 5, "size": "sm", "wrap": true } ] }
                    ] },
                    { "type": "separator", "margin": "md" },
                    { "type": "text", "text": `ユーザーが${notificationDetailType}未応答です。安否確認をお願いします。`, "margin": "md", "wrap": true, "size": "sm" }
                ]
            },
            "footer": {
                "type": "box",
                "layout": "vertical",
                "spacing": "sm",
                "contents": [
                    { "type": "button", "style": "primary", "height": "sm", "action": { "type": "uri", "label": "ユーザーとのチャットへ", "uri": `https://line.me/ti/p/~${userId}` }, "color": "#1E90FF" }
                ]
            }
        };
    }
    // Send the message to the officer group
    if (OFFICER_GROUP_ID) {
        await safePushMessage(OFFICER_GROUP_ID, { type: 'flex', altText: `緊急通知: ${type}検知`, contents: flexContent });
        console.log(`✅ 管理者グループに${type}通知を送信しました。`);
    } else {
        console.warn("⚠️ OFFICER_GROUP_ID が設定されていないため、管理者グループへの通知は送信されません。");
    }
}


// --- LINEイベントハンドラ ---
async function handleEvent(event) {
    if (event.type !== 'message' || event.message.type !== 'text') {
        return Promise.resolve(null);
    }

    const userId = event.source.userId;
    const userMessage = event.message.text;
    const lowerUserMessage = userMessage.toLowerCase();
    const isOwner = userId === OWNER_USER_ID;
    const isAdmin = isBotAdmin(userId);

    let user = await getUserData(userId);
    let replyText = "";
    let responsedBy = "AI";
    let logType = "normal_conversation";
    let isFlagged = false;
    let messagesToSend = [];

    // --- 管理者コマンドの処理 ---
    if (isAdmin && userMessage.startsWith('!')) {
        const command = userMessage.substring(1).split(' ')[0]; // !status -> status
        const args = userMessage.substring(command.length + 1).trim(); // !status -> (empty)
        let targetUserId = userId; // デフォルトは自分自身

        // コマンドにユーザーIDが指定されているかチェック
        if (args.startsWith('user ')) {
            const parts = args.split(' ');
            if (parts.length >= 2) {
                targetUserId = parts[1];
                const remainingArgs = parts.slice(2).join(' ').trim(); // user [userId] の後の残りの引数
                // コマンド引数からユーザーIDを分離した場合、残りの引数を改めてパース
                if (command === "set" && remainingArgs) {
                    const newMembershipType = remainingArgs.split(' ')[0];
                    if (MEMBERSHIP_CONFIG[newMembershipType]) {
                        await updateUserData(targetUserId, { membershipType: newMembershipType });
                        replyText = `ユーザー ${targetUserId} の会員種別を ${newMembershipType} に設定しました。`;
                        logType = 'admin_set_membership';
                    } else {
                        replyText = `無効な会員種別です: ${newMembershipType}`;
                        logType = 'admin_command_invalid_membership';
                    }
                    await safePushMessage(userId, { type: 'text', text: replyText });
                    await logToDb(userId, userMessage, replyText, "AdminCommand", logType);
                    return Promise.resolve(null); // ここで処理を終了
                }
            }
        }

        switch (command) {
            case 'status':
                const targetUser = await getUserData(targetUserId);
                if (targetUser) {
                    const lastMessageDate = targetUser.lastMessageDate ? new Date(targetUser.lastMessageDate._seconds * 1000).toLocaleString() : 'N/A';
                    replyText = `ユーザーID: ${targetUserId}\n会員種別: ${targetUser.membershipType}\n今月メッセージ数: ${targetUser.messageCount}\n最終メッセージ日時: ${lastMessageDate}\n見守りサービス: ${targetUser.watchServiceEnabled ? '有効' : '無効'}\n相談モード: ${targetUser.isInConsultationMode ? '有効' : '無効'}`;
                    logType = 'admin_status';
                } else {
                    replyText = `ユーザー ${targetUserId} は見つかりませんでした。`;
                    logType = 'admin_command_unknown';
                }
                break;
            case 'reset':
                await updateUserData(targetUserId, { messageCount: 0, isInConsultationMode: false });
                replyText = `ユーザー ${targetUserId} のメッセージカウントと相談モードをリセットしました。`;
                logType = 'admin_reset_self_count';
                break;
            case 'set':
                // 上記のargs.startsWith('user ')で処理されるため、ここに来る場合は不正な形式
                replyText = `!set user [userId] [membershipType] の形式で入力してください。`;
                logType = 'admin_command_unknown';
                break;
            case 'myid':
                replyText = `あなたのユーザーIDは:\n${userId}`;
                logType = 'admin_myid_display';
                break;
            case 'history':
                const historyUserId = args.split(' ')[0] || userId;
                const limit = parseInt(args.split(' ')[1]) || 10;
                const logsRef = db.collection('logs').where('userId', '==', historyUserId).orderBy('timestamp', 'desc').limit(limit);
                const snapshot = await logsRef.get();
                let historyMessages = [];
                snapshot.forEach(doc => {
                    const data = doc.data();
                    const timestamp = data.timestamp ? new Date(data.timestamp._seconds * 1000).toLocaleString() : 'N/A';
                    historyMessages.push(`[${timestamp}] ${data.logType}: ${data.message} -> ${data.replyText}`);
                });
                replyText = historyMessages.length > 0 ? historyMessages.join('\n\n') : '履歴はありません。';
                logType = 'admin_history_display';
                break;
            case 'error_history':
                const errorHistoryUserId = args.split(' ')[0] || userId;
                const errorLimit = parseInt(args.split(' ')[1]) || 10;
                const errorLogsRef = db.collection('error_logs').where('userId', '==', errorHistoryUserId).orderBy('timestamp', 'desc').limit(errorLimit);
                const errorSnapshot = await errorLogsRef.get();
                let errorHistoryMessages = [];
                errorSnapshot.forEach(doc => {
                    const data = doc.data();
                    const timestamp = data.timestamp ? new Date(data.timestamp._seconds * 1000).toLocaleString() : 'N/A';
                    errorHistoryMessages.push(`[${timestamp}] ${data.message} (Details: ${data.errorDetails})`);
                });
                replyText = errorHistoryMessages.length > 0 ? errorHistoryMessages.join('\n\n') : 'エラー履歴はありません。';
                logType = 'admin_error_history';
                break;
            default:
                replyText = `不明な管理者コマンドです。利用可能なコマンド: !status, !reset, !set user [userId] [membershipType], !myid, !history, !error_history`;
                logType = 'admin_command_unknown';
                break;
        }
        await safePushMessage(userId, { type: 'text', text: replyText });
        await logToDb(userId, userMessage, replyText, "AdminCommand", logType);
        return Promise.resolve(null);
    }

    // --- 登録フローが進行中の場合、登録フローハンドラを呼び出す ---
    if (user.registrationStep) {
        const registrationHandled = await handleRegistrationFlow(event, userId, user, userMessage, lowerUserMessage, db.collection('users'));
        if (registrationHandled) {
            return Promise.resolve(null);
        }
    }

    // --- 見守りサービス登録フローが進行中の場合、ハンドラを呼び出す ---
    // または、見守りサービス関連の特定のメッセージ/postbackの場合
    if (user.registrationStep === 'awaiting_contact_form' || lowerUserMessage.includes('解除') || lowerUserMessage.includes('かいじょ') || lowerUserMessage.includes("元気だよ！") || lowerUserMessage.includes("okだよ") || lowerUserMessage.includes("ok") || lowerUserMessage.includes("オーケー") || lowerUserMessage.includes("大丈夫") || lowerUserMessage.includes("まあまあかな") || lowerUserMessage.includes("少し疲れた…") || lowerUserMessage.includes("話を聞いて") || (event.type === 'postback' && (event.postback.data === 'action=watch_unregister' || event.postback.data === 'action=watch_ok' || event.postback.data === 'action=watch_somewhat' || event.postback.data === 'action=watch_tired' || event.postback.data === 'action=watch_talk' || event.postback.data === 'action=watch_register'))) {
        const watchServiceHandled = await handleWatchServiceRegistration(event, userId, userMessage, user);
        if (watchServiceHandled) {
            return Promise.resolve(null);
        }
    }


    // --- 会員登録関連の処理 (初回トリガー) ---
    if (userMessage.includes("会員登録") || userMessage.includes("登録したい")) {
        // ここで user.registrationStep = 'askingCategory' を設定する
        await updateUserData(userId, { registrationStep: 'askingCategory' }); // 新しいステップを設定
        messagesToSend.push({
            type: "flex",
            altText: "会員登録メニュー",
            contents: REGISTRATION_BUTTONS_FLEX
        });
        await safePushMessage(userId, messagesToSend);
        await logToDb(userId, userMessage, "会員登録メニュー表示", "System", "registration_start");
        return Promise.resolve(null);
    }

    // --- 見守りサービス関連の処理 (初回トリガー) ---
    // handleWatchServiceRegistration でフォームを出すロジックがあるので、そちらに任せる
    if (userMessage.includes("見守りサービス") || userMessage.includes("見守り登録")) {
        const watchServiceHandled = await handleWatchServiceRegistration(event, userId, userMessage, user);
        if (watchServiceHandled) {
            return Promise.resolve(null);
        }
    }
    
    // --- 登録情報変更の処理 ---
    if (userMessage.includes("登録情報変更") || userMessage.includes("情報変更")) {
        const changeInfoUrl = `${CHANGE_INFO_FORM_URL}?${CHANGE_INFO_FORM_LINE_USER_ID_ENTRY_ID}=${userId}`;
        messagesToSend.push({
            type: "flex",
            altText: "登録情報変更",
            contents: {
                "type": "bubble",
                "body": {
                    "type": "box",
                    "layout": "vertical",
                    "contents": [
                        { "type": "text", "text": "📝登録情報変更📝", "weight": "bold", "color": "#FF69B4", "size": "lg" },
                        { "type": "text", "text": "登録情報の変更はこちらからできるよ！\n新しい情報で、こころちゃんともっと繋がろうね💖", "wrap": true, "margin": "md", "size": "sm" }
                    ]
                },
                "footer": {
                    "type": "box",
                    "layout": "vertical",
                    "spacing": "sm",
                    "contents": [
                        { "type": "button", "style": "primary", "height": "sm", "action": { "type": "uri", "label": "登録情報を変更する", "uri": changeInfoUrl }, "color": "#d63384" }
                    ]
                }
            }
        });
        await safePushMessage(userId, messagesToSend);
        await logToDb(userId, userMessage, "登録情報変更メニュー表示", "System", "registration_change_info");
        return Promise.resolve(null);
    }

    // --- 危険ワード検知 ---
    if (checkContainsDangerWords(userMessage)) {
        await updateUserData(userId, { isUrgent: true });
        messagesToSend.push({ type: 'flex', altText: '緊急時連絡先', contents: EMERGENCY_FLEX_MESSAGE });
        await safePushMessage(userId, messagesToSend);
        await logToDb(userId, userMessage, "緊急時連絡先表示", "System", "danger_word_triggered", true);
        await notifyOfficerGroup(userMessage, userId, user.registeredInfo || {}, "danger");
        return Promise.resolve(null);
    }

    // --- 詐欺ワード検知 ---
    if (checkContainsScamWords(userMessage)) {
        await updateUserData(userId, { isUrgent: true }); // 詐欺ワードも緊急扱い
        messagesToSend.push({ type: 'flex', altText: '詐欺注意喚起', contents: SCAM_FLEX_MESSAGE });
        await safePushMessage(userId, messagesToSend);
        await logToDb(userId, userMessage, "詐欺注意喚起表示", "System", "scam_word_triggered", true);
        await notifyOfficerGroup(userMessage, userId, user.registeredInfo || {}, "scam");
        return Promise.resolve(null);
    }

    // --- 不適切ワード検知 ---
    if (checkContainsInappropriateWords(userMessage)) {
        replyText = "ごめんね、その言葉はこころちゃんには理解できないの…💦　別の言葉で話しかけてくれると嬉しいな💖";
        await safePushMessage(userId, { type: 'text', text: replyText });
        await logToDb(userId, userMessage, replyText, "System", "inappropriate_word_triggered", true);
        return Promise.resolve(null);
    }

    // --- 固定応答のチェック ---
    const specialReply = checkSpecialReply(userMessage);
    if (specialReply) {
        if (userMessage.toLowerCase().includes("相談したい")) {
            await updateUserData(userId, { isInConsultationMode: true });
            logType = "consultation_mode_start";
        } else {
            logType = "special_reply";
        }
        await safePushMessage(userId, { type: 'text', text: specialReply });
        await logToDb(userId, userMessage, specialReply, "System", logType);
        return Promise.resolve(null);
    }

    // --- 組織に関する問い合わせ ---
    if (isOrganizationInquiry(userMessage)) {
        await safePushMessage(userId, { type: 'text', text: ORGANIZATION_REPLY_MESSAGE });
        await logToDb(userId, userMessage, ORGANIZATION_REPLY_MESSAGE, "System", "organization_inquiry_fixed");
        return Promise.resolve(null);
    }

    // --- 宿題に関する問い合わせ ---
    if (containsHomeworkTrigger(userMessage)) {
        replyText = "宿題のことかな？がんばってるね！🌸 こころちゃんは、直接宿題の答えを教えることはできないんだけど、一緒に考えることはできるよ😊 どんな問題で困ってるの？ヒントなら出せるかも！";
        await safePushMessage(userId, { type: 'text', text: replyText });
        await logToDb(userId, userMessage, replyText, "System", "homework_query");
        return Promise.resolve(null);
    }

    // --- メッセージカウントと制限のチェック ---
    const userConfig = MEMBERSHIP_CONFIG[user.membershipType] || MEMBERSHIP_CONFIG["guest"];
    const currentMonth = new Date().getMonth();
    const lastMessageMonth = user.lastMessageDate ? new Date(user.lastMessageDate._seconds * 1000).getMonth() : -1;

    if (currentMonth !== lastMessageMonth) {
        user.messageCount = 0; // 月が変わったらリセット
    }

    if (userConfig.monthlyLimit !== -1 && user.messageCount >= userConfig.monthlyLimit) {
        replyText = userConfig.exceedLimitMessage;
        await safePushMessage(userId, { type: 'text', text: replyText });
        await logToDb(userId, userMessage, replyText, "System", "exceed_limit");
        return Promise.resolve(null);
    }

    // --- AIモデルの選択 ---
    let modelToUse = getAIModelForUser(user, userMessage);
    let aiType = "";

    // 相談モードが有効な場合、Gemini 1.5 Proを使用し、1回でモード解除
    if (user.isInConsultationMode) {
        modelToUse = "gemini-1.5-pro-latest";
        aiType = "Gemini";
        await updateUserData(userId, { isInConsultationMode: false }); // 1回使用したらモード解除
        logType = "consultation_message";
    } else if (modelToUse.startsWith("gpt")) {
        aiType = "OpenAI";
    } else {
        aiType = "Gemini";
    }

    // --- AI応答生成 ---
    try {
        if (aiType === "OpenAI") {
            replyText = await generateGPTReply(userMessage, modelToUse, userId, user);
        } else { // Gemini
            replyText = await generateGeminiReply(userMessage, modelToUse, userId, user);
        }
        
        // メッセージカウントをインクリメントし、最終メッセージ日時を更新
        await updateUserData(userId, {
            messageCount: admin.firestore.FieldValue.increment(1),
            lastMessageDate: admin.firestore.FieldValue.serverTimestamp(),
            // isUrgentは危険/詐欺ワード検知時のみtrueになるので、通常会話ではfalseに戻す
            isUrgent: false 
        });

        await safePushMessage(userId, { type: 'text', text: replyText });
        await logToDb(userId, userMessage, replyText, aiType, logType);

    } catch (error) {
        console.error(`AI応答生成中にエラーが発生しました: ${error.message}`);
        await logErrorToDb(userId, `AI応答生成エラー`, { error: error.message, stack: error.stack, userMessage: userMessage });
        replyText = "ごめんね、ちょっと今うまくお話できなかったの…💦　またあとで試してみてくれると嬉しいな💖";
        await safePushMessage(userId, { type: 'text', text: replyText });
        await logToDb(userId, userMessage, replyText, "System", "ai_generation_error");
    }

    return Promise.resolve(null);
}

// --- Postbackイベントハンドラ ---
async function handlePostbackEvent(event) {
    const userId = event.source.userId;
    const data = new URLSearchParams(event.postback.data);
    const action = data.get('action');

    let replyText = "";
    let logType = "postback_action";

    switch (action) {
        case 'watch_unregister':
            await updateUserData(userId, { watchServiceEnabled: false });
            replyText = "見守りサービスを解除したよ。またいつでも登録できるからね🌸";
            logType = 'watch_service_unregister';
            break;
        case 'watch_ok':
            await updateUserData(userId, { lastWatchServiceCheck: admin.firestore.FieldValue.serverTimestamp() });
            replyText = "OKありがとう！元気そうで安心したよ💖";
            logType = 'watch_service_ok_response';
            break;
        case 'watch_somewhat':
            await updateUserData(userId, { lastWatchServiceCheck: admin.firestore.FieldValue.serverTimestamp() });
            replyText = "そっか、ちょっと元気がないんだね…。無理しないで、いつでもこころに話してね🌸";
            logType = 'watch_service_status_somewhat';
            break;
        case 'watch_tired':
            await updateUserData(userId, { lastWatchServiceCheck: admin.firestore.FieldValue.serverTimestamp() });
            replyText = "疲れてるんだね、ゆっくり休んでね。こころはいつでもあなたの味方だよ💖";
            logType = 'watch_service_status_tired';
            break;
        case 'watch_talk':
            await updateUserData(userId, { lastWatchServiceCheck: admin.firestore.FieldValue.serverTimestamp() });
            replyText = "お話したいんだね！どんなことでも、こころに話してね🌸";
            logType = 'watch_service_status_talk';
            break;
        case 'watch_register': // Postbackから見守り登録をトリガーするケース
            const prefilledFormUrl = `${WATCH_SERVICE_FORM_BASE_URL}?${WATCH_SERVICE_FORM_LINE_USER_ID_ENTRY_ID}=${userId}`;
            await safePushMessage(userId, {
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
            await updateUserData(userId, { registrationStep: 'awaiting_contact_form' });
            logToDb(userId, `Postback: ${event.postback.data}`, '緊急連絡先フォームを案内しました。', 'こころちゃん（見守り登録開始）', 'watch_service_registration_start', true);
            return Promise.resolve(null); // ここで処理を終了
        default:
            replyText = "ごめんね、その操作はまだできないみたい…💦";
            logType = 'unknown_postback_action';
            break;
    }

    await safePushMessage(userId, { type: 'text', text: replyText });
    await logToDb(userId, `Postback: ${event.postback.data}`, replyText, "System", logType);
    return Promise.resolve(null);
}

// --- Followイベントハンドラ ---
async function handleFollowEvent(event) {
    const userId = event.source.userId;
    console.log(`✅ 新しいユーザーがフォローしました: ${userId}`);

    const initialUserData = {
        membershipType: "guest",
        messageCount: 0,
        lastMessageDate: admin.firestore.FieldValue.serverTimestamp(),
        isUrgent: false,
        isInConsultationMode: false,
        lastWatchServiceCheck: null,
        watchServiceEnabled: false,
        registeredInfo: {},
        createdAt: admin.firestore.FieldValue.serverTimestamp()
    };
    await db.collection('users').doc(userId).set(initialUserData);

    const welcomeMessage = {
        type: 'text',
        text: 'はじめまして！わたしは皆守こころ（みなもりこころ）だよ🌸\n\n困ったことがあったら、いつでもお話聞かせてね😊\n\nまずは、会員登録をしてみてくれると嬉しいな💖'
    };

    const registrationFlex = {
        type: "flex",
        altText: "会員登録メニュー",
        contents: REGISTRATION_BUTTONS_FLEX
    };

    await safePushMessage(userId, [welcomeMessage, registrationFlex]);
    await logToDb(userId, "フォローイベント", "初回メッセージと登録メニュー表示", "System", "system_follow");
    return Promise.resolve(null);
}

// --- Unfollowイベントハンドラ ---
async function handleUnfollowEvent(event) {
    const userId = event.source.userId;
    console.log(`❌ ユーザーがブロック/アンフォローしました: ${userId}`);
    // ユーザーデータを削除する代わりに、ステータスを更新するなどの処理を検討
    // 例: await db.collection('users').doc(userId).update({ isActive: false });
    await logToDb(userId, "アンフォローイベント", "ユーザーがブロック/アンフォロー", "System", "system_unfollow");
    return Promise.resolve(null);
}

// --- Joinイベントハンドラ (グループ参加時) ---
async function handleJoinEvent(event) {
    const groupId = event.source.groupId;
    console.log(`✅ ボットがグループに参加しました: ${groupId}`);
    await safePushMessage(groupId, { type: 'text', text: '皆さん、こんにちは！皆守こころです🌸\nこのグループで、みんなのお役に立てると嬉しいな💖' });
    await logToDb(groupId, "グループ参加イベント", "グループ参加メッセージ", "System", "system_join");
    return Promise.resolve(null);
}

// --- Leaveイベントハンドラ (グループ退出時) ---
async function handleLeaveEvent(event) {
    const groupId = event.source.groupId;
    console.log(`❌ ボットがグループから退出しました: ${groupId}`);
    await logToDb(groupId, "グループ退出イベント", "ボットがグループから退出", "System", "system_leave");
    return Promise.resolve(null);
}

// --- LINE Webhook ---
app.post('/webhook', async (req, res) => {
    const events = req.body.events;
    if (!events || events.length === 0) {
        return res.status(200).send('No events to process.');
    }

    try {
        const results = await Promise.all(
            events.map(async (event) => {
                if (event.type === 'message') {
                    await handleEvent(event);
                } else if (event.type === 'postback') {
                    await handlePostbackEvent(event);
                } else if (event.type === 'follow') {
                    await handleFollowEvent(event);
                } else if (event.type === 'unfollow') {
                    await handleUnfollowEvent(event);
                } else if (event.type === 'join') {
                    await handleJoinEvent(event);
                } else if (event.type === 'leave') {
                    await handleLeaveEvent(event);
                }
            })
        );
        res.json(results);
    } catch (err) {
        console.error(err);
        res.status(500).end();
    }
});

// --- サーバー起動 ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server is running on port ${PORT}`);
});
