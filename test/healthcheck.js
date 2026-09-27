#!/usr/bin/env node
'use strict';

// 健康检查探针回归测试（node test/healthcheck.js，仅使用 Node 内置模块）。
// 覆盖：
//   1) 正常：2xx + JSON 数组            -> 退出 0
//   2) 201 也是 2xx                     -> 退出 0
//   3) 连接失败（端口无监听）            -> 退出非 0
//   4) 连接被立即重置                    -> 退出非 0
//   5) 请求超时（服务挂起不响应）        -> 退出非 0，且在探针超时内失败
//   6) 非 2xx（500 / 404 / 503）        -> 退出非 0
//   7) 畸形响应（非法 JSON / JSON 对象 / JSON 标量 / 空响应）-> 退出非 0
// 同时验证探针固定经 127.0.0.1 访问 /api/stories。

const assert = require('assert');
const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const path = require('path');

const PROBE = path.join(__dirname, '..', 'scripts', 'healthcheck.js');

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; console.log(`  ✓ ${name}`); };

// 启动一个 HTTP 服务，handler 决定响应内容；返回 { server, port }
const startServer = (handler) => new Promise((resolve) => {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
});

const closeServer = (server) => new Promise((resolve) => {
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  server.close(() => resolve());
});

// 运行探针；env 覆盖环境变量，返回 { code, stdout, stderr, durationMs }
const runProbe = (envOverrides) => new Promise((resolve) => {
  const started = Date.now();
  const child = spawn(process.execPath, [PROBE], {
    env: { ...process.env, ...envOverrides },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('close', (code, signal) => {
    resolve({ code, signal, stdout, stderr, durationMs: Date.now() - started });
  });
});

const failed = (r) => r.code !== 0; // null（被信号杀死）或非 0 均视为失败

(async () => {
  console.log('探针正常分支：');

  // ---------- 1) 2xx + JSON 数组：退出 0；且固定走 127.0.0.1 与 /api/stories ----------
  {
    let seen = null;
    const { server, port } = await startServer((req, res) => {
      // 响应结束后 socket 可能被销毁，需在请求到达时立即快照
      seen = {
        url: req.url,
        method: req.method,
        localAddress: req.socket.localAddress,
        remoteAddress: req.socket.remoteAddress,
      };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify([{ id: 's1' }, { id: 's2' }]));
    });
    try {
      const r = await runProbe({ PORT: String(port) });
      assert.strictEqual(r.code, 0, `期望退出 0，实际 ${r.code}，stderr: ${r.stderr}`);
      ok('正常 200 + JSON 数组退出 0', r.code === 0);
      ok('探针请求路径为 /api/stories', seen && seen.url === '/api/stories');
      ok('探针固定经 127.0.0.1 访问（而非 localhost）',
        seen && seen.localAddress === '127.0.0.1' && seen.remoteAddress === '127.0.0.1');
      ok('探针使用 GET 方法', seen && seen.method === 'GET');
    } finally {
      await closeServer(server);
    }
  }

  // ---------- 2) 201 同样属于 2xx ----------
  {
    const { server, port } = await startServer((req, res) => {
      res.statusCode = 201;
      res.end('[]');
    });
    try {
      const r = await runProbe({ PORT: String(port) });
      ok('201 + JSON 数组同样退出 0', r.code === 0);
    } finally {
      await closeServer(server);
    }
  }

  // 空数组也是合法 JSON 数组
  {
    const { server, port } = await startServer((req, res) => res.end('[]'));
    try {
      const r = await runProbe({ PORT: String(port) });
      ok('空 JSON 数组退出 0', r.code === 0);
    } finally {
      await closeServer(server);
    }
  }

  console.log('探针失败分支：');

  // ---------- 3) 连接失败（无监听端口）----------
  await new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', async () => {
      const port = srv.address().port;
      await new Promise((r) => srv.close(r)); // 释放端口，保证无监听
      const r = await runProbe({ PORT: String(port), HEALTHCHECK_TIMEOUT_MS: '2000' });
      ok('连接被拒绝时退出非 0', failed(r));
      resolve();
    });
  });

  // ---------- 4) 连接建立后被立即重置 ----------
  await new Promise((resolve) => {
    const server = net.createServer((socket) => socket.destroy());
    server.listen(0, '127.0.0.1', async () => {
      const port = server.address().port;
      try {
        const r = await runProbe({ PORT: String(port), HEALTHCHECK_TIMEOUT_MS: '2000' });
        ok('连接被重置时退出非 0', failed(r));
      } finally {
        await new Promise((r) => server.close(r));
      }
      resolve();
    });
  });

  // ---------- 5) 超时：服务接受连接但永不响应 ----------
  {
    const { server, port } = await startServer((req, res) => {
      // 故意挂起，不响应也不结束
      req.socket.on('close', () => {});
      if (typeof req.socket.ref === 'function') req.socket.ref();
    });
    try {
      const r = await runProbe({ PORT: String(port), HEALTHCHECK_TIMEOUT_MS: '500' });
      ok('服务挂起超时时退出非 0', failed(r));
      ok('在探针超时（500ms）附近快速失败，未挂死', r.durationMs < 2000);
    } finally {
      await closeServer(server);
    }
  }

  // ---------- 6) 非 2xx ----------
  for (const status of [500, 404, 503]) {
    const { server, port } = await startServer((req, res) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'boom' }));
    });
    try {
      const r = await runProbe({ PORT: String(port) });
      ok(`HTTP ${status} 退出非 0`, failed(r));
    } finally {
      await closeServer(server);
    }
  }

  // ---------- 7) 畸形 / 类型不符的响应体 ----------
  const badBodies = [
    ['非法 JSON', 'this is not json'],
    ['JSON 对象而非数组', JSON.stringify({ stories: [] })],
    ['JSON 标量而非数组', '42'],
    ['JSON 字符串而非数组', '"hello"'],
    ['空响应体', ''],
    ['残缺 JSON', '[{"id": "s1"'],
  ];
  for (const [label, body] of badBodies) {
    const { server, port } = await startServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(body);
    });
    try {
      const r = await runProbe({ PORT: String(port) });
      ok(`${label} 退出非 0`, failed(r));
    } finally {
      await closeServer(server);
    }
  }

  console.log(`\n全部 ${passed} 项断言通过 ✔`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
