"""
Song enrichment: parse artist/title from YouTube oEmbed, fetch Spotify audio
features, and retrieve lyrics from Genius or lrclib.net (free fallback).

All functions degrade gracefully when API keys are absent or requests fail.
"""

from __future__ import annotations

import os
import re
import urllib.parse
import urllib.request
import json
import logging

logger = logging.getLogger(__name__)

KEY_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# Noise tokens stripped from YouTube titles before parsing
_NOISE_RE = re.compile(
    r"""
    \s*[\(\[]
    (?:
        official\s*(?:music\s*)?(?:video|audio|lyric(?:s)?|visualizer|mv)?|
        lyrics?|
        hd|hq|4k|remastered|remaster|extended|clean|explicit|
        feat\.?|ft\.?|with\s+\w+|
        audio\s*only|topic|vevo|official|
        \d{4}          # year
    )
    [^\)\]]*[\)\]]
    """,
    re.IGNORECASE | re.VERBOSE,
)

_SEPARATORS = [" - ", " – ", " — ", " | "]


def parse_artist_title(yt_title: str) -> tuple[str, str]:
    """
    Best-effort parse of a YouTube video title into (artist, song_title).

    Handles common formats:
      "Artist - Song Title (Official Video)"
      "Song Title - Artist"
      "Artist: Song Title"

    Returns ("", yt_title) when no separator is found.
    """
    cleaned = _NOISE_RE.sub("", yt_title).strip()
    # Collapse repeated spaces
    cleaned = re.sub(r"\s{2,}", " ", cleaned)

    for sep in _SEPARATORS:
        if sep in cleaned:
            parts = cleaned.split(sep, 1)
            artist = parts[0].strip()
            title = parts[1].strip()
            # Some channels put "Song - Artist" so we keep as-is;
            # Spotify search will find the right track regardless.
            return artist, title

    # Colon separator (less common)
    if ":" in cleaned:
        artist, _, title = cleaned.partition(":")
        return artist.strip(), title.strip()

    return "", cleaned


def _spotify_client():
    """Return an authenticated spotipy.Spotify client, or None if keys missing."""
    client_id = os.environ.get("SPOTIFY_CLIENT_ID", "")
    client_secret = os.environ.get("SPOTIFY_CLIENT_SECRET", "")
    if not client_id or not client_secret:
        return None
    try:
        import spotipy
        from spotipy.oauth2 import SpotifyClientCredentials

        return spotipy.Spotify(
            auth_manager=SpotifyClientCredentials(
                client_id=client_id, client_secret=client_secret
            )
        )
    except Exception as exc:
        logger.warning("Spotify client init failed: %s", exc)
        return None


def _analyze_preview(preview_url: str) -> dict:
    """
    Download a Spotify 30-second preview MP3 and extract BPM + key via librosa.
    Returns a partial dict (bpm, key, key_name, mode); empty dict on failure.
    """
    try:
        import os
        import tempfile

        import librosa
        import numpy as np

        req = urllib.request.Request(preview_url, headers={"User-Agent": "MashUp/1.0"})
        with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as fh:
            tmp = fh.name
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                with open(tmp, "wb") as fh:
                    fh.write(resp.read())
            y, sr = librosa.load(tmp, sr=22050, mono=True)
        finally:
            os.unlink(tmp)

        tempo_arr, _ = librosa.beat.beat_track(y=y, sr=sr)
        bpm = round(float(np.atleast_1d(tempo_arr)[0]), 1)

        chroma = np.mean(librosa.feature.chroma_cqt(y=y, sr=sr), axis=1)
        major_tmpl = np.array([1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0], dtype=float)
        minor_tmpl = np.array([1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0], dtype=float)
        major_scores = [np.dot(np.roll(chroma, -i), major_tmpl) for i in range(12)]
        minor_scores = [np.dot(np.roll(chroma, -i), minor_tmpl) for i in range(12)]
        bm = int(np.argmax(major_scores))
        bn = int(np.argmax(minor_scores))
        if major_scores[bm] >= minor_scores[bn]:
            key_idx, mode = bm, 1
        else:
            key_idx, mode = bn, 0
        key_name = f"{KEY_NAMES[key_idx]} {'major' if mode == 1 else 'minor'}"
        return {"bpm": bpm, "key": key_idx, "key_name": key_name, "mode": mode}
    except Exception as exc:
        logger.warning("Preview analysis failed: %s", exc)
        return {}


