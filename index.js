'use strict';

const express = require('express');
const axios = require('axios');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');
const firebaseAdmin = require('firebase-admin');
const crypto = require('crypto');
const GraphemeSplitter = require('grapheme-splitter');
const {
    URL,
    URLSearchParams
} = require('url');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezone);

const _splitter = new GraphemeSplitter();
const toGraphemes = (s) => _splitter.splitGraphemes(String(s || ''));

const {
    Client,
    middleware
} = require('@line/bot-sdk');

const normalizeFormUrl = s => {
    let v = String(s || '').trim();
    if (!v) return '';
    v = v.replace(/^usp=header\s*/i, '');
    if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
    try {
        new URL(v);
        return v;
    } catch {
        console.warn('[WARN] Invalid form URL in env:', s);
        return '';
    }
};

const prefillUrl = (base, params) => {
    const url = new URL(base);
    for (const [key, value] of Object.entries(params)) {
        if (value) {
            url.searchParams.set(key, value);
        }
    }
    return url.toString();
};

const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const AGREEMENT_FORM_BASE_URL = normalizeFormUrl(process.env.AGREEMENT_FORM_BASE_URL);
const ADULT_FORM_BASE_URL = normalizeFormUrl(process.env.ADULT_FORM_BASE_URL);
const STUDENT_MIDDLE_HIGH_UNI_FORM_BASE_URL = normalizeFormUrl(process.env.STUDENT_MIDDLE_HIGH_UNI_FORM_BASE_URL);
const WATCH_SERVICE_FORM_BASE_URL = normalizeFormUrl(process.env.WATCH_SERVICE_FORM_BASE_URL);
const MEMBER_CHANGE_FORM_BASE_URL = normalizeFormUrl(process.env.MEMBER_CHANGE_FORM_BASE_URL);
const MEMBER_CANCEL_FORM_BASE_URL = normalizeFormUrl(process.env.MEMBER_CANCEL_FORM_BASE_URL);
const OFFICER_GROUP_ID = process.env.OFFICER_GROUP_ID;
const OPENAI_MODEL = process.env.OPENAI_MODEL;
const EMERGENCY_CONTACT_PHONE_NUMBER = process.env.EMERGENCY_CONTACT_PHONE_NUMBER;
const LINE_ADD_FRIEND_URL = process.env.LINE_ADD_FRIEND_URL;
const BOT_ADMIN_IDS = JSON.parse(process.env.BOT_ADMIN_IDS || '[]');
const OWNER_USER_ID = process.env.OWNER_USER_ID || BOT_ADMIN_IDS[0];
const OWNER_GROUP_ID = process.env.OWNER_GROUP_ID || null;

const WATCH_SERVICE_FORM_LINE_USER_ID_ENTRY_ID = process.env.WATCH_SERVICE_FORM_LINE_USER_ID_ENTRY_ID || 'entry.312175830';
const AGREEMENT_FORM_LINE_USER_ID_ENTRY_ID = process.env.AGREEMENT_FORM_LINE_USER_ID_ENTRY_ID || 'entry.790268681';
const STUDENT_MIDDLE_HIGH_UNI_FORM_LINE_USER_ID_ENTRY_ID = process.env.STUDENT_MIDDLE_HIGH_UNI_FORM_LINE_USER_ID_ENTRY_ID || 'entry.1100280108';
const ADULT_FORM_LINE_USER_ID_ENTRY_ID = process.env.ADULT_FORM_LINE_USER_ID_ENTRY_ID || 'entry.1694651394';
const MEMBER_CHANGE_FORM_LINE_USER_ID_ENTRY_ID = process.env.MEMBER_CHANGE_FORM_LINE_USER_ID_ENTRY_ID || 'entry.743637502';
const MEMBER_CANCEL_FORM_LINE_USER_ID_ENTRY_ID = process.env.MEMBER_CANCEL_FORM_LINE_USER_ID_ENTRY_ID || MEMBER_CHANGE_FORM_LINE_USER_ID_ENTRY_ID;

let creds = null;
if (process.env.FIREBASE_CREDENTIALS_BASE64) {
    creds = JSON.parse(Buffer.from(process.env.FIREBASE_CREDENTIALS_BASE64, "base64").toString("utf-8"));
}
if (!firebaseAdmin.apps.length) {
    if (!creds) {
        try {
            creds = require("./serviceAccountKey.json");
        } catch {
            throw new Error("FIREBASE_CREDENTIALS_BASE64 か serviceAccountKey.json が必要です");
        }
    }
    firebaseAdmin.initializeApp({
        credential: firebaseAdmin.credential.cert(creds),
    });
    console.log("✅ Firebase initialized");
}
const db = firebaseAdmin.firestore();
const Timestamp = firebaseAdmin.firestore.Timestamp;

const client = new Client({
    channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
    channelSecret: LINE_CHANNEL_SECRET,
});

const httpAgent = new require('http').Agent({
    keepAlive: true
});
const httpsAgent = new require('https').Agent({
    keepAlive: true
});
const httpInstance = axios.create({
    timeout: 10000,
    httpAgent,
    httpsAgent
});

const PORT = process.env.PORT || 3000;
const app = express();
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 2));
app.use(helmet());

