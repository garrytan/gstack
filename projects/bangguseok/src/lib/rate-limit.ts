type LimitInfo = {
  count: number;
  resetTime: number;
};

// Vercel Serverless 배포 환경에서 글로벌 메모리를 활용하는 Map
const ipRequestMap = new Map<string, LimitInfo>();

// 1분당 최대 5회 요청 허용 (비용 폭탄 방지)
const WINDOW_SIZE_MS = 60 * 1000;
const MAX_REQUESTS = 5;

/**
 * 인메모리 IP 기반 Rate Limiter (Token Bucket 유사 구현)
 */
export function checkRateLimit(ip: string): { success: boolean; limit: number; remaining: number; reset: number } {
  const now = Date.now();
  const info = ipRequestMap.get(ip) || { count: 0, resetTime: now + WINDOW_SIZE_MS };

  // 시간이 초과되었으면 리셋
  if (now > info.resetTime) {
    info.count = 0;
    info.resetTime = now + WINDOW_SIZE_MS;
  }

  // 카운트 증가
  info.count += 1;
  ipRequestMap.set(ip, info);

  const remaining = Math.max(0, MAX_REQUESTS - info.count);
  const success = info.count <= MAX_REQUESTS;

  return {
    success,
    limit: MAX_REQUESTS,
    remaining,
    reset: info.resetTime,
  };
}

/**
 * 오래된 IP 기록을 삭제하여 메모리 누수를 방지
 */
function cleanUpRateLimitMap() {
  const now = Date.now();
  for (const [ip, info] of ipRequestMap.entries()) {
    if (now > info.resetTime) {
      ipRequestMap.delete(ip);
    }
  }
}

// 환경에 따라 1분 주기로 정리 실행 (메모리 릭 방지)
if (typeof setInterval !== 'undefined') {
  const interval = setInterval(cleanUpRateLimitMap, WINDOW_SIZE_MS);
  if (interval.unref) {
    interval.unref(); // Node 프로세스 종료를 막지 않음
  }
}
