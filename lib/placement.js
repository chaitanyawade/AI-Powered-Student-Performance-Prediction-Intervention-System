// Placement intelligence: skill levels -> role fit -> skill gap -> roadmap -> resources.
// Everything here is decided by the trained placement model (model/placement.json) and by what it has
// learned from real placement results and skill-test history. Gemini only puts the finished result into words.
const catalog = require("../model/careers.json");
const base = require("../model/placement.json");

const SKILLS = catalog.skills.map(s => s.key);
const ASSUMED = 35;                                    // level assumed for a skill nobody has assessed yet
const sigmoid = v => 1 / (1 + Math.exp(-v));
const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
const clone = o => JSON.parse(JSON.stringify(o));
const skillMeta = Object.fromEntries(catalog.skills.map(s => [s.key, s]));

const newState = () => ({ ...clone(base), pace: {}, notes: [] });

/* ----- how good is the student at each skill? Placement-cell tests first, marks as supporting evidence ----- */
function levels(d) {
  const out = {};
  for (const k of SKILLS) {
    const tests = (d.skills && d.skills[k]) || [];
    let tested = null;
    if (tests.length) {
      const last = tests[tests.length - 1].s, prev = tests.slice(0, -1).map(t => t.s);
      tested = prev.length ? last * 0.6 + avg(prev) * 0.4 : last;                // recent result counts most
    }
    let marks = null;
    const map = catalog.academicMap[k];
    if (map) {
      const v = [];
      for (const s of map.subjects) for (const e of Object.values((d.sub && d.sub[s]) || {})) v.push(e.s / e.max * 100);
      if (v.length) marks = avg(v);
    }
    const lv = tested != null && marks != null ? 0.7 * tested + 0.3 * marks : tested != null ? tested : marks;
    out[k] = { level: lv == null ? null : Math.round(lv), src: tested != null ? "tested" : marks != null ? "marks" : null };
  }
  return out;
}

/* ----- how well does this student fit one role? ----- */
function roleFit(role, lv, st) {
  const need = Object.entries(role.req);
  const total = need.reduce((t, [, [, imp]]) => t + imp, 0);
  const x = SKILLS.map(() => 0);
  const gaps = need.map(([k, [req, imp]]) => {
    const have = lv[k].level, eff = have == null ? ASSUMED : have;
    const xi = imp / total * Math.max(0, 1 - eff / req);
    x[SKILLS.indexOf(k)] = xi;
    return { skill: k, need: req, have, src: lv[k].src, gap: Math.max(0, Math.round(req - eff)), cost: (st.w[SKILLS.indexOf(k)] || 0) * xi };
  });
  const fit = Math.round(sigmoid(st.b - gaps.reduce((t, g) => t + g.cost, 0)) * 100);
  gaps.sort((a, b) => b.cost - a.cost);              // the gap that hurts the fit most comes first
  return { fit, gaps, x };
}
const band = f => f >= 70 ? "Strong fit" : f >= 50 ? "Good fit" : f >= 30 ? "Developing" : "Long way to go";

/* ----- learning resources for a skill at the student's level ----- */
function resourcesFor(skill, level) {
  const want = level < 40 ? "beginner" : level < 65 ? "intermediate" : "advanced";
  const all = catalog.resources.filter(r => r.skill === skill);
  const order = { beginner: ["beginner", "intermediate", "advanced"], intermediate: ["intermediate", "beginner", "advanced"], advanced: ["advanced", "intermediate", "beginner"] }[want];
  return order.flatMap(l => all.filter(r => r.level === l)).slice(0, 3).map(({ title, by, type, url, level: lvl }) => ({ title, by, type, url, level: lvl }));
}

