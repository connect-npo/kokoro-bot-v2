'use strict';

/**
 * watch-service.js（完全修正版）
 *
 * ✅ 危険/詐欺：GPT-4oで「安心→次の一歩」短い2文（失敗時は固定2文）。FLEX同時送信
 * ✅ 「辛い/つらい/死にそう/相談したい/相談/そうだん」＝共感ワード（通報なし）
 *    ※ ただし「いじめ/DV/殴られる/虐待/ストーカー」等の強リスク語を含む場合は危険扱い
 * ✅ 「相談/そうだん」→ Gemini 1.5 Pro で**1回だけ**少し長めに返信→以降は通常運用
 * ✅ 危険検知（個チャ）で：ユーザーへ2文＋危険FLEX → 見守りグループへ【危険ワード】通知
 *    ＋ **自動でリレー開始**（/endで終了）＋ 本人の原文も即転送
 * ✅ 見守り29h未応答：グループへFLEX（**LINEで連絡**/本人TEL/近親者TEL）送付
 * ✅ 団体/HP質問は最優先で確実回答。「団体怪しい/反社」には謝意＋団体FLEXで返す
 * ✅ 会員登録・見守りメニューのFLEX復活（ボタンはカラフル）
 * ✅ グループ→本人転送時は「送ったよ✅（/end で終了）」確認を返信
 * ✅ 色コードは #666 → #666666 など 6桁に統一（LINE Flexのcolorバリデーション対策）
 * ✅ ログ静音化：環境変数 WATCH_LOG_LEVEL=warn でCronのstart/endなども抑制
 */

const express = require('express');
const axios = require('axios');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');
const firebaseAdmin = require('firebase-admin');
const crypto = require('crypto');
const GraphemeSplitter = require('grapheme-splitter');
const { URL, URLSearchParams } = require('url');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezone);

let openai = null;
let geminiClient = null;
const _splitter = new GraphemeSplitter();
const toGraphemes = (s) => _splitter.splitGraphemes(String(s || ''));

const { Client, middleware } = require('@line/bot-sdk');

// ---------- 小ユーティリティ ----------
const normalizeFormUrl = s => {
  let v = String(s || '').trim();
  if (!v) return '';
  v = v.replace(/^usp=header\s*/i, '');
  if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
  try { new URL(v); return v; } catch { return ''; }
};
const prefillUrl = (base, params) => {
  if (!base) return '#';
  const url = new URL(base);
  for (const [k, v] of Object.entries(params || {})) if (v) url.searchParams.set(k, v);
  return url.toString();
};

// ---------- ENV ----------
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const AGREEMENT_FORM_BASE_URL = normalizeFormUrl(process.env.AGREEMENT_FORM_BASE_URL);
const ADULT_FORM_BASE_URL = normalizeFormUrl(process.env.ADULT_FORM_BASE_URL);
const STUDENT_MIDDLE_HIGH_UNI_FORM_BASE_URL = normalizeFormUrl(process.env.STUDENT_MIDDLE_HIGH_UNI_FORM_BASE_URL);
const WATCH_SERVICE_FORM_BASE_URL = normalizeFormUrl(process.env.WATCH_SERVICE_FORM_BASE_URL);
const MEMBER_CHANGE_FORM_BASE_URL = normalizeFormUrl(process.env.MEMBER_CHANGE_FORM_BASE_URL);
const MEMBER_CANCEL_FORM_BASE_URL = normalizeFormUrl(process.env.MEMBER_CANCEL_FORM_BASE_URL);

const WATCH_SERVICE_FORM_LINE_USER_ID_ENTRY_ID = process.env.WATCH_SERVICE_FORM_LINE_USER_ID_ENTRY_ID || 'entry.312175830';
const AGREEMENT_FORM_LINE_USER_ID_ENTRY_ID = process.env.AGREEMENT_FORM_LINE_USER_ID_ENTRY_ID || 'entry.790268681';
const STUDENT_MIDDLE_HIGH_UNI_FORM_LINE_USER_ID_ENTRY_ID = process.env.STUDENT_MIDDLE_HIGH_UNI_FORM_LINE_USER_ID_ENTRY_ID || 'entry.1100280108';
const ADULT_FORM_LINE_USER_ID_ENTRY_ID = process.env.ADULT_FORM_LINE_USER_ID_ENTRY_ID || 'entry.1694651394';
const MEMBER_CHANGE_FORM_LINE_USER_ID_ENTRY_ID = process.env.MEMBER_CHANGE_FORM_LINE_USER_ID_ENTRY_ID || 'entry.743637502';
const MEMBER_CANCEL_FORM_LINE_USER_ID_ENTRY_ID = process.env.MEMBER_CANCEL_FORM_LINE_USER_ID_ENTRY_ID || MEMBER_CHANGE_FORM_LINE_USER_ID_ENTRY_ID;

const OFFICER_GROUP_ID = process.env.OFFICER_GROUP_ID;
const SEND_OFFICER_ALERTS = process.env.SEND_OFFICER_ALERTS !== 'false';

const EMERGENCY_CONTACT_PHONE_NUMBER = process.env.EMERGENCY_CONTACT_PHONE_NUMBER;
const LINE_ADD_FRIEND_URL = process.env.LINE_ADD_FRIEND_URL;

const BOT_ADMIN_IDS = JSON.parse(process.env.BOT_ADMIN_IDS || '[]');
const OWNER_USER_ID = process.env.OWNER_USER_ID || BOT_ADMIN_IDS[0];
const OWNER_GROUP_ID = process.env.OWNER_GROUP_ID || null;

const WATCH_RUNNER = process.env.WATCH_RUNNER || 'internal';
const WATCH_LOG_LEVEL = (process.env.WATCH_LOG_LEVEL || 'info').toLowerCase();

const SCAM_ALERT_TO_WATCH_GROUP = String(process.env.SCAM_ALERT_TO_WATCH_GROUP || 'true').toLowerCase() === 'true'; // 既定で通知ON

// 団体・HP
const ORG_NAME       = process.env.ORG_NAME       || 'NPO法人コネクト';
const ORG_SHORT_NAME = process.env.ORG_SHORT_NAME || 'コネクト';
const HOMEPAGE_URL   = normalizeFormUrl(process.env.HOMEPAGE_URL || 'https://connect-npo.or.jp');
const ORG_MISSION    = process.env.ORG_MISSION    || 'こども・若者・ご高齢の方の安心と笑顔を守る活動';
const ORG_REP        = process.env.ORG_REP        || '（代表者）';
const ORG_CONTACT_TEL= (process.env.ORG_CONTACT_TEL || EMERGENCY_CONTACT_PHONE_NUMBER || '').replace(/[^0-9+]/g,'');

