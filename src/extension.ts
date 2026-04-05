import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ─── 路径常量 ─────────────────────────────────────────────────────────────────

const HOME = os.homedir();
const SWITCH_DIR = path.join(HOME, '.cc-subscription-switch');
const ACCOUNTS_DIR = path.join(SWITCH_DIR, 'accounts');
const CONFIG_FILE = path.join(SWITCH_DIR, 'config.json');
const CLAUDE_DIR = path.join(HOME, '.claude');
const CLAUDE_CREDS = path.join(CLAUDE_DIR, '.credentials.json');
const CLAUDE_SETTINGS = path.join(CLAUDE_DIR, 'settings.json');

// ─── 类型定义 ─────────────────────────────────────────────────────────────────

interface Account {
  name: string;
  description?: string;
}

interface ApiProvider {
  name: string;
  baseUrl: string;
  apiKey: string;
  model?: string;
  description?: string;
}

interface Config {
  accounts: Account[];
  currentAccount?: string;
  apiProviders?: ApiProvider[];
  currentApiProvider?: string;
}

interface Credentials {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    subscriptionType?: string;
    scopes?: string[];
  };
}

interface ClaudeJson {
  oauthAccount?: {
    emailAddress?: string;
    displayName?: string;
    organizationName?: string;
  };
}

interface AccountInfo {
  email: string;
  displayName: string;
  organization: string;
  plan: string;
  refreshToken: string;
  accessToken: string;
}

interface UsageWindow {
  utilization: number;
  resets_at?: string;
}

interface UsageData {
  five_hour: UsageWindow;
  seven_day: UsageWindow;
  seven_day_sonnet: UsageWindow | null;
  seven_day_oauth_apps: UsageWindow | null;
  seven_day_opus: UsageWindow | null;
  extra_usage?: {
    is_enabled: boolean;
    used_credits: number | null;
    monthly_limit: number | null;
  };
}

// ─── OAuth 常量 ───────────────────────────────────────────────────────────────

const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const OAUTH_TOKEN_URL = 'https://claude.ai/api/oauth/token';

// ─── 使用量缓存（内存，5分钟 TTL）────────────────────────────────────────────

const usageCache = new Map<string, { data: UsageData; fetchedAt: number }>();
const CACHE_TTL = 5 * 60 * 1000;

// ─── 配置文件操作 ─────────────────────────────────────────────────────────────

function loadConfig(): Config {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) as Config;
    }
  } catch {}
  return { accounts: [] };
}

function saveConfig(config: Config): void {
  fs.mkdirSync(SWITCH_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

function getAccountDir(name: string): string {
  return path.join(ACCOUNTS_DIR, name);
}

function getAccountCredPath(name: string): string {
  return path.join(getAccountDir(name), '.credentials.json');
}

function getAccountClaudeJsonPath(name: string): string {
  return path.join(getAccountDir(name), '.claude.json');
}

// ─── 账户信息读取 ─────────────────────────────────────────────────────────────

function readAccountInfo(accountName: string): AccountInfo | null {
  try {
    const credPath = getAccountCredPath(accountName);
    if (!fs.existsSync(credPath)) {
      return null;
    }
    const creds = JSON.parse(fs.readFileSync(credPath, 'utf-8')) as Credentials;
    let refreshToken = creds?.claudeAiOauth?.refreshToken ?? '';
    let accessToken = creds?.claudeAiOauth?.accessToken ?? '';
    const expiresAt = creds?.claudeAiOauth?.expiresAt ?? 0;

    // 如果存储的 accessToken 已过期，检查是否是当前激活账户
    // Claude Code 会自动刷新活跃账户的 token，但不会同步回账户目录
    if (expiresAt < Date.now() && fs.existsSync(CLAUDE_CREDS)) {
      try {
        const config = loadConfig();
        if (config.currentAccount === accountName) {
          // 当前激活账户：直接使用活跃凭证（Claude Code 保持其最新）
          const activeCreds = JSON.parse(fs.readFileSync(CLAUDE_CREDS, 'utf-8')) as Credentials;
          const activeAccess = activeCreds?.claudeAiOauth?.accessToken;
          const activeRefresh = activeCreds?.claudeAiOauth?.refreshToken;
          if (activeAccess) {
            accessToken = activeAccess;
            if (activeRefresh) { refreshToken = activeRefresh; }
          }
        }
      } catch {}
    }

    const plan = creds?.claudeAiOauth?.subscriptionType ?? 'unknown';

    let email = '';
    let displayName = '';
    let organization = '';
    const claudeJsonPath = getAccountClaudeJsonPath(accountName);
    if (fs.existsSync(claudeJsonPath)) {
      const claudeJson = JSON.parse(
        fs.readFileSync(claudeJsonPath, 'utf-8')
      ) as ClaudeJson;
      email = claudeJson?.oauthAccount?.emailAddress ?? '';
      displayName = claudeJson?.oauthAccount?.displayName ?? '';
      organization = claudeJson?.oauthAccount?.organizationName ?? '';
    }

    return { email, displayName, organization, plan, refreshToken, accessToken };
  } catch {
    return null;
  }
}

// ─── Token 刷新 ───────────────────────────────────────────────────────────────

async function refreshOAuthToken(accountName: string): Promise<string | null> {
  try {
    const credPath = getAccountCredPath(accountName);
    if (!fs.existsSync(credPath)) { return null; }
    const creds = JSON.parse(fs.readFileSync(credPath, 'utf-8')) as Credentials;
    const refreshToken = creds?.claudeAiOauth?.refreshToken;
    const scopes = creds?.claudeAiOauth?.scopes ?? ['user:inference', 'user:profile'];
    if (!refreshToken) { return null; }

    const res = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'claude-code/2.1.86' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: OAUTH_CLIENT_ID,
        scope: scopes.join(' '),
      }),
    });
    if (!res.ok) { return null; }

    const json = await res.json() as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!json.access_token) { return null; }

    // 更新存储的凭证
    const updated: Credentials = {
      claudeAiOauth: {
        ...creds.claudeAiOauth,
        accessToken: json.access_token,
        refreshToken: json.refresh_token ?? refreshToken,
        expiresAt: json.expires_in ? Date.now() + json.expires_in * 1000 : undefined,
      },
    };
    fs.writeFileSync(credPath, JSON.stringify(updated, null, 2), 'utf-8');

    // 如果是当前激活账户，同步更新 ~/.claude/.credentials.json
    const config = loadConfig();
    if (config.currentAccount === accountName) {
      const active = JSON.parse(fs.readFileSync(CLAUDE_CREDS, 'utf-8')) as Credentials;
      active.claudeAiOauth = updated.claudeAiOauth;
      fs.writeFileSync(CLAUDE_CREDS, JSON.stringify(active, null, 2), 'utf-8');
    }

    return json.access_token;
  } catch {
    return null;
  }
}

