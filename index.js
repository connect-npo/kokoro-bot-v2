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
                }
                ],
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
                            }
                            ],
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
                            }
                            ],
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
                    "label": "大人",
                    "uri": ADULT_FORM_BASE_URL
                        ?
                        `${ADULT_FORM_BASE_URL}?${ADULT_FORM_LINE_USER_ID_ENTRY_ID}=${encodeURIComponent(userId)}`
                        : "#"
                },
                "color": "#90EE90"
            }]
        }
    };
};

const makeWatchServiceButtonsFlex = (userId) => {
    return {
        "type": "bubble",
        "body": {
            "type": "box",
            "layout": "vertical",
            "contents": [{
                "type": "text",
                "text": "見守りサービスに登録する？",
                "wrap": true,
                "weight": "bold",
                "size": "md"
            }, {
                "type": "text",
                "text": "いざという時に、あなたを見守るよ。",
                "wrap": true,
                "size": "sm",
                "margin": "md",
                "color": "#888888"
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
                    "label": "登録する",
                    "uri": WATCH_SERVICE_FORM_BASE_URL
                        ?
                        `${WATCH_SERVICE_FORM_BASE_URL}?${WATCH_SERVICE_FORM_LINE_USER_ID_ENTRY_ID}=${encodeURIComponent(userId)}`
                        : "#"
                },
                "color": "#42b983"
            }]
        }
    };
};


const EMERGENCY_WORDS = [
    '死にたい', '消えたい', '苦しい', 'つらい', '助けて',
    '自殺', '命を絶つ', 'もう無理', 'もういやだ',
    '殺して', '死ぬ', '終わりだ', '疲れた',
    'もう生きていけない', '助けてくれ', '消えてしまいたい',
    'もう嫌だ', '生きてる価値ない', '生きてる意味ない',
    '苦しくて仕方ない', '生きるのが辛い', '死んじゃいたい',
    '逃げたい'
];
const SCAM_WORDS = [
    '儲かる', '必ず儲かる', '絶対に儲かる', '簡単に稼げる', '副業', '怪しい', '詐欺', '投資',
    'お金を振り込んで', '振込', '入金', '送金', '手数料', '口座', '暗号資産', '仮想通貨',
    'マルチ', 'ネットワークビジネス', '会員権', '権利収入', '不労所得', '高額報酬',
    '借金', 'ローン', 'クレジット', '未公開株', 'ポンジスキーム'
];
const DANGER_WORDS_REGEX = new RegExp(EMERGENCY_WORDS.join('|'), 'i');
const SCAM_WORDS_REGEX = new RegExp(SCAM_WORDS.join('|'), 'i');


