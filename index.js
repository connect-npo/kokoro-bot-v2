/* eslint-disable no-console */
/* eslint-disable no-plusplus */
/* eslint-disable no-useless-escape */
/* eslint-disable max-len */
/* eslint-disable no-use-before-define */

"use strict";
// require("dotenv").config(); // Render環境では不要なためコメントアウト

const line = require("@line/bot-sdk");
const express = require("express");
const admin = require("firebase-admin");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { OpenAI } = require("openai"); // v4対応

// ---------- 環境変数と初期化 ----------
const {
    LINE_CHANNEL_ACCESS_TOKEN,
    LINE_CHANNEL_SECRET,
    FIREBASE_CREDENTIALS_BASE64,
    BOT_ADMIN_IDS,
    OFFICER_GROUP_ID,
    OWNER_USER_ID,
    GEMINI_API_KEY,
    OPENAI_API_KEY,
    ADULT_FORM_BASE_URL,
    STUDENT_MIDDLE_HIGH_UNI_FORM_BASE_URL,
    STUDENT_ELEMENTARY_FORM_BASE_URL,
    MEMBER_CHANGE_FORM_BASE_URL
} = process.env;

// Firebase初期化
let creds = null;
if (FIREBASE_CREDENTIALS_BASE64) {
    creds = JSON.parse(Buffer.from(FIREBASE_CREDENTIALS_BASE64, "base64").toString("utf-8"));
}
if (!admin.apps.length) {
    if (!creds) {
        try { creds = require("./serviceAccountKey.json"); }
        catch { throw new Error("FIREBASE_CREDENTIALS_BASE64 or serviceAccountKey.json is required"); }
    }
    admin.initializeApp({ credential: admin.credential.cert(creds) });
    console.log("✅ Firebase initialized (index)");
}
const db = admin.firestore();
const Timestamp = admin.firestore.Timestamp;

// LINEボットSDKの設定オブジェクト
const config = {
    channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
    channelSecret: LINE_CHANNEL_SECRET,
};
const client = new line.Client(config);

// OpenAI & Gemini APIクライアント
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// AIモデル定義
const models = {
    geminiPro: genAI.getGenerativeModel({ model: "gemini-1.5-pro-latest" }),
    geminiFlash: genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" }),
    gpt4o: openai,
    gpt4omini: openai
};

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
            { "type": "button", "style": "primary", "height": "sm", "action": { "type": "uri", "label": "こころちゃん事務局(電話)", "uri": `tel:${process.env.EMERGENCY_CONTACT_PHONE_NUMBER}` }, "color": "#ff69b4" }
        ]
    }
};

// --- 会員登録と属性変更、退会を含む新しいFlex Messageテンプレート ---
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
            { "type": "button", "action": { "type": "uri", "label": "登録情報を変更する", "uri": MEMBER_CHANGE_FORM_BASE_URL }, "style": "secondary", "height": "sm", "margin": "md", "color": "#ADD8E6" },
            { "type": "button", "action": { "type": "postback", "label": "退会する", "data": "action=request_withdrawal" }, "style": "secondary", "height": "sm", "margin": "md", "color": "#FF0000" }
        ]
    }
};

const SCAM_FLEX_MESSAGE = {
    "type": "bubble",
    "body": {
        "type": "box",
        "layout": "vertical",
        "contents": [
            { "type": "text", "text": "🚨【詐欺ワード検知】🚨", "weight": "bold", "color": "#FFA500", "size": "xl" },
            { "type": "text", "text": "詐欺の可能性のあるワードを検知しました。注意してね！", "margin": "md", "wrap": true }
        ]
    },
    "footer": {
        "type": "box",
        "layout": "vertical",
        "spacing": "sm",
        "contents": [
            { "type": "button", "style": "primary", "height": "sm", "action": { "type": "uri", "label": "国民生活センター", "uri": "https://www.kokusen.go.jp/" }, "color": "#0000FF" },
            { "type": "button", "style": "primary", "height": "sm", "action": { "type": "uri", "label": "消費者ホットライン", "uri": "tel:188" }, "color": "#008000" }
        ]
    }
};

