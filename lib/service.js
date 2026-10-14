// Business logic shared by all API routes. Every change goes through act(), and every
// call carries the signed-in user, so permissions are enforced here on the server.
const db = require("./db");
const seed = require("./seed");
const auth = require("./auth");
const M = require("./model");
const crypto = require("crypto");
const coach = require("./coach");
const QUIZ_GRACE_MS = 10000;                           // network delay allowed after the time limit

const clone = o => JSON.parse(JSON.stringify(o));
const fail = (msg, code = 400) => { const e = new Error(msg); e.code = code; throw e; };
const text = (v, max, label) => {
  const s = String(v ?? "").trim();
  if (!s) fail(`${label} is required.`);
  if (s.length > max) fail(`${label} must be ${max} characters or fewer.`);
  return s;
};
const num = (v, lo, hi, label) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) fail(`${label} must be between ${lo} and ${hi}.`);
  return n;
};
const dobText = v => {
  const s = String(v || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || isNaN(Date.parse(s))) fail("Date of birth is required (use the date picker).");
  return s;
};
const prnText = v => {
  const s = String(v || "").trim().toUpperCase();
  if (!/^[A-Z0-9-]{4,20}$/.test(s)) fail("PRN must be 4 to 20 letters, numbers or dashes.");
  return s;
};
const { SUBJECTS, EXAMS, SEMESTER, ATT_MIN } = seed;
const SEM_SHORT = SEMESTER.replace("Semester ", "Sem ");
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const perSubject = () => Object.fromEntries(SUBJECTS.map(s => [s, {}]));
const blankData = () => ({ m: [], ml: [], a: [], al: [], q: [], t: 3, done: [], sub: perSubject(), att: perSubject() });
function ensureCurriculum(d) {                         // records saved by an older version get the new fields
  d.sub = d.sub || {}; d.att = d.att || {};
  SUBJECTS.forEach(s => { d.sub[s] = d.sub[s] || {}; d.att[s] = d.att[s] || {}; });
}
// The AI reads one attendance figure per month, so it is rebuilt from the daily log.
function rebuildMonthly(d) {
  const g = {};
  for (const logs of Object.values(d.att)) for (const [day, st] of Object.entries(logs)) {
    if (st === "N") continue;                              // "not considered": holiday or class not held, never counted
    const k = MONTH_NAMES[Number(day.slice(5, 7)) - 1];
    g[k] = g[k] || [0, 0]; g[k][0] += st === "P" ? 1 : 0; g[k][1] += 1;
  }
  for (const [k, [p, n]] of Object.entries(g)) {
    const pct = Math.round(p / n * 100), i = d.al.indexOf(k);
    if (i >= 0) d.a[i] = pct; else { d.a.push(pct); d.al.push(k); }
  }
}

async function ensureSeed() {
  if (!(await db.isSeeded())) {
    if (process.env.SEED_DEMO !== "0") {                  // SEED_DEMO=0 starts with an empty system (real launch)
      await db.saveTeachers(seed.teachers.map(({ assign, ...t }) => ({ ...t, subject: assign[0].subjects[0], classes: JSON.stringify(assign), pw: auth.hashPassword(seed.DEMO_TEACHER_PASSWORD) })));
      await db.saveStudents(clone(seed.students));         // a few bulk requests, so the first sign-in stays fast on Vercel
      for (const q of seed.quizzes) await db.saveQuiz(clone(q));
    }
    await db.markSeeded();
  }
  return db.getStudents();
}

/* ---------- sign in ---------- */
async function login(b, ip = "") {
  const role = b.role;
  const key = `${ip}|${String(b.prn || b.email || "").toLowerCase()}`;
  const bad = msg => { auth.throttle(key, false); fail(msg, 401); };
  auth.throttle(key, null);                             // throws if this key is locked
  const students = await ensureSeed();

  if (role === "student") {                               // students and parents share this login
    const prn = String(b.prn || "").trim().toUpperCase(), rec = students[prn];
    if (!rec || !auth.same(rec.dob, String(b.dob || ""))) bad("PRN or date of birth is incorrect.");
    auth.throttle(key, true);
    return { token: auth.sign({ role: "student", prn, name: rec.name }), user: { role: "student", prn, name: rec.name } };
  }
  if (role === "teacher") {
    const email = String(b.email || "").trim().toLowerCase();
    const t = (await db.getTeachers()).find(x => x.email.toLowerCase() === email);
    if (!t || !auth.checkPassword(b.password, t.pw)) bad("Email or password is incorrect.");
    auth.throttle(key, true);
    return { token: auth.sign({ role: "teacher", name: t.name }), user: { role: "teacher", name: t.name } };
  }
  if (role === "admin") {
    if (!auth.ADMIN_EMAIL || !auth.ADMIN_PASSWORD) fail("Admin sign-in is not configured. Set ADMIN_EMAIL and ADMIN_PASSWORD.", 500);
    const okMail = auth.same(String(b.email || "").trim().toLowerCase(), auth.ADMIN_EMAIL);
    const okPass = auth.same(String(b.password || ""), auth.ADMIN_PASSWORD);
    if (!(okMail && okPass)) bad("Email or password is incorrect.");
    auth.throttle(key, true);
    return { token: auth.sign({ role: "admin", name: "Administrator" }), user: { role: "admin", name: "Administrator" } };
  }
  fail("Choose how you are signing in.");
}

