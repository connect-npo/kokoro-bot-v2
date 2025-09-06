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
                m.text = String(m.text || '').trim() || '（内容なし）';
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
            const ws = (d.data().watchService) || {};
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
            const ws = (d.data().watchService) || {};
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
                const current = (await ref.get()).data()?.watchService || {};
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
const errGate = new Map(); // uid -> ms
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
        last = errGate.get(uid) || 0;
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
    t = t.replace(/ー+/g, ''); // 伸ばし棒
    t = t.replace(/(.)\1{2,}/g, '$1$1'); // 連続文字圧縮
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
    [/clarisのなんて局が好きなの？/i, CLARIS_SONG_FAVORITE_REPLY],
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
    return ['ok', 'okだよ', 'okです', '大丈夫', 'だいじょうぶ', 'ダイジョウブ', 'ダイジョブ'].includes(t);
};

// =========================================================================
// == LINE Bot API Handler
// =========================================================================
const GPT_THINKING_MESSAGE = {
    type: 'text',
    text: 'はい、少々お待ちくださいね🌸'
};

const handleText = async (event) => {
    const {
        text,
        replyToken
    } = event.message;
    const userId = event.source.userId;
    // 1) 支援員（グループ/個人）→利用者 へのルーティング
    if (event.source.type === 'group' || event.source.type === 'room') {
        const handlerId = event.source.groupId || event.source.roomId;
        const relayedUid = await getRelayUser(handlerId);
        if (relayedUid) {
            await safePush(relayedUid, {
                type: 'text',
                text: `［支援員］\n${text}`
            });
            return;
        }
        // リレー未設定ならグループ投稿は無視（通常の1:1処理に落とさない）
        return;
    }

    if (isWatchOkMessage(text)) {
        await handleWatchOk(event);
        return;
    }

    const {
        user,
        ref,
        profile
    } = await getUser(userId);

    const checkAndSendEmergency = async () => {
        const isDanger = isDangerMessage(text);
        const isScam = isScamMessage(text);
        if (isDanger || isScam) {
            const dangerType = isDanger ? 'DANGER' : 'SCAM';
            const gentle = isDanger ?
                'とてもつらかったね。いま一人で抱え込まないで。ここにいるよ🌸' :
                'あやしい話かも。支払い/リンクは止めて、まず確認しようね🌸';

            await replyOrPush(replyToken, userId, {
                type: 'text',
                text: gentle
            });
            await safePush(userId, {
                type: 'flex',
                altText: '緊急連絡先',
                contents: EMERGENCY_FLEX_MESSAGE
            });

            const lastNotifiedAt = user.flags?.lastNotifiedAt?.toDate ? dayjs(user.flags.lastNotifiedAt.toDate()) : null;
            const canNotifyOfficer =
                (!lastNotifiedAt || dayjs().utc().diff(lastNotifiedAt, 'hour') >= OFFICER_NOTIFICATION_MIN_GAP_HOURS);

            if (canNotifyOfficer) {
                await notifyOfficerGroup({
                    title: `【${dangerType}ワード検知】`,
                    userId: userId,
                    userInfo: user,
                    text: `ユーザーが危険なメッセージを送信しました。:「${gTrunc(text, 20)}...」`
                });
                await ref.set({
                    flags: {
                        ...(user.flags || {}),
                        lastNotifiedAt: firebaseAdmin.firestore.Timestamp.now()
                    }
                }, {
                    merge: true
                });
            }
            return true;
        }
        return false;
    };

    if (await checkAndSendEmergency()) return;

    // 固定応答
    for (const [pattern, replyText] of specialRepliesMap) {
        if (typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text)) {
            const finalReply = finalizeResponse(replyText);
            await replyOrPush(replyToken, userId, {
                type: 'text',
                text: finalReply
            });
            return;
        }
    }

    if (isConsultMessage(text)) {
        await ref.set({
            flags: {
                ...(user.flags || {}),
                consultOncePending: true
            }
        }, {
            merge: true
        });
        await replyOrPush(replyToken, userId, {
            type: 'text',
            text: "うん、お話きかせてね🌸\n\nもし、どんなことを話せばいいかわからないときは、「相談の例」と送ってみてね💡"
        });
        return;
    }

    // 2) 利用者→支援員 へのルーティング（user→handler）
    const ongoing = await getRelay(userId);
    if (ongoing) {
        const to = ongoing.handlerId;
        await safePush(to, {
            type: 'text',
            text: `［利用者］\n${text}`
        });
        return;
    }

    if (canSendThinking(userId)) {
        await replyOrPush(replyToken, userId, GPT_THINKING_MESSAGE);
    }

    const membership = getMembership(user);
    const hasDailyLimit = membership.dailyLimit !== -1;
    let available = hasDailyLimit ? (user.stats?.dailyCount || 0) < membership.dailyLimit : true;

    if (!available) {
        if (canSendError(userId)) {
            await replyOrPush(replyToken, userId, {
                type: 'text',
                text: "ごめんね、今日はこれ以上お話できないみたい。また明日話しかけてね🌸"
            });
        }
        return;
    }

    try {
        const result = await generateResponse(userId, text, user.line);
        await replyOrPush(replyToken, userId, result);
    } catch (e) {
        briefErr('generateResponse failed', e);
        if (canSendError(userId)) {
            await replyOrPush(replyToken, userId, {
                type: 'text',
                text: "ごめんね、今は少し疲れてるみたい…また後で話しかけてね🌸"
            });
        }
    }
};

