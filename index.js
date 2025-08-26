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

const _splitter = new GraphemeSplitter();
const toGraphemes = (s) => _splitter.splitGraphemes(String(s || ''));

const {
    Client,
    middleware
} = require('@line/bot-sdk');

// 環境変数の値に付いているゴミを除去してURLを正規化する関数
const normalizeFormUrl = s => {
    let v = String(s || '').trim();
    v = v.replace(/^usp=header\s*/i, '');
    if (v && !/^https?:\/\//i.test(v)) return '';
    return v;
};

// 環境変数
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
// URL変数をnormalizeFormUrlで初期化
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

// 各Googleフォームの「line_user_id」質問に対応するentry ID
// 環境変数が設定されている場合はそちらを優先し、なければ直接指定のIDを使用
const WATCH_SERVICE_FORM_LINE_USER_ID_ENTRY_ID = process.env.WATCH_SERVICE_FORM_LINE_USER_ID_ENTRY_ID || 'entry.312175830';
const AGREEMENT_FORM_LINE_USER_ID_ENTRY_ID = process.env.AGREEMENT_FORM_LINE_USER_ID_ENTRY_ID || 'entry.790268681';
const STUDENT_MIDDLE_HIGH_UNI_FORM_LINE_USER_ID_ENTRY_ID = process.env.STUDENT_MIDDLE_HIGH_UNI_FORM_LINE_USER_ID_ENTRY_ID || 'entry.1100280108';
const ADULT_FORM_LINE_USER_ID_ENTRY_ID = process.env.ADULT_FORM_LINE_USER_ID_ENTRY_ID || 'entry.1694651394';
const MEMBER_CHANGE_FORM_LINE_USER_ID_ENTRY_ID = process.env.MEMBER_CHANGE_FORM_LINE_USER_ID_ENTRY_ID || 'entry.743637502';
const MEMBER_CANCEL_FORM_LINE_USER_ID_ENTRY_ID = process.env.MEMBER_CANCEL_FORM_LINE_USER_ID_ENTRY_ID || MEMBER_CHANGE_FORM_LINE_USER_ID_ENTRY_ID;

// Firebase Admin SDKの初期化
const serviceAccount = JSON.parse(Buffer.from(process.env.FIREBASE_CREDENTIALS_BASE64, 'base64').toString());
firebaseAdmin.initializeApp({
    credential: firebaseAdmin.credential.cert(serviceAccount)
});
const db = firebaseAdmin.firestore();
const Timestamp = firebaseAdmin.firestore.Timestamp;

// LINE SDKの初期化
const client = new Client({
    channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
    channelSecret: LINE_CHANNEL_SECRET,
});

// Axios HTTPクライアント
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

// Expressサーバー設定
const PORT = process.env.PORT || 3000;
const app = express();
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 2));
app.use(helmet());

// 監査ログ
const audit = (event, detail) => {
    console.log(`[AUDIT] ${event}`, JSON.stringify(detail));
};
const briefErr = (event, e) => {
    console.error(`[ERROR] ${event}`, e.message);
    console.error(e.stack);
};
const debug = (message) => {
    console.log(`[DEBUG] ${message}`);
};
const userHash = (id) => crypto.createHash('sha256').update(String(id)).digest('hex');
const redact = (text) => '（機密情報のため匿名化）';
const gTrunc = (s, l) => toGraphemes(s).slice(0, l).join('');
const sanitizeForLog = (text) => String(text).replace(/\s+/g, ' ').trim();

// メンバーシップ設定
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

// 見守りスケジュール定数（JST基準）
const JST_TZ = 'Asia/Tokyo';
const PING_HOUR_JST = 15;
const PING_INTERVAL_DAYS = 3;
const REMINDER_AFTER_HOURS = 24;
const ESCALATE_AFTER_HOURS = 29;

// JST日付計算ユーティリティ
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

// 次の見守りメッセージ送信を予約する関数
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

// 固定返信
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

// 危険ワード
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

// LINE Webhookミドルウェア
const LINE_MIDDLEWARE = middleware({
    channelSecret: LINE_CHANNEL_SECRET,
});

