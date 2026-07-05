/**
 * Mixer UI: column-per-track grid, drag-drop, transport, generate.
 */

import { playPause, stop } from './audio.js';
import { showToast, addSongToMixer } from './ui.js';
import {
  COMPONENTS,
  canGenerateMashup,
} from './constants/components.js';
import { startMashupGeneration } from './api.js';
import { initStemEditor } from './stem_editor.js';
import { generateMusicPrompt } from './prompt.js';
import {
  computeRelativeSuggestions,
  bpmStretchPct,
  keyCompatibility,
  vibeCompatibility,
  worstBpmStretch,
  safeBpmRange,
  smartDefaultBpm,
  toCamelot,
} from './compatibility.js';

let trackStructureSig = '';
let userSetBpm = false;

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
  store.updateMashup({ tracks: next.map((t, i) => ({ ...t, order: i })) });
}

function trackStructureKey(track) {
  const cc = [...(track.claimedComponents || [])].sort().join(',');
  return `${track.id}@${track.order}@${cc}`;
}

// Sequence number badges ①②③…
const SEQ_BADGES = ['①','②','③','④','⑤','⑥','⑦','⑧','⑨','⑩'];

// ── Grid builder ──────────────────────────────────────────────────────────────

// Matches track info cell in either layout (transposed or DJ)
const TRACK_CELL_SEL = '.mixer-grid__track-info, .mixer-grid__col-header';

