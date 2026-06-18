/**
 * DoS hardening guards for the internet-facing webhook server:
 * per-IP rate limiting, request body-size cap, generic (non-enumerating)
 * 404s, and the X-Content-Type-Options: nosniff header. Drives the REAL
 * shared HTTP server on a fixed WEBHOOK_PORT, like the sibling tests.
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { Chat } from 'chat';

import { registerWebhookAdapter, registerWebhookHandler, stopWebhookServer } from './webhook-server.js';

const PORT = 3918;
const BASE = `http://127.0.0.1:${PORT}`;

async function send(path: string, init?: RequestInit): Promise<Response> {
  // Server starts listening async after registration — retry on refusal.
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(`${BASE}${path}`, { method: 'POST', body: '{}', ...init });
    } catch (err) {
      if (attempt >= 40) throw err;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

afterEach(async () => {
  await stopWebhookServer();
  delete process.env.WEBHOOK_PORT;
  delete process.env.WEBHOOK_RATE_LIMIT;
  delete process.env.WEBHOOK_RATE_WINDOW_MS;
  delete process.env.WEBHOOK_MAX_BODY_BYTES;
});

describe('webhook server — DoS hardening', () => {
  it('rate-limits a flood of requests from the same IP with 429', async () => {
    process.env.WEBHOOK_PORT = String(PORT);
    process.env.WEBHOOK_RATE_LIMIT = '3';
    process.env.WEBHOOK_RATE_WINDOW_MS = '60000';
    registerWebhookHandler('ping', (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('pong');
    });

    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      statuses.push((await send('/webhook/ping')).status);
    }
    // First 3 within the window pass; the 4th is throttled.
    expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
    expect(statuses[3]).toBe(429);
  });

  it('rejects bodies over the limit with 413 (declared Content-Length)', async () => {
    process.env.WEBHOOK_PORT = String(PORT);
    process.env.WEBHOOK_MAX_BODY_BYTES = '16';
    const chat = { webhooks: { slack: async () => new Response('ok') } } as unknown as Chat;
    registerWebhookAdapter(chat, 'slack');

    const big = 'x'.repeat(1024);
    const res = await send('/webhook/slack', { body: big });
    expect(res.status).toBe(413);
  });

  it('does not echo the adapter name on an unknown route (no enumeration)', async () => {
    process.env.WEBHOOK_PORT = String(PORT);
    const chat = { webhooks: { slack: async () => new Response('ok') } } as unknown as Chat;
    registerWebhookAdapter(chat, 'slack');

    const res = await send('/webhook/secret-adapter');
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toBe('Not found');
    expect(body).not.toContain('secret-adapter');
  });

  it('sets X-Content-Type-Options: nosniff on responses', async () => {
    process.env.WEBHOOK_PORT = String(PORT);
    const chat = { webhooks: { slack: async () => new Response('ok') } } as unknown as Chat;
    registerWebhookAdapter(chat, 'slack');

    const miss = await send('/webhook/unknown');
    expect(miss.headers.get('x-content-type-options')).toBe('nosniff');

    const hit = await send('/webhook/slack');
    expect(hit.headers.get('x-content-type-options')).toBe('nosniff');
  });
});
