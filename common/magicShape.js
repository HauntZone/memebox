/**
 * 魔法阵的光栅化原语：纯逻辑，不含任何 uni API、DOM 或平台判断。
 *
 * 这里只认「像素坐标 + 颜色」，不认识魔法阵 —— 圆环 / 星形 / 刻度 / 符文带这些图元
 * 由 magicCircle.js 组装。所有坐标都是**像素单位**，归一化坐标到像素的换算也在那边做。
 *
 * 刻意不写画线算法，而是**距离场 + 覆盖率抗锯齿**：每像素算出到图元的距离 d，
 * 覆盖率取 clamp(halfWidth + 0.5 - d, 0, 1)，也就是一条 1px 宽的线性斜坡。
 * 这么做有两个好处：边缘是平滑的（不是锯齿），而且覆盖率对面积是可加的 ——
 * 「一条已知长度的线，覆盖率总和 ≈ 长度 × 线宽」这条面积守恒是抗锯齿写错了就会立刻
 * 暴露的判据，magicCircle.test.mjs 第 2 节盯着它。
 *
 * 合成一律走 source-over（非预乘，0~255 直通值）。注意这意味着半透明的线互相重叠时
 * 交点会变深，这是标准行为、不是 bug；线条默认 alpha = 1 时不会有这个观感。
 */

/** 数值夹取到 [0, 1]。 */
export function clamp01(value) {
	if (value < 0) return 0
	if (value > 1) return 1
	return value
}

/** 取整并保证至少为 1，用于尺寸。 */
function sizeOf(value) {
	return Math.max(1, Math.round(value) || 0)
}

/**
 * 新建一张正方形 RGBA 画布。
 * background 为 null 时全透明（魔法阵的默认产物）；给了 [r,g,b] 就填成不透明底色。
 */
export function createCanvas({ size, background = null }) {
	const width = sizeOf(size)
	const data = new Uint8ClampedArray(width * width * 4)

	if (background) {
		for (let p = 0; p < data.length; p += 4) {
			data[p] = background[0]
			data[p + 1] = background[1]
			data[p + 2] = background[2]
			data[p + 3] = 255
		}
	}

	return { width, height: width, data }
}

/**
 * 每像素到画布中心的距离表。
 *
 * 圆环都是同心的，共用这一张表之后单个环就退化成 |rMap[i] - radius| 一次减法和一次
 * 绝对值，省掉每环每像素一次 hypot。整张表只算一次，摊到十几个环上很划算。
 */
export function makeRadiusMap(size) {
	const n = sizeOf(size)
	const map = new Float32Array(n * n)
	const center = (n - 1) / 2

	for (let y = 0; y < n; y++) {
		const dy = y - center
		const row = y * n
		for (let x = 0; x < n; x++) {
			const dx = x - center
			map[row + x] = Math.sqrt(dx * dx + dy * dy)
		}
	}

	return map
}

/**
 * source-over 合成一个像素。sa 是已经乘过图层 alpha 的源不透明度（0~1）。
 * 目标像素假设是非预乘的直通值。
 */
function blendPixel(data, p, r, g, b, sa) {
	if (sa <= 0) return

	const da = data[p + 3] / 255
	const outA = sa + da * (1 - sa)
	if (outA <= 0) return

	const keep = da * (1 - sa)
	data[p] = (r * sa + data[p] * keep) / outA
	data[p + 1] = (g * sa + data[p + 1] * keep) / outA
	data[p + 2] = (b * sa + data[p + 2] * keep) / outA
	data[p + 3] = outA * 255
}

/** 把 [0,1] 之外的值夹回去，给坐标取整用。 */
function clampIndex(value, n) {
	if (value < 0) return 0
	if (value > n - 1) return n - 1
	return value
}

/**
 * 描一个圆环（描边，不是实心圆）。
 *
 * 只遍历环的**水平跨度**：每一行先算出环在该行的外边界，若内边界在该行也存在，
 * 就跳过中间那段空档。所以代价正比于环的面积而不是画布面积 —— 1440² 上这一点很要紧。
 */
