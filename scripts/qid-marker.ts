/**
 * The <gstack-qid:...> marker a skill puts in an asked question (#3442).
 *
 * `<gstack-qid:{id}>` names the question; an unregistered id may add a
 * signal hint, `<gstack-qid:{id};signal={signal_key}>`, naming the
 * SIGNAL_MAP key its answer speaks to. Ids and keys are read lowercase.
 * Whether a hint is a real SIGNAL_MAP key is checked where the row is
 * logged (bin/gstack-question-log), not here.
 */
export const QID_MARKER_RE = /<gstack-qid:([a-z0-9-]{1,64})(?:;signal=([a-z0-9-]{1,64}))?>/i;

export interface QidMarker {
  id: string;
  signal_key?: string;
  stripped: string;
}

export function parseQidMarker(text: string): QidMarker | undefined {
  const m = QID_MARKER_RE.exec(text);
  if (!m) return undefined;
  return {
    id: m[1]!.toLowerCase(),
    ...(m[2] ? { signal_key: m[2].toLowerCase() } : {}),
    stripped: text.replace(QID_MARKER_RE, '').trim(),
  };
}
