/**
 * __mocks__/@tauri-apps/api.ts
 * @tauri-apps/api v2 mock — invoke, window, app 등
 */

import { vi } from "vitest";

export const invoke = vi.fn().mockResolvedValue(null);

export const app = {
  getName: vi.fn().mockResolvedValue("bams-widget"),
  getVersion: vi.fn().mockResolvedValue("1.0.0"),
  getTauriVersion: vi.fn().mockResolvedValue("2.0.0"),
};

export const window = {
  getCurrent: vi.fn().mockReturnValue({
    label: "main",
    show: vi.fn().mockResolvedValue(undefined),
    hide: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    setAlwaysOnTop: vi.fn().mockResolvedValue(undefined),
  }),
  getAll: vi.fn().mockResolvedValue([]),
};

export const path = {
  appDataDir: vi.fn().mockResolvedValue("/mock/app-data"),
  homeDir: vi.fn().mockResolvedValue("/mock/home"),
};

export const event = {
  listen: vi.fn().mockResolvedValue(() => {}),
  once: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn().mockResolvedValue(undefined),
};

export const core = {
  invoke: vi.fn().mockResolvedValue(null),
};
