import { showToast, addSongToMixer, addSongToLibraryById } from './ui.js';
import { resetBpmOverride } from './mixer.js';
import { COMPONENT_IDS } from './constants/components.js';

const API_BASE = () => window.MASHUP_API_BASE || 'http://127.0.0.1:8000';
const NON_VOCAL = COMPONENT_IDS.filter(id => id !== 'vocals');

let _store = null;
let _sourceSongId = null;
let _activeAudio = null;
let _selectedCover = null;

export function initRemix(store) {
  _store = store;
  document.getElementById('remix-close-btn')?.addEventListener('click', closeRemixModal);
  document.getElementById('remix-cancel-btn')?.addEventListener('click', closeRemixModal);
  document.getElementById('remix-overlay')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeRemixModal();
  });
  window.openRemixModal = openRemixModal;
}

function closeRemixModal() {
  document.getElementById('remix-overlay').hidden = true;
  stopPreview();
  _selectedCover = null;
  // Reset footer state
  const useBtn = document.getElementById('remix-use-btn');
  const cancelBtn = document.getElementById('remix-cancel-btn');
  if (useBtn) { useBtn.disabled = false; useBtn.hidden = true; }
  if (cancelBtn) cancelBtn.disabled = false;
  document.querySelector('.remix-status')?.remove();
}

function stopPreview() {
  if (_activeAudio) {
    _activeAudio.pause();
    _activeAudio = null;
  }
  document.querySelectorAll('.remix-card__play--playing').forEach(b => {
    b.textContent = '▶';
    b.classList.remove('remix-card__play--playing');
  });
}

function openRemixModal(songId) {
  _sourceSongId = songId;
  _selectedCover = null;
  const song = _store.getState().songs.find(s => s.id === songId);
  if (!song) return;

  document.getElementById('remix-dialog-subtitle').textContent =
    `Covers of "${song.title}"${song.artist ? ` by ${song.artist}` : ''}`;
  document.getElementById('remix-grid').innerHTML = '';
  document.getElementById('remix-error').hidden = true;
  document.getElementById('remix-use-btn').hidden = true;
  document.getElementById('remix-overlay').hidden = false;

  searchCovers(song.title, song.artist || '');
}

async function searchCovers(title, artist) {
  const loading = document.getElementById('remix-loading');
  const errorEl = document.getElementById('remix-error');
  loading.hidden = false;
  errorEl.hidden = true;

  try {
    const params = new URLSearchParams({ title });
    if (artist) params.set('artist', artist);
    const res = await fetch(`${API_BASE()}/api/search-covers?${params}`);
    if (!res.ok) throw new Error(res.status);
    const { covers } = await res.json();
    loading.hidden = true;
    if (!covers.length) {
      errorEl.textContent = 'No covers found — try a shorter title.';
      errorEl.hidden = false;
      return;
    }
    renderCoverGrid(covers, artist);
  } catch {
    loading.hidden = true;
    errorEl.textContent = 'Could not load covers. Is the backend running?';
    errorEl.hidden = false;
  }
}

function renderCoverGrid(covers, originalArtist) {
  const grid = document.getElementById('remix-grid');
  grid.innerHTML = '';
  covers.forEach(cover => {
    const isOriginal = cover.artist.toLowerCase() === (originalArtist || '').toLowerCase();
    const card = document.createElement('div');
    card.className = `remix-card${isOriginal ? ' remix-card--original' : ''}`;
    card.innerHTML = `
      <div class="remix-card__art">
        <img src="${cover.cover}" alt="" loading="lazy" onerror="this.style.display='none'">
        <button type="button" class="remix-card__play" aria-label="Preview">▶</button>
      </div>
      <div class="remix-card__body">
        <div class="remix-card__artist">${esc(cover.artist)}</div>
        <div class="remix-card__source">deezer · preview</div>
        ${isOriginal ? '<div class="remix-card__original-badge">Original</div>' : ''}
      </div>
    `;
    card.querySelector('.remix-card__play').addEventListener('click', (e) => {
      e.stopPropagation();
      togglePreview(cover.preview, e.currentTarget);
    });
    card.addEventListener('click', () => selectCover(cover, card));
    grid.appendChild(card);
  });
}

function togglePreview(url, btn) {
  const wasSame = _activeAudio?._url === url;
  stopPreview();
  if (wasSame) return;

  const audio = new Audio(url);
  audio._url = url;
  audio.play().catch(() => {});
  audio.addEventListener('ended', () => stopPreview());
  btn.textContent = '⏸';
  btn.classList.add('remix-card__play--playing');
  _activeAudio = audio;
}

