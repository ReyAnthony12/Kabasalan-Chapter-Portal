import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
const source=stripTypeScriptTypes((await readFile(new URL('../supabase/functions/create-chapter-member/index.ts',import.meta.url),'utf8')).replace(/^import .*?;\s*/,''));
function setup({role='admin',active=true,profileFailure=false}={}) {
  let handler;const calls=[];
  const caller={auth:{getUser:async()=>({data:{user:{id:'admin-id',app_metadata:{chapter_role:role}}},error:null})}};
  const admin={from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:{role:'admin',is_active:active},error:null})})}),upsert:async row=>{calls.push(['profile',row]);return {error:profileFailure?new Error('database failure'):null};}}),auth:{admin:{createUser:async row=>{calls.push(['auth',row]);return {data:{user:{id:'new-member',email:row.email}},error:null};},deleteUser:async id=>{calls.push(['rollback',id]);return {error:null};}}}};
  let clients=0;
  vm.runInNewContext(source,{createClient:()=>clients++===0?caller:admin,Deno:{env:{get:()=> 'server-environment-reference'},serve:fn=>{handler=fn;}},Response,Request,TextEncoder,console:{error(){}}});
  return {calls,send:body=>handler(new Request('https://example.test',{method:'POST',headers:{Authorization:'Bearer test-token','Content-Type':'application/json'},body:JSON.stringify(body)}))};
}
const details={full_name:'Test Member',email:'Member@example.test',password:'initial-password',chapter_position:'Member'};
test('member creation requires a trusted active administrator',async()=>{
  for(const options of [{role:'member'},{active:false}]) {const api=setup(options);assert.equal((await api.send(details)).status,403);assert.equal(api.calls.length,0);}
});
test('member function rejects null, array, malformed field types and long passwords',async()=>{
  for(const body of [null,[],{...details,email:{}},{...details,password:'a'.repeat(129)}]) {const api=setup();assert.equal((await api.send(body)).status,400);assert.equal(api.calls.length,0);}
});
test('member login includes a live member profile and does not return its password',async()=>{
  const api=setup();const response=await api.send(details);assert.equal(response.status,201);
  assert.deepEqual(api.calls.map(([kind])=>kind),['auth','profile']);
  assert.equal(api.calls[0][1].app_metadata.chapter_role,'member');
  assert.equal(api.calls[1][1].email,'member@example.test');assert.equal(api.calls[1][1].is_active,true);
  assert.equal((await response.text()).includes(details.password),false);
});
test('profile provisioning failure rolls back the newly created login',async()=>{
  const api=setup({profileFailure:true});assert.equal((await api.send(details)).status,500);
  assert.deepEqual(api.calls.map(([kind])=>kind),['auth','profile','rollback']);
  assert.equal(api.calls.at(-1)[1],'new-member');
});
