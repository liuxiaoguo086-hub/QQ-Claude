/**
 * 持久化存储 — SDK 会话映射 + 交换日志 + 记忆摘要
 * 与 Claude Code 共享 D:\claude_memory 目录
 * （对话历史已由 Claude Code 会话机制取代，本文件只存 userId→sessionId 映射）
 */
import fs from "node:fs";
import path from "node:path";
import { getConfig } from "./config.js";
import { info, error } from "./logger.js";

// ─── 路径工具 ───────────────────────────────────────────────

function memoryDir() {
  return getConfig().memory.dir;
}

function dataDir() {
  // 桥接自身数据放在记忆目录的 data/ 子目录
  const config = getConfig();
  return path.resolve(config.memory.dir, "data");
}

function sessionsPath() {
  fs.mkdirSync(dataDir(), { recursive: true });
  return path.join(dataDir(), "qq-bridge-sessions.json");
}

// ─── SDK 会话映射（userId → sessionId）─────────────────────

function loadSessions() {
  try {
    const p = sessionsPath();
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, "utf-8"));
    }
  } catch (e) {
    error(`读取会话映射失败: ${e.message}`);
  }
  return {};
}

function saveSessions(map) {
  try {
    fs.writeFileSync(sessionsPath(), JSON.stringify(map, null, 2), "utf-8");
  } catch (e) {
    error(`保存会话映射失败: ${e.message}`);
  }
}

/**
 * 获取某个用户的 Claude Code 会话 ID（无则返回 undefined）
 */
export function getSession(userId) {
  return loadSessions()[userId];
}

/**
 * 记录某个用户的会话 ID
 */
export function setSession(userId, sessionId) {
  const map = loadSessions();
  if (map[userId] === sessionId) return;
  map[userId] = sessionId;
  saveSessions(map);
  info(`[store] 会话映射更新: ${userId} → ${sessionId}`);
}

/**
 * 清除某个用户的会话（/clear 或 resume 失败时）
 */
export function clearSession(userId) {
  const map = loadSessions();
  delete map[userId];
  saveSessions(map);
}

// ─── 对话日志（每次交换都保存）──────────────────────────────

function exchangeLogPath() {
  fs.mkdirSync(dataDir(), { recursive: true });
  return path.join(dataDir(), "qq-bridge-exchange-log.json");
}

/**
 * 保存每次一问一答的完整记录（代码强制执行，不依赖 AI 记忆）
 */
export function saveExchange(userId, userMessage, assistantReply, toolCalls = []) {
  try {
    const p = exchangeLogPath();
    let log = [];
    if (fs.existsSync(p)) {
      log = JSON.parse(fs.readFileSync(p, "utf-8"));
    }
    log.push({
      timestamp: new Date().toISOString(),
      userId,
      userMessage,
      assistantReply,
      toolCalls,
    });
    // 保留最近 1000 条
    if (log.length > 1000) log = log.slice(-1000);
    fs.writeFileSync(p, JSON.stringify(log, null, 2), "utf-8");
  } catch (e) {
    error(`保存对话日志失败: ${e.message}`);
  }
}

// ─── 记忆文件摘要（--status / 启动横幅展示用）────────────────

/**
 * 读取所有记忆 .md 文件的名称和描述摘要
 */
export function loadMemorySummaries() {
  const dir = memoryDir();
  const files = [];
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith(".md") && f !== "MEMORY.md") {
        const content = fs.readFileSync(path.join(dir, f), "utf-8");
        // 提取 frontmatter 中的 description
        const descMatch = content.match(/description:\s*(.+)/);
        const desc = descMatch ? descMatch[1] : "";
        files.push({ file: f, description: desc });
      }
    }
  } catch (e) {
    error(`读取记忆目录失败: ${e.message}`);
  }
  return files;
}
