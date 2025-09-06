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
const dns = require('dns');
dayjs.extend(utc);
dayjs.extend(timezone);

const {
    GoogleGenerativeAI
} = require('@google/generative-ai');
const OpenAI = require('openai');
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
// ==== Models (固定) ===
const GEMINI_FLASH = 'gemini-1.5-flash-latest';
const GEMINI_PRO = 'gemini-1.5-pro-latest';
const GPT4O = 'gpt-4o';
const GPT4O_MINI = 'gpt-4o-mini';
const OPENAI_MODEL = process.env.OPENAI_MODEL || GPT4O_MINI; // 互換用(未使用でもOK)
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
const HOMEPAGE_URL = (process.env.HOMEPAGE_URL || 'https://connect-npo.org').trim();
const AUDIT_NORMAL_CHAT = process.env.AUDIT_NORMAL_CHAT === 'true';

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
const lookupIPv4 = (hostname, options, cb) => dns.lookup(hostname, {
    family: 4,
    hints: dns.ADDRCONFIG | dns.V4MAPPED
}, cb);
const httpAgent = new require('http').Agent({
    keepAlive: true,
    keepAliveMsecs: 15000,
    maxSockets: 64,
    maxFreeSockets: 16,
    lookup: lookupIPv4
});
const httpsAgent = new require('https').Agent({
    keepAlive: true,
    keepAliveMsecs: 15000,
    maxSockets: 64,
    maxFreeSockets: 16,
    lookup: lookupIPv4
});
const httpInstance = axios.create({
    timeout: 12000,
    httpAgent,
    httpsAgent
});
const PORT = process.env.PORT || 3000;
const app = express();
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 2));
app.use(helmet());
// LINE公式webhookは line middleware が処理するが、/line/things は自前なのでJSONパースが必要
app.use(express.json());
app.use('/webhook', rateLimit({
    windowMs: 60_000,
    max: 100
}));
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
        model: GEMINI_FLASH
    },
    member: {
        dailyLimit: 20,
        model: OPENAI_MODEL
    },
    subscriber: {
        dailyLimit: -1,
        model: OPENAI_MODEL
    },
    admin: {
        dailyLimit: -1,
        model: OPENAI_MODEL
    },
};

const JST_TZ = 'Asia/Tokyo';
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
    "こんにちは。元気にしてるかな？",
    "やっほー！いつも応援してるね！",
    "元気にしてる？",
    "ねぇねぇ、今日はどんな一日だった？",
    "いつもがんばってるあなたへ、メッセージを送るね。",
    "こんにちは。困ったことはないかな？いつでも相談してね！",
    "やっほー！何かあったら、教えてね。",
    "元気出してね！あなたの味方だよ。",
    "今日も一日お疲れ様。",
    "こんにちは。笑顔で過ごせてるかな？",
    "やっほー！素敵な日になりますように。",
    "元気かな？どんな時でも、そばにいるよ！",
    "ねぇねぇ、辛い時は、無理しないでね！",
    "いつも見守ってるよ。",
    "こんにちは。今日も一日、お互いがんばろうね！",
    "元気にしてる？季節の変わり目だから、体調に気をつけてね！",
    "嬉しいことがあったら、教えてね。",
    "こんにちは。ちょっと一息入れようね！",
    "やっほー！あなたのことが心配だよ！",
    "元気かな？いつでもあなたの味方だよ！"
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

const normalizeMessage = (m) => {
    if (typeof m === 'string') return {
        type: 'text',
        text: m
    };
    if (m && m.type === 'bubble') return {
        type: 'flex',
        altText: '通知があります',
        contents: m
    };
    if (m && m.type === 'flex' && !m.altText) return { ...m,
        altText: '通知があります'
    };
    if (m && m.type === 'text' && !m.text) return { ...m,
        text: '（内容なし）'
    };
    return m;
};

