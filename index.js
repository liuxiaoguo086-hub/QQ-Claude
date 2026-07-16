#!/usr/bin/env node
/**
 * QQ → Claude 桥接程序
 *
 * 基于 QQ 官方 Bot WebSocket + Claude Agent SDK。
 * QQ 只做消息转发，后端是完整的 Claude Code 会话：
 * 危险操作经 QQ 审批，长任务节流推送进度。
 *
 * 用法:
 *   node index.js                # 前台运行
 *   node index.js --daemon       # 后台运行
 *   node index.js --stop         # 停止后台进程
 *   node index.js --status       # 查看后台进程状态
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { loadConfig } from "./src/config.js";
import { createQQClient, logout } from "./src/bot.js";
import { setDaemonMode, info, warn, error, raw } from "./src/logger.js";
import { loadMemorySummaries } from "./src/store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PID_FILE = path.join(__dirname, "data", "bridge.pid");

// 静音 SDK 的 canUseTool 遮蔽警告（Read/Glob 等在白名单里不进审批回调，正是设计如此）
process.emitWarning = ((orig) => (warning, ...args) => {
  const isShadowWarn = args.some(
    (a) => a === "CLAUDE_SDK_CAN_USE_TOOL_SHADOWED" || a?.code === "CLAUDE_SDK_CAN_USE_TOOL_SHADOWED",
  );
  if (isShadowWarn) return;
  return orig.call(process, warning, ...args);
})(process.emitWarning);

// ─── 命令行参数 ──────────────────────────────────────────────

const args = process.argv.slice(2);
const daemon    = args.includes("--daemon");
const doStop    = args.includes("--stop");
const doStatus  = args.includes("--status");

// ─── 后台管理 ────────────────────────────────────────────────

function writePid(pid) {
  fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
  fs.writeFileSync(PID_FILE, String(pid), "utf-8");
}

function readPid() {
  try {
    if (fs.existsSync(PID_FILE)) {
      return parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10);
    }
  } catch (_) {}
  return null;
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

let _shouldExit = false;

if (doStop) {
  _shouldExit = true;
  const pid = readPid();
  if (!pid || !isRunning(pid)) {
    console.log("⚠️  桥接程序未在运行。");
    try { fs.unlinkSync(PID_FILE); } catch (_) {}
    process.exit(0);
  }
  console.log(`🛑 正在停止桥接进程 (PID: ${pid})...`);
  process.kill(pid, "SIGTERM");
  let wait = 0;
  const check = setInterval(() => {
    if (!isRunning(pid)) {
      clearInterval(check);
      try { fs.unlinkSync(PID_FILE); } catch (_) {}
      console.log("✅ 已停止。");
      process.exit(0);
    }
    wait += 200;
    if (wait > 5000) {
      clearInterval(check);
      console.log("⚠️  进程未响应 SIGTERM，强制终止...");
      try { process.kill(pid, "SIGKILL"); } catch (_) {}
      try { fs.unlinkSync(PID_FILE); } catch (_) {}
      console.log("✅ 已强制停止。");
      process.exit(0);
    }
  }, 200);
}

if (doStatus) {
  _shouldExit = true;
  const pid = readPid();
  if (pid && isRunning(pid)) {
    // 读取配置
    const config = loadConfig();
    const memFiles = loadMemorySummaries();
    const logDir = path.join(__dirname, "logs");
    const files = fs.existsSync(logDir) ? fs.readdirSync(logDir).filter(f => f.startsWith("bridge-")).sort().reverse() : [];
    const logFile = files.length > 0 ? path.join(logDir, files[0]) : "(无日志)";

    console.log(`✅ QQ 桥接程序运行中 (PID: ${pid})`);
    console.log(`   Bot AppID: ${config.qq.appId}`);
    console.log(`   沙箱: ${config.qq.sandbox !== false ? "是" : "否"}`);
    console.log(`   模型: ${config.claude.model}`);
    console.log(`   记忆目录: ${config.memory.dir} (${memFiles.length} 个文件)`);
    console.log(`   日志文件: ${logFile}`);
    process.exit(0);
  } else {
    console.log("⏸️  QQ 桥接程序未在运行。");
    try { fs.unlinkSync(PID_FILE); } catch (_) {}
    process.exit(0);
  }
}

if (daemon) {
  _shouldExit = true;
  const existingPid = readPid();
  if (existingPid && isRunning(existingPid)) {
    console.log(`⚠️  桥接程序已在运行中 (PID: ${existingPid})`);
    process.exit(1);
  }
  try { fs.unlinkSync(PID_FILE); } catch (_) {}

  const child = spawn(
    process.execPath,
    [path.join(__dirname, "index.js"), "--internal-daemon"],
    {
      cwd: __dirname,
      detached: true,
      stdio: "ignore",
      env: { ...process.env },
    }
  );
  child.unref();
  console.log(`✅ QQ 桥接程序已以后台模式启动 (PID: ${child.pid})`);
  console.log(`   查看状态: node index.js --status`);
  console.log(`   停止程序: node index.js --stop`);
  process.exit(0);
}

// ─── 后台模式实际入口 ────────────────────────────────────────

if (args.includes("--internal-daemon")) {
  setDaemonMode(true);
  writePid(process.pid);
}

// ─── 主流程 ──────────────────────────────────────────────────

async function main() {
  const isInternalDaemon = args.includes("--internal-daemon");
  const config = loadConfig();

  // 启动校验
  if (!config.claude.apiKey) {
    error("claude.apiKey 未配置（data/config.json 或 ANTHROPIC_AUTH_TOKEN），无法启动。");
    process.exit(1);
  }
  if (!fs.existsSync(config.claudeCode.gitBashPath)) {
    warn(`claudeCode.gitBashPath 不存在: ${config.claudeCode.gitBashPath}，Bash 工具可能不可用`);
  }

  if (!isInternalDaemon) {
    const memFiles = loadMemorySummaries();

    raw("╔══════════════════════════════════════╗");
    raw("║  QQ → Claude 桥接程序  v2.0.0      ║");
    raw("╚══════════════════════════════════════╝");
    raw("");
    raw(`  Bot AppID: ${config.qq.appId || "(未配置)"}`);
    raw(`  Sandbox:   ${config.qq.sandbox !== false ? "沙箱 ✅" : "正式"}`);
    raw(`  模型:   ${config.claude.model}`);
    raw(`  后端:   Claude Code (Agent SDK) | cwd=${config.claudeCode.cwd}`);
    raw(`  记忆:   ${config.memory.dir} (${memFiles.length} 个文件)`);
    raw(`  审批:   危险操作经 QQ 审批，${Math.round(config.permissions.approvalTimeoutMs / 60000)} 分钟超时自动拒绝`);
    raw("");
  }

  // 启动 QQ 客户端
  let client;
  try {
    client = await createQQClient();
    info("QQ 客户端已启动，等待登录…");
  } catch (err) {
    error(`QQ 客户端启动失败: ${err.message}`);
    process.exit(1);
  }

  // 优雅退出
  const cleanup = async () => {
    info("收到退出信号，正在停止…");
    await logout();
    try { fs.unlinkSync(PID_FILE); } catch (_) {}
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("exit", () => {
    try { fs.unlinkSync(PID_FILE); } catch (_) {}
  });

  // 保持进程运行（QQ Bot WebSocket 自身维持事件循环）
  info("桥接程序就绪，等待 QQ 消息…");
}

if (!_shouldExit) {
  main().catch((err) => {
    error(`启动失败: ${err}`);
    process.exit(1);
  });
}
