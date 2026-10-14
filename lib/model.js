// EduPlus ML inference (model v2): student records -> 12 engineered features -> calibrated logistic model
// -> risk band + exact explanation + "what-if" levers + data-reliability.
// Coefficients, scaling, calibration and risk bands come from model/model.json (trained by ml/train.py).
// The feature maths below mirrors ml/train.py; test/parity.json proves both give identical numbers.
const base = require("../model/model.json");

const PASS = 40;                                           // a subject average below this counts as failing
// Display groups: each group sums the exact contributions of its features.
const GROUP = { marks: [0, 3], trend: [1, 2], subject: [4, 5], att: [6, 7, 8], quiz: [9, 10], teacher: [11] };
const KEYS = Object.keys(GROUP);

const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
const std = a => Math.sqrt(avg(a.map(v => (v - avg(a)) ** 2)));
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const sigmoid = v => 1 / (1 + Math.exp(-v));
const clone = o => JSON.parse(JSON.stringify(o));

function slope(arr) {                                      // least-squares trend per step
  const n = arr.length;
  if (n < 2) return 0;
  const mx = (n - 1) / 2, my = avg(arr);
  let num = 0, den = 0;
  arr.forEach((y, i) => { num += (i - mx) * (y - my); den += (i - mx) ** 2; });
  return num / den;
}

/* ---------- data processing: app record -> canonical record (same shape the trainer uses) ---------- */
function canon(d) {
  const subj = {}, att = {};
  for (const s of Object.keys(d.sub || {})) {
    const v = Object.values(d.sub[s]).filter(Boolean).map(e => 100 * e.s / e.max);
    if (v.length) subj[s] = v;
  }
  for (const s of Object.keys(d.att || {})) {
    const v = Object.values(d.att[s]).filter(x => x !== "N").map(x => (x === "P" ? 1 : 0));   // "not considered" days never count
    if (v.length) att[s] = v;
  }
  return { m: d.m.slice(-6), a: d.a.slice(-6), q: (d.q || []).slice(-5), t: d.t, subj, att };
}

/* ---------- feature engineering (mirrors features() in ml/train.py) ---------- */
function featuresFromCanon(c) {
  const m = c.m, n = m.length, last3 = avg(m.slice(-3));
  const prev = m.slice(0, -1), z = (m[n - 1] - avg(prev)) / Math.max(std(prev), 5);
  const smean = Object.values(c.subj).filter(v => v.length).map(avg);
  const a = c.a, attOverall = avg(a.slice(-3));
  const attTrend = a.length >= 2 ? a[a.length - 1] - avg(a.slice(Math.max(0, a.length - 4), a.length - 1)) : 0;
  const subAtt = Object.values(c.att).filter(v => v.length >= 3).map(v => 100 * avg(v));
  const q = c.q.slice(-5);
  return [
    last3, slope(m.slice(-6)), std(m.slice(-5)), Math.min(z, 0),
    smean.length ? Math.min(...smean) : last3, smean.filter(v => v < PASS).length,
    attOverall, attTrend, subAtt.length ? Math.min(...subAtt) : attOverall,
    q.length ? avg(q) : 60, q.length >= 3 ? slope(q) : 0, c.t
  ];
}
const quizAvg = d => (d.q && d.q.length ? avg(d.q.slice(-5)) : 60);

/* ---------- model ---------- */
// A saved (learned) state is only usable if it was made for this model version.
const usable = st => (st && st.coef && st.coef.length === base.coef.length && st.version === base.version ? st : base);
const standardise = (x, st) => x.map((v, i) => (v - st.mean[i]) / st.scale[i]);
const logitOf = (x, st) => {
  const z = standardise(x, st), raw = st.intercept + z.reduce((t, v, i) => t + st.coef[i] * v, 0);
  return { z, raw, p: sigmoid(st.calib ? st.calib.a * raw + st.calib.b : raw) };
};
const band = p => (p >= base.bands.high ? "High" : p >= base.bands.medium ? "Medium" : "Low");

// How much the prediction can be trusted depends on how much data stands behind it.
function reliability(c, d) {
  const exams = c.m.length, days = Object.values(c.att).reduce((t, v) => t + v.length, 0), quizzes = (d.q || []).length;
  const score = 0.45 * Math.min(exams, 6) / 6 + 0.30 * Math.min(days, 40) / 40 + 0.15 * Math.min(quizzes, 3) / 3 + 0.10 * Math.min(Object.keys(c.subj).length, 5) / 5;
  return { score: Math.round(score * 100), label: score >= 0.8 ? "High" : score >= 0.55 ? "Medium" : "Low", exams, attendanceDays: days, quizzes };
}

// What-if levers: how far would the risk fall if one thing improved by a realistic step?
// (A model estimate from the learned relationships, not a promise.)
const LEVERS = [
  { k: "attendance", step: "attendance +10 points", apply: x => { x[6] = Math.min(100, x[6] + 10); x[8] = Math.min(100, x[8] + 10); } },
  { k: "marks", step: "marks +8 points", apply: x => { x[0] = Math.min(100, x[0] + 8); x[4] = Math.min(100, x[4] + 8); } },
  { k: "subject", step: "weakest subject +12 points", apply: x => { x[4] = Math.min(100, x[4] + 12); if (x[5] > 0) x[5] -= 1; } },
  { k: "trend", step: "marks stop falling", apply: x => { x[1] = Math.max(x[1], 0); x[2] = Math.min(x[2], 3); x[3] = 0; } },
  { k: "quiz", step: "quiz average +10 points", apply: x => { x[9] = Math.min(100, x[9] + 10); } }
];
function levers(x, st, p) {
  return LEVERS.map(L => { const y = x.slice(); L.apply(y); const to = Math.round(logitOf(y, st).p * 100); return { k: L.k, step: L.step, from: p, to, gain: p - to }; })
    .filter(l => l.gain >= 1).sort((a, b) => b.gain - a.gain);
}