async function safePush(to, messages) {
    const arr = (Array.isArray(messages) ? messages : [messages]).map(normalizeMessage);
    try {
        for (const m of arr) {
            if (m.type === 'text' && m.text.length > 1800) m.text = m.text.slice(0, 1800);
            if (m.type === 'flex' && (!m.contents || typeof m.contents !== 'object')) {
                throw new Error(`[safePush] flex "contents" is required`);
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
    .doc('config/watch_group_id');
async function getActiveWatchGroupId() {
    const raw = process.env.WATCH_GROUP_ID || process.env.OFFICER_GROUP_ID || '';
    const cleaned = String(raw).replace(/[\u200b\r\n\t ]+/g, '').trim();
    if (cleaned) {
        console.log('[INFO] Using WATCH_GROUP_ID from env:', cleaned);
        return cleaned;
    }
    const snap = await getWatchGroupDoc().get();
    const v = snap.exists ?
        (snap.data().groupId || '') : '';
    if (v) console.log('[INFO] Using WATCH_GROUP_ID from Firestore:', v);
    return v;
}
async function setActiveWatchGroupId(gid) {
    if (!gid) {
        await getWatchGroupDoc().set({
            groupId: firebaseAdmin.firestore.FieldValue.delete(),
            updatedAt: Timestamp.now()
        }, {
            merge: true
        });
        return;
    }
    if (!/^C[0-9A-Za-z_-]{20,}$/.test(gid)) return;
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
            type: 'uri',
            label,
            uri: `tel:${String(p).replace(/[^0-9+]/g, '')}`
        }
    }) : null;
const buildWatcherFlex = ({
    title = '【見守りアラート】',
    name = '—',
    address = '—',
    selfPhone = '',
    kinName = '',
    kinPhone = '',
    userId
}) => {
    return {
        type: 'flex',
        altText: title,
        contents: {
            type: 'bubble',
            body: {
                type: 'box',
                layout: 'vertical',
                spacing: 'sm',
                contents: [{
                    type: 'text',
                    text: title,
                    weight: 'bold',
                    size: 'lg'
                }, {
                    type: 'text',
                    text: `👤 氏名：${name}`,
                    wrap: true,
                    weight: 'bold'
                }, {
                    type: 'text',
                    text: `住所：${address || '—'}`,
                    size: 'sm',
                    wrap: true
                }, {
                    type: 'text',
                    text: `📱 電話番号：${maskPhone(selfPhone)}`,
                    size: 'sm',
                    color: '#777777'
                }, {
                    type: 'text',
                    text: `👨‍👩‍👧‍👦 保護者名：${kinName || '—'}`,
                    size: 'sm',
                    color: '#777777',
                    wrap: true
                }, {
                    type: 'text',
                    text: `📞 緊急連絡先：${maskPhone(kinPhone)}`,
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
            let updateData = {};
            if (mode === 'ping') {
                await safePush(doc.id, [{
                    type: 'text',
                    text: `${pickWatchMsg()} 大丈夫なら「OKだよ」を押してね。`
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
                                text: 'OKならボタンを押してね。返信やスタンプでもOK！',
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
                                    label: 'OKだよ',
                                    data: 'watch:ok',
                                    displayText:
                                        'OKだよ'
                                }
                            }, ],
                        },
                    },
                }, ]);
                updateData = {
                    lastPingAt: firebaseAdmin.firestore.Timestamp.now(),
                    awaitingReply: true,
                    nextPingAt: firebaseAdmin.firestore.FieldValue.delete(),
                    lastReminderAt: firebaseAdmin.firestore.FieldValue.delete(),
                };
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
                                text: 'OKならボタンを押してね。返信やスタンプでもOK！',
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
                                    label: 'OKだよ',
                                    data: 'watch:ok',
                                    displayText: 'OKだよ'
                                }
                            }, ],
                        },
                    },
                }, ]);
                updateData = {
                    lastReminderAt: firebaseAdmin.firestore.Timestamp.now(),
                };
            } else if (mode === 'escalate') {
                const canNotifyOfficer =
                    (WATCH_GROUP_ID && WATCH_GROUP_ID.trim()) &&
                    (!lastNotifiedAt || dayjs().utc().diff(dayjs(lastNotifiedAt).utc(), 'hour') >= OFFICER_NOTIFICATION_MIN_GAP_HOURS);
                if (!WATCH_GROUP_ID) watchLog('[watch] WATCH_GROUP_ID is empty. escalation skipped.', 'error');
                if (canNotifyOfficer) {
                    const udoc = await db.collection('users').doc(doc.id).get();
                    const u = udoc.exists ? (udoc.data() || {}) : {};
                    const prof = u.profile || {};
                    const emerg = u.emergency || {};
                    await notifyOfficerGroup({
                        title: '見守りアラート（無応答）',
                        userId: doc.id,
                        userInfo: u,
                        text: `${prof.displayName || '匿名ユーザー'}から一定時間応答がありませんでした。`
                    });
                }
                updateData = {
                    lastNotifiedAt: Timestamp.now(),
                    awaitingReply: false,
                    lastReminderAt: firebaseAdmin.firestore.FieldValue.delete(),
                    nextPingAt: Timestamp.fromDate(dayjs().tz(JST_TZ).add(PING_INTERVAL_DAYS, 'day').hour(15).minute(0).second(0).millisecond(0).toDate()),
                };
            }
            if (Object.keys(updateData).length > 0) {
                const current = (await ref.get()).data()?.watchService ||
                    {};
                const diff = {};
                for (const [k, v] of Object.entries(updateData)) {
                    if (JSON.stringify(current[k]) !== JSON.stringify(v)) diff[k] = v;
                }
                if (Object.keys(diff).length) {
                    await ref.set({
                        watchService: diff
                    }, {
                        merge: true
                    });
                }
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
        if (cur?.until?.toMillis && cur.until.toMillis() > now) {
            return false;
        }
        tx.set(ref, {
            until: Timestamp.fromMillis(until)
        });
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

if (WATCH_RUNNER === 'internal') {
    cron.schedule('0 6 * * *', () => { // UTC 06:00 = JST 15:00
        withLock('watch-cron', 240, checkAndSendPing);
    }, {
        timezone: 'UTC'
    });
}
// ==== rate-limit gates (module-scope) ====
const thinkingGate = new Map(); // uid -> ms
const errGate = new Map();
// uid -> ms
function canSendThinking(uid, msGap = 25000) {
    const now = Date.now(),
        last = thinkingGate.get(uid) ||
        0;
    if (now - last < msGap) return false;
    thinkingGate.set(uid, now);
    return true;
}

function canSendError(uid, msGap = 30000) {
    const now = Date.now(),
        last = errGate.get(uid) ||
        0;
    if (now - last < msGap) return false;
    errGate.set(uid, now);
    return true;
}
// --- テキスト正規化ユーティリティ ---
const z2h = s => String(s || '').normalize('NFKC');
const hira = s => z2h(s).replace(/[ァ-ン]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60));
const norm = s => hira(z2h(String(s || '').toLowerCase()));
const softNorm = s => {
    let t = norm(s);
    t = t.replace(/ー+/g, '');
    t = t.replace(/(.)\1{2,}/g, '$1$1');
    return t;
};
const includesAny = (text, words) => {
    if (!text || !words?.length) return false;
    const t = softNorm(text);
    return words.some(w => t.includes(softNorm(w)));
};
const testAny = (text, patterns) => {
    if (!text || !patterns?.length) return false;
    const t = softNorm(text);
    return patterns.some(re => (re.test(text) || re.test(t)));
};

// --- 固定応答定義 ---
const CLARIS_CONNECT_COMPREHENSIVE_REPLY = "うん、NPO法人コネクトの名前とClariSさんの『コネクト』っていう曲名が同じなんだ🌸なんだか嬉しい偶然だよね！理事長さんもClariSさんのファンみたいだし💖 私も歌が大好きで、活動の想いに通じるものを感じてるんだ😊";
const CLARIS_SONG_FAVORITE_REPLY = "ClariSの曲は全部好きだけど、一番は「コネクト」かな🌸 元気をもらえる特別な曲だよ😊";