// ─── 使用量 API ───────────────────────────────────────────────────────────────

async function fetchUsage(accessToken: string): Promise<UsageData | null> {
  try {
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
    });
    if (!res.ok) {
      return null;
    }
    return (await res.json()) as UsageData;
  } catch {
    return null;
  }
}

async function getUsage(accountName: string): Promise<UsageData | null> {
  const cached = usageCache.get(accountName);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
    return cached.data;
  }

  const info = readAccountInfo(accountName);
  if (!info?.accessToken) {
    return null;
  }

  // 检查 token 是否过期，过期则尝试刷新
  const credPath = getAccountCredPath(accountName);
  let accessToken = info.accessToken;
  try {
    const creds = JSON.parse(fs.readFileSync(credPath, 'utf-8')) as Credentials;
    const expiresAt = creds?.claudeAiOauth?.expiresAt ?? 0;
    if (expiresAt < Date.now()) {
      const newToken = await refreshOAuthToken(accountName);
      if (newToken) { accessToken = newToken; }
    }
  } catch {}

  const data = await fetchUsage(accessToken);
  if (data) {
    usageCache.set(accountName, { data, fetchedAt: Date.now() });
  }
  return data;
}

// ─── 自动生成账户名 ───────────────────────────────────────────────────────────

function generateAccountName(email: string, existingAccounts: Account[]): string {
  const domain = email.split('@')[1] ?? 'account';
  const domainBase = domain.split('.')[0];
  const index = (existingAccounts.length + 1).toString().padStart(2, '0');
  return `${domainBase}_${index}`;
}

// ─── 账户识别 ─────────────────────────────────────────────────────────────────

function detectCurrentAccount(config: Config): string | undefined {
  if (config.currentAccount) {
    return config.currentAccount;
  }
  if (!fs.existsSync(CLAUDE_CREDS)) {
    return undefined;
  }
  try {
    const active = JSON.parse(fs.readFileSync(CLAUDE_CREDS, 'utf-8')) as Credentials;
    const activeToken = active?.claudeAiOauth?.refreshToken;
    if (!activeToken) {
      return undefined;
    }
    for (const account of config.accounts) {
      const credPath = getAccountCredPath(account.name);
      if (!fs.existsSync(credPath)) {
        continue;
      }
      try {
        const creds = JSON.parse(fs.readFileSync(credPath, 'utf-8')) as Credentials;
        if (creds?.claudeAiOauth?.refreshToken === activeToken) {
          return account.name;
        }
      } catch {}
    }
  } catch {}
  return undefined;
}

// ─── 账户切换 ─────────────────────────────────────────────────────────────────

