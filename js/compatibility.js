/**
 * Pure compatibility scoring functions — no DOM, no store.
 *
 * Uses key (0-11), mode (0=minor/1=major), bpm, energy, danceability, valence.
 */

// ── Camelot Wheel ────────────────────────────────────────────────────────────
// Maps (key_idx * 2 + mode) to Camelot notation.
// Minor keys = A, Major keys = B. Numbers follow the circle of fifths.
//
// Camelot #:  1   2   3   4   5   6   7   8   9  10  11  12
// Minor (A): Ab  Eb  Bb   F   C   G   D   A   E   B  F#  C#
// Major (B):  B  F#  Db  Ab  Eb  Bb   F   C   G   D   A   E
//
// Encoded as [key_idx][mode] → camelot number (1-12)
const _CAM_NUM = [
  //  min maj  (key index 0=C … 11=B)
  [5,  8],  // 0  C
  [12, 3],  // 1  C#/Db
  [7,  10], // 2  D
  [2,  5],  // 3  D#/Eb
  [9,  12], // 4  E
  [4,  7],  // 5  F
  [11, 2],  // 6  F#/Gb
  [6,  9],  // 7  G
  [1,  4],  // 8  G#/Ab
  [8,  11], // 9  A
  [3,  6],  // 10 A#/Bb
  [10, 1],  // 11 B
];

/**
 * Convert a Spotify key integer + mode to Camelot notation.
 * @param {number|null} key  0–11
 * @param {number|null} mode 0=minor, 1=major
 * @returns {string|null}  e.g. "4A", "8B"
 */
export function toCamelot(key, mode) {
  if (key == null || key < 0 || mode == null) return null;
  const num = _CAM_NUM[key % 12][mode === 1 ? 1 : 0];
  return `${num}${mode === 1 ? 'B' : 'A'}`;
}

/**
 * Camelot distance between two songs (0 = perfect match, 1 = adjacent,
 * 2+ = increasing clash).  Same-number A↔B (relative minor/major) = 1.
 * @returns {number} 0–6
 */
export function camelotDistance(key1, mode1, key2, mode2) {
  if (key1 == null || key2 == null) return 3;
  const n1 = _CAM_NUM[key1 % 12][mode1 === 1 ? 1 : 0];
  const n2 = _CAM_NUM[key2 % 12][mode2 === 1 ? 1 : 0];
  // Same number, different letter = relative major/minor = distance 1
  if (n1 === n2 && mode1 !== mode2) return 1;
  // Both same = perfect
  if (n1 === n2 && mode1 === mode2) return 0;
  // Circular distance on the 12-position wheel
  const diff = Math.abs(n1 - n2);
  return Math.min(diff, 12 - diff);
}

// Circle of fifths positions (kept for backward compat with circleOfFifthsDistance)
const COF_MAJOR = [0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5];
const COF_MINOR = COF_MAJOR.map((pos) => (pos + 9) % 12);

/**
 * Distance between two keys on the circle of fifths (0 = identical, 6 = tritone).
 * Accounts for relative major/minor relationships (e.g. C major ↔ A minor = 0 distance).
 *
 * @param {number} key1  Spotify key integer 0-11 (-1 = unknown)
 * @param {number} mode1 Spotify mode 1=major 0=minor
 * @param {number} key2
 * @param {number} mode2
 * @returns {number} 0–6
 */
export function circleOfFifthsDistance(key1, mode1, key2, mode2) {
  if (key1 < 0 || key2 < 0) return 3; // unknown → neutral
  const table1 = mode1 === 1 ? COF_MAJOR : COF_MINOR;
  const table2 = mode2 === 1 ? COF_MAJOR : COF_MINOR;
  const pos1 = table1[key1 % 12];
  const pos2 = table2[key2 % 12];
  const diff = Math.abs(pos1 - pos2);
  return Math.min(diff, 12 - diff);
}

/**
 * Aggregate key compatibility for all songs that have key/mode data.
 *
 * @param {Array<{key: number|null, mode: number|null, keyName: string|null}>} songs
 * @returns {{ label: string, colorClass: string, detail: string }}
 */
