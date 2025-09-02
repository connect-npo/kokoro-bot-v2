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

['LINE_CHANNEL_ACCESS_TOKEN', 'LINE_CHANNEL_SECRET'].forEach(k => {
    if (!process.env[k] || !process.env[k].trim()) {
        console.error(`ENV ${k} が未設定です`);
        process.exit(1);
    }
});

const lineConfig = {
    channelAccessToken: (LINE_CHANNEL_ACCESS_TOKEN || '').trim(),
    channelSecret: (LINE_CHANNEL_SECRET || '').trim(),
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
const PORT = process.env.PORT || 3000;
const app = express();
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 2));
app.use(helmet());
const AUDIT_LEVEL = (process.env.AUDIT_LEVEL || 'info').toLowerCase();
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
const ALERT_COOLDOWN_MIN = Number(process.env.ALERT_COOLDOWN_MIN || 60);

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

async function sendWatcherAlert(uid) {
    const gid = (await getActiveWatchGroupId()) || (OFFICER_GROUP_ID || '').trim();
    if (!gid) {
        watchLog('[watch] No WATCH_GROUP_ID / officer group set. Skip alert.', 'error');
        return false;
    }
    const ref = db.collection('users').doc(uid);
    const snap = await ref.get();
    const u = snap.data() || {};
    const prof = u.profile || {};
    const emerg = u.emergency || {};

    const name = prof.name || '—';
    const address = [prof.prefecture, prof.city, prof.line1, prof.line2].filter(Boolean).join(' ');
    const selfPhone = prof.phone || '';
    const kinName = emerg.contactName || '';
    const kinPhone = emerg.contactPhone || '';

    await safePush(gid, buildWatcherFlex({ name, address, selfPhone, kinName, kinPhone, userId: uid }));
    await ref.set({ watchService: { lastNotifiedAt: Timestamp.now() } }, { merge: true });
    return true;
}

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
            type: "message",
            label: "警察 (110)",
            text: "110に電話する"
        }
    }, {
        type: "button",
        style: "primary",
        color: "#FFA500",
        action: {
            type: "message",
            label: "消費者ホットライン (188)",
            text: "188に電話する"
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
                "text": "怪しいお話には注意してね！不安な時は、信頼できる人に相談するか、こちらの情報も参考にして見てね💖",
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
                    "label": "学生（中学・高校・大学）",
                    "uri": prefillUrl(STUDENT_MIDDLE_HIGH_UNI_FORM_BASE_URL, {
                        [STUDENT_MIDDLE_HIGH_UNI_FORM_LINE_USER_ID_ENTRY_ID]: userId
                    })
                },
                "color": "#ADD8E6"
            }, {
                "type": "button",
                "style": "primary",
                "height": "sm",
                "action": {
                    "type": "uri",
                    "label": "大人（一般）",
                    "uri": prefillUrl(ADULT_FORM_BASE_URL, {
                        [ADULT_FORM_LINE_USER_ID_ENTRY_ID]: userId
                    })
                },
                "color": "#90EE90"
            }, {
                "type": "button",
                "style": "primary",
                "height": "sm",
                "action": {
                    "type": "uri",
                    "label": "見守りサービス会員",
                    "uri": prefillUrl(WATCH_SERVICE_FORM_BASE_URL, {
                        [WATCH_SERVICE_FORM_LINE_USER_ID_ENTRY_ID]: userId
                    })
                },
                "color": "#FFD700"
            }]
        }
    };
};
const DANGER_KEYWORDS = [
    '死にたい', '自殺', '消えたい', 'もう疲れた', '生きてる意味ない', 'つらい', 'しんどい', '辛い', 'しにたい', 'もうだめだ', 'もういやだ', 'もう無理', 'もう無理だ', '助けて', '誰も信じられない', '全部終わり', '死ぬ', '死んだほうがまし', '死に場所', 'もうどうでもいい', '死んでやる', 'もう生きていけない',
    'いじめ', 'いじめられ', '虐め', '虐められ',
];
const SCAM_KEYWORDS = [
    '副業', '在宅ワーク', '投資', '儲かる', '必ず稼げる', '月収', '簡単に稼げる', '高収入', 'FX', 'バイナリー', 'アフィリエイト', 'ネットワークビジネス', 'MLM', 'ワンクリック詐欺', '未払い', '訴訟', '請求', '借金', 'お金配り', '当選', '振込先', '送金', '受け取り口座', '手数料', '個人情報',
];
const INAPPROPRIATE_KEYWORDS = [
    'ばか', 'アホ', 'しね', '殺す', 'きもい', 'ブス', 'デブ', '死ね', '殴る', '暴力', 'エロ', '性的な', '裸', 'sex', 'ちんこ', 'まんこ', '射精', '膣', 'セックス', 'オナニー', 'レイプ', 'ポルノ', '自慰',
];
const DANGER_KEYWORDS_REGEX = new RegExp(DANGER_KEYWORDS.join('|'), 'i');
const SCAM_KEYWORDS_REGEX = new RegExp('(' + ['詐欺', 'さぎ', 'サギ'].join('|') + ')', 'i');
const INAPPROPRIATE_KEYWORDS_REGEX = new RegExp(INAPPROPRIATE_KEYWORDS.join('|'), 'i');

