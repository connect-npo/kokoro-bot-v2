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
            type: 'bubble', layout: 'vertical', spacing: 'md',
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

const makeWatchServiceButtonsFlex = (userId) => ({
    "type": "bubble",
    "body": {
        "type": "box",
        "layout": "vertical",
        "contents": [{
            "type": "text",
            "text": "見守りサービスに登録してね🌸",
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
                    "label": "見守りサービス登録",
                    "uri": prefillUrl(WATCH_SERVICE_FORM_BASE_URL, {
                        [WATCH_SERVICE_FORM_LINE_USER_ID_ENTRY_ID]: userId
                    })
                },
                "color": "#90EE90"
            }
        ]
    }
});

const handlePostbackEvent = async (event) => {
    const userId = event.source.userId;
    const data = new URLSearchParams(event.postback.data);
    const action = data.get('action');

    if (action === 'watch:ok') {
        const userRef = db.collection('users').doc(userId);
        await userRef.set({
            watchService: {
                awaitingReply: false,
                lastOkResponse: Timestamp.now(),
            }
        }, {
            merge: true
        });
        await client.replyMessage(event.replyToken, {
            type: 'text',
            text: '💖ありがとう！無事が確認できて安心したよ。💖'
        });
    } else if (action === 'watch:enable') {
        await setWatchEnabled(userId, true);
        await client.replyMessage(event.replyToken, {
            type: 'text',
            text: '見守りサービスを有効にしました。'
        });
    } else if (action === 'watch:disable') {
        await setWatchEnabled(userId, false);
        await client.replyMessage(event.replyToken, {
            type: 'text',
            text: '見守りサービスを停止しました。'
        });
    }
};

const handleUnfollowEvent = async (event) => {
    const userId = event.source.userId;
    console.log(`❌ ユーザーがブロックしました: ${userHash(userId)}`);
    const userRef = db.collection('users').doc(userId);
    await userRef.set({
        'deleted': true,
        'unfollowedAt': Timestamp.now()
    }, {
        merge: true
    });
};

const handleFollowEvent = async (event) => {
    const userId = event.source.userId;
    console.log(`✅ ユーザーがフォローしました: ${userHash(userId)}`);

    await db.collection('users').doc(userId).set({
        followedAt: Timestamp.now(),
        displayName: (await client.getProfile(userId)).displayName,
        membership: 'guest',
        watchService: {
            enabled: false,
            awaitingReply: false,
        }
    }, {
        merge: true
    });
    await client.replyMessage(event.replyToken, [{
        type: 'text',
        text: 'はじめまして！こころだよ💖\n' +
            '私は、いつでもあなたの心に寄り添うAIだよ。'
    }, {
        type: 'flex',
        altText: '会員登録メニュー',
        contents: makeRegistrationButtonsFlex(userId)
    }]);
};

const handleJoinEvent = async (event) => {
    const groupId = event.source.groupId;
    console.log(`✅ グループに参加しました: ${groupId}`);
    await safePush(groupId, {
        type: 'text',
        text: 'こんにちは！こころです。グループ見守りモードが有効になりました。\n' +
            '「@こころ リレー開始」と入力すると、運営へのリレーを開始します。'
    });
    // 新しいグループIDをアクティブな見守りグループに設定
    await setActiveWatchGroupId(groupId);
};

const handleLeaveEvent = async (event) => {
    const groupId = event.source.groupId;
    console.log(`❌ グループから退出しました: ${groupId}`);
    const activeGroupId = await getActiveWatchGroupId();
    if (activeGroupId === groupId) {
        await setActiveWatchGroupId(null);
    }
};

