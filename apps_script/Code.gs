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
    'This image has a red percentage grid overlaid on it. ' +
    'The numbers along the TOP edge are x_pct values (0 = left edge, 100 = right edge). ' +
    'The numbers down the LEFT edge are y_pct values (0 = top edge, 100 = bottom edge). ' +
    'Grid lines appear every 10%.\n\n' +
    'Find every TEXT LABEL, name, number, or annotation printed on this study image that students need to memorize. ' +
    'Focus on TEXT — labels on anatomical structures, numbered items, key terms written on the image. ' +
    'Do NOT identify the structures themselves, only their text labels. ' +
    'IGNORE any title, heading, or caption banner at the very top of the image (typically above y_pct 8).\n\n' +
    'For each label provide:\n' +
    '- label: the exact text as it appears on the image\n' +
    '- x_pct: left edge of the box as % of image width — READ FROM THE GRID, use one decimal place (e.g. 23.5)\n' +
    '- y_pct: top edge of the box as % of image height — READ FROM THE GRID, use one decimal place\n' +
    '- w_pct: box width as % of image width (typically 8–20 for a text label)\n' +
    '- h_pct: box height as % of image height (typically 3–8 for a single line of text)\n\n' +
    'CRITICAL: Read coordinates directly off the grid — do NOT round to multiples of 5 or 10. ' +
    'If a label sits between the 20 and 30 vertical lines and roughly 3/10 of the way across, use 23.0. ' +
    'Size each box to just cover the text — not the structure it points to.\n\n' +
    'Aim for 5–20 labels depending on image complexity.\n\n' +
    'Return ONLY a JSON array:\n' +
    '[{"label":"term","x_pct":23.5,"y_pct":41.2,"w_pct":14.0,"h_pct":4.5}, ...]';

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
      label: String(b.label || ''),
      x_pct: Math.max(0, Math.min(95, Number(b.x_pct) || 0)),
      y_pct: Math.max(0, Math.min(95, Number(b.y_pct) || 0)),
      w_pct: Math.max(1, Math.min(100, Number(b.w_pct) || 10)),
      h_pct: Math.max(1, Math.min(100, Number(b.h_pct) || 5))
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
