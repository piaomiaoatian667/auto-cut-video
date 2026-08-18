# 抖音自动发布 SOP

本 SOP 用于通过抖音创作者中心网页，将 `publish/douyin.json` 指定的单个视频和自定义封面立即发布到已登录账号。

## 1. 前置条件（Prerequisites）

- 在当前仓库根目录执行。
- 浏览器中可以访问 `https://creator.douyin.com/creator-micro/home`。
- 用户已明确要求发布；仅要求检查配置时不得打开上传页面。
- 目标账号可正常登录抖音创作者中心。
- 准备一个非空 `.mp4` 视频和一个非空 `.jpg`、`.jpeg` 或 `.png` 封面。
- 首版只支持单视频、立即发布，不支持定时或批量发布。
- 不保存 Cookie、密码、短信验证码、二维码或浏览器配置文件。

## 2. 配置（Configuration）

复制示例并编辑本地配置：

```bash
cp publish/douyin.example.json publish/douyin.json
```

```json
{
  "version": 1,
  "account": {
    "expectedName": "目标抖音账号昵称"
  },
  "video": "output/final-video.mp4",
  "cover": "output/thumbnail.jpg",
  "title": "视频标题",
  "topics": ["人工智能", "视频剪辑"],
  "visibility": "public",
  "allowDownload": true,
  "publish": {
    "mode": "immediate",
    "allowDuplicate": false
  }
}
```

规则：

| 字段 | 要求 |
| --- | --- |
| `account.expectedName` | 必填，必须与页面当前账号昵称一致。 |
| `video` | 仓库内相对路径，仅支持 `.mp4`。 |
| `cover` | 仓库内相对路径，支持 `.jpg`、`.jpeg`、`.png`。 |
| `title` | 必填；实时字数限制以页面校验为准。 |
| `topics` | 不带 `#`，去除空白后必须唯一。 |
| `visibility` | `public`、`friends` 或 `private`。 |
| `allowDownload` | 布尔值。 |
| `publish.mode` | 固定为 `immediate`。 |
| `publish.allowDuplicate` | 默认 `false`；只绕过已确认的 `published` 回执，不能绕过 `unknown`。 |

视频和封面经过真实路径解析后仍必须位于仓库根目录内；指向仓库外部的软链接会被拒绝。

## 3. 校验（Validate）

```bash
mkdir -p .work
node .agents/skills/douyin-auto-publish/scripts/validate-publish-config.mjs \
  --project-root . \
  --config publish/douyin.json \
  > .work/douyin-preflight.json
```

退出码：

| 退出码 | 含义 |
| --- | --- |
| `0` | 配置、文件、哈希和回执状态允许继续。 |
| `2` | 配置或文件不合法。 |
| `3` | 已有 `published` 或 `unknown` 回执阻止发布。 |
| `4` | 本地读取、哈希或回执扫描失败。 |

任何非零退出都必须停止。不要为了继续运行而修改哈希、删除 `unknown` 或改写校验输出。

## 4. 发布流程（Publish）

标准阶段：

```text
preflight → login-check → account-check → navigate → upload-video
→ fill-metadata → upload-cover → set-options → final-check
→ publish → verify → receipt
```

### 4.1 `preflight`

保存校验器的标准输出到 `.work/douyin-preflight.json`。后续上传路径、账号、字段和视频哈希都从该文件读取，不再次猜测。

### 4.2 `login-check`

通过 `browser:control-in-app-browser` 打开创作者中心。如果页面显示登录入口，停止自动操作，请用户完成扫码、短信或密码登录；用户确认登录完成后再重新读取页面。

### 4.3 `account-check`

读取页面可见账号昵称，与 `account.expectedName` 去除首尾空白后精确比较。不匹配时立即停止，不自动切换账号。

### 4.4 `navigate`

通过页面可见的发布入口进入视频发布表单。优先使用角色、标签和可见文本，不猜测内部 URL，不依赖随机 CSS 类名。

### 4.5 `upload-video`

使用浏览器文件选择器上传 preflight 中的绝对视频路径：先监听 `filechooser`，再点击真实文件输入框或能打开选择器的可见上传控件，最后调用 chooser 的 `setFiles`。等待传输和服务端处理都完成。

上传失败时先读取页面错误，只允许一次有依据的页面内恢复；仍失败则记录 `failed`，不得无限刷新或重复上传。

### 4.6 `fill-metadata`

填写标题，并按页面当前话题交互逐个加入配置中的话题。完成后重新读取页面，确认每个话题均可见。

### 4.7 `upload-cover`

上传 preflight 中的自定义封面，并确认页面预览已应用该封面。无法验证时必须停止，不允许使用系统自动截帧继续发布。

### 4.8 `set-options`

设置 `visibility` 和 `allowDownload`。若页面没有对应选项或页面值无法确认，停止发布。

### 4.9 `final-check`

逐项重新读取：

- 当前账号；
- 视频上传和处理状态；
- 标题；
- 全部话题；
- 自定义封面；
- 可见范围；
- 下载权限；
- 页面校验错误；
- 发布按钮是否可用。