/* ---------- what each person is allowed to see ---------- */
const canSee = (u, rec) =>
  u.role === "admin" || (u.role === "teacher" && (rec.teacher === u.name || (u.classes || []).includes(rec.cls))) || (u.role === "student" && rec.prn === u.prn);

const withClasses = async u => {
  if (!u || u.role !== "teacher") return u;
  const assign = parseAssign((await db.getTeachers()).find(t => t.name === u.name) || {});
  return { ...u, assign, classes: assign.map(a => a.cls), subjects: subjectsOf(assign) };
};

async function snapshot(u) {
  u = await withClasses(u);
  const all = await ensureSeed();
  const state = await db.getModel(), teachersRaw = await db.getTeachers();
  const visible = Object.entries(all).filter(([prn, rec]) => canSee(u, { ...rec, prn }));
  const prns = new Set(visible.map(([prn]) => prn));

  const analyses = {}, jobs = [];
  for (const [prn, rec] of visible) {
    ensureCurriculum(rec.d);
    const a = M.analyse(prn, rec.d, state); delete a.x;
    a.d = { ...rec.d }; delete a.d.ai; delete a.d.plan;
    jobs.push({ prn, rec, a });
    if (u.role !== "student") delete a.d.att;                                // the day-by-day log is only needed on the student's own page
    analyses[prn] = a;
  }

  await attachPlans(jobs);
  const teachersAll = teachersRaw.map(({ pw, classes, ...t }) => ({ ...t, assign: parseAssign({ classes, subject: t.subject }) }));
  const mine = visible.map(([, r]) => r.teacher);
  const teachers = u.role === "admin" ? teachersAll
    : u.role === "teacher" ? teachersAll.filter(t => t.name === u.name)
    : teachersAll.filter(t => mine.includes(t.name)).map(({ email, ...t }) => t);

  const t = Date.now();
  const quizzes = (await db.getQuizzes())
    .filter(q => u.role === "admin" || (u.role === "teacher" && q.teacher === u.name) ||
                 (u.role === "student" && (q.cls === "All" || q.cls === all[u.prn]?.cls)))
    .map(q => {
      const live = !!(q.session && t < q.session.closesAt), base = { id: q.id, title: q.title, subject: q.subject, cls: q.cls, teacher: q.teacher, created: q.created, count: q.questions.length };
      if (u.role === "student") {                                  // no questions until the student starts inside a live class session
        const mine = q.attempts.find(x => x.student === u.prn);
        return { ...base, attempt: mine ? (mine.held ? { held: true } : { correct: mine.correct, total: mine.total, pct: mine.pct }) : null,
          open: live && q.session.roster.includes(u.prn) && !mine, closesAt: live ? q.session.closesAt : 0, minutes: q.session ? q.session.minutes : 0, started: !!(q.starts && q.starts[u.prn]) };
      }
      return { ...base, attempts: q.attempts, session: live ? { code: q.session.code, closesAt: q.session.closesAt, minutes: q.session.minutes, roster: q.session.roster.length, started: Object.keys(q.starts || {}).length } : null };
    });

  return {
    now: t,
    me: u,
    curriculum: { semester: SEMESTER, subjects: subjectList(teachersRaw), exams: EXAMS, attMin: ATT_MIN },
    students: visible.map(([prn, r]) => ({ prn, name: r.name, cls: r.cls, teacher: r.teacher || "", parent: r.parent || "", subjects: subjectsOfStudent(teachersRaw, r), ...(u.role === "admin" ? { dob: r.dob } : {}) })),
    analyses, teachers, quizzes,
    outcomes: (await db.getOutcomes()).filter(o => prns.has(o.prn)),
    notes: (state && state.notes) || [],
    weights: M.weights(state), baseWeights: M.weights(null),
    model: { version: M.base.version, metrics: M.base.metrics, card: M.base.card, bands: M.base.bands, live: state && state.live || null, learned: !!(state && state.version === M.base.version), store: db.kind, demo: auth.DEMO }
  };
}

