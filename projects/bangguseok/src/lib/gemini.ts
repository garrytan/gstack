import { GoogleGenAI } from '@google/genai';
import { GeminiResponse, type GeminiResponseType, type FaceCoordsType } from './schemas';

/**
 * Gemini API 클라이언트
 *
 * Step 1: 텍스트 모델 — 8항목 검증 + 얼굴 좌표 + 변환 가능성 판단
 * Step 2: 이미지 편집 모델 — 배경 제거 + 밝기 보정
 */

const VALIDATION_PROMPT = `당신은 한국 증명사진 규격 검증 전문가입니다.
이 사진이 한국 증명사진 규격에 적합한지 8가지 항목으로 검증하세요.

각 항목에 대해 PASS 또는 FAIL과 한국어 사유를 반환하세요.
또한 사진 속 인물의 얼굴 위치를 0.0~1.0 범위의 상대 좌표로 반환하세요.
(0,0)은 이미지의 좌상단 모서리, (1,1)은 우하단 모서리입니다.

검증 항목:
1. ears_visible: 두 귀가 모두 노출되어 있는가 (머리카락으로 귀가 가려지면 FAIL)
2. head_not_cropped: 정수리 위 여백이 충분한가 (머리카락 끝이 잘리면 FAIL)
3. face_ratio: 얼굴이 사진 전체 세로의 약 70~80%를 차지하는가 (너무 작거나 크면 FAIL)
4. background_white: 배경이 균일한 흰색 또는 밝은 단색인가 (패턴, 어두운 배경이면 FAIL)
5. no_shadow: 얼굴이나 배경에 눈에 띄는 그림자가 없는가
6. no_glare: 안경 착용 시 렌즈에 조명 반사가 없는가 (안경 미착용이면 PASS)
7. facing_front: 얼굴이 정면을 향하고 있는가 (좌우 회전이나 기울임이 없는가)
8. neutral_expression: 입을 다물고 자연스러운 무표정인가 (미소, 찡그림 FAIL)

얼굴 좌표 설명:
- top: 머리 꼭대기(머리카락 포함)의 y좌표 (0.0~1.0). 머리카락 끝이 보이는 가장 높은 지점.
- chin: 턱 끝(턱의 가장 아래 지점)의 y좌표 (0.0~1.0)
- centerX: 얼굴 중심의 x좌표 (0.0~1.0)
- centerY: 얼굴 중심의 y좌표 (0.0~1.0)

모든 항목이 PASS이면 overall은 "PASS", 하나라도 FAIL이면 overall은 "FAIL"로 설정하세요.

추가 판단 — 변환 가능성 (feasible):
이 사진을 이미지 보정(배경 교체, 밝기 조정, 크롭)을 통해 규격에 맞는 증명사진으로 만들 수 있는지 판단하세요.
다음 경우에는 feasible을 false로 설정하고 rejection_reason에 사유를 한국어로 작성하세요:
- 얼굴이 정면이 아닌 측면(45도 이상 회전)인 경우
- 사진이 심하게 흐릿하거나 초점이 맞지 않는 경우
- 2명 이상의 인물이 있는 경우
- 인물 사진이 아닌 경우 (풍경, 동물, 물건 등)
- 얼굴이 심하게 가려진 경우 (마스크, 선글라스 등)
- 정수리가 크게 잘려 복원이 불가능한 경우
그 외의 경우(배경 색상, 밝기, 얼굴 비율 등)는 보정으로 해결 가능하므로 feasible을 true로 설정하세요.`;

const RESPONSE_SCHEMA = {
  type: 'object' as const,
  properties: {
    checks: {
      type: 'object' as const,
      properties: {
        ears_visible: {
          type: 'object' as const,
          properties: {
            result: { type: 'string' as const, enum: ['PASS', 'FAIL'] },
            reason: { type: 'string' as const },
          },
          required: ['result', 'reason'],
        },
        head_not_cropped: {
          type: 'object' as const,
          properties: {
            result: { type: 'string' as const, enum: ['PASS', 'FAIL'] },
            reason: { type: 'string' as const },
          },
          required: ['result', 'reason'],
        },
        face_ratio: {
          type: 'object' as const,
          properties: {
            result: { type: 'string' as const, enum: ['PASS', 'FAIL'] },
            reason: { type: 'string' as const },
          },
          required: ['result', 'reason'],
        },
        background_white: {
          type: 'object' as const,
          properties: {
            result: { type: 'string' as const, enum: ['PASS', 'FAIL'] },
            reason: { type: 'string' as const },
          },
          required: ['result', 'reason'],
        },
        no_shadow: {
          type: 'object' as const,
          properties: {
            result: { type: 'string' as const, enum: ['PASS', 'FAIL'] },
            reason: { type: 'string' as const },
          },
          required: ['result', 'reason'],
        },
        no_glare: {
          type: 'object' as const,
          properties: {
            result: { type: 'string' as const, enum: ['PASS', 'FAIL'] },
            reason: { type: 'string' as const },
          },
          required: ['result', 'reason'],
        },
        facing_front: {
          type: 'object' as const,
          properties: {
            result: { type: 'string' as const, enum: ['PASS', 'FAIL'] },
            reason: { type: 'string' as const },
          },
          required: ['result', 'reason'],
        },
        neutral_expression: {
          type: 'object' as const,
          properties: {
            result: { type: 'string' as const, enum: ['PASS', 'FAIL'] },
            reason: { type: 'string' as const },
          },
          required: ['result', 'reason'],
        },
      },
      required: [
        'ears_visible', 'head_not_cropped', 'face_ratio',
        'background_white', 'no_shadow', 'no_glare',
        'facing_front', 'neutral_expression',
      ],
    },
    face: {
      type: 'object' as const,
      properties: {
        top: { type: 'number' as const },
        chin: { type: 'number' as const },
        centerX: { type: 'number' as const },
        centerY: { type: 'number' as const },
      },
      required: ['top', 'chin', 'centerX', 'centerY'],
    },
    overall: { type: 'string' as const, enum: ['PASS', 'FAIL'] },
    feasible: { type: 'boolean' as const },
    rejection_reason: { type: 'string' as const },
  },
  required: ['checks', 'face', 'overall', 'feasible'],
};

