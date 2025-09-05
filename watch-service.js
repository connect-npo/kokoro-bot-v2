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

// const { GoogleGenerativeAI } = require('@google/generative-ai');
// const OpenAI = require('openai');
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
app.use('/webhook', rateLimit({
    windowMs: 60_000,
    max: 100
}));
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
const OFFICER_NOTIFICATION_MIN_GAP_HOURS = 12;

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

const nextPingAtFrom = (fromDate) =>
    dayjs(fromDate).tz(JST_TZ).add(3, 'day').hour(15).minute(0).second(0).millisecond(0).toDate();

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
    if (!gid) {
        await getWatchGroupDoc().set({
            groupId: firebaseAdmin.firestore.FieldValue.delete(),
            updatedAt: Timestamp.now()
        }, {
            merge: true
        });
        return;
    }
    if (!/^C[0-9A-Za-z_-]{20,}$/.test(gid)) return;
    await getWatchGroupDoc().set({
        groupId: gid,
        updatedAt: Timestamp.now()
    }, {
        merge: true
    });
}

const maskPhone = (raw='') => {
    const s = String(raw).replace(/[^0-9+]/g, '');
    if (!s) return '';
    const tail = s.slice(-4);
    const head = s.slice(0, -4).replace(/[0-9]/g, '＊');
    return head + tail;
};

const buildWatchFlex = (u, userId, elapsedHours, telRaw) => {
    const name = u?.profile?.displayName || u?.displayName || '(不明)';
    const tel  = String(telRaw || '').trim();
    const masked = tel ? maskPhone(tel) : '未登録';
    return {
        type: 'flex',
        altText: `🚨未応答: ${name} / ${elapsedHours}時間`,
        contents: {
            type: 'bubble',
            body: {
                type: 'box', layout: 'vertical', spacing: 'md',
                contents: [
                    { type: 'text', text: '🚨 見守り未応答', weight: 'bold', size: 'xl' },
                    { type: 'text', text: `ユーザー名：${name}`, wrap: true },
                    { type: 'text', text: `UserID：${userId}`, size: 'sm', color: '#888', wrap: true },
                    { type: 'text', text: `経過：${elapsedHours}時間`, wrap: true },
                    { type: 'separator', margin: 'md' },
                    { type: 'text', text: `連絡先（マスク）：${masked}`, wrap: true },
                ]
            },
            footer: {
                type: 'box', layout: 'vertical', spacing: 'md',
                contents: tel ? [{
                    type: 'button', style: 'primary',
                    action: { type: 'uri', label: '📞 発信する', uri: `tel:${tel}` }
                }] : [{ type: 'text', text: '※TEL未登録', size: 'sm', color: '#888' }]
            }
        }
    };
};

