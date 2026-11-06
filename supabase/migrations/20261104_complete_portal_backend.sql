-- Apply after 20261104_active_profile_authorization.sql as postgres.
begin;

alter table public.chapter_settings
  add column payment_deadline text,
  add column accept_gcash boolean not null default true,
  add column accept_cash boolean not null default true,
  add column show_fund_ledger boolean not null default true,
  add column qr_path text,
  add column updated_by uuid references public.profiles(id),
  add column updated_at timestamptz not null default now();
update public.chapter_settings set payment_deadline = 'Day ' || deadline_day::text || ' of each month';
update public.chapter_settings set payment_deadline = 'Last day of each month' where payment_deadline is null;
alter table public.chapter_settings add constraint portal_positive_monthly_amount check (monthly_amount > 0),
  add constraint portal_deadline_length check (length(trim(payment_deadline)) between 1 and 512);
insert into public.chapter_settings(id, payment_deadline)
  values(true, 'Day 15 of each month') on conflict (id) do nothing;
alter table public.monthly_dues
  add column method text check (method in ('Cash', 'GCash')),
  add column paid_at timestamptz,
  add column reviewed_by uuid references public.profiles(id);
alter table public.fund_transactions
  add column kind text check (kind in ('income', 'expense')),
  add column purpose text,
  add column occurred_at timestamptz default now(),
  add column created_by uuid references public.profiles(id),
  add column receipt_path text,
  add column dues_id uuid unique references public.monthly_dues(id);
update public.fund_transactions set kind = type, purpose = description,
  created_by = recorded_by, occurred_at = created_at;

create function portal_private.is_active_portal_member()
returns boolean language sql stable security definer set search_path = ''
as $$ select exists (select 1 from public.profiles p
  where p.id = (select auth.uid()) and p.is_active is true
    and p.role in ('member', 'admin')
    and p.role = ((select auth.jwt()) -> 'app_metadata' ->> 'chapter_role')); $$;
alter function portal_private.is_active_portal_member() owner to postgres;
revoke all on function portal_private.is_active_portal_member() from public;
grant execute on function portal_private.is_active_portal_member() to authenticated;

-- Only existing uploaded objects belonging to this caller may be attached.
create function portal_private.check_portal_proof(p_path text, p_folder text)
returns void language plpgsql security definer set search_path = ''
as $$ begin
  if p_path is not null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('portal-proof:' || p_path, 0));
  end if;
  if p_path is not null and (
    split_part(p_path, '/', 1) <> auth.uid()::text
    or split_part(p_path, '/', 2) <> p_folder
    or p_path !~ '^[0-9a-f-]{36}/[a-z0-9-]+/[0-9a-f-]{36}\.(jpg|jpeg|png|webp)$'
    or not exists (select 1 from storage.objects o
      where o.bucket_id = 'payment-proofs' and o.name = p_path)
  ) then raise exception 'Invalid proof attachment'; end if;
end; $$;
alter function portal_private.check_portal_proof(text,text) owner to postgres;
revoke all on function portal_private.check_portal_proof(text,text) from public;

create function public.portal_submit_dues(p_month date, p_amount numeric, p_proof_path text)
returns uuid language plpgsql security definer set search_path = ''
as $$ declare v_id uuid; v_status text; v_month date := date_trunc('month', p_month)::date;
begin
  if not portal_private.is_active_portal_member() then raise exception 'Active membership required'; end if;
  if v_month is null or p_proof_path is null or p_amount is null
    or not exists (select 1 from public.chapter_settings s where s.id = true
      and s.accept_gcash and s.payment_visible and s.monthly_amount = p_amount)
    or p_amount <= 0 or p_amount > 2147483647 or p_amount <> trunc(p_amount)
  then raise exception 'Invalid contribution or GCash submissions disabled'; end if;
  perform portal_private.check_portal_proof(p_proof_path, v_month::text);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(auth.uid()::text || ':' || v_month::text, 0));
  select id, status into v_id, v_status from public.monthly_dues
    where member_id = auth.uid() and month = v_month for update;
  if v_status in ('Pending', 'Approved') then raise exception 'Contribution already pending or approved'; end if;
  if v_id is null then
    insert into public.monthly_dues(member_id, month, amount, method, status, proof_path, submitted_at)
      values(auth.uid(), v_month, p_amount::integer, 'GCash', 'Pending', p_proof_path, now()) returning id into v_id;
  else
    update public.monthly_dues set amount = p_amount::integer, method = 'GCash', status = 'Pending',
      proof_path = p_proof_path, submitted_at = now(), paid_at = null, reviewed_at = null,
      reviewed_by = null, review_note = null where id = v_id;
  end if;
  return v_id;
end; $$;