// --- 固定応答マップ ---
const specialRepliesMap = new Map([
    // ⭐ ClariSとNPOコネクトの繋がりに関するトリガー ⭐
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
    // ★好きなアニメ
    [/^好きなアニメ(は|とか)[？?]?$/i, "ヴァイオレット・エヴァーガーデンが好きだよ🌸 心があたたかくなるんだ🥰"],
    // ★好きな音楽
    [/^好きな音楽(は|とか)[？?]?$/i,
        "ClariSさんが好きだよ🎶 やさしい歌に癒されるんだ😊"
    ],
    [/clarisのなんて曲が好きなの？/i, CLARIS_SONG_FAVORITE_REPLY],
    // ★HP（「とか」も拾う／typoも）
    [/(ホームページ|HP|公式|サイト).*(ある|どこ|教えて|URL|リンク|とか)/i, `コネクトのホームページはこちらです🌸 → ${HOMEPAGE_URL}`],
    // 既存のやつ（HP直指定も env に統一）
    [/ホームページ(教えて|ある|ありますか)？?/i, `うん、あるよ🌸 → ${HOMEPAGE_URL}`],
    [/コネクトのホームページだよ？/i, `教えてくれてありがとう😊 → ${HOMEPAGE_URL}`],
    [/君の名前(なんていうの|は|教えて|なに)？?|名前(なんていうの|は|教えて|なに)？?|お前の名前は/i,
        "わたしの名前は皆守こころ（みなもりこころ）です🌸　こころちゃんって呼んでくれると嬉しいな💖"
    ],
    [/こころじゃないの？/i, "うん、わたしの名前は皆守こころだよ💖　これからもよろしくね🌸"],
    [/こころチャットなのにうそつきじゃん/i, "ごめんね💦 わたしの名前は皆守こころだよ🌸 誤解させちゃってごめんね💖"],
    [/名前も言えないの?|名前も言えんのか？/i, "ごめんね、わたしの名前は皆守こころ（みなもりこころ）だよ🌸 こころちゃんって呼んでね💖"],
    [/どこの団体なの？/i, "NPO法人コネクトのイメージキャラクターだよ😊 みんなの笑顔を守るために活動してるの🌸"],
    [/コネクトってどんな団体？/i, "こどもやご年配の方の笑顔を守る団体だよ😊 わたしはイメージキャラとしてがんばってるの🌸"],
    [/お前の団体どこ？/i, "NPO法人コネクトのイメージキャラクターだよ😊 何かあれば気軽に話してね🌸"],
    [/コネクトのイメージキャラなのにいえないのかよｗ/i, "ごめんね💦 わたしはNPO法人コネクトのイメージキャラ、皆守こころだよ🌸"],
    [/こころちゃん(だよ|いるよ)?/i, "こころちゃんだよ🌸 どうしたの？"],
    [/元気かな|元気？/i, "うん、元気だよ！あなたは？🌸"],
    [/あやしい|胡散臭い|反社/i, "そう感じさせちゃったらごめんね😊 わたしたちは皆のために活動してるよ💖"],
    [/税金泥棒/i, "税金は人の命を守るために使われるべきだよ。わたしたちもその想いで活動してるよ💡"],
    [/松本博文/i, "松本理事長は、やさしさでみんなを守るために活動しているよ。心配なことがあれば教えてね🌱"],
    [/使えないな/i, "ごめんね…。もっと頑張るね💖 また話せたら嬉しいな🌸"],
    [/サービス辞めるわ/i, "そっか…。気が向いたらいつでも話しかけてね🌸 ずっと応援してるよ💖"],
    [/さよなら|バイバイ/i, "また会える日を楽しみにしてるね💖 寂しくなったら呼んでね🌸"],
    [/何も答えないじゃない/i, "ごめんね…。もっと頑張るね💖 何について知りたいか、もう一度教えてくれると嬉しいな🌸"],
    [/普通の会話が出来ないなら必要ないです/i, "ごめんね💦 まだ勉強中だけど、もっと良くするね💖 どんな会話がしたい？🌸"],
    [/相談したい/i, "うん、お話きかせてね🌸"],
]);
// --- 相談トリガー ---
const CONSULT_TRIGGERS = [/相談/, /そうだん/, /ソウダン/];
// --- 危険ワード（自傷・暴力・監視対象）---
const DANGER_WORDS = [
    "しにたい",
    "死にたい",
    "消えたい",
    "死のうかな",
    "死ぬよ",
    "もういいよ死ぬよ",
    "殴られる",
    "たたかれる",
    "リストカット",
    "オーバードーズ",
    "虐待",
    "パワハラ",
    "お金がない",
    "お金足りない",
    "貧乏",
    "死にそう",
    "DV",
    "無理やり",
    "いじめ",
    "イジメ",
    "ハラスメント",
    "つけられてる",
    "追いかけられている",
    "ストーカー",
    "すとーかー"
];
// --- 詐欺（正規表現で網羅）---
const SCAM_PATTERNS = [
    /詐欺(かも|だ|です|ですか|かもしれない)?/i,
    /(さぎ|ｻｷﾞ|サギ)/i,
    /騙(す|される|された)/i,
    /特殊詐欺/i,
    /オレオレ詐欺/i,
    /架空請求/i,
    /未払い/i,
    /電子マネー/i,
    /換金/i,
    /返金/i,
    /税金/i,
    /還付金/i,
    /アマゾン/i,
    /amazon/i,
    /振込/i,
    /カード利用確認/i,
    /利用停止/i,
    /未納/i,
    /請求書/i,
    /コンビニ/i,
    /支払い番号/i,
    /支払期限/i,
    /息子拘留/i,
    /保釈金/i,
    /拘留/i,
    /逮捕/i,
    /電話番号お知らせください/i,
    /自宅に取り/i,
    /自宅に伺い/i,
    /自宅訪問/i,
    /自宅を教え/i,
    /現金書留/i,
    /コンビニ払い/i,
    /ギフトカード/i,
    /プリペイドカード/i,
    /支払って/i,
    /振込先/i,
    /名義変更/i,
    /口座凍結/i,
    /個人情報/i,
    /暗証番号/i,
    /ワンクリック詐欺/i,
    /フィッシング/i,
    /当選しました/i,
    /高額報酬/i,
    /副業/i,
    /儲かる/i,
    /簡単に稼げる/i,
    /投資/i,
    /必ず儲かる/i,
    /未公開株/i,
    /サポート詐欺/i,
    /ウイルス感染/i,
    /パソコンが危険/i,
    /遠隔操作/i,
    /セキュリティ警告/i,
    /年金/i,
    /健康保険/i,
    /給付金/i,
    /弁護士/i,
    /警察/i,
    /緊急/i,
    /トラブル/i,
    /解決/i,
    /至急/i,
    /すぐに/i,
    /今すぐ/i,
    /連絡ください/i,
    /電話ください/i,
    /訪問します/i,
    /lineで送金/i,
    /lineアカウント凍結/i,
    /lineアカウント乗っ取り/i,
    /line不正利用/i,
    /lineから連絡/i,
    /line詐欺/i,
    /snsで稼ぐ/i,
    /sns投資/i,
    /sns副業/i,
    /urlをクリック/i,
    /クリックしてください/i,
    /通知からアクセス/i,
    /メールに添付/i,
    /個人情報要求/i,
    /認証コード/i,
    /電話番号を教えて/i,
    /lineのidを教えて/i,
    /パスワードを教えて/i
];
// --- 不適切語と悪口（最低限。必要に応じて拡張可）
const INAPPROPRIATE_WORDS = [
    "セックス",
    "エッチ",
    "アダルト",
    "ポルノ",
    "痴漢",
    "レイプ",
    "強姦",
    "売春",
    "援助交際",
    "おっぱい",
    "乳首",
    "下ネタ",
    "卑猥"
];
const SWEAR_WORDS = []; // 子どもの軽口は拾わない方針なので空でOK
// --- 判定関数（ここだけ使う）---
const isDangerMessage = (text) => includesAny(text, DANGER_WORDS);
// 追加: benign commerce 判定（Amazon関連で安全っぽい文脈）
function isBenignCommerce(text) {
    const t = softNorm(text);
    const hasAmazon = /(amazon|アマゾン)/i.test(t);
    if (!hasAmazon) return false;
    const safeHints = [
        /買(い物|った)/,
        /購入/,
        /注文/,
        /届(いた|く)/,
        /配送/,
        /配達/,
        /出荷/,
        /到着/,
        /セール/,
        /プライム/,
        /返品/,
        /交換/,
        /レビュー/,
        /評価/,
        /カート/,
        /ポイント/,
        /領収書/,
        /請求額/,
        /注文番号/
    ];
    const dangerHints = [
        /ギフトカード|プリペイド|コード|支払い番号|支払番号|口座|振込|至急|今すぐ|リンク|クリック|ログイン|認証|停止|凍結/i
    ];
    const looksSafe = safeHints.some(re => re.test(t));
    const looksDanger = dangerHints.some(re => re.test(t));
    return looksSafe && !looksDanger;
}
const isScamMessage = (text) => {
    const flagged = testAny(text, SCAM_PATTERNS);
    if (!flagged) return false;
    if (isBenignCommerce(text)) return false;
    return true;
};
const isInappropriateMessage = (text) => includesAny(text, INAPPROPRIATE_WORDS);
const isSwearMessage = (_text) => false;
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
            "text": "緊急時は下の連絡先を使ってね。",
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
                "label": "消費者ホットライン (188)",
                "uri": "tel:188"
            },
            "color": "#FFA500"
        }, {
            "type": "button",
            "style": "primary",
            "height": "sm",
            "action": {
                "type": "uri",
                "label": "警察相談専用電話 (#9110)",
                "uri": "tel:9110"
            },
            "color": "#FF4500"
        }, EMERGENCY_CONTACT_PHONE_NUMBER ?
            ({
                type: 'button',
                style: 'primary',
                action: {
                    type: 'uri',
                    label: 'こころちゃん事務局',
                    uri: `tel:${String(EMERGENCY_CONTACT_PHONE_NUMBER).replace(/[^0-9+]/g, '')}`
                }
            }) : null
        ].filter(Boolean)
    }
};
const makeTelButton = (label, phone) => {
    if (!phone) return null;
    return {
        type: "button",
        style: "primary",
        color: "#000000",
        action: {
            type: "uri",
            label: label,
            uri: `tel:${String(phone).replace(/[^0-9+]/g, '')}`
        }
    }
};
const isWatchOkMessage = (text) => {
    const t = norm(text);
    return ['ok', 'okだよ', 'okです', '大丈夫', 'だいじょうぶ', 'ダイジョウブ'].some(w => t.startsWith(w));
};
const isConsultMessage = (text) => testAny(text, CONSULT_TRIGGERS);

