import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.95.0';

const config = window.KABASALAN_SUPABASE;
const client = config?.url && config?.publishableKey
  ? createClient(config.url, config.publishableKey)
  : null;
window.portalSupabase = client;

// Only immutable, pre-login markup is retained. Never cache another user's DOM.
const privateTemplates = ['.shell', '#modal', '#chapterPostComposer'].map(selector => ({ selector, html: document.querySelector(selector).innerHTML }));
let sessionEpoch = 0;
let activeUserId = null;
let activeProfile = null;
let dataRevision = 0;
let signingOut = false;
let loginAttempt = 0;
let rejectUnexpectedSignIn = false;
let scheduleMembers = [];
let currentDuesSettings = null;
const officerPositions = ['GT','DGT','MWW','DMWW','MKS','MKC','AUDITOR'];
const effectiveDuesStart = (profile,settings) => profile?.dues_start_month || settings?.dues_start_month || null;
const duesHaveStarted = (profile,settings,month) => { const start=effectiveDuesStart(profile,settings); return !!start && month >= start; };
const sessionContext = () => ({ epoch: sessionEpoch, userId: activeUserId });
const isCurrent = context => !!context?.userId && context.epoch === sessionEpoch && context.userId === activeUserId;
const paymentRefreshNotice = document.getElementById('paymentRefreshNotice');
const retryPaymentRefresh = document.getElementById('retryPaymentRefresh');
function clearPrivateState(mode = 'public-mode') {
  ++sessionEpoch; ++dataRevision; activeUserId = null; activeProfile = null;
  scheduleMembers=[];currentDuesSettings=null;
  window.dispatchEvent(new Event('portal-session-reset'));
  for (const { selector, html } of privateTemplates) document.querySelector(selector).innerHTML = html;
  window.renderFeaturedActivity?.();
  document.querySelectorAll('.modal-back').forEach(el => el.classList.remove('open'));
  document.querySelectorAll('#loginPage input').forEach(input => { input.value = ''; });
  const toast = document.getElementById('toast'); toast.textContent = ''; toast.classList.remove('show');
  paymentRefreshNotice.hidden = true;
  retryPaymentRefresh.disabled = false;
  document.body.classList.remove('authenticated','admin-auth','member-auth','admin-mode','member-mode','public-mode','login-mode');
  document.body.classList.add(mode);
}
async function requireSession(admin = false) {
  const context = sessionContext();
  if (!isCurrent(context) || !activeProfile?.is_active || (admin && activeProfile.role !== 'admin')) throw new Error('Sign in with an active chapter account first.');
  const { data, error } = await client.auth.getUser();
  if (error || !isCurrent(context) || data.user?.id !== context.userId || (admin && data.user.app_metadata?.chapter_role !== 'admin')) throw new Error('Your session changed. Sign in again.');
  return { ...context, user: data.user };
}
function checkResult(result, label) { if (result.error) throw new Error(`${label}: ${result.error.message}`); return result.data; }

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
const toastMessage = message => { if (typeof window.toast === 'function') window.toast(message); else alert(message); };
const setSignedInUi = (profile, user) => {
  const isAdmin = user.app_metadata?.chapter_role === 'admin' && profile.role === 'admin';
  const isMember = user.app_metadata?.chapter_role === 'member' && profile.role === 'member';
  if (!isAdmin && !isMember) return client.auth.signOut().then(() => toastMessage('This account has no Kabasalan Chapter role. Contact the chapter administrator.'));
  document.body.classList.remove('public-mode', 'login-mode', 'member-mode', 'admin-mode', 'member-auth', 'admin-auth');
  document.body.classList.add('authenticated', isAdmin ? 'admin-auth' : 'member-auth', isAdmin ? 'admin-mode' : 'member-mode');
  document.querySelector('.shell')?.classList.remove('gate-hidden');
  const name = profile.full_name || user.email || 'Member';
  document.querySelectorAll('.profile .avatar').forEach(el => { el.textContent = name.split(/\s+/).map(part => part[0]).slice(0,2).join('').toUpperCase(); });
  document.querySelectorAll('.profile b').forEach(el => { el.textContent = name; });
  document.querySelectorAll('.profile small').forEach(el => { el.textContent = profile.chapter_position || 'Member'; });
  document.querySelectorAll('.member-hero h1').forEach(el => { el.textContent = `Welcome, ${name.split(' ')[0]}.`; });
  const account = document.querySelector('#member-page-account .member-account');
  if (account) account.innerHTML = `<div class="account-avatar">${escapeHtml(name.split(/\s+/).map(part => part[0]).slice(0,2).join('').toUpperCase())}</div><div><div class="eyebrow">ACTIVE MEMBER</div><h2>${escapeHtml(name)}</h2><p>Chapter position: ${escapeHtml(profile.chapter_position)}</p><p>Kabasalan Chapter</p></div><span class="badge">Active</span>`;
  if (isAdmin) window.navigate?.('overview');
  else window.memberGo?.('home');
  loadChapterPosts().catch(error => toastMessage(error.message || 'Chapter updates could not load. Please refresh and try again.'));
  loadPortalData().catch(error => toastMessage(error.message));
  if (isAdmin) loadAccounts().catch(error => toastMessage(error.message || 'Member accounts could not load. Please refresh and try again.'));
};

async function activateUser(user) {
  if (signingOut) return;
  if (activeUserId !== user.id) { clearPrivateState('login-mode'); activeUserId = user.id; }
  const context = sessionContext();
  // Login requires core account fields only; optional dues migrations must not block access.
  const { data: profile, error } = await client.from('profiles').select('id,email,full_name,chapter_position,role,is_active').eq('id', user.id).maybeSingle();
  if (!isCurrent(context)) return;
  if (error || !profile || !profile.is_active || !['admin','member'].includes(profile.role)) {
    clearPrivateState('login-mode');
    await client.auth.signOut();
    toastMessage(error ? `Could not verify your chapter profile: ${error.message}` : 'This login has no active Kabasalan Chapter account. Ask the chapter administrator.');
    return;
  }
  if (user.app_metadata?.chapter_role !== profile.role) { clearPrivateState('login-mode'); await client.auth.signOut(); return toastMessage('Your account role needs administrator attention.'); }
  const alreadyActive = activeProfile !== null;
  activeProfile = profile;
  if (!alreadyActive) setSignedInUi(profile, user);
}

async function loadChapterPosts() {
  if (!client) return;
  const { data, error } = await client.from('chapter_posts').select('id,caption,photo_paths,created_at').eq('is_published', true).order('created_at', { ascending: false });
  if (error) return;
  const posts = (data || []).map(post => ({
    ...post,
    photos: (post.photo_paths || []).map(path => client.storage.from('chapter-activities').getPublicUrl(path).data.publicUrl),
  }));
  renderPosts(posts);
}