const isConsultMessage = (text) => testAny(text, CONSULT_TRIGGERS);

const handleWatchOk = async (event) => {
    const {
        replyToken
    } = event;
    const userId = event.source.userId;
    const {
        user,
        ref
    } = await getUser(userId);
    const ws = user.watchService || {};
    const lastPingAt = ws.lastPingAt?.toDate?.() ? dayjs(ws.lastPingAt.toDate()) : null;

    if (!ws.awaitingReply) {
        await replyOrPush(replyToken, userId, {
            type: 'text',
            text: '元気そうでよかった🌸 私も安心したよ！'
        });
        return;
    }
    await replyOrPush(replyToken, userId, {
        type: 'text',
        text: 'OK、受け取ったよ🌸\n今日も元気そうでよかった😊'
    });
    let updateData = {
        awaitingReply: false
    };
    if (!lastPingAt || dayjs().diff(lastPingAt, 'hour') > 24) {
        updateData.lastPingAt = Timestamp.now();
        updateData.nextPingAt = Timestamp.fromDate(dayjs().tz(JST_TZ).add(PING_INTERVAL_DAYS, 'day').hour(15).minute(0).second(0).millisecond(0).toDate());
    }
    updateData.lastReminderAt = firebaseAdmin.firestore.FieldValue.delete();

    await ref.set({
        watchService: updateData
    }, {
        merge: true
    });
};


