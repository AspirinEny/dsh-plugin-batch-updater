# dsh-plugin-batch-updater

A **Updates** tab on the DeepSeek Harness Plugins page: it checks the plugins you
installed yourself on a schedule, lists all of them, and updates the ones you
tick in one serial run.

## Install

In the Plugins page, choose **Add plugin** and paste the repository address:

```
https://github.com/AspirinEny/dsh-plugin-batch-updater
```

Or from a terminal:

```bash
dsh plugin --profile <your-profile> add https://github.com/AspirinEny/dsh-plugin-batch-updater
```

Requires DeepSeek Harness `0.2.2-rc.1` or newer.

## What it does

The shipping Plugin Manager updates one third-party bundle at a time: open its
page, wait for the version check, press **Update to 1.2.3**, repeat. This plugin
puts those steps in one place.

- **An `Updates` tab** beside **Installed** and **Discover**.
- **Every plugin you installed**, always listed, grouped by what can happen to it.
- **Checkboxes**, ticked by default, so **Update** touches only what you chose.
- **A scheduled check** every `intervalMinutes` (6 hours by default).
- **A result toast** in the frame-wide overlay, so a finished or failed batch is
  visible after you leave the Plugins page.

## What it leaves alone

Only bundles the profile itself installed appear on this page. The two dozen
official bundles the DSH installation ships never do, so the count the page shows
matches the plugins you recognise from your own list.

Of your own plugins, these are shown under **Cannot update automatically** with
the reason, rather than hidden:

| Skipped | Why |
|---|---|
| This plugin itself | Replacing a running plugin from inside itself is not safe. |
| Git, tarball, `link:` and `file:` installs | `updateBundle` needs a registry range to resolve a newer version from. |
| Versions that need a newer DSH | Installing them would break the profile. |
| Deprecated versions, and targets that declare no bundle | Neither is a usable upgrade. |
| Prereleases | Unless `includePrerelease` is on. |
| Names listed in `skip` | Explicit opt-out. |

## Settings

Editable from the tab itself (the interval field, then **Save**), or in your
profile's `cordis.patch.yml`:

```yaml
- id: dsh-batch-updater
  config:
    intervalMinutes: 360      # minimum 5
    autoApply: false          # true installs what a scheduled check finds
    includePrerelease: false
    skip: []                  # package names never touched
```

Saving from the page writes the value through the settings service, so it
survives a restart. `autoApply` defaults to **false**: a scheduled run replaces
plugins while the app is in use, and checking automatically while updating on
request keeps that decision with you.

`intervalMinutes` is declared `.volatile()`. That is not a detail: an ordinary
config field restarts the plugin when it changes, which tears down the route and
every bit of state the page is showing — the tab would empty out and report that
the profile had no plugin manager. A volatile field is applied in place. If the
write to the profile is refused (a higher-priority layer pinning the value, for
example), the change still applies to the running process and the page says so
rather than pretending it was stored.

## How it works

The Host half (`index.js`) is a Cordis plugin with two passes over
`ctx.pluginManager`:

```
check:  listBundles()  ->  the bundles with availability 'profile' and not official
                       ->  listVersions(name) for each
                       ->  the newest version that declares a bundle, is not
                           deprecated, accepts this DSH, and is not a prerelease
apply:  updateBundle(name, version) for the ticked rows, strictly in order
```

The queue is strictly serial because the profile holds a write lock that admits
one pnpm run at a time, and because an update is a removal plus an installation:
running two at once would interleave those steps. A failure is recorded and the
queue continues; the manager already rolls its own failed update back.

The browser half (`client.js`) registers the tab into `plugins.tab` and the toast
into `shell.overlay`, and talks to the Host over one exact route
(`/api/dsh-batch-updater/state`) registered on `connection.fetch`, which applies
the Host's own origin fence and browser login.

The route answers `state`, `refresh`, `updateAll`, `updateSelected`, `updateOne`,
`retryFailed`, `setInterval` and `cancel`. `updateOne` refuses any `name@version`
pair the last check did not itself verify, so the page cannot ask the Host to
install a target that was not vetted against the running DSH. `setInterval`
writes the field's volatile handle (so the running instance picks it up) and then
asks the settings service to store it (so it survives a restart).

Progress polling follows the answer: about once a second while a batch is
running, every 20 seconds otherwise.

## Development

```bash
# inline locale/*.json into client.js (the browser half is one file)
node scripts/embed-locale.mjs

# Host half: which bundles are listed, version choice, selection, serial order,
# failure continuation, cancel, interval floor
node test/host.test.mjs

# Browser half: slot registration, dictionaries, and seven page states render
node test/client.test.mjs

# Against a running Harness: confirm the route is mounted behind its login fence
node test/live-interval.mjs
```

`client.test.mjs` drives the components with a small React shim, because React
itself is packed inside the installation's Web artifact and not readable from
disk. It catches render-time crashes, wrong slots and missing copy — **not**
layout, styling, or how the page actually looks.

## Known limits

- **No "update" button beside Refresh.** The Plugins page declares no toolbar
  slot, so a tab is the supported place for this. It also means the tab cannot
  carry a coloured badge: `plugins.tab` labels are strings only, so the "N
  updates available" notice lives at the top of the tab instead.
- **A restart is sometimes still needed.** An update that reports
  `restart-required` is applied on disk; the tab says so and counts those rows.
- **New build scripts block an update.** If a new version needs newly approved
  pnpm build scripts, its installation fails and the manager reinstalls the
  previous version. Approve those scripts once through an ordinary install,
  then update again.

## Changelog

### 0.1.1

- Fix: saving the check interval used to restart the plugin, which emptied the
  tab and made it report "this profile has no plugin manager". The interval is
  now a volatile field applied in place, and a refused profile write is reported
  instead of being passed off as saved.
- Fix: a failed request no longer reads as "no plugin manager"; the last known
  list stays on screen, the real problem is named, and there is a retry.
- The settings schema is recognised again, so the interval is also editable from
  the plugin's own Configure page.

### 0.1.0

- First release.

## License

MIT
