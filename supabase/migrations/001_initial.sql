-- Biblioteca de Musculação · PostgreSQL 15+ / Supabase.
-- Run once as project owner. Application writes come only from the Worker.
begin;

create schema if not exists extensions;
create extension if not exists unaccent with schema extensions;
create extension if not exists pg_trgm with schema extensions;

create function public.normalize_search(input text) returns text
language sql immutable strict parallel safe set search_path = ''
as $$ select lower(extensions.unaccent('extensions.unaccent', input)) $$;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete restrict,
  display_name text not null default '' check (length(display_name) <= 100),
  role text not null default 'user' check (role in ('user','admin')),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- Never trust role/enabled in raw_user_meta_data: all signups are ordinary users.
  insert into public.profiles(id, display_name)
  values (new.id, left(coalesce(new.raw_user_meta_data->>'display_name',''),100));
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
for each row execute function public.handle_new_user();

create table public.memberships (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete restrict,
  status text not null default 'active' check (status in ('active','cancelled')),
  starts_at timestamptz not null default now(),
  expires_at timestamptz,
  granted_by uuid not null references public.profiles(id) on delete restrict,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at is null or expires_at > starts_at)
);
create index memberships_access_idx on public.memberships(user_id,status,expires_at);

create table public.payment_orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete restrict,
  amount_cents integer not null check (amount_cents > 0 and amount_cents <= 10000000),
  currency text not null default 'BRL' check (currency = 'BRL'),
  period_days integer not null check (period_days between 1 and 366),
  plan_title text not null default 'Acesso à biblioteca',
  status text not null default 'pending'
    check (status in ('pending','in_process','approved','rejected','cancelled','refunded','charged_back')),
  provider_preference_id text unique,
  provider_payment_id text unique,
  last_provider_updated_at timestamptz,
  last_reconciled_at timestamptz,
  paid_at timestamptz,
  access_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index payment_orders_reconcile_idx on public.payment_orders(status,updated_at);

create function public.claim_reconciliation_orders(p_limit integer default 5)
returns jsonb language sql volatile security definer set search_path = '' as $$
  with candidates as (
    select id from public.payment_orders
    where status in ('pending','in_process','approved')
      and (provider_payment_id is not null or created_at>now()-interval '7 days')
    order by last_reconciled_at nulls first,created_at,id
    limit greatest(1,least(coalesce(p_limit,5),5)) for update skip locked
  ), claimed as (
    update public.payment_orders o set last_reconciled_at=now()
    from candidates c where o.id=c.id returning o.*
  ) select coalesce(jsonb_agg(to_jsonb(claimed)),'[]'::jsonb) from claimed
$$;

create table public.payment_attempts (
  provider_payment_id text primary key,
  order_id uuid not null references public.payment_orders(id) on delete restrict,
  status text not null check (status in ('pending','in_process','approved','rejected','cancelled','refunded','charged_back')),
  last_provider_updated_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index payment_attempts_order_idx on public.payment_attempts(order_id);

create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete restrict,
  order_id uuid unique references public.payment_orders(id) on delete restrict,
  provider_subscription_id text unique,
  status text not null check (status in ('active','cancelled','expired','refunded','charged_back')),
  period_start timestamptz not null,
  period_end timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (period_end > period_start)
);
create index subscriptions_access_idx on public.subscriptions(user_id,status,period_end);

create function public.create_payment_order(p_user_id uuid,p_amount_cents integer,p_period_days integer,p_plan_title text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare ord public.payment_orders%rowtype;
begin
  if p_user_id is null or p_amount_cents is null or p_amount_cents not between 1 and 10000000
    or p_period_days is null or p_period_days not between 1 and 366
    or p_plan_title is null or length(p_plan_title) not between 1 and 180 then
    raise exception 'Invalid order' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text,0));
  if not exists (select 1 from public.profiles p join auth.users u on u.id=p.id
    where p.id=p_user_id and p.enabled and u.email_confirmed_at is not null) then
    raise exception 'Account unavailable' using errcode='42501';
  end if;
  if exists (select 1 from public.subscriptions s where s.user_id=p_user_id
    and s.status in ('active','cancelled') and s.period_end>now()) then
    raise exception 'Paid term already active' using errcode='22023';
  end if;
  -- Reuse the server-side price/period snapshot for 24h, including simultaneous clicks.
  select * into ord from public.payment_orders where user_id=p_user_id
    and status in ('pending','in_process') and created_at>now()-interval '24 hours'
    order by created_at desc limit 1 for update;
  if not found then
    insert into public.payment_orders(user_id,amount_cents,currency,period_days,plan_title)
    values (p_user_id,p_amount_cents,'BRL',p_period_days,p_plan_title) returning * into ord;
  end if;
  return to_jsonb(ord);
