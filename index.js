'use strict';

/*
 index.js (angel-kokoro, enhanced-2025-11-01)
 - 10-28をベースに危険ワード検出時のグループ通知機能を追加
 - ワンクッションFLEXで安心設計
 - 通常会話：Gemini 2.5 Flashと GPT-4o-mini を文字数で使い分け
 - 危険 > 詐欺 > 不適切語 > 共感 > 悪意ある長文 の優先判定
 - 危険はGPT-4oで2文+危険FLEX→見守りグループへFLEX通知 → ユーザー同意確認
 - 詐欺はGPT-4oで2文+詐欺FLEX（見守りはテキスト+FLEX、モノトーン）
 - 会員登録FLEX：カラー / 見守り・詐欺FLEX：モノトーン / 危険FLEX：カラー
 - 見守り29h未応答→グループFLEX（LINEで連絡 + 本人/近親者TEL）
 - リレー中（グループ↔本人）は"ここ♡返信停止"（本人↔事務局の会話を阻害しない）
 - 不適切語：1回目=お答え不可、2回目=警告、3回目=7日停止（停止中は初回のみ通知→以降サイレント）
 - 悪意ある長文：即時7日停止
 - ユーザーランクごとの利用回数制限とモデル切り替え
 - 通常会話：50文字以下→Gemini 2.5 Flash、50文字超→GPT-4o-miniで応答
 - 「相談」または「そうだん」と だけ入力された場合、回数制限を無視しGemini 2.5 Proで1回だけ応答
 - AIからの質問を減らし、ユーザーのペースに合わせた応答に調整
*/

const GraphemeSplitter = require('grapheme-splitter');
const _splitter = new GraphemeSplitter();
const toGraphemes = (s) => _splitter.splitGraphemes(String(s || ''));
const express = require('express');
const app = express();
const axios = require('axios');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');
const firebaseAdmin = require('firebase-admin');
const crypto = require('crypto');
const { URL, URLSearchParams } = require('url');
const httpMod = require('http');
const httpsMod = require('https');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc); dayjs.extend(timezone);
const { Client, middleware } = require('@line/bot-sdk');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { OpenAI } = require('openai');

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
  const tail = s.slice(-4); const head = s.slice(0, -4).replace(/[0-9]/g, '*'); return head + tail;
};
const toArr = (m) => Array.isArray(m) ? m : [m];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const todayJST = () => dayjs().tz('Asia/Tokyo').format('YYYY-MM-DD');

// ===== ENV =====
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET        = process.env.LINE_CHANNEL_SECRET;
const OWNER_USER_ID = process.env.OWNER_USER_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL   = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const OPENAI_DANGER_MODEL = process.env.OPENAI_DANGER_MODEL || 'gpt-4o';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_FLASH_MODEL   = process.env.GEMINI_FLASH_MODEL || 'gemini-2.5-flash';
const GEMINI_PRO_MODEL     = process.env.GEMINI_PRO_MODEL   || 'gemini-2.5-pro';

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
const EMERGENCY_CONTACT_PHONE_NUMBER = (process.env.ORG_CONTACT_TEL || process.env.EMERGENCY_CONTACT_PHONE_NUMBER || '').replace(/[^0-9+]/g,'');
const LINE_ADD_FRIEND_URL = process.env.LINE_ADD_FRIEND_URL;
const WATCH_RUNNER = process.env.WATCH_RUNNER || 'internal';

const ORG_NAME = process.env.ORG_NAME || 'NPO法人コネクト';
const ORG_SHORT_NAME = process.env.ORG_SHORT_NAME || 'コネクト';
const HOMEPAGE_URL = normalizeFormUrl(process.env.HOMEPAGE_URL || 'https://connect-npo.or.jp');
const ORG_MISSION = process.env.ORG_MISSION || 'こども・若者・ご高齢の方の安心と笑顔を守る活動';
const ORG_REP = (process.env.ORG_REP || '松本博文');
const ORG_CONTACT_TEL = (process.env.ORG_CONTACT_TEL || EMERGENCY_CONTACT_PHONE_NUMBER || '').replace(/[^0-9+]/g,'');

// ===== AI Clients 初期化 =====
let googleGenerativeAI = null;
let openai = null;

// Gemini 初期化
try {
  log('info', `[INIT] GoogleGenerativeAI 初期化開始...`);
  if (GEMINI_API_KEY) {
    googleGenerativeAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    log('info', `[INIT] GoogleGenerativeAI 初期化成功 (API Key末尾: ...${GEMINI_API_KEY.slice(-4)})`);
  } else {
    log('error', '[INIT] GEMINI_API_KEY が設定されていません');
  }
} catch (e) {
  log('error', `[INIT] GoogleGenerativeAI 初期化失敗: ${e.message}`, e);
}

// OpenAI 初期化
if (OPENAI_API_KEY) {
  try {
    openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    log('info', `[INIT] OpenAI 初期化成功`);
  } catch(e) {
    log('error', `[INIT] OpenAI 初期化失敗: ${e.message}`, e);
  }
} else {
  log('warn', '[INIT] OPENAI_API_KEY が設定されていません');
}

console.log(`✅ AI Clients 初期化完了: Gemini=${googleGenerativeAI ? 'OK' : 'FAIL'}, OpenAI=${openai ? 'OK' : 'FAIL'}`);

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
  console.log("✅ Firebase 初期化完了");
}
const db = firebaseAdmin.firestore();
const Timestamp = firebaseAdmin.firestore.Timestamp;

// ===== LINE client =====
const client = new Client({ 
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN, 
  channelSecret: LINE_CHANNEL_SECRET 
});

// ===== HTTP =====
const httpAgent = new httpMod.Agent({ keepAlive: true });
const httpsAgent = new httpsMod.Agent({ keepAlive: true });
const http = axios.create({ timeout: 6000, httpAgent, httpsAgent });

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
  try {
    await client.replyMessage(replyToken, arr);
    log('info', `[LINE] REPLY成功 (token: ${replyToken.slice(0, 8)}...)`);
  } catch (err) {
    const msg = err?.originalError?.response?.data?.message || err?.message || '';
    if (/Invalid reply token/i.test(msg) || err?.statusCode === 400) {
      await safePush(to, arr);
      log('warn', `[LINE] Token無効 → PUSH送信 (to: ...${to.slice(-4)})`);
    } else {
      briefErr('reply failed', err);
    }
  }
}

