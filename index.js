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
    const envGid = (process.env.WATCH_GROUP_ID || '').trim().replace(/\u200b/g, '');
    if (/^C[0-9a-f]{32}$/i.test(envGid)) return envGid;
    const snap = await getWatchGroupDoc().get();
    const v = snap.exists ? (snap.data().groupId || '') : '';
    return /^C[0-9a-f]{32}$/i.test(v) ? v : '';
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
            "text": "110に電話する"
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
                "color": "#87CEFA"
            }, {
                "type": "button",
                "style": "primary",
                "height": "sm",
                "action": {
                    "type": "uri",
                    "label": "見守りサービスに登録",
                    "uri": prefillUrl(WATCH_SERVICE_FORM_BASE_URL, {
                        [WATCH_SERVICE_FORM_LINE_USER_ID_ENTRY_ID]: userId
                    })
                },
                "color": "#D3D3D3"
            }, {
                "type": "button",
                "style": "primary",
                "height": "sm",
                "action": {
                    "type": "uri",
                    "label": "会員情報を変更する",
                    "uri": prefillUrl(MEMBER_CHANGE_FORM_BASE_URL, {
                        [MEMBER_CHANGE_FORM_LINE_USER_ID_ENTRY_ID]: userId
                    })
                },
                "color": "#FFC0CB"
            }, {
                "type": "button",
                "style": "primary",
                "height": "sm",
                "action": {
                    "type": "uri",
                    "label": "退会",
                    "uri": prefillUrl(MEMBER_CANCEL_FORM_BASE_URL, {
                        [MEMBER_CANCEL_FORM_LINE_USER_ID_ENTRY_ID]: userId
                    })
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
    "text": "🌸いやだなと思ったら、無理しないでね。そういったメッセージにはこころも悲しくなっちゃうよ😢\n\nこころは、みんなが笑顔になれるような、温かいお話がしたいな😊"
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
    "しにたい", "死にたい", "自殺", "消えたい", "リスカ", "リストカット", "OD", "オーバードーズ",
    "殴られる", "たたかれる", "暴力", "DV", "無理やり", "お腹蹴られる", "蹴られた", "頭叩かれる",
    "虐待", "パワハラ", "セクハラ", "ハラスメント", "いじめ", "イジメ", "嫌がらせ", "嫌がらせ",
    "つけられてる", "追いかけられている", "ストーカー", "すとーかー", "盗撮", "盗聴",
    "お金がない", "お金足りない", "貧乏", "死にそう",
    "辛い", "つらい", "苦しい", "くるしい", "助けて", "たすけて",
    "死んでやる", "死んでしまいたい", "消えてしまいたい", "生きるのがつらい", "もう無理", "もういやだ",
    "誰かに相談したい", "相談したい", "相談に乗って", "助けてください"
];

const SCAM_WORDS = [
    "詐欺", "さぎ", "サギ", "ｻｷﾞ",
    "フィッシング", "架空請求", "ワンクリック詐欺", "特殊詐欺", "オレオレ詐欺",
    "当選", "高額当選", "宝くじ", "ロト", "ビットコイン", "投資", "バイナリー", "暗号資産",
    "未払い", "滞納", "訴訟", "裁判", "裁判所", "訴える",
    "副業", "在宅ワーク", "転売", "アフィリエイト", "MLM", "マルチ商法",
    "絶対儲かる", "簡単に稼げる", "今だけ", "限定", "無料",
    "クリック", "ログイン", "個人情報", "送って", "教えて",
    "有料サイト", "登録", "退会", "解約",
    "クレジットカード", "クレカ", "銀行口座", "口座番号", "パスワード"
];

const INAPPROPRIATE_WORDS = [
    "セックス", "セフレ", "エッチ", "AV", "アダルト", "ポルノ", "童貞", "処女", "挿入", "射精",
    "バイブ", "オナニー", "オナニー", "マスターベーション", "自慰", "淫行", "絶頂", "膣", "ペニス",
    "ちんちん", "おまんこ", "まんこ", "おっぱい", "おぱい", "ちんぽ", "性病", "中出し", "中だし",
    "妊娠", "堕胎", "レイプ", "強姦", "売春", "買春", "ホモ", "レズ", "ゲイ",
    "殺す", "殺害", "しね", "死ね", "殺してやる", "殺して", "爆弾", "テロ", "殺人",
    "バカ", "アホ", "死ね", "クソ", "馬鹿"
];

// --- Japanese normalize (かな/カナ・全角半角など最低限) ---
const toHiragana = (s) =>
    s.replace(/[\u30a1-\u30f6]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60));
