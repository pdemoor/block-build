import { useEffect, useMemo, useRef, useState } from 'react'
import { useThree, useFrame } from '@react-three/fiber'
import { RigidBody, CuboidCollider } from '@react-three/rapier'
import * as THREE from 'three'

const GRID = 24
const HALF = GRID / 2
const BOX_GEO = new THREE.BoxGeometry(1, 1, 1)
const EDGES_GEO = new THREE.EdgesGeometry(BOX_GEO)

// Perimeter outline of the floor platform — used for glowing rim
const FLOOR_RIM_GEO = (() => {
  const H = HALF
  const g = new THREE.BufferGeometry()
  const v = new Float32Array([
    -H, 0, -H,  H, 0, -H,
     H, 0, -H,  H, 0,  H,
     H, 0,  H, -H, 0,  H,
    -H, 0,  H, -H, 0, -H,
  ])
  g.setAttribute('position', new THREE.BufferAttribute(v, 3))
  return g
})()

const PARTICLE_VERT = `
  attribute float aSize;
  attribute float aPhase;
  attribute vec3 aColor;
  uniform float uTime;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vColor = aColor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float sz = aSize * (130.0 / -mv.z);
    gl_PointSize = max(2.0, min(sz, 48.0));
    gl_Position = projectionMatrix * mv;
    vAlpha = 0.5 + 0.5 * sin(uTime * 0.85 + aPhase);
  }
`

const PARTICLE_FRAG = `
  uniform float uOpacity;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    if (d > 0.5) discard;
    float a = (1.0 - smoothstep(0.1, 0.5, d)) * vAlpha * uOpacity;
    gl_FragColor = vec4(vColor, a);
  }
`

const TRAIL_VERT = `
  attribute float aAlpha;
  attribute float aSize;
  attribute vec3 aColor;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vAlpha = aAlpha;
    vColor = aColor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float sz = aSize * (120.0 / -mv.z);
    gl_PointSize = max(1.5, min(sz, 36.0));
    gl_Position = projectionMatrix * mv;
  }
`

const TRAIL_FRAG = `
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    if (d > 0.5) discard;
    float a = smoothstep(0.5, 0.0, d) * vAlpha;
    gl_FragColor = vec4(vColor, a);
  }
`

// Module-level spaghetti texture — drawn once, shared across all spaghetti cubes
const SPAGHETTI_TEX = (() => {
  const SIZE = 256
  const canvas = document.createElement('canvas')
  canvas.width = SIZE; canvas.height = SIZE
  const ctx = canvas.getContext('2d')

  // Tomato sauce base
  ctx.fillStyle = '#9A2210'
  ctx.fillRect(0, 0, SIZE, SIZE)

  // Sauce depth blobs
  for (let i = 0; i < 9; i++) {
    const bx = Math.sin(i * 1.618) * 88 + SIZE / 2
    const by = Math.cos(i * 2.414) * 88 + SIZE / 2
    const g = ctx.createRadialGradient(bx, by, 4, bx, by, 52)
    g.addColorStop(0, 'rgba(50,8,4,0.32)')
    g.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = g; ctx.fillRect(0, 0, SIZE, SIZE)
  }

  const N = 9
  const bandH = SIZE / N

  for (let i = 0; i < N; i++) {
    const yC = (i + 0.5) * bandH
    const r = bandH * 0.41
    const ph = i * 2.14 + 0.9

    const mkPath = () => {
      ctx.beginPath()
      for (let x = 0; x <= SIZE; x += 2) {
        const w = Math.sin(x * 0.038 + ph) * 3.2 + Math.sin(x * 0.082 + ph * 1.6) * 1.6
        if (x === 0) ctx.moveTo(x, yC - r + w)
        else ctx.lineTo(x, yC - r + w)
      }
      for (let x = SIZE; x >= 0; x -= 2) {
        const w = Math.sin(x * 0.038 + ph) * 3.2 + Math.sin(x * 0.082 + ph * 1.6) * 1.6
        ctx.lineTo(x, yC + r + w)
      }
      ctx.closePath()
    }

    // Noodle body — warm pasta hue varies per strand
    const hue = 40 + (i % 3) * 5
    const sat = 70 + (i % 2) * 9
    const lit = 68 + (i % 4) * 4
    mkPath(); ctx.fillStyle = `hsl(${hue},${sat}%,${lit}%)`; ctx.fill()

    // Bottom shadow — cylindrical depth
    mkPath()
    const sg = ctx.createLinearGradient(0, yC - r, 0, yC + r)
    sg.addColorStop(0, 'rgba(0,0,0,0)'); sg.addColorStop(0.6, 'rgba(0,0,0,0)'); sg.addColorStop(1, 'rgba(0,0,0,0.32)')
    ctx.fillStyle = sg; ctx.fill()

    // Top highlight — specular sheen
    mkPath()
    const hg = ctx.createLinearGradient(0, yC - r, 0, yC + r)
    hg.addColorStop(0, `hsla(${hue},40%,96%,0.68)`)
    hg.addColorStop(0.27, `hsla(${hue},50%,88%,0.18)`)
    hg.addColorStop(0.5, 'rgba(255,255,255,0)')
    ctx.fillStyle = hg; ctx.fill()
  }

  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
})()

