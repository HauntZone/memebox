/**
 * 魔法阵的纯逻辑测试。
 *
 * 跑法见 test/README.md —— 这个文件里的 import 是**拍平的**（`./xxx.js`），
 * 和另外三个测试一致：所有模块和本文件一起复制到同一个临时目录再跑，
 * 所以不能直接 `node test/magicCircle.test.mjs`。
 * 需要复制的模块：magicShape.js / magicRunes.js / magicCircle.js / imageGeometry.js /
 * colorQuantize.js / gifWriter.js / pako.js（本机装了 node 的话直接 node 跑那个临时目录里的副本）。
 *
 * 分节与 plan 对齐。第 1 节和第 6~10 节在 magicRunes / magicCircle 落地后补进来，
 * 所以这里有编号空档 —— 编号是刻意留的，别重排。
 */

import {
	createCanvas, makeRadiusMap, strokeRing, strokeSegment, strokePolyline,
	strokeDisc, blurAlpha, composeOver, applyGlow, flattenOnto, clamp01,
	stampImage, clipCircle
} from './magicShape.js'
import { buildRune, runeBounds } from './magicRunes.js'
import { MAGIC_FONT, CAP_HEIGHT, normalizeText, glyphFor } from './magicFont.js'
import {
	resolveGlyphs, placeTextOnRing, textWidth, needsBitmap,
	planGlyphCanvas, glyphCellCenter, sliceGlyphCells, cropToInk
} from './magicText.js'
import {
	MAGIC_LIMITS, createFigure, renderFigure, renderFrames, composeCircleGif
} from './magicCircle.js'
import { composite } from './imageGeometry.js'

let pass = 0
let fail = 0

function ok(name, cond, extra) {
	if (cond) {
		pass++
		console.log('  PASS  ' + name)
	} else {
		fail++
		console.log('  FAIL  ' + name + (extra ? '  → ' + extra : ''))
	}
}

function eq(name, actual, expected) {
	ok(name, actual === expected, '期望 ' + expected + '，实际 ' + actual)
}

function near(name, actual, expected, tolerance) {
	const delta = Math.abs(actual - expected)
	ok(name, delta <= tolerance, '期望 ' + expected + ' ± ' + tolerance + '，实际 ' + actual + '（差 ' + delta.toFixed(4) + '）')
}

/** 一张图的 alpha 总和（0~1），也就是覆盖率的积分 —— 视觉上等于「覆盖了多少像素」。 */
function coverageSum(image, x0 = 0, y0 = 0, x1 = image.width - 1, y1 = image.height - 1) {
	let sum = 0
	for (let y = y0; y <= y1; y++) {
		for (let x = x0; x <= x1; x++) {
			sum += image.data[(y * image.width + x) * 4 + 3] / 255
		}
	}
	return sum
}

function alphaAt(image, x, y) {
	return image.data[(y * image.width + x) * 4 + 3]
}

/** 一张图里所有像素是不是都合法（不用 NaN 露馅 —— NaN 写进 Uint8ClampedArray 会静默变 0）。 */
function allAlphaFinite(image) {
	for (let p = 3; p < image.data.length; p += 4) {
		if (!Number.isFinite(image.data[p])) return false
	}
	return true
}

const RED = [255, 0, 0]

/** 两张图的像素是不是逐字节相同。 */
function sameBytes(a, b) {
	if (a.width !== b.width || a.height !== b.height) return false
	const x = a.data
	const y = b.data
	for (let i = 0; i < x.length; i++) {
		if (x[i] !== y[i]) return false
	}
	return true
}

/** 两张图 alpha 通道的最大差异，用于「应当相同但浮点会抖」的场合。 */
function maxAlphaDiff(a, b) {
	let max = 0
	for (let p = 3; p < a.data.length; p += 4) {
		const d = Math.abs(a.data[p] - b.data[p])
		if (d > max) max = d
	}
	return max
}

const BASE_PARAMS = { complexity: 4, lineWidth: 22, glow: 60, runeDensity: 50, colorIndex: 0 }

// ---------------------------------------------------------------- 1. 确定性
//
// 这是这个工具最大的架构红利：输入完全由参数和种子决定，所以「同一个种子必然同一张图」
// 是可测的。其它图形工具的输入都是用户选的图，做不到这一点。
console.log('\n== 1. 确定性与结构 ==')

{
	const a = renderFigure(createFigure({ presetKey: 'pentagram', seed: 42, params: BASE_PARAMS }), { size: 96 })
	const b = renderFigure(createFigure({ presetKey: 'pentagram', seed: 42, params: BASE_PARAMS }), { size: 96 })
	ok('同预设同种子同参数 → 逐字节相同', sameBytes(a, b))

	const c = renderFigure(createFigure({ presetKey: 'pentagram', seed: 43, params: BASE_PARAMS }), { size: 96 })
	ok('换个种子就不是同一张图', !sameBytes(a, c))
}

{
	let allRender = true
	let allNonEmpty = true
	let allHaveSpinner = true

	for (let i = 0; i < MAGIC_LIMITS.presetKeys.length; i++) {
		const key = MAGIC_LIMITS.presetKeys[i]
		// 每套预设都跑一遍多种子多复杂度，任何一套画不出来都要在这里露馅
		for (let seed = 1; seed <= 6; seed++) {
			for (let complexity = 2; complexity <= 6; complexity++) {
				const figure = createFigure({ presetKey: key, seed, params: { complexity } })
				const img = renderFigure(figure, { size: 48 })
				if (!img || img.width !== 48 || !allAlphaFinite(img)) allRender = false
				if (coverageSum(img) <= 0) allNonEmpty = false
			}
		}
		const figure = createFigure({ presetKey: key, seed: 1, params: BASE_PARAMS })
		if (figure.stats.spinningLayers < 1) allHaveSpinner = false
	}

	ok('六个预设 × 多种子 × 各档复杂度都能渲染出合法像素', allRender)
	ok('没有一条配置画出空白图', allNonEmpty)
	ok('每个预设都至少有一个转动的图层（否则动画是静止的）', allHaveSpinner)
}

{
	// 复杂度滑块真的在改层数，而且符文密度真的在改符文条数
	const low = createFigure({ presetKey: 'chaos', seed: 3, params: { complexity: 2 } })
	const high = createFigure({ presetKey: 'chaos', seed: 3, params: { complexity: 6 } })
	ok('复杂度提高会加图层', high.stats.layerCount > low.stats.layerCount,
		low.stats.layerCount + ' → ' + high.stats.layerCount)

	const sparse = createFigure({ presetKey: 'chaos', seed: 3, params: { runeDensity: 0 } })
	const dense = createFigure({ presetKey: 'chaos', seed: 3, params: { runeDensity: 100 } })
	ok('符文密度提高会加符文条数', dense.stats.runeCount > sparse.stats.runeCount,
		sparse.stats.runeCount + ' → ' + dense.stats.runeCount)

	// 同一个种子、只改复杂度时，符文的字形不应该变（它们由种子决定，与层数无关）
	const a = createFigure({ presetKey: 'chaos', seed: 3, params: { complexity: 6, runeDensity: 50 } })
	const b = createFigure({ presetKey: 'chaos', seed: 3, params: { complexity: 6, runeDensity: 50 } })
	const runeA = a.layers.find(function (l) { return l.kind === 'runes' })
	const runeB = b.layers.find(function (l) { return l.kind === 'runes' })
	eq('符文种子由阵的种子派生且稳定', runeA.seed, runeB.seed)
}

