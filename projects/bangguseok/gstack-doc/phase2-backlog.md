# Phase 2 고도화 백로그 (Tech Debt & Improvements)

방구석 사진관(PassPro AI) MVP 배포 직전 진행된 보안/아키텍쳐 감사(`/review`, `/cso`)를 통해 도출된 기술적 한계와 개선 사항입니다.
이 문서는 추후 스케일업(Phase 2) 장기 운영이나 결제 모듈 연동 전에 반드시 짚고 넘어가야 할 **1순위 리팩토링 과제**를 담고 있습니다.

---

## 1. 글로벌 분산 환경(Scale-out) 대응 Rate Limit 도입
- **이슈:** Vercel Serverless는 트래픽이 몰리면 독립된 여러 인스턴스(Lambda)를 생성합니다. 현재 인메모리 방식(`new Map()`)은 한 인스턴스 내에서만 1분 단위 제한이 적용되어, 대규모 분산 디도스(DDoS) 공격 시 API 쿼터 고갈 방어가 뚫릴 가능성이 존재합니다.
- **해결/반영 방안:** 
  - Vercel 호환 **Upstash (Serverless Redis)** 데이터베이스 도입.
  - Vercel의 `Edge Middleware` 계층으로 이동시켜, 앱 로직이 실행되기도 전(Edge 단계)에 글로벌 IP 접근 한도를 차단하도록 아키텍쳐 리퍼블리싱.

## 2. 메모리 공격 선제 차단 (Payload Size Validation Early-exit)
- **이슈:** `await request.formData()`를 호출해 Vercel 메모리에 이미지를 적재한 '후'에 `MAX_FILE_SIZE`를 초과했는지 확인하고 있습니다. (Vercel 인프라에서 기본적으로 4.5MB 이상은 끊어주므로 당장 터지진 않습니다)
- **해결/반영 방안:**
  - 미들웨어(Middleware) 레벨에서 `Content-Length` 헤더를 통해 4MB 이상일 경우 즉시 `413 Payload Too Large`를 반환하도록 Early-exit 적용.
  - Vercel `next.config.js`의 `api.bodyParser.sizeLimit` 환경설정을 통해 플랫폼 레벨에서 명시적 차단.

## 3. 서버리스 친화적인 만료 레코드 관리 (Passive Cleanup)
- **이슈:** `setInterval`을 이용해 주기적으로 Rate limit 메모리를 비우는 폴링(Polling) 방식은 계속 상주하는 일반 Node.js 서버에는 적합하지만, 유휴 상태일 때 CPU가 동결(Freeze)되는 서버리스 환경에서는 작동을 보장하지 않습니다.
- **해결/반영 방안:** 
  - `setInterval` 제거.
  - 사용자가 요청(Request)하여 `checkRateLimit()`가 동작하는 '직접적인 실행 시점'에 만료된 예전 기록들을 솎아내는(Triggered) **Passive Cleanup** 패턴으로 구조 개선.

## 4. (추가 제안안) Gemini API 토큰 비용 로깅 대시보드 연동
- **이슈:** Gemini 2.5 Flash API 활용 시 실시간 과금/토큰 사용량을 별도로 남기지 않고 있습니다.
- **해결/반영 방안:**
  - 성공적으로 이미지를 크롭/보정 반환했을 때, `response.usageMetadata.totalTokenCount` 등을 파싱하여, Vercel 로그 혹은 Datadog 메트릭에 기록.
  - 향후 유료 결제 건당 매입원가(마진)를 즉시 계산할 수 있는 파이프라인 형성.