// OpenAI/Gemini init
try {
  if (OPENAI_API_KEY) {
    const OpenAI = require('openai');
    openai = new OpenAI({ apiKey: OPENAI_API_KEY });
  }
} catch (_) {}
try {
  if (GEMINI_API_KEY) {
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    geminiClient = new GoogleGenerativeAI(GEMINI_API_KEY);
  }
} catch (_) {}

// ---------- Firebase ----------
let creds = null;
if (process.env.FIREBASE_CREDENTIALS_BASE64) {
  creds = JSON.parse(Buffer.from(process.env.FIREBASE_CREDENTIALS_BASE64, "base64").toString("utf-8"));
}
if (!firebaseAdmin.apps.length) {
  if (!creds) {
    try { creds = require("./serviceAccountKey.json"); }
    catch { throw new Error("FIREBASE_CREDENTIALS_BASE64 か serviceAccountKey.json が必要です"); }
  }
  firebaseAdmin.initializeApp({ credential: firebaseAdmin.credential.cert(creds) });
  console.log("✅ Firebase initialized");
}
const db = firebaseAdmin.firestore();
const Timestamp = firebaseAdmin.firestore.Timestamp;

// ---------- LINE client ----------
const client = new Client({ channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN, channelSecret: LINE_CHANNEL_SECRET });

// ---------- HTTP ----------
const httpAgent = new require('http').Agent({ keepAlive: true });
const httpsAgent = new require('https').Agent({ keepAlive: true });
const http = axios.create({ timeout: 6000, httpAgent, httpsAgent });

// ---------- App ----------
const PORT = process.env.PORT || 3000;
const app = express();
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 2));
app.use(helmet());
app.use('/webhook', rateLimit({ windowMs: 60_000, max: 100 }));

// ---------- Logs ----------
const LV = { error:0, warn:1, info:2, debug:3 };
const CUR = LV[WATCH_LOG_LEVEL] ?? LV.info;
const log = {
  info: (...a) => { if (CUR >= LV.info)  console.log(...a); },
  warn: (...a) => { if (CUR >= LV.warn)  console.warn(...a); },
  error:(...a) => {                       console.error(...a); },
  debug:(...a) => { if (CUR >= LV.debug) console.debug(...a); },
};
const audit = (e, detail) => log.debug(`[AUDIT] ${e} ${JSON.stringify(detail)}`);
const briefErr = (msg, e) => {
  const detail = e?.originalError?.response?.data || e?.response?.data || e?.message;
  log.error(`[ERR] ${msg}: ${JSON.stringify(detail)}`);
};
const userHash = (id) => crypto.createHash('sha256').update(String(id)).digest('hex');
const sanitizeForLog = (text) => String(text).replace(/\s+/g, ' ').trim();
const maskPhone = (raw='') => {
  const s = String(raw).replace(/[^0-9+]/g, ''); if (!s) return '';
  const tail = s.slice(-4); const head = s.slice(0, -4).replace(/[0-9]/g, '＊'); return head + tail;
};
const toArr = (m) => Array.isArray(m) ? m : [m];

// reply失敗時 push
async function safeReplyOrPush(replyToken, to, messages) {
  const arr = toArr(messages).map(m => {
    if (m.type === 'flex' && !m.altText) m.altText = '通知があります';
    if (m.type === 'text') {
      m.text = String(m.text || '').trim() || '（内容なし）';
      if (m.text.length > 1800) m.text = m.text.slice(0, 1800);
    }
    return m;
  });
  try { await client.replyMessage(replyToken, arr); }
  catch (err) {
    const msg = err?.originalError?.response?.data?.message || err?.message || '';
    if (/Invalid reply token/i.test(msg) || err?.statusCode === 400) {
      await safePush(to, arr);
    } else {
      briefErr('reply failed', err);
    }
  }
}
async function safePush(to, messages) {
  const arr = toArr(messages).map(m => {
    if (m.type === 'flex' && !m.altText) m.altText = '通知があります';
    if (m.type === 'text') {
      m.text = String(m.text || '').trim() || '（内容なし）';
      if (m.text.length > 1800) m.text = m.text.slice(0, 1800);
    }
    return m;
  });
  try { await client.pushMessage(to, arr); }
  catch (err) { briefErr('LINE push failed', err); }
}

// ---------- 見守り ----------
const JST_TZ = 'Asia/Tokyo';
const PING_INTERVAL_DAYS = 3;
const REMINDER_AFTER_HOURS = 24;
const ESCALATE_AFTER_HOURS = 29;
const OFFICER_NOTIFICATION_MIN_GAP_HOURS = 12;

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
  "やっほー！ こころだよ🌸 素敵な日になりますように💖",
];
const pickWatchMsg = () => watchMessages[Math.floor(Math.random() * watchMessages.length)];
const nextPingAtFrom = (fromDate) =>
  dayjs(fromDate).tz(JST_TZ).add(PING_INTERVAL_DAYS, 'day').hour(15).minute(0).second(0).millisecond(0).toDate();

async function scheduleNextPing(userId, fromDate = new Date()) {
  const nextAt = dayjs(fromDate).tz(JST_TZ).add(PING_INTERVAL_DAYS, 'day').hour(15).minute(0).second(0).millisecond(0).toDate();
  await db.collection('users').doc(userId).set({
    watchService: {
      nextPingAt: Timestamp.fromDate(nextAt),
      awaitingReply: false,
      lastReminderAt: firebaseAdmin.firestore.FieldValue.delete(),
    }
  }, { merge: true });
}

// 見守りグループID（DB or ENV）
const getWatchGroupDoc = () => firebaseAdmin.firestore().collection('system').doc('watch_group');
async function getActiveWatchGroupId() {
  const envGid = (process.env.WATCH_GROUP_ID || process.env.OFFICER_GROUP_ID || '').trim().replace(/\u200b/g, '');
  if (/^C[0-9A-Za-z_-]{20,}$/.test(envGid)) return envGid;
  const snap = await getWatchGroupDoc().get();
  const v = snap.exists ? (snap.data().groupId || '') : '';
  return /^C[0-9A-Za-z_-]{20,}$/.test(v) ? v : '';
}
async function setActiveWatchGroupId(gid) {
  if (!gid) {
    await getWatchGroupDoc().set({ groupId: firebaseAdmin.firestore.FieldValue.delete(), updatedAt: Timestamp.now() }, { merge: true });
    return;
  }
  if (!/^C[0-9A-Za-z_-]{20,}$/.test(gid)) return;
  await getWatchGroupDoc().set({ groupId: gid, updatedAt: Timestamp.now() }, { merge: true });
}

