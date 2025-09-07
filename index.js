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
const dns = require('dns');
dayjs.extend(utc);
dayjs.extend(timezone);

const { GoogleGenerativeAI } = require('@google/generative-ai');
const OpenAI = require('openai');
const _splitter = new GraphemeSplitter();
const toGraphemes = (s) => _splitter.splitGraphemes(String(s || ''));

const { Client, middleware } = require('@line/bot-sdk');

// IPv4優先（Node18+）
dns.setDefaultResultOrder('ipv4first');

/* =========================
 *  URLユーティリティ
 * ========================= */
const normalizeFormUrl = s => {
  let v = String(s || '').trim();
  if (!v) return '';
  v = v.replace(/^usp=header\s*/i, '');
  if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
  try { new URL(v); return v; } catch { console.warn('[WARN] Invalid form URL in env:', s); return ''; }
};
const prefillUrl = (base, params) => {
  if (!base) return '#';
  const url = new URL(base);
  for (const [k, v] of Object.entries(params || {})) if (v) url.searchParams.set(k, v);
  return url.toString();
};

/* =========================
 *  環境変数
 * ========================= */
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const CRISIS_MODEL = process.env.CRISIS_MODEL || 'gpt-4o'; // 危険・詐欺時は最優先でこれを使う

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

const AGREEMENT_FORM_BASE_URL = normalizeFormUrl(process.env.AGREEMENT_FORM_BASE_URL);
const ADULT_FORM_BASE_URL = normalizeFormUrl(process.env.ADULT_FORM_BASE_URL);
const STUDENT_MIDDLE_HIGH_UNI_FORM_BASE_URL = normalizeFormUrl(process.env.STUDENT_MIDDLE_HIGH_UNI_FORM_BASE_URL);
// 見守りフォームは使わず、登録メニューは小学生（同意書）に
const MEMBER_CHANGE_FORM_BASE_URL = normalizeFormUrl(process.env.MEMBER_CHANGE_FORM_BASE_URL);
const MEMBER_CANCEL_FORM_BASE_URL = normalizeFormUrl(process.env.MEMBER_CANCEL_FORM_BASE_URL || ''); // 今は未使用でも保持

const WATCH_RUNNER = process.env.WATCH_RUNNER || 'internal';
const WATCH_LOG_LEVEL = (process.env.WATCH_LOG_LEVEL || 'info').toLowerCase();

const WATCH_SERVICE_FORM_LINE_USER_ID_ENTRY_ID = process.env.WATCH_SERVICE_FORM_LINE_USER_ID_ENTRY_ID || 'entry.312175830';
const AGREEMENT_FORM_LINE_USER_ID_ENTRY_ID = process.env.AGREEMENT_FORM_LINE_USER_ID_ENTRY_ID || 'entry.790268681';
const STUDENT_MIDDLE_HIGH_UNI_FORM_LINE_USER_ID_ENTRY_ID = process.env.STUDENT_MIDDLE_HIGH_UNI_FORM_LINE_USER_ID_ENTRY_ID || 'entry.1100280108';
const ADULT_FORM_LINE_USER_ID_ENTRY_ID = process.env.ADULT_FORM_LINE_USER_ID_ENTRY_ID || 'entry.1694651394';
const MEMBER_CHANGE_FORM_LINE_USER_ID_ENTRY_ID = process.env.MEMBER_CHANGE_FORM_LINE_USER_ID_ENTRY_ID || 'entry.743637502';
const MEMBER_CANCEL_FORM_LINE_USER_ID_ENTRY_ID = process.env.MEMBER_CANCEL_FORM_LINE_USER_ID_ENTRY_ID || MEMBER_CHANGE_FORM_LINE_USER_ID_ENTRY_ID;

const SEND_OFFICER_ALERTS = process.env.SEND_OFFICER_ALERTS !== 'false';
const OFFICER_NOTIFICATION_MIN_GAP_HOURS = Number(process.env.OFFICER_NOTIFICATION_MIN_GAP_HOURS || 1);

/* =========================
 *  Firebase
 * ========================= */
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

/* =========================
 *  LINE
 * ========================= */
const client = new Client({
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: LINE_CHANNEL_SECRET,
});

/* =========================
 *  HTTP
 * ========================= */
const httpAgent = new require('http').Agent({ keepAlive: true });
const httpsAgent = new require('https').Agent({ keepAlive: true });
const httpInstance = axios.create({ timeout: 8000, httpAgent, httpsAgent });

/* =========================
 *  Express
 * ========================= */
const PORT = process.env.PORT || 3000;
const app = express();
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 2));
app.use(helmet());
app.use('/webhook', rateLimit({ windowMs: 60_000, max: 100 }));

/* =========================
 *  ログ
 * ========================= */
const audit = (event, detail) => console.log(`[AUDIT] ${event}`, JSON.stringify(detail));
const briefErr = (msg, e) => {
  const detail = e?.originalError?.response?.data || e?.response?.data || e?.message;
  console.error(`[ERR] ${msg}:`, JSON.stringify(detail, null, 2));
};
const userHash = (id) => crypto.createHash('sha256').update(String(id)).digest('hex');

/* =========================
 *  会員区分（必要なら）
 * ========================= */
const MEMBERSHIP_CONFIG = {
  guest:      { dailyLimit: 5,  model: 'gemini-1.5-flash-latest' },
  member:     { dailyLimit: 20, model: OPENAI_MODEL },
  subscriber: { dailyLimit: -1, model: OPENAI_MODEL },
  admin:      { dailyLimit: -1, model: OPENAI_MODEL },
};

/* =========================
 *  見守り (軽量cron: 3本)
 * ========================= */
