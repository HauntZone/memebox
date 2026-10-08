<template>
	<view class="page">
		<!-- ==================== 选图 ==================== -->
		<view class="card">
			<text class="label">头像</text>
			<text class="hint">会先居中裁成正方形，再按五帧手部动作循环播放</text>
			<view class="slot slot-wide" hover-class="slot-hover" @click="pickImage">
				<image v-if="userImage.src" class="slot-image" :src="userImage.src" mode="aspectFit"></image>
				<text v-else class="slot-plus">+</text>
			</view>
		</view>

		<!-- ==================== 参数 ==================== -->
		<!-- 四项都是调优，默认值直接能出成品，所以整卡默认折起来（摘要里带着当前值） -->
		<view class="card">
			<tool-collapse title="参数" :summary="paramSummary">
				<view class="row">
					<text class="label">镜像</text>
					<switch class="switch" color="#5B8FF9" :checked="flip" @change="onFlipChange" />
				</view>
				<tool-slider
					label="大小"
					:spaced="true"
					:value="size"
					:min="sizeMin"
					:max="sizeMax"
					:step="sizeStep"
					@changing="onChanging('size', $event)"
					@change="onChange('size', $event)"
				/>
				<tool-slider
					label="挤压"
					:spaced="true"
					:value="squish"
					:min="squishMin"
					:max="squishMax"
					:step="squishStep"
					@changing="onChanging('squish', $event)"
					@change="onChange('squish', $event)"
				/>
				<tool-slider
					label="速度"
					:spaced="true"
					:value="speed"
					:min="speedMin"
					:max="speedMax"
					:step="speedStep"
					@changing="onChanging('speed', $event)"
					@change="onChange('speed', $event)"
				/>
				<text class="hint">每帧 {{ speed * 10 }}ms；挤压 0 完全不横向变形，100 与经典摸头效果一致</text>
			</tool-collapse>
		</view>

		<!-- ==================== 编辑预览 ==================== -->
		<view v-if="frameSrcs.length" class="card">
			<text class="label">预览</text>
			<text class="hint">预览把透明区压在白底上显示；实际产出的 GIF 是带透明通道的</text>
			<view class="stage stage-white">
				<image class="stage-image" :src="frameSrcs[frameIndex]" mode="aspectFit"></image>
			</view>
		</view>

		<view class="actions">
			<button class="btn btn-primary" :disabled="!userImage.path || busy" @click="generate">
				{{ busy ? '处理中...' : '生成 GIF' }}
			</button>
			<button class="btn btn-plain" :disabled="!gifSrc || busy" @click="saveResult">保存到相册</button>
		</view>

		<!-- ==================== 成品 ==================== -->
		<view v-if="gifSrc" class="card">
			<text class="label">成品（真正要保存的 GIF 文件）</text>
			<text class="hint">{{ gifInfo }}</text>
			<view class="stage stage-white">
				<image class="stage-image" :src="gifSrc" mode="aspectFit"></image>
			</view>
			<text class="hint">这里放的已经是编码好的 GIF 字节。它要是不动，就说明当前平台不播 GIF 动画（文件本身没问题，保存到相册再看）。</text>
		</view>

		<text v-if="errorText" class="error">{{ errorText }}</text>

		<!-- ==================== 诊断 ==================== -->
		<view class="diag">
			<text class="link" @click="toggleDiag">{{ diagOpen ? '收起诊断信息' : '环境诊断' }}</text>
			<view v-if="diagOpen" class="diag-body">
				<text v-for="line in diagLines" :key="line" class="diag-line">{{ line }}</text>
				<text class="link" @click="refreshDiag">刷新</text>
			</view>
		</view>

		<!-- 读像素用的画布：只有 JPEG 头像会走到这里（PNG 走文件字节解码，不需要画布） -->
		<!-- #ifdef MP-WEIXIN -->
		<canvas
			type="2d"
			id="petpetCanvas"
			canvas-id="petpetCanvas"
			class="hidden-canvas"
			:style="canvasStyle"
		></canvas>
		<!-- #endif -->
		<!-- #ifdef APP-PLUS -->
		<canvas
			id="petpetCanvas"
			canvas-id="petpetCanvas"
			class="hidden-canvas"
			:style="canvasStyle"
		></canvas>
		<!-- #endif -->
	</view>
</template>

