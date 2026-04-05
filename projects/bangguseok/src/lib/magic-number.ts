/**
 * 버퍼의 첫 바이트 서명(Magic Number)을 확인하여
 * 클라이언트가 제공한 MIME 타입 주장을 맹신하지 않고 방어합니다.
 * 
 * @param buffer 업로드된 파일의 버퍼
 * @returns 판별된 진짜 파일 타입 ('image/jpeg', 'image/png', 'image/webp', 'image/heic') 혹은 null
 */
export function getMimeTypeFromMagicNumber(buffer: Buffer): string | null {
  if (buffer.length < 12) return null;

  // JPEG: FF D8 FF
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    return 'image/jpeg';
  }

  // PNG: 89 50 4E 47 (0x89 "PNG")
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4E &&
    buffer[3] === 0x47
  ) {
    return 'image/png';
  }

  // WEBP: "RIFF" (0-3바이트) + "WEBP" (8-11바이트)
  if (
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) {
    return 'image/webp';
  }
  
  // HEIC/HEIF: offset 4-7 bytes are "ftyp", offset 8-11 bytes are "heic", "heix", "mif1", "msf1"
  const ftyp = buffer.toString('ascii', 4, 8);
  const brand = buffer.toString('ascii', 8, 12);
  
  if (ftyp === 'ftyp') {
    if (['heic', 'heix', 'mif1', 'msf1'].includes(brand)) {
      return 'image/heic';
    }
  }

  return null;
}
