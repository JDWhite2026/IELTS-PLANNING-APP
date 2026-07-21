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

/* ============================================================
   CLASS DASHBOARD STORAGE
   Uses Postgres if DATABASE_URL is set (e.g. a free Neon database),
   otherwise keeps data in memory so you can test straight away.
   In-memory data resets whenever the server restarts - fine for a
   quick trial, but set DATABASE_URL before a real class uses it.
   ============================================================ */
let pgPool = null;
if (process.env.DATABASE_URL) {
    try {
        const { Pool } = require('pg');
        pgPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
        pgPool.query(`CREATE TABLE IF NOT EXISTS attempts (
            id SERIAL PRIMARY KEY,
            class_code TEXT NOT NULL,
            name TEXT NOT NULL,
            kind TEXT NOT NULL,
            qtype TEXT,
            checks INTEGER,
            created_at TIMESTAMPTZ DEFAULT now()
        )`).then(() => console.log('Dashboard: Postgres ready')).catch(e => console.error('Postgres init error', e.message));
    } catch (e) {
        console.error('DATABASE_URL set but "pg" not installed - run npm install. Falling back to memory.');
    }
}
const memAttempts = []; // in-memory fallback

const clean = (s, max) => String(s == null ? '' : s).replace(/[<>]/g, '').trim().slice(0, max);

async function saveAttempt(rec) {
    const row = {
        class_code: clean(rec.code, 24).toUpperCase(),
        name: clean(rec.name, 40) || 'Anon',
        kind: rec.kind === 'essay' ? 'essay' : 'plan',
        qtype: clean(rec.qtype, 40),
        checks: Math.max(0, Math.min(5, parseInt(rec.checks, 10) || 0))
    };
    if (!row.class_code) return;
    if (pgPool) {
        await pgPool.query(
            'INSERT INTO attempts (class_code, name, kind, qtype, checks) VALUES ($1,$2,$3,$4,$5)',
            [row.class_code, row.name, row.kind, row.qtype, row.checks]
        );
    } else {
        row.created_at = new Date().toISOString();
        memAttempts.push(row);
    }
}

async function getClassRows(code) {
    const c = clean(code, 24).toUpperCase();
    if (pgPool) {
        const r = await pgPool.query('SELECT class_code, name, kind, qtype, checks, created_at FROM attempts WHERE class_code=$1 ORDER BY created_at DESC LIMIT 5000', [c]);
        return r.rows;
    }
    return memAttempts.filter(a => a.class_code === c).slice().reverse();
}

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

/* ============================================================
   DASHBOARD ENDPOINTS
   ============================================================ */

// The app quietly reports a finished plan or a marked essay.
app.post('/api/report', async (req, res) => {
    try {
        await saveAttempt(req.body || {});
        res.json({ ok: true });
    } catch (e) {
        console.error('report error', e.message);
        res.status(500).json({ ok: false });
    }
});

// JSON summary for one class (used by the dashboard page).
app.get('/api/class/:code', async (req, res) => {
    try {
        const rows = await getClassRows(req.params.code);
        const byName = {};
        let missTotals = [0, 0, 0, 0, 0]; // boundary, P1, P2, position, conclusion — only 'plan' rows carry checks
        const CHECK_NAMES = ['Boundary', 'Paragraph 1', 'Paragraph 2', 'Position', 'Conclusion'];
        rows.forEach(r => {
            const key = r.name || 'Anon';
            byName[key] = byName[key] || { name: key, plans: 0, essays: 0, checkSum: 0, checkCount: 0, last: r.created_at };
            const s = byName[key];
            if (r.kind === 'essay') s.essays++;
            else { s.plans++; s.checkSum += (r.checks || 0); s.checkCount++; }
            if (r.created_at > s.last) s.last = r.created_at;
        });
        const students = Object.values(byName).map(s => ({
            name: s.name, plans: s.plans, essays: s.essays,
            avg: s.checkCount ? (s.checkSum / s.checkCount) : null,
            last: s.last
        })).sort((a, b) => (b.plans + b.essays) - (a.plans + a.essays));
        res.json({
            code: clean(req.params.code, 24).toUpperCase(),
            totalPlans: rows.filter(r => r.kind !== 'essay').length,
            totalEssays: rows.filter(r => r.kind === 'essay').length,
            students
        });
    } catch (e) {
        console.error('class error', e.message);
        res.status(500).json({ error: e.message });
    }
});

