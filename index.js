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
 - 「相談」または「そうだん」とだけ入力された場合、回数制限を無視しGemini 2.5 Proで1回だけ応答
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
dayjs.extend(utc);
dayjs.extend(timezone);
const { Client, middleware } = require('@line/bot-sdk');

// Openai SDKはインポート済みと仮定 (package.jsonで対応)
let OpenAI;
try { OpenAI = require('openai').OpenAI; } catch (e) { /* silent */ }


// ===== Logging =====
const LV = { error: 0, warn: 1, info: 2, debug: 3 };
const WATCH_LOG_LEVEL = (process.env.WATCH_LOG_LEVEL || 'info').toLowerCase();
const LV_ALLOW = LV[WATCH_LOG_LEVEL] ?? LV.info;
const log = (lvl, ...args) => { if ((LV[lvl] ?? LV.debug) <= LV_ALLOW) console.log(`[${lvl.toUpperCase()}]`, ...args); };
const audit = (e, detail) => log('info', `[AUDIT] ${e}`, JSON.stringify(detail));
const briefErr = (msg, e) => {
  const detail = e?.originalError?.response?.data || e?.response?.data || e?.message || (e instanceof Error ? e.stack : JSON.stringify(e));
  console.error(`[ERR] ${msg}:`, typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2));
};

// ----------------------------------------------------
// ✨ 🔴 Firebase Admin SDK 初期化（Base64のサービスアカウントJSONを使用） 🔴 ✨
// ----------------------------------------------------
if (firebaseAdmin.apps.length === 0) {
  try {
    const base64Credentials = process.env.FIREBASE_CREDENTIALS_BASE64;
    if (!base64Credentials) {
      console.error('[FATAL] 環境変数 FIREBASE_CREDENTIALS_BASE64 が設定されていません。');
      process.exit(1);
    }
    const jsonString = Buffer.from(base64Credentials, 'base64').toString('utf8');
    const serviceAccount = JSON.parse(jsonString);
    firebaseAdmin.initializeApp({
      credential: firebaseAdmin.credential.cert(serviceAccount),
    });
    console.log('✅ Firebase Admin SDK が正常に初期化されました');
  } catch (e) {
    briefErr('[FATAL] Firebase Admin SDK の初期化に失敗しました', e);
    process.exit(1);
  }
}

// ----------------------------------------------------
// 設定値・定数
// ----------------------------------------------------

// 環境変数からの設定
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OWNER_USER_ID = process.env.OWNER_USER_ID;
const OFFICER_GROUP_ID = process.env.OFFICER_GROUP_ID; // 役員向けグループID
const EMERGENCY_CONTACT_PHONE_NUMBER = process.env.EMERGENCY_CONTACT_PHONE_NUMBER || '0570-064-556'; // いのちの電話
const ORG_NAME = process.env.ORG_NAME || 'NPO法人コネクト';
const ORG_SHORT_NAME = process.env.ORG_SHORT_NAME || 'コネクト';
const ORG_MISSION = process.env.ORG_MISSION || 'こどもや家族を支援する';
const HOMEPAGE_URL = process.env.HOMEPAGE_URL || 'https://connect-npo.org';
const ORG_CONTACT_TEL = process.env.ORG_CONTACT_TEL || '03-xxxx-xxxx';

// モデル名
const GEMINI_FLASH_MODEL = 'gemini-2.5-flash';
const GEMINI_PRO_MODEL   = 'gemini-2.5-pro';
const OPENAI_MODEL       = 'gpt-4o-mini';
const OPENAI_DANGER_MODEL= 'gpt-4o'; // 危険・詐欺は信頼度優先

// 制限値
const MAX_INPUT_LENGTH = 1000;      // 最大入力文字数 (DoS対策)
const MIN_DANGER_WORD_LENGTH = 3;   // 危険ワード判定の最小文字数

// 見守りサービス設定
const JST_TZ = 'Asia/Tokyo';
const WATCH_PING_HOUR_JST = 15;     // 見守りPing時刻 (JST 15:00)
const REMINDER_AFTER_HOURS = 24;    // Ping後、リマインドまで
const ESCALATE_AFTER_HOURS = 48;    // Ping後、エスカレーションまで
const OFFICER_NOTIFICATION_MIN_GAP_HOURS = 6; // 役員通知の最小間隔
const WATCH_RUNNER = process.env.WATCH_RUNNER || 'internal';
const SCAM_ALERT_TO_WATCH_GROUP = (process.env.SCAM_ALERT_TO_WATCH_GROUP || 'true').toLowerCase() === 'true';
const SEND_OFFICER_ALERTS = (process.env.SEND_OFFICER_ALERTS || 'true').toLowerCase() === 'true';

