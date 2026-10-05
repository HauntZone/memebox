/**
 * 摸头表情（petpet）的运算内核：纯函数，不含任何 uni API、DOM 或平台判断。
 *
 * 算法照搬参考实现 meme-generator 的 memes/petpet（MIT）：
 * 头像先裁成正方形，再按每帧的 (x, y, w, h) 非等比拉伸贴到透明画布上，最后叠上对应的手部帧。
 * 五帧素材见 petpetHands.js，坐标表见下面的 LOCS。
 *
 * 与参考实现的两处不同：
 * 1. 「挤压」做成了可调系数 squish（界面才有滑块），locs 本身仍然等于 squish = 1 的那一档，
 *    所以默认参数下**几何完全一致**（每帧的人脸矩形逐像素等于 locs）；
 * 2. 缩放用的是本项目的双线性（imageGeometry.resizeStretchImage），不是 PIL 的 resample
 *    —— 参考实现走的是 pil_utils 的默认滤波器，那不在我们能复现的范围内。
 *    所以是「位置和尺寸照搬、重采样滤波器自备」，不是逐像素照搬。
 */
import { resizeStretchImage, pasteOver, flipHorizontal } from './imageGeometry.js'
import { quantizeFrames } from './colorQuantize.js'
import { encodeGif } from './gifWriter.js'

/**
 * 五帧的「脸」矩形 (x, y, w, h)，取自参考实现 meme-generator 的 memes/petpet/__init__.py。
 * 顺序即帧序，与 petpetHands.js 里五张手部素材一一对应。
 * 第 2 帧 8 + 110 = 118 超出 112 的画布，靠 pasteOver 的越界裁剪复现参考实现里 PIL paste 的行为。
 */
const LOCS = [
	[14, 20, 98, 98],
	[12, 33, 101, 85],
	[8, 40, 110, 76],
	[10, 33, 102, 84],
	[12, 20, 98, 98]
]

export const PETPET_LIMITS = {
	frameCount: LOCS.length,
	locs: LOCS,
	// 手部素材是 112×112 的
	handCanvas: 112,
	// 滑块给整数档，除以 scale 才是实际系数
	sizeRange: [50, 200],
	sizeScale: 100,
	sizeDefault: 100,
	squishRange: [0, 100],
	squishScale: 100,
	squishDefault: 100,
	// 速度滑块的值就是 GIF 帧延时，单位厘秒 —— GIF 的 delay 字段本来就是 1/100 秒
	speedRange: [2, 20],
	speedDefault: 6
}

/**
 * 单帧的「脸」矩形（浮点）。squish 是这里唯一定义的参数：
 *
 *   w1 = h0 + (w0 - h0) * squish     squish = 1 → w0（等同参考实现）
 *                                    squish = 0 → h0（收缩成 h0×h0 的方形，不做横向变形）
 *   h1 = h0                          高度不参与挤压
 *
 * 注意五帧的 w0 本来就都 ≥ h0，所以「用 max(w0,h0) 当方形基准」会算出恒等于 w0 的结果、
 * 让 squish 完全失效（踩过一次）。以 h0 为基准才有意义：squish = 0 时横向回到不拉伸的方形。
 * 第 0/4 帧本就正方（w0 = h0），它们对 squish 不敏感是正确的，不是 bug。
 *
 * 再乘 size，并绕原矩形中心缩放。
 */
export function faceRect(index, { squish = 1, size = 1 } = {}) {
	const loc = LOCS[index]
	if (!loc) return null
	const x0 = loc[0]
	const y0 = loc[1]
	const w0 = loc[2]
	const h0 = loc[3]
	const w = (h0 + (w0 - h0) * squish) * size
	const h = h0 * size
	return {
		x: x0 + w0 / 2 - w / 2,
		y: y0 + h0 / 2 - h / 2,
		w,
		h
	}
}

/**
 * 读头像时该用的正方形边长：取五帧里最大的那条边（再乘 size）。
 * 这样最大那一帧是 1:1，其余帧只是轻微缩小，双线性插值不会因为大幅降采样而混叠。
 * 取 squish = 1 是因为挤压只会让宽度往 h0 收，不会超过 w0。
 */
export function avatarReadEdge({ size = 1 } = {}) {
	let edge = 1
	for (let i = 0; i < PETPET_LIMITS.frameCount; i++) {
		const rect = faceRect(i, { squish: 1, size })
		edge = Math.max(edge, rect.w, rect.h)
	}
	return Math.ceil(edge)
}

/**
 * 合成五帧。image 需要是**正方形**（页面用方形 target 调 readPixels 得到，天然居中裁剪）。
 * hands 由调用方注入，便于测试塞合成素材。
 *
 * 顺序严格照搬参考实现：拉伸 → 贴头像 → 叠手 → （可选）镜像。
 * 镜像放在最后是为了让手跟着一起翻。
 */
export function buildFrames({ image, hands, squish = 1, size = 1, flip = false }) {
	if (!image || !image.data) throw new Error('缺少像素数据')
	if (!hands || hands.length !== PETPET_LIMITS.frameCount) {
		throw new Error('手部素材数量不对：需要 ' + PETPET_LIMITS.frameCount + ' 帧，收到 ' + (hands ? hands.length : 0))
	}

	// GIF 各帧必须等尺寸，按素材归一化（五张都是 112×112，这里只是不写死）
	let canvasWidth = 1
	let canvasHeight = 1
	for (let i = 0; i < hands.length; i++) {
		canvasWidth = Math.max(canvasWidth, hands[i].width)
		canvasHeight = Math.max(canvasHeight, hands[i].height)
	}

	const frames = []
	for (let i = 0; i < hands.length; i++) {
		const rect = faceRect(i, { squish, size })
		const face = resizeStretchImage(
			image,
			Math.max(1, Math.round(rect.w)),
			Math.max(1, Math.round(rect.h))
		)
		if (!face) throw new Error('第 ' + i + ' 帧的人脸缩放失败')

		const blank = {
			width: canvasWidth,
			height: canvasHeight,
			data: new Uint8ClampedArray(canvasWidth * canvasHeight * 4)
		}
		let frame = pasteOver({ base: blank, top: face, x: Math.round(rect.x), y: Math.round(rect.y) })
		frame = pasteOver({ base: frame, top: hands[i], x: 0, y: 0 })
		frames.push(flip ? flipHorizontal(frame) : frame)
	}

	return frames
}

/**
 * 帧 → 量化 → GIF 字节。delayCs 是每帧的厘秒延时（速度滑块的值直接就是它）。
 * 默认透明背景：摸头表情是要当贴纸用的，压平到白底会在深色聊天背景上一眼假。
 */
export function composeGif({ frames, delayCs = PETPET_LIMITS.speedDefault, loop = 0, maxColors = 255 }) {
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