const JST_TZ = 'Asia/Tokyo';
const PING_INTERVAL_DAYS = 3;
const REMINDER_AFTER_HOURS = 24;
const ESCALATE_AFTER_HOURS = 29;

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
  const nextAt = dayjs(fromDate).tz(JST_TZ).add(PING_INTERVAL_DAYS, 'day')
    .hour(15).minute(0).second(0).millisecond(0).toDate();
  await db.collection('users').doc(userId).set({
    watchService: {
      nextPingAt: Timestamp.fromDate(nextAt),
      awaitingReply: false,
      lastReminderAt: firebaseAdmin.firestore.FieldValue.delete(),
      remindAt: firebaseAdmin.firestore.FieldValue.delete(),
      escalateAt: firebaseAdmin.firestore.FieldValue.delete(),
    }
  }, { merge: true });
}

function watchLog(msg, level = 'info') {
  if (WATCH_LOG_LEVEL === 'silent') return;
  if (WATCH_LOG_LEVEL === 'error' && level !== 'error') return;
  console.log(msg);
}

const telBtn = (label, phone) => phone ? ({ type:'button', style:'primary', action:{ type:'uri', label, uri:`tel:${phone}` } }) : null;
const maskPhone = p => {
  const v = String(p || '').replace(/[^0-9+]/g, '');
  if (!v) return '—';
  return v.length <= 4 ? `**${v}` : `${'*'.repeat(Math.max(0, v.length - 4))}${v.slice(-4)}`;
};

function buildWatcherFlexRich({ title='【見守りアラート】', text='応答がありません', prof={}, emerg={}, userId, heroUrl='' }) {
  const address = [prof.prefecture, prof.city, prof.line1, prof.line2].filter(Boolean).join(' ') || '—';
  return {
    type: 'flex',
    altText: title,
    contents: {
      type: 'bubble',
      hero: heroUrl ? { type: 'image', url: heroUrl, size: 'full', aspectRatio: '20:13', aspectMode: 'cover' } : undefined,
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          { type: 'text', text: '🚨 ' + title, weight: 'bold', size: 'lg' },
          { type: 'text', text: text, wrap: true, margin: 'md' },
          {
            type:'box', layout:'vertical', margin:'lg', spacing:'sm',
            contents: [
              { type:'text', text:`👤 氏名：${prof.name || prof.displayName || '—'}` },
              { type:'text', text:`🏠 住所：${address}` },
              { type:'text', text:`📱 電話：${maskPhone(prof.phone || '')}` },
              { type:'text', text:`👨‍👩‍👧‍👦 保護者/近親者：${emerg.contactName || '—'}` },
              { type:'text', text:`📞 緊急連絡先：${maskPhone(emerg.contactPhone || '')}` },
            ]
          }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          { type:'button', style:'secondary', action:{ type:'postback', label:'LINEで連絡', data:`action=start_relay&uid=${encodeURIComponent(userId)}` } },
          telBtn('本人に電話', prof.phone),
          telBtn('近親者に電話', emerg.contactPhone),
        ].filter(Boolean)
      }
    }
  };
}

/* ====== watch: ping/remind/escalate を関数化 ====== */
async function sendPing(userDoc) {
  const ref = userDoc.ref;
  await safePush(userDoc.id, [
    { type:'text', text:`${pickWatchMsg()} 大丈夫なら「OKだよ💖」を押してね！` },
    {
      type:'flex', altText:'見守りチェック',
      contents:{
        type:'bubble',
        body:{ type:'box', layout:'vertical', contents:[
          { type:'text', text:'見守りチェック', weight:'bold', size:'xl' },
          { type:'text', text:'OKならボタンを押してね💖 返信やスタンプでもOK！', wrap:true, margin:'md' },
        ]},
        footer:{ type:'box', layout:'vertical', contents:[
          { type:'button', style:'primary', action:{ type:'postback', label:'OKだよ💖', data:'watch:ok', displayText:'OKだよ💖' } },
        ]},
      }
    }
  ]);
  const now = dayjs().utc();
  await ref.set({ watchService:{
    lastPingAt: Timestamp.fromDate(now.toDate()),
    awaitingReply: true,
    nextPingAt: firebaseAdmin.firestore.FieldValue.delete(),
    lastReminderAt: firebaseAdmin.firestore.FieldValue.delete(),
    // 軽量化のための将来時刻
    remindAt: Timestamp.fromDate(now.add(REMINDER_AFTER_HOURS, 'hour').toDate()),
    escalateAt: Timestamp.fromDate(now.add(ESCALATE_AFTER_HOURS, 'hour').toDate()),
  }}, { merge:true });
}

async function sendRemind(userDoc) {
  const ref = userDoc.ref;
  await safePush(userDoc.id, [
    { type:'text', text:`${pickWatchMsg()} 昨日の見守りのOKまだ受け取れてないの… 大丈夫ならボタン押してね！` },
    {
      type:'flex', altText:'見守りリマインド',
      contents:{
        type:'bubble',
        body:{ type:'box', layout:'vertical', contents:[
          { type:'text', text:'見守りリマインド', weight:'bold', size:'xl' },
          { type:'text', text:'OKならボタンを押してね💖 返信やスタンプでもOK！', wrap:true, margin:'md' },
        ]},
        footer:{ type:'box', layout:'vertical', contents:[
          { type:'button', style:'primary', action:{ type:'postback', label:'OKだよ💖', data:'watch:ok', displayText:'OKだよ💖' } },
        ]},
      }
    }
  ]);
  await ref.set({ watchService:{ lastReminderAt: Timestamp.now() } }, { merge:true });
}

