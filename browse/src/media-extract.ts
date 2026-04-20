/**
 * Media extraction helper — shared between `media` (read) and `scrape` (write) commands.
 *
 * Runs page.evaluate() to discover all media elements on the page:
 *   - <img> with src, srcset, currentSrc, alt, dimensions, loading, data-src
 *   - <video> with currentSrc, poster, duration, <source> children, HLS/DASH detection
 *   - <audio> with src, duration, type
 *   - CSS background-image (capped at 500 elements)
 */

import type { Page, Frame } from 'playwright';

export interface ImageInfo {
  index: number;
  src: string;
  srcset: string;
  currentSrc: string;
  alt: string;
  width: number;
  height: number;
  naturalWidth: number;
  naturalHeight: number;
  loading: string;
  dataSrc: string;
  visible: boolean;
}

export interface VideoSource {
  src: string;
  type: string;
}

export interface VideoInfo {
  index: number;
  src: string;
  currentSrc: string;
  poster: string;
  width: number;
  height: number;
  duration: number;
  type: string;
  sources: VideoSource[];
  isHLS: boolean;
  isDASH: boolean;
}

export interface AudioInfo {
  index: number;
  src: string;
  currentSrc: string;
  duration: number;
  type: string;
}

export interface BackgroundImageInfo {
  index: number;
  url: string;
  selector: string;
  element: string;
}

export interface MediaResult {
  images: ImageInfo[];
  videos: VideoInfo[];
  audio: AudioInfo[];
  backgroundImages: BackgroundImageInfo[];
  total: number;
}

/** Extract all media elements from the page or a scoped subtree. */
export async function extractMedia(
  target: Page | Frame,
  options?: { selector?: string; filter?: 'images' | 'videos' | 'audio' },
): Promise<MediaResult> {
  const result = await target.evaluate(({ scopeSelector, filter }) => {
    const root = scopeSelector
      ? document.querySelector(scopeSelector) || document
      : document;

    const images: any[] = [];
    const videos: any[] = [];
    const audio: any[] = [];
    const backgroundImages: any[] = [];

    // Images
    if (!filter || filter === 'images') {
      const imgs = root.querySelectorAll('img');
      imgs.forEach((img, i) => {
        const rect = img.getBoundingClientRect();
        images.push({
          index: i,
          src: img.src || '',
          srcset: img.srcset || '',
          currentSrc: img.currentSrc || '',
          alt: img.alt || '',
          width: img.width,
          height: img.height,
          naturalWidth: img.naturalWidth,
          naturalHeight: img.naturalHeight,
          loading: img.loading || '',
          dataSrc: img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('data-original') || '',
          visible: rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0,
        });
      });
    }

    // Videos
    if (!filter || filter === 'videos') {
      const vids = root.querySelectorAll('video');
      vids.forEach((vid, i) => {
        const sources = Array.from(vid.querySelectorAll('source')).map(s => ({
          src: s.src || '',
          type: s.type || '',
        }));
        const isHLS = sources.some(s => s.type.includes('mpegURL') || s.src.includes('.m3u8'));
        const isDASH = sources.some(s => s.type.includes('dash') || s.src.includes('.mpd'));
        videos.push({
          index: i,
          src: vid.src || '',
          currentSrc: vid.currentSrc || '',
          poster: vid.poster || '',
          width: vid.videoWidth || vid.width,
          height: vid.videoHeight || vid.height,
          duration: isFinite(vid.duration) ? vid.duration : 0,
          type: sources[0]?.type || '',
          sources,
          isHLS,
          isDASH,
        });
      });
    }

    // Audio
    if (!filter || filter === 'audio') {
      const auds = root.querySelectorAll('audio');
      auds.forEach((aud, i) => {
        const source = aud.querySelector('source');
        audio.push({
          index: i,
          src: aud.src || source?.src || '',
          currentSrc: aud.currentSrc || '',
          duration: isFinite(aud.duration) ? aud.duration : 0,
          type: source?.type || '',
        });
      });
    }

    // Background images (capped at 500 elements for performance)
    if (!filter || filter === 'images') {
      const allElements = root.querySelectorAll('*');
      let bgCount = 0;
      for (let i = 0; i < allElements.length && bgCount < 500; i++) {
        const el = allElements[i];
        const bg = getComputedStyle(el).backgroundImage;
        if (bg && bg !== 'none') {
          const urlMatch = bg.match(/url\(["']?([^"')]+)["']?\)/);
          if (urlMatch && urlMatch[1] && !urlMatch[1].startsWith('data:')) {
            backgroundImages.push({
              index: bgCount,
              url: urlMatch[1],
              selector: el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : ''),
              element: el.tagName.toLowerCase(),
            });
            bgCount++;
          }
        }
      }
    }

    return { images, videos, audio, backgroundImages };
  }, { scopeSelector: options?.selector || null, filter: options?.filter || null });

  return {
    ...result,
    total: result.images.length + result.videos.length + result.audio.length + result.backgroundImages.length,
  };
}
