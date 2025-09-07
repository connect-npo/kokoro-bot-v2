相談　そうだん　も入れたほうが良いよね　Gemini1.5Pro出すために　そこくらいは俺でも出来そう

あとはこれでいいか
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

// IPv4優先
dns.setDefaultResultOrder('ipv4first');

// ---------- URLユーティリティ ----------
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

// ---------- 環境変数 ----------
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

const AGREEMENT_FORM_BASE_URL = normalizeFormUrl(process.env.AGREEMENT_FORM_BASE_URL);
const ADULT_FORM_BASE_URL = normalizeFormUrl(process.env.ADULT_FORM_BASE_URL);
const STUDENT_MIDDLE_HIGH_UNI_FORM_BASE_URL = normalizeFormUrl(process.env.STUDENT_MIDDLE_HIGH_UNI_FORM_BASE_URL);
const WATCH_SERVICE_FORM_BASE_URL = normalizeFormUrl(process.env.WATCH_SERVICE_FORM_BASE_URL);
const MEMBER_CHANGE_FORM_BASE_URL = normalizeFormUrl(process.env.MEMBER_CHANGE_FORM_BASE_URL);
const MEMBER_CANCEL_FORM_BASE_URL = normalizeFormUrl(process.env.MEMBER_CANCEL_FORM_BASE_URL); // 退会フォーム未使用でも保持（将来用）
const OFFICER_GROUP_ID = process.env.OFFICER_GROUP_ID;

const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const EMERGENCY_CONTACT_PHONE_NUMBER = process.env.EMERGENCY_CONTACT_PHONE_NUMBER || '';
const BOT_ADMIN_IDS = JSON.parse(process.env.BOT_ADMIN_IDS || '[]');
const OWNER_USER_ID = process.env.OWNER_USER_ID || BOT_ADMIN_IDS[0];
const WATCH_RUNNER = process.env.WATCH_RUNNER || 'internal';
const WATCH_LOG_LEVEL = (process.env.WATCH_LOG_LEVEL || 'info').toLowerCase();

const WATCH_SERVICE_FORM_LINE_USER_ID_ENTRY_ID = process.env.WATCH_SERVICE_FORM_LINE_USER_ID_ENTRY_ID || 'entry.312175830';
const AGREEMENT_FORM_LINE_USER_ID_ENTRY_ID = process.env.AGREEMENT_FORM_LINE_USER_ID_ENTRY_ID || 'entry.790268681';
const STUDENT_MIDDLE_HIGH_UNI_FORM_LINE_USER_ID_ENTRY_ID = process.env.STUDENT_MIDDLE_HIGH_UNI_FORM_LINE_USER_ID_ENTRY_ID || 'entry.1100280108';
const ADULT_FORM_LINE_USER_ID_ENTRY_ID = process.env.ADULT_FORM_LINE_USER_ID_ENTRY_ID || 'entry.1694651394';
const MEMBER_CHANGE_FORM_LINE_USER_ID_ENTRY_ID = process.env.MEMBER_CHANGE_FORM_LINE_USER_ID_ENTRY_ID || 'entry.743637502';
const MEMBER_CANCEL_FORM_LINE_USER_ID_ENTRY_ID = process.env.MEMBER_CANCEL_FORM_LINE_USER_ID_ENTRY_ID || MEMBER_CHANGE_FORM_LINE_USER_ID_ENTRY_ID;
const SEND_OFFICER_ALERTS = process.env.SEND_OFFICER_ALERTS !== 'false';

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

// ---------- LINE ----------
const client = new Client({
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: LINE_CHANNEL_SECRET,
});

// keepAlive axios
const httpAgent = new require('http').Agent({ keepAlive: true });
const httpsAgent = new require('https').Agent({ keepAlive: true });
const httpInstance = axios.create({ timeout: 6000, httpAgent, httpsAgent });