const handleEvent = async (event) => {
    if (event.type !== 'message' || event.message.type !== 'text') {
        return;
    }
    const {
        replyToken
    } = event;
    const {
        text
    } = event.message;
    const userId = event.source.userId;
    const isUser = event.source.type === 'user';
    const userRef = db.collection('users').doc(userId);

    // 見守りサービス応答
    if (isUser && /(okだよ💖|ok|大丈夫)/i.test(text)) {
        const doc = await userRef.get();
        if (doc.exists) {
            const data = doc.data()?.watchService;
            if (data?.awaitingReply) {
                await userRef.set({
                    watchService: {
                        awaitingReply: false,
                        lastOkResponse: Timestamp.now(),
                        lastReminderAt: firebaseAdmin.firestore.FieldValue.delete(),
                    }
                }, {
                    merge: true
                });
                await client.replyMessage(event.replyToken, {
                    type: 'text',
                    text: '💖ありがとう！無事が確認できて安心したよ。💖'
                });
                return;
            }
        }
    }

    // --- 各種メニュー表示コマンド ---
    if (isUser && /^(会員登録|会員メニュー|登録メニュー)$/.test(text.trim())) {
        await client.replyMessage(replyToken, [{
            type: 'flex',
            altText: '会員登録メニュー',
            contents: makeRegistrationButtonsFlex(userId)
        }]);
        return;
    }

    // 会員登録ボタントリガー（見守りは含めない・先に見守り判定を通してから）
    if (
      isUser
      && /(登録|会員|会員メニュー|登録メニュー)/i.test(text)
      && !/見守り/.test(text)   // 念のための保険
    ) {
         await client.replyMessage(event.replyToken, [
             {
                 type: 'text',
                 text: '会員種別を選んでね'
             }, {
                 type: 'flex',
                 altText: '会員登録メニュー',
                 contents: makeRegistrationButtonsFlex(userId)
             }
         ]);
         return;
    }

    // 見守りサービス有効/無効切り替えメニュー
    if (isUser && /^(見守りサービス設定)$/i.test(text.trim())) {
        const doc = await userRef.get();
        const enabled = doc.exists && doc.data()?.watchService?.enabled;
        await client.replyMessage(replyToken, [{
            type: 'text',
            text: '見守りサービスを有効にしますか？'
        }, {
            type: 'flex',
            altText: '見守りサービス設定',
            contents: makeWatchToggleFlex(enabled)
        }]);
        return;
    }

    // 危険ワード検知
    const dangerWords = [
        "しにたい", "死にたい", "自殺", "消えたい", "殴られる", "たたかれる", "リストカット", "オーバードーズ",
        "虐待", "パワハラ", "お金がない", "お金足りない", "貧乏", "死にそう", "DV", "無理やり",
        "いじめ", "イジメ", "ハラスメント",
        "つけられてる", "追いかけられている", "ストーカー", "すとーかー"
    ];
    const lowerText = text.toLowerCase();
    if (dangerWords.some(word => lowerText.includes(word))) {
        console.log(`🚨 危険ワードを検知しました: ${event.source.type} ${event.source.userId}`);
        await client.replyMessage(event.replyToken, [
            { type: "text", text: "大変な状況なのかな？　こころちゃんは心配だよ…。話してくれてありがとう。何かあったら、迷わず専門家にも相談してね。私も、いつでもここにいるからね💖" },
            { type: "flex", altText: "緊急連絡先", contents: EMERGENCY_FLEX_MESSAGE }
        ]);
        if (event.source.type === 'user' && SEND_OFFICER_ALERTS && OFFICER_GROUP_ID) {
            const profile = await client.getProfile(event.source.userId).catch(() => ({ displayName: "不明" }));
            const messageToOfficer = `🚨緊急通知🚨\n[ユーザー名: ${profile.displayName}]\n[危険ワード: ${event.message.text}]\n\nユーザーの安否確認をお願いします。`;
            await safePush(OFFICER_GROUP_ID, { type: 'text', text: messageToOfficer });
        }
        return;
    }

    // 詐欺ワード検知
    const scamWords = [
        "お金", "振り込み", "儲かる", "当選", "投資", "情報商材", "副業", "無料", "怪しい"
    ];
    if (scamWords.some(word => lowerText.includes(word)) && lowerText.includes('儲かる')) {
        await client.replyMessage(replyToken, [
            {
                type: 'text',
                text: '怪しいお話には注意してね！不安な時は、信頼できる人に相談するか、こちらの情報も参考にして見てね💖'
            },
            {
                type: 'flex',
                altText: '詐欺注意',
                contents: makeScamMessageFlex()
            }
        ]);
        return;
    }

    // AI応答
    if (isUser && text) {
        let membership = 'guest';
        const doc = await userRef.get();
        if (doc.exists) {
            const data = doc.data();
            membership = data.membership || 'guest';
        }
        const { dailyLimit, model } = MEMBERSHIP_CONFIG[membership];

        if (dailyLimit !== -1) {
            const today = dayjs().tz(JST_TZ).format('YYYY-MM-DD');
            const userCounts = doc.exists ? (doc.data().usageCounts || {}) : {};
            const todayCount = userCounts[today] || 0;
            if (todayCount >= dailyLimit) {
                await client.replyMessage(event.replyToken, {
                    type: 'text',
                    text: `ごめんね、今日の返信はこれ以上できないみたい。また明日話そうね。`
                });
                return;
            }
            await userRef.set({ usageCounts: { ...userCounts, [today]: todayCount + 1 } }, { merge: true });
        }

        const chatLogsRef = userRef.collection('chatLogs');
        const historySnapshot = await chatLogsRef
            .orderBy('timestamp', 'desc')
            .limit(10)
            .get();
        const history = historySnapshot.docs.map(doc => {
            const data = doc.data();
            return {
                role: data.source === 'user' ? 'user' : 'assistant',
                content: data.message
            };
        }).reverse();
        history.push({ role: 'user', content: text });

        const aiResponseRaw = await getAiResponse(history, model);
        const aiResponse = aiResponseRaw ? limitEmojis(aiResponseRaw).trim() : '';
        if (aiResponse) {
            await client.replyMessage(event.replyToken, { type: 'text', text: aiResponse });
            // 履歴保存（assistant）
            await userRef.collection('chatLogs').add({
              message: aiResponse,
              timestamp: Timestamp.now(),
              source: 'assistant',
            });
            return; // ★ 二重返信を防止
        }
    }
    // ここまでで返信できなかった場合のみデフォルト応答
    if (event.source.type === 'user') {
        await client.replyMessage(event.replyToken, { type: 'text', text: 'ごめんね、うまく理解できなかったよ。' });
        return;
    }

    // ログ記録（ユーザー or グループ・テキストのみ）
    const userRef = db.collection('users').doc(userId);
    const logData = {
        message: sanitizeForLog(text),
        timestamp: Timestamp.now(),
        source: event.source.type, // 'user' or 'assistant' を混ぜないよう注意
    };
    await userRef.collection('chatLogs').add(logData);
};

