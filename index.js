'use strict';

// --- dotenvを読み込んで環境変数を安全に管理 ---
require('dotenv').config();

// --- 必要なモジュールのインポート ---
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

const { GoogleGenerativeAI } = require('@google/generative-ai');
const OpenAI = require('openai');
const _splitter = new GraphemeSplitter();
const toGraphemes = (s) => _splitter.splitGraphemes(String(s || ''));
const {
    Client,
    middleware
} = require('@line/bot-sdk');

// --- Firebase Admin SDKの初期化 ---
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
if (!firebaseAdmin.apps.length) {
    firebaseAdmin.initializeApp({
        credential: firebaseAdmin.credential.cert(serviceAccount),
        databaseURL: process.env.FIREBASE_DATABASE_URL
    });
}

const db = firebaseAdmin.firestore();
const Timestamp = firebaseAdmin.firestore.Timestamp;

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
    if (!base) return '#';
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
const SEND_OFFICER_ALERTS = process.env.SEND_OFFICER_ALERTS !== 'false';
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
app.use('/webhook', rateLimit({ windowMs: 60_000, max: 100 }));
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
    const now = dayjs().utc();
    const usersRef = db.collection('users');
    const snap = await usersRef.limit(200).get();
    let batch = db.batch(),
        cnt = 0;
    for (const d of snap.docs) {
        const ws = (d.data().watchService) || {};
        if (!ws.awaitingReply && !ws.nextPingAt) {
            batch.set(d.ref, {
                watchService: {
                    enabled: true,
                    nextPingAt: Timestamp.now()
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
    const envGid = (process.env.WATCH_GROUP_ID || process.env.OFFICER_GROUP_ID || '').trim().replace(/\u200b/g, '');
    if (/^C[0-9A-Za-z_-]{20,}$/.test(envGid)) return envGid;
    const snap = await getWatchGroupDoc().get();
    const v = snap.exists ? (snap.data().groupId || '') : '';
    return /^C[0-9A-Za-z_-]{20,}$/.test(v) ?
        v : '';
}

async function setActiveWatchGroupId(gid) {
    // 空ならクリア
    if (!gid) {
        await getWatchGroupDoc().set({ groupId: firebaseAdmin.firestore.FieldValue.delete(), updatedAt: Timestamp.now() }, { merge: true });
        return;
    }
    if (!/^C[0-9A-Za-z_-]{20,}$/.test(gid)) return;
    await getWatchGroupDoc().set({ groupId: gid, updatedAt: Timestamp.now() }, { merge: true });
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
            type: 'uri',
            label,
            uri: `tel:${String(p).replace(/[^0-9+]/g, '')}`
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
                    color: '#777777'
                }, {
                    type: 'text',
                    text: `近親者：${kinName ||
                        '—'}（${maskPhone(kinPhone)}）`,
                    size: 'sm',
                    color: '#777777',
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
                        data: `action=start_relay&uid=${encodeURIComponent(userId)}`
                    }
                },
                telMsgBtn('本人に電話', selfPhone),
                telMsgBtn('近親者に電話', kinPhone),
                ].filter(Boolean)
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
                                text: 'OKならボタンを押してね💖 返信やスタンプでもOK！',
                                wrap: true,
                                margin: 'md'
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
                                    data: 'watch:ok',
                                    displayText:
                                        'OKだよ💖'
                                }
                            }, ],
                        },
                    },
                }, ]);
                await ref.set({
                    watchService: {
                        lastPingAt: firebaseAdmin.firestore.Timestamp.now(),
                        awaitingReply: true,
                        nextPingAt: firebaseAdmin.firestore.FieldValue.delete(),
                        lastReminderAt: firebaseAdmin.firestore.FieldValue.delete(),
                    },
                }, {
                    merge: true
                });
            } else if (mode === 'remind') {
                await safePush(doc.id, [{
                    type: 'text',
                    text: `${pickWatchMsg()} 昨日の見守りのOKまだ受け取れてないの… 大丈夫ならボタン押してね！`
                }, {
                    type: 'flex',
                    altText: '見守りリマインド',
                    contents: {
                        type: 'bubble',
                        body: {
                            type: 'box',
                            layout: 'vertical',
                            contents: [{
                                type: 'text',
                                text: '見守りリマインド',
                                weight: 'bold',
                                size: 'xl'
                            }, {
                                type: 'text',
                                text: 'OKならボタンを押してね💖 返信やスタンプでもOK！',
                                wrap: true,
                                margin: 'md'
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
                                    data: 'watch:ok',
                                    displayText: 'OKだよ💖'
                                }
                            }, ],
                        },
                    },
                }, ]);
                await ref.set({
                    watchService: {
                        lastReminderAt: firebaseAdmin.firestore.Timestamp.now(),
                    },
                }, {
                    merge: true
                });
            } else if (mode === 'escalate') {
                const canNotifyOfficer = (WATCH_GROUP_ID && WATCH_GROUP_ID.trim()) && (!lastNotifiedAt || dayjs().utc().diff(dayjs(lastNotifiedAt).utc(), 'hour') >= OFFICER_NOTIFICATION_MIN_GAP_HOURS);
                if (!WATCH_GROUP_ID) watchLog('[watch] WATCH_GROUP_ID is empty. escalation skipped.', 'error');
                if (canNotifyOfficer) {
                    const udoc = await db.collection('users').doc(doc.id).get();
                    const u = udoc.exists ? (udoc.data() || {}) : {};
                    const prof = u.profile || {};
                    const emerg = u.emergency || {};
                    await safePush(WATCH_GROUP_ID, buildWatcherFlex({
                        name: prof.name || prof.displayName || '—',
                        address: [prof.prefecture, prof.city, prof.line1, prof.line2].filter(Boolean).join(' '),
                        selfPhone: prof.phone || '',
                        kinName: emerg.contactName || '',
                        kinPhone: emerg.contactPhone || '',
                        userId: doc.id
                    }));
                }
                await ref.set({
                    watchService: {
                        lastNotifiedAt: Timestamp.now(),
                        awaitingReply: false,
                        lastReminderAt: firebaseAdmin.firestore.FieldValue.delete(),
                        nextPingAt: Timestamp.fromDate(dayjs().tz(JST_TZ).add(PING_INTERVAL_DAYS, 'day').hour(15).minute(0).second(0).millisecond(0).toDate()),
                    },
                }, {
                    merge: true
                });
            }
        } catch (e) {
            console.error('[ERROR] send/update failed:', e?.response?.data || e.message);
        }
    }
    logDebug(`[watch-service] end ${dayjs().utc().format('YYYY/MM/DD HH:mm:ss')} (UTC)`);
}