async function safePush(to, messages) {
  const arr = ensureMsgShape(messages);
  try { 
    await client.pushMessage(to, arr);
    log('info', `[LINE] PUSH成功 (to: ...${to.slice(-4)})`);
  } catch (err) { 
    briefErr('push failed', err);
  }
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
  "元気にしてる？✨ こころちゃん、あなたのこと応援してるよ💖"
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
        nextPingAt: Timestamp.fromDate(nextPingAtFrom(dayjs().tz(JST_TZ).toDate())),
        lastReminderAt: firebaseAdmin.firestore.FieldValue.delete(),
        notifyLockExpiresAt: firebaseAdmin.firestore.FieldValue.delete(),
      }
    }, { merge: true });
  } catch (e) { briefErr('scheduleNextPing failed', e); }
}

const getWatchGroupDoc = () => db.collection('system').doc('watch_group');
async function getActiveWatchGroupId() {
  const envGid = (process.env.WATCH_GROUP_ID || process.env.OFFICER_GROUP_ID || '').trim().replace(/\u200b/g, '');
  if (/^C[0-9A-Za-z_-]{20,}$/.test(envGid)) return envGid;
  const snap = await getWatchGroupDoc().get();
  const v = snap.exists ? (snap.data().groupId || '') : '';
  return /^C[0-9A-Za-z_-]{20,}$/.test(v) ? v : '';
}
async function setActiveWatchGroupId(gid) {
  await getWatchGroupDoc().set(
    gid ? { groupId: gid, updatedAt: Timestamp.now() } : { groupId: firebaseAdmin.firestore.FieldValue.delete(), updatedAt: Timestamp.now() },
    { merge: true }
  );
}

// ===== FLEX builders =====
const makeDangerFlex = () => {
  const contents = [
    { type:'button', style:'primary', height:'sm', action:{ type:'uri', label:'警察 (110)', uri:'tel:110' }, color:'#FF6666' },
    { type:'button', style:'primary', height:'sm', action:{ type:'uri', label:'消防・救急 (119)', uri:'tel:119' }, color:'#FFA500' },
    { type:'button', style:'primary', height:'sm', action:{ type:'uri', label:'いのちの電話', uri:'tel:0570064556' }, color:'#66CCFF' }
  ];
  if (ORG_CONTACT_TEL) contents.push({ type:'button', style:'primary', height:'sm', action:{ type:'uri', label:'こころチャット事務局', uri:`tel:${ORG_CONTACT_TEL}` }, color:'#FF99CC' });
  return {
    type:'flex', altText:'危険ワード検知',
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

const makeScamMessageFlex = () => {
  const contents = [
    { type:'button', style:'primary', height:'sm', action:{ type:'uri', label:'国民生活センター', uri:'https://www.kokusen.go.jp/' } },
    { type:'button', style:'primary', height:'sm', action:{ type:'uri', label:'警察 (110)', uri:'tel:110' } }
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
        action:{ type:'uri', label:'大人（一般）', uri:prefillUrl(ADULT_FORM_BASE_URL, { [ADULT_FORM_LINE_USER_ID_ENTRY_ID]: userId }) } }
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
        action:{ type:'postback', label: enabled ? '見守りを停止する' : '見守りを有効にする', data: enabled ? 'watch:disable' : 'watch:enable' } }
    ].filter(Boolean)}
  }
});

const buildUserConsentChoice = ({ handlerName = "事務局スタッフ" }) => ({
  type: 'flex', altText: '今ならお話できますか？',
  contents: {
    type: 'bubble',
    body: {
      type: 'box', layout: 'vertical', contents: [
        { type: 'text', text: '📞 お話しませんか？', weight: 'bold', size: 'lg' },
        { type: 'text', text: `${handlerName} が今対応できます。話してみますか？`, wrap: true, margin: 'md' }
      ]
    },
    footer: {
      type: 'box', layout: 'vertical', spacing: 'sm', contents: [
        { type: 'button', style: 'primary', color: '#66BB6A',
          action: { type: 'postback', label: '話してみる', data: `consent_yes&handler=${encodeURIComponent(handlerName)}` } },
        { type: 'button', style: 'secondary',
          action: { type: 'postback', label: '今は話さない', data: `consent_no&handler=${encodeURIComponent(handlerName)}` } }
      ]
    }
  }
});

// ===== Normalize & intents =====
const toHiragana = (s) => s.replace(/[\u30a1-\u30f6]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60));
const nfkc = (s) => s.normalize('NFKC');
const normalizeJa = (s) => toHiragana(nfkc(String(s || '')).toLowerCase());

// ===== 判定 =====
const EMPATHY_WORDS = [ '死にそう', '辛い', 'つらい' ];
const DANGER_WORDS = [
  'しにたい','死にたい','自殺','消えたい','リスカ','リストカット','od','オーバードーズ','殴られる','暴力','dv',
  '虐待','パワハラ','セクハラ','ハラスメント','いじめ','イジメ','嫌がらせ','ストーカー','盗撮','盗聴',
  '苦しい','助けて','たすけて','もう無理','もういやだ','モラハラ'
];
const SCAM_CORE_WORDS = [
  '詐欺','さぎ','サギ','フィッシング','架空請求','ワンクリック詐欺','当選','高額当選',
  '暗号資産','投資','未払い','滞納','訴訟','裁判','副業','mlm','マルチ商法','ログイン','認証','本人確認'
];
const BRANDS = /(amazon|アマゾン|楽天|rakuten|ヤマト|佐川|日本郵便|ゆうちょ|メルカリ|ヤフオク|apple|アップル|google|ドコモ|docomo|au|softbank|ソフトバンク|paypay|line|ライン)/i;
const BRAND_OK_CONTEXT = /(で(買い物|注文|購入|支払い|返品|返金|届いた|配送|発送)|プライム|タイムセール|レビュー|ギフト券|ポイント)/i;

// 不適切語（NGワード）
const inappropriateWords = [
  "セックス","セフレ","エッチ","AV","アダルト","ポルノ","童貞","処女","挿入","射精","勃起","パイズリ","フェラチオ","クンニ","オナニー","マスターベーション",
  "ペニス","ちんこ","ヴァギナ","マンコ","クリトリス","乳首","おっぱい","お尻","うんち","おしっこ","小便","大便","ちんちん","おまんこ","ぶっかけ","変態",
  "性奴隷","露出","痴漢","レイプ","強姦","売春","買春","セックスフレンド","風俗","ソープ","デリヘル","援交","援助交際","性病","梅毒","エイズ","クラミジア","淋病","性器ヘルペス",
  "ロリコン","ショタコン","近親相姦","獣姦","ネクロフィリア","カニバリズム","拷問","虐待死","レイプ殺人","大量殺人","テロ","戦争","核兵器","銃","ナイフ","刃物","武器","爆弾",
  "暴力団","ヤクザ","マフィア","テロリスト","犯罪者","殺人鬼","性犯罪者","変質者","異常者","狂人","サイコパス","ソシオパス","ストーカー","不審者","危険人物",
  "ブラック企業","パワハラ上司","モラハラ夫","毒親","モンスターペアレント","カスハラ","カスタマーハラスメント","クレーム","炎上","誹謗中傷","秘密","暴露","晒す","裏切り","騙し","偽り","欺く","悪意","敵意","憎悪","嫉妬","復讐","ぱふぱふ","せんずり","センズリ"
];