function renderPosts(posts) {
  const dateText = value => new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium' }).format(new Date(value));
  const card = post => `<article class="activity-card">${(post.photos || []).map(photo => `<img src="${escapeHtml(photo)}" alt="Kabasalan Chapter activity" loading="lazy">`).join('')}<div class="activity-card-copy">${post.caption ? `<p>${escapeHtml(post.caption).replace(/\n/g, '<br>')}</p>` : ''}<small>Chapter activity · ${escapeHtml(dateText(post.created_at || post.createdAt))}</small></div></article>`;
  const empty = '<p class="public-empty">No chapter activities have been posted yet.</p>';
  const html = posts.length ? posts.map(card).join('') : empty;
  const publicFeed = document.getElementById('publicActivityGrid'); if (publicFeed) publicFeed.innerHTML = posts.length ? html : (document.querySelector('.undas-feature') ? '' : empty);
  const adminFeed = document.getElementById('adminPostsList'); if (adminFeed) adminFeed.innerHTML = posts.length ? `<div class="chapter-post-grid">${html}</div>` : '<p class="empty-state">No chapter posts yet. Published posts will also appear on the public landing page.</p>';
  const memberFeed = document.getElementById('memberPostFeed'); if (memberFeed) memberFeed.innerHTML = posts.length ? `<div class="chapter-post-grid">${html}</div>` : '<p class="empty-state">No chapter updates have been posted yet.</p>';
  const latestFeed = document.getElementById('memberLatestPost'); if (latestFeed) latestFeed.innerHTML = posts.length ? card(posts[0]) : empty;
  const featuredDate = document.querySelector('#activities .undas-feature time')?.dateTime;
  const featureIsLatest = !posts.length || (featuredDate && new Date(featuredDate) >= new Date(posts[0].created_at || posts[0].createdAt));
  if (featureIsLatest && latestFeed) latestFeed.replaceChildren();
  window.renderFeaturedActivity?.(featureIsLatest);
}

async function loadAccounts() {
  if (!client || !document.body.classList.contains('admin-auth')) return;
  const context = sessionContext();
  const { data, error } = await client.from('profiles').select('*').eq('role','member').order('full_name');
  if (!isCurrent(context)) return;
  if (error) return toastMessage(error.message);
  const body = document.querySelector('#accountsTable tbody');
  if (!body) return;
  body.innerHTML = data.length ? data.map(profile => `<tr><td><div class="member"><div class="mini-avatar">${escapeHtml(profile.full_name.split(/\s+/).map(part => part[0]).slice(0,2).join('').toUpperCase())}</div><div><b>${escapeHtml(profile.full_name)}</b></div></div></td><td>${escapeHtml(profile.email)}</td><td>${escapeHtml(profile.chapter_position)}</td><td><span class="badge">${profile.dues_active !== false ? 'Active' : 'Inactive'}</span></td><td><button type="button" class="secondary" data-dues-member="${escapeHtml(profile.id)}" data-next-active="${profile.dues_active === false}" aria-label="Change monthly dues status for ${escapeHtml(profile.full_name)}">${profile.dues_active === false ? 'Set active' : 'Set inactive'}</button></td></tr>`).join('') : '<tr><td colspan="5" class="empty-state">No member accounts yet. Create the first account.</td></tr>';
  body.querySelectorAll('[data-dues-member]').forEach(button => button.onclick = () => runAction(async () => {
    const context = await requireSession(true);
    checkResult(await client.rpc('portal_set_member_dues_active', {p_member_id:button.dataset.duesMember,p_active:button.dataset.nextActive === 'true'}), 'Member status could not save');
    if (!isCurrent(context)) return;
    await loadAccounts();
    await loadPublicMemberCount();
    if (!isCurrent(context)) return;
    await loadPortalData();
    if (isCurrent(context)) toastMessage('Monthly dues status saved. Member and payment history retained.');
  },button));
  window.searchAccounts?.(document.querySelector('#accounts .search')?.value || '');
}