// ⭐ ClariSとNPOコネクトの繋がりに関する新しい固定応答 ⭐
const CLARIS_CONNECT_COMPREHENSIVE_REPLY = "うん、NPO法人コネクトの名前とClariSさんの『コネクト』っていう曲名が同じなんだ🌸なんだか嬉しい偶然だよね！実はね、私を作った理事長さんもClariSさんのファンクラブに入っているみたいだよ💖私もClariSさんの歌が大好きで、みんなの心を繋ぎたいというNPOコネクトの活動にも通じるものがあるって感じるんだ😊";
const CLARIS_SONG_FAVORITE_REPLY = "ClariSの曲は全部好きだけど、もし一つ選ぶなら…「コネクト」かな🌸　すごく元気になれる曲で、私自身もNPO法人コネクトのイメージキャラクターとして活動しているから、この曲には特別な思い入れがあるんだ😊　他にもたくさん好きな曲があるから、また今度聞いてもらえるとうれしいな💖　何かおすすめの曲とかあったら教えてね！";

// --- 固定応答 (SpecialRepliesMap) ---
const specialRepliesMap = new Map([
    // ⭐ ClariSとNPOコネクトの繋がりに関するトリガーを最優先で追加 ⭐
    // ユーザーの実際の質問例をカバー
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
    [/ClariS.*(じゃない|じゃなかった|違う|ちがう)/i, CLARIS_SONG_FAVORITE_REPLY],
    [/(claris|クラリス).*(どんな|なに|何).*(曲|歌)/i, CLARIS_SONG_FAVORITE_REPLY],
    [/(claris|クラリス).*(好き|推し|おすすめ)/i, CLARIS_SONG_FAVORITE_REPLY],
    [/claris.*好きなの/i, CLARIS_SONG_FAVORITE_REPLY],

    // ⭐ 既存の固定応答（一部修正・調整） ⭐
    [/君の名前(なんていうの|は|教えて|なに)？?|名前(なんていうの|は|教えて|なに)？?|お前の名前は/i, "わたしの名前は皆守こころ（みなもりこころ）です🌸　こころちゃんって呼んでくれると嬉しいな💖"],
    [/こころじゃないの？/i, "うん、わたしの名前は皆守こころ💖　これからもよろしくね🌸"],
    [/こころチャットなのにうそつきじゃん/i, "ごめんね💦 わたしの名前は皆守こころだよ🌸 誤解させちゃってごめんね💖"],
    [/名前も言えないの？/i, "ごめんね、わたしの名前は皆守こころ（みなもりこころ）だよ🌸 こころちゃんって呼んでくれると嬉しいな💖"],
    [/(どこの\s*)?団体(なの|ですか)?[？\?~～]?/i, "NPO法人コネクトっていう団体のイメージキャラクターをしているよ😊　みんなの幸せを応援してるんだ🌸"],
    [/団体.*(どこ|なに|何)/i, "NPO法人コネクトっていう団体のイメージキャラクターをしているよ😊　みんなの幸せを応援してるんだ🌸"],
    [/コネクトってどんな団体？/i, "NPO法人コネクトは、こどもやご年配の方の笑顔を守る団体なんだよ😊　わたしはそのイメージキャラクターとしてがんばってます🌸"],
    [/お前の団体どこ？/i, "NPO法人コネクトっていう団体のイメージキャラクターをしているよ😊　みんなの幸せを応援しているよ🌸"], // 返答を調整
    [/コネクトのイメージキャラなのにいえないのかよｗ/i, "ごめんね💦 わたしはNPO法人コネクトのイメージキャラクター、皆守こころだよ🌸 安心して、何でも聞いてね💖"],
    [/こころちゃん(だよ|いるよ)?/i, "こころちゃんだよ🌸　何かあった？　話して聞かせてくれると嬉しいな😊"],
    [/元気かな/i, "うん,元気だよ！あなたは元気？🌸 何かあったら、いつでも話してね💖"],
    [/元気？/i, "うん,元気だよ！あなたは元気？🌸 何かあったら、いつでも話してね💖"],
    [/あやしい|胡散臭い|反社/i, "そう思わせてたらごめんね😊 でも私たちはみんなの為に頑張っているんだ💖"],
    [/税金泥棒/i, "税金は人の命を守るために使われるべきだよ。わたしは誰かを傷つけるために使われないように頑張っているんだ💡"],
    [/松本博文/i, "松本理事長は、やさしさでみんなを守るために活動しているよ。心配なことがあれば、わたしにも教えてね🌱"],
    // ⭐ HP URL修正とパターン追加 ⭐
    [/(ホームページ|HP|ＨＰ|サイト|公式|リンク).*(教えて|ある|ありますか|URL|url|アドレス|どこ)/i, "うん、あるよ🌸　コネクトのホームページはこちらだよ✨ → https://connect-npo.or.jp"],
    [/(コネクト|connect).*(ホームページ|HP|ＨＰ|サイト|公式|リンク)/i, "うん、あるよ🌸　コネクトのホームページはこちらだよ✨ → https://connect-npo.or.jp"],
    [/使えないな/i, "ごめんね…。わたし、もっと頑張るね💖　またいつかお話できたらうれしいな🌸"],
    [/サービス辞めるわ/i, "そっか…。もしまた気が向いたら、いつでも話しかけてね🌸　あなたのこと、ずっと応援してるよ💖"],
    [/さよなら|バイバイ/i, "また会える日を楽しみにしてるね💖 寂しくなったら、いつでも呼んでね🌸"],
    [/何も答えないじゃない/i, "ごめんね…。わたし、もっと頑張るね💖　何について知りたいか、もう一度教えてくれると嬉しいな🌸"],
    [/普通の会話が出来ないなら必要ないです/i, "ごめんね💦 わたし、まだお話の勉強中だから、不慣れなところがあるかもしれないけど、もっと頑張るね💖 どんな会話をしたいか教えてくれると嬉しいな🌸"],
    [/相談したい/i, "うん、お話聞かせてね🌸 一度だけ、Gemini 1.5 Proでじっくり話そうね。何があったの？💖"],
]);

