'use strict';

/**
 * こころちゃん BOT (完全版)
 * - /webhook ハンドラ
 * - 見守りスケジューラ（cron）
 * - リレー機能
 * - 危険/詐欺検知は見守りグループへ通知（理事会へは飛ばさない）
 * - リッチメニューは Postback(menu=*) で誤爆なし
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

const { GoogleGenerativeAI } = require('@google/generative-ai');
const OpenAI = require('openai');
const _splitter = new GraphemeSplitter();
const toGraphemes = (s) => _splitter.splitGraphemes(String(s || ''));

const { Client, middleware } = require('@line/bot-sdk');

// -----------------------------
// Utils
// -----------------------------
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
    if (value) url.searchParams.set(key, value);
  }
  return url.toString();
};
const gTrunc = (s, l) => toGraphemes(s).slice(0, l).join('');
const userHash = (id) => crypto.createHash('sha256').update(String(id)).digest('hex');
const sanitizeForLog = (text) => String(text || '').replace(/\s+/g, ' ').trim();
const briefErr = (msg, e) => {
  const detail = e?.originalError?.response?.data || e?.response?.data || e?.message || e;
  console.error(`[ERR] ${msg}:`, JSON.stringify(detail, null, 2));
};
const audit = (event, detail) => console.log(`[AUDIT] ${event}`, JSON.stringify(detail));
const redact = () => '（機密情報のため匿名化）';

// -----------------------------
// ENV
// -----------------------------
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

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

const EMERGENCY_CONTACT_PHONE_NUMBER = process.env.EMERGENCY_CONTACT_PHONE_NUMBER || '';
const BOT_ADMIN_IDS = JSON.parse(process.env.BOT_ADMIN_IDS || '[]');
const OWNER_USER_ID = process.env.OWNER_USER_ID || BOT_ADMIN_IDS[0] || '';
const OWNER_GROUP_ID = process.env.OWNER_GROUP_ID || null; // オーナーが BOT を招待する専用グループID（join時の自動設定用）

const WATCH_RUNNER = process.env.WATCH_RUNNER || 'internal';
const WATCH_LOG_LEVEL = (process.env.WATCH_LOG_LEVEL || 'info').toLowerCase();

// 「理事会」グループIDは使わない。誤爆防止のため通知は見守りグループ限定。
const OFFICER_GROUP_ID = ''; // 明示的に空にして使用不可にする（必要なら手動で wg を使う）

const OFFICER_NOTIFICATION_MIN_GAP_HOURS = Number(process.env.OFFICER_NOTIFICATION_MIN_GAP_HOURS || 1);

const PORT = process.env.PORT || 3000;

// -----------------------------
// Firebase
// -----------------------------
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
  firebaseAdmin.initializeApp({ credential: firebaseAdmin.credential.cert(creds) });
  console.log("✅ Firebase initialized");
}
const db = firebaseAdmin.firestore();
const Timestamp = firebaseAdmin.firestore.Timestamp;

// -----------------------------
// LINE
// -----------------------------
const client = new Client({
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: LINE_CHANNEL_SECRET,
});

// HTTP keep-alive
const httpAgent = new (require('http').Agent)({ keepAlive: true });
const httpsAgent = new (require('https').Agent)({ keepAlive: true });
const httpInstance = axios.create({ timeout: 6000, httpAgent, httpsAgent });

// -----------------------------
// 見守り・スケジュール
// -----------------------------
const JST_TZ = 'Asia/Tokyo';
const PING_INTERVAL_DAYS = 3;
const REMINDER_AFTER_HOURS = 24;
const ESCALATE_AFTER_HOURS = 29;

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
  }, { merge: true });
}

// -----------------------------
// 見守りグループIDの動的管理
// -----------------------------
const getWatchGroupDoc = () => firebaseAdmin.firestore().collection('system').doc('watch_group');
async function getActiveWatchGroupId() {
  const envGid = (process.env.WATCH_GROUP_ID || '').trim().replace(/\u200b/g, '');
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

// -----------------------------
// Flex / メッセージ
// -----------------------------
const maskPhone = p => {
  const v = String(p || '').replace(/[^0-9+]/g, '');
  if (!v) return '—';
  return v.length <= 4 ? `**${v}` : `${'*'.repeat(Math.max(0, v.length - 4))}${v.slice(-4)}`;
};
const telMsgBtn = (label, p) => p ? ({
  type: 'button',
  style: 'secondary',
  action: { type: 'uri', label, uri: `tel:${String(p).replace(/[^0-9+]/g, '')}` }
}) : null;

const buildWatcherFlex = ({ title = '【見守りアラート】', name = '—', address = '—', selfPhone = '', kinName = '', kinPhone = '', userId }) => ({
  type: 'flex',
  altText: title,
  contents: {
    type: 'bubble',
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: [
        { type: 'text', text: title, weight: 'bold', size: 'lg' },
        { type: 'text', text: `👤 氏名：${name}`, wrap: true, weight: 'bold' },
        { type: 'text', text: `住所：${address || '—'}`, size: 'sm', wrap: true },
        { type: 'text', text: `📱 電話番号：${maskPhone(selfPhone)}`, size: 'sm', color: '#777777' },
        { type: 'text', text: `👨‍👩‍👧‍👦 保護者名：${kinName || '—'}`, size: 'sm', color: '#777777', wrap: true },
        { type: 'text', text: `📞 緊急連絡先：${maskPhone(kinPhone)}`, size: 'sm', color: '#777777', wrap: true },
      ]
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: [
        { type: 'button', style: 'primary', action: { type: 'postback', label: 'LINEで連絡', data: `action=start_relay&uid=${encodeURIComponent(userId)}` } },
        telMsgBtn('本人に電話', selfPhone),
        telMsgBtn('近親者に電話', kinPhone),
      ].filter(Boolean)
    }
  }
});

const EMERGENCY_FLEX_MESSAGE = {
  type: "bubble",
  body: { type: "box", layout: "vertical", contents: [
    { type: "text", text: "🚨【危険ワード検知】🚨", weight: "bold", size: "xl" },
    { type: "text", text: "緊急時は下の連絡先を使ってね。", margin: "md", wrap: true }
  ]},
  footer: { type: "box", layout: "vertical", spacing: "sm", contents: [
    { type: "button", style: "primary", height: "sm", action: { type: "uri", label: "警察 (110)", uri: "tel:110" }, color: "#FF4500" },
    { type: "button", style: "primary", height: "sm", action: { type: "uri", label: "消防・救急 (119)", uri: "tel:119" }, color: "#FF6347" },
    { type: "button", style: "primary", height: "sm", action: { type: "uri", label: "チャイルドライン", uri: "https://childline.or.jp/tel" }, color: "#1E90FF" },
    { type: "button", style: "primary", height: "sm", action: { type: "uri", label: "いのちの電話", uri: "tel:0570064556" }, color: "#32CD32" },
    { type: "button", style: "primary", height: "sm", action: { type: "uri", label: "チャットまもるん", uri: "https://www.web-mamorun.com/" }, color: "#FFA500" },
    { type: "button", style: "primary", height: "sm", action: { type: "uri", label: "警視庁", uri: "tel:0335814321" }, color: "#FF4500" },
    EMERGENCY_CONTACT_PHONE_NUMBER ? { type: 'button', style: 'primary', action: { type: 'uri', label: 'こころちゃん事務局', uri: `tel:${String(EMERGENCY_CONTACT_PHONE_NUMBER).replace(/[^0-9+]/g, '')}` } } : null
  ].filter(Boolean) }
};

const makeScamMessageFlex = () => {
  const contents = [
    { type: "button", style: "primary", color: "#32CD32", action: { type: "uri", label: "国民生活センター", uri: "https://www.kokusen.go.jp/" } },
    { type: "button", style: "primary", color: "#FF4500", action: { type: "uri", label: "警察 (110)", uri: "tel:110" } },
    { type: "button", style: "primary", color: "#FFA500", action: { type: "uri", label: "消費者ホットライン (188)", uri: "tel:188" } },
  ];
  if (EMERGENCY_CONTACT_PHONE_NUMBER) {
    contents.push({ type: "button", style: "primary", color: "#000000", action: { type: "uri", label: "こころちゃん事務局", uri: `tel:${String(EMERGENCY_CONTACT_PHONE_NUMBER).replace(/[^0-9+]/g, '')}` } });
  }
  return {
    type: "bubble",
    body: { type: "box", layout: "vertical", contents: [
      { type: "text", text: "【詐欺注意】", weight: "bold", size: "xl", align: "center" },
      { type: "text", text: "怪しいお話には注意してね！不安な時は、信頼できる人に相談するか、こちらの情報も参考にしてね🌸", wrap: true, margin: "md" }
    ]},
    footer: { type: "box", layout: "vertical", spacing: "sm", contents }
  };
};

const makeRegistrationButtonsFlex = (userId) => ({
  type: "bubble",
  body: { type: "box", layout: "vertical", contents: [
    { type: "text", text: "どの会員になるか選んでね🌸", wrap: true, weight: "bold", size: "md" }
  ]},
  footer: { type: "box", layout: "vertical", spacing: "sm", contents: [
    {
      type: "button", style: "primary", height: "sm",
      action: { type: "uri", label: "学生（中高大）", uri: STUDENT_MIDDLE_HIGH_UNI_FORM_BASE_URL ? `${STUDENT_MIDDLE_HIGH_UNI_FORM_BASE_URL}?${STUDENT_MIDDLE_HIGH_UNI_FORM_LINE_USER_ID_ENTRY_ID}=${encodeURIComponent(userId)}` : "#" },
      color: "#ADD8E6"
    },
    {
      type: "button", style: "primary", height: "sm",
      action: { type: "uri", label: "大人（一般）", uri: ADULT_FORM_BASE_URL ? `${ADULT_FORM_BASE_URL}?${ADULT_FORM_LINE_USER_ID_ENTRY_ID}=${encodeURIComponent(userId)}` : "#" },
      color: "#87CEFA"
    },
    {
      type: "button", style: "primary", height: "sm",
      action: { type: "uri", label: "会員情報を変更する", uri: prefillUrl(MEMBER_CHANGE_FORM_BASE_URL, { [MEMBER_CHANGE_FORM_LINE_USER_ID_ENTRY_ID]: userId }) },
      color: "#FFC0CB"
    },
    {
      type: "button", style: "primary", height: "sm",
      action: { type: "uri", label: "退会", uri: prefillUrl(MEMBER_CANCEL_FORM_BASE_URL, { [MEMBER_CANCEL_FORM_LINE_USER_ID_ENTRY_ID]: userId }) },
      color: "#DDA0DD"
    }
  ]}
});

const makeWatchServiceButtonsFlex = (userId) => ({
  type: "bubble",
  body: { type: "box", layout: "vertical", contents: [
    { type: "text", text: "見守りサービスに登録する？", wrap: true, weight: "bold", size: "md" },
    { type: "text", text: "いざという時に、あなたを見守るよ。", wrap: true, size: "sm", margin: "md", color: "#888888" }
  ]},
  footer: { type: "box", layout: "vertical", spacing: "sm", contents: [
    {
      type: "button", style: "primary", height: "sm",
      action: { type: "uri", label: "登録する", uri: WATCH_SERVICE_FORM_BASE_URL ? `${WATCH_SERVICE_FORM_BASE_URL}?${WATCH_SERVICE_FORM_LINE_USER_ID_ENTRY_ID}=${encodeURIComponent(userId)}` : "#" },
      color: "#42b983"
    }
  ]}
});

// -----------------------------
// Push helper
// -----------------------------
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
    const detail = err?.originalError?.response?.data || err?.response?.data || err;
    console.error('[ERR] LINE push failed', JSON.stringify({ to, status: err?.statusCode || err?.response?.status, detail }, null, 2));
  }
}

// -----------------------------
// 危険/詐欺/不適切ワード
// -----------------------------
const DANGER_WORDS = [
  "しにたい","死にたい","自殺","消えたい","リスカ","リストカット","OD","オーバードーズ","殴られる","たたかれる",
  "暴力","DV","無理やり","虐待","パワハラ","セクハラ","ハラスメント", "ストーカー","盗撮","盗聴",
  "お金がない","お金足りない","死にそう","辛い","苦しい","助けて","怖い","逃げたい","もうだめだ","死んでやる","殺してやる",
  "殺す","殺される","生きていたくない","もう無理","うつ","鬱","自傷","首吊り","飛び降り","線路","死ぬ","終わり"
];
const SCAM_CORE = ["投資","未公開株","必ず儲かる","絶対儲かる","還付金","振り込め","保証金","前払い","後払い","手数料","送金","副業","ねずみ講","マルチ商法","架空請求"];
const SCAM_MONEY = ["儲かる","高収入","高額","返金保証","利回り","配当","元本保証"];
const INAPPROPRIATE_WORDS = ["死ね","殺すぞ","きもい","うざい","ばか","消えろ","くたばれ","ぶっ殺す","死んでしまえ"];

const checkWords = (text, words) => {
  if (!text || !words || !words.length) return false;
  const lowerText = text.toLowerCase();
  return words.some(word => lowerText.includes(String(word).toLowerCase()));
};
const scamScore = (text) => {
  const t = (text || '').toLowerCase();
  let s = 0;
  if (SCAM_CORE.some(w => t.includes(w.toLowerCase()))) s += 2;
  if (SCAM_MONEY.some(w => t.includes(w.toLowerCase()))) s += 1;
  return s;
};
const isAskingForHomepage = (text) => /ホームページ|HP|URL|リンク|サイト|公式\s*(どこ|教えて|ありますか)/i.test(text);
const isScamMessage = (text) => isAskingForHomepage(text) ? false : scamScore(text) >= 2;
const isDangerMessage = (text) => checkWords(text, DANGER_WORDS);
const isInappropriateMessage = (text) => checkWords(text, INAPPROPRIATE_WORDS);

// -----------------------------
// リレー
// -----------------------------
const RELAY_TTL_MS = 60 * 60 * 1000;
const relays = new Map(); // key=userId, value={to, from, until}

const addRelay = (user, officer) => relays.set(user, { to: officer, from: user, until: Date.now() + RELAY_TTL_MS });
const getRelay = (user) => {
  const relay = relays.get(user);
  if (!relay) return null;
  if (Date.now() > relay.until) { relays.delete(user); return null; }
  return relay;
};
const getRelayUser = (officer) => {
  for (const [user, rel] of relays.entries()) if (rel.to === officer) return user;
  return null;
};

// -----------------------------
// cron: 見守りPing/リマインド/エスカレーション
// -----------------------------
async function fetchTargets() {
  const now = dayjs().utc();
  const usersRef = db.collection('users');
  const targets = [];
  try {
    const snap = await usersRef.where('watchService.awaitingReply', '==', false).where('watchService.nextPingAt', '<=', now.toDate()).limit(200).get();
    targets.push(...snap.docs);
  } catch {
    const snap = await usersRef.limit(500).get();
    for (const d of snap.docs) {
      const ws = (d.data().watchService) || {};
      if (!ws.awaitingReply && ws.nextPingAt?.toDate && ws.nextPingAt.toDate() <= now.toDate()) targets.push(d);
    }
  }
  try {
    const snap = await usersRef.where('watchService.awaitingReply', '==', true).limit(200).get();
    targets.push(...snap.docs);
  } catch {
    const snap = await usersRef.limit(500).get();
    for (const d of snap.docs) {
      const ws = (d.data().watchService) || {};
      if (ws.awaitingReply === true) targets.push(d);
    }
  }
  const map = new Map(); for (const d of targets) map.set(d.id, d); return Array.from(map.values());
}
async function warmupFill() {
  const usersRef = db.collection('users');
  const snap = await usersRef.limit(200).get();
  let batch = db.batch(), cnt = 0;
  for (const d of snap.docs) {
    const ws = (d.data().watchService) || {};
    if (!ws.awaitingReply && !ws.nextPingAt) {
      batch.set(d.ref, { watchService: { enabled: true, nextPingAt: Timestamp.now() } }, { merge: true });
      cnt++;
    }
  }
  if (cnt) await batch.commit();
}
function watchLog(msg, level = 'info') {
  if (WATCH_LOG_LEVEL === 'silent') return;
  if (WATCH_LOG_LEVEL === 'error' && level !== 'error') return;
  console.log(msg);
}

async function checkAndSendPing() {
  const now = dayjs().utc();
  watchLog(`[watch-service] start ${now.format('YYYY/MM/DD HH:mm:ss')} (UTC)`);
  await warmupFill();
  const targets = await fetchTargets();
  if (targets.length === 0) { watchLog('[watch-service] no targets.'); return; }
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
      if (mode === 'noop') continue;

      if (mode === 'ping') {
        await safePush(doc.id, [
          { type: 'text', text: `${pickWatchMsg()} 大丈夫なら「OKだよ」を押してね。` },
          {
            type: 'flex', altText: '見守りチェック',
            contents: {
              type: 'bubble',
              body: { type: 'box', layout: 'vertical', contents: [
                { type: 'text', text: '見守りチェック', weight: 'bold', size: 'xl' },
                { type: 'text', text: 'OKならボタンを押してね。返信やスタンプでもOK！', wrap: true, margin: 'md' },
              ]},
              footer: { type: 'box', layout: 'vertical', contents: [
                { type: 'button', style: 'primary', action: { type: 'postback', label: 'OKだよ', data: 'watch:ok', displayText: 'OKだよ' } },
              ]},
            },
          },
        ]);
        await ref.set({ watchService: {
          lastPingAt: Timestamp.now(),
          awaitingReply: true,
          nextPingAt: firebaseAdmin.firestore.FieldValue.delete(),
          lastReminderAt: firebaseAdmin.firestore.FieldValue.delete(),
        }},{ merge: true });
      } else if (mode === 'remind') {
        await safePush(doc.id, [
          { type: 'text', text: `${pickWatchMsg()} 昨日の見守りのOKまだ受け取れてないの… 大丈夫ならボタン押してね！` },
          {
            type: 'flex', altText: '見守りリマインド',
            contents: {
              type: 'bubble',
              body: { type: 'box', layout: 'vertical', contents: [
                { type: 'text', text: '見守りリマインド', weight: 'bold', size: 'xl' },
                { type: 'text', text: 'OKならボタンを押してね。返信やスタンプでもOK！', wrap: true, margin: 'md' },
              ]},
              footer: { type: 'box', layout: 'vertical', contents: [
                { type: 'button', style: 'primary', action: { type: 'postback', label: 'OKだよ', data: 'watch:ok', displayText: 'OKだよ' } },
              ]},
            },
          },
        ]);
        await ref.set({ watchService: { lastReminderAt: Timestamp.now() } }, { merge: true });
      } else if (mode === 'escalate') {
        const canNotify = (WATCH_GROUP_ID && WATCH_GROUP_ID.trim()) &&
          (!lastNotifiedAt || dayjs().utc().diff(dayjs(lastNotifiedAt).utc(), 'hour') >= OFFICER_NOTIFICATION_MIN_GAP_HOURS);

        if (!WATCH_GROUP_ID) watchLog('[watch] WATCH_GROUP_ID is empty. escalation skipped.', 'error');
        if (canNotify) {
          const udoc = await db.collection('users').doc(doc.id).get();
          const u = udoc.exists ? (udoc.data() || {}) : {};
          const prof = u.profile || {};
          const emerg = u.emergency || {};
          await safePush(WATCH_GROUP_ID, buildWatcherFlex({
            title: '【見守りアラート】',
            name: prof.name || prof.displayName || '—',
            address: [prof.prefecture, prof.city, prof.line1, prof.line2].filter(Boolean).join(' '),
            selfPhone: prof.phone || '',
            kinName: emerg.contactName || '',
            kinPhone: emerg.contactPhone || '',
            userId: doc.id
          }));
        }
        await ref.set({ watchService: {
          lastNotifiedAt: Timestamp.now(),
          awaitingReply: false,
          lastReminderAt: firebaseAdmin.firestore.FieldValue.delete(),
          nextPingAt: Timestamp.fromDate(dayjs().tz(JST_TZ).add(PING_INTERVAL_DAYS, 'day').hour(15).minute(0).second(0).millisecond(0).toDate()),
        }},{ merge: true });
      }
    } catch (e) {
      briefErr('send/update failed', e);
    }
  }
  watchLog(`[watch-service] end ${dayjs().utc().format('YYYY/MM/DD HH:mm:ss')} (UTC)`);
}

async function withLock(lockId, ttlSec, fn) {
  const ref = db.collection('locks').doc(lockId);
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const now = Date.now();
    const until = now + ttlSec * 1000;
    const cur = snap.exists ? snap.data() : null;
    if (cur?.until?.toMillis && cur.until.toMillis() > now) return false;
    tx.set(ref, { until: Timestamp.fromMillis(until) });
    return true;
  }).then(async acquired => {
    if (!acquired) { watchLog(`[watch-service] Lock acquisition failed, skipping.`); return false; }
    try { await fn(); }
    finally { await db.collection('locks').doc(lockId).delete().catch(() => {}); }
    return true;
  });
}
if (WATCH_RUNNER !== 'external') {
  cron.schedule('*/5 * * * *', () => withLock('watch-cron', 240, checkAndSendPing), { scheduled: true, timezone: 'UTC' });
}

