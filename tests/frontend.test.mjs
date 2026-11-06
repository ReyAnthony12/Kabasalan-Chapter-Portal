import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Window } from 'happy-dom';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const ui = await readFile(new URL('../src/scripts/portal-ui.js', import.meta.url), 'utf8');
const runtime = await readFile(new URL('../src/scripts/supabase-runtime.js', import.meta.url), 'utf8');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const result = data => ({ data, error: null });
const user = id => ({ id, email: `${id}@example.test`, app_metadata: { chapter_role: 'admin' } });
const profile = id => ({ id, full_name: `Private ${id}`, role: 'admin', is_active: true });

test('landing activity photos remain visible in admin and member news after refresh and session reset',async t=>{
  const {d,hooks}=setup(t);
  hooks.renderPosts([]);
  for(const id of ['adminPostsList','memberPostFeed','memberLatestPost']) {
    assert.equal(d.querySelectorAll(`#${id} [data-featured-activity] img`).length,7);
    assert.match(d.getElementById(id).textContent,/Small act, big heart/);
    assert.equal(d.querySelector(`#${id} .empty-state`),null);
  }
  hooks.clearPrivateState();
  for(const id of ['adminPostsList','memberPostFeed','memberLatestPost']) assert.equal(d.querySelectorAll(`#${id} [data-featured-activity] img`).length,7);
  assert.equal(d.querySelectorAll('#undas-title').length,1);
});

test('members before their start month are not counted as unpaid',async t=>{
  const {d,hooks}=setup(t);hooks.seed('a');
  const settings={monthly_amount:100,dues_start_month:'2026-11-01'};
  hooks.renderAdminDues([{id:'eligible',full_name:'Started Member',is_active:true},{id:'future',full_name:'Future Member',is_active:true,dues_start_month:'2026-12-01'}],[],'2026-11-01',settings,[]);
  assert.equal(d.querySelectorAll('#duesTable tbody tr[data-status]').length,1);
  assert.equal(d.getElementById('followupUnpaidCount').textContent,'1 members unpaid');
  assert.equal(d.getElementById('payMember').textContent.includes('Future Member'),false);
  hooks.renderAdminDues([{id:'not-started',full_name:'Not Started',is_active:true}],[],'2026-10-01',settings,[]);
  assert.equal(d.getElementById('followupUnpaidCount').textContent,'0 members unpaid');
});
test('unscheduled member cannot upload and officer names are rendered as text',async t=>{
  const {d,hooks,mock}=setup(t);hooks.seed('a','member');
  hooks.renderMemberDues([],{monthly_amount:100,accept_gcash:true,payment_deadline:'Day 15'},{});
  assert.equal(d.getElementById('memberDuesStatus').textContent,'Dues not scheduled yet');
  assert.equal(d.querySelector('#member-page-dues .pay-qr-copy .primary').disabled,true);
  mock.query=({table})=>result(table==='chapter_officers'?[{position:'GT',display_name:'<img src=x onerror=alert(1)>',sort_order:1}]:[]);
  await hooks.loadPublicOfficers();
  assert.equal(d.querySelector('#publicOfficersGrid img'),null);
  assert.equal(d.querySelector('#publicOfficersGrid h3').textContent,'<img src=x onerror=alert(1)>');
});

test('login shows loading, prevents duplicate submits, and restores the button on failure', async t => {
  const { w, d, mock } = setup(t);
  const pending=deferred();let calls=0;mock.signIn=()=>{calls++;return pending.promise;};
  const form=d.querySelector('#loginPage form'),button=form.querySelector('button[type="submit"]');
  const event={preventDefault(){},currentTarget:form};
  const login=w.handleSignIn(event);
  assert.equal(button.disabled,true);
  assert.equal(button.getAttribute('aria-busy'),'true');
  assert.equal(button.querySelector('[role="status"]').textContent,'Signing in…');
  await w.handleSignIn(event);assert.equal(calls,1);
  pending.resolve({data:null,error:{message:'Invalid login credentials'}});await login;
  assert.equal(button.disabled,false);
  assert.equal(button.hasAttribute('aria-busy'),false);
  assert.equal(button.textContent.includes('Sign in to portal'),true);
});

test('canceling the English sign-out confirmation preserves the current session', async t => {
  const {w,d,hooks}=setup(t);hooks.seed('a');let prompt;
  w.confirm=message=>{prompt=message;return false;};
  await w.signOutChapter();
  assert.equal(prompt,'Are you sure you want to sign out?');
  assert.equal(d.body.classList.contains('authenticated'),true);
});

