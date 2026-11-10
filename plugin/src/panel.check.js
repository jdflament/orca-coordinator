// `orca plugin check` renders the panel once per scenario, each with the worker
// on a fresh host. Each scenario points the worker at a fixture board.
import { defineCheck } from 'orca/testing';
const busy = new URL('./fixtures/busy.json', import.meta.url).pathname;
const empty = new URL('./fixtures/empty.json', import.meta.url).pathname;
export default defineCheck({
    busy: { settings: { boardPath: busy } },
    empty: { settings: { boardPath: empty } },
    missing: { settings: { boardPath: '/nonexistent/coordinator-board.json' } }
});
