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
import { apply } from '../index.js'

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
    updatable: true,
    installed: true,
    enabled: true,
    official: false,
    availability: 'profile',
    source: '^1.0.0',
    rows: [],
    ...extra,
  }
}

/** A bundle the dsh installation ships. */
function shipped(name, version) {
  return {
    name,
    version,
    updatable: false,
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
const test = (name, fn) => tests.push({ name, fn })

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
    mine('from-git', '1.0.0', { updatable: false, source: 'github:me/repo#abc' }),
    mine('from-path', '1.0.0', { updatable: false, source: 'link:../x' }),
  ]
  const { ctx } = harness(bundles, { ok: listed([versionRecord('2.0.0')]) })
  const state = await callRoute(ctx, { action: 'refresh' })
  const byName = Object.fromEntries(state.plugins.map((row) => [row.name, row]))
  assert.equal(byName['from-git'].state, 'blocked')
  assert.equal(byName['from-git'].reason, 'not-from-registry')
  assert.equal(byName['from-path'].state, 'blocked')
  assert.equal(byName['from-path'].reason, 'not-from-registry')
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
console.log(`\n${tests.length - failed}/${tests.length} passed`)
process.exitCode = failed === 0 ? 0 : 1
