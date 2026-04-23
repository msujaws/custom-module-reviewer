import { z } from "zod";
import { unsafeBrand, type DNumber } from "./brand.ts";

const DNumberSchema = z.number().int().positive();
const D_NUMBER_PATTERN = /D(\d+)/;

export const parseDNumber = (filename: string): DNumber | null => {
  const match = D_NUMBER_PATTERN.exec(filename);
  if (!match) {
    return null;
  }
  const parsed = Number.parseInt(match[1] ?? "", 10);
  const result = DNumberSchema.safeParse(parsed);
  return result.success ? unsafeBrand<DNumber>(result.data) : null;
};
