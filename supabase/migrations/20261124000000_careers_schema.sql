-- PaperLive Careers: schema, security rules, resume storage
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ───────── Admins (placement team) ─────────
create table public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  created_at timestamptz not null default now()
);
alter table public.admins enable row level security;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where user_id = (select auth.uid()));
$$;
revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to anon, authenticated;

create policy "admins read admins" on public.admins for select to authenticated using (public.is_admin());

-- ───────── Settings ─────────
create table public.settings (
  id int primary key default 1 check (id = 1),
  auto_publish boolean not null default true,       -- JDs captured by AI go live without review
  default_window_hours int not null default 20,     -- time candidates get to apply
  outreach_enabled boolean not null default true,   -- email HR of new leads automatically
  role_keywords text[] not null default array['devops','multi-cloud','multicloud','sre','site reliability','platform engineer','cloud engineer','kubernetes','aws','azure','gcp'],
  outreach_subject text not null default 'Placement partnership: pre-screened DevOps & Cloud candidates from PaperLive Learning',
  outreach_body text not null default 'Hi {hr_name},

I saw that {company} is hiring for {role}. PaperLive Learning trains and places DevOps, multi-cloud and SRE engineers, and we can share pre-screened profiles matched to your experience range within 24 hours, at no cost to you.

If this role is still open, just reply to this email with the JD (attachment or text is fine) and we will send you matching resumes.

Regards,
Placement Team, PaperLive Learning
https://paperlive.in',
  updated_at timestamptz not null default now()
);
insert into public.settings (id) values (1);
alter table public.settings enable row level security;
create policy "admins manage settings" on public.settings for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ───────── Leads (companies hiring) ─────────
create table public.leads (
  id uuid primary key default gen_random_uuid(),
  company text not null,
  role text not null,
  location text,
  source text not null default 'manual' check (source in ('linkedin_alert','manual','email')),
  source_url text,
  hr_name text,
  hr_email text,
  status text not null default 'new' check (status in ('new','needs_contact','contacted','jd_received','not_interested','closed')),
  contacted_at timestamptz,
  gmail_thread_id text,
  notes text,
  sheet_synced boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index leads_dedupe on public.leads (lower(company), lower(role), coalesce(source_url,''));
create index leads_status on public.leads (status);
alter table public.leads enable row level security;
create policy "admins manage leads" on public.leads for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ───────── Jobs (public-safe columns only) ─────────
create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid references public.leads(id) on delete set null,
  company text not null,
  role text not null,
  skills text[] not null default '{}',
  exp_min numeric not null default 0,
  exp_max numeric not null default 50,
  package_text text,
  package_min_lpa numeric,
  package_max_lpa numeric,
  location text,
  work_mode text check (work_mode in ('Onsite','Hybrid','Remote')),
  description text,
  status text not null default 'draft' check (status in ('draft','live','closed')),
  deadline timestamptz,
  posted_at timestamptz,
  created_at timestamptz not null default now(),
  check (exp_max >= exp_min)
);
create index jobs_live on public.jobs (status, deadline);
create index jobs_lead on public.jobs (lead_id);
alter table public.jobs enable row level security;
create policy "public reads live jobs" on public.jobs for select to anon, authenticated
  using (status = 'live' and deadline > now());
create policy "admins manage jobs" on public.jobs for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- Admin-only pipeline data for each job (never visible to candidates)
create table public.job_pipeline (
  job_id uuid primary key references public.jobs(id) on delete cascade,
  hr_email text,
  jd_received_at timestamptz,
  jd_source text,                -- 'email' | 'manual'
  notified_at timestamptz,
  notified_count int not null default 0,
  sent_to_hr_at timestamptz,
  sent_count int not null default 0,
  interviews int not null default 0,
  offers int not null default 0,
  notes text
);
alter table public.job_pipeline enable row level security;
create policy "admins manage pipeline" on public.job_pipeline for all to authenticated using (public.is_admin()) with check (public.is_admin());

create or replace function public.jobs_after_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.job_pipeline (job_id, jd_received_at, jd_source) values (new.id, now(), 'manual')
  on conflict (job_id) do nothing;
  return new;
end $$;
create trigger jobs_after_insert after insert on public.jobs for each row execute function public.jobs_after_insert();

create or replace function public.jobs_before_write() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.status = 'live' and (tg_op = 'INSERT' or old.status <> 'live') then
    new.posted_at := coalesce(new.posted_at, now());
    if new.deadline is null then
      new.deadline := now() + make_interval(hours => (select default_window_hours from public.settings where id = 1));
    end if;
  end if;
  return new;
end $$;
create trigger jobs_before_write before insert or update on public.jobs for each row execute function public.jobs_before_write();

-- ───────── Candidates ─────────
create table public.candidates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique references auth.users(id) on delete set null,
  name text,
  email text not null,
  phone text,
  exp numeric,
  skills text,
  current_location text,
  resume_path text,
  alerts boolean not null default true,
  source text not null default 'self' check (source in ('self','team')),
  created_at timestamptz not null default now()
);
create unique index candidates_email on public.candidates (lower(email));
alter table public.candidates enable row level security;
create policy "candidate reads own" on public.candidates for select to authenticated using (user_id = (select auth.uid()) or public.is_admin());
create policy "candidate updates own" on public.candidates for update to authenticated
  using (user_id = (select auth.uid()) or public.is_admin()) with check (user_id = (select auth.uid()) or public.is_admin());
create policy "admins insert/delete candidates" on public.candidates for insert to authenticated with check (public.is_admin());
create policy "admins delete candidates" on public.candidates for delete to authenticated using (public.is_admin());