{
	let threw = false
	try {
		createFigure({ presetKey: '不存在的预设', seed: 1, params: {} })
	} catch (error) {
		threw = true
	}
	ok('未知预设名抛错而不是画出莫名其妙的东西', threw)
}

// ---------------------------------------------------------------- 2. 覆盖率与抗锯齿
//
// 这是整个光栅化层唯一的正确性判据。线条是从「到线段的距离」推覆盖率的，
// 斜坡宽度写错（比如 reach 忘了 +0.5、或者没 clamp）会让面积立刻偏掉，
// 而肉眼在单张图上完全看不出来。
console.log('\n== 2. 覆盖率的面积守恒 ==')

{
	// 一条水平线段的垂直剖面：覆盖率沿剖面求和，应当精确等于线条的有效宽度 2 × halfWidth。
	// 斜坡是 [hw-0.5, hw+0.5] 上的一刀切，两侧各贡献 hw，合起来正好是 2hw ——
	// 也就是说抗锯齿不会让线变粗或变细，只是把边缘抹匀了。
	const canvas = createCanvas({ size: 160 })
	const hw = 2
	strokeSegment(canvas, { x0: 20, y0: 80, x1: 120, y1: 80, halfWidth: hw, color: RED })

	let column = 0
	for (let y = 0; y < 160; y++) column += alphaAt(canvas, 70, y) / 255
	near('水平线段的垂直剖面积分 = 2 × halfWidth', column, 2 * hw, 0.02)
}

{
	// 长度加倍时面积增量应当精确等于「增量长度 × 有效宽度」。圆帽的贡献是常数，
	// 相减之后被消掉，所以这条不依赖任何关于圆帽形状的假设。
	const hw = 2
	const short = createCanvas({ size: 320 })
	const long = createCanvas({ size: 320 })
	strokeSegment(short, { x0: 40, y0: 160, x1: 140, y1: 160, halfWidth: hw, color: RED })
	strokeSegment(long, { x0: 40, y0: 160, x1: 240, y1: 160, halfWidth: hw, color: RED })

	const delta = coverageSum(long) - coverageSum(short)
	near('长度加倍的面积增量 = 增量长度 × 2 × halfWidth', delta, 100 * 2 * hw, 4)
}

{
	// 斜线的有效宽度必须和水平线一样 —— 距离场是按真实欧氏距离算的，不该受角度影响。
	const canvas = createCanvas({ size: 200 })
	const hw = 3
	strokeSegment(canvas, { x0: 20, y0: 20, x1: 180, y1: 180, halfWidth: hw, color: RED })

	const length = Math.sqrt(160 * 160 + 160 * 160)
	const expected = length * 2 * hw
	const capArea = coverageSum(canvas) - expected
	ok('45 度斜线的面积 = 长度 × 2 × halfWidth + 圆帽', Math.abs(capArea) < expected * 0.05,
		'线身之外多出 ' + capArea.toFixed(2) + '，期望是圆帽量级（' + (Math.PI * hw * hw).toFixed(2) + ' 上下）')
}

// ---------------------------------------------------------------- 3. 退化输入与取值范围
console.log('\n== 3. 退化输入不崩、不产生 NaN ==')

{
	const tiny = createCanvas({ size: 1 })
	eq('size = 1 的画布有 4 个字节', tiny.data.length, 4)
	eq('size = 1 的半径表长度正确', makeRadiusMap(1).length, 1)

	const zero = createCanvas({ size: 0 })
	eq('size = 0 被夹到 1', zero.width, 1)

	const map = makeRadiusMap(8)
	const mapCanvas = createCanvas({ size: 8 })
	strokeRing(mapCanvas, { radiusMap: map, radius: 3, halfWidth: 1, color: RED })
	ok('极小画布上的圆环不产生 NaN', allAlphaFinite(mapCanvas))
}

{
	// 零长线段（两端重合）应当退化成圆点，而不是抛错或什么都不画
	const canvas = createCanvas({ size: 64 })
	strokeSegment(canvas, { x0: 32, y0: 32, x1: 32, y1: 32, halfWidth: 3, color: RED })
	const area = coverageSum(canvas)
	ok('零长线段退化成圆点而不是空', area > 20 && area < 40, '面积 ' + area.toFixed(2) + '，期望 ≈ π×9 = 28.3')

	const line = createCanvas({ size: 64 })
	strokeSegment(line, { x0: 0, y0: 0, x1: 63, y1: 63, halfWidth: 0, color: RED })
	ok('halfWidth = 0 仍然画出东西', coverageSum(line) > 0, '面积 ' + coverageSum(line).toFixed(2))
}

{
	// 空折线、单点折线都必须是安全的 no-op
	const canvas = createCanvas({ size: 32 })
	const before = coverageSum(canvas)
	strokePolyline(canvas, { points: [], halfWidth: 1, color: RED })
	strokePolyline(canvas, { points: [[5, 5]], halfWidth: 1, color: RED })
	eq('空 / 单点折线什么都不画', coverageSum(canvas), before)
}

{
	// 画布尺寸对不上时必须抛错，而不是静默画出一片空白
	const canvas = createCanvas({ size: 64 })
	let threw = false
	try {
		strokeRing(canvas, { radiusMap: makeRadiusMap(32), radius: 20, halfWidth: 1, color: RED })
	} catch (error) {
		threw = true
	}
	ok('radiusMap 尺寸不符时抛错而不是静默画空', threw)
}

{
	eq('clamp01 夹下界', clamp01(-3), 0)
	eq('clamp01 夹上界', clamp01(9), 1)
	eq('clamp01 保留中间值', clamp01(0.25), 0.25)
}

// ---------------------------------------------------------------- 4. 圆环几何
console.log('\n== 4. 圆环画在该在的地方 ==')

{
	const canvas = createCanvas({ size: 128 })
	const map = makeRadiusMap(128)
	strokeRing(canvas, { radiusMap: map, radius: 40, halfWidth: 2, color: RED })

	// 画布中心是 (128-1)/2 = 63.5，所以「正下方 40 像素」落在第 24 行附近
	eq('环上的像素是满不透明', alphaAt(canvas, 64, 24), 255)
	eq('圆心是空的', alphaAt(canvas, 64, 64), 0)
	eq('半径 20 处是空的', alphaAt(canvas, 64, 44), 0)
	eq('画布角落是空的', alphaAt(canvas, 0, 0), 0)

	// 环的覆盖面积应当 ≈ 2π R × 有效宽度
	const expected = 2 * Math.PI * 40 * 4
	near('环面积 ≈ 周长 × 2 × halfWidth', coverageSum(canvas), expected, expected * 0.05)
}

{
	// 同心多环：外环以内的环形空档必须还是空的，说明内边界那段的切分是对的
	const canvas = createCanvas({ size: 200 })
	const map = makeRadiusMap(200)
	strokeRing(canvas, { radiusMap: map, radius: 70, halfWidth: 2, color: RED })
	strokeRing(canvas, { radiusMap: map, radius: 40, halfWidth: 2, color: RED })

	eq('70 环上不透明', alphaAt(canvas, 100, 30), 255)
	eq('40 环上不透明', alphaAt(canvas, 100, 60), 255)
	eq('两环之间是空的', alphaAt(canvas, 100, 45), 0)
	eq('圆心仍然是空的', alphaAt(canvas, 100, 100), 0)
}

