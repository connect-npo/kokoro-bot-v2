// index.js

// LINE Messaging API SDK をインポート
// `npm install @line/bot-sdk raw-body @google/generative-ai` でインストールしてください
const line = require('@line/bot-sdk');
const express = require('express');
const getRawBody = require('raw-body'); // raw-bodyをインポート
const { GoogleGenerativeAI } = require('@google/generative-ai'); // Gemini APIクライアントをインポート

// 環境変数からLINEアクセストークンとシークレット、理事長グループID、そしてGemini APIキーを取得
// Renderの環境変数設定を必ず確認してください
const LINE_ACCESS_TOKEN = process.env.LINE_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const OFFICER_GROUP_ID = process.env.OFFICER_GROUP_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY; // ★重要: Gemini APIキーを環境変数から取得

// LINEクライアントの初期化 (本番用)
// 環境変数が設定されていない場合のフォールバック値はテスト用です。
// 実際の運用では必ず正しい環境変数を設定してください。
const client = new line.Client({
    channelAccessToken: LINE_ACCESS_TOKEN || 'YOUR_CHANNEL_ACCESS_TOKEN_HERE', // ★重要: あなたのLINEチャンネルアクセストークンを設定
    channelSecret: LINE_CHANNEL_SECRET || 'YOUR_CHANNEL_SECRET_HERE' // ★重要: あなたのLINEチャンネルシークレットを設定
});

// Gemini APIクライアントの初期化
const gemini_api_client = new GoogleGenerativeAI(GEMINI_API_KEY || 'YOUR_GEMINI_API_KEY_HERE'); // ★重要: Gemini APIキーを渡す

// Express.jsの初期化
const app = express();
const PORT = process.env.PORT || 3000;

// LINE Webhook用の生のボディを取得するミドルウェア
// line.middlewareが署名検証のために生のボディを必要とするため、express.json()より前に配置します。
app.use((req, res, next) => {
    // /webhookパスの場合のみraw-bodyミドルウェアを適用
    if (req.path === '/webhook') {
        getRawBody(req, {
            length: req.headers['content-length'],
            limit: '1mb', // リクエストボディのサイズ上限を設定
            encoding: req.charset || 'utf-8',
        })
        .then(buf => {
            req.rawBody = buf; // 生のボディをreq.rawBodyに格納
            next();
        })
        .catch(err => {
            console.error('❌ Raw body error:', err); // エラーはログに出力
            res.status(400).send('Failed to parse raw body');
        });
    } else {
        // Webhook以外のパスではexpress.json()を適用
        express.json()(req, res, next);
    }
});


// --- グローバル変数と設定 ---

// 危険ワードと詐欺ワードのリスト
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
    "不幸だ", "絶望した", "希望がない", "苦痛", "生きるのが嫌", "消滅", "安楽死", "自殺幇助"
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
    "コンビニで電子マネーを買って", "コードを教えて", "個人情報を入力してください"
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


// ユーザーごとの通知時間記録 (レート制限用)
const lastNotifyTime = new Map();

// 【1】危険ワード（子ども・全年齢向け）のクイックリプライと詳細テキストメッセージ
// クイックリプライメッセージ（警察・救急のみ）
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
const dangerDetailedTextMessage = `
💡こころちゃんは、みんなのお話をきくことはできるけど…

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

🌸ひとりでがまんしないでね。こころちゃんも、あなたのことをたいせつに思っています💖
`;

// 【2】詐欺ワード（大人向け）のクイックリプライと詳細テキストメッセージ
// クイックリプライメッセージ（110番のみ）
const scamQuickReplyMessage = {
  type: "text",
  text: "⚠️ 詐欺やトラブルにあったかも？と感じたら…",
  quickReply: {
    items: [
      {
        type: "action",
        action: {
          type: "uri",
          label: "👮‍♂️ 緊急時は迷わず 110番 に通報",
          uri: "tel:110"
        }
      }
    ]
  }
};

// 詳細な相談窓口のテキストメッセージ（詐欺ワード用）
const scamDetailedTextMessage = `
⚠️ それはもしかすると詐欺の可能性があります。

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

🕊️ あなたの安心と安全を守るために、すぐに相談してね。
`;


