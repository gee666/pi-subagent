import { describe, it, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { requestLogger } from "../requestLogger.js";
import type { Request, Response, NextFunction } from "express";

// ---------------------------------------------------------------------------
// Helpers – minimal mocks that satisfy the types used by the middleware
// ---------------------------------------------------------------------------

function makeReq(method = "GET", path = "/hello"): Request {
  return { method, path } as unknown as Request;
}

function makeRes(statusCode = 200): {
  res: Response;
  emit: (event: string) => void;
} {
  const listeners: Record<string, Array<() => void>> = {};

  const res = {
    statusCode,
    on(event: string, cb: () => void) {
      (listeners[event] ??= []).push(cb);
    },
  } as unknown as Response;

  return {
    res,
    emit(event: string) {
      (listeners[event] ?? []).forEach((cb) => cb());
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("requestLogger", () => {
  let writtenLines: string[] = [];
  let originalWrite: typeof process.stdout.write;

  beforeEach(() => {
    writtenLines = [];
    originalWrite = process.stdout.write.bind(process.stdout);
    // Intercept stdout so tests stay silent and we can inspect output
    process.stdout.write = ((chunk: string) => {
      writtenLines.push(chunk);
      return true;
    }) as unknown as typeof process.stdout.write;
  });

  afterEach(() => {
    process.stdout.write = originalWrite;
  });

  it("calls next()", () => {
    const nextCalled = mock.fn();
    const { res } = makeRes();
    requestLogger(makeReq(), res, nextCalled as unknown as NextFunction);
    assert.equal(nextCalled.mock.calls.length, 1);
  });

  it("logs nothing before the response finishes", () => {
    const { res } = makeRes();
    requestLogger(makeReq(), res, (() => {}) as NextFunction);
    assert.equal(writtenLines.length, 0, "should not log before finish");
  });

  it("logs a valid JSON line on finish", () => {
    const { res, emit } = makeRes(201);
    requestLogger(makeReq("POST", "/items"), res, (() => {}) as NextFunction);
    emit("finish");

    assert.equal(writtenLines.length, 1);
    const entry = JSON.parse(writtenLines[0]);
    assert.equal(entry.method, "POST");
    assert.equal(entry.path, "/items");
    assert.equal(entry.status, 201);
    assert.ok(typeof entry.durationMs === "number" && entry.durationMs >= 0);
  });

  it("captures the correct status code", () => {
    const { res, emit } = makeRes(404);
    requestLogger(makeReq("GET", "/missing"), res, (() => {}) as NextFunction);
    emit("finish");

    const entry = JSON.parse(writtenLines[0]);
    assert.equal(entry.status, 404);
  });

  it("output line ends with a newline", () => {
    const { res, emit } = makeRes();
    requestLogger(makeReq(), res, (() => {}) as NextFunction);
    emit("finish");

    assert.ok(writtenLines[0].endsWith("\n"));
  });
});
