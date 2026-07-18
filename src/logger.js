/**
 * 日志模块 — 同时输出到终端和日志文件
 * 用于后台运行时保留完整日志
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.resolve(__dirname, "..", "logs");

// 确保日志目录存在
fs.mkdirSync(LOG_DIR, { recursive: true });

function pad(n) {
  return String(n).padStart(2, "0");
}

function localStamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const DATE = localStamp().replace(/[ :]/g, "-");
const LOG_FILE = path.join(LOG_DIR, `bridge-${DATE}.log`);

let _daemonMode = false;
let _stream = null;

function getStream() {
  if (!_stream) {
    _stream = fs.createWriteStream(LOG_FILE, { flags: "a" });
  }
  return _stream;
}

function timestamp() {
  // 本地时间（此前用 toISOString 是 UTC，比北京时间慢 8 小时）
  return localStamp();
}

/**
 * 设置是否后台模式
 * 后台模式下 info/debug 不输出到终端，只写日志文件
 */
export function setDaemonMode(on) {
  _daemonMode = on;
}

export function isDaemonMode() {
  return _daemonMode;
}

export function getLogFile() {
  return LOG_FILE;
}

export function info(...args) {
  const line = `[${timestamp()}] INFO  ${args.join(" ")}`;
  getStream().write(line + "\n");
  if (!_daemonMode) console.log(line);
}

export function warn(...args) {
  const line = `[${timestamp()}] WARN  ${args.join(" ")}`;
  getStream().write(line + "\n");
  if (!_daemonMode) console.warn(line);
}

export function error(...args) {
  const line = `[${timestamp()}] ERROR ${args.join(" ")}`;
  // 同步写确保 exit 前落盘（createWriteStream 异步写可能在 process.exit 时丢失）
  try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch (_) {}
  console.error(line);
}

export function raw(msg) {
  // 不带时间戳的原始输出，仅终端
  if (!_daemonMode) console.log(msg);
}
