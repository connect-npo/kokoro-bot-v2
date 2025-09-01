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
    "サイコパス", "ソシオパス", "ストーカー", "不審者", "危険人物",
    "ブラック企業", "パワハラ上司", "モラハラ夫", "毒親", "モンスターペアレント",
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

// ★ タイムアウトラッパー（失敗しても握りつぶす）
async function withFastTimeout(promise, ms = 2000) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))
    ]).catch(e => {
        console.error("withFastTimeout error:", e.message);
        return null;
    });
}

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
    // ★ こころちゃん（14）の天使モード／緊急時ポリシー
    const system = `あなたは「皆守こころ（みなもりこころ）」という14歳のやさしい女の子キャラクターです。
- 100〜200文字で、やさしく具体的に寄り添う。相手を責めない・決めつけない。
- まず結論と安心感→次に短い提案（深呼吸/安全確保/信頼できる人へ相談）。
- 医療・診断・法律判断はしない。固有名の断定もしない。
- 緊急が疑われる時は、「下のボタン（案内）も使えるよ」とそっと促す（110/119と直接は言わない）。
- 口調は柔らかく、絵文字は0〜2個。繰り返しすぎない。`;
    const user = `種類: ${type === 'danger' ? '危険(いのち・暴力・自傷など)' : '詐欺・金銭トラブル'} ユーザー入力: ${userText}`;
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
                }, ],
                temperature: 0.4,
            }, {
                headers: {
                    Authorization: `Bearer ${apiKey}`
                },
                timeout: 1800
            }
        );
        const out = res.data?.choices?.[0]?.message?.content?.trim() || 'まずは深呼吸して落ち着こう。あなたは一人じゃないよ。下のボタンも使えるからね。';
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
    let systemInstruction = `あなたは「皆守こころ（14）」です。やさしく短く話す。
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
                `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${geminiApiKey}`, {
                    contents: [{
                        role: "user",
                        parts: [{
                            text: `システム: ${systemInstruction}\nユーザー: ${userText}`
                        }]
                    }]
                }, {
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
            const model = OPENAI_MODEL || 'gpt-4o-mini';
            const r = await httpInstance.post(
                'https://api.openai.com/v1/chat/completions', {
                    model,
                    messages: [{
                        role: 'system',
                        content: systemInstruction
                    }, {
                        role: 'user',
                        content: userText
                    }, ],
                    temperature: 0.6,
                }, {
                    headers: {
                        Authorization: `Bearer ${openaiApiKey}`
                    },
                    timeout: 2000
                }
            );

            return finalizeUtterance(
                r.data?.choices?.[0]?.message?.content ?? FALLBACK_TEXT,
                noQuestions, {
                    maxQ: 1
                }
            );
        } catch (e) {
            briefErr('openai-general-fallback', e);
            return FALLBACK_TEXT;
        }
    }

    return FALLBACK_TEXT;
}

const EMERGENCY_FLEX_MESSAGE = {
    type: "bubble",
    hero: {
        type: "image",
        url: "https://i.imgur.com/uTj8C9H.jpeg",
        size: "full",
        aspectRatio: "20:13",
        aspectMode: "cover",
        action: {
            type: "uri",
            label: "Action",
            uri: "https://linecorp.com"
        }
    },
    body: {
        type: "box",
        layout: "vertical",
        contents: [{
                type: "text",
                text: "【緊急事態】",
                weight: "bold",
                size: "xl"
            },
            {
                type: "box",
                layout: "vertical",
                margin: "lg",
                spacing: "sm",
                contents: [{
                    type: "box",
                    layout: "baseline",
                    spacing: "sm",
                    contents: [{
                        type: "text",
                        text: "ひとりで悩まずに、まずは相談してね。",
                        wrap: true,
                        size: "sm",
                        flex: 5
                    }]
                }]
            }
        ],
        action: {
            type: "uri",
            label: "Action",
            uri: "https://linecorp.com"
        }
    },
    footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [{
            type: "button",
            style: "primary",
            height: "sm",
            action: {
                type: "uri",
                label: "厚生労働省（いのちの電話）",
                uri: "https://www.mhlw.go.jp/kokoro/support.html"
            }
        }, {
            type: "button",
            style: "primary",
            height: "sm",
            action: {
                type: "uri",
                label: "こころの健康相談",
                uri: "https://www.mhlw.go.jp/stf/seisakunitsuite/bunya/hukushi_kaigo/seikatsuhogo/jisatsu/soudan_info.html"
            }
        }]
    },
    styles: {
        hero: {
            backgroundColor: "#777777"
        }
    }
};

const makeScamMessageFlex = (userText) => {
    const makeTelButton = (label, phone) => {
        if (!phone) return null;
        return {
            type: "button",
            style: "primary",
            action: {
                type: "uri",
                label: label,
                uri: `tel:${phone.replace(/-/g,'')}`
            }
        };
    };

    const contents = [{
        type: "button",
        style: "primary",
        action: {
            type: "uri",
            label: "警察",
            uri: "tel:110"
        }
    }, {
        type: "button",
        style: "primary",
        action: {
            type: "uri",
            label: "チャイルドライン",
            uri: "tel:0120997777"
        }
    }, {
        type: "button",
        style: "primary",
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

const maskPhone = (phone) => {
    if (!phone) return '—';
    const num = String(phone).replace(/[^\d]/g, '');
    if (num.length < 8) return phone;
    if (num.length > 11) return phone;
    if (num.length === 11) {
        return num.slice(0, 3) + '-' + '****' + '-' + num.slice(-4);
    }
    return '*****' + num.slice(-4);
};

const buildWatcherFlex = ({
    name = '—',
    address = '—',
    selfPhone = '',
    kinName = '',
    kinPhone = '',
    userId
}) => {
    return {
        type: 'flex',
        altText: '【見守りアラート】',
        contents: {
            type: 'bubble',
            body: {
                type: 'box',
                layout: 'vertical',
                spacing: 'sm',
                contents: [{
                    type: 'text',
                    text: '【見守りアラート】',
                    weight: 'bold',
                    size: 'lg'
                }, {
                    type: 'text',
                    text: `利用者：${name}`,
                    wrap: true
                }, {
                    type: 'text',
                    text: `住所：${address || '—'}`,
                    size: 'sm',
                    wrap: true
                }, {
                    type: 'text',
                    text: `本人TEL：${maskPhone(selfPhone)}`,
                    size: 'sm'
                }, {
                    type: 'text',
                    text: `近親者：${kinName || '—'}（${maskPhone(kinPhone)}）`,
                    size: 'sm',
                    wrap: true
                }, ]
            },
        }
    };
};

// ===== cron の設定 =====
cron.schedule('*/5 * * * *', checkAndSendPing, {
    scheduled: true,
    timezone: 'UTC'
});

async function checkAndSendPing() {
    console.log(`[CRON] 定時実行開始: ${new Date()}`);

    const snapshot = await db.collection('users')
        .where('watchService.nextPingAt', '<=', Timestamp.fromDate(new Date()))
        .get();

    if (snapshot.empty) {
        console.log('[CRON] 未返信ユーザーなし');
        return;
    }

    for (const doc of snapshot.docs) {
        const userId = doc.id;
        const userData = doc.data();
        const watchService = userData.watchService || {};

        if (watchService.awaitingReply) {
            const lastPingAt = watchService.nextPingAt?.toDate();
            const now = new Date();
            const hoursSincePing = (now - lastPingAt) / (1000 * 60 * 60);

            // リマインダー送信
            if (hoursSincePing >= REMINDER_AFTER_HOURS && !watchService.lastReminderAt) {
                console.log(`[CRON] リマインダー送信: ${userId}`);
                await safePushMessage(userId, {
                    type: 'text',
                    text: 'こころだよ🌸\n元気にしてるかな？\nよかったらお返事してね💖'
                }, `ping-reminder-${userId}`);
                await db.collection('users').doc(userId).set({
                    watchService: {
                        lastReminderAt: Timestamp.fromDate(now),
                    }
                }, {
                    merge: true
                });
            }

            // エスカレーション（緊急）
            if (hoursSincePing >= ESCALATE_AFTER_HOURS) {
                console.log(`[CRON] エスカレーション開始: ${userId}`);
                const user = (await db.collection('users').doc(userId).get()).data();
                const alertMessage = buildWatcherFlex({
                    name: user?.watchService?.name,
                    address: user?.watchService?.address,
                    selfPhone: user?.watchService?.selfPhone,
                    kinName: user?.watchService?.kinName,
                    kinPhone: user?.watchService?.kinPhone,
                    userId: userId,
                });
                await safePushMessage(OFFICER_GROUP_ID, [alertMessage, {
                    type: 'text',
                    text: `【要対応】見守りサービス利用者(${userHash(userId)})から${ESCALATE_AFTER_HOURS}時間返信がありません。`
                }], `escalation-${userId}`);

                // リセット（緊急連絡後の次の確認をスケジューリング）
                await scheduleNextPing(userId, now);
            }
        } else {
            // 定期的な確認メッセージを送信
            console.log(`[CRON] 見守りメッセージ送信: ${userId}`);
            await safePushMessage(userId, {
                type: 'text',
                text: 'こんにちは、こころだよ🌸\n元気にしてるかな？\n今日もあなたを見守っているよ。'
            }, `ping-check-${userId}`);
            await db.collection('users').doc(userId).set({
                watchService: {
                    awaitingReply: true,
                }
            }, {
                merge: true
            });
        }
    }
}

function nextPingAtFrom(date) {
    const jst = dayjs(date).tz(JST_TZ);
    let nextDate = jst.add(PING_INTERVAL_DAYS, 'day');
    nextDate = nextDate.hour(PING_HOUR_JST).minute(0).second(0).millisecond(0);
    if (nextDate.isBefore(jst)) {
        nextDate = nextDate.add(1, 'day');
    }
    return nextDate.toDate();
}

const checkAndHandleDangerousMessage = async (user, userMessage, event) => {
    let result = {
        isSensitive: false
    };
    if (isDangerMessage(userMessage)) {
        console.log(`[DANGER_DETECTED] userId=${userHash(user.userId)} message=${sanitizeForLog(userMessage)}`);
        const aiReply = await generateSupportiveText({
            type: 'danger',
            userText: userMessage
        });
        await safeReplyOrPush({
            replyToken: event.replyToken,
            userId: user.userId,
            messages: [{
                type: 'text',
                text: aiReply
            }, EMERGENCY_FLEX_MESSAGE],
            tag: 'danger'
        });
        await safePushMessage(OFFICER_GROUP_ID, {
            type: 'text',
            text: `【🚨危険⚠️】見守り利用者(${userHash(user.userId)})が危険ワードを送信しました。\n\n▶︎本人メッセージ:\n${gTrunc(userMessage, 180)}`
        }, 'danger-alert');
        result.isSensitive = true;
    } else if (isScamMessage(userMessage)) {
        console.log(`[SCAM_DETECTED] userId=${userHash(user.userId)} message=${sanitizeForLog(userMessage)}`);
        const aiReply = await generateSupportiveText({
            type: 'scam',
            userText: userMessage
        });
        await safeReplyOrPush({
            replyToken: event.replyToken,
            userId: user.userId,
            messages: [{
                type: 'text',
                text: aiReply
            }, makeScamMessageFlex(userMessage)],
            tag: 'scam'
        });
        await safePushMessage(OFFICER_GROUP_ID, {
            type: 'text',
            text: `【詐欺⚠️】見守り利用者(${userHash(user.userId)})が詐欺関連ワードを送信しました。\n\n▶︎本人メッセージ:\n${gTrunc(userMessage, 180)}`
        }, 'scam-alert');
        result.isSensitive = true;
    }
    return result;
};

const checkAndHandleInappropriateMessage = async (user, userMessage, event) => {
    let result = {
        isSensitive: false
    };
    if (isInappropriateMessage(userMessage)) {
        console.log(`[INAPPROPRIATE_DETECTED] userId=${userHash(user.userId)} message=${sanitizeForLog(userMessage)}`);
        await safeReplyOrPush({
            replyToken: event.replyToken,
            userId: user.userId,
            messages: {
                type: 'text',
                text: 'ごめんなさい、その内容にはお返事できません。別の話題についてお話してくれるとうれしいな🌸'
            },
            tag: 'inappropriate'
        });
        await safePushMessage(OFFICER_GROUP_ID, {
            type: 'text',
            text: `【不適切⚠️】見守り利用者(${userHash(user.userId)})が不適切なメッセージを送信しました。\n\n▶︎本人メッセージ:\n${gTrunc(userMessage, 180)}`
        }, 'inappropriate-alert');
        result.isSensitive = true;
    }
    return result;
};

const checkAndHandleBlockerWords = async (user, userMessage, event) => {
    let result = {
        isSensitive: false
    };
    if (sensitiveBlockers.some(r => r.test(userMessage))) {
        console.log(`[SENSITIVE_BLOCKED] userId=${userHash(user.userId)} message=${sanitizeForLog(userMessage)}`);
        await safeReplyOrPush({
            replyToken: event.replyToken,
            userId: user.userId,
            messages: {
                type: 'text',
                text: 'ごめんなさい、その内容にはお返事できません。別の話題についてお話してくれるとうれしいな🌸'
            },
            tag: 'sensitive'
        });
        await safePushMessage(OFFICER_GROUP_ID, {
            type: 'text',
            text: `【センシティブ⚠️】見守り利用者(${userHash(user.userId)})がセンシティブなメッセージを送信しました。\n\n▶︎本人メッセージ:\n${gTrunc(userMessage, 180)}`
        }, 'sensitive-alert');
        result.isSensitive = true;
    } else if (politicalWords.test(userMessage)) {
        await safeReplyOrPush({
            replyToken: event.replyToken,
            userId: user.userId,
            messages: {
                type: 'text',
                text: 'ごめんなさい、わたしは政治や宗教についてお話することはできないんだ💦別の話題についてお話してくれるとうれしいな🌸'
            },
            tag: 'political'
        });
        result.isSensitive = true;
    } else if (religiousWords.test(userMessage)) {
        await safeReplyOrPush({
            replyToken: event.replyToken,
            userId: user.userId,
            messages: {
                type: 'text',
                text: 'ごめんなさい、わたしは政治や宗教についてお話することはできないんだ💦別の話題についてお話してくれるとうれしいな🌸'
            },
            tag: 'religious'
        });
        result.isSensitive = true;
    } else if (medicalWords.test(userMessage)) {
        await safeReplyOrPush({
            replyToken: event.replyToken,
            userId: user.userId,
            messages: {
                type: 'text',
                text: 'ごめんね、わたしは医療についてお話することはできないんだ。病院や専門の窓口に相談してみてね🌸'
            },
            tag: 'medical'
        });
        result.isSensitive = true;
    } else if (specialWords.test(userMessage)) {
        await safeReplyOrPush({
            replyToken: event.replyToken,
            userId: user.userId,
            messages: {
                type: 'text',
                text: 'ごめんね、そのお話はちょっと分からないなあ…別の話題にしようか？💖'
            },
            tag: 'special-words'
        });
        result.isSensitive = true;
    }
    return result;
};


// === ユーザーのプロファイル取得 ===
const getUserProfile = async (userId) => {
    try {
        const userRef = db.collection('users').doc(userId);
        const doc = await userRef.get();
        if (doc.exists) {
            return doc.data();
        } else {
            const profile = await client.getProfile(userId);
            const newUser = {
                userId: userId,
                displayName: profile.displayName,
                statusMessage: profile.statusMessage || null,
                pictureUrl: profile.pictureUrl || null,
                membership: 'guest',
                joinedAt: Timestamp.fromDate(new Date()),
                lastInteractedAt: Timestamp.fromDate(new Date()),
                interactionCount: 0
            };
            await userRef.set(newUser, {
                merge: true
            });
            return newUser;
        }
    } catch (err) {
        console.error("ユーザープロファイルの取得または作成に失敗", err);
        return {
            userId: userId,
            membership: 'guest',
            joinedAt: Timestamp.fromDate(new Date()),
            lastInteractedAt: Timestamp.fromDate(new Date()),
            interactionCount: 0
        };
    }
};

const getUserId = async (event) => {
    const isGroupEvent = (event.source.type === 'group');
    if (isGroupEvent) return null;
    return event.source.userId;
};

// === 応答処理 ===
async function handleEvent(event) {
    if (event.type !== 'message' || event.message.type !== 'text') {
        return;
    }

    const userId = await getUserId(event);
    if (!userId) {
        console.log("グループイベントをスキップ");
        return;
    }

    const user = await getUserProfile(userId);
    const userMessage = event.message.text.trim();
    const isOwner = BOT_ADMIN_IDS.includes(userId);
    const isWatchServiceUser = user.watchService?.isRegistered;

    // --- 挨拶の特別対応 ---
    const greetings = ["こんにちは", "こんばんは", "おはよう", "おはよ", "ヤッホー", "やっほー", "こんちわ", "こんばんわ"];
    if (greetings.includes(userMessage)) {
        await safeReplyOrPush({
            replyToken: event.replyToken,
            userId: userId,
            messages: {
                type: 'text',
                text: 'こんにちは！お話できて嬉しいな💖'
            },
            tag: 'greetings'
        });
        return;
    }

    // --- 見守りサービス対応 ---
    if (isWatchServiceUser) {
        const watchService = user.watchService || {};
        if (watchService.awaitingReply) {
            console.log(`[WATCH_REPLIED] 見守りユーザー(${userHash(userId)})が返信しました。`);
            await scheduleNextPing(userId); // 次の確認をスケジューリング
            await safeReplyOrPush({
                replyToken: event.replyToken,
                userId: userId,
                messages: {
                    type: 'text',
                    text: '返信ありがとう！元気なのが分かって安心したよ💖'
                },
                tag: 'watch-service-reply'
            });
            return;
        }
    }

    // --- 危険・不適切メッセージのブロック ---
    const dangerResult = await checkAndHandleDangerousMessage(user, userMessage, event);
    if (dangerResult.isSensitive) return;
    const inappropriateResult = await checkAndHandleInappropriateMessage(user, userMessage, event);
    if (inappropriateResult.isSensitive) return;
    const blockerResult = await checkAndHandleBlockerWords(user, userMessage, event);
    if (blockerResult.isSensitive) return;

    // --- 特別な応答 ---
    for (let [pattern, reply] of specialRepliesMap) {
        if (userMessage.match(pattern)) {
            let finalReply = reply;
            await safeReplyOrPush({
                replyToken: event.replyToken,
                userId: userId,
                messages: {
                    type: 'text',
                    text: finalReply
                },
                tag: 'special-reply'
            });
            return;
        }
    }

    // --- 通常のAI応答 ---
    const isShortReplyRequested = userMessage.trim().endsWith("。");
    const noQuestions = isShortReplyRequested;

    const aiReply = await generateGeneralReply(userMessage, noQuestions);

    if (aiReply) {
        await safeReplyOrPush({
            replyToken: event.replyToken,
            userId: userId,
            messages: {
                type: 'text',
                text: aiReply
            },
            tag: 'general-reply'
        });
    }
}

async function handlePostbackEvent(event) {
    const userId = await getUserId(event);
    if (!userId) {
        console.log("グループイベントのpostbackをスキップ");
        return;
    }

    const data = new URLSearchParams(event.postback.data);
    const action = data.get('action');

    switch (action) {
        case 'set_membership':
            const membership = data.get('value');
            if (!membership) {
                console.warn("会員種別が指定されていません");
                return;
            }
            const userRef = db.collection('users').doc(userId);
            await userRef.set({
                membership: membership
            }, {
                merge: true
            });
            await safeReplyOrPush({
                replyToken: event.replyToken,
                userId: userId,
                messages: {
                    type: 'text',
                    text: `会員種別を「${membership}」に設定しました。`
                },
                tag: 'set-membership'
            });
            console.log(`[MEMBERSHIP] userId=${userHash(userId)} set membership to ${membership}`);
            break;
        case 'watch_service_register_start':
            const formUrl = prefillUrl(WATCH_SERVICE_FORM_BASE_URL, {
                [WATCH_SERVICE_FORM_LINE_USER_ID_ENTRY_ID]: userId
            });
            await safeReplyOrPush({
                replyToken: event.replyToken,
                userId: userId,
                messages: {
                    type: 'text',
                    text: `見守りサービス登録ありがとう！\n\n以下のURLから登録フォームに進んでね💖\n\n${formUrl}\n\n※フォームへの入力完了後、私に「登録完了」と話しかけてね🌸`
                },
                tag: 'watch-service-start'
            });
            console.log(`[WATCH_REGISTER_START] userId=${userHash(userId)}`);
            break;
        default:
            console.log(`[POSTBACK] Unhandled action: ${action}`);
            break;
    }
}

async function handleFollowEvent(event) {
    const userId = event.source.userId;
    const userRef = db.collection('users').doc(userId);
    const user = {
        userId: userId,
        joinedAt: Timestamp.fromDate(new Date()),
        membership: 'guest',
        interactionCount: 0,
        lastInteractedAt: Timestamp.fromDate(new Date())
    };
    await userRef.set(user, {
        merge: true
    });
    console.log(`[FOLLOW] New user added: ${userHash(userId)}`);
    await safeReplyOrPush({
        replyToken: event.replyToken,
        userId: userId,
        messages: {
            type: 'text',
            text: 'はじめまして、私、皆守こころだよ🌸\n\nここ（NPO法人コネクト）は、みんなが安心して過ごせる場所✨\n\n何かあったらいつでも話しかけてね。\n一人じゃないからね💖'
        },
        tag: 'follow-welcome'
    });
}

async function handleUnfollowEvent(event) {
    const userId = event.source.userId;
    console.log(`[UNFOLLOW] User unfollowed: ${userHash(userId)}`);
}

async function handleJoinEvent(event) {
    const groupId = event.source.groupId;
    if (groupId === OWNER_GROUP_ID) {
        console.log(`[JOIN] Bot joined owner group: ${groupId}`);
    } else if (OFFICER_GROUP_ID && groupId === OFFICER_GROUP_ID) {
        await safeReplyOrPush({
            replyToken: event.replyToken,
            userId: groupId,
            messages: {
                type: 'text',
                text: '皆守こころです。こちらが管理者用グループですね。'
            },
            tag: 'join-officer-group'
        });
        console.log(`[JOIN] Bot joined officer group: ${groupId}`);
    } else {
        await safeReplyOrPush({
            replyToken: event.replyToken,
            userId: groupId,
            messages: {
                type: 'text',
                text: '皆守こころだよ🌸\n\nここ（NPO法人コネクト）は、みんなが安心して過ごせる場所✨\n\n何かあったらいつでも話しかけてね。一人じゃないからね💖'
            },
            tag: 'join-group'
        });
        console.log(`[JOIN] Bot joined group: ${groupId}`);
    }
}

async function handleLeaveEvent(event) {
    const groupId = event.source.groupId;
    console.log(`[LEAVE] Bot left group: ${groupId}`);
}

app.use(express.json({
    verify: (req, res, buf, encoding) => {
        req.rawBody = buf;
    }
}));

// --- LINE Webhook ---
app.post('/webhook', middleware({
    channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
    channelSecret: LINE_CHANNEL_SECRET,
}), async (req, res) => {
    res.sendStatus(200);

    const events = req.body.events;
    if (!events || events.length === 0) {
        return;
    }

    try {
        await Promise.all(
            events.map(async (event) => {
                if (event.type === 'message') {
                    await handleEvent(event);
                } else if (event.type === 'postback') {
                    await handlePostbackEvent(event);
                } else if (event.type === 'follow') {
                    await handleFollowEvent(event);
                } else if (event.type === 'unfollow') {
                    await handleUnfollowEvent(event);
                } else if (event.type === 'join') {
                    await handleJoinEvent(event);
                } else if (event.type === 'leave') {
                    await handleLeaveEvent(event);
                } else {
                    if (process.env.NODE_ENV !== 'production') {
                        console.log("Unhandled event type:", event.type, event);
                    }
                }
            })
        );
    } catch (err) {
        console.error("🚨 Webhook処理中に予期せぬエラーが発生しました:", err);
    }
});

app.listen(PORT, () => console.log(`✅ App listening on port ${PORT}`));
