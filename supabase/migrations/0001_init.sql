create extension if not exists pgcrypto;

drop table if exists job_matches cascade;
drop table if exists jobs cascade;
drop table if exists contacts cascade;
drop table if exists companies cascade;
drop table if exists runs cascade;
drop table if exists scrape_runs cascade;

create table companies (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  careers_url text,
  ats_provider text,
  ats_slug text,
  priority text,
  notes text,
  last_synced_at timestamptz,
  last_scraped_at timestamptz,
  created_at timestamptz default now()
);

create table contacts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id) on delete cascade,
  name text not null,
  role text,
  relationship_strength text,
  contact_method text,
  notes text,
  created_at timestamptz default now(),
  unique (company_id, name)
);

create table jobs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id) on delete cascade,
  external_id text not null,
  title text not null,
  location text,
  url text not null,
  description_text text,
  posted_at timestamptz,
  first_seen_at timestamptz default now(),
  last_seen_at timestamptz default now(),
  is_open boolean default true,
  unique (company_id, external_id)
);

create table job_matches (
  id uuid primary key default gen_random_uuid(),
  job_id uuid references jobs(id) on delete cascade unique,
  matched_role_category text,
  match_score numeric,
  classification_version text,
  classification_reasoning text,
  status text default 'new',
  user_notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table runs (
  id uuid primary key default gen_random_uuid(),
  kind text,
  started_at timestamptz default now(),
  finished_at timestamptz,
  status text,
  stats jsonb,
  error text
);

create index on jobs (company_id, is_open);
create index on job_matches (status, created_at desc);
