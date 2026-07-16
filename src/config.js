/**
 * 配置管理 — 从配置文件和环境变量加载
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.resolve(__dirname, "..", "data", "config.json");

// 默认配置
const defaults = {
  qq: {
    appId: "",
    appSecret: "",
    sandbox: true,            // 沙箱环境（无频控，测试用）
  },
  claude: {
    apiKey: process.env.ANTHROPIC_AUTH_TOKEN || "",
    baseUrl: process.env.ANTHROPIC_BASE_URL || "https://api.deepseek.com/anthropic",
    model: process.env.ANTHROPIC_MODEL || "deepseek-v4-pro",
  },
  claudeCode: {
    cwd: "D:/claude_memory",            // Claude Code 会话工作目录（resume 要求 cwd 一致，勿随意改动）
    maxTurns: 50,                       // 单个任务最大轮次
    taskTimeoutMs: 1_800_000,           // 单个任务超时（30 分钟）
    gitBashPath: "D:/Git/bin/bash.exe", // Windows 下 Bash 工具依赖 Git Bash
  },
  permissions: {
    approvalTimeoutMs: 300_000,         // QQ 审批超时（5 分钟），超时自动拒绝
    // 自动放行的只读工具 + 安全 Bash 模式；其余全部走 QQ 审批
    autoAllowTools: [
      "Read", "Glob", "Grep", "TodoWrite", "Task", "WebSearch", "WebFetch",
      "Bash(ls:*)", "Bash(dir:*)", "Bash(cat:*)", "Bash(head:*)", "Bash(tail:*)",
      "Bash(pwd)", "Bash(echo:*)", "Bash(find:*)", "Bash(grep:*)", "Bash(rg:*)",
      "Bash(git status:*)", "Bash(git log:*)", "Bash(git diff:*)", "Bash(git show:*)",
      "Bash(curl:*)", "Bash(wget:*)", "Bash(ping:*)", "Bash(type:*)",
      "Bash(which:*)", "Bash(uname:*)", "Bash(whoami:*)", "Bash(hostname:*)",
      "Bash(df:*)", "Bash(du:*)", "Bash(free:*)", "Bash(date:*)",
      "Bash(node --version)", "Bash(npm --version)", "Bash(python --version)",
    ],
  },
  progress: {
    enabled: true,
    initialDelayMs: 30_000,   // 任务超过 30 秒才开始推送进度
    intervalMs: 60_000,       // 之后每 60 秒最多一条
  },
  reply: {
    budgetPerMsg: 5,          // QQ 被动回复条数上限（每 msg_id）
    windowMs: 270_000,        // 被动回复窗口（官方约 5 分钟，留 30 秒余量）
    chunkSize: 1500,          // 最终答案分块大小（字符）
    maxChunks: 3,             // 最终答案最多几条消息
  },
  security: {
    allowedUsers: [],         // owner 的 openid（字符串）；为空 = 允许所有人（危险！）
  },
  memory: {
    dir: "D:/claude_memory",          // 与 Claude Code 共享的记忆目录
    saveEveryExchange: true,          // 每次对话自动保存
  },
};

let _config = null;

export function loadConfig(overrides = {}) {
  let fileConfig = {};
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      fileConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    }
  } catch (e) {
    console.error(`[config] 读取配置文件失败: ${e.message}`);
  }

  // 深度合并：defaults < fileConfig < overrides
  _config = deepMerge(defaults, fileConfig, overrides);

  // 确保 memory 目录存在
  fs.mkdirSync(_config.memory.dir, { recursive: true });

  return _config;
}

export function getConfig() {
  if (!_config) return loadConfig();
  return _config;
}

function deepMerge(...sources) {
  const result = {};
  for (const src of sources) {
    if (!src) continue;
    for (const key of Object.keys(src)) {
      if (src[key] && typeof src[key] === "object" && !Array.isArray(src[key])) {
        result[key] = deepMerge(result[key] || {}, src[key]);
      } else {
        result[key] = src[key];
      }
    }
  }
  return result;
}
