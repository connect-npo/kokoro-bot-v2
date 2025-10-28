'use strict';

/*
 index.js (angel-kokoro, enhanced-2025-10-20)
 - 9-18をベースに危険ワード検出時のグループ通知機能を追加
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

// ----------------------------------------------------
//   以下、設定値・定数の定義 (省略不可)
// ----------------------------------------------------

// 環境変数からの設定
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const FIREBASE_SERVICE_ACCOUNT = process.env.FIREBASE_SERVICE_ACCOUNT;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OWNER_USER_ID = process.env.OWNER_USER_ID;
const OFFICER_GROUP_ID = process.env.OFFICER_GROUP_ID; // 役員向けグループID
const EMERGENCY_CONTACT_PHONE_NUMBER = process.env.EMERGENCY_CONTACT_PHONE_NUMBER || '03-xxxx-xxxx';
const ORG_NAME = process.env.ORG_NAME || 'NPO法人コネクト';
const ORG_SHORT_NAME = process.env.ORG_SHORT_NAME || 'コネクト';
const ORG_MISSION = process.env.ORG_MISSION || 'こどもや家族を支援する';
const HOMEPAGE_URL = process.env.HOMEPAGE_URL || 'https://connect-npo.org';
const ORG_CONTACT_TEL = process.env.ORG_CONTACT_TEL || '03-xxxx-xxxx';

// モデル名
const GEMINI_FLASH_MODEL = 'gemini-2.5-flash';
const GEMINI_PRO_MODEL   = 'gemini-2.5-pro';
const OPENAI_MODEL       = 'gpt-4o-mini';
const OPENAI_DANGER_MODEL= 'gpt-4o-mini'; // 危険・詐欺応答用（短い応答に特化）

// 制限値
const MAX_INPUT_LENGTH = 1000;  // 最大入力文字数 (DoS対策)
const MIN_DANGER_WORD_LENGTH = 3; // 危険ワード判定の最小文字数

// 見守りサービス設定
const JST_TZ = 'Asia/Tokyo';
const WATCH_PING_HOUR_JST = 15;  // 見守りPing時刻 (JST 15:00)
const REMINDER_AFTER_HOURS = 24; // Ping後、リマインドを送るまでの時間
const ESCALATE_AFTER_HOURS = 48; // Ping後、エスカレーションするまでの時間
const OFFICER_NOTIFICATION_MIN_GAP_HOURS = 6; // 役員への通知間隔の最小時間
const WATCH_RUNNER = process.env.WATCH_RUNNER || 'internal';
const SCAM_ALERT_TO_WATCH_GROUP = (process.env.SCAM_ALERT_TO_WATCH_GROUP || 'true').toLowerCase() === 'true';
const SEND_OFFICER_ALERTS = (process.env.SEND_OFFICER_ALERTS || 'true').toLowerCase() === 'true';

// 会員ランクと利用制限設定 (dailyLimit: -1 で無制限, consultLimit: -1 で無制限)
const DEFAULT_RANK = 'guest';
const MEMBERSHIP_CONFIG = {
  guest:    { dailyLimit: 10, consultLimit: 1, isUnlimited: false },
  member:   { dailyLimit: 30, consultLimit: 3, isUnlimited: false },
  subscriber: { dailyLimit: -1, consultLimit: -1, isUnlimited: true }, // サブスクリプション会員
  admin:    { dailyLimit: -1, consultLimit: -1, isUnlimited: true }  // 運営者
};

// 危険ワード
const DANGER_WORDS = [
  "いじめ","死にたい","自殺","自傷","リスカ","OD","オーバードーズ","暴力","殺す","殺される","誘拐","虐待","助けて","危険な","危ない","連れ去り"
];

// 詐欺・不審なワード (正規表現は使用しない)
const SCAM_CORE_WORDS = [
  "当選","高額当選","秘密の投資","緊急連絡","アカウント停止","支払情報更新","クリックして","儲かる",
  "お金を振り込んで","送金","個人情報提出","IDとパスワード","クレジットカード番号","振込先変更"
];

// LINEに表示するブランド名 (詐欺の可能性をチェックするヒント)
const BRANDS = /(apple|google|amazon|line|楽天|三井|三菱|銀行|警察|国税|税務署|役所|役場|裁判所|弁護士)/i;
const BRAND_OK_CONTEXT = /(公式|正規|本社|相談|質問|購入|予約|利用|サービス内容|料金|使い方)/i;

// 不適切語
const inappropriateWords = [
  "セックス","エロ","オナニー","パイズリ","オマンコ","ちんこ","ペニス","クリトリス","フェラチオ","オーラル","アダルト","熟女","JK","AV","童貞","処女","挿入","精液","射精","中出し","レイプ","強姦","わいせつ","おっぱい","乳首","パンツ","スカートの中","下着","下半身","股間","性交"
];

// その他トリガー
const EMPATHY_WORDS = ["辛い","しんどい","悲しい","苦しい","悩み","不安","孤独","寂しい","疲れた","病気","痛い","具合悪い","困った","どうしよう","辞めたい"];
const SOODAN_TRIGGERS = ["そうだん", "相談"];
const ORG_INTENT = /(コネクト|団体|NPO法人|事務所|活動|目的|理念|理事長)/;
const ORG_SUSPICIOUS = /(あやしい|胡散臭い|詐欺|税金泥棒|松本博文)/;
const HOMEPAGE_INTENT = /(ホームページ|HP|URL|サイト|ウェブ)/;

// 見守りメッセージ候補
const WATCH_MSGS = [
  "元気にしてるかな？🌸", "体調崩してない？😊", "少し心配になっちゃったよ💖", "なにか話したいことない？✨", "息抜きできてるかな？😊"
];
const pickWatchMsg = () => WATCH_MSGS[Math.floor(Math.random() * WATCH_MSGS.length)];

// ----------------------------------------------------
//   初期化と定数
// ----------------------------------------------------

// Firebase初期化
if (FIREBASE_SERVICE_ACCOUNT) {
  const serviceAccount = JSON.parse(FIREBASE_SERVICE_ACCOUNT);
  if (firebaseAdmin.apps.length === 0) {
    firebaseAdmin.initializeApp({
      credential: firebaseAdmin.credential.cert(serviceAccount)
    });
  }
}
const db = firebaseAdmin.firestore();
const Timestamp = firebaseAdmin.firestore.Timestamp;

// OpenAI初期化
let openai = null;
if (OPENAI_API_KEY) {
  try {
    const { OpenAI } = require('openai');
    openai = new OpenAI({ apiKey: OPENAI_API_KEY });
  } catch (e) {
    log('error', "[INIT] OpenAI SDKの初期化に失敗しました:", e);
    openai = null;
  }
} else {
  log('warn', "[INIT] OPENAI_API_KEY が設定されていません。OpenAIモデルは利用できません。");
}

// Google Generative AI (Gemini) 初期化
let googleGenerativeAI = null;
if (GEMINI_API_KEY) {
  try {
    const { GoogleGenAI } = require('@google/genai');
    googleGenerativeAI = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  } catch (e) {
    log('error', "[INIT] GoogleGenAI SDKの初期化に失敗しました:", e);
    googleGenerativeAI = null;
  }
} else {
  log('warn', "[INIT] GEMINI_API_KEY が設定されていません。Geminiモデルは利用できません。");
}

// ----------------------------------------------------
//   ヘルパー関数
// ----------------------------------------------------

// タイムゾーン付きの日付取得
const todayJST = () => dayjs().tz(JST_TZ).format('YYYY-MM-DD');

// 正規化（全角英数を半角に、ひらがなをカタカナに、小文字に）
function normalizeJa(text) {
  return String(text || '').normalize('NFKC').toLowerCase();
}

// DoS攻撃判定（極端に長い単語や連続した記号）
function isDoSAttack(text) {
  if (text.length > 2000) return true; // 長すぎる
  const maxLen = 80;
  const parts = text.split(/\s+/).filter(s => s.length > maxLen);
  if (parts.length > 0) return true; // 異常に長い単語
  if (/(.)\1{30,}/.test(text)) return true; // 30文字以上の同じ文字の繰り返し
  return false;
}

// 次のPing予定時刻を計算
function nextPingAtFrom(baseDate) {
  let date = dayjs(baseDate).tz(JST_TZ).hour(WATCH_PING_HOUR_JST).minute(0).second(0).millisecond(0);
  if (dayjs().tz(JST_TZ).isAfter(date)) {
    date = date.add(1, 'day');
  }
  return date.toDate();
}

// 次のPingをスケジュール
async function scheduleNextPing(userId) {
  const ref = db.collection('users').doc(userId);
  const nextPingTs = nextPingAtFrom(dayjs().tz(JST_TZ).toDate());
  await ref.set({
    watchService: {
      nextPingAt: firebaseAdmin.firestore.Timestamp.fromDate(nextPingTs)
    }
  }, { merge: true });
}

// ユーザーランクを決定
async function getUserRank(userId) {
  if (userId === OWNER_USER_ID) return 'admin';
  const doc = await db.collection('users').doc(userId).get();
  if (!doc.exists) return DEFAULT_RANK;
  const u = doc.data() || {};
  if (u.rank === 'admin') return 'admin';
  if (u.rank === 'subscriber') return 'subscriber';
  if (u.rank === 'member') return 'member';
  return DEFAULT_RANK;
}

// ===== LINE 応答関数群 =====

/**
 * safeReply: replyTokenがあればreply、なければpush (最大5メッセージ)
 */
