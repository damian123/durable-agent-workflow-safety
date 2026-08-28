import { createHash } from "node:crypto";

function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite numbers are not supported");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    const entries = Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`);
    return `{${entries.join(",")}}`;
  }
  throw new Error(`unsupported value in capability input: ${typeof value}`);
}

export function actionInputHash(
  capabilityName: string,
  capabilityVersion: string,
  input: unknown,
): string {
  const canonical = canonicalize({
    capabilityName,
    capabilityVersion,
    input,
  });
  return createHash("sha256").update(canonical).digest("hex");
}
