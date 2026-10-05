/**
 * 摸头表情的平台适配层。和 phantomTankAdapter.js / prismTankAdapter.js 一样只是薄壳：
 * 平台代码全在 common/imagePlatform.js 里，这里只填入与摸头表情绑定的两个常量
 * （隐藏画布的 id、自己写出来的文件名前缀），页面从本文件 import，于是页面里不出现平台常量。
 */
import {
	platformName, noteError, getDiagnostics, chooseImages, getImageSize, saveGif,
	readPixels as readPixelsPlatform,
	exportPng as exportPngPlatform,
	exportGif as exportGifPlatform,
	releaseImage as releaseImagePlatform
} from './imagePlatform.js'

const CANVAS_ID = 'petpetCanvas' // 要和 petpet.vue 模板里的隐藏画布 id 一致
const FILE_PREFIX = 'petpet-' // 只用来认出「哪些文件是我们自己写出来的」

export { platformName, noteError, getDiagnostics, chooseImages, getImageSize, saveGif }

export function readPixels(path, target, source, instance) {
	return readPixelsPlatform(path, target, source, instance, CANVAS_ID)
}
/** 导出单帧 PNG —— 摸头表情的实时预览是把五帧落成临时文件后轮换 <image> 播放的 */
export function exportPng(image) {
	return exportPngPlatform(image, FILE_PREFIX)
}
/** 导出成品 GIF，字节来自 common/gifWriter.js */
export function exportGif(bytes) {
	return exportGifPlatform(bytes, FILE_PREFIX)
}
export function releaseImage(src) {
	return releaseImagePlatform(src, FILE_PREFIX)
}
