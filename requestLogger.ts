import type { Request, Response, NextFunction } from "express";

export interface RequestLogEntry {
  method: string;
  path: string;
  status: number;
  durationMs: number;
}

/**
 * Express middleware that logs each request as a structured JSON entry.
 *
 * Fields logged:
 *   method     – HTTP verb (GET, POST, …)
 *   path       – Request URL path
 *   status     – HTTP response status code
 *   durationMs – Round-trip time in milliseconds
 *
 * Usage:
 *   import { requestLogger } from "./requestLogger.js";
 *   app.use(requestLogger);
 */
export function requestLogger(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const startedAt = Date.now();

  // Hook into the 'finish' event so we capture the final status code after
  // all downstream middleware and route handlers have run.
  res.on("finish", () => {
    const entry: RequestLogEntry = {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
    };

    process.stdout.write(JSON.stringify(entry) + "\n");
  });

  next();
}