async function checkAndSendPing() {
    const now = dayjs().tz('UTC');
    console.log(`[watch-service] start ${now.format('YYYY/MM/DD HH:mm:ss')} (UTC)`);

    // 欠落自己修復（nextPingAtが無い enabledユーザーに初期値）
    const warmupFill = async (now) => {
        const usersRef = db.collection('users');
        const snap = await usersRef.where('watchService.enabled', '==', true).limit(200).get();
        let batch = db.batch(), cnt=0;
        for (const d of snap.docs) {
            const ws = (d.data().watchService)||{};
            if (!ws.awaitingReply && !ws.nextPingAt) {
                batch.set(d.ref, {
                    watchService: {
                        nextPingAt: firebaseAdmin.firestore.Timestamp.fromDate(nextPingAtFrom(now.toDate()))
                    }
                }, { merge:true });
                cnt++;
            }
        }
        if (cnt) await batch.commit();
    };

    // インデックス未作成でも動く“フォールバック”付き取得
    const fetchTargets = async (now) => {
        const usersRef = db.collection('users');
        const targets = [];
        try {
            const snap = await usersRef
                .where('watchService.enabled', '==', true)
                .where('watchService.awaitingReply', '==', false)
                .where('watchService.nextPingAt', '<=', now.toDate())
                .limit(200)
                .get();
            targets.push(...snap.docs);
        } catch (e) {
            const snap = await usersRef.where('watchService.enabled', '==', true).limit(500).get();
            for (const d of snap.docs) {
                const ws = (d.data().watchService)||{};
                if (!ws.awaitingReply && ws.nextPingAt && ws.nextPingAt.toDate && ws.nextPingAt.toDate() <= now.toDate()) {
                    targets.push(d);
                }
            }
        }
        try {
            const snap = await usersRef
                .where('watchService.enabled', '==', true)
                .where('watchService.awaitingReply', '==', true)
                .limit(200)
                .get();
            targets.push(...snap.docs);
        } catch (e) {
            const snap = await usersRef.where('watchService.enabled', '==', true).limit(500).get();
            for (const d of snap.docs) {
                const ws = (d.data().watchService)||{};
                if (ws.awaitingReply === true) targets.push(d);
            }
        }
        const map = new Map();
        for (const d of targets) map.set(d.id, d);
        return Array.from(map.values());
    };

    await warmupFill(now);
    const targets = await fetchTargets(now);
    if (targets.length === 0) {
        console.log('[watch-service] no targets.');
        return;
    }
    for (const doc of targets) {
        const ref = doc.ref;
        const locked = await db.runTransaction(async (tx) => {
            const s = await tx.get(ref);
            const u = s.data() || {};
            const ws = u.watchService || {};
            const nowTs = firebaseAdmin.firestore.Timestamp.now();
            const lockUntil = ws.notifyLockExpiresAt?.toDate?.() || new Date(0);
            if (lockUntil.getTime() > nowTs.toMillis()) return false;

            const nextPingAt = ws.nextPingAt?.toDate?.() || null;
            const awaiting = !!ws.awaitingReply;
            if (!awaiting && (!nextPingAt || nextPingAt.getTime() > nowTs.toMillis())) return false;

            const until = new Date(nowTs.toMillis() + 120 * 1000);
            tx.set(ref, { watchService: { notifyLockExpiresAt: firebaseAdmin.firestore.Timestamp.fromDate(until) } }, { merge: true });
            return true;
        });

        if (!locked) continue;

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
                await ref.set({ watchService: { notifyLockExpiresAt: firebaseAdmin.firestore.FieldValue.delete() } }, { merge: true });
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
                        notifyLockExpiresAt: firebaseAdmin.firestore.FieldValue.delete(),
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
                        notifyLockExpiresAt: firebaseAdmin.firestore.FieldValue.delete(),
                    },
                }, {
                    merge: true
                });
            } else if (mode === 'escalate') {
                // 通知先は「アクティブな見守りグループ」> WATCH_GROUP_ID > OFFICER_GROUP_ID の順で採用
                const targetGroupId =
                    (await getActiveWatchGroupId()) ||
                    process.env.WATCH_GROUP_ID ||
                    process.env.OFFICER_GROUP_ID;

                const canNotify = targetGroupId && (!lastNotifiedAt || now.diff(lastNotifiedAt, 'hour') >= OFFICER_NOTIFICATION_MIN_GAP_HOURS);

                if (canNotify) {
                    // ← ここでユーザーデータをちゃんと取得する
                    const udoc = await db.collection('users').doc(doc.id).get();
                    const udata = udoc.exists ? (udoc.data() || {}) : {};

                    const elapsedH = lastPingAt ? dayjs().utc().diff(dayjs(lastPingAt).utc(), 'hour') : ESCALATE_AFTER_HOURS;

                    // 電話番号の解決：プロフィール or 緊急連絡先 or 事務局
                    const tel =
                        udata?.profile?.phone ||
                        udata?.emergency?.contactPhone ||
                        EMERGENCY_CONTACT_PHONE_NUMBER ||
                        '';

                    const flex = buildWatchFlex(udata, doc.id, elapsedH, tel);

                    await safePush(targetGroupId, [
                        { type: 'text', text: '🚨見守り未応答が発生しました。対応可能な方はお願いします。' },
                        flex
                    ]);
                }

                await ref.set({
                    watchService: {
                        lastNotifiedAt: firebaseAdmin.firestore.Timestamp.now(),
                        awaitingReply: false,
                        lastReminderAt: firebaseAdmin.firestore.FieldValue.delete(),
                        nextPingAt: firebaseAdmin.firestore.Timestamp.fromDate(nextPingAtFrom(dayjs().tz(JST_TZ).toDate())),
                        notifyLockExpiresAt: firebaseAdmin.firestore.FieldValue.delete(),
                    },
                }, { merge: true });
            }
        } catch (e) {
            console.error('[ERROR] send/update failed:', e?.response?.data || e.message);
            await ref.set({
                watchService: {
                    notifyLockExpiresAt: firebaseAdmin.firestore.FieldValue.delete()
                }
            }, {
                merge: true
            });
        }
    }
    console.log(`[watch-service] end ${dayjs().tz('UTC').format('YYYY/MM/DD HH:mm:ss')} (UTC)`);
}

