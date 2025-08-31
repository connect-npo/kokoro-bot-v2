// このファイルは、定期的に Firestore をチェックし、ユーザーに
// Ping（初回）→ リマインド（24h）→ エスカレーション（29h）を送るバッチです。
// 外部の cron（Render Scheduler / GitHub Actions / crontab 等）から実行します。

'use strict';

const firebaseAdmin = require('firebase-admin');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezone);

// ====== 環境変数 ======
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || ''; // 任意
const OFFICER_GROUP_ID = process.env.OFFICER_GROUP_ID || '';      // 役員グループ（任意）
const FIREBASE_CREDENTIALS_BASE64 = process.env.FIREBASE_CREDENTIALS_BASE64 || '';

if (!LINE_CHANNEL_ACCESS_TOKEN) {
  console.error('LINE_CHANNEL_ACCESS_TOKEN が未設定です。');
  process.exit(1);
}
if (!FIREBASE_CREDENTIALS_BASE64) {
  console.error('FIREBASE_CREDENTIALS_BASE64 が未設定です。');
  process.exit(1);
}

// ====== Firebase 初期化（Base64 資格情報対応）======
let FIREBASE_SERVICE_ACCOUNT;
try {
  FIREBASE_SERVICE_ACCOUNT = JSON.parse(
    Buffer.from(FIREBASE_CREDENTIALS_BASE64, 'base64').toString('utf-8')
  );
} catch (e) {
  console.error('FIREBASE_CREDENTIALS_BASE64 のデコードに失敗:', e.message);
  process.exit(1);
}

firebaseAdmin.initializeApp({
  credential: firebaseAdmin.credential.cert(FIREBASE_SERVICE_ACCOUNT),
});
const firestore = firebaseAdmin.firestore();

// ====== LINE BOT 初期化 ======
const { Client } = require('@line/bot-sdk');
const lineClient = new Client({
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: LINE_CHANNEL_SECRET || undefined,
});

// ====== ユーティリティ ======
const JST_TZ = 'Asia/Tokyo';
const LOCK_SEC = 120;                   // 二重実行ロック
const REMINDER_AFTER_HOURS = 24;        // リマインドまで
const ESCALATE_AFTER_HOURS = 29;        // エスカレーションまで
const OFFICER_NOTIFICATION_MIN_GAP_HOURS = 12; // 役員通知の最短間隔

/** 次回 Ping は「3日後の15:00 JST」 */
function nextPingAtFrom(fromDate) {
  return dayjs(fromDate)
    .tz(JST_TZ)
    .add(3, 'day')
    .hour(15).minute(0).second(0).millisecond(0)
    .toDate();
}

/** 安全 push（失敗はログのみ） */
async function safePush(to, messages) {
  try {
    await lineClient.pushMessage(to, Array.isArray(messages) ? messages : [messages]);
  } catch (err) {
    console.error(`[ERROR] push to ${to} failed:`, err?.response?.data || err.message);
  }
}

