import { parseOfficialSource, type SourceId } from './model-policy-freshness-sources';

self.onmessage = (event: MessageEvent<{ id: SourceId; text: string }>) => {
  try { self.postMessage({ ok: true, parsed: parseOfficialSource(event.data.id, event.data.text) }); }
  catch (error) { self.postMessage({ ok: false, error: error instanceof Error ? error.message : 'parser-unavailable' }); }
};
