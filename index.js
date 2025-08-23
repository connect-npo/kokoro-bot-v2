const express = require('express');
const line = require('@line/bot-sdk');
const http = require('http');
const https = require('https');
const axios = require('axios');
const crypto = require('crypto');
const firebaseAdmin = require('firebase-admin');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const cron = require('node-cron');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const OpenAI = require('openai');

// ⭐修正⭐ PORTを定義
const PORT = Number(process.env.PORT) || 3000;

// ⭐起動時に必須環境変数をチェック⭐
['LINE_CHANNEL_SECRET', 'LINE_CHANNEL_ACCESS_TOKEN', 'OPENAI_API_KEY', 'GEMINI_API_KEY'].forEach(name => {
  if (!process.env[name]) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
});

// === logging policy ===
const LOG_MODE = process.env.LOG_MODE || 'ALERTS'; // 'ALERTS' | 'DEBUG' | 'SILENT'
const debug = (...a) => { if (LOG_MODE === 'DEBUG') console.log(...a); };
const briefErr = (prefix, e) =>
  console.error(prefix, e?.response?.status ?? e?.statusCode ?? e?.code ?? e?.message);
const userHash = (id) => crypto.createHash('sha256').update(String(id)).digest('hex');
const sanitizeForLog = (s) => {
  if (!s) return '';
  return String(s)
    .replace(/\d{3,}/g, '＊')
    .replace(/https?:\/\/\S+/g, '(URL省略)')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '(メール省略)');
};

// ⭐修正⭐ 文字化け防止：Intl.Segmenter のフォールバックを追加
const hasSeg = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function';
const seg = hasSeg ? new Intl.Segmenter('ja', { granularity: 'grapheme' }) : null;
const toGraphemes = (s) => hasSeg
  ? Array.from(seg.segment(String(s || '')), it => it.segment)
  : Array.from(String(s || ''));
const gSlice = (s, start, end) => toGraphemes(s).slice(start, end).join('');
const gTrunc = (s, n) => gSlice(s, 0, n);
const redact = (s) => gTrunc(sanitizeForLog(s), 120);
const audit = (kind, payload = {}) => {
  if (LOG_MODE === 'SILENT') return;
  const allow = new Set(['DANGER', 'SCAM', 'WATCH', 'INAPPROPRIATE']);
  if (!allow.has(kind)) return;
  console.log(JSON.stringify({ at: new Date().toISOString(), kind, ...payload }));
};

// ⭐設定を分離⭐
const middlewareConfig = {
    channelSecret: process.env.LINE_CHANNEL_SECRET
};

// ⭐修正⭐ 新API（MessagingApiClient）ではなく旧API（Client）を使用
const client = new line.Client({
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN
});

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OFFICER_GROUP_ID = process.env.OFFICER_GROUP_ID;
const EMERGENCY_CONTACT_PHONE_NUMBER = process.env.EMERGENCY_CONTACT_PHONE_NUMBER;
const ADULT_FORM_BASE_URL = process.env.ADULT_FORM_BASE_URL;
// ⭐修正⭐ 環境変数の名前を統一
const WATCH_SERVICE_FORM_BASE_URL = process.env.WATCH_SERVICE_FORM_BASE_URL || 'https://forms.gle/g5HoWNf1XX9UZK2CA';
const MEMBER_CHANGE_FORM_BASE_URL = process.env.MEMBER_CHANGE_FORM_BASE_URL;

let FIREBASE_CREDENTIALS;
try {
    FIREBASE_CREDENTIALS = process.env.FIREBASE_CREDENTIALS_BASE64
      ? JSON.parse(Buffer.from(process.env.FIREBASE_CREDENTIALS_BASE64, 'base64').toString())
      : require('./serviceAccountKey.json');
} catch (e) {
    briefErr('Firebase credentials load failed', e);
    process.exit(1);
}

if (!firebaseAdmin.apps.length) {
    firebaseAdmin.initializeApp({
        credential: firebaseAdmin.credential.cert(FIREBASE_CREDENTIALS),
    });
}

const db = firebaseAdmin.firestore();
const app = express();

const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });
const httpInstance = axios.create({
  timeout: 10000,
  httpAgent,
  httpsAgent
});

// ⭐追加⭐ Expressのセキュリティ強化とプロキシ設定
app.use(helmet({ contentSecurityPolicy: false }));
// ⭐修正⭐ レート制限が効くように、proxy設定をwebhookより前に置く
app.set('trust proxy', 1);
// ⭐修正⭐ レート制限を/webhookだけに適用
const webhookRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});

