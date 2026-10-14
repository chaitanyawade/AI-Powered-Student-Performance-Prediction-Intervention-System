# Deploy EduPlus AI: Supabase, GitHub, Vercel

Do the steps in this order. Total time: about 20 minutes. You need Node.js 18+, Git, and free accounts on Supabase, GitHub and Vercel.

> Never put your Supabase secret key or Gemini key in `index.html`, in GitHub or in a chat. They live only in your local `.env` file and in Vercel's environment variables.

## 0. Test on your computer

```
npm test
npm start      # http://localhost:3000, sign in with the demo accounts in README.md
```

## 1. Supabase (database)

1. https://supabase.com -> **New project**. Pick a name, a nearby region and a database password. Wait until it is ready.
2. **SQL Editor -> New query**. Paste all of `supabase/schema.sql` and click **Run**. It must say "Success". **Table Editor** should show 6 tables: `students`, `teachers`, `quizzes`, `outcomes`, `model_state`, `examples`.
   - Already have an older EduPlus database? Run the single `alter table teachers add column ...` line in that file, or remove the `-- ` in front of the `drop table` line at the top, run the file once, then put the `-- ` back (this deletes old data).
3. **Settings -> API Keys**. Copy:
   - **Project URL** (looks like `https://abcdxyz.supabase.co`)
   - **Secret key** (starts with `sb_secret_`). Older projects: the `service_role` key. **Never the publishable key.**

You do not need to insert the sample data yourself. It is loaded automatically the first time anyone signs in (step 4).

## 2. GitHub

1. https://github.com -> **New repository** -> name `eduplus-ai`, **Private**, do not add a README -> **Create**.
2. In the project folder:
   ```
   git init
   git add .
   git commit -m "EduPlus AI"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/eduplus-ai.git
   git push -u origin main
   ```
3. Run `git ls-files`. You should see `.env.example` but **not** `.env` or `data/local-db.json`.

## 3. Vercel

1. https://vercel.com -> sign up with GitHub -> **Add New -> Project** -> import `eduplus-ai`.
2. Framework Preset: **Other**. Leave Build Command and Output Directory empty (`vercel.json` sets them).
3. **Environment Variables**:

   | Name | Value |
   |---|---|
   | `SUPABASE_URL` | Project URL from step 1 |
   | `SUPABASE_SERVICE_KEY` | the `sb_secret_...` key |
   | `AUTH_SECRET` | long random text: run `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
   | `ADMIN_EMAIL` | the email you will use as admin |
   | `ADMIN_PASSWORD` | a strong password |
   | `GEMINI_API_KEY` | optional. Without it the built-in roadmap wording is used |

   Leave `SEED_DEMO` unset to get the sample data. Add `GEMINI_MODEL` only if Gemini says the model was not found.
4. **Deploy**.

## 4. Check it works

1. Open `https://YOUR-PROJECT.vercel.app/api/health`. It must show `"store":"supabase"`.
2. Open the site and sign in as admin with `ADMIN_EMAIL` / `ADMIN_PASSWORD`. The first sign-in loads the sample data (a few seconds).
3. In Supabase **Table Editor -> students** you should now see 70 rows, and 7 in `teachers`.
4. Sign in as a teacher (`kapoor@school.edu` / `teacher123`) and a student (`2024001` / `2009-05-14`). The sign-in page does not show demo hints online, so share these yourself.

Changed an environment variable later? Redeploy: **Deployments -> latest -> ... -> Redeploy**.

## 5. Real data instead of sample data

The sample teachers all share the password `teacher123`. Before real use either change each password on the **Teachers** page, or start empty:

1. Supabase **SQL Editor**: `truncate table students, teachers, quizzes, outcomes, model_state, examples restart identity;`
2. Vercel: add `SEED_DEMO` = `0` and redeploy.
3. Sign in as admin, add teachers (with their own email and password) and students, and assign classes.

## 6. Updating later

```
npm test
git add .
git commit -m "describe the change"
git push
```
Vercel redeploys automatically.

## How the AI is used

Only the server asks Gemini, and only for a student whose ML findings changed, with anonymous numbers (no name, PRN or date of birth). Nobody can type to it or trigger it. If Gemini is missing or fails, the built-in roadmap is shown. The ML model retrains itself from recorded exam results.

## If something goes wrong

| What you see | What to do |
|---|---|
| "Cannot reach the server" | Open `/api/health`. If it errors, check **Vercel -> project -> Logs** |
| "Server is missing AUTH_SECRET" | Add `AUTH_SECRET` in Vercel and redeploy |
| Admin sign-in "not configured" | Add `ADMIN_EMAIL` and `ADMIN_PASSWORD` in Vercel and redeploy |
| "The database tables are missing" | Run `supabase/schema.sql` (step 1) |
| Errors mentioning `classes` | Run the `alter table teachers add column ...` line from `supabase/schema.sql` |
| "Supabase rejected the key" | Re-copy `SUPABASE_URL` and the **secret** key, with no spaces |
| "... is the publishable key" | Use the key starting `sb_secret_` |
| Errors after the site sat unused | Free Supabase projects pause when idle: restore the project in the Supabase dashboard |
| Sample data did not appear | `/api/health` must show `supabase`. Then sign in once more. If tables were created after a failed first attempt, run the `truncate` line from step 5 and sign in again |
