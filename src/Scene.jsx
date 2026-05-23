import { useEffect, useRef, useMemo } from 'react'
import { RigidBody, CuboidCollider } from '@react-three/rapier'
import * as THREE from 'three'

const BOX_GEO = new THREE.BoxGeometry(1, 1, 1)
const EDGES_GEO = new THREE.EdgesGeometry(BOX_GEO)

const BLOCK_SIZE = 1

export default function Scene({ blocks, knockKey }) {
  return (
    <>
      <Floor />
      {blocks.map(block => (
        <Block key={block.id} block={block} knockKey={knockKey} />
      ))}
    </>
  )
}

function Floor() {
  return (
    <RigidBody type="fixed" friction={1}>
      <mesh receiveShadow position={[0, -0.1, 0]}>
        <boxGeometry args={[20, 0.2, 20]} />
        <meshStandardMaterial color="#2c3e50" roughness={0.9} metalness={0.1} />
      </mesh>
      {/* Grid lines on floor */}
      <gridHelper args={[20, 20, '#4a5568', '#2d3748']} position={[0, 0.01, 0]} />
    </RigidBody>
  )
}

function Block({ block, knockKey }) {
  const rigidBodyRef = useRef(null)
  const prevKnockKey = useRef(knockKey)

  useEffect(() => {
    if (knockKey !== prevKnockKey.current && rigidBodyRef.current) {
      prevKnockKey.current = knockKey
      const body = rigidBodyRef.current

      // Apply a random sideways impulse + some upward force
      const fx = (Math.random() - 0.5) * 20
      const fy = Math.random() * 8 + 4
      const fz = (Math.random() - 0.5) * 20
      body.applyImpulse({ x: fx, y: fy, z: fz }, true)

      // Random torque for spin
      const tx = (Math.random() - 0.5) * 10
      const ty = (Math.random() - 0.5) * 10
      const tz = (Math.random() - 0.5) * 10
      body.applyTorqueImpulse({ x: tx, y: ty, z: tz }, true)
    }
  }, [knockKey])

  return (
    <RigidBody
      ref={rigidBodyRef}
      position={block.position}
      colliders={false}
      restitution={0.3}
      friction={0.8}
      linearDamping={0.1}
      angularDamping={0.1}
    >
      <CuboidCollider args={[BLOCK_SIZE / 2, BLOCK_SIZE / 2, BLOCK_SIZE / 2]} />
      <mesh castShadow receiveShadow>
        <boxGeometry args={[BLOCK_SIZE, BLOCK_SIZE, BLOCK_SIZE]} />
        <meshStandardMaterial
          color={block.color}
          roughness={0.4}
          metalness={0.1}
        />
      </mesh>
      {/* Subtle edge highlight */}
      <lineSegments geometry={EDGES_GEO}>
        <lineBasicMaterial color="#000" transparent opacity={0.15} />
      </lineSegments>
    </RigidBody>
  )
}
