<template>
	<view class="page">
		<!-- ==================== 阵型 ==================== -->
		<view class="card">
			<text class="label">阵型</text>
			<view class="pills">
				<view
					v-for="item in presetOptions"
					:key="item.key"
					class="pill"
					:class="{ 'pill-on': item.key === presetKey }"
					:hover-class="item.key === presetKey ? '' : 'pill-hover'"
					@click="choosePreset(item.key)"
				>
					<text class="pill-text" :class="{ 'pill-text-on': item.key === presetKey }">{{ item.name }}</text>
				</view>
			</view>

			<text class="label label-spaced">配色</text>
			<view class="pills">
				<view
					v-for="(item, index) in colorOptions"
					:key="item.key"
					class="swatch"
					:class="{ 'swatch-on': index === colorIndex }"
					:hover-class="index === colorIndex ? '' : 'pill-hover'"
					@click="chooseColor(index)"
				>
					<view class="swatch-dot" :style="{ background: item.hex }"></view>
					<text class="pill-text" :class="{ 'pill-text-on': index === colorIndex }">{{ item.name }}</text>
				</view>
			</view>

			<view class="actions actions-inline">
				<button class="btn btn-plain" :disabled="busy" @click="reroll">换一个</button>
			</view>
			<text class="hint">种子 {{ displaySeed }}；同一个种子每次都会给出同一张图，换一个就是换种子。</text>
		</view>

		<!-- ==================== 样式 ==================== -->
		<view class="card">
			<tool-slider
				label="复杂度"
				:value="complexity"
				:min="complexityMin"
				:max="complexityMax"
				:step="1"
				@changing="onParamChanging('complexity', $event)"
				@change="onParamChange('complexity', $event)"
			/>
			<tool-slider
				label="线宽"
				:spaced="true"
				:value="lineWidth"
				:min="lineWidthMin"
				:max="lineWidthMax"
				:step="1"
				@changing="onParamChanging('lineWidth', $event)"
				@change="onParamChange('lineWidth', $event)"
			/>
			<tool-slider
				label="辉光"
				:spaced="true"
				:value="glow"
				:min="glowMin"
				:max="glowMax"
				:step="1"
				@changing="onParamChanging('glow', $event)"
				@change="onParamChange('glow', $event)"
			/>
			<tool-slider
				label="符文密度"
				:spaced="true"
				:value="runeDensity"
				:min="runeDensityMin"
				:max="runeDensityMax"
				:step="1"
				@changing="onParamChanging('runeDensity', $event)"
				@change="onParamChange('runeDensity', $event)"
			/>
			<text class="hint">复杂度是图层的层数；辉光为 0 时是纯线条。</text>
		</view>

		<!-- ==================== 预览 ==================== -->
		<view class="card">
			<text class="label">预览</text>
			<text class="hint">预览压黑底显示 —— 发光的效果只在深色背景上成立。黑底 / 透明底的区别只影响保存的 PNG。</text>
			<view class="stage stage-dark">
				<image v-if="previewSrc" class="stage-image" :src="previewSrc" mode="aspectFit"></image>
				<text v-else class="stage-empty">正在生成…</text>
			</view>
		</view>

		<!-- ==================== 保存 PNG ==================== -->
		<view class="card">
			<text class="label">保存 PNG</text>
			<view class="pills">
				<view
					v-for="item in edgeOptions"
					:key="item"
					class="pill"
					:class="{ 'pill-on': item === exportEdge }"
					:hover-class="item === exportEdge ? '' : 'pill-hover'"
					@click="exportEdge = item"
				>
					<text class="pill-text" :class="{ 'pill-text-on': item === exportEdge }">{{ item }}</text>
				</view>
			</view>
			<view class="row row-spaced">
				<text class="label">透明底</text>
				<switch class="switch" color="#5B8FF9" :checked="transparent" @change="onTransparentChange" />
			</view>
			<text class="hint">长边像素，越大越清晰、也越慢。透明底适合再叠到别的图上；关掉则是黑底成品。</text>
			<view class="actions">
				<button class="btn btn-primary" :disabled="busy" @click="saveImage">
					{{ busyPng ? '处理中...' : '保存 PNG' }}
				</button>
			</view>
		</view>

		<!-- ==================== 动画 ==================== -->
		<view class="card">
			<text class="label">旋转动画</text>
			<view class="pills">
				<view
					v-for="item in frameOptions"
					:key="'f' + item"
					class="pill"
					:class="{ 'pill-on': item === gifFrames }"
					:hover-class="item === gifFrames ? '' : 'pill-hover'"
					@click="gifFrames = item"
				>
					<text class="pill-text" :class="{ 'pill-text-on': item === gifFrames }">{{ item }} 帧</text>
				</view>
				<view
					v-for="item in gifEdgeOptions"
					:key="'e' + item"
					class="pill"
					:class="{ 'pill-on': item === gifEdge }"
					:hover-class="item === gifEdge ? '' : 'pill-hover'"
					@click="gifEdge = item"
				>
					<text class="pill-text" :class="{ 'pill-text-on': item === gifEdge }">{{ item }}px</text>
				</view>
			</view>
			<tool-slider
				label="转速"
				:spaced="true"
				:value="delay"
				:min="delayMin"
				:max="delayMax"
				:step="1"
				@changing="onDelayChanging"
				@change="onDelayChange"
			/>
			<text class="hint">每帧 {{ delay * 10 }}ms。动图必须是不透明的 —— GIF 只有「透明 / 不透明」两档，装不下辉光那种从 0 渐变的半透明，硬压会截出一圈硬边。所以这里恒为黑底。</text>
			<view class="actions">
				<button class="btn btn-primary" :disabled="busy" @click="generateGif">
					{{ busyGif ? '正在生成动画...' : '生成并保存 GIF' }}
				</button>
			</view>
			<view v-if="gifSrc" class="stage stage-dark">
				<image class="stage-image" :src="gifSrc" mode="aspectFit"></image>
			</view>
			<text v-if="gifInfo" class="hint">{{ gifInfo }}</text>
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
	</view>
