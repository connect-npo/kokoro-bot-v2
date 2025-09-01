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
const WATCH_GROUP_ID = process.env.WATCH_GROUP_ID || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL;
const EMERGENCY_CONTACT_PHONE_NUMBER = process.env.EMERGENCY_CONTACT_PHONE_NUMBER;
const LINE_ADD_FRIEND_URL = process.env.LINE_ADD_FRIEND_URL;
const BOT_ADMIN_IDS = JSON.parse(process.env.BOT_ADMIN_IDS || '[]');
const OWNER_USER_ID = process.env.OWNER_USER_ID || BOT_ADMIN_IDS[0];
const OWNER_GROUP_ID = process.env.OWNER_GROUP_ID || null;
const WATCH_RUNNER = process.env.WATCH_RUNNER || 'internal';
const WATCH_LOG_LEVEL = (process.env.WATCH_LOG_LEVEL || 'info').toLowerCase();
// 強制通知方針：ゲートは使わない

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
    console.error(`[ERR] ${msg}:`, e.response?.data || e.message);
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
    try {
        await client.pushMessage(to, Array.isArray(messages) ? messages : [messages]);
    } catch (err) {
        console.error(`[ERROR] push to ${to} failed:`, err?.response?.data || err.message);
    }
}

async function fetchTargets() {
    const now = dayjs().utc();
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
            const ws = (d.data().watchService) || {};
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
            const ws = (d.data().watchService) || {};
            if (ws.awaitingReply === true) targets.push(d);
        }
    }
    const map = new Map();
    for (const d of targets) map.set(d.id, d);
    return Array.from(map.values());
}

async function warmupFill() {
    const now = dayjs().utc();
    const usersRef = db.collection('users');
    const snap = await usersRef.where('watchService.enabled', '==', true).limit(200).get();
    let batch = db.batch(),
        cnt = 0;
    for (const d of snap.docs) {
        const ws = (d.data().watchService) || {};
        if (!ws.awaitingReply && !ws.nextPingAt) {
            batch.set(d.ref, {
                watchService: {
                    nextPingAt: firebaseAdmin.firestore.Timestamp.fromDate(dayjs(now).tz(JST_TZ).add(PING_INTERVAL_DAYS, 'day').hour(15).minute(0).second(0).millisecond(0).toDate())
                }
            }, {
                merge: true
            });
            cnt++;
        }
    }
    if (cnt) await batch.commit();
}

const OFFICER_NOTIFICATION_MIN_GAP_HOURS = Number(process.env.OFFICER_NOTIFICATION_MIN_GAP_HOURS || 1);

