// watch-service.js  —— 2025-09-07 完全修正版（丸ごと置き換え）
// 目的：
// - 危険/詐欺ワード時に「GPT-4oの一言」+ FLEX を一括返信（失敗時は固定文に自動フォールバック／二重送信なし）
// - Amazon を詐欺判定に含むが、「Amazonで買い物した」等の通常文は除外
// - いじめ等の危険FLEXを“カラフルボタン”に（最下部に「こころチャット事務局」ボタン）
// - 見守りUIを「見守り」だけで起動（トグル表示）
// - 29時間未応答→見守りグループに通知（TELボタン付き）
// - Firestoreインデックス未作成でも動くフォールバック取得を維持
// - replyToken無効時は push に自動切替（ただし一度だけ／二重送信防止）
// - 詐欺検知時も見守りグループ通知（軽い注意喚起）

'use strict';

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

// ====== ★ GPT-4o の“一言”用（キーが無ければ自動で無効化） ======
let openai = null;
try {
  const OpenAI = require('openai');
  if (process.env.OPENAI_API_KEY) {
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
} catch { /* ランタイムにopenaiが無い場合は無視 */ }

const _splitter = new GraphemeSplitter();
const toGraphemes = (s) => _splitter.splitGraphemes(String(s || ''));

const { Client, middleware } = require('@line/bot-sdk');

const normalizeFormUrl = s => {
  let v = String(s || '').trim();
  if (!v) return '';
  v = v.replace(/^usp=header\s*/i, '');
  if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
  try { new URL(v); return v; } 
  catch { console.warn('[WARN] Invalid form URL in env:', s); return ''; }
};
const prefillUrl = (base, params) => {
  if (!base) return '#';
  const url = new URL(base);
  for (const [k, val] of Object.entries(params)) {
    if (val) url.searchParams.set(k, val);
  }
  return url.toString();
};

// ====== ENV ======
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET       = process.env.LINE_CHANNEL_SECRET;

const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o';
const EMERGENCY_CONTACT_PHONE_NUMBER = process.env.EMERGENCY_CONTACT_PHONE_NUMBER || '';

const AGREEMENT_FORM_BASE_URL = normalizeFormUrl(process.env.AGREEMENT_FORM_BASE_URL);
const ADULT_FORM_BASE_URL = normalizeFormUrl(process.env.ADULT_FORM_BASE_URL);
const STUDENT_MIDDLE_HIGH_UNI_FORM_BASE_URL = normalizeFormUrl(process.env.STUDENT_MIDDLE_HIGH_UNI_FORM_BASE_URL);
const WATCH_SERVICE_FORM_BASE_URL = normalizeFormUrl(process.env.WATCH_SERVICE_FORM_BASE_URL);
const MEMBER_CHANGE_FORM_BASE_URL = normalizeFormUrl(process.env.MEMBER_CHANGE_FORM_BASE_URL);
const MEMBER_CANCEL_FORM_BASE_URL = normalizeFormUrl(process.env.MEMBER_CANCEL_FORM_BASE_URL);

const OFFICER_GROUP_ID = (process.env.OFFICER_GROUP_ID || '').trim();
const SEND_OFFICER_ALERTS = process.env.SEND_OFFICER_ALERTS !== 'false'; // 危険/詐欺の通知許可

const BOT_ADMIN_IDS = JSON.parse(process.env.BOT_ADMIN_IDS || '[]');
const OWNER_USER_ID = process.env.OWNER_USER_ID || BOT_ADMIN_IDS[0] || null;
const OWNER_GROUP_ID = process.env.OWNER_GROUP_ID || null;

const WATCH_RUNNER = process.env.WATCH_RUNNER || 'internal';
const WATCH_LOG_LEVEL = (process.env.WATCH_LOG_LEVEL || 'info').toLowerCase();

const WATCH_SERVICE_FORM_LINE_USER_ID_ENTRY_ID = process.env.WATCH_SERVICE_FORM_LINE_USER_ID_ENTRY_ID || 'entry.312175830';
const AGREEMENT_FORM_LINE_USER_ID_ENTRY_ID     = process.env.AGREEMENT_FORM_LINE_USER_ID_ENTRY_ID || 'entry.790268681';
const STUDENT_MIDDLE_HIGH_UNI_FORM_LINE_USER_ID_ENTRY_ID = process.env.STUDENT_MIDDLE_HIGH_UNI_FORM_LINE_USER_ID_ENTRY_ID || 'entry.1100280108';
const ADULT_FORM_LINE_USER_ID_ENTRY_ID = process.env.ADULT_FORM_LINE_USER_ID_ENTRY_ID || 'entry.1694651394';
const MEMBER_CHANGE_FORM_LINE_USER_ID_ENTRY_ID = process.env.MEMBER_CHANGE_FORM_LINE_USER_ID_ENTRY_ID || 'entry.743637502';
const MEMBER_CANCEL_FORM_LINE_USER_ID_ENTRY_ID = process.env.MEMBER_CANCEL_FORM_LINE_USER_ID_ENTRY_ID || MEMBER_CHANGE_FORM_LINE_USER_ID_ENTRY_ID;

// ====== Firebase ======
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

// ====== LINE ======
const client = new Client({
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: LINE_CHANNEL_SECRET,
});

// ====== HTTP共通 ======
const httpAgent  = new require('http').Agent({ keepAlive: true });
const httpsAgent = new require('https').Agent({ keepAlive: true });
const http = axios.create({ timeout: 6000, httpAgent, httpsAgent });

// ====== APP ======
const PORT = process.env.PORT || 3000;
const app = express();
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 2));
app.use(helmet());
app.use('/webhook', rateLimit({ windowMs: 60_000, max: 100 }));

