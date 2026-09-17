# 墨迹 · 小说抄写工作台

一个前后端分离的本地应用：把小说文本拆成章节，逐字抄写并即时校对，记录练习进度与统计。

- **前端** `web/`：原生 HTML / CSS / JavaScript，无框架、无构建步骤
- **后端** `server/`：Python 标准库（HTTP + SQLite），**零第三方依赖**
- **数据**：全部存在你自己的机器上，不联网、不上传

## 快速开始

```bash
python -m server --open          # 起服务并打开浏览器（默认 http://127.0.0.1:47299）
python -m server --port 8000     # 指定端口
python -m server --db ./dev.sqlite3   # 指定数据库文件
```

Windows 用户也可以直接用桌面版（自带窗口，不依赖浏览器）：见 [`desktop/使用说明.md`](desktop/使用说明.md)。

## 目录结构

```
web/                 前端（静态资源，可单独部署）
  index.html
  app.js             渲染 / 交互 / 会话计时与落库
  api.js             后端 REST 客户端 —— 前后端之间唯一的通道
  stats.js           统计纯计算层（Node 侧有 82 项回归测试）
  encoding.js        文本编码探测（同）
server/              后端（Python 标准库）
  store.py           SQLite 持久层：六张表 + daily 物化视图
  api.py             REST 路由
  http_app.py        HTTP 服务：静态资源与 API 同端口
  paths.py           数据目录 / 前端目录约定
  tests/             后端回归测试（unittest，36 项）
desktop/             桌面外壳（pywebview + WebView2）
verify/              端到端回归（CDP 驱动真实浏览器）
```

前端与后端同源（一个服务同时给页面和 `/api/*`），所以默认不需要处理跨域；
想把前端单独部署（例如前端 5173、后端 8000），在 `web/index.html` 里写上后端地址即可：

```html
<meta name="moji-api" content="http://127.0.0.1:8000" />
```

后端只接受本机来源（`127.0.0.1` / `localhost`），并只对本机来源回 CORS 头 —— 本地数据库不会被别的网页读走。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 服务与数据库状态（`empty` 表示是否空库） |
| GET | `/api/bootstrap` | 一次性取全量：books / progress / sessions / daily / settings |
| GET | `/api/export` | 导出完整备份（JSON） |
| POST | `/api/import?mode=merge\|overwrite` | 导入备份 |
| PUT | `/api/books/{id}` | 整本书写入（元信息 + 章节正文 + 每章进度，同事务） |
| DELETE | `/api/books/{id}` | 删除书及其章节、进度 |
| PUT | `/api/books/{id}/progress/{index}` | 单章进度（打字时高频调用） |
| PUT | `/api/sessions/{id}` | 写入/覆盖一次练习会话，返回重算后的当日汇总 |
| DELETE | `/api/sessions` | 清空练习记录（sessions + daily） |
| PUT | `/api/settings/{key}` | 写一条设置 |

设计上后端只做持久化，不做业务计算：统计、校对、完成度仍由前端 `stats.js` 负责
（它是纯函数，有 82 项 Node 回归测试；复制一份到 Python 会立刻失去这层保护）。
`daily` 是 `sessions` 的物化视图，由后端在同一个事务里重算 —— 统计口径只有一个来源。

## 数据存在哪

```
Windows:  %LOCALAPPDATA%\MoJi\moji.sqlite3
Linux/macOS:  ~/.local/share/moji/moji.sqlite3
```

桌面版与命令行版本共用这一份数据。用 `MOJI_DATA_DIR` 可以整体挪走（测试、多档案都用它）。
备份就是复制这个文件，或者用界面上的「导出备份」。

## 测试

```bash
# 后端：持久层 + HTTP 层（36 项）
python -m unittest discover -s server/tests -t .

# 前端纯计算层：统计 82 项 / 编码探测
node verify/test-stats.js
node verify/test-encoding.js

# 端到端（CDP 驱动真实浏览器；先起后端）
python -m server --port 41777
node verify/cdp-attach.js <debugPort> verify/checks-features.js            # 64 项：界面与数据层
node verify/cdp-attach.js <debugPort> verify/checks-session-persistence.js # 9 项：会话落库与统计口径
node verify/cdp-attach.js <debugPort> verify/checks-migration.js           # 10 项：旧数据迁移
```

## 从旧版本升级

旧版本把书架、进度与练习记录存在浏览器的 IndexedDB 里。新版第一次打开时，
如果后端还是空库，会自动把旧数据整体搬过来（书架、章节进度、练习记录、设置），
搬完打个标记，只做一次。迁移路径有专门的端到端检查（`verify/checks-migration.js`）。

## 已实现

- 导入 `.txt` / `.md` / `.text`，自动识别 UTF-8、UTF-16、GB18030/GBK；识别「第 X 章」「序章」「Chapter 1」等标题拆分章节；长文本流式读取，超大章节自动再拆。
- 左侧原文 + 右侧逐字校对：正确字黑色、错误字红色；支持标点宽松比对（全角/半角、中英文引号不算错）。
- **两栏逐行对齐**（同宽、同起点、同行数），写到最后一行立即整行下滚，抄写端底部常年留一行空白便于对照。
- 回车自动带入下一行的缩进；行首缩进处按退格一次移除换行与缩进占位。
- 会话计时与落库：练习中每 5 秒静默入库、停笔 2 秒再补一次；切章节、切标签页、关窗口时自动结算；退出时用 localStorage 留一份同步快照，下次启动自动补记（页面被强杀也不丢）。
- 统计：完成度、已抄字数、练习时长、平均速度、正确率、连续天数、最近 7 天柱状图与周期对比。
- 章节搜索、校对清单（点击跳转）、快捷导入、移动端底部导航。
- 快捷键：`Tab` 下一章，`Ctrl/Cmd + Enter` 完成本章，`Esc` 退出专注模式。

## 许可

个人练习项目，按原样提供。
