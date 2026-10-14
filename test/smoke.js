// Quick self-test:  npm test   (uses a temporary file, never touches your data)
process.env.SUPABASE_URL = "";
process.env.EDUPLUS_DB_FILE = require("path").join(require("os").tmpdir(), "eduplus-test-db.json");
const s = require("../lib/service");
const auth = require("../lib/auth");
const assert = require("assert");

(async () => {
  const signIn = async b => auth.verify((await s.login(b, "test-" + Math.random())).token);
  const admin = await signIn({ role: "admin", email: "admin@school.edu", password: "admin123" });
  await s.act(admin, { op: "reset" });

  /* --- sign in --- */
  await assert.rejects(s.login({ role: "student", prn: "2024001", dob: "2000-01-01" }, "ip1"), /incorrect/);
  await assert.rejects(s.login({ role: "teacher", email: "kapoor@school.edu", password: "nope" }, "ip2"), /incorrect/);
  const rahul = await signIn({ role: "student", prn: "2024001", dob: "2009-05-14" });
  const kapoor = await signIn({ role: "teacher", email: "KAPOOR@school.edu", password: "teacher123" });
  assert.strictEqual(rahul.role, "student"); assert.strictEqual(kapoor.name, "Mrs. Kapoor");
  for (let i = 0; i < 5; i++) await s.login({ role: "student", prn: "2024002", dob: "bad" }, "locked").catch(() => {});
  await assert.rejects(s.login({ role: "student", prn: "2024002", dob: "2009-08-22" }, "locked"), /Too many/);
  assert.strictEqual(auth.verify("garbage"), null);

  /* --- who sees what --- */
  const a = await s.snapshot(admin), k = await s.snapshot(kapoor), r = await s.snapshot(rahul);
  assert.strictEqual(a.students.length, 70);
  assert(k.students.length === 35 && k.students.every(x => x.cls === "CSE-A") && k.students.some(x => x.name === "Rahul Sharma") && !k.students.some(x => x.name === "Priya Patel"), "a teacher sees only the class they teach");
  assert.strictEqual(r.students.length, 1); assert.strictEqual(r.students[0].prn, "2024001");
  assert(!JSON.stringify(k).includes("2009-05-14") && !JSON.stringify(r).includes("dob"), "date of birth is only visible to admin");
  assert(!JSON.stringify([a, k, r]).includes('"pw"'), "password hashes never leave the server");
  assert(!JSON.stringify([a, k, r]).includes('"answer"'), "quiz answers never leave the server");
  assert(a.analyses["2024001"].p > a.analyses["2024003"].p + 25 && !JSON.stringify(a).match(/study hours|assignments/i));

  /* --- permissions --- */
  await assert.rejects(s.act(null, { op: "saveMarks" }), /sign in/i);
  await assert.rejects(s.act(rahul, { op: "removeStudent", prn: "2024002" }), /permission/);
  await assert.rejects(s.act(kapoor, { op: "reset" }), /permission/);
  await assert.rejects(s.act(kapoor, { op: "removeStudent", prn: "2024002" }), /own students/);
  await assert.rejects(s.act(kapoor, { op: "saveMarks", subject: "Data Structures", exam: "e1", max: 30, records: [{ prn: "2024002", score: 20 }] }), /own students/);
  await assert.rejects(s.act(rahul, { op: "createQuiz" }), /permission/);

  /* --- students: add / edit / remove --- */
  await s.act(kapoor, { op: "addStudent", prn: "2024100", name: "Test Student", dob: "2010-01-01", cls: "IT-B", teacher: "Mr. Iyer" });
  let k2 = await s.snapshot(kapoor);
  assert(k2.analyses["2024100"].insufficient, "teacher-added student is assigned to that teacher, with no prediction yet");
  await assert.rejects(s.act(kapoor, { op: "addStudent", prn: "2024100", name: "Dup", dob: "2010-01-01", cls: "IT-A" }), /already exists/);
  await s.act(kapoor, { op: "updateStudent", prn: "2024100", cls: "IT-A", dob: "1999-01-01", teacher: "Mr. Iyer" });
  let rec = (await s.snapshot(admin)).students.find(x => x.prn === "2024100");
  assert.strictEqual(rec.dob, "2010-01-01", "teachers cannot change a sign-in date of birth");
  assert.strictEqual(rec.teacher, "Mrs. Kapoor", "teachers cannot reassign students");
  const test = await signIn({ role: "student", prn: "2024100", dob: "2010-01-01" });

  /* --- attendance (per subject, per day) --- */
  const subjects = a.curriculum.subjects, exams = a.curriculum.exams;
  assert.strictEqual(subjects.length, 5); assert.strictEqual(exams.length, 3);
  const logs = (await s.snapshot(rahul)).analyses["2024001"].d.att;
  assert(Object.keys(logs).length === 5 && Object.keys(logs["Data Structures"]).length > 20, "student gets a day-by-day log for every subject");
  assert(Object.values((await s.snapshot(kapoor)).analyses).every(x => x.d.att === undefined), "staff snapshots stay small");
  await s.act(kapoor, { op: "saveAttendance", subject: "Data Structures", date: "2026-10-05", records: [{ prn: "2024001", status: "A" }, { prn: "2024003", status: "P" }] });
  assert.strictEqual((await s.snapshot(rahul)).analyses["2024001"].d.att["Data Structures"]["2026-10-05"], "A");
  await s.act(kapoor, { op: "saveAttendance", subject: "Data Structures", date: "2026-10-05", records: [{ prn: "2024001", status: "P" }] });
  assert.strictEqual((await s.snapshot(rahul)).analyses["2024001"].d.att["Data Structures"]["2026-10-05"], "P", "saving a day again overwrites it");
  await assert.rejects(s.act(kapoor, { op: "saveAttendance", subject: "Nope", date: "2026-10-05", records: [] }), /subject/i);
  await assert.rejects(s.act(kapoor, { op: "saveAttendance", subject: "Data Structures", date: "2026-10-05", records: [{ prn: "2024001", status: "?" }] }), /not considered/);
  await assert.rejects(s.act(kapoor, { op: "saveAttendance", subject: "Data Structures", date: "2026-10-05", records: [{ prn: "2024002", status: "P" }] }), /own students/);

  /* --- exam marks (per subject, per exam) --- */
  await s.act(kapoor, { op: "saveAttendance", subject: "Data Structures", date: "2026-09-01", records: [{ prn: "2024100", status: "P" }] });
  assert((await s.snapshot(test)).analyses["2024100"].d.a.length >= 1, "attendance feeds the AI's monthly history");
  for (const ex of exams) {
    for (const sub of subjects.slice(0, -1)) await s.act(admin, { op: "saveMarks", subject: sub, exam: ex.key, max: ex.max, records: [{ prn: "2024100", score: ex.max * 0.6, teacher: 3 }] });
    assert((await s.snapshot(test)).analyses["2024100"].d.m.length === exams.indexOf(ex), "the exam only counts once every subject has marks");
    await s.act(admin, { op: "saveMarks", subject: subjects.at(-1), exam: ex.key, max: ex.max, records: [{ prn: "2024100", score: ex.max * 0.6 }] });
  }
  const t = (await s.snapshot(test)).analyses["2024100"];
  assert(!t.insufficient && t.d.m.length === 3 && t.d.m.every(v => v === 60), "3 complete exams unlock the prediction");
  assert.strictEqual(t.d.sub["Data Structures"].e1.s, 18);
  await assert.rejects(s.act(kapoor, { op: "saveMarks", subject: "Data Structures", exam: "e1", max: 30, records: [{ prn: "2024100", score: 80 }] }), /between/);
  await assert.rejects(s.act(kapoor, { op: "saveMarks", subject: "Data Structures", exam: "zzz", max: 30, records: [] }), /exam/i);

  /* --- quizzes: only inside a live, supervised class session --- */
  const aarav = await signIn({ role: "student", prn: "2024003", dob: "2009-01-30" });
  await assert.rejects(s.act(rahul, { op: "submitQuiz", quizId: "quiz_demo1", answers: [1, 2, 0] }), /Start the quiz in class/);
  await assert.rejects(s.act(rahul, { op: "startQuiz", quizId: "quiz_demo1", code: "1234" }), /not open/);
  const seenByStudent = (await s.snapshot(rahul)).quizzes.find(q => q.id === "quiz_demo1");
  assert(!seenByStudent.questions && !seenByStudent.session && seenByStudent.open === false, "no questions or code are visible outside a class session");
  await assert.rejects(s.act(rahul, { op: "openQuiz", id: "quiz_demo1", minutes: 10, roster: ["2024001"] }), /permission/);
  await assert.rejects(s.act(kapoor, { op: "openQuiz", id: "quiz_demo1", minutes: 10, roster: [] }), /Tick at least one/);
  await assert.rejects(s.act(kapoor, { op: "openQuiz", id: "quiz_demo1", minutes: 10, roster: ["2024002"] }), /not in class|own students/);
  await s.act(kapoor, { op: "openQuiz", id: "quiz_demo1", minutes: 10, roster: ["2024001"] });     // Aarav is absent today, so he is not on the list
  const code = (await s.snapshot(kapoor)).quizzes.find(q => q.id === "quiz_demo1").session.code;
  assert(/^\d{4}$/.test(code) && !JSON.stringify(await s.snapshot(rahul)).includes('"code"'), "the class code is only for staff");
  await assert.rejects(s.act(aarav, { op: "startQuiz", quizId: "quiz_demo1", code }), /not on your teacher's list/);
  await assert.rejects(s.act(rahul, { op: "startQuiz", quizId: "quiz_demo1", code: code === "0000" ? "1111" : "0000" }), /not right/);
  const go = await s.act(rahul, { op: "startQuiz", quizId: "quiz_demo1", code });
  assert(go.questions.length === 3 && !JSON.stringify(go).includes('"answer"') && go.deadline > Date.now(), "questions arrive only after starting, without answers");
  const right = ["Stack", "Enqueue", "O(1)"];
  const answers = go.questions.map(q => q.options.findIndex(o => right.includes(o)));            // each student sees a different order, so map by text
  const res = await s.act(rahul, { op: "submitQuiz", quizId: "quiz_demo1", answers });
  assert.strictEqual(res.result.pct, 100); assert(!res.result.review, "answers are not revealed to the room");
  await assert.rejects(s.act(rahul, { op: "submitQuiz", quizId: "quiz_demo1", answers }), /already/);
  await assert.rejects(s.act(test, { op: "startQuiz", quizId: "quiz_demo1", code }), /not for your class/);
  await s.act(kapoor, { op: "closeQuiz", id: "quiz_demo1" });
  await assert.rejects(s.act(aarav, { op: "startQuiz", quizId: "quiz_demo1", code }), /not open/);
  // time limit, and leaving the quiz screen: a held attempt does not reach the ML model until the teacher accepts it
  await s.act(kapoor, { op: "openQuiz", id: "quiz_demo1", minutes: 5, roster: ["2024003"] });
  const code2 = (await s.snapshot(kapoor)).quizzes.find(q => q.id === "quiz_demo1").session.code;
  const g2 = await s.act(aarav, { op: "startQuiz", quizId: "quiz_demo1", code: code2 });
  const qBefore = (await s.snapshot(aarav)).analyses["2024003"].d.q.length;
  await s.act(aarav, { op: "submitQuiz", quizId: "quiz_demo1", answers: g2.questions.map(() => 0), blurs: 6 });
  assert.strictEqual((await s.snapshot(aarav)).analyses["2024003"].d.q.length, qBefore, "a flagged attempt is not counted by the ML model");
  await assert.rejects(s.act(aarav, { op: "reviewQuiz", id: "quiz_demo1", student: "2024003", accept: true }), /permission/);
  await s.act(kapoor, { op: "reviewQuiz", id: "quiz_demo1", student: "2024003", accept: true });
  assert.strictEqual((await s.snapshot(aarav)).analyses["2024003"].d.q.length, qBefore + 1, "accepted by the teacher: now it counts");
  const db = require("../lib/db"), qs = await db.getQuizzes(), late = qs.find(q => q.id === "quiz_demo1");
  late.attempts = late.attempts.filter(x => x.student !== "2024001"); late.session.roster.push("2024001"); late.session.closesAt = Date.now() + 600000; late.starts = { "2024001": { at: Date.now() - 20 * 60000, perm: [{ qi: 0, oi: [0, 1, 2, 3] }, { qi: 1, oi: [0, 1, 2, 3] }, { qi: 2, oi: [0, 1, 2, 3] }] } };
  await db.saveQuiz(late);
  await assert.rejects(s.act(rahul, { op: "submitQuiz", quizId: "quiz_demo1", answers: [1, 2, 0] }), /Time is over/);
  await s.act(kapoor, { op: "createQuiz", title: "T", cls: "All", subject: "Data Structures", questions: [{ q: "1+1", options: ["1", "2"], answer: 1 }] });
  await assert.rejects(s.act(kapoor, { op: "createQuiz", title: "T", cls: "All", subject: "Operating Systems", questions: [{ q: "1+1", options: ["1", "2"], answer: 1 }] }), /assigned to you/);
  const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  await s.act(kapoor, { op: "createQuiz", title: "Pics", cls: "CSE-A", subject: "Data Structures", questions: [{ q: "", img: PNG, options: ["", "Two", "", "Four"], oimgs: [PNG, "", "", ""], answer: 3 }] });
  await assert.rejects(s.act(kapoor, { op: "createQuiz", title: "Bad", cls: "CSE-A", subject: "Data Structures", questions: [{ q: "x", img: "http://evil.example/a.png", options: ["a", "b"], answer: 0 }] }), /not a valid image/);
  await assert.rejects(s.act(kapoor, { op: "createQuiz", title: "Bad", cls: "CSE-A", subject: "Data Structures", questions: [{ q: "x", img: "data:image/svg+xml;base64,PHN2Zz4=", options: ["a", "b"], answer: 0 }] }), /not a valid image/);
  await assert.rejects(s.act(kapoor, { op: "createQuiz", title: "Bad", cls: "CSE-A", subject: "Data Structures", questions: [{ q: "", options: ["a", "b"], answer: 0 }] }), /text or a picture/);
  const pq = (await s.snapshot(kapoor)).quizzes.find(q => q.title === "Pics");
  await s.act(kapoor, { op: "openQuiz", id: pq.id, minutes: 5, roster: ["2024005"] });
  const rohan = await signIn({ role: "student", prn: "2024005", dob: "2010-11-02" });
  const pcode = (await s.snapshot(kapoor)).quizzes.find(q => q.id === pq.id).session.code;
  const pgo = await s.act(rohan, { op: "startQuiz", quizId: pq.id, code: pcode });
  assert(pgo.questions[0].img === PNG && pgo.questions[0].oimgs.includes(PNG) && pgo.questions[0].options.length === 3, "pictures reach the student only after starting");
  assert(!JSON.stringify((await s.snapshot(rohan)).quizzes).includes("base64"), "pictures are not in the quiz list");
  const rightIdx = pgo.questions[0].options.findIndex(o => o === "Four");
  assert.strictEqual((await s.act(rohan, { op: "submitQuiz", quizId: pq.id, answers: [rightIdx] })).result.pct, 100, "the right answer is found after blank options are skipped");
  assert.strictEqual((await s.snapshot(rahul)).quizzes.length, 3);

  /* --- attendance: "not considered" is never counted; any teacher can enter any subject --- */
  const pctOf = async () => (await s.snapshot(rahul)).analyses["2024001"].d.att;
  const fern = await signIn({ role: "teacher", email: "fernandes@school.edu", password: "teacher123" });
  await s.act(fern, { op: "saveAttendance", subject: "Operating Systems", date: "2026-10-06", records: [{ prn: "2024001", status: "N" }] });
  assert.strictEqual((await s.snapshot(rahul)).analyses["2024001"].d.att["Operating Systems"]["2026-10-06"], "N", "not-considered day is stored");
  const before = (await s.snapshot(rahul)).analyses["2024001"].att;
  await s.act(fern, { op: "saveAttendance", subject: "Operating Systems", date: "2026-10-07", records: [{ prn: "2024001", status: "N" }] });
  assert.strictEqual((await s.snapshot(rahul)).analyses["2024001"].att, before, "not-considered days do not change attendance");

  /* --- teachers change only the subjects assigned to them --- */
  await assert.rejects(s.act(kapoor, { op: "saveAttendance", subject: "Operating Systems", date: "2026-10-06", records: [{ prn: "2024001", status: "P" }] }), /not assigned to teach Operating Systems/);
  await assert.rejects(s.act(kapoor, { op: "saveMarks", subject: "Computer Networks", exam: "e1", max: 30, records: [{ prn: "2024001", score: 20 }] }), /not assigned to teach Computer Networks/);
  await s.act(fern, { op: "saveMarks", subject: "Operating Systems", exam: "e1", max: 30, records: [{ prn: "2024001", score: 20 }] });
  await assert.rejects(s.act(fern, { op: "saveMarks", subject: "Data Structures", exam: "e1", max: 30, records: [{ prn: "2024001", score: 20 }] }), /not assigned to teach Data Structures/);
  await assert.rejects(s.act(fern, { op: "saveMarks", subject: "Operating Systems", exam: "e1", max: 30, records: [{ prn: "2024002", score: 20 }, { prn: "2024100", score: 20 }] }), /own students|not assigned/);

  /* --- admin: several classes and subjects per teacher, students assigned one by one or by CSV --- */
  await s.act(admin, { op: "saveTeacher", name: "Ms. New", email: "new@school.edu", password: "newpass1", assign: [{ cls: "CSE-A", subjects: ["Operating Systems", "Computer Networks"] }, { cls: "CSE-B", subjects: ["Data Structures"] }] });
  const nu = await signIn({ role: "teacher", email: "new@school.edu", password: "newpass1" });
  assert.strictEqual((await s.snapshot(nu)).students.length, 70, "sees both assigned classes");
  await s.act(nu, { op: "saveMarks", subject: "Computer Networks", exam: "e1", max: 30, records: [{ prn: "2024001", score: 22 }] });
  await assert.rejects(s.act(nu, { op: "saveMarks", subject: "Computer Networks", exam: "e1", max: 30, records: [{ prn: "2024002", score: 22 }] }), /not assigned to teach Computer Networks/);
  await assert.rejects(s.act(admin, { op: "saveTeacher", name: "Ms. Bad", email: "bad@school.edu", password: "newpass1", assign: [{ cls: "CSE-A", subjects: [] }] }), /at least one subject/);
  await assert.rejects(s.act(kapoor, { op: "assignStudents", teacher: "Ms. New", prns: ["2024001"] }), /permission/);
  await s.act(admin, { op: "saveTeacher", name: "Ms. Solo", email: "solo@school.edu", password: "solopass1", assign: [{ cls: "CSE-A", subjects: ["Database Systems"] }] });
  await s.act(admin, { op: "assignStudents", teacher: "Ms. Solo", prns: ["2024002", "2024004"] });         // two CSE-B students, one by one
  const solo = await signIn({ role: "teacher", email: "solo@school.edu", password: "solopass1" });
  assert.strictEqual((await s.snapshot(solo)).students.length, 35 + 2, "own class plus the two assigned students");
  await s.act(solo, { op: "saveMarks", subject: "Database Systems", exam: "e1", max: 30, records: [{ prn: "2024002", score: 25 }] });
  await assert.rejects(s.act(solo, { op: "saveMarks", subject: "Operating Systems", exam: "e1", max: 30, records: [{ prn: "2024002", score: 25 }] }), /not assigned to teach/);
  const imp = await s.act(admin, { op: "importStudents", teacher: "Ms. Solo", rows: [
    { prn: "2025001", name: "Csv One", dob: "2010-04-01", cls: "CSE-A", parent: "Mr. One" },
    { prn: "2025002", name: "Csv Two", dob: "2010-04-02", cls: "CSE-B", teacher: "kapoor@school.edu" },
    { prn: "2024005", teacher: "Mr. Rao" }, { prn: "x", name: "Bad" }, { prn: "2025003", name: "No Dob", cls: "CSE-A" }, { prn: "2025004", name: "Ghost", dob: "2010-04-04", cls: "CSE-A", teacher: "Nobody" }] });
  assert.match(imp.message, /2 added, 1 updated, 3 skipped/); assert.strictEqual(imp.problems.length, 3);
  const after = (await s.snapshot(admin)).students;
  assert.strictEqual(after.length, 73); assert.strictEqual(after.find(x => x.prn === "2025001").teacher, "Ms. Solo"); assert.strictEqual(after.find(x => x.prn === "2025002").teacher, "Mrs. Kapoor"); assert.strictEqual(after.find(x => x.prn === "2024005").teacher, "Mr. Rao");
  await assert.rejects(s.act(kapoor, { op: "importStudents", rows: [] }), /permission/);

  /* --- subject and class names typed by the admin --- */
  await s.act(admin, { op: "saveTeacher", name: "Ms. Custom", email: "custom@school.edu", password: "custompw1", assign: [{ cls: "CSE-A", subjects: ["Data Structures and Algorithms", "  operating   systems ", "python basics and the web"] }] });
  const cust = await signIn({ role: "teacher", email: "custom@school.edu", password: "custompw1" });
  const cs = await s.snapshot(cust);
  assert(cs.curriculum.subjects.includes("Data Structures and Algorithms"), "a typed subject becomes a real subject");
  assert.strictEqual(cs.curriculum.subjects.filter(x => x.toLowerCase() === "operating systems").length, 1, "typed names are matched to existing ones, ignoring case and spacing");
  assert(cs.me.subjects.includes("Operating Systems") && cs.me.subjects.includes("Data Structures and Algorithms"));
  await s.act(cust, { op: "saveMarks", subject: "Data Structures and Algorithms", exam: "e1", max: 30, records: [{ prn: "2024001", score: 21 }] });
  await s.act(cust, { op: "saveAttendance", subject: "Data Structures and Algorithms", date: "2026-10-10", records: [{ prn: "2024001", status: "P" }] });
  await assert.rejects(s.act(cust, { op: "saveMarks", subject: "Data Structures and Algorithms", exam: "e1", max: 30, records: [{ prn: "2024002", score: 21 }] }), /own students|not assigned to teach/);   // CSE-B is not theirs
  await assert.rejects(s.act(admin, { op: "saveTeacher", name: "Ms. Bad2", email: "bad2@school.edu", password: "badpass12", assign: [{ cls: "CSE-A", subjects: ["Drop;Table"] }] }), /not a valid subject name/);
  const subs = (await s.snapshot(admin)).students;
  assert(subs.find(x => x.prn === "2024001").subjects.includes("Data Structures and Algorithms") && !subs.find(x => x.prn === "2024002").subjects.includes("Data Structures and Algorithms"), "each student sees only their class's subjects");
  assert(cs.curriculum.subjects.includes("Python Basics and the Web"), "all-lowercase names get capital letters");
  await s.act(admin, { op: "removeTeacher", name: "Ms. Custom" });

  /* --- pipeline: the ML model attaches a learning path; nobody can call the AI --- */
  let snap = await s.snapshot(rahul), pl = snap.analyses["2024001"].plan;
  assert(pl && pl.source === "ml" && pl.steps.length === 3 && pl.steps.every(x => x.when && /^https:\/\//.test(x.resource.url)), "built-in roadmap (3 steps, each with a resource) without a key");
  assert.strictEqual(snap.analyses["2024001"].d.plan, undefined, "plan travels beside the analysis, not inside the raw data");
  assert.strictEqual(typeof s.explain, "undefined", "no function lets a person call the AI");
  await assert.rejects(s.act(kapoor, { op: "exam", prn: "2024001" }), /Unknown action/);
  await assert.rejects(s.act(kapoor, { op: "retrain" }), /permission/);
  assert.match((await s.act(admin, { op: "retrain" })).message, /Retrained|Kept the current|No recorded/);

  /* --- the ML pipeline (and only it) calls Gemini, against a stand-in Google server --- */
  const http = require("http"); let calls = 0, lastBody = "", lastKey = "", mode = "ok";
  const fake = http.createServer((req, res) => {
    let b = ""; req.on("data", c => b += c); req.on("end", () => {
      calls++; lastBody = b; lastKey = req.headers["x-goog-api-key"];
      if (mode === "bad") { res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: { message: "API key not valid" } })); }
      const plan = { headline: "Start with Maths.", steps: [["Quadratic equations", "video"], ["Algebra", "practice"], ["Algebra", "bogus"]].map(([topic, type], i) => ({ title: "Step " + (i + 1), detail: "Do it.", resource: { topic, type, why: "Helps" } })) };
      if (mode === "invent") plan.steps[0].detail = "Your average is 91 percent, so keep going.";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(plan) }] } }] }));
    });
  });
  await new Promise(ok => fake.listen(0, ok));
  process.env.GEMINI_API_BASE = `http://localhost:${fake.address().port}/v1beta`;
  process.env.GEMINI_API_KEY = "test-key-123";
  snap = await s.snapshot(rahul); pl = snap.analyses["2024001"].plan;
  assert.strictEqual(pl.source, "ai"); assert.strictEqual(pl.headline, "Start with Maths."); assert.strictEqual(calls, 1);
  assert.strictEqual(pl.steps[2].resource.type, "notes", "unknown resource types are corrected");
  assert(pl.steps[0].resource.url.includes("youtube.com/results?search_query=Quadratic"), "links are built by us, not by the AI");
  assert.strictEqual(lastKey, "test-key-123");
  assert(!/Rahul|Sharma|2024001|2009-05-14/.test(lastBody), "no name, PRN or date of birth is sent to Gemini");
  assert(!JSON.stringify(snap).includes("test-key-123"), "the key never goes back to the browser");
  await s.snapshot(rahul); assert.strictEqual(calls, 1, "same findings: saved plan, no second request");
  mode = "bad"; await s.act(kapoor, { op: "saveAttendance", subject: "Data Structures", date: "2026-10-08", records: [{ prn: "2024001", status: "A" }] });
  pl = (await s.snapshot(rahul)).analyses["2024001"].plan; assert.strictEqual(pl.source, "ml", "AI failure: built-in path, quietly");
  await s.snapshot(rahul); assert.strictEqual(calls, 2, "a failed attempt is not repeated until the findings change");
  mode = "invent"; await s.act(kapoor, { op: "saveAttendance", subject: "Data Structures", date: "2026-10-09", records: [{ prn: "2024001", status: "A" }] });
  pl = (await s.snapshot(rahul)).analyses["2024001"].plan; assert.strictEqual(pl.source, "ml", "an AI plan that quotes numbers not in the findings is rejected");
  assert(pl.steps.every(x => x.lever && /^(big|good|small|)$/.test(x.effect)), "each step names its lever and the model's estimated effect");
  delete process.env.GEMINI_API_KEY; delete process.env.GEMINI_API_BASE; fake.close();

  /* --- a live site (Vercel) cannot be wiped by "Reset demo" --- */
  const cp = require("child_process").spawnSync(process.execPath, ["-e", `
    const s = require("./lib/service"), a = require("./lib/auth");
    (async () => { const u = a.verify((await s.login({ role: "admin", email: "boss@x.edu", password: "pw-123456" }, "i")).token);
      try { await s.act(u, { op: "reset" }); console.log("RESET ALLOWED"); } catch (e) { console.log(e.message); } })();`],
    { cwd: require("path").join(__dirname, ".."), encoding: "utf8",
      env: { ...process.env, VERCEL: "1", AUTH_SECRET: "x".repeat(40), ADMIN_EMAIL: "boss@x.edu", ADMIN_PASSWORD: "pw-123456", SEED_DEMO: "0",
             EDUPLUS_DB_FILE: require("path").join(require("os").tmpdir(), "eduplus-live-test.json") } });
  assert.match(cp.stdout, /Reset is turned off/, "reset is blocked on a live site: " + cp.stdout + cp.stderr);

  /* --- teachers --- */
  await s.act(admin, { op: "saveTeacher", name: "Mr. Rao", subject: "History", email: "rao@school.edu", password: "secret12" });
  await assert.rejects(s.act(admin, { op: "saveTeacher", name: "Mr. Lee", email: "rao@school.edu", password: "secret12" }), /already uses/);
  assert.strictEqual((await signIn({ role: "teacher", email: "rao@school.edu", password: "secret12" })).name, "Mr. Rao");
  await s.act(admin, { op: "removeTeacher", name: "Mr. Iyer" });
  assert((await s.snapshot(admin)).students.every(x => x.teacher !== "Mr. Iyer"));
  await s.act(kapoor, { op: "removeStudent", prn: "2024100" });
  assert.strictEqual((await s.snapshot(admin)).students.length, 72);
  await s.act(admin, { op: "reset" });
  console.log("All checks passed.");
})().catch(e => { console.error("FAILED:", e.message); process.exit(1); });
