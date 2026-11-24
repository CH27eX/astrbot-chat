/**
 * 发消息的延时打点（只记数字，不挂定时器、不发请求）。
 *
 * 为什么单独一个模块：P1-3 之前只能拿「客户端首字」和「服务端首字」两个数相减，
 * 中间「请求往返 + 首包到达 + 渲染」混在一起。这里把一段发送拆成三个时间点：
 *   sendAt       点发送（发出请求之前）
 *   firstChunkAt 收到第一个非空文本增量（网络 + BFF + AstrBot 首包）
 *   firstPaintAt 这一帧真的画到屏幕上（双 rAF：第一次 rAF 在提交后、第二次在下一帧，约等于「已上屏」）
 * 另外把服务端自己报的 time_to_first_token 也记下来，方便三方对照。
 *
 * 读法：CDP 里 `JSON.stringify(window.__astrbotPerf)`；每次发送会重置。
 */
export interface SendTiming {
  sendAt: number;
  firstChunkAt: number | null;
  firstPaintAt: number | null;
  serverTtftMs: number | null;
}

const w = window as unknown as { __astrbotPerf: SendTiming | null };
w.__astrbotPerf = null;

export function beginSend() {
  const timing: SendTiming = {
    sendAt: performance.now(),
    firstChunkAt: null,
    firstPaintAt: null,
    serverTtftMs: null,
  };
  w.__astrbotPerf = timing;
}

export function markChunk() {
  const timing = w.__astrbotPerf;
  if (!timing || timing.firstChunkAt !== null) return;
  timing.firstChunkAt = performance.now();
}

export function markFirstPaint() {
  const timing = w.__astrbotPerf;
  if (!timing || timing.firstPaintAt !== null) return;
  timing.firstPaintAt = performance.now();
}

export function markServerTtft(ms: number) {
  const timing = w.__astrbotPerf;
  if (!timing || timing.serverTtftMs !== null || !ms) return;
  timing.serverTtftMs = ms;
}
