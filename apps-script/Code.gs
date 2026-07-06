/**
 * Ryo & Nanako Wedding — RSVP サイドカー (Google Apps Script)
 *
 * 役割: Vercel の /api/rsvp から転送された出欠回答を受け取り、
 *   1) スプレッドシートに1行追記（Notion のバックアップ）
 *   2) ゲストへ「送信内容の確認メール」を送信
 *   3) 新郎新婦へ「回答通知メール」を送信
 *
 * セットアップ:
 *   - このスクリプトを出欠用スプレッドシートにバインド（拡張機能 → Apps Script）
 *   - プロジェクトの設定 → スクリプト プロパティ に以下を登録:
 *       RSVP_SECRET  : Vercel の GAS_SHARED_SECRET と同じ値（共有シークレット）
 *       NOTIFY_EMAIL : 新郎新婦の通知先メールアドレス
 *   - デプロイ → 新しいデプロイ → 種類「ウェブアプリ」
 *       実行ユーザー: 自分 / アクセス: 全員
 *   - 初回デプロイ時に MailApp 送信の権限承認が必要
 *   - 発行された URL を Vercel の GAS_WEBHOOK_URL に設定
 */

var SHEET_NAME = '出欠';
var HEADERS = [
  '受信日時', '出欠', '姓', '名', 'せい', 'めい',
  '新郎新婦', 'ご関係', 'メールアドレス', '電話番号', 'ご住所',
  'アレルギー・食事制限', 'ステータス',
];

// 挙式情報（メール文面に使用）
var WEDDING = {
  date: '2026年9月19日（土）',
  reception: '16:30 〜',
  venue: '小笠原伯爵邸（東京）',
};

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return json_({ ok: false, error: 'no_body' }, 400);
    }

    var body = JSON.parse(e.postData.contents);

    // 共有シークレット照合
    var expected = PropertiesService.getScriptProperties().getProperty('RSVP_SECRET');
    if (!expected || body.secret !== expected) {
      return json_({ ok: false, error: 'forbidden' }, 403);
    }

    var data = {
      timestamp: body.timestamp || new Date().toISOString(),
      attendance: s_(body.attendance),
      sei: s_(body.sei),
      mei: s_(body.mei),
      seiKana: s_(body.seiKana),
      meiKana: s_(body.meiKana),
      side: s_(body.side),
      relation: s_(body.relation),
      email: s_(body.email),
      phone: s_(body.phone),
      address: s_(body.address),
      allergy: s_(body.allergy),
    };

    // 1) シートに追記（最優先 — ここは確実に通す）
    appendRow_(data);

    // 2) & 3) メール送信（ベストエフォート。失敗しても追記は成立済み）
    try { sendGuestMail_(data); } catch (mailErr) { Logger.log('guest mail failed: ' + mailErr); }
    try { sendNotifyMail_(data); } catch (mailErr) { Logger.log('notify mail failed: ' + mailErr); }

    return json_({ ok: true }, 200);
  } catch (err) {
    Logger.log('doPost error: ' + err);
    return json_({ ok: false, error: String(err) }, 500);
  }
}

// 簡易ヘルスチェック
function doGet() {
  return json_({ ok: true, service: 'rsvp-sidecar' }, 200);
}

function appendRow_(d) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
  }
  sheet.appendRow([
    formatJst_(d.timestamp),
    d.attendance, d.sei, d.mei, d.seiKana, d.meiKana,
    d.side, d.relation, d.email, d.phone, d.address,
    d.allergy, '新規',
  ]);
}