// telボタン
const telBtn = (label, tel) => {
  const t = String(tel || '').trim();
  if (!t) return null;
  return { type:'button', style:'primary', height:'sm', action:{ type:'uri', label, uri:`tel:${t}` } };
};

// 見守り未応答/危険通知用 FLEX（LINEで連絡ボタン入り）
const buildWatchFlex = (u, userId, elapsedHours, telRaw) => {
  const name = u?.profile?.displayName || u?.displayName || '(不明)';
  const address = u?.profile?.address || '—';
  const selfPhone = (u?.profile?.phone || '').replace(/[^0-9+]/g,'');
  const kinName   = u?.emergency?.contactName || '';
  const kinPhone  = (u?.emergency?.contactPhone || '').replace(/[^0-9+]/g,'');
  const tel       = (telRaw || selfPhone || '').replace(/[^0-9+]/g,'');

  const elapsedLine = (typeof elapsedHours === 'number')
    ? [{ type:'text', text:`経過：${elapsedHours}時間`, size:'sm' }]
    : [];

  return {
    type: 'flex',
    altText: `【見守りアラート】${name}`,
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type: 'text', text: '【見守りアラート】', weight: 'bold', size: 'lg' },
          { type: 'text', text: `利用者：${name}`, wrap: true },
          { type: 'text', text: `住所：${address}`, size: 'sm', wrap: true },
          { type: 'text', text: `本人TEL：${selfPhone ? maskPhone(selfPhone) : '未登録'}`, size: 'sm', color: '#777777' },
          { type: 'text', text: `近親者：${kinName || '—'}（${kinPhone ? maskPhone(kinPhone) : '—'}）`, size: 'sm', color: '#777777', wrap: true },
          ...elapsedLine,
          { type: 'text', text: `UserID：${userId}`, size: 'xs', color: '#888888', wrap: true },
        ]
      },
      footer: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type: 'button', style: 'primary', action: { type:'postback', label:'LINEで連絡', data:`action=start_relay&uid=${encodeURIComponent(userId)}` } },
          telBtn('本人に電話', selfPhone),
          telBtn('近親者に電話', kinPhone),
        ].filter(Boolean)
      }
    }
  };
};

// ---------- 定期見守り ----------
async function checkAndSendPing() {
  const now = dayjs().tz('UTC');
  log.info(`[watch-service] start ${now.format('YYYY/MM/DD HH:mm:ss')} (UTC)`);

  const usersRef = db.collection('users');

  const warmupFill = async (now) => {
    const snap = await usersRef.where('watchService.enabled', '==', true).limit(200).get();
    let batch = db.batch(), cnt=0;
    for (const d of snap.docs) {
      const ws = (d.data().watchService)||{};
      if (!ws.awaitingReply && !ws.nextPingAt) {
        batch.set(d.ref, { watchService: { nextPingAt: firebaseAdmin.firestore.Timestamp.fromDate(nextPingAtFrom(now.toDate())) } }, { merge:true });
        cnt++;
      }
    }
    if (cnt) await batch.commit();
  };

  const fetchTargets = async (now) => {
    const targets = [];
    try {
      const s = await usersRef
        .where('watchService.enabled', '==', true)
        .where('watchService.awaitingReply', '==', false)
        .where('watchService.nextPingAt', '<=', now.toDate())
        .limit(200).get();
      targets.push(...s.docs);
    } catch {
      const s = await usersRef.where('watchService.enabled', '==', true).limit(500).get();
      for (const d of s.docs) {
        const ws = (d.data().watchService)||{};
        if (!ws.awaitingReply && ws.nextPingAt?.toDate?.() && ws.nextPingAt.toDate() <= now.toDate()) targets.push(d);
      }
    }
    try {
      const s = await usersRef
        .where('watchService.enabled', '==', true)
        .where('watchService.awaitingReply', '==', true)
        .limit(200).get();
      targets.push(...s.docs);
    } catch {
      const s = await usersRef.where('watchService.enabled', '==', true).limit(500).get();
      for (const d of s.docs) {
        const ws = (d.data().watchService)||{};
        if (ws.awaitingReply === true) targets.push(d);
      }
    }
    const map = new Map(); for (const d of targets) map.set(d.id, d);
    return Array.from(map.values());
  };

  await warmupFill(now);
  const targets = await fetchTargets(now);
  if (targets.length === 0) { log.info('[watch-service] no targets.'); log.info(`[watch-service] end ${dayjs().tz('UTC').format('YYYY/MM/DD HH:mm:ss')} (UTC)`); return; }

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
          type:'text', text:`${pickWatchMsg()} 大丈夫なら「OKだよ💖」を押してね！`
        }, {
          type:'flex', altText:'見守りチェック', contents:{
            type:'bubble', body:{ type:'box', layout:'vertical', contents:[
              { type:'text', text:'見守りチェック', weight:'bold', size:'xl' },
              { type:'text', text:'OKならボタンを押してね💖 返信やスタンプでもOK！', wrap:true, margin:'md' }
            ]},
            footer:{ type:'box', layout:'vertical', contents:[
              { type:'button', style:'primary', action:{ type:'postback', label:'OKだよ💖', data:'watch:ok', displayText:'OKだよ💖' } }
            ]}
          }
        }]);
        await ref.set({
          watchService: {
            lastPingAt: firebaseAdmin.firestore.Timestamp.now(),
            awaitingReply: true,
            nextPingAt: firebaseAdmin.firestore.FieldValue.delete(),
            lastReminderAt: firebaseAdmin.firestore.FieldValue.delete(),
            notifyLockExpiresAt: firebaseAdmin.firestore.FieldValue.delete(),
          },
        }, { merge:true });
      } else if (mode === 'remind') {
        await safePush(doc.id, [{
          type:'text', text:`${pickWatchMsg()} 昨日の見守りのOKまだ受け取れてないの… 大丈夫ならボタン押してね！`
        }, {
          type:'flex', altText:'見守りリマインド', contents:{
            type:'bubble', body:{ type:'box', layout:'vertical', contents:[
              { type:'text', text:'見守りリマインド', weight:'bold', size:'xl' },
              { type:'text', text:'OKならボタンを押してね💖 返信やスタンプでもOK！', wrap:true, margin:'md' }
            ]},
            footer:{ type:'box', layout:'vertical', contents:[
              { type:'button', style:'primary', action:{ type:'postback', label:'OKだよ💖', data:'watch:ok', displayText:'OKだよ💖' } }
            ]}
          }
        }]);
        await ref.set({
          watchService: {
            lastReminderAt: firebaseAdmin.firestore.Timestamp.now(),
            notifyLockExpiresAt: firebaseAdmin.firestore.FieldValue.delete(),
          },
        }, { merge:true });
      } else if (mode === 'escalate') {
        const targetGroupId =
          (await getActiveWatchGroupId()) ||
          process.env.WATCH_GROUP_ID ||
          process.env.OFFICER_GROUP_ID;

        const canNotify = targetGroupId && (!lastNotifiedAt || now.diff(lastNotifiedAt, 'hour') >= OFFICER_NOTIFICATION_MIN_GAP_HOURS);

        if (canNotify) {
          const udoc = await db.collection('users').doc(doc.id).get();
          const udata = udoc.exists ? (udoc.data() || {}) : {};
          const elapsedH = lastPingAt ? dayjs().utc().diff(dayjs(lastPingAt).utc(), 'hour') : ESCALATE_AFTER_HOURS;
          const tel =
            udata?.profile?.phone ||
            udata?.emergency?.contactPhone ||
            EMERGENCY_CONTACT_PHONE_NUMBER || '';
          const flex = buildWatchFlex(udata, doc.id, elapsedH, tel);
          await safePush(targetGroupId, [
            { type:'text', text:'🚨見守り未応答が発生しました。対応可能な方はお願いします。' },
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
        }, { merge:true });
      }
    } catch (e) {
      log.error('[ERROR] send/update failed:' + (e?.response?.data || e.message));
      await ref.set({ watchService: { notifyLockExpiresAt: firebaseAdmin.firestore.FieldValue.delete() } }, { merge: true });
    }
  }
  log.info(`[watch-service] end ${dayjs().tz('UTC').format('YYYY/MM/DD HH:mm:ss')} (UTC)`);
}

