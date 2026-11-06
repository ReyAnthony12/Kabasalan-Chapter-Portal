begin;
alter table public.profiles add column dues_active boolean not null default true;
create function public.portal_set_member_dues_active(p_member_id uuid,p_active boolean)
returns void language plpgsql security definer set search_path=''
as $$ begin
  if not portal_private.is_active_portal_admin() then raise exception 'Active administrator required'; end if;
  if p_active is null then raise exception 'Choose active or inactive'; end if;
  update public.profiles set dues_active=p_active where id=p_member_id and role='member';
  if not found then raise exception 'Member account not found'; end if;
end; $$;
alter function public.portal_set_member_dues_active(uuid,boolean) owner to postgres;
revoke all on function public.portal_set_member_dues_active(uuid,boolean) from public,anon;
grant execute on function public.portal_set_member_dues_active(uuid,boolean) to authenticated;
create function portal_private.enforce_dues_active()
returns trigger language plpgsql security definer set search_path=''
as $$ begin
  perform 1 from public.profiles where id=new.member_id and dues_active for share;
  if not found then raise exception 'Monthly dues are inactive for this member'; end if;
  return new;
end; $$;
alter function portal_private.enforce_dues_active() owner to postgres;
revoke all on function portal_private.enforce_dues_active() from public;
create trigger portal_check_dues_active before insert or update of member_id,month,amount,proof_path on public.monthly_dues
for each row execute function portal_private.enforce_dues_active();
commit;