function buildMixerGrid(sorted, songs, targetBpm, relativeSuggestions, djMode = false, djSettings = {}) {
  const grid = document.createElement('div');
  grid.className = 'mixer-grid';

  if (djMode) {
    // ── DJ Mode: original column-per-track layout ──────────────────────
    const headerRow = document.createElement('div');
    headerRow.className = 'mixer-grid__row mixer-grid__header-row';

    const corner = document.createElement('div');
    corner.className = 'mixer-grid__label mixer-grid__corner';
    headerRow.appendChild(corner);

    sorted.forEach((track, idx) => {
      const song = songs.find((s) => s.id === track.songId);
      const art = song?.albumArt || song?.thumbnail || '';
      const bpmPct = song?.bpm && targetBpm ? bpmStretchPct(song.bpm, targetBpm) : 0;
      const bpmCls = bpmPct > 15 ? 'bpm-stretch--bad' : bpmPct > 10 ? 'bpm-stretch--warn' : 'bpm-stretch--good';
      const camelot = toCamelot(song?.key ?? null, song?.mode ?? null);
      const keyBadge = camelot ? `<span class="mgcol__key">${escapeHtml(camelot)}</span>` : '';
      const bpmBadge = song?.bpm && targetBpm
        ? `<span class="mgcol__bpm ${bpmCls}">${song.bpm}→${targetBpm}${bpmPct > 0 ? ` (+${bpmPct}%)` : ''}</span>`
        : '';

      const col = document.createElement('div');
      col.className = 'mixer-grid__col-header';
      col.dataset.trackId = track.id;
      col.draggable = true;
      col.innerHTML = `
        <span class="mixer-grid__seq-badge">${SEQ_BADGES[idx] ?? idx + 1}</span>
        <div class="mgcol__thumb-wrap">
          ${art ? `<img class="mgcol__thumb" src="${escapeHtml(art)}" alt="" loading="lazy">` : `<div class="mgcol__thumb mgcol__thumb--empty"></div>`}
        </div>
        <div class="mgcol__info">
          <span class="mgcol__title" title="${escapeHtml(song?.title || '')}">${escapeHtml(song?.title || 'Unknown')}</span>
          ${song?.artist ? `<span class="mgcol__artist">${escapeHtml(song.artist)}</span>` : ''}
          <div class="mgcol__meta">${keyBadge}${bpmBadge}</div>
        </div>
        <div class="mgcol__controls">
          <input type="range" class="range-slider track-volume" min="0" max="100" value="${track.volume}" aria-label="Track volume">
          <div class="mgcol__btns">
            <button type="button" class="btn btn-icon track-mute ${track.muted ? 'is-active' : ''}" data-action="mute" title="Mute"><svg width="14" height="14"><use href="#icon-mute"/></svg></button>
            <button type="button" class="btn btn-icon track-solo ${track.solo ? 'is-active' : ''}" data-action="solo" title="Solo"><svg width="14" height="14"><use href="#icon-solo"/></svg></button>
            <button type="button" class="btn btn-icon track-remove" data-action="remove" title="Remove"><svg width="14" height="14"><use href="#icon-trash"/></svg></button>
          </div>
        </div>`;
      headerRow.appendChild(col);
    });

    grid.appendChild(headerRow);

    const { segmentDuration = 30, crossfadeDuration = 4, autoTiming = false, nSwaps = 4 } = djSettings;
    const settingsRow = document.createElement('div');
    settingsRow.className = 'mixer-grid__row mixer-grid__dj-settings';
    settingsRow.innerHTML = `
      <div class="mixer-grid__label mixer-grid__corner dj-settings__corner">
        <span class="dj-settings__label">DJ Settings</span>
      </div>
      <div class="dj-settings__body">
        <label class="dj-settings__field dj-settings__auto">
          <input type="checkbox" id="dj-auto-input" ${autoTiming ? 'checked' : ''}><span>Auto timing</span>
        </label>
        <label class="dj-settings__field ${autoTiming ? 'dj-settings__field--hidden' : ''}">
          <span>Segment</span>
          <input type="number" class="dj-input" id="dj-segment-input" min="5" max="300" step="5" value="${segmentDuration}">
          <span>sec</span>
        </label>
        <label class="dj-settings__field ${!autoTiming ? 'dj-settings__field--hidden' : ''}">
          <span>Swaps</span>
          <input type="number" class="dj-input" id="dj-swaps-input" min="2" max="20" step="1" value="${nSwaps}">
        </label>
        <label class="dj-settings__field">
          <span>Crossfade</span>
          <input type="number" class="dj-input" id="dj-crossfade-input" min="1" max="30" step="1" value="${crossfadeDuration}">
          <span>sec</span>
        </label>
      </div>`;
    grid.appendChild(settingsRow);

  } else {
    // ── Mashup Mode: transposed grid — tracks as rows, components as columns ──
    grid.classList.add('mixer-grid--transposed');
    grid.style.gridTemplateColumns = `240px repeat(${COMPONENTS.length}, minmax(52px, 1fr))`;

    // Header: corner + one label per component
    const corner = document.createElement('div');
    corner.className = 'mixer-grid__corner';
    grid.appendChild(corner);

    COMPONENTS.forEach(({ id: compId, label }) => {
      const hdr = document.createElement('div');
      hdr.className = 'mixer-grid__comp-header';
      hdr.dataset.componentId = compId;
      hdr.innerHTML = `<span>${escapeHtml(label)}</span>`;
      grid.appendChild(hdr);
    });

    // One row per track: track-info cell + component cells
    sorted.forEach((track, idx) => {
      const song = songs.find((s) => s.id === track.songId);
      const art = song?.albumArt || song?.thumbnail || '';
      const bpmPct = song?.bpm && targetBpm ? bpmStretchPct(song.bpm, targetBpm) : 0;
      const bpmCls = bpmPct > 15 ? 'bpm-stretch--bad' : bpmPct > 10 ? 'bpm-stretch--warn' : 'bpm-stretch--good';
      const camelot = toCamelot(song?.key ?? null, song?.mode ?? null);
      const keyBadge = camelot ? `<span class="mgcol__key">${escapeHtml(camelot)}</span>` : '';
      const bpmBadge = song?.bpm && targetBpm
        ? `<span class="mgcol__bpm ${bpmCls}">${song.bpm}→${targetBpm}${bpmPct > 0 ? ` (+${bpmPct}%)` : ''}</span>`
        : '';

      const infoCell = document.createElement('div');
      infoCell.className = 'mixer-grid__track-info';
      infoCell.dataset.trackId = track.id;
      infoCell.draggable = true;
      infoCell.innerHTML = `
        <div class="mgrow__thumb-wrap">
          ${art ? `<img class="mgrow__thumb" src="${escapeHtml(art)}" alt="" loading="lazy">` : `<div class="mgrow__thumb mgrow__thumb--empty"></div>`}
        </div>
        <div class="mgrow__body">
          <div class="mgrow__info">
            <span class="mgrow__title" title="${escapeHtml(song?.title || '')}">${escapeHtml(song?.title || 'Unknown')}</span>
            ${song?.artist ? `<span class="mgrow__artist">${escapeHtml(song.artist)}</span>` : ''}
            <div class="mgrow__meta">${keyBadge}${bpmBadge}</div>
          </div>
          <div class="mgrow__controls">
            <input type="range" class="range-slider track-volume" min="0" max="100" value="${track.volume}" aria-label="Track volume">
            <div class="mgrow__btns">
              <button type="button" class="btn btn-icon track-mute ${track.muted ? 'is-active' : ''}" data-action="mute" title="Mute"><svg width="14" height="14"><use href="#icon-mute"/></svg></button>
              <button type="button" class="btn btn-icon track-solo ${track.solo ? 'is-active' : ''}" data-action="solo" title="Solo"><svg width="14" height="14"><use href="#icon-solo"/></svg></button>
              <button type="button" class="btn btn-icon track-remove" data-action="remove" title="Remove"><svg width="14" height="14"><use href="#icon-trash"/></svg></button>
            </div>
          </div>
        </div>`;
      grid.appendChild(infoCell);

      COMPONENTS.forEach(({ id: compId, label: compLabel }) => {
        const claimed = (track.claimedComponents || []).includes(compId);
        const takenElsewhere = !claimed && sorted.some(
          (t) => t.id !== track.id && (t.claimedComponents || []).includes(compId)
        );
        const suggested = !claimed && !takenElsewhere &&
          (relativeSuggestions.get(track.id)?.has(compId) ?? false);

        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = [
          'mixer-grid__cell',
          claimed && 'mixer-grid__cell--on',
          takenElsewhere && 'mixer-grid__cell--taken',
          suggested && 'mixer-grid__cell--suggested',
        ].filter(Boolean).join(' ');
        cell.dataset.trackId = track.id;
        cell.dataset.componentId = compId;
        if (takenElsewhere) cell.disabled = true;
        cell.title = takenElsewhere ? 'Taken by another track'
          : suggested ? "Suggested for this song's energy and feel" : compLabel;
        cell.innerHTML = `<span class="mixer-grid__dot"></span>${suggested ? '<span class="mixer-grid__star">★</span>' : ''}`;
        grid.appendChild(cell);
      });
    });
  }

  return grid;
}

