begin;

-- Mark first so a provider failure cannot leave the video visible or republish it.
-- Retain the row for legacy references and the administrative audit trail.
alter table public.videos add column deleted_at timestamptz;
alter table public.videos add constraint videos_deleted_unpublished_check
  check (deleted_at is null or not published);

commit;