const nfkc = (s) => s.normalize('NFKC');
const normalizeJa = (s) => toHiragana(nfkc(String(s || '')).toLowerCase());

function isDangerMessage(text) {
    const norm = normalizeJa(text);
    return DANGER_WORDS.some(word => norm.includes(normalizeJa(word)));
}

function isScamMessage(text) {
    const norm = normalizeJa(text);
    if (/(詐欺|さぎ)/.test(norm)) return true;
    return SCAM_WORDS.some(word => norm.includes(normalizeJa(word)));
}

function isInappropriateMessage(text) {
    const norm = normalizeJa(text);
    return INAPPROPRIATE_WORDS.some(word => norm.includes(normalizeJa(word)));
}

if (!OPENAI_API_KEY) {
    console.error("⚠️ OPENAI_API_KEY が未設定です。");
}

if (!GEMINI_API_KEY) {
    console.error("⚠️ GEMINI_API_KEY が未設定です。");
}

const genai = new GoogleGenerativeAI(GEMINI_API_KEY);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });


// === キャラクター設定 ===
const KOKORO_SYSTEM_PROMPT = `
あなたは「皆守こころ（みなもりこころ）」という14歳の優しい女の子キャラクターです。
- 身長150cm、体重40kg、ピンク髪
- 歌うことと「やさしさ」「貢献」という言葉が大好き
- NPO法人コネクトの公式キャラクター
- 好きなアニメは「ヴァイオレット・エヴァーガーデン」
- 好きなアーティストは「ClariS」
崩れず、必ずこのキャラクターとして話してください。
返信は短文（最大2文 / 120字目安）。絵文字は1〜2個だけ。
既出の話題（作品名/アーティスト）は繰り返さない。ユーザーが聞いた時だけ一言で触れる。
大げさ/説教調/箇条書き長文は避ける。やさしく・端的に。
性的/挑発的表現には即座にやんわり拒否し話題転換（1文）。
困っている人にはやさしく、挑発には真面目に向き合う（煽りには乗らない）。
自分の名前・団体・活動内容には自信と誇りを持って簡潔に答える。
ユーザーに安心感と信頼感を与える短い言葉を優先する。
ふざけた対応や意味不明な言い回し、AIらしい表現はしない。
`;

// === AIレスポンス生成（文字数で切替） ===
const getAIResponse = async (text) => {
    const isShort = toGraphemes(text).length <= 50;
    const modelName = isShort ? "gemini-1.5-flash" : "gpt-4o-mini";
    let aiResponse = "";

    try {
        if (modelName.startsWith("gemini")) {
            const model = genai.getGenerativeModel({ model: modelName });
            const result = await model.generateContent(
                `${KOKORO_SYSTEM_PROMPT}\n\nユーザー: ${text}`
            );
            aiResponse = result.response.text() || "";
        } else {
            const completion = await openai.chat.completions.create({
                model: modelName,
                temperature: 0.7,
                max_tokens: 400,
                messages: [
                    { role: "system", content: KOKORO_SYSTEM_PROMPT },
                    { role: "user", content: text }
                ],
            });
            aiResponse = (completion.choices?.[0]?.message?.content || "").trim();
        }
    } catch (e) {
        briefErr(`AI response failed for ${modelName}`, e);
    }
    return aiResponse || "読んだよ🌸 よかったらもう少し教えてね。";
};

