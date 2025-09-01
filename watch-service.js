'use strict';

const firebaseAdmin = require('firebase-admin');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezone);

const { Client } = require('@line/bot-sdk');

const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || '';
const OFFICER_GROUP_ID = process.env.OFFICER_GROUP_ID || '';
const WATCH_GROUP_ID = process.env.WATCH_GROUP_ID || ''; // 追加
const FIREBASE_CREDENTIALS_BASE64 = process.env.FIREBASE_CREDENTIALS_BASE64 || '';
const EMERGENCY_CONTACT_PHONE_NUMBER = process.env.EMERGENCY_CONTACT_PHONE_NUMBER || '';

if (!LINE_CHANNEL_ACCESS_TOKEN) { console.error('LINE_CHANNEL_ACCESS_TOKEN 未設定'); process.exit(1); }
if (!FIREBASE_CREDENTIALS_BASE64) { console.error('FIREBASE_CREDENTIALS_BASE64 未設定'); process.exit(1); }

// WATCH_GROUP_ID が "C..." 形式でない場合の警告
if (WATCH_GROUP_ID && !/^C/.test(WATCH_GROUP_ID)) {
    console.warn('[WARN] WATCH_GROUP_ID が "C..." 形式ではない可能性');
}
// どちらのグループIDも未設定の場合の警告
if (!WATCH_GROUP_ID && !OFFICER_GROUP_ID) {
    console.warn('[WARN] WATCH_GROUP_ID / OFFICER_GROUP_ID が未設定。未応答通知はスキップされます。');
}

let FIREBASE_SERVICE_ACCOUNT;
try {
  FIREBASE_SERVICE_ACCOUNT = JSON.parse(Buffer.from(FIREBASE_CREDENTIALS_BASE64, 'base64').toString('utf-8'));
} catch (e) {
  console.error('FIREBASE_CREDENTIALS_BASE64 デコード失敗:', e.message); process.exit(1);
}

firebaseAdmin.initializeApp({ credential: firebaseAdmin.credential.cert(FIREBASE_SERVICE_ACCOUNT) });
const firestore = firebaseAdmin.firestore();

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
  dayjs(fromDate).tz(JST_TZ).add(3, 'day').hour(15).minute(0).second(0).millisecond(0).toDate();

async function safePush(to, messages) {
  try { await lineClient.pushMessage(to, Array.isArray(messages) ? messages : [messages]); }
  catch (err) {
    console.error(`[ERROR] push to ${to} failed${err?.response?.status ? ` (HTTP ${err.response.status})` : ''}:`,
      err?.response?.data || err.message);
  }
}

// インデックス未作成でも動く“フォールバック”付き取得
async function fetchTargets(now) {
  const usersRef = firestore.collection('users');
  const targets = [];

  // 1) duePing
  try {
    const snap = await usersRef
      .where('watchService.enabled', '==', true)
      .where('watchService.awaitingReply', '==', false)
      .where('watchService.nextPingAt', '<=', now.toDate())
      .limit(200)
      .get();
    targets.push(...snap.docs);
  } catch (e) {
    // フォールバック：enabledだけで拾ってメモリ側で絞る
    const snap = await usersRef.where('watchService.enabled', '==', true).limit(500).get();
    for (const d of snap.docs) {
      const ws = (d.data().watchService)||{};
      if (!ws.awaitingReply && ws.nextPingAt && ws.nextPingAt.toDate && ws.nextPingAt.toDate() <= now.toDate()) {
        targets.push(d);
      }
    }
  }

  // 2) awaiting
  try {
    const snap = await usersRef
      .where('watchService.enabled', '==', true)
      .where('watchService.awaitingReply', '==', true)
      .limit(200)
      .get();
    targets.push(...snap.docs);
  } catch (e) {
    const snap = await usersRef.where('watchService.enabled', '==', true).limit(500).get();
    for (const d of snap.docs) {
      const ws = (d.data().watchService)||{};
      if (ws.awaitingReply === true) targets.push(d);
    }
  }

  // 同一doc重複排除
  const map = new Map();
  for (const d of targets) map.set(d.id, d);
  return Array.from(map.values());
}

