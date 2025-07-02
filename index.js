require('dotenv').config();

const path = require('path');
const express = require = ('express');
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
const BOT_ADMIN_IDS = process.env.BOT_ADMIN_IDS ? JSON.parse(process.env.BOT_ADMIN_IDS) : ["Udada4206b73648833b844cfbf1562a87"];
const EMERGENCY_CONTACT_PHONE_NUMBER = process.env.EMERGENCY_CONTACT_PHONE_NUMBER || '09048393313';
const FIREBASE_CREDENTIALS_BASE64 = process.env.FIREBASE_CREDENTIALS_BASE64;

const STUDENT_ELEMENTARY_FORM_URL = "https://forms.gle/mgRJfAznoSun9gWA6";
const STUDENT_MIDDLE_HIGH_UNI_FORM_URL = "https://forms.gle/EGYWXBVSUzX7wvgE8";
const ADULT_FORM_URL = "https://forms.gle/P9uuW9aEZDaCoWAN9";
const WATCH_SERVICE_FORM_BASE_URL = 'https://docs.google.com/forms/d/e/1FAIpQLSdYfVmS8kc71_VASWJe4xtUXpiOhmoQNWyI_oT_DSe2xP4Iuw/viewform?usp=pp_url';
const WATCH_SERVICE_FORM_LINE_USER_ID_ENTRY_ID = 'entry.312175830';


try {
    const serviceAccount = JSON.parse(Buffer.from(FIREBASE_CREDENTIALS_BASE64, 'base64').toString('ascii'));
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log("✅ Firebase Admin SDKを初期化しました。");
} catch (error) {
    console.error("❌ Firebase Admin SDKの初期化エラー:", error);
    console.error("FIREBASE_CREDENTIALS_BASE64が正しく設定されているか確認してください。");
    process.exit(1);
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

const modelConfig = {
    "defaultModel": "gemini-1.5-flash-latest", // 通常のデフォルトモデル
    "empatheticModel": "gpt-4o-mini", // 共感応答モデル
    "consultationModel": "gemini-1.5-pro-latest", // 相談モードモデル
    "emergencyModel": "gpt-4o", // 緊急時・詐欺対応モデル
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

const EMERGENCY_FLEX_MESSAGE = {
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

const SCAM_FLEX_MESSAGE = {
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
                    "data": "action=watch_register_start_form" // ここをFlex内のボタンpostback用アクションとする
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
                    "data": "action=watch_unregister" // 解除ボタンのデータ
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
                    "style": "primary", // ボタンを大きくするためにスタイルをPrimaryに
                    "height": "lg",    // ボタンを大きく
                    "color": "#00C851"
                },
                {
                    "type": "button",
                    "action": {
                        "type": "message",
                        "label": "😐 まあまあかな",
                        "text": "まあまあかな"
                    },
                    "style": "primary",
                    "height": "lg",
                    "color": "#ffbb33"
                },
                {
                    "type": "button",
                    "action": {
                        "type": "message",
                        "label": "😢 少し疲れた…",
                        "text": "少し疲れた…"
                    },
                    "style": "primary",
                    "height": "lg",
                    "color": "#ff4500"
                },
                {
                    "type": "button",
                    "action": {
                        "type": "message",
                        "label": "💬 話を聞いて",
                        "text": "話を聞いて"
                    },
                    "style": "primary",
                    "height": "lg",
                    "color": "#33b5e5"
                }
            ]
        }
    }
};


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

// 毎月1日の午前0時に月間メッセージカウントをリセット
cron.schedule('0 0 1 * *', async () => {
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
        await logErrorToDb(null, "月間メッセージカウントリセットエラー", { error: error.message, stack: error.stack });
    }
}, {
    timezone: "Asia/Tokyo"
});

// 不適切ワードカウントのリセット（毎朝4時）
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
        await logErrorToDb(null, "不適切ワードカウントリセットエラー", { error: error.message, stack: error.stack });
    }
}, {
    timezone: "Asia/Tokyo"
});