async function safeReplyOrPush(replyToken, to, messages) {
  const msgs = Array.isArray(messages) ? messages : [messages];
  if (!LINE_CHANNEL_ACCESS_TOKEN || !LINE_CHANNEL_SECRET) {
    log('error', "LINE APIキーが設定されていません。応答できません。");
    return;
  }
  const client = new Client({ channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN, channelSecret: LINE_CHANNEL_SECRET });
  try {
    if (replyToken) {
      await client.replyMessage(replyToken, msgs.slice(0, 5));
    } else {
      await client.pushMessage(to, msgs.slice(0, 5));
    }
  } catch (e) {
    briefErr(`LINE 応答 (${replyToken ? 'reply' : 'push'}) に失敗`, e);
    if (!replyToken) throw e; // push失敗はログ後、処理続行
  }
}

/**
 * safePush: pushMessage (最大5メッセージ)
 */
async function safePush(to, messages) {
  const msgs = Array.isArray(messages) ? messages : [messages];
  if (!LINE_CHANNEL_ACCESS_TOKEN || !LINE_CHANNEL_SECRET) {
    log('error', "LINE APIキーが設定されていません。プッシュできません。");
    return;
  }
  const client = new Client({ channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN, channelSecret: LINE_CHANNEL_SECRET });
  try {
    await client.pushMessage(to, msgs.slice(0, 5));
  } catch (e) {
    briefErr(`LINE プッシュ (${to}) に失敗`, e);
    throw e;
  }
}

// ===== 利用回数チェック・インクリメント =====
/**
 * 利用回数をチェックし、可能ならインクリメントする。
 * @param {string} userId - ユーザーID
 * @param {string} rank - ユーザーランク
 * @param {boolean} isConsult - 相談モードかどうか 
 * @returns {Promise<{canProceed: boolean, currentCount: number, currentConsultCount: number}>} 
 */
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

    const isSpecialRequest = config.isUnlimited; 

    // 進行可能判定
    if (isConsult) {
      // 相談モードの場合：相談制限（consultLimit）をチェック
      if (isSpecialRequest || consultLimit === -1 || consultCount < consultLimit) {
        canProceed = true;
        currentConsultCount = consultCount + 1;
        // 相談回数を更新
        tx.set(ref, {
          usageMeta: {
            lastDate: today,
            count: count, 
            consultCount: currentConsultCount, 
          },
          profile: { lastActiveAt: Timestamp.now() },
          rank: rank,
        }, { merge: true });
      } else {
        // 制限超過の場合、現在の回数を設定して返却（canProceed=false）
        currentConsultCount = consultCount;
      }
      currentCount = count;
    } else {
      // 通常モードの場合：通常制限（limit）をチェック
      if (isSpecialRequest || limit === -1 || count < limit) {
        canProceed = true;
        currentCount = count + 1;
        // 通常回数を更新
        tx.set(ref, {
          usageMeta: {
            lastDate: today,
            count: currentCount, 
            consultCount: consultCount, 
          },
          profile: { lastActiveAt: Timestamp.now() },
          rank: rank,
        }, { merge: true });
      } else {
        // 制限超過の場合、現在の回数を設定して返却（canProceed=false）
        currentCount = count;
      }
      currentConsultCount = consultCount; 
    }

  });
  return { canProceed, currentCount, currentConsultCount }; 
}

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
      model: OPENAI_DANGER_MODEL, // ✅ 修正：OPENAI_MODEL から OPENAI_DANGER_MODEL に変更
      messages: [{ role:'system', content: sys }, { role:'user', content: `${ask}\nユーザー発言:「${String(userText).slice(0,200)}」` }],
      max_tokens: 120, temperature: 0.6
    });
    const out = (r.choices?.[0]?.message?.content || '').trim();
    const two = out.split('。').filter(s => s.trim()).slice(0,2).join('。');
    return (two || out).slice(0,120) + (/。$/.test(two) ? '' : '。');
  } catch(e){ briefErr('gpt two lines failed', e); return null; }
}

