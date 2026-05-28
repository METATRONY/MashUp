/**
 * App entry point: wires together all modules.
 */

import { createStore } from './state.js';
import { setupSongInput, renderSongs, initSongSearch, setupToastListener, setMatchFilter, clearMatchFilter } from './ui.js';
import { initMixer, renderTracks, renderTransport, renderGenerationUI, setupKeyboardShortcuts } from './mixer.js';
import { initAudio, setMashupResultUrl } from './audio.js';
import { initCatalog } from './catalog.js';
import { camelotDistance, bpmStretchPct } from './compatibility.js';

// Create the global store
const store = createStore();

// Load library from backend JSON (authoritative), fall back to localStorage
(async () => {
  try {
    const res = await fetch(`${window.MASHUP_API_BASE || 'http://127.0.0.1:8000'}/api/library`);
    if (res.ok) {
      const songs = await res.json();
      if (Array.isArray(songs) && songs.length > 0) {
        store.setState({ songs });
      }
    }
  } catch { /* backend not running — localStorage fallback stays */ }
})();

// Setup toast listener (for events from components/mixer modules)
setupToastListener();

// Setup song input form and library search
setupSongInput(store);
initSongSearch();

// Initialize mixer (transport wiring)
initMixer(store);

// Wire result audio element and waveform animation
initAudio(store);

// Restore audio player URL from persisted generation state
const _initGen = store.getState().mashup.generation;
if (_initGen.resultUrl) {
  setMashupResultUrl(_initGen.resultUrl);
}

// Setup keyboard shortcuts (Space = play/pause)
setupKeyboardShortcuts();

// Search / match-filter re-renders the song list without touching store state
document.addEventListener('mashup:search', () => renderSongs(store.getState().songs, store));

// "Find a Good Match" button
(function initFindMatch() {
  const btn = document.getElementById('find-match-btn');
  if (!btn) return;

  let active = false;

  btn.addEventListener('click', () => {
    if (active) {
      active = false;
      clearMatchFilter();
      return;
    }

    const state = store.getState();
    const mixerSongIds = new Set(state.mashup.tracks.map((t) => t.songId));
    const mixerSongs = state.mashup.tracks
      .map((t) => state.songs.find((s) => s.id === t.songId))
      .filter(Boolean);

    if (mixerSongs.length === 0) return;

    const targetBpm = state.mashup.bpm ?? 120;

    const matchIds = new Set();
    let goodCount = 0;
    let okCount = 0;

    for (const candidate of state.songs) {
      if (mixerSongIds.has(candidate.id)) continue; // already in mixer

      // BPM check — skip if hard limit exceeded for ALL mixer songs
      const bpmOk = mixerSongs.every((ms) => {
        if (!ms.bpm || !candidate.bpm) return true; // unknown = not disqualified
        return bpmStretchPct(candidate.bpm, targetBpm) <= 15;
      });
      if (!bpmOk) continue;

      // Key check — must be Camelot-compatible (distance ≤ 2) with ALL mixer songs
      const keyOk = mixerSongs.every((ms) => {
        if (ms.key == null || candidate.key == null) return true; // unknown = not disqualified
        return camelotDistance(ms.key, ms.mode, candidate.key, candidate.mode) <= 2;
      });
      if (!keyOk) continue;

      matchIds.add(candidate.id);

      // Count "great" matches separately for the label
      const isGreat = mixerSongs.every((ms) => {
        const keyGood = ms.key == null || candidate.key == null ||
          camelotDistance(ms.key, ms.mode, candidate.key, candidate.mode) <= 1;
        const bpmGood = !ms.bpm || !candidate.bpm ||
          bpmStretchPct(candidate.bpm, targetBpm) <= 10;
        const energyGood = ms.energy == null || candidate.energy == null ||
          Math.abs(ms.energy - candidate.energy) <= 0.25;
        const valenceGood = ms.valence == null || candidate.valence == null ||
          Math.abs(ms.valence - candidate.valence) <= 0.3;
        return keyGood && bpmGood && energyGood && valenceGood;
      });
      if (isGreat) goodCount++; else okCount++;
    }

    // Open the library drawer
    const drawer = document.getElementById('song-input-section');
    if (drawer) {
      drawer.classList.add('library-drawer--open');
      document.body.classList.add('library-open');
    }

    // Clear any existing search text so all matches are visible
    const searchInput = document.getElementById('song-search');
    if (searchInput && searchInput.value) {
      searchInput.value = '';
      searchInput.dispatchEvent(new Event('input'));
    }

    active = true;
    const total = goodCount + okCount;
    const label = total === 0
      ? 'No compatible songs found in library'
      : `${total} compatible song${total !== 1 ? 's' : ''} (${goodCount} great, ${okCount} good)`;
    setMatchFilter(matchIds, label);
  });

  // Keep button enabled/disabled in sync with mixer state
  store.subscribe((state) => {
    const hasTracks = state.mashup.tracks.length > 0;
    btn.disabled = !hasTracks;
    if (!hasTracks && active) {
      active = false;
      clearMatchFilter();
    }
  });
})();

