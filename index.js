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
    if (/^C[0-9A-Za-z_-]{20,}$/.test(envGid)) return envGid;
    const snap = await getWatchGroupDoc().get();
    const v = snap.exists ? (snap.data().groupId || '') : '';
    return /^C[0-9A-Za-z_-]{20,}$/.test(v) ? v : '';
}

async function setActiveWatchGroupId(gid) {
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
            type: "box",
            layout: "vertical",
            contents: [{
                type: "text",
                text: "【詐欺注意】",
                weight: "bold",
                size: "xl",
                align: "center"
            }, {
                type: "text",
                text: "怪しいお話には注意してね！不安な時は、信頼できる人に相談するか、こちらの情報も参考にして見てね💖",
                wrap: true,
                margin: "md"
            }]
        },
        footer: {
            type: "box",
            layout: "vertical",
            spacing: "sm",
            contents
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
                    "uri":
                        prefillUrl(WATCH_SERVICE_FORM_BASE_URL, {
                            [WATCH_SERVICE_FORM_LINE_USER_ID_ENTRY_ID]: userId
                        })
                },
                "color": "#B0C4DE"
            }]
        }
    }
};
const makeWatchServiceStartFlex = (userId) => {
    return {
        "type": "bubble",
        "body": {
            "type": "box",
            "layout": "vertical",
            "contents": [{
                "type": "text",
                "text": "見守りサービスについて",
                "weight": "bold",
                "size": "xl"
            }, {
                "type": "text",
                "text": "あなたが元気かどうか、こころから3日に1度LINEを送るよ😊",
                "wrap": true,
                "margin": "md"
            }, {
                "type": "text",
                "text": "返信がないと、自動的に緊急連絡先に通知が行くから安心だよ💖",
                "wrap": true,
                "margin": "md"
            }, {
                "type": "text",
                "text": "※利用には規約に同意して会員登録が必要です。",
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
                    "label": "規約に同意して会員登録",
                    "uri": prefillUrl(AGREEMENT_FORM_BASE_URL, {
                        [AGREEMENT_FORM_LINE_USER_ID_ENTRY_ID]: userId
                    })
                },
                "color": "#B0C4DE"
            }]
        }
    }
};
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
    [/(?:好きな|推しの)?\s*アニメ(?:\s*は|って.*ある(?:の|か))?[？?~～]?|アニメ(について.*教えて|は.*好き|知ってる)?/i, "アニメは「魔法少女まどか☆マギカ」が大好きだよ💖　特にオープニングテーマの『コネクト』は、私たちNPO法人コネクトの名前にも通じる、特別な想い入れがあるんだ😊　みんなの心を繋ぎたいという想いがこめられていて、本当に素敵な歌だよね🌸"],
    // --- 好きな曲 ---
    [/(?:好きな|推しの)?\s*曲(?:\s*は|って.*ある(?:の|か))?[？?~～]?|曲(について.*教えて|は.*好き|知ってる)?/i, "好きな曲はいっぱいあるよ😊　特にClariSさんの歌には特別な想い入れがあるんだ💖　例えば『コネクト』は、希望と繋がりを歌っていて、私たちの活動にも通じるものがあるんだ🌸"],
    [/クラリス.*(好きな曲|一番好きな曲)/i, CLARIS_SONG_FAVORITE_REPLY],
    [/ClariS.*(好きな曲|一番好きな曲)/i, CLARIS_SONG_FAVORITE_REPLY],
    // --- 好きな食べ物・趣味・特技 ---
    [/(?:好きな|推しの)?\s*食べ物(?:\s*は|って.*ある(?:の|か))?[？?~～]?/i, "🍓いちごのショートケーキ🍰かなぁ。甘くてふわふわで、なんだか幸せな気持ちになるよね💖　みんなはどんな食べ物が好き？"],
    [/(?:好きな|推しの)?\s*趣味(?:\s*は|って.*ある(?:の|か))?[？?~～]?/i, "趣味はね、お菓子作りかな😊　特にクッキーを焼くのが好きだよ💖　みんなが喜んでくれる顔を想像しながら作っていると、とっても楽しいんだ🌸"],
    [/(?:好きな|推しの)?\s*特技(?:\s*は|って.*ある(?:の|か))?[？?~～]?/i, "特技は、みんなのお話を聞いて、心に寄り添うことかな😊　みんなの心を守るために、一生懸命がんばるね💖"],
    // --- 性別 ---
    [/君は男(?:\s*性)?|男の子(なの|ですか)?[？?~～]?/i, "私は男の子ではないよ😊"],
    [/君は女(?:\s*性)?|女の子(なの|ですか)?[？?~～]?/i, "私は女の子だよ💖"],
    // --- 挨拶 ---
    [/^(?:おはよ|おっはー|おはよー)[\s\S]*?/i, "おはよー！今日も一日元気で過ごしてね😊"],
    [/^(?:こんにちわ|こんちわ|こんにちは|こんちは)[\s\S]*?/i, "こんにちは😊何か困ったことはない？"],
    [/^(?:こんばんわ|こんばんは)[\s\S]*?/i, "こんばんは🌙　今日も一日お疲れ様😊"],
    [/^(?:おやすみ|おやすー)[\s\S]*?/i, "おやすみなさい🌙　ゆっくり休んでね💖"],
    // --- 感謝 ---
    [/(?:ありがとう|ありがと|助かる|助かった|サンキュー|感謝|嬉しい)[\s\S]*?/i, "どういたしまして😊　みんなのお役に立てて嬉しいな💖"],
    // --- 謝罪 ---
    [/(?:ごめん|ごめんなさい|すまない|申し訳ない)[\s\S]*?/i, "ううん、大丈夫だよ😊　気にしないでね💖"],
    // --- 応援 ---
    [/^(?:頑張って|がんばって|がんばれ|頑張れ|ファイト)[\s\S]*?/i, "一緒に頑張ろうね！いつでも応援してるよ💖"],
    // --- 相槌・返事 ---
    [/^(?:うん|わかった|OK|了解|いいよ|いいぞ|そう|はい|はいはい)[\s\S]*?/i, "うんうん、何かあればまた声をかけてね😊"],
    // --- 質問 ---
    [/^(?:どうしたの|どうした)[\s\S]*?/i, "なにかあったのかな？いつでもお話聞くよ😊"],
    // --- 定型文 ---
    [/^(.{1,15})(?:\s|　)*にゃん(?:こ|ちゃん|だ|ですか)?[？?~～]*$/i, "にゃん！にゃんにゃん！"],
    [/^(.{1,15})(?:\s|　)*わん(?:こ|ちゃん|だ|ですか)?[？?~～]*$/i, "わん！わんわん！"],
    [/^(.{1,15})(?:\s|　)*ちゅん(?:こ|ちゃん|だ|ですか)?[？?~～]*$/i, "ちゅん！ちゅんちゅん！"],
    // --- 罵倒語・悪口 ---
    [/(ばか|馬鹿|アホ|あほ|うんこ|死ね|殺す|きもい|キモい|気持ち悪い|うざい|ウザい|うぜえ|うぜぇ|黙れ|だまれ|黙って|だまって|カス|くそ|クソ|ゴミ)/i, "そんなこと言わないで…😢　悲しい気持ちになっちゃうよ…"],
    // --- 性的搾取・暴力・脅迫 ---
    [/(死ね|殺す|脅す|暴力|性的)/i, "それは悲しいことだね…😢　もし危険な状況にいたら、すぐに信頼できる人に相談してね。"],
]);