// ---------- Express ----------
const PORT = process.env.PORT || 3000;
const app = express();
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 2));
app.use(helmet());
app.use('/webhook', rateLimit({ windowMs: 60_000, max: 100 }));

// ---------- ログ ----------
const audit = (event, detail) => console.log(`[AUDIT] ${event}`, JSON.stringify(detail));
const briefErr = (msg, e) => {
  const detail = e?.originalError?.response?.data || e?.response?.data || e?.message;
  console.error(`[ERR] ${msg}:`, JSON.stringify(detail, null, 2));
};
const userHash = (id) => crypto.createHash('sha256').update(String(id)).digest('hex');
const gTrunc = (s, l) => toGraphemes(s).slice(0, l).join('');

// ---------- 会員区分（モデル設定は呼び出し側で切替） ----------
const MEMBERSHIP_CONFIG = {
  guest:      { dailyLimit: 5,  model: 'gemini-1.5-flash-latest' },
  member:     { dailyLimit: 20, model: OPENAI_MODEL },
  subscriber: { dailyLimit: -1, model: OPENAI_MODEL },
  admin:      { dailyLimit: -1, model: OPENAI_MODEL },
};

// ---------- 見守り ----------
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
    }
  }, { merge: true });
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
  } catch {
    const snap = await usersRef.limit(500).get();
    for (const d of snap.docs) {
      const ws = (d.data().watchService) || {};
      if (!ws.awaitingReply && ws.nextPingAt?.toDate?.() && ws.nextPingAt.toDate() <= now.toDate()) targets.push(d);
    }
  }
  try {
    const snap = await usersRef.where('watchService.awaitingReply', '==', true).limit(200).get();
    targets.push(...snap.docs);
  } catch {
    const snap = await usersRef.limit(500).get();
    for (const d of snap.docs) if ((d.data().watchService || {}).awaitingReply === true) targets.push(d);
  }
  const map = new Map(); for (const d of targets) map.set(d.id, d); return [...map.values()];
}

function watchLog(msg, level = 'info') {
  if (WATCH_LOG_LEVEL === 'silent') return;
  if (WATCH_LOG_LEVEL === 'error' && level !== 'error') return;
  console.log(msg);
}
const logDebug = (msg) => watchLog(msg, 'info');

// 連絡ボタン
const telBtn = (label, phone) => phone ? ({ type:'button', style:'primary', action:{ type:'uri', label, uri:`tel:${phone}` } }) : null;
const maskPhone = p => {
  const v = String(p || '').replace(/[^0-9+]/g, '');
  if (!v) return '—';
  return v.length <= 4 ? `**${v}` : `${'*'.repeat(Math.max(0, v.length - 4))}${v.slice(-4)}`;
};

