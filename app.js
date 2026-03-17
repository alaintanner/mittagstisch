/* ══════════════════════════════════════════════
   ╔══════════════════════════════════════════╗
   ║  KONFIGURATION — hier anpassen           ║
   ╚══════════════════════════════════════════╝

   mode:
     'local'      → Daten im Browser (localStorage), kein Server nötig
     'sharepoint' → Daten via SharePoint REST API + MSAL-Login
                    Funktioniert von Azure Static Web App oder lokal

   clientId:  App-ID aus Azure AD App-Registrierung
   tenantId:  Tenant-ID (aus Azure AD → Übersicht)
   ══════════════════════════════════════════════ */
const CONFIG = {
  mode: 'sharepoint',   // ← 'local' oder 'sharepoint'

  sharepoint: {
    siteUrl:  'https://tannerone.sharepoint.com/sites/vsl',
    clientId: 'db3df286-8b33-4e88-86b0-77435f625d17',     // ← aus Azure AD App-Registrierung eintragen
    tenantId: 'ed4ab287-2efb-4ea1-8e00-c817f9f69b3f',  // ← aus Azure AD → Übersicht → Verzeichnis-ID
    lists: {
      kinder:        'Mittagstisch_Kinder',
      raeume:        'Mittagstisch_Raeume',
      schulhaeuser:  'Mittagstisch_Schulhaeuser',
      einstellungen: 'Mittagstisch_Einstellungen',
    }
  }
};
/* ══════════════════════════════════════════════ */

/* ══════════════════════════════════════════════
   MSAL — Microsoft Authentication
   ══════════════════════════════════════════════ */
let msalInstance = null;
let msalAccount  = null;

function initMsal() {
  if (CONFIG.mode !== 'sharepoint') return;
  msalInstance = new msal.PublicClientApplication({
    auth: {
      clientId:    CONFIG.sharepoint.clientId,
      authority:   `https://login.microsoftonline.com/${CONFIG.sharepoint.tenantId}`,
      redirectUri: window.location.origin + window.location.pathname,
    },
    cache: { cacheLocation: 'localStorage', storeAuthStateInCookie: true }
  });
}

async function msalLogin() {
  const resp = await msalInstance.handleRedirectPromise();
  if (resp) { msalAccount = resp.account; return; }
  const accounts = msalInstance.getAllAccounts();
  if (accounts.length > 0) { msalAccount = accounts[0]; return; }
  // Noch nicht angemeldet → Redirect zu Microsoft
  await msalInstance.loginRedirect({
    scopes: ['https://tannerone.sharepoint.com/AllSites.Manage']
  });
}

async function getToken() {
  if (!msalInstance || !msalAccount) throw new Error('Nicht angemeldet');
  try {
    const r = await msalInstance.acquireTokenSilent({
      scopes:  ['https://tannerone.sharepoint.com/AllSites.Manage'],
      account: msalAccount
    });
    return r.accessToken;
  } catch(e) {
    await msalInstance.acquireTokenRedirect({
      scopes: ['https://tannerone.sharepoint.com/AllSites.Manage']
    });
  }
}

/* ══════════════════════════════════════════════
   SHAREPOINT REST API (Bearer Token via MSAL)
   ══════════════════════════════════════════════ */
const SP = {
  get siteUrl() { return CONFIG.sharepoint.siteUrl; },
  get lists()   { return CONFIG.sharepoint.lists; },

  async h(write=false) {
    const token = await getToken();
    const h = {
      'Authorization': `Bearer ${token}`,
      'Accept':        'application/json;odata=nometadata',
      'Content-Type':  'application/json'
    };
    return h;
  },

  async getItems(listName, select='', filter='', top=5000) {
    let url = `${SP.siteUrl}/_api/web/lists/getbytitle('${encodeURIComponent(listName)}')/items?$top=${top}`;
    if (select) url += `&$select=${select}`;
    if (filter) url += `&$filter=${filter}`;
    const r = await fetch(url, { headers: await SP.h() });
    if (!r.ok) throw new Error(`Liste «${listName}» nicht erreichbar (${r.status})`);
    return (await r.json()).value;
  },

  async createItem(listName, data) {
    const r = await fetch(
      `${SP.siteUrl}/_api/web/lists/getbytitle('${encodeURIComponent(listName)}')/items`,
      { method:'POST', headers: await SP.h(), body: JSON.stringify(data) }
    );
    if (!r.ok) throw new Error(`Erstellen fehlgeschlagen (${r.status})`);
    return await r.json();
  },

  async updateItem(listName, id, data) {
    const token = await getToken();
    const r = await fetch(
      `${SP.siteUrl}/_api/web/lists/getbytitle('${encodeURIComponent(listName)}')/items(${id})`,
      { method:'POST', headers: {
          'Authorization': `Bearer ${token}`,
          'Accept':        'application/json;odata=nometadata',
          'Content-Type':  'application/json',
          'IF-MATCH':      '*',
          'X-HTTP-Method': 'MERGE'
        }, body: JSON.stringify(data) }
    );
    if (!r.ok) throw new Error(`Update fehlgeschlagen (${r.status})`);
  },

  async deleteItem(listName, id) {
    const token = await getToken();
    const r = await fetch(
      `${SP.siteUrl}/_api/web/lists/getbytitle('${encodeURIComponent(listName)}')/items(${id})`,
      { method:'POST', headers: {
          'Authorization': `Bearer ${token}`,
          'Accept':        'application/json;odata=nometadata',
          'Content-Type':  'application/json',
          'IF-MATCH':      '*',
          'X-HTTP-Method': 'DELETE'
        } }
    );
    if (!r.ok) throw new Error(`Löschen fehlgeschlagen (${r.status})`);
  },

  async loadAll() {
    loader(true);
    try {
      const [kindItems, raumItems, shItems, einstItems] = await Promise.all([
        SP.getItems(SP.lists.kinder,       'ID,Vorname,Nachname,Klasse,Lehrperson,Bemerkungen,SchulhausId,RaumId,StandardRaumId,HatGegessen,Tage'),
        SP.getItems(SP.lists.raeume,       'ID,Title,Farbe,SchulhausId'),
        SP.getItems(SP.lists.schulhaeuser, 'ID,Title,Ort'),
        SP.getItems(SP.lists.einstellungen,'ID,Title,Wert'),
      ]);
      State.schulhaeuser = shItems.map(s => ({ id:String(s.ID), _spId:s.ID, name:s.Title, ort:s.Ort||'' }));
      State.raeume  = raumItems.map(r => ({ id:String(r.ID), _spId:r.ID, label:r.Title, farbe:r.Farbe||'#4a9eff', schulhausId:String(r.SchulhausId||'') }));
      State.kinder  = kindItems.map(k => ({
        id:String(k.ID), _spId:k.ID,
        vorname:k.Vorname||'', nachname:k.Nachname||'',
        klasse:k.Klasse||'', lehrperson:k.Lehrperson||'',
        bemerkungen:k.Bemerkungen||'',
        schulhausId:String(k.SchulhausId||''),
        raumId:String(k.RaumId||'0'),
        standardRaumId:String(k.StandardRaumId||'0'),
        hatGegessen:k.HatGegessen===true||k.HatGegessen==='true'||k.HatGegessen===1,
        tage:(() => { try { return JSON.parse(k.Tage||'[]'); } catch{ return []; } })()
      }));
      einstItems.forEach(e => {
        try {
          const val = JSON.parse(e.Wert||'{}');
          if (e.Title==='theme')    State.theme    = { ...State.theme,    ...val };
          if (e.Title==='branding') State.branding = { ...State.branding, ...val };
          if (e.Title==='users')    State.users    = val;
        } catch{}
      });
      if (!State.users.some(u=>u.role==='global-admin')) {
        State.users.push({ id:uid(), username:'admin', displayName:'Administrator',
          passwordHash:hashPw('admin123'), role:'global-admin', schulhausIds:[], raumIds:[] });
        await SP.saveSettings('users', State.users);
      }
    } catch(e) { loader(false); throw e; }
    loader(false);
  },

  async saveSettings(key, val) {
    const wert = JSON.stringify(val);
    try {
      const items = await SP.getItems(SP.lists.einstellungen, 'ID,Title', `Title eq '${key}'`);
      if (items.length) await SP.updateItem(SP.lists.einstellungen, items[0].ID, { Wert:wert });
      else              await SP.createItem(SP.lists.einstellungen, { Title:key, Wert:wert });
    } catch(e) { console.warn('saveSettings:', e); }
  },

  kindToSP(k) {
    return {
      Vorname:k.vorname, Nachname:k.nachname, Klasse:k.klasse,
      Lehrperson:k.lehrperson, Bemerkungen:k.bemerkungen,
      SchulhausId:parseInt(k.schulhausId)||0,
      RaumId:parseInt(k.raumId)||0,
      StandardRaumId:parseInt(k.standardRaumId)||0,
      HatGegessen:k.hatGegessen,
      Tage:JSON.stringify(k.tage||[])
    };
  }
};

/* ══════════════════════════════════════════════
   STORAGE KEY & DEFAULTS
   ══════════════════════════════════════════════ */
const STORAGE_KEY = 'mittagstisch_v5';
const DAYS = ['', 'Mo', 'Di', 'Mi', 'Do', 'Fr'];
const COLOR_PRESETS = ['#4a9eff','#3ecf8e','#f4a621','#b06dff','#ff6b6b','#e8a44a','#06b6d4','#f43f5e','#a3e635','#fb923c','#c026d3','#0ea5e9'];
const ROLE_COLORS = { 'global-admin': '#e8a44a', 'admin-sbe': '#64aeff', 'team': '#4ade96' };
const ROLE_LABELS = { 'global-admin': 'Global-Admin', 'admin-sbe': 'Admin-SBE', 'team': 'Team' };

/* ══════════════════════════════════════════════
   STATE
   ══════════════════════════════════════════════ */
let State = {
  schulhaeuser: [],
  raeume: [],
  kinder: [],
  mitarbeitende: [],
  users: [],
  theme: { accentColor:'#1a73e8', eatenColor:'#1e8c4a', pendingColor:'#d93025', warnColor:'#f29900', bgBase:'#f6f8fc', bgSurface:'#ffffff' },
  branding: { title:'Mittagstisch', subtitle:'', iconEmoji:'🍽️', headerBg:'#141820', headerText:'#eef2f8' },
};

let Session = { user: null, activeSchulhausId: null };
const SESSION_KEY = 'mittagstisch_session';

function saveSession() {
  if (Session.user) {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({
      userId: Session.user.id,
      activeSchulhausId: Session.activeSchulhausId
    }));
  } else {
    sessionStorage.removeItem(SESSION_KEY);
  }
}

function restoreSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return false;
    const s = JSON.parse(raw);
    const user = State.users.find(u => u.id === s.userId);
    if (!user) return false;
    Session.user = user;
    Session.activeSchulhausId = s.activeSchulhausId || null;
    return true;
  } catch(e) { return false; }
}

/* ══════════════════════════════════════════════
   PERSISTENZ — dual mode
   ══════════════════════════════════════════════ */
function save() {
  if (CONFIG.mode === 'sharepoint') return; // SP: jede Operation spart direkt
  localStorage.setItem(STORAGE_KEY, JSON.stringify(State));
}

function load() {
  if (CONFIG.mode === 'sharepoint') return; // SP: wird via SP.loadAll() geladen
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) State = { ...State, ...JSON.parse(raw) };
  } catch(e) {}
  if (!State.users.some(u => u.role === 'global-admin')) {
    State.users.push({ id:uid(), username:'admin', displayName:'Administrator',
      passwordHash:hashPw('admin123'), role:'global-admin', schulhausIds:[], raumIds:[] });
    save();
  }
}

/* SP-Speicherfunktionen: werden aufgerufen statt save() im SP-Modus */
async function spSaveKind(kind) {
  if (CONFIG.mode!=='sharepoint') return;
  try {
    if (kind._spId) await SP.updateItem(SP.lists.kinder, kind._spId, SP.kindToSP(kind));
    else {
      const res = await SP.createItem(SP.lists.kinder, SP.kindToSP(kind));
      kind._spId = res.ID; kind.id = String(res.ID);
    }
  } catch(e) { toast('SP-Fehler: '+e.message); }
}

async function spDeleteKind(spId) {
  if (CONFIG.mode!=='sharepoint'||!spId) return;
  try { await SP.deleteItem(SP.lists.kinder, spId); } catch(e) { toast('SP-Fehler: '+e.message); }
}

async function spSaveKindField(kind, fields) {
  if (CONFIG.mode!=='sharepoint'||!kind._spId) return;
  try { await SP.updateItem(SP.lists.kinder, kind._spId, fields); } catch(e) { toast('SP-Fehler: '+e.message); }
}

async function spSaveRaum(raum) {
  if (CONFIG.mode!=='sharepoint') return;
  const data = { Title:raum.label, Farbe:raum.farbe, SchulhausId:parseInt(raum.schulhausId)||0 };
  try {
    if (raum._spId) await SP.updateItem(SP.lists.raeume, raum._spId, data);
    else { const res=await SP.createItem(SP.lists.raeume,data); raum._spId=res.ID; raum.id=String(res.ID); }
  } catch(e) { toast('SP-Fehler: '+e.message); }
}

