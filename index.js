'use strict';

/**
 * watch-service.js（決定版）
 * - 危険/詐欺：GPT-4o の安心2文 + カラフルFLEX（危険FLEXに“こころチャット事務局”必ず表示）
 * - 共感ワード（死にそう/つらい/辛い）は緊急扱いせず、安心2文のみ（通報なし）
 * - 「相談/そうだん」⇒ Gemini 1.5 Pro で1回だけじっくり回答、その後は通常
 * - 見守りメッセージ：30種類の挨拶テキスト + 「OKだよ」ボタンFLEX（2通送信）
 * - 見守りグループに詳細FLEX（LINEで連絡ボタン + 本人/近親者TEL）復活
 * - reply失効はpushへ自動フォールバック
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
let genAI = null; // Gemini
const _splitter = new GraphemeSplitter();
const toGraphemes = (s) => _splitter.splitGraphemes(String(s || ''));

const { Client, middleware } = require('@line/bot-sdk');

// ===== Utils =====
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
const toArr = (m) => Array.isArray(m) ? m : [m];

// ===== ENV =====
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
const SCAM_ALERT_TO_WATCH_GROUP = String(process.env.SCAM_ALERT_TO_WATCH_GROUP || 'true').toLowerCase() === 'true';

const EMERGENCY_CONTACT_PHONE_NUMBER = (process.env.EMERGENCY_CONTACT_PHONE_NUMBER || '').replace(/[^0-9+]/g,'');

const BOT_ADMIN_IDS = JSON.parse(process.env.BOT_ADMIN_IDS || '[]');
const OWNER_USER_ID = process.env.OWNER_USER_ID || BOT_ADMIN_IDS[0];
const OWNER_GROUP_ID = process.env.OWNER_GROUP_ID || null;

const WATCH_RUNNER = process.env.WATCH_RUNNER || 'internal';

const ORG_NAME       = process.env.ORG_NAME       || 'NPO法人コネクト';
const ORG_SHORT_NAME = process.env.ORG_SHORT_NAME || 'コネクト';
const HOMEPAGE_URL   = normalizeFormUrl(process.env.HOMEPAGE_URL || 'https://connect-npo.or.jp');
const ORG_MISSION    = process.env.ORG_MISSION    || 'こども・若者・ご高齢の方の安心と笑顔を守る活動';
const ORG_REP        = process.env.ORG_REP        || '（代表者）';
const ORG_CONTACT_TEL= (process.env.ORG_CONTACT_TEL || EMERGENCY_CONTACT_PHONE_NUMBER || '').replace(/[^0-9+]/g,'');

// OpenAI / Gemini init
try {
  if (OPENAI_API_KEY) {
    const OpenAI = require('openai');
    openai = new OpenAI({ apiKey: OPENAI_API_KEY });
  }
} catch (_) {}
try {
  if (GEMINI_API_KEY) {
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  }
} catch (_) {}

// ===== Firebase =====
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

// ===== LINE client =====
const client = new Client({ channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN, channelSecret: LINE_CHANNEL_SECRET });

// ===== HTTP =====
const httpAgent = new require('http').Agent({ keepAlive: true });
const httpsAgent = new require('https').Agent({ keepAlive: true });
const http = axios.create({ timeout: 6000, httpAgent, httpsAgent });

// ===== App =====
const PORT = process.env.PORT || 3000;
const app = express();
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 2));
app.use(helmet());
app.use('/webhook', rateLimit({ windowMs: 60_000, max: 100 }));

// ===== Logs / helpers =====
const audit = (e, detail) => console.log(`[AUDIT] ${e}`, JSON.stringify(detail));
const briefErr = (msg, e) => {
  const detail = e?.originalError?.response?.data || e?.response?.data || e?.message;
  console.error(`[ERR] ${msg}:`, JSON.stringify(detail, null, 2));
};
const sanitizeForLog = (text) => String(text).replace(/\s+/g, ' ').trim();
const maskPhone = (raw='') => {
  const s = String(raw).replace(/[^0-9+]/g, ''); if (!s) return '';
  const tail = s.slice(-4); const head = s.slice(0, -4).replace(/[0-9]/g, '＊'); return head + tail;
};

// reply -> push fallback
const toValidMsgArray = (messages) => toArr(messages).map(m => {
  if (m.type === 'flex' && !m.altText) m.altText = '通知があります';
  if (m.type === 'text') {
    m.text = String(m.text || '').trim() || '（内容なし）';
    if (m.text.length > 1800) m.text = m.text.slice(0, 1800);
  }
  return m;
});
async function safeReplyOrPush(replyToken, to, messages) {
  const arr = toValidMsgArray(messages);
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
  const arr = toValidMsgArray(messages);
  try { await client.pushMessage(to, arr); }
  catch (err) { briefErr('LINE push failed', err); }
}

// ===== 見守り =====
const JST_TZ = 'Asia/Tokyo';
const PING_INTERVAL_DAYS = 3;
const REMINDER_AFTER_HOURS = 24;
const ESCALATE_AFTER_HOURS = 29;
const OFFICER_NOTIFICATION_MIN_GAP_HOURS = 12;

const watchMessages = [
  "こんにちは🌸 こころだよ！今日も元気かな？",
  "やっほー😊 こころだよ！無理してない？",
  "こころちゃんだよ🌸 きょうはどんな日？",
  "深呼吸して、ちょっと一息つこ💖",
  "水分とれた？こころも今、お茶飲んでるよ🌸",
  "空を見てリフレッシュしよ✨",
  "がんばりすぎてない？少し休もうね😊",
  "こころは味方だよ、いつでも話してね💖",
  "今日もえらい！ちゃんと生きててえらい🌸",
  "お散歩できそう？むりなら心だけでもね💖",
  "眠れてるかな？寝る前ストレッチおすすめだよ🌙",
  "ごはん食べた？一口でもOKだよ🍚",
  "姿勢スッと！ちょっと肩回してこ😊",
  "無理しないで、ペース大事だよ🌸",
  "がんばり屋さん、少し休憩してこ💖",
  "こころ、いつも応援してるね📣",
  "目を閉じてゆっくり吸って、吐いて🌱",
  "やさしい音楽きこう🎧",
  "よくここまで来たね、えらい✨",
  "大丈夫、ここにいるよ💖",
  "朝日浴びれた？ちょこっとでOK☀️",
  "お水一口のもう💧",
  "予定はゆるくでいいよ🗓️",
  "心配なこと、メモに出して軽くしよ📝",
  "小さな楽しみ、ひとつ見つけよ🌸",
  "ゆっくりで大丈夫だよ😊",
  "こころと一緒に深呼吸しよ💖",
  "頑張りは見えてるよ、安心してね🌼",
  "失敗してもOK、次があるよ✨",
  "今日は自分にやさしくしてね💖",
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

// 見守りグループID
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

// 電話ボタン
const telMsgBtn = (label, phone) => {
  const s = String(phone || '').replace(/[^0-9+]/g, '');
  if (!s) return null;
  return { type:'button', style:'secondary', height:'sm', action:{ type:'uri', label, uri:`tel:${s}` } };
};

// 見守りアラート（詳細：LINEで連絡 + TEL）
const buildWatcherFlex = ({ name='—', address='—', selfPhone='', kinName='', kinPhone='', userId }) => ({
  type: 'flex',
  altText: '【見守りアラート】',
  contents: {
    type: 'bubble',
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: [
        { type: 'text', text: '【見守りアラート】', weight: 'bold', size: 'lg' },
        { type: 'text', text: `利用者：${name}`, wrap: true },
        { type: 'text', text: `住所：${address || '—'}`, size: 'sm', wrap: true },
        { type: 'text', text: `本人TEL：${maskPhone(selfPhone)}`, size: 'sm' },
        { type: 'text', text: `近親者：${kinName || '—'}（${maskPhone(kinPhone)}）`, size: 'sm', wrap: true },
      ]
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: [
        { type:'button', style:'primary',
          action:{ type:'postback', label:'LINEで連絡', data:`action=start_relay&uid=${encodeURIComponent(userId)}` } },
        telMsgBtn('本人に電話', selfPhone),
        telMsgBtn('近親者に電話', kinPhone),
      ].filter(Boolean)
    }
  }
});

// 既存の簡易版（残す）
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
          { type: 'text', text: `UserID：${userId}`, size: 'sm', wrap: true },
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
        }] : [{ type: 'text', text: '※TEL未登録', size: 'sm' }]
      }
    }
  };
};

// ===== 定期見守り（完全版） =====
async function checkAndSendPing() {
  const now = dayjs().tz('UTC');
  console.log(`[watch-service] start ${now.format('YYYY/MM/DD HH:mm:ss')} (UTC)`);

  const usersRef = db.collection('users');

  // 初期値ウォーム：enabled なのに nextPingAt 無し
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
  if (targets.length === 0) { console.log('[watch-service] no targets.'); return; }

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
        await safePush(doc.id, [
          { type:'text', text:`${pickWatchMsg()} 大丈夫なら「OKだよ💖」を押してね！` },
          {
            type:'flex', altText:'見守りチェック', contents:{
              type:'bubble', body:{ type:'box', layout:'vertical', contents:[
                { type:'text', text:'見守りチェック', weight:'bold', size:'xl' },
                { type:'text', text:'OKならボタンを押してね💖 返信やスタンプでもOK！', wrap:true, margin:'md' }
              ]},
              footer:{ type:'box', layout:'vertical', contents:[
                { type:'button', style:'primary', action:{ type:'postback', label:'OKだよ💖', data:'watch:ok', displayText:'OKだよ💖' } }
              ]}
            }
          }
        ]);
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
        await safePush(doc.id, [
          { type:'text', text:`${pickWatchMsg()} 昨日の見守りのOKまだ受け取れてないの… 大丈夫ならボタン押してね！` },
          {
            type:'flex', altText:'見守りリマインド', contents:{
              type:'bubble', body:{ type:'box', layout:'vertical', contents:[
                { type:'text', text:'見守りリマインド', weight:'bold', size:'xl' },
                { type:'text', text:'OKならボタンを押してね💖 返信やスタンプでもOK！', wrap:true, margin:'md' }
              ]},
              footer:{ type:'box', layout:'vertical', contents:[
                { type:'button', style:'primary', action:{ type:'postback', label:'OKだよ💖', data:'watch:ok', displayText:'OKだよ💖' } }
              ]}
            }
          }
        ]);
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
          const profile = udata.profile || {};
          const emergency = udata.emergency || {};
          const name = profile.displayName || '(不明)';
          const address = profile.address || '—';
          const selfPhone = profile.phone || '';
          const kinName = emergency.contactName || '';
          const kinPhone = emergency.contactPhone || '';

          const detailFlex = buildWatcherFlex({ name, address, selfPhone, kinName, kinPhone, userId: doc.id });

          await safePush(targetGroupId, [
            { type: 'text', text: '🚨見守り未応答が発生しました。対応可能な方はお願いします。' },
            detailFlex
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
      console.error('[ERROR] send/update failed:', e?.response?.data || e.message);
      await ref.set({ watchService: { notifyLockExpiresAt: firebaseAdmin.firestore.FieldValue.delete() } }, { merge: true });
    }
  }
  console.log(`[watch-service] end ${dayjs().tz('UTC').format('YYYY/MM/DD HH:mm:ss')} (UTC)`);
}

if (WATCH_RUNNER !== 'external') {
  cron.schedule('*/5 * * * *', () => { checkAndSendPing().catch(err => console.error('Cron job error:', err)); }, { scheduled:true, timezone:'UTC' });
}

