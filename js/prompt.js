/**
 * AI music prompt generator — builds a professional prompt from mixer state
 * suitable for Lyria 3, Suno, Udio, or similar AI music tools.
 * No artist names or song titles are included.
 */

const KEY_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Semitone intervals for major and natural minor scales
const MAJOR_INTERVALS = [0, 2, 4, 5, 7, 9, 11];
const MINOR_INTERVALS = [0, 2, 3, 5, 7, 8, 10];

// Chord qualities (suffix) for each scale degree
const MAJOR_QUALITIES = ['', 'm', 'm', '', '', 'm', 'dim'];
const MINOR_QUALITIES = ['m', 'dim', '', 'm', 'm', '', ''];

// Roman numeral labels per degree
const MAJOR_NUMERALS = ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°'];
const MINOR_NUMERALS = ['i', 'ii°', 'III', 'iv', 'v', 'VI', 'VII'];

function keyLabel(key, mode) {
  if (key == null) return null;
  const note = KEY_NAMES[key % 12];
  if (mode === 1) return `${note} major`;
  if (mode === 0) return `${note} minor`;
  return note;
}

/**
 * Returns full harmonic context for a key: scale notes, chord names, common progressions.
 */
function buildHarmonicContext(key, mode) {
  if (key == null || mode == null) return null;

  const intervals = mode === 1 ? MAJOR_INTERVALS : MINOR_INTERVALS;
  const qualities = mode === 1 ? MAJOR_QUALITIES : MINOR_QUALITIES;
  const numerals = mode === 1 ? MAJOR_NUMERALS : MINOR_NUMERALS;

  const scaleNotes = intervals.map(i => KEY_NAMES[(key + i) % 12]);
  const chordNames = scaleNotes.map((n, i) => n + qualities[i]);

  // Root note for melodic anchoring
  const root = KEY_NAMES[key % 12];

  // Two common progressions per tonality with roman numerals + chord names
  let prog1, prog2;
  if (mode === 1) {
    // I–V–vi–IV  (most common pop major)
    prog1 = [[0,4,5,3].map(i => chordNames[i]).join(' — '),
             [0,4,5,3].map(i => numerals[i]).join(' — ')];
    // I–IV–V–I
    prog2 = [[0,3,4,0].map(i => chordNames[i]).join(' — '),
             [0,3,4,0].map(i => numerals[i]).join(' — ')];
  } else {
    // i–VI–III–VII
    prog1 = [[0,5,2,6].map(i => chordNames[i]).join(' — '),
             [0,5,2,6].map(i => numerals[i]).join(' — ')];
    // i–iv–VII–III
    prog2 = [[0,3,6,2].map(i => chordNames[i]).join(' — '),
             [0,3,6,2].map(i => numerals[i]).join(' — ')];
  }

  return { root, scaleNotes, chordNames, prog1, prog2, numerals };
}

function avg(nums) {
  const valid = nums.filter(v => v != null);
  if (!valid.length) return null;
  return valid.reduce((s, v) => s + v, 0) / valid.length;
}

function energyAdj(e) {
  if (e == null) return null;
  if (e > 0.85) return 'explosive and intense';
  if (e > 0.68) return 'energetic and driving';
  if (e > 0.48) return 'dynamic';
  if (e > 0.3)  return 'mellow and laid-back';
  return 'ambient and serene';
}

function valenceAdj(v) {
  if (v == null) return null;
  if (v > 0.78) return 'euphoric and exhilarating';
  if (v > 0.58) return 'uplifting and optimistic';
  if (v > 0.38) return 'emotionally nuanced';
  if (v > 0.18) return 'melancholic and introspective';
  return 'dark and brooding';
}

