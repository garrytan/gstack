/**
 * Unit tests for browse/src/media-extract.ts — the media-discovery logic
 * shared by the `media` and `scrape` commands.
 *
 * All of extractMedia's logic lives inside the page.evaluate() callback.
 * Playwright serializes that callback to the browser, but the function itself
 * is pure over the DOM globals it touches (`document`, `getComputedStyle`),
 * so instead of exporting internals or launching a browser these tests pass a
 * fake target whose evaluate() invokes the real callback in-process against a
 * minimal mock DOM. No product code was modified.
 *
 * Globals are installed/restored inside each run (never at module scope) so
 * nothing leaks to sibling test files sharing this shard process.
 */
import { describe, test, expect } from 'bun:test';
import { extractMedia, type MediaResult } from '../src/media-extract';

type Dom = Record<string, any[]>;

/** querySelector/querySelectorAll over a selector → elements map. */
function queryable(map: Dom) {
  return {
    querySelectorAll: (sel: string) => map[sel] ?? [],
    querySelector: (sel: string) => (map[sel] ?? [])[0] ?? null,
  };
}

const VISIBLE_RECT = { width: 100, height: 50, bottom: 400, right: 300 };
const HIDDEN_RECT = { width: 0, height: 0, bottom: 0, right: 0 };

function imgEl(overrides: Record<string, unknown> = {}, attrs: Record<string, string> = {}, rect = VISIBLE_RECT) {
  return {
    src: '', srcset: '', currentSrc: '', alt: '',
    width: 0, height: 0, naturalWidth: 0, naturalHeight: 0, loading: '',
    getAttribute: (name: string) => attrs[name] ?? null,
    getBoundingClientRect: () => rect,
    ...overrides,
  };
}

function videoEl(overrides: Record<string, unknown> = {}, sources: Array<{ src?: string; type?: string }> = []) {
  return {
    src: '', currentSrc: '', poster: '',
    videoWidth: 0, width: 0, videoHeight: 0, height: 0, duration: 0,
    querySelectorAll: (sel: string) => (sel === 'source' ? sources : []),
    ...overrides,
  };
}

function audioEl(overrides: Record<string, unknown> = {}, source: { src?: string; type?: string } | null = null) {
  return {
    src: '', currentSrc: '', duration: 0,
    querySelector: (sel: string) => (sel === 'source' ? source : null),
    ...overrides,
  };
}

/** An element visible only to the background-image pass (`*` + getComputedStyle). */
function bgEl(backgroundImage: string, opts: { tagName?: string; id?: string; className?: unknown } = {}) {
  return {
    tagName: opts.tagName ?? 'DIV',
    id: opts.id ?? '',
    className: opts.className ?? '',
    __backgroundImage: backgroundImage,
  };
}

/**
 * Run the REAL extractMedia against a mock document. The fake target's
 * evaluate() calls the callback with its argument, exactly as Playwright does
 * in the browser — resolving `document`/`getComputedStyle` to our shims.
 */
async function extract(
  dom: Dom,
  options?: Parameters<typeof extractMedia>[1],
): Promise<MediaResult> {
  const g = globalThis as any;
  const savedDocument = g.document;
  const savedGcs = g.getComputedStyle;
  g.document = queryable(dom);
  g.getComputedStyle = (el: any) => ({ backgroundImage: el.__backgroundImage ?? 'none' });
  try {
    const target = { evaluate: (fn: any, arg: any) => Promise.resolve(fn(arg)) } as any;
    return await extractMedia(target, options);
  } finally {
    g.document = savedDocument;
    g.getComputedStyle = savedGcs;
  }
}