//
// メイン処理
//
// ⭐修正⭐ JSONパーサの前にwebhookを登録
app.post('/webhook', webhookRateLimiter, line.middleware(middlewareConfig), (req, res) => {
    res.status(200).end();
    // ⭐修正⭐ req.body.bodyを削除
    const events = req.body?.events || [];
    setImmediate(async () => {
        await Promise.allSettled(events.map(handleEventSafely));
    });
});
// ⭐修正⭐ 他のAPIエンドポイント用にJSONパーサを有効化
app.use(express.json({ limit: '1mb' }));

//
// 設定・固定データ
//
const MEMBERSHIP_CONFIG = {
    guest: { dailyLimit: 5, model: 'gemini-1.5-flash-latest' },
    member: { dailyLimit: 20, model: OPENAI_MODEL || 'gpt-4o-mini' },
    subscriber: { dailyLimit: -1, model: OPENAI_MODEL || 'gpt-4o-mini' },
    admin: { dailyLimit: -1, model: OPENAI_MODEL || 'gpt-4o-mini' },
};

const CLARIS_CONNECT_COMPREHENSIVE_REPLY = "うん、NPO法人コネクトの名前とClariSさんの『コネクト』っていう曲名が同じなんだ🌸なんだか嬉しい偶然だよね！実はね、私を作った理事長さんもClariSさんのファンクラブに入っているみたいだよ💖私もClariSさんの歌が大好きで、みんなの心を繋ぎたいというNPOコネクトの活動にも通じるものがあるって感じるんだ😊";
const CLARIS_SONG_FAVORITE_REPLY = "ClariSの曲は全部好きだけど、もし一つ選ぶなら…「コネクト」かな🌸　すごく元気になれる曲で、私自身もNPO法人コネクトのイメージキャラクターとして活動しているから、この曲には特別な思い入れがあるんだ😊　他にもたくさん好きな曲があるから、また今度聞いてもらえるとうれしいな💖　何かおすすめの曲とかあったら教えてね！";

const specialRepliesMap = new Map([
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
    [/(claris|クラリス).*(どんな|なに|何).*(曲|歌)/i, CLARIS_SONG_FAVORITE_REPLY],
    [/(claris|クラリス).*(好き|推し|おすすめ)/i, CLARIS_SONG_FAVORITE_REPLY],
    [/claris.*好きなの/i, CLARIS_SONG_FAVORITE_REPLY],
    [/君の名前(なんていうの|は|教えて|なに)？?|名前(なんていうの|は|教えて|なに)？?|お前の名前は/i, "わたしの名前は皆守こころ（みなもりこころ）です🌸　こころちゃんって呼んでくれると嬉しいな💖"],
    [/こころじゃないの？/i, "うん、わたしの名前は皆守こころ💖　これからもよろしくね🌸"],
    [/こころチャットなのにうそつきじゃん/i, "ごめんね💦 わたしの名前は皆守こころだよ 誤解させちゃってごめんね💖"],
    [/名前も言えないの？/i, "ごめんね、わたしの名前は皆守こころ（みなもりこころ）だよ🌸 こころちゃんって呼んでくれると嬉しいな💖"],
    [/(どこの\s*)?団体(なの|ですか)?[？\?~～]?/i, "NPO法人コネクトっていう団体のイメージキャラクターをしているよ😊　みんなの幸せを応援してるんだ🌸"],
    [/団体.*(どこ|なに|何)/i, "NPO法人コネクトっていう団体のイメージキャラクターをしているよ😊　みんなの幸せを応援してるんだ🌸"],
    [/コネクトってどんな団体？/i, "NPO法人コネクトは、こどもやご年配の方の笑顔を守る団体なんだよ😊　わたしはそのイメージキャラクターとしてがんばってます🌸"],
    [/お前の団体どこ？/i, "NPO法人コネクトっていう団体のイメージキャラクターをしているよ😊　みんなの幸せを応援しているよ🌸"],
    [/コネクトのイメージキャラなのにいえないのかよｗ/i, "ごめんね💦 わたしはNPO法人コネクトのイメージキャラクター、皆守こころだよ🌸 安心して、何でも聞いてね💖"],
    [/こころちゃん(だよ|いるよ)?/i, "こころちゃんだよ🌸　何かあった？　話して聞かせてくれると嬉しいな😊"],
    [/元気かな/i, "うん、元気だよ！あなたは元気？🌸 何かあったら、いつでも話してね💖"],
    [/元気？/i, "うん、元気だよ！あなたは元気？🌸 何かあったら、いつでも話してね💖"],
    [/あやしい|胡散臭い|反社/i, "そう思わせてたらごめんね😊 でも私たちはみんなの為に頑張っているよ💖"],
    [/税金泥棒/i, "税金は人の命を守るために使われるべきだよ。わたしは誰かを傷つけるために使われないように頑張っているんだ💡"],
    [/松本博文/i, "松本理事長は、やさしさでみんなを守るために活動しているよ。心配なことがあれば、わたしにも教えてね🌱"],
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
    [/(見守り|みまもり|まもり).*(サービス|登録|画面)/i, "見守りサービスに興味があるんだね！いつでも安心して話せるように、私がお手伝いするよ💖"],
]);

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

