/**
 * 纯 JS 的 GIF89a 编码器，没有任何平台依赖，也不依赖任何第三方库。
 *
 * 为什么不复用 pako：pako 是 deflate（PNG/zlib 用的），GIF 用的是 LZW，两码事。
 *
 * 结构：文件头 + 逻辑屏幕描述符 + 全局颜色表 + NETSCAPE2.0 循环扩展
 *       + 每帧（图形控制扩展 + 图像描述符 + LZW 数据）+ 结束符 0x3B。
 *
 * 三处肉眼看不出差别、但写错就整张花掉的地方：
 * 1. 位写入是 **LSB-first**（低位先出），和 PNG 那边高位先出相反；
 * 2. 码长要等**字典真的装不下下一个码**时才升（nextCode > 1 << codeSize），
 *    早一步晚一步解码器就会读错位 —— 推导见 lzwEncode 里的注释；
 * 3. `disposal` 必须给 2（恢复背景）：每帧整幅都带透明区，给 1（不处置）的话
 *    后一帧的透明区会把前一帧透出来，叠成一片鬼影。
 *
 * 只写「全局颜色表 + 每帧不带动画参数之外的差异」：petpet 五帧共用一张全局调色板
 * （见 colorQuantize.js 的解释），所以不需要局部颜色表。
 */

const SIGNATURE = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61] // "GIF89a"
const NETSCAPE = [0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2e, 0x30] // "NETSCAPE2.0"

/** LSB-first 的位写入器：GIF 的 LZW 码流是从低位往高位填的。 */
function createBitWriter() {
	const bytes = []
	let current = 0
	let bitCount = 0
	return {
		write(code, codeSize) {
			current |= code << bitCount
			bitCount += codeSize
			while (bitCount >= 8) {
				bytes.push(current & 0xff)
				current >>= 8
				bitCount -= 8
			}
		},
		flush() {
			if (bitCount > 0) {
				bytes.push(current & 0xff)
				current = 0
				bitCount = 0
			}
			return Uint8Array.from(bytes)
		}
	}
}

/**
 * GIF 的 LZW 编码。indices 是每像素一个字节的调色板索引，minCodeSize 是最小码长。
 * 返回**未分包**的裸码流，交给 packSubBlocks 切块。
 *
 * 码长的升降是最容易错的一步，这里推一遍（minCodeSize = 2，clear = 4，end = 5，初始码长 3）：
 *
 *   解码器读到 clear 后，第一次读码只输出、**不建表**；从第二次起，每读一个码才补上
 *   前一个前缀的延续项。所以解码器的 next 永远比编码器的 next 慢一格。
 *
 *   编码器                        解码器
 *   发 clear                      next = 6
 *   第 1 次未命中：发码，建表 6     读第 2 个码：建表 6，next = 7
 *   第 2 次未命中：发码，建表 7     读第 3 个码：建表 7，next = 8 → 8 == 1<<3，升到 4 位
 *   第 3 次未命中：发码（仍是 3 位） 读第 4 个码（仍是 3 位）→ 建表 8
 *   此时 next 变成 9，9 > 8 → 升到 4 位；第 4 次发码才开始用 4 位
 *
 * 所以判据是 `nextCode > (1 << codeSize)`，而不是 `>=`：用 `>=` 会早一格升位，
 * 解码器还在按旧码长读，整条流就错位了。
 */
export function lzwEncode(indices, minCodeSize) {
	const size = Math.max(2, minCodeSize | 0)
	const clearCode = 1 << size
	const endCode = clearCode + 1

	const writer = createBitWriter()
	let codeSize = size + 1
	let nextCode = endCode + 1
	let dict = new Map()

	function resetDictionary() {
		dict = new Map()
		nextCode = endCode + 1
		codeSize = size + 1
	}

	writer.write(clearCode, codeSize)

	if (indices && indices.length > 0) {
		let prefix = indices[0]
		for (let i = 1; i < indices.length; i++) {
			const k = indices[i]
			// prefix < 4096、k < 256，乘 4096 拼成整数键：比字符串键快，也不产生临时字符串
			const key = prefix * 4096 + k
			const found = dict.get(key)
			if (found !== undefined) {
				prefix = found
				continue
			}

			writer.write(prefix, codeSize)

			if (nextCode < 4096) {
				dict.set(key, nextCode)
				nextCode++
				if (nextCode > (1 << codeSize) && codeSize < 12) codeSize++
			} else {
				// 12 位装满了，发 clear 让编码器和解码器一起重置（clear 仍按当前 12 位发出）
				writer.write(clearCode, codeSize)
				resetDictionary()
			}

			prefix = k
		}
		writer.write(prefix, codeSize)
	}

	writer.write(endCode, codeSize)
	return writer.flush()
}