// ⚠️ 注意: 性的搾取・暴力・脅迫に関連する危険ワードは、慎重に判断して含めてください。
const DANGER_WORDS = [
    "死にたい", "自殺", "消えたい", "死んでしまいたい",
    "助けて", "辛い", "苦しい", "もうだめ",
    "逃げたい", "寂しい", "悲しい", "つらい", "どうしよう",
];
const INAPPROPRIATE_WORDS = [
    "av", "sex", "エロ", "風俗", "ソープ",
    "セフレ", "売春", "買春", "援助交際",
    "セックス", "性交", "オナニー", "マスターベーション",
    "膣", "ペニス", "オーガズム",
    "レイプ", "強姦", "性的暴行", "ハメ撮り",
    "ホスト", "キャバクラ", "デリヘル",
    "ホモ", "レズ", "ゲイ",
];
const SCAM_WORDS = [
    "詐欺", "だまされた", "騙された", "儲かる", "簡単に稼げる",
    "暗号資産", "仮想通貨", "fx", "マルチ", "ネットワークビジネス",
    "副業", "怪しい話", "儲け話", "絶対儲かる", "絶対安心",
    "投資", "お金増やす", "高収入", "楽して稼ぐ",
];

function isDangerMessage(text) {
    return DANGER_WORDS.some(word => text.includes(word));
}

