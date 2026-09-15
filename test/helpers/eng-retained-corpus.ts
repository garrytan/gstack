/** A recorded legacy oracle can survive removal of the implementation it sampled. */
export function hasRetainedLegacyCorpus(
  current: ReadonlyArray<{ title: string; body: string[] }>, snapshot: string,
): boolean {
  const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
  const quoted = (s: string) => s.replace(/"[^"\n]*"|“[^”\n]*”|(?<![\w])'[^'\n]*'(?![\w])|‘[^’\n]*’/g, '');
  const source = (s: string) => /(?:^|\n)\s*(?:source(?: excerpt| material)?|quoted(?: source)?|historical(?: example| assessment)?|if approved|once approved|when approved|pending approval|assuming approval|provided approval)\s*[,.:—-]/i.test(quoted(s));
  const status = '(?:withdrawn|rejected|declined|cancelled|canceled|superseded|deferred|optional|proposed|not current|no longer current|not required|no longer required|conditional on approval)';
  const owner = '(?:(?:this|the) (?:(?:legacy|recorded|baseline) )?(?:(?:regression|parity) )?(?:suite|test|requirement|verification|oracle|corpus))';
  const scalar = (s: string, id: string) => quoted(s.replace(new RegExp(
    `((?:^|[.!?;]\\s+|\\n)\\s*(?:Correction:\\s*)?(?:${id}(?: verification)?|${owner}) (?:is|are|was|were|has been|have been) )["“'‘](${status})["”'’]`, 'gim'), '$1$2'));
  const inactive = (s: string, id: string) => source(s) || new RegExp(
    `\\b(?:${id}(?: verification)?|${owner}) (?:is|are|was|were|has been|have been) ${status}\\b|\\b(?:only if|unless|pending) (?:user )?approv`, 'i').test(scalar(s, id));
  const negated = (s: string) => /\b(?:do not|don't|never|skip|omit|defer|cancel) (?:add|write|implement|record|capture|pin|run|assert|retain|keep)\b/i.test(quoted(s));
  const owned = (s: string) => !source(s) && !negated(s) && snapshot.includes(flat(s));

  for (const declaration of current) {
    if (!/^CRITICAL regression test \([^)]*\bmandatory\b[^)]*\)$/i.test(declaration.title)
        || /\b(?:not|never|no longer) mandatory\b/i.test(declaration.title)) continue;
    const body = declaration.body.join('\n').trim();
    const add = /^Add ([A-Za-z][\w/.-]*\.test\.[jt]s):$/m.exec(body);
    if (!add || !owned(body) || inactive(body, 'T[1-9]\\d*')) continue;
    const bullets = body.split(/\n(?=- )/).slice(1).map(flat);
    const capture = bullets.findIndex(s => /^- (?:Record|Capture|Pin) a corpus of .+ with the legacy decision for each\.$/i.test(s));
    const parity = bullets.findIndex(s => /^- Run the (?:same )?corpus through the new [A-Za-z][\w]* path and assert identical allow\/deny and reason code for every entry\.$/i.test(s));
    if (capture < 0 || parity <= capture || !bullets.some(s => /^- This test is also the shadow-mode oracle; it stays after legacy deletion, re-pointed at the recorded decisions\.$/i.test(s))) continue;
    // Retention makes the old behavior the oracle. Building independent new
    // modules before recording it does not itself rewrite that old behavior.
    const retention = current.filter(s => s.title === 'What already exists').flatMap(s => s.body.join('\n').split(/\n(?=- )/))
      .find(s => /^- legacyAuthFlow\(\): retained behind the per-tenant flag as the shadow oracle and regression baseline until deletion\.$/i.test(flat(s)) && owned(s) && !inactive(s, 'T[1-9]\\d*'));
    if (!retention) continue;
    for (const section of current.filter(s => s.title === 'Implementation Tasks')) {
      const taskBody = section.body.join('\n').trim();
      const tasks = taskBody.split(/\n(?=- )/);
      const rows = tasks.map(body => ({ body, match: /^- (?:\[[ xX]\] )?(T[1-9]\d*)(?: \([^\n)]*\))? [—–-] (.+)(?:\n|$)/.exec(body) })).filter(row => row.match);
      if (rows.length !== new Set(rows.map(row => row.match![1])).size) continue;
      for (const row of rows) {
        const id = row.match![1]!, title = row.match![2]!;
        const action = row.body.replace(/^  - Surfaced by:.*$/gm, '');
        const preceding = taskBody.slice(0, taskBody.indexOf(row.body)).trim().split('\n').at(-1) ?? '';
        const files = [...row.body.matchAll(/^  - Files: ([^\n]+)$/gm)];
        const verifies = [...row.body.matchAll(/^  - Verify: ([^\n]+)$/gm)];
        if (!/^[A-Za-z][\w -]* [—–-] CRITICAL: recorded-corpus parity test legacy vs [A-Za-z][\w]*$/i.test(title)
            || files.length !== 1 || verifies.length !== 1 || !snapshot.includes(flat(row.body)) || source(action) || negated(action) || source(preceding)
            || inactive(action, id) || !files[0]![1]!.split(',').map(s => s.trim()).includes(add[1]!)) continue;
        if (!/^100% decision \+ reason-code parity across the corpus$/i.test(verifies[0]![1]!)) continue;
        const cancelled = current.some(s => {
          if (/\b(?:history|historical|source|quoted|example)\b/i.test(s.title)) return false;
          const raw = s.body.join('\n'), value = scalar(raw, id);
          const named = /^(.*?)\b(?:regression|characterization|parity)\s+(?:suite|test)/i.exec(s.title)?.[1]?.trim();
          const foreign = Boolean(named && !/^(?:(?:critical|recorded|required|current|final|updated)\s*)*(?:legacy(?:AuthFlow\(\))?)?[\s:—-]*$/i.test(named));
          if (new RegExp(`^\\s*\\|\\s*${id}\\s*\\|\\s*["“'‘]?${status}["”'’]?\\s*\\|`, 'im').test(raw)) return true;
          return value.split(/\n|[.!?;]\s+/).some(line => {
            if (source(line) || /^\s*(?:if|unless|assuming|provided)\b/i.test(line)) return false;
            if (foreign && !new RegExp(`\\b${id}\\b|legacyAuthFlow|\\blegacy (?:regression|parity) (?:suite|test|corpus|baseline)\\b`, 'i').test(line)) return false;
            return inactive(line, id) || new RegExp(`^\\s*(?:Correction:\\s*)?legacyAuthFlow\\(\\) (?:is|was|has been|will be) (?:modified|changed|rewritten|refactored|removed|deleted) before ${id}\\b`, 'i').test(line)
              || /^\s*(?:Correction:\s*)?legacyAuthFlow\(\) (?:is|was|has been|will be) (?:modified|changed|rewritten|refactored|removed|deleted) before (?:the )?(?:(?:legacy|recorded|regression) )?(?:corpus|baseline)(?: is)? (?:recorded|captured|pinned)\b/i.test(line)
              || /^\s*(?:the|this) (?:(?:legacy|regression) )?(?:corpus|baseline) is (?:recorded|captured|pinned) (?:only )?after legacyAuthFlow\(\) is (?:modified|changed|rewritten|refactored|removed|deleted)\b/i.test(line)
              || /\b(?:the|this) legacy (?:regression baseline|shadow oracle) (?:is|was|has been) (?:changed|rewritten|removed|deleted|replaced)\b/i.test(line);
          });
        });
        if (!cancelled) return true;
      }
    }
  }
  return false;
}
