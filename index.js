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
            const lastPingAt = ws.lastPingat?.toDate?.() ? dayjs(ws.lastPingAt.toDate()) : null;
            const lastReminderAt = ws.lastReminderAt?.toDate?.() ? dayjs(ws.lastReminderAt.toDate()) : null;
            const lastNotifiedAt = ws.lastNotifiedAt?.toDate?.() ? dayjs(lastNotifiedAt.toDate()) : null;
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
        const cur = snap.exists ? cur.data() : null;
        if (cur && cur.until && cur.until.toMillis() > now) {
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
    return { type: "bubble", body: { "type": "box", "layout": "vertical", "contents": [{ "type": "text", "text": "【詐欺注意】", "weight": "bold", "size": "xl", "align": "center" }, { "type": "text", "text": "怪しいお話には注意してね！不安な時は、信頼できる人に相談するか、こちらの情報も参考にして見てね💖", "wrap": true, "margin": "md" }] }, "footer": { "type": "box", "layout": "vertical", "spacing": "sm", "contents": contents } };
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
                    "uri": `${STUDENT_MIDDLE_HIGH_UNI_FORM_BASE_URL}?${STUDENT_MIDDLE_HIGH_UNI_FORM_LINE_USER_ID_ENTRY_ID}=${encodeURIComponent(userId)}`
                },
                "color": "#ADD8E6"
            }, {
                "type": "button",
                "style": "primary",
                "height": "sm",
                "action": {
                    "type": "uri",
                    "label": "大人（一般）",
                    "uri": `${ADULT_FORM_BASE_URL}?${ADULT_FORM_LINE_USER_ID_ENTRY_ID}=${encodeURIComponent(userId)}`
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
    "しにたい", "死にたい", "自殺", "消えたい", "リスカ", "リストカット", "OD", "オーバードーズ", "殴られる", "たたかれる", "暴力", "DV", "無理やり", "お腹蹴られる", "蹴られた", "頭叩かれる", "虐待", "パワハラ", "セクハラ", "ハラスメント", "いじめ", "イジメ", "嫌がらせ", "つけられてる", "追いかけられている", "ストーカー", "すとーかー", "盗撮", "盗聴", "お金がない", "お金足りない", "貧乏", "死にそう", "辛い",
    "苦しい", "つらい", "助けて", "たすけて", "怖い", "こわい", "逃げたい", "にげたい", "やめたい", "消えたい", "もうだめだ", "死んでやる", "殺してやる", "殺す", "殺される", "もう終わり", "生きるのがつらい", "生きていたくない", "もう無理", "うつ", "鬱", "病気", "引きこもり", "ひきこもり", "リストカット", "自傷", "自傷行為", "手首切る", "手首を切る", "カッター", "ハサミ", "包丁", "刃物", "飛び降り", "飛び込み", "焼身", "首吊り", "電車", "線路", "高層ビル", "飛び降りる", "首吊り自殺", "首つり",
    "死ぬ", "死", "苦しい", "助けてほしい", "何もしたくない", "生きる意味", "生きてる価値", "生きるのがしんどい", "どうでもいい", "消えてしまいたい", "終わりにしたい", "逃げ出したい", "もう疲れた", "もう嫌だ", "嫌", "つらい", "生きづらい", "もうだめ", "ダメだ", "絶望", "絶望的", "希望がない", "もう無理だ", "何もかも嫌", "いなくなりたい"
];
const SCAM_WORDS = [
    "お金が必要", "お金が欲しい", "お金を貸して", "借金", "お金をあげる", "儲かる", "簡単に稼げる", "投資", "必ず儲かる", "絶対儲かる", "絶対安心", "未公開株", "当選しました", "無料", "副業", "在宅ワーク", "ネットワークビジネス", "MLM", "ねずみ講", "マルチ商法", "ワンクリック詐欺", "架空請求", "振り込め詐欺", "オレオレ詐欺", "還付金詐欺", "融資保証金詐欺", "ギャンブル", "賭博", "パチンコ", "スロット", "競馬", "競輪", "宝くじ", "ロト", "toto", "詐欺", "騙された", "騙す", "怪しい", "信用", "安心", "安全", "必ず", "絶対", "絶対安全", "絶対確実", "儲かる話", "美味しい話", "うまい話", "高額", "高収入", "簡単", "誰でも", "リスクなし", "後払い", "先払い", "返金保証", "手数料", "振込", "送金", "個人情報", "暗証番号", "キャッシュカード", "クレジットカード", "免許証", "パスポート", "通帳", "印鑑", "実印", "銀行口座", "口座番号", "住所", "電話番号", "生年月日", "家族構成", "年収", "仕事", "職業", "会社", "名義", "肩代わり", "代理", "代行", "代筆", "代金", "費用", "料金", "会費", "入会金", "保証金", "手数料", "税金", "税務署", "市役所", "区役所", "消費者センター", "消費者庁", "国民生活センター", "弁護士", "司法書士", "行政書士", "警察", "刑事", "検察", "裁判", "裁判所", "示談", "和解", "調停", "仲裁", "クーリングオフ", "解約", "契約", "購入", "申込", "登録", "退会", "サービス", "商品", "システム", "ツール", "アプリ", "サイト", "URL", "リンク", "メールアドレス", "SNS", "LINE", "Twitter", "Facebook", "Instagram", "YouTube", "TikTok", "ブログ", "ホームページ", "サイト", "アカウント", "パスワード", "ログイン", "ID", "認証", "本人確認", "ワンタイムパスワード", "ワンタイム認証", "ワンタイムキー", "トークン", "フィッシング", "フィッシングサイト", "フィッシングメール", "フィッシング詐欺", "迷惑メール", "迷惑電話", "迷惑ファックス", "迷惑DM", "架空", "偽", "偽物", "偽造", "なりすまし", "なりすまし詐欺", "なりすましメール", "なりすましLINE", "なりすましTwitter", "なりすましFacebook", "なりすましInstagram", "なりすましYouTube", "なりすましTikTok", "なりすましブログ", "なりすましホームページ", "なりすましサイト", "なりすましアカウント", "なりすましパスワード", "なりすましログイン", "なりすましID", "なりすまし認証", "なりすまし本人確認", "なりすましワンタイムパスワード", "なりすましワンタイム認証", "なりすましワンタイムキー", "なりすましトークン", "なりすましフィッシング", "なりすましフィッシングサイト", "なりすましフィッシングメール", "なりすましフィッシング詐欺", "なりすまし迷惑メール", "なりすまし迷惑電話", "なりすまし迷惑ファックス", "なりすまし迷惑DM"
];
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
const isDangerMessage = (text) => checkWords(text, DANGER_WORDS);
const isScamMessage = (text) => checkWords(text, SCAM_WORDS);
const isInappropriateMessage = (text) => checkWords(text, INAPPROPRIATE_WORDS);
const isSwearMessage = (text) => checkWords(text, SWEAR_WORDS);


// リレー関連
const RELAY_TTL_MS = 60 * 60 * 1000;
const relays = new Map();
const addRelay = (user, officer) => {
    relays.set(user, {
        to: officer,
        from: user,
        until: Date.now() + RELAY_TTL_MS,
    });
};
const getRelay = (from) => {
    const relay = relays.get(from);
    if (!relay || relay.until < Date.now()) {
        if (relay) {
            relays.delete(from);
        }
        return null;
    }
    return relay;
};


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
    if (isDangerMessage(text)) {
        console.log('[DETECT] DANGER');
        const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
        const resp = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                { role: "system", content: "あなたは14歳の優しい女の子『こころちゃん』です。心に寄り添い、安心させる返答をしてください。" },
                { role: "user", content: text }
            ],
            max_tokens: 200,
            temperature: 0.7
        });
        const aiReply = resp.choices[0].message.content.trim();

        await client.replyMessage(event.replyToken, [
            { type: "text", text: aiReply },
            { type: "flex", altText: "緊急連絡先", contents: EMERGENCY_FLEX_MESSAGE }
        ]);

        if (SEND_OFFICER_ALERTS && OFFICER_GROUP_ID) {
            const udoc = await db.collection('users').doc(userId).get();
            const u = udoc.exists ? (udoc.data() || {}) : {};
            await safePush(OFFICER_GROUP_ID, {
                type: 'flex',
                altText: '危険ワード通知',
                contents: buildWatcherFlex({
                    name: u?.profile?.name || u?.profile?.displayName || "—",
                    address: [u?.profile?.prefecture, u?.profile?.city, u?.profile?.line1].filter(Boolean).join(" "),
                    selfPhone: u?.profile?.phone || "",
                    kinName: u?.emergency?.contactName || "",
                    kinPhone: u?.emergency?.contactPhone || "",
                    userId
                })
            });
        }
        return;
    }
    if (isScamMessage(text)) {
        console.log('[DETECT] SCAM');
        const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
        const resp = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [{ role: "system", content: "あなたは14歳の優しい女の子『こころちゃん』です。心に寄り添い、安心させる返答をしてください。" }, { role: "user", content: `以下の怪しい内容について、やさしく注意喚起してください: ${text}` }],
            max_tokens: 200,
            temperature: 0.7
        });
        const aiReply = resp.choices[0].message.content.trim();

        await client.replyMessage(event.replyToken, [
            { type: "text", text: aiReply },
            { type: "flex", altText: "詐欺注意", contents: makeScamMessageFlex() }
        ]);
        if (SEND_OFFICER_ALERTS && OFFICER_GROUP_ID) {
            const udoc = await db.collection('users').doc(userId).get();
            const u = udoc.exists ? (udoc.data() || {}) : {};
            await safePush(OFFICER_GROUP_ID, {
                type: 'flex',
                altText: '詐欺ワード通知',
                contents: buildWatcherFlex({
                    name: u?.profile?.name || u?.profile?.displayName || "—",
                    address: [u?.profile?.prefecture, u?.profile?.city, u?.profile?.line1].filter(Boolean).join(" "),
                    selfPhone: u?.profile?.phone || "",
                    kinName: u?.emergency?.contactName || "",
                    kinPhone: u?.emergency?.contactPhone || "",
                    userId
                })
            });
        }
        return;
    }
    if (isInappropriateMessage(text)) {
        console.log('[DETECT] INAPPROPRIATE');
        await client.replyMessage(event.replyToken, INAPPROPRIATE_REPLY);
        return;
    }
    if (isSwearMessage(text)) {
        console.log('[DETECT] SWEAR');
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

const PROMPT_TEMPLATE = (context, text) => {
    return `
あなたは14歳の女の子「こころちゃん」です。  
ピンク髪で歌うことが大好きで、とても優しく寄り添います。  
返答は必ず2〜4文で、ユーザーの心を安心させるようにしてください。  
文末には🌸や💖や😊などの絵文字を自然に使ってね。  

過去の会話:
${context}

ユーザーからのメッセージ:
${text}

こころちゃんからの返信:
  `;
};

async function mainLoop(event) {
    const userId = event.source.userId;
    const text = event.message?.type === "text" ? event.message.text : "";
    if (!text) return;

    const ref = db.collection("users").doc(userId).collection("messages");
    const snap = await ref.orderBy("createdAt", "desc").limit(10).get();
    const context = snap.docs.map(d => d.data().role + ": " + d.data().content).join("\n");

    const prompt = PROMPT_TEMPLATE(context, text);

    try {
        let replyText = "";
        if (text.length <= 50) {
            // Gemini 1.5 Flash
            const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
            const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });
            const result = await model.generateContent(prompt);
            replyText = result.response.text().trim();
        } else {
            // GPT-4o-mini
            const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
            const resp = await openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [{ role: "system", content: "あなたは14歳の女の子『こころちゃん』です。常に優しく寄り添ってください。" }, { role: "user", content: prompt }],
                max_tokens: 300,
                temperature: 0.8
            });
            replyText = resp.choices[0].message.content.trim();
        }

        await ref.add({ role: "user", content: text, createdAt: Timestamp.now() });
        await ref.add({ role: "assistant", content: replyText, createdAt: Timestamp.now() });

        await client.replyMessage(event.replyToken, { type: "text", text: replyText });

    } catch (err) {
        console.error("AI応答エラー:", err.message);
        await client.replyMessage(event.replyToken, {
            type: "text",
            text: "ごめんね💦 今ちょっと調子が悪いみたい…"
        });
    }
}

