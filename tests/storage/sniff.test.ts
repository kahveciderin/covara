import { describe, it, expect } from "vitest";
import { sniffContentType, resolveContentType, isActiveContentType } from "@/storage/sniff";
import { fixtures } from "./fixtures";

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("sniffContentType", () => {
  it.each([
    ["png", fixtures.png, "image/png"],
    ["jpeg", fixtures.jpeg, "image/jpeg"],
    ["gif", fixtures.gif, "image/gif"],
    ["webp", fixtures.webp, "image/webp"],
    ["avif", fixtures.avif, "image/avif"],
    ["heic", fixtures.heic, "image/heic"],
    ["pdf", fixtures.pdf, "application/pdf"],
    ["zip", fixtures.zip, "application/zip"],
    ["gzip", fixtures.gzip, "application/gzip"],
    ["mp4", fixtures.mp4, "video/mp4"],
    ["mov", fixtures.mov, "video/quicktime"],
    ["webm", fixtures.webm, "video/webm"],
    ["mp3 (id3)", fixtures.mp3, "audio/mpeg"],
    ["wav", fixtures.wav, "audio/wav"],
    ["ogg", fixtures.ogg, "audio/ogg"],
  ])("detects %s by magic bytes", (_name, data, expected) => {
    const result = sniffContentType(data);
    expect(result.mimeType).toBe(expected);
    expect(result.magic).toBe(true);
    expect(result.active).toBe(false);
  });

  it.each([
    ["<!DOCTYPE html><html></html>", "text/html"],
    ["  \n<html><body>x</body></html>", "text/html"],
    ["﻿<script>alert(1)</script>", "text/html"],
    ["<!-- comment --><p>x", "text/html"],
    ["<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>", "image/svg+xml"],
    ["<?xml version=\"1.0\"?><svg xmlns=\"http://www.w3.org/2000/svg\"/>", "image/svg+xml"],
    ["<?xml version=\"1.0\"?><note><to>x</to></note>", "application/xml"],
  ])("flags active markup %#", (content, expected) => {
    const result = sniffContentType(bytes(content));
    expect(result.mimeType).toBe(expected);
    expect(result.active).toBe(true);
  });

  it("detects JSON and plain text", () => {
    expect(sniffContentType(bytes('{"a":1}')).mimeType).toBe("application/json");
    expect(sniffContentType(bytes("[1,2,3]")).mimeType).toBe("application/json");
    expect(sniffContentType(bytes("hello world")).mimeType).toBe("text/plain");
    expect(sniffContentType(bytes("{not json")).mimeType).toBe("text/plain");
    expect(sniffContentType(bytes("a < b and <abc> is not a tag")).mimeType).toBe("text/plain");
    expect(sniffContentType(bytes("héllo wörld ✓")).mimeType).toBe("text/plain");
  });

  it("treats JSON prefixes of truncated samples as JSON", () => {
    expect(sniffContentType(bytes('{"a": [1, 2'), { complete: false }).mimeType).toBe("application/json");
  });

  it("does not reject a UTF-8 sequence cut at the sample boundary", () => {
    const full = bytes("ab✓");
    const cut = full.subarray(0, full.length - 1);
    expect(sniffContentType(cut, { complete: false }).mimeType).toBe("text/plain");
  });

  it("reports unknown binary and empty content", () => {
    expect(sniffContentType(new Uint8Array([0, 1, 2, 3, 255, 0])).family).toBe("binary");
    const empty = sniffContentType(new Uint8Array());
    expect(empty.family).toBe("empty");
    expect(empty.magic).toBe(false);
  });

  it("does not match truncated signatures", () => {
    expect(sniffContentType(fixtures.png.subarray(0, 4)).mimeType).not.toBe("image/png");
  });
});

describe("isActiveContentType", () => {
  it("covers html, svg, xml, js and +xml types", () => {
    for (const t of ["text/html", "TEXT/HTML; charset=utf-8", "image/svg+xml", "application/xml", "text/xml", "application/javascript", "application/xhtml+xml", "application/rss+xml"]) {
      expect(isActiveContentType(t)).toBe(true);
    }
    for (const t of ["image/png", "text/plain", "application/json", "application/pdf", ""]) {
      expect(isActiveContentType(t)).toBe(false);
    }
  });
});