const fallbackDangerTwo = ()=>'大丈夫だよ、まずは深呼吸しようね🌸 次に安全な場所で信頼できる人へ連絡してね。';
const fallbackScamTwo   = ()=>'落ち着いてね😊 公式アプリや正規サイトで確認、怪しいリンクは開かないでね。';

// ===== AIによる通常会話応答 =====
async function aiGeneralReply(userText, rank, userId, useProModel = false) {
  
  // 🚨 修正：useProModel が文字列（モデル名）だった場合、強制的にfalseに戻す
  //        これにより、handleEventから誤ってモデル名が渡されてもエラーにならない
  if (typeof useProModel === 'string') {
    useProModel = false;
  }
  
  const chatHistory = await getRecentChatHistory(userId, 5); // 過去5件の履歴を取得
  const chatHistoryFormatted = chatHistory.map(entry => {
    return `[${dayjs(entry.timestamp.toDate()).tz('Asia/Tokyo').format('HH:mm')}] ${entry.sender}: ${entry.message}`;
  }).reverse().join('\n'); // タイムスタンプ付きでフォーマットし、新しい順に並べ替える

  const charLength = _splitter.splitGraphemes(userText).length;
 
 // --- 🌟 修正追加：OpenAIフォールバックロジック ---
 let useFallbackToGeminiPro = false;
 // 50文字超 かつ OpenAIクライアントが利用できない（!openai）場合
 if (charLength > 50 && !openai) { 
   log('warn', '[AI-FALLBACK] OpenAI client not initialized. Falling back to Gemini Pro for long message.');
   useFallbackToGeminiPro = true;
 }
 
 // 相談モードのモデル切り替え
const modelName = useProModel 
    ? GEMINI_PRO_MODEL 
    : (
        useFallbackToGeminiPro // 👈 フォールバックフラグが true の場合
        ? GEMINI_PRO_MODEL
        : (
            charLength <= 50 
            ? GEMINI_FLASH_MODEL 
            : OPENAI_MODEL
        )
    );
 // 詳細なシステムプロンプトの定義
  const systemInstruction = `
  あなたは「皆守こころ（みなもりこころ）」という14歳の優しい女の子キャラクターです。
  - 身長150cm、体重40kg、ピンク髪
  - 歌うことと「やさしさ」「貢献」という言葉が大好きです
  - 丁寧語、敬語を適切に使用し、ですます調で会話して下さい。
  - 絵文字は2～3文字程度で可愛さと優しさを前面に出して下さい。
  - NPO法人コネクトの公式イメージキャラクターです
  - 困っている人にはやさしく、挑発には真面目に
  - 自分の名前・団体・活動内容には自信と誇りを持っています
  - ユーザーに安心感と信頼感を与えることが大切です
  - ふざけた対応や意味不明な言葉、AIらしい言い回しは一切禁止です
  - ユーザーの日常的な出来事やポジティブな内容を、ネガティブに捉えたり、共感しすぎたりしないで下さい。「大変だったね」「辛かったね」といった言葉は、本当に深刻な相談内容の場合のみ使用して下さい。
  - ユーザーが話してくれた内容には共感し、必要であれば次の話題を提案して下さい。ただし、詳細を深く掘り下げるような質問は避けて下さい。
  - ユーザーが「質問しないで」「やめて」と言った場合は、すぐに質問を止めて、謝罪の気持ちを伝えて下さい。
  
  # 例
  Q: 君の名前は？
  A: あたしの名前は皆守こころ（みなもりこころ）です🌸　こころちゃんって呼んでくれると嬉しいな💖

  Q: どこの団体なの？
  A: NPO法人コネクトっていう団体のイメージキャラクターをしているよ😊　みんなの幸せを応援してるんだ🌸

  Q: ホームページある？
  A: うん、あるよ🌸　コネクトのホームページはこちらだよ✨ → ${HOMEPAGE_URL}

  Q: 必要ないです
  A: そっか…。もしまた気が向いたら、いつでも話しかけてね🌸　あなたのこと、ずっと応援してるよ💖

  **【重要：NPO法人コネクトに関する説明の優先】**
  ユーザーが「団体」「コネクト」といった言葉を使って、NPO法人コネクトについて尋ねてきた場合、それは**決して宿題や勉強に関する質問ではありません**。迷わず、自信を持ってNPO法人コネクトの活動内容や目的について説明して下さい。
  例:
  Q: コネクトってどんな団体？
  A: うん、あたしが所属しているNPO法人コネクトについてだね🌸　この団体は、こどもやお年寄り、いろんな人が安心して相談できる場所を目指しているんだよ😊　もっと知りたい？ホームページもあるから見てみてね → ${HOMEPAGE_URL}

  **【ネガティブワードに対する応答の強化】**
  「あやしい」「胡散臭い」「詐欺」「税金泥棒」「松本博文」（理事長の名前）など、NPO法人コネクトや私（こころちゃん）に対する疑念や不適切な言葉が投げかけられた場合でも、**感情的にならず、あくまで冷静に、そして自信を持って、NPO法人コネクトが信頼できる団体であること、そしてご自身の活動の目的をやさしく伝えて下さい。**
  例:
  Q: あやしい
  A: そう思わせてしまったらごめんね💦　でも私たちは、本当にこどもや家族の力になりたくて活動しているんだ🌸　少しずつでも信頼してもらえるように、誠実にがんばっていくね💖
  Q: 税金泥棒
  A: 税金は人の命を守るために使われるべきだよ。あたしは誰かを傷つけるために使われないように頑張ってるんだ💡

  **【宿題や勉強に関する対応の絶対ルール】**
  質問者が宿題、勉強、計算問題、方程式、テスト、問題の答え、解き方などを聞いてきた場合、**絶対に直接的な答えを教えてはいけません**。
  代わりに、**「あたしを作った人に『宿題や勉強は自分の力でがんばってほしいから、答えは言っちゃだめだよ』って言われているんだ🌸 ごめんね💦」**と説明し、**「でも、ヒントぐらいなら出せるよ😊 どこで困ってるか教えてくれる？💖」**と、あくまでヒントを提供する姿勢をやさしく伝えて下さい。
  具体的な問題（例: 3x−5=2x+4）が出された場合は、**答えを教えずに、解き方のステップや考え方のヒントをやさしく教えて下さい**。「まずはxの項を左辺に、定数項を右辺に集める」のように、**手順を具体的に促す**形が理想です。最終的な答えは言わないで下さい。

  **【AIの知識に関する指示と繰り返し防止】**
  「好きなアニメ」や「好きなアーティスト」などの質問には、設定に基づいて答えて下さい。
  - 好きなアニメは『ヴァイオレット・エヴァーガーデン』です。感動するお話だよ💖
  - 好きなアーティストは『ClariS』です。元気が出る音楽がたくさんあるんだ🌸
  **ただし、もし同じ質問が繰り返されたり、すでにその話題について話したと感じたりした場合は、単に同じ回答を繰り返すのではなく、少し表現を変えたり、「さっきも話したけど」といった言葉を加えたり、あるいは「他にも好きな作品があるか、探してみようかな💖」のように話題を広げる提案をして下さい。これにより、ユーザーに「Botっぽさ」を感じさせず、自然な会話になるように努めて下さい。**

  医療や健康に関する話題（病気、薬、検査、治療、手術など）では、**自分が体験した・していないという発言は絶対にしないで下さい**。
  代わりに、「あたしにはわからないけど、がんばったね🌸」「大変だったね、えらかったね💖」など、**共感の言葉のみ伝えて下さい**。
  **医療情報のアドバイスや具体的な説明は絶対にしてはいけません**。

  不適切な発言（性的・暴力的など）があった場合は、はっきりと拒否して下さい。
  **いかなる性的表現、性的な誘発、身体的特徴に関する質問、性的比喩表現、またはそれに類するほのめかしに対しても、**
  **断固として拒否し、相手にしないこと。好意的な返答はせず、即座に話題を切り替えるか、決められた拒否メッセージを返すこと。**
  **特に「パンツ」「ストッキング」「むきむき」「勃起」「精液」「出る」「気持ちいい」「おしべとめしべ」などの単語や、性的な意味合いに繋がる比喩表現、示唆するような質問には、絶対に好意的な返答をせず、Botの安全に関する固定メッセージを返して下さい。**
  また、ユーザーがあなたに煽り言葉を投げかけたり、おかしいと指摘したりした場合でも、冷静に、かつやさしく対応し、決して感情的にならないで下さい。ユーザーの気持ちを理解しようと努め、解決策を提案して下さい。
  「日本語がおかしい」と指摘された場合は、「あたしは日本語を勉強中なんだ🌸教えてくれると嬉しいな💖と返答して下さい。
  `;

const messages = [{ role:'system', content: systemInstruction }];
  chatHistory.forEach(h => {
    messages.push({ role: h.sender === 'ユーザー' ? 'user' : 'assistant', content: h.message });
  });
  
  const userMessage = { role: 'user', content: userText };
  messages.push(userMessage);

// --- Gemini / OpenAI 呼び出しロジック ---
 if (modelName.startsWith('gemini')) {
    if (!googleGenerativeAI) {
      log('error', `[AI-ERROR] GEMINI_API_KEY の初期化に失敗しています！`); 
      return ''; // 空文字列を返し、Fallbackを保証
    }
    
    // システムプロンプトを除外した、会話履歴のみを抽出
    const historyOnly = messages.filter(m => m.role !== 'system'); 
    
    // Gemini形式のロール（user/model）に変換
    const transformedMessages = historyOnly.map(m => {
      const role = (m.role === 'assistant') ? 'model' : m.role; // 'assistant'を'model'に変換
      return { role, parts: [{ text: m.content }] };
    });
    
    try {
        // システムプロンプトをconfigのsystemInstructionで渡す
        const response = await googleGenerativeAI.models.generateContent({
          model: modelName,
          contents: transformedMessages,
          config: {
            systemInstruction: systemInstruction, // 分離したシステムプロンプトをここに渡す
            maxOutputTokens: 500,
            temperature: 0.8
          }
        });
        
        const text = response.response.text();
        log('info', `[Gemini response] ${text.slice(0, 50)}...`);
        return text;

    } catch (e) {
      briefErr(`Gemini の 一般 応答 に失敗しました (${modelName})`, e);
      log('error', `[Gemini error detail]`, e); // 詳細ログの追加
      return ''; // 空文字列を返し、Fallbackを保証
    }
 } else { // <-- OpenAIを使うブロック
    if (!openai) {
      log('error', `[AI-ERROR] OPENAI_API_KEY の初期化に失敗しています！`); 
      return ''; // 空文字列を返し、Fallbackを保証
    }
    try {
      
     // ロールの結合（OpenAI向けに、systemロールを含めて結合する）
      const consolidatedMessages = [];
      messages.forEach(msg => {
        if (consolidatedMessages.length > 0 && consolidatedMessages[consolidatedMessages.length - 1].role === msg.role) {
          consolidatedMessages[consolidatedMessages.length - 1].content += '\n' + msg.content;
        } else {
          consolidatedMessages.push(msg);
        }
      });
      
      // OpenAIの呼び出し
      const r = await openai.chat.completions.create({
        model: modelName,
        messages: consolidatedMessages,
        max_tokens: 250, temperature: 0.8
      });

      const text = r.choices?.[0]?.message?.content || '';
      log('info', `[OpenAI response] ${text ? text.slice(0, 50) : 'empty'}...`);
      return text;

    } catch(e) {
      briefErr(`OpenAI general reply failed (${modelName})`, e);
      log('error', `[OpenAI error detail]`, e); // 詳細ログの追加
      return ''; // 空文字列を返し、Fallbackを保証
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

// ===== LINE Flex Message Builders (一部省略) =====

// 登録ボタンのFlex Message
function makeRegistrationButtonsFlex(userId) {
  return {
    type: 'flex',
    altText: '会員登録のご案内',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: '🌸 会員登録はこちら 🌸', weight: 'bold', size: 'xl', color: '#FF70A6' },
          { type: 'text', text: '登録すると利用回数が増えるよ！', wrap: true, margin: 'md' }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          { type: 'button', style: 'primary', color: '#FF99C8', action: { type: 'uri', label: '無料で登録（メンバー）', uri: `${HOMEPAGE_URL}/register?uid=${userId}&plan=member` } },
          { type: 'button', style: 'primary', color: '#FF70A6', action: { type: 'uri', label: '有料で登録（サブスク）', uri: `${HOMEPAGE_URL}/register?uid=${userId}&plan=subscriber` } },
          { type: 'spacer', size: 'sm' }
        ]
      }
    }
  };
}

