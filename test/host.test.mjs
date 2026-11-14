/**
 * Host-half checks, run with the bundled Node:  node test/host.test.mjs
 *
 * These drive `apply()` with a fake context and a fake plugin manager, so the
 * state machine is exercised without touching the real profile. They cover the
 * parts that are easy to get wrong: which bundles the page may show at all,
 * which version a batch picks, that a batch is strictly serial, that one
 * failure does not stop the queue, and that a ticked selection is honoured.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, __setFetchText, __setRoots } from '../index.js'

// The plugin records install/update times under the harness home. Give the run
// a scratch home so tests never read or write a real profile's history, and so
// one test cannot see another's records.
const scratchHome = await mkdtemp(join(tmpdir(), 'dsh-batch-updater-test-'))
process.env.DSH_HOME = scratchHome
// A checkout has no `profiles` segment, so pin the anchors the plugin would
// otherwise derive from its own install path.
__setRoots(scratchHome, join(scratchHome, 'profile', 'node_modules'))
// A scratch profile directory too: the install date is read from the package
// directory inside it, so a test that cares about it creates that directory.
const scratchProfile = join(scratchHome, 'profile')
await mkdir(join(scratchProfile, 'node_modules'), { recursive: true })
process.env.DSH_PROFILE_DIR = scratchProfile

// The plugin reads a Git repository's `package.json` over HTTP. Tests answer
// from this table instead, so a fixture never reaches the network.
const gitAnswers = new Map()
/** The default reader: answers from the table, 404 for anything unset. */
const fetchTextStub = async (url) => {
  const answer = gitAnswers.get(url)
  return answer ?? { status: 404, text: '' }
}
__setFetchText(fetchTextStub)

/**
 * Build a fake Cordis context that records what the plugin registered.
 * @param services - the services `ctx.get`/`ctx.inject` should answer with.
 * @returns the context plus the captured route handler and listeners.
 */
