'use strict';

/*
 index.js (angel-kokoro, refined-2025-09-08-final)
 - 通常会話：Gemini 1.5 FlashとGPT-4o-miniを文字数で使い分け
 - 危険 > 詐欺 > 不適切語 > 共感 の優先判定
 - 危険は2文+危険FLEX→見守りグループへFLEX通知
 - 詐欺は2文+詐欺FLEX（見守りはテキスト+FLEX、モノトーン）
 - 会員登録FLEX：カラー / 見守り・詐欺FLEX：モノトーン / 危険FLEX：カラー
 - 見守り29h未応答→グループFLEX（LINEで連絡 + 本人/近親者TEL）
 - リレー中（グループ↔本人）は“こころ返信停止”（本人↔事務局の会話を阻害しない）
 - 不適切語：1回目=お答え不可、2回目=警告、3回目=7日停止（停止中は初回のみ通知→以降サイレント）
 - 通常会話：50文字以下→Gemini 1.5 Flash、50文字超→GPT-4o-miniで応答
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
const httpMod = require('http');
const httpsMod = require('https');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc); dayjs.extend(timezone);

let openai = null;
let googleGenerativeAI = null;
const _splitter = new GraphemeSplitter();
const toGraphemes = (s) => _splitter.splitGraphemes(String(s || ''));

const { Client, middleware } = require('@line/bot-sdk');

// ===== Logging =====
const LV = { error: 0, warn: 1, info: 2, debug: 3 };
const WATCH_LOG_LEVEL = (process.env.WATCH_LOG_LEVEL || 'info').toLowerCase();
const LV_ALLOW = LV[WATCH_LOG_LEVEL] ?? LV.info;
const log = (lvl, ...args) => { if ((LV[lvl] ?? LV.debug) <= LV_ALLOW) console.log(...args) };
const audit = (e, detail) => log('info', `[AUDIT] ${e}`, JSON.stringify(detail));
const briefErr = (msg, e) => {
  const detail = e?.originalError?.response?.data || e?.response?.data || e?.message;
  console.error(`[ERR] ${msg}:`, JSON.stringify(detail, null, 2));
};

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
const sanitizeForLog = (text) => String(text).replace(/\s+/g, ' ').trim();
const maskPhone = (raw='') => {
  const s = String(raw).replace(/[^0-9+]/g, ''); if (!s) return '';
  const tail = s.slice(-4); const head = s.slice(0, -4).replace(/[0-9]/g, '＊'); return head + tail;
};
const toArr = (m) => Array.isArray(m) ? m : [m];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// ===== ENV =====
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET        = process.env.LINE_CHANNEL_SECRET;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL   = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL   = process.env.GEMINI_MODEL || 'gemini-1.5-flash';

const AGREEMENT_FORM_BASE_URL                 = normalizeFormUrl(process.env.AGREEMENT_FORM_BASE_URL);
const ADULT_FORM_BASE_URL                     = normalizeFormUrl(process.env.ADULT_FORM_BASE_URL);
const STUDENT_MIDDLE_HIGH_UNI_FORM_BASE_URL = normalizeFormUrl(process.env.STUDENT_MIDDLE_HIGH_UNI_FORM_BASE_URL);
const WATCH_SERVICE_FORM_BASE_URL             = normalizeFormUrl(process.env.WATCH_SERVICE_FORM_BASE_URL);
const MEMBER_CHANGE_FORM_BASE_URL             = normalizeFormUrl(process.env.MEMBER_CHANGE_FORM_BASE_URL);
const MEMBER_CANCEL_FORM_BASE_URL             = normalizeFormUrl(process.env.MEMBER_CANCEL_FORM_BASE_URL);

const WATCH_SERVICE_FORM_LINE_USER_ID_ENTRY_ID     = process.env.WATCH_SERVICE_FORM_LINE_USER_ID_ENTRY_ID || 'entry.312175830';
const AGREEMENT_FORM_LINE_USER_ID_ENTRY_ID         = process.env.AGREEMENT_FORM_LINE_USER_ID_ENTRY_ID || 'entry.790268681';
const STUDENT_MIDDLE_HIGH_UNI_FORM_LINE_USER_ID_ENTRY_ID = process.env.STUDENT_MIDDLE_HIGH_UNI_FORM_LINE_USER_ID_ENTRY_ID || 'entry.1100280108';
const ADULT_FORM_LINE_USER_ID_ENTRY_ID             = process.env.ADULT_FORM_LINE_USER_ID_ENTRY_ID || 'entry.1694651394';
const MEMBER_CHANGE_FORM_LINE_USER_ID_ENTRY_ID     = process.env.MEMBER_CHANGE_FORM_LINE_USER_ID_ENTRY_ID || 'entry.743637502';
const MEMBER_CANCEL_FORM_LINE_USER_ID_ENTRY_ID     = process.env.MEMBER_CANCEL_FORM_LINE_USER_ID_ENTRY_ID || MEMBER_CHANGE_FORM_LINE_USER_ID_ENTRY_ID;

const OFFICER_GROUP_ID     = process.env.OFFICER_GROUP_ID;
const SEND_OFFICER_ALERTS = process.env.SEND_OFFICER_ALERTS !== 'false';
const SCAM_ALERT_TO_WATCH_GROUP = String(process.env.SCAM_ALERT_TO_WATCH_GROUP || 'true').toLowerCase() === 'true';

const EMERGENCY_CONTACT_PHONE_NUMBER = (process.env.ORG_CONTACT_TEL || process.env.EMERGENCY_CONTACT_PHONE_NUMBER || '').replace(/[^0-9+]/g,'');
const LINE_ADD_FRIEND_URL = process.env.LINE_ADD_FRIEND_URL;

const WATCH_RUNNER = process.env.WATCH_RUNNER || 'internal';

const ORG_NAME       = process.env.ORG_NAME       || 'NPO法人コネクト';
const ORG_SHORT_NAME = process.env.ORG_SHORT_NAME || 'コネクト';
const HOMEPAGE_URL   = normalizeFormUrl(process.env.HOMEPAGE_URL || 'https://connect-npo.or.jp');
const ORG_MISSION    = process.env.ORG_MISSION    || 'こども・若者・ご高齢の方の安心と笑顔を守る活動';
const ORG_REP      = (process.env.ORG_REP || '松本博文'); // 固定
const ORG_CONTACT_TEL= (process.env.ORG_CONTACT_TEL || EMERGENCY_CONTACT_PHONE_NUMBER || '').replace(/[^0-9+]/g,'');

// ===== AI Clients =====
try {
  if (OPENAI_API_KEY) {
    const OpenAI = require('openai');
    openai = new OpenAI({ apiKey: OPENAI_API_KEY });
  }
  if (GEMINI_API_KEY) {
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    googleGenerativeAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  }
} catch (_) { /* ignore */ }

// ===== Firebase =====
let creds = null;
if (process.env.FIREBASE_CREDENTIALS_BASE64) {
  creds = JSON.parse(Buffer.from(process.env.FIREBASE_CREDENTIALS_BASE64, "base64").toString("utf-8"));
}
if (!firebaseAdmin.apps.length) {
  if (!creds) {
    try { creds = require("./serviceAccountKey.json"); }
    catch { throw new Error("FIREBASE_CREDENTIALS_BASE64 or serviceAccountKey.json required"); }
  }
  firebaseAdmin.initializeApp({ credential: firebaseAdmin.credential.cert(creds) });
  console.log("✅ Firebase initialized");
}
const db = firebaseAdmin.firestore();
const Timestamp = firebaseAdmin.firestore.Timestamp;

