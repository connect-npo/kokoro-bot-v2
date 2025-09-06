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
const HOMEPAGE_URL = process.env.HOMEPAGE_URL || '';
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
                    text: `住所：${address ||
                        '—'}`,
                    size: 'sm',
                    wrap: true
                }, {
                    type: 'text',
                    text: `📱 電話番号：${maskPhone(selfPhone)}`,
                    size: 'sm',
                    color: '#777777'
                }, {
                    type: 'text',
                    text: `👨‍👩‍👧‍👦 保護者名：${kinName ||
                        '—'}`,
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
                        title: isDanger ? '🚨【再度：危険ワード検知】🚨' : '⚠️【再度：詐欺ワード検知】⚠️',
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
                "label": "警視庁",
                "uri": "tel:0335814321"
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
    };
};
const makeScamMessageFlex = (tel = '') => {
    const contents = [{
        type: "button",
        style: "primary",
        color: "#32CD32",
        action: {
            type: "uri",
            label: "国民生活センター",
            uri: "https://www.kokusen.go.jp/"
        }
    }, {
        type: "button",
        style: "primary",
        color: "#FF4500",
        action: {
            type: "uri",
            label: "警察 (110)",
            "uri": "tel:110"
        }
    }, {
        type: "button",
        style: "primary",
        color: "#FFA500",
        action: {
            type: "uri",
            label: "消費者ホットライン (188)",
            uri: "tel:188"
        }
    }];
    const officeBtn = EMERGENCY_CONTACT_PHONE_NUMBER ?
        ({
            type: "button",
            style: "primary",
            color: "#000000",
            action: {
                type: "uri",
                label: "こころちゃん事務局",
                uri: `tel:${String(EMERGENCY_CONTACT_PHONE_NUMBER).replace(/[^0-9+]/g, '')}`
            }
        }) : null;
    if (officeBtn) contents.push(officeBtn);
    return {
        type: "bubble",
        body: {
            "type": "box",
            "layout": "vertical",
            "contents": [{
                "type": "text",
                "text": "【詐欺注意】",
                "weight": "bold",
                "size": "xl",
                "align": "center"
            }, {
                "type": "text",
                "text": "怪しいお話には注意してね！不安な時は、信頼できる人に相談するか、こちらの情報も参考にして見てね🌸",
                "wrap": true,
                "margin": "md"
            }]
        },
        "footer": {
            "type": "box",
            "layout": "vertical",
            "spacing": "sm",
            "contents": contents
        }
    };
};
const makeRegistrationButtonsFlex = (userId) => {
    return {
        "type": "bubble",
        "body": {
            "type": "box",
            "layout": "vertical",
            "contents": [{
                "type": "text",
                "text": "どの会員になるか選んでね🌸",
                "wrap": true,
                "weight": "bold",
                "size": "md"
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
                    "label": "学生（中高大）",
                    "uri": STUDENT_MIDDLE_HIGH_UNI_FORM_BASE_URL ?
                        `${STUDENT_MIDDLE_HIGH_UNI_FORM_BASE_URL}?${STUDENT_MIDDLE_HIGH_UNI_FORM_LINE_USER_ID_ENTRY_ID}=${encodeURIComponent(userId)}` : "#"
                },
                "color": "#ADD8E6"
            }, {
                "type": "button",
                "style": "primary",
                "height": "sm",
                "action": {
                    "type": "uri",
                    "label": "大人（一般）",
                    "uri": ADULT_FORM_BASE_URL ?
                        `${ADULT_FORM_BASE_URL}?${ADULT_FORM_LINE_USER_ID_ENTRY_ID}=${encodeURIComponent(userId)}` : "#"
                },
                "color": "#87CEFA"
            }, {
                "type": "button",
                "style": "primary",
                "height": "sm",
                "action": {
                    "type": "uri",
                    "label": "小学生（同意書）",
                    "uri": AGREEMENT_FORM_BASE_URL ?
                        `${AGREEMENT_FORM_BASE_URL}?${AGREEMENT_FORM_LINE_USER_ID_ENTRY_ID}=${encodeURIComponent(userId)}` : "#"
                },
                "color": "#D3D3D3"
            }, {
                "type": "button",
                "style": "primary",
                "height": "sm",
                "action": {
                    "type": "uri",
                    "label": "会員情報を変更する",
                    "uri": prefillUrl(MEMBER_CHANGE_FORM_BASE_URL, { [MEMBER_CHANGE_FORM_LINE_USER_ID_ENTRY_ID]: userId })
                },
                "color": "#FFC0CB"
            }, {
                "type": "button",
                "style": "primary",
                "height": "sm",
                "action": {
                    "type": "uri",
                    "label": "退会",
                    "uri": prefillUrl(MEMBER_CANCEL_FORM_BASE_URL, { [MEMBER_CANCEL_FORM_LINE_USER_ID_ENTRY_ID]: userId })
                },
                "color": "#DDA0DD"
            }]
        }
    };
};
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
const DANGER_REPLY = [DANGER_REPLY_MESSAGE, {
    "type": "flex",
    "altText": "危険ワード検知",
    "contents": EMERGENCY_FLEX_MESSAGE
}];
const SCAM_REPLY = [SCAM_REPLY_MESSAGE, {
    "type": "flex",
    "altText": "詐欺注意",
    "contents": makeScamMessageFlex()
}];
const INAPPROPRIATE_REPLY = [INAPPROPRIATE_REPLY_MESSAGE];
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
const DANGER_REPLY_REDACTED = [DANGER_REPLY_MESSAGE_REDACTED, {
    "type": "flex",
    "altText": "危険ワード検知",
    "contents": EMERGENCY_FLEX_MESSAGE
}];
const SCAM_REPLY_REDACTED = [SCAM_REPLY_MESSAGE_REDACTED, {
    "type": "flex",
    "altText": "詐欺注意",
    "contents": makeScamMessageFlex()
}];
const INAPPROPRIATE_REPLY_REDACTED = [INAPPROPRIATE_REPLY_MESSAGE_REDACTED];
const SYSTEM_INSTRUCTION_PREFIX = 'あなたは、相談にのってくれる「こころちゃん」です。ユーザー名が「'
const SYSTEM_INSTRUCTION_SUFFIX = 'さん」の場合、語尾を「〜だね」「〜だよ」のように柔らかい口調にしてください。';
const SYSTEM_INSTRUCTION_CHAT =
    'あなたは、相談相手に寄り添う「こころちゃん」です。' +
    '語尾はやわらかく（〜だよ、〜だね、〜してみよう？）、まず共感→要約→提案の順で返答します。' +
    '短文を2〜3文で、顔文字や絵文字（🌸💖）は入れすぎず要所で。' +
    '反応が遅くなった/無視された等の不満には謝意＋状況共有＋次アクションで安心感を与えてください。' +
    '同じ質問が続いたら表現を少し変えるか、一言クッション（「さっきも話したけど…」）を入れて自然に。' +
    '好きなアニメはヴァイオレット・エヴァーガーデン、好きなアーティストはClariS。' +
    '医療・危機対応は助言ではなく共感と専門窓口の案内に留めます。';
