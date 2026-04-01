const API_BASE_URL =
  window.location.hostname === 'localhost'
    ? 'http://localhost:3001'
    : 'https://skockano-backend.onrender.com';

const API = `${API_BASE_URL}/api`;
// const API_BASE_URL = 'https://skockano-backend.onrender.com';
// const API = `${API_BASE_URL}/api`;
//const API = '/api';
const SERVICES = [
  { id: 'regular', name: 'Redovno čišćenje', duration: '2–3 sata', price: 3600 },
  { id: 'general', name: 'Generalno čišćenje', duration: '4–6 sati', price: 7200 },
  { id: 'deep', name: 'Dubinsko čišćenje', duration: '6–8 sati', price: 10800 },
  { id: 'moveout', name: 'Čišćenje posle selidbe', duration: '5–7 sati', price: 9200 },
];
const DAY_CHOICES = ['2026-03-31','2026-04-01','2026-04-02','2026-04-03','2026-04-04','2026-04-05','2026-04-06'];
const TIME_CHOICES = ['08:00','09:00','10:00','11:00','13:00','14:00','15:00','16:00','17:00'];

const state = {
  token: localStorage.getItem('cisto_token'),
  refreshToken: localStorage.getItem('cisto_refresh_token'),
  user: JSON.parse(localStorage.getItem('cisto_user') || 'null'),
  health: null,
  meta: null,
  overview: null,
  providers: [],
  providerProfile: null,
  selectedProvider: null,
  selectedService: SERVICES[0],
  selectedDay: DAY_CHOICES[0],
  selectedTime: TIME_CHOICES[2],
  selectedPaymentMethod: 'cash',
  bookings: [],
  conversations: [],
  activeConversation: null,
  messages: [],
  payments: [],
  admin: null,
  socket: null,
  authMode: 'login',
  currentView: 'auth',
  filters: { search: '', minRating: '', maxPrice: '', verified: false, sort: 'default' },
  providerPagination: { page: 1, limit: 12, total: 0, totalPages: 1 },
  bookingFilters: { status: '', sort: 'newest', search: '' },
  bookingPagination: { page: 1, limit: 10, total: 0, totalPages: 1 },
  loading: { global: 0, providers: false, bookings: false, messages: false, auth: false, profile: false, admin: false },
  ui: { providerSearchTimer: null, bookingSearchTimer: null, lastError: '' },
  session: { refreshing: null },
};

const qs = (id) => document.getElementById(id);
const money = (n) => `${Number(n || 0).toLocaleString('sr-RS')} din`;
const initials = (name='') => name.split(' ').map(p => p[0]).join('').slice(0,2).toUpperCase();
function escapeHtml(value = '') { return String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function toast(message, variant = 'info') {
  const el = qs('toast');
  if (!el) return;
  el.textContent = message;
  el.dataset.variant = variant;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2600);
}
function setLoading(scope, value) {
  state.loading[scope] = value;
  if (scope === 'global') return;
  document.body.dataset.loading = Object.values(state.loading).some(Boolean) ? 'true' : 'false';
}
function sectionSkeleton(kind = 'Učitavam podatke...') {
  return `<div class="card skeleton-card"><div class="skeleton-line lg"></div><div class="skeleton-line"></div><div class="skeleton-line"></div><div class="muted">${escapeHtml(kind)}</div></div>`;
}
function emptyState(title, subtitle = '') {
  return `<div class="empty"><strong>${escapeHtml(title)}</strong>${subtitle ? `<div class="muted" style="margin-top:6px">${escapeHtml(subtitle)}</div>` : ''}</div>`;
}
function pagerMarkup(pagination, actionName) {
  const page = Number(pagination?.page || 1);
  const totalPages = Number(pagination?.totalPages || 1);
  const total = Number(pagination?.total || 0);
  if (totalPages <= 1) return `<div class="pager-summary">Ukupno rezultata: ${total}</div>`;
  return `<div class="pager">
    <div class="pager-summary">Strana ${page} / ${totalPages} · ukupno ${total}</div>
    <div class="pager-actions">
      <button class="ghost-btn" ${page <= 1 ? 'disabled' : ''} onclick="${actionName}(${page - 1})">Prethodna</button>
      <button class="ghost-btn" ${page >= totalPages ? 'disabled' : ''} onclick="${actionName}(${page + 1})">Sledeća</button>
    </div>
  </div>`;
}
const isProvider = () => state.user?.role === 'provider';
const isAdmin = () => state.user?.role === 'admin';
const isClient = () => state.user?.role === 'client';
const avatarMarkup = (provider, large=false) => provider?.avatarUrl
  ? `<img src="${provider.avatarUrl}" class="avatar ${large ? 'avatar-lg' : ''}" style="object-fit:cover;${large ? 'width:72px;height:72px;' : ''}" alt="${escapeHtml(provider.name)}"/>`
  : `<div class="avatar ${large ? 'avatar-lg' : ''}" style="background:${provider?.color || '#eef4ff'};color:${provider?.textColor || '#1769ff'}">${escapeHtml(provider?.initials || initials(provider?.name || ''))}</div>`;

