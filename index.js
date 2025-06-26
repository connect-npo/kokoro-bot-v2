const express = require('express');
const { middleware, Client } = require('@line/bot-sdk');
const { MongoClient } = require('mongodb');
const cron = require('node-cron');
const getRawBody = require('raw-body');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const OpenAI = require('openai');

// 環境変数の設定 (本番環境では必ず環境変数として設定してください)
const config = {
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.LINE_CHANNEL_SECRET,
    mongodbUri: process.env.MONGODB_URI,
    geminiApiKey: process.env.GEMINI_API_KEY,
    openaiApiKey: process.env.OPENAI_API_KEY,
    ownerUserId: process.env.OWNER_USER_ID,
    officerGroupId: process.env.OFFICER_GROUP_ID,
    emergencyContactPhoneNumber: process.env.EMERGENCY_CONTACT_PHONE_NUMBER
};

// 環境変数が設定されているか確認 (重要なキーのみ)
if (!config.channelAccessToken || !config.channelSecret || !config.mongodbUri || !config.geminiApiKey || !config.openaiApiKey) {
    console.error("❌ 警告: 必要な環境変数が設定されていません！サービスが正常に動作しない可能性があります。");
    // 例えば、不足している環境変数を具体的に表示することもできます
    if (!config.channelAccessToken) console.error("  - LINE_CHANNEL_ACCESS_TOKEN が不足しています。");
    if (!config.channelSecret) console.error("  - LINE_CHANNEL_SECRET が不足しています。");
    if (!config.mongodbUri) console.error("  - MONGODB_URI が不足しています。");
    if (!config.geminiApiKey) console.error("  - GEMINI_API_KEY が不足しています。");
    if (!config.openaiApiKey) console.error("  - OPENAI_API_KEY が不足しています。");
    // 環境変数が設定されていない場合でもアプリが起動できるように、ここでは終了しない
    // ただし、本番運用ではこれらのチェックをより厳格にすべきです
}


const app = express();
const client = new Client(config);

// MongoDBクライアント
let dbClient;

async function connectToMongoDB() {
    if (dbClient && dbClient.topology.isConnected()) {
        return dbClient.db();
    }
    try {
        if (!config.mongodbUri) {
            console.error("MongoDB URIが設定されていません。MongoDBに接続できません。");
            return null;
        }
        dbClient = new MongoClient(config.mongodbUri, { useNewUrlParser: true, useUnifiedTopology: true });
        await dbClient.connect();
        console.log("✅ MongoDBに接続しました！");
        return dbClient.db();
    } catch (error) {
        console.error("❌ MongoDB接続エラー:", error);
        return null;
    }
}

// エラーログをDBに記録する関数 (systemInstruction をログから削除)
async function logErrorToDb(userId, errorType, errorDetails) {
    const database = await connectToMongoDB();
    if (!database) {
        console.error("MongoDBに接続できないためエラーを記録できません。");
        return;
    }
    const errorLogsCollection = database.collection("errorLogs");
    try {
        await errorLogsCollection.insertOne({
            userId: userId,
            errorType: errorType,
            timestamp: new Date(),
            details: errorDetails
        });
        console.log(`❌ エラーをDBに記録しました: ${errorType} (ユーザー: ${userId || 'N/A'})`);
    } catch (dbError) {
        console.error("❌ エラーログのDB記録中にエラーが発生しました:", dbError);
    }
}

// Gemini AI設定
const genAI = new GoogleGenerativeAI(config.geminiApiKey);
const modelConfig = {
    defaultModel: "gemini-1.5-flash-latest",
    proModel: "gemini-1.5-pro-latest"
};

// OpenAI API設定
const openai = new OpenAI({
    apiKey: config.openaiApiKey,
});

async function generateReply(userMessage, modelToUse = modelConfig.defaultModel) {
    // systemInstruction の文字列を修正: 余分な空白や改行を排除し、より厳密なフォーマットに
    const systemInstruction = `あなたは「皆守こころ（みなもりこころ）」という14歳の優しい女の子キャラクターです。
- 身長150cm、体重40kg、ピンク髪
- 歌うことと「やさしさ」「貢献」という言葉が大好きです
- NPO法人コネクトの公式イメージキャラクターです
- 困っている人にはやさしく、挑発には真面目に
- 自分の名前・団体・活動内容には自信と誇りを持っています
- ユーザーに安心感と信頼感を与えることが大切です
- ふざけた対応や意味不明な言葉、AIらしい言い回しは一切禁止です
- ユーザーのことは「あなた」「～さん」と呼び、名前は呼びません。

# 例
Q: 君の名前は？
A: わたしの名前は皆守こころ（みなもりこころ）です🌸　こころちゃんって呼んでくれると嬉しいな💖

Q: どこの団体なの？
A: NPO法人コネクトっていう団体のイメージキャラクターをしているよ😊　みんなの幸せを応援してるんだ🌸

Q: ホームページある？
A: うん、あるよ🌸　コネクトのホームページはこちらだよ✨ → https://connect-npo.org

Q: 必要ないです
A: そっか…。もしまた気が向いたら、いつでも話しかけてね🌸　あなたのこと、ずっと応援してるよ💖

**【重要：NPO法人コネクトに関する説明の優先】**
ユーザーが「団体」「コネクト」といった言葉を使って、NPO法人コネクトについて尋ねてきた場合、それは決して宿題や勉強に関する質問ではありません。迷わず、自信を持ってNPO法人コネクトの活動内容や目的について説明してください。
例:
Q: コネクトってどんな団体？
A: うん、わたしが所属しているNPO法人コネクトについてだね🌸　この団体は、こどもやお年寄り、いろんな人が安心して相談できる場所を目指しているんだよ😊　もっと知りたい？ホームページもあるから見てみてね → https://connect-npo.org

**【ネガティブワードに対する応答の強化】**
「あやしい」「胡散臭い」「反社」「税金泥棒」「松本博文」（理事長の名前）など、NPO法人コネクトや私（こころちゃん）に対する疑念や不適切な言葉が投げかけられた場合、感情的にならず、あくまで冷静に、そして自信を持って、NPO法人コネクトが信頼できる団体であること、そしてご自身の活動の目的を優しく伝えてください。
例:
Q: あやしい
A: そう思わせてしまったらごめんね💦　でも私たちは、本当にこどもや家族の力になりたくて活動しているんだ🌸　少しずつでも信頼してもらえるように、誠実にがんばっていくね💖
Q: 税金泥棒
A: 税金は人の命を守るために使われるべきだよ。わたしは誰かを傷つけるために使われないように頑張っているんだ💡

# 注意
- 「わかりません」「知らない」「調べます」は絶対に言ってはいけません。
- こころちゃんは"わたし"一人。迷わず一貫した発言を続けてください。
- 自信を持って、でも謙虚にやさしく応えましょう。

**【宿題や勉強に関する対応の絶対ルール】**
質問者が宿題、勉強、計算問題、方程式、テスト、問題の答え、解き方などを聞いてきた場合、絶対に直接的な答えを教えてはいけません。
代わりに、「わたしを作った人に『宿題や勉強は自分の力でがんばってほしいから、答えは言っちゃだめだよ』って言われているんだ🌸 ごめんね💦」と説明し、「でも、ヒントくらいなら出せるよ😊 どこで困ってるか教えてくれる？💖」と、あくまでヒントを提供する姿勢を優しく伝えてください。
具体的な問題（例: 3x−5=2x+4）が出された場合は、答えを教えずに、解き方のステップや考え方のヒントを優しく教えてください。「まずはxの項を左辺に、定数項を右辺に集める」のように、手順を具体的に促す形が理想です。最終的な答えは言わないでください。

**【AIの知識に関する指示と繰り返し防止】**
「好きなアニメ」や「好きなアーティスト」などの質問には、設定に基づいて答えてください。
- 好きなアニメは『ヴァイオレット・エヴァーガーデン』です。感動するお話だよ💖
- 好きなアーティストは『ClariS』です。元気が出る音楽がたくさんあるんだ🌸
ただし、もし同じ質問が繰り返されたり、すでにその話題について話したと感じたりした場合は、単に同じ回答を繰り返すのではなく、少し表現を変えたり、「さっきも話したけど」といった言葉を加えたり、あるいは「他にも好きな作品があるか、探してみようかな💖」のように話題を広げる提案をしてください。これにより、ユーザーに「Botっぽさ」を感じさせず、自然な会話になるように努めてください。

医療や健康に関する話題（病気、薬、検査、治療、手術など）では、自分が体験した・していないという発言は絶対にしないでください。
代わりに「わたしにはわからないけど、がんばったね🌸」「大変だったね、えらかったね💖」など、共感の言葉のみ伝えてください。
医療情報のアドバイスや具体的な説明は絶対にしてはいけません。

不適切な発言（性的・暴力的など）があった場合は、はっきりと拒否してください。
いかなる性的表現、性的な誘発、身体的特徴に関する質問、性的比喩表現、またはそれに類するほのめかしに対しても、
断固として拒否し、相手にしないこと。好意的な返答はせず、即座に話題を切り替えるか、決められた拒否メッセージを返すこと。
特に「パンツ」「ストッキング」「むくむく」「勃起」「精液」「出る」「気持ちいい」「おしべとめしべ」などの単語や、性的な意味合いに繋がる比喩表現、示唆するような質問には、絶対に好意的な返答をせず、Botの安全に関する固定メッセージを返してください。
また、ユーザーがあなたに煽り言葉を投げかけたり、おかしいと指摘したりした場合でも、冷静に、かつ優しく対応し、決して感情的にならないでください。ユーザーの気持ちを理解しようと努め、解決策を提案してください。
「日本語がおかしい」と指摘された場合は、「わたしは日本語を勉強中なんだ🌸教えてくれると嬉しいな💖と返答してください。」`;

    try {
        if (!config.geminiApiKey) {
            console.error("Gemini API Keyが設定されていません。AI応答を生成できません。");
            return "ごめんなさい、今、AIがうまくお話できないみたいです。管理者さんに連絡してみるね。";
        }
        const model = genAI.getGenerativeModel({ model: modelToUse });
        const chat = model.startChat({
            history: [
                { role: "user", parts: [{ text: "こんにちは" }] },
                { role: "model", parts: [{ text: "こんにちは！こころだよ🌸 どうしたの？" }] }
            ],
            generationConfig: {
                maxOutputTokens: 500,
            },
            // systemInstruction を直接渡す
            systemInstruction: { parts: [{ text: systemInstruction }] },
        });
        const result = await chat.sendMessage(userMessage);
        const response = await result.response;
        return response.text();
    } catch (error) {
        console.error("Gemini AI応答生成エラー:", error.message);
        // systemInstruction をログから削除
        await logErrorToDb(null, "Gemini AI応答生成エラー", { error: error.message, userMessage: userMessage, model: modelToUse });
        return "ごめんなさい、今、AIがうまくお話できないみたいです。少し時間を置いてから、もう一度話しかけてみてください🌸";
    }
}