// ── Compatibility panel (above grid) ─────────────────────────────────────────

function renderCompatibilityPanel(trackedSongs, targetBpm) {
  let panel = document.getElementById('mixer-compat-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'mixer-compat-panel';
    panel.className = 'mixer-compat-panel';
    const tracksEl = document.getElementById('mixer-tracks');
    tracksEl?.parentNode?.insertBefore(panel, tracksEl);
  }

  if (trackedSongs.length < 2) { panel.hidden = true; return; }
  panel.hidden = false;

  const keyInfo = keyCompatibility(trackedSongs);
  const { pct: worstPct, worstSong } = worstBpmStretch(trackedSongs, targetBpm);
  const vibeInfo = vibeCompatibility(trackedSongs);

  const keyHtml = `<span class="mashup-key-badge ${keyInfo.colorClass}" title="${keyInfo.detail}">
    Key: ${keyInfo.detail || '—'} — ${keyInfo.label}
  </span>`;

  const hasBpmData = trackedSongs.some((s) => s.bpm);
  const bpmCls = worstPct > 15 ? 'compat--bad' : worstPct > 10 ? 'compat--warn' : 'compat--good';
  const bpmTitle = worstSong ? `${worstSong.title || ''} (${worstSong.bpm} BPM)` : '';
  let bpmLabel = worstPct > 15
    ? `BPM: ${worstPct}% stretch — exceeds quality limit`
    : worstPct > 10
    ? `BPM: ${worstPct}% stretch — borderline`
    : worstPct > 0
    ? `BPM: ${worstPct}% stretch`
    : 'BPM: perfect match';
  if (worstPct > 10) {
    const range = safeBpmRange(trackedSongs);
    if (range) bpmLabel += ` · Safe: ${range.min}–${range.max} BPM`;
  }
  const bpmHtml = hasBpmData
    ? `<span class="mashup-key-badge ${bpmCls}" title="${escapeHtml(bpmTitle)}">${bpmLabel}</span>`
    : '';

  const vibeHtml = vibeInfo
    ? `<span class="mashup-key-badge ${vibeInfo.colorClass}" title="${vibeInfo.detail}">Vibe: ${vibeInfo.label}</span>`
    : '';

  panel.innerHTML = keyHtml + bpmHtml + vibeHtml;
}