async function switchToAccount(name: string): Promise<void> {
  const credPath = getAccountCredPath(name);
  if (!fs.existsSync(credPath)) {
    throw new Error(`账户 "${name}" 的凭证文件不存在，请重新添加该账户`);
  }

  // 切换前把当前活跃凭证同步回当前账户目录
  // 确保存储的 token 是 Claude Code 最新刷新过的版本
  const config = loadConfig();
  if (config.currentAccount && !config.currentApiProvider) {
    const currentCredPath = getAccountCredPath(config.currentAccount);
    if (fs.existsSync(CLAUDE_CREDS) && fs.existsSync(currentCredPath)) {
      try { fs.copyFileSync(CLAUDE_CREDS, currentCredPath); } catch {}
    }
  }

  // 如果目标账户的 accessToken 已过期，先用 refreshToken 刷新
  // 这样复制到活跃位置时 Claude Code 能直接使用，无需重新登录
  try {
    const creds = JSON.parse(fs.readFileSync(credPath, 'utf-8')) as Credentials;
    if ((creds?.claudeAiOauth?.expiresAt ?? 0) < Date.now()) {
      await refreshOAuthToken(name);
    }
  } catch {}

  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  fs.copyFileSync(credPath, CLAUDE_CREDS); // 此时已是最新 token
  config.currentAccount = name;
  config.currentApiProvider = undefined; // 清除 API Provider 模式
  saveConfig(config);
  clearApiProviderSettings();
}

// ─── API Provider 切换 ─────────────────────────────────────────────────────────

function switchToApiProvider(name: string): void {
  const config = loadConfig();
  const provider = config.apiProviders?.find((p) => p.name === name);
  if (!provider) {
    throw new Error(`API Provider "${name}" 不存在`);
  }

  // 写入 settings.json
  const settings: Record<string, unknown> = {};
  if (fs.existsSync(CLAUDE_SETTINGS)) {
    try {
      Object.assign(settings, JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf-8')));
    } catch {}
  }
  settings.env = settings.env || {};
  // __cas 标记表示此 env 块由本扩展写入，避免误清除 cc-switch 等工具的配置
  (settings.env as Record<string, string>).__cas = '1';
  (settings.env as Record<string, string>).ANTHROPIC_API_KEY = provider.apiKey;
  (settings.env as Record<string, string>).ANTHROPIC_BASE_URL = provider.baseUrl;

  // GLM-5.1 风格：使用 DEFAULT_*_MODEL 环境变量
  if (provider.model) {
    // 如果 model 包含 GLM，则设置三个默认模型变量
    if (provider.model.toUpperCase().includes('GLM')) {
      (settings.env as Record<string, string>).ANTHROPIC_DEFAULT_OPUS_MODEL = provider.model;
      (settings.env as Record<string, string>).ANTHROPIC_DEFAULT_SONNET_MODEL = provider.model;
      // Haiku 用轻量模型
      (settings.env as Record<string, string>).ANTHROPIC_DEFAULT_HAIKU_MODEL = 'GLM-4.5-air';
    } else {
      // 非 GLM 模型，使用单一 MODEL 变量
      (settings.env as Record<string, string>).ANTHROPIC_MODEL = provider.model;
    }
  }

  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2), 'utf-8');

  config.currentApiProvider = name;
  config.currentAccount = undefined; // 清除 OAuth 账户模式
  saveConfig(config);
}

function clearApiProviderSettings(): void {
  if (!fs.existsSync(CLAUDE_SETTINGS)) {return;}
  try {
    const settings: Record<string, unknown> = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf-8'));
    if (settings.env) {
      const env = settings.env as Record<string, unknown>;
      // 只清除由本扩展写入的配置（__cas 标记），避免误删 cc-switch 等工具的配置
      if (!env.__cas) { return; }
      const keysToClean = [
        '__cas',
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_AUTH_TOKEN',
        'ANTHROPIC_BASE_URL',
        'ANTHROPIC_MODEL',
        'ANTHROPIC_DEFAULT_OPUS_MODEL',
        'ANTHROPIC_DEFAULT_SONNET_MODEL',
        'ANTHROPIC_DEFAULT_HAIKU_MODEL',
      ];
      for (const key of keysToClean) {
        delete env[key];
      }
      // 如果 env 为空对象，整个删除
      if (Object.keys(env).length === 0) {
        delete settings.env;
      }
      fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2), 'utf-8');
    }
  } catch {}
}

// ─── 重置时间格式化 ───────────────────────────────────────────────────────────

function formatResetTime(resetsAt: string | undefined): string {
  if (!resetsAt) {return '';}
  const diffMs = new Date(resetsAt).getTime() - Date.now();
  if (diffMs <= 0) {return '已重置';}
  const h = Math.floor(diffMs / 3600000);
  const m = Math.floor((diffMs % 3600000) / 60000);
  if (h >= 1) {return `${h}小时${m > 0 ? m + '分' : ''}后重置`;}
  return `${m}分钟后重置`;
}

// ─── 使用量百分比格式化 ───────────────────────────────────────────────────────

function pct(n: number): string {
  return `${Math.round(n)}%`;
}

function usageColor(n: number): string {
  if (n >= 80) {return '#f44336';}
  if (n >= 50) {return '#ff9800';}
  return '#4caf50';
}

// ─── Webview 使用量面板 ───────────────────────────────────────────────────────

