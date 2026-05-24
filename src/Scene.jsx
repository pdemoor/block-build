import { useEffect, useRef } from 'react'
import { useThree } from '@react-three/fiber'
import { RigidBody, CuboidCollider } from '@react-three/rapier'
import * as THREE from 'three'

const GRID = 24
const HALF = GRID / 2
const BOX_GEO = new THREE.BoxGeometry(1, 1, 1)
const EDGES_GEO = new THREE.EdgesGeometry(BOX_GEO)

// Returns {t, x, y} on pointerdown, null after consumed.
// Use to distinguish a tap (< 300ms, < 8px movement) from a drag/orbit.
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

  // perpendicular (right) direction for horizontal swipe component
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
    {
      x: (Math.random() - 0.5) * 12,
      y: (Math.random() - 0.5) * 12,
      z: (Math.random() - 0.5) * 12,
    },
    true,
  )
}

// Listens for the canvas-level pointerup/pointercancel that signals the end of
// a swipe that started on a block (the pointer may have moved off the block mesh
// before release, so we can't rely on Block's own onPointerUp for this case).
function SwipeHandler({ swipeRef, orbitRef }) {
  const { gl, camera } = useThree()

  useEffect(() => {
    const canvas = gl.domElement

    function onUp(e) {
      if (!e.isPrimary) return
      const sw = swipeRef.current
      if (!sw) return

      const dx = e.clientX - sw.x0
      const dy = e.clientY - sw.y0   // positive = downward
      const dt = Date.now() - sw.t0
      const swipeDyUp = -dy           // positive = upward swipe

      const isSwipeUp = swipeDyUp > 30 && Math.abs(swipeDyUp) > Math.abs(dx) * 0.6 && dt < 700

      if (isSwipeUp && sw.rb.current) {
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
  }, [gl, camera, swipeRef, orbitRef])

  return null
}

export default function Scene({ blocks, knockKey, onPlace, orbitRef }) {
  // Shared ref: set when a primary pointer goes down on a block, cleared on up/cancel.
  // { x0, y0, t0, rb } — rb is the RigidBody ref of the touched block.
  const swipeRef = useRef(null)

  return (
    <>
      <SwipeHandler swipeRef={swipeRef} orbitRef={orbitRef} />
      <Floor onPlace={onPlace} />
      {blocks.map(block => (
        <Block
          key={block.id}
          block={block}
          knockKey={knockKey}
          onPlace={onPlace}
          swipeRef={swipeRef}
          orbitRef={orbitRef}
        />
      ))}
    </>
  )
}

function Floor({ onPlace }) {
  const tapPoint = useRef(null)

  const handlers = useTap(() => {
    if (!tapPoint.current) return
    const gx = Math.round(tapPoint.current.x)
    const gz = Math.round(tapPoint.current.z)
    if (Math.abs(gx) < HALF && Math.abs(gz) < HALF) onPlace(gx, gz)
    tapPoint.current = null
  })

  return (
    <RigidBody type="fixed" friction={1}>
      <mesh
        receiveShadow
        position={[0, -0.1, 0]}
        onPointerDown={e => { tapPoint.current = e.point.clone(); handlers.onPointerDown(e) }}
        onPointerUp={handlers.onPointerUp}
        onPointerLeave={handlers.onPointerLeave}
        onPointerCancel={handlers.onPointerCancel}
      >
        <boxGeometry args={[GRID, 0.2, GRID]} />
        <meshStandardMaterial color="#2c3e50" roughness={0.9} metalness={0.1} />
      </mesh>
      <gridHelper args={[GRID, GRID, '#4a5568', '#2d3748']} position={[0, 0.01, 0]} />
    </RigidBody>
  )
}

function Block({ block, knockKey, onPlace, swipeRef, orbitRef }) {
  const rb = useRef(null)
  const prevKnock = useRef(knockKey)
  // Track pointer-down state locally to distinguish tap vs swipe-that-stayed-on-block
  const pdLocal = useRef(null)

  useEffect(() => {
    if (knockKey !== prevKnock.current && rb.current) {
      prevKnock.current = knockKey
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
    // Disable orbit so this drag doesn't rotate the camera
    if (orbitRef && orbitRef.current) orbitRef.current.enabled = false
    const now = Date.now()
    pdLocal.current = { t: now, x: e.clientX, y: e.clientY }
    swipeRef.current = { x0: e.clientX, y0: e.clientY, t0: now, rb }
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

    // SwipeHandler will fire next (same event bubbles to canvas DOM listener),
    // so just clear local state here. SwipeHandler handles the impulse + orbit re-enable.
    // For taps, we also place a block — but only after SwipeHandler clears swipeRef
    // (which happens synchronously in the same event handlers chain).
    if (isTap) {
      // Clear swipeRef now so SwipeHandler doesn't treat this tap as a swipe
      swipeRef.current = null
      if (orbitRef && orbitRef.current) orbitRef.current.enabled = true
      onPlace(block.gridX, block.gridZ)
    }
    // Non-tap: leave swipeRef set so SwipeHandler can evaluate it
  }

  function handlePointerLeave(e) {
    if (!e.isPrimary) return
    pdLocal.current = null
    // Don't clear swipeRef — the swipe may be continuing past the block edge.
    // Don't re-enable orbit yet — SwipeHandler will do it on pointerup.
  }

  function handlePointerCancel(e) {
    if (!e.isPrimary) return
    pdLocal.current = null
    swipeRef.current = null
    if (orbitRef && orbitRef.current) orbitRef.current.enabled = true
  }

  return (
    <RigidBody
      ref={rb}
      position={block.position}
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
