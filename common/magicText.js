/**
 * 文字环的排版：纯逻辑，不涉及渲染，也不含任何 uni API / DOM / 平台判断。
 *
 * 输出的是**归一化坐标**（阵半径 = 1、原点在阵心），不是像素 —— 所以排版可以脱离渲染
 * 单独测，像素换算留给 magicCircle.js。
 *
 * 坐标系和符文带完全一致：字形的「上」朝向**径向外侧**，字形的 x 轴沿切线。
 * 于是整圈文字在顶部正着读、在底部是倒的 —— 这是「文字上朝外」这个视觉语言的常态，
 * 经典魔法阵就是这么排的，不做下半圈翻转。
 *
 * 字形有两种形态，在排版层是同一件事：
 *   stroke —— 矢量描边（ASCII，来自 magicFont.js），直接变换折线
 *   bitmap —— 位图贴图（中文，由平台层光栅化后缓存），交给 stampImage
 * 所以排版层不需要知道字符是英文还是中文。
 */

import { CAP_HEIGHT, MAGIC_FONT, glyphFor, normalizeText } from './magicFont.js'

/** 单个字形的最小/最大步进间距（以字高为 1 的单位），两端各留一点气。 */
const GLYPH_GAP = 2 / CAP_HEIGHT

export const TEXT_LIMITS = {
	maxChars: 40,
	// 半径是归一化值（阵半径 = 1），滑块给整数档
	radiusRange: [30, 100],
	radiusScale: 100,
	radiusDefault: 78,
	// 字高同样是归一化值
	sizeRange: [3, 18],
	sizeScale: 100,
	sizeDefault: 8,
	// 位图字形按这个字高光栅化（像素）。1440 输出下文字大约 60~70px 高，128 足够，
	// 而且往小缩比往大放画质好得多。
	glyphCell: 128
}

/**
 * 把文本拆成字形记录。ASCII 走内置描边字体，其余走平台层光栅化出来的位图缓存，
 * 两者都没有时给一个「缺字」占位 —— 明确画个方框出来，比静默丢掉强。
 *
 * bitmapCache 形如 { 字: {width, height, data} }，可以缺省（那时非 ASCII 全是占位框）。
 */
export function resolveGlyphs(text, bitmapCache) {
	const normalized = normalizeText(text)
	const out = []

	for (let i = 0; i < normalized.length; i++) {
		if (out.length >= TEXT_LIMITS.maxChars) break
		const char = normalized[i]

		const stroke = glyphFor(char)
		if (stroke) {
			out.push({
				kind: 'stroke',
				char,
				strokes: stroke.s,
				// 都换算成「字高 = 1」的单位
				width: stroke.w / CAP_HEIGHT,
				advance: stroke.a / CAP_HEIGHT
			})
			continue
		}

		const bitmap = bitmapCache && bitmapCache[char]
		if (bitmap && bitmap.width > 0 && bitmap.height > 0) {
			const aspect = bitmap.width / bitmap.height
			out.push({
				kind: 'bitmap',
				char,
				image: bitmap,
				width: aspect,
				advance: aspect + GLYPH_GAP
			})
			continue
		}

		out.push({ kind: 'tofu', char, width: 0.5, advance: 0.5 + GLYPH_GAP })
	}

	return out
}

/** 整串文字占用的弧长对应的「直线宽度」（归一化单位）。 */
export function textWidth(glyphs, size) {
	let total = 0
	for (let i = 0; i < glyphs.length; i++) total += glyphs[i].advance * size
	return total
}

/**
 * 把字形沿半径 radius 的圆排开，整体以 rotation（弧度）为中心。
 *
 * 返回 { strokes, stamps, missing, arcSpan, fits }：
 *   strokes —— 折线数组，归一化坐标、相对阵心
 *   stamps  —— { image, cx, cy, width, angle }，同样是归一化坐标；
 *              width 是归一化宽度，渲染时乘缩放系数即可
 *   missing —— 缺字个数（页面上该给个提示）
 *   fits    —— 文字是否还绕得下一圈（超了就会自己压自己，让页面提示用户调小）
 */
export function placeTextOnRing({ glyphs, radius, size, rotation = 0 }) {
	const strokes = []
	const stamps = []
	let missing = 0

	if (!glyphs || !glyphs.length || radius <= 0 || size <= 0) {
		return { strokes, stamps, missing, arcSpan: 0, fits: true }
	}

	const total = textWidth(glyphs, size)
	const arcSpan = total / radius
	const startAngle = rotation - arcSpan / 2
	let walked = 0

	for (let i = 0; i < glyphs.length; i++) {
		const glyph = glyphs[i]

		// 这个字形的中心落在哪条半径线上
		const theta = startAngle + (walked + (glyph.advance * size) / 2) / radius
		const cos = Math.cos(theta)
		const sin = Math.sin(theta)
		walked += glyph.advance * size

		// 局部 (u, v) → 世界：u 沿切线（角度增大方向），v 沿径向（向外为正）
		const toWorld = function (u, v) {
			const r = radius + v
			return [r * cos - u * sin, r * sin + u * cos]
		}

		if (glyph.kind === 'stroke') {
			const scale = size / CAP_HEIGHT
			for (let s = 0; s < glyph.strokes.length; s++) {
				const source = glyph.strokes[s]
				const points = []
				for (let p = 0; p < source.length; p++) {
					// 网格 y 向下，而 v 向外为正，所以要翻过来
					const u = (source[p][0] - glyph.width * CAP_HEIGHT / 2) * scale
					const v = (CAP_HEIGHT / 2 - source[p][1]) * scale
					points.push(toWorld(u, v))
				}
				strokes.push(points)
			}
			continue
		}

		if (glyph.kind === 'bitmap') {
			const scale = size / glyph.image.height
			const center = toWorld(0, 0)
			stamps.push({
				image: glyph.image,
				cx: center[0],
				cy: center[1],
				width: glyph.image.width * scale,
				// 贴图的 +x 转到切线、+y 转到向内 —— 推导见 stampImage 的注释
				angle: theta + Math.PI / 2
			})
			continue
		}

		// 缺字：画一个方框占位，让人一眼看出是没渲染出来，而不是被静默吞掉
		missing++
		const halfW = glyph.width / 2
		const halfH = 0.35
		strokes.push([
			toWorld(-halfW, halfH), toWorld(halfW, halfH),
			toWorld(halfW, -halfH), toWorld(-halfW, -halfH), toWorld(-halfW, halfH)
		])
	}

	return { strokes, stamps, missing, arcSpan, fits: arcSpan <= Math.PI * 1.8 }
}

