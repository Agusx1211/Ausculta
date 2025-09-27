// Config
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(err => console.error('Service worker registration failed', err));
  });
}
const ENV_FS_DEFAULT = 200;        // envelope sample rate (Hz)
const MIN_BPM = 40, MAX_BPM = 210; // search range
const MAX_PEAKS = 3;

// State
let ctx, stream, src, hp, lp, envNode, recNode, mute, rafId;
let envelopeFs = ENV_FS_DEFAULT;
let ring;              // Ring buffer of envelope
let envWindowSec = 8;  // UI controlled
let sensitivity = 1.0; // UI controlled [0.5..2.0]
let lastACF = null;    // For plotting
let liveActive = false;
let animationRunning = false;

const recorder = { active: false, chunks: [], length: 0, sampleRate: 0 };
let recordedData = null; // { buffer: Float32Array, sampleRate }

let playbackData = null; // { raw, sampleRate, env, envFs, duration, label, peaks }
let playbackCtx = null;
let playbackGains = { original: null, augmented: null };
let playbackState = null; // { playing, startedAt, offset, currentTime, sourceOriginal, sourceAugmented }
let playbackOutputMode = 'original';
let heartbeatCache = { bpm: null, sampleRate: null, buffer: null };
let recorderFlushPromise = null;
let recorderFlushResolve = null;
let deferredInstallPrompt = null;

// UI
const startBtn = document.getElementById('startBtn');
const stopBtn  = document.getElementById('stopBtn');
const statusEl = document.getElementById('status');
const srEl     = document.getElementById('sr');
const efsEl    = document.getElementById('efs');
const beatsEl  = document.getElementById('beats');
const waveCv   = document.getElementById('wave');
const acfCv    = document.getElementById('acf');
const sensEl   = document.getElementById('sens');
const winSecEl = document.getElementById('winSec');
const recordBtn = document.getElementById('recordBtn');
const stopRecordBtn = document.getElementById('stopRecordBtn');
const downloadBtn = document.getElementById('downloadBtn');
const uploadInput = document.getElementById('uploadInput');
const playBtn = document.getElementById('playBtn');
const pauseBtn = document.getElementById('pauseBtn');
const seekEl = document.getElementById('seek');
const playbackTimeEl = document.getElementById('playbackTime');
const outputModeEl = document.getElementById('outputMode');
const installStrip = document.getElementById('installStrip');
const installPwaBtn = document.getElementById('installPwaBtn');

sensEl.addEventListener('input', () => sensitivity = parseFloat(sensEl.value));
winSecEl.addEventListener('change', () => {
  envWindowSec = parseInt(winSecEl.value, 10);
  if (ring) ring.resize(Math.ceil(envelopeFs * envWindowSec * 1.25));
});

startBtn.addEventListener('click', start);
stopBtn.addEventListener('click', stop);
recordBtn.addEventListener('click', startRecording);
stopRecordBtn.addEventListener('click', stopRecording);
downloadBtn.addEventListener('click', downloadRecording);
uploadInput.addEventListener('change', onUploadSelected);
playBtn.addEventListener('click', playPlayback);
pauseBtn.addEventListener('click', pausePlayback);
seekEl.addEventListener('input', onSeekInput);
seekEl.addEventListener('change', onSeekRelease);
outputModeEl.addEventListener('change', () => setPlaybackOutput(outputModeEl.value));

if (installStrip && installPwaBtn) {
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    deferredInstallPrompt = event;
    installStrip.hidden = false;
  });

  installPwaBtn.addEventListener('click', async () => {
    installPwaBtn.disabled = true;
    try {
      if (!deferredInstallPrompt) {
        installStrip.hidden = true;
        return;
      }
      deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice;
    } finally {
      deferredInstallPrompt = null;
      installStrip.hidden = true;
      installPwaBtn.disabled = false;
    }
  });

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    installStrip.hidden = true;
  });
}

