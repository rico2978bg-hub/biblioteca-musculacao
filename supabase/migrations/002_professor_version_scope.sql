begin;

-- Use the supplied contacts for untouched installations, preserving administrator edits.
update public.settings
set value = jsonb_set(
  jsonb_set(value, '{instagram_url}', to_jsonb(coalesce(nullif(value->>'instagram_url',''), 'https://www.instagram.com/seu_perfil/'))),
  '{whatsapp_number}', to_jsonb(coalesce(nullif(value->>'whatsapp_number',''), '5511900000000'))
), updated_at = now()
where key = 'public';

-- Preserve historical uploads but remove publication when the new duration rule is unmet.
-- The Worker checks the unrounded Bunny duration before publishing; this constraint is
-- another boundary for the stored integer value, never a limit on video/account count.
update public.videos set published = false
where published and (duration_seconds < 1 or duration_seconds > 180);

alter table public.videos add constraint videos_published_duration_check
check (not published or duration_seconds between 1 and 180);

-- This version has no supporting-material API/UI. Historical private data stays intact.
comment on table public.materials is 'Legacy supporting files, retained privately; no application routes in this version.';

commit;