/* ---------- New Performance -> Outcome Tracking -> Model Improvement ---------- */
async function applyExam(state, prn, rec, { mark, title }) {
  const d = rec.d;
  const done = (d.done || []).filter(k => M.KEYS.includes(k));
  const before = M.analyse(prn, d, state);
  const last = d.m.length ? d.m[d.m.length - 1] : 0;
  const expected = before.insufficient ? null : Math.max(0, Math.round(last + before.slope));

  mark = Math.max(0, Math.min(100, Math.round(mark)));
  d.m.push(mark); d.ml.push(title); d.done = [];
  if (before.insufficient) return { state, outcome: null };

  const after = M.analyse(prn, d, state);
  const outcome = { prn, month: title, from: before.p, to: after.p, mark, expected, actions: done.length };
  await db.addOutcome(outcome);

  const y = mark < 50 || mark < before.last3 - 12 ? 1 : 0;        // at risk? same definition the model was trained on (ml/train.py)
  await db.addExample({ x: before.x, y, v: M.base.version });
  const next = M.learn(state, before.x, y);
  const note = `${rec.name.split(" ")[0]}: model expected ${expected}%, actual ${mark}% (error ${Math.abs(mark - expected)} pts). ${y ? "At risk" : "Not at risk"} outcome learned.`;
  next.notes = [note, ...((state && state.notes) || [])].slice(0, 6);
  return { state: next, outcome };
}

/* ---------- actions ---------- */
async function validTeacher(name) {
  const t = String(name || "").trim();
  if (!t) return "";
  if (!(await db.getTeachers()).some(x => x.name === t)) fail("That teacher does not exist.");
  return t;
}
/* A teacher's teaching assignments: [{ cls, subjects: [...] }]. Stored as JSON in the existing `classes` column
   (the older "CSE-A,CSE-B" text still reads fine: those classes with the teacher's one subject). */