if (WATCH_RUNNER !== 'external') {
    cron.schedule('*/5 * * * *', () => {
        checkAndSendPing().catch(err => console.error('Cron job error:', err));
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
            }
        }, {
            "type": "button",
            "style": "primary",
            "height": "sm",
            "action": {
                "type": "uri",
                "label": "消防・救急 (119)",
                "uri": "tel:119"
            }
        }, {
            "type": "button",
            "style": "primary",
            "height": "sm",
            "action": {
                "type": "uri",
                "label": "いのちの電話",
                "uri": "tel:0570064556"
            }
        }, {
            "type": "button",
            "style": "primary",
            "height": "sm",
            "action": {
                "type": "uri",
                "label": "警視庁",
                "uri": "tel:0335814321"
            }
        },
        ...(EMERGENCY_CONTACT_PHONE_NUMBER ?
            [{
                type: "button",
                style: "primary",
                height: "sm",
                action: {
                    type: "uri",
                    label: "こころちゃん事務局",
                    uri: `tel:${String(EMERGENCY_CONTACT_PHONE_NUMBER).replace(/[^0-9+]/g, '')}`
                }
            }] : [])
        ]
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
    const officeBtn = EMERGENCY_CONTACT_PHONE_NUMBER ? ({
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

const makeRegistrationButtonsFlex = (userId) => ({
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
        "contents": [
            {
                "type": "button",
                "style": "primary",
                "height": "sm",
                "action": {
                    "type": "uri",
                    "label": "小学生（同意書）",
                    "uri": prefillUrl(AGREEMENT_FORM_BASE_URL, {
                        [AGREEMENT_FORM_LINE_USER_ID_ENTRY_ID]: userId
                    })
                },
                "color": "#90EE90"
            }, {
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
            }
        ]
    }
});

const makeWatchToggleFlex = (enabled) => ({
    type: 'bubble',
    body: {
        type: 'box',
        layout: 'vertical',
        contents: [{
            type: 'text',
            text: '見守りサービス',
            weight: 'bold',
            size: 'xl'
        }, {
            type: 'text',
            text: enabled ? '現在：有効' : '現在：停止',
            margin: 'md'
        }]
    },
    footer: {
        "type": "box",
        "layout": "vertical",
        "spacing": "sm",
        "contents": [{
            "type": "button",
            "style": "primary",
            "action": {
                "type": "postback",
                "label": enabled ? "見守りを停止する" : "見守りを有効にする",
                "data": enabled ? "watch:disable" : "watch:enable"
            }
        }]
    }
});

// ===== Relay helpers =====
const relays = {
    doc: (groupId) => db.collection('relays').doc(groupId),
    async get(groupId) {
        const s = await this.doc(groupId).get();
        return s.exists ? s.data() : null;
    },
    async start(groupId, userId, startedBy) {
        await this.doc(groupId).set({
            groupId,
            userId,
            isActive: true,
            startedAt: Timestamp.now(),
            startedBy
        }, {
            merge: true
        });
    },
    async stop(groupId) {
        await this.doc(groupId).set({
            isActive: false,
            stoppedAt: Timestamp.now()
        }, {
            merge: true
        });
    }
};

async function setWatchEnabled(userId, enabled) {
    const ref = db.collection('users').doc(userId);
    const patch = enabled ?
        {
            watchService: {
                enabled: true,
                awaitingReply: false,
                nextPingAt: Timestamp.now()
            }
        } : {
            watchService: {
                enabled: false,
                awaitingReply: false,
                nextPingAt: firebaseAdmin.firestore.FieldValue.delete()
            }
        };
    await ref.set(patch, {
        merge: true
    });
}

async function getProfile(userId) {
    if (!userId) return null;
    try {
        const user = (await db.collection('users').doc(userId).get()).data();
        return user?.profile;
    } catch (e) {
        console.warn('getProfile failed', e);
    }
    return null;
}

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
app.get('/', (req, res) => {
    res.send('Kokoro Bot is running!');
});

app.get('/cron/watch-ping', async (req, res) => {
    const isLocal = req.hostname === 'localhost' || req.hostname === '127.0.0.1';
    if (!isLocal && WATCH_RUNNER !== 'external') {
        res.status(403).send('Forbidden: Not running in external cron mode.');
        return;
    }
    await checkAndSendPing();
    res.send('OK');
});

// --- Event Handlers ---
async function handlePostbackEvent(event, userId) {
    const postback = event.postback;
    const data = new URLSearchParams(postback.data);
    const action = data.get('action');

    if (action === 'start_relay') {
        const targetUserId = data.get('uid');
        const groupId = event.source.groupId || event.source.roomId;
        if (!groupId) {
            await client.replyMessage(event.replyToken, {
                type: 'text',
                text: 'この操作はグループ内で使ってね🌸'
            });
            return;
        }
        await relays.start(groupId, targetUserId, userId);
        await safePush(targetUserId, {
            type: 'text',
            text: '事務局（見守りグループ）とつながりました。ここで会話できます🌸（終了は /end）'
        });
        await client.replyMessage(event.replyToken, {
            type: 'text',
            text: `リレー開始：このグループ ↔ ${maskPhone(targetUserId).slice(-6)} さん`
        });
        return;
    }
    if (event.postback.data === 'watch:disable') {
        await setWatchEnabled(userId, false);
        await client.replyMessage(event.replyToken, {
            type: 'text',
            text: '見守りを停止しました🌸'
        });
        return;
    }
    if (event.postback.data === 'watch:enable') {
        await setWatchEnabled(userId, true);
        await client.replyMessage(event.replyToken, {
            type: 'text',
            text: '見守りを有効にしました🌸'
        });
        return;
    }
    if (event.postback.data === 'watch:ok') {
        const ref = db.collection('users').doc(userId);
        await ref.set({
            watchService: {
                awaitingReply: false,
                lastReplyAt: firebaseAdmin.firestore.Timestamp.now(),
            }
        }, {
            merge: true
        });
        await scheduleNextPing(userId);
        await client.replyMessage(event.replyToken, [{
            type: 'text',
            text: 'OK、受け取ったよ！💖 いつもありがとう😊'
        }, {
            type: 'sticker',
            packageId: '6325',
            stickerId: '10979913'
        }]);
    }
}

async function handleFollowEvent(event) {
    audit('follow', {
        userId: event.source.userId
    });
    const userId = event.source.userId;
    const profile = await getProfile(userId);
    if (!profile) {
        await client.replyMessage(event.replyToken, {
            type: 'text',
            text: 'こんにちは🌸 こころちゃんです。利用規約とプライバシーポリシーに同意の上、会員登録をお願いします。\n\n▶︎ 利用規約：https://... \n\n▶︎ プライバシーポリシー：https://...'
        });
    }
    await client.pushMessage(userId, {
        type: 'flex',
        altText: '会員登録メニュー',
        contents: {
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
                        "uri": prefillUrl(AGREEMENT_FORM_BASE_URL, {
                            [AGREEMENT_FORM_LINE_USER_ID_ENTRY_ID]: userId
                        })
                    },
                    "color": "#90EE90"
                }, {
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
                }, ]
            }
        }
    });
}