// 欠落自己修復（nextPingAtが無い enabledユーザーに初期値）
async function warmupFill(now) {
  const usersRef = firestore.collection('users');
  const snap = await usersRef.where('watchService.enabled', '==', true).limit(200).get();
  let batch = firestore.batch(), cnt=0;
  for (const d of snap.docs) {
    const ws = (d.data().watchService)||{};
    if (!ws.awaitingReply && !ws.nextPingAt) {
      batch.set(d.ref, {
        watchService: {
          nextPingAt: firebaseAdmin.firestore.Timestamp.fromDate(nextPingAtFrom(now.toDate()))
        }
      }, { merge:true });
      cnt++;
    }
  }
  if (cnt) await batch.commit();
}

// TELマスク＆Flex生成
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
                    type: 'button', style: 'primary',
                    action: { type: 'uri', label: '📞 発信する', uri: `tel:${tel}` }
                }] : [{ type: 'text', text: '※TEL未登録', size: 'sm', color: '#888' }]
            }
        }
    };
};

async function checkAndSendPing() {
  const now = dayjs().tz('UTC'); 
  console.log(`[watch-service] start ${now.format('YYYY/MM/DD HH:mm:ss')} (UTC)`);

  await warmupFill(now);
  const targets = await fetchTargets(now);
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
      const nowTs = firebaseAdmin.firestore.Timestamp.now();
      const lockUntil = ws.notifyLockExpiresAt?.toDate?.() || new Date(0);
      
      // ロック比較をnowTsのミリ秒に統一
      if (lockUntil.getTime() > nowTs.toMillis()) return false;

      const nextPingAt = ws.nextPingAt?.toDate?.() || null;
      const awaiting = !!ws.awaitingReply;
      
      // 次回判定もnowTsのミリ秒に統一
      if (!awaiting && (!nextPingAt || nextPingAt.getTime() > nowTs.toMillis())) return false;

      const until = new Date(nowTs.toMillis() + LOCK_SEC * 1000);
      tx.set(ref, { watchService: { notifyLockExpiresAt: firebaseAdmin.firestore.Timestamp.fromDate(until) } }, { merge: true });
      return true;
    });

    if (!locked) continue;

    try {
      const s = await ref.get();
      const u = s.data() || {};
      const ws = u.watchService || {};
      const awaiting = !!ws.awaitingReply;
      const lastPingAt      = ws.lastPingAt?.toDate?.()      ? dayjs(ws.lastPingAt.toDate())      : null;
      const lastReminderAt  = ws.lastReminderAt?.toDate?.() ? dayjs(ws.lastReminderAt.toDate()) : null;
      const lastNotifiedAt  = ws.lastNotifiedAt?.toDate?.() ? dayjs(ws.lastNotifiedAt.toDate()) : null;

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
        const targetGroupId = WATCH_GROUP_ID || OFFICER_GROUP_ID;
        const canNotify =
          targetGroupId &&
          (!lastNotifiedAt || now.diff(lastNotifiedAt, 'hour') >= OFFICER_NOTIFICATION_MIN_GAP_HOURS);
        if (canNotify) {
          const elapsedH = lastPingAt ? dayjs().utc().diff(dayjs(lastPingAt).utc(), 'hour') : ESCALATE_AFTER_HOURS;
          const tel = u?.profile?.emergencyPhone || u?.emergencyPhone || EMERGENCY_CONTACT_PHONE_NUMBER || '';
          const flex = buildWatchFlex(u, doc.id, elapsedH, tel);
          await safePush(targetGroupId, [
            { type: 'text', text: '🚨見守り未応答が発生しました。対応可能な方はお願いします。' },
            flex
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
        }, { merge: true });
      }

    } catch (e) {
      console.error('[ERROR] send/update failed:', e?.response?.data || e.message);
      await ref.set({ watchService: { notifyLockExpiresAt: firebaseAdmin.firestore.FieldValue.delete() } }, { merge: true });
    }
  }

  console.log(`[watch-service] end ${dayjs().tz('UTC').format('YYYY/MM/DD HH:mm:ss')} (UTC)`);
}

function shutdown(code) {
  firebaseAdmin.app().delete().catch(() => {}).finally(() => process.exit(code));
}

checkAndSendPing().then(() => shutdown(0)).catch(err => { console.error('[watch-service] unexpected error:', err); shutdown(1); });