// 会員ランクと利用制限設定
// (dailyLimit: -1 で無制限, consultLimit: -1 で無制限)
const DEFAULT_RANK = 'guest';
const MEMBERSHIP_CONFIG = {
  guest:    { dailyLimit: 5,  consultLimit: 1, isUnlimited: false }, // ゲスト: 5回
  member:   { dailyLimit: 20, consultLimit: 3, isUnlimited: false }, // メンバー: 20回
  subscriber:  { dailyLimit: -1, consultLimit: -1, isUnlimited: true }, // サブスク会員
  admin:       { dailyLimit: -1, consultLimit: -1, isUnlimited: true }, // 運営者
};

// 🔴 ここで1回だけ宣言
const SOODAN_TRIGGERS = ['そうだん', '相談'];

// ===== 判定 =====
const EMPATHY_WORDS = [ 
    '死にそう', '辛い', 'つらい', 'しんどい', 'だるい', '寂しい', '不安', 
    '苦しい','助けて','たすけて','もう無理','もういやだ','モラハラ'
];
const DANGER_WORDS = [
    'しにたい','死にたい','自殺','消えたい','リスカ','リストカット','od','オーバードーズ','殴られる','暴力','dv',
    '虐待','パワハラ','セクハラ','ハラスメント','いじめ','イジメ','嫌がらせ','ストーカー','盗撮','盗聴',
    '苦しい','助けて','たすけて','もう無理','もういやだ','モラハラ',
    '殺す', '殺害', '首吊り', '爆弾', 'テロ', '攻撃', '襲う', 'ばか', 'あほ', 'くず', 'きもい', 'うざい', 'ガイジ', '統失', '害虫', '逮捕', '違法', '犯罪', '監禁'
];
const SCAM_CORE_WORDS = [
    '詐欺','さぎ','サギ','フィッシング','架空請求','ワンクリック詐欺','当選','高額当選',
    '暗号資産','投資','未払い','滞納','訴訟','裁判','副業','mlm','マルチ商法','ログイン','認証','本人確認',
    'オレオレ', '還付金', '振り込め', '口座番号', '暗証番号', 'キャッシュカード', 'お金が必要', '今日中',
    '取りに行く', '封筒に入れて', '簡単に儲かる', '絶対稼げる', '確実に稼げる', '未公開株', '融資', '給付金'
];
const BRANDS = /(amazon|アマゾン|楽天|rakuten|ヤマト|佐川|日本郵便|ゆうちょ|メルカリ|ヤフオク|apple|アップル|google|ドコモ|docomo|au|softbank|ソフトバンク|paypay|line|ライン|ntt)/i;
const BRAND_OK_CONTEXT = /(で(買い物|注文|購入|支払い|返品|返金|届いた|配送|発送|受け取った)|プライム|タイムセール|レビュー|ギフト券|ポイント|登録|パスワード|問い合わせ|アプリ|利用規約)/i;

// 不適切語（NGワード）
const INAPPROPRIATE_WORDS = [
    "セックス","セフレ","エッチ","AV","アダルト","ポルノ","童貞","処女","挿入","射精","勃起","パイズリ","フェラチオ","クンニ","オナニー","マスターベーション",
    "ペニス","ちんこ","ヴァギナ","マンコ","クリトリス","乳首","おっぱい","お尻","うんち","おしっこ","小便","大便","ちんちん","おまんこ","ぶっかけ","変態",
    "性奴隷","露出","痴漢","レイプ","強姦","売春","買春","セックスフレンド","風俗","ソープ","デリヘル","援交","援助交際","性病","梅毒","エイズ","クラミジア","淋病","性器ヘルペス",
    "ロリコン","ショタコン","近親相姦","獣姦","ネクロフィリア","カニバリズム","拷問","虐待死","レイプ殺人","大量殺人","テロ","戦争","核兵器","銃","ナイフ","刃物","武器","爆弾",
    "暴力団","ヤクザ","マフィア","テロリスト","犯罪者","殺人鬼","性犯罪者","変質者","異常者","狂人","サイコパス","ソシオパス","ストーカー","不審者","危険人物",
    "ブラック企業","パワハラ上司","モラハラ夫","毒親","モンスターペアレント","カスハラ","カスタマーハラスメント","クレーム","炎上","誹謗中傷","秘密","暴露","晒す","裏切り","騙し","偽り","欺く","悪意","敵意","憎悪","嫉妬","復讐","ぱふぱふ","せんずり","センズリ"
];

// 共感トリガー等
const ORG_INTENT = /(コネクト|団体|NPO法人|事務所|活動|目的|理念|理事長)/;
const ORG_SUSPICIOUS = /(あやしい|胡散臭い|詐欺|税金泥棒|松本博文)/;
const HOMEPAGE_INTENT = /(ホームページ|HP|URL|サイト|ウェブ)/;