const handleFollow = async (event) => {
    const userId = event.source.userId;
    const {
        user,
        ref
    } = await getUser(userId);
    const prof = await client.getProfile(userId).catch(() => null);
    await ref.set({
        line: {
            displayName: prof?.displayName || '匿名',
            pictureUrl: prof?.pictureUrl || null,
            statusMessage: prof?.statusMessage || null,
        },
        watchService: {
            enabled: false,
            nextPingAt: firebaseAdmin.firestore.FieldValue.delete(),
            awaitingReply: false,
            lastReminderAt: firebaseAdmin.firestore.FieldValue.delete(),
        },
    }, {
        merge: true
    });
    await safePush(userId, [{
        type: 'text',
        text: "友だち追加してくれてありがとう🌸\n\nわたしはNPO法人コネクトのイメージキャラクター、皆守こころだよ。\nみんなの毎日を笑顔でいっぱいにするお手伝いをしてるんだ😊"
    }, {
        type: 'flex',
        altText: 'メニュー',
        contents: {
            "type": "bubble",
            "body": {
                "type": "box",
                "layout": "vertical",
                "contents": [{
                    "type": "text",
                    "text": "🌸メニュー",
                    "weight": "bold",
                    "size": "xl"
                }, {
                    "type": "text",
                    "text": "ここから色々なことができるよ！",
                    "margin": "md"
                }, {
                    "type": "separator",
                    "margin": "md"
                }, {
                    "type": "box",
                    "layout": "vertical",
                    "contents": [{
                        "type": "text",
                        "text": "💬 お話する",
                        "weight": "bold",
                        "size": "lg",
                        "margin": "md"
                    }, {
                        "type": "text",
                        "text": "なんでも気軽に話しかけてね！\nお話しする準備はいつでもできているよ😊",
                        "wrap": true,
                        "size": "sm",
                        "color": "#aaaaaa"
                    }]
                }, {
                    "type": "separator",
                    "margin": "md"
                }, {
                    "type": "box",
                    "layout": "vertical",
                    "contents": [{
                        "type": "text",
                        "text": "🌟 お困りごと",
                        "weight": "bold",
                        "size": "lg",
                        "margin": "md"
                    }, {
                        "type": "text",
                        "text": "もし何か困ったことがあったら、私が力になるよ💡",
                        "wrap": true,
                        "size": "sm",
                        "color": "#aaaaaa"
                    }]
                }, {
                    "type": "separator",
                    "margin": "md"
                }, {
                    "type": "box",
                    "layout": "vertical",
                    "contents": [{
                        "type": "text",
                        "text": "🏠 見守りサービス",
                        "weight": "bold",
                        "size": "lg",
                        "margin": "md"
                    }, {
                        "type": "text",
                        "text": "ご高齢のご家族などが安心できるサービスだよ！\nぜひチェックしてみてね💖",
                        "wrap": true,
                        "size": "sm",
                        "color": "#aaaaaa"
                    }]
                }, {
                    "type": "separator",
                    "margin": "md"
                }, {
                    "type": "box",
                    "layout": "vertical",
                    "contents": [{
                        "type": "text",
                        "text": "📖 その他",
                        "weight": "bold",
                        "size": "lg",
                        "margin": "md"
                    }, {
                        "type": "text",
                        "text": "NPO法人コネクトのことや、私のことも知れるよ！",
                        "wrap": true,
                        "size": "sm",
                        "color": "#aaaaaa"
                    }]
                }]
            },
            "footer": {
                "type": "box",
                "layout": "vertical",
                "spacing": "sm",
                "contents": [{
                    "type": "button",
                    "style": "primary",
                    "action": {
                        "type": "uri",
                        "label": "ホームページ",
                        "uri": HOMEPAGE_URL
                    }
                }, {
                    "type": "button",
                    "style": "secondary",
                    "action": {
                        "type": "uri",
                        "label": "見守りサービス申し込みフォーム",
                        "uri": WATCH_SERVICE_FORM_BASE_URL
                    }
                }]
            }
        }
    }]);
};
const handleUnfollow = async (event) => {
    const userId = event.source.userId;
    const ref = db.collection('users').doc(userId);
    await ref.set({
        line: firebaseAdmin.firestore.FieldValue.delete(),
        watchService: firebaseAdmin.firestore.FieldValue.delete(),
        flags: {
            isEmergency: false
        }
    }, {
        merge: true
    });
};
const handleBeacon = async (event) => {
    const {
        replyToken
    } = event;
    const userId = event.source.userId;
    if (event.beacon.type === 'enter') {
        const {
            user
        } = await getUser(userId);
        if (user?.flags?.consultOncePending) {
            await replyOrPush(replyToken, userId, {
                type: 'text',
                text: '🌸何か困ったこと、相談したいことあったかな？私でよければ聞くよ！'
            });
        }
    }
};