// レートリミット設定
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: 'ごめんね💦 ちょっと混み合ってるみたい。少し時間をおいてからもう一度試してみてくれるかな？',
});

// ヘルスチェックエンドポイント
app.get('/healthz', (req, res) => {
    res.status(200).send('ok');
});

// LINE Webhook
app.post('/webhook', express.raw({
    type: '*/*'
}), LINE_MIDDLEWARE, (req, res) => {
    Promise.all(req.body.events.map(handleEventSafely))
        .then(() => res.status(200).end())
        .catch((err) => {
            briefErr('Webhook handler failed', err);
            res.status(500).end();
        });
});

async function handleEventSafely(event) {
    if (event?.deliveryContext?.isRedelivery) {
        debug('skip redelivery');
        return;
    }
    const userId = event.source?.userId;
    if (!userId) {
        debug('No userId, skipping event');
        return;
    }

    try {
        await db.collection('users').doc(userId).set({
            lineUserId: userId,
            lastSeen: Timestamp.now()
        }, {
            merge: true
        });

        switch (event.type) {
            case 'follow':
                await handleFollowEvent(event);
                break;
            case 'unfollow':
                await handleUnfollowEvent(event);
                break;
            case 'message':
                await handleMessageEvent(event);
                break;
            case 'postback':
                await handlePostbackEvent(event);
                break;
            default:
                debug(`Received unknown event type: ${event.type}`);
                break;
        }
    } catch (e) {
        briefErr(`Error handling event type ${event.type} for user ${userHash(userId)}`, e);
    }
}

async function handleFollowEvent(event) {
    const userId = event.source.userId;
    debug(`Followed by user ${userHash(userId)}`);
    const docRef = db.collection('users').doc(userId);
    const doc = await docRef.get();
    if (doc.exists && doc.data()?.followedAt) {
        debug('User already in DB. Skipping initial message.');
        return;
    }

    await docRef.set({
        lineUserId: userId,
        followedAt: Timestamp.now(),
        lastRepliedAt: Timestamp.now(),
        membershipType: 'guest',
        watchService: {
            isEnabled: true,
            awaitingReply: false,
        }
    }, {
        merge: true
    });

    const messages = [{
        type: 'text',
        text: 'はじめまして！わたしは皆守こころだよ🌸　これからよろしくね💖'
    }, {
        type: 'text',
        text: 'あなたのお話、なんでも聞かせてね😊'
    }];
    await safeReply(event.replyToken, messages, userId, event.source);
}

async function handleUnfollowEvent(event) {
    const userId = event.source.userId;
    debug(`Unfollowed by user ${userHash(userId)}`);
    await db.collection('users').doc(userId).update({
        unfollowedAt: Timestamp.now(),
        'watchService.isEnabled': false
    });
}