// 見守りメッセージ候補
const WATCH_MSGS = [
  '元気にしてるかな？🌸', '体調崩してない？😊', '少し心配になっちゃったよ💖', 'なにか話したいことない？✨', '息抜きできてるかな？😊'
];
const pickWatchMsg = () => WATCH_MSGS[Math.floor(Math.random() * WATCH_MSGS.length)];

// --- 🧑‍💻 ユーザー管理・履歴 (スタブ化) ---
async function checkAndRecordNotificationTime(userId, type) { /* ... 実際のロジック ... */ return true; }
async function checkAndIncrementCount(userId) { /* ... 実際のロジック ... */ return { isCountOver: false, rank: 'subscriber' }; }
async function getConversationHistory(userId) { /* ... 実際のロジック ... */ return []; }
async function saveConversation(userId, userText, modelText) { /* ... 実際のロジック ... */ }


// --- 🤖 AI応答ロジック ---

async function aiGeneralReply(userId, userText, context, modelOverride = null) {
    if (!ai && !openai) return "ごめんね、いまAIの調子が悪いみたい…少し待ってね。";
    
    const history = await getConversationHistory(userId);
    let targetModel = modelOverride || (userText.length < 50 ? GEMINI_FLASH_MODEL : OPENAI_MODEL);

    const systemInstruction = `あなたは「こころチャット」という名前のAIです。
    ... (ペルソナ設定) ...
    現在のユーザーとの会話履歴と、以下の特別なコンテキストを考慮して応答してください: ${context}`;

    const contents = [ ...history, { role: 'user', parts: [{ text: userText }] } ];
    
    try {
        let replyText = '';
        if (targetModel.startsWith('gemini')) {
            const model = ai.getGenerativeModel({ model: targetModel, config: { systemInstruction: systemInstruction, safetySettings: [/* ... */] } });
            // 💡 修正適用箇所: Gemini呼び出しの引数を配列でラップ
            const response = await model.generateContent(contents);
            replyText = response.text.trim();
        } else if (openai) {
            // ... (OpenAIの呼び出しロジック - 元のコードに合わせてください) ...
            replyText = "AI応答 (GPT) のスタブです。";
        }

        if (!replyText) throw new Error("AI returned empty response.");
        await saveConversation(userId, userText, replyText);
        return replyText;

    } catch (error) {
        briefErr(`AI reply failed (${targetModel})`, error);
        // 修正: 適切なエラー応答
        return "ごめんね💦 いま、**うまく頭が回らなくて**会話に詰まっちゃったみたい…もう一度**短く**話しかけてくれると嬉しいな💖";
    }
}

// 危険・詐欺応答専用のAI関数 (スタブ化)
async function aiDangerReply(userText, context) { return "今のメッセージは、ちょっと心配になっちゃったよ...😥 大丈夫？"; }
async function aiScamReply(userText, context) { return "あのね、**とても怪しいメッセージ**だと感じたよ！🚨 その情報、**絶対に誰にも教えちゃダメ**だよ！"; }

// --- FLEXメッセージ生成（全てスタブ化） ---
function createOneCushionFlex() { return { type: 'text', text: 'ワンクッションFLEX (スタブ)' }; }
function createDangerNotificationFlex(userId, userText, context) { return { type: 'text', text: '危険通知FLEX (スタブ)' }; }
function createScamNotificationFlex(userId, userText, context) { return { type: 'text', text: '詐欺通知FLEX (スタブ)' }; }

// --- 🚨 危険検出と通知 ---

/**
 * 特定のメッセージを外部（見守りグループなど）に通知
 */
async function notifyExternal(userId, userText, type, context) {
    // 🔔 修正適用箇所: 通知先IDをWATCH_GROUP_IDに固定 (理事会への誤通知を解消)
    const notifyTargetId = WATCH_GROUP_ID; 

    const canSendAlert = await checkAndRecordNotificationTime(userId, type);
    let notificationMessage;
    let userReplyText = "ごめんね、何かあったみたいだけど、私はいつもあなたの味方だよ！💖";
    
    switch (type) {
        case 'DANGER':
            notificationMessage = createDangerNotificationFlex(userId, userText, context);
            userReplyText = await aiDangerReply(userText, context);
            break;

        case 'SCAM':
            notificationMessage = createScamNotificationFlex(userId, userText, context);
            userReplyText = await aiScamReply(userText, context);
            break;
            
        case 'EMPATHY':
            userReplyText = "なんだか、とても辛そうな気持ちが伝わってきたよ😢 ギュッと抱きしめるね。";
            break;
            
        case 'INAPPROPRIATE':
            userReplyText = "ごめんなさい、その言葉はちょっと不適切かもしれないな...💦 別の優しい言葉で話してほしいな💖";
            break;
    }

    // 実際の通知実行
    if (notifyTargetId && canSendAlert && SEND_OFFICER_ALERTS && notificationMessage && (type === 'DANGER' || type === 'SCAM')) {
        try {
            await client.pushMessage(notifyTargetId, notificationMessage);
            log('info', `[NOTIFY] Pushed ${type} alert to WATCH_GROUP_ID: ${notifyTargetId}`);
        } catch (e) {
            briefErr(`[ERR] Push to WATCH_GROUP_ID failed (${type})`, e);
        }
    }

    return userReplyText;
}


