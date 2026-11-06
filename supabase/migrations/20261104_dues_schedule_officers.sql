begin;
alter table public.chapter_settings add column dues_start_month date;
alter table public.profiles add column dues_start_month date;
-- NULL means no schedule yet; existing historical payments are never deleted.
alter table public.chapter_settings add constraint portal_chapter_start_month check (dues_start_month = date_trunc('month',dues_start_month)::date);
alter table public.profiles add constraint portal_member_start_month check (dues_start_month = date_trunc('month',dues_start_month)::date);

create table public.chapter_officers (
  position text primary key check(position in ('GT','DGT','MWW','DMWW','MKS','MKC','AUDITOR')),
  display_name text not null check(length(trim(display_name)) between 2 and 120),
  member_id uuid unique references public.profiles(id) on delete set null,
  sort_order integer not null unique,
  updated_at timestamptz not null default now()
);
insert into public.chapter_officers(position,display_name,sort_order) values
('GT','Juffel D. Villaruel',1),('DGT','Jericho Lavictoria',2),
('MWW','Elthon John Balboa',3),('DMWW','Mark John Boron',4),
('MKS','Jhen Lavictoria',5),('MKC','Jay Lara',6),('AUDITOR','Jerson Obera',7);
alter table public.chapter_officers enable row level security;
revoke all on public.chapter_officers from public,anon,authenticated;
grant select(position,display_name,sort_order,updated_at) on public.chapter_officers to anon;
grant select on public.chapter_officers to authenticated;
create policy portal_public_officers on public.chapter_officers for select using(true);

create function public.portal_save_officers(p_officers jsonb)
returns void language plpgsql security definer set search_path=''
as $$ declare v_row jsonb; v_id uuid; v_name text; v_code text;
begin
  if not portal_private.is_active_portal_admin() then raise exception 'Active administrator required'; end if;
  if jsonb_typeof(p_officers) is distinct from 'array' or jsonb_array_length(p_officers) <> 7 then raise exception 'Provide all seven officer positions'; end if;
  if (select count(distinct x->>'position') from jsonb_array_elements(p_officers) x)<>7 then raise exception 'Officer positions must be unique'; end if;
  -- Lock the roster so elections update all seven positions atomically.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('portal-officers',0));
  -- Clear old links first so swapping two officers is supported.
  update public.profiles set chapter_position='Member' where id in(select member_id from public.chapter_officers where member_id is not null);
  update public.chapter_officers set member_id=null;
  for v_row in select value from jsonb_array_elements(p_officers) loop
    v_code=v_row->>'position'; v_name=trim(v_row->>'display_name'); v_id=nullif(v_row->>'member_id','')::uuid;
    if v_code is null or v_code not in ('GT','DGT','MWW','DMWW','MKS','MKC','AUDITOR') or v_name is null or length(v_name) not between 2 and 120 then raise exception 'Invalid officer details'; end if;
    if v_id is not null and not exists(select 1 from public.profiles where id=v_id and is_active) then raise exception 'Select an active chapter account'; end if;
    update public.chapter_officers set display_name=v_name,member_id=v_id,updated_at=now() where position=v_code;
    if v_id is not null then update public.profiles set chapter_position=v_code where id=v_id; end if;
  end loop;
end; $$;
alter function public.portal_save_officers(jsonb) owner to postgres;
revoke all on function public.portal_save_officers(jsonb) from public,anon;
grant execute on function public.portal_save_officers(jsonb) to authenticated;

create function public.portal_set_dues_start(p_start_month date,p_member_id uuid default null)
returns void language plpgsql security definer set search_path=''
as $$ begin
  if not portal_private.is_active_portal_admin() then raise exception 'Active administrator required'; end if;
  if p_start_month is not null and p_start_month <> date_trunc('month',p_start_month)::date then raise exception 'Choose the first day of a month'; end if;
  if p_member_id is null then
    update public.chapter_settings set dues_start_month=p_start_month,updated_by=auth.uid(),updated_at=now() where id=true;
  else
    update public.profiles set dues_start_month=p_start_month where id=p_member_id and role='member';
    if not found then raise exception 'Member account not found'; end if;
  end if;
end; $$;
alter function public.portal_set_dues_start(date,uuid) owner to postgres;
revoke all on function public.portal_set_dues_start(date,uuid) from public,anon;
grant execute on function public.portal_set_dues_start(date,uuid) to authenticated;

-- Enforce the start on the server for both member submissions and admin payments.
create function portal_private.enforce_dues_start()
returns trigger language plpgsql security definer set search_path=''
as $$ declare v_start date;
begin
  select coalesce(p.dues_start_month,s.dues_start_month) into v_start
    from public.profiles p cross join public.chapter_settings s where p.id=new.member_id and s.id=true;
  if v_start is null or new.month < v_start then raise exception 'Monthly dues have not started for this member in that month'; end if;
  return new;
end; $$;
alter function portal_private.enforce_dues_start() owner to postgres;
revoke all on function portal_private.enforce_dues_start() from public;
create trigger portal_check_dues_start before insert or update of member_id,month,amount,proof_path on public.monthly_dues
for each row execute function portal_private.enforce_dues_start();
commit;
