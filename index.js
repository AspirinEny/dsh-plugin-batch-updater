/**
 * dsh-batch-updater — Host half.
 *
 * Two jobs, both over `ctx.pluginManager`:
 *
 *  1. Check: `listBundles()` -> the bundles the manager marks `updatable` ->
 *     `listVersions()` for each of them -> the newest version that can actually
 *     be installed here (declares a bundle, is not deprecated, does not need a
 *     newer DSH, and is not a prerelease unless asked for).
 *  2. Apply: `updateBundle(name, version)` for each, strictly one after another.
 *     The profile lock allows one pnpm run at a time and an update is a removal
 *     plus an installation, so a batch is a queue, never a fan-out. A failure
 *     is recorded and the queue continues.
 *
 * The browser half reads this module's state over one exact route registered on
 * `connection.fetch`, which already applies the Host's own origin fence and
 * browser login. Nothing here is model-facing.
 */

import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

export const name = 'dsh-batch-updater'
/** No hard dependency: the row stays inactive where nothing it needs exists. */
export const inject = []

/**
 * The settings the Plugin Manager renders for this row.
 *
 * `intervalMinutes` is `.volatile()`: the config editor writes it in place, the
 * plugin is *not* restarted, and the running instance reads the new value
 * through the handle. That distinction matters — an ordinary field restarts the
 * plugin, which tears down this route and every bit of state the page is
 * showing, and the page then looks broken.
 *
 * Schemastery is resolved synchronously here because the Loader reads `Config`
 * during activation; a top-level `await` would arrive too late.
 */
export const Config = buildConfigSchema()



const ROUTE_PATH = '/api/dsh-batch-updater/state'
const SELF_NAME = 'dsh-batch-updater'
const DEFAULT_INTERVAL_MINUTES = 360
const MIN_INTERVAL_MINUTES = 5
/** Let the profile finish booting before the first scheduled check competes with it. */
const BOOT_CHECK_DELAY_MS = 12_000

/** A source spec that is not a registry range, so `updateBundle` cannot replace it. */
const NON_REGISTRY_SPEC = /^(?:git\+|git:|file:|link:|https?:|github:|workspace:|portal:)/i

/**
 * Build the row's schema, or null when schemastery cannot be reached.
 * @returns the schema, or null.
 */
function buildConfigSchema() {
  const z = resolveSchemastery()
  if (typeof z?.object !== 'function') return null
  try {
    return z.object({
      intervalMinutes: z
        .number()
        .step(1)
        .min(5)
        .max(10080)
        .default(360)
        .description('How often to check for new plugin versions, in minutes.')
        .volatile(),
      autoApply: z
        .boolean()
        .default(false)
        .description('Install what a scheduled check finds, without asking. Keep this off to check only.'),
      includePrerelease: z
        .boolean()
        .default(false)
        .description('Offer prerelease versions as update targets.'),
    })
  } catch {
    return null
  }
}

/**
 * Load the Host's schemastery from wherever this copy of the plugin sits.
 *
 * A symlinked checkout resolves modules by its real path, so plain ESM `import`
 * and a `createRequire` rooted at the symlink can both miss the profile's
 * hoisted copy. Trying the profile directory and then walking up from this file
 * covers both layouts.
 *
 * @returns the schemastery namespace, or null.
 */
function resolveSchemastery() {
  const bases = [import.meta.url]
  const profileDir = process.env.DSH_PROFILE_DIR
  if (typeof profileDir === 'string' && profileDir !== '') {
    bases.push(pathToFileURL(join(profileDir, 'package.json')).href)
  }
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 8; depth += 1) {
    bases.push(pathToFileURL(join(dir, 'package.json')).href)
    dir = dirname(dir)
  }
  for (const base of bases) {
    try {
      const req = createRequire(base)
      const mod = req('@deepseek-ai/schemastery')
      const z = mod?.default ?? mod
      if (typeof z?.object === 'function') return z
    } catch {
      // Try the next base.
    }
  }
  return null
}

/**
 * Read a value that may be a plain value or a `volatile` handle.
 * @param value - the config field.
 * @returns the current value.
 */
function readVolatile(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    try {
      return value.get()
    } catch {
      return undefined
    }
  }
  return value
}

