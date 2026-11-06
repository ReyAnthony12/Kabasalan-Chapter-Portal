import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

// Minimal pre-migration schema: legacy columns used by the shipped migrations.
// Auth/storage model PostgreSQL privileges and RLS, not Supabase's HTTP services.
const fixture = `
create role anon; create role authenticated;
alter default privileges in schema public grant all on tables to anon,authenticated;
create schema auth; create schema storage;
create table auth.users(id uuid primary key);
create function auth.jwt() returns jsonb language sql stable as $$
 select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
grant usage on schema auth,storage to anon,authenticated;
grant execute on all functions in schema auth to anon,authenticated;
create table public.profiles(id uuid primary key references auth.users, role text not null, is_active boolean not null default true, chapter_position text default 'Member',full_name text default 'Test Member');
alter table public.profiles enable row level security;
grant all on public.profiles to anon,authenticated;
create table public.chapter_settings(id boolean primary key default true check(id=true), deadline_day integer default 15,
 monthly_amount integer default 100, payment_visible boolean default true,gcash_number text,created_at timestamptz default now());
create table public.monthly_dues(id uuid primary key default gen_random_uuid(),member_id uuid references public.profiles,
 month date, amount integer, status text default 'Pending' check(status in ('Pending','Approved','Rejected')), proof_path text, submitted_at timestamptz,
 reviewed_at timestamptz,review_note text,created_at timestamptz default now(),unique(member_id,month));
create table public.fund_transactions(id uuid primary key default gen_random_uuid(),type text check(type in ('income','expense')),amount integer,
 description text,recorded_by uuid references public.profiles,created_at timestamptz default now());
create table public.chapter_posts(id uuid primary key default gen_random_uuid(),caption text,photo_paths text[] default '{}',
 created_by uuid references public.profiles,created_at timestamptz default now(),is_published boolean default false);
create table storage.buckets(id text primary key,public boolean default false,file_size_limit bigint,allowed_mime_types text[]);
create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets,
 name text not null,owner uuid,metadata jsonb,unique(bucket_id,name));
alter table storage.objects enable row level security;
grant select,insert,update,delete on storage.objects to anon,authenticated;
insert into storage.buckets(id) values('payment-proofs'),('chapter-activities'),('chapter-qr');
alter table public.chapter_settings enable row level security;
alter table public.monthly_dues enable row level security;
alter table public.fund_transactions enable row level security;
alter table public.chapter_posts enable row level security;
grant all on public.chapter_settings,public.monthly_dues,public.fund_transactions,public.chapter_posts to anon,authenticated;
`;
const ids = { admin: '00000000-0000-0000-0000-000000000001', member: '00000000-0000-0000-0000-000000000002', other: '00000000-0000-0000-0000-000000000003' };
const proof = month => `${ids.member}/${month}/10000000-0000-0000-0000-000000000001.png`;

test('dues start months are admin controlled and enforced without rewriting history',async()=>{
  const db=await setup();
  try{
    await db.exec('update chapter_settings set dues_start_month=null');
    await upload(db,'2026-01-01');
    await assert.rejects(submit(db,'2026-01-01'),/have not started/);
    await assert.rejects(as(db,'member',"select portal_set_dues_start('2026-01-01',null)"),/Active administrator/);
    await as(db,'admin',"select portal_set_dues_start('2026-03-01',null)");
    await assert.rejects(submit(db,'2026-01-01'),/have not started/);
    await upload(db,'2026-03-01');const march=await submit(db,'2026-03-01');
    await as(db,'admin',"select portal_review_dues($1,'Approved')",[march]);
    await as(db,'admin',"select portal_set_dues_start('2026-05-01',$1)",[ids.member]);
    await upload(db,'2026-04-01');await assert.rejects(submit(db,'2026-04-01'),/have not started/);
    assert.equal((await db.query('select status from monthly_dues where id=$1',[march])).rows[0].status,'Approved');
    await as(db,'admin','select portal_set_dues_start(null,$1)',[ids.member]);
    assert.ok(await submit(db,'2026-04-01'));
    await assert.rejects(as(db,'admin',"select portal_set_dues_start('2026-05-15',null)"),/first day/);
  }finally{await db.close();}
});