/**
 * Gemini API 에러 분류
 */
export class GeminiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = 'GeminiError';
  }
}

/**
 * Step 1: 이미지를 Gemini Vision API로 검증 + 변환 가능성 판단
 */
export async function validateWithGemini(
  imageBuffer: Buffer,
  mimeType: string = 'image/jpeg',
): Promise<GeminiResponseType> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new GeminiError('GEMINI_API_KEY 환경변수가 설정되지 않았습니다', 500);
  }

  const ai = new GoogleGenAI({ apiKey });
  const base64Image = imageBuffer.toString('base64');

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [
          {
            role: 'user',
            parts: [
              { text: VALIDATION_PROMPT },
              {
                inlineData: {
                  mimeType,
                  data: base64Image,
                },
              },
            ],
          },
        ],
        config: {
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA,
          temperature: 0.1,
        },
      });

      const text = response.text;
      if (!text) {
        if (attempt === 0) continue;
        throw new GeminiError('AI 응답이 비어있습니다', 500);
      }

      const parsed = GeminiResponse.safeParse(JSON.parse(text));
      if (!parsed.success) {
        if (attempt === 0) continue;
        throw new GeminiError('AI 응답 형식이 올바르지 않습니다', 500);
      }

      return parsed.data;

    } catch (error) {
      if (error instanceof GeminiError) throw error;

      const err = error as { status?: number; message?: string; statusCode?: number };
      const status = err.status || err.statusCode || 0;
      const message = err.message || '';

      console.error(`[gemini] Validate attempt ${attempt + 1} failed:`, status, message);

      if (message.includes('SAFETY') || message.includes('blocked')) {
        throw new GeminiError('인물 사진을 업로드해주세요', 400);
      }

      if (status === 429 || message.includes('429') || message.includes('RESOURCE_EXHAUSTED') || message.includes('quota')) {
        throw new GeminiError('API 사용량 한도에 도달했습니다. 1분 후 다시 시도해주세요', 429, true);
      }

      if (attempt === 0) continue;

      throw new GeminiError(
        'AI 서버 응답 지연이 발생했습니다. 다시 시도해주세요',
        504,
        true,
      );
    }
  }

  throw new GeminiError('검증에 실패했습니다', 500);
}

/**
 * Step 2: Gemini 이미지 편집 모델로 배경 제거 + 밝기 보정
 *
 * gemini-2.5-flash-image 모델 사용
 * 입력: 원본 이미지 + 편집 프롬프트
 * 출력: 보정된 이미지 Buffer
 */
const ENHANCE_PROMPT = `이 사진을 아래 지시에 따라 편집하여 보정된 이미지를 반환하세요. 텍스트 설명 없이 편집된 이미지만 출력하세요.

[필수 편집]
1. 배경을 완전한 순백색(#FFFFFF)으로 교체. 벽지, 그림자, 무늬, 기타 배경 요소 모두 제거.
2. 얼굴과 상체를 균일하고 밝게 보정. 어두운 그림자 자연스럽게 제거.
3. 전체 색감을 맑고 깨끗한 톤으로 보정.

[리터칭 — 적응적으로]
4. 피부의 잡티, 여드름, 다크서클을 자연스럽게 축소. 피부결 유지.
5. 사진이 어두우면 밝기를 높이고, 이미 밝으면 유지.
6. 피부톤을 자연스러운 화사한 웜톤으로 미세 조정.
7. 눈, 눈썹, 머리카락 디테일을 살짝 선명하게.
8. 얼굴의 입체감을 위해 대비를 미세하게 조정.

[금지 사항]
- 사진의 구도, 크롭, 줌을 변경하지 마세요. 원본과 동일한 프레이밍을 유지.
- 얼굴 형태, 표정, 옷, 액세서리, 머리카락 스타일 변경 금지.
- 과도한 에어브러시 금지. 자연스러운 피부결 유지.
- 인물 윤곽선과 머리카락 경계를 자연스럽게 유지.

반드시 편집된 이미지를 출력하세요.`;

