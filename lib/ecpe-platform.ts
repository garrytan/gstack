/**
 * ECPE v3 authority state currently relies on POSIX uid/mode and no-follow
 * semantics. WSL satisfies that contract; native Windows does not. Keep this
 * guard ahead of authority writes and provider effects until a handle-based
 * SID/DACL implementation covers the complete authority path.
 */
export function assertEcpeAuthorityPlatform(platform: NodeJS.Platform = process.platform): void {
  if (platform === 'win32') throw new Error('ecpe_native_windows_unsupported');
}
