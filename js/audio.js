/**
 * Web Audio API engine for programmatic audio generation and playback.
 */

let audioCtx = null;
let masterGain = null;
let analyserNode = null;
let activeSources = new Map(); // trackId -> { source, gain, panner }
let isPlaying = false;
let startTime = 0;
let timerRaf = null;

/**
 * Initialize the AudioContext (must be called from a user gesture).
 */
export function initAudio() {
  if (audioCtx) return audioCtx;

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  masterGain = audioCtx.createGain();
  masterGain.gain.value = 0.8;

  analyserNode = audioCtx.createAnalyser();
  analyserNode.fftSize = 2048;
  analyserNode.smoothingTimeConstant = 0.85;

  masterGain.connect(analyserNode);
  analyserNode.connect(audioCtx.destination);

  return audioCtx;
}

export function getAudioContext() {
  return audioCtx;
}

export function getAnalyser() {
  return analyserNode;
}

export function setMasterVolume(value) {
  if (masterGain) {
    masterGain.gain.setTargetAtTime(value, audioCtx.currentTime, 0.02);
  }
}

/**
 * Generate an AudioBuffer for a given component type.
 * Creates 4 bars of loopable audio at the given BPM.
 */
export function generateComponentAudio(componentId, bpm = 120) {
  if (!audioCtx) initAudio();

  const beatsPerBar = 4;
  const totalBeats = beatsPerBar * 4; // 4 bars
  const beatDuration = 60 / bpm;
  const totalDuration = totalBeats * beatDuration;
  const sampleRate = audioCtx.sampleRate;
  const length = Math.ceil(totalDuration * sampleRate);
  const buffer = audioCtx.createBuffer(2, length, sampleRate);

  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);

  switch (componentId) {
    case 'beat':
    case 'rhythm':
    case 'meter':
      generatePercussive(left, right, sampleRate, bpm, totalBeats, componentId);
      break;
    case 'tempo':
      generateClick(left, right, sampleRate, bpm, totalBeats);
      break;
    case 'melody':
      generateMelody(left, right, sampleRate, bpm, totalBeats);
      break;
    case 'harmony':
    case 'key_scale':
      generateChordPad(left, right, sampleRate, bpm, totalBeats, componentId);
      break;
    case 'pitch':
      generatePitchSweep(left, right, sampleRate, bpm, totalDuration);
      break;
    case 'timbre':
      generateTimbre(left, right, sampleRate, bpm, totalBeats);
      break;
    case 'dynamics':
      generateDynamics(left, right, sampleRate, bpm, totalDuration);
      break;
    case 'articulation':
      generateArticulation(left, right, sampleRate, bpm, totalBeats);
      break;
    case 'texture':
      generateTexture(left, right, sampleRate, bpm, totalDuration);
      break;
    case 'form':
      generateForm(left, right, sampleRate, bpm, totalDuration);
      break;
    default:
      generateMelody(left, right, sampleRate, bpm, totalBeats);
  }

  return buffer;
}

// --- Audio generation helpers ---

function generatePercussive(left, right, sr, bpm, totalBeats, type) {
  const beatLen = (60 / bpm) * sr;

  for (let beat = 0; beat < totalBeats; beat++) {
    const offset = Math.floor(beat * beatLen);

    // Kick on every beat
    const kickLen = Math.min(Math.floor(0.08 * sr), left.length - offset);
    for (let i = 0; i < kickLen; i++) {
      const t = i / sr;
      const freq = 150 * Math.exp(-30 * t);
      const env = Math.exp(-20 * t);
      const val = Math.sin(2 * Math.PI * freq * t) * env * 0.5;
      if (offset + i < left.length) {
        left[offset + i] += val;
        right[offset + i] += val;
      }
    }

    // Snare on beats 1, 3 (0-indexed)
    if (type === 'beat' && beat % 2 === 1) {
      const snareLen = Math.min(Math.floor(0.1 * sr), left.length - offset);
      for (let i = 0; i < snareLen; i++) {
        const t = i / sr;
        const env = Math.exp(-15 * t);
        const noise = (Math.random() * 2 - 1) * 0.3 * env;
        const tone = Math.sin(2 * Math.PI * 200 * t) * env * 0.2;
        if (offset + i < left.length) {
          left[offset + i] += noise + tone;
          right[offset + i] += noise + tone;
        }
      }
    }

    // Hi-hat on 8th notes for rhythm
    if (type === 'rhythm' || type === 'meter') {
      const subOffset = Math.floor(offset + beatLen / 2);
      const hhLen = Math.min(Math.floor(0.03 * sr), left.length - subOffset);
      for (let i = 0; i < hhLen && subOffset + i < left.length; i++) {
        const t = i / sr;
        const env = Math.exp(-40 * t);
        const noise = (Math.random() * 2 - 1) * 0.15 * env;
        left[subOffset + i] += noise;
        right[subOffset + i] += noise;
      }
    }

    // Accent pattern for meter
    if (type === 'meter' && beat % 4 === 0) {
      const accentLen = Math.min(Math.floor(0.05 * sr), left.length - offset);
      for (let i = 0; i < accentLen && offset + i < left.length; i++) {
        const t = i / sr;
        const env = Math.exp(-25 * t);
        const val = Math.sin(2 * Math.PI * 800 * t) * env * 0.2;
        left[offset + i] += val;
        right[offset + i] += val;
      }
    }
  }
}

