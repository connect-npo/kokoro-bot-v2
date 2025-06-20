// ⭐注意：以下のコードは、前回の私の提供コードから大幅な修正を伴います。
//   特に `app.post('/webhook', ...)` のブロック全体が変わります。
//   よく確認しながら適用してください。

require('dotenv').config();

const path = require('path');
const express = require('express');
const { Client } = require('@line/bot-sdk');
const { MongoClient } = require('mongodb');
const cron = require('node-cron');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const MONGODB_URI = process.env.MONGODB_URI;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
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

let dbInstance;

// JSONファイルを直接埋め込みます (これらは変更なし)
const dangerWords = [
    "しにたい", "死にたい", "自殺", "消えたい", "殴られる", "たたかれる", "リストカット", "オーバードーズ",
    "虐待", "パワハラ", "お金がない", "お金足りない", "貧乏", "死にそう", "DV", "無理やり",
    "いじめ", "イジメ", "ハラスメント"
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
    "クリトリス", "乳首", "おっぱい", "お尻", "うんち", "おしっこ", "小便", "大便", "ちんこ", "まんこ",
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

// specialRepliesMapを直接定義します (変更なし)
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
        return null;
    }
}

async function getUserDisplayName(userId) {
    try {
        const profile = await client.getProfile(userId);
        return profile.displayName;
    } catch (error) {
        console.error(`ユーザー ${userId} の表示名取得に失敗:`, error.message);
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

async function generateReply(userMessage) {
    const modelName = modelConfig.defaultModel;
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
        const model = genAI.getGenerativeModel({ model: modelName, safetySettings });

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
                ]
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
        await client.replyMessage(event.replyToken, {
            type: 'flex',
            altText: '💖こころちゃんから見守りサービスのご案内💖', // 代替テキストを追加
            contents: watchServiceGuideFlexTemplate
        });
        await messagesCollection.insertOne({
            userId: userId,
            message: userMessage,
            replyText: '（見守りサービス案内Flex表示）',
            respondedBy: 'こころちゃん（見守り案内）',
            timestamp: new Date(),
            logType: 'watch_service_interaction'
        });
        handled = true;
    }
    // 「OKだよ💖」などの安否確認応答
    else if (lowerUserMessage.includes("okだよ") || lowerUserMessage.includes("ok") || lowerUserMessage.includes("オーケー") || lowerUserMessage.includes("大丈夫") || lowerUserMessage.includes("げんき") || lowerUserMessage.includes("元気")) {
        if (user && user.wantsWatchCheck) {
            await usersCollection.updateOne(
                { userId: userId },
                { $set: { lastOkResponse: new Date(), scheduledMessageSent: false, firstReminderSent: false, secondReminderSent: false, thirdReminderSent: false } }
            );
            await client.replyMessage(event.replyToken, { type: 'text', text: 'ありがとう🌸 元気そうで安心したよ💖 またね！' });
            await messagesCollection.insertOne({
                userId: userId,
                message: userMessage,
                replyText: 'ありがとう🌸 元気そうで安心したよ💖 またね！',
                respondedBy: 'こころちゃん（見守り応答）',
                timestamp: new Date(),
                logType: 'watch_service_ok_response'
            });
            handled = true;
        }
    }
    else if (userMessage.includes("見守り登録します") || (event.type === 'postback' && event.postback.data === 'action=watch_register')) {
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
                { $set: { registrationStep: 'awaiting_contact' } }
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
    }
    else if (user && user.registrationStep === 'awaiting_contact' && userMessage.match(/^0\d{9,10}$/)) {
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
            message: userMessage,
            replyText: `緊急連絡先 ${userMessage} を登録したよ🌸 これで見守りサービスが始まったね！ありがとう💖`,
            responsedBy: 'こころちゃん（見守り登録完了）',
            timestamp: new Date(),
            logType: 'watch_service_registration_complete'
        });
        handled = true;
    }
    else if (userMessage.includes("見守り解除します") || (event.type === 'postback' && event.postback.data === 'action=watch_unregister')) {
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
            handled = true; // 登録されていない旨の応答もhandledとする
        }
    }

    return handled;
}

