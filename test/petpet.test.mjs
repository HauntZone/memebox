/**
 * 摸头表情（petpet）纯逻辑部分的回归测试。
 *
 * 跑法见 test/README.md —— 复制到临时目录后用 VS Code 自带的 Electron 当 node 跑，
 * 也可以在装了 node 的机器上直接 `node petpet.test.mjs`。
 *
 * 这里的 LZW 解码器和 GIF 解析器都是**从解码端独立写的**，不是把编码器倒过来抄一遍：
 * lzwEncode 的位序和码长升降是最容易错的地方，只有独立实现的解码器能证伪它。
 */
import { resizeStretchImage, pasteOver, flipHorizontal } from './imageGeometry.js'
import { faceRect, buildFrames, composeGif, avatarReadEdge, PETPET_LIMITS } from './petpet.js'
import { medianCut, nearestIndex, quantizeFrames } from './colorQuantize.js'
import { lzwEncode, packSubBlocks, encodeGif } from './gifWriter.js'
import { getHands, base64ToBytes, HAND_PNG_B64 } from './petpetHands.js'

let pass = 0
let fail = 0
function ok(name, cond, extra) {
	if (cond) {
		pass++
		console.log('  PASS  ' + name)
	} else {
		fail++
		console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : ''))
	}
}
function eq(name, actual, expected) {
	ok(name + ' = ' + expected, actual === expected, 'got ' + actual)
}
function near(name, actual, expected, tolerance) {
	ok(name + ' ≈ ' + expected + ' (±' + tolerance + ')', Math.abs(actual - expected) <= tolerance, 'got ' + actual)
}

// ---------------------------------------------------------------- 工具

function makeImage(width, height, fn) {
	const data = new Uint8ClampedArray(width * height * 4)
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const p = (y * width + x) * 4
			const color = fn(x, y)
			data[p] = color[0]
			data[p + 1] = color[1]
			data[p + 2] = color[2]
			data[p + 3] = color.length > 3 ? color[3] : 255
		}
	}
	return { width, height, data }
}

function blankImage(width, height) {
	return { width, height, data: new Uint8ClampedArray(width * height * 4) }
}

function pixelAt(image, x, y) {
	const p = (y * image.width + x) * 4
	return [image.data[p], image.data[p + 1], image.data[p + 2], image.data[p + 3]]
}

/** 不透明像素的外接矩形，用来断言「贴到哪儿、多大、有没有被裁」。 */
function opaqueBounds(image) {
	let minX = Infinity
	let minY = Infinity
	let maxX = -1
	let maxY = -1
	for (let y = 0; y < image.height; y++) {
		for (let x = 0; x < image.width; x++) {
			if (image.data[(y * image.width + x) * 4 + 3] > 0) {
				if (x < minX) minX = x
				if (x > maxX) maxX = x
				if (y < minY) minY = y
				if (y > maxY) maxY = y
			}
		}
	}
	return { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 }
}

/** 固定种子的线性同余，保证测试可复现。 */
function makeRandom(seed) {
	let state = seed >>> 0
	return function () {
		state = (state * 1664525 + 1013904223) >>> 0
		return state / 4294967296
	}
}

/** 合成一个「手」素材：全透明，只有一块 2x2 的不透明标记。 */
function makeHand(size, markerX, markerY, color) {
	const hand = blankImage(size, size)
	for (let y = 0; y < 2; y++) {
		for (let x = 0; x < 2; x++) {
			const px = markerX + x
			const py = markerY + y
			if (px >= size || py >= size) continue
			const p = (py * size + px) * 4
			hand.data[p] = color[0]
			hand.data[p + 1] = color[1]
			hand.data[p + 2] = color[2]
			hand.data[p + 3] = 255
		}
	}
	return hand
}

/**
 * 独立实现的 GIF LZW 解码器（从解码端写的，刻意不复用编码器的任何逻辑）。
 * 解码器的建表比编码器慢一格，这正是码长升降容易错位的地方。
 */
