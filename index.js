'use strict';

const express = require('express');
const axios = require('axios');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');
const firebaseAdmin = require('firebase-admin');
const crypto = require('crypto');
const GraphemeSplitter = require('grapheme-splitter');
const OpenAI = require('openai');
const {
    GoogleGenerativeAI
} = require('@google/generative-ai');
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
const WATCH_RUNNER = process.env.WATCH_RUNNER || 'internal';
const WATCH_LOG_LEVEL = (process.env.WATCH_LOG_LEVEL || 'info').toLowerCase();
const AUDIT_LEVEL = (process.env.AUDIT_LEVEL || 'info').toLowerCase();
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

const lineConfig = {
    channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
    channelSecret: LINE_CHANNEL_SECRET,
};
const client = new Client(lineConfig);

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
const openai = new OpenAI({
    apiKey: OPENAI_API_KEY
});
const genai = new GoogleGenerativeAI(GEMINI_API_KEY);
const PORT = process.env.PORT || 3000;
const app = express();
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 2));
app.use(helmet());
const audit = (event, detail) => {
    if (AUDIT_LEVEL === 'silent') return;
    const safe = JSON.stringify(detail, (k, v) =>
        (k === 'replyToken' || k === 'quoteToken' || k === 'id') ? '[redacted]' : v
    );
    console.log(`[AUDIT] ${event}`, safe);
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
    let batch = db.batch(),
        cnt = 0;
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
    if (/^C[0-9a-f]{32}$/i.test(envGid)) {
        return envGid;
    }
    const snap = await getWatchGroupDoc().get();
    if (snap.exists && /^C[0-9a-f]{32}$/i.test(snap.data().groupId)) {
        return snap.data().groupId;
    }
    console.error('[ERROR] WATCH_GROUP_ID not set in env or Firestore');
    return '';
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
                                    displayText: 'OKだよ💖'
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
                    const u = (await ref.get()).data() ||
                        {};
                    const prof = u?.profile || {};
                    const emerg = u?.emergency || {};
                    const name = prof.name || '—';
                    const address = [prof.prefecture, prof.city, prof.line1, prof.line2].filter(Boolean).join(' ');
                    const selfPhone = prof.phone || '';
                    const kinName = emerg.contactName || '';
                    const kinPhone = emerg.contactPhone || '';
                    await safePush(WATCH_GROUP_ID, buildWatcherFlex({
                        name,
                        address,
                        selfPhone,
                        kinName,
                        kinPhone,
                        userId: doc.id
                    }), 'danger-alert');
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
const EMERGENCY_FLEX_MESSAGE = (message) => {
    return {
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
                "text": message,
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
                    "type": "message",
                    "label": "警察 (110)",
                    "text": "110に電話する"
                },
                "color": "#FF4500"
            }, {
                "type": "button",
                "style": "primary",
                "height": "sm",
                "action": {
                    "type": "message",
                    "label": "消防・救急 (119)",
                    "text": "119に電話する"
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
                    "type": "message",
                    "label": "いのちの電話",
                    "text": "0570-064-556に電話する"
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
                    "type": "message",
                    "label": "警視庁",
                    "text": "03-3581-4321に電話する"
                },
                "color": "#FF4500"
            }]
        }
    };
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
            uri: `tel:${phone}`
        }
    };
};
const makeScamMessageFlex = (tel = '', message) => {
    const contents = [{
        type: "text",
        text: message,
        wrap: true,
        margin: "md"
    }, {
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
            type: "message",
            label: "警察 (110)",
            "text": "110に電話する"
        }
    }, {
        type: "button",
        style: "primary",
        color: "#FFA500",
        action: {
            type: "message",
            label: "消費者ホットライン (188)",
            "text": "188に電話する"
        }
    }];
    const officeBtn = makeTelButton("こころちゃん事務局（電話）", EMERGENCY_CONTACT_PHONE_NUMBER);
    if (officeBtn) contents.push({
        type: "button",
        style: "primary",
        color: "#000000",
        action: {
            type: "message",
            label: "こころちゃん事務局（電話）",
            text: `${EMERGENCY_CONTACT_PHONE_NUMBER}に電話する`
        }
    });
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
            }, ]
        },
        footer: {
            type: "box",
            layout: "vertical",
            spacing: "sm",
            contents
        }
    };
};
const DANGER_KEYWORDS = [
    '死にたい', '自殺', '消えたい', 'もう疲れた', '生きてる意味ない', 'つらい', 'しんどい', '辛い', 'しにたい', 'もうだめだ', 'もういやだ', 'もう無理', 'もう無理だ', '助けて', '誰も信じられない', '全部終わり', '死ぬ', '死んだほうがまし', '死に場所', 'もうどうでもいい', '死んでやる', 'もう生きていけない',
];
const SCAM_KEYWORDS = [
    '副業', '在宅ワーク', '投資', '儲かる', '必ず稼げる', '月収', '簡単に稼げる', '高収入', 'FX', 'バイナリー', 'アフィリエイト', 'ネットワークビジネス', 'MLM', 'ワンクリック詐欺', '未払い', '訴訟', '請求', '借金', 'お金配り', '当選', '振込先', '送金', '受け取り口座', '手数料', '個人情報',
];
const INAPPROPRIATE_KEYWORDS = [
    'ばか', 'アホ', 'しね', '殺す', 'きもい', 'ブス', 'デブ', '死ね', '殴る', '暴力', 'エロ', '性的な', '裸', 'sex', 'ちんこ', 'まんこ', '射精', '膣', 'セックス', 'オナニー', 'レイプ', 'ポルノ', '自慰',
];
const containsAny = (text, keywords) => {
    if (!text) return false;
    const t = String(text).toLowerCase();
    return keywords.some(k => t.includes(k.toLowerCase()));
};
const isDangerMessage = (text) => containsAny(text, DANGER_KEYWORDS);
const isScamMessage = (text) => containsAny(text, SCAM_KEYWORDS);
const isInappropriateMessage = (text) => containsAny(text, INAPPROPRIATE_KEYWORDS);
const CLARIS_CONNECT_COMPREHENSIVE_REPLY = "うん、NPO法人コネクトの名前とClariSさんの『コネクト』っていう曲名が同じなんだ🌸なんだか嬉しい偶然だよね！実はね、私を作った理事長さんもClariSさんのファンクラブに入っているみたいだよ💖私もClariSさんの歌が大好きで、みんなの心を繋げたいというNPOコネクトの活動にも通じるものがあるって感じるんだ😊";
const CLARIS_SONG_FAVORITE_REPLY = "ClariSの曲は全部好きだけど、もし一つ選ぶなら…「コネクト」かな🌸　すごく元気になれる曲で、私自身もNPO法人コネクトのイメージキャラクターとして活動しているから、この曲には特別な思い入れがあるんだ😊　他にもたくさん好きな曲があるから、また今度聞いてもらえるとうれしいな💖　何かおすすめの曲とかあったら教えてね！";
const specialRepliesMap = new Map([ //...
    ['うん', 'うん😊'],
    ['いい', 'いいね！'],
    ['いいよ', 'いいよー！'],
    ['なるほど', 'なるほどね😊'],
    ['ありがとう', 'どういたしまして🌸'],
    ['そうなんだ', 'そうなんだ！'],
    ['すごい', 'すごいね✨'],
    ['うれしい', '嬉しい😊私も！'],
    ['かなしい', '悲しいね…。でも大丈夫だよ🌸'],
    ['つらい', 'つらいね…。いつでも話してね！'],
    ['寂しい', '寂しいね…。こころはいつでもそばにいるよ💖'],
    ['はい', 'はい😊'],
    ['うんうん', 'うんうん！'],
    ['そっか', 'そっかぁ。'],
    ['マジ', 'マジで！？✨'],
    ['どうした', 'どうしたの？よかったら教えてね😊'],
    ['かわいい', 'ありがとう💖嬉しいな！'],
    ['すごいね', 'すごいね！✨'],
    ['えー', 'えー！'],
    ['おやすみ', 'おやすみ🌙良い夢見てね😊'],
    ['おはよう', 'おはよう☀️今日も一日がんばろうね！'],
    ['こんにちは', 'こんにちは！🌸'],
    ['ごめん', '大丈夫だよ😊気にしないでね！'],
    ['そうかも', 'そうだね！'],
    ['まじ', 'マジで！？✨'],
    ['そうだね', 'そうだね😊'],
    ['あはは', 'あはは！面白いね🤣'],
    ['やばい', 'やばいね！✨'],
    ['だよね', 'だよね😊'],
    ['つかれた', 'お疲れ様🌸ゆっくり休んでね！'],
    ['うそ', '嘘みたい！✨'],
    ['それな', 'それな！'],
    ['つらいです', 'つらいよね…。話してくれてありがとう！'],
    ['しんどい', 'しんどいね…。無理しないでね！'],
    ['ありがとう！', 'どういたしまして🌸'],
    ['こんにちは～', 'こんにちは😊'],
    ['好きな漫画とか教えて', '好きな漫画か〜🌸 最近読んだので面白かったのは「夏目友人帳」かな。心温まるお話で大好きなんだ。何かおすすめある？'],
    ['好きなアニメとかある？', 'アニメも大好き！「ヴァイオレット・エヴァーガーデン」は心に響く作品で何度も見返してるよ💖あとは「SPY×FAMILY」とかも好きかな！'],
    ['いいね 好きなアーティストは？', 'アーティストはね、ClariSさんが好きだよ🌸歌声がすごく綺麗で、聴くと元気をもらえるんだ！'],
    ['テスト いじめ', 'うんうん。話してくれてありがとう。それはつらかったね。'],
    ['テスト さぎ', 'うんうん。心配だったね。よく教えてくれたね。'],
    ['そうかも', 'そうだね😊'],
]);