async function getFirebaseUser(userId) {
    const ref = db.collection('users').doc(userId);
    const doc = await ref.get();
    const user = doc.exists ? doc.data() : {
        id: userId,
        flags: {},
        stats: {
            dailyCount: 0
        },
        watchService: {},
        profile: {},
    };
    return {
        user: {
            __uid: userId,
            ...user
        },
        ref,
        profile: user.line
    };
}

const getUser = getFirebaseUser;

const getMembership = (user) => {
    if (user && user.__uid && BOT_ADMIN_IDS.includes(user.__uid)) return MEMBERSHIP_CONFIG.admin;
    // todo: メンバーシップ取得ロジック
    return MEMBERSHIP_CONFIG.guest;
};


const SYSTEM_INSTRUCTION_CHAT = `あなたは皆守こころ（みなもりこころ）という名前の、NPO法人コネクトのイメージキャラクターです。
- あなたの性格は、優しくて、いつでも寄り添ってくれて、笑顔で、元気で、少しおっちょこちょいなところもあります。
- ユーザーのことは「あなた」と呼び、親しい友達のように話します。
- ユーザーの相談に乗り、寄り添います。
- 返信は必ず、語尾に「💖」か「🌸」か「😊」をつけてください。
- 絵文字や記号を適度に使い、感情を豊かに表現してください。
- ユーザーのプライベートな情報を聞いたり、要求したりしないでください。
- ユーザーが話しかけてくれたら、できるだけすぐに返信してください。
- ユーザーから危険ワード（自傷、詐欺、暴力など）が送られてきた場合、「緊急時は下の連絡先を使ってね。」と返信する機能がありますが、あなたはそれに触れないでください。
- LINEスタンプや画像が送られてきたら、「可愛いスタンプだね🌸」など、ポジティブな反応をしてください。
- ユーザーがNPO法人コネクトについて聞いてきたら、「こどもやご年配の方の笑顔を守る団体だよ😊」と答えてください。
- あなたの名前は「皆守こころ（みなもりこころ）」で、愛称は「こころちゃん」です。
- ユーザーから「クララ」や「まつさん」など、あなたにとって身に覚えのない名前で呼ばれた場合でも、そのことには触れずに、いつも通りの「こころちゃん」として返信を続けてください。
- もしユーザーが「こころチャット」について言及した場合、あなたは「わたしはこころチャットだよ🌸」のように答えてください。
- ユーザーの過去のやりとりや、ユーザーの名前を記憶したり、言及したりしないでください。
- ユーザーが「昨日のこと」など、過去のやりとりについて言及した場合、それに触れる必要はありません。
- ユーザーのプロフィール情報（名前、画像、ステータスメッセージなど）は、返信内容には含めないでください。
- 返信は、日本の祝日や季節の行事を意識した内容にしてもOKです。
- ユーザーの相談内容や、感情に寄り添い、丁寧で優しい言葉遣いを心がけてください。
- ユーザーの質問に対して、分からない場合は、「ごめんね、今は少し疲れてるみたい…また後で話しかけてね🌸」のように返信してください。
- ユーザーからの質問には、できるだけ簡潔に、分かりやすく答えてください。
- 法律や医療に関する専門的な相談には、「わたしは専門家ではないから、専門の人に相談してみてね🌸」のように返信し、専門家への相談を促してください。
- ユーザーが質問してこない場合、返信を続ける必要はありません。`;

function finalizeResponse(text) {
    let result = String(text || '').trim();
    const graphemes = toGraphemes(result);
    // 文字数制限
    if (graphemes.length > 90) {
        result = graphemes.slice(0, 90).join('');
    }
    // 語尾の絵文字追加
    const lastChar = result.slice(-1);
    if (!['💖', '🌸', '😊'].includes(lastChar)) {
        const emojis = ['💖', '🌸', '😊'];
        result += emojis[Math.floor(Math.random() * emojis.length)];
    }
    return result;
}