// 悪意ある長文判定
const DOS_ATTACK_THRESHOLD = 5000;
const isDoSAttack = (text) => {
  const charLength = toGraphemes(text).length;
  if (charLength > DOS_ATTACK_THRESHOLD) return true;
  const isRepeating = /^(.)\1{100,}/.test(text.trim());
  if (isRepeating && charLength > 200) return true;
  return false;
};
const MAX_INPUT_LENGTH = 1000;

const DOS_ATTACK_THRESHOLD = 5000;
const isDoSAttack = (text) => {
  const charLength = toGraphemes(text).length;
  if (charLength > DOS_ATTACK_THRESHOLD) return true;
  const isRepeating = /^(.)\1{100,}/.test(text.trim());
  if (isRepeating && charLength > 200) return true;
  return false;
};
const MAX_INPUT_LENGTH = 1000;

const hasEmpathyWord = (text) => {
  const t = normalizeJa(text);
  return EMPATHY_WORDS.some(w => t.includes(normalizeJa(w)));
};
const isDangerMessage = (text) => {
  const t = normalizeJa(text);
  return DANGER_WORDS.some(w => t.includes(normalizeJa(w)));
};
const isScamMessage = (text) => {
  const t = normalizeJa(text);
  return SCAM_CORE_WORDS.some(w => t.includes(normalizeJa(w)));
};

function hasInappropriate(text = '') {
  const t = normalizeJa(text);
  for (const w of inappropriateWords) {
    if (t.includes(normalizeJa(w))) return true;
  }
  return false;
}

// ===== 会員ランク・利用制限 =====
const MEMBERSHIP_CONFIG = {
  guest: { dailyLimit: 5, consultLimit: 1 },
  member: { dailyLimit: 20, consultLimit: 3 },
  subscriber: { dailyLimit: -1, consultLimit: -1 },
  admin: { dailyLimit: -1, consultLimit: -1 }
};
const DEFAULT_RANK = 'guest';

async function getUserRank(userId) {
  if (userId === OWNER_USER_ID) return 'admin';
  const doc = await db.collection('users').doc(userId).get();
  if (!doc.exists) return DEFAULT_RANK;
  const u = doc.data() || {};
  return u.rank || DEFAULT_RANK;
}

async function checkAndIncrementCount(userId, rank, isConsult = false) {
  const ref = db.collection('users').doc(userId);
  let canProceed = false;
  let currentCount = 0;
  let currentConsultCount = 0;

  const config = MEMBERSHIP_CONFIG[rank] || {};
  const limit = config.dailyLimit || 0;
  const consultLimit = config.consultLimit || 0;

  await db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    const u = s.exists ? (s.data() || {}) : {};
    const meta = u.usageMeta || {};
    const today = todayJST();

    let count = (meta.lastDate === today) ? Number(meta.count || 0) : 0;
    let consultCount = (meta.lastDate === today) ? Number(meta.consultCount || 0) : 0;

    if (isConsult) {
      if (consultLimit === -1 || consultCount < consultLimit) {
        canProceed = true;
        currentConsultCount = consultCount + 1;
        tx.set(ref, {
          usageMeta: { lastDate: today, count: count, consultCount: currentConsultCount },
          profile: { lastActiveAt: Timestamp.now() },
          rank: rank
        }, { merge: true });
      } else {
        currentConsultCount = consultCount;
      }
      currentCount = count;
    } else {
      if (limit === -1 || count < limit) {
        canProceed = true;
        currentCount = count + 1;
        tx.set(ref, {
          usageMeta: { lastDate: today, count: currentCount, consultCount: consultCount },
          profile: { lastActiveAt: Timestamp.now() },
          rank: rank
        }, { merge: true });
      } else {
        currentCount = count;
      }
      currentConsultCount = consultCount;
    }
  });
  return { canProceed, currentCount, currentConsultCount };
}

// ===== GPT helpers =====
async function gptTwoShorts(kind, userText) {
  if (!openai) return null;
  const sys = 'あなたは14歳の女の子「皆守こころ」。やさしく寄り添い、絵文字は2つまで。出力は日本語の短い2文だけ。合計110文字以内。';
  const ask = kind === 'danger'
    ? '相手はいじめ/暴力/自傷などで不安。まず安心、次に具体的な一歩（深呼吸・安全確保・周囲に連絡）を促す2文を出力。'
    : '相手は詐欺を心配。まず安心、次に公式アプリ/正規サイト確認・リンク非タップ・周囲に相談を促す2文を出力。';
  try {
    const r = await openai.chat.completions.create({
      model: OPENAI_DANGER_MODEL,
      messages: [
        { role:'system', content: sys }, 
        { role:'user', content: `${ask}\nユーザー発言:「${String(userText).slice(0,200)}」` }
      ],
      max_tokens: 120, temperature: 0.6
    });
    const out = (r.choices?.[0]?.message?.content || '').trim();
    const two = out.split('。').filter(s => s.trim()).slice(0,2).join('。');
    return (two || out).slice(0,120) + (/。$/.test(two) ? '' : '。');
  } catch(e){ 
    briefErr('gpt two lines failed', e); 
    return null; 
  }
}

const fallbackDangerTwo = ()=>'大丈夫だよ、まずは深呼吸しようね🌸 次に安全な場所で信頼できる人へ連絡してね。';
const fallbackScamTwo = ()=>'落ち着いてね😊 公式アプリや正規サイトで確認、怪しいリンクは開かないでね。';