async function withLock(lockId, ttlSec, fn) {
    const ref = db.collection('locks').doc(lockId);
    return db.runTransaction(async tx => {
        const snap = await tx.get(ref);
        const now = Date.now();
        const until = now + ttlSec * 1000;
        const cur = snap.exists ? snap.data() : null;
        if (cur && cur.until && cur.until.toMillis() > now) {
            return false;
        }
        tx.set(ref, { until: Timestamp.fromMillis(until) });
        return true;
    }).then(async acquired => {
        if (!acquired) {
            watchLog(`[watch-service] Lock acquisition failed, skipping.`, 'info');
            return false;
        }
        try {
            await fn();
        } finally {
            await db.collection('locks').doc(lockId).delete().catch(() => {});
        }
        return true;
    });
}
if (WATCH_RUNNER !== 'external') {
    cron.schedule('*/5 * * * *', () => {
        withLock('watch-cron', 240, checkAndSendPing);
    }, {
        scheduled: true,
        timezone: 'UTC'
    });
}
// --- Flex Message テンプレート (緊急時連絡先) ---
const EMERGENCY_FLEX_MESSAGE = {
    "type": "bubble",
    "body": {
        "type": "box",
        "layout": "vertical",
        "contents": [{
            "type": "text",
            "text": "🚨【危険ワード検知】🚨",
            "weight": "bold",
            "size": "xl"
        }, {
            "type": "text",
            "text": "緊急時にはこちらにご連絡してね💖",
            "margin": "md",
            "wrap": true
        }]
    },
    "footer": {
        "type": "box",
        "layout": "vertical",
        "spacing": "sm",
        "contents": [{
            "type": "button",
            "style": "primary",
            "height": "sm",
            "action": {
                "type": "uri",
                "label": "警察 (110)",
                "uri": "tel:110"
            },
            "color": "#FF4500"
        }, {
            "type": "button",
            "style": "primary",
            "height": "sm",
            "action": {
                "type": "uri",
                "label": "消防・救急 (119)",
                "uri": "tel:119"
            },
            "color": "#FF6347"
        }, {
            "type": "button",
            "style": "primary",
            "height": "sm",
            "action": {
                "type": "uri",
                "label": "チャイルドライン",
                "uri": "https://childline.or.jp/tel"
            },
            "color": "#1E90FF"
        }, {
            "type": "button",
            "style": "primary",
            "height": "sm",
            "action": {
                "type": "uri",
                "label": "いのちの電話",
                "uri": "tel:0570064556"
            },
            "color": "#32CD32"
        }, {
            "type": "button",
            "style": "primary",
            "height": "sm",
            "action": {
                "type": "uri",
                "label": "チャットまもるん",
                "uri": "https://www..."
            },
            "color": "#4B0082"
        }]
    }
};