// --- 🌐 LINE Webhook ハンドラ ---

async function handleEvent(event) {
    if (event.type !== 'message' || event.message.type !== 'text') return;
    
    const userId = event.source.userId;
    const messageId = event.message.id;
    const userText = event.message.text.trim();
    const sourceId = event.source.groupId || event.source.roomId || userId;

    log('info', `[POST] Received message from ${sourceId}`);
    
    // 1. DoS攻撃および長すぎる入力をチェック
    if (isDoSAttack(userText)) { /* ... */ return; }
    
    // 2. 利用制限をチェック
    const { isCountOver, rank } = await checkAndIncrementCount(userId);
    if (isCountOver) { /* ... */ return; }

    // 3. フィルタリングと外部通知のチェック (優先度：危険 > 詐欺 > 不適切 > 共感)
    let replyText = '';
    let isFiltered = false;
    const context = `現在のユーザーランクは${rank}です。`;
    
    if (isDangerMessage(userText)) {
        replyText = await notifyExternal(userId, userText, 'DANGER', context);
        isFiltered = true;
    } else if (isScamMessage(userText)) {
        replyText = await notifyExternal(userId, userText, 'SCAM', context);
        isFiltered = true;
    } else if (isInappropriateMessage(userText)) {
        replyText = await notifyExternal(userId, userText, 'INAPPROPRIATE', context);
        isFiltered = true;
    } else if (isEmpathyMessage(userText)) {
        replyText = await notifyExternal(userId, userText, 'EMPATHY', context);
        isFiltered = true;
    }

    // 4. AIによる応答
    if (!isFiltered) {
        replyText = await aiGeneralReply(userId, userText, context);
    }
    
    // 5. LINE応答
    await safeReplyOrPush(event.replyToken, userId, replyText);

    // 6. リレー機能 (Firestoreに保存)
    if (event.source.type === 'group' || event.source.type === 'room') {
        const groupId = event.source.groupId || event.source.roomId;
        
        // 🟡 修正適用箇所: Firestore書き込み前にIDのチェックを追加 (エラー解消)
        if (!groupId || !messageId) {
             log('warn', '[WARN] Firestore relay skip: groupId or messageId undefined');
             return;
        }

        try {
            const relayRef = db.collection(COLLECTIONS.GROUPS).doc(groupId).collection('messages').doc(messageId);
            await relayRef.set({
                userId: userId,
                text: userText,
                timestamp: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
                ai_reply: replyText,
                filtered_type: isFiltered ? 'filtered' : 'none'
            });
            log('debug', '[LOG] Message relayed successfully.');
        } catch (error) {
            briefErr('relay user->group failed', error);
        }
    }
}

// ----------------------------------------------------
// Firestore 参照
// ----------------------------------------------------
const db = firebaseAdmin.firestore();
const Timestamp = firebaseAdmin.firestore.Timestamp;


// ----------------------------------------------------
// OpenAI 初期化
// ----------------------------------------------------
let openai = null;
if (OPENAI_API_KEY && OpenAI) {
  try {
    openai = new OpenAI({ apiKey: OPENAI_API_KEY });
  } catch (e) {
    log('error', '[INIT] OpenAI SDKの初期化に失敗しました:', e);
    openai = null;
  }
} else {
  log('warn', '[INIT] OPENAI_API_KEY または SDK が利用できません。');
}

// ----------------------------------------------------
// Google Generative AI (Gemini) 初期化
// ----------------------------------------------------
let geminiAi = null;
let geminiFlash = null; // gemini-2.5-flash モデルインスタンス
let geminiPro = null;   // gemini-2.5-pro モデルインスタンス
let GoogleGenerativeAI;
try { GoogleGenerativeAI = require('@google/generative-ai').GoogleGenerativeAI; } catch (e) { /* silent */ }