/* ----- roadmap: fix the costliest gaps first; time estimates use the pace the model has seen real students achieve ----- */
function buildRoadmap(role, rec, st) {
  const marks = rec.d.m && rec.d.m.length ? avg(rec.d.m.slice(-3)) : 60;
  const factor = 0.8 + 0.4 * Math.min(100, marks) / 100;                       // stronger academics learn a little faster
  let week = 0;
  const steps = [];
  for (const g of role.gaps.filter(g => g.gap >= 5).slice(0, 5)) {
    const pace = (st.pace && st.pace[g.skill]) || skillMeta[g.skill].pace;      // points gained per week
    const weeks = Math.max(1, Math.ceil(g.gap / (pace * factor)));
    const from = g.have == null ? ASSUMED : g.have;
    steps.push({ skill: g.skill, from: g.have, to: g.need, weeks, startWeek: week + 1, endWeek: week + weeks,
                 needsTest: g.have == null || g.src === "marks", resources: resourcesFor(g.skill, from) });
    week += weeks;
  }
  return { role: role.key, title: role.title, totalWeeks: week, steps };
}

/* ----- everything one student needs to see ----- */
function career(rec, st, opts = {}) {
  const lv = levels(rec.d);
  const roles = catalog.roles.map(r => {
    const f = roleFit(r, lv, st);
    return { key: r.key, title: r.title, blurb: r.blurb, fit: f.fit, band: band(f.fit),
             gaps: f.gaps.map(g => ({ ...g, cost: Number(g.cost.toFixed(3)) })) };
  }).sort((a, b) => b.fit - a.fit);
  const target = roles.some(r => r.key === rec.d.target) ? rec.d.target : null;
  const out = {
    skills: Object.fromEntries(SKILLS.map(k => [k, lv[k]])),
    assessed: SKILLS.filter(k => lv[k].src === "tested").length, total: SKILLS.length,
    roles, best: roles[0].key, target, placements: (rec.d.placements || []).slice(-10)
  };
  if (opts.roadmap) out.roadmap = buildRoadmap(roles.find(r => r.key === (target || out.best)), rec, st);
  return out;
}

/* ----- the whole batch, for the TPO's overview ----- */
function cohort(records, st) {
  const sum = {}, tested = {}, bestRoles = {};
  SKILLS.forEach(k => { sum[k] = 0; tested[k] = 0; });
  let ready = 0, n = 0;
  const careers = {};
  for (const [prn, rec] of Object.entries(records)) {
    const c = career(rec, st); n++;
    SKILLS.forEach(k => { if (c.skills[k].level != null) { sum[k] += c.skills[k].level; tested[k]++; } });
    const best = c.roles[0];
    if (best.fit >= 70) ready++;
    bestRoles[best.key] = (bestRoles[best.key] || 0) + 1;
    careers[prn] = { assessed: c.assessed, best: best.key, bestFit: best.fit, target: c.target,
                     topGaps: best.gaps.filter(g => g.gap > 0).slice(0, 2).map(g => g.skill), placements: c.placements.length };
  }
  return { careers, cohort: {
    students: n, ready, bestRoles,
    skillAverages: Object.fromEntries(SKILLS.map(k => [k, tested[k] ? Math.round(sum[k] / tested[k]) : null])),
    skillCounts: Object.fromEntries(SKILLS.map(k => [k, tested[k]]))
  } };
}

/* ----- learning from real placement results (the model's "experience") ----- */
function learn(st, x, y, lr = 1.5, lam = 0.01) {
  const s = clone(st);
  const p = sigmoid(s.b - x.reduce((t, v, i) => t + s.w[i] * v, 0));
  const err = p - y;
  s.w = s.w.map((w, i) => Math.max(0, w + lr * (err * x[i]) - lr * lam * (w - base.w[i])));
  s.b = s.b - lr * 0.5 * err;
  return s;
}

const importance = st => {
  const t = st.w.reduce((a, b) => a + b, 0) || 1;
  return Object.fromEntries(SKILLS.map((k, i) => [k, st.w[i] / t]));
};

const publicCatalog = () => ({
  skills: catalog.skills.map(({ key, label }) => ({ key, label })),
  roles: catalog.roles.map(({ key, title, blurb }) => ({ key, title, blurb }))
});

module.exports = { catalog, base, SKILLS, newState, levels, roleFit, career, cohort, learn, importance, publicCatalog, band };
