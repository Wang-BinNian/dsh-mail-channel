/**
 * Client-half 离线冒烟测试（不装进 Harness、不开浏览器）。
 *
 *   node test/client.test.mjs
 *
 * 用假 window / document / React / fetch 执行 client.js，验证：
 *   · 模块 id 与包名一致，factory 返回 inject + apply；
 *   · apply 把开关注册到 sidebar.footer.action，并注册中英文字典；
 *   · 初始态显示"读取中"，拿到宿主状态后显示"关闭"并可点击；
 *   · 点击开关向 /dsh-mail-channel/ui POST enabled 补丁；
 *   · 宿主不可达时按钮禁用并提示不可用。
 *
 * 这个假 React 只实现组件用到的 hook，并支持 setState 触发一次重渲染。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const code = readFileSync(join(here, '..', 'client.js'), 'utf8')

let failures = 0
function check(label, ok, detail = '') {
  if (ok) {
    console.log(`  [OK] ${label}`)
    return
  }
  failures += 1
  console.log(`  [!!] ${label} ${detail}`)
}

// ── 迷你 React：按组件函数持久化 hook 槽，setState 触发重渲染 ──
const renderer = {
  component: null,
  props: null,
  hooks: [],
  memo: [],
  cursor: 0,
  effects: [],
  tree: null,
  scheduled: 0,
  render() {
    if (this.component === null) return
    this.cursor = 0
    const tree = this.component(this.props)
    this.tree = tree
    for (const effect of this.effects) {
      if (effect === undefined || !effect.dirty) continue
      if (typeof effect.cleanup === 'function') effect.cleanup()
      effect.dirty = false
      effect.cleanup = effect.fn()
    }
    return tree
  },
  schedule() {
    if (this.scheduled > 0) return
    this.scheduled += 1
    queueMicrotask(() => {
      this.scheduled -= 1
      this.render()
    })
  },
  mount(component, props) {
    this.component = component
    this.props = props
    this.hooks = []
    this.effects = []
    this.memo = []
    return this.render()
  },
  reset() {
    for (const effect of this.effects) {
      if (effect !== undefined && typeof effect.cleanup === 'function') effect.cleanup()
    }
    this.component = null
    this.props = null
    this.hooks = []
    this.effects = []
    this.memo = []
    this.tree = null
  },
}

const React = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children }
  },
  useState(initial) {
    const index = renderer.cursor++
    if (renderer.hooks.length <= index) renderer.hooks[index] = typeof initial === 'function' ? initial() : initial
    return [
      renderer.hooks[index],
      (next) => {
        const value = typeof next === 'function' ? next(renderer.hooks[index]) : next
        if (Object.is(value, renderer.hooks[index])) return
        renderer.hooks[index] = value
        renderer.schedule()
      },
    ]
  },
  useEffect(fn, deps) {
    const index = renderer.cursor++
    const previous = renderer.effects[index]
    const changed = previous === undefined || deps === undefined || deps.some((dep, at) => dep !== previous.deps[at])
    if (previous === undefined) renderer.effects[index] = { fn, deps, dirty: changed, cleanup: undefined }
    else {
      previous.deps = deps
      previous.fn = fn
      if (changed) previous.dirty = true
    }
  },
  useRef(value) {
    const index = renderer.cursor++
    if (renderer.hooks.length <= index) renderer.hooks[index] = { current: value }
    return renderer.hooks[index]
  },
  useCallback(fn, deps) {
    const index = renderer.cursor++
    const previous = renderer.memo[index]
    if (
      previous !== undefined &&
      deps !== undefined &&
      deps.length === previous.deps.length &&
      deps.every((dep, at) => dep === previous.deps[at])
    ) {
      return previous.fn
    }
    renderer.memo[index] = { fn, deps }
    return fn
  },
}

// ── 假页面环境 ──
const requests = []
let fetchMode = 'ok'
async function fetchMock(url, init = {}) {
  requests.push({ url: String(url), method: init.method ?? 'GET', body: init.body })
  if (fetchMode === 'fail') throw new Error('offline')
  const patch = init.body === undefined ? {} : JSON.parse(init.body)
  return {
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      enabled: patch.enabled ?? false,
      sessionId: patch.sessionId ?? '',
      boundSessionId: '',
      channel: { alive: false, mode: 'native', lastCheck: '' },
      pending: 2,
    }),
  }
}

const loadCalls = []
const windowMock = {
  __ModuleLoader__: {
    load(definition) {
      loadCalls.push({ id: definition.id, exports: definition.factory(requireMock) })
    },
  },
}
function requireMock(name) {
  if (name === 'react') return React
  throw new Error(`client.js requested unknown module: ${name}`)
}

const context = {
  window: windowMock,
  document: { baseURI: 'http://127.0.0.1:63583/' },
  fetch: fetchMock,
  URL,
  console,
  setTimeout() {
    return 1
  },
  clearTimeout() {},
  setInterval() {
    return 1
  },
  clearInterval() {},
}
vm.createContext(context)
vm.runInContext(code, context)

const loaded = loadCalls[0]
check('只注册一个模块', loadCalls.length === 1 && loaded.id === 'dsh-mail-channel', JSON.stringify(loadCalls.map((c) => c.id)))
const module = loaded.exports
check(
  '导出 inject 含 slots/locale',
  Array.isArray(module.inject) && module.inject.includes('slots') && module.inject.includes('locale'),
  JSON.stringify(module.inject),
)

const registrations = []
const localeRegistrations = []
module.apply({
  effect(fn) {
    return fn()
  },
  locale: {
    register(ns, dicts) {
      localeRegistrations.push({ ns, dicts })
      return () => {}
    },
  },
  slots: {
    inject(key, callback) {
      callback()
    },
    register(options, Component) {
      registrations.push({ options, Component })
      return () => {}
    },
  },
})

const footer = registrations.find((row) => row.options.name === 'sidebar.footer.action')
check('注册了侧栏开关', footer !== undefined && footer.options.id === 'mail-toggle', JSON.stringify(registrations.map((r) => r.options)))
check('开关使用 mailChannel 词条', footer?.options.locale === 'mailChannel')
const dict = localeRegistrations.find((row) => row.ns === 'mailChannel')
check(
  '注册了中英文字典',
  dict !== undefined && Object.keys(dict.dicts.zh).length === Object.keys(dict.dicts.en).length,
  JSON.stringify(dict?.dicts ? Object.keys(dict.dicts) : null),
)

/** Collect element nodes of one type from a rendered tree. */
function findAll(node, predicate, found = []) {
  if (node === null || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, found)
    return found
  }
  if (predicate(node)) found.push(node)
  for (const child of node.children) findAll(child, predicate, found)
  return found
}

