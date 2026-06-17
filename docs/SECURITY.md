# NanoClaw Security Model

## Trust Model

| Entity | Trust Level | Rationale |
|--------|-------------|-----------|
| Main group | Trusted | Private self-chat, admin control |
| Non-main groups | Untrusted | Other users may be malicious |
| Container agents | Sandboxed | Isolated execution environment |
| Incoming messages | User input | Potential prompt injection |

## Security Boundaries

### 1. Container Isolation (Primary Boundary)

Agents execute in containers (lightweight Linux VMs), providing:
- **Process isolation** - Container processes cannot affect the host
- **Filesystem isolation** - Only explicitly mounted directories are visible
- **Non-root execution** - Runs as unprivileged `node` user (uid 1000)
- **Ephemeral containers** - Fresh environment per invocation (`--rm`)

This is the primary security boundary. Rather than relying on application-level permission checks, the attack surface is limited by what's mounted.

### 2. Mount Security

**External Allowlist** - Mount permissions stored at `~/.config/nanoclaw/mount-allowlist.json`, which is:
- Outside project root
- Never mounted into containers
- Cannot be modified by agents

**Default Blocked Patterns:**
```
.ssh, .gnupg, .aws, .azure, .gcloud, .kube, .docker,
credentials, .env, .netrc, .npmrc, id_rsa, id_ed25519,
private_key, .secret
```

**Protections:**
- Symlink resolution before validation (prevents traversal attacks)
- Container path validation (rejects `..` and absolute paths)
- `nonMainReadOnly` option forces read-only for non-main groups

**Read-Only Project Root:**

The main group's project root is mounted read-only. Writable paths the agent needs (store, group folder, IPC, `.claude/`) are mounted separately. This prevents the agent from modifying host application code (`src/`, `dist/`, `package.json`, etc.) which would bypass the sandbox entirely on next restart. The `store/` directory is mounted read-write so the main agent can access the SQLite database directly.

### 3. Session Isolation

Each group has isolated Claude sessions at `data/sessions/{group}/.claude/`:
- Groups cannot see other groups' conversation history
- Session data includes full message history and file contents read
- Prevents cross-group information disclosure

### 4. IPC Authorization

Messages and task operations are verified against group identity:

| Operation | Main Group | Non-Main Group |
|-----------|------------|----------------|
| Send message to own chat | ✓ | ✓ |
| Send message to other chats | ✓ | ✗ |
| Schedule task for self | ✓ | ✓ |
| Schedule task for others | ✓ | ✗ |
| View all tasks | ✓ | Own only |
| Manage other groups | ✓ | ✗ |

### 5. Credential Isolation (OneCLI Agent Vault)