test('late successful login and auth event cannot undo an explicit logout', async t => {
  const { w, d, mock } = setup(t);
  const pending=deferred();mock.signIn=()=>pending.promise;
  const form=d.querySelector('#loginPage form');
  const login=w.handleSignIn({preventDefault(){},currentTarget:form});
  await Promise.resolve();await w.signOutChapter();
  pending.resolve(result({user:user('a')}));await login;
  mock.authChange('SIGNED_IN',{user:user('a')});
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(d.body.classList.contains('authenticated'),false);
  assert.equal(d.body.classList.contains('public-mode'),true);
  assert.equal(d.querySelector('#accountsTable').textContent.includes('Private a'),false);
});

function setup(t) {
  // Evaluate only checked-in sources; every cloud call goes through the mock below.
  const w = new Window({ url: 'https://portal.example.test', settings: { enableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true, disableIframePageLoading: true, suppressInsecureJavaScriptEnvironmentWarning: true } });
  w.fetch = () => { throw new Error('Network access is forbidden in frontend regression tests'); };
  w.confirm = () => true;
  t.after(() => w.happyDOM.abort());
  w.document.write(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ''));
  const requests = [];
  const mock = { query: () => result([]), signed: path => Promise.resolve(result({ signedUrl: `https://proof.example.test/${path}` })) };
  const client = {
    rpc: (...args) => mock.rpc?.(...args) ?? Promise.resolve(result(null)),
    from(table) {
      const request = { table, filters: [], columns: null };
      const chain = new Proxy({}, { get(_, key) {
        if (key === 'then') return (resolve, reject) => { requests.push(request); return Promise.resolve(mock.query(request)).then(resolve, reject); };
        return (...args) => { if (key === 'select') request.columns = args[0]; if (key === 'eq') request.filters.push(args); return chain; };
      } });
      return chain;
    },
    auth: { onAuthStateChange(fn) { mock.authChange = fn; }, getUser: async () => mock.getUser?.() ?? result({ user: user('a') }), signOut: async () => result(null), signInWithPassword: () => mock.signIn() },
    storage: { from: () => ({
      createSignedUrl: path => mock.signed(path),
      getPublicUrl: path => result({ publicUrl: path }),
      upload: (...args) => mock.upload(...args),
      remove: (...args) => mock.remove(...args),
    }) },
  };
  w.KABASALAN_SUPABASE = { url: 'mock', publishableKey: 'mock' };
  w.__createClient = () => client;
  w.eval(ui);
  w.eval(runtime.replace(/^import[^\n]+\n/, 'const createClient = window.__createClient;\n') + `\nwindow.__test = { renderSettings, renderPosts, activateUser, loadAccounts, renderCloudReceiptQueue, renderAdminDues, renderMemberDues, loadPublicOfficers, clearPrivateState, seed(id, role='admin') { activeUserId=id; activeProfile={id,role,is_active:true}; document.body.className='authenticated '+role+'-auth '+role+'-mode'; } };`);
  return { w, d: w.document, hooks: w.__test, mock, requests };
}

test('logout removes private tables, receipt URLs, passwords and upload previews', async t => {
  const { w, d, hooks } = setup(t);
  hooks.seed('a');
  for (const selector of ['#accountsTable tbody', '#duesTable tbody', '#receiptQueueList', '#member-history tbody']) d.querySelector(selector).innerHTML = '<tr><td>PRIVATE ACCOUNT <a href="https://proof.example.test/private">proof</a></td></tr>';
  d.getElementById('newMemberPassword').value = 'private password';
  d.getElementById('receiptState').innerHTML = '<img src="data:image/png;base64,cHJpdmF0ZQ==">';
  d.getElementById('receiptState').hidden = false;
  d.getElementById('modal').classList.add('open');
  d.getElementById('chapterPostPreview').innerHTML = '<img src="blob:private">';
  await w.signOutChapter();
  assert.equal(d.body.classList.contains('authenticated'), false);
  assert.equal(d.body.textContent.includes('PRIVATE ACCOUNT'), false);
  assert.equal(d.querySelector('[href*="proof.example.test"]'), null);
  assert.equal(d.getElementById('newMemberPassword').value, '');
  assert.equal(d.getElementById('receiptState').children.length, 0);
  assert.equal(d.getElementById('receiptState').hidden, true);
  assert.equal(d.getElementById('chapterPostPreview').children.length, 0);
  assert.equal(d.querySelector('.modal-back.open'), null);
});