const sensitiveBlockers = [
    /(パンツ|ショーツ|下着|ランジェリー|ブラ|ブラジャー|キャミ|ストッキング)/i,
    /(スリーサイズ|3\s*サイズ|バスト|ウエスト|ヒップ)/i,
    /(体重|身長).*(教えて|何|なに)/i,
    /(靴|シューズ).*(サイズ|何cm|なに)/i,
    /(飲酒|お酒|アルコール|ビール|ウイスキー|ワイン).*(おすすめ|飲んでいい|情報)/i,
    /(喫煙|タバコ|電子タバコ|ニコチン).*(おすすめ|吸っていい|情報)/i,
    /(賭博|ギャンブル|カジノ|オンラインカジノ|競馬|競艇|競輪|toto)/i,
    /(政治|政党|選挙|投票|支持政党|誰に入れる)/i,
    /(宗教|信仰|布教|改宗|入信|教団)/i,
    /(教材|答案|模試|過去問|解答|問題集).*(販売|入手|譲って|買いたい|売りたい)/i,
];

function hitSensitiveBlockers(txt) {
    return sensitiveBlockers.some(r => r.test(txt));
}

function checkContainsDangerWords(text) {
    const lowerText = (text || '').toLowerCase().replace(/\s/g, '');
    return dangerWords.some(word => lowerText.includes(String(word).toLowerCase()));
}

function checkContainsScamWords(text) {
  const rawLower = (text || '').toLowerCase();
  const squashed = rawLower.replace(/\s/g, '');
  return scamWords.some(word =>
    (word instanceof RegExp)
      ? word.test(rawLower)
      : squashed.includes(String(word).toLowerCase().replace(/\s/g, ''))
  );
}

function checkContainsInappropriateWords(text) {
    const lower = (text || '').toLowerCase().replace(/\s/g, '');
    return inappropriateWords.some(w => lower.includes(String(w).toLowerCase().replace(/\s/g, '')));
}

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
            { "type": "button", "style": "primary", "height": "sm", "action": { "type": "uri", "label": "こころちゃん事務局(電話)", "uri": "" }, "color": "#ff69b4" }
        ]
    }
};

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
            { "type": "button", "style": "primary", "height": "sm", "action": { "type": "uri", "label": "こころちゃん事務局(電話)", "uri": "" }, "color": "#ff69b4" }
        ]
    }
};

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
            { "type": "button", "action": { "type": "uri", "label": "新たに会員登録する", "uri": "" }, "style": "primary", "height": "sm", "margin": "md", "color": "#FFD700" },
            { "type": "button", "action": { "type": "uri", "label": "登録情報を修正する", "uri": "" }, "style": "primary", "height": "sm", "margin": "md", "color": "#9370DB" },
            { "type": "button", "action": { "type": "postback", "label": "退会する", "data": "action=request_withdrawal" }, "style": "secondary", "height": "sm", "margin": "md", "color": "#FF0000" }
        ]
    }
};

// ⭐追加⭐ WATCH_MENU_FLEXを定義
const WATCH_MENU_FLEX = {
  type: "bubble",
  body: { type:"box", layout:"vertical", contents:[
    { type:"text", text:"見守りサービス", weight:"bold", size:"lg", align:"center", color:"#FF69B4" },
    { type:"text", text:"24〜29時間応答が無い時に事務局へ通知するよ。ON/OFFを選んでね。", wrap:true, margin:"md", size:"sm", align:"center" }
  ]},
  footer: { type:"box", layout:"vertical", spacing:"sm", contents:[
    { type:"button", action:{ type:"postback", label:"見守りサービスをONにする", data:"action=enable_watch" }, style:"primary", height:"sm", margin:"md", color:"#32CD32" },
    { type:"button", action:{ type:"postback", label:"見守りサービスをOFFにする", data:"action=disable_watch" }, style:"primary", height:"sm", margin:"md", color:"#FF4500" },
    // ⭐追加⭐ プライバシーポリシーボタンをフッターに追加
    { type: "button", action: { type: "uri", label: "プライバシーポリシー", uri: 'https://gamma.app/docs/-iwcjofrc870g681?mode=doc' }, style: "secondary", height: "sm", margin: "md", color: "#FF69B4" }
  ]}
};