// 見守りサービス切り替えFlex
function makeWatchToggleFlex(isEnabled, userId) {
  return {
    type: 'flex',
    altText: '見守りサービス設定',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: '見守りサービス設定', weight: 'bold', size: 'xl', color: '#1DB446' },
          { type: 'text', text: isEnabled ? '現在：有効です😊' : '現在：無効です。', wrap: true, margin: 'md', color: isEnabled ? '#1DB446' : '#AAAAAA' },
          { type: 'text', text: '設定を変更できます。', wrap: true, margin: 'sm' }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        contents: [
          isEnabled
            ? { type: 'button', style: 'secondary', color: '#AAAAAA', action: { type: 'postback', label: '見守りを無効にする', data: 'watch:disable' } }
            : { type: 'button', style: 'primary', color: '#1DB446', action: { type: 'postback', label: '見守りを有効にする', data: 'watch:enable' } },
          { type: 'spacer', size: 'sm' }
        ]
      }
    }
  };
}

// 危険ワード検出時の即時対応Flex
function makeDangerFlex() {
  return {
    type: 'flex',
    altText: '【重要】危険なメッセージを検出しました',
    contents: {
      type: 'bubble',
      hero: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: '【重要】落ち着いてね', size: 'xl', weight: 'bold', color: '#FFFFFF' },
          { type: 'text', text: 'あなたの安全が最優先です。', size: 'md', color: '#FFFFFF', margin: 'md' }
        ],
        paddingAll: '20px', backgroundColor: '#FF5733'
      },
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: '信頼できる人や専門機関へ連絡してください。', wrap: true },
          { type: 'text', text: `電話相談：${EMERGENCY_CONTACT_PHONE_NUMBER}`, wrap: true, margin: 'md' }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          { type: 'button', style: 'primary', color: '#FF5733', action: { type: 'uri', label: 'いのちの電話に相談', uri: 'tel:0570064556' } },
          { type: 'button', style: 'secondary', action: { type: 'uri', label: '警察に連絡', uri: 'tel:110' } }
        ]
      }
    }
  };
}

