# DeepSeek 文字留痕（DeepSeek Text Logger）

一个纯本地运行的 DeepSeek 对话留痕工具：在回答出现在页面上的瞬间保存正文，即使回答随后被安全规则撤回、替换或整块移除，也能把已经显示过的内容找回来。

> 本项目与 DeepSeek 官方无关，仅用于个人备份自己在网页/App 中已经看到的内容。所有数据保存在本机，不上传任何服务器。

**关键词**：DeepSeek 防撤回 · DeepSeek 留痕 · 撤回消息找回 · 对话备份 · 回答存档 · Tampermonkey 油猴脚本 · 浏览器书签 · 安卓 WebView

## 功能

- **网络层 + 页面层双捕获**：在 SSE/流式数据到达浏览器时即截获全文；页面渲染卡顿或内容未显示就被撤回时，也能拿到原文
- **正文只增不减**：后续的短提示/替换文本不会覆盖已经保存的长正文，替换文本单独留档
- **撤回自动拦截**：检测到回答被撤回时弹窗提示，并把完整原文存档
- **疑似撤回**：没有提示文字、回答直接消失或被短文本替换时，标记为“疑似撤回”，正文同样保留
- **可视化控制台**：记录列表、搜索、只看被撤回、导出 TXT / JSON、单条复制/导出/删除
- **复制语义清晰**：“复制正文”只复制正文；“复制完整记录”才包含替换文本与历史版本
- **可选择性复制**：框选正文时列表不会重绘，选区不会被刷新打断
- **安卓 App**：WebView 壳，把导出/剪贴板/外链桥接到系统，面板适配窄屏

## 安装

### 方式一：Tampermonkey（推荐）

1. 安装 [Tampermonkey](https://www.tampermonkey.net/)
2. 新建脚本，把 `userscript/deepseek-text-logger.user.js` 的内容整体粘贴进去并保存
3. 打开 https://chat.deepseek.com/ ，刷新页面
4. 右下角出现「📝 留痕」悬浮按钮即安装成功（快捷键 `Alt+L` 打开面板）

### 方式二：书签脚本

打开 `bookmarklet/deepseek-text-logger.html`，按页面提示把链接拖到浏览器书签栏，在 DeepSeek 页面点击该书签即可注入。

### 方式三：安卓 APK（直接安装）

下载 [DeepSeek_Text_Logger_v1.6.3.apk](dist/DeepSeek_Text_Logger_v1.6.3.apk)（versionCode 7 / versionName 1.6.3），传到手机安装即可。

SHA-256：`8D1E21F028456A74B0F8B4C867422425FEE7CD5A14F5987EC5FA2A64F1ABBC4B`

> 升级安装需使用同一签名密钥。签名密钥不随仓库发布；如需自行编译，见下方「构建安卓 App」（用你自己的密钥构建，无法覆盖安装本包）。

## 使用

- `Alt+L`：打开/关闭控制台
- 悬浮按钮可拖动，位置自动记忆
- 控制台内可搜索、筛选“只看被撤回”、导出、逐条复制
- 复制按钮：
  - **复制正文**：只复制已保存的最长可信正文
  - **复制完整记录**：包含正文、替换/提示文本、历史版本

## 构建安卓 App

需要：Windows、Node.js、JDK 17、Android SDK Build-Tools（aapt2 / d8 / zipalign / apksigner）与 `android.jar`。

```powershell
# 1. 准备工具目录（示例）
$env:TEMP\dsapk\tool\jdk-17...
$env:TEMP\dsapk\tool\android-14      # build-tools
$env:TEMP\dsapk\tool\android-35      # platform（含 android.jar）

# 2. 准备自己的签名密钥（首次）
keytool -genkeypair -keystore my.keystore -alias dslogger `
  -keyalg RSA -keysize 2048 -validity 10000

# 3. 设置环境变量并构建
$env:DSLG_KEYSTORE = "C:\path\to\my.keystore"
$env:DSLG_KS_PASS  = "你的密钥库口令"
$env:DSLG_KEY_ALIAS = "dslogger"   # 可选，默认 dslogger
powershell -ExecutionPolicy Bypass -File android\build.ps1
```

产物默认输出到 `%TEMP%\dsapk\out\DeepSeek_Logger_v<版本>.apk`，版本号读取自 `android/app/AndroidManifest.xml`。

> 注意：升级安装必须使用**同一个签名密钥**，否则 Android 会拒绝覆盖安装。

## 测试

```bash
node tests/dslg_core_test.js
```

测试覆盖：长正文被短文本替换后仍能恢复、短文本不覆盖长正文、增量包与完整包不重复拼接、纯增量流正确累计、覆盖后网络层配对仍可用、框选保护与复制语义等。

## 项目结构

```
userscript/         油猴脚本（含内嵌网络层）
  ds_netcap.js      网络层捕获代码（独立参考副本，已内嵌在主脚本中）
bookmarklet/        书签脚本版（单文件 HTML）
tests/              核心逻辑模拟测试
android/
  build.ps1         构建脚本（版本号取自 AndroidManifest）
  prep.js           从主脚本生成 assets/ds_logger.js 与 ds_netcap.js
  makeicon.ps1      生成各密度启动图标
  app/              Android 工程（Manifest / Java / res / shim.js）
```

## 隐私与安全

- 所有留痕数据仅保存在浏览器 localStorage 或 App 本地存储中，**不会上传**
- 仓库不包含、也不会公开任何签名密钥
- 导出文件请自行妥善保管
- 请自行评估使用风险，并遵守 DeepSeek 的服务条款与当地法律法规；不要将本工具用于规避平台安全机制或传播违规内容

## 免责声明

本项目按“现状”提供，不附带任何明示或暗示的担保。因使用本工具造成的任何直接或间接损失，作者不承担责任。

## 许可证

[MIT](LICENSE)