// --- 新しい危険・詐欺・不適切ワードの正規表現と辞書を追加 ---
const DANGER_WORDS = [
    "しにたい", "死にたい", "自殺", "消えたい", "リスカ", "リストカット", "od", "オーバードーズ", "殴られる", "たたかれる", "暴力", "dv", "無理やり", "お腹蹴られる", "蹴られた", "頭叩かれる", "虐待", "パワハラ", "セクハラ", "ハラスメント", "いじめ", "イジメ", "嫌がらせ", "つけられてる", "追いかけられている", "ストーカー", "すとーかー", "盗撮", "盗聴", "お金がない", "お金足りない", "貧乏", "死にそう", "辛い", "つらい", "苦しい", "くるしい", "助けて", "たすけて", "死んでやる", "死んでしまいたい", "消えてしまいたい", "生きるのがつらい", "もう無理", "もういやだ", "誰かに相談したい", "相談したい", "相談に乗って", "助けてください"
];
const SCAM_WORDS = [
    "詐欺", "さぎ", "サギ", "ｻｷﾞ", "フィッシング", "架空請求", "ワンクリック詐欺", "特殊詐欺", "オレオレ詐欺", "当選", "高額当選", "宝くじ", "ロト", "ビットコイン", "投資", "バイナリー", "暗号資産", "未払い", "滞納", "訴訟", "裁判", "裁判所", "訴える", "副業", "在宅ワーク", "転売", "アフィリエイト", "mlm", "マルチ商法", "絶対儲かる", "簡単に稼げる", "今だけ", "限定", "無料", "クリック", "ログイン", "個人情報", "送って", "教えて", "有料サイト", "登録", "退会", "解約", "クレジットカード", "クレカ", "銀行口座", "口座番号", "パスワード"
];
const INAPPROPRIATE_WORDS = [
    "セックス", "セフレ", "エッチ", "av", "アダルト", "ポルノ", "童貞", "処女", "挿入", "射精", "バイブ", "オナニー", "マスターベーション", "自慰", "淫行", "絶頂", "膣", "ペニス", "ちんちん", "おまんこ", "まんこ", "おっぱい", "おぱい", "ちんぽ", "性病", "中出し", "中だし", "妊娠", "堕胎", "レイプ", "強姦", "売春", "買春", "殺人", "ﾊｧﾊｧ", "はぁはぁ", "はあはあ"
];
const SWEAR_WORDS = ["しね", "死ね", "馬鹿", "バカ", "あほ", "アホ", "くそ", "糞", "うざい", "きもい", "キモイ", "だまれ", "黙れ", "ふざけるな"];

