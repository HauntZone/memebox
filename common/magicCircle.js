/**
 * 魔法阵的运算内核：纯函数，不含任何 uni API、DOM 或平台判断。
 *
 * 输入是「预设 + 种子 + 参数」，输出是确定的 RGBA —— 同一个种子必然给出同一张图，
 * 这是这个工具可验证性的来源（本项目其它图形工具的输入都是一张用户选的图，
 * 输出对不对很难自己验证）。
 *
 * 三层结构：
 *   createFigure  预设 + 种子 + 参数 → 图层列表（纯数据，不渲染）
 *   renderFigure  图层列表 + 尺寸 + 时刻 → RGBA
 *   renderFrames  按整数圈转速铺开若干帧，交给 gifWriter 编码
 *
 * 关于「随机」的范围 —— 这是这个工具最容易做坏的地方，同类工具被用户评价为「接近乱码」：
 * **随机不负责发明结构，只在手写好的结构里摆动**。每个预设的半径、对称数、层序都是人写死的，
 * 种子只能决定「可选图层要不要」「几个二选一的取值」「符文字形」。所以任意两个种子给出的图
 * 都还是同一个体系的东西，而不会跑出一张不知所云的图。
 */

import {
	createCanvas, makeRadiusMap, strokeRing, strokePolyline, strokeDisc, applyGlow
} from './magicShape.js'
import { buildRune, runeBounds } from './magicRunes.js'
import { quantizeFrames } from './colorQuantize.js'
import { encodeGif } from './gifWriter.js'

/** 归一化半径 1 对应画布半径的这个比例。剩下的留白是给辉光的 —— 环画到边上光就出画了。 */
const RADIUS_SPAN = 0.80

/**
 * 辉光蔓延的像素宽度 = GLOW_SPREAD × 缩放系数。
 * 取 0.045 时只有 4 个像素，看起来就是「没有光」—— 光晕要够宽才成立。
 */
const GLOW_SPREAD = 0.22

/**
 * 辉光滑块满值时，光晕最亮处的目标不透明度。
 * 不到 1 是有意的：满值也不该糊成一片实心，留一点让芯线仍然读得出来。
 */
const GLOW_PEAK_MAX = 0.9

/** 配色。数组形式是给光栅化用的，hex 是给 UI 用的。 */
export const MAGIC_COLORS = [
	{ key: 'gold', name: '金', rgb: [255, 199, 89], hex: '#FFC759' },
	{ key: 'cyan', name: '青', rgb: [86, 214, 224], hex: '#56D6E0' },
	{ key: 'violet', name: '紫', rgb: [168, 118, 255], hex: '#A876FF' },
	{ key: 'crimson', name: '绯', rgb: [255, 106, 96], hex: '#FF6A60' },
	{ key: 'jade', name: '翠', rgb: [104, 226, 148], hex: '#68E294' },
	{ key: 'white', name: '白', rgb: [236, 240, 255], hex: '#ECF0FF' }
]

export const MAGIC_LIMITS = {
	// 渲染
	radiusSpan: RADIUS_SPAN,
	previewEdge: 400,
	exportEdges: [720, 1080, 1440],
	exportEdgeDefault: 1080,

	// 动画。帧数与 GIF 边长一起决定量化的像素总量，是内存预算的关键 —— 见 composeCircleGif 的注释。
	frameOptions: [12, 16, 20],
	frameDefault: 16,
	gifEdges: [200, 240, 280],
	gifEdgeDefault: 240,
	delayRange: [4, 20],
	delayDefault: 8,

	// 滑块。lineWidth 的单位是「千分之一个阵半径」，所以线宽不随输出尺寸变化。
	complexityRange: [2, 6],
	complexityDefault: 4,
	lineWidthRange: [8, 60],
	lineWidthDefault: 22,
	glowRange: [0, 100],
	glowDefault: 60,
	runeDensityRange: [0, 100],
	runeDensityDefault: 50,

	colors: MAGIC_COLORS,
	presetKeys: ['pentagram', 'hexagram', 'clock', 'element', 'chaos', 'hallow']
}