function buildUsageHtml(
  accounts: { name: string; info: AccountInfo | null; usage: UsageData | null }[]
): string {
  const cards = accounts
    .map(({ name, info, usage }) => {
      const email = info?.email ?? '—';
      const plan = info?.plan === 'pro' ? 'Claude Pro' : (info?.plan ?? '—');
      const displayName = info?.displayName ?? name;

      const sessionPct = usage ? usage.five_hour.utilization : null;
      const weeklyPct = usage ? usage.seven_day.utilization : null;
      const sonnetPct = usage?.seven_day_sonnet?.utilization ?? null;
      const sessionReset = formatResetTime(usage?.five_hour?.resets_at);
      const weeklyReset = formatResetTime(usage?.seven_day?.resets_at);
      const sonnetReset = formatResetTime(usage?.seven_day_sonnet?.resets_at);

      const makeBar = (val: number | null, label: string, sub: string) => {
        if (val === null) {
          return `<div class="usage-row">
            <div class="usage-label"><span>${label}</span><span class="dim">—</span></div>
            <div class="progress-track"><div class="progress-fill" style="width:0%"></div></div>
            <div class="sub">${sub}</div>
          </div>`;
        }
        const color = usageColor(val);
        const width = Math.min(Math.round(val), 100);
        return `<div class="usage-row">
          <div class="usage-label"><span>${label}</span><span style="color:${color}">${pct(val)}</span></div>
          <div class="progress-track"><div class="progress-fill" style="width:${width}%;background:${color}"></div></div>
          <div class="sub">${sub}</div>
        </div>`;
      };

      const extra = usage?.extra_usage?.is_enabled && usage.extra_usage.used_credits !== null
        ? `<div class="extra">额外额度: ${usage.extra_usage.used_credits?.toLocaleString()} / ${usage.extra_usage.monthly_limit?.toLocaleString()}</div>`
        : '';

      const noUsage = !usage
        ? `<div class="dim" style="margin-top:8px;font-size:0.85em">无法获取使用量数据（Token 可能已过期）</div>`
        : '';

      return `<div class="card">
        <div class="card-header">
          <div>
            <span class="account-name">${name}</span>
            <span class="badge">${plan}</span>
          </div>
          <div class="account-email">${email}</div>
          <div class="dim" style="font-size:0.82em">${displayName}</div>
        </div>
        ${makeBar(sessionPct, 'Session (5hr)', sessionReset)}
        ${makeBar(weeklyPct, 'Weekly (7 day)', weeklyReset)}
        ${sonnetPct !== null ? makeBar(sonnetPct, 'Weekly Sonnet', sonnetReset) : ''}
        ${extra}
        ${noUsage}
      </div>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 20px;
    max-width: 480px;
  }
  h2 { margin-bottom: 16px; font-size: 1em; font-weight: 600; opacity: 0.7; text-transform: uppercase; letter-spacing: 0.05em; }
  .card {
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px;
    padding: 14px 16px;
    margin-bottom: 14px;
  }
  .card-header { margin-bottom: 12px; }
  .account-name { font-weight: 600; font-size: 1em; }
  .account-email { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-top: 3px; }
  .badge {
    display: inline-block;
    padding: 1px 7px;
    border-radius: 3px;
    font-size: 0.72em;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    margin-left: 7px;
    vertical-align: middle;
  }
  .usage-row { margin-bottom: 10px; }
  .usage-label { display: flex; justify-content: space-between; font-size: 0.83em; margin-bottom: 4px; }
  .progress-track {
    height: 6px;
    background: var(--vscode-progressBar-background, #333);
    overflow: hidden;
  }
  .progress-fill { height: 100%; }
  .sub { font-size: 0.75em; color: var(--vscode-descriptionForeground); margin-top: 2px; }
  .extra { font-size: 0.8em; color: var(--vscode-descriptionForeground); margin-top: 6px; }
  .dim { opacity: 0.5; }
  .refresh-btn {
    display: block;
    margin-top: 4px;
    padding: 5px 14px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    border-radius: 3px;
    cursor: pointer;
    font-size: 0.85em;
  }
  .refresh-btn:hover { background: var(--vscode-button-hoverBackground); }
  .header-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
</style>
</head>
<body>
  <div class="header-row">
    <h2>Claude 账户使用量</h2>
    <button class="refresh-btn" onclick="refresh()">刷新</button>
  </div>
  ${cards}
  <script>
    const vscode = acquireVsCodeApi();
    function refresh() { vscode.postMessage({ command: 'refresh' }); }
  </script>
</body>
</html>`;
}

// ─── 状态栏 ───────────────────────────────────────────────────────────────────

let statusBar: vscode.StatusBarItem;

function refreshStatusBar(): void {
  const config = loadConfig();

  // 检查是否在使用 API Provider
  if (config.currentApiProvider) {
    const provider = config.apiProviders?.find((p) => p.name === config.currentApiProvider);
    if (provider) {
      statusBar.text = `$(server) ${provider.name}`;
      statusBar.tooltip = `当前 API Provider: ${provider.name}\n${provider.baseUrl}\n点击切换`;
      statusBar.show();
      return;
    }
  }

  // OAuth 账户模式
  const current = detectCurrentAccount(config);
  const info = current ? readAccountInfo(current) : null;
  const emailHint = info?.email ? ` (${info.email})` : '';
  statusBar.text = `$(account) ${current ?? 'default'}`;
  statusBar.tooltip = `当前 Claude 账户: ${current ?? 'default'}${emailHint}\n点击切换`;
  statusBar.show();
}

// ─── Quick Pick 条目 ──────────────────────────────────────────────────────────

function buildAccountQuickPickItems(
  config: Config,
  currentName?: string,
  usageMap?: Map<string, UsageData | null>
) {
  return config.accounts.map((a) => {
    const info = readAccountInfo(a.name);
    const isCurrent = a.name === currentName;
    const planLabel = info?.plan === 'pro' ? 'Pro' : (info?.plan ?? '?');
    const usage = usageMap?.get(a.name);

    let usageSuffix = '';
    if (usage) {
      const s = Math.round(usage.five_hour.utilization);
      const w = Math.round(usage.seven_day.utilization);
      usageSuffix = `  ·  Session ${s}%  ·  Weekly ${w}%`;
    }

    return {
      label: (isCurrent ? '$(check) ' : '$(account) ') + a.name,
      description: info?.email ?? a.description ?? '',
      detail: info
        ? `${planLabel}  ·  ${info.organization || info.displayName || ''}${usageSuffix}`
        : usageSuffix,
      accountName: a.name,
    };
  });
}

// ─── 命令：切换账户 ───────────────────────────────────────────────────────────

async function commandSwitch(): Promise<void> {
  const config = loadConfig();
  const hasAccounts = config.accounts.length > 0;
  const hasProviders = (config.apiProviders?.length ?? 0) > 0;

  if (!hasAccounts && !hasProviders) {
    const action = await vscode.window.showInformationMessage(
      '还没有保存任何账户或 API Provider',
      '添加账户',
      '添加 Provider'
    );
    if (action === '添加账户') {await commandAdd();}
    else if (action === '添加 Provider') {await commandAddApiProvider();}
    return;
  }

  type SwitchItem = { label: string; description: string; detail: string; itemType: 'account' | 'provider'; itemName: string };
  const items: SwitchItem[] = [];
  const currentAccount = detectCurrentAccount(config);
  const currentProvider = config.currentApiProvider;

  // 添加 API Providers（优先显示）
  if (config.apiProviders) {
    for (const p of config.apiProviders) {
      const isCurrent = p.name === currentProvider;
      items.push({
        label: (isCurrent ? '$(check) ' : '$(server) ') + p.name,
        description: p.baseUrl,
        detail: p.model ? `Model: ${p.model}` : '默认模型',
        itemType: 'provider',
        itemName: p.name,
      });
    }
  }

  // 添加 OAuth 账户
  for (const a of config.accounts) {
    const info = readAccountInfo(a.name);
    const isCurrent = a.name === currentAccount && !currentProvider;
    const planLabel = info?.plan === 'pro' ? 'Pro' : (info?.plan ?? '?');
    items.push({
      label: (isCurrent ? '$(check) ' : '$(account) ') + a.name,
      description: info?.email ?? a.description ?? '',
      detail: `${planLabel}  ·  ${info?.organization || info?.displayName || ''}`,
      itemType: 'account',
      itemName: a.name,
    });
  }

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: '切换账户或 API Provider',
    matchOnDescription: true,
    matchOnDetail: true,
  });

  if (!selected) {return;}

  // 已经是当前选中的，不做任何操作
  if (selected.itemType === 'provider' && selected.itemName === currentProvider) {return;}
  if (selected.itemType === 'account' && selected.itemName === currentAccount && !currentProvider) {return;}

  try {
    if (selected.itemType === 'provider') {
      switchToApiProvider(selected.itemName);
    } else {
      await switchToAccount(selected.itemName);
    }
    refreshStatusBar();
    const action = await vscode.window.showInformationMessage(
      `已切换到 "${selected.itemName}"，重载窗口后生效`,
      '立即重载'
    );
    if (action === '立即重载') {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`切换失败: ${message}`);
  }
}