function generateClick(left, right, sr, bpm, totalBeats) {
  const beatLen = (60 / bpm) * sr;
  for (let beat = 0; beat < totalBeats; beat++) {
    const offset = Math.floor(beat * beatLen);
    const clickLen = Math.min(Math.floor(0.015 * sr), left.length - offset);
    const freq = beat % 4 === 0 ? 1200 : 800;
    const amp = beat % 4 === 0 ? 0.4 : 0.25;
    for (let i = 0; i < clickLen && offset + i < left.length; i++) {
      const t = i / sr;
      const env = Math.exp(-80 * t);
      const val = Math.sin(2 * Math.PI * freq * t) * env * amp;
      left[offset + i] = val;
      right[offset + i] = val;
    }
  }
}

function generateMelody(left, right, sr, bpm, totalBeats) {
  const beatLen = (60 / bpm) * sr;
  // C major pentatonic melody pattern
  const notes = [261.63, 293.66, 329.63, 392.0, 440.0, 523.25, 440.0, 392.0,
                 329.63, 392.0, 440.0, 329.63, 293.66, 261.63, 329.63, 293.66];
  const durations = [1, 0.5, 0.5, 1, 1, 0.5, 0.5, 1, 1, 0.5, 0.5, 1, 0.5, 0.5, 1, 1];

  let currentBeat = 0;
  for (let n = 0; n < notes.length && currentBeat < totalBeats; n++) {
    const offset = Math.floor(currentBeat * beatLen);
    const dur = durations[n % durations.length] * beatLen;
    const noteLen = Math.min(Math.floor(dur * 0.9), left.length - offset);

    for (let i = 0; i < noteLen && offset + i < left.length; i++) {
      const t = i / sr;
      const noteDur = noteLen / sr;
      // ADSR-ish envelope
      let env;
      const attackT = 0.01, releaseT = 0.05;
      if (t < attackT) env = t / attackT;
      else if (t > noteDur - releaseT) env = (noteDur - t) / releaseT;
      else env = 1;
      env = Math.max(0, Math.min(1, env)) * 0.3;

      const val = Math.sin(2 * Math.PI * notes[n] * t) * env +
                  Math.sin(2 * Math.PI * notes[n] * 2 * t) * env * 0.15; // slight overtone
      left[offset + i] += val;
      right[offset + i] += val;
    }
    currentBeat += durations[n % durations.length];
  }
}

function generateChordPad(left, right, sr, bpm, totalBeats, type) {
  const beatLen = (60 / bpm) * sr;
  // Chord progression: C - Am - F - G
  const chords = [
    [261.63, 329.63, 392.0],    // C
    [220.0, 261.63, 329.63],    // Am
    [174.61, 220.0, 261.63],    // F
    [196.0, 246.94, 293.66]     // G
  ];

  const beatsPerChord = 4;

  for (let c = 0; c < chords.length; c++) {
    const startBeat = c * beatsPerChord;
    if (startBeat >= totalBeats) break;
    const offset = Math.floor(startBeat * beatLen);
    const chordLen = Math.min(Math.floor(beatsPerChord * beatLen), left.length - offset);

    for (let i = 0; i < chordLen && offset + i < left.length; i++) {
      const t = i / sr;
      const chordDur = chordLen / sr;
      // Soft envelope
      let env = 1;
      if (t < 0.1) env = t / 0.1;
      if (t > chordDur - 0.2) env = Math.max(0, (chordDur - t) / 0.2);
      env *= 0.15;

      let val = 0;
      for (const freq of chords[c]) {
        if (type === 'key_scale') {
          // Use triangle wave for key/scale
          val += triangleWave(freq * t) * env;
        } else {
          // Pad uses detuned sines
          val += Math.sin(2 * Math.PI * freq * t) * env;
          val += Math.sin(2 * Math.PI * freq * 1.003 * t) * env * 0.5; // detune
        }
      }

      left[offset + i] += val;
      right[offset + i] += val;
    }
  }
}