// ---------------------------------------------------------------- 5. 辉光
console.log('\n== 5. 辉光只加光、不动芯线 ==')

{
	const plain = createCanvas({ size: 96 })
	const map = makeRadiusMap(96)
	strokeRing(plain, { radiusMap: map, radius: 30, halfWidth: 1.5, color: RED })

	const glowed = applyGlow({ image: plain, color: [255, 200, 0], peak: 0.8, radius: 12 })

	let neverDarker = true
	let grewOutside = 0
	for (let p = 0; p < plain.data.length; p += 4) {
		if (glowed.data[p + 3] < plain.data[p + 3]) neverDarker = false
		if (plain.data[p + 3] === 0 && glowed.data[p + 3] > 0) grewOutside++
	}

	ok('加辉光后没有任何像素变暗（辉光是垫在下面的）', neverDarker)
	ok('环外的空白处长出了光晕', grewOutside > 200, '长出 ' + grewOutside + ' 个像素')
	eq('芯线本身仍然是满不透明', alphaAt(glowed, 48, 18), 255)

	// 光晕应当随着远离芯线而衰减
	const nearRing = alphaAt(glowed, 48, 14)
	const farFromRing = alphaAt(glowed, 48, 6)
	ok('光晕离芯线越远越弱', farFromRing < nearRing, '近处 ' + nearRing + '，远处 ' + farFromRing)

	// 辉光是有界的：半径 30 的环配上 radius 12 的模糊，光晕够不到圆心（相距 30px）。
	// 这条防的是「模糊半径被算成了画布尺寸」这类错，那会让整张图泛白。
	eq('辉光够不到的地方保持干净的零', alphaAt(glowed, 48, 48), 0)
}

{
	// 盒式模糊本身：单个亮点模糊后应当 (a) 总量守恒 (b) 横竖对称。
	// 对称这条专门盯着「纵向那一趟边读边写」这类错误 —— 那种错会破坏各向同性。
	const canvas = createCanvas({ size: 64 })
	const c = 32
	canvas.data[(c * 64 + c) * 4 + 3] = 255

	const blurred = blurAlpha(canvas, 9)
	let sum = 0
	for (let i = 0; i < blurred.length; i++) sum += blurred[i]
	near('单个亮点模糊后总量守恒', sum, 1, 0.01)

	let symmetric = true
	for (let d = 1; d <= 8; d++) {
		const horizontal = blurred[c * 64 + (c + d)]
		const vertical = blurred[(c + d) * 64 + c]
		if (Math.abs(horizontal - vertical) > 1e-6) symmetric = false
	}
	ok('模糊结果横竖对称（各向同性）', symmetric)

	let peakX = 0
	let peakY = 0
	for (let y = 0; y < 64; y++) {
		for (let x = 0; x < 64; x++) {
			if (blurred[y * 64 + x] > blurred[peakY * 64 + peakX]) { peakX = x; peakY = y }
		}
	}
	eq('模糊后峰值回到原亮点位置', peakX === c && peakY === c, true)

	// peak 是归一化的目标，不是乘一个系数再夹到 1。这两者在不饱和时看不出区别，
	// 一旦饱和就分道扬镳：归一化保住渐变，乘法会把光晕压成一条更糊的实心线。
	// 所以量的是**线性度** —— 线外同一像素的 alpha 必须与 peak 成正比，且不许顶到 255。
	const ring = createCanvas({ size: 96 })
	strokeRing(ring, { radiusMap: makeRadiusMap(96), radius: 30, halfWidth: 2, color: RED })

	const samples = [0.3, 0.6, 0.9].map(function (peak) {
		const glowed = applyGlow({ image: ring, color: RED, peak, radius: 10 })
		return glowed.data[(47 * 96 + 80) * 4 + 3]
	})

	ok('光晕强度随 peak 单调上升', samples[0] < samples[1] && samples[1] < samples[2],
		samples.join(' → '))
	ok('没有饱和成实心（线外不该顶到 255）', samples[2] < 250, '最大 ' + samples[2])
	near('线外 alpha 与 peak 成正比（0.3 : 0.9 应当是 1 : 3）',
		samples[2] / samples[0], 3, 0.2)

	let threwBadPeak = false
	try {
		applyGlow({ image: ring, color: RED, radius: 10 })
	} catch (error) {
		threwBadPeak = true
	}
	ok('peak 缺失时抛错，而不是静默不画光', threwBadPeak)

	const flat = createCanvas({ size: 32 })
	for (let p = 3; p < flat.data.length; p += 4) flat.data[p] = 128
	const flatBlurred = blurAlpha(flat, 6)
	let flatOk = true
	for (let i = 0; i < flatBlurred.length; i++) {
		if (Math.abs(flatBlurred[i] - 128 / 255) > 1e-6) flatOk = false
	}
	ok('常量场模糊后仍是同一个常量（含边界）', flatOk)
}

// ---------------------------------------------------------------- 合成与压平
console.log('\n== 合成与压平 ==')

{
	const base = createCanvas({ size: 8, background: [0, 0, 0] })
	const top = createCanvas({ size: 8 })
	strokeDisc(top, { cx: 4, cy: 4, radius: 2, color: [255, 255, 255] })

	const merged = composeOver({ base, top })
	eq('合成后中心是白的', merged.data[(4 * 8 + 4) * 4], 255)
	eq('合成后画布仍是不透明的黑', alphaAt(merged, 0, 0), 255)
	eq('合成不动入参 base', base.data[(4 * 8 + 4) * 4], 0)

	const flat = flattenOnto(top, [0, 0, 0])
	eq('压平后全部不透明', alphaAt(flat, 0, 0), 255)
	eq('压平不会把透明区变亮', flat.data[0], 0)
}

// ---------------------------------------------------------------- 6. 符文
//
// buildRune 接收一个 [0,1) 的随机源而不是种子，所以这里自带一个 —— 顺便也就证明了
// 它确实只依赖「传进来的随机源」，没有偷偷摸 Math.random。
console.log('\n== 6. 符文的构字法 ==')

