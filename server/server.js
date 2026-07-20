/*  The Exam Academy — Gemini backend for the IELTS planner app
    -------------------------------------------------------------
    Matches what www/index.html's aiCall() sends:
        POST /api/ielts-evaluator
        { systemInstruction, contents, maxTokens }  ->  { reply }

    Calls Google's Gemini REST API directly with fetch — no Google SDK.
    (The old @google/generative-ai@0.1.1 package was from 2023 and could not
    use systemInstruction or the gemini-2.5 models, so every call failed.)

    Run locally:
        cd server
        npm install
        export GEMINI_API_KEY=AIza...        (never commit this)
        npm start

    On Render: root dir "server", build "npm install", start "npm start",
    env var GEMINI_API_KEY set in the dashboard.
*/

const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors()); // You can restrict this to your app's domain later
app.use(express.json({ limit: '1mb' }));

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL_NAME = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const APP_SECRET = process.env.APP_SECRET || '';

if (!API_KEY) {
    console.error('Missing GEMINI_API_KEY.\nRun:  export GEMINI_API_KEY=your-key   then start again.');
    process.exit(1);
}

app.get('/health', (req, res) => res.json({ ok: true, model: MODEL_NAME }));

app.post('/api/ielts-evaluator', async (req, res) => {
    if (APP_SECRET && req.headers['x-app-secret'] !== APP_SECRET) {
        return res.status(401).json({ message: 'Bad app secret' });
    }
    try {
        const { systemInstruction, contents, maxTokens } = req.body || {};

        const r = await fetch(
            'https://generativelanguage.googleapis.com/v1beta/models/' + MODEL_NAME + ':generateContent?key=' + encodeURIComponent(API_KEY),
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    systemInstruction: { parts: [{ text: String(systemInstruction || '') }] },
                    contents: (Array.isArray(contents) ? contents : []).map(m => ({
                        role: m.role === 'assistant' ? 'model' : 'user',
                        parts: [{ text: String(m.text || '') }]
                    })),
                    generationConfig: { maxOutputTokens: Math.min(Number(maxTokens) || 400, 2000) }
                })
            }
        );

        const data = await r.json();
        if (!r.ok) {
            const msg = (data.error && data.error.message) || 'Upstream error';
            console.error('Gemini error', r.status, msg);
            return res.status(r.status).json({ message: msg });
        }

        const reply = (((data.candidates || [])[0] || {}).content || { parts: [] }).parts
            .map(p => p.text || '').join('');
        res.json({ reply });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Failed to connect to AI' });
    }
});

// Render provides the PORT automatically
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`ielts-api running on port ${port} (model: ${MODEL_NAME})`));