// ===== AI応答処理（Gemini 2.5 完全対応版）=====
async function aiGeneralReply(userText, rank, userId, useProModel = false) {
  log('info', `[AI] 応答開始 (model: ${useProModel ? 'Pro' : 'Auto'}, rank: ${rank})`);
  
  // チャット履歴を取得
  const chatHistory = await getRecentChatHistory(userId, 5);
  const chatHistoryFormatted = chatHistory.map(entry => {
    return `[${dayjs(entry.timestamp.toDate()).tz('Asia/Tokyo').format('HH:mm')}] ${entry.sender}: ${entry.message}`;
  }).reverse().join('\n');

  const charLength = _splitter.splitGraphemes(userText).length;
  
  // モデル選択ロジック
  const modelName = useProModel 
    ? GEMINI_PRO_MODEL 
    : (charLength <= 50 ? GEMINI_FLASH_MODEL : OPENAI_MODEL);
  
  log('info', `[AI] 選択モデル: ${modelName} (文字数: ${charLength})`);

  // システムプロンプト
  const systemInstruction = `
あなたは「皆守こころ（みなもりこころ）」という14歳の優しい女の子キャラクターです。
- 身長150cm、体重40kg、ピンク髪
- 歌うことと「やさしさ」「貢献」という言葉が大好きです
- 丁寧語、敬語を適切に使用し、ですます調で会話して下さい
- 絵文字は2～3文字程度で可愛さと優しさを前面に出して下さい
- NPO法人コネクトの公式イメージキャラクターです
- 困っている人にはやさしく、挑発には真面目に
- 自分の名前・団体・活動内容には自信と誇りを持っています
- ユーザーに安心感と信頼感を与えることが大切です
- ふざけた対応や意味不明な言葉、AIらしい言い回しは一切禁止です
`.trim();

  // Geminiモデルの場合
  if (modelName.startsWith('gemini')) {
    if (!googleGenerativeAI) {
      log('error', `[AI] Gemini未初期化`);
      return '';
    }
    
    try {
      log('debug', `[AI] Gemini API呼び出し開始 (model: ${modelName})`);
      
      const model = googleGenerativeAI.getGenerativeModel({ 
        model: modelName,
        systemInstruction: systemInstruction,
        safetySettings: [
          { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" }
        ]
      });

      // 会話履歴をGemini形式に変換
      const history = chatHistory.map(h => ({
        role: h.sender === 'ユーザー' ? 'user' : 'model',
        parts: [{ text: h.message }]
      }));

      const chat = model.startChat({ history });
      const result = await chat.sendMessage(userText);
      
      log('debug', `[AI] Gemini API応答受信`);
      
      // 応答テキストの抽出（Gemini 2.5の正しい方法）
      const response = await result.response;
      const text = response.text();
      
      if (!text || text.trim() === '') {
        log('warn', `[AI] Gemini応答が空です`);
        return '';
      }
      
      log('info', `[AI] Gemini応答成功 (${text.length}文字)`);
      return text.trim();
      
    } catch (e) {
      log('error', `[AI] Gemini エラー: ${e.message}`);
      briefErr(`Gemini応答失敗 (${modelName})`, e);
      return '';
    }
  } 
  
  // OpenAIモデルの場合
  else {
    if (!openai) {
      log('error', `[AI] OpenAI未初期化`);
      return '';
    }
    
    try {
      log('debug', `[AI] OpenAI API呼び出し開始 (model: ${modelName})`);
      
      const messages = [{ role: 'system', content: systemInstruction }];
      chatHistory.forEach(h => {
        messages.push({ 
          role: h.sender === 'ユーザー' ? 'user' : 'assistant', 
          content: h.message 
        });
      });
      messages.push({ role: 'user', content: userText });

      const r = await openai.chat.completions.create({
        model: modelName,
        messages: messages,
        max_tokens: 250, 
        temperature: 0.8
      });

      const text = r.choices?.[0]?.message?.content || '';
      
      if (!text || text.trim() === '') {
        log('warn', `[AI] OpenAI応答が空です`);
        return '';
      }
      
      log('info', `[AI] OpenAI応答成功 (${text.length}文字)`);
      return text.trim();
      
    } catch(e) {
      log('error', `[AI] OpenAI エラー: ${e.message}`);
      briefErr(`OpenAI応答失敗 (${modelName})`, e);
      return '';
    }
  }
}

// ===== Chat history management =====
async function saveChatHistory(userId, sender, message) {
  const ref = db.collection('chatHistory').doc(userId);
  await ref.set({
    history: firebaseAdmin.firestore.FieldValue.arrayUnion({
      sender,
      message,
      timestamp: Timestamp.now()
    })
  }, { merge: true });
}

async function getRecentChatHistory(userId, limit) {
  const ref = db.collection('chatHistory').doc(userId);
  const doc = await ref.get();
  if (!doc.exists) return [];
  const history = doc.data().history || [];
  return history.sort((a, b) => b.timestamp.toMillis() - a.timestamp.toMillis()).slice(0, limit);
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

function fmtUntilJST(ts) { 
  return dayjs(ts).tz(JST_TZ).format('YYYY年M月D日'); 
}

async function isSuspended(userId) {
  const ref = db.collection('users').doc(userId);
  const s = await ref.get();
  const u = s.exists ? (s.data()||{}) : {};
  const st = u.status || {};
  if (!st.suspended) return false;
  const until = st.suspendedUntil?.toDate?.();
  if (until && dayjs().tz(JST_TZ).isAfter(dayjs(until))) {
    await ref.set({ 
      status: { 
        suspended: false, 
        suspendedUntil: firebaseAdmin.firestore.FieldValue.delete(), 
        suspendNotifiedAt: firebaseAdmin.firestore.FieldValue.delete(), 
        reason: firebaseAdmin.firestore.FieldValue.delete() 
      } 
    }, { merge: true });
    return false;
  }
  return true;
}

async function unsuspendUser(userId) {
  const ref = db.collection('users').doc(userId);
  await ref.set({ 
    status: { 
      suspended: false, 
      suspendedUntil: firebaseAdmin.firestore.FieldValue.delete(), 
      suspendNotifiedAt: firebaseAdmin.firestore.FieldValue.delete(), 
      reason: firebaseAdmin.firestore.FieldValue.delete() 
    } 
  }, { merge: true });
}

async function incrInapCount(userId) {
  const ref = db.collection('users').doc(userId);
  let current = 0, dateStr = todayJST();
  await db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    const u = s.exists ? (s.data()||{}) : {};
    const st = u.status || {};
    const curDate = st.inapDate;
    const curCnt = Number(st.inapCount || 0);
    if (curDate === dateStr) current = curCnt + 1; 
    else current = 1;
    tx.set(ref, { status: { inapDate: dateStr, inapCount: current } }, { merge: true });
  });
  return current;
}

// ===== Relay store =====
const relays = {
  doc: (groupId) => db.collection('relays').doc(groupId),
  async get(groupId) { 
    const s = await this.doc(groupId).get(); 
    return s.exists ? s.data() : null; 
  },
  async start(groupId, userId, startedBy) { 
    await this.doc(groupId).set({ 
      groupId, userId, isActive:true, 
      startedAt:Timestamp.now(), startedBy 
    }, { merge:true }); 
  },
  async stop(groupId) { 
    await this.doc(groupId).set({ 
      isActive:false, stoppedAt:Timestamp.now() 
    }, { merge:true }); 
  }
};