const audit = (event, detail) => console.log(`[AUDIT] ${event}`, JSON.stringify(detail));
const debug = (message) => console.log(`[DEBUG] ${message}`);
const briefErr = (msg, e) => {
  const detail = e?.originalError?.response?.data || e?.response?.data || e?.message || e;
  console.error(`[ERR] ${msg}:`, JSON.stringify(detail, null, 2));
};
const sanitizeForLog = (text) => String(text).replace(/\s+/g, ' ').trim();

// ====== 会員プラン別モデル（将来拡張用） ======
const MEMBERSHIP_CONFIG = {
  guest:      { dailyLimit: 5,  model: 'gemini-1.5-flash-latest' },
  member:     { dailyLimit: 20, model: OPENAI_MODEL || 'gpt-4o-mini' },
  subscriber: { dailyLimit: -1, model: OPENAI_MODEL || 'gpt-4o-mini' },
  admin:      { dailyLimit: -1, model: OPENAI_MODEL || 'gpt-4o-mini' },
};

// ====== 見守り設定 ======
const JST_TZ = 'Asia/Tokyo';
const PING_INTERVAL_DAYS = 3;
const REMINDER_AFTER_HOURS = 24;
const ESCALATE_AFTER_HOURS = 29;       // ★ 29時間
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
  dayjs(fromDate).tz(JST_TZ).add(PING_INTERVAL_DAYS, 'day').hour(15).minute(0).second(0).millisecond(0).toDate();

async function scheduleNextPing(userId, fromDate = new Date()) {
  const nextAt = nextPingAtFrom(fromDate);
  await db.collection('users').doc(userId).set({
    watchService: {
      nextPingAt: Timestamp.fromDate(nextAt),
      awaitingReply: false,
      lastReminderAt: firebaseAdmin.firestore.FieldValue.delete(),
    }
  }, { merge: true });
}

// ====== 共通 push/reply ======
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
        m.text = String(m.text || '').trim() || '（内容なし）';
        if (m.text.length > 1800) m.text = m.text.slice(0, 1800);
      }
    }
    await client.pushMessage(to, arr);
  } catch (err) {
    briefErr('LINE push failed', err);
  }
}

// replyTokenが無効/期限切れのときは push に自動フォールバック（1回のみ）
async function safeReplyOrPush(replyToken, toUserId, messages) {
  try {
    await client.replyMessage(replyToken, messages);
  } catch (e) {
    const msg = e?.originalError?.response?.data?.message || e?.message || '';
    if (/Invalid reply token/i.test(msg)) {
      // 期限切れなら push に切り替え（重複防止のためここでのみ）
      await safePush(toUserId, messages);
    } else {
      throw e;
    }
  }
}

// ====== 見守りグループID ======
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
    await getWatchGroupDoc().set({
      groupId: firebaseAdmin.firestore.FieldValue.delete(),
      updatedAt: Timestamp.now()
    }, { merge: true });
    return;
  }
  if (!/^C[0-9A-Za-z_-]{20,}$/.test(gid)) return;
  await getWatchGroupDoc().set({ groupId: gid, updatedAt: Timestamp.now() }, { merge: true });
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
          type: 'button', style: 'primary', color: '#34C759',
          action: { type: 'uri', label: '📞 発信する', uri: `tel:${tel}` }
        }] : [{ type: 'text', text: '※TEL未登録', size: 'sm', color: '#888' }]
      }
    }
  };
};

