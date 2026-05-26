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

# Krumhansl-Schmuckler key profiles (librosa fallback only).
_KS_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
_KS_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

# Maps Essentia enharmonic key names to Spotify key integers (0=C … 11=B)
_ESSENTIA_KEY_MAP = {
    "C": 0, "C#": 1, "Db": 1, "D": 2, "D#": 3, "Eb": 3,
    "E": 4, "F": 5, "F#": 6, "Gb": 6, "G": 7, "G#": 8,
    "Ab": 8, "A": 9, "A#": 10, "Bb": 10, "B": 11,
}


def _extract_bpm_key(y, sr) -> dict:
    """
    Extract BPM and key from a mono audio array.

    Tries Essentia first (RhythmExtractor2013 + KeyExtractor) — these are
    the algorithms that powered AcousticBrainz and are significantly more
    accurate than librosa on real music.  Falls back to librosa with
    Krumhansl-Schmuckler profiles + harmonic separation if Essentia is not
    installed.
    """
    import numpy as np

    # ── Essentia path (preferred) ──────────────────────────────────────────
    try:
        import essentia.standard as es

        audio = y.astype(np.float32)

        # BPM — multifeature mode; normalise to 60–140 to fix 2× octave errors
        # (e.g. slow ballads often detected at double their real tempo)
        rhythm = es.RhythmExtractor2013(method="multifeature")
        bpm, _beats, _conf, _bpm_ests, _beat_loudness = rhythm(audio)
        bpm = float(bpm)
        for _ in range(3):
            if bpm > 140:
                bpm /= 2
            elif bpm < 60:
                bpm *= 2
            else:
                break
        bpm = round(bpm, 1)

        # Key — dedicated harmonic pitch class profile extractor
        key_ext = es.KeyExtractor()
        key_str, scale, _strength = key_ext(audio)
        key_idx = _ESSENTIA_KEY_MAP.get(key_str, -1)
        mode = 1 if scale == "major" else 0
        key_name = f"{key_str} {scale}" if key_idx >= 0 else None

        return {
            "bpm": bpm,
            "key": key_idx if key_idx >= 0 else None,
            "key_name": key_name,
            "mode": mode,
        }
    except ImportError:
        pass  # Essentia not installed — use librosa fallback
    except Exception as exc:
        logger.warning("Essentia analysis failed, falling back to librosa: %s", exc)

    # ── librosa fallback ───────────────────────────────────────────────────
    import librosa

    tempo_arr, _ = librosa.beat.beat_track(y=y, sr=sr, start_bpm=90)
    bpm = float(np.atleast_1d(tempo_arr)[0])
    for _ in range(3):
        if bpm > 150:
            bpm /= 2
        elif bpm < 60:
            bpm *= 2
        else:
            break
    bpm = round(bpm, 1)

    y_harm = librosa.effects.harmonic(y, margin=8)
    chroma = np.mean(librosa.feature.chroma_cqt(y=y_harm, sr=sr), axis=1)
    ks_maj = np.array(_KS_MAJOR)
    ks_min = np.array(_KS_MINOR)
    major_scores = [np.corrcoef(np.roll(chroma, -i), ks_maj)[0, 1] for i in range(12)]
    minor_scores = [np.corrcoef(np.roll(chroma, -i), ks_min)[0, 1] for i in range(12)]
    bm = int(np.argmax(major_scores))
    bn = int(np.argmax(minor_scores))
    key_idx, mode = (bm, 1) if major_scores[bm] >= minor_scores[bn] else (bn, 0)
    key_name = f"{KEY_NAMES[key_idx]} {'major' if mode == 1 else 'minor'}"
    return {"bpm": bpm, "key": key_idx, "key_name": key_name, "mode": mode}

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


