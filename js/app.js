/**
 * App entry point: wires together all modules.
 */

import { createStore } from './state.js';
import { setupSongInput, renderSongs, setupToastListener } from './ui.js';
import { initMixer, renderTracks, renderTransport, renderGenerationUI, setupKeyboardShortcuts } from './mixer.js';
import { initAudio } from './audio.js';

// Create the global store
const store = createStore();

// Setup toast listener (for events from components/mixer modules)
setupToastListener();

// Setup song input form
setupSongInput(store);

// Initialize mixer (transport wiring)
initMixer(store);

// YouTube IFrame API + playback sync (loads script; play still requires user gesture)
initAudio(store);

// Setup keyboard shortcuts (Space = play/pause)
setupKeyboardShortcuts();

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