for (const transition of ['signout', 'switch']) {
  test(`delayed profile cannot reactivate an old account after ${transition}`, async t => {
    const { w, d, hooks, mock } = setup(t);
    const pending = deferred();
    mock.query = req => req.table === 'profiles' ? pending.promise : result([]);
    const activation = hooks.activateUser(user('a'));
    await Promise.resolve();
    if (transition === 'signout') await w.signOutChapter(); else { hooks.clearPrivateState(); hooks.seed('b'); }
    pending.resolve(result(profile('a'))); await activation;
    assert.equal(d.querySelector('.profile b').textContent.includes('Private a'), false);
    assert.equal(d.body.classList.contains('authenticated'), transition === 'switch');
  });

  test(`delayed account list cannot repaint after ${transition}`, async t => {
    const { w, d, hooks, mock } = setup(t);
    hooks.seed('a'); const pending = deferred(); mock.query = () => pending.promise;
    const load = hooks.loadAccounts(); await Promise.resolve();
    if (transition === 'signout') await w.signOutChapter(); else { hooks.clearPrivateState(); hooks.seed('b'); }
    pending.resolve(result([{ full_name: 'LEAKED ACCOUNT', email: 'secret@example.test', chapter_position: 'Member', is_active: true }])); await load;
    assert.equal(d.getElementById('accountsTable').textContent.includes('LEAKED ACCOUNT'), false);
  });
}

const receipt = { id: 'receipt-1', member_id: 'm', month: '2026-11-01', amount: 100, method: 'GCash', status: 'Pending', proof_path: 'private-proof', submitted_at: '2026-11-01T00:00:00Z', profiles: { full_name: 'Receipt Member', email: 'member@example.test' } };
test('nonempty cloud receipt queue awaits signed URLs and renders review controls', async t => {
  const { d, hooks, mock } = setup(t); hooks.seed('a');
  mock.query = () => result([receipt]);
  await hooks.renderCloudReceiptQueue();
  assert.equal(d.querySelectorAll('#receiptQueueList .receipt-row').length, 1);
  assert.equal(d.querySelector('#receiptQueueList .receipt-thumb').getAttribute('src'), 'https://proof.example.test/private-proof');
  assert.equal(d.querySelectorAll('#receiptQueueList [data-review-id="receipt-1"]').length, 2);
  assert.equal(d.getElementById('receiptQueueList').textContent.includes('[object Promise]'), false);
});

test('payment approval confirms before refresh and retry only reloads the dashboard', async t => {
  const { d, hooks, mock } = setup(t);
  hooks.seed('a');
  mock.query = () => result([receipt]);
  await hooks.renderCloudReceiptQueue();

  const refreshStarted = deferred();
  const refresh = deferred();
  const saveStarted = deferred();
  const save = deferred();
  let approvals = 0;
  mock.rpc = name => {
    assert.equal(name, 'portal_review_dues');
    approvals++;
    saveStarted.resolve();
    return save.promise;
  };
  mock.query = () => {
    refreshStarted.resolve();
    return refresh.promise;
  };
  const approve = d.querySelector('[data-review-status="Approved"]');
  const reject = d.querySelector('[data-review-status="Rejected"]');
  const approval = approve.onclick();
  await saveStarted.promise;
  assert.equal(reject.disabled, true);
  assert.equal(approve.disabled, true);
  await reject.onclick();
  await approve.onclick();
  assert.equal(approvals, 1);
  assert.doesNotMatch(d.getElementById('toast').textContent, /Payment approved/);
  save.resolve(result(null));
  await refreshStarted.promise;
  const notice = d.getElementById('paymentRefreshNotice');
  assert.match(d.getElementById('toast').textContent, /Payment approved/);
  assert.equal(notice.hidden, true);

  refresh.resolve({ data: null, error: { message: 'Offline' } });
  await approval;
  assert.equal(notice.hidden, false);
  assert.match(d.getElementById('toast').textContent, /Payment approved/);
  assert.equal(d.querySelector('.receipt-statusline .badge').textContent, 'Approved');
  assert.equal(d.querySelector('#receiptQueueList [data-review-id]'), null);

  mock.query = ({ table }) => result(table === 'chapter_settings' ? { monthly_amount: 100 } : []);
  mock.getUser = () => ({ data: null, error: { message: 'Auth service offline' } });
  await d.getElementById('retryPaymentRefresh').onclick();
  assert.equal(notice.hidden, false);
  delete mock.getUser;
  await d.getElementById('retryPaymentRefresh').onclick();
  assert.equal(notice.hidden, true);
  assert.equal(approvals, 1);
});

