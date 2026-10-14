# EduPlus AI

Student performance prediction with a real machine-learning model, role-based sign-in, a Node API and a Supabase database.
The ML model finds students who are slipping and builds a short **roadmap to improve** (3 steps, each with a related resource). Nobody can call the AI directly: only the server asks Gemini (optional) to word the roadmap.

## Who sees what

| Who | Signs in with | Pages |
|---|---|---|
| **Student / parent** (one shared login) | PRN + date of birth | *My Progress* (marks, attendance, roadmap), *Quizzes* |
| **Teacher** | Email + password | *Home*, *Students*, *Enter Data*, *Quizzes*, *Insights* for the classes assigned to them |
| **Admin** | Email + password from settings | *Overview*, *Students*, *Enter Data*, *Quizzes*, *Insights*, *Teachers* |

The server checks every request, so these limits are real.

## The ML model (v2.0)

**What it predicts:** the chance that a student is *at risk in the next exam*, meaning the next overall mark below 50, or 12+ points under their recent average. The result is a calibrated probability turned into a plain status: *On track*, *Needs attention* (from 30%) or *Needs support now* (from 55%).

**Inputs (12 features):** recent marks, marks trend, how much marks jump around, a sudden drop in the latest exam, the weakest subject and how many subjects are below the pass mark, attendance, attendance trend, the weakest subject's attendance, quiz average and quiz trend, and the teacher's rating. "Not considered" attendance days are never counted.

**Model:** logistic regression with sign constraints (better marks or attendance can never raise the risk), L2 regularisation chosen by 5-fold cross-validation, Platt probability calibration, and risk bands tuned on validation data. It is deliberately simple so every prediction can be explained exactly: each factor's contribution is its coefficient times how far the student is from average.

**Held-out test results** (20% of data never used for fitting, tuning or calibration; trained on a simulated school):

| Measure | Result |
|---|---|
| AUC (ranking quality) | 0.912 |
| Precision-recall AUC | 0.845 |
| At-risk students caught at "Needs attention" | 80% |
| "Needs support now" flags that were correct | 86% |
| Calibration error (ECE) / Brier score | 0.014 / 0.092 |
| For comparison (AUC): simple rule / first model's inputs / gradient boosting | 0.833 / 0.9 / 0.92 |

The gradient-boosting score is only a ceiling check: the explainable model is within about 0.01 AUC of it. **Honest note:** these numbers come from a simulated school, so they show the method works, not how accurate it will be on your pupils. Train on your own records to get real numbers.

**What-if levers:** for each student the model re-scores the risk if one thing improved by a realistic step (attendance +10 points, marks +8, weakest subject +12, marks stop falling, quiz average +10). The roadmap is ordered by these effects and each step shows *Big effect*, *Good effect* or *Helps a bit*. They are model estimates, not promises.

**Reliability, not fake confidence:** each prediction is labelled High, Medium or Low reliability from how much data stands behind it (exams, attendance records, quizzes, subject marks). Fewer than 3 exams or no attendance record gives no prediction at all.

**AI wording (optional):** Gemini only rewrites the model's findings into a 3-step roadmap. It receives anonymous numbers, must pick one of the model's levers for each step, and its text is rejected, and the built-in roadmap shown, if it quotes numbers that are not in the findings.

**Learning from your school:** every recorded exam outcome becomes a training example. The model retrains itself automatically (from 10 examples), but a new version is only kept if it does better than the running one on the newest 20% of outcomes; otherwise the notes say it kept the current model. Examples made for an older model version are ignored.

**Retrain offline (Python 3 with numpy, scipy, scikit-learn):**
```
python ml/train.py                       # simulated school
python ml/train.py --csv records.csv     # your data: the 12 feature columns + at_risk (0/1)
```
It rewrites `model/model.json` (including the report shown to admins under Insights) and `test/parity.json`. `npm test` then proves the live JavaScript model gives the same features and probabilities as Python, and that the quality bar (AUC, calibration, recall, precision) still holds.

## Interface

- **Light and dark mode**: the sun/moon button at the top of every page (also on the sign-in page). The choice is remembered in the browser.
- **Notifications** (bell): built from live data. Students see open quizzes, low subject attendance and their support level. Teachers and admin see running quizzes, attempts to review, students who need support, low attendance and unassigned students or teachers. Clicking an item opens the right page and marks it read.
- **Attendance by subject**: on *My Progress*, click a subject to see a calendar and a dated history you can filter by All, Present or Absent.
- **Quiz pictures**: when creating a quiz, add a picture to any question and to any answer option (shrunk in the browser; pictures reach students only after they start the quiz in class).

## Teachers, classes and subjects

- On the **Teachers** page the admin gives each teacher one or more **classes**, and the **subjects** they teach in each class (Add teacher / Edit). Class and subject names are **typed freely** (for example `Data Structures and Algorithms`): press Enter after each subject. Names are matched to ones already in use, ignoring capitals and spacing, so one subject never exists twice. A class studies the subjects its teachers are assigned (a class with no assigned teachers uses the five starter subjects), and an exam counts once every subject of the student's class has marks. Marks entered earlier under an old subject name stay on the student's record.
- A teacher can enter attendance and marks **only for the subjects assigned to them, in those classes**. Enter Data shows only those choices, and the server refuses anything else.
- The admin can also give a teacher specific students: **Students** button on a teacher (tick the students), or **Import students (CSV)**. Students given to a teacher one by one can be updated for any subject that teacher teaches.
- CSV columns: `prn, name, dob, class, parent, teacher` (teacher = name or email). Existing students need only `prn` (for example a file with just `prn, teacher` assigns them). Up to 500 rows per file; a template can be downloaded in the dialog.

## Quizzes are taken in class only

A quiz cannot be opened from home. The teacher presses **Start in class**, ticks the students who are in the room, picks a time limit and writes the 4-digit **class code** on the board. A student can start only if they are on that list and enter the code; the server enforces the time limit. Each student sees the questions and options in a different order, answers are never shown to the room, and leaving the quiz screen is recorded: an attempt with more than 2 exits is held back until the teacher presses **Count it** or **Ignore**. Absent students take the quiz later in a make-up session run in class. Only supervised, unflagged scores reach the ML model.

## Sample data (loaded automatically on first sign-in)

- 2 classes (CSE-A, CSE-B), 35 students each (PRN 2024001 to 2024070), 7 teachers.
- Student/parent: PRN `2024001`, date of birth `2009-05-14` (Rahul Sharma, the declining-marks example).
- Teachers (password `teacher123` for all; change it on the *Teachers* page before real use): `kapoor@school.edu` (Data Structures, CSE-A), `iyer@school.edu` (Database Systems, CSE-B), `fernandes@school.edu` (Operating Systems, both classes), `rao@school.edu` (Computer Networks, both), `menon@school.edu` (Engineering Mathematics, both), `banerjee@school.edu` (Data Structures, CSE-B), `sethi@school.edu` (Database Systems, CSE-A).
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
| `lib/model.js`, `model/` | The ML model: features, prediction, explanations, what-if levers, retraining. `model/model.json` holds the trained weights and report |
| `lib/db.js`, `lib/seed.js` | Supabase or local-file storage, and the sample data |
| `supabase/schema.sql` | Database tables. Run once in Supabase |
| `ml/train.py` | Training pipeline: split, cross-validation, calibration, risk bands, comparison, report |
| `test/model.js`, `test/smoke.js`, `test/parity.json` | `npm test`: ML checks, then the whole-app checks |

## Deploy

Follow **DEPLOYMENT.md**: Supabase, then GitHub, then Vercel.
