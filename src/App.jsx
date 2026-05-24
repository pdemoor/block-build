import { useState, useRef, useCallback, useEffect } from 'react'
import { Canvas } from '@react-three/fiber'
import { OrbitControls, Environment } from '@react-three/drei'
import { Physics } from '@react-three/rapier'
import Scene from './Scene'

const PALETTE = [
  '#e74c3c', '#e67e22', '#FFE600', '#2ecc71',   // 0-3  red, orange, neon-yellow, green
  '#3498db', '#9b59b6', '#1abc9c', '#FF2DAA',   // 4-7  blue, purple, aqua, arcade-pink
  '#ecf0f1', '#95a5a6', '#34495e', 'rainbow',   // 8-11 white, silver, slate, rainbow
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
  const [knockKey, setKnockKey] = useState(0)
  const [physicsKey, setPhysicsKey] = useState(0)
  const [saves, setSaves] = useState(getSaves)
  const [modal, setModal] = useState(null) // 'save' | 'load' | null
  const [saveName, setSaveName] = useState('')
  const [canUndo, setCanUndo] = useState(false)
  const [antiGravity, setAntiGravity] = useState(false)
  const [placeHeight, setPlaceHeight] = useState(0)
  const [toast, setToast] = useState(null)

  // Refs so callbacks always see current values
  const colorRef = useRef(color)
  colorRef.current = color
  const blocksRef = useRef(blocks)
  blocksRef.current = blocks
  const antiGravityRef = useRef(antiGravity)
  antiGravityRef.current = antiGravity
  const placeHeightRef = useRef(placeHeight)
  placeHeightRef.current = placeHeight
  const historyRef = useRef([])
  const toastTimer = useRef(null)

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
    pushHistory(blocksRef.current, 'place')
    const isAG = antiGravityRef.current
    const height = placeHeightRef.current
    const col = colorRef.current
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

  const handleSave = useCallback(() => {
    const name = saveName.trim()
    if (!name) return
    const data = blocks.map(({ gridX, gridZ, stackLevel, color: c, isFixed }) =>
      ({ gridX, gridZ, stackLevel, color: c, isFixed: !!isFixed }))
    const updated = { ...saves, [name]: data }
    setSaves(updated)
    localStorage.setItem(LS_KEY, JSON.stringify(updated))
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
      if (v) setPlaceHeight(0)
      return !v
    })
  }, [])

  const saveNames = Object.keys(saves)
  // Panel height (px, excluding safe-area) for positioning toast and modals above panel
  const panelH = antiGravity ? 188 : 142

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative', fontFamily: FONT, touchAction: 'none' }}>
      <style>{`
        .bb-btn { transition: transform 0.18s cubic-bezier(0.34,1.56,0.64,1); }
        .bb-btn:active { transform: scale(0.88) !important; transition: transform 0s !important; }
        .bb-swatch { transition: transform 0.16s cubic-bezier(0.34,1.56,0.64,1); }
        .bb-swatch:active { transform: scale(0.80) !important; transition: transform 0s !important; }
        @keyframes bbSwatchPulse {
          0%, 100% { transform: scale(1.15); }
          50%       { transform: scale(1.22); }
        }
        .bb-swatch-selected { animation: bbSwatchPulse 1.9s ease-in-out infinite; }
        .bb-swatch-selected:active { animation: none; transform: scale(0.80) !important; transition: transform 0s !important; }
      `}</style>

      <Canvas
        shadows="soft"
        camera={{ position: [8, 8, 12], fov: 50, near: 0.1, far: 200 }}
        gl={{ antialias: true, powerPreference: 'high-performance' }}
        style={{ background: 'linear-gradient(180deg, #020610 0%, #050c1c 28%, #071228 58%, #050c1c 84%, #020407 100%)', touchAction: 'none' }}
        onCreated={({ gl }) => { gl.domElement.style.touchAction = 'none' }}
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
        <Physics key={physicsKey} gravity={[0, -20, 0]}>
          <Scene
            blocks={blocks}
            knockKey={knockKey}
            onPlace={placeBlock}
            orbitRef={orbitRef}
            antiGravity={antiGravity}
            placeHeight={placeHeight}
            color={color}
            onFreeBlock={freeBlock}
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
      }} />

      {/* Header */}
      <header style={{
        position: 'absolute', top: 0, left: 0, right: 0,
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: 'calc(8px + env(safe-area-inset-top, 0px)) 18px 8px', pointerEvents: 'none',
      }}>
        <img
          src="/logo.png"
          alt="Block Build"
          style={{ width: 'clamp(56px, 11vw, 96px)', height: 'auto', filter: 'drop-shadow(0 2px 8px rgba(0,0,0,0.7))' }}
        />
        {blocks.length > 0 && (
          <span style={{
            background: 'rgba(255,255,255,0.08)',
            backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
            border: '1px solid rgba(255,255,255,0.14)',
            color: 'rgba(255,255,255,0.88)',
            fontSize: 12, fontWeight: 700,
            padding: '4px 11px', borderRadius: 20, letterSpacing: 0.3,
          }}>
            {blocks.length} block{blocks.length !== 1 ? 's' : ''}
          </span>
        )}
      </header>

      {blocks.length === 0 && !antiGravity && (
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
        background: 'linear-gradient(to bottom, rgba(12,14,30,0.78) 0%, rgba(6,8,20,0.92) 100%)',
        backdropFilter: 'blur(24px) saturate(180%)', WebkitBackdropFilter: 'blur(24px) saturate(180%)',
        borderTop: '1px solid rgba(255,255,255,0.10)',
        borderRadius: '20px 20px 0 0',
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06), 0 -8px 32px rgba(0,0,0,0.35)',
        padding: `12px 10px calc(14px + env(safe-area-inset-bottom, 0px))`,
        display: 'flex', flexDirection: 'column', gap: 10,
      }}>
        {/* Colour palette */}
        <div style={{ display: 'flex', gap: 6, justifyContent: 'center', flexWrap: 'wrap' }}>
          {PALETTE.map(c => (
            <button
              key={c}
              className={`bb-swatch${color === c ? ' bb-swatch-selected' : ''}`}
              onPointerDown={() => setColor(c)}
              style={{
                width: 28, height: 28, borderRadius: '50%',
                background: c === 'rainbow'
                  ? 'conic-gradient(from 0deg, #ff0000, #ff8000, #ffff00, #00cc00, #0066ff, #cc00ff, #ff0000)'
                  : c === 'glitter'
                  ? 'radial-gradient(circle at 30% 35%, #fff 0%, #e0e8ff 25%, #a0b0d0 55%, #c8d8f0 80%, #fff 100%)'
                  : c === '#D4AF37'
                  ? 'radial-gradient(circle at 32% 28%, #f7e87a 0%, #D4AF37 50%, #9a7810 100%)'
                  : c === '#111111'
                  ? 'radial-gradient(circle at 32% 28%, #484848 0%, #1c1c1c 55%, #040404 100%)'
                  : c,
                padding: 0, flexShrink: 0,
                border: color === c ? '2.5px solid #fff' : '1.5px solid rgba(255,255,255,0.18)',
                boxShadow: color === c
                  ? `0 0 0 3px ${swatchGlow(c)}, 0 0 16px ${swatchGlow(c)}, 0 2px 8px rgba(0,0,0,0.6)`
                  : '0 1px 3px rgba(0,0,0,0.3)',
                cursor: 'pointer', WebkitTapHighlightColor: 'transparent',
                transform: color === c ? undefined : 'scale(1)',
              }}
            />
          ))}
        </div>

        {/* Float height row — only visible in float mode */}
        {antiGravity && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              className="bb-btn"
              onPointerDown={placeHeight === 0 ? undefined : () => setPlaceHeight(h => Math.max(0, h - 1))}
              style={{
                width: 44, height: 36, flexShrink: 0,
                background: placeHeight === 0 ? 'rgba(255,255,255,0.04)' : 'rgba(124,58,237,0.28)',
                color: placeHeight === 0 ? 'rgba(255,255,255,0.2)' : '#d8b4fe',
                border: `1px solid ${placeHeight === 0 ? 'rgba(255,255,255,0.06)' : 'rgba(124,58,237,0.45)'}`,
                borderRadius: 8, fontSize: 20, fontWeight: 700, lineHeight: 1,
                cursor: placeHeight === 0 ? 'default' : 'pointer',
                boxShadow: placeHeight === 0 ? 'none' : '0 2px 8px rgba(124,58,237,0.25), inset 0 1px 0 rgba(255,255,255,0.1)',
                WebkitTapHighlightColor: 'transparent', touchAction: 'manipulation',
              }}
            >−</button>
            <div style={{ flex: 1, textAlign: 'center', color: '#d8b4fe', fontSize: 12, fontWeight: 700, letterSpacing: 0.3 }}>
              Float height: {placeHeight}
            </div>
            <button
              className="bb-btn"
              onPointerDown={placeHeight === 20 ? undefined : () => setPlaceHeight(h => Math.min(20, h + 1))}
              style={{
                width: 44, height: 36, flexShrink: 0,
                background: placeHeight === 20 ? 'rgba(255,255,255,0.04)' : 'rgba(124,58,237,0.28)',
                color: placeHeight === 20 ? 'rgba(255,255,255,0.2)' : '#d8b4fe',
                border: `1px solid ${placeHeight === 20 ? 'rgba(255,255,255,0.06)' : 'rgba(124,58,237,0.45)'}`,
                borderRadius: 8, fontSize: 20, fontWeight: 700, lineHeight: 1,
                cursor: placeHeight === 20 ? 'default' : 'pointer',
                boxShadow: placeHeight === 20 ? 'none' : '0 2px 8px rgba(124,58,237,0.25), inset 0 1px 0 rgba(255,255,255,0.1)',
                WebkitTapHighlightColor: 'transparent', touchAction: 'manipulation',
              }}
            >+</button>
          </div>
        )}

        {/* Action buttons */}
        <div style={{ display: 'flex', gap: 4 }}>
          <CtrlBtn emoji="↩" label="Undo"  onTap={undo}                                            disabled={!canUndo} />
          <CtrlBtn emoji="✕" label="Clear" onTap={clear}                                           disabled={!blocks.length} />
          <CtrlBtn emoji="💥" label="Knock" onTap={knockDown}                                      disabled={!blocks.length} tintBg="rgba(239,68,68,0.22)" />
          <CtrlBtn emoji="🔮" label="Float" onTap={toggleAntiGravity} active={antiGravity}         activeColor="#7c3aed" activeGlow="rgba(124,58,237,0.65)" />
          <CtrlBtn emoji="💾" label="Save"  onTap={() => { setModal('save'); setSaveName('') }}    disabled={!blocks.length} />
          <CtrlBtn emoji="📂" label="Load"  onTap={() => setModal('load')}                         disabled={!saveNames.length} />
          <CtrlBtn emoji="🔗" label="Share" onTap={handleShare}                                    disabled={!blocks.length} />
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
            style={{
              width: '100%', padding: '10px 14px', borderRadius: 10,
              border: 'none', fontSize: 16, background: '#fff',
              marginBottom: 12, boxSizing: 'border-box', fontFamily: FONT,
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
                    background: 'rgba(41,128,185,0.35)', color: '#fff',
                    border: '1px solid rgba(41,128,185,0.55)', borderRadius: 10,
                    fontSize: 14, fontWeight: 600, fontFamily: FONT,
                    cursor: 'pointer', textAlign: 'left',
                    boxShadow: '0 2px 8px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.1)',
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
                    background: 'rgba(192,57,43,0.35)', color: '#fff',
                    border: '1px solid rgba(192,57,43,0.55)', borderRadius: 10,
                    cursor: 'pointer', fontFamily: FONT,
                    boxShadow: '0 2px 8px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.1)',
                    WebkitTapHighlightColor: 'transparent',
                  }}
                >✕</button>
              </div>
            ))}
          </div>
          <Btn bg="#555" onTap={() => setModal(null)}>Close</Btn>
        </Modal>
      )}

      {/* Toast */}
      {toast && (
        <div style={{
          position: 'absolute', bottom: `calc(${panelH + 14}px + env(safe-area-inset-bottom, 0px))`, left: '50%', transform: 'translateX(-50%)',
          background: 'rgba(8,10,24,0.88)', color: '#fff', padding: '10px 20px',
          borderRadius: 20, fontSize: 14, fontWeight: 600, pointerEvents: 'none',
          backdropFilter: 'blur(16px) saturate(160%)', WebkitBackdropFilter: 'blur(16px) saturate(160%)',
          border: '1px solid rgba(255,255,255,0.14)',
          boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
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
        style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.5)' }}
      />
      <div style={{
        position: 'absolute', bottom: bottom || 'calc(154px + env(safe-area-inset-bottom, 0px))', left: '50%', transform: 'translateX(-50%)',
        width: 'calc(100% - 32px)', maxWidth: 360,
        background: 'linear-gradient(135deg, rgba(14,16,36,0.98) 0%, rgba(8,10,24,0.99) 100%)',
        borderRadius: 18, padding: 18,
        border: '1px solid rgba(255,255,255,0.12)',
        backdropFilter: 'blur(24px) saturate(160%)', WebkitBackdropFilter: 'blur(24px) saturate(160%)',
        boxShadow: '0 8px 40px rgba(0,0,0,0.65), inset 0 1px 0 rgba(255,255,255,0.08)',
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
      onPointerDown={disabled ? undefined : onTap}
      style={{
        flex: 1, height: 40,
        background: disabled ? 'rgba(30,30,46,0.6)' : bg,
        color: disabled ? '#555' : '#fff',
        border: disabled ? '1px solid rgba(255,255,255,0.06)' : '1px solid rgba(255,255,255,0.15)',
        borderRadius: 10,
        fontSize: 14, fontWeight: 700, fontFamily: FONT,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        boxShadow: disabled ? 'none' : '0 2px 8px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.12)',
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
    ? 'rgba(255,255,255,0.04)'
    : active && activeColor
    ? activeColor
    : tintBg || 'rgba(255,255,255,0.07)'
  const shadow = disabled
    ? 'none'
    : active && activeGlow
    ? `0 0 20px ${activeGlow}, inset 0 1px 0 rgba(255,255,255,0.18), 0 2px 8px rgba(0,0,0,0.4)`
    : `0 2px 6px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.08)`
  return (
    <button
      className="bb-btn"
      onPointerDown={disabled ? undefined : onTap}
      style={{
        flex: 1, height: 44, minWidth: 0, padding: 0,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2,
        background: bg,
        color: disabled ? 'rgba(255,255,255,0.22)' : '#fff',
        border: active && activeColor ? 'none' : `1px solid ${disabled ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.11)'}`,
        borderRadius: 10,
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