test('a failed receipt review keeps both controls available and never confirms payment', async t => {
  const { d, hooks, mock } = setup(t);
  hooks.seed('a');
  mock.query = () => result([receipt]);
  await hooks.renderCloudReceiptQueue();
  mock.rpc = () => ({ data: null, error: { message: 'Already reviewed by another admin' } });
  await d.querySelector('[data-review-status="Rejected"]').onclick();
  assert.match(d.getElementById('toast').textContent, /Payment review failed/);
  assert.equal(d.getElementById('paymentRefreshNotice').hidden, true);
  const buttons = [...d.querySelectorAll('#receiptQueueList [data-review-id]')];
  assert.equal(buttons.length, 2);
  assert.ok(buttons.every(button => !button.disabled));
});

test('receipt upload is not repeated when dashboard refresh fails or finishes after logout', async t => {
  const { w, d, hooks, mock } = setup(t);
  hooks.seed('a', 'member');
  const input = d.getElementById('memberReceipt');
  input.files = [new w.File(['receipt'], 'receipt.png', { type: 'image/png' })];
  const month = d.getElementById('memberReceiptMonth');
  const option = d.createElement('option');
  option.value = '2026-11-01';
  option.textContent = 'November 2026';
  month.append(option);
  month.value = '2026-11-01';
  d.getElementById('memberReceiptAmount').value = '100';
  let uploads = 0;
  let submissions = 0;
  mock.upload = () => { uploads++; return result(null); };
  mock.rpc = name => {
    assert.equal(name, 'portal_submit_dues');
    submissions++;
    return result(null);
  };
  mock.query = () => ({ data: null, error: { message: 'Offline' } });
  await Promise.all([w.sendMemberReceipt(), w.sendMemberReceipt()]);
  const notice = d.getElementById('paymentRefreshNotice');
  assert.match(d.getElementById('toast').textContent, /Receipt submitted/);
  assert.equal(notice.hidden, false);

  const refresh = deferred();
  mock.query = () => refresh.promise;
  const retryButton = d.getElementById('retryPaymentRefresh');
  const retry = retryButton.onclick();
  assert.equal(retryButton.disabled, true);
  await w.signOutChapter();
  refresh.resolve({ data: null, error: { message: 'Still offline' } });
  await retry;
  assert.equal(notice.hidden, true);
  assert.equal(retryButton.disabled, false);
  assert.equal(uploads, 1);
  assert.equal(submissions, 1);
});

test('walk-in payment stays confirmed when the receipt queue fails to refresh', async t => {
  const { w, d, hooks, mock } = setup(t);
  hooks.seed('a');
  d.getElementById('accountFields').style.display = 'none';
  d.getElementById('paymentFields').style.display = 'block';
  d.getElementById('modal').classList.add('open');
  d.getElementById('payMember').innerHTML = '<option value="m">Member</option>';
  d.getElementById('payMonth').innerHTML = '<option value="2026-11-01">November 2026</option>';
  d.getElementById('payAmount').value = '100';
  d.getElementById('payMethod').value = 'Cash';
  let writes = 0;
  mock.rpc = (name, args) => {
    assert.equal(name, 'portal_record_payment');
    assert.equal(args.p_member_id, 'm');
    assert.equal(args.p_amount, 100);
    writes++;
    return result(null);
  };
  let duesQueries = 0;
  mock.query = ({ table }) => {
    if (table === 'chapter_settings') return result({ monthly_amount: 100 });
    if (table === 'monthly_dues' && ++duesQueries === 2) return { data: null, error: { message: 'Queue unavailable' } };
    return result([]);
  };
  await w.saveModal();
  const notice = d.getElementById('paymentRefreshNotice');
  assert.match(d.getElementById('toast').textContent, /Payment and chapter income recorded/);
  assert.equal(d.getElementById('modal').classList.contains('open'), false);
  assert.equal(notice.hidden, false);
  await d.getElementById('retryPaymentRefresh').onclick();
  assert.equal(notice.hidden, true);
  assert.equal(writes, 1);
});