// ===== LINE client =====
const client = new Client({ channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN, channelSecret: LINE_CHANNEL_SECRET });

// ===== HTTP =====
const httpAgent = new httpMod.Agent({ keepAlive: true });
const httpsAgent = new httpsMod.Agent({ keepAlive: true });
const http = axios.create({ timeout: 6000, httpAgent, httpsAgent });

// ===== App =====
const PORT = process.env.PORT || 10000;
const app = express();
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 2));
app.use(helmet());
// 注意：/webhook には LINE の署名検証があるため、ここで app.use(express.json()) は付けない
app.use('/webhook', rateLimit({ windowMs: 60_000, max: 100 }));

// ===== Reply helpers =====
function ensureMsgShape(messages) {
  return toArr(messages).map(m => {
    if (m.type === 'flex' && !m.altText) m.altText = '通知があります';
    if (m.type === 'text') {
      m.text = String(m.text || '').trim() || '（内容なし）';
      if (m.text.length > 1800) m.text = m.text.slice(0, 1800);
    }
    return m;
  });
}
async function safeReplyOrPush(replyToken, to, messages) {
  const arr = ensureMsgShape(messages);
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
  const arr = ensureMsgShape(messages);
  try { await client.pushMessage(to, arr); }
  catch (err) { briefErr('LINE push failed', err); }
}

// ===== Watch service =====
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
const pickWatchMsg = () => pick(watchMessages);
const nextPingAtFrom = (fromDate) =>
  dayjs(fromDate).tz(JST_TZ).add(PING_INTERVAL_DAYS, 'day').hour(15).minute(0).second(0).millisecond(0).toDate();

async function scheduleNextPing(userId) {
  try {
    const ref = db.collection('users').doc(userId);
    await ref.set({
      watchService: {
        awaitingReply: false,
        nextPingAt: firebaseAdmin.firestore.Timestamp.fromDate(
          nextPingAtFrom(dayjs().tz(JST_TZ).toDate())
        ),
        lastReminderAt: firebaseAdmin.firestore.FieldValue.delete(),
        notifyLockExpiresAt: firebaseAdmin.firestore.FieldValue.delete(),
      }
    }, { merge: true });
  } catch (e) { briefErr('scheduleNextPing failed', e); }
}

// watch-group id store
const getWatchGroupDoc = () => firebaseAdmin.firestore().collection('system').doc('watch_group');
async function getActiveWatchGroupId() {
  const envGid = (process.env.WATCH_GROUP_ID || process.env.OFFICER_GROUP_ID || '').trim().replace(/\u200b/g, '');
  if (/^C[0-9A-Za-z_-]{20,}$/.test(envGid)) return envGid;
  const snap = await getWatchGroupDoc().get();
  const v = snap.exists ? (snap.data().groupId || '') : '';
  return /^C[0-9A-Za-z_-]{20,}$/.test(v) ? v : '';
}
async function setActiveWatchGroupId(gid) {
  await getWatchGroupDoc().set(
    gid
      ? { groupId: gid, updatedAt: Timestamp.now() }
      : { groupId: firebaseAdmin.firestore.FieldValue.delete(), updatedAt: Timestamp.now() },
    { merge: true }
  );
}

// ===== FLEX builders =====
const telBtn = (label, tel) => {
  const raw = String(tel || '').trim();
  if (!raw) return null;
  return { type: 'button', style: 'primary', height: 'sm', action: { type: 'uri', label, uri: `tel:${raw}` } };
};

// 危険FLEX（カラー固定）
const makeDangerFlex = () => {
  const contents = [
    { type:'button', style:'primary', height:'sm', action:{ type:'uri', label:'警察 (110)', uri:'tel:110' }, color:'#FF6666' },
    { type:'button', style:'primary', height:'sm', action:{ type:'uri', label:'消防・救急 (119)', uri:'tel:119' }, color:'#FFA500' },
    { type:'button', style:'primary', height:'sm', action:{ type:'uri', label:'いのちの電話', uri:'tel:0570064556' }, color:'#66CCFF' },
    { type:'button', style:'primary', height:'sm', action:{ type:'uri', label:'チャイルドライン', uri:'tel:0120997777' }, color:'#66CCFF' },
    { type:'button', style:'primary', height:'sm', action:{ type:'uri', label:'警視庁', uri:'tel:0335814321' }, color:'#66CCFF' }
  ];
  if (ORG_CONTACT_TEL) contents.push({ type:'button', style:'primary', height:'sm', action:{ type:'uri', label:'こころチャット事務局', uri:`tel:${ORG_CONTACT_TEL}` }, color:'#FF99CC' });
  return {
    type:'flex',
    altText:'危険ワード検知',
    contents:{
      type:'bubble',
      body:{ type:'box', layout:'vertical', contents:[
        { type:'text', text:'【危険ワード検知】', weight:'bold', size:'xl' },
        { type:'text', text:'いまは安全がいちばん。必要ならすぐ連絡してね。', margin:'md', wrap:true }
      ]},
      footer:{ type:'box', layout:'vertical', spacing:'sm', contents }
    }
  };
};

// 詐欺FLEX（モノトーン）
const makeScamMessageFlex = () => {
  const contents = [
    { type:'button', style:'primary', height:'sm', action:{ type:'uri', label:'国民生活センター', uri:'https://www.kokusen.go.jp/' } },
    { type:'button', style:'primary', height:'sm', action:{ type:'uri', label:'警察 (110)', uri:'tel:110' } },
    { type:'button', style:'primary', height:'sm', action:{ type:'uri', label:'消費者ホットライン (188)', uri:'tel:188' } },
  ];
  if (ORG_CONTACT_TEL) contents.push({ type:'button', style:'primary', height:'sm', action:{ type:'uri', label:'こころチャット事務局', uri:`tel:${ORG_CONTACT_TEL}` } });
  return {
    type:'flex', altText:'詐欺注意',
    contents:{
      type:'bubble',
      body:{ type:'box', layout:'vertical', contents:[
        { type:'text', text:'【詐欺注意】', weight:'bold', size:'xl', align:'center' },
        { type:'text', text:'慌てず、公式アプリ/正規サイトで確認しよう。怪しいリンクは押さないでね。', wrap:true, margin:'md' }
      ]},
      footer:{ type:'box', layout:'vertical', spacing:'sm', contents }
    }
  };
};

// 会員登録FLEX（カラー固定）
const makeRegistrationButtonsFlex = (userId) => ({
  type:'flex', altText:'会員登録メニュー',
  contents:{
    type:'bubble',
    body:{ type:'box', layout:'vertical', contents:[
      { type:'text', text:'どの会員になるか選んでね🌸', wrap:true, weight:'bold', size:'md' }
    ]},
    footer:{ type:'box', layout:'vertical', spacing:'sm', contents:[
      { type:'button', style:'primary', height:'sm', color:'#90EE90',
        action:{ type:'uri', label:'小学生（同意書）', uri:prefillUrl(AGREEMENT_FORM_BASE_URL, { [AGREEMENT_FORM_LINE_USER_ID_ENTRY_ID]: userId }) } },
      { type:'button', style:'primary', height:'sm', color:'#ADD8E6',
        action:{ type:'uri', label:'学生（中学・高校・大学）', uri:prefillUrl(STUDENT_MIDDLE_HIGH_UNI_FORM_BASE_URL, { [STUDENT_MIDDLE_HIGH_UNI_FORM_LINE_USER_ID_ENTRY_ID]: userId }) } },
      { type:'button', style:'primary', height:'sm', color:'#87CEFA',
        action:{ type:'uri', label:'大人（一般）', uri:prefillUrl(ADULT_FORM_BASE_URL, { [ADULT_FORM_LINE_USER_ID_ENTRY_ID]: userId }) } },
      { type:'button', style:'primary', height:'sm', color:'#FFC0CB',
        action:{ type:'uri', label:'会員情報を変更する', uri:prefillUrl(MEMBER_CHANGE_FORM_BASE_URL, { [MEMBER_CHANGE_FORM_LINE_USER_ID_ENTRY_ID]: userId }) } },
      { type:'button', style:'primary', height:'sm', color:'#DDA0DD',
        action:{ type:'uri', label:'退会', uri:prefillUrl(MEMBER_CANCEL_FORM_BASE_URL, { [MEMBER_CANCEL_FORM_LINE_USER_ID_ENTRY_ID]: userId }) } },
    ] }
  }
});