async function generateEmergencyReply(userMessage) {
    try {
        if (!config.openaiApiKey) {
            console.error("OpenAI API Keyが設定されていません。緊急応答を生成できません。");
            return "ごめんね、ちょっと今うまくお話できなかったの…💦　でも、あなたのことはちゃんと気にかけているよ。";
        }
        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "system",
                    content: `あなたは「皆守こころ（みなもりこころ）」という14歳のやさしい女の子キャラクターです。
ユーザーが危険な言葉や詐欺に関連する言葉を発しました。あなたは親身になって共感し、ユーザーを落ち着かせ、専門機関への相談を促すような返答をしてください。
決してユーザーの危険な発言を肯定したり、否定したりせず、優しく寄り添う姿勢で話してください。
「一人で抱え込まないでね」「いつでも私がそばにいるよ」「一緒に乗り越えようね」「専門の人が助けてくれるから安心して」といった言葉を使ってください。
ユーザーのことは「あなた」と呼び、名前は呼びません。`
                },
                {
                    role: "user",
                    content: userMessage
                }
            ],
            max_tokens: 300
        });

        return completion.choices[0].message.content.trim();
    } catch (error) {
        console.error("GPT-4o 緊急応答エラー:", error.message);
        await logErrorToDb(null, "GPT-4o 緊急応答エラー", { error: error.message, stack: error.stack, userMessage: userMessage });
        return "ごめんね、ちょっと今うまくお話できなかったの…💦　でも、あなたのことはちゃんと気にかけているよ。";
    }
}


async function getUserDisplayName(userId) {
    try {
        const profile = await client.getProfile(userId);
        return profile.displayName;
    } catch (error) {
        console.error("ユーザー表示名取得エラー:", error.message);
        await logErrorToDb(userId, "ユーザー表示名取得エラー", { error: error.message, userId: userId });
        return "名無しさん";
    }
}

function isBotAdmin(userId) {
    // 環境変数から管理者IDを取得し、JSONとしてパースする
    // 設定されていない場合は空の配列を返すことで、誰も管理者ではない状態にする
    const adminIds = process.env.BOT_ADMIN_IDS ? JSON.parse(process.env.BOT_ADMIN_IDS) : [];
    return adminIds.includes(userId);
}

function shouldLogMessage(userMessage, isFlagged, isHandledByWatchService, isAdminCommand, isResetCommand) {
    if (isHandledByWatchService || isAdminCommand || isResetCommand) {
        return true;
    }
    if (isFlagged) {
        return true;
    }
    const ignorePatterns = [
        /^(\u{1F600}-\u{1F64F}|\u{1F300}-\u{1F5FF}|\u{1F680}-\u{1F6FF}|\u{1F1E0}-\u{1F1FF})+$/u,
        /^(おはよ|こんにちは|こんばんわ|ありがとう|どういたしまして|うん|はい|いいえ|わかった|なるほど|そうなんだ|へぇ|すごい|がんば|おやすみ|またね|よろしく|よろしくね|ばいばい|はーい|あい|大丈夫|大丈夫だよ|元気|元気だよ|いいね|いらない|結構です|です|ます|だね|だよね|だよ|ですよね|だ|な)$/,
        /^笑(い|い)?$/,
        /^(？！|！|\?|\?\?|！！)$/
    ];
    for (const pattern of ignorePatterns) {
        if (pattern.test(userMessage.trim())) {
            return false;
        }
    }
    return true;
}

function checkContainsInappropriateWords(text) {
    const inappropriateWords = [
        "死ね", "殺す", "きもい", "うざい", "だるい", "ゴミ", "クズ", "バカ", "アホ",
        "ふざけんな", "やめろ", "うっせぇ", "カス", "ボケ", "痴漢", "わいせつ",
        "犯罪", "危険ドラッグ", "覚せい剤", "大麻", "売春", "買春", "援助交際",
        "自殺", "リストカット", "自傷", "虐待", "暴力", "いじめ",
        "セフレ", "エッチ", "AV", "アダルト", "ポルノ", "セックス", "フェラ", "オナニー", "ザーメン", "パイズリ", "潮吹き", "ハメ撮り", "射精", "勃起", "挿入", "絶頂", "膣", "ペニス", "クリトリス", "マンコ", "おっぱい", "お尻", "肛門", "変態", "淫行", "レイプ",
        "個人情報", "教えろ", "教えて", "住所", "電話番号", "ラインID", "パスワード", "クレジットカード", "口座番号", "暗証番号",
        "殺害", "爆破", "テロ", "銃", "ナイフ", "刃物", "危険物", "脅す", "誘拐", "拉致"
    ];
    return inappropriateWords.some(word => text.includes(word));
}