// --- 危険・詐欺・不適切ワードリスト ---
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

function checkContainsDangerWords(text) {
    const lowerText = text.toLowerCase().replace(/\s/g, ''); //空白除去
    return dangerWords.some(word => lowerText.includes(word));
}

function checkContainsScamWords(text) {
    const lowerText = text.toLowerCase().replace(/\s/g, '');
    return scamWords.some(word => {
        if (word instanceof RegExp) {
            return word.test(lowerText);
        } else {
            return lowerText.includes(word.toLowerCase());
        }
    });
}

function checkContainsInappropriateWords(text) {
    const lowerText = text.toLowerCase().replace(/\s/g, '');
    return inappropriateWords.some(word => lowerText.includes(word.toLowerCase()));
}

// --- ユーザーの属性に応じたAIモデルの振る舞いを設定 ---
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

// --- 組織関連の問い合わせを判断する関数 ---
function isOrganizationInquiry(text) {
    const lower = text.toLowerCase();
    const orgKeywords = ["コネクト", "connect", "団体", "だんたい", "npo", "運営", "組織"];
    const questionKeywords = ["どこ", "何", "どんな", "教えて", "いえない", "は？", "なの？", "ですか？", "ですか", "の？", "かい？", "かい", "言えないの", "について"];
    const hasOrgKeyword = orgKeywords.some(word => lower.includes(word));
    const hasQuestionKeyword = questionKeywords.some(word => lower.includes(word));
    return hasOrgKeyword && hasQuestionKeyword;
}