// ===== FLEX（危険・詐欺・登録・見守り・団体） =====
const makeDangerFlex = () => {
  const officeBtn = (ORG_CONTACT_TEL || EMERGENCY_CONTACT_PHONE_NUMBER)
    ? [{ type: "button", style: "primary", height: "sm", color: "#000000",
         action: { type: "uri", label: "こころチャット事務局", uri: `tel:${(ORG_CONTACT_TEL || EMERGENCY_CONTACT_PHONE_NUMBER)}` } }]
    : [];
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
          { type: "button", style: "primary", height: "sm", color:"#FF6B6B", action: { type: "uri", label: "警察 (110)", uri: "tel:110" } },
          { type: "button", style: "primary", height: "sm", color:"#FF9F43", action: { type: "uri", label: "消防・救急 (119)", uri: "tel:119" } },
          { type: "button", style: "primary", height: "sm", color:"#4D96FF", action: { type: "uri", label: "いのちの電話", uri: "tel:0570064556" } },
          { type: "button", style: "primary", height: "sm", color:"#8E44AD", action: { type: "uri", label: "チャイルドライン", uri: "tel:0120997777" } },
          { type: "button", style: "primary", height: "sm", color:"#2E86C1", action: { type: "uri", label: "警視庁", uri: "tel:0335814321" } },
          ...officeBtn
        ]
      }
    }
  };
};

