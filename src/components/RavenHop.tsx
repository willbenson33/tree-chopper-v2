import { useEffect, useRef, useState } from 'react'
import './RavenHop.css'

// ----- World constants (logical pixel-art units) -----
const WORLD_W = 480
const WORLD_H = 270
const ISLAND_TOP = 182 // reference grass surface y (per-island heights vary around this)
const WATER_Y = 202 // top of water (low enough that a tall island still sits above it)
const BASE_X = 138 // tree base x on left island
const SWIPE_THRESHOLD = 26 // px of pointer travel per chop
const CHOPS_TO_BREAK = 1 // hits needed in the SAME spot to fell the tree
const FOLIAGE_PAD = 22 // top of the trunk reserved for the canopy (not choppable)
const MIN_ZOOM = 0.35
const MAX_ZOOM = 2.5
const DEFAULT_ZOOM = 0.42 // frames the whole (very tall) tree + the gap; zoom in to chop precisely
const PAN_SPEED = 300 // world units / second while a d-pad button is held

type Phase = 'title' | 'chopping' | 'falling' | 'landed' | 'plunging' | 'hopping' | 'result'

interface Leaf {
  x: number
  y: number
  vx: number
  vy: number
  life: number
  color: string
  sway: number
}

interface Confetti {
  x: number
  y: number
  vx: number
  vy: number
  rot: number
  vrot: number
  color: string
  size: number
}

// Wood chips kicked out of the cut where the user is chopping.
interface Chip {
  x: number
  y: number
  vx: number
  vy: number
  rot: number
  vrot: number
  life: number
  size: number
  color: string
}

// A cluster of chops at roughly one height on the trunk.
interface ChopSpot {
  y: number // world-y center of the cut
  count: number // hits landed here
}

// Purely decorative background tree — scenery on the islands, NOT choppable.
interface DecoTree {
  x: number // world-x of the trunk base
  side: 'left' | 'right' // which island it stands on (sets its ground height)
  h: number // trunk height
  w: number // trunk width
  depth: number // 0 = foreground, 1 = far away (smaller + hazier for depth)
}

// Water droplets / dust kicked up when a missed log hits the surface.
interface Splash {
  x: number
  y: number
  vx: number
  vy: number
  life: number
  size: number
  color: string
}

// A felled log that has DETACHED from the stump and is free-falling. Modelled as
// two Verlet particles (the cut "butt" end A and the crown "tip" end B) joined by
// a rigid rod, so it tumbles, splashes, and comes to rest against the landmasses.
interface LogBody {
  ax: number; ay: number; apx: number; apy: number // butt (cut end) pos + prev
  bx: number; by: number; bpx: number; bpy: number // tip (crown end) pos + prev
  len: number
  settle: number // seconds spent at rest
  t: number // seconds since detaching (hard timeout)
  splashedA: boolean
  splashedB: boolean
}

// One of the celebratory ravens that hops across the bridge on a PERFECT chop.
interface Raven {
  x: number
  y: number
  hopFrom: number
  hopTo: number
  hopFromY: number
  hopToY: number
  hopT: number
  hopDur: number
  delay: number // wait before it starts hopping (staggers the flock)
  done: boolean
}

interface GameData {
  phase: Phase
  t: number // total time, seconds
  // tree
  treeHeight: number
  treeWidth: number
  chopsNeeded: number
  chopsDone: number
  spots: ChopSpot[] // clusters of chops grouped by height
  aimY: number // current pointer height on the trunk (world y), for the aim marker
  aimOn: boolean // is the pointer currently over the trunk (a valid chop target)?
  breakH: number // height above ground (px) where the trunk snaps; 0 until felled
  angle: number // 0 = upright, grows toward PI/2 as it falls
  angVel: number
  fallDir: 1 | -1 // +1 fall right (toward gap), -1 fall left
  // pivot the felled segment rotates around (the stump cut)
  segX: number
  segY: number
  logBody: LogBody | null // set once the log detaches and free-falls (plunge)
  splashed: boolean // has the plunging log hit the surface yet
  shakeT: number
  shakeDir: number
  // world layout
  rightEdge: number // left edge x of the right island
  leftTop: number // grass surface y of the left (tree) island
  rightTop: number // grass surface y of the right (target) island
  decoTrees: DecoTree[] // non-choppable scenery trees on both islands
  // particles
  leaves: Leaf[]
  confetti: Confetti[]
  chips: Chip[]
  splashes: Splash[]
  // raven
  ravenX: number
  ravenY: number
  ravenBobT: number
  hopFrom: number
  hopTo: number
  hopFromY: number
  hopToY: number
  hopT: number
  hopDur: number
  ravenFacing: number
  // camera
  camZoom: number
  camFx: number
  camFy: number
  panX: number // d-pad pan offset from the tree focus
  panY: number
  // outcome
  score: number
  success: boolean
  perfect: boolean // a top-score chop: sunglasses + a whole flock joins the hop
  flock: Raven[] // the celebratory ravens (only populated on a perfect chop)
  landTipX: number
  // fx timers
  cawT: number
  landDelay: number
  resultDelay: number
}

const LEAF_COLORS = ['#3f8f37', '#4faa43', '#2f6f2b', '#c9a227', '#7bb661']
const CONFETTI_COLORS = ['#ff5d5d', '#ffd23f', '#3fb6ff', '#7cff5d', '#ff8ad8', '#ffae42', '#a06bff']
const CHIP_COLORS = ['#8a5a2b', '#6b4423', '#a06a34', '#7d5230', '#caa46a']
const WATER_COLORS = ['#9fd6e8', '#6fb3cf', '#bfeaf5', '#3d86a8']
const DUST_COLORS = ['#8d6e3a', '#a98a52', '#7a5a32', '#6b4f2a']

const SAME_SPOT_TOL = 14 // px: hits within this of a cluster count as "the same spot"
const CHOP_X_TOL = 40 // px: how far either side of the trunk still counts as hitting it

// Clamp a world-y to the choppable band of the trunk (above the roots, below the canopy).
function clampChopY(g: GameData, wy: number) {
  const bottom = g.leftTop // breakH 0 (at the base)
  const top = g.leftTop - (g.treeHeight - FOLIAGE_PAD) // highest choppable spot
  return Math.max(top, Math.min(bottom, wy))
}

// Is a world point actually on the trunk (so a chop should register)? Chopping in
// the empty sky / off the tree does nothing.
function onTrunk(g: GameData, wx: number, wy: number) {
  if (Math.abs(wx - BASE_X) > g.treeWidth / 2 + CHOP_X_TOL) return false
  const top = g.leftTop - (g.treeHeight - FOLIAGE_PAD)
  return wy >= top && wy <= g.leftTop
}

// Burst of wood chips out of the cut at world-height y, biased in the swipe direction.
function spawnChips(g: GameData, y: number, dir: number) {
  const half = g.treeWidth / 2
  const n = Math.round(rand(4, 7))
  for (let i = 0; i < n; i++) {
    const side = Math.random() < 0.5 ? -1 : 1
    g.chips.push({
      x: BASE_X + side * half,
      y: y + rand(-3, 3),
      vx: side * rand(20, 70) + dir * 12,
      vy: rand(-75, -20),
      rot: rand(0, Math.PI * 2),
      vrot: rand(-12, 12),
      life: rand(0.5, 1.0),
      size: rand(2, 4),
      color: CHIP_COLORS[(Math.random() * CHIP_COLORS.length) | 0],
    })
  }
}

// Spray thrown up where a missed log hits the water (or dust on land).
function spawnSplash(g: GameData, x: number, y: number, kind: 'water' | 'land') {
  const palette = kind === 'water' ? WATER_COLORS : DUST_COLORS
  const n = kind === 'water' ? 26 : 18
  for (let i = 0; i < n; i++) {
    g.splashes.push({
      x: x + rand(-14, 14),
      y: y + rand(-2, 2),
      vx: rand(-110, 110),
      vy: rand(-200, -70),
      life: rand(0.4, 0.95),
      size: rand(2, 4),
      color: palette[(Math.random() * palette.length) | 0],
    })
  }
}

// Continuous confetti for the perfect-chop party: rains down over the current view
// (spawned relative to the camera focus so it fills the frame at any zoom).
function rainConfetti(g: GameData, n: number) {
  for (let i = 0; i < n; i++) {
    g.confetti.push({
      x: g.camFx + rand(-300, 300),
      y: g.camFy - rand(150, 300), // start above the framed view
      vx: rand(-30, 30),
      vy: rand(40, 120), // drifting downward (gravity adds more)
      rot: rand(0, Math.PI * 2),
      vrot: rand(-6, 6),
      color: CONFETTI_COLORS[(Math.random() * CONFETTI_COLORS.length) | 0],
      size: rand(2, 4),
    })
  }
}

function rand(a: number, b: number) {
  return a + Math.random() * (b - a)
}

