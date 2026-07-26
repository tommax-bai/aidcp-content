import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ApiDirectHttpError,
} from 'aidcp-transport/transport/api-direct-http-common.js';
import {
  InternalHttpClient,
  InternalHttpError,
  InternalHttpServer,
} from 'aidcp-transport/transport/internal-http.js';
import {
  PERSONA_GENERATOR_COMMAND_ROUTES,
  PersonaGeneratorCommandHttpClient,
  registerPersonaGeneratorCommandRoutes,
} from 'aidcp-transport/transport/paired-command-http.js';
import { PersonaGeneratorCommandReceiver } from '../../src/llm/persona-generator-command-receiver.js';

const TOKEN = 'content-command-token';
const INPUT = {
  idempotencyKey: 'persona-http-1',
  accountId: 'account-1',
  keywordSelections: ['护肤'],
};

test('content PersonaGenerator route enforces bearer, version and target before generation', async () => {
  let calls = 0;
  const receiver = new PersonaGeneratorCommandReceiver({
    async generate() {
      calls += 1;
      return {
        ok: true as const,
        soulYaml: 'identity:\n  name: "测试"\n',
        identitySummary: '测试',
      };
    },
  });
  const server = new InternalHttpServer();
  registerPersonaGeneratorCommandRoutes(server, receiver, TOKEN, 'dev');
  const port = await server.listen(0);
  const http = new InternalHttpClient(`http://127.0.0.1:${port}`);
  try {
    await assert.rejects(
      () => new PersonaGeneratorCommandHttpClient(http, 'wrong-token', 'dev').generate(INPUT),
      (error: unknown) =>
        error instanceof ApiDirectHttpError
        && error.code === 'internal_http_unauthorized',
    );
    await assert.rejects(
      () => http.callBearer(
        PERSONA_GENERATOR_COMMAND_ROUTES.generate,
        { version: 2, executionTarget: 'dev', input: INPUT },
        TOKEN,
      ),
      (error: unknown) =>
        error instanceof InternalHttpError
        && error.code === 'api_direct_version_unsupported',
    );
    await assert.rejects(
      () => new PersonaGeneratorCommandHttpClient(http, TOKEN, 'ol').generate(INPUT),
      (error: unknown) =>
        error instanceof ApiDirectHttpError
        && error.code === 'api_direct_target_mismatch',
    );
    assert.equal(calls, 0);

    const client = new PersonaGeneratorCommandHttpClient(http, TOKEN, 'dev');
    assert.equal((await client.generate(INPUT)).outcome, 'applied');
    assert.equal((await client.generate(INPUT)).outcome, 'duplicate');
    assert.equal(calls, 1);
  } finally {
    await server.close();
  }
});

test('post-generation response loss remains result unknown and is not retried', async () => {
  let calls = 0;
  const server = new InternalHttpServer();
  server.registerBearer(
    PERSONA_GENERATOR_COMMAND_ROUTES.generate,
    TOKEN,
    async () => {
      calls += 1;
      throw new InternalHttpError('timeout', 'response lost after generation');
    },
  );
  const port = await server.listen(0);
  try {
    const client = new PersonaGeneratorCommandHttpClient(
      new InternalHttpClient(`http://127.0.0.1:${port}`),
      TOKEN,
      'dev',
    );
    await assert.rejects(
      () => client.generate(INPUT),
      (error: unknown) =>
        error instanceof ApiDirectHttpError
        && error.code === 'persona_generation_result_unknown',
    );
    assert.equal(calls, 1);
  } finally {
    await server.close();
  }
});
