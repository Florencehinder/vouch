alter table job_matches
  add column if not exists synced_to_sheet_at timestamptz;

create index if not exists job_matches_unsynced_idx
  on job_matches (synced_to_sheet_at)
  where synced_to_sheet_at is null;
