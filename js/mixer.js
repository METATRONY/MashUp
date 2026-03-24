/**
 * Mixer panel: track rendering, transport, drag-drop, waveform visualization.
 */

import { getComponentInfo } from './components.js';
import {
  initAudio, playAll, stopAll, updateTrackParams,
  refreshAllTrackMutes, getAnalyser, getIsPlaying,
  getCurrentTime, setMasterVolume, generateComponentAudio
} from './audio.js';
import { extractComponents, waitForJob, getExtractedBuffer } from './api.js';

let store = null;
let trackBuffers = new Map(); // trackId -> AudioBuffer
let waveformRaf = null;
let timeRaf = null;

/**
 * Initialize the mixer panel with the store.
 */
export function initMixer(appStore) {
  store = appStore;
  setupTransport();
  setupDropZone();
  setupMasterVolume();
}

function setupTransport() {
  const playBtn = document.getElementById('play-btn');
  const stopBtn = document.getElementById('stop-btn');
  const bpmInput = document.getElementById('bpm-input');

  playBtn.addEventListener('click', () => togglePlayback());
  stopBtn.addEventListener('click', () => handleStop());

  bpmInput.addEventListener('change', (e) => {
    const bpm = Math.min(300, Math.max(40, parseInt(e.target.value) || 120));
    e.target.value = bpm;
    store.updateMashup({ bpm });
    // Regenerate buffers at new BPM if we have tracks
    regenerateBuffers();
  });
}

function setupMasterVolume() {
  const slider = document.getElementById('master-volume');
  const label = document.getElementById('master-volume-label');

  slider.addEventListener('input', (e) => {
    const vol = parseInt(e.target.value);
    label.textContent = vol + '%';
    setMasterVolume(vol / 100);
  });
}

function setupDropZone() {
  const mixerTracks = document.getElementById('mixer-tracks');

  mixerTracks.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    mixerTracks.classList.add('drag-over');
  });

  mixerTracks.addEventListener('dragleave', (e) => {
    if (!mixerTracks.contains(e.relatedTarget)) {
      mixerTracks.classList.remove('drag-over');
    }
  });

  mixerTracks.addEventListener('drop', (e) => {
    e.preventDefault();
    mixerTracks.classList.remove('drag-over');

    try {
      const data = JSON.parse(e.dataTransfer.getData('application/json'));
      addDroppedComponent(data);
    } catch (err) {
      console.warn('Invalid drop data:', err);
    }
  });
}