/** 32 位整数种子的确定性随机源。**所有随机都必须走它**，否则同种子同图这条就没了。 */
export function createRandom(seed) {
	let state = (seed >>> 0) || 1
	return function () {
		state = (state + 0x6d2b79f5) >>> 0
		let t = state
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

// ---------------------------------------------------------------- 图层构造器
//
// width 是**线宽倍数**而不是绝对宽度：这样线宽滑块一动，整张图的粗细一起变，比例不会散。
// spin 的单位是「每个循环转几整圈」，必须是整数 —— 见 renderFrames 的注释。

function ring(radius, tier, options) {
	const o = options || {}
	return { kind: 'ring', radius, tier, width: o.width || 1, spin: o.spin || 0 }
}

function star(n, k, radius, tier, options) {
	const o = options || {}
	return {
		kind: 'star', n, k, radius, tier,
		width: o.width || 1, spin: o.spin || 0, rotation: o.rotation || 0, dots: !!o.dots
	}
}

function ticks(count, radius, length, tier, options) {
	const o = options || {}
	return {
		kind: 'ticks', count, radius, length, tier,
		width: o.width || 1, spin: o.spin || 0, rotation: o.rotation || 0
	}
}

function runes(count, radius, size, tier, options) {
	const o = options || {}
	return {
		kind: 'runes', count, radius, size, tier,
		width: o.width || 1, spin: o.spin || 0, rotation: o.rotation || 0, seed: o.seed || 0
	}
}

function arcs(count, radius, span, tier, options) {
	const o = options || {}
	return {
		kind: 'arcs', count, radius, span, tier,
		width: o.width || 1, spin: o.spin || 0, rotation: o.rotation || 0
	}
}

const TAU = Math.PI * 2

/**
 * 六个预设。每个 build(rand) 返回图层列表，tier 是「复杂度门槛」——
 * 只有 tier < complexity 的图层会被画出来。tier 0 是骨架，永远在。
 *
 * 每套都要保证至少有一个 spin 非零的图层，否则动画是静止的（测试第 7 节盯着）。
 */
export const MAGIC_PRESETS = {
	pentagram: {
		name: '五芒星',
		colorKey: 'gold',
		build(rand) {
			const inner = rand() < 0.5 ? 0.48 : 0.54
			return [
				ring(1.0, 0, { width: 1.3 }),
				ring(0.96, 1, { width: 0.6 }),
				star(5, 2, 0.84, 0, { width: 1.0, dots: true }),
				ring(0.72, 0, { width: 0.7 }),
				runes(15, 0.63, 0.085, 2, { width: 0.7, spin: -1, seed: 1 }),
				ring(inner, 1, { width: 0.6 }),
				star(5, 1, inner - 0.08, 3, { width: 0.6, spin: 1 })
			]
		}
	},
	hexagram: {
		name: '六芒星',
		colorKey: 'cyan',
		build(rand) {
			return [
				ring(1.0, 0, { width: 1.3 }),
				star(3, 1, 0.88, 0, { width: 1.0, rotation: rand() * 0.2 }),
				star(3, 1, 0.88, 0, { width: 1.0, rotation: Math.PI / 3 }),
				ring(0.74, 1, { width: 0.6 }),
				ticks(12, 0.68, 0.06, 2, { width: 0.6, spin: -1 }),
				ring(0.55, 0, { width: 0.6 }),
				arcs(6, 0.42, TAU / 12, 3, { width: 0.7, spin: 1 })
			]
		}
	},
	clock: {
		name: '时钟',
		colorKey: 'white',
		build(rand) {
			return [
				ring(1.0, 0, { width: 1.3 }),
				ticks(12, 0.88, 0.10, 0, { width: 0.9 }),
				ticks(60, 0.944, 0.032, 1, { width: 0.5, spin: -1 }),
				ring(0.84, 0, { width: 0.6 }),
				runes(12, 0.74, 0.075, 2, { width: 0.6, seed: 2 }),
				ring(0.62, 0, { width: 0.6 }),
				star(12, 5, 0.52, 3, { width: 0.5, spin: 1 })
			]
		}
	},
	element: {
		name: '元素',
		colorKey: 'jade',
		build(rand) {
			const tilt = rand() * 0.3
			return [
				ring(1.0, 0, { width: 1.2 }),
				star(4, 1, 0.88, 0, { width: 1.0, rotation: Math.PI / 4 + tilt, dots: true }),
				arcs(4, 0.76, TAU / 8, 1, { width: 0.8, spin: -1 }),
				ring(0.66, 0, { width: 0.6 }),
				star(4, 1, 0.52, 2, { width: 0.7, rotation: tilt }),
				runes(8, 0.42, 0.07, 3, { width: 0.6, spin: -1, seed: 3 })
			]
		}
	},
	chaos: {
		name: '混沌',
		colorKey: 'violet',
		build(rand) {
			return [
				ring(1.0, 0, { width: 1.2 }),
				ring(0.90, 1, { width: 0.5 }),
				star(7, 3, 0.86, 0, { width: 0.9, spin: 1 }),
				runes(21, 0.70, 0.075, 2, { width: 0.6, spin: -1, seed: 4 }),
				ring(0.62, 0, { width: 0.6 }),
				star(7, 2, 0.54, 1, { width: 0.7, spin: -1 }),
				ring(0.36, 3, { width: 0.5 }),
				arcs(7, 0.30, TAU / 14, 3, { width: 0.6, spin: 2 })
			]
		}
	},
	hallow: {
		name: '圣光',
		colorKey: 'white',
		build(rand) {
			return [
				ring(1.0, 0, { width: 1.4 }),
				ring(0.945, 0, { width: 0.5 }),
				star(8, 3, 0.86, 0, { width: 1.0 }),
				ring(0.78, 1, { width: 0.5 }),
				star(8, 1, 0.72, 2, { width: 0.6, spin: -1 }),
				ring(0.60, 0, { width: 0.6 }),
				runes(16, 0.51, 0.07, 3, { width: 0.6, spin: 1, seed: 5 }),
				ring(0.40, 1, { width: 0.5 }),
				star(4, 1, 0.28, 3, { width: 0.6, spin: 2 })
			]
		}
	}
}

/** 把外部传进来的参数夹到合法范围并补齐默认值。fallbackColorIndex 通常来自预设推荐的配色。 */
export function normalizeParams(input, fallbackColorIndex = 0) {
	const p = input || {}
	const clamp = function (value, low, high, fallback) {
		const n = Number(value)
		if (!Number.isFinite(n)) return fallback
		return Math.min(high, Math.max(low, Math.round(n)))
	}

	const colorIndex = Number.isInteger(p.colorIndex) && p.colorIndex >= 0 && p.colorIndex < MAGIC_COLORS.length
		? p.colorIndex
		: fallbackColorIndex

	return {
		complexity: clamp(p.complexity, MAGIC_LIMITS.complexityRange[0], MAGIC_LIMITS.complexityRange[1], MAGIC_LIMITS.complexityDefault),
		lineWidth: clamp(p.lineWidth, MAGIC_LIMITS.lineWidthRange[0], MAGIC_LIMITS.lineWidthRange[1], MAGIC_LIMITS.lineWidthDefault),
		glow: clamp(p.glow, MAGIC_LIMITS.glowRange[0], MAGIC_LIMITS.glowRange[1], MAGIC_LIMITS.glowDefault),
		runeDensity: clamp(p.runeDensity, MAGIC_LIMITS.runeDensityRange[0], MAGIC_LIMITS.runeDensityRange[1], MAGIC_LIMITS.runeDensityDefault),
		colorIndex
	}
}

/**
 * 预设 + 种子 + 参数 → 整张图的描述（纯数据）。
 * 这一步不做任何渲染，所以可以单独测它的结构（层数、半径是否落在阶梯上、有没有转速）。
 */
export function createFigure({ presetKey, seed, params }) {
	const preset = MAGIC_PRESETS[presetKey]
	if (!preset) throw new Error('未知的魔法阵预设：' + presetKey)

	// 换预设时颜色跟着走，除非调用方明确指定了 colorIndex
	const presetColor = MAGIC_COLORS.findIndex(function (c) { return c.key === preset.colorKey })
	const resolved = normalizeParams(params, presetColor >= 0 ? presetColor : 0)
	const rand = createRandom(seed)
	const all = preset.build(rand)

	const layers = []
	for (let i = 0; i < all.length; i++) {
		if (all[i].tier < resolved.complexity) layers.push(all[i])
	}

	// 符文密度：预设给的是基准条数，滑块按 0~2 倍缩放。至少留 3 个，
	// 否则环节上只剩孤零零一两个字符，看起来像漏画了。
	const densityFactor = resolved.runeDensity / MAGIC_LIMITS.runeDensityDefault
	for (let i = 0; i < layers.length; i++) {
		if (layers[i].kind === 'runes') {
			layers[i].count = Math.max(3, Math.round(layers[i].count * densityFactor))
			// 把阵的种子混进符文的种子。不混的话同一预设的所有种子会长出同一批符文 ——
			// 环和星变了、字符没变，一眼能看出来。
			layers[i].seed = (Math.imul(layers[i].seed, 7919) + (seed >>> 0)) >>> 0
		}
	}

	return {
		presetKey,
		presetName: preset.name,
		seed: seed >>> 0,
		params: resolved,
		color: MAGIC_COLORS[resolved.colorIndex].rgb,
		layers,
		// 统计数字给诊断面板用，不参与渲染
		stats: {
			layerCount: layers.length,
			runeCount: layers.reduce(function (sum, layer) { return sum + (layer.kind === 'runes' ? layer.count : 0) }, 0),
			spinningLayers: layers.filter(function (layer) { return layer.spin !== 0 }).length
		}
	}
}

// ---------------------------------------------------------------- 渲染

/** 图层当前的旋转角。time 是循环相位（0~1）。 */
function layerAngle(layer, time) {
	return (layer.rotation || 0) + layer.spin * TAU * time
}

function polarPoints(cx, cy, radius, angles) {
	const points = []
	for (let i = 0; i < angles.length; i++) {
		points.push([cx + radius * Math.cos(angles[i]), cy + radius * Math.sin(angles[i])])
	}
	return points
}

function drawRing(target, layer, ctx) {
	const halfWidth = ctx.halfWidth * layer.width
	strokeRing(target, {
		radiusMap: ctx.radiusMap,
		radius: layer.radius * ctx.scale,
		halfWidth, color: ctx.color, alpha: layer.alpha || 1
	})
}

function drawStar(target, layer, ctx) {
	const n = layer.n
	const k = layer.k % n
	const base = layerAngle(layer, ctx.time)
	const radius = layer.radius * ctx.scale
	const halfWidth = ctx.halfWidth * layer.width

	// 按 k 步连线。k 与 n 互质时是一笔画到底（n=5/k=2 就是五芒星）；
	// 不互质时会散成 gcd(n,k) 条互不相通的回路（n=6/k=2 是两个三角形），
	// 所以用 used 集合把没走到的顶点各起一条回路，两种情形同一段代码覆盖。
	const step = ((k % n) + n) % n || 1
	const used = new Set()

	for (let start = 0; start < n; start++) {
		if (used.has(start)) continue
		const points = []
		let index = start
		do {
			used.add(index)
			const angle = base + (index * TAU) / n
			points.push([ctx.cx + radius * Math.cos(angle), ctx.cy + radius * Math.sin(angle)])
			index = (index + step) % n
		} while (index !== start && points.length < n)

		strokePolyline(target, { points, closed: true, halfWidth, color: ctx.color, alpha: layer.alpha || 1 })
	}

	if (layer.dots) {
		const dotRadius = Math.max(1, halfWidth * 1.8)
		const angles = []
		for (let i = 0; i < n; i++) angles.push(base + (i * TAU) / n)
		const points = polarPoints(ctx.cx, ctx.cy, radius, angles)
		for (let i = 0; i < points.length; i++) {
			strokeDisc(target, {
				cx: points[i][0], cy: points[i][1], radius: dotRadius,
				color: ctx.color, alpha: layer.alpha || 1
			})
		}
	}
}

function drawTicks(target, layer, ctx) {
	const base = layerAngle(layer, ctx.time)
	const halfWidth = ctx.halfWidth * layer.width
	const inner = layer.radius * ctx.scale
	const outer = (layer.radius + layer.length) * ctx.scale

	for (let i = 0; i < layer.count; i++) {
		const angle = base + (i * TAU) / layer.count
		const cos = Math.cos(angle)
		const sin = Math.sin(angle)
		strokePolyline(target, {
			points: [[ctx.cx + inner * cos, ctx.cy + inner * sin], [ctx.cx + outer * cos, ctx.cy + outer * sin]],
			halfWidth, color: ctx.color, alpha: layer.alpha || 1
		})
	}
}

function drawArcs(target, layer, ctx) {
	const base = layerAngle(layer, ctx.time)
	const halfWidth = ctx.halfWidth * layer.width
	const radius = layer.radius * ctx.scale
	const steps = 8

	for (let i = 0; i < layer.count; i++) {
		const start = base + (i * TAU) / layer.count
		const points = []
		for (let s = 0; s <= steps; s++) {
			const angle = start + (layer.span * s) / steps
			points.push([ctx.cx + radius * Math.cos(angle), ctx.cy + radius * Math.sin(angle)])
		}
		strokePolyline(target, { points, halfWidth, color: ctx.color, alpha: layer.alpha || 1 })
	}
}

function drawRunes(target, layer, ctx) {
	const base = layerAngle(layer, ctx.time)
	const halfWidth = ctx.halfWidth * layer.width
	const rand = createRandom(layer.seed)

	for (let i = 0; i < layer.count; i++) {
		const angle = base + (i * TAU) / layer.count
		const cos = Math.cos(angle)
		const sin = Math.sin(angle)
		const strokes = buildRune(rand)
		const bounds = runeBounds(strokes)

		// 按墨迹高度把符文缩放到 size（阵半径的比例），宽度按同一比例走 ——
		// 所以是一套「等高不等宽」的字符，而不是被拉成一样宽。
		const inkHeight = Math.max(0.01, bounds.maxY - bounds.minY)
		const glyphScale = (layer.size / inkHeight) * ctx.scale
		const midU = (bounds.minX + bounds.maxX) / 2
		const midV = (bounds.minY + bounds.maxY) / 2

		for (let s = 0; s < strokes.length; s++) {
			const points = []
			for (let p = 0; p < strokes[s].length; p++) {
				// 局部 x 沿切向，局部 y 沿径向；符文顶端（局部 y 小）朝外，像站在环上向外看。
				const tangential = (strokes[s][p][0] - midU) * glyphScale
				const radial = layer.radius * ctx.scale + (midV - strokes[s][p][1]) * glyphScale
				points.push([
					ctx.cx + radial * cos - tangential * sin,
					ctx.cy + radial * sin + tangential * cos
				])
			}
			strokePolyline(target, { points, halfWidth, color: ctx.color, alpha: layer.alpha || 1 })
		}
	}
}

const DRAWERS = { ring: drawRing, star: drawStar, ticks: drawTicks, runes: drawRunes, arcs: drawArcs }

/**
 * 渲染一帧。time 是循环相位（0~1）：0 和 1 必须给出逐字节相同的结果，
 * 这是「循环无缝」的定义，由整数 spin 保证（见 renderFrames）。
 */
export function renderFigure(figure, { size, time = 0 }) {
	const width = Math.max(8, Math.round(size))
	const scale = (width / 2) * RADIUS_SPAN
	const params = figure.params

	const canvas = createCanvas({ size: width })
	const ctx = {
		cx: (width - 1) / 2,
		cy: (width - 1) / 2,
		scale,
		radiusMap: makeRadiusMap(width),
		// lineWidth 的单位是千分之一个阵半径，所以线宽不随输出尺寸漂移
		halfWidth: (params.lineWidth / 1000) * scale / 2,
		color: figure.color,
		time
	}

	for (let i = 0; i < figure.layers.length; i++) {
		const layer = figure.layers[i]
		const draw = DRAWERS[layer.kind]
		if (draw) draw(canvas, layer, ctx)
	}

	if (params.glow <= 0) return canvas

	return applyGlow({
		image: canvas,
		color: figure.color,
		peak: (params.glow / 100) * GLOW_PEAK_MAX,
		radius: GLOW_SPREAD * scale
	})
}

/**
 * 铺开一整个循环的帧。
 *
 * **每层的 spin 是整数圈/循环，这是循环无缝的构造性保证** —— 循环走完时每层都恰好转了
 * 整数圈，于是回到起点必然逐字节相同，不需要任何额外的对齐或混合。非整数转速会让
 * 首尾帧差出一个角度，接缝处会看到一跳。测试第 7 节盯着这一条。
 */
export function renderFrames(figure, { size, frames, phaseOffset = 0 }) {
	const count = Math.max(1, Math.round(frames))
	const out = []
	for (let i = 0; i < count; i++) {
		out.push(renderFigure(figure, { size, time: i / count + phaseOffset }))
	}
	return out
}

/**
 * 帧 → 量化 → GIF 字节。
 *
 * **调用方必须先把帧压到不透明底上**（本项目用 imageGeometry.composite 压黑底）：
 * GIF 只有开关式的透明，没有半透明，而辉光是一整片 alpha 从 0 渐变的像素。
 * 带着透明去量化，alphaThreshold（默认 128）会把光晕拦腰截断成一圈硬边，
 * 比不做辉光还难看。这不是可以调参数绕过去的问题，是格式本身装不下。
 *
 * 另外这里要留意量化的内存：quantizeFrames 会为**所有帧的每一个不透明像素**建一个
 * 三元组数组。240² × 16 帧就是约 92 万像素 / 276 万个数组元素，是摸头表情的 15 倍。
 * 所以帧数和边长都卡得比较保守，别再往上调而不实测。
 */
export function composeCircleGif({ frames, delayCs, loop = 0, maxColors = 255 }) {
	if (!frames || !frames.length) throw new Error('没有可编码的帧')

	const quantized = quantizeFrames(frames, maxColors)
	const bytes = encodeGif({
		width: frames[0].width,
		height: frames[0].height,
		frames: quantized.frames,
		palette: quantized.palette,
		transparentIndex: quantized.transparentIndex,
		delayCs,
		loop
	})

	return {
		bytes,
		palette: quantized.palette,
		transparentIndex: quantized.transparentIndex,
		frameCount: frames.length
	}
}
