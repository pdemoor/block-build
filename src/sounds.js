// Programmatic Web Audio sound effects — zero files, zero latency

let _ctx = null

export const sound = { muted: false }

function ac() {
  if (!_ctx) {
    try { _ctx = new (window.AudioContext || window.webkitAudioContext)() } catch { return null }
  }
  if (_ctx.state === 'suspended') _ctx.resume().catch(() => {})
  return _ctx
}

// Soft plastic "thock" — block placement
export function playPlace() {
  if (sound.muted) return
  const c = ac(); if (!c) return
  const t = c.currentTime

  const bpFreq = 420 + Math.random() * 160
  const len = Math.floor(c.sampleRate * 0.055)
  const buf = c.createBuffer(1, len, c.sampleRate)
  const d = buf.getChannelData(0)
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1
  const ns = c.createBufferSource(); ns.buffer = buf
  const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = bpFreq; bp.Q.value = 2.5
  const ng = c.createGain()
  ng.gain.setValueAtTime(0.22, t)
  ng.gain.exponentialRampToValueAtTime(0.001, t + 0.055)
  ns.connect(bp); bp.connect(ng); ng.connect(c.destination)
  ns.start(t); ns.stop(t + 0.06)

  const osc = c.createOscillator(); osc.type = 'sine'
  osc.frequency.setValueAtTime(150 + Math.random() * 30, t)
  osc.frequency.exponentialRampToValueAtTime(75, t + 0.065)
  const og = c.createGain()
  og.gain.setValueAtTime(0.13, t)
  og.gain.exponentialRampToValueAtTime(0.001, t + 0.065)
  osc.connect(og); og.connect(c.destination)
  osc.start(t); osc.stop(t + 0.07)
}

// Low thumps — knock over
export function playKnock() {
  if (sound.muted) return
  const c = ac(); if (!c) return

  ;[[0, 150, 0.28], [0.07, 110, 0.20], [0.15, 80, 0.14]].forEach(([off, freq, vol]) => {
    const t = c.currentTime + off + Math.random() * 0.025
    const len = Math.floor(c.sampleRate * 0.13)
    const buf = c.createBuffer(1, len, c.sampleRate)
    const d = buf.getChannelData(0)
    for (let j = 0; j < len; j++) d[j] = Math.random() * 2 - 1
    const ns = c.createBufferSource(); ns.buffer = buf
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = freq
    const g = c.createGain()
    g.gain.setValueAtTime(vol, t)
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.13)
    ns.connect(lp); lp.connect(g); g.connect(c.destination)
    ns.start(t); ns.stop(t + 0.14)
  })
}

// Crisp click — UI button press
export function playTap() {
  if (sound.muted) return
  const c = ac(); if (!c) return
  const t = c.currentTime
  const osc = c.createOscillator(); osc.type = 'triangle'
  osc.frequency.setValueAtTime(1300 + Math.random() * 200, t)
  osc.frequency.exponentialRampToValueAtTime(700, t + 0.025)
  const g = c.createGain()
  g.gain.setValueAtTime(0.07, t)
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.025)
  osc.connect(g); g.connect(c.destination)
  osc.start(t); osc.stop(t + 0.03)
}

// Rising shimmer arpeggio — float mode on
export function playFloatOn() {
  if (sound.muted) return
  const c = ac(); if (!c) return
  const t = c.currentTime
  ;[330, 415, 523].forEach((freq, i) => {
    const d = i * 0.065
    const osc = c.createOscillator(); osc.type = 'sine'; osc.frequency.value = freq
    const g = c.createGain()
    g.gain.setValueAtTime(0, t + d)
    g.gain.linearRampToValueAtTime(0.065 / (i * 0.4 + 1), t + d + 0.09)
    g.gain.exponentialRampToValueAtTime(0.001, t + d + 0.42)
    osc.connect(g); g.connect(c.destination)
    osc.start(t + d); osc.stop(t + d + 0.46)
  })
}

// Falling tone — float mode off
export function playFloatOff() {
  if (sound.muted) return
  const c = ac(); if (!c) return
  const t = c.currentTime
  const osc = c.createOscillator(); osc.type = 'sine'
  osc.frequency.setValueAtTime(360, t)
  osc.frequency.exponentialRampToValueAtTime(190, t + 0.18)
  const g = c.createGain()
  g.gain.setValueAtTime(0.068, t)
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.18)
  osc.connect(g); g.connect(c.destination)
  osc.start(t); osc.stop(t + 0.20)
}