function fakeContext(services) {
  const handlers = new Map()
  const listeners = new Map()
  const disposers = []
  const ctx = {
    fiber: undefined,
    logger: { info() {} },
    get: (name) => services[name],
    inject(deps, callback) {
      const scoped = {
        get: (name) => services[name],
        effect(fn) {
          const dispose = fn()
          if (typeof dispose === 'function') disposers.push(dispose)
          return () => {}
        },
        on(event, handler) {
          listeners.set(event, handler)
          return () => {}
        },
      }
      const result = callback(scoped)
      if (typeof result === 'function') disposers.push(result)
      return () => {}
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
    on(event, handler) {
      listeners.set(event, handler)
      return () => {}
    },
    setHandler(path, handler) {
      handlers.set(path, handler)
    },
    handlers,
    listeners,
    disposeAll() {
      for (const dispose of disposers) dispose()
    },
  }
  return ctx
}

/**
 * Build a fake `pluginManager` service with a scripted bundle list.
 * @param bundles - what `listBundles()` answers.
 * @param versions - name -> `PluginVersionList`.
 * @param onUpdate - called for each `updateBundle`.
 * @returns the fake service and its call log.
 */
function fakeManager(bundles, versions, onUpdate) {
  const calls = { listBundles: 0, listVersions: [], updateBundle: [], cancelInstall: [] }
  return {
    calls,
    async listBundles() {
      calls.listBundles += 1
      return bundles
    },
    async listVersions(name) {
      calls.listVersions.push(name)
      return versions[name] ?? { status: 'refused', problem: 'not-found', reason: 'not-found', attempts: [] }
    },
    async updateBundle(name, version, options) {
      calls.updateBundle.push({ name, version, requestId: options?.requestId, options })
      return onUpdate(name, version, options)
    },
    async cancelInstall(requestId) {
      calls.cancelInstall.push(requestId)
      return { status: 'cancelled' }
    },
  }
}

/** A plugin the user installed from a registry range. */
function mine(name, version, extra = {}) {
  return {
    name,
    version,
    // The field DSH 0.2.2-rc.2 and newer list: how `updateBundle` replaces it.
    update: 'registry',
    installed: true,
    enabled: true,
    official: false,
    availability: 'profile',
    source: '^1.0.0',
    rows: [],
    ...extra,
  }
}

/** A plugin as an installation older than 0.2.2-rc.2 listed it: the retired boolean, no `update`. */
function mineLegacy(name, version, extra = {}) {
  const bundle = mine(name, version, extra)
  delete bundle.update
  // The retired field was true for a commit-pinned Git copy too, which the plugin
  // has to tell apart by its source spec.
  bundle.updatable = !/^(?:git\+|git:|file:|link:|https?:|github:)/i.test(String(bundle.source))
  return bundle
}

/** A Git copy pinned to a commit, which only another commit of that repository can replace. */
function mineGit(name, version, extra = {}) {
  return mine(name, version, { update: 'git', source: 'github:me/repo#abc1234', ...extra })
}

/** Answer the repository metadata read for one repo, as GitHub's raw host would. */
function stubRepo(ownerRepo, version) {
  const [owner, repo] = ownerRepo.split('/')
  gitAnswers.set(`https://raw.githubusercontent.com/${owner}/${repo}/HEAD/package.json`, {
    status: 200,
    text: JSON.stringify({ name: repo, version }),
  })
}

/** A bundle the dsh installation ships. */
function shipped(name, version) {
  return {
    name,
    version,
    installed: false,
    enabled: true,
    official: true,
    availability: 'installation',
    rows: [],
  }
}

/** A published version record. */
function versionRecord(version, extra = {}) {
  return { version, tags: [], prerelease: false, bundle: true, ...extra }
}

/** A `listed` answer with the given newer versions. */
function listed(versions, registry = null) {
  return { status: 'listed', installed: '1.0.0', registry, attempts: [], versions, omitted: 0 }
}

/** Build a context wired to one manager and its route. */
function harness(bundles, versions, onUpdate, config = { intervalMinutes: 360 }) {
  const manager = fakeManager(bundles, versions, onUpdate ?? (() => appliedChange()))
  const ctx = fakeContext({
    pluginManager: manager,
    connection: {
      fetch: {
        register: (route) => {
          ctx.setHandler(route.path, route.fetch)
          return async () => {}
        },
      },
    },
  })
  apply(ctx, config)
  return { ctx, manager }
}

/** Build a context around one explicit manager, so a stub can define its own methods. */
function harnessWith(manager, config = { intervalMinutes: 360 }) {
  const ctx = fakeContext({
    pluginManager: manager,
    connection: {
      fetch: {
        register: (route) => {
          ctx.setHandler(route.path, route.fetch)
          return async () => {}
        },
      },
    },
  })
  apply(ctx, config)
  return { ctx, manager }
}

/** A manager answer for one successful update. */
function appliedChange(name = 'x') {
  return { from: '1.0.0', to: '2.0.0', step: 'install', result: { changed: true, application: 'applied', stage: 'install', target: name } }
}

/** A manager answer for one failed update. */
function failedChange(name = 'x') {
  return { from: '1.0.0', to: '2.0.0', step: 'install', result: { changed: false, application: 'failed', stage: 'install', target: name, error: { code: 'operation-error' } } }
}

/** Invoke the route handler the plugin registered, as the browser would. */
async function callRoute(ctx, body) {
  const handler = ctx.handlers.get('/api/dsh-batch-updater/state')
  assert.ok(handler, 'the state route was registered')
  const request = new Request('http://127.0.0.1/api/dsh-batch-updater/state', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const response = await handler(request)
  return response.json()
}

/** Wait until the batch in the last snapshot settles. */
async function settle(ctx, state, limit = 200) {
  let current = state
  for (let attempt = 0; attempt < limit; attempt += 1) {
    const run = current.run
    if (run === null || run === undefined) return current
    if (run.status !== 'running' && run.status !== 'cancelling') return current
    await new Promise((resolve) => setTimeout(resolve, 5))
    current = await callRoute(ctx, { action: 'state' })
  }
  return current
}

const tests = []
/** Wrap a test so every case starts with an empty repository table. */
const historyPath = join(scratchHome, 'storages', 'dsh-batch-updater', 'history.json')
const modulesDir = join(scratchProfile, 'node_modules')

/** Create a package directory, so the install date has something to read. */
const stampPackage = async (name) => {
  const dir = join(modulesDir, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0' }))
}

const test = (name, fn) => tests.push({ name, fn: async () => {
  gitAnswers.clear()
  // Every case starts with no record, no remembered install time and no
  // package directories left by the previous case.
  await rm(historyPath, { force: true })
  await rm(modulesDir, { recursive: true, force: true })
  await mkdir(modulesDir, { recursive: true })
  return fn()
} })

test('counts and lists only the plugins the user installed', async () => {
  const bundles = [
    mine('dsh-cost-meter', '1.0.0'),
    mine('dsh-context', '1.0.0'),
    shipped('@deepseek-ai/dsh-base', '0.2.2'),
    shipped('@deepseek-ai/dsh-web-app', '0.2.2'),
    shipped('@deepseek-ai/dsh-experimental-auto-review', '0.2.2'),
  ]
  const { ctx } = harness(bundles, {
    'dsh-cost-meter': listed([versionRecord('2.0.0')]),
    'dsh-context': listed([versionRecord('2.0.0')]),
  })
  const state = await callRoute(ctx, { action: 'refresh' })
  assert.equal(state.checked, 2, 'the denominator is the user\'s own plugins, not every bundle')
  assert.deepEqual(state.plugins.map((row) => row.name).sort(), ['dsh-context', 'dsh-cost-meter'])
  assert.equal(
    state.plugins.some((row) => row.name.startsWith('@deepseek-ai/')),
    false,
    'no shipped bundle reaches the page',
  )
  ctx.disposeAll()
})

test('lists up-to-date plugins too, not just the ones that can move', async () => {
  const bundles = [mine('a', '1.0.0'), mine('b', '1.0.0')]
  const { ctx } = harness(bundles, {
    a: listed([versionRecord('2.0.0')]),
    b: listed([]),
  })
  const state = await callRoute(ctx, { action: 'refresh' })
  assert.equal(state.plugins.length, 2, 'both plugins appear')
  const byName = Object.fromEntries(state.plugins.map((row) => [row.name, row]))
  assert.equal(byName.a.state, 'updatable')
  assert.equal(byName.a.targetVersion, '2.0.0')
  assert.equal(byName.b.state, 'current')
  assert.equal(byName.b.targetVersion, null)
  ctx.disposeAll()
})

test('marks official and non-registry installs as blocked with a reason', async () => {
  const bundles = [
    mine('ok', '1.0.0'),
    mineGit('from-git', '1.0.0'),
    mine('from-path', '1.0.0', { update: undefined, source: 'link:../x' }),
    mine('from-ssh', '1.0.0', { update: 'git', source: 'git@github.com:me/repo.git' }),
  ]
  const { ctx } = harness(bundles, { ok: listed([versionRecord('2.0.0')]) })
  const state = await callRoute(ctx, { action: 'refresh' })
  const byName = Object.fromEntries(state.plugins.map((row) => [row.name, row]))
  // A Git copy is checked against its repository instead. This one answers 404,
  // which is the `git-not-found` row, not the blanket non-registry reason.
  assert.equal(byName['from-git'].state, 'blocked')
  assert.equal(byName['from-git'].reason, 'git-not-found')
  assert.equal(byName['from-path'].state, 'blocked')
  assert.equal(byName['from-path'].reason, 'not-from-registry')
  assert.equal(byName['from-ssh'].state, 'blocked', 'an scp-like Git address is checked as a repository')
  assert.equal(byName['from-ssh'].reason, 'git-not-found')
  ctx.disposeAll()
})

test('reads the update field DSH 0.2.2-rc.2 and newer list', async () => {
  // The regression this guards: 0.2.2-rc.2 replaced `updatable: boolean` with
  // `update: 'registry' | 'git'`, and reading only the old field left every
  // registry plugin blocked, so the page reported nothing to update.
  const bundles = [mine('a', '1.0.0'), mine('b', '1.0.0')]
  const { ctx } = harness(bundles, {
    a: listed([versionRecord('2.0.0')]),
    b: listed([]),
  })
  const state = await callRoute(ctx, { action: 'refresh' })
  const byName = Object.fromEntries(state.plugins.map((row) => [row.name, row]))
  assert.equal(byName.a.state, 'updatable', 'a registry bundle listed with update: registry can move')
  assert.equal(byName.a.targetVersion, '2.0.0')
  assert.equal(byName.b.state, 'current')
  assert.equal(state.updatable.length, 1)
  ctx.disposeAll()
})

test('still reads the retired updatable boolean', async () => {
  const bundles = [
    mineLegacy('a', '1.0.0'),
    mineLegacy('b', '1.0.0', { source: 'github:me/repo#abc' }),
    mineLegacy('c', '1.0.0', { source: 'git@github.com:me/repo.git' }),
  ]
  const { ctx } = harness(bundles, { a: listed([versionRecord('2.0.0')]) })
  const state = await callRoute(ctx, { action: 'refresh' })
  const byName = Object.fromEntries(state.plugins.map((row) => [row.name, row]))
  assert.equal(byName.a.state, 'updatable', 'an older installation still lists updatable: true')
  assert.equal(byName.a.targetVersion, '2.0.0')
  assert.equal(byName.b.state, 'blocked', 'the retired boolean was true for Git copies too')
  assert.equal(byName.b.reason, 'git-not-found')
  assert.equal(byName.c.state, 'blocked', 'an scp-like Git address is checked as a repository')
  assert.equal(byName.c.reason, 'git-not-found')
  ctx.disposeAll()
})

test('a Git install whose repository moved ahead joins the batch', async () => {
  // updateBundle has no path for an unpinned Git spec, so the Host removes the
  // copy and installs its saved spec again — the same two steps a manual
  // reinstall takes — and the row is queued like any other.
  const bundles = [mineGit('from-git', '1.0.0'), mine('reg', '1.0.0')]
  stubRepo('me/repo', '1.2.0')
  const { ctx, manager } = harness(bundles, { reg: listed([versionRecord('2.0.0')]) })
  const state = await callRoute(ctx, { action: 'refresh' })
  const byName = Object.fromEntries(state.plugins.map((row) => [row.name, row]))
  assert.equal(byName['from-git'].state, 'git-updatable')
  assert.equal(byName['from-git'].targetVersion, '1.2.0')
  assert.equal(state.gitUpdatable.length, 1)
  assert.equal(state.gitUpdatable[0].name, 'from-git')
  // Both channels are updatable now, and the queue says which way each installs.
  assert.equal(state.updatable.length, 2)
  const queued = Object.fromEntries(state.updatable.map((item) => [item.name, item]))
  assert.equal(queued['from-git'].git, true)
  assert.equal(queued.reg.git, false)
  // A Git row is still never asked for a registry version list.
  assert.equal(manager.calls.listVersions.includes('from-git'), false)
  ctx.disposeAll()
})

test('a Git update removes the copy and installs its saved spec again', async () => {
  const bundles = [mineGit('from-git', '1.0.0', { source: 'github:me/repo' })]
  stubRepo('me/repo', '1.2.0')
  const order = []
  const manager = {
    calls: { remove: [], install: [] },
    async listBundles() { return bundles },
    async listVersions() { return { status: 'refused', problem: 'not-updatable', reason: '', attempts: [] } },
    async updateBundle() { throw new Error('a git row must not go through updateBundle') },
    async removeBundle(name) { order.push('remove:' + name); this.calls.remove.push(name); return { changed: true, application: 'applied', stage: 'remove', target: name } },
    async installBundle(spec) { order.push('install:' + spec); this.calls.install.push(spec); return { changed: true, application: 'applied', stage: 'install', target: spec } },
    async cancelInstall() { return { status: 'not-running' } },
  }
  const { ctx } = harnessWith(manager)
  await callRoute(ctx, { action: 'refresh' })
  const started = await callRoute(ctx, { action: 'updateAll' })
  assert.equal(started.started, true)
  const settled = await settle(ctx, started)
  assert.deepEqual(order, ['remove:from-git', 'install:github:me/repo'], 'removed first, then reinstalled from its own spec')
  const row = settled.run.results.find((item) => item.name === 'from-git')
  assert.equal(row.outcome, 'applied')
  assert.equal(row.git, true, 'the result records which channel installed it')
  ctx.disposeAll()
})

test('a Git update reinstalls the old copy when the new install fails', async () => {
  // The removal already happened, so a failed install would leave the profile
  // without a plugin it had a moment ago; the Host puts it back.
  const bundles = [mineGit('from-git', '1.0.0', { source: 'github:me/repo' })]
  stubRepo('me/repo', '1.2.0')
  const installs = []
  const manager = {
    calls: { remove: [], install: [] },
    async listBundles() { return bundles },
    async listVersions() { return { status: 'refused', problem: 'not-updatable', reason: '', attempts: [] } },
    async updateBundle() { throw new Error('a git row must not go through updateBundle') },
    async removeBundle(name) { return { changed: true, application: 'applied', stage: 'remove', target: name } },
    async installBundle(spec) {
      installs.push(spec)
      return { changed: false, application: 'failed', stage: 'install', target: spec, error: { code: 'operation-error' } }
    },
    async cancelInstall() { return { status: 'not-running' } },
  }
  const { ctx } = harnessWith(manager)
  await callRoute(ctx, { action: 'refresh' })
  const started = await callRoute(ctx, { action: 'updateAll' })
  const settled = await settle(ctx, started)
  assert.deepEqual(installs, ['github:me/repo', 'github:me/repo'], 'the failed install is retried once to restore the copy')
  const row = settled.run.results.find((item) => item.name === 'from-git')
  assert.equal(row.outcome, 'failed')
  ctx.disposeAll()
})

test('a Git install at the repository version is up to date', async () => {
  const bundles = [mineGit('from-git', '1.0.0')]
  stubRepo('me/repo', '1.0.0')
  const { ctx } = harness(bundles, {})
  const state = await callRoute(ctx, { action: 'refresh' })
  const row = state.plugins.find((item) => item.name === 'from-git')
  assert.equal(row.state, 'current')
  assert.equal(row.targetVersion, null)
  assert.equal(state.gitUpdatable.length, 0)
  ctx.disposeAll()
})

test('a Git repository that cannot be read is blocked, not silently up to date', async () => {
  const bundles = [mineGit('from-git', '1.0.0')]
  // No stub: the reader answers 404, as a private or missing repository would.
  const { ctx } = harness(bundles, {})
  const state = await callRoute(ctx, { action: 'refresh' })
  const row = state.plugins.find((item) => item.name === 'from-git')
  assert.equal(row.state, 'blocked')
  assert.equal(row.reason, 'git-not-found')
  ctx.disposeAll()
})

test('a non-forge host is reported as unsupported rather than checked', async () => {
  const bundles = [mineGit('from-self', '1.0.0', { source: 'https://git.example.com/me/repo' })]
  const { ctx } = harness(bundles, {})
  const state = await callRoute(ctx, { action: 'refresh' })
  const row = state.plugins.find((item) => item.name === 'from-self')
  assert.equal(row.state, 'blocked')
  assert.equal(row.reason, 'git-unsupported-host')
  ctx.disposeAll()
})

test('one transient metadata failure is retried, not reported as a network row', async () => {
  // The scheduled check runs moments after startup, when a machine's network is
  // often not ready; a single blip used to pin the row to "network" all session.
  const bundles = [mineGit('from-git', '1.0.0')]
  let calls = 0
  const realFetch = fetchTextStub
  __setFetchText(async (url) => {
    calls += 1
    if (calls === 1) throw new Error('ECONNRESET once')
    return { status: 200, text: JSON.stringify({ name: 'repo', version: '1.2.0' }) }
  })
  try {
    const { ctx } = harness(bundles, {})
    const state = await callRoute(ctx, { action: 'refresh' })
    const row = state.plugins.find((item) => item.name === 'from-git')
    assert.equal(calls, 2, 'the read was attempted twice')
    assert.equal(row.state, 'git-updatable', 'the retry recovered the row')
    assert.equal(row.targetVersion, '1.2.0')
    ctx.disposeAll()
  } finally {
    __setFetchText(realFetch)
  }
})

test('a persistent metadata failure reports its reason, not just "network"', async () => {
  const bundles = [mineGit('from-git', '1.0.0')]
  const realFetch = fetchTextStub
  __setFetchText(async () => { throw new Error('getaddrinfo ENOTFOUND raw.githubusercontent.com') })
  try {
    const { ctx } = harness(bundles, {})
    const state = await callRoute(ctx, { action: 'refresh' })
    const row = state.plugins.find((item) => item.name === 'from-git')
    assert.equal(row.state, 'blocked')
    assert.equal(row.reason, 'network')
    assert.match(String(row.message), /ENOTFOUND/, 'the underlying cause is carried to the page')
    ctx.disposeAll()
  } finally {
    __setFetchText(realFetch)
  }
})

test('the harness home is found without DSH_HOME in the environment', async () => {
  // The Desktop Host does not pass DSH_HOME to plugin code. The history file was
  // therefore written one level too high, every read came back empty, and the
  // page showed every date as unknown. The plugin's own path is the anchor.
  const savedHome = process.env.DSH_HOME
  const savedProfile = process.env.DSH_PROFILE_DIR
  delete process.env.DSH_HOME
  delete process.env.DSH_PROFILE_DIR
  try {
    await stampPackage('anchored')
    const { ctx } = harness([mine('anchored', '1.0.0')], { anchored: listed([]) })
    const state = await callRoute(ctx, { action: 'refresh' })
    const row = state.plugins.find((item) => item.name === 'anchored')
    // No environment at all: the directory time is still read, so nothing is unknown.
    assert.ok(Number.isFinite(row.installedAt), 'a stamp is read with no DSH_* variables set')
    assert.equal(row.updatedAt, null, 'and no update time is invented')
    ctx.disposeAll()
  } finally {
    process.env.DSH_HOME = savedHome
    process.env.DSH_PROFILE_DIR = savedProfile
  }
})

test('an unchanged package keeps one date instead of claiming an update', async () => {
  // The history already records this version, so nothing was replaced: the page
  // must keep showing the install date rather than inventing an update time.
  await stampPackage('a')
  const first = harness([mine('a', '1.0.0')], { a: listed([]) })
  await callRoute(first.ctx, { action: 'refresh' })
  first.ctx.disposeAll()

  const again = harness([mine('a', '1.0.0')], { a: listed([]) })
  const state = await callRoute(again.ctx, { action: 'refresh' })
  const row = state.plugins.find((item) => item.name === 'a')
  assert.ok(Number.isFinite(row.installedAt), 'the install date survives a second check')
  assert.equal(row.updatedAt, null, 'an unchanged copy reports no update time at all')
  again.ctx.disposeAll()
})

test('a version change records an update date distinct from the install date', async () => {
  // The page has to tell "installed then" from "replaced since": the profile
  // keeps no such record, so the plugin writes one and compares versions.
  await stampPackage('a')
  const first = await (async () => {
    const { ctx } = harness([mine('a', '1.0.0')], { a: listed([]) })
    const state = await callRoute(ctx, { action: 'refresh' })
    ctx.disposeAll()
    return state.plugins.find((item) => item.name === 'a')
  })()
  // Pretend time passed and the package moved to a new version.
  const { ctx } = harness([mine('a', '2.0.0')], { a: listed([]) })
  const second = await callRoute(ctx, { action: 'refresh' })
  const row = second.plugins.find((item) => item.name === 'a')
  assert.ok(row.updatedAt >= row.installedAt, 'the update is at or after the install')
  assert.ok(Number.isFinite(first.installedAt), 'the first sighting was stamped')
  ctx.disposeAll()
})

test('a batch moves each row to up to date as its own install settles', async () => {
  // The page regroups from the list, so the list itself has to advance during
  // the run; otherwise "Update all" looks frozen until the last item finishes.
  const bundles = [mine('one', '1.0.0'), mine('two', '1.0.0'), mine('three', '1.0.0')]
  let releaseSecond
  const secondStarted = new Promise((resolve) => { releaseSecond = resolve })
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const { ctx } = harness(
    bundles,
    { one: listed([versionRecord('2.0.0')]), two: listed([versionRecord('2.0.0')]), three: listed([versionRecord('2.0.0')]) },
    async (name) => {
      if (name === 'two') {
        // Park here so the test can read the list mid-batch.
        releaseSecond()
        await gate
      }
      // A real manager rewrites the installed copy, so the next listBundles()
      // reports the new version; the fixture has to do the same or the check
      // that follows a batch would re-report the old one.
      const row = bundles.find((bundle) => bundle.name === name)
      row.version = '2.0.0'
      row.source = '2.0.0'
      return appliedChange(name)
    },
  )
  await callRoute(ctx, { action: 'refresh' })
  const started = await callRoute(ctx, { action: 'updateAll' })
  assert.equal(started.started, true)
  await secondStarted
  const mid = await callRoute(ctx, { action: 'state' })
  const midByName = Object.fromEntries(mid.plugins.map((row) => [row.name, row]))
  assert.equal(midByName.one.state, 'current', 'the finished one already moved')
  assert.equal(midByName.one.installedVersion, '2.0.0')
  assert.equal(midByName.two.state, 'updatable', 'the running one is still queued')
  assert.equal(mid.updatable.length, 2, 'two remained after one settled')
  release()
  await settle(ctx, mid)
  const after = await callRoute(ctx, { action: 'state' })
  assert.equal(after.plugins.every((row) => row.state === 'current'), true)
  assert.equal(after.updatable.length, 0)
  ctx.disposeAll()
})

test('skips the plugin itself even though the user installed it', async () => {
  const bundles = [mine('dsh-batch-updater', '0.1.0'), mine('other', '1.0.0')]
  const { ctx, manager } = harness(bundles, { other: listed([versionRecord('2.0.0')]) })
  const state = await callRoute(ctx, { action: 'refresh' })
  const self = state.plugins.find((row) => row.name === 'dsh-batch-updater')
  assert.ok(self, 'the plugin still lists itself')
  assert.equal(self.state, 'blocked')
  assert.equal(self.reason, 'self')
  assert.equal(manager.calls.listVersions.includes('dsh-batch-updater'), false, 'it never asks the registry about itself')
  ctx.disposeAll()
})

test('picks the newest admissible version and explains the rest', async () => {
  const bundles = [mine('a', '1.0.0'), mine('b', '1.0.0'), mine('c', '1.0.0')]
  const { ctx } = harness(bundles, {
    a: listed([
      versionRecord('3.0.0', { deprecated: 'broken' }),
      versionRecord('2.5.0', { bundle: false }),
      versionRecord('2.0.0'),
      versionRecord('1.5.0'),
    ]),
    b: listed([versionRecord('2.0.0', { incompatible: { name: 'b', version: '2.0.0', runtimeVersion: '0.3.0', requirements: {} } })]),
    c: listed([versionRecord('2.0.0', { prerelease: true })]),
  })
  const state = await callRoute(ctx, { action: 'refresh' })
  const byName = Object.fromEntries(state.plugins.map((row) => [row.name, row]))
  assert.equal(byName.a.targetVersion, '2.0.0')
  assert.equal(byName.b.reason.startsWith('needs-newer-dsh'), true)
  assert.equal(byName.c.reason, 'prerelease-only')
  ctx.disposeAll()
})

test('includePrerelease admits a prerelease', async () => {
  const { ctx } = harness(
    [mine('c', '1.0.0')],
    { c: listed([versionRecord('2.0.0-rc.1', { prerelease: true })]) },
    undefined,
    { intervalMinutes: 360, includePrerelease: true },
  )
  const state = await callRoute(ctx, { action: 'refresh' })
  assert.equal(state.plugins[0].targetVersion, '2.0.0-rc.1')
  ctx.disposeAll()
})

test('updateSelected updates only the ticked plugins', async () => {
  const bundles = [mine('a', '1.0.0'), mine('b', '1.0.0'), mine('c', '1.0.0')]
  const versions = Object.fromEntries(bundles.map((x) => [x.name, listed([versionRecord('2.0.0')])]))
  const { ctx, manager } = harness(bundles, versions)
  await callRoute(ctx, { action: 'refresh' })
  await callRoute(ctx, { action: 'updateSelected', names: ['a', 'c'] })
  const state = await settle(ctx, await callRoute(ctx, { action: 'state' }))
  assert.deepEqual(manager.calls.updateBundle.map((call) => call.name), ['a', 'c'], 'b was left alone')
  assert.equal(state.run.total, 2)
  ctx.disposeAll()
})

test('updateSelected with nothing ticked starts no batch', async () => {
  const { ctx, manager } = harness([mine('a', '1.0.0')], { a: listed([versionRecord('2.0.0')]) })
  await callRoute(ctx, { action: 'refresh' })
  const answer = await callRoute(ctx, { action: 'updateSelected', names: [] })
  assert.equal(answer.ok, false)
  assert.equal(answer.code, 'bad-request')
  assert.equal(manager.calls.updateBundle.length, 0)
  ctx.disposeAll()
})

test('runs strictly in order and keeps going after a failure', async () => {
  const bundles = [mine('one', '1.0.0'), mine('two', '1.0.0'), mine('three', '1.0.0')]
  const versions = Object.fromEntries(bundles.map((x) => [x.name, listed([versionRecord('2.0.0')])]))
  let inFlight = 0
  let sawOverlap = false
  const { ctx, manager } = harness(bundles, versions, async (name) => {
    inFlight += 1
    if (inFlight > 1) sawOverlap = true
    await new Promise((resolve) => setTimeout(resolve, 4))
    inFlight -= 1
    if (name === 'two') return failedChange(name)
    if (name === 'three') {
      return { from: '1.0.0', to: '2.0.0', step: 'install', result: { changed: true, application: 'restart-required', stage: 'install', target: name } }
    }
    return appliedChange(name)
  })
  await callRoute(ctx, { action: 'refresh' })
  await callRoute(ctx, { action: 'updateAll' })
  const state = await settle(ctx, await callRoute(ctx, { action: 'state' }))
  assert.equal(sawOverlap, false, 'a batch never runs two updates at once')
  assert.equal(state.run.status, 'done')
  assert.deepEqual(state.run.results.map((row) => `${row.name}:${row.outcome}`), [
    'one:applied',
    'two:failed',
    'three:restart-required',
  ])
  assert.deepEqual(manager.calls.updateBundle.map((call) => call.name), ['one', 'two', 'three'])
  assert.equal(manager.calls.updateBundle.every((call) => typeof call.requestId === 'string'), true)
  ctx.disposeAll()
})

test('updateOne refuses a target the last check never verified', async () => {
  const { ctx, manager } = harness([mine('a', '1.0.0')], { a: listed([versionRecord('2.0.0')]) })
  await callRoute(ctx, { action: 'refresh' })
  const answer = await callRoute(ctx, { action: 'updateOne', name: 'a', version: '9.9.9' })
  assert.equal(answer.ok, false)
  assert.equal(answer.code, 'unknown-target')
  assert.equal(manager.calls.updateBundle.length, 0)
  ctx.disposeAll()
})

test('retryFailed re-queues only the failed rows', async () => {
  const bundles = [mine('good', '1.0.0'), mine('bad', '1.0.0')]
  const versions = Object.fromEntries(bundles.map((x) => [x.name, listed([versionRecord('2.0.0')])]))
  let badCalls = 0
  const { ctx, manager } = harness(bundles, versions, async (name) => {
    if (name === 'bad') {
      badCalls += 1
      if (badCalls === 1) return failedChange(name)
    }
    return appliedChange(name)
  })
  await callRoute(ctx, { action: 'refresh' })
  await callRoute(ctx, { action: 'updateAll' })
  await settle(ctx, await callRoute(ctx, { action: 'state' }))
  await callRoute(ctx, { action: 'retryFailed' })
  const state = await settle(ctx, await callRoute(ctx, { action: 'state' }))
  assert.deepEqual(manager.calls.updateBundle.map((call) => call.name), ['good', 'bad', 'bad'])
  assert.equal(state.run.results[0].name, 'bad')
  assert.equal(state.run.results[0].outcome, 'applied')
  ctx.disposeAll()
})

test('cancel asks the manager to stop the item in flight', async () => {
  const bundles = [mine('slow', '1.0.0'), mine('later', '1.0.0')]
  const versions = Object.fromEntries(bundles.map((x) => [x.name, listed([versionRecord('2.0.0')])]))
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const { ctx, manager } = harness(bundles, versions, async (name) => {
    if (name === 'slow') await gate
    return appliedChange(name)
  })
  await callRoute(ctx, { action: 'refresh' })
  await callRoute(ctx, { action: 'updateAll' })
  await new Promise((resolve) => setTimeout(resolve, 10))
  const cancelled = await callRoute(ctx, { action: 'cancel' })
  assert.equal(cancelled.cancel, 'cancelled')
  assert.equal(manager.calls.cancelInstall.length, 1)
  release()
  const state = await settle(ctx, cancelled)
  assert.equal(state.run.status, 'cancelled')
  assert.deepEqual(manager.calls.updateBundle.map((call) => call.name), ['slow'])
  ctx.disposeAll()
})

test('a manager that throws is reported, not swallowed', async () => {
  const ctx = fakeContext({
    pluginManager: {
      async listBundles() {
        throw new Error('profile is locked')
      },
      async listVersions() {},
      async updateBundle() {},
      async cancelInstall() {},
    },
    connection: {
      fetch: {
        register: (route) => {
          ctx.setHandler(route.path, route.fetch)
          return async () => {}
        },
      },
    },
  })
  apply(ctx, { intervalMinutes: 360 })
  const state = await callRoute(ctx, { action: 'refresh' })
  assert.equal(state.ok, true)
  assert.match(state.checkError, /profile is locked/)
  ctx.disposeAll()
})

test('without a plugin manager the page is told it is unavailable', async () => {
  const ctx = fakeContext({
    connection: {
      fetch: {
        register: (route) => {
          ctx.setHandler(route.path, route.fetch)
          return async () => {}
        },
      },
    },
  })
  apply(ctx, { intervalMinutes: 360 })
  const state = await callRoute(ctx, { action: 'state' })
  assert.equal(state.available, false)
  const answer = await callRoute(ctx, { action: 'updateAll' })
  assert.equal(answer.ok, false)
  assert.equal(answer.code, 'unavailable')
  ctx.disposeAll()
})

test('rejects an interval below the floor', async () => {
  const { ctx } = harness([mine('a', '1.0.0')], { a: listed([versionRecord('2.0.0')]) })
  const answer = await callRoute(ctx, { action: 'setInterval', minutes: 1 })
  assert.equal(answer.ok, false)
  assert.equal(answer.code, 'bad-value')
  ctx.disposeAll()
})

test('saving a new interval applies to the running instance and keeps the list', async () => {
  // The real config arrives with `intervalMinutes` as a volatile handle; the
  // bug this covers is that saving used to restart the plugin, so the route and
  // the list vanished and the page claimed the profile had no plugin manager.
  const store = { intervalMinutes: 360 }
  const handle = {
    get: () => store.intervalMinutes,
    [Symbol.for('cosmokit.volatile.write')]: (next) => {
      store.intervalMinutes = next
    },
  }
  const config = { intervalMinutes: handle, autoApply: false, includePrerelease: false, skip: [] }
  const bundles = [mine('a', '1.0.0')]
  const manager = fakeManager(bundles, { a: listed([versionRecord('2.0.0')]) })
  const ctx = fakeContext({
    pluginManager: manager,
    connection: {
      fetch: {
        register: (route) => {
          ctx.setHandler(route.path, route.fetch)
          return async () => {}
        },
      },
    },
  })
  apply(ctx, config)

  await callRoute(ctx, { action: 'refresh' })
  const before = await callRoute(ctx, { action: 'state' })
  assert.equal(before.available, true)
  assert.equal(before.plugins.length, 1)
  assert.equal(before.config.intervalMinutes, 360)

  const saved = await callRoute(ctx, { action: 'setInterval', minutes: 45 })
  assert.equal(saved.ok, true, 'the save is accepted')
  assert.equal(saved.available, true, 'the manager is still reachable afterwards')
  assert.equal(saved.plugins.length, 1, 'the list survives the save')
  assert.equal(saved.config.intervalMinutes, 45, 'and the new value is in force')
  assert.equal(store.intervalMinutes, 45, 'written through the volatile handle')

  const again = await callRoute(ctx, { action: 'state' })
  assert.equal(again.config.intervalMinutes, 45, 'the value sticks for later reads')
  ctx.disposeAll()
})

test('the interval is persisted through the settings service', async () => {
  const store = { intervalMinutes: 360 }
  const handle = {
    get: () => store.intervalMinutes,
    [Symbol.for('cosmokit.volatile.write')]: (next) => {
      store.intervalMinutes = next
    },
  }
  const writes = []
  const ctx = fakeContext({
    pluginManager: fakeManager([mine('a', '1.0.0')], { a: listed([versionRecord('2.0.0')]) }),
    settings: {
      describe: () => [
        { ns: 'someone-else', revision: 1 },
        { ns: 'dsh-batch-updater', revision: 7 },
      ],
      async update(ns, patch, revision) {
        writes.push({ ns, patch, revision })
      },
    },
    connection: {
      fetch: {
        register: (route) => {
          ctx.setHandler(route.path, route.fetch)
          return async () => {}
        },
      },
    },
  })
  apply(ctx, { intervalMinutes: handle, autoApply: false, includePrerelease: false, skip: [] })
  const saved = await callRoute(ctx, { action: 'setInterval', minutes: 90 })
  assert.equal(saved.ok, true)
  assert.equal(saved.persisted, true, 'the save reports that it was written down')
  assert.deepEqual(writes, [{ ns: 'dsh-batch-updater', patch: { intervalMinutes: 90 }, revision: 7 }])
  ctx.disposeAll()
})

test('a settings write that is refused still applies for this process', async () => {
  const store = { intervalMinutes: 360 }
  const handle = {
    get: () => store.intervalMinutes,
    [Symbol.for('cosmokit.volatile.write')]: (next) => {
      store.intervalMinutes = next
    },
  }
  const ctx = fakeContext({
    pluginManager: fakeManager([mine('a', '1.0.0')], { a: listed([versionRecord('2.0.0')]) }),
    settings: {
      describe: () => [{ ns: 'dsh-batch-updater', revision: 7 }],
      async update() {
        throw new Error('higher-priority layer overrides this field')
      },
    },
    connection: {
      fetch: {
        register: (route) => {
          ctx.setHandler(route.path, route.fetch)
          return async () => {}
        },
      },
    },
  })
  apply(ctx, { intervalMinutes: handle, autoApply: false, includePrerelease: false, skip: [] })
  const saved = await callRoute(ctx, { action: 'setInterval', minutes: 90 })
  assert.equal(saved.ok, true, 'the live change still goes through')
  assert.equal(saved.persisted, false, 'and the page is told it will not survive a restart')
  assert.equal(saved.config.intervalMinutes, 90)
  ctx.disposeAll()
})

test('a save that cannot be written is reported, not silently ignored', async () => {
  // No volatile handle (a plain object config): the write cannot be applied, and
  // the page must be told rather than showing the new number as saved.
  const ctx = fakeContext({
    pluginManager: fakeManager([mine('a', '1.0.0')], { a: listed([versionRecord('2.0.0')]) }),
    connection: {
      fetch: {
        register: (route) => {
          ctx.setHandler(route.path, route.fetch)
          return async () => {}
        },
      },
    },
  })
  apply(ctx, { intervalMinutes: 360 })
  const answer = await callRoute(ctx, { action: 'setInterval', minutes: 45 })
  assert.equal(answer.ok, false)
  assert.equal(answer.code, 'bad-value')
  ctx.disposeAll()
})

test('a settings service that throws on lookup does not fail an applied save', async () => {
  const store = { intervalMinutes: 360 }
  const handle = {
    get: () => store.intervalMinutes,
    [Symbol.for('cosmokit.volatile.write')]: (next) => {
      store.intervalMinutes = next
    },
  }
  const ctx = fakeContext({
    pluginManager: fakeManager([mine('a', '1.0.0')], { a: listed([versionRecord('2.0.0')]) }),
    // Cordis refuses an un-injected property access by throwing.
    settings: undefined,
    connection: {
      fetch: {
        register: (route) => {
          ctx.setHandler(route.path, route.fetch)
          return async () => {}
        },
      },
    },
  })
  const originalGet = ctx.get
  ctx.get = (name) => {
    if (name === 'settings') throw new Error('cannot get property "settings" without inject')
    return originalGet(name)
  }
  apply(ctx, { intervalMinutes: handle, autoApply: false, includePrerelease: false, skip: [] })
  const saved = await callRoute(ctx, { action: 'setInterval', minutes: 90 })
  assert.equal(saved.ok, true, 'the applied change stands')
  assert.equal(saved.persisted, false, 'and it is honest about not being stored')
  assert.equal(saved.config.intervalMinutes, 90)
  ctx.disposeAll()
})

test('update progress from the manager reaches the running item', async () => {
  const versions = { slow: listed([versionRecord('2.0.0')]) }
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  let announcedId = null
  const { ctx } = harness([mine('slow', '1.0.0')], versions, async (name, version, options) => {
    announcedId = options.requestId
    await gate
    return appliedChange(name)
  })
  await callRoute(ctx, { action: 'refresh' })
  await callRoute(ctx, { action: 'updateAll' })
  await new Promise((resolve) => setTimeout(resolve, 10))
  const listener = ctx.listeners.get('plugin-manager/update-state')
  assert.ok(listener, 'the plugin listens for update progress')
  listener({ requestId: 'someone-else', step: 'removing' })
  listener({ requestId: announcedId, step: 'installing' })
  const state = await callRoute(ctx, { action: 'state' })
  assert.equal(state.run.current.step, 'installing')
  release()
  ctx.disposeAll()
})

test('a change the plugin did not start marks the list stale, not empty', async () => {
  const { ctx } = harness([mine('a', '1.0.0')], { a: listed([versionRecord('2.0.0')]) })
  const checked = await callRoute(ctx, { action: 'refresh' })
  assert.equal(checked.stale, false)
  assert.equal(checked.plugins.length, 1)
  const listener = ctx.listeners.get('plugin-manager/changed')
  assert.ok(listener, 'the plugin listens for profile changes')
  listener({ kind: 'bundle' })
  const after = await callRoute(ctx, { action: 'state' })
  assert.equal(after.stale, true)
  assert.equal(after.plugins.length, 1, 'the last good list stays visible')
  assert.equal(typeof after.checkedAt, 'number')
  ctx.disposeAll()
})

test('a target equal to the installed version is not treated as an update', async () => {
  const ctx = harness([mine('a', '2.0.0')], {
    a: { status: 'listed', installed: '2.0.0', registry: null, attempts: [], omitted: 0, versions: [versionRecord('2.0.0')] },
  }).ctx
  const state = await callRoute(ctx, { action: 'refresh' })
  assert.equal(state.plugins[0].state, 'current', 'the version in place is not an update target')
  assert.equal(state.updatable.length, 0)
  ctx.disposeAll()
})

test('versions are read concurrently, not one at a time', async () => {
  const names = ['a', 'b', 'c', 'd', 'e', 'f']
  const bundles = names.map((name) => mine(name, '1.0.0'))
  let inFlight = 0
  let peak = 0
  const versions = Object.fromEntries(names.map((name) => [name, listed([versionRecord('2.0.0')])]))
  const manager = fakeManager(bundles, {})
  manager.listVersions = async (name) => {
    inFlight += 1
    peak = Math.max(peak, inFlight)
    await new Promise((resolve) => setTimeout(resolve, 6))
    inFlight -= 1
    return versions[name]
  }
  const ctx = fakeContext({
    pluginManager: manager,
    connection: {
      fetch: {
        register: (route) => {
          ctx.setHandler(route.path, route.fetch)
          return async () => {}
        },
      },
    },
  })
  apply(ctx, { intervalMinutes: 360 })
  await callRoute(ctx, { action: 'refresh' })
  assert.ok(peak > 1, `expected concurrent lookups, saw a peak of ${peak}`)
  assert.ok(peak <= 4, `expected at most 4 lookups at once, saw ${peak}`)
  ctx.disposeAll()
})

test('skip in the config keeps a named plugin out of the batch', async () => {
  const bundles = [mine('wanted', '1.0.0'), mine('pinned', '1.0.0')]
  const versions = Object.fromEntries(bundles.map((x) => [x.name, listed([versionRecord('2.0.0')])]))
  const { ctx, manager } = harness(bundles, versions, undefined, { intervalMinutes: 360, skip: ['pinned'] })
  const state = await callRoute(ctx, { action: 'refresh' })
  const byName = Object.fromEntries(state.plugins.map((row) => [row.name, row]))
  assert.equal(byName.pinned.state, 'blocked')
  assert.equal(byName.pinned.reason, 'skipped-by-config')
  assert.equal(manager.calls.listVersions.includes('pinned'), false, 'a skipped name is never looked up')
  await callRoute(ctx, { action: 'updateAll' })
  await settle(ctx, await callRoute(ctx, { action: 'state' }))
  assert.deepEqual(manager.calls.updateBundle.map((call) => call.name), ['wanted'])
  ctx.disposeAll()
})

test('an update that needs build scripts approved says so', async () => {
  const bundles = [mine('built', '1.0.0')]
  const { ctx } = harness(bundles, { built: listed([versionRecord('2.0.0')]) }, async (name) => ({
    from: '1.0.0',
    to: '2.0.0',
    step: 'install',
    result: {
      changed: false,
      application: 'failed',
      stage: 'install',
      target: name,
      error: { code: 'operation-error' },
      pendingBuilds: ['esbuild', 'sharp'],
    },
  }))
  await callRoute(ctx, { action: 'refresh' })
  await callRoute(ctx, { action: 'updateAll' })
  const state = await settle(ctx, await callRoute(ctx, { action: 'state' }))
  const row = state.run.results[0]
  assert.equal(row.outcome, 'failed')
  assert.deepEqual(row.pendingBuilds, ['esbuild', 'sharp'], 'the blocked build scripts are named')
  ctx.disposeAll()
})

let failed = 0
for (const { name, fn } of tests) {
  try {
    await fn()
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}`)
    console.log(`       ${error?.message ?? error}`)
  }
}
await rm(scratchHome, { recursive: true, force: true })
console.log(`\n${tests.length - failed}/${tests.length} passed`)
process.exitCode = failed === 0 ? 0 : 1