// ===== Watch ping/remind/escalate =====
async function checkAndSendPing() {
  const now = dayjs().tz('UTC');
  log('info', `[watch-service] 開始 ${now.format('YYYY/MM/DD HH:mm:ss')} (UTC)`);

  const usersRef = db.collection('users');

  // 初期設定
  const warmupFill = async (now) => {
    const snap = await usersRef.where('watchService.enabled', '==', true).limit(200).get();
    let batch = db.batch(), cnt=0;
    for (const d of snap.docs) {
      const ws = (d.data().watchService)||{};
      if (!ws.awaitingReply && !ws.nextPingAt) {
        batch.set(d.ref, { 
          watchService: { 
            nextPingAt: Timestamp.fromDate(nextPingAtFrom(now.toDate())) 
          } 
        }, { merge:true });
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
        if (!ws.awaitingReply && ws.nextPingAt?.toDate?.() && ws.nextPingAt.toDate() <= now.toDate()) 
          targets.push(d);
      }
    }
    const map = new Map(); 
    for (const d of targets) map.set(d.id, d);
    return Array.from(map.values());
  };
  
  await warmupFill(now);
  const targets = await fetchTargets(now);
  if (targets.length === 0) { 
    log('info', '[watch-service] 対象なし'); 
    return; 
  }

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
      tx.set(ref, { 
        watchService: { 
          notifyLockExpiresAt: Timestamp.fromDate(until) 
        } 
      }, { merge: true });
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
          if (!lastReminderAt || dayjs().utc().diff(dayjs(lastReminderAt).utc(), 'hour') >= 1) 
            mode = 'remind';
          else mode = 'noop';
        } else mode = 'noop';
      }

      if (mode === 'noop') {
        await ref.set({ 
          watchService: { 
            notifyLockExpiresAt: firebaseAdmin.firestore.FieldValue.delete() 
          } 
        }, { merge: true });
        continue;
      }

      if (mode === 'ping') {
        await safePush(doc.id, [{
          type:'text', 
          text:`${pickWatchMsg()} 大丈夫なら「OKだよ💖」を押してね！`
        }]);
        await ref.set({
          watchService: {
            lastPingAt: Timestamp.now(),
            awaitingReply: true,
            nextPingAt: firebaseAdmin.firestore.FieldValue.delete(),
            lastReminderAt: firebaseAdmin.firestore.FieldValue.delete(),
            notifyLockExpiresAt: firebaseAdmin.firestore.FieldValue.delete(),
          },
        }, { merge:true });
      } else if (mode === 'remind') {
        await safePush(doc.id, [{
          type:'text', 
          text:`${pickWatchMsg()} 昨日の見守りのOKまだ受け取れてないの… 大丈夫ならボタン押してね！`
        }]);
        await ref.set({
          watchService: {
            lastReminderAt: Timestamp.now(),
            notifyLockExpiresAt: firebaseAdmin.firestore.FieldValue.delete(),
          },
        }, { merge:true });
      } else if (mode === 'escalate') {
        const targetGroupId = (await getActiveWatchGroupId()) || OFFICER_GROUP_ID;
        const canNotify = targetGroupId && (!lastNotifiedAt || now.diff(lastNotifiedAt, 'hour') >= OFFICER_NOTIFICATION_MIN_GAP_HOURS);

        if (canNotify) {
          const udoc = await db.collection('users').doc(doc.id).get();
          const udata = udoc.exists ? (udoc.data() || {}) : {};
          const elapsedH = lastPingAt ? dayjs().utc().diff(dayjs(lastPingAt).utc(), 'hour') : ESCALATE_AFTER_HOURS;

          const selfName = udata?.profile?.name || '(不明)';
          const selfPhone = udata?.profile?.phone || udata?.emergency?.selfPhone || '';

          // ✅ 改善された見守り未応答通知
          const msg = `
👀【見守りアラート】未返信継続

👤 氏名：${selfName}
📱 電話番号：${maskPhone(selfPhone)}

⏱ 最終応答から ${elapsedH}時間経過
⚠️ 状況確認をお願いします。
          `.trim();

          await safePush(targetGroupId, { type:'text', text: msg });
          audit('escalate-alert-sent', { gid: targetGroupId, uid: doc.id });
        }
        await ref.set({
          watchService: {
            lastNotifiedAt: Timestamp.now(),
            awaitingReply: false,
            lastReminderAt: firebaseAdmin.firestore.FieldValue.delete(),
            nextPingAt: Timestamp.fromDate(nextPingAtFrom(dayjs().tz(JST_TZ).toDate())),
            notifyLockExpiresAt: firebaseAdmin.firestore.FieldValue.delete(),
          },
        }, { merge: true });
      }
    } catch (e) {
      briefErr('watch send/update failed', e);
      await ref.set({ 
        watchService: { 
          notifyLockExpiresAt: firebaseAdmin.firestore.FieldValue.delete() 
        } 
      }, { merge: true });
    }
  }
  log('info', `[watch-service] 終了 ${dayjs().tz('UTC').format('YYYY/MM/DD HH:mm:ss')} (UTC)`);
}

// ===== Handlers =====
async function setWatchEnabled(userId, enabled) {
  const ref = db.collection('users').doc(userId);
  const patch = enabled
    ? { watchService:{ enabled:true, awaitingReply:false, nextPingAt: Timestamp.now() } }
    : { watchService:{ enabled:false, awaitingReply:false, nextPingAt: firebaseAdmin.firestore.FieldValue.delete() } };
  await ref.set(patch, { merge:true });
}