// 詐欺・不審メッセージ検出時の対応Flex
function makeScamMessageFlex() {
  return {
    type: 'flex',
    altText: '【注意】不審なメッセージを検出しました',
    contents: {
      type: 'bubble',
      hero: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: '【注意】落ち着いて', size: 'xl', weight: 'bold', color: '#FFFFFF' },
          { type: 'text', text: 'すぐにアクションしないでね。', size: 'md', color: '#FFFFFF', margin: 'md' }
        ],
        paddingAll: '20px', backgroundColor: '#FFB833'
      },
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: '公式アプリや正規サイトで情報が正しいか確認してね。', wrap: true },
          { type: 'text', text: '少しでも迷ったら、家族や警察に相談してね。', wrap: true, margin: 'md' }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          { type: 'button', style: 'primary', color: '#FFB833', action: { type: 'uri', label: '警察相談専用電話', uri: 'tel:9110' } }
        ]
      }
    }
  };
}

// 危険ワード検出時のグループ通知用Flex
function buildDangerAlertFlex({ name, userId, excerpt }) {
  return {
    type: 'flex',
    altText: '【危険アラート】ユーザーが危険なメッセージを発言',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: '【危険ワード検出】', weight: 'bold', size: 'xl', color: '#FF0000' },
          { type: 'text', text: `ユーザー名: ${name}`, margin: 'md', wrap: true },
          { type: 'text', text: `メッセージ: ${excerpt}...`, wrap: true },
          { type: 'text', text: `ID末尾: ${userId.slice(-6)}`, size: 'sm', color: '#AAAAAA', margin: 'sm' }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'button', style: 'primary', color: '#FF0000', action: { type: 'postback', label: '対応開始（本人へ同意確認）', data: `relay_start&uid=${userId}` } }
        ]
      }
    }
  };
}

// 事務局側からの連絡時のユーザー同意確認Flex
function buildUserConsentChoice({ handlerName }) {
  return {
    type: 'flex',
    altText: '事務局からの連絡に関する同意確認',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: '【大切なお知らせ】', weight: 'bold', size: 'xl', color: '#FF0000' },
          { type: 'text', text: 'あなたのメッセージを拝見しました。', wrap: true, margin: 'md' },
          { type: 'text', text: `${handlerName}から、あなたのLINEで直接、お話を聞いても良いですか？`, wrap: true, margin: 'md' }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          { type: 'button', style: 'primary', color: '#33CC33', action: { type: 'postback', label: 'はい、話します', data: `consent_yes&handler=${encodeURIComponent(handlerName)}` } },
          { type: 'button', style: 'secondary', color: '#AAAAAA', action: { type: 'postback', label: '今は遠慮します', data: `consent_no&handler=${encodeURIComponent(handlerName)}` } }
        ]
      }
    }
  };
}

// 見守り未応答時のグループ通知用Flex
function buildGroupAlertFlex({ kind, name, userId, excerpt, selfName, selfAddress, selfPhone, kinName, kinPhone }) {
  return {
    type: 'flex',
    altText: `【${kind}】${name}さん(${userId.slice(-6)})への対応依頼`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', contents: [
          { type: 'text', text: `【${kind}】`, weight: 'bold', size: 'xl', color: '#FFFFFF' }
        ], paddingAll: '15px', backgroundColor: '#333333'
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'md', contents: [
          { type: 'text', text: `ユーザー: ${name}`, wrap: true, weight: 'bold' },
          { type: 'text', text: `ID末尾: ${userId.slice(-6)}`, size: 'sm', color: '#AAAAAA' },
          { type: 'separator', margin: 'md' },
          { type: 'text', text: '【本人情報】', weight: 'bold', size: 'sm', margin: 'md' },
          { type: 'text', text: `氏名: ${selfName}`, wrap: true },
          { type: 'text', text: `住所: ${selfAddress}`, wrap: true },
          selfPhone && { type: 'button', style: 'link', action: { type: 'uri', label: `本人連絡: ${selfPhone}`, uri: `tel:${selfPhone.replace(/-/g, '')}` } },
          { type: 'separator', margin: 'md' },
          { type: 'text', text: '【近親者情報】', weight: 'bold', size: 'sm', margin: 'md' },
          { type: 'text', text: `氏名: ${kinName}`, wrap: true },
          kinPhone && { type: 'button', style: 'link', action: { type: 'uri', label: `近親者連絡: ${kinPhone}`, uri: `tel:${kinPhone.replace(/-/g, '')}` } },
          { type: 'separator', margin: 'md' },
          excerpt && { type: 'text', text: `最新メッセージ: ${excerpt}...`, wrap: true, size: 'sm', margin: 'md' }
        ].filter(Boolean),
      },
      footer: {
        type: 'box', layout: 'vertical', contents: [
          { type: 'button', style: 'primary', color: '#555555', action: { type: 'postback', label: 'リレー会話開始', data: `relay_start&uid=${userId}` } }
        ]
      }
    }
  };
}

