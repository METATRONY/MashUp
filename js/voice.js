/**
 * Voice modal: karaoke recording + file upload.
 *
 * Exports:
 *   initVoiceModal(store)  — wire all modal interactions; call once on app init
 *   openVoiceModal()       — show the modal (triggered by "Replace Vocals" btn)
 */

import { startVoiceReplace } from './api.js';

const _apiBase = () => window.MASHUP_API_BASE || 'http://127.0.0.1:8000';

// ── Module state ──────────────────────────────────────────────────────────────

let _store = null;

// Artist catalog
let _selectedArtistId = null;
let _artists = null;  // cached from /api/artists

// Recording
let _mediaRecorder = null;
let _recordedChunks = [];
let _stream = null;
let _timerInterval = null;
let _isRecording = false;
let _pendingBlob = null;
let _pendingFilename = null;

// Karaoke
let _karaokeAudio = null;     // HTMLAudioElement for instrumental
let _prepPolling = false;     // guard: stop polling when modal closed
let _elapsedSecs = 0;         // karaoke recording elapsed time

// Voice test
let _activeVoiceId = null;

// My Voice (trained user model) — supports multiple named voices
// Stored as JSON array: [{id, name}]
function _loadMyVoices() {
  try { return JSON.parse(localStorage.getItem('mashup_my_voices') || '[]'); }
  catch { return []; }
}
function _saveMyVoices(voices) {
  localStorage.setItem('mashup_my_voices', JSON.stringify(voices));
}
function _getMyVoiceName(id) {
  return _loadMyVoices().find(v => v.id === id)?.name ?? 'My Voice';
}

// Legacy single-voice migration
let _myVoiceId = localStorage.getItem('mashup_my_voice_id') ?? null;
if (_myVoiceId && !_loadMyVoices().find(v => v.id === _myVoiceId)) {
  _saveMyVoices([{ id: _myVoiceId, name: 'My Voice' }]);
}

// Karaoke-only mode (opened via standalone Karaoke button, not Replace Vocals)
let _karaokeOnlyMode = false;

// Training session
let _trainingVoiceId = null;
let _trainingTotalSecs = 0;
let _trainingJobId = null;

// Karaoke pitch correction
let _karaokeVideoId = null;    // video_id of current karaoke song
let _karaokeVoiceId = null;    // voice_id after recording is uploaded for pitch-correct

// Lyric highlighting
let _lyricsLines = [];
let _lyricsSpans = [];
let _activeLyricIdx = -1;
let _vocalsStartSecs = 0;   // seconds into the track when vocals actually begin

// ── DOM helpers ───────────────────────────────────────────────────────────────

function _el(id) { return document.getElementById(id); }

// Show one karaoke sub-panel, hide the others (upload tab content is separate)
function _showKaraokePanel(id) {
  ['voice-panel-pick', 'voice-panel-prep', 'voice-panel-karaoke'].forEach((pid) => {
    const el = _el(pid);
    if (el) el.hidden = pid !== id;
  });
}

function _showModal() {
  const overlay = _el('voice-overlay');
  if (overlay) overlay.hidden = false;
}

function _hideModal() {
  const overlay = _el('voice-overlay');
  if (overlay) overlay.hidden = true;
  _cleanup();
}

function _cleanup() {
  _stopMic();
  _prepPolling = false;
  _karaokeVideoId = null;
  _karaokeVoiceId = null;
  if (_karaokeAudio) {
    _karaokeAudio.pause();
    _karaokeAudio.src = '';
    _karaokeAudio = null;
  }
}

function _resetUI() {
  _pendingBlob = null;
  _pendingFilename = null;
  _elapsedSecs = 0;
  _cleanup();

  // Karaoke panel state
  const singBtn = _el('voice-karaoke-sing-btn');
  const stopBtn = _el('voice-karaoke-stop-btn');
  const timer   = _el('voice-karaoke-timer');
  const live    = _el('voice-record-live');
  const status  = _el('voice-karaoke-status');
  if (singBtn) { singBtn.hidden = false; singBtn.disabled = false; }
  if (stopBtn) stopBtn.hidden = true;
  if (timer)   { timer.hidden = true; timer.textContent = '0:00'; }
  if (live)    live.hidden = true;
  if (status)  status.textContent = '';

  // Progress
  const prog = _el('voice-karaoke-progress');
  if (prog) { prog.value = 0; }

  // Preview / confirm
  const preview    = _el('voice-preview');
  const confirmBtn = _el('voice-confirm-btn');
  const fileInput  = _el('voice-file-input');
  if (preview)    preview.hidden = true;
  if (confirmBtn) confirmBtn.disabled = true;
  if (fileInput)  fileInput.value = '';

  // Reset artist selection
  _selectedArtistId = null;
  document.querySelectorAll('.artist-card').forEach(c => c.classList.remove('artist-card--selected'));
  const artistConfirmBtn = _el('voice-artist-confirm-btn');
  if (artistConfirmBtn) artistConfirmBtn.disabled = true;

  // Reset test panel state
  _activeVoiceId = null;
  const testPanel = _el('voice-test-panel');
  const tabBar    = document.querySelector('.voice-tabs');
  const doneBtn   = _el('voice-done-btn');
  if (testPanel) testPanel.hidden = true;
  if (tabBar)    tabBar.hidden = false;
  _el('voice-cancel-btn')?.removeAttribute('hidden');
  const confirmBtn2 = _el('voice-confirm-btn');
  if (confirmBtn2) {
    confirmBtn2.removeAttribute('hidden');
    confirmBtn2.disabled = true;
    confirmBtn2.textContent = 'Use This Recording';
  }
  if (doneBtn) doneBtn.hidden = true;

  // Revoke preview audio blob URL
  const previewAudio2 = _el('voice-preview-audio');
  if (previewAudio2) {
    if (previewAudio2._blobUrl) { URL.revokeObjectURL(previewAudio2._blobUrl); previewAudio2._blobUrl = null; }
    previewAudio2.src = '';
  }

  // Reset pitch-correct row
  const pitchRow = _el('voice-pitch-row');
  if (pitchRow) pitchRow.hidden = true;
  const pitchStatus = _el('voice-pitch-status');
  if (pitchStatus) pitchStatus.textContent = '';
  const pitchAudio = _el('voice-pitch-result-audio');
  if (pitchAudio) { pitchAudio.hidden = true; pitchAudio.src = ''; }

  // Reset lyric state
  _lyricsLines = [];
  _lyricsSpans = [];
  _activeLyricIdx = -1;
  _vocalsStartSecs = 0;
  const lyricsEl = _el('voice-lyrics-text');
  if (lyricsEl) lyricsEl.innerHTML = '';

  // Reset test audio
  const testAudio = _el('voice-test-audio');
  if (testAudio) { testAudio.hidden = true; testAudio.src = ''; }
  const testStatus = _el('voice-test-status');
  if (testStatus) testStatus.textContent = '';
  const testInput = _el('voice-test-input');
  if (testInput) testInput.value = '';
}

