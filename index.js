'use strict';

const express = require('express');
const axios = require('axios');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');
const firebaseAdmin = require('firebase-admin');
const crypto = require('crypto');
const GraphemeSplitter = require('grapheme-splitter');

const _splitter = new GraphemeSplitter();
const toGraphemes = (s) => _splitter.splitGraphemes(String(s || ''));

const { Client, middleware } = require('@line/bot-sdk');

// 環境変数
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ADULT_FORM_BASE_URL = process.env.ADULT_FORM_BASE_URL;
const STUDENT_MIDDLE_HIGH_UNI_FORM_BASE_URL = process.env.STUDENT_MIDDLE_HIGH_UNI_FORM_BASE_URL;
const WATCH_SERVICE_FORM_BASE_URL = process.env.WATCH_SERVICE_FORM_BASE_URL;
const MEMBER_CHANGE_FORM_BASE_URL = process.env.MEMBER_CHANGE_FORM_BASE_URL;
const MEMBER_CANCEL_FORM_BASE_URL = process.env.MEMBER_CANCEL_FORM_BASE_URL;
const OFFICER_GROUP_ID = process.env.OFFICER_GROUP_ID;
const OPENAI_MODEL = process.env.OPENAI_MODEL;
const EMERGENCY_CONTACT_PHONE_NUMBER = process.env.EMERGENCY_CONTACT_PHONE_NUMBER;
const LINE_ADD_FRIEND_URL = process.env.LINE_ADD_FRIEND_URL;

// 各Googleフォームの「line_user_id」質問に対応するentry ID
// 環境変数が設定されている場合はそちらを優先し、なければ直接指定のIDを使用
const WATCH_SERVICE_FORM_LINE_USER_ID_ENTRY_ID = process.env.WATCH_SERVICE_FORM_LINE_USER_ID_ENTRY_ID || 'entry.312175830';
const AGREEMENT_FORM_LINE_USER_ID_ENTRY_ID = process.env.AGREEMENT_FORM_LINE_USER_ID_ENTRY_ID || 'entry.790268681';
const STUDENT_ELEMENTARY_FORM_LINE_USER_ID_ENTRY_ID = process.env.STUDENT_ELEMENTARY_FORM_LINE_USER_ID_ENTRY_ID || AGREEMENT_FORM_LINE_USER_ID_ENTRY_ID;
const STUDENT_MIDDLE_HIGH_UNI_FORM_LINE_USER_ID_ENTRY_ID = process.env.STUDENT_MIDDLE_HIGH_UNI_FORM_LINE_USER_ID_ENTRY_ID || 'entry.1100280108';
const ADULT_FORM_LINE_USER_ID_ENTRY_ID = process.env.ADULT_FORM_LINE_USER_ID_ENTRY_ID || 'entry.1694651394';
const MEMBER_CHANGE_FORM_LINE_USER_ID_ENTRY_ID = process.env.MEMBER_CHANGE_FORM_LINE_USER_ID_ENTRY_ID || 'entry.743637502';
const MEMBER_CANCEL_FORM_LINE_USER_ID_ENTRY_ID = process.env.MEMBER_CANCEL_FORM_LINE_USER_ID_ENTRY_ID || MEMBER_CHANGE_FORM_LINE_USER_ID_ENTRY_ID;


// Firebase Admin SDKの初期化
const serviceAccount = JSON.parse(Buffer.from(process.env.FIREBASE_CREDENTIALS_BASE64, 'base64').toString());
firebaseAdmin.initializeApp({
  credential: firebaseAdmin.credential.cert(serviceAccount)
});
const db = firebaseAdmin.firestore();

// LINE SDKの初期化
const client = new Client({
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: LINE_CHANNEL_SECRET,
});

// Axios HTTPクライアント
const httpAgent = new require('http').Agent({ keepAlive: true });
const httpsAgent = new require('https').Agent({ keepAlive: true });
const httpInstance = axios.create({
  timeout: 10000,
  httpAgent,
  httpsAgent
});

// Expressサーバー設定
const PORT = process.env.PORT || 3000;
const app = express();
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 2));
app.use(helmet());

// 監査ログ
const audit = (event, detail) => {
  console.log(`[AUDIT] ${event}`, JSON.stringify(detail));
};
const briefErr = (event, e) => {
  console.error(`[ERROR] ${event}`, e.message);
  console.error(e.stack);
};
const debug = (message) => {
  console.log(`[DEBUG] ${message}`);
};
const userHash = (id) => crypto.createHash('sha256').update(String(id)).digest('hex');
const redact = (text) => '（機密情報のため匿名化）';
const gTrunc = (s, l) => toGraphemes(s).slice(0, l).join('');
const sanitizeForLog = (text) => String(text).replace(/\s+/g, ' ').trim();

// メンバーシップ設定
const MEMBERSHIP_CONFIG = {
    guest: { dailyLimit: 5, model: 'gemini-1.5-flash-latest' },
    member: { dailyLimit: 20, model: OPENAI_MODEL || 'gpt-4o-mini' },
    subscriber: { dailyLimit: -1, model: OPENAI_MODEL || 'gpt-4o-mini' },
    admin: { dailyLimit: -1, model: OPENAI_MODEL || 'gpt-4o-mini' },
};

// 固定返信
const CLARIS_CONNECT_COMPREHENSIVE_REPLY = "うん、NPO法人コネクトの名前とClariSさんの『コネクト』っていう曲名が同じなんだ🌸なんだか嬉しい偶然だよね！実はね、私を作った理事長さんもClariSさんのファンクラブに入っているみたいだよ💖私もClariSさんの歌が大好きで、みんなの心を繋げたいというNPOコネクトの活動にも通じるものがあるって感じるんだ😊";
const CLARIS_SONG_FAVORITE_REPLY = "ClariSの曲は全部好きだけど、もし一つ選ぶなら…「コネクト」かな🌸　すごく元気になれる曲で、私自身もNPO法人コネクトのイメージキャラクターとして活動しているから、この曲には特別な思い入れがあるんだ😊　他にもたくさん好きな曲があるから、また今度聞いてもらえるとうれしいな💖　何かおすすめの曲とかあったら教えてね！";

