import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Express 4 doesn't catch rejected promises from async handlers — an unhandled
 * DB error would hang the request. Wrap async handlers so rejections flow to
 * the error middleware (which returns the consistent { error } shape).
 */
export function asyncHandler(
  fn: (req: Request, res: Response) => Promise<unknown>,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}
