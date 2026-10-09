import { describe, it, expect } from "vitest";
import { describeErrorBody } from "@/client/errors";

describe("describeErrorBody", () => {
  it("prefers an RFC 7807 detail and carries code + field errors", () => {
    const errors = [{ field: "email", message: "required" }];
    expect(
      describeErrorBody(
        { type: "/problems/validation", title: "Validation failed", status: 400, detail: "Email is required", code: "VALIDATION_ERROR", errors },
        400
      )
    ).toEqual({ message: "Email is required", code: "VALIDATION_ERROR", details: errors });
  });

  it("falls back to the problem title when there is no detail", () => {
    expect(describeErrorBody({ title: "Not found", status: 404 }, 404).message).toBe("Not found");
  });

  it("reads the { error: { message, code, details } } envelope", () => {
    expect(describeErrorBody({ error: { message: "Nope", code: "E_NOPE", details: { a: 1 } } }, 400)).toEqual({
      message: "Nope",
      code: "E_NOPE",
      details: { a: 1 },
    });
  });

  it("reads a bare { error: string }", () => {
    expect(describeErrorBody({ error: "User not found" }, 404)).toEqual({ message: "User not found", code: "HTTP_ERROR" });
  });

  it("reads a bare { message: string }", () => {
    expect(describeErrorBody({ message: "Too many requests" }, 429).message).toBe("Too many requests");
  });

  it("uses a plain-text body", () => {
    expect(describeErrorBody("  upstream timeout \n", 504).message).toBe("upstream timeout");
  });

  it("falls back to the status for empty or unrecognized bodies", () => {
    expect(describeErrorBody(undefined, 500).message).toBe("HTTP 500");
    expect(describeErrorBody("", 500).message).toBe("HTTP 500");
    expect(describeErrorBody({ error: "" }, 502).message).toBe("HTTP 502");
    expect(describeErrorBody({ foo: 1 }, 400, "Request failed (400)").message).toBe("Request failed (400)");
  });
});