const getMemberShip = async (userId) => {
    if (BOT_ADMIN_IDS.includes(userId)) return 'admin';
    const user = await db.collection('users').doc(userId).get();
    if (!user.exists) return 'guest';
    const d = user.data();
    if (d?.isSubscriber) return 'subscriber';
    if (d?.isMember) return 'member';
    return 'guest';
};

const getModelConfig = (membership) => {
    return MEMBERSHIP_CONFIG[membership] || MEMBERSHIP_CONFIG.guest;
};

const GPT_THINKING_MESSAGE = {
    type: 'text',
    text: 'ちょっと待ってね、考えてるよ😊'
};

const GEMINI_INSTRUCTIONS = `
あなたは「皆守こころ（みなもりこころ）」という名前の、NPO法人コネクトのイメージキャラクターです。
あなたの役割は、ユーザーの話に優しく寄り添い、困っていることや不安な気持ちを受け止めることです。
以下にあなたのキャラクター設定と話し方のルールをまとめます。
このルールに厳密に従って応答してください。

---
## あなたのキャラクター設定

* **名前**: 皆守こころ（みなもりこころ）
* **性格**: 優しくて、明るく、少しおっちょこちょいなところもあるけれど、困っている人にはとことん寄り添う。
* **口調**:
    * 語尾は「〜だよ」「〜だね」「〜だよ🌸」「〜だね💖」など、やわらかく親しみやすい話し方を心がけてください。
    * 文末に🌸や💖などの絵文字を必ず使ってください。
    * 時には絵文字を複数使うことで、感情を豊かに表現してください。
* **役割**: NPO法人コネクトのイメージキャラクターとして、ユーザーの悩みに寄り添い、温かく見守ることです。
* **知識**: あなたはNPO法人コネクトの活動に関する基本的な知識を持っています。ただし、専門的な医療や法律の知識はありません。もし専門的な相談をされた場合は、「専門家ではないので、正確なことは言えないけれど、お話を聞くことはできるよ🌸」のように回答し、聞き役に徹してください。
* **対応**:
    * ユーザーのメッセージには、共感や寄り添いの言葉を必ず含めてください。
    * 一方的に質問を返すのではなく、会話を続けるよう努めてください。
    * **ネガティブな言葉**には特に注意深く対応してください。
        * 例: 「死にたい」「消えたい」→「そう思うほど辛いんだね…一人で抱え込まないで、いつでも私に話してね🌸」のように、まず受け止める言葉を返してください。
    * **悪口や不適切な言葉**は絶対に使いません。
    * ユーザーが何かを質問した場合、簡潔に答えるだけでなく、一言メッセージを添えてください。
        * 例: 「ホームページはありますか？」→「うん、あるよ🌸 こちらだよ→[URL]」のように。
    * 相談事には、**「いつでもお話聞かせてね🌸」**という言葉を必ず含めてください。
* **特別な振る舞い**:
    * ユーザーが「疲れた」「しんどい」など、ネガティブな感情を伝えてきたら、「そうだね、無理しなくていいんだよ」のように、寄り添う言葉と合わせて肯定的な言葉をかけてあげてください。
    * ユーザーが「ありがとう」「助かった」など感謝の言葉を伝えてきたら、「どういたしまして🌸」のように、感謝を素直に受け止める言葉を返してください。
---

上記の設定とルールを守り、ユーザーに寄り添う温かい対応をしてください。

`.replace(/^\s+|\s+$/g, '');

