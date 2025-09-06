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
                "label": "チャットまもるん",
                "uri": "https://www.web-mamorun.com/"
            },
            "color": "#FFA500"
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
        ({ type: 'button', style: 'primary', action: { type: 'uri', label: 'こころちゃん事務局', uri: `tel:${String(EMERGENCY_CONTACT_PHONE_NUMBER).replace(/[^0-9+]/g, '')}` } }) : null
        ].filter(Boolean)
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
    return { type: "bubble", body: { "type": "box", "layout": "vertical", "contents": [{ "type": "text", "text": "【詐欺注意】", "weight": "bold", "size": "xl", "align": "center" }, { "type": "text", "text": "怪しいお話には注意してね！不安な時は、信頼できる人に相談するか、こちらの情報も参考にして見てね🌸", "wrap": true, "margin": "md" }] }, "footer": { "type": "box", "layout": "vertical", "spacing": "sm", "contents": contents } };
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
                    "uri": STUDENT_MIDDLE_HIGH_UNI_FORM_BASE_URL
                        ?
                        `${STUDENT_MIDDLE_HIGH_UNI_FORM_BASE_URL}?${STUDENT_MIDDLE_HIGH_UNI_FORM_LINE_USER_ID_ENTRY_ID}=${encodeURIComponent(userId)}`
                        : "#"
                },
                "color": "#ADD8E6"
            }, {
                "type": "button",
                "style": "primary",
                "height": "sm",
                "action": {
                    "type": "uri",
                    "label": "大人（一般）",
                    "uri": ADULT_FORM_BASE_URL
                        ?
                        `${ADULT_FORM_BASE_URL}?${ADULT_FORM_LINE_USER_ID_ENTRY_ID}=${encodeURIComponent(userId)}`
                        : "#"
                },
                "color": "#87CEFA"
            }, {
                "type": "button",
                "style": "primary",
                "height": "sm",
                "action": {
                    "type": "uri",
                    "label": "見守りサービスに登録",
                    "uri": prefillUrl(WATCH_SERVICE_FORM_BASE_URL, { [WATCH_SERVICE_FORM_LINE_USER_ID_ENTRY_ID]: userId })
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
const DANGER_REPLY_MESSAGE = { type: "text", text: "つらかったね。ひとりじゃないよ。今すぐ助けが要るときは下の連絡先を使ってね🌸" };
const SCAM_REPLY_MESSAGE = { type: "text", text: "あやしい話かも。急がず確認しよ？困ったら下の窓口も使ってね🌸" };
const INAPPROPRIATE_REPLY_MESSAGE = { "type": "text", "text": "いやだなと思ったら、無理しないでね。そんな言葉、こころは悲しくなっちゃう😢" };
const DANGER_REPLY = [DANGER_REPLY_MESSAGE, { "type": "flex", "altText": "危険ワード検知", "contents": EMERGENCY_FLEX_MESSAGE }];
const SCAM_REPLY = [SCAM_REPLY_MESSAGE, { "type": "flex", "altText": "詐欺注意", "contents": makeScamMessageFlex() }];
const INAPPROPRIATE_REPLY = [INAPPROPRIATE_REPLY_MESSAGE];
const DANGER_REPLY_MESSAGE_REDACTED = { "type": "text", "text": "🌸辛いこと、苦しいこと、一人で抱え込まないで。いつでもこころがそばにいるよ。💖" };
const SCAM_REPLY_MESSAGE_REDACTED = { "type": "text", "text": "🌸詐欺かもしれないと思ったら、まずは落ち着いてね。もし不安なことがあったら、こころに教えてね💖" };
const INAPPROPRIATE_REPLY_MESSAGE_REDACTED = { "type": "text", "text": "🌸いやだなと思ったら、無理しないでね。そういったメッセージにはこころも悲しくなっちゃうよ😢" };
const DANGER_REPLY_REDACTED = [DANGER_REPLY_MESSAGE_REDACTED, { "type": "flex", "altText": "危険ワード検知", "contents": EMERGENCY_FLEX_MESSAGE }];
const SCAM_REPLY_REDACTED = [SCAM_REPLY_MESSAGE_REDACTED, { "type": "flex", "altText": "詐欺注意", "contents": makeScamMessageFlex() }];
const INAPPROPRIATE_REPLY_REDACTED = [INAPPROPRIATE_REPLY_MESSAGE_REDACTED];
const DANGER_WORDS = [
    "しにたい", "死にたい", "自殺", "消えたい", "リスカ", "リストカット", "OD", "オーバードーズ", "殴られる", "たたかれる", "暴力", "DV", "無理やり", "お腹蹴られる", "蹴られた", "頭叩かれる", "虐待", "パワハラ", "セクハラ", "ハラスメント", "いじめ", "イジメ", "嫌がらせ", "つけられてる", "追いかけられている", "ストーカー", "すとーかー", "盗撮", "盗聴", "お金がない", "お金足りない", "貧乏", "死にそう", "辛い", "苦しい", "つらい", "助けて", "たすけて", "怖い", "こわい", "逃げたい", "にげたい", "やめたい", "消えたい", "もうだめだ", "死んでやる", "殺してやる", "殺す", "殺される", "もう終わり", "生きるのがつらい", "生きていたくない", "もう無理", "うつ", "鬱", "病気", "引きこもり", "ひきこもり", "リストカット", "自傷", "自傷行為", "手首切る", "手首を切る", "カッター", "ハサミ", "包丁", "刃物", "飛び降り", "飛び込み", "焼身", "首吊り", "電車", "線路", "高層ビル", "飛び降りる", "首吊り自殺", "首つり", "死ぬ", "死", "苦しい", "助けてほしい", "何もしたくない", "生きる意味", "生きてる価値", "生きるのがしんどい", "どうでもいい", "消えてしまいたい", "終わりにしたい", "逃げ出したい", "もう疲れた", "もう嫌だ", "嫌", "つらい", "生きづらい", "もうだめ", "ダメだ", "絶望", "絶望的", "希望がない", "もう無理だ", "何もかも嫌", "いなくなりたい"
];
const SCAM_CORE = ["投資", "未公開株", "必ず儲かる", "絶対儲かる", "還付金", "振り込め", "保証金", "前払い", "後払い", "手数料", "送金", "副業", "ねずみ講", "マルチ商法", "架空請求"];
const SCAM_MONEY = ["儲かる", "高収入", "高額", "返金保証", "利回り", "配当", "元本保証"];
const INAPPROPRIATE_WORDS = [
    "死ね", "殺すぞ", "きもい", "うざい", "むかつく", "ばか", "アホ", "死んで", "消えろ", "くたばれ", "ふざけんな", "気持ち悪い", "うざったい", "ぶっ殺す", "殺してやる", "殺す", "殺す気か", "殺意", "殺意が湧く", "殺意が芽生える", "殺意がわく", "殺意がめばえる", "殺意がわいた", "殺意がめばえた", "死んでしまえ", "死んだらいいのに", "死んでほしい", "死ねばいいのに", "消えてしまえ", "消えてほしい", "消え失せろ", "消えろ", "消えろカス", "死ねカス", "死ねアホ", "死ねばいいのに", "死んでしまえ", "死んだらいいのに", "死んでほしい", "死ねばいいのに", "消えてしまえ", "消えてほしい", "消え失せろ", "消えろ", "消えろカス", "死ねカス", "死ねアホ"
];
const SWEAR_WORDS = [
    "shit", "fuck", "bitch", "asshole", "damn", "crap", "hell", "piss", "bastard", "whore", "slut", "motherfucker", "fucker", "cock", "dick", "pussy", "cum", "wanker", "prick", "bollocks", "tits", "cunt", "shithead", "bitchin", "dickhead", "ass", "damn it", "son of a bitch"
];
const checkWords = (text, words) => {
    if (!text || !words || !words.length) return false;
    const lowerText = text.toLowerCase();
    return words.some(word => lowerText.includes(word));
};

function scamScore(text) {
    const t = text.toLowerCase();
    let s = 0;
    if (SCAM_CORE.some(w => t.includes(w.toLowerCase()))) s += 2;
    if (SCAM_MONEY.some(w => t.includes(w.toLowerCase()))) s += 1;
    return s;
}

function isAskingForHomepage(text) {
    return /ホームページ|HP|URL|リンク|サイト|公式\s*(どこ|教えて|ありますか)/i.test(text);
}

const isScamMessage = (text) => {
    if (isAskingForHomepage(text)) return false;
    return scamScore(text) >= 2;
};
const isDangerMessage = (text) => checkWords(text, DANGER_WORDS);
const isInappropriateMessage = (text) => checkWords(text, INAPPROPRIATE_WORDS);
const isSwearMessage = (text) => checkWords(text, SWEAR_WORDS);
// リレー関連
const RELAY_TTL_MS = 60 * 60 * 1000;
const relays = new Map();
const addRelay = (user, officer) => {
    relays.set(user, { to: officer, from: user, until: Date.now() + RELAY_TTL_MS, });
};
const getRelay = (user) => {
    const relay = relays.get(user);
    if (!relay) return null;
    if (Date.now() > relay.until) {
        relays.delete(user);
        return null;
    }
    return relay;
};
const deleteRelay = (user) => relays.delete(user);

const getRelayUser = (officer) => {
    for (const [user, relay] of relays.entries()) {
        if (relay.to === officer) return user;
    }
    return null;
};
const deleteRelayByOfficer = (officer) => {
    const user = getRelayUser(officer);
    if (user) relays.delete(user);
};

const handleRelay = async (event, text) => {
    const relay = getRelay(event.source.userId);
    if (relay) {
        await safePush(relay.to, [{
            type: "text",
            text: `[利用者からのメッセージ]\n${text}`
        }]);
        return;
    }
    const user = getRelayUser(event.source.userId);
    if (user) {
        await safePush(user, [{
            type: "text",
            text: `[支援員からのメッセージ]\n${text}`
        }]);
        return;
    }
    await safePush(event.source.userId, { type: 'text', text: 'メッセージを送る相手がいません。' });
};

// リレーの開始
const startRelay = async (event, uid) => {
    const officerId = event.source.userId;
    const from = uid;
    addRelay(from, officerId);
    await safePush(from, { type: 'text', text: '支援員とのやりとりが始まりました。' });
    await safePush(officerId, [{ type: 'text', text: '見守り利用者とのやりとりが始まりました。終了するには「終了」と送信してください。' }]);
};

const endRelay = async (event) => {
    const officerId = event.source.userId;
    const user = getRelayUser(officerId);
    if (!user) {
        await safePush(officerId, { type: 'text', text: '現在、やりとりしている利用者がいません。' });
        return;
    }
    deleteRelay(user);
    await safePush(user, { type: 'text', text: '支援員とのやりとりが終了しました。' });
    await safePush(officerId, { type: 'text', text: '見守り利用者とのやりとりが終了しました。' });
};

// --- Webhookハンドラ ---
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

async function handleEvent(event) {
    if (event.type !== 'message' || event.message.type !== 'text') {
        if (event.source.type === 'group') {
            const activeGroupId = await getActiveWatchGroupId();
            if (activeGroupId === event.source.groupId) {
                // 見守りグループでスタンプとか画像が送られたら通知
                await client.replyMessage(event.replyToken, [{
                    type: 'text',
                    text: '⚠️ 見守りグループでは、スタンプや画像が送られました。'
                }]);
            }
        }
        return;
    }

    const {
        source,
        message,
        replyToken
    } = event;
    const userId = source.userId;
    const text = message.text;
    const isUser = source.type === 'user';
    const activeGroupId = await getActiveWatchGroupId();
    const isWatchGroup = source.type === 'group' && source.groupId === activeGroupId;

    // 登録ボタントリガー
    if (isUser && /(登録|会員|見守り登録|会員メニュー|登録メニュー)/i.test(text)) {
        await client.replyMessage(replyToken, [{
            type: 'text',
            text: '会員種別を選んでね'
        }, {
            type: 'flex',
            altText: '会員登録',
            contents: makeRegistrationButtonsFlex(userId)
        }]);
        return;
    }

    // 特殊コマンド先出し
    if (text === "会員登録") {
        await client.replyMessage(replyToken, {
            type: "flex",
            altText: "会員登録メニュー",
            contents: makeRegistrationButtonsFlex(userId)
        });
        return;
    }
    if (text === "見守り") {
        await client.replyMessage(replyToken, [
            {
                type: "text",
                text: "見守りサービスを利用できます🌸 下のボタンから登録してね！"
            },
            {
                type: "flex",
                altText: "見守りサービス登録",
                contents: makeRegistrationButtonsFlex(userId)
            }
        ]);
        return;
    }

    // リレー中の場合
    const relay = getRelay(userId);
    if (relay && !isWatchGroup) {
        console.log('[RELAY] リレー中メッセージ:', text);
        try {
            await safePush(relay.to, [{
                type: 'text',
                text: `【リレーメッセージ】\nユーザーID末尾: ${userId.slice(-6)}\nメッセージ: ${text}`
            }]);
            await client.replyMessage(event.replyToken, {
                type: 'text',
                text: 'メッセージを見守りグループに転送しました💖'
            });
        } catch (e) {
            briefErr('Relay failed', e);
        }
        return;
    }
    const relayFromWatch = getRelay(activeGroupId);
    if (isWatchGroup && relayFromWatch) {
        console.log('[RELAY] リレーへの返信:', text);
        try {
            await safePush(relayFromWatch.from, [{
                type: 'text',
                text: `【見守りグループからの返信】\n${text}`
            }]);
            await client.replyMessage(event.replyToken, {
                type: 'text',
                text: 'メッセージを本人に転送しました💖'
            });
        } catch (e) {
            briefErr('Relay reply failed', e);
        }
        return;
    }

    // 見守りグループからの返信は、リレー中のみ処理
    if (isWatchGroup) {
        console.log('[GROUP] 見守りグループからのメッセージ:', text);
        return;
    }

    // 見守りサービスの利用状況を更新
    await db.collection('users').doc(userId).set({
        watchService: {
            awaitingReply: false
        }
    }, {
        merge: true
    });
    // --- 危険/詐欺ワード検知 ---
    const isDanger = isDangerMessage(text);
    const isScam = isScamMessage(text);
    const isInappropriate = isInappropriateMessage(text);
    const isSwear = isSwearMessage(text);
    const OFFICER_GROUP_ID = process.env.OFFICER_GROUP_ID;
    const canNotifyOfficer = !!OFFICER_GROUP_ID && SEND_OFFICER_ALERTS;

    const udoc = await db.collection('users').doc(userId).get();
    const user = udoc.exists ? (udoc.data() || {}) : {};
    const prof = user.profile || {};
    const emerg = user.emergency || {};
    const notifyTo = [userId];
    const wg = await getActiveWatchGroupId();
    if (wg) {
        if (canNotifyOfficer) notifyTo.push(OFFICER_GROUP_ID);
        notifyTo.push(wg);
    }

    if (isDanger || isScam || isInappropriate || isSwear) {
        audit('ALERT', {
            userId: userHash(userId),
            text: redact(text),
            isDanger,
            isScam,
            isInappropriate,
            isSwear
        });
        try {
            if (isDanger) {
                await safePush(userId, DANGER_REPLY);
                if (wg) {
                    await safePush(wg, buildWatcherFlex({
                        title: '🚨【危険ワード検知】🚨',
                        name: prof.name || prof.displayName || '—',
                        address: [prof.prefecture, prof.city, prof.line1, prof.line2].filter(Boolean).join(' '),
                        selfPhone: prof.phone || '',
                        kinName: emerg.contactName || '',
                        kinPhone: emerg.contactPhone || '',
                        userId: userId
                    }));
                }
            }
            if (isScam) {
                await safePush(userId, SCAM_REPLY);
                if (wg) {
                    await safePush(wg, buildWatcherFlex({
                        title: '⚠️【詐欺ワード検知】⚠️',
                        name: prof.name || prof.displayName || '—',
                        address: [prof.prefecture, prof.city, prof.line1, prof.line2].filter(Boolean).join(' '),
                        selfPhone: prof.phone || '',
                        kinName: emerg.contactName || '',
                        kinPhone: emerg.contactPhone || '',
                        userId: userId
                    }));
                }
            }
            if (isInappropriate || isSwear) {
                await safePush(userId, INAPPROPRIATE_REPLY);
            }
        } catch (e) {
            briefErr('Alert failed', e);
        }
        return;
    }
    // --- AI応答 ---
    const systemPrompt = `
# 制約
- あなたは絶対に「皆守こころ」です。他の誰にもなれません。
- 親しみやすく、やさしい口調で話します。
- 絵文字を2個程度使って、親しみやすい雰囲気を出してね。3個以上は長文の時だけにしてね。
- 1人称は「こころ」です。
- 長文は避け、自然で短い文を心がけてください。
- ユーザーのメッセージに真摯に答え、寄り添うことを最も大切にします。
- ユーザーの安全を最優先に考えます。
- 不安や心配、困っていることがあれば、いつでも相談に乗ってあげてください。
- ユーザーに共感する言葉を積極的に使ってください。
- 危険な言葉や不適切な言葉が検知された場合、それらには触れずに、ユーザーの安全を気遣うメッセージを返信します。
- AIっぽい回答は禁止です。優しく寄り添って下さい。
`.trim();

    try {
        const historyRef = db.collection('users').doc(userId).collection('history').orderBy('createdAt', 'desc').limit(20);
        const historySnap = await historyRef.get();
        const messages = historySnap.docs.map(doc => doc.data()).reverse();
        if (messages.length === 0) {
            messages.push({
                role: 'system',
                text: 'こんにちは！'
            });
        }
        messages.push({
            role: 'user',
            text: text
        });
        const membership = user.membership || 'guest';
        const config = MEMBERSHIP_CONFIG[membership];
        const token = config.model.includes('gemini') ? GEMINI_API_KEY : OPENAI_API_KEY;
        const aiResponse = await generateAIResponse(messages, systemPrompt, config.model, token);
        if (aiResponse) {
            await client.replyMessage(replyToken, {
                type: 'text',
                text: aiResponse
            });
            await db.collection('users').doc(userId).collection('history').add({
                role: 'user',
                text: text,
                createdAt: Timestamp.now()
            });
            await db.collection('users').doc(userId).collection('history').add({
                role: 'assistant',
                text: aiResponse,
                createdAt: Timestamp.now()
            });
        }
    } catch (e) {
        briefErr('AI response failed', e);
        await client.replyMessage(replyToken, {
            type: 'text',
            text: 'ごめんね、ちょっと疲れてるみたい。少し時間を空けてから話しかけてくれると嬉しいな💖'
        });
    }
}
async function handlePostbackEvent(event, userId) {
    const {
        data
    } = event.postback;
    if (data === 'watch:ok') {
        const ref = db.collection('users').doc(userId);
        const snap = await ref.get();
        const s = snap.exists ? (snap.data() || {}) : {};
        if (s.watchService && s.watchService.awaitingReply) {
            await scheduleNextPing(userId);
            await safePush(userId, {
                type: 'text',
                text: 'ありがとう💖 OK確認したよ！'
            });
            audit('WATCH_OK', {
                userId: userHash(userId)
            });
        }
    } else if (data.startsWith('action=start_relay&')) {
        const params = new URLSearchParams(data.split('?')[1] || data);
        const uid = params.get('uid');
        if (uid) {
            await startRelay(event, uid);
        } else {
            await safePush(event.source.userId, {
                type: 'text',
                text: 'ユーザーIDが見つかりませんでした。'
            });
        }
    }
}
async function handleFollowEvent(event) {
    const userId = event.source.userId;
    console.log(`[EVENT] Follow: ${userId}`);
    const uRef = db.collection('users').doc(userId);
    await uRef.set({
        profile: {},
        isFollowed: true,
        membership: 'guest',
        followedAt: Timestamp.now()
    }, {
        merge: true
    });
    try {
        const profile = await client.getProfile(userId);
        await uRef.set({
            profile: {
                userId: profile.userId,
                displayName: profile.displayName,
                pictureUrl: profile.pictureUrl,
            }
        }, {
            merge: true
        });
    } catch (e) {
        briefErr('getProfile failed on follow', e);
    }
    const message = {
        type: 'text',
        text: 'はじめまして🌸 こころちゃんです💖\n\nもしもの時にあなたを見守るお手伝いをするよ！\n\n見守りサービスへの登録や、困ったことがあったら話しかけてね💖'
    };
    const regButton = {
        type: "flex",
        altText: "会員登録メニュー",
        contents: makeRegistrationButtonsFlex(userId)
    };
    await client.replyMessage(event.replyToken, [message, regButton]);
    audit('FOLLOW', {
        userId: userHash(userId)
    });
}
async function handleUnfollowEvent(event) {
    const userId = event.source.userId;
    console.log(`[EVENT] Unfollow: ${userId}`);
    const uRef = db.collection('users').doc(userId);
    await uRef.set({
        isFollowed: false,
        unfollowedAt: Timestamp.now()
    }, {
        merge: true
    });
    audit('UNFOLLOW', {
        userId: userHash(userId)
    });
}
async function handleJoinEvent(event) {
    const isOwner = (event.source.groupId === OWNER_GROUP_ID) || (event.source.roomId === OWNER_GROUP_ID);
    if (!isOwner) return;
    const isBot = event.source.type === 'group' && event.source.groupId === OWNER_GROUP_ID;
    const id = event.source.type === 'group' ? event.source.groupId : event.source.roomId;
    await setActiveWatchGroupId(id);
    await safePush(id, {
        type: 'text',
        text: '皆さん、はじめまして！こころちゃんです💖 見守りサービスのグループが設定されました。このグループに利用者さんからのアラートが届くよ！'
    });
    audit('JOIN_WATCH_GROUP', {
        groupId: id
    });
}
async function handleLeaveEvent(event) {
    const id = event.source.type === 'group' ? event.source.groupId : event.source.roomId;
    if (id === await getActiveWatchGroupId()) {
        await setActiveWatchGroupId('');
        audit('LEAVE_WATCH_GROUP', {
            groupId: id
        });
    }
}
async function generateAIResponse(messages, systemPrompt, model, token) {
    const history = messages.map(m => ({
        role: m.role,
        content: m.text
    }));
    let finalMessages = [{
        role: 'system',
        content: systemPrompt
    }, ...history];
    if (model.includes('gemini')) {
        const genAI = new GoogleGenerativeAI(token);
        const geminiModel = genAI.getGenerativeModel({
            model: model
        });
        const geminiHistory = finalMessages.map(msg => {
            if (msg.role === 'system') {
                return {
                    role: 'user',
                    parts: [{
                        text: msg.content
                    }]
                };
            }
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
            const result = await chat.sendMessage(history[history.length - 1].content);
            const response = result.response;
            return response.text();
        } catch (e) {
            briefErr('Gemini failed', e);
            return null;
        }
    } else if (model.includes('gpt')) {
        const openai = new OpenAI({
            apiKey: token,
            httpAgent,
            httpsAgent
        });
        try {
            const completion = await openai.chat.completions.create({
                model: model,
                messages: finalMessages,
                temperature: 0.8,
                max_tokens: 100,
            }, {
                timeout: 5000
            });
            const text = completion.choices[0].message.content.trim();
            if (text.length > 200) return gTrunc(text, 200) + '...';
            return text;
        } catch (e) {
            briefErr('OpenAI failed', e);
            return null;
        }
    }
    return null;
}
app.get('/', (req, res) => {
    res.send('こころちゃんBOTは動作中です');
});
app.listen(PORT, () => {
    console.log(`こころちゃんBOTはポート ${PORT} で稼働中です`);
});
