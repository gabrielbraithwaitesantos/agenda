import { collection, addDoc, getDocs, doc, deleteDoc, writeBatch } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { getStorage, ref as storageRef, uploadBytesResumable, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js";
import { signOut } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

// Helper function to get user-scoped collection path
function getUserCollection(collectionName) {
  if (!window.auth || !window.auth.currentUser) {
    console.error('User not authenticated');
    return null;
  }
  const uid = window.auth.currentUser.uid;
  return collection(window.db, 'users', uid, collectionName);
}

// Helper function to get user-prefixed localStorage key
function getUserLocalStorageKey(key) {
  if (!window.auth || !window.auth.currentUser) return key;
  return `${window.auth.currentUser.uid}_${key}`;
}

// basic calendar/runtime globals
const MONTHS = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
const DAYS = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];

let tasks = [];
try{ tasks = JSON.parse(localStorage.getItem('agenda_tasks')||'[]') || []; }catch(e){ tasks = []; }

// migrate existing tasks: if a task is marked onlyExam and its name looks like the day-of-exam, mark onlyExamDay
try{
  let migrated = false;
  for(const t of tasks){
    if(t && t.onlyExam && !t.onlyExamDay){
      try{
        const n = (t.name||'').toLowerCase();
        if(/\bdia\b|dia da prova|dia\s+da/i.test(n) || /\bdia\s+\d{1,2}\b/.test(n)){
          t.onlyExamDay = true; migrated = true;
        }
      }catch(e){}
    }
  }
  if(migrated) try{ localStorage.setItem('agenda_tasks', JSON.stringify(tasks)); }catch(e){}
}catch(e){/* ignore migration errors */}

let vm = (new Date()).getMonth();
let vy = (new Date()).getFullYear();

function todayStr(){ const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }

// timer state (tracks currently active timed task)
let activeTimer = null;
let timerInterval = null;
try{ activeTimer = JSON.parse(localStorage.getItem('agenda_timer')||'null'); }catch(e){ activeTimer = null; }

// staged attachments waiting for user Send (not yet persisted to localStorage/Firestore)
let pendingAttachments = [];

// simple in-memory message history used by IA integrations (not window.history)
let history = [];

// current user profile used for personalized greeting in the splash
let currentUserProfile = null;

function getProfileStorageKey(uid){
  if(!uid) return 'agenda_profile';
  return `${uid}_agenda_profile`;
}

