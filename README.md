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
| Tarball, `link:` and `file:` installs | `updateBundle` needs a registry range or a pinned commit to resolve a newer version from. |
| Versions that need a newer DSH | Installing them would break the profile. |
| Deprecated versions, and targets that declare no bundle | Neither is a usable upgrade. |
| Prereleases | Unless `includePrerelease` is on. |
| Names listed in `skip` | Explicit opt-out. |

### Plugins installed from Git

The shipping manager never lists versions for a Git-installed bundle: it offers
an update only when the profile's dependency is pinned to a full 40-character
commit, and it takes the target commit from the caller. So a plugin installed as
`github:owner/repo` — the form **Add plugin** saves when you paste a repository
address — cannot be updated by the built-in updater at all, and no amount of
refreshing changes that.

This plugin reads the repository instead. For a **Git install** it fetches
`package.json` from the default branch of the forge the spec names (GitHub,
GitLab and Bitbucket), and compares its `version` with the installed one:

- **The repository moved ahead** — the row appears under **Installed from Git**
  with the newer version and its own **Update** button, and it is included in the
  page's **Update** button like a registry plugin.
- **It matches** — the row is up to date, like a registry plugin.

A row whose repository moved ahead is updatable like any other: it joins the same
batch and the same tick boxes. `updateBundle` has no path for an unpinned Git
spec — it accepts a Git target only from a dependency pinned to a full commit —
so the Host removes the copy and installs its saved spec again, which is exactly
what reinstalling it by hand does. The saved spec is unchanged by that (it stays
`github:owner/repo`, not a pinned commit), so the next check compares against the
new copy the same way.

The removal is the risky half, so a target that fails to install is reinstalled
once from the same spec before the row reports the failure.

A repository this cannot read (private, another host, no `package.json`) is
shown as blocked with that reason instead of pretending it is up to date.

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
check:  listBundles()  ->  the bundles with availability 'profile' and not
                           official
                       ->  update 'registry': listVersions(name)
                       ->  a Git spec: read the repository's package.json
                       ->  anything else: reported, not checked
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

### 0.1.12

- **Every row shows a time again.** The update line was fed only by what this
  plugin had itself witnessed, so packages installed before it existed showed
  nothing — twelve of thirteen rows were blank. It now uses the package
  directory's own timestamp, which pnpm writes on install and again on every
  replacement, so it exists for every package and names when the copy last
  changed. The recorded history stays as a fallback.

### 0.1.11

- **This plugin checks and updates itself.** It has its own row now, under the
  NPM/GIT groups, fed by the repository that installed it rather than by a
  registry. When the repository moves ahead the row offers **Update**, and the
  install is handed to a detached `dsh plugin --profile <name> add <spec>`
  process: the running copy cannot be removed by itself, so the new one takes
  effect at the next start. The result reports **restart required** and the row
  keeps offering the update until the running version actually changes.
- The install-date line is gone. The profile keeps no install record, so that
  line could only repeat the package directory's time; only a genuinely
  observed update is shown now, as **上次更新：**.

### 0.1.10

- **Fix: every plugin showed the same install and update time.** The update date
  fell back to the install date when no update had been recorded, so a copy that
  was only ever installed claimed to have been "updated" at exactly the moment
  it was installed. The update line is now shown only when a replacement was
  actually recorded, and a fresh profile shows the install date alone.
- **Fix: a Git row could stick at "网络异常" for the whole session.** The first
  scheduled check runs moments after startup, when the network may not be up
  yet; one failed read was remembered until the app restarted. The read is
  retried once, and a persistent failure now carries the underlying reason
  (DNS, timeout, refused) instead of the bare word "network".
- The second line reads **上次更新：** rather than 上次更新于：.

### 0.1.9

- **Fix: every date showed as "未知".** The history file was placed one level
  too high — `<home>/profiles/storages/...` instead of `<home>/storages/...` —
  because the Desktop Host does not pass `DSH_HOME` to plugin code, and the
  fallback took the profile directory's parent (which is `profiles`, not the
  home). The plugin now anchors on its own install path
  (`<home>/profiles/<name>/node_modules/<package>`), which needs no environment
  variable at all.
- The group headings all count items the same way: "从 NPM 安装，可更新 N 项",
  "从 GIT 安装，可更新 N 项", "已是最新 N 项", "无法自动更新 N 项".

### 0.1.8

- **The dates moved to their own right-aligned column.** They were appended to
  the version line as small trailing text, where they were easy to miss; each
  row now ends with two lines, "首次安装于：" and "上次更新于：", both in
  `YYYY-MM-DD HH:mm:ss`. Both lines always show — a copy never replaced has one
  timestamp standing for both — so the column does not jump between rows.

### 0.1.7