-- Candidates cannot change who they are linked to
create or replace function public.candidates_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if not public.is_admin() and auth.role() = 'authenticated' then
    new.user_id := old.user_id; new.email := old.email; new.source := old.source;
  end if;
  return new;
end $$;
create trigger candidates_guard before update on public.candidates for each row execute function public.candidates_guard();

-- When someone signs up, link them to the row the team already added (same email) or create one
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.candidates set user_id = new.id where lower(email) = lower(new.email) and user_id is null;
  if not found then
    insert into public.candidates (user_id, email, source) values (new.id, new.email, 'self')
    on conflict do nothing;
  end if;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- ───────── Applications ─────────
create table public.applications (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  candidate_id uuid not null references public.candidates(id) on delete cascade,
  resume_path text,
  status text not null default 'applied' check (status in ('applied','sent_to_hr','interview','offer','rejected')),
  applied_at timestamptz not null default now(),
  unique (job_id, candidate_id)
);
create index applications_candidate on public.applications (candidate_id);
alter table public.applications enable row level security;
create policy "candidate reads own applications" on public.applications for select to authenticated
  using (public.is_admin() or candidate_id in (select id from public.candidates where user_id = (select auth.uid())));
create policy "candidate applies" on public.applications for insert to authenticated
  with check (candidate_id in (select id from public.candidates where user_id = (select auth.uid())));
create policy "admins manage applications" on public.applications for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admins delete applications" on public.applications for delete to authenticated using (public.is_admin());

-- Only eligible candidates, only while the job is open, resume required
create or replace function public.applications_check() returns trigger
language plpgsql security definer set search_path = public as $$
declare j public.jobs; c public.candidates;
begin
  select * into j from public.jobs where id = new.job_id;
  select * into c from public.candidates where id = new.candidate_id;
  if j.status <> 'live' or j.deadline <= now() then raise exception 'This opening is closed'; end if;
  if c.exp is null or c.exp < j.exp_min or c.exp > j.exp_max then
    raise exception 'This role needs % to % years of experience', j.exp_min, j.exp_max;
  end if;
  if coalesce(new.resume_path, c.resume_path) is null then raise exception 'Upload your resume before applying'; end if;
  new.resume_path := coalesce(new.resume_path, c.resume_path);
  new.status := 'applied';
  return new;
end $$;
create trigger applications_check before insert on public.applications for each row execute function public.applications_check();

-- ───────── Email log ─────────
create table public.email_log (
  id bigint generated always as identity primary key,
  kind text not null,          -- candidate_alert | hr_outreach | hr_resumes | admin_notice
  to_email text not null,
  subject text,
  job_id uuid references public.jobs(id) on delete set null,
  lead_id uuid references public.leads(id) on delete set null,
  ok boolean not null default true,
  error text,
  created_at timestamptz not null default now()
);
create index email_log_job on public.email_log (job_id, kind);
create index email_log_lead on public.email_log (lead_id);
alter table public.email_log enable row level security;
create policy "admins read email log" on public.email_log for select to authenticated using (public.is_admin());

-- Automation run history
create table public.automation_runs (
  id bigint generated always as identity primary key,
  started_at timestamptz not null default now(),
  summary jsonb,
  error text
);
alter table public.automation_runs enable row level security;
create policy "admins read runs" on public.automation_runs for select to authenticated using (public.is_admin());

-- ───────── Admin dashboard numbers ─────────
create or replace function public.admin_stats() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  return jsonb_build_object(
    'leads', (select count(*) from leads),
    'leads_week', (select count(*) from leads where created_at > now() - interval '7 days'),
    'contacted', (select count(*) from leads where contacted_at is not null),
    'jds', (select count(*) from jobs),
    'posted', (select count(*) from jobs where posted_at is not null),
    'live', (select count(*) from jobs where status = 'live' and deadline > now()),
    'candidates', (select count(*) from candidates),
    'active_candidates', (select count(*) from candidates where alerts and exp is not null),
    'applications', (select count(*) from applications),
    'sent_to_hr', (select coalesce(sum(sent_count),0) from job_pipeline),
    'interviews', (select coalesce(sum(interviews),0) from job_pipeline),
    'offers', (select coalesce(sum(offers),0) from job_pipeline),
    'emails_today', (select count(*) from email_log where created_at > now() - interval '1 day')
  );
end $$;
revoke all on function public.admin_stats() from public;
grant execute on function public.admin_stats() to authenticated;

-- Applicant counts per job for the admin tables
create or replace view public.job_overview with (security_invoker = true) as
select j.*, p.hr_email, p.jd_received_at, p.jd_source, p.notified_at, p.notified_count, p.sent_to_hr_at, p.sent_count,
       p.interviews, p.offers, p.notes as pipeline_notes,
       (select count(*) from public.applications a where a.job_id = j.id) as applicants,
       (select count(*) from public.candidates c where c.alerts and c.exp between j.exp_min and j.exp_max) as eligible
from public.jobs j left join public.job_pipeline p on p.job_id = j.id;

-- ───────── Resume storage ─────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('resumes', 'resumes', false, 5242880, array['application/pdf','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
on conflict (id) do nothing;

create policy "candidate uploads own resume" on storage.objects for insert to authenticated
  with check (bucket_id = 'resumes' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "candidate updates own resume" on storage.objects for update to authenticated
  using (bucket_id = 'resumes' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "candidate or admin reads resume" on storage.objects for select to authenticated
  using (bucket_id = 'resumes' and ((storage.foldername(name))[1] = (select auth.uid())::text or public.is_admin()));
create policy "admin manages resumes" on storage.objects for all to authenticated
  using (bucket_id = 'resumes' and public.is_admin()) with check (bucket_id = 'resumes' and public.is_admin());