function normalizeProfile(profile){
  const rawName = String(profile && profile.name ? profile.name : '').trim();
  const name = rawName
    .split(/\s+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
  const gender = profile && profile.gender === 'fem' ? 'fem' : 'masc';
  return { name, gender };
}

function buildGreeting(profile){
  const p = normalizeProfile(profile || {});
  if(!p.name) return 'Bem-vindo moreno';
  const prefix = p.gender === 'fem' ? 'Bem-vinda morena' : 'Bem-vindo moreno';
  return `${prefix} ${p.name}`;
}

function buildLiveGreeting(profile){
  const rawName = String(profile && profile.name ? profile.name : '').replace(/\s+/g, ' ').trim();
  const gender = profile && profile.gender === 'fem' ? 'fem' : 'masc';
  const prefix = gender === 'fem' ? 'Bem-vinda morena' : 'Bem-vindo moreno';
  if(!rawName) return prefix;
  return `${prefix} ${rawName}`;
}

function updateSplashGreeting(profile, live = false){
  const el = document.getElementById('splash-greeting');
  const text = live ? buildLiveGreeting(profile) : buildGreeting(profile);
  if(el) el.textContent = text;
  const preview = document.getElementById('profile-preview');
  if(preview && profile) preview.textContent = text;
}

function showSplashUI(){
  const splash = document.getElementById('splash');
  if(splash) splash.style.display = 'flex';
  const bottom = document.getElementById('bottom-ia-bar') || document.querySelector('.bottom-ia');
  if(bottom) bottom.classList.remove('visible');
}

function hideProfileModal(){
  const modal = document.getElementById('profile-modal');
  if(modal) modal.classList.add('hidden');
}

function showProfileModal(){
  const modal = document.getElementById('profile-modal');
  if(modal) modal.classList.remove('hidden');
  const nameInput = document.getElementById('profile-name');
  if(nameInput) setTimeout(()=>{ try{ nameInput.focus(); }catch(e){} }, 50);
}

function loadUserProfile(uid){
  try{
    const raw = localStorage.getItem(getProfileStorageKey(uid));
    if(!raw) return null;
    const parsed = JSON.parse(raw);
    const profile = normalizeProfile(parsed || {});
    if(!profile.name) return null;
    return profile;
  }catch(e){ console.warn('loadUserProfile', e); return null; }
}

function saveUserProfile(uid, profile){
  const cleaned = normalizeProfile(profile || {});
  if(!cleaned.name) return null;
  localStorage.setItem(getProfileStorageKey(uid), JSON.stringify(cleaned));
  currentUserProfile = cleaned;
  updateSplashGreeting(cleaned);
  return cleaned;
}

function renderAccountInfo(profile){
  const el = document.getElementById('profile-account-info');
  const user = window.auth && window.auth.currentUser;
  if(!el) return;
  if(!user){
    el.textContent = 'Você precisa estar logado para ver os dados da conta.';
    return;
  }
  const p = normalizeProfile(profile || currentUserProfile || loadUserProfile(user.uid) || {});
  const displayName = p.name || 'Não definido';
  const genderLabel = p.gender === 'fem' ? 'Feminino' : 'Masculino';
  el.innerHTML = `
    <div><strong>Email:</strong> ${user.email || 'sem email'}</div>
    <div><strong>Nome:</strong> ${displayName}</div>
    <div><strong>Saudação:</strong> ${genderLabel}</div>
  `;
}

function openAccountPanel(){
  try{
    const user = window.auth && window.auth.currentUser;
    if(!user) return;
    const profile = loadUserProfile(user.uid) || currentUserProfile || { name:'', gender:'masc' };
    currentUserProfile = normalizeProfile(profile);
    const nameInput = document.getElementById('profile-name');
    const genderInput = document.getElementById('profile-gender');
    if(nameInput) nameInput.value = currentUserProfile.name || '';
    if(genderInput) genderInput.value = currentUserProfile.gender || 'masc';
    renderAccountInfo(currentUserProfile);
    const preview = document.getElementById('profile-preview');
    if(preview) preview.textContent = currentUserProfile.name ? buildLiveGreeting(currentUserProfile) : 'Bem-vindo moreno';
    const liveExample = document.getElementById('profile-live-example');
    if(liveExample) liveExample.textContent = currentUserProfile.name ? buildLiveGreeting(currentUserProfile) : '';
    const modal = document.getElementById('profile-modal');
    if(modal) modal.classList.remove('hidden');
    if(nameInput) setTimeout(()=>{ try{ nameInput.focus(); }catch(e){} }, 50);
  }catch(e){ console.warn('openAccountPanel', e); }
}

function syncProfilePreview(){
  const name = (document.getElementById('profile-name') || {}).value || '';
  const gender = (document.getElementById('profile-gender') || {}).value || 'masc';
  const preview = document.getElementById('profile-preview');
  const liveExample = document.getElementById('profile-live-example');
  const message = document.getElementById('profile-message');
  const profile = { name, gender };
  const liveGreeting = buildLiveGreeting(profile);
  if(preview) preview.textContent = liveGreeting;
  if(liveExample) liveExample.textContent = liveGreeting;
  updateSplashGreeting(profile, true);
  if(message) message.textContent = '';
}

function showProfileError(msg){
  const message = document.getElementById('profile-message');
  if(message) message.textContent = msg;
}

function refreshWelcomeGate(user){
  try{
    if(!user){
      currentUserProfile = null;
      hideProfileModal();
      updateSplashGreeting(null);
      return;
    }
    showSplashUI();
    const profile = loadUserProfile(user.uid);
    currentUserProfile = profile;
    if(profile){
      updateSplashGreeting(profile);
      renderAccountInfo(profile);
      hideProfileModal();
      const preview = document.getElementById('profile-preview');
      if(preview) preview.textContent = buildLiveGreeting(profile);
      const liveExample = document.getElementById('profile-live-example');
      if(liveExample) liveExample.textContent = buildLiveGreeting(profile);
    } else {
      updateSplashGreeting({ name:'', gender:'masc' });
      const nameInput = document.getElementById('profile-name');
      const genderInput = document.getElementById('profile-gender');
      if(nameInput) nameInput.value = '';
      if(genderInput) genderInput.value = 'masc';
      const preview = document.getElementById('profile-preview');
      if(preview) preview.textContent = 'Bem-vindo moreno';
      const liveExample = document.getElementById('profile-live-example');
      if(liveExample) liveExample.textContent = '';
      renderAccountInfo({ name:'', gender:'masc' });
      showProfileModal();
    }
  }catch(e){ console.warn('refreshWelcomeGate', e); }
}

window.saveWelcomeProfile = function(){
  try{
    const user = window.auth && window.auth.currentUser;
    if(!user) return;
    const name = (document.getElementById('profile-name') || {}).value || '';
    const gender = (document.getElementById('profile-gender') || {}).value || 'masc';
    const cleaned = normalizeProfile({ name, gender });
    if(!cleaned.name){
      showProfileError('Digite seu nome para continuar.');
      const nameInput = document.getElementById('profile-name');
      if(nameInput) nameInput.focus();
      return;
    }
    saveUserProfile(user.uid, cleaned);
    renderAccountInfo(cleaned);
    hideProfileModal();
    showSplashUI();
    updateSplashGreeting(cleaned);
    try{ const bottomInp = document.getElementById('inp-bottom') || document.getElementById('inp'); if(bottomInp) bottomInp.focus(); }catch(e){}
  }catch(e){ console.warn('saveWelcomeProfile', e); }
};

window.openAccountPanel = openAccountPanel;


// helper to persist messages to Firestore (non-blocking)
async function saveMessageToFirebase(role, text){
  try{
    if(!window.db) return;
    const col = getUserCollection('messages');
    if (!col) return;
    await addDoc(col, { role, text, ts: new Date().toISOString() });
  }catch(e){ console.warn('saveMessageToFirebase', e); }
}

async function saveLearningRecord(kind, payload){
  try{
    if(!window.db) return;
    const enabled = localStorage.getItem('agenda_learning') === '1';
    if(!enabled) return;
    const col = getUserCollection('learning');
    if (!col) return;
    await addDoc(col, { kind, payload, ts: new Date().toISOString() });
  }catch(e){ console.warn('saveLearningRecord', e); }
}

// save attachment metadata to Firestore (optional)
async function saveAttachmentRecord(name, url, size, mime, ocr){
  try{
    if(!window.db) return;
    const col = getUserCollection('attachments');
    if (!col) return;
    await addDoc(col, { name, url, size: Number(size||0), mime: mime||null, ocr: ocr || null, ts: new Date().toISOString() });
  }catch(e){ console.warn('saveAttachmentRecord', e); }
}

// local attachments storage (persist metadata in localStorage for quick access) - USER SCOPED
function getAttachmentsStorageKey(){
  if (!window.auth || !window.auth.currentUser) return 'agenda_attachments';
  return `${window.auth.currentUser.uid}_agenda_attachments`;
}
function loadLocalAttachments(){
  try{ return JSON.parse(localStorage.getItem(getAttachmentsStorageKey())||'[]'); }catch(e){ return []; }
}
function saveLocalAttachments(list){
  try{ localStorage.setItem(getAttachmentsStorageKey(), JSON.stringify(list||[])); }catch(e){ console.warn('saveLocalAttachments', e); }
}

function registerAttachmentLocalRecord(name, url, size, mime, ocr){
  try{
    const list = loadLocalAttachments();
    const rec = { id: 'a_'+Date.now(), name: name||'anexo', url, size: Number(size||0), mime: mime||null, ocr: ocr||null, ts: new Date().toISOString() };
    list.unshift(rec);
    saveLocalAttachments(list);
    console.log('registerAttachmentLocalRecord saved', rec);
    renderAttachmentsPanel();
    return rec;
  }catch(e){ console.warn('registerAttachmentLocalRecord', e); }
}

function removeLocalAttachment(id){
  try{ const list = loadLocalAttachments().filter(a=>a.id!==id); saveLocalAttachments(list); renderAttachmentsPanel(); }catch(e){ console.warn('removeLocalAttachment', e); }
}

function createTaskFromAttachment(id){
  try{
    const list = loadLocalAttachments(); const a = list.find(x=>x.id===id); if(!a) return alert('Anexo não encontrado');
    const name = prompt('Nome da tarefa para o anexo (deixe em branco para usar o nome do arquivo):', a.name) || a.name;
    const date = prompt('Data para associar (YYYY-MM-DD ou texto natural):', todayStr());
    if(!date) return;
    const parsed = parsePortugueseDate(date) || date;
    const t = { name: name + ' [ANEXO]', date: parsed, time: null, cat: 'outro', est: 5, attachment: a.url };
    tasks.push(t); saveTasks(); renderCal(); renderTasks(); removeLocalAttachment(id);
    alert('Tarefa criada com anexo e adicionada ao calendário.');
  }catch(e){ console.warn('createTaskFromAttachment', e); alert('Erro ao criar tarefa do anexo'); }
}

function renderAttachmentsPanel(){
  try{
    const container = document.getElementById('attachments-list'); if(!container) return;
    const list = loadLocalAttachments();
    if(!list.length){ container.innerHTML = '<div class="no-tasks">Nenhum anexo ainda</div>'; return; }
    container.innerHTML = '';
    list.forEach(a=>{
      const item = document.createElement('div'); item.className='attachment-item';
      item.style.display='flex'; item.style.alignItems='center'; item.style.justifyContent='space-between'; item.style.gap='8px'; item.style.padding='8px'; item.style.background='rgba(255,255,255,0.02)'; item.style.borderRadius='8px';
      const left = document.createElement('div'); left.style.display='flex'; left.style.gap='8px'; left.style.alignItems='center';
      const ico = document.createElement('div'); ico.style.width='40px'; ico.style.height='40px'; ico.style.borderRadius='6px'; ico.style.background='#0f1113'; ico.style.display='flex'; ico.style.alignItems='center'; ico.style.justifyContent='center'; ico.style.color='#fff'; ico.textContent = (a.name.split('.').pop()||'F').toUpperCase();
      const meta = document.createElement('div'); meta.style.display='flex'; meta.style.flexDirection='column'; meta.innerHTML = `<div style="font-size:13px">${a.name}</div><div style="font-size:11px;color:var(--muted)">${Math.round(a.size/1024)} KB • ${new Date(a.ts).toLocaleString()}</div>`;
      left.appendChild(ico); left.appendChild(meta);
      const actions = document.createElement('div'); actions.style.display='flex'; actions.style.gap='6px';
      const open = document.createElement('a'); open.href = a.url; open.target='_blank'; open.textContent='Abrir'; open.className='cal-nav small';
      const create = document.createElement('button'); create.className='cal-nav small'; create.textContent='Criar tarefa'; create.addEventListener('click', ()=>createTaskFromAttachment(a.id));
      const remove = document.createElement('button'); remove.className='cal-nav small'; remove.textContent='Remover'; remove.addEventListener('click', ()=>{ if(confirm('Remover este anexo?')) removeLocalAttachment(a.id); });
      actions.appendChild(open); actions.appendChild(create); actions.appendChild(remove);
      item.appendChild(left); item.appendChild(actions);
      container.appendChild(item);
    });
  }catch(e){ console.warn('renderAttachmentsPanel', e); }
}

// render attachments panel on startup
try{ setTimeout(()=>{ renderAttachmentsPanel(); }, 200); }catch(e){}
// hide setup banner when GROQ key is present (avoid showing warning on configured installs)
try{
  setTimeout(()=>{
    if(typeof window.syncSetupBannerVisibility === 'function'){
      window.syncSetupBannerVisibility();
      return;
    }
    const banner = document.getElementById('setup-banner');
    if(!banner) return;
    const key = (window.GROQ_API_KEY || '').trim();
    if(key && key !== 'COLE_SUA_CHAVE_GROQ_AQUI' && key !== 'REDACTED_API_KEY'){
      banner.classList.add('hidden');
    } else {
      banner.classList.remove('hidden');
    }
  }, 300);
}catch(e){ console.warn('hide setup banner failed', e); }
// expose helpers for debugging from DevTools
try{
  window.renderAttachmentsPanel = renderAttachmentsPanel;
  window.registerAttachmentLocalRecord = registerAttachmentLocalRecord;
  window.loadLocalAttachments = loadLocalAttachments;
  window.saveLocalAttachments = saveLocalAttachments;
}catch(e){ console.warn('expose debug helpers failed', e); }

// Reconciler: periodically scan attachment previews and persist any completed uploads
function reconcileAttachmentPreviews(){
  try{
    const previews = Array.from(document.querySelectorAll('.attachment-preview'));
    if(!previews.length) return;
    const cur = loadLocalAttachments();
    let changed = false;
    for(const p of previews){
      try{
        // skip previews that are staged/pending — they will be saved only when user explicitly sends
        try{ if(p.dataset && p.dataset.pending) continue; }catch(e){}
        const statusA = p.querySelector('.attachment-status a');
        const titleEl = p.querySelector('.attachment-title');
        if(statusA && statusA.href){
          const href = statusA.href;
          const title = titleEl ? titleEl.textContent : (href.split('/').pop() || 'anexo');
          const exists = cur.find(x=> x.url === href);
          if(!exists){
            const rec = { id: 'a_'+Date.now() + '_' + Math.floor(Math.random()*1000), name: title, url: href, size: 0, mime: null, ocr: null, ts: new Date().toISOString() };
            cur.unshift(rec);
            console.log('reconciler: saved preview to localStorage', rec);
            changed = true;
          }
        }
      }catch(e){ console.warn('reconciler: preview iteration error', e); }
    }
    if(changed){
      try{ saveLocalAttachments(cur); renderAttachmentsPanel(); window.dispatchEvent(new Event('attachments-updated')); }catch(e){ console.warn('reconciler: save failed', e); }
    }
  }catch(e){ console.warn('reconcileAttachmentPreviews failed', e); }
}

// start reconciler (runs in background while page is open)
try{ setInterval(reconcileAttachmentPreviews, 2000); }catch(e){ console.warn('start reconciler failed', e); }
// expose reconcilier to window for manual triggering from UI
try{ window.reconcileAttachmentPreviews = reconcileAttachmentPreviews; }catch(e){ console.warn('expose reconcile failed', e); }

// wire manual reconcile button if present
try{
  setTimeout(()=>{
    const btn = document.getElementById('reconcile-attachments-btn');
    const statusEl = document.getElementById('reconcile-status');
    if(btn){
      btn.addEventListener('click', async ()=>{
        try{ btn.disabled = true; if(statusEl) statusEl.textContent = 'Salvando...';
          await reconcileAttachmentPreviews();
          if(statusEl) statusEl.textContent = 'Concluído';
          setTimeout(()=>{ if(statusEl) statusEl.textContent = ''; }, 2500);
        }catch(e){ console.warn('manual reconcile failed', e); if(statusEl) statusEl.textContent = 'Erro'; }
        finally{ btn.disabled = false; }
      });
    }
  }, 80);
}catch(e){ console.warn('wire manual reconcile button failed', e); }

// ── calendário ───────────────────────────────────────────────────
function changeMonth(d){ vm+=d; if(vm>11){vm=0;vy++;} if(vm<0){vm=11;vy--;} renderCal(); }

function renderCal(){
  document.getElementById('cal-label').textContent = MONTHS[vm].slice(0,3).toUpperCase()+' '+vy;
  const grid = document.getElementById('cal-grid');
  grid.innerHTML = '';
  DAYS.forEach(d=>{ const el=document.createElement('div'); el.className='cal-dow'; el.textContent=d; grid.appendChild(el); });
  const first = new Date(vy,vm,1).getDay();
  const dim   = new Date(vy,vm+1,0).getDate();
  const prev  = new Date(vy,vm,0).getDate();
  const td    = todayStr();
  for(let i=0;i<first;i++){ const el=document.createElement('div'); el.className='cal-day other'; el.textContent=prev-first+1+i; grid.appendChild(el); }
  for(let d=1;d<=dim;d++){
    const ds=vy+'-'+String(vm+1).padStart(2,'0')+'-'+String(d).padStart(2,'0');
    const el=document.createElement('div'); el.className='cal-day';
    const dn = document.createElement('div'); dn.className='day-number'; dn.textContent = d;
    el.appendChild(dn);
    el.setAttribute('data-date', ds);
    if(ds===td) el.classList.add('today');
    const tasksForDay = tasks.filter(t=>t.date===ds).sort((a,b)=> (a.time||'') > (b.time||'') ? 1 : -1);
    if(tasksForDay.length){
      el.classList.add('has-task');
      const maxShow = 3;
      tasksForDay.slice(0,maxShow).forEach(t=>{
        const c = CAT_COLORS[t.cat]||CAT_COLORS.outro;
        const mt = document.createElement('div'); mt.className='mini-task';
        const completedClass = t.completedAt ? ' completed' : '';
        mt.innerHTML = `<div class="mini-dot" style="background:${c}"></div><div class="mini-text${completedClass}">${t.time? t.time+' ' : ''}${t.name}</div>`;
        el.appendChild(mt);
      });
      if(tasksForDay.length>maxShow){
        const more = document.createElement('div'); more.className='more-count'; more.textContent = '+'+(tasksForDay.length-maxShow)+' mais';
        el.appendChild(more);
      }
    }
    el.addEventListener('click', ()=> showDatePopover(ds));
    grid.appendChild(el);
  }
  const rem=42-first-dim;
  for(let i=1;i<=rem;i++){ const el=document.createElement('div'); el.className='cal-day other'; el.textContent=i; grid.appendChild(el); }
}

// ── tarefas ───────────────────────────────────────────────────────
const CAT_COLORS = { trabalho:'#4f8ef7', estudo:'#3ecf8e', pessoal:'#a78bfa', projeto:'#f5a623', outro:'#7a7f8e' };

function saveTasks(){
  try{
    const key = getUserLocalStorageKey('agenda_tasks');
    localStorage.setItem(key, JSON.stringify(tasks));
  }catch(e){ console.warn('saveTasks localStorage write failed', e); }
  if(window.db){
    saveToFirebase(tasks).catch(e=>console.error('saveTasks->saveToFirebase', e));
  }
  // recompute aggregates and update UI whenever tasks change
  computeAggregates();
  try{ renderSplashTasks(); }catch(e){}
}

// Load tasks for a given user (localStorage first, then Firestore fallback)
async function loadTasksForUser(uid){
  try{
    // Always clear the in-memory list first so we never keep tasks from the previous account.
    tasks = [];
    const key = uid ? (uid + '_agenda_tasks') : getUserLocalStorageKey('agenda_tasks');
    let local = null;
    try{ local = JSON.parse(localStorage.getItem(key) || 'null'); }catch(e){ local = null; }
    if(Array.isArray(local)){
      tasks = local;
      computeAggregates(); renderCal(); renderTasks(); try{ renderSplashTasks(); }catch(e){}
      return;
    }
    // fallback to Firestore if available and user present
    if(window.db && uid){
      try{
        const col = getUserCollection('tasks');
        if(col){
          const snap = await getDocs(col);
          const arr = snap.docs.map(d=>{ const obj = d.data(); obj._id = d.id; return obj; });
          if(arr && arr.length){
            tasks = arr;
            try{ localStorage.setItem(key, JSON.stringify(tasks)); }catch(e){}
            computeAggregates(); renderCal(); renderTasks(); try{ renderSplashTasks(); }catch(e){}
            return;
          }
        }
      }catch(e){ console.warn('loadTasksForUser firestore read failed', e); }
    }
  }catch(e){ console.warn('loadTasksForUser', e); }
  // no data -> keep the list empty for this account and render
  tasks = [];
  computeAggregates(); renderCal(); renderTasks(); try{ renderSplashTasks(); }catch(e){}
}

// Called from auth state changes to load appropriate tasks
window.handleAuthStateChange = async function(user){
  try{
    if(user){
      // First: clear old UI elements from previous account BEFORE loading new data
      tasks = [];
      const msgs = document.getElementById('msgs');
      if(msgs) msgs.innerHTML = '';
      const splashReplies = document.getElementById('splash-replies');
      if(splashReplies) splashReplies.innerHTML = '';
      const bottomReplies = document.getElementById('bottom-replies');
      if(bottomReplies) bottomReplies.innerHTML = '';
      const dbgPanel = document.getElementById('splash-debug');
      if(dbgPanel) dbgPanel.remove();
      const el = document.getElementById('splash-tasks');
      if(el) el.innerHTML = '';
      
      // Second: load user-specific tasks, messages, and profile
      await loadTasksForUser(user.uid);
      try{
        const userMessages = await loadMessagesFromFirebase();
        if(userMessages && userMessages.length > 0){
          for(const msg of userMessages){
            addMsg(msg.role || 'ai', msg.text || '');
          }
        }
      }catch(e){ console.warn('load messages failed', e); }
      refreshWelcomeGate(user);
    } else {
      // not authenticated: clear in-memory tasks, messages, attachments so the next account can't inherit them
      tasks = [];
      currentUserProfile = null;
      hideProfileModal();
      // Clear chat DOM
      const msgs = document.getElementById('msgs');
      if(msgs) msgs.innerHTML = '';
      // Clear splash messages
      const splashReplies = document.getElementById('splash-replies');
      if(splashReplies) splashReplies.innerHTML = '';
      // Clear bottom bar messages
      const bottomReplies = document.getElementById('bottom-replies');
      if(bottomReplies) bottomReplies.innerHTML = '';
      // Clear debug panel
      const dbgPanel = document.getElementById('splash-debug');
      if(dbgPanel) dbgPanel.remove();
      const el = document.getElementById('splash-tasks');
      if(el) el.innerHTML = '';
      const splash = document.getElementById('splash'); if(splash) splash.style.display = 'none';
      computeAggregates(); renderCal(); renderTasks(); try{ renderSplashTasks(); }catch(e){}
    }
  }catch(e){ console.warn('handleAuthStateChange', e); }
}

// ── normalize and aggregates ───────────────────────────────────
function normalizeName(name){
  if(!name) return '';
  return name.toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()\[\]"]+/g,'').replace(/\s+/g,' ').trim();
}

// try parse simple Portuguese date expressions into ISO YYYY-MM-DD
function parsePortugueseDate(text){
  if(!text) return null;
  const s = text.toString().toLowerCase().trim();
  // hoje
  if(/\bhoje\b/.test(s)) return todayStr();
  // amanhã / amanha
  if(/\bamanh[ãa]\b/.test(s) || /\bde amanh[ãa]\b/.test(s) ){
    const d = new Date(); d.setDate(d.getDate()+1); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }
  // weekdays: domingo, segunda(-feira), terça, quarta, quinta, sexta, sábado
  const WEEKDAY_MAP = {
    'domingo': 0,
    'domingo-feira': 0,
    'segunda': 1,
    'segunda-feira': 1,
    'terca': 2,
    'terça': 2,
    'terca-feira': 2,
    'terça-feira': 2,
    'quarta': 3,
    'quarta-feira': 3,
    'quinta': 4,
    'quinta-feira': 4,
    'sexta': 5,
    'sexta-feira': 5,
    'sabado': 6,
    'sábado': 6,
    'sabado-feira': 6
  };
  const wdMatch = s.match(/\b(domingo|domingo-feira|segunda(?:-feira| feira)?|terça|terca(?:-feira| feira)?|quarta(?:-feira| feira)?|quinta(?:-feira| feira)?|sexta(?:-feira| feira)?|sábado|sabado(?:-feira| feira)?)\b/iu);
  if(wdMatch){
    try{
      const key = wdMatch[1].toString().toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu,'').replace(/\s+/g,'').replace(/-/, '');
      // map normalized key to weekday index
      let targetWeekday = null;
      for(const k of Object.keys(WEEKDAY_MAP)){
        const nk = k.normalize('NFD').replace(/\p{Diacritic}/gu,'').replace(/\s+/g,'').replace(/-/, '');
        if(nk === key){ targetWeekday = WEEKDAY_MAP[k]; break; }
      }
      if(targetWeekday !== null){
        const today = new Date(); const todayIdx = today.getDay();
        let diff = (targetWeekday - todayIdx + 7) % 7; if(diff === 0) diff = 7; // choose next occurrence (future)
        const d = new Date(); d.setDate(d.getDate() + diff);
        return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      }
    }catch(e){ /* ignore weekday parse errors */ }
  }
  // explicit ISO yyyy-mm-dd
  const iso = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if(iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  // dd/mm or dd-mm (assume current year if missing)
  const m = s.match(/(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/);
  if(m){
    let day = String(m[1]).padStart(2,'0'); let month = String(m[2]).padStart(2,'0');
    let year = m[3] ? String(m[3]) : String(new Date().getFullYear());
    if(year.length===2) year = '20'+year;
    return `${year}-${month}-${day}`;
  }
  // handle "dia 23", "23 de abril", "23 abril" or just a day number (assume current month/year)
  // month name parsing
  const MONTH_NAME_MAP = {
    janeiro:1, fevereiro:2, marco:3, março:3, abril:4, maio:5, junho:6,
    julho:7, agosto:8, setembro:9, outubro:10, novembro:11, dezembro:12
  };
  const dayName = s.match(/(?:dia\s*)?(\d{1,2})(?:\s*(?:de)?\s*([a-zçãõ]+))?(?:\s*(?:de)?\s*(\d{4}))?/i);
  if(dayName){
    const d = parseInt(dayName[1],10);
    if(!Number.isFinite(d) || d<1 || d>31) return null;
    let monthStr = dayName[2];
    let yearStr = dayName[3];
    let monthNum = null;
    if(monthStr){
      monthStr = monthStr.normalize('NFD').replace(/\p{Diacritic}/gu,'');
      // try full name or first 3 letters
      for(const k of Object.keys(MONTH_NAME_MAP)){
        if(k.startsWith(monthStr) || k === monthStr){ monthNum = MONTH_NAME_MAP[k]; break; }
      }
    }
    const now = new Date();
    const year = yearStr ? String(yearStr) : String(now.getFullYear());
    const month = monthNum || (now.getMonth()+1);
    // ensure zero-padded
    const dayP = String(d).padStart(2,'0');
    const monthP = String(month).padStart(2,'0');
    return `${year}-${monthP}-${dayP}`;
  }
  return null;
}

// try extract multiple dates from a freeform text (supports separators: ',', ' e ', ' and ')
function parsePortugueseDates(text){
  if(!text) return [];
  // split on commas or ' e ' (and surrounding spaces)
  const parts = text.split(/,|\s+e\s+|\s+and\s+|;/i).map(p=>p.trim()).filter(Boolean);
  const results = [];
  for(const p of parts){
    const d = parsePortugueseDate(p);
    if(d && !results.includes(d)) results.push(d);
  }
  // if nothing parsed, attempt to find all day numbers like 'dia 22' or standalone numbers
  if(!results.length){
    const numMatches = text.match(/(?:dia\s*)?(\d{1,2})(?:\s*\/\s*\d{1,2})?/g);
    if(numMatches){
      for(const nm of numMatches){ const d = parsePortugueseDate(nm); if(d && !results.includes(d)) results.push(d); }
    }
  }
  return results;
}

function isExamPlanningRequest(text){
  if(!text) return false;
  return /\b(prova|provas|exame|exames|avalia[çc][aã]o|teste|teste\s+de\s+conhecimento)\b/i.test(text);
}

function buildExamPlan(examDateStr, attachmentUrl, text){
  if(!examDateStr) return [];
  const examDate = new Date(examDateStr + 'T12:00:00');
  if(isNaN(examDate.getTime())) return [];

  const diffDays = Math.max(0, Math.floor((examDate.setHours(0,0,0,0) - (new Date()).setHours(0,0,0,0)) / 86400000));
  const plan = [];
  const steps = [];
  const examId = 'exam_' + examDateStr;

  if(diffDays >= 3){
    steps.push({ offset: -3, name: 'Preparar conteúdo para prova', est: 120 });
    steps.push({ offset: -2, name: 'Começar a estudar para prova', est: 90 });
    steps.push({ offset: -1, name: 'Revisão para prova', est: 60 });
  } else if(diffDays === 2){
    steps.push({ offset: -2, name: 'Preparar conteúdo para prova', est: 120 });
    steps.push({ offset: -1, name: 'Revisão para prova', est: 60 });
  } else if(diffDays === 1){
    steps.push({ offset: -1, name: 'Preparar conteúdo para prova', est: 90 });
  }

  steps.push({ offset: 0, name: 'Dia da prova', est: 30 });

  for(const step of steps){
    const d = new Date(examDate);
    d.setDate(d.getDate() + step.offset);
    const date = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    const task = {
      name: step.name,
      date,
      time: step.offset === 0 ? '14:00' : '18:00',
      cat: 'estudo',
      est: step.est,
      examId: examId
    };
    // attach the provided attachment to all exam-related plan tasks (prep, revisão, dia da prova)
    if(attachmentUrl) task.attachment = attachmentUrl;
    // mark these as exam-related tasks so UI can filter or highlight
    task.onlyExam = true;
    // mark the actual exam day specially so we can show only the day-of-exam in the 'Prova' panel
    if(step.offset === 0) task.onlyExamDay = true;
    plan.push(task);
  }

  return plan;
}

function taskAttachmentList(task){
  const urls = [];
  if(!task) return urls;
  if(Array.isArray(task.attachments)){
    for(const url of task.attachments){ if(url && !urls.includes(url)) urls.push(url); }
  }
  if(task.attachment && !urls.includes(task.attachment)) urls.push(task.attachment);
  return urls;
}

function taskAttachmentHtml(task){
  const urls = taskAttachmentList(task);
  if(!urls.length) return '';
  const links = urls.map(url=>{
    const local = loadLocalAttachments().find(a=> a.url === url);
    const label = local && local.name ? local.name : (url.split('/').pop() || 'anexo');
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  }).join('<br>');
  return `<div class="meta" style="margin-top:8px"><strong>Anexo:</strong><div>${links}</div></div>`;
}

function taskFlagsHtml(task){
  if(!task) return '';
  const flags = [];
  if(task.onlyExam) flags.push('<span class="flag">Prova</span>');
  if(task.onlyWork) flags.push('<span class="flag">Trabalho</span>');
  if(!flags.length) return '';
  return `<div style="margin-top:6px">${flags.join(' ')}</div>`;
}

function computeAggregates(){
  const completed = tasks.filter(t=>t.actualDuration && Number.isFinite(t.actualDuration));
  const catStats = {};
  const nameStats = {};
  for(const t of completed){
    const m = Number(t.actualDuration);
    const cat = t.cat || 'outro';
    if(!catStats[cat]) catStats[cat] = { count:0, sum:0 };
    catStats[cat].count++; catStats[cat].sum += m;
    const key = normalizeName(t.name).split(' ').slice(0,6).join(' ');
    if(!nameStats[key]) nameStats[key] = { count:0, sum:0, sample: t.name };
    nameStats[key].count++; nameStats[key].sum += m;
  }
  const catAgg = {};
  for(const k of Object.keys(catStats)) catAgg[k] = { avg: Math.round((catStats[k].sum/catStats[k].count)||0), n: catStats[k].count };
  const nameAgg = {};
  for(const k of Object.keys(nameStats)) nameAgg[k] = { avg: Math.round((nameStats[k].sum/nameStats[k].count)||0), n: nameStats[k].count, sample: nameStats[k].sample };
  const agg = { byCategory: catAgg, byName: nameAgg, computedAt: new Date().toISOString() };
  localStorage.setItem('agenda_aggregates', JSON.stringify(agg));
  renderAggregatesUI(agg);
  return agg;
}

function renderAggregatesUI(agg){
  const container = document.getElementById('agg-list');
  if(!container) return;
  if(!agg || (!Object.keys(agg.byCategory).length && !Object.keys(agg.byName).length)){
    container.innerHTML = 'Nenhum dado histórico'; return;
  }
  let html = '';
  html += '<div style="display:flex;flex-direction:column;gap:6px">';
  html += '<div class="agg-small">Por categoria:</div>';
  for(const k of Object.keys(agg.byCategory)){
    const v = agg.byCategory[k]; html += `<div class="agg-item"><strong>${k}</strong> — média ${v.avg}min (n=${v.n})</div>`;
  }
  html += '<div class="agg-small" style="margin-top:8px">Tarefas semelhantes:</div>';
  const names = Object.keys(agg.byName).slice(0,6);
  for(const n of names){ const v = agg.byName[n]; html += `<div class="agg-item">${v.sample} — média ${v.avg}min (n=${v.n})</div>`; }
  html += '</div>';
  container.innerHTML = html;
}

// try load existing aggregates on init
try{ const ex = JSON.parse(localStorage.getItem('agenda_aggregates')||'null'); if(ex) renderAggregatesUI(ex); }catch(e){}

// ── CRUD manual, export/import ───────────────────────────────────
function createTask(){
  const name = prompt('Nome da tarefa:');
  if(!name) return;
  const date = prompt('Data (YYYY-MM-DD):', todayStr());
  if(!date) return;
  const time = prompt('Hora (HH:MM) — opcional:', '');
  const cat  = prompt('Categoria (trabalho|estudo|pessoal|projeto|outro):', 'outro') || 'outro';
  const est  = parseInt(prompt('Estimativa em minutos:', '60')||'60',10) || 60;
  const t = { name, date, time: time||null, cat, est };
  tasks.push(t);
  saveTasks(); renderCal(); renderTasks();
  try{ saveEventAndLearning('task.create', { name: t.name, date: t.date, cat: t.cat, est: t.est }); }catch(e){}
}

function addTaskForDate(dateStr){
  const name = prompt('Nome da tarefa:');
  if(!name) return;
  const time = prompt('Hora (HH:MM) — opcional:', '');
  const cat  = prompt('Categoria (trabalho|estudo|pessoal|projeto|outro):', 'outro') || 'outro';
  const est  = parseInt(prompt('Estimativa em minutos:', '60')||'60',10) || 60;
  const t = { name, date: dateStr, time: time||null, cat, est };
  tasks.push(t);
  saveTasks(); renderCal(); renderTasks();
  try{ saveEventAndLearning('task.create', { name: t.name, date: t.date, cat: t.cat, est: t.est }); }catch(e){}
}

function editTask(i){
  if(typeof i!=='number') return;
  const t = tasks[i]; if(!t) return;
  // Preencher modal com dados atuais
  const modal = document.getElementById('edit-task-modal');
  if(!modal) return;
  modal.classList.remove('hidden');
  modal.dataset.taskIndex = i;
  document.getElementById('edit-task-name').value = t.name || '';
  document.getElementById('edit-task-date').value = t.date || '';
  document.getElementById('edit-task-time').value = t.time || '';
  document.getElementById('edit-task-cat').value = t.cat || 'outro';
  document.getElementById('edit-task-est').value = t.est || 60;
  // Anexos (exibição simplificada)
  const attDiv = document.getElementById('edit-task-attachments');
  attDiv.innerHTML = '';
  if(t.attachment){
    const a = document.createElement('div');
    a.innerHTML = `<a href="${t.attachment}" target="_blank">Ver anexo</a>`;
    attDiv.appendChild(a);
  }
  document.getElementById('edit-task-message').textContent = '';
  // Cancelar fecha modal
  document.getElementById('edit-task-cancel-btn').onclick = ()=>{ modal.classList.add('hidden'); };
  // Adicionar novo anexo (substitui o anterior)
  document.getElementById('edit-task-add-attachment').onchange = function(ev){
    const file = ev.target.files[0];
    if(file){
      const url = URL.createObjectURL(file);
      attDiv.innerHTML = `<a href="${url}" target="_blank">${file.name}</a>`;
      attDiv.dataset.newAttachment = url;
      attDiv.dataset.newAttachmentName = file.name;
    }
  };
}

function deleteTask(i){
  if(!confirm('Remover esta tarefa?')) return;
  const removed = tasks.splice(i,1)[0];
  console.debug('deleteTask: removed', removed && removed.name, 'index=', i);
  saveTasks(); renderCal(); renderTasks();
  try{ saveEventAndLearning('task.delete', { index: i, task: removed }); }catch(e){}
}

function exportTasks(){
  const data = JSON.stringify(tasks, null, 2);
  const blob = new Blob([data], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'agenda_tasks.json'; document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

function importTasks(){
  const raw = prompt('Cole o JSON das tarefas aqui:');
  if(!raw) return;
  try{
    const parsed = JSON.parse(raw);
    if(Array.isArray(parsed)){
      tasks = parsed;
      saveTasks(); renderCal(); renderTasks();
      alert('Importado '+tasks.length+' tarefas.');
    }else alert('JSON inválido: esperado um array.');
  }catch(e){ alert('Erro ao parsear JSON: '+e.message); }
}

function showTasksForDate(dateStr){
  const list = document.getElementById('task-list');
  const filt = tasks.map((t,i)=>({t,i})).filter(x=>x.t.date===dateStr);
  if(!filt.length){ list.innerHTML = '<div class="no-tasks">Nenhuma tarefa nesta data</div>'; return; }
  list.innerHTML = filt.map(x=>{
    const t = x.t; const i = x.i; const c = CAT_COLORS[t.cat]||CAT_COLORS.outro;
    const isRunning = activeTimer && activeTimer.index===i;
    const elapsed = isRunning && activeTimer.start ? formatElapsed(activeTimer.start) : (t.actualDuration? (t.actualDuration+' min') : '');
    return `<div class="task-card">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <div style="display:flex;gap:8px;align-items:center"><div class="task-dot" style="background:${c}"></div><div>${t.name}</div></div>
        <div style="display:flex;gap:8px;align-items:center">
          ${elapsed? `<div class="elapsed">${elapsed}</div>` : ''}
          <button class="cal-nav" onclick="toggleTimer(${i})">${isRunning? 'Parar' : 'Iniciar'}</button>
          <button class="cal-nav" onclick="markTaskDone(${i})">concluir</button>
          <button class="cal-nav" onclick="editTask(${i})">editar</button>
          <button class="cal-nav" onclick="deleteTask(${i})">remover</button>
        </div>
      </div>
      <div class="task-meta">${t.time||''} · ${t.est||''}min</div>
    </div>`;
  }).join('');
}

// ── date popover (modal) ───────────────────────────────────────
function showDatePopover(dateStr){
  const pop = document.getElementById('date-popover'); if(!pop) return;
  const title = document.getElementById('popover-title'); if(title) title.textContent = 'Evento';
  const body = document.getElementById('popover-body'); if(!body) return;
  const items = tasks.map((t,i)=>({t,i})).filter(x=>x.t.date===dateStr);
  let html = '';
  html += `<div style="font-size:13px;color:var(--muted);margin-bottom:8px">${dateStr}</div>`;
  if(!items.length){ html += '<div class="no-tasks">Nenhuma tarefa nesta data</div>'; }
    for(const it of items){ const t = it.t; const i = it.i; const c = CAT_COLORS[t.cat]||CAT_COLORS.outro;
    html += `<div class="popover-item"><div class="left"><div class="task-dot" style="background:${c}"></div><div><strong>${t.name}</strong><div class="meta">${t.time? t.time+' · ' : ''}${t.cat} · ${t.est||''}min</div>${taskAttachmentHtml(t)}${taskFlagsHtml(t)}</div></div><div style="display:flex;gap:8px"><button class="cal-nav" onclick="editTask(${i}); closeDatePopover();">Editar</button><button class="cal-nav" onclick="deleteTask(${i}); closeDatePopover();">Excluir</button></div></div>`;
  }
  body.innerHTML = html;
  // show
  pop.classList.remove('hidden');
  // set add button handler (add task prefilled with date)
  const addBtn = document.getElementById('popover-add-btn');
  if(addBtn){ addBtn.onclick = ()=>{ addTaskForDate(dateStr); closeDatePopover(); }; }
}

function closeDatePopover(){ const pop = document.getElementById('date-popover'); if(pop) pop.classList.add('hidden'); }

// wire popover close button
setTimeout(()=>{ const b = document.getElementById('popover-close'); if(b) b.addEventListener('click', closeDatePopover); }, 80);


// Salvar edição de tarefa
document.addEventListener('DOMContentLoaded', function(){
  const form = document.getElementById('edit-task-form');
  if(form){
    form.onsubmit = function(ev){
      ev.preventDefault();
      const modal = document.getElementById('edit-task-modal');
      const i = parseInt(modal.dataset.taskIndex, 10);
      if(isNaN(i) || !tasks[i]) return;
      const name = document.getElementById('edit-task-name').value.trim();
      const date = document.getElementById('edit-task-date').value;
      const time = document.getElementById('edit-task-time').value;
      const cat  = document.getElementById('edit-task-cat').value;
      const est  = parseInt(document.getElementById('edit-task-est').value, 10) || 60;
      // Anexo
      const attDiv = document.getElementById('edit-task-attachments');
      let attachment = tasks[i].attachment;
      if(attDiv.dataset.newAttachment){
        attachment = attDiv.dataset.newAttachment;
      }
      tasks[i] = { ...tasks[i], name, date, time, cat, est, attachment };
      saveTasks(); renderCal(); renderTasks();
      modal.classList.add('hidden');
      try{ saveEventAndLearning && saveEventAndLearning('task.update', { index: i, task: tasks[i] }); }catch(e){}
    };
  }
});

// expõe funções
window.createTask = createTask;
window.editTask = editTask;
window.deleteTask = deleteTask;
window.exportTasks = exportTasks;
window.importTasks = importTasks;
window.showTasksForDate = showTasksForDate;
// expose timer and task actions for legacy inline handlers and external calls
window.toggleTimer = toggleTimer;
window.markTaskDone = markTaskDone;
window.startTimer = startTimer;
window.stopTimer = stopTimer;
window.renderTasks = renderTasks;

function renderTasks(){
  const list  = document.getElementById('task-list');
  const td    = todayStr();
  // only consider tasks that have a meaningful name for UI counts/lists
  const visible = tasks.filter(t=>t && t.name && String(t.name).trim().length>0);
  // upcoming: future or today tasks that are not completed
  const upcoming = visible.filter(t=>!t.completedAt && t.date>=td).sort((a,b)=>a.date>b.date?1:-1).slice(0,6);

  const statTotal = document.getElementById('stat-total');
  if(statTotal) statTotal.textContent = visible.length;
  const totalMin = visible.reduce((s,t)=>s+(t.est||0),0);
  const statTime = document.getElementById('stat-time');
  if(statTime) statTime.textContent = totalMin
    ? (totalMin>=60 ? (Math.round(totalMin/6)/10)+'h' : totalMin+'min')
    : '—';

  if(!upcoming.length){
    list.innerHTML='<div class="no-tasks">Nenhuma tarefa ainda</div>';
  } else {
    // build DOM nodes to avoid inline onclick issues and keep stable references
    list.innerHTML = '';
    upcoming.forEach(t=>{
      const c   = CAT_COLORS[t.cat]||CAT_COLORS.outro;
      const est = t.est ? (t.est>=60 ? Math.round(t.est/6)/10+'h' : t.est+'min') : '';
      const dl  = t.date===td ? 'hoje' : t.date.split('-').reverse().slice(0,2).join('/');
      let globalIndex = tasks.findIndex(x => (x && x._id && t && t._id) ? x._id === t._id : x === t);
      if(globalIndex === -1) globalIndex = tasks.indexOf(t);

      const card = document.createElement('div'); card.className = 'task-card';
      const top = document.createElement('div'); top.style.display = 'flex'; top.style.alignItems = 'center'; top.style.justifyContent = 'space-between';

      const left = document.createElement('div'); left.style.display='flex'; left.style.alignItems='center'; left.style.gap='8px';
      const dot = document.createElement('div'); dot.className = 'task-dot'; dot.style.background = c;
      const nameEl = document.createElement('span'); nameEl.className='task-name'; nameEl.textContent = t.name;
      left.appendChild(dot); left.appendChild(nameEl);

      const right = document.createElement('div'); right.style.display='flex'; right.style.gap='8px'; right.style.alignItems='center';
      if(t.actualDuration){ const elapsed = document.createElement('div'); elapsed.className='elapsed'; elapsed.textContent = t.actualDuration + ' min'; right.appendChild(elapsed); }

      const startBtn = document.createElement('button'); startBtn.className = 'cal-nav';
      const isActive = activeTimer && ((activeTimer.id && t && t._id && activeTimer.id===t._id) || activeTimer.index===globalIndex);
      startBtn.textContent = isActive ? 'Parar' : 'Iniciar';
      startBtn.addEventListener('click', (ev)=>{ ev.stopPropagation(); toggleTimer(globalIndex); renderTasks(); renderCal(); });

      const conclBtn = document.createElement('button'); conclBtn.className = 'cal-nav'; conclBtn.textContent = 'concluir';
      conclBtn.addEventListener('click', (ev)=>{ ev.stopPropagation(); markTaskDone(globalIndex); });

      right.appendChild(startBtn); right.appendChild(conclBtn);
      // exam / work toggles
      const examBtn = document.createElement('button'); examBtn.className = 'cal-nav small'; examBtn.textContent = t.onlyExam ? 'Prova ✓' : 'Prova';
      examBtn.addEventListener('click', (ev)=>{ ev.stopPropagation(); t.onlyExam = !t.onlyExam; saveTasks(); renderTasks(); renderCal(); });
      right.appendChild(examBtn);
      const workBtn = document.createElement('button'); workBtn.className = 'cal-nav small'; workBtn.textContent = t.onlyWork ? 'Trabalho ✓' : 'Trabalho';
      workBtn.addEventListener('click', (ev)=>{ ev.stopPropagation(); t.onlyWork = !t.onlyWork; saveTasks(); renderTasks(); renderCal(); });
      right.appendChild(workBtn);
      top.appendChild(left); top.appendChild(right);
      const meta = document.createElement('div'); meta.className='task-meta'; meta.textContent = dl + (t.time? ' · '+t.time: '') + (est? ' · '+est: '');
      card.appendChild(top); card.appendChild(meta);
      // flags (Prova / Trabalho)
      const flagsWrap = document.createElement('div'); flagsWrap.innerHTML = taskFlagsHtml(t);
      card.appendChild(flagsWrap);
      // clicking the task card opens the date popover (same as clicking the day in the calendar)
      card.addEventListener('click', ()=>{ try{ showDatePopover(t.date); }catch(e){ console.warn('open date popover from task card', e); } });
      list.appendChild(card);
    });
  }

  // render exam-only tasks
  try{
    const examList = document.getElementById('exam-task-list');
    if(examList){
      const exams = tasks.filter(t=> t && t.onlyExamDay && !t.completedAt).sort((a,b)=> a.date>b.date?1:-1).slice(0,8);
      if(!exams.length) examList.innerHTML = '<div class="no-tasks">Nenhuma tarefa de prova</div>'; else {
        examList.innerHTML = '';
        exams.forEach(t=>{
          const i = tasks.indexOf(t);
          const item = document.createElement('div'); item.className='task-card small';
          item.style.display='flex'; item.style.justifyContent='space-between'; item.style.alignItems='center';
          const left = document.createElement('div'); left.style.display='flex'; left.style.flexDirection='column';
          const name = document.createElement('strong'); name.textContent = t.name; left.appendChild(name);
          const meta = document.createElement('div'); meta.className='meta'; meta.textContent = (t.date? t.date.split('-').reverse().slice(0,2).join('/') : '') + (t.time? ' · '+t.time : '');
          const actions = document.createElement('div'); actions.style.display='flex'; actions.style.gap='8px';
          const openBtn = document.createElement('button'); openBtn.className='cal-nav small'; openBtn.textContent='Abrir'; openBtn.onclick = ()=>{ showDatePopover(t.date); };
          const createBtn = document.createElement('button'); createBtn.className='cal-nav small'; createBtn.textContent='Editar'; createBtn.onclick = ()=>{ editTask(i); };
          actions.appendChild(openBtn); actions.appendChild(createBtn);
          item.appendChild(left); item.appendChild(actions);
          examList.appendChild(item);
        });
      }
    }
  }catch(e){ console.warn('renderExamTasks failed', e); }

  // render work-only tasks
  try{
    const workList = document.getElementById('work-task-list');
    if(workList){
      const works = tasks.filter(t=> t && t.onlyWork && !t.completedAt).sort((a,b)=> a.date>b.date?1:-1).slice(0,8);
      if(!works.length) workList.innerHTML = '<div class="no-tasks">Nenhuma tarefa de trabalho</div>'; else {
        workList.innerHTML = '';
        works.forEach(t=>{
          const i = tasks.indexOf(t);
          const item = document.createElement('div'); item.className='task-card small';
          item.style.display='flex'; item.style.justifyContent='space-between'; item.style.alignItems='center';
          const left = document.createElement('div'); left.style.display='flex'; left.style.flexDirection='column';
          const name = document.createElement('strong'); name.textContent = t.name; left.appendChild(name);
          const meta = document.createElement('div'); meta.className='meta'; meta.textContent = (t.date? t.date.split('-').reverse().slice(0,2).join('/') : '') + (t.time? ' · '+t.time : '');
          const actions = document.createElement('div'); actions.style.display='flex'; actions.style.gap='8px';
          const openBtn = document.createElement('button'); openBtn.className='cal-nav small'; openBtn.textContent='Abrir'; openBtn.onclick = ()=>{ showDatePopover(t.date); };
          const createBtn = document.createElement('button'); createBtn.className='cal-nav small'; createBtn.textContent='Editar'; createBtn.onclick = ()=>{ editTask(i); };
          actions.appendChild(openBtn); actions.appendChild(createBtn);
          item.appendChild(left); item.appendChild(actions);
          workList.appendChild(item);
        });
      }
    }
  }catch(e){ console.warn('renderWorkTasks failed', e); }
}
  // render a compact list of pending tasks inside the splash overlay
  function renderSplashTasks(){
    const el = document.getElementById('splash-tasks');
    if(!el) return;
    // pending: not completed yet (only count tasks with a real name)
    const td = todayStr();
    const visible = tasks.filter(t=>t && t.name && String(t.name).trim().length>0);
    const pending = visible.filter(t=>!t.completedAt).sort((a,b)=> a.date>b.date?1:-1).slice(0,6);
    el.innerHTML = '';
    // Clean up debug panel if it exists
    const dbgOld = document.getElementById('splash-debug');
    if(dbgOld) dbgOld.remove();
    console.debug('renderSplashTasks: tasks.length=', tasks.length, 'pending.length=', pending.length, tasks.slice(0,6));
    if(!pending.length){
      if(visible.length>0){
        el.innerHTML = '<div class="no-tasks">Nenhuma tarefa pendente (todas as tarefas foram concluídas)</div>'; 
      } else {
        el.innerHTML = '<div class="no-tasks">Nenhuma tarefa pendente</div>';
      }
      return;
    }
    // debug panel: show counts and first names so user can see what's loaded (only if pending tasks exist)
    let dbg = document.createElement('div'); dbg.id = 'splash-debug'; dbg.style.fontSize='12px'; dbg.style.color='var(--muted)'; dbg.style.marginTop='8px';
    try{ dbg.textContent = `Tarefas totais: ${visible.length} — pendentes: ${pending.length} — primeiras: ${pending.slice(0,4).map(p=>p.name||'—').join(' | ')}`; }catch(e){ dbg.textContent = `Tarefas totais: ${visible.length} — pendentes: ${pending.length}`; }
    el.parentNode.insertBefore(dbg, el.nextSibling);
    pending.forEach(t=>{
      const i = tasks.indexOf(t);
      const item = document.createElement('div'); item.className = 'splash-task';
      const row = document.createElement('div'); row.className = 'splash-task-row';
      const name = document.createElement('div'); name.className = 'splash-task-name'; name.textContent = t.name || '';
      const meta = document.createElement('div'); meta.className = 'splash-task-meta'; meta.textContent = (t.date===td? 'hoje' : t.date.split('-').reverse().slice(0,2).join('/')) + (t.time? ' · '+t.time : '');
      row.appendChild(name); row.appendChild(meta);
      const actions = document.createElement('div'); actions.className = 'splash-task-actions';
      const startBtn = document.createElement('button'); startBtn.className = 'cal-nav small';
      const isActive = activeTimer && ((activeTimer.id && t._id && activeTimer.id===t._id) || activeTimer.index===i);
      startBtn.textContent = isActive ? 'Parar' : 'Iniciar';
      startBtn.addEventListener('click', (ev)=>{ ev.stopPropagation(); toggleTimer(i); renderSplashTasks(); renderTasks(); });
      const doneBtn = document.createElement('button'); doneBtn.className = 'cal-nav small'; doneBtn.textContent = 'concluir';
      doneBtn.addEventListener('click', (ev)=>{ ev.stopPropagation(); markTaskDone(i); });
      actions.appendChild(startBtn); actions.appendChild(doneBtn);
      item.appendChild(row); item.appendChild(actions);
      el.appendChild(item);
    });
  }

  function formatElapsed(startISO){
    try{
      const s = new Date(startISO);
      const diff = Math.max(0, Date.now() - s.getTime());
      const mins = Math.floor(diff/60000);
      if(mins<60) return mins + ' min';
      const h = Math.floor(mins/60); const m = mins%60; return `${h}h ${m}m`;
    }catch(e){ return ''; }
  }

  function startTimerInterval(){
    if(timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(()=>{
      // refresh visible lists
      try{ renderTasks(); }catch(e){}
    }, 15000);
  }

  function toggleTimer(selector){
    // selector can be an index (number) or a task id (string)
    let idx = null;
    if(typeof selector === 'number') idx = selector;
    else if(typeof selector === 'string') idx = tasks.findIndex(t=>t && t._id === selector);
    else idx = null;

    // resolve current active index (prefer id match)
    let activeIndex = null;
    if(activeTimer){
      if(activeTimer.id) activeIndex = tasks.findIndex(t=>t && t._id === activeTimer.id);
      else activeIndex = activeTimer.index;
    }

    if(idx !== null && idx === activeIndex){
      stopTimer();
    } else if(typeof idx === 'number' && idx >= 0){
      startTimer(idx);
    } else {
      console.warn('toggleTimer: task not found', selector);
    }
  }

  function startTimer(i){
    if(typeof i !== 'number' || i<0 || i>=tasks.length){ console.warn('startTimer: invalid index', i); return; }
    // stop existing different timer
    if(activeTimer && ((activeTimer.id && tasks.findIndex(t=>t && t._id===activeTimer.id)!==i) || (!activeTimer.id && activeTimer.index!==i)) ) stopTimer();
    const id = tasks[i] && tasks[i]._id ? tasks[i]._id : null;
    activeTimer = { index: i, id, start: new Date().toISOString() };
    localStorage.setItem('agenda_timer', JSON.stringify(activeTimer));
    startTimerInterval();
    renderTasks(); renderCal();
  }

  function stopTimer(){
    if(!activeTimer) return;
    // try resolve task by stored id or index
    let i = activeTimer.index;
    let t = tasks[i];
    if(!t && activeTimer.id){
      i = tasks.findIndex(x=>x && x._id === activeTimer.id);
      if(i !== -1) t = tasks[i];
    }
    if(!t){ activeTimer = null; localStorage.removeItem('agenda_timer'); return; }
    const start = new Date(activeTimer.start);
    const mins = Math.max(1, Math.round((Date.now() - start.getTime())/60000));
    t.actualDuration = (Number(t.actualDuration) || 0) + mins;
    delete t.timerStart;
    saveTasks();
    try{ saveEventAndLearning('task.timed', { taskId: t._id||null, name: t.name, minutes: mins }); }catch(e){}
    activeTimer = null; localStorage.removeItem('agenda_timer');
    if(timerInterval){ clearInterval(timerInterval); timerInterval = null; }
    renderTasks(); renderCal();
  }

// ── chat helpers ─────────────────────────────────────────────────
function addMsg(role, text){
  const msgs = document.getElementById('msgs');
  if(!msgs){
    console.warn('addMsg: msgs element not found');
    return;
  }
  const wrap = document.createElement('div');
  wrap.className = 'msg '+role;
  const t = new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
  const safeText = (text === null || text === undefined) ? '' : String(text);
  wrap.innerHTML = `<div class="bubble">${safeText.replace(/\n/g,'<br/>')}</div><span class="msg-time">${t}</span>`;
  msgs.appendChild(wrap);
  msgs.scrollTop = msgs.scrollHeight;

  // also render messages inside the splash when it's visible (so user sees reply while still on splash)
  try{
    const splash = document.getElementById('splash');
    const splashReplies = document.getElementById('splash-replies');
    if(splash && splashReplies && splash.style.display !== 'none'){
      const spr = document.createElement('div');
      spr.className = 'splash-msg-item '+role;
      const safeText2 = (text === null || text === undefined) ? '' : String(text);
      spr.innerHTML = `<div class="bubble">${safeText2.replace(/\n/g,'<br/>')}</div><span class="msg-time">${t}</span>`;
      splashReplies.appendChild(spr);
      splashReplies.scrollTop = splashReplies.scrollHeight;
    }
  }catch(e){}

  // also render a short-lived preview inside the bottom bar when it's visible (chat column hidden)
  try{
    const bottomReplies = document.getElementById('bottom-replies');
    const bottomEl = document.getElementById('bottom-ia-bar') || document.querySelector('.bottom-ia');
    const splashEl = document.getElementById('splash');
    if(bottomReplies && bottomEl && (!splashEl || splashEl.style.display==='none') && bottomEl.classList.contains('visible')){
      bottomReplies.classList.remove('hidden');
      const br = document.createElement('div');
      br.className = 'bottom-reply '+role;
      const safeText3 = (text === null || text === undefined) ? '' : String(text);
      br.innerHTML = `<div class="bubble">${safeText3.replace(/\n/g,'<br/>')}</div><span class="msg-time">${t}</span>`;
      bottomReplies.appendChild(br);
      bottomReplies.scrollTop = bottomReplies.scrollHeight;
      // auto-remove after a while to avoid growing indefinitely
      setTimeout(()=>{ try{ br.remove(); if(!bottomReplies.children.length) bottomReplies.classList.add('hidden'); }catch(e){} }, 3000);
    }
  }catch(e){}
}

function addThinking(){
  const msgs = document.getElementById('msgs');
  const wrap = document.createElement('div');
  wrap.className = 'msg ai';
  wrap.innerHTML = '<div class="thinking"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>';
  msgs.appendChild(wrap);
  msgs.scrollTop = msgs.scrollHeight;
  return wrap;
}

// remove a user message matching exact text from chat, splash or bottom preview
function removeUserMessage(textToRemove){
  try{
    if(!textToRemove) return;
    const t = textToRemove.trim();
    // main chat
    const msgs = document.getElementById('msgs');
    if(msgs){
      const bubbles = Array.from(msgs.querySelectorAll('.msg.user .bubble'));
      for(let i=bubbles.length-1;i>=0;i--){ const b = bubbles[i]; if(b && b.innerText && b.innerText.trim()===t){ b.parentNode.remove(); break; } }
    }
    // splash replies
    const splashReplies = document.getElementById('splash-replies');
    if(splashReplies){
      const items = Array.from(splashReplies.querySelectorAll('.splash-msg-item.user .bubble, .splash-msg-item .bubble'));
      for(let i=items.length-1;i>=0;i--){ const b = items[i]; if(b && b.innerText && b.innerText.trim()===t){ b.parentNode.remove(); break; } }
    }
    // bottom replies
    const bottomReplies = document.getElementById('bottom-replies');
    if(bottomReplies){
      const items = Array.from(bottomReplies.querySelectorAll('.bottom-reply.user .bubble, .bottom-reply .bubble'));
      for(let i=items.length-1;i>=0;i--){ const b = items[i]; if(b && b.innerText && b.innerText.trim()===t){ b.parentNode.remove(); break; } }
    }
  }catch(e){ console.warn('removeUserMessage', e); }
}

function handleKey(e){ if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); sendMsg(); } }
function autoResize(el){
  // keep a small default height; only expand when content needs more space
  const MIN_H = 36; // default visible height
  const MAX_H = 120; // max expansion
  // reset to minimum first
  el.style.height = MIN_H + 'px';
  // measure scrollHeight; only grow if it noticeably exceeds current inner height
  const sh = el.scrollHeight;
  // add small tolerance to avoid tiny growths while typing
  if(sh > MIN_H + 8){
    el.style.height = Math.min(sh, MAX_H) + 'px';
  } else {
    el.style.height = MIN_H + 'px';
  }
}

// ── enviar mensagem ───────────────────────────────────────────────
// upload a staged attachment (used when user clicks Send)
// `persist` controls whether to save metadata to Firestore/localStorage after upload.
async function uploadPendingAttachment(att, persist = true){
  return new Promise((resolve)=>{
    try{
      let storage = window.storage || null;
      if(!storage && typeof getStorage === 'function' && typeof window.firebaseApp !== 'undefined') storage = getStorage(window.firebaseApp);
      if(!storage){ try{ att.statusEl.textContent = 'Storage não configurado'; }catch(e){}; resolve({ error: 'no-storage' }); return; }
      // if already uploaded (has url), optionally persist metadata and return
      if(att.url){
        try{
          if(persist){
            try{ saveAttachmentRecord(att.name, att.url, att.size, att.mime, att.ocr).catch(e=>console.warn('saveAttachmentRecord failed', e)); }catch(e){ console.warn('saveAttachmentRecord failed', e); }
            try{
              const rec = { id: 'a_'+Date.now(), name: att.name||'anexo', url: att.url, size: Number(att.size||0), mime: att.mime||null, ocr: att.ocr||null, ts: new Date().toISOString() };
              const curRaw = localStorage.getItem('agenda_attachments');
              let cur = [];
              try{ cur = curRaw ? JSON.parse(curRaw) : []; }catch(e){ console.warn('parse agenda_attachments failed, resetting', e); cur = []; }
              cur.unshift(rec);
              localStorage.setItem('agenda_attachments', JSON.stringify(cur));
              try{ renderAttachmentsPanel(); }catch(e){}
              try{ window.dispatchEvent(new Event('attachments-updated')); }catch(e){}
              // remove pending marker from preview since it's now persisted
              try{ if(att.preview && att.preview.dataset) { delete att.preview.dataset.pending; att.preview.classList.remove('attachment-pending'); } }catch(e){}
            }catch(e){ console.warn('local persist failed', e); try{ registerAttachmentLocalRecord(att.name, att.url, att.size, att.mime, att.ocr); }catch(e2){ console.warn('registerAttachmentLocalRecord failed', e2); } }
          }
        }catch(e){ console.warn('persist existing upload failed', e); }
        resolve({ url: att.url, ocr: att.ocr, name: att.name, size: att.size, mime: att.mime });
        return;
      }
      try{
        // if an uploadTask already exists (started earlier in no-persist mode), attach handlers to it
        if(att.uploadTask && !att.url){
          const uploadTask = att.uploadTask;
          try{ if(att.statusEl) att.statusEl.textContent = 'Enviando...'; }catch(e){}
          uploadTask.on('state_changed', (snap)=>{
            try{ const pct = Math.round((snap.bytesTransferred / snap.totalBytes) * 100); if(att.progressBar) att.progressBar.style.width = pct + '%'; if(att.statusEl) att.statusEl.textContent = 'Enviando — ' + pct + '%'; }catch(e){}
          }, (err)=>{
            try{ console.error('upload failed', err); if(att.statusEl) att.statusEl.textContent = 'Erro: ' + (err && err.message ? err.message : String(err)); }catch(e){}
            resolve({ error: err });
          }, async ()=>{
            try{
              const url = await getDownloadURL(uploadTask.snapshot.ref);
              try{ if(att.statusEl) att.statusEl.innerHTML = `<a href="${url}" target="_blank" rel="noopener noreferrer">Abrir anexo</a>`; if(att.progressBar) att.progressBar.style.width = '100%'; }catch(e){}
              // optional OCR for images
              let ocrText = '';
              try{
                if(att.mime && att.mime.startsWith('image/') && window.Tesseract && typeof Tesseract.recognize === 'function'){
                  try{
                    const tmpUrl = URL.createObjectURL(att.file);
                    const ocrRes = await Tesseract.recognize(tmpUrl, 'por');
                    if(ocrRes && ocrRes.data && typeof ocrRes.data.text === 'string') ocrText = ocrRes.data.text.trim();
                    try{ URL.revokeObjectURL(tmpUrl); }catch(e){}
                  }catch(e){ console.warn('OCR failed', e); }
                }
              }catch(e){ console.warn('ocr-check failed', e); }
              // set att fields
              try{ att.url = url; att.ocr = ocrText; }catch(e){}
              // if persist requested, save to Firestore and localStorage
              if(persist){
                try{ await saveAttachmentRecord(att.name, url, att.size, att.mime, ocrText); }catch(e){ console.warn('saveAttachmentRecord failed', e); }
                try{
                  const rec = { id: 'a_'+Date.now(), name: att.name||'anexo', url, size: Number(att.size||0), mime: att.mime||null, ocr: ocrText||null, ts: new Date().toISOString() };
                  const curRaw = localStorage.getItem('agenda_attachments');
                  let cur = [];
                  try{ cur = curRaw ? JSON.parse(curRaw) : []; }catch(e){ console.warn('parse agenda_attachments failed, resetting', e); cur = []; }
                  cur.unshift(rec);
                  localStorage.setItem('agenda_attachments', JSON.stringify(cur));
                  try{ renderAttachmentsPanel(); }catch(e){}
                  try{ window.dispatchEvent(new Event('attachments-updated')); }catch(e){}
                  // remove pending marker from preview since it's now persisted
                  try{ if(att.preview && att.preview.dataset) { delete att.preview.dataset.pending; att.preview.classList.remove('attachment-pending'); } }catch(e){}
                }catch(e){ console.warn('local persist failed', e); try{ registerAttachmentLocalRecord(att.name, url, att.size, att.mime, ocrText); }catch(e2){ console.warn('registerAttachmentLocalRecord failed', e2); } }
              }
              resolve({ url, ocr: ocrText, name: att.name, size: att.size, mime: att.mime });
            }catch(e){ console.error('getDownloadURL error', e); try{ if(att.statusEl) att.statusEl.textContent = 'Erro ao obter link'; }catch(e){}; resolve({ error: e }); }
          });
          return;
        }
        att.statusEl.textContent = 'Enviando...';
        const uploadTask = uploadBytesResumable(att.sref, att.file, { contentType: att.mime || 'application/octet-stream' });
        att.uploadTask = uploadTask;
        uploadTask.on('state_changed', (snap)=>{
          try{ const pct = Math.round((snap.bytesTransferred / snap.totalBytes) * 100); if(att.progressBar) att.progressBar.style.width = pct + '%'; if(att.statusEl) att.statusEl.textContent = 'Enviando — ' + pct + '%'; }catch(e){}
        }, (err)=>{
          try{ console.error('upload failed', err); if(att.statusEl) att.statusEl.textContent = 'Erro: ' + (err && err.message ? err.message : String(err)); }catch(e){}
          resolve({ error: err });
        }, async ()=>{
          try{
            const url = await getDownloadURL(uploadTask.snapshot.ref);
            try{ if(att.statusEl) att.statusEl.innerHTML = `<a href="${url}" target="_blank" rel="noopener noreferrer">Abrir anexo</a>`; if(att.progressBar) att.progressBar.style.width = '100%'; }catch(e){}
            // optional OCR for images
            let ocrText = '';
            try{
              if(att.mime && att.mime.startsWith('image/') && window.Tesseract && typeof Tesseract.recognize === 'function'){
                try{
                  const tmpUrl = URL.createObjectURL(att.file);
                  const ocrRes = await Tesseract.recognize(tmpUrl, 'por');
                  if(ocrRes && ocrRes.data && typeof ocrRes.data.text === 'string') ocrText = ocrRes.data.text.trim();
                  try{ URL.revokeObjectURL(tmpUrl); }catch(e){}
                }catch(e){ console.warn('OCR failed', e); }
              }
            }catch(e){ console.warn('ocr-check failed', e); }
            // set att fields
            try{ att.url = url; att.ocr = ocrText; }catch(e){}
            // if persist requested, save to Firestore and localStorage
            if(persist){
              try{ await saveAttachmentRecord(att.name, url, att.size, att.mime, ocrText); }catch(e){ console.warn('saveAttachmentRecord failed', e); }
              try{
                const rec = { id: 'a_'+Date.now(), name: att.name||'anexo', url, size: Number(att.size||0), mime: att.mime||null, ocr: ocrText||null, ts: new Date().toISOString() };
                const curRaw = localStorage.getItem('agenda_attachments');
                let cur = [];
                try{ cur = curRaw ? JSON.parse(curRaw) : []; }catch(e){ console.warn('parse agenda_attachments failed, resetting', e); cur = []; }
                cur.unshift(rec);
                localStorage.setItem('agenda_attachments', JSON.stringify(cur));
                try{ renderAttachmentsPanel(); }catch(e){}
                try{ window.dispatchEvent(new Event('attachments-updated')); }catch(e){}
                // remove pending marker from preview since it's now persisted
                try{ if(att.preview && att.preview.dataset) { delete att.preview.dataset.pending; att.preview.classList.remove('attachment-pending'); } }catch(e){}
              }catch(e){ console.warn('local persist failed', e); try{ registerAttachmentLocalRecord(att.name, url, att.size, att.mime, ocrText); }catch(e2){ console.warn('registerAttachmentLocalRecord failed', e2); } }
            }
            resolve({ url, ocr: ocrText, name: att.name, size: att.size, mime: att.mime });
          }catch(e){ console.error('getDownloadURL error', e); try{ if(att.statusEl) att.statusEl.textContent = 'Erro ao obter link'; }catch(e){}; resolve({ error: e }); }
        });
      }catch(e){ console.warn('uploadPendingAttachment inner', e); resolve({ error: e }); }
    }catch(e){ console.warn('uploadPendingAttachment', e); resolve({ error: e }); }
  });
}

function getAttachmentPreviewHost(){
  try{
    const splash = document.getElementById('splash');
    const splashVisible = !!(splash && splash.style.display !== 'none');
    if(splashVisible){
      return document.getElementById('splash-replies') || document.getElementById('bottom-replies') || document.body;
    }
  }catch(e){}
  return document.getElementById('bottom-replies') || document.getElementById('splash-replies') || document.body;
}

function getAttachmentPreviewRoots(){
  return [
    document.getElementById('bottom-replies'),
    document.getElementById('splash-replies')
  ].filter(Boolean);
}

async function sendMsg(){
  // prefer bottom input when present (visible), fall back to legacy `inp`
  const bottomInput = document.getElementById('inp-bottom');
  const legacyInput = document.getElementById('inp');
  const inpElem = bottomInput || legacyInput;
  if(!inpElem) return;
  const text = (inpElem.value || '').trim();
  // allow sending when there are completed attachments even if text is empty
  const replyRoots = getAttachmentPreviewRoots();
  const previews = replyRoots.reduce((all, root)=>all.concat(Array.from(root.querySelectorAll('.attachment-preview'))), []);
  const completed = previews.filter(p=> p.querySelector('.attachment-status a'));
  const uploading = previews.filter(p=> !p.querySelector('.attachment-status a'));
  const activeUploading = previews.filter(p=>{ const s = p.querySelector('.attachment-status'); return s && /Enviando/i.test((s.textContent||'')); });
  if(!text && !completed.length && !pendingAttachments.length){
    if(activeUploading.length){
      addMsg('ai', 'O upload do(s) anexo(s) ainda está em andamento. Aguarde até terminar.');
    }
    return;
  }
  // clear the visible inputs immediately so the UI doesn't keep showing the sent text
  try{
    const bi = document.getElementById('inp-bottom'); if(bi) { bi.value = ''; bi.style.height = '42px'; }
    const li = document.getElementById('inp'); if(li) { li.value = ''; li.style.height = '42px'; }
  }catch(e){ console.warn('clear inputs after send', e); }
  // intercept Portuguese removal commands and handle locally without calling the IA
  try{
    // accept more verbs (e.g. "tirar", "retirar") and optional articles/plural before the target
    const delMatch = text.match(/^\s*(remover|remova|excluir|exclua|apagar|deletar|tirar|retirar)\s+(?:as?\s+)?(?:tarefas?\s+)?(.+)$/i);
    if(delMatch){
      const target = delMatch[2].trim();
      // check if user referred to a date (hoje, amanhã, dd/mm, yyyy-mm-dd)
      try{
        const dateTarget = parsePortugueseDate(target);
        if(dateTarget){
          const matched = tasks.filter(t=>t.date===dateTarget);
          console.debug('delete-intercept: date removal for', dateTarget, 'matched=', matched.length);
          if(!matched.length){
            addMsg('ai', `Não há tarefas para ${dateTarget}.`);
            inpElem.value=''; inpElem.style.height='42px';
            const sb = document.getElementById('send-btn'); const sbb = document.getElementById('send-btn-bottom');
            if(sb) sb.disabled = false; if(sbb) sbb.disabled = false;
            return;
          }

          // If the date matches a 'onlyExamDay' task, try to remove the whole exam group.
          const examDayTasks = tasks.filter(t => t.onlyExamDay && t.date === dateTarget);
          let removed = [];
          if(examDayTasks.length){
            // prefer examId grouping when present
            const examId = examDayTasks[0].examId || null;
            if(examId){
              removed = tasks.filter(t => t.examId === examId);
              tasks = tasks.filter(t => t.examId !== examId);
            } else {
              // fallback: remove tasks that are marked onlyExam and occur near the exam date (within 7 days)
              const dt = new Date(dateTarget + 'T12:00:00');
              const toRemove = [];
              for(const t of tasks){
                try{
                  if(t && t.onlyExam){
                    const td = new Date((t.date||'') + 'T12:00:00');
                    const diff = Math.round((td.getTime() - dt.getTime())/86400000);
                    if(Math.abs(diff) <= 7) toRemove.push(t);
                  }
                }catch(e){}
              }
              const names = toRemove.map(x=> x.name || '—');
              removed = toRemove.slice();
              tasks = tasks.filter(t => !(t.onlyExam && names.includes(t.name)) );
            }
          } else {
            // non-exam date removal: remove tasks that fall exactly on the date
            removed = matched.slice();
            tasks = tasks.filter(t=>t.date!==dateTarget);
          }

          const removedNames = removed.map(m=>m.name || '—');
          // ensure the user's command isn't left in chat
          removeUserMessage(text);
          saveTasks(); renderCal(); renderTasks(); try{ renderSplashTasks(); }catch(e){}
          addMsg('ai', `Removidas ${removedNames.length} tarefas relacionadas a ${dateTarget}:\n- ${removedNames.join('\n- ')}`);
          try{ for(const r of removed){ await saveEventAndLearning('task.delete', { task: r }); } }catch(e){}
          inpElem.value=''; inpElem.style.height='42px';
          const sb2 = document.getElementById('send-btn'); const sbb2 = document.getElementById('send-btn-bottom');
          if(sb2) sb2.disabled = false; if(sbb2) sbb2.disabled = false;
          return;
        }
      }catch(e){ console.warn('date-removal error', e); }
      // try match by exact or partial name using normalized comparison (ignore accents/punctuation/case)
      const norm = normalizeName(target);
      const candidates = tasks.map((t,i)=>({t,i})).filter(x=> normalizeName(x.t.name||'').includes(norm));
      if(candidates.length===0){
          // debug
          console.debug('delete-intercept: no candidates for', target, 'tasksLoaded=', tasks.length);
          // if nothing matched, offer available task names to help the user
          const available = tasks.map(t=>t.name || '—').slice(0,8).join('\n');
          addMsg('ai', `Não encontrei nenhuma tarefa com "${target}". Tarefas disponíveis:\n${available}\n\nTente usar o nome completo ou diga: "remover tarefa NOME_DA_TAREFA".`);
        // clear input and re-enable buttons
        inpElem.value=''; inpElem.style.height='42px';
        const sb = document.getElementById('send-btn'); const sbb = document.getElementById('send-btn-bottom');
        if(sb) sb.disabled = false; if(sbb) sbb.disabled = false;
        return;
      }
      if(candidates.length===1){
          const idx = candidates[0].i; const name = candidates[0].t.name;
          console.debug('delete-intercept: removing single candidate', name, 'index=', idx);
          // remove user message from chat so the command doesn't stay visible
          removeUserMessage(text);
          tasks.splice(idx,1);
          saveTasks(); renderCal(); renderTasks(); try{ renderSplashTasks(); }catch(e){}
          addMsg('ai', `Tarefa removida: ${name}`);
          // persist event
          try{ saveEventAndLearning('task.delete', { index: idx, task: candidates[0].t }); }catch(e){}
        inpElem.value=''; inpElem.style.height='42px';
        const sb = document.getElementById('send-btn'); const sbb = document.getElementById('send-btn-bottom');
        if(sb) sb.disabled = false; if(sbb) sbb.disabled = false;
        return;
      }
        // multiple candidates -> ask for clarification listing names (avoid numeric selection)
        console.debug('delete-intercept: multiple candidates for', target, candidates.map(c=>c.t.name));
        // remove user message from chat as we are replying with clarification
        removeUserMessage(text);
        const list = candidates.map(c=>`- ${c.t.name} (${c.t.date}${c.t.time? ' '+c.t.time:''})`).join('\n');
        addMsg('ai', `Encontrei várias tarefas parecidas com "${target}". Por favor, diga o nome completo ou detalhe a tarefa que quer remover:\n${list}`);
      inpElem.value=''; inpElem.style.height='42px';
      const sb2 = document.getElementById('send-btn'); const sbb2 = document.getElementById('send-btn-bottom');
      if(sb2) sb2.disabled = false; if(sbb2) sbb2.disabled = false;
      return;
    }
  }catch(e){ console.warn('delete-intercept', e); }
  inpElem.value=''; inpElem.style.height='42px';
  const sendBtn = document.getElementById('send-btn-bottom') || document.getElementById('send-btn');
  if(sendBtn) sendBtn.disabled = true;
  addMsg('user', text);
  // collect attachment markers (upload staged attachments now, and include already-completed ones)
  let userHistoryContent = text;
  let attachLines = [];
  try{

    // track URLs added from staged uploads to avoid duplicates and to remove previews
    let addedUrls = new Set();

    // first, upload any staged attachments (pendingAttachments)
    if(pendingAttachments && pendingAttachments.length){
      const staged = pendingAttachments.slice();
      try{
        const promises = staged.map(att => uploadPendingAttachment(att));
        const results = await Promise.all(promises);
        for(let i=0;i<results.length;i++){
          const res = results[i]; const att = staged[i];
          if(res && res.url){
            try{ addMsg('user', `<a href="${res.url}" target="_blank" rel="noopener noreferrer">${att.name}</a>`); }catch(e){}
            attachLines.push('ATTACHMENT:'+res.url);
            addedUrls.add(res.url);
            if(res.ocr) attachLines.push('OCR_TEXT:'+res.ocr);
            // remove from pending list
            try{ pendingAttachments = pendingAttachments.filter(x=> x.id !== att.id); }catch(e){}
            try{ saveMessageToFirebase('user', 'ATTACHMENT:'+res.url); }catch(e){}
          } else {
            try{ addMsg('ai', 'Falha ao enviar anexo: ' + String(res && res.error ? (res.error.message||res.error) : 'erro')); }catch(e){}
          }
        }
      }catch(e){ console.warn('upload staged attachments failed', e); }
    }

    // then include any previously-completed previews
    if(completed.length){
      for(const p of completed){
        try{
          const a = p.querySelector('.attachment-status a');
          const title = p.querySelector('.attachment-title') ? p.querySelector('.attachment-title').textContent : (a? a.textContent : 'anexo');
          if(a && a.href){
            // skip previews already added from staged uploads
            try{ if(typeof a.href === 'string' && addedUrls && addedUrls.has && addedUrls.has(a.href)) continue; }catch(e){}
            addMsg('user', `<a href="${a.href}" target="_blank" rel="noopener noreferrer">${title}</a>`);
            attachLines.push('ATTACHMENT:'+a.href);
            try{
              const local = loadLocalAttachments().find(x=> x.url === a.href);
              if(local && local.ocr) attachLines.push('OCR_TEXT:'+local.ocr);
            }catch(e){}
            try{ saveMessageToFirebase('user', 'ATTACHMENT:'+a.href); }catch(e){}
          }
        }catch(e){ console.warn('post completed attachment', e); }
      }
    }

    if(attachLines.length){
      if(!userHistoryContent) userHistoryContent = attachLines.join('\n');
      else userHistoryContent = userHistoryContent + '\n' + attachLines.join('\n');
    }

    // If attachments were added, confirm and remove their previews from the chat
    if(attachLines.length){
      try{
        addMsg('ai', 'Anexo(s) enviado(s) e salvo(s) em Anexos.');
        for(const p of previews){
          try{
            // remove staged/pending previews
            if(p.dataset && p.dataset.pending){ p.remove(); continue; }
            const a = p.querySelector('.attachment-status a');
            if(a && a.href && addedUrls && typeof addedUrls.has === 'function' && addedUrls.has(a.href)){
              p.remove();
            }
          }catch(e){}
        }
      }catch(e){}
    }
  }catch(e){ console.warn('sendMsg attachments', e); }
  // save user input for learning/history (include attachment markers so IA sees them)
  try{ saveMessageToFirebase('user', userHistoryContent || ''); }catch(e){}
  saveLearningRecord('message', { role:'user', text: userHistoryContent || '' });
  history.push({role:'user', content: userHistoryContent || ''});
  // If there's no text but there are attachments (staged or completed), just save them and return
  if(!text && attachLines.length){
    try{
      // ensure any completed previews have local records
      for(const p of completed){
        try{
          const a = p.querySelector('.attachment-status a');
          if(a && a.href){
            try{ const exists = loadLocalAttachments().find(x=>x.url===a.href); if(!exists) registerAttachmentLocalRecord(a.textContent||a.href, a.href, 0, ''); }catch(e){}
            try{ saveMessageToFirebase('user', 'ATTACHMENT:'+a.href); }catch(e){}
          }
        }catch(e){ console.warn('saving completed attachment fallback', e); }
      }
    }catch(e){ console.warn('completed-attachments-fallback', e); }
    addMsg('ai', 'Anexo(s) salvo(s) em Anexos.');
    if(sendBtn) sendBtn.disabled = false;
    return;
  }
  const thinking = addThinking();

  // sem chave configurada → mensagem de ajuda
  if(!window.GROQ_API_KEY || window.GROQ_API_KEY==='COLE_SUA_CHAVE_GROQ_AQUI'){
    thinking.remove();
    addMsg('ai','⚠️ Chave Groq não configurada ainda. Edite o arquivo <code>index.html</code>, cole sua chave em <strong>GROQ_API_KEY</strong> e recarregue a página. Crie uma grátis em console.groq.com.');
    const sb = document.getElementById('send-btn'); const sbb = document.getElementById('send-btn-bottom');
    if(sb) sb.disabled = false; if(sbb) sbb.disabled = false;
    return;
  }

  const tasksSummary = tasks.length
    ? 'Tarefas já cadastradas:\n'+tasks.map(t=>`- ${t.name} (${t.cat}, ${t.date}${t.time?' '+t.time:''}, ~${t.est||'?'}min)`).join('\n')
    : 'Nenhuma tarefa ainda.';

  // compute aggregates and build a short summary for the system prompt
  const agg = computeAggregates();
  let aggSummary = '';
  try{
    const cats = agg.byCategory || {};
    const catLines = Object.keys(cats).map(k=>`${k}: média ${cats[k].avg}min (n=${cats[k].n})`).slice(0,6);
    if(catLines.length) aggSummary += 'Histórico por categoria: ' + catLines.join(' ; ') + '\n';
    const names = agg.byName || {};
    const nameLines = Object.keys(names).slice(0,6).map(k=>`${names[k].sample}: média ${names[k].avg}min (n=${names[k].n})`);
    if(nameLines.length) aggSummary += 'Tarefas parecidas: ' + nameLines.join(' ; ') + '\n';
  }catch(e){ aggSummary = ''; }

  const system = `Você é uma agenda inteligente conversacional. O usuário fala em linguagem natural sobre tarefas, provas, compromissos ou objetivos.

Contexto histórico (opcional):\n${aggSummary}

Regras importantes de comportamento:
- Nunca interprete uma mensagem que contenha apenas um ou poucos dígitos (por exemplo: "1", "2") como uma seleção de menu automática. Se o usuário enviar apenas um número, trate isso como texto ambíguo e peça um pequeno esclarecimento antes de executar qualquer ação.
- Não solicite que o usuário responda escolhendo números. Prefira instruções em texto ou passos em linhas separadas.

Seu trabalho:
1. Entender o que precisa ser feito
2. Estimar quanto tempo cada tarefa vai levar (em minutos, seja realista)
3. Sugerir data/hora com base no que o usuário disse (hoje é ${todayStr()}, ${new Date().toLocaleDateString('pt-BR',{weekday:'long'})})
4. Dar um caminho claro de como começar (2 a 4 passos concretos, em linhas separadas; não peça ao usuário para selecionar por número)

Responda em dois blocos separados exatamente por ---JSON---

BLOCO 1: resposta amigável em português. Inclua:
- breve confirmação do que entendeu
- estimativa de tempo total
- 2-4 passos de como começar (em linhas separadas; não peça ao usuário para escolher um número)
- tom direto, sem enrolação, máximo 8 linhas

BLOCO 2 (após ---JSON---): array JSON das novas tarefas extraídas:
[{"name":"nome curto","cat":"trabalho|estudo|pessoal|projeto|outro","date":"YYYY-MM-DD","time":"HH:MM ou null","est":60}]
Se não houver novas tarefas, retorne [].

${tasksSummary}`;


  try {
    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions',{ 
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': 'Bearer '+window.GROQ_API_KEY
      },
      body: JSON.stringify({
        model:    window.GROQ_MODEL,
        messages: [{role:'system',content:system}, ...history],
        temperature: 0.4,
        max_tokens:  900
      })
    });

    const data = await resp.json();
    if(data.error){ throw new Error(data.error.message); }

    const full   = data.choices[0].message.content;
    const parts  = full.split('---JSON---');
    const reply  = parts[0].trim();
    let newTasks = [];

    if(parts[1]){
      try {
        const raw = parts[1].trim().replace(/```json|```/g,'').trim();
        newTasks  = JSON.parse(raw);
      } catch(e){}
    }

    thinking.remove();
    history.push({role:'assistant', content: full});
    addMsg('ai', reply);
    // save assistant reply
    saveMessageToFirebase('assistant', reply);
    saveLearningRecord('message', { role:'assistant', text: reply });

    if(newTasks.length){
      try{
        const attachmentUrls = attachLines.filter(l=> typeof l === 'string' && l.startsWith('ATTACHMENT:')).map(l=> l.replace('ATTACHMENT:',''));

        // For proof-like requests, replace the AI payload with a deterministic study plan around the exam date.
        const examDate = parsePortugueseDate(text) || (newTasks.find(t=> t && t.date && /^\d{4}-\d{2}-\d{2}$/.test(t.date))?.date || null);
        if(isExamPlanningRequest(text) && examDate){
          newTasks = buildExamPlan(examDate, attachmentUrls[0] || null, text);
          try{ window.lastNewTasks = newTasks; }catch(e){}
        } else {
          // if IA didn't provide a proper ISO date, try to parse the user's original text for a date
          newTasks.forEach(t=>{
            try{
              if(!t.date || !/^\d{4}-\d{2}-\d{2}$/.test(t.date)){
                const parsed = parsePortugueseDate(text);
                if(parsed) t.date = parsed;
              }
              if(!t.attachment && attachmentUrls.length && /prova|exame|avalia[çc][aã]o/i.test(text)){
                t.attachment = attachmentUrls[0];
              }
            }catch(e){ }
          });
          try{ window.lastNewTasks = newTasks; }catch(e){}
        }

        newTasks.forEach(t=>{ if(t.name) tasks.push(t); });
        saveTasks();
        // navigate to the month of the first new task (if valid)
        try{
          const d = new Date(newTasks[0].date+'T12:00:00');
          if(!isNaN(d.getTime())){ vy = d.getFullYear(); vm = d.getMonth(); }
        }catch(e){ }
        renderCal();
        renderTasks();
        try{ renderSplashTasks(); }catch(e){}
      }catch(e){ console.warn('handling newTasks failed', e); }
    }

  } catch(err){
    thinking.remove();
    console.error(err);
    const msg = String(err.message || err || 'Erro desconhecido');
    if(/decommissioned|decommission/i.test(msg)){
      addMsg('ai', 'Erro: o modelo configurado foi descontinuado.\nPor favor atualize o modelo Groq nas configurações. Veja: https://console.groq.com/docs/deprecations');
      // show banner so user can change model
      const banner = document.getElementById('setup-banner'); if(banner) banner.classList.remove('hidden');
    } else {
      addMsg('ai','Erro ao conectar com a IA: '+msg+'\n\nVerifique se a chave Groq está correta e se você tem conexão com a internet.');
    }
  }

  if(sendBtn) sendBtn.disabled = false;
}