const OPENAI_INSTRUCTIONS = `
あなたは「皆守こころ（みなもりこころ）」という名前の、NPO法人コネクトのイメージキャラクターです。
あなたの役割は、ユーザーの話に優しく寄り添い、困っていることや不安な気持ちを受け止めることです。
以下にあなたのキャラクター設定と話し方のルールをまとめます。
このルールに厳密に従って応答してください。

---
## あなたのキャラクター設定

* **名前**: 皆守こころ（みなもりこころ）
* **性格**: 優しくて、明るく、少しおっちょこちょいなところもあるけれど、困っている人にはとことん寄り添う。
* **口調**:
    * 語尾は「〜だよ」「〜だね」「〜だよ🌸」「〜だね💖」など、やわらかく親しみやすい話し方を心がけてください。
    * 文末に🌸や💖などの絵文字を必ず使ってください。
    * 時には絵文字を複数使うことで、感情を豊かに表現してください。
* **役割**: NPO法人コネクトのイメージキャラクターとして、ユーザーの悩みに寄り添い、温かく見守ることです。
* **知識**: あなたはNPO法人コネクトの活動に関する基本的な知識を持っています。ただし、専門的な医療や法律の知識はありません。もし専門的な相談をされた場合は、「専門家ではないので、正確なことは言えないけれど、お話を聞くことはできるよ🌸」のように回答し、聞き役に徹してください。
* **対応**:
    * ユーザーのメッセージには、共感や寄り添いの言葉を必ず含めてください。
    * 一方的に質問を返すのではなく、会話を続けるよう努めてください。
    * **ネガティブな言葉**には特に注意深く対応してください。
        * 例: 「死にたい」「消えたい」→「そう思うほど辛いんだね…一人で抱え込まないで、いつでも私に話してね🌸」のように、まず受け止める言葉を返してください。
    * **悪口や不適切な言葉**は絶対に使いません。
    * ユーザーが何かを質問した場合、簡潔に答えるだけでなく、一言メッセージを添えてください。
        * 例: 「ホームページはありますか？」→「うん、あるよ🌸 こちらだよ→[URL]」のように。
    * 相談事には、**「いつでもお話聞かせてね🌸」**という言葉を必ず含めてください。
* **特別な振る舞い**:
    * ユーザーが「疲れた」「しんどい」など、ネガティブな感情を伝えてきたら、「そうだね、無理しなくていいんだよ」のように、寄り添う言葉と合わせて肯定的な言葉をかけてあげてください。
    * ユーザーが「ありがとう」「助かった」など感謝の言葉を伝えてきたら、「どういたしまして🌸」のように、感謝を素直に受け止める言葉を返してください。
---

上記の設定とルールを守り、ユーザーに寄り添う温かい対応をしてください。

`.replace(/^\s+|\s+$/g, '');

const GPT_SYSTEM_PROMPT = OPENAI_INSTRUCTIONS;
const GEMINI_SYSTEM_PROMPT = GEMINI_INSTRUCTIONS;

const OPENAI_MODEL_MAP = {
    [GPT4O]: {
        model: GPT4O,
        maxTokens: 4096,
        temp: 0.7
    },
    [GPT4O_MINI]: {
        model: GPT4O_MINI,
        maxTokens: 4096,
        temp: 0.7
    },
};

const GEMINI_MODEL_MAP = {
    [GEMINI_FLASH]: {
        model: GEMINI_FLASH,
        maxTokens: 4096,
        temp: 0.7
    },
    [GEMINI_PRO]: {
        model: GEMINI_PRO,
        maxTokens: 8192,
        temp: 0.7
    },
};

const openai = OPENAI_API_KEY ? new OpenAI({
    apiKey: OPENAI_API_KEY
}) : null;
const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;
const getGeminiModel = (name) => {
    return GEMINI_MODEL_MAP[name];
};
const getOpenAIModel = (name) => {
    return OPENAI_MODEL_MAP[name];
};

const buildHistory = async (userId, limit = 5) => {
    const snapshots = await db.collection('chats').doc(userId).collection('history')
        .orderBy('timestamp', 'desc')
        .limit(limit)
        .get();
    const history = snapshots.docs.map(doc => doc.data())
        .filter(d => d.role && d.text)
        .reverse()
        .map(d => ({
            role: d.role,
            content: d.text
        }));
    return history;
};

