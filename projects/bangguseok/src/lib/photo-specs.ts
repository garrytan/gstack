/**
 * 증명사진 규격 상수 — 3종 문서 타입
 *
 * 규격 출처:
 *   여권: 외교부 여권 사진 규격 (ICAO 표준, 3.5×4.5cm → 413×531px @300dpi)
 *   주민등록증/운전면허: 3.5×4.5cm 동일 규격
 *   이력서/학생증: 반명함 3×4cm → 354×472px @300dpi
 */

export type DocumentType = 'passport' | 'id_card' | 'resume';

export interface PhotoSpec {
  /** 출력 너비 (px) */
  w: number;
  /** 출력 높이 (px) */
  h: number;
  /** 최대 파일 크기 (KB) */
  maxKB: number;
  /** 한국어 라벨 */
  label: string;
  /** 얼굴 세로 비율 (전체 높이 대비) */
  faceRatio: number;
}

export const PHOTO_SPECS: Record<DocumentType, PhotoSpec> = {
  passport: {
    w: 413,
    h: 531,
    maxKB: 500,
    label: '여권',
    faceRatio: 0.75,  // 머리 길이(정수리~턱) = 세로의 71~80%, 중간값 75%
  },
  id_card: {
    w: 413,
    h: 531,
    maxKB: 500,
    label: '주민등록증/운전면허',
    faceRatio: 0.75,
  },
  resume: {
    w: 354,
    h: 472,
    maxKB: 500,
    label: '이력서/학생증',
    faceRatio: 0.70,
  },
} as const;

export const DOCUMENT_TYPES = Object.keys(PHOTO_SPECS) as DocumentType[];

export function isValidDocumentType(value: string): value is DocumentType {
  return DOCUMENT_TYPES.includes(value as DocumentType);
}
