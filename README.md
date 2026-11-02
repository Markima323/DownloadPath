# 下载路径助手

一个 Chrome Manifest V3 扩展：为网站关联路径预设，在浏览器下载文件时自动选择对应的子目录。中文界面，配置和最近记录均保存在本机。

## 直接安装

本项目构建后的 `dist` 是可直接加载的扩展目录，`artifacts/download-path-router-0.1.0.zip` 是同一扩展的压缩包。

1. 在 Chrome 地址栏输入 `chrome://extensions`。
2. 开启右上角的“开发者模式”。
3. 点击“加载已解压的扩展程序”，选择本项目的 `dist` 文件夹。使用 ZIP 时请先解压，再选择包含 `manifest.json` 的文件夹。
4. 在工具栏扩展菜单中找到“下载路径助手”，进入设置。
5. 在 Chrome 的 `chrome://settings/downloads` 中设置默认下载目录，并关闭“下载前询问每个文件的保存位置”。
6. 设置路径预设，再为实际使用的网站添加规则，最后通过真实下载检查效果。

源码有修改时需要重新运行 `npm run build`，然后在 `chrome://extensions` 页面点击本扩展的重新加载按钮；已打开的设置页也需要刷新。

## 路径如何工作

本版本采用纯扩展方案。目标必须是 **Chrome 默认下载目录内的相对子目录**，不能填写任意磁盘的绝对路径。

例如，在 Chrome 中手动将默认下载目录设为 `G:\FreeProgram\DownloadPath`，将名为“软件”的预设配置为 `Software`，那么匹配该预设的 `setup.zip` 会保存到：

```text
G:\FreeProgram\DownloadPath\Software\setup.zip
```

支持 `工作/报表` 等多级目录和中文目录名。可以输入 Windows 反斜杠，保存时会统一为 `/`。禁止绝对路径、`..`、空路径片段、Windows 保留名称和非法字符。现有同名文件会由 Chrome 自动编号，不覆盖原文件。

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
- 命中记录表示扩展已提交目标路径建议，不代表下载已完成；实际完成状态请查看 Chrome 下载列表。
- 无账号、云同步、分析上报或远程服务器；卸载扩展会清除扩展自己的配置和记录，不删除已下载文件。

## 已知边界

- Chrome 的“下载前询问位置”、用户主动“另存为”、企业管理策略及其他修改下载文件名的扩展，可能影响最终保存行为。
- 扩展只处理进入 Chrome 下载流程的文件；网页内预览、网站自建文件选择器、交给外部下载器的任务不一定触发本扩展。
- 能解析带 HTTP(S) origin 的 `blob:` 下载地址；不能从不透明来源、`data:` 地址或缺失信息中恢复原网站。
- 浏览器安全拦截、网络故障、磁盘权限、空间不足和系统路径总长度限制仍由 Chrome 处理；扩展不会自动放行安全拦截的文件。
- 配置读取超时或规则处理失败时沿用默认位置，避免等待扩展阻塞下载。
- 本版不含本机辅助程序。如果需要分别保存到 `D:\工作`、`E:\软件` 等独立目录，需要另外开发 Native Messaging 配套程序；下载完成后移动也会影响 Chrome 下载记录中的原路径。

## 开发和验证

需要 Node.js 22 或更高版本及 npm。Windows PowerShell 若禁止执行 `npm.ps1`，使用 `npm.cmd` 代替 `npm`，无需修改系统执行策略。

```powershell
npm.cmd ci
npm.cmd run check
npm.cmd run test:browser
npm.cmd run package
```

| 命令 | 用途 |
| --- | --- |
| `npm run build` | 构建 `dist`，生成图标 |
| `npm run typecheck` | TypeScript 静态检查 |
| `npm test` | 核心匹配、配置校验、下载回调及存储并发测试 |
| `npm run check` | 类型检查、单元测试、构建 |
| `npm run test:browser` | 独立 Chromium 中的真实下载与界面烟雾测试 |
| `npm run package` | 完成基础检查并生成 ZIP |

浏览器测试需要 Playwright Chromium。若本机尚未缓存，先运行：

```powershell
npx.cmd playwright install chromium
```

浏览器测试只启动独立测试配置，不操作用户正在使用的 Chrome。截图、测试文件和测试配置保存在 `test-results`。浏览器测试在构建后运行。

```text
src/
  manifest.json       扩展清单与最小权限
  background/         下载监听、配置持久化、最近记录
  shared/             规则、路径、配置校验及纯逻辑
  options/            中文设置页面
  popup/              工具栏弹窗
  ui/                 界面共享样式和消息接口
scripts/              构建、图标生成、ZIP 打包
tests/                单元测试与真实浏览器测试
dist/                 可加载扩展（构建生成）
artifacts/            ZIP 压缩包（打包生成）
```

## 权限

仅申请 `downloads`（接收下载事件并建议文件名）和 `storage`（本机配置与记录）。不注入网页脚本，不申请全网站读取权限，不读取已下载文件内容。

官方文档：[Downloads API](https://developer.chrome.com/docs/extensions/reference/api/downloads)、[Service Worker 事件](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/events)、[Storage API](https://developer.chrome.com/docs/extensions/reference/api/storage)。