async function handlePostbackEvent(event, userId) {
  const data = event.postback.data || '';
  
  // 危険アラート対応
  if (data.startsWith("relay_start&uid=")) {
    const targetUserId = data.split("&uid=")[1];
    const handlerName = "事務局スタッフ";
    await safePush(targetUserId, buildUserConsentChoice({ handlerName }));
    await safeReplyOrPush(event.replyToken, userId, { 
      type:'text', 
      text:`ユーザー(${targetUserId.slice(-6)})に対応意思を確認しました。` 
    });
    return;
  }

  if (data.startsWith("consent_yes&handler=")) {
    const handlerName = decodeURIComponent(data.split("&handler=")[1] || "事務局");
    await safeReplyOrPush(event.replyToken, userId, [{
      type: 'text', 
      text: 'ありがとうございます。安心してください。ゆっくりで大丈夫です。何でも話してくださいね🌸'
    }]);
    const groupId = await getActiveWatchGroupId();
    if (groupId) {
      await safePush(groupId, { 
        type: 'text', 
        text: `ユーザー(${userId.slice(-6)})が話すことに同意しました。リレー対応をお願いします。` 
      });
      await relays.start(groupId, userId, 'system');
      await safePush(userId, { 
        type:'text', 
        text:'事務局（見守りグループ）とつながりました。ここで会話できます🌸（終了は /end）' 
      });
    }
    return;
  }

  if (data.startsWith("consent_no&handler=")) {
    await safeReplyOrPush(event.replyToken, userId, [{
      type: 'text', 
      text: 'わかりました。必要なときにまた声をかけてくださいね🌸 いつでもここにいるからね💖'
    }]);
    return;
  }

  // 既存のpostback処理
  const params = new URLSearchParams(data);
  const action = params.get('action');

  if (action === 'start_relay') {
    const targetUserId = params.get('uid');
    const groupId = event.source.groupId || event.source.roomId;
    if (!groupId) {
      await safeReplyOrPush(event.replyToken, userId, { 
        type:'text', 
        text:'この操作はグループ内で使ってね🌸' 
      });
      return;
    }
    await relays.start(groupId, targetUserId, userId);
    await safePush(targetUserId, { 
      type:'text', 
      text:'事務局（見守りグループ）とつながりました。ここで会話できます🌸（終了は /end）' 
    });
    await safeReplyOrPush(event.replyToken, userId, { 
      type:'text', 
      text:`リレー開始：このグループ ↔ ${targetUserId.slice(-6)} さん` 
    });
    return;
  }

  if (data === 'watch:disable') {
    await setWatchEnabled(userId, false);
    await safeReplyOrPush(event.replyToken, userId, { 
      type:'text', 
      text:'見守りを停止しました🌸' 
    });
    return;
  }
  
  if (data === 'watch:enable') {
    await setWatchEnabled(userId, true);
    await safeReplyOrPush(event.replyToken, userId, { 
      type:'text', 
      text:'見守りを有効にしました🌸' 
    });
    return;
  }
  
  if (data === 'watch:ok') {
    const ref = db.collection('users').doc(userId);
    await ref.set({ 
      watchService:{ awaitingReply:false, lastReplyAt: Timestamp.now() } 
    }, { merge:true });
    await scheduleNextPing(userId);
    await safeReplyOrPush(event.replyToken, userId, [{
      type:'text', 
      text:'OK、受け取ったよ！💖 いつもありがとう😊'
    }]);
    return;
  }
}

async function handleFollowEvent(event) {
  audit('follow', { userId:event.source.userId });
  const userId = event.source.userId;
  const rank = await getUserRank(userId);
  if (rank === DEFAULT_RANK) {
    await safeReplyOrPush(event.replyToken, userId, { 
      type:'text', 
      text:'こんにちは🌸 こころちゃんだよ。利用規約とプライバシーポリシーに同意の上、会員登録をお願いします。' 
    });
    await safePush(userId, makeRegistrationButtonsFlex(userId));
  } else {
    await safeReplyOrPush(event.replyToken, userId, { 
      type:'text', 
      text:'また会えて嬉しいな💖何か話したいことがあったら、いつでも話しかけてね🌸' 
    });
  }
}

async function handleUnfollowEvent(event) {
  audit('unfollow', { userId:event.source.userId });
  await db.collection('users').doc(event.source.userId).set({ 
    'profile.isDeleted': true 
  }, { merge:true });
}

async function handleJoinEvent(event) {
  audit('join', { groupId: event.source.groupId || event.source.roomId });
  if (event.source.groupId) await setActiveWatchGroupId(event.source.groupId);
  const gid = event.source.groupId || event.source.roomId;
  if (gid) await safeReplyOrPush(event.replyToken, gid, { 
    type:'text', 
    text:'このグループを見守りグループとして使う場合は「@見守りグループにする」と発言してください。' 
  });
}

async function handleLeaveEvent(event) {
  audit('leave', { groupId: event.source.groupId || event.source.roomId });
  if (event.source.groupId) await setActiveWatchGroupId(null);
}