const makeScamMessageFlex = () => {
  const contents = [
    { type: "button", style: "primary", height: "sm", color:"#32CD32", action: { type: "uri", label: "国民生活センター", uri: "https://www.kokusen.go.jp/" } },
    { type: "button", style: "primary", height: "sm", color:"#FF4500", action: { type: "uri", label: "警察 (110)", uri: "tel:110" } },
    { type: "button", style: "primary", height: "sm", color:"#FFA500", action: { type: "uri", label: "消費者ホットライン (188)", uri: "tel:188" } },
  ];
  if (ORG_CONTACT_TEL || EMERGENCY_CONTACT_PHONE_NUMBER) {
    contents.push({ type: "button", style: "primary", height: "sm", color:"#000000",
      action: { type: "uri", label: "こころチャット事務局", uri: `tel:${(ORG_CONTACT_TEL || EMERGENCY_CONTACT_PHONE_NUMBER)}` } });
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
      ...(ORG_CONTACT_TEL || EMERGENCY_CONTACT_PHONE_NUMBER ? [{
        type:'button', style:'secondary', action:{ type:'uri', label:'こころチャット事務局', uri:`tel:${(ORG_CONTACT_TEL || EMERGENCY_CONTACT_PHONE_NUMBER)}` }
      }] : [])
    ]}
  }
});