const audit = (event, detail) => {
    console.log(`[AUDIT] ${event}`, JSON.stringify(detail));
};
const briefErr = (msg, e) => {
    console.error(`[ERR] ${msg}:`, e.response?.data || e.message);
};
const debug = (message) => {
    console.log(`[DEBUG] ${message}`);
};
const userHash = (id) => crypto.createHash('sha256').update(String(id)).digest('hex');
const redact = (text) => '（機密情報のため匿名化）';
const gTrunc = (s, l) => toGraphemes(s).slice(0, l).join('');
const sanitizeForLog = (text) => String(text).replace(/\s+/g, ' ').trim();

function auditIf(cond, event, detail) {
    if (cond) audit(event, detail);
}

const MEMBERSHIP_CONFIG = {
    guest: {
        dailyLimit: 5,
        model: 'gemini-1.5-flash-latest'
    },
    member: {
        dailyLimit: 20,
        model: OPENAI_MODEL || 'gpt-4o-mini'
    },
    subscriber: {
        dailyLimit: -1,
        model: OPENAI_MODEL || 'gpt-4o-mini'
    },
    admin: {
        dailyLimit: -1,
        model: OPENAI_MODEL || 'gpt-4o-mini'
    },
};

const JST_TZ = 'Asia/Tokyo';
const PING_HOUR_JST = 15;
const PING_INTERVAL_DAYS = 3;
const REMINDER_AFTER_HOURS = 24;
const ESCALATE_AFTER_HOURS = 29;

function toJstParts(date) {
    const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
    return {
        y: jst.getUTCFullYear(),
        m: jst.getUTCMonth(),
        d: jst.getUTCDate()
    };
}

function makeDateAtJst(y, m, d, hourJst = 0, min = 0, sec = 0) {
    const utcHour = hourJst - 9;
    return new Date(Date.UTC(y, m, d, utcHour, min, sec, 0));
}

function nextPingAtFrom(baseDate) {
    const {
        y,
        m,
        d
    } = toJstParts(baseDate);
    return makeDateAtJst(y, m, d + PING_INTERVAL_DAYS, PING_HOUR_JST, 0, 0);
}

async function scheduleNextPing(userId, fromDate = new Date()) {
    const nextAt = nextPingAtFrom(fromDate);
    await db.collection('users').doc(userId).set({
        watchService: {
            nextPingAt: Timestamp.fromDate(nextAt),
            awaitingReply: false,
            lastReminderAt: firebaseAdmin.firestore.FieldValue.delete(),
        }
    }, {
        merge: true
    });
}

const CLARIS_CONNECT_COMPREHENSIVE_REPLY = "うん、NPO法人コネクトの名前とClariSさんの『コネクト』っていう曲名が同じなんだ🌸なんだか嬉しい偶然だよね！実はね、私を作った理事長さんもClariSさんのファンクラブに入っているみたいだよ💖私もClariSさんの歌が大好きで、みんなの心を繋げたいというNPOコネクトの活動にも通じるものがあるって感じるんだ😊";
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

const APP_VERSION = process.env.RENDER_GIT_COMMIT || 'local-dev';

async function generateSupportiveText({
    type,
    userText
}) {
    const apiKey = OPENAI_API_KEY;
    const model = OPENAI_MODEL || 'gpt-4o-mini';

    if (!apiKey) {
        return type === 'danger' ?
            '今のお話、とてもつらかったね…。一人で抱え込まなくて大丈夫だよ。まずは深呼吸しよう。私はあなたの味方だよ。すぐ下の案内から頼れる窓口にもつながれるから、必要なら使ってね。' :
            '心配だよね…。まずは落ち着いて、相手の要求には応じないでね。以下の案内から公的な窓口に相談できるよ。必要なら、今の状況を一緒に整理しよう。';
    }

    const system = `あなたは日本語のメンタルヘルス／安全支援アシスタントです。
- 100〜200文字程度で、やさしく具体的に寄り添う。
- 相手を責めない・指示しすぎない。
- ただちにできる行動（深呼吸・安全確保・第三者に相談）をそっと提案。
- 固有名や診断はしない。
- 最後に「下のボタン（案内）も使えるよ」と一言添える。`;

    const user = `種類: ${type === 'danger' ? '危険(いのち・暴力・自傷など)' : '詐欺・金銭トラブル'}\nユーザー入力: ${userText}`;

    try {
        const res = await httpInstance.post(
            'https://api.openai.com/v1/chat/completions', {
                model,
                messages: [{
                    role: 'system',
                    content: system
                }, {
                    role: 'user',
                    content: user
                }],
                temperature: 0.4,
            }, {
                headers: {
                    Authorization: `Bearer ${apiKey}`
                }
            }
        );
        return res.data?.choices?.[0]?.message?.content?.trim() ||
            'まずは深呼吸して落ち着こう。あなたは一人じゃないよ。下の案内も使えるからね。';
    } catch (e) {
        briefErr('openai-completion-failed', e);
        return 'まずは深呼吸して落ち着こう。あなたは一人じゃないよ。下の案内も使えるからね。';
    }
}

