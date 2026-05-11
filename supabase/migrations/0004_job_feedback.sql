-- Phase 1 of feedback loop: capture user feedback on matches, survive reclassification
-- Lives in its own table (not on job_matches) so bumping CLASSIFICATION_VERSION
-- and re-classifying doesn't wipe accumulated feedback.

create table if not exists job_feedback (
  id uuid primary key default gen_random_uuid(),
  job_id uuid references jobs(id) on delete cascade unique,
  -- '++' (loved), '+' (better than rated), '-' (less relevant), '--' (never again)
  feedback text not null,
  feedback_reason text,
  -- Snapshot of category + score at the time feedback was given, for context when
  -- showing as few-shot example to Haiku. Survives reclassification.
  category_at_feedback text,
  score_at_feedback numeric,
  reasoning_at_feedback text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists job_feedback_created_idx on job_feedback (created_at desc);
