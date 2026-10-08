/**
 * 魔法阵的平台适配层。
 *
 * 和 phantomTankAdapter / prismTankAdapter / petpetAdapter 是同一个套路（平台代码全在
 * imagePlatform.js 里，这里只填与业务绑定的常量），页面从本文件 import。
 *
 * 加自定义文字和图片上传之前，这里是四个 adapter 里最薄的一个（不读用户图、不需要画布）。
 * 现在不是了：中文文字要借平台光栅化字形、上传的图要 readPixels，所以它和另外三个一样，
 * 开始需要 CANVAS_ID。
 */
import {
	platformName, noteError, getDiagnostics, savePng, chooseImages, getImageSize,
	readPixels as readPixelsPlatform,
	rasterizeGlyphs as rasterizeGlyphsPlatform,
	exportPng as exportPngPlatform,
	exportGif as exportGifPlatform,
	releaseImage as releaseImagePlatform
} from './imagePlatform.js'

const CANVAS_ID = 'magicCanvas' // 要和 magic-circle.vue 模板里的隐藏画布 id 一致
const FILE_PREFIX = 'magic-' // 只用来认出「哪些文件是我们自己写出来的」

export { platformName, noteError, getDiagnostics, savePng, chooseImages, getImageSize }

// 注意：光栅化的**排版**（planGlyphCanvas 等）是纯计算，定义在 magicText.js 里，
// 页面直接从那边 import —— 不从这里转出去，免得这里看起来像有一份平台实现。

export function readPixels(path, target, source, instance) {
	return readPixelsPlatform(path, target, source, instance, CANVAS_ID)
}

/** 把非 ASCII 字符光栅化成白色蒙版（每个字只做一次，之后纯逻辑复用）。 */
export function rasterizeGlyphs(chars, cellSize, instance) {
	return rasterizeGlyphsPlatform({ chars, cellSize, instance, canvasId: CANVAS_ID })
}

/** 导出 PNG。image 只需是 { width, height, data }，纯 JS 编码。 */
export function exportPng(image) {
	return exportPngPlatform(image, FILE_PREFIX)
}

/** 导出 GIF，字节来自 common/gifWriter.js */
export function exportGif(bytes) {
	return exportGifPlatform(bytes, FILE_PREFIX)
}

export function releaseImage(src) {
	return releaseImagePlatform(src, FILE_PREFIX)
}
