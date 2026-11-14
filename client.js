window.__ModuleLoader__.load({
  id: 'dsh-batch-updater',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Dictionary namespace owned by this plugin. */
    const NS = 'batchUpdater'
    /** The exact route the Host half registered on `connection.fetch`. */
    const ROUTE = 'api/dsh-batch-updater/state'
    /** How often the page re-reads the Host's snapshot while it is idle. */
    const POLL_MS = 20_000
    /** How often it re-reads while a batch is running: progress must move. */
    const RUNNING_POLL_MS = 1_200

    const inject = ['slots', 'locale']

    // BEGIN GENERATED LOCALE — written by scripts/embed-locale.mjs from locale/*.json
    const zh = {
      "tab": "更新",
      "loading": "正在读取插件列表…",
      "checkNow": "立即检查",
      "checking": "检查中…",
      "cancel": "停止",
      "updateAll": "全部更新",
      "updateThis": "更新",
      "updatingAll": "更新中…",
      "dismissRun": "知道了",
      "retryFailed": "重试失败的 {count} 个",
      "noticeUpdatable": "有 {count} 个插件可以更新。",
      "checkedAt": "上次检查 {time}",
      "checkedCount": "共 {count} 个自装插件，{enabled} 个启用",
      "neverChecked": "还没检查过",
      "allUpToDate": "已是最新版本。",
      "checkFailed": "检查失败：{message}",
      "stale": "插件列表有变动，结果可能已过期。",
      "updatableGroup": "可更新 {count}",
      "currentGroup": "已是最新 {count}",
      "blockedCount": "无法自动更新 {count}",
      "gitGroup": "从 Git 安装，有新版本 {count}",
      "gitGroupNote": "这些插件从 Git 仓库安装，内置管理器不会为它们查询版本。下面是仓库里的最新版本；点右侧按钮复制重装命令。",
      "gitManualHint": "需重装",
      "gitCopyCommand": "复制命令",
      "gitCopied": "已复制",
      "gitCopyTip": "复制：dsh plugin --profile desktop add {spec}",
      "gitUnreadable": "读不到这个仓库的版本信息",
      "gitUnsupportedHost": "只支持 GitHub / GitLab / Bitbucket 仓库",
      "selectAll": "全选可更新的插件",
      "selectRow": "选择 {name}",
      "intervalLabel": "检查间隔（分钟）",
      "intervalSave": "保存",
      "intervalBad": "没能保存：{message}",
      "intervalNotSaved": "已生效，但没能写入配置，重启后会恢复原值。",
      "unreachable": "暂时连不上 DSH 宿主（{message}），正在自动重试。",
      "retryConnect": "立即重试",
      "autoOff": "· 只检查，不自动安装",
      "autoOn": "· 发现更新会自动安装",
      "selfNote": "只显示你自行安装的插件；DSH 自带的插件和本插件不在列表中。",
      "runProgress": "正在更新 {index}/{total}：{name}",
      "runFinished": "更新完成：{applied} 个成功，{failed} 个失败",
      "runCancelled": "更新已停止",
      "needsBuildApproval": "安装失败：新版需要先批准 {count} 个构建脚本，去官方安装对话框批准一次后重试。",
      "restartHint": "其中 {count} 个需要重启 DeepSeek Harness 才会生效。",
      "retryHint": "没有其它可更新的插件了；上面失败的 {count} 个可以重试。",
      "statusDone": "已完成",
      "statusRestart": "需重启",
      "statusFailed": "失败",
      "statusCancelled": "已取消",
      "statusOverridden": "被覆盖",
      "statusRunning": "更新中",
      "statusWaiting": "等待",
      "disabledTag": "已停用",
      "reasonOfficial": "DSH 自带",
      "reasonNotUpdatable": "无需更新",
      "reasonNotFromRegistry": "非 registry 安装，无法自动更新",
      "reasonSkipped": "已在配置中跳过",
      "reasonSelf": "本插件自身",
      "reasonNeedsDsh": "需要更新 DSH",
      "reasonPrerelease": "只有预发布版本",
      "reasonDeprecated": "新版本均已废弃",
      "reasonNotBundle": "新版本不是插件包",
      "reasonNotFound": "仓库里找不到这个包",
      "reasonNetwork": "网络异常，读取版本失败",
      "reasonLookupFailed": "版本查询失败",
      "noManager": "当前 profile 没有插件管理服务，此页不可用。",
      "openPackage": "在「已安装」中查看",
      "toastTitle": "插件更新",
      "toastDone": "{count} 个插件已更新",
      "toastFailed": "{count} 个插件更新失败"
    }
    const en = {
      "tab": "Updates",
      "loading": "Reading your plugins…",
      "checkNow": "Check now",
      "checking": "Checking…",
      "cancel": "Stop",
      "updateAll": "Update",
      "updateThis": "Update",
      "updatingAll": "Updating…",
      "dismissRun": "Dismiss",
      "retryFailed": "Retry {count} failed",
      "noticeUpdatable": "{count} plugins can be updated.",
      "checkedAt": "Checked {time}",
      "checkedCount": "{count} installed plugins, {enabled} enabled",
      "neverChecked": "Not checked yet",
      "allUpToDate": "Everything is up to date.",
      "checkFailed": "Check failed: {message}",
      "stale": "Your plugins changed, so this result may be out of date.",
      "updatableGroup": "Can update {count}",
      "currentGroup": "Up to date {count}",
      "blockedCount": "Cannot update automatically {count}",
      "gitGroup": "Installed from Git, newer version {count}",
      "gitGroupNote": "These were installed from a Git repository, which the built-in manager does not query for versions. The newest version in the repository is below; copy the reinstall command with the button on the right.",
      "gitManualHint": "reinstall to update",
      "gitCopyCommand": "Copy command",
      "gitCopied": "Copied",
      "gitCopyTip": "Copy: dsh plugin --profile desktop add {spec}",
      "gitUnreadable": "Could not read this repository's version",
      "gitUnsupportedHost": "Only GitHub / GitLab / Bitbucket repositories are supported",
      "selectAll": "Select every updatable plugin",
      "selectRow": "Select {name}",
      "intervalLabel": "Check every (minutes)",
      "intervalSave": "Save",
      "intervalBad": "Could not save: {message}",
      "intervalNotSaved": "Applied, but it could not be written to the profile; it reverts on restart.",
      "unreachable": "Cannot reach the DSH host right now ({message}); retrying automatically.",
      "retryConnect": "Retry now",
      "autoOff": "· checks only, never installs",
      "autoOn": "· installs what it finds",
      "selfNote": "Only the plugins you installed yourself; DSH's own bundles and this plugin are left out.",
      "runProgress": "Updating {index}/{total}: {name}",
      "runFinished": "Finished: {applied} updated, {failed} failed",
      "runCancelled": "The run was stopped",
      "needsBuildApproval": "Failed: the new version needs {count} build script(s) approved first. Approve them once in the official install dialog, then retry.",
      "restartHint": "{count} of them need a DeepSeek Harness restart to take effect.",
      "retryHint": "Nothing else can be updated; the {count} that failed above can be retried.",
      "statusDone": "Done",
      "statusRestart": "Restart needed",
      "statusFailed": "Failed",
      "statusCancelled": "Cancelled",
      "statusOverridden": "Overridden",
      "statusRunning": "Updating",
      "statusWaiting": "Waiting",
      "disabledTag": "Disabled",
      "reasonOfficial": "Shipped with DSH",
      "reasonNotUpdatable": "Nothing to update",
      "reasonNotFromRegistry": "Not installed from a registry, so it cannot be updated automatically",
      "reasonSkipped": "Skipped in settings",
      "reasonSelf": "This plugin itself",
      "reasonNeedsDsh": "Needs a newer DSH",
      "reasonPrerelease": "Prerelease only",
      "reasonDeprecated": "Newer versions are deprecated",
      "reasonNotBundle": "The newer version is not a plugin bundle",
      "reasonNotFound": "No such package in the registry",
      "reasonNetwork": "Network problem while reading versions",
      "reasonLookupFailed": "Version lookup failed",
      "noManager": "This profile has no plugin manager, so this page is unavailable.",
      "openPackage": "Open in Installed",
      "toastTitle": "Plugin updates",
      "toastDone": "{count} plugins updated",
      "toastFailed": "{count} plugins failed to update"
    }
    // END GENERATED LOCALE

    /**
     * Resolve a route against the directory the Host serves the UI from, so a
     * mounted deployment keeps working. Same rule the shipped market uses.
     * @param path - the route without leading slashes.
     * @returns the pathname to fetch.
     */
    function apiPath(path) {
      const relative = path.replace(/^\/+/, '')
      if (typeof document === 'undefined') return `/${relative}`
      return new URL(relative, document.baseURI).pathname
    }

    /**
     * Ask the Host for the current state, or run one of its actions.
     * @param action - `state`, `refresh`, `updateAll`, `updateSelected`,
     *   `updateOne`, `retryFailed`, `setInterval` or `cancel`.
     * @param payload - extra fields the action needs.
     * @returns the snapshot, or a snapshot-shaped failure.
     */
    async function callHost(action, payload) {
      try {
        const response = await fetch(apiPath(ROUTE), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action, ...(payload ?? {}) }),
        })
        if (!response.ok) {
          return { ok: false, code: `http-${response.status}`, message: `HTTP ${response.status}` }
        }
        return await response.json()
      } catch (error) {
        return { ok: false, code: 'network', message: String((error && error.message) || error) }
      }
    }

    /**
     * Fill `{name}` placeholders in one dictionary string.
     * @param text - the template.
     * @param values - the substitutions.
     * @returns the final text.
     */
    function fill(text, values) {
      if (typeof text !== 'string') return ''
      return text.replace(/\{(\w+)\}/g, (whole, key) =>
        values !== undefined && key in values ? String(values[key]) : whole,
      )
    }

    /**
     * Format a timestamp the way the host formats times elsewhere.
     * @param ms - epoch milliseconds.
     * @returns a short local time, or an empty string.
     */
    function formatTime(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return ''
      try {
        return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
      } catch {
        return new Date(ms).toISOString()
      }
    }

    /**
     * The shared client store: one poller, several readers.
     * @returns a store with `getSnapshot`, `subscribe`, `refresh` and `act`.
     */
    function createStore() {
      let snapshot = { loading: true, data: null, error: null, dismissedRunAt: null }
      const listeners = new Set()
      let inFlight = null

      const publish = (next) => {
        snapshot = { ...snapshot, ...next }
        for (const listener of listeners) listener()
      }

      const load = () => {
        if (inFlight !== null) return inFlight
        inFlight = (async () => {
          const data = await callHost('state')
          // A transport failure keeps the last known list on screen; dropping it
          // would make a one-second blip look like the profile lost its plugins.
          const failed = data?.ok === false
          publish({
            loading: false,
            data: failed ? snapshot.data : data,
            error: failed ? { message: data.message ?? '', code: data.code ?? '' } : null,
          })
          inFlight = null
          return data
        })()
        return inFlight
      }

      /**
       * A batch is a long-lived Host operation, so the page polls it far more
       * often than an idle one while the run is live.
       * @returns the delay the next poll should wait.
       */
      const nextDelay = () => {
        const run = snapshot.data?.run
        const live =
          run !== null && run !== undefined && (run.status === 'running' || run.status === 'cancelling')
        return live ? RUNNING_POLL_MS : POLL_MS
      }

      return {
        getSnapshot: () => snapshot,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        refresh: load,
        nextDelay,
        /**
         * Run one Host action and fold the answer back into the store.
         * @param action - the action name.
         * @param payload - extra fields the action needs.
         * @returns the Host's answer.
         */
        act: async (action, payload) => {
          const data = await callHost(action, payload)
          const failed = data?.ok === false
          publish({
            loading: false,
            // A failed action changes nothing, so the previous snapshot stays.
            data: failed ? snapshot.data : data,
            error: failed ? { message: data.message ?? '', code: data.code ?? '' } : null,
          })
          return data
        },
        dismissRun: (startedAt) => {
          publish({ dismissedRunAt: startedAt })
        },
      }
    }

    /**
     * Subscribe a component to the shared store.
     * @param store - the store.
     * @returns the current snapshot, re-rendering on change.
     */
    function useStore(store) {
      return React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
    }

    /**
     * Styles for this page, expressed only through the host's theme tokens so
     * light/dark, font settings and density follow the rest of the app.
     * @returns a style element, removed with the component.
     */
    function Styles() {
      return h(
        'style',
        null,
        `
.bu-page { display: flex; flex-direction: column; gap: 12px; padding: 2px 0 28px; }
.bu-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.bu-toolbarSpacer { flex: 1 1 auto; }
.bu-note { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
.bu-notice { display: flex; align-items: flex-start; gap: 8px; padding: 8px 12px; border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-primary); font-size: 12px; line-height: 18px; }
.bu-noticeDot { flex: none; width: 6px; height: 6px; margin-top: 6px; border-radius: 50%;
  background: var(--dsw-alias-brand-primary); }
.bu-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  height: 28px; padding: 0 12px; border-radius: 8px; cursor: pointer; font-family: inherit;
  font-size: 13px; line-height: 1; border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }
.bu-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
.bu-btn:disabled { opacity: .45; cursor: default; }
.bu-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.bu-btnPrimary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-bg-base); }
.bu-btnPrimary:hover:not(:disabled) { filter: brightness(1.05); background: var(--dsw-alias-brand-primary); }
.bu-btnGhost { border-color: transparent; background: transparent; color: var(--dsw-alias-label-secondary); }
.bu-btnGhost:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
.bu-input { width: 84px; height: 28px; padding: 0 8px; border-radius: 8px; text-align: center;
  border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary); font-family: inherit; font-size: 13px; }
.bu-input:disabled { opacity: .45; }
.bu-input:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }

.bu-group { display: flex; flex-direction: column; gap: 8px; }
.bu-groupTitle { font-size: 12px; font-weight: 500; color: var(--dsw-alias-label-secondary);
  display: flex; align-items: center; gap: 8px; padding: 0 2px; }
.bu-cards { display: flex; flex-direction: column; gap: 1px; border-radius: 10px; overflow: hidden;
  border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-border-l1); }
.bu-row { display: flex; align-items: center; gap: 12px; padding: 10px 12px;
  background: var(--dsw-alias-bg-layer-1); }
.bu-row:hover { background: var(--dsw-alias-bg-layer-2); }
.bu-check { flex: none; width: 15px; height: 15px; margin: 0; cursor: pointer;
  accent-color: var(--dsw-alias-brand-primary); }
.bu-check:disabled { cursor: default; opacity: .45; }
.bu-rowMain { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.bu-title { font-size: 13px; color: var(--dsw-alias-label-primary); overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
.bu-titleBtn { border: none; background: none; padding: 0; font: inherit; text-align: left;
  color: inherit; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  max-width: 100%; }
.bu-titleBtn:hover { color: var(--dsw-alias-brand-primary); }
.bu-titleBtn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px;
  border-radius: 3px; }
.bu-sub { font-size: 12px; color: var(--dsw-alias-label-secondary); overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
.bu-mono { font-family: var(--dsw-font-mono, ui-monospace, monospace); font-size: 12px; }
.bu-rowEnd { flex: none; display: flex; align-items: center; gap: 8px; }
.bu-badge { display: inline-flex; align-items: center; height: 20px; padding: 0 8px; border-radius: 999px;
  font-size: 11px; line-height: 1; white-space: nowrap; background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary); }
.bu-badgeOk { color: var(--dsw-alias-state-success-primary); }
.bu-badgeWarn { color: var(--dsw-alias-state-warn-primary); }
.bu-badgeErr { color: var(--dsw-alias-state-error-primary); }
.bu-empty { padding: 20px 12px; text-align: center; font-size: 13px;
  color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-1); }
.bu-error { padding: 10px 12px; border-radius: 8px; font-size: 12px; line-height: 18px;
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-state-error-primary);
  word-break: break-word; }
.bu-bar { height: 3px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; }
.bu-barFill { height: 100%; background: var(--dsw-alias-brand-primary); transition: width .25s ease; }
.bu-toast { position: fixed; right: 20px; bottom: 20px; z-index: 60; max-width: 340px;
  display: flex; align-items: flex-start; gap: 10px; padding: 12px 14px; border-radius: 10px;
  border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-overlay);
  box-shadow: 0 8px 28px rgba(0,0,0,.18); font-size: 13px; color: var(--dsw-alias-label-primary); }
.bu-toastBody { display: flex; flex-direction: column; gap: 2px; }
.bu-toastTitle { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.bu-toastClose { flex: none; border: none; background: transparent; padding: 0 2px; cursor: pointer;
  color: var(--dsw-alias-label-secondary); font-family: inherit; font-size: 16px; line-height: 1; }
.bu-toastClose:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px;
  border-radius: 4px; }
`,
      )
    }

    /**
     * One row's outcome, worded through the dictionary.
     * @param props - `outcome` and the translator.
     * @returns the badge element.
     */
    function OutcomeBadge({ outcome, t }) {
      const table = {
        applied: { label: t('statusDone'), cls: 'bu-badgeOk' },
        'restart-required': { label: t('statusRestart'), cls: 'bu-badgeWarn' },
        cancelled: { label: t('statusCancelled'), cls: '' },
        overridden: { label: t('statusOverridden'), cls: 'bu-badgeWarn' },
        failed: { label: t('statusFailed'), cls: 'bu-badgeErr' },
        running: { label: t('statusRunning'), cls: '' },
      }
      const entry = table[outcome] ?? { label: t('statusWaiting'), cls: '' }
      return h('span', { className: `bu-badge ${entry.cls}`.trim() }, entry.label)
    }

    /**
     * Turn one blocked reason code into the page's wording.
     * @param reason - the code the Host reported.
     * @param t - translator.
     * @returns the display text.
     */
    function blockedText(reason, t) {
      if (typeof reason !== 'string' || reason === '') return t('reasonNotUpdatable')
      if (reason === 'official') return t('reasonOfficial')
      if (reason === 'not-updatable') return t('reasonNotUpdatable')
      if (reason === 'not-from-registry') return t('reasonNotFromRegistry')
      if (reason === 'skipped-by-config') return t('reasonSkipped')
      if (reason === 'self') return t('reasonSelf')
      if (reason === 'prerelease-only') return t('reasonPrerelease')
      if (reason === 'deprecated-only') return t('reasonDeprecated')
      if (reason === 'target-is-not-a-bundle') return t('reasonNotBundle')
      if (reason === 'git-unreadable') return t('gitUnreadable')
      if (reason === 'git-unsupported-host') return t('gitUnsupportedHost')
      if (reason === 'git-not-found') return t('reasonNotFound')
      if (reason === 'not-found') return t('reasonNotFound')
      if (reason === 'network') return t('reasonNetwork')
      if (reason === 'unknown') return t('reasonLookupFailed')
      if (reason.startsWith('needs-newer-dsh')) return t('reasonNeedsDsh')
      if (reason.startsWith('version-lookup')) return t('reasonLookupFailed')
      return reason
    }

    /**
     * A checkbox that reports its own state, styled like the host's controls.
     * @param props - checked, disabled, label, onChange.
     * @returns the input element.
     */
    function Check(props) {
      return h('input', {
        type: 'checkbox',
        className: 'bu-check',
        checked: props.checked,
        disabled: props.disabled === true,
        'aria-label': props.label,
        onChange: (event) => props.onChange(event.target.checked),
      })
    }

    /**
     * One installed plugin the page can act on.
     * @param props - the row, selection state, translator, and callbacks.
     * @returns the row element.
     */
    function PluginRow(props) {
      const { row, t, openPackage } = props
      const updatable = row.state === 'updatable'
      const gitUpdatable = row.state === 'git-updatable'
      const live = props.live === true
      const detail = updatable
        ? `${row.installedVersion} → ${row.targetVersion}`
        : gitUpdatable
          ? `${row.installedVersion} → ${row.targetVersion} · ${t('gitManualHint')}`
          : row.state === 'blocked'
            ? blockedText(row.reason, t)
            : row.installedVersion

      return h(
        'div',
        { className: 'bu-row' },
        h(Check, {
          checked: updatable && props.selected === true,
          disabled: !updatable || props.busy === true,
          label: fill(t('selectRow'), { name: row.name }),
          onChange: (next) => props.onSelect(row.name, next),
        }),
        h(
          'div',
          { className: 'bu-rowMain' },
          typeof openPackage === 'function'
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'bu-title bu-titleBtn',
                  title: t('openPackage'),
                  onClick: () => openPackage(row.name),
                },
                row.name,
              )
            : h('div', { className: 'bu-title' }, row.name),
          h('div', { className: `bu-sub ${updatable ? 'bu-mono' : ''}`.trim() }, detail),
        ),
        h(
          'div',
          { className: 'bu-rowEnd' },
          live
            ? h(OutcomeBadge, { outcome: 'running', t })
            : updatable
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'bu-btn',
                    disabled: props.busy === true || props.running === true,
                    onClick: () => props.onUpdateOne(row),
                  },
                  t('updateThis'),
                )
              : gitUpdatable
                // The batch cannot install this one: the dependency has to be
                // repointed at a commit, which is a profile edit, not an update.
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'bu-btn',
                      title: fill(t('gitCopyTip'), { spec: String(row.spec ?? '') }),
                      onClick: () => props.onCopySpec(row),
                    },
                    props.copied === true ? t('gitCopied') : t('gitCopyCommand'),
                  )
                : null,
          row.enabled === false ? h('span', { className: 'bu-badge' }, t('disabledTag')) : null,
        ),
      )
    }

    /**
     * The Updates tab page.
     * @param props - injected props (`t`, `store`) plus the owner's `openPackage`.
     * @returns the page element.
     */
    function UpdatesTab(props) {
      const t = props.t
      const store = props.store
      const openPackage = props.openPackage
      const snapshot = useStore(store)
      const data = snapshot.data
      const [busy, setBusy] = React.useState(false)
      const [selected, setSelected] = React.useState({ deselected: [] })
      const [intervalDraft, setIntervalDraft] = React.useState(null)
      const [intervalError, setIntervalError] = React.useState(null)
      const [intervalNote, setIntervalNote] = React.useState(null)
      // The package whose reinstall command was just copied, so one button can
      // say so; it clears itself after a moment.
      const [copiedSpec, setCopiedSpec] = React.useState(null)

      React.useEffect(() => {
        store.refresh()
      }, [store])

      const run = data?.run ?? null
      const running = run !== null && (run.status === 'running' || run.status === 'cancelling')
      const plugins = Array.isArray(data?.plugins) ? data.plugins : []
      // "The Host says it has no manager" and "we could not reach the Host" are
      // different failures. Only the first means this profile cannot use the
      // feature; the second is a transport problem that resolves on its own, and
      // conflating them told users their plugin manager had vanished whenever a
      // request happened to fail.
      const managerMissing = data?.available === false
      // Any failed request is a transport problem, whether or not an older list
      // is still on screen. Saying so is what keeps a blip from being mistaken
      // for a profile without a plugin manager.
      const unreachable = snapshot.error !== null
      const available = !managerMissing
      const checkedAt = formatTime(data?.checkedAt)

      const updatableNames = plugins.filter((row) => row.state === 'updatable').map((row) => row.name)
      const blockedRows = plugins.filter((row) => row.state === 'blocked')
      const currentRows = plugins.filter((row) => row.state === 'current')
      const gitRows = plugins.filter((row) => row.state === 'git-updatable')

      // Selection defaults to "everything that can move", derived rather than
      // set by an effect: a check that finds new work should not leave the
      // button dead until a second render. Unticking is stored as the opposite
      // of that default, so a refreshed list cannot resurrect a stale tick.
      const activeSelection = selected.deselected.length === 0
        ? updatableNames
        : updatableNames.filter((name) => !selected.deselected.includes(name))
      const allSelected = updatableNames.length > 0 && activeSelection.length === updatableNames.length

      /**
       * Run one Host action with the controls disabled meanwhile.
       * @param action - the action name.
       * @param payload - extra fields the action needs.
       */
      const act = async (action, payload) => {
        setBusy(true)
        try {
          await store.act(action, payload)
        } finally {
          setBusy(false)
        }
      }

      const toggleOne = (name, next) => {
        setSelected((previous) => {
          const current = previous.deselected
          if (next) return { deselected: current.filter((n) => n !== name) }
          return { deselected: current.includes(name) ? current : [...current, name] }
        })
      }

      const toggleAll = (next) => {
        setSelected({ deselected: next ? [] : [...updatableNames] })
      }

      /**
       * Put a Git plugin's reinstall command on the clipboard.
       *
       * A Git-installed bundle updates only by repointing its dependency, which
       * the manager refuses to do from inside itself, so the page hands over the
       * exact command instead of pretending an Update button would work.
       * @param row - the git row.
       */
      const copySpec = async (row) => {
        const spec = String(row?.spec ?? '')
        if (spec === '') return
        const command = `dsh plugin --profile desktop add ${spec}`
        try {
          await navigator.clipboard.writeText(command)
          setCopiedSpec(row.name)
          setTimeout(() => setCopiedSpec(null), 2000)
        } catch {
          // A browser that refuses clipboard access still shows the spec in the
          // row's tooltip, so there is nothing to report here.
        }
      }

      const runFailures = Array.isArray(run?.results) ? run.results.filter((row) => row.outcome === 'failed') : []
      const appliedCount = Array.isArray(run?.results)
        ? run.results.filter((row) => row.outcome === 'applied' || row.outcome === 'restart-required').length
        : 0
      const needRestart = Array.isArray(run?.results)
        ? run.results.filter((row) => row.outcome === 'restart-required').length
        : 0

      const statusLine =
        data === null || snapshot.loading
          ? t('loading')
          : data.checkError
            ? fill(t('checkFailed'), { message: data.checkError })
            : checkedAt === ''
              ? t('neverChecked')
              : `${fill(t('checkedAt'), { time: checkedAt })} · ${fill(t('checkedCount'), {
                  count: data.checked ?? 0,
                  enabled: plugins.filter((row) => row.enabled).length,
                })}`

      const intervalValue =
        intervalDraft !== null ? intervalDraft : String(data?.config?.intervalMinutes ?? 360)

      const total = run !== null && typeof run.total === 'number' && run.total > 0 ? run.total : 0
      const doneCount = run !== null ? (Array.isArray(run.results) ? run.results.length : 0) : 0
      const percent = total > 0 ? Math.min(100, Math.round(((running ? doneCount : total) / total) * 100)) : 0

      const renderRows = (rows) =>
        h(
          'div',
          { className: 'bu-cards' },
          rows.map((row) =>
            h(PluginRow, {
              key: row.name,
              row,
              t,
              openPackage,
              busy,
              running,
              selected: activeSelection.includes(row.name),
              live: run !== null && run.current !== null && run.current !== undefined && run.current.name === row.name,
              copied: copiedSpec === row.name,
              onSelect: toggleOne,
              onCopySpec: copySpec,
              onUpdateOne: (item) => act('updateOne', { name: item.name, version: item.targetVersion }),
            }),
          ),
        )

      return h(
        'div',
        { className: 'bu-page notranslate' },
        h(Styles, null),

        // The change notice the page shows in place of a tab badge.
        updatableNames.length > 0 && !running
          ? h(
              'div',
              { className: 'bu-notice', role: 'status' },
              h('span', { className: 'bu-noticeDot', 'aria-hidden': 'true' }),
              h('span', null, fill(t('noticeUpdatable'), { count: updatableNames.length })),
            )
          : null,

        h(
          'div',
          { className: 'bu-toolbar' },
          h(
            'button',
            {
              type: 'button',
              className: 'bu-btn',
              disabled: busy || !available || data?.checking === true || running,
              onClick: () => act('refresh'),
            },
            data?.checking === true ? t('checking') : t('checkNow'),
          ),
          running
            ? h(
                'button',
                { type: 'button', className: 'bu-btn', disabled: busy, onClick: () => act('cancel') },
                t('cancel'),
              )
            : null,
          h(
            'button',
            {
              type: 'button',
              className: 'bu-btn bu-btnPrimary',
              disabled: busy || running || activeSelection.length === 0 || !available,
              onClick: () => act('updateSelected', { names: activeSelection }),
            },
            running
              ? t('updatingAll')
              : activeSelection.length === 0
                ? t('updateAll')
                : `${t('updateAll')} (${activeSelection.length})`,
          ),
          h('span', { className: 'bu-toolbarSpacer' }),
          h('span', { className: 'bu-note' }, statusLine),
        ),

        // Schedule control. The same value is editable from the plugin's own
        // Configure page; this is the shortcut for the one setting people change.
        available
          ? h(
              'div',
              { className: 'bu-toolbar' },
              h('span', { className: 'bu-note' }, t('intervalLabel')),
              h('input', {
                type: 'number',
                className: 'bu-input bu-mono',
                min: 5,
                max: 10080,
                step: 1,
                value: intervalValue,
                disabled: busy || !available,
                'aria-label': t('intervalLabel'),
                onChange: (event) => setIntervalDraft(event.target.value),
              }),
              h(
                'button',
                {
                  type: 'button',
                  className: 'bu-btn',
                  disabled: busy || !available || intervalDraft === null,
                  onClick: async () => {
                    const answer = await act('setInterval', { minutes: Number(intervalValue) })
                    // A refused save must say so; silently clearing the draft
                    // made a rejected value look accepted.
                    if (answer?.ok === false) {
                      setIntervalError(answer.message ?? answer.code ?? '')
                      return
                    }
                    // Applied but not written down: the timer really did change,
                    // so do not claim it failed — say it will not survive a restart.
                    setIntervalError(null)
                    setIntervalNote(answer?.persisted === false ? t('intervalNotSaved') : null)
                    setIntervalDraft(null)
                  },
                },
                t('intervalSave'),
              ),
              intervalError !== null
                ? h('span', { className: 'bu-note', role: 'alert', style: { color: 'var(--dsw-alias-state-error-primary)' } },
                    fill(t('intervalBad'), { message: intervalError }))
                : null,
              intervalNote !== null
                ? h('span', { className: 'bu-note', role: 'status' }, intervalNote)
                : null,
              h(
                'span',
                { className: 'bu-note' },
                fill(data?.config?.autoApply === true ? t('autoOn') : t('autoOff'), {
                  minutes: data?.config?.intervalMinutes ?? 0,
                }),
              ),
            )
          : null,

        managerMissing
          ? h('div', { className: 'bu-cards' }, h('div', { className: 'bu-empty' }, t('noManager')))
          : null,
        unreachable
          ? h(
              'div',
              { className: 'bu-error' },
              `${fill(t('unreachable'), { message: snapshot.error?.message ?? '' })} `,
              h(
                'button',
                { type: 'button', className: 'bu-btn bu-btnGhost', onClick: () => act('state') },
                t('retryConnect'),
              ),
            )
          : null,
        data?.checkError
          ? h('div', { className: 'bu-error' }, fill(t('checkFailed'), { message: data.checkError }))
          : null,
        data?.stale === true ? h('div', { className: 'bu-note' }, t('stale')) : null,

        // A finished run keeps its result block on screen until dismissed.
        run !== null &&
        Array.isArray(run.results) &&
        run.results.length > 0 &&
        (running || snapshot.dismissedRunAt !== run.startedAt)
          ? h(
              'div',
              { className: 'bu-group' },
              h(
                'div',
                { className: 'bu-groupTitle' },
                h(
                  'span',
                  null,
                  running
                    ? fill(t('runProgress'), {
                        index: Math.min(total, doneCount + 1),
                        total,
                        name: run.current?.name ?? '',
                      })
                    : run.status === 'cancelled'
                      ? t('runCancelled')
                      : fill(t('runFinished'), { applied: appliedCount, failed: runFailures.length }),
                ),
                h('span', { className: 'bu-toolbarSpacer' }),
                !running && runFailures.length > 0
                  ? h(
                      'button',
                      {
                        type: 'button',
                        className: 'bu-btn bu-btnGhost',
                        disabled: busy,
                        onClick: () => act('retryFailed'),
                      },
                      fill(t('retryFailed'), { count: runFailures.length }),
                    )
                  : null,
                !running
                  ? h(
                      'button',
                      {
                        type: 'button',
                        className: 'bu-btn bu-btnGhost',
                        onClick: () => store.dismissRun(run.startedAt ?? null),
                      },
                      t('dismissRun'),
                    )
                  : null,
              ),
              running
                ? h(
                    'div',
                    {
                      className: 'bu-bar',
                      role: 'progressbar',
                      'aria-valuemin': 0,
                      'aria-valuemax': total,
                      'aria-valuenow': doneCount,
                      'aria-label': fill(t('runProgress'), {
                        index: Math.min(total, doneCount + 1),
                        total,
                        name: run.current?.name ?? '',
                      }),
                    },
                    h('div', { className: 'bu-barFill', style: { width: `${percent}%` } }),
                  )
                : null,
              needRestart > 0
                ? h('div', { className: 'bu-note' }, fill(t('restartHint'), { count: needRestart }))
                : null,
              h(
                'div',
                { className: 'bu-cards' },
                run.results.map((row) =>
                  h(
                    'div',
                    { className: 'bu-row', key: `${row.name}-${row.to}` },
                    h(
                      'div',
                      { className: 'bu-rowMain' },
                      h('div', { className: 'bu-title' }, row.name),
                      h(
                        'div',
                        { className: 'bu-sub bu-mono' },
                        Array.isArray(row.pendingBuilds) && row.pendingBuilds.length > 0
                          ? fill(t('needsBuildApproval'), { count: row.pendingBuilds.length })
                          : `${row.from} → ${row.to}`,
                      ),
                    ),
                    h(
                      'div',
                      { className: 'bu-rowEnd' },
                      row.outcome === 'failed' && row.code && !Array.isArray(row.pendingBuilds)
                        ? h('span', { className: 'bu-sub' }, row.code)
                        : null,
                      h(OutcomeBadge, { outcome: row.outcome, t }),
                    ),
                  ),
                ),
              ),
            )
          : null,

        // The list is always present: an empty page tells the user nothing.
        available
          ? h(
              'div',
              { className: 'bu-group' },
              h(
                'div',
                { className: 'bu-groupTitle' },
                h('span', null, fill(t('updatableGroup'), { count: updatableNames.length })),
                updatableNames.length > 0
                  ? h(Check, {
                      checked: allSelected,
                      disabled: busy || running,
                      label: t('selectAll'),
                      onChange: toggleAll,
                    })
                  : null,
              ),
              updatableNames.length > 0
                ? renderRows(plugins.filter((row) => row.state === 'updatable'))
                : h(
                    'div',
                    { className: 'bu-cards' },
                    h(
                      'div',
                      { className: 'bu-empty' },
                      data === null || snapshot.loading
                        ? t('loading')
                        : runFailures.length > 0
                          ? fill(t('retryHint'), { count: runFailures.length })
                          : checkedAt === ''
                            ? t('neverChecked')
                            : t('allUpToDate'),
                    ),
                  ),
            )
          : null,

        // Git installs that moved ahead. The batch cannot touch them, so they
        // get their own group with the exact reinstall command.
        available && gitRows.length > 0
          ? h(
              'div',
              { className: 'bu-group' },
              h(
                'div',
                { className: 'bu-groupTitle' },
                h('span', null, fill(t('gitGroup'), { count: gitRows.length })),
              ),
              h('div', { className: 'bu-note' }, t('gitGroupNote')),
              renderRows(gitRows),
            )
          : null,

        available && currentRows.length > 0
          ? h(
              'div',
              { className: 'bu-group' },
              h('div', { className: 'bu-groupTitle' }, h('span', null, fill(t('currentGroup'), { count: currentRows.length }))),
              renderRows(currentRows),
            )
          : null,

        available && blockedRows.length > 0
          ? h(
              'div',
              { className: 'bu-group' },
              h(
                'div',
                { className: 'bu-groupTitle' },
                h('span', null, fill(t('blockedCount'), { count: blockedRows.length })),
              ),
              renderRows(blockedRows),
            )
          : null,

        h('div', { className: 'bu-note' }, t('selfNote')),
      )
    }

    /**
     * The frame-wide result toast.
     * @param props - the store and the translator.
     * @returns a toast element, or null.
     */
    function ResultToast(props) {
      const { store, t } = props
      const snapshot = useStore(store)
      const run = snapshot.data?.run ?? null

      React.useEffect(() => {
        store.refresh()
      }, [store])

      if (run === null || typeof run !== 'object') return null
      const running = run.status === 'running' || run.status === 'cancelling'
      if (running) return null
      if (run.startedAt !== null && run.startedAt === snapshot.dismissedRunAt) return null
      const results = Array.isArray(run.results) ? run.results : []
      if (results.length === 0) return null
      const applied = results.filter((row) => row.outcome === 'applied' || row.outcome === 'restart-required').length
      const failed = results.filter((row) => row.outcome === 'failed').length

      return h(
        'div',
        { className: 'bu-toast notranslate', role: 'status' },
        h(Styles, null),
        h(
          'div',
          { className: 'bu-toastBody' },
          h('span', { className: 'bu-toastTitle' }, t('toastTitle')),
          h('span', null, failed > 0 ? fill(t('toastFailed'), { count: failed }) : fill(t('toastDone'), { count: applied })),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'bu-toastClose',
            'aria-label': t('dismissRun'),
            onClick: () => store.dismissRun(run.startedAt ?? null),
          },
          '×',
        ),
      )
    }

    /**
     * Client plugin body: dictionaries, the shared store, the tab and its toast.
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-batch-updater: dictionaries')
      const t = ctx.locale.bind(NS)
      const store = createStore()

      let timer = null
      let stopped = false
      /**
       * Re-arm the poll after each settle, at the speed the answer implies, so
       * a running batch advances every second while an idle page stays quiet.
       */
      const schedule = async () => {
        if (stopped) return
        const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
        if (!hidden) await store.refresh()
        if (stopped) return
        timer = setTimeout(schedule, store.nextDelay())
      }
      ctx.effect(() => {
        void schedule()
        return () => {
          stopped = true
          if (timer !== null) clearTimeout(timer)
          timer = null
        }
      }, 'dsh-batch-updater: poll')

      ctx.slots.inject('plugins.tab', () =>
        ctx.slots.register(
          {
            name: 'plugins.tab',
            id: 'batch-updater',
            order: 10,
            label: () => t('tab'),
            locale: NS,
            inject: () => ({ t, store }),
          },
          UpdatesTab,
        ),
      )

      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          {
            name: 'shell.overlay',
            id: 'batch-updater.toast',
            locale: NS,
            inject: () => ({ t, store }),
          },
          ResultToast,
        ),
      )
    }

    return { inject, apply }
  },
})
