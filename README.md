# EduPlus AI

Student performance prediction with a real machine-learning model, role-based sign-in, a Node API and a Supabase database.
The ML model finds students who are slipping and builds a short **roadmap to improve** (3 steps, each with a related resource). Nobody can call the AI directly: only the server asks Gemini (optional) to word the roadmap.

## Who sees what

| Who | Signs in with | Pages |
|---|---|---|
| **Student / parent** (one shared login) | PRN + date of birth | *My Progress* (marks, attendance, roadmap), *Quizzes* |
| **Teacher** | Email + password | *Home*, *Students*, *Enter Data*, *Quizzes*, *Insights* for the classes assigned to them |
| **Admin** | Email + password from settings | *Overview*, *Students*, *Enter Data*, *Quizzes*, *Insights*, *Teachers* |

The server checks every request, so these limits are real. A teacher can enter attendance and marks for **any subject** for their own classes.

## Sample data (loaded automatically on first sign-in)

- 2 classes (CSE-A, CSE-B), 35 students each (PRN 2024001 to 2024070), 7 teachers.
- Student/parent: PRN `2024001`, date of birth `2009-05-14` (Rahul Sharma, the declining-marks example).
- Teachers: `kapoor@school.edu` (CSE-A), `iyer@school.edu` (CSE-B), `fernandes@school.edu`, `rao@school.edu`, `menon@school.edu`, `banerjee@school.edu`, `sethi@school.edu`. Password for all: `teacher123`. Change it on the *Teachers* page before real use.
- Admin locally: `admin@school.edu` / `admin123`. Online you choose the admin email and password yourself (see DEPLOYMENT.md).

## Attendance

Each student, subject and day is **Present**, **Absent** or **Not considered** (holiday or no class held). *Not considered* days are never counted in percentages, the monthly history or the ML model.

## Run on your computer

Needs Node.js 18 or newer.

```
npm test      # should end with: All checks passed.
npm start     # open http://localhost:3000
```

Without a `.env` file, data is saved in `data/local-db.json`. To reload the sample data, stop the server and delete that file.

## Files

| Path | Purpose |
|---|---|
| `public/index.html` | The whole website |
| `api/*.js` | Vercel serverless routes: `login`, `students` (everything a person may see), `act` (every change, permission-checked), `health` |
| `server.js` | Same API for local use (`npm start`) |
| `lib/service.js` | Rules: access control, attendance, marks, seeding, automatic retraining |
| `lib/coach.js`, `lib/gemini.js` | Roadmap builder. Gemini is called only here, from the server, with anonymous numbers |
| `lib/model.js`, `model/` | The ML model (logistic regression) and its trained base weights |
| `lib/db.js`, `lib/seed.js` | Supabase or local-file storage, and the sample data |
| `supabase/schema.sql` | Database tables. Run once in Supabase |
| `ml/train.py` | Optional: retrain the base model (`python ml/train.py`) |
| `test/smoke.js` | `npm test` |

## Deploy

Follow **DEPLOYMENT.md**: Supabase, then GitHub, then Vercel.