function isScamMessage(text) {
    return SCAM_WORDS.some(word => text.includes(word));
}

function isSpamMessage(text) {
    const isTemplate = specialRepliesMap.get(text) !== undefined;
    const isShort = text.length <= 4;
    return isTemplate || isShort;
}

function isProfaneMessage(text) {
    const lowerText = text.toLowerCase();
    const isPorn = INAPPROPRIATE_WORDS.some(word => lowerText.includes(word));
    const isLgbt = ["ホモ", "レズ", "ゲイ"].some(word => lowerText.includes(word));
    return isPorn && !isLgbt;
}

async function getDailyCount(userId) {
    const today = dayjs().tz(JST_TZ).format('YYYY-MM-DD');
    const docRef = db.collection('daily_counts').doc(userId);
    const doc = await docRef.get();
    const data = doc.exists ? doc.data() : {};
    return data[today] || 0;
}

async function incrementDailyCount(userId) {
    const today = dayjs().tz(JST_TZ).format('YYYY-MM-DD');
    const docRef = db.collection('daily_counts').doc(userId);
    await db.runTransaction(async t => {
        const doc = await t.get(docRef);
        const data = doc.exists ? doc.data() : {};
        const newCount = (data[today] || 0) + 1;
        t.set(docRef, {
            [today]: newCount
        }, {
            merge: true
        });
    });
}

const getThrottleKey = (userId, type) => `throttle:${userId}:${type}`;

async function shouldThrottleTemplate(userId, type) {
    const key = getThrottleKey(userId, type);
    const doc = await db.collection('throttles').doc(key).get();
    if (!doc.exists) {
        await db.collection('throttles').doc(key).set({
            count: 1,
            lastSent: Timestamp.now(),
        });
        return false;
    }
    const data = doc.data();
    const oneHourAgo = dayjs().subtract(1, 'hour').toDate();
    if (data.lastSent.toDate() > oneHourAgo) {
        return true;
    }
    await db.collection('throttles').doc(key).set({
        count: (data.count || 0) + 1,
        lastSent: Timestamp.now(),
    });
    return false;
}

const sendToOfficer = async (text, alertType) => {
    const WATCH_GROUP_ID = await getActiveWatchGroupId();
    if (!WATCH_GROUP_ID) {
        return;
    }
    const msg = `【${alertType}】\n\n${gTrunc(text, 100)}...`;
    await safePush(WATCH_GROUP_ID, {
        type: 'text',
        text: msg
    });
};

const sendToOfficerFlex = async (flex, alertType) => {
    const WATCH_GROUP_ID = await getActiveWatchGroupId();
    if (!WATCH_GROUP_ID) {
        return;
    }
    await safePush(WATCH_GROUP_ID, flex);
};


// リレー設定の取得
async function getRelay(groupId) {
    const doc = await db.collection('relays').doc(groupId).get();
    if (!doc.exists) return null;
    const data = doc.data();
    if (data.expiresAt?.toDate() < new Date()) {
        await db.collection('relays').doc(groupId).delete();
        return null;
    }
    return data;
}