function triangleWave(phase) {
  const p = phase % 1;
  return 4 * Math.abs(p - 0.5) - 1;
}

function generatePitchSweep(left, right, sr, bpm, duration) {
  const length = Math.floor(duration * sr);
  for (let i = 0; i < length && i < left.length; i++) {
    const t = i / sr;
    const freq = 200 + 600 * (0.5 + 0.5 * Math.sin(2 * Math.PI * 0.25 * t));
    const env = 0.2 * (0.5 + 0.5 * Math.sin(2 * Math.PI * 0.5 * t));
    const val = Math.sin(2 * Math.PI * freq * t) * env;
    left[i] = val;
    right[i] = val;
  }
}

function generateTimbre(left, right, sr, bpm, totalBeats) {
  const beatLen = (60 / bpm) * sr;
  const freq = 220;
  for (let beat = 0; beat < totalBeats; beat += 2) {
    const offset = Math.floor(beat * beatLen);
    const noteLen = Math.min(Math.floor(1.5 * beatLen), left.length - offset);
    for (let i = 0; i < noteLen && offset + i < left.length; i++) {
      const t = i / sr;
      const noteDur = noteLen / sr;
      let env = 1;
      if (t < 0.02) env = t / 0.02;
      if (t > noteDur - 0.1) env = Math.max(0, (noteDur - t) / 0.1);
      env *= 0.2;
      // Rich harmonics (saw-ish)
      let val = 0;
      for (let h = 1; h <= 8; h++) {
        val += Math.sin(2 * Math.PI * freq * h * t) / h;
      }
      val *= env;
      left[offset + i] += val;
      right[offset + i] += val;
    }
  }
}

function generateDynamics(left, right, sr, bpm, duration) {
  const length = Math.floor(duration * sr);
  const freq = 330;
  for (let i = 0; i < length && i < left.length; i++) {
    const t = i / sr;
    // Volume swells
    const dynEnv = 0.25 * (0.3 + 0.7 * Math.pow(Math.sin(2 * Math.PI * (bpm / 240) * t), 2));
    const val = Math.sin(2 * Math.PI * freq * t) * dynEnv;
    left[i] += val;
    right[i] += val;
  }
}

function generateArticulation(left, right, sr, bpm, totalBeats) {
  const beatLen = (60 / bpm) * sr;
  const freq = 440;
  for (let beat = 0; beat < totalBeats; beat++) {
    const offset = Math.floor(beat * beatLen);
    // Alternating staccato / legato
    const isStaccato = beat % 2 === 0;
    const noteLen = isStaccato
      ? Math.min(Math.floor(0.1 * beatLen), left.length - offset)
      : Math.min(Math.floor(0.8 * beatLen), left.length - offset);

    for (let i = 0; i < noteLen && offset + i < left.length; i++) {
      const t = i / sr;
      const noteDur = noteLen / sr;
      let env;
      if (isStaccato) {
        env = Math.exp(-20 * t) * 0.3;
      } else {
        env = (t < 0.02 ? t / 0.02 : 1) * Math.max(0, 1 - t / noteDur) * 0.2;
      }
      const val = Math.sin(2 * Math.PI * freq * t) * env;
      left[offset + i] += val;
      right[offset + i] += val;
    }
  }
}

function generateTexture(left, right, sr, bpm, duration) {
  const length = Math.floor(duration * sr);
  const freqs = [220, 277.18, 329.63, 440];
  for (let i = 0; i < length && i < left.length; i++) {
    const t = i / sr;
    let valL = 0, valR = 0;
    for (let f = 0; f < freqs.length; f++) {
      const env = 0.1 * (0.5 + 0.5 * Math.sin(2 * Math.PI * (0.1 + f * 0.07) * t));
      const phase = 2 * Math.PI * freqs[f] * t;
      valL += Math.sin(phase + f * 0.3) * env;
      valR += Math.sin(phase - f * 0.3) * env;
    }
    left[i] += valL;
    right[i] += valR;
  }
}

