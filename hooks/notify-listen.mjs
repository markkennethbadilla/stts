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
const sid = encodeURIComponent(String(p.session_id ?? ''));
// This hook is global: /notify carries the session so another session's agent never wakes this listen.
if (p.hook_event_name === 'PreToolUse') {
  // This session is the one listening: tell the daemon, which wakes only for this session's agents.
  try {
    await fetch(`http://127.0.0.1:${port}/session?id=${sid}`, { method: 'POST', signal: AbortSignal.timeout(2000) });
  } catch {} // SILENT-OK: a hook never blocks the session
  process.exit(0);
}
if (p.hook_event_name === 'PostToolUse') {
  // <proj>/<session>.jsonl -> <proj>/<session>/workflows/<runId>.json
  const run = JSON.stringify(p.tool_response ?? '').match(/wf_[\w-]+/)?.[0];
  const session = String(p.transcript_path ?? '').replace(/\.jsonl$/, '');
  if (!run || !session) process.exit(0);
  query = `?session=${sid}&watch=${encodeURIComponent(`${session}/workflows/${run}.json`)}`;
} else {
  const path = String(p.agent_transcript_path ?? '').replaceAll('\\', '/');
  if (p.agent_type === 'workflow-subagent' || path.includes('/subagents/workflows/')) process.exit(0);
  query = `?session=${sid}`;
}
try {
  await fetch(`http://127.0.0.1:${port}/notify${query}`, { method: 'POST', signal: AbortSignal.timeout(2000) });
} catch {}
process.exit(0);
