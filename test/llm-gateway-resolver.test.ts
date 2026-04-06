import { describe, test, expect } from 'bun:test';
import { generateLlmGatewayContext } from '../scripts/resolvers/llm-gateway';
import type { TemplateContext, HostPaths } from '../scripts/resolvers/types';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');

// Known llm-cli-gateway MCP tool names (from src/index.ts tool registrations)
const KNOWN_GATEWAY_TOOLS = [
  'claude_request', 'claude_request_async',
  'codex_request', 'codex_request_async',
  'gemini_request', 'gemini_request_async',
  'llm_job_status', 'llm_job_result', 'llm_job_cancel',
  'session_create', 'session_list', 'session_get', 'session_set_active', 'session_delete', 'session_clear_all',
  'list_models', 'approval_list', 'llm_process_health',
];

const VALID_CLI_VALUES = ['claude', 'codex', 'gemini'];

const claudePaths: HostPaths = {
  skillRoot: '~/.claude/skills/gstack',
  localSkillRoot: '.claude/skills/gstack',
  binDir: '~/.claude/skills/gstack/bin',
  browseDir: '~/.claude/skills/gstack/browse/dist',
  designDir: '~/.claude/skills/gstack/design/dist',
};

function makeCtx(skillName: string, host: string = 'claude'): TemplateContext {
  return {
    skillName,
    tmplPath: path.join(ROOT, skillName, 'SKILL.md.tmpl'),
    host: host as any,
    paths: claudePaths,
    preambleTier: 4,
  };
}

// Load tools.json for schema validation
const toolsJsonPath = path.join(ROOT, 'contrib/add-tool/llm-gateway/tools.json');
const toolsConfig = JSON.parse(fs.readFileSync(toolsJsonPath, 'utf-8'));

describe('tools.json schema validation', () => {
  test('has valid top-level structure', () => {
    expect(toolsConfig.tool).toBe('llm-cli-gateway');
    expect(toolsConfig.mcp_server_name).toBe('llm-cli-gw');
    expect(toolsConfig.detection).toBeDefined();
    expect(toolsConfig.detection.binary).toBe('llm-cli-gateway');
    expect(toolsConfig.detection.min_version).toBe('1.1.0');
    expect(toolsConfig.integrations).toBeDefined();
  });

  test('mcp_server_name is not "llm" (collides with simonw llm tool)', () => {
    expect(toolsConfig.mcp_server_name).not.toBe('llm');
  });

  const integrationNames = Object.keys(toolsConfig.integrations);

  test('has 6 skill integrations', () => {
    expect(integrationNames).toEqual([
      'review', 'investigate', 'plan-eng-review', 'plan-ceo-review', 'ship', 'retro',
    ]);
  });

  for (const [skillName, integration] of Object.entries(toolsConfig.integrations) as [string, any][]) {
    describe(`integration: ${skillName}`, () => {
      test('has required fields', () => {
        expect(integration.phase).toBeTruthy();
        expect(integration.context).toBeTruthy();
        expect(Array.isArray(integration.tools)).toBe(true);
        expect(integration.tools.length).toBeGreaterThan(0);
      });

      for (const tool of integration.tools) {
        test(`tool "${tool.tool}" is a known llm-cli-gateway MCP tool`, () => {
          expect(KNOWN_GATEWAY_TOOLS).toContain(tool.tool);
        });

        test(`tool "${tool.tool}" has a when description`, () => {
          expect(tool.when).toBeTruthy();
          expect(tool.when.length).toBeGreaterThan(10);
        });

        if (tool.requires_cli) {
          test(`tool "${tool.tool}" requires_cli is a valid CLI name`, () => {
            expect(VALID_CLI_VALUES).toContain(tool.requires_cli);
          });
        }
      }
    });
  }
});

