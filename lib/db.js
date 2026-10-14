// Storage layer. Uses Supabase when SUPABASE_URL + SUPABASE_SERVICE_KEY are set,
// otherwise a local JSON file (data/local-db.json). If the file system is
// read-only (e.g. Vercel without Supabase) it falls back to memory.
const fs = require("fs");
const path = require("path");

const URL_ = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KEY = process.env.SUPABASE_SERVICE_KEY || "";
const useSupabase = !!(URL_ && KEY);
const enc = encodeURIComponent;

// New Supabase projects use "secret keys" (sb_secret_...). They are not JWTs, so they go in the
// apikey header ONLY. Older projects use the long "service_role" JWT, which also goes in Authorization.
const NEW_STYLE_KEY = KEY.startsWith("sb_");

async function sb(p, opts = {}) {
  if (KEY.startsWith("sb_publishable_")) {
    throw new Error("SUPABASE_SERVICE_KEY is the publishable key. Use the secret key (it starts with sb_secret_) instead.");
  }
  const r = await fetch(`${URL_}/rest/v1/${p}`, {
    method: opts.method || "GET",
    headers: { apikey: KEY, ...(NEW_STYLE_KEY ? {} : { Authorization: `Bearer ${KEY}` }),
               "Content-Type": "application/json", Prefer: opts.prefer || "return=minimal" },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  if (!r.ok) {
    const body = await r.text();
    if (body.includes("PGRST205") || body.includes("does not exist")) {
      throw new Error("The database tables are missing. Run supabase/schema.sql in the Supabase SQL Editor first.");
    }
    if (r.status === 401 || r.status === 403) {
      throw new Error("Supabase rejected the key. Check SUPABASE_URL and SUPABASE_SERVICE_KEY (use the secret key).");
    }
    throw new Error(`Supabase ${r.status}: ${body}`);
  }
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}
const upsert = (table, key, body) =>
  sb(`${table}?on_conflict=${key}`, { method: "POST", prefer: "resolution=merge-duplicates", body });

/* ---------- local file / memory ---------- */
const FILE = process.env.EDUPLUS_DB_FILE || path.join(__dirname, "..", "data", "local-db.json");
let mem = null;
const empty = () => ({ v: 3, seeded: false, students: {}, teachers: [], quizzes: [], outcomes: [], model: null, examples: [] });
function readLocal() {
  if (mem) return mem;
  try { const j = JSON.parse(fs.readFileSync(FILE, "utf8")); mem = j.v === 3 ? j : empty(); } catch { mem = empty(); }
  return mem;
}
function writeLocal() {
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(mem, null, 2)); } catch { /* read-only: keep in memory */ }
}

