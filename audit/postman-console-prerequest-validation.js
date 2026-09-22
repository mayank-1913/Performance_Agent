'use strict';

/**
 * Validates Console Mediasmart collection pre-request date flow is translated.
 */

const fs = require('fs');
const path = require('path');
const { parse } = require('../apps/api/src/lib/postman/parser');
const { generateK6Script } = require('../apps/api/src/lib/k6/generator');
const { buildAuthFlow } = require('../apps/api/src/lib/postman/authFlow');
const { analyzePrerequestScript } = require('../apps/api/src/lib/postman/prerequestCodegen');
const { scanCompatibility } = require('../apps/api/src/lib/postman/compatibility');

const CONSOLE_COLLECTION = path.join(
  __dirname,
  '../apps/api/storage/uploads/1790073175067_e5c4e3d5-33f8-4cac-86b1-09b8ef38de44_Console_API_Monitoring_Mediasmart_postman_collection.json'
);

function findItem(items, name) {
  for (const it of items || []) {
    if (it.name === name && it.request) return it;
    if (it.item) {
      const f = findItem(it.item, name);
      if (f) return f;
    }
  }
  return null;
}

function main() {
  const raw = JSON.parse(fs.readFileSync(CONSOLE_COLLECTION, 'utf8'));
  const parsed = parse(raw);
  const item = findItem(raw.item, 'createCampaign');
  if (!item) throw new Error('createCampaign not found');

  const prerequest = (item.event || [])
    .filter((e) => e.listen === 'prerequest')
    .flatMap((e) => e.script?.exec || [])
    .join('\n');

  const analysis = analyzePrerequestScript(prerequest);
  const flow = buildAuthFlow(parsed);
  const code = generateK6Script(parsed, { authFlow: flow });
  const compat = scanCompatibility({ rawCollection: raw, parsed });

  const createGroup = code.match(/group\(`[^`]*createCampaign`[\s\S]*?\n  \}\);/i);
  const bodyHasLiteralPlaceholder =
    createGroup && /\{\{started_at\}\}|\{\{finished_at\}\}/.test(createGroup[0]);

  const result = {
    prerequestTranslatable: analysis.translatable,
    prerequestSets: analysis.setsEnvironment,
    generatedHasPmSet: /__pmSet\(state, 'environment', "started_at"/.test(code),
    generatedHasPmSetFinished: /__pmSet\(state, 'environment', "finished_at"/.test(code),
    bodyHasLiteralPlaceholder,
    blockingCompatWarnings: compat.warnings.filter((w) => w.severity === 'blocking').length,
  };

  const out = path.join(__dirname, 'postman-console-prerequest-validation.json');
  fs.writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  console.log('Wrote', out);

  if (!analysis.translatable || bodyHasLiteralPlaceholder) process.exit(1);
}

main();