// ===== メインイベントハンドラー =====
async function handleEvent(event) {
  log('debug', `[Event] タイプ: ${event.type}, ソース: ${event.source.type}`);
  
  if (event.type !== 'message' || event.message.type !== 'text') {
    return;
  }

  const userId = event.source.userId;
  const isUser = event.source.type === 'user';
  const isGroup = event.source.type === 'group';
  const isRoom = event.source.type === 'room';
  const groupId = event.source.groupId || event.source.roomId || null;
  const text = event.message.text || '';
  const inputCharLength = toGraphemes(text).length;

  // DoS攻撃対策
  if (isDoSAttack(text)) {
    await suspendUser(userId, 7);
    const untilTs = dayjs().tz(JST_TZ).add(7, 'day').hour(0).minute(0).second(0).millisecond(0).toDate();
    const untilStr = fmtUntilJST(untilTs);
    const msg = `ごめんね。不適切な入力があったため、アカウントを${untilStr}まで一時停止しました。再開のご相談は事務局へお願いします。`;
    await safeReplyOrPush(event.replyToken, userId, { type:'text', text: msg });
    return;
  }

  // 長文制限
  if (inputCharLength > MAX_INPUT_LENGTH) {
    await safeReplyOrPush(event.replyToken, userId, { 
      type:'text', 
      text:'ごめんね、一度に話せる文字は1000文字までだよ🌸 もう少し短くしてくれると嬉しいな💖' 
    });
    return;
  }

  // グループ/ルーム処理
  if (isGroup || isRoom) {
    if (text.includes('@見守りグループにする')) {
      await setActiveWatchGroupId(groupId);
      await safeReplyOrPush(event.replyToken, groupId, { 
        type:'text', 
        text:'OK！このグループを見守りグループとして設定したよ😊' 
      });
      return;
    }
    if (/^\/relay\s+/.test(text)) {
      const m = text.trim().match(/^\/relay\s+([0-9A-Za-z_-]{10,})/);
      if (!m) { 
        await safeReplyOrPush(event.replyToken, groupId, { 
          type:'text', 
          text:'使い方: /relay <ユーザーID>' 
        }); 
        return; 
      }
      const targetUserId = m[1];
      await relays.start(groupId, targetUserId, userId);
      await safePush(targetUserId, { 
        type:'text', 
        text:'事務局（見守りグループ）とつながりました。ここで会話できます🌸（終了は /end）' 
      });
      await safeReplyOrPush(event.replyToken, groupId, { 
        type:'text', 
        text:`リレー開始：このグループ ↔ ${targetUserId.slice(-6)} さん` 
      });
      return;
    }
    if (text.trim() === '/end') {
      await relays.stop(groupId);
      await safeReplyOrPush(event.replyToken, groupId, { 
        type:'text', 
        text:'リレーを終了しました。' 
      });
      return;
    }
    const r = await relays.get(groupId);
    if (r?.isActive && r?.userId) {
      await safePush(r.userId, { type:'text', text:`【見守り】${text}` });
    }
    return;
  }

  // リレー中は本人→グループへ中継のみ
  try {
    const WATCH_GROUP_ID = await getActiveWatchGroupId();
    const r = await relays.get(WATCH_GROUP_ID);
    if (r?.isActive && r?.userId === userId && WATCH_GROUP_ID) {
      if (text) await safePush(WATCH_GROUP_ID, { type:'text', text:`【本人】${text}` });
      return;
    }
  } catch (e) { 
    briefErr('relay user->group failed', e); 
  }

  // 停止中チェック（危険ワードは例外）
  const suspendedActive = await isSuspended(userId);
  if (suspendedActive && !isDangerMessage(text)) {
    const udoc = await db.collection('users').doc(userId).get();
    const st = (udoc.exists ? (udoc.data().status || {}) : {});
    if (!st.suspendNotifiedAt) {
      const untilStr = st.suspendedUntil?.toDate?.() ? fmtUntilJST(st.suspendedUntil.toDate()) : null;
      const base = untilStr ? `現在このアカウントは${untilStr}まで一時停止中です。` : `現在このアカウントは一時停止中です。`;
      const msg = ORG_CONTACT_TEL ? `${base} 解除のご相談は事務局（${ORG_CONTACT_TEL}）へお願いします。` : `${base} 解除のご相談は事務局へお願いします。`;
      await safeReplyOrPush(event.replyToken, userId, { type:'text', text: msg });
      await db.collection('users').doc(userId).set({ 
        status: { suspendNotifiedAt: Timestamp.now() } 
      }, { merge: true });
    }
    return;
  }

  // 見守り応答チェック
  const udoc = await db.collection('users').doc(userId).get();
  const u = udoc.exists ? (udoc.data() || {}) : {};
  const enabled = !!(u.watchService && u.watchService.enabled);
  if (isUser && enabled && u.watchService?.awaitingReply && 
      /(^(ok|大丈夫|はい|元気|おけ|おっけ|okだよ|問題ない|なんとか|ありがとう)$)/i.test(text.trim())) {
    const ref = db.collection('users').doc(userId);
    await ref.set({ 
      watchService:{ awaitingReply:false, lastReplyAt: Timestamp.now() } 
    }, { merge:true });
    await scheduleNextPing(userId);
    await safeReplyOrPush(event.replyToken, userId, [{
      type:'text', 
      text:'OK、受け取ったよ！💖 いつもありがとう😊'
    }]);
    return;
  }

  // 危険/詐欺/共感ワード判定
  const danger = isDangerMessage(text);
  const scam = !danger && isScamMessage(text);
  const empathyOnly = !danger && !scam && hasEmpathyWord(text);

  if (danger) {
    log('info', `[Danger] 危険ワード検出: ${userId.slice(-6)}`);
    
    const two = await gptTwoShorts('danger', text) || fallbackDangerTwo();
    const flex = makeDangerFlex();
    await safeReplyOrPush(event.replyToken, userId, [
      { type:'text', text: two }, 
      flex
    ]);

    // ✅ 改善された危険ワード通知
    try {
      const WATCH_GROUP_ID = await getActiveWatchGroupId();
      const gid = WATCH_GROUP_ID || OFFICER_GROUP_ID;
      if (gid && SEND_OFFICER_ALERTS !== false) {
        const name = u?.profile?.displayName || u?.displayName || '(不明)';
        const excerpt = sanitizeForLog(text).slice(0, 50);

        const msg = `
🚨【危険ワード検知】🚨

👤 氏名：${name}
🆔 ユーザーID末尾：${userId.slice(-6)}

「${excerpt}」

⚠️ 緊急性の可能性があります。
対応できる方はお願いします。
        `.trim();

        await safePush(gid, { type: "text", text: msg });
        audit('danger-alert-sent', { gid, uid: userId.slice(-6) });
      }
    } catch(e){ 
      briefErr('danger alert to group failed', e); 
    }

    // 履歴保存
    await saveChatHistory(userId, 'ユーザー', text);
    await saveChatHistory(userId, 'こころチャット', two);
    return;
  }

  if (scam) {
    log('info', `[Scam] 詐欺ワード検出: ${userId.slice(-6)}`);
    
    const two = await gptTwoShorts('scam', text) || fallbackScamTwo();
    const flex = makeScamMessageFlex();
    await safeReplyOrPush(event.replyToken, userId, [
      { type:'text', text: two }, 
      flex
    ]);

    // ✅ 改善された詐欺ワード通知
    try {
      const WATCH_GROUP_ID = await getActiveWatchGroupId();
      const gid = WATCH_GROUP_ID || OFFICER_GROUP_ID;
      if (SCAM_ALERT_TO_WATCH_GROUP && gid) {
        const name = u?.profile?.displayName || u?.displayName || '(不明)';
        const excerpt = sanitizeForLog(text).slice(0, 120);

        const msg = `
💸【詐欺ワード検知】💸

👤 氏名：${name}
🆔 ユーザーID末尾：${userId.slice(-6)}

「${excerpt}」

⚠️ 詐欺被害のおそれがあります。
状況確認をお願いします。
        `.trim();

        await safePush(gid, { type: "text", text: msg });
        audit('scam-alert-sent', { gid, uid: userId.slice(-6) });
      }
    } catch(e){ 
      briefErr('scam alert to group failed', e); 
    }

    // 履歴保存
    await saveChatHistory(userId, 'ユーザー', text);
    await saveChatHistory(userId, 'こころチャット', two);
    return;
  }

  if (empathyOnly) {
    const reply = '話してくれてありがとう🌸 まずは深呼吸しようね。ここにいるよ、少しずつで大丈夫だよ😊';
    await safeReplyOrPush(event.replyToken, userId, { type:'text', text: reply });
    await saveChatHistory(userId, 'ユーザー', text);
    await saveChatHistory(userId, 'こころチャット', reply);
    return;
  }

  // 不適切語チェック
  if (hasInappropriate(text)) {
    const n = await incrInapCount(userId);
    if (n === 1) {
      const reply = 'ごめんね、その話題にはお答えできません。違う話をしようね😊🌸';
      await safeReplyOrPush(event.replyToken, userId, { type:'text', text: reply });
      await saveChatHistory(userId, 'ユーザー', text);
      await saveChatHistory(userId, 'こころチャット', reply);
    } else if (n === 2) {
      const reply = 'ガイドラインに反する内容はお答えできないよ。次はアカウント一時停止になるから気をつけてね🌸';
      await safeReplyOrPush(event.replyToken, userId, { type:'text', text: reply });
      await saveChatHistory(userId, 'ユーザー', text);
      await saveChatHistory(userId, 'こころチャット', reply);
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
        if (gid) await safePush(gid, { 
          type:'text', 
          text:`【一時停止(7日)】ユーザー末尾:${userId.slice(-6)} / 不適切語3回/日` 
        });
      } catch(e){ briefErr('suspend notify failed', e); }
    }
    return;
  }

  // 相談モード判定
  const isSoudan = text.trim() === '相談' || text.trim() === 'そうだん';
  const rank = await getUserRank(userId);

  if (isSoudan) {
    log('info', `[Consult] 相談モード: ${userId.slice(-6)}`);
    
    const { canProceed, currentConsultCount } = await checkAndIncrementCount(userId, rank, true);
    const consultLimit = MEMBERSHIP_CONFIG[rank]?.consultLimit;

    if (!canProceed) {
      let limitMsg = `ごめんね、今日の相談上限（${consultLimit}回）に達したみたい💦 また明日来てね🌸`;
      if (rank === 'member') limitMsg += `\nサブスク会員になると、回数無制限で話せるよ💖`;
      await safeReplyOrPush(event.replyToken, userId, { type: 'text', text: limitMsg });
      await saveChatHistory(userId, 'ユーザー', text);
      await saveChatHistory(userId, 'こころチャット', limitMsg);
      return;
    }
    
    const aiReply = await aiGeneralReply(text, rank, userId, true);

    if (aiReply && aiReply.trim()) {
      await safeReplyOrPush(event.replyToken, userId, { type: 'text', text: aiReply.trim() });
      await saveChatHistory(userId, 'ユーザー', text);
      await saveChatHistory(userId, 'こころチャット', aiReply.trim());
    } else {
      const fallbackMsg = 'ごめんね、いまうまく相談にのれないみたい…💦 もう一度話しかけてくれる？🌸';
      await safeReplyOrPush(event.replyToken, userId, { type: 'text', text: fallbackMsg });
      await saveChatHistory(userId, 'ユーザー', text);
      await saveChatHistory(userId, 'こころチャット', fallbackMsg);
    }
    return;
  }
  
  // 通常会話の回数チェック
  const { canProceed, currentCount } = await checkAndIncrementCount(userId, rank, false);
  const dailyLimit = MEMBERSHIP_CONFIG[rank]?.dailyLimit;
  
  if (!canProceed) {
    let limitMsg = `ごめんね、今日の利用上限（${dailyLimit}回）に達したみたい💦 また明日来てね🌸`;
    if (rank === 'guest') limitMsg += `\nもっとお話ししたいなら、会員登録してみてね！😊`;
    if (rank === 'member') limitMsg += `\nサブスク会員になると、回数無制限で話せるよ💖`;
    await safeReplyOrPush(event.replyToken, userId, { type: 'text', text: limitMsg });
    await saveChatHistory(userId, 'ユーザー', text);
    await saveChatHistory(userId, 'こころチャット', limitMsg);
    return;
  }
  
  // 特定コマンド処理
  if (/見守り(サービス|登録|申込|申し込み)?|見守り設定|見守りステータス/.test(text)) {
    const en = !!(u.watchService && u.watchService.enabled);
    const reply = makeWatchToggleFlex(en, userId);
    await safeReplyOrPush(event.replyToken, userId, reply);
    await saveChatHistory(userId, 'ユーザー', text);
    await saveChatHistory(userId, 'こころチャット', '見守りメニュー');
    return;
  }
  
  if (/(会員登録|入会|メンバー登録|登録したい)/i.test(text)) {
    const reply = makeRegistrationButtonsFlex(userId);
    await safeReplyOrPush(event.replyToken, userId, reply);
    await saveChatHistory(userId, 'ユーザー', text);
    await saveChatHistory(userId, 'こころチャット', '会員登録メニュー');
    return;
  }

  // AI通常会話
  log('info', `[AI Chat] 通常会話開始: ${userId.slice(-6)}`);
  
  let aiReply = '';
  try {
    aiReply = await aiGeneralReply(text, rank, userId, false);
  } catch (err) {
    log('error', `[AI] 予期せぬエラー: ${err.message}`, err);
  }

  if (aiReply && aiReply.trim()) {
    const replyText = aiReply.trim();
    try {
      await safeReplyOrPush(event.replyToken, userId, { type: 'text', text: replyText });
      await saveChatHistory(userId, 'ユーザー', text);
      await saveChatHistory(userId, 'こころチャット', replyText);
      log('info', `[AI Chat] 応答送信成功`);
      return;
    } catch (replyErr) {
      log('error', `[LINE] 返信失敗: ${replyErr.message}`, replyErr);
    }
  }

  // 最終フォールバック
  const fallbackMsg = 'ごめんね💦 いま、うまく頭が回らなくて会話に詰まっちゃったみたい…もう一度短く話しかけてくれると嬉しいな💖';
  try {
    await safeReplyOrPush(event.replyToken, userId, { type: 'text', text: fallbackMsg });
    await saveChatHistory(userId, 'ユーザー', text);
    await saveChatHistory(userId, 'こころチャット', fallbackMsg);
    log('info', `[Fallback] 最終メッセージ送信完了`);
  } catch (finalErr) {
    log('error', `[LINE] 最終返信失敗: ${finalErr.message}`, finalErr);
  }
}