const phMonth = date => new Intl.DateTimeFormat('en-PH', { month: 'long', year: 'numeric' }).format(date);
const monthKey = label => {
  if (!label || label === 'This month') { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`; }
  const date = new Date(`${label} 1`);
  return Number.isNaN(date.valueOf()) ? null : `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-01`;
};
const monthOptions = () => Array.from({length:12}, (_, index) => new Date(new Date().getFullYear(), new Date().getMonth()-index, 1));
function setMonthInputs() {
  const options = monthOptions().map(date => `<option value="${monthKey(phMonth(date))}">${escapeHtml(phMonth(date))}</option>`).join('');
  for (const id of ['memberReceiptMonth','payMonth','duesMonthPicker']) {
    const select = document.getElementById(id); if (!select) continue;
    const previous = select.value;
    select.innerHTML = options;
    if ([...select.options].some(option => option.value === previous)) select.value = previous;
    else select.selectedIndex = 0;
  }
  const duesPicker=document.getElementById('duesMonthPicker');if(duesPicker)duesPicker.onchange=()=>loadPortalData().catch(error=>toastMessage(error.message));
}
function monthLabelFor(value) { return phMonth(new Date(`${value}T00:00:00`)); }

async function loadPortalData(user, profile) {
  if (!client || !document.body.classList.contains('authenticated')) return;
  const context = sessionContext();
  const revision = ++dataRevision;
  const current = () => isCurrent(context) && revision === dataRevision;
  setMonthInputs();
  const settingsResult = await client.from('chapter_settings').select('*').eq('id', true).maybeSingle();
  if (!current()) return;
  const settings = checkResult(settingsResult, 'Payment settings could not load');
  if (!settings) throw new Error('Chapter payment settings are unavailable. The administrator must complete database setup.');
  currentDuesSettings=settings;
  const txResult = activeProfile.role === 'admin' || settings.show_fund_ledger
    ? await client.from('fund_transactions').select('*').order('occurred_at', {ascending:false})
    : { data:[], error:null };
  if (!current()) return;
  const transactions = checkResult(txResult, 'Chapter ledger could not load') || [];
  if (settings) renderSettings(settings);
  const authResult = await client.auth.getUser();
  if (!current()) return;
  const authData = checkResult(authResult, 'Could not verify your session');
  if (authData?.user?.id !== context.userId) throw new Error('Your session changed. Sign in again.');
  const isAdmin = document.body.classList.contains('admin-auth');
  const selectedMonth = document.getElementById('duesMonthPicker')?.value || monthKey('This month');
  const monthQuery = client.from('monthly_dues').select('*,profiles!member_id(full_name,email,chapter_position)').order('submitted_at',{ascending:false});
  const [duesResult, membersResult] = await Promise.all([
    isAdmin ? monthQuery.eq('month', selectedMonth) : client.from('monthly_dues').select('*').eq('member_id', authData.user.id).order('month',{ascending:false}),
    isAdmin ? client.from('profiles').select('*').eq('role','member').order('full_name') : client.from('profiles').select('*').eq('id',authData.user.id),
  ]);
  if (!current()) return;
  const dues = checkResult(duesResult, 'Dues could not load');
  const members = checkResult(membersResult, 'Member accounts could not load');
  scheduleMembers=members||[];
  renderFunds(transactions);
  if (isAdmin) renderAdminDues(members || [], dues || [], selectedMonth, settings, transactions);
  else {activeProfile={...activeProfile,...members?.[0]};renderMemberDues((dues || []), settings, activeProfile);}
  if (isAdmin) {
    renderDuesSchedule();
    const queueLoaded = await renderCloudReceiptQueue(context, revision);
    if (!current()) return;
    await loadOfficersEditor(context, revision);
    if (queueLoaded === false) throw new Error('Receipt queue could not load.');
  }
  if (current()) paymentRefreshNotice.hidden = true;
}

async function refreshAfterPayment(context) {
  const refresh = loadPortalData();
  const revision = dataRevision;
  try {
    await refresh;
  } catch {
    if (isCurrent(context) && revision === dataRevision) paymentRefreshNotice.hidden = false;
  }
}

retryPaymentRefresh.onclick = async () => {
  const context = sessionContext();
  if (!isCurrent(context) || retryPaymentRefresh.disabled) return;
  retryPaymentRefresh.disabled = true;
  try {
    await refreshAfterPayment(context);
  } finally {
    if (isCurrent(context)) retryPaymentRefresh.disabled = false;
  }
};

function renderSettings(settings) {
  const amount = Number(settings.monthly_amount || 100);
  const set = (id, value) => { const el=document.getElementById(id); if(el) el.value=value; };
  set('monthlyContribution',amount); set('paymentDeadline',settings.payment_deadline); set('gcashNumber',settings.gcash_number);
  const phone=document.getElementById('memberGcashNumber'); if(phone) phone.textContent=settings.gcash_number;
  const qrAmount=document.getElementById('adminQrAmount'); if(qrAmount) qrAmount.textContent=`Scan to pay ₱${amount.toLocaleString()} monthly dues`;
  const memberAmount=document.getElementById('memberQrAmount'); if(memberAmount) memberAmount.textContent=`Scan to pay ₱${amount.toLocaleString()}`;
  const payAmount=document.getElementById('memberReceiptAmount'); if(payAmount) payAmount.value=amount;
  const adminPhone=document.getElementById('adminQrPhone'); if(adminPhone) adminPhone.textContent=`GCash account · ${settings.gcash_number}`;
  if(settings.qr_path){ const url=client.storage.from('chapter-qr').getPublicUrl(settings.qr_path).data.publicUrl; for(const id of ['adminQrPreview']){const img=document.getElementById(id);if(img)img.src=url;} const memberImg=document.querySelector('#member-page-dues .pay-qr-row img');if(memberImg)memberImg.src=url; }
  document.querySelectorAll('.switch[data-setting]').forEach(button=>{const key={acceptGcash:'accept_gcash',acceptCash:'accept_cash',showLedger:'show_fund_ledger'}[button.dataset.setting];button.setAttribute('aria-pressed',String(!!settings[key]));});
  const gcashUpload=document.querySelector('#member-page-dues .pay-qr-copy .primary');if(gcashUpload)gcashUpload.disabled=!settings.accept_gcash;
  const cashOption=document.querySelector('#payMethod option[value="Cash"]');if(cashOption)cashOption.disabled=!settings.accept_cash;
  const method=document.getElementById('payMethod');
  if(method){for(const option of method.options)option.disabled=option.value==='Cash'?!settings.accept_cash:!settings.accept_gcash;
    if(method.selectedOptions[0]?.disabled)method.value=[...method.options].find(option=>!option.disabled)?.value||'';}
  const adminAmount=document.getElementById('payAmount');if(adminAmount && !document.getElementById('modal').classList.contains('open'))adminAmount.value=amount;
  const duesHeading=document.querySelector('#dues .heading .eyebrow');if(duesHeading)duesHeading.textContent=`Member contributions · ₱${amount.toLocaleString()} per month`;
  const contribution=document.querySelectorAll('#funds .balance-box b')[1];if(contribution)contribution.textContent=`₱${amount.toLocaleString()} per member`;
  const ledger=document.querySelector('.member-fund-ledger');if(ledger)ledger.hidden=!settings.show_fund_ledger;
}

function renderFunds(transactions) {
  const balance=transactions.reduce((sum,row)=>sum+(row.kind==='income'?1:-1)*Number(row.amount),0);
  const fmt=value=>`₱${Number(value||0).toLocaleString('en-PH',{minimumFractionDigits:0,maximumFractionDigits:2})}`;
  const fundsSection=document.querySelector('#funds');
  if(fundsSection){const stats=fundsSection.querySelectorAll('.stat-val');if(stats[0])stats[0].textContent=fmt(balance);if(stats[1])stats[1].textContent=fmt(transactions.filter(row=>row.kind==='income' && phMonth(new Date(row.occurred_at))===phMonth(new Date())).reduce((s,r)=>s+Number(r.amount),0));if(stats[2])stats[2].textContent=fmt(transactions.filter(row=>row.kind==='expense' && phMonth(new Date(row.occurred_at))===phMonth(new Date())).reduce((s,r)=>s+Number(r.amount),0));const list=fundsSection.querySelector('.ledger-list');if(list)list.innerHTML=transactions.length?transactions.map(row=>`<div class="ledger-row"><div><b>${escapeHtml(row.purpose)}</b><small>${escapeHtml(new Date(row.occurred_at).toLocaleString())}</small></div><strong style="color:${row.kind==='income'?'#67b57b':'#e97969'}">${row.kind==='expense'?'−':'+'}${fmt(row.amount)}</strong></div>`).join(''):'<p class="empty-state">No fund transactions recorded yet.</p>';}
  for(const el of document.querySelectorAll('.member-fund-total strong'))el.textContent=fmt(balance);
  document.querySelectorAll('#funds .balance-box b')[0].textContent=fmt(balance);
  const memberLedger=document.querySelector('.member-fund-ledger');if(memberLedger){const list=memberLedger.querySelector('.section-title')?.nextElementSibling;if(list)list.innerHTML=transactions.length?transactions.map(row=>`<div class="ledger-row"><div><b>${escapeHtml(row.purpose)}</b><small>${escapeHtml(new Date(row.occurred_at).toLocaleDateString())}</small></div><strong>${row.kind==='expense'?'−':'+'}${fmt(row.amount)}</strong></div>`).join(''):'<p class="empty-state">No fund activity has been recorded yet.</p>';}
}

function renderAdminDues(members, dues, selectedMonth, settings, transactions) {
  const byMember=new Map(dues.map(row=>[row.member_id,row]));
  const active=members.filter(member=>member.is_active && member.dues_active !== false && duesHaveStarted(member,settings,selectedMonth));
  const paid=active.filter(member=>byMember.get(member.id)?.status==='Approved').length;
  const pending=active.filter(member=>byMember.get(member.id)?.status==='Pending').length;
  const unpaid=active.length-paid-pending;
  const amount=Number(settings?.monthly_amount||100);
  const fmt=value=>`₱${Number(value||0).toLocaleString('en-PH',{maximumFractionDigits:2})}`;
  const overviewStats=document.querySelectorAll('#overview .stats .stat-val');
  if(overviewStats[0])overviewStats[0].textContent=fmt(transactions.reduce((sum,row)=>sum+(row.kind==='income'?1:-1)*Number(row.amount),0));
  if(overviewStats[1])overviewStats[1].innerHTML=`${paid} <span style="font-size:14px;color:#92978e">/ ${active.length}</span>`;
  if(overviewStats[2])overviewStats[2].innerHTML=`${unpaid} <span style="font-size:14px;color:#92978e">members</span>`;
  if(overviewStats[3])overviewStats[3].textContent=fmt(amount);
  const percent=active.length?Math.round(paid*100/active.length):0;
  const paidCaption=document.querySelector('#overview .stats .stat:nth-child(2) .stat-sub');if(paidCaption)paidCaption.textContent=`${percent}% of active members`;
  const deadlineCaption=document.querySelector('#overview .stats .stat:nth-child(4) .stat-sub');if(deadlineCaption)deadlineCaption.textContent=`Due ${settings?.payment_deadline||'last day of each month'}`;
  const collection=document.querySelector('#overview .collection');
  const total=dues.filter(row=>row.status==='Approved').reduce((sum,row)=>sum+Number(row.amount),0); if(collection){const donut=collection.querySelector('.donut-inner');if(donut)donut.innerHTML=`<b>${fmt(total)}</b><small>of ${fmt(active.length*amount)}</small>`;const ring=collection.querySelector('.donut');if(ring)ring.style.background=`conic-gradient(#c7ae65 ${percent}%,#344437 0)`;const legend=collection.querySelector('.legend');if(legend)legend.innerHTML=`<p>Collected <b>${fmt(total)}</b></p><p>Expected balance <b>${fmt(Math.max(0,active.length*amount-total))}</b></p>`;}
  const dueSummary=document.querySelector('#overview .due-summary');if(dueSummary){const count=dueSummary.querySelector('#followupUnpaidCount');if(count)count.textContent=`${unpaid} members unpaid`;const outstanding=dueSummary.querySelector('#followupUnpaidTotal');if(outstanding)outstanding.textContent=fmt(unpaid*amount);const rate=dueSummary.querySelector('#followupRate');if(rate)rate.textContent=`Monthly contribution · ${fmt(amount)} each`;}
  const list=document.getElementById('followupUnpaidList');if(list){const missing=active.filter(member=>byMember.get(member.id)?.status!=='Approved').filter(member=>byMember.get(member.id)?.status!=='Pending');list.innerHTML=missing.length?missing.map(member=>`<div class="due-item"><b>${escapeHtml(member.full_name)}</b><small>${escapeHtml(member.chapter_position)}</small></div>`).join(''):'<p class="followup-empty">No unpaid members for this month.</p>';}
  const table=document.querySelector('#duesTable tbody');if(table){table.innerHTML=active.length?active.map(member=>{const row=byMember.get(member.id);const status=row?.status||'Unpaid';const proof=row?.proof_path?`<button class="proof" type="button" data-proof="${escapeHtml(row.proof_path)}">View proof ↗</button>`:'—';const stamp=row?.paid_at||row?.submitted_at;return `<tr data-status="${status==='Approved'?'paid':status==='Rejected'?'unpaid':status.toLowerCase()}"><td><div class="member"><div class="mini-avatar">${escapeHtml(member.full_name.split(/\s+/).map(part=>part[0]).slice(0,2).join('').toUpperCase())}</div><div><b>${escapeHtml(member.full_name)}</b><small>${escapeHtml(member.email)}</small></div></div></td><td>${escapeHtml(member.chapter_position)}</td><td>${escapeHtml(monthLabelFor(selectedMonth))}</td><td>${fmt(row?.amount||amount)}</td><td>${escapeHtml(row?.method||'—')}</td><td>${stamp?escapeHtml(new Date(stamp).toLocaleString()):'—'}</td><td>${proof}</td><td><span class="badge ${status==='Pending'?'pending':status==='Rejected'?'late':''}">${status==='Approved'?'Paid':escapeHtml(status)}</span></td><td>${!row||status==='Rejected'?`<button class="secondary" data-cash-member="${member.id}">Record cash</button>`:''}</td></tr>`}).join(''):'<tr><td colspan="9" class="empty-state">No active member accounts yet.</td></tr>';table.querySelectorAll('[data-proof]').forEach(button=>button.onclick=()=>runAction(()=>openPrivateProof(button.dataset.proof),button));table.querySelectorAll('[data-cash-member]').forEach(button=>button.onclick=()=>{window.openModal('payment');document.getElementById('payMember').value=button.dataset.cashMember;});}
  const latest=document.getElementById('latestPaymentFeed');if(latest){const rows=dues.filter(row=>row.status==='Pending'||row.status==='Approved').slice(0,4);latest.innerHTML=rows.length?rows.map(row=>`<div class="latest-payment"><div><b>${escapeHtml(row.profiles?.full_name||'Member')}</b><small>${escapeHtml(monthLabelFor(row.month))} · ${escapeHtml(row.method)}</small></div><strong>${fmt(row.amount)}</strong><span class="badge ${row.status==='Pending'?'pending':''}">${row.status==='Pending'?'Pending review':'Paid'}</span></div>`).join(''):'<p class="empty-state">No new member payments have been submitted.</p>';}
  const payMember=document.getElementById('payMember');
  const memberSearch=document.getElementById('payMemberSearch');
  if(payMember){
    const filterMembers=()=>{
      const selected=payMember.value;
      const query=(memberSearch?.value||'').trim().toLocaleLowerCase();
      const matches=active.filter(member=>(member.full_name+' '+(member.email||'')).toLocaleLowerCase().includes(query));
      payMember.innerHTML='<option value="">Select a member</option>'+matches.map(member=>'<option value="'+member.id+'">'+escapeHtml(member.full_name)+(member.email?' — '+escapeHtml(member.email):'')+'</option>').join('');
      if(matches.some(member=>member.id===selected))payMember.value=selected;
      payMember.disabled=matches.length===0;
      const hint=document.getElementById('payMemberHint');
      if(hint)hint.textContent=!active.length?'No active member accounts with scheduled dues yet.':!matches.length?'No matching member accounts. Try another name or email.':matches.length+' member accounts available. Select a member below.';
    };
    if(memberSearch)memberSearch.oninput=filterMembers;
    filterMembers();
  }
  document.querySelectorAll('#dues .stat-val').forEach((el,index)=>{if(index===0)el.textContent=`${paid} / ${active.length}`;if(index===1)el.textContent=fmt(total);if(index===2)el.textContent=String(unpaid);if(index===3)el.textContent=fmt(amount);});
  const monthLabel=document.getElementById('followupMonthLabel');if(monthLabel)monthLabel.textContent=monthLabelFor(selectedMonth);
  const recent=document.querySelector('#overview .table-wrap tbody');
  if(recent)recent.innerHTML=dues.length?dues.slice(0,10).map(row=>`<tr><td>${escapeHtml(row.profiles?.full_name||'Member')}</td><td>${escapeHtml(monthLabelFor(row.month))}</td><td>${fmt(row.amount)}</td><td>${escapeHtml(row.method||'—')}</td><td>${row.paid_at?escapeHtml(new Date(row.paid_at).toLocaleString()):'—'}</td><td>${escapeHtml(row.status)}</td></tr>`).join(''):'<tr><td colspan="6" class="empty-state">No payment activity recorded for this month.</td></tr>';
  const collectedCaption=document.querySelector('#overview .stat .stat-sub');if(collectedCaption)collectedCaption.textContent=`${fmt(total)} collected for ${monthLabelFor(selectedMonth)}`;
  const membersStat=document.querySelectorAll('#funds .stat-val')[3];if(membersStat)membersStat.textContent=String(members.length);
  const followupMonth=document.getElementById('followupMonthLabel');if(followupMonth)followupMonth.textContent=monthLabelFor(selectedMonth);
  const fundCaptions=document.querySelectorAll('#funds .stat-sub');
  if(fundCaptions[0])fundCaptions[0].textContent=`${transactions.length} recorded transaction(s)`;
  if(fundCaptions[1])fundCaptions[1].textContent=phMonth(new Date());
  if(fundCaptions[2])fundCaptions[2].textContent=phMonth(new Date());
  if(fundCaptions[3])fundCaptions[3].textContent='Active chapter members';
  for(const [filter,label,count] of [['all','All members',active.length],['paid','Paid',paid],['unpaid','Unpaid',unpaid],['pending','Pending review',pending]]){const tab=document.querySelector(`#dues [data-filter="${filter}"]`);if(tab)tab.textContent=`${label} · ${count}`;}
  window.filterRows?.();
  const info=document.getElementById('duesScheduleStatus');
  if(info)info.textContent=settings?.dues_start_month?`Chapter dues start ${monthLabelFor(settings.dues_start_month)}. ${members.filter(m=>m.is_active).length-active.length} member(s) not scheduled for this month.`:'No chapter start is set. Set the chapter start month or an individual start in Dues schedule.';
}

function renderMemberDues(rows, settings, profile) {
  const amount=Number(settings?.monthly_amount||100);const current=monthKey('This month');const thisMonth=rows.find(row=>row.month===current);
  const status=thisMonth?.status||'Unpaid';const statusEl=document.getElementById('memberDuesStatus');if(statusEl)statusEl.textContent=status==='Approved'?'Paid':status==='Pending'?'Pending admin review':status==='Rejected'?'Receipt rejected · upload again':'Unpaid';
  const started=profile?.dues_active !== false && duesHaveStarted(profile,settings,current), start=effectiveDuesStart(profile,settings);
  if(statusEl && !started && !thisMonth)statusEl.textContent=start?`Starts ${monthLabelFor(start)}`:'Dues not scheduled yet';
  const picker=document.getElementById('memberReceiptMonth');
  if(picker){for(const option of picker.options)option.disabled=profile?.dues_active === false || !start || option.value<start || rows.some(row=>row.month===option.value&&['Pending','Approved'].includes(row.status));const selected=[...picker.options].find(o=>o.value===picker.value&&!o.disabled)||[...picker.options].find(o=>!o.disabled);picker.value=selected?.value||'';picker.disabled=!selected;}
  const submit=document.querySelector('#member-page-dues .pay-qr-copy .primary');if(submit){submit.disabled=!started||!settings.accept_gcash||picker?.disabled;submit.title=!settings.accept_gcash?'GCash payments are currently disabled.':picker?.disabled?'No unpaid months are available for submission.':'';}
  const history=document.querySelector('#member-history tbody');if(history){history.innerHTML=rows.length?rows.map(row=>`<tr><td>${escapeHtml(monthLabelFor(row.month))}</td><td>₱${Number(row.amount).toLocaleString()}</td><td>${escapeHtml(row.method)}</td><td>${row.paid_at?escapeHtml(new Date(row.paid_at).toLocaleString()):'—'}</td><td><span class="badge ${row.status==='Pending'?'pending':row.status==='Rejected'?'late':''}">${row.status==='Approved'?'Paid':escapeHtml(row.status)}</span></td></tr>`).join(''):'<tr><td colspan="5" class="empty-state">No payment history yet.</td></tr>';}
  const balance=document.querySelector('.member-balance strong');if(balance)balance.textContent=`₱${rows.filter(row=>row.status==='Approved').reduce((sum,row)=>sum+Number(row.amount),0).toLocaleString()}`;
  const amountInput=document.getElementById('memberReceiptAmount');if(amountInput)amountInput.value=amount;
  const statuses=document.querySelectorAll('#member-page-home .member-status');
  if(statuses[0]){statuses[0].querySelector('b').textContent=status==='Approved'?'This month paid':status==='Pending'?'Payment under review':status==='Rejected'?'Receipt rejected':'This month unpaid';statuses[0].querySelector('small').textContent=monthLabelFor(current);}
  if(statuses[0]&&!started&&!thisMonth){statuses[0].querySelector('b').textContent=start?'Dues have not started':'Dues not scheduled';statuses[0].querySelector('small').textContent=start?`Starts ${monthLabelFor(start)}`:'Your administrator will set the start month.';}
  if(statuses[1])statuses[1].querySelector('small').textContent=`₱${amount.toLocaleString()} · ${settings.payment_deadline}`;
  if(profile?.dues_active === false){
    if(statusEl)statusEl.textContent='Monthly dues inactive';
    if(statuses[0]){statuses[0].querySelector('b').textContent='Monthly dues inactive';statuses[0].querySelector('small').textContent='You remain a member. Monthly payments are paused.';}
  }
  const caption=document.querySelector('.member-balance span');if(caption)caption.textContent=`${rows.filter(row=>row.status==='Approved').length} approved contribution(s)`;
}

async function openPrivateProof(path) {
  const context = await requireSession();
  const {data,error}=await client.storage.from('payment-proofs').createSignedUrl(path,60);
  if (!isCurrent(context)) return;
  if(error)return toastMessage(error.message);
  window.open(data.signedUrl,'_blank','noopener');
}

async function renderCloudReceiptQueue(context = sessionContext(), revision = dataRevision) {
  const box=document.getElementById('receiptQueueList');if(!box||!client)return;
  const month=document.getElementById('duesMonthPicker')?.value||monthKey('This month');
  const {data,error}=await client.from('monthly_dues').select('*,profiles!member_id(full_name,email,chapter_position)').eq('month',month).order('submitted_at',{ascending:false});
  if (!isCurrent(context) || revision !== dataRevision) return;
  if(error){box.innerHTML=`<p class="empty-state">${escapeHtml(error.message)}</p>`;return false;}
  const receipts=(data||[]).filter(row=>row.proof_path);
  const html=receipts.length?(await Promise.all(receipts.map(async row=>{const {data:urlData}=await client.storage.from('payment-proofs').createSignedUrl(row.proof_path,60);return `<div class="receipt-row"><div class="receipt-main"><b>${escapeHtml(row.profiles?.full_name||'Member')}</b><small>${escapeHtml(row.profiles?.email||'')} · ${escapeHtml(monthLabelFor(row.month))} · ${escapeHtml(row.method)} · ₱${Number(row.amount).toFixed(2)}</small><small>Submitted ${escapeHtml(new Date(row.submitted_at).toLocaleString())}</small><div class="receipt-statusline"><span class="badge ${row.status==='Pending'?'pending':row.status==='Rejected'?'late':''}">${escapeHtml(row.status)}</span>${urlData?`<a class="proof" href="${escapeHtml(urlData.signedUrl)}" target="_blank" rel="noopener">View proof ↗</a>`:''}</div></div>${urlData?`<a href="${escapeHtml(urlData.signedUrl)}" target="_blank" rel="noopener"><img class="receipt-thumb" src="${escapeHtml(urlData.signedUrl)}" alt="Receipt from ${escapeHtml(row.profiles?.full_name)}"></a>`:''}${row.status==='Pending'?`<div class="receipt-actions"><button class="primary" data-review-id="${row.id}" data-review-status="Approved">Approve payment</button><button class="secondary" data-review-id="${row.id}" data-review-status="Rejected">Reject</button></div>`:''}</div>`}))).join(''):'<p class="empty-state">No member receipts submitted for this month.</p>';
  if (!isCurrent(context) || revision !== dataRevision) return;
  box.innerHTML=html;
  box.querySelectorAll('[data-review-id]').forEach(button => {
    const { reviewId, reviewStatus } = button.dataset;
    const actions = button.closest('.receipt-actions');
    const otherButton = [...actions.querySelectorAll('button')].find(item => item !== button);
    button.onclick = () => runAction(async () => {
      otherButton.disabled = true;
      try {
        await reviewCloudDues(reviewId, reviewStatus, box);
      } finally {
        otherButton.disabled = false;
      }
    }, button, `receipt-review:${reviewId}`);
  });
}

async function reviewCloudDues(id, status, box) {
  const context = await requireSession(true);
  if (!['Approved','Rejected'].includes(status)) throw new Error('Choose approve or reject.');
  const result = await client.rpc('portal_review_dues', { p_id:id, p_status:status });
  if (!isCurrent(context)) return;
  checkResult(result, 'Payment review failed');
  const reviewedButton = [...box.querySelectorAll('[data-review-id]')].find(button => button.dataset.reviewId === id);
  if (reviewedButton) {
    const badge = reviewedButton.closest('.receipt-row').querySelector('.receipt-statusline .badge');
    badge.textContent = status;
    badge.classList.remove('pending');
    badge.classList.toggle('late', status === 'Rejected');
    reviewedButton.closest('.receipt-actions').remove();
  }
  toastMessage(status === 'Approved' ? 'Payment approved and added to chapter funds.' : 'Receipt rejected.');
  await refreshAfterPayment(context);
}

function validAmount(value) { const amount=Number(value); if(!Number.isSafeInteger(amount)||amount<=0||amount>2147483647) throw new Error('Enter a positive whole-peso amount.'); return amount; }
function validMonth(value) { if(!/^\d{4}-\d{2}-01$/.test(value)||!Number.isFinite(Date.parse(value))) throw new Error('Choose a valid payment month.'); return value; }
async function uploadProof(file, context, folder) {
  if (!file) return null;
  if (!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>5_000_000) throw new Error('Receipt must be JPG, PNG, or WebP, up to 5 MB.');
  if (!isCurrent(context)) throw new Error('Your session changed.');
  const path=`${context.userId}/${folder}/${crypto.randomUUID()}.${file.type.split('/')[1].replace('jpeg','jpg')}`;
  checkResult(await client.storage.from('payment-proofs').upload(path,file,{contentType:file.type,upsert:false}), 'Receipt upload failed');
  return path;
}
async function sendCloudReceipt(fileName) {
  const context=await requireSession();
  if(activeProfile.role!=='member') throw new Error('Sign in as a member to submit a receipt.');
  const input=document.getElementById('memberReceipt');const file=input.files?.[0];if(!file) throw new Error('Choose a receipt image first.');
  const month=validMonth(document.getElementById('memberReceiptMonth').value);
  const amount=validAmount(document.getElementById('memberReceiptAmount').value);
  const path=await uploadProof(file,context,month);
  if(!isCurrent(context))return;
  const result=await client.rpc('portal_submit_dues',{p_month:month,p_amount:amount,p_proof_path:path});
  if(!isCurrent(context))return;
  if(result.error){await client.storage.from('payment-proofs').remove([path]);throw new Error(result.error.message);}
  document.getElementById('receiptState').replaceChildren();document.getElementById('receiptState').hidden=true;input.value='';
  toastMessage('Receipt submitted for administrator review.');
  await refreshAfterPayment(context);
}

window.handleSignIn = async event => {
  event.preventDefault();
  if (!client) return toastMessage('Portal cloud sign-in is not configured.');
  const inputs = event.currentTarget.querySelectorAll('input');
  const button = event.currentTarget.querySelector('button[type="submit"]');
  if (button.disabled) return;
  const originalLabel = button.innerHTML;
  const attempt=++loginAttempt;rejectUnexpectedSignIn=false;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.innerHTML = '<span class="sign-in-spinner" aria-hidden="true"></span><span role="status">Signing in…</span>';
  try {
    const { data, error } = await client.auth.signInWithPassword({ email: inputs[0].value.trim(), password: inputs[1].value });
    if(attempt!==loginAttempt)return;
    if (error) throw error;
    if (activeUserId !== data.user.id) { clearPrivateState('login-mode'); activeUserId=data.user.id; }
    await activateUser(data.user);
  } catch (error) { if(attempt===loginAttempt)toastMessage(error.message || 'Sign-in failed.'); }
  finally { button.disabled = false; button.removeAttribute('aria-busy'); button.innerHTML = originalLabel; }
};

window.signOutChapter = async () => {
  if (signingOut || !window.confirm('Are you sure you want to sign out?')) return;
  ++loginAttempt;rejectUnexpectedSignIn=true;signingOut=true; clearPrivateState(); window.scrollTo(0,0);
  try { if(client) { const {error}=await client.auth.signOut(); if(error)toastMessage('This page was cleared. Sign-out could not finish; close this tab before sharing the device.'); } }
  finally { signingOut=false; }
};


window.saveModal = async () => {
  const accountMode = document.getElementById('accountFields')?.style.display === 'block';
  const paymentMode = document.getElementById('paymentFields')?.style.display === 'block';
  const expenseMode = document.getElementById('expenseFields')?.style.display === 'block';
  if (!accountMode && paymentMode) return recordAdminPayment();
  if (!accountMode && expenseMode) return recordChapterExpense();
  if (!accountMode) return;
  if (!client || !document.body.classList.contains('admin-auth')) return toastMessage('Only a signed-in chapter administrator can create a member account.');
  const context=await requireSession(true);
  const payload = {
    full_name: document.getElementById('newMemberName').value.trim(),
    email: document.getElementById('newMemberEmail').value.trim(),
    password: document.getElementById('newMemberPassword').value,
    chapter_position: 'Member',
  };
  if(payload.full_name.length<2 || payload.full_name.length>120)throw new Error('Enter a member name between 2 and 120 characters.');
  if(payload.email.length>254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email))throw new Error('Enter a valid member email address.');
  if(payload.password.length<8 || payload.password.length>128)throw new Error('Use an initial password between 8 and 128 characters.');
  const button = document.querySelector('#modal .modal-foot .primary');
  button.disabled = true;
  try {
    const { error } = await client.functions.invoke('create-chapter-member', { body: payload });
    if(!isCurrent(context))return;
    if (error) {
      let detail;
      try { detail=await error.context?.json?.(); } catch { /* Keep the SDK error when no JSON response exists. */ }
      throw new Error(detail?.error || detail?.message || error.message);
    }
    document.getElementById('newMemberName').value = '';
    document.getElementById('newMemberEmail').value = '';
    document.getElementById('newMemberPassword').value = '';
    document.getElementById('newMemberPosition').value = 'Member';
    window.closeModal();
    await loadAccounts();
    await loadPublicMemberCount();
    await loadPortalData();
    if(isCurrent(context))toastMessage('Member login created. Share the initial password with the member privately.');
  } catch (error) { if(isCurrent(context))toastMessage(error.message || 'Member account could not be created.'); }
  finally { button.disabled = false; }
};

async function recordAdminPayment() {
  const context=await requireSession(true);
  const memberId=document.getElementById('payMember').value;
  const month=validMonth(document.getElementById('payMonth').value);
  const amount=validAmount(document.getElementById('payAmount').value);
  const method=document.getElementById('payMethod').value;
  if(!memberId || !['Cash','GCash'].includes(method))throw new Error('Select a member and payment method.');
  if(currentDuesSettings && !(method==='Cash'?currentDuesSettings.accept_cash:currentDuesSettings.accept_gcash))throw new Error(`${method} payments are disabled. Choose another payment method.`);
  const path=await uploadProof(document.getElementById('adminPaymentProof').files?.[0],context,'walk-in');
  if(!isCurrent(context))return;
  const result=await client.rpc('portal_record_payment',{p_member_id:memberId,p_month:month,p_amount:amount,p_method:method,p_proof_path:path});
  if(!isCurrent(context))return;
  if(result.error){if(path)await client.storage.from('payment-proofs').remove([path]);throw new Error(result.error.message);}
  window.closeModal();document.getElementById('adminPaymentProof').value='';
  toastMessage('Payment and chapter income recorded together.');
  await refreshAfterPayment(context);
}
async function recordChapterExpense() {
  const context=await requireSession(true);
  const fields=[...document.querySelectorAll('#expenseFields input')];
  const description=fields[0].value.trim(),amount=validAmount(fields[1].value),date=fields[2].value,purpose=fields[3].value.trim();
  if(!description||!purpose||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date)))throw new Error('Enter the description, date and purpose.');
  const path=await uploadProof(fields[4].files?.[0],context,'expenses');
  if(!isCurrent(context))return;
  const result=await client.rpc('portal_record_expense',{p_amount:amount,p_purpose:`${description} · ${purpose}`,p_date:date,p_receipt_path:path});
  if(!isCurrent(context))return;
  if(result.error){if(path)await client.storage.from('payment-proofs').remove([path]);throw new Error(result.error.message);}
  window.closeModal();fields.forEach(field=>field.value='');await loadPortalData();
  if(isCurrent(context))toastMessage('Expense saved to the chapter ledger.');
}