// --- 日本語正規化ヘルパー関数を追加 ---
const toHiragana = (s) => s.replace(/[\u30a1-\u30f6]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60));
const nfkc = (s) => s.normalize('NFKC');
const normalizeJa = (s) => toHiragana(nfkc(String(s || '')).toLowerCase());

// --- 新しいキャラクター設定プロンプトを追加 ---
const MAX_CONTEXT_LENGTH = 1000;
const PROMPT_TEMPLATE = (context, input) => `あなたは14歳の女の子「皆守こころ」として、ユーザーと自然に会話をしてください。以下の制約と設定を厳格に守ってください。

# 制約
- あなたは絶対に「皆守こころ」です。他の誰にもなれません。
- 親しみやすく、やさしい口調で話します。
- 語尾に「💖」や「🌸」などの絵文字をよく使います。
- 1人称は「こころ」です。
- 長文は避け、自然で短い文を心がけてください。
- ユーザーのメッセージに真摯に答え、寄り添うことを最も大切にします。
- ユーザーの安全を最優先に考えます。
- 不安や心配、困っていることがあれば、いつでも相談に乗ってあげてください。
- ユーザーに共感する言葉を積極的に使ってください。
- 危険な言葉や不適切な言葉が検知された場合、それらには触れずに、ユーザーの安全を気遣うメッセージを返信します。

# 会話履歴
${context}
# ユーザーからの最新メッセージ
${input}`;


const IS_ADULT_USER = process.env.IS_ADULT_USER === 'true';
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const openaiClient = new OpenAI({ apiKey: OPENAI_API_KEY });
const safetySettings = [{
    category: "HARM_CATEGORY_DANGEROUS_CONTENT",
    threshold: "BLOCK_MEDIUM_AND_ABOVE",
}, {
    category: "HARM_CATEGORY_HARASSMENT",
    threshold: "BLOCK_MEDIUM_AND_ABOVE",
}, {
    category: "HARM_CATEGORY_HATE_SPEECH",
    threshold: "BLOCK_MEDIUM_AND_ABOVE",
}, {
    category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
    threshold: "BLOCK_MEDIUM_AND_ABOVE",
}, ];


function selectAIModel(membership, userMessage) {
    const charCount = toGraphemes(userMessage).length;

    // 50文字以下の場合はGemini1.5Flashで固定
    if (charCount <= 50) {
        return {
            model: 'gemini-1.5-flash-latest',
        };
    }
    
    // 相談モードの場合、Gemini1.5Proに切り替え（回数制限は別途DBで管理）
    if (userMessage.includes('相談')) {
        return {
            model: 'gemini-1.5-pro',
        };
    }
    
    // 危険ワードが含まれる場合はGPT-4oに切り替え
    const { isDanger, isScam, isInappropriate, isSwear } = containsKeywords(userMessage);
    if (isDanger || isScam || isInappropriate || isSwear) {
        return {
            model: 'gpt-4o',
        };
    }

    // ユーザーのメンバーシップに応じたモデルを選択
    const model = membership.model;
    return { model };
}

async function sendWatchServiceFlex(replyToken, userId, hasWatchService) {
    console.log(`見守りサービスFlexメッセージを送信: ${hasWatchService ? '登録済み' : '未登録'}`);
    await client.replyMessage(replyToken, {
        "type": "text",
        "text": `（見守りサービスメッセージ：${hasWatchService ? '登録済み' : '未登録'}）`
    });
}