const ORG_INFO_FLEX = () => ({
  type:'bubble',
  body:{ type:'box', layout:'vertical', spacing:'sm', contents:[
    { type:'text', text: ORG_NAME, weight:'bold', size:'lg' },
    { type:'text', text:`ミッション：${ORG_MISSION}`, wrap:true },
    { type:'text', text:`代表：${ORG_REP}`, wrap:true },
    ...(HOMEPAGE_URL ? [{ type:'text', text:`HP：${HOMEPAGE_URL}`, size:'sm', wrap:true }] : []),
  ]},
  footer:{ type:'box', layout:'vertical', spacing:'sm', contents:[
    ...(HOMEPAGE_URL ? [{ type:'button', style:'primary', action:{ type:'uri', label:'ホームページを見る', uri:HOMEPAGE_URL } }] : []),
    ...(ORG_CONTACT_TEL || EMERGENCY_CONTACT_PHONE_NUMBER ? [{ type:'button', style:'secondary', action:{ type:'uri', label:'電話する', uri:`tel:${(ORG_CONTACT_TEL || EMERGENCY_CONTACT_PHONE_NUMBER)}` } }] : [])
  ]}
});

// ===== 正規化 & 判定 =====
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
const SUSPICIOUS_INTENT = /(怪しい|胡散臭い|反社|やばい|詐欺(団体|っぽい)?)/i;