// ── Voice test panel ──────────────────────────────────────────────────────────

function _showTestPanel(voiceId) {
  _activeVoiceId = voiceId;
  const karaokeContent = _el('voice-tab-karaoke');
  const uploadContent  = _el('voice-tab-upload');
  const trainContent   = _el('voice-tab-train');
  const tabBar         = document.querySelector('.voice-tabs');
  const preview        = _el('voice-preview');
  if (karaokeContent) karaokeContent.hidden = true;
  if (uploadContent)  uploadContent.hidden  = true;
  if (trainContent)   trainContent.hidden   = true;
  if (tabBar)         tabBar.hidden         = true;
  if (preview)        preview.hidden        = true;
  const panel = _el('voice-test-panel');
  if (panel) panel.hidden = false;
  _el('voice-cancel-btn')?.setAttribute('hidden', '');
  _el('voice-confirm-btn')?.setAttribute('hidden', '');
  _el('voice-done-btn')?.removeAttribute('hidden');
}

async function _runVoiceTest() {
  if (!_activeVoiceId) return;
  const input   = _el('voice-test-input');
  const status  = _el('voice-test-status');
  const audioEl = _el('voice-test-audio');
  const btn     = _el('voice-test-btn');
  const text    = input?.value?.trim();
  if (!text) { _showToast('Enter a sentence to test.'); return; }
  if (btn) btn.disabled = true;
  if (status) status.textContent = 'Generating…';
  if (audioEl) audioEl.hidden = true;
  try {
    const res = await fetch(`${_apiBase()}/api/test-voice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voice_id: _activeVoiceId, text }),
    });
    if (!res.ok) throw new Error(await res.text());
    const { audio_url } = await res.json();
    if (audioEl) {
      audioEl.src = `${_apiBase()}${audio_url}?t=${Date.now()}`;
      audioEl.hidden = false;
      audioEl.play().catch(() => {});
    }
    if (status) status.textContent = '';
  } catch (err) {
    if (status) status.textContent = `Error: ${err.message}`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ── Tab switching ─────────────────────────────────────────────────────────────

function _switchTab(activeTab) {
  document.querySelectorAll('[data-voice-tab]').forEach((t) => {
    const isActive = t.dataset.voiceTab === activeTab;
    t.classList.toggle('voice-tab--active', isActive);
    t.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });

  const karaokeContent = _el('voice-tab-karaoke');
  const uploadContent  = _el('voice-tab-upload');
  const trainContent   = _el('voice-tab-train');
  if (karaokeContent) karaokeContent.hidden = activeTab !== 'karaoke';
  if (uploadContent)  uploadContent.hidden  = activeTab !== 'upload';
  if (trainContent)   trainContent.hidden   = activeTab !== 'train';

  if (activeTab === 'karaoke') {
    _renderSongPicker();
    _showKaraokePanel('voice-panel-pick');
  }
}

// ── Song picker ───────────────────────────────────────────────────────────────

function _renderSongPicker() {
  const songs = (_store?.getState().songs || []).filter((s) => s.videoId);
  const emptyEl    = _el('voice-pick-empty');
  const controlsEl = _el('voice-pick-controls');
  const select     = _el('voice-song-select');

  if (emptyEl)    emptyEl.hidden    = songs.length > 0;
  if (controlsEl) controlsEl.hidden = songs.length === 0;
  if (!select)    return;

  select.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Choose a song…';
  placeholder.disabled = true;
  placeholder.selected = true;
  select.appendChild(placeholder);

  songs.forEach((s) => {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.artist ? `${s.artist} – ${s.title || s.videoId}` : (s.title || s.videoId);
    select.appendChild(opt);
  });
}

// ── Karaoke prep ──────────────────────────────────────────────────────────────

async function _prepKaraoke(song) {
  _karaokeVideoId = song.videoId;
  _karaokeVoiceId = null;
  _showKaraokePanel('voice-panel-prep');
  const subtext = _el('voice-prep-subtext');
  if (subtext) subtext.textContent = 'Separating stems with Demucs. This may take a minute.';

  let instrumentalUrl;
  try {
    const res = await fetch(`${_apiBase()}/api/karaoke-prep`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ video_id: song.videoId }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    if (data.status === 'done' && data.download_url) {
      instrumentalUrl = data.download_url;
      _vocalsStartSecs = data.vocals_start_secs || 0;
      console.log('[karaoke] vocals onset (fast path):', _vocalsStartSecs, 's');
    } else if (data.job_id) {
      const result = await _pollKaraokeJob(data.job_id);
      instrumentalUrl = result.url;
      _vocalsStartSecs = result.vocalsStartSecs || 0;
      console.log('[karaoke] vocals onset (polled):', _vocalsStartSecs, 's');
    } else {
      throw new Error('Unexpected response from server');
    }
  } catch (err) {
    if (subtext) subtext.textContent = `Failed: ${err.message}`;
    const spinner = document.querySelector('.voice-prep-spinner');
    if (spinner) spinner.style.display = 'none';
    return;
  }

  _showKaraokePlayer(instrumentalUrl, song.lyricsFull, song.title, song.artist);
}

async function _pollKaraokeJob(jobId) {
  _prepPolling = true;
  const base = _apiBase();
  const maxAttempts = 300;
  let attempt = 0;

  while (_prepPolling && attempt < maxAttempts) {
    attempt++;
    const res = await fetch(`${base}/api/mashup/job/${jobId}`);
    if (!res.ok) throw new Error(`Status check failed (${res.status})`);
    const data = await res.json();

    if (data.status === 'done' && data.download_url) {
      _prepPolling = false;
      return { url: data.download_url, vocalsStartSecs: data.vocals_start_secs || 0 };
    }
    if (data.status === 'error') {
      _prepPolling = false;
      throw new Error(data.error || 'Prep job failed');
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  _prepPolling = false;
  throw new Error('Timed out waiting for instrumental prep.');
}

// ── Karaoke player ────────────────────────────────────────────────────────────

function _showKaraokePlayer(downloadUrl, lyrics, title, artist) {
  const url = downloadUrl.startsWith('http') ? downloadUrl : `${_apiBase()}${downloadUrl}`;

  _karaokeAudio = new Audio(url);

  // Progress bar sync + lyric highlighting
  const prog = _el('voice-karaoke-progress');
  _karaokeAudio.addEventListener('timeupdate', () => {
    const dur = _karaokeAudio.duration;
    const ct  = _karaokeAudio.currentTime;
    if (!dur) return;
    if (prog) prog.value = (ct / dur) * 100;
    if (_lyricsLines.length > 0) {
      // Offset by vocal onset; lead by 0.5 s so next line appears before singer needs it
      const LYRIC_LEAD    = 0.5;
      const effectiveTime = Math.max(0, ct - _vocalsStartSecs + LYRIC_LEAD);
      const effectiveDur  = Math.max(1, dur - _vocalsStartSecs);
      const idx = Math.min(
        Math.floor((effectiveTime / effectiveDur) * _lyricsLines.length),
        _lyricsLines.length - 1,
      );
      if (idx !== _activeLyricIdx) {
        if (_activeLyricIdx >= 0 && _lyricsSpans[_activeLyricIdx]) {
          _lyricsSpans[_activeLyricIdx].classList.remove('voice-lyric-line--active');
        }
        _activeLyricIdx = idx;
        if (_lyricsSpans[idx]) {
          _lyricsSpans[idx].classList.add('voice-lyric-line--active');
          _lyricsSpans[idx].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      }
    }
  });
  _karaokeAudio.addEventListener('ended', () => {
    if (_isRecording) _stopKaraokeRecording();
  });
  if (prog) {
    prog.addEventListener('input', () => {
      if (_karaokeAudio && _karaokeAudio.duration) {
        _karaokeAudio.currentTime = (parseFloat(prog.value) / 100) * _karaokeAudio.duration;
      }
    });
  }

  // Song name label
  const nameEl = _el('voice-karaoke-song-name');
  if (nameEl) {
    nameEl.textContent = artist ? `${artist} – ${title || ''}` : (title || '');
  }

  // Lyrics — one <span> per line for karaoke highlighting
  const lyricsEl = _el('voice-lyrics-text');
  const noLyrics = _el('voice-lyrics-nolyrics');
  _activeLyricIdx = -1;
  if (!lyrics) {
    _lyricsLines = [];
    _lyricsSpans = [];
    if (lyricsEl) lyricsEl.innerHTML = '';
    if (noLyrics) noLyrics.hidden = false;
  } else {
    _lyricsLines = lyrics.split('\n');
    if (lyricsEl) {
      lyricsEl.innerHTML = _lyricsLines
        .map((l) => `<span class="voice-lyric-line">${
          l.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        }</span>`)
        .join('');
      _lyricsSpans = Array.from(lyricsEl.querySelectorAll('.voice-lyric-line'));
    }
    if (noLyrics) noLyrics.hidden = true;
  }

  _showKaraokePanel('voice-panel-karaoke');
}

// ── Karaoke recording ─────────────────────────────────────────────────────────

async function _startKaraokeRecording() {
  if (_isRecording) return;

  const singBtn = _el('voice-karaoke-sing-btn');
  const status  = _el('voice-karaoke-status');
  if (singBtn) singBtn.disabled = true;
  if (status)  status.textContent = 'Requesting microphone…';

  try {
    _stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: false,
    });
  } catch (err) {
    if (status)  status.textContent = 'Microphone access denied. Please allow mic access and try again.';
    if (singBtn) singBtn.disabled = false;
    return;
  }

  _isRecording = true;

  // Warn if the active mic appears to be an external device (phone/iPad via Continuity)
  try {
    const tracks = _stream.getAudioTracks();
    const label  = (tracks[0]?.label || '').toLowerCase();
    const isExternal = /iphone|ipad|continuity|bluetooth|airpods/i.test(label);
    if (isExternal && status) {
      status.textContent = `⚠️ External mic detected ("${tracks[0].label}"). It may capture the music playing — use headphones or switch to the Mac's built-in mic.`;
    } else {
      if (status) status.textContent = 'Recording…';
    }
  } catch (_) {
    if (status) status.textContent = 'Recording…';
  }

  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '';

  _recordedChunks = [];
  _mediaRecorder = new MediaRecorder(_stream, mimeType ? { mimeType } : {});
  _mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) _recordedChunks.push(e.data); };
  _mediaRecorder.onstop = () => {
    const blob = new Blob(_recordedChunks, { type: _mediaRecorder.mimeType || 'audio/webm' });
    const ext  = blob.type.includes('mp4') ? 'mp4' : 'webm';
    _handleAudioBlob(blob, `karaoke.${ext}`);
    _stopMic();
  };
  // If the mic device disconnects mid-recording, stop gracefully
  _stream.getAudioTracks().forEach((track) => {
    track.addEventListener('ended', () => {
      if (_isRecording) {
        const st = _el('voice-karaoke-status');
        if (st) st.textContent = '⚠️ Microphone disconnected — recording stopped.';
        _stopKaraokeRecording();
      }
    });
  });
  _mediaRecorder.start(200);

  // Start instrumental playback
  if (_karaokeAudio) {
    _karaokeAudio.currentTime = 0;
    _karaokeAudio.play().catch(() => {});
  }

  // Show stop button + live indicator + timer
  if (singBtn) { singBtn.hidden = true; singBtn.disabled = false; }
  const stopBtn = _el('voice-karaoke-stop-btn');
  const timer   = _el('voice-karaoke-timer');
  const live    = _el('voice-record-live');
  if (stopBtn) stopBtn.hidden = false;
  if (timer)   { timer.hidden = false; timer.textContent = '0:00'; }
  if (live)    live.hidden = false;

  _elapsedSecs = 0;
  _timerInterval = setInterval(() => {
    _elapsedSecs++;
    const m = Math.floor(_elapsedSecs / 60);
    const s = _elapsedSecs % 60;
    const t = _el('voice-karaoke-timer');
    if (t) t.textContent = `${m}:${s.toString().padStart(2, '0')}`;
  }, 1000);
}

