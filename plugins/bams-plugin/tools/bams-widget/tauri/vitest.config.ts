/**
 * vitest.config.ts — bams-widget 테스트 설정
 * Phase 2.5: Vitest + @testing-library/react
 */

import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    // jsdom 환경 (React 컴포넌트 테스트 필수)
    environment: "jsdom",
    // 전역 설정 파일 (jest-dom matcher 등록)
    setupFiles: ["./src/__tests__/setup.ts"],
    // 글로벌 describe/it/expect (import 없이 사용 가능)
    globals: true,
    // Tauri API mock 자동 해석
    alias: {
      "@tauri-apps/api": path.resolve(
        __dirname,
        "./__mocks__/@tauri-apps/api.ts"
      ),
      "@tauri-apps/plugin-notification": path.resolve(
        __dirname,
        "./__mocks__/@tauri-apps/plugin-notification.ts"
      ),
      "@tauri-apps/plugin-autostart": path.resolve(
        __dirname,
        "./__mocks__/@tauri-apps/plugin-autostart.ts"
      ),
      "@tauri-apps/plugin-global-shortcut": path.resolve(
        __dirname,
        "./__mocks__/@tauri-apps/plugin-global-shortcut.ts"
      ),
      "@tauri-apps/plugin-opener": path.resolve(
        __dirname,
        "./__mocks__/@tauri-apps/plugin-opener.ts"
      ),
    },
    // 커버리지 설정
    coverage: {
      reporter: ["text", "html"],
      include: ["src/lib/**", "src/hooks/**", "src/components/**"],
      exclude: ["src/__tests__/**", "src/main.tsx"],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
