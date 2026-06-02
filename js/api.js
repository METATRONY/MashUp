/**
 * Mashup generation API (FastAPI backend).
 */

import { canGenerateMashup } from './constants/components.js';
import { showToast } from './ui.js';
import { setMashupResultUrl } from './audio.js';

function apiBase() {
  return window.MASHUP_API_BASE || 'http://127.0.0.1:8000';
}


function buildPayload(store, { sample = false } = {}) {
  const state = store.getState();
  const tracks = [...state.mashup.tracks].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  // Resolve solo: if any track is soloed, non-soloed tracks are effectively muted
  const anySolo = tracks.some(t => t.solo);

  const djMode = !!state.mashup.djMode;
  return {
    bpm: state.mashup.bpm ?? 120,
    master_volume: (state.mashup.masterVolume ?? 80) / 100,
    sample,
    mode: djMode ? 'dj' : 'mashup',
    segment_duration: state.mashup.djSegmentDuration ?? 30,
    crossfade_duration: state.mashup.djCrossfadeDuration ?? 4,
    dj_auto_timing: !!(state.mashup.djAutoTiming),
    dj_n_swaps: state.mashup.djNSwaps ?? 4,
    tracks: tracks.map((t) => {
      const song = state.songs.find((s) => s.id === t.songId);
      const effectiveMute = !!t.muted || (anySolo && !t.solo);
      return {
        track_id: t.id,
        video_id: song?.videoId || '',
        components: t.claimedComponents || [],
        volume: (t.volume ?? 80) / 100,
        muted: effectiveMute,
        key: song?.key ?? null,
        mode: song?.mode ?? null,
        hint_bpm: song?.bpm ?? null,
      };
    })
  };
}

async function pollJob(jobId, store) {
  const base = apiBase();
  const maxAttempts = 600;
  let attempt = 0;

  while (attempt < maxAttempts) {
    attempt += 1;
    const res = await fetch(`${base}/api/mashup/job/${jobId}`);
    if (!res.ok) {
      if (res.status === 404) {
        throw new Error('Job not found on server. Backend likely restarted; please generate again.');
      }
      throw new Error(`Status check failed (${res.status})`);
    }
    const data = await res.json();

    if (data.status === 'done' && data.download_url) {
      const url = data.download_url.startsWith('http') ? data.download_url : `${base}${data.download_url}`;
      // Prefix relative stem URLs with backend base so fetches go to the right origin
      const rawStemFiles = data.stem_files ?? {};
      const stemFiles = {};
      for (const [tid, stems] of Object.entries(rawStemFiles)) {
        stemFiles[tid] = {};
        for (const [sname, meta] of Object.entries(stems)) {
          stemFiles[tid][sname] = {
            ...meta,
            url: meta.url.startsWith('http') ? meta.url : `${base}${meta.url}`
          };
        }
      }
      store.setGeneration({
        status: 'done',
        jobId,
        resultUrl: url,
        error: null,
        trackAnalysis: data.track_analysis ?? [],
        stemFiles
      });
      setMashupResultUrl(url);
      showToast('Mashup ready. Press play or download.', 'success');
      return;
    }

    if (data.status === 'error') {
      throw new Error(data.error || 'Job failed');
    }

    await new Promise((r) => setTimeout(r, 2000));
  }

  throw new Error('Timed out waiting for mashup job.');
}

export function getTrackEdit(gen, trackId) {
  const e = gen.stemEdits?.[trackId];
  if (e && typeof e.offset === 'number') return e;
  return { offset: 0, start_trim: 0, end_trim: 0, volume: 1.0 };
}