function parseAssign(t) {
  const raw = String((t && t.classes) || "").trim();
  if (raw.startsWith("[")) {
    try { return cleanAssign(JSON.parse(raw), true); } catch { return []; }
  }
  return raw.split(",").map(x => x.trim()).filter(Boolean).map(cls => ({ cls, subjects: t.subject ? [t.subject] : [] })).filter(a => a.subjects.length);
}
// Subject and class names are typed by the admin, so they are cleaned, and matched to names already in use
// ("data structures" becomes "Data Structures") so the same subject never exists twice.
const titleCase = n => n.split(" ").map((w, i) => (i && ["and", "of", "in", "the", "for", "to", "on", "a", "an"].includes(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(" ");
const SUBJECT_RE = /^[\p{L}\p{N} &.()'\/+-]{2,60}$/u;
function cleanAssign(list, quiet, known = []) {
  const by = new Map(), seen = new Map(known.map(k => [k.toLowerCase(), k]));
  for (const a of Array.isArray(list) ? list : []) {
    const cls = String((a && a.cls) || "").trim().replace(/\s+/g, " ").slice(0, 20), subs = [];
    for (const raw of (a && a.subjects) || []) {
      const name = String(raw || "").trim().replace(/\s+/g, " ");
      if (!name) continue;
      if (!SUBJECT_RE.test(name)) { if (quiet) continue; fail(`"${name.slice(0, 30)}" is not a valid subject name. Use letters, numbers, spaces and & . ( ) ' / + - (2 to 60 characters).`); }
      if (!seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name === name.toLowerCase() ? titleCase(name) : name);   // all-lowercase typing gets capital letters
      subs.push(seen.get(name.toLowerCase()));
    }
    const subjects = [...new Set(subs)];
    if (!cls && !subjects.length) continue;
    if (!cls) { if (quiet) continue; fail("Type a class for every teaching row."); }
    if (!subjects.length) { if (quiet) continue; fail(`Add at least one subject for class ${cls}.`); }
    by.set(cls, [...new Set([...(by.get(cls) || []), ...subjects])]);
  }
  if (by.size > 12) fail("That is too many classes for one teacher.");
  return [...by].map(([cls, subjects]) => ({ cls, subjects }));
}
const subjectsOf = assign => [...new Set(assign.flatMap(a => a.subjects))];
// Subjects that exist = the starter list plus every subject any teacher has been given.
const subjectList = teachers => [...new Set([...SUBJECTS, ...teachers.flatMap(t => parseAssign(t).flatMap(a => a.subjects))])];
// A class studies the subjects its teachers are assigned; a class with no assignments uses the starter list.
const classSubjects = (teachers, cls) => {
  const s = [...new Set(teachers.flatMap(t => parseAssign(t)).filter(a => a.cls === cls).flatMap(a => a.subjects))];
  return s.length ? s : SUBJECTS;
};
// What one student sees: their class's subjects, plus any older subject that already has marks or attendance.
const subjectsOfStudent = (teachers, rec) => [...new Set([...classSubjects(teachers, rec.cls),
  ...Object.keys(rec.d.sub || {}).filter(s => Object.keys(rec.d.sub[s]).length), ...Object.keys(rec.d.att || {}).filter(s => Object.keys(rec.d.att[s]).length)])];
// A teacher may change a subject for a student only if that subject is assigned to them for the student's class,
// or the student was assigned to them one by one (then any subject they teach).
const canTeach = (u, rec, subject) => u.role === "admin" || (u.role === "teacher" &&
  ((u.assign || []).some(a => a.cls === rec.cls && a.subjects.includes(subject)) || (rec.teacher === u.name && (u.subjects || []).includes(subject))));
function mustTeach(u, rec, subject) { if (!canTeach(u, rec, subject)) fail(`You are not assigned to teach ${subject} for ${rec.name} (${rec.cls}). Ask the admin to assign it.`, 403); }
function mustOwn(u, rec) { if (!canSee(u, rec)) fail("You can only change your own students.", 403); }
async function load(u, prn) {
  const students = await ensureSeed();
  const rec = students[String(prn)] || fail("Student not found.", 404);
  mustOwn(u, { ...rec, prn: String(prn) });
  return rec;
}

const ROLES = {
  addStudent: ["admin", "teacher"], updateStudent: ["admin", "teacher"], removeStudent: ["admin", "teacher"],
  saveTeacher: ["admin"], removeTeacher: ["admin"], assignStudents: ["admin"], importStudents: ["admin"],
  saveAttendance: ["admin", "teacher"], saveMarks: ["admin", "teacher"],
  createQuiz: ["admin", "teacher"], deleteQuiz: ["admin", "teacher"], openQuiz: ["admin", "teacher"], closeQuiz: ["admin", "teacher"], reviewQuiz: ["admin", "teacher"],
  startQuiz: ["student"], submitQuiz: ["student"],
  retrain: ["admin"], reset: ["admin"]
};

const ops = {
  async addStudent(b, u) {
    const students = await ensureSeed();
    const prn = prnText(b.prn);
    if (students[prn]) fail("A student with this PRN already exists.");
    const rec = {
      name: text(b.name, 60, "Name"), dob: dobText(b.dob), cls: text(b.cls, 20, "Class"),
      teacher: u.role === "teacher" ? u.name : await validTeacher(b.teacher),
      parent: String(b.parent || "").trim().slice(0, 60), d: blankData()
    };
    await db.saveStudent(prn, rec);
    return { message: `${rec.name} added. They can sign in with PRN ${prn} and their date of birth. Enter attendance and exam marks in Enter Data; the AI insight unlocks after 3 exams.` };
  },
  async updateStudent(b, u) {
    const rec = await load(u, b.prn);
    if (b.name !== undefined) rec.name = text(b.name, 60, "Name");
    if (b.cls !== undefined) rec.cls = text(b.cls, 20, "Class");
    if (b.parent !== undefined) rec.parent = String(b.parent).trim().slice(0, 60);
    if (u.role === "admin") {                                 // teacher assignment and the sign-in date are admin-only
      if (b.teacher !== undefined) rec.teacher = await validTeacher(b.teacher);
      if (b.dob) rec.dob = dobText(b.dob);
    }
    await db.saveStudent(b.prn, rec);
    return { message: `${rec.name} updated.` };
  },
  async removeStudent(b, u) {
    const rec = await load(u, b.prn);
    await db.deleteStudent(b.prn);
    return { message: `${rec.name} removed.` };
  },

  async saveTeacher(b) {
    await ensureSeed();
    const name = text(b.name, 60, "Name"), email = text(b.email, 80, "Email").toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) fail("Enter a valid email address.");
    const all = await db.getTeachers(), old = all.find(t => t.name === name);
    if (all.some(t => t.email.toLowerCase() === email && t.name !== name)) fail("Another teacher already uses this email.");
    let pw = old && old.pw;
    if (b.password) { if (String(b.password).length < 6) fail("Password must be at least 6 characters."); pw = auth.hashPassword(String(b.password)); }
    if (!pw) fail("Set a password so this teacher can sign in.");
    const known = subjectList(await db.getTeachers()), assign = b.assign !== undefined ? cleanAssign(b.assign, false, known) : parseAssign(old ? old : { classes: b.classes, subject: b.subject });
    if (subjectList([{ classes: JSON.stringify(assign) }]).length > 40) fail("That is too many different subjects.");
    await db.saveTeacher({ name, subject: assign.length ? assign[0].subjects[0] : String(b.subject || "").trim().slice(0, 40), email, pw, classes: JSON.stringify(assign) });
    return { message: `${name} saved.` };
  },
  async removeTeacher(b) {
    const students = await ensureSeed();
    for (const [prn, rec] of Object.entries(students)) if (rec.teacher === b.name) { rec.teacher = ""; await db.saveStudent(prn, rec); }
    await db.deleteTeacher(b.name);
    return { message: `${b.name} removed. Their students are now unassigned.` };
  },
  async assignStudents(b) {                                      // admin: pick exactly which students belong to a teacher
    const students = await ensureSeed();
    const teacher = await validTeacher(b.teacher) || fail("Choose a teacher.");
    const want = new Set((b.prns || []).map(String)), changed = {};
    for (const p of want) if (!students[p]) fail("Unknown student in the list.");
    for (const [prn, rec] of Object.entries(students)) {
      if (want.has(prn) && rec.teacher !== teacher) { rec.teacher = teacher; changed[prn] = rec; }
      else if (!want.has(prn) && rec.teacher === teacher) { rec.teacher = ""; changed[prn] = rec; }
    }
    if (Object.keys(changed).length) await db.saveStudents(changed);
    return { message: `${teacher} now has ${want.size} assigned student${want.size === 1 ? "" : "s"}.` };
  },
  async importStudents(b) {                                      // admin: add or update many students from a CSV file
    const students = await ensureSeed(), teachers = await db.getTeachers();
    const rows = Array.isArray(b.rows) ? b.rows : [];
    if (!rows.length) fail("The file has no student rows.");
    if (rows.length > 500) fail("Upload at most 500 students at a time.");
    const who = v => { const x = String(v || "").trim().toLowerCase(); if (!x) return ""; const t = teachers.find(t => t.name.toLowerCase() === x || t.email.toLowerCase() === x); if (!t) fail(`Teacher "${v}" does not exist.`); return t.name; };
    const dflt = await validTeacher(b.teacher), changed = {}, problems = [];
    let added = 0, updated = 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] || {};
      try {
        const prn = prnText(r.prn), teacher = who(r.teacher) || dflt, old = changed[prn] || students[prn];
        if (old) {
          if (r.name) old.name = text(r.name, 60, "Name");
          if (r.cls) old.cls = text(r.cls, 20, "Class");
          if (r.parent) old.parent = String(r.parent).trim().slice(0, 60);
          if (r.dob) old.dob = dobText(r.dob);
          if (teacher) old.teacher = teacher;
          if (!changed[prn]) updated++;
          changed[prn] = old;
        } else {
          changed[prn] = { name: text(r.name, 60, "Name"), dob: dobText(r.dob), cls: text(r.cls, 20, "Class"), teacher, parent: String(r.parent || "").trim().slice(0, 60), d: blankData() };
          added++;
        }
      } catch (e) { problems.push(`Row ${i + 2}: ${e.message}`); }
    }
    if (Object.keys(changed).length) await db.saveStudents(changed);
    return { message: `${added} added, ${updated} updated${problems.length ? `, ${problems.length} skipped` : ""}.`, problems: problems.slice(0, 10) };
  },

  async saveAttendance(b, u) {                                  // one subject, one day, present or absent for each student
    const students = await ensureSeed();
    const teachers = await db.getTeachers(), subject = subjectList(teachers).includes(b.subject) ? b.subject : fail("Choose a subject.");
    const date = String(b.date || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(Date.parse(date)) || +date.slice(0, 4) < 2000) fail("Choose a valid date.");
    const recs = b.records || [];
    for (const r of recs) { const rec = students[r.prn]; if (!rec) fail("Unknown student in the list."); mustOwn(u, { ...rec, prn: r.prn }); mustTeach(u, rec, subject); }
    let absent = 0, skipped = 0;
    for (const r of recs) {
      const rec = students[r.prn];
      if (!["P", "A", "N"].includes(r.status)) fail(`Mark ${rec.name} as present, absent or not considered.`);
      ensureCurriculum(rec.d);
      rec.d.att[subject] = rec.d.att[subject] || {};
      rec.d.att[subject][date] = r.status;
      if (r.status === "A") absent++;
      if (r.status === "N") skipped++;
      rebuildMonthly(rec.d);
      await db.saveStudent(r.prn, rec);
    }
    return { message: `${subject}, ${date}: attendance saved for ${recs.length} student${recs.length === 1 ? "" : "s"} (${absent} absent${skipped ? `, ${skipped} not considered` : ""}).` };
  },

  async saveMarks(b, u) {                                       // one subject, one exam, a score for each student
    const students = await ensureSeed();
    const teachers = await db.getTeachers(), subject = subjectList(teachers).includes(b.subject) ? b.subject : fail("Choose a subject.");
    const exam = EXAMS.find(x => x.key === b.exam) || fail("Choose which exam these marks are for.");
    const max = num(b.max, 1, 1000, "Maximum marks");
    const recs = b.records || [];
    for (const r of recs) { const rec = students[r.prn]; if (!rec) fail("Unknown student in the list."); mustOwn(u, { ...rec, prn: r.prn }); mustTeach(u, rec, subject); }
    let state = await db.getModel(), registered = 0;
    for (const r of recs) {
      const rec = students[r.prn];
      ensureCurriculum(rec.d);
      rec.d.sub[subject] = rec.d.sub[subject] || {};
      rec.d.sub[subject][exam.key] = { s: num(r.score, 0, max, `Marks for ${rec.name}`), max };
      if (r.teacher) rec.d.t = num(r.teacher, 1, 5, "Teacher rating");

      // Once every subject of the student's class has this exam, it counts as one overall exam for the AI.
      const all = classSubjects(teachers, rec.cls).map(x => (rec.d.sub[x] || {})[exam.key]);
      if (all.every(Boolean)) {
        const avg = all.reduce((t, m) => t + m.s / m.max * 100, 0) / all.length;
        const title = `${SEM_SHORT} · ${exam.label}`, i = rec.d.ml.indexOf(title);
        if (i >= 0) rec.d.m[i] = Math.round(avg);
        else { ({ state } = await applyExam(state, r.prn, rec, { mark: avg, title })); registered++; }
      }
      await db.saveStudent(r.prn, rec);
    }
    if (state) await db.saveModel(state);
    if (registered) await retrainAll(10);                       // the ML model re-fits itself from recorded outcomes
    return { message: `${subject}, ${exam.label}: marks saved for ${recs.length} student${recs.length === 1 ? "" : "s"}.${registered ? " The model was updated." : ""}` };
  },

  async createQuiz(b, u) {
    await ensureSeed();
    const qs = Array.isArray(b.questions) ? b.questions : [];
    if (!qs.length || qs.length > 20) fail("A quiz needs between 1 and 20 questions.");
    const pic = x => {                                           // pictures arrive as small data: URLs; anything else is refused
      if (!x) return "";
      if (typeof x !== "string" || !/^data:image\/(?:jpeg|png|webp|gif);base64,[A-Za-z0-9+/]+=*$/.test(x)) fail("One of the pictures is not a valid image.");
      if (x.length > 400000) fail("A picture is too large. Choose a smaller one.");
      return x;
    };
    const questions = qs.map((x, i) => {
      const img = pic(x.img), qt = String(x.q || "").trim().slice(0, 200);
      if (!qt && !img) fail(`Question ${i + 1} needs text or a picture.`);
      const opts = (Array.isArray(x.options) ? x.options : []).slice(0, 4)
        .map((o, j) => ({ t: String(o || "").trim().slice(0, 100), i: pic((x.oimgs || [])[j]), at: j })).filter(p => p.t || p.i);
      if (opts.length < 2) fail(`Question ${i + 1} needs at least 2 options.`);
      const answer = opts.findIndex(p => p.at === Number(x.answer));
      if (answer < 0) fail(`Question ${i + 1} needs a correct answer.`);
      return { q: qt, img, options: opts.map(p => p.t), oimgs: opts.map(p => p.i), answer };
    });
    if (JSON.stringify(questions).length > 3000000) fail("This quiz has too many or too large pictures. Remove some or use smaller ones.");
    const qSubject = String(b.subject || "").trim().slice(0, 60);
    if (u.role === "teacher" && !(u.subjects || []).includes(qSubject)) fail("You can only create quizzes for the subjects assigned to you.", 403);
    const q = { id: "quiz_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), title: text(b.title, 60, "Title"),
      subject: String(b.subject || "").trim().slice(0, 60), cls: text(b.cls, 20, "Class"), teacher: u.role === "teacher" ? u.name : "Administrator",
      created: new Date().toISOString().slice(0, 10), questions, attempts: [] };
    await db.saveQuiz(q);
    return { message: `Quiz "${q.title}" saved. Start it in class when everyone is in the room.` };
  },
  async deleteQuiz(b, u) {
    const q = (await db.getQuizzes()).find(x => x.id === b.id) || fail("Quiz not found.", 404);
    if (u.role === "teacher" && q.teacher !== u.name) fail("You can only delete your own quizzes.", 403);
    await db.deleteQuiz(q.id);
    return { message: "Quiz deleted." };
  },
  /* Quizzes are only possible in a live class session: the teacher starts it for the students in the room,
     shares a code on the board, and everyone has a hard time limit. Nothing can be taken at home. */
  async openQuiz(b, u) {
    const students = await ensureSeed();
    const quiz = (await db.getQuizzes()).find(x => x.id === b.id) || fail("Quiz not found.", 404);
    if (u.role === "teacher" && quiz.teacher !== u.name) fail("You can only run your own quizzes.", 403);
    const minutes = num(b.minutes, 5, 60, "Time limit");
    const roster = [...new Set((b.roster || []).map(String))];
    if (!roster.length) fail("Tick at least one student who is in the room.");
    for (const prn of roster) {
      const rec = students[prn] || fail("Unknown student in the list.");
      if (quiz.cls !== "All" && rec.cls !== quiz.cls) fail(`${rec.name} is not in class ${quiz.cls}.`);
      mustOwn(u, { ...rec, prn });
    }
    const t = Date.now();
    quiz.session = { code: String(crypto.randomInt(1000, 10000)), opened: t, closesAt: t + minutes * 60000, minutes, roster, by: u.name, tries: {} };
    quiz.starts = {};
    await db.saveQuiz(quiz);
    return { message: `Quiz started for ${roster.length} student${roster.length === 1 ? "" : "s"}. Write the code ${quiz.session.code} on the board.` };
  },
  async closeQuiz(b, u) {
    const quiz = (await db.getQuizzes()).find(x => x.id === b.id) || fail("Quiz not found.", 404);
    if (u.role === "teacher" && quiz.teacher !== u.name) fail("You can only run your own quizzes.", 403);
    if (quiz.session) quiz.session.closesAt = Math.min(quiz.session.closesAt, Date.now());
    quiz.starts = {};
    await db.saveQuiz(quiz);
    return { message: "Quiz ended." };
  },
  async startQuiz(b, u) {
    const students = await ensureSeed();
    const rec = students[u.prn] || fail("Student not found.", 404);
    const quiz = (await db.getQuizzes()).find(q => q.id === b.quizId) || fail("Quiz not found.", 404);
    if (quiz.cls !== "All" && quiz.cls !== rec.cls) fail("This quiz is not for your class.", 403);
    const s = quiz.session, t = Date.now();
    if (!s || t >= s.closesAt) fail("This quiz is not open. Quizzes are taken in class, when your teacher starts them.", 403);
    if (!s.roster.includes(u.prn)) fail("You are not on your teacher's list for this session.", 403);
    if (quiz.attempts.some(a => a.student === u.prn)) fail("You have already taken this quiz.");
    quiz.starts = quiz.starts || {};
    let st = quiz.starts[u.prn];
    if (st) { st.resumes = (st.resumes || 0) + 1; await db.saveQuiz(quiz); }      // reloading the page mid-quiz is counted like leaving the screen
    if (!st) {                                                   // a refresh resumes the same attempt; it never gives more time
      if ((s.tries[u.prn] || 0) >= 5) fail("Too many wrong codes. Ask your teacher.", 429);
      if (!auth.same(String(b.code || "").trim(), s.code)) { s.tries[u.prn] = (s.tries[u.prn] || 0) + 1; await db.saveQuiz(quiz); fail("That class code is not right. Check the board.", 403); }
      const mix = n => { const a = Array.from({ length: n }, (_, i) => i); for (let i = n - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
      st = quiz.starts[u.prn] = { at: t, perm: mix(quiz.questions.length).map(qi => ({ qi, oi: mix(quiz.questions[qi].options.length) })) };   // each student sees a different order
      await db.saveQuiz(quiz);
    }
    return { deadline: Math.min(s.closesAt, st.at + s.minutes * 60000), now: t,
      questions: st.perm.map(p => { const qq = quiz.questions[p.qi]; return { q: qq.q, img: qq.img || "", options: p.oi.map(j => qq.options[j]), oimgs: p.oi.map(j => (qq.oimgs || [])[j] || "") }; }) };
  },
  async submitQuiz(b, u) {
    const students = await ensureSeed();
    const rec = students[u.prn] || fail("Student not found.", 404);
    const quiz = (await db.getQuizzes()).find(q => q.id === b.quizId) || fail("Quiz not found.", 404);
    if (quiz.attempts.some(a => a.student === u.prn)) fail("You have already taken this quiz.");
    const st = quiz.starts && quiz.starts[u.prn], s = quiz.session;
    if (!st || !s) fail("Start the quiz in class first.", 403);
    if (Date.now() > Math.min(s.closesAt, st.at + s.minutes * 60000) + QUIZ_GRACE_MS) fail("Time is over, so this attempt was not saved. Ask your teacher for a make-up session.", 403);
    const answers = Array.isArray(b.answers) ? b.answers : [];
    const correct = st.perm.filter((p, k) => Number.isInteger(answers[k]) && p.oi[answers[k]] === quiz.questions[p.qi].answer).length;
    const total = quiz.questions.length, pct = Math.round(correct / total * 100);
    const blurs = Math.max(0, Math.min(99, Math.floor(Number(b.blurs) || 0))) + (st.resumes || 0), held = blurs > 2;   // leaving the quiz screen often: the teacher reviews it first
    quiz.attempts.push({ student: u.prn, name: rec.name, correct, total, pct, at: new Date().toISOString().slice(0, 10), blurs, held, secs: Math.round((Date.now() - st.at) / 1000) });
    delete quiz.starts[u.prn];
    if (!held) { rec.d.q.push(pct); rec.d.q = rec.d.q.slice(-10); await db.saveStudent(u.prn, rec); }   // only supervised, unflagged scores reach the ML model
    await db.saveQuiz(quiz);
    return held ? { message: "Submitted. Your teacher will review this attempt before it counts.", result: { held: true } }
                : { message: `You scored ${correct}/${total} (${pct}%).`, result: { correct, total, pct } };
  },
  async reviewQuiz(b, u) {                                       // teacher decides about an attempt that was held back
    const students = await ensureSeed();
    const quiz = (await db.getQuizzes()).find(x => x.id === b.id) || fail("Quiz not found.", 404);
    if (u.role === "teacher" && quiz.teacher !== u.name) fail("You can only review your own quizzes.", 403);
    const a = quiz.attempts.find(x => x.student === String(b.student) && x.held) || fail("Nothing to review for that student.");
    const rec = students[a.student] || fail("Student not found.", 404);
    mustOwn(u, { ...rec, prn: a.student });
    a.held = false;
    if (b.accept) { rec.d.q.push(a.pct); rec.d.q = rec.d.q.slice(-10); await db.saveStudent(a.student, rec); } else a.ignored = true;
    await db.saveQuiz(quiz);
    return { message: b.accept ? `${a.name}'s score now counts.` : `${a.name}'s attempt will not count.` };
  },

  async retrain() {
    const r = await retrainAll(1);
    return { message: r.n ? r.note : "No recorded exams yet. Enter some exam marks first." };
  },
  async reset() {
    if (!auth.DEMO) fail("Reset is turned off on a live site so real data can't be wiped by accident.", 403);
    await db.clearAll(); await ensureSeed();
    return { message: "Demo data restored." };
  }
};

/* ---------- Gemini-written explanations ---------- */
const effectOf = gain => (gain >= 8 ? "big" : gain >= 4 ? "good" : "small");
function buildFacts(a, d) {                                 // numbers only: no name, no PRN, no date of birth
  const att = {}, marks = {};
  Object.keys({ ...d.sub, ...d.att }).forEach(s => {
    const v = Object.values(d.att[s] || {}).filter(x => x !== "N");
    att[s] = v.length ? Math.round(v.filter(x => x === "P").length / v.length * 100) : null;
    const got = EXAMS.map(e => (d.sub[s] || {})[e.key]).filter(Boolean);
    if (got.length) marks[s] = Math.round(got.reduce((t, m) => t + m.s / m.max * 100, 0) / got.length);
  });
  return {
    riskLevel: a.risk,
    overallExamPercentsOldestFirst: d.m.slice(-6),
    trendPointsPerExam: Number(a.slope.toFixed(1)),
    suddenDropInLatestExam: a.z < -1.5,
    overallAttendancePercent: Math.round(a.att), attendanceBySubjectPercent: att, attendanceRequiredPercent: ATT_MIN,
    marksBySubjectPercentThisSemester: marks,
    weakestSubject: a.weak ? { subject: a.weak.name, percent: a.weak.pct } : null,
    subjectsBelowPassMark: a.failing,
    quizAveragePercent: Math.round(a.quiz), teacherEngagementRating1to5: d.t,
    dataReliability: a.reliability.label,
    mainReasons: a.contrib.filter(c => c.c > 0.004).slice(0, 3).map(c => ({ factor: c.k, sharePercent: Math.round(c.share * 100) })),
    levers: a.levers.slice(0, 4).map(l => ({ lever: l.k, ifImproved: l.step, effect: effectOf(l.gain) }))   // the model's what-if estimates
  };
}

const clampNote = (old, n) => [n, ...((old && old.notes) || [])].slice(0, 6);
async function retrainAll(min) {                         // ML retraining from recorded outcomes, with a validation guard
  const all = (await db.getExamples()).filter(e => Array.isArray(e.x) && e.x.length === M.base.coef.length);   // ignore examples made for an older model
  if (all.length < min) return { n: 0 };
  const old = await db.getModel(), current = M.usable(old);
  const cut = all.length >= 20 ? Math.floor(all.length * 0.8) : all.length, valid = all.slice(cut);   // newest 20% are held back for checking
  let note = `Retrained on ${all.length} recorded exam${all.length === 1 ? "" : "s"}.`;
  if (valid.length >= 5) {
    const cand = M.evaluate(M.fit(all.slice(0, cut), M.base), valid), now = M.evaluate(current, valid);
    if (cand.logloss > now.logloss + 0.005) {                // the challenger is not better: keep the model that is running
      const kept = clone(current); kept.notes = clampNote(old, `Kept the current model: retraining was not better on the newest ${valid.length} exams.`);
      await db.saveModel(kept);
      return { n: all.length, note: kept.notes[0] };
    }
    note = `Retrained on ${all.length} recorded exams. Check on the newest ${valid.length}: error ${now.logloss.toFixed(2)} to ${cand.logloss.toFixed(2)}.`;
  }
  const st = M.fit(all, M.base), ev = M.evaluate(st, all);
  st.live = { examples: all.length, logloss: Number(ev.logloss.toFixed(3)), brier: Number(ev.brier.toFixed(3)), auc: ev.auc == null ? null : Number(ev.auc.toFixed(3)) };
  st.notes = clampNote(old, note);
  await db.saveModel(st);
  return { n: all.length, note };
}

// The ML model asks the AI for a learning path only when its own findings change. People never call the AI.
async function attachPlans(jobs) {
  let ai = 0; const until = Date.now() + 8000;
  await Promise.all(jobs.map(async ({ prn, rec, a }) => {
    if (a.insufficient) return;
    const f = buildFacts(a, rec.d), sig = coach.sig(f), cur = rec.d.plan, wantAI = coach.canUseAI() && a.risk !== "Low";
    if (cur && cur.sig === sig && (cur.source === "ai" || cur.tried || !wantAI)) { a.plan = cur; return; }
    const plan = { sig, ...(await coach.make(f, wantAI && ai++ < 3 && Date.now() < until)) };
    a.plan = plan;
    const fresh = (await db.getStudent(prn)) || rec; ensureCurriculum(fresh.d); fresh.d.plan = plan;
    await db.saveStudent(prn, fresh);
  }));
}

async function act(u, body) {
  if (!u) fail("Please sign in.", 401);
  const op = body && body.op;
  if (!ops[op]) fail("Unknown action.");
  if (!ROLES[op].includes(u.role)) fail("You do not have permission to do this.", 403);
  return ops[op](body, await withClasses(u));
}

module.exports = { snapshot, act, login, store: db.kind, demo: auth.DEMO };