// ML prediction + Explainable AI (for a linear model, coef * standardised value is the exact contribution)
function analyse(prn, d, state) {
  const c = canon(d);
  if (d.m.length < 3 || d.a.length < 1) {                  // a new student needs 3 exam marks and 1 attendance record
    return { prn, d, insufficient: true, p: null, risk: "Pending", S: 0, contrib: [], levers: [], reliability: reliability(c, d), weak: null, failing: 0,
             att: d.a.length ? d.a[d.a.length - 1] : 0, last3: d.m.length ? avg(d.m) : 0, slope: 0, momentum: 0, z: 0, attDrop: 0, quiz: quizAvg(d), x: null };
  }
  const st = usable(state), x = featuresFromCanon(c), { z, p: prob } = logitOf(x, st), p = Math.round(prob * 100);
  const parts = z.map((v, i) => st.coef[i] * v);
  const raw = KEYS.map(k => ({ k, c: Math.max(0, GROUP[k].reduce((t, i) => t + parts[i], 0)) })), tot = raw.reduce((t, r) => t + r.c, 0);
  const contrib = raw.map(r => ({ k: r.k, c: r.c, share: tot ? r.c / tot : 0 })).sort((a, b) => b.c - a.c);
  const m = c.m, weakest = Object.entries(c.subj).map(([name, v]) => ({ name, pct: Math.round(avg(v)) })).sort((a, b) => a.pct - b.pct)[0] || null;
  return {
    prn, d, S: prob, p, risk: band(prob), x, contrib, levers: levers(x, st, p), reliability: reliability(c, d),
    att: c.a[c.a.length - 1], attAvg: x[6], last3: x[0], slope: x[1], quiz: quizAvg(d), z: (m[m.length - 1] - avg(m.slice(0, -1))) / Math.max(std(m.slice(0, -1)), 5),
    momentum: m.length >= 6 ? avg(m.slice(-3)) - avg(m.slice(-6, -3)) : 0, attDrop: c.a.length > 1 ? c.a[c.a.length - 2] - c.a[c.a.length - 1] : 0,
    weak: weakest, failing: x[5]
  };
}

// Share of the model's weight on each factor group
function weights(state) {
  const st = usable(state), w = KEYS.map(k => GROUP[k].reduce((t, i) => t + Math.abs(st.coef[i]), 0)), tot = w.reduce((a, b) => a + b, 0) || 1;
  return Object.fromEntries(KEYS.map((k, i) => [k, w[i] / tot]));
}

const keepSign = (c, i) => (base.signs[i] > 0 ? Math.max(0, c) : Math.min(0, c));

// Online learning: one small gradient step on a real outcome (x = features before the exam, y = 1 if the student was then at risk).
function learn(state, x, y, lr = 0.05, lam = 0.05) {
  const st = clone(usable(state)), { z, raw } = logitOf(x, st);
  const err = sigmoid(raw) - y;
  st.coef = st.coef.map((c, i) => keepSign(c - lr * (err * z[i] + lam * (c - base.coef[i])), i));
  st.intercept -= lr * err;
  return st;
}

// Batch retraining from recorded outcomes: logistic regression pulled gently toward the trained prior
// (the fewer the examples, the stronger the pull), sign constraints kept.
function fit(ex, prior, { epochs = 400, lr = 0.15 } = {}) {
  const st = clone(usable(prior)), n = ex.length, lam = 20 / Math.max(n, 20), k = st.coef.length;
  const Z = ex.map(e => standardise(e.x, st));
  for (let it = 0; it < epochs; it++) {
    const g = new Array(k).fill(0); let gb = 0;
    Z.forEach((z, i) => { const err = sigmoid(st.intercept + z.reduce((t, v, j) => t + st.coef[j] * v, 0)) - ex[i].y; z.forEach((v, j) => { g[j] += err * v; }); gb += err; });
    st.coef = st.coef.map((c, j) => keepSign(c - lr * (g[j] / n + lam * (c - base.coef[j])), j));
    st.intercept -= lr * gb / n;
  }
  return st;
}

// Honest scoring of a model on examples: log-loss, Brier score and AUC (when both outcomes are present).
function evaluate(state, ex) {
  const st = usable(state), ps = ex.map(e => logitOf(e.x, st).p);
  const logloss = -avg(ps.map((p, i) => ex[i].y ? Math.log(p + 1e-12) : Math.log(1 - p + 1e-12))), brier = avg(ps.map((p, i) => (p - ex[i].y) ** 2));
  const pos = ps.filter((_, i) => ex[i].y), neg = ps.filter((_, i) => !ex[i].y);
  let auc = null;
  if (pos.length && neg.length) { let w = 0; for (const a of pos) for (const b of neg) w += a > b ? 1 : a === b ? 0.5 : 0; auc = w / (pos.length * neg.length); }
  return { n: ex.length, logloss, brier, auc };
}

module.exports = { base, KEYS, PASS, canon, featuresFromCanon, analyse, weights, learn, fit, evaluate, usable, quizAvg, reliability };