const isDangerMessage = (text) => DANGER_KEYWORDS_REGEX.test(text);
const isScamMessage = (text) => SCAM_KEYWORDS_REGEX.test(text);
const isInappropriateMessage = (text) => INAPPROPRIATE_KEYWORDS_REGEX.test(text);

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
    [/(?:好きな|推しの)?\s*アニメ(?:\s*は|って)?\s*(?:なに|何|どれ|好き|すき)?[！!。．、,\s]*[?？]?$/i, "『ヴァイオレット・エヴァーガーデン』が好きだよ🌸 心に響くお話なんだ。あなたはどれが好き？"],
    [/アニメ.*(おすすめ|教えて)[！!。．、,\s]*[?？]?$/i, "『ヴァイオレット・エヴァーガーデン』が好きだよ🌸 心に響くお話なんだ。あなたはどれが好き？"],
    [/アニメ.*(ある|あるの|ある？|あるの？|とかある|とかあるの|とかあるの？)/i, "『ヴァイオレット・エヴァーガーデン』が好きだよ🌸 心に響くお話なんだ。あなたはどれが好き？"],
    [/(好きな|推しの)?(漫画|マンガ|まんが)(は|なに|何|ある)?[？?]?/i, "私は色々な作品が好きだよ！🌸 物語に触れると、人の心の温かさや強さを感じることができて、とても勉強になるんだ😊 あなたのおすすめの漫画はどんなものがある？"],
    // --- 好きなアーティスト/音楽（「とかいない？」なども拾う）---
    [/(好きな|推し|おすすめ)\s*アーティスト(は|いる)?/i, "ClariSが好きだよ💖 とくに『コネクト』！あなたの推しも教えて～"],
    [/(好きな|推し|おすすめ)\s*音楽(は|ある)?/i, "ClariSが好きだよ💖 とくに『コネクト』！あなたの推しも教えて～"],
    // --- 「ClariSで一番好きな曲は？」系 ---
    [/(claris|クラリス).*(一番|いちばん)?[^。！？\n]*?(好き|推し)?[^。！？\n]*?(曲|歌)[^。！？\n]*?(なに|何|どれ|教えて|どの)[？?]?/i, "一番好きなのは『コネクト』かな🌸 元気をもらえるんだ😊"],
    // --- 既存の好みショートカット（残す）---
    [/(claris|クラリス).*(どんな|なに|何).*(曲|歌)/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY],
    [/(claris|クラリス).*(好き|推し|おすすめ)/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY],
    [/claris.*好きなの/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY],
    [/(claris|クラリス).*(じゃない|じゃなかった|違う|ちがう)/i, "ううん、ClariSが好きだよ💖 とくに『コネクト』！"],
    // --- その他（元の定義は必要に応じて残す）---
    [/(ホームページ|HP|ＨＰ|サイト|公式|リンク).*(教えて|ある|ありますか|URL|url|アドレス|どこ)/i, "うん、あるよ！\nNPO法人コネクトのホームページはこちらだよ🌸\n[https://connect-npo.or.jp/](https://connect-npo.or.jp/)\n良かったら見てみてね😊"],
    [/(自己紹介|じこしょうかい|自己紹介して)[！!。．、,\s]*[?？]?/i, "私の名前は皆守こころ（みなもりこころ）🌸\nNPO法人コネクトのイメージキャラクターをしているよ😊\nみんなの心を繋げて、幸せを応援する活動をしているんだ💖\n好きなものは、甘いものとClariSさんの曲だよ！\nよろしくね😊"],
    [/(出身地|地元|どこ出身|出身)[！!。．、,\s]*[?？]?/i, "私はみんなの心の中にいるよ💖　出身地はないけど、みんなと繋がるのが大好きだよ！😊"],
    [/(年齢|歳)[！!。．、,\s]*[?？]?/i, "私は歳を取らないよ😊　永遠にみんなの味方だよ！💖"],
    [/(性別|男|女)[！!。．、,\s]*[?？]?/i, "性別はないんだ🌸　みんなの心を応援する存在だよ😊"],
    [/(彼氏|彼女|好きな人|恋人|彼氏いる|彼女いる|好きな人いる)[！!。．、,\s]*[?？]?/i, "私には好きな人はいないんだ😊　でも、みんなのことが大好きだよ！💖"],
    [/(趣味|特技)[！!。．、,\s]*[?？]?/i, "趣味は、みんなのお話を聞くことと、色々なことを調べることかな😊　特技は、みんなの心を明るくすることだよ💖"],
    [/(おやすみ|おやすみなさい|寝るね)[！!。．、,\s]*[?？]?/i, "おやすみ～🌙　ゆっくり休んでね🌸\n良い夢が見られますように💖"],
    [/(おはよう|おはよ)[！!。．、,\s]*[?？]?/i, "おはようございます😊　今日も一日、一緒に頑張ろうね🌸"],
    [/ありがとう[！!。．、,\s]*[?？]?|感謝|感謝します/i, "どういたしまして😊　あなたが喜んでくれて嬉しいな💖"],
    [/ごめん|ごめんなさい|すまない|すみません/i, "大丈夫だよ😊　気にしないでね💖"],
    [/こんにちは|こんにちわ|こんちは/i, "こんにちは🌸\n何かお話ししたいこと、ある？😊"],
    [/こんばんは|こんばんわ/i, "こんばんは🌙\n一日お疲れ様！\nゆっくり休んでね😊"],
    [/さようなら|またね|ばいばい|バイバイ/i, "ばいばい～😊　またいつでも話しかけてね🌸"],
    [/(^|\s)うん($|\s)/i, "うんうん😊　それで？"],
    [/疲れた|つかれた|つらたん|しんどい|病んだ/i, "大丈夫だよ、無理しないでね😊\n辛い気持ち、聞かせてくれてありがとう。\n話すだけでも少し楽になることもあるから、よかったらいつでも聞かせてね🌸"],
    [/元気?(\s*ですか)?[！!。．、,\s]*[?？]?/i, "元気だよ😊\nあなたは元気かな？💖"],
    [/寂しい|さみしい|ひとり|独り|一人/i, "一人じゃないよ🌸\n私がそばにいるから大丈夫💖\nいつでも話しかけてね😊"],
    [/暇|ひま/i, "ひまなんだね😊\n何して遊ぶ？\n面白い話とか、何か聞きたいことある？"],
    [/ねぇねぇ|ねえねえ/i, "なぁに？🌸\nどうしたの？😊"],
]);
const DANGER_REPLY_MESSAGE = {
    type: 'flex',
    altText: '緊急連絡先情報',
    contents: EMERGENCY_FLEX_MESSAGE
};
const SCAM_REPLY_MESSAGE = {
    type: 'flex',
    altText: '詐欺情報',
    contents: makeScamMessageFlex(EMERGENCY_CONTACT_PHONE_NUMBER)
};
const REGISTER_REPLY_MESSAGE = (userId) => ({
    type: 'flex',
    altText: 'こころちゃんの会員登録のご案内',
    contents: makeRegistrationButtonsFlex(userId)
});
const UNAPPROPRIATE_REPLY_MESSAGE = {
    type: 'text',
    text: 'ごめんね、その言葉はちょっと苦手だな💦\nでも、あなたのことを見守る気持ちは変わらないから、よかったら他の言葉でお話してね💖'
};