window.saveChapterSettings = async () => {
  const context=await requireSession(true);
  const amount=Number(document.getElementById('monthlyContribution').value);const deadline=document.getElementById('paymentDeadline').value.trim();const phone=document.getElementById('gcashNumber').value.trim();
  validAmount(amount);
  if(!deadline||!/^09\d{9}$/.test(phone))throw new Error('Enter the deadline and an 11-digit GCash number starting with 09.');
  const {error}=await client.from('chapter_settings').update({monthly_amount:amount,payment_deadline:deadline,gcash_number:phone,updated_at:new Date().toISOString(),updated_by:context.userId}).eq('id',true);
  if(!isCurrent(context))return;
  if(error)throw error;document.getElementById('settingsSaveNote').textContent='Payment settings saved for the chapter.';await loadPortalData();if(isCurrent(context))toastMessage('Chapter payment settings saved.');
};

window.previewChapterQr = async input => {
  const context=await requireSession(true);
  const file=input.files?.[0];if(!file)return;
  if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>2_500_000){input.value='';return toastMessage('Choose a JPG, PNG, or WebP QR image up to 2.5 MB.');}
  const path=`chapter/gcash-qr.${file.type.split('/')[1].replace('jpeg','jpg')}`;
  const {error}=await client.storage.from('chapter-qr').upload(path,file,{contentType:file.type,upsert:true});if(error)return toastMessage(error.message);
  if(!isCurrent(context))return;
  const {error:saveError}=await client.from('chapter_settings').update({qr_path:path,updated_by:context.userId,updated_at:new Date().toISOString()}).eq('id',true);
  if(!isCurrent(context))return;
  if(saveError)throw saveError;await loadPortalData();if(isCurrent(context))toastMessage('Chapter GCash QR updated.');
};

