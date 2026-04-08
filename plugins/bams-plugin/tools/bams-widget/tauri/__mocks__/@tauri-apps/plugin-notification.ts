/**
 * __mocks__/@tauri-apps/plugin-notification.ts
 * Tauri notification plugin mock
 */

import { vi } from "vitest";

export const isPermissionGranted = vi.fn().mockResolvedValue(true);
export const requestPermission = vi.fn().mockResolvedValue("granted");
export const sendNotification = vi.fn().mockResolvedValue(undefined);
export const registerActionTypes = vi.fn().mockResolvedValue(undefined);
export const onNotificationReceived = vi.fn().mockResolvedValue(() => {});
export const onAction = vi.fn().mockResolvedValue(() => {});