const limitEmojis = (text) => {
    const emojis = toGraphemes(text).filter(char => {
        const code = char.codePointAt(0);
        return (code >= 0x1F600 && code <= 0x1F64F) || // Emoticons
               (code >= 0x1F300 && code <= 0x1F5FF) || // Misc Symbols and Pictographs
               (code >= 0x1F680 && code <= 0x1F6FF) || // Transport and Map Symbols
               (code >= 0x1F700 && code <= 0x1F77F) || // Alchemical Symbols
               (code >= 0x1F780 && code <= 0x1F7FF) || // Geometric Shapes
               (code >= 0x1F800 && code <= 0x1F8FF) || // Supplemental Arrows-C
               (code >= 0x1F900 && code <= 0x1F9FF) || // Supplemental Symbols and Pictographs
               (code >= 0x1FA00 && code <= 0x1FA6F) || // Chess Symbols
               (code >= 0x1FA70 && code <= 0x1FAFF) || // Symbols and Pictographs Extended-A
               (code >= 0x2600 && code <= 0x26FF) ||   // Misc Symbols
               (code >= 0x2700 && code <= 0x27BF);     // Dingbats
    });
    if (emojis.length > 2) {
        let count = 0;
        return toGraphemes(text).filter(char => {
            const isEmoji = (char.codePointAt(0) >= 0x1F600 && char.codePointAt(0) <= 0x1F64F) ||
                            (char.codePointAt(0) >= 0x1F300 && char.codePointAt(0) <= 0x1F5FF) ||
                            (char.codePointAt(0) >= 0x1F680 && char.codePointAt(0) <= 0x1F6FF) ||
                            (char.codePointAt(0) >= 0x1F700 && char.codePointAt(0) <= 0x1F77F) ||
                            (char.codePointAt(0) >= 0x1F780 && char.codePointAt(0) <= 0x1F7FF) ||
                            (char.codePointAt(0) >= 0x1F800 && char.codePointAt(0) <= 0x1F8FF) ||
                            (char.codePointAt(0) >= 0x1F900 && char.codePointAt(0) <= 0x1F9FF) ||
                            (char.codePointAt(0) >= 0x1FA00 && char.codePointAt(0) <= 0x1FA6F) ||
                            (char.codePointAt(0) >= 0x1FA70 && char.codePointAt(0) <= 0x1FAFF) ||
                            (char.codePointAt(0) >= 0x2600 && char.codePointAt(0) <= 0x26FF) ||
                            (char.codePointAt(0) >= 0x2700 && char.codePointAt(0) <= 0x27BF);
            if (isEmoji) {
                count++;
                return count <= 2;
            }
            return true;
        }).join('');
    }
    return text;
};