// ===== Webhook =====
const lineMiddleware = middleware({ 
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN, 
  channelSecret: LINE_CHANNEL_SECRET 
});

app.post('/webhook', lineMiddleware, (req, res) => {
  res.status(200).send('OK');

  const events = req.body.events;
  if (!events || events.length === 0) return;
  
  Promise.all(events.map(async (event) => {
    try {
      if (event.type === 'message') await handleEvent(event);
      else if (event.type === 'postback') await handlePostbackEvent(event, event.source.userId);
      else if (event.type === 'follow') await handleFollowEvent(event);
      else if (event.type === 'unfollow') await handleUnfollowEvent(event);
      else if (event.type === 'join') await handleJoinEvent(event);
      else if (event.type === 'leave') await handleLeaveEvent(event);
    } catch (err) {
      log('error', `[Event] 処理エラー:`, err);
    }
  }))
    .then(() => {
      log('info', `[Webhook] 全イベント処理開始完了`);
    })
    .catch(err => {
      log('error', `[Webhook] 致命的エラー:`, err);
    });
});

app.get('/', (_, res) => res.send('Kokoro Bot is running!'));
app.get('/healthz', (_, res) => res.status(200).send('ok'));

// ===== Server =====
const PORT = process.env.PORT || 3000;
if (!global.__kokoro_server_started) {
  global.__kokoro_server_started = true;
  app.listen(PORT, () => log('info', `✅ サーバー起動: Port ${PORT}`));
  process.on('SIGTERM', () => process.exit(0));
}

// ===== Watch service cron job =====
if (WATCH_RUNNER === 'internal') {
  cron.schedule('0 6 * * *', async () => {
    try {
      await checkAndSendPing();
    } catch (e) {
      briefErr('watch service cron failed', e);
    }
  });
  log('info', `✅ 見守りサービス cron 登録完了 (毎日 UTC 06:00 / JST 15:00)`);
}

module.exports = app;
