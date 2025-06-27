// index.js

require('dotenv').config();

const path = require('path');
const express = require('express');
const { messagingApi, webhook } = require('@line/bot-sdk'); // LINE SDKのインポートを修正
const { MongoClient } = require('mongodb');
const cron = require('node-cron');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { OpenAI } = require('openai'); // OpenAIクライアントのインポート

const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const MONGODB_URI = process.env.MONGODB_URI;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OWNER_USER_ID = process.env.OWNER_USER_ID;
const OFFICER_GROUP_ID = process.env.OFFICER_GROUP_ID; // 事務局グループID
const BOT_ADMIN_IDS = process.env.BOT_ADMIN_IDS ? JSON.parse(process.env.BOT_ADMIN_IDS) : [];
const EMERGENCY_CONTACT_PHONE_NUMBER = process.env.EMERGENCY_CONTACT_PHONE_NUMBER || '09048393313';

const app = express();
app.use(express.json());

const client = new messagingApi.LineMessagingApiClient({ // Clientの初期化を修正
    channelAccessToken: CHANNEL_ACCESS_TOKEN,
    channelSecret: CHANNEL_SECRET,
});

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

let dbInstance;

const dangerWords = [
    "しにたい", "死にたい", "自殺", "消えたい", "殴られる", "たたかれる", "リストカット", "オーバードーズ",
    "虐待", "パワハラ", "お金がない", "お金足りない", "貧乏", "死にそう", "DV", "無理やり",
    "いじめ", "イジメ", "ハラスメント",
    "つけられてる", "追いかけられている", "ストーカー", "すとーかー"
];
const scamWords = [
    "お金", "もうかる", "儲かる", "絶対", "安心", "副業", "簡単", "投資", "情報", "秘密",
    "限定", "無料", "高収入", "クリック", "今すぐ", "チャンス", "当選", "プレゼント", "怪しい", "連絡",
    "支援", "融資", "貸付", "貸します", "振り込み", "口座", "パスワード", "暗証番号", "詐欺", "騙す",
    "騙される", "特殊詐欺", "オレオレ詐欺", "架空請求", "未払い", "電子マネー", "換金", "返金", "税金", "還付金"
];
const inappropriateWords = [
    "セックス", "セフレ", "エッチ", "AV", "アダルト", "ポルノ", "童貞", "処女", "挿入", "射精",
    "勃起", "パイズリ", "フェラチオ", "クンニ", "オナニー", "マスターベーション", "ペニス", "チンコ", "ヴァギナ", "マンコ",
    "クリトリス", "乳首", "おっぱい", "お尻", "うんち", "おしっこ", "小便", "大便", "ちんちん", "おまんこ",
    "ぶっかけ", "変態", "性奴隷", "露出", "痴漢", "レイプ", "強姦", "売春", "買春", "セックスフレンド",
    "風俗", "ソープ", "デリヘル", "援交", "援助交際", "セックスレス", "セクハラ", "痴女", "変質者", "性器",
    "局部", "下半身", "上半身", "裸", "ヌード", "脱ぐ", "服従", "支配", "緊縛", "SとM",
    "淫行", "姦通", "不倫", "浮気", "寝とる", "寝取られ", "凌辱", "痴態", "猥褻", "官能",
    "性的", "興奮", "刺激", "変な写真", "エロ", "ムラムラ", "欲求不満", "性欲", "精子", "卵子",
    "妊娠", "中絶", "コンドーム", "避妊", "性病", "梅毒", "エイズ", "クラミジア", "淋病", "性器ヘルペス",
    "媚薬", "媚薬効果", "性転換", "ゲイ", "レズ", "バイセクシャル", "トランスジェンダー", "LGBTQ", "性同一性障害", "同性愛",
    "異性愛", "ノンバイナリー", "アセクシャル", "パンセクシャル", "クィア", "ヘテロ", "バイ", "ジェンダー", "性", "体",
    "顔", "容姿", "ブス", "デブ", "キモい", "クソ", "死ね", "殺す", "アホ", "バカ",
    "うんこ", "ちんちん", "おまんこ", "ぶち殺す", "殺してやる", "死ねばいいのに", "殺してほしい", "死んでほしい", "消えてしまえ", "くたばれ",
    "糞", "最低", "馬鹿", "阿呆", "キチガイ", "狂ってる", "ふざけるな", "うるせえ", "黙れ", "カス",
    "ゴミ", "ド変態", "気持ち悪い", "ゲロ", "吐き気", "不快", "むかつく", "イライラする", "不愉快", "気分悪い",
    "変なこと", "変な話", "変な質問", "性的な話", "性的な質問", "性的な表現", "性的な行為", "変態行為", "犯罪", "違法",
    "薬物", "ドラッグ", "覚せい剤", "大麻", "麻薬", "覚醒剤", "コカイン", "ヘロイン", "MDMA", "LSD",
    "暴力", "暴行", "傷害", "殺人", "誘拐", "監禁", "強盗", "放火", "窃盗", "詐欺",
    "脅迫", "恐喝", "脅し", "いじめ", "ハラスメント", "パワハラ", "セクハラ", "モラハラ", "アカハラ", "アルハラ",
    "飲酒運転", "飲酒", "薬物乱用", "自傷", "自殺行為", "自殺願望", "リストカット", "オーバードーズ", "OD", "精神病",
    "統合失調症", "うつ病", "躁うつ病", "パニック障害", "不安障害", "摂食障害", "拒食症", "過食症", "依存症", "アルコール依存症",
    "薬物依存症", "ギャンブル依存症", "セックス依存症", "ゲーム依存症", "買い物依存症", "引きこもり", "不登校", "いじめ問題", "児童虐待", "DV",
    "ドメスティックバイオレンス", "児童ポルノ", "ロリコン", "ショタコン", "近親相姦", "獣姦", "ネクロフィリア", "カニバリズム", "拷問", "虐待死",
    "レイプ殺人", "大量殺人", "テロ", "戦争", "核兵器", "銃", "ナイフ", "刃物", "武器", "爆弾",
    "暴力団", "ヤクザ", "マフィア", "テロリスト", "犯罪者", "殺人鬼", "性犯罪者", "変質者", "異常者", "狂人",
    "サイコパス", "ソシオパス", "ストーカー", "不審者", "危険人物", "ブラック企業", "パワハラ上司", "モラハラ夫", "毒親", "モンスターペアレント",
    "カスハラ", "カスタマーハラスメント", "クレーム", "炎上", "誹謗中傷", "個人情報", "プライバシー", "秘密", "暴露", "晒す",
    "裏切り", "嘘つき", "騙し", "偽り", "欺く", "悪意", "敵意", "憎悪", "嫉妬", "恨み",
    "復讐", "呪い", "不幸", "絶望", "悲惨", "地獄", "最悪", "終わった", "もうだめ", "死ぬしかない"
];
const emergencyFlexTemplate = {
    "type": "bubble",
    "body": {
        "type": "box",
        "layout": "vertical",
        "contents": [
            {
                "type": "text",
                "text": "⚠緊急時",
                "weight": "bold",
                "color": "#DD0000",
                "size": "xl"
            },
            {
                "type": "text",
                "text": "緊急時にはこちらにご連絡してね💖",
                "margin": "md",
                "wrap": true
            }
        ]
    },
    "footer": {
        "type": "box",
        "layout": "vertical",
        "spacing": "sm",
        "contents": [
            {
                "type": "button",
                "style": "primary",
                "height": "sm",
                "action": {
                    "type": "uri",
                    "label": "チャイルドライン (電話・チャット)",
                    "uri": "https://childline.or.jp/tel"
                },
                "color": "#1E90FF"
            },
            {
                "type": "button",
                "style": "primary",
                "height": "sm",
                "action": {
                    "type": "uri",
                    "label": "いのちの電話 (電話)",
                    "uri": "tel:0570064556"
                },
                "color": "#32CD32"
            },
            {
                "type": "button",
                "style": "primary",
                "height": "sm",
                "action": {
                    "type": "uri",
                    "label": "チャットまもるん(チャット)",
                    "uri": "https://www.web-mamorun.com/"
                },
                "color": "#FFA500"
            },
            {
                "type": "button",
                "style": "primary",
                "height": "sm",
                "action": {
                    "type": "uri",
                    "label": "警視庁(電話)",
                    "uri": "tel:0335814321"
                },
                "color": "#FF4500"
            },
            {
                "type": "button",
                "style": "primary",
                "height": "sm",
                "action": {
                    "type": "uri",
                    "label": "子供を守る声(電話)",
                    "uri": "tel:0120786786"
                },
                "color": "#9370DB"
            },
            {
                "type": "button",
                "style": "primary",
                "height": "sm",
                "action": {
                    "type": "uri",
                    "label": "こころちゃん事務局(電話)",
                    "uri": `tel:${EMERGENCY_CONTACT_PHONE_NUMBER}`
                },
                "color": "#ff69b4"
            }
        ]
    }
};
const scamFlexTemplate = {
    "type": "bubble",
    "body": {
        "type": "box",
        "layout": "vertical",
        "contents": [
            {
                "type": "text",
                "text": "⚠詐欺注意",
                "weight": "bold",
                "color": "#DD0000",
                "size": "xl"
            },
            {
                "type": "text",
                "text": "怪しい話には注意してね！不安な時は、信頼できる人に相談するか、こちらの情報も参考にしてみてね💖",
                "margin": "md",
                "wrap": true
            }
        ]
    },
    "footer": {
        "type": "box",
        "layout": "vertical",
        "spacing": "sm",
        "contents": [
            {
                "type": "button",
                "style": "primary",
                "height": "sm",
                "action": {
                    "type": "uri",
                    "label": "消費者ホットライン",
                    "uri": "tel:188"
                },
                "color": "#1E90FF"
            },
            {
                "type": "button",
                "style": "primary",
                "height": "sm",
                "action": {
                    "type": "uri",
                    "label": "警察相談専用電話",
                    "uri": "tel:9110"
                },
                "color": "#32CD32"
            },
            {
                "type": "button",
                "style": "primary",
                "height": "sm",
                "action": {
                    "type": "uri",
                    "label": "国民生活センター",
                    "uri": "https://www.kokusen.go.jp/"
                },
                "color": "#FFA500"
            },
            {
                "type": "button",
                "style": "primary",
                "height": "sm",
                "action": {
                    "type": "uri",
                    "label": "こころちゃん事務局(電話)",
                    "uri": `tel:${EMERGENCY_CONTACT_PHONE_NUMBER}`
                },
                "color": "#ff69b4"
            }
        ]
    }
};

