#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import codex from '../hosts/codex';

const ROOT = path.resolve(import.meta.dir, '..');
const GENERATED = path.join(ROOT, '.agents', 'skills');
const OUTPUT = path.join(ROOT, 'runtime', 'codex-runtime-contract.json');
const sha = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex');
const canonical = (value: any): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  : JSON.stringify(value);

function hashPath(absolute: string): string {
  const stat = fs.statSync(absolute);
  if (stat.isFile()) return sha(fs.readFileSync(absolute));
  const rows: string[] = [];
  const walk = (dir: string) => fs.readdirSync(dir).sort().forEach(name => {
    if (name === '.git' || name === 'node_modules') return;
    const child = path.join(dir, name); const rel = path.relative(absolute, child); const childStat = fs.lstatSync(child);
    if (childStat.isDirectory()) { rows.push(`D ${rel}`); walk(child); }
    else if (childStat.isSymbolicLink()) rows.push(`L ${rel} ${fs.readlinkSync(child)}`);
    else rows.push(`F ${rel} ${sha(fs.readFileSync(child))}`);
  });
  walk(absolute); return sha(rows.join('\n'));
}

export function tripwireGeneratedOutput(name: string, content: string, dependencies: any[]) {
  for (const forbidden of [/\/Users\/[A-Za-z0-9._-]+\//, /\/home\/[A-Za-z0-9._-]+\//, /~\/\.claude\/skills\//, /\.claude\/skills\//]) {
    if (forbidden.test(content)) throw new Error(`${name}: forbidden developer/provider path ${forbidden}`);
  }
  if (/\b(?:Read|reading)\s+`?sections\/[A-Za-z0-9_.-]+\.md/i.test(content)) throw new Error(`${name}: mandates rereading an inlined section`);
  const destinations = dependencies.map(edge => edge.destination);
  const observed: string[] = [];
  for (const match of content.matchAll(/\$GSTACK_ROOT\/([A-Za-z0-9_.\/-]+)/g)) {
    if (!match[1].startsWith('.feature-')) observed.push(match[1]);
  }
  for (const match of content.matchAll(/\$GSTACK_BIN\/([A-Za-z0-9_.\/-]+)/g)) observed.push(`bin/${match[1]}`);
  for (const match of content.matchAll(/\$GSTACK_BROWSE\/([A-Za-z0-9_.\/-]+)/g)) observed.push(`browse/dist/${match[1]}`);
  for (const match of content.matchAll(/\$GSTACK_SKILLS_DIR\/(gstack-[A-Za-z0-9_.-]+\/SKILL\.md)/g)) observed.push(match[1]);
  for (const raw of observed) {
    const normalized = raw.replace(/[)`'".,:;]+$/, '');
    if (!destinations.some((destination: string) => normalized === destination || normalized.startsWith(`${destination}/`) || destination.startsWith(`${normalized}/`))) {
      throw new Error(`${name}: lexical tripwire found runtime reference without typed edge '${normalized}'`);
    }
  }
}

export function buildCodexRuntimeContract() {
  const sourceSkills = fs.readdirSync(ROOT, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && fs.existsSync(path.join(ROOT, entry.name, 'SKILL.md.tmpl')) && entry.name !== 'codex')
    .map(entry => entry.name).concat('gstack').sort();
  const runtime = codex.runtimeRoot.contract!;
  const declared = Object.keys(runtime.entrypointRequirements).sort();
  const missing = sourceSkills.filter(name => !declared.includes(name));
  const stale = declared.filter(name => !sourceSkills.includes(name));
  if (missing.length || stale.length) throw new Error(`entrypoint requirement declarations are not total; missing=[${missing}] stale=[${stale}]`);
  const requirementIds = new Set(runtime.requirements.map(item => item.id));
  const inherited = runtime.requirements.filter(item => item.required && !['network-required', 'github-cli', 'browser-runtime', 'openai-image-config'].includes(item.id)).map(item => item.id);
  const entrypoints = sourceSkills.map(sourceSkill => {
    const name = sourceSkill === 'gstack' ? 'gstack' : sourceSkill.startsWith('gstack-') ? sourceSkill : `gstack-${sourceSkill}`;
    const root = path.join(GENERATED, name);
    const skill = path.join(root, 'SKILL.md'); const metadata = path.join(root, 'agents', 'openai.yaml'); const deps = path.join(root, 'runtime-dependencies.json');
    if (![skill, deps].every(fs.existsSync)) throw new Error(`missing generated Codex entrypoint ${name}`);
    const dependencies = JSON.parse(fs.readFileSync(deps, 'utf8')).dependencies;
    tripwireGeneratedOutput(name, fs.readFileSync(skill, 'utf8'), dependencies);
    const explicit = runtime.entrypointRequirements[sourceSkill];
    explicit.forEach(id => { if (!requirementIds.has(id)) throw new Error(`${sourceSkill}: undeclared requirement ${id}`); });
    const content_sha256 = sha(canonical({ skill: sha(fs.readFileSync(skill)), metadata: fs.existsSync(metadata) ? sha(fs.readFileSync(metadata)) : null, dependencies: sha(fs.readFileSync(deps)) }));
    return { name, source_skill: sourceSkill, content_sha256, requirements: { inherited, explicit }, dependencies };
  });
  const assets = runtime.assets.map(asset => {
    const source = path.join(ROOT, asset.source);
    const self = asset.destination === 'runtime/codex-runtime-contract.json';
    return { ...asset, present: self || fs.existsSync(source), content_sha256: self || !fs.existsSync(source) || asset.materializeAtInstall ? null : hashPath(source) };
  });
  const registry = sha(canonical({ schema_version: runtime.schemaVersion, capabilities: runtime.capabilities }));
  const assetDigest = sha(canonical(assets.filter(asset => asset.destination !== 'runtime/codex-runtime-contract.json')));
  const release = sha(canonical({ contract_version: runtime.contractVersion, registry_digest: registry, asset_digest: assetDigest, requirements: runtime.requirements, entrypoints }));
  return { schema_version: runtime.schemaVersion, contract_version: runtime.contractVersion, capabilities: runtime.capabilities, requirements: runtime.requirements, assets, entrypoints, identifiers: { capability_registry_digest: registry, runtime_asset_digest: assetDigest, release_artifact_digest: release } };
}

export function writeCodexRuntimeContract() {
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, `${JSON.stringify(buildCodexRuntimeContract(), null, 2)}\n`);
}

if (import.meta.main) {
  const command = process.argv[2] || 'generate';
  const next = `${JSON.stringify(buildCodexRuntimeContract(), null, 2)}\n`;
  if (command === 'check') process.exit(fs.existsSync(OUTPUT) && fs.readFileSync(OUTPUT, 'utf8') === next ? 0 : 1);
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true }); fs.writeFileSync(OUTPUT, next);
}