const LEFT_CLIFF_X = BASE_X + 26 // right edge of the left island (matches drawIslands)
const LOG_GRAV = 820 // px/s^2 pulling the detached log down
const LOG_AIR = 0.992 // velocity retained each step in the air

// Surface height under a given x: left island, the water in the gap, or right island.
// The right island uses the grass top (top - 6) so the foliage rests flush on the
// visible green surface rather than sinking into the dirt beneath it.
function groundYAt(g: GameData, x: number) {
  if (x <= LEFT_CLIFF_X) return g.leftTop
  if (x >= g.rightEdge) return g.rightTop - 6
  return WATER_Y
}

// Verlet step for one detached-log end, then resolve it against whatever surface
// sits beneath it (kills downward speed, adds friction, kicks up a splash/dust).
function collideLogEnd(g: GameData, lb: LogBody, end: 'a' | 'b', radius: number) {
  const x = end === 'a' ? lb.ax : lb.bx
  const y = end === 'a' ? lb.ay : lb.by
  // A successful chop means the green's leading edge reaches the far bank, so rest
  // the CROWN on the right island — its solid canopy catches the edge and holds the
  // log up. Without this the bare trunk tip can settle just short of the edge (over
  // water) even on a ~100 landing, and the whole tree would sink instead of bridge.
  let gx = x
  if (end === 'b' && g.success) gx = g.rightEdge
  const gy = groundYAt(g, gx)
  const onWater = gx > LEFT_CLIFF_X && gx < g.rightEdge
  // Splash/dust the instant this end first breaks the surface.
  const already = end === 'a' ? lb.splashedA : lb.splashedB
  if (!already && y >= gy) {
    spawnSplash(g, x, gy, onWater ? 'water' : 'land')
    g.splashed = true
    if (end === 'a') lb.splashedA = true
    else lb.splashedB = true
  }
  // Over water there's no surface support: the end sinks THROUGH the waterline and
  // keeps going until it reaches a hidden lakebed well below the surface, so the
  // whole tree vanishes underwater (occluded by the foreground water) and settles
  // down there before the result shows. On land the solid body (radius — canopy at
  // the crown, trunk half-thickness at the butt) rests ON TOP instead of clipping.
  if (onWater) {
    const bed = WATER_Y + 80 // lakebed depth, hidden behind the front water
    if (y <= bed) return
    const wpx = end === 'a' ? lb.apx : lb.bpx
    const wnewPx = x - (x - wpx) * 0.4 // water drags the sideways speed down
    if (end === 'a') {
      lb.ay = bed
      lb.apy = bed
      lb.apx = wnewPx
    } else {
      lb.by = bed
      lb.bpy = bed
      lb.bpx = wnewPx
    }
    return
  }
  const rest = gy - radius
  if (y <= rest) return
  const px_ = end === 'a' ? lb.apx : lb.bpx
  const newPx = x - (x - px_) * 0.65 // ground friction on the sideways speed
  if (end === 'a') {
    lb.ay = rest
    lb.apy = rest
    lb.apx = newPx
  } else {
    lb.by = rest
    lb.bpy = rest
    lb.bpx = newPx
  }
}

function stepLog(g: GameData, dt: number) {
  const lb = g.logBody!
  lb.t += dt
  const h = Math.min(dt, 1 / 45) // clamp for a stable integration
  const g2 = LOG_GRAV * h * h
  // integrate both ends (Verlet)
  let nx = lb.ax + (lb.ax - lb.apx) * LOG_AIR
  let ny = lb.ay + (lb.ay - lb.apy) * LOG_AIR + g2
  lb.apx = lb.ax
  lb.apy = lb.ay
  lb.ax = nx
  lb.ay = ny
  nx = lb.bx + (lb.bx - lb.bpx) * LOG_AIR
  ny = lb.by + (lb.by - lb.bpy) * LOG_AIR + g2
  lb.bpx = lb.bx
  lb.bpy = lb.by
  lb.bx = nx
  lb.by = ny
  // rigid rod + ground collisions, relaxed over a few iterations
  for (let i = 0; i < 6; i++) {
    const dx = lb.bx - lb.ax
    const dy = lb.by - lb.ay
    const d = Math.hypot(dx, dy) || 1
    const diff = ((d - lb.len) / d) * 0.5
    const ox = dx * diff
    const oy = dy * diff
    lb.ax += ox
    lb.ay += oy
    lb.bx -= ox
    lb.by -= oy
    collideLogEnd(g, lb, 'a', g.treeWidth * 0.5) // butt: trunk half-thickness
    collideLogEnd(g, lb, 'b', foliageRadius(g.treeWidth)) // crown: solid canopy
  }
  // Settle detection by actual SPEED (displacement / step time), so it's independent
  // of the slow-motion time scaling. Measuring raw per-step displacement would read
  // a slowed-down log as "stopped" while it's still visibly drifting onto the land,
  // and the result screen / raven hop would fire before the tree actually rests.
  const va = Math.hypot(lb.ax - lb.apx, lb.ay - lb.apy) / h
  const vb = Math.hypot(lb.bx - lb.bpx, lb.by - lb.bpy) / h
  if (va < 15 && vb < 15) lb.settle += dt
  else lb.settle = 0
}

// Build a scatter of decorative trees across both islands, with varying height,
// width and depth. Drawn behind the choppable tree, so they never block a chop.
function makeDecoTrees(rightEdge: number): DecoTree[] {
  const trees: DecoTree[] = []
  const add = (side: 'left' | 'right', x: number) => {
    const depth = Math.random() // far trees read smaller + hazier
    trees.push({
      x,
      side,
      h: rand(110, 320) * (1 - depth * 0.45),
      w: rand(9, 20) * (1 - depth * 0.3),
      depth,
    })
  }
  // left island: scattered to the left of the choppable tree (keeps clear of BASE_X)
  const nLeft = Math.round(rand(8, 12))
  for (let i = 0; i < nLeft; i++) add('left', rand(-300, 74))
  // right island: scattered across the landing island
  const nRight = Math.round(rand(9, 13))
  for (let i = 0; i < nRight; i++) add('right', rand(rightEdge + 44, rightEdge + 680))
  // painter's order: draw the far (hazy) trees first so nearer ones overlap them
  trees.sort((a, b) => b.depth - a.depth)
  return trees
}

function makeGame(): GameData {
  // tree width drives the number of chops (3..10)
  const treeWidth = Math.round(rand(16, 32))
  const chopsNeeded = Math.max(3, Math.min(10, Math.round(((treeWidth - 12) / 18) * 7 + 3)))
  // ~3x taller than before; the landing gap scales with this (see rightEdge below)
  const treeHeight = Math.round(rand(432, 504))
  // Varying island heights, centered on the reference surface. The left island
  // carries the tree + raven; the right is the landing target.
  const leftTop = Math.round(ISLAND_TOP + rand(-10, 4))
  const rightTop = Math.round(ISLAND_TOP + rand(-26, 10))

  const landTipX = BASE_X + treeHeight // x the tip reaches when laid flat (cut at the base)

  // `slack` = how far the full-length trunk would overshoot the far edge. We keep
  // it strictly POSITIVE so the tree is ALWAYS taller than the gap (base->far
  // shore = treeHeight - slack < treeHeight): a low enough cut can always bridge.
  // Chopping too high simply leaves the tip short. Slack also drives scoring —
  // breaking so the tip just kisses the edge scores best; lots of leftover trunk
  // on the island docks points.
  // Bigger, more varied slack => the gap is a smaller and more random fraction of
  // the trunk. gap = treeHeight - slack, so this spans ~55%–88% of the tree.
  const minSlack = treeHeight * 0.12
  const maxSlack = treeHeight * 0.45
  const slack = rand(minSlack, maxSlack)
  const rightEdge = landTipX - slack

  return {
    phase: 'title',
    t: 0,
    treeHeight,
    treeWidth,
    chopsNeeded,
    chopsDone: 0,
    spots: [],
    aimY: leftTop - Math.round(treeHeight * 0.18),
    aimOn: false,
    breakH: 0,
    angle: 0,
    angVel: 0,
    fallDir: 1,
    segX: BASE_X,
    segY: leftTop,
    logBody: null,
    splashed: false,
    shakeT: 0,
    shakeDir: 0,
    rightEdge,
    leftTop,
    rightTop,
    decoTrees: makeDecoTrees(rightEdge),
    leaves: [],
    confetti: [],
    chips: [],
    splashes: [],
    ravenX: BASE_X - 26,
    ravenY: leftTop,
    ravenBobT: 0,
    hopFrom: 0,
    hopTo: 0,
    hopFromY: leftTop,
    hopToY: leftTop,
    hopT: 0,
    hopDur: 0.5,
    ravenFacing: 1,
    camZoom: DEFAULT_ZOOM,
    camFx: (BASE_X + 26 + rightEdge) / 2, // center the gap by default
    camFy: leftTop - treeHeight * 0.5,
    panX: 0,
    panY: 0,
    score: 0,
    success: false,
    perfect: false,
    flock: [],
    landTipX,
    cawT: 0,
    landDelay: 0,
    resultDelay: 0,
  }
}