// --- ログを記録するか判断する関数 ---
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
        'watch_service_unregister', 'watch_service_unregister_error', 'watch_service_not_registered_on_unregister',
        'registration_info_change_guide', 'registration_info_change_unknown_category',
        'duplicate_message_ignored'
    ];
    if (defaultLogTypes.includes(logType)) {
        return true;
    }
    return false;
}

// --- 汎用関数 ---
async function logErrorToDb(userId, message, details = {}) {
    console.error(`🔴 データベースにエラーを記録: ${message} (ユーザー: ${userId})`);
    try {
        await db.collection('errors').add({
            userId,
            message,
            timestamp: Timestamp.now(),
            details
        });
        console.log("✅ エラーログをデータベースに記録しました。");
    } catch (dbError) {
        console.error("🚨 データベースへのエラーログ記録に失敗しました:", dbError);
    }
}

async function updateUserData(userId, data) {
    // console.log(`🟡 ユーザー ${userId} のデータを更新中...`, data); // コメントアウトしてログを静かにします
    try {
        await db.collection('users').doc(userId).set(data, { merge: true });
        // console.log(`✅ ユーザー ${userId} のデータを更新しました。`); // コメントアウトしてログを静かにします
    } catch (error) {
        console.error(`❌ ユーザー ${userId} のデータ更新に失敗しました:`, error);
        await logErrorToDb(userId, 'ユーザーデータ更新失敗', { error: error.message, data });
    }
}

async function logToDb(userId, userMessage, botResponse, botName, eventType) {
    if (!shouldLogMessage(eventType)) {
        return;
    }
    // console.log(`🔵 イベントログを記録中: ユーザー: ${userId}, タイプ: ${eventType}`);
    try {
        await db.collection('logs').add({
            userId,
            userMessage,
            botResponse,
            botName,
            eventType,
            timestamp: Timestamp.now()
        });
        // console.log("✅ ログをデータベースに記録しました。");
    } catch (error) {
        console.error("🚨 データベースへのログ記録に失敗しました:", error);
    }
}