// ── export to PDF / printable ──────────────────────────────────
function exportPDF(){
  const title = 'Agenda export - '+new Date().toLocaleDateString();
  // build calendar table for current month (vy, vm)
  const monthLabel = MONTHS[vm] + ' ' + vy;
  let html = `<div style="font-family: ${getComputedStyle(document.body).fontFamily}; padding:12px; color:#111">`;
  html += `<h1 style="margin-bottom:8px">${title}</h1><h2 style="margin-top:0;margin-bottom:8px">${monthLabel}</h2>`;
  html += '<table style="width:100%;border-collapse:collapse;border:1px solid #ccc;font-size:12px">';
  // header days
  html += '<thead><tr>';
  for(const d of DAYS){ html += `<th style="border:1px solid #ccc;padding:6px;background:#f6f6f6">${d}</th>`; }
  html += '</tr></thead>';
  // build grid
  const first = new Date(vy,vm,1).getDay();
  const dim = new Date(vy,vm+1,0).getDate();
  let day = 1 - first;
  html += '<tbody>';
  while(day <= dim){
    html += '<tr>';
    for(let col=0; col<7; col++){
      if(day<1 || day>dim){ html += '<td style="border:1px solid #eee;padding:8px;vertical-align:top;background:#fafafa"></td>'; }
      else{
        const ds = vy+'-'+String(vm+1).padStart(2,'0')+'-'+String(day).padStart(2,'0');
        const tasksForDay = tasks.filter(t=>t.date===ds);
        html += `<td style="border:1px solid #eee;padding:8px;vertical-align:top"><div style="font-weight:600;margin-bottom:6px">${day}</div>`;
        if(tasksForDay.length){
          for(const t of tasksForDay){ html += `<div style="margin-bottom:6px;padding:6px;border-radius:6px;background:#fff;border:1px solid #ddd"><strong>${t.name}</strong><div style="color:#666;font-size:11px">${t.time? t.time+' · ' : ''}${t.cat} · ${t.est||''}min</div></div>`; }
        }
        html += `</td>`;
      }
      day++;
    }
    html += '</tr>';
  }
  html += '</tbody></table></div>';

  const w = window.open('', '_blank');
  w.document.write(`<!doctype html><html><head><title>${title}</title></head><body>${html}</body></html>`);
  w.document.close();
  setTimeout(()=>{ w.print(); }, 300);
}

