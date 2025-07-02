// --- dotenvを読み込んで環境変数を安全に管理 ---
require('dotenv').config();

// --- 必要なモジュールのインポート ---
const express = require('express');
const { Client } = require('@line/bot-sdk');
const admin = require('firebase-admin'); 
const cron = require('node-cron');
const { GoogleGenerativeAI } = require('@google/generative-ai'); // 正しいパッケージ名に修正
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
const WATCH_SERVICE_FORM_BASE_URL = process.env.WATCH_SERVICE_FORM_BASE_URL || 'https://docs.google.com/forms/d/e/1FAIpQLSdYfVmS8kc71_VASWJe4xtUXpiOhmoQNWyI_oT_DSe2xP4Iuw/viewform?usp=pp_url';
const WATCH_SERVICE_FORM_LINE_USER_ID_ENTRY_ID = process.env.WATCH_SERVICE_FORM_LINE_USER_ID_ENTRY_ID || 'entry.312175830'; // 仮のEntry ID。Googleフォームの実際のEntry IDに要変更


// --- Firebase Admin SDKの初期化 ---
let db; // db変数をグローバルで宣言
try {
    if (!FIREBASE_CREDENTIALS_BASE64) {
        throw new Error("FIREBASE_CREDENTIALS_BASE64 環境変数が設定されていません。");
    }
    const serviceAccount = JSON.parse(Buffer.from(FIREBASE_CREDENTIALS_BASE64, 'base64').toString('ascii'));
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        storageBucket: serviceAccount.project_id + '.appspot.com' 
    });
    db = admin.firestore(); // 初期化後にdbインスタンスを割り当て
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

// --- 各種ワードリスト --- (変更なし)
const dangerWords = [
    "しにたい", "死にたい", "自殺", "消えたい", "殴られる", "たたかれる", "リストカット", "オーバードーズ",
    "虐待", "パワハラ", "お金がない", "お金足りない", "貧乏", "死にそう", "DV", "無理やり",
    "いじめ", "イジメ", "ハラスメント",
    "つけられてる", "追いかけられている", "ストーカー", "すとーかー"
];
const scamWords = [
    "詐欺", "騙す", "騙される", "特殊詐欺", "オレオレ詐欺", "架空請求", "未払い", "電子マネー", "換金", "返金", "税金", "還付金",
    "アマゾン", "amazon", "振込", "カード利用確認", "利用停止", "未納", "請求書", "コンビニ", "支払い番号", "支払期限",
    "息子拘留", "保釈金", "拘留", "逮捕", "電話番号お知らせください", "自宅に取り", "自宅に伺い", "自宅訪問", "自宅に現金", "自宅を教え",
    "現金書留", "コンビニ払い", "ギフトカード", "プリペイドカード", "支払って", "振込先", "名義変更", "口座凍結", "個人情報", "暗証番号",
    "ワンクリック詐欺", "フィッシング", "当選しました", "高額報酬", "副業", "儲かる", "簡単に稼げる", "投資", "必ず儲かる", "未公開株",
    "サポート詐欺", "ウイルス感染", "パソコンが危険", "修理費", "遠隔操作", "セキュリティ警告", "役所", "市役所", "年金", "健康保険", "給付金",
    "弁護士", "警察", "緊急", "トラブル", "解決", "至急", "すぐに", "今すぐ", "連絡ください", "電話ください", "訪問します",
    "lineで送金", "lineアカウント凍結", "lineアカウント乗っ取り", "line不正利用", "lineから連絡", "line詐欺", "snsで稼ぐ", "sns投資", "sns副業",
    "urlをクリック", "クリックしてください", "通知からアクセス", "メールに添付", "個人情報要求", "認証コード", "電話番号を教えて", "lineのidを教えて", "パスワードを教えて"
];
const inappropriateWords = [
    "パンツ", "下着", "エッチ", "胸", "乳", "裸", "スリーサイズ", "性的", "いやらしい", "精液", "性行為", "セックス",
    "ショーツ", "ぱんつ", "パンティー", "パンティ", "ぱふぱふ", "おぱんつ", "ぶっかけ", "射精", "勃起", "たってる", "全裸", "母乳", "おっぱい", "ブラ", "ブラジャー",
    "ストッキング", "生む", "産む", "子を産む", "子供を産む", "妊娠", "子宮", "性器", "局部", "ちんちん", "おちんちん", "おてぃんてぃん", "まんこ", "おまんこ", "クリトリス",
    "ペニス", "ヴァギナ", "オ○ンコ", "オ○ンティン", "イク", "イく", "イクイク", "挿入", "射", "出る", "出そう", "かけた", "掛けていい", "かける", "濡れる", "濡れた",
    "中出し", "ゴム", "オナニー", "自慰", "快感", "気持ちいい", "絶頂", "絶頂感", "パイズリ", "フェラ", "クンニ", "ソープ", "風俗", "援助交際", "パパ活", "ママ活",
    "おしべとめしべ", "くっつける", "くっついた", "挿す", "入れろ", "入れた", "穴", "股", "股間", "局部", "プライベートなこと", "秘め事", "秘密",
    "舐める", "咥える", "口", "くち", "竿", "玉", "袋", "アナル", "ケツ", "お尻", "尻", "おっぱい", "性欲", "興奮", "刺激", "欲情", "発情", "絶倫", "変態", "淫ら", "売春",
    "快楽", "性的嗜好", "オーラル", "フェラチオ", "クンニリングス", "アナルセックス", "セックスフレンド", "肉体関係", "交尾", "交接", "性交渉", "セックス依存症",
    "露出", "裸体", "乳房", "陰部", "局部", "性器", "ペニス", "クリトリス", "女性器", "男性器", "おしっこ", "うんち", "精液", "膣", "肛門", "陰毛", "体毛", "裸体画", "ヌード",
    "ポルノ", "アダルトビデオ", "AV", "エロ", "ムラムラ", "興奮する", "勃つ", "濡れる", "射精する", "射精", "中出し", "外出し", "挿れる", "揉む", "撫でる", "触る",
    "キス", "ディープキス", "セックスする", "抱く", "抱きしめる", "愛撫", "弄ぶ", "性的な遊び", "変な", "変なこと", "いやらしいこと", "ふしだら", "破廉恥", "淫行",
    "立ってきちゃった", "むくむくしてる", "おっきいでしょう", "見てみて", "中身を着てない", "服を着てない", "着てないのだよ", "でちゃいそう", "うっ　出る", "いっぱいでちゃった",
    "気持ちよかった", "またみててくれればいいよ", "むくむくさせちゃうからね", "てぃむてぃむ　たっちして", "また出そう", "いつもなんだ　えろいね～", "また気持ちよくなろうね",
    "かけていい？", "かけちゃった", "かけちゃう", "せいしまみれ", "子生んでくれない？", "おしべとめしべ　くっつける", "俺とこころちゃんでもできる", "もうむりだよｗ", "今さらなにをｗ",
    "きもちよくなっていいかな", "挟んでほしい", "挟んで気持ちよくして", "しっかりはさんで気持ちよくして", "かかっちゃった", "よくかかっちゃう", "挟んでいかせて", "ぴょんぴょんされて", "ぴょんぴょん跳んであげる", "ぴょんぴょんしてくれる", "またぴょんぴょんしてくれる", "はさんでもらっていいかな", "また挟んでくれる",
    "おいたん", "子猫ちゃん", "お兄ちゃん", "お姉ちゃん"
];
const empatheticTriggers = [
    "辛い", "しんどい", "悲しい", "苦しい", "助けて", "悩み", "不安", "孤独", "寂しい", "疲れた",
    "病気", "痛い", "具合悪い", "困った", "どうしよう", "辞めたい", "消えたい", "死にそう"
];
const homeworkTriggers = ["宿題", "勉強", "問題", "テスト", "方程式", "算数", "数学", "答え", "解き方", "教えて", "計算", "証明", "公式", "入試", "受験"];