<script>
	import { PETPET_LIMITS, buildFrames, composeGif, avatarReadEdge } from '@/common/petpet.js'
	import { getHands } from '@/common/petpetHands.js'
	import { composite } from '@/common/imageGeometry.js'
	import ToolSlider from '@/components/tool-slider/tool-slider.vue'
	import ToolCollapse from '@/components/tool-collapse/tool-collapse.vue'
	import {
		chooseImages,
		getImageSize,
		readPixels,
		exportPng,
		exportGif,
		saveGif,
		releaseImage,
		getDiagnostics,
		noteError,
		platformName
	} from '@/common/petpetAdapter.js'

	const PREVIEW_DEBOUNCE = 120

	// 已读出的头像像素。刻意放在模块作用域而不是 data 里：data 会被 Vue 变成响应式，
	// 让几十万项的像素数组套上代理是白白烧性能，我们也不需要它触发重渲染。
	let avatarCache = null

	function emptyImage() {
		return { src: '', path: '', width: 0, height: 0 }
	}

	export default {
		components: { ToolSlider, ToolCollapse },
		data() {
			return {
				userImage: emptyImage(),
				flip: false,
				size: PETPET_LIMITS.sizeDefault,
				squish: PETPET_LIMITS.squishDefault,
				speed: PETPET_LIMITS.speedDefault,
				sizeMin: PETPET_LIMITS.sizeRange[0],
				sizeMax: PETPET_LIMITS.sizeRange[1],
				sizeStep: 5,
				squishMin: PETPET_LIMITS.squishRange[0],
				squishMax: PETPET_LIMITS.squishRange[1],
				squishStep: 5,
				speedMin: PETPET_LIMITS.speedRange[0],
				speedMax: PETPET_LIMITS.speedRange[1],
				speedStep: 1,
				frameSrcs: [],
				frameIndex: 0,
				timer: null,
				previewTimer: null,
				gifSrc: '',
				gifInfo: '',
				busy: false,
				errorText: '',
				canvasWidth: 300,
				canvasHeight: 300,
				diagOpen: false,
				diagLines: []
			}
		},
		computed: {
			// 折叠摘要：折起来也要看得出参数被改过没有
			paramSummary() {
				return (this.flip ? '镜像 · ' : '') +
					'大小 ' + this.size + ' · 挤压 ' + this.squish + ' · 速度 ' + this.speed
			},
			canvasStyle() {
				return 'width: ' + this.canvasWidth + 'px; height: ' + this.canvasHeight + 'px;'
			},
			sizeFactor() {
				return this.size / PETPET_LIMITS.sizeScale
			},
			squishFactor() {
				return this.squish / PETPET_LIMITS.squishScale
			},
			// 读头像用的正方形边长：跟着 size 走，最大那一帧正好 1:1
			avatarEdge() {
				return avatarReadEdge({ size: this.sizeFactor })
			}
		},
		onUnload() {
			this.stopTimer()
			if (this.previewTimer) clearTimeout(this.previewTimer)
			this.previewTimer = null
			this.releaseFrameSrcs()
			releaseImage(this.gifSrc)
			this.gifSrc = ''
			avatarCache = null
		},
		methods: {
			// ---------------- 选图 ----------------

			async pickImage() {
				try {
					this.errorText = ''
					const paths = await chooseImages(1)
					if (!paths || !paths.length) return
					const info = await getImageSize(paths[0])

					// 凡是跟「上一张图」绑定的状态都必须在这里清掉：缓存像素、预览帧文件、
					// 上一张图的成品 GIF。留着它们就会拿旧图的数据去算新图。
					this.releaseFrameSrcs()
					releaseImage(this.gifSrc)
					this.gifSrc = ''
					this.gifInfo = ''
					avatarCache = null

					this.userImage = {
						src: paths[0],
						path: info.path || paths[0],
						width: info.width,
						height: info.height
					}
					await this.rebuildPreview()
				} catch (error) {
					this.fail('选择图片失败', error, this.pickHint(error))
				}
			},

			// 相册权限一旦被拒过，系统不会再弹窗，只能去设置里手动打开
			pickHint(error) {
				const message = (error && (error.message || error.errMsg)) || String(error)
				if (/permission|auth deny|denied/i.test(message)) {
					return '权限被拒过之后系统不会再弹窗，请到手机「设置 → 应用 → 本应用 → 权限」里手动打开照片 / 存储权限'
				}
				if (platformName() === 'app') {
					return '可以先到手机「设置 → 应用 → 本应用 → 权限」确认照片 / 存储已允许；如果是刚改过 manifest 里的权限或模块，需要重新制作自定义调试基座才会生效'
				}
				return ''
			},

			// ---------------- 参数 ----------------

			onFlipChange(event) {
				this.flip = event.detail.value
				this.schedulePreview()
			},

			// 拖动中只更新数值（不然标题上的值不跟手），不重建 —— 一次预览要出 5 张临时图
			onChanging(key, value) {
				const number = Number(value)
				if (!isFinite(number)) return
				this[key] = number
				if (key === 'speed') this.restartTimer()
			},

			// 松手且值真的变过才会走到这里
			onChange(key, value) {
				const number = Number(value)
				if (!isFinite(number)) return
				this[key] = number
				if (key === 'speed') {
					// 速度只影响播放节奏，像素没变，不用重算
					this.restartTimer()
					return
				}
				this.schedulePreview()
			},

			schedulePreview() {
				if (this.previewTimer) clearTimeout(this.previewTimer)
				this.previewTimer = setTimeout(() => {
					this.previewTimer = null
					this.rebuildPreview()
				}, PREVIEW_DEBOUNCE)
			},

			// ---------------- 像素 ----------------

			// 目标尺寸同时决定隐藏画布的 CSS 尺寸（App 端旧版 canvas 按这个尺寸绘制）
			async prepareCanvas(width, height) {
				this.canvasWidth = width
				this.canvasHeight = height
				await this.$nextTick()
				// #ifdef APP-PLUS
				// 旧版 canvas 改尺寸后立刻绘制可能用到旧的画布尺寸，给它一点时间
				await new Promise((resolve) => setTimeout(resolve, 80))
				// #endif
			},

			// 方形 target 顺便完成「居中裁成正方形」；同一张图同一个边长只读一次
			async loadAvatarPixels() {
				const edge = this.avatarEdge
				const key = this.userImage.path + '|' + edge
				if (avatarCache && avatarCache.key === key) return avatarCache.image

				await this.prepareCanvas(edge, edge)
				const image = await readPixels(
					this.userImage.path,
					{ width: edge, height: edge },
					this.userImage,
					this
				)
				avatarCache = { key: key, image: image }
				return image
			},

			async composeFrames() {
				const hands = getHands()
				if (!hands[0] || !hands[0].data) {
					throw new Error('手部素材解码失败（内嵌的 PNG 格式不被 decodePng 支持）')
				}
				const avatar = await this.loadAvatarPixels()
				return buildFrames({
					image: avatar,
					hands: hands,
					squish: this.squishFactor,
					size: this.sizeFactor,
					flip: this.flip
				})
			},

			// ---------------- 预览 ----------------

			async rebuildPreview() {
				if (!this.userImage.path || this.busy) return
				try {
					this.errorText = ''
					const frames = await this.composeFrames()
					const srcs = []
					for (let i = 0; i < frames.length; i++) {
						// 预览必须压平再显示：App 端 <image> 不会把父容器的 CSS 背景
						// 从 PNG 的透明区透出来（见 CLAUDE.md 的坑 2），直接显示会是块怪的
						const flat = await exportPng(composite({ image: frames[i], background: 255 }))
						srcs.push(flat.src)
					}
					this.releaseFrameSrcs()
					this.frameSrcs = srcs
					this.frameIndex = 0
					this.restartTimer()
					if (this.diagOpen) this.refreshDiag()
				} catch (error) {
					this.fail('预览失败', error)
				}
			},

			restartTimer() {
				this.stopTimer()
				if (this.frameSrcs.length < 2) return
				// 和 GIF 的 delay 对齐，这样预览的节奏就是成品的节奏
				const delay = Math.max(20, this.speed * 10)
				this.timer = setInterval(() => {
					this.frameIndex = (this.frameIndex + 1) % this.frameSrcs.length
				}, delay)
			},

			stopTimer() {
				if (this.timer) {
					clearInterval(this.timer)
					this.timer = null
				}
			},

			// 自己写出来的文件是持久化的，换新一批之前必须显式删（见 releaseImage 的说明）
			releaseFrameSrcs() {
				this.stopTimer()
				for (let i = 0; i < this.frameSrcs.length; i++) releaseImage(this.frameSrcs[i])
				this.frameSrcs = []
				this.frameIndex = 0
			},

			// ---------------- 生成与保存 ----------------

			async generate() {
				if (!this.userImage.path || this.busy) return
				this.busy = true
				this.errorText = ''
				uni.showLoading({ title: '生成 GIF...' })
				try {
					const frames = await this.composeFrames()
					const result = composeGif({ frames: frames, delayCs: this.speed, loop: 0 })
					const out = await exportGif(result.bytes)

					releaseImage(this.gifSrc)
					this.gifSrc = out.src
					this.gifInfo =
						result.bytes.length + ' 字节 · ' +
						result.frameCount + ' 帧 · 每帧 ' + (this.speed * 10) + 'ms · ' +
						result.palette.length + ' 色调色板'
					uni.hideLoading()
					uni.showToast({ title: '已生成' })
					if (this.diagOpen) this.refreshDiag()
				} catch (error) {
					uni.hideLoading()
					this.fail('生成失败', error)
				}
				this.busy = false
			},

			async saveResult() {
				if (!this.gifSrc || this.busy) return
				this.busy = true
				try {
					await saveGif(this.gifSrc, 'petpet.gif')
					uni.showToast({ title: '已保存' })
				} catch (error) {
					this.fail('保存失败', error)
				}
				this.busy = false
			},

			// ---------------- 诊断 ----------------

			toggleDiag() {
				this.diagOpen = !this.diagOpen
				if (this.diagOpen) this.refreshDiag()
			},

			refreshDiag() {
				const info = getDiagnostics()
				const hands = getHands()
				const handText = hands[0] && hands[0].data
					? hands.length + ' 帧，' + hands[0].width + '×' + hands[0].height
					: '解码失败'
				this.diagLines = [
					'平台：' + info.platform + '（' + info.system + '）',
					'canvas 节点：' + info.canvasNode,
					'最近读到的像素：' + info.readBytes + ' 字节',
					'头像读取边长：' + this.avatarEdge + 'px（方形 target）',
					'手部素材：' + handText,
					'预览帧文件：' + this.frameSrcs.length + ' 个',
					'最近一次错误：' + (info.lastError || '无')
				]
			},

			fail(title, error, hint) {
				const message = (error && (error.message || error.errMsg)) || String(error)
				this.errorText = title + '：' + message + (hint ? '\n' + hint : '')
				noteError(title + '：' + message)
				if (this.diagOpen) this.refreshDiag()
				uni.showToast({ title: title, icon: 'none' })
				console.error('[petpet] ' + title, error)
			}
		}
	}
