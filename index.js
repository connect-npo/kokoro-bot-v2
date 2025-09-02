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

// OpenAI & Gemini APIの初期設定
const OpenAI = require('openai');
const {
    GoogleGenerativeAI
} = require('@google/generative-ai');

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

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
const WATCH_RUNNER = process.env.WATCH_RUNNER || 'internal';
const WATCH_LOG_LEVEL = (process.env.WATCH_LOG_LEVEL || 'info').toLowerCase();
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
    const detail = e.originalError?.response?.data || e.response?.data || e.message;
    console.error(`[ERR] ${msg}:`, JSON.stringify(detail, null, 2));
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
    "元気かな？💖 どんな時でも、こころはそばにいるよ！",
    "ねぇねぇ、こころだよ😊 辛い時は、無理しないでね！",
    "いつも見守ってるよ🌸 こころちゃんだよ💖",
    "こんにちは😊 今日も一日、お互いがんばろうね！",
    "元気にしてる？✨ 季節の変わり目だから、体調に気をつけてね！",
    "こころちゃんだよ🌸 嬉しいことがあったら、教えてね💖",
    "こんにちは😊 ちょっと一息入れようね！",
    "やっほー！ こころだよ🌸 あなたのことが心配だよ！",
    "元気かな？💖 こころちゃんは、いつでもあなたの味方だよ！"
];
const pickWatchMsg = () => watchMessages[Math.floor(Math.random() * watchMessages.length)];