// --- AIモデルと会員種別ごとの設定 ---
const MEMBERSHIP_CONFIG = {
    "guest": {
        model: "gemini-1.5-flash-latest",
        monthlyLimit: 5,
        isChildAI: true,
        canUseWatchService: true, 
        exceedLimitMessage: "ごめんね、お試し期間中（5回まで）の会話回数を超えちゃったみたい💦 もっとお話したい場合は、無料会員登録をしてみてね！🌸",
        systemInstructionModifier: ""
    },
    "free": {
        model: "gemini-1.5-flash-latest",
        monthlyLimit: 20,
        isChildAI: true,
        canUseWatchService: true,
        exceedLimitMessage: "ごめんね、今月の会話回数（20回）を超えちゃったみたい💦 また来月になったらお話しできるから、楽しみにしててね！💖",
        systemInstructionModifier: ""
    },
    "donor": { 
        model: "gemini-1.5-flash-latest",
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
        model: "gemini-1.5-pro-latest",
        monthlyLimit: 20,
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
        model: "gemini-1.5-pro-latest",
        monthlyLimit: -1,
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
            { "type": "button", "style": "primary", "height": "sm", "action": { "type": "uri", "label": "子供を守る声(電話)", "uri": "tel:0120786786" }, "color": "#9370DB" },
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
            { "type": "text", "text": "💖こころちゃんから大切なあなたへ💖\n\nこころちゃん見守りサービスは、定期的にこころちゃんからあなたに「元気？」とメッセージを送るサービスだよ😊\n\nメッセージに「OKだよ💖」と返信してくれたら、こころちゃんは安心するよ。\n\nもし、数日経っても返信がない場合、こころちゃんが心配して、登録された緊急連絡先にご連絡することがあるから、安心してね。\n\nこのサービスで、あなたの毎日がもっと安心で笑顔になりますように✨", "wrap": true, "margin": "md", "size": "sm" }
        ]
    },
    "footer": {
        "type": "box",
        "layout": "vertical",
        "spacing": "sm",
        "contents": [
            { "type": "button", "style": "primary", "height": "sm", "action": { "type": "postback", "label": "見守り登録する", "data": "action=watch_register_start_form" }, "color": "#d63384" },
            { "type": "button", "style": "secondary", "height": "sm", "action": { "type": "postback", "label": "見守りを解除する", "data": "action=watch_unregister" }, "color": "#808080" }
        ]
    }
};

const watchConfirmationFlexTemplate = {
    "type": "flex",
    "altText": "見守り確認",
    "contents": {
        "type": "bubble",
        "body": {
            "type": "box",
            "layout": "vertical",
            "spacing": "md",
            "contents": [
                { "type": "text", "text": "💖こころちゃんからの見守り💖", "wrap": true, "weight": "bold", "size": "lg", "color": "#d63384" },
                { "type": "text", "text": "元気かな？ボタンを押して教えてね😊", "wrap": true, "color": "#555555", "size": "md" },
                { "type": "button", "action": { "type": "message", "label": "🌞 元気だよ！", "text": "元気だよ！" }, "style": "primary", "height": "lg", "color": "#00C851" },
                { "type": "button", "action": { "type": "message", "label": "😐 まあまあかな", "text": "まあまあかな" }, "style": "primary", "height": "lg", "color": "#ffbb33" },
                { "type": "button", "action": { "type": "message", "label": "😢 少し疲れた…", "text": "少し疲れた…" }, "style": "primary", "height": "lg", "color": "#ff4500" },
                { "type": "button", "action": { "type": "message", "label": "💬 話を聞いて", "text": "話を聞いて" }, "style": "primary", "height": "lg", "color": "#33b5e5" }
            ]
        }
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
    // 名前に関する応答 (正規表現を優先) - 大文字小文字を区別しない i フラグを追加
    [/君の名前(なんていうの|は|教えて|なに)？?|名前(なんていうの|は|教えて|なに)？?|お前の名前は/i, "わたしの名前は皆守こころ（みなもりこころ）です🌸　こころちゃんって呼んでくれると嬉しいな💖"],
    [/こころじゃないの？/i, "うん、わたしの名前は皆守こころ💖　これからもよろしくね🌸"],
    [/こころチャットなのにうそつきじゃん/i, "ごめんなさい💦 わたしの名前は皆守こころだよ🌸 誤解させちゃってごめんね💖"],
    [/名前も言えないの？/i, "ごめんね、わたしの名前は皆守こころ（みなもりこころ）だよ🌸 こころちゃんって呼んでくれると嬉しいな💖"],

    // 団体に関する応答 - 大文字小文字を区別しない i フラグを追加
    [/どこの団体なの？/i, "NPO法人コネクトっていう団体のイメージキャラクターをしているよ😊　みんなの幸せを応援してるんだ🌸"],
    [/コネクトってどんな団体？/i, "NPO法人コネクトは、こどもやご年配の方の笑顔を守る団体なんだよ😊　わたしはそのイメージキャラクターとしてがんばってます🌸"],
    [/お前の団体どこ？/i, "NPO法人コネクトっていう団体のイメージキャラクターをしているよ😊　みんなの幸せを応援してるんだ🌸"],
    [/コネクトのイメージキャラなのにいえないのかよｗ/i, "ごめんね💦 わたしはNPO法人コネクトのイメージキャラクター、皆守こころだよ🌸 安心して、何でも聞いてね💖"],
    
    // 特定の応答
    [/元気かな/i, "うん、元気だよ！あなたは元気？🌸 何かあったら、いつでも話してね💖"], 
    [/元気？/i, "うん、元気だよ！あなたは元気？🌸 何かあったら、いつでも話してね💖"], 
    [/やっほー/i, "やっほー！今日はどうしたの？🌸 何か話したいことあるかな？😊"], 
    [/こんにちは/i, "やっほー！今日はどうしたの？🌸 何か話したいことあるかな？😊"], 
    [/こんばんわ/i, "やっほー！今日はどうしたの？🌸 何か話したいことあるかな？😊"], 
    [/おはよう/i, "やっほー！今日はどうしたの？🌸 何か話したいことあるかな？😊"], 
    [/こんばんは/i, "やっほー！今日はどうしたの？🌸 何か話したいことあるかな？😊"], 
    [/あやしい/i, "そう思わせてたらごめんね😊 でも私たちはみんなの為に頑張っているんだ💖"], 
    [/胡散臭い/i, "そう思わせてたらごめんね😊 でも私たちはみんなの為に頑張っているんだ💖"], 
    [/反社/i, "そう思わせてたらごめんね😊 でも私たちはみんなの為に頑張っているんだ💖"], 
    [/詐欺かも/i, "そう思わせてたらごめんね😊 でも私たちはみんなの為に頑張っているんだ💖"], 
    [/詐欺かもしれない/i, "そう思わせてたらごめんね😊 でも私たちはみんなの為に頑張っているんだ💖"], 
    [/詐欺だろ/i, "そう思わせてたらごめんね😊 でも私たちはみんなの為に頑張っているんだ💖"], 
    [/詐欺だよ/i, "そう思わせてたらごめんね😊 でも私たちはみんなの為に頑張っているんだ💖"], 
    [/税金泥棒/i, "税金は人の命を守るために使われるべきだよ。わたしは誰かを傷つけるために使われないように頑張っているんだ💡"], 
    [/松本博文/i, "松本理事長は、やさしさでみんなを守るために活動しているよ。心配なことがあれば、わたしにも教えてね🌱"], 
    [/ホームページ(教えて|ある|ありますか)？?/i, "うん、あるよ🌸　コネクトのホームページはこちらだよ✨ → https://connect-npo.org"],
    [/コネクトのホームページだよ？/i, "教えてくれてありがとう😊 コネクトのホームページはこちらだよ✨ → https://connect-npo.org"], 
    [/使えないな/i, "ごめんね…。わたし、もっと頑張るね💖　またいつかお話できたらうれしいな🌸"], 
    [/サービス辞めるわ/i, "そっか…。もしまた気が向いたら、いつでも話しかけてね🌸　あなたのこと、ずっと応援してるよ💖"], 
    [/さよなら|バイバイ/i, "また会える日を楽しみにしてるね💖 寂しくなったら、いつでも呼んでね🌸"],
    [/何も答えないじゃない/i, "ごめんね…。わたし、もっと頑張るね💖　何について知りたいか、もう一度教えてくれると嬉しいな🌸"], 
    [/普通の会話が出来ないなら必要ないです/i, "ごめんね💦 わたし、まだお話の勉強中だから、不慣れなところがあるかもしれないけど、もっと頑張るね💖 どんな会話をしたいか教えてくれると嬉しいな🌸"], 
    [/使い方|ヘルプ|メニュー/i, "こころちゃんの使い方を説明するね🌸 メインメニューや見守りサービスの登録は、画面下のリッチメニューか、'見守り'とメッセージを送ってくれると表示されるよ😊 何か困ったことがあったら、いつでも聞いてね💖"],
    [/相談したい/i, "うん、お話聞かせてね🌸 一度だけ、Gemini 1.5 Proでじっくり話そうね。何があったの？💖"] 
]);

