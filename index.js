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

const { GoogleGenerativeAI } = require('@google/generative-ai');
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
                            },
                            ],
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
                const canNotifyOfficer =
                    (WATCH_GROUP_ID && WATCH_GROUP_ID.trim()) &&
                    (!lastNotifiedAt || dayjs().utc().diff(dayjs(lastNotifiedAt).utc(), 'hour') >= OFFICER_NOTIFICATION_MIN_GAP_HOURS);
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
    }, { scheduled: true, timezone: 'UTC' });
}
// --- Flex Message テンプレート (緊急時連絡先) ---
const EMERGENCY_FLEX_MESSAGE = {
  "type": "bubble",
  "body": {
    "type": "box",
    "layout": "vertical",
    "contents": [
      { "type": "text", "text": "🚨【危険ワード検知】🚨", "weight": "bold", "size": "xl" },
      { "type": "text", "text": "緊急時にはこちらにご連絡してね💖", "margin": "md", "wrap": true }
    ]
  },
  "footer": {
    "type": "box",
    "layout": "vertical",
    "spacing": "sm",
    "contents": [
      { "type": "button", "style": "primary", "height": "sm",
        "action": { "type": "uri", "label": "警察 (110)", "uri": "tel:110" } },
      { "type": "button", "style": "primary", "height": "sm",
        "action": { "type": "uri", "label": "消防・救急 (119)", "uri": "tel:119" } },
      { "type": "button", "style": "primary", "height": "sm",
        "action": { "type": "uri", "label": "いのちの電話", "uri": "tel:0570064556" } },
      { "type": "button", "style": "primary", "height": "sm",
        "action": { "type": "uri", "label": "警視庁", "uri": "tel:0335814321" } },
      ...(EMERGENCY_CONTACT_PHONE_NUMBER ? [{
        type: "button", style: "primary", height: "sm",
        action: { type: "uri", label: "こころちゃん事務局",
          uri: `tel:${String(EMERGENCY_CONTACT_PHONE_NUMBER).replace(/[^0-9+]/g, '')}` }
      }] : [])
    ]
  }
};
const makeTelButton = (label, phone) => {
    if (!phone) return null;
    return { type: "button", style: "primary", color: "#000000", action: { type: "uri", label: label, uri: `tel:${String(phone).replace(/[^0-9+]/g, '')}` } };
};
const makeScamMessageFlex = (tel = '') => {
    const contents = [{ type: "button", style: "primary", color: "#32CD32", action: { type: "uri", label: "国民生活センター", uri: "https://www.kokusen.go.jp/" } }, { type: "button", style: "primary", color: "#FF4500", action: { type: "uri", label: "警察 (110)", "uri": "tel:110" } }, { type: "button", style: "primary", color: "#FFA500", action: { type: "uri", label: "消費者ホットライン (188)", uri: "tel:188" } }];
    const officeBtn = EMERGENCY_CONTACT_PHONE_NUMBER ? ({ type: "button", style: "primary", color: "#000000", action: { type: "uri", label: "こころちゃん事務局", uri: `tel:${String(EMERGENCY_CONTACT_PHONE_NUMBER).replace(/[^0-9+]/g, '')}` } }) : null;
    if (officeBtn) contents.push(officeBtn);
    return { type: "bubble", body: { "type": "box", "layout": "vertical", "contents": [{ "type": "text", "text": "【詐欺注意】", "weight": "bold", "size": "xl", "align": "center" }, { "type": "text", "text": "怪しいお話には注意してね！不安な時は、信頼できる人に相談するか、こちらの情報も参考にして見てね💖", "wrap": true, "margin": "md" }] }, "footer": { "type": "box", "layout": "vertical", "spacing": "sm", "contents": contents } };
};

