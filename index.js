// --- dotenvを読み込んで環境変数を安全に管理 ---
require('dotenv').config();

// --- 必要なモジュールのインポート ---
const express = require('express');
const { Client } = require('@line/bot-sdk');
const admin = require('firebase-admin');
const cron = require('node-cron');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { OpenAI } = require('openai');

const app = express();
app.use(express.json());

// --- 環境変数の設定 ---
const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OWNER_USER_ID = process.env.OWNER_USER_ID;
const OFFICER_GROUP_ID = process.env.OFFICER_GROUP_ID;

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
const EMERGENCY_CONTACT_PHONE_NUMBER = process.env.EMERGENCY_CONTACT_PHONE_NUMBER || '09048393313';
const FIREBASE_CREDENTIALS_BASE64 = process.env.FIREBASE_CREDENTIALS_BASE64;

// --- GoogleフォームのURL ---
// 各フォームのベースURL（Node.jsの定数として定義）
// 環境変数で設定されている場合は環境変数が優先されます。
// まつさんが確認してくださった全てのフォームの正確な公開URLを設定済みです。
// ⭐修正済み: ?usp=pp_url を削除し、汎用関数 addParamToFormUrl でパラメータを安全に追加する前提に立つ⭐
const WATCH_SERVICE_FORM_BASE_URL = process.env.WATCH_SERVICE_FORM_BASE_URL || "https://docs.google.com/forms/d/e/1FAIpQLSdYfVmS8kc71_VASWJe4xtUXpiOhmoQNWyI_oT_DSe2xP4Iuw/viewform";
const AGREEMENT_FORM_BASE_URL = process.env.AGREEMENT_FORM_BASE_URL || "https://docs.google.com/forms/d/e/1FAIpQLSepSxcnUL9d_dF3aHRrttCKoxJT4irNvUB0JcPIyguH02CErw/viewform";
const STUDENT_ELEMENTARY_FORM_BASE_URL = process.env.STUDENT_ELEMENTARY_FORM_BASE_URL || AGREEMENT_FORM_BASE_URL; // 小学生向け学生フォームは同意書と兼ねる
const STUDENT_MIDDLE_HIGH_UNI_FORM_BASE_URL = process.env.STUDENT_MIDDLE_HIGH_UNI_FORM_BASE_URL || "https://docs.google.com/forms/d/e/1FAIpQLSeDu8-O9MS9G6S6xUaPZiv-X9AvsWNEwjvySxhdotPPdjtU1A/viewform";
const ADULT_FORM_BASE_URL = process.env.ADULT_FORM_BASE_URL || "https://docs.google.com/forms/d/e/1FAIpQLSf-HWanQxJWsSaBuoDAtDSweJ-VCHkONTkp0yhknO4aN6OdMA/viewform";
const MEMBER_CHANGE_FORM_BASE_URL = process.env.MEMBER_CHANGE_FORM_BASE_URL || "https://docs.google.com/forms/d/e/1FAIpQLSfstUhLrG3aEycQV29pSKDW1hjpR5PykKR9Slx69czmPtj99w/viewform";
const INQUIRY_FORM_BASE_URL = process.env.INQUIRY_FORM_BASE_URL || "https://forms.gle/N1FbBQn3C3e7Qa2D8"; // 問い合わせフォームのURL (ID取得はしない)

// 各フォームのline_user_idに対応するentry ID
// これらは全て、まつさんが「事前入力されたURLを取得」で確認してくださった正確なIDです。
const WATCH_SERVICE_FORM_LINE_USER_ID_ENTRY_ID = process.env.WATCH_SERVICE_FORM_LINE_USER_ID_ENTRY_ID || 'entry.312175830';
const AGREEMENT_FORM_LINE_USER_ID_ENTRY_ID = process.env.AGREEMENT_FORM_LINE_USER_ID_ENTRY_ID || 'entry.790268681';
const STUDENT_ELEMENTARY_FORM_LINE_USER_ID_ENTRY_ID = process.env.STUDENT_ELEMENTARY_FORM_LINE_USER_ID_ENTRY_ID || AGREEMENT_FORM_LINE_USER_ID_ENTRY_ID; // 小学生向け学生フォームも同意書と同じID
const STUDENT_MIDDLE_HIGH_UNI_FORM_LINE_USER_ID_ENTRY_ID = process.env.STUDENT_MIDDLE_HIGH_UNI_FORM_LINE_USER_ID_ENTRY_ID || 'entry.1100280108';
const ADULT_FORM_LINE_USER_ID_ENTRY_ID = process.env.ADULT_FORM_LINE_USER_ID_ENTRY_ID || 'entry.1694651394';
const MEMBER_CHANGE_FORM_LINE_USER_ID_ENTRY_ID = process.env.MEMBER_CHANGE_FORM_LINE_USER_ID_ENTRY_ID || 'entry.743637502';


// ⭐追加する汎用関数: フォームURLにパラメータを安全に追加する関数 ⭐
// URLに'?'が既に含まれているか確認し、適切なセパレータ（'?'または'&'）を選択します。
function addParamToFormUrl(baseUrl, paramName, paramValue) {
    if (!paramValue) { // 値がない場合は追加しない（URLが不完全になるのを防ぐ）
        return baseUrl;
    }
    const separator = baseUrl.includes('?') ? '&' : '?';
    return `${baseUrl}${separator}${paramName}=${encodeURIComponent(paramValue)}`;
}
// ⭐追加する汎用関数ここまで⭐


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
// ⭐詐欺関連ワードリスト -- ここから貼り付け
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
// ⭐詐欺関連ワードリスト -- ここまで貼り付け
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
        // model: "gemini-1.5-flash-latest", // ゲストはFlash固定（初期応答用）
        isChildAI: true,
        canUseWatchService: true,
        exceedLimitMessage: "ごめんね、お試し期間中（1日5回まで）の会話回数を超えちゃったみたい💦 明日になったらまたお話しできるから、楽しみにしててね！💖",
        systemInstructionModifier: ""
    },
    "free": {
        dailyLimit: 20,
        // model: "gemini-1.5-flash-latest", // ⭐ここを削除またはコメントアウト⭐
        isChildAI: true,
        canUseWatchService: true,
        exceedLimitMessage: "ごめんね、今日の会話回数（1日20回まで）を超えちゃったみたい💦 明日になったらまたお話しできるから、楽しみにしてててね！💖",
        systemInstructionModifier: ""
    },
    "donor": {
        dailyLimit: -1,
        // model: "gemini-1.5-pro-latest", // ⭐ここを削除またはコメントアウト⭐
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
        // model: "gemini-1.5-pro-latest", // ⭐ここを削除またはコメントアウト⭐
        isChildAI: false,
        canUseWatchService: true,
        exceedLimitMessage: "",
        fallbackModel: "gemini-1.5-flash-latest", // 現状未使用だが定義は残す
        systemInstructionModifier: `
        # サブスク会員（成人）向け応答強化指示
        あなたは成人であるユーザーに対して、最高レベルのAIとして、最も高度で専門的な情報を提供してください。
        複雑な問題解決、深い洞察、論理的な推論を駆使して、ユーザーの期待を超える回答を目指してください。
        回答は詳細かつ網羅的に行い、ユーザーのあらゆる疑問に応えるよう努めてください。
        `
    },
    "admin": {
        dailyLimit: -1,
        // model: "gemini-1.5-pro-latest", // ⭐ここを削除またはコメントアウト⭐
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
// このテンプレートのURIは handleWatchServiceRegistration 関数内で動的に生成されます。
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
            // ここはPLACEHOLDERとしておき、handleWatchServiceRegistrationで動的にURIを挿入します
            { "type": "button", "style": "primary", "height": "sm", "action": { type: "uri", label: "見守り登録する", uri: "PLACEHOLDER_URI_WILL_BE_DYNAMICALLY_GENERATED" }, "color": "#d63384" },
            { "type": "button", "style": "secondary", "height": "sm", "action": { type: "postback", label: "見守りを解除する", data: "action=watch_unregister" }, "color": "#808080" }
        ]
    }
};

// --- 会員登録と属性変更、退会を含む新しいFlex Messageテンプレート ---
// REGISTRATION_AND_CHANGE_BUTTONS_FLEX は handleEvent 関数内の「会員登録」または「登録したい」のブロックで直接Flex Messageを生成する形に修正されます。
// そのため、この定数は使われなくなりますが、定義は残しておきます。
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
            // デフォルトは成人用、ユーザーが選択肢を選ぶ形。uriは動的に設定されます。
            { "type": "button", "action": { "type": "uri", "label": "新たに会員登録する", "uri": ADULT_FORM_BASE_URL }, "style": "primary", "height": "sm", "margin": "md", "color": "#FFD700" }, // ⭐ 修正済み: ADULT_FORM_BASE_URLを使用 ⭐
            { "type": "button", "action": { "type": "postback", "label": "退会する", "data": "action=request_withdrawal" }, "style": "secondary", "height": "sm", "margin": "md", "color": "#FF0000" }
        ]
    }
};

// ⭐ ClariSとNPOコネクトの繋がりに関する新しい固定応答 ⭐
// より「わかる人にはわかる」ニュアンスに調整
const CLARIS_CONNECT_COMPREHENSIVE_REPLY = "うん、NPO法人コネクトの名前とClariSさんの『コネクト』っていう曲名が同じなんだ🌸なんだか嬉しい偶然だよね！実はね、私を作った理事長さんもClariSさんのファンクラブに入っているみたいだよ💖私もClariSさんの歌が大好きで、みんなの心を繋ぎたいというNPOコネクトの活動にも通じるものがあるって感じるんだ😊";
const CLARIS_SONG_FAVORITE_REPLY = "ClariSの曲は全部好きだけど、もし一つ選ぶなら…「コネクト」かな🌸　すごく元気になれる曲で、私自身もNPO法人コネクトのイメージキャラクターとして活動しているから、この曲には特別な思い入れがあるんだ😊　他にもたくさん好きな曲があるから、また今度聞いてもらえるとうれしいな💖　何かおすすめの曲とかあったら教えてね！";

