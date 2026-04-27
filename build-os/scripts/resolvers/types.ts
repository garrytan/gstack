export interface BuildContext {
  skillName: string;
  tmplPath: string;
  skillDir: string;
  preambleTier: number;
}

export type ResolverFn = (ctx: BuildContext, args?: string[]) => string;
