/*  The Exam Academy — Gemini backend for the IELTS planner app
    -------------------------------------------------------------
    This is your uploaded ielts-api server, generalised so it matches what
    www/index.html's aiCall() already sends: POST /api/ielts-evaluator with
    { systemInstruction, contents, maxTokens } -> { reply }.

    The original version hardcoded one fixed "evaluate this paraphrase" prompt
    and a narrower { prompt, studentAnswer } body. The app actually sends a
    DIFFERENT systemInstruction for each feature (plan feedback, self-checks,
    the Socratic coach) — so this server no longer bakes in any one task. It's
    a thin, generic relay to Gemini; the app decides what to ask for.

    Run it locally:
        cd server
        npm install
        export GEMINI_API_KEY=AIza...        (never commit this)
        npm start

    Deploy on Render:
        1. Push this repo to GitHub.
        2. render.com -> New + -> Web Service -> pick the repo.
        3. Root directory: server   |   Build command: npm install   |   Start command: npm start
        4. Add environment variable GEMINI_API_KEY with your key.
        5. Deploy. Render gives you a URL like https://ielts-api.onrender.com — test
           <that-url>/health, then paste it into BACKEND_URL in www/index.html
           (see the comment near aiCall()).
*/

const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(cors()); // You can restrict this to your app's domain later
app.use(express.json({ limit: '1mb' }));

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL_NAME = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const APP_SECRET = process.env.APP_SECRET || ''; // optional shared password, see README

if (!API_KEY) {
    console.error('Missing GEMINI_API_KEY.\nRun:  export GEMINI_API_KEY=your-key   then start again.');
    process.exit(1);
}

const genAI = new GoogleGenerativeAI(API_KEY);

app.get('/health', (req, res) => res.json({ ok: true, model: MODEL_NAME }));

app.post('/api/ielts-evaluator', async (req, res) => {
    if (APP_SECRET && req.headers['x-app-secret'] !== APP_SECRET) {
        return res.status(401).json({ message: 'Bad app secret' });
    }
    try {
        const { systemInstruction, contents, maxTokens } = req.body || {};

        const model = genAI.getGenerativeModel({
            model: MODEL_NAME,
            systemInstruction: String(systemInstruction || '')
        });

        // The app sends contents as [{ role: 'user' | 'assistant', text: '...' }, ...]
        const history = (Array.isArray(contents) ? contents : []).map(m => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: String(m.text || '') }]
        }));

        const result = await model.generateContent({
            contents: history,
            generationConfig: { maxOutputTokens: Math.min(Number(maxTokens) || 400, 2000) }
        });

        res.json({ reply: result.response.text() });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Failed to connect to AI' });
    }
});

// Render provides the PORT automatically
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`ielts-api running on port ${port} (model: ${MODEL_NAME})`));