// ── renderTracks ──────────────────────────────────────────────────────────────

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

  renderCompatibilityPanel(trackedSongs, targetBpm);

  const trackSongPairs = sorted.map((t) => ({
    id: t.id,
    song: songs.find((s) => s.id === t.songId) || null,
  }));
  const relativeSuggestions = computeRelativeSuggestions(trackSongPairs);
  const djMode = !!state.mashup.djMode;
  const djAutoTiming = !!state.mashup.djAutoTiming;
  const structureSig = sorted.map(trackStructureKey).join('|') + `@bpm${targetBpm}@dj${djMode ? 1 : 0}@auto${djAutoTiming ? 1 : 0}`;

  if (sorted.length === 0) {
    trackStructureSig = '';
    container.querySelector('.mixer-grid')?.remove();
    empty?.removeAttribute('hidden');
    return;
  }

  empty?.setAttribute('hidden', '');

  if (structureSig !== trackStructureSig) {
    trackStructureSig = structureSig;
    container.querySelector('.mixer-grid')?.remove();
    const djSettings = {
      segmentDuration: state.mashup.djSegmentDuration ?? 30,
      crossfadeDuration: state.mashup.djCrossfadeDuration ?? 4,
      autoTiming: djAutoTiming,
      nSwaps: state.mashup.djNSwaps ?? 4,
    };
    container.appendChild(buildMixerGrid(sorted, songs, targetBpm, relativeSuggestions, djMode, djSettings));
    return;
  }

  // In-place updates: volume, mute, solo (avoid full rebuild for slider drags)
  sorted.forEach((track) => {
    const col = container.querySelector(`[data-track-id="${track.id}"]`);
    if (!col) return;
    const vol = col.querySelector('.track-volume');
    if (vol && document.activeElement !== vol) vol.value = String(track.volume);
    col.querySelector('.track-mute')?.classList.toggle('is-active', track.muted);
    col.querySelector('.track-solo')?.classList.toggle('is-active', track.solo);
  });
}

// ── Transport & generation UI ─────────────────────────────────────────────────

