import { useState, useRef, useCallback, useEffect } from 'react'
import { Canvas } from '@react-three/fiber'
import { OrbitControls, Environment } from '@react-three/drei'
import { Physics } from '@react-three/rapier'
import Scene from './Scene'

const PALETTE = [
  '#e74c3c', '#e67e22', '#f1c40f', '#2ecc71',
  '#3498db', '#9b59b6', '#1abc9c', '#e91e63',
  '#ecf0f1', '#95a5a6', '#34495e', 'rainbow',
  '#D4AF37', '#C0C0C0', '#FF2A2A', '#FFB6D9',
  '#8B5A2B', 'glitter',
]
const LS_KEY = 'blockbuild_saves'
const LS_AUTOSAVE = 'blockbuild_autosave'
const FONT = "system-ui, -apple-system, sans-serif"
const MAX_HISTORY = 30

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
  // Palette clears the button rows below it; extra height when height controls visible
  const paletteBottom = antiGravity ? 204 : 156

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative', fontFamily: FONT, touchAction: 'none' }}>
      <Canvas
        shadows
        camera={{ position: [8, 8, 12], fov: 50, near: 0.1, far: 200 }}
        gl={{ antialias: true, powerPreference: 'high-performance' }}
        style={{ background: 'linear-gradient(to bottom, #1a1a2e 0%, #16213e 60%, #0f3460 100%)', touchAction: 'none' }}
        onCreated={({ gl }) => { gl.domElement.style.touchAction = 'none' }}
      >
        <ambientLight intensity={0.6} />
        <directionalLight
          position={[8, 12, 8]} intensity={1.2} castShadow
          shadow-mapSize={[1024, 1024]}
          shadow-camera-near={0.1} shadow-camera-far={60}
          shadow-camera-left={-14} shadow-camera-right={14}
          shadow-camera-top={14} shadow-camera-bottom={-14}
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

      {/* Header */}
      <header style={{
        position: 'absolute', top: 0, left: 0, right: 0,
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: 'calc(8px + env(safe-area-inset-top, 0px)) 18px 8px', pointerEvents: 'none',
      }}>
        <img
          src="/logo.png"
          alt="Block Build"
          style={{ width: 'clamp(80px, 16vw, 140px)', height: 'auto', filter: 'drop-shadow(0 2px 8px rgba(0,0,0,0.7))' }}
        />
        {blocks.length > 0 && (
          <span style={{ color: 'rgba(255,255,255,0.65)', fontSize: 13 }}>
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

      {/* Colour palette */}
      <div style={{ position: 'absolute', bottom: `calc(${paletteBottom}px + env(safe-area-inset-bottom, 0px))`, left: 0, right: 0, display: 'flex', justifyContent: 'center', padding: '0 10px', pointerEvents: 'none' }}>
        <div style={{
          display: 'flex', gap: 7, padding: '8px 12px',
          background: 'rgba(0,0,0,0.55)', borderRadius: 28,
          backdropFilter: 'blur(10px)',
          flexWrap: 'wrap', justifyContent: 'center', maxWidth: 360,
          pointerEvents: 'auto',
        }}>
          {PALETTE.map(c => (
            <button
              key={c}
              onPointerDown={() => setColor(c)}
              style={{
                width: 30, height: 30, borderRadius: '50%',
                background: c === 'rainbow' ? 'conic-gradient(from 0deg, #ff0000, #ff8000, #ffff00, #00cc00, #0066ff, #cc00ff, #ff0000)' : c === 'glitter' ? 'radial-gradient(circle at 30% 35%, #fff 0%, #e0e8ff 25%, #a0b0d0 55%, #c8d8f0 80%, #fff 100%)' : c,
                padding: 0, flexShrink: 0,
                border: color === c ? '3px solid #fff' : '2px solid rgba(255,255,255,0.2)',
                boxShadow: color === c
                  ? '0 0 0 2px rgba(255,255,255,0.35), 0 3px 8px rgba(0,0,0,0.5)'
                  : '0 2px 4px rgba(0,0,0,0.3)',
                cursor: 'pointer', WebkitTapHighlightColor: 'transparent',
              }}
            />
          ))}
        </div>
      </div>

      {/* Bottom controls */}
      <div style={{
        position: 'absolute', bottom: 0, left: 0, right: 0,
        padding: `0 16px calc(34px + env(safe-area-inset-bottom, 0px))`, display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center',
        pointerEvents: 'none',
      }}>
        {/* Row 1: action buttons */}
        <div style={{ display: 'flex', gap: 6, width: '100%', maxWidth: 360, pointerEvents: 'auto' }}>
          <Btn bg="#546e7a" onTap={undo} disabled={!canUndo}>↩ Undo</Btn>
          <Btn bg="#7f8c8d" onTap={clear} disabled={!blocks.length}>Clear</Btn>
          <Btn bg="#27ae60" onTap={() => { setModal('save'); setSaveName('') }} disabled={!blocks.length}>Save</Btn>
          <Btn bg="#2980b9" onTap={() => setModal('load')} disabled={!saveNames.length}>Load</Btn>
          <Btn bg="#16a085" onTap={handleShare} disabled={!blocks.length}>Share</Btn>
        </div>

        {/* Row 2: height controls — only in float mode */}
        {antiGravity && (
          <div style={{ display: 'flex', gap: 8, width: '100%', maxWidth: 360, alignItems: 'center', pointerEvents: 'auto' }}>
            <HeightBtn onTap={() => setPlaceHeight(h => Math.max(0, h - 1))} disabled={placeHeight === 0}>−</HeightBtn>
            <div style={{ flex: 1, textAlign: 'center', color: '#e8daef', fontSize: 13, fontWeight: 700, letterSpacing: 0.5 }}>
              Float height: {placeHeight}
            </div>
            <HeightBtn onTap={() => setPlaceHeight(h => Math.min(20, h + 1))}>+</HeightBtn>
          </div>
        )}

        {/* Row 3: mode toggles */}
        <div style={{ display: 'flex', gap: 8, width: '100%', maxWidth: 360, pointerEvents: 'auto' }}>
          <Btn bg="#e74c3c" onTap={knockDown} disabled={!blocks.length} tall>
            💥 Knock Over
          </Btn>
          <ModeBtn active={antiGravity} onTap={toggleAntiGravity} color="#8e44ad" glow="rgba(142,68,173,0.5)">
            🔮 Float Mode
          </ModeBtn>
        </div>
      </div>

      {/* Save modal */}
      {modal === 'save' && (
        <Modal onClose={() => setModal(null)}>
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
        <Modal onClose={() => setModal(null)}>
          <ModalTitle>Saved walls</ModalTitle>
          <div style={{ maxHeight: 220, overflowY: 'auto', marginBottom: 10 }}>
            {saveNames.map(name => (
              <div key={name} style={{ display: 'flex', gap: 6, marginBottom: 7 }}>
                <button
                  onPointerDown={() => handleLoad(name)}
                  style={{
                    flex: 1, padding: '10px 12px', background: '#2980b9', color: '#fff',
                    border: 'none', borderRadius: 10, fontSize: 14, fontWeight: 600,
                    fontFamily: FONT, cursor: 'pointer', textAlign: 'left',
                    WebkitTapHighlightColor: 'transparent',
                  }}
                >
                  {name}
                  <span style={{ opacity: 0.6, fontSize: 11, marginLeft: 6 }}>
                    {saves[name].length} block{saves[name].length !== 1 ? 's' : ''}
                  </span>
                </button>
                <button
                  onPointerDown={() => handleDelete(name)}
                  style={{
                    padding: '10px 13px', background: '#c0392b', color: '#fff',
                    border: 'none', borderRadius: 10, cursor: 'pointer',
                    fontFamily: FONT, WebkitTapHighlightColor: 'transparent',
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
          position: 'absolute', bottom: `calc(${paletteBottom + 70}px + env(safe-area-inset-bottom, 0px))`, left: '50%', transform: 'translateX(-50%)',
          background: 'rgba(0,0,0,0.82)', color: '#fff', padding: '10px 20px',
          borderRadius: 20, fontSize: 14, fontWeight: 600, pointerEvents: 'none',
          backdropFilter: 'blur(8px)', whiteSpace: 'nowrap',
        }}>
          {toast}
        </div>
      )}
    </div>
  )
}

function Modal({ children, onClose }) {
  return (
    <>
      <div
        onPointerDown={onClose}
        style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.45)' }}
      />
      <div style={{
        position: 'absolute', bottom: 'calc(165px + env(safe-area-inset-bottom, 0px))', left: '50%', transform: 'translateX(-50%)',
        width: 'calc(100% - 32px)', maxWidth: 360,
        background: 'rgba(12,12,30,0.97)', borderRadius: 18, padding: 18,
        border: '1px solid rgba(255,255,255,0.1)', backdropFilter: 'blur(16px)',
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

function Btn({ bg, onTap, disabled, children, tall, glow }) {
  return (
    <button
      onPointerDown={disabled ? undefined : onTap}
      style={{
        flex: 1,
        height: tall ? 54 : 44,
        background: disabled ? '#1e1e2e' : bg,
        color: disabled ? '#444' : '#fff',
        border: 'none',
        borderRadius: tall ? 27 : 22,
        fontSize: tall ? 18 : 14,
        fontWeight: 700,
        fontFamily: FONT,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        boxShadow: glow
          ? `0 0 14px ${bg}, 0 4px 14px rgba(0,0,0,0.35)`
          : disabled ? 'none' : '0 4px 14px rgba(0,0,0,0.35)',
        WebkitTapHighlightColor: 'transparent',
        touchAction: 'manipulation',
        userSelect: 'none',
      }}
    >
      {children}
    </button>
  )
}

function ModeBtn({ active, onTap, color, glow, children }) {
  return (
    <button
      onPointerDown={onTap}
      style={{
        flex: 1,
        height: 52,
        background: active ? color : 'rgba(255,255,255,0.07)',
        color: active ? '#fff' : color,
        border: active ? 'none' : `1.5px solid ${color}55`,
        borderRadius: 26,
        fontSize: 14,
        fontWeight: 700,
        fontFamily: FONT,
        cursor: 'pointer',
        boxShadow: active ? `0 4px 20px ${glow}` : 'none',
        WebkitTapHighlightColor: 'transparent',
        touchAction: 'manipulation',
        userSelect: 'none',
      }}
    >
      {children}{active ? ' ON' : ''}
    </button>
  )
}

function HeightBtn({ onTap, disabled, children }) {
  return (
    <button
      onPointerDown={disabled ? undefined : onTap}
      style={{
        width: 44, height: 40, flexShrink: 0,
        background: disabled ? '#1e1e2e' : '#6c3483',
        color: disabled ? '#444' : '#fff',
        border: 'none', borderRadius: 20,
        fontSize: 22, fontWeight: 700, lineHeight: 1,
        fontFamily: FONT, cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        WebkitTapHighlightColor: 'transparent',
        touchAction: 'manipulation',
      }}
    >
      {children}
    </button>
  )
}
