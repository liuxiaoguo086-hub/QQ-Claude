/**
 * QQ Bot 客户端 — 对接 QQ 官方机器人平台 WebSocket
 * 纯 WebSocket 直连，无额外进程依赖
 *
 * 消息路由：白名单 → 刷新回复窗口 → 审批回复 → 命令 → 任务互斥 → 新任务
 */
import { Bot, ReceiverMode } from "qq-official-bot";
import { getConfig } from "./config.js";
import { runTask, handleCommand, isTaskRunning, getRunningInfo } from "./agent.js";
import { tryResolveApproval } from "./approval.js";
import { getChannel, setBotGetter } from "./reply-channel.js";
import { info, warn, error } from "./logger.js";

let bot = null;
let lastMessageTime = 0;               // 最后一次收到用户消息的时间
let lastReplyTime = 0;                 // 最后一次回复用户的时间
let heartbeatTimer = null;
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;  // 5 分钟

/**
 * 启动 QQ Bot，连接官方 WebSocket
 */
export async function createQQClient() {
  const config = getConfig();

  info(`创建 QQ Bot | appid=${config.qq.appId} | sandbox=${config.qq.sandbox}`);

  if (!config.security.allowedUsers?.length) {
    warn("⚠️  security.allowedUsers 为空 —— 任何 QQ 用户都可远程操控本机！");
    warn("⚠️  请在 data/config.json 填入自己的 openid（见日志中的 from=...）");
  }

  bot = new Bot({
    appid: config.qq.appId,
    secret: config.qq.appSecret,
    sandbox: config.qq.sandbox !== false,
    removeAt: true,
    logLevel: "info",
    maxRetry: 10,
    intents: ["GROUP_AND_C2C_EVENT"],
    mode: ReceiverMode.WEBSOCKET,
  });

  // 注入 bot 实例给回复通道（避免循环依赖）
  setBotGetter(() => bot);

  // 白名单检查（openid 是字母数字字符串，必须字符串比较）
  function isAllowedUser(userId) {
    const allowed = config.security.allowedUsers;
    if (!allowed || allowed.length === 0) return true;
    return allowed.map(String).includes(String(userId));
  }

  // 私聊消息
  bot.on("message.private", async (event) => {
    lastMessageTime = Date.now();
    const userId = String(event.user_openid || event.author?.user_openid || "");
    const messageText = (event.content || "").trim();

    info(`[msg] 私聊 | from=${userId} | text=${messageText.slice(0, 80)}`);

    if (!messageText) return;

    if (!isAllowedUser(userId)) {
      warn(`[msg] 非白名单用户 ${userId}，忽略`);
      return;
    }

    const channel = getChannel(userId);
    channel.updateEvent(event); // 刷新被动回复窗口/预算

    try {
      // 1. 审批回复（挂起审批时消费所有文本）
      if (tryResolveApproval(userId, messageText, channel)) return;

      // 2. 命令
      const cmdResult = handleCommand(messageText, userId);
      if (cmdResult) {
        await channel.send(cmdResult, { kind: "final" });
        lastReplyTime = Date.now();
        return;
      }

      // 3. 任务互斥：不排队（排队任务的回复窗口必然过期）
      if (isTaskRunning(userId)) {
        const run = getRunningInfo(userId);
        await channel.send(
          `上一个任务还在运行（${run.currentStep}，已 ${Math.round((Date.now() - run.startedAt) / 1000)} 秒）。` +
            "等完成后再发，或发 /status 查看。",
          { kind: "system" },
        );
        return;
      }

      // 4. 新任务
      const reply = await runTask(userId, messageText, channel);
      const delivered = await channel.sendFinal(reply);
      lastReplyTime = Date.now();
      info(`[reply] 最终答案${delivered ? "已送达" : "发送失败"} → ${userId}`);
    } catch (err) {
      error(`[msg] 处理失败: ${err.stack || err.message}`);
      await channel.send("抱歉，处理消息时出错了。", { kind: "final" }).catch(() => {});
    }
  });

  // 群聊 @消息（记录，暂不处理）
  bot.on("message.group", async (event) => {
    lastMessageTime = Date.now();
    const groupId = String(event.group_openid || "");
    const memberId = String(event.author?.member_openid || "");
    const text = event.content || "";

    info(`[msg] 群聊 | group=${groupId} | from=${memberId} | text=${text.slice(0, 80)}`);
  });

  // 心跳检测：仅当"有未回复的消息且超过 10min"才重连（防僵死/卡任务）
  // lastReplyTime >= lastMessageTime → 已回复，说明连接正常，跳过
  // lastMessageTime > lastReplyTime → 有未回复消息，若超过 10min → 重连
  async function heartbeatCheck() {
    if (lastReplyTime >= lastMessageTime) return;  // 全部已回复，闲置中
    const since = Date.now() - lastMessageTime;
    if (since > HEARTBEAT_INTERVAL_MS) {
      const mins = Math.round(since / 60000);
      warn(`💓 消息发出 ${mins}min 无回复，重连…`);
      try {
        bot.stop?.();
        await new Promise(r => setTimeout(r, 2000));
        await bot.start();
        lastMessageTime = 0;
        lastReplyTime = 0;
        info("💓 已重连");
      } catch (e) {
        error(`💓 重连失败: ${e.message}`);
      }
    }
  }
  heartbeatTimer = setInterval(heartbeatCheck, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.(); // 不阻止进程退出

  // 启动连接
  await bot.start();
  info("✅ QQ Bot WebSocket 已连接");

  return bot;
}

export function getQQClient() {
  return bot;
}

export async function logout() {
  if (bot) {
    bot.stop?.();
    info("QQ Bot 已停止");
  }
}