end $$;

create function public.has_access(p_user_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles p
    where p.id = p_user_id and p.enabled
      and exists (select 1 from auth.users u where u.id=p.id and u.email_confirmed_at is not null)
      and (
        p.role = 'admin'
        or exists (select 1 from public.memberships m where m.user_id=p.id
          and m.status='active' and m.starts_at <= now() and (m.expires_at is null or m.expires_at>now()))
        or exists (select 1 from public.subscriptions s where s.user_id=p.id
          and s.status in ('active','cancelled') and s.period_start <= now() and s.period_end>now())
      )
  )
$$;

create table public.videos (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(title) between 1 and 180),
  exercise text not null default '' check (length(exercise) <= 180),
  description text not null default '' check (length(description) <= 10000),
  difficulty text not null default 'beginner' check (difficulty in ('beginner','intermediate','advanced')),
  duration_seconds integer not null default 0 check (duration_seconds between 0 and 7200),
  status text not null default 'draft' check (status in ('draft','processing','ready','failed')),
  published boolean not null default false,
  bunny_video_id text unique,
  thumbnail_url text,
  thumbnail_storage_path text,
  keywords text[] not null default '{}',
  search_text text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (not published or (status = 'ready' and bunny_video_id is not null))
);
create index videos_search_trgm_idx on public.videos using gin (search_text extensions.gin_trgm_ops);
create index videos_catalog_idx on public.videos(id) where published and status='ready';
create function public.update_video_search() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.search_text := public.normalize_search(new.title || ' ' || new.exercise || ' ' || new.description || ' ' || array_to_string(new.keywords,' '));
  new.updated_at := now();
  return new;
end $$;
create trigger video_search before insert or update on public.videos
for each row execute function public.update_video_search();

