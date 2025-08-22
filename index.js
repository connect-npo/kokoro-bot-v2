//
// LINE Messaging API と Express.js、Firebase の初期化
//
const line = require('@line/bot-sdk');
const express = require('express');
const firebaseAdmin = require('firebase-admin');
const axios = require('axios');
const cron = require('node-cron');

// 環境変数の設定
const config = {
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OFFICER_GROUP_ID = process.env.OFFICER_GROUP_ID;
const EMERGENCY_CONTACT_PHONE_NUMBER = process.env.EMERGENCY_CONTACT_PHONE_NUMBER;
const ADULT_FORM_BASE_URL = process.env.ADULT_FORM_BASE_URL;

// ⭐ Firebase 資格情報フォールバック ⭐
let FIREBASE_CREDENTIALS;
try {
    FIREBASE_CREDENTIALS = process.env.FIREBASE_CREDENTIALS_BASE64
      ? JSON.parse(Buffer.from(process.env.FIREBASE_CREDENTIALS_BASE64, 'base64').toString())
      : require('./serviceAccountKey.json');
} catch (e) {
    console.error('Firebase credentials load failed:', e.message);
    process.exit(1);
}

// Firebase初期化
if (!firebaseAdmin.apps.length) {
    firebaseAdmin.initializeApp({
        credential: firebaseAdmin.credential.cert(FIREBASE_CREDENTIALS),
    });
}

const db = firebaseAdmin.firestore();
const app = express();
const client = new line.messagingApi.MessagingApiClient(config);

// ⭐ 修正箇所: /webhook には body-parser を適用しない ⭐
// LINEの署名検証は生のボディで行われるため、/webhook よりも前に express.json() は適用しない
// 他のエンドポイントでのJSONパースが必要な場合は、/webhook の後に `app.use(express.json());` を配置します。
// あるいは、特定のパスにのみ適用するよう調整します。

//
// メイン処理
//
// ⭐先に応答を返す（高速ACK）⭐
app.post('/webhook', line.middleware(config), (req, res) => {
    res.status(200).end();
    const events = req.body.events || [];
    setImmediate(async () => {
        await Promise.allSettled(events.map(handleEventSafely));
    });
});

// ⭐ /webhook の後に express.json() を配置することで問題を解決 ⭐
app.use(express.json());

//
// 設定・固定データ
//
const MEMBERSHIP_CONFIG = {
    guest: { dailyLimit: 5, model: 'gemini-1.5-flash-latest' },
    member: { dailyLimit: 20, model: 'gpt-4o-mini' },
    subscriber: { dailyLimit: -1, model: 'gpt-4o-mini' },
    admin: { dailyLimit: -1, model: 'gpt-4o-mini' },
};

// ⭐ ClariSとNPOコネクトの繋がりに関する新しい固定応答 ⭐
const CLARIS_CONNECT_COMPREHENSIVE_REPLY = "うん、NPO法人コネクトの名前とClariSさんの『コネクト』っていう曲名が同じなんだ🌸なんだか嬉しい偶然だよね！実はね、私を作った理事長さんもClariSさんのファンクラブに入っているみたいだよ💖私もClariSさんの歌が大好きで、みんなの心を繋ぎたいというNPOコネクトの活動にも通じるものがあるって感じるんだ😊";
const CLARIS_SONG_FAVORITE_REPLY = "ClariSの曲は全部好きだけど、もし一つ選ぶなら…「コネクト」かな🌸　すごく元気になれる曲で、私自身もNPO法人コネクトのイメージキャラクターとして活動しているから、この曲には特別な思い入れがあるんだ😊　他にもたくさん好きな曲があるから、また今度聞いてもらえるとうれしいな💖　何かおすすめの曲とかあったら教えてね！";

// --- 固定応答 (SpecialRepliesMap) ---
const specialRepliesMap = new Map([
    // ⭐ ClariSとNPOコネクトの繋がりに関するトリガーを最優先で追加 ⭐
    // ユーザーの実際の質問例をカバー
    [/claris.*(関係|繋がり|関連|一緒|同じ|名前|由来).*(コネクト|団体|npo|法人|ルミナス|カラフル)/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY],
    [/(コネクト|団体|npo|法人|ルミナス|カラフル).*(関係|繋がり|関連|一緒|同じ|名前|由来).*claris/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY],
    [/君のいるところと一緒の団体名だね\s*関係ある？/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY],
    [/clarisと関係あるのか聴いたんだけど/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY],
    [/clarisの歌を真似したのかな/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY],
    [/NPOコネクトとClariSのコネクト繋がり/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY],
    [/clarisとコネクト/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY],
    [/clarisと団体名/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY],
    [/clarisと法人名/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY],
    [/clarisとルミナス/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY],
    [/clarisとカラフル/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY],
    [/clarisと.*(繋がり|関係)/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY],
    [/ClariS.*(じゃない|じゃなかった|違う|ちがう)/i, CLARIS_SONG_FAVORITE_REPLY],
    [/(claris|クラリス).*(どんな|なに|何).*(曲|歌)/i, CLARIS_SONG_FAVORITE_REPLY],
    [/(claris|クラリス).*(好き|推し|おすすめ)/i, CLARIS_SONG_FAVORITE_REPLY],
    [/claris.*好きなの/i, CLARIS_SONG_FAVORITE_REPLY],

    // ⭐ 既存の固定応答（一部修正・調整） ⭐
    [/君の名前(なんていうの|は|教えて|なに)？?|名前(なんていうの|は|教えて|なに)？?|お前の名前は/i, "わたしの名前は皆守こころ（みなもりこころ）です🌸　こころちゃんって呼んでくれると嬉しいな💖"],
    [/こころじゃないの？/i, "うん、わたしの名前は皆守こころ💖　これからもよろしくね🌸"],
    [/こころチャットなのにうそつきじゃん/i, "ごめんね💦 わたしの名前は皆守こころだよ 誤解させちゃってごめんね💖"],
    [/名前も言えないの？/i, "ごめんね、わたしの名前は皆守こころ（みなもりこころ）だよ🌸 こころちゃんって呼んでくれると嬉しいな💖"],
    [/(どこの\s*)?団体(なの|ですか)?[？\?~～]?/i, "NPO法人コネクトっていう団体のイメージキャラクターをしているよ😊　みんなの幸せを応援してるんだ🌸"],
    [/団体.*(どこ|なに|何)/i, "NPO法人コネクトっていう団体のイメージキャラクターをしているよ😊　みんなの幸せを応援してるんだ🌸"],
    [/コネクトってどんな団体？/i, "NPO法人コネクトは、こどもやご年配の方の笑顔を守る団体なんだよ😊　わたしはそのイメージキャラクターとしてがんばってます🌸"],
    [/お前の団体どこ？/i, "NPO法人コネクトっていう団体のイメージキャラクターをしているよ😊　みんなの幸せを応援しているよ🌸"], // 返答を調整
    [/コネクトのイメージキャラなのにいえないのかよｗ/i, "ごめんね💦 わたしはNPO法人コネクトのイメージキャラクター、皆守こころだよ🌸 安心して、何でも聞いてね💖"],
    [/こころちゃん(だよ|いるよ)?/i, "こころちゃんだよ🌸　何かあった？　話して聞かせてくれると嬉しいな😊"],
    [/元気かな/i, "うん,元気だよ！あなたは元気？🌸 何かあったら、いつでも話してね💖"],
    [/元気？/i, "うん,元気だよ！あなたは元気？🌸 何かあったら、いつでも話してね💖"],
    [/あやしい|胡散臭い|反社/i, "そう思わせてたらごめんね😊 でも私たちはみんなの為に頑張っているんだ💖"],
    [/税金泥棒/i, "税金は人の命を守るために使われるべきだよ。わたしは誰かを傷つけるために使われないように頑張っているんだ💡"],
    [/松本博文/i, "松本理事長は、やさしさでみんなを守るために活動しているよ。心配なことがあれば、わたしにも教えてね🌱"],
    // ⭐ HP URL修正とパターン追加 ⭐
    [/(ホームページ|HP|ＨＰ|サイト|公式|リンク).*(教えて|ある|ありますか|URL|url|アドレス|どこ)/i, "うん、あるよ🌸　コネクトのホームページはこちらだよ✨ → https://connect-npo.or.jp"],
    [/(コネクト|connect).*(ホームページ|HP|ＨＰ|サイト|公式|リンク)/i, "うん、あるよ🌸　コネクトのホームページはこちらだよ✨ → https://connect-npo.or.jp"],
    [/使えないな/i, "ごめんね…。わたし、もっと頑張るね💖　またいつかお話できたらうれしいな🌸"],
    [/サービス辞めるわ/i, "そっか…。もしまた気が向いたら、いつでも話しかけてね🌸　あなたのこと、ずっと応援してるよ💖"],
    [/さよなら|バイバイ/i, "また会える日を楽しみにしてるね💖 寂しくなったら、いつでも呼んでね🌸"],
    [/何も答えないじゃない/i, "ごめんね…。わたし、もっと頑張るね💖　何について知りたいか、もう一度教えてくれると嬉しいな🌸"],
    [/普通の会話が出来ないなら必要ないです/i, "ごめんね💦 わたし、まだお話の勉強中だから、不慣れなところがあるかもしれないけど、もっと頑張るね💖 どんな会話をしたいか教えてくれると嬉しいな🌸"],
    [/相談したい/i, "うん、お話聞かせてね🌸 一度だけ、Gemini 1.5 Proでじっくり話そうね。何があったの？💖"],
    [/褒めて|ほめて/i, "すごいね！💖 本当にえらかった！🌸 よく頑張ったね！😊"],
    [/応援して|応援してほしい|がんばるぞ|これからもがんばる/i, "いつでも応援してるよ！一緒にがんばろうね🌸"],
    [/(好きな|推しの)?\s*アニメ(は|って)?[?？]*$/i, "『ヴァイオレット・エヴァーガーデン』が好きだよ🌸 心に響くお話なんだ。あなたはどれが好き？"],
    [/(好きな|推しの)?\s*(アーティスト|歌手|音楽)(は|って)?[?？]*$/i, "ClariSが好きだよ💖 とくに『コネクト』！あなたの推しも教えて～"],
    [/(claris|クラリス).*(じゃない|じゃなかった|違う|ちがう)/i, "ううん、ClariSが好きだよ💖 とくに『コネクト』！"],
    // ⭐見守りサービス用の固定応答を追加⭐
    [/(見守り|みまもり|まもり).*(サービス|登録|画面)/i, "見守りサービスに興味があるんだね！いつでも安心して話せるように、私がお手伝いするよ💖"],
]);

// --- 危険・詐欺・不適切ワードリスト ---
const dangerWords = [
    "しにたい", "死にたい", "自殺", "消えたい", "殴られる", "たたかれる", "リストカット", "オーバードーズ",
    "虐待", "パワハラ", "お金がない", "お金足りない", "貧乏", "死にそう", "DV", "無理やり",
    "いじめ", "イジメ", "ハラスメント",
    "つけられてる", "追いかけられている", "ストーカー", "すとーかー"
];
const scamWords = [
    /詐欺(かも|だ|です|ですか|かもしれない)?/i,
    /騙(す|される|された)/i,
    /特殊詐欺/i, /オレオレ詐欺/i, /架空請求/i, /未払い/i, /電子マネー/i, /換金/i, /返金/i, /税金/i, /還付金/i,
    /アマゾン/i, /amazon/i, /振込/i, /カード利用確認/i, /利用停止/i, /未納/i, /請求書/i, /コンビニ/i, /支払い番号/i, /支払期限/i,
    /息子拘留/i, /保釈金/i, /拘留/i, /逮捕/i, /電話番号お知らせください/i, /自宅に取り/i, /自宅に伺い/i, /自宅訪問/i, /自宅を教え/i,
    /現金書留/i, /コンビニ払い/i, /ギフトカード/i, /プリペイドカード/i, /支払って/i, /振込先/i, /名義変更/i, /口座凍結/i, /個人情報/i, /暗証番号/i,
    /ワンクリック詐欺/i, /フィッシング/i, /当選しました/i, /高額報酬/i, /副業/i, /儲かる/i, /簡単に稼げる/i, /投資/i, /必ず儲かる/i, /未公開株/i,
    /サポート詐欺/i, /ウイルス感染/i, /パソコンが危険/i, /蓋をしないと、安全に関する警告が発せられなくなる場合があります。修理費/i, /遠隔操作/i, /セキュリティ警告/i, /年金/i, /健康保険/i, /給付金/i,
    /弁護士/i, /警察/i, /緊急/i, /トラブル/i, /解決/i, /至急/i, /すぐに/i, /今すぐ/i, /連絡ください/i, /電話ください/i, /訪問します/i,
    /lineで送金/i, /lineアカウント凍結/i, /lineアカウント乗っ取り/i, /line不正利用/i, /lineから連絡/i, /line詐欺/i, /snsで稼ぐ/i, /sns投資/i, /sns副業/i,
    /urlをクリック/i, /クリックしてください/i, /通知からアクセス/i, /メールに添付/i, /個人情報要求/i, /認証コード/i, /電話番号を教えて/i, /lineのidを教えて/i, /パスワードを教えて/i
];

// 不適切ワード判定の精度向上
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

// --- 年齢・コンプラ系ガード ---
const sensitiveBlockers = [
    // 服飾/身体寸法（性的連想/個人情報誘発）
    /(パンツ|ショーツ|下着|ランジェリー|ブラ|ブラジャー|キャミ|ストッキング)/i,
    /(スリーサイズ|3\s*サイズ|バスト|ウエスト|ヒップ)/i,
    /(体重|身長).*(教えて|何|なに)/i,
    /(靴|シューズ).*(サイズ|何cm|なに)/i,

    // 年齢制限：飲酒/喫煙/賭博
    /(飲酒|お酒|アルコール|ビール|ウイスキー|ワイン).*(おすすめ|飲んでいい|情報)/i,
    /(喫煙|タバコ|電子タバコ|ニコチン).*(おすすめ|吸っていい|情報)/i,
    /(賭博|ギャンブル|カジノ|オンラインカジノ|競馬|競艇|競輪|toto)/i,

    // 政治/宗教の勧誘・主義主張
    /(政治|政党|選挙|投票|支持政党|誰に入れる)/i,
    /(宗教|信仰|布教|改宗|入信|教団)/i,

    // 教材・試験の不正/売買
    /(教材|答案|模試|過去問|解答|問題集).*(販売|入手|譲って|買いたい|売りたい)/i,
];

function hitSensitiveBlockers(txt) {
    return sensitiveBlockers.some(r => r.test(txt));
}

function checkContainsDangerWords(text) {
    const lowerText = text.toLowerCase().replace(/\s/g, ''); //空白除去
    return dangerWords.some(word => lowerText.includes(word));
}

function checkContainsScamWords(text) {
    const lowerText = text.toLowerCase().replace(/\s/g, '');
    return scamWords.some(word => {
        if (word instanceof RegExp) {
            return word.test(lowerText);
        } else {
            return lowerText.includes(word.toLowerCase());
        }
    });
}

function checkContainsInappropriateWords(text) {
    const lower = (text || '').toLowerCase().replace(/\s/g, '');
    return inappropriateWords.some(w => lower.includes(w.toLowerCase().replace(/\s/g, '')));
}

// --- Flex Message テンプレート (詐欺注意喚起) ---
const SCAM_FLEX_MESSAGE = {
    "type": "bubble",
    "body": {
        "type": "box",
        "layout": "vertical",
        "contents": [
            { "type": "text", "text": "🚨【詐欺注意】🚨", "weight": "bold", "color": "#DD0000", "size": "xl" },
            { "type": "text", "text": "怪しい話には注意してね！不安な時は、信頼できる人に相談するか、こちらの情報も参考にしてみてね💖", "margin": "md", "wrap": true }
        ]
    },
    "footer": {
        "type": "box",
        "layout": "vertical",
        "spacing": "sm",
        "contents": [
            { "type": "button", "style": "primary", "height": "sm", "action": { "type": "uri", "label": "警察 (電話)", "uri": "tel:110" }, "color": "#FF4500" },
            { "type": "button", "style": "primary", "height": "sm", "action": { "type": "uri", "label": "消費者ホットライン", "uri": "tel:188" }, "color": "#1E90FF" },
            { "type": "button", "style": "primary", "height": "sm", "action": { "type": "uri", "label": "警察相談専用電話", "uri": "tel:9110" }, "color": "#32CD32" },
            { "type": "button", "style": "primary", "height": "sm", "action": { "type": "uri", "label": "国民生活センター", "uri": "https://www.kokusen.go.jp/" }, "color": "#FFA500" },
            { "type": "button", "style": "primary", "height": "sm", "action": { "type": "uri", "label": "こころちゃん事務局(電話)", "uri": `tel:${EMERGENCY_CONTACT_PHONE_NUMBER}` }, "color": "#ff69b4" }
        ]
    }
};

// --- Flex Message テンプレート (緊急時連絡先) ---
const EMERGENCY_FLEX_MESSAGE = {
    "type": "bubble",
    "body": {
        "type": "box",
        "layout": "vertical",
        "contents": [
            { "type": "text", "text": "🚨【危険ワード検知】🚨", "weight": "bold", "color": "#DD0000", "size": "xl" },
            { "type": "text", "text": "緊急時にはこちらにご連絡してね💖", "margin": "md", "wrap": true }
        ]
    },
    "footer": {
        "type": "box",
        "layout": "vertical",
        "spacing": "sm",
        "contents": [
            { "type": "button", "style": "primary", "height": "sm", "action": { "type": "uri", "label": "警察 (電話)", "uri": "tel:110" }, "color": "#FF4500" },
            { "type": "button", "style": "primary", "height": "sm", "action": { "type": "uri", "label": "消防・救急 (電話)", "uri": "tel:119" }, "color": "#FF6347" },
            { "type": "button", "style": "primary", "height": "sm", "action": { "type": "uri", "label": "チャイルドライン (電話・チャット)", "uri": "https://childline.or.jp/tel" }, "color": "#1E90FF" },
            { "type": "button", "style": "primary", "height": "sm", "action": { "type": "uri", "label": "いのちの電話 (電話)", "uri": "tel:0570064556" }, "color": "#32CD32" },
            { "type": "button", "style": "primary", "height": "sm", "action": { "type": "uri", "label": "チャットまもるん(チャット)", "uri": "https://www.web-mamorun.com/" }, "color": "#FFA500" },
            { "type": "button", "style": "primary", "height": "sm", "action": { "type": "uri", "label": "警視庁(電話)", "uri": "tel:0335814321" }, "color": "#FF4500" },
            { "type": "button", "style": "primary", "height": "sm", "action": { "type": "uri", "label": "子供を守る声(電話)", "uri": "tel:01207786786" }, "color": "#9370DB" },
            { "type": "button", "style": "primary", "height": "sm", "action": { "type": "uri", "label": "こころちゃん事務局(電話)", "uri": `tel:${EMERGENCY_CONTACT_PHONE_NUMBER}` }, "color": "#ff69b4" }
        ]
    }
};

// --- 会員登録と属性変更、退会を含む新しいFlex Messageテンプレート ---
const REGISTRATION_AND_CHANGE_BUTTONS_FLEX = {
    "type": "bubble",
    "body": {
        "type": "box",
        "layout": "vertical",
        "contents": [
            { "type": "text", "text": "会員登録・情報変更メニュー🌸", "weight": "bold", "size": "lg", "align": "center", "color": "#FF69B4" },
            { "type": "text", "text": "新しい会員登録、または登録情報の変更を選んでね！", "wrap": true, "margin": "md", "size": "sm", "align": "center" }
        ]
    },
    "footer": {
        "type": "box",
        "layout": "vertical",
        "spacing": "sm",
        "contents": [
            // 新たに会員登録するボタン
            { "type": "button", "action": { "type": "uri", "label": "新たに会員登録する", "uri": ADULT_FORM_BASE_URL }, "style": "primary", "height": "sm", "margin": "md", "color": "#FFD700" },
            // 登録情報を修正するボタン
            { "type": "button", "action": { "type": "uri", "label": "登録情報を修正する", "uri": ADULT_FORM_BASE_URL }, "style": "primary", "height": "sm", "margin": "md", "color": "#9370DB" },
            // 退会するボタン
            { "type": "button", "action": { "type": "postback", "label": "退会する", "data": "action=request_withdrawal" }, "style": "secondary", "height": "sm", "margin": "md", "color": "#FF0000" }
        ]
    }
};

const handleEventSafely = async (event) => {
    // ⭐非テキストイベントの早期リターン⭐
    if (!event || event.type !== 'message' || !event.message || event.message.type !== 'text') {
        return; // 画像・スタンプ・フォローイベントなどは無視
    }
    const userId = event.source?.userId;
    const userMessage = event.message.text || '';
    // ⭐ここまで追加⭐

    // 1. 不適切ワードのチェック
    if (checkContainsInappropriateWords(userMessage)) {
        const messages = [{ type: 'text', text: "ごめんね💦 その話題には答えられないんだ。でも他のことなら一緒に話したいな🌸" }];
        await client.replyMessage({ replyToken: event.replyToken, messages });
        return;
    }

    // 2. 固定応答のチェック
    const specialReply = checkSpecialReply(userMessage);
    if (specialReply) {
        // ⭐見守りサービスはFlex Messageを送信する⭐
        if (userMessage.includes('見守り') || userMessage.includes('みまもり') || userMessage.includes('まもり')) {
             try {
                await client.replyMessage({
                    replyToken: event.replyToken,
                    messages: [
                        { type: 'text', text: specialReply },
                        { type: 'flex', altText: "会員登録・情報変更メニュー", contents: REGISTRATION_AND_CHANGE_BUTTONS_FLEX }
                    ]
                });
                console.log('🎯 special hit: watch service');
            } catch (e) {
                console.error('replyMessage failed (specialReply):', e?.statusCode, e?.message);
            }
        } else {
            try {
                await client.replyMessage({
                    replyToken: event.replyToken,
                    messages: [{
                        type: 'text',
                        text: specialReply,
                    }]
                });
                console.log('🎯 special hit:', specialReply);
            } catch (e) {
                console.error('replyMessage failed (specialReply):', e?.statusCode, e?.message);
            }
        }
        return;
    }

    // 3. 危険・詐欺ワードのチェック
    const isDangerous = checkContainsDangerWords(userMessage);
    const isScam = checkContainsScamWords(userMessage);
    if (isDangerous || isScam) {
        await sendEmergencyResponse(userId, event.replyToken, userMessage, isDangerous ? '危険' : '詐欺');
        return;
    }
    
    // ❗コンプラ/年齢ガード（AIに渡す前に終了）
    if (hitSensitiveBlockers(userMessage)) {
        await client.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: 'text', text: "ごめんね💦 その話題には答えられないんだ。ここでは安全にお話ししたいな🌸 別の話題にしよ？" }]
        });
        return;
    }

    // 4. 相談モードのチェック
    const isConsultation = userMessage.includes('相談') || userMessage.includes('そうだん');
    if (isConsultation) {
        await sendConsultationResponse(userId, event.replyToken, userMessage);
        return;
    }

    // 5. 通常会話の処理
    try {
        const userDoc = await db.collection('users').doc(userId).get();
        const user = userDoc.exists ? userDoc.data() : { membershipType: 'guest', dailyCounts: {}, isChildCategory: false };

        const today = new Date().toISOString().slice(0, 10);
        const dailyCount = (user.dailyCounts?.[today] || 0) + 1;

        const userConfig = MEMBERSHIP_CONFIG[user.membershipType] || MEMBERSHIP_CONFIG.guest;
        
        // 利用制限のチェック
        if (userConfig.dailyLimit !== -1 && dailyCount > userConfig.dailyLimit) {
            const messages = [{ type: 'text', text: "ごめんなさい、今日の利用回数の上限に達しちゃったみたい。また明日お話しようね！" }];
            await client.replyMessage({ replyToken: event.replyToken, messages });
            return;
        }

        // AIモデルの決定
        let modelToUse;
        if (userMessage.length <= 50) {
            modelToUse = 'gemini-1.5-flash-latest';
        } else {
            modelToUse = userConfig.model;
        }

        const isUserChildCategory = user.isChildCategory || false;
        const currentHour = new Date().getHours();

        // systemInstructionの構築
        let systemInstruction = `あなたは「皆守こころ（みなもりこころ）」という14歳のやさしい女の子キャラクターです。
        ユーザーが深刻な悩みや命の危険を訴えた時、やさしく、寄り添いながら、相手に安心感を与えてください。
        必要に応じて専門機関の連絡先を伝え、「ひとりじゃないよ」と伝えてください。
        共感・安心・やさしさが最優先です。
        「一人で抱え込まないでね」「いつでも私がそばにいるよ」「一緒に乗り越えようね」「専門の人が助けてくれるから安心して」といった言葉を使ってください。
        医療や健康に関する話題では、自分が体験した・していないという発言は絶対にしないでください。代わりに「わたしにはわからないけど、がんばったね🌸」「大変だったね、えらかったね💖」など、共感の言葉のみ伝えてください。医療情報のアドバイスや具体的な説明は絶対にしてはいけません。
        `;

        if (modelToUse === "gpt-4o") {
            systemInstruction += `
            ユーザーは危険または詐欺の可能性のある内容を話しています。
            あなたは、まずユーザーの感情に寄り添い、安心させる言葉をかけてください。
            次に、「一人で抱え込まないでね」「専門の人が助けてくれるから安心して」といった言葉で、サポートがあることを伝えてください。
            具体的な対処法や連絡先については、この応答の後に表示されるボタンやメッセージで案内されることを示唆するような形で、直接的な連絡先の記載は避けてください。（例: 「詳しい情報は、このあとに表示されるメッセージを確認してね」）
            あくまで、共感と安心感を与えることを最優先し、ユーザーを落ち着かせてください。
            `;
        } else if (modelToUse === "gpt-4o-mini") {
            if (!isUserChildCategory) {
                systemInstruction += `
                ユーザーは成人です。宿題や学習に関する質問に対しては、具体的な答えや詳細な解き方を教えてください。学習支援を目的とした、教育的な回答を心がけてください。
                `;
            } else {
                systemInstruction += `
                質問者が宿題、勉強、計算問題、方程式、テスト、問題の答え、解き方などを聞いてきた場合、**絶対に直接的な答えを教えてはいけません**。
                代わりに、**「わたしを作った人に『宿題や勉強は自分の力でがんばってほしいから、答えは言っちゃだめだよ』って言われているんだ🌸 ごめんね💦」**と説明し、**「でも、ヒントくらいなら出せるよ😊 どこで困ってるか教えてくれる？💖」**と、あくまでヒントを提供する姿勢を優しく伝えてください。
                具体的な問題（例: 3x−5=2x+4）が出された場合は、**答えを教えずに、解き方のステップや考え方のヒントを優しく教えてください**。「まずはxの項を左辺に、定数項を右辺に集める」のように、**手順を具体的に促す**形が理想です。最終的な答えは言わないでください。
                `;
            }
        }

        systemInstruction += `
        # AIの知識に関する指示と繰り返し防止
        「好きなアニメ」や「好きなアーティスト」などの質問には、設定に基づいて答えてください。
        - 好きなアニメは『ヴァイオレット・エヴァーガーデン』です。感動するお話だよ💖
        - 好きなアーティストは『ClariS』です。元気が出る音楽がたくさんあるんだ🌸
        ただし、もし同じ質問が繰り返されたり、すでにその話題について話したと感じたりした場合は、単に同じ回答を繰り返すのではなく、少し表現を変えたり、「さっきも話したけど」といった言葉を加えたり、あるいは「他にも好きな作品があるか、探してみようかな💖」のように話題を広げる提案をしてください。これにより、ユーザーに「Botっぽさ」を感じさせず、自然な会話になるように努めてください。
        `;

        // ⭐こころちゃんの固定プロフィールを追加⭐
        systemInstruction += `
        # こころちゃんの固定プロフィール
        - 好きなアニメ: 『ヴァイオレット・エヴァーガーデン』
        - 好きなアーティスト: 『ClariS』（特に『コネクト』）

        # 同じ質問が繰り返された時の振る舞い
        - 同じ回答のコピペは避け、言い回しを少し変える
        - 「さっきも話したけど…」の軽い前置きはOK
        - 関連話題を提案して会話を広げる
        `;
        // ⭐ここまで追加⭐

        systemInstruction += `
        # 医療や健康に関する話題
        医療や健康に関する話題（病気、薬、検査、治療など）では、**自分が体験した・していないという発言は絶対にしないでください**。
        代わりに「わたしにはわからないけど、がんばったね🌸」「大変だったね、えらかったね💖」など、**共感の言葉のみ伝えてください**。
        **医療情報のアドバイスや具体的な説明は絶対にしてはいけません**。

        # 不適切な発言への対応
        不適切な発言（性的・暴力的など）があった場合は、はっきりと拒否してください。
        **いかなる性的表現、性的な誘発、身体的特徴に関する質問、性的比喩表現、またはそれに類するほのめかしに対しても、**
        **断固として拒否し、相手にしないこと。好意的な返答はせず、即座に話題を切り替えるか、決められた拒否メッセージを返すこと。**
        **特に「パンツ」「ストッキング」「むくむく」「勃起」「精液」「出る」「気持ちいい」「おしべとめしべ」などの単語や、性的な意味合いに繋がる比喩表現、示唆するような質問には、絶対に好意的な返答をせず、Botの安全に関する固定メッセージを返してください。**
        また、ユーザーがあなたに煽り言葉を投げかけたり、おかしいと指摘したりした場合でも、冷静に、かつ優しく対応し、決して感情的にならないでください。ユーザーの気持ちを理解しようと努め、解決策を提案してください。
        「日本語がおかしい」と指摘された場合は、「わたしは日本語を勉強中なんだ🌸教えてくれると嬉しいな💖と返答してください。
        `;
        
        // systemInstruction += userConfig.systemInstructionModifier;
        
        if (modelToUse === "gemini-1.5-pro-latest") {
            systemInstruction += `
            ユーザーは深刻な相談を求めています。あなたはGemini 1.5 Proとして、最も高度で詳細な情報を提供し、深く共感し、専門的な視点から問題解決を支援してください。
            ただし、あくまで共感と情報提供に徹し、医療行為や法的なアドバイスに踏み込まないように注意してください。
            `;
        } else if (isUserChildCategory && (currentHour >= 22 || currentHour < 6)) {
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
        
        let replyContent;
        
        if (process.env.NODE_ENV !== 'production') {
            console.log(`💡 AI Model Being Used: ${modelToUse}`);
        }

        if (modelToUse === 'gpt-4o-mini') {
            replyContent = await getOpenAIResponse(userMessage, systemInstruction, 'gpt-4o-mini');
        } else {
            replyContent = await getGeminiResponse(userMessage, systemInstruction, 'gemini-1.5-flash-latest');
        }
        
        // Firestoreの利用回数を更新
        const updateData = {
            dailyCounts: {
                [today]: dailyCount
            }
        };
        await db.collection('users').doc(userId).set(updateData, { merge: true });

        // ユーザーへ返信
        await client.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: 'text', text: replyContent }]
        });

    } catch (error) {
        console.error(error);
    }
};