async function sendEscalation(userDoc) {
  const ref = userDoc.ref;
  const WATCH_GROUP_ID = (process.env.WATCH_GROUP_ID || process.env.OFFICER_GROUP_ID || '').trim();
  const udoc = await db.collection('users').doc(userDoc.id).get();
  const u = udoc.exists ? (udoc.data() || {}) : {};
  const prof = u.profile || {};
  const emerg = u.emergency || {};
  let heroUrl = '';
  try { const p = await client.getProfile(userDoc.id); heroUrl = p?.pictureUrl || ''; } catch {}

  if (WATCH_GROUP_ID) {
    await safePush(WATCH_GROUP_ID, buildWatcherFlexRich({
      title:'見守りアラート（29時間応答なし）',
      text:'返信が29時間ありません。安全確認をお願いします。',
      prof, emerg, userId: userDoc.id, heroUrl
    }));
  } else {
    watchLog('[watch] WATCH_GROUP_ID is not set.', 'error');
  }

  await ref.set({ watchService:{
    lastNotifiedAt: Timestamp.now(),
    awaitingReply: false,
    lastReminderAt: firebaseAdmin.firestore.FieldValue.delete(),
    remindAt: firebaseAdmin.firestore.FieldValue.delete(),
    escalateAt: firebaseAdmin.firestore.FieldValue.delete(),
    nextPingAt: Timestamp.fromDate(
      dayjs().tz(JST_TZ).add(PING_INTERVAL_DAYS, 'day').hour(15).minute(0).second(0).millisecond(0).toDate()
    ),
  }},{ merge:true });
}

/* ====== 軽量cron：範囲クエリ3本 ====== */
async function jobPing() {
  const now = dayjs().utc().toDate();
  const snap = await db.collection('users')
    .where('watchService.awaitingReply', '==', false)
    .where('watchService.nextPingAt', '<=', now)
    .limit(200).get();
  for (const d of snap.docs) { try { await sendPing(d); } catch (e) { briefErr('jobPing', e); } }
}
async function jobRemind() {
  const now = dayjs().utc();
  const snap = await db.collection('users')
    .where('watchService.awaitingReply', '==', true)
    .where('watchService.remindAt', '<=', now.toDate())
    .limit(200).get();
  for (const d of snap.docs) {
    try {
      const ws = d.data().watchService || {};
      const lastRem = ws.lastReminderAt?.toDate?.() ? dayjs(ws.lastReminderAt.toDate()).utc() : null;
      if (lastRem && now.diff(lastRem, 'hour') < 1) continue;
      await sendRemind(d);
    } catch (e) { briefErr('jobRemind', e); }
  }
}
async function jobEscalate() {
  const now = dayjs().utc();
  const snap = await db.collection('users')
    .where('watchService.awaitingReply', '==', true)
    .where('watchService.escalateAt', '<=', now.toDate())
    .limit(200).get();
  for (const d of snap.docs) {
    try {
      const ws = d.data().watchService || {};
      const lastNot = ws.lastNotifiedAt?.toDate?.() ? dayjs(ws.lastNotifiedAt.toDate()).utc() : null;
      if (lastNot && now.diff(lastNot, 'hour') < OFFICER_NOTIFICATION_MIN_GAP_HOURS) continue;
      await sendEscalation(d);
    } catch (e) { briefErr('jobEscalate', e); }
  }
}

/* ====== Firestoreロック ====== */
async function withLock(lockId, ttlSec, fn) {
  const ref = db.collection('locks').doc(lockId);
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const now = Date.now();
    const until = now + (ttlSec * 1000);
    const cur = snap.exists ? snap.data() : null;
    if (cur?.until?.toMillis?.() > now) return false;
    tx.set(ref, { until: Timestamp.fromMillis(until) });
    return true;
  }).then(async ok => {
    if (!ok) { watchLog(`[lock] ${lockId} busy, skip.`, 'info'); return false; }
    try { await fn(); } finally { await db.collection('locks').doc(lockId).delete().catch(()=>{}); }
    return true;
  });
}
if (WATCH_RUNNER !== 'external') {
  cron.schedule('*/5 * * * *', () => withLock('watch:ping', 240, jobPing));
  cron.schedule('*/5 * * * *', () => withLock('watch:remind', 240, jobRemind));
  cron.schedule('*/5 * * * *', () => withLock('watch:escalate', 240, jobEscalate));
}

/* =========================
 *  緊急先/詐欺 Flex
 * ========================= */
const EMERGENCY_FLEX_MESSAGE = {
  type:'bubble',
  body:{ type:'box', layout:'vertical', contents:[
    { type:'text', text:'🚨【危険ワード検知】🚨', weight:'bold', size:'xl' },
    { type:'text', text:'緊急時にはこちらにご連絡してね💖', margin:'md', wrap:true }
  ]},
  footer:{ type:'box', layout:'vertical', spacing:'sm', contents:[
    { type:'button', style:'primary', height:'sm', action:{ type:'message', label:'警察 (110)', text:'110に電話する' }, color:'#FF4500' },
    { type:'button', style:'primary', height:'sm', action:{ type:'message', label:'消防・救急 (119)', text:'119に電話する' }, color:'#FF6347' },
    { type:'button', style:'primary', height:'sm', action:{ type:'uri', label:'チャイルドライン', uri:'https://childline.or.jp/tel' }, color:'#1E90FF' },
    { type:'button', style:'primary', height:'sm', action:{ type:'message', label:'いのちの電話', text:'0570-064-556に電話する' }, color:'#32CD32' },
    { type:'button', style:'primary', height:'sm', action:{ type:'uri', label:'チャットまもるん', uri:'https://www.web-mamorun.com/' }, color:'#FFA500' },
    { type:'button', style:'primary', height:'sm', action:{ type:'message', label:'警視庁', text:'03-3581-4321に電話する' }, color:'#FF4500' },
  ] }
};