function _stopKaraokeRecording() {
  if (!_isRecording) return;
  _isRecording = false;

  clearInterval(_timerInterval);
  _timerInterval = null;

  try {
    if (_mediaRecorder && _mediaRecorder.state !== 'inactive') _mediaRecorder.stop();
  } catch (_) { /* ignore */ }

  if (_karaokeAudio) _karaokeAudio.pause();

  const singBtn = _el('voice-karaoke-sing-btn');
  const stopBtn = _el('voice-karaoke-stop-btn');
  const timer   = _el('voice-karaoke-timer');
  const live    = _el('voice-record-live');
  const status  = _el('voice-karaoke-status');
  if (singBtn) { singBtn.hidden = false; singBtn.disabled = false; }
  if (stopBtn) stopBtn.hidden = true;
  if (timer)   timer.hidden = true;
  if (live)    live.hidden = true;
  if (status)  status.textContent = 'Processing…';
}

function _stopMic() {
  _isRecording = false;
  clearInterval(_timerInterval);
  _timerInterval = null;
  if (_stream) {
    _stream.getTracks().forEach((t) => t.stop());
    _stream = null;
  }
  _mediaRecorder = null;
}

// ── File upload ───────────────────────────────────────────────────────────────

function _handleFileSelect(file) {
  if (!file.type.startsWith('audio/') && !/\.(wav|mp3|m4a|ogg|webm|flac|aac)$/i.test(file.name)) {
    _showToast('Please select an audio file.', 'error');
    return;
  }
  if (file.size > 50 * 1024 * 1024) {
    _showToast('File too large (max 50 MB).', 'error');
    return;
  }
  _handleAudioBlob(file, file.name);
}