function lzwDecode(bytes, minCodeSize) {
	const clearCode = 1 << minCodeSize
	const endCode = clearCode + 1
	let codeSize = minCodeSize + 1
	let table = []

	function resetTable() {
		table = []
		for (let i = 0; i < clearCode; i++) table.push([i])
		table.push(null) // clear
		table.push(null) // end
	}
	resetTable()

	let bitPos = 0
	function readCode() {
		let code = 0
		for (let i = 0; i < codeSize; i++) {
			const byteIndex = bitPos >> 3
			if (byteIndex >= bytes.length) return -1
			code |= ((bytes[byteIndex] >> (bitPos & 7)) & 1) << i
			bitPos++
		}
		return code
	}

	const out = []
	let prev = null
	for (;;) {
		const code = readCode()
		if (code === -1) break
		if (code === clearCode) {
			resetTable()
			codeSize = minCodeSize + 1
			prev = null
			continue
		}
		if (code === endCode) break

		let entry
		if (code < table.length && table[code]) {
			entry = table[code]
		} else if (prev !== null && code === table.length) {
			entry = prev.concat([prev[0]]) // KwKwK：码还没进表
		} else {
			throw new Error('非法 LZW 码 ' + code + '（表长 ' + table.length + '）')
		}

		for (let i = 0; i < entry.length; i++) out.push(entry[i])

		if (prev !== null) {
			table.push(prev.concat([entry[0]]))
			if (table.length === 1 << codeSize && codeSize < 12) codeSize++
		}
		prev = entry
	}
	return out
}

/** 读出 GIF 的一个数据子块序列，返回拼好的数据和下一个位置。 */
function readSubBlocks(bytes, pos) {
	const data = []
	while (pos < bytes.length && bytes[pos] !== 0) {
		const length = bytes[pos]
		pos++
		for (let i = 0; i < length; i++) data.push(bytes[pos + i])
		pos += length
	}
	return { data: Uint8Array.from(data), pos: pos + 1 }
}

/** 独立实现的 GIF89a 解析器，顺带把每帧像素解出来。 */
function parseGif(bytes) {
	const readUint16 = (pos) => bytes[pos] | (bytes[pos + 1] << 8)
	let pos = 0
	const signature = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5])
	pos = 6

	const width = readUint16(pos)
	const height = readUint16(pos + 2)
	const packed = bytes[pos + 4]
	const hasGct = (packed & 0x80) !== 0
	const gctSize = 1 << ((packed & 0x07) + 1)
	const backgroundIndex = bytes[pos + 5]
	pos += 7

	let gct = null
	if (hasGct) {
		gct = []
		for (let i = 0; i < gctSize; i++) {
			gct.push([bytes[pos], bytes[pos + 1], bytes[pos + 2]])
			pos += 3
		}
	}

	const frames = []
	let loop = null
	let sawTrailer = false

	while (pos < bytes.length) {
		const marker = bytes[pos]
		if (marker === 0x3b) {
			sawTrailer = true
			break
		}
		if (marker === 0x21) {
			const label = bytes[pos + 1]
			if (label === 0xf9) {
				const blockSize = bytes[pos + 2]
				if (blockSize !== 4) throw new Error('GCE 块长度不是 4：' + blockSize)
				const gcePacked = bytes[pos + 3]
				frames.push({
					disposal: (gcePacked >> 2) & 0x07,
					transparentFlag: (gcePacked & 0x01) === 1,
					delay: readUint16(pos + 4),
					transparentIndex: bytes[pos + 6]
				})
				pos += 8
			} else if (label === 0xff) {
				const size = bytes[pos + 2]
				const name = String.fromCharCode.apply(null, Array.from(bytes.slice(pos + 3, pos + 3 + size)))
				pos += 3 + size
				const sub = readSubBlocks(bytes, pos)
				pos = sub.pos
				if (name === 'NETSCAPE2.0') loop = sub.data[1] | (sub.data[2] << 8)
			} else {
				pos += 2
				const sub = readSubBlocks(bytes, pos)
				pos = sub.pos
			}
			continue
		}
		if (marker === 0x2c) {
			const left = readUint16(pos + 1)
			const top = readUint16(pos + 3)
			const fw = readUint16(pos + 5)
			const fh = readUint16(pos + 7)
			const imagePacked = bytes[pos + 9]
			if (imagePacked & 0x80) throw new Error('这里不该出现局部颜色表')
			pos += 10
			const minCodeSize = bytes[pos]
			pos++
			const sub = readSubBlocks(bytes, pos)
			pos = sub.pos
			const indices = lzwDecode(sub.data, minCodeSize)
			frames[frames.length - 1].left = left
			frames[frames.length - 1].top = top
			frames[frames.length - 1].width = fw
			frames[frames.length - 1].height = fh
			frames[frames.length - 1].minCodeSize = minCodeSize
			frames[frames.length - 1].indices = indices
			continue
		}
		throw new Error('无法识别的 GIF 块标记 0x' + marker.toString(16) + ' @' + pos)
	}

	return { signature, width, height, hasGct, gctSize, gct, backgroundIndex, loop, frames, sawTrailer }
}