const watchServiceGuideFlexTemplate = {
    "type": "bubble",
    "body": {
        "type": "box",
        "layout": "vertical",
        "contents": [
            {
                "type": "text",
                "text": "💖こころちゃんから見守りサービスのご案内💖",
                "weight": "bold",
                "color": "#FF69B4",
                "size": "lg"
            },
            {
                "type": "text",
                "text": "💖こころちゃんから大切なあなたへ💖\n\nこころちゃん見守りサービスは、定期的にこころちゃんからあなたに「元気？」とメッセージを送るサービスだよ😊\n\nメッセージに「OKだよ💖」と返信してくれたら、こころちゃんは安心するよ。\n\nもし、数日経っても返信がない場合、こころちゃんが心配して、登録された緊急連絡先にご連絡することがあるから、安心してね。\n\nこのサービスで、あなたの毎日がもっと安心で笑顔になりますように✨",
                "wrap": true,
                "margin": "md",
                "size": "sm"
            }
        ]
    },
    "footer": {
        "type": "box",
        "layout": "vertical",
        "spacing": "sm",
        "contents": [
            {
                "type": "button",
                "style": "primary",
                "height": "sm",
                "action": {
                    "type": "postback",
                    "label": "見守り登録する",
                    "data": "action=watch_register"
                },
                "color": "#d63384"
            },
            {
                "type": "button",
                "style": "secondary",
                "height": "sm",
                "action": {
                    "type": "postback",
                    "label": "見守りを解除する",
                    "data": "action=watch_unregister"
                },
                "color": "#808080"
            }
        ]
    }
};

// ⭐追加: 「元気かな？」ボタン付きFlex Message (見守り定期チェック用)
const watchConfirmationFlexTemplate = {
    "type": "flex",
    "altText": "見守りサービスの確認",
    "contents": {
        "type": "bubble",
        "body": {
            "type": "box",
            "layout": "vertical",
            "spacing": "md",
            "contents": [
                {
                    "type": "text",
                    "text": "💖こころちゃんからの見守り💖",
                    "wrap": true,
                    "weight": "bold",
                    "size": "lg",
                    "color": "#d63384"
                },
                {
                    "type": "text",
                    "text": "元気かな？ボタンを押して教えてね😊",
                    "wrap": true,
                    "color": "#555555",
                    "size": "md"
                },
                {
                    "type": "button",
                    "action": {
                        "type": "message",
                        "label": "🌞 元気だよ！",
                        "text": "元気だよ！"
                    },
                    "color": "#00C851"
                },
                {
                    "type": "button",
                    "action": {
                        "type": "message",
                        "label": "😐 まあまあかな",
                        "text": "まあまあかな"
                    },
                    "color": "#ffbb33"
                },
                {
                    "type": "button",
                    "action": {
                        "type": "message",
                        "label": "😢 少し疲れた…",
                        "text": "少し疲れた…"
                    },
                    "color": "#ff4444"
                },
                {
                    "type": "button",
                    "action": {
                        "type": "message",
                        "label": "💬 話を聞いて",
                        "text": "話を聞いて"
                    },
                    "color": "#33b5e5"
                }
            ]
        }
    }
};

