/**
 * Song list, toasts, and modal helpers.
 */

import { parseYouTubeVideoId, thumbnailUrlForVideoId, fetchYouTubeTitle, enrichSong } from './youtube.js';
import { suggestComponents, estimateFeaturesFromMeta, scoreComponents, toCamelot } from './compatibility.js';

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

    // Add song immediately with basic info so the card appears right away
    const resolvedTitle = await fetchYouTubeTitle(videoId);
    store.setState({
      songs: [
        ...store.getState().songs,
        {
          id,
          url,
          videoId,
          title: resolvedTitle,
          thumbnail,
          artist: null,
          bpm: null,
          key: null,
          keyName: null,
          mode: null,
          energy: null,
          valence: null,
          danceability: null,
          lyricsSnippet: null,
          lyricsFull: null,
          albumArt: null,
          spotifyId: null,
          enriching: true,
          enriched: false
        }
      ]
    });
    showToast('Song added — fetching metadata…', 'success');

    // Enrich asynchronously and update card once data arrives
    const enrichment = await enrichSong(videoId);
    if (enrichment) {
      store.updateSong(id, {
        artist: enrichment.artist || null,
        title: enrichment.title || resolvedTitle,
        bpm: enrichment.bpm || null,
        key: enrichment.key ?? null,
        keyName: enrichment.key_name || null,
        mode: enrichment.mode ?? null,
        energy: enrichment.energy ?? null,
        valence: enrichment.valence ?? null,
        danceability: enrichment.danceability ?? null,
        lyricsSnippet: enrichment.lyrics_snippet || null,
        lyricsFull: enrichment.lyrics_full || null,
        albumArt: enrichment.album_art || null,
        spotifyId: enrichment.spotify_id || null,
        enriching: false,
        enriched: true
      });
    } else {
      store.updateSong(id, { enriching: false, enriched: false });
    }
  });
}

const COMP_LABEL = { drums: 'Drums', bass: 'Bass', vocals: 'Vocals', melody: 'Melody', harmony: 'Harmony', pads: 'Pads', percussion: 'Percussion', fx: 'FX', other: 'Other' };

function sortedSongs(songs) {
  return [...songs].sort((a, b) => {
    const bpmDiff = (a.bpm || 0) - (b.bpm || 0);
    if (bpmDiff !== 0) return bpmDiff;
    return (a.keyName || 'zzz').localeCompare(b.keyName || 'zzz');
  });
}

