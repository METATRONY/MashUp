/**
 * Exported mashup audio playback: result MP3 player, transport clock, waveform.
 *
 * YouTube IFrame embeds have been removed — preview playback now comes from
 * the backend-generated MP3 after stems are separated and mixed.
 */

import { showToast } from './ui.js';

let storeRef = null;
let rafId = 0;

function getResultAudio() {
  return document.getElementById('mashup-result-audio');
}

/**
 * @param {string | null} url
 */
export function setMashupResultUrl(url) {
  const a = getResultAudio();
  if (!a) return;
  if (url) {
    a.src = url;
    a.crossOrigin = 'anonymous';
  } else {
    a.pause();
    a.removeAttribute('src');
    a.load();
    const slider = document.getElementById('seek-slider');
    const row = document.getElementById('seek-row');
    if (slider) { slider.value = '0'; slider.disabled = true; }
    if (row) row.setAttribute('hidden', '');
  }
}

function hasResult() {
  const g = storeRef?.getState().mashup.generation;
  return g?.status === 'done' && !!g?.resultUrl;
}

export function initAudio(store) {
  storeRef = store;
  const ra = getResultAudio();
  ra?.addEventListener('ended', () => {
    if (!storeRef) return;
    storeRef.updateMashup({ playing: false });
    stopClock();
  });

  ra?.addEventListener('loadedmetadata', () => {
    const slider = document.getElementById('seek-slider');
    const durEl = document.getElementById('seek-duration');
    const row = document.getElementById('seek-row');
    const dur = ra.duration;
    if (slider) {
      slider.max = String(isFinite(dur) ? dur : 100);
      slider.value = '0';
      slider.disabled = false;
    }
    if (durEl) durEl.textContent = isFinite(dur) ? formatTime(dur) : '';
    if (row) row.removeAttribute('hidden');
  });

  ra?.addEventListener('timeupdate', () => {
    const slider = document.getElementById('seek-slider');
    if (slider && document.activeElement !== slider) {
      slider.value = String(ra.currentTime);
    }
  });

  document.getElementById('seek-slider')?.addEventListener('input', (e) => {
    const audio = getResultAudio();
    if (audio) audio.currentTime = Number(e.target.value);
  });

  tickWaveform();
}

export function playPause() {
  if (!storeRef) return;
  const resultEl = getResultAudio();

  if (!hasResult() || !resultEl) {
    showToast('Generate a mashup first, then press play.', 'info');
    return;
  }

  const state = storeRef.getState();
  if (state.mashup.playing) {
    resultEl.pause();
    storeRef.updateMashup({ playing: false });
    stopClock();
  } else {
    resultEl.play().catch(() => {
      showToast('Could not play the exported mashup.', 'error');
    });
    storeRef.updateMashup({ playing: true });
    startClock();
  }
}

export function stop() {
  if (!storeRef) return;
  const resultEl = getResultAudio();
  if (resultEl) {
    try {
      resultEl.pause();
      resultEl.currentTime = 0;
    } catch {
      /* ignore */
    }
  }
  storeRef.updateMashup({ playing: false, currentTime: 0 });
  stopClock();
  const el = document.getElementById('time-display');
  if (el) el.textContent = formatTime(0);
  const seekSlider = document.getElementById('seek-slider');
  if (seekSlider) seekSlider.value = '0';
}

function pickTimeSource() {
  const resultEl = getResultAudio();
  if (hasResult() && resultEl && !Number.isNaN(resultEl.currentTime)) {
    return resultEl.currentTime;
  }
  return 0;
}

function formatTime(sec) {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  const tenth = Math.floor((r % 1) * 10);
  const rs = Math.floor(r);
  return `${m}:${String(rs).padStart(2, '0')}.${tenth}`;
}

function tickWaveform() {
  const canvas = document.getElementById('master-waveform');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  const t = performance.now() / 1000;
  const playing = storeRef?.getState().mashup.playing;

  ctx.fillStyle =
    getComputedStyle(document.documentElement).getPropertyValue('--bg-muted').trim() || '#f4f4f5';
  ctx.fillRect(0, 0, w, h);

  const grad = ctx.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, 'rgba(109, 40, 217, 0.35)');
  grad.addColorStop(0.5, 'rgba(13, 148, 136, 0.4)');
  grad.addColorStop(1, 'rgba(109, 40, 217, 0.35)');
  ctx.strokeStyle = grad;
  ctx.lineWidth = 2;
  ctx.beginPath();
  const amp = playing ? 1 : 0.15;
  for (let x = 0; x < w; x += 2) {
    const y =
      h / 2 +
      Math.sin(x * 0.04 + t * 6) *
        (h * 0.35 * amp) *
        (0.5 + 0.5 * Math.sin(t * 3 + x * 0.01));
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function startClock() {
  stopClock();
  const loop = () => {
    const el = document.getElementById('time-display');
    if (el) el.textContent = formatTime(pickTimeSource());
    tickWaveform();
    rafId = requestAnimationFrame(loop);
  };
  rafId = requestAnimationFrame(loop);
}

function stopClock() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
  tickWaveform();
}
