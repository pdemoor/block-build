import { useState, useRef, useCallback } from 'react'
import { Canvas } from '@react-three/fiber'
import { OrbitControls, Environment } from '@react-three/drei'
import { Physics } from '@react-three/rapier'
import Scene from './Scene'

const PALETTE = [
  '#e74c3c', '#e67e22', '#f1c40f', '#2ecc71',
  '#3498db', '#9b59b6', '#1abc9c', '#e91e63',
  '#ecf0f1', '#95a5a6', '#34495e', '#d35400',
]
const LS_KEY = 'blockbuild_saves'
const FONT = "system-ui, -apple-system, sans-serif"
const MAX_HISTORY = 20

function getSaves() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}') } catch { return {} }
}

export default function App() {
  const [blocks, setBlocks] = useState([])
  const [color, setColor] = useState('#3498db')
  const [knockKey, setKnockKey] = useState(0)
  const [physicsKey, setPhysicsKey] = useState(0)
  const [saves, setSaves] = useState(getSaves)
  const [modal, setModal] = useState(null) // 'save' | 'load' | null
  const [saveName, setSaveName] = useState('')
  const [canUndo, setCanUndo] = useState(false)
  const nextId = useRef(0)
  const orbitRef = useRef(null)
  // ref so placement callbacks always see current color without re-creating
  const colorRef = useRef(color)
  colorRef.current = color
  // mirror blocks into a ref so history callbacks can read current state
  const blocksRef = useRef(blocks)
  blocksRef.current = blocks
  // history stack: { blocks: Block[], type: 'place' | 'knock' }[]
  const historyRef = useRef([])

  function pushHistory(snap, type) {
    const h = historyRef.current
    historyRef.current = [...h.slice(-(MAX_HISTORY - 1)), { blocks: snap, type }]
    setCanUndo(true)
  }

  const placeBlock = useCallback((gridX, gridZ) => {
    pushHistory(blocksRef.current, 'place')
    setBlocks(prev => {
      const stackLevel = prev.filter(b => b.gridX === gridX && b.gridZ === gridZ).length
      return [...prev, {
        id: nextId.current++,
        gridX, gridZ, stackLevel,
        color: colorRef.current,
        position: [gridX, stackLevel + 0.5, gridZ],
      }]
    })
  }, [])

  const knockDown = useCallback(() => {
    pushHistory(blocksRef.current, 'knock')
    setKnockKey(k => k + 1)
  }, [])

  const undo = useCallback(() => {
    const h = historyRef.current
    if (!h.length) return
    const { blocks: snap, type } = h[h.length - 1]
    historyRef.current = h.slice(0, -1)
    setCanUndo(historyRef.current.length > 0)
    nextId.current = snap.length > 0
      ? snap.reduce((m, b) => Math.max(m, b.id), -1) + 1
      : 0
    setBlocks(snap)
    if (type === 'knock') setPhysicsKey(k => k + 1)
  }, [])

  const clear = useCallback(() => {
    historyRef.current = []
    setCanUndo(false)
    setBlocks([])
    nextId.current = 0
    setPhysicsKey(k => k + 1)
  }, [])

  const handleSave = useCallback(() => {
    const name = saveName.trim()
    if (!name) return
    const data = blocks.map(({ gridX, gridZ, stackLevel, color: c }) => ({ gridX, gridZ, stackLevel, color: c }))
    const updated = { ...saves, [name]: data }
    setSaves(updated)
    localStorage.setItem(LS_KEY, JSON.stringify(updated))
    setModal(null)
    setSaveName('')
  }, [saveName, blocks, saves])

  const handleLoad = useCallback((name) => {
    const data = saves[name]
    if (!data) return
    historyRef.current = []
    setCanUndo(false)
    nextId.current = data.length
    setBlocks(data.map((b, i) => ({ ...b, id: i, position: [b.gridX, b.stackLevel + 0.5, b.gridZ] })))
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

  const saveNames = Object.keys(saves)

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
          <Scene blocks={blocks} knockKey={knockKey} onPlace={placeBlock} orbitRef={orbitRef} />
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
        padding: '10px 18px', pointerEvents: 'none',
      }}>
        <img
          src="/logo.png"
          alt="Block Build"
          style={{
            height: 'clamp(32px, 6vw, 48px)',
            width: 'auto',
            imageRendering: 'pixelated',
            filter: 'drop-shadow(0 2px 6px rgba(0,0,0,0.6))',
          }}
        />
        {blocks.length > 0 && (
          <span style={{ color: 'rgba(255,255,255,0.65)', fontSize: 13 }}>
            {blocks.length} block{blocks.length !== 1 ? 's' : ''}
          </span>
        )}
      </header>

      {blocks.length === 0 && (
        <div style={{
          position: 'absolute', top: '46%', left: 0, right: 0, textAlign: 'center',
          color: 'rgba(255,255,255,0.4)', fontSize: 15, pointerEvents: 'none', letterSpacing: 0.3,
        }}>
          Tap the floor to place a block
        </div>
      )}

      {/* Colour palette — outer wrapper is pointer-transparent so orbit gestures
          starting in the margin areas still reach the canvas */}
      <div style={{ position: 'absolute', bottom: 158, left: 0, right: 0, display: 'flex', justifyContent: 'center', padding: '0 10px', pointerEvents: 'none' }}>
        <div style={{
          display: 'flex', gap: 7, padding: '8px 12px',
          background: 'rgba(0,0,0,0.55)', borderRadius: 28,
          backdropFilter: 'blur(10px)',
          flexWrap: 'wrap', justifyContent: 'center', maxWidth: 340,
          pointerEvents: 'auto',
        }}>
          {PALETTE.map(c => (
            <button
              key={c}
              onPointerDown={() => setColor(c)}
              style={{
                width: 30, height: 30, borderRadius: '50%', background: c, padding: 0, flexShrink: 0,
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

      {/* Action buttons — outer wrapper is pointer-transparent; each row opts back in */}
      <div style={{
        position: 'absolute', bottom: 0, left: 0, right: 0,
        padding: '0 16px 34px', display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center',
        pointerEvents: 'none',
      }}>
        <div style={{ display: 'flex', gap: 8, width: '100%', maxWidth: 340, pointerEvents: 'auto' }}>
          <Btn bg="#27ae60" onTap={() => { setModal('save'); setSaveName('') }} disabled={!blocks.length}>Save</Btn>
          <Btn bg="#8e44ad" onTap={() => setModal('load')} disabled={!saveNames.length}>Load</Btn>
          <Btn bg="#546e7a" onTap={undo} disabled={!canUndo}>↩ Undo</Btn>
          <Btn bg="#7f8c8d" onTap={clear} disabled={!blocks.length}>Clear</Btn>
        </div>
        <div style={{ width: '100%', maxWidth: 340, pointerEvents: 'auto' }}>
          <Btn bg="#e74c3c" onTap={knockDown} disabled={!blocks.length} tall>💥 Knock Down</Btn>
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
        position: 'absolute', bottom: 160, left: '50%', transform: 'translateX(-50%)',
        width: 'calc(100% - 32px)', maxWidth: 340,
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

function Btn({ bg, onTap, disabled, children, tall }) {
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
        boxShadow: disabled ? 'none' : '0 4px 14px rgba(0,0,0,0.35)',
        WebkitTapHighlightColor: 'transparent',
        touchAction: 'manipulation',
        userSelect: 'none',
      }}
    >
      {children}
    </button>
  )
}