/** 测试专用的 mulberry32。刻意不复用 magicCircle 的，好让这条测试独立于那边。 */
function makeRand(seed) {
	let a = seed >>> 0
	return function () {
		a = (a + 0x6d2b79f5) >>> 0
		let t = a
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

{
	const a = JSON.stringify(buildRune(makeRand(1234)))
	const b = JSON.stringify(buildRune(makeRand(1234)))
	eq('同一个种子给出同一个符文', a, b)

	const c = JSON.stringify(buildRune(makeRand(1235)))
	ok('相邻种子给出不同的符文', a !== c)
}

{
	const seeds = 300
	const seen = new Set()
	let minStrokes = 99
	let inRange = true
	let onGrid = true
	let stemAlwaysThere = true

	for (let seed = 0; seed < seeds; seed++) {
		const strokes = buildRune(makeRand(seed))
		seen.add(JSON.stringify(strokes))

		if (strokes.length < minStrokes) minStrokes = strokes.length

		// 主干：x 恒为 0.5 且贯穿上下（0.1 ~ 0.9 是墨迹的纵向范围）
		const stem = strokes[0]
		if (stem.length !== 2 || stem[0][0] !== 0.5 || stem[1][0] !== 0.5) stemAlwaysThere = false
		if (Math.abs(stem[0][1] - 0.1) > 1e-9 || Math.abs(stem[1][1] - 0.9) > 1e-9) stemAlwaysThere = false

		for (let s = 0; s < strokes.length; s++) {
			for (let p = 0; p < strokes[s].length; p++) {
				const x = strokes[s][p][0]
				const y = strokes[s][p][1]
				if (x < 0 || x > 1 || y < 0 || y > 1) inRange = false
				// 吸附到 0.1 网格之后，坐标 ×10 必然接近整数。
				// 浮点乘 10 会有误差，所以用 1e-9 而不是精确相等。
				if (Math.abs(x * 10 - Math.round(x * 10)) > 1e-9) onGrid = false
				if (Math.abs(y * 10 - Math.round(y * 10)) > 1e-9) onGrid = false
			}
		}
	}

	ok('所有坐标都落在 [0,1] 方块内', inRange)
	ok('所有坐标都吸附在 0.1 网格上（这是「像刻的」的来源）', onGrid)
	ok('每个符文都有主干，且主干贯穿上下', stemAlwaysThere)
	ok('每个符文是主干 + 至少一条枝', minStrokes >= 2, '最少 ' + minStrokes + ' 条折线')
	ok('300 个种子给出的符文几乎不重复', seen.size > 250, '不重复 ' + seen.size + ' / ' + seeds)
}

{
	// 镜像：约三分之一的符文枝长在左边。比例明显偏离就说明那一步没生效。
	let mirrored = 0
	const total = 400
	for (let seed = 0; seed < total; seed++) {
		const strokes = buildRune(makeRand(seed))
		const bounds = runeBounds(strokes)
		if (bounds.maxX <= 0.5) mirrored++
	}
	ok('镜像符文占了有意义的一部分（约三分之一）', mirrored > total * 0.2 && mirrored < total * 0.5,
		mirrored + ' / ' + total)
}

{
	const strokes = buildRune(makeRand(7))
	const bounds = runeBounds(strokes)
	ok('外接框包住所有点', bounds.minX <= 0.5 && bounds.maxX >= 0.5 && bounds.minY <= 0.1 && bounds.maxY >= 0.9,
		JSON.stringify(bounds))
}

// ---------------------------------------------------------------- 7. 无缝循环
//
// 循环要能接得上，充要条件是「每层每循环转整数圈」—— 这样循环走完每层都恰好回到
// 原位，接缝处的角位移恰好等于帧间角位移，看不出跳变。这条是构造性的，
// 所以测试分两半：先证明所有图层的 spin 都是整数，再证明相位 1 与相位 0 是同一张图。
console.log('\n== 7. 旋转循环的无缝性 ==')

{
	let allInteger = true
	let spins = new Set()
	for (let i = 0; i < MAGIC_LIMITS.presetKeys.length; i++) {
		const figure = createFigure({ presetKey: MAGIC_LIMITS.presetKeys[i], seed: 9, params: BASE_PARAMS })
		for (let j = 0; j < figure.layers.length; j++) {
			const spin = figure.layers[j].spin
			if (!Number.isInteger(spin)) allInteger = false
			spins.add(spin)
		}
	}
	ok('所有图层的转速都是整数圈/循环', allInteger, '出现过的转速：' + Array.from(spins).sort().join(','))
}

{
	const figure = createFigure({ presetKey: 'pentagram', seed: 11, params: { complexity: 6 } })
	const atZero = renderFigure(figure, { size: 160, time: 0 })
	const atOne = renderFigure(figure, { size: 160, time: 1 })
	const drift = maxAlphaDiff(atZero, atOne)
	ok('相位 1 回到相位 0（循环闭合）', drift <= 2, '最大 alpha 差 ' + drift + '（浮点 cos/sin(θ+2π) 的舍入）')

	// 反过来：半圈时必须有明显不同，否则说明转速压根没起作用
	const atHalf = renderFigure(figure, { size: 160, time: 0.5 })
	ok('相位 0.5 明显不同于相位 0（转速真的生效了）', maxAlphaDiff(atZero, atHalf) > 20,
		'最大 alpha 差 ' + maxAlphaDiff(atZero, atHalf))
}

// ---------------------------------------------------------------- 8. 逐帧渲染
console.log('\n== 8. 逐帧渲染与静态图一致 ==')

{
	const figure = createFigure({ presetKey: 'hallow', seed: 21, params: BASE_PARAMS })
	const frames = renderFrames(figure, { size: 64, frames: 12 })
	const still = renderFigure(figure, { size: 64, time: 0 })

	eq('帧数正确', frames.length, 12)
	ok('第 0 帧与静态渲染逐字节相同', sameBytes(frames[0], still))
	ok('相邻帧确实不同（动画真的在动）', !sameBytes(frames[0], frames[1]))
	ok('所有帧尺寸一致', frames.every(function (f) { return f.width === 64 && f.height === 64 }))
}

// ---------------------------------------------------------------- 9. GIF 可被独立解码
//
// 这个解析器是照 GIF89a 规范从**解码侧**独立写的，不是把编码器倒过来。同源的解码器
// 只能证明「自洽」，证明不了「符合格式」。petpet.test.mjs 里那套用的是同一个思路。
console.log('\n== 9. 生成的 GIF 能被独立解析 ==')

function parseGif(bytes) {
	let pos = 6
	const width = bytes[pos] | (bytes[pos + 1] << 8)
	const height = bytes[pos + 2] | (bytes[pos + 3] << 8)
	const packed = bytes[pos + 4]
	pos += 7
	if (packed & 0x80) pos += 3 * (1 << ((packed & 0x07) + 1))

	const frames = []
	let loop = null
	let trailer = false

	while (pos < bytes.length) {
		const marker = bytes[pos]
		if (marker === 0x3b) { trailer = true; break }

		if (marker === 0x21) {
			const label = bytes[pos + 1]
			if (label === 0xf9) {
				const gce = bytes[pos + 3]
				frames.push({
					delay: bytes[pos + 4] | (bytes[pos + 5] << 8),
					disposal: (gce >> 2) & 0x07,
					hasTransparency: (gce & 0x01) !== 0
				})
			} else if (label === 0xff) {
				// 应用扩展块：NETSCAPE2.0 的循环次数
				let p = pos + 2
				const size = bytes[p]
				const name = String.fromCharCode(...bytes.slice(p + 1, p + 1 + size))
				p += 1 + size
				if (name.indexOf('NETSCAPE') === 0) {
					loop = bytes[p + 2] | (bytes[p + 3] << 8)
				}
			}
			pos += 2
			while (bytes[pos] !== 0) pos += bytes[pos] + 1
			pos += 1
		} else if (marker === 0x2c) {
			pos += 10
			const lflags = bytes[pos - 1]
			if (lflags & 0x80) pos += 3 * (1 << ((lflags & 0x07) + 1))
			pos += 1
			while (bytes[pos] !== 0) pos += bytes[pos] + 1
			pos += 1
		} else {
			break
		}
	}

	return { width, height, frames, loop, trailer }
}

{
	// GIF 必须压到不透明底上再量化 —— 辉光是 alpha 从 0 渐变的像素，
	// 带着透明去量化会被 alphaThreshold 拦腰截断成一圈硬边。
	const figure = createFigure({ presetKey: 'element', seed: 5, params: BASE_PARAMS })
	const raw = renderFrames(figure, { size: 96, frames: 8 })
	const frames = raw.map(function (f) { return composite({ image: f, background: 0 }) })

	const result = composeCircleGif({ frames, delayCs: 8 })
	const gif = parseGif(result.bytes)

	eq('帧数', gif.frames.length, 8)
	eq('宽', gif.width, 96)
	eq('高', gif.height, 96)
	eq('每帧延时（厘秒）', gif.frames[0].delay, 8)
	ok('所有帧的延时都一致', gif.frames.every(function (f) { return f.delay === 8 }))
	ok('disposal 全部是 2（恢复背景）', gif.frames.every(function (f) { return f.disposal === 2 }),
		'实际：' + gif.frames.map(function (f) { return f.disposal }).join(','))
	eq('循环次数 0 = 无限循环', gif.loop, 0)
	ok('文件有正常的收尾块', gif.trailer)
	ok('调色板不超过 255 色', result.palette.length <= 255, '实际 ' + result.palette.length + ' 色')

	// 压平之后不该再有任何透明像素（否则说明压平那步没生效）
	ok('压平后帧里没有半透明残留', frames.every(function (f) {
		for (let p = 3; p < f.data.length; p += 4) if (f.data[p] !== 255) return false
		return true
	}))
}

// ---------------------------------------------------------------- 10. 性能基准
console.log('\n== 10. 性能基准（数字要如实记进交付说明）==')

{
	function time(label, fn) {
		const t0 = Date.now()
		const value = fn()
		const ms = Date.now() - t0
		console.log('        ' + label.padEnd(34) + ms + 'ms')
		return { ms, value }
	}

	const figure = createFigure({ presetKey: 'chaos', seed: 1, params: BASE_PARAMS })

	const preview = time('400² 预览渲染', function () { return renderFigure(figure, { size: 400 }) })
	const full = time('1080² 导出渲染', function () { return renderFigure(figure, { size: 1080 }) })
	const huge = time('1440² 导出渲染', function () { return renderFigure(figure, { size: 1440 }) })

	ok('400² 预览在 400ms 以内', preview.ms < 400, preview.ms + 'ms')
	ok('1080² 导出在 1500ms 以内', full.ms < 1500, full.ms + 'ms')
	ok('1440² 导出在 2500ms 以内', huge.ms < 2500, huge.ms + 'ms')

	const gifFrames = MAGIC_LIMITS.frameDefault
	const gifEdge = MAGIC_LIMITS.gifEdgeDefault
	const gif = time(gifFrames + ' 帧 ' + gifEdge + '² GIF 组装', function () {
		const raw = renderFrames(figure, { size: gifEdge, frames: gifFrames })
		const flat = raw.map(function (f) { return composite({ image: f, background: 0 }) })
		return composeCircleGif({ frames: flat, delayCs: MAGIC_LIMITS.delayDefault })
	})

	ok('默认档 GIF 组装在 6000ms 以内', gif.ms < 6000, gif.ms + 'ms')
	ok('GIF 体积在合理范围（< 2MB）', gif.value.bytes.length < 2 * 1024 * 1024,
		Math.round(gif.value.bytes.length / 1024) + 'KB')
	console.log('        ' + '默认档 GIF 体积'.padEnd(34) + Math.round(gif.value.bytes.length / 1024) + 'KB')
}

// ---------------------------------------------------------------- 11. 矢量字体
console.log('\n== 11. 矢量字体的完整性 ==')

{
	const chars = Object.keys(MAGIC_FONT)
	const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
	const digits = '0123456789'.split('')

	ok('26 个大写字母一个不缺', letters.every(function (c) { return !!MAGIC_FONT[c] }))
	ok('10 个数字一个不缺', digits.every(function (c) { return !!MAGIC_FONT[c] }))

	let inRange = true
	let enoughPoints = true
	let advanceSane = true
	let noEmptyNonSpace = true

	for (let i = 0; i < chars.length; i++) {
		const g = MAGIC_FONT[chars[i]]

		// y 允许略微超出字高（逗号、括号带下伸部），但不该离谱
		for (let s = 0; s < g.s.length; s++) {
			const stroke = g.s[s]
			if (stroke.length < 2) enoughPoints = false
			for (let p = 0; p < stroke.length; p++) {
				const x = stroke[p][0]
				const y = stroke[p][1]
				if (x < -0.01 || x > 10 || y < -0.01 || y > CAP_HEIGHT + 2) inRange = false
			}
		}

		// 步进必须宽于墨迹，否则相邻两字会叠在一起
		if (g.a < g.w) advanceSane = false
		if (chars[i] !== ' ' && g.s.length === 0) noEmptyNonSpace = false
	}

	ok('所有坐标都在合理的网格范围内', inRange)
	ok('每条折线至少两个点', enoughPoints)
	ok('步进宽度不小于墨迹宽度（否则相邻字会叠）', advanceSane)
	ok('除空格外没有空字形', noEmptyNonSpace)
	ok('空格的步进宽度合理且没有笔画', MAGIC_FONT[' '].a > 0 && MAGIC_FONT[' '].s.length === 0)
}

{
	eq('输入统一转成大写', normalizeText('solomon'), 'SOLOMON')
	eq('非字符串输入不炸', normalizeText(null), '')
	eq('取已知字符得到字形', !!glyphFor('A'), true)
	eq('取未知字符得到 null', glyphFor('中'), null)

	const glyphs = resolveGlyphs('AB1-', null)
	eq('ASCII 全部解析成描边字形', glyphs.filter(function (g) { return g.kind === 'stroke' }).length, 4)

	const mixed = resolveGlyphs('A中B', null)
	eq('非 ASCII 没有缓存时给占位框', mixed.filter(function (g) { return g.kind === 'tofu' }).length, 1)
	eq('占位不影响其它字符', mixed.filter(function (g) { return g.kind === 'stroke' }).length, 2)
}

{
	// 给一份合成的掩膜，非 ASCII 就该走位图而不是占位框
	const mask = createCanvas({ size: 40 })
	for (let y = 8; y < 32; y++) {
		for (let x = 14; x < 26; x++) mask.data[(y * 40 + x) * 4 + 3] = 255
	}
	const glyphs = resolveGlyphs('中', { 中: mask })
	eq('有缓存时走位图字形', glyphs[0].kind, 'bitmap')
	ok('位图字形的步进宽于自身宽度', glyphs[0].advance > glyphs[0].width)
}

// ---------------------------------------------------------------- 12. 文字排版
console.log('\n== 12. 文字沿环的排版 ==')

{
	const glyphs = resolveGlyphs('MAGIC', null)
	const radius = 0.8
	const size = 0.09
	const layout = placeTextOnRing({ glyphs, radius, size, rotation: 0 })

	near('弧跨度 = 总步进 / 半径', layout.arcSpan, textWidth(glyphs, size) / radius, 1e-9)
	eq('没有缺字时 missing 为 0', layout.missing, 0)
	ok('描边字形产出折线', layout.strokes.length > 0)
	eq('描边字形不产出贴图', layout.stamps.length, 0)
	ok('短文本绕得下', layout.fits)
}

{
	// 字形的「上」必须朝外：字形顶端的点半径应当大于底端。
	// 这条是「文字上朝外」这个视觉语言的定义，方向反了整圈字就是倒的。
	const glyphs = resolveGlyphs('I', null)
	const radius = 0.8
	const size = 0.1
	const layout = placeTextOnRing({ glyphs, radius, size, rotation: 0 })

	// 主干是一条竖线，两端分别在网格 y=0 和 y=12
	const stem = layout.strokes[0]
	const radiusAt = function (p) { return Math.sqrt(p[0] * p[0] + p[1] * p[1]) }
	const ends = [radiusAt(stem[0]), radiusAt(stem[stem.length - 1])]
	const outer = Math.max(ends[0], ends[1])
	const inner = Math.min(ends[0], ends[1])

	ok('字形顶端朝外（两端半径明显不同）', outer - inner > size * 0.3,
		'两端半径 ' + outer.toFixed(4) + ' / ' + inner.toFixed(4))
	near('外侧落在 radius + size/2 附近', outer, radius + size * 0.5, size * 0.25)
	near('内侧落在 radius - size/2 附近', inner, radius - size * 0.5, size * 0.25)
}

{
	// 整体以 rotation 为中心：rotation 转 π 之后应当得到点对称的排布
	const glyphs = resolveGlyphs('ABC', null)
	const radius = 0.8
	const size = 0.1

	const atZero = placeTextOnRing({ glyphs, radius, size, rotation: 0 })
	const atPi = placeTextOnRing({ glyphs, radius, size, rotation: Math.PI })

	// 绕圈转 π 就是整张布局的点反射 (x,y) → (-x,-y)，字序不变 —— 所以是同一个索引配对
	let mirrored = true
	eq('两种 rotation 下的折线数一致', atPi.strokes.length, atZero.strokes.length)
	for (let i = 0; i < atZero.strokes.length; i++) {
		const a = atZero.strokes[i]
		const b = atPi.strokes[i]
		for (let p = 0; p < a.length; p++) {
			if (Math.abs(a[p][0] + b[p][0]) > 1e-9 || Math.abs(a[p][1] + b[p][1]) > 1e-9) mirrored = false
		}
	}
	ok('rotation 转过 π 得到点对称的排布（说明确实绕 rotation 居中）', mirrored)

	let inside = true
	const maxRadius = radius + size
	for (let i = 0; i < atZero.strokes.length; i++) {
		for (let p = 0; p < atZero.strokes[i].length; p++) {
			const d = Math.hypot(atZero.strokes[i][p][0], atZero.strokes[i][p][1])
			if (d > maxRadius + 1e-9) inside = false
		}
	}
	ok('所有点都落在字形带内', inside)
}

{
	// 位图字形排版成贴图
	const mask = createCanvas({ size: 40, background: [255, 255, 255] })
	const glyphs = resolveGlyphs('中', { 中: mask })
	const layout = placeTextOnRing({ glyphs, radius: 0.8, size: 0.1, rotation: 0 })

	eq('位图字形产出贴图', layout.stamps.length, 1)
	eq('位图字形不产出折线', layout.strokes.length, 0)
	near('贴图宽度 = 位图宽高比 × 字高', layout.stamps[0].width, 0.1, 1e-9)
}

{
	const glyphs = resolveGlyphs('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', null)
	const layout = placeTextOnRing({ glyphs, radius: 0.3, size: 0.18, rotation: 0 })
	ok('文字绕不下时如实报告 fits = false（好让页面提示）', !layout.fits,
		'弧跨度 ' + layout.arcSpan.toFixed(2))
}

// ---------------------------------------------------------------- 13. stampImage
console.log('\n== 13. 贴图的旋转与采样 ==')

{
	// 一张只有左半边不透明的图：angle 为 0 时贴在中心左侧，转 π 之后到右侧。
	// 这条直接证明 angle 的语义是「把贴图自身的 x 轴转过去」，而不是别的什么约定。
	const sprite = createCanvas({ size: 32 })
	for (let y = 0; y < 32; y++) {
		for (let x = 0; x < 16; x++) {
			const p = (y * 32 + x) * 4
			sprite.data[p] = 255
			sprite.data[p + 3] = 255
		}
	}

	const a = createCanvas({ size: 64 })
	stampImage(a, { image: sprite, cx: 32, cy: 32, width: 32, angle: 0 })
	const b = createCanvas({ size: 64 })
	stampImage(b, { image: sprite, cx: 32, cy: 32, width: 32, angle: Math.PI })

	ok('angle = 0 时贴图落在中心左侧', alphaAt(a, 24, 32) > 200 && alphaAt(a, 40, 32) === 0)
	ok('angle = π 时贴图落在中心右侧', alphaAt(b, 40, 32) > 200 && alphaAt(b, 24, 32) === 0)
}

{
	// 预乘采样：不透明红块贴着透明区，边界像素必须仍然是纯红。
	// 直接对 rgb 加权的话透明像素的 rgb(0,0,0) 会被算进去，边界就发黑 ——
	// 照片裁圆、字形贴图这类输入全靠这一点。
	const sprite = createCanvas({ size: 32 })
	for (let y = 0; y < 32; y++) {
		for (let x = 0; x < 16; x++) {
			const p = (y * 32 + x) * 4
			sprite.data[p] = 255
			sprite.data[p + 3] = 255
		}
	}

	const target = createCanvas({ size: 64 })
	stampImage(target, { image: sprite, cx: 32, cy: 32, width: 48, angle: 0 })

	let minRed = 255
	let sawPartial = false
	for (let p = 0; p < target.data.length; p += 4) {
		const a = target.data[p + 3]
		if (a === 0) continue
		if (a < 255) sawPartial = true
		if (target.data[p] < minRed) minRed = target.data[p]
	}

	ok('边缘存在半透明像素（说明有抗锯齿）', sawPartial)
	ok('半透明边缘不发黑（预乘采样正确）', minRed > 250, '最暗的红通道是 ' + minRed)
}

{
	const sprite = createCanvas({ size: 8, background: [10, 200, 30] })
	const target = createCanvas({ size: 32 })
	// 中心贴到画布外，越界部分必须被丢掉且不产生 NaN
	stampImage(target, { image: sprite, cx: -4, cy: 16, width: 16, angle: 0.3 })
	stampImage(target, { image: sprite, cx: 40, cy: 16, width: 16, angle: -1.1 })
	ok('越界贴图不产生 NaN', allAlphaFinite(target))

	const rotated = createCanvas({ size: 32 })
	stampImage(rotated, { image: sprite, cx: 16, cy: 16, width: 16, angle: 2 * Math.PI })
	const straight = createCanvas({ size: 32 })
	stampImage(straight, { image: sprite, cx: 16, cy: 16, width: 16, angle: 0 })
	ok('转整整一圈等于不转', maxAlphaDiff(rotated, straight) <= 1,
		'最大差 ' + maxAlphaDiff(rotated, straight))

	const untouched = createCanvas({ size: 16 })
	const before = coverageSum(untouched)
	stampImage(untouched, { image: sprite, cx: 8, cy: 8, width: 0, angle: 0 })
	stampImage(untouched, { image: sprite, cx: 8, cy: 8, width: 8, angle: 0, alpha: 0 })
	eq('宽度为 0 / alpha 为 0 时什么都不画', coverageSum(untouched), before)
}

// ---------------------------------------------------------------- 14. clipCircle
console.log('\n== 14. 圆形裁剪 ==')

{
	const size = 200
	const solid = createCanvas({ size, background: [200, 100, 50] })
	const radius = 60
	const clipped = clipCircle(solid, { radius, feather: 1 })

	eq('圆心保持不变', alphaAt(clipped, 100, 100), 255)
	eq('圆外归零（正右方）', alphaAt(clipped, 100 + radius + 3, 100), 0)
	eq('圆外归零（正下方）', alphaAt(clipped, 100, 100 + radius + 3), 0)
	eq('圆外归零（对角线）', alphaAt(clipped, 100 + 45, 100 + 45), 0)
	eq('裁剪不动入参', alphaAt(solid, 0, 0), 255)

	// 面积守恒：和线条覆盖率用的是同一套判据
	const expected = Math.PI * radius * radius
	near('覆盖率积分 ≈ πr²', coverageSum(clipped), expected, expected * 0.02)

	const hard = clipCircle(solid, { radius, feather: 1 })
	const soft = clipCircle(solid, { radius, feather: 8 })
	let hardEdge = 0
	let softEdge = 0
	for (let p = 3; p < hard.data.length; p += 4) {
		if (hard.data[p] > 0 && hard.data[p] < 255) hardEdge++
		if (soft.data[p] > 0 && soft.data[p] < 255) softEdge++
	}
	ok('羽化越大，软边像素越多', softEdge > hardEdge * 2, hardEdge + ' → ' + softEdge)
}

// ---------------------------------------------------------------- 15. 内容层与合成顺序
console.log('\n== 15. 内容层的合成顺序 ==')

{
	// 合成顺序直接测 applyGlow 的 underlay：辉光 → 图片 → 线条。
	// 图只在「线条透明」的地方露出来，线条压在图之上。
	const lines = createCanvas({ size: 64 })
	strokeDisc(lines, { cx: 32, cy: 32, radius: 6, color: [255, 0, 0] })
	const image = createCanvas({ size: 64, background: [0, 255, 0] })

	const out = applyGlow({ image: lines, color: [255, 0, 0], peak: 0, radius: 0, underlay: image })
	eq('线条不透明处仍是线条的颜色（线条压在图之上）', out.data[(32 * 64 + 32) * 4], 255)
	eq('线条之外露出图片', out.data[(4 * 64 + 4) * 4 + 1], 255)
	eq('图片区域完全不透明', alphaAt(out, 4, 4), 255)

	// 不传 underlay 时行为不变（既有的调用点都靠这一点）
	const plain = applyGlow({ image: lines, color: [255, 0, 0], peak: 0, radius: 0 })
	eq('不传 underlay 时图片区域仍是透明的', alphaAt(plain, 4, 4), 0)
}

{
	// 走完整的建图路径：注入一张纯绿的中心图，圆内应当大面积为绿
	const size = 160
	const green = createCanvas({ size: 128, background: [0, 255, 0] })
	const figure = createFigure({
		presetKey: 'pentagram',
		seed: 3,
		params: { glow: 0, complexity: 2 },
		content: { center: { image: green } }
	})
	const img = renderFigure(figure, { size })

	const scale = (size / 2) * MAGIC_LIMITS.radiusSpan
	const c = (size - 1) / 2
	const inner = 0.2 * scale

	let greenPixels = 0
	let total = 0
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			if (Math.hypot(x - c, y - c) > inner) continue
			total++
			const p = (y * size + x) * 4
			if (img.data[p + 1] > 200 && img.data[p] < 60 && img.data[p + 2] < 60) greenPixels++
		}
	}
	ok('中心图在阵心大面积可见', greenPixels > total * 0.5,
		greenPixels + ' / ' + total + ' 个像素是图片色')

	// 裁圆：图片方形的四个角在圆外，不该是图片色
	const k = Math.round(c - 0.25 * scale)
	const p = (k * size + k) * 4
	ok('图片的方角被裁掉了（圆外不是图片色）',
		!(img.data[p + 1] > 200 && img.data[p] < 60 && img.data[p + 2] < 60))
}