function buildSongCard(song, store) {
  const art = song.albumArt || song.thumbnail;

  // Compact-mode metadata (always visible)
  const bpmLabel = song.bpm ? `${song.bpm} BPM` : '';
  const keyLabel = song.keyName ? song.keyName : '';
  const metaLine = [bpmLabel, keyLabel].filter(Boolean).join(' · ');

  // Suggested components for detail panel
  let suggestHtml = '';
  if (song.enriched) {
    const hasFeat = song.energy != null;
    const sf = hasFeat
      ? song
      : (song.bpm != null || song.mode != null)
      ? { ...song, ...estimateFeaturesFromMeta(song) }
      : null;
    if (sf) {
      const top = suggestComponents(sf).slice(0, 5);
      const chips = top.map((id) => `<span class="song-card__suggest-chip">${COMP_LABEL[id] || id}</span>`).join('');
      suggestHtml = `<div class="song-card__suggested"><span class="song-card__suggested-label">Best for</span>${chips}</div>`;
    }
  }

  const lyricsText = song.lyricsFull || song.lyricsSnippet;
  const lyricsHtml = lyricsText
    ? `<div class="song-card__lyrics-wrap"><pre class="song-card__lyrics">${escapeHtml(lyricsText)}</pre></div>`
    : '';

  const card = document.createElement('article');
  card.className = `song-card${song.enriching ? ' song-card--enriching' : ''}`;
  card.draggable = true;
  card.dataset.songId = song.id;

  // energy != null means Spotify audio_features gave us exact data;
  // if null, BPM/key are estimated by librosa (mark with ~ prefix)
  const isEstimated = song.energy == null && (song.bpm != null || song.keyName != null);
  const estimatedTip = isEstimated ? ' title="Estimated via audio analysis — Spotify exact data unavailable"' : '';
  const camelot = toCamelot(song.key, song.mode);
  const bpmDisplay = song.bpm ? `${isEstimated ? '~' : ''}${song.bpm} BPM` : '';
  // Show Camelot notation as the key badge (e.g. "4A"), full key name in tooltip
  const keyDisplay = camelot
    ? `${isEstimated ? '~' : ''}${camelot}`
    : song.keyName ? `${isEstimated ? '~' : ''}${escapeHtml(song.keyName)}` : '';
  const keyTip = song.keyName ? ` title="${escapeHtml(song.keyName)}${isEstimated ? ' (estimated)' : ''}"` : estimatedTip;

  const coverMetaHtml = (song.bpm || song.keyName)
    ? `<div class="song-card__cover-meta">
        ${song.bpm ? `<span class="song-card__cover-badge song-card__cover-badge--bpm${isEstimated ? ' song-card__cover-badge--est' : ''}"${estimatedTip}>${bpmDisplay}</span>` : ''}
        ${keyDisplay ? `<span class="song-card__cover-badge song-card__cover-badge--key${isEstimated ? ' song-card__cover-badge--est' : ''}"${keyTip}>${keyDisplay}</span>` : ''}
       </div>`
    : '';

  card.innerHTML = `
    <div class="song-card__row">
      <div class="song-card__row-text">
        ${song.artist ? `<p class="song-card__artist-sm" title="${escapeHtml(song.artist)}">${escapeHtml(song.artist)}</p>` : ''}
        <p class="song-card__title-sm" title="${escapeHtml(song.title)}">${escapeHtml(song.title)}</p>
      </div>
      <div class="song-card__row-meta">
        ${bpmDisplay ? `<span class="song-card__cover-badge song-card__cover-badge--bpm${isEstimated ? ' song-card__cover-badge--est' : ''}"${estimatedTip}>${bpmDisplay}</span>` : ''}
        ${keyDisplay ? `<span class="song-card__cover-badge song-card__cover-badge--key${isEstimated ? ' song-card__cover-badge--est' : ''}"${keyTip}>${keyDisplay}</span>` : ''}
      </div>
      <button type="button" class="btn btn-icon btn-ghost add-to-mixer-btn song-card__row-add" data-song-id="${song.id}" title="Add to mixer">
        <svg width="14" height="14"><use href="#icon-waveform"/></svg>
      </button>
      <button type="button" class="song-card__open-btn" title="Show details" aria-expanded="false">
        <svg width="16" height="16"><use href="#icon-chevron"/></svg>
      </button>
    </div>
    <div class="song-card__details" hidden>
      ${art ? `<div class="song-card__cover">
        <img class="song-card__thumb" src="${art}" alt="" loading="lazy">
        ${song.enriching ? '<div class="song-card__spinner"></div>' : ''}
      </div>` : ''}
      <div class="song-card__detail-body">
        ${song.artist ? `<p class="song-card__artist">${escapeHtml(song.artist)}</p>` : ''}
        ${song.videoId ? `<a class="song-card__yt-link" href="https://www.youtube.com/watch?v=${encodeURIComponent(song.videoId)}" target="_blank" rel="noopener noreferrer">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M23.5 6.2a3 3 0 0 0-2.1-2.1C19.5 3.5 12 3.5 12 3.5s-7.5 0-9.4.6A3 3 0 0 0 .5 6.2C0 8.1 0 12 0 12s0 3.9.5 5.8a3 3 0 0 0 2.1 2.1c1.9.6 9.4.6 9.4.6s7.5 0 9.4-.6a3 3 0 0 0 2.1-2.1C24 15.9 24 12 24 12s0-3.9-.5-5.8zM9.8 15.5V8.5l6.3 3.5-6.3 3.5z"/></svg>
          Listen on YouTube
        </a>` : ''}
        <div class="song-card__badges">
          ${bpmDisplay ? `<span class="song-card__badge song-card__badge--bpm"${estimatedTip}>${bpmDisplay}</span>` : ''}
          ${keyDisplay ? `<span class="song-card__badge song-card__badge--key"${estimatedTip}>${keyDisplay}</span>` : ''}
          ${isEstimated ? `<span class="song-card__badge song-card__badge--est"${estimatedTip}>est.</span>` : ''}
        </div>
        ${suggestHtml}
        ${lyricsHtml}
        <button type="button" class="btn btn-icon btn-ghost remove-song-btn" data-song-id="${song.id}" title="Remove from library" style="align-self:flex-start;margin-top:4px">
          <svg width="16" height="16"><use href="#icon-trash"/></svg>
        </button>
      </div>
    </div>
  `;

  // Expand / collapse
  const openBtn = card.querySelector('.song-card__open-btn');
  const details = card.querySelector('.song-card__details');
  openBtn?.addEventListener('click', () => {
    const open = !details.hidden;
    details.hidden = open;
    openBtn.setAttribute('aria-expanded', String(!open));
    openBtn.querySelector('use').setAttribute('href', open ? '#icon-chevron' : '#icon-collapse');
  });

  // Drag to mixer
  card.addEventListener('dragstart', (ev) => {
    ev.dataTransfer.setData('application/x-mashup-song-id', song.id);
    ev.dataTransfer.effectAllowed = 'copy';
    card.classList.add('song-card--dragging');
  });
  card.addEventListener('dragend', () => card.classList.remove('song-card--dragging'));

  card.querySelector('.add-to-mixer-btn')?.addEventListener('click', () => addSongToMixer(store, song.id));

  card.querySelector('.remove-song-btn')?.addEventListener('click', async () => {
    let ok = true;
    if (typeof window.showConfirm === 'function') {
      ok = await window.showConfirm('Remove this song from your library? Tracks using it will be removed from the mixer.', { title: 'Remove song' });
    }
    if (ok) { store.removeSong(song.id); showToast('Song removed.', 'info'); }
  });

  return card;
}

