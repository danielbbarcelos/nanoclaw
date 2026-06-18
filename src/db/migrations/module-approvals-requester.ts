import type { Migration } from './index.js';

/**
 * Add `requester_user_id` to `pending_approvals`.
 *
 * Separation-of-duties primitive: record who initiated an approval so the
 * approver can be required to be a different person (see pickApprover's
 * exclusion + isAuthorizedApprovalClick's self-approval block). Nullable —
 * agent-initiated rows (self-mod, schedule_task_script) carry no human
 * requester and leave it NULL, which keeps the existing behavior.
 */
export const moduleApprovalsRequester: Migration = {
  version: 17,
  name: 'approvals-requester-user-id',
  up(db) {
    db.exec(`ALTER TABLE pending_approvals ADD COLUMN requester_user_id TEXT;`);
  },
};