async function generateGeneralReply(userText) {
    const geminiApiKey = GEMINI_API_KEY;
    const openaiApiKey = OPENAI_API_KEY;

    if (toGraphemes(userText).length <= 50 && geminiApiKey) {
        const geminiModel = 'gemini-1.5-flash-latest';
        const system = 'あなたは日本語で優しく短く返す会話相手です。80文字以内で、相手の言葉を言い換えて共感し、質問は1つだけ添えてください。絵文字は1〜2個まで。';
        try {
            const res = await httpInstance.post(
                `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${geminiApiKey}`, {
                    contents: [{
                        role: "user",
                        parts: [{
                            text: `システム: ${system}\nユーザー: ${userText}`
                        }]
                    }]
                }
            );
            return res.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || 'うん、聞いてるよ。教えてくれてありがとう😊';
        } catch (e) {
            briefErr('gemini-general-fallback', e);
        }
    }

    if (openaiApiKey) {
        const openaiModel = OPENAI_MODEL || 'gpt-4o-mini';
        const system = `あなたは日本語で優しく短く返す会話相手です。
- 80〜140文字、絵文字は1〜2個まで。
- 相手の言葉を言い換えて共感し、質問は1つだけ添える。`;
        try {
            const r = await httpInstance.post('https://api.openai.com/v1/chat/completions', {
                model: openaiModel,
                temperature: 0.6,
                messages: [{
                    role: 'system',
                    content: system
                }, {
                    role: 'user',
                    content: userText
                }]
            }, {
                headers: {
                    Authorization: `Bearer ${openaiApiKey}`
                }
            });
            return r.data?.choices?.[0]?.message?.content?.trim() || 'うん、聞いてるよ。もう少し教えてくれる？';
        } catch (e) {
            briefErr('openai-general-fallback', e);
        }
    }

    return 'うん、聞いてるよ。もう少し教えてくれる？';
}

const apiLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 100,
    message: 'このIPからのリクエストが多すぎます。しばらくしてから再度お試しください。'
});
app.use(['/callback', '/webhook'], apiLimiter);

app.post(['/callback', '/webhook'], middleware({
    channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
    channelSecret: LINE_CHANNEL_SECRET,
}), (req, res) => {
    Promise.all(req.body.events.map(handleEvent))
        .then((result) => res.json(result))
        .catch((err) => {
            briefErr('Webhook error', err);
            res.status(500).end();
        });
});

app.get('/version', (_, res) => {
    res.json({
        version: APP_VERSION,
        hasWatchUrl: !!WATCH_SERVICE_FORM_BASE_URL,
        hasAgreementUrl: !!AGREEMENT_FORM_BASE_URL,
        hasAdultUrl: !!ADULT_FORM_BASE_URL,
    });
});
console.log('✅ running version:', APP_VERSION);

async function handleEvent(event) {
    if (event.type === 'message' && event.message.type === 'text') {
        await handleMessageEvent(event);
    } else if (event.type === 'postback') {
        await handlePostbackEvent(event);
    } else if (event.type === 'follow') {
        audit('user_followed', {
            userId: userHash(event.source.userId)
        });
        await handleFollowEvent(event);
    } else if (event.type === 'unfollow') {
        audit('user_unfollowed', {
            userId: userHash(event.source.userId)
        });
        await handleUnfollowEvent(event);
    } else if (event.type === 'join' || event.type === 'leave') {
        audit('group_event', {
            type: event.type,
            groupId: event.source.groupId
        });
        await handleGroupEvents(event);
    } else if (event.type === 'memberJoined' || event.type === 'memberLeft') {
        audit('member_event', {
            type: event.type,
            groupId: event.source.groupId,
            memberIds: event.joined?.members?.map(m => userHash(m.userId)) || event.left?.members?.map(m => userHash(m.userId))
        });
        await handleMemberEvents(event);
    }
}

