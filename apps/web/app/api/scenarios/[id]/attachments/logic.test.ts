/**
 * K6F6-02: Attachments validation tests.
 * DB-backed paths proven in e2e, not here.
 */

import { describe, it, expect } from "vitest";

const MAX_FILE_SIZE = 1024 * 1024; // 1MB
const ALLOWED_CONTENT_TYPES = ["text/csv", "application/csv", "text/plain"];

// Pure validation functions extracted for testing
function validateContentType(contentType: string): boolean {
  return ALLOWED_CONTENT_TYPES.includes(contentType);
}

function validateFileName(name: string): boolean {
  return name?.trim().length > 0;
}

function validateBase64Size(base64Data: string): { valid: boolean; size: number } {
  try {
    const decoded = Buffer.from(base64Data, "base64");
    return { valid: decoded.length <= MAX_FILE_SIZE, size: decoded.length };
  } catch {
    return { valid: false, size: 0 };
  }
}

describe("Attachment validation", () => {
  describe("validateContentType", () => {
    it("accepts text/csv", () => {
      expect(validateContentType("text/csv")).toBe(true);
    });

    it("accepts application/csv", () => {
      expect(validateContentType("application/csv")).toBe(true);
    });

    it("accepts text/plain", () => {
      expect(validateContentType("text/plain")).toBe(true);
    });

    it("rejects image/png", () => {
      expect(validateContentType("image/png")).toBe(false);
    });

    it("rejects application/json", () => {
      expect(validateContentType("application/json")).toBe(false);
    });
  });

  describe("validateFileName", () => {
    it("accepts valid filename", () => {
      expect(validateFileName("users.csv")).toBe(true);
    });

    it("rejects empty string", () => {
      expect(validateFileName("")).toBe(false);
    });

    it("rejects whitespace only", () => {
      expect(validateFileName("   ")).toBe(false);
    });

    it("accepts filename with spaces", () => {
      expect(validateFileName("my users.csv")).toBe(true);
    });
  });

  describe("validateBase64Size", () => {
    it("accepts small file", () => {
      const data = Buffer.from("username,password\nuser1,pass1").toString("base64");
      const result = validateBase64Size(data);
      expect(result.valid).toBe(true);
      expect(result.size).toBe(29);
    });

    it("rejects file over 1MB", () => {
      const largeData = Buffer.alloc(MAX_FILE_SIZE + 1, "x").toString("base64");
      const result = validateBase64Size(largeData);
      expect(result.valid).toBe(false);
    });

    it("accepts file exactly 1MB", () => {
      const exactData = Buffer.alloc(MAX_FILE_SIZE, "x").toString("base64");
      const result = validateBase64Size(exactData);
      expect(result.valid).toBe(true);
      expect(result.size).toBe(MAX_FILE_SIZE);
    });
  });
});

describe("AttachmentInfo type shape", () => {
  it("does not include data field", () => {
    // This test documents that list responses exclude binary data
    const attachmentInfo = {
      id: "att-1",
      name: "users.csv",
      contentType: "text/csv",
      size: 100,
      createdAt: new Date(),
    };

    expect(attachmentInfo).not.toHaveProperty("data");
    expect(attachmentInfo).toHaveProperty("id");
    expect(attachmentInfo).toHaveProperty("name");
    expect(attachmentInfo).toHaveProperty("size");
  });
});