export function keyCompatibility(songs) {
  const keyed = songs.filter((s) => s.key != null && s.mode != null);
  if (keyed.length < 2) {
    return { label: 'No key data', colorClass: 'compat--neutral', detail: '' };
  }

  let maxDist = 0;
  for (let i = 0; i < keyed.length; i++) {
    for (let j = i + 1; j < keyed.length; j++) {
      const d = camelotDistance(keyed[i].key, keyed[i].mode, keyed[j].key, keyed[j].mode);
      if (d > maxDist) maxDist = d;
    }
  }

  // Show Camelot notations in the detail string
  const cams = keyed.map((s) => toCamelot(s.key, s.mode)).filter(Boolean).join(' × ');
  const detail = cams;

  if (maxDist === 0) return { label: 'Perfect match', colorClass: 'compat--good', detail };
  if (maxDist === 1) return { label: 'Compatible', colorClass: 'compat--good', detail };
  if (maxDist === 2) return { label: 'Needs pitch shift', colorClass: 'compat--warn', detail };
  return { label: 'Clashing — outside shift range', colorClass: 'compat--bad', detail };
}

/**
 * Vibe compatibility — energy + valence delta across all mixer songs.
 * Returns null when fewer than 2 songs have Spotify audio features.
 *
 * @param {Array<{energy: number|null, valence: number|null, danceability: number|null}>} songs
 * @returns {{ label: string, colorClass: string, detail: string } | null}
 */
export function vibeCompatibility(songs) {
  const featured = songs.filter((s) => s.energy != null && s.valence != null);
  if (featured.length < 2) return null;

  let maxEnergyDiff = 0;
  let maxValenceDiff = 0;
  for (let i = 0; i < featured.length; i++) {
    for (let j = i + 1; j < featured.length; j++) {
      maxEnergyDiff = Math.max(maxEnergyDiff, Math.abs(featured[i].energy - featured[j].energy));
      maxValenceDiff = Math.max(maxValenceDiff, Math.abs(featured[i].valence - featured[j].valence));
    }
  }

  const score = (maxEnergyDiff + maxValenceDiff) / 2;
  const detail = `energy Δ${Math.round(maxEnergyDiff * 100)}% · mood Δ${Math.round(maxValenceDiff * 100)}%`;

  if (score <= 0.15) return { label: 'Matching vibe', colorClass: 'compat--good', detail };
  if (score <= 0.35) return { label: 'Similar vibe', colorClass: 'compat--good', detail };
  if (score <= 0.55) return { label: 'Mixed vibe', colorClass: 'compat--warn', detail };
  return { label: 'Contrasting vibe', colorClass: 'compat--bad', detail };
}

/**
 * BPM stretch percentage from a song's native BPM to the target.
 * @param {number|null} songBpm
 * @param {number} targetBpm
 * @returns {number} absolute stretch percentage (0 = no stretch)
 */
export function bpmStretchPct(songBpm, targetBpm) {
  if (!songBpm || !targetBpm || songBpm <= 0 || targetBpm <= 0) return 0;
  return Math.round(Math.abs((targetBpm / songBpm - 1) * 100));
}

/**
 * Return the worst-case BPM stretch across all songs in the mixer.
 * @param {Array<{bpm: number|null}>} songs
 * @param {number} targetBpm
 * @returns {{ pct: number, worstSong: object|null }}
 */
export function worstBpmStretch(songs, targetBpm) {
  let worst = 0;
  let worstSong = null;
  for (const s of songs) {
    const pct = bpmStretchPct(s.bpm, targetBpm);
    if (pct > worst) {
      worst = pct;
      worstSong = s;
    }
  }
  return { pct: worst, worstSong };
}

/**
 * Raw component scores for a song — lower level than suggestComponents.
 * Used for relative comparisons across tracks.
 *
 * @param {{ energy?: number, danceability?: number, valence?: number }} song
 * @returns {Record<string, number>}
 */
export function scoreComponents(song) {
  const e = (song.energy ?? 0.5);
  const d = (song.danceability ?? 0.5);
  const v = (song.valence ?? 0.5);
  return {
    drums:      e * 0.5 + d * 0.5,
    bass:       d * 0.5 + (1 - v) * 0.3 + e * 0.2,
    vocals:     e * 0.4 + v * 0.4 + d * 0.2,
    melody:     v * 0.5 + (1 - e) * 0.3 + d * 0.2,
    harmony:    v * 0.4 + (1 - e) * 0.4 + (1 - d) * 0.2,
    pads:       (1 - e) * 0.5 + (1 - d) * 0.3 + v * 0.2,
    percussion: d * 0.4 + e * 0.4 + (1 - v) * 0.2,
    fx:         e * 0.4 + (1 - d) * 0.4 + v * 0.2,
    other:      0.2,
  };
}