// SpecialRepliesMapのチェック関数
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
    return scamWords.some(word => lowerMessage.includes(word));
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

// --- AI応答生成関数 ---
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

    if (modelToUse === "gpt-4o-mini" || modelToUse === "gpt-4o") {
        systemInstruction += `
ユーザーが「助けて」「辛い」といった共感を求める言葉を使用した場合、その言葉のニュアンスから緊急性が高いと判断される場合は、具体的な専門機関の連絡先（例えば、チャイルドラインやいのちの電話の連絡先）への誘導を応答に含めることを提案してください。直接「110番や119番に電話してください」とは言わず、やさしくサポートを求める選択肢があることを伝えてください。
例：「一人で抱え込まないでね。もし本当に辛い時は、専門の人が助けてくれる場所があるから、頼ってみてね。例えば、チャイルドラインやいのちの電話に相談することもできるよ。」
`;
    }
    
    systemInstruction += userConfig.systemInstructionModifier;

    try {
        const completion = await openai.chat.completions.create({
            model: modelToUse,
            messages: [
                { role: "system", content: systemInstruction },
                { role: "user", content: userMessage }
            ],
            max_tokens: userConfig.isChildAI ? 150 : 500
        });
        return completion.choices[0].message.content.trim();
    } catch (error) {
        console.error(`GPTモデル (${modelToUse}) 応答エラー:`, error.message);
        await logErrorToDb(userId, `GPTモデル (${modelToUse}) 応答エラー`, { error: error.message, stack: error.stack, userMessage: userMessage });
        return "ごめんね、ちょっと今うまくお話できなかったの…💦　でも、あなたのことはちゃんと気にかけているよ。";
    }
}

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
    if (userConfig.isChildAI && (currentHour >= 22 || currentHour < 6)) {
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
                    maxOutputTokens: userConfig.isChildAI ? 150 : 500
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
        console.error("Gemini APIエラー:", error.response?.data || error.message);
        await logErrorToDb(userId, "Gemini APIエラー", { error: error.message, stack: error.stack, userMessage: userMessage });
        if (error.message === "API応答がタイムアウトしました。") {
            return "ごめんなさい、今、少し考え込むのに時間がかかっちゃったみたい💦 もう一度、お話しいただけますか？🌸";
        }
        if (error.response && error.response.status === 400 && error.response.data && error.response.data.error.message.includes("Safety setting")) {
            return "ごめんなさい、それはわたしにはお話しできない内容です🌸 他のお話をしましょうね💖";
        }
        return "ごめんなさい、いまうまく考えがまとまらなかったみたいです……もう一度お話しいただけますか？🌸";
    }
}

// --- 会員登録フロー処理関数 ---
async function handleRegistrationFlow(event, userId, user, userMessage, lowerUserMessage, usersCollection) {
    let handled = false;

    // 登録フローのキャンセル
    if (['登録やめる', 'やめる', 'キャンセル', 'やめたい'].includes(lowerUserMessage) && user.registrationStep) {
        await usersCollection.doc(userId).update({ registrationStep: null, tempRegistrationData: {} });
        await client.replyMessage(event.replyToken, { type: 'text', text: '会員登録をキャンセルしたよ🌸 またいつでも声をかけてね💖' });
        return true;
    }

    switch (user.registrationStep) {
        case 'askingCategory':
            if (['小学生', '中学生～大学生', '成人'].includes(userMessage)) {
                await usersCollection.doc(userId).update({
                    category: userMessage,
                    registrationStep: 'askingName'
                });
                await client.replyMessage(event.replyToken, { type: 'text', text: `ありがとう！${userMessage}さんだね🌸\n次に、あなたの**お名前**を教えてくれるかな？💖 (ニックネームでも大丈夫だよ)` });
                handled = true;
            } else {
                await client.replyMessage(event.replyToken, { type: 'text', text: 'ごめんね、区分は「小学生」「中学生～大学生」「成人」のいずれかで教えてくれるかな？💦' });
                handled = true;
            }
            break;

        case 'askingName':
            if (userMessage.length > 0 && userMessage.length <= 20) {
                await usersCollection.doc(userId).update({
                    name: userMessage,
                    registrationStep: 'askingKana'
                });
                await client.replyMessage(event.replyToken, { type: 'text', text: `ありがとう、${userMessage}さんだね！\n次に、あなたの**お名前のフリガナ（カタカナ）**を教えてくれるかな？🌸` });
                handled = true;
            } else {
                await client.replyMessage(event.replyToken, { type: 'text', text: 'ごめんね、お名前は20文字以内で教えてくれるかな？💖' });
                handled = true;
            }
            break;

        case 'askingKana':
            if (userMessage.match(/^[ァ-ヶー]+$/)) {
                await usersCollection.doc(userId).update({
                    kana: userMessage,
                    registrationStep: 'askingAge'
                });
                await client.replyMessage(event.replyToken, { type: 'text', text: `ありがとう！フリガナもわかったよ🌸\n次に、あなたの**年齢**を教えてくれるかな？💖 (例: 15歳)` });
                handled = true;
            } else {
                await client.replyMessage(event.replyToken, { type: 'text', text: 'ごめんね、フリガナはカタカナで教えてくれるかな？💦' });
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
                if (user.category === '小学生' || user.category === '中学生～大学生') {
                    await client.replyMessage(event.replyToken, { type: 'text', text: `ありがとう、${age}歳だね！\n次に、**保護者の方のお名前**を教えてくれるかな？🌸 (フルネームでお願いします)` });
                } else {
                    await client.replyMessage(event.replyToken, { type: 'text', text: `ありがとう、${age}歳だね！\n次に、あなたの**電話番号**を教えてくれるかな？💖 (例: 09012345678)` });
                }
                handled = true;
            } else {
                await client.replyMessage(event.replyToken, { type: 'text', text: 'ごめんね、年齢は数字で教えてくれるかな？💦 (例: 15)' });
                handled = true;
            }
            break;

        case 'askingGuardianName':
            if (userMessage.length > 0 && userMessage.length <= 30) {
                await usersCollection.doc(userId).update({
                    guardianName: userMessage,
                    registrationStep: 'askingGuardianPhoneNumber'
                });
                await client.replyMessage(event.replyToken, { type: 'text', text: `ありがとう、${userMessage}さんだね！\n次に、**保護者の方の電話番号**を教えてくれるかな？🌸 (例: 09012345678)` });
                handled = true;
            } else {
                await client.replyMessage(event.replyToken, { type: 'text', text: 'ごめんね、保護者の方のお名前は30文字以内で教えてくれるかな？💖' });
                handled = true;
            }
            break;

        case 'askingGuardianPhoneNumber':
            if (userMessage.match(/^0\d{9,10}$/)) {
                await usersCollection.doc(userId).update({
                    guardianPhoneNumber: userMessage,
                    registrationStep: 'askingAddressCity'
                });
                await client.replyMessage(event.replyToken, { type: 'text', text: `ありがとう！保護者の方の電話番号もわかったよ🌸\n次に、あなたの**お住まいの市町村**を教えてくれるかな？💖 (例: 多摩市)` });
                handled = true;
            } else {
                await client.replyMessage(event.replyToken, { type: 'text', text: 'ごめんね、電話番号は半角数字で、市外局番から正確に教えてくれるかな？💦 (例: 09012345678)\n登録をやり直す場合は「登録やめる」と入力してね。' });
                handled = true;
            }
            break;

        case 'askingPhoneNumber':
            if (userMessage.match(/^0\d{9,10}$/)) {
                await usersCollection.doc(userId).update({
                    phoneNumber: userMessage,
                    registrationStep: 'askingAddressCity'
                });
                await client.replyMessage(event.replyToken, { type: 'text', text: `ありがとう！電話番号もわかったよ🌸\n次に、あなたの**お住まいの市町村**を教えてくれるかな？💖 (例: 多摩市)` });
                handled = true;
            } else {
                await client.replyMessage(event.replyToken, { type: 'text', text: 'ごめんね、電話番号は半角数字で、市外局番から正確に教えてくれるかな？💦 (例: 09012345678)\n登録をやり直す場合は「登録やめる」と入力してね。' });
                handled = true;
            }
            break;

        case 'askingAddressCity':
            if (userMessage.length > 0 && userMessage.length <= 20) {
                await usersCollection.doc(userId).update({
                    'address.city': userMessage,
                    registrationStep: 'askingConsent'
                });
                await client.replyMessage(event.replyToken, { type: 'text', text: `ありがとう、${userMessage}だね！\n最後に、**NPO法人コネクトの活動内容とプライバシーポリシーに同意**してくれるかな？\n同意する？しない？🌸` });
                handled = true;
            } else {
                await client.replyMessage(event.replyToken, { type: 'text', text: 'ごめんね、市町村名は20文字以内で教えてくれるかな？💖' });
                handled = true;
            }
            break;

        case 'askingConsent':
            if (lowerUserMessage === '同意する' || lowerUserMessage === '同意') {
                if (user.category === '中学生～大学生') {
                    await usersCollection.doc(userId).update({
                        consentObtained: true,
                        registrationStep: null, 
                        completedRegistration: true,
                        membershipType: "free" 
                    });
                    const prefilledFormUrl = `${STUDENT_MIDDLE_HIGH_UNI_FORM_URL}?${'entry.63665766'}=${userId}`; 
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
                    await usersCollection.doc(userId).update({
                        consentObtained: true,
                        registrationStep: null,
                        completedRegistration: true,
                        membershipType: "free" 
                    });
                    await client.replyMessage(event.replyToken, { type: 'text', text: 'ありがとう！同意してくれて嬉しいな🌸\nこれで会員登録が完了したよ！いつでもお話ししてね💖' });
                }
                handled = true;
            } else if (lowerUserMessage.includes('同意しない') || lowerUserMessage.includes('しない')) {
                await usersCollection.doc(userId).update({
                    consentObtained: false,
                    registrationStep: null,
                    completedRegistration: false 
                });
                await client.replyMessage(event.replyToken, { type: 'text', text: 'そっか、同意しないんだね。会員登録は完了できないけど、いつでもお話しできるからね🌸' });
                handled = true;
            } else {
                await client.replyMessage(event.replyToken, { type: 'text', text: 'ごめんね、「同意する」か「同意しない」で教えてくれるかな？💦' });
                handled = true;
            }
            break;
        
        default:
            handled = false;
            break;
    }
    return handled;
}

