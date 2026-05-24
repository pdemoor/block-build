import { useEffect, useMemo, useRef, useState } from 'react'
import { useThree, useFrame } from '@react-three/fiber'
import { RigidBody, CuboidCollider } from '@react-three/rapier'
import * as THREE from 'three'

const GRID = 24
const HALF = GRID / 2
const BOX_GEO = new THREE.BoxGeometry(1, 1, 1)
const EDGES_GEO = new THREE.EdgesGeometry(BOX_GEO)

// Pulsing ghost preview shown in float mode
function GhostBlock({ x, z, placeHeight, color }) {
  const matRef = useRef(null)
  useFrame(({ clock }) => {
    if (!matRef.current) return
    matRef.current.opacity = 0.28 + Math.sin(clock.getElapsedTime() * 3.5) * 0.10
  })
  return (
    <>
      <mesh position={[x + 0.5, placeHeight + 0.5, z + 0.5]} geometry={BOX_GEO} raycast={() => null}>
        <meshStandardMaterial ref={matRef} color={color} emissive={color} emissiveIntensity={0.22} transparent opacity={0.28} depthWrite={false} />
      </mesh>
      {placeHeight > 0 && (
        <mesh position={[x + 0.5, placeHeight / 2, z + 0.5]} raycast={() => null}>
          <boxGeometry args={[0.05, placeHeight, 0.05]} />
          <meshBasicMaterial color={color} transparent opacity={0.2} />
        </mesh>
      )}
    </>
  )
}

// Magical shimmer glow for fixed (floating) blocks: slow pulse + fast flicker
function FixedBlockMaterial({ color }) {
  const ref = useRef(null)
  useFrame(({ clock }) => {
    if (!ref.current) return
    const t = clock.getElapsedTime()
    ref.current.emissiveIntensity = 0.10 + Math.sin(t * 2.1) * 0.07 + Math.sin(t * 8.4) * 0.025
  })
  return <meshStandardMaterial ref={ref} color={color} roughness={0.22} metalness={0.05} emissive={color} emissiveIntensity={0.10} />
}

// Expanding ring shockwave on knock
function Shockwave({ knockKey }) {
  const meshRef = useRef(null)
  const matRef = useRef(null)
  const { clock } = useThree()
  const startRef = useRef(null)
  const prevKey = useRef(knockKey)

  useEffect(() => {
    if (knockKey !== prevKey.current) {
      prevKey.current = knockKey
      startRef.current = clock.getElapsedTime()
    }
  }, [knockKey, clock])

  useFrame(() => {
    if (!meshRef.current || !matRef.current || startRef.current === null) return
    const age = clock.getElapsedTime() - startRef.current
    if (age > 0.65) {
      meshRef.current.scale.setScalar(0.001)
      matRef.current.opacity = 0
      startRef.current = null
      return
    }
    const t = age / 0.65
    meshRef.current.scale.setScalar(t * 15)
    matRef.current.opacity = (1 - t) * 0.42
  })

  return (
    <mesh ref={meshRef} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.06, 0]} scale={0.001}>
      <ringGeometry args={[0.8, 1, 36]} />
      <meshBasicMaterial ref={matRef} color="#ff6040" transparent opacity={0} depthWrite={false} side={THREE.DoubleSide} />
    </mesh>
  )
}

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
  const { geoFar, geoNear } = useMemo(() => {
    const mkGeo = (count, rMin, rMax, yOff) => {
      const g = new THREE.BufferGeometry()
      const pos = new Float32Array(count * 3)
      for (let i = 0; i < count; i++) {
        const u = Math.random()
        const phi = Math.random() * Math.PI * 2
        const sinT = Math.sqrt(1 - u * u)
        const r = rMin + Math.random() * (rMax - rMin)
        pos[i * 3]     = r * sinT * Math.cos(phi)
        pos[i * 3 + 1] = r * u + yOff
        pos[i * 3 + 2] = r * sinT * Math.sin(phi)
      }
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
      return g
    }
    return { geoFar: mkGeo(340, 85, 105, 4), geoNear: mkGeo(65, 68, 85, 5) }
  }, [])
  return (
    <>
      <points geometry={geoFar}>
        <pointsMaterial size={0.09} color="#7aaee6" transparent opacity={0.32} sizeAttenuation depthWrite={false} />
      </points>
      <points geometry={geoNear}>
        <pointsMaterial size={0.22} color="#cce8ff" transparent opacity={0.58} sizeAttenuation depthWrite={false} />
      </points>
    </>
  )
}