export interface EnhanceResult {
  image: Buffer | null;
  failReason?: string;
}

export async function enhancePhoto(
  imageBuffer: Buffer,
  mimeType: string = 'image/jpeg',
): Promise<EnhanceResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { image: null, failReason: 'API 키가 설정되지 않았습니다. 관리자에게 문의하세요.' };
  }

  const ai = new GoogleGenAI({ apiKey });
  const base64Image = imageBuffer.toString('base64');
  const MAX_ATTEMPTS = 3;
  let lastTextResponse = '';

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      console.log(`[gemini] Enhance attempt ${attempt + 1}/${MAX_ATTEMPTS}...`);

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-image',
        contents: [
          {
            role: 'user',
            parts: [
              { text: ENHANCE_PROMPT },
              {
                inlineData: {
                  mimeType,
                  data: base64Image,
                },
              },
            ],
          },
        ],
        config: {
          responseModalities: ['IMAGE', 'TEXT'],
        },
      });

      // 응답에서 이미지 파트 추출
      const candidates = response.candidates;
      if (!candidates || candidates.length === 0) {
        console.error('[gemini] Enhance: no candidates');
        continue; // 재시도
      }

      const parts = candidates[0].content?.parts;
      if (!parts) {
        console.error('[gemini] Enhance: no parts');
        continue; // 재시도
      }

      // inlineData 파트 찾기 (이미지)
      for (const part of parts) {
        if (part.inlineData?.data) {
          console.log('[gemini] Enhance: got image response ✅');
          return { image: Buffer.from(part.inlineData.data, 'base64') };
        }
      }

      // 텍스트만 돌아온 경우 → 재시도 (즉시 실패하지 않음)
      for (const part of parts) {
        if (part.text) {
          lastTextResponse = part.text;
          console.log(`[gemini] Enhance attempt ${attempt + 1}: got text instead of image, retrying...`);
          break;
        }
      }

      // 이미지도 텍스트도 없는 경우
      console.error('[gemini] Enhance: empty response');
      continue; // 재시도

    } catch (error) {
      const err = error as { status?: number; message?: string; statusCode?: number };
      const status = err.status || err.statusCode || 0;
      const message = err.message || '';

      console.error(`[gemini] Enhance attempt ${attempt + 1} failed:`, status, message);

      if (status === 429 || message.includes('429') || message.includes('RESOURCE_EXHAUSTED') || message.includes('quota')) {
        return { image: null, failReason: '⏳ API 사용량 한도에 도달했습니다. 1분 후 다시 시도해주세요.' };
      }

      if (status === 404) {
        return { image: null, failReason: '🔧 이미지 보정 모델을 사용할 수 없습니다. 관리자에게 문의하세요.' };
      }

      continue; // 기타 에러도 재시도
    }
  }

  // 모든 시도 실패
  const reason = lastTextResponse
    ? '이미지 보정에 실패했습니다. 잠시 후 다시 시도해주세요.'
    : '이미지 보정에 반복 실패했습니다. 얼굴이 선명하게 보이는 다른 사진으로 시도해주세요.';
  return { image: null, failReason: reason };
}

// ========================================
// Step 2.5: 보정된 이미지에서 얼굴 좌표 재감지
// ========================================

const FACE_DETECT_PROMPT = `이 사진에서 인물의 얼굴 위치를 0.0~1.0 범위의 상대 좌표로 반환하세요.
(0,0)은 이미지 좌상단, (1,1)은 우하단입니다. 텍스트 설명 없이 JSON만 반환하세요.

- top: 머리 꼭대기(머리카락 포함)의 y좌표
- chin: 턱 끝의 y좌표
- centerX: 얼굴 중심의 x좌표
- centerY: 얼굴 중심의 y좌표`;

const FACE_DETECT_SCHEMA = {
  type: 'object' as const,
  properties: {
    top: { type: 'number' as const },
    chin: { type: 'number' as const },
    centerX: { type: 'number' as const },
    centerY: { type: 'number' as const },
  },
  required: ['top', 'chin', 'centerX', 'centerY'],
};

/**
 * 보정된 이미지에서 얼굴 좌표만 빠르게 감지
 * Step 1보다 훨씬 가벼움 (좌표 4개만 반환)
 */
export async function detectFaceCoords(
  imageBuffer: Buffer,
  mimeType: string = 'image/jpeg',
): Promise<FaceCoordsType | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const ai = new GoogleGenAI({ apiKey });
  const base64Image = imageBuffer.toString('base64');

  try {
    console.log('[gemini] Detecting face coords on enhanced image...');

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        {
          role: 'user',
          parts: [
            { text: FACE_DETECT_PROMPT },
            { inlineData: { mimeType, data: base64Image } },
          ],
        },
      ],
      config: {
        responseMimeType: 'application/json',
        responseSchema: FACE_DETECT_SCHEMA,
      },
    });

    const text = response.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return null;

    const parsed = JSON.parse(text) as FaceCoordsType;
    console.log('[gemini] Face coords detected:', parsed);
    return parsed;
  } catch (error) {
    console.error('[gemini] Face detection failed:', error);
    return null;
  }
}