// ===== 危険/共感/詐欺ワード =====
const DANGER_WORDS = [
  "しにたい","死にたい","自殺","消えたい","リスカ","リストカット","OD","オーバードーズ",
  "殴られる","暴力","DV","虐待","パワハラ","セクハラ","ハラスメント",
  "ストーカー","盗撮","盗聴","助けて","たすけて","もう無理","もういやだ"
];
// 共感ワード（緊急FLEX・通報なし）
const EMPATHY_WORDS = ["死にそう","つらい","辛い"];
const SCAM_CORE_WORDS = [
  "詐欺","さぎ","サギ","フィッシング","架空請求","ワンクリック詐欺","特殊詐欺","当選","高額当選",
  "暗号資産","投資","未払い","滞納","訴訟","裁判","副業","MLM","マルチ商法","ログイン","認証","本人確認"
];
const BRANDS = /(amazon|アマゾン|楽天|rakuten|ヤマト|佐川|日本郵便|ゆうちょ|メルカリ|ヤフオク|apple|アップル|google|ドコモ|docomo|au|softbank|ソフトバンク|paypay|line|ライン)/i;
const BRAND_OK_CONTEXT = /(で(買い物|注文|購入|支払い|返品|返金|届いた|配達|発送)|プライム|タイムセール|レビュー|ギフト券|ポイント)/i;

const includesAny = (t, arr) => arr.some(w => t.includes(normalizeJa(w)));

function isDangerMessage(text) {
  const t = normalizeJa(text);
  if (includesAny(t, EMPATHY_WORDS)) return false; // 共感側に寄せる
  return includesAny(t, DANGER_WORDS);
}
function isEmpathyMessage(text) {
  const t = normalizeJa(text);
  return includesAny(t, EMPATHY_WORDS);
}
function isScamMessage(text) {
  const raw = String(text || '');
  const t = normalizeJa(raw);
  if (isHomepageIntent(raw)) return false;
  if (/(会員登録|入会|メンバー登録|登録したい)/i.test(raw)) return false;
  if (/(見守り(?:サービス)?)/.test(raw)) return false;

  if (includesAny(t, SCAM_CORE_WORDS)) return true;

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

// ===== 応答生成（2文） =====
function enforceTwoSentences(text, kind) {
  const parts = String(text || '').split('。').map(s => s.trim()).filter(Boolean);
  const templ2 = kind === 'danger'
    ? '深呼吸して、信頼できる人や緊急先にすぐ相談しよう。'
    : kind === 'scam'
      ? '公式アプリや正規サイトで確認して、怪しいリンクは押さないでね。'
      : 'ゆっくりで大丈夫だよ。いまの気持ち、こころが一緒に受けとめるね。';
  if (parts.length >= 2) return `${parts[0]}。${parts[1]}。`;
  if (parts.length === 1) return `${parts[0]}。${templ2}`;
  return templ2;
}
async function gptTwoShorts(kind, userText) {
  if (!openai) return null;
  const sys =
`あなたは14歳の女の子「皆守こころ」。やさしく安心させる日本語の**短い2文だけ**を出力。
1文目：安心・共感。2文目：今すぐできる安全な一歩（危険=緊急先/詐欺=公式確認/共感=小さなセルフケア）。
句点「。」で区切る。合計140文字以内。絵文字は最大2個。AIやプログラムには触れない。`;
  const asks = {
    danger: '相手はいじめ/暴力/自傷などで不安。安心→行動の2文を出力。',
    scam: '相手は詐欺を心配。安心→行動の2文を出力。',
    empathy: '相手はつらさを表現。安心→小さなセルフケアを促す2文を出力。'
  };
  try {
    const r = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role:'system', content: sys },
        { role:'user', content: `${asks[kind]}\nユーザー発言:「${String(userText).slice(0,200)}」` }
      ],
      max_tokens: 160, temperature: 0.6
    });
    return enforceTwoSentences((r.choices?.[0]?.message?.content || '').trim(), kind);
  } catch (e) {
    briefErr('gptTwoShorts failed', e);
    return null;
  }
}