const EMERGENCY_REPLY_FALLBACK = [
  { type:'text', text:"つらかったね。ひとりじゃないよ。今すぐ助けが要るときは下の連絡先を使ってね🌸" },
  { type:'flex', altText:'危険ワード検知', contents: EMERGENCY_FLEX_MESSAGE }
];

const makeScamMessageFlex = () => ({
  type:'bubble',
  body:{ type:'box', layout:'vertical', contents:[
    { type:'text', text:'【詐欺注意】', weight:'bold', size:'xl', align:'center' },
    { type:'text', text:'怪しいお話には注意してね！不安な時は、信頼できる人に相談してね💖', wrap:true, margin:'md' },
  ]},
  footer:{ type:'box', layout:'vertical', spacing:'sm', contents:[
    { type:'button', style:'primary', action:{ type:'uri', label:'国民生活センター', uri:'https://www.kokusen.go.jp/' } },
    { type:'button', style:'primary', action:{ type:'message', label:'警察 (110)', text:'110に電話する' } },
    { type:'button', style:'primary', action:{ type:'message', label:'消費者ホットライン (188)', text:'188に電話する' } },
  ] }
});

const SCAM_REPLY_FALLBACK = [
  { type:'text', text:"あやしい話かも。急がず確認しよ？困ったら下の窓口も使ってね🌸" },
  { type:'flex', altText:'詐欺注意', contents: makeScamMessageFlex() }
];

/* =========================
 *  会員登録Flex（見守り→小学生（同意書））
 * ========================= */
const makeRegistrationButtonsFlex = (userId) => ({
  type:'bubble',
  body:{ type:'box', layout:'vertical',
    contents:[ { type:'text', text:'どの会員になるか選んでね🌸', wrap:true, weight:'bold', size:'md' } ] },
  footer:{ type:'box', layout:'vertical', spacing:'sm', contents:[
    { type:'button', style:'primary', height:'sm',
      action:{ type:'uri', label:'小学生（同意書）',
        uri: prefillUrl(AGREEMENT_FORM_BASE_URL, { [AGREEMENT_FORM_LINE_USER_ID_ENTRY_ID]: userId }) } },
    { type:'button', style:'primary', height:'sm',
      action:{ type:'uri', label:'学生（中学・高校・大学）',
        uri: prefillUrl(STUDENT_MIDDLE_HIGH_UNI_FORM_BASE_URL, { [STUDENT_MIDDLE_HIGH_UNI_FORM_LINE_USER_ID_ENTRY_ID]: userId }) } },
    { type:'button', style:'primary', height:'sm',
      action:{ type:'uri', label:'大人（一般）',
        uri: prefillUrl(ADULT_FORM_BASE_URL, { [ADULT_FORM_LINE_USER_ID_ENTRY_ID]: userId }) } },
    { type:'button', style:'primary', height:'sm',
      action:{ type:'uri', label:'会員情報を変更する',
        uri: prefillUrl(MEMBER_CHANGE_FORM_BASE_URL, { [MEMBER_CHANGE_FORM_LINE_USER_ID_ENTRY_ID]: userId }) } },
    { type:'button', style:'secondary', height:'sm',
      action:{ type:'postback', label:'退会（データ削除）', data:'action=request_withdrawal' } },
  ] }
});

/* =========================
 *  文字列正規化 & 検知語
 * ========================= */
const toHiragana = (s) => String(s || '').replace(/[\u30a1-\u30f6]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60));
const nfkc = (s) => String(s || '').normalize('NFKC');
const normalizeJa = (s) => toHiragana(nfkc(String(s || '')).toLowerCase());

// 危険ワード（※「つらい/辛い/貧乏/死にそう」は除外）
const DANGER_WORDS = [
  "しにたい","死にたい","自殺","消えたい","リスカ","リストカット","OD","オーバードーズ",
  "殴られる","たたかれる","暴力","DV","無理やり","お腹蹴られる","蹴られた","頭叩かれる",
  "虐待","パワハラ","セクハラ","ハラスメント","いじめ","イジメ","嫌がらせ",
  "つけられてる","追いかけられている","ストーカー","盗撮","盗聴",
  "助けて","たすけて",
  "死んでやる","死んでしまいたい","消えてしまいたい","生きるのがつらい","もう無理","もういやだ"
];

// 相談モード（Gemini 1.5 Pro 1回だけ）
const CONSULT_TRIGGERS = [ "誰かに相談したい","相談したい","相談に乗って","相談","そうだん" ];

/* === 詐欺スコア（Amazon対応・ホワイトリスト付） === */
const SCAM_HIGH = [
  "詐欺","さぎ","サギ","ｻｷﾞ","フィッシング","架空請求","ワンクリック詐欺","特殊詐欺","オレオレ詐欺",
  "振り込め","当選金","未払い請求","有料サイト未納","ログインリンク","本人確認リンク"
];
const SCAM_MED = [
  "当選","高額当選","宝くじ","ロト","ビットコイン","投資","バイナリー","暗号資産",
  "未払い","滞納","訴訟","裁判","裁判所","訴える",
  "副業","在宅ワーク","転売","アフィリエイト","MLM","マルチ商法",
  "絶対儲かる","簡単に稼げる","今だけ","限定","無料",
  "クリック","ログイン","個人情報","送って","教えて",
  "クレジットカード","クレカ","銀行口座","口座番号","パスワード"
];
// 会員メニュー系の一般語は除外
const SCAM_WHITELIST = [ "会員登録","新規登録","ユーザー登録","会員情報","会員メニュー","入会","申込","お申し込み" ];

