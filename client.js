/**
 * Browser half of the mail-channel bundle.
 *
 * Registers one sidebar-footer action: the mail toggle. The button shows whether
 * automatic mail wake-up is on, whether the receiving long connection is alive,
 * and how many mails are waiting. Clicking it toggles the mode; while the mode
 * is on, the button follows the conversation the main view currently shows, so
 * switching conversations moves the mail binding with the focus.
 *
 * All state lives in the Host half; this module only renders and forwards the
 * current conversation id through the plugin's own loopback JSON route.
 */
window.__ModuleLoader__.load({
  id: 'dsh-mail-channel',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Locale namespace owned by this bundle. */
    const NS = 'mailChannel';
    /** Route served by the Host half of this same bundle. */
    const UI_PATH = 'dsh-mail-channel/ui';

    /** Simplified Chinese dictionary (key-set source of truth). */
    const zh = {
      labelOn: '邮件 · 开',
      labelOff: '邮件 · 关',
      titleLoading: '邮件通道：读取状态…',
      titleError: '邮件通道不可用（插件未加载或已停用）',
      titleOff: '邮件自动收信已关闭：来信只落待办，不唤醒对话（待处理 {count} 封）',
      titleAlive: '邮件自动收信已开启，收信正常；切换对话会自动跟随（待处理 {count} 封）',
      titleDead: '邮件自动收信已开启，但收信连接已断开（插件会自动重连；待处理 {count} 封）',
      titleWaiting: '邮件自动收信已开启，等待对话焦点（待处理 {count} 封）',
    };

    /** English dictionary, checked complete against the zh key set. */
    const en = {
      labelOn: 'Mail · on',
      labelOff: 'Mail · off',
      titleLoading: 'Mail channel: reading state…',
      titleError: 'Mail channel unavailable (plugin not loaded or disabled)',
      titleOff: 'Automatic mail wake-up is off: mail is archived without waking a conversation ({count} pending)',
      titleAlive: 'Automatic mail wake-up is on and receiving; switching conversations follows focus ({count} pending)',
      titleDead: 'Automatic mail wake-up is on, but the receiving connection dropped (it reconnects automatically; {count} pending)',
      titleWaiting: 'Automatic mail wake-up is on, waiting for a conversation to focus ({count} pending)',
    };

    /**
     * Component-local styles: rendered by the toggle and removed with it. The
     * row geometry mirrors the host's own sidebar-footer action beside Settings.
     */
    const css = `
      /* 侧栏 footer 的动作行里可能已有别的插件动作（Cordis 面板）占满整行：
         允许换行，让每个 100% 宽的动作各占一行，而不是第二个被侧栏裁掉。 */
      :has(> [data-slot="sidebar.footer.action"]) { flex-wrap: wrap; }
      .dshmc-layer { box-sizing: border-box; flex: none; display: flex; align-items: center; width: 100%; height: 42px; margin: 8px 0 0; }
      .dshmc-button { box-sizing: border-box; display: inline-flex; align-items: center; width: 100%; height: 42px; gap: 8px; margin: 0 -2px; padding: 0 10px 0 8px; overflow: hidden; border: none; border-radius: 12px; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 14px; line-height: 22px; cursor: pointer; transition: background-color 0.12s, color 0.12s; }
      .dshmc-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
      .dshmc-button:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
      .dshmc-button:disabled { cursor: default; opacity: 0.55; }
      .dshmc-button[data-enabled="true"] { color: var(--dsw-alias-brand-primary); }
      .dshmc-icon { flex: none; display: block; }
      .dshmc-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }
      .dshmc-count { flex: none; margin-left: auto; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 16px; font-variant-numeric: tabular-nums; }
      .dshmc-dot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary); }
      .dshmc-button[data-state="alive"] .dshmc-dot { background: var(--dsw-alias-state-success-primary); }
      .dshmc-button[data-state="dead"] .dshmc-dot { background: var(--dsw-alias-state-warn-primary); }
      .dshmc-layer.dshmc-rail { width: 36px; height: 36px; margin: 0; }
      .dshmc-layer.dshmc-rail .dshmc-button { width: 36px; height: 36px; justify-content: center; gap: 0; margin: 0; padding: 0; border-radius: 50%; }
    `;

    /** Resolve the Host route against the page origin. */
    function uiUrl() {
      try {
        return new URL(UI_PATH, document.baseURI).href;
      } catch {
        return `/${UI_PATH}`;
      }
    }

    /**
     * Read the Host-side switch state.
     * @returns the state payload ({ok, enabled, sessionId, channel, pending}).
     */
    async function fetchState() {
      const response = await fetch(uiUrl(), {
        headers: { accept: 'application/json' },
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    }

    /**
     * Forward a switch change or a focus change to the Host half.
     * @param patch - `{enabled?: boolean, sessionId?: string}`.
     * @returns the updated state payload.
     */
    async function postState(patch) {
      const response = await fetch(uiUrl(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    }

    /**
     * Decorative envelope glyph; the row owns its accessible label.
     * @param props - requested icon edge.
     * @returns the icon element.
     */
    function MailIcon({ size = 16 }) {
      return h(
        'svg',
        {
          className: 'dshmc-icon',
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          'aria-hidden': true,
          focusable: false,
        },
        h('rect', {
          x: 3.25,
          y: 5.25,
          width: 17.5,
          height: 13.5,
          rx: 2.75,
          stroke: 'currentColor',
          strokeWidth: 1.5,
        }),
        h('path', {
          d: 'M4.5 7.25 12 12.5l7.5-5.25',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      );
    }

    /**
     * Render the sidebar-footer mail toggle.
     * @param props - owner column state plus the slot's standard hooks and locale seat.
     * @returns the toggle element.
     */
    function MailToggle({ wide, useSessions, usePanelInfo, t }) {
      const [snap, setSnap] = React.useState(null);
      const [failed, setFailed] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const mounted = React.useRef(true);

      React.useEffect(
        () => () => {
          mounted.current = false;
        },
        [],
      );

      const applySnapshot = React.useCallback((next) => {
        if (!mounted.current) return;
        setSnap(next);
        setFailed(false);
      }, []);

      const refresh = React.useCallback(async () => {
        try {
          applySnapshot(await fetchState());
        } catch {
          if (mounted.current) setFailed(true);
        }
      }, [applySnapshot]);

      React.useEffect(() => {
        void refresh();
        const timer = setInterval(() => {
          void refresh();
        }, 5000);
        return () => clearInterval(timer);
      }, [refresh]);

      // The main column retains its current conversation; the same projection
      // the host uses for the document title tells us which one is focused.
      const activeId = useSessions((state) => {
        const rows = state && state.byId ? Object.values(state.byId) : [];
        const row = rows.find((item) => ((item.retainedBy && item.retainedBy.mainView) || 0) > 0);
        return row && typeof row.id === 'string' ? row.id : '';
      });
      const panelActive = usePanelInfo(
        (info) => info.activePanelId !== null && info.activePanelId !== undefined,
      );

      const enabled = snap !== null && snap.enabled === true;
      const boundId = snap !== null && typeof snap.sessionId === 'string' ? snap.sessionId : '';

      // Focus follow: while the mode is on, push the conversation the main view
      // shows. A global panel (Plugins, Tasks, …) keeps the previous binding.
      React.useEffect(() => {
        if (!enabled || panelActive || activeId === '' || activeId === boundId) return undefined;
        const timer = setTimeout(() => {
          postState({ sessionId: activeId })
            .then(applySnapshot)
            .catch(() => {
              if (mounted.current) setFailed(true);
            });
        }, 400);
        return () => clearTimeout(timer);
      }, [enabled, panelActive, activeId, boundId, applySnapshot]);

      const onToggle = () => {
        if (busy || failed) return;
        setBusy(true);
        const next = !enabled;
        const patch = next
          ? { enabled: true, sessionId: activeId || boundId || undefined }
          : { enabled: false };
        postState(patch)
          .then(applySnapshot)
          .catch(() => {
            if (mounted.current) setFailed(true);
          })
          .finally(() => {
            if (mounted.current) setBusy(false);
          });
      };

      const alive = !!(snap && snap.channel && snap.channel.alive === true);
      const pending = snap && Number.isFinite(snap.pending) ? snap.pending : 0;
      const state = failed
        ? 'error'
        : snap === null
          ? 'loading'
          : !enabled
            ? 'off'
            : boundId === ''
              ? 'waiting'
              : alive
                ? 'alive'
                : 'dead';

      const title =
        state === 'error'
          ? t('titleError')
          : state === 'loading'
            ? t('titleLoading')
            : state === 'off'
              ? t('titleOff', { count: pending })
              : state === 'waiting'
                ? t('titleWaiting', { count: pending })
                : state === 'alive'
                  ? t('titleAlive', { count: pending })
                  : t('titleDead', { count: pending });
      const label = wide ? (enabled ? t('labelOn') : t('labelOff')) : '';

      return h(
        'div',
        { className: wide ? 'dshmc-layer' : 'dshmc-layer dshmc-rail' },
        h('style', { key: 'dshmc-styles' }, css),
        h(
          'button',
          {
            type: 'button',
            className: 'dshmc-button',
            onClick: onToggle,
            disabled: failed,
            'aria-pressed': enabled,
            'aria-label': title,
            title,
            'data-enabled': enabled ? 'true' : 'false',
            'data-state': state,
            'data-busy': busy ? 'true' : undefined,
          },
          h(MailIcon, { size: wide ? 16 : 18 }),
          wide ? h('span', { className: 'dshmc-label' }, label) : null,
          wide && pending > 0 ? h('span', { className: 'dshmc-count' }, String(pending)) : null,
          wide ? h('span', { className: 'dshmc-dot' }) : null,
        ),
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'mail-channel: UI dictionaries');
        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register(
            {
              name: 'sidebar.footer.action',
              id: 'mail-toggle',
              order: 20,
              locale: NS,
            },
            MailToggle,
          ),
        );
      },
    };
  },
});
