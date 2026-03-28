import type { AdapterConfigFieldsProps } from '@paperclipai/adapter-utils';
// Note: The skill says to use the primitives from `ui/src/components/agent-config-primitives`
// We'll import them from the expected location in the Paperclip monorepo.
import { Field, ToggleField, DraftInput, DraftNumberInput, help } from '@/components/agent-config-primitives';

// We are using an alias `@/` for the Paperclip UI components.
// In the Paperclip monorepo, this alias is set up to point to `ui/src`.
// If you are not in the Paperclip monorepo, you may need to adjust this import.
// However, when the adapter is used in Paperclip, the alias will be valid.

export function OpenCodeConfigFields({ config, eff, set, values }: AdapterConfigFieldsProps) {
  // Determine if we are in edit mode or create mode
  const isEdit = !!config;

  // Helper to get the current value for a field
  const getValue = <T>(key: string): T => {
    if (isEdit) {
      // In edit mode, we read from the config
      return (config as Record<string, unknown>)[key] as T;
    } else {
      // In create mode, we read from the form values
      return (values as Record<string, unknown>)[key] as T;
    }
  };

  // Helper to set a field value
  const setValue = <T>(key: string, value: T) => {
    if (isEdit) {
      // In edit mode, we update the config via the eff function
      eff({ [key]: value });
    } else {
      // In create mode, we update the form values via the set function
      set({ [key]: value });
    }
  };

  return (
    <>
      <Field
        label="Working Directory"
        description="Absolute path to the directory where OpenCode will run"
      >
        <DraftInput
          placeholder="/path/to/project"
          value={getValue<string>('cwd') || ''}
          onChange={(e) => setValue('cwd', e.target.value)}
        />
      </Field>

      <Field
        label="Model"
        description="OpenCode model to use for the agent"
      >
        <DraftInput
          placeholder="claude-3.5-sonnet"
          value={getValue<string>('model') || ''}
          onChange={(e) => setValue('model', e.target.value)}
        />
      </Field>

      <Field
        label="Timeout (seconds)"
        description="Maximum time to wait for each OpenCode invocation"
      >
        <DraftNumberInput
          min={1}
          step={1}
          value={getValue<number>('timeoutSec') ?? 120}
          onChange={(e) => setValue('timeoutSec', parseInt(e.target.value, 10) || 120)}
        />
      </Field>

      <Field
        label="Grace Period (seconds)"
        description="Additional time to allow OpenCode to shut down after timeout"
      >
        <DraftNumberInput
          min={1}
          step={1}
          value={getValue<number>('graceSec') ?? 15}
          onChange={(e) => setValue('graceSec', parseInt(e.target.value, 10) || 15)}
        />
      </Field>

      <Field
        label="Session History Limit"
        description="Maximum number of conversation turns to keep in history"
      >
        <DraftNumberInput
          min={1}
          step={1}
          value={getValue<number>('sessionHistoryLimit') ?? 10}
          onChange={(e) => setValue('sessionHistoryLimit', parseInt(e.target.value, 10) || 10)}
        />
      </Field>
    </>
  );
}