// ====== 見守りメイン処理（5分ごと or 外部cron） ======
async function checkAndSendPing() {
  const now = dayjs().tz('UTC');
  console.log(`[watch-service] start ${now.format('YYYY/MM/DD HH:mm:ss')} (UTC)`);

  // 欠落自己修復（enabledでnextPingAt欠落を埋める）
  const warmupFill = async (_now) => {
    const usersRef = db.collection('users');
    const snap = await usersRef.where('watchService.enabled', '==', true).limit(200).get();
    let batch = db.batch(), cnt=0;
    for (const d of snap.docs) {
      const ws = (d.data().watchService)||{};
      if (!ws.awaitingReply && !ws.nextPingAt) {
        batch.set(d.ref, { watchService: { nextPingAt: Timestamp.fromDate(nextPingAtFrom(_now.toDate())) } }, { merge:true });
        cnt++;
      }
    }
    if (cnt) await batch.commit();
  };

  // インデックス未作成時も動く“フォールバック取得”
  const fetchTargets = async (_now) => {
    const usersRef = db.collection('users');
    const targets = [];
    try {
      const snap = await usersRef
        .where('watchService.enabled', '==', true)
        .where('watchService.awaitingReply', '==', false)
        .where('watchService.nextPingAt', '<=', _now.toDate())
        .limit(200).get();
      targets.push(...snap.docs);
    } catch {
      const snap = await usersRef.where('watchService.enabled', '==', true).limit(500).get();
      for (const d of snap.docs) {
        const ws = (d.data().watchService)||{};
        if (!ws.awaitingReply && ws.nextPingAt?.toDate?.() && ws.nextPingAt.toDate() <= _now.toDate()) {
          targets.push(d);
        }
      }
    }
    try {
      const snap = await usersRef
        .where('watchService.enabled', '==', true)
        .where('watchService.awaitingReply', '==', true)
        .limit(200).get();
      targets.push(...snap.docs);
    } catch {
      const snap = await usersRef.where('watchService.enabled', '==', true).limit(500).get();
      for (const d of snap.docs) {
        const ws = (d.data().watchService)||{};
        if (ws.awaitingReply === true) targets.push(d);
      }
    }
    const map = new Map();
    for (const d of targets) map.set(d.id, d);
    return [...map.values()];
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
      const nowTs = Timestamp.now();
      const lockUntil = ws.notifyLockExpiresAt?.toDate?.() || new Date(0);
      if (lockUntil.getTime() > nowTs.toMillis()) return false;

      const nextPingAt = ws.nextPingAt?.toDate?.() || null;
      const awaiting = !!ws.awaitingReply;
      if (!awaiting && (!nextPingAt || nextPingAt.getTime() > nowTs.toMillis())) return false;

      const until = new Date(nowTs.toMillis() + 120 * 1000);
      tx.set(ref, { watchService: { notifyLockExpiresAt: Timestamp.fromDate(until) } }, { merge: true });
      return true;
    });
    if (!locked) continue;

    try {
      const s  = await ref.get();
      const u  = s.data() || {};
      const ws = u.watchService || {};
      const awaiting       = !!ws.awaitingReply;
      const lastPingAt     = ws.lastPingAt?.toDate?.()     ? dayjs(ws.lastPingAt.toDate())     : null;
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
            type:'flex', altText:'見守りチェック',
            contents: {
              type:'bubble',
              body: { type:'box', layout:'vertical', contents:[
                { type:'text', text:'見守りチェック', weight:'bold', size:'xl' },
                { type:'text', text:'OKならボタンを押してね💖 返信やスタンプでもOK！', wrap:true, margin:'md' }
              ]},
              footer: { type:'box', layout:'vertical', contents:[
                { type:'button', style:'primary', color:'#34C759',
                  action:{ type:'postback', label:'OKだよ💖', data:'watch:ok', displayText:'OKだよ💖' } }
              ]}
            }
          }
        ]);
        await ref.set({
          watchService: {
            lastPingAt: Timestamp.now(),
            awaitingReply: true,
            nextPingAt: firebaseAdmin.firestore.FieldValue.delete(),
            lastReminderAt: firebaseAdmin.firestore.FieldValue.delete(),
            notifyLockExpiresAt: firebaseAdmin.firestore.FieldValue.delete(),
          }
        }, { merge: true });
      }
      else if (mode === 'remind') {
        await safePush(doc.id, [
          { type:'text', text:`${pickWatchMsg()} 昨日の見守りのOKまだ受け取れてないの… 大丈夫ならボタン押してね！` },
          {
            type:'flex', altText:'見守りリマインド',
            contents: {
              type:'bubble',
              body: { type:'box', layout:'vertical', contents:[
                { type:'text', text:'見守りリマインド', weight:'bold', size:'xl' },
                { type:'text', text:'OKならボタンを押してね💖 返信やスタンプでもOK！', wrap:true, margin:'md' }
              ]},
              footer: { type:'box', layout:'vertical', contents:[
                { type:'button', style:'primary', color:'#34C759',
                  action:{ type:'postback', label:'OKだよ💖', data:'watch:ok', displayText:'OKだよ💖' } }
              ]}
            }
          }
        ]);
        await ref.set({ watchService: { lastReminderAt: Timestamp.now(),
          notifyLockExpiresAt: firebaseAdmin.firestore.FieldValue.delete() } }, { merge:true });
      }
      else if (mode === 'escalate') {
        const targetGroupId =
          (await getActiveWatchGroupId()) ||
          process.env.WATCH_GROUP_ID ||
          OFFICER_GROUP_ID;

        const canNotify = targetGroupId && (!lastNotifiedAt || now.diff(lastNotifiedAt, 'hour') >= OFFICER_NOTIFICATION_MIN_GAP_HOURS);

        if (canNotify) {
          const udoc  = await db.collection('users').doc(doc.id).get();
          const udata = udoc.exists ? (udoc.data() || {}) : {};
          const elapsedH = lastPingAt ? dayjs().utc().diff(dayjs(lastPingAt).utc(), 'hour') : ESCALATE_AFTER_HOURS;
          const tel = udata?.profile?.phone || udata?.emergency?.contactPhone || EMERGENCY_CONTACT_PHONE_NUMBER || '';
          const flex = buildWatchFlex(udata, doc.id, elapsedH, tel);
          await safePush(targetGroupId, [
            { type:'text', text:'🚨見守り未応答が発生しました。対応可能な方はお願いします。' },
            flex
          ]);
        }

        await ref.set({
          watchService: {
            lastNotifiedAt: Timestamp.now(),
            awaitingReply: false,
            lastReminderAt: firebaseAdmin.firestore.FieldValue.delete(),
            nextPingAt: Timestamp.fromDate(nextPingAtFrom(dayjs().tz(JST_TZ).toDate())),
            notifyLockExpiresAt: firebaseAdmin.firestore.FieldValue.delete(),
          }
        }, { merge:true });
      }
    } catch (e) {
      briefErr('watch escalate/send failed', e);
      await ref.set({ watchService: { notifyLockExpiresAt: firebaseAdmin.firestore.FieldValue.delete() } }, { merge:true });
    }
  }

  console.log(`[watch-service] end ${dayjs().tz('UTC').format('YYYY/MM/DD HH:mm:ss')} (UTC)`);
}