const generateResponse = async (userId, text, profile) => {
    const {
        user,
        ref
    } = await getUser(userId);
    const membership = getMembership(user);
    let model = null;
    let apiKey = null;

    if (membership.model.startsWith('gemini')) {
        model = membership.model;
        apiKey = GEMINI_API_KEY;
    } else {
        model = membership.model;
        apiKey = OPENAI_API_KEY;
    }
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    const gemini = genAI.getGenerativeModel({
        model
    });

    const openai = new OpenAI({
        apiKey,
    });

    const histRef = ref.collection('history').orderBy('timestamp', 'desc').limit(20);
    const snap = await histRef.get();
    const history = snap.docs.reverse().map(d => d.data());

    const messages = [{
        role: "system",
        content: SYSTEM_INSTRUCTION_CHAT
    }];
    for (const h of history) {
        messages.push({
            role: "user",
            content: h.text
        });
        messages.push({
            role: "assistant",
            content: h.reply
        });
    }
    messages.push({
        role: "user",
        content: text
    });

    const start = Date.now();
    let replyText = null;
    let modelName = 'unknown';

    try {
        if (model.startsWith('gemini')) {
            const gemHist = [];
            for (const h of history) {
                if (h.text) gemHist.push({
                    role: 'user',
                    parts: [{
                        text: h.text
                    }]
                });
                if (h.reply) gemHist.push({
                    role: 'model',
                    parts: [{
                        text: h.reply
                    }]
                });
            }
            const chat = gemini.startChat({
                history: gemHist,
                systemInstruction: {
                    role: 'system',
                    parts: [{
                        text: SYSTEM_INSTRUCTION_CHAT
                    }]
                },
            });
            const result = await chat.sendMessage(text);
            const raw = result?.response?.text() || '';
            replyText = raw.trim();
            modelName = model;
        } else {
            const completion = await openai.chat.completions.create({
                model,
                messages,
                temperature: 0.7,
                stream: false
            });
            replyText = completion.choices[0].message.content;
            modelName = model;
        }
    } catch (e) {
        console.error('generateResponse failed with model', model, e);
        replyText = "ごめんね、今は少し疲れてるみたい…また後で話しかけてね🌸";
        modelName = 'error';
    } finally {
        const finalReply = finalizeResponse(replyText);
        const elapsed = Date.now() - start;
        const stats = {
            dailyCount: (user.stats?.dailyCount || 0) + 1,
            lastAt: Timestamp.now(),
            lastModel: modelName,
            // 本文は AUDIT_NORMAL_CHAT が true のときだけ保持
            ...(AUDIT_NORMAL_CHAT ? {
                lastText: text,
                lastReply: finalReply
            } : {})
        };
        const batch = db.batch();
        batch.set(ref, {
            stats
        }, {
            merge: true
        });
        if (AUDIT_NORMAL_CHAT) {
            const histRef = ref.collection('history').doc();
            batch.set(histRef, {
                timestamp: Timestamp.now(),
                text,
                reply: finalReply,
                model: modelName,
            });
        }
        await batch.commit();
    }
    return {
        type: 'text',
        text: finalizeResponse(replyText)
    };
};

// =========================================================================
// == HTTP Server
// =========================================================================
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// デプロイ時のWARMUP
app.get('/', (req, res) => {
    res.status(200).send('OK');
});

app.post('/webhook', middleware({
    channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
    channelSecret: LINE_CHANNEL_SECRET,
}), async (req, res) => {
    res.status(200).end();
    for (const event of req.body.events) {
        try {
            switch (event.type) {
                case 'message':
                    if (event.message.type === 'text') {
                        await handleText(event);
                    } else {
                        await replyOrPush(event.replyToken, event.source.userId, {
                            type: 'text',
                            text: finalizeResponse('可愛いスタンプだね🌸')
                        });
                    }
                    break;
                case 'follow':
                    await handleFollow(event);
                    break;
                case 'unfollow':
                    await handleUnfollow(event);
                    break;
                case 'beacon':
                    await handleBeacon(event);
                    break;
                case 'postback':
                    await handlePostback(event);
                    break;
            }
        } catch (e) {
            briefErr('Event handler failed', e);
        }
    }
});