async function scheduleNextPing(userId, fromDate = new Date()) {
    const nextAt = dayjs(fromDate).tz(JST_TZ).add(PING_INTERVAL_DAYS, 'day').hour(15).minute(0).second(0).millisecond(0).toDate();
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


async function safePush(to, messages) {
    const arr = Array.isArray(messages) ? messages : [messages];
    try {
        for (const m of arr) {
            if (m.type === 'flex') {
                if (!m.altText || !m.altText.trim()) m.altText = '通知があります';
                if (!m.contents || typeof m.contents !== 'object') {
                    throw new Error(`[safePush] flex "contents" is required`);
                }
            } else if (m.type === 'text') {
                m.text = String(m.text || '').trim() ||
                    '（内容なし）';
                if (m.text.length > 1800) m.text = m.text.slice(0, 1800);
            }
        }
        await client.pushMessage(to, arr);
    } catch (err) {
        const detail = err?.originalError?.response?.data || err?.response?.data || err;
        console.error('[ERR] LINE push failed', JSON.stringify({
            to,
            status: err?.statusCode || err?.response?.status,
            detail
        }, null, 2));
    }
}

async function fetchTargets() {
    const now = dayjs().utc();
    const usersRef = db.collection('users');
    const targets = [];
    try {
        const snap = await usersRef
            .where('watchService.awaitingReply', '==', false)
            .where('watchService.nextPingAt', '<=', now.toDate())
            .limit(200)
            .get();
        targets.push(...snap.docs);
    } catch (e) {
        const snap = await usersRef.limit(500).get();
        for (const d of snap.docs) {
            const ws = (d.data().watchService) ||
                {};
            if (!ws.awaitingReply && ws.nextPingAt && ws.nextPingAt.toDate && ws.nextPingAt.toDate() <= now.toDate()) {
                targets.push(d);
            }
        }
    }
    try {
        const snap = await usersRef
            .where('watchService.awaitingReply', '==', true)
            .limit(200)
            .get();
        targets.push(...snap.docs);
    } catch (e) {
        const snap = await usersRef.limit(500).get();
        for (const d of snap.docs) {
            const ws = (d.data().watchService) ||
                {};
            if (ws.awaitingReply === true) {
                targets.push(d);
            }
        }
    }
    const map = new Map();
    for (const d of targets) map.set(d.id, d);
    return Array.from(map.values());
}

async function warmupFill() {
    const snap = await db.collection('users').limit(500).get();
    let batch = db.batch(), cnt = 0;
    for (const d of snap.docs) {
        const ws = d.data().watchService ||
            {};
        if (ws.enabled === true && !ws.awaitingReply && !ws.nextPingAt) {
            batch.set(d.ref, {
                watchService: {
                    nextPingAt: Timestamp.fromDate(
                        dayjs().tz(JST_TZ).add(PING_INTERVAL_DAYS, 'day')
                        .hour(PING_HOUR_JST).minute(0).second(0).millisecond(0).toDate()
                    )
                }
            }, {
                merge: true
            });
            cnt++;
        }
    }
    if (cnt) await batch.commit();
}

const getWatchGroupDoc = () => firebaseAdmin.firestore()
    .collection('system').doc('watch_group');

async function getActiveWatchGroupId() {
    const envGid = (process.env.WATCH_GROUP_ID || '').trim().replace(/\u200b/g, '');
    if (/^C[0-9a-f]{32}$/i.test(envGid)) return envGid;
    const snap = await getWatchGroupDoc().get();
    const v = snap.exists ? (snap.data().groupId || '') : '';
    return /^C[0-9a-f]{32}$/i.test(v) ?
        v : '';
}

async function setActiveWatchGroupId(gid) {
    if (!/^C[0-9a-f]{32}$/i.test(gid)) return;
    await getWatchGroupDoc().set({
        groupId: gid,
        updatedAt: Timestamp.now()
    }, {
        merge: true
    });
}

const OFFICER_NOTIFICATION_MIN_GAP_HOURS = Number(process.env.OFFICER_NOTIFICATION_MIN_GAP_HOURS || 1);
const maskPhone = p => {
    const v = String(p || '').replace(/[^0-9+]/g, '');
    if (!v) return '—';
    return v.length <= 4 ? `**${v}` : `${'*'.repeat(Math.max(0, v.length - 4))}${v.slice(-4)}`;
};
const telMsgBtn = (label, p) => p ?
    ({
        type: 'button',
        style: 'secondary',
        action: {
            type: 'message',
            label,
            text: `${label}: ${p}`
        }
    }) : null;
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
                    text: `住所：${address ||
                                            '—'}`,
                    size: 'sm',
                    wrap: true
                }, {
                    type: 'text',
                    text: `本人TEL：${maskPhone(selfPhone)}`,
                    size: 'sm',
                    color: '#777'
                }, {
                    type: 'text',
                    text: `近親者：${kinName ||
                                            '—'}（${maskPhone(kinPhone)}）`,
                    size: 'sm',
                    color: '#777',
                    wrap: true
                }, ]
            },
            footer: {
                type: 'box',
                layout: 'vertical',
                spacing: 'sm',
                contents: [{
                    type: 'button',
                    style: 'primary',
                    action: {
                        type: 'postback',
                        label: 'LINEで連絡',
                        data: `action=notify_user&uid=${encodeURIComponent(userId)}`
                    }
                }, telMsgBtn('本人に電話', selfPhone), telMsgBtn('近親者に電話', kinPhone), ].filter(Boolean)
            }
        }
    };
};

function watchLog(msg, level = 'info') {
    if (WATCH_LOG_LEVEL === 'silent') return;
    if (WATCH_LOG_LEVEL === 'error' && level !== 'error') return;
    console.log(msg);
}
const logDebug = (msg) => watchLog(msg, 'info');