/** 内置字体覆盖的字符（给 UI 提示用）。 */
export function fontCoverage() {
	return 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -.:·\'/!?,()'
}

/**
 * 这个字符要不要走平台光栅化 —— 即「不是空白，且内置描边字体覆盖不到」。
 * 页面用它决定要往 rasterizeGlyphs 里送哪些字（送内置能画的字是白跑一趟 canvas）。
 */
export function needsBitmap(char) {
	if (!char) return false
	if (char === ' ' || char === '\n' || char === '\t') return false
	return !MAGIC_FONT[normalizeText(char)]
}

// ---------------------------------------------------------------- 字形光栅化的排版
//
// 下面这几个是**纯计算**，放在这里而不是平台层：平台层只负责「把字画到画布上」那一步。
// 这样网格怎么排、格子怎么切、墨迹怎么收紧都可以脱离 canvas 测。

/** 画布上限的自我保护：格子排成网格，别排成一条几千像素的长条。 */
const GLYPH_COLUMNS_MAX = 8

/**
 * 把一串字符排成方格阵列。**方格子、不用 measureText** ——
 * 少一个各端行为不一致的 API，而且中文本来就是方的。
 */
export function planGlyphCanvas(chars, cellSize) {
	const unique = []
	const seen = Object.create(null)
	for (let i = 0; i < chars.length; i++) {
		const c = chars[i]
		if (!c || c === ' ' || c === '\t' || c === '\n') continue
		if (seen[c]) continue
		seen[c] = true
		unique.push(c)
	}

	const cell = Math.max(8, Math.round(cellSize))
	const columns = Math.max(1, Math.min(GLYPH_COLUMNS_MAX, unique.length || 1))
	const rows = Math.max(1, Math.ceil(unique.length / columns))

	return {
		chars: unique,
		cellSize: cell,
		columns,
		rows,
		width: columns * cell,
		height: rows * cell
	}
}

/** 第 index 格的中心点（把字画到哪儿）。 */
export function glyphCellCenter(plan, index) {
	const col = index % plan.columns
	const row = Math.floor(index / plan.columns)
	return {
		x: col * plan.cellSize + plan.cellSize / 2,
		y: row * plan.cellSize + plan.cellSize / 2
	}
}

/**
 * 把画好的整张画布按格子切开，并把每格**收紧到墨迹外接框**。
 *
 * 收紧是必须的：不收紧的话「字高」就等于格子高，而格子里的字只占其中一部分，
 * 中文和英文的大小就对不上了（magicText 是按 `image.height` 当字高来缩放的）。
 * 整格都空的（这一端没有该字形的字体）返回 null，让上层退回占位框 —— 比塞一张
 * 全透明的图诚实。
 */
export function sliceGlyphCells(pixels, plan) {
	const out = Object.create(null)

	for (let i = 0; i < plan.chars.length; i++) {
		const col = i % plan.columns
		const row = Math.floor(i / plan.columns)
		const cropped = cropToInk(
			pixels, plan.width,
			col * plan.cellSize, row * plan.cellSize,
			plan.cellSize
		)
		if (cropped) out[plan.chars[i]] = cropped
	}

	return out
}

/** 把一小块区域按 alpha 收紧到墨迹外接框。返回 null 表示整块都是空的。 */
export function cropToInk(pixels, canvasWidth, left, top, size) {
	let minX = size
	let minY = size
	let maxX = -1
	let maxY = -1

	for (let y = 0; y < size; y++) {
		const row = (top + y) * canvasWidth
		for (let x = 0; x < size; x++) {
			if (pixels[(row + left + x) * 4 + 3] < 8) continue
			if (x < minX) minX = x
			if (x > maxX) maxX = x
			if (y < minY) minY = y
			if (y > maxY) maxY = y
		}
	}

	if (maxX < 0) return null

	const width = maxX - minX + 1
	const height = maxY - minY + 1
	const data = new Uint8ClampedArray(width * height * 4)

	for (let y = 0; y < height; y++) {
		const source = ((top + minY + y) * canvasWidth + left + minX) * 4
		data.set(pixels.subarray(source, source + width * 4), y * width * 4)
	}

	return { width, height, data }
}