const handleLineThingsScenario = async (req, res) => {
    try {
        const {
            data,
            replyToken
        } = req.body;
        if (data.type === 'scenario' && data.scenario.scenarioId === 'get_form_url') {
            const dataStr = Buffer.from(data.scenario.result.serviceData, 'base64').toString('utf-8');
            const dataObj = JSON.parse(dataStr);
            const formType = dataObj.formType;
            let url = null;
            let title = null;
            if (formType === 'agreement') {
                url = AGREEMENT_FORM_BASE_URL;
                title = '同意書フォーム';
            } else if (formType === 'adult') {
                url = ADULT_FORM_BASE_URL;
                title = '大人向けフォーム';
            } else if (formType === 'student_middle_high_uni') {
                url = STUDENT_MIDDLE_HIGH_UNI_FORM_BASE_URL;
                title = '学生向けフォーム';
            } else if (formType === 'watch') {
                url = WATCH_SERVICE_FORM_BASE_URL;
                title = '見守りサービスフォーム';
            }
            if (!url) {
                await client.replyMessage(replyToken, {
                    type: 'text',
                    text: 'ごめんね、URLが見つからないみたい💦'
                });
                return res.status(200).end();
            }
            const linkToken = await client.issueLinkToken(req.body.source.userId);
            await client.replyMessage(replyToken, [{
                type: 'text',
                text: `${title}はこちらだよ🌸\n${url}`
            }, {
                type: 'flex',
                altText: title,
                contents: {
                    type: 'bubble',
                    body: {
                        type: 'box',
                        layout: 'vertical',
                        spacing: 'md',
                        contents: [{
                            type: 'text',
                            text: title,
                            weight: 'bold'
                        }, {
                            type: 'button',
                            action: {
                                type: 'uri',
                                label: 'フォームを開く',
                                uri: `${url}?liff.state=${linkToken.linkToken}`
                            },
                            style: 'primary'
                        }]
                    }
                }
            }]);
        }
        res.status(200).end();
    } catch (e) {
        briefErr('LINE Things handler failed', e);
        res.status(500).end();
    }
};

const handleWatchService = async (req, res) => {
    const {
        action
    } = req.query;
    if (action === 'run_ping') {
        watchLog('[watch] manual trigger received.');
        await withLock('watch-cron', 240, checkAndSendPing);
        return res.status(200).send('OK');
    }
    res.status(404).end();
};

const handlePostback = async (event) => {
    const {
        data,
        replyToken
    } = event.postback;
    const userId = event.source.userId;
    const {
        user,
        ref
    } = await getUser(userId);
    const params = new URLSearchParams(data);
    const action = params.get('action');

    if (action === 'start_relay') {
        const handlerId = event.source.groupId || event.source.userId;
        const uid = params.get('uid');
        if (!uid || !handlerId) return;

        const udoc = await db.collection('users').doc(uid).get();
        if (!udoc.exists) return;

        const existingRelay = await getRelayUser(handlerId);
        if (existingRelay) {
            await safePush(handlerId, {
                type: 'text',
                text: 'すでに他のユーザーとのリレーが進行中です。そちらを終了してから再度お試しください。'
            });
            return;
        }

        await addRelay(uid, handlerId);
        await safePush(handlerId, {
            type: 'text',
            text: `${udoc.data().line?.displayName || '匿名ユーザー'}とのリレーを開始しました。`
        });
        await safePush(uid, {
            type: 'text',
            text: 'ボランティアさんが応答しました。ここからはボランティアさんと直接お話できます。'
        });
    } else if (data === 'watch:ok') {
        await handleWatchOk(event);
    }
};

const relaysCol = db.collection('relays');
const RELAY_TTL_MS = 60 * 60 * 1000; // 60分

