const { loadPrompt, preloadAllPrompts } = require('./utils/loadPrompt');
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const rateLimit = require('express-rate-limit');

const fetchFn = globalThis.fetch;

const app = express();
const PORT = process.env.PORT || 3002;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const GRAPH_MODEL = process.env.GRAPH_MODEL || 'gpt-5-mini';

preloadAllPrompts();

// CORS — allow Chrome extensions
const ALLOWED_EXTENSION_IDS = process.env.ALLOWED_EXTENSION_IDS
  ? process.env.ALLOWED_EXTENSION_IDS.split(',').map(id => id.trim())
  : [];

if (ALLOWED_EXTENSION_IDS.length === 0) {
  console.warn('[GRAPHS] WARNING: ALLOWED_EXTENSION_IDS is not set. All Chrome extensions will be allowed.');
}

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (origin.startsWith('chrome-extension://')) {
      if (ALLOWED_EXTENSION_IDS.length === 0) return callback(null, true);
      var extId = origin.replace('chrome-extension://', '');
      if (ALLOWED_EXTENSION_IDS.includes(extId)) return callback(null, true);
      return callback(new Error('Extension not allowed by CORS'));
    }
    if (process.env.NODE_ENV !== 'production') {
      if (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) {
        return callback(null, true);
      }
    }
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Extension-Version']
};

app.use(cors(corsOptions));
app.set('trust proxy', 1);
app.use(express.json({ limit: '50kb' }));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'abaiq-graphs-backend' });
});

// Rate limiter
const graphDataLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { error: 'Too many graph data requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false
});

app.use(graphDataLimiter);

// Minimum extension version
const MIN_EXTENSION_VERSION = '3.0.0';
function checkMinVersion(req, res, next) {
  const extVersion = req.headers['x-extension-version'];
  if (!extVersion) {
    return res.status(426).json({
      error: 'Extension update required',
      message: 'Please update your ABAIQ extension to the latest version.',
      min_version: MIN_EXTENSION_VERSION
    });
  }
  const current = extVersion.split('.').map(Number);
  const minimum = MIN_EXTENSION_VERSION.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((current[i] || 0) < (minimum[i] || 0)) {
      return res.status(426).json({
        error: 'Extension update required',
        message: 'Please update your ABAIQ extension to version ' + MIN_EXTENSION_VERSION + ' or later.',
        min_version: MIN_EXTENSION_VERSION
      });
    }
    if ((current[i] || 0) > (minimum[i] || 0)) break;
  }
  next();
}

// Auth — verify token against main backend
async function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authentication token' });
  }
  const token = authHeader.split(' ')[1];
  const backendUrl = process.env.SUPABASE_BACKEND_URL || 'https://abaiq-backend-production.up.railway.app';

  try {
    const response = await fetchFn(
      backendUrl + '/extension/me',
      { headers: { 'Authorization': 'Bearer ' + token } }
    );
    if (!response.ok) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    req.user = await response.json();
    next();
  } catch (err) {
    console.error('[AUTH] Verification error:', err.message);
    return res.status(401).json({ error: 'Authentication failed' });
  }
}

// Credit consumption via main backend
async function consumeCreditsOnBackend(bearerToken, amount, source) {
  const backendUrl = process.env.SUPABASE_BACKEND_URL || 'https://abaiq-backend-production.up.railway.app';
  try {
    const response = await fetchFn(backendUrl + '/extension/credits/consume', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + bearerToken
      },
      body: JSON.stringify({ amount, source })
    });
    if (!response.ok) {
      const body = await response.text();
      console.error('[CREDITS] Failed to consume credits:', response.status, body);
      return null;
    }
    const data = await response.json();
    console.log('[CREDITS] Credits consumed:', amount, '| Remaining:', (data.credits_left || 0) + (data.extra_credits_balance || 0));
    return data;
  } catch (err) {
    console.error('[CREDITS] Error consuming credits:', err.message);
    return null;
  }
}

// Fix common JSON formatting issues from AI
function fixJSONFormatting(jsonString) {
  let fixed = jsonString;
  fixed = fixed.replace(/```json\n?/g, '').replace(/```\n?/g, '');
  fixed = fixed.replace(/^\uFEFF/, '').trim();
  fixed = fixed.replace(/[\u201C\u201D]/g, '"');
  fixed = fixed.replace(/[\u2018\u2019]/g, "'");
  fixed = fixed.replace(/"\s*\n\s*"/g, '",\n  "');
  fixed = fixed.replace(/,(\s*[}\]])/g, '$1');
  return fixed;
}

