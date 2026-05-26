import { useState, useRef, useCallback, useEffect } from 'react'
import { Canvas } from '@react-three/fiber'
import { OrbitControls, Environment, ContactShadows } from '@react-three/drei'
import { Physics } from '@react-three/rapier'
import Scene from './Scene'
import { sound, playPlace, playKnock, playTap, playFloatOn, playFloatOff, playSave, playLoad } from './sounds'

const PALETTE = [
  '#e74c3c', '#e67e22', '#FFE600', '#2ecc71',   // 0-3  red, orange, neon-yellow, green
  '#3498db', '#9b59b6', '#1abc9c', '#FF2DAA',   // 4-7  blue, purple, aqua, arcade-pink
  '#ecf0f1', 'spaghetti', '#34495e', 'rainbow',  // 8-11 white, spaghetti, slate, rainbow
  '#D4AF37', '#C0C0C0', '#FF2A2A', '#FFB6D9',   // 12-15 gold, silver, bright-red, light-pink
  '#8B5A2B', 'glitter',                           // 16-17 brown, glitter
  '#7CFF00', '#7DF9FF', '#111111',               // 18-20 lime, ice-cyan, deep-black (NEW)
]
const LS_KEY = 'blockbuild_saves'
const LS_AUTOSAVE = 'blockbuild_autosave'
const FONT = "system-ui, -apple-system, sans-serif"
const MAX_HISTORY = 30

function swatchGlow(c) {
  if (c === 'rainbow') return 'rgba(255,200,80,0.70)'
  if (c === 'glitter') return 'rgba(180,215,255,0.68)'
  if (c === '#111111') return 'rgba(160,180,220,0.42)'  // black → cool silver glow
  if (c === '#FFE600') return 'rgba(255,230,0,0.75)'
  if (c === '#7CFF00') return 'rgba(124,255,0,0.75)'
  if (c === '#7DF9FF') return 'rgba(125,249,255,0.72)'
  if (c === '#FF2DAA') return 'rgba(255,45,170,0.75)'
  if (c === 'spaghetti') return 'rgba(232,192,80,0.72)'
  if (c === '#ecf0f1') return 'rgba(236,240,241,0.48)'
  if (c === '#D4AF37') return 'rgba(212,175,55,0.78)'
  return `${c}b0`   // default: 69% alpha (up from 53%)
}

function getSaves() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}') } catch { return {} }
}

// ---- Compact binary share encoding ----
// Each block = 21 bits packed into 3 bytes:
//   [gridX+12 : 5][gridZ+12 : 5][stackLevel : 5][colorIdx : 5][isFixed : 1]
function encodeDesign(blocks) {
  const buf = new Uint8Array(blocks.length * 3)
  blocks.forEach((b, i) => {
    const gx = Math.max(0, Math.min(31, b.gridX + 12))
    const gz = Math.max(0, Math.min(31, b.gridZ + 12))
    const sl = Math.max(0, Math.min(31, b.stackLevel))
    const ci = Math.max(0, PALETTE.indexOf(b.color))
    const fx = b.isFixed ? 1 : 0
    const bits = (gx << 16) | (gz << 11) | (sl << 6) | (ci << 1) | fx
    buf[i * 3]     = (bits >> 16) & 0xFF
    buf[i * 3 + 1] = (bits >> 8)  & 0xFF
    buf[i * 3 + 2] =  bits        & 0xFF
  })
  let bin = ''
  buf.forEach(b => { bin += String.fromCharCode(b) })
  return btoa(bin).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
}

function decodeDesign(str) {
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/'))
  const count = Math.floor(bin.length / 3)
  const blocks = []
  for (let i = 0; i < count; i++) {
    const bits = (bin.charCodeAt(i * 3) << 16) |
                 (bin.charCodeAt(i * 3 + 1) << 8) |
                  bin.charCodeAt(i * 3 + 2)
    const gx = ((bits >> 16) & 0x1F) - 12
    const gz = ((bits >> 11) & 0x1F) - 12
    const sl =  (bits >> 6)  & 0x1F
    const ci =  (bits >> 1)  & 0x1F
    const fx =   bits        & 1
    blocks.push({
      id: i,
      gridX: gx, gridZ: gz, stackLevel: sl,
      color: PALETTE[Math.min(ci, PALETTE.length - 1)],
      isFixed: fx === 1,
      position: [gx + 0.5, sl + 0.5, gz + 0.5],
    })
  }
  return blocks
}

function loadAutosave() {
  try {
    const raw = localStorage.getItem(LS_AUTOSAVE)
    if (!raw) return null
    return JSON.parse(raw)
  } catch { return null }
}

function loadFromUrl() {
  try {
    const d = new URLSearchParams(window.location.search).get('d')
    return d ? decodeDesign(d) : null
  } catch { return null }
}

