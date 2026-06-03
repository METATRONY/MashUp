/**
 * iMovie-style stem timeline editor — one clip per track.
 * All stems within a track are in sync; we only need to adjust timing between tracks.
 */

import { getTrackEdit, remixMashup } from './api.js';
import { showToast } from './ui.js';

function toCamelot(key, mode) {
  if (key == null) return null;
  const maj = ['8B','3B','10B','5B','12B','7B','2B','9B','4B','11B','6B','1B'];
  const min = ['5A','12A','7A','2A','9A','4A','11A','6A','1A','8A','3A','10A'];
  return mode === 1 ? maj[key] : min[key];
}

// "Cmaj" → "C", "Cmin" → "Cm", "C#maj" → "C#", "N" → "N"
function formatChord(name) {
  if (!name || name === 'N') return 'N';
  if (name.endsWith('min')) return name.slice(0, -3) + 'm';
  if (name.endsWith('maj')) return name.slice(0, -3);
  return name;
}

// ── Module-level state ────────────────────────────────────────────────────────

const _bufCache = new Map();       // url → ArrayBuffer
let _previewCtx = null;
let _rafPending = false;
let _pendingArgs = null;

// Playhead + seek state
let _playheadEl  = null;
let _playheadRaf = null;
let _timelineState = null; // { getPxPerSec, labelColWidth, tracksWrap }
let _seekTime  = 0;        // seconds — where next preview will start from
let _isPlaying = false;

// Store reference — always read latest gen from here instead of stale closures
let _store = null;

// ── ArrayBuffer cache ─────────────────────────────────────────────────────────

