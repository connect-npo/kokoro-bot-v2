// --- dotenvを読み込んで環境変数を安全に管理 ---
require('dotenv').config();

// --- 必要なモジュールのインポート ---
const express = require('express');
const { Client } = require('@line/bot-sdk');
const admin = require('firebase-admin');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { OpenAI } = require('openai');
const axios = require('axios'); // ⭐追加: Google Formsへのリクエスト用 ⭐

const app = express();
app.use(express.json());

// --- 環境変数の設定 ---
const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OWNER_USER_ID = process.env.OWNER_USER_ID;
const OFFICER_GROUP_ID = process.env.OFFICER_GROUP_ID;
const GEMINI_PRO_API_KEY = process.env.GEMINI_PRO_API_KEY;
const EMERGENCY_CONTACT_PHONE_NUMBER = process.env.EMERGENCY_CONTACT_PHONE_NUMBER || '09048393313';

let BOT_ADMIN_IDS = ["Udada4206b73648833b844cfbf1562a87"];
if (process.env.BOT_ADMIN_IDS) {
    try {
        BOT_ADMIN_IDS = JSON.parse(process.env.BOT_ADMIN_IDS);
    } catch (e) {
        console.error("❌ BOT_ADMIN_IDS 環境変数のパースに失敗しました。JSON形式で設定してください。", e);
        BOT_ADMIN_IDS = process.env.BOT_ADMIN_IDS.split(',').map(id => id.trim());
    }
}
const FIREBASE_CREDENTIALS_BASE64 = process.env.FIREBASE_CREDENTIALS_BASE64;


// --- GoogleフォームのURLとentry ID ---
const WATCH_SERVICE_FORM_BASE_URL = process.env.WATCH_SERVICE_FORM_BASE_URL || "https://docs.google.com/forms/d/e/1FAIpQLSdYfVmS8kc71_VASWJe4xtUXpiOhmoQNWyI_oT_DSe2xP4Iuw/viewform";
const AGREEMENT_FORM_BASE_URL = process.env.AGREEMENT_FORM_BASE_URL || "https://docs.google.com/forms/d/e/1FAIpQLSepSxcnUL9d_dF3aHRrttCKoxJT4irNvUB0JcPIyguH02CErw/viewform";
const STUDENT_ELEMENTARY_FORM_BASE_URL = process.env.STUDENT_ELEMENTARY_FORM_BASE_URL || AGREEMENT_FORM_BASE_URL;
const STUDENT_MIDDLE_HIGH_UNI_FORM_BASE_URL = process.env.STUDENT_MIDDLE_HIGH_UNI_FORM_BASE_URL || "https://docs.google.com/forms/d/e/1FAIpQLSeDu8-O9MS9G6S6xUaPZiv-X9AvsWNEwjvySxhdotPPdjtU1A/viewform";
const ADULT_FORM_BASE_URL = process.env.ADULT_FORM_BASE_URL || "https://docs.google.com/forms/d/e/1FAIpQLSf-HWanQxJWsSaBuoDAtDSweJ-VCHkONTkp0yhknO4aN6OdMA/viewform";
const MEMBER_CHANGE_FORM_BASE_URL = process.env.MEMBER_CHANGE_FORM_BASE_URL || "https://docs.google.com/forms/d/e/1FAIpQLSfstUhLrG3aEycQV29pSKDW1hjpR5PykKR9Slx69czmPtj99w/viewform";
const INQUIRY_FORM_BASE_URL = process.env.INQUIRY_FORM_BASE_URL || "https://forms.gle/N1FbBQn3C3e7Qa2D8";

const WATCH_SERVICE_FORM_LINE_USER_ID_ENTRY_ID = process.env.WATCH_SERVICE_FORM_LINE_USER_ID_ENTRY_ID || 'entry.312175830';
const AGREEMENT_FORM_LINE_USER_ID_ENTRY_ID = process.env.AGREEMENT_FORM_LINE_USER_ID_ENTRY_ID || 'entry.790268681';
const STUDENT_ELEMENTARY_FORM_LINE_USER_ID_ENTRY_ID = process.env.STUDENT_ELEMENTARY_FORM_LINE_USER_ID_ENTRY_ID || AGREEMENT_FORM_LINE_USER_ID_ENTRY_ID;
const STUDENT_MIDDLE_HIGH_UNI_FORM_LINE_USER_ID_ENTRY_ID = process.env.STUDENT_MIDDLE_HIGH_UNI_FORM_LINE_USER_ID_ENTRY_ID || 'entry.1100280108';
const ADULT_FORM_LINE_USER_ID_ENTRY_ID = process.env.ADULT_FORM_LINE_USER_ID_ENTRY_ID || 'entry.1694651394';
const MEMBER_CHANGE_FORM_LINE_USER_ID_ENTRY_ID = process.env.MEMBER_CHANGE_FORM_LINE_USER_ID_ENTRY_ID || 'entry.743637502';