export function renderTransport(mashup) {
  const bpmInput = document.getElementById('bpm-input');
  if (bpmInput && document.activeElement !== bpmInput) {
    bpmInput.value = String(mashup.bpm ?? 120);
  }
  const master = document.getElementById('master-volume');
  const masterVol = mashup.masterVolume ?? 80;
  if (master && document.activeElement !== master) master.value = String(masterVol);
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
  const djMode = !!mashup.djMode;

  if (djMode) {
    if (tracks.length < 2) {
      hint.textContent = 'Add at least two songs to the mixer for DJ mode.';
    } else {
      const cf = mashup.djCrossfadeDuration ?? 4;
      if (mashup.djAutoTiming) {
        const swaps = mashup.djNSwaps ?? 4;
        hint.textContent = `DJ mode — ${tracks.length} tracks, auto timing (${swaps} swaps), ${cf}s crossfade.`;
      } else {
        const seg = mashup.djSegmentDuration ?? 30;
        hint.textContent = `DJ mode — ${tracks.length} tracks, ${seg}s segments, ${cf}s crossfade. Drag to reorder play sequence.`;
      }
    }
  } else if (tracks.length < 2) {
    hint.textContent = 'Add at least two songs to the mixer, then pick one source per row.';
  } else if (!tracks.every((t) => (t.claimedComponents || []).length > 0)) {
    hint.textContent = 'Each track must claim at least one component row.';
  } else if (!canGenerateMashup(tracks)) {
    hint.textContent = 'Fix overlapping components: each row can only come from one track.';
  } else {
    hint.textContent = 'Ready — generate the full mix or preview a 30-second sample.';
  }

  const busy = gen.status === 'queued' || gen.status === 'running';
  const canGen = djMode ? tracks.length >= 2 : canGenerateMashup(tracks);
  const isSample = !!gen.isSample;

  btn.disabled = busy || !canGen;
  btn.textContent = busy && !isSample ? 'Working…' : (djMode ? 'Generate DJ Mix' : 'Generate mashup');

  const sampleBtnEl = document.getElementById('sample-mashup-btn');
  if (sampleBtnEl) {
    sampleBtnEl.disabled = busy || !canGen;
    sampleBtnEl.textContent = busy && isSample ? 'Working…' : (djMode ? 'Sample DJ' : 'Sample');
  }

  const promptBtnEl = document.getElementById('prompt-mashup-btn');
  if (promptBtnEl) {
    const hasComponents = tracks.some(t => (t.claimedComponents || []).length > 0);
    promptBtnEl.disabled = !hasComponents;
  }

  // Voice replace buttons
  const voiceReplaceBtn = document.getElementById('voice-replace-btn');
  const generateVoiceBtn = document.getElementById('generate-voice-btn');
  const hasVoice = !!mashup.voiceId;
  const hasSingleTrack = tracks.length >= 1;
  if (voiceReplaceBtn) {
    voiceReplaceBtn.disabled = busy;
    voiceReplaceBtn.classList.toggle('voice-replace-btn--active', hasVoice);
    voiceReplaceBtn.title = hasVoice
      ? 'Voice recording ready — click to change or remove'
      : 'Record or upload your voice to replace the vocals';
  }
  if (generateVoiceBtn) {
    const canVoiceGen = hasVoice && hasSingleTrack;
    generateVoiceBtn.style.display = hasVoice ? 'inline-flex' : 'none';
    generateVoiceBtn.disabled = busy || !canVoiceGen;
    generateVoiceBtn.textContent = busy && gen.isSample === false && gen.status === 'running' ? 'Working…' : 'Generate with My Voice';
  }
  const vocalGainLabel = document.getElementById('vocal-gain-label');
  if (vocalGainLabel) vocalGainLabel.style.display = hasVoice ? 'inline-flex' : 'none';

  if (dl) {
    if (gen.status === 'done' && gen.resultUrl) {
      dl.dataset.resultUrl = gen.resultUrl;
      dl.style.display = 'inline-flex';
    } else {
      dl.style.display = 'none';
      delete dl.dataset.resultUrl;
    }
  }

  if (gen.status === 'idle') status.textContent = '';
  else if (gen.status === 'queued') status.textContent = 'Queued…';
  else if (gen.status === 'running') status.textContent = isSample ? 'Generating sample…' : 'Separating and mixing…';
  else if (gen.status === 'done') status.textContent = 'Done. Play from transport or download.';
  else if (gen.status === 'error') status.textContent = gen.error || 'Generation failed.';

  // ── Per-track analysis panel ─────────────────────────────────────────────
  let analysisEl = document.getElementById('generation-analysis');
  if (!analysisEl) {
    analysisEl = document.createElement('div');
    analysisEl.id = 'generation-analysis';
    analysisEl.className = 'generation-analysis';
    status.insertAdjacentElement('afterend', analysisEl);
  }

  const hasStemFiles = gen.stemFiles && Object.keys(gen.stemFiles).length > 0;

  // Analysis panel: only show when stem editor is not visible (stem editor shows metadata inline)
  const trackAnalysis = gen.trackAnalysis || [];
  if (gen.status === 'done' && trackAnalysis.length && !hasStemFiles) {
    const songs = store.getState().songs;
    const rows = trackAnalysis.map((entry) => {
      const track = tracks.find((t) => t.id === entry.track_id);
      const song = track ? songs.find((s) => s.id === track.songId) : null;
      const title = song?.title || entry.track_id;

      const camelot = toCamelot(entry.detected_key ?? null, entry.detected_mode ?? null);
      const keyStr = camelot
        ? `<span class="gen-analysis__key">${escapeHtml(camelot)}</span>`
        : '';

      const targetBpm = Math.round(mashup.bpm ?? 120);
      const bpmStr = entry.detected_bpm
        ? `<span class="gen-analysis__bpm">${Math.round(entry.detected_bpm)}→${targetBpm} BPM</span>`
        : '';

      const shift = entry.semitones_shifted ?? 0;
      const shiftWarn = Math.abs(shift) > 3 ? ' gen-analysis__shift--warn' : '';
      const shiftStr = `<span class="gen-analysis__shift${shiftWarn}">${shift > 0 ? '+' : ''}${shift}st</span>`;

      return `<div class="gen-analysis__track">
        <span class="gen-analysis__title" title="${escapeHtml(title)}">${escapeHtml(title)}</span>
        ${keyStr}${bpmStr}${shiftStr}
      </div>`;
    }).join('');

    analysisEl.innerHTML = rows;
    analysisEl.hidden = false;
  } else {
    analysisEl.hidden = true;
    analysisEl.innerHTML = '';
  }

  // ── Stem timeline editor — full-width, outside the flex actions row ──────────
  let stemEditorEl = document.getElementById('stem-editor-container');
  if (!stemEditorEl) {
    stemEditorEl = document.createElement('div');
    stemEditorEl.id = 'stem-editor-container';
    const generateBar = document.getElementById('mixer-generate-bar');
    (generateBar ?? analysisEl).insertAdjacentElement('afterend', stemEditorEl);
  }
  if (gen.status === 'done' && hasStemFiles) {
    initStemEditor(stemEditorEl, gen, mashup, store);
  } else {
    stemEditorEl.innerHTML = '';
  }
}

