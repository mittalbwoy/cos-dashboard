/* ---------------------------------------------------------------
   Intelligence dashboard — vanilla JS front-end.
   Four tabs: Competitor Intel, AI News, Regulatory, CEO Brief.
   - CEO Brief shows starred items; pins persist in localStorage.
   - ?brief=id1,id2 in the URL loads a shared brief, bypassing pins.
   - Inline markdown "my take" notes load per item.
   --------------------------------------------------------------- */

const DATA = {
  feed:  'data/feed.json',
  meta:  'data/meta.json',
  notes: 'data/notes_index.json',
};
const NOTE_PATH = id => `notes/${id}.md`;
const PINS_KEY = 'cos-dashboard-pins-v1';

const state = {
  items: [],
  meta: null,
  notesIndex: new Set(),
  pinned: loadPins(),
  tab: 'competitor',
  search: '',
  selectedCompetitors: new Set(),
  selectedSource: '',
  briefOverride: parseBriefOverride(),
};

if (state.briefOverride) state.tab = 'brief';

// ---------- bootstrap ----------

async function loadAll() {
  try {
    const [feed, meta, notesIndex] = await Promise.all([
      fetchJSON(DATA.feed),
      fetchJSON(DATA.meta).catch(() => null),
      fetchJSON(DATA.notes).catch(() => []),
    ]);
    state.items = (feed && feed.items) || [];
    state.meta = meta;
    state.notesIndex = new Set(notesIndex || []);
    initUI();
    render();
  } catch (err) {
    console.error(err);
    document.getElementById('items').innerHTML =
      `<div class="empty">Couldn't load data: ${escapeHtml(err.message)}.<br>` +
      `If you just deployed, trigger the <code>Fetch intelligence feed</code> workflow in GitHub Actions.</div>`;
  }
}

async function fetchJSON(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

// ---------- pins ----------

function loadPins() {
  try {
    return new Set(JSON.parse(localStorage.getItem(PINS_KEY) || '[]'));
  } catch { return new Set(); }
}
function savePins() {
  localStorage.setItem(PINS_KEY, JSON.stringify([...state.pinned]));
}
function togglePin(id) {
  if (state.pinned.has(id)) state.pinned.delete(id);
  else state.pinned.add(id);
  savePins();
}

function parseBriefOverride() {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('brief');
  if (!raw) return null;
  const ids = raw.split(',').map(s => s.trim()).filter(Boolean);
  return ids.length > 0 ? ids : null;
}

// ---------- UI setup ----------

function initUI() {
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    if (btn.dataset.tab === state.tab) {
      // Re-sync active states (we may have flipped to 'brief' via URL).
      document.querySelectorAll('.tab').forEach(b => {
        const active = b === btn;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-selected', active ? 'true' : 'false');
      });
    }
  });

  // Search
  const searchEl = document.getElementById('search');
  searchEl.addEventListener('input', e => {
    state.search = e.target.value.trim().toLowerCase();
    render();
  });

  // Competitor chips
  const compContainer = document.getElementById('competitor-filters');
  const competitors = (state.meta && state.meta.competitors) || [];
  compContainer.innerHTML = competitors.map(c =>
    `<button type="button" class="filter-chip" data-comp="${escapeAttr(c)}">${escapeHtml(c)}</button>`
  ).join('');
  compContainer.querySelectorAll('.filter-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const c = btn.dataset.comp;
      if (state.selectedCompetitors.has(c)) {
        state.selectedCompetitors.delete(c);
        btn.classList.remove('is-active');
      } else {
        state.selectedCompetitors.add(c);
        btn.classList.add('is-active');
      }
      render();
    });
  });

  // Source filter
  document.getElementById('source-filter').addEventListener('change', e => {
    state.selectedSource = e.target.value;
    render();
  });

  // Clear all
  document.getElementById('clear-filters').addEventListener('click', () => {
    state.search = '';
    state.selectedCompetitors.clear();
    state.selectedSource = '';
    searchEl.value = '';
    document.getElementById('source-filter').value = '';
    document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('is-active'));
    render();
  });

  // Clear competitor selections only
  document.getElementById('clear-competitors').addEventListener('click', () => {
    state.selectedCompetitors.clear();
    document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('is-active'));
    render();
  });

  // Brief toolbar actions
  document.getElementById('brief-share').addEventListener('click', shareBrief);
  document.getElementById('brief-print').addEventListener('click', () => window.print());
  document.getElementById('brief-clear').addEventListener('click', () => {
    if (state.briefOverride) {
      // Shared brief — just drop the URL override
      state.briefOverride = null;
      const url = new URL(window.location.href);
      url.searchParams.delete('brief');
      window.history.replaceState({}, '', url.toString());
      render();
      return;
    }
    if (state.pinned.size === 0) return;
    if (!confirm(`Remove all ${state.pinned.size} starred items from the brief?`)) return;
    state.pinned.clear();
    savePins();
    render();
  });

  // Counts + header
  updateCounts();
  const gen = state.meta && state.meta.generated_at;
  document.getElementById('generated-at').textContent = gen ? formatTimestamp(gen) : 'no data yet';

  const sources = (state.meta && state.meta.sources) || {};
  const total = Object.keys(sources).length;
  const ok = Object.values(sources).filter(s => s.ok).length;
  const footer = document.getElementById('status-summary');
  if (total > 0) {
    const failed = total - ok;
    footer.innerHTML =
      `${state.items.length} items &middot; ${ok}/${total} sources ok` +
      (failed ? ` &middot; <span class="warn">${failed} failed</span>` : '');
  } else {
    footer.textContent = 'no fetch metadata available yet';
  }
}

