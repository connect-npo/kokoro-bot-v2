// tools/init-watchService.js
'use strict';

/**
 * 目的：
 * usersコレクションで watchService が未作成のユーザーに
 * 最低限のフィールドを一括付与する初期化スクリプト。
 *
 * 実行後は、あなたが作った backfill-watch-nextPingAt.js を走らせて
 * nextPingAt を全員に入れてください。
 */

const firebaseAdmin = require('firebase-admin');

const FIREBASE_CREDENTIALS_BASE64 = process.env.FIREBASE_CREDENTIALS_BASE64 || '';
if (!FIREBASE_CREDENTIALS_BASE64) {
  console.error('FIREBASE_CREDENTIALS_BASE64 未設定');
  process.exit(1);
}

let cred;
try {
  cred = JSON.parse(Buffer.from(FIREBASE_CREDENTIALS_BASE64, 'base64').toString('utf-8'));
} catch (e) {
  console.error('FIREBASE_CREDENTIALS_BASE64 のデコードに失敗:', e.message);
  process.exit(1);
}

firebaseAdmin.initializeApp({ credential: firebaseAdmin.credential.cert(cred) });
const db = firebaseAdmin.firestore();

(async () => {
  console.log('init-watchService: start');
  const usersSnap = await db.collection('users').get();

  let batch = db.batch();
  let staged = 0;
  let updated = 0;
  let skipped = 0;

  for (const doc of usersSnap.docs) {
    const data = doc.data() || {};
    const ws = data.watchService;

    // 既にwatchServiceがある & enabledがbooleanならスキップ
    if (ws && typeof ws.enabled === 'boolean') {
      skipped++;
      continue;
    }

    // 初期値（必要最低限）
    // enabled は true にしておく（全員を見守りONの初期化に揃える）
    const patch = {
      watchService: {
        enabled: true,
        awaitingReply: false,
        enrolledAt: firebaseAdmin.firestore.Timestamp.now(),
        // これらは backfill / 実行時に適宜上書き・削除される想定
        lastReminderAt: firebaseAdmin.firestore.FieldValue.delete(),
        lastNotifiedAt: firebaseAdmin.firestore.FieldValue.delete(),
        notifyLockExpiresAt: firebaseAdmin.firestore.FieldValue.delete(),
        nextPingAt: firebaseAdmin.firestore.FieldValue.delete(),
      },
    };

    batch.set(doc.ref, patch, { merge: true });
    staged++;
    updated++;

    if (staged >= 400) {
      await batch.commit();
      console.log(`init-watchService: committed ${staged} updates (running total: ${updated})`);
      batch = db.batch();
      staged = 0;
    }
  }

  if (staged > 0) {
    await batch.commit();
    console.log(`init-watchService: committed ${staged} updates (final total: ${updated})`);
  }

  console.log(`init-watchService: done. updated=${updated}, skipped=${skipped}, total=${usersSnap.size}`);
  await firebaseAdmin.app().delete();
  process.exit(0);
})().catch((e) => {
  console.error('init-watchService: ERROR', e);
  firebaseAdmin.app().delete().finally(() => process.exit(1));
});
