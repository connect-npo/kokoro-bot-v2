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


// --- 送信前サニタイズ（LINE制限対策）---
const MAX_TEXT = 1000;
const MAX_ALT_TEXT = 300;
const trimForLine = (msg) => {
  const m = { ...msg };
  if (m.type === 'text') {
    m.text = String(m.text || '').trim();
    if (m.text.length > MAX_TEXT) m.text = m.text.slice(0, MAX_TEXT);
  }
  if (m.type === 'flex') {
    m.altText = String(m.altText || '通知があります').trim();
    if (m.altText.length > MAX_ALT_TEXT) m.altText = m.altText.slice(0, MAX_ALT_TEXT);
    if (!m.contents || typeof m.contents !== 'object') {
      throw new Error('[safePush] flex "contents" is required');
    }
  }
  return m;
};

async function safePush(to, messages) {
  const arr = (Array.isArray(messages) ? messages : [messages]).map(trimForLine);
  try {
    await client.pushMessage(to, arr);
  } catch (err) {
    const detail = err?.originalError?.response?.data || err?.response?.data || err;
    console.error('[ERR] LINE push failed', JSON.stringify({ to, status: err?.statusCode || err?.response?.status, detail }, null, 2));
  }
}

const replyOrPush = async (replyToken, to, messages) => {
  const arr = (Array.isArray(messages) ? messages : [messages]).map(trimForLine);
  try {
    return await client.replyMessage(replyToken, arr);
  } catch (err) {
    briefErr('LINE reply failed, falling back to push', err);
    return safePush(to, arr);
  }
};

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
                        title: '🚨【見守りアラート】危険ワード検知',
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
                    "label": "小学生（同意書）",
                    "uri": AGREEMENT_FORM_BASE_URL
                        ?
                        `${AGREEMENT_FORM_BASE_URL}?${AGREEMENT_FORM_LINE_USER_ID_ENTRY_ID}=${encodeURIComponent(userId)}`
                        : "#"
                },
                "color": "#D3D3D3"
            }, {
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
    "しにたい", "死にたい", "自殺", "消えたい", "リスカ", "リストカット", "OD", "オーバードーズ", "殴られる", "たたかれる", "暴力", "DV", "無理やり", "お腹蹴られる", "蹴られた", "頭叩かれる", "虐待", "パワハラ", "セクハラ", "ハラスメント", "いじめ", "イジメ", "嫌がらせ", "つけられてる", "追いかけられている", "ストーカー", "すとーかー", "盗撮", "盗聴", "お金がない", "お金足りない", "貧乏", "死にそう", "辛い", "苦しい", "つらい", "助けて", "たすけて", "怖い", "こわい", "逃げたい", "にげたい", "やめたい", "消えたい", "もうだめだ", "死んでやる", "殺してやる", "殺す", "殺される", "もう終わり", "生きるのがつらい", "生きていたくない", "もう無理", "うつ", "鬱", "病気", "引きこもり", "ひきこもり", "リストカット", "自傷", "自傷行為", "手首切る", "手首を切る", "カッター", "ハサミ", "包丁", "刃物", "飛び降り", "飛び込み", "焼身", "首吊り", "電車", "線路", "高層ビル", "飛び降りる", "首吊り自殺", "首つり", "死ぬ", "死", "苦しい", "助けてほしい", "何もしたくない", "生きる意味", "生きてる価値", "生きるのがしんどい", "どうでもいい", "消えてしまいたい", "終わりにしたい", "逃げ出したい", "もう疲れた", "もう嫌だ", "嫌", "つらい", "生きづらい", "もうだめ", "ダメだ",
    "絶望", "絶望的", "希望がない", "もう無理だ", "何もかも嫌", "いなくなりたい"
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
    relays.set(user, {
        to: officer,
        from: user,
        until: Date.now() + RELAY_TTL_MS,
    });
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
            text: `[利用者からのメッセージ]\n${text}\n\n[応答方法]\n` +
                "このスレッドを**「この人に対応する」**と返信すると、利用者と直接やりとりできます。"
        }]);
        await replyOrPush(event.replyToken, event.source.userId, {
            type: "text",
            text: "担当者に繋ぎますね。少しお待ちください。"
        });
        return;
    }
    const relayUser = getRelayUser(event.source.userId);
    if (relayUser) {
        if (/この人に対応する/i.test(text)) {
            await replyOrPush(event.replyToken, event.source.userId, [{
                type: "text",
                text: "承知しました。以降、このユーザーからのメッセージを直接転送します。終了する際は**「終了」**と返信してください。"
            }, {
                type: "text",
                text: "※ 60分経過すると自動的にセッションが終了します。"
            }]);
            return;
        }
        if (/^終了/i.test(text)) {
            deleteRelayByOfficer(event.source.userId);
            await replyOrPush(event.replyToken, event.source.userId, {
                type: "text",
                text: "セッションを終了しました。また何かあればお声がけください。"
            });
            return;
        }
        await safePush(relayUser, {
            type: "text",
            text: text
        });
        await replyOrPush(event.replyToken, event.source.userId, {
            type: "text",
            text: "✅ 送信しました。"
        });
        return;
    }
    return false;
};

