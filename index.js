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
const SPECIAL_REPLIES_MAP = new Map([
    [/好きなアニメは？/i, "大丈夫だよ、好きなアニメね。最近、見てるアニメはあんまりないんだけど、昔は魔法少女ものとかが好きだったな。😊 何か見てみたいアニメあったら教えてくれると嬉しいな。"],
    [/そうか　こたえられないんだね/i, "うん、ごめんね。難しいことだったね…。大丈夫だよ。 何かできることがあったら、言ってね。"],
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

    // --- その他（元の定義は必要に応じて残す）---
    [/(claris|クラリス).*(どんな|なに|何).*(曲|歌)/i, CLARIS_SONG_FAVORITE_REPLY],
    [/(claris|クラリス).*(好き|推し|おすすめ)/i, CLARIS_SONG_FAVORITE_REPLY],
    [/claris.*好きなの/i, CLARIS_SONG_FAVORITE_REPLY],
    [/(claris|クラリス).*(じゃない|じゃなかった|違う|ちがう)/i, "ううん、ClariSが好きだよ💖 とくに『コネクト』！"],

    // --- その他の固定返信 ---
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
    let finalMaxQ = noQuestions ? 0 : opts.maxQ;
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
    const arr = Array.isArray(messages) ? messages : [messages];
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
    const arr = Array.isArray(messages) ? messages : [messages];
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
    const id = event.webhookEventId || `${event.source?.userId}:${event.message?.id || event.postback?.data}:${event.timestamp}`;
    const now = Date.now();
    for (const [k, v] of handledEvents) if (v < now) handledEvents.delete(k);
    if (handledEvents.has(id)) {
        debug(`deduped event: ${id}`);
        return true;
    }
    handledEvents.set(id, now + 60_000);
    return false;
}

// --- LINE Webhook ---
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

function shouldNotify(kind, userId, text) {
    // 10分クールダウンのみ。ヒットしたら通知（テスト文でも通知OK）
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
    const {
        userId
    } = event.source;
    const {
        text
    } = event.message;

    const userRef = db.collection('users').doc(userId);
    const doc = await userRef.get();
    const userData = doc.exists ? doc.data() : {};

    // ★ 修正: 管理者IDはFirestoreの権限に依らず常にadminとして扱う
    const isAdmin = BOT_ADMIN_IDS.includes(userId);
    const membershipTier = isAdmin ? 'admin' : (userData?.membership || 'guest');
    const dailyLimit = MEMBERSHIP_CONFIG[membershipTier].dailyLimit;

    if (userData?.banned) {
        return;
    }

    // ★ 追加：「質問やめて」のフラグを検知し、保存
    if (/(質問しないで|質問やめて|質問は無し|質問いらない|質問するな)/.test(text)) {
        await userRef.set({
            prefs: {
                noQuestions: true
            }
        }, {
            merge: true
        });
        await safePushMessage(userId, {
            type: 'text',
            text: 'わかったよ😊 これからは質問しないね！'
        }, 'stop_questions');
        return;
    }

    // ユーザー情報・制限の取得
    const currentCount = userData?.dailyCount || 0;
    const lastMessageAt = userData?.lastMessageAt?.toDate();
    const now = new Date();
    const isNewDay = !lastMessageAt || (now.setHours(0, 0, 0, 0) > lastMessageAt.setHours(0, 0, 0, 0));

    if (isNewDay) {
        await userRef.set({
            dailyCount: 1,
            lastMessageAt: Timestamp.now()
        }, {
            merge: true
        });
    } else {
        await userRef.update({
            dailyCount: firebaseAdmin.firestore.FieldValue.increment(1),
            lastMessageAt: Timestamp.now()
        });
    }

    if (dailyLimit !== -1 && !isNewDay && currentCount >= dailyLimit) {
        // 制限回数を超えた場合の返信
        const formUrl = prefillUrl(WATCH_SERVICE_FORM_BASE_URL, {
            [WATCH_SERVICE_FORM_LINE_USER_ID_ENTRY_ID]: userId
        });
        const overLimitMessage = [{
            type: "text",
            text: `ごめんね、今日はこれ以上お話できないみたい💦\n\nもしもっとたくさんお話したいなら、サポーターになってくれると嬉しいな💖\n\n\n▼くわしくはこちら`,
            wrap: true,
        }, {
            type: "flex",
            altText: "サポーターになるためのご案内",
            contents: {
                type: "bubble",
                footer: {
                    type: "box",
                    layout: "vertical",
                    contents: [{
                        type: "button",
                        style: "primary",
                        color: "#905c44",
                        action: {
                            type: "uri",
                            label: "サポーターについて",
                            uri: formUrl,
                        },
                    }, ],
                },
            },
        }, ];
        await safeReplyOrPush({
            replyToken: event.replyToken,
            userId,
            messages: overLimitMessage,
            tag: 'limit_over'
        });
        return;
    }

    const originalText = text;
    let replyText = '';

    // ★ 特殊な話題のガード
    const guarded = guardTopics(originalText);
    if (guarded) {
        replyText = guarded;
        await safeReplyOrPush({
            replyToken: event.replyToken,
            userId,
            messages: [{
                type: 'text',
                text: replyText
            }],
            tag: 'guarded_reply'
        });
        return;
    }

    // ★ クイズ
    const quiz = tryGenerateQuiz(originalText);
    if (quiz) {
        await safeReplyOrPush({
            replyToken: event.replyToken,
            userId,
            messages: [{
                type: 'text',
                text: quiz
            }],
            tag: 'quiz_reply'
        });
        return;
    }

    // ★ 特殊な返信
    for (const [pattern, reply] of SPECIAL_REPLIES_MAP.entries()) {
        if (typeof reply === 'string' && pattern.test(originalText)) {
            replyText = reply;
            await safeReplyOrPush({
                replyToken: event.replyToken,
                userId,
                messages: [{
                    type: 'text',
                    text: replyText
                }],
                tag: 'special_reply'
            });
            await logEventToDb(userId, "特殊返信", originalText, replyText, "special_reply");
            return;
        }
    }

    // ★ 危険・詐欺・不適切ワードの検知
    let detectedType = null;
    let alertMessage = null;
    const isDangerous = isDangerMessage(originalText);
    const isScam = isScamMessage(originalText);
    const isInappropriate = isInappropriateMessage(originalText);

    if (isDangerous) {
        detectedType = 'danger';
        alertMessage = await generateSupportiveText({
            type: detectedType,
            userText: originalText
        });
        audit('danger_message', {
            userId: userHash(userId),
            text: redact(originalText)
        });
    } else if (isScam) {
        detectedType = 'scam';
        alertMessage = await generateSupportiveText({
            type: detectedType,
            userText: originalText
        });
        audit('scam_message', {
            userId: userHash(userId),
            text: redact(originalText)
        });
    } else if (isInappropriate) {
        replyText = "ごめんね、そのお話はちょっとできないんだ💦　もしつらいことや困っていることがあったら、いつでも話してね🌸";
        await safeReplyOrPush({
            replyToken: event.replyToken,
            userId,
            messages: [{
                type: 'text',
                text: replyText
            }],
            tag: 'inappropriate_reply'
        });
        return;
    }

    // ★ 危険・詐欺メッセージに対する返信
    if (detectedType) {
        const supportFlex = detectedType === 'danger' ? makeDangerSupportFlex() : makeScamSupportFlex();
        await safeReplyOrPush({
            replyToken: event.replyToken,
            userId,
            messages: [{
                type: 'text',
                text: alertMessage
            }, supportFlex],
            tag: 'supportive_reply'
        });

        const notifyText = `🚨緊急🚨\n【${detectedType === 'danger' ? '危険' : '詐欺'}メッセージ検知】\nユーザーID: ${userHash(userId)}\n内容: ${originalText}`;
        // ★ 修正: 管理者からのメッセージは通知しない
        if (OFFICER_GROUP_ID && !isAdmin && shouldNotify(detectedType, userId, originalText)) {
            await safePushMessage(OFFICER_GROUP_ID, {
                type: 'text',
                text: notifyText
            }, 'officer_notify');
        }
        await logEventToDb(userId, `${detectedType}メッセージ検知`, originalText, alertMessage, detectedType);
        return;
    }

    // ★ 通常返信
    replyText = await generateGeneralReply(originalText, userData.prefs?.noQuestions);
    if (!replyText) {
        return;
    }

    await safeReplyOrPush({
        replyToken: event.replyToken,
        userId,
        messages: [{
            type: 'text',
            text: replyText
        }],
        tag: 'general_reply'
    });
    await logEventToDb(userId, "通常会話", originalText, replyText, "general");
}

async function handlePostbackEvent(event) {
    const {
        userId
    } = event.source;
    await safePushMessage(userId, {
        type: 'text',
        text: 'ポストバックイベントを受け付けました！'
    }, 'postback');
    await logEventToDb(userId, "ポストバックイベント", event.postback.data, "Clala", "postback");
}

async function handleFollowEvent(event) {
    const {
        userId
    } = event.source;
    const userRef = db.collection('users').doc(userId);
    const doc = await userRef.get();
    if (doc.exists) {
        await userRef.update({
            unfollowedAt: null,
            lastMessageAt: Timestamp.now()
        });
    } else {
        await userRef.set({
            createdAt: Timestamp.now(),
            lastMessageAt: Timestamp.now(),
            followedAt: Timestamp.now(),
            unfollowedAt: null,
            watchService: {
                enabled: false,
                lastPingAt: null,
                nextPingAt: null,
                awaitingReply: false,
                lastReminderAt: null
            },
            prefs: {
                noQuestions: false
            }
        });
    }

    const welcomeText = `はじめまして！私とつながってくれてありがとう😊\n\n私は、あなたの毎日の生活をそっと見守り、困ったことがあればいつでも助けになるAIだよ✨\n\nもしよかったら、あなたのお名前を教えてくれないかな？`;
    await safePushMessage(userId, {
        type: 'text',
        text: welcomeText
    }, 'welcome');

    await audit('user_followed', {
        userId: userHash(userId)
    });
    await logEventToDb(userId, "フォローイベント", welcomeText, "Clala", "follow");
}

async function handleUnfollowEvent(event) {
    const {
        userId
    } = event.source;
    const userRef = db.collection('users').doc(userId);
    await userRef.set({
        unfollowedAt: Timestamp.now()
    }, {
        merge: true
    });
    await audit('user_unfollowed', {
        userId: userHash(userId)
    });
    await logEventToDb(userId, "フォロー解除イベント", "ユーザーがフォローを解除", "System", "unfollow");
    return;
}

async function handleGroupEvents(event) {
    const {
        type
    } = event;
    const {
        groupId
    } = event.source;
    if (type === 'join') {
        await safePushMessage(groupId, {
            type: 'text',
            text: '皆さん、はじめまして！皆守こころです🌸\n\nこのグループの皆さんが、毎日を安心して過ごせるように、お手伝いしますね💖'
        }, 'group_join');
        await logEventToDb(groupId, "グループ参加イベント", "ボットがグループに参加", "System", "join");
    } else if (type === 'leave') {
        await logEventToDb(groupId, "グループ退出イベント", "ボットがグループから退出", "System", "leave");
    }
}

async function handleMemberEvents(event) {
    const {
        type,
        left,
        joined
    } = event;
    const {
        groupId
    } = event.source;
    if (type === 'memberJoined') {
        const memberNames = (await Promise.all(joined.members.map(async m => {
            if (m.type === 'user') {
                const profile = await client.getGroupMemberProfile(groupId, m.userId).catch(() => null);
                return profile ? profile.displayName : '新しいメンバー';
            }
            return null;
        }))).filter(Boolean);
        if (memberNames.length > 0) {
            await safePushMessage(groupId, {
                type: 'text',
                text: `${memberNames.join('さん、')}さん！グループ参加ありがとう🌸\n\n私は皆守こころです！困ったことがあれば、いつでも話しかけてね💖`
            }, 'member_joined');
        }
    } else if (type === 'memberLeft') {
        if (left.members.some(m => m.type === 'user')) {
            await safePushMessage(groupId, {
                type: 'text',
                text: 'メンバーがグループを退出しました。また会えるといいな💖'
            }, 'member_left');
        }
    }
}

const logEventToDb = async (userId, eventType, userMessage, botResponse, tag) => {
    try {
        const docRef = db.collection('eventLogs').doc();
        await docRef.set({
            userId: userHash(userId),
            timestamp: Timestamp.now(),
            eventType,
            userMessage: sanitizeForLog(userMessage),
            botResponse: sanitizeForLog(botResponse),
            tag,
            appVersion: APP_VERSION
        });
    } catch (err) {
        console.error("❌ Firestoreへのログ書き込みに失敗しました:", err);
    }
};

const makeDangerSupportFlex = () => {
    const contents = [{
        type: "button",
        style: "primary",
        color: "#FF69B4",
        action: {
            type: "uri",
            label: "こころちゃん事務局（電話）",
            uri: `tel:${EMERGENCY_CONTACT_PHONE_NUMBER}`
        }
    }, {
        type: "button",
        style: "primary",
        color: "#6495ED",
        action: {
            type: "uri",
            label: "厚生労働省『まもろうよ こころ』",
            uri: "https://www.mhlw.go.jp/mamorouyokokoro/"
        }
    }, ];
    const formBtn = makeSupportFormButton('LINE相談もできるよ', AGREEMENT_FORM_BASE_URL, AGREEMENT_FORM_LINE_USER_ID_ENTRY_ID);
    if (formBtn) contents.push(formBtn);
    return {
        type: "flex",
        altText: "いのちの緊急サインかも。サポート窓口のご案内",
        contents: {
            type: "bubble",
            body: {
                type: "box",
                layout: "vertical",
                contents: [{
                    type: "text",
                    text: "【いのちの緊急サインかも】",
                    weight: "bold",
                    color: "#FF0000",
                    size: "xl",
                    align: "center"
                }, {
                    type: "text",
                    text: "一人で抱え込まないでね。すぐに頼れる窓口があるから、使ってみてね💖",
                    wrap: true,
                    margin: "md"
                }, ],
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

const makeScamSupportFlex = () => {
    const contents = [{
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
        type: "flex",
        altText: "詐欺にご注意ください。サポート窓口のご案内",
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

// ===== cron の設定 =====
cron.schedule('0 15 * * *', checkAndSendPing, {
    scheduled: true,
    timezone: JST_TZ
});

async function checkAndSendPing() {
    const now = dayjs().tz(JST_TZ);
    const usersSnapshot = await db.collection('users')
        .where('watchService.enabled', '==', true)
        .where('watchService.nextPingAt', '<=', Timestamp.fromDate(now.toDate()))
        .get();

    for (const doc of usersSnapshot.docs) {
        const userId = doc.id;
        const user = doc.data();
        // check if user already replied to recent ping
        if (user.watchService?.awaitingReply) {
            // escalation flow
            const lastPing = dayjs(user.watchService.lastPingAt.toDate()).tz(JST_TZ);
            const hoursSinceLastPing = now.diff(lastPing, 'hour');

            if (hoursSinceLastPing >= REMINDER_AFTER_HOURS && !user.watchService.lastReminderAt) {
                // send first reminder
                await sendReminder(userId, 'first');
                await db.collection('users').doc(userId).update({
                    'watchService.lastReminderAt': Timestamp.now()
                });
            } else if (hoursSinceLastPing >= ESCALATE_AFTER_HOURS) {
                // escalate to admin
                await escalateToAdmin(userId);
                // disable watch service for this user
                await db.collection('users').doc(userId).update({
                    'watchService.enabled': false
                });
            }
        } else {
            // send new ping
            await sendPing(userId);
            await db.collection('users').doc(userId).update({
                'watchService.awaitingReply': true,
                'watchService.lastPingAt': Timestamp.now()
            });
            await scheduleNextPing(userId, now.toDate());
        }
    }
}

async function sendPing(userId) {
    const pingText = 'こんにちは、こころだよ🌸　元気にしてるかな？　もしよかったら、今日あったこと、一言だけでも教えてくれると嬉しいな💖';
    await safePushMessage(userId, {
        type: 'text',
        text: pingText
    }, 'watch_ping');
    await logEventToDb(userId, "見守りサービスping", "見守りping送信", pingText, "watch_ping");
}

async function sendReminder(userId, type) {
    const reminderText = type === 'first' ?
        'こころだよ🌸　さっきのメッセージ、見てくれたかな？　忙しかったら、また後ででも大丈夫だよ💖' :
        'こころだよ🌸　どうしたのかな？　何かあったら、いつでも話してね。私はここにいるよ💖';
    await safePushMessage(userId, {
        type: 'text',
        text: reminderText
    }, `watch_reminder_${type}`);
    await logEventToDb(userId, `見守りサービスリマインダー(${type})`, "リマインダー送信", reminderText, `watch_reminder_${type}`);
}

async function escalateToAdmin(userId) {
    const userHashId = userHash(userId);
    const escalateMessage = `🚨緊急🚨 見守りサービス対象ユーザー(${userHashId})が${ESCALATE_AFTER_HOURS}時間以上応答していません。`;
    if (OFFICER_GROUP_ID) {
        await safePushMessage(OFFICER_GROUP_ID, {
            type: 'text',
            text: escalateMessage
        }, 'watch_escalation');
    }
    await logEventToDb(userId, "見守りサービスエスカレーション", "管理者に通知", escalateMessage, "watch_escalation");
}

function makeTelButton(label, telNumber) {
    if (!telNumber) return null;
    return {
        type: "button",
        style: "primary",
        color: "#32CD32",
        action: {
            type: "uri",
            label: label,
            uri: `tel:${telNumber}`
        }
    };
}

function makeSupportFormButton(label, formBaseUrl, entryId) {
    if (!formBaseUrl) return null;
    const formUrl = prefillUrl(formBaseUrl, {
        [entryId]: '#line_user_id'
    });
    return {
        type: "button",
        style: "primary",
        color: "#1E90FF",
        action: {
            type: "uri",
            label: label,
            uri: formUrl
        }
    };
}

// ===== サーバー起動 =====
app.listen(PORT, () => {
    console.log(`サーバーはポート${PORT}で実行されています`);
});