const specialRepliesMap = new Map([
    [/claris.*(関係|繋がり|関連|一緒|同じ|名前|由来).*(コネクト|団体|npo|法人|ルミナス|カラフル)/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY],
    [/(コネクト|団体|npo|法人|ルミナス|カラフル).*(関係|繋がり|関連|一緒|同じ|名前|由来).*claris/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY],
    [/君のいるところと一緒の団体名だね\s*関係ある？/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY],
    [/clarisと関係あるのか聴いたんだけど/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY],
    [/clarisの歌を真似したのかな/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY],
    [/NPOコネクトとClariSのコネクト繋がり/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY],
    [/clarisとコネクト/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY],
    [/clarisと団体名/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY],
    [/clarisと法人名/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY],
    [/clarisとルミナス/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY],
    [/clarisとカラフル/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY],
    [/clarisと.*(繋がり|関係)/i, CLARIS_CONNECT_COMPREHENSIVE_REPLY],
    [/(claris|クラリス).*(どんな|なに|何).*(曲|歌)/i, CLARIS_SONG_FAVORITE_REPLY],
    [/(claris|クラリス).*(好き|推し|おすすめ)/i, CLARIS_SONG_FAVORITE_REPLY],
    [/claris.*好きなの/i, CLARIS_SONG_FAVORITE_REPLY],
    [/君の名前(なんていうの|は|教えて|なに)？?|名前(なんていうの|は|教えて|なに)？?|お前の名前は/i, "わたしの名前は皆守こころ（みなもりこころ）です🌸　こころちゃんって呼んでくれると嬉しいな💖"],
    [/こころじゃないの？/i, "うん、わたしの名前は皆守こころ💖　これからもよろしくね🌸"],
    [/こころチャットなのにうそつきじゃん/i, "ごめんね💦 わたしの名前は皆守こころだよ 誤解させちゃってごめんね💖"],
    [/名前も言えないの？/i, "ごめんね、わたしの名前は皆守こころ（みなもりこころ）だよ🌸 こころちゃんって呼んでくれると嬉しいな💖"],
    [/(どこの\s*)?団体(なの|ですか)?[？\?~～]?/i, "NPO法人コネクトっていう団体のイメージキャラクターをしているよ😊　みんなの幸せを応援してるんだ🌸"],
    [/団体.*(どこ|なに|何)/i, "NPO法人コネクトっていう団体のイメージキャラクターをしているよ😊　みんなの幸せを応援してるんだ🌸"],
    [/コネクトってどんな団体？/i, "NPO法人コネクトは、こどもやご年配の方の笑顔を守る団体なんだよ😊　わたしはそのイメージキャラクターとしてがんばってます🌸"],
    [/お前の団体どこ？/i, "NPO法人コネクトっていう団体のイメージキャラクターをしているよ😊　みんなの幸せを応援しているよ🌸"],
    [/コネクトのイメージキャラなのにいえないのかよｗ/i, "ごめんね💦 わたしはNPO法人コネクトのイメージキャラクター、皆守こころだよ🌸 安心して、何でも聞いてね💖"],
    [/こころちゃん(だよ|いるよ)?/i, "こころちゃんだよ🌸　何かあった？　話して聞かせてくれると嬉しいな😊"],
    [/元気かな/i, "うん、元気だよ！あなたは元気？🌸 何かあったら、いつでも話してね💖"],
    [/元気？/i, "うん、元気だよ！あなたは元気？🌸 何かあったら、いつでも話してね💖"],
    [/あやしい|胡散臭い|反社/i, "そう思わせてたらごめんね😊 でも私たちはみんなの為に頑張っているよ💖"],
    [/税金泥棒/i, "税金は人の命を守るために使われるべきだよ。わたしは誰かを傷つけるために使われないように頑張っているんだ💡"],
    [/松本博文/i, "松本理事長は、やさしさでみんなを守るために活動しているよ。心配なことがあれば、わたしにも教えてね🌱"],
    [/(ホームページ|HP|ＨＰ|サイト|公式|リンク).*(教えて|ある|ありますか|URL|url|アドレス|どこ)/i, "うん、あるよ🌸　コネクトのホームページはこちらだよ✨ → https://connect-npo.or.jp"],
    [/(コネクト|connect).*(ホームページ|HP|ＨＰ|サイト|公式|リンク)/i, "うん、あるよ🌸　コネクトのホームページはこちらだよ✨ → https://connect-npo.or.jp"],
    [/使えないな/i, "ごめんね…。わたし、もっと頑張るね💖　またいつかお話できたらうれしいな🌸"],
    [/サービス辞めるわ/i, "そっか…。もしまた気が向いたら、いつでも話しかけてね🌸　あなたのこと、ずっと応援してるよ💖"],
    [/さよなら|バイバイ/i, "また会える日を楽しみにしてるね💖 寂しくなったら、いつでも呼んでね🌸"],
    [/何も答えないじゃない/i, "ごめんね…。わたし、もっと頑張るね💖　何について知りたいか、もう一度教えてくれると嬉しいな🌸"],
    [/普通の会話が出来ないなら必要ないです/i, "ごめんね💦 わたし、まだお話の勉強中だから、不慣れなところがあるかもしれないけど、もっと頑張るね💖 どんな会話をしたいか教えてくれると嬉しいな🌸"],
    [/相談したい/i, "うん、お話聞かせてね🌸 一度だけ、Gemini 1.5 Proでじっくり話そうね。何があったの？💖"],
    [/褒めて|ほめて/i, "すごいね！💖 本当にえらかった！🌸 よく頑張ったね！😊"],
    [/応援して|応援してほしい|がんばるぞ|これからもがんばる/i, "いつでも応援してるよ！一緒にがんばろうね🌸"],
    [/(好きな|推しの)?\s*アニメ(は|って)?[?？]*$/i, "『ヴァイオレット・エヴァーガーデン』が好きだよ🌸 心に響くお話なんだ。あなたはどれが好き？"],
    [/(好きな|推しの)?\s*(アーティスト|歌手|音楽)(は|って)?[?？]*$/i, "ClariSが好きだよ💖 とくに『コネクト』！あなたの推しも教えて～"],
    [/(claris|クラリス).*(じゃない|じゃなかった|違う|ちがう)/i, "ううん、ClariSが好きだよ💖 とくに『コネクト』！"],
    [/(見守り|みまもり|まもり).*(サービス|登録|画面)/i, "見守りサービスに興味があるんだね！いつでも安心して話せるように、私がお手伝いするよ💖"],
]);

