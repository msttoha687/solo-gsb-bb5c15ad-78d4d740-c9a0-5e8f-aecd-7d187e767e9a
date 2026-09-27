#!/usr/bin/env node
'use strict';

// 容器健康检查探针（无第三方依赖，仅使用 Node 内置模块）。
//
// 背景：原先 Compose 使用 `wget http://localhost:3000/api/stories`。在部分
// 环境中 localhost 会优先解析到 IPv6（::1），而 Node 服务监听的是
// 0.0.0.0:3000（仅 IPv4），导致服务其实正常、wget 却连接失败，容器被
// 误判为 unhealthy。此探针固定使用 127.0.0.1，规避主机名解析差异。
//
// 判定规则：
//   仅当在超时内收到 2xx 响应、且响应体可解析为 JSON 数组时退出 0；
//   连接失败 / 超时 / 非 2xx / 响应体不是合法 JSON 或不是数组 -> 退出 1。

const http = require('http');

const HOST = '127.0.0.1';
const PORT = parseInt(process.env.PORT || '3000', 10);
const PATH = '/api/stories';
// 探针自身的超时应小于 Compose healthcheck 的 timeout（5s），预留收尾余量
const TIMEOUT_MS = parseInt(process.env.HEALTHCHECK_TIMEOUT_MS || '4000', 10);

if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65535) {
  console.error(`[healthcheck] 无效端口: ${process.env.PORT}`);
  process.exit(1);
}

let settled = false;
let timer;

const finish = (ok, message) => {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  if (req) req.destroy();
  if (!ok) console.error(`[healthcheck] ${message}`);
  process.exit(ok ? 0 : 1);
};

const req = http.request(
  {
    host: HOST,
    port: PORT,
    path: PATH,
    method: 'GET',
    // 连接建立阶段的超时（服务无响应 / 连接被挂起）
    timeout: TIMEOUT_MS,
    headers: { Accept: 'application/json' },
  },
  (res) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => {
      const status = res.statusCode || 0;
      if (status < 200 || status >= 300) {
        finish(false, `非 2xx 响应: HTTP ${status}`);
        return;
      }
      const body = Buffer.concat(chunks).toString('utf8');
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch (err) {
        finish(false, `响应不是合法 JSON: ${err.message}`);
        return;
      }
      if (!Array.isArray(parsed)) {
        finish(false, '响应可解析为 JSON，但不是数组');
        return;
      }
      finish(true);
    });
    res.on('error', (err) => finish(false, `读取响应失败: ${err.message}`));
  }
);

// 整体兜底超时（连接 + 读取全过程）
timer = setTimeout(() => finish(false, `请求超时（${TIMEOUT_MS}ms）`), TIMEOUT_MS);

req.on('timeout', () => finish(false, `连接 / 响应超时（${TIMEOUT_MS}ms）`));
req.on('error', (err) => finish(false, `请求失败: ${err.message}`));

req.end();
