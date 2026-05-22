/**
 * Anki Card Creator — Google Apps Script Backend
 *
 * Setup (one time):
 *   1. Project Settings > Script Properties:
 *        ANTHROPIC_API_KEY = sk-ant-... (from console.anthropic.com)
 *   2. Deploy > New deployment > Web app:
 *        Execute as: Me
 *        Who has access: Anyone
 *      Copy the /exec URL into index.html as APPS_SCRIPT_URL.
 */

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MODEL = 'claude-sonnet-4-6';

// ── Routing ───────────────────────────────────────────────────────────────────

function doGet(e) {
  return jsonOut({ ok: true, service: 'anki-card-creator' });
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (body.action === 'generate') return jsonOut(handleGenerate(body));
    return jsonOut({ error: 'Unknown action: ' + body.action });
  } catch (err) {
    return jsonOut({ error: String(err.message || err) });
  }
}

// ── Card generation ───────────────────────────────────────────────────────────

function handleGenerate(body) {
  const content = String(body.content || '').trim();
  if (!content) return { error: 'No content provided.' };

  const cardCount = body.card_count ? parseInt(body.card_count) : null;
  const countHint = cardCount
    ? 'Generate approximately ' + cardCount + ' cards.'
    : 'Generate as many cards as needed to cover all key concepts (aim for 10–30).';

  const system =
    'You are an expert at creating Anki flashcards following spaced repetition best practices. ' +
    'You always respond with valid JSON arrays only — no prose, no markdown fences.';

  const userPrompt =
    'Convert the following study material into Anki flashcards. ' + countHint + '\n\n' +
    'Rules:\n' +
    '- Each card tests ONE atomic concept\n' +
    '- Fronts are concise, specific questions\n' +
    '- Backs are accurate answers (no filler text)\n' +
    '- Use plain language; avoid jargon unless the material requires it\n' +
    '- Tags: 1–3 lowercase topic keywords, hyphens for spaces (e.g. "machine-learning")\n\n' +
    'Return ONLY a JSON array:\n' +
    '[{"front": "...", "back": "...", "tags": ["tag1"]}, ...]\n\n' +
    'Study material:\n' + content;

  const response = callClaude({
    model: MODEL,
    max_tokens: 8096,
    system: system,
    messages: [{ role: 'user', content: userPrompt }],
  });

  let raw = extractText(response).trim();

  // Strip accidental markdown code fences
  if (raw.indexOf('```') === 0) {
    const parts = raw.split('```');
    raw = parts.length > 1 ? parts[1] : raw;
    if (raw.indexOf('json') === 0) raw = raw.slice(4);
    raw = raw.trim();
  }

  let cards;
  try {
    cards = JSON.parse(raw);
  } catch (err) {
    return { error: 'Failed to parse Claude response as JSON: ' + err.message + '\n\nRaw:\n' + raw.slice(0, 400) };
  }

  if (!Array.isArray(cards)) return { error: 'Claude returned JSON but not an array.' };

  return { cards: cards };
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function callClaude(payload) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) throw new Error('Script Property "ANTHROPIC_API_KEY" is not set.');

  const maxAttempts = 3;
  let lastCode = 0, lastBody = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = UrlFetchApp.fetch(ANTHROPIC_API_URL, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    });
    const code = res.getResponseCode();
    const body = res.getContentText();
    if (code === 200) return JSON.parse(body);
    lastCode = code;
    lastBody = body;
    const retriable = code === 429 || code === 502 || code === 503 || code === 529;
    if (!retriable || attempt === maxAttempts) break;
    Utilities.sleep(Math.min(8000, 500 * Math.pow(2, attempt)));
  }
  throw new Error('Claude API ' + lastCode + ': ' + lastBody.slice(0, 300));
}

function extractText(response) {
  return (response.content || [])
    .filter(function (b) { return b.type === 'text'; })
    .map(function (b) { return b.text; })
    .join('\n');
}

function jsonOut(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