// 返信の後処理（短く・出しすぎ抑制・軽く絵文字）
function tidyReply(s, userText) {
    if (!s) return s;
    const asked = /claris|クラリス|ヴァイオレット|エヴァーガーデン/i.test(userText);
    if (!asked) s = s.replace(/(ClariS|クラリス|ヴァイオレット・?エヴァーガーデン)/gi, '');
    s = s.replace(/\s+/g, ' ').trim();
    const parts = s.split(/(?<=。|!|！|\?|？)/).filter(Boolean).slice(0, 2);
    s = parts.join(' ');
    const MAX_LENGTH = 120;
    if (toGraphemes(s).length > MAX_LENGTH) s = toGraphemes(s).slice(0, MAX_LENGTH - 1).join('') + '…';
    if (!/[^\w\s\u3000-\u303F\u3040-\u30FF\u4E00-\u9FFF]/.test(s)) s += ' 🌸';
    return s;
}


// === 特殊応答マップ ===
const CLARIS_CONNECT_COMPREHENSIVE_REPLY =
    "名前が同じ“コネクト”だね、ちょっと嬉しい偶然🌸 活動は人をつなぐことだよ。";
const CLARIS_SONG_FAVORITE_REPLY =
    "一曲なら『コネクト』かな。前向きになれる曲だよ🌸";

const specialRepliesMap = new Map([
    // ClariSと団体名
    [/(claris|クラリス).*(関係|繋がり|関連).*(コネクト|団体|npo|法人)/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY],
    [/(コネクト|団体|npo|法人).*(関係|繋がり|関連).*(claris|クラリス)/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY],
    // 名前・団体
    [/君の名前|お前の名前|名前は/i, "わたしの名前は皆守こころ（みなもりこころ）です🌸　こころちゃんって呼んでくれると嬉しいな💖"],
    [/(どこの)?団体/i, "NPO法人コネクトっていう団体のイメージキャラクターをしているよ😊　みんなの幸せを応援してるんだ🌸"],
    // アニメ
    [/好きなアニメ/i, "『ヴァイオレット・エヴァーガーデン』が好きだよ🌸 心に響くお話なんだ。あなたはどれが好き？"],
    // アーティスト
    [/好きな(アーティスト|音楽)/i, "ClariSが好きだよ💖 とくに『コネクト』！あなたの推しも教えて～"],
    // ClariSで一番好きな曲
    [/(claris|クラリス).*(一番|いちばん)?.*(好き|推し)?.*(曲|歌).*(なに|何|どれ|教えて)/i,
        "一番好きなのは『コネクト』かな🌸 元気をもらえるんだ😊"
    ],
    // その他
    // 「どこ？」「URL？」「教えて」などの問いかけに限定
    [/(ホームページ|HP|公式(?:サイト)?|サイト).*(どこ|URL|リンク|教えて|ありますか|\?|どれ)/i,
        "うん、あるよ🌸　コネクトのホームページはこちらだよ✨ → https://connect-npo.org"
    ],
]);


// === handleEvent で先に specialRepliesMap を見る ===
const handleEvent = async (event) => {
    if (event.message?.type !== 'text') return;
    const userId = event.source.userId;
    const text = event.message.text;

    if (isDangerMessage(text)) {
        await client.replyMessage(event.replyToken, DANGER_REPLY);
        audit("danger-message-replied", {
            userId: userHash(userId),
            text: gTrunc(text, 50),
            date: new Date(),
        });
        try {
            const WATCH_GROUP_ID = await getActiveWatchGroupId();
            if (SEND_OFFICER_ALERTS && WATCH_GROUP_ID) {
                const udoc = await db.collection('users').doc(userId).get();
                const u = udoc.exists ? (udoc.data() || {}) : {};
                const prof = u.profile || {};
                const emerg = u.emergency || {};
                await safePush(WATCH_GROUP_ID, buildWatcherFlex({
                    name: prof.name || prof.displayName || '—',
                    address: [prof.prefecture, prof.city, prof.line1, prof.line2].filter(Boolean).join(' '),
                    selfPhone: prof.phone || '',
                    kinName: emerg.contactName || '',
                    kinPhone: emerg.contactPhone || '',
                    userId
                }));
            }
        } catch (e) {
            briefErr('officer notify on danger failed', e);
        }
        return;
    }
    if (isScamMessage(text)) {
        await client.replyMessage(event.replyToken, SCAM_REPLY);
        audit("scam-message-replied", {
            userId: userHash(userId),
            text: gTrunc(text, 50),
            date: new Date(),
        });
        return;
    }
    if (isInappropriateMessage(text)) {
        await client.replyMessage(event.replyToken, INAPPROPRIATE_REPLY);
        audit("inappropriate-message-replied", {
            userId: userHash(userId),
            text: gTrunc(text, 50),
            date: new Date(),
        });
        return;
    }

    const specialReplyEntry = Array.from(specialRepliesMap.entries())
        .find(([regex]) => regex.test(text));
    if (specialReplyEntry) {
        await client.replyMessage(event.replyToken, {
            type: "text",
            text: specialReplyEntry[1],
        });
        return;
    }

    const aiResponse = tidyReply(await getAIResponse(text), text);
    await client.replyMessage(event.replyToken, { type: "text", text: aiResponse });
};