// ── Waveform + confirm ────────────────────────────────────────────────────────

async function _handleAudioBlob(blob, filename) {
  _pendingBlob     = blob;
  _pendingFilename = filename;

  const preview    = _el('voice-preview');
  const canvas     = _el('voice-waveform-canvas');
  const durationEl = _el('voice-preview-duration');
  const confirmBtn = _el('voice-confirm-btn');
  const status     = _el('voice-karaoke-status');

  if (preview) preview.hidden = false;
  if (status)  status.textContent = '';

  // Wire blob to preview audio player so user can verify the recording
  const previewAudio = _el('voice-preview-audio');
  if (previewAudio) {
    if (previewAudio._blobUrl) URL.revokeObjectURL(previewAudio._blobUrl);
    previewAudio._blobUrl = URL.createObjectURL(blob);
    previewAudio.src = previewAudio._blobUrl;
  }

  if (canvas) {
    try { await _drawVoiceWaveform(canvas, blob); } catch (_) { /* ignore */ }
  }

  if (durationEl) {
    try {
      const ab     = await blob.arrayBuffer();
      const offCtx = new OfflineAudioContext(1, 1, 44100);
      const buf    = await offCtx.decodeAudioData(ab);
      const secs   = buf.duration;
      const m = Math.floor(secs / 60);
      const s = Math.round(secs % 60);
      durationEl.textContent = `Duration: ${m > 0 ? m + 'm ' : ''}${s}s`;

      // Block upload if recording is too short
      if (secs < 5) {
        durationEl.textContent += ' ⚠️ Too short — please sing for at least 30 seconds.';
        durationEl.style.color = 'var(--accent-amber, #d97706)';
        if (confirmBtn) confirmBtn.disabled = true;
        return;
      }
      durationEl.style.color = '';
    } catch (_) {
      durationEl.textContent = '';
    }
  }

  if (confirmBtn) confirmBtn.disabled = false;

  // Show pitch-correct row only for karaoke recordings (we have a reference stem)
  const pitchRow = _el('voice-pitch-row');
  const pitchStatus = _el('voice-pitch-status');
  const pitchAudio  = _el('voice-pitch-result-audio');
  if (pitchRow) pitchRow.hidden = !_karaokeVideoId;
  if (pitchStatus) pitchStatus.textContent = '';
  if (pitchAudio)  { pitchAudio.hidden = true; pitchAudio.src = ''; }
}

async function _drawVoiceWaveform(canvas, blob) {
  const W = canvas.offsetWidth || canvas.width || 400;
  const H = canvas.offsetHeight || canvas.height || 60;
  canvas.width  = W;
  canvas.height = H;

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  const ab     = await blob.arrayBuffer();
  const offCtx = new OfflineAudioContext(1, 1, 44100);
  const buf    = await offCtx.decodeAudioData(ab);
  const raw    = buf.getChannelData(0);
  const sPerBucket = Math.max(1, Math.ceil(raw.length / W));

  const rms = new Float32Array(W);
  for (let i = 0; i < W; i++) {
    let sq = 0;
    for (let j = 0; j < sPerBucket; j++) {
      const s = raw[i * sPerBucket + j] ?? 0;
      sq += s * s;
    }
    rms[i] = Math.sqrt(sq / sPerBucket);
  }

  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent-teal').trim() || '#2dd4bf';
  for (let i = 0; i < W; i++) {
    const h = Math.max(2, Math.round(rms[i] * H * 3.5));
    ctx.fillRect(i, H - h, 1, h);
  }
}