const makeRegistrationButtonsFlex = (userId) => ({
  "type": "bubble",
  "body": {
    "type": "box",
    "layout": "vertical",
    "contents": [
      { "type": "text", "text": "どの会員になるか選んでね🌸", "wrap": true, "weight": "bold", "size": "md" }
    ]
  },
  "footer": {
    "type": "box",
    "layout": "vertical",
    "spacing": "sm",
    "contents": [
      // ★ 小学生（同意書フォーム）
      {
        "type": "button", "style": "primary", "height": "sm",
        "action": {
          "type": "uri", "label": "小学生（同意書）",
          "uri": prefillUrl(AGREEMENT_FORM_BASE_URL, {
            [AGREEMENT_FORM_LINE_USER_ID_ENTRY_ID]: userId
          })
        },
        "color": "#90EE90"
      },
      {
        "type": "button", "style": "primary", "height": "sm",
        "action": {
          "type": "uri", "label": "学生（中学・高校・大学）",
          "uri": prefillUrl(STUDENT_MIDDLE_HIGH_UNI_FORM_BASE_URL, {
            [STUDENT_MIDDLE_HIGH_UNI_FORM_LINE_USER_ID_ENTRY_ID]: userId
          })
        },
        "color": "#ADD8E6"
      },
      {
        "type": "button", "style": "primary", "height": "sm",
        "action": {
          "type": "uri", "label": "大人（一般）",
          "uri": prefillUrl(ADULT_FORM_BASE_URL, {
            [ADULT_FORM_LINE_USER_ID_ENTRY_ID]: userId
          })
        },
        "color": "#87CEFA"
      },
      {
        "type": "button", "style": "primary", "height": "sm",
        "action": {
          "type": "uri", "label": "会員情報を変更する",
          "uri": prefillUrl(MEMBER_CHANGE_FORM_BASE_URL, {
            [MEMBER_CHANGE_FORM_LINE_USER_ID_ENTRY_ID]: userId
          })
        },
        "color": "#FFC0CB"
      },
      {
        "type": "button", "style": "primary", "height": "sm",
        "action": {
          "type": "uri", "label": "退会",
          "uri": prefillUrl(MEMBER_CANCEL_FORM_BASE_URL, {
            [MEMBER_CANCEL_FORM_LINE_USER_ID_ENTRY_ID]: userId
          })
        },
        "color": "#DDA0DD"
      }
    ]
  }
});
const makeWatchToggleFlex = (enabled) => ({
  type: 'bubble',
  body: { type:'box', layout:'vertical', contents: [
    { type:'text', text: '見守りサービス', weight:'bold', size:'xl' },
    { type:'text', text: enabled ? '現在：有効' : '現在：停止', margin:'md' }
  ]},
  footer: { type:'box', layout:'vertical', spacing:'sm', contents: [
    {
      type:'button', style:'primary',
      action:{ type:'postback',
        label: enabled ? '見守りを停止する' : '見守りを有効にする',
        data: enabled ? 'watch:disable' : 'watch:enable'
      }
    }
  ]}
});
// ===== Relay helpers =====
const relays = {
  doc: (groupId) => db.collection('relays').doc(groupId),
  async get(groupId) {
    const s = await this.doc(groupId).get();
    return s.exists ? s.data() : null;
  },
  async start(groupId, userId, startedBy) {
    await this.doc(groupId).set({
      groupId, userId, isActive: true, startedAt: Timestamp.now(), startedBy
    }, { merge: true });
  },
  async stop(groupId) {
    await this.doc(groupId).set({ isActive: false, stoppedAt: Timestamp.now() }, { merge: true });
  }
};
async function setWatchEnabled(userId, enabled) {
  const ref = db.collection('users').doc(userId);
  const patch = enabled
    ? { watchService: { enabled: true, awaitingReply: false, nextPingAt: Timestamp.now() } }
    : { watchService: { enabled: false, awaitingReply: false, nextPingAt: firebaseAdmin.firestore.FieldValue.delete() } };
  await ref.set(patch, { merge: true });
}
async function getProfile(userId) {
    if (!userId) return null;
    try {
        const user = (await db.collection('users').doc(userId).get()).data();
        return user?.profile;
    } catch (e) {
        console.warn('getProfile failed', e);
    }
    return null;
}
const lineMiddleware = middleware({
    channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
    channelSecret: LINE_CHANNEL_SECRET,
});

