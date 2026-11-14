/**
 * dsh-batch-updater — Host half.
 *
 * Two jobs, both over `ctx.pluginManager`:
 *
 *  1. Check: `listBundles()` -> the bundles the manager marks `update: 'registry'` ->
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
import { statSync } from 'node:fs'

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
/** An scp-like Git address such as `git@github.com:me/repo`, which `NON_REGISTRY_SPEC` does not cover. */
const GIT_SSH_SPEC = /^[\w.-]+@[\w.-]+:/

/**
 * A Git-hosted install: the forge and repository path a saved spec names.
 *
 * Only a forge this can address with a plain HTTP metadata read is handled.
 * `pnpm` saved the spec in whatever form it used, so the shorthand
 * (`github:owner/repo`), the HTTPS URL, the `git+` prefixed URL, and the
 * scp-like SSH address all name the same repository and are read here as one.
 */
const GIT_FORGE = /^(?:(github|gitlab|bitbucket|gist):([^/#]+)\/([^/#]+?)|(?:git\+)?https?:\/\/([^/#]+)\/([^/#]+)\/([^/#]+?)|git@([^/:]+):([^/#]+)\/([^/#]+?))(?:\.git)?(?:#.*)?$/i

/** How long one metadata read may take before the row reports a network problem. */
const GIT_METADATA_TIMEOUT_MS = 8_000

/**
 * The HTTP reader `readHeadVersion` uses.
 *
 * A module-level binding so a test can answer without a network, and so the one
 * place that reaches out of the process is visible.
 */
let fetchText = (url) => httpFetch(url)

/**
 * Read one URL as text, bounded by the metadata timeout.
 * @param url - the address to read.
 * @returns the status and the body.
 */
async function httpFetch(url) {
  const answer = await fetch(url, {
    signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(GIT_METADATA_TIMEOUT_MS) : undefined,
    headers: { accept: 'application/json' },
  })
  return { status: answer.status, text: await answer.text() }
}

/** Replace the reader; tests use this, the Host never calls it. */
export function __setFetchText(next) {
  fetchText = typeof next === 'function' ? next : (url) => httpFetch(url)
}

/**
 * The `node_modules` directory this profile installs its packages into.
 * @returns the absolute directory, or null when the Host names no profile.
 */
function profileModulesDir() {
  const profileDir = process.env.DSH_PROFILE_DIR
  if (typeof profileDir !== 'string' || profileDir === '') return null
  return join(profileDir, 'node_modules')
}

/**
 * The moment a package was last installed or replaced in this profile.
 *
 * `pnpm` writes the package directory when it adds it, so the directory's own
 * modification time is when this copy landed — a reinstall refreshes it while a
 * plugin that was never touched keeps its original time. It is the closest thing
 * to an install record the profile keeps: `pnpm` writes no per-package stamp,
 * and the lockfile's time is the whole profile's.
 *
 * @param root - the profile's `node_modules` directory.
 * @param name - the package name, scoped or not.
 * @returns epoch milliseconds, or null when the directory cannot be read.
 */
function installedAtOf(root, name) {
  if (typeof root !== 'string' || root === '' || typeof name !== 'string' || name === '') return null
  try {
    return Math.round(statSync(join(root, name)).mtimeMs)
  } catch {
    return null
  }
}

/**
 * Read the repository a saved Git spec names.
 * @param source - the spec `listBundles()` reports as `source`.
 * @returns the host, owner, repository, and the web URL, or null when the spec
 *   is not a Git address this plugin can read metadata for.
 */
function gitSourceOf(source) {
  if (typeof source !== 'string') return null
  const text = source.trim()
  // A plain version range names a registry copy; only the Git forms carry a host.
  if (text === '' || (NON_REGISTRY_SPEC.test(text) === false && GIT_SSH_SPEC.test(text) === false)) return null
  const match = GIT_FORGE.exec(text)
  if (match === null) return null
  // Three shapes, told apart by which capture group filled: the forge shorthand
  // has no host of its own, the URL carries one, and the scp form carries one
  // after the user name.
  const shorthand = typeof match[1] === 'string' ? match[1].toLowerCase() : ''
  const hosts = { github: 'github.com', gitlab: 'gitlab.com', bitbucket: 'bitbucket.org', gist: 'gist.github.com' }
  const host = (hosts[shorthand] ?? match[4] ?? match[7] ?? '').toLowerCase()
  const owner = match[2] ?? match[5] ?? match[8] ?? ''
  const repo = match[3] ?? match[6] ?? match[9] ?? ''
  if (host === '' || owner === '' || repo === '') return null
  return { host, owner, repo, web: `https://${host}/${owner}/${repo}` }
}

/**
 * Read the `package.json` a Git repository publishes at its default branch.
 *
 * The raw file is what `pnpm` would install, so its `version` is the version a
 * reinstall would land on. Reading it needs no Git binary and no credentials for
 * a public repository, which is the case this page can decide on its own.
 *
 * @param source - the repository the spec names.
 * @param read - performs the HTTP request; injected so tests can answer.
 * @returns the manifest version, or a small reason the read did not answer.
 */
async function readHeadVersion(source, read) {
  const repo = gitSourceOf(source)
  if (repo === null) return { kind: 'unsupported' }
  if (repo.host !== 'github.com' && repo.host !== 'gitlab.com' && repo.host !== 'bitbucket.org') {
    // Only these forges serve a predictable raw file for a public repository.
    return { kind: 'unsupported', host: repo.host }
  }
  const path = repo.host === 'github.com'
    ? `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/HEAD/package.json`
    : repo.host === 'gitlab.com'
      ? `https://gitlab.com/${repo.owner}/${repo.repo}/-/raw/HEAD/package.json`
      : `https://bitbucket.org/${repo.owner}/${repo.repo}/raw/HEAD/package.json`
  try {
    const answer = await read(path)
    if (answer.status < 200 || answer.status >= 300) return { kind: 'not-found', status: answer.status }
    const manifest = JSON.parse(answer.text)
    if (typeof manifest?.version !== 'string' || manifest.version.trim() === '') return { kind: 'not-found' }
    return { kind: 'version', version: manifest.version.trim(), repo }
  } catch (error) {
    return { kind: 'network', message: messageOf(error), repo }
  }
}

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
      skip: z
        .array(z.string())
        .default([])
        .description('Package names this page must never touch.'),
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
  // DSH 0.2.2-rc.2 replaced `updatable: boolean` with `update: 'registry' | 'git'`.
  // Reading only the old field made every registry plugin look not-updatable, so
  // the page found nothing to update against 0.2.2-rc.2 and newer. Both are read.
  const source = typeof bundle.source === 'string' ? bundle.source.trim() : ''
  const updateKind =
    typeof bundle.update === 'string'
      ? bundle.update
      : // The retired boolean, which was also true for the Git copies it covered.
        bundle.updatable === true && !NON_REGISTRY_SPEC.test(source) && !GIT_SSH_SPEC.test(source)
        ? 'registry'
        : undefined
  // A Git copy is not updatable through `updateBundle` — that needs a pinned
  // commit this page cannot produce — but a public repository's version can
  // still be read, so it is reported separately rather than hidden as blocked.
  if (updateKind !== 'registry') {
    if (bundle.official === true) return 'official'
    // Only a source that names a readable repository earns a version check;
    // `link:`, `file:` and tarball installs have no upstream to ask.
    const git = source !== '' && gitSourceOf(source) !== null
    if (git) return 'git-installed'
    if (source !== '' && (NON_REGISTRY_SPEC.test(source) || GIT_SSH_SPEC.test(source))) return 'not-from-registry'
    return 'not-updatable'
  }
  if (bundle.official === true) return 'official'
  return null
}

/**
 * Pick the version a batch may install: versions arrive newest first, so the
 * first one that passes every admission rule is the target.
 *
 * A candidate equal to the installed version is not an update. The manager
 * normally omits it, but treating "same version" as a target would issue a
 * pointless remove-and-reinstall, so it is filtered here too.
 *
 * @param versions - `PluginVersion[]` from `listVersions()`.
 * @param includePrerelease - whether prereleases may be installed.
 * @param installedVersion - the version in place now.
 * @returns the chosen version, or undefined.
 */
function pickTarget(versions, includePrerelease, installedVersion) {
  if (!Array.isArray(versions)) return undefined
  for (const version of versions) {
    if (version === null || typeof version !== 'object') continue
    if (version.bundle !== true) continue
    if (typeof version.deprecated === 'string' && version.deprecated !== '') continue
    if (version.incompatible !== undefined && version.incompatible !== null) continue
    if (version.prerelease === true && includePrerelease !== true) continue
    if (typeof version.version !== 'string' || version.version === '') continue
    if (installedVersion !== '' && version.version === installedVersion) continue
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
  // A newer version whose install scripts were never approved fails here, and
  // the remedy is a one-off approval rather than a retry: say which builds.
  const pendingBuilds = Array.isArray(change.pendingBuilds)
    ? change.pendingBuilds.filter((value) => typeof value === 'string')
    : []
  if (application === 'applied') return { outcome: 'applied', code: '', step, pendingBuilds }
  if (application === 'restart-required') return { outcome: 'restart-required', code: '', step, pendingBuilds }
  if (application === 'cancelled') return { outcome: 'cancelled', code, step, pendingBuilds }
  if (application === 'overridden') return { outcome: 'overridden', code, step, pendingBuilds }
  return { outcome: 'failed', code: code === '' ? `failed-at-${step || 'unknown'}` : code, step, pendingBuilds }
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
    run: null,
    stale: false,
  }

  /**
   * The rows that can move right now.
   *
   * Derived from `plugins` rather than kept beside it: two lists drifting apart
   * is how a row keeps offering an Update button after the batch already took
   * it out of the queue.
   * @returns the updatable entries, in list order.
   */
  function updatableRows() {
    return state.plugins
      .filter((row) => row.state === 'updatable' || row.state === 'git-updatable')
      .map((row) => ({
        name: row.name,
        installedVersion: row.installedVersion,
        targetVersion: row.targetVersion,
        registry: row.registry ?? null,
        // `registry` items go through `updateBundle`; a Git source is removed
        // and installed again, which is the only way the manager can move it.
        git: row.state === 'git-updatable',
        source: row.source ?? null,
      }))
  }

  /**
   * Map several items through an async function, at most `limit` at a time.
   * @param items - the input list.
   * @param limit - how many may be in flight.
   * @param run - the async function.
   * @returns the results, in input order.
   */
  async function mapLimit(items, limit, run) {
    const results = new Array(items.length)
    let next = 0
    const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
      for (;;) {
        const index = next
        next += 1
        if (index >= items.length) return
        results[index] = await run(items[index], index)
      }
    })
    await Promise.all(workers)
    return results
  }

  /**
   * Compare two dotted numeric versions, the way `updateBundle` compares them.
   * @param a - one version.
   * @param b - the other.
   * @returns a negative number, zero, or a positive number.
   */
  function compareVersions(a, b) {
    const pa = String(a).split(/[.+-]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0)
    const pb = String(b).split(/[.+-]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0)
    for (let index = 0; index < 3; index += 1) {
      if (pa[index] !== pb[index]) return pa[index] - pb[index]
    }
    return 0
  }

  /**
   * Read a Git-installed plugin's repository version and build its row.
   *
   * `updateBundle` cannot replace this copy — it accepts a Git target only from a
   * dependency pinned to a full commit — so a Git row is installed by the pair
   * `removeBundle` + `installBundle`, which is what reinstalling it by hand does.
   *
   * @param bundle - one entry from `listBundles()`.
   * @param installedVersion - the version in place now.
   * @param settings - the config in force.
   * @param installedAt - when this copy landed, for the page's timestamp.
   * @returns the row the page renders.
   */
  async function gitRow(bundle, installedVersion, settings, installedAt) {
    const base = { name: bundle.name, installedVersion, installedAt, enabled: bundle.enabled === true, targetVersion: null, registry: null }
    if (settings.skip.includes(bundle.name)) return { ...base, state: 'blocked', reason: 'skipped-by-config' }
    const repo = gitSourceOf(bundle.source)
    if (repo === null) return { ...base, state: 'blocked', reason: 'git-unreadable' }
    const head = await readHeadVersion(bundle.source, fetchText)
    if (head.kind === 'unsupported') return { ...base, state: 'blocked', reason: 'git-unsupported-host', detail: repo.web }
    if (head.kind === 'not-found') return { ...base, state: 'blocked', reason: 'git-not-found', detail: repo.web }
    if (head.kind === 'network') return { ...base, state: 'blocked', reason: 'network', detail: repo.web }
    if (head.kind !== 'version') return { ...base, state: 'blocked', reason: 'git-unreadable', detail: repo.web }
    const newer = compareVersions(head.version, installedVersion) > 0
    return {
      ...base,
      state: newer ? 'git-updatable' : 'current',
      reason: newer ? 'git-updatable' : null,
      targetVersion: newer ? head.version : null,
      // Where it came from and how to install it again, which is all the row
      // needs: it moves through `removeBundle` + `installBundle`.
      source: typeof bundle.source === 'string' ? bundle.source : null,
      detail: repo.web,
    }
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
    const settings = cfg()
    // One read of the profile's node_modules, shared by every row.
    const modulesRoot = profileModulesDir()

    // Versions are read concurrently, but not all at once: each lookup is a
    // package-manager call, and a profile with a dozen plugins would otherwise
    // serialize a dozen round trips.
    const rows = await mapLimit(mine, 4, async (bundle) => {
      const installedVersion = typeof bundle.version === 'string' ? bundle.version : ''
      const installedAt = installedAtOf(modulesRoot, bundle.name)
      /** @type {null | string} */
      let reason = skipReasonFor(bundle, () => settings)
      if (reason === 'git-installed') return gitRow(bundle, installedVersion, settings, installedAt)
      if (reason !== null) {
        return { name: bundle.name, installedVersion, installedAt, enabled: bundle.enabled === true, targetVersion: null, registry: null, state: 'blocked', reason }
      }
      let versions
      try {
        versions = await manager.listVersions(bundle.name)
      } catch (error) {
        return { name: bundle.name, installedVersion, installedAt, enabled: bundle.enabled === true, targetVersion: null, registry: null, state: 'blocked', reason: `version-lookup-failed:${messageOf(error)}` }
      }
      if (versions?.status !== 'listed') {
        // `problem` is a small code ('not-found', 'network', ...) the page can
        // translate; `reason` is a full English sentence meant for a log.
        const problem = typeof versions?.problem === 'string' ? versions.problem : 'unknown'
        return { name: bundle.name, installedVersion, installedAt, enabled: bundle.enabled === true, targetVersion: null, registry: null, state: 'blocked', reason: problem }
      }
      const target = pickTarget(versions.versions, settings.includePrerelease, installedVersion)
      if (target === undefined) {
        reason = explainNoTarget(versions.versions)
        return {
          name: bundle.name,
          installedVersion,
          installedAt,
          enabled: bundle.enabled === true,
          targetVersion: null,
          registry: null,
          state: reason === null ? 'current' : 'blocked',
          reason,
        }
      }
      return {
        name: bundle.name,
        installedVersion,
        installedAt,
        enabled: bundle.enabled === true,
        targetVersion: target.version,
        registry: typeof versions.registry === 'string' ? versions.registry : null,
        state: 'updatable',
        reason: null,
      }
    })

    state.checked = mine.length
    state.plugins = rows
    state.lastCheckAt = Date.now()
    state.lastCheckError = null
    state.stale = false
    return updatableRows()
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
      // A Git copy has no `updateBundle` path: the manager accepts a Git target
      // only from a dependency pinned to a full commit, and this one is not
      // pinned. Removing it and installing the saved spec again is what a manual
      // reinstall does, and `installBundle` already restores the profile files
      // when the install fails.
      const result = item.git === true
        ? await reinstallFromGit(item)
        : await manager.updateBundle(item.name, item.targetVersion, options)
      const detail = outcomeOf(result)
      run.results.push({
        name: item.name,
        from: item.installedVersion,
        to: item.targetVersion,
        outcome: detail.outcome,
        code: detail.code,
        step: detail.step,
        registry: item.registry ?? null,
        git: item.git === true,
        source: item.source ?? null,
        pendingBuilds: detail.pendingBuilds.length > 0 ? detail.pendingBuilds : undefined,
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
        git: item.git === true,
        source: item.source ?? null,
      })
    } finally {
      activeRequestId = null
      run.current = null
      settleRow(item, run)
    }
  }

  /**
   * Replace a Git-installed bundle by removing it and installing its own spec.
   *
   * The removal is the risky half: a failed installation leaves nothing in place
   * of the removed copy. `installBundle` restores `package.json` and the
   * lockfile when *it* fails, so that covers a broken target, but a failure
   * between the two calls would not. The old spec is therefore reinstalled
   * explicitly when the install does not land.
   *
   * @param item - the queued Git entry, carrying the spec it was installed from.
   * @returns a result shaped like `updateBundle`'s, so the page reports it alike.
   */
  async function reinstallFromGit(item) {
    const source = typeof item.source === 'string' ? item.source : ''
    if (source === '') throw new Error(`${item.name} has no saved Git spec to reinstall from`)
    const removed = await manager.removeBundle(item.name)
    if (removed?.application === 'failed' || removed?.application === 'cancelled') {
      // Nothing was removed, so nothing was lost: report the removal's outcome.
      return { from: item.installedVersion, to: item.targetVersion, step: 'remove', result: removed }
    }
    let installed
    try {
      installed = await manager.installBundle(source)
    } catch (error) {
      // Put the removed copy back before reporting, otherwise the profile is
      // left without a plugin it had a moment ago.
      await manager.installBundle(source).catch(() => undefined)
      throw error
    }
    if (installed?.application === 'failed' || installed?.application === 'cancelled') {
      await manager.installBundle(source).catch(() => undefined)
    }
    return { from: item.installedVersion, to: item.targetVersion, step: 'install', result: installed }
  }

  /**
   * Fold a finished item into the list the page renders.
   *
   * Without this the row kept offering an Update button until the whole batch
   * ended, because the page only re-read the list once. Moving the row as soon
   * as its own install settles is what makes "Update all" visibly advance, and
   * it is also correct for the single-row path.
   *
   * @param item - the entry that was installed.
   * @param run - the batch it belongs to.
   */
  function settleRow(item, run) {
    const row = state.plugins.find((entry) => entry.name === item.name)
    if (row === undefined) return
    const outcome = (run.results ?? []).filter((entry) => entry.name === item.name).at(-1)
    const landed =
      outcome !== undefined &&
      (outcome.outcome === 'applied' || outcome.outcome === 'restart-required' || outcome.outcome === 'overridden')
    if (landed) {
      // The manager applied it: the installed version is the target now, and the
      // row belongs with the plugins that are up to date.
      row.state = 'current'
      row.installedVersion = String(item.targetVersion)
      row.targetVersion = null
      row.reason = null
      row.registry = null
      row.installedAt = Date.now()
      return
    }
    // A failure or a cancellation leaves the installed version in place, so the
    // row keeps naming its target; the page shows why in the run results.
    row.targetVersion = item.targetVersion
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
  async function runOne(name, target, installed, registry, git, source) {
    if (running !== null) return running
    if (manager === undefined) throw new Error('plugin manager is not available')
    const item = {
      name,
      installedVersion: installed,
      targetVersion: target,
      registry: registry ?? null,
      git: git === true,
      source: source ?? null,
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
    if (updatableRows().length === 0) {
      await refresh().catch(() => undefined)
    }
    const queue = updatableRows()
    if (queue.length === 0) return null
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
    const queue = updatableRows().filter((item) => wanted.has(item.name))
    if (queue.length === 0) return null
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
    const settings = cfg()
    const updatable = updatableRows()
    return {
      ok: true,
      available: manager !== undefined,
      checkedAt: state.lastCheckAt,
      checkError: state.lastCheckError,
      checking: checking !== null,
      stale: state.stale,
      checked: state.checked,
      plugins: state.plugins,
      updatable,
      // Git installs whose repository moved ahead. They are reported, not
      // queued: `updateBundle` needs a dependency pinned to a full commit.
      gitUpdatable: state.plugins
        .filter((row) => row.state === 'git-updatable')
        .map((row) => ({ name: row.name, from: row.installedVersion, to: row.targetVersion, repo: row.detail ?? null, source: row.source ?? null })),
      blocked: state.plugins
        .filter((row) => row.state === 'blocked')
        .map((row) => ({ name: row.name, reason: row.reason })),
      run: state.run,
      config: {
        intervalMinutes: settings.intervalMinutes,
        autoApply: settings.autoApply,
        includePrerelease: settings.includePrerelease,
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
    // `ctx.get` is read defensively: a profile that does not compose the
    // settings service must not turn an already-applied change into a failure.
    let settings
    try {
      settings = ctx.get('settings')
    } catch {
      return false
    }
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
                // Only a target the last check actually found may be installed,
                // and the check is `plugins` — the list the page renders — not a
                // queue that a running batch may already have drained.
                const known = updatableRows().find((row) => row.name === name && row.targetVersion === target)
                if (known === undefined) {
                  return reply({ ok: false, code: 'unknown-target', message: `${name}@${target} is not a checked target` })
                }
                await runOne(name, target, known.installedVersion, known.registry ?? null, known.git, known.source)
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
                  git: row.git === true,
                  source: row.source ?? null,
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