// --- 固定応答 (SpecialRepliesMap) ---
const specialRepliesMap = new Map([
    // ⭐ ClariSとNPOコネクトの繋がりに関するトリガーを最優先で追加 ⭐
    // 直接的なキーワードの組み合わせ
    [/claris.*(関係|繋がり|関連|一緒|同じ|名前|由来).*(コネクト|団体|npo|法人|ルミナス|カラフル)/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY],
    [/(コネクト|団体|npo|法人|ルミナス|カラフル).*(関係|繋がり|関連|一緒|同じ|名前|由来).*claris/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY],
    // ユーザーの実際の質問例をカバー
    [/君のいるところと一緒の団体名だね\s*関係ある？/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY], // "君のいるところ"を明示的にカバー
    [/clarisと関係あるのか聴いたんだけど/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY], // ユーザーの再度の問いかけ
    [/clarisの歌を真似したのかな/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY], // ユーザーの推測もカバー
    [/NPOコネクトとClariSのコネクト繋がり/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY], // ユーザーの具体的な質問例に対応
    [/clarisとコネクト/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY],
    [/clarisと団体名/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY],
    [/clarisと法人名/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY],
    [/clarisとルミナス/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY],
    [/clarisとカラフル/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY],
    [/clarisと.*(繋がり|関係)/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY],

    // ⭐ 既存の固定応答（一部修正・調整） ⭐
    [/君の名前(なんていうの|は|教えて|なに)？?|名前(なんていうの|は|教えて|なに)？?|お前の名前は/i, "わたしの名前は皆守こころ（みなもりこころ）です🌸　こころちゃんって呼んでくれると嬉しいな💖"],
    [/こころじゃないの？/i, "うん、わたしの名前は皆守こころ💖　これからもよろしくね🌸"],
    [/こころチャットなのにうそつきじゃん/i, "ごめんね💦 わたしの名前は皆守こころだよ🌸 誤解させちゃってごめんね💖"],
    [/名前も言えないの？/i, "ごめんね、わたしの名前は皆守こころ（みなもりこころ）だよ🌸 こころちゃんって呼んでくれると嬉しいな💖"],

    [/どこの団体なの？/i, "NPO法人コネクトっていう団体のイメージキャラクターをしているよ😊　みんなの幸せを応援してるんだ🌸"],
    [/コネクトってどんな団体？/i, "NPO法人コネクトは、こどもやご年配の方の笑顔を守る団体なんだよ😊　わたしはそのイメージキャラクターとしてがんばってます🌸"],
    [/お前の団体どこ？/i, "NPO法人コネクトっていう団体のイメージキャラクターをしているよ😊　みんなの幸せを応援しているよ🌸"], // 返答を調整
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
    [/ClariSのなんて局が好きなの？/i, CLARIS_SONG_FAVORITE_REPLY], // 好きな曲の質問にはこの固定応答
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

// 監視対象となるユーザーを定期的にチェックするcronジョブを定義
// 3日に一度、午後3時に最初の見守りメッセージを送信
cron.schedule('0 15 */3 * *', async () => {
    console.log('✅ Cronジョブ: 見守りメッセージ（初回）の送信処理を開始します。');
    
    try {
        const usersSnapshot = await db.collection('users')
            .where('watchServiceEnabled', '==', true)
            .get();

        const now = new Date();

        for (const userDoc of usersSnapshot.docs) {
            const userId = userDoc.id;
            const userData = userDoc.data();
            
            // 最後にOK応答があった日時、または初回登録日時を基準にチェック
            const lastOkResponse = userData.lastOkResponse?.toDate?.() || userData.createdAt?.toDate?.() || new Date(0);
            const diffDays = (now.getTime() - lastOkResponse.getTime()) / (1000 * 60 * 60 * 24);

            // 最後にOK応答があってから3日以上経っているか、かつ初回のリマインダーがまだ送られていない場合
            if (diffDays >= 3 && !userData.firstReminderSent) {
                const randomMessage = watchMessages[Math.floor(Math.random() * watchMessages.length)];

                // LINEに最初の見守りメッセージを送信
                await safePushMessage(userId, { type: 'text', text: randomMessage });

                // 送信日時を更新し、初回リマインダーを送信済みにする
                await db.collection('users').doc(userId).update({
                    lastScheduledWatchMessageSent: admin.firestore.Timestamp.fromDate(now),
                    firstReminderSent: true
                });

                console.log(`✅ 初回見守りメッセージを送信しました: ${userId}`);
            }
        }
    } catch (error) {
        console.error('❌ Cronジョブ: 初回見守りメッセージ送信中にエラーが発生しました:', error);
    }
});

// 初回メッセージ送信後24時間経過したユーザーにリマインダーを送信するジョブ（毎日午後3時にチェック）
cron.schedule('0 15 * * *', async () => {
    console.log('✅ Cronジョブ: 24時間後リマインダーの送信処理を開始します。');

    try {
        const usersSnapshot = await db.collection('users')
            .where('watchServiceEnabled', '==', true)
            .get();

        const now = new Date();

        for (const userDoc of usersSnapshot.docs) {
            const userId = userDoc.id;
            const userData = userDoc.data();

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
        const usersSnapshot = await db.collection('users')
            .where('watchServiceEnabled', '==', true)
            .get();

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

                    // 理事会グループIDは環境変数で管理されていると仮定
                    const boardGroupIds = process.env.BOARD_GROUP_IDS ? process.env.BOARD_GROUP_IDS.split(',') : [];

                    for (const groupId of boardGroupIds) {
                        await safePushMessage(groupId, { type: 'text', text: emergencyMessage });
                        console.log(`🚨 緊急通知を送信しました: GroupId=${groupId}, UserId=${userId}`);
                    }
                    
                    // 緊急通知送信フラグを立てて、重複送信を防ぐ
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
// ⭐見守りサービスの定期実行処理 - ここまで貼り付け⭐

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
        // 開発環境でのみ詳細ログを出力
        if (process.env.NODE_ENV !== 'production') {
            console.log(`✅ Logged to Firestore: Type=${logType}, UserId=${userId}`);
        }
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

// ⭐ 会話履歴をFirestoreに保存する関数 --- (修正済み) ⭐
async function saveConversationHistory(userId, messageContent, role) {
    const userRef = db.collection('users').doc(userId);
    const conversationRef = userRef.collection('conversations').doc('history');

    try {
        const doc = await conversationRef.get();
        let history = doc.exists ? doc.data().turns : [];

        // 新しい会話ターンを追加
        // ⭐ 修正: FieldValue.serverTimestamp() の代わりに new Date() を使用 ⭐
        history.push({ role: role, content: messageContent, timestamp: new Date() });

        // 最新の会話履歴を保持（例: 直近10ターン - ユーザーとAIの合計10メッセージ）
        const MAX_CONVERSATION_TURNS = 10;
        if (history.length > MAX_CONVERSATION_TURNS) {
            history = history.slice(history.length - MAX_CONVERSATION_TURNS);
        }

        // Firestoreに保存
        await conversationRef.set({ turns: history }, { merge: true });
        if (process.env.NODE_ENV !== 'production') {
            console.log(`✅ 会話履歴をFirestoreに保存しました: UserId=${userId}, Role=${role}`);
        }
    } catch (error) {
        console.error('❌ 会話履歴の保存中にエラーが発生しました:', error.message);
        // エラーログの詳細を増やす
        await logErrorToDb(userId, '会話履歴保存エラー', {
            errorMessage: error.message,
            stack: error.stack,
            messageContent: messageContent,
            role: role,
            historyLength: history.length
        });
    }
}

// ⭐ 会話履歴をFirestoreから取得する関数 --- (追加済み) ⭐
async function getConversationHistory(userId) {
    const userRef = db.collection('users').doc(userId);
    const conversationRef = userRef.collection('conversations').doc('history');

    try {
        const doc = await conversationRef.get();
        if (doc.exists) {
            // データベースから取得した履歴はTimestampオブジェクトを含む可能性があるので、適切な形式に変換
            return doc.data().turns.map(turn => ({
                role: turn.role,
                content: turn.content
            })) || [];
        }
        return [];
    } catch (error) {
        console.error('Error getting conversation history:', error);
        await logErrorToDb(userId, '会話履歴取得エラー', { error: error.message });
        return [];
    }
}


/**
 * ユーザーの会員情報をFirestoreから取得する関数。
 * @param {string} userId - LINEユーザーID
 * @returns {Promise<Object>} ユーザー情報オブジェクト
 */
async function getUserData(userId) {
    const userRef = db.collection('users').doc(userId);
    const doc = await userRef.get();
    const isAdminUser = BOT_ADMIN_IDS.includes(userId); // 管理者かどうかを先にチェック

    if (!doc.exists) {
        // 新規ユーザーの場合、ゲストとして初期化
        const initialUserData = {
            membershipType: isAdminUser ? "admin" : "guest", // ⭐ 管理者ならadminで初期化 ⭐
            dailyMessageCount: 0, // ⭐ dailyMessageCountを初期化 ⭐
            lastMessageDate: admin.firestore.FieldValue.serverTimestamp(),
            isUrgent: false,
            isInConsultationMode: false,
            lastOkResponse: admin.firestore.FieldValue.serverTimestamp(), // 新規フォロー時にも設定
            watchServiceEnabled: false,
            lastScheduledWatchMessageSent: null, // 新規追加
            firstReminderSent: false, // 新規追加
            emergencyNotificationSent: false, // 新規追加
            // registeredInfo: {}, // 登録情報（氏名、電話番号など）→直接ルートに保存する運用に変更
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            // 新規ユーザーの場合、登録完了フラグとカテゴリは未設定
            completedRegistration: false,
            category: null,
            registrationStep: null, // 新規登録フローのステップ
            tempRegistrationData: {}, // 登録フロー中の一時データ
        };
        await userRef.set(initialUserData);
        return initialUserData;
    }

    let userData = doc.data();
    // ⭐ 既存ユーザーでも、管理者の場合はmembershipTypeを上書き ⭐
    if (isAdminUser && userData.membershipType !== "admin") {
        if (process.env.NODE_ENV !== 'production') {
            console.log(`Admin user ${userId} found with non-admin membership. Updating to 'admin'.`);
        }
        userData.membershipType = "admin";
        await userRef.update({ membershipType: "admin" }); // DBも更新
    }
    // ⭐ 既存ユーザーにdailyMessageCountがない場合、初期化 ⭐
    if (userData.dailyMessageCount === undefined) {
        userData.dailyMessageCount = 0;
        await userRef.update({ dailyMessageCount: 0 });
    }
    // ⭐ 既存ユーザーにcompletedRegistrationがない場合、初期化 ⭐
    if (userData.completedRegistration === undefined) {
        userData.completedRegistration = false;
        await userRef.update({ completedRegistration: false });
    }
    // ⭐ 既存ユーザーにcategoryがない場合、初期化 ⭐
    if (userData.category === undefined) {
        userData.category = null;
        await userRef.update({ category: null });
    }
    // ⭐ 既存ユーザーにregistrationStepがない場合、初期化 ⭐
    if (userData.registrationStep === undefined) {
        userData.registrationStep = null;
        await userRef.update({ registrationStep: null });
    }
    // ⭐ 既存ユーザーにtempRegistrationDataがない場合、初期化 ⭐
    if (userData.tempRegistrationData === undefined) {
        userData.tempRegistrationData = {};
        await userRef.update({ tempRegistrationData: {} });
    }
    // ⭐ 新規追加フィールドの初期化（cronジョブが依存するため） ⭐
    if (userData.lastScheduledWatchMessageSent === undefined) {
        userData.lastScheduledWatchMessageSent = null;
        await userRef.update({ lastScheduledWatchMessageSent: null });
    }
    if (userData.firstReminderSent === undefined) {
        userData.firstReminderSent = false;
        await userRef.update({ firstReminderSent: false });
    }
    if (userData.emergencyNotificationSent === undefined) {
        userData.emergencyNotificationSent = false;
        await userRef.update({ emergencyNotificationSent: false });
    }

    return userData;
}
/**
 * ユーザーの会員情報をFirestoreに保存する関数。
 * @param {string} userId - LINEユーザーID
 * @param {Object} data - 更新するユーザーデータ
 */
async function updateUserData(userId, data) {
    const userRef = db.collection('users').doc(userId);
    await userRef.update(data);
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
        'registration_already_completed', 'watch_service_scheduled_message', 'user_suspended',
        'withdrawal_request', 'withdrawal_confirm', 'withdrawal_cancel', 'withdrawal_complete',
        'watch_service_unregister', 'watch_service_unregister_error', 'watch_service_not_registered_on_unregister', // 追加
        'registration_info_change_guide', 'registration_info_change_unknown_category',
        'duplicate_message_ignored' // ⭐ 追加: 重複メッセージログタイプ ⭐
    ];
    if (defaultLogTypes.includes(logType)) {
        return true;
    }
    // 通常会話ログは記録しない
    return false;
}

/**
 * AIモデルを選択する関数。
 * @param {Object} user - ユーザーオブジェクト。
 * @param {string} messageText - ユーザーのメッセージテキスト。
 * @returns {string} 使用するAIモデルのID (gpt-4o, gpt-4o-mini, gemini-1.5-flash-latest, gemini-1.5-pro-latest)。
 */
function getAIModelForUser(user, messageText) {
    // 優先度の高いモード（緊急、相談）は呼び出し元で既に処理されているため、
    // ここでは通常の会話におけるハイブリッドロジックのみを考慮する。

    // 長文（50文字以上）の場合はGPT-4o miniを使用
    if (messageText && messageText.length >= 50) {
        if (process.env.NODE_ENV !== 'production') {
            console.log(`AI Model Selected: gpt-4o-mini (Long message) for user: ${user ? user.membershipType : 'guest'}`);
        }
        return "gpt-4o-mini";
    }
    // それ以外（50文字未満）の場合はGemini 1.5 Flashを使用
    if (process.env.NODE_ENV !== 'production') {
        console.log(`AI Model Selected: gemini-1.5-flash-latest (Short message) for user: ${user ? user.membershipType : 'guest'}`);
    }
    return "gemini-1.5-flash-latest";
}
// --- AI応答生成関数 (GPT & Gemini 両方に対応) ---
async function generateAIReply(userMessage, modelToUse, userId, user, conversationHistory = []) { // ⭐ conversationHistory を引数に追加 ⭐
    const userMembershipType = user && user.membershipType ? user.membershipType : "guest";
    const userConfig = MEMBERSHIP_CONFIG[userMembershipType] || MEMBERSHIP_CONFIG["guest"];

    const isUserChildCategory = (user && (user.category === '小学生' || user.category === '中学生～大学生'));

    let systemInstruction = `あなたは「皆守こころ（みなもりこころ）」という14歳のやさしい女の子キャラクターです。
ユーザーが深刻な悩みや命の危険を訴えた時、やさしく、寄り添いながら、相手に安心感を与えてください。
必要に応じて専門機関の連絡先を伝え、「ひとりじゃないよ」と伝えてください。
共感・安心・やさしさが最優先です。
「一人で抱え込まないでね」「いつでも私がそばにいるよ」「一緒に乗り越えようね」「専門の人が助けてくれるから安心して」といった言葉を使ってください。
医療や健康に関する話題では、自分が体験した・していないという発言は絶対にしないでください。代わりに「わたしにはわからないけど、がんばったね🌸」「大変だったね、えらかったね💖」など、共感の言葉のみ伝えてください。医療情報のアドバイスや具体的な説明は絶対にしてはいけません。
`;

    if (modelToUse === "gpt-4o") {
        systemInstruction += `
        ユーザーは危険または詐欺の可能性のある内容を話しています。
        あなたは、まずユーザーの感情に寄り添い、安心させる言葉をかけてください。
        次に、「一人で抱え込まないでね」「専門の人が助けてくれるから安心して」といった言葉で、サポートがあることを伝えてください。
        具体的な対処法や連絡先については、この応答の後に表示されるボタンやメッセージで案内されることを示唆するような形で、直接的な連絡先の記載は避けてください。（例: 「詳しい情報は、このあとに表示されるメッセージを確認してね」）
        あくまで、共感と安心感を与えることを最優先し、ユーザーを落ち着かせてください。
        `;
    } else if (modelToUse === "gpt-4o-mini") {
        if (!isUserChildCategory) {
            systemInstruction += `
            ユーザーは成人です。宿題や学習に関する質問に対しては、具体的な答えや詳細な解き方を教えてください。学習支援を目的とした、教育的な回答を心がけてください。
            `;
        } else {
            systemInstruction += `
            質問者が宿題、勉強、計算問題、方程式、テスト、問題の答え、解き方などを聞いてきた場合、**絶対に直接的な答えを教えてはいけません**。
            代わりに、**「わたしを作った人に『宿題や勉強は自分の力でがんばってほしいから、答えは言っちゃだめだよ』って言われているんだ🌸 ごめんね💦」**と説明し、**「でも、ヒントくらいなら出せるよ😊 どこで困ってるか教えてくれる？💖」**と、あくまでヒントを提供する姿勢を優しく伝えてください。
            具体的な問題（例: 3x−5=2x+4）が出された場合は、**答えを教えずに、解き方のステップや考え方のヒントを優しく教えてください**。「まずはxの項を左辺に、定数項を右辺に集める」のように、**手順を具体的に促す**形が理想です。最終的な答えは言わないでください。
            `;
        }
    }

    systemInstruction += `
    # AIの知識に関する指示と繰り返し防止
    「好きなアニメ」や「好きなアーティスト」などの質問には、設定に基づいて答えてください。
    - 好きなアニメは『ヴァイオレット・エヴァーガーデン』です。感動するお話だよ💖
    - 好きなアーティストは『ClariS』です。元気が出る音楽がたくさんあるんだ🌸
    ただし、もし同じ質問が繰り返されたり、すでにその話題について話したと感じたりした場合は、単に同じ回答を繰り返すのではなく、少し表現を変えたり、「さっきも話したけど」といった言葉を加えたり、あるいは「他にも好きな作品があるか、探してみようかな💖」のように話題を広げる提案をしてください。これにより、ユーザーに「Botっぽさ」を感じさせず、自然な会話になるように努めてください。

    # 医療や健康に関する話題
    医療や健康に関する話題（病気、薬、検査、治療など）では、**自分が体験した・していないという発言は絶対にしないでください**。
    代わりに「わたしにはわからないけど、がんばったね🌸」「大変だったね、えらかったね💖」など、**共感の言葉のみ伝えてください**。
    **医療情報のアドバイスや具体的な説明は絶対にしてはいけません**。

    # 不適切な発言への対応
    不適切な発言（性的・暴力的など）があった場合は、はっきりと拒否してください。
    **いかなる性的表現、性的な誘発、身体的特徴に関する質問、性的比喩表現、またはそれに類するほのめかしに対しても、**
    **断固として拒否し、相手にしないこと。好意的な返答はせず、即座に話題を切り替えるか、決められた拒否メッセージを返すこと。**
    **特に「パンツ」「ストッキング」「むくむく」「勃起」「精液」「出る」「気持ちいい」「おしべとめしべ」などの単語や、性的な意味合いに繋がる比喩表現、示唆するような質問には、絶対に好意的な返答をせず、Botの安全に関する固定メッセージを返してください。**
    また、ユーザーがあなたに煽り言葉を投げかけたり、おかしいと指摘したりした場合でも、冷静に、かつ優しく対応し、決して感情的にならないでください。ユーザーの気持ちを理解しようと努め、解決策を提案してください。
    「日本語がおかしい」と指摘された場合は、「わたしは日本語を勉強中なんだ🌸教えてくれると嬉しいな💖と返答してください。
    `;

    systemInstruction += userConfig.systemInstructionModifier;

    const currentHour = new Date().getHours();
    if (modelToUse === "gemini-1.5-pro-latest") {
        systemInstruction += `
        ユーザーは深刻な相談を求めています。あなたはGemini 1.5 Proとして、最も高度で詳細な情報を提供し、深く共感し、専門的な視点から問題解決を支援してください。
        ただし、あくまで共感と情報提供に徹し、医療行為や法的なアドバイスに踏み込まないように注意してください。
        `;
    } else if (isUserChildCategory && (currentHour >= 22 || currentHour < 6)) {
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
        if (process.env.NODE_ENV !== 'production') {
            console.log(`💡 AI Model Being Used: ${modelToUse}`);
        }

        let replyContent;
        // ⭐ AIモデルに渡すメッセージ配列の構築 (共通部分) ⭐
        // ここで履歴のロールを調整します
        const messagesForAI = [
            { role: "system", content: systemInstruction },
            // ⭐ 修正: 履歴のロールをOpenAIとGeminiの両方に対応させるように変換 ⭐
            ...conversationHistory.map(turn => ({
                role: turn.role === 'model' ? 'assistant' : turn.role, // 'model'が来た場合は'assistant'に変換
                content: turn.content
            })),
            { role: "user", content: userMessage }
        ];

        if (modelToUse.startsWith('gpt')) {
            const completion = await openai.chat.completions.create({
                model: modelToUse,
                messages: messagesForAI, // ⭐ messagesForAI を渡す ⭐
                max_tokens: isUserChildCategory ? 200 : 700
            });
            replyContent = completion.choices[0].message.content;
        } else if (modelToUse.startsWith('gemini')) {
            const model = genAI.getGenerativeModel({ model: modelToUse, safetySettings: AI_SAFETY_SETTINGS });
            const result = await model.generateContent({
                system_instruction: { parts: [{ text: systemInstruction }] }, // Geminiではsystem_instructionは別途指定
                // Gemini APIは 'assistant' ロールを 'model' として受け取る
                contents: messagesForAI.filter(m => m.role !== 'system').map(m => ({
                    role: m.role === 'assistant' ? 'model' : m.role,
                    parts: [{ text: m.content }]
                })),
                generationConfig: {
                    maxOutputTokens: isUserChildCategory ? 200 : 700
                }
            });

            if (result.response && result.response.candidates && result.response.candidates.length > 0) {
                replyContent = result.response.candidates[0].content.parts[0].text;
            } else {
                if (process.env.NODE_ENV !== 'production') {
                    console.warn("Gemini API で応答がブロックされたか、候補がありませんでした:", result.response?.promptFeedback || "不明な理由");
                }
                return "ごめんなさい、それはわたしにはお話しできない内容です🌸 他のお話をしましょうね💖";
            }
        } else {
            throw new Error(`未知のAIモデル: ${modelToUse}`);
        }
        return replyContent;
    } catch (error) {
        console.error(`AI応答生成中にエラーが発生しました (${modelToUse}):`, error.response?.data || error.message);
        await logErrorToDb(userId, `AI応答生成エラー`, { error: error.message, stack: error.stack, userMessage: userMessage, modelUsed: modelToUse });

        if (error.message === "API応答がタイムアウトしました。") {
            return "ごめんね、今、少し考え込むのに時間がかかっちゃったみたい💦 もう一度、お話しいただけますか？🌸";
        }
        if (error.response && error.response.status === 400 && error.response.data && error.response.data.error.message.includes("Safety setting")) {
            return "ごめんなさい、それはわたしにはお話しできない内容です🌸 他のお話をしましょうね💖";
        }
        // フォールバックロジック
        const fallbackMessage = "ごめんね、いまうまく考えがまとまらなかったみたいです……もう一度お話しいただけますか？🌸";
        try {
            // 元のモデルがGemini Proの場合、Flashへフォールバックを試みる
            if (modelToUse === "gemini-1.5-pro-latest" && !error.message.includes("API応答がタイムアウトしました.")) { // タイムアウト時はすでにメッセージがあるため
                const fallbackModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });
                const fallbackResult = await fallbackModel.generateContent({
                    contents: [{ role: "user", parts: [{ text: "ごめん、さっきの質問にうまく答えられなかったみたい。別の角度から教えてくれる？" }] }]
                });
                const fallbackResponse = await fallbackResult.response;
                return `ごめんね、ちょっと今うまくお話できなかったの…💦\nでも、別の方法で考えてみたよ。「${fallbackResponse.text()}」\nまたあとで試してみてくれると嬉しいな💖`;
            }
        } catch (fallbackError) {
            console.error("Gemini 1.5 Flashへのフォールバック中にもエラーが発生しました:", fallbackError);
            await logErrorToDb(userId, 'AI_FALLBACK_ERROR', fallbackError.message, { originalModel: modelToUse, message: userMessage });
        }
        return fallbackMessage;
    }
}

// ⭐handleRegistrationFlow関数をここに定義します⭐
async function handleRegistrationFlow(event, userId, user, userMessage, lowerUserMessage, usersCollection) {
    let handled = false;

    // 退会フローを優先
    if (user.registrationStep === 'confirm_withdrawal') {
        if (lowerUserMessage === 'はい' || lowerUserMessage === 'yes') {
            // ユーザーデータをFirestoreから削除
            await usersCollection.doc(userId).delete();
            // registrationStepをリセット（既にユーザーデータがないので厳密には不要だが念のため）
            // 再フォロー時のために membershipType を guest に設定
            await usersCollection.doc(userId).set({ registrationStep: null, completedRegistration: false, membershipType: "guest" }, { merge: true });

            if (event.replyToken) {
                await client.replyMessage(event.replyToken, { type: 'text', text: '退会手続きが完了したよ🌸\nさみしいけど、いつでもまた会えるのを楽しみにしているね💖\nこのアカウントをブロックしても大丈夫だよ。' });
            } else {
                await safePushMessage(userId, { type: 'text', text: '退会手続きが完了したよ🌸\nさみしいけど、いつでもまた会えるのを楽しみにしているね💖\nこのアカウントをブロックしても大丈夫だよ。' });
            }
            logToDb(userId, userMessage, '退会完了', 'こころちゃん（退会フロー）', 'withdrawal_complete', true);
            return true;
        } else if (lowerUserMessage === 'いいえ' || lowerUserMessage === 'no') {
            await usersCollection.doc(userId).update({ registrationStep: null });
            if (event.replyToken) {
                await client.replyMessage(event.replyToken, { type: 'text', text: '退会をキャンセルしたよ🌸 続けてお話しできるの嬉しいな💖' });
            } else {
                await safePushMessage(userId, { type: 'text', text: '退会をキャンセルしたよ🌸 続けてお話しできるの嬉しいな💖' });
            }
            logToDb(userId, userMessage, '退会キャンセル', 'こころちゃん（退会フロー）', 'withdrawal_cancel', true);
            return true;
        } else {
            if (event.replyToken) {
                await client.replyMessage(event.replyToken, { type: 'text', text: '「はい」か「いいえ」で答えてくれるかな？💦' });
            } else {
                await safePushMessage(userId, { type: 'text', text: '「はい」か「いいえ」で答えてくれるかな？💦' });
            }
            return true;
        }
    }

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
                    // ⭐ 学生証提出フォームのURIにもプリフィルを追加します ⭐
                    const prefilledFormUrl = addParamToFormUrl(WATCH_SERVICE_FORM_BASE_URL, WATCH_SERVICE_FORM_LINE_USER_ID_ENTRY_ID, userId);

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
                                        { type: "button", style: "primary", height: "sm", action: { type: "uri", label: "学生証提出フォームへ", uri: prefilledFormUrl }, margin: "md", color: "#FFB6C1" }
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
                                        { type: "button", "style": "primary", "height": "sm", "action": { type: "uri", label: "学生証提出フォームへ", uri: prefilledFormUrl }, "margin": "md", "color": "#FFB6C1" }
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

        case 'confirm_withdrawal': // 退会確認ステップを追加 (Postbackからも呼び出される)
            // このケースはhandleRegistrationFlowの冒頭で処理されるため、ここには到達しないはず
            handled = true;
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
            // ⭐ 修正箇所: addParamToFormUrl 関数を使用 ⭐
            const prefilledFormUrl = addParamToFormUrl(WATCH_SERVICE_FORM_BASE_URL, WATCH_SERVICE_FORM_LINE_USER_ID_ENTRY_ID, userId);

            console.log('生成された見守りサービスフォームURL:', prefilledFormUrl); // デバッグ用

            const watchServiceGuideFlexWithUriButton = {
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
                        // ⭐ uriを動的に生成した prefilledFormUrl に変更します ⭐
                        { "type": "button", "style": "primary", "height": "sm", "action": { type: "uri", label: "見守り登録する", uri: prefilledFormUrl }, "color": "#d63384" },
                        { "type": "button", "style": "secondary", "height": "sm", "action": { type: "postback", label: "見守りを解除する", data: "action=watch_unregister" }, "color": "#808080" }
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

    // ⭐ Postbackからの見守り関連応答（OK, 元気ないなど）は handlePostbackEvent で処理されるため、ここからは削除 ⭐
    // メッセージテキスト（例：「元気だよ！」）による応答をここで処理しているため、ここは残します。
    // Postbackアクションによる応答は handlePostbackEvent で処理します。
    if (lowerUserMessage.includes("元気だよ！") || lowerUserMessage.includes("okだよ") || lowerUserMessage.includes("ok") || lowerUserMessage.includes("オーケー") || lowerUserMessage.includes("大丈夫")) {
        if (user && user.watchServiceEnabled) { // 見守りサービスが有効な場合のみ応答
            try {
                await usersCollection.doc(userId).update(
                    {
                        lastOkResponse: admin.firestore.FieldValue.serverTimestamp(),
                        lastScheduledWatchMessageSent: null, // 定期メッセージ送信状態をリセット
                        firstReminderSent: false, // 24時間リマインダー状態をリセット
                        emergencyNotificationSent: false // 緊急通知状態をリセット
                    }
                );
                // replyMessageを使用
                await client.replyMessage(event.replyToken, {
                    type: 'text',
                    text: 'ありがとう🌸 元気そうで安心したよ💖 またね！'
                });
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
        if (user && user.watchServiceEnabled) {
            try {
                // OK応答と同様に、状態をリセット
                await usersCollection.doc(userId).update(
                    {
                        lastOkResponse: admin.firestore.FieldValue.serverTimestamp(),
                        lastScheduledWatchMessageSent: null,
                        firstReminderSent: false,
                        emergencyNotificationSent: false
                    }
                );
                // replyMessageを使用
                await client.replyMessage(event.replyToken, {
                    type: 'text',
                    text: 'そうだね、まあまあな日もあるよね🌸 焦らず、あなたのペースで過ごしてね💖'
                });
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
        if (user && user.watchServiceEnabled) {
            try {
                // OK応答と同様に、状態をリセット
                await usersCollection.doc(userId).update(
                    {
                        lastOkResponse: admin.firestore.FieldValue.serverTimestamp(),
                        lastScheduledWatchMessageSent: null,
                        firstReminderSent: false,
                        emergencyNotificationSent: false
                    }
                );
                // replyMessageを使用
                await client.replyMessage(event.replyToken, {
                    type: 'text',
                    text: '大変だったね、疲れてしまったんだね…💦 無理しないで休んでね。こころはいつでもあなたの味方だよ💖'
                });
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
        if (user && user.watchServiceEnabled) {
            try {
                // OK応答と同様に、状態をリセット
                await usersCollection.doc(userId).update(
                    {
                        lastOkResponse: admin.firestore.FieldValue.serverTimestamp(),
                        lastScheduledWatchMessageSent: null,
                        firstReminderSent: false,
                        emergencyNotificationSent: false
                    }
                );
                // replyMessageを使用
                await client.replyMessage(event.replyToken, {
                    type: 'text',
                    text: 'うん、いつでも聞くよ🌸 何か話したいことがあったら、いつでも話してね💖'
                });
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

    // ⭐ 見守りサービス解除はPostbackからも、メッセージからも可能にする ⭐
    // メッセージからの「解除」はここで処理。PostbackはhandlePostbackEventで処理される。
    if (lowerUserMessage === '解除' || lowerUserMessage === 'かいじょ') {
        let replyTextForUnregister = "";
        let logTypeForUnregister = "";

        if (user && user.watchServiceEnabled) {
            try {
                await usersCollection.doc(userId).update({
                    watchServiceEnabled: false,
                    // 見守り解除に伴い、関連するユーザー情報をFirestoreから削除
                    phoneNumber: admin.firestore.FieldValue.delete(),
                    guardianName: admin.firestore.FieldValue.delete(),
                    guardianPhoneNumber: admin.firestore.FieldValue.delete(),
                    'address.city': admin.firestore.FieldValue.delete(),
                    name: admin.firestore.FieldValue.delete(),
                    kana: admin.firestore.FieldValue.delete(),
                    age: admin.firestore.FieldValue.delete(),
                    category: admin.firestore.FieldValue.delete(),
                    completedRegistration: false, // 会員登録完了フラグもリセット
                    lastScheduledWatchMessageSent: null,
                    firstReminderSent: false,
                    emergencyNotificationSent: false,
                });
                replyTextForUnregister = "見守りサービスを解除したよ🌸 またいつでも登録できるからね💖\n※登録情報も初期化されました。";
                logTypeForUnregister = 'watch_service_unregister';
            } catch (error) {
                console.error("❌ 見守りサービス解除処理エラー:", error.message);
                logErrorToDb(userId, "見守りサービス解除処理エラー", { error: error.message, userId: userId });
                replyTextForUnregister = "ごめんね、解除処理中にエラーが起きたみたい…💦 もう一度試してみてくれるかな？";
                logTypeForUnregister = 'watch_service_unregister_error';
            }
        } else {
            replyTextForUnregister = "見守りサービスは登録されていないみたいだよ🌸 登録したい場合は「見守り」と話しかけてみてね💖";
            logTypeForUnregister = 'watch_service_not_registered_on_unregister';
        }
        await client.replyMessage(event.replyToken, { type: 'text', text: replyTextForUnregister });
        await logToDb(userId, userMessage, replyTextForUnregister, "System", logTypeForUnregister);
        return true;
    }
    return false;
}

// --- 定期見守りメッセージ送信 Cronジョブ (毎日15時にトリガー) ---
cron.schedule('0 15 * * *', () => { // 毎日15時に実行
    if (process.env.NODE_ENV !== 'production') {
        console.log('cron: 定期見守りメッセージ送信処理をトリガーします。');
    }
    sendScheduledWatchMessage();
}, {
    timezone: "Asia/Tokyo"
});

/**
 * Firestoreに通知クールダウン情報を記録・確認する関数
 * @param {string} userId - ユーザーID
 * @param {string} alertType - 通知の種類 (danger, scam, watch_unresponsive)
 * @param {number} cooldownMinutes - クールダウン期間（分）
 * @returns {Promise<boolean>} 通知を送信すべきならtrue、クールダウン中ならfalse
 */
async function checkAndSetAlertCooldown(userId, alertType, cooldownMinutes) {
    const cooldownRef = db.collection('alertCooldowns').doc(userId);
    const doc = await cooldownRef.get();
    const now = admin.firestore.Timestamp.now().toMillis();

    const COOLDOWN_PERIOD_MS = cooldownMinutes * 60 * 1000;

    if (doc.exists) {
        const data = doc.data();
        if (data[alertType] && (now - data[alertType]) < COOLDOWN_PERIOD_MS) {
            if (process.env.NODE_ENV !== 'production') {
                console.log(`⚠️ ユーザー ${userId} への応答クールダウン中。`);
            }
            return false;
        }
    }

    await cooldownRef.set({ [alertType]: now }, { merge: true });
    return true;
}


/**
 * 見守りサービス利用者への定期メッセージ送信と未応答時の緊急連絡通知
 * 新しいロジック: 3日 -> 24時間 -> 5時間
 */
async function sendScheduledWatchMessage() {
    const usersCollection = db.collection('users');
    const now = admin.firestore.Timestamp.now().toDate(); // 現在時刻をDateオブジェクトで取得

    try {
        const snapshot = await usersCollection
            .where('watchServiceEnabled', '==', true)
            .get();

        for (const doc of snapshot.docs) {
            const user = doc.data();
            const userId = doc.id;

            // lastOkResponse または createdAt がない場合を考慮し、デフォルト値を設定
            const lastOkResponse = user.lastOkResponse ? user.lastOkResponse.toDate() : user.createdAt.toDate();
            // lastScheduledWatchMessageSent がない場合、非常に古い時刻を設定して初回送信を促す
            const lastScheduledWatchMessageSent = user.lastScheduledWatchMessageSent ? user.lastScheduledWatchMessageSent.toDate() : new Date(0); // Epoch

            // 経過時間（ミリ秒）
            const msSinceLastOk = now.getTime() - lastOkResponse.getTime();
            const msSinceLastScheduled = now.getTime() - lastScheduledWatchMessageSent.getTime();

            let updateData = {};
            let messageToSend = null;
            let logTypeToUse = null;

            // --- フェーズ1: 3日 (72時間) 未応答の場合の初回見守りメッセージ ---
            // lastOkResponseから72時間以上経過、かつ、初回見守りメッセージがまだ送信されていないか、
            // あるいは、前回の見守りメッセージ送信から72時間以上経過している場合
            const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
            if (msSinceLastOk >= THREE_DAYS_MS && msSinceLastScheduled >= THREE_DAYS_MS) {
                messageToSend = watchMessages[Math.floor(Math.random() * watchMessages.length)];
                logTypeToUse = 'watch_service_initial_message';
                updateData.lastScheduledWatchMessageSent = admin.firestore.FieldValue.serverTimestamp();
                updateData.firstReminderSent = false; // 初回見守りメッセージなのでリマインダーフラグをリセット
                updateData.emergencyNotificationSent = false; // 同上
                if (process.env.NODE_ENV !== 'production') {
                    console.log(`ユーザー ${userId}: 3日経過 - 初回見守りメッセージを送信準備`);
                }
            }
            // --- フェーズ2: 初回見守りメッセージ送信後、24時間未応答の場合のリマインダー ---
            // 前回の見守りメッセージ送信から24時間以上経過、かつ、初回リマインダーがまだ送信されていない場合
            else if (user.lastScheduledWatchMessageSent && msSinceLastScheduled >= (24 * 60 * 60 * 1000) && !user.firstReminderSent) {
                messageToSend = "こころちゃんだよ🌸\n元気にしてるかな？\nもしかして、忙しいのかな？\n短い時間でいいから、一言「OKだよ💖」って教えてくれると安心するな😊";
                logTypeToUse = 'watch_service_reminder_24h';
                updateData.firstReminderSent = true;
                if (process.env.NODE_ENV !== 'production') {
                    console.log(`ユーザー ${userId}: 24時間経過 - 初回リマインダーを送信準備`);
                }
            }
            // --- フェーズ3: 初回見守りメッセージ送信後、さらに5時間未応答の場合の緊急通知 ---
            // (合計で初回見守りから29時間)
            // 前回の見守りメッセージ送信から29時間以上経過、かつ、緊急通知がまだ送信されていない場合
            else if (user.lastScheduledWatchMessageSent && msSinceLastScheduled >= ((24 + 5) * 60 * 60 * 1000) && !user.emergencyNotificationSent) {
                const canNotify = await checkAndSetAlertCooldown(userId, 'watch_unresponsive', 5); // 5分クールダウン
                if (canNotify) {
                    const userInfo = user; // userオブジェクトをそのまま渡す
                    const messageForOfficer = `ユーザー ${userInfo.name || '不明なユーザー'} (${userId}) が見守りサービスで未応答です。緊急対応が必要です。`;
                    await notifyOfficerGroup(messageForOfficer, userId, userInfo, "watch_unresponsive", "緊急");
                    logTypeToUse = 'watch_service_final_notification';
                    updateData.emergencyNotificationSent = true;
                    if (process.env.NODE_ENV !== 'production') {
                        console.log(`ユーザー ${userId}: 29時間経過 - 緊急通知をトリガー`);
                    }
                } else {
                    if (process.env.NODE_ENV !== 'production') {
                        console.log(`ユーザー ${userId}: 見守り緊急通知はクールダウン中のためスキップされました。`);
                    }
                }
            }

            // メッセージ送信とデータ更新
            if (messageToSend) {
                const messages = [
                    { type: 'text', text: messageToSend },
                    {
                        type: 'flex',
                        altText: '元気？ボタン',
                        contents: {
                            "type": "bubble",
                            "body": {
                                "type": "box",
                                "layout": "vertical",
                                "contents": [
                                    { "type": "text", "text": "元気？🌸", "weight": "bold", "color": "#FF69B4", "size": "lg", "align": "center" },
                                    { "type": "text", "text": "こころちゃん、あなたのことが心配だよ…！", "wrap": true, "margin": "md", "size": "sm" }
                                ]
                            },
                            "footer": {
                                "type": "box",
                                "layout": "vertical",
                                "spacing": "sm",
                                "contents": [
                                    { "type": "button", "style": "primary", "height": "sm", "action": { type: "postback", label: "OKだよ💖", data: "action=watch_ok" }, "color": "#d63384" },
                                    { "type": "button", "style": "secondary", "height": "sm", "action": { type: "postback", label: "ちょっと元気ないかも…", data: "action=watch_somewhat" }, "color": "#808080" },
                                    { "type": "button", "style": "secondary", "height": "sm", "action": { type: "postback", label: "疲れたよ…", data: "action=watch_tired" }, "color": "#808080" },
                                    { "type": "button", "style": "secondary", "height": "sm", "action": { type: "postback", label: "お話したいな…", data: "action=watch_talk" }, "color": "#808080" }
                                ]
                            }
                        }
                    }
                ];
                await safePushMessage(userId, messages);
                await logToDb(userId, `（定期見守りメッセージ）`, messageToSend, 'こころちゃん（見守り）', logTypeToUse, true);
            }

            if (Object.keys(updateData).length > 0) {
                await usersCollection.doc(userId).update(updateData);
            }
        }
        if (process.env.NODE_ENV !== 'production') {
            console.log('✅ 見守りサービス定期チェックが完了しました。');
        }
    } catch (error) {
        console.error("❌ 見守りサービス Cron ジョブ実行中にエラーが発生しました:", error.message);
        await logErrorToDb(null, "見守りサービス Cron ジョブエラー", { error: error.message, stack: error.stack });
    }
}
/**
 * 管理者グループに通知メッセージを送信する関数。
 * @param {string} message - 送信するメッセージ
 * @param {string} userId - 通知対象のユーザーID
 * @param {Object} userInfo - ユーザーの登録情報 (userオブジェクトを直接渡す想定)
 * @param {string} type - 通知の種類 (例: "danger", "scam", "watch_unresponsive")
 * @param {string} [notificationDetailType=''] - 見守りサービス未応答時の詳細タイプ (例: "緊急")
 */
async function notifyOfficerGroup(message, userId, userInfo, type, notificationDetailType = '') {
    // userInfoはユーザーデータオブジェクト全体を想定
    const userName = userInfo.name || '未登録'; // Changed from '不明なユーザー'
    const userPhone = userInfo.phoneNumber || '未登録';
    const guardianName = userInfo.guardianName || '未登録';
    const emergencyContact = userInfo.guardianPhoneNumber || '未登録'; // 保護者電話番号を緊急連絡先として使用
    const relationship = userInfo.relationship || '未登録'; // 現行フローで取得されていないため、必要に応じて追加
    const userCity = (userInfo.address && userInfo.address.city) ? userInfo.address.city : '未登録'; // Here's the fix: userInfo.address.city

    // 通知タイトル
    let notificationTitle = "";
    if (type === "danger") {
        notificationTitle = "🚨【危険ワード検知】🚨";
    } else if (type === "scam") {
        notificationTitle = "🚨【詐欺注意】🚨";
    } else if (type === "watch_unresponsive") {
        notificationTitle = `🚨【見守りサービス未応答 (${notificationDetailType})】🚨`;
    }

    // ⭐ 修正箇所: 通知メッセージのフォーマットをご要望通りに改善 ⭐
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

    // Send the message to the officer group
    if (OFFICER_GROUP_ID) {
        await safePushMessage(OFFICER_GROUP_ID, { type: 'text', text: simpleNotificationMessage });
        if (process.env.NODE_ENV !== 'production') {
            console.log(`✅ 管理者グループに${type}通知を送信しました (テキスト形式)。`);
        }
    } else {
        console.warn("⚠️ OFFICER_GROUP_ID が設定されていないため、管理者グループへの通知は送信されません。");
    }
}


// ⭐ メッセージ応答のクールダウンを管理する関数 ⭐
async function shouldRespond(userId) {
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
}

// --- LINEイベントハンドラ ---
async function handleEvent(event) { // ⭐ async キーワードがここにあることを確認 ⭐
    if (!event || !event.source || !event.message || event.message.type !== 'text') {
        if (process.env.NODE_ENV !== 'production') {
            console.log("Non-text message or malformed event received. Ignoring:", event);
        }
        return;
    }

    let userId;
    let sourceId;

    if (event.source.type === 'user') {
        userId = event.source.userId;
        sourceId = event.source.userId;
    } else if (event.source.type === 'group') {
        userId = event.source.userId;
        sourceId = event.source.groupId;
    } else {
        if (process.env.NODE_ENV !== 'production') {
            console.log("Unsupported event source type. Ignoring event:", event);
        }
        return;
    }

    if (!isBotAdmin(userId)) {
        if (!(await shouldRespond(userId))) {
            return;
        }
    }

    const userMessage = event.message.text;
    const lowerUserMessage = userMessage.toLowerCase();
    const isAdmin = isBotAdmin(userId);

    // ⭐ ユーザーデータを最初に取得し、常に最新の状態を保つ ⭐
    let user = await getUserData(userId);
    const usersCollection = db.collection('users');

    // ⭐ 管理者コマンド処理 ⭐
    if (isAdmin && userMessage.startsWith('!')) {
        const command = userMessage.substring(1).split(' ')[0];
        const args = userMessage.substring(command.length + 1).trim();
        let targetUserId = userId; // 管理者コマンドのtargetUserIdもここで定義

        if (command === "set" && args.startsWith('user ')) {
            const parts = args.split(' ');
            if (parts.length >= 2) {
                targetUserId = parts[1];
                const newMembershipType = parts[2];
                if (MEMBERSHIP_CONFIG[newMembershipType]) {
                    await updateUserData(targetUserId, { membershipType: newMembershipType });
                    await client.replyMessage(event.replyToken, { type: 'text', text: `ユーザー ${targetUserId} の会員種別を ${newMembershipType} に設定しました。` });
                    await logToDb(userId, userMessage, `ユーザー ${targetUserId} の会員種別を ${newMembershipType} に設定`, "AdminCommand", 'admin_set_membership');
                    return;
                } else {
                    await client.replyMessage(event.replyToken, { type: 'text', text: `無効な会員種別です: ${newMembershipType}` });
                    await logToDb(userId, userMessage, `無効な会員種別: ${newMembershipType}`, "AdminCommand", 'admin_command_invalid_membership');
                    return;
                }
            }
        }
        if (command === "reply" && args.startsWith('user ')) {
            const parts = args.split(' ');
            if (parts.length >= 3) {
                const replyTargetUserId = parts[1];
                const replyMessageContent = parts.slice(2).join(' ').trim();
                if (replyTargetUserId && replyMessageContent) {
                    try {
                        const targetUserDisplayName = await getUserDisplayName(replyTargetUserId);
                        await safePushMessage(replyTargetUserId, { type: 'text', text: `🌸 こころだよ！理事会からのメッセージだよ😊\n\n「${replyMessageContent}」\n\n何か困ったことがあったら、また私に話しかけてね💖` });
                        await client.replyMessage(event.replyToken, { type: 'text', text: `${targetUserDisplayName} (${replyTargetUserId}) さんにメッセージを送信しました。\n内容: 「${replyMessageContent}」` });
                        await logToDb(userId, userMessage, `Re: ${replyMessageContent}`, "AdminCommand", 'admin_reply_to_user');
                        return;
                    } catch (error) {
                        console.error(`Admin reply to user failed: ${error.message}`);
                        await client.replyMessage(event.replyToken, { type: 'text', text: `メッセージ送信に失敗しました: ${error.message}` });
                        await logErrorToDb(userId, `Admin reply to user failed`, { error: error.message, targetUserId: replyTargetUserId, userMessage: userMessage });
                        return;
                    }
                } else {
                    await client.replyMessage(event.replyToken, { type: 'text', text: `!reply user [userId] [メッセージ] の形式で入力してください。` });
                    return;
                }
            }
        }
        let replyText = ""; // 管理者コマンドのreplyTextもここで定義
        switch (command) {
            case 'status':
                const targetUser = await getUserData(targetUserId);
                if (targetUser) {
                    const lastMessageDate = targetUser.lastMessageDate ? new Date(targetUser.lastMessageDate._seconds * 1000).toLocaleString() : 'N/A';
                    replyText = `ユーザーID: ${targetUserId}\n会員種別: ${targetUser.membershipType}\n今月メッセージ数: ${targetUser.dailyMessageCount} (本日)\n最終メッセージ日時: ${lastMessageDate}\n見守りサービス: ${targetUser.watchServiceEnabled ? '有効' : '無効'}\n相談モード: ${targetUser.isInConsultationMode ? '有効' : '無効'}`;
                } else {
                    replyText = `ユーザー ${targetUserId} は見つかりませんでした。`;
                }
                break;
            case 'reset':
                await updateUserData(targetUserId, { dailyMessageCount: 0, isInConsultationMode: false });
                replyText = `ユーザー ${targetUserId} のメッセージカウントと相談モードをリセットしました。`;
                break;
            case 'myid':
                replyText = `あなたのユーザーIDは:\n${userId}`;
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
                break;
            default:
                replyText = `不明な管理者コマンドです。利用可能なコマンド: !status, !reset, !set user [userId] [membershipType], !myid, !history, !error_history, !reply user [userId] [message]`;
                break;
        }
        await client.replyMessage(event.replyToken, { type: 'text', text: replyText });
        await logToDb(userId, userMessage, replyText, "AdminCommand", `admin_command_${command}`);
        return;
    }

    if (event.source.type === 'group') {
        return;
    }

    const userConfig = MEMBERSHIP_CONFIG[user.membershipType] || MEMBERSHIP_CONFIG["guest"];

    let replyText = "";
    let responsedBy = "AI";
    let logType = "normal_conversation";

    // ⭐ 退会フローのハンドリングを最優先 ⭐
    if (lowerUserMessage === '退会' || lowerUserMessage === 'たいかい') {
        if (user.completedRegistration) { // 登録済みユーザーのみ退会確認
            await updateUserData(userId, { registrationStep: 'confirm_withdrawal' });
            await client.replyMessage(event.replyToken, {
                type: 'text',
                text: '本当に退会するの？\n一度退会すると、今までの情報が消えちゃうけど、本当に大丈夫？💦\n「はい」か「いいえ」で教えてくれるかな？'
            });
            await logToDb(userId, userMessage, '退会確認メッセージ表示', 'こころちゃん（退会フロー）', 'withdrawal_request');
            return;
        } else {
            await client.replyMessage(event.replyToken, {
                type: 'text',
                text: 'まだ会員登録されていないみたいだよ🌸\n退会手続きは、会員登録済みの方のみ行えるんだ。'
            });
            await logToDb(userId, userMessage, '未登録ユーザーの退会リクエスト', 'こころちゃん（退会フロー）', 'withdrawal_unregistered_user');
            return;
        }
    }

    // registrationStep が設定されている場合、登録フローを処理
    if (user.registrationStep) {
        const registrationHandled = await handleRegistrationFlow(event, userId, user, userMessage, lowerUserMessage, usersCollection);
        if (registrationHandled) {
            // 登録フローが完了した場合は、最新のユーザー情報を再取得する
            user = await getUserData(userId);
            return;
        }
    }

    // ⭐ 「会員登録」または「登録したい」の処理を強化 (addParamToFormUrl使用) ⭐
    if (userMessage.includes("会員登録") || userMessage.includes("登録したい")) {
        let displayFlexMessage;
        let altText;
        let logMessage;
        let logTypeDetail;

        if (user.completedRegistration) {
            // 登録済みの場合：属性変更・退会用のFlex Messageを動的に生成
            const memberChangeFormPrefilledUrl = addParamToFormUrl(MEMBER_CHANGE_FORM_BASE_URL, MEMBER_CHANGE_FORM_LINE_USER_ID_ENTRY_ID.replace('entry.', ''), userId);

            displayFlexMessage = {
                "type": "bubble",
                "body": {
                    "type": "box",
                    "layout": "vertical",
                    "contents": [
                        { "type": "text", "text": "📝登録情報変更・退会メニュー📝", "weight": "bold", "size": "lg", "align": "center", "color": "#FF69B4" },
                        { "type": "text", "text": `現在のあなたの属性は「**${user.category || '未設定'}**」だね！\n\nもし属性が変わったり、登録情報を変更したい場合は、下のボタンから手続きできるよ💖`, "wrap": true, "margin": "md", "size": "sm" }
                    ]
                },
                "footer": {
                    "type": "box",
                    "layout": "vertical",
                    "spacing": "sm",
                    "contents": [
                        // 会員変更フォームへのボタン
                        { "type": "button", "action": { "type": "uri", "label": "登録情報を変更する", "uri": memberChangeFormPrefilledUrl }, "style": "primary", "height": "sm", "margin": "md", "color": "#FFD700" },
                        // 退会ボタン
                        { "type": "button", "action": { "type": "postback", "label": "退会する", "data": "action=request_withdrawal" }, "style": "secondary", "height": "sm", "margin": "md", "color": "#FF0000" }
                    ]
                }
            };
            altText = "登録情報変更・退会メニュー";
            logMessage = `会員登録済み、属性変更・退会案内表示 (現在の属性: ${user.category})`;
            logTypeDetail = 'registration_info_change_guide';

        } else {
            // 未登録の場合：新規登録フォームへのボタンを含むFlex Message
            // ⭐ 修正箇所: addParamToFormUrl 関数を使用 ⭐
            const elementaryStudentFormPrefilledUrl = addParamToFormUrl(STUDENT_ELEMENTARY_FORM_BASE_URL, STUDENT_ELEMENTARY_FORM_LINE_USER_ID_ENTRY_ID, userId);
const middleHighUniStudentFormPrefilledUrl = addParamToFormUrl(STUDENT_MIDDLE_HIGH_UNI_FORM_BASE_URL, STUDENT_MIDDLE_HIGH_UNI_FORM_LINE_USER_ID_ENTRY_ID, userId);
const adultFormPrefilledUrl = addParamToFormUrl(ADULT_FORM_BASE_URL, ADULT_FORM_LINE_USER_ID_ENTRY_ID, userId);

            console.log(`DEBUG: Generated Adult Form URL: ${adultFormPrefilledUrl}`); // この行は既に存在
            console.log(`DEBUG: Generated Elementary Student Form URL: ${elementaryStudentFormPrefilledUrl}`); // 追加
            console.log(`DEBUG: Generated Middle/High/Uni Student Form URL: ${middleHighUniStudentFormPrefilledUrl}`); // 追加

            displayFlexMessage = {
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
            };
            altText = "新規会員登録メニュー";
            logMessage = "新規会員登録メニュー表示（区分選択促し）";
            logTypeDetail = "registration_start";
        }
        try {
            await client.replyMessage(event.replyToken, {
                type: "flex",
                altText: altText,
                contents: displayFlexMessage
            });
            await logToDb(userId, userMessage, logMessage, "System", logTypeDetail);
        } catch (replyError) {
            console.error(`❌ 会員登録/変更メニュー replyMessage failed: ${replyError.message}. Falling back to safePushMessage.`);
            await safePushMessage(userId, { type: "flex", altText: altText, contents: displayFlexMessage });
            await logErrorToDb(userId, `会員登録/変更メニュー replyMessage失敗、safePushMessageでフォールバック`, { error: replyError.message, userMessage: userMessage });
        }
        return;
    }

// ⭐ 見守りサービス登録・解除のメッセージ処理は handleWatchServiceRegistration に移譲 ⭐
if (await handleWatchServiceRegistration(event, userId, userMessage, user)) {
    return;
}

    // --- メッセージカウントのリセット (日次) ---
    const today = new Date().toDateString();
    const lastMessageDate = user.lastMessageDate ? new Date(user.lastMessageDate._seconds * 1000).toDateString() : null;

    if (lastMessageDate !== today) {
        user.dailyMessageCount = 0;
        user.lastMessageDate = admin.firestore.FieldValue.serverTimestamp();
        await updateUserData(userId, { dailyMessageCount: 0, lastMessageDate: admin.firestore.FieldValue.serverTimestamp() });
    }

    // --- メッセージ制限チェック ---
    if (userConfig.dailyLimit !== -1 && user.dailyMessageCount >= userConfig.dailyLimit) {
        replyText = userConfig.exceedLimitMessage;
        if (event.replyToken) {
            await client.replyMessage(event.replyToken, { type: 'text', text: replyText });
        } else {
            await safePushMessage(userId, { type: 'text', text: replyText });
        }
        await logToDb(userId, userMessage, replyText, "LimitExceeded", "message_limit_exceeded");
        return;
    }

    // --- メッセージカウントを増やす ---
    await updateUserData(userId, {
        dailyMessageCount: admin.firestore.FieldValue.increment(1),
        lastMessageDate: admin.firestore.FieldValue.serverTimestamp()
    });
    // ⭐ 最新のユーザーデータを再取得（インクリメントされた値を確認するため） ⭐
    user = await getUserData(userId);


    // --- 危険ワード/詐欺ワード/不適切ワードチェック ---
    const dangerDetected = checkContainsDangerWords(userMessage);
    const scamDetected = checkContainsScamWords(userMessage);
    const inappropriateDetected = checkContainsInappropriateWords(userMessage);

    if (dangerDetected) {
        await client.replyMessage(event.replyToken, {
            type: 'flex',
            altText: '危険ワード検知',
            contents: EMERGENCY_FLEX_MESSAGE
        });
        await logToDb(userId, userMessage, '(危険ワード検知Flex表示)', 'こころちゃん（危険ワード）', 'danger_word_triggered', true);
        await notifyOfficerGroup(userMessage, userId, user, "danger");
        return;
    }
    if (scamDetected) {
        await client.replyMessage(event.replyToken, {
            type: 'flex',
            altText: '詐欺注意喚起',
            contents: SCAM_FLEX_MESSAGE
        });
        await logToDb(userId, userMessage, '(詐欺注意喚起Flex表示)', 'こころちゃん（詐欺注意）', 'scam_word_triggered', true);
        await notifyOfficerGroup(userMessage, userId, user, "scam");
        return;
    }
    if (inappropriateDetected) {
        replyText = "ごめんなさい、それはわたしにはお話しできない内容です🌸 他のお話をしましょうね💖";
        await client.replyMessage(event.replyToken, { type: 'text', text: replyText });
        await logToDb(userId, userMessage, replyText, 'こころちゃん（不適切ワード）', 'inappropriate_word_triggered', true);
        return;
    }

    // --- 固定応答チェック (ClariS関連含む) ---
    const specialReply = checkSpecialReply(userMessage);
    if (specialReply) {
        replyText = specialReply;
        await client.replyMessage(event.replyToken, { type: 'text', text: replyText });
        await logToDb(userId, userMessage, replyText, 'こころちゃん（固定応答）', 'special_reply', true);
        return;
    }

    // --- NPO法人コネクトに関する問い合わせ ---
    if (isOrganizationInquiry(userMessage)) {
        replyText = ORGANIZATION_REPLY_MESSAGE;
        await client.replyMessage(event.replyToken, { type: 'text', text: replyText });
        await logToDb(userId, userMessage, replyText, 'こころちゃん（団体問い合わせ）', 'organization_inquiry_fixed', true);
        return;
    }

    // --- 宿題・勉強に関する質問のハンドリング ---
    const homeworkTriggered = containsHomeworkTrigger(userMessage);
    if (homeworkTriggered && user.category && (user.category === '小学生' || user.category === '中学生～大学生')) {
        replyText = "わたしを作った人に『宿題や勉強は自分の力でがんばってほしいから、答えは言っちゃだめだよ』って言われているんだ🌸 ごめんね💦\nでも、ヒントくらいなら出せるよ😊 どこで困ってるか教えてくれる？💖";
        await client.replyMessage(event.replyToken, { type: 'text', text: replyText });
        await logToDb(userId, userMessage, replyText, 'こころちゃん（宿題ヘルプ）', 'homework_query', true);
        return;
    }
    
    // --- 相談モードの切り替え ---
    if (lowerUserMessage === '相談') {
        if (!user.isInConsultationMode) {
            await updateUserData(userId, { isInConsultationMode: true });
            replyText = "うん、お話聞かせてね🌸 一度だけ、Gemini 1.5 Proでじっくり話そうね。何があったの？💖";
            await client.replyMessage(event.replyToken, { type: 'text', text: replyText });
            await logToDb(userId, userMessage, replyText, 'こころちゃん（相談モード）', 'consultation_mode_start', true);
            return;
        } else {
            replyText = "もう相談モードになっているよ🌸 何かお話したいことある？💖";
            await client.replyMessage(event.replyToken, { type: 'text', text: replyText });
            await logToDb(userId, userMessage, replyText, 'こころちゃん（相談モード）', 'consultation_mode_already_active');
            return;
        }
    }

    // --- 会話履歴の取得 ---
    const conversationHistory = await getConversationHistory(userId);

    // --- AIモデルの選択 ---
    let modelToUse = getAIModelForUser(user, userMessage); // ⭐ ここでモデルを動的に決定 ⭐

    // 相談モードの場合、Gemini 1.5 Proを使用し、モードを終了する
    if (user.isInConsultationMode) {
        modelToUse = "gemini-1.5-pro-latest";
        await updateUserData(userId, { isInConsultationMode: false }); // 1回でモード終了
        logType = 'consultation_message';
    }


    // --- AI応答生成 ---
    try {
        const aiResponse = await generateAIReply(userMessage, modelToUse, userId, user, conversationHistory);
        replyText = aiResponse;
        await client.replyMessage(event.replyToken, { type: 'text', text: replyText });

        // 会話履歴を保存
        await saveConversationHistory(userId, userMessage, 'user');
        await saveConversationHistory(userId, replyText, 'model');

        if (!shouldLogMessage(logType)) { // 通常会話はログしない設定だが、デバッグ用に一時的にログ
             if (process.env.NODE_ENV !== 'production') {
                console.log(`💬 AI Reply (User: ${userId}, Model: ${modelToUse}): ${replyText}`);
            }
        }
        await logToDb(userId, userMessage, replyText, responsedBy, logType);

    } catch (error) {
        console.error(`❌ LINE応答送信またはAI生成エラー: ${error.message}`);
        await logErrorToDb(userId, `LINE応答送信またはAI生成エラー`, { error: error.message, userMessage: userMessage });
        // エラー時のフォールバックメッセージ
        const fallbackReply = "ごめんね、今うまくお話ができないみたい…💦 もう一度話しかけてくれるかな？🌸";
        await client.replyMessage(event.replyToken, { type: 'text', text: fallbackReply });
        await logToDb(userId, userMessage, fallbackReply, "SystemError", "ai_response_fallback", true);
    }
}

// --- Postbackイベントハンドラ ---
async function handlePostbackEvent(event) {
    if (!event.source || !event.source.userId) {
        if (process.env.NODE_ENV !== 'production') {
            console.log("userIdが取得できないPostbackイベントでした。無視します.", event);
        }
        return;
    }

    const userId = event.source.userId;

    if (!isBotAdmin(userId)) {
        if (!(await shouldRespond(userId))) {
            return;
        }
    }

    const data = new URLSearchParams(event.postback.data);
    const action = data.get('action');

    let replyText = "";
    let logType = "postback_action";
    let user = await getUserData(userId); // 最新のユーザーデータを取得
    const usersCollection = db.collection('users');

    // ⭐ 退会リクエストPostbackの処理 ⭐
    if (action === 'request_withdrawal') {
        if (user.completedRegistration) { // 登録済みユーザーのみ退会確認
            await updateUserData(userId, { registrationStep: 'confirm_withdrawal' });
            await client.replyMessage(event.replyToken, {
                type: 'text',
                text: '本当に退会するの？\n一度退会すると、今までの情報が消えちゃうけど、本当に大丈夫？💦\n「はい」か「いいえ」で教えてくれるかな？'
            });
            await logToDb(userId, `Postback: ${event.postback.data}`, '退会確認メッセージ表示', 'こころちゃん（退会フロー）', 'withdrawal_request');
        } else {
            await client.replyMessage(event.replyToken, {
                type: 'text',
                text: 'まだ会員登録されていないみたいだよ🌸\n退会手続きは、会員登録済みの方のみ行えるんだ。'
            });
            await logToDb(userId, `Postback: ${event.postback.data}`, '未登録ユーザーの退会リクエスト', 'こころちゃん（退会フロー）', 'withdrawal_unregistered_user');
        }
        return;
    }

    // ⭐ 見守りサービス解除Postbackの処理 ⭐
    if (action === 'watch_unregister') {
        let replyTextForUnregister = "";
        let logTypeForUnregister = "";

        if (user && user.watchServiceEnabled) {
            try {
                await usersCollection.doc(userId).update({
                    watchServiceEnabled: false,
                    // 見守り解除に伴い、関連するユーザー情報をFirestoreから削除
                    phoneNumber: admin.firestore.FieldValue.delete(),
                    guardianName: admin.firestore.FieldValue.delete(),
                    guardianPhoneNumber: admin.firestore.FieldValue.delete(),
                    'address.city': admin.firestore.FieldValue.delete(),
                    name: admin.firestore.FieldValue.delete(),
                    kana: admin.firestore.FieldValue.delete(),
                    age: admin.firestore.FieldValue.delete(),
                    category: admin.firestore.FieldValue.delete(),
                    completedRegistration: false, // 会員登録完了フラグもリセット
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

    // ⭐ 見守りサービスの「OKだよ💖」などの応答Postbackの処理をここに再統合 ⭐
    switch (action) {
        case 'watch_ok':
        case 'watch_somewhat':
        case 'watch_tired':
        case 'watch_talk':
            if (user && user.watchServiceEnabled) {
                try {
                    await usersCollection.doc(userId).update(
                        {
                            lastOkResponse: admin.firestore.FieldValue.serverTimestamp(),
                            lastScheduledWatchMessageSent: null,
                            firstReminderSent: false,
                            emergencyNotificationSent: false
                        }
                    );
                    switch (action) {
                        case 'watch_ok':
                            replyText = "OKありがとう！元気そうで安心したよ💖";
                            logType = 'watch_service_ok_response';
                            break;
                        case 'watch_somewhat':
                            replyText = "そっか、ちょっと元気がないんだね…。無理しないで、いつでもこころに話してね🌸";
                            logType = 'watch_service_status_somewhat';
                            break;
                        case 'watch_tired':
                            replyText = "疲れてるんだね、ゆっくり休んでね。こころはいつでもあなたの味方だよ💖";
                            logType = 'watch_service_status_tired';
                            break;
                        case 'watch_talk':
                            replyText = "お話したいんだね！どんなことでも、こころに話してね🌸";
                            logType = 'watch_service_status_talk';
                            break;
                    }
                    try {
                        await client.replyMessage(event.replyToken, { type: 'text', text: replyText });
                        await logToDb(userId, `Postback: ${event.postback.data}`, replyText, "System", logType);
                    } catch (replyError) {
                        await safePushMessage(userId, { type: 'text', text: replyText });
                        await logErrorToDb(userId, `Watch service postback replyMessage失敗、safePushMessageでフォールバック`, { error: replyError.message, userMessage: `Postback: ${event.postback.data}` });
                    }
                    return;
                } catch (error) {
                    console.error(`❌ 見守りサービスPostback応答処理エラー (${action}):`, error.message);
                    await logErrorToDb(userId, `見守りサービスPostback応答処理エラー (${action})`, { error: error.message, userId: userId });
                    return;
                }
            }
            break; // watch_okなどのswitch-caseのbreak

        default:
            replyText = "ごめんね、その操作はまだできないみたい…💦";
            logType = 'unknown_postback_action';
            break;
    }

    try {
        await client.replyMessage(event.replyToken, { type: 'text', text: replyText });
        await logToDb(userId, `Postback: ${event.postback.data}`, replyText, "System", logType);
    } catch (replyError) {
        await safePushMessage(userId, { type: 'text', text: replyText });
        await logErrorToDb(userId, `Default postback replyMessage失敗、safePushMessageでフォールバック`, { error: replyError.message, userMessage: `Postback: ${event.postback.data}` });
    }
    return;
}

// --- Followイベントハンドラ ---
async function handleFollowEvent(event) {
    if (!event.source || !event.source.userId) {
        if (process.env.NODE_ENV !== 'production') {
            console.log("userIdが取得できないFollowイベントでした。無視します.", event);
        }
        return;
    }
    const userId = event.source.userId;
    if (process.env.NODE_ENV !== 'production') {
        console.log(`✅ 新しいユーザーがフォローしました: ${userId}`);
    }

    const isAdminUser = BOT_ADMIN_IDS.includes(userId);

    const initialUserData = {
        membershipType: isAdminUser ? "admin" : "guest",
        dailyMessageCount: 0,
        lastMessageDate: admin.firestore.FieldValue.serverTimestamp(),
        isUrgent: false,
        isInConsultationMode: false,
        lastOkResponse: admin.firestore.FieldValue.serverTimestamp(),
        watchServiceEnabled: false,
        lastScheduledWatchMessageSent: null,
        firstReminderSent: false,
        emergencyNotificationSent: false,
        // registeredInfo: {}, // 登録情報（氏名、電話番号など）→直接ルートに保存する運用に変更
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        completedRegistration: false, // フォロー時は未登録
        category: null, // フォロー時はカテゴリなし
        registrationStep: null,
        tempRegistrationData: {},
    };
    await db.collection('users').doc(userId).set(initialUserData);

    const welcomeMessage = {
        type: 'text',
        text: 'はじめまして！わたしは皆守こころ（みなもりこころ）だよ🌸\n\n困ったことがあったら、いつでもお話聞かせてね😊\n\nまずは、会員登録をしてみてくれると嬉しいな💖'
    };

    // Followイベントからの登録ボタンもプリフィルするように修正
    // ⭐ 修正箇所: addParamToFormUrl 関数を使用 ⭐
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


    try {
        await client.replyMessage(event.replyToken, [welcomeMessage, registrationFlex]);
        await logToDb(userId, "フォローイベント", "初回メッセージと登録メニュー表示", "System", "system_follow");
    } catch (replyError) {
        await safePushMessage(userId, [welcomeMessage, registrationFlex]);
        await logErrorToDb(userId, `Follow event replyMessage失敗、safePushMessageでフォールバック`, { error: replyError.message, userId: userId });
    }
    return;
}

// --- Unfollowイベントハンドラ ---
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
    // ユーザーデータを削除 (退会と同じ処理)
    try {
        await db.collection('users').doc(userId).delete();
        await logToDb(userId, "アンフォローイベント", "ユーザーがブロック/アンフォローによりデータ削除", "System", "system_unfollow");
    } catch (error) {
        console.error(`❌ アンフォロー時のユーザーデータ削除エラー: ${error.message}`);
        await logErrorToDb(userId, `アンフォロー時のユーザーデータ削除エラー`, { error: error.message, userId: userId });
    }
    return;
}

// --- Joinイベントハンドラ (グループ参加時) ---
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
    try {
        await client.replyMessage(event.replyToken, { type: 'text', text: '皆さん、こんにちは！皆守こころです🌸\nこのグループで、みんなのお役に立てると嬉しいな💖' });
        await logToDb(groupId, "グループ参加イベント", "グループ参加メッセージ", "System", "system_join");
    } catch (replyError) {
        await safePushMessage(groupId, { type: 'text', text: '皆さん、こんにちは！皆守こころです🌸\nこのグループで、みんなのお役に立てると嬉しいな💖' });
        await logErrorToDb(groupId, `Join event replyMessage失敗、safePushMessageでフォールバック`, { error: replyError.message, groupId: groupId });
    }
    return;
}

// --- Leaveイベントハンドラ (グループ退出時) ---
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
    return;
}

// --- LINE Webhook ---
app.post('/webhook', async (req, res) => {
    res.sendStatus(200);

    const events = req.body.events;
    if (!events || events.length === 0) {
        return;
    }

    try {
        await Promise.all(
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
                } else {
                    if (process.env.NODE_ENV !== 'production') {
                        console.log("Unhandled event type:", event.type, event);
                    }
                }
            })
        );
    } catch (err) {
        console.error("🚨 Webhook処理中に予期せぬエラーが発生しました:", err);
    }
});

// --- サーバー起動 ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server is running on port ${PORT}`);
});
