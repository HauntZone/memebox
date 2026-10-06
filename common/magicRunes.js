/**
 * 魔法阵的符文生成：纯数据，不涉及渲染，也不含任何 uni API / DOM / 平台判断。
 *
 * 刻意**不画随机线段**，而是照真实符文（Elder Futhark 那一系）的构字法生成：
 * **一条竖主干 + 1~3 条从主干斜出去的枝**。这是这套字母表共有的构造原则，
 * 所以按它生成的图形一律读起来像符文，而不会退化成随机划痕。
 *
 * 坐标一律吸附到 0.1 的粗网格上 —— 真实符文是刻出来的，笔画落在固定的几个高度上，
 * 自由浮点反而会显得「软」。吸附之后同一条枝只会出现在十个位置之一，这就是「像刻的」
 * 的来源，也是每次生成都不同但都像符文的原因。
 *
 * 所有坐标在**局部方块** [0,1] × [0,1] 里：主干固定 x = 0.5，枝向右（镜像时向左）伸出。
 * 高度恒定占满 0.05 ~ 0.95，所以所有符文一样高、宽度不同 —— 和一套字体的「等高不等宽」
 * 是一回事。摆放（缩放到带高、转到切线方向）由 magicCircle.js 负责。
 */

/** 吸附网格。改小会让符文变得「手写感」重、不再像刻的；改大会退化成一堆重合的字符。 */
const GRID = 0.1

/**
 * 主干与墨迹的纵向范围。必须**落在 0.1 网格上** —— 它和枝一样要过 snap()，
 * 取 0.05 / 0.95 会被吸附成 0.1 / 0.9，主干就比枝短一截（踩过一次）。
 */
const INK_TOP = 0.1
const INK_BOTTOM = 0.9

/** 主干所在的 x（局部坐标）。固定不动，这样一排符文的主干是对齐的。 */
const STEM_X = 0.5

function snap(value) {
	return Math.round(value / GRID) * GRID
}

function clampRange(value, low, high) {
	if (value < low) return low
	if (value > high) return high
	return value
}

function pick(rand, options) {
	return options[Math.min(options.length - 1, Math.floor(rand() * options.length))]
}

/** 原地洗牌，用传入的 rand 保证可复现（不能用 Math.random）。 */
function shuffle(items, rand) {
	for (let i = items.length - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1))
		const swap = items[i]
		items[i] = items[j]
		items[j] = swap
	}
	return items
}

/**
 * 生成一个符文。返回若干条折线：`[[[x, y], ...], ...]`，第一条是主干。
 *
 * rand 由一个 [0,1) 的随机源提供，**必须由调用方传入**，这样同一个种子给出同一个符文，
 * 而本模块不需要知道随机数是怎么来的（也就避免了和 magicCircle 互相 import）。
 */
export function buildRune(rand) {
	// 主干
	const strokes = [[[STEM_X, INK_TOP], [STEM_X, INK_BOTTOM]]]

	// 枝挂在主干的三档高度上，互不重合。先洗牌再排序，保证「挑中哪几档」是随机的、
	// 但画出来仍然是从上到下有序的。
	const slots = shuffle([0.3, 0.5, 0.7], rand)
	const branchCount = 1 + Math.floor(rand() * 3)
	const anchors = slots.slice(0, branchCount).sort(function (a, b) { return a - b })

	for (let i = 0; i < anchors.length; i++) {
		const anchorY = anchors[i]
		const reach = pick(rand, [0.25, 0.4, 0.5])
		const rise = pick(rand, [0.2, 0.3]) * (rand() < 0.5 ? -1 : 1)

		// 枝尖必须留在方块内。真实符文里枝可以很短、也可以几乎到底，所以夹取比重掷自然。
		const tipY = clampRange(anchorY + rise, INK_TOP, INK_BOTTOM)
		const tipX = STEM_X + reach

		// 一半的枝带一个拐点（主干 → 肘 → 枝尖），这是符文里很常见的一类笔画
		if (rand() < 0.5) {
			const elbowX = STEM_X + reach * 0.55
			const elbowY = anchorY + (tipY - anchorY) * 0.15
			strokes.push([[STEM_X, anchorY], [elbowX, elbowY], [tipX, tipY]])
		} else {
			strokes.push([[STEM_X, anchorY], [tipX, tipY]])
		}
	}

	// 约三分之一的符文整体镜像，枝长到左边去。真实符文里镜像字形是存在的。
	const mirrored = rand() < 0.35

	for (let s = 0; s < strokes.length; s++) {
		const stroke = strokes[s]
		for (let p = 0; p < stroke.length; p++) {
			const x = mirrored ? 1 - stroke[p][0] : stroke[p][0]
			stroke[p][0] = clampRange(snap(x), 0, 1)
			stroke[p][1] = clampRange(snap(stroke[p][1]), 0, 1)
		}
	}

	return strokes
}

/**
 * 取符文墨迹的外接框，返回 { minX, minY, maxX, maxY }。
 * 摆放时按这个框把符文缩放到带高 —— 用的是墨迹而不是 [0,1] 方块，
 * 否则主干偏在一边的符文会被视觉上缩小一圈。
 */
export function runeBounds(strokes) {
	let minX = 1
	let minY = 1
	let maxX = 0
	let maxY = 0

	for (let s = 0; s < strokes.length; s++) {
		const stroke = strokes[s]
		for (let p = 0; p < stroke.length; p++) {
			const x = stroke[p][0]
			const y = stroke[p][1]
			if (x < minX) minX = x
			if (x > maxX) maxX = x
			if (y < minY) minY = y
			if (y > maxY) maxY = y
		}
	}

	return { minX, minY, maxX, maxY }
}
