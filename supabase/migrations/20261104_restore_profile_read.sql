-- Restore profile reads required by portal login. RLS stays enabled.
-- Members read their own profile; trusted admins read chapter profiles.
begin;

create policy portal_profiles_read
on public.profiles
for select
to authenticated
using (
  id = (select auth.uid())
  or ((select auth.jwt()) -> 'app_metadata' ->> 'chapter_role') = 'admin'
);

commit;