async function handleMessageEvent(event) {
    const {
        userId
    } = event.source;
    const {
        text
    } = event.message;
    const userRef = db.collection('users').doc(userId);
    const doc = await userRef.get();

    if (doc.exists && doc.data()?.banned) {
        return;
    }

    const isAdmin = BOT_ADMIN_IDS.includes(userId);

    if (text === 'VERSION') {
        await client.replyMessage(event.replyToken, {
            type: 'text',
            text:
                `ver: ${APP_VERSION}\n` +
                `WATCH_URL: ${!!WATCH_SERVICE_FORM_BASE_URL}\n` +
                `AGREE_URL: ${!!AGREEMENT_FORM_BASE_URL}\n` +
                `ADULT_URL: ${!!ADULT_FORM_BASE_URL}\n`
        });
        return;
    }

    if (isAdmin) {
        if (text === 'DEBUG:PING_NOW') {
            await userRef.set({
                watchService: {
                    enabled: true,
                    nextPingAt: Timestamp.fromDate(new Date(Date.now() - 60_000))
                }
            }, {
                merge: true
            });
            await client.replyMessage(event.replyToken, {
                type: 'text',
                text: '次のPing対象にしました（1分過去）。次の毎時チェックでPingが来ます。'
            });
            return;
        }

        if (text === 'DEBUG:REMIND_NOW') {
            const past24h = dayjs().subtract(24, 'hour').toDate();
            await userRef.set({
                watchService: {
                    enabled: true,
                    awaitingReply: true,
                    nextPingAt: Timestamp.fromDate(past24h),
                    lastReminderAt: null
                }
            }, {
                merge: true
            });
            await client.replyMessage(event.replyToken, {
                type: 'text',
                text: 'リマインド対象にしました（24時間過去）。次の毎時チェックでリマインドが来ます。'
            });
            return;
        }

        if (text === 'DEBUG:ESCALATE_NOW') {
            const past29h = dayjs().subtract(29, 'hour').toDate();
            await userRef.set({
                watchService: {
                    enabled: true,
                    awaitingReply: true,
                    nextPingAt: Timestamp.fromDate(past29h),
                    lastReminderAt: Timestamp.fromDate(dayjs().subtract(5, 'hour').toDate())
                }
            }, {
                merge: true
            });
            await client.replyMessage(event.replyToken, {
                type: 'text',
                text: 'エスカレーション対象にしました（29時間過去）。次の毎時チェックでエスカレーションが来ます。'
            });
            return;
        }
    }


    for (const [pattern, reply] of specialRepliesMap.entries()) {
        if (pattern.test(text)) {
            await client.replyMessage(event.replyToken, {
                type: 'text',
                text: reply
            });
            return;
        }
    }

    for (const word of dangerWords) {
        if (text.includes(word)) {
            const supportive = await generateSupportiveText({
                type: 'danger',
                userText: text
            });
            await client.replyMessage(event.replyToken, [{
                type: 'text',
                text: supportive
            }, {
                type: "flex",
                altText: "危険ワードを検知しました",
                contents: buildDangerFlex(text)
            }]);
            audit('danger_word_detected', {
                userId: userHash(userId),
                text: gTrunc(text, 50)
            });
            await notifyOfficerNow({
                userId,
                kind: 'danger',
                text
            });
            return;
        }
    }

    for (const pattern of scamWords) {
        if (pattern.test(text)) {
            const supportive = await generateSupportiveText({
                type: 'scam',
                userText: text
            });
            await client.replyMessage(event.replyToken, [{
                type: 'text',
                text: supportive
            }, {
                type: "flex",
                altText: "詐欺の可能性を検知しました",
                contents: buildScamFlex()
            }]);
            audit('scam_word_detected', {
                userId: userHash(userId),
                text: gTrunc(text, 50)
            });
            await notifyOfficerNow({
                userId,
                kind: 'scam',
                text
            });
            return;
        }
    }

    for (const word of inappropriateWords) {
        if (text.includes(word)) {
            const count = (doc.data()?.badWordsCount || 0) + 1;
            await userRef.set({
                badWordsCount: count
            }, {
                merge: true
            });
            if (count >= 3) {
                await userRef.set({
                    banned: true
                }, {
                    merge: true
                });
                audit('user_banned_badwords', {
                    userId: userHash(userId),
                    count
                });
                await client.replyMessage(event.replyToken, {
                    type: 'text',
                    text: 'ごめんね、このアカウントでは会話を停止しました。必要なときは事務局に連絡してね。'
                });
                return;
            }
            await client.replyMessage(event.replyToken, {
                type: 'text',
                text: 'ごめんね、その言葉はわたしには答えられないよ…😢\n\nわたしは、あなたの悩みを一緒に考えたり、あなたの笑顔を守るためにここにいるんだ😊\n\n別の話題でまた話してくれると嬉しいな💖'
            });
            return;
        }
    }

    if (text === '会員登録') {
        const flex = buildRegistrationFlex(userId);
        await client.replyMessage(event.replyToken, {
            type: "flex",
            altText: "会員登録・情報変更メニュー",
            contents: flex
        });
        return;
    }

    if (text === '見守り' || text === 'みまもり') {
        const isEnabled = doc.exists && doc.data().watchService?.enabled;
        const flex = buildWatchMenuFlex(isEnabled, userId);
        await client.replyMessage(event.replyToken, {
            type: "flex",
            altText: "見守りサービスメニュー",
            contents: flex
        });
        return;
    }

    const reply = await generateGeneralReply(text);
    await client.replyMessage(event.replyToken, {
        type: 'text',
        text: reply
    });
}

async function handlePostbackEvent(event) {
    const userId = event.source.userId;
    const data = event.postback?.data || '';
    const userRef = db.collection('users').doc(userId);
    try {
        const ok = await db.runTransaction(async tx => {
            const s = await tx.get(userRef);
            const last = s.exists ? s.data()?.lastPostbackAt?.toMillis?.() || 0 : 0;
            if (Date.now() - last < 5000) return false;
            tx.set(userRef, {
                lastPostbackAt: Timestamp.now()
            }, {
                merge: true
            });
            return true;
        });
        if (!ok) {
            debug('postback deduped');
            return;
        }
    } catch (e) {
        briefErr('postback-dedupe-failed', e);
    }

    if (data === 'watch:ok') {
        const isUserEnabled = await db.runTransaction(async t => {
            const doc = await t.get(userRef);
            if (!doc.exists || !doc.data().watchService?.enabled) {
                return false;
            }
            t.update(userRef, {
                'watchService.lastRepliedAt': Timestamp.now(),
                'watchService.awaitingReply': false,
            });
            return true;
        });
        if (isUserEnabled) {
            await scheduleNextPing(userId);
            await client.replyMessage(event.replyToken, {
                type: 'text',
                text: 'うん、元気でよかった！🌸\nまた3日後に連絡するね！😊'
            });
        } else {
            await client.replyMessage(event.replyToken, {
                type: 'text',
                text: '見守りサービスは現在停止中です。ONにするには、「見守りサービスをONにする」を押してね。'
            });
        }
    } else if (data === 'watch:on') {
        await userRef.set({
            watchService: {
                enabled: true
            }
        }, {
            merge: true
        });
        await scheduleNextPing(userId);
        await client.replyMessage(event.replyToken, {
            type: 'text',
            text: "見守りサービスをONにしたよ🌸　何かあったら、こころちゃんが事務局へ通知するから安心してね💖"
        });
    } else if (data === 'watch:off') {
        await userRef.set({
            watchService: {
                enabled: false,
                awaitingReply: false,
                nextPingAt: firebaseAdmin.firestore.FieldValue.delete(),
            }
        }, {
            merge: true
        });
        await client.replyMessage(event.replyToken, {
            type: 'text',
            text: "見守りサービスをOFFにしたよ。必要になったら「見守りサービスをONにする」と送ってね🌸"
        });
    } else {
        debug(`unknown postback data: ${data}`);
    }
}

