'use client';

import { useState, useCallback, useRef } from 'react';
import type { ValidateResponse } from '@/lib/schemas';
import type { DocumentType } from '@/lib/photo-specs';

/* ===================================
   상수
   =================================== */

const DOC_OPTIONS: { type: DocumentType; label: string }[] = [
  { type: 'passport', label: '여권' },
  { type: 'id_card', label: '주민등록증' },
  { type: 'resume', label: '이력서' },
];

const CHECK_LABELS: Record<string, string> = {
  ears_visible: '귀 노출 확인',
  head_not_cropped: '정수리 여백',
  face_ratio: '얼굴 비율',
  background_white: '배경 투명화 및 흰색 교체',
  no_shadow: '그림자 제거',
  no_glare: '안경 반사 제거',
  facing_front: '정면 응시',
  neutral_expression: '자연스러운 무표정',
};

const LOADING_STEPS = [
  '사진을 분석하여 최적의 구도를 찾는 중입니다...',
  '8개 규격 항목을 AI가 정밀 검증하고 있습니다...',
  '배경을 흰색으로 교체하고 잡티를 제거하는 중입니다...',
  '여권/이력서 규격에 맞게 크롭 작업을 진행 중입니다...',
];

const MAX_CLIENT_SIZE = 2000;

/* ===================================
   유틸리티
   =================================== */

function resizeImage(file: File, maxSize: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;

      if (width <= maxSize && height <= maxSize) {
        resolve(file);
        return;
      }

      const ratio = Math.min(maxSize / width, maxSize / height);
      width = Math.round(width * ratio);
      height = Math.round(height * ratio);

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) { reject(new Error('Canvas 생성 실패')); return; }
      ctx.drawImage(img, 0, 0, width, height);

      canvas.toBlob(
        (blob) => blob ? resolve(blob) : reject(new Error('Blob 변환 실패')),
        'image/jpeg',
        0.92,
      );
    };

    img.onerror = () => reject(new Error('이미지 로드 실패'));
    img.src = url;
  });
}

function isHEIC(file: File): boolean {
  const name = file.name.toLowerCase();
  return name.endsWith('.heic') || name.endsWith('.heif') || file.type === 'image/heic';
}

async function convertHEIC(file: File): Promise<File> {
  const heic2any = (await import('heic2any')).default;
  const blob = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.92 });
  const result = Array.isArray(blob) ? blob[0] : blob;
  return new File([result], file.name.replace(/\.heic$/i, '.jpg'), { type: 'image/jpeg' });
}

/* ===================================
   SVG Icons (Thin, Aesthetic)
   =================================== */

function CameraIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" strokeWidth="1.2" strokeLinecap="round" stroke="currentColor" width="28" height="28">
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
      <circle cx="12" cy="13" r="4"/>
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth="1.2" strokeLinecap="round" stroke="currentColor" width="22" height="22">
      <circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>
    </svg>
  );
}

function LayersIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth="1.2" strokeLinecap="round" stroke="currentColor" width="22" height="22">
      <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth="1.5" strokeLinecap="round" stroke="currentColor" width="16" height="16">
      <path d="M20 6L9 17l-5-5"/>
    </svg>
  );
}

function ShieldCheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth="1.2" strokeLinecap="round" stroke="currentColor" width="22" height="22">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
    </svg>
  );
}

/* ===================================
   타입
   =================================== */

type AppState = 'upload' | 'loading' | 'result' | 'error';

/* ===================================
   메인 컴포넌트
   =================================== */