/**
 * Suggest which component IDs are a good fit for a song based on its
 * Spotify audio features. Returns an ordered array of component IDs.
 *
 * @param {{ energy: number|null, danceability: number|null, valence: number|null }} song
 * @returns {string[]}
 */
export function suggestComponents(song) {
  const scores = scoreComponents(song);
  return Object.entries(scores)
    .filter(([, score]) => score > 0.45)
    .sort(([, a], [, b]) => b - a)
    .map(([id]) => id);
}

/**
 * Given multiple tracks (each with a song), compute which track "wins"
 * each component — i.e. has the highest score for it among all tracks.
 * Only marks a component as suggested if it scores above `minScore`.
 *
 * @param {Array<{ id: string, song: object|null }>} trackSongs  array of {id, song} pairs
 * @returns {Map<string, Set<string>>}  trackId → Set of component IDs it should show ★ for
 */
export function computeRelativeSuggestions(trackSongs, minScore = 0.42) {
  const COMP_IDS = ['drums', 'bass', 'vocals', 'melody', 'harmony', 'pads', 'percussion', 'fx', 'other'];

  // Build feature-enriched song for each track (real or estimated)
  const enriched = trackSongs.map(({ id, song }) => {
    if (!song) return { id, scores: null };
    const hasFeat = song.energy != null;
    const sf = hasFeat
      ? song
      : song.bpm != null || song.mode != null
      ? { ...song, ...estimateFeaturesFromMeta(song) }
      : null;
    return { id, scores: sf ? scoreComponents(sf) : null };
  });

  const result = new Map(trackSongs.map(({ id }) => [id, new Set()]));

  for (const compId of COMP_IDS) {
    // Find best score and which track has it
    let bestScore = -1;
    let bestIds = [];
    for (const { id, scores } of enriched) {
      if (!scores) continue;
      const s = scores[compId];
      if (s > bestScore) { bestScore = s; bestIds = [id]; }
      else if (s === bestScore) { bestIds.push(id); }
    }
    // Only award ★ when there's a strict winner — ties mean neither song is differentiated
    if (bestScore >= minScore && bestIds.length === 1) {
      result.get(bestIds[0])?.add(compId);
    }
  }

  return result;
}

/**
 * Estimate energy, danceability, valence from BPM + mode when Spotify
 * audio_features are unavailable (deprecated endpoint for new apps).
 * Returns an object that can be merged into a song for suggestComponents().
 *
 * @param {{ bpm: number|null, mode: number|null }} song
 * @returns {{ energy: number, danceability: number, valence: number } | null}
 */
export function estimateFeaturesFromMeta(song) {
  const bpm = song.bpm;
  const mode = song.mode; // 1 = major, 0 = minor
  if (!bpm && mode == null) return null;

  let energy = 0.5;
  let danceability = 0.5;
  if (bpm) {
    // Energy scales with tempo
    if (bpm < 75) { energy = 0.28; danceability = 0.35; }
    else if (bpm < 95) { energy = 0.42; danceability = 0.52; }
    else if (bpm < 115) { energy = 0.55; danceability = 0.68; }
    else if (bpm < 135) { energy = 0.68; danceability = 0.72; }
    else if (bpm < 155) { energy = 0.78; danceability = 0.62; }
    else { energy = 0.85; danceability = 0.48; }
  }

  // Valence: major keys tend to sound happier
  const valence = mode == null ? 0.5 : mode === 1 ? 0.65 : 0.38;

  return { energy, danceability, valence };
}

/**
 * Given songs in the mixer, compute the smart default target BPM
 * (average of songs that have Spotify BPM data).
 * Returns null if no BPM data available.
 *
 * @param {Array<{bpm: number|null}>} songs
 * @returns {number|null}
 */
export function smartDefaultBpm(songs) {
  const bpms = songs.map((s) => s.bpm).filter((b) => b && b > 30 && b < 300);
  if (bpms.length === 0) return null;
  return Math.round(bpms.reduce((a, b) => a + b, 0) / bpms.length);
}
