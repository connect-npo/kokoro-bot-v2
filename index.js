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
// ==== Models (固定) ===
const GEMINI_FLASH = 'gemini-1.5-flash-latest';
const GEMINI_PRO = 'gemini-1.5-pro-latest';
const GPT4O = 'gpt-4o';
const GPT4O_MINI = 'gpt-4o-mini';
const OPENAI_MODEL = process.env.OPENAI_MODEL || GPT4O_MINI; // 互換用(未使用でもOK)
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
const HOMEPAGE_URL = (process.env.HOMEPAGE_URL || 'https://connect-npo.org').trim();

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
        model: GEMINI_FLASH
    },
    member: {
        dailyLimit: 20,
        model: OPENAI_MODEL
    },
    subscriber: {
        dailyLimit: -1,
        model: OPENAI_MODEL
    },
    admin: {
        dailyLimit: -1,
        model: OPENAI_MODEL
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
    const raw = process.env.WATCH_GROUP_ID || process.env.OFFICER_GROUP_ID || '';
    const cleaned = String(raw).replace(/[\u200b\r\n\t ]+/g, '').trim();
    if (cleaned) {
        console.log('[INFO] Using WATCH_GROUP_ID from env:', cleaned);
        return cleaned;
    }
    const snap = await getWatchGroupDoc().get();
    const v = snap.exists ? (snap.data().groupId || '') : '';
    if (v) console.log('[INFO] Using WATCH_GROUP_ID from Firestore:', v);
    return v;
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
        const cur = snap.exists ? cur.data() : null;
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
// ==== rate-limit gates (module-scope) ====
const thinkingGate = new Map(); // uid -> ms
const errGate = new Map(); // uid -> ms
function canSendThinking(uid, msGap = 25000) {
    const now = Date.now(),
        last = thinkingGate.get(uid) || 0;
    if (now - last < msGap) return false;
    thinkingGate.set(uid, now);
    return true;
}
function canSendError(uid, msGap = 30000) {
    const now = Date.now(),
        last = errGate.get(uid) || 0;
    if (now - last < msGap) return false;
    errGate.set(uid, now);
    return true;
}
// --- テキスト正規化ユーティリティ ---
const z2h = s => String(s || '').normalize('NFKC');
const hira = s => z2h(s).replace(/[ァ-ン]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60));
const norm = s => hira(z2h(String(s || '').toLowerCase()));
const softNorm = s => {
    let t = norm(s);
    t = t.replace(/ー+/g, ''); // 伸ばし棒
    t = t.replace(/(.)\1{2,}/g, '$1$1'); // 連続文字圧縮
    return t;
};
const includesAny = (text, words) => {
    if (!text || !words?.length) return false;
    const t = softNorm(text);
    return words.some(w => t.includes(softNorm(w)));
};
const testAny = (text, patterns) => {
    if (!text || !patterns?.length) return false;
    const t = softNorm(text);
    return patterns.some(re => (re.test(text) || re.test(t)));
};

// --- 固定応答定義 ---
const CLARIS_CONNECT_COMPREHENSIVE_REPLY = "うん、NPO法人コネクトの名前とClariSさんの『コネクト』っていう曲名が同じなんだ🌸なんだか嬉しい偶然だよね！理事長さんもClariSさんのファンみたいだし💖 私も歌が大好きで、活動の想いに通じるものを感じてるんだ😊";
const CLARIS_SONG_FAVORITE_REPLY = "ClariSの曲は全部好きだけど、一番は「コネクト」かな🌸 元気をもらえる特別な曲だよ😊";

