// SubagentStop: a background agent finished. Tell the stts daemon so an open listen
// returns __STTS_BACKGROUND_RESULT__. Daemon down or slow: do nothing, exit 0.
const port = Number(process.env.STTS_PORT) || 15986;
try {
  await fetch(`http://127.0.0.1:${port}/notify`, { method: 'POST', signal: AbortSignal.timeout(2000) });
} catch {}
process.exit(0);
