import { randomUUID } from 'crypto';
import { NextFunction, Request, Response } from 'express';

export interface RequestWithId extends Request {
  requestId?: string;
}

/**
 * Generates a server-side UUID v4 X-Request-Id for every request.
 * Any client-supplied X-Request-Id header is ignored (Contract §0.17).
 */
export function requestIdMiddleware(req: RequestWithId, res: Response, next: NextFunction): void {
  const requestId = randomUUID();
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  next();
}
