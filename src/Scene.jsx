import { useEffect, useRef, useState } from 'react'
import { useThree } from '@react-three/fiber'
import { RigidBody, CuboidCollider } from '@react-three/rapier'
import * as THREE from 'three'

const GRID = 24
const HALF = GRID / 2
const BOX_GEO = new THREE.BoxGeometry(1, 1, 1)
const EDGES_GEO = new THREE.EdgesGeometry(BOX_GEO)

function useTap(onTap) {
  const pd = useRef(null)
  return {
    onPointerDown(e) {
      if (!e.isPrimary) return
      pd.current = { t: Date.now(), x: e.clientX, y: e.clientY }
    },
    onPointerUp(e) {
      if (!e.isPrimary || !pd.current) return
      const dx = e.clientX - pd.current.x
      const dy = e.clientY - pd.current.y
      const isTap = Date.now() - pd.current.t < 300 && dx * dx + dy * dy < 64
      pd.current = null
      if (isTap) onTap(e)
    },
    onPointerLeave() { pd.current = null },
    onPointerCancel() { pd.current = null },
  }
}

function applySwipeImpulse(camera, body, swipeDx, swipeDyUp) {
  const dir = new THREE.Vector3()
  camera.getWorldDirection(dir)
  dir.y = 0
  dir.normalize()

  const right = new THREE.Vector3()
  right.crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize()

  const speed = Math.min(swipeDyUp * 0.12, 20)
  body.applyImpulse(
    {
      x: dir.x * speed + right.x * swipeDx * 0.06,
      y: speed * 0.5 + 6,
      z: dir.z * speed + right.z * swipeDx * 0.06,
    },
    true,
  )
  body.applyTorqueImpulse(
    { x: (Math.random() - 0.5) * 12, y: (Math.random() - 0.5) * 12, z: (Math.random() - 0.5) * 12 },
    true,
  )
}

function SwipeHandler({ swipeRef, orbitRef, onFreeBlock }) {
  const { gl, camera } = useThree()

  useEffect(() => {
    const canvas = gl.domElement

    function onUp(e) {
      if (!e.isPrimary) return
      const sw = swipeRef.current
      if (!sw) return

      const dx = e.clientX - sw.x0
      const dy = e.clientY - sw.y0
      const dt = Date.now() - sw.t0
      const swipeDyUp = -dy

      const isSwipeUp = swipeDyUp > 30 && Math.abs(swipeDyUp) > Math.abs(dx) * 0.6 && dt < 700

      if (isSwipeUp && sw.rb.current) {
        if (sw.isFixed) {
          // Convert fixed body to dynamic before applying impulse
          sw.rb.current.setBodyType(0, true)
          onFreeBlock(sw.blockId)
        }
        applySwipeImpulse(camera, sw.rb.current, dx, swipeDyUp)
      }

      swipeRef.current = null
      if (orbitRef.current) orbitRef.current.enabled = true
    }

    function onCancel(e) {
      if (!e.isPrimary) return
      swipeRef.current = null
      if (orbitRef.current) orbitRef.current.enabled = true
    }

    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('pointercancel', onCancel)
    return () => {
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointercancel', onCancel)
    }
  }, [gl, camera, swipeRef, orbitRef, onFreeBlock])

  return null
}

export default function Scene({ blocks, knockKey, onPlace, orbitRef, antiGravity, placeHeight, color, onFreeBlock }) {
  const swipeRef = useRef(null)
  const [ghostGrid, setGhostGrid] = useState(null) // {x, z} or null

  return (
    <>
      <SwipeHandler swipeRef={swipeRef} orbitRef={orbitRef} onFreeBlock={onFreeBlock} />
      <Floor
        onPlace={onPlace}
        antiGravity={antiGravity}
        placeHeight={placeHeight}
        color={color}
        ghostGrid={ghostGrid}
        setGhostGrid={setGhostGrid}
      />
      {blocks.map(block => (
        <Block
          key={block.id}
          block={block}
          knockKey={knockKey}
          onPlace={onPlace}
          swipeRef={swipeRef}
          orbitRef={orbitRef}
          antiGravity={antiGravity}
          placeHeight={placeHeight}
          setGhostGrid={setGhostGrid}
        />
      ))}
    </>
  )
}