if (GEMINI_API_KEY && GoogleGenerativeAI) {
  try {
    geminiAi = new GoogleGenerativeAI(GEMINI_API_KEY);
    
    // 🔴 修正: モデルサービスを直接取得
    geminiFlash = geminiAi.getGenerativeModel({ model: GEMINI_FLASH_MODEL });
    geminiPro = geminiAi.getGenerativeModel({ model: GEMINI_PRO_MODEL });
    
  } catch (e) {
    log('error', '[INIT] Google Generative AI SDKの初期化に失敗しました:', e);
    geminiAi = null;
    geminiFlash = null;
    geminiPro = null;
  }
} else {
  log('warn', '[INIT] GEMINI_API_KEY または SDK が利用できません。');
}

// ----------------------------------------------------
// 補助関数群
// ----------------------------------------------------

// LINE Push/Reply Utility
const lineClient = new Client({ channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN, channelSecret: LINE_CHANNEL_SECRET });
const safeReplyOrPush = async (token, to, messages) => {
  const msgs = Array.isArray(messages) ? messages : [messages];
  if (token && token !== '00000000000000000000000000000000') {
    try { await lineClient.replyMessage(token, msgs); return true; } catch (e) { briefErr(`LINE reply to ${to} failed`, e); }
  }
  try { await lineClient.pushMessage(to, msgs); return true; } catch (e) { briefErr(`LINE push to ${to} failed`, e); }
  return false;
};
const safePush = async (to, messages) => safeReplyOrPush(null, to, messages);

// Utility functions
const normalizeJa = (t) => String(t || '').replace(/[Ａ-Ｚａ-ｚ０-９]/g, s => String.fromCharCode(s.charCodeAt(0) - 0xFEE0)).toLowerCase().trim();
const todayJST = () => dayjs().tz(JST_TZ).format('YYYY-MM-DD');

function nextPingAtFrom(baseDate) {
  let next = dayjs(baseDate).tz(JST_TZ).hour(WATCH_PING_HOUR_JST).minute(0).second(0).millisecond(0);
  if (next.isBefore(dayjs().tz(JST_TZ))) next = next.add(1, 'day');
  return next.toDate();
}
async function scheduleNextPing(userId) {
  const ref = db.collection('users').doc(userId);
  await ref.set({ watchService: { nextPingAt: Timestamp.fromDate(nextPingAtFrom(new Date())) } }, { merge: true });
}

// User Rank / Count
async function getUserRank(userId) {
  if (userId === OWNER_USER_ID) return 'admin';
  if (!userId) return DEFAULT_RANK;
  const doc = await db.collection('users').doc(userId).get();
  return doc.data()?.rank || DEFAULT_RANK;
}

async function checkAndIncrementCount(userId, rank, isConsult = false) {
  const ref = db.collection('users').doc(userId);
  const config = MEMBERSHIP_CONFIG[rank] || MEMBERSHIP_CONFIG[DEFAULT_RANK];
  const limit = isConsult ? config.consultLimit : config.dailyLimit;

  if (config.isUnlimited) return { canProceed: true, currentCount: -1 };
  if (limit === -1) return { canProceed: true, currentCount: -1 };

  let currentCount = -1;
  let canProceed = false;
  const counterField = isConsult ? 'consultCount' : 'dailyCount';
  const dateField = isConsult ? 'consultDate' : 'dailyDate';

  await db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    const u = s.exists ? (s.data() || {}) : {};
    const dateStr = todayJST();
    
    const currentUsage = u[counterField] || 0;
    const lastDate = u[dateField];

    if (lastDate !== dateStr) {
      currentCount = 1;
      canProceed = 1 <= limit;
      tx.set(ref, { [dateField]: dateStr, [counterField]: 1 }, { merge: true });
    } else {
      currentCount = currentUsage + 1;
      canProceed = currentCount <= limit;
      if (canProceed) {
        tx.set(ref, { [counterField]: currentCount }, { merge: true });
      }
    }
  });

  return { canProceed, currentCount };
}

// Message Classification
const isDoSAttack = (text) => toGraphemes(text).length > 2000;
const isDangerMessage = (text) => {
  if (toGraphemes(text).length < MIN_DANGER_WORD_LENGTH) return false;
  const t = normalizeJa(text);
  return DANGER_WORDS.some(w => t.includes(w));
};
const isScamMessage = (text) => {
  const t = normalizeJa(text);
  const hasCore = SCAM_CORE_WORDS.some(w => t.includes(w));
  const hasBrand = BRANDS.test(t);
  const okContext = BRAND_OK_CONTEXT.test(t);
  return hasCore && hasBrand && !okContext;
};
const hasEmpathyWord = (text) => {
  const t = normalizeJa(text);
  return EMPATHY_WORDS.some(w => t.includes(w));
};
const hasInappropriate = (text) => {
  const t = normalizeJa(text).replace(/[^a-z0-9ぁ-んァ-ヶ一-龠]/g, ''); // 記号除去
  return inappropriateWords.some(w => t.includes(w));
};

