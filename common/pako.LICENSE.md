(The MIT License)

Copyright (C) 2014-2017 by Vitaly Puzrin and Andrei Tuputcyn

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

---

## 本项目的改动（升级 pako 之后要重新打上）

### 1. 去掉注释里的 `#ifdef` / `#endif`（`pako.js` 的 `tr_static_init` 附近）

上游的 `pako.js` 在这一带有一段从 zlib 移植过来的注释：

```js
/*#ifdef NO_INIT_GLOBAL_POINTERS
  static_l_desc.static_tree = static_ltree;
  ...
#endif*/
```

**HBuilderX 的条件编译扫描器会把块注释里的 `#ifdef` 当成真指令**，而结尾的 `#endif`
后面紧跟着 `*/`、它认不出是配对的那一行，于是整个编译直接失败：

```
条件编译失败: #ifdef/#ifndef 缺少配对的 #endif
at common/pako.js:429
```

那段代码本来就是注释掉的、在 JS 里完全不执行（pako 的移植版把 zlib 的
`NO_INIT_GLOBAL_POINTERS` 分支整个省了），所以**去掉指令记号不改变任何运行行为** ——
改法是把那几个赋值语句改成 `//` 行注释、并把说明写进一个普通块注释里。

升级 pako 之后照做一遍即可：全文件搜 `/*#ifdef`，把注释里的 `#ifdef` / `#endif`
记号去掉（**只动注释，别动任何真代码**）。用 `grep -n '#ifdef\|#endif'` 复查一遍，
确认剩下的 `#ifdef` 和 `#endif` 数量相等。