// 内部cron（RenderのWeb Serviceで実行時）
if (WATCH_RUNNER !== 'external') {
  cron.schedule('*/5 * * * *', () => {
    checkAndSendPing().catch(err => console.error('Cron job error:', err));
  }, { scheduled: true, timezone: 'UTC' });
}

// ====== FLEXテンプレ（危険：カラフル+最下部に事務局TEL） ======
const EMERGENCY_FLEX_MESSAGE = (() => {
  const telBtn = EMERGENCY_CONTACT_PHONE_NUMBER ? [{
    type: "button", style: "primary", height: "sm", color: "#111111",
    action: { type: "uri", label: "こころチャット事務局", uri: `tel:${String(EMERGENCY_CONTACT_PHONE_NUMBER).replace(/[^0-9+]/g, '')}` }
  }] : [];
  return {
    type: "bubble",
    body: {
      type: "box", layout: "vertical",
      contents: [
        { type: "text", text: "🚨【危険ワード検知】🚨", weight: "bold", size: "xl" },
        { type: "text", text: "緊急時にはこちらに連絡してね。いまは安全第一だよ🌸", margin: "md", wrap: true }
      ]
    },
    footer: {
      type: "box", layout: "vertical", spacing: "sm",
      contents: [
        { type:"button", style:"primary", height:"sm", color:"#FF3B30",
          action:{ type:"uri", label:"警察 (110)", uri:"tel:110" }},
        { type:"button", style:"primary", height:"sm", color:"#FF9500",
          action:{ type:"uri", label:"消防・救急 (119)", uri:"tel:119" }},
        { type:"button", style:"primary", height:"sm", color:"#AF52DE",
          action:{ type:"uri", label:"いのちの電話", uri:"tel:0570064556" }},
        { type:"button", style:"primary", height:"sm", color:"#007AFF",
          action:{ type:"uri", label:"警視庁", uri:"tel:0335814321" }},
        ...telBtn
      ]
    }
  };
})();

// 詐欺FLEX（現行の色味を維持）
const makeScamMessageFlex = () => {
  const contents = [
    { type:"button", style:"primary", color:"#32CD32",
      action:{ type:"uri", label:"国民生活センター", uri:"https://www.kokusen.go.jp/" } },
    { type:"button", style:"primary", color:"#FF4500",
      action:{ type:"uri", label:"警察 (110)", uri:"tel:110" } },
    { type:"button", style:"primary", color:"#FFA500",
      action:{ type:"uri", label:"消費者ホットライン (188)", uri:"tel:188" } },
  ];
  if (EMERGENCY_CONTACT_PHONE_NUMBER) {
    contents.push({ type:"button", style:"primary", color:"#111111",
      action:{ type:"uri", label:"こころチャット事務局", uri:`tel:${String(EMERGENCY_CONTACT_PHONE_NUMBER).replace(/[^0-9+]/g, '')}` }});
  }
  return {
    type: "bubble",
    body: { type: "box", layout: "vertical", contents: [
      { type: "text", text: "【詐欺注意】", weight: "bold", size: "xl", align: "center" },
      { type: "text", text: "怪しい話は開かず・教えず・払わず！困ったら下の窓口へ🌸", wrap: true, margin: "md" }
    ]},
    footer: { type: "box", layout: "vertical", spacing: "sm", contents }
  };
};