export function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space') return;
    const t = e.target;
    if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable) return;
    e.preventDefault();
    playPause();
  });
}

// ── initMixer ─────────────────────────────────────────────────────────────────

export function resetBpmOverride() {
  userSetBpm = false;
}

export function initMixer(store) {
  const playBtn = document.getElementById('play-btn');
  const stopBtn = document.getElementById('stop-btn');
  const bpmInput = document.getElementById('bpm-input');
  const master = document.getElementById('master-volume');
  const masterLabel = document.getElementById('master-volume-label');
  const mixerTracks = document.getElementById('mixer-tracks');
  const genBtn = document.getElementById('generate-mashup-btn');
  const sampleBtn = document.getElementById('sample-mashup-btn');
  const dlBtn = document.getElementById('download-mashup-btn');

  playBtn?.addEventListener('click', () => playPause());
  stopBtn?.addEventListener('click', () => stop());

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
    } catch {
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

  // BPM ÷2 / ×2 on transport
  function setTransportBpm(newBpm) {
    const v = Math.min(300, Math.max(40, Math.round(newBpm)));
    if (bpmInput) bpmInput.value = String(v);
    userSetBpm = true;
    store.updateMashup({ bpm: v });
  }
  document.getElementById('bpm-half-btn')?.addEventListener('click', () => {
    setTransportBpm((store.getState().mashup.bpm ?? 120) / 2);
  });
  document.getElementById('bpm-double-btn')?.addEventListener('click', () => {
    setTransportBpm((store.getState().mashup.bpm ?? 120) * 2);
  });

  // Tap Tempo — average interval across last 4 taps
  const _tapTimes = [];
  document.getElementById('bpm-tap-btn')?.addEventListener('click', () => {
    const now = Date.now();
    _tapTimes.push(now);
    if (_tapTimes.length > 4) _tapTimes.shift();
    if (_tapTimes.length >= 2) {
      const intervals = [];
      for (let i = 1; i < _tapTimes.length; i++) intervals.push(_tapTimes[i] - _tapTimes[i - 1]);
      const avgMs = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      setTransportBpm(60000 / avgMs);
    }
    // Reset if more than 2 seconds pass between taps
    setTimeout(() => {
      if (_tapTimes.length && Date.now() - _tapTimes[_tapTimes.length - 1] > 2000) _tapTimes.length = 0;
    }, 2100);
  });

  store.subscribe((state) => {
    if (userSetBpm) return;
    const trackedSongs = state.mashup.tracks
      .map((t) => state.songs.find((s) => s.id === t.songId))
      .filter(Boolean);
    const avg = smartDefaultBpm(trackedSongs);
    if (avg && avg !== (state.mashup.bpm ?? 120)) {
      store.updateMashup({ bpm: avg });
      if (bpmInput && document.activeElement !== bpmInput) bpmInput.value = String(avg);
    }
  });

  master?.addEventListener('input', () => {
    const v = Number(master.value);
    if (masterLabel) masterLabel.textContent = `${v}%`;
    store.updateMashup({ masterVolume: v });
  });

  genBtn?.addEventListener('click', () => startMashupGeneration(store));
  sampleBtn?.addEventListener('click', () => startMashupGeneration(store, { sample: true }));

  // Auto-assign: assign each component to the track that scores best for it
  const autoAssignBtn = document.getElementById('auto-assign-btn');
  autoAssignBtn?.addEventListener('click', () => {
    const state = store.getState();
    const sorted = sortedTracks(state.mashup.tracks);
    if (sorted.length === 0) return;

    const trackSongPairs = sorted.map((t) => ({
      id: t.id,
      song: state.songs.find((s) => s.id === t.songId) || null,
    }));

    // Clear all current assignments first (so exclusivity checks pass cleanly)
    sorted.forEach((t) => store.updateTrackComponents(t.id, []));

    const suggestions = computeRelativeSuggestions(trackSongPairs);
    // Track which components have been assigned
    const assigned = new Set();

    // Assign winning components per track
    for (const { id } of trackSongPairs) {
      const wins = [...(suggestions.get(id) || [])].filter((c) => !assigned.has(c));
      wins.forEach((c) => assigned.add(c));
      if (wins.length > 0) store.updateTrackComponents(id, wins);
    }

    // Any track with no assignments gets "other" as a fallback
    const freshTracks = store.getState().mashup.tracks;
    for (const t of freshTracks) {
      if ((t.claimedComponents || []).length === 0) {
        store.updateTrackComponents(t.id, ['other']);
      }
    }
    showToast('Components auto-assigned based on each song\'s energy and vibe.', 'info');
  });

  // Keep auto-assign button enabled only when there are tracks
  store.subscribe((state) => {
    if (!autoAssignBtn) return;
    autoAssignBtn.disabled = state.mashup.tracks.length === 0;
  });

  document.getElementById('karaoke-btn')?.addEventListener('click', async () => {
    const { openKaraokeModal } = await import('./voice.js');
    openKaraokeModal();
  });

  document.getElementById('voice-replace-btn')?.addEventListener('click', async () => {
    const { openVoiceModal } = await import('./voice.js');
    openVoiceModal();
  });

  document.getElementById('generate-voice-btn')?.addEventListener('click', () => {
    const gain = parseFloat(document.getElementById('vocal-gain-slider')?.value ?? '2');
    import('./api.js').then(({ startVoiceReplace }) => startVoiceReplace(store, { vocalGain: gain }));
  });

  // Vocal gain slider — live readout
  document.getElementById('vocal-gain-slider')?.addEventListener('input', (e) => {
    const v = parseFloat(e.target.value).toFixed(1);
    const label = document.getElementById('vocal-gain-value');
    if (label) label.textContent = v;
  });

  // DJ Mode toggle
  const djBtn = document.getElementById('dj-mode-btn');
  djBtn?.addEventListener('click', () => {
    const current = store.getState().mashup.djMode;
    store.updateMashup({ djMode: !current });
    djBtn.classList.toggle('dj-mode-btn--active', !current);
  });

  // Keep DJ Mode button enabled/disabled and active class in sync
  store.subscribe((state) => {
    if (!djBtn) return;
    const hasTracks = state.mashup.tracks.length >= 2;
    djBtn.disabled = !hasTracks;
    if (!hasTracks && state.mashup.djMode) {
      store.updateMashup({ djMode: false });
    }
    djBtn.classList.toggle('dj-mode-btn--active', !!state.mashup.djMode);
  });

  // DJ settings inputs (delegated — inputs live inside the grid)
  mixerTracks?.addEventListener('change', (e) => {
    if (e.target.id === 'dj-segment-input') {
      const v = Math.max(5, Math.min(300, Number(e.target.value) || 30));
      e.target.value = String(v);
      store.updateMashup({ djSegmentDuration: v });
    } else if (e.target.id === 'dj-crossfade-input') {
      const v = Math.max(1, Math.min(30, Number(e.target.value) || 4));
      e.target.value = String(v);
      store.updateMashup({ djCrossfadeDuration: v });
    } else if (e.target.id === 'dj-auto-input') {
      store.updateMashup({ djAutoTiming: e.target.checked });
    } else if (e.target.id === 'dj-swaps-input') {
      const v = Math.max(2, Math.min(20, Number(e.target.value) || 4));
      e.target.value = String(v);
      store.updateMashup({ djNSwaps: v });
    }
  });

  const promptBtn = document.getElementById('prompt-mashup-btn');
  const promptOverlay = document.getElementById('prompt-overlay');
  const promptText = document.getElementById('prompt-dialog-text');
  const promptCopy = document.getElementById('prompt-dialog-copy');
  const promptClose = document.getElementById('prompt-dialog-close');
  const promptCloseBtn = document.getElementById('prompt-dialog-close-btn');

  function closePromptModal() {
    if (promptOverlay) promptOverlay.hidden = true;
  }

  promptBtn?.addEventListener('click', () => {
    const prompt = generateMusicPrompt(store.getState());
    if (!prompt) { showToast('Select at least one component to generate a prompt.', 'info'); return; }
    if (promptText) promptText.value = prompt;
    if (promptOverlay) promptOverlay.hidden = false;
    promptText?.focus();
    promptText?.select();
  });

  promptClose?.addEventListener('click', closePromptModal);
  promptCloseBtn?.addEventListener('click', closePromptModal);
  promptOverlay?.addEventListener('click', (e) => { if (e.target === promptOverlay) closePromptModal(); });

  promptCopy?.addEventListener('click', async () => {
    const text = promptText?.value;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      promptCopy.textContent = 'Copied!';
      setTimeout(() => { if (promptCopy) promptCopy.textContent = 'Copy Prompt'; }, 2000);
    } catch {
      showToast('Copy failed — select all text and copy manually.', 'error');
    }
  });

  // ── Event delegation on mixer-tracks ────────────────────────────────

  // Component cell toggle
  mixerTracks?.addEventListener('click', async (e) => {
    // Component cell
    const cell = e.target.closest('.mixer-grid__cell');
    if (cell && !cell.disabled) {
      const trackId = cell.dataset.trackId;
      const compId = cell.dataset.componentId;
      if (trackId && compId) {
        const r = store.toggleTrackComponent(trackId, compId);
        if (!r.ok && r.reason === 'taken') {
          showToast('That component is already taken by another track.', 'info');
        }
      }
      return;
    }

    // Header buttons (mute / solo / remove)
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const col = btn.closest(TRACK_CELL_SEL);
    if (!col) return;
    const trackId = col.dataset.trackId;
    const action = btn.dataset.action;

    if (action === 'mute') {
      const tr = store.getState().mashup.tracks.find((t) => t.id === trackId);
      if (tr) store.updateTrack(trackId, { muted: !tr.muted });
    } else if (action === 'solo') {
      const tr = store.getState().mashup.tracks.find((t) => t.id === trackId);
      if (tr) store.updateTrack(trackId, { solo: !tr.solo });
    } else if (action === 'remove') {
      let ok = true;
      if (typeof window.showConfirm === 'function') {
        ok = await window.showConfirm('Remove this track from the mixer?', { title: 'Remove track' });
      }
      if (ok) { store.removeTrack(trackId); showToast('Track removed.', 'info'); }
    }
  });

  // Volume slider
  mixerTracks?.addEventListener('input', (e) => {
    const vol = e.target.closest('.track-volume');
    if (!vol) return;
    const col = vol.closest(TRACK_CELL_SEL);
    const trackId = col?.dataset.trackId;
    if (trackId) store.updateTrack(trackId, { volume: Number(vol.value) });
  });

  // Drag-to-reorder tracks
  let dragFromId = null;

  mixerTracks?.addEventListener('dragstart', (e) => {
    const col = e.target.closest(TRACK_CELL_SEL);
    if (!col) return;
    dragFromId = col.dataset.trackId;
    e.dataTransfer.effectAllowed = 'move';
    col.classList.add('mixer-col--dragging');
  });

  mixerTracks?.addEventListener('dragend', (e) => {
    e.target.closest(TRACK_CELL_SEL)?.classList.remove('mixer-col--dragging');
    dragFromId = null;
  });

  mixerTracks?.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = e.dataTransfer.types.includes('application/x-mashup-song-id')
      ? 'copy' : 'move';
  });

  mixerTracks?.addEventListener('drop', (e) => {
    e.preventDefault();
    const songId = e.dataTransfer.getData('application/x-mashup-song-id');
    if (songId) { addSongToMixer(store, songId); return; }
    const col = e.target.closest(TRACK_CELL_SEL);
    if (dragFromId && col?.dataset.trackId) {
      reorderTracks(store, dragFromId, col.dataset.trackId);
    }
  });
}