// ================================================================ 1. 手部素材

console.log('\n== 1. 手部素材（base64 内嵌） ==')
{
	eq('内嵌了 5 帧', HAND_PNG_B64.length, 5)

	const sample = base64ToBytes('aGVsbG8=')
	eq('base64 解出 hello 的长度', sample.length, 5)
	eq('base64 首字节', sample[0], 0x68)
	eq('base64 忽略换行', base64ToBytes('aGVs\nbG8=').length, 5)
	eq('空串解出空数组', base64ToBytes('').length, 0)

	const hands = getHands()
	eq('getHands 返回 5 帧', hands.length, 5)
	let allDecoded = true
	let allSquare = true
	for (let i = 0; i < hands.length; i++) {
		if (!hands[i] || !hands[i].data) allDecoded = false
		else if (hands[i].width !== PETPET_LIMITS.handCanvas || hands[i].height !== PETPET_LIMITS.handCanvas) {
			allSquare = false
		}
	}
	ok('五帧都能被 decodePng 解开（否则素材格式要重转）', allDecoded)
	ok('五帧都是 ' + PETPET_LIMITS.handCanvas + '×' + PETPET_LIMITS.handCanvas, allSquare)
	eq('getHands 缓存同一份', getHands(), hands)

	// 素材必须真的带透明区，否则贴上去会是一张实心方块
	let transparent = 0
	for (let p = 3; p < hands[0].data.length; p += 4) if (hands[0].data[p] === 0) transparent++
	ok('第 0 帧有透明像素（是带 alpha 的手）', transparent > 0, transparent)
}

// ================================================================ 2. resizeStretchImage

console.log('\n== 2. 非等比拉伸 ==')
{
	const source = makeImage(4, 4, (x) => [x * 60, 0, 0])

	const same = resizeStretchImage(source, 4, 4)
	eq('同尺寸返回同尺寸', same.width, 4)
	ok('同尺寸是拷贝而不是同一个数组', same.data !== source.data)
	eq('同尺寸像素一致', same.data[0], source.data[0])

	const stretched = resizeStretchImage(source, 8, 2)
	eq('拉伸后宽度', stretched.width, 8)
	eq('拉伸后高度', stretched.height, 2)
	eq('拉伸后像素数', stretched.data.length, 8 * 2 * 4)

	// 横向拉 2 倍：目标第 0 列取源第 0 列，最后一列取源第 3 列
	eq('左端对齐源首像素', pixelAt(stretched, 0, 0)[0], 0)
	eq('右端对齐源末像素', pixelAt(stretched, 7, 0)[0], 180)
	// 纵向压 2 倍：上下两行都应当有值，不能只留一行
	ok('纵向压缩后两行都有像素', pixelAt(stretched, 1, 1)[3] === 255)

	const single = resizeStretchImage(source, 1, 1)
	eq('退化成 1×1 不除零', single.data.length, 4)
	eq('1×1 取的是首像素', single.data[0], 0)

	eq('参数不合法返回 null', resizeStretchImage(null, 4, 4), null)
	eq('尺寸为 0 返回 null', resizeStretchImage(source, 0, 4), null)
}

// ================================================================ 3. pasteOver