// Slow overhead breathing light — very subtle living-world feel
function BreathingLight() {
  const ref = useRef(null)
  useFrame(({ clock }) => {
    if (!ref.current) return
    ref.current.intensity = 0.12 + Math.sin(clock.getElapsedTime() * 0.32) * 0.04
  })
  return <pointLight ref={ref} position={[2, 20, 3]} color="#1c3a6a" intensity={0.12} />
}

export default function Scene({ blocks, knockKey, onPlace, orbitRef, antiGravity, placeHeight, color, onFreeBlock }) {
  const swipeRef = useRef(null)
  const [ghostGrid, setGhostGrid] = useState(null) // {x, z} or null

  return (
    <>
      <StarField />
      <BreathingLight />
      <Shockwave knockKey={knockKey} />
      <KnockParticles knockKey={knockKey} />
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
          <meshStandardMaterial
            color="#0a1520" roughness={0.88} metalness={0.22}
            emissive="#050a14" emissiveIntensity={0.20}
            transparent opacity={0.78} depthWrite={false}
          />
        </mesh>
        {/* Fine 1-unit grid — very subtle */}
        <gridHelper args={[GRID, GRID, '#0d1e32', '#08121e']} position={[0, 0.01, 0]} />
        {/* Major 4-unit grid — slightly brighter for orientation */}
        <gridHelper args={[GRID, 6, '#18304e', '#18304e']} position={[0, 0.013, 0]} />
      </RigidBody>

      {/* Dark void plane — falling blocks drift into atmospheric darkness */}
      <mesh position={[0, -2.5, 0]} rotation={[-Math.PI / 2, 0, 0]} raycast={() => null}>
        <planeGeometry args={[GRID * 2, GRID * 2]} />
        <meshBasicMaterial color="#020508" transparent opacity={0.52} depthWrite={false} />
      </mesh>

      {antiGravity && ghostGrid && (
        <GhostBlock x={ghostGrid.x} z={ghostGrid.z} placeHeight={placeHeight} color={color} />
      )}
    </>
  )
}

// Polished metallic gold — high metalness + optional float shimmer
function GoldMaterial({ isFixed }) {
  const ref = useRef(null)
  useFrame(({ clock }) => {
    if (!ref.current || !isFixed) return
    const t = clock.getElapsedTime()
    ref.current.emissiveIntensity = 0.08 + Math.sin(t * 2.1) * 0.06 + Math.sin(t * 8.4) * 0.02
  })
  return <meshStandardMaterial ref={ref} color="#D4AF37" roughness={0.14} metalness={0.90} emissive="#D4AF37" emissiveIntensity={isFixed ? 0.08 : 0} />
}

// Lacquered gloss black — ultra-low roughness + cool blue float glow
function BlackMaterial({ isFixed }) {
  const ref = useRef(null)
  useFrame(({ clock }) => {
    if (!ref.current || !isFixed) return
    const t = clock.getElapsedTime()
    ref.current.emissiveIntensity = 0.05 + Math.sin(t * 2.1) * 0.04 + Math.sin(t * 8.4) * 0.015
  })
  return <meshStandardMaterial ref={ref} color="#111111" roughness={0.06} metalness={0.92} emissive="#6090ff" emissiveIntensity={isFixed ? 0.05 : 0} />
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

const SPARK_COUNT = 18

function KnockParticles({ knockKey }) {
  const pointsRef = useRef(null)
  const matRef = useRef(null)
  const { clock } = useThree()
  const startRef = useRef(null)
  const prevKey = useRef(knockKey)
  const velRef = useRef([])

  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SPARK_COUNT * 3), 3))
    return g
  }, [])

  useEffect(() => {
    if (knockKey === prevKey.current) return
    prevKey.current = knockKey
    startRef.current = clock.getElapsedTime()
    velRef.current = Array.from({ length: SPARK_COUNT }, () => {
      const phi = Math.random() * Math.PI * 2
      const el = (0.18 + Math.random() * 0.62) * Math.PI * 0.5
      const spd = 2.5 + Math.random() * 4.5
      return [Math.cos(el) * Math.cos(phi) * spd, Math.sin(el) * spd, Math.cos(el) * Math.sin(phi) * spd]
    })
  }, [knockKey, clock])

  useFrame(() => {
    if (!pointsRef.current || !matRef.current || startRef.current === null) return
    const age = clock.getElapsedTime() - startRef.current
    const DUR = 0.72
    if (age > DUR) { matRef.current.opacity = 0; startRef.current = null; return }
    const t = age / DUR
    matRef.current.opacity = (t < 0.12 ? t / 0.12 : 1 - t) * 0.88
    const pos = geo.attributes.position.array
    for (let i = 0; i < SPARK_COUNT; i++) {
      const [vx, vy, vz] = velRef.current[i] || [0, 2, 0]
      pos[i * 3]     = vx * age
      pos[i * 3 + 1] = Math.max(0.05, vy * age - 4.75 * age * age + 0.25)
      pos[i * 3 + 2] = vz * age
    }
    geo.attributes.position.needsUpdate = true
  })

  return (
    <points ref={pointsRef} geometry={geo}>
      <pointsMaterial ref={matRef} size={0.15} color="#ff8822" transparent opacity={0} depthWrite={false} sizeAttenuation />
    </points>
  )
}

