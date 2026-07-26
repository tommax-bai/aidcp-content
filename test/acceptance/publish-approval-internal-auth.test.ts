// aidcp:test-owner=derived
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

async function serverSource(): Promise<string> {
  return readFile(new URL('../../src/server.ts', import.meta.url), 'utf8');
}

function between(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `missing source markers: ${startMarker}`);
  return source.slice(start, end);
}

test('content approval writer requires one explicit token with no fallback or log exposure', async () => {
  const source = await serverSource();
  const requireToken = between(
    source,
    'function requirePublishApprovalInternalToken()',
    'async function main()',
  );
  assert.match(
    requireToken,
    /const envName = 'AIDCP_PUBLISH_APPROVAL_INTERNAL_TOKEN'/,
  );
  assert.match(requireToken, /const token = readEnvString\(envName\)/);
  assert.match(requireToken, /if \(!token \|\| \/\\s\/\.test\(token\)\)/);
  assert.match(requireToken, /throw new Error\(/);
  assert.doesNotMatch(
    requireToken,
    /readEnvString\(envName\)\s*(?:\?\?|\|\|)/,
    'token must not fall back to another env value or default',
  );
  assert.doesNotMatch(requireToken, /console\.(?:log|warn|error)/);

  const main = between(source, 'async function main()', '\nmain().catch(');
  const tokenRead = main.indexOf(
    'const publishApprovalInternalToken = requirePublishApprovalInternalToken();',
  );
  assert.ok(tokenRead >= 0);
  assert.ok(
    tokenRead < main.indexOf('await runSchemaContractGate('),
    'missing token must reject startup before storage/schema initialization',
  );
  assert.match(
    main,
    /new PublishCardExitHttpClient\(\s*apiHttp,\s*publishApprovalInternalToken,\s*\)/,
  );
  assert.doesNotMatch(
    main,
    /console\.(?:log|warn|error)\([\s\S]{0,160}publishApprovalInternalToken/,
  );
});