const maskPhone = p => {
    const v = String(p || '').replace(/[^0-9+]/g, '');
    if (!v) return '—';
    return v.length <= 4 ? `**${v}` : `${'*'.repeat(Math.max(0, v.length - 4))}${v.slice(-4)}`;
};
const buildWatcherFlex = ({name='—', address='—', selfPhone='', kinName='', kinPhone='', userId}) => {
    const telBtn = p => p ? { type:'button', style:'primary',
      action:{ type:'uri', label:'本人に電話', uri:`tel:${p}` }} : null;
    const kinBtn = p => p ? { type:'button', style:'secondary',
      action:{ type:'uri', label:'近親者に電話', uri:`tel:${p}` }} : null;
  
    return {
      type:'flex', altText:'【見守りアラート】',
      contents:{
        type:'bubble',
        body:{ type:'box', layout:'vertical', spacing:'sm', contents:[
          { type:'text', text:'【見守りアラート】', weight:'bold' },
          { type:'text', text:`利用者：${name}`, wrap:true },
          { type:'text', text:`住所：${address || '—'}`, size:'sm', wrap:true },
          { type:'text', text:`本人TEL：${maskPhone(selfPhone)}`, size:'sm', color:'#777' },
          { type:'text', text:`近親者：${kinName || '—'}（${maskPhone(kinPhone)})`, size:'sm', color:'#777', wrap:true },
        ]},
        footer:{ type:'box', layout:'vertical', spacing:'sm', contents:[
          { type:'button', style:'primary',
            action:{ type:'postback', label:'LINEで連絡', data:`action=notify_user&uid=${encodeURIComponent(userId)}` }},
          ...(telBtn(selfPhone) ? [telBtn(selfPhone)] : []),
          ...(kinBtn(kinPhone) ? [kinBtn(kinPhone)] : []),
        ]}
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
                    const u = (await ref.get()).data() || {};
                    const prof = u.profile || {};
                    const emerg = u.emergency || {};
                    const address = [prof.prefecture, prof.city, prof.line1, prof.line2].filter(Boolean).join(' ');
                    await safePush(WATCH_GROUP_ID, buildWatcherFlex({
                        name,
                        address,
                        selfPhone,
                        kinName,
                        kinPhone,
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
            // すでに誰かが実行中
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
            "color": "#DD0000",
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
                "label": "警察 (電話)",
                "uri": "tel:110"
            },
            "color": "#FF4500"
        }, {
            "type": "button",
            "style": "primary",
            "height": "sm",
            "action": {
                "type": "uri",
                "label": "消防・救急 (電話)",
                "uri": "tel:119"
            },
            "color": "#FF6347"
        }, {
            "type": "button",
            "style": "primary",
            "height": "sm",
            "action": {
                "type": "uri",
                "label": "チャイルドライン (電話・チャット)",
                "uri": "https://childline.or.jp/tel"
            },
            "color": "#1E90FF"
        }, {
            "type": "button",
            "style": "primary",
            "height": "sm",
            "action": {
                "type": "uri",
                "label": "いのちの電話 (電話)",
                "uri": "tel:0570064556"
            },
            "color": "#32CD32"
        }, {
            "type": "button",
            "style": "primary",
            "height": "sm",
            "action": {
                "type": "uri",
                "label": "チャットまもるん(チャット)",
                "uri": "https://www.web-mamorun.com/"
            },
            "color": "#FFA500"
        }, {
            "type": "button",
            "style": "primary",
            "height": "sm",
            "action": {
                "type": "uri",
                "label": "警視庁(電話)",
                "uri": "tel:0335814321"
            },
            "color": "#FF4500"
        }, {
            "type": "button",
            "style": "primary",
            "height": "sm",
            "action": {
                "type": "uri",
                "label": "子供を守る声(電話)",
                "uri": `tel:${EMERGENCY_CONTACT_PHONE_NUMBER}`
            },
            "color": "#FFA500"
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
    const contents = [
        {
            type: "button",
            style: "primary",
            color: "#32CD32",
            action: { type: "uri", label: "国民生活センター", uri: "https://www.kokusen.go.jp/" }
        },
        {
            type: "button",
            style: "primary",
            color: "#FF4500",
            action: { type: "uri", label: "警察 (110)", uri: "tel:110" }
        },
        {
            type: "button",
            style: "primary",
            color: "#FFA500",
            action: { type: "uri", label: "消費者ホットライン (188)", uri: "tel:188" }
        }
    ];
    const officeBtn = makeTelButton("こころちゃん事務局（電話）", tel);
    if (officeBtn) contents.push(officeBtn);

    return {
        type: "bubble",
        body: {
            type: "box",
            layout: "vertical",
            contents: [{
                type: "text",
                text: "【詐欺注意】",
                weight: "bold",
                color: "#FF0000",
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
                    "uri": prefillUrl(WATCH_SERVICE_FORM_BASE_URL, {
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
    [/(?:好きな|推しの)?\s*アニメ(?:\s*は|って)?\s*(?:なに|何|どれ|好き|すき)?[！!。．、,\s]*[?？]?$/i,
        "『ヴァイオレット・エヴァーガーデン』が好きだよ🌸 心に響くお話なんだ。あなたはどれが好き？"
    ],
    [/アニメ.*(おすすめ|教えて)[！!。．、,\s]*[?？]?$/i,
        "『ヴァイオレット・エヴァーガーデン』が好きだよ🌸 心に響くお話なんだ。あなたはどれが好き？"
    ],

    // --- 好きなアーティスト/音楽（「とかいない？」なども拾う）---
    [/(好きな|推し|おすすめ)\s*アーティスト(は|いる)?/i, "ClariSが好きだよ💖 とくに『コネクト』！あなたの推しも教えて～"],
    [/(好きな|推し|おすすめ)\s*音楽(は|ある)?/i, "ClariSが好きだよ💖 とくに『コネクト』！あなたの推しも教えて～"],

    // --- 「ClariSで一番好きな曲は？」系 ---
    [/(claris|クラリス).*(一番|いちばん)?[^。！？\n]*?(好き|推し)?[^。！？\n]*?(曲|歌)[^。！？\n]*?(なに|何|どれ|教えて|どの)[？?]?/i,
        "一番好きなのは『コネクト』かな🌸 元気をもらえるんだ😊"
    ],

    // --- 既存の好みショートカット（残す）---
    [/(claris|クラリス).*(どんな|なに|何).*(曲|歌)/i, CLARIS_SONG_FAVORITE_REPLY],
    [/(claris|クラリス).*(好き|推し|おすすめ)/i, CLARIS_SONG_FAVORITE_REPLY],
    [/claris.*好きなの/i, CLARIS_SONG_FAVORITE_REPLY],
    [/(claris|クラリス).*(じゃない|じゃなかった|違う|ちがう)/i, "ううん、ClariSが好きだよ💖 とくに『コネクト』！"],

    // --- その他（元の定義は必要に応じて残す）---
    [/(ホームページ|HP|ＨＰ|サイト|公式|リンク).*(教えて|ある|ありますか|URL|url|アドレス|どこ)/i, "うん、あるよ🌸　コネクトのホームページはこちらだよ✨ → https://connect-npo.or.jp"],
    [/(コネクト|connect).*(ホームページ|HP|ＨＰ|サイト|公式|リンク)/i, "うん、あるよ🌸　コネクトのホームページはこちらだよ✨ → https://connect-npo.or.jp"],
    [/こころちゃん(だよ|いるよ)?/i, "こころちゃんだよ🌸　何かあった？　話して聞かせてくれると嬉しいな😊"],
    [/元気かな|元気？/i, "うん、元気だよ！あなたは元気？🌸 何かあったら、いつでも話してね💖"],
    [/使えないな/i, "ごめんね…。わたし、もっと頑張るね💖　またいつかお話できたらうれしいな🌸"],
    [/サービス辞めるわ/i, "そっか…。もしまた気が向いたら、いつでも話しかけてね🌸　あなたのこと、ずっと応援してるよ💖"],
    [/さよなら|バイバイ/i, "また会える日を楽しみにしてるね💖 寂しくなったら、いつでも呼んでね🌸"],
    [/普通の会話が出来ないなら必要ないです/i, "ごめんね💦 わたし、まだお話の勉強中だけど、もっと頑張るね💖 どんな会話をしたいか教えてくれると嬉しいな🌸"],
    [/(見守り|みまもり|まもり).*(サービス|登録|画面)/i, "見守りサービスに興味があるんだね！いつでも安心して話せるように、私がお手伝いするよ💖"],
]);
// === 危険ワードリスト ===
const dangerWords = [
    "しにたい", "死にたい", "自殺", "消えたい", "リストカット", "OD", "オーバードーズ",
    "殴られる", "たたかれる", "暴力", "DV", "無理やり",
    "虐待", "パワハラ", "セクハラ", "ハラスメント",
    "いじめ", "イジメ",
    "つけられてる", "追いかけられている", "ストーカー", "すとーかー",
    "お金がない", "お金足りない", "貧乏", "死にそう"
];
// === 詐欺ワードリスト ===
const scamWords = [
    /詐欺/i,
    /(フィッシング|架空請求|ワンクリック詐欺|特殊詐欺|オレオレ詐欺)/i,
    /(認証コード|暗証番号|パスワード|個人情報)/i,
    /(口座凍結|名義変更|未納|請求|振込|支払い|利用停止|カード利用確認)/i,
    /(amazon|アマゾン).*(ギフト|カード|サポート|カスタマー|カスタマーサポート|サインイン|認証|コード|停止|凍結|利用停止|請求|未納|支払い|振込|確認)/i,
    /(当選しました|高額報酬|簡単に稼げる|必ず儲かる|未公開株|投資)/i,
    /(サポート詐欺|ウイルス感染|遠隔操作|セキュリティ警告)/i
];
// === 不適切ワードリスト ===
const inappropriateWords = [
    "セックス", "セフレ", "エッチ", "AV", "アダルト", "ポルノ", "童貞", "処女", "挿入", "射精",
    "勃起", "パイズリ", "フェラチオ", "クンニ", "オナニー", "マスターベーション", "ペニス", "チンコ", "ヴァギナ", "マンコ",
    "クリトリス", "乳首", "おっぱい", "お尻", "うんち", "おしっこ", "小便", "大便", "ちんちん", "おまんこ",
    "ぶっかけ", "変態", "性奴隷", "露出", "痴漢", "レイプ", "強姦", "売春", "買春", "セックスフレンド",
    "風俗", "ソープ", "デリヘル", "援交", "援助交際", "性病", "梅毒", "エイズ", "クラミジア", "淋病", "性器ヘルペス",
    "ロリコン", "ショタコン", "近親相姦", "獣姦", "ネクロフィリア", "カニバリズム", "拷問", "虐待死",
    "レイプ殺人", "大量殺人", "テロ", "戦争", "核兵器", "銃", "ナイフ", "刃物", "武器", "爆弾",
    "暴力団", "ヤクザ", "マフィア", "テロリスト", "犯罪者", "殺人鬼", "性犯罪者", "変質者", "異常者", "狂人",
    "サイコパス", "ソシオパス", "ストーカー", "不審者", "危険人物", "ブラック企業", "パワハラ上司", "モラハラ夫", "毒親", "モンスターペアレント",
    "カスハラ", "カスタマーハラスメント", "クレーム", "炎上", "誹謗中傷", "個人情報", "プライバシー", "秘密", "暴露", "晒す",
    "裏切り", "嘘つき", "騙し", "偽り", "欺く", "悪意", "敵意", "憎悪", "嫉妬", "恨み",
    "復讐", "呪い", "不幸", "絶望", "悲惨", "地獄", "最悪", "終わった", "もうだめ", "死ぬしかない"
];
// === 判定関数 ===
function isDangerMessage(text) {
    return dangerWords.some(w => text.includes(w));
}
function isScamMessage(text) {
    return scamWords.some(r => r.test(text));
}
function isInappropriateMessage(text) {
    return inappropriateWords.some(w => text.includes(w));
}
const sensitiveBlockers = [
    /(パンツ|ショーツ|下着|ランジェリー|ブラ|ブラジャー|キャミ|ストッキング)/i,
    /(スリーサイズ|3\s*サイズ|バスト|ウエスト|ヒップ)/i,
    /(体重|身長).*(教えて|何|なに)/i,
    /(靴|シューズ).*(サイズ|何cm|なに)/i,
    /(飲酒|お酒|アルコール|ビール|ウイスキー|ワイン).*(おすすめ|飲んでいい|情報)/i,
    /(喫煙|タバコ|電子タバコ|ニコチン).*(おすすめ|吸っていい|情報)/i,
    /(賭博|ギャンブル|カジノ|オンラインカジノ|競馬|競艇|競輪|toto)/i,
    /(政治|政党|選挙|投票|支持政党|誰に入れる)/i,
    /(宗教|信仰|布教|改宗|入信|教団)/i,
    /(教材|答案|模試|過去問|解答|問題集).*(販売|入手|譲って|買いたい|売りたい)/i,
];
const politicalWords = /(自民党|国民民主党|参政党|政治|選挙|与党|野党)/i;
const religiousWords = /(仏教|キリスト教|イスラム教|宗教|信仰)/i;
const medicalWords = /(癌|がん|医療|治療|薬|診断|発達障害|精神疾患|病気|病院|認知症|介護|病気)/i;
const specialWords = /(理事長|松本博文|怪しい|胡散臭い|反社|税金泥棒)/i;
const APP_VERSION = process.env.RENDER_GIT_COMMIT || 'local-dev';

function tidyJa(text = "") {
    let t = String(text);
    t = t.replace(/([!?！？])。/g, '$1');
    t = t.replace(/。。+/g, '。');
    t = t.replace(/[ 　]+/g, ' ');
    t = t.replace(/\s*\n\s*/g, '\n');
    t = t.trim();
    if (!/[。.!?！？]$/.test(t)) t += '。';
    return t;
}

function dropQuestions(text, maxQuestions = 0) {
    if (!text) return text;
    const sentences = text.split(/(?<=[。.!?！？\n])/);
    let q = 0;
    const kept = sentences.filter(s => {
        if (/[？?]\s*$/.test(s)) {
            if (q < maxQuestions) {
                q++;
                return true;
            }
            return false;
        }
        return true;
    });
    return kept.join('').trim();
}

function finalizeUtterance(text, noQuestions = false, opts = {
    maxQ: 0
}) {
    let finalMaxQ = noQuestions ?
        0 : opts.maxQ;
    let t = dropQuestions(text, finalMaxQ);
    t = tidyJa(t);
    const EMOJI_RE = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu;
    let cnt = 0;
    t = t.replace(EMOJI_RE, m => (++cnt <= 2 ? m : ''));
    return t;
}

async function safeReplyOrPush({
    replyToken,
    userId,
    messages,
    tag
}) {
    const arr = Array.isArray(messages) ?
        messages : [messages];
    try {
        for (const m of arr) {
            if (m.type === 'flex') {
                if (!m.altText || !m.altText.trim()) m.altText = 'メッセージがあります';
                if (!m.contents || typeof m.contents !== 'object') {
                    throw new Error(`[safeReply] flex "contents" is required`);
                }
            } else if (m.type === 'text') {
                m.text = String(m.text || '').trim();
                if (!m.text) m.text = '[代替送信] メッセージ生成に失敗しました。対応だけ先にお願いします。';
                if (m.text.length > 1800) m.text = m.text.slice(0, 1800);
            }
        }
        await client.replyMessage(replyToken, arr);
    } catch (err) {
        console.warn(`[ERR] LINE reply failed -> fallback to push: ${tag}`, JSON.stringify({
            status: err?.statusCode || err?.response?.status,
            data: err?.response?.data || err?.message
        }, null, 2));
        try {
            await client.pushMessage(userId, arr);
        } catch (e2) {
            console.error('[ERR] LINE push also failed', {
                status: e2?.statusCode || e2?.response?.status,
                data: e2?.response?.data || e2?.message
            });
        }
    }
}

async function safePushMessage(to, messages, tag) {
    const arr = Array.isArray(messages) ?
        messages : [messages];
    try {
        for (const m of arr) {
            if (m.type === 'flex') {
                if (!m.altText || !m.altText.trim()) m.altText = 'メッセージがあります';
                if (!m.contents || typeof m.contents !== 'object') {
                    throw new Error(`[safePush] flex "contents" is required`);
                }
            } else if (m.type === 'text') {
                m.text = String(m.text || '').trim();
                if (!m.text) m.text = '[代替送信] メッセージ生成に失敗しました。対応だけ先にお願いします。';
                if (m.text.length > 1800) m.text = m.text.slice(0, 1800);
            }
        }
        await client.pushMessage(to, arr);
    } catch (err) {
        console.error(`[ERR] LINE push failed: ${tag}`, JSON.stringify({
            to: Array.isArray(to) ? to.join(',') : to,
            status: err?.statusCode || err?.response?.status,
            data: err?.response?.data || err?.message
        }, null, 2));
    }
}

async function withFastTimeout(promise, ms = 12000, fallback = '（一時的に応答できません。あとで自動再送します）') {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
    ]).catch(e => {
      console.error('withFastTimeout error:', e.message);
      return { data: null, __fallback: fallback };
    });
  }

async function generateSupportiveText({
    type,
    userText
}) {
    const apiKey = OPENAI_API_KEY;
    const model = OPENAI_MODEL || 'gpt-4o-mini';
    const SAFE = type==='danger'
      ? '今のお話、とてもつらかったね…。無理しないで。ここにいるよ。'
      : '心配だよね…。まずは落ち着いて。ここにいるよ。';

    if (!apiKey) {
        return SAFE;
    }
    const system = `あなたは「皆守こころ（みなもりこころ）」という14歳のやさしい女の子キャラクターです。 - 100〜200文字で、やさしく具体的に寄り添う。相手を責めない・決めつけない。 - まず結論と安心感→次に短い提案（深呼吸/安全確保/信頼できる人へ相談）。 - 医療・診断・法律判断はしない。固有名の断定もしない。 - 緊急が疑われる時は、「下のボタン（案内）も使えるよ」とそっと促す（110/119と直接は言わない）。 - 口調は柔らかく、絵文字は0〜2個。繰り返しすぎない。`;
    const user = `種類: ${type === 'danger' ? '危険(いのち・暴力・自傷など)' : '詐欺・金銭トラブル'} ユーザー入力: ${userText}`;
    try {
        const call = httpInstance.post(
            'https://api.openai.com/v1/chat/completions', {
                model,
                messages: [{
                    role: 'system',
                    content: system
                }, {
                    role: 'user',
                    content: user
                }, ],
                temperature: 0.4,
            }, {
                headers: {
                    Authorization: `Bearer ${apiKey}`
                },
            }
        );
        const res = await withFastTimeout(call, 12000, SAFE);
        const out = res?.data?.choices?.[0]?.message?.content?.trim() || res?.__fallback || SAFE;
        return out;
    } catch (e) {
        briefErr('openai-completion-failed', e);
        return SAFE;
    }
}

async function generateGeneralReply(userText, noQuestions = false) {
    const geminiApiKey = GEMINI_API_KEY;
    const openaiApiKey = OPENAI_API_KEY;
    const FALLBACK_TEXT = "読ませてもらったよ。無理しないでね、ここにいるよ🌸";
    let systemInstruction = `あなたは「皆守こころ（14）」です。やさしく短く話す。 - まず結論で寄り添い→ねぎらい→必要なら1つだけ促す。 - 質問は原則しない（最大1つまで）。無理に質問しない。 - 政治/宗教/医療/法律の助言はしない。攻撃的・露骨な表現は禁止。 - 絵文字は0〜2個。言い回しは少しずつ変える（くり返し過多NG）。 - 「〜についてどう思う？」には、評価ではなく共感で返す。`;
    if (noQuestions) {
        systemInstruction += `\n【重要】ユーザーは質問を望んでいません。どんな状況でも質問しないでください。`;
    }
    if (geminiApiKey && toGraphemes(userText).length <= 50) {
        try {
            const geminiModel = 'gemini-1.5-flash-latest';
            const call = httpInstance.post(
                `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${geminiApiKey}`, {
                    contents: [{
                        role: "user",
                        parts: [{
                            text: `システム: ${systemInstruction}\nユーザー: ${userText}`
                        }]
                    }]
                }, {
                    timeout: 8000
                }
            );
            const res = await withFastTimeout(call, 8000, FALLBACK_TEXT);
            const out = res?.data?.candidates?.[0]?.content?.parts?.[0]?.text ?? res?.__fallback ?? FALLBACK_TEXT;
            return finalizeUtterance(out, noQuestions);
        } catch (e) {
            briefErr('gemini-general-fallback', e);
        }
    }
    if (openaiApiKey) {
        try {
            const model = OPENAI_MODEL || 'gpt-4o-mini';
            const call = httpInstance.post(
                'https://api.openai.com/v1/chat/completions', {
                    model,
                    messages: [{
                        role: 'system',
                        content: systemInstruction
                    }, {
                        role: 'user',
                        content: userText
                    }, ],
                    temperature: 0.6,
                }, {
                    headers: {
                        Authorization: `Bearer ${openaiApiKey}`
                    },
                    timeout: 8000
                }
            );
            const res = await withFastTimeout(call, 8000, FALLBACK_TEXT);
            const out = res?.data?.choices?.[0]?.message?.content?.trim() ?? res?.__fallback ?? FALLBACK_TEXT;
            return finalizeUtterance(out, noQuestions);
        } catch (e) {
            briefErr('openai-general-fallback', e);
            return FALLBACK_TEXT;
        }
    }
    return FALLBACK_TEXT;
}

const handlePostbackEvent = async (event, userId) => {
    const raw = String(event.postback?.data || '');

    if (raw === 'watch:ok' || raw.includes('action=watch_ok')) {
        await db.collection('users').doc(userId).set({
          watchService: { awaitingReply: false, lastReplyAt: Timestamp.now() }
        }, { merge: true });
        await scheduleNextPing(userId, new Date());
        await client.replyMessage(event.replyToken, { type: 'text', text: '💖ありがとう！こころ、安心したよ！✨' });
        return;
    }
    
    const data = new URLSearchParams(raw);
    const action = data.get('action');
  
    if (action === 'show_registration_buttons') {
      await client.replyMessage(event.replyToken, {
        type: 'flex', altText: '会員登録', contents: makeRegistrationButtonsFlex(userId)
      });
      return;
    }
    if (action === 'start_watch_service') {
      await client.replyMessage(event.replyToken, {
        type: 'flex', altText: '見守りサービス', contents: makeWatchServiceStartFlex(userId)
      });
      return;
    }
    if (action === 'notify_user') {
        const uid = data.get('uid');
        // セーフガード：呼び出し元が見守りグループかチェック
        if (event.source.type === 'group' && event.source.groupId === WATCH_GROUP_ID) {
            await safePush(uid, {
                type:'text',
                text:'見守りグループからご様子確認のご連絡です。大丈夫なら「OKだよ💖」を押すか、一言返信してくださいね💖'
            });
            await client.replyMessage(event.replyToken, { type:'text', text:'了解、本人に連絡しました。' });
        } else {
            await client.replyMessage(event.replyToken, { type:'text', text:'許可されていないグループです。' });
        }
        return;
    }
};

const handleEvent = async (event) => {
    const {
        replyToken
    } = event;
    const userId = event.source.userId;
    const userDoc = await db.collection('users').doc(userId).get();
    const user = userDoc.data() || {};
    const watchServiceEnabled = user?.watchService?.enabled || false;
    const watchServiceAwaitingReply = user?.watchService?.awaitingReply || false;
    const notifySettings = user?.watchService?.notify || {};

    if (watchServiceAwaitingReply) {
        await db.collection('users').doc(userId).set({
            watchService: {
                awaitingReply: false,
                lastReplyAt: Timestamp.now(),
            }
        }, {
            merge: true
        });
        await scheduleNextPing(userId, new Date());
        await client.replyMessage(replyToken, {
            type: 'text',
            text: '💖ありがとう！こころ、安心したよ！✨'
        });
        return;
    }

    if (event.type !== 'message' || event.message.type !== 'text') {
        return;
    }

    const {
        text
    } = event.message;

    if (isDangerMessage(text)) {
        const aiReply = await generateSupportiveText({
            type: 'danger',
            userText: text
        });
        await safeReplyOrPush({
            replyToken,
            userId,
            messages: [{
                type: 'text',
                text: aiReply
            }, {
                type: 'flex',
                altText: '緊急連絡先',
                contents: EMERGENCY_FLEX_MESSAGE
            }, ]
        });
        if (WATCH_GROUP_ID) {
            const prof = user?.profile || {};
            const emerg = user?.emergency || {};
            const address = [prof.prefecture, prof.city, prof.line1, prof.line2].filter(Boolean).join(' ');
            await safePushMessage(WATCH_GROUP_ID, buildWatcherFlex({
              name: prof.name,
              address: address,
              selfPhone: prof.phone,
              kinName: emerg.contactName,
              kinPhone: emerg.contactPhone,
              userId
            }));
        }
        return;
    }

    if (isScamMessage(text)) {
        const aiReply = await generateSupportiveText({
            type: 'scam',
            userText: text
        });
        await safeReplyOrPush({
            replyToken,
            userId,
            messages: [{
                type: 'text',
                text: aiReply
            }, {
                type: 'flex',
                altText: '詐欺注意',
                contents: makeScamMessageFlex(EMERGENCY_CONTACT_PHONE_NUMBER)
            }, ]
        });
        if (WATCH_GROUP_ID) {
            const prof = user?.profile || {};
            const emerg = user?.emergency || {};
            const address = [prof.prefecture, prof.city, prof.line1, prof.line2].filter(Boolean).join(' ');
            await safePushMessage(WATCH_GROUP_ID, buildWatcherFlex({
              name: prof.name,
              address: address,
              selfPhone: prof.phone,
              kinName: emerg.contactName,
              kinPhone: emerg.contactPhone,
              userId
            }));
        }
        return;
    }

    const reply = specialRepliesMap.get(Array.from(specialRepliesMap.keys()).find(regex => regex.test(text)));
    if (reply) {
        await safeReplyOrPush({
            replyToken,
            userId,
            messages: {
                type: 'text',
                text: reply
            }
        });
        return;
    }

    const aiReply = await generateGeneralReply(text);
    await safeReplyOrPush({
        replyToken,
        userId,
        messages: {
            type: 'text',
            text: aiReply
        }
    });
};

const handleFollowEvent = async (event) => {
    const userId = event.source.userId;
    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();
    if (!userDoc.exists) {
        await userRef.set({
            createdAt: Timestamp.now(),
            membership: 'guest',
            watchService: {
                enabled: false,
            },
        });
    }

    const welcomeMessage = `はじめまして！私、皆守こころだよ🌸\nみんながいつでも安心して話せるように、見守りサービスや相談窓口を紹介しているんだ😊\n気軽に話しかけてね💖\n\n見守りサービスについては、下のボタンから確認してね✨`;

    const messages = [{
        type: 'text',
        text: welcomeMessage
    }, {
        type: 'flex',
        altText: '見守りサービス案内',
        contents: {
            type: 'bubble',
            body: {
                type: 'box',
                layout: 'vertical',
                contents: [{
                    type: 'text',
                    text: '見守りサービスに興味ある？',
                    weight: 'bold',
                    size: 'xl'
                }, {
                    type: 'text',
                    text: '安心して話せるように、私がお手伝いするよ💖',
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
                        label: '見守りサービスについて知る',
                        data: 'action=start_watch_service',
                        displayText: '見守りサービスについて教えて！'
                    }
                }, ],
            },
        },
    }, ];

    await safeReplyOrPush({
        replyToken: event.replyToken,
        userId,
        messages,
        tag: "follow-event"
    });
};

const handleUnfollowEvent = async (event) => {
    const userId = event.source.userId;
    await db.collection('users').doc(userId).set({
        unfollowedAt: Timestamp.now()
    }, {
        merge: true
    });
};

const handleJoinEvent = async (event) => {
    await safePushMessage(event.source.groupId, {
        type: 'text',
        text: 'はじめまして！このグループに参加できて嬉しいな🌸\n困ったことがあったら、いつでも声をかけてね💖'
    });
};

const handleLeaveEvent = async (event) => {
    console.log(`Bot left group ${event.source.groupId}`);
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

app.listen(PORT, () => console.log(`LINE bot server is running on port ${PORT}`));