// 会員登録FLEX
const makeRegistrationButtonsFlex = (userId) => ({
  type: "bubble",
  body: { type: "box", layout: "vertical", contents: [
    { type:"text", text:"どの会員になるか選んでね🌸", wrap:true, weight:"bold", size:"md" }
  ]},
  footer: {
    type: "box", layout: "vertical", spacing: "sm",
    contents: [
      { type:"button", style:"primary", height:"sm", color:"#90EE90",
        action:{ type:"uri", label:"小学生（同意書）",
          uri: prefillUrl(AGREEMENT_FORM_BASE_URL, { [AGREEMENT_FORM_LINE_USER_ID_ENTRY_ID]: userId }) } },
      { type:"button", style:"primary", height:"sm", color:"#ADD8E6",
        action:{ type:"uri", label:"学生（中学・高校・大学）",
          uri: prefillUrl(STUDENT_MIDDLE_HIGH_UNI_FORM_BASE_URL, { [STUDENT_MIDDLE_HIGH_UNI_FORM_LINE_USER_ID_ENTRY_ID]: userId }) } },
      { type:"button", style:"primary", height:"sm", color:"#87CEFA",
        action:{ type:"uri", label:"大人（一般）",
          uri: prefillUrl(ADULT_FORM_BASE_URL, { [ADULT_FORM_LINE_USER_ID_ENTRY_ID]: userId }) } },
      { type:"button", style:"primary", height:"sm", color:"#FFC0CB",
        action:{ type:"uri", label:"会員情報を変更する",
          uri: prefillUrl(MEMBER_CHANGE_FORM_BASE_URL, { [MEMBER_CHANGE_FORM_LINE_USER_ID_ENTRY_ID]: userId }) } },
      { type:"button", style:"primary", height:"sm", color:"#DDA0DD",
        action:{ type:"uri", label:"退会",
          uri: prefillUrl(MEMBER_CANCEL_FORM_BASE_URL, { [MEMBER_CANCEL_FORM_LINE_USER_ID_ENTRY_ID]: userId }) } },
    ]
  }
});

// 見守りトグルFLEX（「見守り」だけで出す）
const makeWatchToggleFlex = (enabled, userId) => ({
  type: 'bubble',
  body: { type:'box', layout:'vertical', contents:[
    { type:'text', text:'見守りサービス', weight:'bold', size:'xl' },
    { type:'text', text: enabled ? '現在：有効' : '現在：停止', margin:'md' }
  ]},
  footer: { type:'box', layout:'vertical', spacing:'sm', contents:[
    { type:'button', style:'primary', color: enabled ? '#FF3B30' : '#34C759',
      action:{ type:'postback', label: enabled ? '見守りを停止する' : '見守りを有効にする', data: enabled ? 'watch:disable' : 'watch:enable' } },
    ...(WATCH_SERVICE_FORM_BASE_URL ? [{
      type:'button', style:'secondary',
      action:{ type:'uri', label:'見守りの説明/設定フォーム', uri: prefillUrl(WATCH_SERVICE_FORM_BASE_URL, { [WATCH_SERVICE_FORM_LINE_USER_ID_ENTRY_ID]: userId }) }
    }] : [])
  ]}
});

// ===== Relay helpers =====
const relays = {
  doc: (groupId) => db.collection('relays').doc(groupId),
  async get(groupId) { const s = await this.doc(groupId).get(); return s.exists ? s.data() : null; },
  async start(groupId, userId, startedBy) {
    await this.doc(groupId).set({ groupId, userId, isActive:true, startedAt:Timestamp.now(), startedBy }, { merge:true });
  },
  async stop(groupId) { await this.doc(groupId).set({ isActive:false, stoppedAt:Timestamp.now() }, { merge:true }); }
};

async function setWatchEnabled(userId, enabled) {
  const ref = db.collection('users').doc(userId);
  const patch = enabled
    ? { watchService: { enabled:true, awaitingReply:false, nextPingAt: Timestamp.now() } }
    : { watchService: { enabled:false, awaitingReply:false, nextPingAt: firebaseAdmin.firestore.FieldValue.delete() } };
  await ref.set(patch, { merge:true });
}

async function getProfile(userId) {
  if (!userId) return null;
  try { const user = (await db.collection('users').doc(userId).get()).data(); return user?.profile; }
  catch (e) { console.warn('getProfile failed', e); }
  return null;
}

const lineMiddleware = middleware({ channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN, channelSecret: LINE_CHANNEL_SECRET });

// ====== ルーティング ======
app.post('/webhook', lineMiddleware, async (req, res) => {
  res.sendStatus(200);
  const events = req.body.events;
  if (!events || events.length === 0) return;
  try {
    await Promise.all(events.map(async (event) => {
      if (event.type === 'message')      await handleEvent(event);
      else if (event.type === 'postback') await handlePostbackEvent(event, event.source.userId);
      else if (event.type === 'follow')   await handleFollowEvent(event);
      else if (event.type === 'unfollow') await handleUnfollowEvent(event);
      else if (event.type === 'join')     await handleJoinEvent(event);
      else if (event.type === 'leave')    await handleLeaveEvent(event);
    }));
  } catch (err) {
    console.error("🚨 Webhook処理中に予期せぬエラー:", err);
  }
});

app.get('/', (_req, res) => res.send('Kokoro Bot is running!'));