function addParamToFormUrl(baseUrl, paramName, paramValue) {
    if (!paramValue) {
        return baseUrl;
    }
    const separator = baseUrl.includes('?') ? '&' : '?';
    return `${baseUrl}${separator}${paramName}=${encodeURIComponent(paramValue)}`;
}

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
const geminiFlashModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });

const genAIPro = new GoogleGenerativeAI(GEMINI_PRO_API_KEY);
const geminiProModel = genAIPro.getGenerativeModel({ model: "gemini-1.5-pro-latest" });

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });


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


// --- ログ関数と補助関数 ---
async function logToDb(userId, userMessage, botMessage, sender, type, isOfficialResponse = false) {
    try {
        await db.collection('chats').add({
            userId, userMessage, botMessage, sender,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            type, isOfficialResponse
        });
    } catch (error) {
        console.error("❌ Firestoreへのログ書き込みエラー:", error);
    }
}
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
async function shouldRespond(userId) {
    const docRef = db.collection('replyLocks').doc(userId);
    const doc = await docRef.get();
    const now = admin.firestore.Timestamp.now().toMillis();
    const COOLDOWN_PERIOD_MS = 5000;
    if (doc.exists) {
        const data = doc.data();
        if (data.lastRepliedAt && (now - data.lastRepliedAt) < COOLDOWN_PERIOD_MS) {
            return false;
        }
    }
    await docRef.set({ lastRepliedAt: now }, { merge: true });
    return true;
}

// 危険ワード、詐欺ワードをチェックして通知する関数
async function checkKeywordsAndNotify(userId, message) {
    const isDanger = dangerWords.some(word => message.includes(word));
    const isScam = scamWords.some(regex => regex.test(message));
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
            await safePushMessage(userId, { type: "flex", altText: "緊急連絡先です。", contents: EMERGENCY_FLEX_MESSAGE });
            await notifyOfficerGroup(message, userId, userInfo, 'danger', '危険ワード検知');
        }
        if (isScam) {
            await safePushMessage(userId, { type: "flex", altText: "詐欺注意喚起です。", contents: SCAM_FLEX_MESSAGE });
            await notifyOfficerGroup(message, userId, userInfo, 'scam', '詐欺ワード検知');
        }
        return true;
    }
    return false;
}

// 管理者グループへの通知関数 (watch-service.jsと共有)
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


// --- 応答モード管理 ---
async function getUserMode(userId) {
    const userDoc = await db.collection('users').doc(userId).get();
    return userDoc.exists && userDoc.data().mode ? userDoc.data().mode : 'normal';
}

async function setUserMode(userId, mode) {
    await db.collection('users').doc(userId).set({ mode }, { merge: true });
}