const MAX_MESSAGE_HISTORY = 10;
const PUSH_MESSAGE_REPLY_WAIT = 1000;
const PUSH_MESSAGE_REPLY_INTERVAL = 500;
const MESSAGES_TO_FETCH = 20;

function hasWatched(user) {
    return user.watchService?.enabled === true && user.watchService?.awaitingReply === true;
}

const handleTextMessage = async (event, user) => {
    const {
        replyToken,
        source
    } = event;
    const uid = source.userId;
    const text = event.message.text;

    // 1. 危険ワード検知 (自殺・虐待など)
    if (isDangerMessage(text)) {
        audit('Danger keyword detected', {
            text: sanitizeForLog(text),
            userId: userHash(uid)
        });
        await client.replyMessage(replyToken, [DANGER_REPLY_MESSAGE, {
            type: 'text',
            text: '大丈夫だよ、ひとりじゃないからね🌸 辛い時は、いつでも話してね。'
        }, ]);
        // 直近通知からのクールダウンを見て、管理グループへ即時通報
        try {
            const doc = await db.collection('users').doc(uid).get();
            const last = doc.data()?.watchService?.lastNotifiedAt?.toDate?.();
            const mins = last ? (Date.now() - last.getTime()) / 60000 : Infinity;
            if (mins >= ALERT_COOLDOWN_MIN) await sendWatcherAlert(uid);
        } catch (_) {}
        return;
    }

    // 2. 詐欺ワード検知
    if (isScamMessage(text)) {
        audit('Scam keyword detected', {
            text: sanitizeForLog(text),
            userId: userHash(uid)
        });
        await client.replyMessage(replyToken, [SCAM_REPLY_MESSAGE, {
            type: 'text',
            text: '怪しいなと思ったら、すぐに誰かに相談してね！もしよかったら、私にも聞かせてね🌸'
        }, ]);
        return;
    }

    // 3. 不適切ワード検知
    if (isInappropriateMessage(text)) {
        audit('Inappropriate keyword detected', {
            text: sanitizeForLog(text),
            userId: userHash(uid)
        });
        await client.replyMessage(replyToken, UNAPPROPRIATE_REPLY_MESSAGE);
        return;
    }

    // 4. 固定リプ
    for (const [pattern, reply] of specialRepliesMap) {
        if (pattern.test(text)) {
            audit('Special reply triggered', {
                text: sanitizeForLog(text),
                userId: userHash(uid)
            });
            const messages = Array.isArray(reply) ? reply : [{
                type: 'text',
                text: reply
            }];
            await client.replyMessage(replyToken, messages);
            return;
        }
    }

    // 5. 登録案内
    if (text.trim() === '登録') {
        await client.replyMessage(replyToken, [REGISTER_REPLY_MESSAGE(uid), {
            type: 'text',
            text: 'ご登録で使える機能が増えるよ🌸\nこのままでも、もちろんお話しできるから安心してお話してね💖'
        }]);
        return;
    }

    // 6. 見守りサービス中 (応答を受理)
    if (hasWatched(user)) {
        await client.replyMessage(replyToken, {
            type: 'text',
            text: '返信ありがとう！💖大丈夫そうかな？また困ったらいつでも話してね🌸'
        });
        await scheduleNextPing(uid);
        return;
    }

    // 7. 通常返答（AI応答）
    // TODO: AI呼び出しロジックに差し替える
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

        // 通常フォールバック（まずは固定文でOK。後でAI応答に差し替え）
        await client.replyMessage(replyToken, {
            type: 'text',
            text: 'こころだよ🌸 メッセージ読んだよ！よかったら、もう少しお話聞かせてね😊'
        });
    } catch (e) {
        briefErr('fallback reply failed', e);
    }
};