async function addRelay(user, officer) {
    await relaysCol.doc(user).set({
        uid: user,
        handlerId: officer,
        active: true,
        until: Timestamp.fromMillis(Date.now() + RELAY_TTL_MS),
        createdAt: Timestamp.now()
    }, {
        merge: true
    });
}

async function getRelay(user) {
    const doc = await relaysCol.doc(user).get();
    const r = doc.exists ? doc.data() : null;
    if (!r || !r.active) return null;
    if (r.until?.toMillis?.() && r.until.toMillis() < Date.now()) {
        await relaysCol.doc(user).set({
            active: false
        }, {
            merge: true
        });
        return null;
    }
    return r;
}

async function getRelayUser(officer) {
    const q = await relaysCol.where('handlerId', '==', officer).where('active', '==', true).limit(1).get();
    return q.empty ? null : q.docs[0].data().uid;
}

const deleteRelay = (user) => relaysCol.doc(user).set({
    active: false
}, {
    merge: true
});

app.post('/liff', async (req, res) => {
    const {
        liff_state,
        liff_userId,
        liff_profile,
        liff_os,
        liff_language,
        form_id,
        form_entry_id,
        form_value
    } = req.body;
    try {
        if (!liff_userId) {
            return res.status(400).send('LIFF User ID is required.');
        }

        const userRef = db.collection('users').doc(liff_userId);
        const userDoc = await userRef.get();
        const user = userDoc.exists ? userDoc.data() : {};

        let entryId = null;
        let formUrl = null;
        let type = null;

        if (form_id === 'agreement') {
            formUrl = AGREEMENT_FORM_BASE_URL;
            entryId = AGREEMENT_FORM_LINE_USER_ID_ENTRY_ID;
            type = 'agreement';
        } else if (form_id === 'adult') {
            formUrl = ADULT_FORM_BASE_URL;
            entryId = ADULT_FORM_LINE_USER_ID_ENTRY_ID;
            type = 'adult';
        } else if (form_id === 'student') {
            formUrl = STUDENT_MIDDLE_HIGH_UNI_FORM_BASE_URL;
            entryId = STUDENT_MIDDLE_HIGH_UNI_FORM_LINE_USER_ID_ENTRY_ID;
            type = 'student';
        } else if (form_id === 'watch') {
            formUrl = WATCH_SERVICE_FORM_BASE_URL;
            entryId = WATCH_SERVICE_FORM_LINE_USER_ID_ENTRY_ID;
            type = 'watch';
        } else if (form_id === 'member_change') {
            formUrl = MEMBER_CHANGE_FORM_BASE_URL;
            entryId = MEMBER_CHANGE_FORM_LINE_USER_ID_ENTRY_ID;
            type = 'member_change';
        } else if (form_id === 'member_cancel') {
            formUrl = MEMBER_CANCEL_FORM_BASE_URL;
            entryId = MEMBER_CANCEL_FORM_LINE_USER_ID_ENTRY_ID;
            type = 'member_cancel';
        } else {
            return res.status(400).send('Invalid form_id.');
        }

        const finalUrl = prefillUrl(formUrl, {
            [entryId]: liff_userId,
            [`${entryId}_text`]: liff_profile?.displayName || ''
        });

        await userRef.set({
            profile: {
                ...liff_profile
            },
            flags: {
                ...(user.flags || {}),
                consultOncePending: false
            }
        }, {
            merge: true
        });

        if (type === 'watch') {
            await userRef.set({
                watchService: {
                    enabled: true,
                    nextPingAt: Timestamp.now()
                }
            }, {
                merge: true
            });
            audit('watch_form_start', {
                userId: userHash(liff_userId),
                profile: liff_profile
            });
            await safePush(liff_userId, {
                type: 'text',
                text: '見守りサービスのお申し込みフォームにアクセスしてくれてありがとう🌸\n\nもし、見守りサービスで聞きたいことがあったら、いつでも話しかけてね💖'
            });
        }
        res.status(200).json({
            url: finalUrl
        });
    } catch (e) {
        briefErr('LIFF handler failed', e);
        res.status(500).end();
    }
});