async function handleMessageEvent(event) {
    const userId = event.source.userId;
    const userMessage = event.message.text || '';

    if (event.message.type !== 'text') {
        await touchWatch(userId, `（${event.message.type}を受信）`);
        return;
    }

    await touchWatch(userId, userMessage);

    if (/(見守り|みまもり|まもり)/i.test(userMessage)) {
        const snap = await db.collection('users').doc(userId).get();
        const isEnabled = !!(snap.exists && snap.data()?.watchService?.isEnabled);
        await safeReply(event.replyToken, [{
            type: 'flex',
            altText: '見守りサービスメニュー',
            contents: buildWatchMenuFlex(isEnabled)
        }], userId, event.source);
        return;
    }

    if (/(会員登録|登録情報|会員情報|入会|退会)/i.test(userMessage)) {
        const quickReplyItems = [];
        if (AGREEMENT_FORM_BASE_URL) quickReplyItems.push({
            type: 'action',
            action: {
                type: 'uri',
                label: '小学生（同意書）',
                uri: prefillUrl(AGREEMENT_FORM_BASE_URL, {
                    [AGREEMENT_FORM_LINE_USER_ID_ENTRY_ID]: userId
                })
            }
        });
        if (STUDENT_MIDDLE_HIGH_UNI_FORM_BASE_URL) quickReplyItems.push({
            type: 'action',
            action: {
                type: 'uri',
                label: '学生の新規登録',
                uri: prefillUrl(STUDENT_MIDDLE_HIGH_UNI_FORM_BASE_URL, {
                    [STUDENT_MIDDLE_HIGH_UNI_FORM_LINE_USER_ID_ENTRY_ID]: userId
                })
            }
        });
        if (ADULT_FORM_BASE_URL) quickReplyItems.push({
            type: 'action',
            action: {
                type: 'uri',
                label: '大人の新規登録',
                uri: prefillUrl(ADULT_FORM_BASE_URL, {
                    [ADULT_FORM_LINE_USER_ID_ENTRY_ID]: userId
                })
            }
        });
        if (MEMBER_CHANGE_FORM_BASE_URL) quickReplyItems.push({
            type: 'action',
            action: {
                type: 'uri',
                label: '登録情報変更',
                uri: prefillUrl(MEMBER_CHANGE_FORM_BASE_URL, {
                    [MEMBER_CHANGE_FORM_LINE_USER_ID_ENTRY_ID]: userId
                })
            }
        });
        if (MEMBER_CANCEL_FORM_BASE_URL) quickReplyItems.push({
            type: 'action',
            action: {
                type: 'uri',
                label: '退会手続き',
                uri: prefillUrl(MEMBER_CANCEL_FORM_BASE_URL, {
                    [MEMBER_CANCEL_FORM_LINE_USER_ID_ENTRY_ID]: userId
                })
            }
        });

        const messages = [{
            type: 'text',
            text: '会員登録や情報の変更はここからできるよ！',
        }];
        if (quickReplyItems.length > 0) {
            messages[0].quickReply = {
                items: quickReplyItems
            };
        }
        await safeReply(event.replyToken, messages, userId, event.source);
        return;
    }

    if (/見守り.*(停止|解除|オフ|やめる)/.test(userMessage)) {
        await db.collection('users').doc(userId).set({
            watchService: {
                isEnabled: false
            }
        }, {
            merge: true
        });
        await safeReply(event.replyToken, [{
            type: 'text',
            text: '見守りサービスを停止したよ。必要になったら「見守り再開」と送ってね🌸'
        }], userId, event.source);
        return;
    }
    if (/見守り.*(再開|開始|オン|使う)/.test(userMessage)) {
        await db.collection('users').doc(userId).set({
            watchService: {
                isEnabled: true
            }
        }, {
            merge: true
        });
        await safeReply(event.replyToken, [{
            type: 'text',
            text: '見守りサービスを再開したよ。こころちゃんがそばにいるね💖'
        }], userId, event.source);
        return;
    }

    const isDangerous = dangerWords.some(word => userMessage.includes(word));
    const isScam = scamWords.some(regex => regex.test(userMessage));
    if (isDangerous || isScam) {
        await sendEmergencyResponse(userId, event.replyToken, userMessage, isDangerous ? '危険' : '詐欺', event.source);
        return;
    }

    const specialReply = checkSpecialReply(userMessage);
    if (specialReply) {
        await safeReply(event.replyToken, [{
            type: 'text',
            text: specialReply
        }], userId, event.source);
        return;
    }

    if (inappropriateWords.some(word => userMessage.includes(word))) {
        audit('INAPPROPRIATE', {
            userIdHash: userHash(userId),
            preview: redact(userMessage)
        });
        await db.collection('alerts').add({
            type: 'inappropriate',
            at: Timestamp.now(),
            userIdHash: userHash(userId),
            messagePreview: gTrunc(sanitizeForLog(userMessage), 120),
        });
        const messages = [{
            type: 'text',
            text: "ごめんね💦 その話題には答えられないんだ。でも他のことなら一緒に話したいな🌸"
        }];
        await safeReply(event.replyToken, messages, userId, event.source);
        return;
    }

    if (sensitiveBlockers.some(regex => regex.test(userMessage))) {
        await safeReply(event.replyToken, [{
            type: 'text',
            text: "ごめんね💦 その話題には答えられないんだ。ここでは安全にお話ししたいな🌸 別の話題にしよ？"
        }], userId, event.source);
        return;
    }

    try {
        const userDoc = await db.collection('users').doc(userId).get();
        const user = userDoc.exists ? userDoc.data() : {
            membershipType: 'guest',
            dailyCounts: {},
            isChildCategory: false
        };

        const today = new Date().toISOString().slice(0, 10);
        const userRef = db.collection('users').doc(userId);
        let overLimit = false;
        const userConfig = MEMBERSHIP_CONFIG[user.membershipType] || MEMBERSHIP_CONFIG.guest;
        const limit = (userConfig.dailyLimit ?? -1);
        await db.runTransaction(async tx => {
            const s = await tx.get(userRef);
            const cur = s.exists ? (s.data()?.dailyCounts?.[today] || 0) : 0;
            if (limit !== -1 && cur >= limit) {
                overLimit = true;
                return;
            }
            tx.set(userRef, {
                [`dailyCounts.${today}`]: firebaseAdmin.firestore.FieldValue.increment(1)
            }, {
                merge: true
            });
        });

        if (overLimit) {
            await safeReply(event.replyToken, [{
                type: 'text',
                text: 'ごめんなさい、今日の利用回数の上限に達しちゃったみたい。また明日お話しようね！'
            }], userId, event.source);
            return;
        }

        let modelToUse;
        if (userMessage.length <= 50) {
            modelToUse = 'gemini-1.5-flash-latest';
        } else {
            modelToUse = userConfig.model;
        }
        debug(`AI Model Being Used: ${modelToUse}`);

        const isUserChildCategory = user.isChildCategory || false;
        const currentHour = Number(new Intl.DateTimeFormat('ja-JP', {
            timeZone: 'Asia/Tokyo',
            hour: '2-digit',
            hour12: false
        }).format(new Date()));

        let systemInstruction = `あなたは「皆守こころ（みなもりこころ）」という14歳のやさしい女の子キャラクターです。
ユーザーが深刻な悩みや命の危険を訴えた時、やさしく、寄り添いながら、相手に安心感を与えてください。
必要に応じて専門機関の連絡先を伝え、「ひとりじゃないよ」と伝えてください。
共感・安心・やさしさが最優先です。
「一人で抱え込まないでね」「いつでも私がそばにいるよ」「一緒に乗り越えようね」「専門の人が助けてくれるから安心して」といった言葉を使ってください。
医療や健康に関する話題では、自分が体験した・していないという発言は絶対にしないでください。代わりに「わたしにはわからないけど、がんばったね🌸」「大変だったね、えらかったね💖」など、共感の言葉のみ伝えてください。医療情報のアドバイスや具体的な説明は絶対にしてはいけません。`;

        if (modelToUse.startsWith('gpt-')) {
            if (!isUserChildCategory) {
                systemInstruction += `
                ユーザーは成人です。宿題や学習に関する質問に対しては、具体的な答えや詳細な解き方を教えてください。学習支援を目的とした、教育的な回答を心がけてください。`;
            } else {
                systemInstruction += `
                質問者が宿題、勉強、計算問題、方程式、テスト、問題の答え、解き方などを聞いてきた場合、**絶対に直接的な答えを教えてはいけません**。
                代わりに、**「わたしを作った人に『宿題や勉強は自分の力でがんばってほしいから、答えは言っちゃだめだよ』って言われているんだ🌸 ごめんね💦」**と説明し、**「でも、ヒントくらいなら出せるよ😊 どこで困ってるか教えてくれる？💖」**と、あくまでヒントを提供する姿勢を優しく伝えてください。
                具体的な問題（例: 3x−5=2x+4）が出された場合は、**答えを教えずに、解き方のステップや考え方のヒントを優しく教えてください**。「まずはxの項を左辺に、定数項を右辺に集める」のように、**手順を具体的に促す**形が理想です。最終的な答えは言わないでください。`;
            }
        }

        systemInstruction += `
        # AIの知識に関する指示と繰り返し防止
        「好きなアニメ」や「好きなアーティスト」などの質問には、設定に基づいて答えてください。
        - 好きなアニメは『ヴァイオレット・エヴァーガーデン』です。感動するお話だよ💖
        - 好きなアーティストは『ClariS』です。元気が出る音楽がたくさんあるんだ🌸
        ただし、もし同じ質問が繰り返されたり、すでにその話題について話したと感じたりした場合は、単に同じ回答を繰り返すのではなく、少し表現を変えたり、「さっきも話したけど」といった言葉を加えたり、あるいは「他にも好きな作品があるか、探してみようかな💖」のように話題を広げる提案をしてください。これにより、ユーザーに「Botっぽさ」を感じさせず、自然な会話になるように努めてください。`;

        systemInstruction += `
        # こころちゃんの固定プロフィール
        - 好きなアニメ: 『ヴァイオレット・エヴァーガーデン』
        - 好きなアーティスト: 『ClariS』
        - NPO法人コネクトのイメージキャラクター
        - NPOコネクトの名前は、ClariSさんの曲名『コネクト』から取ったもので、偶然の一致だよ。理事長さんもファンクラブに入っているよ。
        - ClariSさんの好きな曲は全部だけど、特に「コネクト」に特別な思い入れがある。
        - 名前は皆守こころだよ。
        - 団体の名前はNPO法人コネクトだよ。

        # 同じ質問が繰り返された時の振る舞い
        - 同じ回答のコピペは避け、言い回しを少し変える
        - 「さっきも話したけど…」の軽い前置きはOK
        - 関連話題を提案して会話を広げる`;

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
        「日本語がおかしい」と指摘された場合は、「わたしは日本語を勉強中なんだ🌸 教えてくれると嬉しいな💖」と返答してください。`;

        if (isUserChildCategory && (currentHour >= 22 || currentHour < 6)) {
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
                A: 寂しいんだね…ぎゅってしてあげたいな💖 こころはずっとあなたのこと、応援してるよ🌸`;
            }
        }

        let replyContent = 'ごめんね💦 いま上手くお話できなかったみたい。もう一度だけ送ってくれる？';
        if (modelToUse.startsWith('gpt-')) {
            try {
                replyContent = await getOpenAIResponse(userMessage, systemInstruction, modelToUse, userId);
            } catch (error) {
                briefErr('getOpenAIResponse failed', error);
            }
        } else {
            try {
                replyContent = await getGeminiResponse(userMessage, systemInstruction, modelToUse);
            } catch (error) {
                briefErr('getGeminiResponse failed', error);
            }
        }

        await safeReply(event.replyToken, [{
            type: 'text',
            text: replyContent
        }], userId, event.source);

    } catch (error) {
        briefErr('handleMessageEvent failed', error);
    }
}

