/**
 * Song list, toasts, and modal helpers.
 */

import { parseYouTubeVideoId, thumbnailUrlForVideoId, fetchYouTubeTitle } from './youtube.js';

const TOAST_EVENT = 'mashup-toast';

export function showToast(message, variant = 'info') {
  window.dispatchEvent(new CustomEvent(TOAST_EVENT, { detail: { message, variant } }));
}

export function setupToastListener() {
  const container = document.getElementById('toast-container');
  if (!container) return;

  window.addEventListener(TOAST_EVENT, (e) => {
    const { message, variant } = e.detail || {};
    if (!message) return;

    const el = document.createElement('div');
    el.className = `toast toast--${variant}`;
    el.textContent = message;
    el.setAttribute('role', 'status');
    container.appendChild(el);

    requestAnimationFrame(() => el.classList.add('toast--visible'));

    const remove = () => {
      el.classList.remove('toast--visible');
      el.addEventListener('transitionend', () => el.remove(), { once: true });
      setTimeout(() => el.remove(), 400);
    };
    setTimeout(remove, 3800);
  });
}

function wireModal() {
  const overlay = document.getElementById('modal-overlay');
  const cancel = document.getElementById('modal-cancel');
  const confirm = document.getElementById('modal-confirm');
  if (!overlay || !cancel || !confirm) return;

  let resolvePromise = null;

  cancel.addEventListener('click', () => {
    overlay.hidden = true;
    if (resolvePromise) resolvePromise(false);
    resolvePromise = null;
  });

  confirm.addEventListener('click', () => {
    overlay.hidden = true;
    if (resolvePromise) resolvePromise(true);
    resolvePromise = null;
  });

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      overlay.hidden = true;
      if (resolvePromise) resolvePromise(false);
      resolvePromise = null;
    }
  });

  window.showConfirm = (message, { title = 'Confirm' } = {}) => {
    const body = document.getElementById('modal-body');
    if (!body) return Promise.resolve(false);
    body.innerHTML = `<p class="modal-title">${escapeHtml(title)}</p><p class="modal-text">${escapeHtml(message)}</p>`;
    overlay.hidden = false;
    return new Promise((resolve) => {
      resolvePromise = resolve;
    });
  };
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

wireModal();

export function setupSongInput(store) {
  const form = document.getElementById('song-input-form');
  const input = document.getElementById('url-input');
  if (!form || !input) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = input.value.trim();
    const videoId = parseYouTubeVideoId(url);
    if (!videoId) {
      showToast('Paste a valid YouTube URL (watch, shorts, or youtu.be).', 'error');
      return;
    }

    const dup = store.getState().songs.some((s) => s.videoId === videoId);
    if (dup) {
      showToast('That video is already in your library.', 'info');
      return;
    }

    const id = crypto.randomUUID();
    const thumbnail = thumbnailUrlForVideoId(videoId);
    input.value = '';

    const resolvedTitle = await fetchYouTubeTitle(videoId);
    store.setState({
      songs: [
        ...store.getState().songs,
        { id, url, videoId, title: resolvedTitle, thumbnail }
      ]
    });
    showToast('Song added to your library.', 'success');
  });
}

export function renderSongs(songs, store) {
  const container = document.getElementById('songs-container');
  if (!container) return;

  container.innerHTML = '';

  songs.forEach((song) => {
    const card = document.createElement('article');
    card.className = 'song-card';
    card.draggable = true;
    card.dataset.songId = song.id;

    card.innerHTML = `
      <div class="song-card__media">
        <img class="song-card__thumb" src="${song.thumbnail}" alt="" loading="lazy" width="160" height="90">
        <span class="song-card__badge">YouTube</span>
      </div>
      <div class="song-card__body">
        <h3 class="song-card__title">${escapeHtml(song.title)}</h3>
        <p class="song-card__meta">${escapeHtml(song.videoId)}</p>
        <div class="song-card__actions">
          <button type="button" class="btn btn-secondary btn-sm add-to-mixer-btn" data-song-id="${song.id}">
            <svg width="16" height="16"><use href="#icon-waveform"/></svg>
            Add to Mixer
          </button>
          <button type="button" class="btn btn-icon btn-ghost remove-song-btn" data-song-id="${song.id}" title="Remove from library">
            <svg width="18" height="18"><use href="#icon-trash"/></svg>
          </button>
        </div>
      </div>
    `;

    card.addEventListener('dragstart', (ev) => {
      ev.dataTransfer.setData('application/x-mashup-song-id', song.id);
      ev.dataTransfer.effectAllowed = 'copy';
      card.classList.add('song-card--dragging');
    });

    card.addEventListener('dragend', () => {
      card.classList.remove('song-card--dragging');
    });

    const addBtn = card.querySelector('.add-to-mixer-btn');
    addBtn?.addEventListener('click', () => addSongToMixer(store, song.id));

    const rm = card.querySelector('.remove-song-btn');
    rm?.addEventListener('click', async () => {
      let ok = true;
      if (typeof window.showConfirm === 'function') {
        ok = await window.showConfirm(
          'Remove this song from your library? Tracks using it will be removed from the mixer.',
          { title: 'Remove song' }
        );
      }
      if (ok) {
        store.removeSong(song.id);
        showToast('Song removed.', 'info');
      }
    });

    container.appendChild(card);
  });
}

export function addSongToMixer(store, songId) {
  const state = store.getState();
  const song = state.songs.find((s) => s.id === songId);
  if (!song) return;

  const maxOrder = state.mashup.tracks.reduce((m, t) => Math.max(m, t.order ?? 0), -1);
  store.addTrack({
    id: crypto.randomUUID(),
    songId,
    volume: 80,
    muted: false,
    solo: false,
    order: maxOrder + 1,
    claimedComponents: []
  });

  showToast('Added to mixer.', 'success');
  document.getElementById('mixer-section')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