export default function Home() {
  const [state, setState] = useState<AppState>('upload');
  const [docType, setDocType] = useState<DocumentType>('passport');
  const [preview, setPreview] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [loadingStep, setLoadingStep] = useState(0);
  const [result, setResult] = useState<ValidateResponse | null>(null);
  const [error, setError] = useState<string>('');
  const [toast, setToast] = useState<string>('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const showToast = useCallback((msg: string, duration = 3000) => {
    setToast(msg);
    setTimeout(() => setToast(''), duration);
  }, []);

  const handleFile = useCallback(async (file: File) => {
    try {
      let processedFile = file;

      if (isHEIC(file)) {
        showToast('HEIC 사진 포맷을 변환 중...');
        processedFile = await convertHEIC(file);
      }

      const url = URL.createObjectURL(processedFile);
      setPreview(url);
      setSelectedFile(processedFile);
      setState('upload');
      setResult(null);
      setError('');
    } catch {
      setError('이미지를 읽을 수 없습니다. 다른 사진으로 시도해주세요.');
      setState('error');
    }
  }, [showToast]);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const removePreview = useCallback(() => {
    if (preview) URL.revokeObjectURL(preview);
    setPreview(null);
    setSelectedFile(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [preview]);

  const handleSubmit = useCallback(async () => {
    if (!selectedFile) return;

    setState('loading');
    setLoadingStep(0);
    setError('');

    const stepInterval = setInterval(() => {
      setLoadingStep((prev) => Math.min(prev + 1, LOADING_STEPS.length - 1));
    }, 2500);

    try {
      const resized = await resizeImage(selectedFile, MAX_CLIENT_SIZE);

      const formData = new FormData();
      formData.append('file', resized, selectedFile.name);
      formData.append('documentType', docType);

      const response = await fetch('/api/validate', {
        method: 'POST',
        body: formData,
      });

      clearInterval(stepInterval);

      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.error || `서버 오류가 발생했습니다 (${response.status})`);
      }

      const data: ValidateResponse = await response.json();
      setResult(data);
      setState('result');

    } catch (err) {
      clearInterval(stepInterval);
      setError(err instanceof Error ? err.message : '알 수 없는 오류가 발생했습니다');
      setState('error');
    }
  }, [selectedFile, docType]);

  const handleRetry = useCallback(() => {
    removePreview();
    setResult(null);
    setError('');
    setState('upload');
  }, [removePreview]);

  const handleDownload = useCallback(() => {
    if (!result?.croppedImage) return;

    const link = document.createElement('a');
    link.href = `data:image/jpeg;base64,${result.croppedImage}`;
    link.download = `증명사진_${docType}_${Date.now()}.jpg`;
    link.click();
  }, [result, docType]);

  const isRejected = result && !result.feasible;
  const isEnhanceFailed = result && result.feasible && result.enhanceFailed;
  const hasResult = result && result.feasible && !result.enhanceFailed;

  return (
    <div className="page">
      {/* 백그라운드 커튼 애니메이션 레이어 */}
      <div className="curtain-overlay" />

      {/* ═══ Header ═══ */}
      <header className="header container">
        <h1 className="header__logo">방구석 사진관</h1>
        <p className="header__tagline">반려 걱정 없는 증명사진, 10초면 완성</p>
        <span className="header__badge">무료 베타 서비스</span>
      </header>

      {/* ═══ Upload State — 2-Column Layout ═══ */}
      {(state === 'upload' || state === 'error') && (
        <main className="main-grid container">
          {/* Left: Action Column */}
          <div className="action-col">
            {/* Doc Type Pills */}
            <div className="doc-selector">
              {DOC_OPTIONS.map((opt) => (
                <button
                  key={opt.type}
                  id={`doc-type-${opt.type}`}
                  className={`doc-pill ${docType === opt.type ? 'doc-pill--active' : ''}`}
                  onClick={() => setDocType(opt.type)}
                  type="button"
                >
                  {opt.label}
                </button>
              ))}
            </div>

            {/* Upload Zone */}
            {!preview ? (
              <div
                className="upload-zone"
                onDrop={handleDrop}
                onDragOver={(e) => e.preventDefault()}
                tabIndex={0}
                role="button"
                aria-label="사진 업로드"
              >
                <div className="upload-zone__icon-wrap">
                  <CameraIcon />
                </div>
                <p className="upload-zone__title">여기에 사진을 올려주세요</p>
                <p className="upload-zone__hint">JPG, PNG, HEIC · 최대 4MB</p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleFileChange}
                  id="file-input"
                />
              </div>
            ) : (
              <div className="preview">
                <img src={preview} alt="미리보기" className="preview__image" />
                <button
                  className="preview__remove"
                  onClick={removePreview}
                  type="button"
                  aria-label="사진 제거"
                >
                  ✕
                </button>
              </div>
            )}

            {/* Error */}
            {state === 'error' && error && (
              <div className="error-banner">{error}</div>
            )}

            {/* CTA Button */}
            <button
              id="submit-btn"
              className="btn-cta"
              onClick={handleSubmit}
              disabled={!selectedFile}
              type="button"
            >
              {selectedFile ? '무료로 증명사진 만들기' : '사진을 먼저 올려주세요'}
            </button>
          </div>

          {/* Right: Trust/Aesthetic Column */}
          <div className="trust-col">
            {/* Sample Result */}
            <div className="card" style={{ padding: '32px 24px', textAlign: 'center' }}>
              <div className="comparison" style={{ marginBottom: 0 }}>
                <div className="comparison__item">
                  <span className="comparison__label">원본</span>
                  <div style={{ width: 100, height: 130, background: 'rgba(0,0,0,0.05)', borderRadius: 12, margin: '0 auto' }} />
                </div>
                <span className="comparison__arrow" style={{ opacity: 0.3 }}>→</span>
                <div className="comparison__item">
                  <span className="comparison__label">규격 완성</span>
                  <div style={{ width: 100, height: 130, background: '#fff', border: '1px solid var(--border)', borderRadius: 12, margin: '0 auto', boxShadow: 'var(--shadow-card)' }} />
                </div>
              </div>
            </div>

            {/* Trust Badges */}
            <div className="trust-badges">
              <div className="trust-badge">
                <div className="trust-badge__icon-wrap">
                  <ClockIcon />
                </div>
                <div className="trust-badge__text">
                  <p className="trust-badge__label">10초 완성</p>
                  <p className="trust-badge__desc">번거로운 다운로드 없이 10초면 완성</p>
                </div>
              </div>
              <div className="trust-badge">
                <div className="trust-badge__icon-wrap">
                  <LayersIcon />
                </div>
                <div className="trust-badge__text">
                  <p className="trust-badge__label">AI 자동 보정</p>
                  <p className="trust-badge__desc">배경 투명화 및 규격 맞춤 크롭 지원</p>
                </div>
              </div>
              <div className="trust-badge">
                <div className="trust-badge__icon-wrap">
                  <ShieldCheckIcon />
                </div>
                <div className="trust-badge__text">
                  <p className="trust-badge__label">규격 적합 보장</p>
                  <p className="trust-badge__desc">8가지 규격 기준 완전 충족으로 반려 걱정 제로</p>
                </div>
              </div>
            </div>
          </div>
        </main>
      )}

      {/* ═══ Loading State ═══ */}
      {state === 'loading' && (
        <div className="container">
          <div className="loading-section">
            <div className="loading__circle" />
            <div>
              <p className="loading__text">{LOADING_STEPS[loadingStep]}</p>
              <p className="loading__subtext">잠시만 기다려주세요 (약 30초 소요)</p>
            </div>
          </div>
        </div>
      )}

      {/* ═══ Result — 변환 불가 ═══ */}
      {isRejected && (
        <div className="results container">
          <div className="result-banner result-banner--reject" style={{ fontFamily: 'var(--font-body)', fontWeight: 500, fontSize: 16 }}>
            이 사진은 증명사진으로 변환할 수 없습니다.
          </div>

          <section className="card">
            <h2 className="card__title">변환 불가 사유</h2>
            <div className="rejection-reason" style={{ fontSize: 14 }}>
              <p>{result.rejectionReason}</p>
            </div>
          </section>

          <section className="card">
            <h2 className="card__title">다시 촬영할 때 권장 사항</h2>
            <div className="retake-guide">
              <div className="retake-guide__item">1. 카메라를 완전한 정면으로 마주보세요.</div>
              <div className="retake-guide__item">2. 입술을 자연스럽게 닫은 무표정이어야 합니다.</div>
              <div className="retake-guide__item">3. 밝은 조명 아래에서 그림자 없이 촬영해주세요.</div>
              <div className="retake-guide__item">4. 흰 옷은 배경과 구분이 어려우니 피해주세요.</div>
            </div>
          </section>

          <div style={{ textAlign: 'center', marginTop: 24 }}>
            <button className="btn-retry" onClick={handleRetry} type="button">
              다른 사진으로 다시 시도
            </button>
          </div>
        </div>
      )}

      {/* ═══ Result — 보정 실패 ═══ */}
      {isEnhanceFailed && (
        <div className="results container">
          <div className="result-banner result-banner--warn" style={{ fontFamily: 'var(--font-body)', fontWeight: 500, fontSize: 16 }}>
            일시적인 서버 오류로 이미지 보정에 실패했습니다.
          </div>

          <section className="card">
            <div className="rejection-reason">
              <p>{result.enhanceFailReason || 'AI 이미지 편집 노드에서 응답을 받지 못했습니다.'}</p>
            </div>
          </section>

          <div style={{ textAlign: 'center', marginTop: 24 }}>
            <button className="btn-retry" onClick={handleRetry} type="button">
              다시 시도하기
            </button>
          </div>
        </div>
      )}

      {/* ═══ Result — 변환 성공 ═══ */}
      {hasResult && (
        <div className="results container">
          <div className="result-banner">
            {result.overall === 'PASS'
              ? '모든 규격을 완벽히 충족하는 증명사진입니다.'
              : '일부 규격에 미달되나, AI가 최적의 상태로 보정했습니다.'}
          </div>

          {/* Download & Comparison */}
          <section className="card" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            {result.croppedImage ? (
              <>
                <div className="comparison">
                  <div className="comparison__item">
                    <span className="comparison__label">원본 사진</span>
                    {preview && <img src={preview} alt="원본" className="comparison__img" />}
                  </div>
                  <span className="comparison__arrow">→</span>
                  <div className="comparison__item">
                    <span className="comparison__label">규격 완성본</span>
                    <img
                      src={`data:image/jpeg;base64,${result.croppedImage}`}
                      alt="보정된 증명사진"
                      className="comparison__img comparison__img--after"
                    />
                  </div>
                </div>

                <button
                  id="download-btn"
                  className="btn-download"
                  onClick={handleDownload}
                  type="button"
                >
                  규격 사진 다운로드
                </button>
              </>
            ) : (
              <div style={{ color: 'var(--warning)', fontSize: 14 }}>
                에러: 이미지 크롭 처리를 완수할 수 없습니다. 다시 시도해주세요.
              </div>
            )}
          </section>

          {/* Check List */}
          <section className="card">
            <h2 className="card__title">상세 규격 검증 리포트</h2>
            <div className="check-list">
              {Object.entries(result.checks).map(([key, check]) => {
                const isEnhanced = check.reason.includes('✨') || check.reason.includes('보정');
                return (
                  <div key={key} className={`check-item ${isEnhanced ? 'check-item--enhanced' : ''}`}>
                    <span className={`check-item__icon check-item__icon--${isEnhanced ? 'enhanced' : check.result.toLowerCase()}`}>
                      {isEnhanced ? '✦' : check.result === 'PASS' ? '✓' : '✗'}
                    </span>
                    <div className="check-item__content">
                      <div className="check-item__label">
                        {CHECK_LABELS[key] || key}
                        {isEnhanced && <span className="check-item__badge">AI 자동 보정</span>}
                      </div>
                      <div className="check-item__reason">{check.reason}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          {/* Retry */}
          <div style={{ textAlign: 'center', marginTop: 24 }}>
            <button className="btn-retry" onClick={handleRetry} type="button">
              다른 사진으로 다시 만들기
            </button>
          </div>
        </div>
      )}

      {/* ═══ Toast ═══ */}
      {toast && <div className="toast">{toast}</div>}

      {/* ═══ Footer ═══ */}
      <footer className="footer container">
        <p>방구석 사진관 · 무료 베타 서비스</p>
        <p>업로드된 사진은 보안 정책에 따라 즉시 삭제되며 서버에 저장되지 않습니다.</p>
      </footer>
    </div>
  );
}