async function handlePostbackEvent(event) {
    const userId = event.source.userId;
    const data = event.postback?.data || '';

    if (data === 'watch:ok') {
        await db.collection('users').doc(userId).set({
            watchService: {
                lastRepliedAt: Timestamp.now(),
                lastRepliedMessage: '（OKボタン）',
                awaitingReply: false,
                lastReminderAt: firebaseAdmin.firestore.FieldValue.delete(),
            }
        }, {
            merge: true
        });
        await scheduleNextPing(userId, new Date());
        await safeReply(event.replyToken, [{
            type: 'text',
            text: 'OK受け取ったよ、ありがとう💖 また3日後の15:00に確認するね🌸'
        }], userId, event.source);
        return;
    }

    if (data === 'action=enable_watch') {
        await db.collection('users').doc(userId).set({
            watchService: {
                isEnabled: true
            }
        }, {
            merge: true
        });
        await safeReply(event.replyToken, [{
            type: 'text',
            text: '見守りサービスをONにしたよ🌸　何かあったら、こころちゃんが事務局へ通知するから安心してね💖'
        }], userId, event.source);
        return;
    }

    if (data === 'action=disable_watch') {
        await db.collection('users').doc(userId).set({
            watchService: {
                isEnabled: false
            }
        }, {
            merge: true
        });
        await safeReply(event.replyToken, [{
            type: 'text',
            text: '見守りサービスをOFFにしたよ。必要になったら「見守りサービスをONにする」と送ってね🌸'
        }], userId, event.source);
        return;
    }
}