async function refreshSession() {
  if (!state.refreshToken) throw new Error('Sesija je istekla. Prijavi se ponovo.');
  if (!state.session.refreshing) {
    state.session.refreshing = (async () => {
      const res = await fetch(`${API}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: state.refreshToken }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || 'Sesija je istekla.');
      persistAuth(data);
      return data;
    })().finally(() => { state.session.refreshing = null; });
  }
  return state.session.refreshing;
}

async function api(path, method='GET', body, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (body !== undefined && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const isJson = res.headers.get('content-type')?.includes('application/json');
  const data = isJson ? await res.json().catch(() => null) : null;

  if (res.status === 401 && options.retryAuth !== false && state.refreshToken && !path.includes('/auth/refresh')) {
    try {
      await refreshSession();
      return api(path, method, body, { ...options, retryAuth: false });
    } catch (refreshErr) {
      logout({ silent: true });
      throw refreshErr;
    }
  }

  if (!res.ok) {
    state.ui.lastError = data?.error || 'Greška na serveru';
    throw new Error(state.ui.lastError);
  }
  return data;
}

async function checkHealth() {
  try {
    state.health = await fetch('${API}/health').then(r=>r.json());
    const mode = [state.health?.dataMode, state.health?.schemaMode, state.health?.paymentMode].filter(Boolean).join(' · ');
    qs('api-pill').textContent = mode ? `API aktivan · ${mode}` : 'API aktivan';
    qs('api-pill').className = 'api-pill ok';
  } catch {
    qs('api-pill').textContent = 'API nije dostupan';
    qs('api-pill').className = 'api-pill off';
  }
}

function persistAuth(data) {
  state.token = data.token;
  state.refreshToken = data.refreshToken || state.refreshToken;
  state.user = data.user;
  localStorage.setItem('cisto_token', data.token);
  if (state.refreshToken) localStorage.setItem('cisto_refresh_token', state.refreshToken);
  localStorage.setItem('cisto_user', JSON.stringify(data.user));
}
async function logout(options = {}) {
  const { silent = false } = options;
  const oldToken = state.token;
  state.token = null; state.refreshToken = null; state.user = null; state.providerProfile = null; state.bookings = []; state.conversations = []; state.activeConversation = null; state.messages = []; state.payments = []; state.admin = null;
  localStorage.removeItem('cisto_token'); localStorage.removeItem('cisto_refresh_token'); localStorage.removeItem('cisto_user');
  if (state.socket) { state.socket.disconnect(); state.socket = null; }
  if (oldToken && !silent) {
    try {
      await fetch(`${API}/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${oldToken}` } });
    } catch {}
  }
  setView('auth'); renderAll();
  if (!silent) toast('Odjavljen si sa sistema.');
}

function navItems() {
  if (isAdmin()) {
    return [
      { key: 'dashboard', label: 'Pregled', icon: '📊' },
      { key: 'admin', label: 'Admin', icon: '🛡️' },
      { key: 'providers', label: 'Pružaoci', icon: '🧽' },
      { key: 'bookings', label: 'Rezervacije', icon: '📅' },
      { key: 'profile', label: 'Profil', icon: '👤' },
    ];
  }
  return [
    { key: 'dashboard', label: isProvider() ? 'Panel' : 'Pregled', icon: '🏠' },
    { key: 'providers', label: 'Pružaoci', icon: '🧽' },
    { key: 'bookings', label: isProvider() ? 'Poslovi' : 'Rezervacije', icon: '📅' },
    { key: 'messages', label: 'Poruke', icon: '💬' },
    { key: 'profile', label: isProvider() ? 'Moj servis' : 'Profil', icon: '👤' },
  ];
}

function renderSidebar() {
  qs('sidebar-nav').innerHTML = navItems().map(item => `
    <button class="nav-item ${state.currentView === item.key ? 'active' : ''}" onclick="goTo('${item.key}')">
      <span>${item.icon}</span><span>${item.label}</span>
    </button>`).join('');
}

function setView(view) {
  state.currentView = view;
  document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
  const section = qs(`${view}-view`);
  if (section) section.classList.add('active');
  qs('logout-btn').classList.toggle('hidden', !state.user);
  const meta = {
    auth: ['Prijava i registracija', 'Prijavi se ili napravi nalog i nastavi u aplikaciju.'],
    dashboard: [isAdmin() ? 'Admin pregled' : isProvider() ? 'Provider panel' : 'Pregled', isAdmin() ? 'Kontrola korisnika, verifikacija i finansije.' : isProvider() ? 'Poslovi, statistika i zahtevi na jednom mestu.' : 'Pregled pružalaca, rezervacija i razgovora.'],
    providers: ['Pružaoci usluga', 'Pretraga, filteri i detaljan pregled profila.'],
    provider: ['Profil pružaoca', 'Detalji usluge, recenzije, galerija i rezervacija termina.'],
    bookings: ['Rezervacije', 'Statusi, cene, naplata i sledeći koraci.'],
    messages: ['Poruke', 'Razgovori povezani sa backendom i Socket.IO.'],
    profile: [isProvider() ? 'Moj servis' : 'Moj profil', isProvider() ? 'Uredi cenu, opis, usluge, galeriju i dostupnost.' : 'Podaci o nalogu i aktivnosti.'],
    admin: ['Admin panel', 'Verifikacija pružalaca, korisnici i evidencija uplata.'],
  };
  qs('page-title').textContent = meta[view]?.[0] || 'Čisto';
  qs('page-subtitle').textContent = meta[view]?.[1] || '';
  renderSidebar();
}
window.goTo = (view) => { if (!state.user && view !== 'auth') return setView('auth'); setView(view); renderAll(); };

function ensureSocket() {
  if (!window.io || !state.user || isAdmin() || state.socket) return;
  state.socket = io();
  state.socket.emit('join', state.user.id);
  state.socket.on('newMessage', async (msg) => {
    if (state.activeConversation?.id === msg.conversationId) { state.messages.push(msg); renderMessagesPanel(); }
    await loadConversations();
    renderMessagesList();
  });
}

async function loadOverview() { state.overview = await api('/analytics/overview'); }
async function loadMeta() { state.meta = await fetch('${API}/meta/config').then(r=>r.json()).catch(()=>null); }
async function loadProviders() {
  setLoading('providers', true);
  try {
    const params = new URLSearchParams();
    if (state.filters.search) params.set('search', state.filters.search);
    if (state.filters.minRating) params.set('minRating', state.filters.minRating);
    if (state.filters.maxPrice) params.set('maxPrice', state.filters.maxPrice);
    if (state.filters.verified) params.set('verified', 'true');
    if (state.filters.sort && state.filters.sort !== 'default') params.set('sort', state.filters.sort);
    params.set('page', String(state.providerPagination.page || 1));
    params.set('limit', String(state.providerPagination.limit || 12));
    params.set('includeMeta', 'true');
    const payload = await api(`/providers?${params.toString()}`);
    state.providers = payload.items || payload;
    state.providerPagination = payload.pagination || state.providerPagination;
  } finally {
    setLoading('providers', false);
  }
}
async function loadProviderProfileSafe() { if (!isProvider()) return state.providerProfile = null; try { state.providerProfile = await api('/provider/me'); } catch { state.providerProfile = null; } }
async function loadBookings() {
  if (!state.user || isAdmin()) return state.bookings = [];
  setLoading('bookings', true);
  try {
    const params = new URLSearchParams();
    if (state.bookingFilters.status) params.set('status', state.bookingFilters.status);
    if (state.bookingFilters.search) params.set('search', state.bookingFilters.search);
    if (state.bookingFilters.sort) params.set('sort', state.bookingFilters.sort);
    params.set('page', String(state.bookingPagination.page || 1));
    params.set('limit', String(state.bookingPagination.limit || 10));
    params.set('includeMeta', 'true');
    const payload = await api(`/bookings/my?${params.toString()}`);
    state.bookings = payload.items || payload;
    state.bookingPagination = payload.pagination || state.bookingPagination;
  } finally {
    setLoading('bookings', false);
  }
}
async function loadConversations() {
  if (!state.user || isAdmin()) return state.conversations = [];
  const payload = await api('/conversations/all?includeMeta=true&limit=50');
  state.conversations = payload.items || payload;
  if (!state.activeConversation || !state.conversations.some(c => c.id === state.activeConversation.id)) state.activeConversation = state.conversations[0] || null;
}
async function loadMessages() {
  if (!state.activeConversation) return state.messages = [];
  setLoading('messages', true);
  try {
    const payload = await api(`/messages/${state.activeConversation.id}?includeMeta=true&limit=200`);
    state.messages = payload.items || payload;
  } finally {
    setLoading('messages', false);
  }
}
async function loadPayments() {
  if (!state.user) return state.payments = [];
  const payload = await api('/payments/my?includeMeta=true&limit=50');
  state.payments = payload.items || payload;
}
async function loadAdminData() { if (!isAdmin()) return state.admin = null; state.admin = await api('/admin/overview'); }

async function bootstrapAfterLogin() {
  await Promise.all([loadOverview(), loadProviders(), loadProviderProfileSafe(), loadBookings(), loadConversations(), loadPayments(), loadAdminData()]);
  ensureSocket();
  if (state.activeConversation) await loadMessages();
}

function renderAuth() {
  qs('auth-view').innerHTML = `
    <div class="auth-wrap">
      <div class="hero">
        <div>
          <span class="eyebrow">ČISTO PLATFORM</span>
          <h2>Čišćenje, rezervacija i komunikacija na jednom mestu.</h2>
          <p>Klijenti zakazuju termine, pružaoci vode svoj servis, admin verifikuje profile, prati uplate i podešava platformu.</p>
        </div>
        <div class="mini-card light">
          <strong>Test nalozi</strong><br/>Klijent: milan@test.com / lozinka123<br/>Pružalac: marija@test.com / lozinka123<br/>Admin: admin@test.com / admin123
        </div>
      </div>
      <div class="card">
        <div class="form-tabs">
          <button class="form-tab ${state.authMode === 'login' ? 'active' : ''}" onclick="switchAuthMode('login')">Prijava</button>
          <button class="form-tab ${state.authMode === 'register' ? 'active' : ''}" onclick="switchAuthMode('register')">Registracija</button>
        </div>
        <form id="auth-form">
          ${state.authMode === 'register' ? `<div class="field"><label>Ime i prezime</label><input name="name" required /></div>` : ''}
          <div class="field"><label>Email</label><input name="email" type="email" required /></div>
          <div class="field"><label>Lozinka</label><input name="password" type="password" required /></div>
          ${state.authMode === 'register' ? `
            <div class="field"><label>Uloga</label><select name="role"><option value="client">Klijent</option><option value="provider">Pružalac usluge</option></select></div>
            <div class="field"><label>Lokacija</label><input name="location" value="Beograd" /></div>` : ''}
          <button class="primary-btn" type="submit" style="width:100%">${state.authMode === 'login' ? 'Prijavi se' : 'Napravi nalog'}</button>
        </form>
      </div>
      <div class="muted" style="margin-top:12px">Podržani režimi: PostgreSQL, refresh sesije, admin audit, Stripe/Cloudinary ready.</div>
    </div>`;
  qs('auth-form').onsubmit = async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    const payload = Object.fromEntries(form.entries());
    try {
      setLoading('auth', true);
      const data = await api(state.authMode === 'login' ? '/auth/login' : '/auth/register', 'POST', payload);
      persistAuth(data);
      await bootstrapAfterLogin();
      setView('dashboard');
      renderAll();
      toast(state.authMode === 'login' ? 'Uspešna prijava.' : 'Nalog je kreiran.', 'success');
    } catch (err) { toast(err.message, 'error'); }
    finally { setLoading('auth', false); }
  };
}
window.switchAuthMode = (mode) => { state.authMode = mode; renderAuth(); };

function cardStat(label, value) { return `<div class="kpi"><div class="num">${value}</div><div>${label}</div></div>`; }
function renderDashboard() {
  const totalRevenue = (isAdmin() ? (state.admin?.payments || []) : state.payments).filter(p => p.status === 'paid').reduce((sum, p) => sum + Number(p.amount || 0), 0);
  const pendingJobs = state.bookings.filter(item => item.status === 'confirmed').length;
  const completedJobs = state.bookings.filter(item => ['completed','reviewed'].includes(item.status)).length;
  const topProviders = state.providers.slice(0, 3);
  const upcoming = isAdmin() ? (state.admin?.bookings || []).slice(0, 4) : state.bookings.slice(0, 4);
  qs('dashboard-view').innerHTML = `
    <div class="grid">
      <div class="banner">
        <div>
          <span class="eyebrow">${isAdmin() ? 'Administracija' : isProvider() ? 'Provider iskustvo' : 'Klijentsko iskustvo'}</span>
          <h2>${isAdmin() ? 'Kontroliši celu platformu iz jednog panela.' : isProvider() ? `Dobrodošla nazad, ${escapeHtml(state.user?.name || '')}` : 'Pronađi proverenu pomoć za dom za nekoliko klikova.'}</h2>
          <p>${isAdmin() ? 'Verifikuj profile, prati rezervacije i proveri sve transakcije.' : isProvider() ? 'Prati zahteve, ažuriraj svoj servis i odgovaraj klijentima iz jedne table.' : 'Pregledaj profile, rezerviši termin i nastavi komunikaciju bez napuštanja aplikacije.'}</p>
        </div>
        <div class="banner-side">
          <div class="mini-metric"><strong>${state.overview?.totalProviders || 0}</strong><span>aktivnih profila</span></div>
          <div class="mini-metric"><strong>${state.overview?.onlineProviders || 0}</strong><span>online sada</span></div>
        </div>
      </div>
      <div class="kpis">
        ${isAdmin()
          ? cardStat('Korisnici', state.admin?.users?.length || 0) + cardStat('Čekaju verifikaciju', state.overview?.pendingVerification || 0) + cardStat('Plaćeno', money(totalRevenue))
          : isProvider()
            ? cardStat('Aktivni poslovi', pendingJobs) + cardStat('Završeni poslovi', completedJobs) + cardStat('Ukupan promet', money(totalRevenue))
            : cardStat('Moje rezervacije', state.bookings.length) + cardStat('Razgovori', state.conversations.length) + cardStat('Potrošeno', money(totalRevenue))}
      </div>
      <div class="grid cols-2">
        <div class="card">
          <div class="section-head"><h3>${isAdmin() ? 'Najnovije rezervacije' : isProvider() ? 'Najnoviji poslovi' : 'Sledeće rezervacije'}</h3><button class="ghost-btn" onclick="goTo('bookings')">Otvori</button></div>
          <div class="list">
            ${upcoming.map(item => `<div class="list-item"><div><strong>${escapeHtml(item.serviceName || item.service)}</strong><div class="muted">${escapeHtml(item.provider?.name || item.client?.name || '')}</div></div><div style="text-align:right"><strong>${escapeHtml(item.date)} ${escapeHtml(item.time)}</strong><div class="muted">${escapeHtml(item.status)}</div></div></div>`).join('') || '<div class="empty">Još nema aktivnosti.</div>'}
          </div>
        </div>
        <div class="card">
          <div class="section-head"><h3>${isAdmin() ? 'Top pružaoci' : isProvider() ? 'Tržište i konkurencija' : 'Preporučeni pružaoci'}</h3><button class="ghost-btn" onclick="goTo('providers')">Pregledaj</button></div>
          <div class="list">
            ${topProviders.map(provider => `<div class="list-item"><div style="display:flex;gap:12px;align-items:center">${avatarMarkup(provider)}<div><strong>${escapeHtml(provider.name)}</strong><div class="muted">${escapeHtml(provider.location)}</div></div></div><div style="text-align:right"><strong>★ ${provider.rating}</strong><div class="muted">${money(provider.pricePerHour)}/h</div></div></div>`).join('') || '<div class="empty">Nema rezultata.</div>'}
          </div>
        </div>
      </div>
    </div>`;
}

function renderProviders() {
  const content = state.loading.providers
    ? `<div class="providers-grid">${sectionSkeleton('Učitavam pružaoce...')}${sectionSkeleton('Pripremam listu...')}</div>`
    : state.providers.length
      ? `<div class="providers-grid">
        ${state.providers.map(provider => `
          <div class="provider-card">
            <div class="provider-top">
              <div style="display:flex;gap:12px;align-items:center">${avatarMarkup(provider)}<div><strong>${escapeHtml(provider.name)}</strong><div class="muted">${escapeHtml(provider.location)}</div></div></div>
              <div style="text-align:right"><strong>${money(provider.pricePerHour)}</strong><div class="muted">po satu</div></div>
            </div>
            <div class="badge-row">${provider.verified ? '<span class="badge verified">Verifikovan</span>' : ''}${provider.online ? '<span class="badge online">Online</span>' : ''}<span class="badge">★ ${provider.rating}</span></div>
            <div class="chips">${(provider.services || []).map(s => `<span class="chip">${escapeHtml(s)}</span>`).join('')}</div>
            <p class="muted">${escapeHtml(provider.bio || '')}</p>
            <button class="primary-btn" onclick="openProvider('${provider.id}')">Pogledaj profil</button>
          </div>`).join('')}
        </div>`
      : emptyState('Nema pružalaca za dati filter.', 'Probaj drugačiji kriterijum ili ukloni filtere.');

  qs('providers-view').innerHTML = `
    <div class="card" style="margin-bottom:18px">
      <div class="filters">
        <input id="filter-search" placeholder="Ime, usluga ili lokacija" value="${escapeHtml(state.filters.search)}" />
        <select id="filter-rating"><option value="">Min rating</option><option value="4" ${state.filters.minRating==='4'?'selected':''}>4+</option><option value="4.5" ${state.filters.minRating==='4.5'?'selected':''}>4.5+</option><option value="4.8" ${state.filters.minRating==='4.8'?'selected':''}>4.8+</option></select>
        <select id="filter-price"><option value="">Max cena / sat</option><option value="1600" ${state.filters.maxPrice==='1600'?'selected':''}>1600</option><option value="1800" ${state.filters.maxPrice==='1800'?'selected':''}>1800</option><option value="2500" ${state.filters.maxPrice==='2500'?'selected':''}>2500</option></select>
        <select id="filter-sort"><option value="default" ${state.filters.sort==='default'?'selected':''}>Podrazumevano</option><option value="rating_desc" ${state.filters.sort==='rating_desc'?'selected':''}>Najbolji rejting</option><option value="price_asc" ${state.filters.sort==='price_asc'?'selected':''}>Cena rastuće</option><option value="price_desc" ${state.filters.sort==='price_desc'?'selected':''}>Cena opadajuće</option></select>
        <label class="chip"><input id="filter-verified" type="checkbox" ${state.filters.verified ? 'checked' : ''}/> Samo verifikovani</label>
        <button class="primary-btn" onclick="applyFilters()">Primeni</button>
        <button class="ghost-btn" onclick="resetProviderFilters()">Reset</button>
      </div>
    </div>
    ${pagerMarkup(state.providerPagination, 'goToProviderPage')}
    ${content}`;

  const searchEl = qs('filter-search');
  if (searchEl) {
    searchEl.oninput = () => {
      clearTimeout(state.ui.providerSearchTimer);
      state.ui.providerSearchTimer = setTimeout(() => applyFilters({ preservePage: false }), 350);
    };
  }
}
window.openProvider = async function(providerId) {
  state.selectedProvider = await api(`/providers/${providerId}`); state.selectedService = SERVICES[0]; state.selectedDay = DAY_CHOICES[0]; state.selectedTime = TIME_CHOICES[2]; state.selectedPaymentMethod = 'cash'; setView('provider'); renderProviderDetails();
};
function renderProviderDetails() {
  const p = state.selectedProvider;
  if (!p) return qs('provider-view').innerHTML = '<div class="empty">Nije izabran provider.</div>';
  const gallery = (p.gallery || []).map((src) => `<img src="${src}" class="gallery-thumb" alt="Galerija"/>`).join('') || '<div class="empty">Još nema dodatih slika.</div>';
  qs('provider-view').innerHTML = `
    <div class="provider-details">
      <div class="grid">
        <div class="card">
          <div class="provider-top">
            <div style="display:flex;gap:14px;align-items:center">${avatarMarkup(p, true)}<div><h2 style="margin:0 0 8px">${escapeHtml(p.name)}</h2><div class="badge-row"><span class="badge">★ ${p.rating}</span><span class="badge">${p.reviewCount || p.reviews?.length || 0} recenzija</span>${p.verified ? '<span class="badge verified">Verifikovan</span>' : ''}${p.online ? '<span class="badge online">Online</span>' : ''}</div></div></div>
            <button class="ghost-btn" onclick="goTo('providers')">Nazad</button>
          </div>
          <p>${escapeHtml(p.bio || '')}</p>
          <div class="chips">${(p.services || []).map(s => `<span class="chip">${escapeHtml(s)}</span>`).join('')}</div>
          <div class="grid cols-3" style="margin-top:18px"><div class="mini-card light"><strong>${money(p.pricePerHour)}</strong><span>po satu</span></div><div class="mini-card light"><strong>${p.stats?.jobs || 0}</strong><span>odrađenih poslova</span></div><div class="mini-card light"><strong>${p.stats?.response || 0}%</strong><span>stopa odgovora</span></div></div>
        </div>
        <div class="card"><h3>Galerija</h3><div class="gallery-grid">${gallery}</div></div>
        <div class="card"><h3>Recenzije</h3><div class="list">${(p.reviews || []).map(r => `<div class="list-item" style="display:block"><div style="display:flex;justify-content:space-between;gap:10px"><strong>${escapeHtml(r.clientName)}</strong><span class="muted">★ ${r.rating}</span></div><div class="muted" style="margin:6px 0">${escapeHtml(r.date)}</div><div>${escapeHtml(r.text)}</div></div>`).join('') || '<div class="empty">Još nema recenzija.</div>'}</div></div>
      </div>
      <div class="grid">
        <div class="card">
          <h3>Rezerviši termin</h3>
          <div class="field"><label>Usluga</label><select id="service-select">${SERVICES.map(s => `<option value="${s.id}" ${state.selectedService?.id===s.id?'selected':''}>${s.name} · ${money(s.price)}</option>`).join('')}</select></div>
          <div class="field"><label>Dan</label><div class="chips">${DAY_CHOICES.map(day => `<button class="day-pill ${state.selectedDay===day?'active':''}" onclick="chooseDay('${day}')">${day}</button>`).join('')}</div></div>
          <div class="field"><label>Vreme</label><div class="time-slots">${TIME_CHOICES.map(slot => `<button class="time-slot ${state.selectedTime===slot?'active':''}" onclick="chooseTime('${slot}')">${slot}</button>`).join('')}</div></div>
          <div class="field"><label>Način plaćanja</label><select id="payment-method"><option value="cash" ${state.selectedPaymentMethod==='cash'?'selected':''}>Plaćanje na licu mesta</option><option value="card" ${state.selectedPaymentMethod==='card'?'selected':''}>Kartica odmah</option></select></div>
          <div class="field"><label>Napomena</label><textarea id="booking-note" placeholder="Na primer: treba i terasa, prozori ili frižider"></textarea></div>
          <div class="price-box"><div class="list-item"><span>Ukupna cena</span><strong>${money(state.selectedService?.price)}</strong></div><div class="list-item"><span>Provizija platforme</span><strong>${money(Math.round((state.selectedService?.price || 0) * 0.10))}</strong></div><div class="list-item"><span>Provider dobija</span><strong>${money((state.selectedService?.price || 0) - Math.round((state.selectedService?.price || 0) * 0.10))}</strong></div></div>
          <button class="primary-btn" onclick="submitBooking()" ${!isClient() ? 'disabled' : ''}>${isProvider() ? 'Provider ne rezerviše sam sebi' : isAdmin() ? 'Admin ne rezerviše' : 'Potvrdi rezervaciju'}</button>
        </div>
      </div>
    </div>`;
  qs('service-select').onchange = (e) => { state.selectedService = SERVICES.find(s => s.id === e.target.value) || SERVICES[0]; renderProviderDetails(); };
  qs('payment-method').onchange = (e) => { state.selectedPaymentMethod = e.target.value; };
}
window.chooseDay = (day) => { state.selectedDay = day; renderProviderDetails(); };
window.chooseTime = (time) => { state.selectedTime = time; renderProviderDetails(); };
window.submitBooking = async function() {
  if (!state.user) return toast('Prvo se prijavi.');
  if (!isClient()) return toast('Samo klijent može praviti rezervaciju.');
  await api('/bookings', 'POST', { providerId: state.selectedProvider.id, service: state.selectedService.id, serviceName: state.selectedService.name, date: state.selectedDay, time: state.selectedTime, price: state.selectedService.price, note: qs('booking-note').value, paymentMethod: qs('payment-method').value });
  await Promise.all([loadBookings(), loadConversations(), loadPayments()]); setView('bookings'); renderAll(); toast('Rezervacija je poslata.');
};

function bookingActions(booking) {
  if (isAdmin()) return `<button class="ghost-btn" onclick="adminSetBooking('${booking.id}','completed')">Završi</button><button class="ghost-btn" onclick="adminSetBooking('${booking.id}','cancelled')">Otkaži</button>`;
  const actions = [];
  if (isProvider() && booking.status === 'confirmed') actions.push(`<button class="ghost-btn" onclick="changeBookingStatus('${booking.id}','completed')">Označi kao završeno</button>`);
  if (isClient() && booking.status === 'confirmed') actions.push(`<button class="ghost-btn" onclick="changeBookingStatus('${booking.id}','cancelled')">Otkaži</button>`);
  if (isClient() && booking.status === 'completed') actions.push(`<button class="ghost-btn" onclick="openReviewForm('${booking.id}','${booking.providerId}')">Ostavi recenziju</button>`);
  if (isClient() && booking.paymentStatus !== 'paid') actions.push(`<button class="primary-btn" onclick="payBooking('${booking.id}','${booking.providerId}',${booking.price})">Plati karticom</button>`);
  return actions.join('');
}
function renderBookings() {
  const bookings = isAdmin() ? (state.admin?.bookings || []) : state.bookings;
  const pagination = isAdmin() ? { page: 1, totalPages: 1, total: bookings.length } : state.bookingPagination;
  const listMarkup = state.loading.bookings
    ? sectionSkeleton('Učitavam rezervacije...')
    : bookings.length
      ? bookings.map(booking => `<div class="card booking-card"><div class="provider-top"><div><h3 style="margin:0">${escapeHtml(booking.serviceName || booking.service)}</h3><div class="muted">${escapeHtml(booking.provider?.name || booking.client?.name || '')}</div></div><div style="text-align:right"><div class="booking-status ${escapeHtml(booking.status)}">${escapeHtml(booking.status)}</div><strong>${money(booking.price)}</strong></div></div><div class="list-item"><span>Termin</span><strong>${escapeHtml(booking.date)} u ${escapeHtml(booking.time)}</strong></div><div class="list-item"><span>Način plaćanja</span><strong>${escapeHtml(booking.paymentMethod || 'cash')} · ${escapeHtml(booking.paymentStatus || 'pending')}</strong></div>${booking.payment?.reference ? `<div class="list-item"><span>Referenca uplate</span><strong>${escapeHtml(booking.payment.reference)}</strong></div>` : ''}${isProvider() ? `<div class="list-item"><span>Tebi ostaje</span><strong>${money(booking.providerAmount || (booking.price - Math.round(booking.price * 0.10)))}</strong></div>` : ''}${booking.note ? `<div class="note-box">${escapeHtml(booking.note)}</div>` : ''}<div class="actions-row">${bookingActions(booking)}</div></div>`).join('')
      : emptyState('Još nema rezervacija.', 'Kada zakažeš prvi termin, pojaviće se ovde.');

  qs('bookings-view').innerHTML = `
    ${!isAdmin() ? `<div class="card" style="margin-bottom:18px">
      <div class="filters">
        <input id="booking-search" placeholder="Pretraga po usluzi ili imenu" value="${escapeHtml(state.bookingFilters.search)}" />
        <select id="booking-status-filter">
          <option value="" ${!state.bookingFilters.status ? 'selected' : ''}>Svi statusi</option>
          <option value="pending" ${state.bookingFilters.status==='pending'?'selected':''}>pending</option>
          <option value="confirmed" ${state.bookingFilters.status==='confirmed'?'selected':''}>confirmed</option>
          <option value="completed" ${state.bookingFilters.status==='completed'?'selected':''}>completed</option>
          <option value="cancelled" ${state.bookingFilters.status==='cancelled'?'selected':''}>cancelled</option>
        </select>
        <select id="booking-sort-filter">
          <option value="newest" ${state.bookingFilters.sort==='newest'?'selected':''}>Najnovije</option>
          <option value="oldest" ${state.bookingFilters.sort==='oldest'?'selected':''}>Najstarije</option>
          <option value="price_desc" ${state.bookingFilters.sort==='price_desc'?'selected':''}>Najskuplje</option>
          <option value="price_asc" ${state.bookingFilters.sort==='price_asc'?'selected':''}>Najjeftinije</option>
        </select>
        <button class="primary-btn" onclick="applyBookingFilters()">Primeni</button>
        <button class="ghost-btn" onclick="resetBookingFilters()">Reset</button>
      </div>
    </div>` : ''}
    ${pagerMarkup(pagination, 'goToBookingPage')}
    <div class="grid">${listMarkup}</div>`;

  const searchEl = qs('booking-search');
  if (searchEl) {
    searchEl.oninput = () => {
      clearTimeout(state.ui.bookingSearchTimer);
      state.ui.bookingSearchTimer = setTimeout(() => applyBookingFilters({ preservePage: false }), 350);
    };
  }
}
window.changeBookingStatus = async function(id, status) { try { await api(`/bookings/${id}/status`, 'PATCH', { status }); await Promise.all([loadBookings(), loadConversations(), loadPayments(), loadAdminData()]); renderAll(); toast('Status je ažuriran.'); } catch (err) { toast(err.message); } };
window.payBooking = async function(bookingId, providerId, amount) { try { await api('/payments/checkout', 'POST', { bookingId, providerId, amount, method: 'card' }); await Promise.all([loadBookings(), loadPayments(), loadAdminData()]); renderBookings(); toast('Uplata je uspešno evidentirana.'); } catch (err) { toast(err.message); } };
window.adminSetBooking = async function(id, status) { return window.changeBookingStatus(id, status); };
window.openReviewForm = function(bookingId, providerId) {
  const card = document.createElement('div'); card.className = 'modal-backdrop';
  card.innerHTML = `<div class="modal-card"><h3>Ostavi ocenu</h3><div class="field"><label>Ocena</label><select id="review-rating"><option value="5">5</option><option value="4">4</option><option value="3">3</option></select></div><div class="field"><label>Komentar</label><textarea id="review-text" placeholder="Kako je prošla usluga?"></textarea></div><div class="actions-row"><button class="ghost-btn" onclick="this.closest('.modal-backdrop').remove()">Zatvori</button><button class="primary-btn" id="review-submit">Pošalji</button></div></div>`;
  document.body.appendChild(card);
  card.querySelector('#review-submit').onclick = async () => {
    try { await api('/reviews', 'POST', { bookingId, providerId, rating: Number(card.querySelector('#review-rating').value), text: card.querySelector('#review-text').value }); card.remove(); await Promise.all([loadBookings(), loadProviders(), loadProviderProfileSafe()]); renderAll(); toast('Recenzija je sačuvana.'); } catch (err) { toast(err.message); }
  };
};

async function renderMessages() {
  qs('messages-view').innerHTML = `<div class="conversation-layout"><div class="card"><div class="section-head"><h3>Razgovori</h3></div><div id="conversation-list" class="conversation-list"></div></div><div id="messages-panel" class="messages-panel"></div></div>`;
  renderMessagesList(); if (state.activeConversation) await loadMessages(); renderMessagesPanel();
}
function conversationTitle(conv) { return isProvider() ? conv.client?.name || 'Klijent' : conv.provider?.name || 'Provider'; }
function conversationSubtitle(conv) { if (isProvider()) return conv.client?.email || conv.client?.location || ''; return conv.provider?.location || ''; }
function renderMessagesList() {
  const el = qs('conversation-list'); if (!el) return;
  if (!state.conversations.length) {
    el.innerHTML = emptyState('Još nema poruka.');
    return;
  }
  el.innerHTML = state.conversations.map(conv => `<button class="conversation-item ${state.activeConversation?.id === conv.id ? 'active' : ''}" onclick="selectConversation('${conv.id}')"><div style="display:flex;justify-content:space-between;gap:10px"><strong>${escapeHtml(conversationTitle(conv))}</strong><span class="muted">${escapeHtml(conv.lastTime || '')}</span></div><div class="muted">${escapeHtml(conv.lastMessage || '')}</div></button>`).join('');
}
window.selectConversation = async function(id) { state.activeConversation = state.conversations.find(c => c.id === id) || null; await loadMessages(); renderMessagesList(); renderMessagesPanel(); };
function messageBubbleClass(msg) { const mine = (isProvider() && msg.from === 'provider') || (isClient() && msg.from === 'client'); if (msg.from === 'system') return 'system'; return mine ? 'own' : 'other'; }
function renderMessagesPanel() {
  const panel = qs('messages-panel'); if (!panel) return; if (!state.activeConversation) return panel.innerHTML = '<div class="empty" style="padding:24px">Izaberi razgovor.</div>';
  const messagesMarkup = state.loading.messages
    ? sectionSkeleton('Učitavam poruke...')
    : (state.messages.map(msg => `<div class="msg-row ${messageBubbleClass(msg)}"><div class="msg ${messageBubbleClass(msg)}">${escapeHtml(msg.text)}<span class="msg-meta">${escapeHtml(msg.time || '')}</span></div></div>`).join('') || '<div class="empty">Još nema poruka.</div>');
  panel.innerHTML = `<div class="messages-header"><div><strong>${escapeHtml(conversationTitle(state.activeConversation))}</strong><div class="muted">${escapeHtml(conversationSubtitle(state.activeConversation))}</div></div><button class="ghost-btn" onclick="goTo('bookings')">Poslovi</button></div><div id="messages-body" class="messages-body">${messagesMarkup}</div><form id="message-form" class="messages-compose"><input id="message-input" placeholder="Pošalji poruku..." ${state.loading.messages ? 'disabled' : ''}/><button class="primary-btn" type="submit" ${state.loading.messages ? 'disabled' : ''}>Pošalji</button></form>`;
  const body = qs('messages-body'); if (body) body.scrollTop = body.scrollHeight;
  qs('message-form').onsubmit = async (e) => { e.preventDefault(); const text = qs('message-input').value.trim(); if (!text) return; try { const msg = await api('/messages', 'POST', { conversationId: state.activeConversation.id, text }); state.messages.push(msg); qs('message-input').value = ''; await loadConversations(); renderMessagesList(); renderMessagesPanel(); } catch (err) { toast(err.message); } };
}

function renderProfile() {
  if (isProvider()) return renderProviderProfile();
  const totalSpend = state.payments.filter(p => p.status === 'paid').reduce((sum, item) => sum + Number(item.amount || 0), 0);
  qs('profile-view').innerHTML = `<div class="profile-grid"><div class="card"><h3>Podaci o nalogu</h3><div class="list-item"><span>Ime</span><strong>${escapeHtml(state.user?.name || '')}</strong></div><div class="list-item"><span>Email</span><strong>${escapeHtml(state.user?.email || '')}</strong></div><div class="list-item"><span>Lokacija</span><strong>${escapeHtml(state.user?.location || '')}</strong></div><div class="list-item"><span>Uloga</span><strong>${escapeHtml(state.user?.role || '')}</strong></div><div class="list-item"><span>Podrška</span><strong>${escapeHtml(state.meta?.supportEmail || 'podrska@cisto.test')}</strong></div></div><div class="card"><h3>Aktivnost</h3><div class="list-item"><span>Rezervacija</span><strong>${state.bookings.length}</strong></div><div class="list-item"><span>Razgovora</span><strong>${state.conversations.length}</strong></div><div class="list-item"><span>Ukupno plaćeno</span><strong>${money(totalSpend)}</strong></div><div class="list-item"><span>Naknada platforme</span><strong>${escapeHtml(String(state.meta?.bookingFeePercent || 10))}%</strong></div></div></div>`;
}
function renderProviderProfile() {
  const p = state.providerProfile; if (!p) return qs('profile-view').innerHTML = '<div class="empty">Provider profil nije učitan.</div>';
  qs('profile-view').innerHTML = `
    <div class="grid cols-2">
      <div class="card">
        <h3>Javni profil</h3>
        <form id="provider-profile-form">
          <div class="field"><label>Lokacija</label><input name="location" value="${escapeHtml(p.location || '')}" /></div>
          <div class="field"><label>Cena po satu</label><input name="pricePerHour" type="number" value="${escapeHtml(p.pricePerHour || 0)}" /></div>
          <div class="field"><label>Online status</label><select name="online"><option value="true" ${p.online ? 'selected' : ''}>Online</option><option value="false" ${!p.online ? 'selected' : ''}>Offline</option></select></div>
          <div class="field"><label>Usluge (zarezima odvojene)</label><input name="services" value="${escapeHtml((p.services || []).join(', '))}" /></div>
          <div class="field"><label>Bio</label><textarea name="bio">${escapeHtml(p.bio || '')}</textarea></div>
          <button class="primary-btn" type="submit">Sačuvaj izmene</button>
        </form>
      </div>
      <div class="grid">
        <div class="card"><h3>Fotografije profila</h3><div style="display:grid;gap:12px">${p.avatarUrl ? `<img src="${p.avatarUrl}" class="gallery-thumb" style="width:100%;height:180px"/>` : '<div class="empty">Nema naslovne slike.</div>'}<input id="avatar-upload" type="file" accept="image/*"/><button class="ghost-btn" onclick="uploadProviderImage('avatar')">Sačuvaj naslovnu sliku</button></div></div>
        <div class="card"><h3>Galerija</h3><div class="gallery-grid">${(p.gallery || []).map((src, idx) => `<div class="gallery-item"><img src="${src}" class="gallery-thumb" alt="Galerija"/><button class="ghost-btn small-btn" onclick="removeGalleryImage(${idx})">Ukloni</button></div>`).join('') || '<div class="empty">Još nema slika.</div>'}</div><input id="gallery-upload" type="file" accept="image/*"/><button class="ghost-btn" onclick="uploadProviderImage('gallery')">Dodaj u galeriju</button></div>
        <div class="card"><h3>Rezime servisa</h3><div class="list-item"><span>Rating</span><strong>★ ${p.rating}</strong></div><div class="list-item"><span>Recenzije</span><strong>${p.reviewCount}</strong></div><div class="list-item"><span>Poslovi</span><strong>${p.stats?.jobs || 0}</strong></div><div class="list-item"><span>Odgovor</span><strong>${p.stats?.response || 0}%</strong></div></div>
      </div>
    </div>`;
  qs('provider-profile-form').onsubmit = async (e) => {
    e.preventDefault(); const form = new FormData(e.target);
    try { state.providerProfile = await api('/provider/me', 'PATCH', { location: form.get('location'), pricePerHour: Number(form.get('pricePerHour')), online: form.get('online') === 'true', bio: form.get('bio'), services: String(form.get('services')).split(',').map(s => s.trim()).filter(Boolean) }); await loadProviders(); renderProviderProfile(); toast('Provider profil je ažuriran.'); } catch (err) { toast(err.message); }
  };
}
async function fileToDataUrl(file) { return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(file); }); }
window.uploadProviderImage = async function(kind) {
  const input = qs(kind === 'avatar' ? 'avatar-upload' : 'gallery-upload');
  const file = input?.files?.[0]; if (!file) return toast('Izaberi sliku.');
  try { await api('/provider/upload-image', 'POST', { kind, filename: file.name, imageData: await fileToDataUrl(file) }); await Promise.all([loadProviderProfileSafe(), loadProviders()]); if (state.selectedProvider?.id === state.providerProfile?.id) state.selectedProvider = state.providerProfile; renderAll(); toast('Slika je sačuvana.'); input.value = ''; } catch (err) { toast(err.message); }
};
window.removeGalleryImage = async function(index) { try { await api(`/provider/gallery/${index}`, 'DELETE'); await Promise.all([loadProviderProfileSafe(), loadProviders()]); renderAll(); toast('Slika je uklonjena.'); } catch (err) { toast(err.message); } };

function renderAdmin() {
  if (!isAdmin()) return qs('admin-view').innerHTML = '<div class="empty">Admin pristup nije dostupan.</div>';
  const data = state.admin || { users: [], providers: [], bookings: [], payments: [] };
  qs('admin-view').innerHTML = `
    <div class="grid">
      <div class="grid cols-3">
        ${cardStat('Korisnici', data.users.length)}
        ${cardStat('Pružaoci', data.providers.length)}
        ${cardStat('Uplate', money(data.payments.filter(p => p.status === 'paid').reduce((s,p)=>s+Number(p.amount||0),0)))}
      </div>
      <div class="grid cols-2">
        <div class="card"><h3>Verifikacija pružalaca</h3><div class="list">${data.providers.map(p => `<div class="list-item"><div style="display:flex;gap:12px;align-items:center">${avatarMarkup(p)}<div><strong>${escapeHtml(p.name)}</strong><div class="muted">${escapeHtml(p.location)}</div></div></div><div class="actions-row"><span class="badge ${p.verified ? 'verified' : ''}">${p.verified ? 'Verifikovan' : 'Čeka'}</span><button class="ghost-btn" onclick="setProviderVerified('${p.id}', ${!p.verified})">${p.verified ? 'Skini verifikaciju' : 'Verifikuj'}</button></div></div>`).join('')}</div></div>
        <div class="card"><h3>Korisnici</h3><div class="list">${data.users.map(u => `<div class="list-item"><div><strong>${escapeHtml(u.name)}</strong><div class="muted">${escapeHtml(u.email)}</div></div><div class="muted">${escapeHtml(u.role)}</div></div>`).join('')}</div></div>
      </div>
      <div class="grid cols-2">
        <div class="card"><h3>Rezervacije</h3><div class="list">${data.bookings.slice(0, 8).map(b => `<div class="list-item"><div><strong>${escapeHtml(b.serviceName || b.service)}</strong><div class="muted">${escapeHtml(b.client?.name || '')} → ${escapeHtml(b.provider?.name || '')}</div></div><div style="text-align:right"><div class="booking-status ${escapeHtml(b.status)}">${escapeHtml(b.status)}</div><div class="muted">${escapeHtml(b.date)} ${escapeHtml(b.time)}</div></div></div>`).join('')}</div></div>
        <div class="card"><h3>Uplate</h3><div class="list">${data.payments.map(p => `<div class="list-item"><div><strong>${money(p.amount)}</strong><div class="muted">${escapeHtml(p.reference || '')}</div></div><div class="muted">${escapeHtml(p.status)} · ${escapeHtml(p.method)}</div></div>`).join('') || '<div class="empty">Još nema uplata.</div>'}</div></div>
      </div>
    </div>`;
}
window.setProviderVerified = async function(id, verified) { try { await api(`/admin/providers/${id}/verify`, 'PATCH', { verified }); await Promise.all([loadAdminData(), loadProviders(), loadOverview()]); renderAdmin(); toast('Status verifikacije je promenjen.'); } catch (err) { toast(err.message); } };
window.saveAdminSettings = async function() { try {
  await api('/admin/settings', 'PATCH', {
    platformName: qs('admin-platform-name')?.value,
    supportEmail: qs('admin-support-email')?.value,
    bookingFeePercent: Number(qs('admin-booking-fee')?.value || 10),
    defaultCurrency: qs('admin-currency')?.value,
    deployTarget: qs('admin-deploy-target')?.value,
    maintenanceMode: qs('admin-maintenance-mode')?.value === 'true',
    allowNewProviders: qs('admin-provider-signups')?.value === 'true',
  });
  await Promise.all([loadAdminData(), loadMeta(), loadOverview()]);
  renderAll();
  toast('Podešavanja platforme su sačuvana.');
} catch (err) { toast(err.message); } };
window.exportAdminBackup = async function() { try {
  const data = await api('/admin/export');
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `cisto-backup-${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  await loadAdminData();
  renderAdmin();
  toast('Backup je preuzet kao JSON fajl.');
} catch (err) { toast(err.message); } };


window.goToProviderPage = async function(page) {
  state.providerPagination.page = page;
  await loadProviders();
  renderProviders();
  window.scrollTo({ top: 0, behavior: 'smooth' });
};

window.goToBookingPage = async function(page) {
  state.bookingPagination.page = page;
  await loadBookings();
  renderBookings();
  window.scrollTo({ top: 0, behavior: 'smooth' });
};

window.applyFilters = async function(options = {}) {
  state.filters.search = qs('filter-search')?.value.trim() || '';
  state.filters.minRating = qs('filter-rating')?.value || '';
  state.filters.maxPrice = qs('filter-price')?.value || '';
  state.filters.sort = qs('filter-sort')?.value || 'default';
  state.filters.verified = !!qs('filter-verified')?.checked;
  if (!options.preservePage) state.providerPagination.page = 1;
  try {
    await loadProviders();
    renderProviders();
  } catch (err) { toast(err.message, 'error'); }
};

window.resetProviderFilters = async function() {
  state.filters = { search: '', minRating: '', maxPrice: '', verified: false, sort: 'default' };
  state.providerPagination.page = 1;
  await loadProviders();
  renderProviders();
};

window.applyBookingFilters = async function(options = {}) {
  state.bookingFilters.search = qs('booking-search')?.value.trim() || '';
  state.bookingFilters.status = qs('booking-status-filter')?.value || '';
  state.bookingFilters.sort = qs('booking-sort-filter')?.value || 'newest';
  if (!options.preservePage) state.bookingPagination.page = 1;
  try {
    await loadBookings();
    renderBookings();
  } catch (err) { toast(err.message, 'error'); }
};

window.resetBookingFilters = async function() {
  state.bookingFilters = { status: '', sort: 'newest', search: '' };
  state.bookingPagination.page = 1;
  await loadBookings();
  renderBookings();
};

function renderAll() {
  renderSidebar(); renderAuth();
  if (!state.user) return;
  renderDashboard(); renderProviders(); renderBookings(); renderProfile(); renderAdmin();
  if (state.currentView === 'provider') renderProviderDetails();
  if (state.currentView === 'messages' && !isAdmin()) renderMessages();
}

async function init() {
  qs('logout-btn').onclick = () => logout();
  await checkHealth();
  if (state.user && state.token) {
    try { await bootstrapAfterLogin(); setView('dashboard'); }
    catch { logout(); }
  } else setView('auth');
  renderAll();
}
init();
