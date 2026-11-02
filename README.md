# 下载路径助手

一个 Chrome Manifest V3 扩展：为网站关联路径预设，支持默认下载目录内的子目录，以及配套 Windows 辅助程序的绝对路径。中文界面，配置、记录与文件均在本机处理。

## 直接安装

本项目构建后的 `dist` 是可直接加载的扩展目录，`artifacts/download-path-router-0.2.0.zip` 是同一扩展的压缩包。绝对路径还需要安装本项目附带的辅助程序，见下节。

1. 在 Chrome 地址栏输入 `chrome://extensions`。
2. 开启右上角的“开发者模式”。
3. 点击“加载已解压的扩展程序”，选择本项目的 `dist` 文件夹。使用 ZIP 时请先解压，再选择包含 `manifest.json` 的文件夹。
4. 在工具栏扩展菜单中找到“下载路径助手”，进入设置。
5. 在 Chrome 的 `chrome://settings/downloads` 中设置默认下载目录，并关闭“下载前询问每个文件的保存位置”。
6. 设置路径预设，再为实际使用的网站添加规则，最后通过真实下载检查效果。

源码有修改时需要重新运行 `npm run build`，然后在 `chrome://extensions` 页面点击本扩展的重新加载按钮；已打开的设置页也需要刷新。

从 0.1.0 升级时重新加载原 `dist`，保留扩展 ID 和现有配置。新版本增加 `nativeMessaging` 权限；如果 Chrome 要求重新启用扩展，请在扩展管理页面完成启用。旧版相对路径配置可直接继续使用。

## 启用绝对路径

1. 加载新版本扩展，在扩展设置的“使用帮助”中复制当前扩展 ID。
2. 双击项目根目录的 `install-native.cmd`，粘贴该 ID。也可以解压 `artifacts/download-path-router-windows-helper-0.2.0.zip`，双击其中的同名文件。
3. 回到扩展设置，检测 Windows 辅助程序，确认显示版本 `0.2.0`。
4. 在“路径预设”中新建或编辑预设，将目录类型选为“Windows 绝对路径”，填写如 `D:\工作\报表` 或 `E:\软件` 的完整目录。
5. 将网站规则关联到这个预设，完成一次实际下载；最终目录会显示在“最近记录”中，可以打开文件位置。

安装程序仅为当前 Windows 用户注册 Native Messaging，无需管理员权限。辅助程序复制到 `%LOCALAPPDATA%\DownloadPathRouter\host`，授权给填写的扩展 ID。无需为已编译的辅助程序另外安装 Node.js。