function inferGenre(e, v, d, bpm) {
  if (e == null) {
    if (bpm >= 130) return 'electronic dance';
    if (bpm >= 105) return 'contemporary pop';
    return 'modern pop';
  }
  if (e > 0.78 && bpm >= 125 && d > 0.6) return 'electronic dance';
  if (e > 0.72 && bpm >= 130) return 'high-energy pop';
  if (e > 0.62 && d > 0.68 && bpm >= 95) return 'uptempo pop';
  if (e > 0.62 && (v == null || v < 0.42)) return 'alternative pop';
  if (e > 0.55 && bpm >= 90) return 'dynamic pop';
  if (e < 0.38 && (v == null || v < 0.42)) return 'atmospheric indie';
  if (e < 0.42 && bpm < 95) return 'downtempo pop';
  if (d != null && d > 0.7 && bpm >= 90) return 'groove-forward pop';
  return 'contemporary pop';
}

function feelSentence(e, v, d) {
  const parts = [];
  if (d != null) {
    if (d > 0.74) parts.push('highly danceable with a propulsive rhythmic pulse');
    else if (d > 0.55) parts.push('rhythmically engaging and groove-forward');
  }
  if (e != null && v != null) {
    if (e > 0.62 && v > 0.58) parts.push('emotionally charged and triumphant');
    else if (e > 0.58 && v < 0.38) parts.push('intense with brooding emotional depth');
    else if (e < 0.42 && v > 0.58) parts.push('warm and gently uplifting');
    else if (e < 0.42 && v < 0.38) parts.push('contemplative and emotionally complex');
  }
  return parts.length ? parts.join(', with ') + '.' : null;
}

function componentDesc(compId, song, harmonic) {
  const e = song.energy;
  const v = song.valence;
  const d = song.danceability;
  const minor = song.mode === 0;
  const root = harmonic?.root ?? null;

  switch (compId) {
    case 'drums': {
      const hit = e > 0.72 ? 'heavy, thunderous' : e > 0.48 ? 'crisp and punchy' : 'sparse, brushed';
      const groove = d > 0.7 ? 'syncopated groove with driving hi-hats' : d > 0.48 ? 'solid four-on-the-floor pattern' : 'open, spacious kit feel';
      return `${hit} drum kit — ${groove}, snappy snare, and tight low-end kick`;
    }
    case 'bass': {
      const weight = e > 0.68 ? 'thick, saturated' : e > 0.44 ? 'round, warm' : 'soft, melodic';
      const motion = minor ? 'dark chromatic movement' : 'smooth tonal movement';
      const rootHint = root ? `, rooted on ${root}` : '';
      return `${weight} bassline with ${motion}${rootHint}, locking firmly with the kick`;
    }
    case 'vocals': {
      const delivery = e > 0.68 ? 'powerful, full-voice delivery' : e > 0.44 ? 'smooth, emotive singing' : 'delicate, intimate tone';
      const mood = v > 0.62 ? 'soaring and uplifting' : v > 0.4 ? 'nuanced and expressive' : 'haunting and melancholic';
      const rootHint = root ? ` — melodic phrases anchored to the ${root} root` : '';
      return `${mood} lead vocals with ${delivery}${rootHint}`;
    }
    case 'melody': {
      const char = e > 0.65 ? 'bright and forward-driving' : e > 0.42 ? 'flowing and melodic' : 'gentle and ethereal';
      const tonality = minor ? 'minor-key, bittersweet' : 'major-key, uplifting';
      const noteHint = harmonic ? ` using notes from the ${harmonic.scaleNotes.join('–')} scale` : '';
      return `${char} ${tonality} melodic lead carrying the main hook${noteHint}`;
    }
    case 'harmony': {
      const texture = e > 0.58 ? 'lush, full-bodied' : 'soft, airy';
      const quality = minor ? 'minor-key' : 'major-key';
      const chordHint = harmonic ? ` (${harmonic.chordNames.slice(0, 4).join(', ')})` : '';
      return `${texture} ${quality} chord voicings${chordHint} providing harmonic depth`;
    }
    case 'pads': {
      const motion = e > 0.62 ? 'pulsating, slowly-evolving' : 'vast, slowly-drifting';
      const color = minor ? 'dark, cinematic' : 'warm, luminous';
      return `${motion} ${color} pad layers creating depth and atmosphere`;
    }
    case 'percussion': {
      const density = d > 0.7 ? 'intricate, multi-layered' : d > 0.48 ? 'rhythmic and textural' : 'sparse, accent-driven';
      return `${density} percussion with shakers, claps, and tonal hits weaving rhythmic texture`;
    }
    case 'fx': {
      const style = e > 0.62
        ? 'sweeping upward risers, reverse cymbal splashes, and side-chained noise bursts'
        : 'subtle atmospheric sweeps, long reverb tails, and gentle pitch-shifted transitions';
      return `${style} for dynamic tension and release`;
    }
    case 'other':
      return 'additional textural and harmonic elements complementing the arrangement';
    default:
      return 'musical element';
  }
}

