import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..', '..');

// Same generated two-line pointer consumed by setup-gbrain-fixture.ts.
const STOP_POINTER =
  /^> \*\*STOP\.\*\* Before [^\n]*sections\/([a-z0-9-]+\.md)[^\n]*\n> in full\.[^\n]*/gm;

/** Expand on-demand sections where the agent reads them, then take the requested excerpt. */
export function readWorkflowExcerpt(skillPath: string, startMarker: string, endMarker: string | null): string {
  const secDir = path.join(ROOT, path.dirname(skillPath), 'sections');
  const content = fs.readFileSync(path.join(ROOT, skillPath), 'utf-8').replace(STOP_POINTER, (_pointer, file: string) => {
    const body = fs.readFileSync(path.join(secDir, file), 'utf-8')
      .replace(/^<!--[^\n]*-->\n/gm, '').trim();
    if (body.length < 200) throw new Error(`${skillPath}: section ${file} is empty/stub`);
    return body;
  });
  const start = content.indexOf(startMarker);
  if (start < 0) throw new Error(`Start marker not found in ${skillPath}: "${startMarker}"`);
  const end = endMarker ? content.indexOf(endMarker, start) : content.length;
  if (end < 0) throw new Error(`End marker not found in ${skillPath}: "${endMarker}"`);
  return content.slice(start, end);
}