// ─── 命令：使用量面板 ─────────────────────────────────────────────────────────

let usagePanel: vscode.WebviewPanel | undefined;

async function commandUsage(): Promise<void> {
  const config = loadConfig();
  if (config.accounts.length === 0) {
    vscode.window.showInformationMessage('还没有保存任何账户');
    return;
  }

  if (usagePanel) {
    usagePanel.reveal();
  } else {
    usagePanel = vscode.window.createWebviewPanel(
      'claudeUsage',
      'Claude 账户使用量',
      vscode.ViewColumn.Beside,
      { enableScripts: true }
    );
    usagePanel.onDidDispose(() => {
      usagePanel = undefined;
    });
    usagePanel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.command === 'refresh') {
        usageCache.clear();
        await updateUsagePanel(config);
      }
    });
  }

  await updateUsagePanel(config);
}

async function updateUsagePanel(config: Config): Promise<void> {
  if (!usagePanel) {
    return;
  }

  // 先展示加载中
  usagePanel.webview.html = buildUsageHtml(
    config.accounts.map((a) => ({
      name: a.name,
      info: readAccountInfo(a.name),
      usage: null,
    }))
  );

  // 并发拉取所有账户使用量
  const results = await Promise.all(
    config.accounts.map(async (a) => ({
      name: a.name,
      info: readAccountInfo(a.name),
      usage: await getUsage(a.name),
    }))
  );

  if (usagePanel) {
    usagePanel.webview.html = buildUsageHtml(results);
  }
}