{
	// 环绕图：cycle 模式下多张图各占槽位，same 模式只用第一张
	const size = 200
	const red = createCanvas({ size: 64, background: [255, 0, 0] })
	const blue = createCanvas({ size: 64, background: [0, 0, 255] })

	const mk = function (mode) {
		const figure = createFigure({
			presetKey: 'pentagram', seed: 3,
			params: { glow: 0, complexity: 2, ring: { count: 4, radius: 70, size: 20, mode } },
			content: { ring: { images: [red, blue] } }
		})
		return renderFigure(figure, { size })
	}

	const cycled = mk('cycle')
	const same = mk('same')

	let blueInCycled = false
	let blueInSame = false
	for (let p = 0; p < cycled.data.length; p += 4) {
		if (cycled.data[p] < 60 && cycled.data[p + 2] > 200) blueInCycled = true
		if (same.data[p] < 60 && same.data[p + 2] > 200) blueInSame = true
	}
	ok('cycle 模式下第二张图也出现了', blueInCycled)
	ok('same 模式下只用第一张图', !blueInSame)
}

// ---------------------------------------------------------------- 16. 注入式确定性
console.log('\n== 16. 注入内容的确定性 ==')

{
	// 「同种子同图」在引入用户内容之后不再成立（用户传的图不属于种子），
	// 但「同一份参数 + 同一份注入内容」仍然必须逐字节可复现 ——
	// 这是新的可复现性保证，也是这一整套注入式测试的前提。
	const mask = createCanvas({ size: 32 })
	for (let y = 6; y < 26; y++) for (let x = 10; x < 22; x++) mask.data[(y * 32 + x) * 4 + 3] = 255
	const photo = createCanvas({ size: 64, background: [30, 120, 210] })

	const make = function () {
		return createFigure({
			presetKey: 'chaos',
			seed: 99,
			params: { complexity: 5 },
			content: {
				text: { glyphs: resolveGlyphs('AB中', { 中: mask }) },
				center: { image: photo },
				ring: { images: [photo] }
			}
		})
	}

	ok('带文字与图片时，同参数同内容渲染两次逐字节相同',
		sameBytes(renderFigure(make(), { size: 96 }), renderFigure(make(), { size: 96 })))

	const other = createFigure({
		presetKey: 'chaos', seed: 99, params: { complexity: 5 },
		content: { center: { image: createCanvas({ size: 64, background: [210, 30, 30] }) } }
	})
	ok('换一张注入的图片就不再是同一张图',
		!sameBytes(renderFigure(make(), { size: 96 }), renderFigure(other, { size: 96 })))
}