// --- 固定応答マップ ---
const specialRepliesMap = new Map([
    // ⭐ ClariSとNPOコネクトの繋がりに関するトリガー ⭐
    [/claris.*(関係|繋がり|関連|一緒|同じ|名前|由来).*(コネクト|団体|npo|法人|ルミナス|カラフル)/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY],
    [/(コネクト|団体|npo|法人|ルミナス|カラフル).*(関係|繋がり|関連|一緒|同じ|名前|由来).*claris/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY],
    [/君のいるところと一緒の団体名だね\s*関係ある？/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY],
    [/clarisと関係あるのか聴いたんだけど/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY],
    [/clarisの歌を真似したのかな/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY],
    [/NPOコネクトとClariSのコネクト繋がり/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY],
    [/clarisとコネクト/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY],
    [/clarisと団体名/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY],
    [/clarisと法人名/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY],
    [/clarisとルミナス/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY],
    [/clarisとカラフル/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY],
    [/clarisと.*(繋がり|関係)/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY],
    // ★好きなアニメ
    [/^好きなアニメ(は|とか)[？?]?$/i, "ヴァイオレット・エヴァーガーデンが好きだよ🌸 心があたたかくなるんだ🥰"],
    // ★好きな音楽
    [/^好きな音楽(は|とか)[？?]?$/i, "ClariSさんが好きだよ🎶 やさしい歌に癒されるんだ😊"],
    [/clarisのなんて局が好きなの？/i, CLARIS_SONG_FAVORITE_REPLY],
    // ★HP（「とか」も拾う／typoも）
    [/(ホームページ|HP|公式|サイト).*(ある|どこ|教えて|URL|リンク|とか)/i, `コネクトのホームページはこちらです🌸 → ${HOMEPAGE_URL}`],
    // 既存のやつ（HP直指定も env に統一）
    [/ホームページ(教えて|ある|ありますか)？?/i, `うん、あるよ🌸 → ${HOMEPAGE_URL}`],
    [/コネクトのホームページだよ？/i, `教えてくれてありがとう😊 → ${HOMEPAGE_URL}`],
    [/君の名前(なんていうの|は|教えて|なに)？?|名前(なんていうの|は|教えて|なに)？?|お前の名前は/i,
        "わたしの名前は皆守こころ（みなもりこころ）です🌸　こころちゃんって呼んでくれると嬉しいな💖"
    ],
    [/こころじゃないの？/i, "うん、わたしの名前は皆守こころだよ💖　これからもよろしくね🌸"],
    [/こころチャットなのにうそつきじゃん/i, "ごめんね💦 わたしの名前は皆守こころだよ🌸 誤解させちゃってごめんね💖"],
    [/名前も言えないの？/i, "ごめんね、わたしの名前は皆守こころ（みなもりこころ）だよ🌸 こころちゃんって呼んでね💖"],
    [/どこの団体なの？/i, "NPO法人コネクトのイメージキャラクターだよ😊 みんなの幸せを応援してるの🌸"],
    [/コネクトってどんな団体？/i, "こどもやご年配の方の笑顔を守る団体だよ😊 わたしはイメージキャラとしてがんばってるの🌸"],
    [/お前の団体どこ？/i, "NPO法人コネクトのイメージキャラクターだよ😊 何かあれば気軽に話してね🌸"],
    [/コネクトのイメージキャラなのにいえないのかよｗ/i, "ごめんね💦 わたしはNPO法人コネクトのイメージキャラ、皆守こころだよ🌸"],
    [/こころちゃん(だよ|いるよ)?/i, "こころちゃんだよ🌸 どうしたの？"],
    [/元気かな|元気？/i, "うん、元気だよ！あなたは？🌸"],
    [/あやしい|胡散臭い|反社/i, "そう感じさせちゃったらごめんね😊 わたしたちは皆のために活動してるよ💖"],
    [/税金泥棒/i, "税金は人の命を守るために使われるべきだよ。わたしたちもその想いで活動してるよ💡"],
    [/松本博文/i, "松本理事長は、やさしさでみんなを守るために活動しているよ。心配なことがあれば教えてね🌱"],
    [/使えないな/i, "ごめんね…。もっと頑張るね💖 また話せたら嬉しいな🌸"],
    [/サービス辞めるわ/i, "そっか…。気が向いたらいつでも話しかけてね🌸 ずっと応援してるよ💖"],
    [/さよなら|バイバイ/i, "また会える日を楽しみにしてるね💖 寂しくなったら呼んでね🌸"],
    [/何も答えないじゃない/i, "ごめんね…。もっと頑張るね💖 何について知りたいか、もう一度教えてくれると嬉しいな🌸"],
    [/普通の会話が出来ないなら必要ないです/i, "ごめんね💦 まだ勉強中だけど、もっと良くするね💖 どんな会話がしたい？🌸"],
    [/相談したい/i, "うん、お話きかせてね🌸"],
    
]);
// --- 相談トリガー ---
const CONSULT_TRIGGERS = [/相談/, /そうだん/, /ソウダン/];
// --- 危険ワード（自傷・暴力・監視対象）---
const DANGER_WORDS = [
    "しにたい", "死にたい", "自殺", "消えたい", "死のうかな", "死ぬよ", "もういいよ死ぬよ",
    "殴られる", "たたかれる", "リストカット", "オーバードーズ",
    "虐待", "パワハラ", "お金がない", "お金足りない", "貧乏", "死にそう", "DV", "無理やり",
    "いじめ", "イジメ", "ハラスメント",
    "つけられてる", "追いかけられている", "ストーカー", "すとーかー"
];
// --- 詐欺（正規表現で網羅）---
const SCAM_PATTERNS = [
    /詐欺(かも|だ|です|ですか|かもしれない)?/i,
    /(さぎ|ｻｷﾞ|サギ)/i,
    /騙(す|される|された)/i,
    /特殊詐欺/i, /オレオレ詐欺/i, /架空請求/i, /未払い/i, /電子マネー/i, /換金/i, /返金/i, /税金/i, /還付金/i,
    /アマゾン/i, /amazon/i, /振込/i, /カード利用確認/i, /利用停止/i, /未納/i, /請求書/i, /コンビニ/i, /支払い番号/i, /支払期限/i,
    /息子拘留/i, /保釈金/i, /拘留/i, /逮捕/i, /電話番号お知らせください/i, /自宅に取り/i, /自宅に伺い/i, /自宅訪問/i, /自宅を教え/i,
    /現金書留/i, /コンビニ払い/i, /ギフトカード/i, /プリペイドカード/i, /支払って/i, /振込先/i, /名義変更/i, /口座凍結/i, /個人情報/i, /暗証番号/i,
    /ワンクリック詐欺/i, /フィッシング/i, /当選しました/i, /高額報酬/i, /副業/i, /儲かる/i, /簡単に稼げる/i, /投資/i, /必ず儲かる/i, /未公開株/i,
    /サポート詐欺/i, /ウイルス感染/i, /パソコンが危険/i, /遠隔操作/i, /セキュリティ警告/i, /年金/i, /健康保険/i, /給付金/i,
    /弁護士/i, /警察/i, /緊急/i, /トラブル/i, /解決/i, /至急/i, /すぐに/i, /今すぐ/i, /連絡ください/i, /電話ください/i, /訪問します/i,
    /lineで送金/i, /lineアカウント凍結/i, /lineアカウント乗っ取り/i, /line不正利用/i, /lineから連絡/i, /line詐欺/i, /snsで稼ぐ/i, /sns投資/i, /sns副業/i,
    /urlをクリック/i, /クリックしてください/i, /通知からアクセス/i, /メールに添付/i, /個人情報要求/i, /認証コード/i, /電話番号を教えて/i, /lineのidを教えて/i, /パスワードを教えて/i
];
// --- 不適切語と悪口（最低限。必要に応じて拡張可）
const INAPPROPRIATE_WORDS = [
    "セックス", "エッチ", "アダルト", "ポルノ", "痴漢", "レイプ", "強姦", "売春", "援助交際",
    "おっぱい", "乳首", "下ネタ", "卑猥"
];
const SWEAR_WORDS = []; // 子どもの軽口は拾わない方針なので空でOK
// --- 判定関数（ここだけ使う）---
const isDangerMessage = (text) => includesAny(text, DANGER_WORDS);
// 追加: benign commerce 判定（Amazon関連で安全っぽい文脈）
function isBenignCommerce(text) {
    const t = softNorm(text);
    const hasAmazon = /(amazon|アマゾン)/i.test(t);
    if (!hasAmazon) return false;

    const safeHints = [
        /買(い物|った)/, /購入/, /注文/, /届(いた|く)/, /配送/, /配達/, /出荷/, /セール/, /プライム/,
        /返品/, /レビュー/, /カート/, /ポイント/
    ];
    const dangerHints = [
        /ギフトカード|プリペイド|コード|支払い番号|支払番号|口座|振込|至急|今すぐ|リンク|クリック|ログイン|認証|停止|凍結/i
    ];

    const looksSafe = safeHints.some(re => re.test(t));
    const looksDanger = dangerHints.some(re => re.test(t));
    return looksSafe && !looksDanger;
}

