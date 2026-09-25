import * as fs from 'node:fs';
import * as path from 'node:path';

export function createPrecisionLossCandidate(
  target: string,
  contents: string,
  readFileId: (file: string) => bigint = file => fs.lstatSync(file, { bigint: true }).ino,
): bigint {
  if (fs.existsSync(target)) throw new Error('Precision fixture target already exists');
  const directory = path.dirname(target);
  if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('Precision fixture directory must not be linked');
  const pool = fs.mkdtempSync(path.join(directory, 'ntfs-id-'));
  let aboveSafe = 0;
  try {
    for (let batch = 0; batch < 512; batch++) {
      const files: string[] = [];
      for (let slot = 0; slot < 2; slot++) {
        const file = path.join(pool, `candidate-${slot}`);
        fs.writeFileSync(file, contents, { flag: 'wx' });
        files.push(file);
        const inode = readFileId(file);
        if (inode > BigInt(Number.MAX_SAFE_INTEGER)) aboveSafe++;
        if (inode > BigInt(Number.MAX_SAFE_INTEGER) && String(Number(inode)) !== String(inode)) {
          fs.linkSync(file, target);
          return inode;
        }
      }
      for (const file of files) fs.unlinkSync(file);
    }
    throw new Error(`No precision-losing NTFS file ID within 1024 file creations (${aboveSafe} above-safe observations)`);
  } finally {
    fs.rmSync(pool, { recursive: true, force: true });
  }
}