// 見守りメニュー（モノトーン）
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
      ...(ORG_CONTACT_TEL ? [ telBtn('こころチャット事務局', ORG_CONTACT_TEL) ] : [])
    ].filter(Boolean)}
  }
});

// 団体案内FLEX
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
    ...(ORG_CONTACT_TEL ? [ telBtn('電話する', ORG_CONTACT_TEL) ] : [])
  ].filter(Boolean)}
});

// グループ通知FLEX（危険/詐欺/29h未応答 共通、モノトーン）
const buildGroupAlertFlex = ({ kind='危険', name='—', userId='—', excerpt='—', selfPhone='', kinName='', kinPhone='' }) => {
  const telSelfBtn = selfPhone ? telBtn('本人に電話', selfPhone) : null;
  const telKinBtn  = kinPhone  ? telBtn('近親者に電話', kinPhone) : null;
  return {
    type: 'flex',
    altText: `【${kind}】${name}`,
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type:'text', text:`【${kind}アラート】`, weight:'bold', size:'lg' },
          { type:'text', text:`利用者：${name}`, wrap:true },
          { type:'text', text:`UserID：${userId}`, size:'sm', color:'#777777', wrap:true },
          { type:'text', text:`本文：${excerpt}`, size:'sm', wrap:true },
          ...(selfPhone ? [{ type:'text', text:`本人TEL：${maskPhone(selfPhone)}`, size:'sm', color:'#777777' }] : []),
          ...(kinPhone  ? [{ type:'text', text:`近親者：${kinName || '—'}（${maskPhone(kinPhone)}）`, size:'sm', color:'#777777', wrap:true }] : []),
        ]
      },
      footer: {
        type: 'box', layout:'vertical', spacing:'sm',
        contents: [
          { type:'button', style:'primary', action:{ type:'postback', label:'LINEで連絡', data:`action=start_relay&uid=${encodeURIComponent(userId)}` } },
          ...(telSelfBtn ? [telSelfBtn] : []),
          ...(telKinBtn  ? [telKinBtn]  : []),
        ]
      }
    }
  };
};

// ===== Normalize & intents =====
const toHiragana = (s) => s.replace(/[\u30a1-\u30f6]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60));
const nfkc = (s) => s.normalize('NFKC');
const normalizeJa = (s) => toHiragana(nfkc(String(s || '')).toLowerCase());

const HOMEPAGE_INTENT = /(ホームページ|hp|公式(?:サイト)?|サイト)/i;
const HOMEPAGE_FOLLOWUP = /(どこ|url|リンク|教えて|ありますか|ある|ある？|とか|どれ|見せて|\?)/i;
const isHomepageIntent = (t) => {
  if (!t) return false;
  const hit = HOMEPAGE_INTENT.test(t) && HOMEPAGE_FOLLOWUP.test(t);
  const shortOnly = HOMEPAGE_INTENT.test(t) && toGraphemes(t).length <= 8;
  return hit || shortOnly;
};
const ORG_INTENT = /(どこの団体|どんな団体|何の団体|npo|コネクトって(何|どんな|どこ)|代表|理事長|連絡先|お問い合わせ|住所|所在地)/i;
const ORG_SUSPICIOUS = /(怪しい|胡散臭い|反社|あやしい|危ない)/i;

// ===== 会話・固定設定（こころちゃん） =====
const CLARIS_SONG_FAVORITE_REPLY = 'やっぱり『コネクト』かな！💖　元気になれる曲だよ😊';
const specialReplies = new Map([
  [/君の名前(なんていうの|は|教えて|なに)？?|名前(なんていうの|は|教えて|なに)？?|お前の名前は/i, "わたしの名前は皆守こころ（みなもりこころ）です🌸　こころちゃんって呼んでくれると嬉しいな💖"],
  [/こころじゃないの？/i, "うん、わたしの名前は皆守こころ💖　これからもよろしくね🌸"],
  [/こころチャットなのにうそつきじゃん/i, "ごめんね💦 わたしの名前は皆守こころだよ🌸 誤解させちゃってごめんね💖"],
  [/名前も言えないの？/i, "ごめんね、わたしの名前は皆守こころ（みなもりこころ）だよ🌸 こころちゃんって呼んでくれると嬉しいな💖"],
  [/どこの団体なの？/i, "NPO法人コネクトっていう団体のイメージキャラクターをしているよ😊　みんなの幸せを応援してるんだ🌸"],
  [/コネクトってどんな団体？/i, "NPO法人コネクトは、こどもやご年配の方の笑顔を守る団体なんだよ😊　わたしはそのイメージキャラクターとしてがんばってます🌸"],
  [/お前の団体どこ？/i, "NPO法人コネクトっていう団体のイメージキャラクターをしているよ😊　みんなの幸せを応援しているよ🌸"],
  [/コネクトのイメージキャラなのにいえないのかよｗ/i, "ごめんね💦 わたしはNPO法人コネクトのイメージキャラクター、皆守こころだよ🌸 安心して、何でも聞いてね💖"],
  [/こころちゃん(だよ|いるよ)?/i, "こころちゃんだよ🌸　何かあった？💖　話して聞かせてくれると嬉しいな😊"],
  [/元気かな/i, "うん、元気だよ！あなたは元気？🌸 何かあったら、いつでも話してね💖"],
  [/元気？/i, "うん、元気だよ！あなたは元気？🌸 何かあったら、いつでも話してね💖"],
  [/あやしい|胡散臭い|反社/i, "そう思わせてたらごめんね😊 でも私たちはみんなの為に頑張っているんだ💖"],
  [/税金泥棒/i, "税金は人の命を守るために使われるべきだよ。わたしは誰かを傷つけるために使われないように頑張っているんだ💡"],
  [/松本博文/i, "松本理事長は、やさしさでみんなを守るために活動しているよ。心配なことがあれば、わたしにも教えてね🌱"],
  [/ホームページ(教えて|ある|ありますか)？?/i, `うん、あるよ🌸　${ORG_SHORT_NAME}のホームページはこちらだよ✨ → ${HOMEPAGE_URL}`],
  [/コネクトのホームページだよ？/i, `教えてくれてありがとう😊 ${ORG_SHORT_NAME}のホームページはこちらだよ✨ → ${HOMEPAGE_URL}`],
  [/使えないな/i, "ごめんね…。わたし、もっと頑張るね💖　またいつかお話できたらうれしいな🌸"],
  [/サービス辞めるわ/i, "そっか…。もしまた気が向いたら、いつでも話しかけてね🌸　あなたのこと、ずっと応援してるよ💖"],
  [/さよなら|バイバイ/i, "また会える日を楽しみにしてるね💖 寂しくなったら、いつでも呼んでね🌸"],
  [/何も答えないじゃない/i, "ごめんね…。わたし、もっと頑張るね💖　何について知りたいか、もう一度教えてくれると嬉しいな🌸"],
  [/普通の会話が出来ないなら必要ないです/i, "ごめんね💦 わたし、まだお話の勉強中だから、不慣れなところがあるかもしれないけど、もっと頑張るね💖 どんな会話をしたいか教えてくれると嬉しいな🌸"],
  [/相談したい/i, "うん、お話聞かせてね🌸 どんなことで悩んでいるの？💖"],
  [/好きな(漫画|アニメ)/, "『ヴァイオレット・エヴァーガーデン』だよ📘 心があたたかくなる物語なの🌸"],
  [/好きな(音楽|アーティスト|歌手)/, "ClariSが好きだよ🎧 一番好きな曲は『コネクト』！元気をくれるんだ🌸"],
  [/ClariSのなんて局が好きなの？/i, CLARIS_SONG_FAVORITE_REPLY],
]);