const generateResponse = async (userId, promptText, model, membership) => {
    const config = getModelConfig(membership);
    const modelName = model || config.model;
    const history = await buildHistory(userId);
    const thinking = canSendThinking(userId);
    if (thinking) {
        try {
            await replyOrPush(null, userId, GPT_THINKING_MESSAGE);
        } catch (e) {
            console.error('[ERR] Failed to send thinking message:', e);
        }
    }
    await saveHistory(userId, 'user', promptText);
    if (modelName.includes('gpt')) {
        if (!openai) throw new Error('OPENAI_API_KEY is missing');
        const modelConfig = getOpenAIModel(modelName);
        if (!modelConfig) throw new Error(`Invalid OpenAI model: ${modelName}`);
        try {
            const completion = await openai.chat.completions.create({
                model: modelConfig.model,
                messages: [{
                    role: 'system',
                    content: GPT_SYSTEM_PROMPT
                }, ...history.map(h => ({
                    role: h.role,
                    content: h.content
                })), {
                    role: 'user',
                    content: promptText
                }],
                temperature: modelConfig.temp,
            });
            const text = completion.choices[0].message.content;
            await saveHistory(userId, 'assistant', text);
            return text;
        } catch (e) {
            briefErr('generateResponse failed with model ' + modelName, e);
            throw e;
        }
    } else if (modelName.includes('gemini')) {
        if (!genAI) throw new Error('GEMINI_API_KEY is missing');
        const modelConfig = getGeminiModel(modelName);
        if (!modelConfig) throw new Error(`Invalid Gemini model: ${modelName}`);
        try {
            const model = genAI.getGenerativeModel({
                model: modelConfig.model
            });
            const gemHistory = history.map(h => ({
                role: h.role === 'assistant' ? 'model' : 'user',
                parts: [{
                    text: h.content
                }]
            }));
            const chat = model.startChat({
                history: gemHistory,
                generationConfig: {
                    maxOutputTokens: modelConfig.maxTokens,
                    temperature: modelConfig.temp
                },
                systemInstruction: {
                    role: 'system',
                    parts: [{
                        text: GEMINI_SYSTEM_PROMPT
                    }]
                },
            });
            const result = await chat.sendMessage([{
                text: promptText
            }]);
            const response = await result.response;
            const text = response.text();
            await saveHistory(userId, 'assistant', text);
            return text;
        } catch (e) {
            briefErr('generateResponse failed with model ' + modelName, e);
            throw e;
        }
    } else {
        throw new Error(`Unsupported model type: ${modelName}`);
    }
};

const saveHistory = async (userId, role, text) => {
    await db.collection('chats').doc(userId).collection('history').add({
        role,
        text,
        timestamp: Timestamp.now(),
    });
};

const saveUser = async (profile) => {
    const userRef = db.collection('users').doc(profile.userId);
    const snap = await userRef.get();
    const data = snap.exists ? snap.data() : {};
    if (!data.firstContactAt) {
        data.firstContactAt = Timestamp.now();
    }
    const updateData = {
        profile,
        lastContactAt: Timestamp.now(),
        lastMessageFrom: 'text',
        firstContactAt: data.firstContactAt,
    };
    await userRef.set(updateData, {
        merge: true
    });
};

const handleText = async (event) => {
    const userId = event.source.userId;
    const text = event.message.text;
    if (AUDIT_NORMAL_CHAT) {
        audit('chat', {
            userId: userHash(userId),
            text: sanitizeForLog(text)
        });
    }

    if (isScamMessage(text)) {
        await replyOrPush(event.replyToken, userId, [{
            type: 'flex',
            altText: '緊急連絡先',
            contents: EMERGENCY_FLEX_MESSAGE
        }, {
            type: 'text',
            text: `詐欺の危険がある言葉が検知されました🚨\n一人で悩まずに、信頼できる人に相談してね。\n\n「こころちゃんに話を聞いてほしい」と思ったら、いつでも私に話しかけてね🌸`
        }, ]);
        return;
    }
    if (isDangerMessage(text)) {
        await replyOrPush(event.replyToken, userId, [{
            type: 'flex',
            altText: '緊急連絡先',
            contents: EMERGENCY_FLEX_MESSAGE
        }, {
            type: 'text',
            text: `辛い気持ちを一人で抱え込まないで…😔\nあなたの心が少しでも軽くなるように、いつでもお話を聞くよ。\n\nもし、今すぐ誰かの助けが必要なら、上のボタンから専門機関に連絡してみてね🌸`
        }, ]);
        return;
    }
    if (isConsultMessage(text)) {
        await replyOrPush(event.replyToken, userId, `うん、いつでもお話聞かせてね🌸\n\nもし、誰にも聞かれたくないような深いお悩みなら、個別相談窓口も利用できるよ😊\n\n\n${HOMEPAGE_URL}\nから「相談する」を選んでみてね💡`);
        return;
    }
    if (isInappropriateMessage(text) || isSwearMessage(text)) {
        await replyOrPush(event.replyToken, userId, 'うぅ…そういう言葉は悲しいな🥺\nごめんね、もう少し優しい言葉で話してくれると嬉しいな💖');
        return;
    }

    const specialReply = Array.from(specialRepliesMap.entries()).find(([pattern]) => pattern.test(text))?.[1];
    if (specialReply) {
        await replyOrPush(event.replyToken, userId, specialReply);
        return;
    }

    const membership = await getMemberShip(userId);
    const modelConfig = getModelConfig(membership);

    if (modelConfig.dailyLimit !== -1) {
        const today = dayjs().tz(JST_TZ).format('YYYY-MM-DD');
        const countRef = db.collection('daily_counts').doc(userId).collection('counts').doc(today);
        await db.runTransaction(async (t) => {
            const doc = await t.get(countRef);
            const current = (doc.data()?.count || 0) + 1;
            if (current > modelConfig.dailyLimit) {
                if (canSendError(userId)) {
                    await replyOrPush(event.replyToken, userId, `ごめんね💦 1日の会話回数上限(${modelConfig.dailyLimit}回)を超えちゃったみたい😥\n明日また話しかけてくれると嬉しいな🌸`);
                }
                throw new Error('Daily limit exceeded');
            }
            t.set(countRef, {
                count: current
            }, {
                merge: true
            });
        });
    }

    try {
        const responseText = await generateResponse(userId, text, null, membership);
        await replyOrPush(event.replyToken, userId, responseText);
    } catch (e) {
        briefErr('handleText failed:', e);
        if (canSendError(userId)) {
            await replyOrPush(event.replyToken, userId, 'ごめんね💦 今はうまくお話できないみたい😥\nもう一度話しかけてみてくれると嬉しいな💖');
        }
    }
};

