// PTY harness — boots ONE UI (the real binary) over a real node-pty PTY at
// 120×40 with the fake gateway substituted via HERMES_PYTHON, drains the master
// side tightly, samples /proc/PID externally on fixture-message boundaries, and
// (optionally) wraps the UI in a cgroup-v2 scope via systemd-run.
// Methodology: docs/plans/opentui-bench-suite.md. No tmux anywhere — except
// mode 'pipeline', which exists to measure the tmux emulator leg and runs the
// UI inside a dedicated `tmux -L hermes-bench-<runId>` server.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import pty from 'node-pty'

const here = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(here, '..')
const FAKE_GATEWAY = join(here, 'fake-gateway.mjs')

export const NODE26_BIN = process.env.BENCH_NODE_BIN
  || join(process.env.HOME ?? '', '.local/share/fnm/node-versions/v26.3.0/installation/bin/node')

const sleep = ms => new Promise(r => setTimeout(r, ms))
const now = () => Date.now()

// ── /proc readers (UI PID only — never the gateway child) ──────────────
function readProcSample(pid) {
  try {
    const rollup = readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8')
    const status = readFileSync(`/proc/${pid}/status`, 'utf8')
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const kb = (text, key) => {
      const m = text.match(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm'))
      return m ? Number(m[1]) : null
    }
    // stat: fields after the parenthesized comm; utime=14 stime=15 (1-indexed).
    const afterComm = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return {
      rss_kb: kb(rollup, 'Rss'),
      pss_kb: kb(rollup, 'Pss'),
      private_dirty_kb: kb(rollup, 'Private_Dirty'),
      vmhwm_kb: kb(status, 'VmHWM'),
      utime_ticks: Number(afterComm[11]),
      stime_ticks: Number(afterComm[12])
    }
  } catch {
    return null // process gone
  }
}

function readCgroup(pid) {
  try {
    const line = readFileSync(`/proc/${pid}/cgroup`, 'utf8').trim()
    const path = line.split('::')[1]
    if (!path) return null
    return `/sys/fs/cgroup${path}`
  } catch {
    return null
  }
}

function readCgroupStats(cgPath) {
  if (!cgPath) return null
  try {
    const read = f => {
      try {
        return readFileSync(join(cgPath, f), 'utf8').trim()
      } catch {
        return null
      }
    }
    const events = read('memory.events')
    const oomKill = events ? Number(events.match(/^oom_kill (\d+)$/m)?.[1] ?? 0) : null
    return {
      current: Number(read('memory.current') ?? NaN) || null,
      peak: Number(read('memory.peak') ?? NaN) || null,
      oom_kill: oomKill
    }
  } catch {
    return null
  }
}

function childrenOf(pid) {
  try {
    return readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number)
  } catch {
    return []
  }
}

function commOf(pid) {
  try {
    return readFileSync(`/proc/${pid}/comm`, 'utf8').trim()
  } catch {
    return ''
  }
}

function procStateOf(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]
  } catch {
    return null
  }
}

// Alive = signalable AND not a zombie (a destroyed-PTY child may linger as Z
// until reaped — that is not an orphan, just an unreaped corpse).
function pidAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  return procStateOf(pid) !== 'Z'
}

// Cumulative CPU (utime+stime ticks) of one pid — total since its exec.
function cpuTicksOf(pid) {
  if (!pid) return null
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const afterComm = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return Number(afterComm[11]) + Number(afterComm[12])
  } catch {
    return null
  }
}

let _clkTck = null
function clkTck() {
  if (_clkTck) return _clkTck
  try {
    _clkTck = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim()) || 100
  } catch {
    _clkTck = 100
  }
  return _clkTck
}

function quantile(values, q) {
  if (!values || values.length === 0) return null
  const s = [...values].sort((a, b) => a - b)
  const i = (s.length - 1) * q
  const lo = Math.floor(i)
  const hi = Math.ceil(i)
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo)
}

// ── M6 frame pacing ─────────────────────────────────────────────────────
// Burst-segment the PTY data-chunk timestamps: a gap >gapMs is a frame
// boundary (terminal writers flush a frame as one tight burst of chunks).
// Returns frames/s, bytes-per-frame distribution, and how many frames
// coalesced >1 chunk.
export function framePacing(timestamps, sizes, gapMs = 4) {
  if (!timestamps || timestamps.length < 2) return null
  const frames = []
  let cur = null
  for (let i = 0; i < timestamps.length; i++) {
    const t = timestamps[i]
    if (!cur || t - cur.end > gapMs) {
      cur = { start: t, end: t, bytes: 0, chunks: 0 }
      frames.push(cur)
    }
    cur.end = t
    cur.bytes += sizes[i] ?? 0
    cur.chunks += 1
  }
  const spanMs = timestamps[timestamps.length - 1] - timestamps[0]
  const bytes = frames.map(f => f.bytes)
  const intervals = frames.slice(1).map((f, i) => f.start - frames[i].start)
  return {
    gap_ms: gapMs,
    chunks: timestamps.length,
    frames: frames.length,
    duration_ms: spanMs,
    fps_avg: spanMs > 0 ? Math.round((frames.length / (spanMs / 1000)) * 10) / 10 : null,
    interframe_ms_p50: quantile(intervals, 0.5),
    interframe_ms_p95: quantile(intervals, 0.95),
    bytes_per_frame_p50: quantile(bytes, 0.5),
    bytes_per_frame_p95: quantile(bytes, 0.95),
    coalesced_frames: frames.filter(f => f.chunks > 1).length
  }
}