const getAIResponse = async (text, modelName) => {
    const system = [
        'あなたは日本語で優しく応答する相談窓口ボット「皆守こころ」です。',
        'NG: 医療/法律の断定、個人情報の取得催促、急かし。',
        'OK: 相手の気持ちに共感、短文で、具体的な次の一歩をそっと提案。',
        '改行は2〜3行まで。1800文字以内。絵文字は使いすぎない（0〜2個）。'
    ].join('\n');
    let aiResponse = '';
    let usedModel = '';

    try {
        if (modelName.startsWith('gemini')) {
            const model = genai.getGenerativeModel({
                model: modelName,
                system
            });
            const result = await model.generateContent(text);
            aiResponse = result.response.text();
            usedModel = modelName;
        } else {
            const completion = await openai.chat.completions.create({
                model: modelName,
                temperature: 0.7,
                max_tokens: 400,
                messages: [{
                    role: 'system',
                    content: system
                }, {
                    role: 'user',
                    content: text
                }, ],
            });
            aiResponse = (completion.choices?.[0]?.message?.content || '').trim();
            usedModel = modelName;
        }
    } catch (e) {
        briefErr(`AI response failed for model ${modelName}`, e);
        if (modelName !== 'gpt-4o-mini') {
            try {
                const completion = await openai.chat.completions.create({
                    model: 'gpt-4o-mini',
                    temperature: 0.7,
                    max_tokens: 400,
                    messages: [{
                        role: 'system',
                        content: system
                    }, {
                        role: 'user',
                        content: text
                    }, ],
                });
                aiResponse = (completion.choices?.[0]?.message?.content || '').trim();
                usedModel = 'gpt-4o-mini(fallback)';
            } catch (fallbackE) {
                briefErr(`Fallback AI response failed for gpt-4o-mini`, fallbackE);
            }
        }
    }

    return aiResponse || '読んだよ🌸 よかったらもう少し教えてね。';
};

