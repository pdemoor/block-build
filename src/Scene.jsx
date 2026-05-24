import { useEffect, useRef } from 'react'
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
      pd.current = { t: Date.now(), x: e.clientX, y: e.clientY }
    },
    onPointerUp(e) {
      if (!pd.current) return
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

export default function Scene({ blocks, knockKey, onPlace }) {
  return (
    <>
      <Floor onPlace={onPlace} />
      {blocks.map(block => (
        <Block key={block.id} block={block} knockKey={knockKey} onPlace={onPlace} />
      ))}
    </>
  )
}

function Floor({ onPlace }) {
  // Store the intersection point from pointerDown so we can use it in onPointerUp
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

function Block({ block, knockKey, onPlace }) {
  const rb = useRef(null)
  const prevKnock = useRef(knockKey)

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

  const handlers = useTap(() => onPlace(block.gridX, block.gridZ))

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
        onPointerDown={e => { e.stopPropagation(); handlers.onPointerDown(e) }}
        onPointerUp={e => { e.stopPropagation(); handlers.onPointerUp(e) }}
        onPointerLeave={handlers.onPointerLeave}
        onPointerCancel={handlers.onPointerCancel}
      >
        <meshStandardMaterial color={block.color} roughness={0.4} metalness={0.1} />
      </mesh>
      <lineSegments geometry={EDGES_GEO}>
        <lineBasicMaterial color="#000" transparent opacity={0.15} />
      </lineSegments>
    </RigidBody>
  )
}