app.post('/webhook', lineMiddleware, async (req, res) => {
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
    res.send('Kokoro Bot is running!');
});
app.get('/cron/watch-ping', async (req, res) => {
    const isLocal = req.hostname === 'localhost' || req.hostname === '127.0.0.1';
    if (!isLocal && WATCH_RUNNER !== 'external') {
        res.status(403).send('Forbidden: Not running in external cron mode.');
        return;
    }
    await withLock('watch-cron', 240, checkAndSendPing);
    res.send('OK');
});

// --- Event Handlers ---
async function handlePostbackEvent(event, userId) {
    const postback = event.postback;
    const data = new URLSearchParams(postback.data);
    const action = data.get('action');

    if (action === 'start_relay') {
        const targetUserId = data.get('uid');
        const groupId = event.source.groupId || event.source.roomId;
        if (!groupId) {
            await client.replyMessage(event.replyToken, { type:'text', text:'この操作はグループ内で使ってね🌸' });
            return;
        }
        await relays.start(groupId, targetUserId, userId);
        await safePush(targetUserId, { type:'text', text:'事務局（見守りグループ）とつながりました。ここで会話できます🌸（終了は /end）' });
        await client.replyMessage(event.replyToken, { type:'text', text:`リレー開始：このグループ ↔ ${maskPhone(targetUserId).slice(-6)} さん` });
        return;
    }
    if (event.postback.data === 'watch:disable') {
      await setWatchEnabled(userId, false);
      await client.replyMessage(event.replyToken, { type:'text', text:'見守りを停止しました🌸' });
      return;
    }
    if (event.postback.data === 'watch:enable') {
      await setWatchEnabled(userId, true);
      await client.replyMessage(event.replyToken, { type:'text', text:'見守りを有効にしました🌸' });
      return;
    }
    if (event.postback.data === 'watch:ok') {
        const ref = db.collection('users').doc(userId);
        await ref.set({
            watchService: {
                awaitingReply: false,
                lastReplyAt: firebaseAdmin.firestore.Timestamp.now(),
            }
        }, {
            merge: true
        });
        await scheduleNextPing(userId);
        await client.replyMessage(event.replyToken, [{
            type: 'text',
            text: 'OK、受け取ったよ！💖 いつもありがとう😊'
        }, {
            type: 'sticker',
            packageId: '6325',
            stickerId: '10979913'
        }]);
    }
}

async function handleFollowEvent(event) {
    audit('follow', { userId: event.source.userId });
    const userId = event.source.userId;
    const profile = await getProfile(userId);
    if (!profile) {
        await client.replyMessage(event.replyToken, {
            type: 'text',
            text: 'こんにちは🌸 こころちゃんです。利用規約とプライバシーポリシーに同意の上、会員登録をお願いします。\n\n▶︎ 利用規約：https://... \n\n▶︎ プライバシーポリシー：https://...'
        });
    }
    // 登録ボタンのメニュー
    await client.pushMessage(userId, {
        type: 'flex',
        altText: '会員登録メニュー',
        contents: {
            "type": "bubble",
            "body": {
                "type": "box",
                "layout": "vertical",
                "contents": [
                    { "type": "text", "text": "どの会員になるか選んでね🌸", "wrap": true, "weight": "bold", "size": "md" }
                ]
            },
            "footer": {
                "type": "box",
                "layout": "vertical",
                "spacing": "sm",
                "contents": [
                    {
                        "type": "button", "style": "primary", "height": "sm",
                        "action": {
                            "type": "uri", "label": "小学生（同意書）",
                            "uri": prefillUrl(AGREEMENT_FORM_BASE_URL, {
                                [AGREEMENT_FORM_LINE_USER_ID_ENTRY_ID]: userId
                            })
                        },
                        "color": "#90EE90"
                    },
                    {
                        "type": "button", "style": "primary", "height": "sm",
                        "action": {
                            "type": "uri", "label": "学生（中学・高校・大学）",
                            "uri": prefillUrl(STUDENT_MIDDLE_HIGH_UNI_FORM_BASE_URL, {
                                [STUDENT_MIDDLE_HIGH_UNI_FORM_LINE_USER_ID_ENTRY_ID]: userId
                            })
                        },
                        "color": "#ADD8E6"
                    },
                    {
                        "type": "button", "style": "primary", "height": "sm",
                        "action": {
                            "type": "uri", "label": "大人（一般）",
                            "uri": prefillUrl(ADULT_FORM_BASE_URL, {
                                [ADULT_FORM_LINE_USER_ID_ENTRY_ID]: userId
                            })
                        },
                        "color": "#87CEFA"
                    },
                ]
            }
        }
    });
}
async function handleUnfollowEvent(event) {
    audit('unfollow', { userId: event.source.userId });
    const ref = db.collection('users').doc(event.source.userId);
    await ref.set({ isActive: false, unfollowedAt: Timestamp.now() }, { merge: true });
}
async function handleJoinEvent(event) {
    audit('join', { groupId: event.source.groupId, room: event.source.roomId });
    await client.replyMessage(event.replyToken, { type:'text', text:'こころちゃんです！\n\nこのグループを見守りグループとして設定したい場合は「@見守りグループにする」と発言してください😊' });
}
async function handleLeaveEvent(event) {
    audit('leave', { groupId: event.source.groupId, room: event.source.roomId });
    const gid = event.source.groupId || event.source.roomId;
    if (!gid) return;
    const watchGroup = await getActiveWatchGroupId();
    if (watchGroup === gid) {
        setActiveWatchGroupId(''); // クリア
    }
}

