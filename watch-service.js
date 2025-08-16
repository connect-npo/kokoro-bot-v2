// Firebase Admin SDKの初期化とFirestoreの取得
const admin = require('firebase-admin');
const serviceAccount = JSON.parse(Buffer.from(process.env.FIREBASE_CREDENTIALS_BASE64, 'base64').toString());

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();
const usersCollection = db.collection('users');

// LINE
if (!process.env.LINE_CHANNEL_ACCESS_TOKEN || !process.env.LINE_CHANNEL_SECRET) {
  console.error("❌ LINEトークン未設定: LINE_CHANNEL_ACCESS_TOKEN / LINE_CHANNEL_SECRET を設定してください。");
  process.exit(1);
}
const client = new line.Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
});

// --- 環境変数 ---
const EMERGENCY_CONTACT_PHONE_NUMBER = process.env.EMERGENCY_CONTACT_PHONE_NUMBER || '09048393313';
const OFFICER_GROUP_ID = process.env.OFFICER_GROUP_ID;
if (!OFFICER_GROUP_ID) {
  console.warn("⚠️ OFFICER_GROUP_ID が未設定です。緊急通知の送信先がありません。");
}

// --- ユーティリティ ---
async function safePushMessage(to, messages) {
  const arr = Array.isArray(messages) ? messages : [messages];
  try {
    await client.pushMessage(to, arr);
    console.log(`✅ Push -> ${to}`);
    // LINE API Rate対策で少しだけ待つ
    await new Promise(r => setTimeout(r, 120));
  } catch (e) {
    console.error(`❌ Push失敗 (${to}):`, e);
  }
}

// --- OKボタン付きのFlex（見守り用） ---
function buildWatchOkFlex(messageText = "こころちゃんです。元気にしてるかな？") {
  return {
    type: 'flex',
    altText: '見守りメッセージ',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'text', text: '見守りメッセージ', weight: 'bold', size: 'lg' },
          { type: 'text', text: messageText, wrap: true },
          { type: 'separator', margin: 'md' },
          {
            type: 'box',
            layout: 'vertical',
            margin: 'md',
            contents: [
              {
                type: 'button',
                style: 'primary',
                height: 'sm',
                action: {
                  type: 'postback',
                  label: '✅ 安心です（OK）',
                  data: 'watch_ok',
                  displayText: 'OK'
                }
              }
              // 相談ボタンを付けるなら↓を有効化
              // {
              //   type: 'button',
              //   style: 'secondary',
              //   margin: 'sm',
              //   height: 'sm',
              //   action: { type: 'postback', label: '🆘 相談する', data: 'watch_help', displayText: '相談' }
              // }
            ]
          }
        ]
      }
    }
  };
}

// --- 緊急通知（管理者向け）Flex ---
function buildEmergencyFlex(u, fallbackPhone, address) {
  return {
    type: 'flex',
    altText: '見守りサービス緊急通知',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'text', text: '🚨 見守りサービス緊急通知', weight: 'bold', size: 'lg', color: '#D32F2F' },
          { type: 'separator', margin: 'sm' },
          {
            type: 'box',
            layout: 'vertical',
            margin: 'md',
            contents: [
              { type: 'text', text: `👤 氏名：${u.full_name || '未登録'}`, wrap: true, size: 'sm' },
              { type: 'text', text: `📱 登録者電話：${u.phone || '未登録'}`, wrap: true, size: 'sm' },
              { type: 'text', text: `👤 緊急先氏名：${u.emergency_contact_name || '未登録'}`, wrap: true, size: 'sm' },
              { type: 'text', text: `📞 緊急先電話：${u.emergency_phone || fallbackPhone}`, wrap: true, size: 'sm' },
              { type: 'text', text: `🤝 関係性：${u.emergency_contact_relationship || '未登録'}`, wrap: true, size: 'sm' },
              { type: 'text', text: `🏠 住所：${address}`, wrap: true, size: 'sm' },
              { type: 'text', text: `🆔 LINE ID：${u.line_user_id || '未登録'}`, wrap: true, size: 'sm' }
            ]
          },
          { type: 'separator', margin: 'sm' },
          { type: 'text', text: '※29時間以上応答がないため自動送信されています', size: 'xs', color: '#666' }
        ]
      }
    }
  };
}

