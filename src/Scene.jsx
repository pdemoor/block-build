import { useEffect, useMemo, useRef, useState } from 'react'
import { useThree, useFrame } from '@react-three/fiber'
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

function StarField() {
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry()
    const pos = new Float32Array(300 * 3)
    for (let i = 0; i < 300; i++) {
      const u = Math.random()                      // cos of polar angle → 0=horizon,1=zenith
      const phi = Math.random() * Math.PI * 2
      const sinT = Math.sqrt(1 - u * u)
      const r = 80 + Math.random() * 20
      pos[i * 3]     = r * sinT * Math.cos(phi)
      pos[i * 3 + 1] = r * u + 4                  // keep above floor
      pos[i * 3 + 2] = r * sinT * Math.sin(phi)
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    return g
  }, [])
  return (
    <points geometry={geo}>
      <pointsMaterial size={0.15} color="#8ab0e8" transparent opacity={0.5} sizeAttenuation depthWrite={false} />
    </points>
  )
}

export default function Scene({ blocks, knockKey, onPlace, orbitRef, antiGravity, placeHeight, color, onFreeBlock }) {
  const swipeRef = useRef(null)
  const [ghostGrid, setGhostGrid] = useState(null) // {x, z} or null

  return (
    <>
      <StarField />
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
          <meshStandardMaterial color="#0b1624" roughness={0.92} metalness={0.18} emissive="#050a12" emissiveIntensity={0.3} transparent opacity={0.72} depthWrite={false} />
        </mesh>
        <gridHelper args={[GRID, GRID, '#1c3254', '#0d1a2c']} position={[0, 0.01, 0]} />
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

function GlitterMaterial() {
  const ref = useRef(null)
  useFrame(({ clock }) => {
    if (!ref.current) return
    const t = clock.getElapsedTime()
    // Product of incommensurate frequencies → pseudo-random sparkle bursts
    const s = Math.max(0, Math.sin(t * 6.7) * Math.cos(t * 11.3) * Math.sin(t * 17.1)) * 3
    ref.current.emissiveIntensity = s
  })
  return <meshStandardMaterial ref={ref} color="#D0D8F0" metalness={0.95} roughness={0.04} emissive="#ffffff" emissiveIntensity={0} />
}

function RainbowMaterial() {
  const ref = useRef(null)
  useFrame(({ clock }) => {
    if (!ref.current) return
    const t = clock.getElapsedTime()
    ref.current.color.setHSL(t * 0.3 % 1, 1, 0.55)
    ref.current.emissive.setHSL((t * 0.3 + 0.5) % 1, 0.8, 0.12)
  })
  return <meshStandardMaterial ref={ref} roughness={0.2} metalness={0.5} emissiveIntensity={0.4} />
}

function Block({ block, knockKey, onPlace, swipeRef, orbitRef, antiGravity, placeHeight, setGhostGrid }) {
  const rb = useRef(null)
  const prevKnock = useRef(knockKey)
  const pdLocal = useRef(null)

  useEffect(() => {
    if (knockKey !== prevKnock.current && rb.current) {
      prevKnock.current = knockKey
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
    const now = Date.now()
    pdLocal.current = { t: now, x: e.clientX, y: e.clientY }
    if (orbitRef?.current) orbitRef.current.enabled = false
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
        {block.color === 'rainbow' ? <RainbowMaterial /> : block.color === 'glitter' ? <GlitterMaterial /> : <meshStandardMaterial color={block.color} roughness={0.4} metalness={0.1} />}
      </mesh>
      <lineSegments geometry={EDGES_GEO}>
        <lineBasicMaterial color="#000" transparent opacity={0.10} />
      </lineSegments>
    </RigidBody>
  )
}
