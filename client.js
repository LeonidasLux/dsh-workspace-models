/**
 * Client half of the workspace-models bundle.
 *
 * Registers three contributions into the Harness Web GUI:
 *  - one keyed `main` panel (id `workspace-models`) summarizing every
 *    workspace, its configured model, and its per-model token usage;
 *  - the matching `sidebar.panellist` entry, so the sidebar owns the button;
 *  - one `workspace` context-menu action, so each workspace's "more" menu
 *    gains a model-configuration row.
 *
 * Data comes from the Host half's fenced routes (`/workspace-models/...`).
 * Styling uses only `--dsw-alias-*` theme tokens.
 */
window.__ModuleLoader__.load({
  id: 'dsh-workspace-models',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const PANEL_ID = 'workspace-models'
    const ROUTE = '/workspace-models'
    const NS = 'workspaceModels'

    const DICTIONARIES = {
      en: {
        panelTitle: 'Workspace models',
        panelSubtitle: 'The model each workspace runs on, and what its sessions spent in tokens.',
        menuConfigure: 'Model configuration…',
        refresh: 'Refresh',
        loading: 'Reading workspaces and token usage…',
        loadFailed: 'Could not read workspace data: {message}',
        retry: 'Retry',
        defaultModel: 'Deployment default',
        followDefault: 'Follows the default',
        configured: 'Pinned',
        totalTokens: 'Total tokens',
        totalInput: 'Input',
        totalOutput: 'Output',
        totalSessions: 'Sessions',
        totalWorkspaces: 'Workspaces',
        empty: 'No workspace is registered yet.',
        sessions: '{count} sessions',
        live: 'live',
        noUsage: 'No token usage recorded yet.',
        colModel: 'Model',
        colRequests: 'Requests',
        colInput: 'Input',
        colOutput: 'Output',
        colTotal: 'Total',
        configure: 'Configure',
        cancel: 'Cancel',
        save: 'Save',
        saving: 'Saving…',
        useDefault: 'Follow deployment default',
        modelLabel: 'Model',
        effortLabel: 'Reasoning effort',
        effortAuto: 'Automatic',
        saved: 'Saved.',
        saveFailed: 'Could not save: {message}',
        appliedLive: 'Retargeted {count} live session(s).',
        unavailable: 'Not in the current catalog',
        customEntry: 'Other vendor / custom…',
        providerId: 'Provider id',
        modelId: 'Model id',
        providerHint: 'Add other vendors in Settings → Models first; the id here is the provider id that surface saved.',
        unlisted: 'Not in the catalog',
        unlistedWarning: 'This route is not in the current catalog yet; requests fail until that provider is configured.',
        customRequired: 'Enter both a provider id and a model id.',
        catalogEmpty: 'No routable model is listed. Add a provider in Settings → Models.',
        workspacesHeading: 'Workspaces',
        warnings: 'Some providers could not be listed: {list}',
      },
      zh: {
        panelTitle: '工作区模型',
        panelSubtitle: '每个工作区使用的模型，以及各工作区会话的 Token 用量。',
        menuConfigure: '模型配置…',
        refresh: '刷新',
        loading: '正在读取工作区与 Token 用量…',
        loadFailed: '读取工作区数据失败：{message}',
        retry: '重试',
        defaultModel: '默认模型',
        followDefault: '跟随默认',
        configured: '已配置',
        totalTokens: '总 Token',
        totalInput: '输入',
        totalOutput: '输出',
        totalSessions: '会话数',
        totalWorkspaces: '工作区',
        empty: '还没有登记任何工作区。',
        sessions: '{count} 个会话',
        live: '在线',
        noUsage: '还没有记录到 Token 用量。',
        colModel: '模型',
        colRequests: '请求',
        colInput: '输入',
        colOutput: '输出',
        colTotal: '合计',
        configure: '配置',
        cancel: '取消',
        save: '保存',
        saving: '保存中…',
        useDefault: '跟随默认模型',
        modelLabel: '模型',
        effortLabel: '推理强度',
        effortAuto: '自动',
        saved: '已保存。',
        saveFailed: '保存失败：{message}',
        appliedLive: '已同步到 {count} 个运行中的会话。',
        unavailable: '不在当前模型目录中',
        customEntry: '其他厂商 / 手动填写…',
        providerId: '服务商 id',
        modelId: '模型 id',
        providerHint: '先在 设置 → 模型 里添加其他厂商；这里的 id 就是该处保存的服务商 id。',
        unlisted: '目录中未列出',
        unlistedWarning: '该模型还不在当前目录中；在该服务商配置好之前，请求会失败。',
        customRequired: '请同时填写服务商 id 与模型 id。',
        catalogEmpty: '当前没有可路由的模型。请在 设置 → 模型 里添加服务商。',
        workspacesHeading: '工作区',
        warnings: '部分模型提供方无法列出：{list}',
      },
    }

    const SUPPORTED = Object.keys(DICTIONARIES)

    /** Set by `apply`, so a component never depends on inject being honoured. */
    let currentReader = null

    /** English-only reader used before (or instead of) the real locale service. */
    const fallbackReader = {
      useLocaleId: () => 'en',
      t: (key, params) => format(DICTIONARIES.en[key] ?? key, params),
      tFor: () => (key, params) => format(DICTIONARIES.en[key] ?? key, params),
    }

    /**
     * Interpolate `{name}` placeholders.
     * @param {string} template text.
     * @param {Record<string, unknown>} params values.
     * @returns {string} rendered text.
     */
    function format(template, params) {
      if (template === undefined) return ''
      if (params === undefined) return template
      return template.replace(/\{(\w+)\}/g, (match, key) => {
        const value = params[key]
        return value === undefined ? match : String(value)
      })
    }

    /**
     * Build a locale reader over the Client locale service.
     * @param {any} locale the `locale` service.
     * @returns {{ useLocaleId: () => string, t: (key: string, params?: any) => string, tFor: (id: string) => any }} reader.
     */
    function makeLocaleReader(locale) {
      if (locale === undefined || locale === null) return fallbackReader
      const subscribe = (listener) => locale.subscribe(listener)
      const getSnapshot = () => locale.getSnapshot()
      /**
       * The active locale id. `LocaleSnapshot` carries it as `active`; the
       * other fields are accepted so a renamed snapshot field degrades to the
       * English baseline instead of crashing.
       * @returns {string} one of SUPPORTED.
       */
      const readId = () => {
        const snapshot = getSnapshot()
        let id
        if (typeof snapshot === 'string') id = snapshot
        else if (snapshot !== null && typeof snapshot === 'object') {
          id = snapshot.active ?? snapshot.locale ?? snapshot.id
        }
        if (typeof id !== 'string' || id.length === 0) return 'en'
        if (SUPPORTED.includes(id)) return id
        const primary = id.split('-')[0].toLowerCase()
        return SUPPORTED.includes(primary) ? primary : 'en'
      }
      const tFor = (id) => (key, params) => {
        const table = DICTIONARIES[id] ?? DICTIONARIES.en
        return format(table[key] ?? DICTIONARIES.en[key] ?? key, params)
      }
      const useLocaleId = () => React.useSyncExternalStore(subscribe, readId, () => 'en')
      return {
        useLocaleId,
        tFor,
        t: (key, params) => tFor(readId())(key, params),
      }
    }

    /**
     * Compact token count.
     * @param {number} value count.
     * @returns {string} display text.
     */
    function tokens(value) {
      const count = Number.isFinite(value) ? value : 0
      if (count < 1000) return String(count)
      if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}K`
      return `${(count / 1_000_000).toFixed(2)}M`
    }

    /** Cross-component "open this workspace in the panel" channel. */
    const pending = { workspaceId: null, version: 0, listeners: new Set() }

    function setPendingWorkspace(workspaceId) {
      pending.workspaceId = workspaceId
      pending.version += 1
      for (const listener of [...pending.listeners]) listener()
    }

    function subscribePending(listener) {
      pending.listeners.add(listener)
      return () => pending.listeners.delete(listener)
    }

    function usePendingVersion() {
      return React.useSyncExternalStore(subscribePending, () => pending.version, () => 0)
    }

    /* ---------------------------------------------------------------- styles */

    const STYLES = `
.wsm-page { box-sizing: border-box; height: 100%; overflow: auto; padding: 28px 32px 48px; color: var(--dsw-alias-label-primary); }
.wsm-inner { max-width: 1040px; margin: 0 auto; display: flex; flex-direction: column; gap: 20px; }
.wsm-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.wsm-title { margin: 0; font-size: 20px; line-height: 28px; font-weight: 600; }
.wsm-subtitle { margin: 4px 0 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); }
.wsm-headActions { display: flex; align-items: center; gap: 8px; flex: none; }
.wsm-chip { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px; border-radius: 999px; font-size: 12px; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.wsm-chip strong { color: var(--dsw-alias-label-primary); font-weight: 600; }
.wsm-btn { height: 28px; padding: 0 12px; border-radius: 8px; font-size: 12px; cursor: pointer; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l2); }
.wsm-btn:hover { background: var(--dsw-alias-bg-layer-1); }
.wsm-btn:disabled { opacity: .55; cursor: default; }
.wsm-btn.primary { background: var(--dsw-alias-brand-primary); border-color: transparent; color: #fff; }
.wsm-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
.wsm-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; padding: 14px 16px; background: var(--dsw-alias-bg-layer-1); display: flex; flex-direction: column; gap: 4px; }
.wsm-cardLabel { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.wsm-cardValue { font-size: 22px; line-height: 30px; font-weight: 600; }
.wsm-cardHint { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.wsm-sectionHead { display: flex; align-items: baseline; justify-content: space-between; margin-top: 4px; }
.wsm-sectionTitle { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary); letter-spacing: .04em; }
.wsm-list { display: flex; flex-direction: column; gap: 10px; }
.wsm-row { border: 1px solid var(--dsw-alias-border-l1); border-radius: 14px; background: var(--dsw-alias-bg-layer-1); padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
.wsm-row.focused { border-color: var(--dsw-alias-brand-primary); }
.wsm-rowHead { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.wsm-name { font-size: 14px; font-weight: 600; }
.wsm-path { font-size: 12px; color: var(--dsw-alias-label-secondary); margin-top: 2px; word-break: break-all; }
.wsm-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.wsm-tag { display: inline-flex; align-items: center; height: 22px; padding: 0 9px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); font-size: 12px; }
.wsm-tag.model { color: var(--dsw-alias-label-primary); }
.wsm-tag.pinned { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.wsm-tag.live { border-color: var(--dsw-alias-state-success-primary); color: var(--dsw-alias-state-success-primary); }
.wsm-tag.warn { border-color: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-state-warn-primary); }
.wsm-usage { display: flex; flex-wrap: wrap; gap: 18px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.wsm-usage strong { color: var(--dsw-alias-label-primary); font-weight: 600; font-size: 13px; }
.wsm-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.wsm-table th { text-align: right; font-weight: 500; color: var(--dsw-alias-label-secondary); padding: 4px 6px; border-bottom: 1px solid var(--dsw-alias-border-l1); white-space: nowrap; }
.wsm-table th:first-child, .wsm-table td:first-child { text-align: left; }
.wsm-table td { text-align: right; padding: 4px 6px; border-bottom: 1px solid var(--dsw-alias-border-l1); font-variant-numeric: tabular-nums; }
.wsm-table tr:last-child td { border-bottom: none; }
.wsm-muted { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.wsm-editor { border-top: 1px dashed var(--dsw-alias-border-l2); padding-top: 12px; display: flex; flex-direction: column; gap: 10px; }
.wsm-field { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.wsm-field label { font-size: 12px; color: var(--dsw-alias-label-secondary); min-width: 68px; }
.wsm-select { height: 30px; min-width: 220px; max-width: 100%; border-radius: 8px; padding: 0 8px; font-size: 13px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l2); }
.wsm-editorActions { display: flex; align-items: center; gap: 8px; }
.wsm-notice { font-size: 12px; }
.wsm-notice.ok { color: var(--dsw-alias-state-success-primary); }
.wsm-notice.error { color: var(--dsw-alias-state-error-primary); }
.wsm-notice.warn { color: var(--dsw-alias-state-warn-primary); }
.wsm-empty { padding: 40px 16px; text-align: center; color: var(--dsw-alias-label-secondary); font-size: 13px; }
`

    /**
     * Display name of one provider/model route.
     * @param {any} entry selection or usage row.
     * @param {any} overview panel payload.
     * @returns {string} display name.
     */
    function modelLabel(entry, overview) {
      const groups = overview === null || overview === undefined ? [] : overview.catalog?.groups ?? []
      const group = groups.find((candidate) => candidate.id === entry.provider)
      const model = (group?.models ?? []).find((candidate) => candidate.id === entry.model)
      if (model !== undefined) return model.name ?? model.id
      return `${entry.provider}/${entry.model}`
    }

    /**
     * The panel: one card per workspace with its model, usage, and editor.
     * @param {{ reader?: any }} props injected props.
     */
    function WorkspaceModelsPage(props) {
      const reader = props !== null && props !== undefined && props.reader !== undefined
        ? props.reader
        : (currentReader ?? fallbackReader)
      const localeId = reader.useLocaleId()
      const t = reader.tFor(localeId)
      const pendingTick = usePendingVersion()
      const [overview, setOverview] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [loading, setLoading] = React.useState(true)
      const [editingId, setEditingId] = React.useState(null)
      const [focusedId, setFocusedId] = React.useState(null)
      const alive = React.useRef(true)

      React.useEffect(() => {
        alive.current = true
        return () => { alive.current = false }
      }, [])

      const load = React.useCallback(async (refresh) => {
        setLoading(true)
        try {
          const response = await fetch(`${ROUTE}/overview${refresh ? '?refresh=1' : ''}`, { cache: 'no-store' })
          const body = await response.json().catch(() => null)
          if (!response.ok || body === null || body.ok !== true) {
            throw new Error(body && body.error ? String(body.error) : `HTTP ${response.status}`)
          }
          if (!alive.current) return
          setOverview(body.overview)
          setError(null)
        } catch (failure) {
          if (!alive.current) return
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          if (alive.current) setLoading(false)
        }
      }, [])

      React.useEffect(() => {
        void load(false)
      }, [load])

      /* a context-menu action asked the panel to configure one workspace */
      React.useEffect(() => {
        const target = pending.workspaceId
        if (target === null) return
        pending.workspaceId = null
        setFocusedId(target)
        setEditingId(target)
      }, [pendingTick])

      const rows = overview === null ? [] : overview.workspaces ?? []
      const totals = overview === null ? null : overview.totals
      const defaultSelection = overview === null ? null : overview.defaultSelection
      const warnings = overview === null || !Array.isArray(overview.warnings) ? [] : overview.warnings

      return h('div', { className: 'wsm-page' },
        h('style', { dangerouslySetInnerHTML: { __html: STYLES } }),
        h('div', { className: 'wsm-inner' },
          h('header', { className: 'wsm-head' },
            h('div', null,
              h('h1', { className: 'wsm-title' }, t('panelTitle')),
              h('p', { className: 'wsm-subtitle' }, t('panelSubtitle')),
            ),
            h('div', { className: 'wsm-headActions' },
              defaultSelection === null
                ? null
                : h('span', { className: 'wsm-chip' },
                    t('defaultModel'),
                    h('strong', null, modelLabel(defaultSelection, overview))),
              h('button', {
                type: 'button',
                className: 'wsm-btn',
                disabled: loading,
                onClick: () => { void load(true) },
              }, t('refresh')),
            ),
          ),

          error !== null
            ? h('div', { className: 'wsm-row' },
                h('div', { className: 'wsm-notice error' }, t('loadFailed', { message: error })),
                h('div', { className: 'wsm-editorActions' },
                  h('button', { type: 'button', className: 'wsm-btn', onClick: () => { void load(true) } }, t('retry')),
                ),
              )
            : null,

          loading && overview === null
            ? h('div', { className: 'wsm-empty' }, t('loading'))
            : null,

          totals !== null
            ? h('section', { className: 'wsm-cards' },
                h('div', { className: 'wsm-card' },
                  h('span', { className: 'wsm-cardLabel' }, t('totalTokens')),
                  h('span', { className: 'wsm-cardValue' }, tokens(totals.total)),
                  h('span', { className: 'wsm-cardHint' }, `${t('totalInput')} ${tokens(totals.input)} · ${t('totalOutput')} ${tokens(totals.output)}`),
                ),
                h('div', { className: 'wsm-card' },
                  h('span', { className: 'wsm-cardLabel' }, t('totalSessions')),
                  h('span', { className: 'wsm-cardValue' }, String(rows.reduce((sum, row) => sum + row.sessionCount, 0))),
                  h('span', { className: 'wsm-cardHint' }, `${t('colRequests')} ${totals.requests}`),
                ),
                h('div', { className: 'wsm-card' },
                  h('span', { className: 'wsm-cardLabel' }, t('totalWorkspaces')),
                  h('span', { className: 'wsm-cardValue' }, String(rows.length)),
                  h('span', { className: 'wsm-cardHint' }, `${rows.filter((row) => row.configured !== null).length} ${t('configured')}`),
                ),
              )
            : null,

          warnings.length > 0
            ? h('div', { className: 'wsm-notice warn' },
                t('warnings', { list: warnings.map((warning) => `${warning.provider}: ${warning.message}`).join('; ') }))
            : null,

          h('div', { className: 'wsm-sectionHead' },
            h('span', { className: 'wsm-sectionTitle' }, t('workspacesHeading')),
          ),

          rows.length === 0 && loading === false
            ? h('div', { className: 'wsm-empty' }, t('empty'))
            : h('div', { className: 'wsm-list' },
                rows.map((row) => h(WorkspaceCard, {
                  key: row.id,
                  row,
                  overview,
                  t,
                  focused: focusedId === row.id,
                  editing: editingId === row.id,
                  onToggleEdit: () => setEditingId(editingId === row.id ? null : row.id),
                  onSaved: () => {
                    setEditingId(null)
                    setFocusedId(row.id)
                    void load(true)
                  },
                  onFocus: () => setFocusedId(row.id),
                })),
              ),
        ),
      )
    }

    /**
     * One workspace card.
     * @param {any} props card props.
     */
    function WorkspaceCard(props) {
      const { row, overview, t, focused, editing, onToggleEdit, onSaved, onFocus } = props
      const configured = row.configured
      const effective = row.effective
      return h('article', { className: `wsm-row${focused ? ' focused' : ''}` },
        h('div', { className: 'wsm-rowHead' },
          h('div', null,
            h('div', { className: 'wsm-name' }, row.title),
            h('div', { className: 'wsm-path' }, row.path),
          ),
          h('div', { className: 'wsm-editorActions' },
            h('button', {
              type: 'button',
              className: 'wsm-btn',
              onClick: () => { onFocus(); onToggleEdit() },
            }, editing ? t('cancel') : t('configure')),
          ),
        ),
        h('div', { className: 'wsm-meta' },
          h('span', { className: `wsm-tag model${configured === null ? '' : ' pinned'}` },
            effective === null ? t('noUsage') : modelLabel(effective, overview)),
          h('span', { className: 'wsm-tag' }, configured === null ? t('followDefault') : t('configured')),
          row.effectiveListed === false ? h('span', { className: 'wsm-tag warn' }, t('unlisted')) : null,
          h('span', null, t('sessions', { count: row.sessionCount })),
          row.live ? h('span', { className: 'wsm-tag live' }, t('live')) : null,
        ),
        h('div', { className: 'wsm-usage' },
          h('span', null, t('totalTokens'), ' ', h('strong', null, tokens(row.usage.total))),
          h('span', null, t('colInput'), ' ', h('strong', null, tokens(row.usage.input))),
          h('span', null, t('colOutput'), ' ', h('strong', null, tokens(row.usage.output))),
          h('span', null, t('colRequests'), ' ', h('strong', null, String(row.usage.requests))),
        ),
        row.models.length === 0
          ? h('div', { className: 'wsm-muted' }, t('noUsage'))
          : h('table', { className: 'wsm-table' },
              h('thead', null,
                h('tr', null,
                  h('th', null, t('colModel')),
                  h('th', null, t('colRequests')),
                  h('th', null, t('colInput')),
                  h('th', null, t('colOutput')),
                  h('th', null, t('colTotal')),
                ),
              ),
              h('tbody', null,
                row.models.map((model) => h('tr', { key: `${model.provider}/${model.model}` },
                  h('td', null, modelLabel(model, overview)),
                  h('td', null, String(model.requests)),
                  h('td', null, tokens(model.input)),
                  h('td', null, tokens(model.output)),
                  h('td', null, tokens(model.total)),
                )),
              ),
            ),
        editing
          ? h(ModelEditor, { row, overview, t, onSaved })
          : null,
      )
    }

    /** Sentinel select value that switches the editor to free-form entry. */
    const CUSTOM = '__custom__'

    /** Route key shared by the picker values and the catalog membership check. */
    function routeKey(selection) {
      return `${selection.provider}::${selection.model}`
    }

    /**
     * Inline model editor for one workspace.
     *
     * The picker lists every provider the Host can currently route to, from any
     * vendor, grouped by provider. A vendor that is not (yet) in that catalog can
     * still be pinned by typing its provider and model ids.
     * @param {any} props editor props.
     */
    function ModelEditor(props) {
      const { row, overview, t, onSaved } = props
      const groups = overview?.catalog?.groups ?? []
      const configured = row.configured
      const fallback = overview?.defaultSelection ?? null
      const initial = configured ?? fallback

      const options = React.useMemo(() => {
        const list = []
        for (const group of groups) {
          for (const model of group.models ?? []) {
            list.push({ value: `${group.id}::${model.id}`, provider: group.id, model })
          }
        }
        return list
      }, [groups])

      const initialKey = initial === null ? '' : routeKey(initial)
      const initialListed = initialKey !== '' && options.some((option) => option.value === initialKey)
      const [mode, setMode] = React.useState(initial !== null && !initialListed ? 'custom' : 'catalog')
      const [routeValue, setRouteValue] = React.useState(
        initialListed
          ? initialKey
          : (initial === null && options.length > 0 ? options[0].value : ''),
      )
      const [customProvider, setCustomProvider] = React.useState(initial === null ? '' : initial.provider)
      const [customModel, setCustomModel] = React.useState(initial === null ? '' : initial.model)
      const [effort, setEffort] = React.useState(initial?.reasoningEffort ?? '')
      const [followDefault, setFollowDefault] = React.useState(configured === null)
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState(null)

      const selected = options.find((option) => option.value === routeValue)
      const efforts = selected?.model?.reasoning?.efforts ?? []
      const custom = mode === 'custom'
      const providerId = customProvider.trim()
      const modelId = customModel.trim()
      /* the route the form would save, and whether the catalog knows it */
      const draft = followDefault
        ? null
        : custom
          ? (providerId === '' || modelId === '' ? null : { provider: providerId, model: modelId })
          : (selected === undefined ? null : { provider: selected.provider, model: selected.model.id })
      const draftListed = draft === null ? null : options.some((option) => option.value === routeKey(draft))

      const submit = async () => {
        setBusy(true)
        setNotice(null)
        try {
          let model = null
          if (!followDefault) {
            if (draft === null) throw new Error(custom ? t('customRequired') : t('unavailable'))
            model = { ...draft }
            if (!custom && effort.length > 0) model.reasoningEffort = effort
          }
          const response = await fetch(`${ROUTE}/config`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ workspaceId: row.id, model }),
          })
          const body = await response.json().catch(() => null)
          if (!response.ok || body === null || body.ok !== true) {
            throw new Error(body && body.error ? String(body.error) : `HTTP ${response.status}`)
          }
          const applied = Number.isFinite(body.appliedToLiveSessions) ? body.appliedToLiveSessions : 0
          const prefix = applied > 0 ? `${t('saved')} ${t('appliedLive', { count: applied })}` : t('saved')
          setNotice(body.listed === false
            ? { tone: 'warn', text: `${prefix} ${t('unlistedWarning')}` }
            : { tone: 'ok', text: prefix })
          onSaved()
        } catch (failure) {
          setNotice({
            tone: 'error',
            text: t('saveFailed', { message: failure instanceof Error ? failure.message : String(failure) }),
          })
        } finally {
          setBusy(false)
        }
      }

      return h('div', { className: 'wsm-editor' },
        h('div', { className: 'wsm-field' },
          h('label', null, t('modelLabel')),
          h('select', {
            className: 'wsm-select',
            value: followDefault ? '' : (custom ? CUSTOM : routeValue),
            disabled: followDefault || busy,
            onChange: (event) => {
              const nextValue = event.target.value
              if (nextValue === CUSTOM) {
                setMode('custom')
                setEffort('')
                return
              }
              setMode('catalog')
              setRouteValue(nextValue)
              const next = options.find((option) => option.value === nextValue)
              const nextEfforts = next?.model?.reasoning?.efforts ?? []
              const nextDefault = next?.model?.reasoning?.defaultEffort ?? ''
              setEffort(nextEfforts.some((entry) => entry.id === nextDefault) ? nextDefault : '')
            },
          },
            followDefault ? h('option', { value: '' }, t('useDefault')) : null,
            groups.map((group) => h('optgroup', { key: group.id, label: group.name ?? group.id },
              (group.models ?? []).map((model) => h('option', {
                key: `${group.id}::${model.id}`,
                value: `${group.id}::${model.id}`,
              }, model.name ?? model.id)),
            )),
            h('option', { value: CUSTOM }, t('customEntry')),
          ),
        ),
        custom && !followDefault
          ? h('div', { className: 'wsm-field' },
              h('label', null, t('providerId')),
              h('input', {
                className: 'wsm-select',
                type: 'text',
                value: customProvider,
                placeholder: 'openai',
                spellCheck: false,
                disabled: busy,
                onChange: (event) => setCustomProvider(event.target.value),
              }),
              h('label', { style: { minWidth: 'auto' } }, t('modelId')),
              h('input', {
                className: 'wsm-select',
                type: 'text',
                value: customModel,
                placeholder: 'gpt-5',
                spellCheck: false,
                disabled: busy,
                onChange: (event) => setCustomModel(event.target.value),
              }),
            )
          : null,
        custom && !followDefault
          ? h('div', { className: 'wsm-muted' }, t('providerHint'))
          : null,
        h('div', { className: 'wsm-field' },
          h('label', null, t('effortLabel')),
          h('select', {
            className: 'wsm-select',
            value: effort,
            disabled: followDefault || busy || custom || efforts.length === 0,
            onChange: (event) => setEffort(event.target.value),
          },
            h('option', { value: '' }, t('effortAuto')),
            efforts.map((entry) => h('option', { key: entry.id, value: entry.id }, entry.name ?? entry.id)),
          ),
        ),
        h('div', { className: 'wsm-field' },
          h('label', { style: { cursor: 'pointer' } },
            h('input', {
              type: 'checkbox',
              checked: followDefault,
              disabled: busy,
              onChange: (event) => {
                const next = event.target.checked
                setFollowDefault(next)
                if (!next && !custom && routeValue === '') {
                  const first = options[0]
                  if (first !== undefined) setRouteValue(first.value)
                }
              },
            }),
            ' ',
            t('useDefault'),
          ),
        ),
        draft !== null && draftListed === false
          ? h('div', { className: 'wsm-notice warn' }, t('unlistedWarning'))
          : null,
        groups.length === 0
          ? h('div', { className: 'wsm-muted' }, t('catalogEmpty'))
          : null,
        h('div', { className: 'wsm-editorActions' },
          h('button', {
            type: 'button',
            className: 'wsm-btn primary',
            disabled: busy || (!followDefault && draft === null),
            onClick: () => { void submit() },
          }, busy ? t('saving') : t('save')),
        ),
        notice === null ? null : h('div', { className: `wsm-notice ${notice.tone}` }, notice.text),
      )
    }

    /** The sidebar rail icon; `size` and `active` come from the sidebar owner. */
    function SidebarIcon(props) {
      const size = Number.isFinite(props?.size) ? props.size : 16
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        'aria-hidden': true,
      },
        h('rect', { x: 3, y: 4, width: 8, height: 7, rx: 2, stroke: 'currentColor', strokeWidth: 1.6 }),
        h('rect', { x: 13, y: 4, width: 8, height: 7, rx: 2, stroke: 'currentColor', strokeWidth: 1.6 }),
        h('rect', { x: 3, y: 13, width: 8, height: 7, rx: 2, stroke: 'currentColor', strokeWidth: 1.6 }),
        h('path', { d: 'M14 16.5h6M17 13.5v6', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
      )
    }

    const inject = ['slots', 'locale']

    /**
     * Client entry.
     * @param {any} ctx Client plugin context.
     */
    function apply(ctx) {
      const reader = makeLocaleReader(ctx.locale)
      currentReader = reader
      ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), 'workspace-models: locale')

      /** Open the panel, optionally focusing one workspace. */
      const openPanel = (workspaceId) => {
        if (typeof workspaceId === 'string' && workspaceId.length > 0) setPendingWorkspace(workspaceId)
        const layout = ctx.get('layout')
        if (layout !== undefined && typeof layout.selectPanel === 'function') layout.selectPanel(PANEL_ID)
      }

      const slots = ctx.slots
      if (slots !== undefined) {
        ctx.effect(() => slots.inject('main', () => slots.register({
          name: 'main',
          key: PANEL_ID,
          inject: () => ({ reader }),
        }, WorkspaceModelsPage)), 'workspace-models: main panel')

        ctx.effect(() => slots.inject('sidebar.panellist', () => slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 30,
          label: () => reader.t('panelTitle'),
          inject: () => ({ reader }),
        }, SidebarIcon)), 'workspace-models: sidebar entry')
      }

      /* each workspace's "..." / right-click menu gains one configuration row */
      ctx.effect(() => {
        const dispose = ctx.inject(['contextMenus'], (scoped) => {
          if (scoped.contextMenus === undefined) return () => {}
          return scoped.contextMenus.register({
            id: 'workspace-models.configure',
            target: 'workspace',
            order: 250,
            resolve: (value) => {
              const workspaceId = value !== null && typeof value === 'object'
                ? (value.workspaceId ?? value.id)
                : undefined
              if (typeof workspaceId !== 'string' || workspaceId.length === 0) return []
              return [{
                id: 'configure',
                label: reader.t('menuConfigure'),
                run: () => openPanel(workspaceId),
              }]
            },
          })
        })
        return () => {
          if (typeof dispose === 'function') dispose()
        }
      }, 'workspace-models: workspace menu')
    }

    return { inject, apply, name: 'workspace-models-client' }
  },
})
