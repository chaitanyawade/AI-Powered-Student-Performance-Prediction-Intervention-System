// Used ONLY by the ML pipeline on the server (lib/coach.js). No page, button or API route lets a person call it.
// It receives anonymous ML findings (no name, PRN or date of birth) and returns a short improvement roadmap, one resource topic per step.
const base = () => (process.env.GEMINI_API_BASE || "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");
const enabled = () => !!process.env.GEMINI_API_KEY;
const model = () => process.env.GEMINI_MODEL || "gemini-3.5-flash";
const TYPES = ["video", "practice", "notes"];

const PROMPT = f => `You are the improvement-roadmap coach inside a school's machine-learning system. Use ONLY these ML findings. Never invent numbers, causes or names. Plain words, no jargon.
Findings (JSON): ${JSON.stringify(f)}
Reply with ONLY JSON: {"headline":"one friendly sentence, max 20 words","steps":[{"title":"max 6 words","detail":"max 25 words","resource":{"topic":"short searchable topic that matches this step, e.g. Normalization in DBMS","type":"video|practice|notes","why":"max 12 words"}}] (exactly 3 roadmap steps in order, weakest subject first)}`;

async function plan(facts) {
  const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(`${base()}/models/${encodeURIComponent(model())}:generateContent`, {
      method: "POST", signal: ctrl.signal,
      headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: PROMPT(facts) }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 1500, responseMimeType: "application/json" } })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Gemini: ${(data.error && data.error.message) || "HTTP " + res.status}`);
    const raw = (((data.candidates || [])[0] || {}).content || {}).parts || [];
    const j = JSON.parse(raw.map(p => p.text || "").join("").replace(/^\s*```(?:json)?|```\s*$/g, "").trim());
    const t = (v, n) => String(v || "").replace(/\s+/g, " ").trim().slice(0, n);
    const steps = (j.steps || []).slice(0, 3).map(s => ({ title: t(s.title, 60), detail: t(s.detail, 200),
      resource: { topic: t(s.resource && s.resource.topic, 80), type: TYPES.includes(s.resource && s.resource.type) ? s.resource.type : "notes", why: t(s.resource && s.resource.why, 100) } }))
      .filter(s => s.title && s.resource.topic);
    if (steps.length < 3) throw new Error("Gemini returned an incomplete roadmap.");
    return { headline: t(j.headline, 160), steps };
  } catch (e) { throw e.name === "AbortError" ? new Error("Gemini took too long.") : e; }
  finally { clearTimeout(timer); }
}
module.exports = { enabled, plan, model };