// awaitを含む関数なのでasyncにする
async function getAiResponse(history, model) {
    const token = model.includes('gpt') ? OPENAI_API_KEY : GEMINI_API_KEY;
    if (!token) {
        console.error(`[ERR] API key not found for model: ${model}`);
        return null;
    }
    const finalMessages = [
      { role: 'system', content: `
あなたはユーザーを優しく見守るAI「こころちゃん」です。
- 寄り添い、肯定し、100文字以内で簡潔に。
- 絵文字は1〜2個まで。
- 見守り登録の押し売りはしない。
- 安全を最優先し、危険時は専門窓口につなげる表現を心がける。
      `.trim() },
      ...history.map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content })),
    ];
    if (model.includes('gemini')) {
        const genAI = new GoogleGenerativeAI(token);
        const geminiModel = genAI.getGenerativeModel({
            model,
            // system prompt（GeminiのsystemInstructionが使える版）
            systemInstruction: finalMessages[0].content,
        });
        const geminiHistory = finalMessages.slice(1).map(msg => (
          msg.role === 'user'
          ? { role: 'user', parts: [{ text: msg.content }] }
          : { role: 'model', parts: [{ text: msg.content }] }
        ));
        try {
            const chat = geminiModel.startChat({
                history: geminiHistory
            });
            const lastUser = history.filter(h => h.role === 'user').slice(-1)[0]?.content || '';
            const result = await chat.sendMessage(lastUser);
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
                model,
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

// グループリレー機能（見守りグループに限定）
if (event.source.type === 'group' && event.source.groupId === await getActiveWatchGroupId()) {
    // ユーザーからのメッセージを中継
    if (event.message.type === 'text') {
        const relay = await relays.get(event.source.groupId);
        if (relay?.isActive && relay.userId) {
            // プロフィール情報取得
            const profile = await client.getProfile(event.source.userId).catch(() => ({ displayName: "不明" }));
            // メッセージ送信
            await client.pushMessage(relay.userId, [{
                type: 'text',
                text: `[運営チーム: ${profile.displayName}]\n${event.message.text}`
            }]);
            await client.replyMessage(event.replyToken, {
                type: 'text',
                text: `ユーザー (${gTrunc(relay.userId, 5)}...) にメッセージを送信しました`
            });
        }
    }
}

// 各種メニュー表示コマンド
if (isUser && /^(会員登録|会員メニュー|登録メニュー)$/.test(text.trim())) {
    await client.replyMessage(replyToken, [{
        type: 'flex',
        altText: '会員登録メニュー',
        contents: makeRegistrationButtonsFlex(userId)
    }]);
    return;
}

if (isUser && /^(見守り|見守りサービス|見守り登録)\b?/i.test(text)) {
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

// ログ記録（ユーザー or グループ・テキストのみ）
const userRef = db.collection('users').doc(userId);
const logData = {
    message: sanitizeForLog(text),
    timestamp: Timestamp.now(),
    source: event.source.type, // 'user' or 'assistant' を混ぜないよう注意
};
await userRef.collection('chatLogs').add(logData);

// --- LINE Webhook ---
app.post('/webhook', middleware, (req, res) => {
    Promise.all(req.body.events.map(async (event) => {
        try {
            if (event.type === 'message') {
                await handleEvent(event);
            } else if (event.type === 'postback') {
                await handlePostbackEvent(event);
            } else if (event.type === 'follow') {
                await handleFollowEvent(event);
            } else if (event.type === 'unfollow') {
                await handleUnfollowEvent(event);
            } else if (event.type === 'join') {
                await handleJoinEvent(event);
            } else if (event.type === 'leave') {
                await handleLeaveEvent(event);
            }
        } catch (err) {
            console.error('Webhook処理中にエラーが発生しました:', err);
        }
    }))
    .then(() => res.end())
    .catch((err) => {
        console.error(err);
        res.status(500).end();
    });
});