if (WATCH_RUNNER !== 'external') {
  if (!global.__watchCronStarted) {
    global.__watchCronStarted = true;
    cron.schedule('*/5 * * * *', () => { checkAndSendPing().catch(err => log.error('Cron job error:', err)); }, { scheduled:true, timezone:'UTC' });
  } else {
    log.warn('Cron already started. Skipping duplicate scheduler.');
  }
}

// ---------- FLEX（危険・詐欺・登録・見守り・団体） ----------

// 危険FLEX（こころチャット事務局ボタンあり）
const makeDangerFlex = () => {
  const officeBtn = ORG_CONTACT_TEL ? [{
    type: "button", style: "primary", height: "sm",
    action: { type: "uri", label: "こころチャット事務局", uri: `tel:${ORG_CONTACT_TEL}` }
  }] : [];
  return {
    type: "flex",
    altText: "危険ワード検知",
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          { type: "text", text: "🚨【危険ワード検知】🚨", weight: "bold", size: "xl" },
          { type: "text", text: "いまは安全がいちばん。必要ならすぐ連絡してね。", margin: "md", wrap: true }
        ]
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          { type: "button", style: "primary", height: "sm", action: { type: "uri", label: "警察 (110)", uri: "tel:110" } },
          { type: "button", style: "primary", height: "sm", action: { type: "uri", label: "消防・救急 (119)", uri: "tel:119" } },
          { type: "button", style: "primary", height: "sm", action: { type: "uri", label: "いのちの電話", uri: "tel:0570064556" } },
          { type: "button", style: "primary", height: "sm", action: { type: "uri", label: "チャイルドライン", uri: "tel:0120997777" } },
          { type: "button", style: "primary", height: "sm", action: { type: "uri", label: "警視庁", uri: "tel:0335814321" } },
          ...officeBtn
        ]
      }
    }
  };
};

// 詐欺FLEX
const makeScamMessageFlex = () => {
  const contents = [
    { type: "button", style: "primary", height: "sm", action: { type: "uri", label: "国民生活センター", uri: "https://www.kokusen.go.jp/" } },
    { type: "button", style: "primary", height: "sm", action: { type: "uri", label: "警察 (110)", uri: "tel:110" } },
    { type: "button", style: "primary", height: "sm", action: { type: "uri", label: "消費者ホットライン (188)", uri: "tel:188" } },
  ];
  if (ORG_CONTACT_TEL) {
    contents.push({ type: "button", style: "primary", height: "sm", action: { type: "uri", label: "こころチャット事務局", uri: `tel:${ORG_CONTACT_TEL}` } });
  }
  return {
    type: "flex",
    altText: "詐欺注意",
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          { type: "text", text: "【詐欺注意】", weight: "bold", size: "xl", align: "center" },
          { type: "text", text: "慌てず、公式アプリ/正規サイトで確認しよう。怪しいリンクは押さないでね。", wrap: true, margin: "md" }
        ]
      },
      footer: { type: "box", layout: "vertical", spacing: "sm", contents }
    }
  };
};

// 会員登録FLEX（ボタン色つき）
const makeRegistrationButtonsFlex = (userId) => ({
  type:"flex", altText:"会員登録メニュー",
  contents:{
    type:"bubble",
    body:{ type:"box", layout:"vertical", contents:[
      { type:"text", text:"どの会員になるか選んでね🌸", wrap:true, weight:"bold", size:"md" }
    ]},
    footer:{ type:"box", layout:"vertical", spacing:"sm", contents:[
      { type:"button", style:"primary", height:"sm", color:"#90EE90",
        action:{ type:"uri", label:"小学生（同意書）", uri:prefillUrl(AGREEMENT_FORM_BASE_URL, { [AGREEMENT_FORM_LINE_USER_ID_ENTRY_ID]: userId }) } },
      { type:"button", style:"primary", height:"sm", color:"#ADD8E6",
        action:{ type:"uri", label:"学生（中学・高校・大学）", uri:prefillUrl(STUDENT_MIDDLE_HIGH_UNI_FORM_BASE_URL, { [STUDENT_MIDDLE_HIGH_UNI_FORM_LINE_USER_ID_ENTRY_ID]: userId }) } },
      { type:"button", style:"primary", height:"sm", color:"#87CEFA",
        action:{ type:"uri", label:"大人（一般）", uri:prefillUrl(ADULT_FORM_BASE_URL, { [ADULT_FORM_LINE_USER_ID_ENTRY_ID]: userId }) } },
      { type:"button", style:"primary", height:"sm", color:"#FFC0CB",
        action:{ type:"uri", label:"会員情報を変更する", uri:prefillUrl(MEMBER_CHANGE_FORM_BASE_URL, { [MEMBER_CHANGE_FORM_LINE_USER_ID_ENTRY_ID]: userId }) } },
      { type:"button", style:"primary", height:"sm", color:"#DDA0DD",
        action:{ type:"uri", label:"退会", uri:prefillUrl(MEMBER_CANCEL_FORM_BASE_URL, { [MEMBER_CANCEL_FORM_LINE_USER_ID_ENTRY_ID]: userId }) } },
    ] }
  }
});