let _songSearchQuery = '';
let _matchFilterIds = null; // Set<string> | null — null means no filter active

export function setMatchFilter(ids, label = 'Showing compatible songs') {
  _matchFilterIds = ids instanceof Set ? ids : new Set(ids);
  const banner = document.getElementById('match-filter-banner');
  const labelEl = document.getElementById('match-filter-label');
  if (banner) banner.hidden = false;
  if (labelEl) labelEl.textContent = label;
  const btn = document.getElementById('find-match-btn');
  if (btn) btn.classList.add('find-match-btn--active');
  document.dispatchEvent(new CustomEvent('mashup:search', { bubbles: true }));
}

export function clearMatchFilter() {
  _matchFilterIds = null;
  const banner = document.getElementById('match-filter-banner');
  if (banner) banner.hidden = true;
  const btn = document.getElementById('find-match-btn');
  if (btn) btn.classList.remove('find-match-btn--active');
  document.dispatchEvent(new CustomEvent('mashup:search', { bubbles: true }));
}

export function initSongSearch() {
  const input = document.getElementById('song-search');
  if (!input) return;
  input.addEventListener('input', () => {
    _songSearchQuery = input.value.trim().toLowerCase();
    input.dispatchEvent(new CustomEvent('mashup:search', { bubbles: true }));
  });

  document.getElementById('match-filter-clear')?.addEventListener('click', clearMatchFilter);
}

export function renderSongs(songs, store) {
  const container = document.getElementById('songs-container');
  const countEl = document.getElementById('library-count');
  if (!container) return;

  const sorted = sortedSongs(songs);

  let filtered = sorted;
  if (_matchFilterIds !== null) {
    filtered = filtered.filter((s) => _matchFilterIds.has(s.id));
  }
  if (_songSearchQuery) {
    filtered = filtered.filter((s) =>
      (s.title || '').toLowerCase().includes(_songSearchQuery) ||
      (s.artist || '').toLowerCase().includes(_songSearchQuery) ||
      (s.keyName || '').toLowerCase().includes(_songSearchQuery)
    );
  }

  if (countEl) countEl.textContent = songs.length > 0 ? `${filtered.length} / ${songs.length}` : '';

  container.innerHTML = '';
  filtered.forEach((song) => container.appendChild(buildSongCard(song, store)));
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

export async function addSongToLibraryById(store, videoId, hintArtist = '', hintTitle = '') {
  const state = store.getState();
  // Don't add duplicates
  if (state.songs.some(s => s.videoId === videoId)) return;

  const id = crypto.randomUUID();
  const thumbnail = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
  const resolvedTitle = hintTitle || videoId;

  store.setState({
    songs: [...store.getState().songs, {
      id, url: `https://www.youtube.com/watch?v=${videoId}`,
      videoId, title: resolvedTitle, thumbnail,
      artist: hintArtist || null,
      bpm: null, key: null, keyName: null, mode: null,
      energy: null, valence: null, danceability: null,
      lyricsSnippet: null, lyricsFull: null,
      albumArt: null, spotifyId: null,
      enriching: true, enriched: false
    }]
  });
  showToast(`Adding "${resolvedTitle}" to library…`, 'success');

  const enrichment = await enrichSong(videoId);
  if (enrichment) {
    store.updateSong(id, {
      artist: enrichment.artist || hintArtist || null,
      title: enrichment.title || resolvedTitle,
      bpm: enrichment.bpm || null,
      key: enrichment.key ?? null,
      keyName: enrichment.key_name || null,
      mode: enrichment.mode ?? null,
      energy: enrichment.energy ?? null,
      valence: enrichment.valence ?? null,
      danceability: enrichment.danceability ?? null,
      lyricsSnippet: enrichment.lyrics_snippet || null,
      lyricsFull: enrichment.lyrics_full || null,
      albumArt: enrichment.album_art || null,
      spotifyId: enrichment.spotify_id || null,
      enriching: false, enriched: true
    });
  } else {
    store.updateSong(id, { enriching: false, enriched: false });
  }
}