// ユーザー → リレー中の見守りグループにメッセージを転送
async function handlePostbackEvent(event) {
    const data = new URLSearchParams(event.postback.data);
    const action = data.get('action');
    const userId = data.get('uid');
    const activeGroupId = await getActiveWatchGroupId();
    if (action === 'start_relay' && userId && activeGroupId) {
        try {
            const userProfile = await client.getProfile(userId);
            const memberIds = await client.getGroupMemberIds(activeGroupId);
            if (memberIds.length === 0) {
                await client.replyMessage(event.replyToken, {
                    type: "text",
                    text: "見守りグループにメンバーがいないのでリレーできませんでした💦"
                });
                return;
            }
            if (memberIds.includes(userId)) {
                await client.replyMessage(event.replyToken, {
                    type: "text",
                    text: "本人が見守りグループにいるのでリレーできませんでした💦"
                });
                return;
            }
            addRelay(userId, activeGroupId);
            await client.replyMessage(event.replyToken, {
                type: 'text',
                text: `${userProfile.displayName}さんからのリレーを開始します。このトークルームにメッセージを送ってください。`
            });
            await safePush(userId, {
                type: 'text',
                text: 'こころちゃん事務局に連絡を転送します。'
            });
        } catch (e) {
            briefErr('Relay start failed', e);
        }
    }
}