// Subscribe to state changes
store.subscribe((state) => {
  renderSongs(state.songs, store);
  renderTracks(state.mashup.tracks, state.songs, store);
  renderTransport(state.mashup);
  renderGenerationUI(state.mashup, store);
});

(function initialRender() {
  const state = store.getState();
  renderSongs(state.songs, store);
  renderTracks(state.mashup.tracks, state.songs, store);
  renderTransport(state.mashup);
  renderGenerationUI(state.mashup, store);
})();

// Tab switcher for Library / Catalog
let _catalogInited = false;
document.querySelectorAll('.library-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.library-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    document.getElementById('library-panel').hidden = tab !== 'library';
    document.getElementById('catalog-panel').hidden = tab !== 'catalog';
    if (tab === 'catalog' && !_catalogInited) {
      _catalogInited = true;
      initCatalog(store);
    }
  });
});

// Handle URL hash navigation
function handleHash() {
  const hash = window.location.hash;
  if (hash === '#mixer') {
    document.getElementById('mixer-section')?.scrollIntoView({ behavior: 'smooth' });
  }
}

window.addEventListener('hashchange', handleHash);
if (window.location.hash) {
  // Delay to ensure DOM is ready
  setTimeout(handleHash, 100);
}

// Resize master waveform canvas to match its CSS width
function resizeWaveformCanvas() {
  const canvas = document.getElementById('master-waveform');
  if (canvas) {
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.floor(rect.width);
    canvas.height = Math.floor(rect.height);
  }
}

window.addEventListener('resize', resizeWaveformCanvas);
resizeWaveformCanvas();

// Library drawer toggle + hover-to-open
(function initLibraryDrawer() {
  const drawer    = document.getElementById('song-input-section');
  const backdrop  = document.getElementById('library-backdrop');
  const toggleBtn = document.getElementById('library-toggle-btn');
  const closeBtn  = document.getElementById('library-close-btn');
  const edgeTip   = document.getElementById('library-edge-trigger');
  if (!drawer) return;

  let closeTimer = null;

  function open() {
    clearTimeout(closeTimer);
    drawer.classList.add('library-drawer--open');
    document.body.classList.add('library-open');
  }
  function close() {
    drawer.classList.remove('library-drawer--open');
    document.body.classList.remove('library-open');
  }
  function scheduleClose() {
    clearTimeout(closeTimer);
    closeTimer = setTimeout(close, 320);
  }
  function cancelClose() {
    clearTimeout(closeTimer);
  }

  // Click toggle
  toggleBtn?.addEventListener('click', () =>
    drawer.classList.contains('library-drawer--open') ? close() : open()
  );
  backdrop?.addEventListener('click', close);
  closeBtn?.addEventListener('click', close);

  // Hover open: thin left-edge strip triggers open
  edgeTip?.addEventListener('mouseenter', open);
  edgeTip?.addEventListener('mouseleave', scheduleClose);

  // Keep open while mouse is inside the drawer
  drawer.addEventListener('mouseenter', cancelClose);
  drawer.addEventListener('mouseleave', scheduleClose);
})();

// Welcome message
console.log(
  '%c MashUp %c Music Component Mixer ',
  'background: #18181b; color: #fff; padding: 4px 8px; border-radius: 4px 0 0 4px; font-weight: bold;',
  'background: #0d9488; color: #fff; padding: 4px 8px; border-radius: 0 4px 4px 0;'
);