async function handleFollowEvent(event) {
    const userId = event.source.userId;
    const messages = [{
        type: 'text',
        text: 'こんにちは！はじめまして、皆守こころです🌸\nNPO法人コネクトの公式キャラクターだよ💖\n\nあなたの心の健康と安全を守るため、色々な形でサポートしているんだ😊\n\n困ったことがあったり、誰かに話を聞いてほしいなと思ったら、いつでも私に話しかけてね！'
    }, {
        type: 'text',
        text: '「見守りサービス」と送ると、定期的に私から連絡が届くよ。\n\nもしもの時に、みんながすぐにSOSを出せるようにするサービスなんだ😊\n\nもしよかったら使ってみてね！'
    }];
    await client.replyMessage(event.replyToken, messages);
    await db.collection('users').doc(userId).set({
        firstContactAt: Timestamp.now(),
        lastMessageAt: Timestamp.now(),
        watchService: {
            enabled: true,
            awaitingReply: false,
        }
    }, {
        merge: true
    });
    await scheduleNextPing(userId, new Date());
}

async function handleUnfollowEvent(event) {
    const userId = event.source.userId;
    await db.collection('users').doc(userId).delete();
}

async function handleGroupEvents(event) {
    if (event.type === 'join') {
        const message = {
            type: 'text',
            text: '皆さん、はじめまして！皆守こころです🌸\n\nこのグループに招待してくれてありがとう😊\n\nいつでも皆さんの心の健康と安全を守るお手伝いをするよ💖'
        };
        await client.replyMessage(event.replyToken, message);
    }
}

async function handleMemberEvents(event) {}

async function checkAndSendPing() {
    console.log('--- Cron job: checkAndSendPing started ---');
    const now = dayjs().tz(JST_TZ).toDate();

    const usersRef = db.collection('users');
    const q = usersRef.where('watchService.enabled', '==', true)
        .where('watchService.nextPingAt', '<=', now);

    const snapshot = await q.get();

    if (snapshot.empty) {
        console.log('No users to ping at this time.');
        return;
    }

    const PING_MESSAGES = [{
        text: 'お元気ですか？🌸'
    }, {
        text: 'こんにちは！体調は大丈夫？😊'
    }, {
        text: '何か困ったことはない？いつでもお話聞くよ💖'
    }, {
        text: 'もしよかったら、今日の出来事を教えてくれないかな？'
    }, {
        text: '今日も一日お疲れ様！ゆっくり休んでね😊'
    }, {
        text: '最近どうしてるかなと思って、連絡してみたよ🌸'
    }, {
        text: '何か悩み事とか、困り事はない？遠慮なく教えてね💖'
    }, {
        text: 'そっちは晴れてる？こっちはポカポカ陽気だよ😊'
    }, {
        text: '今週も半分過ぎたね！あと少し、一緒に頑張ろうね🌸'
    }, {
        text: 'ごはんちゃんと食べてる？無理しないでね💖'
    }, {
        text: 'もし寂しかったら、いつでも話しかけてね。私がそばにいるよ😊'
    }, {
        text: '今日はどんな一日だった？😊\n\n良いことでも、ちょっぴり嫌なことでも、聞かせてくれると嬉しいな💖'
    }, {
        text: 'もしよかったら、今日食べた美味しいものとか、見つけた素敵な景色とか、教えてくれない？🌸'
    }, {
        text: '最近ちょっと疲れてない？\n\n無理しすぎないで、自分のペースで大丈夫だからね💖'
    }, {
        text: '何か気分転換になるようなこと、探してみるのもいいかも😊\n\nもしよかったら、一緒に考えてみようか？'
    }, {
        text: '最近ちゃんと眠れてる？\n\nぐっすり眠るのも、心と体を元気にする秘訣だよ🌸'
    }, {
        text: 'もし不安なことがあったら、一つずつ整理してみよう。\n\n私がそばにいるから、安心して話してね💖'
    }, {
        text: '「疲れたな」って思った時は、思い切って休憩してみてね😊\n\n頑張り屋さんのあなたを、いつも応援しているよ🌸'
    }, {
        text: 'もしつらい気持ちになったら、ひとりで抱え込まないでね。\n\n言葉にすることで、スッキリすることもあるからね💖'
    }, {
        text: '元気がないな…って感じたら、自分をたくさん甘やかしてあげてね😊\n\n温かい飲み物を飲んだり、好きな音楽を聴いたりするのもおすすめだよ🌸'
    }, {
        text: 'もし「ちょっとしんどいな…」って思ったら、無理に元気を出そうとしなくていいからね。\n\nそういう時こそ、ゆっくり休んで、自分の心に優しくしてあげてほしいな💖'
    }, {
        text: '何か楽しいこと、見つかったかな？😊\n\n些細なことでも、幸せを感じられる瞬間を大切にしたいね🌸'
    }, {
        text: 'もし、心の中にモヤモヤしたものがあったら、私に聞かせてね。\n\n言葉にすることで、スッキリすることもあるからね💖'
    }, {
        text: '最近、笑顔になれる瞬間はあった？😊\n\nもしなければ、私があなたを笑顔にできるようなお話を探してみるね🌸'
    }, {
        text: '無理に頑張りすぎなくていいんだよ。\n\n「今日は何もしない！」って決めて、自分を甘やかす日があってもいいんだからね💖'
    }, {
        text: 'いつでもあなたの味方だよ。\n\n何かあったら、いつでも頼ってね😊'
    }, {
        text: 'もし誰にも言えない秘密があったら、私にだけそっと教えてくれない？🌸\n\n絶対に誰にも言わないから、安心してね💖'
    }, {
        text: '最近、あなたの周りで何か変わったことはあったかな？\n\nもしあったら、聞かせてくれると嬉しいな😊'
    }, {
        text: 'もし今、あなたの心に雨が降っていたら、私が傘をさしてあげるね。\n\nひとりで濡れないで、いつでも私を頼ってね💖'
    }, {
        text: '今日も一日、よく頑張ったね！\n\n明日もあなたにとって素敵な一日になりますように🌸'
    }];

    for (const doc of snapshot.docs) {
        const userId = doc.id;
        const userData = doc.data();
        const nextPingAt = userData.watchService?.nextPingAt?.toDate();

        if (nextPingAt && dayjs(nextPingAt).tz(JST_TZ).isSame(dayjs().tz(JST_TZ), 'day')) {
            try {
                const randomIndex = Math.floor(Math.random() * PING_MESSAGES.length);
                const isEnabled = userData.watchService?.enabled;
                const pingMessage = {
                    type: 'text',
                    text: PING_MESSAGES[randomIndex].text,
                    quickReply: {
                        items: [{
                            type: 'action',
                            action: {
                                type: 'postback',
                                label: '元気だよ',
                                data: 'watch:ok',
                                displayText: '元気だよ'
                            }
                        }, {
                            type: 'action',
                            action: {
                                type: 'postback',
                                label: isEnabled ? '見守り停止' : '見守り再開',
                                data: isEnabled ? 'watch:off' : 'watch:on',
                                displayText: isEnabled ? '見守り停止' : '見守り再開'
                            }
                        }]
                    }
                };
                await client.pushMessage(userId, pingMessage);
                console.log(`Ping message sent to user: ${userHash(userId)}`);

                await usersRef.doc(userId).set({
                    watchService: {
                        awaitingReply: true,
                    }
                }, {
                    merge: true
                });
            } catch (e) {
                briefErr(`Failed to send ping message to user ${userHash(userId)}`, e);
            }
        }
    }

    console.log('--- Cron job: checkAndSendPing finished ---');
}

