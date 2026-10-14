-- EduPlus AI schema. Run once in Supabase: SQL Editor -> New query -> paste -> Run.
-- Safe to run again: it only creates what is missing.
--
-- UPGRADING from an earlier version of this project? The tables changed shape
-- (students are now identified by PRN). Uncomment the next line ONCE, run, then comment it again.
-- This deletes the old demo data:
-- drop table if exists students, teachers, quizzes, outcomes, model_state, examples cascade;

create table if not exists students (
  prn     text primary key,              -- student ID used to sign in
  name    text not null,
  dob     text not null,                 -- YYYY-MM-DD, used with the PRN to sign in
  cls     text not null default '',
  teacher text not null default '',      -- name of the assigned teacher ('' = unassigned)
  parent  text not null default '',
  d       jsonb not null                 -- { m, ml, a, al, q, t, done }  marks, labels, attendance, quiz scores, teacher rating
);

create table if not exists teachers (
  name    text primary key,
  subject text not null default '',
  email   text not null unique,          -- used to sign in
  pw      text not null,                 -- password hash (never plain text)
  classes text not null default ''       -- classes this teacher can see, comma separated
);
alter table teachers add column if not exists classes text not null default '';   -- for databases created before this column existed

create table if not exists quizzes (
  id   text primary key,
  data jsonb not null                    -- title, subject, cls, teacher, questions (with answers), attempts
);

create table if not exists outcomes (
  id         bigserial primary key,
  prn        text not null,
  month      text,                       -- exam name
  p_from     int,                        -- risk % before the exam
  p_to       int,                        -- risk % after the exam
  mark       int,
  expected   int,
  actions    int,
  created_at timestamptz default now()
);

create table if not exists model_state (
  id    int primary key,                 -- 1 = learned model, 2 = "demo data loaded" flag
  state jsonb not null
);

create table if not exists examples (
  id         bigserial primary key,
  x          jsonb not null,             -- feature vector before the exam
  y          int   not null,             -- 1 = student declined
  created_at timestamptz default now()
);

-- Lock the tables down. Only the server (service-role key) can read/write them;
-- the browser never talks to Supabase directly.
alter table students    enable row level security;
alter table teachers    enable row level security;
alter table quizzes     enable row level security;
alter table outcomes    enable row level security;
alter table model_state enable row level security;
alter table examples    enable row level security;