describe('extractMedia: images', () => {
  test('collects attributes, dimensions, and the lazy-load data-src fallback chain', async () => {
    const result = await extract({
      img: [
        imgEl({
          src: 'https://cdn.example.com/hero.jpg',
          srcset: 'hero-2x.jpg 2x',
          currentSrc: 'https://cdn.example.com/hero-2x.jpg',
          alt: 'Hero',
          width: 640, height: 480, naturalWidth: 1280, naturalHeight: 960,
          loading: 'lazy',
        }, { 'data-lazy-src': 'lazy.jpg' }),
      ],
    });
    expect(result.images).toHaveLength(1);
    const img = result.images[0];
    expect(img.index).toBe(0);
    expect(img.src).toBe('https://cdn.example.com/hero.jpg');
    expect(img.srcset).toBe('hero-2x.jpg 2x');
    expect(img.currentSrc).toBe('https://cdn.example.com/hero-2x.jpg');
    expect(img.alt).toBe('Hero');
    expect(img.naturalWidth).toBe(1280);
    expect(img.loading).toBe('lazy');
    // No data-src → falls through to data-lazy-src.
    expect(img.dataSrc).toBe('lazy.jpg');
    expect(img.visible).toBe(true);
    expect(result.total).toBe(1);
  });

  test('data-src wins over the later fallbacks, data-original is last', async () => {
    const first = await extract({ img: [imgEl({}, { 'data-src': 'a.jpg', 'data-lazy-src': 'b.jpg', 'data-original': 'c.jpg' })] });
    expect(first.images[0].dataSrc).toBe('a.jpg');
    const last = await extract({ img: [imgEl({}, { 'data-original': 'c.jpg' })] });
    expect(last.images[0].dataSrc).toBe('c.jpg');
    const none = await extract({ img: [imgEl()] });
    expect(none.images[0].dataSrc).toBe('');
  });

  test('a zero-size or fully offscreen rect marks the image not visible', async () => {
    const result = await extract({
      img: [
        imgEl({}, {}, HIDDEN_RECT),
        // Above/left of the viewport: bottom and right are negative.
        imgEl({}, {}, { width: 10, height: 10, bottom: -5, right: -5 }),
        imgEl({}, {}, VISIBLE_RECT),
      ],
    });
    expect(result.images.map(index => index.visible)).toEqual([false, false, true]);
  });
});

describe('extractMedia: videos', () => {
  test('detects HLS from either the mime type or an .m3u8 source URL', async () => {
    const result = await extract({
      video: [
        videoEl({}, [{ src: 'https://v.example.com/stream.m3u8', type: '' }]),
        videoEl({}, [{ src: 'https://v.example.com/stream', type: 'application/x-mpegURL' }]),
        videoEl({ src: 'plain.mp4' }, [{ src: 'plain.mp4', type: 'video/mp4' }]),
      ],
    });
    expect(result.videos.map(v => v.isHLS)).toEqual([true, true, false]);
    expect(result.videos[2].type).toBe('video/mp4');
  });

  test('detects DASH from either the mime type or an .mpd source URL', async () => {
    const result = await extract({
      video: [
        videoEl({}, [{ src: 'https://v.example.com/manifest.mpd', type: '' }]),
        videoEl({}, [{ src: 'https://v.example.com/manifest', type: 'application/dash+xml' }]),
      ],
    });
    expect(result.videos.map(v => v.isDASH)).toEqual([true, true]);
  });

  test('an Infinity duration (live stream) is reported as 0; intrinsic size beats attributes', async () => {
    const result = await extract({
      video: [videoEl({ duration: Infinity, videoWidth: 1920, width: 640, videoHeight: 1080, height: 360 })],
    });
    expect(result.videos[0].duration).toBe(0);
    expect(result.videos[0].width).toBe(1920);
    expect(result.videos[0].height).toBe(1080);
  });

  test('collects every <source> child with src and type', async () => {
    const sources = [
      { src: 'a.webm', type: 'video/webm' },
      { src: 'a.mp4', type: 'video/mp4' },
    ];
    const result = await extract({ video: [videoEl({ poster: 'poster.jpg' }, sources)] });
    expect(result.videos[0].sources).toEqual(sources);
    expect(result.videos[0].poster).toBe('poster.jpg');
    expect(result.videos[0].type).toBe('video/webm'); // first source's type
  });
});

describe('extractMedia: audio', () => {
  test('falls back to the <source> child when the element has no src, NaN duration → 0', async () => {
    const result = await extract({
      audio: [audioEl({ duration: NaN }, { src: 'track.ogg', type: 'audio/ogg' })],
    });
    expect(result.audio[0].src).toBe('track.ogg');
    expect(result.audio[0].type).toBe('audio/ogg');
    expect(result.audio[0].duration).toBe(0);
  });

  test('element src wins over the source child', async () => {
    const result = await extract({
      audio: [audioEl({ src: 'direct.mp3', duration: 12.5 }, { src: 'child.ogg', type: 'audio/ogg' })],
    });
    expect(result.audio[0].src).toBe('direct.mp3');
    expect(result.audio[0].duration).toBe(12.5);
  });
});

