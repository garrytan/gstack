import { NextRequest, NextResponse } from 'next/server';

/**
 * 인메모리 Rate Limiter
 *
 * IP당 분당 MAX_REQUESTS 제한
 * Serverless 인스턴스 재시작 시 카운터 리셋 (의도적 — MVP 수준)
 */

const MAX_REQUESTS = 10;
const WINDOW_MS = 60 * 1000; // 1분

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const limiter = new Map<string, RateLimitEntry>();

// 주기적 정리 (메모리 누수 방지)
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of limiter) {
    if (now > entry.resetAt) {
      limiter.delete(key);
    }
  }
}, WINDOW_MS);

export function middleware(request: NextRequest) {
  // API 경로만 rate limit 적용
  if (!request.nextUrl.pathname.startsWith('/api/')) {
    return NextResponse.next();
  }

  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('x-real-ip')
    || '127.0.0.1';

  const now = Date.now();
  const entry = limiter.get(ip);

  if (!entry || now > entry.resetAt) {
    // 새 윈도우 시작
    limiter.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return NextResponse.next();
  }

  if (entry.count >= MAX_REQUESTS) {
    return NextResponse.json(
      { error: '너무 많은 요청입니다. 잠시 후 다시 시도해주세요', code: 429 },
      { status: 429 },
    );
  }

  entry.count++;
  return NextResponse.next();
}

export const config = {
  matcher: '/api/:path*',
};