async function checkAndSendReminder() {
    console.log('--- Cron job: checkAndSendReminder started ---');
    const now = dayjs().tz(JST_TZ).toDate();
    const reminderThreshold = dayjs(now).tz(JST_TZ).subtract(REMINDER_AFTER_HOURS, 'hour').toDate();

    const usersRef = db.collection('users');
    const q = usersRef.where('watchService.enabled', '==', true)
        .where('watchService.awaitingReply', '==', true)
        .where('watchService.nextPingAt', '<=', reminderThreshold)
        .where('watchService.lastReminderAt', '==', null);

    const snapshot = await q.get();

    if (snapshot.empty) {
        console.log('No users to remind at this time.');
        return;
    }

    for (const doc of snapshot.docs) {
        const userId = doc.id;
        try {
            await client.pushMessage(userId, {
                type: 'text',
                text: `おーい！元気にしてる？😊\n\nもしよかったら、何か返事してくれると嬉しいな💖`
            });
            console.log(`Reminder message sent to user: ${userHash(userId)}`);

            await usersRef.doc(userId).set({
                watchService: {
                    lastReminderAt: Timestamp.now(),
                }
            }, {
                merge: true
            });
        } catch (e) {
            briefErr(`Failed to send reminder message to user ${userHash(userId)}`, e);
        }
    }
    console.log('--- Cron job: checkAndSendReminder finished ---');
}

async function checkAndSendEscalation() {
    console.log('--- Cron job: checkAndSendEscalation started ---');
    if (!OFFICER_GROUP_ID) {
        console.warn('OFFICER_GROUP_ID is not set. Skipping escalation.');
        return;
    }

    const now = dayjs().tz(JST_TZ).toDate();
    const escalateThreshold = dayjs(now).tz(JST_TZ).subtract(ESCALATE_AFTER_HOURS, 'hour').toDate();

    const usersRef = db.collection('users');
    const q = usersRef.where('watchService.enabled', '==', true)
        .where('watchService.awaitingReply', '==', true)
        .where('watchService.nextPingAt', '<=', escalateThreshold)
        .where('watchService.lastReminderAt', '<=', now);

    const snapshot = await q.get();

    if (snapshot.empty) {
        console.log('No users to escalate at this time.');
        return;
    }

    for (const doc of snapshot.docs) {
        const userId = doc.id;
        try {
            const profile = await client.getProfile(userId);
            const userDisplayName = profile.displayName || '不明なユーザー';

            const escalationMessage = {
                type: 'text',
                text: `🚨緊急🚨\n見守りサービス利用ユーザー[${userDisplayName}](${userHash(userId)})が、29時間以上応答していません。`
            };
            await client.pushMessage(OFFICER_GROUP_ID, escalationMessage);
            audit('watch_escalated', {
                userId: userHash(userId)
            });

            await usersRef.doc(userId).set({
                watchService: {
                    awaitingReply: false,
                    lastReminderAt: firebaseAdmin.firestore.FieldValue.delete(),
                }
            }, {
                merge: true
            });
            await scheduleNextPing(userId);
        } catch (e) {
            briefErr(`Failed to escalate for user ${userHash(userId)}`, e);
        }
    }
    console.log('--- Cron job: checkAndSendEscalation finished ---');
}