describe('extractMedia: CSS background images', () => {
  test('parses url(...) in quoted and unquoted forms, skipping none and data: URIs', async () => {
    const result = await extract({
      '*': [
        bgEl('url("https://cdn.example.com/bg.png")'),
        bgEl("url('https://cdn.example.com/bg2.png')"),
        bgEl('url(https://cdn.example.com/bg3.png)'),
        bgEl('none'),
        bgEl('url(data:image/png;base64,AAAA)'),
      ],
    });
    expect(result.backgroundImages.map(b => b.url)).toEqual([
      'https://cdn.example.com/bg.png',
      'https://cdn.example.com/bg2.png',
      'https://cdn.example.com/bg3.png',
    ]);
    expect(result.backgroundImages.map(b => b.index)).toEqual([0, 1, 2]);
  });

  test('builds a tag#id.class selector; a non-string className (SVG) contributes no class part', async () => {
    const result = await extract({
      '*': [
        bgEl('url(a.png)', { tagName: 'SECTION', id: 'hero', className: ' banner  large ' }),
        bgEl('url(b.png)', { tagName: 'SVG', className: { baseVal: 'svg-class' } }),
      ],
    });
    expect(result.backgroundImages[0].selector).toBe('section#hero.banner.large');
    expect(result.backgroundImages[0].element).toBe('section');
    expect(result.backgroundImages[1].selector).toBe('svg');
  });

  test('caps background-image extraction at 500 elements', async () => {
    const many = Array.from({ length: 520 }, (_, i) => bgEl(`url(bg-${i}.png)`));
    const result = await extract({ '*': many });
    expect(result.backgroundImages).toHaveLength(500);
    expect(result.backgroundImages[499].url).toBe('bg-499.png');
    expect(result.total).toBe(500);
  });
});

describe('extractMedia: filter and scope options', () => {
  const FULL_DOM: Dom = {
    img: [imgEl({ src: 'i.png' })],
    video: [videoEl({ src: 'v.mp4' })],
    audio: [audioEl({ src: 'a.mp3' })],
    '*': [bgEl('url(bg.png)')],
  };

  test('no filter returns every category and total sums them', async () => {
    const result = await extract(FULL_DOM);
    expect(result.images).toHaveLength(1);
    expect(result.videos).toHaveLength(1);
    expect(result.audio).toHaveLength(1);
    expect(result.backgroundImages).toHaveLength(1);
    expect(result.total).toBe(4);
  });

  test("filter: 'videos' excludes images, audio, and background images", async () => {
    const result = await extract(FULL_DOM, { filter: 'videos' });
    expect(result.videos).toHaveLength(1);
    expect(result.images).toEqual([]);
    expect(result.audio).toEqual([]);
    expect(result.backgroundImages).toEqual([]);
    expect(result.total).toBe(1);
  });

  test("filter: 'images' includes background images (they are image media)", async () => {
    const result = await extract(FULL_DOM, { filter: 'images' });
    expect(result.images).toHaveLength(1);
    expect(result.backgroundImages).toHaveLength(1);
    expect(result.videos).toEqual([]);
    expect(result.audio).toEqual([]);
    expect(result.total).toBe(2);
  });

  test('a selector scopes extraction to the matching subtree', async () => {
    const scoped = {
      ...queryable({ img: [imgEl({ src: 'scoped.png' })] }),
    };
    const result = await extract({ img: [imgEl({ src: 'global.png' })], '#gallery': [scoped] }, { selector: '#gallery' });
    expect(result.images).toHaveLength(1);
    expect(result.images[0].src).toBe('scoped.png');
  });

  test('a selector matching nothing falls back to the whole document', async () => {
    const result = await extract({ img: [imgEl({ src: 'global.png' })] }, { selector: '#missing' });
    expect(result.images).toHaveLength(1);
    expect(result.images[0].src).toBe('global.png');
  });
});