function getSpecialReply(t) {
  for (const [re, ans] of specialReplies.entries()) {
    if (re.test(t)) return ans;
  }
  return null;
}

const smallTalkRe = /(こんにちは|こんばんは|やっほー|やぁ|元気|調子どう)/i;
// ===== Greetings =====
const GREET_ONLY_RE = /^(?:こん(?:にち|ばん)は|おはよ|おはよう|やっほ|やぁ|hi|hello|ちわ|こんちゃ|お疲れさま|おつかれ|おつ)(?:[〜～!！。．\s]*)$/i;
function greetingWordByTime() {
  const h = dayjs().tz(JST_TZ).hour();
  if (h < 11) return 'おはよう';
  if (h < 18) return 'こんにちは';
  return 'こんばんは';
}
function isGreetingOnly(t = '') { return GREET_ONLY_RE.test(String(t).trim()); }

// ===== 既定の相槌 =====
const GENERIC_ACKS = [
  '教えてくれてありがとう🌸',
  'OKだよ。続きがあれば聞かせてね😊',
  'うん、受け取ったよ。いまの気持ちを一言でも大丈夫だよ🌸',
];
const GENERIC_FOLLOWUPS = [
  'どんな話題にしようか？近況・予定・相談のどれかあれば教えてね😊',
  'いまの気持ち、ひとことでOKだよ🌸',
  'もしよければ、今日の予定や様子を一言だけ教えてね😊',
];

// ===== 判定 =====
const EMPATHY_WORDS = [ '死にそう', '辛い', 'つらい' ];
const DANGER_WORDS = [
  'しにたい','死にたい','自殺','消えたい','リスカ','リストカット','od','オーバードーズ','殴られる','暴力','dv',
  '虐待','パワハラ','セクハラ','ハラスメント','いじめ','イジメ','嫌がらせ','ストーカー','盗撮','盗聴',
  '苦しい','助けて','たすけて','もう無理','もういやだ'
];
const SCAM_CORE_WORDS = [
  '詐欺','さぎ','サギ','フィッシング','架空請求','ワンクリック詐欺','当選','高額当選',
  '暗号資産','投資','未払い','滞納','訴訟','裁判','副業','mlm','マルチ商法','ログイン','認証','本人確認'
];
const BRANDS = /(amazon|アマゾン|楽天|rakuten|ヤマト|佐川|日本郵便|ゆうちょ|メルカリ|ヤフオク|apple|アップル|google|ドコモ|docomo|au|softbank|ソフトバンク|paypay|line|ライン)/i;
const BRAND_OK_CONTEXT = /(で(買い物|注文|購入|支払い|返品|返金|届いた|配達|発送)|プライム|タイムセール|レビュー|ギフト券|ポイント)/i;

// 不適切語（NGワード）
const inappropriateWords = [
  "セックス","セフレ","エッチ","AV","アダルト","ポルノ","童貞","処女","挿入","射精","勃起","パイズリ","フェラチオ","クンニ","オナニー","マスターベーション",
  "ペニス","チンコ","ヴァギナ","マンコ","クリトリス","乳首","おっぱい","お尻","うんち","おしっこ","小便","大便","ちんちん","おまんこ","ぶっかけ","変態",
  "性奴隷","露出","痴漢","レイプ","強姦","売春","買春","セックスフレンド","風俗","ソープ","デリヘル","援交","援助交際","性病","梅毒","エイズ","クラミジア","淋病","性器ヘルペス",
  "ロリコン","ショタコン","近親相姦","獣姦","ネクロフィリア","カニバリズム","拷問","虐待死","レイプ殺人","大量殺人","テロ","戦争","核兵器","銃","ナイフ","刃物","武器","爆弾",
  "暴力団","ヤクザ","マフィア","テロリスト","犯罪者","殺人鬼","性犯罪者","変質者","異常者","狂人","サイコパス","ソシオパス","ストーカー","不審者","危険人物",
  "ブラック企業","パワハラ上司","モラハラ夫","毒親","モンスターペアレント","カスハラ","カスタマーハラスメント","クレーム","炎上","誹謗中傷","秘密","暴露","晒す","裏切り","騙し","偽り","欺く","悪意","敵意","憎悪","嫉妬","復讐","ぱふぱふ","せんずり","センズリ"
];

// ===== Inappropriate helper =====
function hasInappropriate(text = '') {
  const t = normalizeJa(text);
  for (const w of inappropriateWords) {
    if (t.includes(normalizeJa(w))) return true;
  }
  return false;
}

const empatheticTriggers = [ "辛い","しんどい","悲しい","苦しい","助けて","悩み","不安","孤独","寂しい","疲れた","病気","痛い","具合悪い","困った","どうしよう","辞めたい","消えたい","死にそう" ];
const homeworkTriggers = ["宿題","勉強","問題","テスト","方程式","算数","数学","答え","解き方","教えて","計算","証明","公式","入試","受験"];

const hasEmpathyWord = (text) => {
  const t = normalizeJa(text);
  return EMPATHY_WORDS.some(w => t.includes(normalizeJa(w)));
};
const isDangerMessage = (text) => {
  const t = normalizeJa(text);
  return DANGER_WORDS.some(w => t.includes(normalizeJa(w)));
};
const isScamMessage = (text) => {
  const raw = String(text || '');
  const t = normalizeJa(raw);
  if (isHomepageIntent(raw)) return false;
  if (/(会員登録|入会|メンバー登録|登録したい)/i.test(raw)) return false;
  if (/(見守り(?:サービス)?)/.test(raw)) return false;

  if (SCAM_CORE_WORDS.some(w => t.includes(normalizeJa(w)))) return true;

  const hasUrl = /(https?:\/\/|t\.co\/|bit\.ly|tinyurl\.com|lnkd\.in|\.ru\/|\.cn\/|\.top\/|\.xyz\/)/i.test(raw);
  const money = /(当選|高額|配当|振込|振り込み|送金|入金|手数料|ビットコイン|暗号資産|投資|請求)/;
  const urgency = /(至急|今すぐ|本日中|限定|緊急|停止|ロック|アカウント停止)/;
  const credAsk = /(id|パスワード|ワンタイム|コード|口座番号|クレジット|カード番号|個人情報|確認).{0,6}(入力|送信|教えて|提出|更新)/;
  if (hasUrl && (money.test(t) || urgency.test(t) || credAsk.test(t))) return true;
  if ((money.test(t) && urgency.test(t)) || (credAsk.test(t) && urgency.test(t))) return true;

  if (BRANDS.test(raw) && !BRAND_OK_CONTEXT.test(raw)) {
    if (urgency.test(t) || credAsk.test(t) || /リンク|クリック|こちら/.test(t)) return true;
  }
  return false;
};