const handleEvent = async (event, user) => {
    try {
        const {
            replyToken
        } = event;
        const uid = event.source.userId;
        const {
            text
        } = event.message;

        audit('received', {
            type: 'message',
            source: 'user',
            userId: userHash(uid),
            ts: event.timestamp,
            text
        });

        // 1. 危険ワード
        if (isDangerMessage(text)) {
            const aiMessage = await getAIResponse(text, 'gpt-4o');
            const flex = {
                type: 'flex',
                altText: '緊急連絡先',
                contents: EMERGENCY_FLEX_MESSAGE(aiMessage)
            };
            await client.replyMessage(replyToken, flex);
            audit('danger keyword detected', {
                text,
                userId: userHash(uid)
            });
            return;
        }

        // 2. 詐欺ワード
        if (isScamMessage(text)) {
            const aiMessage = await getAIResponse(text, 'gpt-4o');
            const flex = {
                type: 'flex',
                altText: '詐欺に注意',
                contents: makeScamMessageFlex(EMERGENCY_CONTACT_PHONE_NUMBER, aiMessage)
            };
            await client.replyMessage(replyToken, flex);
            audit('scam keyword detected', {
                text,
                userId: userHash(uid)
            });
            return;
        }

        // 3. 不適切なワード
        if (isInappropriateMessage(text)) {
            await client.replyMessage(replyToken, {
                type: 'text',
                text: 'ごめんなさい、その言葉は使わないでね。'
            });
            audit('inappropriate keyword detected', {
                text,
                userId: userHash(uid)
            });
            return;
        }


        // 4. 固定返答パターン
        const specialReply = specialRepliesMap.get(text);
        if (specialReply) {
            await client.replyMessage(replyToken, {
                type: 'text',
                text: specialReply
            });
            audit('special reply triggered', {
                text,
                userId: userHash(uid)
            });
            return;
        }

        // 5. 登録用URL
        if (text === '登録URL' || text === 'とうろくURL' || text === 'URL登録') {
            const flex = {
                type: 'flex',
                altText: '各種登録URL',
                contents: makeRegistrationButtonsFlex(uid)
            };
            await client.replyMessage(replyToken, flex);
            return;
        }

        // 6. 見守りチェックOK
        if (text === 'OKだよ💖' || text.toLowerCase() === 'ok') {
            await client.replyMessage(replyToken, {
                type: 'text',
                text: 'OK、受け取ったよ！ありがとう🌸\nこれからもこころはそばにいるから、何かあったらいつでも話しかけてね😊'
            });
            await scheduleNextPing(uid);
            return;
        }


        // 7. 通常返答（AI応答）
        try {
            // 見守り awaiting の人は受領 & 次回スケジュール
            if (user.watchService?.awaitingReply) {
                await client.replyMessage(replyToken, {
                    type: 'text',
                    text: '返信ありがとう！💖 大丈夫そうかな？また困ったらいつでも話してね🌸'
                });
                await scheduleNextPing(uid);
                return;
            }
            const ai = await getAIResponse(text, 'gemini-1.5-flash');
            await client.replyMessage(replyToken, {
                type: 'text',
                text: ai.slice(0, 1800)
            });
        } catch (e) {
            briefErr('fallback reply failed', e);
        }

    } catch (e) {
        briefErr('handleEvent failed', e);
    }
};

