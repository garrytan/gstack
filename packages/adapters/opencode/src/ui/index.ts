import type { UIAdapterModule } from '../types';
import { parseOpenCodeStdoutLine } from './parse-stdout';
import { OpenCodeConfigFields } from './config-fields';
import { buildOpenCodeConfig } from './build-config';

export const opencodeUIAdapter: UIAdapterModule = {
  type: 'opencode',
  label: 'OpenCode',
  parseStdoutLine: parseOpenCodeStdoutLine,
  ConfigFields: OpenCodeConfigFields,
  buildAdapterConfig: buildOpenCodeConfig,
};