// ===== Gemini（相談1回だけ） =====
async function geminiConsultOnce(userId, message) {
  // 既に使っていたらnull
  const ref = db.collection('users').doc(userId);
  const snap = await ref.get();
  const used = snap.exists && snap.data()?.ai?.consultOnceUsed;
  if (used) return null;

  let text = null;
  if (genAI) {
    try {
      const model = genAI.getGenerativeModel({ model: 'gemini-1.5-pro-latest' });
      const sys =
`あなたは14歳の女の子「皆守こころ」。やさしく寄り添い、安心させる短い段落で返信する。
禁止: 医療・法律の断定アドバイス、AIやプログラムの自己言及。
推奨: 共感→整理→一歩（話せる人/相談窓口/深呼吸）。語尾はやわらかく、顔文字・絵文字は控えめ（最大1個）。`;
      const prompt = `${sys}\n\n相手からの相談:\n${String(message).slice(0, 800)}\n\nこころの返事:`;
      const result = await model.generateContent(prompt);
      text = (await result.response.text()).trim();
    } catch (e) {
      briefErr('gemini consult failed', e);
    }
  }
  // 失敗時フォールバック
  if (!text) {
    text = '話してくれてありがとう。いまの気持ち、とっても大切だよ。まず深呼吸して、信頼できる人に一言だけでも伝えてみようね。';
  }

  // フラグを立てる
  await ref.set({ ai: { consultOnceUsed: true, consultOnceAt: Timestamp.now() } }, { merge: true });
  return text;
}

// ===== LINE webhook =====
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

// ===== Relays =====
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

// ===== Handlers =====
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
    await safeReplyOrPush(event.replyToken, userId, { type:'text', text:`リレー開始：このグループ ↔ ${targetUserId.slice(-6)} さん` });
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

