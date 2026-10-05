// T2 fills this in: turn ids, dedupe, join, ack gate.
import { setup } from 'xstate';

export const turnsMachine = setup({}).createMachine({ id: 'turns' });