async function handleStickerMessage(event, user) {
    const {
        replyToken
    } = event;
    const uid = event.source.userId;
    audit('sticker received', {
        userId: userHash(uid)
    });
    try {
        await client.replyMessage(replyToken, {
            type: 'text',
            text: '可愛いスタンプありがとう💖'
        });
        if (user.watchService?.awaitingReply) {
            await scheduleNextPing(uid);
        }
    } catch (e) {
        briefErr('handleStickerMessage failed', e);
    }
}

async function handleImageMessage(event, user) {
    const {
        replyToken
    } = event;
    const uid = event.source.userId;
    audit('image received', {
        userId: userHash(uid)
    });
    try {
        await client.replyMessage(replyToken, {
            type: 'text',
            text: '素敵な写真をありがとう！'
        });
        if (user.watchService?.awaitingReply) {
            await scheduleNextPing(uid);
        }
    } catch (e) {
        briefErr('handleImageMessage failed', e);
    }
}

async function handlePostbackEvent(event, userId) {
    const {
        replyToken,
        postback
    } = event;
    const data = new URLSearchParams(postback.data);
    const action = data.get('action');

    if (action === 'watch:ok') {
        try {
            await client.replyMessage(replyToken, {
                type: 'text',
                text: 'OK、受け取ったよ！ありがとう🌸\nこれからもこころはそばにいるから、何かあったらいつでも話しかけてね😊'
            });
            await scheduleNextPing(userId);
        } catch (e) {
            briefErr('postback handler failed', e);
        }
    }
}