// リッチな見守りアラート（可能ならユーザーアイコン付き）
function buildWatcherFlexRich({ title='【見守りアラート】', text='応答がありません', prof={}, emerg={}, userId, heroUrl='' }) {
  const address = [prof.prefecture, prof.city, prof.line1, prof.line2].filter(Boolean).join(' ') || '—';
  return {
    type: 'flex',
    altText: title,
    contents: {
      type: 'bubble',
      hero: heroUrl ? {
        type: 'image',
        url: heroUrl,
        size: 'full',
        aspectRatio: '20:13',
        aspectMode: 'cover'
      } : undefined,
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

const OFFICER_NOTIFICATION_MIN_GAP_HOURS = Number(process.env.OFFICER_NOTIFICATION_MIN_GAP_HOURS || 1);

// 見守り判定＆送信（3日→OKなら次、24hで再送、29hでエスカレーション）
async function checkAndSendPing() {
  const now = dayjs().utc();
  logDebug(`[watch-service] start ${now.format('YYYY/MM/DD HH:mm:ss')} (UTC)`);
  const targets = await fetchTargets();
  if (!targets.length) { logDebug('[watch-service] no targets.'); return; }

  for (const doc of targets) {
    const ref = doc.ref;
    try {
      const s = await ref.get(); const u = s.data() || {}; const ws = u.watchService || {};
      const awaiting = !!ws.awaitingReply;
      const lastPingAt = ws.lastPingAt?.toDate?.() ? dayjs(ws.lastPingAt.toDate()) : null;
      const lastReminderAt = ws.lastReminderAt?.toDate?.() ? dayjs(ws.lastReminderAt.toDate()) : null;
      const lastNotifiedAt = ws.lastNotifiedAt?.toDate?.() ? dayjs(ws.lastNotifiedAt.toDate()) : null;

      let mode = awaiting ? 'noop' : 'ping';
      if (awaiting && lastPingAt) {
        const hrs = dayjs().utc().diff(dayjs(lastPingAt).utc(), 'hour');
        if      (hrs >= ESCALATE_AFTER_HOURS) mode = 'escalate';
        else if (hrs >= REMINDER_AFTER_HOURS) {
          if (!lastReminderAt || dayjs().utc().diff(dayjs(lastReminderAt).utc(), 'hour') >= 1) mode = 'remind';
          else mode = 'noop';
        } else mode = 'noop';
      }
      if (mode === 'noop') continue;

      if (mode === 'ping') {
        await safePush(doc.id, [
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
        await ref.set({ watchService:{
          lastPingAt: Timestamp.now(),
          awaitingReply: true,
          nextPingAt: firebaseAdmin.firestore.FieldValue.delete(),
          lastReminderAt: firebaseAdmin.firestore.FieldValue.delete(),
        }}, { merge:true });

      } else if (mode === 'remind') {
        await safePush(doc.id, [
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

      } else if (mode === 'escalate') {
        const WATCH_GROUP_ID = (process.env.WATCH_GROUP_ID || process.env.OFFICER_GROUP_ID || '').trim();
        const canNotifyOfficer = WATCH_GROUP_ID && (!lastNotifiedAt || dayjs().utc().diff(dayjs(lastNotifiedAt).utc(), 'hour') >= OFFICER_NOTIFICATION_MIN_GAP_HOURS);
        if (!WATCH_GROUP_ID) watchLog('[watch] WATCH_GROUP_ID is not set.', 'error');

        if (canNotifyOfficer) {
          const udoc = await db.collection('users').doc(doc.id).get();
          const ud = udoc.exists ? (udoc.data() || {}) : {};
          const prof = ud.profile || {};
          const emerg = ud.emergency || {};
          // 可能ならプロフィール画像を取得
          let heroUrl = '';
          try { const p = await client.getProfile(doc.id); heroUrl = p?.pictureUrl || ''; } catch {}
          await safePush(WATCH_GROUP_ID, buildWatcherFlexRich({
            title:'見守りアラート（29時間応答なし）',
            text:'返信が29時間ありません。安全確認をお願いします。',
            prof, emerg, userId: doc.id, heroUrl
          }));
        }
        await ref.set({ watchService:{
          lastNotifiedAt: Timestamp.now(),
          awaitingReply: false,
          lastReminderAt: firebaseAdmin.firestore.FieldValue.delete(),
          nextPingAt: Timestamp.fromDate(dayjs().tz(JST_TZ).add(PING_INTERVAL_DAYS, 'day').hour(15).minute(0).second(0).millisecond(0).toDate()),
        }},{ merge:true });
      }

    } catch (e) {
      console.error('[ERROR] watch send/update failed:', e?.response?.data || e.message);
    }
  }
  logDebug(`[watch-service] end ${dayjs().utc().format('YYYY/MM/DD HH:mm:ss')} (UTC)`);
}

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
    if (!ok) { watchLog(`[watch-service] Lock acquisition failed, skipping.`, 'info'); return false; }
    try { await fn(); } finally { await db.collection('locks').doc(lockId).delete().catch(()=>{}); }
    return true;
  });
}
if (WATCH_RUNNER !== 'external') {
  cron.schedule('*/5 * * * *', () => { withLock('watch-cron', 240, checkAndSendPing); }, { scheduled:true, timezone:'UTC' });
}

// ---------- 緊急先/詐欺 Flex ----------
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

const makeScamMessageFlex = () => {
  const contents = [
    { type:'button', style:'primary', action:{ type:'uri', label:'国民生活センター', uri:'https://www.kokusen.go.jp/' } },
    { type:'button', style:'primary', action:{ type:'message', label:'警察 (110)', text:'110に電話する' } },
    { type:'button', style:'primary', action:{ type:'message', label:'消費者ホットライン (188)', text:'188に電話する' } },
  ];
  if (EMERGENCY_CONTACT_PHONE_NUMBER) {
    contents.push({ type:'button', style:'primary', action:{ type:'uri', label:'こころちゃん事務局（電話）', uri:`tel:${EMERGENCY_CONTACT_PHONE_NUMBER}` } });
  }
  return {
    type:'bubble',
    body:{ type:'box', layout:'vertical', contents:[
      { type:'text', text:'【詐欺注意】', weight:'bold', size:'xl', align:'center' },
      { type:'text', text:'怪しいお話には注意してね！不安な時は、信頼できる人に相談してね💖', wrap:true, margin:'md' },
    ]},
    footer:{ type:'box', layout:'vertical', spacing:'sm', contents }
  };
};

// ---------- 会員登録Flex（見守り→小学生（同意書）に変更） ----------
const makeRegistrationButtonsFlex = (userId) => ({
  type:'bubble',
  body:{ type:'box', layout:'vertical',
    contents:[ { type:'text', text:'どの会員になるか選んでね🌸', wrap:true, weight:'bold', size:'md' } ] },
  footer:{ type:'box', layout:'vertical', spacing:'sm', contents:[
    // 小学生（同意書）
    { type:'button', style:'primary', height:'sm',
      action:{ type:'uri', label:'小学生（同意書）',
        uri: prefillUrl(AGREEMENT_FORM_BASE_URL, { [AGREEMENT_FORM_LINE_USER_ID_ENTRY_ID]: userId }) } },
    // 中高大（既存）
    { type:'button', style:'primary', height:'sm',
      action:{ type:'uri', label:'学生（中学・高校・大学）',
        uri: prefillUrl(STUDENT_MIDDLE_HIGH_UNI_FORM_BASE_URL, { [STUDENT_MIDDLE_HIGH_UNI_FORM_LINE_USER_ID_ENTRY_ID]: userId }) } },
    // 大人
    { type:'button', style:'primary', height:'sm',
      action:{ type:'uri', label:'大人（一般）',
        uri: prefillUrl(ADULT_FORM_BASE_URL, { [ADULT_FORM_LINE_USER_ID_ENTRY_ID]: userId }) } },
    // 会員情報変更
    { type:'button', style:'primary', height:'sm',
      action:{ type:'uri', label:'会員情報を変更する',
        uri: prefillUrl(MEMBER_CHANGE_FORM_BASE_URL, { [MEMBER_CHANGE_FORM_LINE_USER_ID_ENTRY_ID]: userId }) } },
    // 退会（フォームなし→データ削除リクエストへ誘導するポストバック）
    { type:'button', style:'secondary', height:'sm',
      action:{ type:'postback', label:'退会（データ削除）', data:'action=request_withdrawal' } },
  ] }
});

// ---------- 危険/詐欺/不適切 ----------
const toHiragana = (s) => s.replace(/[\u30a1-\u30f6]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60));
const nfkc = (s) => String(s || '').normalize('NFKC');
const normalizeJa = (s) => toHiragana(nfkc(String(s || '')).toLowerCase());

// 危険ワード（※「つらい／辛い／貧乏／死にそう」は除外）
const DANGER_WORDS = [
  "しにたい","死にたい","自殺","消えたい","リスカ","リストカット","OD","オーバードーズ",
  "殴られる","たたかれる","暴力","DV","無理やり","お腹蹴られる","蹴られた","頭叩かれる",
  "虐待","パワハラ","セクハラ","ハラスメント","いじめ","イジメ","嫌がらせ",
  "つけられてる","追いかけられている","ストーカー","盗撮","盗聴",
  "助けて","たすけて",
  "死んでやる","死んでしまいたい","消えてしまいたい","生きるのがつらい","もう無理","もういやだ"
];

// “相談モード”トリガ（Gemini 1.5 Proで1回返答）
const CONSULT_TRIGGERS = [
  "誰かに相談したい","相談したい","相談に乗って","相談","そうだん"
];

const SCAM_WORDS = [
  "詐欺","さぎ","サギ","ｻｷﾞ","フィッシング","架空請求","ワンクリック詐欺","特殊詐欺","オレオレ詐欺",
  "当選","高額当選","宝くじ","ロト","ビットコイン","投資","バイナリー","暗号資産",
  "未払い","滞納","訴訟","裁判","裁判所","訴える",
  "副業","在宅ワーク","転売","アフィリエイト","MLM","マルチ商法",
  "絶対儲かる","簡単に稼げる","今だけ","限定","無料",
  "クリック","ログイン","個人情報","送って","教えて",
  "有料サイト","登録","退会","解約",
  "クレジットカード","クレカ","銀行口座","口座番号","パスワード"
];

const INAPPROPRIATE_WORDS = [
  "セックス","セフレ","エッチ","AV","アダルト","ポルノ","童貞","処女","挿入","射精",
  "バイブ","オナニー","マスターベーション","自慰","絶頂","膣","ペニス",
  "ちんちん","おまんこ","まんこ","おっぱい","ちんぽ","性病","中出し",
  "妊娠","堕胎","レイプ","強姦","売春","買春","ホモ","レズ","ゲイ",
  "殺す","殺害","しね","死ね","殺してやる","殺して","爆弾","テロ","殺人",
  "バカ","アホ","クソ","馬鹿"
];

function isDangerMessage(text) {
  const norm = normalizeJa(text);
  return DANGER_WORDS.some(w => norm.includes(normalizeJa(w)));
}
function isConsultation(text) {
  const norm = normalizeJa(text);
  return CONSULT_TRIGGERS.some(w => norm.includes(normalizeJa(w)));
}
function isScamMessage(text) {
  const norm = normalizeJa(text);
  if (/(詐欺|さぎ)/.test(norm)) return true;
  return SCAM_WORDS.some(w => norm.includes(normalizeJa(w)));
}
function isInappropriateMessage(text) {
  const norm = normalizeJa(text);
  return INAPPROPRIATE_WORDS.some(w => norm.includes(normalizeJa(w)));
}

// ---------- AI ----------
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

// モデル自動選択：短文→Gemini Flash、長文→GPT-4o mini
function pickChatModelByLength(text) {
  return (toGraphemes(text).length <= 50) ? 'gemini-1.5-flash' : OPENAI_MODEL;
}

// 相談モード（Gemini 1.5 Proで1回だけ）
async function generateConsultationOnce(text) {
  try {
    const model = genai.getGenerativeModel({ model: 'gemini-1.5-pro', safetySettings: [
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_MEDIUM_AND_ABOVE" }
    ]});
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

// 通常AI返信
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
  } catch (e) {
    briefErr(`AI response failed for ${modelName}`, e);
  }
  return aiResponse || "読んだよ🌸 よかったらもう少し教えてね。";
}

// tidy
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

// 固定返答
const DANGER_REPLY = [
  { type:'text', text:"つらかったね。ひとりじゃないよ。今すぐ助けが要るときは下の連絡先を使ってね🌸" },
  { type:'flex', altText:'危険ワード検知', contents: EMERGENCY_FLEX_MESSAGE }
];
const SCAM_REPLY = [
  { type:'text', text:"あやしい話かも。急がず確認しよ？困ったら下の窓口も使ってね🌸" },
  { type:'flex', altText:'詐欺注意', contents: makeScamMessageFlex() }
];
const INAPPROPRIATE_REPLY = [
  { type:'text', text:"いやだなと思ったら、無理しないでね。そんな言葉、こころは悲しくなっちゃう😢" }
];

// 固定（HP/名前など）
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

// ---------- イベント ----------
const handleEvent = async (event) => {
  if (event.message?.type !== 'text') return;
  const userId = event.source.userId;
  const text = event.message.text;
  let replied = false;

  try {
    // 1) 相談モード（先行・1回だけ）
    if (isConsultation(text)) {
      const out = tidyReply(await generateConsultationOnce(text), text);
      await client.replyMessage(event.replyToken, { type:'text', text: out });
      replied = true;
      return;
    }

    // 2) 危険/詐欺/不適切
    if (isDangerMessage(text)) {
      await client.replyMessage(event.replyToken, DANGER_REPLY);
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
          let heroUrl = '';
          try { const p = await client.getProfile(userId); heroUrl = p?.pictureUrl || ''; } catch {}
          await safePush(WATCH_GROUP_ID, buildWatcherFlexRich({
            title:'危険ワード検知', text:'メッセージに危険ワードが含まれました。至急ご確認ください。',
            prof, emerg, userId, heroUrl
          }));
        }
      } catch (e) { briefErr('officer notify on danger failed', e); }
      return;
    }
    if (isScamMessage(text)) {
      await client.replyMessage(event.replyToken, SCAM_REPLY);
      replied = true;
      audit("scam-message-replied", { userId: userHash(userId), text: text.slice(0,50), date:new Date() });
      return;
    }
    if (isInappropriateMessage(text)) {
      await client.replyMessage(event.replyToken, INAPPROPRIATE_REPLY);
      replied = true;
      audit("inappropriate-message-replied", { userId: userHash(userId), text: text.slice(0,50), date:new Date() });
      return;
    }

    // 3) 固定応答
    const specialReplyEntry = Array.from(specialRepliesMap.entries()).find(([regex]) => regex.test(text));
    if (specialReplyEntry) {
      await client.replyMessage(event.replyToken, { type:'text', text: specialReplyEntry[1] });
      replied = true;
      return;
    }

    // 4) 通常AI返信
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

// Postback
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
      await client.replyMessage(event.replyToken, { type:'text', text:'🌸了解！' });
      const targetUserId = data.get('uid');
      if (targetUserId) {
        await safePush(targetUserId, { type:'text', text:'🌸こころだよ！誰かがあなたのことを心配してるみたいだよ！大丈夫？無理しないでね😊' });
      }
      break;
    }
    case 'request_withdrawal': {
      // 退会: データ削除（必要な範囲に合わせて調整）
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

// Follow/Unfollow/Join/Leave
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
  } catch (e) {
    briefErr('follow event failed', e);
  }
};

const handleUnfollowEvent = async (event) => {
  await db.collection('users').doc(event.source.userId).set({
    unfollowedAt: Timestamp.now(), status: 'unfollowed'
  }, { merge: true });
};

const handleJoinEvent = async (event) => {
  if (event.source.type === 'group') {
    const groupId = event.source.groupId;
    audit('joined-group', { groupId });
    // 参加グループを見守りグループとしてアクティブ化
    await db.collection('system').doc('watch_group').set({ groupId, updatedAt: Timestamp.now() }, { merge: true });
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

// Webhook
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

// Health
app.get('/', (_req, res) => res.send('こころチャットサービスが動いています！'));
app.get('/health', (_req, res) => res.status(200).send('OK'));

// 起動
app.listen(PORT, () => {
  console.log(`こころチャットサービスはポート ${PORT} で稼働中です。`);
});
