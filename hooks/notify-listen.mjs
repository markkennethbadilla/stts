// SubagentStop: a background agent finished. Tell the stts daemon so an open listen
// returns __STTS_BACKGROUND_RESULT__. PostToolUse on Workflow: hand the daemon the run's
// state file to watch, since Claude Code fires no hook when a workflow ends (spec 007).
// Daemon down or slow: do nothing, exit 0.
// An agent inside a Workflow is skipped: the session gets no task-notification for it
// (only for the whole workflow), so a release would spin the listen loop (spec 007).
let p = {};
try {
  let s = '';
  for await (const c of process.stdin) s += c;
  p = JSON.parse(s);
} catch {}
const port = Number(process.env.STTS_PORT) || 15986;
let query = '';
if (p.hook_event_name === 'PostToolUse') {
  // <proj>/<session>.jsonl -> <proj>/<session>/workflows/<runId>.json
  const run = JSON.stringify(p.tool_response ?? '').match(/wf_[\w-]+/)?.[0];
  const session = String(p.transcript_path ?? '').replace(/\.jsonl$/, '');
  if (!run || !session) process.exit(0);
  query = `?watch=${encodeURIComponent(`${session}/workflows/${run}.json`)}`;
} else {
  const path = String(p.agent_transcript_path ?? '').replaceAll('\\', '/');
  if (p.agent_type === 'workflow-subagent' || path.includes('/subagents/workflows/')) process.exit(0);
}
try {
  await fetch(`http://127.0.0.1:${port}/notify${query}`, { method: 'POST', signal: AbortSignal.timeout(2000) });
} catch {}
process.exit(0);