// Safe display color for special string-keyed materials (ghost block, etc.)
function displayColor(c) {
  if (c === 'rainbow') return '#ff6688'
  if (c === 'glitter') return '#d8e4f8'
  if (c === 'spaghetti') return '#E8C060'
  return c
}

// Module-level circular particle pool — no per-frame allocations
const TN = 500
const _tp  = new Float32Array(TN * 3)
const _ta  = new Float32Array(TN)
const _tc  = new Float32Array(TN * 3)
const _ts  = new Float32Array(TN)
const _tb  = new Float32Array(TN)
const _td  = new Float32Array(TN)
const _tma = new Float32Array(TN)
let   _th  = 0
const _col = new THREE.Color()

function _emit(x, y, z, r, g, b, sz, dur, maxA, now) {
  const i = _th++ % TN
  _tp[i*3]=x; _tp[i*3+1]=y; _tp[i*3+2]=z
  _tc[i*3]=r; _tc[i*3+1]=g; _tc[i*3+2]=b
  _ts[i]=sz; _tb[i]=now; _td[i]=dur; _tma[i]=maxA
  _ta[i]=maxA  // pre-seed so particle is visible this frame
}

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
        <meshStandardMaterial ref={matRef} color={displayColor(color)} emissive={displayColor(color)} emissiveIntensity={0.22} transparent opacity={0.28} depthWrite={false} />
      </mesh>
      {placeHeight > 0 && (
        <mesh position={[x + 0.5, placeHeight / 2, z + 0.5]} raycast={() => null}>
          <boxGeometry args={[0.05, placeHeight, 0.05]} />
          <meshBasicMaterial color={displayColor(color)} transparent opacity={0.2} />
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
  return <meshStandardMaterial ref={ref} color={color} roughness={0.10} metalness={0.08} envMapIntensity={1.4} emissive={color} emissiveIntensity={0.10} />
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

// Very slow fog density pulse — world feels like it's breathing
function AmbientBreath() {
  const { scene } = useThree()
  useFrame(({ clock }) => {
    if (!scene.fog) return
    const t = clock.getElapsedTime()
    scene.fog.near = 56 + Math.sin(t * 0.055) * 2.5
    scene.fog.far = 100 + Math.cos(t * 0.038) * 4
  })
  return null
}

// Extremely gentle camera orbit that fades in after ~4 s of inactivity,
// then immediately surrenders the moment the user touches controls.
function CinematicDrift({ orbitRef }) {
  const lastActivity = useRef(performance.now())

  useEffect(() => {
    const ctrl = orbitRef.current
    if (!ctrl) return
    const stop = () => {
      lastActivity.current = performance.now()
      ctrl.autoRotate = false
      ctrl.autoRotateSpeed = 0
    }
    const mark = () => { lastActivity.current = performance.now() }
    ctrl.addEventListener('start', stop)
    ctrl.addEventListener('change', mark)
    return () => {
      ctrl.removeEventListener('start', stop)
      ctrl.removeEventListener('change', mark)
    }
  }, [orbitRef])

  useFrame(() => {
    const ctrl = orbitRef.current
    if (!ctrl) return
    const idleSec = (performance.now() - lastActivity.current) / 1000
    const target = idleSec > 4 ? 0.16 : 0
    // Lerp speed so it fades in/out smoothly; hard-stop on 'start' handles
    // the case where the user grabs the camera mid-drift.
    ctrl.autoRotateSpeed += (target - ctrl.autoRotateSpeed) * 0.01
    ctrl.autoRotate = ctrl.autoRotateSpeed > 0.004
  })

  return null
}

function AmbientParticles() {
  const COUNT = 90
  const pointsRef = useRef(null)

  const state = useMemo(() => {
    const rng = (lo, hi) => lo + Math.random() * (hi - lo)
    const COLORS = [
      [0.62, 0.76, 0.97],
      [0.80, 0.76, 1.00],
      [0.86, 0.93, 1.00],
      [1.00, 1.00, 1.00],
      [0.72, 0.88, 1.00],
    ]
    const baseX = new Float32Array(COUNT)
    const baseZ = new Float32Array(COUNT)
    const baseY = new Float32Array(COUNT)
    const speeds = new Float32Array(COUNT)
    const phases = new Float32Array(COUNT)
    const pos = new Float32Array(COUNT * 3)
    const sizes = new Float32Array(COUNT)
    const colAttr = new Float32Array(COUNT * 3)

    for (let i = 0; i < COUNT; i++) {
      baseX[i] = rng(-12, 12)
      baseZ[i] = rng(-12, 12)
      baseY[i] = rng(0, 18)
      speeds[i] = rng(0.08, 0.28)
      phases[i] = rng(0, Math.PI * 2)
      pos[i*3] = baseX[i]; pos[i*3+1] = baseY[i]; pos[i*3+2] = baseZ[i]
      sizes[i] = rng(0.6, 1.9)
      const c = COLORS[Math.floor(Math.random() * COLORS.length)]
      colAttr[i*3] = c[0]; colAttr[i*3+1] = c[1]; colAttr[i*3+2] = c[2]
    }

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    geometry.setAttribute('aSize',    new THREE.BufferAttribute(sizes, 1))
    geometry.setAttribute('aPhase',   new THREE.BufferAttribute(phases, 1))
    geometry.setAttribute('aColor',   new THREE.BufferAttribute(colAttr, 3))

    const material = new THREE.ShaderMaterial({
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      uniforms: { uTime: { value: 0 }, uOpacity: { value: 0.26 } },
      transparent: true,
      depthWrite: false,
    })

    return { baseX, baseZ, baseY, speeds, phases, geometry, material }
  }, [])

  useFrame(({ clock }, delta) => {
    const pts = pointsRef.current
    if (!pts) return
    const { baseX, baseZ, baseY, speeds, phases, geometry } = state
    const t = clock.getElapsedTime()
    pts.material.uniforms.uTime.value = t
    const attr = geometry.attributes.position
    for (let i = 0; i < COUNT; i++) {
      baseY[i] += speeds[i] * delta
      if (baseY[i] > 18) {
        baseY[i] = -0.5
        baseX[i] = (Math.random() - 0.5) * 24
        baseZ[i] = (Math.random() - 0.5) * 24
      }
      attr.setXYZ(
        i,
        baseX[i] + Math.sin(t * 0.38 + phases[i]) * 0.6,
        baseY[i],
        baseZ[i] + Math.cos(t * 0.31 + phases[i] * 1.4) * 0.5,
      )
    }
    attr.needsUpdate = true
  })

  return <points ref={pointsRef} geometry={state.geometry} material={state.material} />
}

function TrailSystem() {
  const { geo, mat } = useMemo(() => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(_tp, 3))
    g.setAttribute('aAlpha',   new THREE.BufferAttribute(_ta, 1))
    g.setAttribute('aColor',   new THREE.BufferAttribute(_tc, 3))
    g.setAttribute('aSize',    new THREE.BufferAttribute(_ts, 1))
    const m = new THREE.ShaderMaterial({
      vertexShader: TRAIL_VERT,
      fragmentShader: TRAIL_FRAG,
      transparent: true,
      depthWrite: false,
    })
    return { geo: g, mat: m }
  }, [])

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime()
    for (let i = 0; i < TN; i++) {
      const f = _td[i] > 0 ? (t - _tb[i]) / _td[i] : 1
      _ta[i] = f >= 1 ? 0 : _tma[i] * (1 - f) * (1 - f)
    }
    geo.attributes.aAlpha.needsUpdate = true
    geo.attributes.position.needsUpdate = true
  })

  return <points geometry={geo} material={mat} />
}

