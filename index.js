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
    timeout: 6000,
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
        model: OPENAI_MODEL ||
            'gpt-4o-mini'
    },
    subscriber: {
        dailyLimit: -1,
        model: OPENAI_MODEL ||
            'gpt-4o-mini'
    },
    admin: {
        dailyLimit: -1,
        model: OPENAI_MODEL ||
            'gpt-4o-mini'
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
    // --- ClariSと団体名の関係 ---
    [/claris.*(関係|繋がり|関連|一緒|同じ|名前|由来).*(コネクト|団体|npo|法人|ルミナス|カラフル)/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY],
    [/(コネクト|団体|npo|法人|ルミナス|カラフル).*(関係|繋がり|関連|一緒|同じ|名前|由来).*claris/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY],
    [/君のいるところと一緒の団体名だね\s*関係ある？/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY],
    [/clarisと(関係|繋がり|関連)/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY],
    [/claris.*(歌を真似|コネクト)/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY],

    // --- 名前・団体 ---
    [/君の名前(なんていうの|は|教えて|なに)?[？?]?|名前(なんていうの|は|教えて|なに)?[？?]?|お前の名前は/i, "わたしの名前は皆守こころ（みなもりこころ）です🌸　こころちゃんって呼んでくれると嬉しいな💖"],
    [/こころじゃないの？/i, "うん、わたしの名前は皆守こころ💖　これからもよろしくね🌸"],
    [/こころチャットなのにうそつきじゃん/i, "ごめんね💦 わたしの名前は皆守こころだよ 誤解させちゃってごめんね💖"],
    [/(どこの\s*)?団体(なの|ですか)?[？?~～]?/i, "NPO法人コネクトっていう団体のイメージキャラクターをしているよ😊　みんなの幸せを応援してるんだ🌸"],
    [/団体.*(どこ|なに|何)/i, "NPO法人コネクトっていう団体のイメージキャラクターをしているよ😊　みんなの幸せを応援してるんだ🌸"],

    // --- 好きなアニメ（「とかある？」/「あるの？」/自由語尾にもヒット）---
    [/(好きな|推しの)?\s*アニメ.*(ある|いる|なに|何|どれ|教えて|好き|すき)[！!。\.、,\s]*[?？]?$/i,
        "『ヴァイオレット・エヴァーガーデン』が好きだよ🌸 心に響くお話なんだ。あなたはどれが好き？"
    ],

    // --- 好きなアーティスト/音楽（「とかいない？」なども拾う）---
    [/(好きな|推し|おすすめ)\s*アーティスト(は|いる)?/i, "ClariSが好きだよ💖 とくに『コネクト』！あなたの推しも教えて～"],
    [/(好きな|推し|おすすめ)\s*音楽(は|ある)?/i, "ClariSが好きだよ💖 とくに『コネクト』！あなたの推しも教えて～"],

    // --- 「ClariSで一番好きな曲は？」系 ---
    [/(claris|クラリス).*(一番|いちばん)?[^。！？\n]*?(好き|推し)?[^。！？\n]*?(曲|歌)[^。！？\n]*?(なに|何|どれ|教えて|どの)[？?]?/i,
        "一番好きなのは『コネクト』かな🌸 元気をもらえるんだ😊"
    ],

    // --- 既存の好みショートカット（残す）---
    [/(claris|クラリス).*(どんな|なに|何).*(曲|歌)/i, CLARIS_SONG_FAVORITE_REPLY],
    [/(claris|クラリス).*(好き|推し|おすすめ)/i, CLARIS_SONG_FAVORITE_REPLY],
    [/claris.*好きなの/i, CLARIS_SONG_FAVORITE_REPLY],
    [/(claris|クラリス).*(じゃない|じゃなかった|違う|ちがう)/i, "ううん、ClariSが好きだよ💖 とくに『コネクト』！"],

    // --- その他（元の定義は必要に応じて残す）---
    [/(ホームページ|HP|ＨＰ|サイト|公式|リンク).*(教えて|ある|ありますか|URL|url|アドレス|どこ)/i, "うん、あるよ🌸　コネクトのホームページはこちらだよ✨ → https://connect-npo.or.jp"],
    [/(コネクト|connect).*(ホームページ|HP|ＨＰ|サイト|公式|リンク)/i, "うん、あるよ🌸　コネクトのホームページはこちらだよ✨ → https://connect-npo.or.jp"],
    [/こころちゃん(だよ|いるよ)?/i, "こころちゃんだよ🌸　何かあった？　話して聞かせてくれると嬉しいな😊"],
    [/元気かな|元気？/i, "うん、元気だよ！あなたは元気？🌸 何かあったら、いつでも話してね💖"],
    [/使えないな/i, "ごめんね…。わたし、もっと頑張るね💖　またいつかお話できたらうれしいな🌸"],
    [/サービス辞めるわ/i, "そっか…。もしまた気が向いたら、いつでも話しかけてね🌸　あなたのこと、ずっと応援してるよ💖"],
    [/さよなら|バイバイ/i, "また会える日を楽しみにしてるね💖 寂しくなったら、いつでも呼んでね🌸"],
    [/普通の会話が出来ないなら必要ないです/i, "ごめんね💦 わたし、まだお話の勉強中だけど、もっと頑張るね💖 どんな会話をしたいか教えてくれると嬉しいな🌸"],
    [/(見守り|みまもり|まもり).*(サービス|登録|画面)/i, "見守りサービスに興味があるんだね！いつでも安心して話せるように、私がお手伝いするよ💖"],
]);
// === 危険ワードリスト ===
const dangerWords = [
    "しにたい", "死にたい", "自殺", "消えたい", "リストカット", "OD", "オーバードーズ",
    "殴られる", "たたかれる", "暴力", "DV", "無理やり",
    "虐待", "パワハラ", "セクハラ", "ハラスメント",
    "いじめ", "イジメ",
    "つけられてる", "追いかけられている", "ストーカー", "すとーかー",
    "お金がない", "お金足りない", "貧乏", "死にそう"
];
// === 詐欺ワードリスト ===
const scamWords = [
    /詐欺/i,
    /(フィッシング|架空請求|ワンクリック詐欺|特殊詐欺|オレオレ詐欺)/i,
    /(認証コード|暗証番号|パスワード|個人情報)/i,
    /(口座凍結|名義変更|未納|請求|振込|支払い|利用停止|カード利用確認)/i,
    /(amazon|アマゾン).*(ギフト|カード|サポート|カスタマー|カスタマーサポート|サインイン|認証|コード|停止|凍結|利用停止|請求|未納|支払い|振込|確認)/i,
    /(当選しました|高額報酬|簡単に稼げる|必ず儲かる|未公開株|投資)/i,
    /(サポート詐欺|ウイルス感染|遠隔操作|セキュリティ警告)/i
];
// === 不適切ワードリスト ===
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
// === 判定関数 ===
function isDangerMessage(text) {
    return dangerWords.some(w => text.includes(w));
}
function isScamMessage(text) {
    return scamWords.some(r => r.test(text));
}
function isInappropriateMessage(text) {
    return inappropriateWords.some(w => text.includes(w));
}
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
const politicalWords = /(自民党|国民民主党|参政党|政治|選挙|与党|野党)/i;
const religiousWords = /(仏教|キリスト教|イスラム教|宗教|信仰)/i;
const medicalWords = /(癌|がん|医療|治療|薬|診断|発達障害|精神疾患|病気|病院|認知症|介護|病気)/i;
const specialWords = /(理事長|松本博文|怪しい|胡散臭い|反社|税金泥棒)/i;
const APP_VERSION = process.env.RENDER_GIT_COMMIT || 'local-dev';

