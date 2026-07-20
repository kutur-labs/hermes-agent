/**
 * E2E test: loading a large previous session re-renders the transcript
 * multiple times.
 *
 * The desktop's `resumeSession` path does up to three message-set passes
 * when loading a stored session:
 *
 *  1. Warm cache (if the runtime id is still live) → immediate paint
 *  2. `session.activate` projection → reconcileAuthoritativeMessages
 *  3. REST `getSessionMessages` persisted transcript → reconcile again
 *
 * Each pass calls `syncSessionStateToView` which replaces the `$messages`
 * atom, causing the assistant-ui thread to re-render the whole transcript.
 * On a large session (53 messages here) this is visible as a flicker —
 * the transcript appears, then gets replaced, then settles.
 *
 * This test seeds a real exported session (53 messages — 1 user, 11
 * assistant, 41 tool) into the sandbox's state.db BEFORE launching the app,
 * so the session appears in the sidebar on first load. It then clicks the
 * session row and instruments DOM mutations on the thread viewport to prove
 * the transcript DOM was rebuilt more than once during the load.
 *
 * Prerequisite: `npm run build` must have been run so dist/ exists.
 */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'

import { _electron, expect, type ElectronApplication, type Page, test } from '@playwright/test'

import {
  buildAppEnv,
  createSandbox,
  findElectron,
  launchDesktop,
  writeEnvFile,
  writeMockProviderConfig,
  waitForAppReady,
  type Sandbox,
} from './fixtures'
import { startMockServer } from './mock-server'

// ─── Constants ─────────────────────────────────────────────────────────

const DESKTOP_ROOT = path.resolve(import.meta.dirname, '..')
const REPO_ROOT = path.resolve(DESKTOP_ROOT, '..', '..')
const FIXTURE_PATH = path.resolve(import.meta.dirname, 'fixtures', 'large-session.json')
const SEED_SCRIPT = path.resolve(import.meta.dirname, 'scripts', 'seed_session_db.py')

const SESSION_TITLE = 'Auditing and Removing Brew Pip Support'

// ─── Fixture data ──────────────────────────────────────────────────────

/** The exported session from a real Hermes state.db (53 messages). */
function loadSessionFixture(): Record<string, unknown> {
  const raw = readFileSync(FIXTURE_PATH, 'utf8')
  return JSON.parse(raw) as Record<string, unknown>
}

// ─── Seeded mock backend fixture ───────────────────────────────────────

interface SeededMockBackendFixture {
  app: ElectronApplication
  page: Page
  mockUrl: string
  sandbox: Sandbox
  cleanup: () => Promise<void>
}

/**
 * Set up a mock-backend environment with a pre-seeded session in state.db.
 *
 * Like setupMockBackend but seeds the large-session.json fixture into the
 * sandbox's state.db BEFORE launching the app, so the session appears in
 * the sidebar on first load.
 */
async function setupSeededMockBackend(): Promise<SeededMockBackendFixture> {
  // 1. Start mock inference server
  const mock = await startMockServer()

  // 2. Create sandbox + write config
  const sandbox = createSandbox('seeded')
  writeMockProviderConfig(sandbox.hermesHome, mock.url)
  writeEnvFile(sandbox.hermesHome)

  // 3. Seed the state.db with the large session fixture BEFORE the app
  //    starts. The backend creates state.db on first run, but if it already
  //    exists with the right schema, the backend reuses it.
  const stateDbPath = path.join(sandbox.hermesHome, 'state.db')
  const pythonBin = spawnSync('which', ['python3'], { encoding: 'utf8' })
  const python = pythonBin.status === 0 ? pythonBin.stdout.trim() : 'python3'

  const seedResult = spawnSync(
    python,
    [SEED_SCRIPT, stateDbPath, FIXTURE_PATH],
    {
      encoding: 'utf8',
      cwd: REPO_ROOT,
      env: { ...process.env, PYTHONPATH: REPO_ROOT },
    },
  )

  if (seedResult.status !== 0) {
    throw new Error(
      `Failed to seed state.db:\nstdout: ${seedResult.stdout}\nstderr: ${seedResult.stderr}`,
    )
  }

  // 4. Build env + launch
  const env = buildAppEnv(sandbox)
  const { app, page } = await launchDesktop(env)

  return {
    app,
    page,
    mockUrl: mock.url,
    sandbox,
    cleanup: async () => {
      await app.close().catch(() => undefined)
      await mock.close()
      sandbox.cleanup()
    },
  }
}

// ─── Test ───────────────────────────────────────────────────────────────

let fixture: SeededMockBackendFixture | null = null

test.beforeAll(async () => {
  fixture = await setupSeededMockBackend()
  await waitForAppReady(fixture!, 120_000)
})

test.afterAll(async () => {
  await fixture?.cleanup()
  fixture = null
})