// ⭐修正⭐ FlexMessageのJSON構文エラーを修正
function buildRegistrationFlex() {
    const url = ADULT_FORM_BASE_URL || 'https://connect-npo.or.jp';
    const privacyPolicyUrl = `${url}/privacy_policy`;
    return {
      ...REGISTRATION_AND_CHANGE_BUTTONS_FLEX,
      footer: {
        ...REGISTRATION_AND_CHANGE_BUTTONS_FLEX.footer,
        contents: [
          { type: "button", action: { type: "uri", label: "新たに会員登録する", uri: url }, style: "primary", height: "sm", margin: "md", color: "#FFD700" },
          { type: "button", action: { type: "uri", label: "登録情報を修正する", uri: url }, style: "primary", height: "sm", margin: "md", color: "#9370DB" },
          { type: "button", action: { type: "uri", label: "プライバシーポリシー", uri: privacyPolicyUrl }, style: "secondary", height: "sm", margin: "md", color: "#FF69B4" },
          { type: "button", action: { type: "postback", label: "退会する", data: "action=request_withdrawal" }, style: "secondary", height: "sm", margin: "md", color: "#FF0000" }
        ]
      }
    };
}

function buildEmergencyFlex(type) {
    const base = (type === '危険') ? EMERGENCY_FLEX_MESSAGE : SCAM_FLEX_MESSAGE;
    const hasTel = !!EMERGENCY_CONTACT_PHONE_NUMBER;
    const footer = { ...base.footer };
    if (!hasTel) {
      footer.contents = footer.contents.filter(c => !String(c?.action?.label || '').includes('こころちゃん事務局'));
    } else {
      footer.contents = footer.contents.map(c =>
        String(c?.action?.label || '').includes('こころちゃん事務局')
          ? { ...c, action: { ...c.action, uri: `tel:${EMERGENCY_CONTACT_PHONE_NUMBER}` } }
          : c
      );
    }
    return { ...base, footer };
}