// ─── 命令：添加账户 ───────────────────────────────────────────────────────────

async function commandAdd(): Promise<void> {
  type AddOption = { label: string; id: 'save-current' | 'new-login' };
  const options: AddOption[] = [];
  if (fs.existsSync(CLAUDE_CREDS)) {
    options.push({ label: '$(save) 保存当前 Claude 会话为账户', id: 'save-current' });
  }
  options.push({ label: '$(sign-in) 登录新账户', id: 'new-login' });

  const action = await vscode.window.showQuickPick(options, { placeHolder: '如何添加账户？' });
  if (!action) {
    return;
  }

  if (action.id === 'save-current') {
    await saveCurrentSession();
  } else {
    await loginNewAccount();
  }
}

async function saveCurrentSession(): Promise<void> {
  const config = loadConfig();
  let autoName = '';
  try {
    const claudeJsonPath = path.join(CLAUDE_DIR, '.claude.json');
    if (fs.existsSync(claudeJsonPath)) {
      const claudeJson = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8')) as ClaudeJson;
      const email = claudeJson?.oauthAccount?.emailAddress ?? '';
      if (email) {
        autoName = generateAccountName(email, config.accounts);
      }
    }
  } catch {}

  const name = await vscode.window.showInputBox({
    prompt: '输入账户名称',
    value: autoName,
    placeHolder: '例如：scotlandmail_01',
    validateInput: (v) => {
      if (!v?.trim()) {return '名称不能为空';}
      if (!/^[\w-]+$/.test(v)) {return '只能包含字母、数字、- 和 _';}
      if (config.accounts.find((a) => a.name === v)) {return '该名称已存在';}
      return null;
    },
  });
  if (!name) {
    return;
  }

  const accountDir = getAccountDir(name);
  fs.mkdirSync(accountDir, { recursive: true });
  fs.copyFileSync(CLAUDE_CREDS, path.join(accountDir, '.credentials.json'));
  const claudeJsonSrc = path.join(CLAUDE_DIR, '.claude.json');
  if (fs.existsSync(claudeJsonSrc)) {
    fs.copyFileSync(claudeJsonSrc, path.join(accountDir, '.claude.json'));
  }

  const info = readAccountInfo(name);
  config.accounts.push({ name, description: info?.email ?? '' });
  config.currentAccount = name;
  saveConfig(config);

  vscode.window.showInformationMessage(
    `账户 "${name}"${info?.email ? ` (${info.email})` : ''} 已保存`
  );
  refreshStatusBar();
}

async function loginNewAccount(): Promise<void> {
  const tempName = `_pending_${Date.now()}`;
  const accountDir = getAccountDir(tempName);
  fs.mkdirSync(accountDir, { recursive: true });

  const terminal = vscode.window.createTerminal({
    name: 'Claude 登录新账户',
    shellPath: 'cmd.exe',
    env: { CLAUDE_CONFIG_DIR: accountDir },
  });
  terminal.show();
  terminal.sendText('claude');

  vscode.window.showInformationMessage('请在终端中完成 Claude 登录，登录成功后将自动保存账户');

  const credPath = path.join(accountDir, '.credentials.json');
  const claudeJsonPath = path.join(accountDir, '.claude.json');
  let attempts = 0;

  const poll = setInterval(async () => {
    attempts++;
    if (fs.existsSync(credPath)) {
      clearInterval(poll);
      let autoName = '';

      // .claude.json 可能在 credentials 出现后数秒才写入，等待最多 5 秒
      await new Promise<void>((resolve) => {
        let waited = 0;
        const waitForClaudeJson = setInterval(() => {
          waited += 500;
          if (fs.existsSync(claudeJsonPath) || waited >= 5000) {
            clearInterval(waitForClaudeJson);
            resolve();
          }
        }, 500);
      });

      if (fs.existsSync(claudeJsonPath)) {
        try {
          const claudeJson = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8')) as ClaudeJson;
          const email = claudeJson?.oauthAccount?.emailAddress ?? '';
          if (email) {
            autoName = generateAccountName(email, loadConfig().accounts);
          }
        } catch {}
      }

      const currentConfig = loadConfig();
      const name = await vscode.window.showInputBox({
        prompt: '登录成功！确认账户名称',
        value: autoName,
        validateInput: (v) => {
          if (!v?.trim()) {return '名称不能为空';}
          if (!/^[\w-]+$/.test(v)) {return '只能包含字母、数字、- 和 _';}
          if (currentConfig.accounts.find((a) => a.name === v)) {return '该名称已存在';}
          return null;
        },
      });

      if (!name) {
        fs.rmSync(accountDir, { recursive: true, force: true });
        return;
      }

      const finalDir = getAccountDir(name);
      fs.renameSync(accountDir, finalDir);
      const info = readAccountInfo(name);
      currentConfig.accounts.push({ name, description: info?.email ?? '' });
      saveConfig(currentConfig);
      vscode.window.showInformationMessage(`账户 "${name}"${info?.email ? ` (${info.email})` : ''} 已保存`);
      refreshStatusBar();
    } else if (attempts >= 300) {
      clearInterval(poll);
      fs.rmSync(accountDir, { recursive: true, force: true });
      vscode.window.showWarningMessage('等待登录超时，请重新尝试添加账户');
    }
  }, 1000);
}

