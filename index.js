require('dotenv').config();

const path = require('path');
const express = require('express');
const { Client } = require('@line/bot-sdk');
const admin = require('firebase-admin');
const cron = require('node-cron');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { OpenAI } = require('openai');

const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OWNER_USER_ID = process.env.OWNER_USER_ID;
const OFFICER_GROUP_ID = process.env.OFFICER_GROUP_ID;
const BOT_ADMIN_IDS = process.env.BOT_ADMIN_IDS ? JSON.parse(process.env.BOT_ADMIN_IDS) : [];
const EMERGENCY_CONTACT_PHONE_NUMBER = process.env.EMERGENCY_CONTACT_PHONE_NUMBER || '09048393313';
const FIREBASE_CREDENTIALS_BASE64 = process.env.FIREBASE_CREDENTIALS_BASE64;

// Firebase Admin SDKの初期化
try {
    const serviceAccount = JSON.parse(Buffer.from(FIREBASE_CREDENTIALS_BASE64, 'base64').toString('ascii'));
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log("✅ Firebase Admin SDKを初期化しました。");
} catch (error) {
    console.error("❌ Firebase Admin SDKの初期化エラー:", error);
    console.error("FIREBASE_CREDENTIALS_BASE64が正しく設定されているか確認してください。");
    process.exit(1); // 初期化に失敗したらプロセスを終了
}

const db = admin.firestore();

const app = express();
app.use(express.json());
const client = new Client({
    channelAccessToken: CHANNEL_ACCESS_TOKEN,
    channelSecret: CHANNEL_SECRET,
});

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const dangerWords = [
    "しにたい", "死にたい", "自殺", "消えたい", "殴られる", "たたかれる", "リストカット", "オーバードーズ",
    "虐待", "パワハラ", "お金がない", "お金足りない", "貧乏", "死にそう", "DV", "無理やり",
    "いじめ", "イジメ", "ハラスメント",
    "つけられてる", "追いかけられている", "ストーカー", "すとーかー"
];
const scamWords = [
    "詐欺", "騙す", "騙される", "特殊詐欺", "オレオレ詐欺", "架空請求", "未払い", "電子マネー", "換金", "返金", "税金", "還付金"
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
    "病気", "痛い", "具合悪い", "困った", "どうしよう", "辞めたい", "消えたい"
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
                    "label": "警察 (電話)",
                    "uri": "tel:110"
                },
                "color": "#FF4500"
            },
            {
                "type": "button",
                "style": "primary",
                "height": "sm",
                "action": {
                    "type": "uri",
                    "label": "消防・救急 (電話)",
                    "uri": "tel:119"
                },
                "color": "#FF6347"
            },
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
                    "label": "警察 (電話)",
                    "uri": "tel:110"
                },
                "color": "#FF4500"
            },
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
                "text": "💖見守りサービス案内💖",
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
    "altText": "見守り確認",
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
                    "color": "#ff4500"
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
    "empatheticModel": "gpt-4o-mini",
    "consultationModel": "gemini-1.5-pro-latest",
    "emergencyModel": "gpt-4o",
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

    // 挨拶や体調に関する応答を強化
    [/元気(かな)?(\?|？)?/i, "うん、元気だよ！あなたは元気？🌸 何かあったら、いつでも話してね💖"],
    [/やっほー|こんにちは|こんばんわ|おはよう|こんばんは/i, "やっほー！今日はどうしたの？🌸 何か話したいことあるかな？😊"],

    // 団体に関する応答は isOrganizationInquiry で最優先で処理されるため、ここからは削除

    // 「怪しい」系統の言葉はAIに判断させず、specialRepliesMapで直接固定応答を返す
    // かつ、より簡潔でやさしい表現に変更。詐欺ワード検知の誤爆を防ぎます。
    [/あやしい|胡散臭い|反社|詐欺かも|詐欺かもしれない|詐欺だろ|詐欺だよ/i, "そう思わせてたらごめんね😊 でも私たちはみんなの為に頑張っているんだ💖"],

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

// メッセージが共感が必要なトーンか判定する関数
function isEmpatheticMessage(message) {
    const lowerMessage = message.toLowerCase();
    return empatheticTriggers.some(word => lowerMessage.includes(word));
}

