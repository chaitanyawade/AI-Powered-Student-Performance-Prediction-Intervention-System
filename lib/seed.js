// Starting demo data (college style): one semester, five subjects, three exams per subject,
// and a day-by-day attendance log for every subject.
//
// d.m / d.ml  = overall exam history used by the AI (average of all subjects for each exam)
// d.a / d.al  = monthly attendance history used by the AI
// d.q         = recent quiz scores (%)          d.t = teacher rating (1-5)
// d.sub       = current-semester marks:      { subject: { e1: {s, max}, e2: {s, max}, end: {s, max} } }
// d.att       = current-semester attendance: { subject: { "2026-09-14": "P" | "A" } }
// d.done      = improvement steps marked as done since the last exam

const SEMESTER = "Semester 3";
const SUBJECTS = ["Data Structures", "Database Systems", "Operating Systems", "Computer Networks", "Engineering Mathematics"];
const EXAMS = [
  { key: "e1",  label: "1st Exam",          max: 30 },
  { key: "e2",  label: "2nd Exam",          max: 30 },
  { key: "end", label: "Semester End Exam", max: 100 }
];
const ATT_MIN = 75;                                   // minimum attendance % a student must keep
const DEMO_TEACHER_PASSWORD = "teacher123";           // demo only: change on the Teachers page

/* ---------- generators for the demo data ---------- */
const rng = seed => () => {                           // small deterministic random generator
  seed |= 0; seed = seed + 0x6D2B79F5 | 0;
  let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296;
};
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// weekdays of the semester so far (3 Aug to 9 Oct 2026)
const DAYS = [];
for (let d = new Date(Date.UTC(2026, 7, 3)); d <= new Date(Date.UTC(2026, 9, 9)); d.setUTCDate(d.getUTCDate() + 1)) {
  const wd = (d.getUTCDay() + 6) % 7;                 // Mon = 0
  if (wd < 5) DAYS.push({ iso: d.toISOString().slice(0, 10), wd });
}

function marks(e1avg, e2avg) {                        // per-subject marks that average to the given exam averages
  const off1 = [6, -4, 2, -6, 2], off2 = [-5, 3, 4, -6, 4], sub = {};
  SUBJECTS.forEach((s, i) => {
    sub[s] = {
      e1: { s: Math.round(clamp(e1avg + off1[i], 0, 100) * 30 / 100), max: 30 },
      e2: { s: Math.round(clamp(e2avg + off2[i], 0, 100) * 30 / 100), max: 30 }
    };
  });
  return sub;
}

function attendance(target, seed) {                   // three lectures a week per subject
  const next = rng(seed), off = [4, -3, 2, -5, 2], att = {};
  SUBJECTS.forEach((s, i) => {
    const pAbsent = clamp(1 - (target + off[i]) / 100, 0, 0.9);
    att[s] = {};
    DAYS.forEach(day => { if ((day.wd + i) % 5 < 3) att[s][day.iso] = next() < pAbsent ? "A" : "P"; });
  });
  return att;
}

const MONTHS = ["Apr", "May", "Jun", "Jul", "Aug", "Sep"];
const HIST = ["Sem 1 · End Exam", "Sem 2 · 1st Exam", "Sem 2 · 2nd Exam", "Sem 2 · End Exam", "Sem 3 · 1st Exam", "Sem 3 · 2nd Exam"];

const mk = (n, m, a, q, t) => ({
  m, ml: [...HIST], a, al: [...MONTHS], q, t, done: [],
  sub: marks(m[4], m[5]), att: attendance(a[a.length - 1], 7000 + n)
});

/* ---------- 62 more students so each of the two classes has 35 ---------- */
const FIRST = ["Aditya","Vivaan","Arjun","Sai","Reyansh","Krish","Atharv","Dhruv","Neel","Yash","Anika","Saanvi","Myra","Kiara","Navya","Ira","Meera","Tara","Riya","Sneha","Pooja","Kavya","Nisha","Aisha","Zoya","Tanvi","Isha","Manav","Harsh","Varun","Siddharth"];
const LAST = ["Gupta","Reddy","Desai","Bhat","Kulkarni","Pillai","Chopra","Malhotra","Shetty","Menon","Agarwal","Bose","Chatterjee","Das","Ghosh","Jain","Khan","Lal","Mishra","Naidu","Pandey","Rastogi","Saxena"];

function profile(n) {                               // a believable mix: most steady, some improving, some slipping
  const r = rng(900 + n), j = (base, spread) => Math.round(clamp(base + (r() - 0.5) * spread, 20, 98)), pick = r();
  const line = (from, to, len, spread) => Array.from({ length: len }, (_, i) => j(from + (to - from) * i / (len - 1), spread));
  if (pick < 0.16) return mk(n, line(76 - r() * 6, 46 + r() * 8, 6, 5), line(90, 66 + r() * 6, 6, 3), line(62, 40 + r() * 6, 5, 6), 2 + (r() < 0.5 ? 0 : 1)); // slipping
  if (pick < 0.30) return mk(n, line(54 + r() * 6, 50 + r() * 6, 6, 6), line(74, 68, 6, 4), line(52, 48, 5, 8), 2);                                                  // low and steady
  if (pick < 0.46) return mk(n, line(55 + r() * 5, 72 + r() * 6, 6, 5), line(78, 91, 6, 3), line(54, 74, 5, 6), 3 + (r() < 0.5 ? 0 : 1));                           // improving
  return mk(n, line(74 + r() * 12, 76 + r() * 12, 6, 4), line(90, 93, 6, 3), line(72, 84, 5, 6), 4 + (r() < 0.4 ? 1 : 0));                                           // strong
}