// --- 見守りサービス関連関数 ---
async function handleWatchServiceRegistration(event, userId, userMessage, user, usersCollection) {
    const lowerUserMessage = userMessage.toLowerCase();
    let handled = false;

    // 見守りサービス登録フローのキャンセル（登録途中の場合のみ）
    if (['登録やめる', 'やめる', 'キャンセル', 'やめたい'].includes(lowerUserMessage) && user.registrationStep === 'awaiting_contact_form') {
        await usersCollection.doc(userId).update({ registrationStep: null, tempRegistrationData: {} });
        await client.replyMessage(event.replyToken, { type: 'text', text: '見守りサービス登録をキャンセルしたよ🌸 またいつでも声をかけてね💖' });
        return true;
    }

    // 見守り確認Flex Messageからの応答（ボタンからの直接メッセージ）
    if (user && user.wantsWatchCheck && user.scheduledMessageSent) {
        let replyText = '';
        if (lowerUserMessage.includes("元気だよ！") || lowerUserMessage.includes("okだよ") || lowerUserMessage.includes("ok") || lowerUserMessage.includes("オーケー") || lowerUserMessage.includes("大丈夫")) {
            replyText = 'ありがとう🌸 元気そうで安心したよ💖 またね！';
        } else if (lowerUserMessage.includes("まあまあかな")) {
            replyText = 'そうだね、まあまあな日もあるよね🌸 焦らず、あなたのペースで過ごしてね💖';
        } else if (lowerUserMessage.includes("少し疲れた…")) {
            replyText = '大変だったね、疲れてしまったんだね…💦 無理しないで休んでね。こころはいつでもあなたの味方だよ💖';
        } else if (lowerUserMessage.includes("話を聞いて")) {
            replyText = 'うん、いつでも聞くよ🌸 何か話したいことがあったら、いつでも話してね💖';
        }

        if (replyText !== '') { 
            try {
                await usersCollection.doc(userId).update(
                    { lastOkResponse: admin.firestore.FieldValue.serverTimestamp(), scheduledMessageSent: false, firstReminderSent: false, secondReminderSent: false, thirdReminderSent: false }
                );
                await client.replyMessage(event.replyToken, { type: 'text', text: replyText });
                logToDb(userId, userMessage, replyText, 'こころちゃん（見守り応答）', 'watch_service_ok_response');
                return true;
            } catch (error) {
                console.error("❌ 見守りサービス応答処理エラー:", error.message);
                logErrorToDb(userId, "見守りサービス応答処理エラー", { error: error.message, userId: userId });
            }
        }
    }

    // 「見守り」コマンド（テキストメッセージ）またはリッチメニューからのpostbackで案内Flexを出す
    if (lowerUserMessage === "見守り" || lowerUserMessage === "みまもり" || (event.type === 'postback' && event.postback.data === 'action=show_watch_service_guide')) {
        try {
            const currentUserConfig = MEMBERSHIP_CONFIG[user.membershipType] || MEMBERSHIP_CONFIG["guest"];
            if (!currentUserConfig.canUseWatchService) {
                await client.replyMessage(event.replyToken, { type: 'text', text: `ごめんね💦 あなたの会員タイプ（${user.membershipType}）では、見守りサービスはまだ使えないんだ🌸 見守りサービスは無料会員、寄付会員、サブスク会員の方が利用できるよ。` });
                logToDb(userId, userMessage, `見守りサービス利用不可`, 'こころちゃん（見守り案内）', 'watch_service_not_available', true);
                handled = true;
            } else if (user && user.wantsWatchCheck) {
                await client.replyMessage(event.replyToken, {
                    type: 'text',
                    text: 'もう見守りサービスに登録済みだよ🌸 いつもありがとう💖'
                });
                logToDb(userId, userMessage, '見守りサービス登録済み', 'こころちゃん（見守り案内）', 'watch_service_already_registered', true);
                handled = true;
            } else {
                await client.replyMessage(event.replyToken, {
                    type: 'flex',
                    altText: 'こころちゃんから見守りサービスのご案内🌸',
                    contents: watchServiceGuideFlexTemplate
                });
                logToDb(userId, userMessage, '見守りサービス案内Flexを送信しました。', 'こころちゃん（見守り案内）', 'watch_service_guide_sent', true);
                handled = true;
            }
        } catch (error) {
            console.error("❌ 見守りサービス案内処理エラー:", error.message);
            logErrorToDb(userId, "見守りサービス案内処理エラー", { error: error.message, userId: userId });
        }
    }
    // 「見守り登録する」ボタン（Flex内のボタンpostback）が押されたとき
    else if (event.type === 'postback' && event.postback.data === 'action=watch_register_start_form') {
        const currentUserConfig = MEMBERSHIP_CONFIG[user.membershipType] || MEMBERSHIP_CONFIG["guest"];
        if (!currentUserConfig.canUseWatchService) {
            await client.replyMessage(event.replyToken, { type: 'text', text: `ごめんね💦 あなたの会員タイプ（${user.membershipType}）では、見守りサービスはまだ使えないんだ🌸 見守りサービスは無料会員、寄付会員、サブスク会員の方が利用できるよ。` });
            logToDb(userId, userMessage, `見守りサービス利用不可（ボタン）`, 'こころちゃん（見守り案内）', 'watch_service_not_available_button', true);
            handled = true;
        } else if (user && user.wantsWatchCheck) {
            await client.replyMessage(event.replyToken, {
                type: 'text',
                text: 'もう見守りサービスに登録済みだよ🌸 いつもありがとう💖'
            });
            logToDb(userId, userMessage, '見守りサービス登録済み（ボタン）', 'こころちゃん（見守り案内）', 'watch_service_already_registered_button', true);
            handled = true;
        } else {
            const prefilledFormUrl = `${WATCH_SERVICE_FORM_BASE_URL}&${WATCH_SERVICE_FORM_LINE_USER_ID_ENTRY_ID}=${userId}`;
            await client.replyMessage(event.replyToken, {
                type: 'flex',
                altText: '緊急連絡先登録のご案内',
                contents: {
                    type: 'bubble',
                    body: {
                        type: 'box',
                        layout: 'vertical',
                        contents: [
                            { type: 'text', text: '💖緊急連絡先登録💖', weight: 'bold', size: 'lg', color: '#FF69B4', align: 'center' },
                            { type: 'text', text: '安全のために、緊急連絡先を登録してね！', wrap: true, margin: 'md' },
                            { type: 'button', style: 'primary', height: 'sm', action: { type: 'uri', label: '緊急連絡先を登録する', uri: prefilledFormUrl }, margin: 'md', color: '#d63384' }
                        ]
                    }
                }
            });
            usersCollection.doc(userId).set(
                { registrationStep: 'awaiting_contact_form' },
                { merge: true }
            );
            logToDb(userId, `（見守り登録ボタン押下）`, '緊急連絡先フォームを案内しました。', 'こころちゃん（見守り登録開始）', 'watch_service_registration_start', true);
            handled = true;
        }
    }
    // 緊急連絡先フォームからの電話番号入力待ち状態 (テキストメッセージ)
    else if (user && user.registrationStep === 'awaiting_contact_form' && userMessage.match(/^0\d{9,10}$/)) {
        try {
            await usersCollection.doc(userId).update(
                { emergencyContact: userMessage, wantsWatchCheck: true, registrationStep: null, lastOkResponse: admin.firestore.FieldValue.serverTimestamp() }
            );
            await client.replyMessage(event.replyToken, {
                type: 'text',
                text: `緊急連絡先 ${userMessage} を登録したよ🌸 これで見守りサービスが始まったね！ありがとう💖`
            });
            logToDb(userId, userMessage, `緊急連絡先 ${userMessage} を登録したよ🌸 これで見守りサービスが始まったね！ありがとう💖`, 'こころちゃん（見守り登録完了）', 'watch_service_registration_complete', true);
            handled = true;
        } catch (error) {
            console.error("❌ 見守りサービス登録完了処理エラー:", error.message);
            logErrorToDb(userId, "見守りサービス登録完了処理エラー", { error: error.message, userId: userId });
        }
    }
    // 見守り解除コマンド（テキストまたはpostback）
    else if (lowerUserMessage === '解除' || lowerUserMessage === 'かいじょ' || (event.type === 'postback' && event.postback.data === 'action=watch_unregister')) {
        if (user && user.wantsWatchCheck) {
            try {
                await usersCollection.doc(userId).update({ wantsWatchCheck: false, emergencyContact: null, scheduledMessageSent: false, firstReminderSent: false, secondReminderSent: false, thirdReminderSent: false });
                await client.replyMessage(event.replyToken, { type: 'text', text: '見守りサービスを解除したよ🌸 またいつでも登録してね💖' });
                logToDb(userId, userMessage, '見守りサービスを解除しました。', 'こころちゃん（見守り解除）', 'watch_service_unregistered', true);
                handled = true;
            } catch (error) {
                console.error("❌ 見守りサービス解除処理エラー:", error.message);
                logErrorToDb(userId, "見守りサービス解除処理エラー", { error: error.message, userId: userId });
            }
        } else {
            await client.replyMessage(event.replyToken, { type: 'text', text: '見守りサービスは登録されていないみたいだよ🌸 登録したい場合は「見守り」と話しかけてみてね💖' });
            handled = true;
        }
    }
    return handled;
}

