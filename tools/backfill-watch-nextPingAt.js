// tools/backfill-watch-nextPingAt.js
'use strict';

const firebaseAdmin = require('firebase-admin');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const tz = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(tz);

const JST = 'Asia/Tokyo';

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

// nextPingAt を「今から15分後」にセット
const nextPingAtFrom = (from = new Date()) =>
  dayjs(from).tz(JST).add(15, 'minute').second(0).millisecond(0).toDate();

(async () => {
  console.log('backfill-watch-nextPingAt: start');

  const snap = await db.collection('users').where('watchService.enabled', '==', true).get();
  let batch = db.batch(), count = 0, updated = 0;

  snap.forEach(doc => {
    const ws = doc.data().watchService || {};
    if (!ws.awaitingReply && !ws.nextPingAt) {
      batch.update(doc.ref, {
        'watchService.nextPingAt': firebaseAdmin.firestore.Timestamp.fromDate(nextPingAtFrom(new Date())),
        'watchService.awaitingReply': false,
        'watchService.lastReminderAt': firebaseAdmin.firestore.FieldValue.delete(),
        'watchService.lastCheckinMessageAt': firebaseAdmin.firestore.FieldValue.delete(),
      });
      count++;
      updated++;
      if (count >= 400) {
        batch.commit();
        batch = db.batch();
        count = 0;
      }
    }
  });

  if (count > 0) {
    await batch.commit();
  }

  console.log(`backfill-watch-nextPingAt: completed, updated ${updated} users`);
  process.exit(0);
})();