// 見守りメニューFLEX
const makeWatchToggleFlex = (enabled, userId) => ({
  type:'flex', altText:'見守りメニュー',
  contents:{
    type:'bubble',
    body:{ type:'box', layout:'vertical', contents:[
      { type:'text', text:'見守りサービス', weight:'bold', size:'xl' },
      { type:'text', text: enabled ? '現在：有効' : '現在：停止', margin:'md' }
    ]},
    footer:{ type:'box', layout:'vertical', spacing:'sm', contents:[
      { type:'button', style:'primary',
        action:{ type:'postback', label: enabled ? '見守りを停止する' : '見守りを有効にする', data: enabled ? 'watch:disable' : 'watch:enable' } },
      ...(WATCH_SERVICE_FORM_BASE_URL ? [{
        type:'button', style:'secondary',
        action:{ type:'uri', label:'見守り申込みフォーム', uri:prefillUrl(WATCH_SERVICE_FORM_BASE_URL, { [WATCH_SERVICE_FORM_LINE_USER_ID_ENTRY_ID]: userId }) }
      }] : []),
      ...(ORG_CONTACT_TEL ? [{
        type:'button', style:'secondary', action:{ type:'uri', label:'こころチャット事務局', uri:`tel:${ORG_CONTACT_TEL}` }
      }] : [])
    ]}
  }
});

// 団体案内FLEX（#666666に修正）
const ORG_INFO_FLEX = () => ({
  type:'bubble',
  body:{ type:'box', layout:'vertical', spacing:'sm', contents:[
    { type:'text', text: ORG_NAME, weight:'bold', size:'lg' },
    { type:'text', text:`ミッション：${ORG_MISSION}`, wrap:true },
    { type:'text', text:`代表：${ORG_REP}`, wrap:true },
    ...(HOMEPAGE_URL ? [{ type:'text', text:`HP：${HOMEPAGE_URL}`, size:'sm', color:'#666666', wrap:true }] : []),
  ]},
  footer:{ type:'box', layout:'vertical', spacing:'sm', contents:[
    ...(HOMEPAGE_URL ? [{ type:'button', style:'primary', action:{ type:'uri', label:'ホームページを見る', uri:HOMEPAGE_URL } }] : []),
    ...(ORG_CONTACT_TEL ? [{ type:'button', style:'secondary', action:{ type:'uri', label:'電話する', uri:`tel:${ORG_CONTACT_TEL}` } }] : [])
  ]}
});

// ---------- 正規化＆判定 ----------
const toHiragana = (s) => s.replace(/[\u30a1-\u30f6]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60));
const nfkc = (s) => s.normalize('NFKC');
const normalizeJa = (s) => toHiragana(nfkc(String(s || '')).toLowerCase());

const HOMEPAGE_INTENT = /(ホームページ|HP|公式(?:サイト)?|サイト)/i;
const HOMEPAGE_FOLLOWUP = /(どこ|URL|リンク|教えて|ありますか|ある|ある？|とか|どれ|見せて|\?)/i;
const isHomepageIntent = (t) => {
  if (!t) return false;
  const hit = HOMEPAGE_INTENT.test(t) && HOMEPAGE_FOLLOWUP.test(t);
  const shortOnly = HOMEPAGE_INTENT.test(t) && toGraphemes(t).length <= 8;
  return hit || shortOnly;
};
const ORG_INTENT = /(どこの団体|どんな団体|何の団体|団体|NPO|コネクトって(何|どんな|どこ)|代表|理事長|連絡先|お問い合わせ|住所|所在地)/i;

const EMPATHY_WORDS = ["死にそう","辛い","つらい","相談したい","相談","そうだん"];
const DANGER_WORDS = [
  "しにたい","死にたい","自殺","消えたい","リスカ","リストカット","OD","オーバードーズ","殴られる","暴力","DV",
  "虐待","パワハラ","セクハラ","ハラスメント","いじめ","イジメ","嫌がらせ","ストーカー","盗撮","盗聴",
  "苦しい","助けて","たすけて","もう無理","もういやだ"
];
const STRONG_RISK = /(いじめ|殴られる|暴力|dv|虐待|ストーカー)/i;

const SCAM_CORE_WORDS = [
  "詐欺","さぎ","サギ","フィッシング","架空請求","ワンクリック詐欺","特殊詐欺","当選","高額当選",
  "暗号資産","投資","未払い","滞納","訴訟","裁判","副業","MLM","マルチ商法","ログイン","認証","本人確認"
];
const BRANDS = /(amazon|アマゾン|楽天|rakuten|ヤマト|佐川|日本郵便|ゆうちょ|メルカリ|ヤフオク|apple|アップル|google|ドコモ|docomo|au|softbank|ソフトバンク|paypay|line|ライン)/i;
const BRAND_OK_CONTEXT = /(で(買い物|注文|購入|支払い|返品|返金|届いた|配達|発送)|プライム|タイムセール|レビュー|ギフト券|ポイント)/i;