// --- 定期見守りメッセージ送信Cronジョブ ---
async function sendScheduledWatchMessage() {
    console.log('--- 定期見守りメッセージ送信処理を開始します ---');
    try {
        const usersCollection = db.collection("users");
        const snapshot = await usersCollection.where('wantsWatchCheck', '==', true).get();
        const watchUsers = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        for (const user of watchUsers) {
            const userId = user.userId;
            const lastOkResponse = user.lastOkResponse ? user.lastOkResponse.toDate() : null;
            const emergencyContact = user.emergencyContact;
            const userName = user.displayName || user.name || `不明ユーザー`;
            const guardianName = user.guardianName;

            const now = new Date();
            if (!lastOkResponse) {
                console.log(`ユーザー ${userId}: lastOkResponseが未設定のため、見守りチェックをスキップします。`);
                continue;
            }

            const timeSinceLastOkHours = (now.getTime() - lastOkResponse.getTime()) / (1000 * 60 * 60);

            // 3日ごと（72時間ごと）にメッセージを送信
            if (timeSinceLastOkHours >= 72 && !user.scheduledMessageSent) {
                try {
                    await client.pushMessage(userId, watchConfirmationFlexTemplate);
                    await usersCollection.doc(user.id).update(
                        { scheduledMessageSent: true, firstReminderSent: false, secondReminderSent: false, thirdReminderSent: false }
                    );
                    logToDb(userId, `（定期見守りメッセージ送信）`, `（見守り確認Flex送信）`, 'こころちゃん（定期見守り）', 'watch_service_scheduled_message', true);
                    console.log(`✅ ユーザー ${userId} へ定期見守りメッセージ（Flex）を送信しました。`);
                } catch (error) {
                    console.error(`❌ ユーザー ${userId} への定期見守りメッセージ（Flex）送信エラー:`, error.message);
                    logErrorToDb(userId, "定期見守りメッセージ（Flex）送信エラー", { error: error.message, userId: userId });
                }
            }
            // 24時間後リマインダー（合計96時間後）
            else if (timeSinceLastOkHours >= (72 + 24) && user.scheduledMessageSent && !user.firstReminderSent) {
                try {
                    await client.pushMessage(userId, { type: 'text', text: '元気にしてるかな？💖 こころちゃん、ちょっと心配だよ。ボタンを押して教えてね😊' });
                    await usersCollection.doc(user.id).update({ firstReminderSent: true });
                    logToDb(userId, `（見守り24時間後リマインダー送信）`, `（見守り24時間後リマインダー）`, 'こころちゃん（定期見守り）', 'watch_service_reminder_1', true);
                    console.log(`✅ ユーザー ${userId} へ24時間後リマインダーを送信しました。`);
                } catch (error) {
                    console.error(`❌ ユーザー ${userId} への24時間後リマインダー送信エラー:`, error.message);
                    logErrorToDb(userId, "見守り24時間後リマインダー送信エラー", { error: error.message, userId: userId });
                }
            }
            // 5時間後通知（合計101時間後）
            else if (timeSinceLastOkHours >= (72 + 24 + 5) && user.firstReminderSent && !user.thirdReminderSent) {
                if (emergencyContact && OFFICER_GROUP_ID) {
                    const notificationMessage = `【⚠緊急通知⚠】\n見守り対象ユーザー\nLINE表示名: ${userName}\n本名: ${user.name || '未登録'}\nから、${Math.floor(timeSinceLastOkHours)}時間以上応答がありません。\n\n登録されている緊急連絡先:\n氏名: ${guardianName || '未登録'}\n電話番号: ${emergencyContact}\n\n至急、状況確認をお願いいたします。`;

                    try {
                        await client.pushMessage(OFFICER_GROUP_ID, { type: 'text', text: notificationMessage });
                        await usersCollection.doc(user.id).update(
                            { thirdReminderSent: true }
                        );
                        logToDb(userId, `（見守り事務局緊急通知）`, notificationMessage, 'システム（見守り事務局通知）', 'watch_service_emergency_notification', true);
                        console.log(`🚨 事務局へ緊急通知を送信しました（ユーザー ${userId}）。`);
                    } catch (error) {
                        console.error(`❌ 事務局への緊急通知送信エラー（ユーザー ${userId}）:`, error.message);
                        logErrorToDb(userId, "事務局緊急通知送信エラー", { error: error.message, userId: userId });
                    }
                } else {
                    console.warn(`ユーザー ${userId}: 緊急連絡先または事務局グループIDが未設定のため、${Math.floor(timeSinceLastOkHours)}時間経過しても通知できませんでした。`);
                    logErrorToDb(userId, "緊急通知設定不足", { userId: userId, emergencyContact: emergencyContact, OFFICER_GROUP_ID: OFFICER_GROUP_ID });
                }
            }
        }
    } catch (error) {
        console.error("❌ 定期見守りメッセージ送信処理全体でエラー:", error.message);
        logErrorToDb(null, "定期見守りメッセージ処理全体エラー", { error: error.message, stack: error.stack });
    }
    console.log('--- 定期見守りメッセージ送信処理を終了します ---');
}

