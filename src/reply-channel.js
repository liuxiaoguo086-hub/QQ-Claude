/**
 * 回复通道 — 每用户的 QQ 消息发送管理
 *
 * QQ 官方 Bot 限制：被动回复约 5 条/msg_id、约 5 分钟窗口；
 * 主动推送有平台配额，不可靠，只做降级兜底。
 * 策略：非最终答案的消息预留 1 个被动名额给最终答案；
 *       进度消息发不出去就丢弃（不占主动推送配额）。
 */
import { getConfig } from "./config.js";
import { info, warn } from "./logger.js";

// bot 实例由 bot.js 启动时注入（避免 ESM 循环依赖）
let _getBot = null;
export function setBotGetter(fn) {
  _getBot = fn;
}

const channels = new Map(); // userId -> ReplyChannel

export function getChannel(userId) {
  if (!channels.has(userId)) channels.set(userId, new ReplyChannel(userId));
  return channels.get(userId);
}

class ReplyChannel {
  constructor(userId) {
    this.userId = userId;
    this.event = null;   // 最新可回复事件（作为被动回复的 source）
    this.used = 0;       // 当前 msg_id 已用被动回复数
    this.eventAt = 0;    // event 到达时间
  }

  /** 每条新进消息调用：刷新被动回复窗口和预算 */
  updateEvent(event) {
    this.event = event;
    this.used = 0;
    this.eventAt = Date.now();
  }

  _passiveAvailable(reserveFinal) {
    const { budgetPerMsg, windowMs } = getConfig().reply;
    if (!this.event || Date.now() - this.eventAt > windowMs) return false;
    const limit = reserveFinal ? budgetPerMsg - 1 : budgetPerMsg;
    return this.used < limit;
  }

  /**
   * 发送一条消息
   * @param {string} text
   * @param {{kind?: "progress"|"approval"|"final"|"system"}} opts
   * @returns {Promise<boolean>} 是否送达
   */
  async send(text, { kind = "system" } = {}) {
    const bot = _getBot?.();
    if (!bot) {
      warn(`[reply] bot 未就绪，消息丢弃 (${kind})`);
      return false;
    }
    // 非最终答案要给 final 留 1 个被动名额
    const reserveFinal = kind !== "final";
    if (this._passiveAvailable(reserveFinal)) {
      try {
        await bot.sendPrivateMessage(this.userId, text, this.event); // 带 source = 被动回复
        this.used++;
        info(`[reply] 被动回复(${kind}) → ${this.userId} | 已用 ${this.used}`);
        return true;
      } catch (e) {
        warn(`[reply] 被动回复失败(${kind}): ${e.message}`);
      }
    }
    // 进度消息不降级：主动推送配额留给审批/最终答案
    if (kind === "progress") return false;
    try {
      await bot.sendPrivateMessage(this.userId, text); // 无 source = 主动推送
      info(`[reply] 主动推送(${kind}) → ${this.userId}`);
      return true;
    } catch (e) {
      warn(`[reply] 主动推送失败(${kind})，可能配额受限: ${e.message}`);
      return false;
    }
  }

  /**
   * 发送最终答案：分块（按行边界优先），限制条数，超出截断
   * @returns {Promise<boolean>} 是否至少送达一条
   */
  async sendFinal(text) {
    const { chunkSize, maxChunks } = getConfig().reply;
    const chunks = splitChunks(text || "（任务完成，无文本输出）", chunkSize);
    if (chunks.length > maxChunks) {
      chunks.length = maxChunks;
      chunks[maxChunks - 1] += "\n…（内容过长已截断，可让我分段输出）";
    }
    let delivered = false;
    for (const c of chunks) {
      delivered = (await this.send(c, { kind: "final" })) || delivered;
    }
    return delivered;
  }
}

/** 按行边界优先切分文本，单行超长时硬切 */
function splitChunks(text, size) {
  const chunks = [];
  let current = "";
  for (const line of String(text).split("\n")) {
    // 单行就超长：硬切
    if (line.length > size) {
      if (current) { chunks.push(current); current = ""; }
      for (let i = 0; i < line.length; i += size) {
        chunks.push(line.slice(i, i + size));
      }
      continue;
    }
    if (current.length + line.length + 1 > size) {
      chunks.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current) chunks.push(current);
  return chunks.length ? chunks : [""];
}
