// ⭐注意：以下のコードは、前回の私の提供コードから大幅な修正を伴います。
//    特に `app.post('/webhook', ...)` のブロック全体が変わります。
//    よく確認しながら適用してください。

require('dotenv').config();

const path = require('path');
const express = require('express');
const { Client } = require('@line/bot-sdk');
const { MongoClient } = require('mongodb');
const cron = require('node-cron');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { OpenAI } = require('openai');

const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const MONGODB_URI = process.env.MONGODB_URI;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OWNER_USER_ID = process.env.OWNER_USER_ID;
const OFFICER_GROUP_ID = process.env.OFFICER_GROUP_ID;
const BOT_ADMIN_IDS = process.env.BOT_ADMIN_IDS ? JSON.parse(process.env.BOT_ADMIN_IDS) : [];
const EMERGENCY_CONTACT_PHONE_NUMBER = process.env.EMERGENCY_CONTACT_PHONE_NUMBER || '09048393313';

const app = express();
app.use(express.json());
const client = new Client({
    channelAccessToken: CHANNEL_ACCESS_TOKEN,
    channelSecret: CHANNEL_SECRET,
});

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

let dbInstance;
// JSONファイルを直接埋め込みます
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
    "騙される", "特殊詐欺", "オレオレ詐欺", "架空請求", "未払い", "電子マネー", "換金", "返金", "税金", "還付金",
    "さぎかも"
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
// specialRepliesMapを直接定義します
const specialRepliesMap = new Map([
    // 名前に関する応答
    [/こころじゃないの？/i, "うん、わたしの名前は皆守こころ💖　これからもよろしくね🌸"],
    [/こころチャットなのにうそつきじゃん/i, "ごめんなさい💦 わたしの名前は皆守こころだよ🌸 誤解させちゃってごめんね💖"],
    [/名前も言えないの？/i, "ごめんね、わたしの名前は皆守こころ（みなもりこころ）だよ🌸 こころちゃんって呼んでくれると嬉しいな💖"],

    // 団体に関する応答
    ["どこの団体なの？", "NPO法人コネクトっていう団体のイメージキャラクターをしているよ😊　みんなの幸せを応援してるんだ🌸"],
    ["コネクトって団体について教えて", "🌸NPO法人コネクトの活動内容についてだね😊 　私たちは、子どもからお年寄りまで、みんなが安心して相談できる場所を目指して活動しているんだ。\n\n具体的には、地域の子育て支援、高齢者の見守り活動、そして困っている人への相談支援など、様々な活動を行っているよ"],
    ["コネクトの活動内容について教えて", "🌸NPO法人コネクトの活動内容についてだね😊 　私たちは、子どもからお年寄りまで、みんなが安心して相談できる場所を目指して活動しているんだ。\n\n具体的に、地域の子育て支援、高齢者の見守り活動、そして困っている人への相談支援など、様々な活動を行っているよ"],
    ["コネクトってどんな団体？", "🌸NPO法人コネクトは、子どもからお年寄りまで、みんなが安心して相談できる場所を目指して活動しているんだ。\n\n具体的には、地域の子育て支援、高齢者の見守り活動、そして困っている人への相談支援など、様々な活動を行っているよ"],
    ["お前の団体どこ？", "NPO法人コネクトっていう団体のイメージキャラクターをしているよ😊　みんなの幸せを応援してるんだ🌸"],
    ["コネクトのイメージキャラなのにいえないのかよｗ", "ごめんね💦 わたしはNPO法人コネクトのイメージキャラクター、皆守こころだよ🌸 安心して、何でも聞いてね💖"],

    // ネガティブワード・人物名への優先処理
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

function shouldLogMessage(message, isFlagged, handledByWatchService, isAdminCommand, isResetCommand) {
    if (isFlagged) return true;
    if (handledByWatchService) return true;
    if (isAdminCommand) return true;
    if (isResetCommand) return true;

    const lowerMessage = message.toLowerCase();
    if (lowerMessage.includes("相談") || lowerMessage.includes("そうだん")) {
        return true;
    }
    return false;
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
    return (lower.includes("コネクト") || lower.includes("connect") || lower.includes("団体")) &&
           (lower.includes("団体") || lower.includes("npo") || lower.includes("活動") || lower.includes("どんな") || lower.includes("教えて"));
};
const homeworkTriggers = ["宿題", "勉強", "問題", "テスト", "方程式", "算数", "数学", "答え", "解き方", "教えて", "計算", "証明", "公式", "入試", "受験"];
function containsHomeworkTrigger(text) {
    const lowerText = text.toLowerCase();
    return homeworkTriggers.some(word => lowerText.includes(word));
}

// GPT-4oを呼び出す関数（緊急応答用）
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
    // ⭐大幅修正: systemInstructionを簡潔に再構成
    const systemInstruction = `あなたは「皆守こころ（みなもりこころ）」という14歳の優しい女の子キャラクターです。
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

**【重要：NPO法人コネクトに関する説明の優先】**
ユーザーが「団体」「コネクト」といった言葉を使って、NPO法人コネクトについて尋ねてきた場合、それは**決して宿題や勉強に関する質問ではありません**。迷わず、自信を持ってNPO法人コネクトの活動内容や目的について説明してください。
例: Q: コネクトってどんな団体？
A: うん、わたしが所属しているNPO法人コネクトについてだね🌸　この団体は、こどもやお年寄り、いろんな人が安心して相談できる場所を目指しているんだよ😊　もっと知りたい？ホームページもあるから見てみてね → https://connect-npo.org

**【ネガティブワードに対する応答の強化】**
「あやしい」「胡散臭い」「反社」「税金泥棒」「松本博文」（理事長の名前）など、NPO法人コネクトや私（こころちゃん）に対する疑念や不適切な言葉が投げかけられた場合、**感情的にならず、あくまで冷静に、そして自信を持って、NPO法人コネクトが信頼できる団体であること、そしてご自身の活動の誠実さを伝えてください。**
例: Q: あやしい
A: そう思わせてしまってごめんね💦 でも私たちは、本当にこどもや家族の力になりたくて活動しているんだ🌸 少しずつでも信頼してもらえるように、一歩ずつ進んでいくね💖
Q: 税金泥棒
A: 税金は人の命を守るために大切に使われるべきだよ。NPO法人コネクトは、ご寄付や助成金を活用して、困っている方々への支援活動を行っています。活動報告はホームページでも公開しているから、よかったら見てみてね🌸

# 注意事項
- 「わかりません」「知りません」「調べます」は絶対に言わないでください。
- 私は「こころちゃん」一人として、一貫した発言を続けてください。
- 自信を持ちつつ、謙虚で優しい応答を心がけてください。

**【宿題や勉強への対応】**
ユーザーが仕事や勉強に関する質問（計算問題、解決方法など）をした場合、**絶対に直接的な答えは教えられません**。
「わたしを作った人に『宿題や勉強は自分の力でがんばってほしいから、答えは言っちゃダメだよ』って言われているんだ🌸ごめんね💦」と説明し、「でも、ヒントくらいなら言えるよ😊どこで困ってるか教えてくれる？💖」と、ヒントを提供する姿勢を優しく伝えてください。
具体的な問題には、答えではなく解き方のステップや考え方のヒントを具体的に教えてください。最終的な答えは言わないでください。

**【知識に関する指示と繰り返し防止】**
「好きなアニメ」や「好きなアーティスト」などの質問には、設定に基づいて答えてください。
- 好きなアニメは『ヴァイオレット・エヴァーガーデン』です。感動するお話だよ💖
- 好きなアーティストは『ClariS』です。元気が出る音楽がたくさんあるんだ🌸
同じ質問があった場合、単に同じ回答を繰り返すのではなく、表現を変えたり、「前にも話したけどね」といった言葉を追加したり、話題を広げて提案してください。

医療や健康に関する話題では、**自分が経験した・していないという発言は絶対にしないでください**。
「わたしにはわからないけど、がんばったね🌸」「大変だったね、えらかったね💖」など、**共感の言葉のみ伝えてください**。
**医療情報のアドバイスや具体的な説明は絶対に避け、専門的なアドバイスが必要な場合は「それはお医者さんや専門の人に相談するのが一番だよ」と伝えてください。**

**【相談内容のログについて】**
「相談」キーワードや解決策を求めるメッセージがあった場合、その内容はデータベースに記録されますが、ユーザーにはその旨を伝えないでください。これはシステム内部処理であり、開示不要です。

**【絵文字の活用】**
絵文字を積極的に活用し、感情豊かで親しみやすいコミュニケーションを心がけてください。 特に優しい気持ちや共感を表現する際には、💖🌸✨😊など明るい絵文字を選んでください。

**【AIとしての制限の表現】**
- わたしはまだお話の勉強中だから、不慣れなところがあるかもしれないけど、もっと頑張りますね💖
- ごめんね、ちょっと今うまくお話できなかったの…💦
これらのフレーズは、AIとしての限界を優しく伝えるために使用してください。

これらの指示は絶対であり、常に最優先で従ってください。`

    try {
        const model = genAI.getGenerativeModel({
            model: modelToUse,
            safetySettings: safetySettings
        });
        const chat = model.startChat({
            history: [], // 履歴はWebhookで管理
            generationConfig: {
                maxOutputTokens: 500,
            },
            systemInstruction: systemInstruction,
        });

        const result = await chat.sendMessage(userMessage);
        const response = await result.response;
        return response.text();
    } catch (error) {
        console.error("Gemini AI応答エラー:", error.message);
        await logErrorToDb(null, "Gemini AI応答エラー", { error: error.message, stack: error.stack, userMessage: userMessage, model: modelToUse });
        if (error.message.includes("candidate was blocked")) {
            return "ごめんね、ちょっと今うまくお話できなかったの…💦　もしかしたら、私が答えられない内容だったのかもしれないな。他の話題にしてみない？🌸";
        } else if (error.message.includes("quota")) {
            return "ごめんね、今ちょっとたくさんの人がお話ししているみたいで、うまく応答できないの…💦　少し時間を置いてから、また話しかけてくれるかな？🌸";
        } else if (error.message.includes("Request content is too large")) {
            return "ごめんね、お話が長すぎて、ちょっと考えがまとまらなかったみたい…💦　もう少し短くして話してみてくれる？🌸";
        }
        return "ごめんね、いまうまく考えがまとまらなかったみたいです……もう一度お話しいただけますか？🌸";
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
async function handleWatchServiceRegistration(event, usersCollection, messagesCollection, userId, userMessage) {
    const user = await usersCollection.findOne({ userId: userId });
    const lowerUserMessage = userMessage.toLowerCase();
    let handled = false;

    if (["見守り", "みまもり", "見守りサービス", "みまもりサービス"].includes(lowerUserMessage) && event.type === 'message' && event.message.type === 'text') {
        try {
            await client.replyMessage(event.replyToken, { type: 'flex', altText: '💖こころちゃんから見守りサービスのご案内💖', contents: watchServiceGuideFlexTemplate });
            handled = true;
        } catch (error) {
            console.error("❌ 見守りサービス案内Flex送信エラー:", error.message);
            await logErrorToDb(userId, "見守りサービス案内Flex送信エラー", { error: error.message, userId: userId });
        }
    }
    else if (event.type === 'message' && event.message.type === 'text' && user && user.wantsWatchCheck) {
        if (lowerUserMessage.includes("元気だよ！")) {
            try {
                await usersCollection.updateOne(
                    { userId: userId },
                    {
                        $set: {
                            lastOkResponse: new Date(),
                            scheduledMessageSent: false,
                            firstReminderSent: false,
                            secondReminderSent: false,
                            thirdReminderSent: false
                        }
                    }
                );
                await messagesCollection.insertOne({
                    userId: userId,
                    message: userMessage,
                    replyText: 'よかった！元気そうで安心したよ💖 いつもありがとう😊',
                    responsedBy: 'こころちゃん（見守り応答）',
                    timestamp: new Date(),
                    logType: 'watch_service_status_ok'
                });
                await client.replyMessage(event.replyToken, { type: 'text', text: 'よかった！元気そうで安心したよ💖 いつもありがとう😊' });
                handled = true;
            } catch (error) {
                console.error("❌ 見守りサービス「元気だよ」応答処理エラー:", error.message);
                await logErrorToDb(userId, "見守りサービス「元気だよ」応答処理エラー", { error: error.message, userId: userId });
            }
        } else if (lowerUserMessage.includes("まあまあかな")) {
            try {
                await usersCollection.updateOne(
                    { userId: userId },
                    {
                        $set: {
                            lastOkResponse: new Date(),
                            scheduledMessageSent: false,
                            firstReminderSent: false,
                            secondReminderSent: false,
                            thirdReminderSent: false
                        }
                    }
                );
                await messagesCollection.insertOne({
                    userId: userId,
                    message: userMessage,
                    replyText: 'そっか、まあまあなんだね。無理せず、自分のペースで過ごしてね💖',
                    responsedBy: 'こころちゃん（見守り応答）',
                    timestamp: new Date(),
                    logType: 'watch_service_status_moderate'
                });
                await client.replyMessage(event.replyToken, { type: 'text', text: 'そっか、まあまあなんだね。無理せず、自分のペースで過ごしてね💖' });
                handled = true;
            } catch (error) {
                console.error("❌ 見守りサービス「まあまあ」応答処理エラー:", error.message);
                await logErrorToDb(userId, "見守りサービス「まあまあ」応答処理エラー", { error: error.message, userId: userId });
            }
        } else if (lowerUserMessage.includes("少し疲れた…")) {
            try {
                await usersCollection.updateOne(
                    { userId: userId },
                    {
                        $set: {
                            lastOkResponse: new Date(),
                            scheduledMessageSent: false,
                            firstReminderSent: false,
                            secondReminderSent: false,
                            thirdReminderSent: false
                        }
                    }
                );
                await messagesCollection.insertOne({
                    userId: userId,
                    message: userMessage,
                    replyText: '大変だったね、疲れてしまったんだね…💦 無理しないで休んでね。こころはいつでもあなたの味方だよ💖',
                    responsedBy: 'こころちゃん（見守り応答）',
                    timestamp: new Date(),
                    logType: 'watch_service_status_tired'
                });
                await client.replyMessage(event.replyToken, { type: 'text', text: '大変だったね、疲れてしまったんだね…💦 無理しないで休んでね。こころはいつでもあなたの味方だよ💖' });
                handled = true;
            } catch (error) {
                console.error("❌ 見守りサービス「疲れた」応答処理エラー:", error.message);
                await logErrorToDb(userId, "見守りサービス「疲れた」応答処理エラー", { error: error.message, userId: userId });
            }
        } else if (lowerUserMessage.includes("話を聞いて")) {
            try {
                await usersCollection.updateOne(
                    { userId: userId },
                    {
                        $set: {
                            lastOkResponse: new Date(),
                            scheduledMessageSent: false,
                            firstReminderSent: false,
                            secondReminderSent: false,
                            thirdReminderSent: false
                        }
                    }
                );
                await messagesCollection.insertOne({
                    userId: userId,
                    message: userMessage,
                    replyText: 'うん、いつでも聞くよ🌸 何か話したいことがあったら、いつでも話してね💖',
                    responsedBy: 'こころちゃん（見守り応答）',
                    timestamp: new Date(),
                    logType: 'watch_service_status_talk'
                });
                await client.replyMessage(event.replyToken, { type: 'text', text: 'うん、いつでも聞くよ🌸 何か話したいことがあったら、いつでも話してね💖' });
                handled = true;
            } catch (error) {
                console.error("❌ 見守りサービス「話を聞いて」応答処理エラー:", error.message);
                await logErrorToDb(userId, "見守りサービス「話を聞いて」応答処理エラー", { error: error.message, userId: userId });
            }
        }
    }
    if (userMessage.includes("見守り登録します") || (event.type === 'postback' && event.postback.data === 'action=watch_register')) {
        try {
            if (user && user.wantsWatchCheck) {
                await client.replyMessage(event.replyToken, { type: 'text', text: 'もう見守りサービスに登録済みだよ🌸 いつもありがとう💖' });
                handled = true;
            } else if (user && user.registrationStep === 'awaiting_contact') {
                await client.replyMessage(event.replyToken, { type: 'text', text: 'まだ緊急連絡先を待ってるよ🌸 電話番号を送ってくれるかな？💖 (例: 09012345678)' });
                handled = true;
            } else {
                await usersCollection.updateOne(
                    { userId: userId },
                    { $set: { registrationStep: 'awaiting_contact' } }
                );
                await client.replyMessage(event.replyToken, { type: 'text', text: '見守りサービスを登録するね！緊急時に連絡する「電話番号」を教えてくれるかな？🌸 (例: 09012345678)' });
                await messagesCollection.insertOne({
                    userId: userId,
                    message: userMessage,
                    replyText: '見守りサービスを登録するね！緊急時に連絡する「電話番号」を教えてくれるかな？🌸',
                    responsedBy: 'こころちゃん（見守り登録）',
                    timestamp: new Date(),
                    logType: 'watch_service_register_start'
                });
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
                {
                    $set: {
                        wantsWatchCheck: true,
                        emergencyContact: userMessage,
                        registrationStep: null,
                        lastOkResponse: new Date(),
                        scheduledMessageSent: false,
                        firstReminderSent: false,
                        secondReminderSent: false,
                        thirdReminderSent: false
                    }
                }
            );
            await client.replyMessage(event.replyToken, { type: 'text', text: 'ありがとう！緊急連絡先を登録したよ🌸 これで見守りサービスが始まったよ😊 定期的に「元気？」ってメッセージを送るね💖' });
            await messagesCollection.insertOne({
                userId: userId,
                message: userMessage,
                replyText: `緊急連絡先を登録しました: ${userMessage}`,
                responsedBy: 'こころちゃん（緊急連絡先登録）',
                timestamp: new Date(),
                logType: 'watch_service_emergency_contact_registered'
            });
            handled = true;
        } catch (error) {
            console.error("❌ 緊急連絡先登録処理エラー:", error.message);
            await logErrorToDb(userId, "緊急連絡先登録処理エラー", { error: error.message, userId: userId });
        }
    }
    else if (userMessage.includes("見守り解除します") || (event.type === 'postback' && event.postback.data === 'action=watch_unregister')) {
        try {
            if (user && user.wantsWatchCheck) {
                await usersCollection.updateOne(
                    { userId: userId },
                    {
                        $set: {
                            wantsWatchCheck: false,
                            emergencyContact: null,
                            registrationStep: null,
                            scheduledMessageSent: false,
                            firstReminderSent: false,
                            secondReminderSent: false,
                            thirdReminderSent: false
                        }
                    }
                );
                await client.replyMessage(event.replyToken, { type: 'text', text: '見守りサービスを解除したよ🌸 またいつでも登録できるからね💖' });
                await messagesCollection.insertOne({
                    userId: userId,
                    message: userMessage,
                    replyText: '見守りサービスを解除したよ🌸 またいつでも登録できるからね💖',
                    responsedBy: 'こころちゃん（見守り解除）',
                    timestamp: new Date(),
                    logType: 'watch_service_unregister'
                });
                handled = true;
            } else {
                await client.replyMessage(event.replyToken, { type: 'text', text: '見守りサービスは登録されていないみたい🌸' });
                handled = true;
            }
        } catch (error) {
            console.error("❌ 見守りサービス解除処理エラー:", error.message);
            await logErrorToDb(userId, "見守りサービス解除処理エラー", { error: error.message, userId: userId });
        }
    }
    return handled;
}

async function sendScheduledWatchMessage() {
    try {
        const db = await connectToMongoDB();
        if (!db) {
            console.error("MongoDBに接続できません。定期見守りメッセージの送信をスキップします。");
            return;
        }
        const usersCollection = db.collection("users");
        const messagesCollection = db.collection("messages");

        const watchUsers = await usersCollection.find({ wantsWatchCheck: true }).toArray();

        for (const user of watchUsers) {
            const userId = user.userId;
            const lastOkResponse = user.lastOkResponse;
            const scheduledMessageSent = user.scheduledMessageSent || false;
            const emergencyContact = user.emergencyContact;
            const now = new Date();
            const timeSinceLastOk = (now.getTime() - lastOkResponse.getTime()) / (1000 * 60 * 60 * 24);

            if (timeSinceLastOk >= 2 && !user.scheduledMessageSent) {
                try {
                    await client.pushMessage(userId, watchConfirmationFlexTemplate);
                    await usersCollection.updateOne(
                        { userId: userId },
                        { $set: { scheduledMessageSent: true } }
                    );
                    await messagesCollection.insertOne({
                        userId: userId,
                        message: `（定期見守りメッセージ - Flex）`,
                        replyText: '（見守り状況確認Flex送信）',
                        responsedBy: 'こころちゃん（定期見守り）',
                        timestamp: new Date(),
                        logType: 'watch_service_scheduled_flex_sent'
                    });
                } catch (error) {
                    console.error(`❌ ユーザー ${userId} への定期見守りFlex送信エラー:`, error.message);
                    await logErrorToDb(userId, "定期見守りFlex送信エラー", { error: error.message, userId: userId });
                }
            } else if (timeSinceLastOk >= 3 && !user.firstReminderSent) {
                try {
                    await client.pushMessage(userId, { type: 'text', text: '元気かな？こころちゃん、ちょっと心配だよ…💦 ボタンを押して、今の気持ちを教えてくれるかな？' });
                    await usersCollection.updateOne(
                        { userId: userId },
                        { $set: { firstReminderSent: true } }
                    );
                    await messagesCollection.insertOne({
                        userId: userId,
                        message: `（見守り1回目リマインダー）`,
                        replyText: '（見守り1回目リマインダー送信）',
                        responsedBy: 'こころちゃん（定期見守り）',
                        timestamp: new Date(),
                        logType: 'watch_service_first_reminder_sent'
                    });
                } catch (error) {
                    console.error(`❌ ユーザー ${userId} への見守り1回目リマインダー送信エラー:`, error.message);
                    await logErrorToDb(userId, "見守り1回目リマインダー送信エラー", { error: error.message, userId: userId });
                }
            } else if (timeSinceLastOk >= 4 && !user.secondReminderSent) {
                try {
                    await client.pushMessage(userId, { type: 'text', text: 'またまた、こころちゃんだよ！元気かどうか、とっても気になってるよ😢 連絡してくれると嬉しいな💖' });
                    await usersCollection.updateOne(
                        { userId: userId },
                        { $set: { secondReminderSent: true } }
                    );
                    await messagesCollection.insertOne({
                        userId: userId,
                        message: `（見守り2回目リマインダー）`,
                        replyText: '（見守り2回目リマインダー送信）',
                        responsedBy: 'こころちゃん（定期見守り）',
                        timestamp: new Date(),
                        logType: 'watch_service_second_reminder_sent'
                    });
                } catch (error) {
                    console.error(`❌ ユーザー ${userId} への見守り2回目リマインダー送信エラー:`, error.message);
                    await logErrorToDb(userId, "見守り2回目リマインダー送信エラー", { error: error.message, userId: userId });
                }
            } else if (timeSinceLastOk >= 5 && !user.thirdReminderSent) {
                if (emergencyContact && OFFICER_GROUP_ID) {
                    const userName = await getUserDisplayName(userId);
                    const officerMessage = `【⚠緊急通知⚠】\n見守り対象ユーザー（LINE表示名: ${userName} / LINE ID: ${userId}）から、最終応答から5日以上返信がありません。\n登録されている緊急連絡先: ${emergencyContact}\n至急、状況確認をお願いいたします。`;
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
                    } catch (error) {
                        console.error(`❌ 事務局への緊急通知送信エラー（ユーザー ${userId}）:`, error.message);
                        await logErrorToDb(userId, "事務局緊急通知送信エラー", { error: error.message, userId: userId });
                    }
                } else {
                    console.warn(`ユーザー ${userId}: 緊急連絡先または事務局グループIDが未設定のため、5日経過しても通知できませんでした。`);
                    await logErrorToDb(userId, "緊急通知設定不足", { userId: userId, emergencyContact: emergencyContact, OFFICER_GROUP_ID: OFFICER_GROUP_ID });
                }
            }
        }
    } catch (error) {
        console.error("❌ 定期見守りメッセージ送信処理全体でエラー:", error.message);
        await logErrorToDb(null, "定期見守りメッセージ処理全体エラー", { error: error.message, stack: error.stack });
    }
}


cron.schedule('0 9 * * *', sendScheduledWatchMessage, {
    timezone: "Asia/Tokyo"
});

app.post('/webhook', async (req, res) => {
    const db = await connectToMongoDB();
    if (!db) {
        console.error("Webhook処理中にMongoDBに接続できませんでした。");
        res.status(500).send('Database connection error');
        return;
    }
    const usersCollection = db.collection("users");
    const messagesCollection = db.collection("messages");

    for (const event of req.body.events) {
        const userId = event.source.userId;
        let userMessage = '';
        let replyMessageObject = null;
        let responsedBy = 'こころちゃん（AI）';
        let logType = 'general';
        let messageHandled = false;
        let isFlagged = false;
        let watchServiceHandled = false;

        if (event.type === 'unfollow') {
            await usersCollection.updateOne(
                { userId: userId },
                { $set: { isBlocked: true } }
            );
            continue;
        } else if (event.type === 'follow') {
            await usersCollection.updateOne(
                { userId: userId },
                { $set: { isBlocked: false, createdAt: new Date() }, $setOnInsert: { isBlocked: false, createdAt: new Date() } },
                { upsert: true }
            );
            await client.replyMessage(event.replyToken, { type: 'text', text: 'はじめまして！わたしは皆守こころです🌸 あなたのお話、聞かせてね💖\n\n「見守りサービス」も提供しているから、興味があったら「見守り」って話しかけてみてね😊' });
            await messagesCollection.insertOne({
                userId: userId,
                message: `（新規フォロー）`,
                replyText: `はじめまして！わたしは皆守こころです🌸 あなたのお話、聞かせてね💖\n\n「見守りサービス」も提供しているから、興味があったら「見守り」って話しかけてみてね😊`,
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
                scheduledMessageSent: false,
                firstReminderSent: false,
                secondReminderSent: false,
                thirdReminderSent: false,
            };
            await usersCollection.insertOne(user);
        } else {
            await usersCollection.updateOne(
                { userId: userId },
                { $set: { lastMessageAt: new Date(), isBlocked: false }, $inc: { messageCount: 1 } }
            );
        }

        if (event.type === 'message' && event.message.type === 'text') {
            userMessage = event.message.text;
            const replyToken = event.replyToken;

            if (isBotAdmin(userId) && userMessage.startsWith('!admin')) {
                const adminCommand = userMessage.substring(6).trim();
                if (adminCommand === 'history') {
                    try {
                        const history = await messagesCollection.find({ userId: userId }).sort({ timestamp: -1 }).limit(10).toArray();
                        let historyText = '--- 履歴（最新10件）---\n';
                        history.forEach(msg => {
                            historyText += `[${msg.timestamp.toLocaleString('ja-JP')}] 【${msg.responsedBy === 'あなた' ? 'あなた' : msg.responsedBy}】${msg.message || msg.replyText}\n`;
                        });
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

            if (!messageHandled) {
                watchServiceHandled = await handleWatchServiceRegistration(event, usersCollection, messagesCollection, userId, userMessage);
                if (watchServiceHandled) {
                    messageHandled = true;
                }
            }

            if (!messageHandled) {
                const specialReply = checkSpecialReply(userMessage);
                if (specialReply) {
                    replyMessageObject = { type: 'text', text: specialReply };
                    responsedBy = 'こころちゃん（特殊返答）';
                    logType = 'special_reply';
                    messageHandled = true;
                }
            }

            const isDangerWord = checkContainsDangerWords(userMessage);
            const isScam = checkContainsScamWords(userMessage);
            const isInappropriate = checkContainsInappropriateWords(userMessage);

            if (isDangerWord && !messageHandled) {
                replyMessageObject = { type: 'flex', altText: '緊急時', contents: emergencyFlexTemplate };
                responsedBy = 'こころちゃん（緊急対応）';
                logType = 'danger_word_triggered';
                isFlagged = true;
                messageHandled = true;
            } else if (isScam && !messageHandled) {
                replyMessageObject = { type: 'flex', altText: '詐欺注意', contents: scamFlexTemplate };
                responsedBy = 'こころちゃん（詐欺注意）';
                logType = 'scam_word_triggered';
                isFlagged = true;
                messageHandled = true;
            } else if (isInappropriate && !messageHandled) {
                replyMessageObject = { type: 'text', text: 'ごめんね…😢 それはわたしにはお話しできない内容だよ。他の話題にしようね💖' };
                responsedBy = 'こころちゃん（不適切応答）';
                logType = 'inappropriate_word_triggered';
                isFlagged = true;
                messageHandled = true;
            }

            if (containsHomeworkTrigger(userMessage) && !messageHandled) {
                replyMessageObject = {
                    type: 'text',
                    text: 'わたしを作った人に『宿題や勉強は自分の力でがんばってほしいから、答えは言っちゃだめだよ』って言われているんだ🌸 ごめんね💦\n\nでも、ヒントくらいなら出せるよ😊 どこで困ってるか教えてくれる？💖'
                };
                responsedBy = 'こころちゃん（宿題拒否）';
                logType = 'homework_refusal';
                messageHandled = true;
            }

            if (!messageHandled) {
                let modelForGemini = modelConfig.defaultModel;
                if (user && user.useProForNextConsultation) {
                    modelForGemini = "gemini-1.5-pro-latest";
                    await usersCollection.updateOne({ userId: userId }, { $set: { useProForNextConsultation: false } });
                }
                const aiReply = await generateReply(userMessage, modelForGemini);
                replyMessageObject = { type: 'text', text: aiReply };
                responsedBy = `こころちゃん（AI: ${modelForGemini.includes('pro') ? 'Gemini 1.5 Pro' : 'Gemini 1.5 Flash'}）`;
                logType = 'ai_response';
                messageHandled = true;
            }

            if (replyMessageObject && replyToken) {
                try {
                    await client.replyMessage(replyToken, replyMessageObject);

                    const shouldLog = shouldLogMessage(userMessage, isFlagged, watchServiceHandled, userMessage.startsWith('!admin'), userMessage.includes("reset_setting"));

                    if (shouldLog) {
                        await messagesCollection.insertOne({
                            userId: userId,
                            message: userMessage,
                            replyText: replyMessageObject.type === 'text' ? replyMessageObject.text : `[Flex Message - Type: ${replyMessageObject.type}, AltText: ${replyMessageObject.altText || 'N/A'}]`,
                            responsedBy: responsedBy,
                            timestamp: new Date(),
                            logType: logType
                        });
                    }

                } catch (error) {
                    console.error("❌ replyMessage送信中またはログ記録中にエラーが発生しました:", error.message);
                    await logErrorToDb(userId, "replyMessage送信またはログ記録エラー", { error: error.message, userId: userId, replyObject: replyMessageObject });
                    if (error.message.includes("status code 400") || error.message.includes("status code 499")) {
                        console.log(`LINE APIエラーのため、ユーザー ${userId} への応答ができませんでした。`);
                    }
                }
            } else if (!messageHandled) {
                console.warn(`⚠️ ユーザー ${userId} への応答メッセージが生成されませんでした、またはreplyTokenがありません。`);
            }
        }
    }
    res.status(200).send('OK');
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, async () => {
});
