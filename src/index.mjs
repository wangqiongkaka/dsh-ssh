import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { SshManager } from './manager.mjs';
import { SshBridge, aiMethods } from './bridge.mjs';
import { quote, requireText } from './ssh.mjs';
import { readJson, requireSameOrigin } from './wire.mjs';

export const name = 'dsh-ssh';
export const inject = ['connection', 'sessions', 'subprocess'];

export async function apply(ctx) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ssh-'));
  const manager = new SshManager({ root, subprocess: ctx.subprocess });
  const bridge = new SshBridge(manager);
  ctx.effect(() => async () => {
    try { await manager.close(); } finally { await bridge.close(); await rm(root, { recursive: true, force: true }); }
  });
  await bridge.start();
  ctx.on('session/disposed', session => manager.revoke(session.id));
  const methods = { ...aiMethods, authorize: 'authorize', revoke: 'revoke',
    'terminal.open': 'openTerminal', 'terminal.read': 'terminalRead', 'terminal.write': 'terminalWrite',
    'terminal.resize': 'terminalResize', 'terminal.close': 'terminalClose',
    instructions: async sessionId => {
      const file = await manager.credential(sessionId, bridge.endpoint);
      const command = `${quote(process.execPath)} ${quote(fileURLToPath(new URL('./ssh-cli.mjs', import.meta.url)))} ${quote(file)}`;
      const state = manager.state(sessionId);
      return { text: `当前会话已获准通过 SSH 操作 ${state.connection.host}（${state.connection.user || 'SSH 配置中的用户'}）。权限与远端账号相同，可执行任意远程 Shell 命令。此授权仅用于当前会话和当前机器，禁止读取、打印或复制会话凭据文件。\n原生 DSH 优先使用 ssh_exec / ssh_read / ssh_stop / ssh_status 工具。Codex / Claude Code 使用以下本机命令：\n${command} exec '{"command":"pwd","waitMs":1000}'\n命令未结束时返回 running:true 和 id；用 ${command} read '{"id":"返回的命令 ID","offset":0}' 读取，之后沿用返回的 offset；停止用 stop '{"id":"命令 ID"}'。cwd 参数表示远端工作目录。每次 exec 是独立 Shell，跨命令请传 cwd 或写成同一条命令。\n遇到 outcomeUnknown:true、断线或超时，不得宣称成功或自动重试写操作。授权撤销或宿主重启后必须由用户重新授权。` };
    },
  };
  for (const [action, method] of Object.entries(methods)) {
    ctx.connection.fetch.register({ path: `/api/dsh-ssh/${action}`, methods: ['POST'], requestBody: 'streaming',
      fetch: async request => {
        try {
          requireSameOrigin(request);
          const { sessionId, ...input } = await readJson(request);
          requireText(sessionId, '会话 ID', 256);
          if (!ctx.sessions.get(sessionId)) throw new Error('会话未加载，请先打开该会话');
          const value = await (typeof method === 'function' ? method(sessionId) : manager[method](sessionId, input));
          return Response.json({ ok: true, value }, { headers: { 'Cache-Control': 'no-store' } });
        } catch (error) { return Response.json({ ok: false, error: error.message }, { status: 400, headers: { 'Cache-Control': 'no-store' } }); }
      },
    });
  }
  ctx.inject(['tools'], scope => {
    for (const [action, parameters, description] of [
      ['status', {}, '查询当前会话的 SSH 授权与连接状态。尚未授权时请用户在 SSH 侧边栏连接；不得自行建立连接。'],
      ['exec', { command: { type: 'string', required: true }, cwd: { type: 'string' }, waitMs: { type: 'integer' } }, '在当前会话已授权的远端机器执行任意 Shell 命令，权限与远端账号一致。cwd 是远端目录，每次执行为独立 Shell。waitMs 为 0–10000，默认 1000。返回 running:true 时用 ssh_read 继续读取。outcomeUnknown:true 时结果无法确认，不得自动重试写操作。'],
      ['read', { id: { type: 'string', required: true }, offset: { type: 'integer' } }, '读取当前会话远程命令输出，首次 offset=0，之后使用返回的 offset。truncated 表示早期输出已超出缓存。'],
      ['stop', { id: { type: 'string', required: true } }, '停止当前会话启动的 SSH 命令进程。远端主动脱离连接的进程可能继续运行，需要另行核实。'],
    ]) scope.tools.register(defineTool({ name: `ssh_${action}`, description, parameters, timeoutMs: 15000,
      output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
      execute: async (args, execution) => {
        if (!execution.agent) throw new Error('SSH 操作需要当前会话');
        execution.signal.throwIfAborted();
        return JSON.stringify(await manager[aiMethods[action]](execution.agent.id, args));
      },
    }));
  });
}
