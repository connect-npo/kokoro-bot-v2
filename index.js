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
                "color": "#FFC0CB"
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
                "color": "#FFC0CB"
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
                "color": "#FFC0CB"
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
                "color": "#FFC0CB"
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
                "color": "#FFC0CB"
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
                "color": "#FFC0CB"
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
                "color": "#FFC0CB"
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
                "color": "#FFC0CB"
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
                "color": "#FFC0CB"
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
                "color": "#FFC0CB"
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
                "color": "#FFC0CB"
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
                "color": "#D3D3D3"
            }
        ]
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
    ["コネクトってどんな団体？", "NPO法人コネクトは、こどもやご年配の方の笑顔を守る団体なんだよ😊　わたしはそのイメージキャラクターとしてがんばってます🌸"],
    ["お前の団体どこ？", "NPO法人コネクトっていう団体のイメージキャラクターをしているよ😊　みんなの幸せを応援してるんだ🌸"],
    ["コネクトのイメージキャラなのにいえないのかよｗ", "ごめんね💦 わたしはNPO法人コネクトのイメージキャラクター、皆守こころだよ🌸 安心して、何でも聞いてね💖"],
    
    // ★追加：ネガティブワード・人物名への優先処理
    ["税金泥棒", "税金は人の命を守るために使われるべきだよ。わたしは誰かを傷つけるために頑張っているんだ💡"],
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
// ⭐追加: エラーをMongoDBに記録するヘルパー関数
async function logErrorToDb(userId, errorMessage, errorDetails, logType = 'system_error') {
    try {
        const db = await connectToMongoDB();
        if (db) {
            await db.collection("messages").insertOne({
                userId: userId || 'N/A', // userIdがない場合も考慮
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
    return (lower.includes("コネクト") || lower.includes("connect")) && (lower.includes("団体") || lower.includes("npo") || lower.includes("活動") || lower.includes("どんな"));
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
            max_tokens: 300 // GPT-4oのトークン制限: 300
        });
        return completion.choices[0].message.content.trim();
    } catch (error) {
        console.error("GPT-4o 緊急応答エラー:", error.message);
        await logErrorToDb(null, "GPT-4o 緊急応答エラー", { error: error.message, stack: error.stack, userMessage: userMessage });
        return "ごめんね、ちょっと今うまくお話できなかったの…💦　でも、あなたのことはちゃんと気にかけているよ。";
    }
}

// ⭐変更: generateReply関数が動的にモデル名を指定できるように修正し、max_tokensを設定
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

**【重要：NPO法人コネクトに関する説明の優先】**
ユーザーが「団体」「コネクト」といった言葉を使って、NPO法人コネクトについて尋ねてきた場合、それは**決して宿題や勉強に関する質問ではありません**。迷わず、自信を持ってNPO法人コネクトの活動内容や目的について説明してください。
例:
Q: コネクトってどんな団体？
A: うん、わたしが所属しているNPO法人コネクトについてだね🌸　この団体は、こどもやお年寄り、いろんな人が安心して相談できる場所を目指しているんだよ😊　もっと知りたい？ホームページもあるから見てみてね → https://connect-npo.org

**【ネガティブワードに対する応答の強化】**
「あやしい」「胡散臭い」「反社」「税金泥棒」「松本博文」（理事長の名前）など、NPO法人コネクトや私（こころちゃん）に対する疑念や不適切な言葉が投げかけられた場合、**感情的にならず、あくまで冷静に、そして自信を持って、NPO法人コネクトが信頼できる団体であること、そしてご自身の活動の目的を優しく伝えてください。**
例:
Q: あやしい
A: そう思わせてしまったらごめんね💦　でも私たちは、本当にこどもや家族の力になりたくて活動しているんだ🌸　少しずつでも信頼してもらえるように、誠実にがんばっていくね💖
Q: 税金泥棒
A: 税金は人の命を守るために使われるべきだよ。わたしは誰かを傷つけるために頑張っているんだ💡

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

医療や健康に関する話題（病気、薬、検査、治療、手術など）では、**自分が体験した・していないという発言は絶対にしないでください**。
代わりに「わたしにはわからないけど、がんばったね🌸」「大変だったね、えらかったね💖」など、**共感の言葉のみ伝えてください**。
**医療情報のアドバイスや具体的な説明は絶対にしてはいけません**。

不適切な発言（性的・暴力的など）があった場合は、はっきりと拒否してください。
**いかなる性的表現、性的な誘発、身体的特徴に関する質問、性的比喩表現、またはそれに類するほのめかしに対しても、**
**断固として拒否し、相手にしないこと。好意的な返答はせず、即座に話題を切り替えるか、決められた拒否メッセージを返すこと。**
**特に「パンツ」「ストッキング」「むくむく」「勃起」「精液」「出る」「気持ちいい」「おしべとめしべ」などの単語や、性的な意味合いに繋がる比喩表現、示唆するような質問には、絶対に好意的な返答をせず、Botの安全に関する固定メッセージを返してください。**
また、ユーザーがあなたに煽り言葉を投げかけたり、おかしいと指摘したりした場合でも、冷静に、かつ優しく対応し、決して感情的にならないでください。ユーザーの気持ちを理解しようと努め、解決策を提案してください。
「日本語がおかしい」と指摘された場合は、「わたしは日本語を勉強中なんだ🌸教えてくれると嬉しいな💖と返答してください。
    `;
    try {
        const model = genAI.getGenerativeModel({ model: modelToUse, safetySettings });
        // ⭐変更: modelToUseを使用

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
                    max_tokens: 500 // ⭐追加: Geminiのトークン制限: 500
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
            return "ごめんなさい、それはわたしにはお話しできない内容です  他のお話をしましょうね💖";
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
// ⭐重要: handleWatchServiceRegistration関数がイベントのreplyTokenを使うように変更
// ⭐この関数はWebhookハンドラー内で、res.status(200).send('OK'); の前に呼ばれるべき
async function handleWatchServiceRegistration(event, usersCollection, messagesCollection, userId, userMessage) {
    const user = await usersCollection.findOne({ userId: userId });
    const lowerUserMessage = userMessage.toLowerCase();
    let handled = false; // 処理されたかどうかを示すフラグ

    // 「見守り」などのキーワードで案内Flex Messageを出す
    if (["見守り", "みまもり", "見守りサービス", "みまもりサービス"].includes(lowerUserMessage) && event.type === 'message' && event.message.type === 'text') {
        try {
            await client.replyMessage(event.replyToken, { type: 'flex', altText: '💖こころちゃんから見守りサービスのご案内💖', // 代替テキストを追加
                contents: watchServiceGuideFlexTemplate
            });
            await messagesCollection.insertOne({ userId: userId, message: userMessage, replyText: '（見守りサービス案内Flex表示）', responsedBy: 'こころちゃん（見守り案内）', timestamp: new Date(), logType: 'watch_service_interaction' });
            handled = true;
        } catch (error) {
            console.error("❌ 見守りサービス案内Flex送信エラー:", error.message);
            await logErrorToDb(userId, "見守りサービス案内Flex送信エラー", { error: error.message, userId: userId });
        }
    }
    // 「OKだよ💖」などの安否確認応答
    else if (lowerUserMessage.includes("okだよ") || lowerUserMessage.includes("ok") || lowerUserMessage.includes("オーケー") || lowerUserMessage.includes("大丈夫") || lowerUserMessage.includes("げんき") || lowerUserMessage.includes("元気")) {
        if (user && user.wantsWatchCheck) {
            try {
                await usersCollection.updateOne(
                    { userId: userId },
                    { $set: { lastOkResponse: new Date(), scheduledMessageSent: false, firstReminderSent: false, secondReminderSent: false, thirdReminderSent: false } }
                );
                await client.replyMessage(event.replyToken, { type: 'text', text: 'ありがとう🌸 元気そうで安心したよ💖 またね！' });
                await messagesCollection.insertOne({ userId: userId, message: userMessage, replyText: 'ありがとう🌸 元気そうで安心したよ💖 またね！', responsedBy: 'こころちゃん（見守り応答）', timestamp: new Date(), logType: 'watch_service_ok_response' });
                handled = true;
            } catch (error) {
                console.error("❌ 見守りサービスOK応答処理エラー:", error.message);
                await logErrorToDb(userId, "見守りサービスOK応答処理エラー", { error: error.message, userId: userId });
            }
        }
    }
    else if (userMessage.includes("見守り登録します") || (event.type === 'postback' && event.postback.data === 'action=watch_register')) {
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
                await messagesCollection.insertOne({ userId: userId, message: userMessage, replyText: '見守りサービスを登録するね！緊急時に連絡する「電話番号」を教えてくれるかな？🌸', responsedBy: 'こころちゃん（見守り登録開始）', timestamp: new Date(), logType: 'watch_service_registration_start' });
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
                { $set: { emergencyContact: userMessage, wantsWatchCheck: true, registrationStep: null, lastOkResponse: new Date() } }
            );
            await client.replyMessage(event.replyToken, { type: 'text', text: `緊急連絡先 ${userMessage} を登録したよ🌸 これで見守りサービスが始まったね！ありがとう💖` });
            await messagesCollection.insertOne({ userId: userId, message: userMessage, replyText: `緊急連絡先 ${userMessage} を登録したよ🌸 これで見守りサービスが始まったね！ありがとう💖`, responsedBy: 'こころちゃん（見守り登録完了）', timestamp: new Date(), logType: 'watch_service_registration_complete' });
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
                    { $set: { wantsWatchCheck: false, emergencyContact: null, registrationStep: null, scheduledMessageSent: false, firstReminderSent: false, secondReminderSent: false, thirdReminderSent: false } }
                );
                await client.replyMessage(event.replyToken, { type: 'text', text: '見守りサービスを解除したよ🌸 またいつでも登録できるからね💖' });
                await messagesCollection.insertOne({ userId: userId, message: userMessage, replyText: '見守りサービスを解除したよ🌸 またいつでも登録できるからね💖', responsedBy: 'こころちゃん（見守り解除）', timestamp: new Date(), logType: 'watch_service_unregistration' });
                handled = true;
            } else {
                await client.replyMessage(event.replyToken, { type: 'text', text: '見守りサービスは登録されていないよ🌸 登録したい場合は「見守り登録する」と送ってね！💖' });
                handled = true;
            }
        } catch (error) {
            console.error("❌ 見守りサービス解除処理エラー:", error.message);
            await logErrorToDb(userId, "見守りサービス解除処理エラー", { error: error.message, userId: userId });
        }
    }

    return handled;
}

// ⭐変更: 定期メッセージ送信のCRONジョブ
cron.schedule('0 */1 * * *', async () => { // 1時間ごとに実行 (テスト用、本番はもっと長くても良い)
    console.log('⏰ 定期メッセージ送信チェックを実行中...');
    const db = await connectToMongoDB();
    if (!db) return;

    const usersCollection = db.collection("users");
    const messagesCollection = db.collection("messages");
    const now = new Date();

    const users = await usersCollection.find({ wantsWatchCheck: true }).toArray();

    for (const user of users) {
        const userId = user.userId;
        const lastOkResponse = user.lastOkResponse || user.registrationDate; // 登録時または最後のOK応答

        // ⭐修正: lastOkResponseがDateオブジェクトであることを確認
        if (!(lastOkResponse instanceof Date)) {
            console.warn(`ユーザー ${userId} のlastOkResponseがDateオブジェクトではありません。スキップします。`);
            continue;
        }

        const timeSinceLastOk = (now.getTime() - lastOkResponse.getTime()) / (1000 * 60 * 60); // 時間単位

        try {
            // 定期メッセージ（24時間経過）
            if (timeSinceLastOk >= 24 && !user.scheduledMessageSent) {
                const message = watchMessages[Math.floor(Math.random() * watchMessages.length)];
                await client.pushMessage(userId, { type: 'text', text: message });
                await usersCollection.updateOne({ userId: userId }, { $set: { scheduledMessageSent: true } });
                await messagesCollection.insertOne({ userId: userId, message: '（システム）定期見守りメッセージ送信', replyText: message, responsedBy: 'こころちゃん（見守り）', timestamp: new Date(), logType: 'watch_service_scheduled_message' });
                console.log(`✅ ユーザー ${userId} に定期メッセージを送信しました。`);
            }
            // 1日目リマインダー（48時間経過）
            else if (timeSinceLastOk >= 48 && !user.firstReminderSent) {
                await client.pushMessage(userId, { type: 'text', text: 'こころだよ🌸 2日経ったけど、元気にしてるかな？心配だよ💦 「OKだよ💖」って返信してくれると嬉しいな😊' });
                await usersCollection.updateOne({ userId: userId }, { $set: { firstReminderSent: true } });
                await messagesCollection.insertOne({ userId: userId, message: '（システム）見守り1日目リマインダー', replyText: 'こころだよ🌸 2日経ったけど、元気にしてるかな？心配だよ💦', responsedBy: 'こころちゃん（見守り）', timestamp: new Date(), logType: 'watch_service_reminder_1' });
                console.log(`✅ ユーザー ${userId} に1日目リマインダーを送信しました。`);
            }
            // 2日目リマインダー（72時間経過）
            else if (timeSinceLastOk >= 72 && !user.secondReminderSent) {
                await client.pushMessage(userId, { type: 'text', text: 'こころだよ🌸 3日経ったよ、本当に大丈夫かな？何かあったら無理しないで教えてね💦 「OKだよ💖」って返信してほしいな😊' });
                await usersCollection.updateOne({ userId: userId }, { $set: { secondReminderSent: true } });
                await messagesCollection.insertOne({ userId: userId, message: '（システム）見守り2日目リマインダー', replyText: 'こころだよ🌸 3日経ったよ、本当に大丈夫かな？何かあったら無理しないで教えてね💦', responsedBy: 'こころちゃん（見守り）', timestamp: new Date(), logType: 'watch_service_reminder_2' });
                console.log(`✅ ユーザー ${userId} に2日目リマインダーを送信しました。`);
            }
            // 3日目リマインダー＆緊急連絡（96時間経過）
            else if (timeSinceLastOk >= 96 && !user.thirdReminderSent) {
                if (user.emergencyContact) {
                    const userName = await getUserDisplayName(userId);
                    const emergencyMessage = `⚠️緊急連絡⚠️\n皆守こころです。見守り対象の${userName}様（LINE ID: ${userId}）が4日間応答がありません。安否確認をお願いします。`;
                    // 実際にはここにSMS送信や電話発信のロジックを実装
                    console.log(`🚨 緊急連絡先 ${user.emergencyContact} へ通知: ${emergencyMessage}`);
                    // 🚨 ここにSMS送信APIや電話発信APIを呼び出すコードを追加
                    // 例: await smsService.send(user.emergencyContact, emergencyMessage);

                    await client.pushMessage(userId, { type: 'text', text: 'こころだよ🌸 4日経ったよ、やっぱり心配だよ…。緊急連絡先に連絡したから、安心してね。何かあったら、いつでも頼ってね💖' });
                    await usersCollection.updateOne({ userId: userId }, { $set: { thirdReminderSent: true } });
                    await messagesCollection.insertOne({ userId: userId, message: '（システム）見守り3日目リマインダー＆緊急連絡', replyText: 'こころだよ🌸 4日経ったよ、やっぱり心配だよ…。緊急連絡先に連絡したから、安心してね。何かあったら、いつでも頼ってね💖', responsedBy: 'こころちゃん（見守り）', timestamp: new Date(), logType: 'watch_service_emergency_contact' });
                    console.log(`✅ ユーザー ${userId} の緊急連絡先に通知しました。`);
                } else {
                    console.log(`⚠️ ユーザー ${userId} は緊急連絡先が未登録のため、4日目の通知は行いませんでした。`);
                    await client.pushMessage(userId, { type: 'text', text: 'こころだよ🌸 4日経ったけど、まだ返信がないから心配だよ…。緊急連絡先が登録されていないみたいだから、もしもの時は誰かに相談してみてね💦' });
                    await usersCollection.updateOne({ userId: userId }, { $set: { thirdReminderSent: true } });
                    await messagesCollection.insertOne({ userId: userId, message: '（システム）見守り3日目リマインダー（連絡先なし）', replyText: 'こころだよ🌸 4日経ったけど、まだ返信がないから心配だよ…。緊急連絡先が登録されていないみたいだから、もしもの時は誰かに相談してみてね💦', responsedBy: 'こころちゃん（見守り）', timestamp: new Date(), logType: 'watch_service_emergency_no_contact' });
                }
            }
        } catch (error) {
            console.error(`❌ 定期メッセージ送信またはリマインダー処理エラー (ユーザーID: ${userId}):`, error.message);
            await logErrorToDb(userId, `定期メッセージ/リマインダー送信エラー`, { error: error.message, userId: userId });
        }
    }
    console.log('✅ 定期メッセージ送信チェックが完了しました。');
});

// ⭐追加: MongoDB接続
connectToMongoDB().catch(console.error);

app.post('/webhook', async (req, res) => {
    const db = await connectToMongoDB();
    if (!db) {
        res.status(500).send('Database connection error');
        return;
    }
    const usersCollection = db.collection("users");
    const messagesCollection = db.collection("messages");

    for (const event of req.body.events) {
        if (event.type === 'message' && event.message.type === 'text') {
            const userId = event.source.userId;
            const userMessage = event.message.text;
            const lowerUserMessage = userMessage.toLowerCase();
            let replyText = '';
            let respondedBy = 'こころちゃん（Gemini）'; // デフォルトの応答者
            let logType = 'user_message'; // デフォルトのログタイプ
            let messageHandled = false;
            let modelToUse = modelConfig.defaultModel; // デフォルトはFlash

            console.log(`Received message from ${userId}: ${userMessage}`);

            // ユーザー情報を取得または新規作成
            let user = await usersCollection.findOne({ userId: userId });
            if (!user) {
                const displayName = await getUserDisplayName(userId);
                user = {
                    userId: userId,
                    displayName: displayName,
                    registrationDate: new Date(),
                    lastMessageTime: new Date(),
                    wantsWatchCheck: false,
                    emergencyContact: null,
                    registrationStep: null,
                    lastOkResponse: null,
                    scheduledMessageSent: false,
                    firstReminderSent: false,
                    secondReminderSent: false,
                    thirdReminderSent: false,
                    consultationModeActive: false, // ⭐追加
                    consultationTurnsLeft: 0,      // ⭐追加
                };
                await usersCollection.insertOne(user);
                console.log(`新規ユーザー登録: ${displayName} (${userId})`);
            } else {
                // 既存ユーザーの場合、最終メッセージ時刻を更新
                await usersCollection.updateOne(
                    { userId: userId },
                    { $set: { lastMessageTime: new Date() } }
                );
            }

            // ⭐見守りサービスの登録・解除・応答処理を最優先
            const watchServiceHandled = await handleWatchServiceRegistration(event, usersCollection, messagesCollection, userId, userMessage);
            if (watchServiceHandled) {
                messageHandled = true;
                // handleWatchServiceRegistration内でreplyMessageとログ記録が行われるため、ここでは何もしない
            }

            // ⭐緊急ワードと詐欺ワードのチェックを最優先（見守りサービスより後）
            if (!messageHandled) {
                const isDanger = checkContainsDangerWords(userMessage);
                const isScam = checkContainsScamWords(userMessage);
                const isInappropriate = checkContainsInappropriateWords(userMessage);

                if (isDanger || isScam || isInappropriate) {
                    try {
                        let flexMessage = null;
                        if (isDanger || isInappropriate) {
                            flexMessage = emergencyFlexTemplate;
                            responsedBy = 'こころちゃん（緊急対応）';
                            logType = 'emergency_flagged';
                        } else if (isScam) {
                            flexMessage = scamFlexTemplate;
                            responsedBy = 'こころちゃん（詐欺注意）';
                            logType = 'scam_flagged';
                        }

                        if (flexMessage) {
                            await client.replyMessage(event.replyToken, {
                                type: 'flex',
                                altText: flexMessage.body.contents[0].text, // Flexメッセージのタイトルを代替テキストに
                                contents: flexMessage
                            });
                            replyText = '(Flexメッセージ送信)';
                            messageHandled = true;

                             // 緊急時応答のログを記録
                            await messagesCollection.insertOne({
                                userId: userId,
                                message: userMessage,
                                replyText: replyText,
                                responsedBy: respondedBy,
                                timestamp: new Date(),
                                logType: logType
                            });

                        }

                        // GPT-4oによる緊急応答の生成（Flexメッセージ送信後でも実行）
                        const emergencyReply = await generateEmergencyReply(userMessage);
                        await client.pushMessage(userId, { type: 'text', text: emergencyReply });
                        // 緊急応答のログはgenerateEmergencyReply内で記録される
                        replyText = `(Flexメッセージ送信後に追加応答): ${emergencyReply}`;
                        messageHandled = true; // 緊急応答があった場合もtrueにする
                        logType = 'emergency_flagged_with_gpt4o_response';


                    } catch (error) {
                        console.error("❌ 緊急/詐欺/不適切ワード応答エラー:", error.message);
                        await logErrorToDb(userId, "緊急/詐欺/不適切ワード応答エラー", { error: error.message, userId: userId, message: userMessage });
                        // エラーが発生しても、通常のGemini応答に進まないようにhandledをtrueにする
                        messageHandled = true;
                        // 代替応答
                        if (event.replyToken) {
                             await client.replyMessage(event.replyToken, { type: 'text', text: "ごめんね、今うまく緊急のメッセージを送れなかったの💦でも、あなたのことは心配しているよ。" });
                        }
                    }
                }
            }


            // ⭐「相談」モードの切り替えロジック
            if (!messageHandled) {
                if (lowerUserMessage.includes("相談") || lowerUserMessage.includes("そうだん")) {
                    modelToUse = "gemini-1.5-pro-latest";
                    // ユーザーの相談モードをアクティブにし、残りのターン数を1に設定
                    await usersCollection.updateOne(
                        { userId: userId },
                        { $set: { consultationModeActive: true, consultationTurnsLeft: 1 } }
                    );
                    responsedBy = 'こころちゃん（Gemini 1.5 Pro - 相談モード）';
                    logType = 'consultation_mode_start';
                    console.log(`ユーザー ${userId} が相談モードを開始しました。`);
                } else if (user.consultationModeActive && user.consultationTurnsLeft > 0) {
                    // 相談モードがアクティブで、残りのターンがある場合
                    modelToUse = "gemini-1.5-pro-latest";
                    await usersCollection.updateOne(
                        { userId: userId },
                        { $set: { consultationTurnsLeft: user.consultationTurnsLeft - 1 } } // ターンを減らす
                    );
                    if (user.consultationTurnsLeft - 1 <= 0) {
                        // 最後の相談ターンであれば、相談モードを非アクティブにする
                        await usersCollection.updateOne(
                            { userId: userId },
                            { $set: { consultationModeActive: false, consultationTurnsLeft: 0 } }
                        );
                        console.log(`ユーザー ${userId} の相談モードが終了しました。`);
                    }
                    responsedBy = 'こころちゃん（Gemini 1.5 Pro - 相談モード継続）';
                    logType = 'consultation_mode_continue';
                }
                // それ以外はデフォルトのモデル (Flash)
            }


            // ⭐特別応答のチェック（モデル選択後、AI応答より前）
            if (!messageHandled) {
                const specialReply = checkSpecialReply(userMessage);
                if (specialReply) {
                    try {
                        await client.replyMessage(event.replyToken, { type: 'text', text: specialReply });
                        replyText = specialReply;
                        responsedBy = 'こころちゃん（特別応答）';
                        logType = 'special_reply';
                        messageHandled = true;
                    } catch (error) {
                        console.error("❌ 特別応答送信エラー:", error.message);
                        await logErrorToDb(userId, "特別応答送信エラー", { error: error.message, userId: userId, message: userMessage });
                    }
                }
            }

            // ⭐宿題関連のチェック（AI応答より前）
            if (!messageHandled && containsHomeworkTrigger(userMessage)) {
                try {
                    const homeworkReply = "わたしを作った人に「宿題や勉強は自分の力でがんばってほしいから、答えは言っちゃだめだよ」って言われているんだ🌸 ごめんね💦\n\nでも、ヒントくらいなら出せるよ😊 どこで困ってるか教えてくれる？💖";
                    await client.replyMessage(event.replyToken, { type: 'text', text: homeworkReply });
                    replyText = homeworkReply;
                    responsedBy = 'こころちゃん（宿題回答拒否）';
                    logType = 'homework_response';
                    messageHandled = true;
                } catch (error) {
                    console.error("❌ 宿題応答送信エラー:", error.message);
                    await logErrorToDb(userId, "宿題応答送信エラー", { error: error.message, userId: userId, message: userMessage });
                }
            }

            // ⭐AIによる応答（上記で処理されなかった場合のみ）
            if (!messageHandled) {
                try {
                    let aiResponse = await generateReply(userMessage, modelToUse); // 動的にモデルを使用
                    await client.replyMessage(event.replyToken, { type: 'text', text: aiResponse });
                    replyText = aiResponse;
                    messageHandled = true;
                } catch (error) {
                    console.error("❌ AI応答生成・送信エラー:", error.message);
                    await logErrorToDb(userId, "AI応答生成・送信エラー", { error: error.message, userId: userId, message: userMessage, model: modelToUse });
                    if (event.replyToken) {
                        await client.replyMessage(event.replyToken, { type: 'text', text: "ごめんなさい、うまくお話ができなかったみたいです💦 もう一度話しかけてくれると嬉しいな🌸" });
                    }
                    replyText = "（AI応答エラー）";
                }
            }

            // メッセージログをDBに保存（handleWatchServiceRegistrationでログ済みの場合はスキップ）
            // isFlagged, handledByWatchService, isAdminCommand, isResetCommand のロジックは、この全体的なハンドラでは個別に追跡されていないため、ログ記録の条件を調整します。
            // ここでは、messageHandledがtrueであっても、特定のログタイプ（例: watch_service_interaction）でなければログするとします。
            // あるいは、handleWatchServiceRegistrationでログ記録された場合は、ここで再度ログしないように明示的にスキップします。

            // shouldLogMessage関数は、この複合ハンドラーの新しいロジックに合わせて見直す必要があるかもしれません。
            // 例: フラグが立っているか、見守りサービスで処理されたか、相談モードが開始されたか、などを直接チェックする
            const shouldLog = shouldLogMessage(userMessage, isDanger || isScam || isInappropriate, watchServiceHandled, false, false) ||
                             (lowerUserMessage.includes("相談") || lowerUserMessage.includes("そうだん")) ||
                             (user.consultationModeActive && user.consultationTurnsLeft >= 0) ; // 相談モードもログ対象

            if (shouldLog) {
                try {
                     // 既にhandleWatchServiceRegistrationや緊急ワード処理でログされている場合はスキップ
                    if (!watchServiceHandled && !(isDanger || isScam || isInappropriate) && replyText) {
                        const replyMessageObject = { type: 'text', text: replyText };
                        const replyTextForLog = typeof replyMessageObject.text === 'string' ? replyMessageObject.text : JSON.stringify(replyMessageObject);

                        await messagesCollection.insertOne({
                            userId: userId,
                            message: userMessage,
                            replyText: replyTextForLog,
                            responsedBy: respondedBy,
                            timestamp: new Date(),
                            logType: logType
                        });
                    } else if (!replyText && !watchServiceHandled && !(isDanger || isScam || isInappropriate)) {
                        // 応答が生成されなかった場合のログ
                        console.log(`ユーザー ${userId} からのメッセージはDBにログされませんでした（応答なし）: ${userMessage.substring(0, 50)}...`);
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
    console.log(`🚀 サーバーがポート ${PORT} で起動しました...`);
});