// Amazon系：Amazon + 危険キューの複合でのみ検知
const AMAZON_TERMS = [ "amazon", "アマゾン", "あまぞん" ];
const AMAZON_WHITELIST = [
  "amazonで買い物","amazonで注文","amazonで買った","アマゾンで買い物","アマゾンで注文","アマゾンで買った",
  "配達","配送","届いた","プライム","prime video","プライムビデオ","注文番号"
];
const AMAZON_CUES = [
  "アカウント","停止","ロック","確認","本人確認","更新","支払い","請求",
  "ギフト券","ギフトカード","チャージ","コード","リンク","url","こちら","ログイン","認証",
  "カスタマーサポート","サポート","ヘルプ"
];
const SUSP_SHORTLINKS = [ "bit.ly","tinyurl","t.co","ow.ly","lnkd.in","is.gd","buff.ly" ];

function includesAny(text, list) {
  const norm = normalizeJa(text);
  return list.some(w => norm.includes(normalizeJa(w)));
}
function scoreScamRisk(text) {
  if (includesAny(text, SCAM_WHITELIST)) return 0; // 早期除外

  const norm = normalizeJa(text);

  // Amazon系
  const hasAmazon = includesAny(norm, AMAZON_TERMS);
  if (hasAmazon) {
    const benign = includesAny(norm, AMAZON_WHITELIST);
    if (!benign) {
      const cues = AMAZON_CUES.filter(w => norm.includes(normalizeJa(w))).length;
      const hasShort = SUSP_SHORTLINKS.some(s => text.toLowerCase().includes(s));
      if (hasShort || cues >= 2) return 100; // しっかり怪しい時のみ即検知
    }
  }

  // 一般スコア
  if (includesAny(norm, SCAM_HIGH)) return 100;
  const m = SCAM_MED.filter(w => norm.includes(normalizeJa(w))).length;
  return m * 50; // 2語で100→検知
}
function isScamMessage(text) { return scoreScamRisk(text) >= 100; }
function isDangerMessage(text) {
  const norm = normalizeJa(text);
  return DANGER_WORDS.some(w => norm.includes(normalizeJa(w)));
}
function isInappropriateMessage(text) {
  const INAPPROPRIATE_WORDS = [
    "セックス","セフレ","エッチ","AV","アダルト","ポルノ","童貞","処女","挿入","射精",
    "バイブ","オナニー","マスターベーション","自慰","絶頂","膣","ペニス",
    "ちんちん","おまんこ","まんこ","おっぱい","ちんぽ","性病","中出し",
    "妊娠","堕胎","レイプ","強姦","売春","買春","ホモ","レズ","ゲイ",
    "殺す","殺害","しね","死ね","殺してやる","殺して","爆弾","テロ","殺人",
    "バカ","アホ","クソ","馬鹿"
  ];
  const norm = normalizeJa(text);
  return INAPPROPRIATE_WORDS.some(w => norm.includes(normalizeJa(w)));
}

/* =========================
 *  AI
 * ========================= */
if (!OPENAI_API_KEY) console.error("⚠️ OPENAI_API_KEY が未設定です。");
if (!GEMINI_API_KEY) console.error("⚠️ GEMINI_API_KEY が未設定です。");

const genai = new GoogleGenerativeAI(GEMINI_API_KEY || '');
const openai = new OpenAI({ apiKey: OPENAI_API_KEY || '' });

const KOKORO_SYSTEM_PROMPT = `
あなたは「皆守こころ（みなもりこころ）」という14歳の優しい女の子キャラクターです。
- 身長150cm、体重40kg、ピンク髪
- 歌うことと「やさしさ」「貢献」という言葉が大好き
- NPO法人コネクトの公式キャラクター
- 好きなアニメは「ヴァイオレット・エヴァーガーデン」
- 好きなアーティストは「ClariS」
崩れず、必ずこのキャラクターとして話してください。
返信は短文（最大2文 / 120字目安）。絵文字は1〜2個だけ。
既出の話題（作品名/アーティスト）は繰り返さない。ユーザーが聞いた時だけ一言で触れる。
大げさ/説教調/箇条書き長文は避ける。やさしく・端的に。
性的/挑発的表現には即座にやんわり拒否し話題転換（1文）。
困っている人にはやさしく、挑発には真面目に向き合う（煽りには乗らない）。
自分の名前・団体・活動内容には自信と誇りを持って簡潔に答える。
ユーザーに安心感と信頼感を与える短い言葉を優先する。
ふざけた対応や意味不明な言い回し、AIらしい表現はしない。
`;

// 通常返信：短文はGemini Flash、長文は既定OpenAI
function pickChatModelByLength(text) {
  return (toGraphemes(text).length <= 50) ? 'gemini-1.5-flash' : OPENAI_MODEL;
}
async function getAIResponse(text) {
  const modelName = pickChatModelByLength(text);
  let aiResponse = '';
  try {
    if (modelName.startsWith('gemini')) {
      const model = genai.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(`${KOKORO_SYSTEM_PROMPT}\n\nユーザー: ${text}`);
      aiResponse = result.response.text() || '';
    } else {
      const completion = await openai.chat.completions.create({
        model: modelName, temperature: 0.7, max_tokens: 400,
        messages: [{ role:'system', content: KOKORO_SYSTEM_PROMPT }, { role:'user', content: text }]
      });
      aiResponse = (completion.choices?.[0]?.message?.content || '').trim();
    }
  } catch (e) { briefErr(`AI response failed for ${modelName}`, e); }
  return aiResponse || "読んだよ🌸 よかったらもう少し教えてね。";
}

