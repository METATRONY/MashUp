/**
 * Mixer UI: tracks, drag-drop, component chips, transport, generate.
 */

import { playPause, stop } from './audio.js';
import { showToast, addSongToMixer } from './ui.js';
import {
  COMPONENTS,
  canGenerateMashup,
  componentsClaimedByOthers
} from './constants/components.js';
import { startMashupGeneration } from './api.js';
import {
  computeRelativeSuggestions,
  bpmStretchPct,
  keyCompatibility,
  worstBpmStretch,
  smartDefaultBpm
} from './compatibility.js';

let trackStructureSig = '';
let userSetBpm = false; // true once the user manually edits the BPM input

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function sortedTracks(tracks) {
  return [...tracks].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

function reorderTracks(store, fromId, toId) {
  if (fromId === toId) return;
  const state = store.getState();
  const sorted = sortedTracks(state.mashup.tracks);
  const fromIdx = sorted.findIndex((t) => t.id === fromId);
  const toIdx = sorted.findIndex((t) => t.id === toId);
  if (fromIdx < 0 || toIdx < 0) return;

  const next = [...sorted];
  const [moved] = next.splice(fromIdx, 1);
  next.splice(toIdx, 0, moved);

  store.updateMashup({
    tracks: next.map((t, i) => ({ ...t, order: i }))
  });
}

function trackStructureKey(track) {
  const cc = [...(track.claimedComponents || [])].sort().join(',');
  return `${track.id}@${track.order}@${cc}`;
}

function buildTrackRow(track, song, allTracks, targetBpm, suggested) {
  const row = document.createElement('div');
  row.className = 'mixer-track';
  row.draggable = true;
  row.dataset.trackId = track.id;

  const title = song?.title || 'Unknown';
  const vid = song?.videoId || '';
  const claimed = new Set(track.claimedComponents || []);
  const takenElsewhere = componentsClaimedByOthers(allTracks, track.id);

  const chipsHtml = COMPONENTS.map(({ id, label }) => {
    const isMine = claimed.has(id);
    const disabled = !isMine && takenElsewhere.has(id);
    const isSuggested = !isMine && !disabled && suggested.has(id);
    const cls = ['component-chip', 'btn', 'btn-sm'];
    if (isMine) cls.push('component-chip--active');
    if (disabled) cls.push('component-chip--disabled');
    if (isSuggested) cls.push('component-chip--suggested');
    const chipLabel = isSuggested ? `★ ${label}` : label;
    const chipTitle = disabled
      ? 'Taken by another track'
      : isSuggested
      ? `Suggested for this song's energy and feel`
      : label;
    return `<button type="button" class="${cls.join(' ')}" data-component-id="${id}" ${
      disabled ? 'disabled' : ''
    } title="${chipTitle}">${escapeHtml(chipLabel)}</button>`;
  }).join('');

  // BPM stretch indicator
  const songBpm = song?.bpm;
  let bpmRowHtml = '';
  if (songBpm && targetBpm) {
    const pct = bpmStretchPct(songBpm, targetBpm);
    const cls = pct > 30 ? 'bpm-stretch--bad' : pct > 15 ? 'bpm-stretch--warn' : 'bpm-stretch--good';
    const stretchLabel = pct > 0 ? ` (${pct > 0 ? '+' : ''}${pct}%)` : ' (no stretch)';
    bpmRowHtml = `<div class="track-bpm-row">
      <span class="track-bpm-row__icon">♩</span>
      <span class="track-bpm-row__value ${cls}">${songBpm} BPM → ${targetBpm} BPM${stretchLabel}</span>
    </div>`;
  }

  row.innerHTML = `
    <button type="button" class="mixer-track__handle" title="Drag to reorder" aria-label="Reorder track">
      <svg width="18" height="18"><use href="#icon-drag"/></svg>
    </button>
    <div class="mixer-track__body">
      <div class="mixer-track__main">
        <span class="mixer-track__title">${escapeHtml(title)}</span>
        <span class="mixer-track__id">${escapeHtml(vid)}</span>
      </div>
      ${bpmRowHtml}
      <div class="mixer-track__components" role="group" aria-label="Components from this track">
        <span class="mixer-track__components-label">Take</span>
        <div class="component-chip-row">${chipsHtml}</div>
      </div>
      <div class="mixer-track__controls">
        <div class="mixer-track__vol">
          <svg width="14" height="14" class="mixer-track__vol-icon"><use href="#icon-volume"/></svg>
          <input type="range" class="range-slider track-volume" min="0" max="100" value="${track.volume}" aria-label="Track volume">
        </div>
        <button type="button" class="btn btn-icon track-mute ${track.muted ? 'is-active' : ''}" data-action="mute" title="Mute">
          <svg width="18" height="18"><use href="#icon-mute"/></svg>
        </button>
        <button type="button" class="btn btn-icon track-solo ${track.solo ? 'is-active' : ''}" data-action="solo" title="Solo">
          <svg width="18" height="18"><use href="#icon-solo"/></svg>
        </button>
        <button type="button" class="btn btn-icon track-remove" data-action="remove" title="Remove from mixer">
          <svg width="18" height="18"><use href="#icon-trash"/></svg>
        </button>
      </div>
    </div>
  `;

  return row;
}

function renderCompatibilityPanel(trackedSongs, targetBpm) {
  let panel = document.getElementById('mixer-compat-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'mixer-compat-panel';
    panel.className = 'mixer-compat-panel';
    const tracksEl = document.getElementById('mixer-tracks');
    tracksEl?.parentNode?.insertBefore(panel, tracksEl);
  }

  if (trackedSongs.length < 2) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;

  const keyInfo = keyCompatibility(trackedSongs);
  const { pct: worstPct, worstSong } = worstBpmStretch(trackedSongs, targetBpm);

  const keyHtml = `<span class="mashup-key-badge ${keyInfo.colorClass}" title="${keyInfo.detail}">
    Key: ${keyInfo.detail || '—'} — ${keyInfo.label}
  </span>`;

  const bpmWarnHtml =
    worstPct > 30 && worstSong
      ? `<span class="bpm-warning">
          ⚠ "${escapeHtml(worstSong.title || '')}" (${worstSong.bpm} BPM) needs ${worstPct}% stretch — consider adjusting target BPM
        </span>`
      : '';

  panel.innerHTML = keyHtml + bpmWarnHtml;
}

export function renderTracks(tracks, songs, store) {
  const container = document.getElementById('mixer-tracks');
  const empty = document.getElementById('mixer-empty');
  if (!container) return;

  const sorted = sortedTracks(tracks);
  const state = store.getState();
  const targetBpm = state.mashup.bpm ?? 120;
  const trackedSongs = sorted
    .map((t) => songs.find((s) => s.id === t.songId))
    .filter(Boolean);

  // Always update the compatibility panel (cheap)
  renderCompatibilityPanel(trackedSongs, targetBpm);

  // Relative suggestions: ★ goes to whichever track scores BEST for each component
  const trackSongPairs = sorted.map((t) => ({ id: t.id, song: songs.find((s) => s.id === t.songId) || null }));
  const relativeSuggestions = computeRelativeSuggestions(trackSongPairs);

  const structureSig = sorted.map(trackStructureKey).join('|') + `@bpm${targetBpm}`;

  if (sorted.length === 0) {
    trackStructureSig = '';
    container.querySelectorAll('.mixer-track').forEach((el) => el.remove());
    empty?.removeAttribute('hidden');
    return;
  }

  empty?.setAttribute('hidden', '');

  if (structureSig !== trackStructureSig) {
    trackStructureSig = structureSig;
    container.querySelectorAll('.mixer-track').forEach((el) => el.remove());
    sorted.forEach((track) => {
      const song = songs.find((s) => s.id === track.songId);
      const suggested = relativeSuggestions.get(track.id) || new Set();
      container.appendChild(buildTrackRow(track, song, sorted, targetBpm, suggested));
    });
    return;
  }

  sorted.forEach((track) => {
    const row = container.querySelector(`[data-track-id="${track.id}"]`);
    if (!row) return;
    const vol = row.querySelector('.track-volume');
    if (vol && document.activeElement !== vol) vol.value = String(track.volume);
    row.querySelector('.track-mute')?.classList.toggle('is-active', track.muted);
    row.querySelector('.track-solo')?.classList.toggle('is-active', track.solo);
  });
}

export function renderTransport(mashup) {
  const bpmInput = document.getElementById('bpm-input');
  if (bpmInput && document.activeElement !== bpmInput) {
    bpmInput.value = String(mashup.bpm ?? 120);
  }

  const master = document.getElementById('master-volume');
  const masterVol = mashup.masterVolume ?? 80;
  if (master && document.activeElement !== master) {
    master.value = String(masterVol);
  }

  const label = document.getElementById('master-volume-label');
  if (label) label.textContent = `${Math.round(masterVol)}%`;

  const playBtn = document.getElementById('play-btn');
  if (playBtn) {
    playBtn.innerHTML = mashup.playing
      ? '<svg width="20" height="20"><use href="#icon-pause"/></svg>'
      : '<svg width="20" height="20"><use href="#icon-play"/></svg>';
    playBtn.title = mashup.playing ? 'Pause (Space)' : 'Play (Space)';
  }
}

export function renderGenerationUI(mashup, store) {
  const hint = document.getElementById('mixer-generate-hint');
  const btn = document.getElementById('generate-mashup-btn');
  const status = document.getElementById('generation-status');
  const dl = document.getElementById('download-mashup-btn');
  if (!hint || !btn || !status) return;

  const tracks = mashup.tracks || [];
  const gen = mashup.generation || { status: 'idle' };

  if (tracks.length < 2) {
    hint.textContent = 'Add at least two songs to the mixer, then assign components (each component only once across tracks).';
  } else if (!tracks.every((t) => (t.claimedComponents || []).length > 0)) {
    hint.textContent = 'Each track must claim at least one component. Components are exclusive—only one track may use Melody, Drums, etc.';
  } else if (!canGenerateMashup(tracks)) {
    hint.textContent = 'Fix overlapping components: each of the nine slots can only come from one track.';
  } else {
    hint.textContent =
      'When ready, generate a single mixed file from your selections. Processing runs on the server (Demucs stems; mapping is approximate).';
  }

  const busy = gen.status === 'queued' || gen.status === 'running';
  btn.disabled = busy || !canGenerateMashup(tracks);
  btn.textContent = busy ? 'Working…' : 'Generate mashup';

  if (gen.status === 'idle') status.textContent = '';
  else if (gen.status === 'queued') status.textContent = 'Queued…';
  else if (gen.status === 'running') status.textContent = 'Separating and mixing…';
  else if (gen.status === 'done') status.textContent = 'Done. Play from transport or download.';
  else if (gen.status === 'error') status.textContent = gen.error || 'Generation failed.';

  if (dl) {
    if (gen.status === 'done' && gen.resultUrl) {
      dl.dataset.resultUrl = gen.resultUrl;
      dl.style.display = 'inline-flex';
    } else {
      dl.style.display = 'none';
      delete dl.dataset.resultUrl;
    }
  }
}

export function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space') return;
    const t = e.target;
    if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable) {
      return;
    }
    e.preventDefault();
    playPause();
  });
}

