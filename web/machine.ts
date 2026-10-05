// T5 fills this in: the page machine with parallel regions.
import { setup } from 'xstate';

export const pageMachine = setup({}).createMachine({ id: 'page' });