// ─── 命令：删除账户 ───────────────────────────────────────────────────────────

async function commandRemove(): Promise<void> {
  const config = loadConfig();
  if (config.accounts.length === 0) {
    vscode.window.showInformationMessage('没有可删除的账户');
    return;
  }

  const current = detectCurrentAccount(config);
  const items = buildAccountQuickPickItems(config, current);
  const selected = await vscode.window.showQuickPick(items, { placeHolder: '选择要删除的账户' });
  if (!selected) {
    return;
  }

  const info = readAccountInfo(selected.accountName);
  const label = info?.email
    ? `"${selected.accountName}" (${info.email})`
    : `"${selected.accountName}"`;

  const confirm = await vscode.window.showWarningMessage(
    `确定删除账户 ${label}？此操作不可撤销。`,
    { modal: true },
    '删除'
  );
  if (confirm !== '删除') {
    return;
  }

  config.accounts = config.accounts.filter((a) => a.name !== selected.accountName);
  if (config.currentAccount === selected.accountName) {
    config.currentAccount = undefined;
  }
  saveConfig(config);

  const accountDir = getAccountDir(selected.accountName);
  if (fs.existsSync(accountDir)) {
    fs.rmSync(accountDir, { recursive: true, force: true });
  }
  usageCache.delete(selected.accountName);

  vscode.window.showInformationMessage(`账户 ${label} 已删除`);
  refreshStatusBar();
}

// ─── 命令：当前账户详情 ───────────────────────────────────────────────────────

function commandWhoami(): void {
  const config = loadConfig();

  // 检查是否在使用 API Provider
  if (config.currentApiProvider) {
    const provider = config.apiProviders?.find((p) => p.name === config.currentApiProvider);
    if (provider) {
      vscode.window.showInformationMessage(
        [`API Provider: ${provider.name}`, `Base URL: ${provider.baseUrl}`, `Model: ${provider.model || '默认'}`].join('\n'),
        { modal: true },
        '确定'
      );
      return;
    }
  }

  const current = detectCurrentAccount(config);
  if (!current) {
    vscode.window.showInformationMessage('当前使用默认 Claude 账户（未通过本扩展管理）');
    return;
  }
  const info = readAccountInfo(current);
  if (!info) {
    vscode.window.showInformationMessage(`当前账户: ${current}`);
    return;
  }
  const planLabel = info.plan === 'pro' ? 'Claude Pro' : info.plan;
  vscode.window.showInformationMessage(
    [`账户名: ${current}`, `邮箱: ${info.email || '—'}`, `姓名: ${info.displayName || '—'}`, `组织: ${info.organization || '—'}`, `计划: ${planLabel}`].join('\n'),
    { modal: true },
    '确定'
  );
}

// ─── 命令：添加 API Provider ───────────────────────────────────────────────────

interface ProviderPreset {
  name: string;
  baseUrl: string;
  model: string;
  description: string;
}

const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    name: 'GLM-5.1',
    baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
    model: 'GLM-5.1',
    description: '智谱最新旗舰模型，面向 Coding/Agent',
  },
  {
    name: 'GLM-5',
    baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
    model: 'GLM-5',
    description: '智谱旗舰模型，支持深度思考',
  },
];