function addDroppedComponent(data) {
  const { songId, componentId, categoryColorName, label, songTitle } = data;
  const state = store.getState();

  // Check if already in mixer
  const existing = state.mashup.tracks.find(
    t => t.songId === songId && t.componentId === componentId
  );
  if (existing) {
    window.dispatchEvent(new CustomEvent('mashup:toast', {
      detail: { message: 'Component already in mixer', type: 'info' }
    }));
    return;
  }

  const trackId = `track-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  store.addTrack({
    id: trackId,
    songId,
    componentId,
    categoryColorName,
    label,
    songTitle,
    volume: 75,
    pan: 0,
    muted: false,
    soloed: false
  });

  window.dispatchEvent(new CustomEvent('mashup:toast', {
    detail: { message: `Added ${label} to mixer`, type: 'success' }
  }));
}

/**
 * Render all mixer tracks from state.
 */
export function renderTracks(tracks, songs) {
  const container = document.getElementById('mixer-tracks');
  const emptyState = document.getElementById('mixer-empty');

  if (tracks.length === 0) {
    container.innerHTML = '';
    container.appendChild(emptyState || createEmptyState());
    emptyState && (emptyState.style.display = '');
    return;
  }

  // Remove empty state
  const empty = container.querySelector('.mixer-empty-state');
  if (empty) empty.style.display = 'none';

  // Build a set of current track IDs
  const currentIds = new Set(tracks.map(t => t.id));

  // Remove rows no longer in state
  container.querySelectorAll('.track-row').forEach(row => {
    if (!currentIds.has(row.dataset.trackId)) {
      row.remove();
    }
  });

  // Add or update rows
  for (const track of tracks) {
    let row = container.querySelector(`[data-track-id="${track.id}"]`);
    if (!row) {
      row = createTrackRow(track);
      container.appendChild(row);
      ensureBuffer(track);
    } else {
      updateTrackRow(row, track);
    }
  }
}

function createEmptyState() {
  const div = document.createElement('div');
  div.className = 'mixer-empty-state';
  div.id = 'mixer-empty';
  div.innerHTML = `
    <svg width="48" height="48" class="empty-icon"><use href="#icon-waveform"/></svg>
    <p>Drag components here or click "Add to Mixer" to start building your mashup</p>
  `;
  return div;
}

function createTrackRow(track) {
  const row = document.createElement('div');
  row.className = 'track-row';
  row.dataset.trackId = track.id;
  if (track.muted) row.classList.add('muted');
  if (track.soloed) row.classList.add('soloed');

  row.innerHTML = `
    <div class="track-drag-handle">
      <svg width="16" height="16"><use href="#icon-drag"/></svg>
    </div>
    <div class="track-info">
      <div class="track-song-name">${escapeHtml(track.songTitle || 'Unknown')}</div>
      <span class="track-component-badge ${track.categoryColorName}">${escapeHtml(track.label)}</span>
    </div>
    <div class="track-waveform">
      <canvas width="200" height="36"></canvas>
    </div>
    <div class="track-volume">
      <input type="range" class="range-slider track-vol-slider" min="0" max="100" value="${track.volume}">
      <span class="track-volume-label">${track.volume}%</span>
    </div>
    <div class="track-pan">
      <span class="pan-label">L</span>
      <div class="pan-knob" title="Pan: center">
        <div class="pan-knob-indicator"></div>
      </div>
      <span class="pan-label">R</span>
    </div>
    <div class="track-buttons">
      <button class="mute-btn ${track.muted ? 'active' : ''}" title="Mute">M</button>
      <button class="solo-btn ${track.soloed ? 'active' : ''}" title="Solo">S</button>
    </div>
    <button class="track-remove" title="Remove track">
      <svg width="14" height="14"><use href="#icon-trash"/></svg>
    </button>
  `;

  // Volume slider
  const volSlider = row.querySelector('.track-vol-slider');
  const volLabel = row.querySelector('.track-volume-label');
  volSlider.addEventListener('input', (e) => {
    const vol = parseInt(e.target.value);
    volLabel.textContent = vol + '%';
    store.updateTrack(track.id, { volume: vol });
    if (getIsPlaying()) {
      updateTrackParams(track.id, { volume: vol }, store.getState().mashup.tracks);
    }
  });

  // Pan knob (click and drag)
  const panKnob = row.querySelector('.pan-knob');
  const panIndicator = row.querySelector('.pan-knob-indicator');
  let panDragging = false;
  let panStartY = 0;
  let panStartVal = track.pan;

  panKnob.addEventListener('mousedown', (e) => {
    panDragging = true;
    panStartY = e.clientY;
    panStartVal = store.getState().mashup.tracks.find(t => t.id === track.id)?.pan || 0;
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!panDragging) return;
    const delta = (panStartY - e.clientY) * 2;
    const newPan = Math.min(100, Math.max(-100, panStartVal + delta));
    const rotation = (newPan / 100) * 135;
    panIndicator.style.transform = `translateX(-50%) rotate(${rotation}deg)`;
    panKnob.title = `Pan: ${newPan > 0 ? 'R' + newPan : newPan < 0 ? 'L' + Math.abs(newPan) : 'C'}`;
    store.updateTrack(track.id, { pan: newPan });
    if (getIsPlaying()) {
      updateTrackParams(track.id, { pan: newPan }, store.getState().mashup.tracks);
    }
  });

  document.addEventListener('mouseup', () => { panDragging = false; });

  // Double-click pan knob to reset
  panKnob.addEventListener('dblclick', () => {
    panIndicator.style.transform = 'translateX(-50%) rotate(0deg)';
    panKnob.title = 'Pan: C';
    store.updateTrack(track.id, { pan: 0 });
    if (getIsPlaying()) {
      updateTrackParams(track.id, { pan: 0 }, store.getState().mashup.tracks);
    }
  });

  // Mute
  const muteBtn = row.querySelector('.mute-btn');
  muteBtn.addEventListener('click', () => {
    const current = store.getState().mashup.tracks.find(t => t.id === track.id);
    if (!current) return;
    store.updateTrack(track.id, { muted: !current.muted });
    if (getIsPlaying()) {
      refreshAllTrackMutes(store.getState().mashup.tracks);
    }
  });

  // Solo
  const soloBtn = row.querySelector('.solo-btn');
  soloBtn.addEventListener('click', () => {
    const current = store.getState().mashup.tracks.find(t => t.id === track.id);
    if (!current) return;
    store.updateTrack(track.id, { soloed: !current.soloed });
    if (getIsPlaying()) {
      refreshAllTrackMutes(store.getState().mashup.tracks);
    }
  });

  // Remove
  const removeBtn = row.querySelector('.track-remove');
  removeBtn.addEventListener('click', () => {
    store.removeTrack(track.id);
    trackBuffers.delete(track.id);
    if (getIsPlaying()) {
      // Re-play without this track
      const state = store.getState();
      if (state.mashup.tracks.length > 0) {
        playAll(state.mashup.tracks, trackBuffers);
      } else {
        handleStop();
      }
    }
  });

  // Draw initial waveform placeholder
  drawTrackWaveformPlaceholder(row.querySelector('.track-waveform canvas'), track.categoryColorName);

  return row;
}

function updateTrackRow(row, track) {
  row.classList.toggle('muted', track.muted);
  row.classList.toggle('soloed', track.soloed);

  const muteBtn = row.querySelector('.mute-btn');
  const soloBtn = row.querySelector('.solo-btn');
  muteBtn.classList.toggle('active', track.muted);
  soloBtn.classList.toggle('active', track.soloed);
}

function drawTrackWaveformPlaceholder(canvas, colorName) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const colors = {
    amber: '#f59e0b',
    cyan: '#06b6d4',
    green: '#10b981',
    purple: '#7c3aed'
  };
  const color = colors[colorName] || colors.purple;

  ctx.fillStyle = color + '40';
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();

  for (let x = 0; x < w; x++) {
    const y = h / 2 + Math.sin(x * 0.05) * (h * 0.3) * Math.sin(x * 0.01 + 1);
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

async function ensureBuffer(track) {
  if (trackBuffers.has(track.id)) return;
  const bpm = store.getState().mashup.bpm;
  try {
    initAudio();
    const buffer = generateComponentAudio(track.componentId, bpm);
    trackBuffers.set(track.id, buffer);
    drawTrackWaveformFromBuffer(track);
  } catch (e) {
    console.error('Buffer generation failed:', e);
  }
}

function drawTrackWaveformFromBuffer(track) {
  const buffer = trackBuffers.get(track.id);
  if (!buffer) return;

  const container = document.querySelector(`[data-track-id="${track.id}"]`);
  if (!container) return;

  const canvas = container.querySelector('.track-waveform canvas');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const data = buffer.getChannelData(0);
  const step = Math.floor(data.length / w);

  const colors = {
    amber: '#f59e0b',
    cyan: '#06b6d4',
    green: '#10b981',
    purple: '#7c3aed'
  };
  const color = colors[track.categoryColorName] || colors.purple;

  ctx.fillStyle = color + '30';
  ctx.strokeStyle = color + '80';
  ctx.lineWidth = 1;

  ctx.beginPath();
  ctx.moveTo(0, h / 2);

  for (let x = 0; x < w; x++) {
    let min = 1, max = -1;
    const start = x * step;
    for (let j = 0; j < step && start + j < data.length; j++) {
      const val = data[start + j];
      if (val < min) min = val;
      if (val > max) max = val;
    }
    const yMin = ((1 + min) / 2) * h;
    const yMax = ((1 + max) / 2) * h;
    ctx.fillRect(x, yMax, 1, yMin - yMax || 1);
  }

  // Center line
  ctx.strokeStyle = color + '40';
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();
}

async function regenerateBuffers() {
  const bpm = store.getState().mashup.bpm;
  const wasPlaying = getIsPlaying();
  if (wasPlaying) stopAll();

  initAudio();
  const tracks = store.getState().mashup.tracks;
  for (const track of tracks) {
    const buffer = generateComponentAudio(track.componentId, bpm);
    trackBuffers.set(track.id, buffer);
    drawTrackWaveformFromBuffer(track);
  }

  if (wasPlaying && tracks.length > 0) {
    playAll(tracks, trackBuffers);
    store.updateMashup({ playing: true });
  }
}

function togglePlayback() {
  const state = store.getState();
  if (getIsPlaying()) {
    stopAll();
    store.updateMashup({ playing: false });
    updatePlayButton(false);
    stopTimeUpdate();
    stopWaveformAnimation();
  } else {
    if (state.mashup.tracks.length === 0) {
      window.dispatchEvent(new CustomEvent('mashup:toast', {
        detail: { message: 'Add some tracks to the mixer first', type: 'info' }
      }));
      return;
    }
    // Ensure all buffers exist
    for (const track of state.mashup.tracks) {
      if (!trackBuffers.has(track.id)) {
        initAudio();
        const buffer = generateComponentAudio(track.componentId, state.mashup.bpm);
        trackBuffers.set(track.id, buffer);
      }
    }
    playAll(state.mashup.tracks, trackBuffers);
    store.updateMashup({ playing: true });
    updatePlayButton(true);
    startTimeUpdate();
    startWaveformAnimation();
  }
}

function handleStop() {
  stopAll();
  store.updateMashup({ playing: false, currentTime: 0 });
  updatePlayButton(false);
  stopTimeUpdate();
  stopWaveformAnimation();
  document.getElementById('time-display').textContent = '0:00.0';
  clearMasterWaveform();
}

function updatePlayButton(playing) {
  const btn = document.getElementById('play-btn');
  btn.classList.toggle('playing', playing);
  btn.innerHTML = playing
    ? '<svg width="20" height="20"><use href="#icon-pause"/></svg>'
    : '<svg width="20" height="20"><use href="#icon-play"/></svg>';
  btn.title = playing ? 'Pause (Space)' : 'Play (Space)';
}

function startTimeUpdate() {
  const display = document.getElementById('time-display');
  const update = () => {
    const t = getCurrentTime();
    const mins = Math.floor(t / 60);
    const secs = Math.floor(t % 60);
    const tenths = Math.floor((t * 10) % 10);
    display.textContent = `${mins}:${secs.toString().padStart(2, '0')}.${tenths}`;
    timeRaf = requestAnimationFrame(update);
  };
  timeRaf = requestAnimationFrame(update);
}

function stopTimeUpdate() {
  if (timeRaf) {
    cancelAnimationFrame(timeRaf);
    timeRaf = null;
  }
}

function startWaveformAnimation() {
  const canvas = document.getElementById('master-waveform');
  const ctx = canvas.getContext('2d');
  const analyser = getAnalyser();
  if (!analyser) return;

  const bufferLength = analyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);

  const draw = () => {
    waveformRaf = requestAnimationFrame(draw);
    analyser.getByteTimeDomainData(dataArray);

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    // Background grid
    ctx.strokeStyle = '#2d2d4420';
    ctx.lineWidth = 1;
    for (let y = 0; y < h; y += 20) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    // Waveform
    const gradient = ctx.createLinearGradient(0, 0, w, 0);
    gradient.addColorStop(0, '#7c3aed');
    gradient.addColorStop(0.5, '#06b6d4');
    gradient.addColorStop(1, '#10b981');

    ctx.lineWidth = 2;
    ctx.strokeStyle = gradient;
    ctx.beginPath();

    const sliceWidth = w / bufferLength;
    let x = 0;

    for (let i = 0; i < bufferLength; i++) {
      const v = dataArray[i] / 128.0;
      const y = (v * h) / 2;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      x += sliceWidth;
    }

    ctx.lineTo(w, h / 2);
    ctx.stroke();

    // Glow effect
    ctx.lineWidth = 6;
    ctx.globalAlpha = 0.15;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 2;

    // Center line
    ctx.strokeStyle = '#2d2d4460';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();
  };

  waveformRaf = requestAnimationFrame(draw);
}

function stopWaveformAnimation() {
  if (waveformRaf) {
    cancelAnimationFrame(waveformRaf);
    waveformRaf = null;
  }
}

function clearMasterWaveform() {
  const canvas = document.getElementById('master-waveform');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

/**
 * Render the transport bar state.
 */
export function renderTransport(mashup) {
  const bpmInput = document.getElementById('bpm-input');
  if (document.activeElement !== bpmInput) {
    bpmInput.value = mashup.bpm;
  }
  updatePlayButton(mashup.playing);
}

// Keyboard shortcut
export function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    // Don't trigger when typing in inputs
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    if (e.code === 'Space') {
      e.preventDefault();
      togglePlayback();
    }
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
