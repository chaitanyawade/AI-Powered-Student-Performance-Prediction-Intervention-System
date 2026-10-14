// The ML model's learning coach: turns ML findings into a 3-step improvement roadmap, each step with a related resource.
// Built-in rules always work; the AI (Gemini) is called from here, server-side, when the ML findings change.
const crypto = require("crypto");
const gemini = require("./gemini");

const q = encodeURIComponent;
const LINK = {   // links are search pages built by us, so a made-up URL can never reach a student
  video: t => `https://www.youtube.com/results?search_query=${q(t + " explained")}`,
  practice: t => `https://www.google.com/search?q=${q(t + " practice questions")}`,
  notes: t => `https://www.google.com/search?q=${q(t + " revision notes")}`
};
const sig = f => crypto.createHash("sha1").update(JSON.stringify(f)).digest("hex");

function builtIn(f) {
  const weak = f.weakestSubject ? f.weakestSubject.subject : (Object.entries(f.marksBySubjectPercentThisSemester || {}).sort((a, b) => a[1] - b[1])[0] || [])[0] || null;
  const subj = weak || "your weakest subject", T = weak || "exam revision techniques";
  const STEP = {
    marks: { title: `Revise ${subj}`, detail: "Spend 30 focused minutes a day on topics where you lost marks in the last two exams.", resource: { topic: T, type: "video", why: "Re-learn the key ideas" } },
    subject: { title: `Catch up in ${subj}`, detail: f.subjectsBelowPassMark > 0 ? "This subject is below the pass mark. Ask your teacher which topics to start with, then practise them daily." : "Work through its weakest topics first, 30 minutes a day.", resource: { topic: T, type: "practice", why: "Practise the basics" } },
    trend: { title: "Fix last exam's mistakes", detail: "Redo every question you lost marks on, then ask your teacher about any you still miss.", resource: { topic: T, type: "practice", why: "Practise the questions you missed" } },
    attendance: { title: "Attend every class this week", detail: `Aim for ${f.attendanceRequiredPercent}% or more. Missed classes are the quickest way to fall behind.`, resource: { topic: "how to catch up on missed classes", type: "notes", why: "Get back on track quickly" } },
    quiz: { title: "Take a short daily quiz", detail: "Ten minutes of practice questions a day helps you remember before exams.", resource: { topic: T, type: "practice", why: "Ten minutes of questions a day" } },
    teacher: { title: "Meet your teacher", detail: "Ask for one thing to work on and show your progress next week.", resource: { topic: "how to ask your teacher for help", type: "notes", why: "Make your check-in count" } }
  };
  const asKey = k => (k === "att" ? "attendance" : k);
  const keys = f.riskLevel === "Low" ? ["marks", "quiz", "attendance"]
    : [...(f.levers || []).map(l => l.lever), ...(f.mainReasons || []).map(r => asKey(r.factor)), "marks", "quiz", "attendance"];
  return {
    headline: f.riskLevel === "Low" ? "You are on track. Keep your routine steady."
      : `Start with ${subj}. Small steps, one week at a time, will turn things around.`,
    steps: [...new Set(keys)].filter(k => STEP[k]).slice(0, 3).map(k => ({ ...STEP[k], lever: k }))
  };
}

// The AI may only reword the model's findings: numbers it quotes must come from the findings (small numbers like minutes are fine).
function grounded(out, f) {
  const known = new Set((JSON.stringify(f).match(/\d+/g) || []));
  const text = [out.headline, ...out.steps.flatMap(s => [s.title, s.detail, s.resource.why])].join(" ");
  return (text.match(/\d+/g) || []).every(n => Number(n) <= 60 || known.has(n));
}

const WHEN = ["Week 1", "Week 2", "Weeks 3–4"];
async function make(f, useAI) {
  let out = { ...builtIn(f), source: "ml" }, tried = false;
  if (useAI) {
    tried = true;
    try {
      const ai = await gemini.plan(f);
      if (grounded(ai, f)) out = { ...ai, source: "ai" }; else console.error("AI plan rejected: it quoted numbers that are not in the findings.");
    } catch (e) { console.error("AI plan failed:", e.message); }
  }
  const effect = Object.fromEntries((f.levers || []).map(l => [l.lever, l.effect]));
  out.steps = out.steps.map((s, i) => ({ when: WHEN[i], lever: s.lever, effect: effect[s.lever] || "", title: s.title, detail: s.detail, resource: { title: s.resource.topic, type: s.resource.type, why: s.resource.why, url: LINK[s.resource.type](s.resource.topic) } }));
  return { ...out, tried };
}
module.exports = { sig, make, canUseAI: gemini.enabled };