{
	const mask = createCanvas({ size: 32 })
	const figure = createFigure({
		presetKey: 'clock', seed: 1, params: {},
		content: {
			text: { glyphs: resolveGlyphs('AB中国', { 中: mask }) },
			center: { image: createCanvas({ size: 32, background: [1, 2, 3] }) },
			ring: { images: [createCanvas({ size: 32, background: [1, 2, 3] })] }
		}
	})

	eq('统计：文字字数', figure.stats.textChars, 4)
	eq('统计：中心图', figure.stats.centerImage, 1)
	eq('统计：环绕槽位数', figure.stats.ringSlots, MAGIC_LIMITS.ringCountDefault)
	ok('内容层被加进了图层表',
		figure.layers.some(function (l) { return l.kind === 'text' }) &&
		figure.layers.some(function (l) { return l.kind === 'centerImage' }) &&
		figure.layers.some(function (l) { return l.kind === 'ringImages' }))

	// 什么都不传时不该凭空多出内容层
	const bare = createFigure({ presetKey: 'clock', seed: 1, params: {} })
	eq('没传内容时没有文字层', bare.stats.textChars, 0)
	eq('没传内容时没有中心图', bare.stats.centerImage, 0)
	eq('没传内容时没有环绕层', bare.stats.ringSlots, 0)
}

