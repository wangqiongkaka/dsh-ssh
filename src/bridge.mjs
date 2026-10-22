import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { readJson } from './wire.mjs';

export const aiMethods = { status: 'state', exec: 'execute', read: 'read', stop: 'stop' };

export class SshBridge {
  constructor(manager) { this.manager = manager; this.pending = new Set(); }
  async start() {
    this.server = createServer((request, response) => {
      const work = this.handle(request, response);
      this.pending.add(work);
      void work.finally(() => this.pending.delete(work));
    });
    this.server.requestTimeout = 15000;
    this.server.headersTimeout = 10000;
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', resolve); });
    this.endpoint = `http://127.0.0.1:${this.server.address().port}`;
    return this.endpoint;
  }
  async handle(request, response) {
    response.setHeader('Content-Type', 'application/json');
    try {
      const token = request.headers.authorization?.replace(/^Bearer /, '');
      const sessionId = this.manager.sessionForToken(token);
      if (!sessionId || request.headers.origin || request.headers['sec-fetch-site'] || !/^127\.0\.0\.1:\d+$/.test(request.headers.host ?? '')) {
        response.writeHead(403).end(JSON.stringify({ error: '会话凭据无效或授权已撤销' })); return;
      }
      const action = request.url?.slice(1);
      if (request.method !== 'POST' || !Object.hasOwn(aiMethods, action)) {
        response.writeHead(404).end(JSON.stringify({ error: '不支持的操作' })); return;
      }
      const body = new Request(this.endpoint, { method: 'POST', body: Readable.toWeb(request), duplex: 'half' });
      const input = await readJson(body);
      if (Object.hasOwn(input, 'sessionId') || Object.hasOwn(input, 'connection')) throw new Error('AI 不能选择会话或修改连接');
      const result = await this.manager[aiMethods[action]](sessionId, input);
      response.end(JSON.stringify(result));
    } catch (error) { response.writeHead(400).end(JSON.stringify({ error: error.message })); }
  }
  async close() {
    if (this.server) await new Promise((resolve, reject) => {
      this.server.close(error => error ? reject(error) : resolve()); this.server.closeAllConnections();
    });
    await Promise.allSettled(this.pending);
  }
}