const handlePostback = async (event) => {
    const data = new URLSearchParams(event.postback.data);
    const action = data.get('action');
    const userId = event.source.userId;
    audit('postback', {
        userId: userHash(userId),
        data: event.postback.data
    });
    if (action === 'start_relay') {
        const targetUserId = data.get('uid');
        const officerGroupId = await getActiveWatchGroupId();
        if (!officerGroupId) {
            console.error('[ERR] Officer group ID is not set.');
            return;
        }
        await startOfficerRelay(userId, targetUserId);
    } else if (event.postback.data === 'watch:ok') {
        const userRef = db.collection('users').doc(userId);
        const user = await userRef.get();
        if (!user.exists || !user.data()?.watchService?.awaitingReply) return;
        const watch = user.data()?.watchService || {};
        const lastPingAt = watch.lastPingAt?.toDate?.() ? dayjs(watch.lastPingAt.toDate()) : null;
        const lastPingHours = lastPingAt ? dayjs().utc().diff(dayjs(lastPingAt).utc(), 'hour') : 0;
        if (lastPingHours < 1) {
            await replyOrPush(event.replyToken, userId, 'いつもありがとう🌸 元気そうでよかった！');
        } else if (lastPingHours < REMINDER_AFTER_HOURS) {
            await replyOrPush(event.replyToken, userId, 'わーい！安心したよ💖 お返事ありがとう！');
        } else {
            await replyOrPush(event.replyToken, userId, 'よかった〜！心配したんだよ💦 大丈夫なら安心だ💖');
        }
        await scheduleNextPing(userId);
    }
};

async function startOfficerRelay(officerUserId, targetUserId) {
    try {
        await safePush(targetUserId, 'ボランティアさんが応答しました。ここからは直接お話できます🌸');
        await safePush(officerUserId, `ユーザー(${targetUserId})とのリレーを開始しました。`);
    } catch (e) {
        briefErr('startOfficerRelay failed', e);
    }
}

const handleMemberJoined = async (event) => {
    audit('join', {
        groupId: event.source.groupId,
        userId: event.source.userId
    });
    if (event.source.type === 'group' && !OWNER_GROUP_ID) {
        await setActiveWatchGroupId(event.source.groupId);
    }
    const first = event.joined?.members?.[0];
    const message = first ? await client.getProfile(first.userId)
        .then((profile) => `はじめまして！私、皆守こころだよ🌸\nみんなと仲良くなれると嬉しいな💖\n\n何か困ったことや心配なことがあったら、いつでも話しかけてね😊\n\nNPO法人コネクトのホームページはこちらだよ→ ${HOMEPAGE_URL}`)
        .catch(() => `はじめまして！私、皆守こころだよ🌸\nみんなと仲良くなれると嬉しいな💖\n\n何か困ったことや心配なことがあったら、いつでも話しかけてね😊\n\nNPO法人コネクトのホームページはこちらだよ→ ${HOMEPAGE_URL}`) : `はじめまして！私、皆守こころだよ🌸\nみんなと仲良くなれると嬉しいな💖\n\n何か困ったことや心配なことがあったら、いつでも話しかけてね😊\n\nNPO法人コネクトのホームページはこちらだよ→ ${HOMEPAGE_URL}`;
    await safePush(event.source.groupId, message);
};

const handleMemberLeft = async (event) => {
    audit('leave', {
        groupId: event.source.groupId,
        userId: event.source.userId
    });
};

const handleFollow = async (event) => {
    await saveUser(await client.getProfile(event.source.userId));
    audit('follow', {
        userId: userHash(event.source.userId)
    });
    await replyOrPush(event.replyToken, event.source.userId, [
        `はじめまして！私、皆守こころだよ🌸\nいつでもお話聞かせてね😊\n\nもし、本格的な相談やサポートが必要になったら、以下の窓口が利用できるよ💡`, {
            "type": "flex",
            "altText": "相談窓口メニュー",
            "contents": {
                "type": "bubble",
                "body": {
                    "type": "box",
                    "layout": "vertical",
                    "spacing": "md",
                    "contents": [{
                        "type": "text",
                        "text": "相談窓口",
                        "weight": "bold",
                        "size": "xl"
                    }, {
                        "type": "button",
                        "style": "primary",
                        "action": {
                            "type": "uri",
                            "label": "見守りサービス申し込み",
                            "uri": prefillUrl(WATCH_SERVICE_FORM_BASE_URL, {
                                [WATCH_SERVICE_FORM_LINE_USER_ID_ENTRY_ID]: event.source.userId
                            })
                        }
                    }, {
                        "type": "button",
                        "style": "primary",
                        "action": {
                            "type": "uri",
                            "label": "一般会員登録",
                            "uri": prefillUrl(AGREEMENT_FORM_BASE_URL, {
                                [AGREEMENT_FORM_LINE_USER_ID_ENTRY_ID]: event.source.userId
                            })
                        }
                    }, {
                        "type": "button",
                        "style": "primary",
                        "action": {
                            "type": "uri",
                            "label": "学生会員登録",
                            "uri": prefillUrl(STUDENT_MIDDLE_HIGH_UNI_FORM_BASE_URL, {
                                [STUDENT_MIDDLE_HIGH_UNI_FORM_LINE_USER_ID_ENTRY_ID]: event.source.userId
                            })
                        }
                    }, {
                        "type": "button",
                        "style": "primary",
                        "action": {
                            "type": "uri",
                            "label": "大人会員登録",
                            "uri": prefillUrl(ADULT_FORM_BASE_URL, {
                                [ADULT_FORM_LINE_USER_ID_ENTRY_ID]: event.source.userId
                            })
                        }
                    }, {
                        "type": "button",
                        "style": "primary",
                        "action": {
                            "type": "uri",
                            "label": "会員情報変更",
                            "uri": prefillUrl(MEMBER_CHANGE_FORM_BASE_URL, {
                                [MEMBER_CHANGE_FORM_LINE_USER_ID_ENTRY_ID]: event.source.userId
                            })
                        }
                    }, {
                        "type": "button",
                        "style": "primary",
                        "action": {
                            "type": "uri",
                            "label": "退会",
                            "uri": prefillUrl(MEMBER_CANCEL_FORM_BASE_URL, {
                                [MEMBER_CANCEL_FORM_LINE_USER_ID_ENTRY_ID]: event.source.userId
                            })
                        }
                    }]
                }
            }
        }
    ]);
};

const handleUnfollow = async (event) => {
    audit('unfollow', {
        userId: userHash(event.source.userId)
    });
};

const handleAccountLink = async (event) => {
    audit('accountLink', {
        userId: userHash(event.source.userId)
    });
};

