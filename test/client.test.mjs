/**
 * Browser-half check, run with the bundled Node:  node test/client.test.mjs
 *
 * The page hands a bundle a `require` for the shared React runtime and calls the
 * factory once. React itself is packed inside the installation's Web artifact,
 * which this script cannot read, so the module table below carries a small shim
 * implementing exactly the surface this bundle uses. That still catches the
 * failures that would otherwise surface only as a blank tab: a throw at module
 * scope, a factory that returns nothing usable, `apply` registering into the
 * wrong slot, a component that throws while rendering, or copy that never
 * appears.
 *
 * What this cannot prove: layout, styling, real hook re-renders, and how the
 * page looks. Those need the browser.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const source = await readFile(join(root, 'client.js'), 'utf8')

// -- a minimal React, covering only what this bundle calls -------------------

const FRAGMENT = Symbol('Fragment')
/** The hook slot of the component currently rendering. */
let hookSlot = null

/**
 * Build one element the renderer understands.
 * @param type - a tag name, a component function, or FRAGMENT.
 * @param props - element props; `children` joins any rest arguments.
 * @param rest - child arguments.
 * @returns the element node.
 */
function createElement(type, props, ...rest) {
  const own = { ...(props ?? {}) }
  if (rest.length === 1) own.children = rest[0]
  else if (rest.length > 1) own.children = rest
  return { type, props: own }
}

const React = {
  createElement,
  Fragment: FRAGMENT,
  useState(initial) {
    const slot = hookSlot
    const index = slot.used++
    if (!(index in slot.values)) slot.values[index] = typeof initial === 'function' ? initial() : initial
    return [slot.values[index], (next) => {
      slot.values[index] = typeof next === 'function' ? next(slot.values[index]) : next
    }]
  },
  useEffect() {
    hookSlot.used += 1
  },
  useSyncExternalStore(subscribe, getSnapshot) {
    void subscribe
    return getSnapshot()
  },
}

const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'circle', 'path'])

/**
 * Escape text for HTML output.
 * @param text - the raw text.
 * @returns escaped text.
 */
