/**
 * YouTube URL parsing and lightweight metadata helpers.
 */

export function parseYouTubeVideoId(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const input = raw.trim();
  if (!input) return null;

  try {
    const u = new URL(input);
    const host = u.hostname.replace(/^www\./, '');

    if (host === 'youtu.be') {
      const id = u.pathname.split('/').filter(Boolean)[0];
      return id && /^[\w-]{11}$/.test(id) ? id : null;
    }

    if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
      if (u.pathname === '/watch' || u.pathname.startsWith('/watch')) {
        const v = u.searchParams.get('v');
        return v && /^[\w-]{11}$/.test(v) ? v : null;
      }
      if (u.pathname.startsWith('/shorts/')) {
        const id = u.pathname.split('/')[2];
        return id && /^[\w-]{11}$/.test(id) ? id : null;
      }
      if (u.pathname.startsWith('/embed/')) {
        const id = u.pathname.split('/')[2];
        return id && /^[\w-]{11}$/.test(id) ? id : null;
      }
      if (u.pathname.startsWith('/live/')) {
        const id = u.pathname.split('/')[2];
        return id && /^[\w-]{11}$/.test(id) ? id : null;
      }
    }
  } catch {
    return null;
  }

  return null;
}

export function thumbnailUrlForVideoId(videoId) {
  return `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
}

/**
 * Best-effort title via oEmbed (may fail in-browser due to CORS in some setups).
 */
export async function fetchYouTubeTitle(videoId) {
  const pageUrl = `https://www.youtube.com/watch?v=${videoId}`;
  try {
    const oembed = `https://www.youtube.com/oembed?url=${encodeURIComponent(pageUrl)}&format=json`;
    const res = await fetch(oembed);
    if (res.ok) {
      const data = await res.json();
      if (data && typeof data.title === 'string') return data.title;
    }
  } catch {
    /* ignore */
  }
  return `YouTube video`;
}

/**
 * Enrich a video ID with song metadata via the backend /api/enrich endpoint.
 * Returns the enrichment object or null on failure.
 *
 * @param {string} videoId
 * @returns {Promise<object|null>}
 */
export async function enrichSong(videoId) {
  const base = window.MASHUP_API_BASE || 'http://127.0.0.1:8000';
  try {
    const res = await fetch(`${base}/api/enrich?video_id=${encodeURIComponent(videoId)}`);
    if (res.ok) return await res.json();
  } catch {
    /* network error — degrade gracefully */
  }
  return null;
}