const props = {
  wide: true,
  useSessions: (selector) => selector({ byId: {} }),
  usePanelInfo: (selector) => selector({ activePanelId: null }),
  t: (key) => key,
}
const initialTree = renderer.mount(footer.Component, props)
let button = findAll(initialTree, (node) => node.type === 'button')[0]
check('初始态渲染出按钮', button !== undefined)
check('初始态显示读取中', String(button?.props.title).includes('titleLoading'), String(button?.props.title))
check('初始态按钮可用', button?.props.disabled === false)

await new Promise((resolve) => setImmediate(resolve))
button = findAll(renderer.tree, (node) => node.type === 'button')[0]
check('拿到状态后显示关闭', String(button?.props.title).includes('titleOff'), String(button?.props.title))
check('关闭态 aria-pressed=false', button?.props['aria-pressed'] === false)

requests.length = 0
button.props.onClick()
await new Promise((resolve) => setImmediate(resolve))
const post = requests.find((request) => request.method === 'POST')
check('点击后向宿主发 POST', post !== undefined && post.url.endsWith('/dsh-mail-channel/ui'), JSON.stringify(requests))
check('POST 打开开关', post !== undefined && JSON.parse(post.body).enabled === true, post?.body)

renderer.reset()
fetchMode = 'fail'
const failingTree = renderer.mount(footer.Component, props)
await new Promise((resolve) => setImmediate(resolve))
const failingButton = findAll(renderer.tree, (node) => node.type === 'button')[0]
check('宿主不可达时按钮禁用', failingButton?.props.disabled === true)
check('宿主不可达时提示错误', String(failingButton?.props.title).includes('titleError'), String(failingButton?.props.title))
check('收起态不渲染文字标签', findAll(renderer.mount(footer.Component, { ...props, wide: false }), (node) => node.type === 'span').length <= 1)

console.log(failures === 0 ? '\n客户端冒烟全部通过 ✅' : `\n失败 ${failures} 项 ❌`)
process.exitCode = failures === 0 ? 0 : 1