console.log('\n== 3. 双图叠加（非预乘） ==')
{
	const base = blankImage(4, 4)
	const opaque = makeImage(2, 2, () => [200, 100, 50])
	const pasted = pasteOver({ base, top: opaque, x: 1, y: 1 })

	eq('叠加不改画布尺寸', pasted.width, 4)
	eq('(0,0) 仍是透明', pixelAt(pasted, 0, 0)[3], 0)
	eq('贴入位置的颜色', pixelAt(pasted, 1, 1)[0], 200)
	eq('贴入位置的 alpha', pixelAt(pasted, 1, 1)[3], 255)
	eq('入参 base 未被修改', base.data[((1 * 4 + 1) * 4) + 3], 0)

	// 半透明 50% 白叠在纯黑上：非预乘的结果应当是最亮通道接近 128 的灰
	const blackBase = makeImage(1, 1, () => [0, 0, 0, 255])
	const halfWhite = makeImage(1, 1, () => [255, 255, 255, 128])
	const blended = pasteOver({ base: blackBase, top: halfWhite, x: 0, y: 0 })
	near('半透明白叠黑：红通道约 128', pixelAt(blended, 0, 0)[0], 128, 2)
	eq('完全不透明（结果 alpha 255）', pixelAt(blended, 0, 0)[3], 255)

	// 全透明叠上去应当原样保留底层
	const keep = pasteOver({ base: blackBase, top: blankImage(1, 1), x: 0, y: 0 })
	eq('全透明不改变底层', pixelAt(keep, 0, 0)[0], 0)

	// 越界：参考实现第 2 帧 8 + 110 = 118 > 112，靠裁剪复现 PIL paste
	const wide = makeImage(10, 1, () => [10, 20, 30])
	const clipped = pasteOver({ base: blankImage(4, 1), top: wide, x: 2, y: 0 })
	eq('越界被裁掉：只剩 2 列', opaqueBounds(clipped).width, 2)
	// x = -5 时源的第 5~8 列落到画布的 0~3 列，只有 4 个像素可见
	eq('负偏移也按越界裁剪', pasteOver({ base: blankImage(4, 1), top: wide, x: -5, y: 0 }).data.filter((v, i) => i % 4 === 3 && v > 0).length, 4)

	// oa = 0 的分支：两层都是全透明
	const zero = pasteOver({ base: blankImage(1, 1), top: blankImage(1, 1), x: 0, y: 0 })
	eq('两层全透明输出 alpha 0', pixelAt(zero, 0, 0)[3], 0)
	eq('两层全透明输出 rgb 0', pixelAt(zero, 0, 0)[0], 0)
}

// ================================================================ 4. flipHorizontal

console.log('\n== 4. 水平镜像 ==')
{
	const image = makeImage(3, 1, (x) => [x * 10, 0, 0])
	const flipped = flipHorizontal(image)
	eq('镜像后尺寸不变', flipped.width, 3)
	eq('首像素变成原来的末像素', pixelAt(flipped, 0, 0)[0], 20)
	eq('末像素变成原来的首像素', pixelAt(flipped, 2, 0)[0], 0)
	eq('镜像两次回到原图', pixelAt(flipHorizontal(flipped), 0, 0)[0], 0)
	eq('原图未被修改', pixelAt(image, 0, 0)[0], 0)
}

// ================================================================ 5. faceRect 契约

console.log('\n== 5. faceRect 契约 ==')
{
	const locs = PETPET_LIMITS.locs

	let equalsLocs = true
	for (let i = 0; i < locs.length; i++) {
		const rect = faceRect(i, { squish: 1, size: 1 })
		if (rect.x !== locs[i][0] || rect.y !== locs[i][1] || rect.w !== locs[i][2] || rect.h !== locs[i][3]) {
			equalsLocs = false
			console.log('        帧 ' + i + ' -> ' + JSON.stringify(rect))
		}
	}
	ok('squish=1,size=1 逐帧精确等于参考实现的 locs', equalsLocs)

	// 以 h0 为方形基准：squish=0 时宽度收到高度，高度不变，中心不动
	let squareAtZero = true
	let centerKept = true
	for (let i = 0; i < locs.length; i++) {
		const rect = faceRect(i, { squish: 0, size: 1 })
		if (rect.w !== locs[i][3] || rect.h !== locs[i][3]) squareAtZero = false
		if (Math.abs(rect.x + rect.w / 2 - (locs[i][0] + locs[i][2] / 2)) > 1e-9) centerKept = false
		if (Math.abs(rect.y + rect.h / 2 - (locs[i][1] + locs[i][3] / 2)) > 1e-9) centerKept = false
	}
	ok('squish=0 时每帧都收缩成 h0×h0 的方形', squareAtZero)
	ok('squish=0 时中心仍在原矩形中心', centerKept)

	// 回归护栏：曾经把方形基准写成 max(w0,h0)，而五帧的 w0 本来就都 ≥ h0，
	// 结果 squish 恒等于 w0、整个参数是死的。这里钉住「squish 必须真的起作用」。
	const s0 = faceRect(1, { squish: 0 })
	const s1 = faceRect(1, { squish: 1 })
	eq('squish 真的改变宽度（第 1 帧 85 vs 101）', s0.w + '/' + s1.w, '85/101')
	ok('squish 中间档落在两端之间', faceRect(1, { squish: 0.5 }).w === 93)

	// 第 0/4 帧本来就正方，对 squish 不敏感是正确的
	eq('第 0 帧本就是正方，squish=0 宽度不变', faceRect(0, { squish: 0 }).w, 98)

	const half = faceRect(2, { squish: 1, size: 0.5 })
	eq('size=0.5 宽度减半', half.w, 55)
	eq('size=0.5 高度减半', half.h, 38)
	near('size=0.5 中心不动', half.x + half.w / 2, 8 + 110 / 2, 1e-9)

	eq('越界帧返回 null', faceRect(99), null)

	eq('avatarReadEdge 默认等于最大帧的宽', avatarReadEdge({ size: 1 }), 110)
	eq('avatarReadEdge 随 size 放大', avatarReadEdge({ size: 2 }), 220)
}

