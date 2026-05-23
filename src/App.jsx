import { useState, useRef, useCallback } from 'react'
import { Canvas } from '@react-three/fiber'
import { OrbitControls, Environment } from '@react-three/drei'
import { Physics } from '@react-three/rapier'
import Scene from './Scene'

const BLOCK_SIZE = 1
const BLOCK_COLORS = [
  '#e74c3c', '#e67e22', '#f1c40f', '#2ecc71',
  '#3498db', '#9b59b6', '#1abc9c', '#e91e63',
]

export default function App() {
  const [blocks, setBlocks] = useState([])
  const [knockKey, setKnockKey] = useState(0)
  const blockCountRef = useRef(0)

  const addBlock = useCallback(() => {
    const index = blockCountRef.current
    blockCountRef.current += 1
    setBlocks(prev => [
      ...prev,
      {
        id: index,
        position: [0, BLOCK_SIZE * index + BLOCK_SIZE / 2 + 0.01, 0],
        color: BLOCK_COLORS[index % BLOCK_COLORS.length],
      },
    ])
  }, [])

  const knockDown = useCallback(() => {
    setKnockKey(k => k + 1)
  }, [])

  const reset = useCallback(() => {
    setBlocks([])
    blockCountRef.current = 0
    setKnockKey(k => k + 1)
  }, [])

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <Canvas
        shadows
        camera={{ position: [6, 6, 10], fov: 50, near: 0.1, far: 200 }}
        gl={{ antialias: true, powerPreference: 'high-performance' }}
        style={{ background: 'linear-gradient(to bottom, #1a1a2e 0%, #16213e 60%, #0f3460 100%)' }}
      >
        <ambientLight intensity={0.6} />
        <directionalLight
          position={[8, 12, 8]}
          intensity={1.2}
          castShadow
          shadow-mapSize={[1024, 1024]}
          shadow-camera-near={0.1}
          shadow-camera-far={50}
          shadow-camera-left={-10}
          shadow-camera-right={10}
          shadow-camera-top={10}
          shadow-camera-bottom={-10}
        />
        <Physics gravity={[0, -20, 0]}>
          <Scene blocks={blocks} knockKey={knockKey} />
        </Physics>
        <OrbitControls
          enablePan={false}
          minDistance={4}
          maxDistance={25}
          maxPolarAngle={Math.PI / 2 - 0.05}
          touches={{ ONE: 1, TWO: 2 }}
          makeDefault
        />
        <Environment preset="city" />
      </Canvas>

      <UI
        blockCount={blocks.length}
        onAdd={addBlock}
        onKnock={knockDown}
        onReset={reset}
      />
    </div>
  )
}

function UI({ blockCount, onAdd, onKnock, onReset }) {
  return (
    <>
      {/* Title */}
      <div style={{
        position: 'absolute',
        top: 16,
        left: 0,
        right: 0,
        textAlign: 'center',
        color: '#fff',
        fontFamily: "'Segoe UI', system-ui, sans-serif",
        pointerEvents: 'none',
      }}>
        <div style={{ fontSize: 26, fontWeight: 800, letterSpacing: 2, textShadow: '0 2px 8px rgba(0,0,0,0.5)' }}>
          BLOCK BUILD
        </div>
        {blockCount > 0 && (
          <div style={{ fontSize: 14, opacity: 0.7, marginTop: 2 }}>
            {blockCount} block{blockCount !== 1 ? 's' : ''}
          </div>
        )}
      </div>

      {/* Bottom buttons */}
      <div style={{
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '0 24px 40px',
        gap: 12,
      }}>
        <button
          onPointerDown={onAdd}
          style={buttonStyle('#3498db', '#2980b9', 64, 22)}
        >
          + Add Block
        </button>
        <div style={{ display: 'flex', gap: 12, width: '100%', maxWidth: 320 }}>
          <button
            onPointerDown={onKnock}
            disabled={blockCount === 0}
            style={buttonStyle('#e74c3c', '#c0392b', 48, 16, blockCount === 0, true)}
          >
            Knock Down
          </button>
          <button
            onPointerDown={onReset}
            disabled={blockCount === 0}
            style={buttonStyle('#7f8c8d', '#636e72', 48, 16, blockCount === 0, true)}
          >
            Reset
          </button>
        </div>
      </div>
    </>
  )
}

function buttonStyle(bg, activeBg, height, fontSize, disabled = false, half = false) {
  return {
    height,
    width: half ? undefined : '100%',
    flex: half ? 1 : undefined,
    maxWidth: half ? undefined : 320,
    background: disabled ? '#444' : bg,
    color: disabled ? '#888' : '#fff',
    border: 'none',
    borderRadius: height / 2,
    fontSize,
    fontWeight: 700,
    fontFamily: "'Segoe UI', system-ui, sans-serif",
    letterSpacing: 0.5,
    cursor: disabled ? 'not-allowed' : 'pointer',
    boxShadow: disabled ? 'none' : '0 4px 16px rgba(0,0,0,0.4)',
    transition: 'transform 0.1s, opacity 0.1s',
    WebkitTapHighlightColor: 'transparent',
    touchAction: 'manipulation',
    userSelect: 'none',
    opacity: disabled ? 0.5 : 1,
  }
}
