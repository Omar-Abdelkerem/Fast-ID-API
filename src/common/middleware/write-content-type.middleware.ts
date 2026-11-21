import { NextFunction, Request, Response } from 'express';
import { AppException } from '../errors/app-exception';

const WRITE_METHODS = new Set(['POST', 'PATCH', 'DELETE', 'PUT']);
const ATTACHMENT_UPLOAD_PATH_REGEX = /^\/api\/v1\/applications\/[^/]+\/attachments\/?$/;

function extractMediaType(contentTypeHeader: string): string {
  return contentTypeHeader.split(';')[0]?.trim().toLowerCase() ?? '';
}

function requestHasBody(req: Request): boolean {
  const transferEncoding = req.headers['transfer-encoding'];
  if (transferEncoding && transferEncoding.trim() !== '') {
    return true;
  }

  const contentLengthHeader = req.headers['content-length'];
  if (contentLengthHeader === undefined) {
    return false;
  }

  const parsedLength = Number.parseInt(contentLengthHeader, 10);
  return Number.isNaN(parsedLength) || parsedLength > 0;
}

function sendErrorEnvelope(res: Response, exception: AppException): void {
  res.setHeader('Cache-Control', 'no-store');
  res.vary('Origin');
  res.status(exception.getStatus()).json(exception.toEnvelope());
}

/**
 * Enforces Contract §0.2, §0.9, and Design D-24:
 * - Write requests with a body require application/json (or multipart/form-data on §4.9).
 * - Any disallowed Content-Type on a write request is rejected with 415 UNSUPPORTED_MEDIA_TYPE
 *   even if the body is empty.
 * - Bodyless writes accept an omitted Content-Type, empty body with application/json, or {} with application/json.
 */
export function writeContentTypeMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!WRITE_METHODS.has(req.method.toUpperCase())) {
    next();
    return;
  }

  const rawPath = (req.originalUrl || req.url || '').split('?')[0];
  const isAttachmentUpload =
    req.method.toUpperCase() === 'POST' && ATTACHMENT_UPLOAD_PATH_REGEX.test(rawPath);

  const rawContentType = req.headers['content-type'];
  const hasContentType = rawContentType !== undefined;
  const mediaType = typeof rawContentType === 'string' ? extractMediaType(rawContentType) : '';

  if (isAttachmentUpload) {
    if (!hasContentType || mediaType !== 'multipart/form-data') {
      sendErrorEnvelope(
        res,
        new AppException(
          'UNSUPPORTED_MEDIA_TYPE',
          'Attachment uploads require multipart/form-data Content-Type.',
        ),
      );
      return;
    }
    next();
    return;
  }

  if (hasContentType) {
    if (mediaType !== 'application/json') {
      sendErrorEnvelope(
        res,
        new AppException('UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.'),
      );
      return;
    }
    next();
    return;
  }

  if (requestHasBody(req)) {
    sendErrorEnvelope(
      res,
      new AppException(
        'UNSUPPORTED_MEDIA_TYPE',
        'Write requests with a body must specify Content-Type: application/json.',
      ),
    );
    return;
  }

  next();
}
