/**
 * Minimal HTTP server for Chat SDK adapter webhooks.
 *
 * Starts lazily on first adapter registration. Routes requests by path:
 *   /webhook/{adapterName} → chat.webhooks[adapterName](request)
 *   /webhook/{path}        → raw handler from registerWebhookHandler(path, ...)
 *
 * Multiple Chat instances can register adapters — each adapter name maps
 * to its owning Chat instance. Raw routes let modules receive non-Chat-SDK
 * webhooks (GitHub, payment providers, health checks) on the same server
 * without editing this file or opening a second port.
 */
import http from 'http';

import type { Chat } from 'chat';

import { log } from './log.js';

const DEFAULT_PORT = 3000;

/**
 * DoS guards for the internet-facing webhook port. All tunable by env so the
 * code default never needs editing per-deploy; values are read when the server
 * starts (see ensureServer). Set a limit to 0 to disable it.
 */
const DEFAULT_MAX_BODY_BYTES = 1_048_576; // 1 MiB — reject larger uploads (OOM guard)
// Off by default: webhooks from Slack/Discord/Telegram/etc. all arrive from the
// platform's shared IPs, so a per-source-IP limit can't tell a flood from normal
// traffic and would drop legitimate events under load. Real rate limiting belongs
// at a reverse proxy. Opt in with WEBHOOK_RATE_LIMIT>0 only behind a per-client
// proxy. The body cap + request timeout below are the always-on, false-positive-
// free DoS guards.
const DEFAULT_RATE_LIMIT = 0; // requests per window, per source IP (0 = off)
const DEFAULT_RATE_WINDOW_MS = 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000; // slowloris guard (0 = off)

interface WebhookEntry {
  chat: Chat;
  adapterName: string;
}

/** Node-style handler for raw (non-Chat-SDK) webhook routes. */
export type RawWebhookHandler = (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>;

const routes = new Map<string, WebhookEntry>();
const rawRoutes = new Map<string, RawWebhookHandler>();
let server: http.Server | null = null;

/** Raised when a request body exceeds the configured limit. */
class PayloadTooLargeError extends Error {
  constructor() {
    super('payload too large');
    this.name = 'PayloadTooLargeError';
  }
}

/**
 * In-process fixed-window rate limiter keyed by source IP. Caps brute-force /
 * flooding on the public webhook port without pulling in a new dependency.
 * Note: it sees the socket peer address — behind a reverse proxy that is the
 * proxy IP, so keep real per-client limiting in the proxy too. We deliberately
 * do NOT trust X-Forwarded-For (spoofable by anyone hitting the port directly).
 */
interface RateState {
  count: number;
  windowStart: number;
}
const rateBuckets = new Map<string, RateState>();

function rateLimitOk(ip: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  // Opportunistic sweep so a flood of distinct IPs can't grow the map forever.
  if (rateBuckets.size > 10_000) {
    for (const [key, st] of rateBuckets) {
      if (now - st.windowStart >= windowMs) rateBuckets.delete(key);
    }
  }
  const st = rateBuckets.get(ip);
  if (!st || now - st.windowStart >= windowMs) {
    rateBuckets.set(ip, { count: 1, windowStart: now });
    return true;
  }
  st.count += 1;
  return st.count <= limit;
}

/** Plain-text response with nosniff — used for every reply this file writes. */
function sendPlain(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/plain',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

/** Convert Node.js IncomingMessage to a Web API Request. */
async function toWebRequest(req: http.IncomingMessage, maxBytes: number): Promise<Request> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    // Defense for chunked bodies with no/forged Content-Length: stop reading
    // and reject rather than buffer an unbounded payload into memory.
    if (maxBytes > 0 && total > maxBytes) {
      req.destroy();
      throw new PayloadTooLargeError();
    }
    chunks.push(buf);
  }
  const body = Buffer.concat(chunks);

  const host = req.headers.host || 'localhost';
  const url = `http://${host}${req.url}`;

  const headers: Record<string, string> = {};
  for (const [key, val] of Object.entries(req.headers)) {
    if (typeof val === 'string') headers[key] = val;
    else if (Array.isArray(val)) headers[key] = val.join(', ');
  }

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(url, {
    method: req.method || 'GET',
    headers,
    body: hasBody ? body : undefined,
  });
}

