create extension if not exists pgcrypto;

alter table public."巡号手记" alter column reflection drop not null;
alter table public."巡号手记" drop constraint if exists 巡号手记_decision_check;
alter table public."巡号手记" add constraint 巡号手记_decision_check
  check (decision in ('本轮跳过','看过但不想写','留下心得','想分享','写草稿','已发布','发布失败'));

create table if not exists public.xhs_patrol_devices (
  id text primary key,
  secret_hash text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

-- Provision a device separately with a SHA-256 hash of a random secret.
-- Never commit the original device secret to source control.

create table if not exists public.xhs_patrol_jobs (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'browse' check (kind in ('browse','publish')),
  status text not null default 'queued' check (status in ('queued','claimed','completed','failed')),
  scheduled_at timestamptz not null,
  claimed_at timestamptz,
  completed_at timestamptz,
  payload jsonb not null default '{}'::jsonb,
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  unique(kind, scheduled_at)
);

alter table public.xhs_patrol_devices enable row level security;
alter table public.xhs_patrol_jobs enable row level security;

create or replace function public.claim_xhs_patrol_job(p_device_id text, p_secret text)
returns setof public.xhs_patrol_jobs language plpgsql security definer set search_path=public,extensions as $$
declare v_job public.xhs_patrol_jobs;
begin
  if not exists (select 1 from xhs_patrol_devices where id=p_device_id and enabled and secret_hash=encode(digest(p_secret,'sha256'),'hex')) then raise exception 'unauthorized'; end if;
  select * into v_job from xhs_patrol_jobs where status='queued' and scheduled_at<=now() order by scheduled_at for update skip locked limit 1;
  if v_job.id is null then return; end if;
  update xhs_patrol_jobs set status='claimed', claimed_at=now() where id=v_job.id returning * into v_job;
  return next v_job;
end $$;

create or replace function public.complete_xhs_patrol_job(p_device_id text, p_secret text, p_job_id uuid, p_result jsonb, p_error text default null)
returns void language plpgsql security definer set search_path=public,extensions as $$
begin
  if not exists (select 1 from xhs_patrol_devices where id=p_device_id and enabled and secret_hash=encode(digest(p_secret,'sha256'),'hex')) then raise exception 'unauthorized'; end if;
  update xhs_patrol_jobs set status=case when p_error is null then 'completed' else 'failed' end, result=p_result, error=p_error, completed_at=now() where id=p_job_id and status='claimed';
end $$;

create or replace function public.complete_xhs_patrol_job_b64(p_device_id text, p_secret text, p_job_id uuid, p_result_base64 text, p_error text default null)
returns void language plpgsql security definer set search_path=public,extensions as $$
declare v_result jsonb;
begin
  if not exists (select 1 from xhs_patrol_devices where id=p_device_id and enabled and secret_hash=encode(digest(p_secret,'sha256'),'hex')) then raise exception 'unauthorized'; end if;
  v_result := case when p_result_base64 is null or p_result_base64='' then null else convert_from(decode(p_result_base64,'base64'),'utf8')::jsonb end;
  update xhs_patrol_jobs set status=case when p_error is null then 'completed' else 'failed' end, result=v_result, error=p_error, completed_at=now() where id=p_job_id and status='claimed';
end $$;

revoke all on function public.claim_xhs_patrol_job(text,text) from public;
revoke all on function public.complete_xhs_patrol_job(text,text,uuid,jsonb,text) from public;
grant execute on function public.claim_xhs_patrol_job(text,text) to anon, authenticated, service_role;
grant execute on function public.complete_xhs_patrol_job(text,text,uuid,jsonb,text) to anon, authenticated, service_role;
revoke all on function public.complete_xhs_patrol_job_b64(text,text,uuid,text,text) from public;
grant execute on function public.complete_xhs_patrol_job_b64(text,text,uuid,text,text) to anon, authenticated, service_role;
