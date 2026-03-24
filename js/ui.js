/**
 * UI helpers: DOM utilities, song card rendering, toast notifications, modals.
 */

import { renderComponentSelector, CATEGORIES, getComponentInfo } from './components.js';

// --- DOM Helpers ---

export function $(selector, parent = document) {
  return parent.querySelector(selector);
}

export function $$(selector, parent = document) {
  return [...parent.querySelectorAll(selector)];
}

export function createElement(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'className') el.className = value;
    else if (key === 'textContent') el.textContent = value;
    else if (key === 'innerHTML') el.innerHTML = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else el.setAttribute(key, value);
  }
  for (const child of children) {
    if (typeof child === 'string') el.appendChild(document.createTextNode(child));
    else if (child) el.appendChild(child);
  }
  return el;
}

// --- Song Card Rendering ---

export function renderSongCard(song, store) {
  const existingCard = document.querySelector(`[data-song-id="${song.id}"]`);

  if (existingCard) {
    updateSongCard(existingCard, song, store);
    return null; // Already exists, just updated
  }

  const card = createElement('div', {
    className: 'song-card',
    dataset: { songId: song.id }
  });

  // Header
  const header = createElement('div', { className: 'song-card-header' });

  const thumb = createElement('img', {
    className: 'song-thumbnail',
    src: song.thumbnail,
    alt: song.title,
    loading: 'lazy'
  });
  thumb.onerror = () => { thumb.src = createPlaceholderImage(); };

  const info = createElement('div', { className: 'song-info' });
  info.innerHTML = `
    <div class="song-title">${escapeHtml(song.title)}</div>
    <div class="song-meta">
      <span class="status-badge ${song.status}">${song.status}</span>
      <span class="component-count" title="Selected components">${(song.selectedComponents || []).length}</span>
    </div>
  `;

  const actions = createElement('div', { className: 'song-actions' });

  const expandBtn = createElement('button', {
    className: 'expand-btn',
    title: 'Show components',
    innerHTML: '<svg width="20" height="20"><use href="#icon-expand"/></svg>'
  });

  const removeBtn = createElement('button', {
    className: 'remove-song-btn',
    title: 'Remove song',
    innerHTML: '<svg width="16" height="16"><use href="#icon-trash"/></svg>'
  });

  removeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    showModal('Remove this song and all its tracks from the mixer?', () => {
      store.removeSong(song.id);
    });
  });

  actions.appendChild(expandBtn);
  actions.appendChild(removeBtn);

  header.appendChild(thumb);
  header.appendChild(info);
  header.appendChild(actions);
  card.appendChild(header);

  // Component selector
  const selector = renderComponentSelector(song, store);
  card.appendChild(selector);

  // Toggle expand
  header.addEventListener('click', (e) => {
    if (e.target.closest('.remove-song-btn')) return;
    expandBtn.classList.toggle('expanded');
    selector.classList.toggle('open');
  });

  // Processing overlay
  if (song.status === 'loading') {
    const overlay = createElement('div', {
      className: 'processing-overlay',
      innerHTML: `
        <div class="spinner"></div>
        <span>Fetching video info...</span>
      `
    });
    card.appendChild(overlay);
  }

  return card;
}

function updateSongCard(card, song, store) {
  // Update status badge
  const badge = card.querySelector('.status-badge');
  if (badge) {
    badge.className = `status-badge ${song.status}`;
    badge.textContent = song.status;
  }

  // Update component count
  const count = card.querySelector('.component-count');
  if (count) {
    count.textContent = (song.selectedComponents || []).length;
  }

  // Update title if changed
  const titleEl = card.querySelector('.song-title');
  if (titleEl && titleEl.textContent !== song.title) {
    titleEl.textContent = song.title;
  }

  // Update thumbnail
  const thumb = card.querySelector('.song-thumbnail');
  if (thumb && thumb.src !== song.thumbnail && song.thumbnail) {
    thumb.src = song.thumbnail;
  }

  // Remove processing overlay if ready
  if (song.status === 'ready') {
    const overlay = card.querySelector('.processing-overlay');
    if (overlay) overlay.remove();
  }

  // Re-render component selector to reflect selection state
  const oldSelector = card.querySelector('.component-selector');
  if (oldSelector) {
    const wasOpen = oldSelector.classList.contains('open');
    const newSelector = renderComponentSelector(song, store);
    if (wasOpen) newSelector.classList.add('open');
    card.replaceChild(newSelector, oldSelector);
  }
}