export default function App() {
  const nextId = useRef(0)
  const orbitRef = useRef(null)

  const [blocks, setBlocks] = useState(() => {
    const fromUrl = loadFromUrl()
    if (fromUrl?.length) { nextId.current = fromUrl.length; return fromUrl }
    const autosaved = loadAutosave()
    if (autosaved?.length) {
      nextId.current = autosaved.length
      return autosaved.map((b, i) => ({
        ...b, id: i,
        isFixed: !!b.isFixed,
        position: [b.gridX + 0.5, b.stackLevel + 0.5, b.gridZ + 0.5],
      }))
    }
    return []
  })
  const [color, setColor] = useState('#3498db')
  const [isRandom, setIsRandom] = useState(false)
  const [knockKey, setKnockKey] = useState(0)
  const [physicsKey, setPhysicsKey] = useState(0)
  const [saves, setSaves] = useState(getSaves)
  const [modal, setModal] = useState(null) // 'save' | 'load' | null
  const [saveName, setSaveName] = useState('')
  const [canUndo, setCanUndo] = useState(false)
  const [antiGravity, setAntiGravity] = useState(false)
  const [placeHeight, setPlaceHeight] = useState(0)
  const [toast, setToast] = useState(null)
  const [isPhotoMode, setIsPhotoMode] = useState(false)
  const [muted, setMuted] = useState(() => { try { return localStorage.getItem('bb_muted') === '1' } catch { return false } })

  // Keep module-level sound state in sync on every render
  sound.muted = muted

  // Refs so callbacks always see current values
  const colorRef = useRef(color)
  colorRef.current = color
  const isRandomRef = useRef(isRandom)
  isRandomRef.current = isRandom
  const blocksRef = useRef(blocks)
  blocksRef.current = blocks
  const antiGravityRef = useRef(antiGravity)
  antiGravityRef.current = antiGravity
  const placeHeightRef = useRef(placeHeight)
  placeHeightRef.current = placeHeight
  const historyRef = useRef([])
  const toastTimer = useRef(null)
  const glRef = useRef(null)
  // Prevents duplicate placement when multiple event paths fire for one gesture (e.g.
  // both a Block's onPointerUp and the Floor's tap handler resolving the same touch).
  const lastPlaceTimeRef = useRef(0)

  useEffect(() => {
    if (!blocks.length) {
      localStorage.removeItem(LS_AUTOSAVE)
      return
    }
    try {
      const data = blocks.map(({ gridX, gridZ, stackLevel, color: c, isFixed }) =>
        ({ gridX, gridZ, stackLevel, color: c, isFixed: !!isFixed }))
      localStorage.setItem(LS_AUTOSAVE, JSON.stringify(data))
    } catch {}
  }, [blocks])

  function pushHistory(snap, type) {
    historyRef.current = [...historyRef.current.slice(-(MAX_HISTORY - 1)), { blocks: snap, type }]
    setCanUndo(true)
  }

  function showToast(msg) {
    setToast(msg)
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 2500)
  }

  const placeBlock = useCallback((gridX, gridZ) => {
    // Guard: if two event paths (Block tap + Floor tap) fire within 80 ms for the
    // same gesture, only the first call goes through. 80 ms is well below normal
    // inter-tap speed (~150 ms+) so rapid stacking is unaffected.
    const now = Date.now()
    if (now - lastPlaceTimeRef.current < 80) return
    lastPlaceTimeRef.current = now
    playPlace()
    pushHistory(blocksRef.current, 'place')
    const isAG = antiGravityRef.current
    const height = placeHeightRef.current
    const col = isRandomRef.current
      ? PALETTE[Math.floor(Math.random() * PALETTE.length)]
      : colorRef.current
    setBlocks(prev => {
      const stackLevel = isAG
        ? height
        : prev.filter(b => b.gridX === gridX && b.gridZ === gridZ).length
      return [...prev, {
        id: nextId.current++,
        gridX, gridZ, stackLevel,
        color: col,
        position: [gridX + 0.5, stackLevel + 0.5, gridZ + 0.5],
        isFixed: isAG,
      }]
    })
  }, [])

  const freeBlock = useCallback((id) => {
    setBlocks(prev => prev.map(b => b.id === id ? { ...b, isFixed: false } : b))
  }, [])

  const knockDown = useCallback(() => {
    playKnock()
    pushHistory(blocksRef.current, 'knock')
    setBlocks(prev => prev.map(b => b.isFixed ? { ...b, isFixed: false } : b))
    setKnockKey(k => k + 1)
  }, [])

  const undo = useCallback(() => {
    const h = historyRef.current
    if (!h.length) return
    const { blocks: snap, type } = h[h.length - 1]
    historyRef.current = h.slice(0, -1)
    setCanUndo(historyRef.current.length > 0)
    nextId.current = snap.length > 0 ? snap.reduce((m, b) => Math.max(m, b.id), -1) + 1 : 0
    setBlocks(snap)
    if (type === 'knock') setPhysicsKey(k => k + 1)
  }, [])

  const clear = useCallback(() => {
    if (!blocksRef.current.length) return
    pushHistory(blocksRef.current, 'place')
    setBlocks([])
    nextId.current = 0
    setPhysicsKey(k => k + 1)
  }, [])

  const handleShare = useCallback(() => {
    const cur = blocksRef.current
    if (!cur.length) return
    const code = encodeDesign(cur)
    const url = `${window.location.origin}${window.location.pathname}?d=${code}`
    if (navigator.share) {
      navigator.share({ title: 'Block Build', text: 'Check out my block design!', url }).catch(() => {})
    } else {
      navigator.clipboard.writeText(url)
        .then(() => showToast('Link copied!'))
        .catch(() => showToast('Copy failed'))
    }
  }, [])

  const handleScreenshot = useCallback(() => {
    const canvas = glRef.current?.domElement
    if (!canvas) return
    canvas.toBlob(blob => {
      if (!blob) return
      const file = new File([blob], 'block-build.png', { type: 'image/png' })
      if (navigator.canShare?.({ files: [file] })) {
        navigator.share({ files: [file], title: 'Block Build' }).catch(() => {})
      } else {
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url; a.download = 'block-build.png'; a.click()
        setTimeout(() => URL.revokeObjectURL(url), 60000)
      }
    }, 'image/png')
  }, [])

  const handleSave = useCallback(() => {
    const name = saveName.trim()
    if (!name) return
    const data = blocks.map(({ gridX, gridZ, stackLevel, color: c, isFixed }) =>
      ({ gridX, gridZ, stackLevel, color: c, isFixed: !!isFixed }))
    const updated = { ...saves, [name]: data }
    setSaves(updated)
    localStorage.setItem(LS_KEY, JSON.stringify(updated))
    playSave()
    setModal(null)
    setSaveName('')
  }, [saveName, blocks, saves])

  const handleLoad = useCallback((name) => {
    const data = saves[name]
    if (!data) return
    pushHistory(blocksRef.current, 'place')
    nextId.current = data.length
    setBlocks(data.map((b, i) => ({
      ...b, id: i,
      isFixed: !!b.isFixed,
      position: [b.gridX + 0.5, b.stackLevel + 0.5, b.gridZ + 0.5],
    })))
    setPhysicsKey(k => k + 1)
    playLoad()
    setModal(null)
  }, [saves])

  const handleDelete = useCallback((name) => {
    const updated = { ...saves }
    delete updated[name]
    setSaves(updated)
    localStorage.setItem(LS_KEY, JSON.stringify(updated))
    if (!Object.keys(updated).length) setModal(null)
  }, [saves])

  const toggleAntiGravity = useCallback(() => {
    setAntiGravity(v => {
      if (v) { setPlaceHeight(0); playFloatOff() }
      else playFloatOn()
      return !v
    })
  }, [])

  const toggleMute = useCallback(() => setMuted(m => {
    const next = !m
    try { localStorage.setItem('bb_muted', next ? '1' : '0') } catch {}
    return next
  }), [])

  const saveNames = Object.keys(saves)
  // Panel height (px, excluding safe-area) for positioning toast and modals above panel
  const panelH = antiGravity ? 196 : 150

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative', fontFamily: FONT, touchAction: 'none' }}>
      <style>{`
        /* Buttons: fast ease-in press, spring bounce-back, brightness dip for physical depth */
        .bb-btn {
          transition: transform 0.22s cubic-bezier(0.34,1.56,0.64,1), filter 0.20s ease;
          will-change: transform;
        }
        .bb-btn:active {
          transform: scale(0.87) !important;
          filter: brightness(0.82) !important;
          transition: transform 0.07s cubic-bezier(0.4,0,1,1), filter 0.07s ease !important;
        }
        /* Swatches: more elastic squeeze (smaller target, needs more feedback) */
        .bb-swatch {
          transition: transform 0.20s cubic-bezier(0.34,1.56,0.64,1), filter 0.16s ease;
          will-change: transform;
        }
        .bb-swatch:active {
          transform: scale(0.76) !important;
          filter: brightness(0.78) !important;
          transition: transform 0.06s cubic-bezier(0.4,0,1,1), filter 0.06s ease !important;
        }
        @keyframes bbSwatchPulse {
          0%, 100% { transform: scale(1.15); filter: brightness(1.0); }
          50%       { transform: scale(1.22); filter: brightness(1.16); }
        }
        .bb-swatch-selected { animation: bbSwatchPulse 1.9s ease-in-out infinite; }
        .bb-swatch-selected:active { animation: none; transform: scale(0.76) !important; filter: brightness(0.78) !important; transition: transform 0.06s cubic-bezier(0.4,0,1,1), filter 0.06s ease !important; }
        /* Pulsing glow on active-mode buttons (e.g. Float) */
        @keyframes bbActiveGlow {
          0%, 100% { filter: brightness(1.0); }
          50%       { filter: brightness(1.16); }
        }
        .bb-active-glow { animation: bbActiveGlow 2.4s ease-in-out infinite; }
        .bb-active-glow:active { animation: none !important; filter: brightness(0.82) !important; transition: filter 0.07s ease !important; }
        @keyframes bbFadeIn { from { opacity: 0; transform: scale(0.92); } to { opacity: 1; transform: scale(1); } }
        @keyframes bbLogoIn {
          from { opacity: 0; transform: translateY(-5px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .bb-logo-area { animation: bbLogoIn 0.65s cubic-bezier(0.25,0.46,0.45,0.94) 0.12s both; }
        @keyframes bbTitleShimmer {
          0%   { background-position: 160% center; }
          100% { background-position: -160% center; }
        }
        .bb-title {
          background: linear-gradient(90deg,
            rgba(255,255,255,0.70) 0%,
            rgba(220,205,255,0.82) 22%,
            rgba(255,255,255,0.97) 42%,
            rgba(190,220,255,0.88) 62%,
            rgba(220,205,255,0.82) 80%,
            rgba(255,255,255,0.70) 100%
          );
          background-size: 400% 100%;
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          background-clip: text;
          filter: drop-shadow(0 0 7px rgba(180,160,255,0.52)) drop-shadow(0 1px 2px rgba(0,0,0,0.55));
          animation: bbTitleShimmer 5.5s linear infinite;
        }
        .bb-input {
          background: rgba(255,255,255,0.07) !important;
          border: 1px solid rgba(255,255,255,0.14) !important;
          color: #fff !important;
          outline: none;
        }
        .bb-input::placeholder { color: rgba(255,255,255,0.35); }
        .bb-input:focus {
          border-color: rgba(180,160,255,0.40) !important;
          background: rgba(255,255,255,0.10) !important;
          box-shadow: 0 0 0 3px rgba(120,100,255,0.18) !important;
        }
      `}</style>

      <Canvas
        shadows="soft"
        camera={{ position: [8, 8, 24], fov: 50, near: 0.1, far: 200 }}
        gl={{ antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: true }}
        style={{ background: 'linear-gradient(180deg, #020610 0%, #050c1c 28%, #071228 58%, #050c1c 84%, #020407 100%)', touchAction: 'none' }}
        onCreated={({ gl }) => { gl.domElement.style.touchAction = 'none'; glRef.current = gl }}
      >
        <fog attach="fog" args={['#060b18', 58, 100]} />
        <ambientLight intensity={0.32} />
        <hemisphereLight args={['#162e5c', '#05090f', 0.52]} />
        <directionalLight
          position={[8, 14, 6]} intensity={0.82} castShadow
          shadow-mapSize={[1024, 1024]}
          shadow-camera-near={0.1} shadow-camera-far={60}
          shadow-camera-left={-16} shadow-camera-right={16}
          shadow-camera-top={16} shadow-camera-bottom={-16}
        />
        <pointLight position={[-6, 8, -10]} intensity={0.28} color="#1a3268" />
        <pointLight position={[2, 11, 9]} intensity={0.22} color="#fff5ea" />
        {/* Subtle up-light at floor center — faint blue pool that makes the build area feel grounded */}
        <pointLight position={[0, 0.18, 0]} intensity={0.18} color="#0d2050" distance={13} decay={2} />
        {/* Below-floor light — illuminates falling cubes seen through the translucent platform */}
        <pointLight position={[0, -7, 0]} intensity={0.52} color="#14284e" distance={38} decay={1.4} />
        {/* Soft contact shadows — one extra render pass at 512px, zero per-frame allocations */}
        <ContactShadows
          position={[0, 0.016, 0]}
          opacity={0.54}
          width={24}
          height={24}
          blur={2.8}
          far={26}
          resolution={512}
          color="#000a1e"
        />
        <Physics key={physicsKey} gravity={[0, -20, 0]}>
          <Scene
            blocks={blocks}
            knockKey={knockKey}
            onPlace={placeBlock}
            orbitRef={orbitRef}
            antiGravity={antiGravity}
            placeHeight={placeHeight}
            color={color}
            isRandom={isRandom}
            onFreeBlock={freeBlock}
            isPhotoMode={isPhotoMode}
          />
        </Physics>
        <OrbitControls
          ref={orbitRef}
          enablePan={true}
          minDistance={4}
          maxDistance={30}
          maxPolarAngle={Math.PI / 2 - 0.05}
          makeDefault
        />
        <Environment preset="city" />
      </Canvas>

      {/* Vignette overlay */}
      <div style={{
        position: 'absolute', inset: 0, pointerEvents: 'none',
        background: 'radial-gradient(ellipse at 50% 36%, transparent 42%, rgba(3,5,12,0.55) 70%, rgba(2,4,10,0.78) 100%)',
        opacity: isPhotoMode ? 0 : 1,
        transition: 'opacity 0.4s ease',
      }} />

      {/* Header */}
      <header style={{
        position: 'absolute', top: 0, left: 0, right: 0,
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: 'calc(8px + env(safe-area-inset-top, 0px)) 18px 8px', pointerEvents: 'none',
        opacity: isPhotoMode ? 0 : 1,
        transform: isPhotoMode ? 'translateY(-8px)' : 'translateY(0)',
        transition: 'opacity 0.35s ease, transform 0.35s ease',
      }}>
        <div className="bb-logo-area" style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          gap: 'clamp(2px, 0.5vw, 5px)',
        }}>
          <img
            src="/block-build-logo.png?v=2"
            alt="Block Build"
            style={{ width: 'clamp(68px, 14vw, 112px)', height: 'auto', filter: 'drop-shadow(0 2px 12px rgba(0,0,0,0.8))' }}
          />
          <span
            className="bb-title"
            style={{
              fontFamily: "ui-rounded, 'SF Pro Rounded', -apple-system, BlinkMacSystemFont, system-ui, sans-serif",
              fontSize: 'clamp(9px, 1.9vw, 15px)',
              fontWeight: 900,
              letterSpacing: '0.11em',
              lineHeight: 1,
              userSelect: 'none',
              whiteSpace: 'nowrap',
            }}
          >BLOCK BUILD</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            className="bb-btn"
            onPointerDown={toggleMute}
            title={muted ? 'Unmute' : 'Mute'}
            style={{
              width: 32, height: 32, borderRadius: '50%',
              background: 'linear-gradient(165deg, rgba(255,255,255,0.13) 0%, rgba(255,255,255,0.06) 100%)',
              backdropFilter: 'blur(20px) saturate(180%)', WebkitBackdropFilter: 'blur(20px) saturate(180%)',
              border: '1px solid rgba(255,255,255,0.18)',
              boxShadow: '0 2px 8px rgba(0,0,0,0.40), inset 0 1px 0 rgba(255,255,255,0.16)',
              color: 'rgba(255,255,255,0.92)',
              fontSize: 14, lineHeight: 1, padding: 0, flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer', pointerEvents: 'all',
              WebkitTapHighlightColor: 'transparent', touchAction: 'manipulation',
            }}
          >{muted ? '🔇' : '🔊'}</button>
          {blocks.length > 0 && (
            <span style={{
              background: 'linear-gradient(165deg, rgba(255,255,255,0.11) 0%, rgba(255,255,255,0.05) 100%)',
              backdropFilter: 'blur(20px) saturate(180%)', WebkitBackdropFilter: 'blur(20px) saturate(180%)',
              border: '1px solid rgba(255,255,255,0.16)',
              boxShadow: '0 2px 8px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.13)',
              color: 'rgba(255,255,255,0.92)',
              fontSize: 12, fontWeight: 700,
              padding: '4px 12px', borderRadius: 20, letterSpacing: 0.3,
            }}>
              {blocks.length} block{blocks.length !== 1 ? 's' : ''}
            </span>
          )}
        </div>
      </header>

      {blocks.length === 0 && !antiGravity && !isPhotoMode && (
        <div style={{
          position: 'absolute', top: '46%', left: 0, right: 0, textAlign: 'center',
          color: 'rgba(255,255,255,0.4)', fontSize: 15, pointerEvents: 'none', letterSpacing: 0.3,
        }}>
          Tap the floor to place a block
        </div>
      )}

      {/* Unified bottom panel */}
      <div style={{
        position: 'absolute', bottom: 0, left: 0, right: 0,
        background: 'linear-gradient(175deg, rgba(18,26,58,0.82) 0%, rgba(9,12,28,0.91) 50%, rgba(5,7,17,0.96) 100%)',
        backdropFilter: 'blur(40px) saturate(200%) brightness(1.04)',
        WebkitBackdropFilter: 'blur(40px) saturate(200%) brightness(1.04)',
        borderTop: '1px solid rgba(255,255,255,0.16)',
        borderRadius: '24px 24px 0 0',
        boxShadow: [
          'inset 0 1px 0 rgba(255,255,255,0.13)',
          'inset 0 2px 16px rgba(100,140,255,0.05)',
          '0 -16px 48px rgba(0,0,0,0.52)',
          '0 -1px 24px rgba(80,120,255,0.09)',
        ].join(', '),
        padding: `14px 12px calc(16px + env(safe-area-inset-bottom, 0px))`,
        display: 'flex', flexDirection: 'column', gap: 10,
        opacity: isPhotoMode ? 0 : 1,
        transform: isPhotoMode ? 'translateY(100%)' : 'translateY(0)',
        transition: 'opacity 0.35s ease, transform 0.35s ease',
        pointerEvents: isPhotoMode ? 'none' : 'auto',
      }}>
        {/* Colour palette — nested glass layer for Vision Pro-style depth */}
        <div style={{
          background: 'linear-gradient(175deg, rgba(255,255,255,0.065) 0%, rgba(255,255,255,0.022) 100%)',
          borderRadius: 16, padding: '8px 8px',
          border: '1px solid rgba(255,255,255,0.09)',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.09)',
        }}>
        <div style={{ display: 'flex', gap: 6, justifyContent: 'center', flexWrap: 'wrap' }}>
          {PALETTE.map(c => (
            <button
              key={c}
              className={`bb-swatch${!isRandom && color === c ? ' bb-swatch-selected' : ''}`}
              onPointerDown={() => { setColor(c); setIsRandom(false) }}
              style={{
                width: 28, height: 28, borderRadius: '50%',
                background: c === 'rainbow'
                  ? 'conic-gradient(from 0deg, #ff0000, #ff8000, #ffff00, #00cc00, #0066ff, #cc00ff, #ff0000)'
                  : c === 'glitter'
                  ? 'radial-gradient(circle at 30% 35%, #fff 0%, #e0e8ff 25%, #a0b0d0 55%, #c8d8f0 80%, #fff 100%)'
                  : c === 'spaghetti'
                  ? 'repeating-linear-gradient(0deg, #E8C060 0px, #E8C060 4px, #8E1E08 4px, #8E1E08 7px)'
                  : c === '#D4AF37'
                  ? 'radial-gradient(circle at 32% 28%, #f7e87a 0%, #D4AF37 50%, #9a7810 100%)'
                  : c === '#111111'
                  ? 'radial-gradient(circle at 32% 28%, #484848 0%, #1c1c1c 55%, #040404 100%)'
                  : c,
                padding: 0, flexShrink: 0,
                border: !isRandom && color === c ? '2.5px solid #fff' : '1.5px solid rgba(255,255,255,0.18)',
                boxShadow: !isRandom && color === c
                  ? `0 0 0 3px ${swatchGlow(c)}, 0 0 16px ${swatchGlow(c)}, 0 2px 8px rgba(0,0,0,0.6)`
                  : '0 1px 3px rgba(0,0,0,0.3)',
                cursor: 'pointer', WebkitTapHighlightColor: 'transparent',
                transform: !isRandom && color === c ? undefined : 'scale(1)',
              }}
            />
          ))}
          {/* Random colour mode — each placed block picks a random palette colour */}
          <button
            className={`bb-swatch${isRandom ? ' bb-swatch-selected' : ''}`}
            onPointerDown={() => setIsRandom(r => !r)}
            style={{
              width: 28, height: 28, borderRadius: '50%',
              background: 'conic-gradient(from 0deg, #e74c3c, #FFE600, #7CFF00, #3498db, #9b59b6, #FF2DAA, #e74c3c)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 12, fontWeight: 900, lineHeight: 1,
              color: 'rgba(255,255,255,0.92)', textShadow: '0 1px 3px rgba(0,0,0,0.9)',
              padding: 0, flexShrink: 0,
              border: isRandom ? '2.5px solid #fff' : '1.5px solid rgba(255,255,255,0.25)',
              boxShadow: isRandom
                ? '0 0 0 3px rgba(255,255,255,0.55), 0 0 18px rgba(255,255,255,0.40), 0 2px 8px rgba(0,0,0,0.6)'
                : '0 1px 3px rgba(0,0,0,0.3)',
              cursor: 'pointer', WebkitTapHighlightColor: 'transparent',
              transform: isRandom ? undefined : 'scale(1)',
            }}
          >?</button>
        </div>
        </div>

        {/* Float height row — only visible in float mode */}
        {antiGravity && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              className="bb-btn"
              onPointerDown={placeHeight === 0 ? undefined : () => setPlaceHeight(h => Math.max(0, h - 1))}
              style={{
                width: 44, height: 36, flexShrink: 0,
                background: placeHeight === 0 ? 'rgba(255,255,255,0.03)' : 'linear-gradient(165deg, rgba(124,58,237,0.40) 0%, rgba(100,40,220,0.28) 100%)',
                color: placeHeight === 0 ? 'rgba(255,255,255,0.20)' : '#d8b4fe',
                border: `1px solid ${placeHeight === 0 ? 'rgba(255,255,255,0.05)' : 'rgba(124,58,237,0.52)'}`,
                borderRadius: 10, fontSize: 20, fontWeight: 700, lineHeight: 1,
                cursor: placeHeight === 0 ? 'default' : 'pointer',
                boxShadow: placeHeight === 0 ? 'none' : '0 2px 10px rgba(124,58,237,0.30), inset 0 1px 0 rgba(255,255,255,0.18)',
                WebkitTapHighlightColor: 'transparent', touchAction: 'manipulation',
              }}
            >−</button>
            <div style={{ flex: 1, textAlign: 'center', color: '#c4b0f8', fontSize: 12, fontWeight: 700, letterSpacing: 0.3 }}>
              Float height: {placeHeight}
            </div>
            <button
              className="bb-btn"
              onPointerDown={placeHeight === 20 ? undefined : () => setPlaceHeight(h => Math.min(20, h + 1))}
              style={{
                width: 44, height: 36, flexShrink: 0,
                background: placeHeight === 20 ? 'rgba(255,255,255,0.03)' : 'linear-gradient(165deg, rgba(124,58,237,0.40) 0%, rgba(100,40,220,0.28) 100%)',
                color: placeHeight === 20 ? 'rgba(255,255,255,0.20)' : '#d8b4fe',
                border: `1px solid ${placeHeight === 20 ? 'rgba(255,255,255,0.05)' : 'rgba(124,58,237,0.52)'}`,
                borderRadius: 10, fontSize: 20, fontWeight: 700, lineHeight: 1,
                cursor: placeHeight === 20 ? 'default' : 'pointer',
                boxShadow: placeHeight === 20 ? 'none' : '0 2px 10px rgba(124,58,237,0.30), inset 0 1px 0 rgba(255,255,255,0.18)',
                WebkitTapHighlightColor: 'transparent', touchAction: 'manipulation',
              }}
            >+</button>
          </div>
        )}

        {/* Action buttons */}
        <div style={{ display: 'flex', gap: 4 }}>
          <CtrlBtn emoji="↩" label="Undo"  onTap={undo}                                            disabled={!canUndo} />
          <CtrlBtn emoji="✕" label="Clear" onTap={clear}                                           disabled={!blocks.length} />
          <CtrlBtn emoji="💥" label="Knock" onTap={knockDown}                                      disabled={!blocks.length} tintBg="linear-gradient(165deg, rgba(239,68,68,0.30) 0%, rgba(220,50,50,0.16) 100%)" />
          <CtrlBtn emoji="🔮" label="Float" onTap={toggleAntiGravity} active={antiGravity}         activeColor="#7c3aed" activeGlow="rgba(124,58,237,0.65)" />
          <CtrlBtn emoji="💾" label="Save"  onTap={() => { setModal('save'); setSaveName('') }}    disabled={!blocks.length} />
          <CtrlBtn emoji="📂" label="Load"  onTap={() => setModal('load')}                         disabled={!saveNames.length} />
          <CtrlBtn emoji="🔗" label="Share" onTap={handleShare}                                    disabled={!blocks.length} />
          <CtrlBtn emoji="📷" label="Photo" onTap={() => setIsPhotoMode(true)} />
        </div>
      </div>

      {/* Save modal */}
      {modal === 'save' && (
        <Modal onClose={() => setModal(null)} bottom={`calc(${panelH + 12}px + env(safe-area-inset-bottom, 0px))`}>
          <ModalTitle>Name this wall</ModalTitle>
          <input
            autoFocus value={saveName}
            onChange={e => setSaveName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSave()}
            placeholder="e.g. My Castle"
            className="bb-input"
            style={{
              width: '100%', padding: '10px 14px', borderRadius: 10,
              fontSize: 16, marginBottom: 12, boxSizing: 'border-box', fontFamily: FONT,
            }}
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <Btn bg="#27ae60" onTap={handleSave} disabled={!saveName.trim()}>Save</Btn>
            <Btn bg="#555" onTap={() => setModal(null)}>Cancel</Btn>
          </div>
        </Modal>
      )}

      {/* Load modal */}
      {modal === 'load' && (
        <Modal onClose={() => setModal(null)} bottom={`calc(${panelH + 12}px + env(safe-area-inset-bottom, 0px))`}>
          <ModalTitle>Saved walls</ModalTitle>
          <div style={{ maxHeight: 220, overflowY: 'auto', marginBottom: 10 }}>
            {saveNames.map(name => (
              <div key={name} style={{ display: 'flex', gap: 6, marginBottom: 7 }}>
                <button
                  className="bb-btn"
                  onPointerDown={() => handleLoad(name)}
                  style={{
                    flex: 1, padding: '10px 12px',
                    background: 'linear-gradient(165deg, rgba(41,128,185,0.38) 0%, rgba(41,128,185,0.20) 100%)',
                    color: '#fff',
                    border: '1px solid rgba(41,128,185,0.50)', borderRadius: 10,
                    fontSize: 14, fontWeight: 600, fontFamily: FONT,
                    cursor: 'pointer', textAlign: 'left',
                    boxShadow: '0 2px 10px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.15)',
                    WebkitTapHighlightColor: 'transparent',
                  }}
                >
                  {name}
                  <span style={{ opacity: 0.6, fontSize: 11, marginLeft: 6 }}>
                    {saves[name].length} block{saves[name].length !== 1 ? 's' : ''}
                  </span>
                </button>
                <button
                  className="bb-btn"
                  onPointerDown={() => handleDelete(name)}
                  style={{
                    padding: '10px 13px',
                    background: 'linear-gradient(165deg, rgba(192,57,43,0.38) 0%, rgba(192,57,43,0.20) 100%)',
                    color: '#fff',
                    border: '1px solid rgba(192,57,43,0.50)', borderRadius: 10,
                    cursor: 'pointer', fontFamily: FONT,
                    boxShadow: '0 2px 10px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.15)',
                    WebkitTapHighlightColor: 'transparent',
                  }}
                >✕</button>
              </div>
            ))}
          </div>
          <Btn bg="#555" onTap={() => setModal(null)}>Close</Btn>
        </Modal>
      )}

      {/* Photo mode overlay — screenshot + exit buttons */}
      {isPhotoMode && (
        <div style={{
          position: 'absolute',
          top: 'calc(14px + env(safe-area-inset-top, 0px))',
          right: 14,
          display: 'flex', gap: 8, zIndex: 20,
          animation: 'bbFadeIn 0.3s ease',
        }}>
          <button
            className="bb-btn"
            onPointerDown={handleScreenshot}
            style={{
              width: 48, height: 48, borderRadius: 14,
              background: 'rgba(255,255,255,0.13)',
              backdropFilter: 'blur(14px) saturate(160%)', WebkitBackdropFilter: 'blur(14px) saturate(160%)',
              border: '1px solid rgba(255,255,255,0.24)',
              boxShadow: '0 4px 20px rgba(0,0,0,0.55)',
              fontSize: 22, cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              WebkitTapHighlightColor: 'transparent', touchAction: 'manipulation',
            }}
          >📸</button>
          <button
            className="bb-btn"
            onPointerDown={() => setIsPhotoMode(false)}
            style={{
              width: 48, height: 48, borderRadius: 14,
              background: 'rgba(255,255,255,0.13)',
              backdropFilter: 'blur(14px) saturate(160%)', WebkitBackdropFilter: 'blur(14px) saturate(160%)',
              border: '1px solid rgba(255,255,255,0.24)',
              boxShadow: '0 4px 20px rgba(0,0,0,0.55)',
              color: '#fff', fontSize: 18, fontWeight: 700, cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              WebkitTapHighlightColor: 'transparent', touchAction: 'manipulation',
              fontFamily: FONT,
            }}
          >✕</button>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div style={{
          position: 'absolute', bottom: `calc(${panelH + 14}px + env(safe-area-inset-bottom, 0px))`, left: '50%', transform: 'translateX(-50%)',
          background: 'linear-gradient(165deg, rgba(20,28,58,0.95) 0%, rgba(8,12,26,0.98) 100%)',
          color: 'rgba(255,255,255,0.94)', padding: '10px 22px',
          borderRadius: 22, fontSize: 14, fontWeight: 600, pointerEvents: 'none',
          backdropFilter: 'blur(28px) saturate(200%)', WebkitBackdropFilter: 'blur(28px) saturate(200%)',
          border: '1px solid rgba(255,255,255,0.17)',
          boxShadow: '0 4px 28px rgba(0,0,0,0.60), inset 0 1px 0 rgba(255,255,255,0.14)',
          whiteSpace: 'nowrap',
        }}>
          {toast}
        </div>
      )}
    </div>
  )
}

