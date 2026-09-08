import { stripVTControlCharacters } from 'node:util';

/** Select the explicit affirmative entry in a fully rendered startup menu. */
export function trustDialogInput(visible: string): string | null {
  const clean = stripVTControlCharacters(visible);
  const headers = [...clean.matchAll(/Accessing\s*workspace:|Do\s*you\s*trust\s*(?:the\s*files\s*in\s*)?this\s*folder\?|Trust\s*this\s*folder\?/gi)];
  const header = headers.at(-1);
  if (!header) return null;
  const dialog = clean.slice(header.index);

  type Option = { selected: boolean; affirmative: boolean };
  const options: Option[] = [];
  for (const line of dialog.split(/[\r\n]+/)) {
    const match = line.replace(/\s+/g, '').match(
      /^(❯)?(?:\d+[.)])?(Yes(?:,Itrustthisfolder|,andalwaysallowaccessto.+)?|No(?:,exit)?)(?:\(Recommended\))?$/i,
    );
    if (match) options.push({ selected: !!match[1], affirmative: /^Yes/i.test(match[2]!) });
  }

  // Cursor-positioning escapes can collapse the two current menu rows into
  // one logical line. Their complete labels still identify both choices.
  if (options.length < 2) {
    options.length = 0;
    for (const match of dialog.replace(/\s+/g, '').matchAll(/(❯)?(?:\d+[.)])?(Yes,Itrustthisfolder|No,exit)/gi)) {
      options.push({ selected: !!match[1], affirmative: /^Yes/i.test(match[2]!) });
    }
  }

  const target = options.findIndex((option) => option.affirmative);
  const selected = options.findIndex((option) => option.selected);
  // Wait for both choices and a single cursor. An incomplete or unfamiliar
  // frame must never turn a guessed default into an implicit rejection.
  if (target < 0 || selected < 0 || !options.some((option) => !option.affirmative) ||
      options.filter((option) => option.selected).length !== 1) return null;
  const distance = target - selected;
  return (distance < 0 ? '\x1b[A' : '\x1b[B').repeat(Math.abs(distance)) + '\r';
}