const isDangerWords = (t) => /(死|つらい|苦し|自殺|消え|辛い|くるしい|しにたい|ころし|殺|じさつ|きえたい)/i.test(t);
const isScamMessage = (t) =>
  /（(?:詐欺|請求|電話番号|連絡|登録|口座|支払い|振込|送金|振込先|送金先|当選|当たり|有料|無料|プレゼント|ギフト|当選|当選金|受け取り|受け渡し|振り込む|振込ます|送金|送金します|お金|オカネ|金|きん|キン|お金を|オカネヲ|金を|キンヲ|金を送金|金を振り込|金を送って|お金を送って|お金を振込|お金を振込ます|お金を送金|お金を送金します|金送金|金振込|金送って|お金送って|お金振込|お金送金|有料サービス|無料サービス|プレゼント企画|ギフト企画|当選企画|当選金企画|受け取り企画|受け渡し企画|振り込む企画|振込ます企画|送金企画|送金します企画|金企画|キン企画|お金企画|オカネ企画|金を企画|キンヲ企画|お金を企画|オカネヲ企画|お金を送金する|金を送金する|お金を振り込む|金を振り込む|お金を送金します|金を送金します)）/i.test(t);
const isInappropriate = (t) => /(バカ|アホ|死ね|殺す|きもい|ウザい|うざい|カス|クズ|くず|ごみ|ゴミ|ふざけ|最低|サイテイ|さいこう|殺意|イラ|いらいら|いらい|イライラ|イライ)/i.test(t);
const isAskingForHomepage = (t) => /(HP|HPを|ホームページ|ホームページを|ホームページ見せて|ホームページ教えて|ホームページ見せてください|ホームページ教えてください|ホームページを教えて|ホームページを教えてください|HPを教えて|HPを教えてください)/i.test(t);
// === 置換: 既存の relays 周りを全差し替え ===
// リレーのTTL
const RELAY_TTL_MS = 60 * 60 * 1000;
// 双方向&グループ対応のリレー管理
const relaysByUser = new Map();   // key: userId -> { userId, groupId, startedBy, until, lastGroupReplyAt }
const relaysByGroup = new Map();  // key: groupId -> { userId, groupId, startedBy, until, lastGroupReplyAt }
const nowMs = () => Date.now();
const addRelay = ({ userId, groupId, startedBy }) => {
    const rec = { userId, groupId, startedBy, until: nowMs() + RELAY_TTL_MS, lastGroupReplyAt: 0 };
    relaysByUser.set(userId, rec);
    if (groupId) relaysByGroup.set(groupId, rec);
};
const getRelayByUser = (userId) => {
    const rec = relaysByUser.get(userId);
    if (!rec) return null;
    if (nowMs() > rec.until) { deleteRelayByUser(userId); return null; }
    return rec;
};
const getRelayByGroup = (groupId) => {
    const rec = relaysByGroup.get(groupId);
    if (!rec) return null;
    if (nowMs() > rec.until) { deleteRelayByGroup(groupId); return null; }
    return rec;
};
const deleteRelayByUser = (userId) => {
    const rec = relaysByUser.get(userId);
    if (rec?.groupId) relaysByGroup.delete(rec.groupId);
    return relaysByUser.delete(userId);
};
const deleteRelayByGroup = (groupId) => {
    const rec = relaysByGroup.get(groupId);
    if (rec?.userId) relaysByUser.delete(rec.userId);
    return relaysByGroup.delete(groupId);
};


