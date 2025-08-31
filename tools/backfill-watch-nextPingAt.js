'use strict';
const firebaseAdmin = require('firebase-admin');
const dayjs = require('dayjs'); const utc = require('dayjs/plugin/utc'); const tz = require('dayjs/plugin/timezone');
dayjs.extend(utc); dayjs.extend(tz);
const JST='Asia/Tokyo';

const FIREBASE_CREDENTIALS_BASE64 = process.env.FIREBASE_CREDENTIALS_BASE64 || '';
if (!FIREBASE_CREDENTIALS_BASE64) { console.error('FIREBASE_CREDENTIALS_BASE64 未設定'); process.exit(1); }
const cred = JSON.parse(Buffer.from(FIREBASE_CREDENTIALS_BASE64, 'base64').toString('utf-8'));
firebaseAdmin.initializeApp({ credential: firebaseAdmin.credential.cert(cred) });
const db = firebaseAdmin.firestore();

const nextPingAtFrom = (from) => dayjs(from).tz(JST).add(3,'day').hour(15).minute(0).second(0).millisecond(0).toDate();
// 即時送出したい時は ↑ を「dayjs(from).subtract(1,'minute').toDate()」に変更

(async () => {
  const snap = await db.collection('users').where('watchService.enabled','==',true).get();
  let batch = db.batch(), n=0, up=0;
  snap.forEach(doc => {
    const ws = (doc.data().watchService)||{};
    if (!ws.awaitingReply && !ws.nextPingAt) {
      batch.set(doc.ref, { watchService: {
        nextPingAt: firebaseAdmin.firestore.Timestamp.fromDate(nextPingAtFrom(new Date())),
        awaitingReply: false,
        lastReminderAt: firebaseAdmin.firestore.FieldValue.delete(),
        notifyLockExpiresAt: firebaseAdmin.firestore.FieldValue.delete(),
      }}, { merge:true });
      n++; up++;
      if (n >= 400) { batch.commit(); batch = db.batch(); n=0; }
    }
  });
  if (n>0) await batch.commit();
  console.log('backfill updated:', up);
  await firebaseAdmin.app().delete(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
