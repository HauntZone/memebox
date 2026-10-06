/**
 * 魔法阵的平台适配层。
 *
 * 和 phantomTankAdapter / prismTankAdapter / petpetAdapter 是同一个套路（平台代码全在
 * imagePlatform.js 里，这里只填与业务绑定的常量），但**明显更薄**：魔法阵不读用户选的图、
 * 不做像素回读，所以既没有 CANVAS_ID，也不需要 readPixels / chooseImages / getImageSize。
 *
 * 它落在平台上的动作只有一件：把自己算出来的 RGBA 写成文件、再存进相册。
 * 也正因为如此，这个工具的页面模板里连隐藏画布节点都没有。
 */
import {
	platformName, noteError, getDiagnostics, savePng,
	exportPng as exportPngPlatform,
	exportGif as exportGifPlatform,
	releaseImage as releaseImagePlatform
} from './imagePlatform.js'

// 只用来认出「哪些文件是我们自己写出来的」，不会出现在用户看到的文件名里
const FILE_PREFIX = 'magic-'

export { platformName, noteError, getDiagnostics, savePng }

/** 导出 PNG。image 只需是 { width, height, data }，纯 JS 编码，不碰画布。 */
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