def search_spotify(artist: str, title: str) -> dict | None:
    """
    Search Spotify for the track and return audio features + album art.

    The Spotify audio_features endpoint is deprecated for new app registrations
    (returns 403). We gracefully fall back to analyzing the 30-second preview
    clip with librosa for BPM + key when audio_features is unavailable.

    Returns a dict with keys: bpm, key, key_name, mode, energy, valence,
    danceability, album_art, spotify_id — or None on failure.
    """
    sp = _spotify_client()
    if sp is None:
        return None

    try:
        query = f"track:{title} artist:{artist}" if artist else f"track:{title}"
        results = sp.search(q=query, type="track", limit=1)
        items = results.get("tracks", {}).get("items", [])
        if not items:
            results = sp.search(q=f"{artist} {title}".strip(), type="track", limit=1)
            items = results.get("tracks", {}).get("items", [])
        if not items:
            return None

        track = items[0]
        track_id = track["id"]
        preview_url = track.get("preview_url")

        images = track.get("album", {}).get("images", [])
        album_art = images[0]["url"] if images else None

        result: dict = {
            "bpm": None,
            "key": None,
            "key_name": None,
            "mode": None,
            "energy": None,
            "valence": None,
            "danceability": None,
            "album_art": album_art,
            "spotify_id": track_id,
            "spotify_artist": track.get("artists", [{}])[0].get("name", "") or artist,
            "spotify_title": track.get("name", title),
        }

        # Try Spotify audio_features (works on older app registrations; 403 on newer ones)
        try:
            features = sp.audio_features([track_id])
            if features and features[0]:
                f = features[0]
                key_idx = f.get("key", -1)
                mode = f.get("mode", 1)
                result.update(
                    {
                        "bpm": round(f.get("tempo", 0), 1),
                        "key": key_idx,
                        "key_name": (
                            f"{KEY_NAMES[key_idx]} {'major' if mode == 1 else 'minor'}"
                            if 0 <= key_idx <= 11
                            else None
                        ),
                        "mode": mode,
                        "energy": round(f.get("energy", 0), 3),
                        "valence": round(f.get("valence", 0), 3),
                        "danceability": round(f.get("danceability", 0), 3),
                    }
                )
        except Exception:
            pass  # 403 for new Spotify app registrations — fall through to preview analysis

        # If we still have no BPM/key, analyze the 30-second preview with librosa
        if result["bpm"] is None and preview_url:
            result.update(_analyze_preview(preview_url))

        return result
    except Exception as exc:
        logger.warning("Spotify search failed: %s", exc)
        return None


def get_lyrics_genius(artist: str, title: str) -> str | None:
    """Fetch full lyrics from Genius. Requires GENIUS_ACCESS_TOKEN env var."""
    token = os.environ.get("GENIUS_ACCESS_TOKEN", "")
    if not token:
        return None
    try:
        import lyricsgenius

        genius = lyricsgenius.Genius(token, remove_section_headers=True)
        song = genius.search_song(title, artist)
        if song and song.lyrics:
            return song.lyrics.strip()
    except Exception as exc:
        logger.warning("Genius lyrics fetch failed: %s", exc)
    return None