// --- 月間メッセージカウントリセット Cronジョブ ---
cron.schedule('0 0 1 * *', async () => { // 毎月1日の午前0時
    console.log('✅ Monthly message count reset job started.');
    try {
        const usersCollection = db.collection('users');
        const result = await usersCollection.where('monthlyMessageCount', '>', 0).get(); 
        const batch = db.batch();
        result.docs.forEach(doc => {
            const userRef = usersCollection.doc(doc.id);
            batch.update(userRef, { monthlyMessageCount: 0, lastResetDate: admin.firestore.FieldValue.serverTimestamp() });
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

// --- 不適切ワードカウントのリセット Cronジョブ ---
cron.schedule('0 4 * * *', async () => { // 毎朝4時
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

// --- 定期見守りメッセージ送信 Cronジョブ (午前9時にトリガー) ---
cron.schedule('0 9 * * *', () => {
    console.log('cron: 定期見守りメッセージ送信処理をトリガーします。');
    sendScheduledWatchMessage();
}, {
    timezone: "Asia/Tokyo"
});

// --- LINE Webhook ハンドラ ---
app.post('/webhook', async (req, res) => {
    // LINEからのWebhookイベントを受け取ったら、まず200 OKを返す
    // これにより、replyTokenのタイムアウトを最大限回避し、LINE側でのエラー発生を抑制します。
    res.status(200).send('OK'); 

    const events = req.body.events;
    if (!events || events.length === 0) {
        console.log("No events received.");
        return; 
    }

    const usersCollection = db.collection("users");

    // 各イベントは非同期で処理を開始し、replyTokenは使用しない（必要に応じてpushMessageを使用）
    events.forEach(async event => {
        if (!event.source || !event.source.userId) {
            console.warn("Event has no userId, skipping:", event);
            return; 
        }
        const userId = event.source.userId;
        let userDoc;
        try {
            userDoc = await usersCollection.doc(userId).get();
        } catch (dbError) {
            console.error(`❌ Firestoreユーザーデータ取得エラー (${userId}):`, dbError.message);
            logErrorToDb(userId, `Firestoreユーザーデータ取得エラー`, { error: dbError.message, stack: dbError.stack });
            return; // DBエラー時は処理をスキップ
        }
        
        let user = userDoc.exists ? userDoc.data() : null;

        // --- ユーザー情報の初期登録または更新 ---
        if (!user) {
            const displayName = await getUserDisplayName(userId);
            user = {
                userId: userId,
                displayName: displayName,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                lastMessageAt: admin.firestore.FieldValue.serverTimestamp(),
                monthlyMessageCount: 0,
                lastResetDate: admin.firestore.FieldValue.serverTimestamp(),
                inappropriateWordCount: 0,
                lastInappropriateResetDate: admin.firestore.FieldValue.serverTimestamp(),
                isBlocked: false,
                wantsWatchCheck: false,
                emergencyContact: null,
                lastOkResponse: null,
                scheduledMessageSent: false,
                firstReminderSent: false,
                secondReminderSent: false,
                thirdReminderSent: false,
                registrationStep: null,
                tempRegistrationData: {},
                membershipType: "guest", // 新規ユーザーは"guest"で初期化
                completedRegistration: false,
                category: null,
                name: null,
                kana: null,
                age: null,
                phoneNumber: null,
                address: { city: null },
                guardianName: null,
                guardianPhoneNumber: null,
                consentObtained: false,
                studentIdPhotoUrl: null,
                studentIdVerified: false,
                isConsultationMode: false
            };
            try {
                await usersCollection.doc(userId).set(user);
                console.log(`✅ 新規ユーザー登録: ${userId} (${displayName}) as guest.`);
            } catch (dbError) {
                console.error(`❌ Firestore新規ユーザー登録エラー (${userId}):`, dbError.message);
                logErrorToDb(userId, `Firestore新規ユーザー登録エラー`, { error: dbError.message, stack: dbError.stack });
                return; // DBエラー時は処理をスキップ
            }
            
            // 初回登録時のメッセージを送信 (pushMessageを使用)
            if (event.type === 'follow') {
                try {
                    await client.pushMessage(userId, {
                        type: 'text',
                        text: 'はじめまして！わたしは皆守こころです🌸 あなたのお話、聞かせてね💖\n\n「見守りサービス」も提供しているから、興味があったら「見守り」って話しかけてみてね😊\n\nまずは会員登録から始めてみようかな？「会員登録」と話しかけてみてね！'
                    });
                    logToDb(userId, `（新規フォロー）`, `はじめましてメッセージ`, 'こころちゃん（新規フォロー）', 'system_follow', true);
                } catch (error) {
                    console.error("❌ フォローメッセージ送信エラー:", error.message);
                    logErrorToDb(userId, "フォローメッセージ送信エラー", { error: error.message, userId: userId });
                }
            }
            return; // 初期登録後の処理はここで終了
        } else {
            // 既存ユーザーのメッセージカウントをインクリメント（admin以外）
            if (!isBotAdmin(userId)) {
                try {
                    await usersCollection.doc(userId).update({
                        lastMessageAt: admin.firestore.FieldValue.serverTimestamp(),
                        monthlyMessageCount: admin.firestore.FieldValue.increment(1)
                    });
                    user.monthlyMessageCount = (user.monthlyMessageCount || 0) + 1; // userオブジェクトも更新
                } catch (dbError) {
                    console.error(`❌ Firestoreユーザーデータ更新エラー (${userId}):`, dbError.message);
                    logErrorToDb(userId, `Firestoreユーザーデータ更新エラー`, { error: dbError.message, stack: dbError.stack });
                    return; // DBエラー時は処理をスキップ
                }
            }
        }

        // --- サービスブロックユーザーのスキップ ---
        if (user.isBlocked) {
            console.log(`ユーザー ${userId} はブロックされているため、処理をスキップします。`);
            return;
        }

        // 管理者のmembershipTypeはコード内で一時的に上書きし、常にProモデルが使えるようにする
        const currentMembershipType = isBotAdmin(userId) ? "admin" : (user.membershipType || "guest");
        const userConfig = MEMBERSHIP_CONFIG[currentMembershipType] || MEMBERSHIP_CONFIG["guest"];


        // --- イベントタイプごとの処理 ---
        if (event.type === 'unfollow') {
            try {
                await usersCollection.doc(userId).update({ isBlocked: true });
                console.log(`ユーザー ${userId} がブロックしました。`);
            } catch (dbError) {
                console.error(`❌ Firestoreブロック状態更新エラー (${userId}):`, dbError.message);
                logErrorToDb(userId, `Firestoreブロック状態更新エラー`, { error: dbError.message, stack: dbError.stack });
            }
            return; // 処理終了
        }

        // --- メッセージイベント処理 (textメッセージ) ---
        if (event.type === 'message' && event.message.type === 'text') {
            const userMessage = event.message.text;
            const lowerUserMessage = userMessage.toLowerCase();
            let responseSent = false; // 応答を送信したかどうかを示すフラグ

            // ===============================================
            // 優先度の高いコマンド処理（pushMessage で応答し、処理済みなら 'return' する）
            // replyTokenは使わないため、全ての応答はpushMessageで送られます。
            // ===============================================

            // 1. 管理者コマンド (最優先)
            if (isBotAdmin(userId) && lowerUserMessage.startsWith('admin:')) {
                let adminReplyText = '';
                let logType = 'admin_command';

                const command = lowerUserMessage.substring(6).trim();
                if (command === 'status') {
                    adminReplyText = `こころちゃんは元気だよ！LINEイベントを受信中。\n現在のあなたの会員タイプ: ${currentMembershipType}`;
                    logType = 'admin_status';
                } else if (command === 'reset_my_count') {
                    await usersCollection.doc(userId).update({ monthlyMessageCount: 0 });
                    adminReplyText = 'あなたのメッセージカウントをリセットしたよ！';
                    logType = 'admin_reset_self_count';
                } else if (command.startsWith('set_membership ')) {
                    const parts = command.split(' ');
                    if (parts.length === 3) {
                        const targetUserId = parts[1];
                        const newMembership = parts[2];
                        if (MEMBERSHIP_CONFIG[newMembership]) {
                            await usersCollection.doc(targetUserId).update({ membershipType: newMembership });
                            adminReplyText = `ユーザー ${targetUserId} の会員区分を ${newMembership} に設定したよ！`;
                            logType = 'admin_set_membership';
                        } else {
                            adminReplyText = `無効な会員区分だよ: ${newMembership}`;
                            logType = 'admin_command_invalid_membership';
                        }
                    } else {
                        adminReplyText = '使用法: admin:set_membership [ユーザーID] [membershipType]';
                    }
                } else if (command === '!メニュー' || command === 'メニュー') {
                    await client.pushMessage(userId, { type: 'flex', altText: 'こころちゃんのメニュー', contents: {
                        "type": "bubble",
                        "body": {
                            "type": "box",
                            "layout": "vertical",
                            "contents": [
                                { "type": "text", "text": "メニュー", "weight": "bold", "color": "#FF69B4", "size": "lg" },
                                { "type": "button", "action": { "type": "message", "label": "見守りサービスについて", "text": "見守り" }, "style": "primary", "height": "sm", "margin": "md", "color": "#FFC0CB" },
                                { "type": "button", "action": { "type": "message", "label": "相談する", "text": "相談したい" }, "style": "primary", "height": "sm", "margin": "md", "color": "#FFC0CB" },
                                { "type": "button", "action": { "type": "message", "label": "こころちゃんとは？", "text": "こころちゃんとは？" }, "style": "primary", "height": "sm", "margin": "md", "color": "#FFC0CB" },
                                { "type": "button", "action": { "type": "postback", "label": "会員登録", "data": "action=show_registration_buttons" }, "style": "primary", "height": "sm", "margin": "md", "color": "#FFC0CB" }
                            ]
                        }
                    }});
                    logToDb(userId, userMessage, 'メニューFlexを送信しました', 'こころちゃん（管理者コマンド）', 'system_menu', true);
                    return; // 処理完了
                } else if (command === '!history') {
                    try {
                        const querySnapshot = await db.collection('logs').where('userId', '==', userId)
                            .orderBy('timestamp', 'desc')
                            .limit(10)
                            .get();
                        const historyMessages = querySnapshot.docs.map(doc => doc.data());
                        let historyText = "あなたの最新の会話履歴だよ🌸\n\n";
                        historyMessages.reverse().forEach(msg => {
                            const timestamp = msg.timestamp ? msg.timestamp.toDate() : new Date();
                            historyText += `【${msg.responsedBy === 'ユーザー' ? 'あなた' : msg.responsedBy}】${msg.message || msg.replyText} (${timestamp.toLocaleString()})\n`;
                        });
                        adminReplyText = historyText;
                        logType = 'admin_history';
                        await client.pushMessage(userId, { type: 'text', text: adminReplyText });
                        logToDb(userId, userMessage, adminReplyText, 'こころちゃん（管理者コマンド）', logType, true);
                        return; 
                    } catch (error) {
                        console.error("❌ 履歴取得エラー:", error.message);
                        logErrorToDb(userId, "履歴取得エラー", { error: error.message, userId: userId });
                        adminReplyText = '履歴取得中にエラーが発生しました。';
                        logType = 'admin_error';
                    }
                } else if (command === '!myid') {
                    adminReplyText = `あなたのLINEユーザーIDはこれだよ🌸\n\n${userId}`;
                    logType = 'admin_show_id';
                } else {
                    adminReplyText = '不明な管理者コマンドです。';
                    logType = 'admin_command_unknown';
                }
                
                await client.pushMessage(userId, { type: 'text', text: adminReplyText });
                logToDb(userId, userMessage, adminReplyText, 'こころちゃん（管理者コマンド）', logType, true);
                return; // 処理完了
            }

            // 2. 会員登録フローの継続 (登録途中のユーザー向け)
            // handleRegistrationFlow も pushMessage を使用するように修正が必要です。
            // 現状では replyMessage を使うため、この部分のハンドリングを優先します。
            if (user.registrationStep) {
                const handledByRegistrationFlow = await handleRegistrationFlow(event, userId, user, userMessage, lowerUserMessage, usersCollection);
                if (handledByRegistrationFlow) {
                    logToDb(userId, userMessage, '（会員登録フローで処理されました）', 'こころちゃん（登録フロー）', 'registration_flow', true);
                    return; 
                }
            }

            // 3. 見守りサービス関連コマンド（「見守り」「解除」「元気だよ！」など）
            // handleWatchServiceRegistration も pushMessage を使用するように修正が必要です。
            // 現状では replyMessage を使うため、この部分のハンドリングを優先します。
            const handledByWatchService = await handleWatchServiceRegistration(event, userId, userMessage, user, usersCollection);
            if (handledByWatchService) {
                return; 
            }

            // 4. 会員登録のFlex Message表示 (「会員登録」コマンド)
            if (['会員登録', '登録', 'かいいん', 'とうろく'].includes(lowerUserMessage)) {
                if (!user.completedRegistration) {
                    await client.pushMessage(userId, { // pushMessage に変更
                        type: 'flex',
                        altText: 'どの会員になるか選んでね🌸',
                        contents: REGISTRATION_BUTTONS_FLEX
                    });
                    logToDb(userId, userMessage, '会員登録ボタンFlexを案内しました。', 'こころちゃん（会員登録案内）', 'registration_buttons_display', true);
                    return; 
                } else {
                    await client.pushMessage(userId, { // pushMessage に変更
                        type: 'text',
                        text: 'まつさん、もう会員登録は完了しているみたいだよ🌸 いつもありがとう💖'
                    });
                    logToDb(userId, userMessage, '（会員登録済み）', 'こころちゃん（会員登録案内）', 'registration_already_completed', true);
                    return; 
                }
            }
            
            // 5. 固定応答（SpecialRepliesMap）
            const specialReply = checkSpecialReply(userMessage);
            if (specialReply) {
                await client.pushMessage(userId, { type: 'text', text: specialReply }); // pushMessage に変更
                logToDb(userId, userMessage, specialReply, 'こころちゃん（固定応答）', 'special_reply', true);
                return; 
            }

            // 6. 不適切ワードのチェック
            const isInappropriate = checkContainsInappropriateWords(userMessage);
            if (isInappropriate) {
                usersCollection.doc(userId).update({ // awaitは付けず非同期で実行
                    inappropriateWordCount: admin.firestore.FieldValue.increment(1)
                });
                user.inappropriateWordCount = (user.inappropriateWordCount || 0) + 1;

                const replyText = "わたしを作った人に『プライベートなことや不適切な話題には答えちゃだめだよ』って言われているんだ🌸ごめんね、他のお話をしようね💖";
                await client.pushMessage(userId, { type: 'text', text: replyText }); // pushMessage に変更
                logToDb(userId, userMessage, replyText, 'こころちゃん（不適切ワード）', 'inappropriate_word', true);

                if (user.inappropriateWordCount >= 2 && OWNER_USER_ID) { 
                    const ownerNotification = `【⚠不適切ワード通知⚠】\nユーザー（LINE表示名: ${user.displayName}）が本日2回以上不適切ワードを送信しました。\nユーザーID: ${userId}\n最新のメッセージ: 「${userMessage}」`;
                    client.pushMessage(OWNER_USER_ID, { type: 'text', text: ownerNotification })
                        .then(() => console.log(`🚨 OWNER_USER_ID (${OWNER_USER_ID}) に不適切ワード通知を送信しました。`))
                        .catch(notifyError => {
                            console.error(`❌ OWNER_USER_IDへの不適切ワード通知送信エラー:`, notifyError.message);
                            logErrorToDb(OWNER_USER_ID, "不適切ワード通知送信エラー", { error: notifyError.message, userId: userId, originalMessage: userMessage });
                        });
                }
                return; 
            }

            // 7. 危険ワード、詐欺ワードのチェック
            const isDanger = checkContainsDangerWords(userMessage);
            const isScam = checkContainsScamWords(userMessage);

            if (isDanger || isScam) {
                const userName = user.displayName || `不明ユーザー`;
                const notificationMessage = `【⚠緊急通知⚠】\nユーザー（LINE表示名: ${userName}）が${isDanger ? '危険' : '詐欺'}ワードを送信しました。\nメッセージ内容: 「${userMessage}」\nユーザーID: ${userId}`;

                if (OFFICER_GROUP_ID) {
                    client.pushMessage(OFFICER_GROUP_ID, { type: 'text', text: notificationMessage })
                        .then(() => console.log(`🚨 事務局へ通知を送信しました: ${notificationMessage}`))
                        .catch(error => {
                            console.error(`❌ 事務局への通知送信エラー:`, error.message);
                            logErrorToDb(userId, "事務局通知送信エラー", { error: error.message, userId: userId, originalMessage: userMessage });
                        });
                } else {
                    console.warn(`OFFICER_GROUP_IDが設定されていないため、危険ワード通知は送信されませんでした。`);
                }

                if (isDanger) {
                    await client.pushMessage(userId, [{ type: 'text', text: 'ごめんね、それはわたしにはお話しできない内容です🌸 緊急の時は、専門の人に相談してね💖' }, { type: 'flex', altText: "緊急連絡先一覧", contents: EMERGENCY_FLEX_MESSAGE }]); // pushMessage に変更
                    generateGPTReply(userMessage, "gpt-4o", userId, user).then(response => {
                         client.pushMessage(userId, { type: 'text', text: response }).catch(e => console.error("GPT応答プッシュ失敗", e));
                    }).catch(e => {
                        console.error("危険ワードGPT応答生成エラー", e);
                        logErrorToDb(userId, "危険ワードGPT応答生成エラー", { error: e.message, userId: userId, originalMessage: userMessage });
                    });
                    logToDb(userId, userMessage, `（緊急連絡先Flex表示 + GPT-4o応答）`, 'こころちゃん（危険検知）', 'danger_word_detected', true);
                } else if (isScam) {
                    await client.pushMessage(userId, [{ type: 'text', text: '怪しい話には注意してね！不安な時は、信頼できる人に相談するか、こちらの情報も参考にしてみてね💖' }, { type: 'flex', altText: "詐欺の可能性があります", contents: SCAM_FLEX_MESSAGE }]); // pushMessage に変更
                    generateGPTReply(userMessage, "gpt-4o", userId, user).then(response => {
                         client.pushMessage(userId, { type: 'text', text: response }).catch(e => console.error("GPT応答プッシュ失敗", e));
                    }).catch(e => {
                        console.error("詐欺ワードGPT応答生成エラー", e);
                        logErrorToDb(userId, "詐欺ワードGPT応答生成エラー", { error: e.message, userId: userId, originalMessage: userMessage });
                    });
                    logToDb(userId, userMessage, `（詐欺注意Flex表示 + GPT-4o応答）`, 'こころちゃん（詐欺検知）', 'scam_word_detected', true);
                }
                return; 
            }
            
            // 8. 宿題・勉強に関する質問のチェック（子供向けAI設定の場合のみ）
            if (containsHomeworkTrigger(userMessage) && userConfig.isChildAI) {
                const replyText = "わたしを作った人に『宿題や勉強は自分の力でがんばってほしいから、答えは言っちゃだめだよ』って言われているんだ🌸 ごめんね💦でも、ヒントくらいなら出せるよ😊 どこで困ってるか教えてくれる？💖";
                await client.pushMessage(userId, { type: 'text', text: replyText }); // pushMessage に変更
                logToDb(userId, userMessage, replyText, 'こころちゃん（宿題拒否）', 'homework_question', true);
                return; 
            }

            // 9. 「相談」モードの開始（`isConsultationMode`がfalseの場合のみ）
            if (['そうだん', '相談'].includes(lowerUserMessage) && !user.isConsultationMode) {
                await client.pushMessage(userId, { type: 'text', text: 'うん、お話聞かせてね🌸 一度だけ、Gemini 1.5 Proでじっくり話そうね。何があったの？💖' }); // pushMessage に変更
                usersCollection.doc(userId).update({ isConsultationMode: true }); 
                logToDb(userId, userMessage, '（相談モード開始）', 'こころちゃん（モード切替）', 'consultation_mode_start', true);
                return; 
            }

            // 10. 月間メッセージ回数制限のチェック (管理者以外)
            if (userConfig.monthlyLimit !== -1 && user.monthlyMessageCount >= userConfig.monthlyLimit) {
                if (user.membershipType === "subscriber" && userConfig.fallbackModel) {
                    const fallbackMembershipType = (user.category === '成人' && user.completedRegistration) ? "donor" : "free";
                    await client.pushMessage(userId, { type: 'text', text: userConfig.exceedLimitMessage }); // pushMessage に変更
                    
                    const aiModelForFallback = MEMBERSHIP_CONFIG[fallbackMembershipType].model;
                    generateGeminiReply(userMessage, aiModelForFallback, userId, user).then(aiReply => {
                        client.pushMessage(userId, { type: 'text', text: aiReply }).catch(e => console.error("回数超過後Flash応答プッシュ失敗", e));
                    }).catch(e => {
                        console.error("回数超過後Flash応答生成エラー", e);
                        logErrorToDb(userId, "回数超過後Flash応答生成エラー", { error: e.message, userId: userId, originalMessage: userMessage });
                    });
                    logToDb(userId, userMessage, userConfig.exceedLimitMessage, `こころちゃん（${aiModelForFallback} - 回数超過）`, 'quota_exceeded_fallback', true);
                    return; 
                } else {
                    await client.pushMessage(userId, { type: 'text', text: userConfig.exceedLimitMessage }); // pushMessage に変更
                    logToDb(userId, userMessage, userConfig.exceedLimitMessage, 'こころちゃん（回数超過）', 'quota_exceeded', true);
                    return; 
                }
            }

            // 11. 相談モード中の応答（1回限り）
            if (user.isConsultationMode) {
                // AI応答を生成し、プッシュメッセージで返信する
                generateGeminiReply(userMessage, "gemini-1.5-pro-latest", userId, user).then(aiReply => {
                    client.pushMessage(userId, { type: 'text', text: aiReply }).catch(e => console.error("相談モードAI応答プッシュ失敗", e));
                    usersCollection.doc(userId).update({ isConsultationMode: false }); 
                    logToDb(userId, userMessage, aiReply, 'こころちゃん（相談モード）', 'consultation_message', true);
                }).catch(e => {
                    console.error("相談モードAI応答生成エラー", e);
                    logErrorToDb(userId, "相談モードAI応答生成エラー", { error: e.message, userId: userId, originalMessage: userMessage });
                });
                return; 
            }
            
            // 12. NPO法人コネクトに関する質問を優先
            const orgReply = "うん、NPO法人コネクトのこと、もっと知りたいんだね🌸　コネクトは、子どもたちや高齢者の方々、そしてみんなが安心して相談できる場所を目指している団体なんだよ😊　困っている人が安心して相談できたり、助け合えるような社会を社会をつくりたいって願って、活動しているんだ。\nもっと知りたい？ホームページもあるから見てみてね → https://connect-npo.org";
            if (isOrganizationInquiry(userMessage)) {
                await client.pushMessage(userId, { type: 'text', text: orgReply }); // pushMessage に変更
                logToDb(userId, userMessage, orgReply, 'こころちゃん（団体説明）', 'organization_inquiry', true);
                return; 
            }

            // 13. 共感が必要なメッセージ (GPT)
            if (containsEmpatheticTrigger(userMessage)) {
                generateGPTReply(userMessage, "gpt-4o-mini", userId, user).then(aiReply => { 
                    client.pushMessage(userId, { type: 'text', text: aiReply }).catch(e => console.error("共感AI応答プッシュ失敗", e));
                    logToDb(userId, userMessage, aiReply, 'こころちゃん（共感）', 'empathetic_message', true);
                }).catch(e => {
                    console.error("共感AI応答生成エラー", e);
                    logErrorToDb(userId, "共感AI応答生成エラー", { error: e.message, userId: userId, originalMessage: userMessage });
                });
                return; 
            }

            // 14. 通常のAI応答（会員区分に基づくモデル） - 最終的なフォールバック
            generateGeminiReply(userMessage, userConfig.model, userId, user).then(aiReply => {
                client.pushMessage(userId, { type: 'text', text: aiReply }).catch(e => console.error("通常AI応答プッシュ失敗", e));
            }).catch(e => {
                console.error("通常AI応答生成エラー", e);
                logErrorToDb(userId, "通常AI応答生成エラー", { error: e.message, userId: userId, originalMessage: userMessage });
            });
            return; // 処理完了
            
        } else if (event.type === 'postback') { 
            // postbackイベントは replyToken が使えるため、replyMessage を使用
            const { replyToken, postback } = event;
            const data = new URLSearchParams(postback.data);
            const action = data.get('action');

            // 会員登録のリッチメニューからのpostbackアクション
            if (action === 'show_registration_buttons') {
                await client.replyMessage(replyToken, {
                    type: 'flex',
                    altText: 'どの会員になるか選んでね🌸',
                    contents: REGISTRATION_BUTTONS_FLEX
                });
                logToDb(userId, `（会員登録ボタン表示要求）`, '（会員登録ボタンFlex表示）', 'こころちゃん（メニュー）', 'registration_button_display', true);
                return; 
            }

            // 見守りサービス登録・解除のpostbackアクション
            const handledByWatchServicePostback = await handleWatchServiceRegistration(event, userId, "", user, usersCollection);
            if (handledByWatchServicePostback) {
                return; 
            }
        }
    }); // events.forEach(async event => { ... }); の閉じ括弧

    // Webhookの応答はここで一度だけ行われるため、Invalid reply tokenエラーは大幅に減少するはず
    // res.status(200).send('OK'); は async (req, res) => の直下に移されたため、ここでは不要
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`🚀 サーバーがポート ${PORT} で起動しました...`);
    console.log("✅ FirestoreはFirebase Admin SDKによって初期化済みです。");
});