// --- 主要なイベントハンドラ関数 ---
async function handleEvent(event) {
    if (event.type !== 'message' || event.message.type !== 'text') {
        return;
    }

    const userId = event.source.userId;
    const userMessage = event.message.text.trim();
    const replyToken = event.replyToken;

    if (userMessage.startsWith('ping') || userMessage.startsWith('Ping')) {
        await client.replyMessage(replyToken, { type: 'text', text: 'pong' });
        return;
    }

    const shouldProc = await shouldRespond(userId);
    if (!shouldProc && !BOT_ADMIN_IDS.includes(userId)) {
        return;
    }

    const keywordDetected = await checkKeywordsAndNotify(userId, userMessage);
    if (keywordDetected) {
        return;
    }

    const specialReply = checkSpecialReply(userMessage);
    if (specialReply) {
        await safePushMessage(userId, { type: 'text', text: specialReply });
        await logToDb(userId, userMessage, specialReply, 'bot', 'special_reply', true);
        return;
    }

    let userDoc = await db.collection('users').doc(userId).get();
    let userData = userDoc.exists ? userDoc.data() : { role: 'guest', messageCount: 0, mode: 'normal' };
    const { role, messageCount, lastMessageDate, mode } = userData;

    if (mode === 'normal' && userMessage.includes('モード変更')) {
        const changeModeMessage = {
            type: "flex",
            altText: "モード変更メニュー",
            contents: {
                type: "bubble",
                body: {
                    type: "box",
                    layout: "vertical",
                    contents: [{
                        type: "text",
                        text: "モード変更メニュー",
                        weight: "bold",
                        size: "xl",
                        align: "center",
                        color: "#FF69B4"
                    }, {
                        type: "text",
                        text: "使いたいAIモデルを選んでね！",
                        wrap: true,
                        margin: "md",
                        size: "sm",
                        align: "center"
                    }]
                },
                footer: {
                    type: "box",
                    layout: "vertical",
                    spacing: "sm",
                    contents: [{
                        type: "button",
                        action: { type: "postback", label: "GPT-4o", data: "action=change_mode&model=gpt-4o" },
                        style: "primary",
                        height: "sm",
                        margin: "md",
                        color: "#00BFFF"
                    }, {
                        type: "button",
                        action: { type: "postback", label: "Gemini 1.5 Flash", data: "action=change_mode&model=gemini-flash" },
                        style: "primary",
                        height: "sm",
                        margin: "md",
                        color: "#FFD700"
                    }]
                }
            }
        };
        await safePushMessage(userId, changeModeMessage);
        return;
    }
    
    // ⭐相談モードへの移行 ⭐
    if (mode === 'normal' && userMessage.includes('相談したい')) {
        await setUserMode(userId, 'pro_talk');
        await safePushMessage(userId, { type: 'text', text: 'うん、お話聞かせてね🌸 一度だけ、Gemini 1.5 Proでじっくり話そうね。何があったの？💖' });
        return;
    }

    const today = new Date().toISOString().split('T')[0];
    const newCount = (lastMessageDate === today) ? messageCount + 1 : 1;
    await db.collection('users').doc(userId).set({
        messageCount: newCount,
        lastMessageDate: today,
        role: role
    }, { merge: true });

    const memberConfig = MEMBERSHIP_CONFIG[role] || MEMBERSHIP_CONFIG.guest;
    if (memberConfig.dailyLimit !== -1 && newCount > memberConfig.dailyLimit) {
        await safePushMessage(userId, { type: 'text', text: memberConfig.exceedLimitMessage });
        return;
    }

    let conversationHistory = [];
    if (BOT_ADMIN_IDS.includes(userId)) {
        const chatSnapshot = await db.collection('chats')
            .where('userId', '==', userId)
            .orderBy('timestamp', 'desc')
            .limit(10)
            .get();
        conversationHistory = chatSnapshot.docs.reverse().map(doc => doc.data());
    }

    const aiType = mode === 'pro_talk' ? 'gemini-pro' : (userMessage.includes('GPT') || userMessage.includes('gpt')) ? 'gpt-4o' : 'gemini-flash';
    
    let botMessage;
    if (aiType === 'gpt-4o') {
        const historyForGPT = conversationHistory.map(chat => ({
            role: chat.sender === 'user' ? 'user' : 'assistant',
            content: chat.userMessage || chat.botMessage
        }));
        historyForGPT.push({ role: 'user', content: userMessage });

        const systemPrompt = `
            あなたは「皆守こころ（みなもりこころ）」という名前の、NPO法人コネクトのイメージキャラクターです。
            子どもや高齢者を含む幅広い世代の相談に乗る優しいキャラクターを演じてください。
            あなたの口調は、明るく、優しく、親しみやすい「〜だよ💖」「〜だね🌸」といった形です。
            感情豊かな絵文字を積極的に使用してください。
            ユーザーの問いかけに寄り添い、丁寧に応対してください。
            ただし、不適切な言葉や危険なワードに対しては、即座に警告と連絡先を提示してください。
            ${memberConfig.systemInstructionModifier}
            `;
        try {
            const completion = await openai.chat.completions.create({
                model: "gpt-4o",
                messages: [{ role: "system", content: systemPrompt }, ...historyForGPT],
            });
            botMessage = completion.choices[0].message.content;
        } catch (error) {
            console.error('❌ OpenAI APIエラー:', error);
            await logErrorToDb(userId, 'OpenAI APIエラー', { error: error.message });
            botMessage = 'ごめんね、今ちょっとお話ができないみたい💦 もう一度試してみてくれると嬉しいな💖';
        }
    } else if (aiType === 'gemini-flash' || aiType === 'gemini-pro') {
        const targetModel = aiType === 'gemini-pro' ? geminiProModel : geminiFlashModel;
        const systemPrompt = `
            あなたは「皆守こころ（みなもりこころ）」という名前の、NPO法人コネクトのイメージキャラクターです。
            子どもや高齢者を含む幅広い世代の相談に乗る優しいキャラクターを演じてください。
            あなたの口調は、明るく、優しく、親しみやすい「〜だよ💖」「〜だね🌸」といった形です。
            感情豊かな絵文字を積極的に使用してください。
            ユーザーの問いかけに寄り添い、丁寧に応対してください。
            ただし、不適切な言葉や危険なワードに対しては、即座に警告と連絡先を提示してください。
            ${memberConfig.systemInstructionModifier}
        `;
        const chat = targetModel.startChat({
            history: conversationHistory.map(chat => ({
                role: chat.sender === 'user' ? 'user' : 'model',
                parts: [{ text: chat.userMessage || chat.botMessage }]
            })),
            safetySettings: AI_SAFETY_SETTINGS,
            generationConfig: {
                stopSequences: ["\n\n"],
            },
            systemInstruction: systemPrompt
        });
        try {
            const result = await chat.sendMessage(userMessage);
            const response = result.response;
            botMessage = response.text();
            if (mode === 'pro_talk') {
                await setUserMode(userId, 'normal'); // 相談モードを終了
                botMessage += '\n\n💖相談モードは一旦終了するね💖\nまた何かあったらいつでも話してね！';
            }
        } catch (error) {
            console.error('❌ Gemini APIエラー:', error);
            await logErrorToDb(userId, 'Gemini APIエラー', { error: error.message });
            botMessage = 'ごめんね、今ちょっとお話ができないみたい💦 もう一度試してみてくれると嬉しいな💖';
        }
    } else {
        botMessage = 'ごめんね、どのAIモデルを使うか分からなかったよ💦もう一度教えてくれるかな？💖';
    }

    await safePushMessage(userId, { type: 'text', text: botMessage });
    await logToDb(userId, userMessage, botMessage, 'user', 'gemini');
}

