#!/usr/bin/env node
// Matrix runner — executes the protocol from docs/plans/opentui-bench-suite.md:
// golden-digest determinism gate first, then strictly SEQUENTIAL runs (one SUT
// at a time — this host has ~4.4GB free), A/B interleaved with randomized
// per-rep config order, 10s cooldowns, load-avg gate recorded, results to
// bench/results/<utc>-<sha7>-<cell>-<ui>-<config>-r<rep>.json.
//
// Usage:
//   node run.mjs --cell gate|mem3000|slope10k|nodes|cpu|scroll|startup|chaos|pipeline|echo
//   node run.mjs --all            (the full E1 host sequence, gate first)
// Knobs: --reps N, --msgs N, --cap 2G|none, --seed N

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { generate } from './fixture-stream.mjs'
import { loadAvg, NODE26_BIN, REPO_ROOT, runScenario } from './harness.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const RESULTS_DIR = join(here, 'results')
const CACHE_DIR = join(here, '.cache')

const CONFIGS = {
  ink: { ui: 'ink', opentuiCap: null },
  'otui-capped': { ui: 'opentui', opentuiCap: 3000 },
  'otui-uncapped': { ui: 'opentui', opentuiCap: 100000 }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// Deterministic shuffle (mulberry32) so the randomized pair order is recorded
// and reproducible from the seed in each result's meta.
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function shuffled(arr, rand) {
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

function sha7() {
  try {
    return execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', '--short=7', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}

function outFileFor(cell, config, rep) {
  const utc = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)
  return join(RESULTS_DIR, `${utc}-${sha7()}-${cell}-${CONFIGS[config].ui}-${config}-r${rep}.json`)
}

async function ensureFixture(msgs) {
  const path = join(CACHE_DIR, `fixture-${msgs}.ndjson`)
  const metaPath = `${path}.meta.json`
  if (existsSync(path) && existsSync(metaPath)) return JSON.parse(readFileSync(metaPath, 'utf8'))
  const info = await generate(msgs, path)
  writeFileSync(metaPath, JSON.stringify(info))
  return info
}

// Load gate: record load average; wait (bounded) for load1 < 1 per protocol.
async function loadGate() {
  for (let i = 0; i < 24; i++) {
    const la = loadAvg()
    if (!la || la[0] < 1) return la
    process.stdout.write(`  load gate: load1=${la[0]} — waiting\n`)
    await sleep(5000)
  }
  return loadAvg()
}

async function doRun(cell, config, rep, scenario) {
  const la = await loadGate()
  const outFile = outFileFor(cell, config, rep)
  process.stdout.write(`▶ ${cell} ${config} r${rep} (load1=${la?.[0]})\n`)
  const t0 = Date.now()
  const result = await runScenario({
    ...CONFIGS[config],
    configName: config,
    cell,
    rep,
    outFile,
    ...scenario
  })
  process.stdout.write(
    `  ✔ ${result.summary.result} in ${((Date.now() - t0) / 1000).toFixed(1)}s — rss=${(
      (result.samples.at(-1)?.rss_kb ?? 0) / 1024
    ).toFixed(0)}MB vmhwm=${((result.summary.vmhwm_kb ?? 0) / 1024).toFixed(0)}MB → ${outFile.split('/').pop()}\n`
  )
  await sleep(10_000) // cooldown
  return result
}

// ── cells ───────────────────────────────────────────────────────────────
async function cellGate(opts) {
  // Determinism gate: 2 digest replays per UI config; digests must match.
  const fx = await ensureFixture(opts.gateMsgs ?? 300)
  const digests = {}
  for (const config of ['ink', 'otui-capped']) {
    digests[config] = []
    for (let rep = 0; rep < 2; rep++) {
      const r = await doRun('gate', config, rep, {
        mode: 'digest',
        fixturePath: fx.path,
        fixtureMsgs: fx.msgs,
        fixtureSha: fx.sha256,
        memoryMax: null,
        heapMb: 8192,
        startDelayMs: 1200,
        quiesceMs: 700
      })
      digests[config].push(r.summary.digest)
    }
    const [a, b] = digests[config]
    if (!a || a !== b) {
      throw new Error(`DETERMINISM GATE FAILED for ${config}: ${a} != ${b}`)
    }
    process.stdout.write(`  gate OK ${config}: ${a.slice(0, 16)}…\n`)
  }
  return digests
}

async function cellMem(opts) {
  const msgs = opts.msgs ?? 3000
  const reps = opts.reps ?? 3
  const fx = await ensureFixture(msgs)
  const rand = rng(opts.seed ?? 20260611)
  const configs = opts.configs ?? Object.keys(CONFIGS)
  for (let rep = 0; rep < reps; rep++) {
    for (const config of shuffled(configs, rand)) {
      await doRun(`mem${msgs}`, config, rep, {
        mode: 'mem',
        fixturePath: fx.path,
        fixtureMsgs: fx.msgs,
        fixtureSha: fx.sha256,
        memoryMax: opts.cap === 'none' ? null : '2G',
        heapMb: opts.heap ?? 8192,
        runTimeoutMs: 45 * 60 * 1000
      })
    }
  }
}

async function cellSlope(opts) {
  const msgs = opts.msgs ?? 10000
  const fx = await ensureFixture(msgs)
  const rand = rng(opts.seed ?? 7)
  for (const config of shuffled(['ink', 'otui-uncapped'], rand)) {
    await doRun(`slope${msgs}`, config, 0, {
      mode: 'mem',
      fixturePath: fx.path,
      fixtureMsgs: fx.msgs,
      fixtureSha: fx.sha256,
      memoryMax: opts.cap === 'none' ? null : '2G',
      heapMb: 8192,
      runTimeoutMs: 90 * 60 * 1000
    })
  }
}

async function cellNodes(opts) {
  // Instrumented node-count runs — NEVER headlined. Ink: env-gated fd-3
  // sampler in the real binary over the PTY. OpenTUI: the existing headless
  // renderer-walk (scripts/mem-bench.tsx), labeled diagnostic.
  const msgs = opts.msgs ?? 3000
  const fx = await ensureFixture(msgs)
  await doRun(`nodes${msgs}`, 'ink', 0, {
    mode: 'mem',
    fixturePath: fx.path,
    fixtureMsgs: fx.msgs,
    fixtureSha: fx.sha256,
    memoryMax: '2G',
    heapMb: 8192,
    inkNodeSampler: true,
    runTimeoutMs: 45 * 60 * 1000
  })

  // OpenTUI headless renderer-walk (diagnostic-only by methodology).
  const benchDir = join(REPO_ROOT, 'ui-opentui/.bench')
  process.stdout.write('▶ nodes opentui headless mem-bench (diagnostic)\n')
  execFileSync(NODE26_BIN, ['scripts/build.mjs', 'scripts/mem-bench.tsx', '.bench'], {
    cwd: join(REPO_ROOT, 'ui-opentui'),
    stdio: 'inherit'
  })
  for (const [config, cap] of [
    ['otui-capped', '3000'],
    ['otui-uncapped', '100000']
  ]) {
    const stdout = execFileSync(
      NODE26_BIN,
      ['--experimental-ffi', '--expose-gc', '--no-warnings', join(benchDir, 'mem-bench.js')],
      {
        cwd: join(REPO_ROOT, 'ui-opentui'),
        encoding: 'utf8',
        env: { ...process.env, MEM_BENCH_TOTAL: String(msgs), MEM_BENCH_SAMPLE: '250', HERMES_TUI_MAX_MESSAGES: cap },
        maxBuffer: 64 * 1024 * 1024
      }
    )
    const outFile = outFileFor(`nodes${msgs}`, config, 0)
    // parse the table: pushes | msgs | rss | heapUsed | external | arrayBuf | activeAllocs | renderables
    const samples = []
    for (const line of stdout.split('\n')) {
      const m = line.match(/^\s*(\d+) \|\s*(\d+) \|\s*([\d.]+) \|\s*([\d.]+) \|\s*([\d.]+) \|\s*([\d.]+) \|\s*(\d+) \|\s*(\d+)/)
      if (m) {
        samples.push({
          kind: 'boundary',
          msgs: Number(m[1]),
          mounted_msgs: Number(m[2]),
          rss_kb: Math.round(Number(m[3]) * 1024),
          heap_mb: Number(m[4]),
          active_allocs: Number(m[7]),
          renderables: Number(m[8])
        })
      }
    }
    writeFileSync(
      outFile,
      JSON.stringify(
        {
          meta: {
            cell: `nodes${msgs}`,
            ui: 'opentui',
            config,
            mode: 'headless-membench',
            rep: 0,
            utc: new Date().toISOString(),
            sha: sha7(),
            instrumented: true,
            diagnostic_only: true,
            opentui_cap: Number(cap),
            fixture: { msgs }
          },
          samples,
          events: [],
          summary: { result: 'completed', headless: true },
          raw_stdout: stdout
        },
        null,
        1
      )
    )
    process.stdout.write(`  ✔ headless ${config} → ${outFile.split('/').pop()}\n`)
  }
}

async function cellCpu(opts) {
  const msgs = opts.msgs ?? 800
  const reps = opts.reps ?? 3
  const fx = await ensureFixture(msgs)
  const rand = rng(opts.seed ?? 99)
  for (let rep = 0; rep < reps; rep++) {
    for (const config of shuffled(Object.keys(CONFIGS), rand)) {
      await doRun(`cpu${msgs}`, config, rep, {
        mode: 'cpu-paced',
        pacedRate: 30,
        fixturePath: fx.path,
        fixtureMsgs: fx.msgs,
        fixtureSha: fx.sha256,
        memoryMax: '2G',
        heapMb: 8192,
        runTimeoutMs: 30 * 60 * 1000
      })
    }
  }
}

async function cellScroll(opts) {
  const msgs = opts.msgs ?? 3000
  const reps = opts.reps ?? 3
  const fx = await ensureFixture(msgs)
  const rand = rng(opts.seed ?? 31337)
  for (let rep = 0; rep < reps; rep++) {
    for (const config of shuffled(Object.keys(CONFIGS), rand)) {
      await doRun(`scroll${msgs}`, config, rep, {
        mode: 'scroll',
        scroll: { hz: 30, seconds: 15 },
        fixturePath: fx.path,
        fixtureMsgs: fx.msgs,
        fixtureSha: fx.sha256,
        memoryMax: '2G',
        heapMb: 8192,
        runTimeoutMs: 45 * 60 * 1000
      })
    }
  }
}

// ── chaos/stability cell ─────────────────────────────────────────────────
// 5 scenarios × {ink, otui-capped} = 10 sequential runs. The fake gateway
// self-SIGKILLs deterministically (HERMES_FAKE_DIE_AT) for the kill scenarios;
// SIGSTOP is external (harness reads HERMES_FAKE_PIDFILE). Auto-heal detection
// = pidfile rewrite by the respawned gateway. Results carry summary.chaos.
const CHAOS_SCENARIOS = ['gw-kill-stream', 'gw-kill-tool', 'gw-stop', 'resize-storm', 'pty-eof']

async function cellChaos(opts) {
  const msgs = opts.msgs ?? 300
  const half = Math.floor(msgs / 2)
  const fx = await ensureFixture(msgs)
  const configs = opts.configs ?? ['ink', 'otui-capped']
  const scenarios = opts.scenarios ?? CHAOS_SCENARIOS
  for (const config of configs) {
    for (const scenario of scenarios) {
      const chaos = { scenario }
      let extra = {}
      if (scenario === 'gw-kill-stream') chaos.dieAt = `${half}:kill`
      if (scenario === 'gw-kill-tool') chaos.dieAt = `${half}:tool-kill`
      if (scenario === 'gw-stop') {
        // paced so "mid-stream" exists long enough to land an external SIGSTOP
        chaos.stopAt = half
        chaos.fakeMode = 'paced'
        extra = { pacedRate: 120 }
      }
      await doRun('chaos', config, scenario, {
        mode: 'chaos',
        chaos,
        fixturePath: fx.path,
        fixtureMsgs: fx.msgs,
        fixtureSha: fx.sha256,
        memoryMax: '2G',
        heapMb: 8192,
        sampleEvery: 25,
        runTimeoutMs: 10 * 60 * 1000,
        ...extra
      })
    }
  }
}

// ── total-pipeline CPU cell (UI + gateway + tmux emulator leg) ───────────
// The user's real stack runs the TUI inside tmux; the UI runs in a dedicated
// `tmux -L hermes-bench-<runId>` server with the harness PTY attached as the
// client (unattached tmux skips most output work). Results carry
// summary.pipeline (cpu_s per process) + summary.frame_pacing (M6).
async function cellPipeline(opts) {
  const msgs = opts.msgs ?? 800
  const fx = await ensureFixture(msgs)
  for (const config of opts.configs ?? ['ink', 'otui-capped']) {
    await doRun('pipeline', config, 0, {
      mode: 'pipeline',
      pacedRate: 30,
      fixturePath: fx.path,
      fixtureMsgs: fx.msgs,
      fixtureSha: fx.sha256,
      memoryMax: '2G',
      heapMb: 8192,
      runTimeoutMs: 30 * 60 * 1000
    })
  }
}

// ── M7 input-to-echo latency cell ────────────────────────────────────────
// Load 100 msgs, idle, then 30 distinct keystrokes 500ms apart; latency =
// write → first PTY data whose ANSI-stripped text contains that char. Then
// one \r submit timed to the fake gateway's marker-token paint. Results
// carry summary.echo.
async function cellEcho(opts) {
  const msgs = opts.msgs ?? 100
  const fx = await ensureFixture(msgs)
  for (const config of opts.configs ?? ['ink', 'otui-capped']) {
    await doRun('echo', config, 0, {
      mode: 'echo',
      fixturePath: fx.path,
      fixtureMsgs: fx.msgs,
      fixtureSha: fx.sha256,
      memoryMax: '2G',
      heapMb: 8192,
      runTimeoutMs: 10 * 60 * 1000
    })
  }
}

async function cellStartup(opts) {
  const reps = opts.reps ?? 10
  const rand = rng(opts.seed ?? 4242)
  for (let rep = 0; rep < reps; rep++) {
    for (const config of shuffled(['ink', 'otui-capped'], rand)) {
      await doRun('startup', config, rep, {
        mode: 'startup',
        fixturePath: '',
        fixtureMsgs: 0,
        fixtureSha: '',
        memoryMax: null,
        heapMb: 8192,
        startDelayMs: 999999,
        quiesceMs: 700,
        runTimeoutMs: 60 * 1000
      })
    }
  }
}

// ── main ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const opt = name => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const opts = {
  reps: opt('reps') ? Number(opt('reps')) : undefined,
  msgs: opt('msgs') ? Number(opt('msgs')) : undefined,
  cap: opt('cap'),
  seed: opt('seed') ? Number(opt('seed')) : undefined,
  configs: opt('configs') ? opt('configs').split(',').filter(c => CONFIGS[c]) : undefined,
  scenarios: opt('scenarios') ? opt('scenarios').split(',').filter(s => CHAOS_SCENARIOS.includes(s)) : undefined,
  heap: opt('heap') ? Number(opt('heap')) : undefined
}
const cell = opt('cell')
mkdirSync(RESULTS_DIR, { recursive: true })

const CELLS = {
  gate: cellGate,
  mem3000: cellMem,
  slope10k: cellSlope,
  nodes: cellNodes,
  cpu: cellCpu,
  scroll: cellScroll,
  startup: cellStartup,
  chaos: cellChaos,
  pipeline: cellPipeline,
  echo: cellEcho
}

if (args.includes('--all')) {
  await cellGate(opts)
  await cellStartup(opts)
  await cellMem(opts)
  await cellCpu(opts)
  await cellScroll(opts)
  await cellNodes(opts)
  await cellSlope(opts)
} else if (cell && CELLS[cell]) {
  await CELLS[cell](opts)
} else {
  process.stdout.write(`usage: node run.mjs --cell ${Object.keys(CELLS).join('|')} [--reps N --msgs N --cap none --seed N]\n`)
  process.exit(cell ? 1 : 0)
}