// --- 見守りメッセージ（30種類） ---
const watchMessages = [
  "こんにちは🌸 こころちゃんだよ！ 今日も元気にしてるかな？💖",
  "やっほー！ こころだよ😊 いつも応援してるね！",
  "元気にしてる？✨ こころちゃん、あなたのこと応援してるよ💖",
  "ねぇねぇ、こころだよ🌸 今日はどんな一日だった？",
  "いつもがんばってるあなたへ、こころからメッセージを送るね💖",
  "お元気ですか？こころちゃんです😊 素敵な一日を過ごせていますように！",
  "こんにちは！こころだよ🌸 毎日がんばっていて偉いね✨",
  "やっほー！今日も一日お疲れ様💖 少しでもホッとできる時間がありますように。",
  "ねぇ、こころだよ😊 困ったことがあったらいつでも話してね！",
  "こんにちは🌸 あなたのことが気になってメッセージしちゃった💖",
  "やっほー！こころちゃんです😊 元気に過ごしてるかな？",
  "元気出してね！こころちゃんはいつもあなたの味方だよ💖",
  "こんにちは✨ こころちゃん、あなたのことを想ってるよ😊",
  "やっほー！気分転換に何か楽しいこと見つかったかな？💖",
  "元気かな？🌸 こころだよ！もしよかったらお話しようね😊",
  "こんにちは💖 こころちゃんです！あなたの笑顔が見たいな✨",
  "やっほー😊 久しぶりにメッセージしちゃった！元気にしてる？",
  "ねぇ、こころだよ🌸 今、何してるのかな？💖",
  "元気？😊 こころちゃんです！何か良いことあった？",
  "こんにちは✨ こころだよ！もし疲れたら無理しないでね💖",
  "やっほー！今日も一日お疲れ様🌸 ゆっくり休んでね😊",
  "ねぇねぇ、こころだよ💖 忙しい毎日だけど、息抜きも大切だよ✨",
  "元気にしてるかな？こころちゃんはいつもここにいるよ😊",
  "こんにちは！🌸 こころだよ！あなたのこと、いつも考えてるよ💖",
  "やっほー！こころちゃんです😊 お話するの、楽しみにしているね！",
  "元気？💖 もしよかったら、最近のことを話してくれないかな？",
  "こんにちは✨ こころだよ！何か手伝えることがあったら言ってね😊",
  "やっほー！今日もがんばってるね🌸 応援してるよ💖",
  "ねぇ、こころだよ😊 あなたの存在が、私にとって大切だよ✨",
  "元気かな？💖 こころちゃんです！あなたの毎日が幸せでありますように！"
];

// --- 本体 ---
async function runWatchService() {
  try {
    console.log("⏰ 見守りステータス確認開始");
    const now = Timestamp.now().toDate();
    const oneDayMs = 24 * 60 * 60 * 1000;

    const q = db.collection('users').where('watchServiceEnabled', '==', true);
    const snapshot = await q.get();

    for (const doc of snapshot.docs) {
      try {
        const user = doc.data();
        const userId = doc.id;

        // 直近アクション（OK or 直近の定期送信）
        const lastOk = user.lastOkResponse ? user.lastOkResponse.toDate() : new Date(0);
        const lastSched = user.lastScheduledWatchMessageSent ? user.lastScheduledWatchMessageSent.toDate() : new Date(0);
        const lastAction = lastOk > lastSched ? lastOk : lastSched;
        const diffMs = now.getTime() - lastAction.getTime();

        // 初回暴発ガード（ユーザー作成から72h以上）
        const createdAt = user.createdAt ? user.createdAt.toDate() : null;
        const eligibleForNewMessage =
          diffMs >= 3 * oneDayMs &&
          (!createdAt || (now.getTime() - createdAt.getTime()) >= 3 * oneDayMs);

        // 3日経過：OKボタン付きメッセージ
        if (eligibleForNewMessage) {
          const msg = watchMessages[Math.floor(Math.random() * watchMessages.length)];
          const flex = buildWatchOkFlex(msg);
          await safePushMessage(userId, flex);
          await doc.ref.update({
            lastScheduledWatchMessageSent: Timestamp.now(),
            firstReminderSent: false,
            emergencyNotificationSent: false
          });
          continue;
        }

        // 24時間経過：リマインド（まだ送っていない場合）
        if (diffMs >= oneDayMs && !user.firstReminderSent) {
          await safePushMessage(userId, { type: 'text', text: '前回のメッセージから24時間が経過しました。大丈夫ですか？' });
          await doc.ref.update({ firstReminderSent: true });
        }

        // 29時間経過：管理者に緊急通知（氏名/電話/関係性/住所/LINE ID 全部）
        else if (diffMs >= 29 * 60 * 60 * 1000 && user.firstReminderSent && !user.emergencyNotificationSent) {
          // 住所はあるものを結合してフル化
          const address =
            user.address_full ||
            [user.prefecture, user.city, user.address_line1, user.address_line2]
              .filter(Boolean)
              .join(' ') ||
            user.city || '未登録';

          if (OFFICER_GROUP_ID) {
            const flex = buildEmergencyFlex(user, EMERGENCY_CONTACT_PHONE_NUMBER, address);
            await safePushMessage(OFFICER_GROUP_ID, flex);
          }
          await doc.ref.update({ emergencyNotificationSent: true });
        }
      } catch (e) {
        console.error(`ユーザー ${doc.id} 処理中エラー:`, e);
      }
    }
    console.log("✅ 見守りステータス確認完了");
  } catch (err) {
    console.error("❌ 実行エラー:", err);
  }
}

// --- 実行（RenderのCronから呼ばれる想定） ---
if (require.main === module) {
  runWatchService()
    .then(() => {
      console.log("🏁 watch-service.js 正常終了");
      process.exit(0);
    })
    .catch(err => {
      console.error("💥 watch-service.js 実行中エラー:", err);
      process.exit(1);
    });
}
