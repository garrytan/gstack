/**
 * Minimal ambient types for `html-to-docx` (v1.8.0), which ships no
 * bundled .d.ts and has no @types package. Covers only the call shape
 * this repo actually uses.
 */
declare module 'html-to-docx' {
  interface HtmlToDocxOptions {
    title?: string;
    creator?: string;
    [key: string]: unknown;
  }

  function HTMLtoDOCX(
    htmlString: string,
    headerHTMLString?: string | null,
    options?: HtmlToDocxOptions,
  ): Promise<Buffer | Blob>;

  export default HTMLtoDOCX;
}