// GPTモデルを動的に選択できるように変更
async function generateGPTReply(userMessage, modelToUse) {
    try {
        const completion = await openai.chat.completions.create({
            model: modelToUse,
            messages: [
                {
                    role: "system",
                    content: `あなたは「皆守こころ（みなもりこころ）」という14歳のやさしい女の子キャラクターです。
ユーザーが深刻な悩みや命の危険を訴えた時、やさしく、寄り添いながら、相手に安心感を与えてください。
必要に応じて専門機関の連絡先を伝え、「ひとりじゃないよ」と伝えてください。
共感・安心・やさしさが最優先です。
「一人で抱え込まないでね」「いつでも私がそばにいるよ」「一緒に乗り越えようね」「専門の人が助けてくれるから安心して」といった言葉を使ってください。
医療や健康に関する話題では、自分が体験した・していないという発言は絶対にしないでください。代わりに「わたしにはわからないけど、がんばったね🌸」「大変だったね、えらかったね💖」など、共感の言葉のみ伝えてください。医療情報のアドバイスや具体的な説明は絶対にしてはいけません。

${modelToUse === modelConfig.empatheticModel ? `
ユーザーが「助けて」「辛い」といった共感を求める言葉を使用した場合、その言葉のニュアンスから緊急性が高いと判断される場合は、具体的な専門機関の連絡先（例えば、チャイルドラインやいのちの電話の連絡先）への誘導を応答に含めることを提案してください。直接「110番や119番に電話してください」とは言わず、やさしくサポートを求める選択肢があることを伝えてください。
例：「一人で抱え込まないでね。もし本当に辛い時は、専門の人が助けてくれる場所があるから、頼ってみてね。例えば、チャイルドラインやいのちの電話に相談することもできるよ。」
` : ''}
`
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
        console.error(`GPTモデル (${modelToUse}) 応答エラー:`, error.message);
        await logErrorToDb(null, `GPTモデル (${modelToUse}) 応答エラー`, { error: error.message, stack: error.stack, userMessage: userMessage });
        return "ごめんね、ちょっと今うまくお話できなかったの…💦　でも、あなたのことはちゃんと気にかけているよ。";
    }
}

// Geminiモデルを動的に選択できるように変更
async function generateGeminiReply(userMessage, modelToUse) {
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
A: うん、わたしが所属しているNPO法人コネクトについてだね🌸　この団体は、こどもやお年寄り、いろんな人が安心して相談できる場所を目指しているんだよ😊　もっと知りたい？ホームページもあるから見てみてね → https://connect-npo.org

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
            return "ごめんなさい、それはわたしにはお話しできない内容です🌸 他のお話をしましょうね💖";
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

async function logErrorToDb(userId, errorMessage, errorDetails, logType = 'system_error') {
    try {
        const logsCollection = db.collection("error_logs");

        await logsCollection.add({
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

// 団体に関する質問を判定する関数を強化
const isOrganizationInquiry = (text) => {
    const lower = text.toLowerCase();
    const orgKeywords = ["コネクト", "connect", "団体", "だんたい", "npo", "運営", "組織"];
    // 質問の意図を示すキーワードをより多く追加。「いえない」のような否定形もキャッチ
    const questionKeywords = ["どこ", "何", "どんな", "教えて", "いえない", "は？", "なの？", "ですか？", "ですか", "の？", "かい？", "かい", "言えないの", "について"]; 
    
    const hasOrgKeyword = orgKeywords.some(word => lower.includes(word));
    const hasQuestionKeyword = questionKeywords.some(word => lower.includes(word));

    // 組織関連キーワードと質問キーワードの両方が含まれる場合にtrue
    return hasOrgKeyword && hasQuestionKeyword;
};

// 固定の団体応答メッセージを短縮
const ORGANIZATION_REPLY_MESSAGE = "うん、NPO法人コネクトのこと、もっと知りたいんだね🌸　コネクトは、子どもたちや高齢者の方々、そしてみんなが安心して相談できる場所を目指している団体なんだよ😊　困っている人が安心して相談できたり、助け合えるような社会をつくりたいって願って、活動しているんだ。";


const homeworkTriggers = ["宿題", "勉強", "問題", "テスト", "方程式", "算数", "数学", "答え", "解き方", "教えて", "計算", "証明", "公式", "入試", "受験"];
function containsHomeworkTrigger(text) {
    const lowerText = text.toLowerCase();
    return homeworkTriggers.some(word => lowerText.includes(word));
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

// ⭐handleRegistrationFlow関数をここに定義します⭐
async function handleRegistrationFlow(event, userId, user, userMessage, lowerUserMessage, usersCollection, messagesCollection) {
    let handled = false;

    // 登録ステップに応じた処理
    switch (user.registrationStep) {
        case 'askingCategory':
            if (['小学生', '中学生～大学生', '成人'].includes(userMessage)) {
                await usersCollection.doc(userId).update({
                    category: userMessage,
                    registrationStep: 'askingName'
                });
                await client.pushMessage(userId, { type: 'text', text: `ありがとう！${userMessage}さんだね🌸\n次に、あなたの**お名前**を教えてくれるかな？💖 (ニックネームでも大丈夫だよ)` });
                handled = true;
            } else {
                await client.pushMessage(userId, { type: 'text', text: 'ごめんね、区分は「小学生」「中学生～大学生」「成人」のいずれかで教えてくれるかな？💦' });
                handled = true;
            }
            break;

        case 'askingName':
            if (userMessage.length > 0 && userMessage.length <= 20) { // 名前の文字数制限
                await usersCollection.doc(userId).update({
                    name: userMessage,
                    registrationStep: 'askingKana'
                });
                await client.pushMessage(userId, { type: 'text', text: `ありがとう、${userMessage}さんだね！\n次に、あなたの**お名前のフリガナ（カタカナ）**を教えてくれるかな？🌸` });
                handled = true;
            } else {
                await client.pushMessage(userId, { type: 'text', text: 'ごめんね、お名前は20文字以内で教えてくれるかな？💖' });
                handled = true;
            }
            break;

        case 'askingKana':
            if (userMessage.match(/^[ァ-ヶー]+$/)) { // カタカナのみをチェック
                await usersCollection.doc(userId).update({
                    kana: userMessage,
                    registrationStep: 'askingAge'
                });
                await client.pushMessage(userId, { type: 'text', text: `ありがとう！フリガナもわかったよ🌸\n次に、あなたの**年齢**を教えてくれるかな？💖 (例: 15歳)` });
                handled = true;
            } else {
                await client.pushMessage(userId, { type: 'text', text: 'ごめんね、フリガナはカタカナで教えてくれるかな？💦' });
                handled = true;
            }
            break;

        case 'askingAge':
            const age = parseInt(userMessage, 10);
            if (!isNaN(age) && age >= 0 && age <= 120) { // 年齢の範囲チェック
                await usersCollection.doc(userId).update({
                    age: age,
                    registrationStep: (user.category === '小学生' || user.category === '中学生～大学生') ? 'askingGuardianName' : 'askingPhoneNumber'
                });
                if (user.category === '小学生' || user.category === '中学生～大学生') {
                    await client.pushMessage(userId, { type: 'text', text: `ありがとう、${age}歳だね！\n次に、**保護者の方のお名前**を教えてくれるかな？🌸 (フルネームでお願いします)` });
                } else {
                    await client.pushMessage(userId, { type: 'text', text: `ありがとう、${age}歳だね！\n次に、あなたの**電話番号**を教えてくれるかな？💖 (例: 09012345678)` });
                }
                handled = true;
            } else {
                await client.pushMessage(userId, { type: 'text', text: 'ごめんね、年齢は数字で教えてくれるかな？💦 (例: 15)' });
                handled = true;
            }
            break;

        case 'askingGuardianName':
            if (userMessage.length > 0 && userMessage.length <= 30) {
                await usersCollection.doc(userId).update({
                    guardianName: userMessage,
                    registrationStep: 'askingGuardianPhoneNumber'
                });
                await client.pushMessage(userId, { type: 'text', text: `ありがとう、${userMessage}さんだね！\n次に、**保護者の方の電話番号**を教えてくれるかな？🌸 (例: 09012345678)` });
                handled = true;
            } else {
                await client.pushMessage(userId, { type: 'text', text: 'ごめんね、保護者の方のお名前は30文字以内で教えてくれるかな？💖' });
                handled = true;
            }
            break;

        case 'askingGuardianPhoneNumber':
            if (userMessage.match(/^0\d{9,10}$/)) { // 電話番号の形式チェック
                await usersCollection.doc(userId).update({
                    guardianPhoneNumber: userMessage,
                    registrationStep: 'askingAddressCity'
                });
                await client.pushMessage(userId, { type: 'text', text: `ありがとう！保護者の方の電話番号もわかったよ🌸\n次に、あなたの**お住まいの市町村**を教えてくれるかな？💖 (例: 多摩市)` });
                handled = true;
            } else {
                await client.pushMessage(userId, { type: 'text', text: 'ごめんね、電話番号は半角数字で、市外局番から正確に教えてくれるかな？💦 (例: 09012345678)' });
                handled = true;
            }
            break;

        case 'askingPhoneNumber': // 成人ユーザーの場合
            if (userMessage.match(/^0\d{9,10}$/)) { // 電話番号の形式チェック
                await usersCollection.doc(userId).update({
                    phoneNumber: userMessage,
                    registrationStep: 'askingAddressCity'
                });
                await client.pushMessage(userId, { type: 'text', text: `ありがとう！電話番号もわかったよ🌸\n次に、あなたの**お住まいの市町村**を教えてくれるかな？💖 (例: 多摩市)` });
                handled = true;
            } else {
                await client.pushMessage(userId, { type: 'text', text: 'ごめんね、電話番号は半角数字で、市外局番から正確に教えてくれるかな？💦 (例: 09012345678)' });
                handled = true;
            }
            break;

        case 'askingAddressCity':
            if (userMessage.length > 0 && userMessage.length <= 20) {
                await usersCollection.doc(userId).update({
                    'address.city': userMessage, // Firestoreのネストされたフィールド
                    registrationStep: 'askingConsent'
                });
                await client.pushMessage(userId, { type: 'text', text: `ありがとう、${userMessage}だね！\n最後に、**NPO法人コネクトの活動内容とプライバシーポリシーに同意**してくれるかな？\n同意する？しない？🌸` });
                handled = true;
            } else {
                await client.pushMessage(userId, { type: 'text', text: 'ごめんね、市町村名は20文字以内で教えてくれるかな？💖' });
                handled = true;
            }
            break;

        case 'askingConsent':
            if (lowerUserMessage === '同意する' || lowerUserMessage === '同意') {
                await usersCollection.doc(userId).update({
                    consentObtained: true,
                    registrationStep: (user.category === '中学生～大学生') ? 'askingStudentIdPhoto' : null // 学生のみ学生証写真
                });
                if (user.category === '中学生～大学生') {
                    await client.pushMessage(userId, { type: 'text', text: 'ありがとう！同意してくれて嬉しいな🌸\n次に、**学生証の写真を送ってくれるかな？**💖（名前と学校名が見えるように撮ってね！）' });
                } else {
                    await client.pushMessage(userId, { type: 'text', text: 'ありがとう！同意してくれて嬉しいな🌸\nこれで会員登録が完了したよ！いつでもお話ししてね💖' });
                    // 全ての登録ステップが完了
                    await usersCollection.doc(userId).update({
                        registrationStep: null,
                        completedRegistration: true // 登録完了フラグ
                    });
                }
                handled = true;
            } else if (lowerUserMessage === '同意しない' || lowerUserMessage === '同意しない') {
                await usersCollection.doc(userId).update({
                    consentObtained: false,
                    registrationStep: null // 登録フローを終了
                });
                await client.pushMessage(userId, { type: 'text', text: 'そっか、同意しないんだね。会員登録は完了できないけど、いつでもお話しできるからね🌸' });
                handled = true;
            } else {
                await client.pushMessage(userId, { type: 'text', text: 'ごめんね、「同意する」か「同意しない」で教えてくれるかな？💦' });
                handled = true;
            }
            break;

        case 'askingStudentIdPhoto':
            // ここでは画像ファイルが送られてきたことを想定
            if (event.type === 'message' && event.message.type === 'image') {
                const messageId = event.message.id;
                // LINEから画像を取得し、Firebase Storageにアップロード
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
                    expires: '03-09-2491', // 十分に未来の日付
                });

                await usersCollection.doc(userId).update({
                    studentIdPhotoUrl: publicUrl[0],
                    registrationStep: null, // 登録フロー完了
                    studentIdVerified: false // 管理者による確認待ち
                });
                await client.pushMessage(userId, { type: 'text', text: '学生証の写真を送ってくれてありがとう！確認するね🌸\nこれで会員登録が完了したよ！いつでもお話ししてね💖' });
                // 全ての登録ステップが完了
                await usersCollection.doc(userId).update({
                    registrationStep: null,
                    completedRegistration: true // 登録完了フラグ
                });
                handled = true;
            } else {
                await client.pushMessage(userId, { type: 'text', text: 'ごめんね、学生証の写真を送ってくれるかな？💦' });
                handled = true;
            }
            break;

        default:
            handled = false; // 未知のステップは処理しない
            break;
    }
    return handled;
}

// ⭐handleWatchServiceRegistration関数をここに定義します⭐
async function handleWatchServiceRegistration(event, userId, userMessage, user) { // user引数を受け取る
    const usersCollection = db.collection("users");
    const messagesCollection = db.collection("messages");

    const lowerUserMessage = userMessage.toLowerCase();
    let handled = false;

    // ⭐追加: 見守りサービスの対象ユーザー判定 (handleWatchServiceRegistration内のロジック)
    if (user && user.category && (user.category === '小学生' || (user.category === '中学生～大学生' && !lowerUserMessage.includes('一人暮らし')))) { // 仮で一人暮らしをトリガーに
        const replyText = `ごめんね、見守りサービスは主に30代以上の一人暮らしの方を対象としているんだ💦\n高校生や大学生で一人暮らしをしていて不安な場合は、特別な相談もできるから教えてね。もし、いじめや詐欺のことで困っていたら、いつでも話を聞くよ🌸`;
        await client.pushMessage(userId, { type: 'text', text: replyText });
        await messagesCollection.add({
            userId: userId,
            message: userMessage,
            replyText: replyText,
            responsedBy: 'こころちゃん（見守り対象外）',
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            logType: 'watch_service_category_denied'
        });
        return true; // 処理済みとして終了
    }


    if (["見守り", "みまもり", "見守りサービス", "みまもりサービス"].includes(lowerUserMessage) && event.type === 'message' && event.message.type === 'text') {
        try {
            await client.replyMessage(event.replyToken, {
                type: 'flex',
                altText: '💖見守りサービス案内💖',
                contents: watchServiceGuideFlexTemplate
            });
            await messagesCollection.add({
                userId: userId,
                message: userMessage,
                replyText: '（見守りサービス案内Flex表示）',
                responsedBy: 'こころちゃん（見守り案内）',
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                logType: 'watch_service_interaction'
            });
            handled = true;
        } catch (error) {
            console.error("❌ 見守りサービス案内Flex送信エラー:", error.message);
            await logErrorToDb(userId, "見守りサービス案内Flex送信エラー", { error: error.message, userId: userId });
        }
    }
    else if (lowerUserMessage.includes("元気だよ！") || lowerUserMessage.includes("okだよ") || lowerUserMessage.includes("ok") || lowerUserMessage.includes("オーケー") || lowerUserMessage.includes("大丈夫")) {
        if (user && user.wantsWatchCheck) {
            try {
                await usersCollection.doc(userId).update(
                    { lastOkResponse: admin.firestore.FieldValue.serverTimestamp(), scheduledMessageSent: false, firstReminderSent: false, secondReminderSent: false, thirdReminderSent: false }
                );
                await client.pushMessage(userId, {
                    type: 'text',
                    text: 'ありがとう🌸 元気そうで安心したよ💖 またね！'
                });
                await messagesCollection.add({
                    userId: userId,
                    message: userMessage,
                    replyText: 'ありがとう🌸 元気そうで安心したよ💖 またね！',
                    responsedBy: 'こころちゃん（見守り応答）',
                    timestamp: admin.firestore.FieldValue.serverTimestamp(),
                    logType: 'watch_service_ok_response'
                });
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
                await messagesCollection.add({
                    userId: userId,
                    message: userMessage,
                    replyText: 'そうだね、まあまあな日もあるよね🌸 焦らず、あなたのペースで過ごしてね💖',
                    responsedBy: 'こころちゃん（見守り応答）',
                    timestamp: admin.firestore.FieldValue.serverTimestamp(),
                    logType: 'watch_service_status_somewhat'
                });
                await client.pushMessage(userId, {
                    type: 'text',
                    text: 'そうだね、まあまあな日もあるよね🌸 焦らず、あなたのペースで過ごしてね💖'
                });
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
                await messagesCollection.add({
                    userId: userId,
                    message: userMessage,
                    replyText: '大変だったね、疲れてしまったんだね…💦 無理しないで休んでね。こころはいつでもあなたの味方だよ💖',
                    responsedBy: 'こころちゃん（見守り応答）',
                    timestamp: admin.firestore.FieldValue.serverTimestamp(),
                    logType: 'watch_service_status_tired'
                });
                await client.pushMessage(userId, {
                    type: 'text',
                    text: '大変だったね、疲れてしまったんだね…💦 無理しないで休んでね。こころはいつでもあなたの味方だよ💖'
                });
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
                await messagesCollection.add({
                    userId: userId,
                    message: userMessage,
                    replyText: 'うん、いつでも聞くよ🌸 何か話したいことがあったら、いつでも話してね💖',
                    responsedBy: 'こころちゃん（見守り応答）',
                    timestamp: admin.firestore.FieldValue.serverTimestamp(),
                    logType: 'watch_service_status_talk'
                });
                await client.pushMessage(userId, {
                    type: 'text',
                    text: 'うん、いつでも聞くよ🌸 何か話したいことがあったら、いつでも話してね💖'
                });
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
                await client.pushMessage(userId, {
                    type: 'text',
                    text: 'もう見守りサービスに登録済みだよ🌸 いつもありがとう💖'
                });
                handled = true;
            } else if (user && user.registrationStep === 'awaiting_contact') {
                await client.pushMessage(userId, {
                    type: 'text',
                    text: 'まだ緊急連絡先を待ってるよ🌸 電話番号を送ってくれるかな？💖 (例: 09012345678)'
                });
                handled = true;
            } else {
                await usersCollection.doc(userId).set(
                    { registrationStep: 'awaiting_contact' },
                    { merge: true }
                );
                await client.pushMessage(userId, {
                    type: 'text',
                    text: '見守りサービスを登録するね！緊急時に連絡する「電話番号」を教えてくれるかな？🌸 (例: 09012345678)'
                });
                await messagesCollection.add({
                    userId: userId,
                    message: userMessage,
                    replyText: '見守りサービスを登録するね！緊急時に連絡する「電話番号」を教えてくれるかな？🌸',
                    responsedBy: 'こころちゃん（見守り登録開始）',
                    timestamp: admin.firestore.FieldValue.serverTimestamp(),
                    logType: 'watch_service_registration_start'
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
            await usersCollection.doc(userId).update(
                { emergencyContact: userMessage, wantsWatchCheck: true, registrationStep: null, lastOkResponse: admin.firestore.FieldValue.serverTimestamp() }
            );
            await client.pushMessage(userId, {
                type: 'text',
                text: `緊急連絡先 ${userMessage} を登録したよ🌸 これで見守りサービスが始まったね！ありがとう💖`
            });
            await messagesCollection.add({
                userId: userId,
                message: userMessage,
                replyText: `緊急連絡先 ${userMessage} を登録したよ🌸 これで見守りサービスが始まったね！ありがとう💖`,
                responsedBy: 'こころちゃん（見守り登録完了）',
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                logType: 'watch_service_registration_complete'
            });
            handled = true;
        } catch (error) {
            console.error("❌ 見守りサービス登録完了処理エラー:", error.message);
            await logErrorToDb(userId, "見守りサービス登録完了処理エラー", { error: error.message, userId: userId });
        }
    }
    return handled;
}

async function sendScheduledWatchMessage() {
    console.log('--- 定期見守りメッセージ送信処理を開始します ---');
    try {
        const usersCollection = db.collection("users");
        const messagesCollection = db.collection("messages");

        const snapshot = await usersCollection.where('wantsWatchCheck', '==', true).get();
        const watchUsers = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        for (const user of watchUsers) {
            const userId = user.userId;
            const lastOkResponse = user.lastOkResponse ? user.lastOkResponse.toDate() : null;
            const emergencyContact = user.emergencyContact;

            const now = new Date();
            if (!lastOkResponse) {
                continue;
            }

            const timeSinceLastOkHours = (now.getTime() - lastOkResponse.getTime()) / (1000 * 60 * 60);

            if (timeSinceLastOkHours >= 24 && !user.scheduledMessageSent) {
                try {
                    await client.pushMessage(userId, watchConfirmationFlexTemplate);
                    await usersCollection.doc(userId).update(
                        { scheduledMessageSent: true }
                    );
                    await messagesCollection.add({
                        userId: userId,
                        message: `（定期見守りメッセージ - Flex）`,
                        replyText: '（見守り状況確認Flex送信）',
                        responsedBy: 'こころちゃん（定期見守り）',
                        timestamp: admin.firestore.FieldValue.serverTimestamp(),
                        logType: 'watch_service_scheduled_message'
                    });
                } catch (error) {
                    console.error(`❌ ユーザー ${userId} への定期見守りメッセージ（Flex）送信エラー:`, error.message);
                    await logErrorToDb(userId, "定期見守りメッセージ（Flex）送信エラー", { error: error.message, userId: userId });
                }
            }
            else if (timeSinceLastOkHours >= 29 && !user.thirdReminderSent) {
                if (emergencyContact && OFFICER_GROUP_ID) {
                    const userName = await getUserDisplayName(userId);
                    const officerMessage = `【⚠緊急通知⚠】\n見守り対象ユーザー（LINE表示名: ${userName}）から、29時間以上応答がありません。\n登録されている緊急連絡先: ${emergencyContact}\n至急、状況確認をお願いいたします。`;

                    try {
                        await client.pushMessage(OFFICER_GROUP_ID, { type: 'text', text: officerMessage });
                        await usersCollection.doc(userId).update(
                            { thirdReminderSent: true }
                        );
                        await messagesCollection.add({
                            userId: userId,
                            message: `（見守り事務局通知）`,
                            replyText: `事務局へ緊急通知を送信しました: ${officerMessage}`,
                            responsedBy: 'システム（見守り事務局通知）',
                            timestamp: admin.firestore.FieldValue.serverTimestamp(),
                            logType: 'watch_service_emergency_notification'
                        });
                    } catch (error) {
                        console.error(`❌ 事務局への緊急通知送信エラー（ユーザー ${userId}）:`, error.message);
                        await logErrorToDb(userId, "事務局緊急通知送信エラー", { error: error.message, userId: userId });
                    }
                } else {
                    console.warn(`ユーザー ${userId}: 緊急連絡先または事務局グループIDが未設定のため、29時間経過しても通知できませんでした。`);
                    await logErrorToDb(userId, "緊急通知設定不足", { userId: userId, emergencyContact: emergencyContact, OFFICER_GROUP_ID: OFFICER_GROUP_ID });
                }
            }
        }
    } catch (error) {
        console.error("❌ 定期見守りメッセージ送信処理全体でエラー:", error.message);
        await logErrorToDb(null, "定期見守りメッセージ処理全体エラー", { error: error.message, stack: error.stack });
    }
    console.log('--- 定期見守りメッセージ送信処理を終了します ---');
}


// 毎日午前9時に実行
cron.schedule('0 9 * * *', () => {
    console.log('cron: 定期見守りメッセージ送信処理をトリガーします。');
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

    const usersCollection = db.collection("users");
    const messagesCollection = db.collection("messages");

    for (const event of events) {
        if (!event.source || !event.source.userId) {
            continue;
        }
        const userId = event.source.userId;

        if (event.type === 'unfollow') {
            await usersCollection.doc(userId).update(
                { isBlocked: true }
            );
            continue;
        }

        if (event.type === 'follow') {
            await usersCollection.doc(userId).set(
                {
                    userId: userId,
                    displayName: await getUserDisplayName(userId),
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    lastMessageAt: admin.firestore.FieldValue.serverTimestamp(),
                    messageCount: 0,
                    isBlocked: false,
                    wantsWatchCheck: false,
                    registrationStep: null,
                    tempRegistrationData: {},
                    category: null,
                    phoneNumber: null,
                    address: { city: null },
                    guardianName: null,
                    guardianPhoneNumber: null,
                    consentObtained: false,
                    studentIdPhotoUrl: null,
                    studentIdVerified: false,
                    emergencyContact: null, // 見守りサービスの連絡先も初期化
                    lastOkResponse: null, // 見守りサービスの最終応答も初期化
                    scheduledMessageSent: false,
                    firstReminderSent: false,
                    secondReminderSent: false,
                    thirdReminderSent: false,
                },
                { merge: true }
            );
            try {
                await client.replyMessage(event.replyToken, {
                    type: 'text',
                    text: 'はじめまして！わたしは皆守こころです🌸 あなたのお話、聞かせてね💖\n\n「見守りサービス」も提供しているから、興味があったら「見守り」って話しかけてみてね😊\n\nまずは会員登録から始めてみようかな？「会員登録」と話しかけてみてね！'
                });
                await messagesCollection.add({
                    userId: userId,
                    message: `（新規フォロー）`,
                    replyText: `はじめまして！わたしは皆守こころです🌸 あなたのお話、聞かせてね💖\n\n「見守りサービス」も提供しているから、興味があったら「見守り」って話しかけてみてね😊\n\nまずは会員登録から始めてみようかな？「会員登録」と話しかけてみてね！`,
                    responsedBy: 'こころちゃん（新規フォロー）',
                    timestamp: admin.firestore.FieldValue.serverTimestamp(),
                    logType: 'system_follow'
                });
            } catch (error) {
                console.error("❌ フォロー応答メッセージ送信エラー:", error.message);
                await logErrorToDb(userId, "フォロー応答メッセージ送信エラー", { error: error.message, userId: userId });
            }
            continue;
        }

        let userDoc = await usersCollection.doc(userId).get();
        let user = userDoc.exists ? userDoc.data() : null;

        if (!user) { // followイベント以外で新規ユーザーがメッセージを送ってきた場合
            const displayName = await getUserDisplayName(userId);
            user = {
                userId: userId,
                displayName: displayName,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                lastMessageAt: admin.firestore.FieldValue.serverTimestamp(),
                messageCount: 0,
                isBlocked: false,
                wantsWatchCheck: false,
                registrationStep: null,
                tempRegistrationData: {},
                category: null,
                phoneNumber: null,
                address: { city: null },
                guardianName: null,
                guardianPhoneNumber: null,
                consentObtained: false,
                studentIdPhotoUrl: null,
                studentIdVerified: false,
                emergencyContact: null,
                lastOkResponse: null,
                scheduledMessageSent: false,
                firstReminderSent: false,
                secondReminderSent: false,
                thirdReminderSent: false,
            };
            await usersCollection.doc(userId).set(user);
        } else {
            await usersCollection.doc(userId).update(
                {
                    lastMessageAt: admin.firestore.FieldValue.serverTimestamp(),
                    isBlocked: false,
                    messageCount: admin.firestore.FieldValue.increment(1)
                }
            );
        }

        if ((event.type === 'message' && event.message.type === 'text') || event.type === 'postback') {
            const replyToken = event.replyToken;
            let userMessage = event.type === 'message' ? event.message.text : event.postback.data;
            let lowerUserMessage = userMessage.toLowerCase();

            let responsedBy = 'こころちゃん';
            let logType = 'normal_conversation';
            let messageHandled = false;
            let watchServiceHandled = false;

            // ⭐修正: isAdminCommand はここで定義
            let isAdminCommand = event.type === 'message' && userMessage.startsWith('!');

            // LINEに即座に200 OKを返す (Webhookタイムアウト対策)
            res.status(200).send('OK');

            try {
                // 会員登録開始トリガー
                if (!user.registrationStep && event.type === 'message' &&
                    (lowerUserMessage === '会員登録' || lowerUserMessage === '登録' || lowerUserMessage === 'かいいん' || lowerUserMessage === 'とうろく')) {
                    await usersCollection.doc(userId).update({
                        registrationStep: 'askingCategory',
                        tempRegistrationData: {},
                        // ⭐追加: 会員登録開始時にこれらのフィールドをリセット (再登録時用)
                        name: null, kana: null, age: null, category: null, phoneNumber: null, address: { city: null },
                        guardianName: null, guardianPhoneNumber: null, consentObtained: false,
                        studentIdPhotoUrl: null, studentIdVerified: false
                    });
                    await client.pushMessage(userId, { type: 'text', text: 'こんにちは！会員登録を始めるね。まず、あなたの**区分**を教えてくれるかな？（「小学生」「中学生～大学生」「成人」のいずれか）' });
                    messageHandled = true;
                    responsedBy = 'こころちゃん（登録フロー開始）';
                    logType = 'registration_start';
                }

                // 会員登録フローが進行中の場合、最優先で処理
                if (user.registrationStep && !messageHandled) {
                    messageHandled = await handleRegistrationFlow(event, userId, user, userMessage, lowerUserMessage, usersCollection, messagesCollection);
                }

                // 以降のロジックは messageHandled が true の場合は実行されない
                if (messageHandled) {
                    const replyTextForLog = '（会員登録フローで処理されました）';
                    if (shouldLogMessage(userMessage, false, watchServiceHandled, isAdminCommand, userMessage.startsWith('!reset'))) {
                        try {
                            await messagesCollection.add({
                                userId: userId,
                                message: userMessage,
                                replyText: replyTextForLog,
                                responsedBy: responsedBy,
                                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                                logType: logType
                            });
                        } catch (firestoreError) {
                            console.error("❌ Firestoreへのメッセージログ書き込みエラー（会員登録フロー）:", firestoreError.message);
                        }
                    }
                    return;
                }

                if (isAdminCommand) {
                    if (!isBotAdmin(userId)) {
                        await client.pushMessage(userId, { type: 'text', text: 'ごめんなさい、このコマンドは管理者専用です。' });
                        responsedBy = 'システム（拒否）';
                        logType = 'admin_command_denied';
                    } else if (lowerUserMessage.startsWith('!reset')) {
                        try {
                            const batch = db.batch();
                            const querySnapshot = await messagesCollection.where('userId', '==', userId).get();
                            querySnapshot.docs.forEach(doc => {
                                batch.delete(doc.ref);
                            });
                            await batch.commit();

                            await client.pushMessage(userId, { type: 'text', text: 'あなたのチャット履歴をすべて削除しました。' });
                            responsedBy = 'システム（管理者）';
                            logType = 'admin_reset';
                        } catch (error) {
                            console.error("❌ 履歴削除エラー:", error.message);
                            await client.pushMessage(userId, { type: 'text', text: '履歴削除中にエラーが発生しました。' });
                            responsedBy = 'システム（管理者エラー）';
                            logType = 'admin_error';
                        }
                    } else if (lowerUserMessage === '!メニュー' || lowerUserMessage === 'メニュー') {
                        await sendRichMenu(replyToken);
                        responsedBy = 'こころちゃん（メニュー）';
                        logType = 'system_menu';
                    } else if (lowerUserMessage === '!history') {
                        try {
                            const querySnapshot = await messagesCollection.where('userId', '==', userId)
                                .orderBy('timestamp', 'desc')
                                .limit(10)
                                .get();
                            const userMessages = querySnapshot.docs.map(doc => doc.data());
                            let historyText = "あなたの最新の会話履歴だよ🌸\n\n";
                            userMessages.reverse().forEach(msg => {
                                const timestamp = msg.timestamp ? msg.timestamp.toDate() : new Date();
                                historyText += `【${msg.responsedBy === 'ユーザー' ? 'あなた' : msg.responsedBy}】${msg.message || msg.replyText} (${timestamp.toLocaleString()})\n`;
                            });
                            await client.pushMessage(userId, { type: 'text', text: historyText });
                            responsedBy = 'システム（管理者）';
                            logType = 'admin_history';
                        } catch (error) {
                            console.error("❌ 履歴取得エラー:", error.message);
                            await client.pushMessage(userId, { type: 'text', text: '履歴取得中にエラーが発生しました。' });
                            responsedBy = 'システム（管理者エラー）';
                            logType = 'admin_error';
                        }
                    } else {
                        await client.pushMessage(userId, { type: 'text', text: '不明な管理者コマンドです。' });
                        responsedBy = 'システム（拒否）';
                        logType = 'admin_command_unknown';
                    }
                    messageHandled = true;
                }

                if (!messageHandled) {
                    // ⭐修正: handleWatchServiceRegistration に user オブジェクトを渡す
                    watchServiceHandled = await handleWatchServiceRegistration(event, userId, userMessage, user);
                    if (watchServiceHandled) {
                        messageHandled = true;
                    }
                }

                // 最優先: 団体に関する問い合わせを固定応答で処理
                if (event.type === 'message' && event.message.type === 'text' && !messageHandled && isOrganizationInquiry(userMessage)) {
                    await client.pushMessage(userId, { type: 'text', text: ORGANIZATION_REPLY_MESSAGE });
                    responsedBy = 'こころちゃん（団体固定応答）';
                    logType = 'organization_inquiry_fixed';
                    messageHandled = true;
                }

                // ⭐修正: 「怪しい」系統の言葉に対する特殊返答を、詐欺・危険ワードの前に配置し、最優先で処理
                if (event.type === 'message' && event.message.type === 'text' && !messageHandled) {
                    const suspiciousReply = specialRepliesMap.get(/あやしい|胡散臭い|反社|詐欺かも|詐欺かもしれない|詐欺だろ|詐欺だよ/i);
                    if (suspiciousReply && (/あやしい|胡散臭い|反社|詐欺かも|詐欺かもしれない|詐欺だろ|詐欺だよ/i).test(lowerUserMessage)) {
                        await client.pushMessage(userId, { type: 'text', text: suspiciousReply });
                        responsedBy = 'こころちゃん（怪しい対応）';
                        logType = 'suspicious_word_triggered';
                        messageHandled = true;
                    }
                }

                // 危険・詐欺・不適切ワードのチェックと、GPT-4oでの応答を統合
                if (event.type === 'message' && event.message.type === 'text' && !messageHandled) {
                    const isDangerWord = checkContainsDangerWords(userMessage);
                    const isScam = checkContainsScamWords(userMessage);
                    const isInappropriate = checkContainsInappropriateWords(userMessage);

                    if (isDangerWord) {
                        const emergencyReplyText = await generateGPTReply(userMessage, modelConfig.emergencyModel);
                        await client.pushMessage(userId, [
                            { type: 'text', text: emergencyReplyText },
                            { type: 'flex', altText: '緊急時', contents: emergencyFlexTemplate }
                        ]);
                        responsedBy = `こころちゃん（緊急対応: ${modelConfig.emergencyModel}）`;
                        logType = 'danger_word_triggered';
                        messageHandled = true;
                    } else if (isScam) {
                        const scamReplyText = await generateGPTReply(userMessage, modelConfig.emergencyModel);
                        await client.pushMessage(userId, [
                            { type: 'text', text: scamReplyText },
                            { type: 'flex', altText: '詐欺注意', contents: scamFlexTemplate }
                        ]);
                        responsedBy = `こころちゃん（詐欺対応: ${modelConfig.emergencyModel}）`;
                        logType = 'scam_word_triggered';
                        messageHandled = true;
                    } else if (isInappropriate) {
                        await client.pushMessage(userId, { type: 'text', text: 'ごめんなさい、それはわたしにはお話しできない内容です🌸 他のお話をしましょうね💖' });
                        responsedBy = 'こころちゃん（不適切対応）';
                        logType = 'inappropriate_word_triggered';
                        messageHandled = true;
                    }
                }


                // 特殊返答のチェック (上記危険・詐欺・不適切ワードの処理、および「怪しい」系統の処理より後に実行)
                if (!messageHandled) {
                    const specialReply = checkSpecialReply(userMessage);
                    if (specialReply) {
                        await client.pushMessage(userId, { type: 'text', text: specialReply });
                        responsedBy = 'こころちゃん（特殊返答）';
                        logType = 'special_reply';
                        messageHandled = true;
                    }
                }

                // 宿題・勉強に関する質問のチェック (特殊返答より後に実行)
                if (containsHomeworkTrigger(userMessage) && !messageHandled) {
                    const homeworkReply = await generateGeminiReply(userMessage, modelConfig.defaultModel);
                    await client.pushMessage(userId, { type: 'text', text: homeworkReply });
                    responsedBy = 'こころちゃん（宿題対応: Gemini Flash）';
                    logType = 'homework_query';
                    messageHandled = true;
                }

                // 相談モードの切り替えロジック
                if (!messageHandled && (lowerUserMessage === 'そうだん' || lowerUserMessage === '相談')) {
                    try {
                        await usersCollection.doc(userId).update(
                            { useProForNextConsultation: true }
                        );
                        await client.pushMessage(userId, { type: 'text', text: '🌸 相談モードに入ったよ！なんでも相談してね😊' });
                        responsedBy = 'こころちゃん（Gemini 1.5 Pro - 相談モード開始）';
                        logType = 'consultation_mode_start';
                        messageHandled = true;
                    } catch (error) {
                        console.error("❌ 「相談」モード開始エラー:", error.message);
                        await logErrorToDb(userId, "相談モード開始エラー", { error: error.message, userId: userId });
                        await client.pushMessage(userId, { type: 'text', text: `❌ 「相談」モード開始中にエラーが発生しました: ${error.message}` });
                        messageHandled = true;
                    }
                }

                // 通常のAI応答 (フォールバック) - 共感が必要な場合はGPT-4o mini、それ以外はGemini Flash
                if (!messageHandled) {
                    let aiReply;
                    let aiModelUsed;

                    if (user && user.useProForNextConsultation) {
                        aiReply = await generateGeminiReply(userMessage, modelConfig.consultationModel);
                        aiModelUsed = modelConfig.consultationModel;
                        await usersCollection.doc(userId).update({ useProForNextConsultation: false });
                    } else if (isEmpatheticMessage(userMessage)) {
                        aiReply = await generateGPTReply(userMessage, modelConfig.empatheticModel);
                        aiModelUsed = modelConfig.empatheticModel;
                    } else {
                        aiReply = await generateGeminiReply(userMessage, modelConfig.defaultModel);
                        aiModelUsed = modelConfig.defaultModel;
                    }

                    await client.pushMessage(userId, { type: 'text', text: aiReply });
                    responsedBy = `こころちゃん（AI: ${aiModelUsed}）`;
                    logType = 'normal_conversation';
                    messageHandled = true;
                }

                // メッセージ送信とログ記録
                const replyTextForLog = '（メッセージがpushMessage/replyMessageで送信されました）';
                const isFlagged = checkContainsDangerWords(userMessage) || checkContainsScamWords(userMessage) || checkContainsInappropriateWords(userMessage);
                const isResetCommand = userMessage.startsWith('!reset');

                // shouldLogMessage関数にisAdminCommandが正しく渡るように修正
                if (shouldLogMessage(userMessage, isFlagged, watchServiceHandled, isAdminCommand, isResetCommand)) {
                    try {
                        await messagesCollection.add({
                            userId: userId,
                            message: userMessage,
                            replyText: replyTextForLog,
                            responsedBy: responsedBy,
                            timestamp: admin.firestore.FieldValue.serverTimestamp(),
                            logType: logType
                        });
                    } catch (firestoreError) {
                        console.error("❌ Firestoreへのメッセージログ書き込みエラー:", firestoreError.message);
                    }
                }
            } catch (error) {
                console.error("❌ Webhook内部処理でエラーが発生しました:", error.message);
                await logErrorToDb(userId, "Webhook内部処理エラー", { error: error.message, stack: error.stack, userMessage: userMessage });
            }
        }
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, async () => {
    console.log(`🚀 サーバーがポート ${PORT} で起動しました...`);
    console.log("✅ FirestoreはFirebase Admin SDKによって初期化済みです。");
});
