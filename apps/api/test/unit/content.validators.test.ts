import { describe, expect, it } from "vitest";
import {
  heroSchema,
  curatedSectionSchema,
  announcementSchema,
} from "../../src/validators/content.validators.js";

/**
 * Joi schemas for the home content editor. Mirrors the runtime options used by
 * the `validate` middleware (`stripUnknown` + `abortEarly: false`).
 */

const OPTIONS = { stripUnknown: true, abortEarly: false, convert: true };

const validSlide = () => ({
  mediaType: "image",
  mediaUrl: "https://res.cloudinary.com/demo/hero.jpg",
  title: "Nueva colección",
  isActive: true,
});

describe("heroSchema", () => {
  it("accepts a valid slide list and strips unknown fields", () => {
    const { error, value } = heroSchema.validate(
      { slides: [{ ...validSlide(), hacker: "x" }], extra: true },
      OPTIONS,
    );

    expect(error).toBeUndefined();
    expect(value.slides[0]).not.toHaveProperty("hacker");
    expect(value).not.toHaveProperty("extra");
  });

  it("rejects more than 8 slides", () => {
    const slides = Array.from({ length: 9 }, validSlide);
    const { error } = heroSchema.validate({ slides }, OPTIONS);
    expect(error).toBeDefined();
  });

  it("rejects non-https media URLs", () => {
    const { error } = heroSchema.validate(
      { slides: [{ ...validSlide(), mediaUrl: "http://insecure.com/a.jpg" }] },
      OPTIONS,
    );
    expect(error).toBeDefined();
  });

  it("rejects a CTA label without its href (and vice versa)", () => {
    const withLabelOnly = heroSchema.validate(
      { slides: [{ ...validSlide(), ctaLabel: "Ver colección" }] },
      OPTIONS,
    );
    const withHrefOnly = heroSchema.validate(
      { slides: [{ ...validSlide(), ctaHref: "/coleccion/verano" }] },
      OPTIONS,
    );
    expect(withLabelOnly.error).toBeDefined();
    expect(withHrefOnly.error).toBeDefined();
  });

  it("accepts a relative path or https URL as ctaHref", () => {
    const relative = heroSchema.validate(
      { slides: [{ ...validSlide(), ctaLabel: "Ver", ctaHref: "/coleccion/verano" }] },
      OPTIONS,
    );
    const absolute = heroSchema.validate(
      { slides: [{ ...validSlide(), ctaLabel: "Ver", ctaHref: "https://mariamatera.com/x" }] },
      OPTIONS,
    );
    const javascript = heroSchema.validate(
      { slides: [{ ...validSlide(), ctaLabel: "Ver", ctaHref: "javascript:alert(1)" }] },
      OPTIONS,
    );
    expect(relative.error).toBeUndefined();
    expect(absolute.error).toBeUndefined();
    expect(javascript.error).toBeDefined();
  });

  it("rejects an invalid mediaType", () => {
    const { error } = heroSchema.validate(
      { slides: [{ ...validSlide(), mediaType: "gif" }] },
      OPTIONS,
    );
    expect(error).toBeDefined();
  });
});

describe("curatedSectionSchema", () => {
  it("accepts a list of unique object ids", () => {
    const { error } = curatedSectionSchema.validate(
      { productIds: ["a".repeat(24), "b".repeat(24)], isActive: true },
      OPTIONS,
    );
    expect(error).toBeUndefined();
  });

  it("rejects duplicated ids, malformed ids and more than 12", () => {
    const dup = curatedSectionSchema.validate(
      { productIds: ["a".repeat(24), "a".repeat(24)], isActive: true },
      OPTIONS,
    );
    const malformed = curatedSectionSchema.validate(
      { productIds: ["not-an-id"], isActive: true },
      OPTIONS,
    );
    const tooMany = curatedSectionSchema.validate(
      {
        productIds: Array.from({ length: 13 }, (_, i) =>
          i.toString(16).padStart(24, "0"),
        ),
        isActive: true,
      },
      OPTIONS,
    );
    expect(dup.error).toBeDefined();
    expect(malformed.error).toBeDefined();
    expect(tooMany.error).toBeDefined();
  });
});

describe("announcementSchema", () => {
  it("accepts a valid bar announcement", () => {
    const { error } = announcementSchema.validate(
      { text: "Envío gratis todo julio", type: "bar", isActive: true },
      OPTIONS,
    );
    expect(error).toBeUndefined();
  });

  it("rejects empty text, text over 200 chars and invalid type", () => {
    const empty = announcementSchema.validate({ text: "", type: "bar", isActive: true }, OPTIONS);
    const long = announcementSchema.validate(
      { text: "x".repeat(201), type: "bar", isActive: true },
      OPTIONS,
    );
    const badType = announcementSchema.validate(
      { text: "Hola", type: "banner", isActive: true },
      OPTIONS,
    );
    expect(empty.error).toBeDefined();
    expect(long.error).toBeDefined();
    expect(badType.error).toBeDefined();
  });

  it("requires isActive explicitly", () => {
    const { error } = announcementSchema.validate({ text: "Hola", type: "popup" }, OPTIONS);
    expect(error).toBeDefined();
  });
});