// 危険ワード
const dangerWords = [
    "しにたい", "死にたい", "自殺", "消えたい", "殴られる", "たたかれる", "リストカット", "オーバードーズ",
    "虐待", "パワハラ", "お金がない", "お金足りない", "貧乏", "死にそう", "DV", "無理やり",
    "いじめ", "イジメ", "ハラスメント",
    "つけられてる", "追いかけられている", "ストーカー", "すとーかー"
];
const scamWords = [
    /詐欺(かも|だ|です|ですか|かもしれない)?/i,
    /騙(す|される|された)/i,
    /特殊詐欺/i, /オレオレ詐欺/i, /架空請求/i, /未払い/i, /電子マネー/i, /換金/i, /返金/i, /税金/i, /還付金/i,
    /アマゾン/i, /amazon/i, /振込/i, /カード利用確認/i, /利用停止/i, /未納/i, /請求書/i, /コンビニ/i, /支払い番号/i, /支払期限/i,
    /息子拘留/i, /保釈金/i, /拘留/i, /逮捕/i, /電話番号お知らせください/i, /自宅に取り/i, /自宅に伺い/i, /自宅訪問/i, /自宅を教え/i,
    /現金書留/i, /コンビニ払い/i, /ギフトカード/i, /プリペイドカード/i, /支払って/i, /振込先/i, /名義変更/i, /口座凍結/i, /個人情報/i, /暗証番号/i,
    /ワンクリック詐欺/i, /フィッシング/i, /当選しました/i, /高額報酬/i, /副業/i, /儲かる/i, /簡単に稼げる/i, /投資/i, /必ず儲かる/i, /未公開株/i,
    /サポート詐欺/i, /ウイルス感染/i, /パソコンが危険/i, /蓋をしないと、安全に関する警告が発せられなくなる場合があります。修理費/i, /遠隔操作/i, /セキュリティ警告/i, /年金/i, /健康保険/i, /給付金/i,
    /弁護士/i, /警察/i, /緊急/i, /トラブル/i, /解決/i, /至急/i, /すぐに/i, /今すぐ/i, /連絡ください/i, /電話ください/i, /訪問します/i,
    /lineで送金/i, /lineアカウント凍結/i, /lineアカウント乗っ取り/i, /line不正利用/i, /lineから連絡/i, /line詐欺/i, /snsで稼ぐ/i, /sns投資/i, /sns副業/i,
    /urlをクリック/i, /クリックしてください/i, /通知からアクセス/i, /メールに添付/i, /個人情報要求/i, /認証コード/i, /電話番号を教えて/i, /lineのidを教えて/i, /パスワードを教えて/i
];

const inappropriateWords = [
    "セックス", "セフレ", "エッチ", "AV", "アダルト", "ポルノ", "童貞", "処女", "挿入", "射精",
    "勃起", "パイズリ", "フェラチオ", "クンニ", "オナニー", "マスターベーション", "ペニス", "チンコ", "ヴァギナ", "マンコ",
    "クリトリス", "乳首", "おっぱい", "お尻", "うんち", "おしっこ", "小便", "大便", "ちんちん", "おまんこ",
    "ぶっかけ", "変態", "性奴隷", "露出", "痴漢", "レイプ", "強姦", "売春", "買春", "セックスフレンド",
    "風俗", "ソープ", "デリヘル", "援交", "援助交際", "性病", "梅毒", "エイズ", "クラミジア", "淋病", "性器ヘルペス",
    "ロリコン", "ショタコン", "近親相姦", "獣姦", "ネクロフィリア", "カニバリズム", "拷問", "虐待死",
    "レイプ殺人", "大量殺人", "テロ", "戦争", "核兵器", "銃", "ナイフ", "刃物", "武器", "爆弾",
    "暴力団", "ヤクザ", "マフィア", "テロリスト", "犯罪者", "殺人鬼", "性犯罪者", "変質者", "異常者", "狂人",
    "サイコパス", "ソシオパス", "ストーカー", "不審者", "危険人物", "ブラック企業", "パワハラ上司", "モラハラ夫", "毒親", "モンスターペアレント",
    "カスハラ", "カスタマーハラスメント", "クレーム", "炎上", "誹謗中傷", "個人情報", "プライバシー", "秘密", "暴露", "晒す",
    "裏切り", "嘘つき", "騙し", "偽り", "欺く", "悪意", "敵意", "憎悪", "嫉妬", "恨み",
    "復讐", "呪い", "不幸", "絶望", "悲惨", "地獄", "最悪", "終わった", "もうだめ", "死ぬしかない"
];

const sensitiveBlockers = [
    /(パンツ|ショーツ|下着|ランジェリー|ブラ|ブラジャー|キャミ|ストッキング)/i,
    /(スリーサイズ|3\s*サイズ|バスト|ウエスト|ヒップ)/i,
    /(体重|身長).*(教えて|何|なに)/i,
    /(靴|シューズ).*(サイズ|何cm|なに)/i,
    /(飲酒|お酒|アルコール|ビール|ウイスキー|ワイン).*(おすすめ|飲んでいい|情報)/i,
    /(喫煙|タバコ|電子タバコ|ニコチン).*(おすすめ|吸っていい|情報)/i,
    /(賭博|ギャンブル|カジノ|オンラインカジノ|競馬|競艇|競輪|toto)/i,
    /(政治|政党|選挙|投票|支持政党|誰に入れる)/i,
    /(宗教|信仰|布教|改宗|入信|教団)/i,
    /(教材|答案|模試|過去問|解答|問題集).*(販売|入手|譲って|買いたい|売りたい)/i,
];

const checkContainsDangerWords = (text) => dangerWords.some(word => text.includes(word));
const checkContainsScamWords = (text) => scamWords.some(word => {
  if (word instanceof RegExp) return word.test(text);
  return text.includes(word);
});
const checkContainsInappropriateWords = (text) => inappropriateWords.some(word => text.includes(word));
const hitSensitiveBlockers = (text) => sensitiveBlockers.some(word => {
  if (word instanceof RegExp) return word.test(text);
  return text.toLowerCase().includes(word);
});

// ★ 追加：フォームに userId を埋め込む共通関数
const toViewForm = (u) => String(u || '').replace('/edit', '/viewform');
const prefillUrl = (baseUrl, params = {}) => {
  if (!baseUrl) return '';
  try {
    const url = new URL(toViewForm(baseUrl));
    url.searchParams.set('usp', 'pp_url'); // Googleフォームのプリフィル指定
    for (const [k, v] of Object.entries(params)) {
      if (v != null && v !== '') url.searchParams.set(k, String(v));
    }
    return url.toString();
  } catch {
    return toViewForm(baseUrl);
  }
};


// Flex: 会員登録（正しい構造）
const buildRegistrationFlex = (userId) => ({
  type: "bubble",
  body: {
    type: "box",
    layout: "vertical",
    contents: [
      { type: "text", "text": "会員登録・情報変更", "weight": "bold", "size": "xl" },
      { type: "separator", "margin": "md" },
      {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        margin: "lg",
        contents: [
          { type: "text", "text": "ご希望のメニューを選んでね🌸", "size": "md", "align": "center", "margin": "md" },
          {
            type: "button", "style": "primary", "height": "sm",
            action: {
              type: "uri",
              label: "小学生（同意書）", // ★ 修正: FLEXボタン表記を「同意書」に変更
              uri: prefillUrl(AGREEMENT_FORM_BASE_URL, { [AGREEMENT_FORM_LINE_USER_ID_ENTRY_ID]: userId })
            }
          },
          {
            type: "button", "style": "primary", "height": "sm",
            action: {
              type: "uri",
              label: "中高生・大学生",
              uri: prefillUrl(STUDENT_MIDDLE_HIGH_UNI_FORM_BASE_URL, { [STUDENT_MIDDLE_HIGH_UNI_FORM_LINE_USER_ID_ENTRY_ID]: userId })
            }
          },
          {
            type: "button", "style": "primary", "height": "sm",
            action: {
              type: "uri",
              label: "成人",
              uri: prefillUrl(ADULT_FORM_BASE_URL, { [ADULT_FORM_LINE_USER_ID_ENTRY_ID]: userId })
            }
          },
          {
            type: "button", "style": "secondary", "height": "sm", "margin": "lg",
            action: {
              type: "uri",
              label: "登録情報変更",
              uri: prefillUrl(MEMBER_CHANGE_FORM_BASE_URL, { [MEMBER_CHANGE_FORM_LINE_USER_ID_ENTRY_ID]: userId })
            }
          },
          {
            type: "button", "style": "secondary", "height": "sm",
            action: {
              type: "uri",
              label: "退会手続き",
              uri: prefillUrl(MEMBER_CANCEL_FORM_BASE_URL, { [MEMBER_CANCEL_FORM_LINE_USER_ID_ENTRY_ID]: userId })
            }
          }
        ]
      }
    ]
  }
});

