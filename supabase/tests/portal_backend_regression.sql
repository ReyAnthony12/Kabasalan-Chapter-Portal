-- Run as postgres after both 20261104 migrations. All changes roll back.
-- No real users, authentication records, payments, or uploads are created.
begin;
do $$
declare v_signature text; v_name text;
begin
  foreach v_signature in array array[
    'public.portal_submit_dues(date,numeric,text)',
    'public.portal_review_dues(uuid,text)',
    'public.portal_record_payment(uuid,date,numeric,text,text)',
    'public.portal_record_expense(numeric,text,date,text)'
  ] loop
    if has_function_privilege('anon', v_signature, 'execute') then
      raise exception 'Anonymous execute unexpectedly allowed: %', v_signature;
    end if;
    if not has_function_privilege('authenticated', v_signature, 'execute') then
      raise exception 'Authenticated execute missing: %', v_signature;
    end if;
    if not exists (select 1 from pg_proc p where p.oid = v_signature::regprocedure
      and p.prosecdef and p.proowner = 'postgres'::regrole
      and p.proconfig @> array['search_path=""']) then
      raise exception 'Unsafe function configuration: %', v_signature;
    end if;
  end loop;
  foreach v_name in array array['chapter_settings','monthly_dues','fund_transactions','chapter_posts'] loop
    if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = v_name and c.relrowsecurity) then
      raise exception 'RLS missing: %', v_name;
    end if;
  end loop;
  foreach v_name in array array['monthly_dues','fund_transactions'] loop
    if has_table_privilege('authenticated', 'public.' || v_name, 'insert,update,delete') then
      raise exception 'Direct financial writes unexpectedly allowed: %', v_name;
    end if;
  end loop;
end; $$;

-- Simulate an authenticated request with no identity or live profile.
select set_config('request.jwt.claims', '{}', true);
select set_config('request.jwt.claim.sub', '', true);
set local role authenticated;
do $$
declare v_denied boolean;
begin
  if portal_private.is_active_portal_member() or portal_private.is_active_portal_admin() then
    raise exception 'A missing identity must not authorize access';
  end if;
  v_denied := false;
  begin perform public.portal_submit_dues(current_date, 100, 'invalid');
  exception when raise_exception then v_denied := sqlerrm = 'Active membership required'; end;
  if not v_denied then raise exception 'Missing identity submitted dues'; end if;
  v_denied := false;
  begin perform public.portal_review_dues('00000000-0000-0000-0000-000000000001', 'Approved');
  exception when raise_exception then v_denied := sqlerrm = 'Active administrator required'; end;
  if not v_denied then raise exception 'Missing identity reviewed dues'; end if;
  v_denied := false;
  begin perform public.portal_record_payment('00000000-0000-0000-0000-000000000001', current_date, 100, 'Cash');
  exception when raise_exception then v_denied := sqlerrm = 'Active administrator required'; end;
  if not v_denied then raise exception 'Missing identity recorded a payment'; end if;
  v_denied := false;
  begin perform public.portal_record_expense(100, 'Regression test', current_date);
  exception when raise_exception then v_denied := sqlerrm = 'Active administrator required'; end;
  if not v_denied then raise exception 'Missing identity recorded an expense'; end if;
end; $$;

-- A forged/stale admin claim without a matching live profile also fails.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000001","app_metadata":{"chapter_role":"admin"}}', true);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true);
do $$ begin
  if portal_private.is_active_portal_admin() then
    raise exception 'Token metadata alone authorized an administrator';
  end if;
end; $$;
reset role;
rollback;