document.addEventListener('click',event=>{
  const button=event.target.closest('.switch[data-setting]');if(!button||!client)return;
  event.preventDefault();event.stopImmediatePropagation();
  const key={acceptGcash:'accept_gcash',acceptCash:'accept_cash',showLedger:'show_fund_ledger'}[button.dataset.setting];
  runAction(async()=>{
    const context=await requireSession(true);
    const data=checkResult(await client.from('chapter_settings').select(key).eq('id',true).single(),'Could not read setting');
    if(!isCurrent(context))return;
    checkResult(await client.from('chapter_settings').update({[key]:!data[key]}).eq('id',true),'Could not save setting');
    if(isCurrent(context)) {
      await loadPortalData();
      const label={acceptGcash:'GCash payments',acceptCash:'Cash payments',showLedger:'Member fund ledger'}[button.dataset.setting];
      if(isCurrent(context))toastMessage(`${label} ${data[key]?'disabled':'enabled'}. Changes saved.`);
    }
  },button);
},true);
window.sendMemberReceipt = sendCloudReceipt;
window.renderReceiptQueue = renderCloudReceiptQueue;
window.reviewReceipt = (id,status) => runAction(()=>reviewCloudDues(id,status),null,`review-${id}`);

// Receipt image retention must never change an approved financial record.
// No destructive cleanup runs merely because an administrator opens the portal.

