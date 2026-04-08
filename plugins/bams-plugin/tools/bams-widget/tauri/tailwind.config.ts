// Tailwind CSS v4 — CSS-first config
// 대부분의 설정은 src/styles/globals.css의 @theme 블록에서 처리
// 이 파일은 content 경로 명시 용도로만 유지
import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
};

export default config;