function escape(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Render one node to markup.
 * @param node - element, string, number, array, or null.
 * @returns the markup.
 */
function render(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string') return escape(node)
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(render).join('')
  if (typeof node.type === 'function') {
    const previous = hookSlot
    hookSlot = { used: 0, values: [] }
    try {
      return render(node.type(node.props))
    } finally {
      hookSlot = previous
    }
  }
  if (node.type === FRAGMENT) return render(node.props.children)
  const tag = node.type
  const attributes = []
  for (const [key, value] of Object.entries(node.props ?? {})) {
    if (key === 'children' || value === null || value === undefined || value === false) continue
    // Event handlers and children-of-components never become attributes.
    if (typeof value === 'function' || typeof value === 'object') continue
    if (key === 'style') continue
    const name = key === 'className' ? 'class' : key
    if (value === true) {
      attributes.push(name)
      continue
    }
    attributes.push(`${name}="${escape(value)}"`)
  }
  const open = `<${tag}${attributes.length > 0 ? ` ${attributes.join(' ')}` : ''}>`
  if (VOID_TAGS.has(tag)) return open
  return `${open}${render(node.props?.children)}</${tag}>`
}

// -- load the bundle the way the page does ------------------------------------

let loaded = null
const windowShim = {
  __ModuleLoader__: {
    load(registration) {
      loaded = registration
    },
  },
}

new Function('window', source)(windowShim)

assert.ok(loaded, 'the bundle registered itself with the module loader')
assert.equal(loaded.id, 'dsh-batch-updater', 'the module id is the package name')
assert.equal(typeof loaded.factory, 'function', 'the bundle exposes a factory')

const moduleTable = { react: React, 'react/jsx-runtime': { Fragment: FRAGMENT } }
const exports = loaded.factory((id) => {
  if (!(id in moduleTable)) throw new Error(`unexpected require("${id}")`)
  return moduleTable[id]
})

assert.ok(exports, 'the factory returned a module')
assert.ok(Array.isArray(exports.inject), 'the module declares its inject list')
assert.equal(typeof exports.apply, 'function', 'the module exposes apply')

// -- drive apply() with a fake browser context --------------------------------

/**
 * Build a fake client plugin context that records what gets registered.
 * @returns the context plus the captured registrations and effects.
 */
function fakeClientContext() {
  const registrations = []
  const effects = []
  const dictionaries = []
  const ctx = {
    effect(fn, label) {
      const dispose = fn()
      effects.push({ label, dispose })
      return () => {}
    },
    locale: {
      register(ns, dicts) {
        dictionaries.push({ ns, dicts })
        return () => {}
      },
      bind() {
        return (key, values) => {
          const template = dictionaries[0]?.dicts.zh?.[key] ?? key
          if (values === undefined) return template
          return String(template).replace(/\{(\w+)\}/g, (whole, name) =>
            name in values ? String(values[name]) : whole,
          )
        }
      },
    },
    slots: {
      inject(name, callback) {
        const dispose = callback()
        effects.push({ label: `inject:${name}`, dispose })
        return () => {}
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }
  return { ctx, registrations, effects, dictionaries }
}

const { ctx, registrations, effects, dictionaries } = fakeClientContext()
exports.apply(ctx)

assert.ok(dictionaries.length >= 1, 'the bundle registered its dictionaries')
const dict = dictionaries[0].dicts
assert.ok(dict.zh && dict.en, 'both locales are present')
assert.deepEqual(
  Object.keys(dict.zh).sort(),
  Object.keys(dict.en).sort(),
  'the two dictionaries have the same key set',
)

const bySlot = new Map(registrations.map((entry) => [entry.options.name, entry]))
assert.ok(bySlot.has('plugins.tab'), 'the Updates tab is registered')
assert.equal(bySlot.get('plugins.tab').options.id, 'batch-updater')
assert.equal(typeof bySlot.get('plugins.tab').options.label, 'function', 'the tab label is a thunk')
assert.equal(bySlot.get('plugins.tab').options.label(), dict.zh.tab, 'and resolves in the active locale')
assert.ok(bySlot.has('shell.overlay'), 'the result toast is registered')
assert.equal(bySlot.get('shell.overlay').options.id, 'batch-updater.toast')

// -- render the states the page can be in ------------------------------------

const t = ctx.locale.bind('batchUpdater')

/** A store stub whose snapshot the test drives directly. */
function stubStore(snapshot) {
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    refresh: async () => snapshot.data,
    nextDelay: () => 20_000,
    act: async () => snapshot.data,
    dismissRun: () => {},
  }
}

const baseConfig = { intervalMinutes: 360, autoApply: false, includePrerelease: false }

/** One row for a plugin that can move. */
const rowUpdatable = (name, from, to) => ({
  name,
  installedVersion: from,
  enabled: true,
  targetVersion: to,
  registry: null,
  state: 'updatable',
  reason: null,
})

/** One row for a plugin already on the newest version. */
const rowCurrent = (name, version) => ({
  name,
  installedVersion: version,
  enabled: true,
  targetVersion: null,
  registry: null,
  state: 'current',
  reason: null,
})

/** One row the plugin cannot update, with the reason. */
const rowBlocked = (name, version, reason) => ({
  name,
  installedVersion: version,
  enabled: true,
  targetVersion: null,
  registry: null,
  state: 'blocked',
  reason,
})

const loading = { loading: true, data: null, error: null, dismissedRunAt: null }

const idle = {
  loading: false,
  dismissedRunAt: null,
  error: null,
  data: {
    ok: true,
    available: true,
    checkedAt: Date.now(),
    checkError: null,
    checking: false,
    stale: false,
    checked: 14,
    plugins: [
      rowUpdatable('dsh-cost-meter', '1.9.58', '1.9.60'),
      rowUpdatable('dsh-context', '0.82.2', '0.83.0'),
      rowCurrent('dsh-free-search', '0.9.37'),
      rowBlocked('dsh-better-sidebar', '0.30.1', 'not-from-registry'),
    ],
    updatable: [],
    blocked: [{ name: 'dsh-better-sidebar', reason: 'not-from-registry' }],
    run: null,
    config: baseConfig,
  },
}

const finished = {
  loading: false,
  dismissedRunAt: null,
  error: null,
  data: {
    ...idle.data,
    plugins: [rowCurrent('dsh-cost-meter', '1.9.60'), rowCurrent('dsh-context', '0.83.0')],
    run: {
      status: 'done',
      startedAt: Date.now() - 5000,
      finishedAt: Date.now(),
      total: 2,
      index: 1,
      current: null,
      results: [
        { name: 'dsh-cost-meter', from: '1.9.58', to: '1.9.60', outcome: 'applied', code: '', step: 'install' },
        { name: 'dsh-context', from: '0.82.2', to: '0.83.0', outcome: 'restart-required', code: '', step: 'install' },
      ],
    },
    config: { ...baseConfig, autoApply: true },
  },
}

const running = {
  loading: false,
  dismissedRunAt: null,
  error: null,
  data: {
    ...idle.data,
    run: {
      status: 'running',
      startedAt: Date.now(),
      finishedAt: null,
      total: 3,
      index: 0,
      current: { name: 'dsh-cost-meter', from: '1.9.58', to: '1.9.60', step: 'installing' },
      results: [],
    },
    config: { ...baseConfig, intervalMinutes: 60 },
  },
}

const unavailable = {
  loading: false,
  dismissedRunAt: null,
  error: null,
  data: {
    ok: true,
    available: false,
    checkedAt: null,
    checkError: null,
    checking: false,
    stale: false,
    checked: 0,
    plugins: [],
    updatable: [],
    blocked: [],
    run: null,
    config: baseConfig,
  },
}

const failed = {
  loading: false,
  dismissedRunAt: null,
  error: { ok: false, code: 'network', message: 'fetch failed' },
  data: { ok: false, code: 'network', message: 'fetch failed' },
}

// A transport failure while a good list is already on screen: the list must
// stay, and the page must NOT claim the profile has no plugin manager.
const blipped = {
  loading: false,
  dismissedRunAt: null,
  error: { code: 'network', message: 'fetch failed' },
  data: idle.data,
}

const tab = bySlot.get('plugins.tab').component
const toast = bySlot.get('shell.overlay').component

const states = { loading, idle, finished, running, unavailable, failed, blipped }
for (const [label, snapshot] of Object.entries(states)) {
  const store = stubStore(snapshot)
  const html = render(React.createElement(tab, { t, store, install() {}, openPackage() {} }))
  assert.ok(typeof html === 'string', `${label}: the tab rendered`)
  assert.ok(!html.includes('undefined'), `${label}: no literal "undefined" leaked into the markup`)
  const toastHtml = render(React.createElement(toast, { t, store }))
  assert.ok(typeof toastHtml === 'string', `${label}: the toast rendered or returned null`)
}

/** Render the tab for one snapshot. */
const renderTab = (snapshot) =>
  render(React.createElement(tab, { t, store: stubStore(snapshot), install() {}, openPackage() {} }))

// The list is always present, and it is the user's own plugins only.
const idleHtml = renderTab(idle)
assert.ok(idleHtml.includes('dsh-cost-meter'), 'an updatable plugin is listed')
assert.ok(idleHtml.includes('dsh-free-search'), 'an up-to-date plugin is listed too, not hidden')
assert.ok(idleHtml.includes('dsh-better-sidebar'), 'a blocked plugin is listed with its reason')
assert.equal(
  /@deepseek-ai\/dsh-/.test(idleHtml),
  false,
  'no shipped bundle name appears on the page',
)
assert.ok(idleHtml.includes('共 14 个自装插件'), 'the count is the user\'s own plugins')
assert.ok(idleHtml.includes('有 2 个插件可以更新'), 'the notice states how many can move')
assert.ok(idleHtml.includes('type="checkbox"'), 'rows carry a checkbox')
assert.ok(idleHtml.includes('全部更新 (2)'), 'the button numbers the ticked rows')

// A finished run reports itself and its restart need.
const finishedHtml = renderTab(finished)
assert.ok(finishedHtml.includes('更新完成'), 'the finished run reports its outcome')
assert.ok(finishedHtml.includes('需重启'), 'a restart-required item is marked')
assert.ok(finishedHtml.includes('需要重启 DeepSeek Harness'), 'and the restart hint is spelled out')

// A run that left a failure must not let the empty list read as "all current".
const finishedWithFailure = {
  ...finished,
  data: {
    ...finished.data,
    run: {
      ...finished.data.run,
      results: [
        { name: 'ok-one', from: '1.0.0', to: '2.0.0', outcome: 'applied', code: '', step: 'install' },
        { name: 'broken', from: '1.0.0', to: '2.0.0', outcome: 'failed', code: 'operation-error', step: 'install' },
      ],
    },
  },
}
const failureHtml = renderTab(finishedWithFailure)
assert.ok(failureHtml.includes('重试失败的 1 个'), 'a failed row offers a retry')
assert.ok(
  !failureHtml.includes('已是最新版本。'),
  'an empty list after a failure does not claim everything is current',
)

// Running state offers Stop and says what it is doing.
const runningHtml = renderTab(running)
assert.ok(runningHtml.includes('停止'), 'a running batch offers Stop')
assert.ok(runningHtml.includes('更新中'), 'and says it is updating')

// The unavailable and failed states are told plainly.
const unavailableHtml = renderTab(unavailable)
assert.ok(unavailableHtml.includes('没有插件管理服务'), 'an unavailable profile is told plainly')

// A transport blip is not the same failure: the list stays and the wording differs.
const blippedHtml = renderTab(blipped)
assert.equal(
  blippedHtml.includes('没有插件管理服务'),
  false,
  'a failed request does not claim the profile has no plugin manager',
)
assert.ok(blippedHtml.includes('dsh-cost-meter'), 'the last known list stays on screen')
assert.ok(blippedHtml.includes('暂时连不上'), 'and the real problem is named')
assert.ok(blippedHtml.includes('立即重试'), 'with a way to retry')

const failedHtml = renderTab(failed)
assert.ok(failedHtml.includes('检查失败') || failedHtml.includes('fetch failed'), 'a transport failure is surfaced')
const loadingHtml = renderTab(loading)
assert.ok(loadingHtml.includes('正在读取插件列表'), 'the first paint says it is loading')

// The schedule is editable from the page.
assert.ok(idleHtml.includes('检查间隔'), 'the page exposes the check interval')
assert.ok(idleHtml.includes('保存'), 'and a control to save it')

// The toast speaks only after a settled run with results, and honours dismissal.
const finishedToast = render(React.createElement(toast, { t, store: stubStore(finished) }))
assert.ok(finishedToast.includes('插件更新'), 'the toast names the feature')

const noToastYet = { ...finished, data: { ...finished.data, run: { ...finished.data.run, results: [] } } }
assert.equal(render(React.createElement(toast, { t, store: stubStore(noToastYet) })), '', 'no toast before any result')

const dismissed = { ...finished, dismissedRunAt: finished.data.run.startedAt }
assert.equal(render(React.createElement(toast, { t, store: stubStore(dismissed) })), '', 'a dismissed toast stays dismissed')

assert.equal(
  render(React.createElement(toast, { t, store: stubStore(running) })),
  '',
  'no toast while the batch is still running',
)

const failedRun = {
  loading: false,
  dismissedRunAt: null,
  error: null,
  data: {
    ...finished.data,
    run: {
      status: 'done',
      startedAt: Date.now() - 1000,
      finishedAt: Date.now(),
      total: 1,
      index: 0,
      current: null,
      results: [{ name: 'broken', from: '1.0.0', to: '2.0.0', outcome: 'failed', code: 'operation-error', step: 'install' }],
    },
  },
}
assert.ok(
  render(React.createElement(toast, { t, store: stubStore(failedRun) })).includes('失败'),
  'a failed run reaches the frame-wide toast',
)

// Every reason code must be worded, never printed raw.
const codes = [
  'official',
  'not-updatable',
  'not-from-registry',
  'skipped-by-config',
  'self',
  'prerelease-only',
  'deprecated-only',
  'target-is-not-a-bundle',
  'needs-newer-dsh',
  'needs-newer-dsh:0.3.0',
  'version-lookup-failed:ETIMEDOUT',
  'version-lookup-refused',
  'not-found',
  'network',
]
for (const code of codes) {
  const snapshot = { ...idle, data: { ...idle.data, plugins: [rowBlocked(`plugin-${code}`, '1.0.0', code)] } }
  const html = renderTab(snapshot)
  assert.ok(!html.includes(`>${code}<`), `reason "${code}" is translated rather than printed raw`)
}

// -- teardown ----------------------------------------------------------------

for (const effect of effects) {
  if (typeof effect.dispose === 'function') effect.dispose()
}

console.log(
  `  ok   ${registrations.length} slot registrations, ${effects.length} effects disposed, ${Object.keys(states).length} states + 4 toast cases rendered`,
)
console.log('\nclient half passed')
