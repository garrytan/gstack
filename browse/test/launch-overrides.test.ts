import { describe, test, expect } from 'bun:test';
import { parseExtraChromiumArgs, parseHttpCredentials } from '../src/launch-overrides';

const EMPTY_ENV = {} as NodeJS.ProcessEnv;

describe('parseExtraChromiumArgs', () => {
  test('unset → []', () => {
    expect(parseExtraChromiumArgs(EMPTY_ENV)).toEqual([]);
  });

  test('blank/whitespace → []', () => {
    expect(parseExtraChromiumArgs({ GSTACK_CHROMIUM_ARGS: '   ' } as NodeJS.ProcessEnv)).toEqual([]);
  });

  test('JSON array of strings → verbatim', () => {
    expect(
      parseExtraChromiumArgs({
        GSTACK_CHROMIUM_ARGS: '["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"]',
      } as NodeJS.ProcessEnv),
    ).toEqual(['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']);
  });

  test('whitespace-separated string → split into flags', () => {
    expect(
      parseExtraChromiumArgs({
        GSTACK_CHROMIUM_ARGS: '--flag-a   --flag-b\t--flag-c',
      } as NodeJS.ProcessEnv),
    ).toEqual(['--flag-a', '--flag-b', '--flag-c']);
  });

  test('single flag → one-element array', () => {
    expect(
      parseExtraChromiumArgs({ GSTACK_CHROMIUM_ARGS: '--mute-audio' } as NodeJS.ProcessEnv),
    ).toEqual(['--mute-audio']);
  });

  test('JSON array drops empty entries', () => {
    expect(
      parseExtraChromiumArgs({ GSTACK_CHROMIUM_ARGS: '["--a", "", "  "]' } as NodeJS.ProcessEnv),
    ).toEqual(['--a']);
  });

  test('non-array JSON (object) → treated as whitespace string', () => {
    // '{"a":1}' is valid JSON but not a string array, so it falls through to
    // whitespace splitting and yields one token.
    expect(
      parseExtraChromiumArgs({ GSTACK_CHROMIUM_ARGS: '{"a":1}' } as NodeJS.ProcessEnv),
    ).toEqual(['{"a":1}']);
  });
});

describe('parseHttpCredentials', () => {
  test('unset → undefined', () => {
    expect(parseHttpCredentials(EMPTY_ENV)).toBeUndefined();
  });

  test('blank → undefined', () => {
    expect(parseHttpCredentials({ GSTACK_HTTP_CREDENTIALS: '' } as NodeJS.ProcessEnv)).toBeUndefined();
  });

  test('no colon → undefined', () => {
    expect(
      parseHttpCredentials({ GSTACK_HTTP_CREDENTIALS: 'usernopass' } as NodeJS.ProcessEnv),
    ).toBeUndefined();
  });

  test('leading colon (empty user) → undefined', () => {
    expect(
      parseHttpCredentials({ GSTACK_HTTP_CREDENTIALS: ':secret' } as NodeJS.ProcessEnv),
    ).toBeUndefined();
  });

  test('user:pass → split on first colon', () => {
    expect(
      parseHttpCredentials({ GSTACK_HTTP_CREDENTIALS: 'alice:s3cr3t' } as NodeJS.ProcessEnv),
    ).toEqual({ username: 'alice', password: 's3cr3t' });
  });

  test('password may contain colons', () => {
    expect(
      parseHttpCredentials({ GSTACK_HTTP_CREDENTIALS: 'alice:a:b:c' } as NodeJS.ProcessEnv),
    ).toEqual({ username: 'alice', password: 'a:b:c' });
  });
});
