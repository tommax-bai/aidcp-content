// aidcp:test-owner=derived
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

async function serverSource(): Promise<string> {
  return readFile(new URL('../../src/server.ts', import.meta.url), 'utf8');
}

test('content root owns PersonaGenerator and registers the target-bound authenticated command', async () => {
  const source = await serverSource();
  assert.match(source, /new PersonaGeneratorCommandReceiver\(\s*new PersonaGenerator\(\{/);
  assert.match(source, /soulCodec:\s*PERSONA_SOUL_CODEC/);
  assert.match(source, /requireContentInternalToken\(\)/);
  assert.match(
    source,
    /registerPersonaGeneratorCommandRoutes\(\s*httpServer,\s*personaGeneratorAuthority,\s*contentInternalToken,\s*deploymentTarget,\s*\)/,
  );
  assert.doesNotMatch(source, /from ['"]\.\/soul\//);
});

test('curated content absence cannot disable persona or publish capabilities', async () => {
  const source = await serverSource();
  const personaRegistration = source.indexOf('registerPersonaGeneratorCommandRoutes(');
  const curatedGuard = source.indexOf('if (curatedContentStore) {', personaRegistration);
  const publishStatusRegistration = source.indexOf(
    'registerPublishStatusRoutes(httpServer',
    curatedGuard,
  );
  assert.ok(personaRegistration >= 0);
  assert.ok(curatedGuard > personaRegistration);
  assert.ok(publishStatusRegistration > curatedGuard);

  const curatedBlock = source.slice(curatedGuard, publishStatusRegistration);
  assert.doesNotMatch(curatedBlock, /\breturn\b/);
});
