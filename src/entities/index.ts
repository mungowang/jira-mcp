import { issue } from './issue.ts';
import { comment } from './comment.ts';
import { worklog } from './worklog.ts';
import { attachment } from './attachment.ts';
import { project } from './project.ts';
import { user } from './user.ts';
import { meta } from './meta.ts';
import { pluginInventory } from './plugin-inventory.ts';
import { link } from './link.ts';
import { watcher } from './watcher.ts';
import { agile } from './agile.ts';

/** Common Jira entities, one file each. Adding an entity = adding a file + one line here. */
export const entities = [issue, comment, worklog, attachment, project, user, link, watcher, meta, pluginInventory, agile];