如需命令行安装：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/install-native.ps1 -ExtensionId 这里替换为实际扩展ID
```

安装脚本不会改变 Chrome 的默认下载目录。`uninstall-native.cmd` 解除当前用户的辅助程序注册，并保留下载文件和恢复记录。重新在其他目录加载扩展可能得到不同的扩展 ID，需要再次运行安装脚本授权该 ID。

## 路径如何工作

两种路径模式可以同时使用：

| 模式 | 预设示例 | 行为 |
| --- | --- | --- |
| 相对子目录 | `Software`、`工作/报表` | Chrome 直接下载到默认目录内的对应子目录，无需辅助程序 |
| Windows 绝对路径 | `D:\工作\报表`、`E:\软件` | Chrome 下载完成后，辅助程序自动移动到目标目录 |

**绝对模式是“下载完成后移动”，下载过程中仍需要 Chrome 默认目录所在磁盘的临时空间。** 文件先进入默认下载目录内的 `_DownloadPathRouter\任务ID\` 暂存区。移动成功后只删除原暂存文件及其空任务目录，不删除其它下载。

Chrome 下载列表可能仍指向原暂存路径，无法用扩展 API 改写为移动后的新路径。最终位置以扩展“最近记录”中的“已移动”结果为准；使用扩展的“打开文件夹”定位文件。

例如，在 Chrome 中手动将默认下载目录设为 `G:\FreeProgram\DownloadPath`，将名为“软件”的预设配置为 `Software`，那么匹配该预设的 `setup.zip` 会保存到：

```text
G:\FreeProgram\DownloadPath\Software\setup.zip
```

两种模式均支持中文目录与文件名。相对模式可输入 Windows 反斜杠，保存时统一为 `/`；绝对模式统一为本机盘符与反斜杠。禁止 `..`、设备路径、备用数据流、空路径片段、Windows 保留名称和非法字符。绝对模式暂不支持 UNC、网络映射盘、符号链接、junction 或经过其它重解析点的路径。

相对模式由 Chrome 为同名文件编号，绝对模式由辅助程序为同名文件编号，均不覆盖已有文件。同盘优先重命名；跨盘先创建独立临时副本并校验 SHA-256，再提交最终文件并删除源文件。失败时保留源文件或可恢复的任务记录。

如果把项目文件夹同时设为 Chrome 默认下载目录，下载内容会与源码共处；也可以选择一个独立的下载根目录，扩展不要求下载位置等于项目位置。

## 网站规则

首次启动预置“软件”“文档”“图片”三个可编辑的路径预设，**没有绑定任何网站**。新建规则时填写自己的实际域名和目标预设。

每条规则选择一个明确的匹配依据：

| 匹配依据 | 使用场景 | 对应数据 |
| --- | --- | --- |
| 来源网站 | 从某网站点击下载，文件可能在 CDN 上 | 下载记录中的 `referrer` |
| 下载链接 | 下载链接始终使用固定服务器 | 初始 `url` |
| 最终下载地址 | 文件经过跳转，按最终服务器分类 | `finalUrl` |

同一网站的来源信息可能因网站隐私策略而缺失；这种情况下“来源网站”规则不会命中。应通过实际下载核实，可改为明确的下载服务器域名规则。扩展不会用当前活动标签页猜测下载来源，也不会自动把所有 CDN 下载视为同一网站。

域名匹配不区分大小写，可以粘贴完整 HTTP(S) 链接，保存时提取域名；匹配忽略协议、端口、路径和查询参数。“包含子域名”需要显式勾选，不使用 `*.example.com` 通配符。

数值较大的优先级先执行；同优先级按配置中规则的先后顺序执行。全局开关或单条规则关闭后停止相应分流。没有匹配规则时沿用 Chrome 原本的下载行为。

测试匹配工具只模拟给定地址和文件名的规则判断。实际下载是否提供来源、是否弹出另存为窗口，仍需用目标网站验证。

## 配置和记录

- 预设支持增删改；被规则引用的预设需先解除关联再删除。
- 配置导入和导出使用 JSON，导入前检查格式、版本、数量和路径；导入会替换现有配置，请先导出备份。
- 多窗口保存会检查配置版本，拒绝过期快照覆盖较新的改动；出现冲突提示时可直接重试保存，表单中的编辑会保留。总开关独立更新，不会覆盖网站规则。
- 最多 100 个预设、500 条规则。优先级范围 `-10000` 到 `10000`。
- 最近记录最多保留 100 条命中或异常记录，可手动清除；不保存完整下载 URL、查询参数或文件内容。日志中含文件名、匹配域名、规则和目标子路径。
- 命中记录表示扩展已提交目标路径建议，不代表下载已完成；绝对模式的“已移动”记录包含最终绝对路径。
- 待移动任务持久化保留，最多 200 个。未安装辅助程序、目标盘不可用或权限不足时保留暂存文件；安装或修复后，在日志中单个重试，或在帮助中“重试待移动文件”。浏览器重启也会尝试恢复。清空日志不删除待移动任务或文件。
- 网站规则或预设在下载途中被编辑时，已经开始的任务仍使用开始下载时的目标目录；新配置仅影响之后的下载。
- 无账号、云同步、分析上报或远程服务器；卸载扩展会清除扩展自己的配置和记录，不删除已下载文件。

## 已知边界

- Chrome 的“下载前询问位置”、用户主动“另存为”、企业管理策略及其他修改下载文件名的扩展，可能影响最终保存行为。
- 扩展只处理进入 Chrome 下载流程的文件；网页内预览、网站自建文件选择器、交给外部下载器的任务不一定触发本扩展。
- 能解析带 HTTP(S) origin 的 `blob:` 下载地址；不能从不透明来源、`data:` 地址或缺失信息中恢复原网站。
- 浏览器安全拦截、网络故障仍由 Chrome 处理；扩展不会自动放行安全拦截的文件。辅助程序也可能因权限、目标盘不可用、空间不足或 Windows 路径长度限制而失败。
- 配置读取超时或规则处理失败时沿用默认位置，避免等待扩展阻塞下载。
- 主动“另存为”到暂存区外的位置时，保留用户选择的位置，不自动移动。
- 跨盘复制期间如果进程突然退出，极少数恢复窗口可能留下随机 `.download-path-router-*.partial` 临时副本；原文件保留，重试仍能继续完成。不要手动删除仍待处理任务的暂存文件。
- 辅助程序安装位置与任务恢复记录位于 `%LOCALAPPDATA%\DownloadPathRouter`。卸载浏览器扩展不会替你清除此目录；解除辅助程序注册也不删除下载文件。

## 开发和验证

需要 Node.js 22 或更高版本及 npm。Windows PowerShell 若禁止执行 `npm.ps1`，使用 `npm.cmd` 代替 `npm`，无需修改系统执行策略。

```powershell
npm.cmd ci
npm.cmd run check
npm.cmd run test:browser
npm.cmd run test:native
npm.cmd run test:browser:native
npm.cmd run package
```

| 命令 | 用途 |
| --- | --- |
| `npm run build` | 构建 `dist`，生成图标 |
| `npm run build:native` | 使用 Windows 自带 .NET Framework 编译辅助程序 |
| `npm run typecheck` | TypeScript 静态检查 |
| `npm test` | 核心匹配、配置校验、下载回调、持久化任务、恢复与存储并发测试 |
| `npm run check` | 类型检查、单元测试、构建 |
| `npm run test:browser` | 独立 Chromium 中的真实下载与界面烟雾测试 |
| `npm run test:native` | 原生帧协议、真实移动、幂等、故障恢复及文件安全测试 |
| `npm run test:browser:native` | 独立 Chromium 与本机程序联动、失败保留、重启和重试测试 |
| `npm run package` | 完成基础检查、编译辅助程序，生成扩展及辅助程序 ZIP |

浏览器测试需要 Playwright Chromium。若本机尚未缓存，先运行：

```powershell
npx.cmd playwright install chromium
```

浏览器测试只启动独立测试配置，不操作用户正在使用的 Chrome。截图、测试文件和测试配置保存在 `test-results`。浏览器测试在构建后运行。

原生浏览器测试临时注册独立随机名称的测试 host，结束后只删除该测试注册项，不改正式辅助程序注册；下载、目标目录和任务记录都在独立测试目录。辅助程序测试包含系统临时目录中的隔离跨盘场景。

```text
src/
  manifest.json       扩展清单与最小权限
  background/         下载监听、配置持久化、最近记录
  shared/             规则、路径、配置校验及纯逻辑
  options/            中文设置页面
  popup/              工具栏弹窗
  ui/                 界面共享样式和消息接口
scripts/              构建、图标生成、ZIP 打包
native/Host.cs        Windows Native Messaging 辅助程序源码
native/bin/           编译后的辅助程序
tests/                单元测试与真实浏览器测试
dist/                 可加载扩展（构建生成）
artifacts/            ZIP 压缩包（打包生成）
```

## 权限

申请 `downloads`（下载事件、文件名建议与下载状态）、`storage`（本机配置、任务与记录）和 `nativeMessaging`（与已安装的 Windows 辅助程序通信）。不注入网页脚本，不申请全网站读取权限。辅助程序只操作本扩展暂存区的任务文件，跨盘复制时在本机校验文件内容，不上传数据。

官方文档：[Downloads API](https://developer.chrome.com/docs/extensions/reference/api/downloads)、[Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)、[Service Worker 生命周期](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)、[Storage API](https://developer.chrome.com/docs/extensions/reference/api/storage)。
