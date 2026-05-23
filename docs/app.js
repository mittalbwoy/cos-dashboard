/* ---------------------------------------------------------------
   Intelligence dashboard — vanilla JS front-end.
   Loads feed.json / meta.json / notes_index.json from /docs/data,
   renders two tabs (Competitor Intel + AI News), supports search,
   competitor + source filters, and inline markdown "my take" notes.
   --------------------------------------------------------------- */

const DATA = {
  feed:  'data/feed.json',
  meta:  'data/meta.json',
  notes: 'data/notes_index.json',
};
const NOTE_PATH = id => `notes/${id}.md`;

const state = {
  items: [],
  meta: null,
  notesIndex: new Set(),
  tab: 'competitor',
  search: '',
  selectedCompetitors: new Set(),
  selectedSource: '',
};

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

// ---------- UI setup ----------

function initUI() {
  // Tabs
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(b => {
        const active = b === btn;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      state.tab = btn.dataset.tab;
      state.selectedSource = '';
      document.getElementById('source-filter').value = '';
      render();
    });
  });

  // Counts
  const compCount = state.items.filter(i => i.category === 'competitor').length;
  const aiCount = state.items.filter(i => i.category === 'ai-news').length;
  document.getElementById('count-competitor').textContent = compCount;
  document.getElementById('count-ai-news').textContent = aiCount;

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

  // Header timestamp + footer summary
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

// ---------- filter + render ----------

function visibleItems() {
  let items = state.items.filter(i => i.category === state.tab);

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
  if (state.selectedSource) {
    items = items.filter(i => i.source === state.selectedSource);
  }
  // server pre-sorts by date desc, keep that
  return items;
}

function populateSourceFilter() {
  const select = document.getElementById('source-filter');
  const baseItems = state.items.filter(i => i.category === state.tab);
  const sources = [...new Set(baseItems.map(i => i.source))].sort((a, b) => a.localeCompare(b));
  const current = select.value;
  select.innerHTML = '<option value="">All sources</option>' +
    sources.map(s => `<option value="${escapeAttr(s)}">${escapeHtml(s)}</option>`).join('');
  if (sources.includes(current)) select.value = current;
}

function render() {
  // Show/hide the whole competitor filter row depending on tab.
  const compRow = document.getElementById('competitor-row');
  compRow.style.display = state.tab === 'competitor' ? 'flex' : 'none';

  // Selection count + conditional clear link
  const indicator = document.getElementById('competitor-count-indicator');
  const clearLink = document.getElementById('clear-competitors');
  const n = state.selectedCompetitors.size;
  indicator.textContent = n > 0 ? `${n} selected` : '';
  clearLink.hidden = n === 0;

  populateSourceFilter();

  const items = visibleItems();
  const container = document.getElementById('items');

  if (items.length === 0) {
    container.innerHTML = `<div class="empty">${state.items.length === 0
      ? 'No data yet. Trigger the <code>Fetch intelligence feed</code> workflow in GitHub Actions to populate.'
      : 'No items match your filters.'}</div>`;
    return;
  }

  container.innerHTML = items.map(renderItem).join('');

  // Mount notes for items that have them
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
}

function renderItem(it) {
  const tags = (it.competitors || []).map(c =>
    `<span class="tag">${escapeHtml(c)}</span>`
  ).join('');
  const hasNote = state.notesIndex.has(it.id);
  const noteSlot = hasNote
    ? `<div class="note" data-note-id="${escapeAttr(it.id)}"><div class="note-label">my take</div><div class="note-body">loading&hellip;</div></div>`
    : '';
  const addNote = hasNote
    ? ''
    : `<div class="add-note">add note: <code>docs/notes/${escapeHtml(it.id)}.md</code>` +
      `<button type="button" class="copy-id" data-id="${escapeAttr(it.id)}">copy id</button></div>`;
  return `
    <article class="item" data-id="${escapeAttr(it.id)}">
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