任何一项与配置不一致都必须停止。用户明确调用发布即构成本次上传和直接发布授权；`final-check` 通过后直接点击语义明确的发布按钮，不再二次询问。最终发布按钮禁止使用纯坐标盲点。

### 4.10 `publish` 与 `verify`

点击发布后等待页面给出权威结果。点击动作本身不代表成功，不得因为超时而再次点击。

## 5. 成功验收（Success verification）

以下任一权威信号才可记录 `published`：

- 页面明确显示发布成功；
- 页面导航到明确的成功结果页；
- 作品管理中出现账号、标题和本次发布时间相符的新作品。

只有页面直接提供时才记录 `workId` 或 `workUrl`，不从无关脚本、日志或网络请求中猜测。

## 6. 回执（Receipts）

回执目录：

```text
publish/receipts/douyin/<video-sha256-without-prefix>/
```

先把结果写入 `.work/douyin-result.json`，再执行：

```bash
node .agents/skills/douyin-auto-publish/scripts/record-publish-result.mjs \
  --preflight .work/douyin-preflight.json \
  --result .work/douyin-result.json
```

### `published` 示例

```json
{
  "status": "published",
  "accountName": "目标抖音账号昵称",
  "videoSha256": "sha256:从-preflight-复制",
  "title": "视频标题",
  "topics": ["人工智能", "视频剪辑"],
  "visibility": "public",
  "allowDownload": true,
  "workId": null,
  "workUrl": null
}
```

### `unknown` 示例

仅在已点击发布、但无法确认成功或失败时使用：

```json
{
  "status": "unknown",
  "accountName": "目标抖音账号昵称",
  "videoSha256": "sha256:从-preflight-复制",
  "title": "视频标题",
  "stage": "verify-after-submit",
  "lastKnownUrl": "https://creator.douyin.com/creator-micro/home"
}
```

### `failed` 示例

仅用于点击发布之前的失败：

```json
{
  "status": "failed",
  "accountName": null,
  "videoSha256": "sha256:从-preflight-复制",
  "title": "视频标题",
  "stage": "upload-cover",
  "lastKnownUrl": "https://creator.douyin.com/creator-micro/home",
  "message": "封面上传失败"
}
```

回执写入采用同目录临时文件加原子重命名。`failed` 不阻止修复后的重试；`published` 默认阻止重复发布；`unknown` 始终阻止自动重试。

## 7. `unknown` 状态（Unknown outcome）

1. 打开作品管理，按账号、标题、发布时间和视频内容人工核验。
2. 未完成核验前，不得重新上传，也不得仅把 `allowDuplicate` 改为 `true`。
3. 若确认已发布，使用页面实际信息记录一份 `published` 回执。
4. 若确认未发布，保留原始 JSON 内容并补充人工核验说明。
5. 将已人工处理的 `unknown` 文件移入同一哈希目录下的 `resolved/` 子目录；校验器只扫描哈希目录顶层 JSON。
6. 再次运行校验，确认不存在其他顶层 `unknown` 后才能决定是否重试。

## 8. 登录与验证码（Login and CAPTCHA）

- 登录过期：停在登录页，用户完成登录后再继续。
- CAPTCHA / 验证码、扫码确认或风险控制提示：立即停止并把浏览器交给用户。
- 不代替用户绕过验证，不保存验证内容，不通过刷新循环规避风控。
- 风控处理完成后重新执行 `account-check` 和当前阶段检查，不直接跳到发布。

## 9. 常见失败处理

| 情况 | 处理 |
| --- | --- |
| 账号不匹配 | 报告期望值和页面值，停止。 |
| 视频上传失败 | 读取可见错误，只恢复一次；失败则记录 `failed`。 |
| 封面失败 | 停止，不使用默认封面。 |
| 字段被页面截断或拒绝 | 停止并报告实时校验信息。 |
| 发布按钮不可用 | 重新执行 `final-check`，不强制点击。 |
| 点击后无明确结果 | 记录 `unknown`，不得重试。 |

## 10. 页面变化（UI changes）

1. 获取新的 DOM 或可见页面状态，确认入口、字段或按钮是否改名。
2. 优先更新语义文本和角色定位，不加入易变的构建类名。
3. 如果语义定位无效，可用截图理解布局，但最终发布按钮仍不能使用纯坐标点击。
4. 同步更新 `SKILL.md`、本 SOP 和契约测试中的关键术语。
5. 页面变化未确认前停止真实发布，不通过连续猜测点击寻找入口。

## 11. 发布前安全清单

- [ ] 校验器退出 `0`。
- [ ] 页面账号与 `account.expectedName` 一致。
- [ ] 视频和自定义封面均来自 preflight 路径。
- [ ] 标题、话题、可见范围和下载权限逐项复核。
- [ ] 页面无验证码、风控或校验错误。
- [ ] 当前哈希没有阻断回执。
- [ ] 点击后只根据权威页面信号记录结果。
