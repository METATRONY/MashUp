/**
 * YouTube IFrame API playback: multi-track sync, levels, transport clock.
 */

import { showToast } from './ui.js';

let storeRef = null;
let apiReady = false;
let containerEl = null;

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
  }
}

function shouldPlayExportedMashup() {
  const g = storeRef?.getState().mashup.generation;
  return g?.status === 'done' && !!g?.resultUrl;
}

/** @type {Map<string, { player: YT.Player | null, slotId: string, videoId: string, ready: boolean }>} */
const registry = new Map();

let lastStructureSig = '';
let rafId = 0;

const YT_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

function nearestPlaybackRate(bpm) {
  const r = Math.min(2, Math.max(0.25, bpm / 120));
  return YT_RATES.reduce((best, x) =>
    Math.abs(x - r) < Math.abs(best - r) ? x : best
  );
}

function loadYouTubeAPI() {
  return new Promise((resolve) => {
    if (window.YT && window.YT.Player) {
      apiReady = true;
      resolve();
      return;
    }
    const existing = document.querySelector('script[data-yt-iframe-api]');
    if (existing) {
      const check = () => {
        if (window.YT && window.YT.Player) {
          apiReady = true;
          resolve();
        } else {
          setTimeout(check, 50);
        }
      };
      check();
      return;
    }
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    tag.async = true;
    tag.dataset.ytIframeApi = 'true';
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof prev === 'function') prev();
      apiReady = true;
      resolve();
    };
    document.head.appendChild(tag);
  });
}

function ensurePlayerContainer() {
  if (containerEl) return containerEl;
  containerEl = document.createElement('div');
  containerEl.id = 'yt-player-root';
  containerEl.setAttribute('aria-hidden', 'true');
  containerEl.style.cssText =
    'position:fixed;left:-9999px;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;';
  document.body.appendChild(containerEl);
  return containerEl;
}

function destroyAllPlayers() {
  registry.forEach((entry) => {
    try {
      entry.player?.destroy?.();
    } catch {
      /* ignore */
    }
    const el = document.getElementById(entry.slotId);
    el?.remove();
  });
  registry.clear();
}

function sortedTracks(state) {
  return [...state.mashup.tracks].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

function effectiveVolume(track, tracks) {
  if (track.muted) return 0;
  const anySolo = tracks.some((t) => t.solo);
  if (anySolo && !track.solo) return 0;
  return track.volume;
}

function applyLevels(state) {
  const tracks = sortedTracks(state);
  const master = (state.mashup.masterVolume ?? 80) / 100;
  const rate = nearestPlaybackRate(state.mashup.bpm ?? 120);

  tracks.forEach((t) => {
    const entry = registry.get(t.id);
    if (!entry?.player || !entry.ready) return;
    const ev = effectiveVolume(t, tracks);
    const vol = Math.round((ev * master));
    try {
      entry.player.setVolume?.(Math.max(0, Math.min(100, vol)));
      entry.player.setPlaybackRate?.(rate);
    } catch {
      /* ignore */
    }
  });
}

function rebuildPlayers(state) {
  destroyAllPlayers();
  const root = ensurePlayerContainer();
  const tracks = sortedTracks(state);

  tracks.forEach((track) => {
    const song = state.songs.find((s) => s.id === track.songId);
    if (!song) return;

    const slotId = `yt-slot-${track.id}`;
    const slot = document.createElement('div');
    slot.id = slotId;
    root.appendChild(slot);

    registry.set(track.id, {
      player: null,
      slotId,
      videoId: song.videoId,
      ready: false
    });

    const player = new YT.Player(slotId, {
      videoId: song.videoId,
      width: '1',
      height: '1',
      playerVars: {
        autoplay: 0,
        controls: 0,
        modestbranding: 1,
        rel: 0,
        playsinline: 1,
        origin: window.location.origin || undefined
      },
      events: {
        onReady: (e) => {
          const ent = registry.get(track.id);
          if (!ent) return;
          ent.player = e.target;
          ent.ready = true;
          applyLevels(storeRef.getState());
          if (storeRef.getState().mashup.playing) {
            try {
              e.target.playVideo();
            } catch {
              /* ignore */
            }
          }
        },
        onError: () => {
          showToast('Could not load a YouTube track (embed restricted or unavailable).', 'error');
        }
      }
    });

    registry.get(track.id).player = player;
  });
}

function syncPlayersWithState(state) {
  if (!apiReady) return;

  const tracks = sortedTracks(state);
  const structureSig = tracks.map((t) => `${t.id}@${t.order}`).join('>');

  if (structureSig !== lastStructureSig) {
    lastStructureSig = structureSig;
    rebuildPlayers(state);
    return;
  }

  applyLevels(state);
}

export function initAudio(store) {
  storeRef = store;
  const ra = getResultAudio();
  ra?.addEventListener('ended', () => {
    if (!storeRef) return;
    storeRef.updateMashup({ playing: false });
    stopClock();
  });

  loadYouTubeAPI().then(() => {
    lastStructureSig = '';
    syncPlayersWithState(store.getState());
    tickWaveform();
  });

  store.subscribe((state) => {
    syncPlayersWithState(state);
  });
}

function forEachReadyPlayer(fn) {
  registry.forEach((entry) => {
    if (entry.player && entry.ready) fn(entry.player);
  });
}

export function playPause() {
  if (!storeRef) return;
  const state = storeRef.getState();
  const tracks = sortedTracks(state);
  const resultEl = getResultAudio();

  if (shouldPlayExportedMashup() && resultEl) {
    forEachReadyPlayer((p) => {
      try {
        p.pauseVideo();
      } catch {
        /* ignore */
      }
    });

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
    return;
  }

  if (resultEl) {
    try {
      resultEl.pause();
    } catch {
      /* ignore */
    }
  }

  if (tracks.length === 0) {
    showToast('Add at least one track to the mixer.', 'info');
    return;
  }

  if (state.mashup.playing) {
    forEachReadyPlayer((p) => {
      try {
        p.pauseVideo();
      } catch {
        /* ignore */
      }
    });
    storeRef.updateMashup({ playing: false });
    stopClock();
  } else {
    storeRef.updateMashup({ playing: true });
    applyLevels(storeRef.getState());
    forEachReadyPlayer((p) => {
      try {
        p.playVideo();
      } catch {
        /* ignore */
      }
    });
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
  forEachReadyPlayer((p) => {
    try {
      p.pauseVideo();
      p.seekTo(0, true);
    } catch {
      /* ignore */
    }
  });
  storeRef.updateMashup({ playing: false, currentTime: 0 });
  stopClock();
  const el = document.getElementById('time-display');
  if (el) el.textContent = formatTime(0);
}

function pickTimeSource() {
  if (!storeRef) return 0;
  const state = storeRef.getState();
  const resultEl = getResultAudio();
  if (shouldPlayExportedMashup() && resultEl && !Number.isNaN(resultEl.currentTime)) {
    return resultEl.currentTime;
  }
  const tracks = sortedTracks(state);
  for (const t of tracks) {
    const entry = registry.get(t.id);
    if (entry?.player && entry.ready) {
      try {
        return entry.player.getCurrentTime() || 0;
      } catch {
        /* continue */
      }
    }
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
    const y = h / 2 + Math.sin(x * 0.04 + t * 6) * (h * 0.35 * amp) * (0.5 + 0.5 * Math.sin(t * 3 + x * 0.01));
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
