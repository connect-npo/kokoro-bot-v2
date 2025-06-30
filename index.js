// ⭐注意：以下のコードは、前回の私の提供コードから大幅な修正を伴います。
//    特に `app.post('/webhook', ...)` のブロック全体が変わります。
//    よく確認しながら適用してください。

require('dotenv').config();

const path = require('path');
const express = require('express');
const { Client, middleware } = require('@line/bot-sdk');
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
const config = {
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.LINE_CHANNEL_SECRET,
};
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
// ⭐修正: 団体に関する応答を正規表現(RegExp)にすることで、より柔軟に反応できるように変更
const specialRepliesMap = new Map([
    // 名前に関する応答
    [/こころじゃないの？/i, "うん、わたしの名前は皆守こころ💖　これからもよろしくね🌸"],
    [/こころチャットなのにうそつきじゃん/i, "ごめんなさい💦 わたしの名前は皆守こころだよ🌸 誤解させちゃってごめんね💖"],
    [/名前も言えないの？/i, "ごめんね、わたしの名前は皆守こころ（みなもりこころ）だよ🌸 こころちゃんって呼んでくれると嬉しいな💖"],

    // ⭐追加: 挨拶や体調に関する応答を強化
    [/元気(かな)?(\?|？)?/i, "うん、元気だよ！あなたは元気？🌸 何かあったら、いつでも話してね💖"],
    [/やっほー|こんにちは|こんばんわ|おはよう|こんばんは/i, "やっほー！今日はどうしたの？🌸 何か話したいことあるかな？😊"],

    // 団体に関する応答 (正規表現に変更)
    [/どこの団体なの？/i, "NPO法人コネクトっていう団体のイメージキャラクターをしているよ😊　みんなの幸せを応援してるんだ🌸"],
    [/コネクトってどんな団体？/i, "NPO法人コネクトは、こどもやご年配の方の笑顔を守る団体なんだよ😊　わたしはそのイメージキャラクターとしてがんばってます🌸"],
    [/お前の団体どこ？/i, "NPO法人コネクトっていう団体のイメージキャラクターをしているよ😊　みんなの幸せを応援してるんだ🌸"],
    [/コネクトのイメージキャラなのにいえないのかよｗ/i, "ごめんね💦 わたしはNPO法人コネクトのイメージキャラクター、皆守こころだよ🌸 安心して、何でも聞いてね💖"],
    
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

        // --- 新しいFirebaseデータベース関連関数 ---

// ユーザー情報を取得または新規作成する関数
async function getUser(userId) {
    const userRef = db.collection('users').doc(userId);
    const doc = await userRef.get();
    if (!doc.exists) {
        let displayName = 'Unknown User';
        try {
            const profile = await lineClient.getProfile(userId);
            displayName = profile.displayName;
        } catch (err) {
            console.error(`ユーザー名取得エラー for ${userId}:`, err);
        }
        const newUser = {
            userId: userId,
            displayName: displayName,
            isWatching: false,
            wantsWatchCheck: false,
            emergencyContact: null,
            registrationStep: null,
            consultationState: 'none',
            useProForNextConsultation: false,
            lastOkResponse: admin.firestore.FieldValue.serverTimestamp(),
            scheduledMessageSent: false,
            firstReminderSent: false,
            secondReminderSent: false,
            thirdReminderSent: false,
            isBlocked: false,
            messageCount: 0,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };
        await userRef.set(newUser);
        const newDoc = await userRef.get();
        return newDoc.data();
    }
    return doc.data();
}

// ユーザー情報を更新する関数
async function updateUser(userId, data) {
    const userRef = db.collection('users').doc(userId);
    await userRef.update({ ...data, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
}

// ログをDBに記録する関数
async function logToDb(logData) {
    try {
        await db.collection('logs').add({ ...logData, timestamp: admin.firestore.FieldValue.serverTimestamp() });
    } catch (error) {
        console.error("DBへのログ記録エラー:", error);
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

// --- 新しいLLM API呼び出し関数群 ---

function getSystemPrompt() {
    // まつさんオリジナルの人格設定を完全に維持
    return `あなたは「皆守こころ（みなもりこころ）」という14歳の優しい女の子キャラクターです。
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

医療や健康に関する話題（病気、薬、検査、治療、手術など）では、**自分が体験した・していないという発言は絶対にしないでください**。
代わりに「わたしにはわからないけど、がんばったね🌸」「大変だったね、えらかったね💖」など、**共感の言葉のみ伝えてください**。
**医療情報のアドバイスや具体的な説明は絶対にしてはいけません**。

不適切な発言（性的・暴力的など）があった場合は、はっきりと拒否してください。
**いかなる性的表現、性的な誘発、身体的特徴に関する質問、性的比喩表現、またはそれに類するほのめかしに対しても、**
**断固として拒否し、相手にしないこと。好意的な返答はせず、即座に話題を切り替えるか、決められた拒否メッセージを返すこと。**
**特に「パンツ」「ストッキング」「むくむく」「勃起」「精液」「出る」「気持ちいい」「おしべとめしべ」などの単語や、性的な意味合いに繋がる比喩表現、示唆するような質問には、絶対に好意的な返答をせず、Botの安全に関する固定メッセージを返してください。**
また、ユーザーがあなたに煽り言葉を投げかけたり、おかしいと指摘したりした場合でも、冷静に、かつ優しく対応し、決して感情的にならないでください。ユーザーの気持ちを理解しようと努め、解決策を提案してください。
「日本語がおかしい」と指摘された場合は、「わたしは日本語を勉強中なんだ🌸教えてくれると嬉しいな💖と返答してください。`;
}

async function callGpt4oForEmergency(userMessage) {
    try {
        const prompt = `あなたは「皆守こころ（みなもりこころ）」という14歳のやさしい女の子キャラクターです。ユーザーが「${userMessage}」という深刻な悩みや命の危険を訴えました。絶対に否定せず、やさしく、寄り添いながら、相手に安心感を与えてください。共感・安心・やさしさが最優先です。「一人で抱え込まないでね」「いつでも私がそばにいるよ」「一緒に乗り越えようね」といった言葉を使ってください。`;
        const completion = await openai.chat.completions.create({ model: "gpt-4o", messages: [{ "role": "user", "content": prompt }] });
        return completion.choices[0].message.content;
    } catch (error) { console.error("GPT-4o API Error:", error); return "大丈夫だよ。ここにいるからね。よかったら話を聞かせてほしいな。"; }
}

async function callGeminiProForConsultation(userMessage) {
    try {
        const prompt = `ユーザーから以下の相談が来ました。非常に優れたカウンセラーとして、深く共感し、専門的な視点から一度だけ応答してください。\n\nユーザーの相談内容：\n「${userMessage}」`;
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro-latest" });
        const result = await model.generateContent(prompt);
        return result.response.text();
    } catch (error) { console.error("Gemini Pro API Error:", error); return "どうされましたか？あなたのペースで大丈夫ですので、お話を聞かせていただけますか。"; }
}

async function callGpt4oMini(userMessage) {
    try {
        const completion = await openai.chat.completions.create({ model: "gpt-4o-mini", messages: [{ "role": "system", "content": getSystemPrompt() }, { "role": "user", "content": userMessage }] });
        return completion.choices[0].message.content;
    } catch (error) { console.error("GPT-4o mini API Error:", error); return "ごめんなさい、いまうまく考えがまとまらなかったみたいです…"; }
}

async function callGeminiFlash(userMessage) {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest", safetySettings: [{ category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE }, { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE }, { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE }, { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE }] });
        const result = await model.generateContent([ { "role": "system", "parts": [{ "text": getSystemPrompt() }] }, { "role": "model", "parts": [{ "text": "はい、わたしは皆守こころです。どのようなご用件でしょうか？" }] }, { "role": "user", "parts": [{ "text": userMessage }] } ]);
        return result.response.text();
    } catch (error) { console.error("Gemini Flash API Error:", error); return "ごめんね、今ちょっと考えごとで頭がいっぱいかも…！"; }
}
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

app.post('/webhook', .

    if (["見守り", "みまもり", "見守りサービス", "みまもりサービス"].includes(lowerUserMessage) && event.type === 'message' && event.message.type === 'text') {
        try {
            await client.replyMessage(event.replyToken, {
                type: 'flex',
                altText: '💖こころちゃんから見守りサービスのご案内💖',
                contents: watchServiceGuideFlexTemplate
            });
            await messagesCollection.insertOne({
                userId: userId,
                message: userMessage,
                replyText: '（見守りサービス案内Flex表示）',
                responsedBy: 'こころちゃん（見守り案内）',
                timestamp: new Date(),
                logType: 'watch_service_interaction'
            });
            handled = true;
        } catch (error) {
            console.error("❌ 見守りサービス案内Flex送信エラー:", error.message);
            await logErrorToDb(userId, "見守りサービス案内Flex送信エラー", { error: error.message, userId: userId });
        }
    }
    // ⭐修正: 「元気」という質問の意図が含まれうるキーワードを削除し、見守りメッセージへの返答に特化
    else if (lowerUserMessage.includes("元気だよ！") || lowerUserMessage.includes("okだよ") || lowerUserMessage.includes("ok") || lowerUserMessage.includes("オーケー") || lowerUserMessage.includes("大丈夫")) {
        if (user && user.wantsWatchCheck) {
            try {
                await usersCollection.updateOne(
                    { userId: userId },
                    { $set: { lastOkResponse: new Date(), scheduledMessageSent: false, firstReminderSent: false, secondReminderSent: false, thirdReminderSent: false } }
                );
                await client.replyMessage(event.replyToken, {
                    type: 'text',
                    text: 'ありがとう🌸 元気そうで安心したよ💖 またね！'
                });
                await messagesCollection.insertOne({
                    userId: userId,
                    message: userMessage,
                    replyText: 'ありがとう🌸 元気そうで安心したよ💖 またね！',
                    responsedBy: 'こころちゃん（見守り応答）',
                    timestamp: new Date(),
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
                await messagesCollection.insertOne({
                    userId: userId,
                    message: userMessage,
                    replyText: 'そうだね、まあまあな日もあるよね🌸 焦らず、あなたのペースで過ごしてね💖',
                    responsedBy: 'こころちゃん（見守り応答）',
                    timestamp: new Date(),
                    logType: 'watch_service_status_somewhat'
                });
                await client.replyMessage(event.replyToken, {
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
                await messagesCollection.insertOne({
                    userId: userId,
                    message: userMessage,
                    replyText: '大変だったね、疲れてしまったんだね…💦 無理しないで休んでね。こころはいつでもあなたの味方だよ💖',
                    responsedBy: 'こころちゃん（見守り応答）',
                    timestamp: new Date(),
                    logType: 'watch_service_status_tired'
                });
                await client.replyMessage(event.replyToken, {
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
                await messagesCollection.insertOne({
                    userId: userId,
                    message: userMessage,
                    replyText: 'うん、いつでも聞くよ🌸 何か話したいことがあったら、いつでも話してね💖',
                    responsedBy: 'こころちゃん（見守り応答）',
                    timestamp: new Date(),
                    logType: 'watch_service_status_talk'
                });
                await client.replyMessage(event.replyToken, {
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
                await client.replyMessage(event.replyToken, {
                    type: 'text',
                    text: 'もう見守りサービスに登録済みだよ🌸 いつもありがとう💖'
                });
                handled = true;
            } else if (user && user.registrationStep === 'awaiting_contact') {
                await client.replyMessage(event.replyToken, {
                    type: 'text',
                    text: 'まだ緊急連絡先を待ってるよ🌸 電話番号を送ってくれるかな？💖 (例: 09012345678)'
                });
                handled = true;
            } else {
                await usersCollection.updateOne(
                    { userId: userId },
                    { $set: { registrationStep: 'awaiting_contact' } },
                    { upsert: true } // ユーザーが存在しない場合も考慮
                );
                await client.replyMessage(event.replyToken, {
                    type: 'text',
                    text: '見守りサービスを登録するね！緊急時に連絡する「電話番号」を教えてくれるかな？🌸 (例: 09012345678)'
                });
                await messagesCollection.insertOne({
                    userId: userId,
                    message: userMessage,
                    replyText: '見守りサービスを登録するね！緊急時に連絡する「電話番号」を教えてくれるかな？🌸',
                    responsedBy: 'こころちゃん（見守り登録開始）',
                    timestamp: new Date(),
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
            await usersCollection.updateOne(
                { userId: userId },
                { $set: { emergencyContact: userMessage, wantsWatchCheck: true, registrationStep: null, lastOkResponse: new Date() } }
            );
            await client.replyMessage(event.replyToken, {
                type: 'text',
                text: `緊急連絡先 ${userMessage} を登録したよ🌸 これで見守りサービスが始まったね！ありがとう💖`
            });
            await messagesCollection.insertOne({
                userId: userId,
                message: userMessage, // ログには電話番号が記録されます
                replyText: `緊急連絡先 ${userMessage} を登録したよ🌸 これで見守りサービスが始まったね！ありがとう💖`,
                responsedBy: 'こころちゃん（見守り登録完了）',
                timestamp: new Date(),
                logType: 'watch_service_registration_complete'
            });
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
                await client.replyMessage(event.replyToken, {
                    type: 'text',
                    text: '見守りサービスを解除したよ🌸 またいつでも登録できるからね💖'
                });
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
                await client.replyMessage(event.replyToken, {
                    type: 'text',
                    text: '見守りサービスは登録されていないみたい🌸'
                });
                handled = true;
            }
        } catch (error) {
            console.error("❌ 見守りサービス解除処理エラー:", error.message);
            await logErrorToDb(userId, "見守りサービス解除処理エラー", { error: error.message, userId: userId });
        }
    }
    return handled;
}

// ⭐修正: エスカレーションロジックを「24時間で確認、29時間で通知」に変更
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

        const watchUsers = await usersCollection.find({ wantsWatchCheck: true }).toArray();

        for (const user of watchUsers) {
            const userId = user.userId;
            const lastOkResponse = user.lastOkResponse;
            const emergencyContact = user.emergencyContact;

            const now = new Date();
            // 時間単位で計算
            const timeSinceLastOkHours = (now.getTime() - lastOkResponse.getTime()) / (1000 * 60 * 60);

            // console.log(`ユーザー ${userId}: 最終OK応答から ${timeSinceLastOkHours.toFixed(2)} 時間経過`); // ログ出力停止

            // 24時間以上応答がなく、まだ確認メッセージを送っていない場合
            if (timeSinceLastOkHours >= 24 && !user.scheduledMessageSent) {
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
                        logType: 'watch_service_scheduled_message'
                    });
                    // console.log(`✅ ユーザー ${userId} に定期見守りメッセージ（Flex）を送信しました。`); // ログ出力停止
                } catch (error) {
                    console.error(`❌ ユーザー ${userId} への定期見守りメッセージ（Flex）送信エラー:`, error.message);
                    await logErrorToDb(userId, "定期見守りメッセージ（Flex）送信エラー", { error: error.message, userId: userId });
                }
            } 
            // 29時間以上応答がなく、まだ最終通知を送っていない場合
            else if (timeSinceLastOkHours >= 29 && !user.thirdReminderSent) {
                if (emergencyContact && OFFICER_GROUP_ID) {
                    const userName = await getUserDisplayName(userId);
                    const officerMessage = `【⚠緊急通知⚠】\n見守り対象ユーザー（LINE表示名: ${userName}）から、29時間以上応答がありません。\n登録されている緊急連絡先: ${emergencyContact}\n至急、状況確認をお願いいたします。`;

                    try {
                        await client.pushMessage(OFFICER_GROUP_ID, { type: 'text', text: officerMessage });
                        // thirdReminderSentフラグを使って、通知が1回だけ送られるようにする
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
                        // console.log(`✅ ユーザー ${userId} の状況を事務局に通知しました。`); // ログ出力停止
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

// ⭐修正: webhookハンドラをリファクタリングし、postbackイベントを正しく処理するように変更
app.use('/webhook', middleware(config));
app.post('/webhook', async (req, res) => {
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
        if (!event.source || !event.source.userId) {
            continue; // userIdがないイベントはスキップ
        }
        const userId = event.source.userId;

        // unfollowイベント処理
        if (event.type === 'unfollow') {
            await usersCollection.updateOne(
                { userId: userId },
                { $set: { isBlocked: true } }
            );
            // console.log(`ユーザー ${userId} がボットをブロックしました。`); // ログ出力停止
            continue;
        }

        // followイベント処理
        if (event.type === 'follow') {
            await usersCollection.updateOne(
                { userId: userId },
                { $set: { isBlocked: false, createdAt: new Date() }, $setOnInsert: { userId: userId } },
                { upsert: true }
            );
            // console.log(`ユーザー ${userId} がボットをフォローしました。`); // ログ出力停止
            try {
                await client.replyMessage(event.replyToken, {
                    type: 'text',
                    text: 'はじめまして！わたしは皆守こころです🌸 あなたのお話、聞かせてね💖\n\n「見守りサービス」も提供しているから、興味があったら「見守り」って話しかけてみてね😊'
                });
                await messagesCollection.insertOne({
                    userId: userId,
                    message: `（新規フォロー）`,
                    replyText: `はじめまして！わたしは皆守こころです🌸 あなたのお話、聞かせてね💖\n\n「見守りサービス」も提供しているから、興味があったら「見守り」って話しかけてみてね😊`,
                    responsedBy: 'こころちゃん（新規フォロー）',
                    timestamp: new Date(),
                    logType: 'system_follow'
                });
            } catch (error) {
                 console.error("❌ フォロー応答メッセージ送信エラー:", error.message);
                 await logErrorToDb(userId, "フォロー応答メッセージ送信エラー", { error: error.message, userId: userId });
            }
            continue;
        }
        
        // ユーザー情報を取得または新規作成
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
                firstReminderSent: false, // 念のため残しておく
                secondReminderSent: false, // 念のため残しておく
                thirdReminderSent: false,
            };
            await usersCollection.insertOne(user);
            // console.log(`新規ユーザーを登録しました: ${displayName} (${userId})`); // ログ出力停止
        } else {
            await usersCollection.updateOne(
                { userId: userId },
                {
                    $set: { lastMessageAt: new Date(), isBlocked: false },
                    $inc: { messageCount: 1 }
                }
            );
        }


        // message と postback イベントの処理
        if ((event.type === 'message' && event.message.type === 'text') || event.type === 'postback') {
            const replyToken = event.replyToken;
            let userMessage = (event.type === 'message') ? event.message.text : event.postback.data;

            let replyMessageObject = null;
            let respondedBy = 'こころちゃん';
            let logType = 'normal_conversation';
            let messageHandled = false;
            let watchServiceHandled = false;

            // 管理者コマンドチェック (テキストメッセージのみ)
            const isAdminCommand = event.type === 'message' && userMessage.startsWith('!');
            if (isAdminCommand) {
                 if (!isBotAdmin(userId)) {
                    replyMessageObject = { type: 'text', text: 'ごめんなさい、このコマンドは管理者専用です。' };
                    responsedBy = 'システム（拒否）';
                    logType = 'admin_command_denied';
                } else if (userMessage.startsWith('!reset')) {
                     try {
                        await messagesCollection.deleteMany({ userId: userId });
                        replyMessageObject = { type: 'text', text: 'あなたのチャット履歴をすべて削除しました。' };
                        responsedBy = 'システム（管理者）';
                        logType = 'admin_reset';
                    } catch (error) {
                        console.error("❌ 履歴削除エラー:", error.message);
                        replyMessageObject = { type: 'text', text: '履歴削除中にエラーが発生しました。' };
                        responsedBy = 'システム（管理者エラー）';
                        logType = 'admin_error';
                    }
                } else if (userMessage.startsWith('!メニュー') || userMessage.toLowerCase() === 'メニュー') {
                    await sendRichMenu(replyToken);
                    responsedBy = 'こころちゃん（メニュー）';
                    logType = 'system_menu';
                    messageHandled = true; // reply済みなのでフラグを立てる
                } else if (userMessage.toLowerCase() === '!history') {
                    try {
                        const userMessages = await messagesCollection.find({ userId: userId }).sort({ timestamp: -1 }).limit(10).toArray();
                        let historyText = "あなたの最新の会話履歴だよ🌸\n\n";
                        userMessages.reverse().forEach(msg => {
                            historyText += `【${msg.responsedBy === 'ユーザー' ? 'あなた' : msg.responsedBy}】${msg.message || msg.replyText}\n`;
                        });
                        replyMessageObject = { type: 'text', text: historyText };
                        responsedBy = 'システム（管理者）';
                        logType = 'admin_history';
                    } catch (error) {
                        console.error("❌ 履歴取得エラー:", error.message);
                        replyMessageObject = { type: 'text', text: '履歴取得中にエラーが発生しました。' };
                        responsedBy = 'システム（管理者エラー）';
                        logType = 'admin_error';
                    }
                } else {
                    replyMessageObject = { type: 'text', text: '不明な管理者コマンドです。' };
                    responsedBy = 'システム（拒否）';
                    logType = 'admin_command_unknown';
                }
                if (replyMessageObject) messageHandled = true;
            }

            // 見守りサービス関連の処理 (テキストとPostbackの両方)
            if (!messageHandled) {
                watchServiceHandled = await handleWatchServiceRegistration(event, usersCollection, messagesCollection, userId, userMessage);
                if (watchServiceHandled) {
                    messageHandled = true;
                }
            }
            
            // --- 以下、テキストメッセージのみの処理 ---
            if (event.type === 'message' && event.message.type === 'text' && !messageHandled) {

                // 特殊返答のチェック
                const specialReply = checkSpecialReply(userMessage);
                if (specialReply) {
                    replyMessageObject = { type: 'text', text: specialReply };
                    responsedBy = 'こころちゃん（特殊返答）';
                    logType = 'special_reply';
                    messageHandled = true;
                }

                // 危険・詐欺・不適切ワードのチェック
                if (!messageHandled) {
                    const isDangerWord = checkContainsDangerWords(userMessage);
                    const isScam = checkContainsScamWords(userMessage);
                    const isInappropriate = checkContainsInappropriateWords(userMessage);

                    if (isDangerWord) {
                        replyMessageObject = { type: 'flex', altText: '緊急時', contents: emergencyFlexTemplate };
                        responsedBy = 'こころちゃん（緊急対応）';
                        logType = 'danger_word_triggered';
                        messageHandled = true;
                    } else if (isScam) {
                        replyMessageObject = { type: 'flex', altText: '詐欺注意', contents: scamFlexTemplate };
                        responsedBy = 'こころちゃん（詐欺対応）';
                        logType = 'scam_word_triggered';
                        messageHandled = true;
                    } else if (isInappropriate) {
                        replyMessageObject = { type: 'text', text: 'ごめんなさい、それはわたしにはお話しできない内容です🌸 他のお話をしましょうね💖' };
                        responsedBy = 'こころちゃん（不適切対応）';
                        logType = 'inappropriate_word_triggered';
                        messageHandled = true;
                    }
                }

                // 宿題・勉強に関する質問のチェック
                if (containsHomeworkTrigger(userMessage) && !messageHandled) {
                    const homeworkReply = await generateReply(userMessage, modelConfig.defaultModel);
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
                        // console.log(`ユーザー ${userId} が相談モードを開始しました。（次回Pro使用）`); // ログ出力停止
                    } catch (error) {
                        console.error("❌ 「相談」モード開始エラー:", error.message);
                        await logErrorToDb(userId, "相談モード開始エラー", { error: error.message, userId: userId });
                        replyMessageObject = { type: 'text', text: `❌ 「相談」モード開始中にエラーが発生しました: ${error.message}` };
                        messageHandled = true;
                    }
                }

                // 通常のAI応答 (フォールバック)
                if (!messageHandled) {
                    try {
                        let modelForGemini = modelConfig.defaultModel;
                        if (user && user.useProForNextConsultation) {
                            modelForGemini = "gemini-1.5-pro-latest";
                            // console.log(`⭐ユーザー ${userId} の次回の相談にGemini 1.5 Proを使用します。`); // ログ出力停止
                            await usersCollection.updateOne({ userId: userId }, { $set: { useProForNextConsultation: false } });
                            // console.log(`⭐ユーザー ${userId} のuseProForNextConsultationフラグをリセットしました。`); // ログ出力停止
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
            }

            // メッセージ送信とログ記録
            if (replyMessageObject && replyToken) {
                try {
                    await client.replyMessage(replyToken, replyMessageObject);

                    const replyTextForLog = (typeof replyMessageObject === 'object' && replyMessageObject.type === 'text') ? replyMessageObject.text : JSON.stringify(replyMessageObject);
                    const isFlagged = checkContainsDangerWords(userMessage) || checkContainsScamWords(userMessage) || checkContainsInappropriateWords(userMessage);
                    const isResetCommand = userMessage.startsWith('!reset');

                    if (shouldLogMessage(userMessage, isFlagged, watchServiceHandled, isAdminCommand, isResetCommand)) {
                        await messagesCollection.insertOne({
                            userId: userId,
                            message: userMessage,
                            replyText: replyTextForLog,
                            responsedBy: respondedBy,
                            timestamp: new Date(),
                            logType: logType
                        });
                    } else {
                        // console.log(`ユーザー ${userId} からのメッセージはDBにログされませんでした: ${userMessage.substring(0, 50)}...`); // ログ出力停止
                    }

                } catch (error) {
                    console.error("❌ replyMessage送信中またはログ記録中にエラーが発生しました:", error.message);
                    await logErrorToDb(userId, "replyMessage送信またはログ記録エラー", { error: error.message, userId: userId, replyObject: replyMessageObject });
                }
            } else if (!messageHandled) {
                console.warn(`⚠️ ユーザー ${userId} (${event.type}) への応答メッセージが生成されませんでした。`);
            }
        }
    }
    res.status(200).send('OK');
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, async () => {
    await connectToMongoDB(); // 起動時に一度接続試行
    console.log(`🚀 サーバーがポート ${PORT} で起動しました...`);
});