create function public.portal_review_dues(p_id uuid, p_status text)
returns uuid language plpgsql security definer set search_path = ''
as $$ declare v_row public.monthly_dues;
begin
  if not portal_private.is_active_portal_admin() then raise exception 'Active administrator required'; end if;
  if p_status is null or p_status not in ('Approved', 'Rejected') then raise exception 'Invalid review status'; end if;
  select * into v_row from public.monthly_dues where id = p_id for update;
  if not found or v_row.status <> 'Pending' then raise exception 'Only pending contributions may be reviewed'; end if;
  if v_row.amount is null or v_row.amount <= 0 then raise exception 'Invalid contribution amount'; end if;
  update public.monthly_dues set status = p_status, reviewed_by = auth.uid(), reviewed_at = now(),
    paid_at = case when p_status = 'Approved' then now() else null end where id = p_id;
  if p_status = 'Approved' then
    insert into public.fund_transactions(type, kind, amount, description, purpose, recorded_by, created_by, dues_id, occurred_at)
      values('income', 'income', v_row.amount, 'Monthly dues · ' || v_row.month::text,
        'Monthly dues · ' || v_row.month::text, auth.uid(), auth.uid(), p_id, now());
  end if;
  return p_id;
end; $$;

create function public.portal_record_payment(p_member_id uuid, p_month date, p_amount numeric,
  p_method text, p_proof_path text default null)
returns uuid language plpgsql security definer set search_path = ''
as $$ declare v_id uuid; v_status text; v_month date := date_trunc('month', p_month)::date;
begin
  if not portal_private.is_active_portal_admin() then raise exception 'Active administrator required'; end if;
  if v_month is null or p_amount is null or p_amount <= 0 or p_amount > 2147483647
    or p_amount <> trunc(p_amount) or p_method is null or p_method not in ('Cash', 'GCash')
    or not exists (select 1 from public.profiles where id = p_member_id and is_active is true and role = 'member')
    or not exists (select 1 from public.chapter_settings where id = true
      and ((p_method = 'Cash' and accept_cash) or (p_method = 'GCash' and accept_gcash)))
  then raise exception 'Invalid contribution or payment method disabled'; end if;
  perform portal_private.check_portal_proof(p_proof_path, 'walk-in');
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_member_id::text || ':' || v_month::text, 0));
  select id, status into v_id, v_status from public.monthly_dues
    where member_id = p_member_id and month = v_month for update;
  if v_status in ('Pending', 'Approved') then raise exception 'Contribution already pending or approved'; end if;
  if v_id is null then
    insert into public.monthly_dues(member_id, month, amount, method, status, proof_path, submitted_at, paid_at, reviewed_by, reviewed_at)
      values(p_member_id, v_month, p_amount::integer, p_method, 'Approved', p_proof_path, now(), now(), auth.uid(), now()) returning id into v_id;
  else
    update public.monthly_dues set amount = p_amount::integer, method = p_method, status = 'Approved',
      proof_path = p_proof_path, submitted_at = now(), paid_at = now(), reviewed_by = auth.uid(),
      reviewed_at = now(), review_note = null where id = v_id;
  end if;
  insert into public.fund_transactions(type, kind, amount, description, purpose, recorded_by, created_by, dues_id, occurred_at)
    values('income', 'income', p_amount::integer, 'Monthly dues · ' || v_month::text,
      'Monthly dues · ' || v_month::text, auth.uid(), auth.uid(), v_id, now());
  return v_id;
end; $$;

create function public.portal_record_expense(p_amount numeric, p_purpose text, p_date date, p_receipt_path text default null)
returns uuid language plpgsql security definer set search_path = ''
as $$ declare v_id uuid;
begin
  if not portal_private.is_active_portal_admin() then raise exception 'Active administrator required'; end if;
  if p_amount is null or p_amount <= 0 or p_amount > 2147483647 or p_amount <> trunc(p_amount)
    or p_date is null or p_purpose is null or length(trim(p_purpose)) = 0 or length(p_purpose) > 2000
  then raise exception 'Invalid expense'; end if;
  perform portal_private.check_portal_proof(p_receipt_path, 'expenses');
  insert into public.fund_transactions(type, kind, amount, description, purpose, recorded_by, created_by, occurred_at, receipt_path)
    values('expense', 'expense', p_amount::integer, trim(p_purpose), trim(p_purpose), auth.uid(), auth.uid(),
      p_date::timestamp at time zone 'Asia/Manila', p_receipt_path) returning id into v_id;
  return v_id;
end; $$;

alter function public.portal_submit_dues(date,numeric,text) owner to postgres;
alter function public.portal_review_dues(uuid,text) owner to postgres;
alter function public.portal_record_payment(uuid,date,numeric,text,text) owner to postgres;
alter function public.portal_record_expense(numeric,text,date,text) owner to postgres;
revoke all on function public.portal_submit_dues(date,numeric,text), public.portal_review_dues(uuid,text),
  public.portal_record_payment(uuid,date,numeric,text,text), public.portal_record_expense(numeric,text,date,text) from public, anon;
grant execute on function public.portal_submit_dues(date,numeric,text), public.portal_review_dues(uuid,text),
  public.portal_record_payment(uuid,date,numeric,text,text), public.portal_record_expense(numeric,text,date,text) to authenticated;