// ---------------------------------------------------------------- 17. 字形光栅化的排版
//
// 这一段是纯计算（平台层只负责「把字画到画布上」那一步），所以能脱离 canvas 测。
// 布局算错的话症状是「字挤成一团」或「画布尺寸和 prepareCanvas 不一致导致读到错像素」。
console.log('\n== 17. 字形光栅化的排版 ==')

{
	ok('英文不需要位图（内置描边字体管）', !needsBitmap('A'))
	ok('中文需要位图', needsBitmap('中'))
	ok('空格不需要位图', !needsBitmap(' '))
	ok('空输入不需要位图', !needsBitmap(''))
}

{
	const plan = planGlyphCanvas('ABAC B', 64)
	eq('去重后只剩不同的字符', plan.chars.length, 3)
	eq('顺序按首次出现', plan.chars.join(''), 'ABC')
	eq('格子尺寸照传', plan.cellSize, 64)
	eq('画布宽 = 列数 × 格子', plan.width, plan.columns * 64)
	eq('画布高 = 行数 × 格子', plan.height, plan.rows * 64)
	ok('画布装得下所有格子', plan.columns * plan.rows >= plan.chars.length)

	const many = planGlyphCanvas('0123456789ABCDEFGHIJ', 100)
	ok('列数有上限，不会排成一条几千像素的长条', many.columns <= 8, '列数 ' + many.columns)
	ok('画布尺寸与格子数自洽', many.width === many.columns * 100 && many.height === many.rows * 100)

	const empty = planGlyphCanvas('   ', 64)
	eq('全是空白时没有要光栅化的字符', empty.chars.length, 0)
	eq('空输入也要给一个合法画布', planGlyphCanvas('', 64).width > 0, true)
	ok('格子尺寸有下限（太小会糊）', planGlyphCanvas('A', 0).cellSize >= 8)
}

