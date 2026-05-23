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
    if (body.action === 'generate')      return jsonOut(handleGenerate(body));
    if (body.action === 'analyzeImage')  return jsonOut(handleAnalyzeImage(body));
    return jsonOut({ error: 'Unknown action: ' + body.action });
  } catch (err) {
    return jsonOut({ error: String(err.message || err) });
  }
}

// ── Card generation ───────────────────────────────────────────────────────────

function handleGenerate(body) {
  const content = String(body.content || '').trim();
  if (!content) return { error: 'No content provided.' };

  const cardType = body.card_type === 'cloze' ? 'cloze' : 'basic';
  const cardCount = body.card_count ? parseInt(body.card_count) : null;
  const countHint = cardCount
    ? 'Generate approximately ' + cardCount + ' cards.'
    : 'Generate as many cards as needed to cover all key concepts (aim for 10–30).';

  const system =
    'You are an expert at creating Anki flashcards following spaced repetition best practices. ' +
    'You always respond with valid JSON arrays only — no prose, no markdown fences.';

  const userPrompt = cardType === 'cloze'
    ? buildClozePrompt(content, countHint)
    : buildBasicPrompt(content, countHint);

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

// ── Image analysis ────────────────────────────────────────────────────────────

function handleAnalyzeImage(body) {
  const imageData  = String(body.image_data  || '');
  const mediaType  = String(body.media_type  || 'image/jpeg');
  const imageW     = Number(body.image_width  || 0);
  const imageH     = Number(body.image_height || 0);

  if (!imageData) return { error: 'No image data provided.' };
  if (!imageW || !imageH) return { error: 'Image dimensions missing.' };

  const system =
    'You are an expert at analyzing study images for Anki flashcard creation. ' +
    'You always respond with valid JSON arrays only — no prose, no markdown fences.';

  const userPrompt =
    'This image has a blue coordinate grid overlaid on it, with labeled anchor points (blue boxes with white text). ' +
    'Each anchor label shows "X,Y" where X = % from left edge (0–100) and Y = % from top edge (0–100). ' +
    'Grid lines run every 10%.\n\n' +
    'Your task: find every TEXT LABEL in this study image that students need to memorize — ' +
    'muscle names in colored boxes, anatomical term labels, key terms with arrows or lines pointing to structures. ' +
    'IGNORE: the overall image title/heading at the very top, and any reference numbers (1, 2, 3…) used as pointers.\n\n' +
    'For each text label provide:\n' +
    '- label: the exact text as it appears\n' +
    '- cx_pct: X coordinate of the CENTER of the text label, as % of image width (use the nearest grid anchor to estimate precisely)\n' +
    '- cy_pct: Y coordinate of the CENTER of the text label, as % of image height\n' +
    '- w_pct: width of the text label box as % of image width\n' +
    '- h_pct: height of the text label box as % of image height\n\n' +
    'For cx_pct and cy_pct: find the two nearest anchor points on either side of the label and interpolate. ' +
    'Example: a label halfway between "40,20" and "60,20" anchors has cx_pct=50. ' +
    'Do NOT round to multiples of 10 — use one decimal place (e.g. 47.5).\n\n' +
    'Aim for 5–20 labels depending on image complexity.\n\n' +
    'Return ONLY a JSON array:\n' +
    '[{"label":"Deltoid","cx_pct":18.5,"cy_pct":24.0,"w_pct":16.0,"h_pct":5.0}, ...]';

  const response = callClaude({
    model: MODEL,
    max_tokens: 3000,
    system: system,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageData } },
        { type: 'text',  text: userPrompt }
      ]
    }]
  });

  let raw = extractText(response).trim();
  if (raw.indexOf('```') === 0) {
    const parts = raw.split('```');
    raw = parts.length > 1 ? parts[1] : raw;
    if (raw.indexOf('json') === 0) raw = raw.slice(4);
    raw = raw.trim();
  }

  let boxes;
  try { boxes = JSON.parse(raw); }
  catch (err) { return { error: 'Failed to parse Claude response: ' + err.message + '\n\nRaw: ' + raw.slice(0, 300) }; }

  if (!Array.isArray(boxes)) return { error: 'Expected a JSON array of boxes.' };

  // Clamp percentages to valid range
  boxes = boxes.map(function(b) {
    return {
      label:  String(b.label || ''),
      cx_pct: Math.max(1, Math.min(99, Number(b.cx_pct || b.x_pct) || 50)),
      cy_pct: Math.max(1, Math.min(99, Number(b.cy_pct || b.y_pct) || 50)),
      w_pct:  Math.max(1, Math.min(80, Number(b.w_pct) || 15)),
      h_pct:  Math.max(1, Math.min(40, Number(b.h_pct) || 5))
    };
  });

  return { boxes: boxes };
}

// ── Prompt builders ───────────────────────────────────────────────────────────

function buildBasicPrompt(content, countHint) {
  return (
    'Convert the following study material into Anki flashcards. ' + countHint + '\n\n' +
    'Rules:\n' +
    '- Each card tests ONE atomic concept\n' +
    '- Fronts are concise, specific questions\n' +
    '- Backs are accurate answers (no filler text)\n' +
    '- Use plain language; avoid jargon unless the material requires it\n' +
    '- Tags: 1–3 lowercase topic keywords, hyphens for spaces (e.g. "machine-learning")\n\n' +
    'Return ONLY a JSON array:\n' +
    '[{"front": "...", "back": "...", "tags": ["tag1"]}, ...]\n\n' +
    'Study material:\n' + content
  );
}

function buildClozePrompt(content, countHint) {
  return (
    'Convert the following study material into Anki CLOZE flashcards. ' + countHint + '\n\n' +
    'Rules:\n' +
    '- Each card is a sentence or short paragraph with key terms hidden using {{c1::term}} syntax\n' +
    '- Use {{c1::term}} for the first blank, {{c2::term}} for a second blank in the same card, etc.\n' +
    '- Each card should hide 1–3 of the most important terms — not every word\n' +
    '- The sentence should make full sense when the blanks are revealed\n' +
    '- Keep sentences concise and factually precise\n' +
    '- "extra" field: add a brief clarification or memory hint (optional, can be empty string)\n' +
    '- Tags: 1–3 lowercase topic keywords, hyphens for spaces\n\n' +
    'Example output:\n' +
    '[{"text": "The {{c1::mitochondria}} is the powerhouse of the {{c2::cell}}.", "extra": "Found in eukaryotic cells", "tags": ["biology","cell"]}, ...]\n\n' +
    'Return ONLY a JSON array:\n' +
    '[{"text": "...", "extra": "...", "tags": ["tag1"]}, ...]\n\n' +
    'Study material:\n' + content
  );
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