function Modal({ children, onClose, bottom }) {
  return (
    <>
      <div
        onPointerDown={onClose}
        style={{
          position: 'absolute', inset: 0,
          background: 'rgba(0,0,0,0.55)',
          backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
        }}
      />
      <div style={{
        position: 'absolute', bottom: bottom || 'calc(162px + env(safe-area-inset-bottom, 0px))', left: '50%', transform: 'translateX(-50%)',
        width: 'calc(100% - 32px)', maxWidth: 360,
        background: 'linear-gradient(165deg, rgba(20,28,62,0.97) 0%, rgba(9,12,28,0.99) 100%)',
        borderRadius: 20, padding: 18,
        border: '1px solid rgba(255,255,255,0.15)',
        backdropFilter: 'blur(40px) saturate(200%)', WebkitBackdropFilter: 'blur(40px) saturate(200%)',
        boxShadow: '0 8px 48px rgba(0,0,0,0.72), inset 0 1px 0 rgba(255,255,255,0.14), 0 0 0 1px rgba(100,130,255,0.07)',
      }}>
        {children}
      </div>
    </>
  )
}

function ModalTitle({ children }) {
  return (
    <div style={{ color: '#fff', fontWeight: 700, fontSize: 16, marginBottom: 12 }}>
      {children}
    </div>
  )
}

