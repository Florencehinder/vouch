alter table companies
  add column if not exists ai_deployment_score smallint,
  add column if not exists team_caliber_score smallint,
  add column if not exists customer_access_score smallint,
  add column if not exists network_alumni_score smallint,
  add column if not exists stage_score smallint,
  add column if not exists geographic_score smallint,
  add column if not exists mission_score smallint,
  add column if not exists tier text,
  add column if not exists tier_reasoning text,
  add column if not exists evaluation_version text,
  add column if not exists evaluated_at timestamptz;

create index if not exists companies_tier_idx on companies (tier);
