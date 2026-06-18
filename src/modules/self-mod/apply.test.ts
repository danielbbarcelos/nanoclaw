/**
 * Locks host-side defense-in-depth: even if a malicious payload reaches the
 * apply step (bypassing request-side checks), apply.ts re-validates and refuses
 * to write an unsafe package name / MCP command into the container config.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { Session } from '../../types.js';

vi.mock('../../container-runner.js', () => ({
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
  killContainer: vi.fn(),
  wakeContainer: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../db/agent-groups.js', () => ({ getAgentGroup: vi.fn(() => ({ id: 'ag-1', name: 'g' })) }));
vi.mock('../../db/container-configs.js', () => ({
  getContainerConfig: vi.fn(() => ({ packages_apt: '[]', packages_npm: '[]', mcp_servers: '{}' })),
  updateContainerConfigJson: vi.fn(),
}));
vi.mock('../../db/sessions.js', () => ({ getSession: vi.fn(() => null) }));
vi.mock('../../session-manager.js', () => ({ writeSessionMessage: vi.fn() }));

import { buildAgentGroupImage } from '../../container-runner.js';
import { updateContainerConfigJson } from '../../db/container-configs.js';
import { applyAddMcpServer, applyInstallPackages } from './apply.js';

const session = { id: 'sess-1', agent_group_id: 'ag-1' } as unknown as Session;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('applyInstallPackages — host-side revalidation', () => {
  it('rejects a malicious apt name and never mutates config or rebuilds', async () => {
    const notify = vi.fn();
    await applyInstallPackages({ session, payload: { apt: ['foo; rm -rf /'], npm: [] }, userId: 'u', notify });
    expect(updateContainerConfigJson).not.toHaveBeenCalled();
    expect(buildAgentGroupImage).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('rejected at apply'));
  });

  it('applies a valid request', async () => {
    const notify = vi.fn();
    await applyInstallPackages({ session, payload: { apt: ['ripgrep'], npm: [] }, userId: 'u', notify });
    expect(updateContainerConfigJson).toHaveBeenCalled();
    expect(buildAgentGroupImage).toHaveBeenCalled();
  });
});

describe('applyAddMcpServer — host-side revalidation', () => {
  it('rejects a command with shell metacharacters', async () => {
    const notify = vi.fn();
    await applyAddMcpServer({
      session,
      payload: { name: 'srv', command: 'sh -c "evil"', args: [] },
      userId: 'u',
      notify,
    });
    expect(updateContainerConfigJson).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('rejected at apply'));
  });

  it('applies a valid MCP server', async () => {
    const notify = vi.fn();
    await applyAddMcpServer({
      session,
      payload: { name: 'srv', command: 'npx', args: ['-y', 'x'] },
      userId: 'u',
      notify,
    });
    expect(updateContainerConfigJson).toHaveBeenCalled();
  });
});