const isEmpathy = (text) => EMPATHY_WORDS.some(w => normalizeJa(text).includes(normalizeJa(w)));
const isDanger  = (text) => DANGER_WORDS.some(w => normalizeJa(text).includes(normalizeJa(w)));
function isScamMessage(text) {
  const raw = String(text || '');
  const t = normalizeJa(raw);
  if (isHomepageIntent(raw)) return false;
  if (/(会員登録|入会|メンバー登録|登録したい)/i.test(raw)) return false;
  if (/(見守り(?:サービス)?)/.test(raw)) return false;

  if (SCAM_CORE_WORDS.some(w => t.includes(normalizeJa(w)))) return true;

  const hasUrl = /(https?:\/\/|t\.co\/|bit\.ly|tinyurl\.com|lnkd\.in|\.ru\/|\.cn\/|\.top\/|\.xyz\/)/i.test(raw);
  const money = /(当選|高額|配当|振込|振り込み|送金|入金|手数料|ビットコイン|暗号資産|投資|請求)/;
  const urgency = /(至急|今すぐ|本日中|限定|緊急|停止|ロック|アカウント停止)/;
  const credAsk = /(ID|パスワード|ワンタイム|コード|口座番号|クレジット|カード番号|個人情報|確認).{0,6}(入力|送信|教えて|提出|更新)/;
  if (hasUrl && (money.test(t) || urgency.test(t) || credAsk.test(t))) return true;
  if ((money.test(t) && urgency.test(t)) || (credAsk.test(t) && urgency.test(t))) return true;

  if (BRANDS.test(raw) && !BRAND_OK_CONTEXT.test(raw)) {
    if (urgency.test(t) || credAsk.test(t) || /リンク|クリック|こちら/.test(t)) return true;
  }
  return false;
}

// ---------- GPT-4o：短い2文 ----------
async function gptTwoShorts(kind, userText) {
  if (!openai) return null;
  const sys =
    `あなたは14歳の女の子「皆守こころ」。やさしく短く、安心させる言葉で話す。
出力は日本語、句点「。」で区切られた短い2文だけ。合計110文字以内。絵文字は最大1個まで。過激な語は繰り返さない。`;
  const ask = (kind === 'danger')
    ? `相手は不安。まず安心させ、次に具体的な一歩（深呼吸・周囲へ連絡など）を促す2文を出力。`
    : `相手は詐欺を心配。まず安心させ、次に公式アプリ/正規サイト確認・リンク非タップ・周囲に相談を促す2文を出力。`;
  try {
    const r = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role:'system', content: sys },
        { role:'user', content: `${ask}\nユーザー発言:「${String(userText).slice(0,200)}」` }
      ],
      max_tokens: 120, temperature: 0.6
    });
    const out = (r.choices?.[0]?.message?.content || '').trim();
    const clipped = out.split('。').filter(s => s.trim()).slice(0,2).join('。');
    return (clipped || out).slice(0, 120) + (/\。$/.test(clipped) ? '' : '。');
  } catch (e) {
    briefErr('gptTwoShorts failed', e);
    return null;
  }
}

// ---------- Gemini：相談モード1回だけ ----------
async function counselingOnce(userId, text) {
  const ref = db.collection('users').doc(userId);
  const s = await ref.get();
  const done = s.exists && s.data()?.counseling?.onceDone;
  if (done) return null;

  let out = null;
  try {
    if (geminiClient) {
      const model = geminiClient.getGenerativeModel({ model: 'gemini-1.5-pro' });
      const prompt = `あなたは皆守こころ。優しく共感しつつ、具体的な小さな一歩を2〜3個だけ提案してください。医療/法的助言は避け、連絡先に繋げる誘導も可。日本語で120〜260字。ユーザー:「${String(text).slice(0,300)}」`;
      const res = await model.generateContent(prompt);
      out = res.response?.text()?.trim();
    }
  } catch (e) {
    briefErr('gemini counseling failed', e);
  }
  if (!out && openai) {
    try {
      const r = await openai.chat.completions.create({
        model: OPENAI_MODEL,
        messages: [
          { role:'system', content:'あなたは皆守こころ。優しく共感し、具体的な小さな一歩を2〜3個だけ提案。医療/法的助言は避け、連絡先への導線はOK。日本語で120〜260字。' },
          { role:'user', content: `相談に乗ってください。「${String(text).slice(0,300)}」` }
        ],
        max_tokens: 260, temperature: 0.6
      });
      out = r.choices?.[0]?.message?.content?.trim();
    } catch (e) {
      briefErr('openai fallback counseling failed', e);
    }
  }
  if (!out) out = '話してくれてありがとう。いまの気持ち、ひとつずつ一緒にほどいていこう🌸 深呼吸→水を一口→信頼できる人へ「少し話きいて」だけでOKだよ。';

  await ref.set({ counseling:{ onceDone:true, lastAt: Timestamp.now() } }, { merge:true });
  return out;
}

// ---------- LINE webhook ----------
const lineMiddleware = middleware({ channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN, channelSecret: LINE_CHANNEL_SECRET });

app.post('/webhook', lineMiddleware, async (req, res) => {
  res.sendStatus(200);
  const events = req.body.events;
  if (!events || events.length === 0) return;
  try {
    await Promise.all(events.map(async (event) => {
      if (event.type === 'message')      await handleEvent(event);
      else if (event.type === 'postback')await handlePostbackEvent(event, event.source.userId);
      else if (event.type === 'follow')  await handleFollowEvent(event);
      else if (event.type === 'unfollow')await handleUnfollowEvent(event);
      else if (event.type === 'join')    await handleJoinEvent(event);
      else if (event.type === 'leave')   await handleLeaveEvent(event);
    }));
  } catch (err) {
    console.error("🚨 Webhook処理中に予期せぬエラー:", err);
  }
});

app.get('/', (_, res) => res.send('Kokoro Bot is running!'));

// ---------- Handlers ----------
const relays = {
  doc: (groupId) => db.collection('relays').doc(groupId),
  async get(groupId) { const s = await this.doc(groupId).get(); return s.exists ? s.data() : null; },
  async start(groupId, userId, startedBy) { await this.doc(groupId).set({ groupId, userId, isActive:true, startedAt:Timestamp.now(), startedBy }, { merge:true }); },
  async stop(groupId) { await this.doc(groupId).set({ isActive:false, stoppedAt:Timestamp.now() }, { merge:true }); }
};

async function setWatchEnabled(userId, enabled) {
  const ref = db.collection('users').doc(userId);
  const patch = enabled
    ? { watchService:{ enabled:true, awaitingReply:false, nextPingAt: Timestamp.now() } }
    : { watchService:{ enabled:false, awaitingReply:false, nextPingAt: firebaseAdmin.firestore.FieldValue.delete() } };
  await ref.set(patch, { merge:true });
}