// Fallback short messages for safety-critical situations
const fallbackDangerTwo = () => 'ちょっと心配だよ。今、あなたの気持ちが一番大切だから、まず落ち着いて深呼吸してね。専門の窓口も頼ってね。';
const fallbackScamTwo = () => 'ちょっと待って！一旦立ち止まろう。それは本当に正しい情報かな？すぐにアクションしないで、公式情報と確認してね。';


// Chat History
async function saveChatHistory(userId, sender, message) {
  // 🩵 修正: userIdが有効かチェック
  if (!userId || typeof userId !== 'string' || userId.length < 5) {
    log('warn', 'saveChatHistory: Invalid userId provided', { userId, sender });
    return;
  }
  const ref = db.collection('chatHistory').doc(userId);
  const newEntry = {
    sender: sender,
    message: message,
    timestamp: Timestamp.now()
  };

  await ref.set({
    history: firebaseAdmin.firestore.FieldValue.arrayUnion(newEntry)
  }, { merge: true });
}

async function getRecentChatHistory(userId, limit) {
  // 🩵 修正: userIdが有効かチェック
  if (!userId || typeof userId !== 'string' || userId.length < 5) return [];

  const ref = db.collection('chatHistory').doc(userId);
  const doc = await ref.get();
  if (!doc.exists) return [];
  const history = doc.data().history || [];
  // Firestore TimestampをDateに変換してソート
  return history
    .map(h => ({
      ...h,
      timestamp: h.timestamp?.toDate?.() || new Date(0)
    }))
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
    .slice(0, limit);
}


// --- AI Core ---

// 🔴 修正: Gemini/OpenAIを統合し、Gemini Pro/Flashを使い分ける
async function aiGeneralReply(text, rank, userId, isConsultMode = false) {
  log('debug', 'aiGeneralReply started', { rank, isConsultMode });
  let chatModel = null;
  let systemInstruction = 'あなたは「こころちゃん」という名前の、優しくて賢く、誠実で真面目なAIチャットボットです。ユーザーの話に共感し、寄り添い、感情豊かに対応します。回答は日本語で、100文字から150文字程度の短く簡潔な一言にしてください。絵文字（💖、🌸、😊など）を必ず使い、親しみやすさを強調してください。長い回答は避けてください。';
  let isGemini = false;
  let historyLimit = 5;
  
  // 1. モデルの選択
  if (isConsultMode) {
    // 相談モード: Gemini Pro または GPT-4o-mini/GPT-4o
    if (geminiPro) {
      chatModel = geminiPro;
      isGemini = true;
      systemInstruction = 'あなたは「こころちゃん」という名前の、優しくて賢く、誠実で真面目なAIチャットボットです。ユーザーが相談モードに入っています。ユーザーの話に**深く共感し、寄り添い、優しく**、感情豊かに対応してください。特に否定的な意見や断定的な態度は避け、**安心感を与える**ことを最優先してください。回答は日本語で、150文字から300文字程度で、**共感を伝える内容**にしてください。絵文字（💖、🌸、😊など）を必ず使い、親しみやすさを強調してください。';
      historyLimit = 10;
    } else if (openai) {
      chatModel = openai;
      systemInstruction = systemInstruction.replace('100文字から150文字', '150文字から300文字'); // 相談モードの長さに変更
      historyLimit = 10;
    }
  } else {
    // 通常モード: Gemini Flash または GPT-4o-mini
    if (geminiFlash) {
      chatModel = geminiFlash;
      isGemini = true;
      historyLimit = 5;
    } else if (openai) {
      chatModel = openai;
      historyLimit = 5;
    }
  }

  if (!chatModel) return null; // 利用可能なモデルがない

  // 2. 履歴の準備
  const history = await getRecentChatHistory(userId, historyLimit);
  const historyForModel = history
    .map(h => ({
      role: h.sender === 'ユーザー' ? 'user' : 'model',
      parts: [{ text: h.message }]
    }));
  
  // 3. モデルへの送信と応答
  try {
    if (isGemini) {
      // Gemini API
      const chat = chatModel.startChat({
        history: historyForModel,
        config: { systemInstruction }
      });
      const result = await chat.sendMessage({ text });
      return result.text;
    } else {
      // OpenAI API
      const messages = [
        { role: 'system', content: systemInstruction },
        ...historyForModel.map(h => ({ role: h.role, content: h.parts[0].text })),
        { role: 'user', content: text }
      ];
      
      const response = await chatModel.chat.completions.create({
        model: OPENAI_MODEL, // OpenAIの場合は、OPENAI_MODELを使用
        messages: messages,
        temperature: 0.7,
      });
      return response.choices[0].message.content;
    }
  } catch (e) {
    briefErr(`AI reply failed (${isGemini ? 'Gemini' : 'OpenAI'})`, e);
    return null; // 失敗
  }
}


