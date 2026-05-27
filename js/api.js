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
  return {
    bpm: state.mashup.bpm ?? 120,
    master_volume: (state.mashup.masterVolume ?? 80) / 100,
    sample,
    tracks: tracks.map((t) => {
      const song = state.songs.find((s) => s.id === t.songId);
      return {
        track_id: t.id,
        video_id: song?.videoId || '',
        components: t.claimedComponents || [],
        volume: (t.volume ?? 80) / 100,
        muted: !!t.muted,
        key: song?.key ?? null,
        mode: song?.mode ?? null
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
      store.setGeneration({
        status: 'done',
        jobId,
        resultUrl: url,
        error: null
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

export async function startMashupGeneration(store, { sample = false } = {}) {
  const state = store.getState();

  // Guard: prevent double-firing if a job is already in progress
  const { status } = state.mashup.generation;
  if (status === 'queued' || status === 'running') return;

  if (!canGenerateMashup(state.mashup.tracks)) {
    showToast('Add two or more tracks and assign exclusive components.', 'info');
    return;
  }

  store.setGeneration({ status: 'queued', jobId: null, resultUrl: null, error: null, isSample: sample });
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