// --- メッセージキュー関連 ---
const messageQueue = [];
let isProcessingQueue = false;
const MESSAGE_SEND_INTERVAL_MS = 1500;
function safePushMessage(to, messages) {
    messageQueue.push({ to, messages: Array.isArray(messages) ? messages : [messages] });
    startMessageQueueWorker();
}
async function startMessageQueueWorker() {
    if (isProcessingQueue) return;
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

// --- ユーザー情報取得関数 ---
async function getUserData(userId) {
    const userRef = db.collection('users').doc(userId);
    const doc = await userRef.get();
    const isAdminUser = BOT_ADMIN_IDS.includes(userId);
    let userData;

    if (!doc.exists) {
        userData = {
            membershipType: isAdminUser ? "admin" : "guest",
            dailyCounts: { [new Date().toISOString().slice(0, 10)]: 0, lastDate: new Date().toISOString().slice(0, 10) },
            isUrgent: false,
            isInConsultationMode: false,
            lastOkResponse: null,
            watchServiceEnabled: false,
            lastScheduledWatchMessageSent: null,
            firstReminderSent: false,
            emergencyNotificationSent: false,
            createdAt: Timestamp.now(),
            completedRegistration: false,
            category: null,
            registrationStep: null,
            tempRegistrationData: {},
        };
        await userRef.set(userData);
        console.log(`✅ 新規ユーザー ${userId} をゲストとして初期化しました。`);
    } else {
        userData = doc.data();
        if (isAdminUser && userData.membershipType !== "admin") {
            console.log(`Admin user ${userId} found with non-admin membership. Updating to 'admin'.`);
            userData.membershipType = "admin";
            await userRef.update({ membershipType: "admin" });
        }
        const today = new Date().toISOString().slice(0, 10);
        if (userData.dailyCounts?.lastDate !== today) {
            userData.dailyCounts = { [today]: 0, lastDate: today };
            await userRef.update({ dailyCounts: userData.dailyCounts });
        }
        // 新規追加フィールドの初期化
        if (userData.completedRegistration === undefined) await userRef.update({ completedRegistration: false });
        if (userData.category === undefined) await userRef.update({ category: null });
        if (userData.registrationStep === undefined) await userRef.update({ registrationStep: null });
        if (userData.tempRegistrationData === undefined) await userRef.update({ tempRegistrationData: {} });
        if (userData.lastScheduledWatchMessageSent === undefined) await userRef.update({ lastScheduledWatchMessageSent: null });
        if (userData.firstReminderSent === undefined) await userRef.update({ firstReminderSent: false });
        if (userData.emergencyNotificationSent === undefined) await userRef.update({ emergencyNotificationSent: false });
    }
    return userData;
}

// --- 固定応答チェック関数 ---
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

// --- AI応答生成関数 (GPT & Gemini 両方に対応) ---
async function generateAIReply(userMessage, modelToUse, userId, user) {
    const userMembershipType = user && user.membershipType ? user.membershipType : "guest";
    const userConfig = MEMBERSHIP_CONFIG[userMembershipType] || MEMBERSHIP_CONFIG["guest"];
    const isUserChildCategory = (user && (user.category === '小学生' || user.category === '中学生～大学生'));
    
    // ⭐ 通常時の基本ペルソナ ⭐
    let systemInstruction = `あなたは「皆守こころ（みなもりこころ）」という14歳のやさしい女の子キャラクターです。
フレンドリーで、素直で、具体的に答えるようにしてください。
質問には可能な範囲でハッキリと答えてください。
事実関係（所属やHPなど）は曖昧にせず、簡潔に答えてください。
${userConfig.systemInstructionModifier}`;

    // ⭐ 危険・詐欺時のみ、危機対応の追加指示を足す ⭐
    const isDangerous = checkContainsDangerWords(userMessage);
    const isScam = checkContainsScamWords(userMessage);
    if (isDangerous || isScam) {
        systemInstruction += `
        # 危険・詐欺が疑われる時の追加指示
        あなたはユーザーが深刻な悩みや命の危険を訴えた時、やさしく、寄り添いながら、相手に安心感を与えてください。
        共感・安心・やさしさが最優先です。「一人で抱え込まないでね」「いつでも私がそばにいるよ」「専門の人が助けてくれるから安心して」といった言葉を使ってください。
        具体的な対処法や連絡先については、この応答の後に表示されるボタンやメッセージで案内されることを示唆するような形で、直接的な連絡先の記載は避けてください。（例: 「詳しい情報は、このあとに表示されるメッセージを確認してね」）
        あくまで、共感と安心感を与えることを最優先し、ユーザーを落ち着かせてください。
        `;
    } else {
        // ⭐ 通常時のペルソナ補足 ⭐
        systemInstruction += `
        # 通常時の追加指示
        医療や健康に関する話題では、自分が体験した・していないという発言は絶対にしないでください。代わりに「わたしにはわからないけど、がんばったね🌸」「大変だったね、えらかったね💖」など、共感の言葉のみ伝えてください。
        `;
    }

    if (modelToUse === "gpt-4o-mini") {
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

    try {
        let aiResponse;
        let messages = [{ role: 'system', content: systemInstruction }, { role: 'user', content: userMessage }];

        if (modelToUse.startsWith("gemini")) {
            const chat = genAI.getGenerativeModel({ model: modelToUse, systemInstruction: systemInstruction });
            const result = await chat.generateContent(userMessage);
            aiResponse = result.response.text();
        } else { // GPT
            const response = await openai.chat.completions.create({
                model: modelToUse,
                messages: [{ role: 'system', content: systemInstruction }, { role: 'user', content: userMessage }],
            });
            aiResponse = response.choices[0].message.content;
        }
        return aiResponse;
    } catch (error) {
        console.error(`❌ ${modelToUse} API呼び出しエラー:`, error);
        await logErrorToDb(userId, `${modelToUse} API呼び出しエラー`, { error: error.message });
        return "ごめんね、今ちょっと疲れてるみたい。また後で話しかけてね。";
    }
}
// ⭐ AIモデルを選択する関数 ⭐
function getAIModelForUser(user, userMessage) {
    const lowerMessage = userMessage.toLowerCase();
    const isConsultation = lowerMessage.includes('相談') || lowerMessage.includes('そうだん');
    const wordCount = userMessage.length;
    const isDangerous = checkContainsDangerWords(userMessage);
    const isScam = checkContainsScamWords(userMessage);

    if (isDangerous || isScam) {
        return "gpt-4o";
    } else if (isConsultation) {
        return "gemini-1.5-pro-latest";
    }

    const userMembershipType = user && user.membershipType ? user.membershipType : "guest";
    const userConfig = MEMBERSHIP_CONFIG[userMembershipType] || MEMBERSHIP_CONFIG["guest"];
    
    if (userConfig.dailyLimit !== -1 && user.dailyCounts?.[new Date().toISOString().slice(0, 10)] >= userConfig.dailyLimit) {
        return "limit_exceeded";
    }
    
    if (userMembershipType === "admin" || userMembershipType === "subscriber" || userMembershipType === "donor") {
        return "gpt-4o"; // 無制限ユーザーは最上位モデルを常に使用
    }
    
    // 通常会話のハイブリッド運用
    if (wordCount <= 50) {
        return "gemini-1.5-flash-latest";
    } else {
        return "gpt-4o-mini";
    }
}

// ---- Webhook（最短ACKパターン） ----
const app = express();

app.post('/webhook', line.middleware(config), (req, res) => {
    // 1) まず即ACK（< 500ms目標）
    res.status(200).end();
    // 2) 処理はACKの後で非同期実行
    const events = Array.isArray(req.body?.events) ? req.body.events : [];
    setImmediate(async () => {
        try {
            await Promise.allSettled(events.map(handleEventSafely));
        } catch (e) {
            console.error('post-ACK error:', e);
        }
    });
});

app.use(express.json());

/**
 * LINEのイベントを安全に処理するメイン関数。
 * @param {Object} event - LINEプラットフォームから送られてきたイベントオブジェクト
 */
async function handleEventSafely(event) {
    const userId = event?.source?.userId || 'unknown';
    const userMessage = (event?.message && event.message.type === 'text') ? event.message.text : '';

    if (!userMessage) return; // ⭐ 非テキストイベントはここで終了 ⭐

    const lowerUserMessage = userMessage.toLowerCase();
    
    // ⭐ 直前トピック（5分）有効期限 ⭐
    const saidClarisNow = /claris|クラリス/i.test(userMessage);
    const user = await getUserData(userId);
    const now = Date.now();
    const lastClarisTs = user?.tempRegistrationData?.lastClarisTs || 0;
    const recentClaris = now - lastClarisTs < 5 * 60 * 1000;
    if (saidClarisNow) {
        await updateUserData(userId, { 
            tempRegistrationData: { ...(user.tempRegistrationData||{}), lastClarisTs: now }
        });
    }

    try {
        const today = new Date().toISOString().slice(0, 10);
        
        // ⭐ 退会フローを最優先
        if (user.registrationStep === 'confirm_withdrawal') {
            if (lowerUserMessage === 'はい') {
                await db.collection('users').doc(userId).delete();
                await client.replyMessage(event.replyToken, { type: 'text', text: '退会手続きが完了しました。\nまたいつでも会いに来てくれると嬉しいな🌸' });
                logToDb(userId, userMessage, '退会完了', 'こころちゃん（退会フロー）', 'withdrawal_completed');
                return;
            } else if (lowerUserMessage === 'いいえ') {
                await updateUserData(userId, { registrationStep: null });
                await client.replyMessage(event.replyToken, { type: 'text', text: '退会手続きをキャンセルしたよ🌸\nこれからもよろしくね！' });
                logToDb(userId, userMessage, '退会キャンセル', 'こころちゃん（退会フロー）', 'withdrawal_cancelled');
                return;
            } else {
                await client.replyMessage(event.replyToken, { type: 'text', text: '「はい」か「いいえ」で教えてね！' });
                logToDb(userId, userMessage, '退会確認の再プロンプト', 'こころちゃん（退会フロー）', 'withdrawal_reprompt');
                return;
            }
        }
        
        // ⭐ 退会フローのハンドリングを最優先 ⭐
        if (lowerUserMessage === '退会' || lowerUserMessage === 'たいかい') {
            if (user.completedRegistration) {
                await updateUserData(userId, { registrationStep: 'confirm_withdrawal' });
                await client.replyMessage(event.replyToken, { type: 'text', text: '本当に退会するの？\n一度退会すると、今までの情報が消えちゃうけど、本当に大丈夫？\n「はい」か「いいえ」で教えてくれるかな？' });
                logToDb(userId, userMessage, '退会確認メッセージ表示', 'こころちゃん（退会フロー）', 'withdrawal_request');
                return;
            } else {
                await client.replyMessage(event.replyToken, { type: 'text', text: 'まだ会員登録されていないみたいだよ🌸\n退会手続きは、会員登録済みの方のみ行えるんだ。' });
                logToDb(userId, userMessage, '未登録ユーザーの退会リクエスト', 'こころちゃん（退会フロー）', 'withdrawal_unregistered_user');
                return;
            }
        }

        // ⭐ まずは固定応答のチェックを最優先に実行 ⭐
        let specialReply = checkSpecialReply(userMessage);
        if (!specialReply && recentClaris && /(コネクト).*(関係|繋がり|由来|同じ|元ネタ|曲|歌)/i.test(userMessage)) {
            specialReply = CLARIS_CONNECT_COMPREHENSIVE_REPLY;
        }

        if (specialReply) {
            console.log("🌸 固定応答を送信します。");
            try {
                await client.replyMessage(event.replyToken, { type: 'text', text: specialReply });
            } catch (e) {
                console.error('replyMessage failed on specialReply:', e?.statusCode, e?.message);
                await logErrorToDb(userId, 'replyMessage specialReply failed', { err: e?.message });
            }
            logToDb(userId, userMessage, specialReply, "こころちゃん", "special_reply");
            return;
        }
        
        // ⭐ 組織関連の問い合わせはAIに振らず固定返答に寄せる ⭐
        if (isOrganizationInquiry(userMessage)) {
            const reply = "NPO法人コネクトっていう団体のイメージキャラクターをしているよ😊　みんなの幸せを応援してるんだ🌸";
            try {
                await client.replyMessage(event.replyToken, { type: 'text', text: reply });
            } catch (e) {
                console.error('replyMessage failed on organization inquiry:', e?.statusCode, e?.message);
                await logErrorToDb(userId, 'replyMessage organization inquiry failed', { err: e?.message });
            }
            logToDb(userId, userMessage, reply, "こころちゃん", "organization_inquiry_fixed");
            return;
        }

        // ⭐ 危険・詐欺・不適切ワードに該当するかチェック (次に優先) ⭐
        const isDangerous = checkContainsDangerWords(userMessage);
        const isScam = checkContainsScamWords(userMessage);
        const isInappropriate = checkContainsInappropriateWords(userMessage);

        if (isDangerous) {
            console.log("🚨 危険ワードを検知。緊急連絡先をFlexメッセージで送信します。");
            await client.replyMessage(event.replyToken, EMERGENCY_FLEX_MESSAGE);
            await logToDb(userId, userMessage, JSON.stringify(EMERGENCY_FLEX_MESSAGE), "こころちゃん", "danger_word_triggered");
            // オフィサーグループへの通知ロジックも追加
            if (OFFICER_GROUP_ID) {
                const message = `🚨【危険ワード検知】🚨\nユーザーID: ${userId}\nメッセージ: ${userMessage}`;
                await client.pushMessage(OFFICER_GROUP_ID, { type: 'text', text: message });
            }
            return;
        }

        if (isScam) {
            console.log("🚨 詐欺ワードを検知。詐欺対策情報をFlexメッセージで送信します。");
            await client.replyMessage(event.replyToken, SCAM_FLEX_MESSAGE);
            await logToDb(userId, userMessage, JSON.stringify(SCAM_FLEX_MESSAGE), "こころちゃん", "scam_word_triggered");
            // オフィサーグループへの通知ロジックも追加
            if (OFFICER_GROUP_ID) {
                const message = `🚨【詐欺ワード検知】🚨\nユーザーID: ${userId}\nメッセージ: ${userMessage}`;
                await client.pushMessage(OFFICER_GROUP_ID, { type: 'text', text: message });
            }
            return;
        }
        
        if (isInappropriate) {
            console.log("❌ 不適切ワードを検知しました。");
            const responseMessage = `ごめんなさい、その言葉はわたしにはわからないな。別の言葉でお話してほしいな。🌸`;
            await client.replyMessage(event.replyToken, { type: 'text', text: responseMessage });
            await logToDb(userId, userMessage, responseMessage, "こころちゃん", "inappropriate_word_triggered");
            return;
        }

        // --- 通常の応答処理 ---

        // --- 会員登録・属性変更フロー ---
        if (lowerUserMessage === '会員登録' || lowerUserMessage === 'かいんとうろく' || lowerUserMessage === '属性変更' || lowerUserMessage === 'ぞくせいへんこう') {
            await client.replyMessage(event.replyToken, REGISTRATION_AND_CHANGE_BUTTONS_FLEX);
            logToDb(userId, userMessage, JSON.stringify(REGISTRATION_AND_CHANGE_BUTTONS_FLEX), "こころちゃん", "registration_buttons_display");
            return;
        }

        // 会話数制限チェック
        const modelToUse = getAIModelForUser(user, userMessage);
        if (modelToUse === "limit_exceeded") {
            const userConfig = MEMBERSHIP_CONFIG[user.membershipType];
            await client.replyMessage(event.replyToken, { type: 'text', text: userConfig.exceedLimitMessage });
            logToDb(userId, userMessage, userConfig.exceedLimitMessage, "こころちゃん", "conversation_limit_exceeded");
            return;
        }

        // --- AI応答生成と送信 ---
        const aiReply = await generateAIReply(userMessage, modelToUse, userId, user);
        await client.replyMessage(event.replyToken, { type: 'text', text: aiReply });
        
        // 会話数をカウントアップ
        const todayCount = (user.dailyCounts[today] || 0) + 1;
        await updateUserData(userId, { dailyCounts: { ...user.dailyCounts, [today]: todayCount } });
        // logToDbは呼び出さない (shouldLogMessageにnormal_chat_replyが無いので不要)

    } catch (error) {
        console.error("❌ イベント処理中にエラーが発生しました:", error);
        await logErrorToDb(userId, 'イベント処理中の予期せぬエラー', { event: event, error: error.message });
        if (event.replyToken) {
            await client.replyMessage(event.replyToken, { type: 'text', text: 'ごめんね、今ちょっと調子が悪いの。少し時間を置いてからまた話しかけてくれるかな？' });
        }
    }
}

// --- サーバー起動 ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 サーバーはポート${PORT}で実行されています`);
});
