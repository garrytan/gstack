import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runBashScript } from './helpers/bash-script';

// Value: protects=doctor JSON keeps its exact escaping contract while using no per-field subprocesses;
//   fails_when=quotes/backslashes/control bytes make malformed JSON or Unicode/newline details change
test('doctor JSON string encoding preserves controls, Unicode and terminal-newline behavior', () => {
  const source = fs.readFileSync(path.resolve(import.meta.dir, '../bin/gstack-doctor-check.sh'), 'utf8');
  const fn = /^_dc_json_str\(\) \{[\s\S]*?^\}/m.exec(source)![0];
  const vectors = ['', 'hello', '"quoted"', 'C:\\Users\\fixture\\a', 'tabs\there', '\n', 'a\n', 'a\n\n', '\na\n',
    '\r\n', 'line1\nline2', 'emoji 😀 café', '\\"\t\n', Array.from({ length: 31 }, (_, i) => String.fromCharCode(i + 1)).join('')];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-json-'));
  try {
    const input = path.join(dir, 'vectors'); fs.writeFileSync(input, vectors.join('\0') + '\0');
    const result = runBashScript(fn + '\nwhile IFS= read -r -d "" text; do _dc_json_str "$text"; printf "\\n"; done < "$DOCTOR_JSON_VECTORS"',
      { env: { ...process.env, DOCTOR_JSON_VECTORS: input.replaceAll('\\', '/') }, timeout: 10_000 });
    expect(result.status, result.stderr).toBe(0);
    const values = result.stdout.trimEnd().split('\n').map(line => JSON.parse(line));
    expect(values).toEqual(['', 'hello', '"quoted"', 'C:\\Users\\fixture\\a', 'tabs\there', '', 'a', 'a\n', '\na',
      '', 'line1\nline2', 'emoji 😀 café', '\\"\t', '\t']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