// ====== 本体 ======
async function checkAndSendPing() {
  const now = dayjs().tz(JST_TZ);
  console.log(`[watch-service] start ${now.format('YYYY/MM/DD HH:mm:ss')}`);

  const usersRef = firestore.collection('users');

  // 1) 通常 Ping 対象
  const duePingSnap = await usersRef
    .where('watchService.enabled', '==', true)
    .where('watchService.awaitingReply', '==', false)
    .where('watchService.nextPingAt', '<=', now.toDate())
    .get();

  // 2) リマインド / エスカレーション 対象（返信待ち）
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

    // --- 取扱中ロック（衝突防止） ---
    const locked = await firestore.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      const u = s.data() || {};
      const ws = u.watchService || {};

      const lockUntil = ws.notifyLockExpiresAt?.toDate?.() || new Date(0);
      if (lockUntil.getTime() > Date.now()) {
        console.log(JSON.stringify({level:'info', msg:'skip locked', user:doc.id}));
        return false;
      }

      const nextPingAt = ws.nextPingAt?.toDate?.() || null;
      const awaiting = !!ws.awaitingReply;

      // awaiting 中は nextPingAt を見ない。awaiting でない時だけ nextPingAt が due か確認
      if (!awaiting && (!nextPingAt || nextPingAt > new Date())) {
        console.log(JSON.stringify({level:'info', msg:'skip not due', user:doc.id}));
        return false;
      }

      tx.set(ref, {
        watchService: {
          notifyLockExpiresAt: firebaseAdmin.firestore.Timestamp.fromDate(
            new Date(Date.now() + LOCK_SEC * 1000)
          ),
        },
      }, { merge: true });

      return true;
    });

    if (!locked) continue;

    try {
      // --- 再取得して判定 ---
      const s = await ref.get();
      const u = s.data() || {};
      const ws = u.watchService || {};

      const awaiting = !!ws.awaitingReply;
      const lastPingAt     = ws.lastPingAt?.toDate?.()     ? dayjs(ws.lastPingAt.toDate())     : null;
      const lastReminderAt = ws.lastReminderAt?.toDate?.() ? dayjs(ws.lastReminderAt.toDate()) : null;
      const lastNotifiedAt = ws.lastNotifiedAt?.toDate?.() ? dayjs(ws.lastNotifiedAt.toDate()) : null;

      // 送信モード決定
      // awaiting=true なのに lastPingAt がない不整合は noop（安全側）
      let mode = awaiting ? 'noop' : 'ping';
      if (awaiting && lastPingAt) {
        const hrs = dayjs().tz(JST_TZ).diff(lastPingAt, 'hour');
        if (hrs >= ESCALATE_AFTER_HOURS) {
          mode = 'escalate';
        } else if (hrs >= REMINDER_AFTER_HOURS) {
          if (!lastReminderAt || dayjs().tz(JST_TZ).diff(lastReminderAt, 'hour') >= 1) {
            mode = 'remind';
          } else {
            mode = 'noop';
          }
        } else {
          mode = 'noop';
        }
      }

      if (mode === 'noop') {
        await ref.set({
          watchService: { notifyLockExpiresAt: firebaseAdmin.firestore.FieldValue.delete() },
        }, { merge: true });
        console.log(JSON.stringify({level:'info', msg:'noop', user:doc.id}));
        continue;
      }

      // --- 送信 ---
      if (mode === 'ping') {
        console.log(JSON.stringify({level:'info', msg:'ping', user:doc.id}));
        await safePush(doc.id, [
          { type: 'text', text: 'こころだよ🌸 元気にしてる？ 大丈夫なら「OKだよ💖」を押してね！' },
          {
            type: 'flex',
            altText: '見守りチェック',
            contents: {
              type: 'bubble',
              body: {
                type: 'box',
                layout: 'vertical',
                contents: [
                  { type: 'text', text: '見守りチェック', weight: 'bold', size: 'xl' },
                  { type: 'text', text: 'OKならボタンを押してね💖 返信やスタンプでもOK！', wrap: true, margin: 'md' },
                ],
              },
              footer: {
                type: 'box',
                layout: 'vertical',
                contents: [
                  {
                    type: 'button',
                    style: 'primary',
                    action: { type: 'postback', label: 'OKだよ💖', data: 'watch:ok', displayText: 'OKだよ💖' },
                  },
                ],
              },
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
        console.log(JSON.stringify({level:'info', msg:'remind', user:doc.id}));
        await safePush(doc.id, [
          { type: 'text', text: 'こころだよ🌸 昨日の見守りのOKまだ受け取れてないの… 大丈夫ならボタン押してね！' },
          {
            type: 'flex',
            altText: '見守りリマインド',
            contents: {
              type: 'bubble',
              body: {
                type: 'box',
                layout: 'vertical',
                contents: [
                  { type: 'text', text: '見守りリマインド', weight: 'bold', size: 'xl' },
                  { type: 'text', text: 'OKならボタンを押してね💖 返信やスタンプでもOK！', wrap: true, margin: 'md' },
                ],
              },
              footer: {
                type: 'box',
                layout: 'vertical',
                contents: [
                  {
                    type: 'button',
                    style: 'primary',
                    action: { type: 'postback', label: 'OKだよ💖', data: 'watch:ok', displayText: 'OKだよ💖' },
                  },
                ],
              },
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
        console.log(JSON.stringify({level:'info', msg:'escalate', user:doc.id}));

        const canNotifyOfficer =
          OFFICER_GROUP_ID &&
          (!lastNotifiedAt || dayjs().tz(JST_TZ).diff(lastNotifiedAt, 'hour') >= OFFICER_NOTIFICATION_MIN_GAP_HOURS);

        if (canNotifyOfficer) {
          await safePush(OFFICER_GROUP_ID, {
            type: 'text',
            text: `🚨見守り未応答: ユーザー ${doc.id} が ${ESCALATE_AFTER_HOURS}時間未応答`,
          });
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
      await ref.set({
        watchService: { notifyLockExpiresAt: firebaseAdmin.firestore.FieldValue.delete() },
      }, { merge: true });
    }
  }

  console.log(`[watch-service] end ${dayjs().tz(JST_TZ).format('YYYY/MM/DD HH:mm:ss')}`);
}

// 直接実行
checkAndSendPing().catch((err) => {
  console.error('[watch-service] unexpected error:', err);
  process.exit(1);
});