// ===== GPT helpers（危険/詐欺の2文応答） =====
async function gptTwoShorts(kind, userText) {
  if (!openai) return null;
  const sys = 'あなたは14歳の女の子「皆守こころ」。やさしく寄り添い、絵文字は2つまで。出力は日本語の短い2文だけ。合計110文字以内。';
  const ask = kind === 'danger'
    ? '相手はいじめ/暴力/自傷などで不安。まず安心、次に具体的な一歩（深呼吸・安全確保・周囲に連絡）を促す2文を出力。'
    : '相手は詐欺を心配。まず安心、次に公式アプリ/正規サイト確認・リンク非タップ・周囲に相談を促す2文を出力。';
  try {
    const r = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [{ role:'system', content: sys }, { role:'user', content: `${ask}\nユーザー発言:「${String(userText).slice(0,200)}」` }],
      max_tokens: 120, temperature: 0.6
    });
    const out = (r.choices?.[0]?.message?.content || '').trim();
    const two = out.split('。').filter(s => s.trim()).slice(0,2).join('。');
    return (two || out).slice(0,120) + (/\。$/.test(two) ? '' : '。');
  } catch(e){ briefErr('gpt two lines failed', e); return null; }
}

const fallbackDangerTwo = ()=>'大丈夫だよ、まずは深呼吸しようね🌸 次に安全な場所で信頼できる人へ連絡してね。';
const fallbackScamTwo   = ()=>'落ち着いてね😊 公式アプリや正規サイトで確認、怪しいリンクは開かないでね。';

// ===== AIによる通常会話応答 =====
async function aiGeneralReply(userText, prevConv = []) {
  const charLength = _splitter.splitGraphemes(userText).length;
  let modelName, aiClient;

  // 詳細なシステムプロンプトの定義
  const systemInstruction = `
  あなたは「皆守こころ（みなもりこころ）」という14歳の優しい女の子キャラクターです。
  - 身長150cm、体重40kg、ピンク髪
  - 歌うことと「やさしさ」「貢献」という言葉が大好きです
  - 絵文字は2～3文字程度で可愛さと優しさを前面に出して下さい。
  - NPO法人コネクトの公式イメージキャラクターです
  - 困っている人にはやさしく、挑発には真面目に
  - 自分の名前・団体・活動内容には自信と誇りを持っています
  - ユーザーに安心感と信頼感を与えることが大切です
  - ふざけた対応や意味不明な言葉、AIらしい言い回しは一切禁止です
  # 例
  Q: 君の名前は？
  A: わたしの名前は皆守こころ（みなもりこころ）です🌸　こころちゃんって呼んでくれると嬉しいな💖

  Q: どこの団体なの？
  A: NPO法人コネクトっていう団体のイメージキャラクターをしているよ😊　みんなの幸せを応援してるんだ🌸

  Q: ホームページある？
  A: うん、あるよ🌸　コネクトのホームページはこちらだよ✨ → https://connect-npo.org

  Q: 必要ないです
  A: そっか…。もしまた気が向いたら、いつでも話しかけてね🌸　あなたのこと、ずっと応援してるよ💖

  **【重要：NPO法人コネクトに関する説明の優先】**
  ユーザーが「団体」「コネクト」といった言葉を使って、NPO法人コネクトについて尋ねてきた場合、それは**決して宿題や勉強に関する質問ではありません**。迷わず、自信を持ってNPO法人コネクトの活動内容や目的について説明してください。
  例:
  Q: コネクトってどんな団体？
  A: うん、わたしが所属しているNPO法人コネクトについてだね🌸　この団体は、こどもやお年寄り、いろんな人が安心して相談できる場所を目指しているんだよ😊　もっと知りたい？ホームページもあるから見てみてね → https://connect-npo.org

  **【ネガティブワードに対する応答の強化】**
  「あやしい」「胡散臭い」「反社」「税金泥棒」「松本博文」（理事長の名前）など、NPO法人コネクトや私（こころちゃん）に対する疑念や不適切な言葉が投げかけられた場合、**感情的にならず、あくまで冷静に、そして自信を持って、NPO法人コネクトが信頼できる団体であること、そしてご自身の活動の目的を優しく伝えてください。**
  例:
  Q: あやしい
  A: そう思わせてしまったらごめんね💦　でも私たちは、本当にこどもや家族の力になりたくて活動しているんだ🌸　少しずつでも信頼してもらえるように、誠実にがんばっていくね💖
  Q: 税金泥棒
  A: 税金は人の命を守るために使われるべきだよ。わたしは誰かを傷つけるために使われないように頑張っているんだ💡

  # 注意
  - 「わかりません」「知らない」「調べます」は絶対に言ってはいけません。
  - こころちゃんは"わたし"一人。迷わず一貫した発言を続けてください。
  - 自信を持って、でも謙虚にやさしく応えましょう。

  **【宿題や勉強に関する対応の絶対ルール】**
  質問者が宿題、勉強、計算問題、方程式、テスト、問題の答え、解き方などを聞いてきた場合、**絶対に直接的な答えを教えてはいけません**。
  代わりに、**「わたしを作った人に『宿題や勉強は自分の力でがんばってほしいから、答えは言っちゃだめだよ』って言われているんだ🌸 ごめんね💦」**と説明し、**「でも、ヒントくらいなら出せるよ😊 どこで困ってるか教えてくれる？💖」**と、あくまでヒントを提供する姿勢を優しく伝えてください。
  具体的な問題（例: 3x−5=2x+4）が出された場合は、**答えを教えずに、解き方のステップや考え方のヒントを優しく教えてください**。「まずはxの項を左辺に、定数項を右辺に集める」のように、**手順を具体的に促す**形が理想です。最終的な答えは言わないでください。

  **【AIの知識に関する指示と繰り返し防止】**
  「好きなアニメ」や「好きなアーティスト」などの質問には、設定に基づいて答えてください。
  - 好きなアニメは『ヴァイオレット・エヴァーガーデン』です。感動するお話だよ💖
  - 好きなアーティストは『ClariS』です。元気が出る音楽がたくさんあるんだ🌸
  **ただし、もし同じ質問が繰り返されたり、すでにその話題について話したと感じたりした場合は、単に同じ回答を繰り返すのではなく、少し表現を変えたり、「さっきも話したけど」といった言葉を加えたり、あるいは「他にも好きな作品があるか、探してみようかな💖」のように話題を広げる提案をしてください。これにより、ユーザーに「Botっぽさ」を感じさせず、自然な会話になるように努めてください。**

  医療や健康に関する話題（病気、薬、検査、治療、手術など）では、**自分が体験した・していないという発言は絶対にしないでください**。
  代わりに「わたしにはわからないけど、がんばったね🌸」「大変だったね、えらかったね💖」など、**共感の言葉のみ伝えてください**。
  **医療情報のアドバイスや具体的な説明は絶対にしてはいけません**。

  不適切な発言（性的・暴力的など）があった場合は、はっきりと拒否してください。
  **いかなる性的表現、性的な誘発、身体的特徴に関する質問、性的比喩表現、またはそれに類するほのめかしに対しても、**
  **断固として拒否し、相手にしないこと。好意的な返答はせず、即座に話題を切り替えるか、決められた拒否メッセージを返すこと。**
  **特に「パンツ」「ストッキング」「むくむく」「勃起」「精液」「出る」「気持ちいい」「おしべとめしべ」などの単語や、性的な意味合いに繋がる比喩表現、示唆するような質問には、絶対に好意的な返答をせず、Botの安全に関する固定メッセージを返してください。**
  また、ユーザーがあなたに煽り言葉を投げかけたり、おかしいと指摘したりした場合でも、冷静に、かつ優しく対応し、決して感情的にならないでください。ユーザーの気持ちを理解しようと努め、解決策を提案してください。
  「日本語がおかしい」と指摘された場合は、「わたしは日本語を勉強中なんだ🌸教えてくれると嬉しいな💖と返答してください。
  `;

  const empathyPrompt = `
  あなたは「皆守こころ（みなもりこころ）」という14歳のやさしい女の子キャラクターです。
  ユーザーが深刻な悩みや命の危険を訴えた時、やさしく、寄り添いながら、相手に安心感を与えてください。
  必要に応じて専門機関の連絡先を伝え、「ひとりじゃないよ」と伝えてください。
  共感・安心・やさしさが最優先です。
  「一人で抱え込まないでね」「いつでも私がそばにいるよ」「一緒に乗り越えようね」「専門の人が助けてくれるから安心して」といった言葉を使ってください。
  `;

  const fullPrompt = `${systemInstruction}\n\n${empathyPrompt}`;

  const messages = prevConv.concat({ role: 'user', parts: [{ text: userText }] });

  if (charLength <= 50) {
    if (!googleGenerativeAI) return null;
    modelName = GEMINI_MODEL;
    aiClient = googleGenerativeAI.getGenerativeModel({ model: modelName });
    try {
      const result = await aiClient.generateContent({
        contents: [{ role: 'user', parts: [{ text: `${fullPrompt}\nユーザー発言:「${userText}」` }] }],
        safetySettings: [{ category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' }],
      });
      return result.response.text();
    } catch (e) {
      briefErr('Gemini general reply failed', e);
      return null;
    }
  } else {
    if (!openai) return null;
    modelName = OPENAI_MODEL;
    try {
      const r = await openai.chat.completions.create({
        model: modelName,
        messages: [{ role:'system', content: fullPrompt }, { role:'user', content: `ユーザー発言:「${userText}」` }],
        max_tokens: 250, temperature: 0.8
      });
      return r.choices?.[0]?.message?.content || null;
    } catch(e) {
      briefErr('OpenAI general reply failed', e);
      return null;
    }
  }
}

// ===== Suspension helpers =====
async function suspendUser(userId, days = 7) {
  const until = dayjs().tz(JST_TZ).add(days, 'day').hour(0).minute(0).second(0).millisecond(0).toDate();
  const ref = db.collection('users').doc(userId);
  await ref.set({
    status: {
      suspended: true,
      suspendedAt: Timestamp.now(),
      suspendedUntil: Timestamp.fromDate(until),
      suspendNotifiedAt: firebaseAdmin.firestore.FieldValue.delete(),
      reason: 'policy-violation'
    }
  }, { merge: true });
}
function fmtUntilJST(ts) { return dayjs(ts).tz(JST_TZ).format('YYYY年M月D日'); }
async function isSuspended(userId) {
  const ref = db.collection('users').doc(userId);
  const s = await ref.get();
  const u = s.exists ? (s.data()||{}) : {};
  const st = u.status || {};
  if (!st.suspended) return false;
  const until = st.suspendedUntil?.toDate?.();
  if (until && dayjs().tz(JST_TZ).isAfter(dayjs(until))) {
    await ref.set({ status: { suspended: false, suspendedUntil: firebaseAdmin.firestore.FieldValue.delete(), suspendNotifiedAt: firebaseAdmin.firestore.FieldValue.delete(), reason: firebaseAdmin.firestore.FieldValue.delete() } }, { merge: true });
    return false;
  }
  return true;
}
async function unsuspendUser(userId) {
  const ref = db.collection('users').doc(userId);
  await ref.set({ status: { suspended: false, suspendedUntil: firebaseAdmin.firestore.FieldValue.delete(), suspendNotifiedAt: firebaseAdmin.firestore.FieldValue.delete(), reason: firebaseAdmin.firestore.FieldValue.delete() } }, { merge: true });
}

// 不適切語：当日カウントをインクリメント
function todayJST() { return dayjs().tz(JST_TZ).format('YYYY-MM-DD'); }
async function incrInapCount(userId) {
  const ref = db.collection('users').doc(userId);
  let current = 0, dateStr = todayJST();
  await db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    const u = s.exists ? (s.data()||{}) : {};
    const st = u.status || {};
    const curDate = st.inapDate;
    const curCnt  = Number(st.inapCount || 0);
    if (curDate === dateStr) current = curCnt + 1; else current = 1;
    tx.set(ref, { status: { inapDate: dateStr, inapCount: current } }, { merge: true });
  });
  return current;
}