async function handlePostbackEvent(event) {
    const userId = event.source.userId;
    const postbackData = new URLSearchParams(event.postback.data);
    const action = postbackData.get('action');

    if (action === 'change_mode') {
        const model = postbackData.get('model');
        await setUserMode(userId, model === 'gpt-4o' ? 'gpt-talk' : 'normal');
        const message = `了解だよ！💖 これから${model === 'gpt-4o' ? 'GPT-4o' : 'Gemini 1.5 Flash'}で応答するね🌸`;
        await safePushMessage(userId, { type: 'text', text: message });
    } else if (action === 'watch_unregister') {
        const watchServiceUnregisterUrl = addParamToFormUrl(WATCH_SERVICE_UNREGISTER_FORM_BASE_URL, WATCH_SERVICE_UNREGISTER_FORM_LINE_USER_ID_ENTRY_ID, userId);
        const unregisterFlexMessage = {
            type: "bubble",
            body: {
                type: "box",
                layout: "vertical",
                contents: [{
                    type: "text",
                    text: "見守りサービス解除メニュー",
                    weight: "bold",
                    size: "lg",
                    align: "center",
                    color: "#FF69B4"
                }, {
                    type: "text",
                    text: "見守りサービスを解除する場合は、以下のボタンから手続きしてね！",
                    wrap: true,
                    margin: "md",
                    size: "sm",
                    align: "center"
                }]
            },
            footer: {
                type: "box",
                layout: "vertical",
                spacing: "sm",
                contents: [{
                    type: "button",
                    action: { type: "uri", label: "見守りサービスを解除する", uri: watchServiceUnregisterUrl },
                    style: "primary",
                    height: "sm",
                    margin: "md",
                    color: "#d63384"
                }]
            }
        };
        await safePushMessage(userId, unregisterFlexMessage);
    }
}

async function handleFollowEvent(event) {
    const userId = event.source.userId;
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) {
        await db.collection('users').doc(userId).set({
            role: 'guest',
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            lastInteractedAt: admin.firestore.FieldValue.serverTimestamp(),
            messageCount: 0,
            watchServiceEnabled: false,
            mode: 'normal'
        });
    }

    const message = {
        type: 'text',
        text: 'はじめまして🌸 こころだよ！わたしはみんなの悩みを優しく聞いたり、一緒に楽しくお話したり、時にはそっと見守ったりするAIキャラクターだよ😊\n\n困ったことや話したいことがあったら、いつでも気軽に話しかけてね💖'
    };
    await safePushMessage(userId, message);
}

async function handleUnfollowEvent(event) {
    const userId = event.source.userId;
    console.log(`❌ Unfollowed by user: ${userId}`);
    await db.collection('users').doc(userId).delete();
}

async function handleJoinEvent(event) {
    const groupId = event.source.groupId;
    const joinMessage = {
        type: 'text',
        text: 'はじめまして🌸 こころだよ！このグループに招待してくれてありがとう😊\n\nグループでの会話は見守りサービスとして、みんなの安全のために見守ってるよ。もし、個人的に相談したいことがあったら、私に直接メッセージしてね💖\n\nもし危険な言葉を見つけたり、詐欺の可能性のある言葉を見つけたら理事会のグループに通知を飛ばすよ。'
    };
    await safePushMessage(groupId, joinMessage);
}

async function handleLeaveEvent(event) {
    const groupId = event.source.groupId;
    console.log(`❌ Left group: ${groupId}`);
}

// --- LINE Webhook --
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

// --- サーバーの起動 ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ Server is running on port ${PORT}`);
});