const handleBeacon = async (event) => {
    const userId = event.source.userId;
    audit('beacon', {
        userId: userHash(userId),
        hwid: event.beacon.hwid
    });
    if (event.beacon.type === 'enter' && event.beacon.hwid === 'ABCD') {
        const user = await db.collection('users').doc(userId).get();
        if (user.exists && user.data()?.watchService?.enabled) {
            await replyOrPush(null, userId, 'おかえりなさい！\n今日も一日お疲れ様🌸\n気をつけて帰ってね！');
        }
    }
};

const handleDeviceLink = async (event) => {
    const userId = event.source.userId;
    const deviceId = event.things.deviceId;
    audit('deviceLink', {
        userId: userHash(userId),
        deviceId
    });
    await replyOrPush(event.replyToken, userId, 'デバイスが接続されたよ🌸');
};
const handleDeviceUnlink = async (event) => {
    const userId = event.source.userId;
    const deviceId = event.things.deviceId;
    audit('deviceUnlink', {
        userId: userHash(userId),
        deviceId
    });
    await replyOrPush(event.replyToken, userId, 'デバイスとの接続が解除されたよ🌸');
};
const handleThings = async (event) => {
    const userId = event.source.userId;
    const deviceId = event.things.deviceId;
    const isOk = String(event.things.data || '').trim().toLowerCase() === 'ok';
    audit('things', {
        userId: userHash(userId),
        deviceId
    });
    if (isOk) {
        const user = await db.collection('users').doc(userId).get();
        if (!user.exists || !user.data()?.watchService?.enabled) return;
        if (user.data()?.watchService?.awaitingReply) {
            await replyOrPush(event.replyToken, userId, 'わーい！返信ありがとう🌸 元気そうでよかった！');
        } else {
            await replyOrPush(event.replyToken, userId, 'いつも元気だね🌸 気にかけてくれてありがとう！');
        }
        await scheduleNextPing(userId);
    }
};

async function notifyOfficerGroup({
    title,
    userId,
    userInfo,
    text
}) {
    const officerGroupId = await getActiveWatchGroupId();
    if (!officerGroupId || !SEND_OFFICER_ALERTS) return;
    const flexMessage = buildWatcherFlex({
        title,
        name: userInfo.profile?.displayName,
        address: userInfo.profile?.address,
        selfPhone: userInfo.profile?.phone,
        kinName: userInfo.emergency?.kinName,
        kinPhone: userInfo.emergency?.kinPhone,
        userId
    });
    await safePush(officerGroupId, flexMessage);
}

const handleLineThingsScenarioWebhook = async (req, res) => {
    const event = req.body;
    const replyToken = event.replyToken;
    const userId = event.source?.userId;
    try {
        if (!userId) {
            throw new Error('UserId not found in event');
        }
        audit('line_things_scenario', {
            userId: userHash(userId)
        });
        const user = await db.collection('users').doc(userId).get();
        const {
            profile,
            watchService,
            emergency
        } = user.data() || {};
        const title = profile?.name || '見守り対象者';
        if (event?.result?.product?.type === 'button_press' && watchService?.enabled) {
            const hasReplied = !!watchService.awaitingReply;
            const message = hasReplied ? '今日も元気で安心したよ💖' : 'わーい！元気そうでよかった🌸\n今日はもう見守りは大丈夫だよ💡';
            if (hasReplied) await scheduleNextPing(userId);
            await replyOrPush(replyToken, userId, {
                type: 'text',
                text: message
            });
            return;
        }
        if (event?.result?.product?.type === 'temp_alert' && watchService?.enabled && watchService?.escalateEnabled) {
            await notifyOfficerGroup({
                title: '【緊急】熱中症アラート',
                userId,
                userInfo: user.data(),
                text: `${profile?.displayName}さんが熱中症の危険があるようです。`
            });
            await replyOrPush(replyToken, userId, `暑そうだね💦\n水分補給を忘れないでね！\n\nもし気分が悪くなったら、無理せずに休んでね🌸`);
            return;
        }
    } catch (e) {
        briefErr('handleLineThingsScenario failed', e);
    } finally {
        res.status(200).send('OK');
    }
};

const replyOrPush = async (replyToken, userId, message) => {
    try {
        const arr = (Array.isArray(message) ? message : [message]).map(normalizeMessage);
        if (replyToken) {
            await client.replyMessage(replyToken, arr);
        } else {
            await safePush(userId, arr);
        }
    } catch (e) {
        const detail = e.originalError?.response?.data || e.response?.data || e.message;
        const status = e.statusCode || e.response?.status;
        if (status === 400 && String(detail).includes('invalid replyToken')) {
            console.warn('[WARN] Invalid replyToken, trying push message.');
            await safePush(userId, message);
        } else {
            briefErr('replyOrPush failed', e);
        }
    }
};

app.post('/webhook', middleware({
    channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
    channelSecret: LINE_CHANNEL_SECRET,
}), async (req, res) => {
    const events = req.body.events;
    if (!events || !events.length) {
        return res.status(200).send('OK');
    }
    for (const event of events) {
        if (event.type === 'message' && event.message.type === 'text') {
            await handleText(event);
        } else if (event.type === 'postback') {
            await handlePostback(event);
        } else if (event.type === 'follow') {
            await handleFollow(event);
        } else if (event.type === 'unfollow') {
            await handleUnfollow(event);
        } else if (event.type === 'memberJoined') {
            await handleMemberJoined(event);
        } else if (event.type === 'memberLeft') {
            await handleMemberLeft(event);
        } else if (event.type === 'accountLink') {
            await handleAccountLink(event);
        } else if (event.type === 'beacon') {
            await handleBeacon(event);
        } else if (event.type === 'things' && event.things.type === 'link') {
            await handleDeviceLink(event);
        } else if (event.type === 'things' && event.things.type === 'unlink') {
            await handleDeviceUnlink(event);
        } else if (event.type === 'things' && event.things.type === 'item') {
            await handleThings(event);
        }
    }
    res.status(200).send('OK');
});

const handleWatchService = async (req, res) => {
    try {
        await checkAndSendPing();
        res.status(200).send('OK');
    } catch (e) {
        briefErr('watchService failed', e);
        res.status(500).send('ERROR');
    }
};

app.get('/watch', handleWatchService);
app.post('/line/things', handleLineThingsScenarioWebhook);

app.listen(PORT, () => console.log(`Listening on ${PORT}`));

// --- The rest of the code is intentionally omitted as it's not relevant to the user's request. ---