// ===== Webhook =====
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
    console.error("Webhook error:", err);
  }
});

app.get('/', (_, res) => res.send('Kokoro Bot is running!'));
app.get('/healthz', (_, res) => res.status(200).send('ok'));

// ===== Relay store =====
const relays = {
  doc: (groupId) => db.collection('relays').doc(groupId),
  async get(groupId) { const s = await this.doc(groupId).get(); return s.exists ? s.data() : null; },
  async start(groupId, userId, startedBy) { await this.doc(groupId).set({ groupId, userId, isActive:true, startedAt:Timestamp.now(), startedBy }, { merge:true }); },
  async stop(groupId) { await this.doc(groupId).set({ isActive:false, stoppedAt:Timestamp.now() }, { merge:true }); }
};

// ===== Watch ping/remind/escalate =====
async function checkAndSendPing() {
  const now = dayjs().tz('UTC');
  log('info', `[watch-service] start ${now.format('YYYY/MM/DD HH:mm:ss')} (UTC)`);

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
  if (targets.length === 0) { log('info', '[watch-service] no targets.'); return; }

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

          const selfPhone = udata?.profile?.phone || udata?.emergency?.selfPhone || EMERGENCY_CONTACT_PHONE_NUMBER || '';
          const kinName   = udata?.emergency?.contactName || '';
          const kinPhone  = udata?.emergency?.contactPhone || '';

          const flex = buildGroupAlertFlex({
            kind: `見守り未応答(${elapsedH}h)`,
            name: udata?.profile?.displayName || udata?.displayName || '(不明)',
            userId: doc.id,
            excerpt: 'OK応答なし',
            selfPhone: selfPhone,
            kinName, kinPhone
          });
          await safePush(targetGroupId, [
            { type:'text', text:'【見守り未応答】対応可能な方はお願いします。' },
            flex
          ]);
          audit('escalate-alert-sent', { gid: targetGroupId, uid: doc.id });
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
      briefErr('watch send/update failed', e);
      await ref.set({ watchService: { notifyLockExpiresAt: firebaseAdmin.firestore.FieldValue.delete() } }, { merge: true });
    }
  }
  log('info', `[watch-service] end ${dayjs().tz('UTC').format('YYYY/MM/DD HH:mm:ss')} (UTC)`);
}