// ================================================================ 6. buildFrames

console.log('\n== 6. 五帧合成 ==')
{
	const size = PETPET_LIMITS.handCanvas
	const avatar = makeImage(100, 100, () => [255, 0, 0])

	// 量人像边界时用全透明的手，否则手部的标记会把外接矩形撑大
	const emptyHands = []
	for (let i = 0; i < 5; i++) emptyHands.push(blankImage(size, size))

	const frames = buildFrames({ image: avatar, hands: emptyHands, squish: 1, size: 1, flip: false })
	eq('合成出 5 帧', frames.length, 5)
	eq('每帧画布宽', frames[0].width, size)
	eq('每帧画布高', frames[0].height, size)

	// 参考实现的 locs 本身就溢出 112 画布（第 1 帧 12+101=113、33+85=118），
	// 溢出部分和 PIL 的 paste 一样被裁掉 —— 这不是 bug，是参考行为。
	const bounds1 = opaqueBounds(frames[1])
	eq('第 1 帧人像左边界', bounds1.minX, 12)
	eq('第 1 帧人像上边界', bounds1.minY, 33)
	eq('第 1 帧被右边界裁到 112', bounds1.maxX, size - 1)
	eq('第 1 帧被下边界裁到 112', bounds1.maxY, size - 1)
	eq('第 1 帧可见宽度（101 被裁成 100）', bounds1.width, 100)
	eq('第 1 帧可见高度（85 被裁成 79）', bounds1.height, 79)

	// 第 2 帧：8 + 110 = 118 > 112
	const bounds2 = opaqueBounds(frames[2])
	eq('第 2 帧从 x=8 开始', bounds2.minX, 8)
	eq('第 2 帧可见宽度只有 104', bounds2.width, 104)

	// 第 4 帧：12 + 98 = 110 没超，横向不该被裁
	const bounds4 = opaqueBounds(frames[4])
	eq('第 4 帧横向未裁剪', bounds4.minX + '/' + bounds4.width, '12/98')

	// 从 100×100 的方图拉成 110×76，说明确实做了非等比拉伸
	ok('第 2 帧是从方图非等比拉伸来的', bounds2.width !== bounds2.height)

	// 手在最上层：角落的标记应当盖住人像
	const markerHands = []
	for (let i = 0; i < 5; i++) markerHands.push(makeHand(size, 108, 108, [0, 0, 255]))
	const marked = buildFrames({ image: avatar, hands: markerHands, squish: 1, size: 1 })
	eq('手部标记叠在人像之上', pixelAt(marked[0], 109, 109)[2], 255)
	eq('人像中心仍是红色', pixelAt(marked[1], 60, 60)[0], 255)

	// 镜像：整帧翻转，边界关于画布中轴对称
	const flipped = buildFrames({ image: avatar, hands: emptyHands, squish: 1, size: 1, flip: true })
	const flippedBounds1 = opaqueBounds(flipped[1])
	eq('镜像后左边界 = 画布右缘 - 原右边界', flippedBounds1.minX, size - 1 - bounds1.maxX)
	eq('镜像后右边界 = 画布右缘 - 原左边界', flippedBounds1.maxX, size - 1 - bounds1.minX)
	eq('镜像后宽高不变', flippedBounds1.width + '/' + flippedBounds1.height, bounds1.width + '/' + bounds1.height)

	// squish / size 真的传到了合成里
	const squished = buildFrames({ image: avatar, hands: emptyHands, squish: 0, size: 1 })
	eq('squish=0 时第 1 帧宽度收到 h0', opaqueBounds(squished[1]).width, 85)
	eq('squish=0 时第 1 帧高度不变', opaqueBounds(squished[1]).height, 79)
	const big = buildFrames({ image: avatar, hands: emptyHands, squish: 1, size: 2 })
	eq('size=2 时人像比画布大，铺满整个宽度', opaqueBounds(big[1]).width, size)

	let threw = false
	try {
		buildFrames({ image: avatar, hands: hands.slice(0, 3) })
	} catch (error) {
		threw = true
	}
	ok('手部素材数量不对时抛错', threw)
}

