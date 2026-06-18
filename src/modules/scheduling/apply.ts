/**
 * Approval handler for scheduled tasks that carry a pre-agent shell script.
 *
 * A task's `script` is executed in the container before the agent runs
 * (container/agent-runner/src/scheduling/task-script.ts → applyPreTaskScripts).
 * That is an arbitrary-code/persistence vector, so schedule_task / update_task
 * route the script case through admin approval (see actions.ts). On approve we
 * perform the deferred insert/update here; on reject nothing is written.
 */
import { log } from '../../log.js';
import { openInboundDb } from '../../session-manager.js';
import type { ApprovalHandler } from '../approvals/index.js';
import { insertTask, updateTask, type TaskUpdate } from './db.js';

export const applyTaskScript: ApprovalHandler = async ({ session, payload, notify }) => {
  const inDb = openInboundDb(session.agent_group_id, session.id);
  let message: string;
  try {
    if (payload.op === 'update') {
      const taskId = payload.taskId as string;
      const update = payload.update as TaskUpdate;
      const touched = updateTask(inDb, taskId, update);
      log.info('Task script update approved', { taskId, touched });
      message =
        touched > 0
          ? `update_task: script approved — task "${taskId}" updated.`
          : `update_task: approved, but no live task matched id "${taskId}".`;
    } else {
      const taskId = payload.taskId as string;
      insertTask(inDb, {
        id: taskId,
        processAfter: payload.processAfter as string,
        recurrence: (payload.recurrence as string | null) ?? null,
        platformId: (payload.platformId as string | null) ?? null,
        channelType: (payload.channelType as string | null) ?? null,
        threadId: (payload.threadId as string | null) ?? null,
        content: JSON.stringify({ prompt: payload.prompt, script: payload.script }),
      });
      log.info('Scheduled task with script approved', { taskId });
      message = `schedule_task: script approved — task "${taskId}" scheduled.`;
    }
  } finally {
    inDb.close();
  }
  // Notify after closing our handle so the notify path's own connection has it.
  notify(message);
};