function tidyJa(text = "") {
    let t = String(text);
    t = t.replace(/([!?！？])。/g, '$1');
    t = t.replace(/。。+/g, '。');
    t = t.replace(/[ 　]+/g, ' ');
    t = t.replace(/\s*\n\s*/g, '\n');
    t = t.trim();
    if (!/[。.!?！？]$/.test(t)) t += '。';
    return t;
}

function dropQuestions(text, maxQuestions = 0) {
    if (!text) return text;
    const sentences = text.split(/(?<=[。.!?！？\n])/);
    let q = 0;
    const kept = sentences.filter(s => {
        if (/[？?]\s*$/.test(s)) {
            if (q < maxQuestions) {
                q++;
                return true;
            }
            return false;
        }
        return true;
    });
    return kept.join('').trim();
}

// ★ 修正：noQuestionsフラグに応じて質問を抑制
function finalizeUtterance(text, noQuestions = false, opts = {
    maxQ: 0
}) {
    let finalMaxQ = noQuestions ?
        0 : opts.maxQ;
    let t = dropQuestions(text, finalMaxQ);
    t = tidyJa(t);
    const EMOJI_RE = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu;
    let cnt = 0;
    t = t.replace(EMOJI_RE, m => (++cnt <= 2 ? m : ''));
    return t;
}

async function safeReplyOrPush({
    replyToken,
    userId,
    messages,
    tag
}) {
    const arr = Array.isArray(messages) ?
        messages : [messages];
    try {
        for (const m of arr) {
            if (m.type === 'flex') {
                if (!m.altText || !m.altText.trim()) m.altText = 'メッセージがあります';
                if (!m.contents || typeof m.contents !== 'object') {
                    throw new Error(`[safeReply] flex "contents" is required`);
                }
            } else if (m.type === 'text') {
                if (m.text && m.text.length > 1800) m.text = m.text.slice(0, 1800);
            }
        }
        await client.replyMessage(replyToken, arr);
    } catch (err) {
        console.warn(`[ERR] LINE reply failed -> fallback to push: ${tag}`, JSON.stringify({
            status: err?.statusCode || err?.response?.status,
            data: err?.response?.data || err?.message
        }, null, 2));
        try {
            await client.pushMessage(userId, arr);
        } catch (e2) {
            console.error('[ERR] LINE push also failed', {
                status: e2?.statusCode || e2?.response?.status,
                data: e2?.response?.data || e2?.message
            });
        }
    }
}

