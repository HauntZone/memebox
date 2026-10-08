/**
 * 页面脚本自检：把每个页面 .vue 里的 <script> 抽出来**真跑一遍**，用假上下文把每个生命周期
 * 钩子、每个方法、每个计算属性都调一次，专门抓「引用了不存在的东西」这类错。
 *
 * 为什么需要它（这个坑连踩两次）：
 *   1. 把一个纯函数从平台层挪到纯逻辑层，**忘了改 adapter 的 import** —— 模块解析错误；
 *   2. 删掉一个没人用的模块级变量，**漏改了 onUnload 里对它的赋值** —— 运行时的 ReferenceError。
 * 这两种 `node --check` 都抓不到（它只查语法），页面又只在退出/交互时才触发，所以只能靠真跑。
 *
 * 用法（不需要 node 也行，见 test/README.md 的 Electron 那套）：
 *     node test/pageCheck.mjs            检查全部页面
 *     node test/pageCheck.mjs <某个.vue>  只检查一个
 *
 * **它只证明「脚本里没有悬空引用、import 都能解析」**，不证明页面能正常跑 —— 布局、
 * 平台 API 行为、交互手感这些仍然只能在 HBuilderX 里看。别把它当成页面已测过。
 */

import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs'
import { join, resolve, dirname, relative, sep } from 'node:path'
import { tmpdir } from 'node:os'

const root = process.cwd()
// 生成物一律写到系统临时目录，不往仓库里丢垃圾
const scratch = join(tmpdir(), 'toolbox-pagecheck')
mkdirSync(scratch, { recursive: true })
writeFileSync(join(scratch, 'stub.mjs'), 'export default { name: "stub" }\n')

function walk(dir, out) {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name)
		if (statSync(full).isDirectory()) walk(full, out)
		else if (name.endsWith('.vue')) out.push(full)
	}
	return out
}

const targets = process.argv[2]
	? [resolve(process.argv[2])]
	: walk(join(root, 'pages'), []).sort()

// ---------------------------------------------------------------- 导出表

function exportsOf(path) {
	const src = readFileSync(path, 'utf8')
	const names = new Set()
	for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1])
	for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
		for (const part of m[1].split(',')) {
			const bit = part.trim()
			if (!bit) continue
			const as = bit.split(/\s+as\s+/)
			names.add((as[1] || as[0]).trim())
		}
	}
	return names
}

// ---------------------------------------------------------------- 假上下文

// uni 的桩：任意属性都返回「可无限链式调用、且不是 thenable」的假对象。
// 不是 thenable 很要紧 —— 否则 await 会把它当 Promise 一直等下去。
function fake(label) {
	return new Proxy(function () { return fake(label) }, {
		get(_t, key) {
			if (key === 'then') return undefined
			if (key === Symbol.toPrimitive) return () => 0
			if (key === 'toString') return () => '[' + label + ']'
			if (key === 'length' || key === 'width' || key === 'height') return 0
			return fake(label + '.' + String(key))
		},
		apply() { return fake(label) }
	})
}

globalThis.uni = fake('uni')
globalThis.document = { createElement: () => fake('canvas') }
globalThis.window = { devicePixelRatio: 1 }

const realError = console.error
console.error = () => {} // 页面自己的 fail() 会把输出淹掉，先静音

// ---------------------------------------------------------------- 逐个页面检查

let problems = 0
let checked = 0

for (const file of targets) {
	const rel = relative(root, file).split(sep).join('/')
	const source = readFileSync(file, 'utf8')
	const block = source.match(/<script>([\s\S]*?)<\/script>/)
	if (!block) continue
	checked++

	const issues = []
	const dir = dirname(file)

	// 1) import 都要能解析到真的导出
	for (const m of block[1].matchAll(/import\s+([\s\S]*?)\s+from\s+'([^']+)'/g)) {
		const spec = m[2]
		if (!spec.startsWith('.') && !spec.startsWith('@/')) continue
		const target = spec.startsWith('@/') ? join(root, spec.slice(2)) : resolve(dir, spec)
		if (!/\.(js|mjs)$/.test(target)) continue // .vue 组件由下面的桩顶替

		let avail
		try { avail = exportsOf(target) } catch (e) { issues.push('读不到模块 ' + spec); continue }

		const braced = m[1].match(/\{([\s\S]*)\}/)
		if (!braced) continue
		for (const part of braced[1].split(',')) {
			const name = part.trim().split(/\s+as\s+/)[0].trim()
			if (name && !avail.has(name)) issues.push('import 了不存在的导出：' + name + '  (来自 ' + spec + ')')
		}
	}

	// 2) 真跑一遍，抓悬空引用
	const rewritten = block[1].replace(/from\s+'([^']+)'/g, (whole, spec) => {
		if (spec.endsWith('.vue')) return "from '" + pathToUrl(join(scratch, 'stub.mjs')) + "'"
		if (spec.startsWith('@/')) return "from '" + pathToUrl(join(root, spec.slice(2))) + "'"
		if (spec.startsWith('.')) return "from '" + pathToUrl(resolve(dir, spec)) + "'"
		return whole
	})

	const generated = join(scratch, rel.replace(/[/\\]/g, '_') + '.mjs')
	writeFileSync(generated, rewritten)

	try {
		const component = (await import(pathToUrl(generated))).default
		if (!component) { issues.push('没有 default 导出'); }

		const fakeThis = Object.create(null)
		const data = typeof component.data === 'function' ? component.data() : {}
		for (const key of Object.keys(data)) fakeThis[key] = data[key]
		for (const key of Object.keys(component.methods || {})) fakeThis[key] = component.methods[key].bind(fakeThis)
		fakeThis.$nextTick = () => Promise.resolve()
		fakeThis.$scope = fakeThis
		fakeThis.$emit = () => {}

		const calls = []
		for (const name of ['onLoad', 'onShow', 'onHide', 'onUnload']) {
			if (typeof component[name] === 'function') calls.push([name, component[name]])
		}
		for (const name of Object.keys(component.methods || {})) calls.push(['methods.' + name, component.methods[name]])
		for (const name of Object.keys(component.computed || {})) calls.push(['computed.' + name, component.computed[name]])

		for (const [name, fn] of calls) {
			try {
				const result = fn.call(fakeThis)
				if (result && typeof result.then === 'function') {
					// 异步的限时等一等：uni 的桩不会回调，干等会永远挂着
					await Promise.race([
						result.then(() => {}, (e) => { throw e }),
						new Promise((r) => setTimeout(r, 40))
					])
				}
			} catch (error) {
				if (error instanceof ReferenceError) issues.push(name + ' → ' + error.message)
			}
		}
	} catch (error) {
		issues.push('加载脚本失败：' + ((error && error.message) || error))
	}

	if (issues.length) {
		problems += issues.length
		realError('✗ ' + rel)
		for (const line of issues) realError('    ' + line)
	} else {
		console.log('✓ ' + rel)
	}
}

function pathToUrl(p) {
	return 'file://' + resolve(p).split(sep).join('/')
}

console.log('\n检查了 ' + checked + ' 个页面')
console.log(problems
	? '发现 ' + problems + ' 处问题（脚本有悬空引用或解析不了的 import —— 这类错 node --check 抓不到）'
	: '没有发现悬空引用或解析不了的 import')
process.exitCode = problems ? 1 : 0