// sendScheduledWatchMessageはpushMessageを使うため変更なし。
// ただし、QuickReplyのボタン表示のために、pushMessageでは表示されないことを理解して運用する
// もし定期メッセージでQuickReplyが必須なら、別途WebhooksからのreplyMessageトリガーを検討する必要がある
async function sendScheduledWatchMessage() {
    console.log('--- 定期見守りメッセージ送信処理を開始します ---');
    const db = await connectToMongoDB();
    if (!db) {
        console.error('MongoDB接続失敗: 定期見守りメッセージを送信できません。');
        return;
    }
    const usersCollection = db.collection("users");
    const messagesCollection = db.collection("messages");
    const now = new Date();

    const users = await usersCollection.find({ wantsWatchCheck: true, isPermanentlyLocked: { $ne: true } }).toArray();

    for (const user of users) {
        let messageToSend = null;
        let logType = 'scheduled_watch_message';
        let respondedBy = 'こころちゃん（見守り）';

        const threeDaysAgo = new Date(now.getTime() - (3 * 24 * 60 * 60 * 1000));
        const lastActivity = user.lastOkResponse || user.createdAt;

        if (lastActivity < threeDaysAgo && !user.scheduledMessageSent) {
            const randomMessage = watchMessages[Math.floor(Math.random() * watchMessages.length)];
            // ⭐ここがpushMessageなのでQuickReplyは表示されない。テキストは届く
            messageToSend = {
                type: 'text',
                text: randomMessage,
                quickReply: {
                    items: [
                        {
                            type: "action",
                            action: {
                                type: "message",
                                label: "OKだよ💖",
                                text: "OKだよ💖"
                            }
                        }
                    ]
                }
            };
            await usersCollection.updateOne(
                { userId: user.userId },
                { $set: { scheduledMessageSent: true, scheduledMessageTimestamp: now, firstReminderSent: false, secondReminderSent: false, thirdReminderSent: false } }
            );
            console.log(`✉️ 初回見守りメッセージを送信しました（ユーザー: ${user.userId}）`);
            logType = 'scheduled_watch_message_initial';

        }
        else if (user.scheduledMessageSent && !user.firstReminderSent) {
            const twentyFourHoursAgo = new Date(now.getTime() - (24 * 60 * 60 * 1000));
            if (user.scheduledMessageTimestamp && user.scheduledMessageTimestamp < twentyFourHoursAgo) {
                messageToSend = { type: 'text', text: 'あれ？まだ返事がないみたい…心配だよ🌸 元気にしてるかな？「OKだよ💖」って教えてね！' };
                await usersCollection.updateOne(
                    { userId: user.userId },
                    { $set: { firstReminderSent: true, firstReminderTimestamp: now } }
                );
                console.log(`⏰ 1回目リマインダーを送信しました（ユーザー: ${user.userId}）`);
                logType = 'scheduled_watch_message_first_reminder';
            }
        }
        else if (user.firstReminderSent && !user.secondReminderSent) {
            const fiveHoursAgo = new Date(now.getTime() - (5 * 60 * 60 * 1000));
            if (user.firstReminderTimestamp && user.firstReminderTimestamp < fiveHoursAgo) {
                messageToSend = { type: 'text', text: 'どうしたのかな？とても心配だよ…何かあったら無理しないで連絡してね🌸 「OKだよ💖」で安心させてくれると嬉しいな。' };
                await usersCollection.updateOne(
                    { userId: user.userId },
                    { $set: { secondReminderSent: true, secondReminderTimestamp: now } }
                );
                console.log(`⏰ 2回目リマインダーを送信しました（ユーザー: ${user.userId}）`);
                logType = 'scheduled_watch_message_second_reminder';
            }
        }
        else if (user.secondReminderSent && !user.thirdReminderSent) {
            const twentyNineHoursAgoFromScheduled = new Date(user.scheduledMessageTimestamp.getTime() + (29 * 60 * 60 * 1000));
            if (now > twentyNineHoursAgoFromScheduled) {
                try {
                    const userDisplayName = await getUserDisplayName(user.userId);
                    const emergencyMessage = `⚠️ 緊急！ ${userDisplayName}さん（LINE ID: ${user.userId}）が、こころちゃん見守りサービスに29時間応答していません。登録された緊急連絡先 ${user.emergencyContact} へ連絡してください。`;

                    if (OWNER_USER_ID) {
                        await client.pushMessage(OWNER_USER_ID, { type: 'text', text: emergencyMessage });
                        console.log(`🚨 理事長へ緊急通知を送信しました（ユーザー: ${user.userId}）`);
                    }

                    if (OFFICER_GROUP_ID) {
                        await client.pushMessage(OFFICER_GROUP_ID, { type: 'text', text: emergencyMessage });
                        console.log(`🚨 オフィサーグループへ緊急通知を送信しました（ユーザー: ${user.userId}）`);
                    }

                    await usersCollection.updateOne(
                        { userId: user.userId },
                        { $set: { thirdReminderSent: true, thirdReminderTimestamp: now } }
                    );
                    await messagesCollection.insertOne({
                        userId: user.userId,
                        message: '(定期見守りメッセージ - 緊急連絡先通知)',
                        replyText: emergencyMessage,
                        responsedBy: 'こころちゃん（緊急通知）',
                        timestamp: now,
                        logType: 'scheduled_watch_message_emergency'
                    });
                } catch (error) {
                    console.error(`❌ 緊急連絡先通知の送信に失敗しました（ユーザー: ${user.userId}）:`, error.message);
                }
            }
            continue;
        }

        if (messageToSend) {
            try {
                await client.pushMessage(user.userId, messageToSend); // プッシュメッセージで送信
                await messagesCollection.insertOne({
                    userId: user.userId,
                    message: '(定期見守りメッセージ)',
                    replyText: messageToSend.text,
                    responsedBy: respondedBy,
                    timestamp: now,
                    logType: logType
                });
            } catch (error) {
                console.error(`❌ 定期見守りメッセージの送信に失敗しました（ユーザー: ${user.userId}）:`, error.message);
                await messagesCollection.insertOne({
                    userId: user.userId,
                    message: '(定期見守りメッセージ - 送信失敗)',
                    replyText: `送信失敗: ${error.message}`,
                    responsedBy: 'こころちゃん（システムエラー）',
                    timestamp: now,
                    logType: 'scheduled_watch_message_send_failed'
                });
            }
        }
    }
    console.log('✅ 定期見守りメッセージ送信処理を終了しました。');
}