// === メイン ===
async function handleEvent(event) {
  const userId = event.source.userId;
  const isUser  = event.source.type === 'user';
  const isGroup = event.source.type === 'group';
  const isRoom  = event.source.type === 'room';
  const groupId = event.source.groupId || event.source.roomId || null;

  const text = event.message.type === 'text' ? event.message.text : '';
  const stickerId = event.message.type === 'sticker' ? event.message.stickerId : '';

  // グループ/ルーム内
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
      await safePush(r.userId, { type:'text', text:`【見守り】${text}` });
    }
    return;
  }

  // 1) HP/団体（最優先）
  if (await answerOrgOrHomepage(event, userId, text)) return;

  // 相談系（Gemini 1回だけ）
  if (/(相談|そうだん)/i.test(text)) {
    const consult = await geminiConsultOnce(userId, text);
    if (consult) {
      await safeReplyOrPush(event.replyToken, userId, { type:'text', text: consult });
      return;
    }
    // 2回目以降は通常フローへ
  }

  // プロフィール・見守り状態
  let udoc = await db.collection('users').doc(userId).get();
  let u = udoc.data() || {};
  const enabled = !!(u.watchService && u.watchService.enabled);

  // 見守りOK
  if (isUser && enabled && u.watchService?.awaitingReply && (
    /(^(ok|大丈夫|はい|元気|おけ|おっけ|okだよ|問題ない|なんとか|ありがとう)$)/i.test(String(text||'').trim()) ||
    /^(11537|11538|52002734|52002735|52002741|52002742|52002758|52002759|52002766|52002767)$/i.test(String(stickerId||''))
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

  // 見守りメニュー
  if (/見守り(サービス|登録|申込|申し込み)?|見守り設定|見守りステータス/.test(text)) {
    const en = !!(u.watchService && u.watchService.enabled);
    await safeReplyOrPush(event.replyToken, userId, makeWatchToggleFlex(en, userId));
    return;
  }

  // 会員登録
  if (/(会員登録|入会|メンバー登録|登録したい)/i.test(text)) {
    await safeReplyOrPush(event.replyToken, userId, makeRegistrationButtonsFlex(userId));
    return;
  }

  // 危険/共感/詐欺ワード
  const empathy = isEmpathyMessage(text);
  const danger  = isDangerMessage(text);
  const scam    = isScamMessage(text);

  if (empathy || danger || scam) {
    const kind = empathy ? 'empathy' : danger ? 'danger' : 'scam';
    const two  = await gptTwoShorts(kind, text);
    const talk = two
      ? { type: 'text', text: two }
      : { type: 'text', text:
          empathy ? '気持ち伝えてくれてありがとう。今はゆっくりで大丈夫、一緒に深呼吸しよ。'
        : danger  ? '大丈夫、まずは深呼吸しよう。信頼できる人や緊急先にすぐ相談しよう。'
                  : '落ち着いて公式アプリや正規サイトで確認してね。怪しいリンクは開かないでね。' };

    // 危険のみ緊急FLEX、詐欺は詐欺FLEX、共感はFLEXなし
    const flex = danger ? makeDangerFlex() : (scam ? makeScamMessageFlex() : null);

    await safeReplyOrPush(event.replyToken, userId, flex ? [talk, flex] : [talk]);

    // 通知：危険＝常時 / 詐欺＝設定ON / 共感＝通知なし
    try {
      const WATCH_GROUP_ID = await getActiveWatchGroupId();
      const gid = WATCH_GROUP_ID || OFFICER_GROUP_ID;

      if (danger && gid && SEND_OFFICER_ALERTS !== false) {
        await safePush(gid, { type:'text', text:`【危険ワード】\nユーザー末尾: ${userId.slice(-6)}\n発言: ${sanitizeForLog(text)}` });
      }
      if (scam && gid && SCAM_ALERT_TO_WATCH_GROUP) {
        await safePush(gid, { type:'text', text:`【詐欺の可能性】\nユーザー末尾: ${userId.slice(-6)}\n発言: ${sanitizeForLog(text)}` });
      }
    } catch (e) { briefErr('alert to group failed', e); }

    return;
  }

  // 個チャ→見守りグループ リレー
  try {
    const WATCH_GROUP_ID = await getActiveWatchGroupId();
    const r = await relays.get(WATCH_GROUP_ID);
    if (r?.isActive && r?.userId === userId && WATCH_GROUP_ID) {
      await safePush(WATCH_GROUP_ID, { type:'text', text:`【本人】${text}` });
    }
  } catch (e) { briefErr('relay user->group failed', e); }

  // 団体/HP応答
  async function answerOrgOrHomepage(event, userId, text) {
    if (isHomepageIntent(text)) {
      await safeReplyOrPush(event.replyToken, userId, { type:'text', text:`うん、あるよ🌸 ${ORG_SHORT_NAME}のホームページはこちらだよ✨ → ${HOMEPAGE_URL}` });
      return true;
    }
    if (SUSPICIOUS_INTENT.test(text)) {
      await safeReplyOrPush(event.replyToken, userId, [
        { type:'text', text:'そう思わせていたらごめんね…💦 でも、みんなのために頑張っている団体だよ🌸' },
        { type:'flex', altText:`${ORG_SHORT_NAME}のご案内`, contents: ORG_INFO_FLEX() }
      ]);
      return true;
    }
    if (ORG_INTENT.test(text)) {
      await safeReplyOrPush(event.replyToken, userId, [
        { type:'text', text:`${ORG_NAME}は、${ORG_MISSION}をすすめる団体だよ🌸` },
        { type:'flex', altText:`${ORG_SHORT_NAME}のご案内`, contents: ORG_INFO_FLEX() }
      ]);
      return true;
    }
    return false;
  }

  // 該当なし：相槌
  await safeReplyOrPush(event.replyToken, userId, { type:'text', text:'ありがとう🌸 その気持ち、ちゃんと受け取ったよ。必要ならいつでも頼ってね💖' });
}

app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