function sendGuestMail_(d) {
  if (!d.email) return;
  var attending = d.attendance === '出席';
  var subject = '【Ryo & Nanako Wedding】ご回答ありがとうございました';

  var lead = attending
    ? 'この度はご出席のお返事をいただき、誠にありがとうございます。<br>当日お会いできますことを、心より楽しみにしております。'
    : 'この度はお返事をいただき、誠にありがとうございます。<br>残念ではございますが、またお会いできる日を楽しみにしております。';

  var rows = [
    ['ご出欠', d.attendance],
    ['お名前', d.sei + ' ' + d.mei + '（' + d.seiKana + ' ' + d.meiKana + '）'],
    ['ご関係', d.side + ' / ' + d.relation],
    ['ご連絡先', d.email + (d.phone ? '　' + d.phone : '')],
    ['ご住所', d.address],
  ];
  if (d.allergy) rows.push(['アレルギー・食事制限', d.allergy]);

  var html =
    '<div style="font-family:\'Hiragino Mincho ProN\',serif;color:#28231D;line-height:1.9;max-width:560px;">' +
      '<p style="font-size:15px;letter-spacing:0.04em;">' + lead + '</p>' +
      summaryTable_(rows) +
      '<div style="margin:24px 0 8px;padding:18px 20px;background:#F6EFDE;border:1px solid rgba(40,35,29,0.12);">' +
        '<p style="margin:0;font-size:11px;letter-spacing:0.3em;color:#9E8458;text-transform:uppercase;">Wedding</p>' +
        '<p style="margin:8px 0 0;font-size:14px;">日時：' + WEDDING.date + '　受付 ' + WEDDING.reception + '<br>会場：' + WEDDING.venue + '</p>' +
      '</div>' +
      '<p style="font-size:13px;color:#46403A;">ご記入内容に変更がございましたら、お手数ですが新郎新婦まで直接ご連絡ください。</p>' +
      '<p style="font-size:13px;color:#46403A;margin-top:20px;">Ryo &amp; Nanako</p>' +
    '</div>';

  MailApp.sendEmail({
    to: d.email,
    subject: subject,
    htmlBody: html,
    name: 'Ryo & Nanako Wedding',
  });
}

function sendNotifyMail_(d) {
  var to = PropertiesService.getScriptProperties().getProperty('NOTIFY_EMAIL');
  if (!to) return;

  var subject = '【RSVP】' + d.sei + ' ' + d.mei + ' 様 — ' + d.attendance + '（' + d.side + '）';
  var rows = [
    ['ご出欠', d.attendance],
    ['お名前', d.sei + ' ' + d.mei],
    ['ふりがな', d.seiKana + ' ' + d.meiKana],
    ['新郎/新婦', d.side],
    ['ご関係', d.relation],
    ['メール', d.email],
    ['電話', d.phone || '—'],
    ['住所', d.address],
    ['アレルギー・食事制限', d.allergy || '—'],
    ['受信日時', formatJst_(d.timestamp)],
  ];

  var html =
    '<div style="font-family:sans-serif;color:#222;line-height:1.8;max-width:560px;">' +
      '<p style="font-size:15px;">新しい出欠の回答が届きました。</p>' +
      summaryTable_(rows) +
    '</div>';

  MailApp.sendEmail({ to: to, subject: subject, htmlBody: html });
}

// ── helpers ──────────────────────────────────────────────
function summaryTable_(rows) {
  var html = '<table style="border-collapse:collapse;margin:18px 0;width:100%;font-size:14px;">';
  for (var i = 0; i < rows.length; i++) {
    html +=
      '<tr>' +
        '<td style="padding:8px 12px;border-bottom:1px solid #eee;color:#948876;white-space:nowrap;vertical-align:top;">' + escape_(rows[i][0]) + '</td>' +
        '<td style="padding:8px 12px;border-bottom:1px solid #eee;">' + escape_(rows[i][1]).replace(/\n/g, '<br>') + '</td>' +
      '</tr>';
  }
  return html + '</table>';
}

function formatJst_(iso) {
  try {
    return Utilities.formatDate(new Date(iso), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm');
  } catch (err) {
    return iso;
  }
}

function s_(v) {
  return (typeof v === 'string' ? v : '').trim();
}

function escape_(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function json_(obj, code) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