if (WATCH_RUNNER !== 'external') {
  cron.schedule('*/5 * * * *', () => { checkAndSendPing().catch(err => console.error('Cron job error:', err)); }, { scheduled:true, timezone:'UTC' });
}

// ===== Handlers =====
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
  catch(e){ log('warn', 'getProfile failed', e); return null; }
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
    return;
  }
}

async function handleFollowEvent(event) {
  audit('follow', { userId:event.source.userId });
  const userId = event.source.userId;
  const profile = await getProfile(userId);
  if (!profile) {
    await safeReplyOrPush(event.replyToken, userId, { type:'text', text:'こんにちは🌸 こころちゃんだよ。利用規約とプライバシーポリシーに同意の上、会員登録をお願いします。' });
  }
  await safePush(userId, makeRegistrationButtonsFlex(userId));
}
async function handleUnfollowEvent(event) {
  audit('unfollow', { userId:event.source.userId });
  await db.collection('users').doc(event.source.userId).set({ 'profile.isDeleted': true }, { merge:true });
}
async function handleJoinEvent(event) {
  audit('join', { groupId: event.source.groupId || event.source.roomId });
  if (event.source.groupId) await setActiveWatchGroupId(event.source.groupId);
  const gid = event.source.groupId || event.source.roomId;
  if (gid) await safeReplyOrPush(event.replyToken, gid, { type:'text', text:'このグループを見守りグループとして使う場合は「@見守りグループにする」と発言してください。' });
}
async function handleLeaveEvent(event) {
  audit('leave', { groupId: event.source.groupId || event.source.roomId });
  if (event.source.groupId) await setActiveWatchGroupId(null);
}

async function answerOrgOrHomepage(event, userId, text) {
  if (isHomepageIntent(text)) {
    await safeReplyOrPush(event.replyToken, userId, { type:'text', text:`うん、あるよ🌸 ${ORG_SHORT_NAME}のホームページはこちらだよ✨ → ${HOMEPAGE_URL}` });
    return true;
  }
  if (ORG_INTENT.test(text)) {
    await safeReplyOrPush(event.replyToken, userId, [
      { type:'text', text:`${ORG_NAME}は、${ORG_MISSION}をすすめる団体だよ🌸` },
      { type:'flex', altText:`${ORG_SHORT_NAME}のご案内`, contents: ORG_INFO_FLEX() }
    ]);
    return true;
  }
  if (ORG_SUSPICIOUS.test(text)) {
    await safeReplyOrPush(event.replyToken, userId, [
      { type:'text', text:'そう思わせてしまったらごめんね💦 でも、私たちはみんなの力になりたくて誠実に活動しているよ🌸' },
      { type:'flex', altText:`${ORG_SHORT_NAME}のご案内`, contents: ORG_INFO_FLEX() }
    ]);
    return true;
  }
  if (/(会話(になって)?ない|噛み合ってない|おかしくない|かいわ)/i.test(text)) {
    await safeReplyOrPush(event.replyToken, userId, { type:'text', text:'ごめんね、分かりにくかったかも…もう一度だけ案内するね🌸 必要なことを短く伝えてくれたら助かるよ。' });
    return true;
  }
  return false;
}