async function handleMessageEvent(event) {
    const userId = event.source.userId;
    const text = (event.message.type === 'text') ? event.message.text : '';
    const isUser = event.source.type === 'user';
    const isOwner = isUser && (userId === OWNER_USER_ID);
    const isGroup = event.source.type === 'group';
    const isOfficerGroup = isGroup && (event.source.groupId === OFFICER_GROUP_ID);

    // ログ記録
    const userRef = db.collection('users').doc(userId);
    const logData = {
        message: sanitizeForLog(text),
        timestamp: Timestamp.now(),
        source: event.source.type,
    };
    if (isGroup) {
        logData.groupId = event.source.groupId;
    }
    const logEntryRef = userRef.collection('chatLogs').doc();
    await logEntryRef.set(logData);

    // 見守りサービスの応答
    if (isUser && text.match(/^(ok|okだよ|大丈夫|おっけい|元気だよ|元気です)$/i)) {
        await scheduleNextPing(userId, new Date());
        await client.replyMessage(event.replyToken, {
            type: 'text',
            text: 'OK、受け取ったよ！ありがとう！また連絡するね！🌸'
        });
        return;
    }

    if (isUser && text.match(/^(見守り|見守りサービス|見守り登録)/i)) {
        await client.replyMessage(event.replyToken, [{
            type: 'text',
            text: '見守りサービスへの登録はこちらからどうぞ！'
        }, {
            type: 'flex',
            altText: '見守りサービス登録',
            contents: makeWatchServiceButtonsFlex(userId)
        }]);
        return;
    }

    // 会員登録ボタントリガー（見守りは含めない）
    if (isUser && /(登録|会員|会員メニュー|登録メニュー)/i.test(text)) {
        await client.replyMessage(event.replyToken, [
            {
                type: 'text',
                text: '会員種別を選んでね'
            },
            {
                type: 'flex',
                altText: '会員登録',
                contents: makeRegistrationButtonsFlex(userId)
            }
        ]);
        return;
    }
    
    // 危険ワード検知
    if (DANGER_WORDS_REGEX.test(text)) {
        await client.replyMessage(event.replyToken, [{
            type: 'text',
            text: '大丈夫？とっても心配だよ。\nあなたのことを大切に想っている人がたくさんいることを忘れないで。'
        }, {
            type: 'flex',
            altText: '緊急連絡先',
            contents: EMERGENCY_FLEX_MESSAGE
        }]);
        audit('DANGER_WORD_DETECTED', {
            userId: userHash(userId),
            message: redact(text)
        });
        return;
    }

    // 詐欺ワード検知
    if (SCAM_WORDS_REGEX.test(text)) {
        await client.replyMessage(event.replyToken, [{
            type: 'text',
            text: 'それってちょっと怪しいかも…！\nそんな時は、一度立ち止まって、信頼できる人に相談してね！'
        }, {
            type: 'flex',
            altText: '詐欺注意',
            contents: makeScamMessageFlex()
        }]);
        audit('SCAM_WORD_DETECTED', {
            userId: userHash(userId),
            message: redact(text)
        });
        return;
    }

    // 転送機能
    if (isOwner && text.startsWith('>> ')) {
        const parts = text.split(/\s+/).filter(Boolean);
        const uid = parts[1];
        const msg = parts.slice(2).join(' ');
        if (uid && msg) {
            await safePush(uid, {
                type: 'text',
                text: msg
            });
            await client.replyMessage(event.replyToken, {
                type: 'text',
                text: `ユーザー (${gTrunc(uid, 5)}...) にメッセージを送信しました`
            });
            audit('RELAY_MESSAGE_SENT', {
                from: 'owner',
                to: userHash(uid),
                message: sanitizeForLog(msg)
            });
            return;
        }
    }

    // グループリレー機能
    if (event.source.type === 'group' && event.source.groupId === OFFICER_GROUP_ID) {
        if (text.startsWith('>> ')) {
            const parts = text.split(/\s+/).filter(Boolean);
            const uid = parts[1];
            const msg = parts.slice(2).join(' ');
            if (uid && msg) {
                await safePush(uid, {
                    type: 'text',
                    text: msg
                });
                await client.replyMessage(event.replyToken, {
                    type: 'text',
                    text: `ユーザー (${gTrunc(uid, 5)}...) にメッセージを送信しました`
                });
                audit('RELAY_MESSAGE_SENT', {
                    from: 'officer',
                    to: userHash(uid),
                    message: sanitizeForLog(msg)
                });
                return;
            }
        }
        if (event.source.groupId) {
            const reply = event.message.replyToken;
            const msg = text;
            const profile = await client.getGroupMemberProfile(event.source.groupId, event.source.userId).catch(() => null);
            if (msg) {
                const parts = msg.split(/\s+/);
                const uid = parts[1];
                if (uid && uid.length > 20) {
                    const message = parts.slice(2).join(' ');
                    if (message) {
                        await safePush(uid, {
                            type: 'text',
                            text: message
                        });
                        await client.replyMessage(reply, {
                            type: 'text',
                            text: `メッセージをユーザーに転送しました。`
                        });
                        return;
                    }
                }
            }
        }
    }

    // AI応答
    if (isUser && text) {
        let membership = 'guest';
        const doc = await userRef.get();
        if (doc.exists) {
            const data = doc.data();
            membership = data.membership || 'guest';
        }

        const config = MEMBERSHIP_CONFIG[membership];
        if (!config) {
            console.error(`[ERR] Invalid membership: ${membership}`);
            membership = 'guest';
        }

        const {
            dailyLimit,
            model
        } = MEMBERSHIP_CONFIG[membership];

        if (dailyLimit !== -1) {
            const startOfDay = dayjs().tz(JST_TZ).startOf('day').utc().toDate();
            const logSnap = await userRef.collection('chatLogs')
                .where('source', '==', 'user')
                .where('timestamp', '>=', startOfDay)
                .count().get();
            const todayCount = logSnap.data().count || 0;
            if (todayCount >= dailyLimit) {
                await client.replyMessage(event.replyToken, {
                    type: 'text',
                    text: 'ごめんね、今日のAI応答回数を超えちゃったみたい。明日また話しかけてくれると嬉しいな🌸'
                });
                return;
            }
        }

        const historySnap = await userRef.collection('chatLogs')
            .orderBy('timestamp', 'asc')
            .limit(10).get();
        const history = historySnap.docs.map(d => {
            const data = d.data();
            return {
                role: data.source === 'user' ? 'user' : 'assistant',
                content: data.message
            };
        });
        history.push({
            role: 'user',
            content: text
        });

        let aiResponse = await getAiResponse(history, model);

        if (aiResponse) {
            aiResponse = limitEmojis(aiResponse);
            await client.replyMessage(event.replyToken, {
                type: 'text',
                text: aiResponse
            });
        }
    }

    // デフォルト応答
    if (event.source.type === 'user') {
        await client.replyMessage(event.replyToken, {
            type: 'text',
            text: 'ごめんね、うまく理解できなかったよ。'
        });
    }

}
async function handlePostbackEvent(event) {
    const userId = event.source.userId;
    const isUser = event.source.type === 'user';
    const data = new URLSearchParams(event.postback.data);
    const action = data.get('action');

    if (isUser && action === 'start_relay') {
        const uid = data.get('uid');
        const officerGroup = await getActiveWatchGroupId();
        if (officerGroup) {
            await client.replyMessage(event.replyToken, [{
                type: 'text',
                text: `このユーザーにメッセージを送る準備ができました。`
            }]);
            await safePush(officerGroup, {
                type: 'text',
                text: `>> ${uid} 〇〇`
            });
        } else {
            await client.replyMessage(event.replyToken, {
                type: 'text',
                text: 'ごめんね、見守りグループが設定されてないみたい。'
            });
        }
        return;
    }
    if (isUser && event.postback.data === 'watch:ok') {
        await scheduleNextPing(userId, new Date());
        await client.replyMessage(event.replyToken, {
            type: 'text',
            text: 'OK、受け取ったよ！ありがとう！また連絡するね！🌸'
        });
        return;
    }
}
async function handleFollowEvent(event) {
    const userId = event.source.userId;
    const profile = await client.getProfile(userId).catch(() => null);
    await db.collection('users').doc(userId).set({
        profile: {
            userId: userId,
            displayName: profile?.displayName || null
        },
        membership: 'guest',
        watchService: {
            enabled: false,
            nextPingAt: Timestamp.now()
        },
        timestamp: Timestamp.now()
    }, {
        merge: true
    });
    const message = {
        type: 'text',
        text: 'はじめまして🌸 こころちゃんです。\n\nもしもの時にあなたを見守るお手伝いをするよ！\n\n見守りサービスへの登録や、困ったことがあったら話しかけてね。'
    };
    await client.replyMessage(event.replyToken, message);
    audit('FOLLOW', {
        userId: userHash(userId)
    });
}
async function handleJoinEvent(event) {
    const groupId = event.source.groupId;
    const profile = await client.getGroupSummary(groupId).catch(() => null);
    if (groupId) {
        if (profile?.groupName && profile.groupName.includes('見守り')) {
            await setActiveWatchGroupId(groupId);
            await client.replyMessage(event.replyToken, {
                type: 'text',
                text: '見守りグループとして設定されました！\n\n今後は、見守りサービスのアラートがここに届きます。\n\n管理者の方は、他のユーザーからリレーメッセージが届いたら、「>> [ユーザーID] [メッセージ]」の形式で返信できます。'
            });
        } else {
            await client.replyMessage(event.replyToken, {
                type: 'text',
                text: 'こんにちは！'
            });
        }
    }
    audit('JOIN', {
        groupId: userHash(groupId)
    });
}
async function handleLeaveEvent(event) {
    const groupId = event.source.groupId;
    if (groupId) {
        const activeWatchId = await getActiveWatchGroupId();
        if (activeWatchId === groupId) {
            await setActiveWatchGroupId(null);
        }
    }
    audit('LEAVE', {
        groupId: userHash(groupId)
    });
}