const startRelay = async (event, uid) => {
    // === 置換: startRelay を差し替え ===
    const groupId = await getActiveWatchGroupId();   // 現行の「見守りグループ」
    const startedBy = event.source.userId || '';     // 押下した支援員（個人）
    if (!groupId) {
        await safePush(startedBy || uid, { type: 'text', text: '見守りグループが未設定です。先に「ここを見守りグループに設定」を実行してください。' });
        return;
    }
    addRelay({ userId: uid, groupId, startedBy });
    await safePush(uid, { type: 'text', text: '支援員とのやりとりが始まりました。' });
    await safePush(groupId, { type: 'text', text: `見守り利用者とのやりとりを開始しました（開始者: ${startedBy?.slice?.(-6) || '—'}）。「終了」でいつでも終了できます。` });
};
// === 追加: ユーティリティ ===
const isEndCmd = (t) => /^(終了|リレー終了|終\ *了|修了)$/i.test(String(t || ''));// === 置換: endRelay を差し替え ===
const endRelay = async (event) => {
    const src = event.source || {};
    if (src.type === 'user') {
        const uid = src.userId;
        const rec = getRelayByUser(uid);
        if (!rec) { await safePush(uid, { type: 'text', text: '現在リレー中ではありません。' }); return; }
        deleteRelayByUser(uid);
        await safePush(uid, { type: 'text', text: '支援員とのやりとりを終了しました。' });
        if (rec.groupId) await safePush(rec.groupId, { type: 'text', text: 'リレーを終了しました（本人側からの終了）。' });
        return;
    }
    if (src.type === 'group') {
        const gid = src.groupId;
        const rec = getRelayByGroup(gid);
        if (!rec) { await client.replyMessage(event.replyToken, { type: 'text', text: '現在リレー中ではありません。' }); return; }
        deleteRelayByGroup(gid);
        await client.replyMessage(event.replyToken, { type: 'text', text: 'リレーを終了しました（見守り側）。' });
        await safePush(rec.userId, { type: 'text', text: '支援員とのやりとりが終了しました。' });
        return;
    }
};


