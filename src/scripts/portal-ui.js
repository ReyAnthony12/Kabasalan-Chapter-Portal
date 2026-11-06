// Presentation only. Cloud operations fail closed until the authenticated runtime loads.
const pageLabels = { overview:'Overview', dues:'Monthly dues', funds:'Chapter funds', news:'News & updates', admin:'Admin & payments', accounts:'Member accounts', officers:'7 Masters', schedule:'Dues schedule' };
let currentFilter = 'all';
let toastTimer;
let receiptReader;
let previewGeneration = 0;
const photoPreviews = new Set();
function toast(message) {
  const el = document.getElementById('toast');
  el.textContent = message; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.classList.remove('show'); el.textContent = ''; }, 3000);
}
function cloudUnavailable(event) { event?.preventDefault?.(); toast('Cloud service is still loading or unavailable. Please refresh and try again.'); }
for (const name of ['handleSignIn','saveModal','saveChapterSettings','previewChapterQr','sendMemberReceipt','publishChapterPost','signOutChapter','saveChapterOfficers','saveChapterDuesStart','saveMemberDuesStart']) window[name] = cloudUnavailable;
function showLogin() { document.body.classList.remove('public-mode'); document.body.classList.add('login-mode'); window.scrollTo(0,0); }
function showLanding() { if (document.body.classList.contains('authenticated')) return; document.body.classList.remove('login-mode'); document.body.classList.add('public-mode'); window.scrollTo(0,0); }
function navigate(page) {
  if (!pageLabels[page] || !document.body.classList.contains('admin-auth')) return;
  document.querySelectorAll('main.content > .section').forEach(el => el.classList.toggle('show',el.id === page));
  document.querySelectorAll('.nav [data-page]').forEach(el => el.classList.toggle('active',el.dataset.page === page));
  document.getElementById('crumb').textContent = pageLabels[page];
  document.getElementById('sidebar').classList.remove('open'); window.scrollTo(0,0);
}
function memberGo(page) {
  if (!document.body.classList.contains('member-auth')) return;
  document.querySelectorAll('.member-panel').forEach(el => el.classList.toggle('active',el.id === `member-page-${page}`));
  document.querySelectorAll('[data-member-page]').forEach(el => el.classList.toggle('selected',el.dataset.memberPage === page));
  const title = document.querySelector('.member-top-title b'); if (title) title.textContent = {home:'Member home',dues:'Monthly dues',funds:'Chapter funds',news:'Chapter news',account:'My account'}[page] || 'Member home';
  window.scrollTo(0,0);
}
function filterRows() {
  document.querySelector('#duesTable [data-search-empty]')?.remove();
  const q = document.getElementById('memberSearch').value.toLowerCase();
  document.querySelectorAll('#duesTable tbody tr').forEach(row => {
    const status = row.dataset.status;
    row.hidden = !!status && !((currentFilter === 'all' || status === currentFilter) && row.textContent.toLowerCase().includes(q));
  });
  showSearchResultState('duesTable');
}
function showUnpaidMembers() { navigate('dues'); currentFilter='unpaid'; document.querySelectorAll('#dues .tab').forEach(el=>el.classList.toggle('active',el.dataset.filter==='unpaid')); filterRows(); }
function searchAccounts(value) { document.querySelectorAll('#accountsTable tbody tr:not([data-search-empty])').forEach(row=>{ row.hidden=!row.textContent.toLowerCase().includes(value.trim().toLowerCase()); }); showSearchResultState('accountsTable'); }
function showSearchResultState(id) {
  const table=document.getElementById(id),body=table?.querySelector('tbody');if(!body)return;
  body.querySelector('[data-search-empty]')?.remove();
  if([...body.querySelectorAll('tr')].some(row=>!row.hidden))return;
  const row=document.createElement('tr');row.dataset.searchEmpty='true';const cell=document.createElement('td');row.append(cell);body.append(row);
  cell.colSpan=table.querySelectorAll('thead th').length;cell.className='empty-state';cell.textContent='No matching members. Try another name or change your filter.';
}
let dialogReturnFocus;
function focusDialog(id) {
  dialogReturnFocus=document.activeElement;
  const backdrop=document.getElementById(id),dialog=backdrop.querySelector('.modal');
  dialog.setAttribute('role','dialog');dialog.setAttribute('aria-modal','true');
  const heading=dialog.querySelector('h2');if(!heading.id)heading.id=`${id}-heading`;dialog.setAttribute('aria-labelledby',heading.id);
  document.body.classList.add('dialog-open');
  [...dialog.querySelectorAll('input,select,textarea,button')].find(el=>!el.disabled&&!el.closest('[style*="display:none"],[style*="display: none"]'))?.focus();
}
function restoreDialogFocus() {
  if(document.querySelector('.modal-back.open'))return;
  document.body.classList.remove('dialog-open');
  if(dialogReturnFocus?.isConnected)dialogReturnFocus.focus();dialogReturnFocus=null;
}
function openModal(type,member) {
  if (!document.body.classList.contains('admin-auth')) return;
  const names={payment:'Record a payment',account:'Create member account',expense:'Add a chapter expense'};
  if (!names[type]) return;
  document.getElementById('modalTitle').textContent=names[type];
  document.getElementById('modalDesc').textContent={payment:'Record the actual amount received for one member and month.',account:'Create a secure member login and assign their chapter position.',expense:'Record the amount, date, purpose, and optional receipt.'}[type];
  for(const [id,kind] of [['paymentFields','payment'],['accountFields','account'],['expenseFields','expense']]) document.getElementById(id).style.display=kind===type?'block':'none';
  document.querySelector('#modal .modal-foot .primary').textContent=type==='account'?'Create member account':'Save record';
  if(type==='payment'){const search=document.getElementById('payMemberSearch');search.value='';search.dispatchEvent(new Event('input'));document.getElementById('payMember').value=member||'';}
  document.getElementById('modal').classList.add('open');
  focusDialog('modal');
}
function closeModal() { document.getElementById('modal').classList.remove('open'); document.getElementById('newMemberPassword').value=''; restoreDialogFocus(); }
function openChapterPostComposer() { if(document.body.classList.contains('admin-auth')) { document.getElementById('chapterPostComposer').classList.add('open');focusDialog('chapterPostComposer'); } }
function releasePhotoPreviews() { for(const url of photoPreviews) URL.revokeObjectURL(url); photoPreviews.clear(); }
function closeChapterPostComposer() { document.getElementById('chapterPostComposer').classList.remove('open'); releasePhotoPreviews(); document.getElementById('chapterPostPreview').replaceChildren(); restoreDialogFocus(); }
function previewChapterPostPhotos(input) {
  releasePhotoPreviews(); const box=document.getElementById('chapterPostPreview'); box.replaceChildren();
  const files=[...(input.files||[])];
  if(files.length>5 || files.some(file=>!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>8_000_000)) {input.value='';return toast('Choose up to five JPG, PNG, or WebP photos, up to 8 MB each.');}
  for(const file of files) {const img=document.createElement('img');img.alt='Activity photo preview';img.src=URL.createObjectURL(file);photoPreviews.add(img.src);box.append(img);}
}
function submitMemberReceipt(input) {
  receiptReader?.abort(); const generation=++previewGeneration; const file=input.files?.[0];
  const box=document.getElementById('receiptState');box.replaceChildren();box.hidden=true;
  if(!file)return;
  if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>5_000_000){input.value='';return toast('Choose a JPG, PNG, or WebP receipt, up to 5 MB.');}
  receiptReader=new FileReader();
  receiptReader.onload=()=>{
    if(generation!==previewGeneration || !document.body.classList.contains('member-auth'))return;
    const label=document.createElement('b');label.textContent='Check your receipt before submitting';
    const name=document.createElement('p');name.textContent=file.name;
    const img=document.createElement('img');img.alt='Selected payment receipt';img.src=receiptReader.result;
    const button=document.createElement('button');button.className='primary';button.textContent='Submit for review';button.onclick=()=>window.sendMemberReceipt(file.name);
    box.replaceChildren(label,name,img,button);box.hidden=false;
  };
  receiptReader.onerror=()=>toast('Could not read this receipt. Choose the image again.');receiptReader.readAsDataURL(file);
}
window.addEventListener('portal-session-reset',()=>{++previewGeneration;receiptReader?.abort();receiptReader=null;releasePhotoPreviews();clearTimeout(toastTimer);currentFilter='all';dialogReturnFocus=null;document.body.classList.remove('dialog-open');});
document.addEventListener('click',event=>{
  const nav=event.target.closest('.nav [data-page]');if(nav)navigate(nav.dataset.page);
  if(event.target.closest('#hamb'))document.getElementById('sidebar').classList.toggle('open');
  const tab=event.target.closest('#dues .tab');if(tab){currentFilter=tab.dataset.filter;document.querySelectorAll('#dues .tab').forEach(el=>el.classList.toggle('active',el===tab));filterRows();}
  if(event.target.id==='modal')closeModal();if(event.target.id==='chapterPostComposer')closeChapterPostComposer();
});
document.addEventListener('input',event=>{if(event.target.id==='memberSearch')filterRows();});
document.addEventListener('keydown',event=>{if(event.key==='Escape'){closeModal();closeChapterPostComposer();document.getElementById('sidebar').classList.remove('open');}});
document.addEventListener('keydown',event=>{
  if(event.key!=='Tab')return;
  const dialog=document.querySelector('.modal-back.open .modal');if(!dialog)return;
  const items=[...dialog.querySelectorAll('button,input,select,textarea,a[href]')].filter(el=>!el.disabled&&!el.hidden&&!el.closest('[style*="display:none"],[style*="display: none"]'));
  const first=items[0],last=items.at(-1);if(!first)return;
  if(event.shiftKey&&(document.activeElement===first||!dialog.contains(document.activeElement))){event.preventDefault();last.focus();}
  else if(!event.shiftKey&&(document.activeElement===last||!dialog.contains(document.activeElement))){event.preventDefault();first.focus();}
});
document.querySelector('.month-pill').textContent=new Intl.DateTimeFormat('en-PH',{month:'long',year:'numeric',timeZone:'Asia/Manila'}).format(new Date());
// Reuse the published landing-page activity in every signed-in news view.
window.renderFeaturedActivity = (includeLatest = true) => {
  const feature = document.querySelector('#activities .undas-feature');
  if (!feature) return;
  for (const id of ['adminPostsList', 'memberPostFeed', ...(includeLatest ? ['memberLatestPost'] : [])]) {
    const feed = document.getElementById(id);
    if (!feed || feed.querySelector('[data-featured-activity]')) continue;
    const copy = feature.cloneNode(true);
    copy.dataset.featuredActivity = 'undas-2026';
    copy.removeAttribute('aria-labelledby');
    copy.setAttribute('aria-label', feature.querySelector('h3').textContent);
    copy.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
    feed.querySelectorAll('.empty-state, .public-empty').forEach(el => el.remove());
    feed.prepend(copy);
  }
};
window.renderFeaturedActivity();