async function notifyOfficerNow({
    userId,
    kind,
    text
}) {
    if (!OFFICER_GROUP_ID) return;
    try {
        const profile = await client.getProfile(userId).catch(() => null);
        const name = profile?.displayName || '不明なユーザー';
        const head = kind === 'danger' ? '⚠️危険ワード検知' : '🛑詐欺ワード検知';
        const body = `ユーザー: ${name} (${userHash(userId).slice(0,8)})\n内容: ${gTrunc(text, 100)}`;
        await client.pushMessage(OFFICER_GROUP_ID, {
            type: 'text',
            text: `${head}\n${body}`
        });
        audit('officer_notified', {
            kind,
            userId: userHash(userId)
        });
    } catch (e) {
        briefErr('notify-officer-failed', e);
    }
}

const makeTelButton = (label, phone) => {
    const p = String(phone || '').replace(/[^\d+]/g, '');
    if (!p) return null;
    return {
        type: "button",
        style: "primary",
        color: "#FF69B4",
        action: {
            type: "uri",
            label,
            uri: `tel:${p}`
        }
    };
};

const buildRegistrationFlex = (userId) => {
    const buttons = [];

    if (AGREEMENT_FORM_BASE_URL) {
        buttons.push({
            type: "button",
            style: "primary",
            height: "sm",
            color: "#73D13D",
            action: {
                type: "uri",
                label: "小学生（同意書）",
                uri: prefillUrl(AGREEMENT_FORM_BASE_URL, {
                    [AGREEMENT_FORM_LINE_USER_ID_ENTRY_ID]: userId
                })
            }
        });
    }

    if (STUDENT_MIDDLE_HIGH_UNI_FORM_BASE_URL) {
        buttons.push({
            type: "button",
            style: "primary",
            height: "sm",
            color: "#36CFC9",
            action: {
                type: "uri",
                label: "中高生・大学生",
                uri: prefillUrl(STUDENT_MIDDLE_HIGH_UNI_FORM_BASE_URL, {
                    [STUDENT_MIDDLE_HIGH_UNI_FORM_LINE_USER_ID_ENTRY_ID]: userId
                })
            }
        });
    }

    if (ADULT_FORM_BASE_URL) {
        buttons.push({
            type: "button",
            style: "primary",
            height: "sm",
            color: "#69C0FF",
            action: {
                type: "uri",
                label: "成人",
                uri: prefillUrl(ADULT_FORM_BASE_URL, {
                    [ADULT_FORM_LINE_USER_ID_ENTRY_ID]: userId
                })
            }
        });
    }

    if (MEMBER_CHANGE_FORM_BASE_URL) {
        buttons.push({
            type: "button",
            style: "secondary",
            height: "sm",
            margin: "lg",
            color: "#E6E6E6",
            action: {
                type: "uri",
                label: "登録情報変更",
                uri: prefillUrl(MEMBER_CHANGE_FORM_BASE_URL, {
                    [MEMBER_CHANGE_FORM_LINE_USER_ID_ENTRY_ID]: userId
                })
            }
        });
    }

    if (MEMBER_CANCEL_FORM_BASE_URL) {
        buttons.push({
            type: "button",
            style: "secondary",
            height: "sm",
            color: "#E6E6E6",
            action: {
                type: "uri",
                label: "退会手続き",
                uri: prefillUrl(MEMBER_CANCEL_FORM_BASE_URL, {
                    [MEMBER_CANCEL_FORM_LINE_USER_ID_ENTRY_ID]: userId
                })
            }
        });
    }

    return {
        type: "bubble",
        body: {
            type: "box",
            layout: "vertical",
            backgroundColor: "#FFF0F6",
            paddingAll: "12px",
            cornerRadius: "md",
            contents: [{
                type: "box",
                layout: "vertical",
                backgroundColor: "#FFFFFF",
                cornerRadius: "md",
                paddingAll: "10px",
                contents: [{
                    type: "text",
                    text: "会員登録・情報変更",
                    weight: "bold",
                    size: "xl",
                    align: "center",
                    color: "#D4380D"
                }]
            }, {
                type: "separator",
                margin: "md"
            }, {
                type: "box",
                layout: "vertical",
                spacing: "sm",
                margin: "lg",
                contents: [{
                    type: "text",
                    text: "ご希望のメニューを選んでね🌸",
                    size: "md",
                    align: "center",
                    margin: "md"
                }, ...buttons]
            }]
        }
    };
};