// ── import any: file input handler + smart parsing ─────────────
function triggerImportAny(){ try{ const el = document.getElementById('import-any-file'); if(el) el.click(); }catch(e){ console.warn('triggerImportAny', e); } }

// wire file input change to read file as text and pass to importer (accepts any file)
setTimeout(()=>{
  try{
    const importEl = document.getElementById('import-any-file');
    if(importEl){
      importEl.addEventListener('change', async (ev)=>{
        const f = ev.target.files && ev.target.files[0]; if(!f) return;

        // decide if this should be treated as text (JSON/CSV/TXT) or a binary attachment
        const name = f.name || '';
        const mime = f.type || '';
        const textLike = mime.startsWith('text') || mime === 'application/json' || /\.(json|csv|txt|md|xml)$/i.test(name);

        if(textLike){
          try{
            const txt = await f.text();
            if(txt){ handleImportedText(txt); ev.target.value = ''; return; }
          }catch(e){ console.warn('import file read as text failed', e); }
        }

        // treat as binary attachment -> upload to Firebase Storage
        try{
          let storage = window.storage || null;
          if(!storage && typeof getStorage === 'function' && typeof window.firebaseApp !== 'undefined'){
            storage = getStorage(window.firebaseApp);
          }
          if(!storage){
            addMsg('ai', 'Storage não configurado. Configure Firebase Storage no `index.html` para enviar anexos.');
            ev.target.value = '';
            return;
          }

          const safeName = name.replace(/[^a-zA-Z0-9._-]/g,'_');
          const path = 'attachments/' + Date.now() + '_' + safeName;
          const sref = storageRef(storage, path);

          // create a preview element in bottom-replies so user sees the selected file
          try{
            const bottomReplies = getAttachmentPreviewHost();
            const preview = document.createElement('div'); preview.className = 'attachment-preview';
            const thumbWrap = document.createElement('div'); thumbWrap.className = 'attachment-thumbwrap';
            if(mime.startsWith('image/')){
              const img = document.createElement('img'); img.className = 'attachment-thumb'; img.src = URL.createObjectURL(f);
              thumbWrap.appendChild(img);
            } else {
              const icon = document.createElement('div'); icon.className = 'attachment-icon'; icon.textContent = name.split('.').pop().toUpperCase(); thumbWrap.appendChild(icon);
            }
            const meta = document.createElement('div'); meta.className = 'attachment-meta';
            const title = document.createElement('div'); title.className = 'attachment-title'; title.textContent = name;
            const size = document.createElement('div'); size.className = 'attachment-size'; size.textContent = Math.round(f.size/1024) + ' KB';
            const status = document.createElement('div'); status.className = 'attachment-status'; status.textContent = 'Enviando...';
            const progressOuter = document.createElement('div'); progressOuter.className = 'attachment-progress-outer';
            const progressBar = document.createElement('div'); progressBar.className = 'attachment-progress-bar'; progressBar.style.width = '0%';
            progressOuter.appendChild(progressBar);
            const cancelBtn = document.createElement('button'); cancelBtn.className = 'attachment-cancel'; cancelBtn.type = 'button'; cancelBtn.textContent = '✕';

            meta.appendChild(title); meta.appendChild(size); meta.appendChild(status); meta.appendChild(progressOuter);
            preview.appendChild(thumbWrap); preview.appendChild(meta); preview.appendChild(cancelBtn);
            bottomReplies.classList.remove('hidden'); bottomReplies.appendChild(preview);

            // stage attachment for upload when the user clicks Send (do not upload now)
            try{
              const attId = 'p_'+Date.now()+'_'+Math.floor(Math.random()*10000);
              status.textContent = 'Enviando...';
              progressBar.style.width = '0%';
              const att = { id: attId, file: f, name, mime, size: f.size, path, sref, preview, statusEl: status, progressBar, titleEl: title };
              // mark preview as pending so reconcilier won't auto-save it
              try{ preview.dataset.pending = attId; preview.classList.add('attachment-pending'); }catch(e){}
              pendingAttachments.unshift(att);

              // start upload immediately to show progress, but do not persist metadata until user sends
              try{ uploadPendingAttachment(att, false).catch(e=>console.warn('upload (no-persist) failed', e)); }catch(e){ console.warn('start upload failed', e); }

              cancelBtn.addEventListener('click', ()=>{
                try{
                  // if upload started, attempt cancel
                  if(att.uploadTask){ try{ att.uploadTask.cancel(); }catch(e){} }
                }catch(e){}
                // remove preview and remove from staging
                try{ preview.remove(); }catch(e){}
                try{ pendingAttachments = pendingAttachments.filter(x=> x.id !== att.id); }catch(e){}
                ev.target.value = '';
              });
            }catch(e){ console.warn('stage attachment failed', e); ev.target.value = ''; }
          }catch(e){
            console.error('preview/upload error', e);
            addMsg('ai', 'Erro ao processar anexo: '+ (e && e.message ? e.message : String(e)) );
            ev.target.value = '';
          }
          return;
        }catch(e){
          console.error('upload failed', e);
          addMsg('ai', 'Falha ao enviar anexo: '+ String(e && e.message ? e.message : e));
          ev.target.value = '';
          return;
        }
      });
    }
  }catch(e){ console.warn('wire import-any-file', e); }
}, 80);