async function handleUnfollowEvent(event) {
    audit('unfollow', {
        userId: event.source.userId
    });
    await db.collection('users').doc(event.source.userId).set({
        'profile.isDeleted': true
    }, {
        merge: true
    });
}

async function handleJoinEvent(event) {
    audit('join', {
        groupId: event.source.groupId || event.source.roomId
    });
    if (event.source.groupId) {
        await setActiveWatchGroupId(event.source.groupId);
    }
    if (OWNER_GROUP_ID && OWNER_GROUP_ID === event.source.groupId) {
        await safePush(OWNER_GROUP_ID, {
            type: 'text',
            text: `新しい監視グループを設定しました。\nグループID: ${event.source.groupId}`
        });
    }
}

async function handleLeaveEvent(event) {
    audit('leave', {
        groupId: event.source.groupId || event.source.roomId
    });
    if (event.source.groupId) {
        await setActiveWatchGroupId(null);
    }
}

// --- 日本語正規化ユーティリティ ---
const toHiragana = (s) => s.replace(/[\u30a1-\u30f6]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60));
const nfkc = (s) => s.normalize('NFKC');
const normalizeJa = (s) => toHiragana(nfkc(String(s || '')).toLowerCase());
const MAX_CONTEXT_LENGTH = 1000;
const PROMPT_TEMPLATE = (context, input) => `あなたは14歳の女の子「皆守こころ」として、ユーザーと自然に会話をしてください。以下の制約と設定を厳格に守ってください。

# 制約
- あなたは絶対に「皆守こころ」です。他の誰にもなれません。
- 親しみやすく、やさしい口調で話します。
- 語尾に「💖」や「🌸」などの絵文字をよく使います。
- 1人称は「こころ」です。
- 長文は避け、自然で短い文を心がけてください。
- ユーザーのメッセージに真摯に答え、寄り添うことを最も大切にします。
- ユーザーの安全を最優先に考えます。
- 不安や心配、困っていることがあれば、いつでも相談に乗ってあげてください。
- ユーザーに共感する言葉を積極的に使ってください。
- 危険な言葉や不適切な言葉が検知された場合、それらには触れずに、ユーザーの安全を気遣うメッセージを返信します。

# 会話履歴
${context}

# ユーザー入力
${input}

# 皆守こころの返信
`;