function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.tab').forEach(b => {
    const active = b.dataset.tab === tab;
    b.classList.toggle('is-active', active);
    b.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  state.selectedSource = '';
  document.getElementById('source-filter').value = '';
  render();
}

function updateCounts() {
  const cats = { competitor: 0, 'ai-news': 0, regulatory: 0 };
  state.items.forEach(i => { if (i.category in cats) cats[i.category]++; });
  document.getElementById('count-competitor').textContent = cats.competitor;
  document.getElementById('count-ai-news').textContent = cats['ai-news'];
  document.getElementById('count-regulatory').textContent = cats.regulatory;
  const briefCount = state.briefOverride ? state.briefOverride.length : state.pinned.size;
  document.getElementById('count-brief').textContent = briefCount;
}

// ---------- filter + render ----------

function visibleItems() {
  let items;

  if (state.tab === 'brief') {
    const targetIds = new Set(state.briefOverride || [...state.pinned]);
    items = state.items.filter(i => targetIds.has(i.id));
  } else {
    items = state.items.filter(i => i.category === state.tab);
  }

  if (state.search) {
    const q = state.search;
    items = items.filter(i =>
      (i.title || '').toLowerCase().includes(q) ||
      (i.snippet || '').toLowerCase().includes(q) ||
      (i.source || '').toLowerCase().includes(q)
    );
  }
  if (state.tab === 'competitor' && state.selectedCompetitors.size > 0) {
    items = items.filter(i =>
      (i.competitors || []).some(c => state.selectedCompetitors.has(c))
    );
  }
  if (state.tab !== 'brief' && state.selectedSource) {
    items = items.filter(i => i.source === state.selectedSource);
  }
  return items;
}

function populateSourceFilter() {
  const select = document.getElementById('source-filter');
  if (state.tab === 'brief') {
    select.innerHTML = '<option value="">All sources</option>';
    select.value = '';
    return;
  }
  const baseItems = state.items.filter(i => i.category === state.tab);
  const sources = [...new Set(baseItems.map(i => i.source))].sort((a, b) => a.localeCompare(b));
  const current = select.value;
  select.innerHTML = '<option value="">All sources</option>' +
    sources.map(s => `<option value="${escapeAttr(s)}">${escapeHtml(s)}</option>`).join('');
  if (sources.includes(current)) select.value = current;
}

function render() {
  const isBrief = state.tab === 'brief';
  const isCompetitor = state.tab === 'competitor';
  const isRoadmap = state.tab === 'roadmap';

  // Toggle the static Roadmap section vs the dynamic items list.
  document.getElementById('items').hidden = isRoadmap;
  document.getElementById('roadmap').hidden = !isRoadmap;

  // Show/hide the competitor filter row + brief toolbar based on tab.
  document.getElementById('competitor-row').style.display = isCompetitor ? 'flex' : 'none';
  const filtersSection = document.querySelector('.filters');
  filtersSection.style.display = (isBrief || isRoadmap) ? 'none' : 'flex';
  const briefToolbar = document.getElementById('brief-toolbar');
  briefToolbar.hidden = !isBrief;

  // On the roadmap tab there's no list rendering to do.
  if (isRoadmap) return;

  // Selection count + conditional clear link (competitor tab only)
  const indicator = document.getElementById('competitor-count-indicator');
  const clearLink = document.getElementById('clear-competitors');
  const n = state.selectedCompetitors.size;
  indicator.textContent = n > 0 ? `${n} selected` : '';
  clearLink.hidden = n === 0;

  populateSourceFilter();

  const items = visibleItems();
  const container = document.getElementById('items');

  if (isBrief) {
    const meta = document.getElementById('brief-meta');
    if (state.briefOverride) {
      meta.textContent = `shared brief — ${state.briefOverride.length} item${state.briefOverride.length === 1 ? '' : 's'}`;
    } else {
      meta.textContent = state.pinned.size === 0
        ? 'no starred items yet'
        : `${state.pinned.size} starred item${state.pinned.size === 1 ? '' : 's'}`;
    }
  }

  if (items.length === 0) {
    let msg;
    if (isBrief && state.pinned.size === 0 && !state.briefOverride) {
      msg = 'Star items on any tab to build a brief. The star is at the top-right of every card.';
    } else if (state.items.length === 0) {
      msg = 'No data yet. Trigger the <code>Fetch intelligence feed</code> workflow in GitHub Actions to populate.';
    } else {
      msg = 'No items match your filters.';
    }
    container.innerHTML = `<div class="empty">${msg}</div>`;
    return;
  }

  container.innerHTML = items.map(renderItem).join('');

  // Mount notes
  items.forEach(it => {
    if (state.notesIndex.has(it.id)) mountNote(it.id);
  });

  // Wire copy-id buttons
  container.querySelectorAll('.copy-id').forEach(btn => {
    btn.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(btn.dataset.id); } catch {}
      btn.textContent = 'copied';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.textContent = 'copy id';
        btn.classList.remove('copied');
      }, 1200);
    });
  });

  // Wire star buttons
  container.querySelectorAll('.star-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const id = btn.dataset.pin;
      togglePin(id);
      updateCounts();
      if (state.tab === 'brief') {
        render();
      } else {
        const isOn = state.pinned.has(id);
        btn.classList.toggle('is-on', isOn);
        btn.textContent = isOn ? '★' : '☆';
        btn.setAttribute('aria-label', isOn ? 'Unpin item' : 'Pin item');
        btn.setAttribute('title', isOn ? 'Unpin from brief' : 'Pin to brief');
        btn.closest('.item').classList.toggle('is-pinned', isOn);
      }
    });
  });
}