alter table public.chapter_settings enable row level security;
alter table public.monthly_dues enable row level security;
alter table public.fund_transactions enable row level security;
alter table public.chapter_posts enable row level security;
revoke insert, update, delete on public.monthly_dues, public.fund_transactions from authenticated, anon;
grant select on public.chapter_settings, public.monthly_dues, public.fund_transactions, public.chapter_posts to authenticated;
grant select on public.chapter_posts to anon;
revoke truncate, references, trigger on public.profiles, public.chapter_settings, public.monthly_dues, public.fund_transactions, public.chapter_posts from authenticated, anon;
grant update on public.chapter_settings to authenticated;
grant insert, update, delete on public.chapter_posts to authenticated;
create policy portal_settings_read on public.chapter_settings for select to authenticated
  using ((select portal_private.is_active_portal_member()));
create policy portal_settings_update on public.chapter_settings for update to authenticated
  using ((select portal_private.is_active_portal_admin())) with check ((select portal_private.is_active_portal_admin()));
create policy portal_dues_read on public.monthly_dues for select to authenticated
  using ((select portal_private.is_active_portal_member()) and
    (member_id = (select auth.uid()) or (select portal_private.is_active_portal_admin())));
create policy portal_funds_read on public.fund_transactions for select to authenticated
  using ((select portal_private.is_active_portal_admin()) or
    ((select portal_private.is_active_portal_member()) and exists
      (select 1 from public.chapter_settings where id = true and show_fund_ledger)));
create policy portal_posts_read on public.chapter_posts for select to authenticated
  using (is_published or (select portal_private.is_active_portal_admin()));
create policy portal_public_posts_read on public.chapter_posts for select to anon
  using (is_published);
create policy portal_posts_insert on public.chapter_posts for insert to authenticated
  with check ((select portal_private.is_active_portal_admin()) and created_by = (select auth.uid()));
create policy portal_posts_update on public.chapter_posts for update to authenticated
  using ((select portal_private.is_active_portal_admin())) with check ((select portal_private.is_active_portal_admin()));
create policy portal_posts_delete on public.chapter_posts for delete to authenticated
  using ((select portal_private.is_active_portal_admin()));

update storage.buckets set file_size_limit = 5242880, allowed_mime_types = array['image/jpeg','image/png','image/webp'] where id = 'payment-proofs';
update storage.buckets set file_size_limit = 8388608, allowed_mime_types = array['image/jpeg','image/png','image/webp'] where id = 'chapter-activities';
update storage.buckets set file_size_limit = 2621440, allowed_mime_types = array['image/jpeg','image/png','image/webp'] where id = 'chapter-qr';
create policy portal_proofs_read on storage.objects for select to authenticated
  using (bucket_id = 'payment-proofs' and (select portal_private.is_active_portal_member()) and
    (split_part(name, '/', 1) = (select auth.uid())::text or (select portal_private.is_active_portal_admin())));
create policy portal_proofs_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'payment-proofs' and (select portal_private.is_active_portal_member())
    and split_part(name, '/', 1) = (select auth.uid())::text
    and name ~ '^[0-9a-f-]{36}/([0-9]{4}-[0-9]{2}-01|walk-in|expenses)/[0-9a-f-]{36}\.(jpg|jpeg|png|webp)$'
    and (split_part(name, '/', 2) not in ('walk-in', 'expenses')
      or (select portal_private.is_active_portal_admin())));

-- Definer lookup checks all references regardless of the caller's row visibility.
create function portal_private.portal_proof_unreferenced(p_path text)
returns boolean language plpgsql volatile security definer set search_path = ''
as $$ begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('portal-proof:' || p_path, 0));
  return not exists (select 1 from public.monthly_dues where proof_path = p_path)
    and not exists (select 1 from public.fund_transactions where receipt_path = p_path);
end; $$;
alter function portal_private.portal_proof_unreferenced(text) owner to postgres;
revoke all on function portal_private.portal_proof_unreferenced(text) from public;
grant execute on function portal_private.portal_proof_unreferenced(text) to authenticated;
create policy portal_proofs_cleanup on storage.objects for delete to authenticated
  using (bucket_id = 'payment-proofs' and (select portal_private.is_active_portal_member())
    and split_part(name, '/', 1) = (select auth.uid())::text
    and portal_private.portal_proof_unreferenced(name));
create policy portal_public_images_read on storage.objects for select to public
  using (bucket_id in ('chapter-activities', 'chapter-qr'));
create policy portal_public_images_insert on storage.objects for insert to authenticated
  with check (bucket_id in ('chapter-activities', 'chapter-qr') and (select portal_private.is_active_portal_admin()));
create policy portal_public_images_update on storage.objects for update to authenticated
  using (bucket_id in ('chapter-activities', 'chapter-qr') and (select portal_private.is_active_portal_admin()))
  with check (bucket_id in ('chapter-activities', 'chapter-qr') and (select portal_private.is_active_portal_admin()));
create policy portal_public_images_delete on storage.objects for delete to authenticated
  using (bucket_id in ('chapter-activities', 'chapter-qr') and (select portal_private.is_active_portal_admin()));
commit;