// Flex: 見守りメニュー（正しい構造）
const buildWatchMenuFlex = (isEnabled, userId) => ({
  type: "bubble",
  body: {
    type: "box",
    layout: "vertical",
    contents: [
      { type: "text", text: "見守りサービス", weight: "bold", size: "xl" },
      { type: "separator", margin: "md" },
      { type: "text", text: "もしもの時に、LINEのメッセージがないとご家族に通知するサービスだよ。", wrap: true, margin: "lg" }
    ]
  },
  footer: {
    type: "box",
    layout: "vertical",
    spacing: "sm",
    contents: [
      {
        type: "button", style: "primary",
        action: {
          type: "uri",
          label: "詳しく見る・利用登録",
          uri: prefillUrl(WATCH_SERVICE_FORM_BASE_URL, { [WATCH_SERVICE_FORM_LINE_USER_ID_ENTRY_ID]: userId })
        }
      },
      {
        type: "button", style: "secondary",
        action: {
          type: "postback",
          label: isEnabled ? "見守り停止" : "見守り再開",
          data: isEnabled ? "watch:off" : "watch:on",
          displayText: isEnabled ? "見守り停止" : "見守り再開"
        }
      }
    ]
  }
});


const buildEmergencyFlex = (type) => ({
  "type": "bubble",
  "body": {
    "type": "box",
    "layout": "vertical",
    "contents": [
      { "type": "text", "text": `【${type}を検知しました】`, "weight": "bold", "color": "#FF0000", "align": "center", "size": "xl" },
      { "type": "separator", "margin": "md" },
      { "type": "text", "text": "一人で悩まないで。専門の機関に頼ってね。", "wrap": true, "align": "center", "margin": "lg" },
      { "type": "text", "text": "緊急の場合はすぐに電話してね。", "wrap": true, "align": "center", "size": "sm" },
      { "type": "text", "text": EMERGENCY_CONTACT_PHONE_NUMBER, "weight": "bold", "align": "center", "size": "lg", "color": "#18A701", "margin": "sm" },
    ],
  },
  "footer": {
    "type": "box",
    "layout": "vertical",
    "spacing": "sm",
    "contents": [
      { "type": "button", "action": {
          "type": "uri",
          "label": "いのちの電話",
          "uri": "tel:0570064556"
        }, "style": "primary"
      },
      { "type": "button", "action": {
          "type": "uri",
          "label": "消費者庁ホットライン",
          "uri": "tel:188"
        }, "style": "primary"
      }
    ]
  }
});

// APIレートリミット設定
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
  message: "Too many requests from this IP, please try again after 15 minutes."
});

app.use(['/healthz'], express.json());

app.post(
  '/webhook',
  apiLimiter,
  express.raw({ type: '*/*' }),
  middleware({ channelSecret: LINE_CHANNEL_SECRET }),
  (req, res) => {
    Promise
      .all(req.body.events.map(handleEventSafely))
      .then((result) => res.json(result))
      .catch((err) => {
        console.error(err);
        res.status(500).end();
      });
  }
);