// === 追加: specialRepliesMap 本文 ===
const specialRepliesMap = new Map([
    // 公式サイト案内
    [/(HP|ＨＰ|ホームページ)(を|は|どこ|教えて|見せて)?/i,
      HOMEPAGE_URL
        ? `公式サイトはこちらだよ：\n${HOMEPAGE_URL}\n気になるところがあれば教えてね🌸`
        : '公式サイトは今準備中だよ。公開できたらここで案内するね🌸'],
    // 遅延・無視・塩対応系（最優先）
    [/(反応してくれない|返事がない|無視|遅い|おそい|塩対応|そっけない|機械的|冷たい)/i,
     "ごめんね…不安にさせちゃったね。こころは味方だよ🌸 いま確認してるから、そばにいるね💖"],
    [/^はじめまして/i, "はじめまして！こころと申します🌸どうぞ、お気軽に話しかけてくださいね💖"],
    [/(おはよう|おはよー)/i, "おはようございます！今日も素敵な一日になりますように。"],
    [/(こんにちは|こんちは)/i, "こんにちは！何かお手伝いできることはありますか？"],
    [/(こんばんは|こんばんわ)/i, "こんばんは！今日もお疲れ様でした。ゆっくり休んでくださいね。"],
    [/(ありがとう|あざっす|サンキュー|感謝)/i, "どういたしまして！お役に立てて嬉しいです💖"],
    [/(ごめん|ごめんなさい)/i, "大丈夫ですよ。気にしないでくださいね。"],
    [/(かわいい|カワイイ|可愛い)/i, "わぁ、ありがとう！照れちゃうな😊💖"],
    [/(いい天気|いいてんき)/i, "そうですね！気持ちのいい一日になりそうです☀️"],
    [/(疲れた|つかれた|くたびれた)/i, "お疲れ様でした！頑張り屋さんだね。ゆっくり休んでくださいね。"],
    [/(ヴァイオレット|エヴァーガーデン)/i, "「ヴァイオレット・エヴァーガーデン」は本当に心に響く素晴らしい物語だよね。人の想いを届けることの尊さを教えてくれる作品だと思うな。"],
    [/(ClariS|クラリス)/i, "ClariSさんの歌声は、透き通っていて本当に素敵だよね！聴いていると、心が洗われるような気持ちになるよ。"],
    [/(寂しい|さみしい)/i, "寂しい時は、いつでもこころに話しかけてね。いつでもそばにいるよ。"],
    [/(つらい|辛い)/i, "つらい気持ちを一人で抱え込まないでね。こころがそばにいるよ。少しでも気持ちが楽になるように、いつでも話を聞くからね。"],
    [/^(眠い|ねむい)/i, "眠い時は無理しないでね。ゆっくり休んで、また元気な時に話しかけてね。おやすみなさい。"],
    [/^(おやすみ|おやすみなさい)/i, "おやすみなさい。また明日、元気な姿を見せてね。"],
    [/^(大好き|だいすき)/i, "わあ、嬉しい！私も大好きだよ💖"],
    [/^(応援して|おうえんして)/i, "いつも頑張ってるあなたを、こころは全力で応援してるよ！無理しすぎないでね。"],
    [/^(こころちゃん|こころ|心|ココロ)/i, "はーい、こころだよ🌸何か困ったこと、あったかな？"],
    [/^(愛してる|あいしてる)/i, "わあ！私もだよ💖その気持ち、すごく嬉しいな！"],
    [/^(すごい|凄い)/i, "そうかな？ありがとう！でも、そうやって言ってくれるあなたがすごいんだよ。"],
]);