export default function RavenHop() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const gameRef = useRef<GameData>(makeGame())
  const zoomRef = useRef(DEFAULT_ZOOM)
  const [zoom, setZoom] = useState(DEFAULT_ZOOM)
  const panDirRef = useRef({ x: 0, y: 0 }) // active d-pad direction (-1/0/1)
  const [phase, setPhase] = useState<Phase>('title')
  const [chopInfo, setChopInfo] = useState({ done: 0, needed: 0 })
  const [showCaw, setShowCaw] = useState(false)
  const [result, setResult] = useState<{ score: number; success: boolean } | null>(null)

  zoomRef.current = zoom

  // Map a viewport (client) point to world coordinates using the live camera.
  function clientToWorld(clientX: number, clientY: number) {
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    const cw = canvas.clientWidth
    const ch = canvas.clientHeight
    const fit = Math.min(cw / WORLD_W, ch / WORLD_H)
    const g = gameRef.current
    const scale = fit * g.camZoom
    const tx = cw / 2 - g.camFx * scale
    const ty = ch / 2 - g.camFy * scale
    return {
      x: (clientX - rect.left - tx) / scale,
      y: (clientY - rect.top - ty) / scale,
    }
  }

  // Screen px per world unit at the current camera zoom (for gesture panning).
  function worldScale() {
    const canvas = canvasRef.current!
    const fit = Math.min(canvas.clientWidth / WORLD_W, canvas.clientHeight / WORLD_H)
    return fit * gameRef.current.camZoom
  }

  // Move the camera by a world-space delta (used by pinch-pan), clamped like the d-pad.
  function panBy(dxWorld: number, dyWorld: number) {
    const g = gameRef.current
    const rangeX = g.treeHeight + 80
    const rangeY = g.treeHeight * 0.6
    g.panX = Math.max(-rangeX, Math.min(rangeX, g.panX + dxWorld))
    g.panY = Math.max(-rangeY, Math.min(rangeY, g.panY + dyWorld))
  }

  function setZoomClamped(z: number) {
    const nz = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z))
    zoomRef.current = nz
    setZoom(nz)
  }

  // ----- input: swipe to chop (vertical position picks the spot) -----
  useEffect(() => {
    const canvas = canvasRef.current!
    let dragging = false
    let lastX = 0
    let accum = 0

    const aim = (x: number, y: number) => {
      const g = gameRef.current
      if (g.phase !== 'chopping') return
      const w = clientToWorld(x, y)
      g.aimY = clampChopY(g, w.y)
      g.aimOn = onTrunk(g, w.x, w.y)
    }
    const start = (x: number, y: number) => {
      const g = gameRef.current
      if (g.phase === 'title') {
        beginGame()
        return
      }
      if (g.phase !== 'chopping') return
      dragging = true
      lastX = x
      accum = 0
      aim(x, y)
    }
    const move = (x: number, y: number) => {
      const g = gameRef.current
      if (g.phase !== 'chopping') return
      aim(x, y) // live aim marker, even before the first swipe
      if (!dragging) return
      const w = clientToWorld(x, y)
      // Only the trunk can be chopped — swinging off the tree banks no progress.
      if (!onTrunk(g, w.x, w.y)) {
        lastX = x
        accum = 0
        return
      }
      const dx = x - lastX
      lastX = x
      accum += dx
      while (Math.abs(accum) >= SWIPE_THRESHOLD) {
        const dir = accum > 0 ? 1 : -1
        accum -= dir * SWIPE_THRESHOLD
        registerChop(dir, w.y)
        if (gameRef.current.phase !== 'chopping') break
      }
    }
    const end = () => {
      dragging = false
    }

    // ----- multi-touch: pinch to zoom, two-finger drag to pan -----
    // One finger chops (as before); two fingers do the standard pan/zoom gesture.
    let gesturing = false
    let pinchStartDist = 1
    let pinchStartZoom = DEFAULT_ZOOM
    let lastMidX = 0
    let lastMidY = 0
    const touchDist = (t: TouchList) =>
      Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY)
    const touchMidX = (t: TouchList) => (t[0].clientX + t[1].clientX) / 2
    const touchMidY = (t: TouchList) => (t[0].clientY + t[1].clientY) / 2
    const beginGesture = (t: TouchList) => {
      gesturing = true
      dragging = false // cancel any in-progress chop
      pinchStartDist = touchDist(t) || 1
      pinchStartZoom = zoomRef.current
      lastMidX = touchMidX(t)
      lastMidY = touchMidY(t)
    }

    const onMouseDown = (e: MouseEvent) => start(e.clientX, e.clientY)
    const onMouseMove = (e: MouseEvent) => move(e.clientX, e.clientY)
    const onMouseUp = () => end()
    const onWheel = (e: WheelEvent) => {
      setZoomClamped(zoomRef.current * (e.deltaY < 0 ? 1.12 : 1 / 1.12))
      e.preventDefault()
    }
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length >= 2) {
        beginGesture(e.touches)
        e.preventDefault()
        return
      }
      if (!gesturing && e.touches[0]) start(e.touches[0].clientX, e.touches[0].clientY)
    }
    const onTouchMove = (e: TouchEvent) => {
      if (gesturing && e.touches.length >= 2) {
        // pinch -> zoom about the current focus
        setZoomClamped(pinchStartZoom * (touchDist(e.touches) / pinchStartDist))
        // two-finger drag -> pan (move the world with your fingers)
        const mx = touchMidX(e.touches)
        const my = touchMidY(e.touches)
        const scale = worldScale()
        panBy(-(mx - lastMidX) / scale, -(my - lastMidY) / scale)
        lastMidX = mx
        lastMidY = my
        e.preventDefault()
        return
      }
      if (!gesturing && e.touches[0]) move(e.touches[0].clientX, e.touches[0].clientY)
      e.preventDefault()
    }
    const onTouchEnd = (e: TouchEvent) => {
      // stay in gesture mode until every finger lifts, so a leftover finger
      // doesn't suddenly start chopping
      if (e.touches.length === 0) {
        gesturing = false
        end()
      }
    }

    canvas.addEventListener('mousedown', onMouseDown)
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('touchstart', onTouchStart, { passive: false })
    canvas.addEventListener('touchmove', onTouchMove, { passive: false })
    canvas.addEventListener('touchend', onTouchEnd)
    canvas.addEventListener('touchcancel', onTouchEnd)

    return () => {
      canvas.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('touchstart', onTouchStart)
      canvas.removeEventListener('touchmove', onTouchMove)
      canvas.removeEventListener('touchend', onTouchEnd)
      canvas.removeEventListener('touchcancel', onTouchEnd)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function beginGame() {
    const g = makeGame()
    g.phase = 'chopping'
    gameRef.current = g
    setPhase('chopping')
    setResult(null)
    setShowCaw(false)
    setChopInfo({ done: 0, needed: CHOPS_TO_BREAK })
  }

  function registerChop(dir: number, chopY: number) {
    const g = gameRef.current
    if (g.phase !== 'chopping') return

    // Add this hit to the nearest existing cut within tolerance, else start a new
    // one. Grouping by proximity (not a fixed grid) means hits at roughly the same
    // height reliably stack up to fell the tree, even with a little hand jitter.
    const y = clampChopY(g, chopY)
    g.aimY = y
    g.aimOn = true
    let spot = g.spots.find((s) => Math.abs(s.y - y) <= SAME_SPOT_TOL)
    if (!spot) {
      spot = { y, count: 0 }
      g.spots.push(spot)
    }
    spot.count++
    spot.y += (y - spot.y) * 0.3 // ease the cut toward where you're actually hitting
    const count = spot.count

    g.chopsDone++
    g.shakeT = 0.35
    g.shakeDir = -dir

    // wood chips kick out of the cut where the user is chopping
    spawnChips(g, y, dir)
    // every chop jolts a flurry of leaves loose from the canopy
    const topX = BASE_X
    const topY = g.leftTop - g.treeHeight
    const spread = Math.max(28, g.treeWidth * 1.7) // roughly the canopy radius
    const nl = Math.round(rand(34, 52))
    for (let i = 0; i < nl; i++) {
      g.leaves.push({
        x: topX + rand(-spread, spread),
        y: topY + rand(-spread * 0.6, spread * 0.9),
        vx: rand(-12, 12),
        vy: rand(-8, 6),
        life: rand(2.6, 4),
        color: LEAF_COLORS[(Math.random() * LEAF_COLORS.length) | 0],
        sway: rand(0, Math.PI * 2),
      })
    }

    // HUD tracks the most-concentrated spot — that's the one that fells the tree
    let best = 0
    for (const s of g.spots) best = Math.max(best, s.count)
    setChopInfo({ done: Math.min(best, CHOPS_TO_BREAK), needed: CHOPS_TO_BREAK })

    if (count >= CHOPS_TO_BREAK) {
      // enough hits in one spot — it snaps here
      g.breakH = g.leftTop - spot.y
      // the cut becomes the pivot the upper segment rotates around
      g.segX = BASE_X
      g.segY = g.leftTop - g.breakH
      g.splashed = false
      // swipe left (dir -1) -> fall right (+1) and vice versa
      g.fallDir = dir < 0 ? 1 : -1
      g.phase = 'falling'
      g.angVel = 0.25 // gentle initial nudge; it accelerates as it tips over
      setPhase('falling')
    }
  }

  // ----- main loop -----
  useEffect(() => {
    const canvas = canvasRef.current!
    const ctx = canvas.getContext('2d')!
    let raf = 0
    let prev = performance.now()

    const loop = (now: number) => {
      const realDt = Math.min(0.05, (now - prev) / 1000)
      prev = now
      update(realDt)
      render(ctx, canvas)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function update(realDt: number) {
    const g = gameRef.current
    g.t += realDt

    // d-pad pan (only meaningful while lining up a chop)
    const pd = panDirRef.current
    if ((pd.x || pd.y) && (g.phase === 'chopping' || g.phase === 'title')) {
      const rangeX = g.treeHeight + 80 // far enough to peek at the landing island
      const rangeY = g.treeHeight * 0.6
      g.panX = Math.max(-rangeX, Math.min(rangeX, g.panX + pd.x * PAN_SPEED * realDt))
      g.panY = Math.max(-rangeY, Math.min(rangeY, g.panY + pd.y * PAN_SPEED * realDt))
    }

    // slow-motion factor for the dramatic landing
    let dtScale = 1
    let targetZoom = zoomRef.current
    // default: center the gap horizontally and the full tree height vertically,
    // offset by the user's pan. Zoom centers on this point.
    let targetFx = (LEFT_CLIFF_X + g.rightEdge) / 2
    let targetFy = g.leftTop - g.treeHeight * 0.5
    if (g.phase === 'chopping' || g.phase === 'title') {
      targetFx += g.panX
      targetFy += g.panY
    }

    if (g.phase === 'falling') {
      // Pull the camera back to the original framing so the whole tree is in view
      // for the fall (overriding whatever the player zoomed in to while chopping).
      targetZoom = DEFAULT_ZOOM
      targetFx = (LEFT_CLIFF_X + g.rightEdge) / 2
      targetFy = g.leftTop - g.treeHeight * 0.5
      // Gravity-driven tip-over: angular torque grows with sin(angle), so the
      // trunk starts barely moving (the initial nudge tips it past balance) and
      // keeps accelerating as it leans, like a real falling tree. A constant
      // slow-motion factor keeps the whole arc slow and dramatic.
      const SLOW = 0.55 // overall slow-motion playback rate
      const FALL_G = 4.5 // angular gravity strength
      const sdt = realDt * SLOW
      dtScale = SLOW // keep leaves/chips in sync with the slowed fall
      g.angVel += FALL_G * Math.sin(g.angle) * sdt
      g.angle += g.angVel * sdt
      // Shed a TRAIL of leaves from the canopy as it sweeps down: spawn a few each
      // frame at the crown's current (rotating) position; they then fall on their
      // own from wherever they were shed, marking the path of the fall.
      const segLen = g.treeHeight - g.breakH
      const phi = g.angle * g.fallDir
      const cx = g.segX + segLen * Math.sin(phi)
      const cy = g.segY - segLen * Math.cos(phi)
      const cr = foliageRadius(g.treeWidth)
      // Just a light, steady trickle from the canopy as it falls (the big burst
      // already happened when the chop felled it).
      const nTrail = Math.round(rand(0, 2))
      for (let i = 0; i < nTrail; i++) {
        g.leaves.push({
          x: cx + rand(-cr, cr),
          y: cy + rand(-cr, cr),
          vx: rand(-6, 6),
          vy: rand(-4, 4),
          life: rand(2.6, 4.2),
          color: LEAF_COLORS[(Math.random() * LEAF_COLORS.length) | 0],
          sway: rand(0, Math.PI * 2),
        })
      }
      if (g.angle >= Math.PI / 2) {
        g.angle = Math.PI / 2
        land()
      }
    } else if (g.phase === 'landed') {
      targetZoom = DEFAULT_ZOOM
      targetFx = (LEFT_CLIFF_X + g.rightEdge) / 2
      targetFy = g.leftTop - g.treeHeight * 0.5
      g.landDelay -= realDt
      if (g.landDelay <= 0) {
        if (g.success) startHopping()
        else finishResult()
      }
    } else if (g.phase === 'plunging') {
      // the log has detached — free-fall it as a rigid body, colliding with the
      // water and the two landmasses until it settles. Keep the wide framing and
      // ease it down in mild slow-motion for a dramatic plunge.
      const lb = g.logBody!
      stepLog(g, realDt * 0.6)
      targetZoom = DEFAULT_ZOOM
      targetFx = (LEFT_CLIFF_X + g.rightEdge) / 2
      targetFy = g.leftTop - g.treeHeight * 0.5
      // Only wrap up once the log has fully fallen in (sunk to the lakebed and
      // settled), or come to rest on land, or timed out — so the whole tree goes
      // under the water before the result screen appears.
      const fullySunk = lb.ay > WATER_Y + 60 && lb.by > WATER_Y + 60
      if (lb.settle > 0.6 || lb.t > 4 || fullySunk) {
        if (g.success) startHopping()
        else finishResult()
      }
    } else if (g.phase === 'hopping') {
      if (g.perfect) {
        // pull back to frame the whole gap so the streaming flock is all in view
        targetZoom = 0.85
        targetFx = (LEFT_CLIFF_X + g.rightEdge) / 2
        targetFy = g.leftTop - 40
      } else {
        targetZoom = Math.max(zoomRef.current, 1.5)
        targetFx = g.ravenX + 20
        targetFy = g.ravenY - 30
      }
      updateHopping(realDt)
    }

    const simDt = realDt * dtScale

    // camera easing
    const k = Math.min(1, realDt * 5)
    g.camZoom += (targetZoom - g.camZoom) * k
    g.camFx += (targetFx - g.camFx) * k
    g.camFy += (targetFy - g.camFy) * k

    // shake decay
    if (g.shakeT > 0) g.shakeT = Math.max(0, g.shakeT - realDt)

    // leaves
    for (const l of g.leaves) {
      l.vy += 14 * simDt
      l.sway += simDt * 3
      l.x += (l.vx + Math.sin(l.sway) * 10) * simDt
      l.y += l.vy * simDt
      l.life -= simDt
    }
    g.leaves = g.leaves.filter((l) => l.life > 0 && l.y < WATER_Y + 4)

    // wood chips (heavier, shorter-lived than leaves)
    for (const c of g.chips) {
      c.vy += 220 * realDt
      c.x += c.vx * realDt
      c.y += c.vy * realDt
      c.rot += c.vrot * realDt
      c.life -= realDt
    }
    g.chips = g.chips.filter((c) => c.life > 0 && c.y < WATER_Y + 6)

    // splash / dust thrown up by a plunging log
    for (const s of g.splashes) {
      s.vy += 380 * realDt
      s.x += s.vx * realDt
      s.y += s.vy * realDt
      s.life -= realDt
    }
    g.splashes = g.splashes.filter((s) => s.life > 0)

    // confetti
    for (const c of g.confetti) {
      c.vy += 150 * realDt
      c.x += c.vx * realDt
      c.y += c.vy * realDt
      c.rot += c.vrot * realDt
    }
    g.confetti = g.confetti.filter((c) => c.y < WORLD_H + 20)

    // caw flash
    if (g.cawT > 0) {
      g.cawT -= realDt
      if (g.cawT <= 0) setShowCaw(false)
    }

    // ambient raven bob while idle
    if (g.phase === 'chopping' || g.phase === 'title') {
      g.ravenBobT += realDt
    }
  }

  function land() {
    const g = gameRef.current
    g.perfect = false
    // Did the trunk bridge the gap? Only a forward fall whose tip reaches the
    // far island counts; a higher break reaches less far.
    if (g.fallDir === 1) {
      // Reach is measured to the TOP OF THE GREEN: the trunk tip plus the canopy
      // that sticks out past it (the green is solid, so its leading edge is what
      // bridges and what scoring keys off).
      const tipX =
        BASE_X + (g.treeHeight - g.breakH) + foliageRadius(g.treeWidth) * FOLIAGE_REACH
      // deviation of the top of the green from the far edge: + lands past it
      // ("too much tree"), - lands short of it.
      const overshoot = tipX - g.rightEdge
      if (overshoot >= -2) {
        g.success = true
        // Score peaks at 100 when the top of the green lands EXACTLY on the far
        // edge. Deviating either way docks points — overshooting (extra tree past
        // the edge) or landing short both cost the same. The curve is gentle near
        // the sweet spot (small misses barely dock) and only bottoms out at a
        // generous floor for big misses, so it's forgiving rather than brutal.
        const maxDev = g.treeHeight * 0.25 // deviation that bottoms the score out
        const dev = Math.min(1, Math.abs(overshoot) / maxDev)
        g.score = Math.max(15, Math.round(100 - 85 * dev * dev))
        g.perfect = g.score >= 90 // top-tier chop earns the sunglasses + flock party
        // confetti from the bottom
        for (let i = 0; i < 90; i++) {
          g.confetti.push({
            x: rand(0, WORLD_W),
            y: WORLD_H + rand(0, 10),
            vx: rand(-40, 40),
            vy: rand(-260, -150),
            rot: rand(0, Math.PI * 2),
            vrot: rand(-6, 6),
            color: CONFETTI_COLORS[(Math.random() * CONFETTI_COLORS.length) | 0],
            size: rand(2, 4),
          })
        }
        g.cawT = 1.6
        setShowCaw(true)
        // even a clean bridge detaches and settles ACROSS the gap instead of
        // freezing in mid-air — it angles down onto both banks under gravity.
        detachLog()
        return
      }
    }
    // Missed — the log tips off and falls the rest of the way down
    // (into the water across the gap, or onto the left island when it fell back).
    g.success = false
    g.score = 0
    detachLog()
  }

  function detachLog() {
    const g = gameRef.current
    g.phase = 'plunging'
    setPhase('plunging')
    g.splashed = false
    // DETACH from the stump: snapshot the now-horizontal log as two free particles
    // and let gravity take it the rest of the way (into the gap water or onto land).
    const L = g.treeHeight - g.breakH
    const phi = g.angle * g.fallDir // ~ ±PI/2 (horizontal) by the time we plunge
    const ax = g.segX
    const ay = g.segY
    const bx = g.segX + L * Math.sin(phi)
    const by = g.segY - L * Math.cos(phi)
    const dt = 1 / 60
    // the crown carries the swing's downward speed; the butt just drops off the cut
    const tipVy = Math.min(620, Math.abs(g.angVel) * L)
    g.logBody = {
      ax, ay, apx: ax, apy: ay - 6 * dt,
      bx, by, bpx: bx, bpy: by - tipVy * dt,
      len: L,
      settle: 0,
      t: 0,
      splashedA: false,
      splashedB: false,
    }
  }

  function startHopping() {
    const g = gameRef.current
    g.phase = 'hopping'
    setPhase('hopping')
    g.ravenX = BASE_X - 4
    g.ravenY = g.leftTop // starts on the ground beside the stump
    // On a PERFECT chop, a whole flock of (sunglasses-wearing) ravens lines up on
    // the near bank and hops across behind the hero, staggered so they stream over.
    g.flock = []
    if (g.perfect) {
      for (let i = 0; i < 20; i++) {
        const sx = BASE_X - 6 - rand(4, 70) // queued up behind the hero
        g.flock.push({
          x: sx,
          y: g.leftTop,
          hopFrom: sx,
          hopTo: sx, // sentinel: pick a hop on the first step
          hopFromY: g.leftTop,
          hopToY: g.leftTop,
          hopT: 0,
          hopDur: 0.4,
          delay: rand(0, 2.2),
          done: false,
        })
      }
    }
    nextHop()
  }

  // Advance one celebratory flock raven across the bridge (same step logic as the
  // hero, but with its own start delay so the flock streams over rather than clumps).
  function stepFlockRaven(g: GameData, r: Raven, dt: number) {
    if (r.delay > 0) {
      r.delay -= dt
      return
    }
    if (r.done) return
    if (r.hopTo === r.hopFrom) {
      const target = g.rightEdge + 30
      if (r.x >= target - 1) {
        r.done = true
        return
      }
      const step = Math.min(g.treeHeight / 6, target - r.x)
      r.hopFrom = r.x
      r.hopTo = r.x + step
      r.hopFromY = r.y
      r.hopToY = r.hopTo >= g.rightEdge ? g.rightTop : logTopYAt(g, r.hopTo)
      r.hopT = 0
      return
    }
    r.hopT += dt
    const p = Math.min(1, r.hopT / r.hopDur)
    r.x = r.hopFrom + (r.hopTo - r.hopFrom) * p
    const baseY = r.hopFromY + (r.hopToY - r.hopFromY) * p
    r.y = baseY - Math.sin(p * Math.PI) * 14
    if (p >= 1) {
      r.y = r.hopToY
      r.hopFrom = r.hopTo = r.x // trigger the next hop selection next frame
    }
  }

  function nextHop() {
    const g = gameRef.current
    const target = g.rightEdge + 18 // step onto the right island
    if (g.ravenX >= target - 1) {
      // reached the far island — pause, then show the result (stay in 'hopping').
      // A perfect chop lingers so the whole flock can stream across in the confetti.
      g.resultDelay = g.perfect ? 4 : 0.7
      g.hopFrom = g.ravenX
      g.hopTo = g.ravenX // sentinel: no more hops
      return
    }
    const step = Math.min(g.treeHeight / 6, target - g.ravenX)
    g.hopFrom = g.ravenX
    g.hopTo = g.ravenX + step
    // Follow the settled log: each hop lands on the trunk's surface at that x, and
    // the final hop steps up onto the right island.
    g.hopFromY = g.ravenY
    g.hopToY = g.hopTo >= g.rightEdge ? g.rightTop : logTopYAt(g, g.hopTo)
    g.hopT = 0
    g.hopDur = 0.42
  }

  // The surface y of the settled log at world-x (raven walks on top of the trunk).
  function logTopYAt(g: GameData, x: number) {
    const lb = g.logBody
    if (!lb) return g.leftTop - g.breakH
    const dx = lb.bx - lb.ax
    const f = Math.abs(dx) < 1 ? 0 : Math.max(0, Math.min(1, (x - lb.ax) / dx))
    return lb.ay + (lb.by - lb.ay) * f - g.treeWidth * 0.4
  }

  function updateHopping(realDt: number) {
    const g = gameRef.current
    // Perfect chop: stream the flock across and rain confetti the whole time —
    // runs regardless of whether the hero is still hopping or waiting at the end.
    if (g.perfect) {
      for (const r of g.flock) stepFlockRaven(g, r, realDt)
      rainConfetti(g, Math.round(rand(4, 8)))
    }
    // finished all hops: wait out the result delay, then show the score
    if (g.hopTo === g.hopFrom) {
      g.resultDelay -= realDt
      if (g.resultDelay <= 0) finishResult()
      return
    }
    g.hopT += realDt
    const p = Math.min(1, g.hopT / g.hopDur)
    g.ravenX = g.hopFrom + (g.hopTo - g.hopFrom) * p
    const baseY = g.hopFromY + (g.hopToY - g.hopFromY) * p
    const arc = Math.sin(p * Math.PI) * 14
    g.ravenY = baseY - arc
    if (p >= 1) {
      g.ravenY = g.hopToY
      nextHop()
    }
  }

  function finishResult() {
    const g = gameRef.current
    if (g.phase === 'result') return
    g.phase = 'result'
    setPhase('result')
    setResult({ score: g.score, success: g.success })
  }

  // ----- rendering -----
  function render(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement) {
    const g = gameRef.current
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const cw = canvas.clientWidth
    const ch = canvas.clientHeight
    if (canvas.width !== Math.floor(cw * dpr) || canvas.height !== Math.floor(ch * dpr)) {
      canvas.width = Math.floor(cw * dpr)
      canvas.height = Math.floor(ch * dpr)
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.imageSmoothingEnabled = false
    ctx.fillStyle = '#0b0f1a'
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    const fit = Math.min(cw / WORLD_W, ch / WORLD_H)
    const scale = fit * g.camZoom
    const tx = cw / 2 - g.camFx * scale
    const ty = ch / 2 - g.camFy * scale
    ctx.setTransform(scale * dpr, 0, 0, scale * dpr, tx * dpr, ty * dpr)

    // clip-ish: draw sky background larger than world to fill when zoomed
    drawSky(ctx)
    drawIslands(ctx, g)
    drawScoreZones(ctx, g)
    drawDecoTrees(ctx, g)
    drawTree(ctx, g)
    // Water sits IN FRONT of the landmass and the tree: it hides the underwater
    // cliffs and lets a felled log sink out of sight as it drops below the surface.
    drawWater(ctx, g)
    drawLeaves(ctx, g)
    drawChips(ctx, g)
    drawSplashes(ctx, g)
    drawRaven(ctx, g)
    drawConfetti(ctx, g)

    // screen-space overlay (constant size regardless of camera zoom): drawn last
    // because it resets the canvas transform to device pixels.
    drawSwipeHint(ctx, g, scale, tx, ty, dpr)
  }

  return (
    <div className="rh-root">
      <canvas ref={canvasRef} className="rh-canvas" />

      {/* Zoom slider, upper right */}
      <div className="rh-zoom">
        <span className="rh-zoom-label">🔍</span>
        <input
          type="range"
          min={MIN_ZOOM}
          max={MAX_ZOOM}
          step={0.05}
          value={zoom}
          onChange={(e) => setZoom(parseFloat(e.target.value))}
        />
      </div>

      {/* Pan d-pad, under the zoom slider */}
      <div className="rh-dpad">
        <button
          className="rh-dpad-btn up"
          onPointerDown={() => (panDirRef.current = { x: 0, y: -1 })}
          onPointerUp={() => (panDirRef.current = { x: 0, y: 0 })}
          onPointerLeave={() => (panDirRef.current = { x: 0, y: 0 })}
          onPointerCancel={() => (panDirRef.current = { x: 0, y: 0 })}
          aria-label="pan up"
        >
          ▲
        </button>
        <div className="rh-dpad-mid">
          <button
            className="rh-dpad-btn left"
            onPointerDown={() => (panDirRef.current = { x: -1, y: 0 })}
            onPointerUp={() => (panDirRef.current = { x: 0, y: 0 })}
            onPointerLeave={() => (panDirRef.current = { x: 0, y: 0 })}
            onPointerCancel={() => (panDirRef.current = { x: 0, y: 0 })}
            aria-label="pan left"
          >
            ◀
          </button>
          <button
            className="rh-dpad-btn center"
            onPointerDown={() => {
              const g = gameRef.current
              g.panX = 0
              g.panY = 0
            }}
            aria-label="recenter on tree"
          >
            ⊙
          </button>
          <button
            className="rh-dpad-btn right"
            onPointerDown={() => (panDirRef.current = { x: 1, y: 0 })}
            onPointerUp={() => (panDirRef.current = { x: 0, y: 0 })}
            onPointerLeave={() => (panDirRef.current = { x: 0, y: 0 })}
            onPointerCancel={() => (panDirRef.current = { x: 0, y: 0 })}
            aria-label="pan right"
          >
            ▶
          </button>
        </div>
        <button
          className="rh-dpad-btn down"
          onPointerDown={() => (panDirRef.current = { x: 0, y: 1 })}
          onPointerUp={() => (panDirRef.current = { x: 0, y: 0 })}
          onPointerLeave={() => (panDirRef.current = { x: 0, y: 0 })}
          onPointerCancel={() => (panDirRef.current = { x: 0, y: 0 })}
          aria-label="pan down"
        >
          ▼
        </button>
      </div>

      {/* Chop counter / hint */}
      {phase === 'chopping' && (
        <div className="rh-hint">
          <div className="rh-hint-title">CHOP THE SAME SPOT</div>
          <div className="rh-chops">
            {Array.from({ length: chopInfo.needed }).map((_, i) => (
              <span key={i} className={'rh-chip' + (i < chopInfo.done ? ' on' : '')} />
            ))}
          </div>
          <div className="rh-hint-sub">
            swipe ON THE TRUNK · 5 hits in one spot fells it · chop low to reach · final swipe ←
            drops it toward the gap
          </div>
        </div>
      )}

      {/* Title screen */}
      {phase === 'title' && (
        <div className="rh-title" onPointerDown={beginGame}>
          <h1>RAVEN HOP</h1>
          <p>Chop the tree to bridge the gap.</p>
          <p>Aim at one spot &amp; land 5 hits to fell it · chop low to reach.</p>
          <div className="rh-start">TAP TO START</div>
        </div>
      )}

      {/* CAW CAW flash */}
      {showCaw && <div className="rh-caw">CAW CAW</div>}

      {/* Result */}
      {result && <ResultScreen score={result.score} success={result.success} onReplay={beginGame} />}
    </div>
  )
}

// ============ drawing helpers ============
function px(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, c: string) {
  ctx.fillStyle = c
  ctx.fillRect(x, y, w, h)
}

function drawSky(ctx: CanvasRenderingContext2D) {
  // Tall trees + zoomed-out / panned views expose a lot of sky, so fill generously.
  const grad = ctx.createLinearGradient(0, -480, 0, WATER_Y)
  grad.addColorStop(0, '#bfe6f5')
  grad.addColorStop(1, '#eaf8ff')
  ctx.fillStyle = grad
  ctx.fillRect(-700, -700, WORLD_W + 1400, WATER_Y + 700)
  // sun
  px(ctx, 60, 28, 22, 22, '#fff3c4')
  px(ctx, 64, 24, 14, 30, '#fff3c4')
  px(ctx, 56, 32, 30, 14, '#fff3c4')
  // clouds (chunky)
  drawCloud(ctx, 300, 40)
  drawCloud(ctx, 180, 70)
  drawCloud(ctx, 420, 30)
}

function drawCloud(ctx: CanvasRenderingContext2D, x: number, y: number) {
  const c = '#ffffff'
  px(ctx, x, y, 30, 8, c)
  px(ctx, x + 6, y - 6, 20, 8, c)
  px(ctx, x + 14, y - 10, 14, 8, c)
  px(ctx, x - 6, y + 2, 12, 6, '#eef6fb')
}

function drawWater(ctx: CanvasRenderingContext2D, g: GameData) {
  // base water body (wide enough for zoomed-out / panned views)
  px(ctx, -700, WATER_Y, WORLD_W + 1400, WORLD_H - WATER_Y + 200, '#2a6f97')
  const t = g.t
  // gentle bands that drift
  for (let row = 0; row < 7; row++) {
    const yy = WATER_Y + 4 + row * 9
    const shade = row % 2 === 0 ? '#3d86a8' : '#347a9b'
    px(ctx, -700, yy, WORLD_W + 1400, 5, shade)
    // moving highlight dashes
    ctx.fillStyle = '#6fb3cf'
    for (let i = 0; i < 60; i++) {
      const baseX = -300 + i * 22
      const off = Math.sin(t * 1.2 + row * 0.8 + i) * 6
      const w = 8 + Math.sin(t + i) * 2
      ctx.fillRect(baseX + off + (row % 2) * 11, yy + 1, w, 2)
    }
  }
  // wavy surface line
  ctx.fillStyle = '#9fd6e8'
  for (let x = -700; x < WORLD_W + 700; x += 4) {
    const wy = WATER_Y + Math.sin(x * 0.08 + t * 1.6) * 2
    ctx.fillRect(x, wy, 4, 2)
  }
}

function drawIslands(ctx: CanvasRenderingContext2D, g: GameData) {
  // left island (extends off-screen to the left)
  drawIsland(ctx, -600, BASE_X + 26, g.leftTop, true)
  // right island (extends far to the right so the wide gap reads cleanly)
  drawIsland(ctx, g.rightEdge, g.rightEdge + 700, g.rightTop, false)
}

// Coloured landing-zone bands on the right island, shown after the tree falls.
// Green = perfect (≥90), yellow = nice (50–89), red = too much (15–49).
// Bands extend 40 world-px down from the grass top so they're legible at the
// default zoom. A white tick marks where the foliage tip actually landed.
function drawScoreZones(ctx: CanvasRenderingContext2D, g: GameData) {
  if (g.phase === 'title' || g.phase === 'chopping' || g.phase === 'falling') return

  const maxDev = g.treeHeight * 0.25
  // score = 100 - 85·dev² ≥ 90  →  dev ≤ √(10/85)
  const greenEdge = maxDev * Math.sqrt(10 / 85)
  // score ≥ 50  →  dev ≤ √(50/85)
  const yellowEdge = maxDev * Math.sqrt(50 / 85)

  const grassTop = g.rightTop - 6  // top of the grass strip (matches drawIsland)
  const zoneH = 40                  // tall enough to be visible at 0.42× zoom

  // Main colour fills — drawn over the grass+dirt surface of the right island
  ctx.globalAlpha = 0.72
  px(ctx, g.rightEdge + yellowEdge, grassTop, maxDev - yellowEdge, zoneH, '#cc2222')
  px(ctx, g.rightEdge + greenEdge,  grassTop, yellowEdge - greenEdge, zoneH, '#c9900a')
  px(ctx, g.rightEdge,              grassTop, greenEdge,              zoneH, '#1f9e30')
  ctx.globalAlpha = 1

  // Bright 2 px rim along the top edge of each zone for crisp contrast
  px(ctx, g.rightEdge + yellowEdge, grassTop, maxDev - yellowEdge, 2, '#ff5555')
  px(ctx, g.rightEdge + greenEdge,  grassTop, yellowEdge - greenEdge, 2, '#ffee22')
  px(ctx, g.rightEdge,              grassTop, greenEdge,              2, '#55ff66')

  // 1 px dark dividers between zones
  px(ctx, g.rightEdge + greenEdge  - 1, grassTop, 2, zoneH, '#000000')
  px(ctx, g.rightEdge + yellowEdge - 1, grassTop, 2, zoneH, '#000000')

  // White tick at the actual foliage-tip landing position on a successful bridge
  if (g.success && g.breakH > 0) {
    const tipX =
      BASE_X + (g.treeHeight - g.breakH) + foliageRadius(g.treeWidth) * FOLIAGE_REACH
    ctx.globalAlpha = 0.9
    px(ctx, tipX - 1, grassTop - 4, 3, zoneH + 8, '#ffffff')
    ctx.globalAlpha = 1
  }
}

function drawIsland(ctx: CanvasRenderingContext2D, left: number, right: number, top: number, isLeft: boolean) {
  const w = right - left
  // dirt body
  px(ctx, left, top, w, WORLD_H - top + 40, '#7a5a32')
  px(ctx, left, top, w, 26, '#8d6e3a')
  // dirt speckles
  ctx.fillStyle = '#6b4f2a'
  for (let i = 0; i < w; i += 14) {
    px(ctx, left + i + (isLeft ? 4 : 8), top + 18 + ((i % 28) ? 0 : 6), 3, 3, '#6b4f2a')
    px(ctx, left + i + 10, top + 34, 4, 3, '#6b4f2a')
  }
  // grass top
  px(ctx, left, top - 6, w, 8, '#5fae46')
  px(ctx, left, top - 6, w, 3, '#74c455')
  // grass tufts on the inner edge
  const edge = isLeft ? right : left
  const dir = isLeft ? -1 : 1
  for (let i = 0; i < 5; i++) {
    px(ctx, edge + dir * (i * 4) - (isLeft ? 4 : 0), top - 8 - (i % 2), 3, 4, '#74c455')
  }
}

// Background scenery: the non-choppable trees on both islands. Far trees are
// faded toward the sky (atmospheric haze) so the scene reads with depth.
function drawDecoTrees(ctx: CanvasRenderingContext2D, g: GameData) {
  for (const tr of g.decoTrees) {
    const top = tr.side === 'left' ? g.leftTop : g.rightTop
    ctx.save()
    ctx.globalAlpha = 1 - tr.depth * 0.5
    ctx.translate(tr.x, top)
    drawTrunk(ctx, tr.w, tr.h, true)
    drawFoliage(ctx, 0, -tr.h, tr.w)
    ctx.restore()
  }
  ctx.globalAlpha = 1
}

function drawTree(ctx: CanvasRenderingContext2D, g: GameData) {
  const baseX = BASE_X
  const baseY = g.leftTop
  const tw = g.treeWidth
  const th = g.treeHeight
  const felled = g.breakH > 0 && g.phase !== 'chopping' && g.phase !== 'title'

  ctx.save()
  ctx.translate(baseX, baseY)

  // shake while chopping
  if (g.shakeT > 0 && g.phase === 'chopping') {
    const amp = (g.shakeT / 0.35) * 3
    const s = Math.sin(g.t * 60) * amp * g.shakeDir
    ctx.translate(s, 0)
    ctx.rotate((s / 200) * 0.6)
  }

  if (!felled) {
    // whole tree still standing
    drawTrunk(ctx, tw, th, true)
    drawNotches(ctx, g)
    drawFoliage(ctx, 0, -th, tw)
  } else {
    const bh = g.breakH
    const half = tw / 2
    // the stump that stays rooted on the left island
    drawTrunk(ctx, tw, bh, true)
    drawNotches(ctx, g)
    px(ctx, -half, -bh - 2, tw, 3, '#caa46a') // pale cut face on the stump
  }

  ctx.restore()

  // the felled segment: rotates around its pivot, which is the stump cut while
  // bridging but free-falls (g.segX/g.segY) once it misses and plunges.
  if (felled) {
    const half = tw / 2
    const segLen = th - g.breakH
    ctx.save()
    if (g.logBody) {
      // detached free-falling log: butt at A, crown at B
      const lb = g.logBody
      const ang = Math.atan2(lb.by - lb.ay, lb.bx - lb.ax) + Math.PI / 2
      ctx.translate(lb.ax, lb.ay)
      ctx.rotate(ang)
    } else {
      // still hinged at the stump cut, tipping over
      ctx.translate(g.segX, g.segY)
      ctx.rotate(g.angle * g.fallDir)
    }
    drawTrunk(ctx, tw, segLen, false)
    px(ctx, -half, -2, tw, 3, '#caa46a') // matching cut face on the fallen piece
    drawFoliage(ctx, 0, -segLen, tw)
    ctx.restore()
  }

  // live aim marker: a chevron pointing at the spot you'd chop — yellow when the
  // pointer is on the trunk (a valid hit), red when it's off the tree.
  if (g.phase === 'chopping') {
    ctx.save()
    ctx.translate(baseX, baseY)
    const half = tw / 2
    const ay = g.aimY - baseY
    const col = g.aimOn ? '#ffe14d' : '#ff6b6b'
    ctx.globalAlpha = g.aimOn ? 0.6 + 0.4 * Math.sin(g.t * 8) : 0.45
    px(ctx, half + 5, ay - 3, 2, 6, col)
    px(ctx, half + 7, ay - 2, 2, 4, col)
    px(ctx, half + 9, ay - 1, 2, 2, col)
    ctx.globalAlpha = 1
    ctx.restore()
  }
}

// First-swipe hint: three left-pointing chevrons to the right of the trunk that
// "march" toward the tree, cueing the player to swipe LEFT (which fells it toward
// the gap). Shown only before the first chop — the first valid swipe leaves the
// chopping phase, so it vanishes on its own once the player swipes.
//
// Drawn in SCREEN space (constant size, independent of camera zoom): we project
// the trunk anchor to device pixels ourselves, then reset the transform.
const HINT_BLK = 3 // chevron pixel-block size, in CSS px (constant on screen)
const HINT_STEPS = 5 // blocks per arm (chevron height ~= 2 * STEPS * BLK)
function drawSwipeHint(
  ctx: CanvasRenderingContext2D,
  g: GameData,
  scale: number,
  tx: number,
  ty: number,
  dpr: number,
) {
  if (g.phase !== 'chopping' || g.chopsDone > 0) return
  // Anchor to the trunk's right edge / mid-height in the world, projected to the
  // screen, then offset by a constant screen-pixel gap so it reads at any zoom.
  const wx = BASE_X + g.treeWidth / 2
  const wy = g.leftTop - g.treeHeight * 0.4
  const sx = wx * scale + tx + 18 // 18 CSS px right of the trunk edge
  const sy = wy * scale + ty

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0) // work in CSS pixels
  const gap = HINT_BLK * 3.2 // spacing between chevron tips
  // Bright wave travels right->left across the trio, so the arrows read as
  // moving leftward. Chevron 2 (rightmost) lights first, then 1, then 0.
  for (let i = 0; i < 3; i++) {
    const a = Math.max(0, Math.sin(g.t * 4 - (2 - i) * 1.1))
    drawLeftChevron(ctx, sx + i * gap, sy, 0.25 + 0.75 * a)
  }
  // "SWIPE" label, just right of the arrows, in the same neon green.
  const fontPx = HINT_STEPS * HINT_BLK * 1.5
  const textX = sx + 2 * gap + HINT_STEPS * HINT_BLK + 6
  ctx.globalAlpha = 0.9
  ctx.fillStyle = '#39ff14'
  ctx.font = `bold ${fontPx}px monospace`
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  ctx.fillText('SWIPE', textX, sy)
  ctx.globalAlpha = 1
}

// A pixel "<" with its tip at (cx, cy), arms extending up-right and down-right.
function drawLeftChevron(ctx: CanvasRenderingContext2D, cx: number, cy: number, alpha: number) {
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha))
  const b = HINT_BLK
  for (let k = 0; k < HINT_STEPS; k++) {
    px(ctx, cx + k * b, cy - k * b - b / 2, b * 1.4, b * 1.4, '#39ff14')
    px(ctx, cx + k * b, cy + k * b - b / 2, b * 1.4, b * 1.4, '#39ff14')
  }
  ctx.globalAlpha = 1
}

// Draws a trunk of the given length upward from local (0,0), optionally with roots.
function drawTrunk(ctx: CanvasRenderingContext2D, tw: number, len: number, withRoots: boolean) {
  const half = tw / 2
  px(ctx, -half, -len, tw, len, '#6b4423')
  px(ctx, -half, -len, Math.max(2, tw * 0.3), len, '#7d5230') // light side
  px(ctx, half - Math.max(2, tw * 0.28), -len, Math.max(2, tw * 0.28), len, '#523318') // shade
  // bark lines
  ctx.fillStyle = '#523318'
  for (let y = -len + 12; y < -8; y += 16) {
    ctx.fillRect(-half + 2, y, tw - 4, 2)
  }
  if (withRoots) {
    px(ctx, -half - 4, -6, tw + 8, 8, '#6b4423')
    px(ctx, -half - 8, -2, 6, 4, '#523318')
    px(ctx, half + 2, -2, 6, 4, '#523318')
  }
}

// Shows where the user has been chopping: each spot gouges a notch that deepens
// with the number of hits there. Notches above the cut fell away with the trunk.
function drawNotches(ctx: CanvasRenderingContext2D, g: GameData) {
  const half = g.treeWidth / 2
  const maxDepth = g.treeWidth * 0.9
  for (const s of g.spots) {
    const bh = g.leftTop - s.y // height above ground (local trunk y is -bh)
    if (g.breakH > 0 && bh >= g.breakH - 1) continue // this spot fell with the trunk
    const depth = Math.min(maxDepth, (s.count / CHOPS_TO_BREAK) * maxDepth)
    px(ctx, half - depth, -bh - 3, depth, 6, '#3a2410')
    px(ctx, half - depth, -bh - 3, Math.min(depth, 3), 2, '#2a1908')
  }
}

// Radius of the canopy blob around the crown. The green is treated as SOLID: it
// rests on the ground instead of clipping through it, and reach/scoring is measured
// to the far edge of this canopy rather than the bare trunk tip. When the felled
// log lies flat, the canopy's sideways extent (±r) becomes its vertical bulge, and
// its tip-ward extent (~1.3r) becomes how much farther the green reaches than the
// trunk — see FOLIAGE_REACH.
function foliageRadius(tw: number) {
  return Math.max(20, tw * 1.7)
}
const FOLIAGE_REACH = 1.3 // canopy reaches this * radius past the trunk tip

function drawFoliage(ctx: CanvasRenderingContext2D, x: number, y: number, tw: number) {
  const r = foliageRadius(tw)
  const blocks: [number, number, number, number, string][] = [
    [-r, -r * 0.4, r * 2, r, '#2f6f2b'],
    [-r * 0.8, -r, r * 1.6, r, '#3f8f37'],
    [-r * 0.5, -r * 1.3, r, r * 0.8, '#4faa43'],
    [-r * 0.9, -r * 0.1, r * 1.8, r * 0.6, '#367e30'],
  ]
  for (const [bx, by, bw, bh, c] of blocks) px(ctx, x + bx, y + by, bw, bh, c)
  // highlight dabs
  ctx.fillStyle = '#67bd55'
  px(ctx, x - r * 0.5, y - r * 0.9, 5, 5, '#67bd55')
  px(ctx, x + r * 0.2, y - r * 0.5, 4, 4, '#67bd55')
  px(ctx, x - r * 0.1, y - r * 0.2, 5, 4, '#67bd55')
}

function drawLeaves(ctx: CanvasRenderingContext2D, g: GameData) {
  for (const l of g.leaves) {
    ctx.globalAlpha = Math.min(1, l.life)
    px(ctx, l.x, l.y, 3, 3, l.color)
  }
  ctx.globalAlpha = 1
}

function drawChips(ctx: CanvasRenderingContext2D, g: GameData) {
  for (const c of g.chips) {
    ctx.save()
    ctx.globalAlpha = Math.min(1, c.life * 2)
    ctx.translate(c.x, c.y)
    ctx.rotate(c.rot)
    px(ctx, -c.size / 2, -c.size / 2, c.size, c.size * 0.7, c.color)
    ctx.restore()
  }
  ctx.globalAlpha = 1
}

function drawSplashes(ctx: CanvasRenderingContext2D, g: GameData) {
  for (const s of g.splashes) {
    ctx.globalAlpha = Math.min(1, s.life * 2.2)
    px(ctx, s.x, s.y, s.size, s.size, s.color)
  }
  ctx.globalAlpha = 1
}

function drawRaven(ctx: CanvasRenderingContext2D, g: GameData) {
  if (g.phase === 'result') return
  // Perfect chop: the whole flock hops across behind the hero, all in shades.
  if (g.perfect) {
    for (const r of g.flock) drawRavenAt(ctx, r.x, r.y, true)
  }
  let x = g.ravenX
  let y = g.ravenY
  if (g.phase === 'chopping' || g.phase === 'title') {
    y = g.leftTop + Math.sin(g.ravenBobT * 3) * 1
  }
  drawRavenAt(ctx, x, y, g.perfect) // hero dons sunglasses on a perfect chop
}

function drawRavenAt(ctx: CanvasRenderingContext2D, x: number, y: number, shades: boolean) {
  ctx.save()
  ctx.translate(Math.round(x), Math.round(y))
  // facing right
  const black = '#1b1b24'
  const dark = '#2c2c38'
  // tail
  px(ctx, -8, -8, 4, 3, black)
  px(ctx, -9, -7, 3, 2, dark)
  // body
  px(ctx, -6, -11, 10, 8, black)
  px(ctx, -5, -12, 8, 2, black)
  // wing
  px(ctx, -4, -9, 7, 4, dark)
  px(ctx, -3, -8, 5, 2, '#3a3a48')
  // head
  px(ctx, 2, -14, 5, 5, black)
  // beak
  px(ctx, 7, -13, 4, 2, '#f2a13c')
  px(ctx, 7, -11, 3, 1, '#d9852a')
  if (shades) {
    // sunglasses: a dark lens bar across the eyes with a glint + a temple arm
    px(ctx, 2, -13, 5, 2, '#0c0c12')
    px(ctx, 3, -11, 3, 1, '#0c0c12')
    px(ctx, 1, -13, 1, 1, '#0c0c12')
    px(ctx, 3, -13, 1, 1, '#5a6cff')
  } else {
    // eye
    px(ctx, 4, -13, 2, 2, '#ffffff')
    px(ctx, 5, -13, 1, 1, '#000000')
  }
  // legs
  px(ctx, -2, -3, 1, 3, '#d9852a')
  px(ctx, 2, -3, 1, 3, '#d9852a')
  ctx.restore()
}

function drawConfetti(ctx: CanvasRenderingContext2D, g: GameData) {
  for (const c of g.confetti) {
    ctx.save()
    ctx.translate(c.x, c.y)
    ctx.rotate(c.rot)
    px(ctx, -c.size / 2, -c.size / 2, c.size, c.size, c.color)
    ctx.restore()
  }
}

// ============ Result screen ============
function ResultScreen({
  score,
  success,
  onReplay,
}: {
  score: number
  success: boolean
  onReplay: () => void
}) {
  // a successful-but-low score means the trunk overshot — too much extra tree
  const headline = !success
    ? 'MISSED!'
    : score >= 90
      ? 'PERFECT CHOP!'
      : score >= 50
        ? 'NICE CHOP!'
        : 'TOO MUCH TREE!'

  return (
    <div className="rh-result">
      <div className="rh-result-card">
        <div className="rh-headline">{headline}</div>
        {/* raven face hidden for now — flip to true to bring it back */}
        {false && <RavenFace mood="neutral" />}
        <div className="rh-scoreboard">
          <span className="rh-score-label">SCORE</span>
          <span className="rh-score-value">{success ? score : 0}%</span>
        </div>
        <button className="rh-replay" onClick={onReplay}>
          Caw! ▸ play again
        </button>
      </div>
    </div>
  )
}

function RavenFace({ mood }: { mood: 'smile' | 'neutral' | 'side' }) {
  // pupil position for "side eye"
  const pupilCx = mood === 'side' ? 138 : 130
  const pupilCy = mood === 'side' ? 96 : 100

  return (
    <svg className="rh-raven" viewBox="0 0 260 200" width="260" height="200">
      {/* head */}
      <ellipse cx="130" cy="110" rx="92" ry="80" fill="#1b1b24" />
      <ellipse cx="130" cy="118" rx="78" ry="66" fill="#23232e" />
      {/* feather tufts */}
      <polygon points="60,46 78,20 90,52" fill="#1b1b24" />
      <polygon points="200,46 182,20 170,52" fill="#1b1b24" />
      {/* big eye (sclera) */}
      <circle cx="130" cy="100" r="56" fill="#ffffff" />
      <circle cx="130" cy="100" r="56" fill="none" stroke="#0c0c12" strokeWidth="4" />
      {/* pupil */}
      <circle cx={pupilCx} cy={pupilCy} r="40" fill="#0c0c12" />
      <circle cx={pupilCx - 12} cy={pupilCy - 14} r="9" fill="#ffffff" opacity="0.9" />

      {/* eyelid for side-eye / moods */}
      {mood === 'side' && (
        <path d="M74 78 Q130 56 186 84 L186 60 L74 60 Z" fill="#1b1b24" />
      )}
      {mood === 'smile' && (
        <path d="M86 150 Q130 178 174 150" fill="none" stroke="#f2a13c" strokeWidth="7" strokeLinecap="round" />
      )}
      {mood === 'neutral' && (
        <line x1="98" y1="158" x2="162" y2="158" stroke="#f2a13c" strokeWidth="7" strokeLinecap="round" />
      )}

      {/* beak */}
      <polygon points="196,108 252,120 196,132" fill="#f2a13c" />
      <polygon points="196,120 240,123 196,130" fill="#d9852a" />
    </svg>
  )
}