function generateForm(left, right, sr, bpm, duration) {
  const length = Math.floor(duration * sr);
  const sectionDur = duration / 4;
  const sectionFreqs = [261.63, 329.63, 220, 261.63]; // Verse, Chorus feel, Bridge, Verse
  const sectionAmps = [0.2, 0.3, 0.15, 0.25];

  for (let i = 0; i < length && i < left.length; i++) {
    const t = i / sr;
    const section = Math.min(3, Math.floor(t / sectionDur));
    const sectionT = (t % sectionDur) / sectionDur;

    // Crossfade between sections
    let env = sectionAmps[section];
    if (sectionT < 0.05) env *= sectionT / 0.05;
    if (sectionT > 0.95) env *= (1 - sectionT) / 0.05;

    const freq = sectionFreqs[section];
    const val = (Math.sin(2 * Math.PI * freq * t) +
                 0.5 * Math.sin(2 * Math.PI * freq * 1.5 * t)) * env;
    left[i] += val;
    right[i] += val;
  }
}

// --- Playback engine ---

/**
 * Create a track audio chain: source -> gain -> panner -> masterGain
 */
function createTrackChain(buffer, params) {
  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  source.loop = true;

  const gainNode = audioCtx.createGain();
  gainNode.gain.value = params.muted ? 0 : params.volume / 100;

  const panNode = audioCtx.createStereoPanner();
  panNode.pan.value = params.pan / 100; // -100 to 100 mapped to -1 to 1

  source.connect(gainNode);
  gainNode.connect(panNode);
  panNode.connect(masterGain);

  return { source, gain: gainNode, panner: panNode };
}

/**
 * Play all tracks synchronously.
 */
export function playAll(tracks, buffers) {
  if (!audioCtx) initAudio();
  if (audioCtx.state === 'suspended') audioCtx.resume();

  stopAll();

  const hasSoloed = tracks.some(t => t.soloed);

  for (const track of tracks) {
    const buffer = buffers.get(track.id);
    if (!buffer) continue;

    const effectiveMuted = track.muted || (hasSoloed && !track.soloed);
    const chain = createTrackChain(buffer, { ...track, muted: effectiveMuted });
    chain.source.start(0);
    activeSources.set(track.id, chain);
  }

  isPlaying = true;
  startTime = audioCtx.currentTime;
}

/**
 * Stop all playback.
 */
export function stopAll() {
  for (const [id, chain] of activeSources) {
    try {
      chain.source.stop();
      chain.source.disconnect();
      chain.gain.disconnect();
      chain.panner.disconnect();
    } catch (e) { /* already stopped */ }
  }
  activeSources.clear();
  isPlaying = false;
}

/**
 * Update track parameters in real-time.
 */
export function updateTrackParams(trackId, params, allTracks) {
  const chain = activeSources.get(trackId);
  if (!chain) return;

  const hasSoloed = allTracks ? allTracks.some(t => t.soloed) : false;
  const track = allTracks ? allTracks.find(t => t.id === trackId) : null;
  const effectiveMuted = params.muted !== undefined
    ? params.muted || (hasSoloed && !(params.soloed ?? track?.soloed))
    : (track?.muted || (hasSoloed && !track?.soloed));

  if (params.volume !== undefined || params.muted !== undefined || params.soloed !== undefined) {
    const vol = (params.volume !== undefined ? params.volume : (track?.volume ?? 75)) / 100;
    chain.gain.gain.setTargetAtTime(effectiveMuted ? 0 : vol, audioCtx.currentTime, 0.02);
  }

  if (params.pan !== undefined) {
    chain.panner.pan.setTargetAtTime(params.pan / 100, audioCtx.currentTime, 0.02);
  }
}

/**
 * Re-apply mute/solo to all active tracks.
 */
export function refreshAllTrackMutes(tracks) {
  const hasSoloed = tracks.some(t => t.soloed);
  for (const track of tracks) {
    const chain = activeSources.get(track.id);
    if (!chain) continue;
    const effectiveMuted = track.muted || (hasSoloed && !track.soloed);
    const vol = track.volume / 100;
    chain.gain.gain.setTargetAtTime(effectiveMuted ? 0 : vol, audioCtx.currentTime, 0.02);
  }
}

export function getIsPlaying() {
  return isPlaying;
}

export function getCurrentTime() {
  if (!isPlaying || !audioCtx) return 0;
  return audioCtx.currentTime - startTime;
}
