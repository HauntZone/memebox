/**
 * 调色板量化：纯逻辑，不含任何 uni API、DOM 或平台判断。
 *
 * 用中位切分（median cut）把所有帧的不透明像素**一起**量化成一张全局调色板。
 * 为什么不逐帧各配一张局部调色板：摸头表情的五帧只有人脸微移、颜色几乎一样，
 * 逐帧调色板会让同一块脸在不同帧落到略微不同的颜色上，播起来就是一层细密的闪烁。
 * 全局表还省掉四张颜色表，文件更小。
 *
 * 不做 Floyd–Steinberg 抖动：内容是人脸照片 + 硬边手部，抖动收益有限，却会让测试从
 * 「精确重构」退化成「近似」，也会把 GIF 撑大。留作以后的可选项。
 */

/** 频道跨度最大的那个通道：返回 0=R / 1=G / 2=B 以及跨度值。 */
function channelRange(packed, start, end) {
	let rMin = 255
	let rMax = 0
	let gMin = 255
	let gMax = 0
	let bMin = 255
	let bMax = 0
	for (let i = start; i < end; i++) {
		const v = packed[i]
		const r = (v >> 16) & 0xff
		const g = (v >> 8) & 0xff
		const b = v & 0xff
		if (r < rMin) rMin = r
		if (r > rMax) rMax = r
		if (g < gMin) gMin = g
		if (g > gMax) gMax = g
		if (b < bMin) bMin = b
		if (b > bMax) bMax = b
	}
	const dr = rMax - rMin
	const dg = gMax - gMin
	const db = bMax - bMin
	if (dr >= dg && dr >= db) return { channel: 0, range: dr }
	if (dg >= db) return { channel: 1, range: dg }
	return { channel: 2, range: db }
}

function averageColor(packed, start, end) {
	let r = 0
	let g = 0
	let b = 0
	for (let i = start; i < end; i++) {
		const v = packed[i]
		r += (v >> 16) & 0xff
		g += (v >> 8) & 0xff
		b += v & 0xff
	}
	const count = end - start
	return [Math.round(r / count), Math.round(g / count), Math.round(b / count)]
}

/**
 * 中位切分。pixels 是扁平的 RGB 三元组数组（[r,g,b,r,g,b,...]），没有像素时返回单色黑。
 *
 * 每次挑「跨度最大」的桶来切（跨度相同则挑像素多的），桶内按跨度最大的通道排序后从中间劈开。
 * 全程只用整数比较和稳定规则，所以同一份输入永远得到同一张调色板 —— 测试才立得住。
 */
export function medianCut(pixels, maxColors) {
	const limit = Math.max(1, Math.min(256, maxColors | 0))
	const count = Math.floor(pixels.length / 3)
	const packed = new Int32Array(count)
	for (let i = 0, p = 0; i < count; i++, p += 3) {
		packed[i] = ((pixels[p] & 0xff) << 16) | ((pixels[p + 1] & 0xff) << 8) | (pixels[p + 2] & 0xff)
	}
	if (count === 0) return [[0, 0, 0]]

	// 桶只记 packed 上的区间，切分时只排这一段，避免每轮都重建数组
	let buckets = [{ start: 0, end: count }]

	while (buckets.length < limit) {
		let best = -1
		let bestRange = -1
		let bestCount = -1
		for (let i = 0; i < buckets.length; i++) {
			const bucket = buckets[i]
			const bucketCount = bucket.end - bucket.start
			if (bucketCount < 2) continue
			const range = channelRange(packed, bucket.start, bucket.end)
			if (range.range > bestRange || (range.range === bestRange && bucketCount > bestCount)) {
				best = i
				bestRange = range.range
				bestCount = bucketCount
			}
		}
		// 所有桶要么只剩一个像素、要么颜色完全一致，再切也没有意义
		if (best === -1) break

		const bucket = buckets[best]
		const channel = channelRange(packed, bucket.start, bucket.end).channel
		const shift = (2 - channel) * 8
		const slice = packed.subarray(bucket.start, bucket.end)
		slice.sort(function (a, b) {
			return ((a >>> shift) & 0xff) - ((b >>> shift) & 0xff)
		})

		const mid = bucket.start + ((bucket.end - bucket.start) >> 1)
		buckets.splice(best, 1, { start: bucket.start, end: mid }, { start: mid, end: bucket.end })
	}

	const palette = []
	for (let i = 0; i < buckets.length; i++) {
		palette.push(averageColor(packed, buckets[i].start, buckets[i].end))
	}
	return palette
}

/**
 * 找调色板里离 (r,g,b) 最近的一格，返回索引。
 * 用平方距离（省一次开方，比大小等价）；并列时取**最小索引**，保证结果确定。
 */
export function nearestIndex(r, g, b, palette) {
	let best = 0
	let bestDistance = Infinity
	for (let i = 0; i < palette.length; i++) {
		const color = palette[i]
		const dr = r - color[0]
		const dg = g - color[1]
		const db = b - color[2]
		const distance = dr * dr + dg * dg + db * db
		if (distance < bestDistance) {
			bestDistance = distance
			best = i
		}
	}
	return best
}

/**
 * 把若干帧 RGBA 量化成索引帧 + 一张全局调色板。
 *
 * 返回 { palette, frames: Uint8Array[], transparentIndex }。
 * 透明像素（alpha < alphaThreshold）一律映射到 transparentIndex —— GIF 只有开关式的
 * 透明，没有半透明，所以 alpha 只能二值化；阈值取 128 是二分，不是调过的经验值。
 *
 * 调色板最多 255 色，第 256 格留给透明，这样颜色表刚好塞满 2 的幂。
 */
export function quantizeFrames(frames, maxColors = 255, { alphaThreshold = 128 } = {}) {
	if (!frames || !frames.length) throw new Error('没有可量化的帧')
	const limit = Math.max(1, Math.min(255, maxColors | 0))

	const samples = []
	for (let f = 0; f < frames.length; f++) {
		const data = frames[f].data
		for (let p = 0; p < data.length; p += 4) {
			if (data[p + 3] < alphaThreshold) continue
			samples.push(data[p], data[p + 1], data[p + 2])
		}
	}

	const palette = medianCut(samples, limit)
	const transparentIndex = palette.length < 256 ? palette.length : 255

	// 手部素材是大片纯色，同一颜色会反复问很多次；照片部分则基本一问一个准。
	// 缓存对前者省掉绝大部分计算，对后者最多长到「不同颜色数」，不会失控。
	const cache = new Map()
	const indexed = []

	for (let f = 0; f < frames.length; f++) {
		const data = frames[f].data
		const out = new Uint8Array(data.length / 4)
		for (let i = 0, p = 0; i < out.length; i++, p += 4) {
			if (data[p + 3] < alphaThreshold) {
				out[i] = transparentIndex
				continue
			}
			const r = data[p]
			const g = data[p + 1]
			const b = data[p + 2]
			const key = (r << 16) | (g << 8) | b
			let index = cache.get(key)
			if (index === undefined) {
				index = nearestIndex(r, g, b, palette)
				cache.set(key, index)
			}
			out[i] = index
		}
		indexed.push(out)
	}

	return { palette, frames: indexed, transparentIndex }
}