function Floor({ onPlace, antiGravity, placeHeight, color, ghostGrid, setGhostGrid }) {
  const tapPoint = useRef(null)

  const handlers = useTap(() => {
    if (!tapPoint.current) return
    // Math.floor gives the cell index; block world center = index + 0.5
    const gx = Math.floor(tapPoint.current.x)
    const gz = Math.floor(tapPoint.current.z)
    if (Math.abs(gx) < HALF && Math.abs(gz) < HALF) onPlace(gx, gz)
    tapPoint.current = null
  })

  return (
    <>
      <RigidBody type="fixed" friction={1}>
        <mesh
          receiveShadow
          position={[0, -0.1, 0]}
          onPointerDown={e => { tapPoint.current = e.point.clone(); handlers.onPointerDown(e) }}
          onPointerUp={handlers.onPointerUp}
          onPointerLeave={e => {
            handlers.onPointerLeave(e)
            setGhostGrid(null)
          }}
          onPointerCancel={e => {
            handlers.onPointerCancel(e)
            setGhostGrid(null)
          }}
          onPointerMove={e => {
            if (!antiGravity) { if (ghostGrid) setGhostGrid(null); return }
            const gx = Math.floor(e.point.x)
            const gz = Math.floor(e.point.z)
            if (Math.abs(gx) < HALF && Math.abs(gz) < HALF) setGhostGrid({ x: gx, z: gz })
          }}
        >
          <boxGeometry args={[GRID, 0.2, GRID]} />
          <meshStandardMaterial color="#2c3e50" roughness={0.9} metalness={0.1} transparent opacity={0.55} depthWrite={false} />
        </mesh>
        <gridHelper args={[GRID, GRID, '#4a5568', '#2d3748']} position={[0, 0.01, 0]} />
      </RigidBody>

      {/* Ghost block preview — ghostGrid stores cell indices; world center = index + 0.5 */}
      {antiGravity && ghostGrid && (
        <>
          <mesh
            position={[ghostGrid.x + 0.5, placeHeight + 0.5, ghostGrid.z + 0.5]}
            geometry={BOX_GEO}
            raycast={() => null}
          >
            <meshStandardMaterial color={color} transparent opacity={0.4} depthWrite={false} />
          </mesh>
          {placeHeight > 0 && (
            <mesh
              position={[ghostGrid.x + 0.5, placeHeight / 2, ghostGrid.z + 0.5]}
              raycast={() => null}
            >
              <boxGeometry args={[0.05, placeHeight, 0.05]} />
              <meshBasicMaterial color={color} transparent opacity={0.2} />
            </mesh>
          )}
        </>
      )}
    </>
  )
}

function Block({ block, knockKey, onPlace, swipeRef, orbitRef, antiGravity, placeHeight, setGhostGrid }) {
  const rb = useRef(null)
  const prevKnock = useRef(knockKey)
  const pdLocal = useRef(null)

  useEffect(() => {
    if (knockKey !== prevKnock.current && rb.current) {
      prevKnock.current = knockKey
      // Ensure body is dynamic before applying impulse (handles fixed→dynamic transition timing)
      try { rb.current.setBodyType(0, true) } catch {}
      rb.current.applyImpulse(
        { x: (Math.random() - 0.5) * 20, y: Math.random() * 8 + 4, z: (Math.random() - 0.5) * 20 },
        true,
      )
      rb.current.applyTorqueImpulse(
        { x: (Math.random() - 0.5) * 10, y: (Math.random() - 0.5) * 10, z: (Math.random() - 0.5) * 10 },
        true,
      )
    }
  }, [knockKey])

  function handlePointerDown(e) {
    if (!e.isPrimary) return
    e.stopPropagation()
    if (orbitRef?.current) orbitRef.current.enabled = false
    const now = Date.now()
    pdLocal.current = { t: now, x: e.clientX, y: e.clientY }
    swipeRef.current = { x0: e.clientX, y0: e.clientY, t0: now, rb, blockId: block.id, isFixed: block.isFixed }
  }

  function handlePointerMove(e) {
    if (!antiGravity || !e.isPrimary) return
    e.stopPropagation()
    setGhostGrid({ x: block.gridX, z: block.gridZ })
  }

  function handlePointerUp(e) {
    if (!e.isPrimary) return
    e.stopPropagation()
    const loc = pdLocal.current
    pdLocal.current = null
    if (!loc) return

    const dx = e.clientX - loc.x
    const dy = e.clientY - loc.y
    const isTap = Date.now() - loc.t < 300 && dx * dx + dy * dy < 64

    if (isTap) {
      swipeRef.current = null
      if (orbitRef?.current) orbitRef.current.enabled = true
      onPlace(block.gridX, block.gridZ)
    }
    // Non-tap: leave swipeRef set for SwipeHandler to evaluate
  }

  function handlePointerLeave(e) {
    if (!e.isPrimary) return
    pdLocal.current = null
    // Don't clear swipeRef — swipe may be continuing past the block edge
  }

  function handlePointerCancel(e) {
    if (!e.isPrimary) return
    pdLocal.current = null
    swipeRef.current = null
    if (orbitRef?.current) orbitRef.current.enabled = true
  }

  return (
    <RigidBody
      ref={rb}
      position={block.position}
      type={block.isFixed ? 'fixed' : 'dynamic'}
      colliders={false}
      restitution={0.3}
      friction={0.8}
      linearDamping={0.1}
      angularDamping={0.1}
    >
      <CuboidCollider args={[0.5, 0.5, 0.5]} />
      <mesh
        castShadow
        receiveShadow
        geometry={BOX_GEO}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerLeave}
        onPointerCancel={handlePointerCancel}
      >
        <meshStandardMaterial color={block.color} roughness={0.4} metalness={0.1} />
      </mesh>
      <lineSegments geometry={EDGES_GEO}>
        <lineBasicMaterial color="#000" transparent opacity={0.15} />
      </lineSegments>
    </RigidBody>
  )
}
