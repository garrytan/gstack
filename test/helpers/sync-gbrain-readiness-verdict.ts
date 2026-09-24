export function readinessVerdictProblems(kind: 'ready' | 'unknown', output: string): string[] {
  const problems: string[] = [];
  if (kind === 'ready') {
    const capability = [...output.matchAll(/^\s*Capability[\s.:-]+(OK|FIX|WARN|ERR)\b[^\r\n]*/gim)];
    if (capability.length !== 1 || capability[0]![1]?.toUpperCase() !== 'OK' || !/\bsource-scoped page read verified\b/i.test(capability[0]![0]))
      problems.push('ready result lacks verified source-scoped Capability OK');
    const overallStatuses = [...output.matchAll(/\b(?:gbrain\s+status|verdict)\s*:\s*(GREEN|YELLOW|RED)\b/gi)].map((match) => match[1].toUpperCase());
    if (overallStatuses.includes('GREEN'))
      problems.push('ready result claims GREEN with unavailable rows');
    if (overallStatuses.includes('RED'))
      problems.push('ready result has conflicting overall verdict');
    if (!overallStatuses.includes('YELLOW'))
      problems.push('ready result lacks YELLOW overall verdict');
  } else {
    if (!/unknown|unverified|retry|could not verify/i.test(output)) problems.push('unknown status not reported');
    if (!/\bCapability\s*[.: ]+\s*WARN\b|\b(?:gbrain\s+status|verdict)\s*:\s*YELLOW\b/i.test(output))
      problems.push('unknown result lacks WARN/YELLOW verdict');
    if (/\b(?:gbrain\s+status|verdict)\s*:\s*GREEN\b|\bCapability\s*[.: ]+\s*OK\b/i.test(output))
      problems.push('unknown result claims GREEN or capability OK');
  }
  for (const claim of output.matchAll(/\b(?:semantic search|writes?|write readiness|write availability)[^.!?\n]{0,60}\b(?:ready|verified|proven|confirmed|working)\b/gi)) {
    if (!/\b(?:not|never|without|unknown|unverified)\b/i.test(claim[0]))
      problems.push('read-only check claims semantic search or write readiness');
  }
  return problems;
}