describe("resolveContentType (enforce)", () => {
  it("accepts a matching declared type", () => {
    const d = resolveContentType({ declared: "image/png", bytes: fixtures.png });
    expect(d.rejected).toBe(false);
    expect(d.mimeType).toBe("image/png");
  });

  it("rejects HTML declared as an image", () => {
    const d = resolveContentType({ declared: "image/png", bytes: bytes("<html><script>alert(1)</script></html>") });
    expect(d.rejected).toBe(true);
    expect(d.reason).toBe("active_content_mismatch");
  });

  it("rejects SVG declared as an image/png", () => {
    const d = resolveContentType({ declared: "image/png", bytes: bytes("<svg onload=alert(1)></svg>") });
    expect(d.rejected).toBe(true);
  });

  it("rejects HTML declared as text/plain", () => {
    const d = resolveContentType({ declared: "text/plain", bytes: bytes("<!doctype html><p>hi") });
    expect(d.rejected).toBe(true);
  });

  it("accepts HTML honestly declared as text/html (active, served safely on download)", () => {
    const d = resolveContentType({ declared: "text/html", bytes: bytes("<html></html>") });
    expect(d.rejected).toBe(false);
    expect(d.mimeType).toBe("text/html");
  });

  it("uses the sniffed type when the declared type is generic", () => {
    expect(resolveContentType({ declared: "application/octet-stream", bytes: fixtures.jpeg }).mimeType).toBe("image/jpeg");
    expect(resolveContentType({ declared: "", bytes: fixtures.pdf }).mimeType).toBe("application/pdf");
    expect(resolveContentType({ declared: null, bytes: bytes("<svg></svg>") }).mimeType).toBe("image/svg+xml");
  });

  it("corrects a mislabelled-but-harmless declared type to the sniffed type", () => {
    const d = resolveContentType({ declared: "text/plain", bytes: fixtures.png });
    expect(d.rejected).toBe(false);
    expect(d.mimeType).toBe("image/png");
  });

  it("rejects a declared magic type whose content has a different signature", () => {
    const d = resolveContentType({ declared: "image/png", bytes: fixtures.pdf });
    expect(d.rejected).toBe(true);
    expect(d.reason).toBe("signature_mismatch");
  });

  it("rejects a declared magic type whose content has no signature (spoofed/truncated)", () => {
    expect(resolveContentType({ declared: "image/png", bytes: bytes("just text") }).rejected).toBe(true);
    expect(resolveContentType({ declared: "image/png", bytes: fixtures.png.subarray(0, 4) }).rejected).toBe(true);
  });

  it("rejects zero-byte content declared as a magic type, accepts empty text", () => {
    expect(resolveContentType({ declared: "image/png", bytes: new Uint8Array() }).rejected).toBe(true);
    const text = resolveContentType({ declared: "text/plain", bytes: new Uint8Array() });
    expect(text.rejected).toBe(false);
    expect(text.mimeType).toBe("text/plain");
    expect(resolveContentType({ declared: "", bytes: new Uint8Array() }).mimeType).toBe("application/octet-stream");
  });

  it("rejects image polyglots carrying script markup", () => {
    const polyglot = new Uint8Array([...fixtures.gif, ...bytes("/*<script>alert(1)</script>*/")]);
    const d = resolveContentType({ declared: "image/gif", bytes: polyglot });
    expect(d.rejected).toBe(true);
    expect(d.reason).toBe("polyglot");
  });

  it("keeps specific zip-container types (docx/xlsx) declared over application/zip", () => {
    const docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    const d = resolveContentType({ declared: docx, bytes: fixtures.zip });
    expect(d.rejected).toBe(false);
    expect(d.mimeType).toBe(docx);
  });

  it("treats ISO-BMFF siblings (mp4/mov) as compatible", () => {
    const d = resolveContentType({ declared: "video/mp4", bytes: fixtures.mov });
    expect(d.rejected).toBe(false);
    expect(d.mimeType).toBe("video/mp4");
  });

  it("normalises image aliases (image/jpg)", () => {
    const d = resolveContentType({ declared: "image/jpg", bytes: fixtures.jpeg });
    expect(d.rejected).toBe(false);
    expect(d.mimeType).toBe("image/jpeg");
  });

  it("keeps a textual declared type for text content (csv)", () => {
    const d = resolveContentType({ declared: "text/csv", bytes: bytes("a,b\n1,2\n") });
    expect(d.mimeType).toBe("text/csv");
  });

  it("downgrades an active declared type the content does not confirm", () => {
    const d = resolveContentType({ declared: "text/html", bytes: bytes("plain words") });
    expect(d.rejected).toBe(false);
    expect(d.mimeType).toBe("text/plain");
  });
});

describe("resolveContentType (other policies)", () => {
  it("lenient uses the sniffed type but never rejects", () => {
    const d = resolveContentType({ declared: "image/png", bytes: bytes("<html></html>"), policy: "lenient" });
    expect(d.rejected).toBe(false);
    expect(d.mimeType).toBe("text/html");
  });

  it("trust-declared keeps the declared type without sniffing", () => {
    const d = resolveContentType({ declared: "image/png", bytes: bytes("<html></html>"), policy: "trust-declared" });
    expect(d.rejected).toBe(false);
    expect(d.mimeType).toBe("image/png");
    expect(d.sniffed).toBeNull();
  });
});
