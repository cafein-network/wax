import { resumeBeat } from './behavior.mjs';

const BPM = 76;
const BEAT = 60 / BPM;
const VOLUME = 0.16;
const CHORDS = [[41, 57, 60, 64, 69], [40, 55, 59, 62, 67], [38, 53, 57, 60, 65], [36, 52, 55, 59, 64]];
const LOOKAHEAD = 0.25;
const TICK_MS = 100;

const hz = (note) => 440 * 2 ** ((note - 69) / 12);

let audio = null, master = null, filter = null, timer = null, nextBeat = 0, beatIndex = 0, noise = null;
let wanted = false;

function noiseBuffer(ctx) {
  const buffer = ctx.createBuffer(1, ctx.sampleRate * 0.2, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

function tone(freq, at, length, { type = 'triangle', gain = 0.08, attack = 0.04 } = {}) {
  const osc = audio.createOscillator(), env = audio.createGain();
  osc.type = type; osc.frequency.value = freq;
  osc.detune.value = (Math.random() - 0.5) * 8;
  env.gain.setValueAtTime(0, at);
  env.gain.linearRampToValueAtTime(gain, at + attack);
  env.gain.exponentialRampToValueAtTime(0.0001, at + length);
  osc.connect(env).connect(filter);
  osc.start(at); osc.stop(at + length + 0.05);
}

function kick(at) {
  const osc = audio.createOscillator(), env = audio.createGain();
  osc.frequency.setValueAtTime(120, at);
  osc.frequency.exponentialRampToValueAtTime(45, at + 0.18);
  env.gain.setValueAtTime(0.35, at);
  env.gain.exponentialRampToValueAtTime(0.0001, at + 0.3);
  osc.connect(env).connect(master);
  osc.start(at); osc.stop(at + 0.32);
}

function hat(at, gain) {
  const src = audio.createBufferSource(), hp = audio.createBiquadFilter(), env = audio.createGain();
  src.buffer = noise; hp.type = 'highpass'; hp.frequency.value = 7000;
  env.gain.setValueAtTime(gain, at);
  env.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);
  src.connect(hp).connect(env).connect(master);
  src.start(at); src.stop(at + 0.06);
}

function playBeat(at) {
  const bar = Math.floor(beatIndex / 4) % CHORDS.length, step = beatIndex % 4;
  const [bass, ...chord] = CHORDS[bar];
  if (step === 0) chord.forEach((note, i) => tone(hz(note), at + i * 0.03, BEAT * 4, { gain: 0.045, attack: 0.3 }));
  if (step === 0 || step === 2) tone(hz(bass), at, BEAT * 1.6, { type: 'sine', gain: 0.16, attack: 0.02 });
  if (step === 0 || step === 2) kick(at);
  hat(at + BEAT / 2, 0.04); hat(at, step % 2 ? 0.05 : 0.025);
  if (Math.random() < 0.45) tone(hz(chord[Math.floor(Math.random() * chord.length)] + 12), at + BEAT * (Math.random() < 0.5 ? 0 : 0.5), BEAT * 1.2, { type: 'sine', gain: 0.05 });
  beatIndex++;
}

function schedule() {
  const resumed = resumeBeat(nextBeat, audio.currentTime, BEAT, beatIndex);
  nextBeat = resumed.nextBeat; beatIndex = resumed.index;
  while (nextBeat < audio.currentTime + LOOKAHEAD) { playBeat(nextBeat); nextBeat += BEAT; }
}

export const isPlaying = () => wanted;

export async function startMusic() {
  if (wanted) return true;
  const Ctx = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  if (!Ctx) return false;
  audio ??= new Ctx();
  if (!master) {
    master = audio.createGain(); master.gain.value = 0;
    filter = audio.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 1800; filter.Q.value = 0.4;
    filter.connect(master).connect(audio.destination);
    noise = noiseBuffer(audio);
  }
  wanted = true;
  await audio.resume();
  if (!wanted || timer) return wanted;
  master.gain.cancelScheduledValues(audio.currentTime);
  master.gain.linearRampToValueAtTime(VOLUME, audio.currentTime + 0.8);
  nextBeat = audio.currentTime + 0.1; beatIndex = 0;
  timer = setInterval(schedule, TICK_MS);
  schedule();
  return true;
}

export function stopMusic() {
  wanted = false;
  if (!timer) return;
  clearInterval(timer); timer = null;
  const at = audio.currentTime;
  master.gain.cancelScheduledValues(at);
  master.gain.setValueAtTime(master.gain.value, at);
  master.gain.linearRampToValueAtTime(0, at + 0.6);
  setTimeout(() => { if (!wanted) audio.suspend(); }, 700);
}