Real API credentials **never enter containers**. NanoClaw uses [OneCLI's Agent Vault](https://github.com/onecli/onecli) to proxy outbound requests and inject credentials at the gateway level.

**How it works:**
1. Credentials are registered once with `onecli secrets create`, stored and managed by OneCLI
2. When NanoClaw spawns a container, it calls `applyContainerConfig()` to route outbound HTTPS through the OneCLI gateway
3. The gateway matches requests by host and path, injects the real credential, and forwards
4. Agents cannot discover real credentials — not in environment, stdin, files, or `/proc`

**Per-agent policies:**
Each NanoClaw group gets its own OneCLI agent identity. This allows different credential policies per group (e.g. your sales agent vs. support agent). OneCLI supports rate limits, and time-bound access and approval flows are on the roadmap.

**NOT Mounted:**
- Channel auth sessions (`store/auth/`) — host only
- Mount allowlist — external, never mounted
- Any credentials matching blocked patterns
- `.env` is shadowed with `/dev/null` in the project root mount

### 6. Egress Lockdown (Forced Proxy)

The `HTTPS_PROXY` env var only redirects *proxy-aware* clients — a tool that
ignores it (or a raw socket) could reach the internet directly and bypass
credential injection, approvals, and audit. Egress lockdown closes that hole at
the network layer.

**How it works:** agents are placed on a Docker `--internal` network
(`nanoclaw-egress`) that has **no route to the internet**. The OneCLI gateway
container is attached to that network, aliased as `host.docker.internal`, so the
injected proxy URL (`…@host.docker.internal:10255`) resolves to the gateway
*container-to-container*. The gateway is therefore the **only reachable hop** —
anything else has nowhere to go. The agent is non-root with no `NET_ADMIN`, so
it cannot undo this. Identical mechanism on macOS and Linux (no host firewall,
no `host-gateway` route).

- **Self-healing:** the gateway is re-attached to the network at every spawn and
  on each host-sweep tick, so an out-of-band detach (e.g. `docker compose up` on
  the OneCLI stack — its compose lives in `~/.onecli`, not this repo) recovers
  automatically.
- **Fail-fast:** if lockdown is on but the network can't be created or the
  gateway can't be attached (e.g. a non-standard gateway container name, or the
  gateway isn't running), nanoclaw **refuses to spawn the agent** and surfaces a
  clear error — it never silently falls back to open egress. Fix the cause (or
  set `NANOCLAW_EGRESS_LOCKDOWN=false`) and retry. The host-sweep re-heal is the
  exception: a heal failure there is logged but not fatal, since already-running
  agents stay on the internal net (no leak) until the gateway returns.

**Configuration:**

| Env | Default | Meaning |
| --- | --- | --- |
| `NANOCLAW_EGRESS_LOCKDOWN` | `false` | Set `true` to opt in (otherwise the host-gateway path is used). Enabled automatically by `/add-golden-registry`. |
| `NANOCLAW_EGRESS_NETWORK` | `nanoclaw-egress` | Network name. |
| `ONECLI_GATEWAY_CONTAINER` | `onecli` | Gateway container to attach. |

**⚠ Behavior when enabled:** with lockdown on, agents have **no direct
internet** — all traffic must go through OneCLI. Proxy-aware clients (npm, pnpm,
pip, curl, node/bun with the proxy env) are unaffected. Any workflow that relies
on a **non-proxy-aware** tool reaching the internet directly will fail by design.
Lockdown is **off by default**; opt in with `NANOCLAW_EGRESS_LOCKDOWN=true`.

### 7. Resource Limits & Container Hardening

A prompt-injected or runaway agent has a full shell inside its container by
design (the container is the trust boundary). These spawn-time limits bound the
blast radius so one hostile session can't take the **host** down (fork bomb,
memory balloon, disk/PID exhaustion) or escalate after a runtime escape. Applied
in `buildContainerArgs` (`src/container-runner.ts`).

| Env | Default | Flag | Meaning |
| --- | --- | --- | --- |
| `NANOCLAW_CONTAINER_NO_NEW_PRIVILEGES` | `true` | `--security-opt no-new-privileges` | Blocks setuid privilege escalation inside the container. Set `false` to drop. |
| `NANOCLAW_CONTAINER_MEMORY` | `4g` | `--memory` / `--memory-swap` | Hard memory ceiling (swap disabled). `''`/`off` removes the limit. |
| `NANOCLAW_CONTAINER_PIDS` | `1024` | `--pids-limit` | Caps processes/threads — defangs fork bombs. `''`/`off` removes. |
| `NANOCLAW_CONTAINER_CPUS` | _(unset)_ | `--cpus` | Opt-in CPU quota (e.g. `2`). Off by default — `--pids-limit` already bounds fork bombs and a quota can slow legitimate work. |

Tune limits up for heavy browser/build workloads; the defaults target normal
coding and agent-browser use.

### 8. Backups & Durability

`data/v2.db` is the **sole** store of identity, roles, and wiring, and it's
gitignored — losing it means re-running setup and re-wiring every channel. Two
mechanisms protect it (`src/db/backup.ts`):

- **Pre-migration snapshot** — `runMigrations` writes a `VACUUM INTO` snapshot
  before applying any pending migration (some migrations recreate tables and
  none have a reverse, so this is the recovery path for a bad upgrade).
- **Periodic snapshot** — a daily timer (`startDbBackupTimer`) snapshots the
  live DB. `VACUUM INTO` is consistent under concurrent writes and folds in WAL
  frames, so there's no `-wal`/`-shm` sidecar to copy.

Snapshots land in `data/backups/<name>.<label>-<ts>.bak`, pruned to the most
recent `NANOCLAW_DB_BACKUP_KEEP` (default 14).