test('seven elected officers are public, editable only by admins, and do not grant admin access',async()=>{
  const db=await setup();
  try{
    const roster=await as(db,null,'select position,display_name,sort_order from chapter_officers order by sort_order');
    assert.equal(roster.length,7);assert.equal(roster[0].display_name,'Juffel D. Villaruel');assert.equal(roster[6].display_name,'Jerson Obera');
    await assert.rejects(as(db,null,'select member_id from chapter_officers'),/permission denied/);
    const proposed=roster.map(row=>({...row,member_id:null}));proposed[0]={...proposed[0],display_name:'Elected Member',member_id:ids.member};
    await assert.rejects(as(db,'member','select portal_save_officers($1)',[JSON.stringify(proposed)]),/Active administrator/);
    await as(db,'admin','select portal_save_officers($1)',[JSON.stringify(proposed)]);
    const member=(await db.query('select role,chapter_position from profiles where id=$1',[ids.member])).rows[0];
    assert.deepEqual(member,{role:'member',chapter_position:'GT'});
    proposed[1]={...proposed[1],display_name:'Duplicate Member',member_id:ids.member};
    await assert.rejects(as(db,'admin','select portal_save_officers($1)',[JSON.stringify(proposed)]),/duplicate key/);
    assert.equal((await db.query("select member_id from chapter_officers where position='GT'")).rows[0].member_id,ids.member);
    proposed[0]={...proposed[0],display_name:'New GT',member_id:ids.other};
    await as(db,'admin','select portal_save_officers($1)',[JSON.stringify(proposed)]);
    assert.equal((await db.query('select chapter_position from profiles where id=$1',[ids.member])).rows[0].chapter_position,'DGT');
    proposed[1]={...proposed[1],display_name:'Name without account',member_id:null};
    await as(db,'admin','select portal_save_officers($1)',[JSON.stringify(proposed)]);
    assert.equal((await db.query('select chapter_position from profiles where id=$1',[ids.member])).rows[0].chapter_position,'Member');
  }finally{await db.close();}
});

async function setup() {
  const db = new PGlite();
  await db.exec(fixture);
  for (const name of ['restore_profile_read','active_profile_authorization','complete_portal_backend','dues_schedule_officers','member_dues_status']) {
    await db.exec(await readFile(new URL(`../supabase/migrations/20261104_${name}.sql`, import.meta.url), 'utf8'));
  }
  for (const [role,id] of Object.entries(ids)) {
    await db.query('insert into auth.users values ($1)', [id]);
    await db.query('insert into public.profiles(id,role,is_active) values ($1,$2,true)', [id, role === 'admin' ? 'admin' : 'member']);
  }
  await db.exec("update public.chapter_settings set dues_start_month='2026-01-01'");
  return db;
}
async function as(db, identity, sql, params = [], claim) {
  await db.exec('begin');
  try {
    await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify(identity ? {sub: ids[identity], app_metadata: {chapter_role: claim ?? (identity === 'admin' ? 'admin' : 'member')}} : {})]);
    await db.exec(`set local role ${identity ? 'authenticated' : 'anon'}`);
    const result = await db.query(sql, params);
    await db.exec('commit');
    return result.rows;
  } catch (error) { await db.exec('rollback'); throw error; }
}
async function upload(db, month) {
  await as(db,'member',"insert into storage.objects(bucket_id,name,owner) values ('payment-proofs',$1,$2)",[proof(month),ids.member]);
}
async function submit(db, month) {
  return (await as(db,'member','select public.portal_submit_dues($1,100,$2) id',[month,proof(month)]))[0].id;
}

test('profile RLS consults current membership even with stale administrator claims', async () => {
  const db = await setup();
  try {
    assert.equal((await as(db,'admin','select * from profiles')).length,3);
    assert.deepEqual((await as(db,'member','select id from profiles')).map(r=>r.id),[ids.member]);
    assert.equal((await as(db,null,'select * from profiles')).length,0);
    await db.exec("insert into chapter_posts(caption,is_published) values('Public activity',true),('Draft activity',false)");
    assert.deepEqual((await as(db,null,'select caption from chapter_posts')).map(r=>r.caption),['Public activity']);
    assert.equal((await as(db,'member','select * from chapter_posts')).length,1);
    assert.equal((await as(db,'admin','select * from chapter_posts')).length,2);
    await db.exec(`update profiles set is_active=false where id='${ids.admin}'`);
    assert.deepEqual((await as(db,'admin','select id from profiles')).map(r=>r.id),[ids.admin]);
    await db.exec(`update profiles set is_active=true,role='member' where id='${ids.admin}'`);
    assert.deepEqual((await as(db,'admin','select id from profiles')).map(r=>r.id),[ids.admin]);
    await assert.rejects(as(db,'admin',"select portal_record_expense(100,'forbidden',current_date)"), /Active administrator required/);
  } finally { await db.close(); }
});

