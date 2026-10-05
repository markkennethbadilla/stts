// T4 fills this in: typed fetch to the daemon.
import { DEFAULT_PORT } from './protocol.ts';

export const daemonUrl = (port: number = Number(process.env['STTS_PORT'] ?? DEFAULT_PORT)): string =>
  `http://127.0.0.1:${port}`;
