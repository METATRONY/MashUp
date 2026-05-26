import { addSongToLibraryById } from './ui.js';

const BASE = () => window.MASHUP_API_BASE || 'http://127.0.0.1:8000';

let _catalog = null;
let _activeDecade = 'all';
let _query = '';

const DECADES = [
  { label: '1990–2000', from: 1990, to: 1999 },
  { label: '2000–2010', from: 2000, to: 2009 },
  { label: '2010–2020', from: 2010, to: 2019 },
  { label: '2020–',     from: 2020, to: 9999 },
];

async function fetchCatalog() {
  if (_catalog) return _catalog;
  const res = await fetch(`${BASE()}/api/catalog`);
  _catalog = await res.json();
  return _catalog;
}

export async function initCatalog(store) {
  const panel = document.getElementById('catalog-panel');
  if (!panel) return;

  // Year filter
  const yearBar = panel.querySelector('.catalog-years');
  const searchEl = panel.querySelector('.catalog-search');
  const listEl = panel.querySelector('.catalog-list');
  const loadingEl = panel.querySelector('.catalog-loading');

  loadingEl.hidden = false;
  listEl.innerHTML = '';
  const catalog = await fetchCatalog();
  loadingEl.hidden = true;

  yearBar.innerHTML = [
    `<button class="catalog-year-pill active" data-decade="all">All</button>`,
    ...DECADES.map(d =>
      `<button class="catalog-year-pill" data-decade="${d.label}">${d.label}</button>`
    )
  ].join('');

  function render() {
    const state = store.getState();
    const libSet = new Set(state.songs.map(s => `${(s.artist||'').toLowerCase()}|${(s.title||'').toLowerCase()}`));
    const decade = DECADES.find(d => d.label === _activeDecade);
    const filtered = catalog.filter(s => {
      if (decade && (s.year < decade.from || s.year > decade.to)) return false;
      if (_query) {
        const q = _query.toLowerCase();
        return s.title.toLowerCase().includes(q) || s.artist.toLowerCase().includes(q);
      }
      return true;
    });

    listEl.innerHTML = filtered.map((s, i) => {
      const key = `${s.artist.toLowerCase()}|${s.title.toLowerCase()}`;
      const inLib = libSet.has(key);
      return `<div class="catalog-row" data-idx="${i}" data-artist="${escHtml(s.artist)}" data-title="${escHtml(s.title)}">
        <span class="catalog-row__year">${s.year}</span>
        <span class="catalog-row__info"><strong>${escHtml(s.artist)}</strong> — ${escHtml(s.title)}</span>
        <button class="btn btn-sm catalog-add-btn${inLib ? ' in-lib' : ''}" ${inLib ? 'disabled' : ''} data-artist="${escHtml(s.artist)}" data-title="${escHtml(s.title)}">
          ${inLib ? 'In Library' : '+ Add'}
        </button>
      </div>`;
    }).join('');
  }

  yearBar.addEventListener('click', e => {
    const pill = e.target.closest('.catalog-year-pill');
    if (!pill) return;
    yearBar.querySelectorAll('.catalog-year-pill').forEach(p => p.classList.remove('active'));
    pill.classList.add('active');
    _activeDecade = pill.dataset.decade;
    render();
  });

  searchEl.addEventListener('input', () => { _query = searchEl.value.trim(); render(); });

  listEl.addEventListener('click', async e => {
    const btn = e.target.closest('.catalog-add-btn');
    if (!btn || btn.disabled) return;
    const artist = btn.dataset.artist;
    const title = btn.dataset.title;
    btn.textContent = 'Searching…';
    btn.disabled = true;
    try {
      const res = await fetch(`${BASE()}/api/search-yt?artist=${encodeURIComponent(artist)}&title=${encodeURIComponent(title)}`);
      if (!res.ok) throw new Error('Not found');
      const { video_id } = await res.json();
      await addSongToLibraryById(store, video_id, artist, title);
      btn.textContent = 'Added ✓';
    } catch {
      btn.textContent = 'Not found';
      btn.disabled = false;
    }
  });

  store.subscribe(() => render());
  render();
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