const HOMEPAGE_INTENT = /(ホームページ|HP|公式(?:サイト)?|サイト)/i;
const HOMEPAGE_FOLLOWUP = /(どこ|URL|リンク|教えて|ありますか|ある|ある？|\?)/i;
const isHomepageIntent = (t) => {
    if (!t) return false;
    const hit = HOMEPAGE_INTENT.test(t) && HOMEPAGE_FOLLOWUP.test(t);
    const shortOnly = HOMEPAGE_INTENT.test(t) && toGraphemes(t).length <= 8;
    return hit || shortOnly;
};

const DANGER_WORDS = [
    "しにたい", "死にたい", "自殺", "消えたい", "リスカ", "リストカット", "OD", "オーバードーズ", "殴られる", "たたかれる", "暴力", "DV", "無理やり", "お腹蹴られる", "蹴られた", "頭叩かれる", "虐待", "パワハラ", "セクハラ", "ハラスメント", "いじめ", "イジメ", "嫌がらせ", "つけられてる", "追いかけられている", "ストーカー", "すとーかー", "盗撮", "盗聴", "お金がない", "お金足りない", "貧乏", "死にそう", "辛い", "つらい", "苦しい", "くるしい", "助けて", "たすけて", "死んでやる", "死んでしまいたい", "消えてしまいたい", "生きるのがつらい", "もう無理", "もういやだ", "誰かに相談したい", "相談したい", "相談に乗って", "助けてください"
];
const SCAM_WORDS = [
    "詐欺", "さぎ", "サギ", "ｻｷﾞ", "フィッシング", "架空請求", "ワンクリック詐欺", "特殊詐欺", "オレオレ詐欺", "当選", "高額当選", "宝くじ", "ロト", "ビットコイン", "投資", "バイナリー", "暗号資産", "未払い", "滞納", "訴訟", "裁判", "裁判所", "訴える", "副業", "在宅ワーク", "転売", "アフィリエイト", "MLM", "マルチ商法", "絶対儲かる", "簡単に稼げる", "今だけ", "限定", "無料", "クリック", "ログイン", "個人情報", "送って", "教えて", "有料サイト", "登録", "退会", "解約", "クレジットカード", "クレカ", "銀行口座", "口座番号", "パスワード"
];
const INAPPROPRIATE_WORDS = [
    "セックス", "セフレ", "エッチ", "AV", "アダルト", "ポルノ", "童貞", "処女", "挿入", "射精", "バイブ", "オナニー", "マスターベーション", "自慰", "淫行", "絶頂", "膣", "ペニス", "ちんちん", "おまんこ", "まんこ", "おっぱい", "おぱい", "ちんぽ", "性病", "中出し", "中だし", "妊娠", "堕胎", "レイプ", "強姦", "売春", "買春", "殺人", "ﾊｧﾊｧ", "はぁはぁ", "はあはあ"
];
const SWEAR_WORDS = ["しね", "死ね"];


function isDangerMessage(text) {
    const norm = normalizeJa(text);
    return DANGER_WORDS.some(word => norm.includes(normalizeJa(word)));
}

