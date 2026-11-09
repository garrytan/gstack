/**
 * The <gstack-qid:...> marker a skill puts in an asked question (#3442).
 *
 * `<gstack-qid:{id}>` names the question; an unregistered id may add a
 * signal hint, `<gstack-qid:{id};signal={signal_key}>`, naming the
 * SIGNAL_MAP key its answer speaks to. Ids and keys are read lowercase.
 * A malformed hint (an underscore, a space, an empty or unknown key name)
 * is dropped on its own; the id still names the question. Whether a hint
 * is a real SIGNAL_MAP key is checked where the row is logged
 * (bin/gstack-question-log), not here.
 */
export const QID_MARKER_RE = /<gstack-qid:([a-z0-9-]{1,64})(?:;([^<>\n]{0,128}))?>/i;

const SIGNAL_HINT_RE = /^signal=([a-z0-9-]{1,64})$/i;

export interface QidMarker {
  id: string;
  signal_key?: string;
  stripped: string;
}

export function parseQidMarker(text: string): QidMarker | undefined {
  const m = QID_MARKER_RE.exec(text);
  if (!m) return undefined;
  const hint = m[2] === undefined ? undefined : SIGNAL_HINT_RE.exec(m[2])?.[1];
  return {
    id: m[1]!.toLowerCase(),
    ...(hint ? { signal_key: hint.toLowerCase() } : {}),
    stripped: text.replace(QID_MARKER_RE, '').trim(),
  };
}