async function commandAddApiProvider(): Promise<void> {
  // 先选择预设或自定义
  type PresetOption = { label: string; description: string; preset?: ProviderPreset; isCustom: boolean };
  const presetOptions: PresetOption[] = [
    ...PROVIDER_PRESETS.map((p) => ({
      label: '$(zap) ' + p.name,
      description: p.description,
      preset: p,
      isCustom: false,
    })),
    { label: '$(edit) 自定义 Provider', description: '手动输入所有配置', isCustom: true },
  ];

  const selectedPreset = await vscode.window.showQuickPick(presetOptions, {
    placeHolder: '选择预设或自定义 Provider',
  });
  if (!selectedPreset) {return;}

  let name: string;
  let baseUrl: string;
  let model: string | undefined;

  if (selectedPreset.preset) {
    // 使用预设
    const preset = selectedPreset.preset;
    name = preset.name;
    baseUrl = preset.baseUrl;
    model = preset.model;
  } else {
    // 自定义流程
    const inputName = await vscode.window.showInputBox({
      prompt: 'Provider 名称',
      placeHolder: '例如：SiliconFlow、OpenRouter',
      validateInput: (v) => {
        if (!v?.trim()) {return '名称不能为空';}
        const config = loadConfig();
        if (config.apiProviders?.find((p) => p.name === v)) {return '该名称已存在';}
        return null;
      },
    });
    if (!inputName) {return;}
    name = inputName;

    const inputBaseUrl = await vscode.window.showInputBox({
      prompt: 'API Base URL（Anthropic 兼容端点）',
      placeHolder: '例如：https://api.siliconflow.cn/v1',
      validateInput: (v) => {
        if (!v?.trim()) {return 'URL 不能为空';}
        if (!v.startsWith('http')) {return '必须是有效的 URL';}
        return null;
      },
    });
    if (!inputBaseUrl) {return;}
    baseUrl = inputBaseUrl;

    const inputModel = await vscode.window.showInputBox({
      prompt: '模型名称（可选，留空使用默认）',
      placeHolder: '例如：claude-sonnet-4-20250514',
    });
    model = inputModel || undefined;
  }

  const apiKey = await vscode.window.showInputBox({
    prompt: `${name} API Key`,
    placeHolder: 'sk-...',
    password: true,
    validateInput: (v) => {
      if (!v?.trim()) {return 'API Key 不能为空';}
      return null;
    },
  });
  if (!apiKey) {return;}

  const config = loadConfig();
  config.apiProviders = config.apiProviders || [];
  config.apiProviders.push({ name, baseUrl, apiKey, model: model || undefined });
  saveConfig(config);

  vscode.window.showInformationMessage(`API Provider "${name}" 已添加`);
}

// ─── 命令：切换到 API Provider ─────────────────────────────────────────────────

async function commandSwitchApiProvider(): Promise<void> {
  const config = loadConfig();
  if (!config.apiProviders?.length) {
    const action = await vscode.window.showInformationMessage(
      '还没有添加任何 API Provider',
      '添加 Provider'
    );
    if (action) {await commandAddApiProvider();}
    return;
  }

  const current = config.currentApiProvider;
  const items = config.apiProviders.map((p) => ({
    label: (p.name === current ? '$(check) ' : '$(server) ') + p.name,
    description: p.baseUrl,
    detail: p.model ? `Model: ${p.model}` : '默认模型',
    providerName: p.name,
  }));

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: '选择 API Provider',
  });

  if (!selected || selected.providerName === current) {return;}

  try {
    switchToApiProvider(selected.providerName);
    refreshStatusBar();
    const action = await vscode.window.showInformationMessage(
      `已切换到 "${selected.providerName}"，重载窗口后生效`,
      '立即重载'
    );
    if (action === '立即重载') {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`切换失败: ${message}`);
  }
}

// ─── 命令：删除 API Provider ───────────────────────────────────────────────────

async function commandRemoveApiProvider(): Promise<void> {
  const config = loadConfig();
  if (!config.apiProviders?.length) {
    vscode.window.showInformationMessage('没有可删除的 API Provider');
    return;
  }

  const items = config.apiProviders.map((p) => ({
    label: '$(server) ' + p.name,
    description: p.baseUrl,
    providerName: p.name,
  }));

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: '选择要删除的 API Provider',
  });
  if (!selected) {return;}

  const confirm = await vscode.window.showWarningMessage(
    `确定删除 "${selected.providerName}"？`,
    { modal: true },
    '删除'
  );
  if (confirm !== '删除') {return;}

  config.apiProviders = config.apiProviders.filter((p) => p.name !== selected.providerName);
  if (config.currentApiProvider === selected.providerName) {
    config.currentApiProvider = undefined;
    clearApiProviderSettings();
  }
  saveConfig(config);

  vscode.window.showInformationMessage(`API Provider "${selected.providerName}" 已删除`);
  refreshStatusBar();
}

// ─── 扩展入口 ─────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'claude-switcher.switch';
  context.subscriptions.push(statusBar);
  refreshStatusBar();

  context.subscriptions.push(
    vscode.commands.registerCommand('claude-switcher.switch', commandSwitch),
    vscode.commands.registerCommand('claude-switcher.add', commandAdd),
    vscode.commands.registerCommand('claude-switcher.remove', commandRemove),
    vscode.commands.registerCommand('claude-switcher.whoami', commandWhoami),
    vscode.commands.registerCommand('claude-switcher.usage', commandUsage),
    vscode.commands.registerCommand('claude-switcher.addProvider', commandAddApiProvider),
    vscode.commands.registerCommand('claude-switcher.switchProvider', commandSwitchApiProvider),
    vscode.commands.registerCommand('claude-switcher.removeProvider', commandRemoveApiProvider)
  );
}

export function deactivate(): void {
  statusBar?.dispose();
  usagePanel?.dispose();
}