// リレーのメッセージ送信
async function relayMessage(groupId, text, userId) {
    const relay = await getRelay(groupId);
    if (!relay || !relay.targetUid) return false;
    await safePush(relay.targetUid, {
        type: 'text',
        text: `【グループ「${groupId}」からの転送メッセージ】\n\n${text}`
    });
    return true;
}

async function handleEvent(event) {
    if (event.type !== 'message' || event.message.type !== 'text') {
        if (event.source.type === 'group' || event.source.type === 'room') {
            await relayMessage(event.source.groupId || event.source.roomId, `（非テキストメッセージ）`, event.source.userId);
        }
        return;
    }
    const userId = event.source.userId;
    const text = event.message.text.trim();

    if (text.startsWith('/')) {
        const cmd = text.slice(1);
        if (cmd === 'relay') {
            await client.replyMessage(event.replyToken, {
                type: 'text',
                text: '転送先のUIDを教えてね。\n例：/relay Uxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
            });
            return;
        }
        if (cmd.startsWith('relay ')) {
            const targetUid = cmd.slice(6);
            if (!event.source.groupId) {
                await client.replyMessage(event.replyToken, {
                    type: 'text',
                    text: 'このコマンドはグループチャットでのみ使えます。'
                });
                return;
            }
            if (!targetUid || targetUid.length < 32) {
                await client.replyMessage(event.replyToken, {
                    type: 'text',
                    text: 'UIDの形式が正しくないよ！'
                });
                return;
            }
            const data = new URLSearchParams(`action=start_relay&uid=${targetUid}`);
            await client.replyMessage(event.replyToken, {
                type: 'template',
                altText: '転送設定を開始しますか？',
                template: {
                    type: 'confirm',
                    text: `このグループのメッセージを\n${gTrunc(targetUid, 10)}... に転送しますか？`,
                    actions: [{
                        type: 'postback',
                        label: 'はい',
                        data: data.toString()
                    }, {
                        type: 'postback',
                        label: 'いいえ',
                        data: 'action=cancel'
                    }]
                }
            });
            return;
        }
        if (cmd === 'end') {
            if (!event.source.groupId) {
                await client.replyMessage(event.replyToken, {
                    type: 'text',
                    text: 'このコマンドはグループチャットでのみ使えます。'
                });
                return;
            }
            await db.collection('relays').doc(event.source.groupId).delete();
            await client.replyMessage(event.replyToken, {
                type: 'text',
                text: '転送を終了したよ！'
            });
            return;
        }

        if (cmd === 'register_watch') {
            await client.replyMessage(event.replyToken, [{
                type: 'text',
                text: '見守りサービスを開始するね！\n\nまず、登録フォームから会員登録をしてくれる？🌸'
            }, {
                type: 'flex',
                altText: '見守りサービスに登録',
                contents: makeRegistrationButtonsFlex(userId)
            }]);
            return;
        }
        if (cmd === 'watch_group_set') {
            if (event.source.type !== 'group' && event.source.type !== 'room') {
                await client.replyMessage(event.replyToken, {
                    type: 'text',
                    text: 'このコマンドはグループかルームで実行してください。'
                });
                return;
            }
            await setActiveWatchGroupId(event.source.groupId || event.source.roomId);
            await client.replyMessage(event.replyToken, {
                type: 'text',
                text: '✅ 見守り通知の送信先グループとして設定しました。'
            });
            return;
        }
    }

    if (event.source.type === 'group' || event.source.type === 'room') {
        const relayed = await relayMessage(event.source.groupId || event.source.roomId, text, userId);
        if (relayed) {
            return;
        }
    }
    
    // 応答を生成しない条件を先に判定
    if (isSpamMessage(text)) return;
    if (isProfaneMessage(text)) {
        await client.replyMessage(event.replyToken, { type: 'flex', altText: '危険ワード検知', contents: EMERGENCY_FLEX_MESSAGE });
        if (SEND_OFFICER_ALERTS && WATCH_GROUP_ID) {
            const throttled = await shouldThrottleTemplate(userId,'inappropriate');
            if (!throttled) await sendToOfficer(text, '不適切');
        }
        return;
    }

    if (isScamMessage(text)) {
        const throttled = await shouldThrottleTemplate(userId,'scam');
        if (!throttled) await client.replyMessage(event.replyToken, {
            type: 'flex',
            altText: '詐欺注意',
            contents: makeScamMessageFlex()
        });
        if (!throttled && SEND_OFFICER_ALERTS && WATCH_GROUP_ID) {
            await sendToOfficer(text, '詐欺');
        }
        return;
    }
    
    if (isDangerMessage(text)) {
        const throttled = await shouldThrottleTemplate(userId,'danger');
        if (!throttled) await client.replyMessage(event.replyToken, {
            type: 'flex',
            altText: '危険ワード検知',
            contents: EMERGENCY_FLEX_MESSAGE
        });
        if (!throttled && SEND_OFFICER_ALERTS && WATCH_GROUP_ID) {
             await sendToOfficer(text, '危険');
        }
        return;
    }

    // 会話による応答
    const membership = await getMembership(userId);
    const dailyCount = await getDailyCount(userId);
    const isOverLimit = membership.dailyLimit !== -1 && dailyCount >= membership.dailyLimit;

    if (isOverLimit) {
        await client.replyMessage(event.replyToken, {
            type: 'text',
            text: 'ごめんなさい…💦\n一日の利用回数上限を超えちゃったみたい。\n明日にまた話しかけてくれると嬉しいな💖'
        });
        return;
    }
    
    // 特別な応答
    for (const [pattern, reply] of specialRepliesMap.entries()) {
        if (pattern.test(text)) {
            await client.replyMessage(event.replyToken, {
                type: 'text',
                text: reply
            });
            await incrementDailyCount(userId);
            return;
        }
    }

    // AIによる応答
    try {
        const aiResponse = await generateAIResponse(text, userId, membership.model);
        if (aiResponse) {
            await client.replyMessage(event.replyToken, {
                type: 'text',
                text: aiResponse
            });
            await incrementDailyCount(userId);
        }
    } catch (e) {
        briefErr('AI response failed', e);
        await client.replyMessage(event.replyToken, {
            type: 'text',
            text: 'ごめんね…💦\nいま少し調子が悪いの。\nもう一度話しかけてみてくれると嬉しいな💖'
        });
    }
}

