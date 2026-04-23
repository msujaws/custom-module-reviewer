import { unsafeBrand, type ModuleName, type ModuleSlug } from "./brand.ts";

const NON_ALPHANUMERIC = /[^\da-z]+/g;
const LEADING_OR_TRAILING_HYPHENS = /^-+|-+$/g;

export const toModuleSlug = (name: ModuleName): ModuleSlug => {
  const slug = name
    .toLowerCase()
    .replaceAll(NON_ALPHANUMERIC, "-")
    .replaceAll(LEADING_OR_TRAILING_HYPHENS, "");
  return unsafeBrand<ModuleSlug>(slug);
};