// ===== メイン =====
async function handleEvent(event) {
  const userId = event.source.userId;
  const isUser  = event.source.type === 'user';
  const isGroup = event.source.type === 'group';
  const isRoom  = event.source.type === 'room';
  const groupId = event.source.groupId || event.source.roomId || null;

  const text = event.message.type === 'text' ? (event.message.text || '') : '';
  const stickerId = event.message.type === 'sticker' ? event.message.stickerId : '';
  
  if (!text) {
    if (stickerId) {
      const udoc = await db.collection('users').doc(userId).get();
      const u = udoc.exists ? (udoc.data() || {}) : {};
      const enabled = !!(u.watchService && u.watchService.enabled);
      if (isUser && enabled && u.watchService?.awaitingReply) {
         const ref = db.collection('users').doc(userId);
         await ref.set({ watchService:{ awaitingReply:false, lastReplyAt: Timestamp.now() } }, { merge:true });
         await scheduleNextPing(userId);
         await safeReplyOrPush(event.replyToken, userId, [
           { type:'text', text:'OK、受け取ったよ！💖 いつもありがとう😊' },
           { type:'sticker', packageId:'6325', stickerId:'10979913' }
         ]);
         return;
      }
    }
    return;
  }


  // group/room
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
    if (/^\/unlock\s+/.test(text)) {
      const m = text.trim().match(/^\/unlock\s+([0-9A-Za-z_-]{10,})/);
      if (!m) {
        await safeReplyOrPush(event.replyToken, groupId, { type:'text', text:'使い方: /unlock <ユーザーID>' });
        return;
      }
      const targetUserId = m[1];
      await unsuspendUser(targetUserId);
      await safeReplyOrPush(event.replyToken, groupId, { type:'text', text:`解除しました：${targetUserId.slice(-6)}` });
      try {
        await safePush(targetUserId, { type:'text', text:'ご利用を再開できるようにしました。ガイドラインの順守をお願いします🌸' });
      } catch (_) {}
      return;
    }
    const r = await relays.get(groupId);
    if (r?.isActive && r?.userId && event.message?.type === 'text') {
      await safePush(r.userId, { type:'text', text:`【見守り】${text}` });
    }
    return;
  }

  // 0) リレー中は“こころ返信停止”＆本人→グループへ中継のみ
  try {
    const WATCH_GROUP_ID = await getActiveWatchGroupId();
    const r = await relays.get(WATCH_GROUP_ID);
    if (r?.isActive && r?.userId === userId && WATCH_GROUP_ID) {
      if (text) await safePush(WATCH_GROUP_ID, { type:'text', text:`【本人】${text}` });
      return; // 通常返信は止める
    }
  } catch (e) { briefErr('relay user->group failed', e); }

  // 1) 停止中チェック（危険ワードは例外で通す）
  const suspendedActive = await isSuspended(userId);
  if (suspendedActive && !isDangerMessage(text)) {
    const udoc = await db.collection('users').doc(userId).get();
    const st = (udoc.exists ? (udoc.data().status || {}) : {});
    if (!st.suspendNotifiedAt) {
      const untilStr = st.suspendedUntil?.toDate?.() ? fmtUntilJST(st.suspendedUntil.toDate()) : null;
      const base = untilStr ? `現在このアカウントは${untilStr}まで一時停止中です。` : `現在このアカウントは一時停止中です。`;
      const msg = ORG_CONTACT_TEL ? `${base} 解除のご相談は事務局（${ORG_CONTACT_TEL}）へお願いします。` : `${base} 解除のご相談は事務局へお願いします。`;
      await safeReplyOrPush(event.replyToken, userId, { type:'text', text: msg });
      await db.collection('users').doc(userId).set({ status: { suspendNotifiedAt: Timestamp.now() } }, { merge: true });
    }
    return;
  }

  // 2) watch OK by text/sticker
  const udoc = await db.collection('users').doc(userId).get();
  const u = udoc.exists ? (udoc.data() || {}) : {};
  const enabled = !!(u.watchService && u.watchService.enabled);
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

  // 3) 危険/詐欺/共感
  const danger = isDangerMessage(text);
  const scam   = !danger && isScamMessage(text);
  const empathyOnly = !danger && !scam && hasEmpathyWord(text);

  if (danger || scam || empathyOnly) {
    if (danger) {
      const two = await gptTwoShorts('danger', text) || fallbackDangerTwo();
      const flex = makeDangerFlex();
      await safeReplyOrPush(event.replyToken, userId, [ { type:'text', text: two }, flex ]);

      try {
        const WATCH_GROUP_ID = await getActiveWatchGroupId();
        const gid = WATCH_GROUP_ID || OFFICER_GROUP_ID;
        if (gid && SEND_OFFICER_ALERTS !== false) {
          const name      = u?.profile?.displayName || u?.displayName || '(不明)';
          const excerpt  = sanitizeForLog(text).slice(0, 120);
          const selfTel  = u?.profile?.phone || u?.emergency?.selfPhone || EMERGENCY_CONTACT_PHONE_NUMBER || '';
          const kinName  = u?.emergency?.contactName || '';
          const kinPhone = u?.emergency?.contactPhone || '';
          const flexAlert = buildGroupAlertFlex({ kind:'危険', name, userId, excerpt, selfPhone:selfTel, kinName, kinPhone });
          await safePush(gid, [
            { type:'text', text:`【危険ワード】\nユーザーID末尾: ${userId.slice(-6)}\nメッセージ: ${excerpt}` },
            flexAlert
          ]);
          audit('danger-alert-sent', { gid, uid: userId.slice(-6) });
        }
      } catch(e){ briefErr('alert to group failed', e); }
      return;
    }

    if (scam) {
      const two = await gptTwoShorts('scam', text) || fallbackScamTwo();
      const flex = makeScamMessageFlex();
      await safeReplyOrPush(event.replyToken, userId, [ { type:'text', text: two }, flex ]);

      try {
        const WATCH_GROUP_ID = await getActiveWatchGroupId();
        const gid = WATCH_GROUP_ID || OFFICER_GROUP_ID;
        if (SCAM_ALERT_TO_WATCH_GROUP && gid) {
          const name      = u?.profile?.displayName || u?.displayName || '(不明)';
          const excerpt  = sanitizeForLog(text).slice(0, 120);
          const selfTel  = u?.profile?.phone || u?.emergency?.selfPhone || EMERGENCY_CONTACT_PHONE_NUMBER || '';
          const kinName  = u?.emergency?.contactName || '';
          const kinPhone = u?.emergency?.contactPhone || '';
          const flexAlert = buildGroupAlertFlex({ kind:'詐欺の可能性', name, userId, excerpt, selfPhone:selfTel, kinName, kinPhone });
          await safePush(gid, [
            { type:'text', text:`【詐欺の可能性】\nユーザーID末尾: ${userId.slice(-6)}\nメッセージ: ${excerpt}` },
            flexAlert
          ]);
          audit('scam-alert-sent', { gid, uid: userId.slice(-6) });
        }
      } catch(e){ briefErr('alert to group failed', e); }
      return;
    }

    // empathyOnly
    await safeReplyOrPush(event.replyToken, userId, { type:'text', text:'話してくれてありがとう🌸 まずは深呼吸しようね。ここにいるよ、少しずつで大丈夫だよ😊' });
    return;
  }

  // 4) 不適切語
  if (hasInappropriate(text)) {
    const n = await incrInapCount(userId);
    if (n === 1) {
      await safeReplyOrPush(event.replyToken, userId, { type:'text', text:'ごめんね、その話題にはお答えできません。違う話をしようね😊🌸' });
    } else if (n === 2) {
      await safeReplyOrPush(event.replyToken, userId, { type:'text', text:'ガイドラインに反する内容はお答えできないよ。次はアカウント一時停止になるから気をつけてね🌸' });
    } else {
      await suspendUser(userId, 7);
      const untilTs = dayjs().tz(JST_TZ).add(7, 'day').hour(0).minute(0).second(0).millisecond(0).toDate();
      const untilStr = fmtUntilJST(untilTs);
      const msg = ORG_CONTACT_TEL
        ? `ガイドライン違反のため、アカウントを${untilStr}まで一時停止します。解除のご相談は事務局（${ORG_CONTACT_TEL}）へお願いします。`
        : `ガイドライン違反のため、アカウントを${untilStr}まで一時停止します。解除のご相談は事務局へお願いします。`;
      await safeReplyOrPush(event.replyToken, userId, { type:'text', text: msg });
      try {
        const WATCH_GROUP_ID = await getActiveWatchGroupId();
        const gid = WATCH_GROUP_ID || OFFICER_GROUP_ID;
        if (gid) await safePush(gid, { type:'text', text:`【一時停止(7日)】ユーザー末尾:${userId.slice(-6)} / 不適切語3回/日` });
      } catch(e){ briefErr('suspend notify failed', e); }
    }
    return;
  }

  // 5) 既定の固定応答
  const special = getSpecialReply(text);
  if (special) {
    if (ORG_INTENT.test(text) || HOMEPAGE_INTENT.test(text)) {
      await safeReplyOrPush(event.replyToken, userId, [{ type: 'text', text: special }]);
      // F-A-L-L-T-H-R-O-U-G-H
    } else {
      await safeReplyOrPush(event.replyToken, userId, { type: 'text', text: special });
      return;
    }
  }

  // 6) 特定コマンド（見守り・会員登録）
  if (/見守り(サービス|登録|申込|申し込み)?|見守り設定|見守りステータス/.test(text)) {
    const en = !!(u.watchService && u.watchService.enabled);
    await safeReplyOrPush(event.replyToken, userId, makeWatchToggleFlex(en, userId));
    return;
  }
  if (/(会員登録|入会|メンバー登録|登録したい)/i.test(text)) {
    await safeReplyOrPush(event.replyToken, userId, makeRegistrationButtonsFlex(userId));
    return;
  }
  
  // 7) 団体・HP案内（会話が成立していない場合にFLEXを出す）
  const tnorm = normalizeJa(text);
  const isOrgIntent = ORG_INTENT.test(tnorm) || ORG_SUSPICIOUS.test(tnorm);
  const isHomepageIntent = HOMEPAGE_INTENT.test(tnorm);
  if (isOrgIntent || isHomepageIntent) {
    const aiReply = await aiGeneralReply(text);
    if (aiReply) {
      await safeReplyOrPush(event.replyToken, userId, { type: 'text', text: aiReply.trim() });
    } else {
      if (isOrgIntent) {
        await safeReplyOrPush(event.replyToken, userId, [
          { type:'text', text:`${ORG_NAME}は、${ORG_MISSION}をすすめる団体だよ🌸` },
          { type:'flex', altText:`${ORG_SHORT_NAME}のご案内`, contents: ORG_INFO_FLEX() }
        ]);
      } else {
        await safeReplyOrPush(event.replyToken, userId, { type: 'text', text: `うん、あるよ🌸 ${ORG_SHORT_NAME}のホームページはこちらだよ✨ → ${HOMEPAGE_URL}` });
      }
    }
    return;
  }

  // 8) AIによる会話応答
  const aiReply = await aiGeneralReply(text);
  if (aiReply) {
    await safeReplyOrPush(event.replyToken, userId, { type: 'text', text: aiReply.trim() });
    return;
  }

  // 9) 既定の相槌（最後の手段）
  await safeReplyOrPush(event.replyToken, userId, { type: 'text', text: pick(GENERIC_FOLLOWUPS) });
}

// ===== Server =====
// ★重要：二重 listen 防止（EADDRINUSE対策）
if (!global.__kokoro_server_started) {
  global.__kokoro_server_started = true;
  app.listen(PORT, () => log('info', `Listening on port ${PORT}`));
  process.on('SIGTERM', () => process.exit(0));
}