{
	const plan = planGlyphCanvas('ABCDE', 64)
	const first = glyphCellCenter(plan, 0)
	eq('第一格中心 x', first.x, 32)
	eq('第一格中心 y', first.y, 32)

	const secondRow = glyphCellCenter(plan, plan.columns)
	eq('换行后回到第一列', secondRow.x, 32)
	eq('换行后 y 加一格', secondRow.y, 96)
}

{
	// 第二格画在偏左上角，第二格留空 —— 收紧和「空格子返回 null」都要能看出来
	const cell = 32
	const plan = planGlyphCanvas('AB', cell)
	const pixels = new Uint8ClampedArray(plan.width * plan.height * 4)
	for (let y = 7; y <= 20; y++) {
		for (let x = 5; x <= 12; x++) {
			const p = (y * plan.width + x) * 4
			pixels[p] = 255
			pixels[p + 1] = 255
			pixels[p + 2] = 255
			pixels[p + 3] = 255
		}
	}

	const out = sliceGlyphCells(pixels, plan)
	ok('有墨迹的格子被切出来', !!out.A)
	eq('收紧到墨迹宽度', out.A.width, 8)
	eq('收紧到墨迹高度', out.A.height, 14)
	eq('收紧后第一个像素是不透明的', out.A.data[3], 255)
	ok('整格全空的字符不返回（上层会退回占位框）', !out.B)

	eq('全空区域返回 null', cropToInk(new Uint8ClampedArray(16 * 16 * 4), 16, 0, 0, 16), null)
}

// ---------------------------------------------------------------- 18. 内容层的性能基准
console.log('\n== 18. 带文字与图片的性能基准 ==')

{
	function time(label, fn) {
		const t0 = Date.now()
		const value = fn()
		const ms = Date.now() - t0
		console.log('        ' + label.padEnd(34) + ms + 'ms')
		return { ms, value }
	}

	// 造一张「照片」：有渐变噪声，用来压一压量化的内存和耗时
	const photo = createCanvas({ size: 512 })
	for (let y = 0; y < 512; y++) {
		for (let x = 0; x < 512; x++) {
			const p = (y * 512 + x) * 4
			photo.data[p] = (x * 7) % 256
			photo.data[p + 1] = (y * 5) % 256
			photo.data[p + 2] = ((x + y) * 3) % 256
			photo.data[p + 3] = 255
		}
	}

	const mask = createCanvas({ size: 128 })
	for (let y = 20; y < 108; y++) for (let x = 24; x < 104; x++) mask.data[(y * 128 + x) * 4 + 3] = 255
	const glyphs = resolveGlyphs('SOLOMON 2026 中文', { 中: mask, 文: mask })

	const heavy = createFigure({
		presetKey: 'chaos', seed: 1, params: { complexity: 6 },
		content: {
			text: { glyphs },
			center: { image: photo },
			ring: { images: [photo, photo], mode: 'cycle', count: 8 }
		}
	})

	const preview = time('400² 预览（带内容）', function () { return renderFigure(heavy, { size: 400 }) })
	const full = time('1440² 导出（带内容）', function () { return renderFigure(heavy, { size: 1440 }) })

	ok('带内容的 400² 预览在 600ms 以内', preview.ms < 600, preview.ms + 'ms')
	ok('带内容的 1440² 导出在 3000ms 以内', full.ms < 3000, full.ms + 'ms')

	const gif = time(MAGIC_LIMITS.frameDefault + ' 帧 ' + MAGIC_LIMITS.gifEdgeDefault + '² GIF（带内容）', function () {
		const raw = renderFrames(heavy, { size: MAGIC_LIMITS.gifEdgeDefault, frames: MAGIC_LIMITS.frameDefault })
		const flat = raw.map(function (f) { return composite({ image: f, background: 0 }) })
		return composeCircleGif({ frames: flat, delayCs: MAGIC_LIMITS.delayDefault })
	})

	console.log('        ' + '带内容的 GIF 体积'.padEnd(34) + Math.round(gif.value.bytes.length / 1024) + 'KB')
	ok('带内容的默认档 GIF 组装在 9000ms 以内（图片进 GIF 会明显变重）',
		gif.ms < 9000, gif.ms + 'ms')
}

// ----------------------------------------------------------------
console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项')
process.exit(fail ? 1 : 0)
