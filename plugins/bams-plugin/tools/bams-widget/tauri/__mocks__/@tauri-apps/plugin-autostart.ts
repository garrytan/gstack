/**
 * __mocks__/@tauri-apps/plugin-autostart.ts
 */

import { vi } from "vitest";

export const enable = vi.fn().mockResolvedValue(undefined);
export const disable = vi.fn().mockResolvedValue(undefined);
export const isEnabled = vi.fn().mockResolvedValue(false);