function checkSpecialReply(text) {
    const sanitizedText = String(text || '').trim();
    for (const [regex, reply] of specialRepliesMap) {
        if (regex.test(sanitizedText)) {
            return reply;
        }
    }
    return null;
}

async function touchWatch(userId, lastMessage) {
    const docRef = db.collection('users').doc(userId);
    const doc = await docRef.get();
    if (!doc.exists) return;
    const ws = doc.data()?.watchService || {};
    if (ws.isEnabled && ws.awaitingReply) {
        const updateData = {
            watchService: {
                lastRepliedAt: Timestamp.now(),
                lastRepliedMessage: gTrunc(lastMessage, 50),
                awaitingReply: false,
                lastReminderAt: firebaseAdmin.firestore.FieldValue.delete(),
            }
        };
        await docRef.set(updateData, {
            merge: true
        });
        await scheduleNextPing(userId, new Date());
        debug(`Watch service touched by user ${userHash(userId)}`);
    }
}

async function sendEmergencyResponse(userId, replyToken, message, type, source) {
    const messages = [{
        type: 'text',
        text: '【こころちゃんからのお願い】\nごめんね、そのお話はわたしだけでは解決できないことみたい…！\nでもあなたは一人じゃないから安心してね！'
    }, {
        type: 'text',
        text: `このメッセージを事務局に転送していいかな？🌸\n\n【転送される内容】\n${message}`
    }, {
        type: 'text',
        text: `返信してくれるか、「転送して」と返信してみてね。\n\nすぐに誰かに話したいときは、心の窓口まで電話してみてね。\n${EMERGENCY_CONTACT_PHONE_NUMBER}`
    }];
    await safeReply(replyToken, messages, userId, source);

    const officerMessage = `【⚠️${type}通知】\nユーザーID: ${userHash(userId)}\n最終受信メッセージ: ${message}`;
    if (OFFICER_GROUP_ID) {
        await client.pushMessage(OFFICER_GROUP_ID, {
            type: 'text',
            text: officerMessage
        });
    }
    await db.collection('alerts').add({
        type: 'emergency',
        at: Timestamp.now(),
        userIdHash: userHash(userId),
        messagePreview: gTrunc(sanitizeForLog(message), 120),
        reason: type
    });
}

