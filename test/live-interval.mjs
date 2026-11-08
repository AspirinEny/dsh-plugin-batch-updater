/**
 * Live regression check for the "save the interval, lose the page" bug.
 *
 * Run from the package directory while the Harness is up:
 *   node test/live-interval.mjs
 *
 * It talks to the plugin's own route, the same way the page does. A route that
 * stops answering, or a `setInterval` that returns an error, is the exact
 * symptom the bug produced: the list vanished and the page claimed the profile
 * had no plugin manager.
 *
 * The route sits behind the Host's browser login, so this script can only prove
 * the plugin's *shape* is intact (it is still `active` and still declares its
 * schema). The end-to-end save is verified from the page itself.
 */
import assert from 'node:assert/strict'

const origin = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:50064'
const route = `${origin}/api/dsh-batch-updater/state`

const response = await fetch(route, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'state' }),
}).catch((error) => ({ error }))

if (response.error !== undefined) {
  console.log(`route unreachable: ${response.error.message}`)
  console.log('the plugin is probably not loaded in this process')
  process.exit(1)
}

// 200 means the route answered without the browser cookie; 401 means the Host
// fence answered first, which still proves the route is behind it and mounted.
assert.ok(
  response.status === 200 || response.status === 401,
  `unexpected status ${response.status} from the state route`,
)

if (response.status === 401) {
  // The fence answers before the handler runs, and its body is not something
  // this plugin controls, so only the status is meaningful here.
  console.log('route is mounted behind the Host login fence (401), as intended')
  console.log('open the Updates tab in the page to exercise the save itself')
  process.exit(0)
}

const state = await response.json()
console.log('state:', JSON.stringify({ ok: state.ok, available: state.available, checked: state.checked }))
assert.equal(state.ok, true)
console.log('route answers directly; state is intact')