</script>

<style>
	.page {
		min-height: 100vh;
		padding: 32rpx 24rpx 64rpx;
		box-sizing: border-box;
		background-color: #F5F6FA;
	}

	.card {
		margin-bottom: 24rpx;
		padding: 32rpx 28rpx;
		background-color: #FFFFFF;
		border-radius: 20rpx;
		box-shadow: 0 4rpx 16rpx rgba(31, 35, 41, 0.06);
	}

	.label {
		display: block;
		font-size: 30rpx;
		font-weight: 500;
		color: #1F2329;
	}

	.hint {
		display: block;
		margin-top: 10rpx;
		font-size: 24rpx;
		line-height: 36rpx;
		color: #8F9299;
	}

	.row {
		display: flex;
		flex-direction: row;
		align-items: center;
		justify-content: space-between;
	}

	.switch {
		transform: scale(0.85);
	}

	.slot {
		flex: 1;
		height: 220rpx;
		margin-right: 20rpx;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		background-color: #F2F3F7;
		border-radius: 16rpx;
		overflow: hidden;
	}

	.slot:last-child {
		margin-right: 0;
	}

	.slot-wide {
		width: 100%;
		height: 300rpx;
		margin: 20rpx 0 0;
	}

	.slot-hover {
		opacity: 0.7;
	}

	.slot-image {
		width: 100%;
		flex: 1;
	}

	.slot-plus {
		font-size: 56rpx;
		color: #B6BAC3;
	}

	.actions {
		margin-bottom: 24rpx;
		display: flex;
		flex-direction: row;
	}

	.btn {
		flex: 1;
		margin: 0 8rpx;
		font-size: 30rpx;
		border-radius: 44rpx;
	}

	.btn-primary {
		background-color: #5B8FF9;
		color: #FFFFFF;
	}

	.btn-primary[disabled] {
		background-color: #B9CFFB;
		color: #FFFFFF;
	}

	.btn-plain {
		background-color: #FFFFFF;
		color: #5A5F6B;
	}

	.btn-plain[disabled] {
		color: #B6BAC3;
	}

	.stage {
		margin-top: 20rpx;
		height: 420rpx;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 20rpx;
		overflow: hidden;
	}

	.stage-white {
		background-color: #FFFFFF;
		border: 2rpx solid #E6E8EE;
	}

	.stage-image {
		width: 100%;
		height: 100%;
	}

	.link {
		display: block;
		margin-top: 20rpx;
		font-size: 26rpx;
		color: #5B8FF9;
	}

	.error {
		display: block;
		margin-bottom: 16rpx;
		padding: 20rpx 24rpx;
		font-size: 24rpx;
		line-height: 36rpx;
		color: #E8684A;
		background-color: #FDF0EC;
		border-radius: 16rpx;
	}

	.diag {
		margin-top: 8rpx;
	}

	.diag-body {
		margin-top: 12rpx;
		padding: 20rpx 24rpx;
		background-color: #F2F3F7;
		border-radius: 16rpx;
	}

	.diag-line {
		display: block;
		font-size: 22rpx;
		line-height: 34rpx;
		color: #5A5F6B;
	}

	.hidden-canvas {
		position: fixed;
		left: -9999px;
		top: 0;
	}
</style>
