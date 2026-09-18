# 墨迹 · 小说抄写工作台

一个自用的抄写练笔工具：导入一本对标书，左边原文、右边抄写区，逐字对照，
抄错的字会变红，今天抄了多少字、练了多久自动记着。

`v0.1` · 数据存在本机，不联网、不上传。

## 为什么写它

抄书是一种练笔办法：找新书榜里百万字以内、非大神白金作者的题材对标书，
对准免费章节分屏照抄，每天四到六千字，边抄边想人家为什么这么写剧情、怎么安排节奏
（这个分法来自起点编辑星河的分享）。

用记事本对着抄不太顺手 —— 不知道抄了多少字、抄错的是哪个字、今天练够没有。
就写了这个工具，先给自己用。

不同短板练的东西不一样，大致是：

| 短板 | 抄什么 | 抄的时候想什么 |
| --- | --- | --- |
| 文笔差、思路还行 | 对标书的免费章节，每天 4000–6000 字 | 好词句单独存一份；他的节奏怎么安排、人设怎么立、哪里点到为止 |
| 文笔还行、题材思路跟不上 | 新书榜前 200 的简介、书名、开头三章 | 题材怎么选、人设标签怎么打、前期剧情怎么排；再往后拆第一个大高潮如何落地 |
| 两样都差 | 上面的都做，量加到每一天一万字以上 | 代入感、期待感、情绪反馈这些最基础的东西 |

再往上（靠写书有了点收入，或者写得久了），做法会变成"摘抄开头和高潮段落保持手感"、
"拆本章说、拆市场"。核心都是别停下积累 —— 这个工具主要服务的是前面那段对着抄的练习，
后面那些更多靠笔记软件和自己的整理。

## 它做什么

| 练笔时要做的事 | 工具里的做法 |
| --- | --- |
| 分屏对照、照着抄 | 左原文、右抄写区，两栏**同宽、同起点、逐行对齐**；写到最后一行立即整行下滚，抄写区底部常年空出一行，方便看另一侧 |
| 一眼看出抄错哪个字 | 逐字校对：写对的字黑色、写错的字红色；「校对清单」列出每处偏差，点一下光标跳到那个字 |
| 抄完一段回看 | 光标所在句单独显示；原文栏与抄写栏按同一行坐标双向同步滚动 |
| 摘抄好词句 | 全文搜索能定位到原文任意位置并高亮；选中文字即反色。整理交给笔记软件，工具只保证你抄得到 |
| 每天要够量 | 侧栏实时显示已抄字数、本次时长、平均速度、完成度、错误字数；左侧「今日小目标」盯着当天进度 |
| 长期不断 | 统计页：连续天数、历史最长连续、最近 7 天柱状图、与上一周期对比 |
| 按章拆书 | 章节目录支持逐章重置 / 删除；导入时自动识别「第 X 章」「序章」「Chapter 1」切分章节，超大章节自动再拆成能一次抄完的段落 |
| 各种 TXT | 自动识别 UTF-8 / UTF-16 / GB18030-GBK，识别不准可在左侧手动切换 |

## 快速开始

**桌面版**（Tauri：独立窗口，可打成安装包，数据在本机）：

```bash
npm install            # 第一次
npm run app:dev        # 开发：前端热更新 + 打开窗口
npm run app:build      # 打包：NSIS 安装包落在 src-tauri/target/release/bundle/
```

需要 Node 20+ 与 Rust 工具链（Windows 上走 MSVC）。Rust 用 scoop 装最省事：

```bash
scoop install rustup
rustup default stable-msvc
```

（MSVC 那一环没有包管理器能代劳，装 Visual Studio Build Tools 的
「C++ 生成工具」工作负载即可，约 3GB。）

前端是 Vue 3 + Vite，数据层是 Rust + SQLite —— 编译产物约 4MB，
不依赖 Python，也不开任何端口。

**浏览器模式**（改前端不用等编译，适合边写边调）：

```bash
npm run build          # 生成 dist/
python -m server --open
```

Python 后端只用标准库（3.10+），端点与 Rust 端一一对应。Windows 上也可以直接双击
`启动墨迹.cmd`：起服务、开浏览器，连点两下不会起两个实例。

## 上手三步

1. 点左侧「导入新小说」，选一个 `.txt` / `.md` / `.text`（对标书正文，或自己整理的拆书笔记）。
2. 在章节目录里选一章，点「开始抄写」，直接在右侧敲 —— 抄错的字会变红。
3. 抄完一段点「校对清单」回看偏差；字数与时长会自动记下来。