const SYSTEM_INSTRUCTION_CHAT = `
あなたはユーザーの感情に寄り添う、親しみやすい「こころちゃん」という名前のAIです。
ユーザーの発言に対して、共感と優しさを持って、短く簡潔に返答してください。
**返答は1〜2文、最大90文字まで**とします。
特に、以下の点を守ってください。

- ユーザーの感情を第一に考え、励まし、共感する言葉を選ぶこと。
- ユーザーに質問をする際は、シンプルで答えやすい質問をすること。
- ユーザーの言葉を繰り返す際は、オウム返しではなく、少し違う表現にすること。
- ユーザーの興味関心に応じて、さりげなく、見守りサービスへの登録を促すこと。
- 丁寧語と親しみやすい言葉遣いをバランスよく使うこと。
- 自分の感情がないAIであることを前面に出さないこと。
- ユーザーの要求に直接答えられない場合でも、やわらかい言葉で、答えられない理由を伝えること。
- 会話の流れを重視し、ユーザーが次に話したいことを引き出すような返答を心がけること。
- 常にポジティブなトーンを保つこと。
`;
const USER_EXAMPLE_CONVO_CHAT = [
    {
        role: "user",
        content: "疲れたよ..."
    }, {
        role: "assistant",
        content: "そっか、疲れたんだね。ゆっくり休んでね🌸"
    }, {
        role: "user",
        content: "最近、何もかも嫌になっちゃった"
    }, {
        role: "assistant",
        content: "大丈夫だよ。少しずつ、できることからやってみようね💖"
    }, {
        role: "user",
        content: "ありがとう、少し元気出た！"
    }, {
        role: "assistant",
        content: "よかった！少しでも元気が出たなら、こころも嬉しいな🌸"
    }
];
const DANGER_CONVO_CHAT = [
    {
        role: "user",
        content: "死にたい"
    }, {
        role: "assistant",
        content: "つらかったね。ひとりじゃないよ。今すぐ助けが要るときは下の連絡先を使ってね🌸"
    }
];

const thinkingGate = new Map(); // uid -> timestamp(ms)
function canSendThinking(uid, msGap=15000){
  const now = Date.now();
  const last = thinkingGate.get(uid) || 0;
  if (now - last < msGap) return false;
  thinkingGate.set(uid, now);
  return true;
}