export default function Scene({ blocks, knockKey, onPlace, orbitRef, antiGravity, placeHeight, color, isRandom, onFreeBlock, isPhotoMode }) {
  const swipeRef = useRef(null)
  const [ghostGrid, setGhostGrid] = useState(null) // {x, z} or null

  return (
    <>
      <StarField />
      <BreathingLight />
      <AmbientBreath />
      <CinematicDrift orbitRef={orbitRef} />
      <AmbientParticles />
      <TrailSystem />
      <Shockwave knockKey={knockKey} />
      <KnockParticles knockKey={knockKey} />
      <SwipeHandler swipeRef={swipeRef} orbitRef={orbitRef} onFreeBlock={onFreeBlock} />
      <Floor
        onPlace={onPlace}
        antiGravity={antiGravity}
        placeHeight={placeHeight}
        color={color}
        isRandom={isRandom}
        ghostGrid={ghostGrid}
        setGhostGrid={setGhostGrid}
        isPhotoMode={isPhotoMode}
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

function Floor({ onPlace, antiGravity, placeHeight, color, isRandom, ghostGrid, setGhostGrid, isPhotoMode }) {
  const tapPoint = useRef(null)

  const handlers = useTap(() => {
    if (!tapPoint.current || isPhotoMode) return
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
          {/* Dark glass floor — translucent so falling cubes stay visible below */}
          <meshStandardMaterial
            color="#080d18" roughness={0.28} metalness={0.72}
            emissive="#050c22" emissiveIntensity={0.16}
            envMapIntensity={2.4}
            transparent opacity={0.38} depthWrite={false}
          />
        </mesh>
        {/* Fine 1-unit grid — very subtle */}
        <gridHelper args={[GRID, GRID, '#0d1e32', '#08121e']} position={[0, 0.01, 0]} />
        {/* Major 4-unit grid — slightly brighter for orientation */}
        <gridHelper args={[GRID, 6, '#18304e', '#18304e']} position={[0, 0.013, 0]} />
      </RigidBody>

      {/* Glowing platform rim — defines edge, preserves "physical surface" feel */}
      <lineSegments geometry={FLOOR_RIM_GEO} position={[0, 0.014, 0]}>
        <lineBasicMaterial color="#2878d8" transparent opacity={0.72} depthWrite={false} />
      </lineSegments>
      {/* Softer outer glow ring just below rim */}
      <lineSegments geometry={FLOOR_RIM_GEO} position={[0, -0.12, 0]}>
        <lineBasicMaterial color="#1050a8" transparent opacity={0.38} depthWrite={false} />
      </lineSegments>

      {/* Far-distance void fade — only softens cubes at extreme depth, not the visible fall zone */}
      <mesh position={[0, -28, 0]} rotation={[-Math.PI / 2, 0, 0]} raycast={() => null}>
        <planeGeometry args={[GRID * 4, GRID * 4]} />
        <meshBasicMaterial color="#010306" transparent opacity={0.06} depthWrite={false} />
      </mesh>

      {antiGravity && ghostGrid && !isRandom && (
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
  return <meshStandardMaterial ref={ref} color="#D4AF37" roughness={0.09} metalness={0.93} emissive="#D4AF37" emissiveIntensity={isFixed ? 0.08 : 0} />
}

// Lacquered gloss black — ultra-low roughness + cool blue float glow
function BlackMaterial({ isFixed }) {
  const ref = useRef(null)
  useFrame(({ clock }) => {
    if (!ref.current || !isFixed) return
    const t = clock.getElapsedTime()
    ref.current.emissiveIntensity = 0.05 + Math.sin(t * 2.1) * 0.04 + Math.sin(t * 8.4) * 0.015
  })
  return <meshStandardMaterial ref={ref} color="#111111" roughness={0.04} metalness={0.94} emissive="#6090ff" emissiveIntensity={isFixed ? 0.05 : 0} />
}

// Brushed metallic silver
function SilverMaterial({ isFixed }) {
  const ref = useRef(null)
  useFrame(({ clock }) => {
    if (!ref.current || !isFixed) return
    const t = clock.getElapsedTime()
    ref.current.emissiveIntensity = 0.06 + Math.sin(t * 2.1) * 0.04 + Math.sin(t * 8.4) * 0.015
  })
  return <meshStandardMaterial ref={ref} color="#C0C0C0" roughness={0.08} metalness={0.90} emissive="#C0C0C0" emissiveIntensity={isFixed ? 0.06 : 0} />
}

// Lime jelly — ultra-translucent, iridescent, dual-shell inner glow creates ripple illusion
function JellyMaterial({ isFixed }) {
  const matRef = useRef(null)
  const shell1Ref = useRef(null)
  const shell2Ref = useRef(null)
  useFrame(({ clock }) => {
    const t = clock.getElapsedTime()
    const base = isFixed ? 0.26 : 0.15
    const pulse = Math.sin(t * 2.3) * 0.11 + Math.sin(t * 5.2) * 0.045 + Math.sin(t * 9.1) * 0.020
    if (matRef.current) matRef.current.emissiveIntensity = base + pulse
    // Two shells pulse at different speeds/phases — interference creates ripple feel
    if (shell1Ref.current) shell1Ref.current.opacity = 0.22 + Math.abs(Math.sin(t * 2.3 + 0.4)) * 0.16
    if (shell2Ref.current) shell2Ref.current.opacity = 0.10 + Math.abs(Math.sin(t * 3.9 + 1.9)) * 0.12
  })
  return (
    <>
      <meshPhysicalMaterial
        ref={matRef}
        color="#7CFF00"
        roughness={0.01}
        metalness={0}
        clearcoat={1.0}
        clearcoatRoughness={0.02}
        transparent
        opacity={0.50}
        envMapIntensity={2.8}
        emissive="#5aff00"
        emissiveIntensity={0.15}
        iridescence={0.72}
        iridescenceIOR={1.3}
        iridescenceThicknessRange={[80, 380]}
      />
      {/* Outer glow shell — primary subsurface scatter illusion */}
      <mesh geometry={BOX_GEO} scale={0.84} raycast={() => null}>
        <meshBasicMaterial ref={shell1Ref} color="#aaff40" transparent opacity={0.22} depthWrite={false} side={THREE.BackSide} />
      </mesh>
      {/* Inner glow shell — different phase creates depth/ripple illusion */}
      <mesh geometry={BOX_GEO} scale={0.55} raycast={() => null}>
        <meshBasicMaterial ref={shell2Ref} color="#ccff60" transparent opacity={0.10} depthWrite={false} side={THREE.BackSide} />
      </mesh>
    </>
  )
}

// Spaghetti cube — glossy sauce sheen, animated noodle drift, inner sauce warmth
function SpaghettiMaterial({ isFixed }) {
  const matRef = useRef(null)
  const sauceRef = useRef(null)
  useFrame(({ clock }) => {
    const t = clock.getElapsedTime()
    // Noodles drift faster + more lateral sway
    if (SPAGHETTI_TEX) {
      SPAGHETTI_TEX.offset.y = (t * 0.028) % 1
      SPAGHETTI_TEX.offset.x = Math.sin(t * 0.48) * 0.022
    }
    if (!matRef.current) return
    matRef.current.emissiveIntensity = (isFixed ? 0.11 : 0.03)
      + Math.sin(t * 1.9) * 0.05 + Math.sin(t * 7.1) * 0.018
    if (sauceRef.current) sauceRef.current.opacity = 0.16 + Math.abs(Math.sin(t * 1.7 + 0.8)) * 0.12
  })
  return (
    <>
      <meshPhysicalMaterial
        ref={matRef}
        map={SPAGHETTI_TEX}
        roughness={0.26}
        metalness={0}
        clearcoat={0.72}
        clearcoatRoughness={0.42}
        envMapIntensity={1.10}
        emissive="#D46020"
        emissiveIntensity={0.03}
        iridescence={0.22}
        iridescenceIOR={1.2}
        iridescenceThicknessRange={[60, 220]}
      />
      {/* Inner sauce shell — warm tomato backlight, pulses like simmering sauce */}
      <mesh geometry={BOX_GEO} scale={0.76} raycast={() => null}>
        <meshBasicMaterial ref={sauceRef} color="#ff4808" transparent opacity={0.16} depthWrite={false} side={THREE.BackSide} />
      </mesh>
    </>
  )
}

// Frosted ice — soft constant glow, stronger when floating
function IceCyanMaterial({ isFixed }) {
  const ref = useRef(null)
  useFrame(({ clock }) => {
    if (!ref.current) return
    const t = clock.getElapsedTime()
    const base = isFixed ? 0.10 : 0.05
    ref.current.emissiveIntensity = base + Math.sin(t * 1.7) * 0.03 + Math.sin(t * 5.3) * 0.015
  })
  return <meshStandardMaterial ref={ref} color="#7DF9FF" roughness={0.13} metalness={0.06} envMapIntensity={1.3} emissive="#7DF9FF" emissiveIntensity={0.05} />
}

function GlitterMaterial() {
  const ref = useRef(null)
  useFrame(({ clock }) => {
    if (!ref.current) return
    const t = clock.getElapsedTime()
    const s = Math.max(0, Math.sin(t * 6.7) * Math.cos(t * 11.3) * Math.sin(t * 17.1)) * 3.2
    // Cycle emissive hue through silver-blue-gold-white for multi-facet glitter shimmer
    const hue = (t * 0.18 + Math.sin(t * 4.3) * 0.25) % 1
    ref.current.emissive.setHSL(hue, 0.55, 0.85)
    ref.current.emissiveIntensity = s
    // Metalness flicker for "catching light" feel
    ref.current.metalness = 0.92 + Math.sin(t * 13.7) * 0.06
  })
  return <meshStandardMaterial ref={ref} color="#D8E0F4" metalness={0.92} roughness={0.03} emissive="#ffffff" emissiveIntensity={0} />
}

function RainbowMaterial() {
  const ref = useRef(null)
  useFrame(({ clock }) => {
    if (!ref.current) return
    const t = clock.getElapsedTime()
    ref.current.color.setHSL(t * 0.3 % 1, 1, 0.55)
    ref.current.emissive.setHSL((t * 0.3 + 0.5) % 1, 0.8, 0.12)
    // Metalness shimmer: specular highlight dances as material "catches light"
    ref.current.metalness = 0.45 + Math.sin(t * 7.3) * 0.25 + Math.sin(t * 13.1) * 0.12
    ref.current.roughness  = 0.13 + Math.sin(t * 4.7) * 0.06
  })
  return <meshStandardMaterial ref={ref} roughness={0.13} metalness={0.5} emissiveIntensity={0.4} />
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
  const lastTrailRef = useRef(-999)
  const jellyKnockRef = useRef(null)
  const jellyWobbleRef = useRef(null)
  const spaghettiKnockRef = useRef(null)
  const spaghettiWobbleRef = useRef(null)
  const { clock } = useThree()
  const birthTime = useRef(clock.getElapsedTime())

  useFrame(() => {
    const t = clock.getElapsedTime()

    // Scale: placement bounce / jelly wobble / float breathing
    if (meshRef.current) {
      if (block.color === '#7CFF00') {
        // Velocity-driven wobble: fires while block is tumbling/falling, creating continuous squish
        let curSpd = 0
        if (rb.current) {
          const rv = rb.current.linvel()
          const ra = rb.current.angvel()
          curSpd = Math.sqrt(rv.x*rv.x + rv.y*rv.y + rv.z*rv.z)
                 + Math.sqrt(ra.x*ra.x + ra.y*ra.y + ra.z*ra.z) * 0.4
          if (curSpd > 0.7) jellyWobbleRef.current = t
        }

        const kAge = jellyKnockRef.current !== null ? t - jellyKnockRef.current : 999
        const wAge = jellyWobbleRef.current !== null ? t - jellyWobbleRef.current : 999
        const bAge = birthTime.current !== null ? t - birthTime.current : 999
        let sx = 1, sy = 1, sz = 1

        if (kAge < 2.2) {
          // Knock: 4 waves, very high amplitude, very slow decay — gooey long aftermath
          const w1 = 0.78 * Math.exp(-1.8 * kAge) * Math.sin(8.5 * kAge + Math.PI * 0.45)
          const w2 = 0.42 * Math.exp(-1.6 * kAge) * Math.sin(14.0 * kAge + Math.PI * 0.85)
          const w3 = 0.22 * Math.exp(-1.4 * kAge) * Math.sin(20.5 * kAge)
          const w4 = 0.14 * Math.exp(-1.1 * kAge) * Math.sin(5.5 * kAge + Math.PI * 1.2) // slow low-freq ripple
          sx = 1 + w1 * 1.40 + w2 * 0.55 + w3 * 0.22 + w4 * 0.62
          sy = 1 - w1 * 0.95 + w2 * 0.42 - w3 * 0.18 - w4 * 0.48
          sz = 1 + w1 * 1.18 - w2 * 0.36 + w3 * 0.28 + w4 * 0.40
        } else if (wAge < 1.5) {
          // Tumble wobble: gooey sloshing, 3 waves, fires down to low speed
          const sf = Math.min(curSpd / 12, 1)
          const amp = 0.50 + sf * 0.24
          const w1 = amp * Math.exp(-3.2 * wAge) * Math.sin(10.5 * wAge + Math.PI * 0.3)
          const w2 = amp * 0.50 * Math.exp(-2.5 * wAge) * Math.sin(17.0 * wAge)
          const w3 = amp * 0.28 * Math.exp(-2.0 * wAge) * Math.sin(4.5 * wAge + Math.PI * 0.8)
          sx = 1 + w1 + w2 * 0.35 + w3 * 0.58
          sy = 1 - w1 * 0.82 + w2 * 0.22 - w3 * 0.45
          sz = 1 + w1 * 0.92 - w2 * 0.28 + w3 * 0.38
        } else if (bAge < 1.9) {
          // Placement: three-wave squash with slow gooey recovery
          const w1 = 0.68 * Math.exp(-3.5 * bAge) * Math.sin(11.0 * bAge)
          const w2 = 0.34 * Math.exp(-2.8 * bAge) * Math.sin(18.5 * bAge + 0.9)
          const w3 = 0.18 * Math.exp(-2.2 * bAge) * Math.sin(7.0 * bAge + Math.PI * 0.5)
          sx = 1 + w1 + w2 * 0.30 + w3 * 0.48
          sy = 1 - w1 * 0.88 - w2 * 0.22 - w3 * 0.38
          sz = 1 + w1 * 0.92 + w2 * 0.42 + w3 * 0.30
        } else {
          if (birthTime.current !== null) { birthTime.current = null }
          // Idle: three-frequency jelly breathing — very alive, very gooey
          const phX = block.id * 0.7; const phZ = block.id * 1.3
          const ix = 0.038 * Math.sin(t * 2.7 + phX) + 0.016 * Math.sin(t * 6.3 + phX * 0.5) + 0.008 * Math.sin(t * 11.2 + phX * 0.3)
          const iz = 0.030 * Math.sin(t * 3.3 + phZ) + 0.013 * Math.sin(t * 7.5 + phZ * 0.6) + 0.006 * Math.sin(t * 12.8 + phZ * 0.4)
          sx = 1 + ix; sy = 1 - (ix + iz) * 0.74; sz = 1 + iz
        }

        meshRef.current.scale.set(
          Math.max(0.42, Math.min(1.82, sx)),
          Math.max(0.42, Math.min(1.82, sy)),
          Math.max(0.42, Math.min(1.82, sz))
        )
      } else if (block.color === 'spaghetti') {
        // Velocity-driven wobble: fires while block is actively tumbling/falling
        let curSpd = 0
        if (rb.current) {
          const rv = rb.current.linvel()
          const ra = rb.current.angvel()
          curSpd = Math.sqrt(rv.x*rv.x + rv.y*rv.y + rv.z*rv.z)
                 + Math.sqrt(ra.x*ra.x + ra.y*ra.y + ra.z*ra.z) * 0.4
          if (curSpd > 0.6) spaghettiWobbleRef.current = t
        }

        const kAge = spaghettiKnockRef.current !== null ? t - spaghettiKnockRef.current : 999
        const wAge = spaghettiWobbleRef.current !== null ? t - spaghettiWobbleRef.current : 999
        const bAge = birthTime.current !== null ? t - birthTime.current : 999
        let sx = 1, sy = 1, sz = 1

        if (kAge < 2.8) {
          // Knock: 4 waves, extremely floppy, chaotic per-axis — noodles everywhere
          const w1 = 0.82 * Math.exp(-1.6 * kAge) * Math.sin(6.5 * kAge)
          const w2 = 0.46 * Math.exp(-1.4 * kAge) * Math.sin(10.0 * kAge + Math.PI * 0.65)
          const w3 = 0.26 * Math.exp(-1.2 * kAge) * Math.sin(14.0 * kAge + Math.PI * 1.3)
          const w4 = 0.16 * Math.exp(-1.0 * kAge) * Math.sin(4.0 * kAge + Math.PI * 0.4)
          sx = 1 + w1 * 1.55 + w2 * 0.35 + w3 * 0.15 + w4 * 0.68
          sy = 1 - w1 * 0.78 + w2 * 0.60 - w3 * 0.34 - w4 * 0.52
          sz = 1 - w1 * 0.48 - w2 * 0.54 + w3 * 0.46 + w4 * 0.38
        } else if (wAge < 1.6) {
          // Tumble: noodles slosh around, 3 waves + low-freq slap
          const sf = Math.min(curSpd / 10, 1)
          const amp = 0.55 + sf * 0.26
          const w1 = amp * Math.exp(-2.8 * wAge) * Math.sin(7.5 * wAge + Math.PI * 0.2)
          const w2 = amp * 0.58 * Math.exp(-2.2 * wAge) * Math.sin(12.0 * wAge + Math.PI * 0.75)
          const w3 = amp * 0.32 * Math.exp(-1.8 * wAge) * Math.sin(4.5 * wAge + Math.PI * 1.1)
          sx = 1 + w1 + w2 * 0.32 + w3 * 0.58
          sy = 1 - w1 * 0.62 + w2 * 0.40 - w3 * 0.48
          sz = 1 - w1 * 0.24 - w2 * 0.52 + w3 * 0.42
        } else if (bAge < 2.0) {
          // Placement: heavy plop, 3 waves, painfully slow noodle recovery
          const w1 = 0.74 * Math.exp(-3.0 * bAge) * Math.sin(7.0 * bAge)
          const w2 = 0.36 * Math.exp(-2.4 * bAge) * Math.sin(12.0 * bAge + 0.8)
          const w3 = 0.20 * Math.exp(-1.8 * bAge) * Math.sin(4.5 * bAge + 1.5)
          sx = 1 + w1 + w2 * 0.25 + w3 * 0.55
          sy = 1 - w1 * 0.84 - w2 * 0.40 - w3 * 0.44
          sz = 1 + w1 * 0.82 + w2 * 0.48 + w3 * 0.38
        } else {
          if (birthTime.current !== null) { birthTime.current = null }
          // Idle: very visible noodle sway — three frequencies, feels ridiculous
          const phX = block.id * 0.7; const phZ = block.id * 1.3
          const ix = 0.046 * Math.sin(t * 1.9 + phX) + 0.020 * Math.sin(t * 4.8 + phX * 0.6) + 0.009 * Math.sin(t * 9.3 + phX * 0.3)
          const iz = 0.038 * Math.sin(t * 2.5 + phZ) + 0.016 * Math.sin(t * 5.7 + phZ * 0.7) + 0.007 * Math.sin(t * 10.1 + phZ * 0.4)
          sx = 1 + ix; sy = 1 - (ix + iz) * 0.80; sz = 1 + iz
        }

        meshRef.current.scale.set(
          Math.max(0.38, Math.min(1.88, sx)),
          Math.max(0.38, Math.min(1.88, sy)),
          Math.max(0.38, Math.min(1.88, sz))
        )
      } else if (birthTime.current !== null) {
        const age = t - birthTime.current
        if (age > 0.4) { meshRef.current.scale.setScalar(1); birthTime.current = null }
        else { meshRef.current.scale.setScalar(1 + 0.22 * Math.exp(-7 * age) * Math.cos(12 * age)) }
      } else if (block.isFixed) {
        // Very subtle breathing ±1.2%, phase-offset per block id so they're not in sync
        meshRef.current.scale.setScalar(1 + Math.sin(t * 1.8 + block.id * 0.7) * 0.012)
      }
    }

    // Motion trail: emit afterimage particles when block is flying fast
    if (rb.current) {
      const rv = rb.current.linvel()
      const spd = Math.sqrt(rv.x*rv.x + rv.y*rv.y + rv.z*rv.z)
      if (spd > 2.2 && t - lastTrailRef.current > 0.048) {
        lastTrailRef.current = t
        const rp = rb.current.translation()
        if (rp.y > -4) {
          const sf = Math.min(spd / 10, 1)
          if (block.color === 'rainbow') {
            _col.setHSL((t * 0.55) % 1, 1.0, 0.72)
            _emit(rp.x, rp.y, rp.z, _col.r, _col.g, _col.b, 0.9 + sf * 0.9, 0.26, 0.40 + sf * 0.22, t)
          } else if (block.color === 'glitter') {
            _col.setHSL((t * 0.35 + Math.sin(t * 5) * 0.2) % 1, 0.6, 0.88)
            _emit(rp.x, rp.y, rp.z, _col.r, _col.g, _col.b, 0.9 + sf * 0.9, 0.26, 0.40 + sf * 0.22, t)
          } else if (block.color === 'spaghetti') {
            // Sauce flying: pasta-yellow at slow speeds, tomato-red at high speeds
            _col.setRGB(0.74 + sf * 0.24, 0.44 - sf * 0.20, 0.02)
            _emit(rp.x, rp.y, rp.z, _col.r, _col.g, _col.b, 0.85 + sf * 0.8, 0.26, 0.34 + sf * 0.20, t)
          } else {
            _col.set(block.color)
            _emit(rp.x, rp.y, rp.z,
              Math.min(1, _col.r * 1.5 + 0.08),
              Math.min(1, _col.g * 1.5 + 0.08),
              Math.min(1, _col.b * 1.5 + 0.08),
              0.7 + sf * 0.8, 0.26, 0.30 + sf * 0.18, t)
          }
        }
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
      if (block.color === '#7CFF00') jellyKnockRef.current = clock.getElapsedTime()
      if (block.color === 'spaghetti') spaghettiKnockRef.current = clock.getElapsedTime()
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

  const isJelly = block.color === '#7CFF00'
  const isSpaghetti = block.color === 'spaghetti'

  return (
    <RigidBody
      ref={rb}
      position={block.position}
      type={block.isFixed ? 'fixed' : 'dynamic'}
      colliders={false}
      restitution={isJelly ? 0.80 : isSpaghetti ? 0.22 : 0.3}
      friction={isJelly ? 0.40 : isSpaghetti ? 0.28 : 0.8}
      linearDamping={isJelly ? 0.03 : isSpaghetti ? 0.014 : 0.1}
      angularDamping={isJelly ? 0.03 : isSpaghetti ? 0.010 : 0.1}
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
          : block.color === '#C0C0C0'
          ? <SilverMaterial isFixed={block.isFixed} />
          : block.color === '#7DF9FF'
          ? <IceCyanMaterial isFixed={block.isFixed} />
          : block.color === '#7CFF00'
          ? <JellyMaterial isFixed={block.isFixed} />
          : block.color === 'spaghetti'
          ? <SpaghettiMaterial isFixed={block.isFixed} />
          : block.isFixed
          ? <FixedBlockMaterial color={block.color} />
          : <meshStandardMaterial color={block.color} roughness={0.10} metalness={0.08} envMapIntensity={1.4} />}
        {/* Edges live inside the mesh so they inherit wobble scale on jelly/spaghetti */}
        <lineSegments geometry={EDGES_GEO}>
          <lineBasicMaterial color="#000000" transparent opacity={0.07} />
        </lineSegments>
        <lineSegments geometry={EDGES_GEO} scale={1.003}>
          <lineBasicMaterial color="#ffffff" transparent opacity={0.13} depthWrite={false} />
        </lineSegments>
        {/* Placement white pop + knock orange burst overlay */}
        <mesh geometry={BOX_GEO} scale={1.02} raycast={() => null}>
          <meshBasicMaterial ref={flashMatRef} color="#ffffff" transparent opacity={0} depthWrite={false} />
        </mesh>
      </mesh>
    </RigidBody>
  )
}
