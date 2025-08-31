'use strict';

const firebaseAdmin = require('firebase-admin');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezone);

const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || '';
const OFFICER_GROUP_ID = process.env.OFFICER_GROUP_ID || '';
const FIREBASE_CREDENTIALS_BASE64 = process.env.FIREBASE_CREDENTIALS_BASE64 || '';

if (!LINE_CHANNEL_ACCESS_TOKEN) {
  console.error('LINE_CHANNEL_ACCESS_TOKEN が未設定です。'); process.exit(1);
}
if (!FIREBASE_CREDENTIALS_BASE64) {
  console.error('FIREBASE_CREDENTIALS_BASE64 が未設定です。'); process.exit(1);
}

let FIREBASE_SERVICE_ACCOUNT;
try {
  FIREBASE_SERVICE_ACCOUNT = JSON.parse(Buffer.from(FIREBASE_CREDENTIALS_BASE64, 'base64').toString('utf-8'));
} catch (e) {
  console.error('FIREBASE_CREDENTIALS_BASE64 のデコードに失敗:', e.message); process.exit(1);
}

firebaseAdmin.initializeApp({ credential: firebaseAdmin.credential.cert(FIREBASE_SERVICE_ACCOUNT) });
const firestore = firebaseAdmin.firestore();

const { Client } = require('@line/bot-sdk');
const lineClient = new Client({
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: LINE_CHANNEL_SECRET || undefined,
});

const JST_TZ = 'Asia/Tokyo';
const LOCK_SEC = 120;
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
  "こんにちは😊 笑顔で過ごせてるかな？",
  "やっほー！ こころだよ🌸 素敵な日になりますように💖",
  "元気かな？💖 こころはいつでもあなたのそばにいるよ！",
  "ねぇねぇ、こころだよ😊 どんな小さなことでも話してね！",
  "いつも応援してるよ🌸 こころちゃんだよ💖",
  "こんにちは😊 今日も一日、お互いがんばろうね！",
  "やっほー！ こころだよ🌸 素敵な日になりますように💖",
  "元気にしてる？✨ 季節の変わり目だから、体調に気をつけてね！",
  "こころちゃんだよ🌸 嬉しいことがあったら、教えてね💖",
  "こんにちは😊 ちょっと一息入れようね！",
  "やっほー！ こころだよ🌸 あなたのことが心配だよ！",
  "元気かな？💖 どんな時でも、こころはそばにいるよ！",
  "ねぇねぇ、こころだよ😊 辛い時は、無理しないでね！",
  "いつも見守ってるよ🌸 こころちゃんだよ💖",
  "こんにちは😊 今日も一日、穏やかに過ごせたかな？",
  "やっほー！ こころだよ🌸 困った時は、いつでも呼んでね！",
  "元気にしてる？✨ こころはいつでも、あなたのことを考えてるよ💖",
  "こころちゃんだよ🌸 小さなことでも、お話しようね！",
  "こんにちは😊 あなたの笑顔が見たいな！",
  "やっほー！ こころだよ🌸 頑張り屋さんだね！",
  "元気かな？💖 こころちゃんは、いつでもあなたの味方だよ！"
];
const pickWatchMsg = () => watchMessages[Math.floor(Math.random() * watchMessages.length)];

function nextPingAtFrom(fromDate) {
  return dayjs(fromDate).tz(JST_TZ).add(3, 'day').hour(15).minute(0).second(0).millisecond(0).toDate();
}

async function safePush(to, messages) {
  try { await lineClient.pushMessage(to, Array.isArray(messages) ? messages : [messages]); }
  catch (err) { console.error(`[ERROR] push to ${to} failed:`, err?.response?.data || err.message); }
}