/**
 * Write a `volatile` config field in place, without restarting the plugin.
 * @param handle - the field's handle from `Config`.
 * @param next - the value to store.
 * @returns true when the write went through.
 */
function writeVolatile(handle, next) {
  if (handle === null || typeof handle !== 'object') return false
  const writer = handle[Symbol.for('cosmokit.volatile.write')]
  if (typeof writer !== 'function') return false
  try {
    writer(next)
    return true
  } catch {
    return false
  }
}

/**
 * Read the row's config with defaults.
 * @param raw - the value the Loader passed to `apply`.
 * @returns a complete, validated config.
 */
function normalizeConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const minutes = Number(readVolatile(input.intervalMinutes))
  const skip = Array.isArray(input.skip)
    ? input.skip.filter((value) => typeof value === 'string' && value.trim() !== '')
    : []
  return {
    intervalMinutes:
      Number.isFinite(minutes) && minutes >= MIN_INTERVAL_MINUTES
        ? Math.floor(minutes)
        : DEFAULT_INTERVAL_MINUTES,
    autoApply: input.autoApply === true,
    includePrerelease: input.includePrerelease === true,
    skip,
  }
}

/**
 * Decide whether a bundle is one the user installed themselves.
 *
 * Only those belong on this page. The installation ships roughly two dozen
 * official bundles of its own, and counting them made "checked N plugins"
 * report a number the user could not recognise from their own plugin list.
 *
 * @param bundle - one entry from `pluginManager.listBundles()`.
 * @returns true when the bundle is a profile dependency the user owns.
 */
function isUserInstalled(bundle) {
  if (bundle === null || typeof bundle !== 'object') return false
  if (typeof bundle.name !== 'string' || bundle.name === '') return false
  if (bundle.official === true) return false
  // `availability: 'profile'` is the manager saying the profile's own
  // dependencies hold this package; 'installation' is the copy dsh shipped.
  if (bundle.availability !== 'profile') return false
  return true
}

/**
 * Explain why a bundle is out of scope, or answer null when it may be updated.
 * @param bundle - one entry from `pluginManager.listBundles()`.
 * @param cfg - the normalized config.
 * @returns the reason it is skipped, or null.
 */
function skipReasonFor(bundle, cfg) {
  if (bundle === null || typeof bundle !== 'object') return 'unreadable'
  const name = typeof bundle.name === 'string' ? bundle.name : ''
  if (name === '') return 'unreadable'
  if (name === SELF_NAME) return 'self'
  if (cfg().skip.includes(name)) return 'skipped-by-config'
  // The manager itself already answers false for git, path, tarball and
  // installation-provided bundles; these checks keep the reason visible.
  if (bundle.updatable !== true) {
    if (bundle.official === true) return 'official'
    const source = typeof bundle.source === 'string' ? bundle.source.trim() : ''
    if (source !== '' && NON_REGISTRY_SPEC.test(source)) return 'not-from-registry'
    return 'not-updatable'
  }
  if (bundle.official === true) return 'official'
  return null
}

/**
 * Pick the version a batch may install: versions arrive newest first, so the
 * first one that passes every admission rule is the target.
 * @param versions - `PluginVersion[]` from `listVersions()`.
 * @param includePrerelease - whether prereleases may be installed.
 * @returns the chosen version, or undefined.
 */
function pickTarget(versions, includePrerelease) {
  if (!Array.isArray(versions)) return undefined
  for (const version of versions) {
    if (version === null || typeof version !== 'object') continue
    if (version.bundle !== true) continue
    if (typeof version.deprecated === 'string' && version.deprecated !== '') continue
    if (version.incompatible !== undefined && version.incompatible !== null) continue
    if (version.prerelease === true && includePrerelease !== true) continue
    if (typeof version.version !== 'string' || version.version === '') continue
    return version
  }
  return undefined
}

/**
 * Say why a listed-but-blocked bundle has no installable target, for the UI.
 * @param versions - the same list `pickTarget` saw.
 * @returns a short reason, or null when the list was simply empty.
 */