function generated() {
  const out = {}, used = new Set(), left = { "CSE-A": 35 - 3, "CSE-B": 35 - 5 }, boss = { "CSE-A": "Mrs. Kapoor", "CSE-B": "Mr. Iyer" };
  for (let n = 9; n <= 70; n++) {
    const r = rng(n * 31);
    let name; for (let k = 0; !name || used.has(name); k++) name = `${FIRST[(n + k * 7) % FIRST.length]} ${LAST[(n * 3 + k) % LAST.length]}`;
    used.add(name);
    let cls = n % 2 ? "CSE-A" : "CSE-B"; if (!left[cls]) cls = cls === "CSE-A" ? "CSE-B" : "CSE-A"; left[cls]--;
    const dob = `${2009 + Math.floor(r() * 2)}-${String(1 + Math.floor(r() * 12)).padStart(2, "0")}-${String(1 + Math.floor(r() * 28)).padStart(2, "0")}`;
    out["2024" + String(n).padStart(3, "0")] = { name, dob, cls, teacher: boss[cls], parent: `${n % 2 ? "Mr." : "Mrs."} ${name.split(" ")[1]}`, d: profile(n) };
  }
  return out;
}

module.exports = {
  SEMESTER, SUBJECTS, EXAMS, ATT_MIN, DEMO_TEACHER_PASSWORD,
  teachers: [                                       // assign = the classes each teacher teaches and the subjects in each
    { name: "Mrs. Kapoor",   email: "kapoor@school.edu",    assign: [{ cls: "CSE-A", subjects: ["Data Structures"] }] },
    { name: "Mr. Iyer",      email: "iyer@school.edu",      assign: [{ cls: "CSE-B", subjects: ["Database Systems"] }] },
    { name: "Ms. Fernandes", email: "fernandes@school.edu", assign: [{ cls: "CSE-A", subjects: ["Operating Systems"] }, { cls: "CSE-B", subjects: ["Operating Systems"] }] },
    { name: "Mr. Rao",       email: "rao@school.edu",       assign: [{ cls: "CSE-A", subjects: ["Computer Networks"] }, { cls: "CSE-B", subjects: ["Computer Networks"] }] },
    { name: "Dr. Menon",     email: "menon@school.edu",     assign: [{ cls: "CSE-A", subjects: ["Engineering Mathematics"] }, { cls: "CSE-B", subjects: ["Engineering Mathematics"] }] },
    { name: "Ms. Banerjee",  email: "banerjee@school.edu",  assign: [{ cls: "CSE-B", subjects: ["Data Structures"] }] },
    { name: "Mr. Sethi",     email: "sethi@school.edu",     assign: [{ cls: "CSE-A", subjects: ["Database Systems"] }] }
  ],
  students: Object.assign({
    "2024001": { name: "Rahul Sharma", dob: "2009-05-14", cls: "CSE-A", teacher: "Mrs. Kapoor",   parent: "Mr. Sharma", d: mk(1, [78,72,64,56,50,46], [88,84,79,74,70,68], [50,46,44,42,38], 1) },
    "2024002": { name: "Priya Patel",  dob: "2009-08-22", cls: "CSE-B", teacher: "Mr. Iyer",      parent: "Mrs. Patel", d: mk(2, [76,75,72,70,68,65], [88,86,83,81,80,79], [66,64,62,60,58], 3) },
    "2024003": { name: "Aarav Mehta",  dob: "2009-01-30", cls: "CSE-A", teacher: "Mrs. Kapoor",   parent: "Mr. Mehta",  d: mk(3, [84,86,88,90,90,90], [93,94,94,95,94,94], [88,90,92,90,90], 5) },
    "2024004": { name: "Ananya Singh", dob: "2010-03-09", cls: "CSE-B", teacher: "Mr. Iyer", parent: "Mrs. Singh", d: mk(4, [64,66,70,72,71,71], [80,81,83,82,82,82], [60,58,56,58,58], 2) },
    "2024005": { name: "Rohan Kumar",  dob: "2010-11-02", cls: "CSE-A", teacher: "Mrs. Kapoor",   parent: "Mr. Kumar",  d: mk(5, [68,62,58,54,50,50], [82,78,73,70,67,65], [60,58,55,52,50], 3) },
    "2024006": { name: "Ishaan Verma", dob: "2010-07-18", cls: "CSE-B", teacher: "Mr. Iyer", parent: "Mr. Verma",  d: mk(6, [80,82,85,86,86,85], [90,91,92,91,91,91], [80,82,84,82,82], 4) },
    "2024007": { name: "Diya Nair",    dob: "2009-12-05", cls: "CSE-B", teacher: "Mr. Iyer",      parent: "Mrs. Nair",  d: mk(7, [80,79,79,78,78,77], [90,89,88,88,87,88], [78,76,76,74,76], 5) },
    "2024008": { name: "Kabir Joshi",  dob: "2009-09-27", cls: "CSE-B", teacher: "Mr. Iyer",      parent: "Mr. Joshi",  d: mk(8, [66,60,54,50,46,36], [78,74,70,66,63,61], [60,56,52,48,44], 2) }
  }, generated()),
  quizzes: [{
    id: "quiz_demo1", title: "Stacks and Queues", subject: "Data Structures", cls: "CSE-A", teacher: "Mrs. Kapoor",
    created: "2026-10-01", attempts: [],
    questions: [
      { q: "Which data structure works on the last-in, first-out principle?", options: ["Queue", "Stack", "Array", "Tree"], answer: 1 },
      { q: "Which operation adds an element to a queue?", options: ["Push", "Pop", "Enqueue", "Peek"], answer: 2 },
      { q: "What is the time to push onto an array-based stack?", options: ["O(1)", "O(n)", "O(log n)", "O(n²)"], answer: 0 }
    ]
  }]
};