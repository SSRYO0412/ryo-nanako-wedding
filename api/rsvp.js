// Vercel Serverless Function — RSVP 受付
// 役割: フォーム送信を受け取り、Notion（CMS=主）に保存し、
//       Apps Script サイドカー（Sheets バックアップ + 確認/通知メール）へも転送する。
// env: NOTION_TOKEN / NOTION_DATABASE_ID / GAS_WEBHOOK_URL / GAS_SHARED_SECRET

// ── 設定 ───────────────────────────────────────────────
// RSVP 締切（JST）。当日末まで受付 = 2026-08-01T00:00:00+09:00 を過ぎたら締切。
const RSVP_DEADLINE = new Date('2026-08-01T00:00:00+09:00').getTime();

const ATTENDANCE = ['出席', '欠席'];
const SIDES = ['新郎側', '新婦側'];
const RELATIONS = [
  '親族', '幼馴染', '小学校', '中学校', '高校', '大学', '職場',
  '高校ラグビー部', '新座片山', '大学ラクロス', '大学アメフト', 'その他',
];

const NOTION_API = 'https://api.notion.com/v1/pages';
const NOTION_VERSION = '2022-06-28';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── ユーティリティ ─────────────────────────────────────
function str(v) {
  return (typeof v === 'string' ? v : '').trim();
}

function richText(content) {
  return { rich_text: [{ text: { content } }] };
}

function parseBody(req) {
  // Vercel は application/json を自動パースするが、文字列で来る場合にも対応
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body.length) {
    try { return JSON.parse(req.body); } catch (_) { return {}; }
  }
  return {};
}

// ── Notion 保存（主）─────────────────────────────────────
async function saveToNotion(data, timestampISO) {
  const props = {
    '氏名': { title: [{ text: { content: `${data.sei} ${data.mei}` } }] },
    '姓': richText(data.sei),
    '名': richText(data.mei),
    'せい': richText(data.seiKana),
    'めい': richText(data.meiKana),
    '出欠': { select: { name: data.attendance } },
    '新郎新婦': { select: { name: data.side } },
    'ご関係': { select: { name: data.relation } },
    'メールアドレス': { email: data.email },
    'ご住所': richText(data.address),
    '受信日時': { date: { start: timestampISO } },
    'ステータス': { select: { name: '新規' } },
  };
  if (data.phone) props['電話番号'] = { phone_number: data.phone };
  if (data.allergy) props['アレルギー・食事制限'] = richText(data.allergy);

  const res = await fetch(NOTION_API, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.NOTION_TOKEN}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      parent: { database_id: process.env.NOTION_DATABASE_ID },
      properties: props,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Notion ${res.status}: ${detail}`);
  }
  return res.json();
}

// ── Sheets + メール（副・サイドカー）─────────────────────
async function forwardToSidecar(data, timestampISO) {
  const url = process.env.GAS_WEBHOOK_URL;
  if (!url) throw new Error('GAS_WEBHOOK_URL not set');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // GAS の CORS/プリフライト回避
    body: JSON.stringify({ secret: process.env.GAS_SHARED_SECRET, timestamp: timestampISO, ...data }),
  });
  if (!res.ok) throw new Error(`Sidecar HTTP ${res.status}`);
  // GAS は常に 200 を返すため、本文の ok まで検証する（secret 不一致などを検知）
  const out = await res.json().catch(() => ({}));
  if (!out.ok) throw new Error(`Sidecar body: ${JSON.stringify(out)}`);
  return true;
}

// ── ハンドラ ───────────────────────────────────────────
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  // 締切チェック（サーバー側の最終防衛線）
  if (Date.now() >= RSVP_DEADLINE) {
    return res.status(403).json({ ok: false, error: 'closed', message: 'ご回答の受付は終了いたしました。' });
  }

  const body = parseBody(req);

  // ハニーポット: bot は隠しフィールドを埋めがち。値があれば静かに成功扱いで破棄。
  if (str(body.company)) {
    return res.status(200).json({ ok: true });
  }

  // 正規化
  const data = {
    attendance: str(body.attendance),
    sei: str(body.sei),
    mei: str(body.mei),
    seiKana: str(body.seiKana),
    meiKana: str(body.meiKana),
    side: str(body.side),
    relation: str(body.relation),
    email: str(body.email),
    phone: str(body.phone),
    address: str(body.address),
    allergy: str(body.allergy),
  };

  // バリデーション（必須）
  const errors = [];
  if (!ATTENDANCE.includes(data.attendance)) errors.push('出欠');
  if (!data.sei) errors.push('姓');
  if (!data.mei) errors.push('名');
  if (!data.seiKana) errors.push('せい');
  if (!data.meiKana) errors.push('めい');
  if (!SIDES.includes(data.side)) errors.push('新郎側/新婦側');
  if (!RELATIONS.includes(data.relation)) errors.push('ご関係');
  if (!EMAIL_RE.test(data.email)) errors.push('メールアドレス');
  if (!data.address) errors.push('ご住所');
  if (errors.length) {
    return res.status(400).json({ ok: false, error: 'validation', fields: errors });
  }

  const timestampISO = new Date().toISOString();

  // Notion（主）と サイドカー（副）を並列実行
  const [notionResult, sidecarResult] = await Promise.allSettled([
    saveToNotion(data, timestampISO),
    forwardToSidecar(data, timestampISO),
  ]);

  // Notion 失敗 = データを失う恐れ → エラーを返してゲストに再送を促す
  if (notionResult.status === 'rejected') {
    console.error('[rsvp] Notion failed:', notionResult.reason);
    if (sidecarResult.status === 'fulfilled') {
      console.warn('[rsvp] Notion failed but sidecar(sheet/mail) succeeded — データは Sheets に存在');
    }
    return res.status(502).json({ ok: false, error: 'notion', message: '送信に失敗しました。お手数ですが時間をおいて再度お試しください。' });
  }

  // Notion 成功・サイドカー失敗 → ゲストには成功（Notion に正データあり）。ログに warning。
  if (sidecarResult.status === 'rejected') {
    console.warn('[rsvp] sidecar(sheet/mail) failed:', sidecarResult.reason);
  }

  return res.status(200).json({ ok: true });
};