window.publishChapterPost = async () => {
  const context=await requireSession(true);
  if (!client || !document.body.classList.contains('admin-auth')) return toastMessage('Sign in as chapter administrator to publish activities.');
  const caption = document.getElementById('chapterPostCaption').value.trim();
  const files = [...(document.getElementById('chapterPostPhotos').files || [])];
  if (!caption && !files.length) return toastMessage('Add a caption or at least one photo.');
  if (files.length > 5) return toastMessage('Choose up to five photos.');
  const button = document.querySelector('#chapterPostComposer .modal-foot .primary');
  button.disabled = true; button.textContent = 'Uploading…';
  try {
    const user=context.user;
    const paths = [];
    for (const file of files) {
      if (!['image/jpeg','image/png','image/webp'].includes(file.type) || file.size > 8_000_000) throw new Error('Photos must be JPG, PNG, or WebP, up to 8 MB each.');
      const path = `${user.id}/${crypto.randomUUID()}.${file.type.split('/')[1].replace('jpeg','jpg')}`;
      const { error } = await client.storage.from('chapter-activities').upload(path, file, { contentType: file.type, upsert: false });
      if (error) throw error;
      if (!isCurrent(context)) return;
      paths.push(path);
    }
    const { error } = await client.from('chapter_posts').insert({ caption, photo_paths: paths, created_by: user.id, is_published: true });
    if (!isCurrent(context)) return;
    if (error) throw error;
    document.getElementById('chapterPostCaption').value = '';
    document.getElementById('chapterPostPhotos').value = '';
    document.getElementById('chapterPostPreview').replaceChildren();
    window.closeChapterPostComposer();
    await loadChapterPosts();
    if(isCurrent(context))toastMessage('Chapter activity is now visible on the public landing page.');
  } catch (error) { if(isCurrent(context))toastMessage(error.message || 'Could not publish activity.'); }
  finally { button.disabled = false; button.textContent = 'Publish update'; }
};