app.get('/cron/watch-ping', async (req, res) => {
  const isLocal = req.hostname === 'localhost' || req.hostname === '127.0.0.1';
  if (!isLocal && WATCH_RUNNER !== 'external') {
    res.status(403).send('Forbidden: Not running in external cron mode.');
    return;
  }
  await checkAndSendPing();
  res.send('OK');
});

// ====== 危険/詐欺ワード検知（Amazon誤検知回避付き） ======
const toHiragana = (s) => s.replace(/[\u30a1-\u30f6]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60));
const nfkc = (s) => s.normalize('NFKC');
const normalizeJa = (s) => toHiragana(nfkc(String(s || '')).toLowerCase());

const DANGER_WORDS = [
  "しにたい","死にたい","自殺","消えたい","リスカ","リストカット","od","オーバードーズ",
  "殴られる","たたかれる","暴力","dv","無理やり","虐待","パワハラ","セクハラ","ハラスメント",
  "いじめ","ｲｼﾞﾒ","嫌がらせ","ストーカー","盗撮","盗聴",
  "お金がない","死にそう","辛い","つらい","苦しい","助けて","もう無理","もういやだ",
  "相談したい","助けてください"
];
const SCAM_WORDS = [
  "詐欺","さぎ","サギ","ﾌｨｯｼﾝｸﾞ","フィッシング","架空請求","ワンクリック","特殊詐欺","当選",
  "高額","宝くじ","ロト","ビットコイン","投資","バイナリー","未払い","滞納","訴訟","裁判",
  "副業","在宅ワーク","転売","mlm","マルチ商法","絶対儲かる","簡単に稼げる","限定","無料",
  "ログイン","個人情報","有料サイト","登録","退会","解約","クレジットカード","クレカ",
  "口座番号","パスワード","ワンタイム","認証","リンク","url","クリック","請求","停止","未納"
];

function isDangerMessage(text) {
  const norm = normalizeJa(text);
  return DANGER_WORDS.some(w => norm.includes(normalizeJa(w)));
}

// ★ Amazon：単なる購入/注文の話題は除外。詐欺に典型的な語と「併出」した時のみ真
function amazonLooksBenign(t) {
  // 「買い物/購入/注文/配達/届いた/プライム」などは benign
  const benign = /(買い物|購入|買った|注文|オーダー|配達|届い|発送|到着|プライム|セール|ポイント)/;
  const suspicious = /(詐欺|さぎ|偽|なりすまし|ﾌｨｯｼﾝｸﾞ|フィッシング|sms|スミッシング|ログイン|認証|アカウント|停止|請求|未納|リンク|url|クリック|カード|クレカ|パスワード|注文してない|覚えがない)/;
  if (!/amazon|アマゾン/i.test(t)) return false;
  if (suspicious.test(t)) return false;   // 怪しい語と併出 → 詐欺扱い
  if (benign.test(t)) return true;        // benign文脈 → 除外
  return false;                           // それ以外は判断保留（他ルールに委ねる）
}

function isScamMessage(text) {
  const t = normalizeJa(text);
  // ホームページ案内は除外
  if (isHomepageIntent(text)) return false;

  // 会員登録/見守りは除外
  const REG = /(会員登録|入会|メンバー登録|登録したい)/i;
  const WATCH = /(見守り(?:サービス)?(?:登録|申込|申し込み)?|見守り)/i;
  if (REG.test(text) || WATCH.test(text)) return false;

  // Amazon誤検知ガード
  if (amazonLooksBenign(text)) return false;

  if (/(詐欺|さぎ)/.test(t)) return true;

  const hasUrl = /(https?:\/\/|t\.co\/|bit\.ly|tinyurl\.com|lnkd\.in|\.ru\/|\.cn\/|\.top\/|\.xyz\/)/i.test(text);
  const money = /(当選|高額|配当|振込|送金|入金|手数料|ビットコイン|暗号資産|投資)/;
  const urgency = /(至急|今すぐ|本日中|限定|緊急|アカウント停止|認証|ログイン)/;
  const credAsk = /(id|パスワード|ワンタイム|コード|口座番号|クレジット|カード番号|個人情報).{0,8}(入力|送信|教えて|提出)/;

  if (hasUrl && (money.test(t) || urgency.test(t) || credAsk.test(t))) return true;
  if (money.test(t) && urgency.test(t)) return true;
  if (credAsk.test(t) && urgency.test(t)) return true;

  return SCAM_WORDS.some(w => t.includes(normalizeJa(w)));
}

const INAPPROPRIATE = ["セックス","セフレ","エッチ","av","アダルト","ポルノ","挿入","射精","オナニー","妊娠","中出し","強姦","売春","殺人","ﾊｧﾊｧ","はぁはぁ","はあはあ"];
const SWEAR = ["しね","死ね"];
function isInappropriateMessage(text){ const n=normalizeJa(text); return INAPPROPRIATE.some(w=>n.includes(normalizeJa(w))); }
function isSwearMessage(text){ const n=normalizeJa(text); return SWEAR.some(w=>n.includes(normalizeJa(w))); }

