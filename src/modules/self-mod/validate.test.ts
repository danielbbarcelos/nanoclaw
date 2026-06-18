/**
 * Locks the self-mod payload validators. These names/commands flow into shell
 * exec and MCP process spawn on approve, so the regexes are a security boundary:
 * shell metacharacters, spaces, and traversal-ish input must be rejected.
 */
import { describe, expect, it } from 'vitest';

import { validateMcpServer, validatePackages } from './validate.js';

describe('validatePackages', () => {
  it('accepts normal apt and npm names', () => {
    expect(validatePackages(['ripgrep', 'lib2-dev'], ['@scope/pkg', 'left-pad']).ok).toBe(true);
  });

  it('requires at least one package', () => {
    expect(validatePackages([], []).ok).toBe(false);
  });

  it('caps the number of packages', () => {
    const many = Array.from({ length: 21 }, (_, i) => `p${i}`);
    expect(validatePackages(many, []).ok).toBe(false);
  });

  it('rejects shell metacharacters and traversal in apt names', () => {
    for (const bad of ['foo; rm -rf /', 'foo&&bar', '../etc', 'foo$(id)', '-rf', 'a b']) {
      expect(validatePackages([bad], []).ok, bad).toBe(false);
    }
  });

  it('rejects injection in npm names', () => {
    for (const bad of ['foo;bar', 'pkg && evil', 'http://evil', '../x']) {
      expect(validatePackages([], [bad]).ok, bad).toBe(false);
    }
  });
});

describe('validateMcpServer', () => {
  it('accepts a normal server', () => {
    expect(validateMcpServer('my-server', 'npx', ['-y', 'pkg']).ok).toBe(true);
    expect(validateMcpServer('srv', '/usr/local/bin/tool', []).ok).toBe(true);
  });

  it('requires name and command', () => {
    expect(validateMcpServer('', 'npx', []).ok).toBe(false);
    expect(validateMcpServer('srv', '', []).ok).toBe(false);
    expect(validateMcpServer(undefined, undefined, undefined).ok).toBe(false);
  });

  it('rejects shell metacharacters in the command', () => {
    for (const bad of ['npx; rm -rf /', 'sh -c "evil"', 'node && id', 'cmd|tee', 'a b']) {
      expect(validateMcpServer('srv', bad, []).ok, bad).toBe(false);
    }
  });

  it('rejects invalid server names', () => {
    for (const bad of ['has space', 'name;evil', '../x', 'a'.repeat(70)]) {
      expect(validateMcpServer(bad, 'npx', []).ok, bad).toBe(false);
    }
  });

  it('rejects non-string args', () => {
    expect(validateMcpServer('srv', 'npx', ['ok', 42]).ok).toBe(false);
    expect(validateMcpServer('srv', 'npx', 'not-an-array').ok).toBe(false);
  });
});