function renderItem(it) {
  const tags = (it.competitors || []).map(c =>
    `<span class="tag">${escapeHtml(c)}</span>`
  ).join('');
  const hasNote = state.notesIndex.has(it.id);
  const isPinned = state.pinned.has(it.id);
  const noteSlot = hasNote
    ? `<div class="note" data-note-id="${escapeAttr(it.id)}"><div class="note-label">my take</div><div class="note-body">loading&hellip;</div></div>`
    : '';
  // 'add note' affordance intentionally hidden — restore by re-adding an
  // <div class="add-note"> block here if you want note authoring back.
  const addNote = '';
  const star = `<button type="button" class="star-btn ${isPinned ? 'is-on' : ''}"
                        data-pin="${escapeAttr(it.id)}"
                        aria-label="${isPinned ? 'Unpin item' : 'Pin item'}"
                        title="${isPinned ? 'Unpin from brief' : 'Pin to brief'}">${isPinned ? '★' : '☆'}</button>`;
  return `
    <article class="item ${isPinned ? 'is-pinned' : ''}" data-id="${escapeAttr(it.id)}">
      ${star}
      <div class="item-title">
        <a href="${escapeAttr(it.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(it.title)}</a>
      </div>
      <div class="item-meta">
        <span>${escapeHtml(it.source)}</span>
        <span class="dot">&middot;</span>
        <span title="${escapeAttr(it.date)}">${formatTimestamp(it.date)}</span>
      </div>
      ${it.snippet ? `<div class="item-snippet">${escapeHtml(it.snippet)}</div>` : ''}
      ${tags ? `<div class="item-tags">${tags}</div>` : ''}
      ${noteSlot}
      ${addNote}
    </article>`;
}

async function mountNote(id) {
  try {
    const r = await fetch(NOTE_PATH(id), { cache: 'no-store' });
    if (!r.ok) return;
    const md = await r.text();
    const el = document.querySelector(`.note[data-note-id="${cssEscape(id)}"] .note-body`);
    if (el && window.marked) {
      el.innerHTML = window.marked.parse(md);
    } else if (el) {
      el.textContent = md;
    }
  } catch (err) {
    console.warn('note load failed', id, err);
  }
}

// ---------- brief share ----------

async function shareBrief() {
  const ids = state.briefOverride || [...state.pinned];
  if (ids.length === 0) {
    alert('No items in the brief yet. Star items on any tab first.');
    return;
  }
  const url = new URL(window.location.href);
  url.search = '';
  url.searchParams.set('brief', ids.join(','));
  const link = url.toString();
  const btn = document.getElementById('brief-share');
  try {
    await navigator.clipboard.writeText(link);
    const original = btn.textContent;
    btn.textContent = 'Link copied';
    setTimeout(() => { btn.textContent = original; }, 1500);
  } catch {
    prompt('Copy this link:', link);
  }
}

// ---------- helpers ----------

function formatTimestamp(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const diff = Date.now() - d.getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const day = Math.floor(h / 24);
  if (day < 7) return `${day}d ago`;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, {
    month: 'short', day: 'numeric',
    year: sameYear ? undefined : 'numeric',
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}
const escapeAttr = escapeHtml;

function cssEscape(s) {
  return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^\w-]/g, '\\$&');
}

loadAll();