function explainNoTarget(versions) {
  if (!Array.isArray(versions) || versions.length === 0) return null
  let needsDsh = null
  let deprecated = 0
  let notBundles = 0
  let prerelease = 0
  for (const version of versions) {
    if (version === null || typeof version !== 'object') continue
    if (version.bundle !== true) {
      notBundles += 1
      continue
    }
    if (typeof version.deprecated === 'string' && version.deprecated !== '') {
      deprecated += 1
      continue
    }
    if (version.incompatible !== undefined && version.incompatible !== null) {
      needsDsh ??= version.incompatible
      continue
    }
    if (version.prerelease === true) {
      prerelease += 1
      continue
    }
  }
  if (needsDsh !== null && typeof needsDsh === 'object') {
    const runtime = typeof needsDsh.runtimeVersion === 'string' ? needsDsh.runtimeVersion : ''
    return runtime === '' ? 'needs-newer-dsh' : `needs-newer-dsh:${runtime}`
  }
  if (prerelease > 0) return 'prerelease-only'
  if (deprecated > 0) return 'deprecated-only'
  if (notBundles > 0) return 'target-is-not-a-bundle'
  return null
}

/**
 * Turn whatever was thrown into one line the UI can show.
 * @param error - the thrown value.
 * @returns a message.
 */