// bottom action panel toggle and wiring
setTimeout(()=>{
  try{
    const fileInput = document.getElementById('import-any-file');
    const attachBtn = document.getElementById('input-attach-btn');
    const splashAttachBtn = document.getElementById('splash-attach-btn');
    // wire attach button inside input to open file picker
    if(attachBtn && fileInput){
      attachBtn.addEventListener('click', ()=>{ fileInput.click(); });
    }
    if(splashAttachBtn && fileInput){
      splashAttachBtn.addEventListener('click', ()=>{ fileInput.click(); });
    }
  }catch(e){ console.warn('bottom action wiring', e); }
}, 120);

function handleImportedText(txt){
  const bottomInput = document.getElementById('inp-bottom');
  const legacyInput = document.getElementById('inp');
  const targetInput = bottomInput || legacyInput;

  // try JSON
  try{
    const parsed = JSON.parse(txt);
    if(Array.isArray(parsed)){
      // try detect tasks
      const maybeTasks = parsed.filter(p=>p && p.name && p.date);
      if(maybeTasks.length){ tasks = tasks.concat(maybeTasks); saveTasks(); renderCal(); renderTasks(); alert('Importadas '+maybeTasks.length+' tarefas.'); return; }
      // otherwise treat as messages/history: push to chat as user content
      const content = JSON.stringify(parsed, null, 2);
      if(targetInput){ targetInput.value = content; sendMsg(); } else { document.getElementById('inp').value = content; sendMsg(); }
      return;
    }else if(parsed && typeof parsed === 'object'){
      // single object: either task or message
      if(parsed.name && parsed.date){ tasks.push(parsed); saveTasks(); renderCal(); renderTasks(); alert('Tarefa importada.'); return; }
      if(targetInput){ targetInput.value = JSON.stringify(parsed, null, 2); sendMsg(); } else { document.getElementById('inp').value = JSON.stringify(parsed, null, 2); sendMsg(); }
      return;
    }
  }catch(e){ /* not JSON */ }

  // try CSV: heuristic - lines with date,name
  const lines = txt.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  if(lines.length>1 && lines[0].includes(',')){
    const imported = [];
    for(const l of lines){ const parts = l.split(',').map(p=>p.trim()); if(parts[0] && parts[1]){
      const date = parts[0]; const name = parts[1]; imported.push({ name, date, time:null, cat:'outro', est:60 });
    }}
    if(imported.length){ tasks = tasks.concat(imported); saveTasks(); renderCal(); renderTasks(); alert('Importadas '+imported.length+' tarefas (CSV).'); return; }
  }

  // fallback: treat as free text and send to chat (prefer bottom input)
  if(targetInput){ targetInput.value = txt.slice(0, 4000); sendMsg(); }
  else { document.getElementById('inp').value = txt.slice(0, 4000); sendMsg(); }
}