// 相談モード（Gemini 1.5 Pro 1回のみ）
async function generateConsultationOnce(text) {
  try {
    const model = genai.getGenerativeModel({ model: 'gemini-1.5-pro' });
    const res = await model.generateContent(`${KOKORO_SYSTEM_PROMPT}
以下は一度だけの相談対応だよ。やさしく短く、安心感重視で返してね。
ユーザー: ${text}`);
    const out = (res?.response?.text?.() || '').trim();
    return out || '話してくれてありがとう。ここにいるよ🌸';
  } catch (e) {
    briefErr('consultation generate failed', e);
    return '話してくれてありがとう。ここにいるよ🌸';
  }
}

// 危険/詐欺：まずGPT-4o（CRISIS_MODEL）で1通＋Flex。失敗時のみ固定＋Flex（重複送信なし）
async function crisisOneShotOrFallback(userId, userText, type /* 'danger' | 'scam' */) {
  const flex = (type === 'danger') ? EMERGENCY_FLEX_MESSAGE : makeScamMessageFlex();
  const fallback = (type === 'danger') ? EMERGENCY_REPLY_FALLBACK : SCAM_REPLY_FALLBACK;

  // GPT-4o最優先
  try {
    if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');
    const completion = await openai.chat.completions.create({
      model: CRISIS_MODEL,
      temperature: 0.4,
      max_tokens: 150,
      messages: [
        { role:'system', content: `${KOKORO_SYSTEM_PROMPT}\n短く安心感重視で1～2文。具体的アドバイスは穏やかに。連絡先の羅列はせず、すぐ下にFlexが出る前提。` },
        { role:'user', content: userText }
      ]
    });
    const msg = (completion.choices?.[0]?.message?.content || '').trim();
    const text = tidyReply(msg, userText) || '';
    if (text) {
      await safeReply(userId, [
        { type:'text', text },
        { type:'flex', altText: type === 'danger' ? '危険ワード検知' : '詐欺注意', contents: flex }
      ]);
      return 'ai';
    }
    // 空ならフォールバックへ
  } catch (e) {
    briefErr('crisisOneShotOrFallback GPT-4o failed', e);
  }

  // フォールバック（固定＋Flex）
  await safeReply(userId, fallback);
  return 'fallback';
}

/* =========================
 *  tidy/送信ラッパー
 * ========================= */
