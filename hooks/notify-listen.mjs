// SubagentStop: a background agent finished. Tell the stts daemon so an open listen
// returns __STTS_BACKGROUND_RESULT__. Daemon down or slow: do nothing, exit 0.
// An agent inside a Workflow is skipped: the session gets no task-notification for it
// (only for the whole workflow), so a release would spin the listen loop (spec 007).
let p = {};
try {
  let s = '';
  for await (const c of process.stdin) s += c;
  p = JSON.parse(s);
} catch {}
const path = String(p.agent_transcript_path ?? '').replaceAll('\\', '/');
if (p.agent_type === 'workflow-subagent' || path.includes('/subagents/workflows/')) process.exit(0);
const port = Number(process.env.STTS_PORT) || 15986;
try {
  await fetch(`http://127.0.0.1:${port}/notify`, { method: 'POST', signal: AbortSignal.timeout(2000) });
} catch {}
process.exit(0);
