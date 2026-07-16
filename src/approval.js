/**
 * 审批管理 — 危险操作经 QQ 请求用户批准
 *
 * canUseTool 回调 → requestApproval() → QQ 发审批请求 → 挂起等待
 * 用户回复 是/否 → bot.js 调 tryResolveApproval() → resolve
 * 超时（默认 5 分钟）→ 自动拒绝，任务继续
 */
import { getConfig } from "./config.js";
import { info, warn } from "./logger.js";

const pendings = new Map(); // userId -> { resolve, timer, toolName }
const queues = new Map();   // userId -> Promise 链（SDK 可能并发回调，串行化逐个审批）

const YES = ["是", "y", "yes", "允许", "同意", "批准", "1"];
const NO = ["否", "n", "no", "拒绝", "不", "0"];

export function hasPendingApproval(userId) {
  return pendings.has(userId);
}

/** 把工具输入摘要成人话 */
export function summarizeToolInput(toolName, input = {}) {
  if (toolName === "Bash") return `命令: ${String(input.command || "").slice(0, 200)}`;
  if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(toolName)) {
    return `文件: ${input.file_path || input.notebook_path || "?"}`;
  }
  if (toolName === "WebFetch") return `URL: ${input.url || "?"}`;
  return `参数: ${JSON.stringify(input).slice(0, 200)}`;
}

/**
 * 由 canUseTool 回调调用：发送审批请求并等待用户决定
 * @returns {Promise<{approved: boolean, reason?: string}>}
 */
export function requestApproval(userId, toolName, input, channel) {
  // 串行化：同一用户同时只挂一个审批，其余排队
  const prev = queues.get(userId) || Promise.resolve();
  const p = prev.then(() => askOne(userId, toolName, input, channel));
  queues.set(userId, p.catch(() => {}));
  return p;
}

async function askOne(userId, toolName, input, channel) {
  const { approvalTimeoutMs } = getConfig().permissions;
  const minutes = Math.round(approvalTimeoutMs / 60_000);
  const text = [
    "⚠️ 权限请求",
    `工具: ${toolName}`,
    summarizeToolInput(toolName, input),
    `回复 是/y 允许，否/n 拒绝（${minutes} 分钟未回复自动拒绝）`,
  ].join("\n");

  const sent = await channel.send(text, { kind: "approval" });
  if (!sent) {
    // 审批请求都发不出去 → 立即拒绝，别白等 5 分钟
    warn(`[approval] 审批请求无法送达 ${userId}，自动拒绝 ${toolName}`);
    return { approved: false, reason: "审批请求无法送达用户，操作已拒绝" };
  }
  info(`[approval] 审批请求已发送 | user=${userId} tool=${toolName}`);

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendings.delete(userId);
      info(`[approval] 超时自动拒绝 | user=${userId} tool=${toolName}`);
      resolve({ approved: false, reason: "用户未在时限内批准，操作已拒绝" });
    }, approvalTimeoutMs);
    pendings.set(userId, { resolve, timer, toolName });
  });
}

/**
 * bot.js 每条私聊消息先调它
 * @returns {boolean} true = 该消息已被审批流程消费，不要当成新任务
 */
export function tryResolveApproval(userId, text, channel) {
  const p = pendings.get(userId);
  const word = text.trim().toLowerCase();
  const isYes = YES.includes(word);
  const isNo = NO.includes(word);

  if (!p) {
    if (isYes || isNo) {
      // 迟到的审批回复（已超时或已处理），别当成新任务喂给 Claude
      channel.send("当前没有待审批的操作。", { kind: "system" });
      return true;
    }
    return false;
  }

  if (isYes || isNo) {
    clearTimeout(p.timer);
    pendings.delete(userId);
    info(`[approval] 用户${isYes ? "批准" : "拒绝"} | user=${userId} tool=${p.toolName}`);
    p.resolve(isYes ? { approved: true } : { approved: false, reason: "用户拒绝了该操作" });
    channel.send(isYes ? "✅ 已批准，继续执行…" : "🚫 已拒绝该操作", { kind: "system" });
  } else {
    channel.send(`有权限请求等待处理（${p.toolName}）：回复 是/y 允许，否/n 拒绝`, { kind: "system" });
  }
  return true; // 审批挂起期间的任何文本都被消费
}

/**
 * 任务结束/超时/异常时清理挂起审批（resolve 为拒绝，防止孤儿 timer）
 */
export function cancelApproval(userId, reason = "任务已结束") {
  const p = pendings.get(userId);
  if (!p) return;
  clearTimeout(p.timer);
  pendings.delete(userId);
  info(`[approval] 取消挂起审批 | user=${userId} tool=${p.toolName} | ${reason}`);
  p.resolve({ approved: false, reason });
}
