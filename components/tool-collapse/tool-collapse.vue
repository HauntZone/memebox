<template>
	<view class="tool-collapse" :class="{ 'tool-collapse-spaced': spaced }">
		<view class="tc-head" hover-class="tc-head-hover" @click="toggle">
			<text class="tc-title">{{ title }}</text>
			<view class="tc-right">
				<text v-if="!open && summary" class="tc-summary">{{ summary }}</text>
				<view class="tc-arrow" :class="{ 'tc-arrow-open': open }"></view>
			</view>
		</view>
		<view v-if="open" class="tc-body">
			<slot></slot>
		</view>
	</view>
</template>

<script>
	/**
	 * 可折叠区块：一行「标题 + 当前状态 + 箭头」，点一下展开 / 收起。
	 *
	 * 刻意做成**区块级**而不是卡片级 —— `.card` 外壳仍由各页自己提供，所以同一张卡片里
	 * 可以「常用项露在外面、不常用项折在下面」，不必把现有卡片拆成两张卡。
	 *
	 * 展开态是组件自己的 data（非受控），页面离开或切 Tab 重建时就回到初始值 ——
	 * 这正是「初始折叠」要的语义，页面不用为它维护任何状态。
	 *
	 * **正文必须用 v-if 而不是 v-show**：`tool-slider` 在 mounted 里量轨道宽度，
	 * `display: none` 时 boundingClientRect 的宽度是 0，量测会静默失败、把轨道宽度留成 0。
	 *
	 * **只给 pages/image 分包里的页面用。** 它要是也被 pages/tools 的页面引用，按分包规则
	 * 就会被两个分包同时依赖、只能留在主包，「主包只留首页」这条就破了 —— 所以二维码页
	 * 刻意没有折叠（它本来也只有「容错级别」一项可折，不值得付这个代价）。
	 */
	export default {
		name: 'tool-collapse',
		props: {
			title: { type: String, default: '' },
			// 折起来时显示的一行当前状态。**不要省**：折起来就看不到里面被改过没有了，
			// 告警（比如「有字符没渲染出来」）也必须提到这里，否则会被一起折掉。
			summary: { type: String, default: '' },
			defaultOpen: { type: Boolean, default: false },
			// 同一张卡片里不是第一行时打开，替代原来的 .row-spaced（和 tool-slider 同一个约定）
			spaced: { type: Boolean, default: false }
		},
		data() {
			return { open: this.defaultOpen }
		},
		methods: {
			toggle() {
				this.open = !this.open
			}
		}
	}
</script>

<style scoped>
	.tool-collapse-spaced {
		margin-top: 32rpx;
	}

	.tc-head {
		display: flex;
		flex-direction: row;
		align-items: center;
		justify-content: space-between;
		/* 上下各留一点：标题本身只有 30rpx 高，直接当热区点太窄 */
		padding: 10rpx 0;
	}

	.tc-head-hover {
		opacity: 0.6;
	}

	.tc-title {
		font-size: 30rpx;
		font-weight: 500;
		color: #1F2329;
	}

	.tc-right {
		display: flex;
		flex-direction: row;
		align-items: center;
	}

	/* 单行省略：摘要长了不能把标题挤掉。它在 flex 行里，会被块化成 block，
	   所以 max-width / overflow 是生效的（mini-program 的 <text> 也是同一套规则） */
	.tc-summary {
		max-width: 400rpx;
		margin-right: 16rpx;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		font-size: 24rpx;
		color: #8F9299;
	}

	/* 箭头用 border 拼，不用 ▾ 这类字符 —— 不依赖各端字体有没有那个字形 */
	.tc-arrow {
		width: 0;
		height: 0;
		border-left: 10rpx solid transparent;
		border-right: 10rpx solid transparent;
		border-top: 12rpx solid #B6BAC3;
		transition: transform 0.18s;
	}

	.tc-arrow-open {
		transform: rotate(180deg);
	}

	.tc-body {
		margin-top: 8rpx;
	}
</style>