describe('LLM_GATEWAY_CONTEXT resolver', () => {
  const integratedSkills = Object.keys(toolsConfig.integrations);

  for (const skillName of integratedSkills) {
    test(`${skillName}: returns non-empty output`, () => {
      const result = generateLlmGatewayContext(makeCtx(skillName));
      expect(result.length).toBeGreaterThan(0);
    });

    test(`${skillName}: contains mcp__llm-cli-gw__ prefix`, () => {
      const result = generateLlmGatewayContext(makeCtx(skillName));
      expect(result).toContain('mcp__llm-cli-gw__');
    });

    test(`${skillName}: contains CLI availability gating`, () => {
      const result = generateLlmGatewayContext(makeCtx(skillName));
      expect(result).toContain('LLM_GATEWAY: unavailable');
      expect(result).toContain('LLM_GATEWAY: available');
    });

    test(`${skillName}: contains cross-model synthesis instruction`, () => {
      const result = generateLlmGatewayContext(makeCtx(skillName));
      expect(result).toContain('which models contributed');
      expect(result).toContain('agree vs. diverge');
    });

    test(`${skillName}: uses context from tools.json`, () => {
      const result = generateLlmGatewayContext(makeCtx(skillName));
      const expectedContext = toolsConfig.integrations[skillName].context;
      expect(result).toContain(expectedContext);
    });
  }

  test('returns empty string for unknown skills', () => {
    expect(generateLlmGatewayContext(makeCtx('browse'))).toBe('');
    expect(generateLlmGatewayContext(makeCtx('qa'))).toBe('');
    expect(generateLlmGatewayContext(makeCtx('design-review'))).toBe('');
    expect(generateLlmGatewayContext(makeCtx('nonexistent-skill'))).toBe('');
  });

  test('codex host suppresses codex-specific tools', () => {
    const result = generateLlmGatewayContext(makeCtx('review', 'codex'));
    expect(result).not.toContain('codex_request_async');
    expect(result).toContain('gemini_request_async');
  });

  test('codex host still produces output when gemini tools exist', () => {
    const result = generateLlmGatewayContext(makeCtx('review', 'codex'));
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain('Multi-LLM Orchestration');
  });

  test('host filtering is generalized — any host suppresses its own CLI tools', () => {
    // If gemini were a host, it should suppress gemini tools
    const geminiResult = generateLlmGatewayContext(makeCtx('review', 'gemini'));
    expect(geminiResult).not.toContain('gemini_request_async');
    expect(geminiResult).toContain('codex_request_async');
  });

  test('async tools in tool list only for review and ship', () => {
    for (const skillName of integratedSkills) {
      const tools = toolsConfig.integrations[skillName].tools as any[];
      const hasAsyncTools = tools.some((t: any) => t.tool.endsWith('_async'));
      if (skillName === 'review' || skillName === 'ship') {
        expect(hasAsyncTools).toBe(true);
      } else {
        expect(hasAsyncTools).toBe(false);
      }
    }
  });
});

describe('generated SKILL.md files contain gateway content', () => {
  const integratedSkills = ['review', 'investigate', 'plan-eng-review', 'plan-ceo-review', 'ship', 'retro'];

  for (const skill of integratedSkills) {
    test(`${skill}/SKILL.md contains Multi-LLM Orchestration section`, () => {
      const content = fs.readFileSync(path.join(ROOT, skill, 'SKILL.md'), 'utf-8');
      expect(content).toContain('## Multi-LLM Orchestration (llm-cli-gateway)');
      expect(content).toContain('mcp__llm-cli-gw__');
    });

    test(`${skill}/SKILL.md has no unresolved {{LLM_GATEWAY_CONTEXT}} placeholder`, () => {
      const content = fs.readFileSync(path.join(ROOT, skill, 'SKILL.md'), 'utf-8');
      expect(content).not.toContain('{{LLM_GATEWAY_CONTEXT}}');
    });
  }

  test('non-integrated skills have no gateway content', () => {
    const nonIntegrated = ['browse', 'qa', 'design-review', 'office-hours', 'codex'];
    for (const skill of nonIntegrated) {
      const skillPath = path.join(ROOT, skill, 'SKILL.md');
      if (fs.existsSync(skillPath)) {
        const content = fs.readFileSync(skillPath, 'utf-8');
        expect(content).not.toContain('Multi-LLM Orchestration');
        expect(content).not.toContain('mcp__llm-cli-gw__');
      }
    }
  });
});

describe('preamble detection block', () => {
  test('preamble.ts contains llm-cli-gateway detection', () => {
    const preamble = fs.readFileSync(path.join(ROOT, 'scripts/resolvers/preamble.ts'), 'utf-8');
    expect(preamble).toContain('llm-cli-gateway');
    expect(preamble).toContain('LLM_GATEWAY');
    expect(preamble).toContain('LLM_GW_CLAUDE');
    expect(preamble).toContain('LLM_GW_CODEX');
    expect(preamble).toContain('LLM_GW_GEMINI');
  });

  test('generated SKILL.md preamble contains gateway detection output', () => {
    const content = fs.readFileSync(path.join(ROOT, 'review/SKILL.md'), 'utf-8');
    expect(content).toContain('LLM_GATEWAY:');
    expect(content).toContain('LLM_GW_CLAUDE:');
  });
});
