import type { Metadata } from "next";
import { Noto_Serif_KR } from "next/font/google";
import localFont from "next/font/local";
import "./globals.css";

const notoSerifKR = Noto_Serif_KR({
  subsets: ["latin"],
  weight: ["600", "700"],
  variable: "--font-noto-serif",
  display: "swap",
});

const pretendard = localFont({
  src: [
    {
      path: "../fonts/PretendardVariable.woff2",
      style: "normal",
    },
  ],
  variable: "--font-pretendard",
  display: "swap",
  fallback: ["-apple-system", "BlinkMacSystemFont", "Segoe UI", "sans-serif"],
});

export const metadata: Metadata = {
  title: "방구석 사진관 — 증명사진 AI 규격 검증",
  description:
    "여권, 주민등록증, 이력서 증명사진을 AI가 자동 검증하고 규격에 맞게 크롭합니다. 반려 걱정 없이 10초만에 완성.",
  keywords: [
    "증명사진",
    "여권사진 규격",
    "여권사진 반려",
    "증명사진 크롭",
    "주민등록증 사진",
    "이력서 사진",
    "AI 사진 검증",
    "방구석 사진관",
  ],
  openGraph: {
    title: "방구석 사진관 — 증명사진 AI 규격 검증",
    description: "반려 걱정 없이 10초만에 증명사진 완성",
    type: "website",
    locale: "ko_KR",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko" className={`${notoSerifKR.variable} ${pretendard.variable}`}>
      <body>{children}</body>
    </html>
  );
}
