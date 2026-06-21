import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  classifyDataFile,
  discoverDesktopAiChatStorage,
  formatDiscoveryMarkdown,
} from '../scripts/desktop-ai-chat-storage-discovery';

function withTempHome(fn: (root: string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-ai-storage-'));
  try {
    fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function mkdirp(targetPath: string) {
  fs.mkdirSync(targetPath, { recursive: true });
}

describe('desktop AI chat storage discovery', () => {
  test('reports only metadata for synthetic app and storage roots', () => {
    withTempHome(root => {
      const appsDir = path.join(root, 'Applications');
      const appDir = path.join(appsDir, 'ChatGPT.app');
      mkdirp(path.join(appDir, 'Contents'));
      fs.writeFileSync(
        path.join(appDir, 'Contents/Info.plist'),
        `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.openai.chat.test</string>
</dict></plist>`
      );

      const supportDir = path.join(root, 'Library/Application Support/ChatGPT');
      const indexedDbDir = path.join(supportDir, 'IndexedDB');
      mkdirp(indexedDbDir);
      fs.writeFileSync(path.join(indexedDbDir, 'CURRENT'), 'MANIFEST-000001');
      fs.writeFileSync(path.join(supportDir, 'salary-discussion.data'), 'PRIVATE_CHAT_SECRET: hello world');

      const discoveries = discoverDesktopAiChatStorage({
        homeDir: root,
        applicationsDirs: [appsDir],
      });
      const chatgpt = discoveries.find(discovery => discovery.provider === 'ChatGPT Desktop');

      expect(chatgpt?.installed).toBe(true);
      expect(chatgpt?.decision).toBe('promising but brittle');
      expect(chatgpt?.entries.some(entry => entry.bundleIdentifier === 'com.openai.chat.test')).toBe(true);
      expect(chatgpt?.entries.some(entry => entry.path.includes('<redacted-private-file-001.data>'))).toBe(true);

      const jsonOutput = JSON.stringify(discoveries, null, 2);
      const markdownOutput = formatDiscoveryMarkdown(discoveries);
      expect(jsonOutput).not.toContain('PRIVATE_CHAT_SECRET');
      expect(markdownOutput).not.toContain('PRIVATE_CHAT_SECRET');
      expect(jsonOutput).not.toContain('salary-discussion.data');
      expect(markdownOutput).not.toContain('salary-discussion.data');
      expect(jsonOutput).toContain('private header/content not inspected');
    });
  });

  test('header classification is explicit opt-in for synthetic approved samples', () => {
    withTempHome(root => {
      const appsDir = path.join(root, 'Applications');
      const appDir = path.join(appsDir, 'ChatGPT.app');
      mkdirp(path.join(appDir, 'Contents'));
      fs.writeFileSync(
        path.join(appDir, 'Contents/Info.plist'),
        `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.openai.chat.test</string>
</dict></plist>`
      );

      const supportDir = path.join(root, 'Library/Application Support/ChatGPT');
      mkdirp(supportDir);
      fs.writeFileSync(path.join(supportDir, 'synthetic.data'), Buffer.from([0x1f, 0x8b, 0x08, 0x00]));

      const discoveries = discoverDesktopAiChatStorage({
        homeDir: root,
        applicationsDirs: [appsDir],
        allowHeaderRead: true,
      });
      const jsonOutput = JSON.stringify(discoveries, null, 2);

      expect(jsonOutput).toContain('.data file, gzip-compressed');
      expect(jsonOutput).not.toContain('synthetic.data');
    });
  });

  test('treats Gemini as not installed without a dedicated app bundle', () => {
    withTempHome(root => {
      const supportDir = path.join(root, 'Library/Application Support/Gemini');
      mkdirp(path.join(supportDir, 'IndexedDB'));

      const discoveries = discoverDesktopAiChatStorage({
        homeDir: root,
        applicationsDirs: [path.join(root, 'Applications')],
      });
      const gemini = discoveries.find(discovery => discovery.provider === 'Gemini');

      expect(gemini?.installed).toBe(false);
      expect(gemini?.decision).toBe('not feasible');
      expect(gemini?.entries.some(entry => entry.path === supportDir && entry.exists)).toBe(true);
    });
  });

  test('does not treat Perplexity-only group containers as Comet installation', () => {
    withTempHome(root => {
      mkdirp(path.join(root, 'Library/Group Containers/group.ai.perplexity.app'));

      const discoveries = discoverDesktopAiChatStorage({
        homeDir: root,
        applicationsDirs: [path.join(root, 'Applications')],
      });
      const comet = discoveries.find(discovery => discovery.provider === 'Comet');
      const perplexity = discoveries.find(discovery => discovery.provider === 'Perplexity');

      expect(comet?.installed).toBe(false);
      expect(comet?.decision).toBe('not feasible');
      expect(perplexity?.installed).toBe(true);
    });
  });

  test('treats Grok-like local containers as local target evidence', () => {
    withTempHome(root => {
      const grokContainer = path.join(root, 'Library/Containers/com.xai.grok');
      mkdirp(grokContainer);

      const discoveries = discoverDesktopAiChatStorage({
        homeDir: root,
        applicationsDirs: [path.join(root, 'Applications')],
      });
      const grok = discoveries.find(discovery => discovery.provider === 'Grok');

      expect(grok?.installed).toBe(true);
      expect(grok?.decision).toBe('not feasible');
      expect(grok?.entries.some(entry => entry.path === grokContainer)).toBe(true);
    });
  });

  test('classifies data-file headers without returning header bytes', () => {
    withTempHome(root => {
      const sqliteData = path.join(root, 'sqlite.data');
      const gzipData = path.join(root, 'gzip.data');
      const binaryData = path.join(root, 'binary.data');
      fs.writeFileSync(sqliteData, Buffer.concat([Buffer.from('SQLite format 3\0', 'binary'), Buffer.alloc(16)]));
      fs.writeFileSync(gzipData, Buffer.from([0x1f, 0x8b, 0x08, 0x00]));
      fs.writeFileSync(binaryData, Buffer.from([0x00, 0xff, 0xaa, 0x13]));

      expect(classifyDataFile(sqliteData)).toBe('.data file, SQLite database');
      expect(classifyDataFile(gzipData)).toBe('.data file, gzip-compressed');
      expect(classifyDataFile(binaryData)).toBe('.data file, custom/encrypted binary or unknown compression');
    });
  });
});