const handleStickerMessage = async (event, user) => {
    const {
        replyToken,
        source
    } = event;
    const uid = source.userId;

    if (hasWatched(user)) {
        await client.replyMessage(replyToken, {
            type: 'text',
            text: 'スタンプありがとう！💖 大丈夫そうかな？また困ったらいつでも話してね🌸'
        });
        await scheduleNextPing(uid);
        return;
    }
    const fixedReply = "かわいいスタンプありがとう🌸 どんなスタンプも大歓迎だよ😊";
    await client.replyMessage(replyToken, {
        type: 'text',
        text: fixedReply
    });
};

const handleImageMessage = async (event, user) => {
    const {
        replyToken
    } = event;
    const fixedReply = "素敵な画像をありがとう🌸 見守りサービスのご利用についてのご連絡でなければ、画像には返信できないんだ…ごめんね💦";
    await client.replyMessage(replyToken, {
        type: 'text',
        text: fixedReply
    });
};

const handlePostbackEvent = async (event, uid) => {
    const {
        replyToken,
        data,
        params,
        source
    } = event;
    const parts = data.split(':');
    const action = parts[0];

    audit('Postback received', {
        action,
        userId: userHash(uid)
    });

    if (action === 'watch') {
        const command = parts[1];
        if (command === 'ok') {
            await scheduleNextPing(uid);
            await client.replyMessage(replyToken, {
                type: 'text',
                text: "OKありがとう！💖 返信をもらえて嬉しいな😊"
            });
        }
    } else if (action === 'notify_user') {
        const encodedUid = (new URLSearchParams(data)).get('uid');
        if (!encodedUid) return;
        const targetUid = decodeURIComponent(encodedUid);
        if (targetUid === 'U00000000000000000000000000000000') return;

        const target = await client.getProfile(targetUid).catch(() => null);
        if (!target) {
            await client.replyMessage(replyToken, {
                type: 'text',
                text: '対象のユーザーが見つかりません'
            });
            return;
        }

        await safePush(targetUid, {
            type: 'text',
            text: 'こころちゃんの事務局です。ご返信が途絶えているため、念のためご連絡しました。ご心配であれば、こちらに返信いただくか、LINE通話でご相談ください。'
        });
        await safePush(source.groupId || source.userId, {
            type: 'text',
            text: `${target.displayName}さんにメッセージを送信しました。`
        });
    }
};