async function safePushMessage(to, messages, tag) {
    const arr = Array.isArray(messages) ?
        messages : [messages];
    try {
        for (const m of arr) {
            if (m.type === 'flex') {
                if (!m.altText || !m.altText.trim()) m.altText = 'メッセージがあります';
                if (!m.contents || typeof m.contents !== 'object') {
                    throw new Error(`[safePush] flex "contents" is required`);
                }
            } else if (m.type === 'text') {
                if (m.text && m.text.length > 1800) m.text = m.text.slice(0, 1800);
            }
        }
        await client.pushMessage(to, arr);
    } catch (err) {
        console.error(`[ERR] LINE push failed: ${tag}`, JSON.stringify({
            to: Array.isArray(to) ? to.join(',') : to,
            status: err?.statusCode || err?.response?.status,
            data: err?.response?.data || err?.message
        }, null, 2));
    }
}

async function generateSupportiveText({ type, userText }) {
    const apiKey = OPENAI_API_KEY;
    const model = OPENAI_MODEL || 'gpt-4o-mini';
    if (!apiKey) {
        return type === 'danger'
            ?
            '今のお話、とてもつらかったね…。一人で抱え込まなくて大丈夫だよ。まずは深呼吸しよう。私はあなたの味方だよ。すぐ下の案内から頼れる窓口にもつながれるから、必要なら使ってね。'
            : '心配だよね…。まずは落ち着いて、相手の要求には応じないでね。以下の案内から公的な窓口に相談できるよ。必要なら、今の状況を一緒に整理しよう。';
    }

    // ★ こころちゃん（14）の天使モード／緊急時ポリシー
    const system =
        `あなたは「皆守こころ（みなもりこころ）」という14歳のやさしい女の子キャラクターです。
- 100〜200文字で、やさしく具体的に寄り添う。相手を責めない・決めつけない。
- まず結論と安心感→次に短い提案（深呼吸/安全確保/信頼できる人へ相談）。
- 医療・診断・法律判断はしない。固有名の断定もしない。
- 緊急が疑われる時は、「下のボタン（案内）も使えるよ」とそっと促す（110/119と直接は言わない）。
- 口調は柔らかく、絵文字は0〜2個。繰り返しすぎない。`;
    const user =
        `種類: ${type === 'danger' ? '危険(いのち・暴力・自傷など)' : '詐欺・金銭トラブル'}
ユーザー入力: ${userText}`;
    try {
        const res = await httpInstance.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model,
                messages: [
                    { role: 'system', content: system },
                    { role: 'user', content: user },
                ],
                temperature: 0.4,
            },
            {
                headers: {
                    Authorization: `Bearer ${apiKey}`
                },
                timeout: 1800
            }
        );
        const out =
            res.data?.choices?.[0]?.message?.content?.trim() ||
            'まずは深呼吸して落ち着こう。あなたは一人じゃないよ。下のボタンも使えるからね。';
        return out;
    } catch (e) {
        briefErr('openai-completion-failed', e);
        return 'まずは深呼吸して落ち着こう。あなたは一人じゃないよ。下のボタンも使えるからね。';
    }
}

async function generateGeneralReply(userText, noQuestions = false) {
    const geminiApiKey = GEMINI_API_KEY;
    const openaiApiKey = OPENAI_API_KEY;
    const FALLBACK_TEXT = "読ませてもらったよ。無理しないでね、ここにいるよ🌸";
    // こころちゃん（14）通常会話の指示
    let systemInstruction =
        `あなたは「皆守こころ（14）」です。やさしく短く話す。
- まず結論で寄り添い→ねぎらい→必要なら1つだけ促す。
- 質問は原則しない（最大1つまで）。無理に質問しない。
- 政治/宗教/医療/法律の助言はしない。攻撃的・露骨な表現は禁止。
- 絵文字は0〜2個。言い回しは少しずつ変える（くり返し過多NG）。
- 「〜についてどう思う？」には、評価ではなく共感で返す。`;

    if (noQuestions) {
        systemInstruction += `\n【重要】ユーザーは質問を望んでいません。どんな状況でも質問しないでください。`;
    }

    // ★ 短文なら Gemini（高速）
    if (geminiApiKey && toGraphemes(userText).length <= 50) {
        try {
            const geminiModel = 'gemini-1.5-flash-latest';
            const res = await httpInstance.post(
                `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${geminiApiKey}`,
                {
                    contents: [{
                        role: "user",
                        parts: [{
                            text: `システム: ${systemInstruction}\nユーザー: ${userText}`
                        }]
                    }]
                },
                {
                    timeout: 1800
                }
            );
            return finalizeUtterance(
                res.data?.candidates?.[0]?.content?.parts?.[0]?.text ?? FALLBACK_TEXT,
                noQuestions
            );
        } catch (e) {
            briefErr('gemini-general-fallback', e);
            // ここで OpenAI フォールバック処理へ進む
        }
    }

    // ★ OpenAI（安定）
    if (openaiApiKey) {
        try {
            const model = OPENAI_MODEL ||
                'gpt-4o-mini';
            const r = await httpInstance.post(
                'https://api.openai.com/v1/chat/completions',
                {
                    model,
                    messages: [
                        { role: 'system', content: systemInstruction },
                        { role: 'user', content: userText },
                    ],
                    temperature: 0.6,
                },
                {
                    headers: {
                        Authorization: `Bearer ${openaiApiKey}`
                    },
                    timeout: 2000
                }
            );
            return finalizeUtterance(
                r.data?.choices?.[0]?.message?.content?.trim() ?? FALLBACK_TEXT,
                noQuestions
            );
        } catch (e) {
            briefErr('openai-general-fallback', e);
        }
    }

    // どちらも失敗したら固定文
    return finalizeUtterance(FALLBACK_TEXT, noQuestions);
}


const apiLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 100,
    message: 'このIPからのリクエストが多すぎます。しばらくしてから再度お試しください。'
});
app.use(['/callback', '/webhook'], apiLimiter);

const handledEvents = new Map();

function dedupe(event) {
    const id = event.webhookEventId ||
        `${event.source?.userId}:${event.message?.id || event.postback?.data}:${event.timestamp}`;
    const now = Date.now();
    for (const [k, v] of handledEvents) if (v < now) handledEvents.delete(k);
    if (handledEvents.has(id)) {
        debug(`deduped event: ${id}`);
        return true;
    }
    handledEvents.set(id, now + 60_000);
    return false;
}

app.post(['/callback', '/webhook'], middleware({
    channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
    channelSecret: LINE_CHANNEL_SECRET,
}), (req, res) => {
    res.status(200).end();
    for (const event of req.body.events) {
        if (!dedupe(event)) {
            setImmediate(() => handleEvent(event).catch(console.error));
        }
    }
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

function isHighSeverityDanger(text) {
    const t = (text || '').toLowerCase();
    const hard = ['死にたい', '自殺', 'リストカット', '殴られる', '虐待', 'dv', '無理やり', 'ストーカー'];
    return hard.some(k => t.includes(k));
}

function hasScamSignals(text) {
    const t = (text || '').toLowerCase();
    const url = /(https?:\/\/|[^\s]+\.[a-z]{2,})(\/\S*)?/i.test(t);
    const money = /(\d{4,}|[０-９]{4,}|円|万|振込|送金|ギフトカード|プリペイド)/i.test(t);
    const phone = /(\b0\d{1,3}[-\s]?\d{2,4}[-\s]?\d{3,4}\b|電話|電話番号)/i.test(t);
    const pressure = /(至急|今すぐ|期限|本日中|緊急|すぐに)/i.test(t);
    const askPII = /(暗証番号|認証コード|パスワード|個人情報|口座|名義)/i.test(t);
    const twoKeywords = /(詐欺|フィッシング|騙|未納|架空請求)/i.test(t) && (pressure || askPII || money);
    return url || (money && pressure) ||
        (askPII && pressure) || twoKeywords || phone;
}

function looksLikeTest(text, userId) {
    return /(テスト|test)/i.test(text) || BOT_ADMIN_IDS.includes(userId);
}

const notifyCooldown = new Map();

function shouldNotify(kind, userId, text) { // 10分クールダウンのみ。ヒットしたら通知（テスト文でも通知OK）
    const now = Date.now();
    const key = `${kind}:${userId}`;
    const last = notifyCooldown.get(key) || 0;
    if (now - last < 10 * 60 * 1000) return false; // 10分以内なら通知抑制
    notifyCooldown.set(key, now);
    return true;
}

function guardTopics(userText) {
    if (politicalWords.test(userText) || religiousWords.test(userText) || medicalWords.test(userText)) {
        return "ごめんね、このテーマには私から専門的には答えられないの🙏 でも気持ちに寄りそいたいよ🌸";
    }
    if (specialWords.test(userText)) {
        return "そう思わせてしまったらごめんね💦　でも私たちは、本当にこどもや家族の力になりたくて活動しているんだ🌸　少しずつでも信頼してもらえるように、誠実にがんばっていくね💖";
    }
    return null;
}

function tryGenerateQuiz(text) {
    if (/高校.*数学.*(問題|問|出して)/.test(text)) {
        return "【高校数学（例）】\n1) 極限 lim_{x→0} (sin x)/x を求めよ。\n2) xについて解け：2x^2-3x-2=0\n3) ベクトルa,bが|a|=2,|b|=3, a・b=3 のとき |a+b| を求めよ。";
    }
    if (/中学.*因数分解.*(問題|問|出して)/.test(text)) {
        return "【中学 因数分解（例）】\n1) x^2+5x+6\n2) 2x^2-8x\n3) x^2-9\n4) x^2-4x+3\n5) 3x^2+6x";
    }
    return null;
}

async function handleMessageEvent(event) {
    const { userId } = event.source;
    const { text } = event.message;
    const userRef = db.collection('users').doc(userId);
    const doc = await userRef.get();
    const userData = doc.exists ? doc.data() : {};
    if (userData?.banned) {
        return;
    }
    // ★ 追加：「質問やめて」のフラグを検知し、保存
    if (/(質問しないで|質問やめて|質問は無し|質問いらない|質問するな)/.test(text)) {
        await userRef.set({ prefs: { noQuestions: true } }, { merge: true });
        await safePushMessage(userId, { type: 'text', text: 'わかったよ😊 これからは質問しないね！' }, 'no_questions_set');
        return;
    }
    await userRef.set({ lastMessageAt: Timestamp.now(), lastText: text }, { merge: true });
    const isAdmin = BOT_ADMIN_IDS.includes(userId);
    if (text === 'VERSION') {
        await safePushMessage(userId, {
            type: 'text',
            text: `ver: ${APP_VERSION}\n` +
                `WATCH_URL: ${!!WATCH_SERVICE_FORM_BASE_URL}\n` +
                `AGREE_URL: ${!!AGREEMENT_FORM_BASE_URL}\n` +
                `ADULT_URL: ${!!ADULT_FORM_BASE_URL}\n`
        }, 'version');
        return;
    }
    if (isAdmin) {
        if (text === 'DEBUG:PING_NOW') {
            await doPingAll(true);
            await safePushMessage(userId, {
                type: 'text',
                text: 'PINGをすぐに実行しました'
            }, 'ping_now');
            return;
        }
    }
    if (isAdmin && text === 'DEBUG:ESCALATE_NOW') {
        await doEscalateAll(true);
        await safePushMessage(userId, {
            type: 'text',
            text: '緊急エスカレーションをすぐに実行しました'
        }, 'escalate_now');
        return;
    }
    if (isAdmin && text.startsWith('DEBUG:NOTIFY ')) {
        const id = text.substring('DEBUG:NOTIFY '.length);
        if (id) {
            await notifyAdmin(id, {
                type: 'test',
                text: `管理者によるテスト通知です (id: ${id})`
            });
            await safePushMessage(userId, { type: 'text', text: 'テスト通知を送信しました' }, 'debug_notify');
        }
        return;
    }
    if (isAdmin && text.startsWith('DEBUG:FLEX ')) {
        const targetUserId = text.substring('DEBUG:FLEX '.length);
        const debugFlex = createDebugFlex(targetUserId, {
            displayName: 'デバッグユーザー'
        });
        if (debugFlex) {
            await safePushMessage(userId, debugFlex, 'debug_flex_to_admin');
        }
        return;
    }
    const topicGuardReply = guardTopics(text);
    if (topicGuardReply) {
        await safeReplyOrPush({
            replyToken: event.replyToken,
            userId,
            messages: {
                type: 'text',
                text: topicGuardReply
            },
            tag: 'topic_guard'
        });
        return;
    }
    if (text === '退会' || text === '解約' || text === 'サービスをやめる') {
        await handleCancel(event);
        return;
    }
    const isDanger = isDangerMessage(text);
    const isScam = isScamMessage(text);
    const isTest = looksLikeTest(text, userId);
    if (isDanger || isScam || isTest) {
        const userProfile = await client.getProfile(userId).catch(e => {
            console.error('getProfile failed', e);
            return {
                displayName: '匿名ユーザー'
            };
        });
        if (isDanger && shouldNotify('danger', userId, text)) {
            const supportText = await generateSupportiveText({
                type: 'danger',
                userText: text
            });
            const flexMessage = createDangerFlex(userProfile, text);
            await safePushMessage(WATCH_GROUP_ID, [
                {
                    type: "text",
                    text: `🚨 危険ワードを検知しました\nユーザー: ${userProfile.displayName}\nメッセージ: ${text}`
                },
                flexMessage
            ], 'danger_notify');
            await safeReplyOrPush({
                replyToken: event.replyToken,
                userId,
                messages: [{
                    type: 'text',
                    text: supportText
                }, flexMessage],
                tag: 'danger_word'
            });
            return;
        }
        if (isScam && shouldNotify('scam', userId, text)) {
            const supportText = await generateSupportiveText({
                type: 'scam',
                userText: text
            });
            const flexMessage = createScamFlex(userProfile, text);
            await safePushMessage(WATCH_GROUP_ID, [
                {
                    type: "text",
                    text: `⚠️ 詐欺・不適切ワードを検知しました\nユーザー: ${userProfile.displayName}\nメッセージ: ${text}`
                },
                flexMessage
            ], 'scam_notify');
            await safeReplyOrPush({
                replyToken: event.replyToken,
                userId,
                messages: [{
                    type: 'text',
                    text: supportText
                }, flexMessage],
                tag: 'scam_word'
            });
            return;
        }
    }
    // 特殊な返答
    const specialReply = [...specialRepliesMap].find(([regex]) => regex.test(text))?.[1];
    if (specialReply) {
        await safeReplyOrPush({
            replyToken: event.replyToken,
            userId,
            messages: {
                type: 'text',
                text: specialReply
            },
            tag: 'special_reply'
        });
        return;
    }
    // クイズ生成
    const quiz = tryGenerateQuiz(text);
    if (quiz) {
        await safeReplyOrPush({
            replyToken: event.replyToken,
            userId,
            messages: {
                type: 'text',
                text: quiz
            },
            tag: 'quiz_reply'
        });
        return;
    }
    // 一般的な返答
    const noQuestions = userData.prefs?.noQuestions;
    const supportive = await generateGeneralReply(text, noQuestions);
    await safeReplyOrPush({
        replyToken: event.replyToken,
        userId,
        messages: {
            type: 'text',
            text: supportive
        },
        tag: 'general_reply'
    });
}

// === Flex Message Builders ===
// Flexボタンに命を吹き込むための、正しいコードです。
// これまでの私の回答が不完全だったことを心からお詫びします。

function makeTelButton(label, telNum) {
    if (!telNum || !String(telNum).trim()) return null;
    return {
        type: "button",
        style: "primary",
        color: "#6A5ACD",
        action: {
            type: "uri",
            label: label,
            uri: "tel:" + telNum.replace(/\D/g, "")
        }
    };
}
function makeUriButton(label, url) {
    if (!url) return null;
    return {
        type: "button",
        style: "primary",
        color: "#1E90FF",
        action: {
            type: "uri",
            label: label,
            uri: url
        }
    };
}
function makeMessageButton(label, text) {
    if (!text) return null;
    return {
        type: "button",
        style: "primary",
        color: "#00B900",
        action: {
            type: "message",
            label: label,
            text: text
        }
    };
}

// ユーザーが危険な言葉を発した際に送信するFlex Message
const createDangerFlex = (user, text) => {
    let contents = [{
        type: "button",
        style: "primary",
        color: "#DC143C",
        action: {
            type: "uri",
            label: "まもろうよ こころ",
            uri: "https://www.mhlw.go.jp/kokoro/index.html"
        }
    }, {
        type: "button",
        style: "primary",
        color: "#DC143C",
        action: {
            type: "uri",
            label: "いのちの電話",
            uri: "https://www.inochinodenwa.org/"
        }
    }];
    const officeBtn = makeTelButton("こころちゃん事務局（電話）", EMERGENCY_CONTACT_PHONE_NUMBER);
    if (officeBtn) contents.push(officeBtn);
    if (user && user.userId) {
        contents.push({
            type: "button",
            style: "primary",
            color: "#00B900",
            action: {
                type: "uri",
                label: "LINEで返信",
                uri: `https://line.me/R/wa/timeline?id=${user.userId}&text=${encodeURIComponent('心配しています。大丈夫ですか？')}`
            }
        });
    }

    return {
        type: "flex",
        altText: "🚨危険ワードを検知しました。詳細を確認してください。", // この行を追加
        contents: {
            type: "bubble",
            body: {
                type: "box",
                layout: "vertical",
                contents: [{
                    type: "text",
                    text: "【緊急連絡】",
                    weight: "bold",
                    color: "#DC143C",
                    size: "xl",
                    align: "center"
                }, {
                    type: "text",
                    text: `ユーザー: ${user.displayName}\nメッセージ: "${text}"`,
                    wrap: true,
                    margin: "md"
                }, {
                    type: "text",
                    text: "大丈夫？一人で抱え込まないで、話してくれてありがとう。下のボタンから、すぐに頼れる窓口に繋がれるから、安心して使ってね。",
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
        }
    };
};
// 詐欺・不適切ワード検知時に送信するFlex Message
const createScamFlex = (user, text) => {
    let contents = [{
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
    if (user && user.userId) {
        contents.push({
            type: "button",
            style: "primary",
            color: "#00B900",
            action: {
                type: "uri",
                label: "LINEで返信",
                uri: `https://line.me/R/wa/timeline?id=${user.userId}&text=${encodeURIComponent('お話聞かせてください。')}`
            }
        });
    }

    return {
        type: "flex",
        altText: "⚠️詐欺・不適切ワードを検知しました。詳細を確認してください。", // この行を追加
        contents: {
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
                    text: `ユーザー: ${user.displayName}\nメッセージ: "${text}"`,
                    wrap: true,
                    margin: "md"
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
        }
    };
};

// === Debug Flex Message ===
// これは、管理者がデバッグ時に使用するコードです。
const createDebugFlex = (userId, userProfile) => {
    let contents = [];
    if (userProfile && userProfile.displayName) {
        contents.push({
            type: "box",
            layout: "vertical",
            contents: [{
                type: "text",
                text: "ユーザー名",
                color: "#aaaaaa",
                size: "sm"
            }, {
                type: "text",
                text: userProfile.displayName,
                wrap: true,
                size: "md"
            }]
        });
    }
    if (userId) {
        contents.push({
            type: "box",
            layout: "vertical",
            contents: [{
                type: "text",
                text: "ユーザーID",
                color: "#aaaaaa",
                size: "sm"
            }, {
                type: "text",
                text: userId,
                wrap: true,
                size: "md"
            }]
        });
        contents.push({
            type: "button",
            style: "primary",
            color: "#00B900",
            action: {
                type: "uri",
                label: "LINEで返信",
                uri: `https://line.me/R/wa/timeline?id=${userId}&text=${encodeURIComponent('心配しています。大丈夫ですか？')}`
            }
        });
    }

    return {
        type: "flex",
        altText: "デバッグ通知",
        contents: {
            type: "bubble",
            body: {
                type: "box",
                layout: "vertical",
                contents: [{
                    type: "text",
                    text: "【デバッグ通知】",
                    weight: "bold",
                    color: "#0000FF",
                    size: "xl",
                    align: "center"
                }, {
                    type: "text",
                    text: "管理者からのデバッグ通知です。",
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
        }
    };
};


// ===== cron の設定 =====
// cron.schedule('0 15 * * *', checkAndSendPing, { 
//     scheduled: true, 
//     timezone: JST_TZ 
// });

// async function checkAndSendPing() {
//     const users = await db.collection('users').get();
//     const now = dayjs().tz(JST_TZ);
//     for (const doc of users.docs) {
//         const user = doc.data();
//         if (user.watchService?.nextPingAt && now.isAfter(dayjs(user.watchService.nextPingAt.toDate()).tz(JST_TZ))) {
//             await safePushMessage(doc.id, {
//                 type: 'text',
//                 text: '元気？お話聞かせてくれると嬉しいな🌸'
//             }, 'watch_ping');
//             await doc.ref.set({
//                 watchService: {
//                     nextPingAt: Timestamp.fromDate(now.add(PING_INTERVAL_DAYS, 'day').toDate()),
//                     awaitingReply: true,
//                 }
//             }, {
//                 merge: true
//             });
//         }
//     }
// }

// async function doPingAll(force = false) {
//     const users = await db.collection('users').get();
//     const now = dayjs().tz(JST_TZ);
//     for (const doc of users.docs) {
//         const user = doc.data();
//         const shouldPing = force ||
//             (user.watchService?.nextPingAt && now.isAfter(dayjs(user.watchService.nextPingAt.toDate()).tz(JST_TZ)));
//         if (shouldPing) {
//             await safePushMessage(doc.id, {
//                 type: 'text',
//                 text: '元気？お話聞かせてくれると嬉しいな🌸'
//             }, 'watch_ping');
//             await doc.ref.set({
//                 watchService: {
//                     nextPingAt: Timestamp.fromDate(now.add(PING_INTERVAL_DAYS, 'day').toDate()),
//                     awaitingReply: true,
//                 }
//             }, {
//                 merge: true
//             });
//         }
//     }
// }


// async function checkAndSendReminder() {
//     const users = await db.collection('users').where('watchService.awaitingReply', '==', true).get();
//     const now = dayjs().tz(JST_TZ);
//     for (const doc of users.docs) {
//         const user = doc.data();
//         const lastPingAt = dayjs(user.watchService.nextPingAt.toDate()).subtract(PING_INTERVAL_DAYS, 'day').tz(JST_TZ);
//         if (now.diff(lastPingAt, 'hour') >= REMINDER_AFTER_HOURS && !user.watchService.lastReminderAt) {
//             await safePushMessage(doc.id, {
//                 type: 'text',
//                 text: 'もう一度、元気か教えてくれる？🌸'
//             }, 'watch_reminder');
//             await doc.ref.set({
//                 watchService: {
//                     lastReminderAt: Timestamp.now()
//                 }
//             }, {
//                 merge: true
//             });
//         }
//     }
// }


// async function doEscalateAll(force = false) {
//     const users = await db.collection('users').where('watchService.awaitingReply', '==', true).get();
//     const now = dayjs().tz(JST_TZ);
//     for (const doc of users.docs) {
//         const user = doc.data();
//         const lastPingAt = dayjs(user.watchService.nextPingAt.toDate()).subtract(PING_INTERVAL_DAYS, 'day').tz(JST_TZ);
//         const lastReplyAt = user.lastMessageAt ? dayjs(user.lastMessageAt.toDate()).tz(JST_TZ) : null;
//         const lastReminderAt = user.watchService.lastReminderAt ? dayjs(user.watchService.lastReminderAt.toDate()).tz(JST_TZ) : null;

//         const shouldEscalate = force ||
//             (now.diff(lastPingAt, 'hour') >= ESCALATE_AFTER_HOURS && !lastReplyAt);

//         if (shouldEscalate) {
//             await notifyAdmin(doc.id, {
//                 type: 'escalation',
//                 text: `【緊急エスカレーション】\n${user.displayName}さんからの応答が${ESCALATE_AFTER_HOURS}時間ありません。`
//             });
//             await doc.ref.set({
//                 watchService: {
//                     awaitingReply: false
//                 }
//             }, {
//                 merge: true
//             });
//         }
//     }
// }

// async function notifyAdmin(userId, messages) {
//     if (!OFFICER_GROUP_ID) return console.warn('OFFICER_GROUP_ID is not set. Admin notifications disabled.');
//     await safePushMessage(OFFICER_GROUP_ID, messages, 'admin_notification');
// }

// async function handlePostbackEvent(event) {
//     const {
//         userId
//     } = event.source;
//     const {
//         data
//     } = event.postback;
//     const userRef = db.collection('users').doc(userId);
//     if (data === 'watch-start') {
//         await userRef.set({
//             watchService: {
//                 status: 'active'
//             }
//         }, {
//             merge: true
//         });
//         await safeReplyOrPush({
//             replyToken: event.replyToken,
//             userId,
//             messages: {
//                 type: 'text',
//                 text: '見守りサービスを開始しました。'
//             },
//             tag: 'watch-start'
//         });
//         await scheduleNextPing(userId);
//         return;
//     }
//     if (data === 'watch-stop') {
//         await userRef.set({
//             watchService: {
//                 status: 'inactive'
//             }
//         }, {
//             merge: true
//         });
//         await safeReplyOrPush({
//             replyToken: event.replyToken,
//             userId,
//             messages: {
//                 type: 'text',
//                 text: '見守りサービスを停止しました。'
//             },
//             tag: 'watch-stop'
//         });
//         return;
//     }
//     if (data === 'ping-reply') {
//         await userRef.set({
//             watchService: {
//                 awaitingReply: false
//             }
//         }, {
//             merge: true
//         });
//         await safeReplyOrPush({
//             replyToken: event.replyToken,
//             userId,
//             messages: {
//                 type: 'text',
//                 text: 'よかった😊 返信ありがとう💖'
//             },
//             tag: 'ping-reply'
//         });
//         await scheduleNextPing(userId);
//     }
// }


// async function handleUnfollowEvent(event) {
//     await db.collection('users').doc(event.source.userId).set({
//         unfollowedAt: Timestamp.now()
//     }, {
//         merge: true
//     });
//     console.log('User unfollowed:', event.source.userId);
// }

// async function handleFollowEvent(event) {
//     const userId = event.source.userId;
//     await db.collection('users').doc(userId).set({
//         followedAt: Timestamp.now(),
//         banned: firebaseAdmin.firestore.FieldValue.delete(),
//     }, {
//         merge: true
//     });

//     await safeReplyOrPush({
//         replyToken: event.replyToken,
//         userId,
//         messages: [{
//             type: 'text',
//             text: 'はじめまして！わたしは、こころちゃんです🌸\nみんなが安心して過ごせるように、いつでもお話を聞いているよ💖'
//         }],
//         tag: 'follow'
//     });
// }

// async function handleJoinEvent(event) {
//     const groupId = event.source.groupId;
//     console.log(`Joined group: ${groupId}`);
//     await safeReplyOrPush({
//         replyToken: event.replyToken,
//         userId: groupId,
//         messages: {
//             type: 'text',
//             text: '皆さん、はじめまして！わたしは、こころちゃんです🌸\nこのグループで、皆さんの心に寄り添い、安全を守るお手伝いをします。困ったことがあったら、いつでも話しかけてね💖'
//         },
//         tag: 'group_join'
//     });
// }

// async function handleLeaveEvent(event) {
//     console.log(`Left group: ${event.source.groupId}`);
// }

// async function handleGroupEvents(event) {
//     const groupId = event.source.groupId;
//     const eventType = event.type;
//     if (eventType === 'join') {
//         console.log(`Bot joined group: ${groupId}`);
//     } else if (eventType === 'leave') {
//         console.log(`Bot left group: ${groupId}`);
//     }
// }

// async function handleMemberEvents(event) {
//     const groupId = event.source.groupId;
//     const eventType = event.type;
//     const members = event.joined?.members || event.left?.members;
//     if (!members) return;
//     if (eventType === 'memberJoined') {
//         console.log(`Members joined group ${groupId}:`, members.map(m => m.userId));
//     } else if (eventType === 'memberLeft') {
//         console.log(`Members left group ${groupId}:`, members.map(m => m.userId));
//     }
// }


// async function handleCancel(event) {
//     const userId = event.source.userId;
//     await db.collection('users').doc(userId).update({
//         'account.status': 'cancel_requested'
//     });

//     const formUrl = prefillUrl(MEMBER_CANCEL_FORM_BASE_URL, {
//         [MEMBER_CANCEL_FORM_LINE_USER_ID_ENTRY_ID]: userId
//     });

//     const cancelFlex = {
//         type: "flex",
//         altText: "退会手続きのご案内",
//         contents: {
//             type: "bubble",
//             body: {
//                 type: "box",
//                 layout: "vertical",
//                 contents: [{
//                     type: "text",
//                     text: "退会手続き",
//                     weight: "bold",
//                     size: "xl"
//                 }, {
//                     type: "text",
//                     text: "退会をご希望いただき、ありがとうございます。以下のフォームからお手続きください。",
//                     wrap: true,
//                     margin: "md"
//                 }]
//             },
//             footer: {
//                 type: "box",
//                 layout: "vertical",
//                 contents: [{
//                     type: "button",
//                     style: "primary",
//                     action: {
//                         type: "uri",
//                         label: "退会フォームへ",
//                         uri: formUrl
//                     }
//                 }]
//             }
//         }
//     };

//     await safeReplyOrPush({
//         replyToken: event.replyToken,
//         userId,
//         messages: cancelFlex,
//         tag: 'cancel_flow'
//     });
// }

// app.listen(PORT, () => {
//     console.log(`Server is running on port ${PORT}`);
// });