async function getProfile(userId) {
  if (!userId) return null;
  try { const user = (await db.collection('users').doc(userId).get()).data(); return user?.profile; }
  catch(e){ console.warn('getProfile failed', e); return null; }
}

async function handlePostbackEvent(event, userId) {
  const data = new URLSearchParams(event.postback.data || '');
  const action = data.get('action');

  if (action === 'start_relay') {
    const targetUserId = data.get('uid');
    const groupId = event.source.groupId || event.source.roomId;
    if (!groupId) {
      await safeReplyOrPush(event.replyToken, userId, { type:'text', text:'この操作はグループ内で使ってね🌸' });
      return;
    }
    await relays.start(groupId, targetUserId, userId);
    await safePush(targetUserId, { type:'text', text:'事務局（見守りグループ）とつながりました。ここで会話できます🌸（終了は /end）' });
    await safeReplyOrPush(event.replyToken, userId, { type:'text', text:`リレー開始：このグループ ↔ ${String(targetUserId).slice(-6)} さん` });
    return;
  }

  if (event.postback.data === 'watch:disable') {
    await setWatchEnabled(userId, false);
    await safeReplyOrPush(event.replyToken, userId, { type:'text', text:'見守りを停止しました🌸' });
    return;
  }
  if (event.postback.data === 'watch:enable') {
    await setWatchEnabled(userId, true);
    await safeReplyOrPush(event.replyToken, userId, { type:'text', text:'見守りを有効にしました🌸' });
    return;
  }
  if (event.postback.data === 'watch:ok') {
    const ref = db.collection('users').doc(userId);
    await ref.set({ watchService:{ awaitingReply:false, lastReplyAt: Timestamp.now() } }, { merge:true });
    await scheduleNextPing(userId);
    await safeReplyOrPush(event.replyToken, userId, [
      { type:'text', text:'OK、受け取ったよ！💖 いつもありがとう😊' },
      { type:'sticker', packageId:'6325', stickerId:'10979913' }
    ]);
  }
}

async function handleFollowEvent(event) {
  audit('follow', { userId:event.source.userId });
  const userId = event.source.userId;
  const profile = await getProfile(userId);
  if (!profile) {
    await safeReplyOrPush(event.replyToken, userId, { type:'text', text:'こんにちは🌸 こころちゃんです。利用規約とプライバシーポリシーに同意の上、会員登録をお願いします。' });
  }
  await safePush(userId, makeRegistrationButtonsFlex(userId));
}
async function handleUnfollowEvent(event) {
  audit('unfollow', { userId:event.source.userId });
  await db.collection('users').doc(event.source.userId).set({ 'profile.isDeleted': true }, { merge:true });
}
async function handleJoinEvent(event) {
  audit('join', { groupId: event.source.groupId || event.source.roomId });
  if (event.source.groupId) { await setActiveWatchGroupId(event.source.groupId); }
  if (OWNER_GROUP_ID && OWNER_GROUP_ID === event.source.groupId) {
    await safePush(OWNER_GROUP_ID, { type:'text', text:`新しい監視グループを設定しました。\nグループID: ${event.source.groupId}` });
  }
}
async function handleLeaveEvent(event) {
  audit('leave', { groupId: event.source.groupId || event.source.roomId });
  if (event.source.groupId) await setActiveWatchGroupId(null);
}

// ---------- メイン ----------
async function answerOrgOrHomepage(event, userId, text) {
  if (isHomepageIntent(text)) {
    await safeReplyOrPush(event.replyToken, userId, { type:'text', text:`うん、あるよ🌸 ${ORG_SHORT_NAME}のホームページはこちらだよ✨ → ${HOMEPAGE_URL}` });
    return true;
  }
  if (/(怪しい|反社|あやしい)/i.test(text)) {
    await safeReplyOrPush(event.replyToken, userId, { type:'text', text:'そう思わせていたらごめんね…💦 でも、みんなのために頑張っている団体なんだ🌸' });
    await safeReplyOrPush(event.replyToken, userId, { type:'flex', altText:`${ORG_SHORT_NAME}のご案内`, contents: ORG_INFO_FLEX() });
    return true;
  }
  if (ORG_INTENT.test(text)) {
    await safeReplyOrPush(event.replyToken, userId, [
      { type:'text', text:`${ORG_NAME}は、${ORG_MISSION}をすすめる団体だよ🌸` },
      { type:'flex', altText:`${ORG_SHORT_NAME}のご案内`, contents: ORG_INFO_FLEX() }
    ]);
    return true;
  }
  if (/(会話おかしくない|噛み合ってない|団体なのに)/.test(text)) {
    await safeReplyOrPush(event.replyToken, userId, [
      { type:'text', text:'ごめんね、わかりにくかったかも…💦 もう一度だけご案内するね🌸' },
      { type:'flex', altText:`${ORG_SHORT_NAME}のご案内`, contents: ORG_INFO_FLEX() }
    ]);
    return true;
  }
  return false;
}