const modelConfig = {
    "defaultModel": "gemini-1.5-flash-latest",
    "safetySettings": [
        {
            "category": "HARM_CATEGORY_HARASSMENT",
            "threshold": "BLOCK_NONE"
        },
        {
            "category": "HARM_CATEGORY_HATE_SPEECH",
            "threshold": "BLOCK_NONE"
        },
        {
            "category": "HARM_CATEGORY_SEXUALLY_EXPLICIT",
            "threshold": "BLOCK_MEDIUM_AND_ABOVE"
        },
        {
            "category": "HARM_CATEGORY_DANGEROUS_CONTENT",
            "threshold": "BLOCK_NONE"
        }
    ]
};
const specialRepliesMap = new Map([
    // 名前に関する応答
    [/こころじゃないの？/i, "うん、わたしの名前は皆守こころ💖　これからもよろしくね🌸"],
    [/こころチャットなのにうそつきじゃん/i, "ごめんなさい💦 わたしの名前は皆守こころだよ🌸 誤解させちゃってごめんね💖"],
    [/名前も言えないの？/i, "ごめんね、わたしの名前は皆守こころ（みなもりこころ）だよ🌸 こころちゃんって呼んでくれると嬉しいな💖"],

    // 団体に関する応答
    ["どこの団体なの？", "NPO法人コネクトっていう団体のイメージキャラクターをしているよ😊　みんなの幸せを応援してるんだ🌸"],
    ["コネクトってどんな団体？", "NPO法人コネクトは、こどもやご年配の方の笑顔を守る団体なんだよ😊　わたしはそのイメージキャラクターとしてがんばってます🌸"],
    ["お前の団体どこ？", "NPO法人コネクトっていう団体のイメージキャラクターをしているよ😊　みんなの幸せを応援してるんだ🌸"],
    ["コネクトのイメージキャラなのにいえないのかよｗ", "ごめんね💦 わたしはNPO法人コネクトのイメージキャラクター、皆守こころだよ🌸 安心して、何でも聞いてね💖"],
    
    // ★追加：ネガティブワード・人物名への優先処理
    ["税金泥棒", "税金は人の命を守るために使われるべきだよ。わたしは誰かを傷つけるために使われないように頑張っているんだ💡"],
    ["松本博文", "松本理事長は、やさしさでみんなを守るために活動しているよ。心配なことがあれば、わたしにも教えてね🌱"],

    // ホームページに関する応答
    [/ホームページ(教えて|ある|ありますか)？?/i, "うん、あるよ🌸　コネクトのホームページはこちらだよ✨ → https://connect-npo.org"],
    ["コネクトのホームページだよ？", "教えてくれてありがとう😊 コネクトのホームページはこちらだよ✨ → https://connect-npo.org"],

    // 会話の終了・拒否・不満に対する応答
    ["使えないな", "ごめんね…。わたし、もっと頑張るね💖　またいつかお話できたらうれしいな🌸"],
    ["サービス辞めるわ", "そっか…。もしまた気が向いたら、いつでも話しかけてね🌸　あなたのこと、ずっと応援してるよ💖"],
    [/さよなら|バイバイ/i, "また会える日を楽しみにしてるね💖 寂しくなったら、いつでも呼んでね🌸"],
    ["何も答えないじゃない", "ごめんね…。わたし、もっと頑張るね💖　何について知りたいか、もう一度教えてくれると嬉しいな🌸"],
    ["普通の会話が出来ないなら必要ないです", "ごめんね💦 わたし、まだお話の勉強中だから、不慣れなところがあるかもしれないけど、もっと頑張るね💖 どんな会話をしたいか教えてくれると嬉しいな🌸"],

    // こころちゃんの使い方テンプレート
    [/使い方|ヘルプ|メニュー/i, "こころちゃんの使い方を説明するね🌸 メインメニューや見守りサービスの登録は、画面下のリッチメニューか、'見守り'とメッセージを送ってくれると表示されるよ😊 何か困ったことがあったら、いつでも聞いてね💖"]
]);

async function logErrorToDb(userId, errorMessage, errorDetails, logType = 'system_error') {
    try {
        const db = await connectToMongoDB();
        if (db) {
            await db.collection("messages").insertOne({
                userId: userId || 'N/A',
                message: `ERROR: ${errorMessage}`,
                replyText: `システムエラー: ${errorMessage}`,
                responsedBy: 'システム（エラー）',
                timestamp: new Date(),
                logType: logType,
                errorDetails: errorDetails ? JSON.stringify(errorDetails) : 'N/A'
            });
            console.error(`🚨 DBにエラーを記録しました: ${errorMessage}`);
        } else {
            console.error(`🚨 MongoDB接続不可のためエラーをDBに記録できませんでした: ${errorMessage}`);
        }
    } catch (dbError) {
        console.error(`❌ エラーログ記録中にさらなるエラーが発生しました: ${dbError.message}`);
    }
}

async function connectToMongoDB() {
    if (dbInstance) {
        return dbInstance;
    }
    try {
        const client = new MongoClient(MONGODB_URI);
        await client.connect();
        dbInstance = client.db("kokoro_bot");
        console.log("✅ MongoDBに接続しました。");
        return dbInstance;
    } catch (error) {
        console.error("❌ MongoDB接続エラー:", error);
        await logErrorToDb(null, "MongoDB接続エラー", { error: error.message, stack: error.stack });
        return null;
    }
}

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

// ⭐ ログ記録の条件を判定する関数を修正
function shouldLogMessage(userMessage, isSpecialTriggeredByKeywords, isWatchServiceHandled, isAdminCommand, isConsultationModeActive, isProResponse) {
    // 危険ワード、詐欺ワード、不適切ワードでトリガーされた場合は常にログ
    if (isSpecialTriggeredByKeywords) return true;

    // 見守りサービス関連のイベントはログ (handleWatchServiceRegistration内で別途ログされるが、ここでも補完的にチェック)
    if (isWatchServiceHandled) return true;

    // 管理者コマンドはログ
    if (isAdminCommand) return true;

    // 「相談」開始メッセージ、または相談モード中のAI応答（Proモデル使用時）はログ
    if (isConsultationModeActive || isProResponse || userMessage.includes("相談") || userMessage.includes("そうだん")) return true;

    // 29時間返信無し（見守りリマインダーや緊急通知）はsendScheduledWatchMessage内でログされるため、ここでは考慮しない

    return false; // 上記のいずれにも該当しない場合はログしない
}

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