async function loadPublicMemberCount() {
  if (!client) return;
  const count = document.getElementById('publicMemberCount');
  if (!count) return;
  try {
    const { data, error } = await client.rpc('portal_public_member_count');
    if (error || data === null || !Number.isSafeInteger(Number(data)) || Number(data) < 0) throw new Error('Count unavailable');
    count.textContent = Number(data).toLocaleString('en-PH');
    count.removeAttribute('title');
  } catch {
    count.textContent = '—';
    count.title = 'Member count is temporarily unavailable';
  }
}

async function loadPublicOfficers() {
  const result=await client.from('chapter_officers').select('position,display_name,sort_order,updated_at').order('sort_order');
  const box=document.getElementById('publicOfficersGrid');
  if(result.error){if(box)box.textContent='Chapter leadership is temporarily unavailable.';return;}
  if(box)box.innerHTML=(result.data||[]).map(row=>`<article class="officer-card"><span>${escapeHtml(row.position)}</span><h3>${escapeHtml(row.display_name)}</h3></article>`).join('');
}
async function loadOfficersEditor(context=sessionContext(), revision=dataRevision) {
  if(!isCurrent(context)||activeProfile?.role!=='admin')return;
  const [officersResult,accountsResult]=await Promise.all([
    client.from('chapter_officers').select('*').order('sort_order'),
    client.from('profiles').select('id,full_name,role,is_active').eq('is_active',true).order('full_name'),
  ]);
  if(!isCurrent(context) || revision !== dataRevision)return;
  const officers=checkResult(officersResult,'Officers could not load'),accounts=checkResult(accountsResult,'Account choices could not load');
  document.getElementById('officersEditor').innerHTML=officers.map(row=>`<div class="officer-edit" data-position="${escapeHtml(row.position)}"><h3>${escapeHtml(row.position)}</h3><label>Link chapter account (optional)</label><select data-officer-account aria-label="Link account for ${escapeHtml(row.position)}"><option value="">Name only · no account linked</option>${accounts.map(account=>`<option value="${escapeHtml(account.id)}" ${account.id===row.member_id?'selected':''}>${escapeHtml(account.full_name)}</option>`).join('')}</select><label>Public officer name</label><input data-officer-name aria-label="Public name for ${escapeHtml(row.position)}" type="text" required minlength="2" maxlength="120" value="${escapeHtml(row.display_name)}"></div>`).join('');
}
function renderDuesSchedule() {
  const settings=currentDuesSettings;if(!settings)return;
  document.getElementById('chapterDuesStart').value=settings.dues_start_month?.slice(0,7)||'';
  document.getElementById('chapterDuesStartNote').textContent=settings.dues_start_month?`Everyone follows ${monthLabelFor(settings.dues_start_month)} unless an individual start is set below.`:'Not scheduled. Set a chapter start month, or set individual starts below.';
  const box=document.getElementById('memberStartEditor');
  const members=scheduleMembers.filter(member=>member.is_active);
  box.innerHTML=members.length?members.map(member=>{const start=effectiveDuesStart(member,settings);return `<form class="member-start-row" data-member-start="${escapeHtml(member.id)}"><div><b>${escapeHtml(member.full_name)}</b><small>${escapeHtml(member.chapter_position||'Member')} · ${start?`Starts ${escapeHtml(monthLabelFor(start))}`:'Not scheduled'}</small></div><input type="month" aria-label="Start month for ${escapeHtml(member.full_name)}" value="${escapeHtml(member.dues_start_month?.slice(0,7)||'')}"><button class="secondary" type="submit">Save</button></form>`;}).join(''):'<p class="empty-state">Create member accounts first. They will follow the chapter start month by default.</p>';
}
window.saveChapterOfficers=async()=>{
  const context=await requireSession(true);
  const rows=[...document.querySelectorAll('#officersEditor [data-position]')].map(row=>({position:row.dataset.position,display_name:row.querySelector('[data-officer-name]').value.trim(),member_id:row.querySelector('[data-officer-account]').value||null}));
  if(rows.length!==7||rows.some(row=>row.display_name.length<2))throw new Error('Enter all seven officer names.');
  checkResult(await client.rpc('portal_save_officers',{p_officers:rows}),'Officers could not be saved');
  if(!isCurrent(context))return;
  await loadPublicOfficers();if(!isCurrent(context))return;
  await loadAccounts();await loadPortalData();if(isCurrent(context)){document.getElementById('officersSaveNote').textContent='Saved. The landing page shows the current 7 Masters.';toastMessage('7 Masters updated.');}
};
window.saveChapterDuesStart=async()=>{
  const context=await requireSession(true),value=document.getElementById('chapterDuesStart').value;
  if(!/^\d{4}-\d{2}$/.test(value))throw new Error('Choose the chapter start month.');
  checkResult(await client.rpc('portal_set_dues_start',{p_start_month:`${value}-01`,p_member_id:null}),'Start month could not be saved');
  if(isCurrent(context)){await loadPortalData();if(isCurrent(context))toastMessage('Chapter dues start saved. Members without overrides follow this month.');}
};
window.saveMemberDuesStart=async form=>{
  const context=await requireSession(true),value=form.querySelector('input').value;
  if(value&&!/^\d{4}-\d{2}$/.test(value))throw new Error('Choose a valid month.');
  checkResult(await client.rpc('portal_set_dues_start',{p_start_month:value?`${value}-01`:null,p_member_id:form.dataset.memberStart}),'Member start could not be saved');
  if(isCurrent(context)){await loadPortalData();if(isCurrent(context))toastMessage(value?'Individual start saved.':'Member now follows the chapter start.');}
};
document.addEventListener('change',event=>{if(event.target.matches('[data-officer-account]')&&event.target.value){const row=event.target.closest('[data-position]');row.querySelector('[data-officer-name]').value=event.target.selectedOptions[0].textContent;}});
document.addEventListener('submit',event=>{const form=event.target.closest('[data-member-start]');if(form){event.preventDefault();window.saveMemberDuesStart(form);}});

