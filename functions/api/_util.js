// Cloudflare Pages Functions 共享工具。
export const REPO = "gaaiyun/TradingWorkbench";
export const RAW_BASE = `https://raw.githubusercontent.com/${REPO}/main/public`;

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

export function gate(env, code) {
  // 写操作 / 烧配额的接口统一用访问码门禁
  return Boolean(env.ACCESS_CODE) && code === env.ACCESS_CODE;
}

export function ghHeaders(env) {
  const h = {
    accept: "application/vnd.github+json",
    "user-agent": "tradingagents-board",
  };
  if (env.GITHUB_DISPATCH_TOKEN) h.authorization = `Bearer ${env.GITHUB_DISPATCH_TOKEN}`;
  return h;
}

export class RequestBodyTooLargeError extends Error {
  constructor(maxBytes) {
    super(`request body exceeds ${maxBytes} bytes`);
    this.name = "RequestBodyTooLargeError";
    this.maxBytes = maxBytes;
  }
}

export async function readJsonBody(request, { maxBytes = 16 * 1024 } = {}) {
  const advertised = Number(request.headers.get("content-length"));
  if (Number.isFinite(advertised) && advertised > maxBytes) {
    throw new RequestBodyTooLargeError(maxBytes);
  }

  try {
    if (!request.body) return null;
    const reader = request.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("request body too large");
        throw new RequestBodyTooLargeError(maxBytes);
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) throw error;
    return null;
  }
}

// 代理 GitHub raw 上随 commit 更新的数据文件（比静态部署快照新鲜）。
export async function proxyRaw(path, { cacheSeconds = 60 } = {}) {
  const upstream = `${RAW_BASE}/${path}`;
  const resp = await fetch(upstream, { cf: { cacheTtl: cacheSeconds, cacheEverything: true } });
  if (!resp.ok) {
    return json({ error: `upstream ${resp.status}` }, resp.status === 404 ? 404 : 502);
  }
  const body = await resp.text();
  const type = path.endsWith(".json")
    ? "application/json; charset=utf-8"
    : "text/plain; charset=utf-8";
  return new Response(body, {
    status: 200,
    headers: { "content-type": type, "cache-control": `public, max-age=${cacheSeconds}` },
  });
}