// ====== GPT-4o“一言”（失敗時は null） ======
async function crisisOneLiner(kind, userText) {
  if (!openai) return null;
  const sys = (kind === 'danger')
    ? "あなたは困っている人を安心させる支援員です。日本語で、60文字以内の短い一言だけで返事してください。呼吸を促し、安全確保を最優先に。敬語は硬くしすぎない。絵文字1つまで可。"
    : "あなたは詐欺被害防止の支援員です。日本語で、60文字以内の短い注意喚起だけ返してください。リンクを開かない・個人情報を出さない旨を含めて。";
  try {
    const r = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role: 'system', content: sys },
        { role: 'user',   content: `ユーザーの発言: ${String(userText).slice(0, 300)}` }
      ],
      temperature: 0.4,
      max_tokens: 80,
    });
    const text = (r.choices?.[0]?.message?.content || '').trim();
    return text ? text.slice(0, 120) : null;
  } catch (e) {
    briefErr('openai one-liner failed', e);
    return null;
  }
}

// ====== Event handlers ======
async function handlePostbackEvent(event, userId) {
  const postback = event.postback;
  const data = new URLSearchParams(postback.data);
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
    await ref.set({ watchService: { awaitingReply:false, lastReplyAt: Timestamp.now() } }, { merge:true });
    await scheduleNextPing(userId);
    await safeReplyOrPush(event.replyToken, userId, [
      { type:'text', text:'OK、受け取ったよ！💖 いつもありがとう😊' },
      { type:'sticker', packageId:'6325', stickerId:'10979913' }
    ]);
  }
}

async function handleFollowEvent(event) {
  audit('follow', { userId: event.source.userId });
  const userId = event.source.userId;
  const profile = await getProfile(userId);
  if (!profile) {
    await safeReplyOrPush(event.replyToken, userId, {
      type:'text',
      text:'こんにちは🌸 こころちゃんです。利用規約とプライバシーポリシーに同意の上、会員登録をお願いします。\n\n▶︎ 利用規約：https://...\n▶︎ プライバシーポリシー：https://...'
    });
  }
  await safePush(userId, { type:'flex', altText:'会員登録メニュー', contents: makeRegistrationButtonsFlex(userId) });
}

async function handleUnfollowEvent(event) {
  audit('unfollow', { userId: event.source.userId });
  await db.collection('users').doc(event.source.userId).set({ 'profile.isDeleted': true }, { merge:true });
}

async function handleJoinEvent(event) {
  audit('join', { groupId: event.source.groupId || event.source.roomId });
  if (event.source.groupId) await setActiveWatchGroupId(event.source.groupId);
  if (OWNER_GROUP_ID && OWNER_GROUP_ID === event.source.groupId) {
    await safePush(OWNER_GROUP_ID, { type:'text', text:`新しい監視グループを設定しました。\nグループID: ${event.source.groupId}` });
  }
}

async function handleLeaveEvent(event) {
  audit('leave', { groupId: event.source.groupId || event.source.roomId });
  if (event.source.groupId) await setActiveWatchGroupId(null);
}

const HOMEPAGE_INTENT = /(ホームページ|HP|公式(?:サイト)?|サイト)/i;
const HOMEPAGE_FOLLOWUP = /(どこ|URL|リンク|教えて|ありますか|ある|ある？|\?)/i;
const isHomepageIntent = (t) => {
  if (!t) return false;
  const hit = HOMEPAGE_INTENT.test(t) && HOMEPAGE_FOLLOWUP.test(t);
  const shortOnly = HOMEPAGE_INTENT.test(t) && toGraphemes(t).length <= 8;
  return hit || shortOnly;
};