// expose new functions
window.exportPDF = exportPDF;
window.triggerImportAny = triggerImportAny;

// ── Firebase helpers (Firestore) ────────────────────────────
async function saveToFirebase(tasksList){
  try{
    if (!window.auth || !window.auth.currentUser) {
      console.warn('Not authenticated, skipping Firebase save');
      return;
    }
    const col = getUserCollection('tasks');
    if (!col) return;
    const existing = await getDocs(col);
    const batch = writeBatch(window.db);
    // delete existing docs
    for(const d of existing.docs){
      batch.delete(d.ref);
    }
    // add new docs with generated ids
    for(const t of tasksList){
      const data = Object.assign({}, t);
      if(data._id) delete data._id;
      if(t._id){
        const ref = doc(window.db, 'users', window.auth.currentUser.uid, 'tasks', t._id);
        batch.set(ref, data);
      } else {
        const newRef = doc(col);
        batch.set(newRef, data);
      }
    }
    await batch.commit();
  }catch(e){ console.error('saveToFirebase', e); }
}

// save an arbitrary event (non-blocking)
async function saveEventToFirebase(type, payload){
  try{
    if(!window.db) return;
    const col = getUserCollection('events');
    if (!col) return;
    await addDoc(col, { type, payload, ts: new Date().toISOString() });
  }catch(e){ console.warn('saveEventToFirebase', e); }
}