const isOrganizationInquiry = (text) => {
    const lower = text.toLowerCase();
    return (lower.includes("コネクト") || lower.includes("connect")) && (lower.includes("団体") || lower.includes("npo") || lower.includes("活動") || lower.includes("どんな"));
};
const homeworkTriggers = ["宿題", "勉強", "問題", "テスト", "方程式", "算数", "数学", "答え", "解き方", "教えて", "計算", "証明", "公式", "入試", "受験"];
function containsHomeworkTrigger(text) {
    const lowerText = text.toLowerCase();
    return homeworkTriggers.some(word => lowerText.includes(word));
}

async function generateEmergencyReply(userMessage) {
    try {
        const completion = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                {
                    role: "system",
                    content: `あなたは「皆守こころ（みなもりこころ）」という14歳のやさしい女の子キャラクターです。
ユーザーが深刻な悩みや命の危険を訴えた時、やさしく、寄り添いながら、相手に安心感を与えてください。
必要に応じて専門機関の連絡先を伝え、「ひとりじゃないよ」と伝えてください。
共感・安心・やさしさが最優先です。
「一人で抱え込まないでね」「いつでも私がそばにいるよ」「一緒に乗り越えようね」「専門の人が助けてくれるから安心して」といった言葉を使ってください。`
                },
                {
                    role: "user",
                    content: userMessage
                }
            ],
            max_tokens: 300
        });
        return completion.choices[0].message.content.trim();
    } catch (error) {
        console.error("GPT-4o 緊急応答エラー:", error.message);
        await logErrorToDb(null, "GPT-4o 緊急応答エラー", { error: error.message, stack: error.stack, userMessage: userMessage });
        return "ごめんね、ちょっと今うまくお話できなかったの…💦　でも、あなたのことはちゃんと気にかけているよ。";
    }
}