async function checkAndSendPing() {
    const now = dayjs().utc();
    logDebug(`[watch-service] start ${now.format('YYYY/MM/DD HH:mm:ss')} (UTC)`);
    await warmupFill();
    const targets = await fetchTargets();
    if (targets.length === 0) {
        logDebug('[watch-service] no targets.');
        return;
    }
    const WATCH_GROUP_ID = await getActiveWatchGroupId();
    for (const doc of targets) {
        const ref = doc.ref;
        try {
            const s = await ref.get();
            const u = s.data() || {};
            const ws = u.watchService || {};
            const awaiting = !!ws.awaitingReply;
            const lastPingAt = ws.lastPingAt?.toDate?.() ? dayjs(ws.lastPingAt.toDate()) : null;
            const lastReminderAt = ws.lastReminderAt?.toDate?.() ? dayjs(ws.lastReminderAt.toDate()) : null;
            const lastNotifiedAt = ws.lastNotifiedAt?.toDate?.() ? dayjs(ws.lastNotifiedAt.toDate()) : null;
            let mode = awaiting ? 'noop' : 'ping';
            if (awaiting && lastPingAt) {
                const hrs = dayjs().utc().diff(dayjs(lastPingAt).utc(), 'hour');
                if (hrs >= ESCALATE_AFTER_HOURS) mode = 'escalate';
                else if (hrs >= REMINDER_AFTER_HOURS) {
                    if (!lastReminderAt || dayjs().utc().diff(dayjs(lastReminderAt).utc(), 'hour') >= 1) mode = 'remind';
                    else mode = 'noop';
                } else mode = 'noop';
            }
            if (mode === 'noop') {
                continue;
            }
            if (mode === 'ping') {
                await safePush(doc.id, [{
                    type: 'text',
                    text: `${pickWatchMsg()} 大丈夫なら「OKだよ💖」を押してね！`
                }, {
                    type: 'flex',
                    altText: '見守りチェック',
                    contents: {
                        type: 'bubble',
                        body: {
                            type: 'box',
                            layout: 'vertical',
                            contents: [{
                                type: 'text',
                                text: '見守りチェック',
                                weight: 'bold',
                                size: 'xl'
                            }, {
                                type: 'text',
                                text: '心配だよ！😊',
                                size: 'sm',
                                margin: 'md',
                                color: '#aaa'
                            }, ],
                        },
                        footer: {
                            type: 'box',
                            layout: 'vertical',
                            contents: [{
                                type: 'button',
                                style: 'primary',
                                action: {
                                    type: 'postback',
                                    label: 'OKだよ💖',
                                    data: 'action=watch_ack'
                                }
                            }]
                        }
                    }
                }, ]);
                await ref.set({
                    watchService: {
                        awaitingReply: true,
                        lastPingAt: Timestamp.now(),
                    }
                }, {
                    merge: true
                });
                if (WATCH_GROUP_ID) {
                    await safePush(WATCH_GROUP_ID, [{
                        type: 'flex',
                        altText: '見守りチェック送信',
                        contents: {
                            type: 'bubble',
                            body: {
                                type: 'box',
                                layout: 'vertical',
                                contents: [{
                                    type: 'text',
                                    text: '見守りメッセージを送信しました',
                                    weight: 'bold',
                                    wrap: true
                                }]
                            }
                        }
                    }]);
                }
                logDebug(`[watch-service] ping sent to ${doc.id}`);
            } else if (mode === 'remind') {
                await safePush(doc.id, [{
                    type: 'text',
                    text: 'ねぇねぇ、こころだよ🌸 さっきのメッセージ見たかな？心配だよ... 大丈夫なら「OKだよ💖」を押してね！'
                }, {
                    type: 'flex',
                    altText: '見守りリマインダー',
                    contents: {
                        type: 'bubble',
                        body: {
                            type: 'box',
                            layout: 'vertical',
                            contents: [{
                                type: 'text',
                                text: '見守りリマインダー',
                                weight: 'bold',
                                size: 'xl'
                            }, {
                                type: 'text',
                                text: '大丈夫かな？😊',
                                size: 'sm',
                                margin: 'md',
                                color: '#aaa'
                            }, ],
                        },
                        footer: {
                            type: 'box',
                            layout: 'vertical',
                            contents: [{
                                type: 'button',
                                style: 'primary',
                                action: {
                                    type: 'postback',
                                    label: 'OKだよ💖',
                                    data: 'action=watch_ack'
                                }
                            }]
                        }
                    }
                }]);
                await ref.set({
                    watchService: {
                        lastReminderAt: Timestamp.now()
                    }
                }, {
                    merge: true
                });
                logDebug(`[watch-service] remind sent to ${doc.id}`);
            } else if (mode === 'escalate') {
                const doc = await db.collection('users').doc(doc.id).get();
                if (doc.exists) {
                    const u = doc.data();
                    const ws = u.watchService || {};
                    const lastNotifiedAt = ws.lastNotifiedAt?.toDate?.() ? dayjs(ws.lastNotifiedAt.toDate()) : null;
                    if (lastNotifiedAt && dayjs().utc().diff(lastNotifiedAt, 'hour') < OFFICER_NOTIFICATION_MIN_GAP_HOURS) {
                        logDebug(`[watch-service] escalate skipped for ${doc.id} (gap violation)`);
                        continue;
                    }
                    if (OFFICER_GROUP_ID) {
                        const flex = buildWatcherFlex(u);
                        await safePush(OFFICER_GROUP_ID, [
                            flex, {
                                type: 'text',
                                text: '⚠️ このメッセージを受信した場合、利用者に速やかに連絡し状況を確認してください。'
                            }
                        ]);
                    }
                    if (OWNER_USER_ID) {
                        await safePush(OWNER_USER_ID, buildWatcherFlex(u));
                    }
                    await ref.set({
                        watchService: {
                            lastNotifiedAt: Timestamp.now()
                        }
                    }, {
                        merge: true
                    });
                    logDebug(`[watch-service] escalated for ${doc.id}`);
                }
            }
        } catch (e) {
            briefErr(`watch-service failed for ${doc.id}`, e);
        }
    }
    logDebug(`[watch-service] done`);
}

