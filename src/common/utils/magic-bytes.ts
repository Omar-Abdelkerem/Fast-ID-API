import { AllowedDocumentMimeType } from '../../modules/services/service-definition.types';

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/**
 * Sniffs actual file type from magic bytes for JPEG, PNG, and PDF (Design D-09, §8).
 * Never trusts client-declared Content-Type or filename extension.
 */
export function sniffAllowedMimeType(buffer: Buffer): AllowedDocumentMimeType | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }

  if (buffer.length >= PNG_MAGIC.length) {
    let isPng = true;
    for (let i = 0; i < PNG_MAGIC.length; i += 1) {
      if (buffer[i] !== PNG_MAGIC[i]) {
        isPng = false;
        break;
      }
    }
    if (isPng) {
      return 'image/png';
    }
  }

  if (
    buffer.length >= 4 &&
    buffer[0] === 0x25 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x44 &&
    buffer[3] === 0x46
  ) {
    return 'application/pdf';
  }

  return null;
}

export function extensionForMimeType(mimeType: AllowedDocumentMimeType): string {
  switch (mimeType) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'application/pdf':
      return 'pdf';
  }
}