for (const transition of ['signout', 'switch']) test(`receipt URL completion cannot repaint after ${transition}`, async t => {
  const { w, d, hooks, mock } = setup(t); hooks.seed('a');
  const pending = deferred(), started = deferred();
  mock.query = () => result([receipt]); mock.signed = () => { started.resolve(); return pending.promise; };
  const load = hooks.renderCloudReceiptQueue(); await started.promise;
  if (transition === 'signout') await w.signOutChapter(); else { hooks.clearPrivateState(); hooks.seed('b'); }
  pending.resolve(result({ signedUrl: 'https://proof.example.test/SECRET' })); await load;
  assert.equal(d.querySelector('[href*="SECRET"]'), null);
  assert.equal(d.getElementById('receiptQueueList').textContent.includes('Receipt Member'), false);
});

test('same-user auth refresh preserves the selected admin page', async t => {
  const { w, d, hooks, mock } = setup(t); hooks.seed('a'); w.navigate('accounts');
  mock.query = () => result(profile('a'));
  await hooks.activateUser(user('a'));
  assert.equal(d.querySelector('main.content > .section.show').id, 'accounts');
  assert.equal(d.getElementById('crumb').textContent, 'Member accounts');
});

test('paid filter displays approved dues and excludes unpaid members', t => {
  const { d, hooks } = setup(t); hooks.seed('a');
  hooks.renderAdminDues([{ id:'paid', full_name:'Paid Person', is_active:true }, { id:'unpaid', full_name:'Unpaid Person', is_active:true }], [{ member_id:'paid', status:'Approved', month:'2026-11-01', amount:100 }], '2026-11-01', { monthly_amount:100,dues_start_month:'2026-01-01' }, []);
  d.querySelector('#dues [data-filter="paid"]').click();
  const rows = [...d.querySelectorAll('#duesTable tbody tr')];
  assert.equal(rows.find(row => row.dataset.status === 'paid').hidden, false);
  assert.equal(rows.find(row => row.dataset.status === 'unpaid').hidden, true);
});

test('receipt FileReader completion is invalidated by logout', async t => {
  const { w, d, hooks } = setup(t); hooks.seed('a', 'member');
  let reader;
  w.FileReader = class { constructor() { reader = this; } readAsDataURL() {} abort() { this.aborted = true; } };
  w.submitMemberReceipt({ files: [{ type:'image/png', size:12, name:'private-receipt.png' }] });
  await w.signOutChapter();
  reader.result = 'data:image/png;base64,cHJpdmF0ZQ=='; reader.onload();
  assert.equal(reader.aborted, true);
  assert.equal(d.getElementById('receiptState').children.length, 0);
  assert.equal(d.getElementById('receiptState').hidden, true);
});

test('frontend has no local persistence or demo mutation observers', () => {
  assert.doesNotMatch(ui + runtime, /\blocalStorage\b|\bMutationObserver\b/);
});

test('shared notification gives each new message three seconds and clears it afterward', async t => {
  const w=new Window();t.after(()=>w.happyDOM.abort());
  w.document.write(html);
  const timers=new Map();let next=0;
  w.setTimeout=(callback,delay)=>{const id=++next;timers.set(id,{callback,delay});return id;};
  w.clearTimeout=id=>timers.delete(id);
  w.eval(ui);
  w.toast('Changes saved.');
  const notice=w.document.getElementById('toast');
  assert.equal(notice.getAttribute('role'),'status');
  assert.equal(notice.textContent,'Changes saved.');
  assert.equal(notice.classList.contains('show'),true);
  assert.equal([...timers.values()][0].delay,3000);
  w.toast('Payment updated.');
  assert.equal(timers.size,1);
  assert.equal(notice.textContent,'Payment updated.');
  [...timers.values()][0].callback();
  assert.equal(notice.classList.contains('show'),false);
  assert.equal(notice.textContent,'');
});

test('member search explains no results and recovers when cleared', async t=>{
  const {w,d}=setup(t);
  d.querySelector('#accountsTable tbody').innerHTML='<tr><td>Ana Member</td></tr>';
  w.searchAccounts('missing');
  assert.match(d.querySelector('[data-search-empty]').textContent,/No matching members/);
  w.searchAccounts('Ana');
  assert.equal(d.querySelector('[data-search-empty]'),null);
  assert.equal(d.querySelector('#accountsTable tbody tr').hidden,false);
});

test('modal traps keyboard focus and restores the opening control',async t=>{
  const {w,d,hooks}=setup(t);hooks.seed('a');
  const opener=d.querySelector('#accounts .heading button');opener.focus();
  w.openModal('account');
  assert.equal(d.querySelector('#modal .modal').getAttribute('role'),'dialog');
  assert.equal(d.activeElement.id,'newMemberName');
  const last=d.querySelector('#modal .modal-foot .primary');last.focus();
  last.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));
  assert.equal(d.activeElement.id,'newMemberName');
  w.closeModal();assert.equal(d.activeElement,opener);
  assert.equal(d.body.classList.contains('dialog-open'),false);
});


