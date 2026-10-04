/**
 * Opt-in write verification.
 *
 * Everything happens on a throwaway probe issue that is deleted in a `finally`, so the only
 * lasting effects are a link on an existing issue (removed again) and a watcher/assignee
 * change on the probe itself.
 *
 * Guarded twice on purpose: it refuses to run unless VERIFY_WRITE=1 AND VERIFY_PROJECT is
 * set explicitly. There is no default project - a typo must not be able to write anywhere.
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { shapeOf } from './capture.mjs';

export function writeModeEnabled() {
  return process.env.VERIFY_WRITE === '1';
}

export function assertWriteModeConfigured() {
  if (!process.env.VERIFY_PROJECT) {
    throw new Error(
      'VERIFY_WRITE=1 requires VERIFY_PROJECT=<KEY> as well. ' +
      'The probe issue is created in that project and deleted at the end; ' +
      'no default is used so a mistake cannot write into the wrong project.',
    );
  }
}

export async function verifyWrites(srv, ctx, { record, issueTypeName = 'Task' } = {}) {
  const project = process.env.VERIFY_PROJECT;
  const stamp = new Date().toISOString();
  let probeKey = null;
  const localFile = resolve(tmpdir(), `mcp-verify-${Date.now()}.txt`);
  writeFileSync(localFile, 'probe');

  /**
   * Write responses are the only evidence for the envelopes on the write path
   * (createdIssue / comment / worklog / attachment), which are permissive today only because
   * nothing has observed them. Record their shape so the schemas can be tightened afterwards.
   */
  const shapes = {};
  const step = async (label, fn) => {
    try {
      const r = await fn();
      if (!r.ok) { record(label, 'fail', r.text); console.log(`  x  ${label}  ${r.text.split('\n')[0].slice(0, 110)}`); return null; }
      record(label, 'ok', ''); console.log(`  ok ${label}`);
      const parsed = r.structuredContent ?? (() => { try { return JSON.parse(r.text); } catch { return r.text; } })();
      if (parsed && typeof parsed === 'object') shapes[label] = shapeOf(parsed);
      return parsed;
    } catch (err) {
      record(label, 'fail', err.message); console.log(`  x  ${label}  ${err.message.slice(0, 110)}`); return null;
    }
  };

  try {
    // Describe first - this is also where a screen restriction would surface.
    await step('jira_describe_create', () => srv.callTool('jira_describe_create', { projectKey: project, issueTypeName }));

    const created = await step('jira_create_issue', () => srv.callTool('jira_create_issue', {
      fields: {
        project: { key: project },
        summary: `[mcp-verify] ${stamp}`,
        issuetype: { name: issueTypeName },
        description: 'Created by test/live-verify.mjs with VERIFY_WRITE=1. Safe to delete.',
      },
    }));
    probeKey = created?.key ?? null;
    if (!probeKey) {
      console.log('  ! could not create the probe issue; skipping the remaining write checks');
      return;
    }
    console.log(`  i  probe issue: ${probeKey}`);

    await step('jira_get_issue', () => srv.callTool('jira_get_issue', { key: probeKey }));
    await step('jira_describe_edit', () => srv.callTool('jira_describe_edit', { key: probeKey }));
    await step('jira_update_issue', () => srv.callTool('jira_update_issue', { key: probeKey, fields: { summary: `[mcp-verify] updated ${stamp}` } }));
    await step('jira_assign_issue', () => srv.callTool('jira_assign_issue', { key: probeKey, assignee: ctx.username }));

    const comment = await step('jira_add_comment', () => srv.callTool('jira_add_comment', { key: probeKey, body: 'probe comment' }));
    await step('jira_list_comments', () => srv.callTool('jira_list_comments', { key: probeKey }));
    if (comment?.id) {
      await step('jira_update_comment', () => srv.callTool('jira_update_comment', { key: probeKey, commentId: comment.id, body: 'probe comment (edited)' }));
      await step('jira_delete_comment', () => srv.callTool('jira_delete_comment', { key: probeKey, commentId: comment.id }));
    }

    const worklog = await step('jira_add_worklog', () => srv.callTool('jira_add_worklog', {
      key: probeKey, timeSpentSeconds: 60, started: '2026-01-01T09:00:00.000+0800', comment: 'probe',
    }));
    await step('jira_list_worklogs', () => srv.callTool('jira_list_worklogs', { key: probeKey }));
    if (worklog?.id) await step('jira_delete_worklog', () => srv.callTool('jira_delete_worklog', { key: probeKey, worklogId: worklog.id }));

    await step('jira_add_watcher', () => srv.callTool('jira_add_watcher', { key: probeKey, username: ctx.username }));
    await step('jira_get_watchers', () => srv.callTool('jira_get_watchers', { key: probeKey }));
    await step('jira_remove_watcher', () => srv.callTool('jira_remove_watcher', { key: probeKey, username: ctx.username }));

    await step('jira_upload_attachment', () => srv.callTool('jira_upload_attachment', { key: probeKey, filePath: localFile }));
    const withAttachments = await step('jira_list_attachments', () => srv.callTool('jira_list_attachments', { key: probeKey }));
    const attachment = withAttachments?.fields?.attachment?.[0];
    if (attachment?.id) {
      await step('jira_get_attachment_meta', () => srv.callTool('jira_get_attachment_meta', { id: attachment.id }));
      await step('jira_delete_attachment', () => srv.callTool('jira_delete_attachment', { id: attachment.id }));
    }

    // Link to an existing issue, then remove the link (the other issue is never modified).
    if (ctx.issueKey && ctx.issueKey !== probeKey) {
      const types = await srv.callTool('jira_get_link_types', {});
      let linkType = 'Relates';
      try { linkType = JSON.parse(types.text)?.issueLinkTypes?.[0]?.name ?? linkType; } catch { /* keep default */ }
      await step('jira_link_issues', () => srv.callTool('jira_link_issues', {
        type: linkType, inwardIssue: probeKey, outwardIssue: ctx.issueKey,
      }));
      const linked = await step('jira_get_issue (issuelinks)', () => srv.callTool('jira_get_issue', { key: probeKey, fields: ['issuelinks'] }));
      const linkId = linked?.fields?.issuelinks?.[0]?.id;
      if (linkId) await step('jira_delete_link', () => srv.callTool('jira_delete_link', { linkId }));
      else record('jira_delete_link', 'skip', 'no link id came back in issuelinks');
    } else {
      record('jira_link_issues', 'skip', 'no second issue available to link the probe to');
      record('jira_delete_link', 'skip', 'no second issue available to link the probe to');
    }

    // Transitions depend on the workflow; the first available one is applied when there is one.
    const transitions = await step('jira_get_transitions', () => srv.callTool('jira_get_transitions', { key: probeKey }));
    const transition = transitions?.transitions?.[0];
    if (transition?.id) {
      await step('jira_transition_issue', () => srv.callTool('jira_transition_issue', { key: probeKey, transitionId: transition.id }));
    } else {
      record('jira_transition_issue', 'skip', 'no transition available from the initial status');
    }

    await step('jira_create_remote_link', () => srv.callTool('jira_create_remote_link', {
      key: probeKey, url: 'https://example.invalid/mcp-verify', title: 'mcp-verify probe',
    }));
    await step('jira_get_remote_links', () => srv.callTool('jira_get_remote_links', { key: probeKey }));
  } finally {
    if (Object.keys(shapes).length) {
      const dir = resolve(process.env.CAPTURE_DIR ?? 'capture');
      mkdirSync(dir, { recursive: true });
      const file = resolve(dir, 'write-shapes.json');
      writeFileSync(file, JSON.stringify(shapes, null, 2));
      console.log(`  i  write response shapes -> ${file} (gitignored; this is what tightens the write envelopes)`);
    }
    if (probeKey) {
      // Cleanup matters more than reporting: never leave the probe behind.
      const del = await srv.callTool('jira_delete_issue', { key: probeKey });
      record('jira_delete_issue (cleanup)', del.ok ? 'ok' : 'fail', del.ok ? `deleted ${probeKey}` : del.text);
      console.log(del.ok ? `  ok jira_delete_issue (cleanup) - ${probeKey} removed` : `  x  cleanup failed for ${probeKey}: ${del.text.slice(0, 120)}`);
    }
    rmSync(localFile, { force: true });
  }
}
