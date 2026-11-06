-- Expose only the total; member profiles remain private.
begin;
create or replace function public.portal_public_member_count()
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select count(*) from public.profiles p
  inner join auth.users u on u.id = p.id
  where p.role = 'member';
$$;
alter function public.portal_public_member_count() owner to postgres;
revoke all on function public.portal_public_member_count() from public;
grant execute on function public.portal_public_member_count() to anon, authenticated;
commit;