| Env | Default | Meaning |
| --- | --- | --- |
| `NANOCLAW_DB_BACKUP_KEEP` | `14` | Snapshots retained per source DB. |
| `NANOCLAW_DB_BACKUP_INTERVAL_HOURS` | `24` | Periodic backup cadence; `0` disables the timer. |

**Manual backup:** `pnpm exec tsx scripts/backup-db.ts` (safe while the host is
running). **Restore:** stop NanoClaw, remove any `data/v2.db-wal`/`-shm`, then
`cp data/backups/v2.db.<...>.bak data/v2.db`.

On graceful shutdown the host closes the central DB so better-sqlite3
checkpoints the WAL back into `v2.db` (otherwise the latest writes can linger
only in `v2.db-wal`). Session DBs run `journal_mode=DELETE` with an explicit
`synchronous=FULL` so a power loss can't corrupt in-flight messages.

## Privilege Comparison

| Capability | Main Group | Non-Main Group |
|------------|------------|----------------|
| Project root access | `/workspace/project` (ro) | None |
| Store (SQLite DB) | `/workspace/project/store` (rw) | None |
| Group folder | `/workspace/group` (rw) | `/workspace/group` (rw) |
| Global memory | Implicit via project | `/workspace/global` (ro) |
| Additional mounts | Configurable | Read-only unless allowed |
| Network access | Unrestricted | Unrestricted |
| MCP tools | All | All |

## Security Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                        UNTRUSTED ZONE                             │
│  Incoming Messages (potentially malicious)                         │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼ Trigger check, input escaping
┌──────────────────────────────────────────────────────────────────┐
│                     HOST PROCESS (TRUSTED)                        │
│  • Message routing                                                │
│  • IPC authorization                                              │
│  • Mount validation (external allowlist)                          │
│  • Container lifecycle                                            │
│  • OneCLI Agent Vault (injects credentials, enforces policies)   │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼ Explicit mounts only, no secrets
┌──────────────────────────────────────────────────────────────────┐
│                CONTAINER (ISOLATED/SANDBOXED)                     │
│  • Agent execution                                                │
│  • Bash commands (sandboxed)                                      │
│  • File operations (limited to mounts)                            │
│  • API calls routed through OneCLI Agent Vault                   │
│  • No real credentials in environment or filesystem              │
└──────────────────────────────────────────────────────────────────┘
```

## Supply Chain Security (pnpm)

NanoClaw uses pnpm with two supply chain defenses configured in `pnpm-workspace.yaml`:

### Minimum Release Age

`minimumReleaseAge: 4320` (3 days). pnpm will refuse to resolve any package version published less than 3 days ago. This defends against typosquatting and compromised maintainer accounts — most malicious publishes are detected and pulled within 72 hours.

**Excluding a package from the release age gate** (`minimumReleaseAgeExclude`):

This should be rare. When a zero-day fix or critical dependency requires an immediate update:

1. The exclusion must be reviewed and approved by a human maintainer
2. The entry must pin the **exact version** being excluded — never a range or wildcard
   ```yaml
   minimumReleaseAgeExclude:
     some-package: "1.2.3"  # Approved by @user, 2026-04-14 — CVE-XXXX-YYYY fix
   ```
3. The exclusion should be removed once the version ages past the threshold (i.e. after 3 days)
4. Automated agents (Claude, CI bots) must never add exclusions without human sign-off

### Build Script Allowlist

`onlyBuiltDependencies` restricts which packages can execute install/postinstall scripts. Only packages on this list are permitted to run build scripts during `pnpm install`. Currently allowed:

- `better-sqlite3` — compiles native SQLite bindings
- `esbuild` — downloads platform-specific binary
- `protobufjs` — generates protobuf bindings (used by Baileys/libsignal)
- `sharp` — downloads platform-specific image processing binary

Adding a package to this list requires human approval — build scripts execute arbitrary code with the installing user's permissions.

### `.npmrc` Safety Net

The `.npmrc` file contains `minReleaseAge=3d` as a fallback. The authoritative setting is in `pnpm-workspace.yaml`, but `.npmrc` provides defense-in-depth if npm is ever invoked directly (e.g. by a tool that doesn't respect pnpm).