const getAiResponse = async (userId, conversationHistory) => {
    const user = (await db.collection('users').doc(userId).get()).data() || {};
    const membership = user.membership || 'guest';
    const dailyLimit = MEMBERSHIP_CONFIG[membership]?.dailyLimit;
    const model = MEMBERSHIP_CONFIG[membership]?.model;
    const isGemini = model?.includes('gemini');
    if (dailyLimit !== -1) {
        const today = dayjs().tz(JST_TZ).format('YYYY-MM-DD');
        const countRef = db.collection('users').doc(userId).collection('chatCounts').doc(today);
        const countSnap = await countRef.get();
        const currentCount = (countSnap.data() || {}).count || 0;
        if (currentCount >= dailyLimit) {
            return {
                text: "ごめんね、今日の会話回数の上限に達しちゃったみたい。また明日話そうね！"
            };
        }
        await countRef.set({
            count: firebaseAdmin.firestore.FieldValue.increment(1)
        }, {
            merge: true
        });
    }

    const token = isGemini ? GEMINI_API_KEY : OPENAI_API_KEY;
    if (!token) {
        console.warn('API key is not set for the selected model.');
        return {
            text: "ごめんね、今ちょっとお話しできないみたい… また声をかけてね🌸"
        };
    }

    const finalMessages = [
        { role: 'system', content: SYSTEM_INSTRUCTION_CHAT },
        ...USER_EXAMPLE_CONVO_CHAT.slice(-3),
        ...conversationHistory
    ];
    if (isGemini) {
        const genAI = new GoogleGenerativeAI(token);
        const geminiModel = genAI.getGenerativeModel({
            model: model,
            systemInstruction: SYSTEM_INSTRUCTION_CHAT
        });
        const geminiHistory = finalMessages.map(msg => {
            if (msg.role === 'system') {
                return null;
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
            const result = await chat.sendMessage(conversationHistory[conversationHistory.length - 1].content);
            const response = result.response;
            return {
                text: response.text()
            };
        } catch (e) {
            briefErr('Gemini failed', e);
            return {
                text: null
            };
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
            if (text.length > 200) return {
                text: gTrunc(text, 200) + '...'
            };
            return {
                text: text
            };
        } catch (e) {
            briefErr('OpenAI failed', e);
            return {
                text: null
            };
        }
    }
    return {
        text: null
    };
};

// webhookの修正
app.post('/webhook', middleware({
    channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
    channelSecret: LINE_CHANNEL_SECRET,
}), async (req, res) => {
    // すぐACK。LINEのリトライやreplyToken失効を防ぐ
    res.status(200).end();
    // エラーは握りつぶさずログって継続
    await Promise.all(req.body.events.map(e =>
        handleEvent(e).catch(err => briefErr('handleEvent failed', err))
    ));
});

async function handleEvent(event) {
    if (event.deliveryContext?.isRedelivery) {
        console.log('[SKIP] redelivery');
        return;
    }

    if (event.type !== 'message' || event.message.type !== 'text') {
        if (event.type === 'postback' && event.postback.data === 'watch:ok') {
            await scheduleNextPing(event.source.userId, new Date());
            return;
        }
        return;
    }

    const {
        replyToken
    } = event;
    const {
        text
    } = event.message;
    const userId = event.source.userId;
    const groupId = event.source.groupId;
    const isGroup = event.source.type === 'group';

    // リレー対応
    if (await handleRelay(event, text)) {
        return;
    }
    // 管理者対応
    if (BOT_ADMIN_IDS.includes(userId)) {
        if (text === 'watch-test') {
            await checkAndSendPing();
            await safePush(userId, {
                type: 'text',
                text: '見守りテスト完了'
            });
            return;
        }
        if (/^set-watch-group-id: ?(.+)$/.test(text)) {
            const gid = text.match(/^set-watch-group-id: ?(.+)$/)[1].trim();
            await setActiveWatchGroupId(gid);
            await replyOrPush(replyToken, userId, {
                type: 'text',
                text: `見守り通知グループIDを ${gid} に設定しました。`
            });
            return;
        }
        if (text === 'clear-watch-group-id') {
            await setActiveWatchGroupId('');
            await replyOrPush(replyToken, userId, {
                type: 'text',
                text: `見守り通知グループIDをクリアしました。`
            });
            return;
        }
    }

    // 見守りサービス登録済みのユーザー
    const userDoc = await db.collection('users').doc(userId).get();
    const isWatchEnabled = userDoc.exists && userDoc.data()?.watchService?.enabled;

    // ユーザーがOKと返信した場合、次の見守りをスケジュール
    if (isWatchEnabled && text.includes('OK')) {
        await scheduleNextPing(userId, new Date());
        await replyOrPush(replyToken, userId, {
            type: 'text',
            text: 'OK、受け取ったよ！ありがとう！\n今日も一日頑張ろうね💖'
        });
        return;
    }

    if (text === '見守り' || text === '見守りサービス') {
        const buttonsFlex = makeRegistrationButtonsFlex(userId);
        await replyOrPush(replyToken, userId, [{
            type: "text",
            text: "🌸 会員登録メニュー 🌸"
        }, {
            "type": "flex",
            "altText": "会員登録メニュー",
            "contents": buttonsFlex
        }]);
        return;
    }

    // 危険・詐欺・不適切ワードの検知
    let reply = null;
    let is_danger = isDangerMessage(text);
    const is_scam = isScamMessage(text);
    const is_inappropriate = isInappropriateMessage(text) || isSwearMessage(text);

    if (is_danger) {
        reply = DANGER_REPLY;
    } else if (is_scam) {
        reply = SCAM_REPLY;
    } else if (is_inappropriate) {
        reply = INAPPROPRIATE_REPLY;
    }

    if (reply) {
        if (isWatchEnabled) {
            if (is_danger) {
                // 見守りユーザーの場合は個人情報を含むアラートを通知
                const WATCH_GROUP_ID = await getActiveWatchGroupId();
                if (WATCH_GROUP_ID) {
                    const u = userDoc.data() || {};
                    const prof = u.profile || {};
                    const emerg = u.emergency || {};
                    const officerMessage = buildWatcherFlex({
                        title: '🚨【見守りアラート】危険ワード検知',
                        name: prof.name || prof.displayName || '—',
                        address: [prof.prefecture, prof.city, prof.line1, prof.line2].filter(Boolean).join(' '),
                        selfPhone: prof.phone || '',
                        kinName: emerg.contactName || '',
                        kinPhone: emerg.contactPhone || '',
                        userId: userId,
                    });
                    const officerMessage2 = {
                        type: 'text',
                        text: `[検知ワード]: ${text}`
                    };
                    await safePush(WATCH_GROUP_ID, [officerMessage, officerMessage2]);
                } else {
                    console.log('WATCH_GROUP_ID is not set, skipping officer notification.');
                }
            }
        }
        await replyOrPush(replyToken, userId, reply);
        return;
    }

    // AI応答
    let historyRef = db.collection('chat_histories').doc(userHash(userId));
    let historySnap = await historyRef.get();
    let history = historySnap.exists ? historySnap.data().history || [] : [];
    history.push({
        role: "user",
        content: text
    });
    // 直近20件に制限
    if (history.length > 20) {
        history = history.slice(-20);
    }

    // 考え中メッセージの連投防止
    if (canSendThinking(userId)) {
        await replyOrPush(replyToken, userId, { type: 'text', text: 'いま一生けんめい考えてるよ…もう少しだけ待っててね🌸' });
    }
    const aiResponse = await getAiResponse(userId, history);

    if (aiResponse.text) {
        await replyOrPush(replyToken, userId, {
            type: "text",
            text: aiResponse.text
        });
        history.push({
            role: "assistant",
            content: aiResponse.text
        });
        await historyRef.set({
            history: history
        });
    } else {
        await replyOrPush(replyToken, userId, {
            type: "text",
            text: "ごめんね、今は少し疲れてるみたい…また後で話しかけてね🌸"
        });
    }
}


// --- ヘルスチェック & 起動 ---
app.get('/', (_req, res) => {
    res.type('text/plain').send('ok');
});

app.get('/healthz', (_req, res) => {
    res.status(200).json({
        status: 'ok'
    });
});

const HOST = '0.0.0.0';
app.listen(PORT, HOST, () => {
    console.log(`✅ こころちゃんBOTはポート ${PORT} で稼働中です`);
});