function selectCover(cover, cardEl) {
  document.querySelectorAll('.remix-card--selected').forEach(c => c.classList.remove('remix-card--selected'));
  cardEl.classList.add('remix-card--selected');
  _selectedCover = cover;

  const useBtn = document.getElementById('remix-use-btn');
  useBtn.textContent = `Use "${esc(cover.artist)}" Style`;
  useBtn.hidden = false;
  useBtn.onclick = configureRemixMixer;
}

function setRemixLoading(msg) {
  const useBtn = document.getElementById('remix-use-btn');
  const cancelBtn = document.getElementById('remix-cancel-btn');
  const footer = document.querySelector('.remix-dialog__footer');

  useBtn.disabled = true;
  cancelBtn.disabled = true;

  let status = footer.querySelector('.remix-status');
  if (!status) {
    status = document.createElement('span');
    status.className = 'remix-status';
    footer.insertBefore(status, useBtn);
  }
  status.textContent = msg;
}

function setRemixError(msg) {
  const useBtn = document.getElementById('remix-use-btn');
  const cancelBtn = document.getElementById('remix-cancel-btn');
  useBtn.disabled = false;
  cancelBtn.disabled = false;
  const status = document.querySelector('.remix-status');
  if (status) status.remove();

  const errorEl = document.getElementById('remix-error');
  errorEl.textContent = msg;
  errorEl.hidden = false;
  errorEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function closeLibraryDrawer() {
  const drawer = document.getElementById('song-input-section');
  if (drawer?.classList.contains('library-drawer--open')) {
    drawer.classList.remove('library-drawer--open');
    document.body.classList.remove('library-open');
  }
}

async function configureRemixMixer() {
  if (!_selectedCover || !_sourceSongId) return;

  const originalSong = _store.getState().songs.find(s => s.id === _sourceSongId);
  if (!originalSong) return;

  // Keep modal open — show progress inline
  setRemixLoading(`Finding "${_selectedCover.artist}" on YouTube…`);

  // Step 1: find cover on YouTube before touching the mixer
  let coverVideoId = null;
  try {
    const res = await fetch(
      `${API_BASE()}/api/search-yt?artist=${encodeURIComponent(_selectedCover.artist)}&title=${encodeURIComponent(_selectedCover.title)}`
    );
    if (res.ok) coverVideoId = (await res.json()).video_id;
  } catch { /* network error */ }

  if (!coverVideoId) {
    setRemixError(`"${_selectedCover.artist}" wasn't found on YouTube. Try a different cover.`);
    return;
  }

  setRemixLoading(`Adding "${_selectedCover.artist}" to library…`);

  // Step 2: add cover to library (no-op if duplicate)
  await addSongToLibraryById(_store, coverVideoId, _selectedCover.artist, _selectedCover.title);

  const coverSong = _store.getState().songs.find(s => s.videoId === coverVideoId);
  if (!coverSong) {
    setRemixError('Could not add the cover to the library. Try again.');
    return;
  }

  // Step 3: clear the mixer and reset manual BPM override so auto-detect runs
  resetBpmOverride();
  const existingTracks = _store.getState().mashup.tracks;
  existingTracks.forEach(t => _store.removeTrack(t.id));

  // Step 4: original → vocals only
  addSongToMixer(_store, _sourceSongId);
  const origTrackId = _store.getState().mashup.tracks.at(-1).id;
  _store.updateTrackComponents(origTrackId, ['vocals']);

  // Step 5: cover → all non-vocal components
  addSongToMixer(_store, coverSong.id);
  const coverTrackId = _store.getState().mashup.tracks.at(-1).id;
  _store.updateTrackComponents(coverTrackId, NON_VOCAL);

  // Step 6: close modal + drawer, scroll to mixer
  closeRemixModal();
  closeLibraryDrawer();
  setTimeout(() => {
    document.getElementById('mixer-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const genBtn = document.getElementById('generate-mashup-btn');
    if (genBtn) {
      genBtn.classList.add('remix-btn-pulse');
      setTimeout(() => genBtn.classList.remove('remix-btn-pulse'), 2000);
    }
  }, 150);
  showToast(`Mixer set — ${originalSong.artist || originalSong.title} vocals + ${_selectedCover.artist} style. Hit Generate!`, 'success');
}

function esc(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
