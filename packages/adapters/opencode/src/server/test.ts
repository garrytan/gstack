import { 
  AdapterEnvironmentTestContext, 
  AdapterEnvironmentTestResult,
  AdapterEnvironmentCheckLevel,
  AdapterEnvironmentTestStatus,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv
} from '@paperclipai/adapter-utils/server-utils';

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext
): Promise<AdapterEnvironmentTestResult> {
  const checks = [];

  // 1. Validate cwd
  const cwd = ctx.config.cwd as string | undefined;
  if (!cwd) {
    checks.push({
      code: 'MISSING_CWD',
      level: 'error' as AdapterEnvironmentCheckLevel,
      message: 'cwd is required',
    });
  } else {
    try {
      ensureAbsoluteDirectory(cwd);
      checks.push({
        code: 'CWD_VALID',
        level: 'info' as AdapterEnvironmentCheckLevel,
        message: `cwd is valid: ${cwd}`,
      });
    } catch (err) {
      checks.push({
        code: 'INVALID_CWD',
        level: 'error' as AdapterEnvironmentCheckLevel,
        message: `Invalid cwd: ${err.message}`,
      });
    }
  }

  // 2. Validate that opencode command is available
  try {
    // We need to pass the environment for command resolution
    // Build a basic environment for testing
    const env = {
      ...process.env,
      // We don't have the full buildPaperclipEnv here, but for command resolution we just need PATH
    };
    ensureCommandResolvable('opencode', cwd ?? '.', env);
    checks.push({
      code: 'OPENCODE_COMMAND_AVAILABLE',
      level: 'info' as AdapterEnvironmentCheckLevel,
      message: 'OpenCode CLI is available in PATH',
    });
  } catch (err) {
    checks.push({
      code: 'OPENCODE_COMMAND_NOT_FOUND',
      level: 'error' as AdapterEnvironmentCheckLevel,
      message: `OpenCode CLI not found: ${err.message}`,
    });
  }

  // 3. Validate model if provided
  const model = ctx.config.model as string | undefined;
  if (model) {
    // OpenCode accepts many model IDs, we can't easily validate them all
    // But we can check if it's a non-empty string
    if (model.trim().length === 0) {
      checks.push({
        code: 'INVALID_MODEL',
        level: 'warn' as AdapterEnvironmentCheckLevel,
        message: 'model should not be empty if provided',
      });
    } else {
      checks.push({
        code: 'MODEL_PROVIDED',
        level: 'info' as AdapterEnvironmentCheckLevel,
        message: `model is set to: ${model}`,
      });
    }
  }

  // Determine overall status
  const hasError = checks.some(check => check.level === 'error');
  const hasWarning = !hasError && checks.some(check => check.level === 'warn');
  
  let status: AdapterEnvironmentTestStatus = 'pass';
  if (hasError) {
    status = 'fail';
  } else if (hasWarning) {
    status = 'warn';
  }

  return {
    adapterType: ctx.agent.adapterType,
    status,
    checks,
    testedAt: new Date().toISOString(),
  };
}