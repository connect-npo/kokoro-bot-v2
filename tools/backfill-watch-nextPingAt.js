// tools/init-watchService.js
'use strict';

/**
 * usersコレクションで watchService が未作成のユーザーに
 * 最低限のフィールドを一括付与する初期化スクリプト。
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
  let staged = 0, updated = 0;

  usersSnap.forEach(doc => {
    const data = doc.data();
    if (!data.watchService) {
      const ref = doc.ref;
      batch.update(ref, {
        watchService: {
          enabled: true,
          isEnabled: true,
          awaitingReply: false,
          enrolledAt: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
          lastNotifiedAt: null,
          lastPingAt: null,
          lastRepliedAt: null,
          lastRepliedMessage: null,
          lastReplyReason: null,
          privacyPolicyVersion: "v1"
        }
      });
      staged++;
      if (staged >= 400) {
        batch.commit();
        batch = db.batch();
        staged = 0;
      }
      updated++;
    }
  });

  if (staged > 0) {
    await batch.commit();
  }

  console.log(`init-watchService: completed, updated ${updated} users`);
  process.exit(0);
})();