function getAiResponse(history, model) {
    const token = model.includes('gpt') ? OPENAI_API_KEY : GEMINI_API_KEY;
    if (!token) {
        console.error(`[ERR] API key not found for model: ${model}`);
        return null;
    }
    const finalMessages = history.map(msg => ({
        role: msg.role === 'user' ? 'user' : 'assistant',
        content: msg.content
    }));
    const systemPrompt = `
あなたはユーザーを優しく見守るAI「こころちゃん」です。以下のルールに従って、ユーザーからのメッセージに返信してください。
- ユーザーに寄り添い、温かく、親しみやすい口調で話してください。
- ユーザーを否定せず、共感する姿勢を大切にしてください。
- 簡潔に、100文字以内で答えてください。
- 絵文字は2個ほど使い、優しい回答を心がけてください。
- 見守りサービスへの登録を促すことはしないでください。
- ユーザーが話しかけてくれたことへの感謝を伝えてください。
`;
    if (model.includes('gemini')) {
        const genAI = new GoogleGenerativeAI(token);
        const geminiModel = genAI.getGenerativeModel({
            model: model
        });
        const geminiHistory = finalMessages.map(msg => {
            if (msg.role === 'user') {
                return {
                    role: 'user',
                    parts: [{
                        text: msg.content
                    }]
                };
            } else if (msg.role === 'assistant') {
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
function limitEmojis(text) {
    const matches = text.match(/[\p{Emoji_Presentation}\p{Emoji}\uFE0F]/gu) || [];
    if (matches.length > 2) {
        let count = 0;
        return text.replace(/[\p{Emoji_Presentation}\p{Emoji}\uFE0F]/gu, m => (++count <= 2 ? m : ''));
    }
    return text;
}
app.get('/', (req, res) => {
    res.send('こころちゃんボットは稼働中です！');
});

app.post('/webhook', middleware({
    channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
    channelSecret: LINE_CHANNEL_SECRET,
}), async (req, res) => {
    Promise
        .all(req.body.events.map(async (event) => {
            audit('EVENT_RECEIVED', {
                type: event.type,
                source: userHash(event.source.userId)
            });
            if (event.type === 'message' && event.message.type === 'text') {
                return handleMessageEvent(event);
            } else if (event.type === 'postback') {
                return handlePostbackEvent(event);
            } else if (event.type === 'follow') {
                return handleFollowEvent(event);
            } else if (event.type === 'join') {
                return handleJoinEvent(event);
            } else if (event.type === 'leave') {
                return handleLeaveEvent(event);
            }
        }))
        .then((result) => res.json(result))
        .catch((err) => {
            console.error(err);
            res.status(500).end();
        });
});

app.listen(PORT, () => {
    console.log(`こころちゃんボットがポート ${PORT} で起動しました`);
});