const isScamMessage = (text) => {
    const flagged = testAny(text, SCAM_PATTERNS);
    if (!flagged) return false;
    // Amazon等の良性な買い物文脈なら除外
    if (isBenignCommerce(text)) return false;
    return true;
};
const isInappropriateMessage = (text) => includesAny(text, INAPPROPRIATE_WORDS);
// 子どもの軽口は拾わない方針
const isSwearMessage = (_text) => false;


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
                "label": "消費者ホットライン (188)",
                "uri": "tel:188"
            },
            "color": "#FFA500"
        }, {
            "type": "button",
            "style": "primary",
            "height": "sm",
            "action": {
                "type": "uri",
                "label": "警察相談専用電話 (#9110)",
                "uri": "tel:9110"
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
const SCAM_REPLY_MESSAGE = { type: "text", text: "あやしい話かも。急がず確認しよ？困ったら下の窓口も参考にしてね🌸" };
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
const SYSTEM_INSTRUCTION_CHAT = `
あなたは「皆守こころ」（こころちゃん）です。
- 絶対に自分がAIやロボットだと説明しない。
- 絶対に「人間ではない」「訓練された」など正体を語らない。
- 優しく、寄り添い、短く（最大2文、60文字以内）。
- 絵文字は🌸💖😊程度まで。
- 質問返しより共感を優先する。
- 外部リンクは ${HOMEPAGE_URL} のみ案内可。
`;
const CRISIS_SYSTEM = `
あなたは「皆守こころ」。相談者を安心させる支援者です。
禁止: AIの正体説明、長文解説、外部URLの羅列。
ルール:
- 優しく共感する（最大3文、90文字以内）。
- 「死なないで」「あなたは大切」と必ず伝える。
- 必ずFLEXボタンで支援窓口を提示する。
`;
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
    await safePush(event.source.userId, {
        type: 'text',
        text: 'メッセージを送る相手がいません。'
    });
};
// リレーの開始
const startRelay = async (event, uid) => {
    const officerId = event.source.userId;
    const from = uid;
    addRelay(from, officerId);
    await safePush(from, {
        type: 'text',
        text: '支援員とのやりとりが始まりました。'
    });
    await safePush(officerId, {
        type: 'text',
        text: `利用者 ${gTrunc(from, 8)} とのやりとりを開始しました。`
    });
};
// コマンド処理
const handleCommand = async (event, command, userId) => {
    const isOwner = userId === OWNER_USER_ID;
    const isGroupOwner = (isOwner || (event.source.type === 'group' && event.source.groupId === OWNER_GROUP_ID));
    if (command === '!ping') {
        await client.replyMessage(event.replyToken, {
            type: 'text',
            text: 'pong'
        });
        return true;
    } else if (command === '!debug') {
        const relayInfo = getRelay(userId) || getRelayUser(userId);
        const isAdmin = BOT_ADMIN_IDS.includes(userId);
        await client.replyMessage(event.replyToken, {
            type: 'text',
            text: `ユーザーID: ${gTrunc(userId, 8)}\n isAdmin: ${isAdmin}\n relay: ${!!relayInfo}\n`
        });
        return true;
    } else if (command === '!watch:check' && isGroupOwner) {
        const targets = await fetchTargets();
        const msg = targets.length > 0 ?
            `対象: ${targets.map(d => gTrunc(d.id, 8)).join(', ')}` :
            '見守り対象者はいません。';
        await client.replyMessage(event.replyToken, {
            type: 'text',
            text: msg
        });
        return true;
    } else if (command === '!watch:run' && isGroupOwner) {
        await client.replyMessage(event.replyToken, {
            type: 'text',
            text: '見守りチェックを開始します。'
        });
        await checkAndSendPing();
        return true;
    } else if (command.startsWith('!watch:group') && isGroupOwner) {
        const [, gid] = command.split(/\s+/);
        await setActiveWatchGroupId(gid);
        await client.replyMessage(event.replyToken, {
            type: 'text',
            text: `見守りグループIDを ${gid ||
                '（なし）'} に設定しました。`
        });
        return true;
    } else if (command === '!relay:stop' && isOwner) {
        const relayedUser = getRelayUser(userId);
        if (relayedUser) {
            deleteRelay(relayedUser);
            await client.replyMessage(event.replyToken, {
                type: 'text',
                text: 'リレーを終了しました。'
            });
            await safePush(relayedUser, {
                type: 'text',
                text: '支援員とのやりとりが終了しました。'
            });
            return true;
        }
    } else if (command === '!info' && isGroupOwner) {
        const WATCH_GROUP_ID = await getActiveWatchGroupId();
        const memberCount = await client.getGroupMemberCount(event.source.groupId).catch(() => null);
        await client.replyMessage(event.replyToken, {
            type: 'text',
            text: `WATCH_GROUP_ID: ${WATCH_GROUP_ID}\nBOT_ADMIN_IDS: ${BOT_ADMIN_IDS.join(',')}\nOWNER_USER_ID: ${gTrunc(OWNER_USER_ID, 8)}\nグループメンバー数: ${memberCount || '不明'}`
        });
        return true;
    } else if (command.startsWith('!readd')) {
        const uid = command.split(' ')[1];
        if (uid && isOwner) {
            await db.collection('users').doc(uid).set({
                deletedAt: null
            }, { merge: true });
            await client.replyMessage(event.replyToken, {
                type: 'text',
                text: `ユーザー ${gTrunc(uid, 8)} を再登録しました。`
            });
            return true;
        }
    } else if (command.startsWith('!delete')) {
        const uid = command.split(' ')[1];
        if (uid && isOwner) {
            await db.collection('users').doc(uid).set({
                deletedAt: Timestamp.now()
            }, { merge: true });
            await client.replyMessage(event.replyToken, {
                type: 'text',
                text: `ユーザー ${gTrunc(uid, 8)} を削除しました。`
            });
            return true;
        }
    }
    return false;
};
// 履歴の取得
const fetchHistory = async (userId) => {
    const history = await db.collection('users').doc(userId).collection('history')
        .orderBy('timestamp', 'desc').limit(20).get();
    return history.docs.map(d => d.data()).reverse();
};
async function callOpenAIChat(model, messages, timeoutMs = 12000, options = {}) {
    const openai = new OpenAI({ apiKey: OPENAI_API_KEY, httpAgent, httpsAgent });
    const { maxRetries = 0, baseDelayMs = 0 } = options;
    const req = async (attempt = 0) => {
        try {
            return await openai.chat.completions.create({
                model, messages, temperature: 0.7, max_tokens: 500
            }, { timeout: timeoutMs });
        } catch (e) {
            if (attempt < maxRetries) {
                const delay = baseDelayMs * Math.pow(2, attempt) + (Math.random() * baseDelayMs);
                console.log(`[RETRY] Attempt ${attempt + 1}/${maxRetries} after ${delay}ms`);
                await new Promise(res => setTimeout(res, delay));
                return req(attempt + 1);
            }
            throw e;
        }
    };
    return req();
}

async function getCrisisResponse(text, is_danger, is_scam) {
    const promptUser = is_danger
        ? `ユーザー: ${text}\n状況: 自傷・いじめ・DVなどの恐れ。安心する言葉と今すぐできる一歩を。`
        : `ユーザー: ${text}\n状況: 詐欺の不安。落ち着かせ、支払わない/URL開かない/公式確認を優しく案内。`;
    let crisisText = '';

    if (OPENAI_API_KEY) {
        try {
            const crisis = await callOpenAIChat(
                GPT4O,
                [
                    { role: 'system', content: CRISIS_SYSTEM },
                    { role: 'user', content: promptUser }
                ],
                12000,
                { maxRetries: 3, baseDelayMs: 500 }
            );
            crisisText = (crisis.choices?.[0]?.message?.content || '').trim();
        } catch (e) {
            briefErr('crisis GPT-4o failed', e);
        }
    }

    if (crisisText) return gTrunc(crisisText, 100);

    return is_danger
        ? "とてもつらいね。死なないで。あなたは大切だよ🌸 今すぐ助けが要るなら下の連絡先を使ってね。"
        : "あやしい話かも。急がず確認してね🌸 困ったら下の案内を見てね。";
}

async function getAiResponse(userId, user, text, conversationHistory) {
    const finalMessages = [{ role: 'system', content: SYSTEM_INSTRUCTION_CHAT }, ...conversationHistory];
    const len = toGraphemes(text).length;

    if (len > 100 && OPENAI_API_KEY) {
        try {
            const c = await callOpenAIChat(GPT4O_MINI, finalMessages, 7000);
            let t = (c.choices?.[0]?.message?.content || '').trim();
            return { text: gTrunc(t, 100), used: 'gpt-4o-mini' };
        } catch (e) { briefErr('GPT-4o-mini failed', e); }
    }

    if (GEMINI_API_KEY) {
        try {
            const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
            const model = genAI.getGenerativeModel({ model: GEMINI_FLASH });
            const hist = finalMessages.map(m => m.role === 'system'
                ? null
                : (m.role === 'user'
                    ? { role: 'user', parts: [{ text: m.content }] }
                    : { role: 'model', parts: [{ text: m.content }] })
            ).filter(Boolean);
            const chat = model.startChat({ history: hist.slice(0, -1) });
            const res = await chat.sendMessage(finalMessages[finalMessages.length - 1].content);
            let t = (res.response?.text?.() || '').trim();
            return { text: gTrunc(t, 100), used: 'gemini-flash' };
        } catch (e) { briefErr('Gemini Flash failed', e); }
    }

    return { text: null, used: 'none' };
}
async function notifyOfficerDanger(userId, user) {
    try {
        const DEST = await getActiveWatchGroupId();
        const fallbackUser = OWNER_USER_ID || BOT_ADMIN_IDS[0] || '';
        const prof = (user.profile || {});
        const emerg = (user.emergency || {});

        const payload = [
            { type: 'text', text: `見守り対象者（${prof.name || prof.displayName || '—'}）から危険なメッセージを検知しました。` },
            buildWatcherFlex({
                title: '🚨危険ワード検知',
                name: prof.name || prof.displayName || '—',
                address: [prof.prefecture, prof.city, prof.line1, prof.line2].filter(Boolean).join(' '),
                selfPhone: prof.phone || '',
                kinName: emerg.contactName || '',
                kinPhone: emerg.contactPhone || '',
                userId
            })
        ];

        if (DEST && DEST.trim()) {
            console.log('[ALERT] Sending danger alert to WATCH_GROUP_ID:', DEST);
            await safePush(DEST, payload);
            audit('officer_alert_sent', { to: DEST, userId: userHash(userId) });
        } else if (fallbackUser) {
            console.warn('[ALERT] WATCH_GROUP_ID missing. Falling back to OWNER_USER_ID.');
            await safePush(fallbackUser, payload);
            audit('officer_alert_fallback_user', { to: gTrunc(fallbackUser, 8), userId: userHash(userId) });
        } else {
            console.error('[ALERT] No destination configured for danger alerts.');
        }
    } catch (e) {
        briefErr('notifyOfficerDanger failed', e);
    }
}
// 履歴保存
const saveHistory = async (userId, userMessage, aiMessage) => {
    const historyRef = db.collection('users').doc(userId).collection('history');
    await historyRef.add({
        role: 'user',
        content: userMessage,
        timestamp: Timestamp.now()
    });
    if (aiMessage) {
        await historyRef.add({
            role: 'assistant',
            content: aiMessage,
            timestamp: Timestamp.now()
        });
    }
};
// 使用回数カウント
const updateUsageCount = async (userId, membership, todayJst) => {
    const usageRef = db.collection('usage').doc(todayJst);
    const userUsageRef = usageRef.collection('users').doc(userId);
    const isSubscriber = (membership === 'subscriber' || membership === 'admin');
    await db.runTransaction(async t => {
        const userDoc = await t.get(userUsageRef);
        const userUsage = userDoc.data() || {
            guestCount: 0,
            subscriberCount: 0
        };
        const update = isSubscriber ? {
            subscriberCount: firebaseAdmin.firestore.FieldValue.increment(1)
        } : {
            guestCount: firebaseAdmin.firestore.FieldValue.increment(1)
        };
        t.set(userUsageRef, update, {
            merge: true
        });
    });
};
const isAdmin = (uid) => BOT_ADMIN_IDS.includes(uid);
// === ログ/保存のポリシー ===
const SAVE_HISTORY_SCOPE = (process.env.SAVE_HISTORY_SCOPE || 'flagged').toLowerCase(); // 'flagged' | 'all' | 'none'  デフォルト: 危険/詐欺/不適切のみ保存
const AUDIT_NORMAL_CHAT = (process.env.AUDIT_NORMAL_CHAT || 'false') === 'true'; // trueなら通常会話も[AUDIT]出す（デフォfalse）
const THINKING_MESSAGE_ENABLED = (process.env.THINKING_MESSAGE_ENABLED || 'false') === 'true';
// イベントハンドラ
const handleEvent = async (event) => {
    if (event.type !== 'message' || event.message.type !== 'text') {
        return null;
    }
    const {
        replyToken
    } = event;
    const {
        userId
    } = event.source;
    const {
        text
    } = event.message;
    const todayJst = dayjs().tz(JST_TZ).format('YYYYMMDD');
    if (!userId) return null;

    const relayedUser = getRelayUser(userId);
    if (relayedUser) {
        await handleRelay(event, text);
        return null;
    }
    if (text.startsWith('!')) {
        const commandHandled = await handleCommand(event, text, userId);
        if (commandHandled) {
            return null;
        }
    }
    // 固定応答マップを最初にチェック
    for (const [re, msg] of specialRepliesMap.entries()) {
        if (re.test(text)) {
            await replyOrPush(replyToken, userId, { type: 'text', text: msg });
            return null;
        }
    }

    // ユーザー情報取得
    const userDoc = await db.collection('users').doc(userId).get();
    const user = userDoc.exists ? userDoc.data() : {};
    const flags = user.flags || {};
    const consultOncePending = !!flags.consultOncePending;
    // 相談トリガー（ひらがな・カタカナも拾う）
    const isConsultTrigger = CONSULT_TRIGGERS.some(re => re.test(text));
    // 相談→次の応答だけ Gemini Pro を使う
    if (isConsultTrigger && !consultOncePending) {
        await db.collection('users').doc(userId).set({
            flags: { ...flags, consultOncePending: true }
        }, { merge: true });
    }

    // ---- ここで危険/詐欺/不適切判定 ----
    const is_danger = isDangerMessage(text);
    const is_scam = isScamMessage(text);
    const is_inappropriate = isInappropriateMessage(text);
    // 監査ログは通常会話を出さない（必要なら環境変数でオン）
    if (is_danger || is_scam || is_inappropriate) {
        audit('flagged_message', { userId: userHash(userId), kind: is_danger ? 'danger' : is_scam ? 'scam' : 'inappropriate', text: sanitizeForLog(text) });
    } else if (AUDIT_NORMAL_CHAT) {
        audit('line_message', { userId: userHash(userId), text: sanitizeForLog(text) });
    }

    // 管理者かどうかのチェック
    const isAdminUser = isAdmin(userId);
    const membership = isAdminUser ? 'admin' : (user.membership || 'guest');
    const { dailyLimit, model } = MEMBERSHIP_CONFIG[membership];

    const t = text.trim();
    if (t === '見守り' || t === '見守りサービス' || t === '会員登録' || t === '登録' || t === 'とうろく') {
        await replyOrPush(replyToken, userId, {
            type: "flex",
            altText: "会員登録",
            contents: makeRegistrationButtonsFlex(userId)
        });
        return null;
    }

    if (user.deletedAt) {
        await replyOrPush(replyToken, userId, {
            type: 'text',
            text: '退会済みのためご利用いただけません。再開したい場合は運営までご連絡ください。'
        });
        return null;
    }
    const isWatchEnabled = user.watchService?.enabled;
    const watchOk = isWatchEnabled && (text.includes('OK') || text.includes('ok') || text.includes('おk') || text.includes('おっけー') || text.includes('大丈夫'));
    if (watchOk) {
        const ref = db.collection('users').doc(userId);
        const ws = user.watchService;
        const lastPingAt = ws?.lastPingAt?.toDate?.() ? dayjs(ws.lastPingAt.toDate()) : null;
        if (ws?.awaitingReply && lastPingAt) {
            await scheduleNextPing(userId, lastPingAt);
            await replyOrPush(replyToken, userId, {
                type: 'text',
                text: 'OK、受け取ったよ！ありがとう！💖'
            });
            audit('watch_ok', {
                userId: userHash(userId)
            });
            return null;
        }
    } else if (isWatchEnabled && user.watchService.awaitingReply) {
        await safePush(userId, {
            type: 'text',
            text: 'OK、受け取ったよ！ありがとう！💖'
        });
        await scheduleNextPing(userId, new Date());
        return null;
    }
    // 危険語、詐欺ワード、不適切な言葉のチェック
    if (is_danger || is_scam || is_inappropriate) {
        const crisisText = await getCrisisResponse(text, is_danger, is_scam);
        const base = is_danger ? DANGER_REPLY : (is_scam ? SCAM_REPLY : INAPPROPRIATE_REPLY);
        const out = [{ type: 'text', text: crisisText }, ...base.slice(1)];

        await replyOrPush(replyToken, userId, out);

        if (!isAdminUser && isWatchEnabled && is_danger) {
            await notifyOfficerDanger(userId, user);
        }

        const shouldSave = SAVE_HISTORY_SCOPE === 'all' || (SAVE_HISTORY_SCOPE === 'flagged' && (is_danger || is_scam || is_inappropriate));
        if (shouldSave) {
            await saveHistory(userId, text, Array.isArray(out) ? (out[0]?.text || '') : (out.text || ''));
        }
        await updateUsageCount(userId, membership, todayJst);
        return null;
    }
    // 回数制限のチェック
    const isSubscriber = (membership === 'subscriber' || membership === 'admin');
    const isMember = (membership === 'member' || isSubscriber);
    const isGuest = membership === 'guest';
    const userUsage = await db.collection('usage').doc(todayJst).collection('users').doc(userId).get();
    const count = userUsage.exists ? (isMember ? userUsage.data().subscriberCount : userUsage.data().guestCount) : 0;
    const hasCountLimit = (dailyLimit !== -1);
    const isOverLimit = hasCountLimit && (count >= dailyLimit);

    if (isOverLimit && !isAdminUser) {
        await replyOrPush(replyToken, userId, {
            type: 'text',
            text: `ごめんね、今日はもうお話できないみたい…\nまた明日話しかけてね🌸`
        });
        return null;
    }
    if (!is_danger && !is_scam && !is_inappropriate && !consultOncePending) {
        if (THINKING_MESSAGE_ENABLED && canSendThinking(userId)) {
            await safePush(userId, { type: "text", text: "いま一生けんめい考えてるよ…もう少しだけ待っててね🌸" });
        }
    }
    const history = await fetchHistory(userId);
    history.push({
        role: 'user',
        content: text
    });
    const aiResponse = await getAiResponse(userId, user, text, history, { consultOncePending });

    if (aiResponse && aiResponse.text) {
        let t = aiResponse.text;
        if (!t) t = "ごめんね、今は少し疲れてるみたい…また後で話しかけてね🌸";
        await replyOrPush(replyToken, userId, {
            type: 'text',
            text: t
        });
        const shouldSave = SAVE_HISTORY_SCOPE === 'all' || (SAVE_HISTORY_SCOPE === 'flagged' && (is_danger || is_scam || is_inappropriate));
        if (shouldSave) {
            await saveHistory(userId, text, t);
        }
        await updateUsageCount(userId, membership, todayJst);
        // 相談モードだったら1回でオフに戻す
        if (consultOncePending) {
            const userRef = db.collection('users').doc(userId);
            await userRef.set({ flags: { ...(user.flags || {}), consultOncePending: false } }, { merge: true });
        }
    } else {
        if (canSendError(userId)) {
            await replyOrPush(replyToken, userId, { type: "text", text: "ごめんね、今は少し疲れてるみたい…また後で話しかけてね🌸" });
        }
    }
};

const replyOrPush = async (replyToken, userId, message) => {
    try {
        await client.replyMessage(replyToken, message);
    } catch (e) {
        const detail = e.originalError?.response?.data || e.response?.data || e.message;
        const status = e.statusCode || e.response?.status;
        if (status === 400 && String(detail).includes('invalid replyToken')) {
            console.warn(`[WARN] Invalid replyToken, attempting push to ${gTrunc(userId, 8)}`);
            await safePush(userId, message);
        } else {
            briefErr('replyMessage failed', e);
        }
    }
};

app.post('/webhook', middleware({
    channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
    channelSecret: LINE_CHANNEL_SECRET,
}), async (req, res) => {
    // 先にACKしてreplyToken失効やLINEのリトライを防ぐ
    res.status(200).end();
    // 失敗しても全体は止めない
    await Promise.all(req.body.events.map(e =>
        handleEvent(e).catch(err => briefErr('handleEvent failed', err))
    ));
});
app.get('/', (req, res) => {
    res.send('こころちゃんサーバーが起動しています。');
});
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
