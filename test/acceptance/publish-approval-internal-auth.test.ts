// aidcp:test-owner=derived
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

async function serverSource(): Promise<string> {
  return readFile(new URL('../../src/server.ts', import.meta.url), 'utf8');
}

async function entrySource(): Promise<string> {
  return readFile(new URL('../../src/content-service-entry.ts', import.meta.url), 'utf8');
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
    'export interface ContentStartupCapability',
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

  const main = source.slice(source.indexOf('export async function startContentService('));
  assert.ok(main.length > 0, 'missing source markers: startContentService');
  const tokenRead = main.indexOf(
    'const publishApprovalInternalToken = requirePublishApprovalInternalToken();',
  );
  assert.ok(tokenRead >= 0);
  assert.ok(
    tokenRead < main.indexOf('new pg.Pool('),
    'missing token must reject startup before any storage is initialized',
  );

  // schema 契约门本身已挪到可执行入口（本进程的 main）。这条断言跟着挪：
  // 门 MUST 跑在装配之前——顺序倒过来等于先连上一个落后的库，再由某个存储在某次调用上炸掉。
  const entry = await entrySource();
  const gate = entry.indexOf('await runContentStartupSchemaGate(');
  const start = entry.indexOf('await startContentService(');
  assert.ok(gate >= 0 && start > gate, 'schema gate must run before the composition root is built');
  assert.doesNotMatch(
    entry.slice(gate - 200, gate),
    /try\s*{[^}]*$/,
    'schema gate must not be swallowed by try/catch',
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
