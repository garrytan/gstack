/**
 * Document extraction contract.
 *
 * Extraction turns a file into the structured `ExtractedDocument` the rule
 * engine checks. It is deliberately the *only* thing a provider does: the
 * checks themselves are deterministic and run identically whether the fields
 * came from OCR or from a buyer typing what their document says.
 *
 * That split is what lets document intelligence be useful before any provider
 * exists, and it is why the null extractor throws rather than returning an
 * empty document — an empty extraction would read as "we checked and found
 * nothing wrong", which is the opposite of the truth.
 */

import 'server-only';
import type { DocumentKind, ExtractedDocument } from '@/domain/documents/types';
import { getServerEnv } from '@/lib/env';

export interface ExtractionRequest {
  readonly kind: DocumentKind;
  readonly storagePath: string;
  readonly mimeType: string;
}

export interface DocumentExtractor {
  readonly name: string;
  extract(request: ExtractionRequest): Promise<ExtractedDocument>;
}

export class ExtractionNotConfiguredError extends Error {
  constructor() {
    super(
      'No document extraction provider is configured. PropIQ will not return an empty ' +
        'extraction, because an empty result reads as a clean document. Enter the document ' +
        'details manually to run the same checks.',
    );
    this.name = 'ExtractionNotConfiguredError';
  }
}

class NullExtractor implements DocumentExtractor {
  readonly name = 'none';
  async extract(): Promise<ExtractedDocument> {
    throw new ExtractionNotConfiguredError();
  }
}

let extractor: DocumentExtractor = new NullExtractor();

export const getDocumentExtractor = (): DocumentExtractor => extractor;

export const setDocumentExtractor = (next: DocumentExtractor): void => {
  extractor = next;
};

export const isExtractionConfigured = (): boolean => getDocumentExtractor().name !== 'none';

/**
 * Upload validation.
 *
 * Runs before a byte is stored. Type and size are checked against an
 * allowlist rather than a blocklist, and the declared MIME type is never
 * trusted on its own — the extension has to agree with it.
 */
export const ALLOWED_DOCUMENT_TYPES: Readonly<Record<string, readonly string[]>> = {
  'application/pdf': ['.pdf'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
  'image/webp': ['.webp'],
};

export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

export interface UploadValidation {
  readonly ok: boolean;
  readonly reason?: string;
}

export const validateUpload = (file: {
  name: string;
  size: number;
  type: string;
}): UploadValidation => {
  const allowedExtensions = ALLOWED_DOCUMENT_TYPES[file.type];
  if (!allowedExtensions) {
    return {
      ok: false,
      reason: `${file.type || 'That file type'} is not accepted. Upload a PDF or an image.`,
    };
  }

  const lower = file.name.toLowerCase();
  if (!allowedExtensions.some((ext) => lower.endsWith(ext))) {
    // A declared MIME type that disagrees with the extension is either a
    // misconfigured client or an attempt to smuggle something past the filter.
    return { ok: false, reason: 'The file extension does not match its declared type.' };
  }

  if (file.size <= 0) return { ok: false, reason: 'That file is empty.' };
  if (file.size > MAX_DOCUMENT_BYTES) {
    return {
      ok: false,
      reason: `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB.`,
    };
  }

  return { ok: true };
};

/** Storage path for a user's document. The prefix is what the RLS policy enforces. */
export const documentStoragePath = (
  userId: string,
  documentId: string,
  fileName: string,
): string => {
  // Only the extension survives from the user-supplied name; the rest is ours.
  const ext = fileName
    .slice(fileName.lastIndexOf('.'))
    .toLowerCase()
    .replace(/[^a-z.]/g, '');
  return `${userId}/${documentId}${ext}`;
};

export const getServerExtractionStatus = (): { configured: boolean; provider: string } => {
  // Reads env so the UI can explain the state rather than guessing at it.
  getServerEnv();
  return { configured: isExtractionConfigured(), provider: getDocumentExtractor().name };
};