export function initMixer(store) {
  const playBtn = document.getElementById('play-btn');
  const stopBtn = document.getElementById('stop-btn');
  const bpmInput = document.getElementById('bpm-input');
  const master = document.getElementById('master-volume');
  const masterLabel = document.getElementById('master-volume-label');
  const mixerTracks = document.getElementById('mixer-tracks');
  const genBtn = document.getElementById('generate-mashup-btn');
  const dlBtn = document.getElementById('download-mashup-btn');

  playBtn?.addEventListener('click', () => playPause());
  stopBtn?.addEventListener('click', () => stop());

  // Blob-based download so it works cross-origin (page on :8080, API on :8000)
  dlBtn?.addEventListener('click', async (e) => {
    e.preventDefault();
    const url = dlBtn.dataset.resultUrl;
    if (!url) return;
    try {
      dlBtn.textContent = 'Downloading…';
      const res = await fetch(url);
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = 'mashup.mp3';
      a.click();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 15000);
    } catch (err) {
      showToast('Download failed. Try right-clicking and Save As.', 'error');
    } finally {
      dlBtn.textContent = 'Download MP3';
    }
  });

  bpmInput?.addEventListener('change', () => {
    const v = Math.min(300, Math.max(40, Number(bpmInput.value) || 120));
    bpmInput.value = String(v);
    userSetBpm = true;
    store.updateMashup({ bpm: v });
  });

  // Auto-set BPM to the average of tracks' Spotify BPMs when user hasn't touched it
  store.subscribe((state) => {
    if (userSetBpm) return;
    const trackedSongs = state.mashup.tracks
      .map((t) => state.songs.find((s) => s.id === t.songId))
      .filter(Boolean);
    const avg = smartDefaultBpm(trackedSongs);
    if (avg && avg !== (state.mashup.bpm ?? 120)) {
      store.updateMashup({ bpm: avg });
      if (bpmInput && document.activeElement !== bpmInput) {
        bpmInput.value = String(avg);
      }
    }
  });

  master?.addEventListener('input', () => {
    const v = Number(master.value);
    if (masterLabel) masterLabel.textContent = `${v}%`;
    store.updateMashup({ masterVolume: v });
  });

  genBtn?.addEventListener('click', () => {
    startMashupGeneration(store);
  });

  mixerTracks?.addEventListener('click', async (e) => {
    const chip = e.target.closest('.component-chip');
    if (chip && mixerTracks.contains(chip)) {
      const row = chip.closest('.mixer-track');
      const trackId = row?.dataset.trackId;
      const compId = chip.dataset.componentId;
      if (trackId && compId) {
        const r = store.toggleTrackComponent(trackId, compId);
        if (!r.ok && r.reason === 'taken') {
          showToast('That component is already taken by another track.', 'info');
        }
      }
      return;
    }

    const row = e.target.closest('.mixer-track');
    if (!row) return;
    const trackId = row.dataset.trackId;
    const btn = e.target.closest('button');
    if (!btn || btn.classList.contains('mixer-track__handle')) return;

    if (btn.classList.contains('track-mute')) {
      const tr = store.getState().mashup.tracks.find((t) => t.id === trackId);
      if (tr) store.updateTrack(trackId, { muted: !tr.muted });
      return;
    }

    if (btn.classList.contains('track-solo')) {
      const tr = store.getState().mashup.tracks.find((t) => t.id === trackId);
      if (tr) store.updateTrack(trackId, { solo: !tr.solo });
      return;
    }

    if (btn.classList.contains('track-remove')) {
      let ok = true;
      if (typeof window.showConfirm === 'function') {
        ok = await window.showConfirm('Remove this track from the mixer?', { title: 'Remove track' });
      }
      if (ok) {
        store.removeTrack(trackId);
        showToast('Track removed.', 'info');
      }
    }
  });

  mixerTracks?.addEventListener('input', (e) => {
    const vol = e.target.closest('.track-volume');
    if (!vol) return;
    const row = vol.closest('.mixer-track');
    const trackId = row?.dataset.trackId;
    if (!trackId) return;
    store.updateTrack(trackId, { volume: Number(vol.value) });
  });

  mixerTracks?.addEventListener('dragstart', (e) => {
    if (e.target.closest('.component-chip')) {
      e.preventDefault();
      return;
    }
    const row = e.target.closest('.mixer-track');
    if (!row) return;
    e.dataTransfer.setData('application/x-track-id', row.dataset.trackId);
    e.dataTransfer.effectAllowed = 'move';
    row.classList.add('mixer-track--dragging');
  });

  mixerTracks?.addEventListener('dragend', (e) => {
    const row = e.target.closest('.mixer-track');
    row?.classList.remove('mixer-track--dragging');
  });

  mixerTracks?.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = e.dataTransfer.types.includes('application/x-mashup-song-id')
      ? 'copy'
      : 'move';
  });

  mixerTracks?.addEventListener('drop', (e) => {
    e.preventDefault();
    const songId = e.dataTransfer.getData('application/x-mashup-song-id');
    if (songId) {
      addSongToMixer(store, songId);
      return;
    }

    const fromId = e.dataTransfer.getData('application/x-track-id');
    const targetRow = e.target.closest('.mixer-track');
    if (fromId && targetRow?.dataset.trackId) {
      reorderTracks(store, fromId, targetRow.dataset.trackId);
    }
  });
}