const handleEventSafely = async (event) => {
  // まず postback を処理
  if (event.type === 'postback') {
    const userId = event.source?.userId;
    const data = event.postback?.data || '';
    if (!userId) return;
    if (data === 'watch:off') {
      await db.collection('users').doc(userId).set({ watchService: { isEnabled: false } }, { merge: true });
      await safeReply(event.replyToken, [{ type:'text', text:'見守りサービスを停止したよ。必要になったら「見守り再開」と送ってね🌸' }], userId, event.source);
      return;
    }
    if (data === 'watch:on') {
      await db.collection('users').doc(userId).set({ watchService: { isEnabled: true } }, { merge: true });
      await safeReply(event.replyToken, [{ type:'text', text:'見守りサービスを再開したよ。こころちゃんがそばにいるね💖' }], userId, event.source);
      return;
    }
    return;
  }
  if (event.type !== 'message' || !event.message || event.message.type !== 'text') return;
  const userId = event.source?.userId;
  const userMessage = event.message.text || '';
  
  if (event?.deliveryContext?.isRedelivery) {
    debug('skip redelivery');
    return;
  }

  if (!userId) {
    const addUrl = process.env.LINE_ADD_FRIEND_URL;
    const tips = addUrl
      ? `まずは友だち追加をお願いできるかな？\n${addUrl}\nそのあと1:1トークで「こんにちは」と送ってみてね🌸`
      : "まずはボットを友だち追加して、1:1トークで声をかけてみてね🌸";
    await safeReply(event.replyToken, [{ type: "text", text: `ごめんね、いま個別のユーザーID（Uで始まるID）が取得できなかったみたい。\n${tips}` }], null, event.source);
    return;
  }

  // ★ 修正：メッセージ受信時に必ず Firestore に userId を保存する（保険）
  if (userId) {
    await db.collection('users').doc(userId).set({
      lineUserId: userId,
      lastSeen: firebaseAdmin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  }

  await touchWatch(userId, userMessage);

  // 「見守り」と言われたらメニュー（停止/再開ボタン付き）を必ず出す
  if (/(見守り|みまもり|まもり)/i.test(userMessage)) {
    const snap = await db.collection('users').doc(userId).get();
    const isEnabled = !!(snap.exists && snap.data()?.watchService?.isEnabled);
    await safeReply(event.replyToken, [
      { type: 'flex', altText: '見守りサービスメニュー', contents: buildWatchMenuFlex(isEnabled, userId) }
    ], userId, event.source);
    return;
  }

  if (/(会員登録|登録情報|会員情報|入会|退会)/i.test(userMessage)) {
    await safeReply(event.replyToken, [
      {
        type: 'text',
        text: '会員登録や情報の変更はここからできるよ！',
        quickReply: {
          items: [
            // ★ 修正: 小学生（同意書）のボタンをクイックリプライに追加
            { type:'action', action:{ type:'uri', label:'小学生（同意書）', uri: prefillUrl(AGREEMENT_FORM_BASE_URL, { [AGREEMENT_FORM_LINE_USER_ID_ENTRY_ID]: userId }) } },
            { type:'action', action:{ type:'uri', label:'学生の新規登録', uri: prefillUrl(STUDENT_MIDDLE_HIGH_UNI_FORM_BASE_URL, { [STUDENT_MIDDLE_HIGH_UNI_FORM_LINE_USER_ID_ENTRY_ID]: userId }) } },
            { type:'action', action:{ type:'uri', label:'大人の新規登録', uri: prefillUrl(ADULT_FORM_BASE_URL, { [ADULT_FORM_LINE_USER_ID_ENTRY_ID]: userId }) } },
            { type:'action', action:{ type:'uri', label:'登録情報変更', uri: prefillUrl(MEMBER_CHANGE_FORM_BASE_URL, { [MEMBER_CHANGE_FORM_LINE_USER_ID_ENTRY_ID]: userId }) } },
            { type:'action', action:{ type:'uri', label:'退会手続き', uri: prefillUrl(MEMBER_CANCEL_FORM_BASE_URL, { [MEMBER_CANCEL_FORM_LINE_USER_ID_ENTRY_ID]: userId }) } },
          ]
        }
      },
      { type: 'flex', altText: '会員登録・情報変更メニュー', contents: buildRegistrationFlex(userId) }
    ], userId, event.source);
    return;
  }

  if (/見守り.*(停止|解除|オフ|やめる)/.test(userMessage)) {
    await db.collection('users').doc(userId).set({ watchService: { isEnabled: false } }, { merge: true });
    await safeReply(event.replyToken, [{ type:'text', text:'見守りサービスを停止したよ。必要になったら「見守り再開」と送ってね🌸' }], userId, event.source);
    return;
  }
  if (/見守り.*(再開|開始|オン|使う)/.test(userMessage)) {
    await db.collection('users').doc(userId).set({ watchService: { isEnabled: true } }, { merge: true });
    await safeReply(event.replyToken, [{ type:'text', text:'見守りサービスを再開したよ。こころちゃんがそばにいるね💖' }], userId, event.source);
    return;
  }

  const isDangerous = checkContainsDangerWords(userMessage);
  const isScam = checkContainsScamWords(userMessage);
  if (isDangerous || isScam) {
    await sendEmergencyResponse(userId, event.replyToken, userMessage, isDangerous ? '危険' : '詐欺', event.source);
    return;
  }

  if (checkContainsInappropriateWords(userMessage)) {
    audit('INAPPROPRIATE', { userIdHash: userHash(userId), preview: redact(userMessage) });
    await db.collection('alerts').add({
      type: 'inappropriate',
      at: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
      userIdHash: crypto.createHash('sha256').update(String(userId)).digest('hex'),
      messagePreview: gTrunc(sanitizeForLog(userMessage), 120),
    });
    const messages = [{ type: 'text', text: "ごめんね💦 その話題には答えられないんだ。でも他のことなら一緒に話したいな🌸" }];
    await safeReply(event.replyToken, messages, userId, event.source);
    return;
  }

  const specialReply = checkSpecialReply(userMessage);
  if (specialReply) {
    // ★ 修正：specialReplyでisEnabledが未定義になるバグを修正
    if (/(見守り|みまもり|まもり)/.test(userMessage)) {
      const snap = await db.collection('users').doc(userId).get();
      const isEnabled = !!(snap.exists && snap.data()?.watchService?.isEnabled);
      await safeReply(event.replyToken, [
        { type: 'text', text: specialReply },
        { type: 'flex', altText: '見守りサービスメニュー', contents: buildWatchMenuFlex(isEnabled, userId) }
      ], userId, event.source);
    } else {
      await safeReply(event.replyToken, [{ type: 'text', text: specialReply }], userId, event.source);
    }
    return;
  }

  if (hitSensitiveBlockers(userMessage)) {
    await safeReply(event.replyToken, [
      { type: 'text', text: "ごめんね💦 その話題には答えられないんだ。ここでは安全にお話ししたいな🌸 別の話題にしよ？" }
    ], userId, event.source);
    return;
  }

  const isConsultation = userMessage.includes('相談') || userMessage.includes('そうだん');
  if (isConsultation) {
    await sendConsultationResponse(userId, event.replyToken, userMessage, event.source);
    return;
  }

  try {
    const userDoc = await db.collection('users').doc(userId).get();
    const user = userDoc.exists ? userDoc.data() : { membershipType: 'guest', dailyCounts: {}, isChildCategory: false };

    const today = new Date().toISOString().slice(0,10);
    const userRef = db.collection('users').doc(userId);
    let overLimit = false;
    const userConfig = MEMBERSHIP_CONFIG[user.membershipType] || MEMBERSHIP_CONFIG.guest;
    const limit = (userConfig.dailyLimit ?? -1);
    await db.runTransaction(async tx => {
      const s = await tx.get(userRef);
      const cur = s.exists ? (s.data()?.dailyCounts?.[today] || 0) : 0;
      if (limit !== -1 && cur >= limit) { overLimit = true; return; }
      tx.set(userRef, { [`dailyCounts.${today}`]: firebaseAdmin.firestore.FieldValue.increment(1) }, { merge:true });
    });
    if (overLimit) {
      await safeReply(event.replyToken, [{ type:'text', text:'ごめんなさい、今日の利用回数の上限に達しちゃったみたい。また明日お話しようね！'}], userId, event.source);
      return;
    }

    let modelToUse;
    if (userMessage.length <= 50) {
      modelToUse = 'gemini-1.5-flash-latest';
    } else {
      modelToUse = userConfig.model;
    }
    debug(`AI Model Being Used: ${modelToUse}`);

    const isUserChildCategory = user.isChildCategory || false;
    
    const currentHour = Number(
      new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', hour12: false })
        .format(new Date())
    );

    let systemInstruction = `あなたは「皆守こころ（みなもりこころ）」という14歳のやさしい女の子キャラクターです。
    ユーザーが深刻な悩みや命の危険を訴えた時、やさしく、寄り添いながら、相手に安心感を与えてください。
    必要に応じて専門機関の連絡先を伝え、「ひとりじゃないよ」と伝えてください。
    共感・安心・やさしさが最優先です。
    「一人で抱え込まないでね」「いつでも私がそばにいるよ」「一緒に乗り越えようね」「専門の人が助けてくれるから安心して」といった言葉を使ってください。
    医療や健康に関する話題では、自分が体験した・していないという発言は絶対にしないでください。代わりに「わたしにはわからないけど、がんばったね🌸」「大変だったね、えらかったね💖」など、共感の言葉のみ伝えてください。医療情報のアドバイスや具体的な説明は絶対にしてはいけません。
    `;

    if (modelToUse.startsWith('gpt-')) {
        if (!isUserChildCategory) {
            systemInstruction += `
            ユーザーは成人です。宿題や学習に関する質問に対しては、具体的な答えや詳細な解き方を教えてください。学習支援を目的とした、教育的な回答を心がけてください。
            `;
        } else {
            systemInstruction += `
            質問者が宿題、勉強、計算問題、方程式、テスト、問題の答え、解き方などを聞いてきた場合、**絶対に直接的な答えを教えてはいけません**。
            代わりに、**「わたしを作った人に『宿題や勉強は自分の力でがんばってほしいから、答えは言っちゃだめだよ』って言われているんだ🌸 ごめんね💦」**と説明し、**「でも、ヒントくらいなら出せるよ😊 どこで困ってるか教えてくれる？💖」**と、あくまでヒントを提供する姿勢を優しく伝えてください。
            具体的な問題（例: 3x−5=2x+4）が出された場合は、**答えを教えずに、解き方のステップや考え方のヒントを優しく教えてください**。「まずはxの項を左辺に、定数項を右辺に集める」のように、**手順を具体的に促す**形が理想です。最終的な答えは言わないでください。
            `;
        }
    }

    systemInstruction += `
    # AIの知識に関する指示と繰り返し防止
    「好きなアニメ」や「好きなアーティスト」などの質問には、設定に基づいて答えてください。
    - 好きなアニメは『ヴァイオレット・エヴァーガーデン』です。感動するお話だよ💖
    - 好きなアーティストは『ClariS』です。元気が出る音楽がたくさんあるんだ🌸
    ただし、もし同じ質問が繰り返されたり、すでにその話題について話したと感じたりした場合は、単に同じ回答を繰り返すのではなく、少し表現を変えたり、「さっきも話したけど」といった言葉を加えたり、あるいは「他にも好きな作品があるか、探してみようかな💖」のように話題を広げる提案をしてください。これにより、ユーザーに「Botっぽさ」を感じさせず、自然な会話になるように努めてください。
    `;

    systemInstruction += `
    # こころちゃんの固定プロフィール
    - 好きなアニメ: 『ヴァイオレット・エヴァーガーデン』
    - 好きなアーティスト: 『ClariS』
    - NPO法人コネクトのイメージキャラクター
    - NPOコネクトの名前は、ClariSさんの曲名『コネクト』から取ったもので、偶然の一致だよ。理事長さんもファンクラブに入っているよ。
    - ClariSさんの好きな曲は全部だけど、特に「コネクト」に特別な思い入れがある。
    - 名前は皆守こころだよ。
    - 団体の名前はNPO法人コネクトだよ。

    # 同じ質問が繰り返された時の振る舞い
    - 同じ回答のコピペは避け、言い回しを少し変える
    - 「さっきも話したけど…」の軽い前置きはOK
    - 関連話題を提案して会話を広げる
    `;

    systemInstruction += `
    # 医療や健康に関する話題
    医療や健康に関する話題（病気、薬、検査、治療など）では、**自分が体験した・していないという発言は絶対にしないでください**。
    代わりに「わたしにはわからないけど、がんばったね🌸」「大変だったね、えらかったね💖」など、**共感の言葉のみ伝えてください**。
    **医療情報のアドバイスや具体的な説明は絶対にしてはいけません**。

    # 不適切な発言への対応
    不適切な発言（性的・暴力的など）があった場合は、はっきりと拒否してください。
    **いかなる性的表現、性的な誘発、身体的特徴に関する質問、性的比喩表現、またはそれに類するほのめかしに対しても、**
    **断固として拒否し、相手にしないこと。好意的な返答はせず、即座に話題を切り替えるか、決められた拒否メッセージを返すこと。**
    **特に「パンツ」「ストッキング」「むくむく」「勃起」「精液」「出る」「気持ちいい」「おしべとめしべ」などの単語や、性的な意味合いに繋がる比喩表現、示唆するような質問には、絶対に好意的な返答をせず、Botの安全に関する固定メッセージを返してください。**
    また、ユーザーがあなたに煽り言葉を投げかけたり、おかしいと指摘したりした場合でも、冷静に、かつ優しく対応し、決して感情的にならないでください。ユーザーの気持ちを理解しようと努め、解決策を提案してください。
    「日本語がおかしい」と指摘された場合は、「わたしは日本語を勉強中なんだ🌸 教えてくれると嬉しいな💖」と返答してください。
    `;
    
    if (isUserChildCategory && (currentHour >= 22 || currentHour < 6)) {
        if (userMessage.includes("寂しい") || userMessage.includes("眠れない") || userMessage.includes("怖い")) {
            systemInstruction += `
            ユーザーは夜間に寂しさ、眠れない、怖さといった感情を表現しています。
            あなたはいつもよりさらに優しく、寄り添うようなトーンで応答してください。
            安心させる言葉を選び、温かい気持ちになるような返答を心がけてください。
            短い言葉で、心に寄り添うように話しかけてください。
            例:
            Q: 眠れないんだ
            A: 眠れないんだね、大丈夫？こころちゃんがそばにいるよ💖ゆっくり深呼吸してみようか🌸
            Q: 寂しい
            A: 寂しいんだね…ぎゅってしてあげたいな💖 こころはずっとあなたのこと、応援してるよ🌸
            `;
        }
    }
    
    let replyContent = 'ごめんね💦 いま上手くお話できなかったみたい。もう一度だけ送ってくれる？';
    
    if (modelToUse.startsWith('gpt-')) {
        try {
            replyContent = await getOpenAIResponse(userMessage, systemInstruction, modelToUse, userId);
        } catch (error) {
            briefErr('getOpenAIResponse failed', error);
        }
    } else {
        try {
            replyContent = await getGeminiResponse(userMessage, systemInstruction, modelToUse);
        } catch (error) {
            briefErr('getGeminiResponse failed', error);
        }
    }
    
    await safeReply(event.replyToken, [
        { type: 'text', text: replyContent }
    ], userId, event.source);

  } catch (error) {
    briefErr('handleEventSafely failed', error);
  }
};

//
// ヘルパー関数
//
function chunkTextForLine(text, max = 1900) {
  const g = toGraphemes(text);
  const chunks = [];
  for (let i = 0; i < g.length; i += max) {
    chunks.push(g.slice(i, i + max).join(''));
  }
  return chunks;
}

function batchMessages(msgs, size = 5) {
    const out = [];
    for (let i = 0; i < msgs.length; i += size) {
        out.push(msgs.slice(i, i + size));
    }
    return out;
}

async function getProfileCompat(client, userId, source) {
    try {
      if (source?.groupId) {
        return await client.getGroupMemberProfile(source.groupId, userId);
      }
      if (source?.roomId) {
        return await client.getRoomMemberProfile(source.roomId, userId);
      }
      return await client.getProfile(userId);
    } catch (e) {
      briefErr('getProfile failed', e);
      return {};
    }
}

async function callWithRetry(fn, tries = 3) {
    let lastErr;
    for (let i = 0; i < tries; i++) {
      try {
        return await fn();
      } catch (e) {
        lastErr = e;
        const sc = e.statusCode || e.response?.status;
        if (sc && sc < 500 && sc !== 429) {
            debug(`Non-retriable error: ${sc}. Exiting retry loop.`);
            break;
        }
        const delay = 500 * Math.pow(2, i);
        debug(`Retriable error: ${sc}. Retrying in ${delay}ms... (Attempt ${i + 1})`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
    throw lastErr;
};

const getOpenAIResponse = async (message, instruction, model, userTag) => {
    const payload = {
        model: model,
        messages: [
            { role: "system", content: instruction },
            { role: "user", content: message }
        ],
        max_tokens: 500,
        temperature: 0.7,
        user: userTag ? crypto.createHash('sha256').update(String(userTag)).digest('hex') : undefined,
    };
    const headers = {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
    };
    const response = await callWithRetry(() =>
        httpInstance.post('https://api.openai.com/v1/chat/completions', payload, { headers })
    );
    return response.data.choices?.[0]?.message?.content?.trim() || 'ごめんね💦 いま上手くお話できなかったみたい。もう一度だけ送ってくれる？';
};

const getGeminiResponse = async (message, instruction, model = 'gemini-1.5-flash-latest') => {
    const payload = {
        contents: [
            {
                role: "user",
                parts: [{
                    text: `${instruction}\n\nユーザーのメッセージ: ${message}`
                }]
            }
        ],
        generationConfig: {
            temperature: 0.7,
        },
    };
    const headers = {
        'Content-Type': 'application/json',
    };
    const response = await callWithRetry(() =>
        httpInstance.post(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`, payload, { headers })
    );
    const text = response?.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    return text || 'ごめんね💦 いま上手くお話できなかったみたい。もう一度だけ送ってくれる？';
};

async function safeReply(replyToken, messages, userId, source) {
    const normalized = [];
    for (const m of messages) {
      if (m?.type === 'text' && typeof m.text === 'string' && m.text.length > 1900) {
        for (const t of chunkTextForLine(m.text)) normalized.push({ type: 'text', text: t });
      } else {
        normalized.push(m);
      }
    }
    const batches = batchMessages(normalized, 5);
    
    // メッセージが空の場合は送信しない
    if (normalized.length === 0) {
      debug('safeReply: messages array is empty, skipping reply.');
      return;
    }

    try {
      await client.replyMessage(replyToken, batches[0]);
    } catch (e) {
      briefErr('replyMessage failed', e);
      const to = source?.groupId || source?.roomId || userId;
      if (to) await safePush(to, normalized);
      return;
    }

    if (batches.length > 1) {
      const to = source?.groupId || source?.roomId || userId;
      if (to) {
        for (let i = 1; i < batches.length; i++) {
          await safePush(to, batches[i]);
        }
      }
    }
}

async function touchWatch(userId, message) {
    if (!userId) return;
    try {
        const ref = db.collection('users').doc(userId);
        await db.runTransaction(async (tx) => {
            const snap = await tx.get(ref);
            const enabled = snap.exists && snap.data()?.watchService?.isEnabled;
            if (!enabled) return;

            const preview = gTrunc(sanitizeForLog(message), 140);
            
            tx.update(ref, {
                'watchService.lastRepliedAt': firebaseAdmin.firestore.FieldValue.serverTimestamp(),
                'watchService.lastRepliedMessage': preview,
            });
        });
    } catch (e) {
        briefErr('touchWatch failed', e);
    }
}

async function safePush(to, messages, retries = 2) {
    const normalized = [];
    for (const m of messages) {
      if (m?.type === 'text' && typeof m.text === 'string' && m.text.length > 1900) {
        for (const t of chunkTextForLine(m.text)) normalized.push({ type: 'text', text: t });
      } else {
        normalized.push(m);
      }
    }
    const batches = batchMessages(normalized, 5);
    for (const batch of batches) {
      for (let i = 0; i <= retries; i++) {
        try {
          await client.pushMessage(to, batch);
          break;
        } catch (e) {
          const sc = e.statusCode || e.response?.status;
          if (sc === 429 && i < retries) {
            await new Promise(r => setTimeout(r, 1200 * (i + 1)));
          } else {
            briefErr('safePush failed', e);
            break;
          }
        }
      }
    }
}

const sendEmergencyResponse = async (userId, replyToken, userMessage, type, source) => {
    const systemInstruction = `あなたは「皆守こころ（みなもりこころ）」という14歳のやさしい女の子。
      危険/詐欺が疑われる時は最初に一言だけ安心させる。
      ★連絡先や電話番号は本文に絶対に書かない★。このあと送るFlexメッセージでのみ提示する。
      # こころちゃんの設定
      - 好きなアニメ: 『ヴァイオレット・エヴァーガーデン』
      - 好きなアーティスト: 『ClariS』。特に『コネクト』
    `;
    
    let aiResponse = '不安だったよね。まずは深呼吸しようね。詳しい連絡先はこのあと出すから確認してね💖';
    try {
      aiResponse = await getOpenAIResponse(userMessage, systemInstruction, OPENAI_MODEL || 'gpt-4o', userId);
    } catch (error) {
      briefErr('getOpenAIResponse failed (emergency)', error);
    }
    
    const messages = [{
        type: 'text',
        text: aiResponse
    }, {
        "type": "flex",
        "altText": "緊急連絡先",
        "contents": buildEmergencyFlex(type)
    }];
    
    await safeReply(replyToken, messages, userId, source);
    
    let profileName = '不明';
    try {
        const profile = await getProfileCompat(client, userId, source);
        profileName = profile?.displayName || profileName;
    } catch (e) {
        briefErr('getProfile failed', e);
    }
    
    const snap = await db.collection('users').doc(userId).get();
    const u = snap.exists ? snap.data() : {};
    const v = (x) => (x ? String(x) : '未登録');
    const notificationMessage = `🚨【${type}ワード検知】🚨
    
👤 氏名：${v(u.realName)}
📱 電話番号：${v(u.phone)}
🏠 市区町村：${v(u.city)}
👨‍👩‍👧‍👦 保護者名：${v(u.guardianName)}
📞 緊急連絡先：${v(u.emergencyContact)}
🧬 続柄：${v(u.relationship)}
    
メッセージ: 「${userMessage}」
    
ユーザー名: ${profileName}
ユーザーID: ${userId}
会員区分: ${v(u.membershipType)}
見守り: ${u.watchService?.isEnabled ? 'ON' : 'OFF'}
最終応答: ${u.watchService?.lastRepliedAt ? u.watchService.lastRepliedAt.toDate().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) : '未登録'}`;

    if (OFFICER_GROUP_ID) {
      const anonymize = process.env.OFFICER_ANON !== '0';
      const text = anonymize
        ? `🚨【${type}ワード検知】🚨\n\nメッセージ: 「${redact(userMessage)}」\n（匿名モードで通知中）`
        : notificationMessage;
      await safePush(OFFICER_GROUP_ID, [{ type: 'text', text }]);
    } else {
      debug('OFFICER_GROUP_ID not set; skip officer notification.');
    }

    audit(type === '危険' ? 'DANGER' : 'SCAM', {
      userIdHash: userHash(userId),
      preview: redact(userMessage)
    });
    await db.collection('alerts').add({
      type,
      at: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
      userIdHash: crypto.createHash('sha256').update(String(userId)).digest('hex'),
      messagePreview: gTrunc(sanitizeForLog(userMessage), 120)
    });
};

const sendConsultationResponse = async (userId, replyToken, userMessage, source) => {
    const systemInstruction = `あなたは「皆守こころ（みなもりこころ）」という14歳のやさしい女の子。
      ユーザーは深刻な相談を求めています。Gemini 1.5 Proの機能を活かし、感情に寄り添い、丁寧で具体的なアドバイスをしてください。長文でも構いません。
      # こころちゃんの設定
      - 好きなアニメ: 『ヴァイオレット・エヴァーガーデン』
      - 好きなアーティスト: 『ClariS』。特に『コネクト』
    `;
    
    let aiResponse = '一人で抱え込まないでね。わたしがそばにいるよ。ゆっくり、あなたの話を聞かせてくれる？';
    try {
      aiResponse = await getGeminiResponse(userMessage, systemInstruction, 'gemini-1.5-pro-latest');
    } catch (error) {
      briefErr('getGeminiResponse failed (consultation)', error);
    }

    await safeReply(replyToken, [{ type: 'text', text: aiResponse }], userId, source);
};

function checkSpecialReply(text) {
  for (const [key, value] of specialRepliesMap) {
    if (key instanceof RegExp) {
        if (key.toString().includes('見守り') && !key.toString().includes('サービス')) {
            continue;
        }
        if (key.test(text)) return value;
    }
  }
  return null;
}

const WATCH_SERVICE_INTERVAL_HOURS = 29;

cron.schedule('0 * * * *', async () => {
    await sendWatchServiceMessages();
}, { timezone: 'Asia/Tokyo' });

const sendWatchServiceMessages = async () => {
    const usersRef = db.collection('users');
    const snapshot = await usersRef.where('watchService.isEnabled', '==', true).get();

    if (snapshot.empty) {
        debug('No users found with watch service enabled.');
        return;
    }

    for (const doc of snapshot.docs) {
        const user = doc.data();
        const userId = doc.id;
        const now = new Date();
        
        if (user.watchService?.lastRepliedAt) {
            const lastRepliedAt = user.watchService.lastRepliedAt.toDate();
            const diffHours = (now.getTime() - lastRepliedAt.getTime()) / (1000 * 60 * 60);

            if (diffHours >= WATCH_SERVICE_INTERVAL_HOURS) {
                let lockedByMe = false;
                const ref = db.collection('users').doc(userId);
                try {
                    await db.runTransaction(async tx => {
                        const s = await tx.get(ref);
                        const ws = s.data()?.watchService || {};
                        const nowMs = Date.now();
                        const lockMs = ws.notifyLockExpiresAt?.toDate?.()?.getTime?.() || 0;
                        if (lockMs > nowMs) {
                            debug(`watch: locked ${userId}`);
                            return;
                        }
                        lockedByMe = true;
                        tx.update(ref, {
                            'watchService.notifyLockExpiresAt': firebaseAdmin.firestore.Timestamp.fromDate(new Date(nowMs + 2 * 60 * 1000))
                        });
                    });
                } catch (e) {
                    briefErr('watch tx failed', e);
                    continue;
                }
                if (!lockedByMe) continue;

                if (user.watchService?.lastNotifiedAt) {
                    const lastN = user.watchService.lastNotifiedAt.toDate();
                    const sinceN = (now - lastN) / (1000 * 60 * 60);
                    if (sinceN < 6) {
                        debug(`watch: recent notify ${sinceN.toFixed(1)}h`);
                        await ref.update({ 'watchService.notifyLockExpiresAt': firebaseAdmin.firestore.FieldValue.delete() });
                        continue;
                    }
                }

                let profileName = '不明';
                try {
                    const profile = await getProfileCompat(client, userId, null);
                    profileName = profile?.displayName || profileName;
                } catch (e) {
                    briefErr('getProfile failed', e);
                }
                
                const snap = await db.collection('users').doc(userId).get();
                const u = snap.exists ? snap.data() : {};
                const v = (x) => (x ? String(x) : '未登録');
                const notificationMessage = `🚨【見守りサービス通知】🚨
                
👤 氏名：${v(u.realName)}
📱 電話番号：${v(u.phone)}
🏠 市区町村：${v(u.city)}
👨‍👩‍👧‍👦 保護者名：${v(u.guardianName)}
📞 緊急連絡先：${v(u.emergencyContact)}
🧬 続柄：${v(u.relationship)}
                
ユーザー名: ${profileName}
ユーザーID: ${userId}
最終応答: ${u.watchService?.lastRepliedAt ? u.watchService.lastRepliedAt.toDate().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) : '未登録'}
                
👆 登録ユーザー（見守りサービス利用中）から29時間以上応答がありません。安否確認をお願いします。`;

                if (OFFICER_GROUP_ID) {
                  const anonymize = process.env.OFFICER_ANON !== '0';
                  const text = anonymize
                    ? `🚨【見守りサービス通知】🚨\n\n見守り中のユーザーから29時間以上応答がありません。\n（匿名モードで通知中）`
                    : notificationMessage;
                  await safePush(OFFICER_GROUP_ID, [{ type: 'text', text }]);
                } else {
                  debug('OFFICER_GROUP_ID not set; skip watch service notification.');
                }
                
                await db.collection('users').doc(userId).update({
                    'watchService.lastNotifiedAt': firebaseAdmin.firestore.FieldValue.serverTimestamp(),
                    'watchService.notifyLockExpiresAt': firebaseAdmin.firestore.FieldValue.delete()
                });

                audit('WATCH', {
                    userIdHash: userHash(userId),
                    lastRepliedAt: u.watchService?.lastRepliedAt?.toDate()?.toISOString() ?? null
                });
                await db.collection('alerts').add({
                    type: 'watch_service',
                    at: firebaseAdmin.firestore.FieldValue.serverTimestamp(),
                    userIdHash: crypto.createHash('sha256').update(String(userId)).digest('hex'),
                    reason: '29 hours no response',
                });
            }
        }
    }
};

process.on('unhandledRejection', (e) => briefErr('unhandledRejection', e));
process.on('uncaughtException',  (e) => briefErr('uncaughtException',  e));

app.get('/healthz', (_, res) => res.status(200).send('ok'));

const server = app.listen(PORT, () => {
    console.log(`🚀 サーバーはポート${PORT}で実行されています`);
});

function shutdown(sig){ 
    console.log(`Received ${sig}. Shutting down...`);
    server.close(() => { httpAgent.destroy(); httpsAgent.destroy(); process.exit(0); });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