function Block({ block, knockKey, onPlace, swipeRef, orbitRef, antiGravity, placeHeight, setGhostGrid }) {
  const rb = useRef(null)
  const prevKnock = useRef(knockKey)
  const pdLocal = useRef(null)
  const meshRef = useRef(null)
  const flashMatRef = useRef(null)
  const knockFlashRef = useRef(null)
  const { clock } = useThree()
  const birthTime = useRef(clock.getElapsedTime())

  useFrame(() => {
    const t = clock.getElapsedTime()

    // Scale: placement bounce (400ms spring), then float breathing for fixed blocks
    if (meshRef.current) {
      if (birthTime.current !== null) {
        const age = t - birthTime.current
        if (age > 0.4) { meshRef.current.scale.setScalar(1); birthTime.current = null }
        else { meshRef.current.scale.setScalar(1 + 0.22 * Math.exp(-7 * age) * Math.cos(12 * age)) }
      } else if (block.isFixed) {
        // Very subtle breathing ±1.2%, phase-offset per block id so they're not in sync
        meshRef.current.scale.setScalar(1 + Math.sin(t * 1.8 + block.id * 0.7) * 0.012)
      }
    }

    // Flash overlay: knock orange burst takes priority over birth white pop
    if (!flashMatRef.current) return
    if (knockFlashRef.current !== null) {
      const age = t - knockFlashRef.current
      if (age > 0.28) {
        knockFlashRef.current = null
        flashMatRef.current.opacity = 0
      } else {
        flashMatRef.current.color.set('#ff7730')
        flashMatRef.current.opacity = age < 0.07
          ? (age / 0.07) * 0.52
          : Math.max(0, (1 - (age - 0.07) / 0.21) * 0.52)
      }
    } else if (birthTime.current !== null) {
      const age = t - birthTime.current
      flashMatRef.current.color.set('#ffffff')
      flashMatRef.current.opacity = age < 0.15 ? (1 - age / 0.15) * 0.38 : 0
    } else {
      flashMatRef.current.opacity = 0
    }
  })

  useEffect(() => {
    if (knockKey !== prevKnock.current && rb.current) {
      prevKnock.current = knockKey
      knockFlashRef.current = clock.getElapsedTime()
      try { rb.current.setBodyType(0, true) } catch {}
      rb.current.applyImpulse(
        { x: (Math.random() - 0.5) * 26, y: Math.random() * 10 + 6, z: (Math.random() - 0.5) * 26 },
        true,
      )
      rb.current.applyTorqueImpulse(
        { x: (Math.random() - 0.5) * 16, y: (Math.random() - 0.5) * 16, z: (Math.random() - 0.5) * 16 },
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
  }

  function handlePointerLeave(e) {
    if (!e.isPrimary) return
    pdLocal.current = null
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
        ref={meshRef}
        castShadow
        receiveShadow
        geometry={BOX_GEO}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerLeave}
        onPointerCancel={handlePointerCancel}
      >
        {block.color === 'rainbow'
          ? <RainbowMaterial />
          : block.color === 'glitter'
          ? <GlitterMaterial />
          : block.color === '#D4AF37'
          ? <GoldMaterial isFixed={block.isFixed} />
          : block.color === '#111111'
          ? <BlackMaterial isFixed={block.isFixed} />
          : block.isFixed
          ? <FixedBlockMaterial color={block.color} />
          : <meshStandardMaterial color={block.color} roughness={0.25} metalness={0.0} />}
      </mesh>
      <lineSegments geometry={EDGES_GEO}>
        <lineBasicMaterial color="#000" transparent opacity={0.10} />
      </lineSegments>
      {/* Placement white pop + knock orange burst overlay */}
      <mesh geometry={BOX_GEO} scale={1.02} raycast={() => null}>
        <meshBasicMaterial ref={flashMatRef} color="#ffffff" transparent opacity={0} depthWrite={false} />
      </mesh>
    </RigidBody>
  )
}