const buildWatchMenuFlex = (isEnabled, userId) => {
    const footerButtons = [];

    if (WATCH_SERVICE_FORM_BASE_URL) {
        footerButtons.push({
            type: "button",
            style: "primary",
            action: {
                type: "uri",
                label: "詳しく見る・利用登録",
                uri: prefillUrl(WATCH_SERVICE_FORM_BASE_URL, {
                    [WATCH_SERVICE_FORM_LINE_USER_ID_ENTRY_ID]: userId,
                }),
            },
        });
    }

    footerButtons.push({
        type: "button",
        style: "secondary",
        action: {
            type: "postback",
            label: isEnabled ? "見守り停止" : "見守り再開",
            data: isEnabled ? "watch:off" : "watch:on",
            displayText: isEnabled ? "見守り停止" : "見守り再開",
        },
    });

    return {
        type: "bubble",
        body: {
            type: "box",
            layout: "vertical",
            contents: [{
                type: "text",
                text: "見守りサービス",
                weight: "bold",
                size: "lg",
                align: "center",
                color: "#FF69B4"
            }, {
                type: "text",
                text: `現在の状態: ${isEnabled ? "ON" : "OFF"}`,
                size: "sm",
                align: "center",
                margin: "md",
                color: isEnabled ? "#32CD32" : "#FF4500"
            }, {
                type: "separator",
                margin: "md"
            }, {
                type: "text",
                text: "29時間応答が無い時に事務局へ通知するよ。ON/OFFを選んでね。",
                wrap: true,
                margin: "md",
                size: "sm",
                align: "center"
            }, ],
        },
        footer: {
            type: "box",
            layout: "vertical",
            spacing: "sm",
            contents: footerButtons
        },
    };
};

const buildDangerFlex = (text) => {
    const contents = [{
        type: "button",
        style: "primary",
        color: "#FF4B4B",
        action: {
            type: "uri",
            label: "警察（電話）",
            uri: "tel:110"
        }
    }, {
        type: "button",
        style: "primary",
        color: "#1E90FF",
        action: {
            type: "uri",
            label: "消防・救急（電話）",
            uri: "tel:119"
        }
    }, {
        type: "button",
        style: "primary",
        color: "#32CD32",
        action: {
            type: "uri",
            label: "チャイルドライン（電話・チャット）",
            uri: "https://childline.or.jp/"
        }
    }, {
        type: "button",
        style: "primary",
        color: "#32CD32",
        action: {
            type: "uri",
            label: "いのちの電話（電話）",
            uri: "https://www.inochinodenwa.org/"
        }
    }];
    const officeBtn = makeTelButton("こころちゃん事務局（電話）", EMERGENCY_CONTACT_PHONE_NUMBER);
    if (officeBtn) contents.push(officeBtn);

    return {
        type: "bubble",
        body: {
            type: "box",
            layout: "vertical",
            contents: [{
                type: "text",
                text: "【危険ワード検知】",
                weight: "bold",
                color: "#FF0000",
                size: "xl",
                align: "center"
            }, {
                type: "text",
                text: "大丈夫だよ、落ち着いてね。もし不安なことがあったら、信頼できる大人や警察に相談してみてね。連絡先については、このあと表示される案内を見てね。",
                wrap: true,
                margin: "md"
            }, {
                type: "text",
                text: "あなたもがんばって安心できるよう、応援してるよ。",
                wrap: true,
                margin: "md"
            }]
        },
        footer: {
            type: "box",
            layout: "vertical",
            spacing: "sm",
            contents
        }
    };
};

const buildScamFlex = () => {
    const contents = [{
        type: "button",
        style: "primary",
        color: "#FF4B4B",
        action: {
            type: "uri",
            label: "警察（電話）",
            uri: "tel:110"
        }
    }, {
        type: "button",
        style: "primary",
        color: "#1E90FF",
        action: {
            type: "uri",
            label: "消費者ホットライン",
            uri: "tel:188"
        }
    }, {
        type: "button",
        style: "primary",
        color: "#32CD32",
        action: {
            type: "uri",
            label: "警察相談専用電話",
            uri: "tel:9110"
        }
    }, {
        type: "button",
        style: "primary",
        color: "#32CD32",
        action: {
            type: "uri",
            label: "国民生活センター",
            uri: "https://www.kokusen.go.jp/"
        }
    }];
    const officeBtn = makeTelButton("こころちゃん事務局（電話）", EMERGENCY_CONTACT_PHONE_NUMBER);
    if (officeBtn) contents.push(officeBtn);

    return {
        type: "bubble",
        body: {
            type: "box",
            layout: "vertical",
            contents: [{
                type: "text",
                text: "【詐欺注意】",
                weight: "bold",
                color: "#FF0000",
                size: "xl",
                align: "center"
            }, {
                type: "text",
                text: "怪しいお話には注意してね！不安な時は、信頼できる人に相談するか、こちらの情報も参考にして見てね💖",
                wrap: true,
                margin: "md"
            }]
        },
        footer: {
            type: "box",
            layout: "vertical",
            spacing: "sm",
            contents
        }
    };
};

cron.schedule('0 15 * * *', checkAndSendPing, {
    scheduled: true,
    timezone: JST_TZ
});
cron.schedule('0 * * * *', checkAndSendReminder, {
    scheduled: true,
    timezone: JST_TZ
});
cron.schedule('0 * * * *', checkAndSendEscalation, {
    scheduled: true,
    timezone: JST_TZ
});

app.listen(PORT, () => {
    console.log(`サーバーはポート${PORT}で実行されています`);
});