async function fetchCachedBuffer(url) {
  if (_bufCache.has(url)) return _bufCache.get(url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}`);
  const ab = await res.arrayBuffer();
  _bufCache.set(url, ab);
  return ab;
}

// ── Waveform drawing ──────────────────────────────────────────────────────────

/**
 * Build a Float32Array of per-column RMS values (max across all provided URLs).
 * Returns null if nothing could be decoded.
 */
async function buildRmsArray(urls, W) {
  if (!urls.length || !W) return null;
  const rms = new Float32Array(W);
  for (const url of urls) {
    try {
      const ab = await fetchCachedBuffer(url);
      const offCtx = new OfflineAudioContext(1, 1, 44100);
      const buf = await offCtx.decodeAudioData(ab.slice(0));
      const raw = buf.getChannelData(0);
      const sPerBucket = Math.max(1, Math.ceil(raw.length / W));
      for (let i = 0; i < W; i++) {
        let sq = 0;
        for (let j = 0; j < sPerBucket; j++) {
          const s = raw[i * sPerBucket + j] ?? 0;
          sq += s * s;
        }
        rms[i] = Math.max(rms[i], Math.sqrt(sq / sPerBucket));
      }
    } catch (_) { /* skip */ }
  }
  return rms;
}

/**
 * Draw the waveform canvas:
 *  - gray bars for excluded stems
 *  - teal bars + amber peaks for claimed stems
 */
async function drawMultiLayerWaveform(canvas, claimedUrls, excludedUrls) {
  try {
    const W = canvas.offsetWidth || canvas.width || 200;
    const H = canvas.offsetHeight || canvas.height || 40;
    canvas.width = W;
    canvas.height = H;

    const ctx2d = canvas.getContext('2d');
    ctx2d.clearRect(0, 0, W, H);

    // Excluded stems — dim gray
    if (excludedUrls.length) {
      const excRms = await buildRmsArray(excludedUrls, W);
      if (excRms) {
        ctx2d.fillStyle = 'rgba(160, 160, 160, 0.35)';
        for (let i = 0; i < W; i++) {
          const h = Math.max(1, Math.round(excRms[i] * H * 2.8));
          ctx2d.fillRect(i, H - h, 1, h);
        }
      }
    }

    // Claimed stems — bright teal
    if (claimedUrls.length) {
      const clmRms = await buildRmsArray(claimedUrls, W);
      if (clmRms) {
        ctx2d.fillStyle = '#5eead4';
        for (let i = 0; i < W; i++) {
          const h = Math.max(1, Math.round(clmRms[i] * H * 2.8));
          ctx2d.fillRect(i, H - h, 1, h);
        }
        // Amber peak spikes
        ctx2d.fillStyle = '#fbbf24';
        for (let i = 0; i < W; i++) {
          if (clmRms[i] > 0.7) {
            const h = Math.round(clmRms[i] * H);
            ctx2d.fillRect(i, H - h, 1, Math.min(h, 6));
          }
        }
      }
    }
  } catch (_) { /* waveform render failed silently */ }
}

// ── Playhead ──────────────────────────────────────────────────────────────────

function _cancelPlayheadAnim() {
  if (_playheadRaf) { cancelAnimationFrame(_playheadRaf); _playheadRaf = null; }
}

/** Full cleanup — removes element (use when editor is torn down). */
function stopPlayhead() {
  _cancelPlayheadAnim();
  if (_playheadEl) { _playheadEl.remove(); _playheadEl = null; }
}

/** Create or move the playhead to a static position (seconds). */
function setPlayheadPosition(time) {
  if (!_timelineState) return;
  const { getPxPerSec, labelColWidth, tracksWrap } = _timelineState;

  if (!_playheadEl) {
    _playheadEl = document.createElement('div');
    _playheadEl.className = 'stem-editor__playhead';
    tracksWrap.appendChild(_playheadEl);
  }
  _playheadEl.style.left = `${labelColWidth + time * getPxPerSec()}px`;
}

/**
 * Start animating the playhead from _seekTime.
 * ctx.currentTime - ctxStartTime gives elapsed since play start.
 */
function startPlayhead(ctx, ctxStartTime) {
  _cancelPlayheadAnim();
  if (!_timelineState) return;
  const { getPxPerSec, labelColWidth } = _timelineState;

  const tick = () => {
    if (!_previewCtx || ctx.state === 'closed') {
      _playheadRaf = null;
      _isPlaying = false;
      return; // keep playhead visible at final position
    }
    const elapsed = _seekTime + (ctx.currentTime - ctxStartTime);
    if (_playheadEl) _playheadEl.style.left = `${labelColWidth + elapsed * getPxPerSec()}px`;
    _playheadRaf = requestAnimationFrame(tick);
  };
  _playheadRaf = requestAnimationFrame(tick);
}

// ── Preview / stop ────────────────────────────────────────────────────────────

export function stopPreview() {
  _isPlaying = false;
  _cancelPlayheadAnim();
  if (_previewCtx) {
    _previewCtx.close().catch(() => {});
    _previewCtx = null;
  }
  // Keep playhead visible as a static position marker
  setPlayheadPosition(_seekTime);
}

async function previewStems() {
  // Always read the latest gen so we never use a stale closure copy of stemEdits
  const gen = _store ? _store.getState().mashup.generation : null;
  if (!gen) return;
  stopPreview();

  // Pause the transport player so it doesn't bleed into the Web Audio preview
  const transportEl = document.getElementById('mashup-result-audio');
  if (transportEl && !transportEl.paused) transportEl.pause();

  const startFrom = _seekTime;
  const ctx = new AudioContext();
  _previewCtx = ctx;
  _isPlaying = true;

  // ── Phase 1: fetch & decode ALL claimed stems in parallel ─────────────────
  // Must complete before scheduling so all nodes start from the same baseTime.
  // If we scheduled inside the fetch loop, fast-loading stems would start
  // before slow-loading ones, breaking relative timing (e.g. a 30-second
  // offset appears shorter than intended because baseTime already advanced).
  const decoded = []; // { edit, buf }
  const fetchJobs = [];
  for (const [tid, stems] of Object.entries(gen.stemFiles || {})) {
    const edit = getTrackEdit(gen, tid);
    for (const [, meta] of Object.entries(stems)) {
      if (meta.claimed === false) continue; // visual-only; skip in audio
      fetchJobs.push((async () => {
        try {
          const ab = await fetchCachedBuffer(meta.url);
          if (ctx.state === 'closed') return;
          const buf = await ctx.decodeAudioData(ab.slice(0));
          if (ctx.state === 'closed') return;
          decoded.push({ edit, buf });
        } catch (_) { /* missing stem — skip */ }
      })());
    }
  }
  await Promise.all(fetchJobs);
  if (ctx.state === 'closed') return;

  // ── Phase 2: schedule all nodes from a single future reference point ──────
  const baseTime = ctx.currentTime + 0.05; // 50 ms ahead — guaranteed future

  for (const { edit, buf } of decoded) {
    const startTrim    = Math.max(0, edit.start_trim);
    const endTrim      = Math.max(0, edit.end_trim);
    const offset       = edit.offset;
    const clipAudioStart = startTrim + Math.max(0, -offset);
    const clipStartInMix = Math.max(0, offset);
    const clipDuration   = Math.max(0.05, buf.duration - startTrim - endTrim);
    const clipEndInMix   = clipStartInMix + clipDuration;

    if (startFrom >= clipEndInMix) continue;

    const timeIntoClip  = Math.max(0, startFrom - clipStartInMix);
    const bufferOffset  = clipAudioStart + timeIntoClip;
    const remaining     = Math.max(0.05, clipDuration - timeIntoClip);
    const scheduleDelay = Math.max(0, clipStartInMix - startFrom);

    try {
      const node = ctx.createBufferSource();
      node.buffer = buf;
      const gain = ctx.createGain();
      gain.gain.value = Math.max(0, edit.volume);
      node.connect(gain).connect(ctx.destination);
      node.start(baseTime + scheduleDelay, bufferOffset, remaining);
    } catch (_) { /* skip */ }
  }

  startPlayhead(ctx, baseTime);

  // Debug: show what edits are actually being used for this preview
  const editSummary = Object.entries(gen.stemFiles || {}).map(([tid]) => {
    const e = getTrackEdit(gen, tid);
    return `${tid.slice(-5)}: +${e.offset.toFixed(1)}s`;
  }).join('  ');
  console.log('[preview] stemEdits:', JSON.stringify(gen.stemEdits));
  const t = _seekTime;
  const fromLabel = t > 0 ? ` from ${t < 60 ? `${Math.round(t)}s` : `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}`}` : '';
  showToast(`Preview${fromLabel} — ${editSummary}`, 'info');
}

// ── Track edit helpers ────────────────────────────────────────────────────────

function applyEdit(store, trackId, patch) {
  // Always read from store so concurrent edits on different tracks don't collide
  const gen = store.getState().mashup.generation;
  const current = getTrackEdit(gen, trackId);
  const updated = { ...current, ...patch };
  store.setGeneration({ stemEdits: { ...(gen.stemEdits || {}), [trackId]: updated } });
}

// ── Drag logic ────────────────────────────────────────────────────────────────

function _debugEditToast(store, trackId, songTitle) {
  const gen = store.getState().mashup.generation;
  const e = getTrackEdit(gen, trackId);
  showToast(
    `${songTitle}: start ${e.offset >= 0 ? '+' : ''}${e.offset.toFixed(1)}s | trim ${e.start_trim.toFixed(1)}–${e.end_trim.toFixed(1)}s | vol ${Math.round(e.volume * 100)}%`,
    'info'
  );
}

function makeDraggable(clipEl, trackDuration, edit, trackId, songTitle, pxPerSecGetter, onCommit, store) {
  // ── Body drag: moves clip in timeline (offset only) ──────────────────────────
  clipEl.addEventListener('mousedown', (e) => {
    if (e.target.classList.contains('stem-clip__handle')) return;
    e.preventDefault();
    const startX = e.clientX;
    const startOffset = edit.offset;
    const onMove = (mv) => {
      const delta = (mv.clientX - startX) / pxPerSecGetter();
      onCommit({ offset: Math.round(Math.max(0, startOffset + delta) * 10) / 10 });
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      _debugEditToast(store, trackId, songTitle);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  // ── Left handle: moves LEFT EDGE only (offset + start_trim move together)
  //    Right edge stays fixed. Drag right = trim more from start + delay start.
  //    Drag left = restore trimmed audio + move clip earlier.
  const leftHandle = clipEl.querySelector('.stem-clip__handle--left');
  if (leftHandle) {
    leftHandle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const startX      = e.clientX;
      const startTrim   = edit.start_trim;
      const startOffset = edit.offset;
      // How far right: can't trim more than leaves 0.5s of audio
      const maxDelta = trackDuration - startTrim - edit.end_trim - 0.5;
      // How far left: can't go below 0 for either trim or offset
      const minDelta = -Math.min(startTrim, startOffset);
      const onMove = (mv) => {
        const raw   = (mv.clientX - startX) / pxPerSecGetter();
        const delta = Math.round(Math.max(minDelta, Math.min(maxDelta, raw)) * 10) / 10;
        onCommit({
          start_trim: startTrim + delta,
          offset:     startOffset + delta,
        });
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        _debugEditToast(store, trackId, songTitle);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  // ── Right handle: moves RIGHT EDGE only (end_trim, offset unchanged) ─────────
  const rightHandle = clipEl.querySelector('.stem-clip__handle--right');
  if (rightHandle) {
    rightHandle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const startX    = e.clientX;
      const startTrim = edit.end_trim;
      const maxTrim   = trackDuration - edit.start_trim - 0.5;
      const onMove = (mv) => {
        const delta = (mv.clientX - startX) / pxPerSecGetter();
        onCommit({ end_trim: Math.round(Math.max(0, Math.min(maxTrim, startTrim - delta)) * 10) / 10 });
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        _debugEditToast(store, trackId, songTitle);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }
}

// ── Volume control: − [input] + ───────────────────────────────────────────────

function buildVolumeControl(wrap, edit, onCommit) {
  const pct = Math.round(edit.volume * 100);

  wrap.innerHTML = `
    <button class="stem-editor__vol-step" data-dir="-1" title="Decrease volume">−</button>
    <input  class="stem-editor__vol-input" type="number" min="0" max="150" step="5" value="${pct}">
    <span   class="stem-editor__vol-pct">%</span>
    <button class="stem-editor__vol-step" data-dir="1"  title="Increase volume">+</button>`;

  const input = wrap.querySelector('.stem-editor__vol-input');

  const commit = () => {
    const v = Math.max(0, Math.min(150, parseInt(input.value, 10) || 0));
    input.value = v;
    onCommit({ volume: v / 100 });
  };

  input.addEventListener('change', commit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(); });

  wrap.querySelectorAll('.stem-editor__vol-step').forEach((btn) => {
    btn.addEventListener('click', () => {
      const dir = parseInt(btn.dataset.dir, 10);
      input.value = Math.max(0, Math.min(150, (parseInt(input.value, 10) || 0) + dir * 5));
      commit();
    });
  });
}

// ── Timeline ruler ────────────────────────────────────────────────────────────

function buildRuler(rulerEl, totalDuration, pxPerSec, labelColWidth) {
  rulerEl.innerHTML = '';
  // Ticks are position:absolute — left is from ruler's left edge, so we add labelColWidth
  rulerEl.style.cursor = 'ew-resize';

  const step = totalDuration > 120 ? 30 : totalDuration > 60 ? 15 : totalDuration > 30 ? 10 : 5;
  for (let t = 0; t <= totalDuration; t += step) {
    const tick = document.createElement('div');
    tick.className = 'stem-editor__ruler-tick';
    tick.style.left = `${labelColWidth + t * pxPerSec}px`;
    rulerEl.appendChild(tick);

    const lbl = document.createElement('div');
    lbl.className = 'stem-editor__ruler-label';
    lbl.style.left = `${labelColWidth + t * pxPerSec}px`;
    lbl.textContent = t < 60 ? `${t}s` : `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
    rulerEl.appendChild(lbl);
  }
}

