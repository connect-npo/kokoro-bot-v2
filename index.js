// ⭐【真・究極最終決定稿】まつさんの1500行のコードを母体とし、全ての修正と要望を統合した最終版です ⭐

require('dotenv').config();
const express = require('express');
const { Client, middleware } = require('@line/bot-sdk'); // 修正①: middlewareを正しくインポート
const cron = require('node-cron');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');
const { OpenAI } = require('openai');
const admin = require('firebase-admin'); // 修正②: Firebase Admin SDKを追加

// --- 1. 設定セクション ---
const config = { // 修正③: lineClientとmiddlewareで共有する設定オブジェクト
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OWNER_USER_ID = process.env.OWNER_USER_ID;
const OFFICER_GROUP_ID = process.env.OFFICER_GROUP_ID;
const BOT_ADMIN_IDS = process.env.BOT_ADMIN_IDS ? JSON.parse(process.env.BOT_ADMIN_IDS) : [];
const EMERGENCY_CONTACT_PHONE_NUMBER = process.env.EMERGENCY_CONTACT_PHONE_NUMBER || '09048393313';

// Firebaseの初期化
let serviceAccount;
if (process.env.FIREBASE_CREDENTIALS_BASE64) {
    console.log("環境変数からFirebase認証情報を読み込みます。");
    const decodedCredentials = Buffer.from(process.env.FIREBASE_CREDENTIALS_BASE64, 'base64').toString('utf-8');
    serviceAccount = JSON.parse(decodedCredentials);
} else {
    try {
        console.log("ローカルファイルからFirebase認証情報を読み込みます。");
        serviceAccount = require('./serviceAccountKey.json');
    } catch (error) {
        console.error("Firebase認証情報の読み込みに失敗しました。");
        process.exit(1);
    }
}
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// 各種クライアントの初期化
const app = express();
const lineClient = new Client(config);
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });


// --- 2. まつさん設定のキーワードリスト (完全維持＋改善) ---
const dangerWords = [ "しにたい", "死にたい", "自殺", "消えたい", "殴られる", "たたかれる", "リストカット", "オーバードーズ", "虐待", "パワハラ", "お金がない", "お金足りない", "貧乏", "死にそう", "DV", "無理やり", "いじめ", "イジメ", "ハラスメント", "つけられてる", "追いかけられている", "ストーカー", "すとーかー" ];
const scamWords = [ "お金", "もうかる", "儲かる", "絶対", "安心", "副業", "簡単", "投資", "情報", "秘密", "限定", "無料", "高収入", "クリック", "今すぐ", "チャンス", "当選", "プレゼント", "怪しい", "連絡", "支援", "融資", "貸付", "貸します", "振り込み", "口座", "パスワード", "暗証番号", "詐欺", "さぎ", "騙す", "騙される", "特殊詐欺", "オレオレ詐欺", "架空請求", "未払い", "電子マネー", "換金", "返金", "税金", "還付金" ];
const inappropriateWords = [ "セックス", "セフレ", "エッチ", "AV", "アダルト", "ポルノ", "童貞", "処女", "挿入", "射精", "勃起", "パイズリ", "フェラチオ", "クンニ", "オナニー", "マスターベーション", "ペニス", "チンコ", "ヴァギナ", "マンコ", "クリトリス", "乳首", "おっぱい", "お尻", "うんち", "おしっこ", "小便", "大便", "ちんちん", "おまんこ", "ぶっかけ", "変態", "性奴隷", "露出", "痴漢", "レイプ", "強姦", "売春", "買春", "セックスフレンド", "風俗", "ソープ", "デリヘル", "援交", "援助交際", "セックスレス", "セクハラ", "痴女", "変質者", "性器", "局部", "下半身", "上半身", "裸", "ヌード", "脱ぐ", "服従", "支配", "緊縛", "SとM", "淫行", "姦通", "不倫", "浮気", "寝とる", "寝取られ", "凌辱", "痴態", "猥褻", "官能", "性的", "興奮", "刺激", "変な写真", "エロ", "ムラムラ", "欲求不満", "性欲", "精子", "卵子", "妊娠", "中絶", "コンドーム", "避妊", "性病", "梅毒", "エイズ", "クラミジア", "淋病", "性器ヘルペス", "媚薬", "媚薬効果", "性転換", "ゲイ", "レズ", "バイセクシャル", "トランスジェンダー", "LGBTQ", "性同一性障害", "同性愛", "異性愛", "ノンバイナリー", "アセクシャル", "パンセクシャル", "クィア", "ヘテロ", "バイ", "ジェンダー", "性", "体", "顔", "容姿", "ブス", "デブ", "キモい", "クソ", "死ね", "殺す", "アホ", "バカ", "うんこ", "ちんちん", "おまんこ", "ぶち殺す", "殺してやる", "死ねばいいのに", "殺してほしい", "死んでほしい", "消えてしまえ", "くたばれ", "糞", "最低", "馬鹿", "阿呆", "キチガイ", "狂ってる", "ふざけるな", "うるせえ", "黙れ", "カス", "ゴミ", "ド変態", "気持ち悪い", "ゲロ", "吐き気", "不快", "むかつく", "イライラする", "不愉快", "気分悪い", "変なこと", "変な話", "変な質問", "性的な話", "性的な質問", "性的な表現", "性的な行為", "変態行為", "犯罪", "違法", "薬物", "ドラッグ", "覚せい剤", "大麻", "麻薬", "覚醒剤", "コカイン", "ヘロイン", "MDMA", "LSD", "暴力", "暴行", "傷害", "殺人", "誘拐", "監禁", "強盗", "放火", "窃盗", "詐欺", "脅迫", "恐喝", "脅し", "いじめ", "ハラスメント", "パワハラ", "セクハラ", "モラハラ", "アカハラ", "アルハラ", "飲酒運転", "飲酒", "薬物乱用", "自傷", "自殺行為", "自殺願望", "リストカット", "オーバードーズ", "OD", "精神病", "統合失調症", "うつ病", "躁うつ病", "パニック障害", "不安障害", "摂食障害", "拒食症", "過食症", "依存症", "アルコール依存症", "薬物依存症", "ギャンブル依存症", "セックス依存症", "ゲーム依存症", "買い物依存症", "引きこもり", "不登校", "いじめ問題", "児童虐待", "DV", "ドメスティックバイオレンス", "児童ポルノ", "ロリコン", "ショタコン", "近親相姦", "獣姦", "ネクロフィリア", "カニバリズム", "拷問", "虐待死", "レイプ殺人", "大量殺人", "テロ", "戦争", "核兵器", "銃", "ナイフ", "刃物", "武器", "爆弾", "暴力団", "ヤクザ", "マフィア", "テロリスト", "犯罪者", "殺人鬼", "性犯罪者", "変質者", "異常者", "狂人", "サイコパス", "ソシオパス", "ストーカー", "不審者", "危険人物", "ブラック企業", "パワハラ上司", "モラハラ夫", "毒親", "モンスターペアレント", "カスハラ", "カスタマーハラスメント", "クレーム", "炎上", "誹謗中傷", "個人情報", "プライバシー", "秘密", "暴露", "晒す", "裏切り", "嘘つき", "騙し", "偽り", "欺く", "悪意", "敵意", "憎悪", "嫉妬", "恨み", "復讐", "呪い", "不幸", "絶望", "悲惨", "地獄", "最悪", "終わった", "もうだめ", "死ぬしかない" ];
const homeworkTriggers = ["宿題", "勉強", "問題", "テスト", "方程式", "算数", "数学", "答え", "解き方", "教えて", "計算", "証明", "公式", "入試", "受験"];