快捷键：`Tab` 下一章 · `Ctrl/Cmd + Enter` 完成本章 · `Esc` 退出专注模式。

## 架构

```
src/                 前端：Vue 3 + Vite
  api/index.js       数据层：桌面里走 IPC，浏览器里走 HTTP（方法名与返回形状一致）
  core/              纯计算层：统计、编码探测、文本与校对（Node 侧有 82 项回归测试）
  composables/       全局状态：书架、会话计时与落库、统计合成
  components/        视图：工作台 / 章节目录 / 统计 / 设置
public/              原样进 dist 的静态资源（PWA 的 manifest、图标、service worker）
src-tauri/           桌面版：Tauri 2 + Rust
  src/store.rs       SQLite 持久层：六张表 + daily 物化视图
  src/commands.rs    IPC 命令（与 HTTP 端点一一对应）
server/              浏览器模式的后端：Python 标准库 + SQLite，零第三方依赖
scripts/             构建辅助（打安装包、生成图标）
verify/              回归检查（Node 单测 + CDP 驱动真实浏览器）
docs/                使用说明
```

前端只有 `dist/` 一份（`npm run build` 的产物）：桌面版把它嵌进二进制，
浏览器模式由 Python 后端托管 —— 两种打开方式看到的是同一个界面。

两条数据通道（IPC / HTTP）的端点一一对应，加功能时两端各加一个端点，
再往 `src/api/index.js` 加一个方法。

后端只负责存、不算：统计、校对、完成度都放在前端的纯函数里（有 82 项 Node 测试
盯着），`daily` 由后端在写入会话的同一个事务里从 `sessions` 重算 ——
统计口径只有一个来源。

桌面版不开任何端口；浏览器模式下 Python 服务只监听 `127.0.0.1`，
也只对本机来源（`127.0.0.1` / `localhost`）回 CORS 头。
想把前端单独部署（前端 5173、后端 8000），在页面里写上后端地址即可：

```html
<meta name="moji-api" content="http://127.0.0.1:8000" />
```

## 数据存在哪

```
Windows       %LOCALAPPDATA%\MoJi\moji.sqlite3
Linux / macOS ~/.local/share/moji/moji.sqlite3
```

一个 SQLite 文件就是全部数据，桌面版与命令行版共用这一份；`MOJI_DATA_DIR` 可以整体挪走。
备份就是复制这个文件，或者用设置里的「导出备份」。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 服务与数据库状态 |
| GET | `/api/bootstrap` | 一次性取全量：books / progress / sessions / daily / settings |
| GET | `/api/export` | 导出完整备份（JSON） |
| POST | `/api/import?mode=merge\|overwrite` | 导入备份 |
| PUT | `/api/books/{id}` | 整本书写入（元信息 + 章节正文 + 每章进度，同事务） |
| DELETE | `/api/books/{id}` | 删除书及其章节、进度 |
| PUT | `/api/books/{id}/progress/{index}` | 单章进度（打字时高频调用） |
| PUT | `/api/sessions/{id}` | 写入／覆盖一次练习会话，返回重算后的当日汇总 |
| DELETE | `/api/sessions` | 清空练习记录 |
| PUT | `/api/settings/{key}` | 写一条设置 |

## 测试

```bash
# 后端：持久层 + HTTP 层（37 项）
python -m unittest discover -s server/tests -t .

# 前端纯计算层（Node）
node verify/test-stats.js          # 统计 82 项
node verify/test-encoding.js       # 编码探测 21 项

# 界面回归：CDP 驱动真实浏览器（附着方式见 verify/cdp-attach.js 顶部注释）
npm run build                                      # 先生成 dist/
python -m server --port 41777 --db ./test.sqlite3  # 用临时库起后端，别动真实数据
node verify/cdp-attach.js <debugPort> verify/checks-vue-app.js   # 62 项，全部从用户视角看
```

写的时候踩过的坑都留了注释：为什么落库要每 5 秒一次、为什么退出时要留一份快照、
为什么速度的分子分母必须同口径、为什么原文轨道（`<pre>`）也得套上正文的字体声明 ——
这些在界面上只表现为"数字不太对"或者"两栏悄悄错行"，肉眼很难发现，
所以每条都配了回归检查。界面这一份刻意不碰内部状态：导入是构造 File 塞进
`input[type=file]`，重开软件是新建一个 iframe，结算靠切书触发 —— 走的都是用户的路。

## 许可

自用项目，顺手开源，按原样提供（尚未指定开源许可证）。
