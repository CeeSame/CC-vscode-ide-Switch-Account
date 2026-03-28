# Claude Account Switcher

VSCode 扩展，在多个 Claude Code 订阅账户与自定义 API Provider 之间一键切换，无需重复登录。

与 `cc-subscription-switch` (ccss) 共用目录结构，完全兼容。

---

## 功能

- 状态栏显示当前账户/Provider，点击即可切换
- 多账户管理（添加、删除、查看）
- 自定义 API Provider（Base URL + API Key + Model）
- Usage Dashboard（用量进度条，5 分钟缓存）
- 切换前自动刷新 OAuth Token，避免过期

---

## 命令（Command Palette）

使用 `Ctrl+Shift+P` 打开命令面板，输入 `Claude` 筛选：

| 命令 | 说明 |
|------|------|
| `Claude: Switch Claude Account/Provider` | 切换账户或 API Provider（主入口） |
| `Claude: Add Claude Account` | 添加新的 OAuth 账户 |
| `Claude: Remove Claude Account` | 删除已保存的账户 |
| `Claude: Show Current Claude Account` | 查看当前激活账户（whoami） |
| `Claude: Show Usage Dashboard` | 查看各账户用量面板 |
| `Claude: Add API Provider` | 添加自定义 API Provider |
| `Claude: Switch API Provider` | 切换到 API Provider 模式 |
| `Claude: Remove API Provider` | 删除 API Provider |

> 点击状态栏图标等同于执行 `Switch Claude Account/Provider`。

---

## 状态栏图标说明

| 图标 | 含义 |
|------|------|
| `$(account) 账户名` | 当前使用 OAuth 账户 |
| `$(server) Provider名` | 当前使用 API Provider |

---

## API Provider 配置

切换到 API Provider 时，自动写入 `~/.claude/settings.json` 的 `env` 块：

**GLM 模型**（model 名含 "GLM"）：
```json
{
  "env": {
    "ANTHROPIC_API_KEY": "your-api-key",
    "ANTHROPIC_BASE_URL": "https://open.bigmodel.cn/api/coding/paas/v4",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "GLM-5.1",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "GLM-5.1",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "GLM-4.5-air"
  }
}
```

**其他模型**：
```json
{
  "env": {
    "ANTHROPIC_API_KEY": "your-api-key",
    "ANTHROPIC_BASE_URL": "https://api.example.com/v1",
    "ANTHROPIC_MODEL": "model-name"
  }
}
```

切回 OAuth 账户时，自动清除全部 7 个环境变量并删除 `env` 字段。

---

## 已知问题

### ⚠️ 切换模型/账户后出现 "Invalid signature in thinking block"

**错误**：
```
API Error: 400 messages.N.content.0: Invalid signature in thinking block
```

**原因**：Claude extended thinking 模式会在对话历史中留下带加密签名的 `thinking` 块，签名绑定了特定模型和 session。切换模型或账户后，旧签名对新环境无效，API 拒绝整个对话历史。

**解决**：切换模型/账户后，**开一个新对话（New Chat）** 再继续工作。

> 这是 Claude API 的设计限制，无法从扩展层面修复。

---

## 文件路径

| 用途 | 路径 |
|------|------|
| 账户配置 | `~/.cc-subscription-switch/config.json` |
| 账户凭证目录 | `~/.cc-subscription-switch/accounts/{name}/` |
| Claude 活跃凭证 | `~/.claude/.credentials.json` |
| Claude 设置 | `~/.claude/settings.json` |

---

## 开发

```bash
# 编译
npm run compile

# 打包 vsix
npm run package
```

编译后将 `out/extension.js` 和 `package.json` 复制到安装目录（扁平结构，无 `out/` 子目录）。