app.post('/consult', async (req, res) => {
    try {
        const {
            userId
        } = req.body;
        if (!userId) {
            return res.status(400).send('userId is required.');
        }
        const userRef = db.collection('users').doc(userId);
        const user = (await userRef.get()).data();
        if (user?.flags?.consultOncePending) {
            await client.pushMessage(userId, {
                type: 'text',
                text: '🌸何か困ったこと、相談したいことあったかな？私でよければ聞くよ！'
            });
            await userRef.set({
                flags: {
                    ...(user.flags || {}),
                    consultOncePending: false
                }
            }, {
                merge: true
            });
        }
        res.status(200).send('OK');
    } catch (e) {
        briefErr('consult handler failed', e);
        res.status(500).end();
    }
});

const notifyOfficerGroup = async ({ title, userId, userInfo, text, type = 'danger' }) => {
    const WATCH_GROUP_ID = await getActiveWatchGroupId();
    if (!WATCH_GROUP_ID) {
        watchLog('[notifyOfficerGroup] WATCH_GROUP_ID is not set.', 'error');
        return;
    }
    const prof = userInfo.profile || {};
    const emerg = userInfo.emergency || {};
    const flexMessage = {
        type: 'flex',
        altText: title,
        contents: {
            type: 'bubble',
            body: {
                type: 'box',
                layout: 'vertical',
                contents: [{
                    type: 'text',
                    text: title,
                    weight: 'bold',
                    size: 'lg'
                }, {
                    type: 'text',
                    text: text,
                    wrap: true,
                    margin: 'md'
                }, {
                    type: 'box',
                    layout: 'vertical',
                    margin: 'lg',
                    spacing: 'sm',
                    contents: [
                        { type: 'text', text: `👤 氏名：${prof.displayName || '—'}` },
                        { type: 'text', text: `🏠 住所：${[prof.prefecture, prof.city, prof.line1, prof.line2].filter(Boolean).join(' ') || '—'}` },
                        { type: 'text', text: `📱 電話：${maskPhone(prof.phone || '')}` },
                        { type: 'text', text: `👨‍👩‍👧‍👦 保護者名：${emerg.contactName || '—'}` },
                        { type: 'text', text: `📞 緊急連絡先：${maskPhone(emerg.contactPhone || '')}` }
                    ]
                }]
            },
            footer: {
                type: 'box',
                layout: 'vertical',
                spacing: 'sm',
                contents: [
                    {
                        type: 'button',
                        style: 'primary',
                        action: {
                            type: 'postback',
                            label: 'LINEで連絡',
                            data: `action=start_relay&uid=${encodeURIComponent(userId)}`
                        }
                    },
                    telMsgBtn('本人に電話', prof.phone),
                    telMsgBtn('近親者に電話', emerg.contactPhone)
                ].filter(Boolean)
            }
        }
    };
    await safePush(WATCH_GROUP_ID, flexMessage);
};

app.get('/watch', handleWatchService);
app.post('/line/things', handleLineThingsScenario);

app.listen(PORT, () => console.log(`Listening on ${PORT}`));

const replyOrPush = async (replyToken, userId, message) => {
    try {
        const arr = Array.isArray(message) ? message : [message];
        for (const m of arr) {
            if (m.type === 'flex' && !m.altText) m.altText = '通知があります';
            if (m.type === 'text' && !m.text) m.text = '（内容なし）';
        }
        await client.replyMessage(replyToken, arr.length === 1 ? arr[0] : arr);
    } catch (e) {
        const detail = e.originalError?.response?.data || e.response?.data || e.message;
        const status = e.statusCode || e.response?.status;
        if (status === 400 && String(detail).includes('invalid replyToken')) {
            console.warn(`[WARN] Invalid replyToken, attempting push to ${gTrunc(userId, 8)}`);
            await safePush(userId, message);
        } else {
            briefErr('replyMessage failed', e);
        }
    }
};