/** Write a Web API Response back to a Node.js ServerResponse. */
async function fromWebResponse(webRes: Response, nodeRes: http.ServerResponse): Promise<void> {
  const headers = Object.fromEntries(webRes.headers.entries());
  // Defense-in-depth against MIME sniffing; don't clobber an explicit value.
  if (!('x-content-type-options' in headers)) headers['x-content-type-options'] = 'nosniff';
  nodeRes.writeHead(webRes.status, headers);
  if (webRes.body) {
    const reader = webRes.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        nodeRes.write(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  nodeRes.end();
}

/**
 * Register a webhook adapter on the shared server.
 * Starts the server lazily on first call.
 *
 * `routingPath` is the URL segment (`/webhook/<routingPath>`); `adapterName`
 * stays the handler key into `chat.webhooks`. The split lets N instances of
 * one platform (each with its own Chat + signing secret) listen on distinct
 * URLs while dispatching to the same SDK adapter name. Defaulting
 * routingPath to adapterName keeps the historical single-instance route
 * byte-identical. Signature adopted verbatim from PR #2617 (@davekim917's
 * #1804 prototype) so the two changes converge textually.
 */
export function registerWebhookAdapter(chat: Chat, adapterName: string, routingPath: string = adapterName): void {
  routes.set(routingPath, { chat, adapterName });
  ensureServer();
  log.info('Webhook adapter registered', { adapter: adapterName, path: `/webhook/${routingPath}` });
}

/**
 * Register a raw Node-style handler at /webhook/{path} on the shared server.
 *
 * For webhooks that don't flow through a Chat SDK adapter (GitHub, payment
 * providers, health checks): modules register their endpoint here instead of
 * editing this file or standing up a second HTTP server on another port.
 * The handler owns the request/response directly.
 *
 * Starts the server lazily on first call.
 */
export function registerWebhookHandler(path: string, handler: RawWebhookHandler): void {
  rawRoutes.set(path, handler);
  ensureServer();
  log.info('Webhook handler registered', { path: `/webhook/${path}` });
}

function ensureServer(): void {
  if (server) return;

  const port = parseInt(process.env.WEBHOOK_PORT || String(DEFAULT_PORT), 10);
  const maxBodyBytes = parseInt(process.env.WEBHOOK_MAX_BODY_BYTES || String(DEFAULT_MAX_BODY_BYTES), 10);
  const rateLimit = parseInt(process.env.WEBHOOK_RATE_LIMIT || String(DEFAULT_RATE_LIMIT), 10);
  const rateWindowMs = parseInt(process.env.WEBHOOK_RATE_WINDOW_MS || String(DEFAULT_RATE_WINDOW_MS), 10);
  const requestTimeoutMs = parseInt(process.env.WEBHOOK_REQUEST_TIMEOUT_MS || String(DEFAULT_REQUEST_TIMEOUT_MS), 10);

  server = http.createServer(async (req, res) => {
    const url = req.url || '/';

    // Flood/brute-force guard: rate-limit by source IP before doing any work.
    if (rateLimit > 0) {
      const ip = req.socket.remoteAddress || 'unknown';
      if (!rateLimitOk(ip, rateLimit, rateWindowMs)) {
        sendPlain(res, 429, 'Too Many Requests');
        return;
      }
    }

    // OOM guard: reject oversized bodies up front when the length is declared.
    const declaredLen = Number(req.headers['content-length']);
    if (maxBodyBytes > 0 && Number.isFinite(declaredLen) && declaredLen > maxBodyBytes) {
      sendPlain(res, 413, 'Payload Too Large');
      return;
    }

    // Route: /webhook/{adapterName}
    const match = url.match(/^\/webhook\/([^/?]+)/);
    if (!match) {
      sendPlain(res, 404, 'Not found');
      return;
    }

    const adapterName = match[1];

    try {
      // Raw routes take priority — the handler writes the response itself.
      const rawHandler = rawRoutes.get(adapterName);
      if (rawHandler) {
        await rawHandler(req, res);
        return;
      }

      const entry = routes.get(adapterName);
      if (!entry) {
        // Generic 404 — don't echo the adapter name (avoids endpoint enumeration).
        sendPlain(res, 404, 'Not found');
        return;
      }

      const webReq = await toWebRequest(req, maxBodyBytes);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const webhooks = entry.chat.webhooks as Record<string, (r: Request, opts?: any) => Promise<Response>>;
      const handler = webhooks[entry.adapterName];
      const webRes = await handler(webReq, {
        waitUntil: (p: Promise<unknown>) => {
          p.catch(() => {});
        },
      });
      await fromWebResponse(webRes, res);
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        if (!res.headersSent) sendPlain(res, 413, 'Payload Too Large');
        return;
      }
      log.error('Webhook handler error', { adapter: adapterName, url: req.url, err });
      if (!res.headersSent) sendPlain(res, 500, 'Internal Server Error');
    }
  });

  // Slowloris guard: cap how long a single request may take end-to-end.
  if (requestTimeoutMs > 0) server.requestTimeout = requestTimeoutMs;

  server.listen(port, '0.0.0.0', () => {
    log.info('Webhook server started', { port, adapters: [...routes.keys()] });
  });
}

/** Shut down the webhook server. */
export async function stopWebhookServer(): Promise<void> {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    routes.clear();
    rawRoutes.clear();
    rateBuckets.clear();
    log.info('Webhook server stopped');
  }
}