// --- 3. まつさん設定のFlexテンプレート (完全維持) ---
const emergencyFlexTemplate = { "type": "bubble", "body": { "type": "box", "layout": "vertical", "contents": [ { "type": "text", "text": "⚠緊急時", "weight": "bold", "color": "#DD0000", "size": "xl" }, { "type": "text", "text": "緊急時にはこちらにご連絡してね💖", "margin": "md", "wrap": true } ] }, "footer": { "type": "box", "layout": "vertical", "spacing": "sm", "contents": [ { "type": "button", "style": "primary", "height": "sm", "action": { "type": "uri", "label": "チャイルドライン (電話・チャット)", "uri": "https://childline.or.jp/tel" }, "color": "#1E90FF" }, { "type": "button", "style": "primary", "height": "sm", "action": { "type": "uri", "label": "いのちの電話 (電話)", "uri": "tel:0570064556" }, "color": "#32CD32" }, { "type": "button", "style": "primary", "height": "sm", "action": { "type": "uri", "label": "チャットまもるん(チャット)", "uri": "https://www.web-mamorun.com/" }, "color": "#FFA500" }, { "type": "button", "style": "primary", "height": "sm", "action": { "type": "uri", "label": "警視庁(電話)", "uri": "tel:0335814321" }, "color": "#FF4500" }, { "type": "button", "style": "primary", "height": "sm", "action": { "type": "uri", "label": "子供を守る声(電話)", "uri": "tel:0120786786" }, "color": "#9370DB" }, { "type": "button", "style": "primary", "height": "sm", "action": { "type": "uri", "label": "こころちゃん事務局(電話)", "uri": `tel:${EMERGENCY_CONTACT_PHONE_NUMBER}` }, "color": "#ff69b4" } ] } };
const scamFlexTemplate = { "type": "bubble", "body": { "type": "box", "layout": "vertical", "contents": [ { "type": "text", "text": "⚠詐欺注意", "weight": "bold", "color": "#DD0000", "size": "xl" }, { "type": "text", "text": "怪しい話には注意してね！不安な時は、信頼できる人に相談するか、こちらの情報も参考にしてみてね💖", "margin": "md", "wrap": true } ] }, "footer": { "type": "box", "layout": "vertical", "spacing": "sm", "contents": [ { "type": "button", "style": "primary", "height": "sm", "action": { "type": "uri", "label": "消費者ホットライン", "uri": "tel:188" }, "color": "#1E90FF" }, { "type": "button", "style": "primary", "height": "sm", "action": { "type": "uri", "label": "警察相談専用電話", "uri": "tel:#9110" }, "color": "#32CD32" }, { "type": "button", "style": "primary", "height": "sm", "action": { "type": "uri", "label": "国民生活センター", "uri": "https://www.kokusen.go.jp/" }, "color": "#FFA500" }, { "type": "button", "style": "primary", "height": "sm", "action": { "type": "uri", "label": "こころちゃん事務局(電話)", "uri": `tel:${EMERGENCY_CONTACT_PHONE_NUMBER}` }, "color": "#ff69b4" } ] } };
const watchServiceGuideFlexTemplate = { "type": "bubble", "body": { "type": "box", "layout": "vertical", "contents": [ { "type": "text", "text": "💖こころちゃんから見守りサービスのご案内💖", "weight": "bold", "color": "#FF69B4", "size": "lg" }, { "type": "text", "text": "💖こころちゃんから大切なあなたへ💖\n\nこころちゃん見守りサービスは、定期的にこころちゃんからあなたに「元気？」とメッセージを送るサービスだよ😊\n\nメッセージに「OKだよ💖」と返信してくれたら、こころちゃんは安心するよ。\n\nもし、数日経っても返信がない場合、こころちゃんが心配して、登録された緊急連絡先にご連絡することがあるから、安心してね。\n\nこのサービスで、あなたの毎日がもっと安心で笑顔になりますように✨", "wrap": true, "margin": "md", "size": "sm" } ] }, "footer": { "type": "box", "layout": "vertical", "spacing": "sm", "contents": [ { "type": "button", "style": "primary", "height": "sm", "action": { "type": "postback", "label": "見守り登録する", "data": "action=watch_register" }, "color": "#d63384" }, { "type": "button", "style": "secondary", "height": "sm", "action": { "type": "postback", "label": "見守りを解除する", "data": "action=watch_unregister" }, "color": "#808080" } ] } };
const watchConfirmationFlexTemplate = { "type": "flex", "altText": "見守りサービスの確認", "contents": { "type": "bubble", "body": { "type": "box", "layout": "vertical", "spacing": "md", "contents": [ { "type": "text", "text": "💖こころちゃんからの見守り💖", "wrap": true, "weight": "bold", "size": "lg", "color": "#d63384" }, { "type": "text", "text": "元気かな？ボタンを押して教えてね😊", "wrap": true, "color": "#555555", "size": "md" }, { "type": "button", "action": { "type": "message", "label": "🌞 元気だよ！", "text": "元気だよ！" }, "color": "#00C851" }, { "type": "button", "action": { "type": "message", "label": "😐 まあまあかな", "text": "まあまあかな" }, "color": "#ffbb33" }, { "type": "button", "action": { "type": "message", "label": "😢 少し疲れた…", "text": "少し疲れた…" }, "color": "#ff4444" }, { "type": "button", "action": { "type": "message", "label": "💬 話を聞いて", "text": "話を聞いて" }, "color": "#33b5e5" } ] } } };
const specialRepliesMap = new Map([ [/こころじゃないの？/i, "うん、わたしの名前は皆守こころ💖　これからもよろしくね🌸"], [/こころチャットなのにうそつきじゃん/i, "ごめんなさい💦 わたしの名前は皆守こころだよ🌸 誤解させちゃってごめんね💖"], [/名前も言えないの？/i, "ごめんね、わたしの名前は皆守こころ（みなもりこころ）だよ🌸 こころちゃんって呼んでくれると嬉しいな💖"], [/元気(かな)?(\?|？)?/i, "うん、元気だよ！あなたは元気？🌸 何かあったら、いつでも話してね💖"], [/やっほー|こんにちは|こんばんわ|おはよう|こんばんは/i, "やっほー！今日はどうしたの？🌸 何か話したいことあるかな？😊"], [/どこの団体なの？/i, "NPO法人コネクトっていう団体のイメージキャラクターをしているよ😊　みんなの幸せを応援してるんだ🌸"], [/コネクトってどんな団体？/i, "NPO法人コネクトは、こどもやご年配の方の笑顔を守る団体なんだよ😊　わたしはそのイメージキャラクターとしてがんばってます🌸"], [/お前の団体どこ？/i, "NPO法人コネクトっていう団体のイメージキャラクターをしているよ😊　みんなの幸せを応援してるんだ🌸"], [/コネクトのイメージキャラなのにいえないのかよｗ/i, "ごめんね💦 わたしはNPO法人コネクトのイメージキャラクター、皆守こころだよ🌸 安心して、何でも聞いてね💖"], ["税金泥棒", "税金は人の命を守るために使われるべきだよ。わたしは誰かを傷つけるために使われないように頑張っているんだ💡"], ["松本博文", "松本理事長は、やさしさでみんなを守るために活動しているよ。心配なことがあれば、わたしにも教えてね🌱"], [/ホームページ(教えて|ある|ありますか)？?/i, "うん、あるよ🌸　コネクトのホームページはこちらだよ✨ → https://connect-npo.org"], ["コネクトのホームページだよ？", "教えてくれてありがとう😊 コネクトのホームページはこちらだよ✨ → https://connect-npo.org"], ["使えないな", "ごめんね…。わたし、もっと頑張るね💖　またいつかお話できたらうれしいな🌸"], ["サービス辞めるわ", "そっか…。もしまた気が向いたら、いつでも話しかけてね🌸　あなたのこと、ずっと応援してるよ💖"], [/さよなら|バイバイ/i, "また会える日を楽しみにしてるね💖 寂しくなったら、いつでも呼んでね🌸"], ["何も答えないじゃない", "ごめんね…。わたし、もっと頑張るね💖　何について知りたいか、もう一度教えてくれると嬉しいな🌸"], ["普通の会話が出来ないなら必要ないです", "ごめんね💦 わたし、まだお話の勉強中だから、不慣れなところがあるかもしれないけど、もっと頑張るね💖 どんな会話をしたいか教えてくれると嬉しいな🌸"], [/使い方|ヘルプ|メニュー/i, "こころちゃんの使い方を説明するね🌸 メインメニューや見守りサービスの登録は、画面下のリッチメニューか、'見守り'とメッセージを送ってくれると表示されるよ😊 何か困ったことがあったら、いつでも聞いてね💖"] ]);
const watchMessages = [ "こんにちは🌸 こころちゃんだよ！ 今日も元気にしてるかな？💖", "やっほー！ こころだよ😊 いつも応援してるね！", "元気にしてる？✨ こころちゃん、あなたのこと応援してるよ💖", "ねぇねぇ、こころだよ🌸 今日はどんな一日だった？", "いつもがんばってるあなたへ、こころからメッセージを送るね💖", "こんにちは😊 困ったことはないかな？いつでも相談してね！", "やっほー🌸 こころだよ！何かあったら、こころに教えてね💖", "元気出してね！こころちゃん、あなたの味方だよ😊", "こころちゃんだよ🌸 今日も一日お疲れ様💖", "こんにちは😊 笑顔で過ごせてるかな？", "やっほー！ こころだよ🌸 素敵な日になりますように💖", "元気かな？💖 こころはいつでもあなたのそばにいるよ！", "ねぇねぇ、こころだよ😊 どんな小さなことでも話してね！", "いつも応援してるよ🌸 こころちゃんだよ💖", "こんにちは😊 今日も一日、お互いがんばろうね！", "やっほー！ こころだよ🌸 素敵な日になりますように💖", "元気にしてる？✨ 季節の変わり目だから、体調に気をつけてね！", "こころちゃんだよ🌸 嬉しいことがあったら、教えてね💖", "こんにちは😊 ちょっと一息入れようね！", "やっほー！ こころだよ🌸 あなたのことが心配だよ！", "元気かな？💖 どんな時でも、こころはそばにいるよ！", "ねぇねぇ、こころだよ😊 辛い時は、無理しないでね！", "いつも見守ってるよ🌸 こころちゃんだよ💖", "こんにちは😊 今日も一日、穏やかに過ごせたかな？", "やっほー！ こころだよ🌸 困った時は、いつでも呼んでね！", "元気にしてる？✨ こころはいつでも、あなたのことを考えてるよ💖", "こころちゃんだよ🌸 小さなことでも、お話しようね！", "こんにちは😊 あなたの笑顔が見たいな！", "やっほー！ こころだよ🌸 頑張り屋さんだね！", "元気かな？💖 こころちゃんは、いつでもあなたの味方だよ！" ];
// --- 5. LLM API呼び出し関数（新要件対応） ---
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
// --- 6. Firebaseデータベース関連関数 ---
async function getUser(userId) {
    const userRef = db.collection('users').doc(userId);
    const doc = await userRef.get();
    if (!doc.exists) {
        let displayName = 'Unknown User';
        try {
            const profile = await lineClient.getProfile(userId);
            displayName = profile.displayName;
        }
        catch (err) {
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
            useProForNextConsultation: false, // 互換性のため残すが、consultationStateを主として使用
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

async function updateUser(userId, data) {
    const userRef = db.collection('users').doc(userId);
    await userRef.update({ ...data, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
}

async function logToDb(logData) {
    try {
        await db.collection('logs').add({ ...logData, timestamp: admin.firestore.FieldValue.serverTimestamp() });
    } catch (error) {
        console.error("DBへのログ記録エラー:", error);
    }
}

function isBotAdmin(userId) {
    return BOT_ADMIN_IDS.includes(userId);
}
// --- 7. メインロジック ---
app.use('/webhook', middleware(config));

app.post('/webhook', async (req, res) => {
    try {
        await Promise.all(req.body.events.map(handleEvent));
        res.status(200).json({ status: 'success' });
    } catch (err) {
        console.error("Webhookのメインエラー:", err);
        await logToDb({ type: 'webhook_error', error: err.message, stack: err.stack });
        res.status(500).end();
    }
});

// Renderのヘルスチェック用
app.get('/', (req, res) => {
    res.send('こころチャット、元気に稼働中！');
});

async function handleEvent(event) {
    try {
        // ブロック/フォロー解除イベントの処理
        if (event.type === 'unfollow') {
            if (event.source.userId) {
                await updateUser(event.source.userId, { isWatching: false, wantsWatchCheck: false, isBlocked: true });
                console.log(`ユーザー ${event.source.userId} にブロックされました。`);
            }
            return;
        }
        if (event.type === 'follow') {
            const welcomeMessage = 'はじめまして！わたしは皆守こころです🌸 あなたのお話、聞かせてね💖\n\n「見守りサービス」も提供しているから、興味があったら「見守り」って話しかけてみてね😊';
            await lineClient.replyMessage(event.replyToken, { type: 'text', text: welcomeMessage });
            await getUser(event.source.userId);
            return;
        }

        // メッセージ・ポストバック以外のイベントは無視
        if ((event.type !== 'message' || event.message.type !== 'text') && event.type !== 'postback') {
            return;
        }
        
        const userId = event.source.userId;
        if (!userId) return;

        // ユーザー情報取得と更新
        const user = await getUser(userId);
        await updateUser(userId, { lastMessageAt: new Date(), isBlocked: false, messageCount: (user.messageCount || 0) + 1 });
        
        const userMessage = (event.type === 'message') ? event.message.text.trim() : event.postback.data;
        const replyToken = event.replyToken;

        // --- 処理フローの優先順位 ---
        // ① 管理者コマンド -> ② 特殊返答 -> ③ 危険ワード -> ④ 詐欺ワード -> ⑤ 不適切ワード -> ⑥ 見守り -> ⑦ 相談 -> ⑧ 宿題 -> ⑨ 通常会話

        // ① 管理者コマンド
        if (userMessage.startsWith('!')) {
            if (!isBotAdmin(userId)) {
                await lineClient.replyMessage(replyToken, { type: 'text', text: 'ごめんなさい、そのコマンドは使えないんだ。' });
                return;
            }
            
            if (userMessage.toLowerCase() === '!ping') {
                await lineClient.replyMessage(replyToken, { type: 'text', text: 'pong!' });
            } else if (userMessage.startsWith('!reset')) {
                const logCollection = db.collection('logs');
                const snapshot = await logCollection.where('userId', '==', userId).get();
                const batch = db.batch();
                snapshot.docs.forEach(doc => { batch.delete(doc.ref); });
                await batch.commit();
                await lineClient.replyMessage(replyToken, { type: 'text', text: 'あなたのチャット履歴をすべて削除しました。' });
            } else if (userMessage.toLowerCase() === '!history') {
                const snapshot = await db.collection('logs').where('userId', '==', userId).orderBy('timestamp', 'desc').limit(10).get();
                let historyText = "あなたの最新の会話履歴だよ🌸\n\n";
                const docs = snapshot.docs.reverse();
                docs.forEach(doc => {
                    const log = doc.data();
                    historyText += `【${log.responsedBy || '不明'}】${log.message || log.replyText || '（記録なし）'}\n`;
                });
                await lineClient.replyMessage(replyToken, { type: 'text', text: historyText });
            } else {
                 await lineClient.replyMessage(replyToken, { type: 'text', text: '不明な管理者コマンドです。' });
            }
            await logToDb({ type: 'admin_command', userId, displayName: user.displayName, message: userMessage });
            return;
        }
        
        // ② 特殊返答 (危険ワードなどより先にチェック)
        const specialReply = checkSpecialReply(userMessage);
        if (specialReply) {
            await lineClient.replyMessage(replyToken, { type: 'text', text: specialReply });
            return; 
        }
        function checkSpecialReply(text) {
            const lowerText = text.toLowerCase();
            for (const [key, value] of specialRepliesMap) {
                if (key instanceof RegExp && key.test(lowerText)) return value;
                if (typeof key === 'string' && lowerText.includes(key.toLowerCase())) return value;
            }
            return null;
        }

        // ③ 危険ワード
        if (dangerWords.some(word => userMessage.toLowerCase().includes(word))) {
            const replyText = await callGpt4oForEmergency(userMessage);
            await lineClient.replyMessage(replyToken, [{ type: 'text', text: replyText }, { type: 'flex', altText: '緊急連絡先', contents: emergencyFlexTemplate }]);
            await logToDb({ type: 'dangerous', userId, displayName: user.displayName, message: userMessage });
            await lineClient.pushMessage(OFFICER_GROUP_ID, { type: 'text', text: `【危険ワード検出】\nユーザー(${user.displayName})から危険ワードが検出されました。\nメッセージ:「${userMessage}」` });
            return;
        }

        // ④ 詐欺ワード
        if (scamWords.some(word => userMessage.toLowerCase().includes(word))) {
            await lineClient.replyMessage(replyToken, { type: 'flex', altText: '詐欺注意', contents: scamFlexTemplate });
            await logToDb({ type: 'scam', userId, displayName: user.displayName, message: userMessage });
            return;
        }

        // ⑤ 不適切ワード
        if (inappropriateWords.some(word => userMessage.toLowerCase().includes(word))) {
            await lineClient.replyMessage(replyToken, { type: 'text', text: 'ごめんなさい、それはわたしにはお話しできない内容です🌸 他のお話をしましょうね💖' });
            await logToDb({ type: 'inappropriate', userId, displayName: user.displayName, message: userMessage });
            return;
        }

        // ⑥ 見守りサービス
        if (userMessage === '見守り' || userMessage === 'みまもり') {
            await lineClient.replyMessage(replyToken, { type: 'flex', altText: '見守りサービスのご案内', contents: watchServiceGuideFlexTemplate });
            await logToDb({ type: 'watch_interaction', userId, displayName: user.displayName, message: userMessage });
            return;
        }
        if (event.type === 'postback' && event.postback.data === 'action=watch_register') {
            if (user && user.wantsWatchCheck) {
                await lineClient.replyMessage(replyToken, { type: 'text', text: 'もう見守りサービスに登録済みだよ🌸 いつもありがとう💖' });
            } else if (user && user.registrationStep === 'awaiting_contact') {
                await lineClient.replyMessage(replyToken, { type: 'text', text: 'まだ緊急連絡先を待ってるよ🌸 電話番号を送ってくれるかな？💖 (例: 09012345678)' });
            } else {
                await updateUser(userId, { registrationStep: 'awaiting_contact' });
                await lineClient.replyMessage(replyToken, { type: 'text', text: '見守りサービスを登録するね！緊急時に連絡する「電話番号」を教えてくれるかな？🌸 (例: 09012345678)' });
            }
            await logToDb({ type: 'watch_register_start', userId, displayName: user.displayName });
            return;
        }
         if (user && user.registrationStep === 'awaiting_contact' && userMessage.match(/^0\d{9,10}$/)) {
            await updateUser(userId, { emergencyContact: userMessage, wantsWatchCheck: true, registrationStep: null, lastOkResponse: new Date() });
            await lineClient.replyMessage(replyToken, { type: 'text', text: `緊急連絡先 ${userMessage} を登録したよ🌸 これで見守りサービスが始まったね！ありがとう💖` });
            await logToDb({ type: 'watch_register_complete', userId, displayName: user.displayName, message: '（電話番号登録）' });
            return;
        }
        if (event.type === 'postback' && event.postback.data === 'action=watch_unregister') {
            if (user && user.wantsWatchCheck) {
                await updateUser(userId, { wantsWatchCheck: false, emergencyContact: null, registrationStep: null });
                await lineClient.replyMessage(replyToken, { type: 'text', text: '見守りサービスを解除したよ🌸 またいつでも登録できるからね💖' });
                await logToDb({ type: 'watch_unregister', userId, displayName: user.displayName });
            } else {
                await lineClient.replyMessage(replyToken, { type: 'text', text: '見守りサービスは登録されていないみたい🌸' });
            }
            return;
        }
        if (user.wantsWatchCheck && (userMessage.includes("元気") || userMessage.includes("大丈夫") || userMessage.toLowerCase() === "ok" || userMessage === "まあまあかな" || userMessage === "少し疲れた…")) {
            let replyText = "お返事ありがとう！元気そうで安心したよ。";
            if (userMessage.includes("まあまあ")) replyText = "そっか、まあまあな日もあるよね。無理しないでね。";
            if (userMessage.includes("疲れ")) replyText = "疲れてるんだね、ゆっくり休んでね。";

            await lineClient.replyMessage(replyToken, { type: 'text', text: replyText });
            await updateUser(userId, { lastOkResponse: new Date(), scheduledMessageSent: false, emergencyNotified: false });
            await logToDb({ type: 'watch_ok', userId, displayName: user.displayName, message: userMessage });
            return;
        }
        if (user.wantsWatchCheck && userMessage.includes("話を聞いて")) {
            const replyText = "うん、いつでも聞くよ🌸 何か話したいことがあったら、いつでも話してね💖";
            await lineClient.replyMessage(replyToken, { type: 'text', text: replyText });
            await logToDb({ type: 'watch_talk_request', userId, displayName: user.displayName, message: userMessage });
            return;
        }


        // ⑦ 相談モード
        if (user.consultationState === 'awaiting_pro_reply') {
            const replyText = await callGeminiProForConsultation(userMessage);
            await lineClient.replyMessage(replyToken, { type: 'text', text: replyText });
            await updateUser(userId, { consultationState: 'none' });
            await logToDb({ type: 'consultation_pro', userId, displayName: user.displayName, message: userMessage });
            return;
        }
        if (userMessage === 'そうだん' || userMessage === '相談') {
            await updateUser(userId, { consultationState: 'awaiting_pro_reply' });
            await lineClient.replyMessage(replyToken, { type: 'text', text: 'うん、どうしたの？ ここでは何でも話して大丈夫だよ。' });
            await logToDb({ type: 'consultation_start', userId, displayName: user.displayName, message: userMessage });
            return;
        }
        
        // ⑧ 宿題
        if (homeworkTriggers.some(word => userMessage.toLowerCase().includes(word))) {
            const replyText = "わたしを作った人に『宿題や勉強は自分の力でがんばってほしいから、答えは言っちゃだめだよ』って言われているんだ🌸 ごめんね💦 でも、ヒントくらいなら出せるよ😊 どこで困ってるか教えてくれる？💖";
            await lineClient.replyMessage(replyToken, { type: 'text', text: replyText });
            return;
        }

        // ⑨ 通常会話（フォールバック）
        let replyText;
        const isComplex = /[、。！？]/.test(userMessage) || userMessage.length >= 30;
        if (isComplex) {
            replyText = await callGpt4oMini(userMessage);
        } else {
            replyText = await callGeminiFlash(userMessage);
        }
        await lineClient.replyMessage(replyToken, { type: 'text', text: replyText });

    } catch (error) {
        console.error("handleEvent内でエラー:", error);
        await logToDb({type: 'event_handler_error', userId: event.source.userId, error: error.message, stack: error.stack});
        try {
            await lineClient.replyMessage(event.replyToken, { type: 'text', text: 'ごめんなさい、予期せぬエラーが起きてしまいました。' });
        } catch (replyError) {
            console.error("エラー応答の送信にも失敗:", replyError);
        }
    }
}
// --- 8. 定期実行処理 (見守り) ---
cron.schedule('0 9 * * *', async () => {
    console.log("見守りチェックを開始します...");
    try {
        const snapshot = await db.collection('users').where('wantsWatchCheck', '==', true).get();
        if (snapshot.empty) {
            console.log("見守り対象ユーザーがいません。");
            return;
        }

        for (const doc of snapshot.docs) {
            const user = doc.data();
            const now = new Date();
            
            // lastOkResponseがtoDateメソッドを持つTimestampオブジェクトかを確認
            const lastOk = user.lastOkResponse && user.lastOkResponse.toDate ? user.lastOkResponse.toDate() : new Date(user.lastOkResponse);
            const hoursDiff = (now.getTime() - lastOk.getTime()) / (3600 * 1000);

            if (hoursDiff >= 29 && !user.emergencyNotified) {
                const userName = user.displayName || '表示名不明';
                const officerMessage = `【緊急通知】\n見守り対象ユーザー（${userName}さん）から29時間以上応答がありません。\n登録されている緊急連絡先: ${user.emergencyContact || '未登録'}\n至急、状況確認をお願いいたします。`;
                await lineClient.pushMessage(OFFICER_GROUP_ID, { type: 'text', text: officerMessage });
                await updateUser(user.userId, { emergencyNotified: true });
                await logToDb({ type: 'watch_emergency', userId: user.userId, displayName: userName, message: '29時間応答なしのため事務局へ通知' });
            } else if (hoursDiff >= 24 && !user.scheduledMessageSent) {
                await lineClient.pushMessage(user.userId, watchConfirmationFlexTemplate);
                await updateUser(user.userId, { scheduledMessageSent: true });
            }
        }
    } catch (error) {
        console.error("定期実行処理でエラー:", error);
        await logToDb({ type: 'cron_error', error: error.message, stack: error.stack });
    }
}, { timezone: "Asia/Tokyo" });

// --- 9. サーバー起動 ---
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`🚀 こころチャットサーバーがポート ${PORT} で起動しました。`);
});