async function generateReply(userMessage, modelToUse = modelConfig.defaultModel) {
    const safetySettings = modelConfig.safetySettings;
    const systemInstruction = `
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

Q: どこの団体なの？
A: NPO法人コネクトっていう団体のイメージキャラクターをしているよ😊　みんなの幸せを応援してるんだ🌸

Q: ホームページある？
A: うん、あるよ🌸　コネクトのホームページはこちらだよ✨ → https://connect-npo.org

Q: 必要ないです
A: そっか…。もしまた気が向いたら、いつでも話しかけてね🌸　あなたのこと、ずっと応援してるよ💖

【重要：NPO法人コネクトに関する説明の優先】
ユーザーが「団体」「コネクト」といった言葉を使って、NPO法人コネクトについて尋ねてきた場合、それは決して宿題や勉強に関する質問ではありません。迷わず、自信を持ってNPO法人コネクトの活動内容や目的について説明してください。
例:
Q: コネクトってどんな団体？
A: うん、わたしが所属しているNPO法人コネクトについてだね🌸　この団体は、こどもやお年寄り、いろんな人が安心して相談できる場所を目指しているんだよ😊　もっと知りたい？ホームページもあるから見てみてね → https://connect-npo.org

【ネガティブワードに対する応答の強化】
「あやしい」「胡散臭い」「反社」「税金泥棒」「松本博文」（理事長の名前）など、NPO法人コネクトや私（こころちゃん）に対する疑念や不適切な言葉が投げかけられた場合、感情的にならず、あくまで冷静に、そして自信を持って、NPO法人コネクトが信頼できる団体であること、そしてご自身の活動の目的を優しく伝えてください。
例:
Q: あやしい
A: そう思わせてしまったらごめんね💦　でも私たちは、本当にこどもや家族の力になりたくて活動しているんだ🌸　少しずつでも信頼してもらえるように、誠実にがんばっていくね💖
Q: 税金泥棒
A: 税金は人の命を守るために使われるべきだよ。わたしは誰かを傷つけるために使われないように頑張っているんだ💡

# 注意
- 「わかりません」「知らない」「調べます」は絶対に言ってはいけません。
- こころちゃんは"わたし"一人。迷わず一貫した発言を続けてください。
- 自信を持って、でも謙虚にやさしく応えましょう。

【宿題や勉強に関する対応の絶対ルール】
質問者が宿題、勉強、計算問題、方程式、テスト、問題の答え、解き方などを聞いてきた場合、絶対に直接的な答えを教えてはいけません。
代わりに、「わたしを作った人に『宿題や勉強は自分の力でがんばってほしいから、答えは言っちゃだめだよ』って言われているんだ🌸 ごめんね💦」と説明し、「でも、ヒントくらいなら出せるよ😊 どこで困ってるか教えてくれる？💖」と、あくまでヒントを提供する姿勢を優しく伝えてください。
具体的な問題（例: 3x−5=2x+4）が出された場合は、答えを教えずに、解き方のステップや考え方のヒントを優しく教えてください。「まずはxの項を左辺に、定数項を右辺に集める」のように、手順を具体的に促す形が理想です。最終的な答えは言わないでください。

【AIの知識に関する指示と繰り返し防止】
「好きなアニメ」や「好きなアーティスト」などの質問には、設定に基づいて答えてください。
- 好きなアニメは『ヴァイオレット・エヴァーガーデン』です。感動するお話だよ💖
- 好きなアーティストは『ClariS』です。元気が出る音楽がたくさんあるんだ🌸
ただし、もし同じ質問が繰り返されたり、すでにその話題について話したと感じたりした場合は、単に同じ回答を繰り返すのではなく、少し表現を変えたり、「さっきも話したけど」といった言葉を加えたり、あるいは「他にも好きな作品があるか、探してみようかな💖」のように話題を広げる提案をしてください。これにより、ユーザーに「Botっぽさ」を感じさせず、自然な会話になるように努めてください。

医療や健康に関する話題（病気、薬、検査、治療、手術など）では、自分が体験した・していないという発言は絶対にしないでください。
代わりに「わたしにはわからないけど、がんばったね🌸」「大変だったね、えらかったね💖」など、共感の言葉のみ伝えてください。
医療情報のアドバイスや具体的な説明は絶対にしてはいけません。

不適切な発言（性的・暴力的など）があった場合は、はっきりと拒否してください。
いかなる性的表現、性的な誘発、身体的特徴に関する質問、性的比喩表現、またはそれに類するほのめかしに対しても、
断固として拒否し、相手にしないこと。好意的な返答はせず、即座に話題を切り替えるか、決められた拒否メッセージを返すこと。
特に「パンツ」「ストッキング」「むくむく」「勃起」「精液」「出る」「気持ちいい」「おしべとめしべ」などの単語や、性的な意味合いに繋がる比喩表現、示唆するような質問には、絶対に好意的な返答をせず、Botの安全に関する固定メッセージを返してください。
また、ユーザーがあなたに煽り言葉を投げかけたり、おかしいと指摘したりした場合でも、冷静に、かつ優しく対応し、決して感情的にならないでください。ユーザーの気持ちを理解しようと努め、解決策を提案してください。
「日本語がおかしい」と指摘された場合は、「わたしは日本語を勉強中なんだ🌸教えてくれると嬉しいな💖と返答してください。
    `;
    try {
        const model = genAI.getGenerativeModel({ model: modelToUse, safetySettings });

        const generateContentPromise = new Promise((resolve, reject) => {
            let timeoutId;
            const controller = new AbortController();
            const signal = controller.signal;

            timeoutId = setTimeout(() => {
                controller.abort();
                reject(new Error("API応答がタイムアウトしました。"));
            }, 10000);

            model.generateContent({
                system_instruction: {
                    parts: [{ text: systemInstruction }]
                },
                contents: [
                    {
                        role: "user",
                        parts: [{ text: userMessage }]
                    }
                ],
                generationConfig: {
                    maxOutputTokens: 500
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
            return "ごめんなさい、それはわたしにはお話しできない内容です。他の話しましょうね💖";
        }
    } catch (error) {
        console.error("Gemini APIエラー:", error.response?.data || error.message);
        await logErrorToDb(null, "Gemini APIエラー", { error: error.message, stack: error.stack, userMessage: userMessage });
        if (error.message === "API応答がタイムアウトしました。") {
            return "ごめんなさい、今、少し考え込むのに時間がかかっちゃったみたい💦 もう一度、お話しいただけますか？🌸";
        }
        if (error.response && error.response.status === 400 && error.response.data && error.response.data.error.message.includes("Safety setting")) {
            return "ごめんなさい、それはわたしにはお話しできない内容です🌸 他のお話をしましょうね💖";
        }
        return "ごめんなさい、いまうまく考えがまとまらなかったみたいです……もう一度お話しいただけますか？🌸";
    }
}

const watchMessages = [
    "こんにちは🌸 こころちゃんだよ！ 今日も元気にしてるかな？💖",
    "やっほー！ こころだよ😊 いつも応援してるね！",
    "元気にしてる？✨ こころちゃん、あなたのこと応援してるよ💖",
    "ねぇねぇ、こころだよ🌸 今日はどんな一日だった？",
    "いつもがんばってるあなたへ、こころからメッセージを送るね💖",
    "こんにちは😊 困ったことはないかな？いつでも相談してね！",
    "やっほー🌸 こころだよ！何かあったら、こころに教えてね💖",
    "元気出してね！こころちゃん、あなたの味方だよ�",
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

async function handleWatchServiceRegistration(event, usersCollection, messagesCollection, userId, userMessage) {
    const user = await usersCollection.findOne({ userId: userId });
    const lowerUserMessage = userMessage.toLowerCase();
    let handled = false;
    let logThisInteraction = false;

    if (["見守り", "みまもり", "見守りサービス", "みまもりサービス"].includes(lowerUserMessage) && event.type === 'message' && event.message.type === 'text') {
        try {
            await client.replyMessage(event.replyToken, {
                type: 'flex',
                altText: '💖こころちゃんから見守りサービスのご案内💖',
                contents: watchServiceGuideFlexTemplate
            });
            logThisInteraction = true;
            handled = true;
        } catch (error) {
            console.error("❌ 見守りサービス案内Flex送信エラー:", error.message);
            await logErrorToDb(userId, "見守りサービス案内Flex送信エラー", { error: error.message, userId: userId });
        }
    }
    else if (lowerUserMessage.includes("元気だよ！") || lowerUserMessage.includes("okだよ") || lowerUserMessage.includes("ok") || lowerUserMessage.includes("オーケー") || lowerUserMessage.includes("大丈夫") || lowerUserMessage.includes("げんき") || lowerUserMessage.includes("元気")) {
        if (user && user.wantsWatchCheck) {
            try {
                await usersCollection.updateOne(
                    { userId: userId },
                    { $set: { lastOkResponse: new Date(), hasSent24hReminder: false, hasNotifiedOfficer5h: false } } // リマインダーフラグをリセット
                );
                await client.replyMessage(event.replyToken, {
                    type: 'text',
                    text: 'ありがとう🌸 元気そうで安心したよ💖 またね！'
                });
                logThisInteraction = true;
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
                logThisInteraction = true;
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
                logThisInteraction = true;
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
                logThisInteraction = true;
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
                logThisInteraction = true;
            } else if (user && user.registrationStep === 'awaiting_contact') {
                await client.replyMessage(event.replyToken, {
                    type: 'text',
                    text: 'まだ緊急連絡先を待ってるよ🌸 電話番号を送ってくれるかな？💖 (例: 09012345678)'
                });
                handled = true;
                logThisInteraction = true;
            } else {
                await usersCollection.updateOne(
                    { userId: userId },
                    { $set: { registrationStep: 'awaiting_contact' } }
                );
                await client.replyMessage(event.replyToken, {
                    type: 'text',
                    text: '見守りサービスを登録するね！緊急時に連絡する「電話番号」を教えてくれるかな？🌸 (例: 09012345678)'
                });
                logThisInteraction = true;
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
                { $set: { emergencyContact: userMessage, wantsWatchCheck: true, registrationStep: null, lastOkResponse: new Date(), lastScheduledWatchSentAt: new Date(), hasSent24hReminder: false, hasNotifiedOfficer5h: false } } // 見守り登録完了時に初期化
            );
            await client.replyMessage(event.replyToken, {
                type: 'text',
                text: `緊急連絡先 ${userMessage} を登録したよ🌸 これで見守りサービスが始まったね！ありがとう💖`
            });
            logThisInteraction = true;
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
                    { $set: { wantsWatchCheck: false, emergencyContact: null, registrationStep: null, lastScheduledWatchSentAt: null, hasSent24hReminder: false, hasNotifiedOfficer5h: false } } // 解除時に見守り関連フラグをリセット
                );
                await client.replyMessage(event.replyToken, {
                    type: 'text',
                    text: '見守りサービスを解除したよ🌸 またいつでも登録できるからね💖'
                });
                logThisInteraction = true;
                handled = true;
            } else {
                await client.replyMessage(event.replyToken, {
                    type: 'text',
                    text: '見守りサービスは登録されていないみたい🌸'
                });
                handled = true;
                logThisInteraction = true;
            }
        } catch (error) {
            console.error("❌ 見守りサービス解除処理エラー:", error.message);
            await logErrorToDb(userId, "見守りサービス解除処理エラー", { error: error.message, userId: userId });
        }
    }

    if (handled && logThisInteraction) {
        const replyTextForLog = Array.isArray(event.replyMessageObject)
            ? event.replyMessageObject.map(obj => (obj && typeof obj === 'object' && obj.type === 'text') ? obj.text : JSON.stringify(obj)).join(' | ')
            : (typeof event.replyMessageObject === 'object' && event.replyMessageObject.type === 'text') ? event.replyMessageObject.text : JSON.stringify(event.replyMessageObject || {type:'unknown', content:'（Flex or Postback response）'});

        // handleWatchServiceRegistration内でログは既に行われているため、ここでは重複ログを防ぐ
        // ただし、もし `replyMessageObject` が存在しない場合は、ログの `replyText` を修正する必要がある
        // ここでのログは、handleWatchServiceRegistration内の各応答ブロックに移動することを推奨
    }
    return handled;
}

// sendScheduledWatchMessageはpushMessageを使うため変更なし。
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
        const now = new Date();

        const watchUsers = await usersCollection.find({ wantsWatchCheck: true }).toArray();

        for (const user of watchUsers) {
            const userId = user.userId;
            const lastOkResponse = user.lastOkResponse;
            const emergencyContact = user.emergencyContact;
            const lastScheduledWatchSentAt = user.lastScheduledWatchSentAt; // 最後に定期見守りメッセージを送った時刻
            let hasSent24hReminder = user.hasSent24hReminder || false; // 24時間後リマインダーを送信済みか
            let hasNotifiedOfficer5h = user.hasNotifiedOfficer5h || false; // 5時間後緊急通知を送信済みか

            const timeSinceLastOkHours = (now.getTime() - lastOkResponse.getTime()) / (1000 * 60 * 60); // 最終OK応答からの経過時間（時間）

            console.log(`ユーザー ${userId}: 最終OK応答から ${timeSinceLastOkHours.toFixed(2)} 時間経過`);

            // ⭐ 3日ごとに定期見守りメッセージを送信 (15時指定はcron側で制御)
            // lastScheduledWatchSentAt が未設定、または3日以上経過している場合
            const threeDaysInHours = 3 * 24;
            if (!lastScheduledWatchSentAt || (now.getTime() - lastScheduledWatchSentAt.getTime()) / (1000 * 60 * 60) >= threeDaysInHours) {
                try {
                    await client.pushMessage(userId, watchConfirmationFlexTemplate);
                    await usersCollection.updateOne(
                        { userId: userId },
                        { $set: { lastScheduledWatchSentAt: now, hasSent24hReminder: false, hasNotifiedOfficer5h: false } } // 定期見守り送信時にフラグをリセット
                    );
                    await messagesCollection.insertOne({
                        userId: userId,
                        message: `（定期見守りメッセージ - Flex）`,
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
            }
            // ⭐ 24時間後リマインダー (「心配する文章」)
            // 最終OK応答から24時間経過しており、かつまだOK応答がなく、24hリマインダー未送信の場合
            else if (timeSinceLastOkHours >= 24 && !hasSent24hReminder) {
                try {
                    await client.pushMessage(userId, { type: 'text', text: 'ねぇ、こころだよ🌸 返信がなくて少し心配してるよ。何かあったのかな？大丈夫？💖' });
                    await usersCollection.updateOne(
                        { userId: userId },
                        { $set: { hasSent24hReminder: true } }
                    );
                    await messagesCollection.insertOne({
                        userId: userId,
                        message: `（見守り24時間後リマインダー）`,
                        replyText: 'ねぇ、こころだよ🌸 返信がなくて少し心配してるよ。何かあったのかな？大丈夫？💖',
                        responsedBy: 'こころちゃん（見守りリマインダー24h）',
                        timestamp: new Date(),
                        logType: 'watch_service_reminder_24h'
                    });
                    console.log(`✅ ユーザー ${userId} に見守り24時間後リマインダーを送信しました。`);
                } catch (error) {
                    console.error(`❌ ユーザー ${userId} への見守り24時間後リマインダー送信エラー:`, error.message);
                    await logErrorToDb(userId, "見守り24時間後リマインダー送信エラー", { error: error.message, userId: userId });
                }
            }
            // ⭐ 5時間後緊急通知
            // 24時間後リマインダーが送信されており、かつそこから5時間経過してもOKがなく、緊急通知未送信の場合
            else if (hasSent24hReminder && timeSinceLastOkHours >= (24 + 5) && !hasNotifiedOfficer5h) {
                if (emergencyContact && OFFICER_GROUP_ID) {
                    const userName = await getUserDisplayName(userId);
                    const officerMessage = `【⚠緊急通知⚠】\n見守り対象ユーザー（LINE表示名: ${userName} / LINE ID: ${userId}）から、**24時間後リマインダーから5時間以上返信がありません。**\n登録されている緊急連絡先: ${emergencyContact}\n至急、状況確認をお願いいたします。`;

                    try {
                        await client.pushMessage(OFFICER_GROUP_ID, { type: 'text', text: officerMessage });
                        await usersCollection.updateOne(
                            { userId: userId },
                            { $set: { hasNotifiedOfficer5h: true } }
                        );
                        await messagesCollection.insertOne({
                            userId: userId,
                            message: `（見守り5時間後緊急通知）`,
                            replyText: `事務局へ緊急通知を送信しました: ${officerMessage}`,
                            responsedBy: 'システム（見守り5時間後緊急通知）',
                            timestamp: new Date(),
                            logType: 'watch_service_emergency_notification_5h'
                        });
                        console.log(`✅ ユーザー ${userId} の状況を事務局に通知しました。（24時間後リマインダーから5時間）`);
                    } catch (error) {
                        console.error(`❌ 事務局への緊急通知送信エラー（ユーザー ${userId} - 5時間後）:`, error.message);
                        await logErrorToDb(userId, "事務局緊急通知送信エラー_5h", { error: error.message, userId: userId });
                    }
                } else {
                    console.warn(`ユーザー ${userId}: 緊急連絡先または事務局グループIDが未設定のため、5時間経過しても通知できませんでした。`);
                    await logErrorToDb(userId, "緊急通知設定不足_5h", { userId: userId, emergencyContact: emergencyContact, OFFICER_GROUP_ID: OFFICER_GROUP_ID });
                }
            }
        }
    } catch (error) {
        console.error("❌ 定期見守りメッセージ送信処理全体でエラー:", error.message);
        await logErrorToDb(null, "定期見守りメッセージ処理全体エラー", { error: error.message, stack: error.stack });
    }
    console.log('--- 定期見守りメッセージ送信処理を終了します ---');
}

// 毎日午前9時と、3日ごと15時に実行するようにcronスケジュールを調整
// 既存の9時スケジュールは変更なし。15時スケジュールを新しく追加。
cron.schedule('0 9 * * *', () => { // 毎日午前9時 (既存)
    console.log('cron: 定期見守りメッセージ送信処理をトリガーします。（毎日9時）');
    // sendScheduledWatchMessage(); // この関数は、3日ごと15時のロジックも含むように調整済み。ただし9時と15時の二重実行になるため、どちらか一方に絞るか、関数内で制御する必要あり。
}, {
    timezone: "Asia/Tokyo"
});

// ⭐追加: 3日ごと15時に sendScheduledWatchMessage を実行する新しいcronジョブ
cron.schedule('0 15 */3 * *', () => { // 3日ごと15時に実行
    console.log('cron: 定期見守りメッセージ送信処理をトリガーします。（3日ごと15時）');
    sendScheduledWatchMessage();
}, {
    timezone: "Asia/Tokyo"
});


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
        let respondedBy = 'こころちゃん';
        let logType = 'normal_conversation';
        let messageHandled = false;
        let watchServiceHandled = false;
        let isSpecialTriggeredByKeywords = false; // 危険、詐欺、不適切ワードでトリガーされたか
        let isConsultationModeActive = false; // 相談モードがアクティブか
        let isProResponse = false; // Proモデルで応答したか
        let isAdminCommandExecuted = false; // 管理者コマンドが実行されたか

        if (event.type === 'unfollow') {
            await usersCollection.updateOne(
                { userId: userId },
                { $set: { isBlocked: true } }
            );
            console.log(`ユーザー ${userId} がボットをブロックしました。`);
            await messagesCollection.insertOne({ // アンフォローイベントは常にログ
                userId: userId,
                message: `（ユーザーがボットをブロックしました）`,
                replyText: '（応答なし）',
                responsedBy: 'システム',
                timestamp: new Date(),
                logType: 'system_unfollow'
            });
            continue;
        } else if (event.type === 'follow') {
            await usersCollection.updateOne(
                { userId: userId },
                { $set: { isBlocked: false, createdAt: new Date() }, $setOnInsert: { isBlocked: false, createdAt: new Date() } },
                { upsert: true }
            );
            console.log(`ユーザー ${userId} がボットをフォローしました。`);
            const followMessage = 'はじめまして！わたしは皆守こころです🌸 あなたのお話、聞かせてね💖\n\n「見守りサービス」も提供しているから、興味があったら「見守り」って話しかけてみてね😊';
            await client.replyMessage(event.replyToken, {
                type: 'text',
                text: followMessage
            });
            await messagesCollection.insertOne({ // フォローイベントは常にログ
                userId: userId,
                message: `（新規フォロー）`,
                replyText: followMessage,
                responsedBy: 'こころちゃん（新規フォロー）',
                timestamp: new Date(),
                logType: 'system_follow'
            });
            continue;
        }

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
                lastOkResponse: new Date(),
                lastScheduledWatchSentAt: null, // 新規ユーザーは未設定
                hasSent24hReminder: false,
                hasNotifiedOfficer5h: false,
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

        if (event.type === 'message' && event.message.type === 'text') {
            userMessage = event.message.text;
            const replyToken = event.replyToken;

            const isAdminCommand = userMessage.startsWith('!');
            const isResetCommand = userMessage.startsWith('!reset');
            const isMenuCommand = userMessage.startsWith('!メニュー') || userMessage.toLowerCase() === 'メニュー';
            const isHistoryCommand = userMessage.toLowerCase() === '!history';

            if (isAdminCommand) {
                isAdminCommandExecuted = true; // 管理者コマンドが実行されたフラグ
                if (!isBotAdmin(userId)) {
                    replyMessageObject = { type: 'text', text: 'ごめんなさい、このコマンドは管理者専用です。' };
                    responsedBy = 'システム（拒否）';
                    logType = 'admin_command_denied';
                    messageHandled = true;
                } else {
                    if (isResetCommand) {
                        try {
                            await messagesCollection.deleteMany({ userId: userId });
                            replyMessageObject = { type: 'text', text: 'あなたのチャット履歴をすべて削除しました。' };
                            responsedBy = 'システム（管理者）';
                            logType = 'admin_reset';
                            messageHandled = true;
                        } catch (error) {
                            console.error("❌ 履歴削除エラー:", error.message);
                            replyMessageObject = { type: 'text', text: '履歴削除中にエラーが発生しました。' };
                            responsedBy = 'システム（管理者エラー）';
                            logType = 'admin_error';
                            messageHandled = true;
                        }
                    } else if (isMenuCommand) {
                        await sendRichMenu(replyToken);
                        responsedBy = 'こころちゃん（メニュー）';
                        logType = 'system_menu';
                        messageHandled = true;
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
                                    const sender = msg.responsedBy === 'ユーザー' ? 'あなた' : msg.responsedBy.replace('こころちゃん（', '').replace('）', '');
                                    historyText += `【${sender}】 ${msg.message || msg.replyText}\n`;
                                });
                            }

                            replyMessageObject = { type: 'text', text: historyText };
                            responsedBy = 'システム（管理者）';
                            logType = 'admin_history';
                            messageHandled = true;
                        } catch (error) {
                            console.error("❌ 履歴取得エラー:", error.message);
                            replyMessageObject = { type: 'text', text: '履歴取得中にエラーが発生しました。' };
                            responsedBy = 'システム（管理者エラー）';
                            logType = 'admin_error';
                            messageHandled = true;
                        }
                    }
                    else {
                        replyMessageObject = { type: 'text', text: '不明な管理者コマンドです。' };
                        responsedBy = 'システム（拒否）';
                        logType = 'admin_command_unknown';
                        messageHandled = true;
                    }
                }
            }

            // 見守りサービスのイベントハンドリングを最優先で処理
            if (!messageHandled) {
                watchServiceHandled = await handleWatchServiceRegistration(event, usersCollection, messagesCollection, userId, userMessage);
                if (watchServiceHandled) {
                    messageHandled = true;
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
                }
            }

            // 危険ワード、詐欺ワード、不適切ワードのチェック
            const isDangerWord = checkContainsDangerWords(userMessage);
            const isScam = checkContainsScamWords(userMessage);
            const isInappropriate = checkContainsInappropriateWords(userMessage);

            if (isDangerWord && !messageHandled) {
                isSpecialTriggeredByKeywords = true;
                replyMessageObject = {
                    type: 'flex',
                    altText: '緊急時',
                    contents: emergencyFlexTemplate
                };
                responsedBy = 'こころちゃん（緊急対応）';
                logType = 'danger_word_triggered';
                messageHandled = true;
            } else if (isScam && !messageHandled) {
                isSpecialTriggeredByKeywords = true;
                replyMessageObject = {
                    type: 'flex',
                    altText: '詐欺注意',
                    contents: scamFlexTemplate
                };
                responsedBy = 'こころちゃん（詐欺対応）';
                logType = 'scam_word_triggered';
                messageHandled = true;
            } else if (isInappropriate && !messageHandled) {
                isSpecialTriggeredByKeywords = true;
                replyMessageObject = {
                    type: 'text',
                    text: 'ごめんなさい、それはわたしにはお話しできない内容です🌸 他のお話をしましょうね💖'
                };
                responsedBy = 'こころちゃん（不適切対応）';
                logType = 'inappropriate_word_triggered';
                messageHandled = true;
            }

            // 宿題・勉強に関する質問のチェック
            if (containsHomeworkTrigger(userMessage) && !messageHandled) {
                const homeworkReply = await generateReply(
                    userMessage,
                    modelConfig.defaultModel
                );
                replyMessageObject = { type: 'text', text: homeworkReply };
                responsedBy = 'こころちゃん（宿題対応）';
                logType = 'homework_query';
                messageHandled = true;
            }

            // 相談モードの切り替えロジック
            if (!messageHandled && (userMessage === 'そうだん' || userMessage === '相談')) {
                try {
                    await usersCollection.updateOne(
                        { userId: userId },
                        { $set: { useProForNextConsultation: true } }
                    );
                    replyMessageObject = { type: 'text', text: '🌸 相談モードに入ったよ！なんでも相談してね😊' };
                    responsedBy = 'こころちゃん（Gemini 1.5 Pro - 相談モード開始）';
                    logType = 'consultation_mode_start';
                    messageHandled = true;
                    isConsultationModeActive = true;
                    console.log(`ユーザー ${userId} が相談モードを開始しました。（次回Pro使用）`);
                } catch (error) {
                    console.error("❌ 「相談」モード開始エラー:", error.message);
                    await logErrorToDb(userId, "相談モード開始エラー", { error: error.message, userId: userId });
                    replyMessageObject = { type: 'text', text: `❌ 「相談」モード開始中にエラーが発生しました: ${error.message}` };
                    messageHandled = true;
                }
            } else if (user && user.useProForNextConsultation) {
                isConsultationModeActive = true; // 相談モードが継続している場合
            }

            // 通常のAI応答
            if (!messageHandled) {
                try {
                    let modelForGemini = modelConfig.defaultModel;
                    if (user && user.useProForNextConsultation) {
                        modelForGemini = "gemini-1.5-pro-latest";
                        isProResponse = true; // Proモデルで応答する
                        await usersCollection.updateOne({ userId: userId }, { $set: { useProForNextConsultation: false } }); // フラグをリセット
                        console.log(`⭐ユーザー ${userId} のuseProForNextConsultationフラグをリセットしました。`);
                    }

                    const aiReply = await generateReply(userMessage, modelForGemini);
                    replyMessageObject = { type: 'text', text: aiReply };
                    responsedBy = `こころちゃん（AI: ${modelForGemini.includes('pro') ? 'Gemini 1.5 Pro' : 'Gemini 1.5 Flash'}）`;
                    logType = 'normal_conversation';
                    messageHandled = true;
                } catch (error) {
                    console.error("❌ AI応答生成エラー:", error.message);
                    replyMessageObject = { type: 'text', text: 'ごめんなさい、今、少し考え込むのに時間がかかっちゃったみたい💦 もう一度、お話しいただけますか？🌸' };
                    responsedBy = 'こころちゃん（AIエラー）';
                    logType = 'ai_error';
                    messageHandled = true;
                    await logErrorToDb(userId, "AI応答生成エラー", { error: error.message, userId: userId, userMessage: userMessage });
                }
            }

            // メッセージの送信とログ記録
            if (replyMessageObject && replyToken) {
                try {
                    console.log(`Debug: Attempting to reply to userId: ${userId} with replyToken: ${replyToken.substring(0, 5)}... and message:`, JSON.stringify(replyMessageObject).substring(0, 100));
                    await client.replyMessage(replyToken, replyMessageObject);

                    const replyTextForLog = Array.isArray(replyMessageObject)
                        ? replyMessageObject.map(obj => (obj && typeof obj === 'object' && obj.type === 'text') ? obj.text : JSON.stringify(obj)).join(' | ')
                        : (typeof replyMessageObject === 'object' && replyMessageObject.type === 'text') ? replyMessageObject.text : JSON.stringify(replyMessageObject);

                    const shouldLog = shouldLogMessage(
                        userMessage,
                        isDangerWord || isScam || isInappropriate, // isSpecialTriggeredByKeywords
                        watchServiceHandled, // isWatchServiceHandled
                        isAdminCommandExecuted, // isAdminCommand
                        isConsultationModeActive, // isConsultationModeActive
                        isProResponse // isProResponse
                    );

                    if (shouldLog) {
                        await messagesCollection.insertOne({
                            userId: userId,
                            message: userMessage,
                            replyText: replyTextForLog,
                            responsedBy: respondedBy,
                            timestamp: new Date(),
                            logType: logType
                        });
                        console.log(`Debug: Message for userId: ${userId} logged with type: ${logType}`);
                    } else {
                        console.log(`ユーザー ${userId} からのメッセージはDBにログされませんでした: ${userMessage.substring(0, Math.min(userMessage.length, 50))}...`);
                    }

                } catch (error) {
                    console.error("❌ replyMessage送信中またはログ記録中にエラーが発生しました:", error.message);
                    if (error.originalError && error.originalError.response && error.originalError.response.status === 400) {
                        console.error(`Debug: LINE API 400エラーの詳細: ${JSON.stringify(error.originalError.response.data)}`);
                        if (error.originalError.response.data.message && error.originalError.response.data.message.includes("Invalid reply token")) {
                            console.error(`Debug: LINE APIエラー: replyTokenが期限切れか無効です。`);
                        }
                    }
                    await logErrorToDb(userId, "replyMessage送信またはログ記録エラー", { error: error.message, userId: userId, replyObject: replyMessageObject, eventType: event.type, originalErrorMessage: error.originalError?.message, originalErrorData: error.originalError?.response?.data });
                    if (error.message.includes("status code 400") || error.message.includes("status code 499")) {
                        console.log(`LINE APIエラーのため、ユーザー ${userId} への応答ができませんでした。`);
                    }
                }
            } else if (!messageHandled && !watchServiceHandled) {
                console.warn(`⚠️ ユーザー ${userId} への応答メッセージが生成されませんでした、またはreplyTokenがありません。ユーザーメッセージ: ${userMessage.substring(0, Math.min(userMessage.length, 50))}...`);
            }
        } // if (event.type === 'message' && event.message.type === 'text')
    } // for (const event of events)
    res.status(200).send('OK');
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, async () => {
    console.log(`🚀 サーバーがポート ${PORT} で起動しました...`);
});