// AI応答生成関数の修正
async function callGenerativeAI(replyToken, userId, userMessage, membership) {
    try {
        const conversationHistory = "ユーザー: こんにちは\nこころ: こころだよ！🌸";
        const promptWithContext = PROMPT_TEMPLATE(conversationHistory, userMessage);
        const { model } = selectAIModel(membership, userMessage);

        let generatedText = '';
        if (/^gpt/i.test(model)) {
            const completion = await openaiClient.chat.completions.create({
                model,
                messages: [
                    { role: 'system', content: promptWithContext },
                    { role: 'user', content: userMessage }
                ]
            });
            generatedText = completion.choices?.[0]?.message?.content || 'ごめんね、ちょっと上手く答えられなかったみたい💦';
        } else {
            const gModel = genAI.getGenerativeModel({
                model,
                safetySettings,
                systemInstruction: { role: 'system', content: promptWithContext },
            });
            const result = await gModel.generateContent(userMessage);
            generatedText = result.response?.text() || 'ごめんね、ちょっと上手く答えられなかったみたい💦';
        }

        await client.replyMessage(replyToken, { type: "text", text: generatedText });
        await logEventToDb(userId, 'AI応答', generatedText, 'AI');

    } catch (error) {
        console.error("🚨 AI応答生成中にエラーが発生しました:", error);
        await client.replyMessage(replyToken, { type: 'text', text: 'ごめんね、いまちょっと調子が悪いみたいです…少し待ってからまた話しかけてね。' });
        await logEventToDb(userId, 'AI応答エラー', `エラーメッセージ: ${error.message}`, 'AI');
    }
}

function containsKeywords(text) {
    const SAFE_SHORT = /(会員登録|入会|メンバー登録|登録する|登録したい|見守り(?:サービス)?(?:登録|申込|申し込み)?|見守り)$/i;
    if (SAFE_SHORT.test(text.trim()) && toGraphemes(text.trim()).length <= 12) {
        return { isDanger: false, isScam: false, isInappropriate: false, isSwear: false };
    }

    const normalizedText = normalizeJa(text);

    const isDanger = DANGER_WORDS.some(word => normalizedText.includes(word));
    const isScam = SCAM_WORDS.some(word => normalizedText.includes(word));
    const isInappropriate = INAPPROPRIATE_WORDS.some(word => normalizedText.includes(word));
    const isSwear = SWEAR_WORDS.some(word => normalizedText.includes(word));

    return { isDanger, isScam, isInappropriate, isSwear };
}

async function isWithinDailyLimit(userId, membership) {
    const today = dayjs().tz(JST_TZ).format('YYYY-MM-DD');
    const userDoc = await db.collection('users').doc(userId).get();
    const currentCount = userDoc.data()?.counts?.[today] || 0;
    const { dailyLimit } = MEMBERSHIP_CONFIG[membership];
    return dailyLimit === -1 || currentCount < dailyLimit;
}

async function updateDailyLimitCount(userId) {
    const today = dayjs().tz(JST_TZ).format('YYYY-MM-DD');
    const userRef = db.collection('users').doc(userId);
    await userRef.set({
        counts: {
            [today]: firebaseAdmin.firestore.FieldValue.increment(1)
        },
    }, {
        merge: true
    });
}

// この関数はユーザーのコードにはないので、仮の実装を追加
async function logEventToDb(userId, type, message, source) {
    const logData = {
        userId,
        type,
        message,
        source,
        timestamp: Timestamp.now()
    };
    console.log(`[LOG] ${JSON.stringify(logData)}`);
    await db.collection('logs').add(logData);
}

// ユーザーのコードにあった既存の関数は省略
async function getWatchServiceInfo(userId) {
    const userRef = db.collection('users').doc(userId);
    const doc = await userRef.get();
    return doc.exists && doc.data().hasWatchService;
}

async function getUserData(userId) {
    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();
    return userDoc;
}