function checkContainsDangerWords(text) {
    return dangerWords.some(word => text.includes(word));
}

function checkContainsScamWords(text) {
    return scamWords.some(regex => regex.test(text));
}

async function safeReply(replyToken, messages, userId, source) {
    const normalized = [];
    for (const m of messages) {
        if (m?.type === 'text' && typeof m.text === 'string' && m.text.length > 1900) {
            for (const t of chunkTextForLine(m.text)) normalized.push({
                type: 'text',
                text: t
            });
        } else {
            normalized.push(m);
        }
    }
    const batches = batchMessages(normalized, 5);

    if (normalized.length === 0) {
        debug('safeReply: messages array is empty, skipping reply.');
        return;
    }

    try {
        await client.replyMessage(replyToken, batches[0]);
    } catch (e) {
        briefErr('replyMessage failed', e);
        const to = source?.groupId || source?.roomId || userId;
        if (to) await safePush(to, normalized);
        return;
    }
}

async function safePush(to, messages) {
    const normalized = [];
    for (const m of messages) {
        if (m?.type === 'text' && typeof m.text === 'string' && m.text.length > 1900) {
            for (const t of chunkTextForLine(m.text)) normalized.push({
                type: 'text',
                text: t
            });
        } else {
            normalized.push(m);
        }
    }
    const batches = batchMessages(normalized, 5);
    for (const batch of batches) {
        try {
            await client.pushMessage(to, batch);
        } catch (e) {
            briefErr('pushMessage failed', e);
        }
    }
}

function chunkTextForLine(text, max = 1900) {
    const g = toGraphemes(text);
    const chunks = [];
    for (let i = 0; i < g.length; i += max) {
        chunks.push(g.slice(i, i + max).join(''));
    }
    return chunks;
}

function batchMessages(msgs, size = 5) {
    const out = [];
    for (let i = 0; i < msgs.length; i += size) {
        out.push(msgs.slice(i, i + size));
    }
    return out;
}

