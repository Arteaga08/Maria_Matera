import slugifyLib from "slugify";

/**
 * Slug helpers. `slugify` normalizes text to a URL-safe slug; `uniqueSlug`
 * appends a numeric suffix until the slug is free in the given collection.
 */

interface SlugModel {
  exists(filter: { slug: string }): Promise<unknown>;
}

const slugify = (text: string): string =>
  slugifyLib(text, { lower: true, strict: true, trim: true });

const uniqueSlug = async (model: SlugModel, base: string): Promise<string> => {
  const root = slugify(base) || "item";
  let candidate = root;
  let suffix = 1;
  while (await model.exists({ slug: candidate })) {
    candidate = `${root}-${suffix}`;
    suffix += 1;
  }
  return candidate;
};

export { slugify, uniqueSlug };
