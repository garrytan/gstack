/**
 * __mocks__/@tauri-apps/plugin-opener.ts
 */

import { vi } from "vitest";

export const openUrl = vi.fn().mockResolvedValue(undefined);
export const openPath = vi.fn().mockResolvedValue(undefined);
export const revealItemInDir = vi.fn().mockResolvedValue(undefined);