def get_lyrics_lrclib(artist: str, title: str) -> str | None:
    """
    Fetch lyrics from lrclib.net (free, no API key).
    Returns plain-text lyrics or None.
    """
    try:
        params = urllib.parse.urlencode({"track_name": title, "artist_name": artist})
        url = f"https://lrclib.net/api/search?{params}"
        req = urllib.request.Request(url, headers={"User-Agent": "MashUp/1.0"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode())
        if isinstance(data, list) and data:
            plain = data[0].get("plainLyrics") or data[0].get("syncedLyrics")
            if plain:
                # Strip LRC timestamps if present
                plain = re.sub(r"\[\d+:\d+\.\d+\]", "", plain).strip()
                return plain
    except Exception as exc:
        logger.warning("lrclib fetch failed: %s", exc)
    return None


def _lyrics_snippet(full_lyrics: str | None, max_lines: int = 4) -> str | None:
    if not full_lyrics:
        return None
    lines = [ln for ln in full_lyrics.splitlines() if ln.strip()]
    snippet_lines = lines[:max_lines]
    suffix = " …" if len(lines) > max_lines else ""
    return "\n".join(snippet_lines) + suffix


def fetch_oembed_title(video_id: str) -> str:
    """Fetch YouTube oEmbed title for a video ID."""
    try:
        page_url = f"https://www.youtube.com/watch?v={video_id}"
        encoded = urllib.parse.quote_plus(page_url)
        url = f"https://www.youtube.com/oembed?url={encoded}&format=json"
        req = urllib.request.Request(url, headers={"User-Agent": "MashUp/1.0"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode())
        return data.get("title", "")
    except Exception:
        return ""


def enrich_video(video_id: str) -> dict:
    """
    Full enrichment pipeline for a YouTube video ID.

    Returns a dict suitable for the /api/enrich response.
    All fields are present; unknown values are None.
    """
    yt_title = fetch_oembed_title(video_id)
    artist, title = parse_artist_title(yt_title) if yt_title else ("", "")

    result: dict = {
        "video_id": video_id,
        "yt_title": yt_title or None,
        "artist": artist or None,
        "title": title or yt_title or None,
        "bpm": None,
        "key": None,
        "key_name": None,
        "mode": None,
        "energy": None,
        "valence": None,
        "danceability": None,
        "album_art": None,
        "spotify_id": None,
        "lyrics_snippet": None,
        "lyrics_full": None,
    }

    if title:
        spotify = search_spotify(artist, title)
        if spotify:
            result.update(
                {
                    "bpm": spotify["bpm"],
                    "key": spotify["key"],
                    "key_name": spotify["key_name"],
                    "mode": spotify["mode"],
                    "energy": spotify["energy"],
                    "valence": spotify["valence"],
                    "danceability": spotify["danceability"],
                    "album_art": spotify["album_art"],
                    "spotify_id": spotify["spotify_id"],
                    "artist": spotify.get("spotify_artist") or artist or None,
                    "title": spotify.get("spotify_title") or title or None,
                }
            )

        effective_artist = result["artist"] or artist
        effective_title = result["title"] or title

        lyrics = get_lyrics_genius(effective_artist, effective_title)
        if lyrics is None:
            lyrics = get_lyrics_lrclib(effective_artist, effective_title)

        result["lyrics_full"] = lyrics
        result["lyrics_snippet"] = _lyrics_snippet(lyrics)

    # If BPM/key still missing (no Spotify preview, or Spotify unavailable),
    # download a 45-second YouTube clip and analyze with librosa
    if result["bpm"] is None:
        result.update(_analyze_youtube_clip(video_id))

    return result


def _analyze_youtube_clip(video_id: str, duration: int = 45) -> dict:
    """
    Download first `duration` seconds of a YouTube video via yt-dlp and
    extract BPM + key with librosa. Returns a partial dict or empty dict.
    """
    import sys
    import tempfile
    import subprocess as _sp
    from pathlib import Path as _P

    ytdlp = str(_P(sys.executable).parent / "yt-dlp")
    if not _P(ytdlp).exists():
        ytdlp = "yt-dlp"

    try:
        import librosa
        import numpy as np

        with tempfile.TemporaryDirectory() as tmpdir:
            out_tmpl = str(_P(tmpdir) / "clip.%(ext)s")
            result = _sp.run(
                [
                    ytdlp,
                    f"https://www.youtube.com/watch?v={video_id}",
                    "-x",
                    "--audio-format", "wav",
                    "--audio-quality", "5",
                    "--download-sections", f"*0-{duration}",
                    "--force-keyframes-at-cuts",
                    "-o", out_tmpl,
                    "--no-playlist",
                    "--quiet",
                ],
                capture_output=True,
                text=True,
                timeout=90,
            )
            wavs = list(_P(tmpdir).glob("*.wav"))
            if not wavs:
                return {}

            y, sr = librosa.load(str(wavs[0]), sr=22050, mono=True)

        tempo_arr, _ = librosa.beat.beat_track(y=y, sr=sr)
        bpm = round(float(np.atleast_1d(tempo_arr)[0]), 1)

        chroma = np.mean(librosa.feature.chroma_cqt(y=y, sr=sr), axis=1)
        major_tmpl = np.array([1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0], dtype=float)
        minor_tmpl = np.array([1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0], dtype=float)
        major_s = [np.dot(np.roll(chroma, -i), major_tmpl) for i in range(12)]
        minor_s = [np.dot(np.roll(chroma, -i), minor_tmpl) for i in range(12)]
        bm, bn = int(np.argmax(major_s)), int(np.argmax(minor_s))
        key_idx, mode = (bm, 1) if major_s[bm] >= minor_s[bn] else (bn, 0)
        key_name = f"{KEY_NAMES[key_idx]} {'major' if mode == 1 else 'minor'}"

        return {"bpm": bpm, "key": key_idx, "key_name": key_name, "mode": mode}
    except Exception as exc:
        logger.warning("YouTube clip BPM analysis failed: %s", exc)
        return {}