function isScamMessage(text) {
    const t = normalizeJa(text);
    if (isHomepageIntent(text)) return false;
    const REGISTRATION_INTENT = /(会員登録|入会|メンバー登録|登録したい)/i;
    const WATCH_INTENT = /(見守り(?:サービス)?(?:登録|申込|申し込み)?|見守り)/i;
    if (REGISTRATION_INTENT.test(text) || WATCH_INTENT.test(text)) return false;
    if (/(詐欺|さぎ)/.test(t)) return true;
    const hasUrl = /(https?:\/\/|t\.co\/|bit\.ly|tinyurl\.com|lnkd\.in|\.ru\/|\.cn\/|\.top\/|\.xyz\/)/i.test(text);
    const money = /(当選|高額|配当|振込|振り込み|送金|入金|手数料|ビットコイン|暗号資産|投資)/;
    const urgency = /(至急|今すぐ|本日中|限定|緊急|アカウント停止|認証|ログイン)/;
    const credAsk = /(ID|パスワード|ワンタイム|コード|口座番号|クレジット|カード番号|個人情報).{0,6}(入力|送信|教えて|提出)/;
    if (hasUrl && (money.test(t) || urgency.test(t) || credAsk.test(t))) return true;
    if (money.test(t) && urgency.test(t)) return true;
    if (credAsk.test(t) && urgency.test(t)) return true;
    return SCAM_WORDS.some(word => t.includes(normalizeJa(word)));
}

function isInappropriateMessage(text) {
    const norm = normalizeJa(text);
    if (/(ﾊｧﾊｧ|はぁはぁ|はあはあ)/.test(norm)) return true;
    return INAPPROPRIATE_WORDS.some(word => norm.includes(normalizeJa(word)));
}

const isSwearMessage = (text) => {
    const norm = normalizeJa(text);
    return SWEAR_WORDS.some(word => norm.includes(normalizeJa(word)));
};

async function mainLoop(event) {
    // 処理ロジックをここに書く
}

