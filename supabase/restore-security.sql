-- Apply after a reviewed full logical restore into a dedicated EMPTY Supabase project.
-- The schema/data are already restored. This file does not restore content or grant admin roles.
begin;
alter default privileges in schema public revoke all on tables from anon,authenticated;
alter default privileges in schema public revoke execute on functions from public,anon,authenticated;
revoke all on all tables in schema public from anon,authenticated;
grant select on public.profiles,public.favorites to authenticated;
grant select,insert,update,delete on all tables in schema public to service_role;
revoke update,delete on public.audit_logs,public.payment_events from service_role;
revoke insert,update,delete on public.payment_attempts from service_role;
revoke all on function public.handle_new_user(),public.update_video_search(),public.has_access(uuid),
  public.process_payment(uuid,text,text,timestamptz,text,integer,text,timestamptz),
  public.create_payment_order(uuid,integer,integer,text),
  public.claim_reconciliation_orders(integer),
  public.catalog_search(text,text,text,text,text,uuid,integer),
  public.replace_video_taxonomies(uuid,uuid[]),public.rate_limit(text,integer,integer)
  from public,anon,authenticated;
grant execute on function public.has_access(uuid),public.process_payment(uuid,text,text,timestamptz,text,integer,text,timestamptz),public.create_payment_order(uuid,integer,integer,text),public.claim_reconciliation_orders(integer),
  public.catalog_search(text,text,text,text,text,uuid,integer),public.replace_video_taxonomies(uuid,uuid[]),
  public.rate_limit(text,integer,integer) to service_role;
alter table public.profiles enable row level security;
alter table public.favorites enable row level security;
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
create or replace trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();
update storage.buckets set public=false where id='materials';
commit;