function messageOf(error) {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/**
 * Map one `PluginUpdateResult` to the outcome the page shows.
 * @param result - the manager's answer.
 * @returns a stable outcome key plus an optional detail.
 */
function outcomeOf(result) {
  const change = result?.result ?? {}
  const application = typeof change.application === 'string' ? change.application : 'failed'
  const code = typeof change.error?.code === 'string' ? change.error.code : ''
  const step = typeof result?.step === 'string' ? result.step : ''
  if (application === 'applied') return { outcome: 'applied', code: '', step }
  if (application === 'restart-required') return { outcome: 'restart-required', code: '', step }
  if (application === 'cancelled') return { outcome: 'cancelled', code, step }
  if (application === 'overridden') return { outcome: 'overridden', code, step }
  return { outcome: 'failed', code: code === '' ? `failed-at-${step || 'unknown'}` : code, step }
}

/**
 * Register the schedule, the route, and the state machine on this row's context.
 * @param ctx - the Host plugin context.
 * @param config - the row's config.
 */
export function apply(ctx, config) {
  /**
   * The settings in force right now.
   *
   * `intervalMinutes` is a `volatile` handle, so the value can change while the
   * plugin keeps running; reading through `normalizeConfig` each time means the
   * timer, the check and the page never disagree about it.
   * @returns a complete config snapshot.
   */
  const cfg = () => normalizeConfig(config)
  // One line at activation: a profile that set `config:` in its row can confirm
  // here that the value arrived, without reading any state the page shows.
  ctx.logger?.info?.(
    'dsh-batch-updater: interval %d min, autoApply %s, prerelease %s, skip %d',
    cfg().intervalMinutes,
    String(cfg().autoApply),
    String(cfg().includePrerelease),
    cfg().skip.length,
  )

  /** The manager service, present only while the profile composes it. */
  let manager
  /** The one check in flight, shared by the timer, the route and the button. */
  let checking = null
  /** The one batch in flight. */
  let running = null
  /** The request id of the item the batch is currently installing. */
  let activeRequestId = null

  const state = {
    lastCheckAt: null,
    lastCheckError: null,
    checked: 0,
    plugins: [],
    updatable: [],
    blocked: [],
    run: null,
    stale: false,
  }

  /**
   * Read the user's own bundles and work out which ones can move.
   *
   * Every user-installed bundle gets a row, whether or not it can move: a page
   * that empties itself when nothing is out of date tells the user nothing, and
   * looks broken. Only the bundles the installation ships and profile-selected
   * names it cannot address are left out entirely.
   *
   * @returns the updatable list, or throws with the reason.
   */
  async function checkNow() {
    if (manager === undefined) throw new Error('plugin manager is not available')
    const bundles = await manager.listBundles()
    const all = Array.isArray(bundles) ? bundles : []
    const mine = all.filter(isUserInstalled)
    const plugins = []
    const updatable = []
    const blocked = []
    for (const bundle of mine) {
      const installedVersion = typeof bundle.version === 'string' ? bundle.version : ''
      const row = {
        name: bundle.name,
        installedVersion,
        enabled: bundle.enabled === true,
        targetVersion: null,
        registry: null,
        state: 'current',
        reason: null,
      }
      const skip = skipReasonFor(bundle, cfg)
      if (skip !== null) {
        row.state = 'blocked'
        row.reason = skip
        plugins.push(row)
        blocked.push({ name: bundle.name, reason: skip })
        continue
      }
      let versions
      try {
        versions = await manager.listVersions(bundle.name)
      } catch (error) {
        row.state = 'blocked'
        row.reason = `version-lookup-failed:${messageOf(error)}`
        plugins.push(row)
        blocked.push({ name: bundle.name, reason: row.reason })
        continue
      }
      if (versions?.status !== 'listed') {
        const reason = typeof versions?.reason === 'string' ? versions.reason : 'version-lookup-refused'
        row.state = 'blocked'
        row.reason = reason
        plugins.push(row)
        blocked.push({ name: bundle.name, reason })
        continue
      }
      const target = pickTarget(versions.versions, cfg().includePrerelease)
      if (target === undefined) {
        const why = explainNoTarget(versions.versions)
        if (why !== null) {
          row.state = 'blocked'
          row.reason = why
          blocked.push({ name: bundle.name, reason: why })
        }
        plugins.push(row)
        continue
      }
      row.state = 'updatable'
      row.targetVersion = target.version
      row.registry = typeof versions.registry === 'string' ? versions.registry : null
      plugins.push(row)
      updatable.push({
        name: bundle.name,
        installedVersion,
        targetVersion: target.version,
        registry: row.registry,
      })
    }
    state.checked = mine.length
    state.plugins = plugins
    state.updatable = updatable
    state.blocked = blocked
    state.lastCheckAt = Date.now()
    state.lastCheckError = null
    state.stale = false
    return updatable
  }

  /**
   * Run one check, sharing it with everyone who asks while it is in flight.
   * @returns the updatable list.
   */
  function refresh() {
    if (checking !== null) return checking
    checking = (async () => {
      try {
        return await checkNow()
      } catch (error) {
        state.lastCheckError = messageOf(error)
        state.lastCheckAt = Date.now()
        throw error
      } finally {
        checking = null
      }
    })()
    return checking
  }

  /**
   * Install one target and record what the manager answered.
   * @param item - the queued entry.
   * @param index - its position in the batch.
   * @param total - the batch length.
   * @param run - the batch record to update.
   */
  async function applyOne(item, index, total, run) {
    run.index = index
    run.current = { name: item.name, from: item.installedVersion, to: item.targetVersion, step: 'checking' }
    const requestId = `${SELF_NAME}-${run.startedAt}-${index}`
    activeRequestId = requestId
    try {
      const options = { requestId }
      if (typeof item.registry === 'string' && item.registry !== '') options.registry = item.registry
      const result = await manager.updateBundle(item.name, item.targetVersion, options)
      const detail = outcomeOf(result)
      run.results.push({
        name: item.name,
        from: item.installedVersion,
        to: item.targetVersion,
        outcome: detail.outcome,
        code: detail.code,
        step: detail.step,
        registry: item.registry ?? null,
      })
    } catch (error) {
      run.results.push({
        name: item.name,
        from: item.installedVersion,
        to: item.targetVersion,
        outcome: 'failed',
        code: 'threw',
        detail: messageOf(error),
        registry: item.registry ?? null,
      })
    } finally {
      activeRequestId = null
      run.current = null
    }
  }

  /**
   * Update exactly one bundle, reusing the batch machinery so the two paths
   * report progress the same way and can never run at the same time.
   * @param name - the package to update.
   * @param target - the exact version to move it to.
   * @param installed - the version it is on now, for the answer.
   * @param registry - the registry that answered the version lookup, if any.
   * @returns the batch record, or null when the name is not in the known list.
   */
  async function runOne(name, target, installed, registry) {
    if (running !== null) return running
    if (manager === undefined) throw new Error('plugin manager is not available')
    const item = {
      name,
      installedVersion: installed,
      targetVersion: target,
      registry: registry ?? null,
    }
    const run = {
      status: 'running',
      startedAt: Date.now(),
      finishedAt: null,
      total: 1,
      index: 0,
      current: null,
      results: [],
      single: name,
    }
    running = run
    state.run = run
    ;(async () => {
      try {
        await applyOne(item, 0, 1, run)
        run.status = run.status === 'cancelling' ? 'cancelled' : 'done'
      } catch (error) {
        run.status = 'failed'
        run.error = messageOf(error)
      } finally {
        run.finishedAt = Date.now()
        run.current = null
        running = null
        activeRequestId = null
        await refresh().catch(() => undefined)
      }
    })()
    return run
  }

  /**
   * Run one batch over an explicit queue, so "update all" and "update the
   * ticked rows" are the same code path with a different list.
   * @param queue - the entries to install, in order.
   * @param label - what the page should call this run.
   * @returns the batch record, or null when the queue is empty.
   */
  function startBatch(queue, label) {
    if (running !== null) return running
    if (queue.length === 0) return null
    const run = {
      status: 'running',
      startedAt: Date.now(),
      finishedAt: null,
      total: queue.length,
      index: 0,
      current: null,
      results: [],
      label,
    }
    running = run
    state.run = run
    ;(async () => {
      try {
        for (let index = 0; index < queue.length; index += 1) {
          if (run.status === 'cancelling') break
          await applyOne(queue[index], index, queue.length, run)
        }
        run.status = run.status === 'cancelling' ? 'cancelled' : 'done'
      } catch (error) {
        run.status = 'failed'
        run.error = messageOf(error)
      } finally {
        run.finishedAt = Date.now()
        run.current = null
        running = null
        activeRequestId = null
        // The profile changed under us: re-read it. A failure left its package
        // on the old version, so it reappears as updatable again.
        await refresh().catch(() => undefined)
      }
    })()
    return run
  }

  /**
   * Update every queued bundle, one after another, and keep going after a failure.
   * @returns the batch record, or null when there is nothing to do.
   */
  async function runAll() {
    if (running !== null) return running
    if (manager === undefined) throw new Error('plugin manager is not available')
    if (state.updatable.length === 0) {
      await refresh().catch(() => undefined)
    }
    const queue = state.updatable.map((item) => ({ ...item }))
    if (queue.length === 0) return null
    state.updatable = []
    return startBatch(queue, 'all')
  }

  /**
   * Update just the rows the page ticked.
   * @param names - the package names the user selected.
   * @returns the batch record, or null when none of them can move.
   */
  async function runSelected(names) {
    if (running !== null) return running
    if (manager === undefined) throw new Error('plugin manager is not available')
    const wanted = new Set(Array.isArray(names) ? names : [])
    const queue = state.updatable.filter((item) => wanted.has(item.name)).map((item) => ({ ...item }))
    if (queue.length === 0) return null
    state.updatable = state.updatable.filter((item) => !wanted.has(item.name))
    return startBatch(queue, 'selected')
  }

  /**
   * Ask the manager to stop the item being installed right now.
   * @returns the cancellation status, or 'not-running'.
   */
  async function cancel() {
    if (running === null) return 'not-running'
    if (activeRequestId === null) {
      running.status = 'cancelling'
      return 'queued'
    }
    try {
      const answer = await manager.cancelInstall(activeRequestId)
      const status = answer?.status ?? 'not-running'
      // `too-late` means this one bundle is past the point of stopping, but the
      // user still asked to stop: finish the item and drop the rest of the queue.
      if (status !== 'not-running') running.status = 'cancelling'
      return status
    } catch (error) {
      return `failed:${messageOf(error)}`
    }
  }

  /**
   * The state the browser half renders.
   * @returns a plain JSON snapshot.
   */
  function snapshot() {
    return {
      ok: true,
      available: manager !== undefined,
      checkedAt: state.lastCheckAt,
      checkError: state.lastCheckError,
      checking: checking !== null,
      stale: state.stale,
      checked: state.checked,
      plugins: state.plugins,
      updatable: state.updatable,
      blocked: state.blocked,
      run: state.run,
      config: {
        intervalMinutes: cfg().intervalMinutes,
        autoApply: cfg().autoApply,
        includePrerelease: cfg().includePrerelease,
      },
    }
  }

  /**
   * Save a new schedule and apply it without restarting the plugin.
   *
   * `intervalMinutes` is `volatile`, so both halves of this are safe: writing
   * the field's own handle updates the running instance in place, and
   * `settings.update` — the same path the Configure form uses — persists it
   * without a reload. Either one alone would be wrong: `configEditor.edit`
   * restarts the plugin and tears down every bit of state the page is showing
   * (that was the "save, then the list vanishes" bug), and a volatile write by
   * itself is forgotten on the next start.
   *
   * Persistence is best-effort: a profile without the settings service, or one
   * that refuses the write, still gets the new schedule for this process rather
   * than a failed save.
   *
   * @param minutes - the requested interval.
   * @returns `{ applied, persisted }`, or null when the value is out of range.
   */
  async function setIntervalMinutes(minutes) {
    const next = Number(minutes)
    if (!Number.isFinite(next) || next < MIN_INTERVAL_MINUTES) return null
    const rounded = Math.floor(next)
    const handle = config !== null && typeof config === 'object' ? config.intervalMinutes : undefined
    if (!writeVolatile(handle, rounded)) return null
    rearm()
    const persisted = await persistInterval(rounded)
    return { applied: true, persisted }
  }

  /**
   * Write the interval into the profile through the settings service.
   * @param minutes - the value to store.
   * @returns true when it was written.
   */
  async function persistInterval(minutes) {
    const settings = ctx.get('settings')
    if (settings === undefined || typeof settings.describe !== 'function') return false
    let descriptors
    try {
      descriptors = settings.describe()
    } catch {
      return false
    }
    if (!Array.isArray(descriptors)) return false
    // The namespace is the profile entry id, which is addressable in more than
    // one form depending on how the row was installed; ask each in turn.
    const candidates = [SELF_NAME, `include:${SELF_NAME}`, ctx.fiber?.entry?.id].filter(
      (value) => typeof value === 'string' && value !== '',
    )
    for (const ns of candidates) {
      const found = descriptors.find((entry) => String(entry?.ns) === ns)
      if (found === undefined) continue
      try {
        await settings.update(ns, { intervalMinutes: minutes }, found.revision)
        return true
      } catch {
        // Try the next spelling.
      }
    }
    return false
  }

  /** Re-arm the schedule after the interval changed. */
  function rearm() {
    if (typeof rearmRef === 'function') rearmRef()
  }

  /** Replaced once the schedule effect is installed. */
  let rearmRef = null

  /**
   * The one scheduled pass: check, then apply when the profile asked for that.
   */
  async function scheduledPass() {
    if (manager === undefined) return
    if (running !== null) return
    try {
      const updatable = await refresh()
      if (cfg().autoApply && Array.isArray(updatable) && updatable.length > 0) {
        await runAll()
      }
    } catch {
      // The failure is already in `state.lastCheckError`, which the page shows.
    }
  }

  ctx.inject(['pluginManager'], (scoped) => {
    manager = scoped.get('pluginManager')
    scoped.effect(
      () => () => {
        manager = undefined
      },
      'dsh-batch-updater: manager release',
    )
    scoped.effect(() => {
      let timers = []
      /** (Re)build both timers from the interval in force right now. */
      const arm = () => {
        for (const timer of timers) clearTimeout(timer)
        timers = []
        const boot = setTimeout(() => void scheduledPass(), BOOT_CHECK_DELAY_MS)
        if (typeof boot.unref === 'function') boot.unref()
        timers.push(boot)
        const period = Math.max(MIN_INTERVAL_MINUTES, cfg().intervalMinutes) * 60_000
        const ticker = setInterval(() => void scheduledPass(), period)
        if (typeof ticker.unref === 'function') ticker.unref()
        timers.push(ticker)
      }
      arm()
      rearmRef = arm
      return () => {
        rearmRef = null
        for (const timer of timers) clearTimeout(timer)
        timers = []
      }
    }, 'dsh-batch-updater: schedule')
    return () => {
      manager = undefined
    }
  })

  ctx.inject(['connection'], (scoped) => {
    const connection = scoped.get('connection')
    if (typeof connection?.fetch?.register !== 'function') return
    scoped.effect(
      () =>
        connection.fetch.register({
          path: ROUTE_PATH,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: async (request) => {
            let body
            try {
              body = await request.json()
            } catch {
              body = {}
            }
            const action = typeof body?.action === 'string' ? body.action : 'state'
            const reply = (payload) =>
              Response.json(payload, { headers: { 'cache-control': 'no-store' } })
            try {
              if (action === 'refresh') {
                await refresh().catch(() => undefined)
                return reply(snapshot())
              }
              if (action === 'updateAll') {
                if (manager === undefined) {
                  return reply({ ok: false, code: 'unavailable', message: 'plugin manager is not available' })
                }
                const run = await runAll()
                if (run === null) return reply(snapshot())
                return reply({ ...snapshot(), started: true })
              }
              if (action === 'updateSelected') {
                if (manager === undefined) {
                  return reply({ ok: false, code: 'unavailable', message: 'plugin manager is not available' })
                }
                const names = Array.isArray(body?.names) ? body.names.filter((v) => typeof v === 'string') : []
                if (names.length === 0) {
                  return reply({ ok: false, code: 'bad-request', message: 'updateSelected needs at least one name' })
                }
                const run = await runSelected(names)
                if (run === null) return reply(snapshot())
                return reply({ ...snapshot(), started: true })
              }
              if (action === 'setInterval') {
                const saved = await setIntervalMinutes(body?.minutes)
                if (saved === null) {
                  return reply({
                    ok: false,
                    code: 'bad-value',
                    message: `intervalMinutes must be between ${MIN_INTERVAL_MINUTES} and 10080 minutes`,
                  })
                }
                return reply({ ...snapshot(), persisted: saved.persisted })
              }
              if (action === 'updateOne') {
                if (manager === undefined) {
                  return reply({ ok: false, code: 'unavailable', message: 'plugin manager is not available' })
                }
                const name = typeof body?.name === 'string' ? body.name : ''
                const target = typeof body?.version === 'string' ? body.version : ''
                if (name === '' || target === '') {
                  return reply({ ok: false, code: 'bad-request', message: 'updateOne needs a name and a version' })
                }
                // Only versions the last check actually found may be installed,
                // so the page cannot ask for a target that was never verified.
                const known = state.updatable.find((row) => row.name === name && row.targetVersion === target)
                if (known === undefined) {
                  return reply({ ok: false, code: 'unknown-target', message: `${name}@${target} is not a checked target` })
                }
                const installed = known.installedVersion
                const registry = known.registry ?? null
                await runOne(name, target, installed, registry)
                return reply({ ...snapshot(), started: true })
              }
              if (action === 'retryFailed') {
                if (manager === undefined) {
                  return reply({ ok: false, code: 'unavailable', message: 'plugin manager is not available' })
                }
                const failed = (state.run?.results ?? []).filter((row) => row.outcome === 'failed')
                if (failed.length === 0) return reply(snapshot())
                const queue = failed.map((row) => ({
                  name: row.name,
                  installedVersion: row.from,
                  targetVersion: row.to,
                  registry: row.registry ?? null,
                }))
                const run = startBatch(queue, 'retry')
                if (run === null) return reply(snapshot())
                return reply({ ...snapshot(), started: true })
              }
              if (action === 'cancel') {
                const status = await cancel()
                return reply({ ...snapshot(), cancel: status })
              }
              return reply(snapshot())
            } catch (error) {
              return reply({ ok: false, code: 'internal', message: messageOf(error) })
            }
          },
        }),
      'dsh-batch-updater: state route',
    )
  })

  // Mirror the manager's own progress onto the item being installed.
  ctx.on('plugin-manager/update-state', (progress) => {
    const requestId = progress?.requestId
    if (activeRequestId === null || requestId !== activeRequestId) return
    if (running === null || running.current === null) return
    const step = typeof progress?.step === 'string' ? progress.step : ''
    if (step !== '') running.current.step = step
  })

  // A change we did not start still makes the list we showed stale. Marking it
  // rather than clearing the timestamp keeps the last good list visible; the
  // page offers "check now" instead of pretending it never checked.
  ctx.on('plugin-manager/changed', () => {
    if (running !== null) return
    state.stale = true
  })
}