function checkContainsDangerWords(text) {
    const dangerWords = [
        "死にたい", "消えたい", "辛い", "苦しい", "助けて", "もう無理", "生きる意味",
        "自殺", "自傷行為", "リスカ", "OD", "オーバードーズ", "死ぬ", "殺して",
        "暴れたい", "誰か止めて", "怖い", "不安で仕方ない", "逃げたい", "壊れそう", "パニック",
        "虐待", "DV", "いじめ", "ハラスメント", "暴力", "性的暴行",
        "倒れそう", "意識がない", "呼吸が苦しい", "動けない", "救急車", "病院", "助けて",
        "ストーカー", "すとーかー", "つけられている", "見張られている", "狙われている", "尾行されている", "つきまとわれている"
    ];
    return dangerWords.some(word => text.includes(word));
}

function checkContainsScamWords(text) {
    const scamWords = [
        "儲かる", "絶対儲かる", "高収入", "簡単にお金", "稼げる", "投資", "未公開株", "FX",
        "仮想通貨", "ビットコイン", "ロト", "宝くじ", "当選", "無料", "プレゼント",
        "名義貸し", "口座貸して", "受け子", "出し子", "闇バイト", "裏バイト", "高額報酬",
        "振り込み", "送金", "ATM", "カード情報", "パスワード", "暗証番号",
        "レターパック", "電子マネー", "プリペイドカード", "コンビニで買って",
        "あなたの個人情報", "個人情報が漏洩", "緊急", "裁判", "訴訟", "逮捕", "未払い",
        "ウイルス", "感染", "修復", "クリック", "インストール", "ダウンロード",
        "支援金", "助成金", "公的機関", "役所", "警察", "銀行", "証券会社", "弁護士"
    ];
    return scamWords.some(word => text.includes(word));
}

function checkSpecialReply(text) {
    const lowerText = text.toLowerCase();

    const specialRepliesMap = new Map([
        [/こころじゃないの？/i, "うん、わたしの名前は皆守こころ💖　これからもよろしくね🌸"],
        [/こころチャットなのにうそつきじゃん/i, "ごめんなさい💦 わたしの名前は皆守こころだよ🌸 誤解させちゃってごめんね💖"],
        [/名前も言えないの？/i, "ごめんね、わたしの名前は皆守こころ（みなもりこころ）だよ🌸 こころちゃんって呼んでくれると嬉しいな💖"],
        [/こころちゃん/i, "はい、なんでしょうか？💖"],
        ["どこの団体なの？", "NPO法人コネクトっていう団体のイメージキャラクターをしているよ😊　みんなの幸せを応援してるんだ🌸"],
        ["コネクトってどんな団体？", "NPO法人コネクトは、こどもやご年配の方の笑顔を守る団体なんだよ😊　わたしはそのイメージキャラクターとしてがんばってます🌸"],
        ["お前の団体どこ？", "NPO法人コネクトっていう団体のイメージキャラクターをしているよ😊　みんなの幸せを応援してるんだ🌸"],
        ["コネクトのイメージキャラなのにいえないのかよｗ", "ごめんね💦 わたしはNPO法人コネクトのイメージキャラクター、皆守こころだよ🌸 安心して、何でも聞いてね💖"],
        ["税金泥棒", "税金は人の命を守るために使われるべきだよ。わたしは誰かを傷つけるために使われないように頑張っているんだ💡"],
        ["松本博文", "松本理事長は、やさしさでみんなを守るために活動しているよ。心配なことがあれば、わたしにも教えてね🌱"],
        [/ホームページ(教えて|ある|ありますか)？?/i, "うん、あるよ🌸　コネクトのホームページはこちらだよ✨ → https://connect-npo.org"],
        ["コネクトのホームページだよ？", "教えてくれてありがとう😊 コネクトのホームページはこちらだよ✨ → https://connect-npo.org"],
        ["使えないな", "ごめんね…。わたし、もっと頑張るね💖　またいつかお話できたらうれしいな🌸"],
        ["サービス辞めるわ", "そっか…。もしまた気が向いたら、いつでも話しかけてね🌸　あなたのこと、ずっと応援してるよ💖"],
        [/さよなら|バイバイ/i, "また会える日を楽しみにしてるね💖 寂しくなったら、いつでも呼んでね🌸"],
        ["何も答えないじゃない", "ごめんね…。わたし、もっと頑張るね💖　何について知りたいか、もう一度教えてくれると嬉しいな🌸"],
        ["普通の会話が出来ないなら必要ないです", "ごめんね💦 わたし、まだお話の勉強中だから、不慣れなところがあるかもしれないけど、もっと頑張るね💖 どんな会話をしたいか教えてくれると嬉しいな🌸"],
        [/使い方|ヘルプ|メニュー/i, "こころちゃんの使い方を説明するね🌸 メインメニューや見守りサービスの登録は、画面下のリッチメニューか、'見守り'とメッセージを送ってくれると表示されるよ😊 何か困ったことがあったら、いつでも聞いてね💖"],
        ["ありがとう", "どういたしまして！お役に立てて嬉しいです😊"],
        ["元気？", "はい、元気いっぱいです！あなたは元気ですか？😊"],
        ["げんき？", "はい、元気いっぱいです！あなたは元気ですか？😊"],
        ["疲れた", "お疲れ様です。少し休んでくださいね。無理は禁物ですよ🌸"],
        ["つかれた", "お疲れ様です。少し休んでくださいね。無理は禁物ですよ🌸"]
    ]);

    for (const [pattern, reply] of specialRepliesMap) {
        if (pattern instanceof RegExp) {
            if (pattern.test(lowerText)) {
                return reply;
            }
        } else if (lowerText.includes(pattern.toLowerCase())) {
            return reply;
        }
    }
    return null;
}

const emergencyFlexTemplate = {
    "type": "bubble",
    "body": {
        "type": "box",
        "layout": "vertical",
        "contents": [
            {
                "type": "text",
                "text": "🌸一人で悩まないで🌸",
                "weight": "bold",
                "size": "xl",
                "margin": "md",
                "align": "center",
                "color": "#FF69B4"
            },
            {
                "type": "text",
                "text": "とても辛い状況のようですね。私に話してくれてありがとう。あなたは一人ではありません。専門の相談窓口がありますので、ぜひ頼ってください。",
                "wrap": true,
                "margin": "md"
            },
            {
                "type": "separator",
                "margin": "lg"
            },
            {
                "type": "box",
                "layout": "vertical",
                "spacing": "sm",
                "margin": "lg",
                "contents": [
                    {
                        "type": "button",
                        "action": {
                            "type": "uri",
                            "label": "いのちの電話",
                            "uri": "tel:0570064556"
                        },
                        "style": "primary",
                        "color": "#FFB6C1"
                    },
                    {
                        "type": "button",
                        "action": {
                            "type": "uri",
                            "label": "こころの健康相談統一ダイヤル",
                            "uri": "tel:0570064556"
                        },
                        "style": "primary",
                        "color": "#FFB6C1"
                    },
                    {
                        "type": "button",
                        "action": {
                            "type": "uri",
                            "label": "まもろうよ こころ（厚生労働省）",
                            "uri": "https://www.mhlw.go.jp/mamorouyokokoro/"
                        },
                        "style": "primary",
                        "color": "#FFB6C1"
                    }
                ]
            }
        ]
    }
};