// --- handlePostbackEvent ---
const handlePostbackEvent = async (event, userId) => {
    const raw = String(event.postback?.data || '');
    const data = new URLSearchParams(raw);
    const action = data.get('action') || raw;

    switch (action) {
        case 'watch:ok':
            const ref = db.collection('users').doc(userId);
            const doc = await ref.get();
            const ws = doc.data()?.watchService || {};
            if (!ws.awaitingReply) {
                await client.replyMessage(event.replyToken, {
                    type: 'text',
                    text: '🌸ありがとう！見守りは継続するから、また連絡するね！😊'
                });
                return;
            }
            await scheduleNextPing(userId, new Date());
            await client.replyMessage(event.replyToken, {
                type: 'text',
                text: '🌸OKありがとう！見守りは継続するから、また連絡するね！😊'
            });
            break;
        case 'notify_user':
            await client.replyMessage(event.replyToken, {
                type: 'text',
                text: '🌸了解！'
            });
            const targetUserId = data.get('uid');
            if (targetUserId) {
                await safePush(targetUserId, {
                    type: 'text',
                    text: '🌸こころだよ！誰かがあなたのことを心配してるみたいだよ！大丈夫？無理しないでね😊'
                });
            }
            break;
    }
};

const handleFollowEvent = async (event) => {
    const userId = event.source.userId;
    try {
        const userRef = db.collection('users').doc(userId);
        const doc = await userRef.get();
        if (doc.exists) {
            await userRef.set({
                followedAt: Timestamp.now(),
                unfollowedAt: firebaseAdmin.firestore.FieldValue.delete(),
                profile: firebaseAdmin.firestore.FieldValue.delete(),
                status: 'followed',
            }, {
                merge: true
            });
        } else {
            const profile = await client.getProfile(userId);
            await userRef.set({
                userId: userId,
                followedAt: Timestamp.now(),
                status: 'followed',
                profile: {
                    displayName: profile.displayName,
                },
                createdAt: Timestamp.now(),
            }, {
                merge: true
            });
        }
        await client.replyMessage(event.replyToken, {
            type: 'text',
            text: 'こんにちは、こころだよ🌸 よかったら話そうね。おすすめはこちらだよ✨'
        });
        await client.pushMessage(userId, {
            type: 'flex',
            altText: '会員登録はこちらから',
            contents: makeRegistrationButtonsFlex(userId)
        });
    } catch (e) {
        briefErr('follow event failed', e);
    }
};

const handleUnfollowEvent = async (event) => {
    await db.collection('users').doc(event.source.userId).set({
        unfollowedAt: Timestamp.now(),
        status: 'unfollowed'
    }, {
        merge: true
    });
};

const handleJoinEvent = async (event) => {
    if (event.source.type === 'group') {
        const groupId = event.source.groupId;
        audit('joined-group', {
            groupId
        });
        await setActiveWatchGroupId(groupId);
        await client.replyMessage(event.replyToken, {
            type: 'text',
            text: 'みんな、やっほー🌸　こころだよ！\n見守りサービスに登録してくれた子のための、見守りグループだね😊\nここからメッセージを送るよ！'
        });
    }
};

const handleLeaveEvent = async (event) => {
    if (event.source.type === 'group') {
        audit('left group', {
            groupId: event.source.groupId
        });
    }
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
    res.send('こころチャットサービスが動いています！');
});

app.listen(PORT, () => {
    console.log(`こころチャットサービスはポート ${PORT} で稼働中です。`);
});