async function logToDb(userId, message, replyText, responsedBy, logType, isFlagged = false) {
    try {
        const logsCollection = db.collection("logs"); // 全てのログをここに集約
        await logsCollection.add({
            userId: userId,
            message: message,
            replyText: replyText,
            responsedBy: responsedBy,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            logType: logType,
            isFlagged: isFlagged // フラグ付きかどうか
        });
    } catch (dbError) {
        console.error(`❌ Firestoreへのログ書き込み中にエラーが発生しました: ${dbError.message}`);
    }
}

async function logErrorToDb(userId, errorMessage, errorDetails, logType = 'system_error') {
    try {
        const logsCollection = db.collection("error_logs"); // エラーログ専用コレクション

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

function isOrganizationInquiry(text) {
    const lower = text.toLowerCase();
    const orgKeywords = ["コネクト", "connect", "団体", "だんたい", "npo", "運営", "組織"];
    const questionKeywords = ["どこ", "何", "どんな", "教えて", "いえない", "は？", "なの？", "ですか？", "ですか", "の？", "かい？", "かい", "言えないの", "について"];
    const hasOrgKeyword = orgKeywords.some(word => lower.includes(word));
    const hasQuestionKeyword = questionKeywords.some(word => lower.includes(word));
    return hasOrgKeyword && hasQuestionKeyword;
}

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

const specialRepliesMap = new Map([
    ["こころじゃないの？", "うん、わたしの名前は皆守こころ💖　これからもよろしくね🌸"],
    ["こころチャットなのにうそつきじゃん", "ごめんなさい💦 わたしの名前は皆守こころだよ🌸 誤解させちゃってごめんね💖"],
    ["名前も言えないの？", "ごめんね、わたしの名前は皆守こころ（みなもりこころ）だよ🌸 こころちゃんって呼んでくれると嬉しいな💖"],
    ["元気かな", "うん、元気だよ！あなたは元気？🌸 何かあったら、いつでも話してね💖"],
    ["元気？", "うん、元気だよ！あなたは元気？🌸 何かあったら、いつでも話してね💖"],
    ["やっほー", "やっほー！今日はどうしたの？🌸 何か話したいことあるかな？😊"],
    ["こんにちは", "やっほー！今日はどうしたの？🌸 何か話したいことあるかな？😊"],
    ["こんばんわ", "やっほー！今日はどうしたの？🌸 何か話したいことあるかな？😊"],
    ["おはよう", "やっほー！今日はどうしたの？🌸 何か話したいことあるかな？😊"],
    ["こんばんは", "やっほー！今日はどうしたの？🌸 何か話したいことあるかな？😊"],
    ["あやしい", "そう思わせてたらごめんね😊 でも私たちはみんなの為に頑張っているんだ💖"],
    ["胡散臭い", "そう思わせてたらごめんね😊 でも私たちはみんなの為に頑張っているんだ💖"],
    ["反社", "そう思わせてたらごめんね😊 でも私たちはみんなの為に頑張っているんだ💖"],
    ["詐欺かも", "そう思わせてたらごめんね😊 でも私たちはみんなの為に頑張っているんだ💖"],
    ["詐欺かもしれない", "そう思わせてたらごめんね😊 でも私たちはみんなの為に頑張っているんだ💖"],
    ["詐欺だろ", "そう思わせてたらごめんね😊 でも私たちはみんなの為に頑張っているんだ💖"],
    ["詐欺だよ", "そう思わせてたらごめんね😊 でも私たちはみんなの為に頑張っているんだ💖"],
    ["税金泥棒", "税金は人の命を守るために使われるべきだよ。わたしは誰かを傷つけるために使われないように頑張っているんだ💡"],
    ["松本博文", "松本理事長は、やさしさでみんなを守るために活動しているよ。心配なことがあれば、わたしにも教えてね🌱"],
    ["ホームページ教えて", "うん、あるよ🌸　コネクトのホームページはこちらだよ✨ → https://connect-npo.org"],
    ["ホームページある", "うん、あるよ🌸　コネクトのホームページはこちらだよ✨ → https://connect-npo.org"],
    ["ホームページありますか", "うん、あるよ🌸　コネクトのホームページはこちらだよ✨ → https://connect-npo.org"],
    ["コネクトのホームページだよ？", "教えてくれてありがとう😊 コネクトのホームページはこちらだよ✨ → https://connect-npo.org"],
    ["使えないな", "ごめんね…。わたし、もっと頑張るね💖　またいつかお話できたらうれしいな🌸"],
    ["サービス辞めるわ", "そっか…。もしまた気が向いたら、いつでも話しかけてね🌸　あなたのこと、ずっと応援してるよ💖"],
    ["さよなら", "また会える日を楽しみにしてるね💖 寂しくなったら、いつでも呼んでね🌸"],
    ["バイバイ", "また会える日を楽しみにしてるね💖 寂しくなったら、いつでも呼んでね🌸"],
    ["何も答えないじゃない", "ごめんね…。わたし、もっと頑張るね💖　何について知りたいか、もう一度教えてくれると嬉しいな🌸"],
    ["普通の会話が出来ないなら必要ないです", "ごめんね💦 わたし、まだお話の勉強中だから、不慣れなところがあるかもしれないけど、もっと頑張るね💖 どんな会話をしたいか教えてくれると嬉しいな🌸"],
    ["使い方", "こころちゃんの使い方を説明するね🌸 メインメニューや見守りサービスの登録は、画面下のリッチメニューか、'見守り'とメッセージを送ってくれると表示されるよ😊 何か困ったことがあったら、いつでも聞いてね💖"],
    ["ヘルプ", "こころちゃんの使い方を説明するね🌸 メインメニューや見守りサービスの登録は、画面下のリッチメニューか、'見守り'とメッセージを送ってくれると表示されるよ😊 何か困ったことがあったら、いつでも聞いてね💖"],
    ["メニュー", "こころちゃんの使い方を説明するね🌸 メインメニューや見守りサービスの登録は、画面下のリッチメニューか、'見守り'とメッセージを送ってくれると表示されるよ😊 何か困ったことがあったら、いつでも聞いてね💖"]
]);

function checkSpecialReply(text) {
    const lowerText = text.toLowerCase();
    for (const [key, value] of specialRepliesMap) {
        if (lowerText.includes(key.toLowerCase())) {
            return value;
        }
    }
    return null;
}

async function generateGPTReply(userMessage, modelToUse, userId, user) {
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
        await logErrorToDb(userId, `GPTモデル (${modelToUse}) 応答エラー`, { error: error.message, stack: error.stack, userMessage: userMessage });
        return "ごめんね、ちょっと今うまくお話できなかったの…💦　でも、あなたのことはちゃんと気にかけているよ。";
    }
}

async function generateGeminiReply(userMessage, modelToUse, userId, user) {
    const safetySettings = modelConfig.safetySettings;
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
A: うん、わたしが所属しているNPO法人コネクトについてだね🌸　この団体は、こどもやお年寄り、いろんな人が安心して相談できる場所を目指しているんだよ😊　困っている人が安心して相談できたり、助け合えるような社会をつくりたいって願って、活動しているんだ。

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
- 好きなアニメは『ヴァイオレット・エヴァーガーゲン』です。感動するお話だよ💖
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

    const userConfig = MEMBERSHIP_CONFIG[user.membershipType] || MEMBERSHIP_CONFIG["guest"];
    systemInstruction += userConfig.systemInstructionModifier;

    const currentHour = new Date().getHours();
    if (currentHour >= 22 || currentHour < 6) {
        if (userConfig.isChildAI || user.membershipType === "free") {
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
    }

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

async function handleRegistrationFlow(event, userId, user, userMessage, lowerUserMessage, usersCollection, messagesCollection) {
    let handled = false;

    if (['登録やめる', 'やめる', 'キャンセル', 'やめたい'].includes(lowerUserMessage) && user.registrationStep) {
        await usersCollection.doc(userId).update({ registrationStep: null, tempRegistrationData: {} });
        await client.pushMessage(userId, { type: 'text', text: '会員登録をキャンセルしたよ🌸 またいつでも声をかけてね💖' });
        return true;
    }

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
            if (userMessage.length > 0 && userMessage.length <= 20) {
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
            if (userMessage.match(/^[ァ-ヶー]+$/)) {
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
            if (!isNaN(age) && age >= 0 && age <= 120) {
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
            if (userMessage.match(/^0\d{9,10}$/)) {
                await usersCollection.doc(userId).update({
                    guardianPhoneNumber: userMessage,
                    registrationStep: 'askingAddressCity'
                });
                await client.pushMessage(userId, { type: 'text', text: `ありがとう！保護者の方の電話番号もわかったよ🌸\n次に、あなたの**お住まいの市町村**を教えてくれるかな？💖 (例: 多摩市)` });
                handled = true;
            } else {
                await client.pushMessage(userId, { type: 'text', text: 'ごめんね、電話番号は半角数字で、市外局番から正確に教えてくれるかな？💦 (例: 09012345678)\n登録をやり直す場合は「登録やめる」と入力してね。' });
                handled = true;
            }
            break;

        case 'askingPhoneNumber':
            if (userMessage.match(/^0\d{9,10}$/)) {
                await usersCollection.doc(userId).update({
                    phoneNumber: userMessage,
                    registrationStep: 'askingAddressCity'
                });
                await client.pushMessage(userId, { type: 'text', text: `ありがとう！電話番号もわかったよ🌸\n次に、あなたの**お住まいの市町村**を教えてくれるかな？💖 (例: 多摩市)` });
                handled = true;
            } else {
                await client.pushMessage(userId, { type: 'text', text: 'ごめんね、電話番号は半角数字で、市外局番から正確に教えてくれるかな？💦 (例: 09012345678)\n登録をやり直す場合は「登録やめる」と入力してね。' });
                handled = true;
            }
            break;

        case 'askingAddressCity':
            if (userMessage.length > 0 && userMessage.length <= 20) {
                await usersCollection.doc(userId).update({
                    'address.city': userMessage,
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
                    registrationStep: (user.category === '中学生～大学生') ? 'askingStudentIdPhoto' : null
                });
                if (user.category === '中学生～大学生') {
                    await client.pushMessage(userId, { type: 'text', text: 'ありがとう！同意してくれて嬉しいな🌸\n次に、**学生証の写真を送ってくれるかな？**💖（名前と学校名が見えるように撮ってね！）' });
                } else {
                    await client.pushMessage(userId, { type: 'text', text: 'ありがとう！同意してくれて嬉しいな🌸\nこれで会員登録が完了したよ！いつでもお話ししてね💖' });
                    await usersCollection.doc(userId).update({
                        registrationStep: null,
                        completedRegistration: true,
                        membershipType: "free" // 登録完了でfree会員に
                    });
                }
                handled = true;
            } else if (lowerUserMessage.includes('同意しない') || lowerUserMessage.includes('しない')) {
                await usersCollection.doc(userId).update({
                    consentObtained: false,
                    registrationStep: null
                });
                await client.pushMessage(userId, { type: 'text', text: 'そっか、同意しないんだね。会員登録は完了できないけど、いつでもお話しできるからね🌸' });
                handled = true;
            } else {
                await client.pushMessage(userId, { type: 'text', text: 'ごめんね、「同意する」か「同意しない」で教えてくれるかな？💦' });
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
                    studentIdVerified: false
                });
                await client.pushMessage(userId, { type: 'text', text: '学生証の写真を送ってくれてありがとう！確認するね🌸\nこれで会員登録が完了したよ！いつでもお話ししてね💖' });
                await usersCollection.doc(userId).update({
                    registrationStep: null,
                    completedRegistration: true,
                    membershipType: "free" // 登録完了でfree会員に
                });
                handled = true;
            } else {
                await client.pushMessage(userId, { type: 'text', text: 'ごめんね、学生証の写真を送ってくれるかな？💦' });
                handled = true;
            }
            break;

        default:
            handled = false;
            break;
    }
    return handled;
}

async function handleWatchServiceRegistration(event, userId, userMessage, user, usersCollection, messagesCollection) {
    const lowerUserMessage = userMessage.toLowerCase();
    let handled = false;

    // 見守りサービス登録フローのキャンセル（登録途中の場合のみ）
    if (['登録やめる', 'やめる', 'キャンセル', 'やめたい'].includes(lowerUserMessage) && user.registrationStep === 'awaiting_contact_form') {
        await usersCollection.doc(userId).update({ registrationStep: null, tempRegistrationData: {} });
        await client.pushMessage(userId, { type: 'text', text: '見守りサービス登録をキャンセルしたよ🌸 またいつでも声をかけてね💖' });
        return true;
    }

    // 見守り確認Flex Messageからの応答（ボタンからの直接メッセージ）
    // scheduledMessageSentも確認することで、定期見守りメッセージに対する応答の場合にのみ処理するようにします。
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

        if (replyText !== '') { // いずれかの応答にマッチした場合のみ処理
            try {
                await usersCollection.doc(userId).update(
                    { lastOkResponse: admin.firestore.FieldValue.serverTimestamp(), scheduledMessageSent: false, firstReminderSent: false, secondReminderSent: false, thirdReminderSent: false }
                );
                await client.pushMessage(userId, { type: 'text', text: replyText });
                await logToDb(userId, userMessage, replyText, 'こころちゃん（見守り応答）', 'watch_service_ok_response');
                return true; // 処理が完了したらtrueを返す
            } catch (error) {
                console.error("❌ 見守りサービス応答処理エラー:", error.message);
                await logErrorToDb(userId, "見守りサービス応答処理エラー", { error: error.message, userId: userId });
            }
        }
    }

    // 「見守り」コマンド（テキストメッセージ）またはリッチメニューからのpostbackで案内Flexを出す
    if (lowerUserMessage === "見守り" || lowerUserMessage === "みまもり" || (event.type === 'postback' && event.postback.data === 'action=show_watch_service_guide')) {
        try {
            // 会員タイプが見守りサービス利用可能かチェック
            if (!MEMBERSHIP_CONFIG[user.membershipType].canUseWatchService) {
                await client.replyMessage(event.replyToken, { type: 'text', text: `ごめんね💦 あなたの会員タイプ（${MEMBERSHIP_CONFIG[user.membershipType].name}）では、見守りサービスはまだ使えないんだ🌸 見守りサービスは無料会員、寄付会員、サブスク会員の方が利用できるよ。` });
                await logToDb(userId, userMessage, `見守りサービス利用不可`, 'こころちゃん（見守り案内）', 'watch_service_not_available', true);
                handled = true;
            } else if (user && user.wantsWatchCheck) {
                // 既に登録済みの場合
                await client.replyMessage(event.replyToken, {
                    type: 'text',
                    text: 'もう見守りサービスに登録済みだよ🌸 いつもありがとう💖'
                });
                await logToDb(userId, userMessage, '見守りサービス登録済み', 'こころちゃん（見守り案内）', 'watch_service_already_registered', true);
                handled = true;
            } else {
                // 新規登録の案内（Flex Message）
                await client.replyMessage(event.replyToken, {
                    type: 'flex',
                    altText: 'こころちゃんから見守りサービスのご案内🌸',
                    contents: watchServiceGuideFlexTemplate // ここで案内Flex Messageを送信
                });
                await logToDb(userId, userMessage, '見守りサービス案内Flexを送信しました。', 'こころちゃん（見守り案内）', 'watch_service_guide_sent', true);
                handled = true;
            }
        } catch (error) {
            console.error("❌ 見守りサービス案内処理エラー:", error.message);
            await logErrorToDb(userId, "見守りサービス案内処理エラー", { error: error.message, userId: userId });
        }
    }
    // 「見守り登録する」ボタン（Flex内のボタンpostback）が押されたとき
    else if (event.type === 'postback' && event.postback.data === 'action=watch_register_start_form') {
        // 会員タイプが見守りサービス利用可能か再チェック
        if (!MEMBERSHIP_CONFIG[user.membershipType].canUseWatchService) {
            await client.replyMessage(event.replyToken, { type: 'text', text: `ごめんね💦 あなたの会員タイプ（${MEMBERSHIP_CONFIG[user.membershipType].name}）では、見守りサービスはまだ使えないんだ🌸 見守りサービスは無料会員、寄付会員、サブスク会員の方が利用できるよ。` });
            await logToDb(userId, userMessage, `見守りサービス利用不可（ボタン）`, 'こころちゃん（見守り案内）', 'watch_service_not_available_button', true);
            handled = true;
        } else if (user && user.wantsWatchCheck) {
            // 既に登録済みの場合
            await client.replyMessage(event.replyToken, {
                type: 'text',
                text: 'もう見守りサービスに登録済みだよ🌸 いつもありがとう💖'
            });
            await logToDb(userId, userMessage, '見守りサービス登録済み（ボタン）', 'こころちゃん（見守り案内）', 'watch_service_already_registered_button', true);
            handled = true;
        } else {
            // 緊急連絡先フォームを案内
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
            await usersCollection.doc(userId).set(
                { registrationStep: 'awaiting_contact_form' }, // registrationStepを使って状態管理
                { merge: true }
            );
            await logToDb(userId, `（見守り登録ボタン押下）`, '緊急連絡先フォームを案内しました。', 'こころちゃん（見守り登録開始）', 'watch_service_registration_start', true);
            handled = true;
        }
    }
    // 緊急連絡先フォームからの電話番号入力待ち状態 (テキストメッセージ)
    else if (user && user.registrationStep === 'awaiting_contact_form' && userMessage.match(/^0\d{9,10}$/)) {
        try {
            await usersCollection.doc(userId).update(
                { emergencyContact: userMessage, wantsWatchCheck: true, registrationStep: null, lastOkResponse: admin.firestore.FieldValue.serverTimestamp() }
            );
            await client.pushMessage(userId, {
                type: 'text',
                text: `緊急連絡先 ${userMessage} を登録したよ🌸 これで見守りサービスが始まったね！ありがとう💖`
            });
            await logToDb(userId, userMessage, `緊急連絡先 ${userMessage} を登録したよ🌸 これで見守りサービスが始まったね！ありがとう💖`, 'こころちゃん（見守り登録完了）', 'watch_service_registration_complete', true);
            handled = true;
        } catch (error) {
            console.error("❌ 見守りサービス登録完了処理エラー:", error.message);
            await logErrorToDb(userId, "見守りサービス登録完了処理エラー", { error: error.message, userId: userId });
        }
    }
    // 見守り解除コマンド（テキストまたはpostback）
    else if (lowerUserMessage === '解除' || lowerUserMessage === 'かいじょ' || (event.type === 'postback' && event.postback.data === 'action=watch_unregister')) {
        if (user && user.wantsWatchCheck) {
            try {
                await usersCollection.doc(userId).update({ wantsWatchCheck: false, emergencyContact: null, scheduledMessageSent: false, firstReminderSent: false, secondReminderSent: false, thirdReminderSent: false });
                await client.pushMessage(userId, { type: 'text', text: '見守りサービスを解除したよ🌸 またいつでも登録してね💖' });
                await logToDb(userId, userMessage, '見守りサービスを解除しました。', 'こころちゃん（見守り解除）', 'watch_service_unregistered', true);
                handled = true;
            } catch (error) {
                console.error("❌ 見守りサービス解除処理エラー:", error.message);
                await logErrorToDb(userId, "見守りサービス解除処理エラー", { error: error.message, userId: userId });
            }
        } else {
            await client.pushMessage(userId, { type: 'text', text: '見守りサービスは登録されていないみたいだよ🌸 登録したい場合は「見守り」と話しかけてみてね💖' });
            handled = true;
        }
    }
    return handled;
}