</template>

<script>
	import {
		MAGIC_LIMITS, MAGIC_PRESETS, createFigure, renderFigure, renderFrames, composeCircleGif
	} from '@/common/magicCircle.js'
	import { composite } from '@/common/imageGeometry.js'
	import ToolSlider from '@/components/tool-slider/tool-slider.vue'
	import {
		exportPng, exportGif, savePng, releaseImage, getDiagnostics, noteError
	} from '@/common/magicAdapter.js'

	// 预览文件的防抖。渲染本身只要几毫秒，贵的是落一个临时文件 —— 拖动时不值得每帧都写。
	const PREVIEW_DEBOUNCE = 140

	// 预览恒按这个尺寸渲染，没有「全分辨率预览」这一档：全分辨率只在保存时算一次。
	// 所以也不需要 staleFull 那种门禁 —— 预览永远是最新的。
	const PREVIEW_EDGE = MAGIC_LIMITS.previewEdge

	/** 预设自己的推荐配色。预设名与色号都从内核里取，这个页面不另存一份。 */
	function presetColorIndex(key) {
		const preset = MAGIC_PRESETS[key]
		if (!preset) return 0
		const index = MAGIC_LIMITS.colors.findIndex(function (c) { return c.key === preset.colorKey })
		return index >= 0 ? index : 0
	}

	export default {
		components: { ToolSlider },
		data() {
			return {
				presetKey: 'pentagram',
				seed: 20261006,
				colorIndex: 0,

				complexity: MAGIC_LIMITS.complexityDefault,
				lineWidth: MAGIC_LIMITS.lineWidthDefault,
				glow: MAGIC_LIMITS.glowDefault,
				runeDensity: MAGIC_LIMITS.runeDensityDefault,
				complexityMin: MAGIC_LIMITS.complexityRange[0],
				complexityMax: MAGIC_LIMITS.complexityRange[1],
				lineWidthMin: MAGIC_LIMITS.lineWidthRange[0],
				lineWidthMax: MAGIC_LIMITS.lineWidthRange[1],
				glowMin: MAGIC_LIMITS.glowRange[0],
				glowMax: MAGIC_LIMITS.glowRange[1],
				runeDensityMin: MAGIC_LIMITS.runeDensityRange[0],
				runeDensityMax: MAGIC_LIMITS.runeDensityRange[1],

				transparent: false,
				exportEdge: MAGIC_LIMITS.exportEdgeDefault,
				edgeOptions: MAGIC_LIMITS.exportEdges,

				gifFrames: MAGIC_LIMITS.frameDefault,
				gifEdge: MAGIC_LIMITS.gifEdgeDefault,
				frameOptions: MAGIC_LIMITS.frameOptions,
				gifEdgeOptions: MAGIC_LIMITS.gifEdges,
				delay: MAGIC_LIMITS.delayDefault,
				delayMin: MAGIC_LIMITS.delayRange[0],
				delayMax: MAGIC_LIMITS.delayRange[1],

				previewSrc: '',
				pngSrc: '',
				previewTimer: null,
				renderToken: 0,
				renderMs: 0,
				layerCount: 0,
				runeCount: 0,

				gifSrc: '',
				gifInfo: '',

				busyPng: false,
				busyGif: false,
				errorText: '',
				diagOpen: false,
				diagLines: []
			}
		},
		computed: {
			busy() {
				return this.busyPng || this.busyGif
			},
			displaySeed() {
				return String(this.seed)
			},
			presetOptions() {
				const keys = MAGIC_LIMITS.presetKeys
				const out = []
				for (let i = 0; i < keys.length; i++) {
					out.push({ key: keys[i], name: MAGIC_PRESETS[keys[i]].name })
				}
				return out
			},
			colorOptions() {
				return MAGIC_LIMITS.colors
			}
		},
		onLoad() {
			this.renderPreviewNow()
		},
		onUnload() {
			if (this.previewTimer) {
				clearTimeout(this.previewTimer)
				this.previewTimer = null
			}
			// 自己写出来的文件是持久化的，离开页面必须显式删（见 CLAUDE.md 的坑 4）
			this.renderToken++
			releaseImage(this.previewSrc)
			this.previewSrc = ''
			releaseImage(this.pngSrc)
			this.pngSrc = ''
			releaseImage(this.gifSrc)
			this.gifSrc = ''
			previewCache = null
		},
		methods: {
			// ---------------------------------------------------------- 参数
			currentParams() {
				return {
					complexity: this.complexity,
					lineWidth: this.lineWidth,
					glow: this.glow,
					runeDensity: this.runeDensity,
					colorIndex: this.colorIndex
				}
			},
			currentFigure() {
				return createFigure({
					presetKey: this.presetKey,
					seed: this.seed,
					params: this.currentParams()
				})
			},
			choosePreset(key) {
				if (key === this.presetKey || this.busy) return
				this.presetKey = key
				// 换阵型时把配色跟着换掉，否则六套阵都用同一个颜色，分不出区别
				this.colorIndex = presetColorIndex(key)
				this.schedulePreview(0)
			},
			chooseColor(index) {
				if (index === this.colorIndex || this.busy) return
				this.colorIndex = index
				this.schedulePreview(0)
			},
			reroll() {
				if (this.busy) return
				// 种子本身用 Math.random 无所谓 —— 可复现的是「给定种子」，不是「种子怎么来的」
				this.seed = Math.floor(Math.random() * 0xffffffff) >>> 0
				this.schedulePreview(0)
			},
			onParamChanging(name, value) {
				this[name] = value
				this.schedulePreview(PREVIEW_DEBOUNCE)
			},
			onParamChange(name, value) {
				this[name] = value
				this.schedulePreview(0)
			},
			onDelayChanging(value) {
				this.delay = value
			},
			onDelayChange(value) {
				this.delay = value
			},
			onTransparentChange(event) {
				this.transparent = event.detail.value
			},

			// ---------------------------------------------------------- 预览
			schedulePreview(delay) {
				if (this.previewTimer) clearTimeout(this.previewTimer)
				if (!delay) {
					this.previewTimer = null
					this.renderPreviewNow()
					return
				}
				this.previewTimer = setTimeout(() => {
					this.previewTimer = null
					this.renderPreviewNow()
				}, delay)
			},
			async renderPreviewNow() {
				const token = ++this.renderToken
				try {
					const figure = this.currentFigure()
					const started = Date.now()
					const rendered = renderFigure(figure, { size: PREVIEW_EDGE })
					const flat = composite({ image: rendered, background: 0 })
					const elapsed = Date.now() - started

					const out = await exportPng(flat)

					// 领号之后又有人发起了新的一轮，自己这份就是过期的：
					// 把它删掉、什么都不写，免得晚到的旧结果盖掉新结果。
					if (token !== this.renderToken) {
						releaseImage(out.src)
						return
					}

					releaseImage(this.previewSrc)
					this.previewSrc = out.src
					this.renderMs = elapsed
					this.layerCount = figure.stats.layerCount
					this.runeCount = figure.stats.runeCount
					this.errorText = ''
					if (this.diagOpen) this.refreshDiag()
				} catch (error) {
					this.fail('预览失败', error)
				}
			},

			// ---------------------------------------------------------- 保存 PNG
			async saveImage() {
				if (this.busy) return
				this.busyPng = true
				uni.showLoading({ title: '正在渲染...' })
				try {
					const figure = this.currentFigure()
					const rendered = renderFigure(figure, { size: this.exportEdge })
					const image = this.transparent ? rendered : composite({ image: rendered, background: 0 })
					const out = await exportPng(image)
					// 存完不立刻回收：H5 的下载走的是这个 src 上的 blob URL，
					// 当场撤掉可能把还在进行的下载打断。留着，由 onUnload / 下一次保存来清。
					releaseImage(this.pngSrc)
					this.pngSrc = out.src
					await savePng(out.src, 'magic-circle.png')
					uni.hideLoading()
					uni.showToast({ title: '已保存' })
				} catch (error) {
					uni.hideLoading()
					this.fail('保存失败', error, this.saveHint())
				} finally {
					this.busyPng = false
				}
			},
			saveHint() {
				return '保存到相册需要照片 / 存储权限。权限被拒过之后系统不会再弹窗，请到手机「设置 → 应用 → 本应用 → 权限」里手动打开。'
			},

			// ---------------------------------------------------------- 动画
			async generateGif() {
				if (this.busy) return
				this.busyGif = true
				uni.showLoading({ title: '正在生成动画...' })
				try {
					const figure = this.currentFigure()
					const raw = renderFrames(figure, { size: this.gifEdge, frames: this.gifFrames })
					// GIF 只有开关式透明，装不下辉光的渐变，所以恒压黑底（见 composeCircleGif 的注释）
					const frames = []
					for (let i = 0; i < raw.length; i++) {
						frames.push(composite({ image: raw[i], background: 0 }))
					}

					const result = composeCircleGif({ frames, delayCs: this.delay })
					const out = await exportGif(result.bytes)

					releaseImage(this.gifSrc)
					this.gifSrc = out.src
					this.gifInfo = Math.round(result.bytes.length / 1024) + 'KB · ' + result.frameCount +
						' 帧 · 每帧 ' + this.delay * 10 + 'ms · ' + result.palette.length + ' 色调色板'
					uni.hideLoading()
					await savePng(out.src, 'magic-circle.gif')
					uni.showToast({ title: '已保存' })
				} catch (error) {
					uni.hideLoading()
					this.fail('生成失败', error, this.saveHint())
				} finally {
					this.busyGif = false
				}
			},

			// ---------------------------------------------------------- 诊断与错误
			fail(title, error, hint) {
				const message = (error && (error.message || error.errMsg)) || String(error)
				this.errorText = title + '：' + message + (hint ? '\n' + hint : '')
				noteError(title + '：' + message)
				if (this.diagOpen) this.refreshDiag()
				uni.showToast({ title: title, icon: 'none' })
				console.error('[magic-circle] ' + title, error)
			},
			toggleDiag() {
				this.diagOpen = !this.diagOpen
				if (this.diagOpen) this.refreshDiag()
			},
			refreshDiag() {
				const info = getDiagnostics()
				// 刻意不显示 canvas 节点：这个页面不走画布，那个字段是 imagePlatform 的模块级单例，
				// 这里读到的是上一个页面的陈旧读数，放上来只会误导排查。
				this.diagLines = [
					'平台：' + info.platform + '（' + info.system + '）',
					'阵型：' + MAGIC_PRESETS[this.presetKey].name + ' · 种子 ' + this.seed,
					'图层：' + this.layerCount + ' 层（其中符文 ' + this.runeCount + ' 个）',
					'预览：' + PREVIEW_EDGE + '² 渲染 ' + this.renderMs + 'ms',
					'预览临时文件：' + (this.previewSrc ? '1 个' : '无'),
					'成品 GIF：' + (this.gifInfo || '无'),
					'最近一次错误：' + (info.lastError || '无')
				]
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

	.label-spaced {
		margin-top: 32rpx;
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

	.row-spaced {
		margin-top: 32rpx;
	}

	.switch {
		transform: scale(0.85);
	}

	.pills {
		display: flex;
		flex-direction: row;
		flex-wrap: wrap;
		margin-top: 16rpx;
	}

	.pill {
		margin: 0 16rpx 16rpx 0;
		padding: 12rpx 28rpx;
		background-color: #F2F3F7;
		border-radius: 32rpx;
	}

	.pill-on {
		background-color: #5B8FF9;
	}

	.pill-hover {
		opacity: 0.7;
	}

	.pill-text {
		font-size: 26rpx;
		color: #5A5F6B;
	}

	.pill-text-on {
		color: #FFFFFF;
	}

	.swatch {
		margin: 0 16rpx 16rpx 0;
		padding: 10rpx 24rpx 10rpx 12rpx;
		display: flex;
		flex-direction: row;
		align-items: center;
		background-color: #F2F3F7;
		border-radius: 32rpx;
	}

	.swatch-on {
		background-color: #5B8FF9;
	}

	.swatch-dot {
		width: 28rpx;
		height: 28rpx;
		margin-right: 12rpx;
		border-radius: 14rpx;
	}

	.actions {
		margin-top: 24rpx;
		display: flex;
		flex-direction: row;
	}

	.actions-inline {
		margin-top: 20rpx;
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
		height: 520rpx;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 20rpx;
		overflow: hidden;
	}

	/* 深色底：预览压的就是纯黑，所以舞台也用纯黑，不然会看出接缝 */
	.stage-dark {
		background-color: #000000;
	}

	.stage-image {
		width: 100%;
		height: 100%;
	}

	.stage-empty {
		font-size: 26rpx;
		color: #5A5F6B;
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
</style>