// ===============================
// POST /classify-graph-data
// ===============================
app.post('/classify-graph-data', checkMinVersion, verifyToken, async (req, res) => {
  console.log(`[AUDIT] classify_graph_data user=${req.user.sub || req.user.email || 'unknown'} ip=${req.ip}`);
  try {
    const { page_text, page_url, page_title, source } = req.body;

    if (!page_text || typeof page_text !== 'string' || page_text.trim().length === 0) {
      return res.status(400).json({ error: 'Missing required field', details: 'page_text must be a non-empty string' });
    }
    if (page_text.length > 100000) {
      return res.status(400).json({ error: 'page_text exceeds maximum length (100000 chars)' });
    }

    // Credit pre-check — Smart Graphs cost 50 credits (Sonnet 4.6 is the
    // expensive op; pricing parity with BIP analysis to align user mental model
    // of "large AI operation = 50 credits").
    const GRAPH_CREDIT_COST = 50;
    const availableCredits = (req.user.credits_left || 0) + (req.user.extra_credits_balance || 0);
    if (availableCredits < GRAPH_CREDIT_COST) {
      console.log(`⛔ Not enough credits for graph scan: has ${availableCredits}, needs ${GRAPH_CREDIT_COST}`);
      return res.status(402).json({ error: 'Not enough credits', credits_remaining: availableCredits, credits_required: GRAPH_CREDIT_COST });
    }

    const bearerToken = req.headers.authorization.split(' ')[1];
    const systemPrompt = loadPrompt('classify-graph-data.system.txt');

    const userPrompt = `Extract multi-session ABA behavior data from this page for graphing.\n\nPage URL: ${page_url || 'Not provided'}\nPage Title: ${page_title || 'Not provided'}\n\nPage Content:\n${page_text.substring(0, 80000)}`;

    // OpenAI with forced function calling (equivalent of Claude tool_use)
    const itemSchema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string' },
        values: { type: 'array', items: { type: 'number' } },
        labels: { type: 'array', items: { type: 'string' } },
        sto: { type: ['number', 'null'] },
        trend: {
          type: ['object', 'null'],
          additionalProperties: false,
          properties: {
            datapoints: { type: 'number' },
            direction: { type: 'string' },
            slope: { type: 'number' }
          },
          required: ['datapoints', 'direction', 'slope']
        }
      },
      required: ['name', 'values', 'labels', 'sto', 'trend']
    };

    const completion = await openai.chat.completions.create({
      model: GRAPH_MODEL,
      max_completion_tokens: 32000,
      reasoning_effort: 'minimal',
      tools: [
        {
          type: 'function',
          function: {
            name: 'extract_graph_data',
            description: 'Extract ABA behavior data from the page into structured arrays for graphing.',
            strict: true,
            parameters: {
              type: 'object',
              additionalProperties: false,
              properties: {
                maladaptive: { type: 'array', items: itemSchema },
                replacement: { type: 'array', items: itemSchema },
                caregiver: { type: 'array', items: itemSchema }
              },
              required: ['maladaptive', 'replacement', 'caregiver']
            }
          }
        }
      ],
      tool_choice: { type: 'function', function: { name: 'extract_graph_data' } },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    });

    const toolCall = completion.choices?.[0]?.message?.tool_calls?.[0];
    if (!toolCall || !toolCall.function?.arguments) {
      throw new Error('Model did not call extract_graph_data function');
    }
    let parsed;
    try {
      parsed = JSON.parse(toolCall.function.arguments);
    } catch (parseErr) {
      parsed = JSON.parse(fixJSONFormatting(toolCall.function.arguments));
    }

    // Sanitize structure
    const sanitizeItems = (items) => {
      if (!Array.isArray(items)) return [];
      return items.map(item => ({
        name: String(item.name || 'Unknown'),
        values: (Array.isArray(item.values) ? item.values : []).map(v => Number(v) || 0).slice(0, 50),
        labels: (Array.isArray(item.labels) ? item.labels : []).map(l => String(l)).slice(0, 50),
        sto: item.sto != null ? Number(item.sto) : null,
        trend: item.trend && typeof item.trend === 'object' ? {
          datapoints: Number(item.trend.datapoints) || 0,
          direction: String(item.trend.direction || 'Stable'),
          slope: Number(item.trend.slope) || 0
        } : null
      })).filter(item => item.values.length > 0);
    };

    parsed.maladaptive = sanitizeItems(parsed.maladaptive);
    parsed.replacement = sanitizeItems(parsed.replacement);
    parsed.caregiver = sanitizeItems(parsed.caregiver);

    const totalExtracted = parsed.maladaptive.length + parsed.replacement.length + parsed.caregiver.length;
    if (totalExtracted === 0) {
      console.warn('[GRAPH-DATA] No data extracted — skipping credit consumption');
      return res.status(422).json({
        error: 'No graph data could be extracted from this page',
        maladaptive: [],
        replacement: [],
        caregiver: []
      });
    }

    // Consume credits (50)
    const consumeResult = await consumeCreditsOnBackend(bearerToken, GRAPH_CREDIT_COST, source || 'graph_scan');
    if (!consumeResult) {
      console.error('[GRAPH-DATA] Credit consumption failed after successful AI call.');
      return res.status(500).json({ error: 'Credit consumption failed. Please try again.' });
    }

    const creditsRemaining = (consumeResult.credits_left || 0) + (consumeResult.extra_credits_balance || 0);
    parsed.credits_remaining = creditsRemaining;

    console.log(`[GRAPH-DATA] Extracted: ${parsed.maladaptive.length} maladaptive, ${parsed.replacement.length} replacement, ${parsed.caregiver.length} caregiver`);

    return res.json(parsed);
  } catch (err) {
    console.error('[GRAPH-DATA] Error:', err.message);
    return res.status(500).json({ error: 'Graph data extraction failed', details: err.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`\n  ABAIQ GRAPHS BACKEND\n`);
  console.log(`  Status:  Running`);
  console.log(`  Port:    ${PORT}`);
  console.log(`  Health:  http://localhost:${PORT}/health\n`);
});