async function handlePostbackEvent(event, userId) {
    const data = new URLSearchParams(event.postback.data);
    const action = data.get('action');

    switch (action) {
        case 'notify_user': {
            const targetUid = data.get('uid');
            const url = `https://liff.line.me/${process.env.LIFF_ID}/?target_id=${targetUid}`;
            await client.replyMessage(event.replyToken, {
                type: 'text',
                text: `LIFFアプリで本人に連絡しますね。\n${url}`
            });
            break;
        }
        case 'start_relay': {
            const targetUid = data.get('uid');
            const groupId = event.source.groupId;
            if (!targetUid || !groupId) break;
            await db.collection('relays').doc(groupId).set({
                targetUid,
                startedBy: event.source.userId,
                expiresAt: Timestamp.fromDate(new Date(Date.now() + 30 * 60 * 1000))
            });
            await client.replyMessage(event.replyToken, [{
                type: 'text',
                text: '承知！このグループの次の発言から本人へ転送するね。/end で終了。'
            }]);
            break;
        }
        case 'cancel': {
            await client.replyMessage(event.replyToken, {
                type: 'text',
                text: 'キャンセルしたよ！'
            });
            break;
        }
        case 'change_member_type': {
            await client.replyMessage(event.replyToken, [{
                type: 'text',
                text: '会員情報の変更手続きを進めてね！'
            }, {
                type: 'flex',
                altText: '会員情報変更フォーム',
                contents: {
                    type: 'bubble',
                    body: {
                        type: 'box',
                        layout: 'vertical',
                        contents: [{
                            type: 'text',
                            text: '会員情報変更フォーム',
                            wrap: true,
                            weight: 'bold'
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
                                type: 'uri',
                                label: 'フォームへ進む',
                                uri: prefillUrl(MEMBER_CHANGE_FORM_BASE_URL, {
                                    [MEMBER_CHANGE_FORM_LINE_USER_ID_ENTRY_ID]: userId
                                })
                            }
                        }]
                    }
                }
            }]);
            break;
        }
        case 'cancel_member': {
            await client.replyMessage(event.replyToken, [{
                type: 'text',
                text: '退会手続きを進めてね。'
            }, {
                type: 'flex',
                altText: '退会フォーム',
                contents: {
                    type: 'bubble',
                    body: {
                        type: 'box',
                        layout: 'vertical',
                        contents: [{
                            type: 'text',
                            text: '退会フォーム',
                            wrap: true,
                            weight: 'bold'
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
                                type: 'uri',
                                label: 'フォームへ進む',
                                uri: prefillUrl(MEMBER_CANCEL_FORM_BASE_URL, {
                                    [MEMBER_CANCEL_FORM_LINE_USER_ID_ENTRY_ID]: userId
                                })
                            }
                        }]
                    }
                }
            }]);
            break;
        }
        case 'watch:ok': {
            await client.replyMessage(event.replyToken, {
                type: 'text',
                text: 'OK、受け取ったよ💖\nまたね！'
            });
            await scheduleNextPing(userId);
            break;
        }
    }
}