// ── Main entry point ──────────────────────────────────────────────────────────

export function initStemEditor(container, gen, mashup, store) {
  _store = store; // always keep fresh — read from here in previewStems

  const stemFiles = gen.stemFiles || {};
  if (!gen.jobId || Object.keys(stemFiles).length === 0) {
    stopPlayhead();
    container.innerHTML = '';
    return;
  }

  _pendingArgs = { gen, mashup, store };
  if (_rafPending) return;
  _rafPending = true;
  requestAnimationFrame(() => {
    _rafPending = false;
    const args = _pendingArgs;
    _pendingArgs = null;
    _buildEditor(container, args.gen, args.mashup, args.store);
  });
}

function _buildEditor(container, gen, mashup, store) {
  const stemFiles = gen.stemFiles || {};
  const tracks = mashup.tracks || [];
  const songs = store.getState().songs;

  const LABEL_COL_W = 210; // px for song-name + metadata label column

  // ── Per-track duration + waveform URLs (claimed + excluded) ──────────────────
  const trackMeta = {};
  for (const track of tracks) {
    const stems = stemFiles[track.id] || {};
    const claimedSet = new Set(track.claimedComponents || []);
    let duration = 0;
    const claimedUrls  = [];
    const excludedUrls = [];
    for (const [sname, meta] of Object.entries(stems)) {
      if (meta.duration > duration) duration = meta.duration;
      // Use backend "claimed" flag if present, else fall back to claimedComponents
      const isClaimed = meta.claimed !== undefined ? meta.claimed : claimedSet.has(sname);
      if (isClaimed) claimedUrls.push(meta.url);
      else excludedUrls.push(meta.url);
    }
    trackMeta[track.id] = { duration, claimedUrls, excludedUrls };
  }

  // ── Compute total timeline length ────────────────────────────────────────────
  let totalDuration = 10;
  for (const track of tracks) {
    const { duration } = trackMeta[track.id] || {};
    if (!duration) continue;
    const edit = getTrackEdit(gen, track.id);
    const clipEnd = edit.offset + Math.max(0, duration - edit.start_trim - edit.end_trim);
    if (clipEnd > totalDuration) totalDuration = clipEnd;
  }

  const laneWidth = Math.max(container.offsetWidth - LABEL_COL_W - 110, 200);
  let pxPerSec = laneWidth / totalDuration;
  const pxPerSecGetter = () => pxPerSec;

  // ── Build DOM ────────────────────────────────────────────────────────────────
  // Clear stale playhead reference (DOM about to be replaced)
  _playheadEl = null;
  container.innerHTML = '';

  const editor = document.createElement('div');
  editor.className = 'stem-editor';

  const rulerTop = document.createElement('div');
  rulerTop.className = 'stem-editor__ruler';
  editor.appendChild(rulerTop);

  const tracksWrap = document.createElement('div');
  tracksWrap.className = 'stem-editor__tracks';

  const orderedTracks = [...tracks].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const trackAnalysis = gen.trackAnalysis || [];
  const targetBpm = Math.round(mashup.bpm ?? 120);

  for (const track of orderedTracks) {
    const { duration: trackDuration, claimedUrls, excludedUrls } = trackMeta[track.id] || {};
    if (!trackDuration || (!claimedUrls?.length && !excludedUrls?.length)) continue;

    const song = songs.find((s) => s.id === track.songId);
    const songTitle = song?.title || track.id;
    const edit = getTrackEdit(gen, track.id);
    const analysis = trackAnalysis.find((e) => e.track_id === track.id);

    const row = document.createElement('div');
    row.className = 'stem-editor__row';

    // ── Row label: title + metadata badges ──────────────────────────────────
    const rowLabel = document.createElement('div');
    rowLabel.className = 'stem-editor__row-label';

    const titleEl = document.createElement('div');
    titleEl.className = 'stem-editor__row-title';
    titleEl.textContent = songTitle;
    titleEl.title = songTitle;
    rowLabel.appendChild(titleEl);

    if (analysis) {
      const metaEl = document.createElement('div');
      metaEl.className = 'stem-editor__row-meta';

      const camelot = toCamelot(analysis.detected_key ?? null, analysis.detected_mode ?? null);
      if (camelot) {
        const k = document.createElement('span');
        k.className = 'gen-analysis__key';
        k.textContent = camelot;
        metaEl.appendChild(k);
      }
      if (analysis.detected_bpm) {
        const b = document.createElement('span');
        b.className = 'gen-analysis__bpm';
        b.textContent = `${Math.round(analysis.detected_bpm)}→${targetBpm} BPM`;
        metaEl.appendChild(b);
      }
      const shift = analysis.semitones_shifted ?? 0;
      const st = document.createElement('span');
      st.className = `gen-analysis__shift${Math.abs(shift) > 3 ? ' gen-analysis__shift--warn' : ''}`;
      st.textContent = `${shift > 0 ? '+' : ''}${shift}st`;
      metaEl.appendChild(st);

      // Pitch nudge buttons (−1 / +1 semitone post-generation)
      const pitchDownBtn = document.createElement('button');
      pitchDownBtn.type = 'button';
      pitchDownBtn.className = 'btn btn-ghost stem-editor__pitch-btn';
      pitchDownBtn.title = 'Shift pitch down 1 semitone (re-render to apply)';
      pitchDownBtn.textContent = '−st';
      pitchDownBtn.addEventListener('click', () => {
        const cur = getTrackEdit(store.getState().mashup.generation, track.id);
        applyEdit(store, track.id, { pitch_shift: (cur.pitch_shift ?? 0) - 1 });
      });
      const pitchUpBtn = document.createElement('button');
      pitchUpBtn.type = 'button';
      pitchUpBtn.className = 'btn btn-ghost stem-editor__pitch-btn';
      pitchUpBtn.title = 'Shift pitch up 1 semitone (re-render to apply)';
      pitchUpBtn.textContent = '+st';
      pitchUpBtn.addEventListener('click', () => {
        const cur = getTrackEdit(store.getState().mashup.generation, track.id);
        applyEdit(store, track.id, { pitch_shift: (cur.pitch_shift ?? 0) + 1 });
      });
      metaEl.appendChild(pitchDownBtn);
      metaEl.appendChild(pitchUpBtn);

      rowLabel.appendChild(metaEl);

      if (analysis.midi_path) {
        const base = window.MASHUP_API_BASE || 'http://127.0.0.1:8000';
        const midiLink = document.createElement('a');
        midiLink.className = 'stem-editor__midi-link';
        midiLink.href = `${base}${analysis.midi_path}`;
        midiLink.download = '';
        midiLink.title = 'Download MIDI transcription for this track';
        midiLink.textContent = '↓ MIDI';
        rowLabel.appendChild(midiLink);
      }
    }

    row.appendChild(rowLabel);

    // ── Lane + clip ─────────────────────────────────────────────────────────
    const lane = document.createElement('div');
    lane.className = 'stem-editor__lane';
    lane.style.width = `${laneWidth}px`;

    // offset = when this track starts in the mix (timeline position)
    // start_trim / end_trim = how much audio is cut from each end (content trim)
    // Clip left = ONLY offset (not offset+start_trim — those are independent)
    const clipLeft  = Math.max(0, edit.offset * pxPerSec);
    const clipWidth = Math.max(8, (trackDuration - edit.start_trim - edit.end_trim) * pxPerSec);

    const clip = document.createElement('div');
    clip.className = 'stem-clip';
    clip.style.left  = `${clipLeft}px`;
    clip.style.width = `${clipWidth}px`;

    const leftHandle = document.createElement('div');
    leftHandle.className = 'stem-clip__handle stem-clip__handle--left';

    const waveCanvas = document.createElement('canvas');
    waveCanvas.className = 'stem-clip__waveform';

    const rightHandle = document.createElement('div');
    rightHandle.className = 'stem-clip__handle stem-clip__handle--right';

    clip.appendChild(leftHandle);
    clip.appendChild(waveCanvas);
    clip.appendChild(rightHandle);
    lane.appendChild(clip);

    // ── Chord markers ───────────────────────────────────────────────────────
    const chords = analysis?.chords;
    if (chords?.length) {
      chords.forEach(({ time_sec, chord }) => {
        if (time_sec < 0) return;
        const marker = document.createElement('div');
        marker.className = 'stem-editor__chord-marker';
        const isMinor = chord.endsWith('min');
        const isNone  = chord === 'N';
        marker.classList.add(isNone ? 'chord--none' : isMinor ? 'chord--minor' : 'chord--major');
        marker.style.left = `${time_sec * pxPerSec}px`;
        const label = document.createElement('span');
        label.className = 'stem-editor__chord-label';
        label.textContent = formatChord(chord);
        marker.appendChild(label);
        lane.appendChild(marker);
      });
    }

    // ── Start-time input ────────────────────────────────────────────────────
    const offsetWrap = document.createElement('div');
    offsetWrap.className = 'stem-editor__offset-wrap';
    offsetWrap.innerHTML = `
      <span class="stem-editor__offset-label">Start</span>
      <input class="stem-editor__offset-input" type="number"
             min="-300" max="300" step="0.5" value="${edit.offset.toFixed(1)}">
      <span class="stem-editor__offset-unit">s</span>`;

    const offsetInput = offsetWrap.querySelector('.stem-editor__offset-input');
    const commitOffset = () => {
      const v = Math.round((parseFloat(offsetInput.value) || 0) * 10) / 10;
      offsetInput.value = v.toFixed(1);
      applyEdit(store, track.id, { offset: v });
    };
    offsetInput.addEventListener('change', commitOffset);
    offsetInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') commitOffset(); });

    const volWrap = document.createElement('div');
    volWrap.className = 'stem-editor__vol-wrap';

    row.appendChild(lane);
    row.appendChild(offsetWrap);
    row.appendChild(volWrap);
    tracksWrap.appendChild(row);

    const onCommit = (patch) => applyEdit(store, track.id, patch);
    makeDraggable(clip, trackDuration, edit, track.id, songTitle, pxPerSecGetter, onCommit, store);
    buildVolumeControl(volWrap, edit, (patch) => onCommit(patch));

    // Async waveform after layout is in DOM
    const capClaimedUrls  = [...(claimedUrls  || [])];
    const capExcludedUrls = [...(excludedUrls || [])];
    requestAnimationFrame(() => {
      waveCanvas.width  = Math.round(clip.offsetWidth  || clipWidth);
      waveCanvas.height = Math.round(clip.offsetHeight || 80);
      drawMultiLayerWaveform(waveCanvas, capClaimedUrls, capExcludedUrls);
    });
  }

  editor.appendChild(tracksWrap);

  // Actions bar
  const actions = document.createElement('div');
  actions.className = 'stem-editor__actions';

  const previewBtn  = document.createElement('button');
  previewBtn.className = 'btn btn-secondary';
  previewBtn.textContent = '▶ Preview';

  const stopBtn = document.createElement('button');
  stopBtn.className = 'btn btn-secondary';
  stopBtn.textContent = '⏹ Stop';

  const rerenderBtn = document.createElement('button');
  rerenderBtn.className = 'btn btn-primary';
  rerenderBtn.textContent = 'Re-render with edits';

  const resetBtn = document.createElement('button');
  resetBtn.className = 'btn btn-secondary';
  resetBtn.textContent = 'Reset all';

  actions.appendChild(previewBtn);
  actions.appendChild(stopBtn);
  actions.appendChild(rerenderBtn);
  actions.appendChild(resetBtn);
  editor.appendChild(actions);

  container.appendChild(editor);

  // Measure actual lane left position for pixel-perfect ruler + playhead alignment
  const firstLane  = tracksWrap.querySelector('.stem-editor__lane');
  const editorRect = editor.getBoundingClientRect();
  const laneRect   = firstLane?.getBoundingClientRect();
  const laneOffset = (laneRect && editorRect.width > 0)
    ? Math.round(laneRect.left - editorRect.left)
    : LABEL_COL_W;

  _timelineState = { getPxPerSec: () => pxPerSec, labelColWidth: laneOffset, tracksWrap };
  buildRuler(rulerTop, totalDuration, pxPerSec, laneOffset);

  // Show static playhead at current seek position
  setPlayheadPosition(_seekTime);

  // ── Shared scrub logic ───────────────────────────────────────────────────────
  function startScrub(startClientX, startClientY) {
    const wasPlaying = _isPlaying;
    if (wasPlaying) {
      _isPlaying = false;
      _cancelPlayheadAnim();
      if (_previewCtx) { _previewCtx.close().catch(() => {}); _previewCtx = null; }
    }

    const getTimeFromX = (clientX) => {
      const twRect = tracksWrap.getBoundingClientRect();
      const x = clientX - twRect.left - laneOffset;
      return Math.max(0, Math.min(totalDuration, x / pxPerSec));
    };

    const onMove = (mv) => {
      _seekTime = getTimeFromX(mv.clientX);
      setPlayheadPosition(_seekTime);
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (wasPlaying) {
        previewStems().catch(() => {});
      }
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  // ── Ruler click/drag ─────────────────────────────────────────────────────────
  rulerTop.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const twRect = tracksWrap.getBoundingClientRect();
    const x = e.clientX - twRect.left - laneOffset;
    _seekTime = Math.max(0, Math.min(totalDuration, x / pxPerSec));
    setPlayheadPosition(_seekTime);
    startScrub(e.clientX, e.clientY);
  });

  // ── Playhead drag ─────────────────────────────────────────────────────────────
  if (_playheadEl) {
    _playheadEl.style.pointerEvents = 'auto';
    _playheadEl.style.cursor = 'ew-resize';
    _playheadEl.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      startScrub(e.clientX, e.clientY);
    });
  }

  // ── Button handlers ──────────────────────────────────────────────────────────
  previewBtn.addEventListener('click', async () => {
    _seekTime = 0;
    setPlayheadPosition(0);
    previewBtn.disabled = true;
    try { await previewStems(); } finally { previewBtn.disabled = false; }
  });

  stopBtn.addEventListener('click', () => {
    stopPreview();
    showToast('Preview stopped.', 'info');
  });

  rerenderBtn.addEventListener('click', async () => {
    rerenderBtn.disabled = true;
    rerenderBtn.textContent = 'Re-rendering…';
    stopPreview();
    try { await remixMashup(store); }
    finally {
      rerenderBtn.disabled = false;
      rerenderBtn.textContent = 'Re-render with edits';
    }
  });

  resetBtn.addEventListener('click', () => {
    store.setGeneration({ stemEdits: {} });
    showToast('Track edits reset.', 'info');
  });

  // Recompute pxPerSec on container resize
  const resizeObs = new ResizeObserver(() => {
    const newLaneWidth = Math.max(container.offsetWidth - LABEL_COL_W - 110, 200);
    pxPerSec = newLaneWidth / totalDuration;
  });
  resizeObs.observe(container);
}