export function strokeRing(target, { radiusMap, radius, halfWidth, color, alpha = 1 }) {
	const n = target.width

	// 尺寸对不上会读到 undefined，NaN 一路传进 Uint8ClampedArray 会被静默夹成 0 ——
	// 结果是「画出来什么都没有」而不是报错，所以这里显式拦住。
	if (!radiusMap || radiusMap.length !== n * n) {
		throw new Error('radiusMap 尺寸与画布不符，应由 makeRadiusMap 按同一 size 生成')
	}

	const data = target.data
	const center = (n - 1) / 2
	const reach = halfWidth + 0.5
	const outer = radius + reach
	const inner = radius - reach
	const r = color[0]
	const g = color[1]
	const b = color[2]

	const yMin = Math.max(0, Math.ceil(center - outer - 1))
	const yMax = Math.min(n - 1, Math.floor(center + outer + 1))

	for (let y = yMin; y <= yMax; y++) {
		const dy = y - center
		const dySq = dy * dy
		const outerSq = outer * outer - dySq
		if (outerSq <= 0) continue

		const row = y * n
		const xOuter = Math.sqrt(outerSq)
		const x0 = Math.max(0, Math.ceil(center - xOuter))
		const x1 = Math.min(n - 1, Math.floor(center + xOuter))

		// 内边界也在这一行时，中间那段是空档，切成左右两段画
		const innerSq = inner * inner - dySq
		if (innerSq > 0) {
			const xInner = Math.sqrt(innerSq)
			const gapStart = Math.max(x0, Math.ceil(center - xInner))
			const gapEnd = Math.min(x1, Math.floor(center + xInner))
			strokeRingSpan(target, row, x0, gapStart - 1, radiusMap, radius, reach, r, g, b, alpha)
			strokeRingSpan(target, row, gapEnd + 1, x1, radiusMap, radius, reach, r, g, b, alpha)
			continue
		}

		strokeRingSpan(target, row, x0, x1, radiusMap, radius, reach, r, g, b, alpha)
	}

	return target
}

/** strokeRing 的一段水平区间。抽出来只是为了不让上面那三层分支糊成一片。 */
function strokeRingSpan(target, row, x0, x1, radiusMap, radius, reach, r, g, b, alpha) {
	const data = target.data
	for (let x = x0; x <= x1; x++) {
		const i = row + x
		const d = Math.abs(radiusMap[i] - radius)
		if (d >= reach) continue
		blendPixel(data, i * 4, r, g, b, (reach - d) * alpha)
	}
}

/**
 * 描一条线段（圆头，两端和沿途都是同一个半宽）。
 *
 * 距离用平方比较来筛掉绝大多数像素，只在真正落在范围内的像素上开方 —— 长线段的
 * 包围盒里绝大多数点都是要丢的，这一条省下的开销很可观。
 */
export function strokeSegment(target, { x0, y0, x1, y1, halfWidth, color, alpha = 1 }) {
	const n = target.width
	const reach = halfWidth + 0.5
	const reachSq = reach * reach

	const minX = Math.max(0, Math.ceil(Math.min(x0, x1) - reach - 1))
	const maxX = Math.min(n - 1, Math.floor(Math.max(x0, x1) + reach + 1))
	const minY = Math.max(0, Math.ceil(Math.min(y0, y1) - reach - 1))
	const maxY = Math.min(n - 1, Math.floor(Math.max(y0, y1) + reach + 1))
	if (minX > maxX || minY > maxY) return target

	const ex = x1 - x0
	const ey = y1 - y0
	const lenSq = ex * ex + ey * ey

	for (let y = minY; y <= maxY; y++) {
		const py = y - y0
		const row = y * n
		for (let x = minX; x <= maxX; x++) {
			const px = x - x0

			let t = 0
			if (lenSq > 0) {
				t = (px * ex + py * ey) / lenSq
				if (t < 0) t = 0
				else if (t > 1) t = 1
			}

			const dx = px - t * ex
			const dy = py - t * ey
			const dSq = dx * dx + dy * dy
			if (dSq >= reachSq) continue

			const d = Math.sqrt(dSq)
			blendPixel(target.data, (row + x) * 4, color[0], color[1], color[2], (reach - d) * alpha)
		}
	}

	return target
}