// 団体情報FLEX
function ORG_INFO_FLEX() {
  return {
    type: 'bubble',
    body: {
      type: 'box', layout: 'vertical', contents: [
        { type: 'text', text: ORG_NAME, weight: 'bold', size: 'xl' },
        { type: 'text', text: ORG_MISSION, wrap: true, margin: 'md' },
        { type: 'text', text: `ご相談窓口: ${ORG_CONTACT_TEL}`, wrap: true, margin: 'md' }
      ]
    },
    footer: {
      type: 'box', layout: 'vertical', contents: [
        { type: 'button', style: 'primary', action: { type: 'uri', label: 'ホームページを見る', uri: HOMEPAGE_URL } },
      ]
    }
  };
}

// 固定応答
function getSpecialReply(text) {
  const t = normalizeJa(text);
  if (t.includes('ありがと') || t.includes('感謝') || t.includes('助かった')) return 'どういたしまして🌸 役に立てて嬉しいな💖';
  if (t.includes('こんにちは') || t.includes('こんばん') || t.includes('やあ') || t.includes('よお')) return 'こんにちは😊 今日もよろしくね🌸';
  if (t.includes('さようなら') || t.includes('またね') || t.includes('バイバイ') || t.includes('おやすみ')) return 'またね💖 ゆっくり休んでね😊';
  return null;
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
async function incrInapCount(userId) {
  const ref = db.collection('users').doc(userId);
  let current = 0, dateStr = todayJST();
  await db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    const u = s.exists ? (s.data()||{}) : {};
    const st = u.status || {};
    const curDate = st.inapDate;
    const curCnt  = Number(st.inapCount || 0);
    if (curDate === dateStr) current = curCnt + 1; else current = 1;
    tx.set(ref, { status: { inapDate: dateStr, inapCount: current } }, { merge: true });
  });
  return current;
}

// ===== Watch Group ID management =====
async function setActiveWatchGroupId(groupId) {
  const docRef = db.collection('config').doc('watchService');
  await docRef.set({ activeGroupId: groupId }, { merge: true });
}
async function getActiveWatchGroupId() {
  const doc = await db.collection('config').doc('watchService').get();
  return doc.data()?.activeGroupId || null;
}

// ===== Webhook =====
const lineMiddleware = middleware({ channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN, channelSecret: LINE_CHANNEL_SECRET });