function productionNote(e, v, d, bpm) {
  const parts = [];
  if (e != null) {
    if (e > 0.7) parts.push('polished, high-impact mix with wide stereo field and prominent low-end');
    else if (e > 0.45) parts.push('balanced, dynamic mix with clear stereo separation');
    else parts.push('intimate, detailed mix with emphasis on space and texture');
  } else {
    parts.push('clean, modern production');
  }
  if (bpm >= 125) parts.push('club-ready with tight, punchy transients');
  if (d != null && d > 0.68) parts.push('strong rhythmic groove throughout');
  if (v != null && v < 0.35) parts.push('cinematic and emotionally evocative atmosphere');
  return parts.join('; ');
}

/**
 * Ensure lyrics have section markers. If none are found, wrap the whole text
 * so the AI knows this is a vocal part with structure.
 */
function structureLyrics(raw) {
  const sectionPattern = /^\[.+\]/m;
  if (sectionPattern.test(raw)) return raw.trim();

  // No markers — heuristically split on blank lines into verses/chorus
  const blocks = raw.trim().split(/\n\s*\n/).filter(b => b.trim());
  if (blocks.length <= 1) return raw.trim();

  // Label: first block = Verse 1, middle blocks alternate Chorus / Verse, last = Outro if only one line
  const labeled = blocks.map((block, i) => {
    let label;
    if (i === 0) label = 'Verse 1';
    else if (i === blocks.length - 1 && block.split('\n').length <= 2) label = 'Outro';
    else label = i % 2 === 0 ? `Verse ${Math.ceil(i / 2) + 1}` : 'Chorus';
    return `[${label}]\n${block.trim()}`;
  });
  return labeled.join('\n\n');
}

const COMP_ORDER = ['vocals', 'drums', 'bass', 'melody', 'harmony', 'pads', 'percussion', 'fx', 'other'];
const COMP_LABEL = {
  vocals: 'Vocals', drums: 'Drums', bass: 'Bass', melody: 'Melody',
  harmony: 'Harmony', pads: 'Pads', percussion: 'Percussion', fx: 'FX', other: 'Other',
};

