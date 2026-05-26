/**
 * App entry point: wires together all modules.
 */

import { createStore } from './state.js';
import { setupSongInput, renderSongs, initSongSearch, setupToastListener } from './ui.js';
import { initMixer, renderTracks, renderTransport, renderGenerationUI, setupKeyboardShortcuts } from './mixer.js';
import { initAudio } from './audio.js';
import { initCatalog } from './catalog.js';

// Create the global store
const store = createStore();

// Setup toast listener (for events from components/mixer modules)
setupToastListener();

// Setup song input form and library search
setupSongInput(store);
initSongSearch();

// Initialize mixer (transport wiring)
initMixer(store);

// Wire result audio element and waveform animation
initAudio(store);

// Setup keyboard shortcuts (Space = play/pause)
setupKeyboardShortcuts();

// Search re-renders the song list without touching store state
document.addEventListener('mashup:search', () => renderSongs(store.getState().songs, store));

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

// Welcome message
console.log(
  '%c MashUp %c Music Component Mixer ',
  'background: #18181b; color: #fff; padding: 4px 8px; border-radius: 4px 0 0 4px; font-weight: bold;',
  'background: #0d9488; color: #fff; padding: 4px 8px; border-radius: 0 4px 4px 0;'
);