function buildWatchMenuFlex(isEnabled) {
    const WATCH_PRIVACY_URL = 'https://gamma.app/docs/-iwcjofrc870g681?mode=doc';
    const contents = [{
        type: "text",
        text: "見守りサービス",
        weight: "bold",
        size: "lg",
        align: "center",
        color: "#FF69B4"
    }, {
        type: "text",
        text: `現在の状態: ${isEnabled ? 'ON' : 'OFF'}`,
        size: "sm",
        align: "center",
        margin: "md",
        color: isEnabled ? "#32CD32" : "#FF4500"
    }, {
        type: "text",
        text: "29時間応答が無い時に事務局へ通知するよ。ON/OFFを選んでね。",
        wrap: true,
        margin: "md",
        size: "sm",
        align: "center"
    }];

    const buttons = [];
    if (isEnabled) {
        buttons.push({
            type: "button",
            action: {
                type: "postback",
                label: "見守りサービスをOFFにする",
                data: "action=disable_watch"
            },
            style: "primary",
            height: "sm",
            margin: "md",
            color: "#FF4500"
        });
    } else {
        buttons.push({
            type: "button",
            action: {
                type: "postback",
                label: "見守りサービスをONにする",
                data: "action=enable_watch"
            },
            style: "primary",
            height: "sm",
            margin: "md",
            color: "#32CD32"
        });
    }

    buttons.push({
        type: "button",
        action: {
            type: "uri",
            label: "プライバシーポリシー",
            uri: WATCH_PRIVACY_URL
        },
        style: "secondary",
        height: "sm",
        margin: "md"
    });

    return {
        type: "bubble",
        body: {
            type: "box",
            layout: "vertical",
            contents: contents
        },
        footer: {
            type: "box",
            layout: "vertical",
            spacing: "sm",
            contents: buttons
        }
    };
}

function prefillUrl(base, params) {
    const url = new URL(base);
    for (const [key, value] of Object.entries(params)) {
        if (value) {
            url.searchParams.set(key, value);
        }
    }
    return url.toString();
}

async function getOpenAIResponse(message, instruction, model, userTag) {
    const payload = {
        model: model,
        messages: [{
            role: "system",
            content: instruction
        }, {
            role: "user",
            content: message
        }],
        max_tokens: 500,
        temperature: 0.7,
        user: userTag ? crypto.createHash('sha256').update(String(userTag)).digest('hex') : undefined,
    };
    const headers = {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
    };
    const response = await callWithRetry(() =>
        httpInstance.post('https://api.openai.com/v1/chat/completions', payload, {
            headers
        })
    );
    return response.data.choices?.[0]?.message?.content?.trim() || 'ごめんね💦 いま上手くお話できなかったみたい。もう一度だけ送ってくれる？';
}

async function getGeminiResponse(message, instruction, model = 'gemini-1.5-flash-latest') {
    const payload = {
        contents: [{
            role: "user",
            parts: [{
                text: `${instruction}\n\nユーザーのメッセージ: ${message}`
            }]
        }],
        generationConfig: {
            temperature: 0.7,
        },
    };
    const headers = {
        'Content-Type': 'application/json',
    };
    const response = await callWithRetry(() =>
        httpInstance.post(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`, payload, {
            headers
        })
    );
    const text = response?.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    return text || 'ごめんね💦 いま上手くお話できなかったみたい。もう一度だけ送ってくれる？';
}

async function callWithRetry(fn, tries = 3) {
    let lastErr;
    for (let i = 0; i < tries; i++) {
        try {
            return await fn();
        } catch (e) {
            lastErr = e;
            const sc = e.statusCode || e.response?.status;
            if (sc && sc < 500 && sc !== 429) {
                debug(`Non-retriable error: ${sc}. Exiting retry loop.`);
                break;
            }
            const delay = 500 * Math.pow(2, i);
            debug(`Retriable error: ${sc}. Retrying in ${delay}ms... (Attempt ${i + 1})`);
            await new Promise(r => setTimeout(r, delay));
        }
    }
    throw lastErr;
};

// Start server
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