/** 描一条折线。closed 为真时首尾相连（正多边形、星形多边形都走这条）。 */
export function strokePolyline(target, { points, closed = false, halfWidth, color, alpha = 1 }) {
	if (!points || points.length < 2) return target

	for (let i = 0; i + 1 < points.length; i++) {
		strokeSegment(target, {
			x0: points[i][0], y0: points[i][1],
			x1: points[i + 1][0], y1: points[i + 1][1],
			halfWidth, color, alpha
		})
	}

	if (closed) {
		const last = points[points.length - 1]
		const first = points[0]
		strokeSegment(target, {
			x0: last[0], y0: last[1], x1: first[0], y1: first[1],
			halfWidth, color, alpha
		})
	}

	return target
}

/** 画一个实心圆点（星形多边形的顶点常用）。 */
export function strokeDisc(target, { cx, cy, radius, color, alpha = 1 }) {
	const n = target.width
	const reach = radius + 0.5
	const reachSq = reach * reach

	const minX = Math.max(0, Math.ceil(cx - reach - 1))
	const maxX = Math.min(n - 1, Math.floor(cx + reach + 1))
	const minY = Math.max(0, Math.ceil(cy - reach - 1))
	const maxY = Math.min(n - 1, Math.floor(cy + reach + 1))

	for (let y = minY; y <= maxY; y++) {
		const dy = y - cy
		const row = y * n
		for (let x = minX; x <= maxX; x++) {
			const dx = x - cx
			const dSq = dx * dx + dy * dy
			if (dSq >= reachSq) continue
			const d = Math.sqrt(dSq)
			blendPixel(target.data, (row + x) * 4, color[0], color[1], color[2], (reach - d) * alpha)
		}
	}

	return target
}

/**
 * 一次盒式模糊（先横后纵），滑动窗口，每像素 O(1)。
 *
 * 边界用**夹取**而不是跳过 —— 跳过会让画面边缘的辉光凭空变暗，夹取才是「画面外的像素
 * 等于边缘像素」这个视觉上正确的延拓。
 *
 * 横向是 src → tmp，纵向是 tmp → dst，**三段缓冲不能省**：纵向那半如果边读边写同一张表，
 * 滑动窗口要减掉的那一行已经被自己写过了，和值会被自己的输出污染。横向没这个问题
 * （读 src 写 dst），但纵向读写的都是上一趟的结果，必须借 tmp 隔开。
 */
function boxBlurPass(src, tmp, dst, n, radius) {
	const win = 2 * radius + 1

	for (let y = 0; y < n; y++) {
		const row = y * n
		let sum = 0
		for (let k = -radius; k <= radius; k++) sum += src[row + clampIndex(k, n)]

		for (let x = 0; x < n; x++) {
			tmp[row + x] = sum / win
			sum -= src[row + clampIndex(x - radius, n)]
			sum += src[row + clampIndex(x + radius + 1, n)]
		}
	}

	for (let x = 0; x < n; x++) {
		let sum = 0
		for (let k = -radius; k <= radius; k++) sum += tmp[clampIndex(k, n) * n + x]

		for (let y = 0; y < n; y++) {
			const i = y * n + x
			const value = sum / win
			sum -= tmp[clampIndex(y - radius, n) * n + x]
			sum += tmp[clampIndex(y + radius + 1, n) * n + x]
			dst[i] = value
		}
	}
}

/**
 * 取 alpha 通道做三次盒式模糊，返回 0~1 的浮点数组。
 *
 * 三次盒式是高斯的一个廉价近似（可分离 + 滑动窗口 → 每像素 O(1)），比真卷积便宜
 * 一个数量级，而辉光本来就只需要「像高斯」而不是「等于高斯」。
 * 半径取 radius/3：三次半径 r 的盒式模糊，等效高斯 σ 大致就是 r，所以想要视觉上
 * 蔓延 radius 像素的光晕，每次取 radius/3 就够了。
 */