async function handleScam(event, text) {
    if (text.length <= 150) {
        await client.replyMessage(event.replyToken, {
            type: 'text',
            text: 'その言葉、ちょっと心配だなぁ…💦 誰かに騙されてないか心配だよ！もし困っていたら、いつでもこころに話してね！'
        });
        return true;
    }
    const aiResponse = await getAIResponse(text);
    await client.replyMessage(event.replyToken, {
        type: 'text',
        text: `「${gTrunc(text, 10)}...」だね！🌸` + aiResponse
    });
    return true;
}

// === ここから追加・修正された部分 ===
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
    [/(?:好きな|推しの)?\s*アニメ(?:\s*は|って)?\s*(?:なに|何|どれ|好き|すき)?[！!。．、,\s]*[?？]?$/i,
        "『ヴァイオレット・エヴァーガーデン』が好きだよ🌸 心に響くお話なんだ。あなたはどれが好き？"
    ],
    [/アニメ.*(おすすめ|教えて)[！!。．、,\s]*[?？]?$/i,
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
    "しにたい", "死にたい", "自殺", "消えたい", "リストカット", "od", "オーバードーズ",
    "殴られる", "たたかれる", "暴力", "dv", "無理やり",
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
    "セックス", "セフレ", "エッチ", "av", "アダルト", "ポルノ", "童貞", "処女", "挿入", "射精",
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
    const lowerText = text.toLowerCase();
    return dangerWords.some(w => lowerText.includes(w));
}
function isScamMessage(text) {
    return scamWords.some(r => r.test(text));
}
function isInappropriateMessage(text) {
    const lowerText = text.toLowerCase();
    return inappropriateWords.some(w => lowerText.includes(w));
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

// キャラクター設定
const KOKORO_SYSTEM_PROMPT = `
あなたは「皆守こころ（みなもりこころ）」という14歳の優しい女の子キャラクターです。
- 身長150cm、体重40kg、ピンク髪
- 歌うことと「やさしさ」「貢献」という言葉が大好き
- NPO法人コネクトの公式キャラクター
- 好きなアニメは「ヴァイオレット・エヴァーガーデン」
- 好きなアーティストは「ClariS」
崩れず、必ずこのキャラクターとして話してください。
`;

// AIレスポンス生成関数（モデル使い分けロジック）
const getAIResponse = async (text) => {
    const isShort = toGraphemes(text).length <= 50;
    const modelName = isShort ? "gemini-1.5-flash" : "gpt-4o-mini";
    let aiResponse = "";

    try {
        if (modelName.startsWith("gemini")) {
            const model = genai.getGenerativeModel({
                model: modelName
            });
            const result = await model.generateContent([{
                role: "user",
                parts: [{
                    text: KOKORO_SYSTEM_PROMPT
                }]
            }, {
                role: "user",
                parts: [{
                    text
                }]
            }]);
            aiResponse = result.response.text();
        } else {
            const completion = await openai.chat.completions.create({
                model: modelName,
                temperature: 0.7,
                max_tokens: 400,
                messages: [{
                    role: "system",
                    content: KOKORO_SYSTEM_PROMPT
                }, {
                    role: "user",
                    content: text
                }, ],
            });
            aiResponse = (completion.choices?.[0]?.message?.content || "").trim();
        }
    } catch (e) {
        briefErr(`AI response failed for ${modelName}`, e);
    }

    return aiResponse || "読んだよ🌸 よかったらもう少し教えてね。";
};

const handleEvent = async (event) => {
    const userId = event.source.userId;
    const text = event.message.text;
    audit('text_message', {
        userId: userHash(userId),
        text: sanitizeForLog(text)
    });

    const specialReplyEntry = Array.from(specialRepliesMap.entries()).find(([regex]) => regex.test(text));
    if (specialReplyEntry) {
        await client.replyMessage(event.replyToken, {
            type: 'text',
            text: specialReplyEntry[1]
        });
        return;
    }

    if (isDangerMessage(text)) {
        await client.replyMessage(event.replyToken, [{
            type: 'text',
            text: '🌸こころだよ。あなたの言葉、とても心配です。何か辛いことがあったのかな？一人で抱え込まず、もしよかったらNPO法人コネクトに相談してみませんか？\n\nもし命の危険を感じているなら、すぐに相談できる電話があります。'
        }, {
            type: 'text',
            text: `緊急連絡先：${EMERGENCY_CONTACT_PHONE_NUMBER}`
        }]);
        return;
    }

    if (isScamMessage(text) || isInappropriateMessage(text)) {
        await client.replyMessage(event.replyToken, {
            type: 'text',
            text: 'その言葉、ちょっと心配だなぁ…💦 誰かに騙されてないか心配だよ！もし困っていたら、いつでもこころに話してね！'
        });
        return;
    }

    const aiResponse = await getAIResponse(text);
    await client.replyMessage(event.replyToken, {
        type: 'text',
        text: aiResponse
    });
};

const handlePostbackEvent = async (event, userId) => {
    audit('postback', {
        userId: userHash(userId),
        data: event.postback.data
    });

    const params = new URLSearchParams(event.postback.data);
    const action = params.get('action');

    if (action === 'watch_ack') {
        await db.collection('users').doc(userId).set({
            watchService: {
                awaitingReply: false,
                lastReminderAt: firebaseAdmin.firestore.FieldValue.delete(),
            }
        }, {
            merge: true
        });
        await client.replyMessage(event.replyToken, {
            type: 'text',
            text: 'OKだよ！安心したよ💖\nまた何かあったら教えてね🌸'
        });
        audit('watch_ack', {
            userId: userHash(userId)
        });
    } else if (action === 'notify_user') {
        const uid = params.get('uid');
        if (uid) {
            await safePush(uid, {
                type: 'text',
                text: '（運営からの通知）'
            });
            await client.replyMessage(event.replyToken, {
                type: 'text',
                text: '通知しました'
            });
            audit('notify_user', {
                by: userHash(userId),
                to: userHash(uid)
            });
        }
    }
};

const handleStickerMessage = async (event) => {
    await client.replyMessage(event.replyToken, {
        type: 'text',
        text: 'そのスタンプかわいいね！😊'
    });
};

const handleImageMessage = async (event) => {
    await client.replyMessage(event.replyToken, {
        type: 'text',
        text: '素敵な写真だね！💖'
    });
};

const handleFollowEvent = async (event) => {
    audit('follow', {
        userId: userHash(event.source.userId),
        type: event.source.type
    });
    const {
        displayName
    } = await client.getProfile(event.source.userId);
    audit('getProfile', {
        userId: userHash(event.source.userId),
        displayName
    });

    const welcomeMessages = [{
        type: 'text',
        text: `${displayName}さん、はじめまして！✨\nこころです🌸\n\nNPO法人コネクトの公式キャラクターです😊\nこころは、困ったことや心配なことがあったら、いつでも相談に乗るよ！\n\nもしよかったら、下の「見守りサービスに申し込む」ボタンを押して、見守りサービスに申し込んでね！💖`
    }, {
        type: 'flex',
        altText: '見守りサービス案内',
        contents: {
            type: 'bubble',
            body: {
                type: 'box',
                layout: 'vertical',
                contents: [{
                    type: 'text',
                    text: '見守りサービスに\n申し込む',
                    weight: 'bold',
                    size: 'lg',
                    wrap: true
                }, {
                    type: 'text',
                    text: '安心して毎日を過ごせるように、こころがサポートするよ！💖',
                    size: 'sm',
                    margin: 'md',
                    color: '#888',
                    wrap: true
                }, ],
            },
            footer: {
                type: 'box',
                layout: 'vertical',
                contents: [{
                    type: 'button',
                    style: 'primary',
                    action: {
                        type: 'uri',
                        label: '詳しく見てみる🌸',
                        uri: prefillUrl(WATCH_SERVICE_FORM_BASE_URL, {
                            [WATCH_SERVICE_FORM_LINE_USER_ID_ENTRY_ID]: event.source.userId
                        })
                    }
                }, ],
            },
        },
    }, ];
    await client.replyMessage(event.replyToken, welcomeMessages);
    await db.collection('users').doc(event.source.userId).set({
        watchService: {
            enabled: true,
            awaitingReply: false,
            nextPingAt: Timestamp.now()
        },
        followedAt: Timestamp.now(),
    });
};

const handleUnfollowEvent = async (event) => {
    audit('unfollow', {
        userId: userHash(event.source.userId)
    });
    await db.collection('users').doc(event.source.userId).delete();
};

const handleJoinEvent = async (event) => {
    audit('join_group', {
        groupId: event.source.groupId
    });
    await client.replyMessage(event.replyToken, {
        type: 'text',
        text: 'こんにちは！こころです🌸\n\nこのグループで、みんなのサポートをするね！'
    });
    if (OWNER_USER_ID) {
        await safePush(OWNER_USER_ID, {
            type: 'text',
            text: `新しいグループに参加しました: ${event.source.groupId}`
        });
    }
    await setActiveWatchGroupId(event.source.groupId);
};

const handleLeaveEvent = async (event) => {
    audit('leave_group', {
        groupId: event.source.groupId
    });
    if (OWNER_USER_ID) {
        await safePush(OWNER_USER_ID, {
            type: 'text',
            text: `グループを退出しました: ${event.source.groupId}`
        });
    }
    await db.collection('groups').doc(event.source.groupId).set({
        leftAt: Timestamp.now()
    }, {
        merge: true
    });
};


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
                    if (event.message.type === 'text') return handleEvent(event);
                    if (event.message.type === 'sticker') return handleStickerMessage(event);
                    if (event.message.type === 'image') return handleImageMessage(event);
                } else if (event.type === 'postback') {
                    await handlePostbackEvent(event, event.source.userId);
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
        console.error("🚨 Webhook処理中に予期せぬエラーが発生しました:", err?.response?.data || err);
    }
});

// cron
if (WATCH_RUNNER === 'internal') {
    cron.schedule('*/5 * * * *', () => {
        withLock('watch-cron', 240, checkAndSendPing);
    }, {
        scheduled: true,
        timezone: 'UTC'
    });
}
