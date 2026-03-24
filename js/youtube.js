/**
 * YouTube URL parsing and video info fetching.
 */

/**
 * Extract video ID from various YouTube URL formats.
 * Supports: youtube.com/watch?v=, youtu.be/, youtube.com/shorts/, youtube.com/embed/
 */
export function parseYouTubeUrl(url) {
  if (!url || typeof url !== 'string') return null;

  const trimmed = url.trim();
  let videoId = null;

  try {
    const urlObj = new URL(trimmed);
    const hostname = urlObj.hostname.replace('www.', '');

    if (hostname === 'youtube.com' || hostname === 'm.youtube.com') {
      if (urlObj.pathname === '/watch') {
        videoId = urlObj.searchParams.get('v');
      } else if (urlObj.pathname.startsWith('/shorts/')) {
        videoId = urlObj.pathname.split('/shorts/')[1]?.split('/')[0];
      } else if (urlObj.pathname.startsWith('/embed/')) {
        videoId = urlObj.pathname.split('/embed/')[1]?.split('/')[0];
      } else if (urlObj.pathname.startsWith('/v/')) {
        videoId = urlObj.pathname.split('/v/')[1]?.split('/')[0];
      }
    } else if (hostname === 'youtu.be') {
      videoId = urlObj.pathname.slice(1).split('/')[0];
    }
  } catch {
    // Try regex fallback for edge cases
    const patterns = [
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/
    ];
    for (const pattern of patterns) {
      const match = trimmed.match(pattern);
      if (match) {
        videoId = match[1];
        break;
      }
    }
  }

  // Validate: YouTube IDs are exactly 11 chars
  if (videoId && /^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return videoId;
  }
  return null;
}

/**
 * Fetch video info from noembed (no API key required).
 * Returns { title, thumbnail, videoId }
 */
export async function fetchVideoInfo(videoId) {
  const url = `https://noembed.com/embed?url=https://www.youtube.com/watch?v=${videoId}`;

  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();

    if (data.error) {
      throw new Error(data.error);
    }

    return {
      videoId,
      title: data.title || 'Unknown Title',
      thumbnail: data.thumbnail_url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      author: data.author_name || 'Unknown Artist'
    };
  } catch (err) {
    // Fallback: use default thumbnail, generic title
    console.warn('Failed to fetch video info:', err);
    return {
      videoId,
      title: `YouTube Video (${videoId})`,
      thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      author: 'Unknown'
    };
  }
}

/**
 * Create an iframe embed for a YouTube video.
 */
export function createPlayerEmbed(containerEl, videoId) {
  const iframe = document.createElement('iframe');
  iframe.src = `https://www.youtube.com/embed/${videoId}?enablejsapi=1`;
  iframe.width = '100%';
  iframe.height = '200';
  iframe.style.borderRadius = '8px';
  iframe.style.border = 'none';
  iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope';
  iframe.allowFullscreen = true;
  containerEl.appendChild(iframe);
  return iframe;
}