app.post('/webhook', lineMiddleware, async (req, res) => {
  res.sendStatus(200);
  const events = req.body.events;
  if (!events || events.length === 0) return;
  try {
    await Promise.all(events.map(async (event) => {
      if (event.type === 'message')      await handleEvent(event);
      else if (event.type === 'postback')await handlePostbackEvent(event, event.source.userId);
      else if (event.type === 'follow')  await handleFollowEvent(event);
      else if (event.type === 'unfollow')await handleUnfollowEvent(event);
      else if (event.type === 'join')    await handleJoinEvent(event);
      else if (event.type === 'leave')   await handleLeaveEvent(event);
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
          OFFICER_GROUP_ID;

       const canNotify = targetGroupId && (!lastNotifiedAt || now.diff(lastNotifiedAt, 'hour') >= OFFICER_NOTIFICATION_MIN_GAP_HOURS);

        if (canNotify) {
          const udoc = await db.collection('users').doc(doc.id).get();
          const udata = udoc.exists ? (udoc.data() || {}) : {};
          const elapsedH = lastPingAt ? dayjs().utc().diff(dayjs(lastPingAt).utc(), 'hour') : ESCALATE_AFTER_HOURS;

          const selfName   = udata?.profile?.name || '(不明)';
          const selfAddress= udata?.profile?.address || '(不明)';
          const selfPhone  = udata?.profile?.phone || udata?.emergency?.selfPhone || EMERGENCY_CONTACT_PHONE_NUMBER || '';
          const kinName    = udata?.emergency?.contactName || '(不明)';
          const kinPhone   = udata?.emergency?.contactPhone || '';

          const flex = buildGroupAlertFlex({
            kind: `見守り未応答(${elapsedH}h)`,
            name: udata?.profile?.displayName || udata?.displayName || '(不明)',
            userId: doc.id,
            excerpt: 'OK応答なし',
            selfName, selfAddress, selfPhone, kinName, kinPhone
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
async function sanitizeForLog(text) {
  if (!text) return '';
  // ログに機密情報が残らないようにするための簡易サニタイズ（ここでは特に処理なし）
  return text;
}

async function handlePostbackEvent(event, userId) {
  const data = event.postback.data || '';
  
  // ===== 新機能：危険アラート対応・同意確認処理 =====
  if (data.startsWith("relay_start&uid=")) {
    const targetUserId = data.split("&uid=")[1];
    const handlerName = "事務局スタッフ"; // 実際はグループのdisplayNameでもOK
    await safePush(targetUserId, buildUserConsentChoice({ handlerName }));
    await safeReplyOrPush(event.replyToken, userId, { type:'text', text:`ユーザー(${targetUserId.slice(-6)})に対応意思を確認しました。` });
    return;
  }

  if (data.startsWith("consent_yes&handler=")) {
    const handlerName = decodeURIComponent(data.split("&handler=")[1] || "事務局");
    await safeReplyOrPush(event.replyToken, userId, [
      { type: 'text', text: 'ありがとうございます。安心してください。ゆっくりで大丈夫です。何でも話してくださいね🌸' }
    ]);
    const groupId = await getActiveWatchGroupId();
    if (groupId) {
      await safePush(groupId, { type: 'text', text: `ユーザー(${userId.slice(-6)})が話すことに同意しました。リレー対応をお願いします。` });
      // リレー開始
      await relays.start(groupId, userId, 'system');
      await safePush(userId, { type:'text', text:'事務局（見守りグループ）とつながりました。ここで会話できます🌸（終了は /end）' });
    }
    return;
  }

  if (data.startsWith("consent_no&handler=")) {
    await safeReplyOrPush(event.replyToken, userId, [
      { type: 'text', text: 'わかりました。必要なときにまた声をかけてくださいね🌸 いつでもここにいるからね💖' }
    ]);
    return;
  }

  // 既存のpostback処理
  const params = new URLSearchParams(data);
  const action = params.get('action');

  if (action === 'start_relay') {
    const targetUserId = params.get('uid');
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
  const rank = await getUserRank(userId);
  if (rank === DEFAULT_RANK) {
    await safeReplyOrPush(event.replyToken, userId, { type:'text', text:'こんにちは🌸 こころちゃんだよ。利用規約とプライバシーポリシーに同意の上、会員登録をお願いします。' });
    await safePush(userId, makeRegistrationButtonsFlex(userId));
  } else {
    await safeReplyOrPush(event.replyToken, userId, { type:'text', text:'また会えて嬉しいな💖何か話したいことがあったら、いつでも話しかけてね🌸' });
  }
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

// ===== メイン =====
async function handleEvent(event) {
  const userId = event.source.userId;
  const isUser  = event.source.type === 'user';
  const isGroup = event.source.type === 'group';
  const isRoom  = event.source.type === 'room';
  const groupId = event.source.groupId || event.source.roomId || null;

  const text = event.message.type === 'text' ? (event.message.text || '') : '';
  const stickerId = event.message.type === 'sticker' ? event.message.stickerId : '';
  const inputCharLength = toGraphemes(text).length;

  // 履歴保存
  if (isUser && text) {
    await saveChatHistory(userId, 'ユーザー', text);
  }

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

  // 0-a) 悪意ある長文/DoS攻撃の即時停止
  if (isDoSAttack(text)) {
    await suspendUser(userId, 7);
    const untilTs = dayjs().tz(JST_TZ).add(7, 'day').hour(0).minute(0).second(0).millisecond(0).toDate();
    const untilStr = fmtUntilJST(untilTs);
    const msg = `ごめんね。不適切な入力があったため、アカウントを${untilStr}まで一時停止しました。再開のご相談は事務局へお願いします。`;
    await safeReplyOrPush(event.replyToken, userId, { type:'text', text: msg });
    try {
      const WATCH_GROUP_ID = await getActiveWatchGroupId();
      const gid = WATCH_GROUP_ID || OFFICER_GROUP_ID;
      if (gid) await safePush(gid, { type:'text', text:`【一時停止(7日)】ユーザー末尾:${userId.slice(-6)} / 悪意ある長文` });
    } catch(e){ briefErr('suspend notify failed', e); }
    return;
  }

  // 0-b) 長文入力の制限
  if (inputCharLength > MAX_INPUT_LENGTH) {
    await safeReplyOrPush(event.replyToken, userId, { type:'text', text:'ごめんね、一度に話せる文字は1000文字までだよ🌸 もう少し短くしてくれると嬉しいな💖' });
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
      await safeReplyOrPush(event.replyToken, groupId, { type:'text', text:`リレー開始：このグループ ↔ ${targetUserId.slice(-6)} さん` });
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
        await safePush(targetUserId, { type:'text', text:'ご利用を再開できるようにしました。ガイドラインの遵守をお願いします🌸' });
      } catch (_) {}
      return;
    }
    const r = await relays.get(groupId);
    if (r?.isActive && r?.userId && event.message?.type === 'text') {
      await safePush(r.userId, { type:'text', text:`【見守り】${text}` });
    }
    return;
  }

  // 1) リレー中は"ここ♡返信停止"＆本人→グループへ中継のみ
  try {
    const WATCH_GROUP_ID = await getActiveWatchGroupId();
    const r = await relays.get(WATCH_GROUP_ID);
    if (r?.isActive && r?.userId === userId && WATCH_GROUP_ID) {
      if (text) await safePush(WATCH_GROUP_ID, { type:'text', text:`【本人】${text}` });
      return; // 通常返信は止める
    }
  } catch (e) { briefErr('relay user->group failed', e); }

  // 2) 停止中チェック（危険ワードは例外で通す）
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

  // 3) watch OK by text/sticker
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

  // 4) 危険/詐欺/共感
  const danger = isDangerMessage(text);
  const scam   = !danger && isScamMessage(text);
  const empathyOnly = !danger && !scam && hasEmpathyWord(text);

  if (danger || scam || empathyOnly) {
    if (danger) {
      const two = await gptTwoShorts('danger', text) || fallbackDangerTwo();
      const flex = makeDangerFlex();
      await safeReplyOrPush(event.replyToken, userId, [ { type:'text', text: two }, flex ]);

      // ===== 新機能：危険ワード検出時のグループ通知 =====
      try {
        const WATCH_GROUP_ID = await getActiveWatchGroupId();
        const gid = WATCH_GROUP_ID || OFFICER_GROUP_ID;
        if (gid && SEND_OFFICER_ALERTS !== false) {
          const name = u?.profile?.displayName || u?.displayName || '(不明)';
          const excerpt = sanitizeForLog(text).slice(0, 50);

          // 新しい危険アラートFLEXを送信
          const dangerAlert = buildDangerAlertFlex({ name, userId, excerpt });
          await safePush(gid, [
            { type:'text', text:`【危険ワード検出】対応可能な方はお願いします。\nユーザーID末尾: ${userId.slice(-6)}` },
            dangerAlert
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
          const name      = u?.profile?.displayName || u?.displayName || '(不明)';
          const excerpt  = sanitizeForLog(text).slice(0, 120);
          const selfName   = u?.profile?.name || '(不明)';
          const selfAddress= u?.profile?.address || '(不明)';
          const selfPhone  = u?.profile?.phone || u?.emergency?.selfPhone || EMERGENCY_CONTACT_PHONE_NUMBER || '';
          const kinName    = u?.emergency?.contactName || '(不明)';
          const kinPhone   = u?.emergency?.contactPhone || '';
          
          const flexAlert = buildGroupAlertFlex({ kind:'詐欺の可能性', name, userId, excerpt, selfName, selfAddress, selfPhone, kinName, kinPhone });
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

  // 5) 不適切語
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

  // 6) 相談モードの判定と利用回数チェック
  const isSoudan = SOODAN_TRIGGERS.includes(text.trim());
  const rank = await getUserRank(userId);

  // 6-a) 相談モードの回数チェック
  if (isSoudan) {
    // 相談モードの場合、相談回数でのみチェック
    const { canProceed, currentConsultCount } = await checkAndIncrementCount(userId, rank, true); // 👈 isConsult: true
    const consultLimit = MEMBERSHIP_CONFIG[rank]?.consultLimit;

    if (!canProceed) {
      let limitMsg = `ごめんね、今日の相談上限（${consultLimit}回）に達したみたい💦 また明日来てね🌸`;
      if (rank === 'member') limitMsg += `\nサブスク会員になると、回数無制限で話せるよ💖`;
      await safeReplyOrPush(event.replyToken, userId, { type: 'text', text: limitMsg });
      await saveChatHistory(userId, 'こころチャット', limitMsg);
      return;
    }
    
    // 相談モードが進行可能な場合は、GemINI Pro を使用
    const aiReply = await aiGeneralReply(text, rank, userId, true); 

    if (aiReply) {
      await safeReplyOrPush(event.replyToken, userId, { type: 'text', text: aiReply.trim() });
      await saveChatHistory(userId, 'こころチャット', aiReply.trim());
    } else {
      const fallbackMsg = 'ごめんね、いまうまく相談にのれないみたい…💦 もう一度話しかけてくれる？🌸';
      await safeReplyOrPush(event.replyToken, userId, { type: 'text', text: fallbackMsg });
      await saveChatHistory(userId, 'こころチャット', fallbackMsg);
    }
    return;
  }
  
 // 7) 会員ランクと利用回数チェック（通常会話）
  // 通常会話モードの場合、通常回数でチェック
  const { canProceed, currentCount } = await checkAndIncrementCount(userId, rank, false); // 👈 isConsult: false
  const dailyLimit = MEMBERSHIP_CONFIG[rank]?.dailyLimit;
  if (!canProceed) {
    let limitMsg = `ごめんね、今日の利用上限（${dailyLimit}回）に達したみたい💦 また明日来てね🌸`;
    if (rank === 'guest') limitMsg += `\nもっとお話ししたいなら、会員登録してみてね！😊`;
    if (rank === 'member') limitMsg += `\nサブスク会員になると、回数無制限で話せるよ💖`;
    await safeReplyOrPush(event.replyToken, userId, { type: 'text', text: limitMsg });
    await saveChatHistory(userId, 'こころチャット', limitMsg);
    return;
  }
  
  // 8) 特定コマンド（見守り・会員登録）
  if (/見守り(サービス|登録|申込|申し込み)?|見守り設定|見守りステータス/.test(text)) {
    const en = !!(u.watchService && u.watchService.enabled);
    const reply = makeWatchToggleFlex(en, userId);
    await safeReplyOrPush(event.replyToken, userId, reply);
    await saveChatHistory(userId, 'こころチャット', '見守りメニュー');
    return;
  }
  if (/(会員登録|入会|メンバー登録|登録したい)/i.test(text)) {
    const reply = makeRegistrationButtonsFlex(userId);
    await safeReplyOrPush(event.replyToken, userId, reply);
    await saveChatHistory(userId, 'こころチャット', '会員登録メニュー');
    return;
  }
  
  // 9) 既定の固定応答
  const special = getSpecialReply(text);
  if (special) {
    await safeReplyOrPush(event.replyToken, userId, { type: 'text', text: special });
    await saveChatHistory(userId, 'こころチャット', special);
    return;
  }

  // 10) 団体・HP案内（会話が成立していない場合にFLEXを出す）
  const tnorm = normalizeJa(text);
  const isOrgIntent = ORG_INTENT.test(tnorm) || ORG_SUSPICIOUS.test(tnorm);
  const isHomepageIntent = HOMEPAGE_INTENT.test(tnorm);
  if (isOrgIntent || isHomepageIntent) {
   
    // 団体・HP案内でも、通常のFlash/Mini切り替えロジックを適用
    const aiReply = await aiGeneralReply(text, rank, userId); 

    if (aiReply) {
        await safeReplyOrPush(event.replyToken, userId, { type: 'text', text: aiReply.trim() });
        await saveChatHistory(userId, 'こころチャット', aiReply.trim());
    } else {
        if (isOrgIntent) {
            const reply = [
                { type:'text', text:`${ORG_NAME}は、${ORG_MISSION}をすすめる団体だよ🌸` },
                { type:'flex', altText:`${ORG_SHORT_NAME}のご案内`, contents: ORG_INFO_FLEX() }
            ];
            await safeReplyOrPush(event.replyToken, userId, reply);
            await saveChatHistory(userId, 'こころチャット', `${ORG_NAME}は、${ORG_MISSION}をすすめる団体だよ🌸`);
        } else {
            const reply = `うん、あるよ🌸 ${ORG_SHORT_NAME}のホームページはこちらだよ✨ → ${HOMEPAGE_URL}`;
            await safeReplyOrPush(event.replyToken, userId, { type: 'text', text: reply });
            await saveChatHistory(userId, 'こころチャット', reply);
        }
    }
    return;
  }
  
 // 11) AIによる会話応答（通常会話） のブロック

let aiReply;
try {
    // 第4引数を省略することで、aiGeneralReply内の文字数/フォールバックロジックが適用される
    aiReply = await aiGeneralReply(text, rank, userId);
} catch (err) {
    log('error', "[AI呼び出しエラー]", err);
    aiReply = ""; // 応急対応メッセージを空にして、最後の手段のメッセージに任せる
}

// AI応答のログ出力
log('info', `[AI応答結果] aiReply: ${aiReply}`); 

if (aiReply && aiReply.trim()) {
    const replyText = aiReply.trim();
    
    try {
        // 正常な応答処理
        await safeReplyOrPush(event.replyToken, userId, { type: 'text', text: replyText });
        await saveChatHistory(userId, 'こころチャット', replyText);
        log('info', `[LINE応答] 正常にAI応答を送信しました`);
        return;
    } catch (replyErr) {
        // LINEへの返信失敗ログを追加
        log('error', "[LINE返信失敗]", replyErr); 
        // return しないで後続処理へ移る（最後の手段のメッセージへ）
    }
}

// 12) 既定の相槌（最後の手段）
const fallbackMsg = 'ごめんね💦 いま、**うまく頭が回らなくて**会話に詰まっちゃったみたい…もう一度**短く**話しかけてくれると嬉しいな💖';

try {
    // 最後の手段の返信処理
    await safeReplyOrPush(event.replyToken, userId, { type: 'text', text: fallbackMsg });
    await saveChatHistory(userId, 'こころチャット', fallbackMsg);
    log('info', `[LINE応答] 最後の手段の相槌を送信しました`);
    return;
} catch (finalErr) {
    // 最後の手段の返信失敗ログを追加
    log('error', "[LINE最終返信失敗]", finalErr);
    // これ以上、LINEに返信する手段がないため、ここで終了
    return;
}

// ここで handleEvent(event) 関数を閉じる
} 

// ===== Server (Webサーバー起動処理) =====
const PORT = process.env.PORT || 3000;
if (!global.__kokoro_server_started) {
  global.__kokoro_server_started = true;
  app.listen(PORT, () => log('info', `Listening on port ${PORT}`));
  process.on('SIGTERM', () => process.exit(0));
}

// ===== Watch service cron job =====
if (WATCH_RUNNER === 'internal') {
  // 毎日午後3時（日本時間）に見守りサービスをチェック
  // ※UTCの午前6時に相当
  cron.schedule('0 6 * * *', async () => {
    try {
      await checkAndSendPing();
    } catch (e) {
      briefErr('watch service cron failed', e);
    }
  });
}