// ================================================================ 7. 量化

console.log('\n== 7. 中位切分与量化 ==')
{
	// 颜色数不超过上限时必须精确重构
	const colors = [[10, 20, 30], [200, 40, 60], [30, 220, 90], [250, 250, 250]]
	const flat = []
	for (let i = 0; i < colors.length; i++) flat.push(colors[i][0], colors[i][1], colors[i][2])
	const palette = medianCut(flat, 8)
	eq('颜色数少于上限时调色板不膨胀', palette.length, colors.length)

	let exact = true
	for (let i = 0; i < colors.length; i++) {
		const index = nearestIndex(colors[i][0], colors[i][1], colors[i][2], palette)
		const found = palette[index]
		if (found[0] !== colors[i][0] || found[1] !== colors[i][1] || found[2] !== colors[i][2]) exact = false
	}
	ok('四种颜色都能被精确命中', exact)

	eq('调色板不会超过上限', medianCut(flat, 2).length <= 2, true)
	eq('没有像素时退化成单色黑', medianCut([], 8).length, 1)

	// 并列时取最小索引
	eq('并列取最小索引', nearestIndex(50, 50, 50, [[50, 50, 50], [50, 50, 50]]), 0)

	// 量化：透明像素落到 transparentIndex，不透明像素能原样还原
	const frameA = makeImage(4, 1, (x) => (x < 2 ? [10, 20, 30] : [200, 40, 60]))
	const frameB = makeImage(4, 1, () => [10, 20, 30, 0]) // 全透明
	const quantized = quantizeFrames([frameA, frameB], 8)

	eq('透明索引紧跟在调色板之后', quantized.transparentIndex, quantized.palette.length)
	eq('索引帧数与输入一致', quantized.frames.length, 2)
	eq('索引帧长度 = 像素数', quantized.frames[0].length, 4)
	eq('不透明像素不是透明索引', quantized.frames[0][0] !== quantized.transparentIndex, true)
	eq('透明像素落到透明索引', quantized.frames[1][0], quantized.transparentIndex)

	let roundTrips = true
	for (let i = 0; i < 4; i++) {
		const index = quantized.frames[0][i]
		if (index >= quantized.palette.length) roundTrips = false
	}
	ok('所有索引都在调色板范围内', roundTrips)

	const first = quantized.palette[quantized.frames[0][0]]
	eq('索引还原出原色 R', first[0], 10)
	eq('索引还原出原色 G', first[1], 20)
	eq('索引还原出原色 B', first[2], 30)

	// 调色板必须留得下透明那一格
	const many = makeImage(64, 64, (x, y) => [x * 4, y * 4, (x + y) * 2])
	const quantizedMany = quantizeFrames([many], 255)
	ok('255 色上限时仍有透明格（调色板 ≤ 255）', quantizedMany.palette.length <= 255, quantizedMany.palette.length)
	ok('透明索引不超过 255', quantizedMany.transparentIndex <= 255, quantizedMany.transparentIndex)
}

// ================================================================ 8. LZW 往返