async function start() {
  if (liveActive) return;
  try {
    status("Requesting microphone…");
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1
      }
    });
    ctx = new (window.AudioContext || window.webkitAudioContext)({latencyHint: 'interactive'});
    await ctx.resume();

    status("Building audio graph…");
    await setupWorklet(ctx);

    src = ctx.createMediaStreamSource(stream);

    recNode = new AudioWorkletNode(ctx, 'recorder-processor', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    recNode.port.onmessage = onRecorderMessage;

    hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 20; hp.Q.value = 0.707;
    lp = ctx.createBiquadFilter(); lp.type = 'lowpass';  lp.frequency.value = 150; lp.Q.value = 0.707;

    envNode = new AudioWorkletNode(ctx, 'envelope-processor', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    envNode.port.onmessage = onEnvelopeChunk;

    mute = ctx.createGain(); mute.gain.value = 0; // keep graph alive, no sound

    // Connect: mic -> recorder tap -> HP -> LP -> Worklet -> mute -> destination
    src.connect(recNode).connect(hp).connect(lp).connect(envNode).connect(mute).connect(ctx.destination);

    // Init ring buffer sized to current window
    envelopeFs = ENV_FS_DEFAULT;
    ring = new RingBuffer(Math.ceil(envelopeFs * envWindowSec * 1.25));

    // UI
    srEl.textContent = `${Math.round(ctx.sampleRate)} Hz`;
    efsEl.textContent = `${envelopeFs} Hz`;
    status("Listening");
    liveActive = true;
    startBtn.disabled = true; stopBtn.disabled = false;
    recordBtn.disabled = false; stopRecordBtn.disabled = true;

    ensureLoop();

  } catch (err) {
    console.error(err);
    status("Microphone error");
    alert("Microphone failed: " + (err?.message || err));
    stop();
  }
}

async function stop() {
  if (!liveActive) return;

  let flushPromise = null;
  if (recorder.active) {
    flushPromise = stopRecording();
  }
  if (flushPromise) {
    try { await flushPromise; } catch {}
  }

  if (envNode) envNode.port.onmessage = null;
  try { hp && hp.disconnect(); lp && lp.disconnect(); envNode && envNode.disconnect(); mute && mute.disconnect(); } catch {}
  try { recNode && recNode.disconnect(); } catch {}
  try { src && src.disconnect(); } catch {}
  if (ctx && ctx.state !== 'closed') ctx.close();
  if (stream) stream.getTracks().forEach(t => t.stop());

  ctx = null; stream = null; src = null; hp = null; lp = null; envNode = null; recNode = null; mute = null;
  liveActive = false;
  ring = null;

  startBtn.disabled = false; stopBtn.disabled = true;
  recordBtn.disabled = true; stopRecordBtn.disabled = true;

  if (!playbackData) status("Idle");

  refreshLoopState();
}

function ensureLoop() {
  if (animationRunning) return;
  animationRunning = true;
  rafId = requestAnimationFrame(loop);
}