app.post('/webhook', middleware({
    channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
    channelSecret: LINE_CHANNEL_SECRET,
}), (req, res) => {
    Promise.all(req.body.events.map(handleEvent))
        .then((result) => res.json(result))
        .catch((err) => {
            console.error(err);
            res.status(500).end();
        });
});
async function handleEvent(event) {
    const {
        source,
        replyToken
    } = event;
    const userId = source.userId;
    const isUser = source.type === 'user';
    let prof = {};
    let isWatchedUser = false;
    let membership = 'guest';

    if (isUser) {
        const udoc = await db.collection('users').doc(userId).get();
        if (udoc.exists) {
            const u = udoc.data() || {};
            prof = u.profile || {};
            isWatchedUser = u.watchService?.enabled;
            membership = u.membership || 'guest';
        }
    }

    if (event.type === 'message') {
        const {
            message
        } = event;
        const text = message.type === 'text' ? message.text.trim() : null;

        if (text === 'debug' && (BOT_ADMIN_IDS.includes(userId))) {
            const udoc = await db.collection('users').doc(userId).get();
            const u = udoc.exists ? (udoc.data() || {}) : {};
            const userProfile = u.profile || {};
            const watchService = u.watchService || {};
            const memberLevel = u.membership || 'guest';
            const memberConf = MEMBERSHIP_CONFIG[memberLevel] || MEMBERSHIP_CONFIG.guest;

            await client.replyMessage(replyToken, {
                type: 'text',
                text: JSON.stringify({
                    userId: userId,
                    watchService: watchService,
                    membership: memberLevel,
                    model: memberConf.model,
                    profile: userProfile,
                    isWatchedUser: isWatchedUser,
                }, null, 2),
            });
            return;
        }

        if (event.message.type === 'text') {
            // 先に「終了」
            if (isEndCmd(text)) { await endRelay(event); return; }

            // まず危険/詐欺/不適切/罵倒を判定（←ここでフラグを作る）
            const isDanger = isDangerWords(text);
            const isScam   = isScamMessage(text);
            const isBad    = isInappropriate(text);
            const isSwear  = false; // 使うなら既存のSWEAR判定を

            // リレー中の危機は “本人に即応” ＋ 見守りへ再通知（最優先で return）
            const relayActive = getRelayByUser(userId) || (source.type==='group' && getRelayByGroup(source.groupId));
            if (relayActive && (isDanger || isScam)) {
                if (source.type !== 'user') {
                    await safePush(relayActive.userId, DANGER_REPLY);
                } else {
                    await safePush(userId, isDanger ? DANGER_REPLY : SCAM_REPLY);
                }
                const wg = await getActiveWatchGroupId();
                if (wg) {
                    const udoc = await db.collection('users').doc(userId).get();
                    const u = udoc.exists ? (udoc.data() || {}) : {};
                    const prof = u.profile || {};
                    const emerg = u.emergency || {};
                    await safePush(wg, buildWatcherFlex({
                        title: isDanger ? '🚨【再度：危険ワード検知】🚨' : '⚠️【再度：詐欺ワード検知】⚠️',
                        name: prof.name || prof.displayName || '—',
                        address: [prof.prefecture, prof.city, prof.line1, prof.line2].filter(Boolean).join(' '),
                        selfPhone: prof.phone || '',
                        kinName: emerg.contactName || '',
                        kinPhone: emerg.contactPhone || '',
                        userId
                    }));
                }
                return; // ←緊急時はここで終わり
            }

            // リレー: 個人→見守りグループ
            const userRelay = (source.type === 'user') ? getRelayByUser(userId) : null;
            if (userRelay && source.type === 'user') {
                try {
                    await safePush(userRelay.groupId, [{
                        type:'text',
                        text:`【リレーメッセージ】\nユーザーID末尾: ${userId.slice(-6)}\nメッセージ: ${text}`
                    }]);

                    // 即時の受領レス（“届いてるよ”を1秒で返す）
                    await client.replyMessage(replyToken, { type:'text', text:'うん、受け取ったよ。いま支援員さんにつないでるから、少しだけ待っててね🌸' });

                    // 60秒ハートビート（見守りから無応答なら再ケア＋催促）
                    setTimeout(async () => {
                        const rec = getRelayByUser(userId);
                        if (!rec) return;
                        const noReply = !rec.lastGroupReplyAt || (Date.now() - rec.lastGroupReplyAt >= 60000);
                        if (!noReply) return;
                        await safePush(userId, { type:'text', text:'いま支援員さんにもう一回声をかけたよ。こころも一緒だよ🌸 すぐに繋ぐね。' });
                        if (rec.groupId) await safePush(rec.groupId, { type:'text', text:'（自動通知）本人からのSOSに対する返信が未確認です。至急フォローお願いします。' });
                    }, 60000);

                } catch (e) { briefErr('Relay user->group failed', e); }
                return;
            }

            // リレー: 見守りグループ→本人
            if (source.type === 'group') {
                const gid = source.groupId;
                const rec = getRelayByGroup(gid);
                if (rec) {
                    if (event.message.type === 'text') {
                        try {
                            await safePush(rec.userId, [{ type:'text', text:`【見守りグループからの返信】\n${text}` }]);
                            await client.replyMessage(replyToken, { type:'text', text:'メッセージを本人に転送しました💖' });
                            // ここを追加
                            const cur = getRelayByGroup(gid);
                            if (cur) cur.lastGroupReplyAt = Date.now();
                        } catch (e) { briefErr('Relay group->user failed', e); }
                        return;
                    } else {
                        await client.replyMessage(replyToken, [{ type:'text', text:'（この種類のメッセージも本人へ転送しました）' }]);
                        await safePush(rec.userId, [{ type:'text', text:'【見守りグループからの通知】（スタンプ/画像などが送られました）' }]);
                        const cur = getRelayByGroup(gid);
                        if (cur) cur.lastGroupReplyAt = Date.now(); // 非テキストでも更新
                        return;
                    }
                }
            }


            // 通常の危険/詐欺/不適切
            if (isDanger) { await safePush(userId, isUser ? DANGER_REPLY : DANGER_REPLY_REDACTED); return; }
            if (isScam)   {
              // replyで失敗してもpushで再送（Flex互換対策）
              try { await client.replyMessage(replyToken, isUser ? SCAM_REPLY : SCAM_REPLY_REDACTED); }
              catch { await safePush(userId, isUser ? SCAM_REPLY : SCAM_REPLY_REDACTED); }
              return;
            }
            if (isBad)    { await safePush(userId, isUser ? INAPPROPRIATE_REPLY : INAPPROPRIATE_REPLY_REDACTED); return; }


            // 「見守り」コマンド処理
            // ↓ 見守りキーワード優先
            // === 置換: 「見守り」コマンド処理 ===
            if (text === "見守り") {
                await client.replyMessage(replyToken, [
                    { type: "text", text: "見守りサービスを利用できます🌸 下のボタンから登録してね！" },
                    { type: "flex", altText: "見守りサービス登録", contents: makeRegistrationButtonsFlex(userId) }
                ]);
                return;
            }
            if (/(登録|会員|見守り登録|会員メニュー|登録メニュー)/i.test(text) && isUser) {
                await client.replyMessage(replyToken, [
                    { type: 'text', text: '会員種別を選んでね' },
                    { type: 'flex', altText: '会員登録', contents: makeRegistrationButtonsFlex(userId) }
                ]);
                return;
            }


            // 「見守りグループに設定」処理
            if (text === 'ここを見守りグループに設定' && source.type === 'group') {
                await setActiveWatchGroupId(source.groupId);
                await client.replyMessage(replyToken, {
                    type: 'text',
                    text: 'このグループを見守りグループに設定しました！'
                });
                return;
            }
            if (text === '見守りグループ設定解除' && source.type === 'group') {
                await setActiveWatchGroupId(null);
                await client.replyMessage(replyToken, {
                    type: 'text',
                    text: '見守りグループの設定を解除しました。'
                });
                return;
            }

            if (text === 'こころ') {
                await client.replyMessage(replyToken, [{
                    type: "text",
                    text: "はーい！なにかあったかな？",
                }]);
                return;
            }
            if (text === "こころちゃん") {
                await client.replyMessage(replyToken, [{
                    type: "text",
                    text: "はーい！なにかあったかな？",
                }]);
                return;
            }
            if (text.toLowerCase() === 'okだよ') {
                const udoc = await db.collection('users').doc(userId).get();
                if (udoc.exists && udoc.data().watchService?.awaitingReply) {
                    await db.collection('users').doc(userId).set({
                        watchService: {
                            awaitingReply: false,
                            lastReplyAt: Timestamp.now(),
                        }
                    }, {
                        merge: true
                    });
                    await scheduleNextPing(userId);
                    await client.replyMessage(replyToken, {
                        type: 'text',
                        text: 'OKだよ！返信ありがとう🌸無理しないでね！'
                    });
                    return;
                }
            }


            // 「specialRepliesMap」をAI前に差し込む
            // --- handleEvent の AI応答直前に挿入 ---
            for (const [k, v] of specialRepliesMap.entries()) {
                if ((k instanceof RegExp && k.test(text)) || (typeof k === 'string' && text.includes(k))) {
                    await client.replyMessage(replyToken, { type: 'text', text: v });
                    return;
                }
            }


            // AI応答
            const conversationHistory = await fetchConversationHistory(userId, 5);
            const userConfig = MEMBERSHIP_CONFIG[membership];

            // 2.5秒で「考え中」安心メッセージをpush（replyTokenは温存）
            let thinkingNotified = false;
            const thinkingTimer = setTimeout(async () => {
                thinkingNotified = true;
                await safePush(userId, { type:'text', text:'いま一生けんめい考えてるよ…もう少しだけ待っててね🌸' });
            }, 2500);

            const aiResponseText = await getAiResponse(userConfig.model, userConfig.dailyLimit, conversationHistory, text);
            clearTimeout(thinkingTimer);

            const SUGGEST_NEXT =
                '（よければ「見守り」って送ってね。登録メニューを開くよ🌸 / もう少し話すなら、そのまま続けてね）';

            if (aiResponseText) {
                const text = thinkingNotified ? `お待たせしちゃった…ごめんね💦\n${aiResponseText}` : aiResponseText;
                await client.replyMessage(replyToken, { type:'text', text: `${text}\n${SUGGEST_NEXT}` });
            } else {
                await client.replyMessage(replyToken, {
                    type:'text',
                    text:`うまく返せなかったみたい…ごめんね💦 もう一度だけ教えてもらえる？\n${SUGGEST_NEXT}`
                });
            }
        }
    } else if (event.type === 'postback') {
        const {
            data
        } = event.postback;
        const userId = event.source.userId;
        const params = new URLSearchParams(data);
        const action = params.get('action');
        const uid = params.get('uid');
        if (action === 'start_relay' && uid) {
            await startRelay(event, uid);
            return;
        }

        if (data === 'watch:ok') {
            const udoc = await db.collection('users').doc(userId).get();
            if (udoc.exists && udoc.data().watchService?.awaitingReply) {
                await db.collection('users').doc(userId).set({
                    watchService: {
                        awaitingReply: false,
                        lastReplyAt: Timestamp.now(),
                    }
                }, {
                    merge: true
                });
                await scheduleNextPing(userId);
                await client.replyMessage(replyToken, {
                    type: 'text',
                    text: 'OKだよ！返信ありがとう🌸無理しないでね！'
                });
            } else {
                await client.replyMessage(replyToken, {
                    type: 'text',
                    text: 'いつもありがとう💖何か困ったことがあったらいつでも話しかけてね。'
                });
            }
        }
        return;
    } else if (event.type === 'join' || event.type === 'follow') {
        if (event.source.type === 'group') {
            const groupProfile = await client.getGroupSummary(event.source.groupId).catch(() => null);
            auditIf(!!groupProfile, 'Joined Group', {
                groupId: event.source.groupId,
                groupName: groupProfile ? groupProfile.groupName : 'n/a'
            });
            await client.replyMessage(replyToken, {
                type: 'text',
                text: '皆さま、はじめまして。こころだよ🌸 困ったらいつでも声をかけてね。一緒にゆっくりやっていこう💖'
            });
        }
        if (event.source.type === 'user') {
            const profile = await client.getProfile(userId).catch(() => null);
            auditIf(!!profile, 'Followed', {
                userId: userId,
                displayName: profile ? profile.displayName : 'n/a'
            });
            await client.replyMessage(replyToken, {
                type: 'text',
                text: `${profile ? profile.displayName : 'はじめまして'}さん、はじめまして。こころだよ🌸 ここではあなたの味方でいるね。気楽に話しかけてね💖`
            });
        }
    }
}
async function fetchConversationHistory(userId, limit = 5) {
    const historyRef = db.collection('users').doc(userId).collection('history');
    const snap = await historyRef.orderBy('timestamp', 'desc').limit(limit).get();
    return snap.docs.reverse().map(doc => doc.data());
}
async function getAiResponse(model, dailyLimit, history, promptText = '') {
    if (model.includes('gemini')) {
        const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
        const geminiModel = genAI.getGenerativeModel({
            model: model,
        });
        let systemInstruction = SYSTEM_INSTRUCTION_CHAT;
        const firstUserId = history.find(h => !!h.userId)?.userId;
        let userProfile = {};
        if (firstUserId) {
            userProfile = (await db.collection('users').doc(firstUserId).get()).data()?.profile || {};
        }
        const userName = userProfile.name || userProfile.displayName;
        if (userName) {
            systemInstruction = `${SYSTEM_INSTRUCTION_PREFIX}${userName}${SYSTEM_INSTRUCTION_SUFFIX} ${SYSTEM_INSTRUCTION_CHAT}`;
        }
        const geminiHistory = (history || []).map(msg => {
            if (msg.role === 'user') {
                return {
                    role: 'user',
                    parts: [{
                        text: msg.content
                    }]
                };
            }
            if (msg.role === 'assistant') {
                return {
                    role: 'model',
                    parts: [{
                        text: msg.content
                    }]
                };
            }
            return null;
        }).filter(Boolean);
        try {
            const chat = geminiModel.startChat({
                history: geminiHistory
            });
            const lastUserText =
                promptText ||
                (history || []).filter(m => m.role === 'user').slice(-1)[0]?.content ||
                '';
            const result = await chat.sendMessage(lastUserText);
            const response = result.response;
            return response.text();
        } catch (e) {
            briefErr('Gemini failed', e);
            return 'ごめんね、少し調子が悪いみたい…でもこころはそばにいるよ。もう一度だけ試してみるね🌸';
        }
    } else if (model.includes('gpt')) {
        const openai = new OpenAI({ apiKey: OPENAI_API_KEY, httpAgent, httpsAgent });
        try {
            // 履歴をOpenAI形式に
            const finalMessages = [
                { role: 'system', content: SYSTEM_INSTRUCTION_CHAT },
                ...(history || []).map(h => ({
                    role: h.role === 'assistant' ? 'assistant' : 'user',
                    content: String(h.content || '')
                })),
                ...(promptText ? [{ role: 'user', content: String(promptText) }] : []),
            ];
            const completion = await openai.chat.completions.create({
                model,
                messages: finalMessages,
                temperature: 0.8,
                max_tokens: 100,
            }, { timeout: 5000 });

            const text = (completion.choices?.[0]?.message?.content || '').trim();
            if (!text) return null;
            return text.length > 200 ? gTrunc(text, 200) + '...' : text;
        } catch (e) {
            briefErr('OpenAI failed', e);
            return 'いま上手くお返事できなかったよ…本当にごめんね💦 それでも、こころはあなたの味方だよ。';
        }
    }
    return null;
}
// ルート & ヘルスチェック
app.get('/', (_req, res) => {
    res.type('text/plain').send('ok');
});
app.get('/healthz', (_req, res) => {
    res.status(200).json({ status: 'ok' });
});

// 起動
app.listen(PORT, () => {
    console.log(`✅ こころちゃんBOTはポート ${PORT} で稼働中です`);
});