// 見守りサービス案内用Flex Messageテンプレート (変更なし)
const watchServiceGuideFlexTemplate = {
    "type": "bubble",
    "altText": "見守りサービスのご案内",
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
                    "label": "緊急連絡先を登録/変更する",
                    "data": "action=watch_update_emergency_contact"
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
        { "category": "HARM_CATEGORY_HARASSMENT", "threshold": "BLOCK_NONE" },
        { "category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "BLOCK_NONE" },
        { "category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "BLOCK_MEDIUM_AND_ABOVE" },
        { "category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "BLOCK_NONE" }
    ]
};

// 30通りの見守りメッセージ
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

// 特殊応答マッピング
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
「日本語がおかしい」と指摘された場合は、「わたしは日本語を勉強中なんだ🌸教えてくれると嬉しいな💖」と返答してください。
`;


// LINE BotのWebhookイベントハンドラ
app.post('/webhook', line.middleware({ channelAccessToken: LINE_ACCESS_TOKEN, channelSecret: LINE_CHANNEL_SECRET }), async (req, res) => {
    const events = req.body.events;
    if (!events || events.length === 0) {
        return res.status(200).send('OK');
    }

    try {
        // req.bodyにはLINEからのパースされたJSONが入っている
        // LINE SDKのミドルウェアが署名検証とボディパースを行っているため、ここでは直接req.bodyを使用します。
        // getRawBodyミドルウェアがreq.rawBodyをセットし、line.middlewareがそれを利用して検証しています。
        for (const event of events) {
            await handleEvent(event);
        }
        res.status(200).send('OK');
    } catch (error) {
        console.error(`❌ Webhook処理中にエラーが発生しました: ${error.message}`);
        res.status(500).send('Internal Server Error');
    }
});

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

    // 管理者コマンドの処理
    if (messageText.toLowerCase() === '/unlock') {
        await client.replyMessage(event.replyToken, { type: 'text', text: 'アカウントのロックを解除しました。' });
        await recordToDatabase(userId, messageText, 'admin_command');
        return;
    }

    // 「そうだん」コマンドの処理
    if (messageText === 'そうだん' || messageText === '相談') {
        await client.replyMessage(event.replyToken, { type: 'text', text: 'はい、どうしたの？たくさんお話ししようね💖' });
        await recordToDatabase(userId, messageText, 'consultation_command');
        return;
    }

    // 見守りサービス関連の処理 (postbackイベントも考慮)
    if (event.type === 'postback' && event.postback.data.startsWith('action=watch_')) {
        const action = event.postback.data.split('=')[1];
        if (action === 'watch_register') {
            await client.replyMessage(event.replyToken, { type: 'text', text: '見守りサービスへの登録が完了しました！ありがとう💖 毎日午後3時頃にメッセージを送るね😊 もし内容を変更したくなったら、「見守り」と送ってね🌸' });
        } else if (action === 'watch_unregister') {
            await client.replyMessage(event.replyToken, { type: 'text', text: '見守りサービスを解除しました。いつでもまた登録できるからね🌸' });
        } else if (action === 'watch_update_emergency_contact') {
            await client.replyMessage(event.replyToken, { type: 'text', text: '緊急連絡先の登録や変更については、こころちゃん事務局にお問い合わせくださいね。' });
        }
        await recordToDatabase(userId, event.postback.data, 'watch_service_action');
        return;
    } else if (isWatchKeyword(messageText)) {
        await client.replyMessage(event.replyToken, watchServiceGuideFlexTemplate);
        await recordToDatabase(userId, messageText, 'watch_service_inquiry');
        return;
    }

    // 危険ワードのチェック
    const foundDangerWord = dangerWords.some(word => messageText.includes(word));
    if (foundDangerWord) {
        // クイックリプライと詳細テキストメッセージを順番に送信
        await client.replyMessage(event.replyToken, dangerQuickReplyMessage);
        await client.pushMessage(userId, { type: 'text', text: dangerDetailedTextMessage }); // pushMessageで別送
        await sendEmergencyNotificationToGroup(userId, messageText);
        await recordToDatabase(userId, messageText, 'danger_word_detected');
        return;
    }

    // 詐欺ワードのチェック
    const foundScamWord = scamWords.some(word => messageText.includes(word));
    if (foundScamWord) {
        // クイックリプライと詳細テキストメッセージを順番に送信
        await client.replyMessage(event.replyToken, scamQuickReplyMessage);
        await client.pushMessage(userId, { type: 'text', text: scamDetailedTextMessage }); // pushMessageで別送
        await recordToDatabase(userId, messageText, 'scam_word_detected');
        return;
    }

    // 不適切ワードのチェック
    const foundInappropriateWord = inappropriateWords.some(word => messageText.includes(word));
    if (foundInappropriateWord) {
        await client.replyMessage(event.replyToken, { type: 'text', text: 'ごめんね、その内容には答えられないよ…。' });
        return;
    }

    // 特殊応答のチェック
    for (const [pattern, reply] of specialRepliesMap) {
        if (pattern instanceof RegExp ? pattern.test(messageText) : messageText === pattern) {
            await client.replyMessage(event.replyToken, { type: 'text', text: reply });
            return;
        }
    }

    // 通常のAI応答 (Gemini APIの呼び出しを想定)
    try {
        const aiResponse = await generateGeminiResponse(userId, messageText);
        await client.replyMessage(event.replyToken, { type: 'text', text: aiResponse });
    } catch (error) {
        console.error('Gemini API Error:', error);
        await client.replyMessage(event.replyToken, { type: 'text', text: 'ごめんね、今ちょっとお話できないみたい。また後で試してみてくれるかな？💦' });
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
            text: `⚠ 危険ワード検出: ユーザーID ${userId} が「${message}」と発言しました。`
        });
        lastNotifyTime.set(key, now);
    } catch (error) {
        console.error(`❌ 危険ワード通知の送信に失敗しました（ユーザー: ${userId}）: ${error.message}`);
    }
}

/**
 * データベースにログを記録するダミー関数（エラーログ記録は一時停止）
 * @param {string} userId - ユーザーID
 * @param {string} message - ユーザーメッセージまたはイベントデータ
 * @param {string} type - ログの種類（例: 'admin_command', 'danger_word_detected'）
 * @param {string|null} error - エラーメッセージ（オプション）
 */
async function recordToDatabase(userId, message, type, error = null) {
    if (error) {
        return;
    }

    const skipTypes = ['regular_ai_response', 'special_reply', 'inappropriate_word_detected'];
    if (skipTypes.includes(type)) {
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

    console.log('💾 DBに記録:', record);
    // ここに実際のデータベース（例: MongoDB, Firestore）への保存ロジックを実装
}

/**
 * Gemini APIを呼び出し、AIの応答を生成する関数
 * @param {string} userId - ユーザーID
 * @param {string} userMessage - ユーザーのメッセージ
 * @returns {Promise<string>} - AIの応答テキスト
 */
async function generateGeminiResponse(userId, userMessage) {
    // モデルをインスタンス化
    const model = gemini_api_client.getGenerativeModel(modelConfig);

    const fullPrompt = `${systemInstruction}\n\nユーザー: ${userMessage}`;
    let chatHistory = [];
    chatHistory.push({ role: "user", parts: [{ text: fullPrompt }] });

    try {
        const result = await model.generateContent({
            contents: chatHistory,
            generationConfig: {
                // 安全設定はmodelConfigから取得
                safetySettings: modelConfig.safetySettings
            }
        });

        if (result.response && result.response.candidates && result.response.candidates.length > 0 &&
            result.response.candidates[0].content && result.response.candidates[0].content.parts &&
            result.response.candidates[0].content.parts.length > 0) {
            return result.response.candidates[0].content.parts[0].text;
        } else {
            throw new Error("Gemini APIからの応答が期待された形式ではありません。");
        }
    } catch (error) {
        // Gemini APIからのエラーを捕捉し、詳細なエラーメッセージをログに出力
        if (error.response && error.response.status) {
            console.error(`Gemini API エラー: HTTPステータスコード ${error.response.status} - ${error.response.statusText || '不明なエラー'}`);
            if (error.response.data) {
                console.error('Gemini API エラー詳細:', error.response.data);
            }
        } else {
            console.error('Gemini API エラー:', error.message);
        }
        throw new Error(`Gemini APIからのリクエストが失敗しました。: ${error.message}`);
    }
}

/**
 * 毎日定時に見守りメッセージを送信する関数（ダミー）
 * ※実際にはCloud SchedulerやCronジョブなどで定期的にトリガーする必要があります。
 */
async function sendDailyWatchMessage() {
    const currentTime = new Date();
    // 毎日午後3時に実行される想定
    if (currentTime.getHours() === 15 && currentTime.getMinutes() === 0) {
        // 見守りサービス登録済みの全ユーザーを取得 (ダミーデータ)
        const watchUsers = ['user1', 'user2']; // 実際にはDBから取得

        const randomMessage = watchMessages[Math.floor(Math.random() * watchMessages.length)]; // 30通りからランダム選択

        for (const userId of watchUsers) {
            try {
                await client.pushMessage(userId, { type: 'text', text: randomMessage });
                await recordToDatabase(userId, randomMessage, 'watch_message_sent');
            } catch (error) {
                console.error(`❌ 見守りメッセージ送信失敗（ユーザー: ${userId}）: ${error.message}`);
            }
        }
    }
}

/**
 * 未返信ユーザーをチェックし、リマインダーや緊急通知を送信する関数（ダミー）
 * ※実際にはCloud SchedulerやCronジョブなどで定期的にトリガーする必要があります。
 */
async function checkUnansweredMessages() {
    const unanswered24hUsers = ['user1']; // 実際にはDBから取得
    for (const userId of unanswered24hUsers) {
        try {
            await client.pushMessage(userId, { type: 'text', text: '見てくれたかな？😊 こころちゃん、ちょっと心配してるよ💖' });
            await recordToDatabase(userId, 'リマインダーメッセージ送信', 'watch_reminder_sent');
        } catch (error) {
            console.error(`❌ リマインダーメッセージ送信失敗（ユーザー: ${userId}）: ${error.message}`);
        }
    }

    const unanswered29hUsers = ['user1']; // 実際にはDBから取得
    for (const userId of unanswered29hUsers) {
        try {
            await sendEmergencyNotificationToGroup(userId, '見守りサービス：29時間以上未返信');
            await recordToDatabase(userId, '緊急連絡先へ通知 (29時間未返信)', 'watch_emergency_notified');
        } catch (error) {
            console.error(`❌ 緊急連絡先への通知失敗（ユーザー: ${userId}）: ${error.message}`);
        }
    }
}

// サーバーを起動
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    // 定期実行関数は本番環境ではCloud Schedulerなどと連携
    // 例: setInterval(sendDailyWatchMessage, 60 * 1000); // 1分ごとにチェック (デモ用)
    // setInterval(checkUnansweredMessages, 60 * 1000); // 1分ごとにチェック (デモ用)
});