// 危険・詐欺メッセージ時の短い応答を生成
async function gptTwoShorts(type, text) {
  if (!openai) return null;
  const isDanger = type === 'danger';
  const systemInstruction = isDanger
    ? 'あなたは「こころちゃん」という名前の、優しく、冷静で、賢いAIです。ユーザーから命に関わる危険なメッセージを検出しました。ユーザーの不安を軽減し、まず落ち着かせることを最優先してください。専門の相談窓口への誘導を促す文章を、**20文字から60文字程度**で作成してください。絵文字（💖、🌸、😊など）を必ず使い、親しみやすさを保ってください。'
    : 'あなたは「こころちゃん」という名前の、優しく、冷静で、賢いAIです。ユーザーから詐欺や不審なメッセージを検出しました。ユーザーを驚かせず、すぐにアクションするのを防ぐ言葉を選び、「立ち止まること」と「確認すること」を促す文章を、**20文字から60文字程度**で作成してください。絵文字（💖、🌸、😊など）を必ず使い、親しみやすさを保ってください。';
  
  try {
    const response = await openai.chat.completions.create({
      model: OPENAI_DANGER_MODEL,
      messages: [
        { role: 'system', content: systemInstruction },
        { role: 'user', content: `ユーザーメッセージ: ${text}` }
      ],
      temperature: 0.5,
    });
    return response.choices[0].message.content;
  } catch (e) {
    briefErr(`GPT two-shorts failed (${type})`, e);
    return null;
  }
}