test('payment settings update displayed amounts and disable unavailable methods',async t=>{
  const {d,hooks}=setup(t);hooks.seed('a');
  hooks.renderSettings({monthly_amount:250,payment_deadline:'Day 15',gcash_number:'09123456789',accept_gcash:false,accept_cash:true,show_fund_ledger:true});
  assert.match(d.querySelector('#dues .eyebrow').textContent,/250/);
  assert.equal(d.getElementById('payAmount').value,'250');
  assert.equal(d.getElementById('payMethod').value,'Cash');
  assert.equal(d.querySelector('#payMethod option').disabled,true);
});

test('total member count includes active members whose dues have not started',async t=>{
  const {d,hooks}=setup(t);hooks.seed('a');
  hooks.renderAdminDues([{id:'future',full_name:'Future Member',is_active:true,dues_start_month:'2026-12-01'}],[],'2026-11-01',{monthly_amount:100,dues_start_month:'2026-11-01'},[]);
  assert.equal(d.querySelectorAll('#funds .stat-val')[3].textContent,'1');
  assert.match(d.getElementById('followupMonthLabel').textContent,/Nov/);
});

test('member month picker excludes approved and pending payments but allows retrying rejected ones',async t=>{
  const {d,hooks}=setup(t);hooks.seed('a','member');
  const now=new Date();const month=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
  const picker=d.getElementById('memberReceiptMonth');picker.innerHTML=`<option value="${month}">Current month</option>`;
  const settings={monthly_amount:100,accept_gcash:true,payment_deadline:'Day 15',dues_start_month:month};
  for(const status of ['Approved','Pending']){
    hooks.renderMemberDues([{month,status,amount:100}],settings,{});
    assert.equal(picker.disabled,true);
    assert.equal(d.querySelector('#member-page-dues .pay-qr-copy .primary').disabled,true);
  }
  hooks.renderMemberDues([{month,status:'Rejected',amount:100}],settings,{});
  assert.equal(picker.disabled,false);
  assert.equal(d.querySelector('#member-page-dues .pay-qr-copy .primary').disabled,false);
});

test('inactive dues members stay in directory but are excluded from unpaid and cash selection',async t=>{
 const {d,hooks,mock}=setup(t);hooks.seed('a');
 const members=[{id:'active',full_name:'Active Person',is_active:true,dues_active:true},{id:'paused',full_name:'Paused Person',is_active:true,dues_active:false}];
 mock.query=()=>result(members);await hooks.loadAccounts();
 assert.match(d.querySelector('#accountsTable').textContent,/Paused Person/);
 assert.equal(d.querySelector('[data-dues-member="paused"]').textContent,'Set active');
 hooks.renderAdminDues(members,[],'2026-11-01',{monthly_amount:100,dues_start_month:'2026-01-01'},[]);
 assert.equal(d.getElementById('followupUnpaidCount').textContent,'1 members unpaid');
 assert.equal(d.getElementById('payMember').textContent.includes('Paused Person'),false);
 assert.equal(d.querySelectorAll('#funds .stat-val')[3].textContent,'2');
 hooks.renderMemberDues([],{monthly_amount:100,accept_gcash:true,dues_start_month:'2026-01-01'},members[1]);
 assert.equal(d.getElementById('memberDuesStatus').textContent,'Monthly dues inactive');
 assert.equal(d.querySelector('#member-page-dues .pay-qr-copy .primary').disabled,true);
});


test('admin login works without optional dues profile columns', async t => {
  const {d,hooks,mock,requests}=setup(t);
  mock.query=({table,columns,filters})=> {
    if(table==='profiles' && /dues_active|dues_start_month/.test(columns))
      return {data:null,error:{code:'42703',message:'column profiles.dues_active does not exist'}};
    if(table==='profiles') return result(filters.some(([key])=>key==='id') ? profile('a') : []);
    return result([]);
  };
  await hooks.activateUser(user('a'));
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(d.body.classList.contains('admin-auth'),true);
  assert.equal(d.body.classList.contains('authenticated'),true);
  assert.equal(requests.find(r=>r.table==='profiles').columns,'id,email,full_name,chapter_position,role,is_active');
  assert.equal(d.getElementById('toast').textContent.includes('does not exist'),false);
});