// The teacher dashboard page itself.
app.get('/dashboard', (req, res) => {
    res.type('html').send(`<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Class dashboard — The Exam Academy</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Inter:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>
  :root{--orange:#F0923B;--deep:#d97b22;--wash:rgba(240,146,59,0.1);--ink:#171512;--sec:#5f594f;--mut:#97907f;--line:#e9e4dc;--paper:#f7f4ef;--ok:#1d7a3f;}
  *{box-sizing:border-box}
  body{font-family:Inter,system-ui,sans-serif;color:var(--ink);background:var(--paper);margin:0;padding:24px 16px 60px;line-height:1.5}
  .wrap{max-width:820px;margin:0 auto}
  h1{font-family:'Space Grotesk',serif;font-size:1.5rem;margin:0 0 2px}
  .sub{color:var(--sec);font-size:.9rem;margin-bottom:20px}
  .code-row{display:flex;gap:8px;margin-bottom:22px;flex-wrap:wrap}
  input{flex:1;min-width:160px;padding:11px 13px;border:1.5px solid #d8d1c6;border-radius:10px;font-size:1rem;font-family:inherit;text-transform:uppercase}
  button{padding:11px 20px;border:none;border-radius:10px;background:var(--orange);color:#fff;font-weight:800;font-family:inherit;cursor:pointer;font-size:.95rem}
  .stats{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:20px}
  .stat{background:#fff;border:1px solid var(--line);border-radius:12px;padding:14px;text-align:center}
  .stat .n{font-family:'Space Grotesk',serif;font-size:1.6rem;font-weight:700}
  .stat .l{font-size:.62rem;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:var(--mut);margin-top:3px}
  table{width:100%;border-collapse:collapse;background:#fff;border:1px solid var(--line);border-radius:12px;overflow:hidden}
  th,td{padding:11px 13px;text-align:left;font-size:.9rem;border-bottom:1px solid var(--line)}
  th{font-size:.62rem;font-weight:800;text-transform:uppercase;letter-spacing:.07em;color:var(--mut);background:var(--paper)}
  td.num,th.num{text-align:center}
  tr:last-child td{border-bottom:none}
  .avg-pill{display:inline-block;padding:2px 9px;border-radius:99px;font-weight:700;font-size:.8rem;background:var(--wash);color:var(--deep)}
  .avg-low{background:#faeae6;color:#c2402f}
  .empty{color:var(--mut);text-align:center;padding:30px;background:#fff;border:1px dashed #d8d1c6;border-radius:12px}
  .note{font-size:.78rem;color:var(--mut);margin-top:16px}
</style></head><body><div class="wrap">
  <h1>Class dashboard</h1>
  <div class="sub">See how a class is getting on with their planning practice.</div>
  <div class="code-row">
    <input id="code" placeholder="Class code (e.g. EA-7B)" />
    <button onclick="load()">View class</button>
  </div>
  <div id="out"></div>
  <div class="note">Anyone with a class code can view its dashboard. Keep codes to yourself and your class.</div>
</div>
<script>
  const q = new URLSearchParams(location.search);
  const el = id => document.getElementById(id);
  if (q.get('code')) { el('code').value = q.get('code'); load(); }
  async function load(){
    const code = el('code').value.trim().toUpperCase();
    if(!code){return;}
    history.replaceState(null,'','?code='+encodeURIComponent(code));
    el('out').innerHTML = '<div class="empty">Loading…</div>';
    try{
      const r = await fetch('/api/class/'+encodeURIComponent(code));
      const d = await r.json();
      if(!d.students || !d.students.length){ el('out').innerHTML = '<div class="empty">No activity yet for <b>'+code+'</b>. Once students enter this code and finish a plan, they\\'ll appear here.</div>'; return; }
      const rows = d.students.map(s => {
        const avg = s.avg==null ? '—' : '<span class="avg-pill '+(s.avg<3?'avg-low':'')+'">'+s.avg.toFixed(1)+'/5</span>';
        const when = s.last ? new Date(s.last).toLocaleDateString() : '—';
        return '<tr><td>'+esc(s.name)+'</td><td class="num">'+s.plans+'</td><td class="num">'+s.essays+'</td><td class="num">'+avg+'</td><td class="num">'+when+'</td></tr>';
      }).join('');
      el('out').innerHTML =
        '<div class="stats"><div class="stat"><div class="n">'+d.students.length+'</div><div class="l">Students</div></div>'+
        '<div class="stat"><div class="n">'+d.totalPlans+'</div><div class="l">Plans made</div></div>'+
        '<div class="stat"><div class="n">'+d.totalEssays+'</div><div class="l">Essays marked</div></div></div>'+
        '<table><thead><tr><th>Student</th><th class="num">Plans</th><th class="num">Essays</th><th class="num">Avg checklist</th><th class="num">Last active</th></tr></thead><tbody>'+rows+'</tbody></table>';
    }catch(e){ el('out').innerHTML = '<div class="empty">Couldn\\'t load that class - try again.</div>'; }
  }
  function esc(s){return String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}
</script></body></html>`);
});

// Render provides the PORT automatically
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`ielts-api running on port ${port} (models: ${MODELS.join(', ')})`));