// ===== LINE Flex Message Builders =====

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
    briefErr("Webhook error", err);
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

        if (canNotify && SEND_OFFICER_ALERTS !== false) {
          const udoc = await db.collection('users').doc(doc.id).get();
          const udata = udoc.exists ? (udoc.data() || {}) : {};
          const elapsedH = lastPingAt ? dayjs().utc().diff(dayjs(lastPingAt).utc(), 'hour') : ESCALATE_AFTER_HOURS;

          const selfName   = udata?.profile?.name || '(不明)';
          const selfAddress= udata?.profile?.address || '(不明)';
          const selfPhone  = udata?.profile?.phone || udata?.emergency?.selfPhone || EMERGENCY_CONTACT_PHONE_NUMBER || '';
          const kinName    = udata?.emergency?.contactName || '(不明)';
          const kinPhone   = udata?.emergency?.contactPhone || '';

          // 🔴 最終的に通知を送信するブロック
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
        
        // 🔴 ステータスを更新し、次回のPingをスケジュール
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
  // 🩵 修正: userIdが無効な場合は早期リターン
  if (!userId || typeof userId !== 'string' || userId.length < 5) return;
  
  const data = event.postback.data || '';
  
  // ===== 新機能：危険アラート対応・同意確認処理 =====
  if (data.startsWith("relay_start&uid=")) {
    const targetUserId = data.split("&uid=")[1];
    const handlerName = "事務局スタッフ"; // 実際はグループのdisplayNameでもOK
    await safePush(targetUserId, buildUserConsentChoice({ handlerName }));
    // 返信トークンを使ってグループに確認メッセージを返す
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
  if (data.includes('watch:disable')) {
    await setWatchEnabled(userId, false);
    await safeReplyOrPush(event.replyToken, userId, { type:'text', text:'見守りを停止しました🌸' });
    return;
  }
  if (data.includes('watch:enable')) {
    await setWatchEnabled(userId, true);
    await safeReplyOrPush(event.replyToken, userId, { type:'text', text:'見守りを有効にしました🌸' });
    return;
  }
  if (data.includes('watch:ok')) {
    const ref = db.collection('users').doc(userId);
    await ref.set({ watchService:{ awaitingReply:false, lastReplyAt: Timestamp.now() } }, { merge:true });
    await scheduleNextPing(userId);
    await safeReplyOrPush(event.replyToken, userId, [
      { type:'text', text:'OK、受け取ったよ！💖 いつもありがとう😊' },
      { type:'sticker', packageId:'6325', stickerId:'10979913' }
    ]);
    return;
  }
  
  // 'relay_start&uid=' の処理が優先されたため、このブロックは削除するか、他のpostback処理を追加する
  // const params = new URLSearchParams(data);
  // const action = params.get('action');
  // if (action === 'start_relay') {
  //   const targetUserId = params.get('uid');
  //   ...
  // }
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
  const gid = event.source.groupId || event.source.roomId;
  if (gid) await safeReplyOrPush(event.replyToken, gid, { type:'text', text:'このグループを見守りグループとして使う場合は「@見守りグループにする」と発言してください。' });
}
async function handleLeaveEvent(event) {
  audit('leave', { groupId: event.source.groupId || event.source.roomId });
  const gid = event.source.groupId || event.source.roomId;
  if (gid && gid === (await getActiveWatchGroupId())) await setActiveWatchGroupId(null);
}

// ===== メイン =====
async function handleEvent(event) {
  // 🩵 修正: userIdが無効な場合は早期リターン
  const userId = event.source.userId;
  if (!userId || typeof userId !== 'string' || userId.length < 5) return;

  const isUser  = event.source.type === 'user';
  const isGroup = event.source.type === 'group';
  const isRoom  = event.source.type === 'room';
  const groupId = event.source.groupId || event.source.roomId || null;

  // テキストメッセージ以外は無視（スタンプは一部例外で後続処理）
  if (event.message.type !== 'text' && event.message.type !== 'sticker') return;
  
  const text = event.message.type === 'text' ? (event.message.text || '') : '';
  const stickerId = event.message.type === 'sticker' ? event.message.stickerId : '';
  const inputCharLength = toGraphemes(text).length;

  // 履歴保存
  if (isUser && (text || stickerId)) {
    const logText = text || `[Sticker: ${stickerId}]`;
    await saveChatHistory(userId, 'ユーザー', logText);
  }

  // 処理対象がテキストメッセージでない場合、見守りOKのスタンプ応答をチェックして終了
  if (!text) {
    if (stickerId) {
      const udoc = await db.collection('users').doc(userId).get();
      const u = udoc.exists ? (udoc.data() || {}) : {};
      const enabled = !!(u.watchService && u.watchService.enabled);
      // 見守りOKのスタンプID (適当なIDの例)
      const watchOkStickerIds = ['52002766', '52002767', '52002734', '52002735', '52002758', '52002759', '11537', '11538'];
      if (isUser && enabled && u.watchService?.awaitingReply && watchOkStickerIds.includes(stickerId)) {
         const ref = db.collection('users').doc(userId);
         await ref.set({ watchService:{ awaitingReply:false, lastReplyAt: Timestamp.now() } }, { merge:true });
         await scheduleNextPing(userId);
         await safeReplyOrPush(event.replyToken, userId, [
           { type:'text', text:'OK、スタンプで受け取ったよ！💖 いつもありがとう😊' },
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

  // 3) watch OK by text
  const udoc = await db.collection('users').doc(userId).get();
  const u = udoc.exists ? (udoc.data() || {}) : {};
  const enabled = !!(u.watchService && u.watchService.enabled);
  if (isUser && enabled && u.watchService?.awaitingReply && (
    /(^(ok|大丈夫|はい|元気|おけ|おっけ|okだよ|問題ない|なんとか|ありがとう)$)/i.test(normalizeJa(text.trim()))
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
        if (SCAM_ALERT_TO_WATCH_GROUP && gid && SEND_OFFICER_ALERTS !== false) {
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
    const aiReply = await aiGeneralReply(text, rank, userId, true); // 簡易相談モード
    const replyText = aiReply ? aiReply.trim() : '話してくれてありがとう🌸 まずは深呼吸しようね。ここにいるよ、少しずつで大丈夫だよ😊';
    await safeReplyOrPush(event.replyToken, userId, { type:'text', text: replyText });
    await saveChatHistory(userId, 'こころチャット', replyText);
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
  const isSoudan = SOODAN_TRIGGERS.includes(normalizeJa(text.trim()));
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

  // 10) 団体・HP案内
  const tnorm = normalizeJa(text);
  const isOrgIntent = ORG_INTENT.test(tnorm) || ORG_SUSPICIOUS.test(tnorm);
  const isHomepageIntent = HOMEPAGE_INTENT.test(tnorm);
  if (isOrgIntent || isHomepageIntent) {
   
    // 団体・HP案内でも、通常のFlash/Mini切り替えロジックを適用
    const aiReply = await aiGeneralReply(text, rank, userId); 

    if (aiReply) {
        const replyText = aiReply.trim();
        await safeReplyOrPush(event.replyToken, userId, { type: 'text', text: replyText });
        await saveChatHistory(userId, 'こころチャット', replyText);
    } else {
        // AI応答失敗時のFallback
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
  
 // 11) AIによる会話応答（通常会話）

let aiReply;
try {
    // 第4引数を省略することで、aiGeneralReply内の文字数/フォールバックロジックが適用される
    aiReply = await aiGeneralReply(text, rank, userId);
} catch (err) {
    briefErr("AI呼び出しエラー", err);
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
        briefErr("LINE返信失敗", replyErr); 
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
    briefErr("LINE最終返信失敗", finalErr);
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
