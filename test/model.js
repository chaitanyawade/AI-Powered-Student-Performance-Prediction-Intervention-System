// ML tests: parity with the Python trainer, sensible behaviour, what-if levers, retraining and safety checks.
const assert = require("assert");
const M = require("../lib/model");
const fixtures = require("./parity.json");

const rng = seed => () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const clone = o => JSON.parse(JSON.stringify(o));

// a complete student record in the shape the app stores
const student = (over = {}) => ({
  m: [62, 60, 64, 61, 63, 62], a: [88, 86, 87, 85, 86, 87], q: [65, 70, 60], t: 3,
  sub: { "Data Structures": { e1: { s: 18, max: 30 }, e2: { s: 19, max: 30 } }, "Database Systems": { e1: { s: 20, max: 30 }, e2: { s: 19, max: 30 } } },
  att: { "Data Structures": { d1: "P", d2: "P", d3: "A", d4: "P" }, "Database Systems": { d1: "P", d2: "P", d3: "P", d4: "N" } }, ...over
});

(() => {
  // 1. the live JavaScript model reproduces the trainer's features and probabilities exactly
  for (const f of fixtures) {
    const x = M.featuresFromCanon(f.canon);
    x.forEach((v, i) => assert(Math.abs(v - f.x[i]) < 1e-6, `feature ${M.base.features[i]} differs from Python`));
    const st = M.base, z = x.map((v, i) => (v - st.mean[i]) / st.scale[i]), raw = st.intercept + z.reduce((t, v, i) => t + st.coef[i] * v, 0);
    assert(Math.abs(1 / (1 + Math.exp(-(st.calib.a * raw + st.calib.b))) - f.p) < 1e-6, "probability differs from Python");
  }

  // 2. the model card still meets its quality bar (guards against a bad retrain being committed)
  const mt = M.base.metrics;
  assert(mt.auc >= 0.85 && mt.ece <= 0.05 && mt.recall_at_medium >= 0.75 && mt.precision_at_high >= 0.75, "model quality bar");
  M.base.coef.forEach((c, i) => assert(M.base.signs[i] > 0 ? c >= 0 : c <= 0, "coefficient signs are monotone"));

  // 3. sensible behaviour: better marks, better attendance -> never more risk; more failing subjects -> never less
  const p = d => M.analyse("x", d).p;
  const base = student();
  assert(p(student({ m: base.m.map(v => v + 15) })) <= p(base), "higher marks never raise risk");
  assert(p(student({ a: base.a.map(v => Math.min(100, v + 10)) })) <= p(base), "higher attendance never raises risk");
  assert(p(student({ q: [90, 95, 92] })) <= p(base), "better quizzes never raise risk");
  const failing = student({ sub: { ...base.sub, "Operating Systems": { e1: { s: 6, max: 30 }, e2: { s: 7, max: 30 } } } });
  assert(p(failing) >= p(base), "a failing subject never lowers risk");
  assert.strictEqual(M.analyse("x", failing).weak.name, "Operating Systems");
  assert.strictEqual(M.analyse("x", failing).failing, 1);
  assert(p(student({ m: [70, 70, 70, 70, 70, 30] })) > p(student({ m: [70, 70, 70, 70, 70, 70] })), "a sudden drop raises risk");

  // 4. "not considered" attendance days are ignored
  const withN = M.canon(student());
  assert.deepStrictEqual(withN.att["Database Systems"], [1, 1, 1]);

  // 5. what-if levers: sorted, positive, and consistent with the model
  const slipping = M.analyse("x", student({ m: [78, 74, 70, 64, 58, 52], a: [90, 84, 78, 72, 68, 64], q: [40, 45], t: 2, sub: failing.sub }));
  assert(slipping.risk === "High" && slipping.levers.length >= 2, "a slipping student gets levers");
  slipping.levers.forEach((l, i) => { assert(l.gain >= 1 && l.to < l.from, "lever lowers risk"); if (i) assert(l.gain <= slipping.levers[i - 1].gain, "levers are sorted"); });
  assert.deepStrictEqual(M.analyse("x", student({ m: [90, 91, 92, 93, 92, 94], a: [97, 97, 98, 97, 98, 97], q: [95, 92, 96], t: 5 })).levers.length, 0, "a strong student has nothing to fix");

  // 6. explanations: contributions are exact (shares add up) and the top reason is the real driver
  const sh = slipping.contrib.reduce((t, c) => t + c.share, 0);
  assert(Math.abs(sh - 1) < 1e-9 && slipping.contrib[0].c >= slipping.contrib[1].c);

  // 7. reliability reflects how much data stands behind a prediction
  const thin = M.analyse("x", { m: [60, 62, 61], a: [80], q: [], t: 3, sub: {}, att: {} }), rich = M.analyse("x", student());
  assert(thin.reliability.label === "Low" && rich.reliability.score > thin.reliability.score);
  assert(M.analyse("x", { m: [60, 62], a: [80], q: [], t: 3, sub: {}, att: {} }).insufficient, "too little data: no prediction");

  // 8. a learned state made for another model version is ignored, never mixed in
  const stale = { ...clone(M.base), version: "1.0", coef: [0, 0, 0, 0, 0, 0, 0] };
  assert.strictEqual(M.analyse("x", base, stale).p, M.analyse("x", base).p);

  // 9. retraining: fits new evidence, keeps constraints, and the validation check can tell better from worse
  const r = rng(7), ex = Array.from({ length: 240 }, () => {
    const x = M.base.mean.map((m, i) => m + (r() - 0.5) * 3.4 * M.base.scale[i]);   // a school where attendance matters far more
    const pr = 1 / (1 + Math.exp(-(-0.4 - 2.4 * (x[6] - M.base.mean[6]) / M.base.scale[6])));
    return { x, y: r() < pr ? 1 : 0 };
  });
  const train = ex.slice(0, 180), valid = ex.slice(180), fitted = M.fit(train, M.base);
  assert(M.evaluate(fitted, valid).logloss < M.evaluate(M.base, valid).logloss, "retraining on new evidence improves held-out error");
  fitted.coef.forEach((c, i) => assert(M.base.signs[i] > 0 ? c >= 0 : c <= 0, "constraints survive retraining"));
  const noise = ex.slice(0, 180).map(e => ({ x: e.x, y: r() < 0.5 ? 1 : 0 })), noisy = M.fit(noise, M.base);
  assert(M.evaluate(noisy, valid).logloss >= M.evaluate(fitted, valid).logloss, "a model fitted to random labels is not better");
  assert.strictEqual(M.evaluate({ ...M.base }, [{ x: ex[0].x, y: 1 }, { x: ex[1].x, y: 0 }]).auc === null, false);
  assert.strictEqual(M.learn(null, ex[0].x, 1).coef.length, M.base.coef.length);
  console.log("ML checks passed.");
})();
