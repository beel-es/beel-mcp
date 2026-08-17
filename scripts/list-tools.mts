import { loadSpec } from '../src/spec/load.js';
import { buildManifest } from '../src/spec/manifest.js';
import { toolName } from '../src/spec/derive.js';
import { applyToolPolicy } from '../src/policy/tool-policy.js';

const spec = loadSpec();
const ops = buildManifest(spec);
const { tools, excluded } = applyToolPolicy(ops);
console.log(`total ops: ${ops.length}, included: ${tools.length}, excluded: ${excluded.length}`);
for (const op of tools) console.log('  +', toolName(op.operationId));
for (const e of excluded) console.log('  -', toolName(e.op.operationId), e.reason);