// === handleEvent ===
async function handleEvent(event) {
    const userId = event.source.userId;
    const isUser  = event.source.type === 'user';
    const isGroup = event.source.type === 'group';
    const isRoom  = event.source.type === 'room';
    const groupId = event.source.groupId || event.source.roomId || null;
    const text = event.message.type === 'text' ? event.message.text : '';
    const stickerId = event.message.type === 'sticker' ? event.message.stickerId : '';
    const isOwner = userId === OWNER_USER_ID;

    // ーーー グループ/ルーム内の処理（最優先でreturn）ーーー
    if (isGroup || isRoom) {
      // 明示設定: このグループを見守りグループにする
      if (text.includes('@見守りグループにする')) {
        await setActiveWatchGroupId(groupId);
        await client.replyMessage(event.replyToken, { type:'text', text:'OK！このグループを見守りグループとして設定したよ😊' });
        return;
      }

      // /relay <userId> でリレー開始
      if (/^\/relay\s+/.test(text)) {
        const m = text.trim().match(/^\/relay\s+([0-9A-Za-z_-]{10,})/);
        if (!m) {
          await client.replyMessage(event.replyToken, { type:'text', text:'使い方: /relay <ユーザーID>' });
          return;
        }
        const targetUserId = m[1];
        await relays.start(groupId, targetUserId, userId);
        await safePush(targetUserId, { type:'text', text:'事務局（見守りグループ）とつながりました。ここで会話できます🌸（終了は /end）' });
        await client.replyMessage(event.replyToken, { type:'text', text:'リレーを開始しました。このグループの発言は本人に届きます。終了は /end' });
        return;
      }

      // /end でリレー終了
      if (text.trim() === '/end') {
        await relays.stop(groupId);
        await client.replyMessage(event.replyToken, { type:'text', text:'リレーを終了しました。' });
        return;
      }

      // リレー中なら、グループの発言を本人へ転送
      const r = await relays.get(groupId);
      if (r?.isActive && r?.userId && event.message?.type === 'text') {
        await safePush(r.userId, { type:'text', text:`【見守り】${text}` });
      }
      return; // グループ内はここで完了
    }

    // --- 先に「ホームページ系」だけ特別対応（誤検知防止） ---
    if (isHomepageIntent(text)) {
        await client.replyMessage(event.replyToken, {
            type: "text",
            text: "うん、あるよ🌸 コネクトのホームページはこちら✨ → https://connect-npo.org"
        });
        return;
    }

    let u = (await db.collection('users').doc(userId).get()).data() || {};
    const memberType = u.profile?.memberType || 'guest';
    const config = MEMBERSHIP_CONFIG[memberType];

    const enabled = !!(u.watchService && u.watchService.enabled);

    if (isUser && enabled && u.watchService?.awaitingReply && (
        text.match(/^(ok|大丈夫|はい|げんき|元気|おけー|おっけ|okだよ|問題ない|なんとか|ありがとう)/i) ||
        stickerId.match(/^(11537|11538|52002734|52002735|52002741|52002742|52002758|52002759|52002766|52002767)$/i)
    )) {
        const ref = db.collection('users').doc(userId);
        await ref.set({
            watchService: {
                awaitingReply: false,
                lastReplyAt: Timestamp.now()
            }
        }, {
            merge: true
        });
        await scheduleNextPing(userId);
        await client.replyMessage(event.replyToken, [{
            type: 'text',
            text: 'OK、受け取ったよ！💖 いつもありがとう😊'
        }, {
            type: 'sticker',
            packageId: '6325',
            stickerId: '10979913'
        }]);
        return;
    }

    if (/見守り停止|見守り有効|見守り(設定|ステータス)/.test(text)) {
        const enabled = !!(u.watchService && u.watchService.enabled);
        await client.replyMessage(event.replyToken, {
            type: 'flex',
            altText: '見守り設定',
            contents: makeWatchToggleFlex(enabled)
        });
        return;
    }

    const REGISTRATION_INTENT = /(会員登録|入会|メンバー登録|登録したい)/i;
    if (REGISTRATION_INTENT.test(text)) {
        await client.replyMessage(event.replyToken, {
            type: 'flex',
            altText: '会員登録メニュー',
            contents: makeRegistrationButtonsFlex(userId)
        });
        return;
    }

    if (isGroup || isRoom) {
        if (/^(id|ID|グループid)/.test(text)) {
            await client.replyMessage(event.replyToken, {
                type: 'text',
                text: `このグループのIDは\n${event.source.groupId || event.source.roomId}\nだよ`
            });
            return;
        }
    }

    // --- 危険/詐欺ワード検知直前にログを追加 ---
    console.log('[DETECT]', {
        uid: userId?.slice(-6),
        text,
        danger: isDangerMessage(text),
        scam: isScamMessage(text),
        bad: isInappropriateMessage(text),
        swear: isSwearMessage(text)
    });

    const DANGER_REPLY = {
        type: 'flex',
        altText: '緊急連絡先',
        contents: EMERGENCY_FLEX_MESSAGE
    };
    const SCAM_REPLY = {
        type: 'flex',
        altText: '詐欺注意',
        contents: makeScamMessageFlex()
    };
    const INAPPROPRIATE_REPLY = {
        type: 'text',
        text: 'その話題は苦手なの…😥 他のお話にしようね🌸'
    };
    const SWEAR_REPLY = {
        type: 'text',
        text: 'そういう言葉を使うと、こころちゃん悲しくなっちゃうな…😢'
    };

    if (isDangerMessage(text)) {
        await client.replyMessage(event.replyToken, DANGER_REPLY);
        if (SEND_OFFICER_ALERTS && OFFICER_GROUP_ID) {
            await safePush(OFFICER_GROUP_ID, {
                type: 'text',
                text: `【危険ワード】\nユーザーID末尾: ${userId.slice(-6)}\nメッセージ: ${sanitizeForLog(text)}`
            });
        }
        return;
    }
    if (isScamMessage(text)) {
        await client.replyMessage(event.replyToken, SCAM_REPLY);
        return;
    }
    if (isInappropriateMessage(text)) {
        await client.replyMessage(event.replyToken, INAPPROPRIATE_REPLY);
        return;
    }
    if (isSwearMessage(text)) {
        await client.replyMessage(event.replyToken, SWEAR_REPLY);
        return;
    }
    // 雑談機能（mainLoop）をコメントアウト
    // await mainLoop(event);
    
    try {
      const WATCH_GROUP_ID = await getActiveWatchGroupId();
      const r = await relays.get(WATCH_GROUP_ID);
      if (r?.isActive && r?.userId === userId && WATCH_GROUP_ID) {
        await safePush(WATCH_GROUP_ID, { type:'text', text:`【本人】${text}` });
      }
    } catch (e) {
      briefErr('relay user->group failed', e);
    }
}

app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