// -----------------------------
// AI応答
// -----------------------------
const MEMBERSHIP_CONFIG = {
  guest:      { dailyLimit: 5,  model: 'gemini-1.5-flash-latest' },
  member:     { dailyLimit: 20, model: OPENAI_MODEL },
  subscriber: { dailyLimit: -1, model: OPENAI_MODEL },
  admin:      { dailyLimit: -1, model: OPENAI_MODEL },
};

function limitEmojis(text) {
  const matches = (text || '').match(/[\p{Emoji_Presentation}\p{Emoji}\uFE0F]/gu) || [];
  if (matches.length > 2) {
    let count = 0;
    return text.replace(/[\p{Emoji_Presentation}\p{Emoji}\uFE0F]/gu, m => (++count <= 2 ? m : ''));
  }
  return text;
}

async function generateAIResponse(messages, systemPrompt, model, token) {
  const history = messages.map(m => ({ role: m.role, content: m.text || m.content }));
  const finalMessages = [{ role: 'system', content: systemPrompt }, ...history];

  if (model.includes('gemini')) {
    const genAI = new GoogleGenerativeAI(token);
    const geminiModel = genAI.getGenerativeModel({ model });
    const geminiHistory = finalMessages.map(msg => {
      if (msg.role === 'system' || msg.role === 'user') return { role: 'user', parts: [{ text: msg.content }] };
      if (msg.role === 'assistant') return { role: 'model', parts: [{ text: msg.content }] };
      return null;
    }).filter(Boolean);
    try {
      const chat = geminiModel.startChat({ history: geminiHistory });
      const result = await chat.sendMessage(history[history.length - 1].content);
      return (result.response?.text() || '').trim();
    } catch (e) { briefErr('Gemini failed', e); return null; }
  } else {
    const openai = new OpenAI({ apiKey: token, httpAgent, httpsAgent });
    try {
      const completion = await openai.chat.completions.create({
        model, messages: finalMessages, temperature: 0.8, max_tokens: 100,
      }, { timeout: 5000 });
      const text = (completion.choices?.[0]?.message?.content || '').trim();
      return text.length > 200 ? gTrunc(text, 200) + '...' : text;
    } catch (e) { briefErr('OpenAI failed', e); return null; }
  }
}