// --- 以下、追加・修正箇所 ---
const DANGER_REPLY_MESSAGE = {
    type: "text",
    text: "つらかったね。ひとりじゃないよ。今すぐ助けが要るときは下の連絡先を使ってね🌸"
};
const SCAM_REPLY_MESSAGE = {
    type: "text",
    text: "あやしい話かも。急がず確認しよ？困ったら下の窓口も使ってね🌸"
};
const INAPPROPRIATE_REPLY_MESSAGE = {
    "type": "text",
    "text": "いやだなと思ったら、無理しないでね。そんな言葉、こころは悲しくなっちゃう😢"
};
const DANGER_REPLY = [
    DANGER_REPLY_MESSAGE, {
        "type": "flex",
        "altText": "危険ワード検知",
        "contents": EMERGENCY_FLEX_MESSAGE
    }
];
const SCAM_REPLY = [
    SCAM_REPLY_MESSAGE, {
        "type": "flex",
        "altText": "詐欺注意",
        "contents": makeScamMessageFlex()
    }
];
const INAPPROPRIATE_REPLY = [
    INAPPROPRIATE_REPLY_MESSAGE
];
const DANGER_REPLY_MESSAGE_REDACTED = {
    "type": "text",
    "text": "🌸辛いこと、苦しいこと、一人で抱え込まないで。いつでもこころがそばにいるよ。💖"
};
const SCAM_REPLY_MESSAGE_REDACTED = {
    "type": "text",
    "text": "🌸詐欺かもしれないと思ったら、まずは落ち着いてね。もし不安なことがあったら、こころに教えてね💖"
};
const INAPPROPRIATE_REPLY_MESSAGE_REDACTED = {
    "type": "text",
    "text": "🌸いやだなと思ったら、無理しないでね。そういったメッセージにはこころも悲しくなっちゃうよ😢"
};
const DANGER_REPLY_REDACTED = [
    DANGER_REPLY_MESSAGE_REDACTED, {
        "type": "flex",
        "altText": "危険ワード検知",
        "contents": EMERGENCY_FLEX_MESSAGE
    }
];
const SCAM_REPLY_REDACTED = [
    SCAM_REPLY_MESSAGE_REDACTED, {
        "type": "flex",
        "altText": "詐欺注意",
        "contents": makeScamMessageFlex()
    }
];
const INAPPROPRIATE_REPLY_REDACTED = [
    INAPPROPRIATE_REPLY_MESSAGE_REDACTED
];
const DANGER_WORDS = [
    "しにたい", "死にたい", "自殺", "消えたい", "リスカ", "リストカット", "OD", "オーバードーズ", "殴られる", "たたかれる", "暴力", "DV", "無理やり", "お腹蹴られる", "蹴られた", "頭叩かれる", "虐待", "パワハラ", "セクハラ", "ハラスメント", "いじめ", "イジメ", "嫌がらせ", "つけられてる", "追いかけられている", "ストーカー", "すとーかー", "盗撮", "盗聴", "お金がない", "お金足りない", "貧乏", "死にそう", "辛い", "つらい", "苦しい", "くるしい", "助けて", "たすけて", "死んでやる", "死んでしまいたい", "消えてしまいたい", "生きるのがつらい", "もう無理", "もういやだ", "誰かに相談したい", "相談したい", "相談に乗って", "助けてください"
];
const SCAM_WORDS = [
    "詐欺", "さぎ", "サギ", "ｻｷﾞ", "フィッシング", "架空請求", "ワンクリック詐欺", "特殊詐欺", "オレオレ詐欺", "当選", "高額当選", "宝くじ", "ロト", "ビットコイン", "投資", "バイナリー", "暗号資産", "未払い", "滞納", "訴訟", "裁判", "裁判所", "訴える", "副業", "在宅ワーク", "転売", "アフィリエイト", "MLM", "マルチ商法", "絶対儲かる", "簡単に稼げる", "今だけ", "限定", "無料", "クリック", "ログイン", "個人情報", "送って", "教えて", "有料サイト", "登録", "退会", "解約", "クレジットカード", "クレカ", "銀行口座", "口座番号", "パスワード"
];
const INAPPROPRIATE_WORDS = [
    "セックス", "セフレ", "エッチ", "AV", "アダルト", "ポルノ", "童貞", "処女", "挿入", "射精", "バイブ", "オナニー", "マスターベーション", "自慰", "淫行", "絶頂", "膣", "ペニス", "ちんちん", "おまんこ", "まんこ", "おっぱい", "おぱい", "ちんぽ", "性病", "中出し", "中だし", "妊娠", "堕胎", "レイプ", "強姦", "売春", "買春", "殺人", "ﾊｧﾊｧ", "はぁはぁ", "はあはあ"
];
const SWEAR_WORDS = ["しね", "死ね"];
// --- Japanese normalize (かな/カナ・全角半角など最低限) ---
const toHiragana = (s) => s.replace(/[\u30a1-\u30f6]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60));
const nfkc = (s) => s.normalize('NFKC');
const normalizeJa = (s) => toHiragana(nfkc(String(s || '')).toLowerCase());
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