def search_spotify(artist: str, title: str) -> dict | None:
    """
    Search Spotify for the track and return album art + confirmed metadata.

    NOTE: audio_features is permanently 403 for new Spotify app registrations.
    We no longer attempt it. Spotify is used solely for album art and canonical
    artist/title. BPM and key are sourced from GetSongBPM (see get_song_bpm)
    or Essentia local analysis.

    Returns a dict with: album_art, spotify_id, spotify_artist, spotify_title.
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
        images = track.get("album", {}).get("images", [])
        return {
            "album_art": images[0]["url"] if images else None,
            "spotify_id": track["id"],
            "spotify_artist": track.get("artists", [{}])[0].get("name", "") or artist,
            "spotify_title": track.get("name", title),
        }
    except Exception as exc:
        logger.warning("Spotify search failed: %s", exc)
        return None


# Maps GetSongBPM / Essentia key strings to Spotify key integers (0=C … 11=B)
_KEY_NAME_MAP = {
    "C": 0, "C#": 1, "Db": 1, "D": 2, "D#": 3, "Eb": 3,
    "E": 4, "F": 5, "F#": 6, "Gb": 6, "G": 7, "G#": 8,
    "Ab": 8, "A": 9, "A#": 10, "Bb": 10, "B": 11,
}


def _parse_key_string(key_str: str) -> tuple[int, int] | None:
    """
    Parse a key string like "Fm", "C#m", "Ab", "D" into (key_idx, mode).
    mode=0 minor, mode=1 major. Returns None on failure.
    """
    if not key_str:
        return None
    s = key_str.strip()
    is_minor = s.endswith("m")
    note = s[:-1] if is_minor else s
    idx = _KEY_NAME_MAP.get(note)
    if idx is None:
        return None
    return idx, (0 if is_minor else 1)


def get_song_bpm(artist: str, title: str) -> dict | None:
    """
    Look up exact BPM and key from the GetSongBPM API.

    Requires GETSONGBPM_API_KEY in environment. Free tier covers most
    mainstream songs. Returns a dict with bpm, key, key_name, mode, or
    None if the key is missing / song not found.
    """
    api_key = os.environ.get("GETSONGBPM_API_KEY", "")
    if not api_key:
        return None

    try:
        lookup = urllib.parse.quote_plus(f"{artist} {title}".strip())
        url = f"https://api.getsongbpm.com/search/?api_key={api_key}&type=song&lookup={lookup}"
        req = urllib.request.Request(url, headers={"User-Agent": "MashUp/1.0"})
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read().decode())

        songs = data.get("search") or []
        if not songs:
            return None

        song = songs[0]
        bpm = song.get("tempo")
        key_str = song.get("key_of", "")

        if not bpm:
            return None

        bpm = round(float(bpm), 1)
        parsed = _parse_key_string(key_str)
        if parsed is None:
            return {"bpm": bpm, "key": None, "key_name": None, "mode": None}

        key_idx, mode = parsed
        key_name = f"{KEY_NAMES[key_idx]} {'major' if mode == 1 else 'minor'}"
        return {"bpm": bpm, "key": key_idx, "key_name": key_name, "mode": mode}

    except Exception as exc:
        logger.warning("GetSongBPM lookup failed: %s", exc)
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


def _yt_title_matches_track(yt_title: str, sp_artist: str, sp_title: str) -> bool:
    """
    Return True if the YouTube video title is plausibly consistent with the
    Spotify-confirmed artist and song title.

    We check that at least one significant word from the Spotify artist AND
    one significant word from the Spotify title appear in the YouTube title.
    Short/common words (≤3 chars) are skipped to avoid false positives.
    """
    if not yt_title or not sp_artist or not sp_title:
        return True  # Can't check; assume OK

    yt = yt_title.lower()
    sig = lambda s: [w.lower() for w in s.split() if len(w) > 3]

    artist_words = sig(sp_artist)
    title_words = sig(sp_title)

    artist_ok = not artist_words or any(w in yt for w in artist_words)
    title_ok = not title_words or any(w in yt for w in title_words)
    return artist_ok and title_ok


def enrich_video(video_id: str) -> dict:
    """
    Full enrichment pipeline for a YouTube video ID.

    Cross-validates the YouTube video against the Spotify-matched track.
    If the video title doesn't match the Spotify artist/title (e.g. the user
    pasted the wrong URL), audio analysis falls back to searching YouTube for
    the canonical version of the Spotify-confirmed song — preventing BPM/key
    data from a completely different song corrupting the card.

    Returns a dict suitable for the /api/enrich response.
    All fields are present; unknown values are None.
    """
    from .catalog import search_yt_video_id

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

    # The video ID we'll actually download for audio analysis.
    # Starts as the user's pasted video; may be replaced by a canonical search.
    audio_vid = video_id

    if title:
        # ── Step 1: Spotify — metadata only (album art + confirmed artist/title) ──
        spotify = search_spotify(artist, title)
        if spotify:
            sp_artist = spotify.get("spotify_artist") or artist
            sp_title = spotify.get("spotify_title") or title

            result.update({
                "album_art": spotify["album_art"],
                "spotify_id": spotify["spotify_id"],
                "artist": sp_artist or None,
                "title": sp_title or None,
            })

            # Cross-validate: does the user's YouTube video match Spotify's result?
            if not _yt_title_matches_track(yt_title or "", sp_artist, sp_title):
                logger.warning(
                    "YouTube title %r doesn't match Spotify track %r – %r; "
                    "searching for canonical video for audio analysis.",
                    yt_title, sp_artist, sp_title,
                )
                canonical = search_yt_video_id(sp_artist, sp_title)
                if canonical:
                    audio_vid = canonical

        effective_artist = result["artist"] or artist
        effective_title = result["title"] or title

        # ── Step 2: GetSongBPM — exact BPM + key from crowdsourced database ──
        bpm_data = get_song_bpm(effective_artist, effective_title)
        if bpm_data:
            result.update({
                "bpm": bpm_data["bpm"],
                "key": bpm_data["key"],
                "key_name": bpm_data["key_name"],
                "mode": bpm_data["mode"],
            })
            logger.info("GetSongBPM: %s – %s → %s BPM %s",
                        effective_artist, effective_title,
                        bpm_data["bpm"], bpm_data["key_name"])

        # ── Step 3: Lyrics ──────────────────────────────────────────────────
        lyrics = get_lyrics_genius(effective_artist, effective_title)
        if lyrics is None:
            lyrics = get_lyrics_lrclib(effective_artist, effective_title)
        result["lyrics_full"] = lyrics
        result["lyrics_snippet"] = _lyrics_snippet(lyrics)

    # ── Step 4: Essentia local analysis — fallback if GetSongBPM had no data ──
    if result["bpm"] is None:
        result.update(_analyze_youtube_clip(audio_vid))

    return result


def _analyze_youtube_clip(video_id: str) -> dict:
    """
    Download 60 seconds of audio from a YouTube video (skipping the first 30s
    to avoid unrepresentative intros) and extract BPM + key.

    Uses 44100 Hz sample rate for better frequency resolution. Falls back to
    librosa if Essentia is unavailable.
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

        with tempfile.TemporaryDirectory() as tmpdir:
            out_tmpl = str(_P(tmpdir) / "clip.%(ext)s")
            _sp.run(
                [
                    ytdlp,
                    f"https://www.youtube.com/watch?v={video_id}",
                    "-x",
                    "--audio-format", "wav",
                    "--audio-quality", "5",
                    # Skip first 30s (intro/silence), analyse next 60s of real content
                    "--download-sections", "*30-90",
                    "--force-keyframes-at-cuts",
                    "-o", out_tmpl,
                    "--no-playlist",
                    "--quiet",
                ],
                capture_output=True,
                text=True,
                timeout=120,
            )
            wavs = list(_P(tmpdir).glob("*.wav"))
            if not wavs:
                # Song may be shorter than 30s — fall back to the beginning
                _sp.run(
                    [ytdlp, f"https://www.youtube.com/watch?v={video_id}",
                     "-x", "--audio-format", "wav", "--audio-quality", "5",
                     "--download-sections", "*0-60",
                     "--force-keyframes-at-cuts", "-o", out_tmpl,
                     "--no-playlist", "--quiet"],
                    capture_output=True, text=True, timeout=120,
                )
                wavs = list(_P(tmpdir).glob("*.wav"))
                if not wavs:
                    return {}

            # 44100 Hz gives better frequency resolution than 22050 Hz
            y, sr = librosa.load(str(wavs[0]), sr=44100, mono=True)

        return _extract_bpm_key(y, sr)
    except Exception as exc:
        logger.warning("YouTube clip BPM analysis failed: %s", exc)
        return {}