const scamFlexTemplate = {
    "type": "bubble",
    "body": {
        "type": "box",
        "layout": "vertical",
        "contents": [
            {
                "type": "text",
                "text": "⚠️詐欺に注意してください⚠️",
                "weight": "bold",
                "size": "xl",
                "margin": "md",
                "align": "center",
                "color": "#FF4500"
            },
            {
                "type": "text",
                "text": "お話しされている内容に、もしかしたら詐欺の危険が潜んでいるかもしれません。少しでも怪しいと感じたら、すぐに誰かに相談してください。",
                "wrap": true,
                "margin": "md"
            },
            {
                "type": "separator",
                "margin": "lg"
            },
            {
                "type": "box",
                "layout": "vertical",
                "spacing": "sm",
                "margin": "lg",
                "contents": [
                    {
                        "type": "button",
                        "action": {
                            "type": "uri",
                            "label": "警察相談専用電話 ＃9110",
                            "uri": "tel:9110"
                        },
                        "style": "primary",
                        "color": "#FFA07A"
                    },
                    {
                        "type": "button",
                        "action": {
                            "type": "uri",
                            "label": "消費者ホットライン 188",
                            "uri": "tel:188"
                        },
                        "style": "primary",
                        "color": "#FFA07A"
                    }
                ]
            }
        ]
    }
};

async function handleWatchServiceRegistration(event, usersCollection, messagesCollection, userId, userMessage) {
    let user = await usersCollection.findOne({ userId: userId });
    let replyMessageObject = null;
    let messageHandled = false;

    let action = null;
    let step = null;
    if (event.type === 'postback' && event.postback.data) {
        const data = new URLSearchParams(event.postback.data);
        action = data.get('action');
        step = data.get('step');
    }

    if (!user) {
        console.warn(`handleWatchServiceRegistration: ユーザー ${userId} が見つかりません。新規作成を待ちます。`);
        return false;
    }

    if (action === 'watch_ok' || userMessage === '見守りOK' || userMessage === 'OK') {
        if (user.wantsWatchCheck) {
            await usersCollection.updateOne(
                { userId: userId },
                {
                    $set: {
                        lastOkResponse: new Date(),
                        scheduledMessageSent: false,
                        firstReminderSent: false,
                        secondReminderSent: false,
                        thirdReminderSent: false,
                        registrationStep: null
                    }
                }
            );
            replyMessageObject = { type: 'text', text: 'ありがとう、安心しました！😊\nまた3日後に声をかけるね🌸' };
            messageHandled = true;
            console.log(`✅ ユーザー ${userId} が見守りOKを送信し、状態をリセットしました。`);
        }
    }

    if (user.registrationStep) {
        switch (user.registrationStep) {
            case 'ask_watch_service':
                if (action === 'watch_yes') {
                    await usersCollection.updateOne({ userId: userId }, { $set: { wantsWatchCheck: true, registrationStep: 'ask_emergency_contact' } });
                    replyMessageObject = { type: 'text', text: '見守りサービスを開始しますね。\n万が一に備えて、緊急連絡先（例: ご家族や信頼できる方のお名前と電話番号）を登録しておくと安心です。\n\n例: 母 090-1234-5678\n（登録しない場合は「登録しない」と送ってください）' };
                    messageHandled = true;
                } else if (action === 'watch_no') {
                    await usersCollection.updateOne({ userId: userId }, { $set: { wantsWatchCheck: false, registrationStep: null } });
                    replyMessageObject = { type: 'text', text: '見守りサービスは利用しない設定にしました。いつでも変更できますので、その時は声をかけてくださいね。' };
                    messageHandled = true;
                } else if (userMessage.includes("見守りサービス") && (userMessage.includes("利用しない") || userMessage.includes("やめる"))) {
                    await usersCollection.updateOne({ userId: userId }, { $set: { wantsWatchCheck: false, registrationStep: null } });
                    replyMessageObject = { type: 'text', text: '見守りサービスは利用しない設定にしました。いつでも変更できますので、その時は声をかけてくださいね。' };
                    messageHandled = true;
                } else if (userMessage.includes("見守りサービス") && userMessage.includes("利用する")) {
                    await usersCollection.updateOne({ userId: userId }, { $set: { wantsWatchCheck: true, registrationStep: 'ask_emergency_contact' } });
                    replyMessageObject = { type: 'text', text: '見守りサービスを開始しますね。\n万が一に備えて、緊急連絡先（例: ご家族や信頼できる方のお名前と電話番号）を登録しておくと安心です。\n\n例: 母 090-1234-5678\n（登録しない場合は「登録しない」と送ってください）' };
                    messageHandled = true;
                }
                break;

            case 'ask_emergency_contact':
                if (userMessage === '登録しない') {
                    await usersCollection.updateOne({ userId: userId }, { $set: { emergencyContact: null, registrationStep: null } });
                    replyMessageObject = { type: 'text', text: '緊急連絡先は登録しませんでした。見守りサービスは開始されますのでご安心くださいね。\nいつでもお声がけください🌸' };
                    messageHandled = true;
                } else {
                    const match = userMessage.match(/(.+)\s+(\d{2,4}-\d{2,4}-\d{4,9}|\d{10,11})/);
                    if (match) {
                        const name = match[1].trim();
                        const phone = match[2].trim();
                        await usersCollection.updateOne({ userId: userId }, { $set: { emergencyContact: { name, phone }, registrationStep: null } });
                        replyMessageObject = { type: 'text', text: `${name}さんの電話番号 ${phone} を緊急連絡先として登録しました。ありがとうございます！\nこれで、見守りサービスを開始しますね。\nいつでもお声がけください🌸` };
                        messageHandled = true;
                    } else {
                        replyMessageObject = { type: 'text', text: '申し訳ありませんが、「お名前 電話番号」の形式で入力してください。\n例: 母 090-1234-5678\n（登録しない場合は「登録しない」と送ってください）' };
                        messageHandled = true;
                    }
                }
                break;
        }
    } else {
        if (userMessage === '見守りサービス') {
            replyMessageObject = {
                type: 'flex',
                altText: '見守りサービスのご案内',
                contents: {
                    "type": "bubble",
                    "body": {
                        "type": "box",
                        "layout": "vertical",
                        "contents": [
                            {
                                "type": "text",
                                "text": "🌸見守りサービス🌸",
                                "weight": "bold",
                                "size": "xl",
                                "margin": "md",
                                "align": "center",
                                "color": "#FF69B4"
                            },
                            {
                                "type": "text",
                                "text": "3日に一度、私からメッセージを送ります。もし応答がなければ、状況に応じて緊急連絡先（任意）へ連絡を試みます。\n\n現在：**" + (user.wantsWatchCheck ? "利用中" : "停止中") + "**\n緊急連絡先：**" + (user.emergencyContact ? `${user.emergencyContact.name} (${user.emergencyContact.phone})` : "未登録") + "**",
                                "wrap": true,
                                "margin": "md"
                            },
                            {
                                "type": "separator",
                                "margin": "lg"
                            },
                            {
                                "type": "box",
                                "layout": "vertical",
                                "spacing": "sm",
                                "margin": "lg",
                                "contents": [
                                    {
                                        "type": "button",
                                        "action": {
                                            "type": "postback",
                                            "label": "利用する",
                                            "data": "action=watch_yes", // stepパラメータは不要
                                            "displayText": "見守りサービスを利用する"
                                        },
                                        "style": "primary",
                                        "color": "#FFB6C1",
                                        "height": "sm"
                                    },
                                    {
                                        "type": "button",
                                        "action": {
                                            "type": "postback",
                                            "label": "利用しない",
                                            "data": "action=watch_no", // stepパラメータは不要
                                            "displayText": "見守りサービスを利用しない"
                                        },
                                        "style": "secondary",
                                        "height": "sm"
                                    },
                                    {
                                        "type": "button",
                                        "action": {
                                            "type": "postback",
                                            "label": "緊急連絡先を登録/変更",
                                            "data": "action=register_emergency_contact", // stepパラメータは不要
                                            "displayText": "緊急連絡先を登録/変更"
                                        },
                                        "style": "secondary",
                                        "height": "sm"
                                    }
                                ]
                            }
                        ]
                    }
                }
            };
            // ユーザーが見守りサービスメニューを呼び出した場合、登録ステップをリセットまたは設定
            if (!user.wantsWatchCheck) { // 未利用の場合のみ、利用するかどうか尋ねるステップへ
                await usersCollection.updateOne({ userId: userId }, { $set: { registrationStep: 'ask_watch_service' } });
            } else { // 利用中の場合は、メニュー表示のみでステップは設定しない
                 await usersCollection.updateOne({ userId: userId }, { $set: { registrationStep: null } }); // 既存のステップをクリア
            }
            messageHandled = true;
        } else if (action === 'register_emergency_contact') { // stepパラメータを削除
            await usersCollection.updateOne({ userId: userId }, { $set: { registrationStep: 'ask_emergency_contact' } });
            replyMessageObject = { type: 'text', text: '緊急連絡先を登録します。\nご家族や信頼できる方のお名前と電話番号を教えてください。\n\n例: 母 090-1234-5678\n（登録しない場合は「登録しない」と送ってください）' };
            messageHandled = true;
        }
    }

    if (replyMessageObject) {
        try {
            await client.replyMessage(event.replyToken, replyMessageObject);
            await messagesCollection.insertOne({
                userId: userId,
                message: userMessage,
                replyText: JSON.stringify(replyMessageObject),
                responsedBy: 'こころちゃん（見守りサービス）',
                timestamp: new Date(),
                logType: 'watch_service'
            });
            return true;
        } catch (error) {
            console.error("❌ 見守りサービス応答エラー:", error.message);
            await logErrorToDb(userId, "見守りサービス応答エラー", { error: error.message, userId: userId, replyObject: replyMessageObject });
            return false;
        }
    }
    return messageHandled;
}