export function blurAlpha(image, radius, passes = 3) {
	const n = image.width
	const data = image.data
	const r = Math.max(1, Math.round(radius / passes))

	let current = new Float32Array(n * n)
	let other = new Float32Array(n * n)
	const temp = new Float32Array(n * n)

	for (let i = 0, p = 3; i < current.length; i++, p += 4) {
		current[i] = data[p] / 255
	}

	for (let pass = 0; pass < passes; pass++) {
		boxBlurPass(current, temp, other, n, r)
		const swap = current
		current = other
		other = swap
	}

	return current
}

/**
 * 把一张带 alpha 的图 source-over 到另一张上，返回新图（不动入参）。
 */
export function composeOver({ base, top }) {
	const width = base.width
	const height = base.height
	const out = new Uint8ClampedArray(base.data)
	const data = top.data

	for (let p = 0; p < out.length; p += 4) {
		blendPixel(out, p, data[p], data[p + 1], data[p + 2], data[p + 3] / 255)
	}

	return { width, height, data: out }
}

/**
 * 给一张线条图加辉光：模糊它的 alpha 当一层光晕垫在**下面**，原线条压在上面。
 *
 * 垫在下面（而不是盖在上面）是有意的：芯线保持锐利的本色，外圈才是渐隐的光。
 *
 * peak 是光晕最亮处的**目标不透明度**（0~1），而不是一个倍数。这里是按模糊结果的
 * 最大值归一化过去，不是简单地乘一个系数再夹到 1 —— 后者会让光晕在芯线附近整片饱和，
 * 变成「一条更糊的实心线 + 硬边截止」，比不做辉光还难看（踩过一次，量出来的曲线是
 * 255,255,27,0 这种断崖）。归一化之后峰值精确可控，而且中间的渐变关系原样保留。
 */
export function applyGlow({ image, color, peak, radius }) {
	// 没有这道闸，写错的 peak 会一路 NaN 下去、被 Uint8ClampedArray 静默夹成 0 ——
	// 症状是「辉光设了但一点都没有」，而不会报错。
	if (!Number.isFinite(peak)) {
		throw new Error('applyGlow 的 peak 必须是有限数值（0 表示不加辉光）')
	}

	const blurred = blurAlpha(image, radius)
	const n = image.width

	let max = 0
	for (let i = 0; i < blurred.length; i++) {
		if (blurred[i] > max) max = blurred[i]
	}

	const glow = new Uint8ClampedArray(image.data.length)
	if (max <= 0 || peak <= 0) {
		return composeOver({ base: { width: n, height: n, data: glow }, top: image })
	}

	const scale = clamp01(peak) / max
	for (let i = 0, p = 0; i < blurred.length; i++, p += 4) {
		const a = clamp01(blurred[i] * scale)
		if (a <= 0) continue
		glow[p] = color[0]
		glow[p + 1] = color[1]
		glow[p + 2] = color[2]
		glow[p + 3] = a * 255
	}

	return composeOver({
		base: { width: n, height: n, data: glow },
		top: image
	})
}

/**
 * 把一张图按给定颜色压平（丢掉 alpha）。底色是彩色时用它；
 * 纯黑底可以直接用 imageGeometry.composite（那边只支持灰度背景）。
 */
export function flattenOnto(image, color) {
	const out = new Uint8ClampedArray(image.data.length)
	const data = image.data

	for (let p = 0; p < out.length; p += 4) {
		const a = data[p + 3] / 255
		const rest = 1 - a
		out[p] = data[p] * a + color[0] * rest
		out[p + 1] = data[p + 1] * a + color[1] * rest
		out[p + 2] = data[p + 2] * a + color[2] * rest
		out[p + 3] = 255
	}

	return { width: image.width, height: image.height, data: out }
}