// --- Song Input Form ---

export function setupSongInput(store) {
  const form = document.getElementById('song-input-form');
  const input = document.getElementById('url-input');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = input.value.trim();
    if (!url) return;

    // Import youtube module dynamically to avoid circular deps
    const { parseYouTubeUrl, fetchVideoInfo } = await import('./youtube.js');
    const videoId = parseYouTubeUrl(url);

    if (!videoId) {
      showToast('Invalid YouTube URL. Please try again.', 'error');
      return;
    }

    // Check for duplicate
    const state = store.getState();
    if (state.songs.some(s => s.videoId === videoId)) {
      showToast('This song has already been added.', 'info');
      return;
    }

    const songId = `song-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    // Add song in loading state
    store.setState({
      songs: [...state.songs, {
        id: songId,
        videoId,
        url,
        title: 'Loading...',
        thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        author: '',
        status: 'loading',
        selectedComponents: [],
        expanded: false
      }]
    });

    input.value = '';

    // Fetch info
    try {
      const info = await fetchVideoInfo(videoId);
      store.updateSong(songId, {
        title: info.title,
        thumbnail: info.thumbnail,
        author: info.author,
        status: 'ready'
      });
      showToast(`Added: ${info.title}`, 'success');
    } catch (err) {
      store.updateSong(songId, {
        title: `YouTube Video (${videoId})`,
        status: 'ready'
      });
      showToast('Added song (could not fetch full info)', 'info');
    }
  });
}

// --- Render Songs Container ---

export function renderSongs(songs, store) {
  const container = document.getElementById('songs-container');

  // Remove cards for songs that no longer exist
  container.querySelectorAll('.song-card').forEach(card => {
    const id = card.dataset.songId;
    if (!songs.find(s => s.id === id)) {
      card.remove();
    }
  });

  // Add or update cards
  for (const song of songs) {
    const card = renderSongCard(song, store);
    if (card) {
      container.appendChild(card);
    }
  }
}

// --- Toast Notifications ---

export function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = createElement('div', {
    className: `toast ${type}`,
    textContent: message
  });
  container.appendChild(toast);

  // Remove after animation
  setTimeout(() => {
    toast.remove();
  }, 3200);
}

// --- Modal ---

let currentModalResolve = null;

export function showModal(content, onConfirm) {
  const overlay = document.getElementById('modal-overlay');
  const body = document.getElementById('modal-body');
  const confirmBtn = document.getElementById('modal-confirm');
  const cancelBtn = document.getElementById('modal-cancel');

  body.textContent = typeof content === 'string' ? content : '';
  if (typeof content !== 'string' && content instanceof HTMLElement) {
    body.innerHTML = '';
    body.appendChild(content);
  }

  overlay.hidden = false;

  const cleanup = () => {
    overlay.hidden = true;
    confirmBtn.removeEventListener('click', handleConfirm);
    cancelBtn.removeEventListener('click', handleCancel);
    overlay.removeEventListener('click', handleOverlayClick);
  };

  const handleConfirm = () => {
    cleanup();
    if (onConfirm) onConfirm();
  };

  const handleCancel = () => {
    cleanup();
  };

  const handleOverlayClick = (e) => {
    if (e.target === overlay) handleCancel();
  };

  confirmBtn.addEventListener('click', handleConfirm);
  cancelBtn.addEventListener('click', handleCancel);
  overlay.addEventListener('click', handleOverlayClick);
}

// --- Helpers ---

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

function createPlaceholderImage() {
  const canvas = document.createElement('canvas');
  canvas.width = 80;
  canvas.height = 60;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(0, 0, 80, 60);
  ctx.fillStyle = '#7c3aed';
  ctx.font = '24px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('\u266B', 40, 30);
  return canvas.toDataURL();
}

// Listen for custom toast events
export function setupToastListener() {
  window.addEventListener('mashup:toast', (e) => {
    const { message, type } = e.detail;
    showToast(message, type);
  });
}