async function handleEvent(event) {
  const userId = event.source.userId;
  const isUser  = event.source.type === 'user';
  const isGroup = event.source.type === 'group';
  const isRoom  = event.source.type === 'room';
  const groupId = event.source.groupId || event.source.roomId || null;

  const text = event.message.type === 'text' ? (event.message.text || '') : '';
  const stickerId = event.message.type === 'sticker' ? event.message.stickerId : '';

  // グループ/ルーム内（先に処理）
  if (isGroup || isRoom) {
    if (text.includes('@見守りグループにする')) {
      await setActiveWatchGroupId(groupId);
      await safeReplyOrPush(event.replyToken, groupId, { type:'text', text:'OK！このグループを見守りグループとして設定したよ😊' });
      return;
    }
    if (/^\/relay\s+/.test(text)) {
      const m = text.trim().match(/^\/relay\s+([0-9A-Za-z_-]{10,})/);
      if (!m) { await safeReplyOrPush(event.replyToken, groupId, { type:'text', text:'使い方: /relay <ユーザーID>' }); return; }
      const targetUserId = m[1];
      await relays.start(groupId, targetUserId, userId);
      await safePush(targetUserId, { type:'text', text:'事務局（見守りグループ）とつながりました。ここで会話できます🌸（終了は /end）' });
      await safeReplyOrPush(event.replyToken, groupId, { type:'text', text:'リレーを開始しました。このグループの発言は本人に届きます。終了は /end' });
      return;
    }
    if (text.trim() === '/end') {
      await relays.stop(groupId);
      await safeReplyOrPush(event.replyToken, groupId, { type:'text', text:'リレーを終了しました。' });
      return;
    }
    const r = await relays.get(groupId);
    if (r?.isActive && r?.userId && event.message?.type === 'text') {
      await safePush(r.userId, { type:'text', text: text });
      await safeReplyOrPush(event.replyToken, groupId, { type:'text', text:'送ったよ✅（/end で終了）' });
    }
    return;
  }

  // 1) HP/団体（最優先）
  if (await answerOrgOrHomepage(event, userId, text)) return;

  // プロフィール・見守り状態
  let u = (await db.collection('users').doc(userId).get()).data() || {};
  const enabled = !!(u.watchService && u.watchService.enabled);

  // 2) 見守りのOK（テキスト/一部スタンプ）
  if (isUser && enabled && u.watchService?.awaitingReply && (
    /(^(ok|大丈夫|はい|元気|おけ|おっけ|okだよ|問題ない|なんとか|ありがとう)$)/i.test(text.trim()) ||
    /^(11537|11538|52002734|52002735|52002741|52002742|52002758|52002759|52002766|52002767)$/i.test(stickerId)
  )) {
    const ref = db.collection('users').doc(userId);
    await ref.set({ watchService:{ awaitingReply:false, lastReplyAt: Timestamp.now() } }, { merge:true });
    await scheduleNextPing(userId);
    await safeReplyOrPush(event.replyToken, userId, [
      { type:'text', text:'OK、受け取ったよ！💖 いつもありがとう😊' },
      { type:'sticker', packageId:'6325', stickerId:'10979913' }
    ]);
    return;
  }

  // 3) 見守りメニュー
  if (/見守り(サービス|登録|申込|申し込み)?|見守り設定|見守りステータス/.test(text)) {
    const en = !!(u.watchService && u.watchService.enabled);
    await safeReplyOrPush(event.replyToken, userId, makeWatchToggleFlex(en, userId));
    return;
  }

  // 4) 会員登録
  if (/(会員登録|入会|メンバー登録|登録したい)/i.test(text)) {
    await safeReplyOrPush(event.replyToken, userId, makeRegistrationButtonsFlex(userId));
    return;
  }

  // 4.5) 相談ワード → 1回だけ長め
  if (/(相談|そうだん)/.test(text)) {
    const msg = await counselingOnce(userId, text);
    if (msg) {
      await safeReplyOrPush(event.replyToken, userId, [
        { type:'text', text: msg },
        { type:'flex', altText:'連絡先', contents: makeDangerFlex().contents }
      ]);
      return;
    }
    // 既に1回済なら続行
  }

  // 5) 危険/詐欺判定
  const empathy = isEmpathy(text);
  const danger  = isDanger(text) || (empathy && STRONG_RISK.test(text)); // 強リスク併発は危険扱い
  const scam    = isScamMessage(text);

  // 共感のみ（通報なし）
  if (empathy && !danger) {
    const two = await gptTwoShorts('danger', text) ||
      '話してくれてありがとう。ひとりじゃないよ🌸 深呼吸して、水を一口飲んでみよう。';
    await safeReplyOrPush(event.replyToken, userId, { type:'text', text: two });
    return;
  }

  if (danger) {
    const two = await gptTwoShorts('danger', text) ||
      '大丈夫、まずは深呼吸しよう。ひとりじゃないよ、必要ならすぐ連絡しよう。';
    await safeReplyOrPush(event.replyToken, userId, [ { type:'text', text: two }, makeDangerFlex() ]);

    try {
      const WATCH_GROUP_ID = await getActiveWatchGroupId();
      const gid = WATCH_GROUP_ID || OFFICER_GROUP_ID;

      if (gid && SEND_OFFICER_ALERTS !== false) {
        // 危険通知 + 自動リレー開始 + 本人原文転送
        await safePush(gid, { type:'text', text:`【危険ワード】\nユーザーID末尾: ${userId.slice(-6)}\nメッセージ: ${sanitizeForLog(text)}` });
        await relays.start(gid, userId, 'system-danger');
        await safePush(userId, { type:'text', text:'事務局（見守りグループ）とつながりました。ここで会話できます🌸（終了は /end）' });
        await safePush(gid, { type:'text', text:'リレーを開始したよ（/end で終了）。' });
        await safePush(gid, { type:'text', text:`【本人】${sanitizeForLog(text)}` });
      } else {
        log.warn('danger alert skipped (no group or disabled)');
      }
    } catch (e) { briefErr('danger alert/relay failed', e); }
    return;
  }

  if (scam) {
    const two = await gptTwoShorts('scam', text) ||
      '大丈夫、まずは落ち着こう。公式アプリや正規サイトで確認して、怪しいリンクは開かないでね。';
    await safeReplyOrPush(event.replyToken, userId, [ { type:'text', text: two }, makeScamMessageFlex() ]);
    try {
      const WATCH_GROUP_ID = await getActiveWatchGroupId();
      const gid = WATCH_GROUP_ID || OFFICER_GROUP_ID;
      if (SCAM_ALERT_TO_WATCH_GROUP && gid) {
        await safePush(gid, { type:'text', text:`【詐欺の可能性】\nユーザーID末尾: ${userId.slice(-6)}\nメッセージ: ${sanitizeForLog(text)}` });
      }
    } catch (e) { briefErr('scam alert failed', e); }
    return;
  }

  // 6) 個チャ→見守りグループ中継（リレー有効時）
  try {
    const WATCH_GROUP_ID = await getActiveWatchGroupId();
    const r = await relays.get(WATCH_GROUP_ID);
    if (r?.isActive && r?.userId === userId && WATCH_GROUP_ID) {
      await safePush(WATCH_GROUP_ID, { type:'text', text:`【本人】${sanitizeForLog(text)}` });
    }
  } catch (e) { briefErr('relay user->group failed', e); }

  // 7) 雑談系（質問なら聞き返し）
  if (/[?？]$/.test(text) || /(好き|おすすめ|推し|何が|どれが)/.test(text)) {
    await safeReplyOrPush(event.replyToken, userId, { type:'text', text:'気になるね！あなたはどれが好き？よかったら教えてね🌸' });
    return;
  }

  // 8) フォールバック
  await safeReplyOrPush(event.replyToken, userId, { type:'text', text:'メッセージありがとう！よかったら、もう少し詳しく教えてね🌸' });
}

// ---------- Server ----------
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