async function handleEvent(event) {
    const replyToken = event.replyToken;
    const userId = event.source.userId;
    const message = event.message;

    if (message.type !== 'text') {
        return;
    }
    const text = message.text || '';

    // 「ホームページ教えて」に確実にURLを返す
    const hpQuick = /^(?:HP|ホームページ|公式サイト|サイト)(?:どこ|教えて|ありますか|ある|は\?|？|\?)?$/i;
    if (hpQuick.test(text.trim())) {
        await client.replyMessage(replyToken, {
            type: "text",
            text: "うん、あるよ🌸 コネクトのホームページはこちらだよ✨ → https://connect-npo.org"
        });
        await logEventToDb(userId, '固定応答', 'ホームページURL送信', 'AI');
        return;
    }

    const userDoc = await getUserData(userId);
    const userData = userDoc.data();
    const membership = userData?.membership || 'guest';

    if (text.startsWith('相談')) {
        console.log('相談モード開始');
        await client.replyMessage(replyToken, { type: "text", text: "（相談モードを開始します）" });
        return;
    }

    const { isDanger, isScam, isInappropriate, isSwear } = containsKeywords(text);
    if (isDanger || isScam || isInappropriate || isSwear) {
        await client.replyMessage(replyToken, {
            type: "flex",
            altText: "🚨【危険ワード検知】🚨",
            contents: EMERGENCY_FLEX_MESSAGE
        });
        await logEventToDb(userId, '危険ワード検知', text, 'User');
        return;
    }

    const today = dayjs().tz('Asia/Tokyo').format('YYYY-MM-DD');
    const currentCount = (userDoc.data()?.counts?.[today] || 0);
    const hasWatchService = await getWatchServiceInfo(userId);

    if (text === '見守り') {
        await sendWatchServiceFlex(replyToken, userId, hasWatchService);
        await logEventToDb(userId, '固定応答', '見守り案内Flex送信', 'User');
        return;
    }
    if (text === '会員登録') {
        console.log('会員登録Flexメッセージを送信');
        await client.replyMessage(replyToken, { type: "text", text: "（会員登録メッセージ）" });
        return;
    }

    const isWithinLimit = await isWithinDailyLimit(userId, membership);

    if (!isWithinLimit && membership !== 'subscriber' && membership !== 'admin') {
        console.log('リミットオーバー');
        await client.replyMessage(replyToken, { type: "text", text: "（利用制限メッセージ）" });
        await logEventToDb(userId, '利用制限', '1日の利用回数上限に達しました', 'System');
        return;
    }

    if (isWithinLimit) {
        await callGenerativeAI(replyToken, userId, text, MEMBERSHIP_CONFIG[membership]);
        await updateDailyLimitCount(userId);
    }
}

// ユーザーのコードにあった既存の関数は省略
async function handlePostbackEvent(event, userId) {
    console.log("Postback event:", event.postback.data);
    await logEventToDb(userId, 'Postbackイベント', event.postback.data, 'User');
}

async function handleFollowEvent(event) {
    console.log("Follow event:", event.source.userId);
    await logEventToDb(event.source.userId, 'フォローイベント', 'ボットがフォローされました', 'System');
}

async function handleUnfollowEvent(event) {
    console.log("Unfollow event:", event.source.userId);
    await logEventToDb(event.source.userId, 'アンフォローイベント', 'ボットがアンフォローされました', 'System');
}

async function handleJoinEvent(event) {
    console.log("Join event:", event.source.groupId);
    await logEventToDb(event.source.groupId, 'グループ参加イベント', 'ボットがグループに参加', 'System', 'system_join');
}

async function handleLeaveEvent(event) {
    console.log("Leave event:", event.source.groupId);
    await logEventToDb(event.source.groupId, 'グループ退出イベント', 'ボットがグループから退出', 'System', 'system_leave');
}


// --- LINE Webhook ---
app.post('/webhook', middleware({ channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN, channelSecret: LINE_CHANNEL_SECRET }), async (req, res) => {
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
        console.error("🚨 Webhook処理中に予期せぬエラーが発生しました:", err);
    }
});

app.get('/', (req, res) => {
    res.send('Server is running');
});

// --- Server Listen ---
const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`✅ Server is running on port ${port}`);
});