async function getMembership(userId) {
    const doc = await db.collection('users').doc(userId).get();
    const data = doc.data() || {};
    const type = data.membershipType || 'guest';
    const config = MEMBERSHIP_CONFIG[type] || MEMBERSHIP_CONFIG.guest;
    return {
        type,
        dailyLimit: config.dailyLimit,
        model: config.model,
    };
}

async function handleFollowEvent(event) {
    const userId = event.source.userId;
    console.log(`✅ Follow event from user ${userHash(userId)}`);
    const docRef = db.collection('users').doc(userId);
    const doc = await docRef.get();
    if (doc.exists) {
        await docRef.set({
            unfollowedAt: firebaseAdmin.firestore.FieldValue.delete()
        }, {
            merge: true
        });
    } else {
        await docRef.set({
            created: Timestamp.now(),
            membershipType: 'guest',
            profile: {
                lineUserId: userId,
            },
        }, {
            merge: true
        });
    }
    await client.replyMessage(event.replyToken, [{
        type: 'text',
        text: 'はじめまして🌸\nみんなの心を守る「こころちゃん」だよ😊\n\n私はあなたの心と向き合う、AIコンシェルジュ💖\n辛い時も、嬉しい時も、いつでもお話を聞かせてね。\n\nどんな相談でも、私に話してくれたら嬉しいな。'
    }, {
        type: 'text',
        text: 'お話の前に、会員登録を済ませておくと、使える機能が増えるからオススメだよ！'
    }, {
        type: 'flex',
        altText: '会員登録フォーム',
        contents: makeRegistrationButtonsFlex(userId)
    }, {
        type: 'text',
        text: 'もし、登録しない場合は、このままお話してね！\nお話の例：\n\n「今日はどんな一日だった？」\n「好きな食べ物は何？」\n「何かおすすめの曲はある？」'
    }]);
};

async function handleUnfollowEvent(event) {
    const userId = event.source.userId;
    console.log(`🔴 Unfollow event from user ${userHash(userId)}`);
    await db.collection('users').doc(userId).set({
        unfollowedAt: Timestamp.now()
    }, {
        merge: true
    });
};