module.exports = {
  kind: useSupabase ? "supabase" : "local",

  /* students: { prn: { name, cls, teacher, parent, dob, d } } */
  async getStudents() {
    if (useSupabase) {
      const rows = await sb("students?select=prn,name,cls,teacher,parent,dob,d");
      return Object.fromEntries(rows.map(r => [r.prn, { name: r.name, cls: r.cls, teacher: r.teacher, parent: r.parent, dob: r.dob, d: r.d }]));
    }
    return readLocal().students;
  },
  async getStudent(prn) {
    if (useSupabase) {
      const rows = await sb(`students?prn=eq.${enc(prn)}&select=prn,name,cls,teacher,parent,dob,d`);
      const r = rows[0];
      return r ? { name: r.name, cls: r.cls, teacher: r.teacher, parent: r.parent, dob: r.dob, d: r.d } : null;
    }
    return readLocal().students[prn] || null;
  },
  async saveStudent(prn, rec) {
    if (useSupabase) return upsert("students", "prn", { prn, name: rec.name, cls: rec.cls, teacher: rec.teacher || "", parent: rec.parent || "", dob: rec.dob, d: rec.d });
    readLocal().students[prn] = rec; writeLocal();
  },
  async saveStudents(map) {                                // bulk save, used when loading the sample data
    const rows = Object.entries(map).map(([prn, r]) => ({ prn, name: r.name, cls: r.cls, teacher: r.teacher || "", parent: r.parent || "", dob: r.dob, d: r.d }));
    if (useSupabase) { for (let i = 0; i < rows.length; i += 20) await upsert("students", "prn", rows.slice(i, i + 20)); return; }
    Object.assign(readLocal().students, map); writeLocal();
  },
  async deleteStudent(prn) {
    if (useSupabase) {
      await sb(`students?prn=eq.${enc(prn)}`, { method: "DELETE" });
      return sb(`outcomes?prn=eq.${enc(prn)}`, { method: "DELETE" });
    }
    const m = readLocal(); delete m.students[prn]; m.outcomes = m.outcomes.filter(o => o.prn !== prn); writeLocal();
  },

  /* teachers: [{ name, subject, email, pw }]   pw = password hash, never sent to the browser */
  async getTeachers() {
    if (useSupabase) return sb("teachers?select=name,subject,email,pw,classes&order=name.asc");
    return readLocal().teachers;
  },
  async saveTeacher(t) {
    if (useSupabase) return upsert("teachers", "name", t);
    const m = readLocal(), i = m.teachers.findIndex(x => x.name === t.name);
    if (i >= 0) m.teachers[i] = t; else m.teachers.push(t);
    writeLocal();
  },
  async saveTeachers(list) {
    if (useSupabase) return upsert("teachers", "name", list.map(t => ({ name: t.name, subject: t.subject, email: t.email, pw: t.pw, classes: t.classes || "" })));
    for (const t of list) await this.saveTeacher(t);
  },
  async deleteTeacher(name) {
    if (useSupabase) return sb(`teachers?name=eq.${enc(name)}`, { method: "DELETE" });
    const m = readLocal(); m.teachers = m.teachers.filter(t => t.name !== name); writeLocal();
  },

  /* quizzes: [{ id, title, subject, cls, teacher, created, questions, attempts }] */
  async getQuizzes() {
    if (useSupabase) return (await sb("quizzes?select=id,data")).map(r => ({ id: r.id, ...r.data }));
    return readLocal().quizzes;
  },
  async saveQuiz(q) {
    if (useSupabase) { const { id, ...data } = q; return upsert("quizzes", "id", { id, data }); }
    const m = readLocal(), i = m.quizzes.findIndex(x => x.id === q.id);
    if (i >= 0) m.quizzes[i] = q; else m.quizzes.unshift(q);
    writeLocal();
  },
  async deleteQuiz(id) {
    if (useSupabase) return sb(`quizzes?id=eq.${enc(id)}`, { method: "DELETE" });
    const m = readLocal(); m.quizzes = m.quizzes.filter(q => q.id !== id); writeLocal();
  },

  /* outcome tracking */
  async getOutcomes() {
    if (useSupabase) {
      const rows = await sb("outcomes?select=*&order=id.desc&limit=100");
      return rows.map(r => ({ prn: r.prn, month: r.month, from: r.p_from, to: r.p_to, mark: r.mark, expected: r.expected, actions: r.actions }));
    }
    return readLocal().outcomes;
  },
  async addOutcome(o) {
    if (useSupabase) return sb("outcomes", { method: "POST", body: { prn: o.prn, month: o.month, p_from: o.from, p_to: o.to, mark: o.mark, expected: o.expected, actions: o.actions } });
    readLocal().outcomes.unshift(o); writeLocal();
  },

  /* model state (row id 1) and "demo data already loaded" flag (row id 2) */
  async getModel() {
    if (useSupabase) { const r = await sb("model_state?id=eq.1&select=state"); return r[0] ? r[0].state : null; }
    return readLocal().model;
  },
  async saveModel(state) {
    if (useSupabase) return upsert("model_state", "id", { id: 1, state });
    readLocal().model = state; writeLocal();
  },
  async isSeeded() {
    if (useSupabase) { const r = await sb("model_state?id=eq.2&select=state"); return !!(r[0] && r[0].state.seeded); }
    return readLocal().seeded;
  },
  async markSeeded() {
    if (useSupabase) return upsert("model_state", "id", { id: 2, state: { seeded: true } });
    readLocal().seeded = true; writeLocal();
  },

  /* learning examples */
  async getExamples() {
    if (useSupabase) return (await sb("examples?select=x,y&order=id.asc&limit=5000")).map(r => ({ x: r.x, y: r.y }));
    return readLocal().examples;
  },
  async addExample(e) {
    if (useSupabase) return sb("examples", { method: "POST", body: e });
    readLocal().examples.push(e); writeLocal();
  },

  async clearAll() {
    if (useSupabase) {
      await sb("outcomes?id=gt.0", { method: "DELETE" });
      await sb("examples?id=gt.0", { method: "DELETE" });
      await sb("model_state?id=gt.0", { method: "DELETE" });
      await sb("quizzes?id=not.is.null", { method: "DELETE" });
      await sb("teachers?name=not.is.null", { method: "DELETE" });
      await sb("students?name=not.is.null", { method: "DELETE" });
      return;
    }
    mem = empty(); writeLocal();
  }
};
