/*  The Exam Academy — Gemini backend for the IELTS planner app
    -------------------------------------------------------------
    Matches what www/index.html's aiCall() sends:
        POST /api/ielts-evaluator
        { systemInstruction, contents, maxTokens }  ->  { reply }

    Calls Google's Gemini REST API directly with fetch — no Google SDK.

    Model handling is self-healing: it tries a list of models in order and
    uses the first that responds. If the newest model is unavailable to this
    account (404) or overloaded (503/429), it automatically falls back to the
    next. Set GEMINI_MODEL to pin one specific model and skip the fallback.

    Run locally:
        cd server
        npm install
        export GEMINI_API_KEY=your-key        (never commit this)
        npm start

    On Render: root dir "server", build "npm install", start "npm start",
    env var GEMINI_API_KEY set in the dashboard.
*/

const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors()); // You can restrict this to your app's domain later
app.use(express.json({ limit: '1mb' }));

// Serve the app itself, so students can use it in a browser at this
// same URL — no install needed. (../www is the Capacitor web folder.)
const path = require('path');
app.use(express.static(path.join(__dirname, '..', 'www')));

const API_KEY = process.env.GEMINI_API_KEY;
const APP_SECRET = process.env.APP_SECRET || '';

// If GEMINI_MODEL is set, use only that. Otherwise try these in order —
// cheaper/steadier first, newest/busiest last as a guaranteed fallback.
const MODELS = process.env.GEMINI_MODEL
    ? [process.env.GEMINI_MODEL]
    : ['gemini-3.1-flash-lite', 'gemini-flash-latest', 'gemini-3.5-flash'];

if (!API_KEY) {
    console.error('Missing GEMINI_API_KEY.\nRun:  export GEMINI_API_KEY=your-key   then start again.');
    process.exit(1);
}

const RETRYABLE = [429, 500, 503, 504];
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Remember which model last worked so we try it first next time.
let preferredModel = MODELS[0];

async function callGemini(payload) {
    // Try the last-known-good model first, then the rest.
    const order = [preferredModel, ...MODELS.filter(m => m !== preferredModel)];
    let lastErr = { status: 502, message: 'No model responded' };

    for (const model of order) {
        const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model +
            ':generateContent?key=' + encodeURIComponent(API_KEY);

        // One model: retry a couple of times on transient overload before moving on.
        for (let attempt = 0; attempt < 3; attempt++) {
            let r, data;
            try {
                r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload });
                data = await r.json().catch(() => ({}));
            } catch (e) {
                lastErr = { status: 502, message: 'Network error reaching Gemini' };
                break;
            }

            if (r.ok) {
                preferredModel = model;
                const reply = (((data.candidates || [])[0] || {}).content || { parts: [] }).parts
                    .map(p => p.text || '').join('');
                return { ok: true, reply, model };
            }

            lastErr = { status: r.status, message: (data.error && data.error.message) || 'Upstream error' };

            if (RETRYABLE.includes(r.status)) {
                console.warn(model + ' busy (' + r.status + '), retry ' + (attempt + 1));
                await sleep(600 * (attempt + 1));
                continue; // try same model again
            }
            // Not retryable (e.g. 404 model unavailable, 400 bad key) — move to next model.
            console.warn(model + ' unusable (' + r.status + '): ' + lastErr.message);
            break;
        }
    }
    return { ok: false, ...lastErr };
}

app.get('/health', (req, res) => res.json({ ok: true, models: MODELS, preferred: preferredModel }));

// Diagnostic: lists the models THIS key is actually allowed to use for
// generateContent. Open in a browser to see real, valid model names.
app.get('/models', async (req, res) => {
    try {
        const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?key=' + encodeURIComponent(API_KEY) + '&pageSize=200');
        const data = await r.json();
        if (!r.ok) return res.status(r.status).json(data);
        const usable = (data.models || [])
            .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
            .map(m => (m.name || '').replace('models/', ''));
        res.json({ count: usable.length, models: usable });
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
});

app.post('/api/ielts-evaluator', async (req, res) => {
    if (APP_SECRET && req.headers['x-app-secret'] !== APP_SECRET) {
        return res.status(401).json({ message: 'Bad app secret' });
    }
    try {
        const { systemInstruction, contents, maxTokens } = req.body || {};

        const payload = JSON.stringify({
            systemInstruction: { parts: [{ text: String(systemInstruction || '') }] },
            contents: (Array.isArray(contents) ? contents : []).map(m => ({
                role: m.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: String(m.text || '') }]
            })),
            generationConfig: { maxOutputTokens: Math.min(Number(maxTokens) || 400, 2000) }
        });

        const result = await callGemini(payload);
        if (result.ok) return res.json({ reply: result.reply });

        console.error('Gemini failed', result.status, result.message);
        const friendly = RETRYABLE.includes(result.status)
            ? 'The AI is very busy right now. Please try again in a moment.'
            : result.message;
        res.status(result.status).json({ message: friendly });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Failed to connect to AI' });
    }
});

// Render provides the PORT automatically
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`ielts-api running on port ${port} (models: ${MODELS.join(', ')})`));