async function checkAndSendPing() {
  const now = dayjs().tz(JST_TZ);
  console.log(`[watch-service] start ${now.format('YYYY/MM/DD HH:mm:ss')}`);
  const usersRef = firestore.collection('users');

  const duePingSnap = await usersRef
    .where('watchService.enabled', '==', true)
    .where('watchService.awaitingReply', '==', false)
    .where('watchService.nextPingAt', '<=', now.toDate())
    .get();

  const awaitingSnap = await usersRef
    .where('watchService.enabled', '==', true)
    .where('watchService.awaitingReply', '==', true)
    .get();

  const targets = [...duePingSnap.docs, ...awaitingSnap.docs];
  if (targets.length === 0) {
    console.log('[watch-service] no targets.');
    return;
  }

  for (const doc of targets) {
    const ref = doc.ref;

    const locked = await firestore.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      const u = s.data() || {};
      const ws = u.watchService || {};
      const lockUntil = ws.notifyLockExpiresAt?.toDate?.() || new Date(0);
      if (lockUntil.getTime() > Date.now()) return false;
      const nextPingAt = ws.nextPingAt?.toDate?.() || null;
      const awaiting = !!ws.awaitingReply;
      if (!awaiting && (!nextPingAt || nextPingAt > new Date())) return false;
      tx.set(ref, { watchService: { notifyLockExpiresAt: firebaseAdmin.firestore.Timestamp.fromDate(new Date(Date.now() + LOCK_SEC * 1000)) } }, { merge: true });
      return true;
    });

    if (!locked) continue;

    try {
      const s = await ref.get();
      const u = s.data() || {};
      const ws = u.watchService || {};
      const awaiting = !!ws.awaitingReply;
      const lastPingAt     = ws.lastPingAt?.toDate?.()     ? dayjs(ws.lastPingAt.toDate())     : null;
      const lastReminderAt = ws.lastReminderAt?.toDate?.() ? dayjs(ws.lastReminderAt.toDate()) : null;
      const lastNotifiedAt = ws.lastNotifiedAt?.toDate?.() ? dayjs(ws.lastNotifiedAt.toDate()) : null;

      let mode = awaiting ? 'noop' : 'ping';
      if (awaiting && lastPingAt) {
        const hrs = dayjs().tz(JST_TZ).diff(lastPingAt, 'hour');
        if (hrs >= ESCALATE_AFTER_HOURS) mode = 'escalate';
        else if (hrs >= REMINDER_AFTER_HOURS) {
          if (!lastReminderAt || dayjs().tz(JST_TZ).diff(lastReminderAt, 'hour') >= 1) mode = 'remind';
          else mode = 'noop';
        } else mode = 'noop';
      }

      if (mode === 'noop') {
        await ref.set({ watchService: { notifyLockExpiresAt: firebaseAdmin.firestore.FieldValue.delete() } }, { merge: true });
        continue;
      }

      if (mode === 'ping') {
        await safePush(doc.id, [
          { type: 'text', text: `${pickWatchMsg()} 大丈夫なら「OKだよ💖」を押してね！` },
          {
            type: 'flex',
            altText: '見守りチェック',
            contents: {
              type: 'bubble',
              body: { type: 'box', layout: 'vertical', contents: [
                { type: 'text', text: '見守りチェック', weight: 'bold', size: 'xl' },
                { type: 'text', text: 'OKならボタンを押してね💖 返信やスタンプでもOK！', wrap: true, margin: 'md' },
              ] },
              footer: { type: 'box', layout: 'vertical', contents: [
                { type: 'button', style: 'primary', action: { type: 'postback', label: 'OKだよ💖', data: 'watch:ok', displayText: 'OKだよ💖' } },
              ] },
            },
          },
        ]);
        await ref.set({
          watchService: {
            lastPingAt: firebaseAdmin.firestore.Timestamp.now(),
            awaitingReply: true,
            nextPingAt: firebaseAdmin.firestore.FieldValue.delete(),
            lastReminderAt: firebaseAdmin.firestore.FieldValue.delete(),
            notifyLockExpiresAt: firebaseAdmin.firestore.FieldValue.delete(),
          },
        }, { merge: true });

      } else if (mode === 'remind') {
        await safePush(doc.id, [
          { type: 'text', text: `${pickWatchMsg()} 昨日の見守りのOKまだ受け取れてないの… 大丈夫ならボタン押してね！` },
          {
            type: 'flex',
            altText: '見守りリマインド',
            contents: {
              type: 'bubble',
              body: { type: 'box', layout: 'vertical', contents: [
                { type: 'text', text: '見守りリマインド', weight: 'bold', size: 'xl' },
                { type: 'text', text: 'OKならボタンを押してね💖 返信やスタンプでもOK！', wrap: true, margin: 'md' },
              ] },
              footer: { type: 'box', layout: 'vertical', contents: [
                { type: 'button', style: 'primary', action: { type: 'postback', label: 'OKだよ💖', data: 'watch:ok', displayText: 'OKだよ💖' } },
              ] },
            },
          },
        ]);
        await ref.set({
          watchService: {
            lastReminderAt: firebaseAdmin.firestore.Timestamp.now(),
            notifyLockExpiresAt: firebaseAdmin.firestore.FieldValue.delete(),
          },
        }, { merge: true });

      } else if (mode === 'escalate') {
        const canNotifyOfficer = OFFICER_GROUP_ID && (!lastNotifiedAt || dayjs().tz(JST_TZ).diff(lastNotifiedAt, 'hour') >= OFFICER_NOTIFICATION_MIN_GAP_HOURS);
        if (canNotifyOfficer) {
          await safePush(OFFICER_GROUP_ID, { type: 'text', text: `🚨見守り未応答: ユーザー ${doc.id} が ${ESCALATE_AFTER_HOURS}時間未応答` });
        }
        await ref.set({
          watchService: {
            lastNotifiedAt: firebaseAdmin.firestore.Timestamp.now(),
            awaitingReply: false,
            lastReminderAt: firebaseAdmin.firestore.FieldValue.delete(),
            nextPingAt: firebaseAdmin.firestore.Timestamp.fromDate(nextPingAtFrom(now.toDate())),
            notifyLockExpiresAt: firebaseAdmin.firestore.FieldValue.delete(),
          },
        }, { merge: true });
      }

    } catch (e) {
      console.error('[ERROR] send/update failed:', e?.response?.data || e.message);
      await ref.set({ watchService: { notifyLockExpiresAt: firebaseAdmin.firestore.FieldValue.delete() } }, { merge: true });
    }
  }

  console.log(`[watch-service] end ${dayjs().tz(JST_TZ).format('YYYY/MM/DD HH:mm:ss')}`);
}

checkAndSendPing().catch((err) => {
  console.error('[watch-service] unexpected error:', err);
  process.exit(1);
});