async function handleEvent(event) {
  const userId = event.source.userId;
  const isUser  = event.source.type === 'user';
  const isGroup = event.source.type === 'group';
  const isRoom  = event.source.type === 'room';
  const groupId = event.source.groupId || event.source.roomId || null;

  const text = event.message.type === 'text' ? event.message.text : '';
  const stickerId = event.message.type === 'sticker' ? event.message.stickerId : '';

  // ---- グループ/ルームの挙動（ここで完了） ----
  if (isGroup || isRoom) {
    if (text.includes('@見守りグループにする')) {
      await setActiveWatchGroupId(groupId);
      await safeReplyOrPush(event.replyToken, userId, { type:'text', text:'OK！このグループを見守りグループとして設定したよ😊' });
      return;
    }
    if (/^\/relay\s+/.test(text)) {
      const m = text.trim().match(/^\/relay\s+([0-9A-Za-z_-]{10,})/);
      if (!m) {
        await safeReplyOrPush(event.replyToken, userId, { type:'text', text:'使い方: /relay <ユーザーID>' });
        return;
      }
      const targetUserId = m[1];
      await relays.start(groupId, targetUserId, userId);
      await safePush(targetUserId, { type:'text', text:'事務局（見守りグループ）とつながりました。ここで会話できます🌸（終了は /end）' });
      await safeReplyOrPush(event.replyToken, userId, { type:'text', text:'リレーを開始しました。このグループの発言は本人に届きます。終了は /end' });
      return;
    }
    if (text.trim() === '/end') {
      await relays.stop(groupId);
      await safeReplyOrPush(event.replyToken, userId, { type:'text', text:'リレーを終了しました。' });
      return;
    }
    // リレー中はグループ→本人転送
    const r = await relays.get(groupId);
    if (r?.isActive && r?.userId && event.message?.type === 'text') {
      await safePush(r.userId, { type:'text', text:`【見守り】${text}` });
    }
    return;
  }

  // --- HP案内の特別対応 ---
  if (isHomepageIntent(text)) {
    await safeReplyOrPush(event.replyToken, userId, { type:'text', text:'うん、あるよ🌸 コネクトのホームページはこちら✨ → https://connect-npo.org' });
    return;
  }

  const udoc = await db.collection('users').doc(userId).get();
  const u = udoc.exists ? (udoc.data() || {}) : {};
  const enabled = !!u.watchService?.enabled;

  // 見守りOKショート返信（テキスト/よく使うスタンプ）
  if (isUser && enabled && u.watchService?.awaitingReply && (
      /(ok|大丈夫|はい|元気|okだよ|問題ない|なんとか|ありがとう)/i.test(text) ||
      /^(11537|11538|52002734|52002735|52002741|52002742|52002758|52002759|52002766|52002767)$/i.test(stickerId)
  )) {
    await db.collection('users').doc(userId).set({ watchService: { awaitingReply:false, lastReplyAt:Timestamp.now() } }, { merge:true });
    await scheduleNextPing(userId);
    await safeReplyOrPush(event.replyToken, userId, [
      { type:'text', text:'OK、受け取ったよ！💖 いつもありがとう😊' },
      { type:'sticker', packageId:'6325', stickerId:'10979913' }
    ]);
    return;
  }

  // ★ 「見守り」と言われたら必ずトグルUIを出す
  if (/見守り/.test(text)) {
    await safeReplyOrPush(event.replyToken, userId, {
      type:'flex', altText:'見守り設定', contents: makeWatchToggleFlex(enabled, userId)
    });
    return;
  }

  // 会員登録メニュー
  if (/(会員登録|入会|メンバー登録|登録したい)/i.test(text)) {
    await safeReplyOrPush(event.replyToken, userId, { type:'flex', altText:'会員登録メニュー', contents: makeRegistrationButtonsFlex(userId) });
    return;
  }

  // ---- 危険/詐欺/不適切/暴言 検知 ----
  const danger = isDangerMessage(text);
  const scam   = isScamMessage(text);
  const bad    = isInappropriateMessage(text);
  const swear  = isSwearMessage(text);

  console.log('[DETECT]', { uid: userId?.slice(-6), text, danger, scam, bad, swear });

  if (danger) {
    const one = await crisisOneLiner('danger', text);
    const msgs = [
      { type:'text', text: one || 'つらかったね…いまは安全がいちばんだよ。一緒に落ち着こうね🌸' },
      { type:'flex', altText:'緊急連絡先', contents: EMERGENCY_FLEX_MESSAGE }
    ];
    await safeReplyOrPush(event.replyToken, userId, msgs);

    if (SEND_OFFICER_ALERTS && OFFICER_GROUP_ID) {
      await safePush(OFFICER_GROUP_ID, { type:'text',
        text:`【危険ワード】\nユーザー末尾: ${userId.slice(-6)}\n「${sanitizeForLog(text)}」` });
    }
    return;
  }

  if (scam) {
    const one = await crisisOneLiner('scam', text);
    const msgs = [
      { type:'text', text: one || '焦らなくて大丈夫。リンクは開かず個人情報は出さないでね🌸' },
      { type:'flex', altText:'詐欺注意', contents: makeScamMessageFlex() }
    ];
    await safeReplyOrPush(event.replyToken, userId, msgs);

    if (SEND_OFFICER_ALERTS && OFFICER_GROUP_ID) {
      await safePush(OFFICER_GROUP_ID, { type:'text',
        text:`【詐欺ワード】\nユーザー末尾: ${userId.slice(-6)}\n「${sanitizeForLog(text)}」` });
    }
    return;
  }

  if (bad) {
    await safeReplyOrPush(event.replyToken, userId, { type:'text', text:'その話題は苦手なの…😥 他のお話にしようね🌸' });
    return;
  }
  if (swear) {
    await safeReplyOrPush(event.replyToken, userId, { type:'text', text:'そういう言葉を聞くと、こころちゃん悲しくなっちゃう…😢' });
    return;
  }

  // リレー中（本人→見守りグループ）転送
  try {
    const WATCH_GROUP_ID = await getActiveWatchGroupId();
    const r = WATCH_GROUP_ID ? await relays.get(WATCH_GROUP_ID) : null;
    if (r?.isActive && r?.userId === userId && WATCH_GROUP_ID) {
      await safePush(WATCH_GROUP_ID, { type:'text', text:`【本人】${text}` });
    }
  } catch (e) {
    briefErr('relay user->group failed', e);
  }

  // ここでは雑談（大規模応答）を抑止。必要なら mainLoop を差し戻し。
}

// ====== 起動 ======
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