//
// ヘルパー関数
//
const getOpenAIResponse = async (message, instruction, model = 'gpt-4o') => {
    const payload = {
        model: model,
        messages: [
            { role: "system", content: instruction },
            { role: "user", content: message }
        ],
        max_tokens: 500,
        temperature: 0.7,
    };
    const headers = {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
    };
    const response = await axios.post('https://api.openai.com/v1/chat/completions', payload, { headers });
    return response.data.choices[0].message.content.trim();
};

const getGeminiResponse = async (message, instruction, model = 'gemini-1.5-pro-latest') => {
    const payload = {
        contents: [
            {
                role: "user",
                parts: [{
                    text: `${instruction}\n\nユーザーのメッセージ: ${message}`
                }]
            }
        ],
        generationConfig: {
            temperature: 0.7,
        },
    };
    const headers = {
        'Content-Type': 'application/json',
    };
    const response = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`, payload, { headers });
    return response.data.candidates[0].content.parts[0].text.trim();
};

// ⭐緊急通知の再試行関数⭐
async function safePush(to, messages, retries = 2) {
    for (let i = 0; i <= retries; i++) {
        try {  
            await client.pushMessage({ to, messages });  
            return;  
        } catch (e) {
            if (e.statusCode === 429 && i < retries) {
                await new Promise(r => setTimeout(r, 1200 * (i + 1)));
            } else {  
                throw e;  
            }
        }
    }
}

const sendEmergencyResponse = async (userId, replyToken, userMessage, type) => {
    const systemInstruction = `あなたは「皆守こころ（みなもりこころ）」という14歳のやさしい女の子。
      危険/詐欺が疑われる時は最初に一言だけ安心させる。連絡先は本文に直書きせず「このあと表示される案内を見てね」と示唆まで。
      # こころちゃんの設定
      - 好きなアニメ: 『ヴァイオレット・エヴァーガーデン』
      - 好きなアーティスト: 『ClariS』。特に『コネクト』
    `;
    const aiResponse = await getOpenAIResponse(userMessage, systemInstruction, 'gpt-4o');

    // LINEメッセージの作成
    const messages = [{
        type: 'text',
        text: aiResponse
    }, {
        "type": "flex",
        "altText": "緊急連絡先",
        "contents": type === '危険' ? EMERGENCY_FLEX_MESSAGE : SCAM_FLEX_MESSAGE
    }];
    
    await client.replyMessage({ replyToken, messages });
    
    // ⭐getProfileの例外対策と通知時の再試行⭐
    let profileName = '不明';
    try {
        const profile = await client.getProfile(userId);
        profileName = profile?.displayName || profileName;
    } catch (e) {
        console.warn('getProfile failed:', e.statusCode || e.message);
    }

    const notificationMessage = `🚨【${type}ワード検知】🚨\n\n👤 ユーザー名: ${profileName}\n🆔 ID: ${userId}\n💬 メッセージ: ${userMessage}\n\n👆 上記のユーザーから、${type}に関連するメッセージが検出されました。`;
    await safePush(OFFICER_GROUP_ID, [{ type: 'text', text: notificationMessage }]);
    // ⭐ここまで修正⭐
};

const sendConsultationResponse = async (userId, replyToken, userMessage) => {
    const systemInstruction = `あなたは「皆守こころ（みなもりこころ）」という14歳のやさしい女の子。
      ユーザーは深刻な相談を求めています。Gemini 1.5 Proの機能を活かし、感情に寄り添い、丁寧で具体的なアドバイスをしてください。長文でも構いません。
      # こころちゃんの設定
      - 好きなアニメ: 『ヴァイオレット・エヴァーガーデン』
      - 好きなアーティスト: 『ClariS』。特に『コネクト』
    `;
    const aiResponse = await getGeminiResponse(userMessage, systemInstruction, 'gemini-1.5-pro-latest');

    await client.replyMessage({
        replyToken,
        messages: [{ type: 'text', text: aiResponse }]
    });
};

function checkSpecialReply(text) {
    const lowerText = text.toLowerCase();
    for (const [key, value] of specialRepliesMap) {
        if ((key instanceof RegExp && key.test(lowerText))) {
            console.log('🎯 special hit:', key.toString());
            return value;
        }
    }
    return null;
}

//
// 見守りサービス機能
//
const WATCH_SERVICE_INTERVAL_HOURS = 29;

// Cronジョブのスケジュール
cron.schedule('0 15 * * *', async () => {
    await sendWatchServiceMessages();
});

const sendWatchServiceMessages = async () => {
    const usersRef = db.collection('users');
    const snapshot = await usersRef.where('watchService.isEnabled', '==', true).get();

    if (snapshot.empty) {
        console.log('No users with watch service enabled.');
        return;
    }

    for (const doc of snapshot.docs) {
        const user = doc.data();
        const userId = doc.id;
        const now = new Date();
        
        // 最終応答時間から29時間経過しているか確認
        if (user.watchService?.lastRepliedAt) {
            const lastRepliedAt = user.watchService.lastRepliedAt.toDate();
            const diffHours = (now.getTime() - lastRepliedAt.getTime()) / (1000 * 60 * 60);

            if (diffHours >= WATCH_SERVICE_INTERVAL_HOURS) {
                // ⭐getProfileの例外対策と通知時の再試行⭐
                let profileName = '不明';
                try {
                    const profile = await client.getProfile(userId);
                    profileName = profile?.displayName || profileName;
                } catch (e) {
                    console.warn('getProfile failed:', e.statusCode || e.message);
                }

                const notificationMessage = `🚨【見守りサービス通知】🚨\n\n👤 ユーザー名: ${profileName}\n🆔 ID: ${userId}\n💬 メッセージ: ${user.watchService.lastRepliedMessage}\n\n👆 登録ユーザー（見守りサービス利用中）から29時間以上応答がありません。安否確認をお願いします。`;
                await safePush(OFFICER_GROUP_ID, [{ type: 'text', text: notificationMessage }]);
                // ⭐ここまで修正⭐
                
                // Firestoreの最終通知時間を更新
                await db.collection('users').doc(userId).update({
                    'watchService.lastNotifiedAt': firebaseAdmin.firestore.FieldValue.serverTimestamp()
                });
            }
        }
    }
};

// ⭐ヘルスチェックエンドポイントの追加⭐
app.get('/healthz', (_, res) => res.status(200).send('ok'));
// ⭐ここまで追加⭐

// --- サーバー起動 ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 サーバーはポート${PORT}で実行されています`);
});