/** 把裸码流切成 GIF 的数据子块：每块 ≤255 字节，前面一个长度字节，最后以 0x00 收尾。 */
export function packSubBlocks(bytes) {
	const out = []
	let offset = 0
	while (offset < bytes.length) {
		const length = Math.min(255, bytes.length - offset)
		out.push(length)
		for (let i = 0; i < length; i++) out.push(bytes[offset + i])
		offset += length
	}
	out.push(0)
	return Uint8Array.from(out)
}

/**
 * 把索引帧编码成 GIF89a 字节。
 *
 * width / height 是所有帧共用的画布尺寸（GIF 各帧必须等尺寸）；
 * frames 是 Uint8Array[]（每帧一个调色板索引数组）；palette 是 [[r,g,b], ...]；
 * transparentIndex 给 -1 表示不透明（不写透明标志）；delayCs 是每帧延时，单位厘秒；
 * loop 是循环次数，0 = 无限循环。
 */
export function encodeGif({
	width,
	height,
	frames,
	palette,
	transparentIndex = -1,
	delayCs = 6,
	loop = 0,
	disposal = 2
}) {
	if (!width || !height) throw new Error('图片尺寸不合法')
	if (!frames || !frames.length) throw new Error('没有可编码的帧')
	if (!palette || !palette.length) throw new Error('缺少调色板')

	const hasTransparent = transparentIndex >= 0
	// 颜色表必须是 2 的幂，且要装得下透明那一格（透明格在 palette 之外）
	const needed = Math.max(palette.length, hasTransparent ? transparentIndex + 1 : 0, 2)
	let bitsPerColor = 1
	while ((1 << bitsPerColor) < needed) bitsPerColor++
	if (bitsPerColor < 2) bitsPerColor = 2
	if (bitsPerColor > 8) throw new Error('调色板超过 256 色：' + needed)
	const tableSize = 1 << bitsPerColor
	const minCodeSize = bitsPerColor

	const out = []
	const pushBytes = (list) => {
		for (let i = 0; i < list.length; i++) out.push(list[i] & 0xff)
	}
	const pushUint16 = (value) => {
		out.push(value & 0xff, (value >> 8) & 0xff)
	}

	// 文件头
	pushBytes(SIGNATURE)

	// 逻辑屏幕描述符：有全局颜色表(bit7) | 颜色分辨率(bit4-6，给 7 表示 8 位/通道) | 表大小幂次(bit0-2)
	pushUint16(width)
	pushUint16(height)
	out.push(0x80 | 0x70 | (bitsPerColor - 1))
	out.push(hasTransparent ? transparentIndex : 0) // 背景色索引（有透明时索性指到透明格）
	out.push(0) // 像素宽高比：0 = 不指定

	// 全局颜色表（透明那一格填 0,0,0 占位，反正永远不会被显示）
	for (let i = 0; i < tableSize; i++) {
		const color = palette[i]
		if (color) out.push(color[0] & 0xff, color[1] & 0xff, color[2] & 0xff)
		else out.push(0, 0, 0)
	}

	// NETSCAPE2.0 应用扩展：循环次数（0 = 无限）
	out.push(0x21, 0xff, 0x0b)
	pushBytes(NETSCAPE)
	out.push(0x03, 0x01)
	pushUint16(loop)
	out.push(0x00)

	for (let f = 0; f < frames.length; f++) {
		// 图形控制扩展：处置方式(bit2-4) | 用户输入(bit1) | 透明标志(bit0)
		out.push(0x21, 0xf9, 0x04)
		out.push(((disposal & 0x07) << 2) | (hasTransparent ? 0x01 : 0x00))
		pushUint16(delayCs)
		out.push(hasTransparent ? transparentIndex : 0)
		out.push(0x00)

		// 图像描述符：无局部颜色表、不隔行，整幅铺在 (0,0)
		out.push(0x2c)
		pushUint16(0)
		pushUint16(0)
		pushUint16(width)
		pushUint16(height)
		out.push(0x00)

		// LZW 最小码长 + 数据子块
		out.push(minCodeSize)
		pushBytes(packSubBlocks(lzwEncode(frames[f], minCodeSize)))
	}

	out.push(0x3b) // 结束符
	return Uint8Array.from(out)
}