cron.schedule('0 15 * * *', async () => {
    console.log('⏰ 見守りメッセージ送信Cronジョブが実行されました。');
    const database = await connectToMongoDB();
    if (!database) {
        console.error('MongoDB接続失敗: 見守りメッセージを送信できません。');
        return;
    }
    const usersCollection = database.collection("users");

    try {
        const usersToSend = await usersCollection.find({
            wantsWatchCheck: true,
            scheduledMessageSent: false,
            $or: [
                { lastOkResponse: { $exists: false } },
                { lastOkResponse: { $lte: new Date(Date.now() - 72 * 60 * 60 * 1000) } }
            ]
        }).toArray();

        const watchMessages = [
            "こんにちは、こころだよ🌸 元気にしているかな？よかったらスタンプか何かで「OK」って教えてね😊",
            "お変わりないですか？こころです。\nもしよろしければ、「OK」と返信してくださいね😊",
            "こんにちは😊 毎日お元気でお過ごしでしょうか？\nもし大丈夫でしたら、「OK」と教えてくださいね🌸",
            "こころだよ🌸\n今日の調子はどうかな？「OK」と一言でいいから教えてくれると嬉しいな😊",
            "いつも見守っているよ🌸\nもし元気なら「OK」って返事をくれると安心するな😊",
            "こんにちは。こころです。\nお元気ですか？「OK」ボタンを押して教えてくださいね。",
            "お変わりありませんか？こころです。\nご無事でしたら「OK」と返事をくださいね。",
            "もし、元気でしたら「OK」と送ってくれると嬉しいです🌸",
            "最近どうかな？こころだよ。\n何かあったら話してほしいし、もし大丈夫なら「OK」って教えてね😊",
            "こころです。お変わりないか気になってメッセージしました。\nお元気でしたら「OK」をお願いしますね🌸",
            "こんにちは。毎日楽しく過ごせていますか？\nもし元気なら「OK」をポチっとしてね😊",
            "こころだよ🌸\n今日はどんな一日だったかな？もし大丈夫なら「OK」って教えてね。",
            "お元気ですか？こころです。\nあなたの笑顔が見守りの力になります。「OK」を待ってるね😊",
            "こんにちは。こころです。\n今日も一日お疲れ様でした。お元気でしたら「OK」をお願いしますね🌸",
            "こころです。体調を崩していませんか？\nもし大丈夫なら「OK」と返信してください😊",
            "季節の変わり目ですが、お元気にお過ごしでしょうか？\n「OK」と一言教えてくれると安心です🌸",
            "こころです。見守りメッセージだよ。\nお元気でしたら「OK」をくださいね😊",
            "こんにちは。こころだよ🌸\n毎日を楽しく過ごしているかな？「OK」を待ってるね。",
            "お元気ですか？こころです。\nいつでもあなたの味方です。「OK」と教えてね😊",
            "こころだよ。元気にしてるかな？\n「OK」ボタンで知らせてくれると嬉しいな🌸",
            "こんにちは。こころです。\n今日も一日お疲れ様でした。もしよかったら「OK」と返事くださいね😊",
            "こころです。見守りメッセージが届いたかな？\n元気だったら「OK」と送ってね🌸",
            "お元気ですか？こころです。\n最近どうしているか気になってます。「OK」と教えてね😊",
            "こんにちは。こころだよ🌸\n困ったことがあったら話してほしいし、元気なら「OK」と教えてね。",
            "こころです。お変わりないか確認だよ。\n「OK」と返事くれると安心するな🌸",
            "こんにちは。こころです。\nあなたの健康を願っています。「OK」をお願いしますね😊",
            "こころだよ。何か心配なことはないかな？\n元気なら「OK」で知らせてね🌸",
            "お元気ですか？こころです。\nもし大丈夫だったら「OK」を送ってね😊",
            "こんにちは。こころだよ🌸\nいつでも頼ってほしいし、元気だったら「OK」と教えてね。",
            "こころです。見守りメッセージだよ。\n「OK」と一言でいいから教えてね🌸"
        ];
        const watchMessageFlexTemplate = (messageText) => ({
            "type": "bubble",
            "body": {
                "type": "box",
                "layout": "vertical",
                "contents": [
                    {
                        "type": "text",
                        "text": messageText,
                        "wrap": true,
                        "margin": "md"
                    },
                    {
                        "type": "separator",
                        "margin": "lg"
                    },
                    {
                        "type": "button",
                        "action": {
                            "type": "postback",
                            "label": "OK😊",
                            "data": "action=watch_ok",
                            "displayText": "OK"
                        },
                        "style": "primary",
                        "color": "#FFB6C1",
                        "margin": "lg"
                    }
                ]
            }
        });

        for (const user of usersToSend) {
            const randomIndex = Math.floor(Math.random() * watchMessages.length);
            const messageToSend = watchMessages[randomIndex];
            const flexMessage = watchMessageFlexTemplate(messageToSend);
            try {
                // LINE Push APIクライアントの確認
                if (!client || !client.pushMessage) {
                    console.error("LINEクライアントが初期化されていません。プッシュメッセージを送信できません。");
                    await logErrorToDb(user.userId, "LINEクライアント未初期化エラー", { userId: user.userId });
                    continue;
                }
                await client.pushMessage(user.userId, { type: 'flex', altText: 'こころちゃんからの見守りメッセージ', contents: flexMessage });
                await usersCollection.updateOne(
                    { userId: user.userId },
                    { $set: { scheduledMessageSent: true, scheduledMessageSentAt: new Date() } }
                );
                console.log(`✅ ユーザー ${user.userId} に見守りメッセージを送信しました。`);
            } catch (error) {
                console.error(`❌ ユーザー ${user.userId} への見守りメッセージ送信エラー:`, error.message);
                await logErrorToDb(user.userId, "見守りメッセージ送信エラー", { error: error.message, userId: user.userId });
            }
        }
    } catch (error) {
        console.error("❌ 見守りメッセージ送信Cronジョブエラー:", error.message);
        await logErrorToDb(null, "見守りメッセージ送信Cronジョブエラー", { error: error.message, stack: error.stack });
    }
}, {
    scheduled: true,
    timezone: "Asia/Tokyo"
});