cron.schedule('0 4 * * *', async () => {
    const db = await connectToMongoDB();
    if (!db) {
        console.error('MongoDB接続失敗: flaggedMessageCountのリセットができません。');
        return;
    }
    const usersCollection = db.collection("users");
    await usersCollection.updateMany(
        { isPermanentlyLocked: { $ne: true } },
        { $set: { flaggedMessageCount: 0, isAccountSuspended: false, suspensionReason: null } }
    );
    console.log("✅ 毎日 1 回、永久ロックされていない全ユーザーの flaggedMessageCount と日次サスペンド状態をリセットしました。");
}, {
    scheduled: true,
    timezone: "Asia/Tokyo"
});

cron.schedule('0 15 * * *', sendScheduledWatchMessage, {
    scheduled: true,
    timezone: "Asia/Tokyo"
});


// ⭐ここからWebhookエンドポイントの処理を大幅に修正します⭐
app.post('/webhook', async (req, res) => {
    const events = req.body.events;

    // イベントのループは変わらず
    for (const event of events) {
        const userId = event.source.userId;
        if (!userId) {
            console.warn('⚠️ userIdが取得できませんでした。グループイベントなどの可能性があります。');
            continue;
        }

        const db = await connectToMongoDB();
        if (!db) {
            console.error('MongoDB接続失敗: Webhookイベントを処理できません。');
            res.status(500).send('MongoDB connection failed'); // MongoDB接続エラーの場合はここでエラーを返す
            return; // 処理を終了
        }
        const usersCollection = db.collection("users");
        const messagesCollection = db.collection("messages");

        let user = await usersCollection.findOne({ userId: userId });
        if (!user) {
            user = {
                userId: userId,
                displayName: await getUserDisplayName(userId),
                createdAt: new Date(),
                lastMessageAt: new Date(),
                wantsWatchCheck: false,
                emergencyContact: null,
                registrationStep: null,
                scheduledMessageSent: false,
                firstReminderSent: false,
                secondReminderSent: false,
                thirdReminderSent: false,
                lastOkResponse: new Date(),
                flaggedMessageCount: 0,
                isAccountSuspended: false,
                suspensionReason: null,
                isPermanentlyLocked: false,
                lastPermanentLockNotifiedAt: null
            };
            await usersCollection.insertOne(user);
            console.log(`新規ユーザー登録: ${user.displayName} (${userId})`);
        } else {
            await usersCollection.updateOne(
                { userId: userId },
                { $set: { lastMessageAt: new Date() } }
            );
            if (user.flaggedMessageCount === undefined) {
                await usersCollection.updateOne({ userId: userId }, { $set: { flaggedMessageCount: 0 } });
                user.flaggedMessageCount = 0;
            }
            if (user.isAccountSuspended === undefined) {
                await usersCollection.updateOne({ userId: userId }, { $set: { isAccountSuspended: false, suspensionReason: null } });
                user.isAccountSuspended = false;
                user.suspensionReason = null;
            }
            if (user.isPermanentlyLocked === undefined) {
                await usersCollection.updateOne({ userId: userId }, { $set: { isPermanentlyLocked: false } });
                user.isPermanentlyLocked = false;
            }
            if (user.lastPermanentLockNotifiedAt === undefined) {
                await usersCollection.updateOne({ userId: userId }, { $set: { lastPermanentLockNotifiedAt: null } });
                user.lastPermanentLockNotifiedAt = null;
            }
            if (user.thirdReminderSent === undefined) {
                await usersCollection.updateOne({ userId: userId }, { $set: { thirdReminderSent: false } });
                user.thirdReminderSent = false;
            }
        }

        // --- Postbackイベント処理 ---
        // ⭐PostbackはreplyTokenが使えるので、res.status(200).send('OK'); より前に処理
        if (event.type === 'postback' && event.postback.data) {
            console.log('✅ Postbackイベントを受信しました。');
            const data = new URLSearchParams(event.postback.data);
            const action = data.get('action');

            const handledByWatchService = await handleWatchServiceRegistration(event, usersCollection, messagesCollection, userId, `（Postback: ${action}）`);
            if (handledByWatchService) {
                // Postbackに対する応答はhandleWatchServiceRegistration内でreplyMessageで行われるため、
                // ここでres.status(200).send('OK')を返す。次のイベントへ。
                res.status(200).send('OK');
                return; // このイベントの処理を終了
            }
        }

        // --- メッセージイベント処理 ---
        // ⭐メッセージイベントもreplyTokenが使えるので、res.status(200).send('OK'); より前に処理
        if (event.type === 'message' && event.message.type === 'text') {
            const userMessage = event.message.text;
            console.log("ユーザーからのメッセージ:", userMessage);

            let replyMessageObject = null;
            let respondedBy = 'こころちゃん（AI）';
            let logType = 'normal';
            let messageHandled = false; // メッセージが処理されたかを示すフラグ

            // 管理者コマンドの処理
            if (isBotAdmin(userId)) {
                const unlockMatch = userMessage.match(/^\/unlock (U[0-9a-f]{32})$/);
                if (unlockMatch) {
                    const targetUserId = unlockMatch[1];
                    try {
                        const result = await usersCollection.updateOne(
                            { userId: targetUserId },
                            { $set: { isAccountSuspended: false, suspensionReason: null, flaggedMessageCount: 0, isPermanentlyLocked: false, lastPermanentLockNotifiedAt: null } }
                        );
                        if (result.matchedCount > 0) {
                            replyMessageObject = { type: 'text', text: `✅ ユーザー ${targetUserId} のロックを解除し、カウントをリセットしました。` };
                            // ロック解除されたユーザーへの通知はpushMessageで非同期に行う
                            client.pushMessage(targetUserId, { type: 'text', text: '🌸 あなたのアカウントの停止が解除されました。またいつでもお話しできますよ💖' }).catch(err => console.error("解除通知失敗:", err));
                            console.log(`管理者 ${userId} によりユーザー ${targetUserId} のロックが解除されました。`);
                        } else {
                            replyMessageObject = { type: 'text', text: `❌ ユーザー ${targetUserId} は見つかりませんでした。` };
                        }
                    } catch (error) {
                        console.error(`❌ 管理者コマンドでのロック解除エラー: ${error.message}`);
                        replyMessageObject = { type: 'text', text: `❌ ロック解除中にエラーが発生しました: ${error.message}` };
                    }
                    logType = 'admin_command';
                    messageHandled = true;
                }
            }

            // 「そうだん」コマンドの処理（リセット）
            if (!messageHandled && (userMessage === 'そうだん' || userMessage === '相談')) {
                if (user) {
                    await usersCollection.updateOne(
                        { userId: userId },
                        { $set: { flaggedMessageCount: 0, isAccountSuspended: false, suspensionReason: null, isPermanentlyLocked: false, lastPermanentLockNotifiedAt: null } }
                    );
                    replyMessageObject = { type: 'text', text: '🌸 会話の回数制限をリセットしました。これで、またいつでもお話しできますよ💖' };
                } else {
                    replyMessageObject = { type: 'text', text: 'ごめんなさい、アカウント情報が見つかりませんでした。' };
                }
                logType = 'conversation_limit_reset_and_consultation_mode';
                messageHandled = true;
            }

            // 見守りサービス関連の処理を優先
            // ⭐handleWatchServiceRegistration内でreplyMessageが呼ばれるので、
            //   ここではawaitで待って、trueが返ってきたらこのイベントの処理を終了する
            if (!messageHandled) {
                const handledByWatchService = await handleWatchServiceRegistration(event, usersCollection, messagesCollection, userId, userMessage);
                if (handledByWatchService) {
                    messageHandled = true;
                }
            }

            // それ以外のメッセージ（AI応答または固定応答）
            if (!messageHandled) {
                if (checkContainsInappropriateWords(userMessage)) {
                    replyMessageObject = { type: 'text', text: "わたしを作った人に『プライベートなことや不適切な話題には答えちゃだめだよ』って言われているんだ🌸ごめんね、他のお話をしようね💖" };
                    respondedBy = 'こころちゃん（不適切ワード）';
                    logType = 'inappropriate_word';
                    // 不適切ワード検知時は、理事会への通知は不要 (仕様による)
                } else if (checkContainsDangerWords(userMessage)) {
                    // 危険ワード検知時はFlex Messageで応答
                    replyMessageObject = {
                        type: 'flex',
                        altText: '⚠緊急時',
                        contents: emergencyFlexTemplate
                    };
                    respondedBy = 'こころちゃん（危険ワード）';
                    logType = 'danger_word';
                    // 理事グループへの通知は非同期で行う
                    try {
                        const userDisplayName = await getUserDisplayName(userId);
                        const dangerAlertMessage = `🚨 緊急通知: ${userDisplayName}さん（LINE ID: ${userId}）が危険な言葉を検知しました: "${userMessage}"`;
                        if (OFFICER_GROUP_ID) {
                            await client.pushMessage(OFFICER_GROUP_ID, { type: 'text', text: dangerAlertMessage });
                            console.log(`🚨 オフィサーグループへ危険ワード通知を送信しました（ユーザー: ${userId}）`);
                        }
                    } catch (notificationError) {
                        console.error(`❌ 危険ワード通知の送信に失敗しました（ユーザー: ${userId}）:`, notificationError.message);
                    }
                } else if (checkContainsScamWords(userMessage)) {
                    // 詐欺ワード検知時はFlex Messageで応答
                    replyMessageObject = {
                        type: 'flex',
                        altText: '⚠詐欺注意',
                        contents: scamFlexTemplate
                    };
                    responsedBy = 'こころちゃん（詐欺ワード）';
                    logType = 'scam_word';
                } else {
                    const specialReply = checkSpecialReply(userMessage);
                    if (specialReply) {
                        replyMessageObject = { type: 'text', text: specialReply };
                        responsedBy = 'こころちゃん（固定応答）';
                    } else if (isOrganizationInquiry(userMessage) || containsHomeworkTrigger(userMessage)) {
                        const aiResponse = await generateReply(userMessage);
                        replyMessageObject = { type: 'text', text: aiResponse };
                        responsedBy = 'こころちゃん（AI）';
                        logType = 'ai_generated';
                    } else {
                        const aiResponse = await generateReply(userMessage);
                        replyMessageObject = { type: 'text', text: aiResponse };
                        responsedBy = 'こころちゃん（AI）';
                        logType = 'ai_generated';
                    }
                }
            }

            // ⭐ここでユーザーへの直接応答をreplyMessageで行う⭐
            if (replyMessageObject && event.replyToken) {
                try {
                    await client.replyMessage(event.replyToken, replyMessageObject);
                    console.log(`✅ ユーザー ${userId} へreplyMessageで応答しました。`);

                    // ログ記録
                    const isResetCommand = (userMessage === 'そうだん' || userMessage === '相談');
                    const isAdminCommand = userMessage.startsWith('/unlock');
                    const isFlaggedMessage = (logType === 'inappropriate_word' || logType === 'danger_word' || logType === 'scam_word');

                    if (shouldLogMessage(userMessage, isFlaggedMessage, messageHandled, isAdminCommand, isResetCommand)) { // messageHandledを渡す
                        await messagesCollection.insertOne({
                            userId: userId,
                            message: userMessage,
                            replyText: (replyMessageObject && typeof replyMessageObject === 'object' && replyMessageObject.type === 'text') ? replyMessageObject.text : JSON.stringify(replyMessageObject),
                            responsedBy: respondedBy,
                            timestamp: new Date(),
                            logType: logType
                        });
                    } else {
                        console.log(`ユーザー ${userId} からのメッセージはDBにログされませんでした: ${userMessage.substring(0, 50)}...`);
                    }

                } catch (error) {
                    console.error("❌ replyMessage送信中またはログ記録中にエラーが発生しました:", error.message);
                    if (error.message.includes("status code 400") || error.message.includes("status code 499")) {
                        console.log(`LINE APIエラーのため、ユーザー ${userId} への応答ができませんでした。`);
                    }
                }
            } else if (!messageHandled) {
                console.warn(`⚠️ ユーザー ${userId} への応答メッセージが生成されませんでした、またはreplyTokenがありません。`);
            }
        }
    }
    // ⭐すべてのイベントを処理し終えたら、最後に200 OKを返す⭐
    res.status(200).send('OK');
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, async () => {
    console.log(`🚀 サーバーがポート ${PORT} で起動しました`);
    await connectToMongoDB();
});