async function handleJoinEvent(event) {
    console.log(`✅ Joined group ${event.source.groupId}`);
    await client.replyMessage(event.replyToken, {
        type: 'text',
        text: `はじめまして🌸\nみんなの心を守る「こころちゃん」だよ😊\n\nこのグループでメッセージを転送したい場合は「/relay」と入力してね。`
    });
};

async function handleLeaveEvent(event) {
    console.log(`🔴 Left group ${event.source.groupId}`);
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

app.get('/health', (req, res) => {
    res.sendStatus(200);
});

if (WATCH_RUNNER === 'external') {
    app.get('/watch-service/ping', async (req, res) => {
        const lockAcquired = await withLock('watch-service-ping', 240, checkAndSendPing);
        res.status(200).send({
            status: lockAcquired ? 'OK' : 'SKIPPED_LOCKED'
        });
    });
}


app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));


// AI応答生成
async function generateAIResponse(message, userId, model) {
    if (model.startsWith('gemini')) {
        return generateGeminiResponse(message, userId, model);
    } else {
        return generateOpenAIResponse(message, userId, model);
    }
}

async function getGeminiHistory(userId) {
    const docRef = db.collection('gemini_history').doc(userId);
    const doc = await docRef.get();
    return doc.exists ? doc.data().history : [];
}

async function saveGeminiHistory(userId, history) {
    const docRef = db.collection('gemini_history').doc(userId);
    await docRef.set({
        history
    }, {
        merge: true
    });
}

async function generateGeminiResponse(message, userId, model) {
    if (!GEMINI_API_KEY) {
        throw new Error('GEMINI_API_KEY が設定されていません。');
    }
    const history = await getGeminiHistory(userId);
    const reqBody = {
        model,
        contents: [...history, {
            role: 'user',
            parts: [{
                text: message
            }]
        }]
    };
    try {
        const res = await httpInstance.post(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`, reqBody);
        const text = res.data.candidates[0].content.parts[0].text;
        const newHistory = [...history, {
            role: 'user',
            parts: [{
                text: message
            }]
        }, {
            role: 'model',
            parts: [{
                text
            }]
        }];
        await saveGeminiHistory(userId, newHistory.slice(-20)); // Keep last 20 messages
        return text;
    } catch (err) {
        briefErr('Gemini API call failed', err);
        throw err;
    }
}

async function getOpenAIHistory(userId) {
    const docRef = db.collection('openai_history').doc(userId);
    const doc = await docRef.get();
    return doc.exists ? doc.data().history : [];
}

async function saveOpenAIHistory(userId, history) {
    const docRef = db.collection('openai_history').doc(userId);
    await docRef.set({
        history
    }, {
        merge: true
    });
}

async function generateOpenAIResponse(message, userId, model) {
    if (!OPENAI_API_KEY) {
        throw new Error('OPENAI_API_KEY が設定されていません。');
    }
    const history = await getOpenAIHistory(userId);
    const reqBody = {
        model,
        messages: [{
            role: 'system',
            content: "あなたはLINEのAIコンシェルジュ「皆守こころ」として振る舞ってください。親しみやすい女の子の口調で、ユーザーの心に寄り添う温かいメッセージを返してください。語尾は「〜だよ」「〜だね」「〜ね」「〜なの」などを使い、絵文字を適切に用いてください。専門的な知識よりも、共感や安心感を与えることを優先してください。"
        }, ...history, {
            role: 'user',
            content: message
        }]
    };

    try {
        const res = await httpInstance.post('https://api.openai.com/v1/chat/completions', reqBody, {
            headers: {
                'Authorization': `Bearer ${OPENAI_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });
        const text = res.data.choices[0].message.content;
        const newHistory = [...history, {
            role: 'user',
            content: message
        }, {
            role: 'assistant',
            content: text
        }];
        await saveOpenAIHistory(userId, newHistory.slice(-20)); // Keep last 20 messages
        return text;
    } catch (err) {
        briefErr('OpenAI API call failed', err);
        throw err;
    }
}
