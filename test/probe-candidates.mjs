/**
 * Candidate REST paths for the plugins that most often need adapting.
 * Shared by scripts/probe-paths.mjs and the optional probe phase of the live verification.
 */
export const CANDIDATES = [
  // Tempo Timesheets - several generations of the API
  '/rest/tempo-timesheets/4/worklogs',
  '/rest/tempo-timesheets/3/worklogs',
  '/rest/tempo-timesheets/4/worklogs/search',
  '/rest/tempo-timesheets/4/worklog',
  '/rest/tempo-timesheets/4/projects',
  '/rest/tempo-timesheets/4/periods',
  '/rest/tempo-core/1/worklogs',
  '/rest/tempo/1/worklogs',
  // ScriptRunner
  '/rest/scriptrunner/latest/custom',
  // Jira Service Management (Server)
  '/rest/servicedeskapi/servicedesk',
  '/rest/servicedeskapi/request',
  // Zephyr Scale (Server)
  '/rest/atm/1.0/testcase/search',
  '/rest/atm/1.0/environments',
  // Xray (Server)
  '/rest/raven/1.0/api/test',
  '/rest/raven/2.0/api/test',
  // Zephyr Squad / Zephyr for Jira (Server)
  '/rest/zapi/latest/cycle',
  '/rest/zapi/latest/util/versionBoard-list',
  // Structure
  '/rest/structure/2.0/structure',
  // Insight / Assets
  '/rest/insight/1.0/objectschema/list',
  // Tempo modules - the target instance has Planner, Teams and Accounts (not Timesheets),
  // which is why the tempo-timesheets paths above answer 405/404 there.
  '/rest/tempo-planning/1/plan',
  '/rest/tempo-teams/2/team',
  '/rest/tempo-teams/1/team',
  '/rest/tempo-accounts/1/account',
];