console.log('\n== 8. LZW 编解码往返 ==')
{
	const cases = [
		{ name: '空流', indices: [], size: 2 },
		{ name: '单个符号', indices: [3], size: 2 },
		{ name: '两个符号', indices: [1, 2], size: 2 },
		{ name: '长同值串', indices: new Array(5000).fill(7), size: 4 },
		{ name: '两色交替', indices: Array.from({ length: 3000 }, (_, i) => i % 2), size: 2 },
		{ name: '小字母表随机', indices: null, size: 4, seed: 11, length: 9000, alphabet: 5 },
		{ name: '满字母表随机', indices: null, size: 8, seed: 22, length: 20000, alphabet: 256 },
		// 这一条会填满 12 位字典，逼出「发 clear 重置」那条分支
		{ name: '撑爆 12 位字典', indices: null, size: 8, seed: 33, length: 300000, alphabet: 256 }
	]

	for (let c = 0; c < cases.length; c++) {
		const item = cases[c]
		let indices = item.indices
		if (!indices) {
			const random = makeRandom(item.seed)
			indices = new Uint8Array(item.length)
			for (let i = 0; i < item.length; i++) indices[i] = Math.floor(random() * item.alphabet)
		}
		const encoded = lzwEncode(indices, item.size)
		const decoded = lzwDecode(encoded, item.size)
		let same = decoded.length === indices.length
		if (same) {
			for (let i = 0; i < indices.length; i++) {
				if (decoded[i] !== indices[i]) {
					same = false
					break
				}
			}
		}
		ok('往返一致：' + item.name + '（' + indices.length + ' → ' + encoded.length + ' 字节）', same)
	}
}

// ================================================================ 9. 子块打包

console.log('\n== 9. 数据子块 ==')
{
	const none = packSubBlocks(new Uint8Array(0))
	eq('空数据只留终止符', none.length, 1)
	eq('终止符是 0x00', none[0], 0)

	const small = packSubBlocks(Uint8Array.from([1, 2, 3]))
	eq('小数据块长度', small.length, 5)
	eq('长度字节', small[0], 3)
	eq('末尾终止符', small[small.length - 1], 0)

	const big = new Uint8Array(600)
	for (let i = 0; i < 600; i++) big[i] = i & 0xff
	const packed = packSubBlocks(big)
	eq('第一块 255 字节', packed[0], 255)
	eq('600 字节切成 255+255+90', packed[256], 255)
	eq('第三块 90', packed[512], 90)
	eq('总长度 = 3 个长度字节 + 600 + 终止符', packed.length, 3 + 600 + 1)
}

// ================================================================ 10. GIF 容器

console.log('\n== 10. GIF89a 容器 ==')
{
	const palette = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [10, 20, 30]]
	const frames = [
		Uint8Array.from([0, 1, 2, 3, 0, 1, 2, 3]),
		Uint8Array.from([3, 2, 1, 0, 3, 2, 1, 0])
	]
	const bytes = encodeGif({
		width: 4,
		height: 2,
		frames,
		palette,
		transparentIndex: 4,
		delayCs: 6,
		loop: 0
	})

	const parsed = parseGif(bytes)
	eq('签名', parsed.signature, 'GIF89a')
	eq('画布宽', parsed.width, 4)
	eq('画布高', parsed.height, 2)
	ok('有全局颜色表', parsed.hasGct)
	eq('颜色表按 2 的幂补齐', parsed.gctSize, 8)
	eq('循环次数（0 = 无限）', parsed.loop, 0)
	eq('帧数', parsed.frames.length, 2)
	eq('文件以 0x3B 收尾', bytes[bytes.length - 1], 0x3b)
	ok('解析器读到了结束符', parsed.sawTrailer)

	eq('帧 0 延时', parsed.frames[0].delay, 6)
	eq('帧 1 延时', parsed.frames[1].delay, 6)
	eq('处置方式 = 2（恢复背景）', parsed.frames[0].disposal, 2)
	ok('写了透明标志', parsed.frames[0].transparentFlag)
	eq('透明索引', parsed.frames[0].transparentIndex, 4)
	eq('帧位置 (0,0)', parsed.frames[0].left + ',' + parsed.frames[0].top, '0,0')
	eq('帧尺寸', parsed.frames[0].width + 'x' + parsed.frames[0].height, '4x2')
	eq('颜色表第 0 格', parsed.gct[0].join(','), '255,0,0')
	eq('颜色表第 3 格', parsed.gct[3].join(','), '10,20,30')
	eq('透明格填了占位色', parsed.gct[4].join(','), '0,0,0')

	let pixelsRoundTrip = true
	for (let f = 0; f < 2; f++) {
		if (parsed.frames[f].indices.length !== frames[f].length) pixelsRoundTrip = false
		else {
			for (let i = 0; i < frames[f].length; i++) {
				if (parsed.frames[f].indices[i] !== frames[f][i]) pixelsRoundTrip = false
			}
		}
	}
	ok('两帧像素都能从 GIF 字节里原样解回来', pixelsRoundTrip)

	// 不透明（transparentIndex = -1）时不该写透明标志
	const opaque = parseGif(encodeGif({ width: 1, height: 1, frames: [Uint8Array.from([0])], palette: [[1, 2, 3]], transparentIndex: -1 }))
	ok('不透明时不写透明标志', !opaque.frames[0].transparentFlag)
	eq('不透明时透明索引为 0', opaque.frames[0].transparentIndex, 0)
	eq('只有两色时颜色表补到 4', opaque.gctSize, 4)

	// 大调色板：255 色 + 1 透明格 = 256
	const bigPalette = []
	for (let i = 0; i < 255; i++) bigPalette.push([i, 255 - i, (i * 7) & 0xff])
	const big = parseGif(encodeGif({
		width: 256,
		height: 1,
		frames: [Uint8Array.from(Array.from({ length: 256 }, (_, i) => i))],
		palette: bigPalette,
		transparentIndex: 255
	}))
	eq('255 色 + 透明 = 256 格颜色表', big.gctSize, 256)
	eq('最小码长为 8', big.frames[0].minCodeSize, 8)
	eq('256 像素全解回来', big.frames[0].indices.length, 256)
	eq('末位像素索引', big.frames[0].indices[255], 255)

	let threw = false
	try {
		encodeGif({ width: 4, height: 4, frames: [], palette })
	} catch (error) {
		threw = true
	}
	ok('没有帧时抛错', threw)
}