async function spDeleteRaum(spId) {
  if (CONFIG.mode!=='sharepoint'||!spId) return;
  try { await SP.deleteItem(SP.lists.raeume, spId); } catch(e) { toast('SP-Fehler: '+e.message); }
}

async function spSaveSchulhaus(sh) {
  if (CONFIG.mode!=='sharepoint') return;
  const data = { Title:sh.name, Ort:sh.ort||'' };
  try {
    if (sh._spId) await SP.updateItem(SP.lists.schulhaeuser, sh._spId, data);
    else { const res=await SP.createItem(SP.lists.schulhaeuser,data); sh._spId=res.ID; sh.id=String(res.ID); }
  } catch(e) { toast('SP-Fehler: '+e.message); }
}

async function spDeleteSchulhaus(spId) {
  if (CONFIG.mode!=='sharepoint'||!spId) return;
  try { await SP.deleteItem(SP.lists.schulhaeuser, spId); } catch(e) { toast('SP-Fehler: '+e.message); }
}

/* ══════════════════════════════════════════════
   HILFSFUNKTIONEN
   ══════════════════════════════════════════════ */
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2); }
function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function toast(msg, dur=2600) { const t=document.getElementById('toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(t._t); t._t=setTimeout(()=>t.classList.remove('show'),dur); }
function loader(v) { document.getElementById('loader').classList.toggle('hidden',!v); }
function todayStr() { const d=new Date(),days=['Sonntag','Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag'],months=['Jan','Feb','Mär','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Dez']; return `${days[d.getDay()]}, ${d.getDate()}. ${months[d.getMonth()]} ${d.getFullYear()}`; }
function todayDow() { const d=new Date().getDay(); return d===0?7:d; } // 1=Mo..5=Fr, So/Sa→ keine Anzeige

// Einfaches Hashing (für lokale Speicherung ausreichend)
function hashPw(pw) {
  let h = 0;
  for (let i=0; i<pw.length; i++) { h = ((h<<5)-h)+pw.charCodeAt(i); h|=0; }
  return 'h'+Math.abs(h).toString(36)+'_'+pw.length;
}

function showModal(id) { document.getElementById(id).classList.remove('hidden'); }
function hideModal(id) { document.getElementById(id).classList.add('hidden'); }

// Schulhäuser des aktuellen Benutzers (für Admin-Bereich: alle zugewiesenen)
function mySchulhaeuser() {
  if (!Session.user) return [];
  if (Session.user.role === 'global-admin') return State.schulhaeuser;
  return State.schulhaeuser.filter(s => Session.user.schulhausIds.includes(s.id));
}

// Aktives Schulhaus für Board-Anzeige. Gibt null zurück wenn "Alle" gewählt.
function activeSchulhaus() {
  if (!Session.user) return null;
  if (isGlobalAdmin()) {
    if (Session.activeSchulhausId === '__all__' || !Session.activeSchulhausId) return null;
    return State.schulhaeuser.find(s=>s.id===Session.activeSchulhausId) || null;
  }
  return myPrimarySchulhaus();
}

// Schulhaus-IDs für aktuelle Ansicht (Board + Admin-Filter)
function activeSchulhausIds() {
  if (!Session.user) return [];
  if (isGlobalAdmin()) {
    const sh = activeSchulhaus();
    return sh ? [sh.id] : State.schulhaeuser.map(s=>s.id);
  }
  return mySchulhaeuser().map(s=>s.id);
}

function myPrimarySchulhaus() {
  const my = mySchulhaeuser();
  return my.length ? my[0] : null;
}

function canAdmin() { return Session.user && (Session.user.role === 'global-admin' || Session.user.role === 'admin-sbe'); }
function isGlobalAdmin() { return Session.user && Session.user.role === 'global-admin'; }

/* ══════════════════════════════════════════════
   LOGIN
   ══════════════════════════════════════════════ */
function initLogin() {
  const btn = document.getElementById('btn-login');
  const err = document.getElementById('login-error');

  function tryLogin() {
    const username = document.getElementById('login-user').value.trim();
    const password = document.getElementById('login-pass').value;
    const user = State.users.find(u => u.username.toLowerCase() === username.toLowerCase());
    if (!user || user.passwordHash !== hashPw(password)) {
      err.classList.add('show'); return;
    }
    err.classList.remove('show');
    Session.user = user;
    saveSession();
    document.getElementById('login-view').style.display = 'none';
    document.getElementById('main-app').classList.add('active');
    updateSessionUI();
    renderBoard();
  }

  btn.addEventListener('click', tryLogin);
  document.getElementById('login-pass').addEventListener('keydown', e => { if(e.key==='Enter') tryLogin(); });
  document.getElementById('login-user').addEventListener('keydown', e => { if(e.key==='Enter') document.getElementById('login-pass').focus(); });
}

function logout() {
  Session.user = null;
  Session.activeSchulhausId = null;
  saveSession();
  document.getElementById('main-app').classList.remove('active');
  document.getElementById('login-view').style.display = 'flex';
  document.getElementById('login-user').value = '';
  document.getElementById('login-pass').value = '';
  showView('view-board');
}

function updateSessionUI() {
  const u = Session.user;
  if (!u) return;
  const roleColor = ROLE_COLORS[u.role] || '#fff';

  document.getElementById('user-badge-name').textContent = u.displayName;
  document.getElementById('role-dot').style.background = roleColor;
  document.getElementById('user-badge-admin').textContent = u.displayName + ' · ' + ROLE_LABELS[u.role];
  document.getElementById('role-dot-admin').style.background = roleColor;

  const adminBtn = document.getElementById('btn-to-admin');
  if (adminBtn) adminBtn.style.display = canAdmin() ? '' : 'none';

  if (isGlobalAdmin()) {
    document.getElementById('schulhaus-selector-wrap').style.display = '';
    document.getElementById('schulhaus-badge-board').style.display = 'none';
    buildSchulhausSelector();
    document.getElementById('schulhaus-selector-admin-wrap').style.display = '';
    document.getElementById('schulhaus-badge-admin').style.display = 'none';
    buildSchulhausSelectorAdmin();
  } else {
    document.getElementById('schulhaus-selector-wrap').style.display = 'none';
    document.getElementById('schulhaus-badge-board').style.display = '';
    const sh = myPrimarySchulhaus();
    document.getElementById('schulhaus-badge-board').textContent = '🏫 ' + (sh ? sh.name : '–');
    Session.activeSchulhausId = sh ? sh.id : null;
    document.getElementById('schulhaus-selector-admin-wrap').style.display = 'none';
    document.getElementById('schulhaus-badge-admin').style.display = '';
    document.getElementById('schulhaus-badge-admin').textContent = '🏫 ' + (sh ? sh.name : '–');
  }
  updateHeaderTitle();
}

function buildSchulhausSelector() {
  const sel = document.getElementById('schulhaus-selector');
  if (!sel) return;
  sel.innerHTML =
    `<option value="__all__">Alle Schulhäuser</option>` +
    State.schulhaeuser.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  // Gespeicherten Wert setzen, Fallback auf ersten Eintrag
  if (Session.activeSchulhausId && (Session.activeSchulhausId === '__all__' || State.schulhaeuser.find(s=>s.id===Session.activeSchulhausId))) {
    sel.value = Session.activeSchulhausId;
  } else {
    sel.value = '__all__';
    Session.activeSchulhausId = '__all__';
  }
  sel.onchange = () => {
    Session.activeSchulhausId = sel.value;
    const adminSel = document.getElementById('schulhaus-selector-admin');
    if (adminSel) adminSel.value = sel.value;
    saveSession();
    updateHeaderTitle();
    renderBoard();
  };
}

function buildSchulhausSelectorAdmin() {
  const sel = document.getElementById('schulhaus-selector-admin');
  if (!sel) return;
  sel.innerHTML =
    `<option value="__all__">Alle Schulhäuser</option>` +
    State.schulhaeuser.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  sel.value = Session.activeSchulhausId || '__all__';
  sel.onchange = () => {
    Session.activeSchulhausId = sel.value;
    const boardSel = document.getElementById('schulhaus-selector');
    if (boardSel) boardSel.value = sel.value;
    saveSession();
    updateHeaderTitle();
    const activeTab = document.querySelector('#admin-tab-bar .tab.active');
    if (activeTab) refreshAdminTab(activeTab.dataset.tab);
  };
}

/* ══════════════════════════════════════════════
   THEME & BRANDING
   ══════════════════════════════════════════════ */
function lighten(hex, amt) {
  if (!hex||hex.length<7) return hex||'#fff';
  return '#'+[parseInt(hex.slice(1,3),16),parseInt(hex.slice(3,5),16),parseInt(hex.slice(5,7),16)].map(v=>Math.min(255,Math.max(0,v+amt)).toString(16).padStart(2,'0')).join('');
}
function hexAlpha(hex, a) {
  if (!hex||hex.length<7) return 'transparent';
  const [r,g,b]=[parseInt(hex.slice(1,3),16),parseInt(hex.slice(3,5),16),parseInt(hex.slice(5,7),16)];
  return `rgba(${r},${g},${b},${a})`;
}
function applyTheme() {
  const t=State.theme, r=document.documentElement;
  const br=parseInt(t.bgBase.slice(1,3)||'14',16),bg=parseInt(t.bgBase.slice(3,5)||'18',16),bb=parseInt(t.bgBase.slice(5,7)||'20',16);
  const dark=(0.299*br+0.587*bg+0.114*bb)<128;
  r.style.setProperty('--clr-gold',t.accentColor);
  r.style.setProperty('--clr-green',t.eatenColor);
  r.style.setProperty('--clr-red',t.pendingColor);
  r.style.setProperty('--clr-amber',t.warnColor);
  r.style.setProperty('--bg-base',t.bgBase);
  r.style.setProperty('--bg-surface',t.bgSurface);
  r.style.setProperty('--bg-elevated',dark?lighten(t.bgBase,20):lighten(t.bgBase,-12));
  r.style.setProperty('--bg-card',dark?hexAlpha(lighten(t.bgBase,12),.92):hexAlpha(lighten(t.bgBase,8),.97));
  r.style.setProperty('--bg-glass',dark?'rgba(255,255,255,0.05)':'rgba(0,0,0,0.04)');
  r.style.setProperty('--clr-text',dark?'#eef2f8':'#141820');
  r.style.setProperty('--clr-text-dim',dark?'#8e9bb5':'#4a5568');
  r.style.setProperty('--clr-text-mut',dark?'#4d5a72':'#a0aec0');
  r.style.setProperty('--clr-border',dark?'rgba(255,255,255,0.07)':'rgba(0,0,0,0.07)');
  r.style.setProperty('--clr-border-b',dark?'rgba(255,255,255,0.12)':'rgba(0,0,0,0.13)');
  r.style.setProperty('--clr-gold-dim',hexAlpha(t.accentColor,.15));
  r.style.setProperty('--clr-green-dim',hexAlpha(t.eatenColor,.13));
  r.style.setProperty('--clr-red-dim',hexAlpha(t.pendingColor,.13));
  r.style.setProperty('--clr-amber-dim',hexAlpha(t.warnColor,.15));
}
function applyBranding() {
  const b=State.branding;
  const subtitle=(b.subtitle||'').trim();
  const bg=b.headerBg||'#141820', txt=b.headerText||'#eef2f8';
  ['brand-icon-board','brand-icon-admin','bp-icon'].forEach(id=>{const el=document.getElementById(id);if(el)el.textContent=b.iconEmoji||'🍽️';});
  // Titel werden via updateHeaderTitle() gesetzt (mit Schulhausname vorangestellt)
  updateHeaderTitle();
  ['brand-title-board','brand-title-admin','bp-title'].forEach(id=>{const el=document.getElementById(id);if(el)el.style.color=txt;});
  const sub=document.getElementById('brand-sub-board');
  if(sub){sub.textContent=subtitle||todayStr();sub.style.color=hexAlpha(txt,.65);}
  const bpSub=document.getElementById('bp-sub');
  if(bpSub){bpSub.textContent=subtitle||'(Datum)';bpSub.style.fontStyle=subtitle?'normal':'italic';}
  [document.getElementById('board-header'),document.querySelector('#view-admin .app-header')].forEach(el=>{if(el){el.style.background=hexAlpha(bg,.97);el.style.borderBottomColor=hexAlpha(txt,.1);}});
  const loginIcon=document.getElementById('login-icon');if(loginIcon)loginIcon.textContent=b.iconEmoji||'🍽️';
  const loginTitle=document.getElementById('login-title');if(loginTitle)loginTitle.textContent=b.title||'Mittagstisch';
  const preview=document.getElementById('branding-preview');if(preview){preview.style.background=hexAlpha(bg,.97);}
  const bpT=document.getElementById('bp-title');if(bpT)bpT.textContent=b.title||'Mittagstisch';
}

function updateHeaderTitle() {
  const b=State.branding;
  const sh = activeSchulhaus();
  const shName = sh ? sh.name : '';
  const titel = b.title||'Mittagstisch';
  const combined = shName ? `${shName} ${titel}` : titel;
  const boardT=document.getElementById('brand-title-board');if(boardT)boardT.textContent=combined;
  const adminT=document.getElementById('brand-title-admin');if(adminT)adminT.textContent=combined;
}

/* ══════════════════════════════════════════════
   VIEWS
   ══════════════════════════════════════════════ */
function showView(id) {
  document.querySelectorAll('.view-panel').forEach(v => v.classList.toggle('active', v.id===id));
}

/* ══════════════════════════════════════════════
   BOARD
   ══════════════════════════════════════════════ */
let boardFilter = 'all';
let activeDayFilter = 0; // 0=heute automatisch
let sortables = [];

function initDayFilter() {
  const today = todayDow();
  document.querySelectorAll('.day-btn').forEach(btn => {
    const d = parseInt(btn.dataset.day);
    if (d === today) btn.classList.add('today');
    btn.addEventListener('click', () => {
      const was = btn.classList.contains('active');
      document.querySelectorAll('.day-btn').forEach(b=>b.classList.remove('active'));
      if (!was) { btn.classList.add('active'); activeDayFilter = d; }
      else activeDayFilter = 0;
      renderBoard();
    });
  });
  // Heute automatisch aktivieren
  const todayBtn = document.querySelector(`.day-btn[data-day="${today}"]`);
  if (todayBtn) { todayBtn.classList.add('active'); activeDayFilter = today; }
}

function kinderFuerBoard() {
  const ids = activeSchulhausIds();
  return State.kinder.filter(k => {
    if (!ids.includes(k.schulhausId)) return false;
    // Wenn Tage hinterlegt und aktiver Tag gesetzt: nur Kinder die HEUTE kommen sollten
    if (activeDayFilter > 0 && (k.tage||[]).length > 0 && !(k.tage||[]).includes(activeDayFilter)) return false;
    return true;
  });
}

// Kinder die heute kommen sollten aber in Abwesend-Spalte sind (raumId='0')
// = diese sind wirklich abwesend (krank, Urlaub etc.)
// Kinder die heute NICHT im Tages-Plan sind → gar nicht anzeigen (bereits in kinderFuerBoard gefiltert)

function renderBoard() {
  const board = document.getElementById('kanban-board');
  sortables.forEach(s=>s.destroy()); sortables=[]; board.innerHTML='';

  const ids = activeSchulhausIds();
  if (!ids.length) {
    board.innerHTML='<div style="padding:40px;color:var(--clr-text-mut);font-size:14px">Kein Schulhaus zugewiesen.</div>';
    return;
  }

  const sichtbareKinder = kinderFuerBoard();

  // Bei "Alle": Schulhäuser als Abschnitte gruppieren
  const schulhausGruppen = isGlobalAdmin() && !activeSchulhaus()
    ? State.schulhaeuser.filter(s=>ids.includes(s.id))
    : [activeSchulhaus() || State.schulhaeuser.find(s=>s.id===ids[0])];

  schulhausGruppen.forEach((sh, gi) => {
    if (!sh) return;
    const shKinder = sichtbareKinder.filter(k=>k.schulhausId===sh.id);
    const myRaeume = State.raeume.filter(r=>r.schulhausId===sh.id);
    const allRooms = [{id:'0', label:'Abwesend', farbe:'#6b7a90'}, ...myRaeume];

    // Schulhaus-Trennlinie bei Alle-Ansicht
    if (schulhausGruppen.length > 1) {
      const sep = document.createElement('div');
      sep.style.cssText='display:flex;align-items:center;gap:10px;padding:0 4px;flex-shrink:0;align-self:center';
      sep.innerHTML=`<div style="writing-mode:vertical-rl;transform:rotate(180deg);font-family:var(--fd);font-size:13px;font-weight:600;color:var(--clr-gold);white-space:nowrap;padding:8px 0">🏫 ${esc(sh.name)}</div>`;
      board.appendChild(sep);
    }

    allRooms.forEach(room => {
      // Abwesend-Spalte: nur Kinder die heute eigentlich da sein sollten (tage enthält activeDayFilter)
      // aber noch in raumId='0' sind
      let kids;
      if (room.id === '0') {
        kids = shKinder.filter(k => (k.raumId||'0') === '0');
        // Wenn Tagesfilter aktiv: nur Kinder die heute laut Stundenplan hier sein sollten
        // (alle anderen sind heute einfach nicht da, nicht abwesend)
        if (activeDayFilter > 0) {
          kids = kids.filter(k => (k.tage||[]).includes(activeDayFilter));
        }
      } else {
        kids = shKinder.filter(k => (k.raumId||'0') === room.id);
      }

      const roomStaff = room.id !== '0'
        ? State.users.filter(u => (u.raumIds||[]).includes(room.id) && (u.schulhausIds||[]).includes(sh.id) && u.role !== 'global-admin')
        : [];

      const col = document.createElement('div');
      col.className = 'kanban-col' + (room.id==='0'?' abwesend-col':'');
      col.dataset.room = room.id; col.dataset.schulhaus = sh.id;

      const accent = document.createElement('div');
      accent.className = 'col-accent';
      accent.style.background = `linear-gradient(90deg,${room.farbe},transparent)`;
      col.appendChild(accent);

      const header = document.createElement('div');
      header.className = 'col-header';
      header.innerHTML = `<div class="col-header-top"><div class="col-name-row"><div class="col-dot" style="background:${room.farbe};box-shadow:0 0 6px ${room.farbe}"></div><span class="col-label">${esc(room.label)}</span></div><span class="col-count">${kids.length}</span></div>${roomStaff.length?`<div class="col-staff">${roomStaff.map(s=>`<div class="staff-chip"><div class="staff-chip-dot" style="background:${room.farbe}"></div>${esc(s.displayName)}</div>`).join('')}</div>`:''}`;
      col.appendChild(header);

      // Scroll-Wrapper
      const wrap = document.createElement('div');
      wrap.className = 'col-body-wrap col-scroll-fade';

      const body = document.createElement('div');
      body.className = 'col-body'; body.dataset.room = room.id; body.dataset.schulhaus = sh.id;
      if (!kids.length) body.innerHTML = '<div class="empty-col">Leer</div>';
      else kids.forEach(k=>body.appendChild(renderCard(k)));
      wrap.appendChild(body);
      col.appendChild(wrap);
      board.appendChild(col);

      sortables.push(Sortable.create(body, {
        group:'children', animation:200, ghostClass:'sortable-ghost', chosenClass:'sortable-chosen',
        delay:40, delayOnTouchOnly:true,
        onAdd(evt) {
          const id=evt.item.dataset.id, newRoom=evt.to.dataset.room;
          const kind=State.kinder.find(k=>k.id===id); if(!kind)return;
          kind.raumId=newRoom; save();
          const r=allRooms.find(r=>r.id===newRoom);
          toast(`${kind.vorname} → ${r?.label||'?'}`);
          setTimeout(renderBoard,0);
        }
      }));
    });

    // Trennlinie zwischen Schulhäusern
    if (gi < schulhausGruppen.length - 1) {
      const div = document.createElement('div');
      div.style.cssText='width:1px;background:var(--clr-border-b);align-self:stretch;flex-shrink:0;margin:0 4px';
      board.appendChild(div);
    }
  });

  updateStats(sichtbareKinder);
  applyBoardFilter(sichtbareKinder);
}


function renderCard(kind) {
  const card = document.createElement('div');
  card.className = 'child-card'; card.dataset.id = kind.id;
  const tage = (kind.tage||[]).map(d=>DAYS[d]).filter(Boolean);
  card.innerHTML = `
    <div class="card-top">
      <div class="child-name">
        ${esc(kind.vorname)} <span class="child-name-last">${esc(kind.nachname)}</span>
        <div class="child-tags">
          ${kind.klasse?`<span class="child-tag">${esc(kind.klasse)}</span>`:''}
          ${kind.lehrperson?`<span class="child-tag">${esc(kind.lehrperson)}</span>`:''}
        </div>
        ${tage.length?`<div class="child-days">${tage.map(d=>`<span class="day-dot">${d}</span>`).join('')}</div>`:''}
      </div>
      ${kind.bemerkungen?`<div class="warn-badge" data-bem="${esc(kind.bemerkungen)}"><div class="warn-icon">⚠️</div></div>`:''}
    </div>`;
  const btn = document.createElement('button');
  btn.className = 'btn-eat ' + (kind.hatGegessen?'has-eaten':'not-eaten');
  btn.innerHTML = kind.hatGegessen ? '✓ Hat gegessen' : '✗ Noch nicht gegessen';
  btn.addEventListener('click', e => { e.stopPropagation(); toggleEaten(kind.id); });
  card.appendChild(btn);

  // Warn-Badge Tooltip (hover + click für Touch)
  if (kind.bemerkungen) {
    const badge = card.querySelector('.warn-badge');
    badge.addEventListener('mouseenter', e => showBemerkTooltip(e, kind.bemerkungen));
    badge.addEventListener('mouseleave', hideBemerkTooltip);
    badge.addEventListener('click', e => { e.stopPropagation(); toggleBemerkTooltip(e, kind.bemerkungen); });
  }
  return card;
}

// Globaler Bemerkungen-Tooltip
let _tooltipPinned = false;
function showBemerkTooltip(e, text) {
  if (_tooltipPinned) return;
  const el = document.getElementById('bemerk-tooltip');
  el.textContent = text;
  positionTooltip(el, e);
  el.style.display = 'block';
  requestAnimationFrame(()=>el.style.opacity='1');
}
function hideBemerkTooltip() {
  if (_tooltipPinned) return;
  const el = document.getElementById('bemerk-tooltip');
  el.style.opacity='0';
  setTimeout(()=>{if(!_tooltipPinned)el.style.display='none';},150);
}
function toggleBemerkTooltip(e, text) {
  const el = document.getElementById('bemerk-tooltip');
  if (_tooltipPinned) { _tooltipPinned=false; el.style.opacity='0'; setTimeout(()=>el.style.display='none',150); return; }
  _tooltipPinned=true;
  el.textContent=text;
  positionTooltip(el, e);
  el.style.display='block';
  requestAnimationFrame(()=>el.style.opacity='1');
}
function positionTooltip(el, e) {
  el.style.top='0'; el.style.left='0'; el.style.display='block';
  const rect = el.getBoundingClientRect();
  let x = e.clientX + 12, y = e.clientY + 12;
  if (x + rect.width > window.innerWidth - 8) x = e.clientX - rect.width - 12;
  if (y + rect.height > window.innerHeight - 8) y = e.clientY - rect.height - 12;
  el.style.left = x + 'px'; el.style.top = y + 'px';
}
document.addEventListener('click', e => {
  if (!e.target.closest('.warn-badge')) { _tooltipPinned=false; const el=document.getElementById('bemerk-tooltip'); if(el){el.style.opacity='0';setTimeout(()=>el.style.display='none',150);} }
});

function toggleEaten(id) {
  const kind=State.kinder.find(k=>k.id===id); if(!kind)return;
  kind.hatGegessen=!kind.hatGegessen; save(); renderBoard();
  toast(kind.hatGegessen?`${kind.vorname} hat gegessen ✓`:`${kind.vorname} zurückgesetzt`);
}

function updateStats(kids) {
  const t=kids.length, e=kids.filter(k=>k.hatGegessen).length;
  document.getElementById('stat-total').textContent=t;
  document.getElementById('stat-eaten').textContent=e;
  document.getElementById('stat-waiting').textContent=t-e;
}

function setBoardFilter(f) {
  boardFilter=f;
  document.querySelectorAll('.stat-pill').forEach(p=>p.classList.toggle('active',p.dataset.filter===f));
  applyBoardFilter(kinderFuerBoard());
}

function applyBoardFilter(kids) {
  document.querySelectorAll('.kanban-col').forEach(col=>{
    if(col.dataset.room==='0'){col.classList.remove('dimmed');col.querySelectorAll('.child-card').forEach(c=>c.style.display='');return;}
    let vis=0;
    col.querySelectorAll('.child-card').forEach(card=>{
      const kind=kids.find(k=>k.id===card.dataset.id);
      const show=!kind?false:boardFilter==='all'||(boardFilter==='eaten'&&kind.hatGegessen)||(boardFilter==='pending'&&!kind.hatGegessen);
      card.style.display=show?'':'none';
      if(show)vis++;
    });
    col.classList.toggle('dimmed',boardFilter!=='all'&&vis===0);
  });
}

function resetDay() {
  if(!confirm('Alle Kinder zurücksetzen (Raum + Status)?'))return;
  kinderFuerBoard().forEach(k=>{
    k.raumId=k.standardRaumId||'0';
    k.hatGegessen=false;
  });
  save(); renderBoard(); toast('Tag zurückgesetzt ✓');
}

function resetStatus() {
  const eaten=kinderFuerBoard().filter(k=>k.hatGegessen);
  if(!eaten.length){toast('Alle bereits auf Ausstehend');return;}
  if(!confirm(`${eaten.length} Kind${eaten.length>1?'er':''} auf Ausstehend zurücksetzen?`))return;
  eaten.forEach(k=>k.hatGegessen=false);
  save(); renderBoard(); renderKinderTable();
  toast(`${eaten.length} Kind${eaten.length>1?'er':''} zurückgesetzt ✓`);
}

/* ══════════════════════════════════════════════
   ADMIN TABS — NACH ROLLE
   ══════════════════════════════════════════════ */
function buildAdminTabs() {
  const bar = document.getElementById('admin-tab-bar');
  bar.innerHTML = '';
  const tabs = [{ id:'kinder', label:'👶 Kinder' }, { id:'raeume', label:'🚪 Räume' }];
  if (isGlobalAdmin()) {
    tabs.push({ id:'schulhaeuser', label:'🏫 Schulhäuser' });
    tabs.push({ id:'benutzer', label:'👤 Benutzer' });
    tabs.push({ id:'design', label:'🎨 Design' });
    tabs.push({ id:'branding', label:'✏️ Header' });
  }
  tabs.forEach((t,i) => {
    const btn = document.createElement('button');
    btn.className = 'tab' + (i===0?' active':'');
    btn.dataset.tab = t.id; btn.textContent = t.label;
    btn.addEventListener('click', () => {
      bar.querySelectorAll('.tab').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('#view-admin .tab-content').forEach(c=>c.classList.toggle('active',c.id==='tab-'+t.id));
      refreshAdminTab(t.id);
    });
    bar.appendChild(btn);
  });
  // Ersten Tab aktivieren
  document.querySelectorAll('#view-admin .tab-content').forEach(c=>c.classList.remove('active'));
  const first = document.getElementById('tab-kinder'); if(first)first.classList.add('active');
  refreshAdminTab('kinder');
}

function refreshAdminTab(id) {
  if(id==='kinder'){buildKinderFilters();renderKinderTable();}
  if(id==='raeume')renderRaeumeListe();
  if(id==='schulhaeuser')renderSchulhausGrid();
  if(id==='benutzer')renderUserListe();
  if(id==='design')syncThemePickers();
  if(id==='branding')syncBrandingInputs();
}

/* ══════════════════════════════════════════════
   KINDER
   ══════════════════════════════════════════════ */
let kindSort={col:'nachname',dir:'asc'}, kindSearch='', kindFilterKlasse='', kindFilterLP='';
let kindPage = 1;
const KIDS_PER_PAGE = 20;

function kinderFuerAdmin() {
  const ids = activeSchulhausIds();
  return State.kinder.filter(k=>ids.includes(k.schulhausId));
}

function buildKinderFilters() {
  const kids=kinderFuerAdmin();
  const klassen=[...new Set(kids.map(k=>k.klasse).filter(Boolean))].sort();
  const lps=[...new Set(kids.map(k=>k.lehrperson).filter(Boolean))].sort();
  const sc=document.getElementById('filter-klasse'),st=document.getElementById('filter-lehrperson');
  const pvc=sc.value,pvt=st.value;
  sc.innerHTML='<option value="">Alle Klassen</option>'+klassen.map(x=>`<option value="${esc(x)}"${x===pvc?' selected':''}>${esc(x)}</option>`).join('');
  st.innerHTML='<option value="">Alle Lehrpersonen</option>'+lps.map(x=>`<option value="${esc(x)}"${x===pvt?' selected':''}>${esc(x)}</option>`).join('');
  document.getElementById('kinder-sub').textContent=`${kids.length} Kinder erfasst`;
}

function filteredKinder() {
  const q=kindSearch.toLowerCase();
  return kinderFuerAdmin().filter(k=>{
    if(q&&![k.vorname,k.nachname,k.klasse,k.lehrperson,k.bemerkungen].some(f=>(f||'').toLowerCase().includes(q)))return false;
    if(kindFilterKlasse&&k.klasse!==kindFilterKlasse)return false;
    if(kindFilterLP&&k.lehrperson!==kindFilterLP)return false;
    return true;
  }).sort((a,b)=>{
    const va=(a[kindSort.col]||'').toLowerCase(),vb=(b[kindSort.col]||'').toLowerCase();
    return kindSort.dir==='asc'?va.localeCompare(vb,'de'):vb.localeCompare(va,'de');
  });
}

let selectedKinder = new Set();

function updateSelectionBar() {
  const bar = document.getElementById('selection-bar');
  const cnt = document.getElementById('sel-count');
  if (!bar || !cnt) return;
  cnt.textContent = selectedKinder.size;
  bar.classList.toggle('visible', selectedKinder.size > 0);
  const cbAll = document.getElementById('cb-all-kinder');
  if (cbAll) {
    const page = filteredKinder().slice((kindPage-1)*KIDS_PER_PAGE, kindPage*KIDS_PER_PAGE);
    cbAll.indeterminate = selectedKinder.size > 0 && !page.every(k => selectedKinder.has(k.id));
    cbAll.checked = page.length > 0 && page.every(k => selectedKinder.has(k.id));
  }
}

function renderKinderTable() {
  const list = filteredKinder();
  const tbody = document.getElementById('kinder-tbody');
  const empty = document.getElementById('kinder-empty');
  tbody.innerHTML = '';

  if (!list.length) { empty.hidden=false; renderKinderPagination(0,0); updateSelectionBar(); return; }
  empty.hidden = true;

  const totalPages = Math.ceil(list.length / KIDS_PER_PAGE);
  if (kindPage > totalPages) kindPage = totalPages;
  if (kindPage < 1) kindPage = 1;
  const start = (kindPage-1)*KIDS_PER_PAGE;
  const paginated = list.slice(start, start+KIDS_PER_PAGE);

  paginated.forEach(kind => {
    const sh = State.schulhaeuser.find(s => s.id===kind.schulhausId);
    const stdRaum = State.raeume.find(r => r.id===kind.standardRaumId);
    const tage = (kind.tage||[]).map(d=>DAYS[d]).filter(Boolean);
    const checked = selectedKinder.has(kind.id);
    const tr = document.createElement('tr');
    if (checked) tr.style.background = '#f0f4ff';
    tr.innerHTML = `
      <td class="cb-col"><input type="checkbox" class="kind-cb" data-id="${kind.id}" ${checked?'checked':''}></td>
      <td><div class="td-name">${esc(kind.vorname)} ${esc(kind.nachname)}</div></td>
      <td>${kind.klasse?`<span class="badge badge-blue">${esc(kind.klasse)}</span>`:'-'}</td>
      <td>${sh?`<span class="badge badge-muted">🏫 ${esc(sh.name)}</span>`:'-'}</td>
      <td>${stdRaum?`<span class="badge badge-muted"><span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${stdRaum.farbe};margin-right:4px"></span>${esc(stdRaum.label)}</span>`:'<span style="color:#9aa0a6;font-size:12px">–</span>'}</td>
      <td>${tage.length?tage.map(d=>`<span class="badge badge-gold">${d}</span>`).join(' '):'-'}</td>
      <td><span class="badge ${kind.hatGegessen?'badge-green':'badge-red'}">${kind.hatGegessen?'✓ Gegessen':'✗ Ausstehend'}</span></td>
      <td class="td-actions"><button class="btn-icon edit" data-id="${kind.id}">✏️</button><button class="btn-icon del" data-id="${kind.id}">🗑️</button></td>`;
    tr.querySelector('.kind-cb').addEventListener('change', e => {
      if (e.target.checked) selectedKinder.add(kind.id);
      else selectedKinder.delete(kind.id);
      tr.style.background = e.target.checked ? '#f0f4ff' : '';
      updateSelectionBar();
    });
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('.btn-icon.edit').forEach(b => b.addEventListener('click', () => openKindModal(b.dataset.id)));
  tbody.querySelectorAll('.btn-icon.del').forEach(b => b.addEventListener('click', () => deleteKind(b.dataset.id)));
  renderKinderPagination(list.length, totalPages);
  updateSelectionBar();
}

function renderKinderPagination(total, totalPages) {
  const el = document.getElementById('kinder-pagination');
  if (!el) return;
  if (total <= KIDS_PER_PAGE) { el.innerHTML = ''; return; }
  const start = (kindPage-1)*KIDS_PER_PAGE+1;
  const end   = Math.min(kindPage*KIDS_PER_PAGE, total);
  let btns = '';
  for (let i=1; i<=totalPages; i++) {
    if (totalPages>7 && i>2 && i<totalPages-1 && Math.abs(i-kindPage)>1) {
      if (i===3 || i===totalPages-2) btns += '<span style="color:#9aa0a6;padding:0 4px">…</span>';
      continue;
    }
    btns += `<button class="pag-btn${i===kindPage?' active':''}" data-p="${i}">${i}</button>`;
  }
  el.innerHTML = `
    <span class="pag-info">${start}–${end} von ${total} Kindern</span>
    <div class="pag-controls">
      <button class="pag-btn" id="pag-prev" ${kindPage===1?'disabled':''}>‹ Zurück</button>
      ${btns}
      <button class="pag-btn" id="pag-next" ${kindPage===totalPages?'disabled':''}>Weiter ›</button>
    </div>`;
  el.querySelectorAll('.pag-btn[data-p]').forEach(b =>
    b.addEventListener('click', () => { kindPage = parseInt(b.dataset.p); renderKinderTable(); })
  );
  el.querySelector('#pag-prev')?.addEventListener('click', () => {
    if (kindPage > 1) { kindPage--; renderKinderTable(); }
  });
  el.querySelector('#pag-next')?.addEventListener('click', () => {
    if (kindPage < totalPages) { kindPage++; renderKinderTable(); }
  });
}

function openKindModal(editId=null) {
  document.getElementById('modal-kind-title').textContent=editId?'Kind bearbeiten':'Kind hinzufügen';
  document.getElementById('kind-edit-id').value=editId||'';
  const verfuegbareShIds = isGlobalAdmin() ? State.schulhaeuser : mySchulhaeuser();
  const sel=document.getElementById('kind-schulhaus');
  sel.innerHTML=verfuegbareShIds.map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join('');

  if(editId){
    const k=State.kinder.find(x=>x.id===editId);
    document.getElementById('kind-vorname').value=k.vorname||'';
    document.getElementById('kind-nachname').value=k.nachname||'';
    document.getElementById('kind-klasse').value=k.klasse||'';
    document.getElementById('kind-lehrperson').value=k.lehrperson||'';
    document.getElementById('kind-bemerkung').value=k.bemerkungen||'';
    sel.value=k.schulhausId||'';
    document.querySelectorAll('#kind-days-grid input[type=checkbox]').forEach(cb=>{
      cb.checked=(k.tage||[]).includes(parseInt(cb.dataset.day));
    });
    buildKindRaumSel(sel.value, k.standardRaumId||'0');
  } else {
    ['kind-vorname','kind-nachname','kind-klasse','kind-lehrperson','kind-bemerkung'].forEach(id=>document.getElementById(id).value='');
    document.querySelectorAll('#kind-days-grid input[type=checkbox]').forEach(cb=>cb.checked=false);
    const defSh = isGlobalAdmin() ? activeSchulhaus() : myPrimarySchulhaus();
    if(defSh) sel.value=defSh.id;
    buildKindRaumSel(sel.value, '0');
  }

  // Standardraum-Liste aktualisieren wenn Schulhaus wechselt
  sel.onchange = () => buildKindRaumSel(sel.value, '0');

  showModal('modal-kind');
  setTimeout(()=>document.getElementById('kind-vorname').focus(),80);
}

function buildKindRaumSel(schulhausId, selectedRaumId='0') {
  const raumSel=document.getElementById('kind-standardraum');
  const raeume=State.raeume.filter(r=>r.schulhausId===schulhausId);
  raumSel.innerHTML='<option value="0">— Alle Kinder (kein Standardraum)</option>'
    + raeume.map(r=>`<option value="${r.id}">${esc(r.label)}</option>`).join('');
  raumSel.value=selectedRaumId||'0';
}

async function saveKind() {
  const vorname=document.getElementById('kind-vorname').value.trim();
  const nachname=document.getElementById('kind-nachname').value.trim();
  const klasse=document.getElementById('kind-klasse').value.trim();
  const lehrperson=document.getElementById('kind-lehrperson').value.trim();
  const bemerkungen=document.getElementById('kind-bemerkung').value.trim();
  const schulhausId=document.getElementById('kind-schulhaus').value;
  const standardRaumId=document.getElementById('kind-standardraum').value||'0';
  const tage=[...document.querySelectorAll('#kind-days-grid input[type=checkbox]:checked')].map(cb=>parseInt(cb.dataset.day));
  const editId=document.getElementById('kind-edit-id').value;
  if(!vorname||!nachname){alert('Bitte Vor- und Nachname eingeben.');return;}
  if(editId){
    const k=State.kinder.find(x=>x.id===editId);
    Object.assign(k,{vorname,nachname,klasse,lehrperson,bemerkungen,schulhausId,standardRaumId,tage});
    if(CONFIG.mode==='sharepoint') await spSaveKind(k); else save();
    toast('Gespeichert ✓');
  } else {
    const k={id:uid(),vorname,nachname,klasse,lehrperson,bemerkungen,
      schulhausId,standardRaumId,raumId:standardRaumId,hatGegessen:false,tage};
    State.kinder.push(k);
    if(CONFIG.mode==='sharepoint') await spSaveKind(k); else save();
    toast(`${vorname} ${nachname} hinzugefügt ✓`);
  }
  hideModal('modal-kind'); buildKinderFilters(); renderKinderTable(); renderBoard();
}

async function deleteKind(id) {
  const k=State.kinder.find(x=>x.id===id);if(!k)return;
  if(!confirm(`${k.vorname} ${k.nachname} wirklich löschen?`))return;
  if(CONFIG.mode==='sharepoint') await spDeleteKind(k._spId); else save();
  State.kinder=State.kinder.filter(x=>x.id!==id);
  if(CONFIG.mode!=='sharepoint') save();
  buildKinderFilters(); renderKinderTable(); renderBoard(); toast('Kind gelöscht');
}

/* ══════════════════════════════════════════════
   RÄUME
   ══════════════════════════════════════════════ */
function raeumeFuerAdmin() {
  const ids = activeSchulhausIds();
  return State.raeume.filter(r=>ids.includes(r.schulhausId));
}

function renderRaeumeListe() {
  const list=document.getElementById('raeume-list'); list.innerHTML='';
  const raeume=raeumeFuerAdmin();
  if(!raeume.length){list.innerHTML='<p style="color:var(--clr-text-mut);font-size:13px">Noch keine Räume.</p>';return;}
  raeume.forEach(r=>{
    const count=State.kinder.filter(k=>k.raumId===r.id).length;
    const sh=State.schulhaeuser.find(s=>s.id===r.schulhausId);
    const item=document.createElement('div');item.className='list-item';
    item.innerHTML=`<div class="item-color-dot" style="background:${r.farbe}"></div><span class="item-label">${esc(r.label)}</span><span class="item-sub">${sh?esc(sh.name):''} · ${count} Kinder</span><div class="item-actions"><button class="btn-icon edit" data-id="${r.id}">✏️</button><button class="btn-icon del" data-id="${r.id}">🗑️</button></div>`;
    list.appendChild(item);
  });
  list.querySelectorAll('.btn-icon.edit').forEach(b=>b.addEventListener('click',()=>openRaumModal(b.dataset.id)));
  list.querySelectorAll('.btn-icon.del').forEach(b=>b.addEventListener('click',()=>deleteRaum(b.dataset.id)));
}

function openRaumModal(editId=null) {
  document.getElementById('modal-raum-title').textContent=editId?'Raum bearbeiten':'Raum hinzufügen';
  document.getElementById('raum-edit-id').value=editId||'';
  const lbl=document.getElementById('raum-label'),col=document.getElementById('raum-color');
  const shSel=document.getElementById('raum-schulhaus');

  // Schulhaus-Selektor: nur Global-Admin kann wählen, SBE fix
  if(isGlobalAdmin()){
    shSel.innerHTML=State.schulhaeuser.map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join('');
    shSel.parentElement.style.display='';
    // Bei "Alle": erstes Schulhaus vorwählen; sonst aktives
    const defSh = (Session.activeSchulhausId && Session.activeSchulhausId !== '__all__')
      ? Session.activeSchulhausId
      : State.schulhaeuser[0]?.id || '';
    shSel.value = defSh;
  } else {
    const sh=myPrimarySchulhaus();
    shSel.innerHTML=sh?`<option value="${sh.id}">${esc(sh.name)}</option>`:'';
    shSel.parentElement.style.display='none';
  }

  if(editId){
    const r=State.raeume.find(x=>x.id===editId);
    lbl.value=r.label; col.value=r.farbe;
    shSel.value=r.schulhausId||shSel.value;
  } else {
    lbl.value=''; col.value=COLOR_PRESETS[State.raeume.length%COLOR_PRESETS.length];
  }
  const pre=document.getElementById('raum-color-presets');pre.innerHTML='';
  COLOR_PRESETS.forEach(hex=>{const d=document.createElement('div');d.className='color-preset'+(hex===col.value?' active':'');d.style.background=hex;d.title=hex;d.onclick=()=>{col.value=hex;pre.querySelectorAll('.color-preset').forEach(p=>p.classList.toggle('active',p.title===hex));};pre.appendChild(d);});
  showModal('modal-raum');setTimeout(()=>lbl.focus(),80);
}

async function saveRaum() {
  const label=document.getElementById('raum-label').value.trim();
  const farbe=document.getElementById('raum-color').value;
  const editId=document.getElementById('raum-edit-id').value;
  if(!label){alert('Bitte Bezeichnung eingeben.');return;}
  const schulhausId = document.getElementById('raum-schulhaus').value ||
    (isGlobalAdmin()
      ? (activeSchulhaus()?.id || State.schulhaeuser[0]?.id || null)
      : (mySchulhaeuser()[0]?.id || null));
  if(editId){
    const r=State.raeume.find(x=>x.id===editId);
    r.label=label; r.farbe=farbe; r.schulhausId=schulhausId;
    if(CONFIG.mode==='sharepoint') await spSaveRaum(r); else save();
    toast('Raum aktualisiert ✓');
  } else {
    const r={id:uid(),label,farbe,schulhausId};
    State.raeume.push(r);
    if(CONFIG.mode==='sharepoint') await spSaveRaum(r); else save();
    toast(`${label} hinzugefügt ✓`);
  }
  hideModal('modal-raum');renderRaeumeListe();renderBoard();
}

async function deleteRaum(id) {
  const r=State.raeume.find(x=>x.id===id);if(!r)return;
  if(!confirm(`«${r.label}» löschen?`))return;
  // Kinder die diesen Raum als aktuellen Raum haben → Standardraum
  State.kinder.filter(k=>k.raumId===id).forEach(k=>k.raumId=k.standardRaumId===id?'0':k.raumId);
  // Kinder die diesen Raum als Standardraum haben → kein Standardraum
  State.kinder.filter(k=>k.standardRaumId===id).forEach(k=>{k.standardRaumId='0';k.raumId='0';});
  // Benutzer-Raum-Zuweisung bereinigen
  State.users.forEach(u=>{u.raumIds=(u.raumIds||[]).filter(x=>x!==id);});
  if(CONFIG.mode==='sharepoint') await spDeleteRaum(r._spId); else save();
  State.raeume=State.raeume.filter(x=>x.id!==id);
  if(CONFIG.mode!=='sharepoint') save();
  renderRaeumeListe();renderBoard();toast(`${r.label} gelöscht`);
}

/* ══════════════════════════════════════════════
   MITARBEITENDE
   ══════════════════════════════════════════════ */
function mitarbFuerAdmin() {
  if (!State.mitarbeitende) return [];
  const ids = activeSchulhausIds();
  return State.mitarbeitende.filter(m => {
    const mIds = m.schulhausIds || (m.schulhausId ? [m.schulhausId] : []);
    return mIds.some(id => ids.includes(id));
  });
}

function renderMitarbListe() {
  const list=document.getElementById('mitarb-list');list.innerHTML='';
  const mitarb=mitarbFuerAdmin();
  if(!mitarb.length){list.innerHTML='<p style="color:var(--clr-text-mut);font-size:13px">Noch keine Mitarbeitenden.</p>';return;}
  mitarb.forEach(m=>{
    const rooms=(m.raumIds||[]).map(id=>State.raeume.find(r=>r.id===id)).filter(Boolean);
    const shIds=m.schulhausIds||(m.schulhausId?[m.schulhausId]:[]);
    const shNames=shIds.map(id=>State.schulhaeuser.find(s=>s.id===id)?.name).filter(Boolean);
    const item=document.createElement('div');item.className='list-item';
    item.innerHTML=`
      <div class="user-avatar" style="background:var(--clr-gold-dim);color:var(--clr-gold)">${esc(m.name.charAt(0).toUpperCase())}</div>
      <div style="flex:1;min-width:0">
        <div class="item-label">${esc(m.name)}${m.rolle?` <span style="font-size:12px;font-weight:400;color:var(--clr-text-dim)">· ${esc(m.rolle)}</span>`:''}</div>
        <div style="margin-top:4px;display:flex;gap:4px;flex-wrap:wrap">
          ${shNames.map(n=>`<span class="badge badge-gold">🏫 ${esc(n)}</span>`).join('')}
        </div>
      </div>
      <div class="item-badges">
        ${rooms.length?rooms.map(r=>`<span class="badge badge-muted"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${r.farbe};margin-right:4px"></span>${esc(r.label)}</span>`).join(''):'<span style="color:var(--clr-text-mut);font-size:12px">Kein Raum</span>'}
      </div>
      <div class="item-actions">
        <button class="btn-icon edit" data-id="${m.id}">✏️</button>
        <button class="btn-icon del" data-id="${m.id}">🗑️</button>
      </div>`;
    list.appendChild(item);
  });
  list.querySelectorAll('.btn-icon.edit').forEach(b=>b.addEventListener('click',()=>openMitarbModal(b.dataset.id)));
  list.querySelectorAll('.btn-icon.del').forEach(b=>b.addEventListener('click',()=>deleteMitarb(b.dataset.id)));
}

function openMitarbModal(editId=null) {
  document.getElementById('modal-mitarb-title').textContent=editId?'Person bearbeiten':'Person hinzufügen';
  document.getElementById('mitarb-edit-id').value=editId||'';
  let currRooms=[], currShIds=[];
  if(editId){
    const m=State.mitarbeitende.find(x=>x.id===editId);
    document.getElementById('mitarb-name').value=m.name;
    document.getElementById('mitarb-rolle').value=m.rolle||'';
    currRooms=m.raumIds||[];
    currShIds=m.schulhausIds||(m.schulhausId?[m.schulhausId]:[]);
  } else {
    document.getElementById('mitarb-name').value='';
    document.getElementById('mitarb-rolle').value='';
    // Standardmässig aktives Schulhaus vorwählen
    const sh=activeSchulhaus()||myPrimarySchulhaus();
    if(sh) currShIds=[sh.id];
  }

  // Schulhaus-Checkboxen (nur Global-Admin sieht alle, SBE nur sein eigenes)
  const shChecks=document.getElementById('mitarb-schulhaus-checks');
  shChecks.innerHTML='';
  const verfuegbareShIds = isGlobalAdmin() ? State.schulhaeuser : mySchulhaeuser();
  verfuegbareShIds.forEach(s=>{
    const lbl=document.createElement('label');lbl.className='check-label';
    lbl.innerHTML=`<input type="checkbox" class="mitarb-sh-check" value="${s.id}"${currShIds.includes(s.id)?' checked':''}/><span class="check-name">🏫 ${esc(s.name)}</span>`;
    shChecks.appendChild(lbl);
    lbl.querySelector('input').addEventListener('change',()=>buildMitarbRaumChecks(currRooms));
  });

  buildMitarbRaumChecks(currRooms);
  showModal('modal-mitarb');
  setTimeout(()=>document.getElementById('mitarb-name').focus(),80);
}

function buildMitarbRaumChecks(currRooms=[]) {
  const checks=document.getElementById('mitarb-raum-checks');checks.innerHTML='';
  const selShIds=[...document.querySelectorAll('.mitarb-sh-check:checked')].map(i=>i.value);
  const raeume=State.raeume.filter(r=>selShIds.includes(r.schulhausId));
  if(!raeume.length){checks.innerHTML='<p style="color:var(--clr-text-mut);font-size:12px">Zuerst Schulhaus wählen / Räume erstellen.</p>';return;}
  raeume.forEach(r=>{
    const sh=State.schulhaeuser.find(s=>s.id===r.schulhausId);
    const lbl=document.createElement('label');lbl.className='check-label';
    lbl.innerHTML=`<input type="checkbox" value="${r.id}"${currRooms.includes(r.id)?' checked':''}/><div class="check-dot" style="background:${r.farbe}"></div><span class="check-name">${esc(r.label)}</span>${sh?`<span style="font-size:11px;color:var(--clr-text-mut);margin-left:4px">· ${esc(sh.name)}</span>`:''}`;
    checks.appendChild(lbl);
  });
}

function saveMitarb() {
  const name=document.getElementById('mitarb-name').value.trim();
  const rolle=document.getElementById('mitarb-rolle').value.trim();
  const editId=document.getElementById('mitarb-edit-id').value;
  const raumIds=[...document.querySelectorAll('#mitarb-raum-checks input:checked')].map(i=>i.value);
  const schulhausIds=[...document.querySelectorAll('.mitarb-sh-check:checked')].map(i=>i.value);
  if(!name){alert('Bitte Name eingeben.');return;}
  if(editId){
    const m=State.mitarbeitende.find(x=>x.id===editId);
    Object.assign(m,{name,rolle,raumIds,schulhausIds});
    toast('Gespeichert ✓');
  } else {
    State.mitarbeitende.push({id:uid(),name,rolle,schulhausIds,raumIds});
    toast(`${name} hinzugefügt ✓`);
  }
  save();hideModal('modal-mitarb');renderMitarbListe();renderBoard();
}

function deleteMitarb(id) {
  const m=State.mitarbeitende.find(x=>x.id===id);if(!m)return;
  if(!confirm(`${m.name} wirklich löschen?`))return;
  State.mitarbeitende=State.mitarbeitende.filter(x=>x.id!==id);
  save();renderMitarbListe();renderBoard();toast('Gelöscht');
}

/* ══════════════════════════════════════════════
   SCHULHÄUSER (nur Global-Admin)
   ══════════════════════════════════════════════ */
function renderSchulhausGrid() {
  const grid=document.getElementById('schulhaus-grid');grid.innerHTML='';
  if(!State.schulhaeuser.length){grid.innerHTML='<p style="color:var(--clr-text-mut);font-size:13px">Noch keine Schulhäuser.</p>';return;}
  State.schulhaeuser.forEach(sh=>{
    const kinderCount=State.kinder.filter(k=>k.schulhausId===sh.id).length;
    const raumCount=State.raeume.filter(r=>r.schulhausId===sh.id).length;
    const userCount=State.users.filter(u=>(u.schulhausIds||[]).includes(sh.id)).length;
    const card=document.createElement('div');card.className='schulhaus-card';
    card.innerHTML=`<div class="schulhaus-card-name">🏫 ${esc(sh.name)}</div>${sh.ort?`<div style="font-size:12px;color:var(--clr-text-dim)">${esc(sh.ort)}</div>`:''}<div class="schulhaus-card-stats"><span class="badge badge-blue">${kinderCount} Kinder</span><span class="badge badge-muted">${raumCount} Räume</span><span class="badge badge-muted">${userCount} Benutzer</span></div><div class="schulhaus-card-actions"><button class="btn-icon edit" data-id="${sh.id}">✏️</button><button class="btn-icon del" data-id="${sh.id}">🗑️</button></div>`;
    grid.appendChild(card);
  });
  grid.querySelectorAll('.btn-icon.edit').forEach(b=>b.addEventListener('click',()=>openSchulhausModal(b.dataset.id)));
  grid.querySelectorAll('.btn-icon.del').forEach(b=>b.addEventListener('click',()=>deleteSchulhaus(b.dataset.id)));
}

function openSchulhausModal(editId=null) {
  document.getElementById('modal-schulhaus-title').textContent=editId?'Schulhaus bearbeiten':'Schulhaus hinzufügen';
  document.getElementById('schulhaus-edit-id').value=editId||'';
  if(editId){const s=State.schulhaeuser.find(x=>x.id===editId);document.getElementById('schulhaus-name').value=s.name;document.getElementById('schulhaus-ort').value=s.ort||'';}
  else{document.getElementById('schulhaus-name').value='';document.getElementById('schulhaus-ort').value='';}
  showModal('modal-schulhaus');setTimeout(()=>document.getElementById('schulhaus-name').focus(),80);
}

async function saveSchulhaus() {
  const name=document.getElementById('schulhaus-name').value.trim();
  const ort=document.getElementById('schulhaus-ort').value.trim();
  const editId=document.getElementById('schulhaus-edit-id').value;
  if(!name){alert('Bitte Namen eingeben.');return;}
  if(editId){
    const s=State.schulhaeuser.find(x=>x.id===editId);s.name=name;s.ort=ort;
    if(CONFIG.mode==='sharepoint') await spSaveSchulhaus(s); else save();
    toast('Schulhaus aktualisiert ✓');
  } else {
    const s={id:uid(),name,ort};
    State.schulhaeuser.push(s);
    if(CONFIG.mode==='sharepoint') await spSaveSchulhaus(s); else save();
    toast(`${name} hinzugefügt ✓`);
  }
  hideModal('modal-schulhaus');renderSchulhausGrid();
}

async function deleteSchulhaus(id) {
  const s=State.schulhaeuser.find(x=>x.id===id);if(!s)return;
  const n=State.kinder.filter(k=>k.schulhausId===id).length;
  if(!confirm(`«${s.name}» löschen?${n?` ${n} Kinder werden ebenfalls gelöscht.`:''}`))return;
  if(CONFIG.mode==='sharepoint') await spDeleteSchulhaus(s._spId);
  State.schulhaeuser=State.schulhaeuser.filter(x=>x.id!==id);
  State.kinder=State.kinder.filter(k=>k.schulhausId!==id);
  State.raeume=State.raeume.filter(r=>r.schulhausId!==id);
  State.mitarbeitende=State.mitarbeitende.filter(m=>m.schulhausId!==id);
  if(CONFIG.mode!=='sharepoint') save();
  renderSchulhausGrid();renderBoard();toast(`${s.name} gelöscht`);
}

/* ══════════════════════════════════════════════
   BENUTZER (nur Global-Admin)
   ══════════════════════════════════════════════ */
function renderUserListe() {
  const list=document.getElementById('user-list');list.innerHTML='';
  State.users.forEach(u=>{
    const shNames=u.role==='global-admin'?['Alle Schulhäuser']:(u.schulhausIds||[]).map(id=>State.schulhaeuser.find(s=>s.id===id)?.name).filter(Boolean);
    const rooms=(u.raumIds||[]).map(id=>State.raeume.find(r=>r.id===id)).filter(Boolean);
    const roleColor=ROLE_COLORS[u.role]||'#fff';
    const item=document.createElement('div');item.className='list-item';item.style.flexWrap='wrap';
    item.innerHTML=`
      <div class="user-avatar" style="background:${hexAlpha(roleColor,.15)};color:${roleColor}">${esc(u.displayName.charAt(0).toUpperCase())}</div>
      <div style="flex:1;min-width:180px">
        <div class="item-label">${esc(u.displayName)} <span style="font-size:12px;font-weight:400;color:var(--clr-text-dim)">@${esc(u.username)}</span></div>
        <div style="margin-top:5px;display:flex;gap:5px;flex-wrap:wrap;align-items:center">
          <span class="badge" style="background:${hexAlpha(roleColor,.12)};border-color:${hexAlpha(roleColor,.3)};color:${roleColor}">${ROLE_LABELS[u.role]}</span>
          ${shNames.map(n=>`<span class="badge badge-muted">🏫 ${esc(n)}</span>`).join('')}
        </div>
        ${rooms.length?`<div style="margin-top:5px;display:flex;gap:4px;flex-wrap:wrap">${rooms.map(r=>`<span class="badge badge-muted"><span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${r.farbe};margin-right:3px"></span>${esc(r.label)}</span>`).join('')}</div>`:''}
      </div>
      <div class="item-actions">
        <button class="btn-icon edit" data-id="${u.id}">✏️</button>
        ${u.role!=='global-admin'||State.users.filter(x=>x.role==='global-admin').length>1?`<button class="btn-icon del" data-id="${u.id}">🗑️</button>`:''}
      </div>`;
    list.appendChild(item);
  });
  list.querySelectorAll('.btn-icon.edit').forEach(b=>b.addEventListener('click',()=>openUserModal(b.dataset.id)));
  list.querySelectorAll('.btn-icon.del').forEach(b=>b.addEventListener('click',()=>deleteUser(b.dataset.id)));
}

function openUserModal(editId=null) {
  document.getElementById('modal-user-title').textContent=editId?'Benutzer bearbeiten':'Benutzer hinzufügen';
  document.getElementById('user-edit-id').value=editId||'';
  document.getElementById('pw-hint').style.display=editId?'':'none';
  if(editId){
    const u=State.users.find(x=>x.id===editId);
    document.getElementById('user-username').value=u.username;
    document.getElementById('user-display').value=u.displayName;
    document.getElementById('user-password').value='';
    document.getElementById('user-role').value=u.role;
  } else {
    ['user-username','user-display','user-password'].forEach(id=>document.getElementById(id).value='');
    document.getElementById('user-role').value='team';
  }
  buildUserSchulhausChecks(editId);
  document.getElementById('user-role').onchange=()=>buildUserSchulhausChecks(editId);
  showModal('modal-user');
  setTimeout(()=>document.getElementById('user-username').focus(),80);
}

function buildUserSchulhausChecks(editId) {
  const role=document.getElementById('user-role').value;
  const group=document.getElementById('user-schulhaus-group');
  group.style.display=role==='global-admin'?'none':'';
  const checks=document.getElementById('user-schulhaus-checks');checks.innerHTML='';
  const u=editId?State.users.find(x=>x.id===editId):null;
  const currShIds=u?.schulhausIds||[];
  const currRaumIds=u?.raumIds||[];

  State.schulhaeuser.forEach(s=>{
    const lbl=document.createElement('label');lbl.className='check-label';
    lbl.innerHTML=`<input type="checkbox" class="user-sh-check" value="${s.id}"${currShIds.includes(s.id)?' checked':''}/><span class="check-name">🏫 ${esc(s.name)}</span>`;
    checks.appendChild(lbl);
    lbl.querySelector('input').addEventListener('change',()=>buildUserRaumChecks(currRaumIds));
  });
  buildUserRaumChecks(currRaumIds);
}

function buildUserRaumChecks(currRaumIds=[]) {
  const raumGroup=document.getElementById('user-raum-group');
  const checks=document.getElementById('user-raum-checks');checks.innerHTML='';
  const selShIds=[...document.querySelectorAll('.user-sh-check:checked')].map(i=>i.value);
  const raeume=State.raeume.filter(r=>selShIds.includes(r.schulhausId));
  if(!raeume.length){
    raumGroup.style.display='none';return;
  }
  raumGroup.style.display='';
  raeume.forEach(r=>{
    const sh=State.schulhaeuser.find(s=>s.id===r.schulhausId);
    const lbl=document.createElement('label');lbl.className='check-label';
    lbl.innerHTML=`<input type="checkbox" value="${r.id}"${currRaumIds.includes(r.id)?' checked':''}/><div class="check-dot" style="background:${r.farbe}"></div><span class="check-name">${esc(r.label)}</span>${sh?`<span style="font-size:11px;color:var(--clr-text-mut);margin-left:4px">· ${esc(sh.name)}</span>`:''}`;
    checks.appendChild(lbl);
  });
}

function saveUser() {
  const username=document.getElementById('user-username').value.trim();
  const displayName=document.getElementById('user-display').value.trim();
  const password=document.getElementById('user-password').value;
  const role=document.getElementById('user-role').value;
  const editId=document.getElementById('user-edit-id').value;
  const schulhausIds=role==='global-admin'?[]:[...document.querySelectorAll('.user-sh-check:checked')].map(i=>i.value);
  const raumIds=role==='global-admin'?[]:[...document.querySelectorAll('#user-raum-checks input:checked')].map(i=>i.value);
  if(!username||!displayName){alert('Bitte Benutzername und Anzeigename eingeben.');return;}
  if(!editId&&!password){alert('Bitte Passwort eingeben.');return;}
  const existing=State.users.find(u=>u.username.toLowerCase()===username.toLowerCase()&&u.id!==editId);
  if(existing){alert('Benutzername bereits vergeben.');return;}
  if(editId){
    const u=State.users.find(x=>x.id===editId);
    u.username=username;u.displayName=displayName;u.role=role;u.schulhausIds=schulhausIds;u.raumIds=raumIds;
    if(password)u.passwordHash=hashPw(password);
    toast('Gespeichert ✓');
  } else {
    State.users.push({id:uid(),username,displayName,passwordHash:hashPw(password),role,schulhausIds,raumIds});
    toast(`${displayName} hinzugefügt ✓`);
  }
  spSave('users',State.users);hideModal('modal-user');renderUserListe();renderBoard();
}

function deleteUser(id) {
  const u=State.users.find(x=>x.id===id);if(!u)return;
  if(u.id===Session.user?.id){alert('Du kannst dich nicht selbst löschen.');return;}
  if(!confirm(`${u.displayName} wirklich löschen?`))return;
  State.users=State.users.filter(x=>x.id!==id);
  spSave('users',State.users);renderUserListe();toast('Benutzer gelöscht');
}

/* ══════════════════════════════════════════════
   EXCEL-IMPORT
   ══════════════════════════════════════════════ */
let pendingImport=[];
function normalizeHeader(str=''){
  return String(str)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g,'')
    .replace(/[^a-z0-9]/g,'');
}
function fc(row,...cands){
  const keys=Object.keys(row);
  const candsNorm=cands.map(c=>normalizeHeader(c));
  for(const key of keys){
    const keyNorm=normalizeHeader(key);
    if(candsNorm.includes(keyNorm)){
      const value=row[key];
      return String(value===undefined||value===null?'':value).trim();
    }
  }
  return '';
}
function fcBool(row,...cands){const v=fc(row,...cands).toLowerCase();return v==='1'||v==='ja'||v==='x'||v==='true'||v==='yes';}

function initUpload() {
  const zone=document.getElementById('drop-zone'),inp=document.getElementById('file-input');
  zone.addEventListener('click',()=>inp.click());
  zone.addEventListener('dragover',e=>{e.preventDefault();zone.classList.add('drag-active');});
  zone.addEventListener('dragleave',()=>zone.classList.remove('drag-active'));
  zone.addEventListener('drop',e=>{e.preventDefault();zone.classList.remove('drag-active');if(e.dataTransfer.files[0])processFile(e.dataTransfer.files[0]);});
  inp.addEventListener('change',()=>{if(inp.files[0])processFile(inp.files[0]);});
  document.getElementById('btn-clear-upload').addEventListener('click',clearUpload);
  document.getElementById('btn-confirm-import').addEventListener('click',confirmImport);
  document.getElementById('btn-download-tpl').addEventListener('click',downloadTemplate);
}

function downloadTemplate() {
  const wb=XLSX.utils.book_new();
  const ws=XLSX.utils.aoa_to_sheet([
    ['Schulhaus','Vorname','Nachname','Klasse','Lehrperson','Standardraum','Bemerkungen','Mo','Di','Mi','Do','Fr'],
    ['Moosmatt','Anna','Müller','3a','Frau Berger','Zimmer 1','Laktoseintoleranz',1,0,1,0,1],
    ['Moosmatt','Lukas','Meier','2b','Herr Schmidt','Zimmer 2','',1,1,1,1,0],
  ]);
  ws['!cols']=[{wch:14},{wch:12},{wch:14},{wch:8},{wch:18},{wch:14},{wch:24},{wch:5},{wch:5},{wch:5},{wch:5},{wch:5}];
  XLSX.utils.book_append_sheet(wb,ws,'Kinder');
  XLSX.writeFile(wb,'mittagstisch-vorlage.xlsx');
}

function processFile(file) {
  const reader=new FileReader();
  reader.onload=e=>{
    try{
      const wb=XLSX.read(e.target.result,{type:'binary'});
      const ws=wb.Sheets[wb.SheetNames[0]];

      // Header-Zeile automatisch erkennen: suche Zeile mit Schlüsselspalten
      const range=XLSX.utils.decode_range(ws['!ref']||'A1');
      let headerRow=0; // 0-basiert
      const headerTokens=['vorname','firstname','nachname','lastname','schulhaus','school'];
      for(let r=range.s.r; r<=Math.min(range.s.r+5, range.e.r); r++){
        for(let c=range.s.c; c<=range.e.c; c++){
          const cell=ws[XLSX.utils.encode_cell({r,c})];
          if(cell&&typeof cell.v==='string'&&headerTokens.includes(normalizeHeader(cell.v))){
            headerRow=r; break;
          }
        }
        if(headerRow===r&&headerRow>0) break;
        let found=false;
        for(let c=range.s.c;c<=range.e.c;c++){
          const cell=ws[XLSX.utils.encode_cell({r,c})];
          if(cell&&typeof cell.v==='string'&&headerTokens.includes(normalizeHeader(cell.v))){found=true;break;}
        }
        if(found){headerRow=r;break;}
      }

      const rows=XLSX.utils.sheet_to_json(ws,{defval:'',range:headerRow});
      parseRows(rows,file.name);
    }catch(err){alert('Fehler beim Lesen der Datei: '+err.message);}
  };
  reader.readAsBinaryString(file);
}

function parseRows(rows,filename) {
  if(!rows.length){alert('Keine Daten.');return;}

  // Global-Admin: Schulhäuser aus Excel auto-erstellen wenn noch nicht vorhanden
  if(isGlobalAdmin()){
    const neueSH=[...new Set(rows.map(row=>fc(row,'schulhaus','school','schulhausname')).filter(Boolean))];
    neueSH.forEach(name=>{
      if(!State.schulhaeuser.find(s=>s.name.toLowerCase()===name.toLowerCase())){
        State.schulhaeuser.push({id:uid(),name,ort:''});
      }
    });
    if(CONFIG.mode!=='sharepoint') save();
    buildSchulhausSelector();
    buildSchulhausSelectorAdmin();
  }

  pendingImport=rows.map(row=>{
    const shName=fc(row,'schulhaus','school','schulhausname');
    const vorname=fc(row,'vorname','firstname','first name');
    const nachname=fc(row,'nachname','lastname','last name','name');
    const klasse=fc(row,'klasse','class');
    const lehrperson=fc(row,'lehrperson','teacher','klassenlehrperson');
    const bemerkungen=fc(row,'bemerkungen','bemerkung','note','notes');
    const standardRaumName=fc(row,'standardraum','standard raum','raum','room');
    const tage=[1,2,3,4,5].filter(d=>fcBool(row,DAYS[d], d===1?'montag':'',d===2?'dienstag':'',d===3?'mittwoch':'',d===4?'donnerstag':'',d===5?'freitag':''));
    const myAdminIds = isGlobalAdmin() ? State.schulhaeuser.map(s=>s.id) : mySchulhaeuser().map(s=>s.id);
    let sh=State.schulhaeuser.find(s=>s.name.toLowerCase()===shName.toLowerCase());
    if(!sh && myAdminIds.length===1) sh=State.schulhaeuser.find(s=>s.id===myAdminIds[0]);
    if(!sh && isGlobalAdmin() && !shName) sh=activeSchulhaus();
    const schulhausOk=!!(sh&&myAdminIds.includes(sh.id));
    const standardRaum=schulhausOk&&standardRaumName?State.raeume.find(r=>r.schulhausId===sh.id&&r.label.toLowerCase()===standardRaumName.toLowerCase()):null;
    const standardRaumId=standardRaum?standardRaum.id:'0';
    const isDup=State.kinder.some(k=>k.vorname.toLowerCase()===vorname.toLowerCase()&&k.nachname.toLowerCase()===nachname.toLowerCase()&&k.schulhausId===sh?.id);
    // Ungültig-Grund für Benutzerinfo
    let _grund='';
    if(!vorname||!nachname) _grund='Name fehlt';
    else if(!schulhausOk) _grund=shName?`Schulhaus «${shName}» nicht zugewiesen`:'Schulhaus fehlt';
    return{shName,vorname,nachname,klasse,lehrperson,bemerkungen,tage,standardRaumId,schulhausId:sh?.id,_schulhausOk:schulhausOk,_isDup:isDup,_valid:!!(vorname&&nachname&&schulhausOk),_grund};
  });

  const valid=pendingImport.filter(r=>r._valid).length;
  const dups=pendingImport.filter(r=>r._isDup&&r._valid).length;
  const invalid=pendingImport.length-valid;

  document.getElementById('preview-title').textContent=`Vorschau — ${filename}`;
  document.getElementById('upload-preview').hidden=false;
  document.getElementById('preview-stats').innerHTML=
    `<span class="preview-stat">${pendingImport.length} Zeilen</span>`+
    `<span class="preview-stat ok">${valid-dups} neu</span>`+
    (dups?`<span class="preview-stat warn">${dups} zu aktualisieren</span>`:'')+ 
    (invalid?`<span class="preview-stat err">${invalid} ungültig</span>`:'');

  const tbody=document.getElementById('preview-tbody');tbody.innerHTML='';
  pendingImport.forEach(r=>{
    const tr=document.createElement('tr');if(!r._valid)tr.style.opacity='.5';
    const tageStr=(r.tage||[]).map(d=>DAYS[d]).join(', ')||'–';
    let statusBadge;
    if(!r._valid) statusBadge=`<span class="badge badge-red" title="${esc(r._grund)}">✗ ${esc(r._grund)||'Ungültig'}</span>`;
    else if(r._isDup) statusBadge='<span class="badge badge-amber">↻ Wird aktualisiert</span>';
    else statusBadge='<span class="badge badge-green">+ Neu</span>';
    tr.innerHTML=`<td>${esc(r.shName)||'–'}</td><td>${esc(r.vorname)||'?'}</td><td>${esc(r.nachname)||'?'}</td><td>${esc(r.klasse)||'–'}</td><td>${tageStr}</td><td>${statusBadge}</td>`;
    tbody.appendChild(tr);
  });
}

function clearUpload(){pendingImport=[];document.getElementById('upload-preview').hidden=true;document.getElementById('file-input').value='';}

async function confirmImport() {
  const mode=document.querySelector('input[name="import-mode"]:checked').value;
  const valid=pendingImport.filter(r=>r._valid);
  if(!valid.length){alert('Keine gültigen Einträge.');return;}
  if(mode==='replace'&&!confirm('Alle bestehenden Kinder dieses Schulhauses löschen?'))return;
  const btn=document.getElementById('btn-confirm-import');btn.disabled=true;
  loader(true);
  try{
    if(mode==='replace'){
      const targetIds = activeSchulhaus()?.id ? [activeSchulhaus().id] : activeSchulhausIds();
      const toDelete = State.kinder.filter(k=>targetIds.includes(k.schulhausId));
      if(CONFIG.mode==='sharepoint'){
        await Promise.all(toDelete.filter(k=>k._spId).map(k=>spDeleteKind(k._spId)));
      }
      State.kinder=State.kinder.filter(k=>!targetIds.includes(k.schulhausId));
    }

    // Neu erkannte Schulhäuser in SharePoint speichern
    if(CONFIG.mode==='sharepoint'){
      for(const sh of State.schulhaeuser){
        if(!sh._spId) await spSaveSchulhaus(sh);
      }
    }

    let neu=0, aktualisiert=0;
    for(const r of valid){
      if(r._isDup && mode!=='replace'){
        const existing=State.kinder.find(k=>
          k.vorname.toLowerCase()===r.vorname.toLowerCase()&&
          k.nachname.toLowerCase()===r.nachname.toLowerCase()&&
          k.schulhausId===r.schulhausId
        );
        if(existing){
          if(r.klasse)       existing.klasse=r.klasse;
          if(r.lehrperson)   existing.lehrperson=r.lehrperson;
          if(r.bemerkungen)  existing.bemerkungen=r.bemerkungen;
          if(r.tage&&r.tage.length) existing.tage=r.tage;
          if(r.standardRaumId&&r.standardRaumId!=='0'){
            const oldStandard = existing.standardRaumId;
            existing.standardRaumId=r.standardRaumId;
            if(existing.raumId==='0'||existing.raumId===oldStandard){
              existing.raumId=r.standardRaumId;
            }
          }
          if(CONFIG.mode==='sharepoint') await spSaveKind(existing);
          aktualisiert++;
        }
      } else {
        const k={
          id:uid(),vorname:r.vorname,nachname:r.nachname,
          klasse:r.klasse,lehrperson:r.lehrperson,bemerkungen:r.bemerkungen,
          schulhausId:r.schulhausId,standardRaumId:r.standardRaumId||'0',
          raumId:r.standardRaumId||'0',hatGegessen:false,tage:r.tage
        };
        State.kinder.push(k);
        if(CONFIG.mode==='sharepoint') await spSaveKind(k);
        neu++;
      }
    }

    if(CONFIG.mode!=='sharepoint') save();
    clearUpload();buildKinderFilters();renderKinderTable();renderBoard();
    const msg=mode==='replace'
      ? `${neu} Kinder importiert ✓`
      : `${neu} neu, ${aktualisiert} aktualisiert ✓`;
    toast(msg);
  }catch(e){toast('Fehler: '+e.message);}
  finally{loader(false);btn.disabled=false;}
}

/* ══════════════════════════════════════════════
   DESIGN & BRANDING
   ══════════════════════════════════════════════ */
function syncThemePickers(){document.querySelectorAll('.color-picker[data-theme]').forEach(p=>{p.value=State.theme[p.dataset.theme]||'#ffffff';});}
function syncBrandingInputs(){const b=State.branding;document.getElementById('branding-title').value=b.title||'';document.getElementById('branding-subtitle').value=b.subtitle||'';document.getElementById('branding-emoji').value=b.iconEmoji||'';document.getElementById('branding-bg-color').value=b.headerBg||'#141820';document.getElementById('branding-text-color').value=b.headerText||'#eef2f8';applyBranding();}

function spSave(key, val) {
  if(CONFIG.mode==='sharepoint') SP.saveSettings(key, val).catch(e=>console.warn('spSave:', e));
  else save();
}

function initTheme(){
  document.querySelectorAll('.color-picker[data-theme]').forEach(p=>{p.addEventListener('input',()=>{State.theme[p.dataset.theme]=p.value;applyTheme();spSave('theme',State.theme);});});
  document.getElementById('btn-reset-theme').addEventListener('click',()=>{if(!confirm('Design zurücksetzen?'))return;State.theme={accentColor:'#1a73e8',eatenColor:'#1e8c4a',pendingColor:'#d93025',warnColor:'#f29900',bgBase:'#f6f8fc',bgSurface:'#ffffff'};applyTheme();syncThemePickers();spSave('theme',State.theme);toast('Design zurückgesetzt');});
}
function initBranding(){
  const update=()=>{State.branding.title=document.getElementById('branding-title').value.trim();State.branding.subtitle=document.getElementById('branding-subtitle').value.trim();State.branding.iconEmoji=document.getElementById('branding-emoji').value.trim()||'🍽️';State.branding.headerBg=document.getElementById('branding-bg-color').value;State.branding.headerText=document.getElementById('branding-text-color').value;applyBranding();spSave('branding',State.branding);};
  ['branding-title','branding-subtitle','branding-emoji','branding-bg-color','branding-text-color'].forEach(id=>document.getElementById(id).addEventListener('input',update));
  document.getElementById('btn-reset-branding').addEventListener('click',()=>{if(!confirm('Header zurücksetzen?'))return;State.branding={title:'Mittagstisch',subtitle:'',iconEmoji:'🍽️',headerBg:'#141820',headerText:'#eef2f8'};applyBranding();syncBrandingInputs();spSave('branding',State.branding);toast('Header zurückgesetzt');});
}

/* ══════════════════════════════════════════════
   MODAL HELPERS
   ══════════════════════════════════════════════ */
function initModals(){
  // Kind
  document.getElementById('btn-add-kind').addEventListener('click',()=>openKindModal());
  document.getElementById('modal-kind-close').addEventListener('click',()=>hideModal('modal-kind'));
  document.getElementById('modal-kind-cancel').addEventListener('click',()=>hideModal('modal-kind'));
  document.getElementById('modal-kind-save').addEventListener('click',saveKind);
  document.getElementById('modal-kind').addEventListener('click',e=>{if(e.target===e.currentTarget)hideModal('modal-kind');});
  // Raum
  document.getElementById('btn-add-raum').addEventListener('click',()=>openRaumModal());
  document.getElementById('modal-raum-close').addEventListener('click',()=>hideModal('modal-raum'));
  document.getElementById('modal-raum-cancel').addEventListener('click',()=>hideModal('modal-raum'));
  document.getElementById('modal-raum-save').addEventListener('click',saveRaum);
  document.getElementById('modal-raum').addEventListener('click',e=>{if(e.target===e.currentTarget)hideModal('modal-raum');});
  // Schulhaus
  document.getElementById('btn-add-schulhaus').addEventListener('click',()=>openSchulhausModal());
  document.getElementById('modal-schulhaus-close').addEventListener('click',()=>hideModal('modal-schulhaus'));
  document.getElementById('modal-schulhaus-cancel').addEventListener('click',()=>hideModal('modal-schulhaus'));
  document.getElementById('modal-schulhaus-save').addEventListener('click',saveSchulhaus);
  document.getElementById('modal-schulhaus').addEventListener('click',e=>{if(e.target===e.currentTarget)hideModal('modal-schulhaus');});
  // Benutzer
  document.getElementById('btn-add-user').addEventListener('click',()=>openUserModal());
  document.getElementById('modal-user-close').addEventListener('click',()=>hideModal('modal-user'));
  document.getElementById('modal-user-cancel').addEventListener('click',()=>hideModal('modal-user'));
  document.getElementById('modal-user-save').addEventListener('click',saveUser);
  document.getElementById('modal-user').addEventListener('click',e=>{if(e.target===e.currentTarget)hideModal('modal-user');});
  // ESC
  document.addEventListener('keydown',e=>{if(e.key==='Escape')['modal-kind','modal-raum','modal-schulhaus','modal-user'].forEach(id=>hideModal(id));});
}

/* ══════════════════════════════════════════════
   START
   ══════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', async () => {

  // Modus-Badge im Header anzeigen
  const modeBadge = document.createElement('span');
  modeBadge.style.cssText = 'font-size:10px;font-weight:700;padding:2px 8px;border-radius:999px;margin-left:8px;';
  if (CONFIG.mode === 'sharepoint') {
    modeBadge.textContent = '☁ SharePoint';
    modeBadge.style.background = '#e8f0fe';
    modeBadge.style.color = '#1a73e8';
  } else {
    modeBadge.textContent = '💾 Lokal';
    modeBadge.style.background = '#f1f3f4';
    modeBadge.style.color = '#5f6368';
  }
  const brandSub = document.getElementById('brand-sub-board');
  if (brandSub) brandSub.parentNode.insertBefore(modeBadge, brandSub.nextSibling);

  if (CONFIG.mode === 'sharepoint') {
    // MSAL initialisieren und Microsoft-Login
    try {
      initMsal();
      await msalLogin(); // → Redirect zu Microsoft falls nicht angemeldet
      // Nach Redirect-Rückkehr: Daten laden
      applyTheme();
      applyBranding();
      await SP.loadAll();
      applyTheme();
      applyBranding();
    } catch(e) {
      loader(false);
      // Prüfen ob clientId noch Platzhalter ist
      if (CONFIG.sharepoint.clientId === 'DEINE-APP-ID') {
        alert('Bitte zuerst clientId und tenantId in der CONFIG eintragen.\n\nSiehe Anleitung: Azure AD → App-Registrierung.');
      } else {
        alert(`SharePoint-Fehler:\n\n${e.message}`);
      }
      load(); applyTheme(); applyBranding();
    }
  } else {
    // Lokal-Modus
    load();
    applyTheme();
    applyBranding();
  }

  initLogin();
  initDayFilter();
  initUpload();
  initTheme();
  initBranding();
  initModals();

  // Navigation
  document.getElementById('btn-to-admin').addEventListener('click',()=>{buildAdminTabs();showView('view-admin');});
  document.getElementById('btn-back-admin').addEventListener('click',()=>{renderBoard();showView('view-board');});
  document.getElementById('btn-logout').addEventListener('click',logout);

  // Stats Pills
  document.querySelectorAll('.stat-pill').forEach(p=>{p.addEventListener('click',()=>setBoardFilter(boardFilter===p.dataset.filter&&p.dataset.filter!=='all'?'all':p.dataset.filter));});
  document.getElementById('btn-reset-day').addEventListener('click',resetDay);
  document.getElementById('btn-reset-status').addEventListener('click',resetStatus);

  // Kinder-Suche & Filter
  document.getElementById('search-kind').addEventListener('input',e=>{kindSearch=e.target.value;kindPage=1;renderKinderTable();});
  document.getElementById('filter-klasse').addEventListener('change',e=>{kindFilterKlasse=e.target.value;kindPage=1;renderKinderTable();});
  document.getElementById('filter-lehrperson').addEventListener('change',e=>{kindFilterLP=e.target.value;kindPage=1;renderKinderTable();});
  document.querySelectorAll('.data-table th.sortable').forEach(th=>th.addEventListener('click',()=>{kindSort=kindSort.col===th.dataset.col?{col:th.dataset.col,dir:kindSort.dir==='asc'?'desc':'asc'}:{col:th.dataset.col,dir:'asc'};renderKinderTable();}));

  // Alle-Checkbox im Header
  document.getElementById('cb-all-kinder').addEventListener('change', e => {
    const page = filteredKinder().slice((kindPage-1)*KIDS_PER_PAGE, kindPage*KIDS_PER_PAGE);
    if (e.target.checked) page.forEach(k => selectedKinder.add(k.id));
    else page.forEach(k => selectedKinder.delete(k.id));
    renderKinderTable();
  });

  // Auswahl löschen
  document.getElementById('btn-sel-delete').addEventListener('click', async () => {
    if (!selectedKinder.size) return;
    if (!confirm(`${selectedKinder.size} Kinder wirklich löschen?`)) return;
    if (CONFIG.mode === 'sharepoint') {
      loader(true);
      try {
        await Promise.all([...selectedKinder].map(id => {
          const k = State.kinder.find(k=>k.id===id);
          return k?._spId ? spDeleteKind(k._spId) : Promise.resolve();
        }));
      } finally { loader(false); }
    }
    State.kinder = State.kinder.filter(k => !selectedKinder.has(k.id));
    selectedKinder.clear();
    save(); buildKinderFilters(); renderKinderTable(); renderBoard();
    toast(`Kinder gelöscht ✓`);
  });

  // Auswahl aufheben
  document.getElementById('btn-sel-clear').addEventListener('click', () => {
    selectedKinder.clear(); renderKinderTable();
  });

  // Duplikate prüfen
  document.getElementById('btn-show-dups').addEventListener('click', () => {
    const wrap = document.getElementById('dup-panel-wrap');
    if (!wrap.hidden) { wrap.hidden=true; wrap.innerHTML=''; return; }
    renderDupPanel();
  });

  // Session nach Reload wiederherstellen
  if (restoreSession()) {
    document.getElementById('login-view').style.display = 'none';
    document.getElementById('main-app').classList.add('active');
    updateSessionUI();
    renderBoard();
  }
});

/* ══════════════════════════════════════════════
   DUPLIKAT-PRÜFUNG
   ══════════════════════════════════════════════ */
function findDuplicates() {
  const ids = activeSchulhausIds();
  const kinder = State.kinder.filter(k => ids.includes(k.schulhausId));
  const groups = {};
  kinder.forEach(k => {
    const key = `${k.vorname.trim().toLowerCase()}|${k.nachname.trim().toLowerCase()}|${k.schulhausId}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(k);
  });
  return Object.values(groups).filter(g => g.length > 1);
}

function renderDupPanel() {
  const wrap = document.getElementById('dup-panel-wrap');
  const groups = findDuplicates();

  if (!groups.length) {
    wrap.hidden = false;
    wrap.innerHTML = `<div style="display:flex;align-items:center;gap:10px;padding:12px 16px;background:#e6f4ea;border:1px solid #a8d5b5;border-radius:8px;font-size:13px;color:#137333;font-weight:500">✅ Keine Duplikate gefunden.</div>`;
    return;
  }

  // Merke welche in jeder Gruppe behalten werden (erste = keep, rest = löschen)
  // Benutzer kann per Checkbox die Selektion ändern
  const state = {}; // groupKey → Set von zu löschenden IDs
  groups.forEach(g => {
    const key = g[0].id;
    state[key] = new Set(g.slice(1).map(k => k.id)); // Standard: erste behalten, Rest löschen
  });

  function buildHTML() {
    const totalDel = Object.values(state).reduce((s,set)=>s+set.size,0);
    let html = `<div class="dup-panel">
      <div class="dup-panel-head">
        <span class="dup-panel-title">⚠️ ${groups.length} Duplikat-Gruppe${groups.length>1?'n':''} gefunden — ${totalDel} Einträge zum Löschen markiert</span>
        <div class="dup-panel-actions">
          <button class="btn-outline" id="dup-btn-close" style="font-size:12px">✕ Schliessen</button>
          <button class="btn-danger" id="dup-btn-apply" ${totalDel===0?'disabled':''}>🗑️ ${totalDel} markierte löschen</button>
        </div>
      </div>`;

    groups.forEach(g => {
      const sh = State.schulhaeuser.find(s => s.id===g[0].schulhausId);
      const gKey = g[0].id;
      html += `<div class="dup-group">
        <div class="dup-group-head">
          <span class="dup-group-label">${esc(g[0].vorname)} ${esc(g[0].nachname)}</span>
          ${sh?`<span class="badge badge-muted">🏫 ${esc(sh.name)}</span>`:''}
          <span class="dup-group-count">${g.length} Einträge</span>
        </div>`;
      g.forEach((k, i) => {
        const tage = (k.tage||[]).map(d=>DAYS[d]).filter(Boolean);
        const stdR = State.raeume.find(r => r.id===k.standardRaumId);
        const willDelete = state[gKey].has(k.id);
        html += `<div class="dup-row${!willDelete?' dup-keep':''}" data-gkey="${gKey}" data-kid="${k.id}">
          <input type="checkbox" class="dup-cb" data-gkey="${gKey}" data-kid="${k.id}" ${willDelete?'checked':''} style="width:15px;height:15px;accent-color:#d93025;cursor:pointer;flex-shrink:0">
          <div class="dup-row-info">
            <span style="font-weight:600;color:${willDelete?'#c5221f':'#137333'}">${willDelete?'🗑️ Löschen':'✓ Behalten'}</span>
            ${k.klasse?`<span class="badge badge-blue">${esc(k.klasse)}</span>`:''}
            ${stdR?`<span class="badge badge-muted">${esc(stdR.label)}</span>`:''}
            ${k.lehrperson?`<span class="badge badge-muted">LP: ${esc(k.lehrperson)}</span>`:''}
            ${tage.length?`<span class="badge badge-gold">${tage.join(', ')}</span>`:''}
            ${k.bemerkungen?`<span class="badge badge-amber" title="${esc(k.bemerkungen)}">⚠️ Bemerkung</span>`:''}
          </div>
          <button class="btn-icon" data-edit="${k.id}" title="Bearbeiten" style="flex-shrink:0">✏️</button>
        </div>`;
      });
      html += `</div>`;
    });
    html += `</div>`;
    return html;
  }

  function attach() {
    wrap.querySelector('#dup-btn-close').addEventListener('click', () => { wrap.hidden=true; wrap.innerHTML=''; });
    wrap.querySelector('#dup-btn-apply').addEventListener('click', () => {
      const toDelete = new Set(Object.values(state).flatMap(s=>[...s]));
      if (!toDelete.size) return;
      if (!confirm(`${toDelete.size} Einträge wirklich löschen?`)) return;
      State.kinder = State.kinder.filter(k => !toDelete.has(k.id));
      save(); buildKinderFilters(); renderKinderTable(); renderBoard();
      toast(`${toDelete.size} Duplikate gelöscht ✓`);
      renderDupPanel(); // Panel neu aufbauen
    });
    wrap.querySelectorAll('.dup-cb').forEach(cb => {
      cb.addEventListener('change', e => {
        const {gkey, kid} = e.target.dataset;
        const g = groups.find(g => g[0].id===gkey);
        if (!g) return;
        if (e.target.checked) {
          // Sicherstellen dass mindestens einer behalten wird
          const wouldDelete = [...state[gkey]].filter(id=>id!==kid).concat(e.target.checked?[kid]:[]);
          if (wouldDelete.length >= g.length) { e.target.checked=false; toast('Mindestens einen Eintrag behalten.'); return; }
          state[gkey].add(kid);
        } else {
          state[gkey].delete(kid);
        }
        wrap.innerHTML = buildHTML();
        attach();
      });
    });
    wrap.querySelectorAll('[data-edit]').forEach(b => {
      b.addEventListener('click', () => openKindModal(b.dataset.edit));
    });
  }

  wrap.hidden = false;
  wrap.innerHTML = buildHTML();
  attach();
}
