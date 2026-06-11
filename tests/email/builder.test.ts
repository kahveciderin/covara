import { describe, it, expect } from "vitest";
import { createEmail } from "@/email";

describe("Email template builder", () => {
  it("renders HTML and a plaintext fallback", () => {
    const { html, text } = createEmail({ brandColor: "#ff0000" })
      .preview("Preview line")
      .heading("Welcome")
      .text("Thanks for joining.")
      .button("Confirm", "https://example.com/confirm?token=abc")
      .footer("You received this because you signed up.")
      .build();

    expect(html).toContain("<!doctype html>");
    expect(html).toContain("Welcome");
    expect(html).toContain("#ff0000");
    expect(html).toContain("https://example.com/confirm?token=abc");
    expect(html).toContain("Preview line");

    expect(text).toContain("Welcome");
    expect(text).toContain("Thanks for joining.");
    expect(text).toContain("Confirm: https://example.com/confirm?token=abc");
  });

  it("escapes HTML in user content", () => {
    const { html } = createEmail().text('<script>alert("x")</script>').build();
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders a verification code block", () => {
    const { html, text } = createEmail().heading("Your code").code("123456").build();
    expect(html).toContain("123456");
    expect(text).toContain("123456");
  });

  it("supports a logo when themed", () => {
    const { html } = createEmail({ logoUrl: "https://cdn.example.com/logo.png", logoAlt: "Acme" })
      .text("hi")
      .build();
    expect(html).toContain("https://cdn.example.com/logo.png");
    expect(html).toContain("Acme");
  });
});
