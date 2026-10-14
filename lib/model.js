// EduPlus ML inference: features -> trend/momentum/anomaly -> logistic model -> explanation.
// The coefficients come from model/model.json (trained by ml/train.py) and are
// nudged over time by learn() when real exam outcomes arrive.
const base = require("../model/model.json");

// Model inputs: [marks level, attendance, trend slope, quiz average, teacher rating, momentum, anomaly]
// Display groups: momentum is shown under "trend", the anomaly score under "marks".
const GROUP = { marks:[0,6], att:[1], trend:[2,5], quiz:[3], teacher:[4] };
const KEYS = Object.keys(GROUP);
const GAIN = { marks:4, att:1, trend:3, quiz:3, teacher:2 };   // expected exam gain per completed action

const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
const clamp = x => Math.max(0, Math.min(1, x));

function slope(arr) {
  const n = arr.length, mx = (n - 1) / 2, my = avg(arr);
  let num = 0, den = 0;
  arr.forEach((y, i) => { num += (i - mx) * (y - my); den += (i - mx) ** 2; });
  return num / den;
}

// Data processing + feature engineering + historical trend engine + detectors
function quizAvg(d) { return d.q && d.q.length ? avg(d.q.slice(-5)) : 60; }

function features(d) {
  const m = d.m, att = d.a[d.a.length - 1], q = quizAvg(d);
  const last3 = avg(m.slice(-3)), sl = slope(m.slice(-6));
  const momentum = m.length >= 6 ? avg(m.slice(-3)) - avg(m.slice(-6, -3)) : m.length >= 4 ? avg(m.slice(-3)) - avg(m.slice(0, -3)) : 0;
  const prev = m.slice(0, -1), mu = avg(prev);
  const sd = Math.sqrt(avg(prev.map(v => (v - mu) ** 2)));
  const z = (m[m.length - 1] - mu) / Math.max(sd, 5);
  const attDrop = d.a.length > 1 ? d.a[d.a.length - 2] - att : 0;
  return {
    x: [last3, att, sl, q, d.t, momentum, Math.min(z, 0)],
    f: { marks: clamp((75 - last3) / 45), att: clamp((92 - att) / 32), trend: clamp(-sl / 5),
         quiz: clamp((80 - q) / 45), teacher: clamp((5 - d.t) / 4) },
    last3, slope: sl, att, quiz: q, momentum, z, attDrop
  };
}

const sigmoid = v => 1 / (1 + Math.exp(-v));
const standardise = (x, st) => x.map((v, i) => (v - st.mean[i]) / st.scale[i]);

// ML prediction + Explainable AI (for a linear model, coef*value is the exact contribution)
function analyse(prn, d, state) {
  // A new student needs at least 3 exam marks and 1 attendance record before a prediction is meaningful.
  if (d.m.length < 3 || d.a.length < 1) {
    return { prn, d, insufficient: true, p: null, risk: "Pending", S: 0, contrib: [], f: {}, confidence: 0,
             att: d.a.length ? d.a[d.a.length - 1] : 0, last3: d.m.length ? avg(d.m) : 0,
             slope: 0, momentum: 0, z: 0, attDrop: 0, quiz: quizAvg(d), x: null };
  }
  const st = state || base, F = features(d);
  const zx = standardise(F.x, st);
  const parts = zx.map((v, i) => st.coef[i] * v);
  const prob = sigmoid(st.intercept + parts.reduce((a, b) => a + b, 0));
  const p = Math.round(prob * 100);
  const raw = KEYS.map(k => ({ k, c: Math.max(0, GROUP[k].reduce((t, i) => t + parts[i], 0)) }));
  const tot = raw.reduce((t, r) => t + r.c, 0);
  const contrib = raw.map(r => ({ k: r.k, c: r.c, share: tot ? r.c / tot : 0 })).sort((a, b) => b.c - a.c);
  return {
    prn, d, att: F.att, last3: F.last3, slope: F.slope, quiz: F.quiz, f: F.f, S: prob, p,
    risk: p >= 65 ? "High" : p >= 35 ? "Medium" : "Low",
    momentum: F.momentum, z: F.z, attDrop: F.attDrop, contrib,
    confidence: Math.round(100 * Math.max(prob, 1 - prob)), x: F.x
  };
}

// Share of the model's weight that sits on each of the seven factor groups
function weights(state) {
  const st = state || base;
  const w = KEYS.map(k => GROUP[k].reduce((t, i) => t + Math.abs(st.coef[i]), 0));
  const tot = w.reduce((a, b) => a + b, 0);
  return Object.fromEntries(KEYS.map((k, i) => [k, w[i] / tot]));
}

// Model improvement: one gradient step on a real outcome (x = features before the exam,
// y = 1 if the student then declined). L2 pull keeps coefficients near the trained base,
// and the sign constraint (<= 0) from training is preserved.
function learn(state, x, y, lr = 0.06, lam = 0.05) {
  const st = JSON.parse(JSON.stringify(state || base));
  const zx = standardise(x, st);
  const err = sigmoid(st.intercept + zx.reduce((t, v, i) => t + st.coef[i] * v, 0)) - y;
  st.coef = st.coef.map((c, i) => Math.min(0, c - lr * (err * zx[i] + lam * (c - base.coef[i]))));
  st.intercept -= lr * err;
  return st;
}

module.exports = { base, KEYS, GAIN, features, analyse, weights, learn, quizAvg };