// -----------------------------
// 意図判定（誤爆防止）
// -----------------------------
const isWatchIntent  = (t) => /^(見守り|見守りサービス|見守り登録)\b?/i.test(t || '');
const isMemberIntent = (t) => /(会員|会員登録|会員メニュー|登録メニュー)/i.test(t || '') && !/見守り/.test(t || '');

// -----------------------------
// Webhook
// -----------------------------
const app = express();
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 2));
app.use(helmet());
app.use('/webhook', rateLimit({ windowMs: 60_000, max: 100 }));
app.use(express.json());

// LINE middleware（/webhook に限定）
const lineMiddleware = middleware({ channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN, channelSecret: LINE_CHANNEL_SECRET });

app.post('/webhook', lineMiddleware, async (req, res) => {
  res.sendStatus(200);
  const events = req.body.events || [];
  if (!events.length) return;
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

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const { source, message, replyToken } = event;
  const userId = source.userId;
  const text = message.text || '';
  const isUser = source.type === 'user';
  const activeGroupId = await getActiveWatchGroupId();
  const isWatchGroup = source.type === 'group' && source.groupId === activeGroupId;

  // ログ
  await db.collection('users').doc(userId).collection('chatLogs').add({
    message: sanitizeForLog(text),
    timestamp: Timestamp.now(),
    source: source.type,
  });

  // 見守り OK
  if (isUser && /^(ok|okだよ|大丈夫|おっけい|元気だよ|元気です)$/i.test(text)) {
    await scheduleNextPing(userId, new Date());
    await client.replyMessage(replyToken, { type: 'text', text: 'OK、受け取ったよ！ありがとう！また連絡するね！🌸' });
    return;
  }

  // 見守り：テキストトリガー
  if (isUser && isWatchIntent(text)) {
    await client.replyMessage(replyToken, [
      { type: 'text', text: '見守りサービスへの登録はこちらからどうぞ！' },
      { type: 'flex', altText: '見守りサービス登録', contents: makeWatchServiceButtonsFlex(userId) }
    ]);
    return;
  }

  // 会員：テキストトリガー（見守り文脈は除外）
  if (isUser && isMemberIntent(text)) {
    await client.replyMessage(replyToken, [
      { type: 'text', text: '会員種別を選んでね' },
      { type: 'flex', altText: '会員登録', contents: makeRegistrationButtonsFlex(userId) }
    ]);
    return;
  }

  // 見守りグループの雑メッセは無視（リレー中のみ別処理）
  if (isWatchGroup) return;

  // 見守り awaiting フラグ解除
  await db.collection('users').doc(userId).set({ watchService: { awaitingReply: false } }, { merge: true });

  // ワード検知
  const danger = isDangerMessage(text);
  const scam = isScamMessage(text);
  const bad = isInappropriateMessage(text);

  if (danger || scam || bad) {
    const udoc = await db.collection('users').doc(userId).get();
    const user = udoc.exists ? (udoc.data() || {}) : {};
    const prof = user.profile || {};
    const emerg = user.emergency || {};
    const wg = await getActiveWatchGroupId();

    try {
      if (danger) {
        await client.replyMessage(replyToken, [
          { type: 'text', text: 'つらかったね。ひとりじゃないよ。今すぐ助けが要るときは下の連絡先を使ってね🌸' },
          { type: 'flex', altText: '危険ワード検知', contents: EMERGENCY_FLEX_MESSAGE }
        ]);
        if (wg) await safePush(wg, buildWatcherFlex({
          title: '🚨【危険ワード検知】🚨',
          name: prof.name || prof.displayName || '—',
          address: [prof.prefecture, prof.city, prof.line1, prof.line2].filter(Boolean).join(' '),
          selfPhone: prof.phone || '',
          kinName: emerg.contactName || '',
          kinPhone: emerg.contactPhone || '',
          userId
        }));
      }
      if (scam) {
        await client.replyMessage(replyToken, [
          { type: 'text', text: 'あやしい話かも。急がず確認しよ？困ったら下の窓口も使ってね🌸' },
          { type: 'flex', altText: '詐欺注意', contents: makeScamMessageFlex() }
        ]);
        if (wg) await safePush(wg, buildWatcherFlex({
          title: '⚠️【詐欺ワード検知】⚠️',
          name: prof.name || prof.displayName || '—',
          address: [prof.prefecture, prof.city, prof.line1, prof.line2].filter(Boolean).join(' '),
          selfPhone: prof.phone || '',
          kinName: emerg.contactName || '',
          kinPhone: emerg.contactPhone || '',
          userId
        }));
      }
      if (bad) {
        await client.replyMessage(replyToken, { type: 'text', text: 'いやだなと思ったら、無理しないでね。そんな言葉、こころは悲しくなっちゃう😢' });
      }
    } catch (e) { briefErr('alert reply failed', e); }
    return;
  }

  // AI応答
  if (isUser && text) {
    const uref = db.collection('users').doc(userId);
    const usnap = await uref.get();
    const membership = (usnap.exists ? (usnap.data()?.membership) : null) || 'guest';
    const config = MEMBERSHIP_CONFIG[membership] || MEMBERSHIP_CONFIG.guest;
    const token = config.model.includes('gemini') ? GEMINI_API_KEY : OPENAI_API_KEY;

    const historySnap = await uref.collection('chatLogs').orderBy('timestamp', 'asc').limit(10).get();
    const messages = historySnap.docs.map(d => {
      const data = d.data();
      return { role: data.source === 'user' ? 'user' : 'assistant', text: data.message };
    });
    messages.push({ role: 'user', text });

    const systemPrompt = `
# 制約
- あなたは絶対に「皆守こころ」です。他の誰にもなれません。
- 親しみやすく、やさしい口調で話します。
- 絵文字は1～2個。3個以上は使わない。
- 1人称は「こころ」。
- 長文は避け、100文字前後で自然に。
- 安全最優先。危険な内容には踏み込まず気遣いを。
- AIっぽい説明は禁止。やさしく寄り添ってね。
`.trim();

    try {
      const aiResponse = await generateAIResponse(messages, systemPrompt, config.model, token);
      if (aiResponse) {
        const textOut = limitEmojis(aiResponse).trim();
        await client.replyMessage(replyToken, { type: 'text', text: textOut });
        await uref.collection('chatLogs').add({ message: text,      timestamp: Timestamp.now(), source: 'user' });
        await uref.collection('chatLogs').add({ message: textOut,   timestamp: Timestamp.now(), source: 'assistant' });
        return;
      }
    } catch (e) {
      briefErr('AI response failed', e);
      await client.replyMessage(replyToken, { type: 'text', text: 'ごめんね、ちょっと疲れてるみたい。少し時間を空けてから話しかけてくれると嬉しいな💖' });
      return;
    }
  }

  // デフォルト応答（ここに来たら1回だけ）
  if (source.type === 'user') {
    await client.replyMessage(replyToken, { type: 'text', text: 'ごめんね、うまく理解できなかったよ。' });
  }
}

async function handlePostbackEvent(event, userId) {
  const qs = new URLSearchParams(event.postback?.data || '');
  const action = qs.get('action') || '';
  const menu = qs.get('menu') || '';

  // リッチメニュー分岐（誤爆なし）
  if (menu === 'watch') {
    await client.replyMessage(event.replyToken, [
      { type: 'text', text: '見守りサービスへの登録はこちらからどうぞ！' },
      { type: 'flex', altText: '見守りサービス登録', contents: makeWatchServiceButtonsFlex(userId) }
    ]);
    return;
  }
  if (menu === 'member_register') {
    await client.replyMessage(event.replyToken, [
      { type: 'text', text: '会員種別を選んでね' },
      { type: 'flex', altText: '会員登録', contents: makeRegistrationButtonsFlex(userId) }
    ]);
    return;
  }
  if (menu === 'member_menu') {
    await client.replyMessage(event.replyToken, [
      { type: 'text', text: '会員メニューだよ' },
      { type: 'flex', altText: '会員メニュー', contents: makeRegistrationButtonsFlex(userId) } // 必要なら専用のメニューに差し替え
    ]);
    return;
  }

  // 見守りOK
  if (event.postback?.data === 'watch:ok') {
    await scheduleNextPing(userId, new Date());
    await client.replyMessage(event.replyToken, { type: 'text', text: 'OK、受け取ったよ！ありがとう！また連絡するね！🌸' });
    audit('WATCH_OK', { userId: userHash(userId) });
    return;
  }

  // リレー開始
  if (action === 'start_relay') {
    const uid = qs.get('uid');
    const wg = await getActiveWatchGroupId();
    if (uid && wg) {
      await client.replyMessage(event.replyToken, [{ type: 'text', text: `このユーザーにメッセージを送る準備ができました。` }]);
      await safePush(wg, { type: 'text', text: `>> ${uid} 〇〇` });
    } else {
      await client.replyMessage(event.replyToken, { type: 'text', text: 'ごめんね、見守りグループが設定されてないみたい。' });
    }
    return;
  }
}

async function handleFollowEvent(event) {
  const userId = event.source.userId;
  try {
    const profile = await client.getProfile(userId).catch(() => null);
    await db.collection('users').doc(userId).set({
      profile: { userId, displayName: profile?.displayName || null, pictureUrl: profile?.pictureUrl || null },
      isFollowed: true,
      membership: 'guest',
      watchService: { enabled: false, nextPingAt: Timestamp.now() },
      followedAt: Timestamp.now()
    }, { merge: true });

    await client.replyMessage(event.replyToken, {
      type: 'text',
      text: 'はじめまして🌸 こころちゃんです💖\n\nもしもの時にあなたを見守るお手伝いをするよ！\n\n見守りサービスへの登録や、困ったことがあったら話しかけてね💖'
    });
    audit('FOLLOW', { userId: userHash(userId) });
  } catch (e) { briefErr('handleFollowEvent', e); }
}

async function handleUnfollowEvent(event) {
  const userId = event.source.userId;
  await db.collection('users').doc(userId).set({ isFollowed: false, unfollowedAt: Timestamp.now() }, { merge: true });
  audit('UNFOLLOW', { userId: userHash(userId) });
}

async function handleJoinEvent(event) {
  // オーナー専用グループに参加した場合のみ、見守りグループとして記録
  const id = event.source.type === 'group' ? event.source.groupId : event.source.roomId;
  const isOwner = (id === OWNER_GROUP_ID);
  if (!isOwner) return;

  await setActiveWatchGroupId(id);
  await safePush(id, { type: 'text', text: '皆さん、はじめまして！こころちゃんです💖 見守りサービスのグループが設定されました。このグループに利用者さんからのアラートが届くよ！' });
  audit('JOIN_WATCH_GROUP', { groupId: id });
}

async function handleLeaveEvent(event) {
  const id = event.source.type === 'group' ? event.source.groupId : event.source.roomId;
  if (id && id === await getActiveWatchGroupId()) {
    await setActiveWatchGroupId('');
    audit('LEAVE_WATCH_GROUP', { groupId: id });
  }
}

// -----------------------------
// Healthcheck
// -----------------------------
app.get('/', (_req, res) => res.send('こころちゃんBOTは動作中です'));

// -----------------------------
// Start
// -----------------------------
app.listen(PORT, () => console.log(`こころちゃんBOTはポート ${PORT} で稼働中です`));
