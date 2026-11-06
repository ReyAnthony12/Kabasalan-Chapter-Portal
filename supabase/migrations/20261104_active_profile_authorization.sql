-- Require current database authorization as well as trusted token metadata.
-- Apply as the privileged Supabase migration role (postgres).
begin;

create schema if not exists portal_private;

create function portal_private.is_active_portal_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    coalesce(
      ((select auth.jwt()) -> 'app_metadata' ->> 'chapter_role') = 'admin',
      false
    )
    and exists (
      select 1
      from public.profiles as profile
      where profile.id = (select auth.uid())
        and profile.role = 'admin'
        and profile.is_active is true
    );
$$;

-- This owner bypasses profiles RLS, avoiding a recursive policy evaluation.
alter function portal_private.is_active_portal_admin() owner to postgres;
revoke all on function portal_private.is_active_portal_admin() from public;
grant usage on schema portal_private to authenticated;
grant execute on function portal_private.is_active_portal_admin() to authenticated;

drop policy portal_profiles_read on public.profiles;
create policy portal_profiles_read
on public.profiles
for select
to authenticated
using (
  id = (select auth.uid())
  or (select portal_private.is_active_portal_admin())
);

commit;
