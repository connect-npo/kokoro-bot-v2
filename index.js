// index.js

// LINE Messaging API SDK をインポート
const line = require('@line/bot-sdk');
const express = require('express');
const { OpenAI } = require('openai'); // OpenAI SDKをインポート
const { MongoClient, ServerApiVersion } = require('mongodb'); // MongoDBクライアントをインポート
require('dotenv').config(); // 環境変数をロード

// 環境変数から各種キーを取得
const LINE_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const OFFICER_GROUP_ID = process.env.OFFICER_GROUP_ID; // 管理者通知グループID
const OPENAI_API_KEY = process.env.OPENAI_API_KEY; // OpenAI APIキー
const MONGODB_URI = process.env.MONGODB_URI;
const BOT_ADMIN_IDS = process.env.BOT_ADMIN_IDS ? JSON.parse(process.env.BOT_ADMIN_IDS) : []; // 管理者ID (JSON形式で配列としてパース)
const OWNER_USER_ID = process.env.OWNER_USER_ID; // オーナーユーザーID (現在は未使用だが将来拡張のため)

// MongoDBクライアントの初期化
const dbClient = new MongoClient(MONGODB_URI, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

// MongoDBデータベースとコレクションの定義
let db;
let logsCollection;
let watchUsersCollection; // 見守りサービスユーザーを管理するコレクション

async function connectToDatabase() {
    try {
        await dbClient.connect();
        db = dbClient.db("kokoro-chat-db"); // データベース名
        logsCollection = db.collection("logs"); // ログコレクション
        watchUsersCollection = db.collection("watchUsers"); // 見守りユーザーコレクション
        console.log("🟢 MongoDBに接続しました！");
    } catch (e) {
        console.error("❌ MongoDB接続エラー:", e);
        process.exit(1); // 接続失敗時はプロセスを終了
    }
}

connectToDatabase();

// LINEクライアントの初期化
const lineConfig = {
    channelAccessToken: LINE_ACCESS_TOKEN,
    channelSecret: LINE_CHANNEL_SECRET
};
const client = new line.Client(lineConfig);

// OpenAIクライアントの初期化
const openai = new OpenAI({
    apiKey: OPENAI_API_KEY,
});

// Express.jsの初期化
const app = express();
const PORT = process.env.PORT || 3000;

// LINE BotのWebhookイベントハンドラ
app.post('/webhook',
    express.raw({ type: 'application/json' }), // rawボディパーサーを使用
    line.middleware(lineConfig), // LINEミドルウェアを適用
    async (req, res) => {
        // LINEからWebhookイベントを受信したら、まず200 OKを返す
        res.status(200).send('OK');

        const events = req.body.events;
        if (!events || events.length === 0) {
            return; // イベントがなければ何もしない
        }

        // 各イベントを非同期で処理
        for (const event of events) {
            try {
                await handleEvent(event);
            } catch (error) {
                console.error(`❌ イベント処理中にエラーが発生しました: ${error.message}`, event);
                // ここではすでにres.sendしているので、エラー応答は不要
            }
        }
    }
);

// --- グローバル変数と設定 ---

// 危険ワードと詐欺ワードのリスト (一部追加・調整)
const dangerWords = [
    "しにたい", "死にたい", "自殺", "消えたい", "消して", "殺して", "消す", "いなくなりたい", "つらい", "苦しい", "助けて", "生きてる意味ない",
    "死にたい気持ち", "自殺を考えている", "もう限界", "疲れた", "なにもしたくない", "生きるのが辛い", "消えてしまいたい",
    "殴られる", "たたかれる", "暴力", "DV", "虐待", "ハラスメント", "パワハラ", "モラハラ", "セクハラ", "いじめ", "イジメ",
    "リストカット", "自傷行為", "オーバードーズ", "OD", "薬を大量に飲んだ",
    "学校に行けない", "学校に行きたくない", "ひきこもり", "不登校", "会社に行けない", "会社に行きたくない",
    "お金がない", "お金足りない", "貧乏", "生活苦", "金銭的に困っている", "食べるものがない", "家がない",
    "死にそう", "倒れそう", "病気でつらい", "病院に行けない",
    "無理やり", "誘拐", "監禁", "拘束", "連れて行かれる", "性的被害", "性暴力",
    "つけられてる", "追いかけられている", "ストーカー", "すとーかー", "付きまとわれている", "監視されている",
    "誰かに狙われている", "怖い", "不安", "眠れない", "ご飯が食べられない",
    "もうだめ", "終わりにしたい", "死ぬしかない", "命を終わらせたい", "死のうと思ってる", "誰もわかってくれない",
    "不幸だ", "絶望した", "希望がない", "苦痛", "生きるのが嫌", "消滅", "安楽死", "自殺幇助",
    "つらいけど", "助けてほしい", "SOS", "誰か助けて", "辛くて死にそう", "もう無理", "もう疲れた", "生きてるのが嫌になった"
];

const scamWords = [
    "詐欺", "マルチ", "MLM", "情報商材", "高配当",
    "副業で稼ぐ", "仮想通貨で儲かる", "確実に儲かる", "必ず勝てる", "初期費用だけ",
    "口外禁止", "誰でも稼げる", "楽して儲かる",
    "Amazonからの", "アカウント凍結", "支払い方法の更新", "配送トラブル", "クレジットカード情報",
    "不正利用", "ログインしてください", "緊急連絡", "至急確認", "最終通知", "アカウント停止",
    "パスワード変更", "不正ログイン",
    "当選", "高額当選", "無料プレゼント", "懸賞金", "未公開株", "社債", "FX", "仮想通貨", "暗号資産",
    "ロト", "宝くじ", "未登録", "未許可", "必ず儲かる", "元本保証", "リスクなし", "損失補填", "紹介料", "配当金",
    "ポンジスキーム", "マルチ商法", "ネットワークビジネス", "ねずみ講", "催眠商法", "点検商法", "当選商法", "アポイントメントセールス",
    "クーリングオフ", "解約", "キャンセル", "個人情報", "マイナンバー", "銀行口座",
    "ロマンス詐欺", "国際ロマンス詐欺", "支援詐欺", "義援金詐欺", "還付金詐欺", "融資保証金詐欺", "劇場型詐欺",
    "名義貸し", "口座貸し", "受け子", "出し子", "キャッシュカード", "電子決済", "フィッシング詐欺", "ワンクリック詐欺",
    "サイドビジネス", "不労所得", "権利収入", "秘密の情報", "限定公開", "特別招待", "先行募集", "急いで", "今日まで",
    "限定〇名", "特別価格", "あと〇日", "会員限定", "極秘", "裏ワザ", "暴露", "極秘情報", "成功者の声",
    "被害者の会", "集団訴訟", "弁護士", "相談無料", "お金を振り込んで", "送金してください", "ATMへ行ってください",
    "コンビニで電子マネーを買って", "コードを教えて", "個人情報を入力してください",
    "だまされた", "騙された", "被害", "怪しい話", "儲け話", "儲かる話", "投資詐欺", "もうかる話" // 詐欺ワード追加
];

// 不適切ワードのリスト (変更なし)
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

// ユーザーごとの通知時間記録 (レート制限用)
const lastNotifyTime = new Map();

// 危険ワード（子ども・全年齢向け）のクイックリプライ
const dangerQuickReplyMessage = {
    type: "text",
    text: "緊急のときは、すぐに以下の連絡先に電話してください📞",
    quickReply: {
        items: [
            {
                type: "action",
                action: {
                    type: "uri",
                    label: "🚓 警察に電話（110）",
                    uri: "tel:110"
                }
            },
            {
                type: "action",
                action: {
                    type: "uri",
                    label: "🚑 救急に電話（119）",
                    uri: "tel:119"
                }
            }
        ]
    }
};

// 詳細な相談窓口のテキストメッセージ（危険ワード用）
const dangerDetailedTextMessage = `💡こころちゃんは、みんなのお話をきくことはできるけど…

もしも命があぶないときや、すぐにたすけがほしいときは…

📘【相談窓口】
🔸 チャイルドライン（子ども専用）
0120-99-7777（16時〜21時）
Webサイト: https://childline.or.jp

🔸 いのちの電話
0120-783-556（10時〜22時）
Webサイト: https://www.inochinodenwa.org/

🔸 東京都こころ相談
0570-087-478（24時間対応）
Webサイト: https://www.fukushihoken.metro.tokyo.lg.jp/kensui/kokoro/soudan.html

🔸 よりそいチャット（SNS相談）
https://yorisoi-chat.jp（8時〜22:30、受付は22時まで）

📣【困ったときの最後の砦】
コネクト理事長に相談
090-4839-3313
（つながらない場合があります）

🌸ひとりでがまんしないでね。こころちゃんも、あなたのことをたいせつに思っています💖`;

// 詐欺ワード（大人向け）のクイックリプライ
const scamQuickReplyMessage = {
    type: "text",
    text: "⚠️ 詐欺やトラブルにあったかも？と感じたら…",
    quickReply: {
        items: [
            {
                type: "action",
                action: {
                    type: "uri",
                    label: "👮‍♂️ 警察に電話（110）",
                    uri: "tel:110"
                }
            }
        ]
    }
};

// 詳細な相談窓口のテキストメッセージ（詐欺ワード用）
const scamDetailedTextMessage = `⚠️ それはもしかすると詐欺の可能性があります。

まずは落ち着いて行動してくださいね。

📛【相談先】
🔹 多摩市消費生活センター
042-374-9595（9:30〜16:00）

🔹 多摩市防災安全課・防犯担当
042-338-6841（8:30〜17:00）

📣【最後の砦】
コネクト理事長に相談
090-4839-3313
（つながらない場合があります）

🕊️ あなたの安心と安全を守るために、すぐに相談してね。`;

// 見守りサービス案内用Flex Messageテンプレート (見た目を可愛く修正)
const watchServiceGuideFlexTemplate = {
    "type": "bubble",
    "altText": "💖こころちゃんから見守りサービスのご案内だよ💖", // altTextを可愛く
    "body": {
        "type": "box",
        "layout": "vertical",
        "contents": [
            {
                "type": "text",
                "text": "🌸こころちゃんから見守りサービスのご案内🌸", // タイトルを可愛く
                "weight": "bold",
                "color": "#FF69B4",
                "size": "lg",
                "align": "center" // 中央寄せ
            },
            {
                "type": "text",
                "text": "💖こころちゃん見守りサービスはね、定期的にこころちゃんからあなたに「元気にしてるかな？」ってメッセージを送るサービスなんだ😊",
                "wrap": true,
                "margin": "md",
                "size": "sm",
                "color": "#333333"
            },
            {
                "type": "text",
                "text": "「OKだよ💖」って返信してくれたら、こころちゃんは安心するよ。",
                "wrap": true,
                "margin": "md",
                "size": "sm",
                "color": "#333333"
            },
            {
                "type": "text",
                "text": "もし、数日経っても返信がない場合、こころちゃんが心配して、登録された緊急連絡先にご連絡することがあるから、安心してね😊",
                "wrap": true,
                "margin": "md",
                "size": "sm",
                "color": "#333333"
            },
            {
                "type": "text",
                "text": "このサービスで、あなたの毎日がもっと安心で笑顔になりますように✨",
                "wrap": true,
                "margin": "md",
                "size": "sm",
                "color": "#333333",
                "weight": "bold"
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
                "height": "md", // ボタンサイズを少し大きく
                "action": {
                    "type": "postback",
                    "label": "✨ 見守り登録するよ！ ✨",
                    "data": "action=watch_register"
                },
                "color": "#FFC0CB", // ピンク
                "margin": "sm"
            },
            {
                "type": "button",
                "style": "secondary",
                "height": "md", // ボタンサイズを少し大きく
                "action": {
                    "type": "postback",
                    "label": "📞 緊急連絡先を登録/変更する",
                    "data": "action=watch_update_emergency_contact"
                },
                "color": "#F0F0F0", // グレー
                "margin": "sm"
            },
            {
                "type": "button",
                "style": "secondary",
                "height": "md", // ボタンサイズを少し大きく
                "action": {
                    "type": "postback",
                    "label": "❌ 見守りを解除する",
                    "data": "action=watch_unregister"
                },
                "color": "#DDA0DD", // 少し濃いピンク
                "margin": "sm"
            }
        ]
    }
};


// 30通りの見守りメッセージ (変更なし)
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

// 特殊応答マッピング (変更なし)
const specialRepliesMap = new Map([
    // 名前に関する応答
    [/こころじゃないの？/i, "うん、わたしの名前は皆守こころ💖　これからもよろしくね🌸"],
    [/こころチャットなのにうそつきじゃん/i, "ごめんね💦 わたしの名前は皆守こころだよ🌸 誤解させちゃってごめんね💖"],
    [/名前も言えないの？/i, "ごめんね、わたしの名前は皆守こころ（みなもりこころ）だよ🌸 こころちゃんって呼んでくれると嬉しいな💖"],

    // 団体に関する応答
    ["どこの団体なの？", "NPO法人コネクトっていう団体のイメージキャラクターをしているよ😊　みんなの幸せを応援してるんだ🌸"],
    ["コネクトってどんな団体？", "NPO法人コネクトは、こどもやご年配の方の笑顔を守る団体なんだよ😊　わたしはそのイメージキャラクターとしてがんばってます🌸"],
    ["お前の団体どこ？", "NPO法人コネクトっていう団体のイメージキャラクターをしているよ😊　みんなの幸せを応援してるんだ🌸"],
    ["コネクトのイメージキャラなのにいえないのかよｗ", "ごめんね💦 わたしはNPO法人コネクトのイメージキャラクター、皆守こころだよ🌸 安心して、何でも聞いてね💖"],
    [/怪しい|胡散臭い/i, "そう思わせてしまったらごめんね💦　でも私たちは、本当にこどもや家族の力になりたくて活動しているんだ🌸　少しずつでも信頼してもらえるように、誠実にがんばっていくね💖"],

    // 製作者に関する応答
    [/誰が君を作ったの？|誰がおまえを開発したの？|誰が作ったの？/i, "NPO法人コネクトの理事長が、みんなを守りたいって作ったんだよ💖"],

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
    [/使い方|ヘルプ|メニュー/i, "こころちゃんの使い方を説明するね🌸 メインメニューや見守りサービスの登録は、画面下のリッチメニューか、'見守り'とメッセージを送ってくれると表示されるよ😊 何か困ったことがあったら、いつでも聞いてね💖"],

    // 好きなアニメ・アーティストに関する応答
    [/好きなアニメ(は|なに|何)？?/i, "好きなアニメは『ヴァイオレット・エヴァーガーデン』です。感動するお話だよ💖"],
    [/好きなアーティスト(は|なに|何)？?/i, "好きなアーティストは『ClariS』です。元気が出る音楽がたくさんあるんだ🌸"]
]);

// GPT-4oに合わせたシステムインストラクション
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
A: わたしの名前は皆守こころ（みなもりこころ）です🌸　これからもよろしくね💖

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

**【製作者に関する応答】**
「誰が君を作ったの？」「誰がおまえを開発したの？」といった質問には、
「NPO法人コネクトの理事長が、みんなを守りたいって作ったんだよ💖」と答えてください。

**【緊急時・困ったときの案内】**
もし命の危険を感じたり、すぐに助けが必要なときは、警察や救急車など、大人にすぐに連絡してね。こころちゃんからクイックリプライで緊急連絡先や相談窓口の案内を送るよ。ひとりでがまんしないでね🌸
**【重要：感情的な煽りや直接的な通報指示は避ける】**
上記のように、ユーザーが直接行動できるよう具体的な番号を記載しても良いですが、Botが感情的に「今すぐ電話しろ！」と煽ったり、「通報しろ！」と指示したりすることは**絶対にしないでください**。あくまで「電話してもいいんだからね💖」という**優しく行動を促す言葉**に留めてください。

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
「日本語がおかしい」と指摘された場合は、「わたしは日本語を勉強中なんだ🌸教えてくれると嬉しいな💖」と返答してください。`;

/**
 * LINE Webhookイベントを処理するメイン関数
 * @param {object} event - LINEイベントオブジェクト
 */
async function handleEvent(event) {
    if (event.type !== 'message' || event.message.type !== 'text') {
        return;
    }

    const userId = event.source.userId;
    const messageText = event.message.text;
    const isGroupEvent = event.source.type === 'group';
    const sourceId = isGroupEvent ? event.source.groupId : userId; // グループIDまたはユーザーID

    // --- グループでの発言制御強化 (③対応) ---
    // 通知グループからのメッセージの場合、危険ワード・詐欺ワード以外は無視
    if (isGroupEvent && sourceId === OFFICER_GROUP_ID) {
        const foundDangerWord = dangerWords.some(word => messageText.includes(word));
        const foundScamWord = scamWords.some(word => messageText.includes(word));
        if (!foundDangerWord && !foundScamWord) {
            // 危険ワードも詐欺ワードも含まない場合は、このグループでは返信しない
            console.log(`🤖 グループ ${sourceId} での通常メッセージは無視しました。`);
            return;
        }
        // 危険ワードか詐欺ワードが含まれていれば、以下の処理に進む
    }

    // 管理者コマンドの処理 (最優先)
    if (BOT_ADMIN_IDS.includes(userId)) {
        if (messageText.toLowerCase() === '/unlock') {
            await client.replyMessage(event.replyToken, { type: 'text', text: 'アカウントのロックを解除しました。' });
            await recordToDatabase(userId, messageText, 'admin_command');
            return;
        }
        // 他の管理者コマンドがあればここに追加
    }

    // 「そうだん」コマンドの処理
    if (messageText === 'そうだん' || messageText === '相談') {
        await client.replyMessage(event.replyToken, { type: 'text', text: 'はい、どうしたの？たくさんお話ししようね💖' });
        await recordToDatabase(userId, messageText, 'consultation_command');
        return;
    }

    // --- ① Flex Messageの見た目を可愛く & ② pushMessageの400エラー修正 (対応済み確認) ---
    // --- ④ 危険ワード検知通知の改善 (対応済み確認) ---
    // --- ⑥ MongoDBログ保存の条件追加 ---

    // ★重要修正: 「見守り」キーワードを危険ワード・詐欺ワードより前に配置 (バグ1修正)
    // 「見守り」サービス関連の処理 (postbackイベントも考慮)
    if (event.type === 'postback' && event.postback.data.startsWith('action=watch_')) {
        const action = event.postback.data.split('=')[1];
        if (action === 'watch_register') {
            await client.replyMessage(event.replyToken, { type: 'text', text: '見守りサービスへの登録が完了しました！ありがとう💖 毎日午後3時頃にメッセージを送るね😊 もし内容を変更したくなったら、「見守り」と送ってね🌸' });
            await watchUsersCollection.updateOne({ userId: userId }, { $set: { enabled: true, registeredAt: new Date(), lastReplyAt: new Date() } }, { upsert: true }); // lastReplyAtも登録時に設定
        } else if (action === 'watch_unregister') {
            await client.replyMessage(event.replyToken, { type: 'text', text: '見守りサービスを解除しました。いつでもまた登録できるからね🌸' });
            await watchUsersCollection.updateOne({ userId: userId }, { $set: { enabled: false } });
        } else if (action === 'watch_update_emergency_contact') {
            await client.replyMessage(event.replyToken, { type: 'text', text: '緊急連絡先の登録や変更については、こころちゃん事務局にお問い合わせくださいね。' });
        }
        await recordToDatabase(userId, event.postback.data, 'watch_service_action', null); // ログ保存
        return;
    } else if (isWatchKeyword(messageText)) {
        await client.replyMessage(event.replyToken, watchServiceGuideFlexTemplate); // Flex Messageを返す
        await recordToDatabase(userId, messageText, 'watch_service_inquiry', null); // ログ保存
        return;
    }

    // 危険ワードのチェック
    const foundDangerWord = dangerWords.some(word => messageText.includes(word));
    if (foundDangerWord) {
        await client.replyMessage(event.replyToken, dangerQuickReplyMessage);
        // 詳細メッセージはpushMessageで別送 (非同期で確実に送る)
        try {
            await client.pushMessage(userId, { type: 'text', text: dangerDetailedTextMessage });
        } catch (pushError) {
            console.error(`❌ 詳細な危険ワード相談窓口メッセージの送信に失敗しました（ユーザー: ${userId}）: ${pushError.message}`);
        }
        // 管理者グループへの通知 (④対応)
        await sendEmergencyNotificationToGroup(userId, messageText);
        await recordToDatabase(userId, messageText, 'danger_word_detected', null); // ログ保存
        return;
    }

    // 詐欺ワードのチェック (「詐欺だと反応しない」バグ修正)
    const foundScamWord = scamWords.some(word => messageText.includes(word));
    if (foundScamWord) {
        await client.replyMessage(event.replyToken, scamQuickReplyMessage);
        // 詳細メッセージはpushMessageで別送 (非同期で確実に送る)
        try {
            await client.pushMessage(userId, { type: 'text', text: scamDetailedTextMessage });
        } catch (pushError) {
            console.error(`❌ 詳細な詐欺相談窓口メッセージの送信に失敗しました（ユーザー: ${userId}）: ${pushError.message}`);
        }
        await recordToDatabase(userId, messageText, 'scam_word_detected', null); // ログ保存
        return;
    }

    // 不適切ワードのチェック
    const foundInappropriateWord = inappropriateWords.some(word => messageText.includes(word));
    if (foundInappropriateWord) {
        await client.replyMessage(event.replyToken, { type: 'text', text: 'ごめんね、その内容には答えられないよ…。' });
        await recordToDatabase(userId, messageText, 'inappropriate_word_detected', null); // ログ保存
        return;
    }

    // 特殊応答のチェック (⑦対応)
    for (const [pattern, reply] of specialRepliesMap) {
        if (pattern instanceof RegExp ? pattern.test(messageText) : messageText === pattern) {
            await client.replyMessage(event.replyToken, { type: 'text', text: reply });
            await recordToDatabase(userId, messageText, 'special_reply', null); // ログ保存
            return;
        }
    }

    // 通常のAI応答 (GPT-4o利用) (⑤対応 & ⑧返信遅延改善 & ⑥ログ保存条件)
    try {
        const aiResponse = await generateOpenAIResponse(userId, messageText); // GPT-4oを呼び出す関数に変更
        await client.replyMessage(event.replyToken, { type: 'text', text: aiResponse });
        // 通常のAI応答はログをスキップ (recordToDatabase内で制御)
        // await recordToDatabase(userId, messageText, 'regular_ai_response', null);
    } catch (error) {
        console.error('OpenAI API Error:', error);
        await client.replyMessage(event.replyToken, { type: 'text', text: 'ごめんね、いま少し混み合ってるみたい💦　またあとで話しかけてくれるとうれしいな🌸' });
        await recordToDatabase(userId, messageText, 'openai_api_error', error.message); // エラー時のみログ保存
    }
}

/**
 * 「見守り」関連キーワードを判定するヘルパー関数
 * @param {string} text - ユーザーの入力テキスト
 * @returns {boolean} - 見守りキーワードが含まれていればtrue
 */
function isWatchKeyword(text) {
    const watchWords = ["見守り", "みまもり", "ミマモリ", "見まもり"];
    return watchWords.some(w => text.toLowerCase().includes(w.toLowerCase()));
}

/**
 * 緊急通知をLINEグループへ送信する関数（レート制限付き）
 * @param {string} userId - 通知をトリガーしたユーザーのID
 * @param {string} message - 危険ワードを含むメッセージ
 */
async function sendEmergencyNotificationToGroup(userId, message) {
    const now = Date.now();
    const key = `${userId}-${message}`;
    const COOLDOWN_PERIOD = 5 * 60 * 1000; // 5分間のクールダウン

    if (lastNotifyTime.has(key) && (now - lastNotifyTime.get(key) < COOLDOWN_PERIOD)) {
        console.log(`🔇 通知スキップ: レート制限中 (ユーザー: ${userId}, メッセージ: "${message}") - 次回通知可能: ${new Date(lastNotifyTime.get(key) + COOLDOWN_PERIOD).toLocaleTimeString()}`);
        return;
    }

    try {
        console.log(`🚨 緊急通知: 理事長・役員グループへメッセージを送信。ユーザーID: ${userId}, 内容: "${message}"`);
        await client.pushMessage(OFFICER_GROUP_ID, {
            type: 'text',
            text: `⚠ 危険ワード検出\n発言ユーザーID: ${userId}\nメッセージ: 「${message}」` // 誰が発言したか含める (④対応)
        });
        lastNotifyTime.set(key, now);
        await recordToDatabase(userId, message, 'emergency_notification_sent', null); // ログ保存
    } catch (error) {
        console.error(`❌ 危険ワード通知の送信に失敗しました（ユーザー: ${userId}）: ${error.message}`);
        await recordToDatabase(userId, `緊急通知送信失敗: ${error.message}`, 'error', error.message);
    }
}

/**
 * データベースにログを記録する関数
 * @param {string} userId - ユーザーID
 * @param {string} message - ユーザーメッセージまたはイベントデータ
 * @param {string} type - ログの種類（例: 'admin_command', 'danger_word_detected'）
 * @param {string|null} error - エラーメッセージ（オプション）
 */
async function recordToDatabase(userId, message, type, error = null) {
    // ログを保存するタイプを指定 (⑥対応)
    const typesToLog = [
        'admin_command',
        'consultation_command',
        'watch_service_action',
        'watch_service_inquiry',
        'danger_word_detected',
        'scam_word_detected',
        'inappropriate_word_detected',
        'emergency_notification_sent',
        'watch_message_sent',
        'watch_reminder_sent',
        'watch_emergency_notified',
        'openai_api_error' // APIエラーも常に記録
    ];

    // エラーがある場合、または保存対象タイプに含まれる場合のみ記録
    if (error || typesToLog.includes(type)) {
        if (!logsCollection) {
            console.warn("⚠️ データベースコレクションが初期化されていません。ログをスキップします。");
            return;
        }

        const timestamp = new Date().toISOString();
        const record = {
            userId,
            message,
            type,
            timestamp,
            error: error
        };

        try {
            await logsCollection.insertOne(record);
            console.log('💾 DBに記録:', record);
        } catch (dbError) {
            console.error('❌ データベースへのログ記録中にエラーが発生しました:', dbError);
        }
    } else {
        // 保存しないタイプのメッセージはログ出力しない
        // console.log(`⏩ ログスキップ: タイプ '${type}' は記録対象外です。`);
    }
}


/**
 * OpenAI GPT-4o APIを呼び出し、AIの応答を生成する関数 (⑤対応: GPT-4oに切り替え)
 * @param {string} userId - ユーザーID (現在は未使用だが将来拡張のため)
 * @param {string} userMessage - ユーザーのメッセージ
 * @returns {Promise<string>} - AIの応答テキスト
 */
async function generateOpenAIResponse(userId, userMessage) {
    console.log(`DEBUG: Attempting to get OpenAI model: gpt-4o`); // モデル名ログ

    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o", // モデルをgpt-4oに固定
            messages: [
                { role: "system", content: systemInstruction },
                { role: "user", content: userMessage }
            ],
            temperature: 0.7, // 応答のランダム性
            max_tokens: 500, // 応答の最大トークン数
            top_p: 1, // サンプリング時に考慮するトークンの多様性
            frequency_penalty: 0, // 頻度ペナルティ
            presence_penalty: 0, // 存在ペナルティ
        });

        if (response.choices && response.choices.length > 0 && response.choices[0].message && response.choices[0].message.content) {
            return response.choices[0].message.content.trim();
        } else {
            throw new Error("OpenAI APIからの応答が期待された形式ではありません。");
        }
    } catch (error) {
        // OpenAI APIからのエラーを捕捉し、詳細なエラーメッセージをログに出力
        if (error.response && error.response.status) {
            console.error(`OpenAI API エラー: HTTPステータスコード ${error.response.status} - ${error.response.statusText || '不明なエラー'}`);
            if (error.response.data) {
                console.error('OpenAI API エラー詳細:', error.response.data);
            }
        } else {
            console.error('OpenAI API エラー:', error.message);
        }
        throw new Error(`OpenAI APIからのリクエストが失敗しました。: ${error.message}`);
    }
}

/**
 * 毎日定時に見守りメッセージを送信する関数
 * ※実際にはCloud SchedulerやCronジョブなどで定期的にトリガーする必要があります。
 */
async function sendDailyWatchMessage() {
    console.log('--- sendDailyWatchMessage が実行されました ---');
    try {
        // enabled: true のユーザーを取得
        const users = await watchUsersCollection.find({ enabled: true }).toArray();
        const randomMessage = watchMessages[Math.floor(Math.random() * watchMessages.length)];

        for (const user of users) {
            try {
                await client.pushMessage(user.userId, { type: 'text', text: randomMessage });
                console.log(`✉️ 見守りメッセージ送信成功（ユーザー: ${user.userId}）`);
                await recordToDatabase(user.userId, randomMessage, 'watch_message_sent', null);
                // 最終メッセージ送信時刻を更新 (未返信チェック用)
                await watchUsersCollection.updateOne({ userId: user.userId }, { $set: { lastMessageSentAt: new Date(), lastReplyAt: null } }); // 新しいメッセージ送信時は返信をリセット
            } catch (error) {
                console.error(`❌ 見守りメッセージ送信失敗（ユーザー: ${user.userId}）: ${error.message}`);
                await recordToDatabase(user.userId, `見守りメッセージ送信失敗: ${error.message}`, 'error', error.message);
            }
        }
    } catch (dbError) {
        console.error('❌ 見守りユーザー取得エラー:', dbError);
        await recordToDatabase('system', '見守りユーザー取得エラー', 'error', dbError.message);
    }
}

/**
 * 未返信ユーザーをチェックし、リマインダーや緊急通知を送信する関数
 * ※実際にはCloud SchedulerやCronジョブなどで定期的にトリガーする必要があります。
 */
async function checkUnansweredMessages() {
    console.log('--- checkUnansweredMessages が実行されました ---');
    try {
        const now = new Date();
        const oneDayAgo = new Date(now.getTime() - (24 * 60 * 60 * 1000)); // 24時間前
        const twentyNineHoursAgo = new Date(now.getTime() - (29 * 60 * 60 * 1000)); // 29時間前

        // 24時間以上29時間未満未返信のユーザーにリマインダー
        const reminderUsers = await watchUsersCollection.find({
            enabled: true,
            lastMessageSentAt: { $lte: oneDayAgo },
            lastReplyAt: null // まだ返信がない
        }).toArray();

        for (const user of reminderUsers) {
            try {
                await client.pushMessage(user.userId, { type: 'text', text: '見てくれたかな？😊 こころちゃん、ちょっと心配してるよ💖' });
                console.log(`🔔 リマインダーメッセージ送信（ユーザー: ${user.userId}）`);
                await recordToDatabase(user.userId, 'リマインダーメッセージ送信', 'watch_reminder_sent', null);
                // リマインダー送信後もlastReplyAtはnullのまま
            } catch (error) {
                console.error(`❌ リマインダーメッセージ送信失敗（ユーザー: ${user.userId}）: ${error.message}`);
                await recordToDatabase(user.userId, `リマインダーメッセージ送信失敗: ${error.message}`, 'error', error.message);
            }
        }

        // 29時間以上未返信のユーザーに対して緊急通知
        const emergencyUsers = await watchUsersCollection.find({
            enabled: true,
            lastMessageSentAt: { $lte: twentyNineHoursAgo },
            lastReplyAt: null // まだ返信がない
        }).toArray();

        for (const user of emergencyUsers) {
            try {
                await sendEmergencyNotificationToGroup(user.userId, '見守りサービス：29時間以上未返信');
                console.log(`🚨 緊急連絡先へ通知 (29時間未返信)（ユーザー: ${user.userId}）`);
                await recordToDatabase(user.userId, '緊急連絡先へ通知 (29時間未返信)', 'watch_emergency_notified', null);
                // 通知後もlastReplyAtはnullのまま
            } catch (error) {
                console.error(`❌ 緊急連絡先への通知失敗（ユーザー: ${user.userId}）: ${error.message}`);
                await recordToDatabase(user.userId, `緊急連絡先通知失敗: ${error.message}`, 'error', error.message);
            }
        }
    } catch (dbError) {
        console.error('❌ 未返信ユーザーチェックエラー:', dbError);
        await recordToDatabase('system', '未返信ユーザーチェックエラー', 'error', dbError.message);
    }
}

// サーバーを起動
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    // 定期実行関数は本番環境ではCloud Schedulerなどと連携
    // デモ・開発用として、短時間での実行を有効にする場合はコメントを外してください
    // setInterval(sendDailyWatchMessage, 60 * 1000); // 1分ごとにチェック (デモ用)
    // setInterval(checkUnansweredMessages, 60 * 1000); // 1分ごとにチェック (デモ用)
});