// ── ANSI strip for the determinism digest ──────────────────────────────
// Removes CSI/OSC/DCS/SOS/PM/APC sequences, single ESC sequences, and control
// chars, then normalizes whitespace. Good enough to compare final rendered
// transcript text across replays of the SAME UI.
export function stripAnsi(text) {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC
    .replace(/\x1b[PX^_][^\x1b]*\x1b\\/g, '') // DCS/SOS/PM/APC
    .replace(/\x1b\[[0-9;:<=>?]*[ -/]*[@-~]/g, '') // CSI
    .replace(/\x1b[@-Z\\-_]/g, '') // single ESC
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

// Digest normalization: the final screen contains a 1Hz uptime clock (OpenTUI
// status bar `up: Ns`) whose incremental repaints trail the full post-resize
// frame. The transcript region paints deterministically; the clock does not.
// Cut everything after the composer hint (the last stable screen region) and
// normalize the uptime token inside the kept prefix.
export function normalizeForDigest(text) {
  const marker = 'Type your message'
  const idx = text.indexOf(marker)
  const head = idx >= 0 ? text.slice(0, idx + marker.length) : text
  return head.replace(/up: \d+s/g, 'up: Ns')
}

// ── env / argv composition (mirrors hermes_cli/main.py _launch_tui) ────
function composeEnv({ ui, opentuiCap, heapMb, fakeEnv, activeSessionFile }) {
  const keep = ['HOME', 'USER', 'LANG', 'LC_ALL', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'SHELL']
  const env = {}
  for (const k of keep) if (process.env[k]) env[k] = process.env[k]
  env.PATH = `${dirname(NODE26_BIN)}:/usr/bin:/bin:/usr/local/bin`
  env.TERM = 'xterm-256color'
  env.NODE_ENV = 'production'
  env.HERMES_PYTHON = FAKE_GATEWAY
  env.HERMES_PYTHON_SRC_ROOT = REPO_ROOT
  env.HERMES_CWD = REPO_ROOT
  env.HERMES_TUI_ACTIVE_SESSION_FILE = activeSessionFile
  // Launcher parity: NODE_OPTIONS carries the V8 heap cap (8192 on an
  // unconstrained host; _resolve_tui_heap_mb sizes it under a cgroup limit).
  env.NODE_OPTIONS = `--max-old-space-size=${heapMb}`
  if (ui === 'opentui') {
    env.HERMES_TUI_MOUSE = '1'
    if (opentuiCap != null) env.HERMES_TUI_MAX_MESSAGES = String(opentuiCap)
    // Windowing A/B (feat/opentui-memory-window): pass the flag through —
    // composeEnv is otherwise a clean env and would silently strip it.
    if (process.env.HERMES_TUI_WINDOWING != null) env.HERMES_TUI_WINDOWING = process.env.HERMES_TUI_WINDOWING
  }
  Object.assign(env, fakeEnv)
  return env
}

function uiArgv(ui) {
  if (ui === 'ink') {
    return { file: NODE26_BIN, args: ['--expose-gc', join(REPO_ROOT, 'ui-tui/dist/entry.js')], cwd: join(REPO_ROOT, 'ui-tui') }
  }
  return {
    file: NODE26_BIN,
    args: ['--experimental-ffi', '--no-warnings', join(REPO_ROOT, 'ui-opentui/dist/main.js')],
    cwd: join(REPO_ROOT, 'ui-opentui')
  }
}

// ── the scenario runner ────────────────────────────────────────────────
/**
 * opts:
 *   ui: 'ink' | 'opentui'
 *   configName: 'ink' | 'otui-capped' | 'otui-uncapped'
 *   opentuiCap: number|null            (HERMES_TUI_MAX_MESSAGES)
 *   mode: 'mem' | 'cpu-paced' | 'scroll' | 'startup' | 'digest' | 'chaos' | 'pipeline' | 'echo'
 *   chaos: { scenario, dieAt?, stopAt?, flaps?, fakeMode? }   (chaos mode)
 *     scenario: 'gw-kill-stream' | 'gw-kill-tool' | 'gw-stop' | 'resize-storm' | 'pty-eof'
 *   fixturePath, fixtureMsgs, fixtureSha
 *   memoryMax: string|null             ('2G' → systemd-run --user --scope)
 *   heapMb: number                     (--max-old-space-size)
 *   sampleEvery: number                (default 100)
 *   scroll: { hz, seconds }            (scroll mode)
 *   pacedRate: number                  (cpu-paced mode, events/s)
 *   cell, rep, outFile
 *   startDelayMs, quiesceMs, runTimeoutMs
 */
export async function runScenario(opts) {
  const {
    ui,
    configName,
    opentuiCap = null,
    mode,
    fixturePath = '',
    fixtureMsgs = 0,
    fixtureSha = '',
    memoryMax = null,
    heapMb = 8192,
    sampleEvery = 100,
    scroll = { hz: 30, seconds: 15 },
    pacedRate = 30,
    cell = 'E1',
    rep = 0,
    outFile = null,
    startDelayMs = 1500,
    quiesceMs = 800,
    runTimeoutMs = 30 * 60 * 1000
  } = opts

  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  const progressFile = join(tmpdir(), `hermes-bench-progress-${runId}.ndjson`)
  const activeSessionFile = join(tmpdir(), `hermes-bench-session-${runId}.json`)
  writeFileSync(progressFile, '')

  const chaosSpec = mode === 'chaos' ? { flaps: 30, ...(opts.chaos ?? {}) } : null
  const fakeEnv = {
    HERMES_FAKE_FIXTURE: fixturePath,
    HERMES_FAKE_MODE:
      mode === 'cpu-paced' || mode === 'pipeline'
        ? 'paced'
        : mode === 'scroll' || mode === 'echo'
          ? 'load-then-idle'
          : mode === 'chaos'
            ? (chaosSpec.fakeMode ?? 'burst')
            : 'burst',
    HERMES_FAKE_RATE: String(pacedRate),
    HERMES_FAKE_START_DELAY_MS: String(startDelayMs),
    HERMES_FAKE_SAMPLE_EVERY: String(sampleEvery),
    HERMES_FAKE_PROGRESS: progressFile
  }
  // Gateway pid discovery (the UI spawns the gateway, env flows through): the
  // fake gateway writes its pid here at startup; an auto-heal respawn REWRITES
  // it — that rewrite is the respawn-detection signal in chaos cells.
  const gwPidFile = mode === 'chaos' || mode === 'pipeline' ? join(tmpdir(), `hermes-bench-gwpid-${runId}`) : null
  if (gwPidFile) fakeEnv.HERMES_FAKE_PIDFILE = gwPidFile
  if (chaosSpec?.dieAt) {
    fakeEnv.HERMES_FAKE_DIE_AT = chaosSpec.dieAt
    fakeEnv.HERMES_FAKE_DIE_FLAG = `${gwPidFile}.dieflag`
  }
  if (mode === 'echo') fakeEnv.HERMES_FAKE_SUBMIT_RESPONSE = '1'
  const env = composeEnv({ ui, opentuiCap, heapMb, fakeEnv, activeSessionFile })
  const { file, args, cwd } = uiArgv(ui)

  // Instrumented node-count runs (Ink): open fd 3 onto an NDJSON file via a
  // shell wrapper (node-pty cannot pass extra fds) and gate the in-process
  // sampler with HERMES_TUI_MEMSAMPLE_FD=3. NEVER combined with headline
  // memory runs — results carry instrumented:true.
  let nodeSampleFile = null
  let spawnFile = file
  let spawnArgs = args
  if (opts.inkNodeSampler) {
    nodeSampleFile = join(tmpdir(), `hermes-bench-nodes-${runId}.ndjson`)
    writeFileSync(nodeSampleFile, '')
    env.HERMES_TUI_MEMSAMPLE_FD = '3'
    env.HERMES_TUI_MEMSAMPLE_MS = '200'
    const quoted = [file, ...args].map(a => `'${a.replace(/'/g, `'\\''`)}'`).join(' ')
    spawnFile = '/bin/sh'
    spawnArgs = ['-c', `exec 3>>'${nodeSampleFile}'; exec ${quoted}`]
  }

  const unitName = `hermes-bench-${runId}.scope`
  if (memoryMax) {
    const innerFile = spawnFile
    const innerArgs = spawnArgs
    spawnFile = 'systemd-run'
    spawnArgs = [
      '--user',
      '--scope',
      '--quiet',
      '--collect',
      `--unit=${unitName.replace(/\.scope$/, '')}`,
      '-p',
      `MemoryMax=${memoryMax}`,
      '-p',
      'MemorySwapMax=0',
      '--',
      innerFile,
      ...innerArgs
    ]
  }

  // ── pipeline mode: wrap the UI in a DEDICATED tmux server ──────────────
  // The user's real stack runs the TUI inside tmux (verified via /proc
  // environ), so tmux IS the locally measurable terminal-emulator leg. The UI
  // command (systemd-run scope and all) runs inside a fresh `tmux -L <sock>`
  // server; the harness PTY then attaches a client to that socket — without an
  // attached client tmux skips most output work, so the attach is mandatory
  // for the numbers to mean anything. Only THIS socket's server is ever
  // killed; the user's default tmux server is never touched.
  let tmuxSock = null
  let tmuxServerPid = null
  if (mode === 'pipeline') {
    tmuxSock = `hermes-bench-${runId}`
    const quotedCmd = [spawnFile, ...spawnArgs].map(a => `'${a.replace(/'/g, `'\\''`)}'`).join(' ')
    execFileSync(
      'tmux',
      ['-L', tmuxSock, '-f', '/dev/null', 'new-session', '-d', '-s', 'sut', '-x', '120', '-y', '40', `exec ${quotedCmd}`],
      { env }
    )
    spawnFile = 'tmux'
    spawnArgs = ['-L', tmuxSock, '-f', '/dev/null', 'attach-session', '-t', 'sut']
  }

  const t0 = now()
  const term = pty.spawn(spawnFile, spawnArgs, {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    cwd,
    env
  })
  term.resize(120, 40) // explicit TIOCSWINSZ per protocol

  // ── tight drain loop ────────────────────────────────────────────────
  let bytesOut = 0
  let dataWrites = 0
  let firstByteAt = null
  let lastDataAt = null
  const dataTimestamps = [] // scroll latency + frame pacing (epoch ms of each data chunk)
  const dataSizes = [] // bytes per chunk, aligned with dataTimestamps
  // cpu-paced/pipeline record the whole stream (M6 frame pacing); scroll keeps
  // its wheel-phase-only recording so the pacing stats reflect the scroll leg.
  let recordDataTimestamps = mode === 'cpu-paced' || mode === 'pipeline'
  let tailBuf = []
  let tailLen = 0
  const TAIL_MAX = 4 * 1024 * 1024
  term.onData(d => {
    const t = now()
    const blen = Buffer.byteLength(d)
    bytesOut += blen
    dataWrites++
    if (firstByteAt === null) firstByteAt = t
    lastDataAt = t
    if (recordDataTimestamps) {
      dataTimestamps.push(t)
      dataSizes.push(blen)
    }
    tailBuf.push(d)
    tailLen += d.length
    while (tailLen > TAIL_MAX && tailBuf.length > 1) tailLen -= tailBuf.shift().length
  })
  const resetTail = () => {
    tailBuf = []
    tailLen = 0
  }

  // Drain-starvation probe: if OUR event loop stalls, the PTY master isn't
  // being drained. 5ms cadence; any observed gap >10ms is recorded (assert).
  let maxLoopLagMs = 0
  let lagViolations = 0
  let lastTick = now()
  const lagTimer = setInterval(() => {
    const t = now()
    const lag = t - lastTick - 5
    if (lag > maxLoopLagMs) maxLoopLagMs = lag
    if (lag > 10) lagViolations++
    lastTick = t
  }, 5)

  // ── exit tracking ───────────────────────────────────────────────────
  let exited = null
  const exitPromise = new Promise(res => {
    term.onExit(({ exitCode, signal }) => {
      exited = { exitCode, signal, t: now() - t0 }
      res(exited)
    })
  })

  // ── UI PID discovery ────────────────────────────────────────────────
  // `systemd-run --scope` (and the /bin/sh sampler wrapper) EXEC the target in
  // place, so the pty child PID *is* the UI once its comm flips to 'node'.
  // Wait for that flip (scope registration / sh exec take a moment); fall back
  // to a child walk in case a future wrapper forks instead.
  let uiPid = term.pid
  // Node 26 names its main thread: comm is 'node-MainThread'.
  const isNodeComm = pid => commOf(pid).startsWith('node')
  if (mode === 'pipeline') {
    // term.pid is the tmux CLIENT — the UI lives under the dedicated server's
    // pane. Resolve server pid + pane pid, then wait for the pane command
    // (sh `exec` → systemd-run exec-in-place) to flip comm to node.
    uiPid = null
    let panePid = null
    for (let i = 0; i < 200 && !exited; i++) {
      try {
        const out = execFileSync(
          'tmux',
          ['-L', tmuxSock, 'display-message', '-p', '-t', 'sut', '#{pid} #{pane_pid}'],
          { encoding: 'utf8', env }
        ).trim()
        const [srv, pane] = out.split(/\s+/).map(Number)
        if (srv) tmuxServerPid = srv
        if (pane) panePid = pane
      } catch {
        /* server still starting */
      }
      if (panePid) break
      await sleep(25)
    }
    for (let i = 0; i < 200 && !exited && panePid; i++) {
      if (isNodeComm(panePid)) {
        uiPid = panePid
        break
      }
      const nodeKid = childrenOf(panePid).find(k => isNodeComm(k))
      if (nodeKid) {
        uiPid = nodeKid
        break
      }
      await sleep(25)
    }
  } else if (memoryMax || opts.inkNodeSampler) {
    uiPid = null
    for (let i = 0; i < 200 && !exited; i++) {
      if (isNodeComm(term.pid)) {
        uiPid = term.pid
        break
      }
      const nodeKid = childrenOf(term.pid).find(k => isNodeComm(k))
      if (nodeKid) {
        uiPid = nodeKid
        break
      }
      await sleep(25)
    }
  }
  // containerCap: the harness itself runs INSIDE a memory-capped container
  // (E3) — the container cgroup is the cap, no systemd-run involved.
  const cgPath = opts.containerCap ? '/sys/fs/cgroup' : memoryMax && uiPid ? readCgroup(uiPid) : null

  // ── sampling state ──────────────────────────────────────────────────
  const samples = []
  const events = []
  let lastCg = null
  let streamDone = false
  let streamStartT = null
  let doneInfo = null
  let sessionCreateAt = null
  let gwPid = null
  let lastBoundaryMsgs = 0
  let streamStarts = 0
  let dyingItem = null // {k:'dying', kind, msgs, wall} from the fake gateway's last gasp
  const cpuSeries = [] // pipeline: 1Hz {t_ms, ui, gw, tmux} cumulative ticks

  // Gateway pid tracking via the pidfile (chaos/pipeline). A respawned
  // gateway rewrites the file → a new entry appears here.
  const gwPidHistory = [] // {pid, at}  (at = epoch ms first observed)
  const readGwPidfile = () => {
    if (!gwPidFile) return null
    try {
      const v = Number(readFileSync(gwPidFile, 'utf8').trim())
      return Number.isFinite(v) && v > 0 ? v : null
    } catch {
      return null
    }
  }
  const pollGwPid = () => {
    const p = readGwPidfile()
    if (p && gwPidHistory[gwPidHistory.length - 1]?.pid !== p) gwPidHistory.push({ pid: p, at: now() })
  }

  const takeSample = (kind, msgs, evCount) => {
    if (!uiPid) return
    const proc = readProcSample(uiPid)
    if (!proc) return
    const cg = readCgroupStats(cgPath)
    if (cg) lastCg = cg
    samples.push({
      kind,
      t_ms: now() - t0,
      msgs: msgs ?? null,
      events: evCount ?? null,
      pty_bytes: bytesOut,
      pty_writes: dataWrites,
      ...proc,
      ...(cg ? { cg_current: cg.current, cg_peak: cg.peak, cg_oom_kill: cg.oom_kill } : {})
    })
  }

  const tailProgress = (() => {
    let offset = 0
    return () => {
      let size
      try {
        size = statSync(progressFile).size
      } catch {
        return []
      }
      if (size <= offset) return []
      const fd = openSync(progressFile, 'r')
      try {
        const buf = Buffer.alloc(size - offset)
        readSync(fd, buf, 0, buf.length, offset)
        offset = size
        const out = []
        let text = buf.toString('utf8')
        const lastNl = text.lastIndexOf('\n')
        if (lastNl < text.length - 1) {
          offset -= Buffer.byteLength(text.slice(lastNl + 1), 'utf8')
          text = text.slice(0, lastNl + 1)
        }
        for (const line of text.split('\n')) {
          if (!line.trim()) continue
          try {
            out.push(JSON.parse(line))
          } catch {
            /* skip malformed */
          }
        }
        return out
      } finally {
        closeSync(fd)
      }
    }
  })()

  const handleProgress = item => {
    if (item.k === 'start') gwPid = item.pid
    if (item.k === 'req') {
      events.push({ kind: 'rpc', method: item.method, t_ms: now() - t0 })
      if (item.method === 'session.create' && sessionCreateAt === null) sessionCreateAt = now()
    }
    if (item.k === 'stream_start') {
      if (streamStartT === null) streamStartT = now()
      streamStarts++
    }
    if (item.k === 'boundary') {
      lastBoundaryMsgs = item.msgs
      takeSample('boundary', item.msgs, item.events)
    }
    if (item.k === 'dying' && dyingItem === null) {
      dyingItem = item
      events.push({ kind: 'gw-dying', die_kind: item.kind, msgs: item.msgs, t_ms: now() - t0 })
    }
    if (item.k === 'done') {
      streamDone = true
      doneInfo = { msgs: item.msgs, events: item.events }
      takeSample('done', item.msgs, item.events)
    }
  }

  // main poll loop driver
  let pollTimer = null
  const startPolling = () => {
    let lastPeriodic = 0
    pollTimer = setInterval(() => {
      for (const item of tailProgress()) handleProgress(item)
      if (gwPidFile) pollGwPid()
      const t = now()
      if (t - lastPeriodic >= 1000) {
        lastPeriodic = t
        takeSample('periodic', doneInfo?.msgs ?? null, null)
        if (mode === 'pipeline') {
          cpuSeries.push({
            t_ms: t - t0,
            ui: cpuTicksOf(uiPid),
            gw: cpuTicksOf(gwPidHistory[gwPidHistory.length - 1]?.pid ?? gwPid),
            tmux: cpuTicksOf(tmuxServerPid)
          })
        }
      }
    }, 25)
  }
  startPolling()

  const waitFor = async (cond, timeoutMs, pollMs = 50) => {
    const start = now()
    while (!cond()) {
      if (exited) return false
      if (now() - start > timeoutMs) return false
      await sleep(pollMs)
    }
    return true
  }

  // Wait until no PTY output for `ms`, bounded: idle-frame UIs still repaint
  // periodically (1Hz status clock), so a quiesce can never be unbounded.
  const quiesce = async (ms, maxWaitMs = 15_000) => {
    const deadline = now() + maxWaitMs
    for (;;) {
      if (exited) return
      const last = lastDataAt ?? t0
      const idle = now() - last
      if (idle >= ms) return
      if (now() > deadline) return
      await sleep(Math.min(ms - idle + 10, 200))
    }
  }

  let quitRequested = false
  const gracefulQuit = async () => {
    if (exited) return
    quitRequested = true
    try {
      term.write('\x03')
      await sleep(150)
      term.write('\x03')
    } catch {
      /* already gone */
    }
    await Promise.race([exitPromise, sleep(3000)])
    if (!exited) {
      try {
        term.kill('SIGTERM')
      } catch {
        /* ignore */
      }
      await Promise.race([exitPromise, sleep(2000)])
    }
    if (!exited) {
      try {
        term.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      await Promise.race([exitPromise, sleep(2000)])
    }
  }

  // ── mode flows ──────────────────────────────────────────────────────
  const result = {}
  const scrollLatencies = []
  let digest = null
  let digestText = null

  // ── chaos helpers ─────────────────────────────────────────────────────
  const sha256 = text => createHash('sha256').update(text).digest('hex')
  // Resize-jiggle forces a full repaint (like digest mode) so the captured
  // tail is the CURRENT screen, not just incremental damage since the reset.
  const forcedScreen = async () => {
    if (!exited) {
      try {
        resetTail()
        term.resize(120, 39)
        await sleep(350)
        resetTail()
        term.resize(120, 40)
        await sleep(900)
      } catch {
        /* pty gone mid-jiggle */
      }
    }
    return stripAnsi(tailBuf.join(''))
  }
  // Fixture code blocks carry `const xN = M` tokens whose (N,M) pairs are
  // unique and appear in fixture order — a position marker. Build the ordered
  // key list from the fixture file; the highest ordinal rendered pre-kill is
  // the transcript-preservation marker. Preservation = the post-event
  // full-repaint screen still shows a marker from a recent pre-kill turn.
  // Rendered screens collapse whitespace (`constx4=58`), hence the \s* regex.
  const CODE_TOKEN_RE = /const\s*x(\d+)\s*=\s*(\d+)/g
  const markerOrder = (() => {
    const order = new Map()
    try {
      const raw = readFileSync(fixturePath, 'utf8')
      let i = 0
      for (const m of raw.matchAll(/const x(\d+) = (\d+)/g)) {
        const key = `${m[1]}=${m[2]}`
        if (!order.has(key)) order.set(key, i++)
      }
    } catch {
      /* no fixture */
    }
    return order
  })()
  const lastCodeIdx = text => {
    let max = null
    for (const m of text.matchAll(CODE_TOKEN_RE)) {
      const ord = markerOrder.get(`${m[1]}=${m[2]}`)
      if (ord !== undefined && (max === null || ord > max)) max = ord
    }
    return max
  }
  const screenPreserves = (screen, idx) => {
    // No pre marker, or a screen window that happens to show no code block at
    // all (≈0.9 blocks/turn): fall back to "screen not blank".
    const seen = lastCodeIdx(screen)
    if (idx === null || seen === null) return screen.length > 500
    // Preserved = the screen shows content at-or-after the pre-event region
    // (>= idx-10). No upper bound: the UI legitimately keeps painting events
    // it already buffered (pipe + coalesce queue), so the screen may be AHEAD
    // of the captured pre-event tail. Only a transcript reset — a re-stream
    // from scratch showing early-fixture markers — fails this.
    return seen >= idx - 10
  }

  const runChaos = async () => {
    const scen = chaosSpec.scenario
    const chaos = { scenario: scen }

    if (scen === 'gw-kill-stream' || scen === 'gw-kill-tool') {
      // The fake gateway self-SIGKILLs (HERMES_FAKE_DIE_AT) and leaves a
      // 'dying' progress line — the precise kill wall-clock.
      chaos.kill_seen = await waitFor(() => dyingItem !== null, 90_000)
      const preIdx = lastCodeIdx(stripAnsi(tailBuf.join('')))
      chaos.pre_kill_code_idx = preIdx
      chaos.died_at_msgs = dyingItem?.msgs ?? null
      chaos.first_gw_pid = gwPidHistory[0]?.pid ?? null
      // Snapshot the screen post-kill but pre-restream: did the transcript survive?
      await sleep(250)
      const postKill = await forcedScreen()
      chaos.transcript_preserved = screenPreserves(postKill, preIdx)
      chaos.post_kill_screen_sha = sha256(postKill)
      chaos.post_kill_screen_chars = postKill.length
      // Auto-heal detection: the respawned gateway rewrites the pidfile.
      await waitFor(() => gwPidHistory.length >= 2, 30_000)
      chaos.gateway_respawned = gwPidHistory.length >= 2
      chaos.respawn_gw_pid = gwPidHistory[1]?.pid ?? null
      chaos.time_to_respawn_ms = chaos.gateway_respawned && dyingItem ? gwPidHistory[1].at - dyingItem.wall : null
      // Resume: the respawned gateway re-streams to completion ('done').
      const resumed = await waitFor(() => streamDone, 120_000)
      chaos.stream_resumed = resumed && streamStarts >= 2
      if (resumed) {
        await quiesce(quiesceMs)
        takeSample('final', doneInfo?.msgs ?? null, doneInfo?.events ?? null)
      }
      const fin = await forcedScreen()
      chaos.final_screen_sha = sha256(fin)
      chaos.final_screen_code_idx = lastCodeIdx(fin)
      chaos.final_screen_has_fixture = fin.length > 500
    } else if (scen === 'gw-stop') {
      // SIGSTOP must be external (a stopped process can't stop itself): the
      // harness reads the pidfile and signals at the stopAt boundary.
      const stopAt = chaosSpec.stopAt ?? 150
      chaos.stop_at_msgs = stopAt
      chaos.stop_reached = await waitFor(() => lastBoundaryMsgs >= stopAt, 180_000)
      const gwp = gwPidHistory[gwPidHistory.length - 1]?.pid ?? gwPid
      chaos.gw_pid = gwp
      if (chaos.stop_reached && gwp) {
        const preIdx = lastCodeIdx(stripAnsi(tailBuf.join('')))
        chaos.pre_stop_code_idx = preIdx
        try {
          process.kill(gwp, 'SIGSTOP')
        } catch {
          /* gone */
        }
        await sleep(100)
        chaos.gw_state_after_stop = procStateOf(gwp) // expect 'T'
        const tFreeze = now()
        let checks = 0
        let aliveOk = 0
        while (now() - tFreeze < 30_000 && !exited) {
          await sleep(1000)
          checks++
          if (uiPid && readProcSample(uiPid)) aliveOk++
        }
        chaos.freeze_observe_s = 30
        chaos.ui_alive_during_freeze = `${aliveOk}/${checks}`
        chaos.ui_survived_freeze = !exited
        const frozenScreen = await forcedScreen()
        chaos.transcript_preserved = screenPreserves(frozenScreen, preIdx)
        chaos.frozen_screen_sha = sha256(frozenScreen)
        // End the run: CONT first (cleanup needs a running process), then KILL.
        try {
          process.kill(gwp, 'SIGCONT')
        } catch {
          /* gone */
        }
        await sleep(200)
        const tKill = now()
        try {
          process.kill(gwp, 'SIGKILL')
        } catch {
          /* gone */
        }
        await waitFor(() => gwPidHistory[gwPidHistory.length - 1]?.pid !== gwp, 25_000)
        chaos.gateway_respawned = gwPidHistory[gwPidHistory.length - 1]?.pid !== gwp
        chaos.time_to_respawn_ms = chaos.gateway_respawned ? gwPidHistory[gwPidHistory.length - 1].at - tKill : null
        chaos.stream_resumed = await waitFor(() => streamStarts >= 2, 30_000)
      }
    } else if (scen === 'resize-storm') {
      chaos.loaded = await waitFor(() => streamDone, 180_000)
      if (chaos.loaded) await quiesce(quiesceMs)
      const pre = await forcedScreen()
      const preIdx = lastCodeIdx(pre)
      chaos.pre_storm_code_idx = preIdx
      const flaps = chaosSpec.flaps ?? 30
      const tStorm = now()
      let flapped = 0
      for (let i = 0; i < flaps && !exited; i++) {
        try {
          term.resize(i % 2 === 0 ? 80 : 120, i % 2 === 0 ? 20 : 40)
          flapped++
        } catch {
          break
        }
        await sleep(100)
      }
      try {
        if (!exited) term.resize(120, 40)
      } catch {
        /* gone */
      }
      chaos.flaps = flapped
      chaos.storm_ms = now() - tStorm
      await sleep(10_000) // settle
      chaos.ui_survived_storm = !exited
      const post = await forcedScreen()
      chaos.transcript_preserved = screenPreserves(post, preIdx)
      chaos.post_storm_screen_sha = sha256(post)
    } else if (scen === 'pty-eof') {
      chaos.loaded = await waitFor(() => streamDone, 180_000)
      if (chaos.loaded) await quiesce(quiesceMs)
      const gwp = gwPidHistory[gwPidHistory.length - 1]?.pid ?? gwPid
      chaos.gw_pid = gwp
      // Destroy the PTY master: the UI sees EOF/EIO + SIGHUP — the "terminal
      // window closed" case. Does it exit cleanly and reap its gateway?
      let how = null
      try {
        if (typeof term.destroy === 'function') {
          term.destroy()
          how = 'master destroy()'
        }
      } catch {
        /* ignore */
      }
      if (!how) {
        try {
          term.kill('SIGHUP')
          how = 'SIGHUP (no destroy())'
        } catch {
          how = 'failed'
        }
      }
      chaos.master_close = how
      const tEof = now()
      let uiGoneAt = null
      let gwGoneAt = null
      while (now() - tEof < 15_000) {
        if (uiGoneAt === null && !pidAlive(uiPid)) uiGoneAt = now()
        if (gwGoneAt === null && gwp && !pidAlive(gwp)) gwGoneAt = now()
        if (uiGoneAt !== null && (gwGoneAt !== null || !gwp)) break
        await sleep(100)
      }
      chaos.ui_exited_after_eof = uiGoneAt !== null
      chaos.ui_exit_after_eof_ms = uiGoneAt !== null ? uiGoneAt - tEof : null
      chaos.gateway_reaped = gwGoneAt !== null
      chaos.gateway_reaped_ms = gwGoneAt !== null ? gwGoneAt - tEof : null
    }

    chaos.ui_survived = uiPid ? pidAlive(uiPid) : !exited
    return chaos
  }

  const sessionStarted = await waitFor(() => sessionCreateAt !== null, 30_000)
  if (!sessionStarted && !exited) {
    events.push({ kind: 'error', message: 'no session.create within 30s', t_ms: now() - t0 })
  }

  if (mode === 'startup') {
    // settle: boot RPCs done + paint quiet
    await quiesce(quiesceMs)
    takeSample('final', 0, 0)
  } else if (mode === 'chaos') {
    result.chaos = await runChaos()
  } else {
    // wait for the stream to finish (or the UI to die — cap-hit IS a result)
    const ok = await waitFor(() => streamDone, runTimeoutMs, 100)
    if (ok) {
      await quiesce(quiesceMs)
      takeSample('final', doneInfo?.msgs ?? null, doneInfo?.events ?? null)
    }
  }

  if (mode === 'scroll' && !exited && streamDone) {
    // SGR wheel bursts at scroll.hz for scroll.seconds: first half UP, second half DOWN.
    const totalEvents = Math.round(scroll.hz * scroll.seconds)
    const interval = 1000 / scroll.hz
    const writeTimes = []
    recordDataTimestamps = true
    const cpuBefore = readProcSample(uiPid)
    const tScroll0 = now()
    for (let i = 0; i < totalEvents && !exited; i++) {
      const target = tScroll0 + i * interval
      const wait = target - now()
      if (wait > 0) await sleep(wait)
      const btn = i < totalEvents / 2 ? 64 : 65
      term.write(`\x1b[<${btn};60;20M`)
      writeTimes.push(now())
    }
    await quiesce(500)
    recordDataTimestamps = false
    const cpuAfter = readProcSample(uiPid)
    // latency: for each write, first data timestamp >= write time
    let j = 0
    for (const wt of writeTimes) {
      while (j < dataTimestamps.length && dataTimestamps[j] < wt) j++
      if (j < dataTimestamps.length) scrollLatencies.push(dataTimestamps[j] - wt)
    }
    result.scroll = {
      events_sent: writeTimes.length,
      responses: scrollLatencies.length,
      cpu_ticks: cpuBefore && cpuAfter ? cpuAfter.utime_ticks + cpuAfter.stime_ticks - cpuBefore.utime_ticks - cpuBefore.stime_ticks : null
    }
  }

  if (mode === 'digest' && !exited && streamDone) {
    // Force a full repaint via resize-jiggle, then digest the post-resize text.
    resetTail()
    term.resize(120, 39)
    await sleep(400)
    resetTail()
    term.resize(120, 40)
    await sleep(1200) // fixed window — a 1Hz status clock means true silence never comes
    digestText = normalizeForDigest(stripAnsi(tailBuf.join('')))
    digest = createHash('sha256').update(digestText).digest('hex')
  }

  // ── M7 input-to-echo latency ────────────────────────────────────────
  if (mode === 'echo' && !exited && streamDone) {
    await quiesce(quiesceMs)
    // 30 distinct printable chars. Excludes u/p/s and digits: the OpenTUI
    // status bar repaints "up: Ns" at 1Hz and those glyphs would false-match.
    // Detection runs on ANSI-STRIPPED accumulated output (raw chunks are full
    // of CSI finals like 'm'/'H' that would match almost any letter).
    const chars = [...'abcdefghijklmnoqrtvwxyzABCDEFG']
    const echoLat = []
    const firstChunkLat = []
    let capture = null
    const echoTap = term.onData(d => {
      if (!capture) return
      const t = now()
      if (capture.firstAt === null) capture.firstAt = t
      if (capture.matchedAt === null) {
        capture.acc += d
        if (stripAnsi(capture.acc).includes(capture.needle)) capture.matchedAt = t
      }
    })
    for (const c of chars) {
      if (exited) break
      capture = { needle: c, acc: '', matchedAt: null, firstAt: null }
      const tw = now()
      term.write(c)
      await waitFor(() => capture.matchedAt !== null, 440, 5)
      if (capture.matchedAt !== null) echoLat.push(capture.matchedAt - tw)
      if (capture.firstAt !== null) firstChunkLat.push(capture.firstAt - tw)
      const elapsed = now() - tw
      if (elapsed < 500) await sleep(500 - elapsed)
    }
    // Submit: \r → the fake gateway streams a tiny reply carrying "zqxjv";
    // write→marker-paint = input-to-first-token-paint (incl. the gateway hop).
    let submitMs = null
    if (!exited) {
      capture = { needle: 'zqxjv', acc: '', matchedAt: null, firstAt: null }
      const ts = now()
      term.write('\r')
      await waitFor(() => capture.matchedAt !== null, 8000, 10)
      if (capture.matchedAt !== null) submitMs = capture.matchedAt - ts
      await quiesce(500)
    }
    capture = null
    echoTap.dispose()
    result.echo = {
      keystrokes_sent: chars.length,
      keystrokes_matched: echoLat.length,
      echo_ms: { p50: quantile(echoLat, 0.5), p95: quantile(echoLat, 0.95), p99: quantile(echoLat, 0.99) },
      first_chunk_ms: { p50: quantile(firstChunkLat, 0.5), p95: quantile(firstChunkLat, 0.95) },
      submit_first_token_paint_ms: submitMs,
      latencies_ms: echoLat
    }
  }

  // ── total-pipeline CPU (read ticks while everything is still alive) ──
  if (mode === 'pipeline') {
    const clk = clkTck()
    const gwp = gwPidHistory[gwPidHistory.length - 1]?.pid ?? gwPid
    const lastGood = key => cpuSeries.filter(s => s[key] != null).at(-1)?.[key] ?? null
    const fin = {
      ui: cpuTicksOf(uiPid) ?? lastGood('ui'),
      gw: cpuTicksOf(gwp) ?? lastGood('gw'),
      tmux: cpuTicksOf(tmuxServerPid) ?? lastGood('tmux')
    }
    const toS = v => (v == null ? null : Math.round((v / clk) * 100) / 100)
    result.pipeline = {
      tmux_socket: tmuxSock,
      tmux_server_pid: tmuxServerPid,
      ui_pid: uiPid,
      gw_pid: gwp,
      clk_tck: clk,
      cpu_s: {
        ui: toS(fin.ui),
        gateway: toS(fin.gw),
        tmux_server: toS(fin.tmux),
        total: toS((fin.ui ?? 0) + (fin.gw ?? 0) + (fin.tmux ?? 0))
      },
      bytes_total: bytesOut,
      data_flowing: bytesOut > 0, // bytes MUST reach the harness PTY for tmux numbers to mean anything
      cpu_series: cpuSeries
    }
  }

  // M6 frame pacing from the recorded chunk timeline (cpu-paced/pipeline:
  // whole stream; scroll: wheel phase only).
  if (dataTimestamps.length > 1) {
    result.frame_pacing = framePacing(dataTimestamps, dataSizes)
  }

  await gracefulQuit()
  clearInterval(pollTimer)
  clearInterval(lagTimer)

  // pipeline: the dedicated tmux server dies with the run (ONLY this socket's
  // server — never the user's default tmux server).
  if (tmuxSock) {
    try {
      execFileSync('tmux', ['-L', tmuxSock, 'kill-server'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      /* already gone (normal: the server exits with its last session) */
    }
  }

  // chaos: orphan sweep — any gateway pid ever recorded (or the UI itself)
  // still alive after teardown is an orphan: record, then reap (specific pids
  // only — never a broad pkill).
  if (mode === 'chaos' && result.chaos) {
    await sleep(1000)
    const orphans = []
    const seen = new Set(gwPidHistory.map(e => e.pid))
    if (gwPid) seen.add(gwPid)
    for (const pid of seen) {
      if (pidAlive(pid)) {
        orphans.push({ pid, comm: commOf(pid), role: 'gateway' })
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          /* raced */
        }
      }
    }
    if (uiPid && pidAlive(uiPid)) {
      orphans.push({ pid: uiPid, comm: commOf(uiPid), role: 'ui' })
      try {
        process.kill(uiPid, 'SIGKILL')
      } catch {
        /* raced */
      }
    }
    result.chaos.orphans = orphans
    result.chaos.ui_exit = exited
  }

  // cap-hit determination
  const finalCg = lastCg
  let capHit = false
  let capHitBasis = null
  if ((memoryMax || opts.containerCap) && exited) {
    if ((finalCg?.oom_kill ?? 0) > 0) {
      capHit = true
      capHitBasis = 'memory.events oom_kill'
    } else {
      // journal fallback: systemd logs OOM kills on the scope
      try {
        const log = execFileSync(
          'journalctl',
          ['--user', '-q', '--no-pager', '-u', unitName, '--since', '-30min'],
          { encoding: 'utf8' }
        )
        if (/oom|OOM/i.test(log)) {
          capHit = true
          capHitBasis = 'journalctl scope oom record'
        }
      } catch {
        /* journal unavailable */
      }
      if (!capHit && exited.signal === 9 && !streamDone) {
        capHit = true
        capHitBasis = 'SIGKILL before stream completion (inferred)'
      }
    }
  }

  const lastSample = samples[samples.length - 1] ?? null
  const summary = {
    result: capHit
      ? 'cap_hit'
      : exited && !quitRequested && mode !== 'startup'
        ? streamDone
          ? 'crashed_after_stream'
          : 'died'
        : 'completed',
    cap_hit: capHit,
    cap_hit_basis: capHitBasis,
    at_messages: capHit ? (samples.filter(s => s.kind === 'boundary').at(-1)?.msgs ?? null) : null,
    exit: exited,
    stream_done: streamDone,
    msgs_streamed: doneInfo?.msgs ?? samples.filter(s => s.kind === 'boundary').at(-1)?.msgs ?? 0,
    events_streamed: doneInfo?.events ?? null,
    pty_bytes_total: bytesOut,
    pty_data_callbacks: dataWrites,
    first_byte_ms: firstByteAt ? firstByteAt - t0 : null,
    session_create_ms: sessionCreateAt ? sessionCreateAt - t0 : null,
    stream_start_ms: streamStartT ? streamStartT - t0 : null,
    vmhwm_kb: lastSample?.vmhwm_kb ?? null,
    cg_peak: finalCg?.peak ?? null,
    drain_max_loop_lag_ms: maxLoopLagMs,
    drain_lag_violations: lagViolations,
    drain_ok: lagViolations === 0,
    digest,
    scroll_latencies_ms: scrollLatencies.length ? scrollLatencies : undefined,
    ...result
  }

  const out = {
    meta: {
      cell,
      ui,
      config: configName,
      mode,
      rep,
      run_id: runId,
      utc: new Date(t0).toISOString(),
      sha: gitSha(),
      node: NODE26_BIN,
      node_version: nodeVersion(),
      pty: { cols: 120, rows: 40, term: 'xterm-256color' },
      heap_mb: heapMb,
      memory_max: memoryMax,
      container_cap: Boolean(opts.containerCap),
      container_memory: opts.containerMemory ?? null,
      opentui_cap: opentuiCap,
      fixture: { path: fixturePath, msgs: fixtureMsgs, sha256: fixtureSha },
      sample_every: sampleEvery,
      mode_params:
        mode === 'cpu-paced' || mode === 'pipeline'
          ? { rate: pacedRate }
          : mode === 'scroll'
            ? scroll
            : mode === 'chaos'
              ? chaosSpec
              : {},
      ui_pid: uiPid,
      gw_pid: gwPid,
      cgroup: cgPath,
      load_avg_at_start: loadAvg(),
      instrumented: Boolean(opts.inkNodeSampler)
    },
    samples,
    events,
    summary
  }
  if (digestText !== null) out.digest_text = digestText
  // Postmortem: keep the stripped tail of the PTY stream for any run that
  // didn't complete cleanly (crash diagnostics — small, bounded).
  if (summary.result !== 'completed') out.pty_tail = stripAnsi(tailBuf.join('')).slice(-4000)
  if (nodeSampleFile) {
    try {
      out.node_samples = readFileSync(nodeSampleFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(l => JSON.parse(l))
    } catch {
      out.node_samples = []
    }
    try {
      unlinkSync(nodeSampleFile)
    } catch {
      /* ignore */
    }
  }

  try {
    unlinkSync(progressFile)
  } catch {
    /* ignore */
  }
  try {
    unlinkSync(activeSessionFile)
  } catch {
    /* ignore */
  }
  if (gwPidFile) {
    for (const f of [gwPidFile, `${gwPidFile}.dieflag`]) {
      try {
        unlinkSync(f)
      } catch {
        /* ignore */
      }
    }
  }

  if (outFile) {
    mkdirSync(dirname(outFile), { recursive: true })
    writeFileSync(outFile, JSON.stringify(out, null, 1))
  }
  return out
}

let _sha = null
function gitSha() {
  if (_sha) return _sha
  try {
    _sha = execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    _sha = 'unknown'
  }
  return _sha
}

function nodeVersion() {
  try {
    return execFileSync(NODE26_BIN, ['--version'], { encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}

export function loadAvg() {
  try {
    return readFileSync('/proc/loadavg', 'utf8').split(' ').slice(0, 3).map(Number)
  } catch {
    return null
  }
}

export function fixtureCacheDir() {
  const dir = join(here, '.cache')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}
