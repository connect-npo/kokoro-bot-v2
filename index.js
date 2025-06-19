require('dotenv').config();

const express = require('express');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { Client, middleware } = require('@line/bot-sdk');

const app = express();

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

const client = new Client(config);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const dangerWords = [
  'しにたい', '死にたい', '自殺', '消えたい', 'いなくなりたい', '助けて', '限界',
  '働きすぎ', 'つらい', '苦しい', '疲れた', '眠れない', '孤独', '絶望',
  'リストカット', 'リスカ', 'OD', 'オーバードーズ', '薬', '睡眠薬', '大量服薬',
  '殴られる', 'たたかれる', '暴力', '家庭内暴力', 'DV', '虐待', '怒鳴られる',
  'いじめ', '無視される', '仲間はずれ', '学校にいけない', '登校できない', '教室に入れない',
  'お金がない', 'お金が足りない', '借金', '貧乏', '生活できない', '家賃が払えない',
  '誰もわかってくれない', 'もうだめ', '死にたいです', '人生終わった', '逃げたい', '死にたくなる'
];

const groupId = process.env.LINE_GROUP_ID;

app.post('/webhook', middleware(config), express.json(), async (req, res) => {
  try {
    const events = req.body.events;

    for (const event of events) {
      if (event.type === 'message' && event.message.type === 'text') {
        const userMessage = event.message.text;
        const replyToken = event.replyToken;

        const matchedWord = dangerWords.find(word => userMessage.includes(word));

        if (matchedWord) {
          await axios.post(
            'https://api.line.me/v2/bot/message/push',
            {
              to: groupId,
              messages: [
                {
                  type: 'text',
                  text: `⚠️ 危険ワードを検知しました: 「${matchedWord}」📞 至急対応してください。📱 090-4839-3313`
                }
              ]
            },
            {
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${config.channelAccessToken}`
              }
            }
          );
        }

        // Gemini APIでの応答生成
        const model = genAI.getGenerativeModel({ model: 'gemini-pro' });

        const result = await model.generateContent([
          {
            role: 'user',
            parts: [
              {
                text: `あなたは「こころちゃん」という14歳のやさしい女の子です。相談者に寄り添い、絵文字を交えて可愛く、1〜2文の短文で応答してください。\n\n${userMessage}`
              }
            ]
          }
        ]);

        const replyText = result.response.text();

        await client.replyMessage(replyToken, [
          {
            type: 'text',
            text: replyText
          }
        ]);
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('❌ Webhook処理エラー:', err);
    res.status(500).end();
  }
});

const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log(`✅ Server running on port ${port}`);
});