test.describe('loading a large previous session', () => {
  test('transcript re-renders multiple times during load', async () => {
    const page = fixture!.page

    // ── 1. Wait for the session to appear in the sidebar. The session was
    //    seeded into state.db before launch, so it appears once the session
    //    list loads (shortly after the gateway opens). We don't need to wait
    //    for the "Waking up" profile placeholder to disappear — that's the
    //    empty-chat area, not the sidebar.
    const sessionRow = page
      .locator('[data-slot="sidebar"] button')
      .filter({ hasText: SESSION_TITLE })
      .first()

    await sessionRow.waitFor({ state: 'visible', timeout: 60_000 })

    // ── 2. Instrument DOM rebuilds in the thread viewport during load.
    //    Each reconciliation pass in resumeSession replaces the $messages
    //    atom (warm cache → session.activate projection → REST persisted
    //    transcript), causing assistant-ui to tear down and rebuild the
    //    message DOM nodes. A MutationObserver catches these synchronous
    //    DOM mutations; we coalesce them into bursts (groups separated by
    //    a 30ms gap) — each burst is a distinct re-render cycle.
    //
    //    A single clean load would produce one burst. The bug produces
    //    2+ because the three reconciliation passes each rebuild the DOM.
    await page.evaluate(() => {
      const w = window as unknown as {
        __RENDER_COUNT__?: {
          bursts: number
          mutations: number
          timeline: { burst: number; time: number; mutations: number }[]
          stopped: boolean
        }
      }

      const state = {
        bursts: 0,
        mutations: 0,
        timeline: [] as { burst: number; time: number; mutations: number }[],
        stopped: false,
      }
      w.__RENDER_COUNT__ = state

      const viewport = document.querySelector('[data-slot="aui_thread-viewport"]')

      if (!viewport) {
        return
      }

      let currentBatch = 0
      let flushTimer: ReturnType<typeof setTimeout> | null = null

      const flush = () => {
        flushTimer = null
        if (currentBatch > 0 && !state.stopped) {
          state.bursts += 1
          state.timeline.push({ burst: state.bursts, time: Date.now(), mutations: currentBatch })
          currentBatch = 0
        }
      }

      const observer = new MutationObserver(records => {
        if (state.stopped) {
          return
        }

        let batchAdded = 0
        for (const record of records) {
          if (record.type === 'childList') {
            state.mutations += 1
            // Only count bursts that ADD nodes — the initial
            // setMessages([]) clear removes nodes (expected behavior),
            // but content-building re-renders add nodes. Each additive
            // burst is a separate paint of the transcript.
            if (record.addedNodes.length > 0) {
              batchAdded += 1
            }
          }
        }

        if (batchAdded > 0) {
          currentBatch += batchAdded
          if (flushTimer) {
            clearTimeout(flushTimer)
          }
          flushTimer = setTimeout(flush, 30)
        }
      })

      observer.observe(viewport, {
        childList: true,
        subtree: true,
        attributes: false,
        characterData: false,
      })
    })

    // ── 3. Click the session row to trigger resumeSession(). This is the
    //    action that triggers the multi-pass message loading.
    await sessionRow.click()

    // ── 4. Wait for the transcript to settle — message text should be
    //    visible in the thread viewport.
    await page.waitForFunction(
      () => {
        const vp = document.querySelector('[data-slot="aui_thread-viewport"]')

        if (!vp) {
          return false
        }

        const text = vp.textContent ?? ''

        // The session is about auditing brew/pip support — look for
        // a distinctive phrase from the conversation.
        return text.includes('audit') || text.includes('brew') || text.includes('packaging')
      },
      undefined,
      { timeout: 30_000 },
    )

    // ── 5. Take a screenshot of the loaded transcript.
    await page.screenshot({
      path: path.resolve(import.meta.dirname, '..', 'test-results', 'large-session-loaded.png'),
      fullPage: false,
    })

    // ── 6. Give the reconciliation passes time to complete. The three
    //    passes (warm cache → session.activate → REST persisted) each
    //    fire an async reconcile. Wait for the mutation bursts to settle
    //    — no new burst for 1 second means the load is done.
    await page.waitForFunction(
      () => {
        const w = window as unknown as {
          __RENDER_COUNT__?: {
            bursts: number
            timeline: { burst: number; time: number; mutations: number }[]
          }
        }

        const state = w.__RENDER_COUNT__

        if (!state) {
          return false
        }

        if (state.bursts === 0) {
          return false
        }

        const last = state.timeline[state.timeline.length - 1]

        return Date.now() - last.time > 1000
      },
      undefined,
      { timeout: 30_000 },
    )

    // ── 7. Stop counting and read the results.
    const results = await page.evaluate(() => {
      const w = window as unknown as {
        __RENDER_COUNT__?: {
          bursts: number
          mutations: number
          timeline: { burst: number; time: number; mutations: number }[]
          stopped: boolean
        }
      }

      const state = w.__RENDER_COUNT__

      if (state) {
        state.stopped = true
      }

      return state
        ? {
            bursts: state.bursts,
            mutations: state.mutations,
            timeline: state.timeline.map(t => ({ burst: t.burst, mutations: t.mutations })),
          }
        : null
    })

    // ── 8. Assert the bug: the transcript re-rendered more than once.
    //
    //    A single clean load would produce exactly one mutation burst —
    //    the initial DOM build. The bug produces 2+ bursts because the
    //    three reconciliation passes (warm cache, session.activate, REST
    //    persisted) each replace the $messages atom and rebuild the
    //    transcript DOM.
    expect(results, 'render count data should have been collected').not.toBeNull()

    if (results) {
      expect(
        results.bursts,
        `expected >= 2 mutation bursts (multiple re-renders during load), ` +
          `got ${results.bursts}: ${JSON.stringify(results.timeline)}`,
      ).toBeGreaterThanOrEqual(2)
    }
  })
})