function Btn({ bg, onTap, disabled, children }) {
  return (
    <button
      className="bb-btn"
      onPointerDown={disabled ? undefined : () => { playTap(); onTap() }}
      style={{
        flex: 1, height: 40,
        background: disabled ? 'rgba(30,30,46,0.6)' : bg,
        color: disabled ? '#555' : '#fff',
        border: disabled ? '1px solid rgba(255,255,255,0.06)' : '1px solid rgba(255,255,255,0.20)',
        borderRadius: 10,
        fontSize: 14, fontWeight: 700, fontFamily: FONT,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        boxShadow: disabled ? 'none' : '0 2px 10px rgba(0,0,0,0.40), inset 0 1px 0 rgba(255,255,255,0.20)',
        WebkitTapHighlightColor: 'transparent',
        touchAction: 'manipulation', userSelect: 'none',
      }}
    >
      {children}
    </button>
  )
}

function CtrlBtn({ emoji, label, onTap, disabled, active, activeColor, activeGlow, tintBg }) {
  const bg = disabled
    ? 'rgba(255,255,255,0.03)'
    : active && activeColor
    ? `linear-gradient(165deg, ${activeColor}cc 0%, ${activeColor} 100%)`
    : tintBg || 'linear-gradient(165deg, rgba(255,255,255,0.10) 0%, rgba(255,255,255,0.04) 100%)'
  const bdr = disabled
    ? '1px solid rgba(255,255,255,0.05)'
    : active && activeColor
    ? `1px solid ${activeColor}bb`
    : '1px solid rgba(255,255,255,0.13)'
  const shadow = disabled
    ? 'none'
    : active && activeGlow
    ? `0 0 28px ${activeGlow}, 0 0 10px ${activeGlow}88, inset 0 1px 0 rgba(255,255,255,0.30), 0 2px 8px rgba(0,0,0,0.42)`
    : `0 2px 8px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.13), inset 0 -1px 0 rgba(0,0,0,0.10)`
  return (
    <button
      className={`bb-btn${active ? ' bb-active-glow' : ''}`}
      onPointerDown={disabled ? undefined : () => { playTap(); onTap() }}
      style={{
        flex: 1, height: 44, minWidth: 0, padding: 0,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2,
        background: bg,
        color: disabled ? 'rgba(255,255,255,0.22)' : '#fff',
        border: bdr,
        borderRadius: 12,
        cursor: disabled ? 'default' : 'pointer',
        boxShadow: shadow,
        WebkitTapHighlightColor: 'transparent',
        touchAction: 'manipulation', userSelect: 'none',
      }}
    >
      <span style={{ fontSize: 15, lineHeight: 1 }}>{emoji}</span>
      <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: 0.2, lineHeight: 1, fontFamily: FONT }}>{label}</span>
    </button>
  )
}