// ================================================================ 11. 端到端

console.log('\n== 11. composeGif 端到端 ==')
{
	const size = PETPET_LIMITS.handCanvas
	const avatar = makeImage(140, 140, (x, y) => [x % 256, y % 256, (x + y) % 256])
	const hands = getHands()
	const frames = buildFrames({ image: avatar, hands, squish: 1, size: 1, flip: false })
	const result = composeGif({ frames, delayCs: 6, loop: 0 })

	ok('产出非空字节', result.bytes.length > 0, result.bytes.length)
	eq('帧数', result.frameCount, 5)

	const parsed = parseGif(result.bytes)
	eq('端到端：签名', parsed.signature, 'GIF89a')
	eq('端到端：画布 = 手部素材尺寸', parsed.width + 'x' + parsed.height, size + 'x' + size)
	eq('端到端：帧数', parsed.frames.length, 5)
	eq('端到端：循环', parsed.loop, 0)

	let allSized = true
	let allDelayed = true
	for (let i = 0; i < parsed.frames.length; i++) {
		if (parsed.frames[i].indices.length !== size * size) allSized = false
		if (parsed.frames[i].delay !== 6) allDelayed = false
	}
	ok('每帧都解出 ' + size * size + ' 个像素', allSized)
	ok('每帧延时都是 6 厘秒', allDelayed)

	// 解出来的像素应当和量化后的索引逐字节一致
	let matchesIndices = true
	const quantized = quantizeFrames(frames, 255)
	for (let i = 0; i < size * size; i++) {
		if (parsed.frames[2].indices[i] !== quantized.frames[2][i]) {
			matchesIndices = false
			break
		}
	}
	ok('解回来的是第 2 帧真正的索引', matchesIndices)

	// 透明区必须真的落在透明索引上（否则贴纸会带一块黑底）
	const corner = parsed.frames[0].indices[0]
	eq('左上角是透明像素', corner, quantized.transparentIndex)

	// 改速度要真的写进每一帧
	const fast = parseGif(composeGif({ frames, delayCs: 20 }).bytes)
	eq('速度 20 厘秒写进帧 0', fast.frames[0].delay, 20)
	eq('速度 20 厘秒写进帧 4', fast.frames[4].delay, 20)

	console.log('        产物大小：' + result.bytes.length + ' 字节，调色板 ' + result.palette.length + ' 色')
}

// ================================================================

console.log('\n=============================')
console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项')
console.log('=============================\n')
process.exit(fail === 0 ? 0 : 1)