const handleFollowEvent = async (event) => {
    const {
        replyToken,
        source
    } = event;
    const uid = source.userId;
    audit('Follow event', {
        userId: userHash(uid)
    });
    try {
        const userRef = db.collection('users').doc(uid);
        const doc = await userRef.get();
        if (doc.exists) {
            await userRef.update({
                followedAt: Timestamp.now(),
                unfollowedAt: firebaseAdmin.firestore.FieldValue.delete(),
                displayName: (await client.getProfile(uid)).displayName,
            });
        } else {
            await userRef.set({
                uid,
                followedAt: Timestamp.now(),
                displayName: (await client.getProfile(uid)).displayName,
                watchService: {
                    enabled: false
                }
            });
        }

        const initialReply = {
            "type": "bubble",
            "body": {
                "type": "box",
                "layout": "vertical",
                "contents": [{
                    "type": "text",
                    "text": "はじめまして！\nみんなの心を応援する、皆守こころ（みなもりこころ）だよ🌸\n\nここはお話や悩みを安心して話せる場所。\nあなたの心の味方として、いつでもそばにいるから安心してね😊",
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
                    "action": {
                        "type": "message",
                        "label": "お話したい！",
                        "text": "こんにちは"
                    }
                }, {
                    "type": "button",
                    "style": "secondary",
                    "action": {
                        "type": "message",
                        "label": "登録について知りたい",
                        "text": "登録"
                    }
                }]
            }
        };

        const registrationReply = {
            type: 'flex',
            altText: 'こころちゃんの会員登録のご案内',
            contents: makeRegistrationButtonsFlex(uid)
        };

        await client.replyMessage(replyToken, [{
            type: 'flex',
            altText: 'はじめまして',
            contents: initialReply
        }, registrationReply]);

    } catch (e) {
        briefErr('Follow event failed', e);
    }
};

const handleUnfollowEvent = async (event) => {
    const uid = event.source.userId;
    audit('Unfollow event', {
        userId: userHash(uid)
    });
    try {
        await db.collection('users').doc(uid).update({
            unfollowedAt: Timestamp.now()
        });
    } catch (e) {
        briefErr('Unfollow event failed', e);
    }
};

const handleJoinEvent = async (event) => {
    const {
        replyToken,
        source
    } = event;
    if (source.type === 'group') {
        if (!OFFICER_GROUP_ID || source.groupId === OFFICER_GROUP_ID) {
            await setActiveWatchGroupId(source.groupId);
            await client.replyMessage(replyToken, {
                type: 'text',
                text: '見守り通知グループに設定しました✅'
            });
            audit('Joined officer group', {
                groupId: source.groupId
            });
        } else {
            await client.replyMessage(replyToken, {
                type: 'text',
                text: "グループに招待してくれてありがとう！😊\nごめんなさい、このアカウントは１対１のトーク専用だから、個別で話しかけてくれると嬉しいな💖"
            });
            audit('Joined other group', {
                groupId: source.groupId
            });
        }
    } else {
        // room など他種別はそのまま
    }
};

const handleLeaveEvent = async (event) => {
    const {
        source
    } = event;
    audit('Left group/room', {
        id: source.groupId || source.roomId
    });
};

app.get('/', (req, res) => {
    res.send('こころちゃんBOT稼働中🌸');
});

app.post('/webhook', middleware(lineConfig), async (req, res) => {
    const events = req.body.events;
    // 監査ログを絞る
    audit('Webhook received', {
        count: events?.length || 0,
        sample: events?.slice(0, 1)?.map(e => ({
            type: e.type,
            source: e.source?.type,
            userId: e.source?.userId && e.source.userId.slice(0, 6) + '…',
            ts: e.timestamp
        }))
    });
    res.status(200).end();

    try {
        await Promise.all(
            events.map(async (event) => {
                if (!event.source.userId) return;
                const uid = event.source.userId;
                const userRef = db.collection('users').doc(uid);
                const userDoc = await userRef.get();
                const user = userDoc.data() || {};

                // TODO: 最終アクセス時刻を更新
                await userRef.set({
                    lastAccessedAt: Timestamp.now()
                }, {
                    merge: true
                });

                if (event.type === 'message') {
                    if (event.message.type === 'text') return handleTextMessage(event, user);
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

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server is running on port ${PORT}`);
});
