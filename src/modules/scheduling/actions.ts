/**
 * Delivery action handlers for scheduling.
 *
 * The container can't write to inbound.db (host-owned). When the agent calls
 * schedule_task / cancel_task / etc. via MCP, the container writes a
 * `kind='system'` outbound message with an `action` field. The delivery path
 * reaches into this module via the delivery-action registry and we apply the
 * change to inbound.db here.
 */
import type Database from 'better-sqlite3';

import { wakeContainer } from '../../container-runner.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { notifyAgent, requestApproval } from '../approvals/index.js';
import { cancelTask, insertTask, pauseTask, resumeTask, updateTask, type TaskUpdate } from './db.js';

/** A non-empty string we treat as a real pre-agent script (needs approval). */
function hasScript(script: unknown): script is string {
  return typeof script === 'string' && script.trim() !== '';
}

export async function handleScheduleTask(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const taskId = content.taskId as string;
  const prompt = content.prompt as string;
  const script = content.script as string | null;
  const processAfter = content.processAfter as string;
  const recurrence = (content.recurrence as string) || null;

  // Security: a task carrying a shell script runs in the container before the
  // agent (applyPreTaskScripts) — an arbitrary-code/persistence vector. Gate it
  // behind admin approval so a prompt-injected agent can't self-schedule it.
  if (hasScript(script)) {
    const agentGroup = getAgentGroup(session.agent_group_id);
    if (!agentGroup) {
      notifyAgent(session, 'schedule_task failed: agent group not found.');
      return;
    }
    await requestApproval({
      session,
      agentName: agentGroup.name,
      action: 'schedule_task_script',
      payload: {
        op: 'schedule',
        taskId,
        prompt,
        script,
        processAfter,
        recurrence,
        platformId: (content.platformId as string) ?? null,
        channelType: (content.channelType as string) ?? null,
        threadId: (content.threadId as string) ?? null,
      },
      title: 'Scheduled Script Approval',
      question: `Agent "${agentGroup.name}" wants to schedule a task that runs a shell script before the agent:\n\n${script.slice(0, 500)}`,
    });
    notifyAgent(
      session,
      'schedule_task: the task includes a shell script, so it needs admin approval before it will run. An approval request was sent.',
    );
    return;
  }

  insertTask(inDb, {
    id: taskId,
    processAfter,
    recurrence,
    platformId: (content.platformId as string) ?? null,
    channelType: (content.channelType as string) ?? null,
    threadId: (content.threadId as string) ?? null,
    content: JSON.stringify({ prompt, script }),
  });
  log.info('Scheduled task created', { taskId, processAfter, recurrence });
}

export async function handleCancelTask(
  content: Record<string, unknown>,
  _session: Session,
  inDb: Database.Database,
): Promise<void> {
  const taskId = content.taskId as string;
  cancelTask(inDb, taskId);
  log.info('Task cancelled', { taskId });
}

export async function handlePauseTask(
  content: Record<string, unknown>,
  _session: Session,
  inDb: Database.Database,
): Promise<void> {
  const taskId = content.taskId as string;
  pauseTask(inDb, taskId);
  log.info('Task paused', { taskId });
}

export async function handleResumeTask(
  content: Record<string, unknown>,
  _session: Session,
  inDb: Database.Database,
): Promise<void> {
  const taskId = content.taskId as string;
  resumeTask(inDb, taskId);
  log.info('Task resumed', { taskId });
}

export async function handleUpdateTask(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const taskId = content.taskId as string;
  const update: TaskUpdate = {};
  if (typeof content.prompt === 'string') update.prompt = content.prompt;
  if (typeof content.processAfter === 'string') update.processAfter = content.processAfter;
  if (content.recurrence === null || typeof content.recurrence === 'string') {
    update.recurrence = content.recurrence as string | null;
  }
  if (content.script === null || typeof content.script === 'string') {
    update.script = content.script as string | null;
  }

  // Security: same gate as schedule_task — adding a non-empty script must be
  // approved, else an agent could schedule a benign task then update it to
  // smuggle in a script. Clearing the script (null/empty) stays unguarded.
  if (hasScript(update.script)) {
    const agentGroup = getAgentGroup(session.agent_group_id);
    if (!agentGroup) {
      notifyAgent(session, 'update_task failed: agent group not found.');
      return;
    }
    await requestApproval({
      session,
      agentName: agentGroup.name,
      action: 'schedule_task_script',
      payload: { op: 'update', taskId, update },
      title: 'Scheduled Script Approval',
      question: `Agent "${agentGroup.name}" wants to update task "${taskId}" to run a shell script:\n\n${update.script.slice(0, 500)}`,
    });
    notifyAgent(
      session,
      'update_task: adding a shell script needs admin approval before it will run. An approval request was sent.',
    );
    return;
  }

  const touched = updateTask(inDb, taskId, update);
  log.info('Task updated', { taskId, touched, fields: Object.keys(update) });
  if (touched === 0) {
    // Notify the agent that update_task matched nothing. Replicates the
    // old notifyAgent helper that used to live in delivery.ts — inlined
    // here so scheduling doesn't depend on delivery's private helpers.
    writeSessionMessage(session.agent_group_id, session.id, {
      id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: session.agent_group_id,
      channelType: 'agent',
      threadId: null,
      content: JSON.stringify({
        text: `update_task: no live task matched id "${taskId}".`,
        sender: 'system',
        senderId: 'system',
      }),
    });
    const fresh = getSession(session.id);
    if (fresh) {
      wakeContainer(fresh).catch((err) =>
        log.error('Failed to wake container after update_task notification', { err }),
      );
    }
  }
}
