declare const brand: unique symbol;

export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type BugId = Brand<number, "BugId">;
export type DNumber = Brand<number, "DNumber">;
export type RevisionPHID = Brand<string, "RevisionPHID">;
export type UserPHID = Brand<string, "UserPHID">;
export type ModuleName = Brand<string, "ModuleName">;
export type ModuleSlug = Brand<string, "ModuleSlug">;
export type AttachmentId = Brand<number, "AttachmentId">;

export const unsafeBrand = <B>(value: unknown): B => value as B;
