# 摸头表情「手」素材的来源与许可

## 来源

`petpetHands.js` 里内嵌的五张手部 PNG（`0.png` ~ `4.png`）取自开源项目 **meme-generator**：

- 仓库：https://github.com/MeetWq/meme-generator
- 实际下载路径（GitHub 直连不通时走 jsDelivr 镜像）：
  `https://cdn.jsdelivr.net/gh/MeetWq/meme-generator@main/meme_generator/memes/petpet/images/<i>.png`
  （`i` = 0~4）
- 该目录下的五帧素材由 meme-generator 项目整理、又上溯自 NoneBot 的表情包插件生态。

原版「摸头」表情包（`benisland.neocities.org/petpet`）**没有开源**，本项目只把它当作行为参考，
**未从该站点取用任何素材**。

## 下载到的五帧（用于核对素材有没有被换掉）

| 帧 | 字节数 | SHA-256 |
|---|---|---|
| 0.png | 6049 | `69da867cbb64df16fb2eaf43b1e312a33600963fb2e2079c074e55ef4cfa5986` |
| 1.png | 6115 | `7d0dced26c6f6ff6d30b0c9cfd1eabf9bfc897e6fe8ecb28a1cc148d208aae68` |
| 2.png | 6482 | `30707317d526660c41b4d666a404fcd56eebb4a50b8609b70eb2f6aba54e50a1` |
| 3.png | 6197 | `0f3964243f86324185ddb4505a8a41b9395d27a7fd7982cc48a095e3b6b5d428` |
| 4.png | 5652 | `502464be19528bc68872198cd63982edfc1fcaf2501d9ad0e5b7ddc79c578cf6` |

五张都是 112×112、位深 8、颜色类型 6（RGBA）、非隔行。

## 生成 `petpetHands.js` 的步骤

素材固定不变，所以直接转成 base64 内嵌，运行时用 `pngReader.decodePng` 解回像素
（原因见 `petpetHands.js` 开头的注释）。重做一遍的话：

```sh
cd <存放 0.png ~ 4.png 的目录>
for i in 0 1 2 3 4; do base64 -w0 "$i.png"; done
```

把五条 base64 依次填进 `HAND_PNG_B64` 数组即可（顺序就是帧序，和 `petpet.js` 的
`PETPET_LIMITS.locs` 一一对应）。

## 许可（MIT）

```
(The MIT License)

Copyright (C) 2021 MeetWq

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```