// ── Upload to backend ─────────────────────────────────────────────────────────

async function _uploadAndConfirm() {
  if (!_pendingBlob) return;
  const confirmBtn = _el('voice-confirm-btn');
  const status     = _el('voice-record-status');

  if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = 'Uploading…'; }
  if (status)     status.textContent = 'Uploading voice recording…';

  try {
    const fd = new FormData();
    fd.append('file', _pendingBlob, _pendingFilename || 'recording.webm');

    const res = await fetch(`${_apiBase()}/api/upload-voice`, { method: 'POST', body: fd });
    if (!res.ok) {
      const msg = await res.text().catch(() => res.statusText);
      throw new Error(msg);
    }
    const { voice_id, duration } = await res.json();
    _store.setVoiceId(voice_id);
    const secs = Math.round(duration ?? 0);
    const durText = secs >= 60
      ? `${Math.floor(secs / 60)}m ${secs % 60}s`
      : `${secs}s`;
    _showToast(`Upload complete — ${durText} of voice analyzed.`, 'success');
    _showTestPanel(voice_id);
  } catch (err) {
    if (status)     status.textContent = `Upload failed: ${err.message}`;
    if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = 'Use This Recording'; }
    _showToast(`Upload failed: ${err.message}`, 'error');
  }
}

// ── Artist catalog ────────────────────────────────────────────────────────────

async function _fetchArtists() {
  if (_artists) return _artists;
  try {
    const res = await fetch(`${_apiBase()}/api/artists`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    _artists = await res.json();
  } catch (err) {
    console.error('[voice] failed to fetch artists:', err);
    _artists = [];
  }
  return _artists;
}

function _renderArtistCatalog(artists) {
  const grid = _el('artist-catalog');
  const loading = _el('artist-catalog-loading');
  if (loading) loading.hidden = true;
  if (!grid) return;

  if (!artists.length) {
    grid.innerHTML = '<p style="color:var(--text-secondary);font-size:0.85rem;padding:8px">No artists available.</p>';
    grid.hidden = false;
    return;
  }

  grid.innerHTML = '';
  grid.hidden = false;

  const _makeArtistCard = (id, name, genre, extraClass = '') => {
    const card = document.createElement('div');
    card.className = `artist-card${extraClass ? ' ' + extraClass : ''}`;
    card.dataset.artistId = id;
    card.innerHTML = `<div class="artist-card__name">${name}</div><div class="artist-card__genre">${genre}</div>`;

    if (extraClass.includes('artist-card--my-voice')) {
      const removeBtn = document.createElement('button');
      removeBtn.className = 'artist-card__remove';
      removeBtn.title = 'Remove this voice';
      removeBtn.textContent = '×';
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const voiceName = name;
        const voiceId = id.replace(/^user_/, '');
        if (!confirm(`Delete "${voiceName}"?\n\nThe trained model will be permanently removed and cannot be recovered.`)) return;
        // Remove from localStorage
        const updated = _loadMyVoices().filter(v => v.id !== voiceId);
        _saveMyVoices(updated);
        if (_selectedArtistId === id) {
          _selectedArtistId = null;
          const btn = _el('voice-artist-confirm-btn');
          if (btn) btn.disabled = true;
        }
        card.remove();
        // Delete model from server
        fetch(`${_apiBase()}/api/my-voice/${voiceId}`, { method: 'DELETE' }).catch(() => {});
      });
      card.appendChild(removeBtn);
    }

    card.addEventListener('click', () => {
      document.querySelectorAll('.artist-card').forEach(c => c.classList.remove('artist-card--selected'));
      card.classList.add('artist-card--selected');
      _selectedArtistId = id;
      const btn = _el('voice-artist-confirm-btn');
      if (btn) btn.disabled = false;
    });
    return card;
  };

  // Prepend a card for each trained voice (newest first)
  _loadMyVoices().slice().reverse().forEach(v => {
    grid.appendChild(_makeArtistCard(`user_${v.id}`, v.name, 'Personal Model', 'artist-card--my-voice'));
  });

  artists.forEach(a => {
    grid.appendChild(_makeArtistCard(a.id, a.name, a.genre));
  });

  // Re-select previously chosen artist if any
  if (_selectedArtistId) {
    const prev = grid.querySelector(`[data-artist-id="${_selectedArtistId}"]`);
    if (prev) prev.classList.add('artist-card--selected');
  }
}

function _switchTopTab(vtab) {
  document.querySelectorAll('[data-vtab]').forEach(t => {
    const active = t.dataset.vtab === vtab;
    t.classList.toggle('voice-tab-top--active', active);
    t.setAttribute('aria-selected', active ? 'true' : 'false');
  });

  const artistPanel = _el('voice-panel-artist');
  const recordingPanel = _el('voice-panel-recording');
  const artistBtn = _el('voice-artist-confirm-btn');
  const recordingBtn = _el('voice-confirm-btn');

  if (artistPanel) artistPanel.hidden = vtab !== 'artist';
  if (recordingPanel) recordingPanel.hidden = vtab !== 'recording';
  if (artistBtn) artistBtn.hidden = vtab !== 'artist';
  if (recordingBtn) recordingBtn.hidden = vtab !== 'recording';

  if (vtab === 'artist') {
    const loading = _el('artist-catalog-loading');
    const grid = _el('artist-catalog');
    if (loading && grid && grid.hidden) loading.hidden = false;
    _fetchArtists().then(_renderArtistCatalog);
  } else {
    _switchTab('upload');
  }
}

// ── My Voice (trained user model) ────────────────────────────────────────────

async function _initMyVoice() {
  if (!_myVoiceId) return;
  try {
    const res = await fetch(`${_apiBase()}/api/my-voice/${_myVoiceId}/status`);
    if (!res.ok) { _myVoiceId = null; return; }
    const { trained } = await res.json();
    if (!trained) _myVoiceId = null;
  } catch (_) {
    _myVoiceId = null;
  }
}