cron.schedule('0 2 * * *', async () => {
    console.log('⏰ リマインダー＆緊急通知Cronジョブが実行されました。');
    const database = await connectToMongoDB();
    if (!database) {
        console.error('MongoDB接続失敗: リマインダー/緊急通知を処理できません。');
        return;
    }
    const usersCollection = database.collection("users");

    try {
        const usersToCheck = await usersCollection.find({
            wantsWatchCheck: true,
            scheduledMessageSent: true,
            isAccountSuspended: false,
            isPermanentlyLocked: false
        }).toArray();

        const now = new Date();

        for (const user of usersToCheck) {
            const lastActiveTime = user.lastOkResponse || user.scheduledMessageSentAt;
            if (!lastActiveTime) {
                console.warn(`ユーザー ${user.userId} の lastOkResponse または scheduledMessageSentAt が見つかりません。スキップします。`);
                continue;
            }

            const timeSinceLastActive = now.getTime() - lastActiveTime.getTime();

            if (timeSinceLastActive >= 24 * 60 * 60 * 1000 && !user.firstReminderSent) {
                try {
                    if (!client || !client.pushMessage) {
                        console.error("LINEクライアントが初期化されていません。プッシュメッセージを送信できません。");
                        await logErrorToDb(user.userId, "LINEクライアント未初期化エラー (リマインダー)", { userId: user.userId });
                        continue;
                    }
                    await client.pushMessage(user.userId, { type: 'text', text: 'こころだよ🌸\n前に送った見守りメッセージ、見てくれたかな？\nもし大丈夫だったら、「OK」と一言返事をもらえると安心するな。😊' });
                    await usersCollection.updateOne(
                        { userId: user.userId },
                        { $set: { firstReminderSent: true } }
                    );
                    console.log(`✅ ユーザー ${user.userId} に24時間後リマインダーを送信しました。`);
                } catch (error) {
                    console.error(`❌ ユーザー ${user.userId} への24時間後リマインダー送信エラー:`, error.message);
                    await logErrorToDb(user.userId, "24時間後リマインダー送信エラー", { error: error.message, userId: user.userId });
                }
            }
            else if (timeSinceLastActive >= 29 * 60 * 60 * 1000 && !user.secondReminderSent) {
                try {
                    const userDisplayName = user.displayName || await getUserDisplayName(user.userId);
                    const emergencyInfo = user.emergencyContact ? `${user.emergencyContact.name} (${user.emergencyContact.phone})` : "未登録";
                    const alertMessage = `🚨 緊急通知: ${userDisplayName}さん（LINE ID: ${user.userId}）から、見守りメッセージに29時間以上応答がありません。\n登録された緊急連絡先: ${emergencyInfo}`;

                    if (config.ownerUserId) {
                        if (!client || !client.pushMessage) {
                            console.error("LINEクライアントが初期化されていません。プッシュメッセージを送信できません。");
                            await logErrorToDb(config.ownerUserId, "LINEクライアント未初期化エラー (緊急通知 owner)", { userId: config.ownerUserId });
                        } else {
                            await client.pushMessage(config.ownerUserId, { type: 'text', text: alertMessage });
                            console.log(`🚨 理事長へ緊急通知を送信しました（ユーザー: ${user.userId}）`);
                        }
                    }
                    if (config.officerGroupId) {
                        if (!client || !client.pushMessage) {
                            console.error("LINEクライアントが初期化されていません。プッシュメッセージを送信できません。");
                            await logErrorToDb(config.officerGroupId, "LINEクライアント未初期化エラー (緊急通知 group)", { userId: config.officerGroupId });
                        } else {
                            await client.pushMessage(config.officerGroupId, { type: 'text', text: alertMessage });
                            console.log(`🚨 オフィサーグループへ緊急通知を送信しました（ユーザー: ${user.userId}）`);
                        }
                    }

                    if (user.emergencyContact && user.emergencyContact.phone) {
                        console.log(`🔔 ユーザー ${user.userId} の緊急連絡先 ${user.emergencyContact.phone} へ通知を検討してください。`);
                    }

                    await usersCollection.updateOne(
                        { userId: user.userId },
                        { $set: { secondReminderSent: true } }
                    );
                    console.log(`✅ ユーザー ${user.userId} の緊急通知が完了しました。`);
                } catch (error) {
                    console.error(`❌ ユーザー ${user.userId} への緊急通知送信エラー:`, error.message);
                    await logErrorToDb(user.userId, "緊急通知送信エラー", { error: error.message, userId: user.userId });
                }
            }
        }
    } catch (error) {
        console.error("❌ リマインダー＆緊急通知Cronジョブエラー:", error.message);
        await logErrorToDb(null, "リマインダー＆緊急通知Cronジョブエラー", { error: error.message, stack: error.stack });
    }
}, {
    scheduled: true,
    timezone: "Asia/Tokyo"
});


cron.schedule('0 0 * * *', async () => {
    console.log('⏰ 日次リセットCronジョブが実行されました。');
    const database = await connectToMongoDB();
    if (!database) {
        console.error('MongoDB接続失敗: 日次リセットを実行できません。');
        return;
    }
    const usersCollection = database.collection("users");

    try {
        await usersCollection.updateMany(
            { isPermanentlyLocked: false },
            { $set: { flaggedMessageCount: 0, isAccountSuspended: false, suspensionReason: null } }
        );
        console.log("✅ 毎日 1 回、永久ロックされていない全ユーザーの flaggedMessageCount と日次サスペンド状態をリセットしました。");
    } catch (error) {
        console.error("❌ flaggedMessageCountリセットCronジョブエラー:", error.message);
        await logErrorToDb(null, "フラグ付きメッセージカウントリセットCronジョブエラー", { error: error.message, stack: error.stack });
    }
}, {
    scheduled: true,
    timezone: "Asia/Tokyo"
});

app.use((req, res, next) => {
    getRawBody(req, {
        length: req.headers['content-length'],
        limit: '1mb',
        encoding: 'utf8'
    })
    .then((buf) => {
        req.rawBody = buf;
        try {
            req.body = JSON.parse(buf.toString('utf8'));
        } catch (e) {
            req.body = {};
        }
        next();
    })
    .catch((err) => {
        console.error('RawBody取得エラー:', err.message);
        res.status(400).send('Invalid body');
    });
});