- **Both dates, to the second.** Each row now shows when its copy was
  installed and — once it has been replaced — when that happened, as
  `YYYY-MM-DD HH:mm:ss` (the earlier release showed a bare install date with no
  time). A copy that was installed and never touched shows one date.
- The install date comes from the package directory's own timestamp. The update
  date cannot: `pnpm` moves that timestamp on every reinstall, so after one
  update it can no longer say when the package first arrived. The plugin
  therefore keeps a small record of what it has seen under
  `<dsh home>/storages/dsh-batch-updater/history.json` and compares versions
  between checks; a package the record has never seen takes its directory time
  for both. The record is best-effort — a profile that cannot write it still
  shows install dates.

### 0.1.6

- **Git installs update in place now.** They were reported but not queued, on
  the grounds that `updateBundle` refuses an unpinned Git spec. The Host now
  removes the copy and installs its saved spec again — what a manual reinstall
  does — and verifies the saved spec survives unchanged.
- **One selection for both channels.** The page's **Update** button counts and
  updates registry and Git rows together, and each group carries its own
  **Update N selected** action over the rows it holds.
- **One phrasing for both groups**: "From NPM, N updatable" and "From GIT, N
  updatable", instead of a count for one and a sentence for the other.
- A Git install that fails to land is reinstalled from its spec once, so a
  failed update cannot leave the profile without a plugin it just had.

### 0.1.5

- **Each row shows when its copy was installed**, read from the package
  directory's own timestamp — the only per-package install record a pnpm
  profile keeps. A reinstall refreshes it, so the date is also when it last
  changed.
- **"Update" now moves rows as they finish.** Each row became up to date only
  after the entire batch ended, so a run of five looked frozen until the last
  one settled. A row now moves to **Up to date** the moment its own install
  returns.
- **The page re-reads when it becomes visible again**, and an action restarts
  the poller at the running cadence instead of leaving it on the 20-second idle
  timer. A backgrounded tab no longer comes back showing the list from before.
- **Removed the prose that explained the page to itself**: the "only plugins you
  installed yourself" footnote, the "checks only, never installs" suffix, and the
  paragraph above the Git group. The rows already say what they are.
- **One type scale.** Version numbers were rendering in a monospace face while
  every other row used the host's font; the page now inherits a single family at
  13px/12px, with figures kept column-aligned via `font-variant-numeric`.

### 0.1.4

- **Git-installed plugins are checked now.** The shipping manager lists no
  versions for a bundle installed as `github:owner/repo`, so refreshing the
  built-in page never showed an update for one. This page reads
  `package.json` from the repository's default branch on GitHub, GitLab or
  Bitbucket and compares it with the installed version.
- A Git install that moved ahead appears under **Installed from Git** with the
  newer version and a button that copies `dsh plugin --profile <name> add <spec>`.
  It is never queued by **Update** or `autoApply`, because replacing the copy
  means repointing the profile's dependency.
- A Git repository that cannot be read (private, another host, no
  `package.json`) is reported with that reason rather than shown as up to date.
- The metadata read is injectable, so the tests cover every Git path without
  touching the network.

### 0.1.3

- **Fix: nothing was listed as updatable on DSH 0.2.2-rc.2 and newer.** That
  release replaced the boolean `listBundles()[].updatable` with
  `update: 'registry' | 'git'`. The check still read the retired field, which is
  now always absent, so every registry plugin was filed under "cannot update
  automatically" and the page never offered anything. Both fields are read now,
  so installations on either side of the rename work.
- A Git copy (`update: 'git'`) is reported as not registry-installed, which is
  what it is: it moves only to another pinned commit of its own repository, and
  this page cannot produce one.
- An scp-like Git address (`git@host:owner/repo`) is recognised as a Git spec.
  It was previously read as if it were a registry range.

### 0.1.2

- `skip` now actually works: it was documented but missing from the settings
  schema, so the profile stripped it before the plugin ever saw it.
- One list instead of two. The updatable rows are derived from the rendered
  list, so a row can no longer offer an Update button after the batch already
  took it out of the queue.
- Version lookups run four at a time instead of one after another; a profile
  with a dozen plugins no longer waits out a dozen round trips.
- A published version equal to the installed one is not treated as an update.
- A refused version lookup now reports its small code (`not-found`,
  `network`, …) instead of pasting an English sentence into the UI.
- **Dismiss** on the result block now dismisses it; the button used to do
  nothing on the page (only the toast honoured it).
- An update that fails because new build scripts were never approved now names
  them and says what to do, instead of showing a bare failure code.
- The interval field gets real input styling instead of borrowing the button's.
- The count reads "N installed plugins, M enabled" so a disabled plugin is not
  counted as something that will update.

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
