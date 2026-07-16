/**
 * Claude Code 后端 — 通过 Agent SDK 驱动完整的 Claude Code 会话
 * QQ 消息 → runTask() → query() → 审批/进度/最终答案 经 ReplyChannel 发回 QQ
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { getConfig } from "./config.js";
import { getSession, setSession, clearSession, saveExchange, loadMemorySummaries } from "./store.js";
import { requestApproval, cancelApproval, hasPendingApproval } from "./approval.js";
import { info, warn, error } from "./logger.js";

// ─── 运行状态 ────────────────────────────────────────────────

const running = new Map(); // userId -> { startedAt, currentStep }

export function isTaskRunning(userId) {
  return running.has(userId);
}

export function getRunningInfo(userId) {
  return running.get(userId) || null;
}

// ─── 桥接场景系统提示词（追加在 Claude Code 预设之后）────────

const BRIDGE_NOTE = [
  "## QQ 桥接场景（重要）",
  "- 你正通过 QQ 与用户远程对话。回复必须简短精炼（单条 ≤1500 字），使用中文。",
  "- 不要粘贴大段代码或原始输出，用一两句话总结结果。",
  "- 危险操作会经 QQ 转发给用户审批；若被拒绝，向用户说明哪一步没有执行。",
  "- 用户记忆库在 D:\\claude_memory（MEMORY.md 是索引）。需要背景信息时自行读取；",
  "  产生值得记住的信息时写入该目录（kebab-case 文件名，frontmatter + Markdown 正文）。",
].join("\n");

// ─── 命令处理 ────────────────────────────────────────────────

export function handleCommand(body, userId) {
  const config = getConfig();
  const cmd = body.trim().toLowerCase();

  if (cmd === "/clear" || cmd === "清除记忆" || cmd === "清空对话") {
    if (isTaskRunning(userId)) {
      return "任务运行中，无法重置会话。等任务完成后再试。";
    }
    clearSession(userId);
    return "会话已重置 ✓（下次对话将开启全新的 Claude Code 会话）";
  }

  if (cmd === "/help" || cmd === "帮助" || cmd === "命令") {
    return [
      "可用命令：",
      "/clear  — 重置会话（忘记之前的对话）",
      "/help   — 显示此帮助",
      "/status — 查看当前状态",
      "",
      "你也可以：",
      "· 让我执行命令（如「看看 D 盘有哪些文件」）",
      "· 让我读写文件、跑脚本、查资料",
      "· 危险操作我会先发权限请求，回复 是/否 决定",
      "",
      "直接发消息即可。",
    ].join("\n");
  }

  if (cmd === "/status" || cmd === "状态") {
    const run = getRunningInfo(userId);
    const runLine = run
      ? `运行中任务: ${run.currentStep}（已 ${Math.round((Date.now() - run.startedAt) / 1000)} 秒）`
      : "运行中任务: 无";
    return [
      "📊 当前状态",
      `模型: ${config.claude.model}`,
      `后端: Claude Code (Agent SDK)`,
      `会话: ${getSession(userId) ? "已有（连续对话中）" : "无（下条消息新建）"}`,
      runLine,
      `记忆目录: ${config.memory.dir}（${loadMemorySummaries().length} 个文件）`,
    ].join("\n");
  }

  return null;
}

// ─── 任务执行 ────────────────────────────────────────────────

/**
 * 执行一个任务（一条 QQ 消息 = 一次 Claude Code 交互）
 * @param {string} userId
 * @param {string} text
 * @param {import("./reply-channel.js").ReplyChannel} channel
 * @returns {Promise<string>} 最终答案文本
 */
export async function runTask(userId, text, channel) {
  running.set(userId, { startedAt: Date.now(), currentStep: "思考中…" });
  try {
    return await runQuery(userId, text, channel, getSession(userId));
  } catch (err) {
    if (isResumeError(err) && getSession(userId)) {
      // 会话文件丢失/损坏 → 清映射，无 resume 重试一次
      warn(`[agent] resume 失败，清除会话后重试: ${err.message}`);
      clearSession(userId);
      try {
        return await runQuery(userId, text, channel, undefined);
      } catch (err2) {
        error(`[agent] 重试仍失败: ${err2.stack || err2.message}`);
        return `抱歉，处理任务时出错了：${String(err2.message).slice(0, 200)}`;
      }
    }
    error(`[agent] 任务失败: ${err.stack || err.message}`);
    return `抱歉，处理任务时出错了：${String(err.message).slice(0, 200)}`;
  } finally {
    cancelApproval(userId, "任务已结束");
    running.delete(userId);
  }
}

