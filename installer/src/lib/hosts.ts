export type HostId =
  | "claude"
  | "codex"
  | "factory"
  | "opencode"
  | "kiro";

export interface HostMeta {
  id: HostId;
  label: string;
  detectCmd: string;
  skillsDir: string;
  description: string;
}

export const HOSTS: HostMeta[] = [
  {
    id: "claude",
    label: "Claude Code",
    detectCmd: "claude",
    skillsDir: "~/.claude/skills",
    description: "Anthropic's official CLI (primary host)",
  },
  {
    id: "codex",
    label: "Codex",
    detectCmd: "codex",
    skillsDir: "~/.codex/skills",
    description: "OpenAI Codex CLI",
  },
  {
    id: "factory",
    label: "Factory Droid",
    detectCmd: "droid",
    skillsDir: "~/.factory/skills",
    description: "Factory AI droid",
  },
  {
    id: "opencode",
    label: "OpenCode",
    detectCmd: "opencode",
    skillsDir: "~/.config/opencode/skills",
    description: "SST OpenCode agent",
  },
  {
    id: "kiro",
    label: "Kiro",
    detectCmd: "kiro-cli",
    skillsDir: "~/.kiro/skills",
    description: "Kiro CLI",
  },
];

export function hostById(id: string): HostMeta | undefined {
  return HOSTS.find((h) => h.id === id);
}