function stopLoop() {
  animationRunning = false;
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

function refreshLoopState() {
  if (liveActive || playbackData) {
    ensureLoop();
  } else {
    stopLoop();
  }
}

function startRecording() {
  if (!ctx || !recNode || !liveActive) {
    status('Start the microphone before recording.');
    return;
  }
  if (recorder.active) return;
  recorder.active = true;
  recorder.chunks = [];
  recorder.length = 0;
  recorder.sampleRate = ctx.sampleRate;
  recordBtn.disabled = true;
  stopRecordBtn.disabled = false;
  downloadBtn.disabled = true;
  recordedData = null;
  recorderFlushPromise = null;
  recorderFlushResolve = null;
  recNode.port.postMessage({ cmd: 'start' });
  status("Recording (mic)…");
}

function stopRecording() {
  if (!recorder.active || !recNode) return;
  recorder.active = false;
  recordBtn.disabled = false;
  stopRecordBtn.disabled = true;
  recNode.port.postMessage({ cmd: 'stop' });
  if (!recorderFlushPromise) {
    recorderFlushPromise = new Promise(resolve => { recorderFlushResolve = resolve; });
  }
  return recorderFlushPromise;
}

function finalizeRecording() {
  if (!recorder.sampleRate || !recorder.chunks.length) {
    status("No audio captured");
    if (recorderFlushResolve) {
      recorderFlushResolve();
      recorderFlushResolve = null;
      recorderFlushPromise = null;
    }
    return;
  }
  const sampleRate = recorder.sampleRate;
  const merged = mergeChunks(recorder.chunks, recorder.length);
  recorder.chunks = [];
  recorder.length = 0;
  recorder.sampleRate = 0;
  recordedData = { buffer: merged, sampleRate };
  const duration = merged.length / sampleRate;
  status(`Recording ready (${formatTime(duration)})`);
  downloadBtn.disabled = false;
  preparePlayback(merged, sampleRate, 'Recorded session');
  if (recorderFlushResolve) {
    recorderFlushResolve();
    recorderFlushResolve = null;
    recorderFlushPromise = null;
  }
}

function mergeChunks(chunks, totalLength) {
  const out = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function downloadRecording() {
  if (!recordedData) return;
  const wav = encodeWav(recordedData.buffer, recordedData.sampleRate);
  const blob = new Blob([wav], { type: 'audio/wav' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `mic-heart-${Date.now()}.wav`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function onUploadSelected(ev) {
  const file = ev.target?.files?.[0];
  if (!file) return;
  try {
    status(`Loading ${file.name}…`);
    const arrayBuffer = await file.arrayBuffer();
    const tmpCtx = new (window.AudioContext || window.webkitAudioContext)();
    const audioBuffer = await tmpCtx.decodeAudioData(arrayBuffer);
    await tmpCtx.close();
    const length = audioBuffer.length;
    const channels = audioBuffer.numberOfChannels;
    const raw = new Float32Array(length);
    for (let ch = 0; ch < channels; ch++) {
      const data = audioBuffer.getChannelData(ch);
      for (let i = 0; i < length; i++) raw[i] += data[i];
    }
    if (channels > 1) {
      for (let i = 0; i < length; i++) raw[i] /= channels;
    }
    if (liveActive) await stop();
    recordedData = null;
    downloadBtn.disabled = true;
    preparePlayback(raw, audioBuffer.sampleRate, file.name);
  } catch (err) {
    console.error(err);
    status('Failed to load file');
    alert('Could not decode audio file.');
  } finally {
    uploadInput.value = '';
  }
}

async function playPlayback() {
  if (!playbackData) return;
  const ctx = ensurePlaybackContext();
  await ctx.resume();
  if (liveActive) await stop();
  if (!playbackState) initPlaybackState();
  if (playbackState.playing) return;
  startPlaybackSources();
  updatePlaybackControlsState();
  refreshLoopState();
}

function pausePlayback() {
  if (!playbackData || !playbackState?.playing || !playbackCtx) return;
  const elapsed = playbackCtx.currentTime - playbackState.startedAt;
  playbackState.currentTime = Math.min(playbackData.duration, playbackState.offset + elapsed);
  stopPlaybackSources(false);
  playbackState.offset = playbackState.currentTime;
  seekEl.value = playbackState.currentTime.toFixed(2);
  updatePlaybackControlsState();
}

function onSeekInput() {
  if (!playbackData || !playbackState) return;
  const value = clamp(parseFloat(seekEl.value) || 0, 0, playbackData.duration);
  playbackState.currentTime = value;
  playbackState.offset = value;
  updatePlaybackTimeDisplay();
}

function onSeekRelease() {
  if (!playbackData || !playbackState) return;
  const value = clamp(parseFloat(seekEl.value) || 0, 0, playbackData.duration);
  playbackState.currentTime = value;
  playbackState.offset = value;
  if (playbackState.playing) {
    startPlaybackSources();
  } else {
    updatePlaybackControlsState();
  }
}

function setPlaybackOutput(mode) {
  if (mode === 'augmented' && (!playbackData || !playbackData.primaryBpm)) {
    outputModeEl.value = 'original';
    return;
  }
  playbackOutputMode = mode;
  updatePlaybackGains();
}

function preparePlayback(raw, sampleRate, label) {
  if (!raw || !raw.length) {
    status('No audio content');
    return;
  }
  if (playbackState && playbackState.playing) {
    stopPlaybackSources(true);
  }
  const envFs = ENV_FS_DEFAULT;
  const envelope = computeEnvelope(raw, sampleRate, envFs);
  const detection = detectHeartRates(envelope, envFs, sensitivity);
  playbackData = {
    raw,
    sampleRate,
    env: envelope,
    envFs,
    duration: raw.length / sampleRate,
    label,
    peaks: detection.peaks,
    primaryBpm: detection.peaks?.[0]?.bpm || null
  };
  initPlaybackState();
  seekEl.max = playbackData.duration.toFixed(2);
  seekEl.value = '0';
  playbackTimeEl.textContent = `${formatTime(0)} / ${formatTime(playbackData.duration)}`;
  outputModeEl.value = 'original';
  setPlaybackOutput('original');
  const augmentedOption = outputModeEl.querySelector('option[value="augmented"]');
  if (augmentedOption) augmentedOption.disabled = !playbackData.primaryBpm;
  outputModeEl.disabled = !playbackData.primaryBpm;
  seekEl.disabled = false;
  playBtn.disabled = false;
  pauseBtn.disabled = true;
  status(`Playback ready (${label})`);
  refreshLoopState();
}

function initPlaybackState() {
  playbackState = {
    playing: false,
    startedAt: 0,
    offset: 0,
    currentTime: 0,
    sourceOriginal: null,
    sourceAugmented: null
  };
  updatePlaybackControlsState();
}

function ensurePlaybackContext() {
  if (playbackCtx) return playbackCtx;
  playbackCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
  playbackGains.original = playbackCtx.createGain();
  playbackGains.augmented = playbackCtx.createGain();
  playbackGains.original.connect(playbackCtx.destination);
  playbackGains.augmented.connect(playbackCtx.destination);
  updatePlaybackGains();
  return playbackCtx;
}

function updatePlaybackGains() {
  if (!playbackGains.original || !playbackGains.augmented) return;
  playbackGains.original.gain.value = playbackOutputMode === 'original' ? 1 : 0;
  playbackGains.augmented.gain.value = playbackOutputMode === 'augmented' ? 1 : 0;
}

function startPlaybackSources() {
  if (!playbackData) return;
  const ctx = ensurePlaybackContext();
  const { raw, sampleRate, duration } = playbackData;
  const offset = clamp(playbackState.currentTime, 0, duration);

  stopPlaybackSources(false);

  const buffer = ctx.createBuffer(1, raw.length, sampleRate);
  buffer.copyToChannel(raw, 0);

  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(playbackGains.original);
  src.onended = handlePlaybackEnded;
  playbackState.sourceOriginal = src;
  playbackState.startedAt = ctx.currentTime;
  playbackState.offset = offset;
  playbackState.currentTime = offset;
  playbackState.playing = true;
  src.start(0, offset);

  if (playbackData.primaryBpm) {
    const heartbeat = getHeartbeatBuffer(ctx, playbackData.primaryBpm);
    if (heartbeat) {
      const hb = ctx.createBufferSource();
      hb.buffer = heartbeat;
      hb.loop = true;
      hb.playbackRate.value = playbackData.primaryBpm / 60;
      hb.connect(playbackGains.augmented);
      const beatPhase = ((offset * playbackData.primaryBpm) / 60) % 1;
      const startOffset = beatPhase * heartbeat.duration;
      hb.start(0, startOffset);
      playbackState.sourceAugmented = hb;
    }
  } else {
    playbackState.sourceAugmented = null;
  }

  seekEl.value = offset.toFixed(2);
  updatePlaybackTimeDisplay();
  updatePlaybackControlsState();
}

function stopPlaybackSources(resetTime) {
  if (!playbackState) return;
  const orig = playbackState.sourceOriginal;
  const aug = playbackState.sourceAugmented;
  if (orig) {
    orig.onended = null;
    try { orig.stop(); } catch {}
    try { orig.disconnect(); } catch {}
  }
  if (aug) {
    try { aug.stop(); } catch {}
    try { aug.disconnect(); } catch {}
  }
  playbackState.sourceOriginal = null;
  playbackState.sourceAugmented = null;
  playbackState.playing = false;
  if (resetTime) {
    playbackState.currentTime = 0;
    playbackState.offset = 0;
  }
}

function handlePlaybackEnded() {
  if (!playbackState) return;
  playbackState.playing = false;
  playbackState.sourceOriginal = null;
  if (playbackState.sourceAugmented) {
    try { playbackState.sourceAugmented.stop(); } catch {}
    try { playbackState.sourceAugmented.disconnect(); } catch {}
    playbackState.sourceAugmented = null;
  }
  playbackState.currentTime = playbackData ? playbackData.duration : 0;
  playbackState.offset = playbackState.currentTime;
  seekEl.value = playbackState.currentTime.toFixed(2);
  updatePlaybackControlsState();
}

function updatePlaybackControlsState() {
  if (!playbackData) {
    playBtn.disabled = true;
    pauseBtn.disabled = true;
    seekEl.disabled = true;
    outputModeEl.disabled = true;
    playbackTimeEl.textContent = '00:00 / 00:00';
    return;
  }
  playBtn.disabled = !!playbackState?.playing;
  pauseBtn.disabled = !playbackState?.playing;
  seekEl.disabled = false;
  const augmentedOption = outputModeEl.querySelector('option[value="augmented"]');
  const hasHeartbeat = !!playbackData.primaryBpm;
  if (augmentedOption) augmentedOption.disabled = !hasHeartbeat;
  outputModeEl.disabled = !hasHeartbeat;
  updatePlaybackGains();
  updatePlaybackTimeDisplay();
}

function updatePlaybackTimeDisplay() {
  if (!playbackData || !playbackState) {
    playbackTimeEl.textContent = '00:00 / 00:00';
    return;
  }
  playbackTimeEl.textContent = `${formatTime(playbackState.currentTime)} / ${formatTime(playbackData.duration)}`;
}

function updatePlaybackClock() {
  if (!playbackData || !playbackState) return;
  if (playbackState.playing && playbackCtx) {
    const elapsed = playbackCtx.currentTime - playbackState.startedAt;
    const t = playbackState.offset + elapsed;
    if (t >= playbackData.duration) {
      playbackState.currentTime = playbackData.duration;
      stopPlaybackSources(false);
      updatePlaybackControlsState();
    } else {
      playbackState.currentTime = t;
    }
  }
  seekEl.value = playbackState.currentTime.toFixed(2);
  updatePlaybackTimeDisplay();
}

function getHeartbeatBuffer(ctx, bpm) {
  if (!bpm) return null;
  if (heartbeatCache.buffer && heartbeatCache.bpm === bpm && heartbeatCache.sampleRate === ctx.sampleRate) {
    return heartbeatCache.buffer;
  }
  const duration = 1; // seconds per beat at 60 BPM
  const length = Math.max(1, Math.round(ctx.sampleRate * duration));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);

  const addThump = (startSec, emphasis) => {
    const start = Math.floor(startSec * ctx.sampleRate);
    const width = Math.floor(0.08 * ctx.sampleRate);
    for (let i = 0; i < width && start + i < data.length; i++) {
      const t = i / ctx.sampleRate;
      const env = Math.exp(-t * 45) * emphasis;
      const osc = Math.sin(2 * Math.PI * 60 * t) + 0.5 * Math.sin(2 * Math.PI * 120 * t);
      data[start + i] += env * osc * 0.4;
    }
  };

  addThump(0, 1);
  addThump(0.3, 0.7);

  // Gentle high-frequency rustle
  for (let i = 0; i < data.length; i++) {
    data[i] += (Math.random() * 2 - 1) * 0.02 * Math.exp(-i / data.length);
  }

  heartbeatCache = { bpm, sampleRate: ctx.sampleRate, buffer };
  return buffer;
}

function status(s) { statusEl.textContent = s; }

async function setupWorklet(context) {
  if (context.audioWorklet) {
    const code = `
      class EnvelopeProcessor extends AudioWorkletProcessor {
        constructor() {
          super();
          this.envFs = ${ENV_FS_DEFAULT};
          this.decim = Math.max(1, Math.floor(sampleRate / this.envFs));
          this.acc = 0; this.count = 0;
          this.pending = [];
          // One-pole lowpass on envelope ~30 ms
          this.y = 0;
          this.alpha = (1/this.envFs) / (0.03 + (1/this.envFs));
        }
        process(inputs, outputs) {
          const input = inputs[0];
          if (!input || input.length === 0 || input[0].length === 0) { return true; }
          const ch = input[0];
          let y = this.y;
          for (let i = 0; i < ch.length; i++) {
            const a = Math.abs(ch[i]);
            this.acc += a; this.count++;
            if (this.count >= this.decim) {
              const sample = this.acc / this.count;
              y = y + this.alpha * (sample - y);
              this.pending.push(y);
              this.acc = 0; this.count = 0;
            }
            // silence output (keep graph alive)
            outputs[0][0][i] = 0;
          }
          this.y = y;
          if (this.pending.length >= 160) {
            const arr = new Float32Array(this.pending.length);
            for (let k = 0; k < arr.length; k++) arr[k] = this.pending[k];
            this.port.postMessage(arr, [arr.buffer]);
            this.pending.length = 0;
          }
          return true;
        }
      }
      class RecorderProcessor extends AudioWorkletProcessor {
        constructor() {
          super();
          this.recording = false;
          this.pending = [];
          this.pendingSamples = 0;
          this.port.onmessage = (ev) => {
            const cmd = ev.data?.cmd;
            if (cmd === 'start') {
              this.recording = true;
            } else if (cmd === 'stop') {
              this.recording = false;
              this.flush();
              this.port.postMessage({ type: 'stopped' });
            } else if (cmd === 'flush') {
              this.flush();
            }
          };
        }
        flush() {
          if (!this.pendingSamples) return;
          const merged = new Float32Array(this.pendingSamples);
          let offset = 0;
          for (let i = 0; i < this.pending.length; i++) {
            merged.set(this.pending[i], offset);
            offset += this.pending[i].length;
          }
          this.port.postMessage({ type: 'chunk', payload: merged }, [merged.buffer]);
          this.pending.length = 0;
          this.pendingSamples = 0;
        }
        process(inputs, outputs) {
          const input = inputs[0];
          if (!input || input.length === 0 || input[0].length === 0) { return true; }
          const ch = input[0];
          const out = outputs[0][0];
          out.set(ch);
          if (!this.recording) return true;
          const copy = new Float32Array(ch.length);
          copy.set(ch);
          this.pending.push(copy);
          this.pendingSamples += copy.length;
          if (this.pendingSamples >= 2048) this.flush();
          return true;
        }
      }
      registerProcessor('envelope-processor', EnvelopeProcessor);
      registerProcessor('recorder-processor', RecorderProcessor);
    `;
    const blob = new Blob([code], {type: 'application/javascript'});
    await context.audioWorklet.addModule(URL.createObjectURL(blob));
  } else {
    throw new Error("AudioWorklet not supported");
  }
}

function onEnvelopeChunk(ev) {
  const arr = ev.data;
  if (!arr || !ring) return;
  ring.pushArray(arr);
}

function onRecorderMessage(ev) {
  const { type, payload } = ev.data || {};
  if (type === 'chunk' && payload) {
    recorder.chunks.push(payload);
    recorder.length += payload.length;
  } else if (type === 'stopped') {
    finalizeRecording();
  }
}

// Ring buffer for Float32
class RingBuffer {
  constructor(capacity) { this.resize(capacity); }
  resize(capacity) {
    const old = this.buf;
    this.buf = new Float32Array(Math.max(32, capacity|0));
    this.write = 0; this.filled = false;
    if (old) {
      const copy = old.length <= this.buf.length ? old : old.subarray(old.length - this.buf.length);
      this.pushArray(copy);
    }
  }
  pushArray(arr) {
    let i = 0;
    while (i < arr.length) {
      const space = this.buf.length - this.write;
      const n = Math.min(space, arr.length - i);
      this.buf.set(arr.subarray(i, i + n), this.write);
      this.write = (this.write + n) % this.buf.length;
      if (this.write === 0) this.filled = true;
      i += n;
    }
  }
  last(n) {
    const available = this.filled ? this.buf.length : this.write;
    const N = Math.min(n, available);
    const out = new Float32Array(N);
    const start = (this.write - N + this.buf.length) % this.buf.length;
    const end = (start + N);
    if (end <= this.buf.length) {
      out.set(this.buf.subarray(start, end), 0);
    } else {
      const n1 = this.buf.length - start;
      out.set(this.buf.subarray(start), 0);
      out.set(this.buf.subarray(0, N - n1), n1);
    }
    return out;
  }
}

// Heartbeat detection using normalized autocorrelation on envelope
function detectHeartRates(env, fs, sensitivityFactor) {
  const N = env.length;
  if (N < fs * 2) return { peaks: [], acf: null, bpmAxis: null }; // need ≥2s
  // Detrend
  let mean = 0; for (let i = 0; i < N; i++) mean += env[i];
  mean /= N;
  const x = new Float32Array(N);
  let energy = 0;
  for (let i = 0; i < N; i++) { const v = env[i] - mean; x[i] = v; energy += v*v; }
  if (energy < 1e-9) return { peaks: [], acf: null, bpmAxis: null };

  const minLag = Math.round(fs * 60 / MAX_BPM);
  const maxLag = Math.round(fs * 60 / MIN_BPM);
  const L = maxLag - minLag + 1;
  const acf = new Float32Array(L);
  for (let l = minLag; l <= maxLag; l++) {
    let s = 0;
    for (let i = l; i < N; i++) s += x[i] * x[i - l];
    acf[l - minLag] = s / energy; // normalized by overall energy
  }

  const bpmAxis = new Float32Array(L);
  for (let k = 0; k < L; k++) {
    const lag = minLag + k;
    bpmAxis[k] = 60 * fs / lag;
  }

  // Peak picking
  const rawPeaks = [];
  for (let k = 1; k < L - 1; k++) {
    const a = acf[k - 1], b = acf[k], c = acf[k + 1];
    if (b > a && b > c) {
      // Parabolic interpolation
      const denom = (a - 2*b + c);
      let delta = 0;
      if (Math.abs(denom) > 1e-9) delta = 0.5 * (a - c) / denom;
      const lag = (minLag + k + delta);
      const corr = b - 0.25 * (a - c) * delta; // peak value
      const bpm = 60 * fs / lag;
      if (bpm >= MIN_BPM && bpm <= MAX_BPM) rawPeaks.push({ bpm, corr });
    }
  }

  // Threshold scales inversely with sensitivity: more sensitive => lower threshold
  const maxCorr = rawPeaks.reduce((m,p)=>Math.max(m,p.corr), 0);
  const base = 0.22; // baseline correlation requirement
  const thr  = Math.min(0.95, Math.max(0.12, (base / sensitivityFactor)));
  const filtered = rawPeaks.filter(p => p.corr >= Math.max(thr, 0.4 * maxCorr));

  // Sort by correlation and deduplicate within 8 BPM and suppress near ×2 harmonics
  filtered.sort((a,b)=>b.corr - a.corr);
  const chosen = [];
  for (const p of filtered) {
    let keep = true;
    for (const q of chosen) {
      const close = Math.abs(p.bpm - q.bpm) < 8;
      const harmonic = (p.bpm > q.bpm)
          ? Math.abs(p.bpm / q.bpm - 2) < 0.06
          : Math.abs(q.bpm / p.bpm - 2) < 0.06;
      if (close || harmonic) {
        // keep stronger
        if (p.corr > q.corr) {
          const idx = chosen.indexOf(q);
          if (idx >= 0) chosen.splice(idx, 1, p);
        }
        keep = false;
        break;
      }
    }
    if (keep) chosen.push(p);
    if (chosen.length >= MAX_PEAKS) break;
  }

  // Confidence 0..1
  const out = chosen.map(p => ({ bpm: p.bpm, conf: clamp((p.corr - thr) / Math.max(1e-6, (maxCorr - thr)), 0, 1), corr: p.corr }))
                    .sort((a,b)=>b.bpm - a.bpm); // show faster first (often fetal)

  return { peaks: out, acf, bpmAxis };
}

function clamp(x, a, b){ return Math.max(a, Math.min(b, x)); }

function computeEnvelope(raw, sampleRate, envFs) {
  const hp = new Biquad('highpass', sampleRate, 20, 0.707);
  const lp = new Biquad('lowpass', sampleRate, 150, 0.707);
  const decim = Math.max(1, Math.floor(sampleRate / envFs));
  const alpha = (1 / envFs) / (0.03 + (1 / envFs));
  const out = new Float32Array(Math.ceil(raw.length / decim) + 4);
  let acc = 0, count = 0, idx = 0, y = 0;
  for (let i = 0; i < raw.length; i++) {
    let v = hp.process(raw[i]);
    v = lp.process(v);
    const rect = Math.abs(v);
    acc += rect;
    count++;
    if (count >= decim) {
      const sample = acc / count;
      y = y + alpha * (sample - y);
      out[idx++] = y;
      acc = 0; count = 0;
    }
  }
  return out.subarray(0, idx);
}

class Biquad {
  constructor(type, sampleRate, freq, Q) {
    this.type = type;
    this.sampleRate = sampleRate;
    this.freq = freq;
    this.Q = Q;
    this._computeCoeffs();
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
  }
  _computeCoeffs() {
    const w0 = 2 * Math.PI * this.freq / this.sampleRate;
    const cos = Math.cos(w0);
    const sin = Math.sin(w0);
    const alpha = sin / (2 * this.Q);
    let b0, b1, b2, a0, a1, a2;
    if (this.type === 'highpass') {
      b0 = (1 + cos) / 2;
      b1 = -(1 + cos);
      b2 = (1 + cos) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
    } else if (this.type === 'lowpass') {
      b0 = (1 - cos) / 2;
      b1 = 1 - cos;
      b2 = (1 - cos) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
    } else {
      throw new Error('Unsupported biquad type');
    }
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = a1 / a0;
    this.a2 = a2 / a0;
  }
  process(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x;
    this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

function encodeWav(floatData, sampleRate) {
  const samples = floatData.length;
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);

  const writeString = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + samples * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // channels
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeString(36, 'data');
  view.setUint32(40, samples * 2, true);

  let offset = 44;
  for (let i = 0; i < samples; i++, offset += 2) {
    let s = Math.max(-1, Math.min(1, floatData[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return buffer;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return '00:00';
  const total = Math.max(0, Math.round(seconds));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}`;
}

// Drawing
function drawSeries(canvas, xs, ys, {xMin, xMax, yMin, yMax, labels} = {}) {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const w = canvas.clientWidth * dpr, h = canvas.clientHeight * dpr;
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0,0,w,h);
  ctx.lineWidth = Math.max(1, 1 * dpr);

  // Axes (light)
  ctx.globalAlpha = 0.35;
  ctx.beginPath();
  ctx.moveTo(0, h-0.5); ctx.lineTo(w, h-0.5);
  ctx.moveTo(0.5, 0);   ctx.lineTo(0.5, h);
  ctx.strokeStyle = getComputedStyle(document.body).color;
  ctx.stroke();
  ctx.globalAlpha = 1;

  if (!xs || !ys || xs.length === 0) return;

  const Xmin = xMin ?? Math.min(...xs), Xmax = xMax ?? Math.max(...xs);
  const Ymin = yMin ?? Math.min(...ys), Ymax = yMax ?? Math.max(...ys);
  const sx = (w-8) / (Xmax - Xmin || 1), sy = (h-8) / (Ymax - Ymin || 1);

  ctx.beginPath();
  for (let i = 0; i < xs.length; i++) {
    const x = 4 + (xs[i] - Xmin) * sx;
    const y = h - 4 - (ys[i] - Ymin) * sy;
    if (i === 0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
  }
  ctx.strokeStyle = getComputedStyle(document.body).color;
  ctx.stroke();

  // Labels
  if (labels?.length) {
    ctx.font = `${12 * dpr}px ui-sans-serif, system-ui`;
    ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
    ctx.fillStyle = getComputedStyle(document.body).color;
    labels.forEach((t,i)=>ctx.fillText(t, w - 6, h - 6 - i*14*dpr));
  }
}

function loop() {
  if (!animationRunning) { rafId = null; return; }
  rafId = requestAnimationFrame(loop);

  updatePlaybackClock();

  const { env, fs } = getCurrentEnvelopeWindow();
  const envArr = env ?? new Float32Array();
  const fsUsed = fs || envelopeFs;
  const xsEnv = new Float32Array(envArr.length);
  for (let i = 0; i < xsEnv.length; i++) xsEnv[i] = (i - xsEnv.length) / fsUsed;
  drawSeries(waveCv, xsEnv, envArr, { labels: [ "← time (s)" ] });

  const { peaks, acf, bpmAxis } = detectHeartRates(envArr, fsUsed, sensitivity);
  lastACF = acf ? { acf, bpmAxis } : null;

  renderAcf(peaks, lastACF);
  renderPeaks(peaks);
}

function getCurrentEnvelopeWindow() {
  if (liveActive && ring) {
    const fs = envelopeFs;
    const N = Math.round(fs * envWindowSec);
    return { env: ring.last(N), fs };
  }
  if (playbackData) {
    const fs = playbackData.envFs;
    const N = Math.round(fs * envWindowSec);
    if (!playbackState) initPlaybackState();
    const current = clamp(playbackState.currentTime || 0, 0, playbackData.duration);
    const endIndex = Math.min(playbackData.env.length, Math.max(0, Math.round(current * fs)));
    const startIndex = Math.max(0, endIndex - N);
    const slice = playbackData.env.subarray(startIndex, endIndex);
    return { env: slice, fs };
  }
  return { env: new Float32Array(), fs: envelopeFs };
}

function renderAcf(peaks, info) {
  if (!info || !info.acf || !info.bpmAxis) {
    drawSeries(acfCv, [], []);
    return;
  }
  const acf = info.acf;
  const bpmAxis = info.bpmAxis;
  const maxAcf = acf.length ? Math.max(...acf) : 0;
  const yMax = Math.max(0.01, maxAcf * 1.05);
  drawSeries(acfCv, bpmAxis, acf, {
    xMin: MIN_BPM,
    xMax: MAX_BPM,
    yMin: 0,
    yMax,
    labels: [ "BPM →", "corr" ]
  });
  const ctx2 = acfCv.getContext('2d');
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const w = acfCv.width, h = acfCv.height;
  const sx = (w - 8) / (MAX_BPM - MIN_BPM || 1);
  const sy = (h - 8) / (yMax || 1);
  ctx2.save();
  ctx2.translate(4, 0);
  if (peaks) {
    for (const p of peaks) {
      const x = (p.bpm - MIN_BPM) * sx;
      const y = h - 4 - p.corr * sy;
      ctx2.beginPath(); ctx2.arc(x, y, 4 * dpr, 0, Math.PI * 2); ctx2.stroke();
    }
  }
  ctx2.restore();
}

function renderPeaks(peaks) {
  beatsEl.innerHTML = "";
  if (peaks && peaks.length) {
    for (const p of peaks) {
      const div = document.createElement('div');
      div.className = 'chip';
      const tag = document.createElement('span');
      const bpm = Math.round(p.bpm);
      tag.className = 'badge ' + (bpm >= 110 && bpm <= 160 ? 'ok' : (bpm < 50 || bpm > 180 ? 'warn' : ''));
      tag.textContent = (bpm >= 110 && bpm <= 160) ? 'fetal range' : ((bpm < 50 || bpm > 180) ? 'atypical' : 'adult range');
      const strong = document.createElement('span'); strong.className = 'bpm'; strong.textContent = `${bpm} BPM`;
      const conf = document.createElement('span'); conf.className = 'conf'; conf.textContent = `conf ${(p.conf*100).toFixed(0)}%`;
      div.append(strong, conf, tag);
      beatsEl.append(div);
    }
  } else {
    const empty = document.createElement('div');
    empty.className = 'small muted';
    empty.textContent = 'No stable peaks yet';
    beatsEl.append(empty);
  }
}

// Resize canvases on DPR / layout changes
const ro = new ResizeObserver(()=>{ if (animationRunning) { /* redraw handled next frame */ }});
ro.observe(waveCv); ro.observe(acfCv);

// Page unload safety
window.addEventListener('visibilitychange', () => { if (document.hidden && liveActive) stop(); });