// extend event saving to learning
async function saveEventAndLearning(type, payload){
  try{
    await saveEventToFirebase(type, payload);
  }catch(e){}
  // also save to learning collection if enabled
  try{ await saveLearningRecord(type, payload); }catch(e){}
}

// ── mark task done modal and handlers ───────────────────────
let __completeIndex = null;
function markTaskDone(i){
  const t = tasks[i]; if(!t) return alert('Tarefa não encontrada');
  __completeIndex = i;
  const label = document.getElementById('complete-task-label'); if(label) label.textContent = `${t.name} — ${t.date}${t.time? ' · '+t.time : ''}`;
  const inp = document.getElementById('complete-minutes'); if(inp){ inp.value = t.actualDuration || t.est || ''; }
  document.getElementById('complete-modal').classList.remove('hidden');
}

function hideCompleteModal(){
  __completeIndex = null;
  document.getElementById('complete-modal').classList.add('hidden');
}

async function confirmComplete(){
  let completedName = null;
  try{
    console.debug('confirmComplete: start', __completeIndex);
    if(__completeIndex===null) { hideCompleteModal(); return; }
    const i = __completeIndex; const t = tasks[i]; if(!t){ hideCompleteModal(); return; }
    const val = parseInt((document.getElementById('complete-minutes')||{}).value,10);
    const minutes = isNaN(val) ? (t.est||60) : val;
    t.completedAt = new Date().toISOString();
    t.actualDuration = minutes;
    completedName = t.name;
    // disable confirm button to avoid duplicate clicks
    const btnC = document.getElementById('complete-confirm-btn'); if(btnC) btnC.disabled = true;
    saveTasks(); renderCal(); renderTasks();
    // save event to firebase (best-effort)
    try{
      await saveEventAndLearning('task.complete', { taskId: t._id || null, name: t.name, date: t.date, minutes });
    }catch(e){ console.warn('confirmComplete event save', e); }
    console.debug('confirmComplete: done', t && t.name);
  }catch(err){
    console.error('confirmComplete error', err);
  }finally{
    // always try to hide modal and re-enable button
    try{ hideCompleteModal(); }catch(e){ console.warn('hideCompleteModal failed', e); }
    const btnC2 = document.getElementById('complete-confirm-btn'); if(btnC2) btnC2.disabled = false;
    // defensive: if the modal element is still visible for any reason, force-hide it (inline style)
    try{
      const modalEl = document.getElementById('complete-modal');
      if(modalEl){ modalEl.classList.add('hidden'); modalEl.style.display = 'none'; modalEl.setAttribute('aria-hidden','true'); }
    }catch(e){ console.warn('force-hide complete modal failed', e); }
    // refresh splash tasks so the completed task disappears but keep the splash open
    try{ renderSplashTasks(); }catch(e){ console.warn('renderSplashTasks after complete', e); }
    // fallback: remove matching splash DOM node if still present
    try{
      if(completedName){
        const el = document.getElementById('splash-tasks');
        if(el){
          const nodes = Array.from(el.querySelectorAll('.splash-task'));
          nodes.forEach(n=>{
            const nm = (n.querySelector('.splash-task-name')||{}).textContent || '';
            if(nm && nm.trim() === completedName.trim()) n.remove();
          });
        }
      }
    }catch(e){ console.warn('cleanup splash node failed', e); }
  }
}