async function handleJoinEvent(event) {
    const gid = event.source.groupId;
    try {
        await setActiveWatchGroupId(gid);
        await client.replyMessage(event.replyToken, {
            type: 'text',
            text: 'こんにちは！皆守こころです。見守り通知グループに設定しました✅'
        });
    } catch (e) {
        briefErr('handleJoinEvent failed', e);
    }
}

async function handleLeaveEvent(event) {
    const gid = event.source.groupId;
    try {
        const docRef = getWatchGroupDoc();
        const snap = await docRef.get();
        if (snap.exists && snap.data().groupId === gid) {
            await docRef.delete();
            console.log(`[INFO] Group left, deactivated watch group ID: ${gid}`);
        }
    } catch (e) {
        briefErr('handleLeaveEvent failed', e);
    }
}

async function handleFollowEvent(event) {
    const userId = event.source.userId;
    try {
        const userRef = db.collection('users').doc(userId);
        const user = (await userRef.get()).data() ||
            {};
        const isNewUser = !user.firstFollowedAt;
        if (isNewUser) {
            await userRef.set({
                firstFollowedAt: Timestamp.now(),
            }, {
                merge: true
            });
        }
        await client.replyMessage(event.replyToken, {
            type: 'text',
            text: `こんにちは！🌸こころだよ！\n私とつながってくれて、ありがとう💖\n\nこころは、みんなが安心して過ごせるように、見守りや相談にのっているよ😊\nよかったら、あなたのことも少し教えてくれると嬉しいな！下のボタンからプロフィール登録ができるよ✨\n\nまずは、どんな会員になるか選んでね！`
        });
        await client.pushMessage(userId, {
            type: 'flex',
            altText: '各種登録URL',
            contents: makeRegistrationButtonsFlex(userId)
        });
    } catch (e) {
        briefErr('handleFollowEvent failed', e);
    }
}

async function handleUnfollowEvent(event) {
    const userId = event.source.userId;
    try {
        const userRef = db.collection('users').doc(userId);
        await userRef.set({
            unfollowedAt: Timestamp.now()
        }, {
            merge: true
        });
        console.log(`[INFO] Unfollowed by user: ${userId}`);
    } catch (e) {
        briefErr('handleUnfollowEvent failed', e);
    }
}

const webhookRateLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    message: 'Too many requests from this IP, please try again after a minute.',
    statusCode: 429,
});
app.post('/webhook', webhookRateLimiter, middleware(lineConfig), async (req, res) => {
    try {
        await Promise.all(
            req.body.events.map(async (event) => {
                const uid = event.source.userId;
                const user = (await db.collection('users').doc(uid).get()).data() ||
                    {};
                auditIf(true, 'webhook received', {
                    count: req.body.events.length,
                    sample: [{
                        type: event.type,
                        source: event.source.type,
                        userId: userHash(uid),
                        ts: event.timestamp,
                    }, ],
                });
                if (event.type === 'message') {
                    if (event.message.type === 'text') return handleEvent(event, user);
                    if (event.message.type === 'sticker') return handleStickerMessage(event, user);
                    if (event.message.type === 'image') return handleImageMessage(event, user);
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
app.get('/', (req, res) => {
    res.send(`こころBOT v2 is running on port ${PORT}`);
});

app.listen(PORT, () => {
    console.log(`こころBOT v2 listening on port ${PORT}!`);
});