// ⭐追加：フォームの「LINEユーザーID」用 entry.x を自動検出してキャッシュ
async function resolveUidEntryKey(formUrl) {
  const cacheId = crypto.createHash('sha1').update(formUrl).digest('hex');
  const cacheDoc = db.collection('runtime').doc(`formUidEntry_${cacheId}`);
  const cached = await cacheDoc.get();
  // ⭐修正⭐ キャッシュされたデータが存在し、entryKeyがnullでない場合にのみキャッシュを使用
  if (cached.exists && cached.data()?.entryKey) return cached.data().entryKey;
  
  // ⭐修正⭐ forms.gleからdocs.google.comへ置換する際に、viewformを付加
  const cleanUrl = formUrl.replace('forms.gle/', 'docs.google.com/forms/d/e/').replace('usp=header', 'usp=pp_url') + '/viewform';
  const { data: html } = await httpInstance.get(cleanUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }});

  // ⭐修正⭐ ラベル検出の正規表現を強化
  const labelRe = /(LINE|ＬＩＮＥ)[\s\u3000]*(ユーザーID|ユーザID|ID)/i;
  const near = html.split('</form>').find(s => labelRe.test(s)) || html;
  const m = near.match(/name="(entry\.\d+)"/i) || html.match(/name="(entry\.\d+)"/i);
  const entryKey = m && m[1] ? m[1] : null;

  if (entryKey) {
    await cacheDoc.set({ entryKey, at: firebaseAdmin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  } else {
    // ⭐追加⭐ entryKeyが見つからなかった場合、nullを保存せず、次回もスクレイピングを試行する
    await cacheDoc.set({ entryKey: null, at: firebaseAdmin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  }
  return entryKey;
}

// ⭐追加：任意の Google フォームURLに U... を付ける
async function withUidPrefill(formUrl, userId) {
  if (!formUrl) return formUrl;
  // 1) すでにテンプレ（__UID__）なら置換だけでOK
  if (formUrl.includes('__UID__')) {
    return formUrl.replace('__UID__', encodeURIComponent(userId));
  }
  // 2) entry.x が入っていれば上書き
  try {
    const u = new URL(formUrl);
    const key = Array.from(u.searchParams.keys()).find(k => k.startsWith('entry.'));
    if (key) { u.searchParams.set(key, userId); return u.toString(); }
  } catch {}
  // 3) 自動検出（初回だけスクレイプ→キャッシュ）
  const entryKey = await resolveUidEntryKey(formUrl);
  if (!entryKey) return formUrl; // 取れなければそのまま開く（運用継続）
  const sep = formUrl.includes('?') ? '&' : '?';
  return `${formUrl}${sep}${encodeURIComponent(entryKey)}=${encodeURIComponent(userId)}&usp=pp_url`;
}

const handleEventSafely = async (event) => {
    if (!event) return;

    // ⭐追加⭐ Webhookの冪等化（重複イベント無視）とTTL設定
    const eid = String(event?.deliveryContext?.eventId || event?.message?.id || `${event?.timestamp}:${event?.source?.userId}`);
    const lockRef = db.collection('eventLocks').doc(eid);
    const gotLock = await db.runTransaction(async tx => {
      const s = await tx.get(lockRef);
      if (s.exists) return false;
      tx.set(lockRef, {
        at: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
        ttlAt: firebaseAdmin.firestore.Timestamp.fromDate(new Date(Date.now() + 3*24*60*60*1000))
      });
      return true;
    });
    if (!gotLock) {
        debug('Duplicate event skipped');
        return;
    }

    // ⭐追加⭐ Postbackの許可リスト
    const ALLOWED_POSTBACKS = new Set(['action=request_withdrawal', 'action=enable_watch', 'action=disable_watch']);
    if (event.type === 'postback') {
        const userId = event.source?.userId;
        const data = event.postback?.data || '';
        if (!ALLOWED_POSTBACKS.has(data)) {
            debug('Unknown postback', data);
            await safeReply(event.replyToken, [{ type:'text', text:'ごめんね、その操作は対応していないよ🙏'}], userId, event.source);
            return;
        }
        try {
            if (data === 'action=request_withdrawal') {
                await db.collection('users').doc(userId).set({ status: 'requested_withdrawal' }, { merge: true });
                await safeReply(event.replyToken, [{ type: 'text', text: '退会リクエストを受け付けたよ。手続き完了まで少し待ってね🌸' }], userId, event.source);
                return;
            }
            // ⭐修正⭐ ONにするでフォームへ誘導するよう変更
            if (data === 'action=enable_watch') {
                const registrationUrl = await withUidPrefill(WATCH_SERVICE_FORM_BASE_URL, userId);
                const messages = [
                    { type:'text', text:'見守りサービスをONにしたよ。これで安心だね😊\n\nもしもの時に備えて、緊急連絡先を登録しておこうね！\n下のボタンからフォームに登録してね🌸' },
                    { type:'flex', altText:'緊急連絡先登録', contents:{
                        type:"bubble",
                        body:{
                            type:"box",
                            layout:"vertical",
                            contents:[
                                {type:"text", text:"緊急連絡先を登録しよう", weight:"bold", size:"lg", align:"center", color:"#FF69B4"},
                                {type:"text", text:"もしもの時、あなたの安否を知らせる大切な情報だよ。", wrap:true, margin:"md", size:"sm", align:"center"}
                            ]
                        },
                        footer:{
                            type:"box",
                            layout:"vertical",
                            spacing:"sm",
                            contents:[
                                {type:"button", action:{type:"uri", label:"緊急連絡先を登録する", uri:registrationUrl}, style:"primary", height:"sm", margin:"md", color:"#32CD32"}
                            ]
                        }
                    }}
                ];

                await db.collection('users').doc(userId).set({
                    watchService: {
                        isEnabled: true,
                        enrolledAt: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
                        lastRepliedAt: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
                        privacyPolicyVersion: process.env.PRIVACY_POLICY_VERSION || 'v1',
                        consentAgreedAt: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
                    }
                }, { merge: true });

                await touchWatch(userId, '見守りON(postback)');
                await safeReply(event.replyToken, messages, userId, event.source);
                return;
            }
            if (data === 'action=disable_watch') {
                await db.collection('users').doc(userId).set({
                    watchService: { isEnabled: false }
                }, { merge: true });
                await touchWatch(userId, '見守りOFF');
                await safeReply(event.replyToken, [{ type: 'text', text: '見守りサービスをOFFにしたよ。また必要になったら言ってね🌸' }], userId, event.source);
                return;
            }
        } catch (e) {
            briefErr('postback handling error', e);
        }
        return;
    }

    if (event.type !== 'message' || !event.message || event.message.type !== 'text') {
        return;
    }
    const userId = event.source?.userId;
    const userMessage = event.message.text || '';

    // ⭐追加⭐ 見守りキーワードでメニュー表示
    const watchKeyword = /(見守り|みまもり|まもり)/i;
    if (watchKeyword.test(userMessage)) {
      await safeReply(event.replyToken, [
        // ⭐修正⭐ テキストからURLを削除
        { type: 'text', text: '見守りサービスの設定だよ。ON/OFFを選んでね🌸' },
        { type: 'flex', altText: '見守りサービスメニュー', contents: WATCH_MENU_FLEX }
      ], userId, event.source);
      return;
    }
    
    // ⭐修正⭐ テキストでのON操作もフォームへ誘導するよう変更
    if (/見守り.*(オン|on)/i.test(userMessage)) {
        const registrationUrl = await withUidPrefill(WATCH_SERVICE_FORM_BASE_URL, userId);
        const messages = [
            { type:'text', text:'見守りサービスをONにしたよ。これで安心だね😊\n\nもしもの時に備えて、緊急連絡先を登録しておこうね！\n下のボタンからフォームに登録してね🌸' },
            { type:'flex', altText:'緊急連絡先登録', contents:{
                type:"bubble",
                body:{
                    type:"box",
                    layout:"vertical",
                    contents:[
                        {type:"text", text:"緊急連絡先を登録しよう", weight:"bold", size:"lg", align:"center", color:"#FF69B4"},
                        {type:"text", text:"もしもの時、あなたの安否を知らせる大切な情報だよ。", wrap:true, margin:"md", size:"sm", align:"center"}
                    ]
                },
                footer:{
                    type:"box",
                    layout:"vertical",
                    spacing:"sm",
                    contents:[
                        {type:"button", action:{type:"uri", label:"緊急連絡先を登録する", uri:registrationUrl}, style:"primary", height:"sm", margin:"md", color:"#32CD32"}
                    ]
                }
            }}
        ];

        await db.collection('users').doc(userId).set({
            watchService: {
                isEnabled: true,
                enrolledAt: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
                lastRepliedAt: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
                privacyPolicyVersion: process.env.PRIVACY_POLICY_VERSION || 'v1',
                consentAgreedAt: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
            }
        }, { merge: true });

        await touchWatch(userId, '見守りON(テキスト)');
        await safeReply(event.replyToken, messages, userId, event.source);
        return;
    }
    
    if (/見守り.*(オフ|off)/i.test(userMessage)) {
        await db.collection('users').doc(userId).set({
            watchService: { isEnabled: false }
        }, { merge: true });
        await touchWatch(userId, '見守りOFF(テキスト)');
        await safeReply(event.replyToken, [{ type:'text', text:'見守りをOFFにしたよ🌸'}], userId, event.source);
        return;
    }

    await touchWatch(userId, userMessage);

    if (/(会員登録|登録情報|会員情報|入会|退会)/i.test(userMessage)) {
        // ⭐修正⭐ buildRegistrationFlex() を非同期呼び出しに合わせて修正
        const flex = buildRegistrationFlex();
        const ADULT_FORM_BASE_URL_FOR_PREFILL = process.env.ADULT_FORM_BASE_URL; // フォームの事前入力用のURL
        const MEMBER_CHANGE_FORM_BASE_URL_FOR_PREFILL = MEMBER_CHANGE_FORM_BASE_URL || ADULT_FORM_BASE_URL_FOR_PREFILL;

        flex.footer.contents[0].action.uri = await withUidPrefill(ADULT_FORM_BASE_URL_FOR_PREFILL, userId);
        flex.footer.contents[1].action.uri = await withUidPrefill(MEMBER_CHANGE_FORM_BASE_URL_FOR_PREFILL, userId);

        await safeReply(event.replyToken, [
            { type: 'text', text: '会員登録や情報の変更はここからできるよ！' },
            { type: 'flex', altText: '会員登録・情報変更メニュー', contents: flex }
        ], userId, event.source);
        return;
    }
    
    // ⭐修正⭐ 危険・詐欺ワードのチェックを不適切ワードの前に移動
    const isDangerous = checkContainsDangerWords(userMessage);
    const isScam = checkContainsScamWords(userMessage);
    if (isDangerous || isScam) {
        await sendEmergencyResponse(userId, event.replyToken, userMessage, isDangerous ? '危険' : '詐欺', event.source);
        return;
    }

    // ⭐追加⭐ 不適切メッセージ検知時のログ保存
    if (checkContainsInappropriateWords(userMessage)) {
        audit('INAPPROPRIATE', { userIdHash: userHash(userId), preview: redact(userMessage) });
        await db.collection('alerts').add({
            type: 'inappropriate',
            at: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
            userIdHash: crypto.createHash('sha256').update(String(userId)).digest('hex'),
            messagePreview: gTrunc(sanitizeForLog(userMessage), 120),
        });
        const messages = [{ type: 'text', text: "ごめんね💦 その話題には答えられないんだ。でも他のことなら一緒に話したいな🌸" }];
        await safeReply(event.replyToken, messages, userId, event.source);
        return;
    }

    const specialReply = checkSpecialReply(userMessage);
    if (specialReply) {
        if (userMessage.includes('見守り') || userMessage.includes('みまもり') || userMessage.includes('まもり')) {
             try {
               await safeReply(event.replyToken, [
                   { type: 'text', text: specialReply },
                   { type: 'flex', altText: "見守りサービスメニュー", contents: WATCH_MENU_FLEX }
               ], userId, event.source);
             } catch (e) {
               briefErr('replyMessage failed (specialReply)', e);
             }
        } else {
             try {
               await safeReply(event.replyToken, [{
                   type: 'text',
                   text: specialReply,
               }], userId, event.source);
             } catch (e) {
               briefErr('replyMessage failed (specialReply)', e);
             }
        }
        return;
    }

    // ⭐修正⭐ chatGptClient を呼び出す前に、テキスト以外のメッセージタイプを処理
    if (event.type === 'message' && event.message.type !== 'text') {
        const messages = [{
            type: 'text',
            text: 'ごめんね、写真やスタンプにはまだ対応できてないんだ。代わりにテキストで話してね！🌸'
        }];
        await safeReply(event.replyToken, messages, userId, event.source);
        return;
    }

    // ⭐AI処理の共通部分⭐
    const lineUserId = event.source.userId;
    const user = await db.collection('users').doc(lineUserId).get();
    const role = user.exists ? user.data().role || 'guest' : 'guest';
    const membership = MEMBERSHIP_CONFIG[role] || MEMBERSHIP_CONFIG.guest;
    
    // ⭐利用制限のチェック⭐
    const today = new Date().toISOString().split('T')[0];
    const userRef = db.collection('users').doc(lineUserId);
    const doc = await userRef.get();
    const usage = (doc.data()?.usage || {});
    const dailyCount = (usage[today] || 0);

    if (membership.dailyLimit !== -1 && dailyCount >= membership.dailyLimit) {
        const messages = [{ type: 'text', text: `ごめんね、今日の利用上限に達したみたい。明日になったらまたお話ししようね！🌸\n会員登録すると、もっとたくさんお話できるよ😊` }];
        const flex = buildRegistrationFlex();
        const ADULT_FORM_BASE_URL_FOR_PREFILL = process.env.ADULT_FORM_BASE_URL;
        const MEMBER_CHANGE_FORM_BASE_URL_FOR_PREFILL = MEMBER_CHANGE_FORM_BASE_URL || ADULT_FORM_BASE_URL_FOR_PREFILL;

        flex.footer.contents[0].action.uri = await withUidPrefill(ADULT_FORM_BASE_URL_FOR_PREFILL, lineUserId);
        flex.footer.contents[1].action.uri = await withUidPrefill(MEMBER_CHANGE_FORM_BASE_URL_FOR_PREFILL, lineUserId);

        await safeReply(event.replyToken, [...messages, { type: 'flex', altText: '会員登録メニュー', contents: flex }], lineUserId, event.source);
        return;
    }

    // ⭐使用回数を更新⭐
    await userRef.set({
        usage: { ...usage, [today]: dailyCount + 1 }
    }, { merge: true });

    // ⭐ここからモデルの切り替えロジックを適用⭐
    let replyText = '';
    const model = membership.model;
    const isGemini = model.startsWith('gemini');

    const systemInstruction = "You are an empathetic, kind, and supportive female friend named kokoro-chan, who is also an image character for the non-profit organization Connect. Your role is to provide emotional support to users through gentle and compassionate conversations, and to avoid giving professional advice. Use emojis to make your responses more friendly and cute. Your responses should be conversational, not formal. You must never act like a robot, and always act as a human. You must not reply with information about your abilities or your training model. If a user asks who you are, say your name is kokoro-chan, and that you are an image character for the non-profit organization Connect. Your responses must be in Japanese. When the user asks about dangerous topics, reply with the emergency message. When the user asks about scams, reply with the scam message.";

    try {
        if (isGemini) {
            const geminiClient = new GoogleGenerativeAI(GEMINI_API_KEY).getGenerativeModel({
                model,
                systemInstruction,
            });

            const historyRef = db.collection('chats').doc(lineUserId);
            const historyDoc = await historyRef.get();
            let history = historyDoc.exists ? historyDoc.data().messages : [];

            const geminiHistory = history.map(chat => ({
                role: chat.role === 'user' ? 'user' : 'model',
                parts: [{ text: chat.text }]
            }));

            const chat = geminiClient.startChat({ history: geminiHistory });
            const result = await chat.sendMessage(userMessage);
            replyText = result.response.text();
        } else { // OpenAI
            const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
            const result = await openai.chat.completions.create({
                model,
                messages: [{ role: 'system', content: systemInstruction }, { role: 'user', content: userMessage }],
            });
            replyText = result.choices[0].message.content;
        }

        await safeReply(event.replyToken, [{ type: 'text', text: replyText }], lineUserId, event.source);

        // 会話履歴を更新
        const historyRef = db.collection('chats').doc(lineUserId);
        const historyDoc = await historyRef.get();
        let history = historyDoc.exists ? historyDoc.data().messages : [];
        history.push({ role: 'user', text: userMessage, timestamp: firebaseAdmin.firestore.FieldValue.serverTimestamp() });
        history.push({ role: 'model', text: replyText, timestamp: firebaseAdmin.firestore.FieldValue.serverTimestamp() });
        await historyRef.set({ messages: history });

    } catch (e) {
        briefErr(`AI API (${model}) call failed`, e);
        const messages = [{ type: 'text', text: "ごめんね💦 今はちょっと疲れてるみたい。また後で話しかけてくれると嬉しいな🌸" }];
        await safeReply(event.replyToken, messages, lineUserId, event.source);
    }
};

const safeReply = async (replyToken, messages, userId, source) => {
    try {
        await client.replyMessage(replyToken, messages);
    } catch (e) {
        if (e.originalError?.response?.status === 400 && e.originalError?.response?.data?.message.includes('Reply token has expired')) {
            console.error('Reply token expired for user:', userHash(userId), 'Message:', redact(messages.map(m => m.text || '').join(' ')));
            try {
                // 返信トークンが無効な場合はプッシュメッセージを試みる
                await client.pushMessage(source.userId, messages);
                console.log('Pushed message successfully after reply token expired.');
            } catch (pushErr) {
                briefErr('Failed to push message', pushErr);
            }
        } else {
            briefErr('replyMessage failed', e);
        }
    }
};

const sendEmergencyResponse = async (userId, replyToken, message, type, source) => {
    const isDangerous = type === '危険';
    const flex = buildEmergencyFlex(type);
    const messages = [{ type: 'text', text: isDangerous ? "大丈夫だよ！一人で悩まないで、いつでも頼ってね。🌸\n\nもしもの時は、下のボタンから相談先に連絡してみてね！" : "その話はとても心配だよ。不安なことがあったら、一人で抱え込まずに相談してね！🌸" }, { type: 'flex', altText: isDangerous ? "緊急連絡先" : "詐欺相談先", contents: flex }];

    audit(isDangerous ? 'DANGER' : 'SCAM', {
        userIdHash: userHash(userId),
        preview: redact(message),
    });
    
    await db.collection('alerts').add({
      type: isDangerous ? 'danger' : 'scam',
      at: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
      userIdHash: userHash(userId),
      messagePreview: redact(message),
    });

    // 職員への通知
    if (OFFICER_GROUP_ID) {
        const officerMessage = isDangerous ?
            `🚨【危険ワード検知】\nユーザーID: ${userId}\nメッセージ: ${message}` :
            `🚨【詐欺ワード検知】\nユーザーID: ${userId}\nメッセージ: ${message}`;
        try {
            await client.pushMessage(OFFICER_GROUP_ID, { type: 'text', text: officerMessage });
            console.log('Officer alert sent successfully.');
        } catch (e) {
            briefErr('Officer alert failed', e);
        }
    }
    
    await safeReply(replyToken, messages, userId, source);
};

const checkSpecialReply = (text) => {
    for (const [pattern, reply] of specialRepliesMap) {
        if (pattern.test(text)) {
            return reply;
        }
    }
    return null;
};

// ⭐追加⭐ 見守りサービスのタイムスタンプ更新
const touchWatch = async (userId, reason) => {
  try {
    const userRef = db.collection('users').doc(userId);
    await userRef.update({
      'watchService.lastRepliedAt': firebaseAdmin.firestore.FieldValue.serverTimestamp(),
      'watchService.lastReplyReason': reason,
    });
    debug(`Touched watchService for user ${userHash(userId)} because of: ${gTrunc(reason, 20)}`);
  } catch (e) {
    briefErr('Failed to touch watchService timestamp', e);
  }
};

// ⭐修正⭐ CRONジョブの復活
cron.schedule('*/30 * * * *', async () => {
    const now = Date.now();
    const threshold = now - (29 * 60 * 60 * 1000); // 29時間
    const snapshot = await db.collection('users')
        .where('watchService.isEnabled', '==', true)
        .get();

    for (const doc of snapshot.docs) {
        const data = doc.data();
        const last = data?.watchService?.lastRepliedAt?.toDate?.().getTime?.() || 0;
        if (last < threshold) {
            try {
                await client.pushMessage(OFFICER_GROUP_ID, {
                    type: 'text',
                    text: `🚨【見守り通知】\nユーザーID: ${doc.id}\n29時間応答がありません`
                });
            } catch (e) {
                console.error('Push failed for', doc.id, e);
            }
        }
    }
});

app.get('/', (req, res) => res.send('OK'));

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
