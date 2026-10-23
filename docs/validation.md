# 验证记录

日期：2026-10-22。开发目录原为空目录，不是 Git 仓库，无需同步分支；未创建 worktree、修改邻接项目源码或调整用户日常 DSH 配置。

## 已完成

- `npm run check`：构建与 14 项 Node.js 测试通过。覆盖连接参数、IPv6、非法参数、输出游标、跨会话拒绝、失败授权回收、登录与 PTY 撤销竞态、终端关闭竞态、凭据权限、CLI 访问控制及请求校验。
- `npm run test:ui`：无界面 Chromium，使用模拟远端验证连接表单、保存不授权、终端输入输出、AI 通知、撤销、重载与 320px 布局；无页面脚本异常。`ssh-connect.png`、`ssh-connected.png`、`ssh-narrow.png` 已打开检查，无布局溢出或遮挡。
- `npm run test:ssh`：macOS 本机回环地址的临时 sshd、临时私钥和 known_hosts，使用 DSH 的真实 `LocalSubprocessRuntime`；验证密钥与主机密钥校验、登录、CLI、中文输出、非零退出码、远端文件写入、目录失败阻止后续命令、真实 PTY 输入输出、缩放、Ctrl+C、命令和终端撤销。测试完成后回收服务和临时文件。
- `npm run test:host`：使用 DSH 的真实 `defineTool`，验证四个工具的注册和执行、当前会话作用域、HTTP 请求校验、CLI 通知和会话卸载撤销。上下文与远端输出使用测试替身。
- 安装包已在独立临时 `DSH_HOME` 的 web profile 中通过离线安装。前端依赖均在构建时打包，运行时仅使用宿主提供的 peer 包。

## 未完成或受阻

- 完整 DSH 应用界面联调未验收：本机命令行 DSH 0.2.1-alpha.4 的内置 `remote-access`、`working-directory`、`tool-working-directory`、`subagent-spawn-in-process`、`subagent-fork-in-process`、`harness-dev-context`、`ui-secret-mask`、`ui-schedule` 共 8 个条目导入失败。未修改宿主源码处理这些问题。独立组件截图不能视为完整应用截图。
- 未把插件安装到用户日常配置；安装检查使用独立临时配置。
- 未连接用户真实服务器，未实测生产环境的 SSH Agent、加密私钥、ProxyJump、sudo 或不同远端 Shell；这些沿用 OpenSSH 行为。
- 未实跑 Codex / Claude Code 模型对话；已验证其使用的本机 CLI 与会话令牌通道，以及通知内容的生成。

权限取决于远端账号；删除等命令会真实生效。终止 SSH 连接不能保证停止已在远端脱离连接的后台服务。

## 2026-10-23：0.1.1 原生入口样式修正

- 移除自绘引导卡片及样式，交由宿主原生 `GuideBody` 渲染 SSH 入口。
- `npm run check`：构建与 14 项测试通过。
- 无界面 Chromium 使用本地宿主的真实引导组件核对深浅主题和 390/320/740px 布局：SSH 与其他原生入口的宽高、圆角、字号、字重、背景一致，无横向溢出；点击正确打开 SSH 标签。
- `ssh-guide-native-dark.png`、`ssh-guide-native-narrow.png`、`ssh-guide-native-light.png` 已打开核对。这些是原生组件的独立预览，本轮未在完整 DSH 应用中复验。

## 2026-10-23：0.2.0 页面免密配置

- 按确认的需求增加一次密码配置向导：生成或复用本机专用 Ed25519 密钥、确认未知主机指纹、追加远端公钥并验证专用密钥登录；完成后仍需用户授权当前会话。
- `npm run check`：构建与 22 项测试通过。新增覆盖密码不进入 argv/env/文件/状态、指纹未确认时不发送密码、目标认证提示校验、跨站认证请求拒绝、私钥权限、旧公钥保留、幂等安装、错误密码重试、拒绝/取消/超时/关闭清理，以及撤销立即使令牌失效。
- `npm run test:host`、`npm run test:ssh`：宿主工具接口和原有真实 SSH/PTY 功能回归通过。
- `npm run test:ui`：通过页面配置、拒绝与确认指纹、密码清空且不存入浏览器存储、私钥路径回填、配置不自动授权，以及原有连接/终端/撤销/重载和 320px 布局验证。配置向导的 4 张 `ssh-setup-*.png` 截图已打开核对。
- 额外以真实 OpenSSH 10.3 客户端和回环地址临时 Paramiko 4.0.0 SSH 测试服务验证完整链路：首次指纹确认、密码认证、公钥追加、专用新密钥验证、后续授权及远程命令、重复安装不追加、错误密码和拒绝指纹。测试使用临时 HOME、known_hosts、密钥及账号口令，不修改用户 SSH 文件。Paramiko 只安装在忽略的 `.cache` 测试目录，不是产品依赖。
- 未连接用户真实服务器，未在完整 DSH 应用或真实模型对话中验收。本轮未实测跳板机；该场景要求跳板机已有密钥或 Agent 认证。配置向导仅支持 macOS/Linux 宿主和标准密码认证。
- 本次密钥配置会持久保留本机私钥和远端公钥，取消配置或撤销会话授权不会自动移除它们。