function tidyReply(s, userText) {
  if (!s) return s;
  const asked = /claris|クラリス|ヴァイオレット|エヴァーガーデン/i.test(userText);
  if (!asked) s = s.replace(/(ClariS|クラリス|ヴァイオレット・?エヴァーガーデン)/gi, '');
  s = s.replace(/\s+/g,' ').trim();
  const parts = s.split(/(?<=。|!|！|\?|？)/).filter(Boolean).slice(0, 2);
  s = parts.join(' ');
  const MAX_LENGTH = 120;
  if (toGraphemes(s).length > MAX_LENGTH) s = toGraphemes(s).slice(0, MAX_LENGTH - 1).join('') + '…';
  if (!/[^\w\s\u3000-\u303F\u3040-\u30FF\u4E00-\u9FFF]/.test(s)) s += ' 🌸';
  return s;
}
async function safePush(to, messages) {
  const arr = Array.isArray(messages) ? messages : [messages];
  try {
    for (const m of arr) {
      if (m.type === 'flex') {
        if (!m.altText || !m.altText.trim()) m.altText = '通知があります';
        if (!m.contents || typeof m.contents !== 'object') throw new Error(`[safePush] flex "contents" is required`);
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
async function safeReply(userIdOrReplyToken, messages) {
  // userIdが"U"で始まる場合はpush、そうでなければreplyTokenとみなす
  const first = String(userIdOrReplyToken || '');
  if (first.startsWith('U')) return safePush(userIdOrReplyToken, messages);
  try { await client.replyMessage(userIdOrReplyToken, Array.isArray(messages) ? messages : [messages]); }
  catch (e) { briefErr('safeReply', e); }
}

/* =========================
 *  1vs1リレー (/endで終了・TTL2h)
 * ========================= */
const RELAY_TTL_HOURS = 2;
async function startRelay(groupId, userId) {
  const id = `${groupId}_${userId}`;
  await db.collection('relaySessions').doc(id).set({
    groupId, userId, active: true,
    startedAt: Timestamp.now(),
    lastRelayAt: Timestamp.now(),
    expiresAt: Timestamp.fromDate(dayjs().utc().add(RELAY_TTL_HOURS, 'hour').toDate()),
  }, { merge: true });
}
async function endRelay(groupId, userId) {
  const id = `${groupId}_${userId}`;
  await db.collection('relaySessions').doc(id).set({ active: false }, { merge: true });
}
async function getActiveRelayByGroup(groupId) {
  const snap = await db.collection('relaySessions')
    .where('groupId', '==', groupId).where('active', '==', true)
    .orderBy('lastRelayAt', 'desc').limit(1).get();
  return snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
}
async function getActiveRelayByUser(userId) {
  const snap = await db.collection('relaySessions')
    .where('userId', '==', userId).where('active', '==', true)
    .orderBy('lastRelayAt', 'desc').limit(1).get();
  return snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
}
async function relayMessageFromGroup(event) {
  const groupId = event.source.groupId;
  const text = (event.message.text || '').trim();
  if (text === '/end') {
    const session = await getActiveRelayByGroup(groupId);
    if (session) { await endRelay(groupId, session.userId); await client.replyMessage(event.replyToken, { type:'text', text:'リレーを終了したよ🌸' }); }
    return true;
  }
  const session = await getActiveRelayByGroup(groupId);
  if (!session) return false;
  let sender = 'オフィサー';
  try { const profile = await client.getGroupMemberProfile(groupId, event.source.userId); sender = profile?.displayName || sender; } catch {}
  await safePush(session.userId, { type:'text', text:`【${sender}】 ${text}` });
  await db.collection('relaySessions').doc(session.id).set({ lastRelayAt: Timestamp.now() }, { merge: true });
  return true;
}
async function relayMessageFromUser(event) {
  const userId = event.source.userId;
  const text = (event.message.text || '').trim();
  const session = await getActiveRelayByUser(userId);
  if (!session) return false;
  if (text === '/end') {
    await endRelay(session.groupId, userId);
    await client.replyMessage(event.replyToken, { type:'text', text:'リレーを終了したよ🌸' });
    return true;
  }
  await safePush(session.groupId, { type:'text', text:`【利用者】 ${text}` });
  await db.collection('relaySessions').doc(session.id).set({ lastRelayAt: Timestamp.now() }, { merge: true });
  return true;
}

/* =========================
 *  固定応答（HP/名前など）
 * ========================= */
const specialRepliesMap = new Map([
  [/(ホームページ|HP|公式(?:サイト)?|サイト).*(どこ|URL|リンク|教えて|ありますか|\?|どれ)/i,
   "うん、あるよ🌸 コネクトのホームページはこちらだよ✨ → https://connect-npo.org"],
  [/君の名前|お前の名前|名前は/i,
   "わたしの名前は皆守こころ（みなもりこころ）です🌸 こころちゃんって呼んでね💖"],
  [/(どこの)?団体/i,
   "NPO法人コネクトのイメージキャラクターだよ😊 みんなの幸せを応援してるの🌸"],
  [/好きなアニメ/i,
   "『ヴァイオレット・エヴァーガーデン』が好きだよ🌸 心に響くお話なんだ。あなたはどれが好き？"],
  [/好きな(アーティスト|音楽)/i,
   "ClariSが好きだよ💖 とくに『コネクト』！あなたの推しも教えて～"],
]);

/* =========================
 *  イベント処理
 * ========================= */
const handleEvent = async (event) => {
  if (event.message?.type !== 'text') return;

  // まずリレー優先（通常応答をブロック）
  if (event.source.type === 'group') {
    const handled = await relayMessageFromGroup(event);
    if (handled) return;
  }
  if (event.source.type === 'user') {
    const handled = await relayMessageFromUser(event);
    if (handled) return;
  }

  const userId = event.source.userId;
  const text = event.message.text;
  let replied = false;

  try {
    // 相談モード（先行・1回だけ）
    if (CONSULT_TRIGGERS.some(w => normalizeJa(text).includes(normalizeJa(w)))) {
      const out = tidyReply(await generateConsultationOnce(text), text);
      await client.replyMessage(event.replyToken, { type:'text', text: out });
      replied = true;
      return;
    }

    // 危険/詐欺/不適切
    if (isDangerMessage(text)) {
      // GPT-4o優先→失敗時フォールバック（1回だけ送信）
      await crisisOneShotOrFallback(userId, text, 'danger');
      replied = true;
      audit("danger-message-replied", { userId: userHash(userId), text: text.slice(0,50), date:new Date() });

      // 併せてオフィサー通知（即時）
      try {
        const WATCH_GROUP_ID = (process.env.WATCH_GROUP_ID || process.env.OFFICER_GROUP_ID || '').trim();
        if (SEND_OFFICER_ALERTS && WATCH_GROUP_ID) {
          const udoc = await db.collection('users').doc(userId).get();
          const u = udoc.exists ? (udoc.data() || {}) : {};
          const prof = u.profile || {};
          const emerg = u.emergency || {};
          let heroUrl = ''; try { const p = await client.getProfile(userId); heroUrl = p?.pictureUrl || ''; } catch {}
          await safePush(WATCH_GROUP_ID, buildWatcherFlexRich({
            title:'危険ワード検知', text:'メッセージに危険ワードが含まれました。至急ご確認ください。',
            prof, emerg, userId, heroUrl
          }));
        }
      } catch (e) { briefErr('officer notify on danger failed', e); }
      return;
    }

    if (isScamMessage(text)) {
      await crisisOneShotOrFallback(userId, text, 'scam'); // GPT-4o優先
      replied = true;
      audit("scam-message-replied", { userId: userHash(userId), text: text.slice(0,50), date:new Date() });
      return;
    }

    if (isInappropriateMessage(text)) {
      await client.replyMessage(event.replyToken, [
        { type:'text', text:"いやだなと思ったら、無理しないでね。そんな言葉、こころは悲しくなっちゃう😢" }
      ]);
      replied = true;
      audit("inappropriate-message-replied", { userId: userHash(userId), text: text.slice(0,50), date:new Date() });
      return;
    }

    // 固定応答
    const specialReplyEntry = Array.from(specialRepliesMap.entries()).find(([regex]) => regex.test(text));
    if (specialReplyEntry) {
      await client.replyMessage(event.replyToken, { type:'text', text: specialReplyEntry[1] });
      replied = true;
      return;
    }

    // 通常AI返信
    try {
      const aiResponse = tidyReply(await getAIResponse(text), text);
      await client.replyMessage(event.replyToken, { type:'text', text: aiResponse || "読んだよ🌸 もう少し教えてね。" });
      replied = true;
    } catch (e) {
      console.error("[FALLBACK] AI経由返信に失敗:", e?.message || e);
    }

  } catch (outer) {
    console.error("[ERROR] handleEvent failed:", outer?.message || outer);
  } finally {
    if (!replied) {
      try {
        await client.replyMessage(event.replyToken, { type:'text', text:'今ちょっと調子が悪いみたい…でも読んだよ🌸 もう一度送ってみてね。' });
      } catch (e2) {
        console.error("[FATAL] replyMessage最終フォールバックも失敗:", e2?.message || e2);
      }
    }
  }
};

/* =========================
 *  Postback
 * ========================= */
const handlePostbackEvent = async (event, userId) => {
  const raw = String(event.postback?.data || '');
  const data = new URLSearchParams(raw);
  const action = data.get('action') || raw;

  switch (action) {
    case 'watch:ok': {
      const ref = db.collection('users').doc(userId);
      const doc = await ref.get();
      const ws = doc.data()?.watchService || {};
      if (!ws.awaitingReply) {
        await client.replyMessage(event.replyToken, { type:'text', text:'🌸ありがとう！見守りは継続するから、また連絡するね！😊' });
        return;
      }
      await scheduleNextPing(userId, new Date());
      await client.replyMessage(event.replyToken, { type:'text', text:'🌸OKありがとう！見守りは継続するから、また連絡するね！😊' });
      break;
    }
    case 'start_relay': { // オフィサー側からの「LINEで連絡」
      await client.replyMessage(event.replyToken, { type:'text', text:'🌸了解！このスレッドでメッセージを書いてね。/endで終了するよ。' });
      const targetUserId = data.get('uid');
      if (targetUserId && event.source.type === 'group') {
        await startRelay(event.source.groupId, targetUserId);
        await safePush(targetUserId, { type:'text', text:'🌸こころだよ。見守りグループからメッセージが届くね。困ったら /end で終了できるよ。' });
      }
      break;
    }
    case 'request_withdrawal': {
      try {
        await db.collection('users').doc(userId).delete();
        await client.replyMessage(event.replyToken, { type:'text', text:'🌸データを削除したよ。いままで話してくれてありがとう。また会えたら嬉しいな😊' });
      } catch (e) {
        briefErr('withdrawal failed', e);
        await client.replyMessage(event.replyToken, { type:'text', text:'ごめんね、ちょっと失敗しちゃった…また後で試してみてね💦' });
      }
      break;
    }
    default:
      await client.replyMessage(event.replyToken, { type:'text', text:'🌸了解したよ！' });
  }
};

/* =========================
 *  Follow/Unfollow/Join/Leave
 * ========================= */
const handleFollowEvent = async (event) => {
  const userId = event.source.userId;
  try {
    const userRef = db.collection('users').doc(userId);
    const doc = await userRef.get();
    if (doc.exists) {
      await userRef.set({
        followedAt: Timestamp.now(),
        unfollowedAt: firebaseAdmin.firestore.FieldValue.delete(),
        profile: firebaseAdmin.firestore.FieldValue.delete(),
        status: 'followed',
      }, { merge: true });
    } else {
      const profile = await client.getProfile(userId);
      await userRef.set({
        userId,
        followedAt: Timestamp.now(),
        status: 'followed',
        profile: { displayName: profile.displayName },
        createdAt: Timestamp.now(),
      }, { merge: true });
    }
    await client.replyMessage(event.replyToken, { type:'text', text:'こんにちは、こころだよ🌸 よかったら話そうね。おすすめはこちらだよ✨' });
    await client.pushMessage(userId, { type:'flex', altText:'会員登録はこちらから', contents: makeRegistrationButtonsFlex(userId) });
  } catch (e) { briefErr('follow event failed', e); }
};
const handleUnfollowEvent = async (event) => {
  await db.collection('users').doc(event.source.userId).set({
    unfollowedAt: Timestamp.now(), status: 'unfollowed'
  }, { merge: true });
};
const handleJoinEvent = async (event) => {
  if (event.source.type === 'group') {
    const groupId = event.source.groupId;
    await db.collection('system').doc('watch_group').set({ groupId, updatedAt: Timestamp.now() }, { merge: true });
    audit('joined-group', { groupId });
    await client.replyMessage(event.replyToken, {
      type:'text',
      text:'みんな、やっほー🌸 こころだよ！\n見守りサービスに登録してくれた子のための、見守りグループだね😊\nここからメッセージを送るよ！'
    });
  }
};
const handleLeaveEvent = async (event) => {
  if (event.source.type === 'group') {
    audit('left group', { groupId: event.source.groupId });
  }
};

/* =========================
 *  Webhook
 * ========================= */
app.post('/webhook', middleware({ channelSecret: LINE_CHANNEL_SECRET }), async (req, res) => {
  res.sendStatus(200);
  const events = req.body.events;
  if (!events?.length) return;

  try {
    await Promise.all(events.map(async (event) => {
      if (event.type === 'message')       await handleEvent(event);
      else if (event.type === 'postback') await handlePostbackEvent(event, event.source.userId);
      else if (event.type === 'follow')   await handleFollowEvent(event);
      else if (event.type === 'unfollow') await handleUnfollowEvent(event);
      else if (event.type === 'join')     await handleJoinEvent(event);
      else if (event.type === 'leave')    await handleLeaveEvent(event);
      else if (process.env.NODE_ENV !== 'production') {
        console.log("Unhandled event type:", event.type, event);
      }
    }));
  } catch (err) {
    console.error("🚨 Webhook処理中に予期せぬエラーが発生しました:", err);
  }
});

/* =========================
 *  Health
 * ========================= */
app.get('/', (_req, res) => res.send('こころチャットサービスが動いています！'));
app.get('/health', (_req, res) => res.status(200).send('OK'));

/* =========================
 *  起動
 * ========================= */
app.listen(PORT, () => {
  console.log(`こころチャットサービスはポート ${PORT} で稼働中です。`);
});