test('proof submission, administrator review, ledger atomicity, and storage isolation', async () => {
  const db = await setup();
  try {
    await assert.rejects(submit(db,'2026-01-01'), /Invalid proof attachment/);
    await upload(db,'2026-01-01');
    assert.equal((await as(db,'other','select * from storage.objects')).length,0);
    await assert.rejects(as(db,'other','select portal_submit_dues($1,100,$2)',['2026-01-01',proof('2026-01-01')]), /Invalid proof attachment/);
    const id = await submit(db,'2026-01-01');
    assert.equal((await as(db,'member','select status from monthly_dues'))[0].status,'Pending');
    await assert.rejects(as(db,'member',"update monthly_dues set status='Approved' where id=$1",[id]), /permission denied/);
    await assert.rejects(as(db,'member',"insert into monthly_dues(member_id,month,status) values($1,'2026-02-01','Approved')",[ids.other]), /permission denied/);
    await assert.rejects(as(db,'member',"select portal_review_dues($1,'Approved')",[id]), /Active administrator required/);
    assert.equal((await as(db,'member','delete from storage.objects where name=$1 returning id',[proof('2026-01-01')])).length,0);
    await as(db,'admin',"select portal_review_dues($1,'Approved')",[id]);
    assert.equal((await db.query('select * from fund_transactions where dues_id=$1',[id])).rows.length,1);
    assert.equal((await as(db,'member','select status,paid_at,reviewed_by from monthly_dues'))[0].status,'Approved');
    await assert.rejects(as(db,'admin',"select portal_review_dues($1,'Approved')",[id]), /Only pending/);
    await assert.rejects(submit(db,'2026-01-01'), /already pending or approved/);
    assert.equal((await db.query('select * from fund_transactions where dues_id=$1',[id])).rows.length,1);
    await as(db,'admin','update chapter_settings set show_fund_ledger=false');
    assert.equal((await as(db,'member','select * from fund_transactions')).length,0);
    assert.equal((await as(db,'admin','select * from fund_transactions')).length,1);

    await upload(db,'2026-02-01');
    const collision = await submit(db,'2026-02-01');
    await db.query("insert into fund_transactions(type,amount,dues_id) values('income',100,$1)",[collision]);
    await assert.rejects(as(db,'admin',"select portal_review_dues($1,'Approved')",[collision]), /duplicate key/);
    const row = (await db.query('select status,paid_at,reviewed_at,reviewed_by from monthly_dues where id=$1',[collision])).rows[0];
    assert.deepEqual(row,{status:'Pending',paid_at:null,reviewed_at:null,reviewed_by:null});
    assert.equal((await db.query('select * from fund_transactions where dues_id=$1',[collision])).rows.length,1);

    const cash = (await as(db,'admin',"select portal_record_payment($1,'2026-03-15',100,'Cash') id",[ids.member]))[0].id;
    await assert.rejects(as(db,'admin',"select portal_record_payment($1,'2026-03-01',100,'Cash')",[ids.admin]), /Invalid contribution/);
    await assert.rejects(as(db,'admin',"select portal_record_payment($1,'2026-03-01',100,'Cash')",[ids.member]), /already pending or approved/);
    assert.equal((await db.query('select * from fund_transactions where dues_id=$1',[cash])).rows.length,1);
    await upload(db,'2026-04-01');
    assert.equal((await as(db,'member','delete from storage.objects where name=$1 returning id',[proof('2026-04-01')])).length,1);
    assert.equal((await as(db,'other','select * from monthly_dues')).length,0);
    await assert.rejects(as(db,null,"select portal_record_expense(100,'forbidden',current_date)"), /permission denied/);
    const expense=(await as(db,'admin',"select portal_record_expense(40,'Chapter supplies','2026-03-10') id"))[0].id;
    const ledger=(await db.query('select type,kind,amount,description,purpose,recorded_by,created_by from fund_transactions where id=$1',[expense])).rows[0];
    assert.equal(ledger.type,'expense');assert.equal(ledger.kind,'expense');assert.equal(ledger.amount,40);
    assert.equal(ledger.description,'Chapter supplies');assert.equal(ledger.purpose,'Chapter supplies');
    assert.equal(ledger.recorded_by,ids.admin);assert.equal(ledger.created_by,ids.admin);
  } finally { await db.close(); }
});

test('dues inactivity is admin controlled, retains membership and history, and blocks new payments',async()=>{
 const db=await setup();try{
 await upload(db,'2026-01-01');const id=await submit(db,'2026-01-01');
 await as(db,'admin',"select portal_review_dues($1,'Approved')",[id]);
 await assert.rejects(as(db,'member','select portal_set_member_dues_active($1,false)',[ids.member]),/Active administrator/);
 await as(db,'admin','select portal_set_member_dues_active($1,false)',[ids.member]);
 assert.deepEqual((await db.query('select is_active,dues_active from profiles where id=$1',[ids.member])).rows[0],{is_active:true,dues_active:false});
 assert.equal((await as(db,'member','select status from monthly_dues'))[0].status,'Approved');
 await upload(db,'2026-02-01');await assert.rejects(submit(db,'2026-02-01'),/dues are inactive/);
 await as(db,'admin','select portal_set_member_dues_active($1,true)',[ids.member]);assert.ok(await submit(db,'2026-02-01'));
 }finally{await db.close();}
});