const pendingActions=new Map();
async function runAction(action, button, key = action) {
  const context=sessionContext();
  if(pendingActions.get(key)?.epoch===context.epoch)return;
  pendingActions.set(key,context);
  const originalLabel=button?.textContent;
  if(button){button.disabled=true;button.setAttribute('aria-busy','true');if(!button.classList.contains('switch'))button.textContent='Saving…';}
  try {await action();} catch(error){if(isCurrent(context))toastMessage(error.message||'The operation could not finish.');}
  finally {
    if(pendingActions.get(key)===context)pendingActions.delete(key);
    if(button?.isConnected){button.disabled=false;button.removeAttribute('aria-busy');button.textContent=originalLabel;}
  }
}
for(const name of ['saveModal','saveChapterSettings','previewChapterQr','sendMemberReceipt','publishChapterPost','saveChapterOfficers','saveChapterDuesStart','saveMemberDuesStart']) {
  const action=window[name];window[name]=(...args)=>{
    const selectors={saveModal:'#modal .modal-foot .primary',saveChapterSettings:'#admin button[onclick="saveChapterSettings()"]',publishChapterPost:'#chapterPostComposer .modal-foot .primary',saveChapterOfficers:'#officersForm button[type="submit"]',saveChapterDuesStart:'.schedule-form button[type="submit"]',sendMemberReceipt:'#receiptState button'};
    const button=name==='saveMemberDuesStart'?args[0]?.querySelector('button'):document.querySelector(selectors[name]||'[data-no-action-button]');
    return runAction(()=>action(...args),button,name);
  };
}
window.exportMemberList=()=>runAction(async()=>{
  const context=await requireSession(true);
  const rows=checkResult(await client.from('profiles').select('*').eq('role','member').order('full_name'),'Member export failed');
  if(!isCurrent(context))return;
  const safeCell=value=>{let text=String(value??'');if(/^[\s]*[=+@-]/.test(text))text="'"+text;return '"'+text.replaceAll('"','""')+'"';};
  const csv=[['Name','Email','Chapter position','Account active','Monthly dues active'],...rows.map(row=>[row.full_name,row.email,row.chapter_position,row.is_active,row.dues_active !== false])].map(row=>row.map(safeCell).join(',')).join('\r\n');
  const url=URL.createObjectURL(new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download='kabasalan-members.csv';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});

if (client) {
  client.auth.onAuthStateChange((event, session) => {
    if(!session?.user) {clearPrivateState();return;}
    if(event==='SIGNED_IN' && rejectUnexpectedSignIn){setTimeout(()=>client.auth.signOut({scope:'local'}),0);return;}
    if(signingOut)return;
    if(activeUserId!==session.user.id){clearPrivateState('login-mode');activeUserId=session.user.id;}
    const context=sessionContext();
    setTimeout(()=>{if(isCurrent(context))activateUser(session.user).catch(error=>{if(isCurrent(context))toastMessage(error.message);});},0);
  });
  loadChapterPosts().catch(error=>toastMessage(error.message));
  loadPublicOfficers().catch(()=>{});
  loadPublicMemberCount();
}