create table public.taxonomies (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('muscle','category','equipment')),
  name text not null check (length(name) between 1 and 100),
  slug text not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  unique(kind,slug)
);
create table public.video_taxonomies (
  video_id uuid not null references public.videos(id) on delete cascade,
  taxonomy_id uuid not null references public.taxonomies(id) on delete restrict,
  primary key(video_id,taxonomy_id)
);
create index video_taxonomies_reverse_idx on public.video_taxonomies(taxonomy_id,video_id);
create table public.favorites (
  user_id uuid not null references public.profiles(id) on delete cascade,
  video_id uuid not null references public.videos(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key(user_id,video_id)
);

create table public.materials (
  id uuid primary key default gen_random_uuid(),
  video_id uuid references public.videos(id) on delete restrict,
  title text not null check (length(title) between 1 and 180),
  storage_path text not null unique check (storage_path !~ '(^/|\.\.)'),
  mime_type text not null check (mime_type = 'application/pdf'),
  size_bytes integer not null check (size_bytes between 1 and 10485760),
  published boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.settings (
  key text primary key check (key in ('public','plan','legal')),
  value jsonb not null check (jsonb_typeof(value) = 'object'),
  updated_at timestamptz not null default now()
);
insert into public.settings(key,value) values
 ('public','{"instagram_url":"","whatsapp_number":"","banner_title":"","banner_text":"","banner_url":""}'),
 ('plan','{"enabled":false,"amount_cents":0,"currency":"BRL","period_days":30,"title":"Acesso à biblioteca"}'),
 ('legal','{"approved":false,"cancellation_approved":false,"privacy_approved":false,"terms_approved":false}');

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.profiles(id) on delete restrict,
  action text not null check (length(action) between 1 and 100),
  target_type text not null check (length(target_type) between 1 and 100),
  target_id text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index audit_logs_created_idx on public.audit_logs(created_at);

create table public.payment_events (
  id uuid primary key default gen_random_uuid(),
  provider_event_id text not null unique check (length(provider_event_id) between 1 and 250),
  order_id uuid not null references public.payment_orders(id) on delete restrict,
  provider_payment_id text not null,
  status text not null,
  provider_updated_at timestamptz not null,
  outcome text not null default 'received',
  created_at timestamptz not null default now()
);

create function public.process_payment(
  p_order_id uuid, p_provider_payment_id text, p_status text,
  p_provider_updated_at timestamptz, p_event_id text,
  p_amount_cents integer, p_currency text, p_approved_at timestamptz default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  ord public.payment_orders%rowtype;
  attempt public.payment_attempts%rowtype;
  event_row uuid;
  final_status text;
begin
  if p_status is null or p_status not in ('pending','in_process','approved','rejected','cancelled','refunded','charged_back')
    or p_provider_updated_at is null or p_provider_payment_id is null or length(p_provider_payment_id)=0
    or p_event_id is null or length(p_event_id) not between 1 and 250 then
    raise exception 'Invalid payment event' using errcode='22023';
  end if;
  select * into ord from public.payment_orders where id=p_order_id;
  if not found then raise exception 'Unknown order' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended(ord.user_id::text,0));
  select * into ord from public.payment_orders where id=p_order_id for update;
  if p_status='approved' and (p_approved_at is null or not isfinite(p_approved_at)
    or not isfinite(p_provider_updated_at) or p_approved_at>p_provider_updated_at
    or p_approved_at>now()+interval '5 minutes' or p_approved_at<ord.created_at-interval '5 minutes') then
    raise exception 'Invalid payment approval date' using errcode='22023';
  end if;
  if p_amount_cents is distinct from ord.amount_cents or p_currency is distinct from ord.currency then
    raise exception 'Payment value mismatch' using errcode='22023';
  end if;
  if ord.provider_payment_id is not null and ord.provider_payment_id <> p_provider_payment_id
    and ord.status in ('approved','refunded','charged_back') then
    raise exception 'Payment already bound to another provider payment' using errcode='22023';
  end if;
  insert into public.payment_events(provider_event_id,order_id,provider_payment_id,status,provider_updated_at)
  values (p_event_id,p_order_id,p_provider_payment_id,p_status,p_provider_updated_at)
  on conflict(provider_event_id) do nothing returning id into event_row;
  if event_row is null then
    return jsonb_build_object('processed',false,'reason','duplicate','order_id',ord.id,'status',ord.status,'access_until',ord.access_until);
  end if;
  select * into attempt from public.payment_attempts where provider_payment_id=p_provider_payment_id for update;
  if found and attempt.order_id<>p_order_id then
    raise exception 'Payment belongs to another order' using errcode='22023';
  end if;
  if found and p_provider_updated_at<attempt.last_provider_updated_at then
    update public.payment_events set outcome='stale' where id=event_row;
    return jsonb_build_object('processed',false,'reason','stale','order_id',ord.id,'status',ord.status,'access_until',ord.access_until);
  end if;
  if attempt.status in ('refunded','charged_back') and p_status not in ('refunded','charged_back') then
    update public.payment_events set outcome='terminal' where id=event_row;
    return jsonb_build_object('processed',false,'reason','terminal','order_id',ord.id,'status',ord.status,'access_until',ord.access_until);
  end if;
  -- Reversals are terminal. A delayed/replayed approval cannot resurrect access.
  if ord.status in ('refunded','charged_back') and p_status not in ('refunded','charged_back') then
    update public.payment_events set outcome='terminal' where id=event_row;
    return jsonb_build_object('processed',false,'reason','terminal','order_id',ord.id,'status',ord.status,'access_until',null);
  end if;
  -- Equal-time pending/declined events must not regress an approval. Reversals win.
  if ord.status='approved' and p_status not in ('approved','refunded','charged_back') then
    update public.payment_events set outcome='non_regression' where id=event_row;
    return jsonb_build_object('processed',false,'reason','non_regression','order_id',ord.id,'status',ord.status,'access_until',ord.access_until);
  end if;
  insert into public.payment_attempts(provider_payment_id,order_id,status,last_provider_updated_at)
    values(p_provider_payment_id,p_order_id,p_status,p_provider_updated_at)
    on conflict(provider_payment_id) do update set status=excluded.status,last_provider_updated_at=excluded.last_provider_updated_at
      where public.payment_attempts.order_id=excluded.order_id
    returning * into attempt;
  if not found then raise exception 'Payment belongs to another order' using errcode='22023'; end if;
  -- Compare time per attempt. A newer rejection on B must not hide an approval on A.
  if p_status not in ('approved','refunded','charged_back') and ord.last_provider_updated_at is not null
    and p_provider_updated_at<ord.last_provider_updated_at then
    update public.payment_events set outcome='stale_order' where id=event_row;
    return jsonb_build_object('processed',false,'reason','stale','order_id',ord.id,'status',ord.status,'access_until',ord.access_until);
  end if;
  final_status := p_status;
  if final_status='approved' then
    if ord.paid_at is null then
      ord.paid_at := p_approved_at;
      ord.access_until := ord.paid_at + make_interval(days=>ord.period_days);
    end if;
    insert into public.subscriptions(user_id,order_id,status,period_start,period_end)
    values (ord.user_id,ord.id,'active',ord.paid_at,ord.access_until)
    on conflict(order_id) do update set status='active',updated_at=now();
  elsif final_status in ('refunded','charged_back') then
    update public.subscriptions set status=final_status,updated_at=now() where order_id=ord.id;
    ord.access_until := null;
  end if;
  update public.payment_orders set status=final_status,provider_payment_id=p_provider_payment_id,
    last_provider_updated_at=greatest(ord.last_provider_updated_at,p_provider_updated_at),paid_at=ord.paid_at,access_until=ord.access_until,updated_at=now()
    where id=ord.id;
  update public.payment_events set outcome='applied' where id=event_row;
  insert into public.audit_logs(action,target_type,target_id,metadata)
  values ('payment.'||final_status,'payment_order',ord.id::text,
    jsonb_build_object('previous_status',ord.status,'status',final_status,'provider_payment_id',p_provider_payment_id));
  return jsonb_build_object('processed',true,'reason','applied','order_id',ord.id,'status',final_status,'access_until',ord.access_until);
end $$;

create function public.catalog_search(
  p_query text default '',p_difficulty text default null,p_muscle text default null,
  p_category text default null,p_equipment text default null,p_cursor uuid default null,p_limit integer default 24
) returns jsonb language sql stable security definer set search_path = '' as $$
  with filtered as (
    select v.id,v.title,v.exercise,v.description,v.difficulty,v.duration_seconds,v.thumbnail_url,v.keywords,
      coalesce((select jsonb_agg(jsonb_build_object('id',t.id,'kind',t.kind,'name',t.name,'slug',t.slug) order by t.kind,t.name)
        from public.video_taxonomies vt join public.taxonomies t on t.id=vt.taxonomy_id where vt.video_id=v.id),'[]') as taxonomies
    from public.videos v
    where v.published and v.status='ready' and (p_cursor is null or v.id>p_cursor)
      and (nullif(p_difficulty,'') is null or v.difficulty=p_difficulty)
      and (nullif(trim(p_query),'') is null or not exists (
        select 1 from regexp_split_to_table(public.normalize_search(trim(p_query)),'[[:space:]]+') as q(term)
        where v.search_text not like '%'||replace(replace(replace(q.term,'\','\\'),'%','\%'),'_','\_')||'%' escape '\'))
      and (nullif(p_muscle,'') is null or exists (select 1 from public.video_taxonomies vt join public.taxonomies t on t.id=vt.taxonomy_id where vt.video_id=v.id and t.kind='muscle' and t.slug=p_muscle))
      and (nullif(p_category,'') is null or exists (select 1 from public.video_taxonomies vt join public.taxonomies t on t.id=vt.taxonomy_id where vt.video_id=v.id and t.kind='category' and t.slug=p_category))
      and (nullif(p_equipment,'') is null or exists (select 1 from public.video_taxonomies vt join public.taxonomies t on t.id=vt.taxonomy_id where vt.video_id=v.id and t.kind='equipment' and t.slug=p_equipment))
    order by v.id limit greatest(1,least(coalesce(p_limit,24),48))+1
  ), page as (select * from filtered order by id limit greatest(1,least(coalesce(p_limit,24),48)))
  select jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(p) order by p.id) from page p),'[]'),
    'next_cursor',case when (select count(*) from filtered)>greatest(1,least(coalesce(p_limit,24),48))
      then (select id from page order by id desc limit 1) else null end)
$$;

create function public.replace_video_taxonomies(p_video_id uuid,p_taxonomy_ids uuid[])
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.videos where id=p_video_id for update;
  if not found then raise exception 'Video not found'; end if;
  delete from public.video_taxonomies where video_id=p_video_id;
  insert into public.video_taxonomies(video_id,taxonomy_id)
  select p_video_id,unnest(coalesce(p_taxonomy_ids,'{}')) on conflict do nothing;
end $$;

create table public.rate_limits (
  key_hash text not null check (key_hash ~ '^[a-f0-9]{64}$'),
  window_start timestamptz not null,
  hits integer not null default 1,
  expires_at timestamptz not null,
  primary key(key_hash,window_start)
);
create index rate_limits_expiry_idx on public.rate_limits(expires_at);
create function public.rate_limit(p_key_hash text,p_limit integer,p_window_seconds integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare window_at timestamptz; hit_count integer; expires timestamptz;
begin
  if p_limit not between 1 and 10000 or p_window_seconds not between 1 and 86400
    or p_key_hash is null or p_key_hash !~ '^[a-f0-9]{64}$' then raise exception 'Invalid rate limit'; end if;
  window_at := to_timestamp(floor(extract(epoch from now())/p_window_seconds)*p_window_seconds);
  expires := window_at + make_interval(secs=>p_window_seconds);
  insert into public.rate_limits(key_hash,window_start,hits,expires_at) values(p_key_hash,window_at,1,expires)
  on conflict(key_hash,window_start) do update set hits=public.rate_limits.hits+1 returning hits into hit_count;
  delete from public.rate_limits where expires_at < now()-interval '1 day';
  return jsonb_build_object('allowed',hit_count<=p_limit,'remaining',greatest(p_limit-hit_count,0),
    'retry_after',greatest(1,ceil(extract(epoch from expires-now()))::integer));
end $$;

-- RLS provides a second boundary. No browser writes to privileged tables or RPCs.
alter table public.profiles enable row level security;
create policy profile_self_read on public.profiles for select to authenticated using (id=(select auth.uid()));
alter table public.favorites enable row level security;
create policy favorites_self_read on public.favorites for select to authenticated using (user_id=(select auth.uid()));
alter table public.memberships enable row level security;
alter table public.subscriptions enable row level security;
alter table public.payment_orders enable row level security;
alter table public.payment_attempts enable row level security;
alter table public.payment_events enable row level security;
alter table public.videos enable row level security;
alter table public.taxonomies enable row level security;
alter table public.video_taxonomies enable row level security;
alter table public.materials enable row level security;
alter table public.settings enable row level security;
alter table public.audit_logs enable row level security;
alter table public.rate_limits enable row level security;

revoke all on all tables in schema public from anon,authenticated;
grant select on public.profiles,public.favorites to authenticated;
grant select,insert,update,delete on all tables in schema public to service_role;
revoke update,delete on public.audit_logs,public.payment_events from service_role;
revoke insert,update,delete on public.payment_attempts from service_role;
-- process_payment is SECURITY DEFINER and can set ledger outcome; service cannot rewrite history.
revoke all on function public.handle_new_user() from public,anon,authenticated;
revoke all on function public.update_video_search() from public,anon,authenticated;
revoke all on function public.has_access(uuid) from public,anon,authenticated;
revoke all on function public.process_payment(uuid,text,text,timestamptz,text,integer,text,timestamptz) from public,anon,authenticated;
revoke all on function public.create_payment_order(uuid,integer,integer,text) from public,anon,authenticated;
revoke all on function public.claim_reconciliation_orders(integer) from public,anon,authenticated;
revoke all on function public.catalog_search(text,text,text,text,text,uuid,integer) from public,anon,authenticated;
revoke all on function public.replace_video_taxonomies(uuid,uuid[]) from public,anon,authenticated;
revoke all on function public.rate_limit(text,integer,integer) from public,anon,authenticated;
grant execute on function public.has_access(uuid),public.process_payment(uuid,text,text,timestamptz,text,integer,text,timestamptz),public.create_payment_order(uuid,integer,integer,text),public.claim_reconciliation_orders(integer),
  public.catalog_search(text,text,text,text,text,uuid,integer),public.replace_video_taxonomies(uuid,uuid[]),
  public.rate_limit(text,integer,integer) to service_role;
alter default privileges in schema public revoke all on tables from anon,authenticated;
alter default privileges in schema public revoke execute on functions from public,anon,authenticated;

-- Private supporting files. There are deliberately no browser storage policies.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('materials','materials',false,10485760,array['application/pdf']),
       ('thumbnails','thumbnails',true,5242880,array['image/jpeg','image/png','image/webp'])
on conflict(id) do nothing;

comment on table public.memberships is 'Free grants; cancelling a grant never alters paid access.';
comment on table public.subscriptions is 'One paid entitlement per order; overlap never extends a payment twice.';
comment on table public.payment_events is 'Idempotency ledger containing minimal verified provider data, no card data.';
comment on function public.has_access(uuid) is 'Service-only: enabled AND verified email AND (admin OR valid grant OR valid paid period).';
commit;