export async function remixMashup(store) {
  const { generation: gen } = store.getState().mashup;
  if (!gen.jobId) return;
  store.setGeneration({ status: 'running' });
  try {
    const res = await fetch(`${apiBase()}/api/mashup/remix/${gen.jobId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ edits: gen.stemEdits ?? {} })
    });
    if (!res.ok) {
      let detail = `${res.status}`;
      try { const j = await res.json(); detail = j.detail || JSON.stringify(j); } catch { detail = await res.text().catch(() => detail); }
      throw new Error(`Remix failed: ${detail}`);
    }
    const data = await res.json();
    const url = data.download_url.startsWith('http')
      ? data.download_url
      : `${apiBase()}${data.download_url}`;
    store.setGeneration({ status: 'done', resultUrl: url });
    setMashupResultUrl(url);
    showToast('Remix ready.', 'success');
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    store.setGeneration({ status: 'error', error: message });
    showToast(message, 'error');
  }
}

export async function startVoiceReplace(store, {
  sample = false,
  vocalGain = 2.0,
  artistId = null,
  voiceIdOverride = null,
  pitchShift = 0,
} = {}) {
  const state = store.getState();
  const { status } = state.mashup.generation;
  if (status === 'queued' || status === 'running') return;

  const voiceId = voiceIdOverride ?? state.mashup.voiceId;

  if (!artistId && !voiceId) {
    showToast('Select an artist or record your voice first.', 'info');
    return;
  }

  const tracks = state.mashup.tracks;
  if (!tracks.length) { showToast('Add a song to the mixer first.', 'info'); return; }

  const firstTrack = [...tracks].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))[0];
  const song = state.songs.find((s) => s.id === firstTrack.songId);
  if (!song?.videoId) { showToast('Could not find a song to process.', 'info'); return; }

  store.setGeneration({ status: 'queued', jobId: null, resultUrl: null, error: null, isSample: sample, stemFiles: {}, stemEdits: {} });
  setMashupResultUrl(null);

  try {
    const base = apiBase();
    const body = {
      video_id: song.videoId,
      sample,
      hint_bpm: song.bpm ?? null,
      key: song.key ?? null,
      mode: song.mode ?? null,
      vocal_gain: vocalGain,
      pitch_shift: pitchShift,
    };
    if (artistId) {
      body.artist_id = artistId;
    } else {
      body.voice_id = voiceId;
    }

    const res = await fetch(`${base}/api/voice-replace`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      let msg = errText;
      try { const j = JSON.parse(errText); msg = j.detail || j.message || msg; } catch { /* use text */ }
      throw new Error(msg || `HTTP ${res.status}`);
    }

    const data = await res.json();
    if (!data.job_id) throw new Error('No job id returned');

    store.setGeneration({ status: 'running', jobId: data.job_id });
    await pollJob(data.job_id, store);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    store.setGeneration({ status: 'error', error: message, resultUrl: null });
    showToast(message, 'error');
  }
}

export async function startMashupGeneration(store, { sample = false } = {}) {
  const state = store.getState();

  // Guard: prevent double-firing if a job is already in progress
  const { status } = state.mashup.generation;
  if (status === 'queued' || status === 'running') return;

  const djMode = !!state.mashup.djMode;
  if (!djMode && !canGenerateMashup(state.mashup.tracks)) {
    showToast('Add two or more tracks and assign exclusive components.', 'info');
    return;
  }
  if (djMode && state.mashup.tracks.length < 2) {
    showToast('Add at least two tracks for DJ mode.', 'info');
    return;
  }

  store.setGeneration({ status: 'queued', jobId: null, resultUrl: null, error: null, isSample: sample, stemFiles: {}, stemEdits: {} });
  setMashupResultUrl(null);

  try {
    const base = apiBase();
    const payload = buildPayload(store, { sample });
    const res = await fetch(`${base}/api/mashup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const errText = await res.text();
      let msg = errText;
      try {
        const j = JSON.parse(errText);
        msg = j.detail || j.message || msg;
      } catch {
        /* use text */
      }
      throw new Error(msg || `HTTP ${res.status}`);
    }

    const data = await res.json();
    if (!data.job_id) throw new Error('No job id returned');

    store.setGeneration({ status: 'running', jobId: data.job_id });
    await pollJob(data.job_id, store);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    store.setGeneration({ status: 'error', error: message, resultUrl: null });
    showToast(message, 'error');
  }
}
