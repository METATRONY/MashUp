/**
 * App entry point: wires together all modules.
 */

import { createStore } from './state.js';
import { setupSongInput, renderSongs, setupToastListener, showToast } from './ui.js';
import { initMixer, renderTracks, renderTransport, setupKeyboardShortcuts } from './mixer.js';
import { initAudio } from './audio.js';

// Create the global store
const store = createStore();

// Initialize audio on first user interaction
let audioInitialized = false;

function ensureAudio() {
  if (!audioInitialized) {
    try {
      initAudio();
      audioInitialized = true;
    } catch (e) {
      console.warn('Audio init deferred:', e);
    }
  }
}

document.addEventListener('click', ensureAudio, { once: true });
document.addEventListener('keydown', ensureAudio, { once: true });

// Setup toast listener (for events from components/mixer modules)
setupToastListener();

// Setup song input form
setupSongInput(store);

// Initialize mixer
initMixer(store);

// Setup keyboard shortcuts (Space = play/pause)
setupKeyboardShortcuts();

// Subscribe to state changes
store.subscribe((state) => {
  renderSongs(state.songs, store);
  renderTracks(state.mashup.tracks, state.songs);
  renderTransport(state.mashup);
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
  'background: #7c3aed; color: white; padding: 4px 8px; border-radius: 4px 0 0 4px; font-weight: bold;',
  'background: #06b6d4; color: white; padding: 4px 8px; border-radius: 0 4px 4px 0;'
);