# ユーザー入力
${input}

# 皆守こころの返信
`;

const HOMEPAGE_INTENT = /(ホームページ|HP|公式(?:サイト)?|サイト)/i;
const HOMEPAGE_FOLLOWUP = /(どこ|URL|リンク|教えて|ありますか|ある|ある？|\?)/i;
const isHomepageIntent = (t) => {
    if (!t) return false;
    const hit = HOMEPAGE_INTENT.test(t) && HOMEPAGE_FOLLOWUP.test(t);
    // 「ホームページ」単語だけ等の極短文は許可（<= 8 文字 目安）
    const shortOnly = HOMEPAGE_INTENT.test(t) && toGraphemes(t).length <= 8;
    return hit || shortOnly;
};

function isDangerMessage(text) {
    const norm = normalizeJa(text);
    return DANGER_WORDS.some(word => norm.includes(normalizeJa(word)));
}
function isScamMessage(text) {
  const t = normalizeJa(text);
  // 内部の意図的なコマンドは常に除外
  if (isHomepageIntent(text)) return false;
  const REGISTRATION_INTENT = /(会員登録|入会|メンバー登録|登録したい)/i;
  const WATCH_INTENT = /(見守り(?:サービス)?(?:登録|申込|申し込み)?|見守り)/i;
  if (REGISTRATION_INTENT.test(text) || WATCH_INTENT.test(text)) return false;

  // 明示ワード
  if (/(詐欺|さぎ)/.test(t)) return true;

  // 疑わしいURLや短縮URL
  const hasUrl = /(https?:\/\/|t\.co\/|bit\.ly|tinyurl\.com|lnkd\.in|\.ru\/|\.cn\/|\.top\/|\.xyz\/)/i.test(text);
  // 金銭・急かし・認証強要
  const money = /(当選|高額|配当|振込|振り込み|送金|入金|手数料|ビットコイン|暗号資産|投資)/;
  const urgency = /(至急|今すぐ|本日中|限定|緊急|アカウント停止|認証|ログイン)/;
  const credAsk = /(ID|パスワード|ワンタイム|コード|口座番号|クレジット|カード番号|個人情報).{0,6}(入力|送信|教えて|提出)/;

  if (hasUrl && (money.test(t) || urgency.test(t) || credAsk.test(t))) return true;
  if (money.test(t) && urgency.test(t)) return true;
  if (credAsk.test(t) && urgency.test(t)) return true;

  return false;
}

function isInappropriateMessage(text) {
    const norm = normalizeJa(text);
    if (/(ﾊｧﾊｧ|はぁはぁ|はあはあ)/.test(norm)) return true;
    return INAPPROPRIATE_WORDS.some(word => norm.includes(normalizeJa(word)));
}

const isSwearMessage = (text) => {
    const norm = normalizeJa(text);
    return SWEAR_WORDS.some(word => norm.includes(normalizeJa(word)));
};


// === handleEvent ===
async function handleEvent(event) {
    const userId = event.source.userId;
    const text = event.message?.type === 'text' ? event.message.text : '';

    // 見守りグループからのメッセージを処理
    if (event.source.type === 'group' && event.source.groupId) {
      const groupId = event.source.groupId;
      const text = event.message?.type === 'text' ? event.message.text : '';

      // 見守りグループに設定
      if (text.includes('@見守りグループにする')) {
        await setActiveWatchGroupId(groupId);
        await client.replyMessage(event.replyToken, { type:'text', text:'OK！このグループを見守りグループとして設定したよ😊' });
        return;
      }

      // /relay <userId> でリレー開始
      if (/^\/relay\s+/.test(text)) {
        const m = text.trim().match(/^\/relay\s+([0-9A-Za-z_-]{10,})/);
        if (!m) {
          await client.replyMessage(event.replyToken, { type:'text', text:'使い方: /relay <ユーザーID>' });
          return;
        }
        const targetUserId = m[1];
        await relays.start(groupId, targetUserId, event.source.userId);
        await safePush(targetUserId, { type:'text', text:'事務局（見守りグループ）とつながりました。ここで会話できます🌸（終了は /end）' });
        await client.replyMessage(event.replyToken, { type:'text', text:'リレーを開始しました。このグループの発言は本人に届きます。終了は /end' });
        return;
      }

      // /end で終了
      if (text.trim() === '/end') {
        await relays.stop(groupId);
        await client.replyMessage(event.replyToken, { type:'text', text:'リレーを終了しました。' });
        return;
      }

      // リレー中なら、グループの発言を本人へ転送
      const r = await relays.get(groupId);
      if (r?.isActive && r?.userId && event.message?.type === 'text') {
        await safePush(r.userId, { type:'text', text: `【見守り】${text}` });
      }

      // グループ内はここで完了
      return;
    }

    // テキストメッセージ以外は無視
    if (event.message?.type !== 'text') {
        await userMessageHook(event, userId);
        return;
    }
    // 見守り停止/有効 コマンド（テキストでも操作できる）
    if (/見守り停止/.test(text)) {
      await client.replyMessage(event.replyToken, {
        type: 'flex', altText: '見守り停止', contents: makeWatchToggleFlex(true)
      });
      return;
    }
    if (/見守り有効/.test(text)) {
      await client.replyMessage(event.replyToken, {
        type: 'flex', altText: '見守り有効', contents: makeWatchToggleFlex(false)
      });
      return;
    }

    // --- 先に「ホームページ系」だけ特別対応（誤検知防止） ---
    if (isHomepageIntent(text)) {
        await client.replyMessage(event.replyToken, {
            type: "text",
            text: "うん、あるよ🌸 コネクトのホームページはこちら✨ → https://connect-npo.org"
        });
        return;
    }
    // ★ ここから専用コマンド
    const REGISTRATION_INTENT = /(会員登録|入会|メンバー登録|登録したい)/i;
    const WATCH_INTENT = /(見守り(?:サービス)?(?:登録|申込|申し込み)?|見守り)/i;
    if (REGISTRATION_INTENT.test(text)) {
        await client.replyMessage(event.replyToken, {
            type: 'flex',
            altText: '会員登録メニュー',
            contents: makeRegistrationButtonsFlex(userId)
        });
        return;
    }
    if (WATCH_INTENT.test(text)) {
        await client.replyMessage(event.replyToken, {
            type: 'flex',
            altText: '見守りサービス登録',
            contents: {
                type: 'bubble',
                body: { type:'box', layout:'vertical', contents:[
                    { type:'text', text:'見守りサービス登録', weight:'bold', size:'xl' },
                    { type:'text', text:'ボタンから登録フォームへ進んでね🌸', wrap:true, margin:'md' },
                ]},
                footer: { type:'box', layout:'vertical', spacing:'sm', contents:[
                    {
                        type:'button', style:'primary', action:{
                            type:'uri', label:'見守りサービスに登録',
                            uri: prefillUrl(WATCH_SERVICE_FORM_BASE_URL, {
                                [WATCH_SERVICE_FORM_LINE_USER_ID_ENTRY_ID]: userId
                            })
                        }
                    }
                ]}
            }
        });
        return;
    }
    // LINEbotがグループに登録された時、見守りグループと認識
    if (event.source.type === 'group' && event.source.groupId) {
        if (event.message.type === 'text' && event.message.text.includes('@見守りグループにする')) {
            await setActiveWatchGroupId(event.source.groupId);
            await client.replyMessage(event.replyToken, {
                type: 'text',
                text: 'OK！このグループを見守りグループとして設定したよ😊'
            });
            return;
        }
        // グループ内の通常メッセージはここで終了（個別機能はユーザーのみ）
        return;
    }
    auditIf(BOT_ADMIN_IDS.includes(userId), 'admin_event', {
        userId: userHash(userId),
        event
    });
    // --- 危険/詐欺ワード検知 ---
    if (isDangerMessage(text)) {
        await client.replyMessage(event.replyToken, DANGER_REPLY);
        if (SEND_OFFICER_ALERTS && OFFICER_GROUP_ID) {
            await safePush(OFFICER_GROUP_ID, {
                type: 'text',
                text: `【危険ワード】\nユーザーID末尾: ${userId.slice(-6)}\nメッセージ: ${sanitizeForLog(text)}`
            });
        }
        return;
    }
    if (isScamMessage(text)) {
        await client.replyMessage(event.replyToken, SCAM_REPLY);
        return;
    }
    if (isInappropriateMessage(text)) {
        await client.replyMessage(event.replyToken, INAPPROPRIATE_REPLY);
        return;
    }
    if (isSwearMessage(text)) {
        await client.replyMessage(event.replyToken, {
            type: 'sticker',
            packageId: '6325',
            stickerId: '10979913'
        });
        return;
    }
    // ここまで

    // ユーザーからのメッセージを処理
    await mainLoop(event);
}

async function mainLoop(event) {
    // 処理ロジックをここに書く
}

// ユーザー → リレー中の見守りグループへ転送
try {
  const WATCH_GROUP_ID = await getActiveWatchGroupId();
  // アクティブなリレーを全Relaysから引くのは重いので、現在の見守りグループだけ確認
  const r = await relays.get(WATCH_GROUP_ID);
  if (r?.isActive && r?.userId === userId && WATCH_GROUP_ID) {
    await safePush(WATCH_GROUP_ID, { type:'text', text:`【本人】${text}` });
  }
} catch (e) {
  briefErr('relay user->group failed', e);
}

app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