async function _syncVoicesFromDisk() {
  try {
    const res = await fetch(`${_apiBase()}/api/my-voices`);
    if (!res.ok) return;
    const { voices } = await res.json();
    if (!voices.length) return;
    // Merge disk voices into localStorage — disk is authoritative for existence,
    // localStorage is authoritative for names (prefer localStorage name if set).
    const existing = _loadMyVoices();
    const existingMap = Object.fromEntries(existing.map(v => [v.id, v]));
    for (const v of voices) {
      if (!existingMap[v.id]) existingMap[v.id] = v;
    }
    _saveMyVoices(Object.values(existingMap));
  } catch (_) { /* network hiccup — no-op */ }
}

// ── Training clips ─────────────────────────────────────────────────────────────

function _fmtDur(secs) {
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function _updateTrainingCounter() {
  const el = _el('voice-train-clip-count');
  if (!el) return;
  const mins = (_trainingTotalSecs / 60).toFixed(1);
  el.textContent = `${document.querySelectorAll('.voice-train-clip-row').length} clip(s) — ${mins} min total`;
  _updateTrainStartBtn();
}

function _updateTrainStartBtn() {
  const startBtn = _el('voice-train-start-btn');
  if (!startBtn) return;
  const hasName = !!_el('voice-train-name')?.value?.trim();
  const hasAudio = _trainingTotalSecs >= 900;
  startBtn.disabled = !hasName || !hasAudio;
  startBtn.title = !hasName ? 'Enter a name for this voice first'
    : !hasAudio ? 'Add at least 15 minutes of audio'
    : '';
}

async function _handleTrainingFiles(files) {
  const addBtn   = _el('voice-train-add-btn');
  const clipList = _el('voice-train-clips');
  if (!clipList) return;

  if (!_trainingVoiceId) {
    _trainingVoiceId = crypto.randomUUID().replace(/-/g, '');
  }

  for (const file of Array.from(files)) {
    if (!file.type.startsWith('audio/') && !/\.(wav|mp3|m4a|ogg|webm|flac|aac)$/i.test(file.name)) {
      _showToast(`Skipping non-audio file: ${file.name}`, 'error');
      continue;
    }

    // Measure duration client-side for the counter
    let clipSecs = 0;
    try {
      const ab     = await file.arrayBuffer();
      const offCtx = new OfflineAudioContext(1, 1, 44100);
      const buf    = await offCtx.decodeAudioData(ab.slice(0));
      clipSecs = buf.duration;
    } catch (_) { /* estimate from file size if decode fails */ }

    // Upload to backend training session
    const fd = new FormData();
    fd.append('file', file, file.name);
    try {
      const res = await fetch(`${_apiBase()}/api/upload-voice?voice_id=${_trainingVoiceId}`, {
        method: 'POST', body: fd,
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      if (data.duration && !clipSecs) clipSecs = data.duration;
    } catch (err) {
      _showToast(`Upload failed for ${file.name}: ${err.message}`, 'error');
      continue;
    }

    _trainingTotalSecs += clipSecs;

    const row = document.createElement('div');
    row.className = 'voice-train-clip-row';
    row.innerHTML = `<span class="voice-train-clip-row__name">${file.name}</span><span class="voice-train-clip-row__dur">${_fmtDur(clipSecs)}</span>`;
    clipList.appendChild(row);
    _updateTrainingCounter();
  }
}

function _getSelectedEpochs() {
  const active = document.querySelector('.voice-epoch-btn--active');
  return parseInt(active?.dataset?.epochs ?? '200', 10);
}

async function _startTraining() {
  const name = _el('voice-train-name')?.value?.trim();
  if (!name) { _showToast('Enter a name for this voice before training.', 'info'); _el('voice-train-name')?.focus(); return; }
  if (!_trainingVoiceId || _trainingTotalSecs < 900) return;

  const startBtn   = _el('voice-train-start-btn');
  const addBtn     = _el('voice-train-add-btn');
  const progressRow = _el('voice-train-progress-row');
  const statusEl   = _el('voice-train-status');
  const barEl      = _el('voice-train-progress-bar');

  if (startBtn) startBtn.disabled = true;
  if (addBtn)   addBtn.disabled   = true;
  if (progressRow) progressRow.hidden = false;
  if (statusEl)   statusEl.textContent = 'Submitting to GPU…';
  if (barEl)      barEl.style.width = '10%';

  try {
    const res = await fetch(`${_apiBase()}/api/train-voice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voice_id: _trainingVoiceId, n_epochs: _getSelectedEpochs(), name: _el('voice-train-name')?.value?.trim() || 'My Voice' }),
    });
    if (!res.ok) throw new Error(await res.text());
    const { job_id } = await res.json();
    _trainingJobId = job_id;
    _pollTrainingJob(job_id);
  } catch (err) {
    if (statusEl) statusEl.textContent = `Error: ${err.message}`;
    if (startBtn) startBtn.disabled = false;
    if (addBtn)   addBtn.disabled   = false;
  }
}

async function _pollTrainingJob(jobId) {
  const statusEl = _el('voice-train-status');
  const barEl    = _el('voice-train-progress-bar');
  // Fake progress: 10% at start, linear to 85% over 20 min, 100% on done
  const startTime  = Date.now();
  const FAKE_DURATION = 20 * 60 * 1000;

  const _fakeProgress = () => {
    const elapsed = Date.now() - startTime;
    const frac = Math.min(elapsed / FAKE_DURATION, 1);
    return 10 + frac * 75;
  };

  while (true) {
    await new Promise(r => setTimeout(r, 3000));
    try {
      const res = await fetch(`${_apiBase()}/api/mashup/job/${jobId}`);
      if (!res.ok) continue;
      const data = await res.json();

      if (statusEl) statusEl.textContent = data.progress || 'Training…';
      if (barEl)    barEl.style.width = `${_fakeProgress()}%`;

      if (data.status === 'done') {
        if (barEl)    barEl.style.width = '100%';
        if (statusEl) statusEl.textContent = 'Training complete! Your voice model is ready.';

        // Save voice with name into the multi-voice list
        const voiceName = _el('voice-train-name')?.value?.trim() || 'My Voice';
        _myVoiceId = _trainingVoiceId;
        localStorage.setItem('mashup_my_voice_id', _myVoiceId);
        const voices = _loadMyVoices().filter(v => v.id !== _myVoiceId);
        voices.push({ id: _myVoiceId, name: voiceName });
        _saveMyVoices(voices);

        // Re-render artist grid with My Voice cards
        if (_artists) _renderArtistCatalog(_artists);

        _showToast(`"${voiceName}" trained! Test it below, then use it on a song.`, 'success');

        // Show test panel so the user can preview their voice immediately
        _showTestPanel(_trainingVoiceId);
        break;
      }
      if (data.status === 'error') {
        if (statusEl) statusEl.textContent = `Training failed: ${data.error || 'Unknown error'}`;
        const startBtn = _el('voice-train-start-btn');
        const addBtn   = _el('voice-train-add-btn');
        if (startBtn) startBtn.disabled = false;
        if (addBtn)   addBtn.disabled   = false;
        break;
      }
    } catch (_) { /* network hiccup; keep polling */ }
  }
}

// ── Karaoke pitch correction ───────────────────────────────────────────────────

async function _runPitchCorrect() {
  if (!_karaokeVideoId || !_pendingBlob) return;

  const fixBtn   = _el('voice-pitch-fix-btn');
  const statusEl = _el('voice-pitch-status');
  const audioEl  = _el('voice-pitch-result-audio');

  if (fixBtn) fixBtn.disabled = true;
  if (statusEl) statusEl.textContent = 'Uploading recording…';

  try {
    // Upload the blob to get a voice_id for pitch correction
    if (!_karaokeVoiceId) {
      const fd = new FormData();
      fd.append('file', _pendingBlob, _pendingFilename || 'karaoke.webm');
      const upRes = await fetch(`${_apiBase()}/api/upload-voice`, { method: 'POST', body: fd });
      if (!upRes.ok) throw new Error(await upRes.text());
      const { voice_id } = await upRes.json();
      _karaokeVoiceId = voice_id;
    }

    if (statusEl) statusEl.textContent = 'Analyzing pitch…';

    const res = await fetch(`${_apiBase()}/api/karaoke-pitch-correct`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ video_id: _karaokeVideoId, voice_id: _karaokeVoiceId }),
    });
    if (!res.ok) throw new Error(await res.text());
    const { job_id } = await res.json();

    // Poll for completion
    while (true) {
      await new Promise(r => setTimeout(r, 2000));
      const jr = await fetch(`${_apiBase()}/api/mashup/job/${job_id}`);
      if (!jr.ok) continue;
      const jdata = await jr.json();
      if (statusEl) statusEl.textContent = jdata.progress || 'Correcting pitch…';
      if (jdata.status === 'done') {
        const url = `${_apiBase()}${jdata.download_url}?t=${Date.now()}`;
        if (audioEl) { audioEl.src = url; audioEl.hidden = false; audioEl.play().catch(() => {}); }
        if (statusEl) statusEl.textContent = 'Pitch corrected — compare above!';
        break;
      }
      if (jdata.status === 'error') {
        throw new Error(jdata.error || 'Pitch correction failed');
      }
    }
  } catch (err) {
    if (statusEl) statusEl.textContent = `Error: ${err.message}`;
  } finally {
    if (fixBtn) fixBtn.disabled = false;
  }
}

// ── Toast ─────────────────────────────────────────────────────────────────────

function _showToast(message, variant = 'info') {
  document.dispatchEvent(new CustomEvent('mashup-toast', { detail: { message, variant } }));
}

// ── Public API ────────────────────────────────────────────────────────────────

export function initVoiceModal(store) {
  _store = store;

  // Re-render song picker reactively — handles race where songs load from the
  // backend API after the modal is first opened (localStorage may be empty).
  _store.subscribe(() => {
    const overlay = _el('voice-overlay');
    const recordingPanel = _el('voice-panel-recording');
    const tabBar = document.querySelector('.voice-tabs');
    if (overlay && !overlay.hidden && recordingPanel && !recordingPanel.hidden && tabBar && !tabBar.hidden) {
      _renderSongPicker();
    }
  });

  // Close / cancel
  _el('voice-dialog-close')?.addEventListener('click', _hideModal);
  _el('voice-cancel-btn')?.addEventListener('click', _hideModal);
  _el('voice-overlay')?.addEventListener('click', (e) => {
    if (e.target === _el('voice-overlay')) _hideModal();
  });

  // Top-level tab switching (Artist Voices / My Recording)
  document.querySelectorAll('[data-vtab]').forEach((tab) => {
    tab.addEventListener('click', () => _switchTopTab(tab.dataset.vtab));
  });

  // Artist confirm button
  _el('voice-artist-confirm-btn')?.addEventListener('click', () => {
    const errEl = _el('artist-confirm-error');
    const showErr = (msg) => { if (errEl) { errEl.textContent = msg; errEl.hidden = false; } };
    const clearErr = () => { if (errEl) errEl.hidden = true; };

    if (!_selectedArtistId) { showErr('Select an artist first.'); return; }

    const state = _store.getState();
    const { status } = state.mashup.generation;
    if (status === 'queued' || status === 'running') {
      showErr('A generation job is already running — wait for it to finish.');
      return;
    }
    const tracks = state.mashup.tracks;
    if (!tracks.length) {
      showErr('Add a song to the mixer first, then come back and select an artist voice.');
      return;
    }
    clearErr();
    const gain = parseFloat(_el('vocal-gain-slider')?.value ?? '2');
    startVoiceReplace(_store, { artistId: _selectedArtistId, vocalGain: gain });
    _hideModal();
  });

  // Sub-tab switching (Karaoke / Upload File)
  document.querySelectorAll('[data-voice-tab]').forEach((tab) => {
    tab.addEventListener('click', () => _switchTab(tab.dataset.voiceTab));
  });

  // Karaoke: prepare song
  _el('voice-prep-song-btn')?.addEventListener('click', () => {
    const select = _el('voice-song-select');
    if (!select?.value) { _showToast('Please choose a song first.', 'info'); return; }
    const song = store.getState().songs.find((s) => s.id === select.value);
    if (!song) { _showToast('Song not found.', 'error'); return; }
    _prepKaraoke(song);
  });

  // Karaoke: back buttons
  _el('voice-prep-back-btn')?.addEventListener('click', () => {
    _prepPolling = false;
    _renderSongPicker();
    _showKaraokePanel('voice-panel-pick');
  });
  _el('voice-karaoke-back-btn')?.addEventListener('click', () => {
    _cleanup();
    _renderSongPicker();
    _showKaraokePanel('voice-panel-pick');
  });

  // Karaoke: sing / stop
  _el('voice-karaoke-sing-btn')?.addEventListener('click', _startKaraokeRecording);
  _el('voice-karaoke-stop-btn')?.addEventListener('click', _stopKaraokeRecording);

  // Upload tab: file input + drag-drop
  _el('voice-file-input')?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) _handleFileSelect(file);
  });

  const uploadArea = document.querySelector('.voice-upload-area');
  if (uploadArea) {
    uploadArea.addEventListener('dragover', (e) => { e.preventDefault(); uploadArea.classList.add('voice-upload-area--drag'); });
    uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('voice-upload-area--drag'));
    uploadArea.addEventListener('drop', (e) => {
      e.preventDefault();
      uploadArea.classList.remove('voice-upload-area--drag');
      const file = e.dataTransfer?.files?.[0];
      if (file) _handleFileSelect(file);
    });
  }

  // Confirm upload — or use trained My Voice when in train tab
  _el('voice-confirm-btn')?.addEventListener('click', () => {
    const trainTab = _el('voice-tab-train');
    if (trainTab && !trainTab.hidden && _myVoiceId) {
      // Training is done; switch to Artist Voices and auto-select My Voice card
      _switchTopTab('artist');
      setTimeout(() => {
        const card = document.querySelector(`[data-artist-id="user_${_myVoiceId}"]`);
        if (card) card.click();
      }, 50);
      return;
    }
    _uploadAndConfirm();
  });

  // Voice test panel
  _el('voice-test-btn')?.addEventListener('click', _runVoiceTest);
  _el('voice-test-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') _runVoiceTest();
  });

  // Done: close from test panel
  _el('voice-done-btn')?.addEventListener('click', _hideModal);

  // Record new voice: clear saved voice and restart karaoke flow
  _el('voice-newrecord-btn')?.addEventListener('click', () => {
    _store.setVoiceId(null);
    _resetUI();
    _switchTab('karaoke');
  });

  // Train My Voice tab: add audio files
  _el('voice-train-add-btn')?.addEventListener('click', () => {
    _el('voice-train-file-input')?.click();
  });
  _el('voice-train-file-input')?.addEventListener('change', (e) => {
    const files = e.target.files;
    if (files?.length) _handleTrainingFiles(files);
    e.target.value = '';  // reset so the same file can be added again
  });

  // Epoch selector
  _el('voice-train-epochs-group')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.voice-epoch-btn');
    if (!btn) return;
    document.querySelectorAll('.voice-epoch-btn').forEach(b => b.classList.remove('voice-epoch-btn--active'));
    btn.classList.add('voice-epoch-btn--active');
  });

  // Name field: re-evaluate start button on every keystroke
  _el('voice-train-name')?.addEventListener('input', _updateTrainStartBtn);

  // Train My Voice tab: start training
  _el('voice-train-start-btn')?.addEventListener('click', _startTraining);

  // Karaoke pitch correct
  _el('voice-pitch-fix-btn')?.addEventListener('click', _runPitchCorrect);
}

export async function openVoiceModal() {
  _karaokeOnlyMode = false;
  _resetUI();
  await _syncVoicesFromDisk();
  await _initMyVoice();
  // Restore modal title and show all top tabs
  const titleEl = _el('voice-dialog-title');
  if (titleEl) titleEl.innerHTML = '<svg width="15" height="15"><use href="#icon-solo"/></svg> Replace Vocals';
  document.querySelectorAll('[data-vtab]').forEach(t => t.hidden = false);
  // Restore sub-tabs (Upload File + Train My Voice only — no Karaoke)
  document.querySelectorAll('[data-voice-tab]').forEach(t => t.hidden = false);
  const voiceId = _store?.getState().mashup.voiceId;
  if (voiceId) {
    _switchTopTab('recording');
    _showTestPanel(voiceId);
  } else {
    _switchTopTab('artist');
  }
  _showModal();
}

export async function openKaraokeModal() {
  _karaokeOnlyMode = true;
  _resetUI();
  // Title
  const titleEl = _el('voice-dialog-title');
  if (titleEl) titleEl.innerHTML = '<svg width="15" height="15"><use href="#icon-solo"/></svg> Karaoke';
  // Hide top-level tabs — go straight into karaoke
  document.querySelectorAll('[data-vtab]').forEach(t => t.hidden = true);
  // Hide the sub-tab bar (Upload File / Train My Voice) — not relevant in karaoke mode
  document.querySelectorAll('[data-voice-tab]').forEach(t => t.hidden = true);
  // Show recording panel with karaoke content visible
  const artistPanel    = _el('voice-panel-artist');
  const recordingPanel = _el('voice-panel-recording');
  const artistBtn      = _el('voice-artist-confirm-btn');
  const recordingBtn   = _el('voice-confirm-btn');
  if (artistPanel)    artistPanel.hidden    = true;
  if (recordingPanel) recordingPanel.hidden = false;
  if (artistBtn)      artistBtn.hidden      = true;
  if (recordingBtn)   recordingBtn.hidden   = false;
  // Switch to karaoke content and show song picker
  const karaokeContent = _el('voice-tab-karaoke');
  const uploadContent  = _el('voice-tab-upload');
  const trainContent   = _el('voice-tab-train');
  if (karaokeContent) karaokeContent.hidden = false;
  if (uploadContent)  uploadContent.hidden  = true;
  if (trainContent)   trainContent.hidden   = true;
  _renderSongPicker();
  _showKaraokePanel('voice-panel-pick');
  _showModal();
}
