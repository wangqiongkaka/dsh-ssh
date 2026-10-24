export async function readJson(request, limit = 128 * 1024) {
  if (!request.body) throw new Error('缺少请求正文');
  const chunks = []; let size = 0;
  for await (const chunk of request.body) {
    size += chunk.length;
    if (size > limit) throw new Error('请求正文过大');
    chunks.push(Buffer.from(chunk));
  }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('请求必须是 JSON 对象');
  return input;
}

export function requireSameOrigin(request) {
  if (request.headers.get('sec-fetch-site') === 'cross-site') throw new Error('拒绝跨站请求');
  const origin = request.headers.get('origin');
  if (origin) {
    const source = new URL(origin), host = request.headers.get('host');
    // 宿主已校验 Host；HTTP 桥接后的 request.url 使用内部占位地址。
    if (!['http:', 'https:'].includes(source.protocol) || source.origin !== origin
      || (host ? source.host !== host : origin !== new URL(request.url).origin)) throw new Error('拒绝跨站请求');
  }
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new Error('请求必须使用 application/json');
}
