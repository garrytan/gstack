import { z } from 'zod';

/**
 * Gemini API 응답 스키마
 *
 * 각 검증 항목: PASS/FAIL + 한국어 사유
 * 얼굴 좌표: 0.0~1.0 비율 (정규화된 좌표)
 *   (0,0) = 이미지 좌상단, (1,1) = 우하단
 */

const CheckResult = z.enum(['PASS', 'FAIL']);

const CheckItem = z.object({
  result: CheckResult,
  reason: z.string(),
});

export const FaceCoords = z.object({
  /** 정수리 y좌표 (0-1) */
  top: z.number().min(0).max(1),
  /** 턱 y좌표 (0-1) */
  chin: z.number().min(0).max(1),
  /** 얼굴 중심 x좌표 (0-1) */
  centerX: z.number().min(0).max(1),
  /** 얼굴 중심 y좌표 (0-1) */
  centerY: z.number().min(0).max(1),
});

export const ValidationChecks = z.object({
  ears_visible: CheckItem,
  head_not_cropped: CheckItem,
  face_ratio: CheckItem,
  background_white: CheckItem,
  no_shadow: CheckItem,
  no_glare: CheckItem,
  facing_front: CheckItem,
  neutral_expression: CheckItem,
});

export const GeminiResponse = z.object({
  checks: ValidationChecks,
  face: FaceCoords,
  overall: CheckResult,
  /** 이 사진을 증명사진으로 보정할 수 있는지 여부 */
  feasible: z.boolean(),
  /** feasible=false일 때 변환 불가 사유 (한국어) */
  rejection_reason: z.string().optional(),
});

export type GeminiResponseType = z.infer<typeof GeminiResponse>;
export type FaceCoordsType = z.infer<typeof FaceCoords>;
export type CheckResultType = z.infer<typeof CheckResult>;

/**
 * 얼굴 좌표의 의미적 유효성 검증
 * - top < chin (정수리가 턱 위에 있어야 함)
 * - 얼굴 높이가 최소 5% 이상 (너무 작으면 감지 실패)
 */
export function isValidFaceCoords(face: FaceCoordsType): boolean {
  if (face.top >= face.chin) return false;
  const faceHeight = face.chin - face.top;
  if (faceHeight < 0.05) return false;
  if (faceHeight > 0.95) return false;
  return true;
}

/**
 * API 응답 타입
 */
export interface ValidateResponse {
  checks: z.infer<typeof ValidationChecks>;
  overall: 'PASS' | 'FAIL';
  feasible: boolean;
  rejectionReason?: string;      // 변환 불가 사유
  croppedImage?: string;         // base64 JPEG (규격 크롭 완료)
  cropFailed?: boolean;          // 크롭 실패 시 true
  enhanceFailed?: boolean;       // 이미지 보정 실패 시 true
  enhanceFailReason?: string;    // 보정 실패 구체적 사유
  error?: string;
}

export interface ErrorResponse {
  error: string;
  code: number;
}