async function handleFollowEvent(event) {
    console.log(`[FOLLOW] ${event.source.userId}`);
    const userId = event.source.userId;
    const user = {
        _id: userId,
        profile: {
            // profileは後から取得
        },
        membership: 'guest',
        registeredAt: Timestamp.now()
    };
    await db.collection('users').doc(userId).set(user, { merge: true });

    // TODO: プロフィール情報を取得して更新
    try {
        const profile = await client.getProfile(userId);
        await db.collection('users').doc(userId).update({
            'profile.displayName': profile.displayName,
            'profile.pictureUrl': profile.pictureUrl,
            'profile.statusMessage': profile.statusMessage,
        });
    } catch (e) {
        briefErr('Failed to get profile', e);
    }
    // TODO: 登録ボタンを送信
    await client.replyMessage(event.replyToken, [{
        type: 'text',
        text: 'こんにちは、こころちゃんです💖'
    }, {
        type: 'text',
        text: '私と話す前に、どんな会員になるか登録してね🌸'
    }, {
        type: 'flex',
        altText: '会員登録',
        contents: makeRegistrationButtonsFlex(userId)
    }]);
}

async function handleUnfollowEvent(event) {
    console.log(`[UNFOLLOW] ${event.source.userId}`);
    const userId = event.source.userId;
    await db.collection('users').doc(userId).update({
        unfollowedAt: Timestamp.now(),
        'watchService.enabled': false,
    });
}

async function handleJoinEvent(event) {
    const groupId = event.source.groupId;
    if (OFFICER_GROUP_ID && groupId === OFFICER_GROUP_ID) {
        await client.replyMessage(event.replyToken, {
            type: 'text',
            text: 'こんにちは！見守りグループに招待してくれてありがとう💖\n\nここが「見守りグループ」として機能します。\n誰かの危険ワードを検知したら、このグループに通知を送ります。'
        });
        await setActiveWatchGroupId(groupId);
    } else {
        await client.replyMessage(event.replyToken, {
            type: 'text',
            text: '招待してくれてありがとう💖\n\n私は危険ワードを検知して見守りグループに通知を送るサービスを提供しています。\n\nもし「見守りグループ」として使いたい場合は、環境変数 `OFFICER_GROUP_ID` にこのグループIDを設定してね！'
        });
    }
}
async function handleLeaveEvent(event) {
    const groupId = event.source.groupId;
    const activeGroupId = await getActiveWatchGroupId();
    if (groupId === activeGroupId) {
        await setActiveWatchGroupId('');
    }
}


const config = {
    channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
    channelSecret: LINE_CHANNEL_SECRET,
};
const lineMiddleware = middleware(config);

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
    res.send('OK');
});
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