// wire modal buttons
setTimeout(()=>{
  const btnC = document.getElementById('complete-confirm-btn');
  if(btnC) btnC.addEventListener('click', (e)=>{ try{ btnC.disabled = true; confirmComplete(); }catch(err){ console.warn('confirm btn wrapper', err); btnC.disabled = false; } });
  const btnX = document.getElementById('complete-cancel-btn'); if(btnX) btnX.addEventListener('click', (e)=>{ try{ console.debug('cancel click'); hideCompleteModal(); }catch(err){ console.warn('cancel handler', err); } });
  // add custom spinner buttons next to the duration input (avoid native low-contrast spinners)
  try{
    const comp = document.getElementById('complete-minutes');
    if(comp){
      // wrap the input in a positioned container so buttons align with the input
      let inputWrap = comp.closest('.num-spin-input-wrap');
      if(!inputWrap){
        inputWrap = document.createElement('div');
        inputWrap.className = 'num-spin-input-wrap';
        inputWrap.style.position = 'relative';
        inputWrap.style.display = 'block';
        inputWrap.style.width = '100%';
        comp.parentNode.replaceChild(inputWrap, comp);
        inputWrap.appendChild(comp);
      }
      // avoid duplicate wrapper
      if(!inputWrap.querySelector('.num-spin-wrapper')){
        const wrapper = document.createElement('div'); wrapper.className = 'num-spin-wrapper';
        const up = document.createElement('button'); up.type='button'; up.className='num-spin-btn up'; up.innerHTML = '▲';
        const down = document.createElement('button'); down.type='button'; down.className='num-spin-btn down'; down.innerHTML = '▼';
        wrapper.appendChild(up); wrapper.appendChild(down);
        inputWrap.appendChild(wrapper);
        up.addEventListener('click', ()=>{ try{ const v = Math.max(1, (parseInt(comp.value||'0',10)||0)+1); comp.value = String(v); comp.dispatchEvent(new Event('input')); }catch(e){} });
        down.addEventListener('click', ()=>{ try{ const v = Math.max(1, (parseInt(comp.value||'0',10)||0)-1); comp.value = String(v); comp.dispatchEvent(new Event('input')); }catch(e){} });
      }
    }
  }catch(e){ console.warn('wire spinner buttons', e); }
}, 120);

async function loadFromFirebase(){
  try{
    if (!window.auth || !window.auth.currentUser) {
      console.warn('Not authenticated, skipping Firebase load');
      return;
    }
    const col   = getUserCollection('tasks');
    if (!col) return;
    const snap  = await getDocs(col);
    // preserve Firestore id in _id so we can sync edits/deletes later
    tasks = snap.docs.map(d=>Object.assign({ _id: d.id }, d.data()));
    renderCal();
    renderTasks();
    try{ renderSplashTasks(); }catch(e){}
  }catch(e){ console.error('loadFromFirebase', e); }
}
// Load messages from Firestore for current user
async function loadMessagesFromFirebase(){
  try{
    if (!window.auth || !window.auth.currentUser) return [];
    const col = getUserCollection('messages');
    if (!col) return [];
    const snap = await getDocs(col);
    const messages = snap.docs.map(d=>Object.assign({ _id: d.id }, d.data()));
    return messages;
  }catch(e){ console.warn('loadMessagesFromFirebase', e); return []; }
}

// If Firebase is configured, load tasks automatically from Firestore on init
if(window.db){
  try{
    // only auto-load from Firebase if there are no local tasks AND a user is signed in
    if(window.auth && window.auth.currentUser){
      if(!tasks || tasks.length===0){
        loadFromFirebase().catch(e=>console.warn('auto loadFromFirebase', e));
      } else {
        console.debug('Local tasks present; skipping auto loadFromFirebase to avoid overwriting.');
      }
    } else {
      console.debug('No authenticated user; skipping auto loadFromFirebase.');
    }
  }catch(e){ console.warn('loadFromFirebase init', e); }
}

// ── init ──────────────────────────────────────────────────────────
// splash control: show splash by default; user can type or skip
function hideSplash(){
  const s = document.getElementById('splash'); if(!s) return; s.style.display = 'none';
  // show bottom IA bar with animation and focus
  const bar = document.getElementById('bottom-ia-bar') || document.getElementById('bottom-ia');
  const barEl = document.getElementById('bottom-ia-bar') || document.querySelector('.bottom-ia');
  if(barEl) { barEl.classList.add('visible'); }
  const bottomInp = document.getElementById('inp-bottom');
  const legacyInp = document.getElementById('inp');
  // focus the bottom input if present, otherwise the legacy input
  setTimeout(()=>{ if(bottomInp) bottomInp.focus(); else if(legacyInp) legacyInp.focus(); }, 260);
}

function handleSplashSend(){
  const val = (document.getElementById('splash-inp')||{}).value || '';
  // keep splash visible so responses appear there; forward text to main input and send
  if(val.trim()){
    const bottom = document.getElementById('inp-bottom');
    const mainInp = bottom || document.getElementById('inp');
    if(mainInp) mainInp.value = val.trim();
    // clear splash input so user sees response area below
    try{ document.getElementById('splash-inp').value = ''; }catch(e){}
    // small delay so focus settles
    setTimeout(()=>{ sendMsg(); }, 220);
  } else {
    // if empty, behave like previous "Não tenho nada"
    hideSplash();
  }
}

function handleSplashEmpty(){ hideSplash(); }

// attach splash listeners
setTimeout(()=>{
  const snd = document.getElementById('splash-send-btn'); if(snd) snd.addEventListener('click', handleSplashSend);
  const emp = document.getElementById('splash-empty-btn'); if(emp) emp.addEventListener('click', handleSplashEmpty);
  const sinp = document.getElementById('splash-inp'); if(sinp) sinp.addEventListener('keydown', (e)=>{ if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); handleSplashSend(); } });
  // ensure bottom bar exists and hide it initially (will be shown after splash)
  const bottom = document.getElementById('bottom-ia-bar') || document.querySelector('.bottom-ia');
  if(bottom) { bottom.classList.remove('visible'); }
  // allow closing splash by clicking on the overlay background
  const splashEl = document.getElementById('splash');
  if(splashEl){
    splashEl.addEventListener('click', (e)=>{ if(e.target === splashEl) hideSplash(); });
  }
  // if chat column is hidden, switch to single-column layout so calendar centers
  const chatCol = document.getElementById('chat-col');
  const appEl = document.querySelector('.app');
  if(chatCol && appEl && chatCol.classList.contains('hidden')){
    appEl.classList.add('single-column');
  }
  try{ renderSplashTasks(); }catch(e){}
}, 60);
renderCal();
renderTasks();
// if the auth state was already established before app.js loaded, ensure welcome gate runs
function initWelcomeGateRetry(attempt = 0){
  try{
    if(window && window.auth && window.auth.currentUser){
      refreshWelcomeGate(window.auth.currentUser);
      return;
    }
    if(attempt < 20){
      setTimeout(()=>initWelcomeGateRetry(attempt + 1), 150);
    }
  }catch(e){ console.warn('welcome gate init check failed', e); }
}
setTimeout(()=>initWelcomeGateRetry(0), 120);
// wire logout modal buttons
setTimeout(()=>{
  try{
    const cancelBtn = document.getElementById('logout-cancel-btn');
    const confirmBtn = document.getElementById('logout-confirm-btn');
    const modal = document.getElementById('logout-modal');
    if(cancelBtn){ cancelBtn.addEventListener('click', ()=>{ if(modal) modal.classList.add('hidden'); }); }
    if(confirmBtn){ confirmBtn.addEventListener('click', async ()=>{ try{ await window.performLogout(); }catch(e){ console.warn('performLogout click failed', e); } }); }
  }catch(e){ console.warn('wire logout modal failed', e); }
}, 120);
// expõe funções usadas em handlers inline
window.sendMsg = sendMsg;
window.handleKey = handleKey;
window.autoResize = autoResize;
window.changeMonth = changeMonth;
// set model input and expose setter
function setGroqModelFromInput(){
  const inp = document.getElementById('groq-model-input');
  if(!inp) return;
  const val = inp.value.trim();
  if(!val) return alert('Informe o nome do modelo Groq');
  window.GROQ_MODEL = val;
  const lbl = document.getElementById('model-label'); if(lbl) lbl.textContent = (window.GROQ_MODEL?window.GROQ_MODEL:'groq') ;
  alert('Modelo Groq atualizado: '+window.GROQ_MODEL);
}
window.setGroqModelFromInput = setGroqModelFromInput;
// prefill model input if present
const mi = document.getElementById('groq-model-input'); if(mi && window.GROQ_MODEL) mi.value = window.GROQ_MODEL;

// wire learning toggle and clear history
try{
  // ensure learning is always enabled by default
  try{ localStorage.setItem('agenda_learning', '1'); }catch(e){}
  const clearBtn = document.getElementById('clear-history');
  if(clearBtn){ clearBtn.addEventListener('click', ()=>{
    if(!confirm('Limpar histórico local (durações e agregados)?')) return;
    // remove completion metadata from tasks
    tasks = tasks.map(t=>{ const copy = Object.assign({}, t); delete copy.actualDuration; delete copy.completedAt; return copy; });
    localStorage.removeItem('agenda_aggregates');
    saveTasks(); renderCal(); renderTasks();
    alert('Histórico local limpo.');
  }); }
}catch(e){ console.warn('init learning toggle', e); }

// Logout handler
// show logout modal (actual logout performed by performLogout)
window.handleLogout = function(){
  const modal = document.getElementById('logout-modal'); if(!modal) return;
  modal.classList.remove('hidden');
}

function showLoggedOutUI(){
  try{
    const authContainer = document.getElementById('auth-container');
    const appElement = document.querySelector('.app');
    const setupBanner = document.getElementById('setup-banner');
    const bottom = document.getElementById('bottom-ia-bar');
    const splash = document.getElementById('splash');
    const profileModal = document.getElementById('profile-modal');
    if(authContainer){
      authContainer.classList.add('show');
      authContainer.style.display = 'flex';
    }
    if(appElement) appElement.style.display = 'none';
    if(setupBanner) setupBanner.style.display = 'none';
    if(bottom) bottom.style.display = 'none';
    if(splash) splash.style.display = 'none';
    if(profileModal) profileModal.classList.add('hidden');
  }catch(e){ console.warn('showLoggedOutUI', e); }
}

// perform actual logout (previous handleLogout implementation)
window.performLogout = async function(){
  try {
    console.debug('performLogout: starting logout flow');
    // Save any pending tasks before logout (only if authenticated)
    if (tasks && tasks.length > 0) {
      if(window.auth && window.auth.currentUser){
        // fire-and-forget: don't block logout on network/storage latency
        saveToFirebase(tasks).catch(e => console.warn('saveToFirebase before logout', e));
      } else {
        console.debug('Not authenticated — skipping Firebase save before logout');
      }
      try{
        const key = getUserLocalStorageKey('agenda_tasks');
        localStorage.setItem(key, JSON.stringify(tasks));
      }catch(e){ console.warn('persist before logout failed', e); }
    }

    // Clear local state
    tasks = [];
    history = [];
    pendingAttachments = [];
    localStorage.removeItem('agenda_timer');
    localStorage.removeItem('agenda_aggregates');

    // hide logout modal if open
    try{ const modal = document.getElementById('logout-modal'); if(modal) modal.classList.add('hidden'); }catch(e){}

    // Sign out - prefer the global window.signOut if present, else use imported signOut
    try{
      const fn = (window && window.signOut) ? window.signOut : (typeof signOut === 'function' ? signOut : null);
      if(fn){
        await fn(window.auth);
        showLoggedOutUI();
      } else {
        console.warn('performLogout: no signOut function available');
      }
    }catch(e){ console.error('performLogout -> signOut failed', e); throw e; }

    // ensure the UI reflects logout immediately even if auth callback is delayed
    showLoggedOutUI();
    try{ if(window.handleAuthStateChange) window.handleAuthStateChange(null); }catch(e){}
  } catch (error) {
    console.error('Logout error:', error);
    alert('Erro ao fazer logout. Tente novamente.');
  }
}