async function runQuery(userId, text, channel, resumeId) {
  const cfg = getConfig();

  // CRITICAL: prompt 生成器必须保持打开直到收到 result，
  // 否则 SDK 关闭 stdin，canUseTool 的响应通道会报 Stream closed
  let finish;
  const finished = new Promise((r) => (finish = r));
  async function* promptStream() {
    yield { type: "user", message: { role: "user", content: text } };
    await finished;
  }

  const q = query({
    prompt: promptStream(),
    options: {
      cwd: cfg.claudeCode.cwd,
      resume: resumeId,
      maxTurns: cfg.claudeCode.maxTurns,
      systemPrompt: { type: "preset", preset: "claude_code", append: BRIDGE_NOTE },
      // 安全关键：不加载本机 settings.json，防止本机 allow 规则绕过 QQ 审批
      settingSources: [],
      allowedTools: cfg.permissions.autoAllowTools,
      permissionMode: "default",
      canUseTool: async (toolName, input) => {
        const r = await requestApproval(userId, toolName, input, channel);
        return r.approved
          ? { behavior: "allow", updatedInput: input }
          : { behavior: "deny", message: r.reason }; // 不 interrupt，任务继续
      },
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: cfg.claude.baseUrl,
        ANTHROPIC_AUTH_TOKEN: cfg.claude.apiKey,
        ANTHROPIC_MODEL: cfg.claude.model,
        CLAUDE_CODE_GIT_BASH_PATH: cfg.claudeCode.gitBashPath,
      },
      stderr: (data) => warn(`[claude-stderr] ${String(data).slice(0, 400)}`),
    },
  });

  const progress = startProgress(userId, channel);
  const killer = setTimeout(() => {
    warn(`[agent] 任务超时(${cfg.claudeCode.taskTimeoutMs}ms)，中断`);
    q.interrupt().catch(() => {});
  }, cfg.claudeCode.taskTimeoutMs);

  let finalText = "";
  let newSession = null;
  const toolLog = [];

  try {
    for await (const msg of q) {
      if (msg.type === "system" && msg.subtype === "init") {
        newSession = msg.session_id;
        info(`[agent] init | session=${msg.session_id} | model=${msg.model}`);
      }
      if (msg.type === "assistant") {
        for (const b of msg.message.content || []) {
          if (b.type === "tool_use") {
            const step = describeToolUse(b.name, b.input);
            const run = running.get(userId);
            if (run) run.currentStep = step;
            toolLog.push({ tool: b.name, input: JSON.stringify(b.input).slice(0, 200) });
            info(`[agent] tool_use: ${step}`);
          }
        }
      }
      if (msg.type === "result") {
        finalText = msg.subtype === "success" ? (msg.result || "") : friendlyResultError(msg.subtype);
        info(`[agent] result | subtype=${msg.subtype} | turns=${msg.num_turns ?? "?"}`);
        finish();
      }
    }
  } finally {
    clearTimeout(killer);
    progress.stop();
    finish(); // 兜底，防生成器泄漏
  }

  if (newSession) setSession(userId, newSession);
  if (cfg.memory.saveEveryExchange) saveExchange(userId, text, finalText, toolLog);
  return finalText;
}

function isResumeError(err) {
  const m = String(err?.message || "").toLowerCase();
  return (
    m.includes("no conversation found") ||
    m.includes("session") && (m.includes("not found") || m.includes("invalid"))
  );
}

function friendlyResultError(subtype) {
  switch (subtype) {
    case "error_max_turns":
      return "步骤太多，已自动停止。回复「继续」可接着做。";
    case "error_during_execution":
      return "执行过程中出错，任务已停止。可以换个说法再试。";
    default:
      return `任务未正常完成（${subtype}）。`;
  }
}

// ─── 进度跟踪 ────────────────────────────────────────────────

function describeToolUse(name, input = {}) {
  switch (name) {
    case "Bash": return `执行命令 ${String(input.command || "").slice(0, 60)}`;
    case "Read": return `读取 ${input.file_path || ""}`;
    case "Write": return `写入 ${input.file_path || ""}`;
    case "Edit": return `编辑 ${input.file_path || ""}`;
    case "Glob":
    case "Grep": return "搜索文件";
    case "WebFetch":
    case "WebSearch": return "联网查询";
    case "Task": return "执行子任务";
    case "TodoWrite": return "规划步骤";
    default: return name;
  }
}

function startProgress(userId, channel) {
  const { enabled, initialDelayMs, intervalMs } = getConfig().progress;
  if (!enabled) return { stop() {} };
  const startedAt = Date.now();
  let lastSent = 0;
  const timer = setInterval(async () => {
    const elapsed = Date.now() - startedAt;
    if (elapsed < initialDelayMs) return;                        // >30s 才首推
    if (lastSent && Date.now() - lastSent < intervalMs) return;  // ≤1 条/60s
    if (hasPendingApproval(userId)) return;                      // 审批消息已说明现状，别刷屏
    const step = running.get(userId)?.currentStep || "处理中";
    const ok = await channel.send(
      `⏳ 正在执行: ${step}（已运行 ${Math.round(elapsed / 1000)} 秒）`,
      { kind: "progress" }, // 无预算 → false → 下一轮再试
    );
    if (ok) lastSent = Date.now();
  }, 5000);
  return { stop: () => clearInterval(timer) };
}