export function generateMusicPrompt(state) {
  const tracks = (state.mashup.tracks || []).filter(t => (t.claimedComponents || []).length > 0);
  if (!tracks.length) return '';

  const bpm = Math.round(state.mashup.bpm || 120);

  // Map component → song
  const compMap = new Map();
  for (const track of tracks) {
    const song = state.songs.find(s => s.id === track.songId);
    if (!song) continue;
    for (const comp of (track.claimedComponents || [])) {
      compMap.set(comp, song);
    }
  }

  if (!compMap.size) return '';

  const allSongs = [...new Set(compMap.values())];

  // Key: prefer vocal track's key
  let keyStr = null;
  let harmonic = null;
  const vocalSong = compMap.get('vocals');
  if (vocalSong) {
    keyStr = keyLabel(vocalSong.key, vocalSong.mode);
    harmonic = buildHarmonicContext(vocalSong.key, vocalSong.mode);
  }
  if (!keyStr) {
    for (const s of allSongs) {
      const k = keyLabel(s.key, s.mode);
      if (k) {
        keyStr = k;
        harmonic = buildHarmonicContext(s.key, s.mode);
        break;
      }
    }
  }

  // Override prog1 with actual detected chords when available
  if (harmonic) {
    const trackAnalysis = state.mashup.generation?.trackAnalysis ?? [];
    // Prefer the vocal track's analysis, fall back to first available
    const vocalTrack = tracks.find(t => (t.claimedComponents || []).includes('vocals'));
    const leadAnalysis = trackAnalysis.find(a => a.track_id === (vocalTrack?.id ?? ''))
      || trackAnalysis[0];
    const rawChords = leadAnalysis?.chords;
    if (rawChords?.length) {
      // Count chord occurrences (exclude "N" — no chord)
      const counts = {};
      for (const { chord } of rawChords) {
        if (chord !== 'N') counts[chord] = (counts[chord] || 0) + 1;
      }
      // Take up to 6 most frequent, format nicely ("Cmaj" → "C", "Amin" → "Am")
      const top = Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([c]) => c.endsWith('min') ? c.slice(0, -3) + 'm' : c.endsWith('maj') ? c.slice(0, -3) : c);
      if (top.length >= 2) {
        harmonic = { ...harmonic, prog1: [top.join(' – '), 'detected from audio'] };
      }
    }
  }

  const avgE = avg(allSongs.map(s => s.energy));
  const avgV = avg(allSongs.map(s => s.valence));
  const avgD = avg(allSongs.map(s => s.danceability));

  const genre = inferGenre(avgE, avgV, avgD, bpm);
  const eAdj = energyAdj(avgE);
  const vAdj = valenceAdj(avgV);

  const lines = [];

  // ── Opening ──────────────────────────────────────────────────────────────
  const adjParts = [eAdj, vAdj].filter(Boolean);
  const adjStr = adjParts.length ? adjParts.join(', ') + ' ' : '';
  lines.push(`A ${adjStr}${genre} track at ${bpm} BPM${keyStr ? ` in ${keyStr}` : ''}.`);

  const feel = feelSentence(avgE, avgV, avgD);
  if (feel) lines.push(feel);

  // ── Harmonic context (key + scale + chords) ───────────────────────────────
  if (harmonic) {
    lines.push('');
    lines.push('Harmonic reference (follow strictly):');
    lines.push(`• Key: ${keyStr}`);
    lines.push(`• Scale notes: ${harmonic.scaleNotes.join('  ')}`);
    lines.push(`• Root / tonal centre: ${harmonic.root}`);
    lines.push(`• Primary chord progression: ${harmonic.prog1[0]}  (${harmonic.prog1[1]})`);
    lines.push(`• Alternate progression:     ${harmonic.prog2[0]}  (${harmonic.prog2[1]})`);
    lines.push(`• Diatonic chords available: ${harmonic.chordNames.map((c, i) => `${harmonic.numerals[i]}=${c}`).join('  ')}`);
  }

  // ── Instrumentation ───────────────────────────────────────────────────────
  lines.push('');
  lines.push('Instrumentation:');

  for (const compId of COMP_ORDER) {
    if (!compMap.has(compId)) continue;
    const song = compMap.get(compId);
    const desc = componentDesc(compId, song, harmonic);
    lines.push(`• ${COMP_LABEL[compId]}: ${desc}.`);
  }

  // ── Lyrics ────────────────────────────────────────────────────────────────
  if (compMap.has('vocals') && vocalSong) {
    const raw = vocalSong.lyricsFull || vocalSong.lyricsSnippet;
    if (raw && raw.trim()) {
      lines.push('');
      lines.push('Vocals — sing these exact lyrics word for word, do not improvise or substitute:');
      const structured = structureLyrics(raw.trim());
      const capped = structured.length > 1600 ? structured.slice(0, 1600).trimEnd() + '\n[…]' : structured;
      lines.push(capped);
    }
  }

  // ── Production note ───────────────────────────────────────────────────────
  lines.push('');
  lines.push(`Production style: ${productionNote(avgE, avgV, avgD, bpm)}.`);

  return lines.join('\n');
}
