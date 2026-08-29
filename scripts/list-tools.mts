/**
 * Prints the exposed tool surface: what the agent sees, and what the policy left
 * out and why.
 *
 * It goes through `buildApiTools()` — the same entry point the server uses — so
 * the listing can never describe a different set of tools than the one served.
 *
 *   npm run tools:list
 */
import { buildApiTools } from '../src/tools/api-tools.js';
import { toolName } from '../src/spec/derive.js';

const { tools, policy } = buildApiTools();
const total = tools.length + policy.excluded.length;

console.log(`total ops: ${total}, included: ${tools.length}, excluded: ${policy.excluded.length}`);
for (const { tool } of tools) console.log('  +', tool.name);
for (const e of policy.excluded) console.log('  -', toolName(e.op.operationId), e.reason);