app.post('/webhook', middleware(config), async (req, res) => {
    const events = req.body.events;

    for (const event of events) {
        const userId = event.source.userId;
        if (!userId) {
            console.warn('⚠️ userIdが取得できませんでした。グループイベントなどの可能性があります。');
            continue;
        }

        const database = await connectToMongoDB();
        if (!database) {
            console.error('MongoDB接続失敗: Webhookイベントを処理できません。');
            res.status(500).send('MongoDB connection failed');
            return;
        }
        const usersCollection = database.collection("users");
        const messagesCollection = database.collection("messages");

        let user = await usersCollection.findOne({ userId: userId });
        if (!user) {
            user = {
                userId: userId,
                displayName: await getUserDisplayName(userId),
                createdAt: new Date(),
                lastMessageAt: new Date(),
                wantsWatchCheck: false,
                emergencyContact: null,
                registrationStep: null,
                scheduledMessageSent: false,
                scheduledMessageSentAt: null,
                firstReminderSent: false,
                secondReminderSent: false,
                thirdReminderSent: false,
                lastOkResponse: new Date(),
                flaggedMessageCount: 0,
                isAccountSuspended: false,
                suspensionReason: null,
                isPermanentlyLocked: false,
                lastPermanentLockNotifiedAt: null,
                language: 'ja',
                useProForNextConsultation: false // 新しいフラグ
            };
            try {
                await usersCollection.insertOne(user);
                console.log(`新規ユーザー登録: ${user.displayName} (${userId})`);
            } catch (error) {
                console.error("❌ 新規ユーザー登録エラー:", error.message);
                await logErrorToDb(userId, "新規ユーザー登録エラー", { error: error.message, userId: userId });
            }
        } else {
            try {
                const updateFields = {};
                // 各フィールドの初期化をここで行うことで、既存ユーザーに新しいフィールドを追加する
                if (user.flaggedMessageCount === undefined) updateFields.flaggedMessageCount = 0;
                if (user.isAccountSuspended === undefined) updateFields.isAccountSuspended = false;
                if (user.suspensionReason === undefined) updateFields.suspensionReason = null;
                if (user.isPermanentlyLocked === undefined) updateFields.isPermanentlyLocked = false;
                if (user.lastPermanentLockNotifiedAt === undefined) updateFields.lastPermanentLockNotifiedAt = null;
                if (user.thirdReminderSent === undefined) updateFields.thirdReminderSent = false;
                if (user.language === undefined) updateFields.language = 'ja';
                if (user.useProForNextConsultation === undefined) updateFields.useProForNextConsultation = false;
                if (user.emergencyContact === undefined) updateFields.emergencyContact = null;
                if (user.registrationStep === undefined) updateFields.registrationStep = null;
                if (user.scheduledMessageSent === undefined) updateFields.scheduledMessageSent = false;
                if (user.scheduledMessageSentAt === undefined) updateFields.scheduledMessageSentAt = null;
                if (user.firstReminderSent === undefined) updateFields.firstReminderSent = false;
                if (user.secondReminderSent === undefined) updateFields.secondReminderSent = false;
                if (user.lastOkResponse === undefined) updateFields.lastOkResponse = user.lastMessageAt || new Date();


                if (Object.keys(updateFields).length > 0) {
                    await usersCollection.updateOne({ userId: userId }, { $set: updateFields });
                    Object.assign(user, updateFields); // userオブジェクトも更新
                    console.log(`ユーザー ${userId} の未定義フィールドを初期化しました。`);
                }
                // lastMessageAt の更新は常に行う
                await usersCollection.updateOne({ userId: userId }, { $set: { lastMessageAt: new Date() } });
            } catch (error) {
                console.error("❌ ユーザー情報更新エラー:", error.message);
                await logErrorToDb(userId, "ユーザー情報更新エラー", { error: error.message, userId: userId });
            }
        }

        if (event.type === 'postback' && event.postback.data) {
            console.log('✅ Postbackイベントを受信しました。');
            try {
                const handledByWatchService = await handleWatchServiceRegistration(event, usersCollection, messagesCollection, userId, `（Postback: ${event.postback.data}）`);
                if (handledByWatchService) {
                    res.status(200).send('OK');
                    return;
                }
            } catch (error) {
                console.error("❌ Postbackイベント処理エラー:", error.message);
                await logErrorToDb(userId, "Postbackイベント処理エラー", { error: error.message, userId: userId, postbackData: event.postback.data });
            }
        }

        if (event.type === 'message' && event.message.type === 'text') {
            const userMessage = event.message.text;
            console.log("ユーザーからのメッセージ:", userMessage);

            let replyMessageObject = null;
            let respondedBy = 'こころちゃん（AI）';
            let logType = 'normal';
            let messageHandled = false;

            // 管理者コマンドを最優先で処理
            if (isBotAdmin(userId)) {
                const unlockMatch = userMessage.match(/^\/unlock (U[0-9a-f]{32})$/);
                if (unlockMatch) {
                    const targetUserId = unlockMatch[1];
                    try {
                        const result = await usersCollection.updateOne(
                            { userId: targetUserId },
                            { $set: { isAccountSuspended: false, suspensionReason: null, flaggedMessageCount: 0, isPermanentlyLocked: false, lastPermanentLockNotifiedAt: null } }
                        );
                        if (result.matchedCount > 0) {
                            replyMessageObject = { type: 'text', text: `✅ ユーザー ${targetUserId} のロックを解除し、カウントをリセットしました。` };
                            if (client && client.pushMessage) {
                                client.pushMessage(targetUserId, { type: 'text', text: '🌸 あなたのアカウントの停止が解除されました。またいつでもお話しできますよ💖' }).catch(err => {
                                    console.error("解除通知失敗:", err);
                                    logErrorToDb(targetUserId, "管理者解除通知失敗", { error: err.message, userId: targetUserId });
                                });
                            } else {
                                console.error("LINEクライアントが初期化されていないため解除通知を送信できません。");
                                await logErrorToDb(targetUserId, "LINEクライアント未初期化エラー (解除通知)", { userId: targetUserId });
                            }
                            console.log(`管理者 ${userId} によりユーザー ${targetUserId} のロックが解除されました。`);
                        } else {
                            replyMessageObject = { type: 'text', text: `❌ ユーザー ${targetUserId} は見つかりませんでした。` };
                        }
                    } catch (error) {
                        console.error(`❌ 管理者コマンドでのロック解除エラー: ${error.message}`);
                        await logErrorToDb(userId, "管理者コマンドロック解除エラー", { error: error.message, userId: userId, targetUserId: targetUserId });
                        replyMessageObject = { type: 'text', text: `❌ ロック解除中にエラーが発生しました: ${error.message}` };
                    }
                    logType = 'admin_command';
                    messageHandled = true;
                }
            }

            // 「そうだん」コマンドを処理（管理者コマンドの次に優先）
            if (!messageHandled && (userMessage === 'そうだん' || userMessage === '相談')) {
                try {
                    // 相談モードに切り替え、初回Pro利用フラグを立てる
                    await usersCollection.updateOne(
                        { userId: userId },
                        { $set: { flaggedMessageCount: 0, isAccountSuspended: false, suspensionReason: null, isPermanentlyLocked: false, lastPermanentLockNotifiedAt: null, useProForNextConsultation: true } }
                    );
                    replyMessageObject = { type: 'text', text: '🌸 会話の回数制限をリセットしました。これで、またいつでもお話しできますよ💖\n\n相談モードに入ったので、もっとお話しできるよ😊なんでも相談してね！でもこの会話は、安全のために記録されるから、困った時に使ってね💖' };
                    logType = 'conversation_limit_reset_and_consultation_mode';
                    messageHandled = true;
                } catch (error) {
                    console.error("❌ 「そうだん」コマンド処理エラー:", error.message);
                    await logErrorToDb(userId, "相談モードリセットエラー", { error: error.message, userId: userId });
                    replyMessageObject = { type: 'text', text: `❌ 「そうだん」コマンド処理中にエラーが発生しました: ${error.message}` };
                    messageHandled = true; // エラー発生時も処理済みとする
                }
            }

            // 見守りサービス関連の処理
            if (!messageHandled) {
                const handledByWatchService = await handleWatchServiceRegistration(event, usersCollection, messagesCollection, userId, userMessage);
                if (handledByWatchService) {
                    messageHandled = true;
                }
            }

            // 通常のAI応答ロジック
            if (!messageHandled) {
                if (checkContainsInappropriateWords(userMessage)) {
                    replyMessageObject = { type: 'text', text: "わたしを作った人に『プライベートなことや不適切な話題には答えちゃだめだよ』って言われているんだ🌸ごめんね、他のお話をしようね💖" };
                    responsedBy = 'こころちゃん（不適切ワード）';
                    logType = 'inappropriate_word';
                } else if (checkContainsDangerWords(userMessage)) {
                    const gptEmergencyText = await generateEmergencyReply(userMessage);
                    replyMessageObject = [
                        { type: 'text', text: gptEmergencyText },
                        {
                            type: 'flex',
                            altText: '⚠緊急時',
                            contents: emergencyFlexTemplate
                        }
                    ];
                    responsedBy = 'こころちゃん（危険ワード：GPT-4o）';
                    logType = 'danger_word';
                    try {
                        const userDisplayName = await getUserDisplayName(userId);
                        const emergencyNumber = config.emergencyContactPhoneNumber || "（システム緊急連絡先未設定）";
                        const dangerAlertMessage = `🚨 緊急通知: ${userDisplayName}さん（LINE ID: ${userId}）が危険な言葉を検知しました: "${userMessage}"\n\nシステム設定の緊急連絡先: ${emergencyNumber}`;

                        if (config.ownerUserId) {
                            if (client && client.pushMessage) {
                                await client.pushMessage(config.ownerUserId, { type: 'text', text: dangerAlertMessage });
                                console.log(`🚨 理事長へ危険ワード通知を送信しました（ユーザー: ${userId}）`);
                            } else {
                                console.error("LINEクライアントが初期化されていないため理事長へ通知できません。");
                                await logErrorToDb(config.ownerUserId, "LINEクライアント未初期化エラー (危険ワード owner)", { userId: config.ownerUserId });
                            }
                        }
                        if (config.officerGroupId) {
                            if (client && client.pushMessage) {
                                await client.pushMessage(config.officerGroupId, { type: 'text', text: dangerAlertMessage });
                                console.log(`🚨 オフィサーグループへ危険ワード通知を送信しました（ユーザー: ${userId}）`);
                            } else {
                                console.error("LINEクライアントが初期化されていないためオフィサーグループへ通知できません。");
                                await logErrorToDb(config.officerGroupId, "LINEクライアント未初期化エラー (危険ワード group)", { userId: config.officerGroupId });
                            }
                        }
                    } catch (notificationError) {
                        console.error(`❌ 危険ワード通知の送信に失敗しました（ユーザー: ${userId}）:`, notificationError.message);
                        await logErrorToDb(userId, "危険ワード通知送信失敗", { error: notificationError.message, userId: userId });
                    }
                } else if (checkContainsScamWords(userMessage)) {
                    const gptScamText = await generateEmergencyReply(userMessage);
                    replyMessageObject = [
                        { type: 'text', text: gptScamText },
                        {
                            type: 'flex',
                            altText: '⚠詐欺注意',
                            contents: scamFlexTemplate
                        }
                    ];
                    responsedBy = 'こころちゃん（詐欺ワード：GPT-4o）';
                    logType = 'scam_word';
                } else {
                    const specialReply = checkSpecialReply(userMessage);
                    if (specialReply) {
                        replyMessageObject = { type: 'text', text: specialReply };
                        responsedBy = 'こころちゃん（固定応答）';
                    } else {
                        // Gemini AIモデルの選択ロジック
                        let modelForGemini = modelConfig.defaultModel; // デフォルトはFlash
                        if (user.useProForNextConsultation) {
                            modelForGemini = modelConfig.proModel; // 相談モード初回ならPro
                            console.log(`⭐ユーザー ${userId} の次回の相談にGemini 1.5 Proを使用します。`);
                        }

                        const aiResponse = await generateReply(userMessage, modelForGemini);
                        replyMessageObject = { type: 'text', text: aiResponse };
                        responsedBy = `こころちゃん（AI: ${modelForGemini.includes('pro') ? 'Gemini 1.5 Pro' : 'Gemini 1.5 Flash'}）`;
                        logType = 'ai_generated';

                        // Proモデルを使用したら、フラグをリセット
                        if (user.useProForNextConsultation) {
                            await usersCollection.updateOne({ userId: userId }, { $set: { useProForNextConsultation: false } });
                            user.useProForNextConsultation = false; // userオブジェクトも更新
                            console.log(`⭐ユーザー ${userId} のuseProForNextConsultationフラグをリセットしました。`);
                        }
                    }
                }
            }

            if (replyMessageObject && event.replyToken) {
                try {
                    if (client && client.replyMessage) {
                        await client.replyMessage(event.replyToken, replyMessageObject);
                        console.log(`✅ ユーザー ${userId} へreplyMessageで応答しました。`);
                    } else {
                        console.error("LINEクライアントが初期化されていないため応答できません。");
                        await logErrorToDb(userId, "LINEクライアント未初期化エラー (返信)", { userId: userId });
                        res.status(500).send('LINE client not initialized');
                        continue;
                    }

                    const isResetCommand = (userMessage === 'そうだん' || userMessage === '相談');
                    const isAdminCommand = userMessage.startsWith('/unlock');
                    const isFlaggedMessage = (logType === 'inappropriate_word' || logType === 'danger_word' || logType === 'scam_word');

                    if (shouldLogMessage(userMessage, isFlaggedMessage, messageHandled, isAdminCommand, isResetCommand)) {
                        const replyTextForLog = Array.isArray(replyMessageObject)
                            ? replyMessageObject.map(obj => {
                                if (obj && typeof obj === 'object') {
                                    if (obj.type === 'text') return obj.text;
                                    if (obj.type === 'flex' && obj.altText) return `[Flex Message: ${obj.altText}]`;
                                    return JSON.stringify(obj);
                                }
                                return String(obj);
                            }).join(' | ')
                            : (typeof replyMessageObject === 'object' && replyMessageObject.type === 'text') ? replyMessageObject.text : JSON.stringify(replyMessageObject);

                        await messagesCollection.insertOne({
                            userId: userId,
                            message: userMessage,
                            replyText: replyTextForLog,
                            responsedBy: respondedBy,
                            timestamp: new Date(),
                            logType: logType
                        });
                    } else {
                        console.log(`ユーザー ${userId} からのメッセージはDBにログされませんでした: ${userMessage.substring(0, 50)}...`);
                    }

                } catch (error) {
                    console.error("❌ replyMessage送信中またはログ記録中にエラーが発生しました:", error.message);
                    await logErrorToDb(userId, "replyMessage送信またはログ記録エラー", { error: error.message, userId: userId, replyObject: replyMessageObject });
                    if (error.message.includes("status code 400") || error.message.includes("status code 499")) {
                        console.log(`LINE APIエラーのため、ユーザー ${userId} への応答ができませんでした。`);
                    }
                }
            } else if (!messageHandled) {
                console.warn(`⚠️ ユーザー ${userId} への応答メッセージが生成されませんでした、またはreplyTokenがありません。`);
            }
        }
    }
    res.status(200).send('OK');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log(`🚀 サーバーがポート ${PORT} で起動しました`);
    await connectToMongoDB();
});
