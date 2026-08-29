import { createHash } from "node:crypto";

function canonicalize(
  value: unknown,
  ancestors = new Set<object>(),
  encountered = new Set<object>(),
): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite numbers are not supported");
    if (Object.is(value, -0)) return "-0";
    return JSON.stringify(value);
  }
  if (typeof value === "object") {
    if (ancestors.has(value)) throw new Error("cyclic capability inputs are not supported");
    if (encountered.has(value)) {
      throw new Error("shared object references are not supported in JSON capability inputs");
    }
    ancestors.add(value);
    encountered.add(value);
    try {
      if (Array.isArray(value)) {
        const ownKeys = Reflect.ownKeys(value);
        if (
          Object.getPrototypeOf(value) !== Array.prototype ||
          ownKeys.some((key) => typeof key === "symbol") ||
          ownKeys.length !== value.length + 1
        ) {
          throw new Error("capability input arrays must be dense plain JSON arrays");
        }
        const items: string[] = [];
        for (let index = 0; index < value.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (
            descriptor === undefined ||
            !descriptor.enumerable ||
            !("value" in descriptor)
          ) {
            throw new Error("capability input arrays must be dense plain JSON arrays");
          }
          items.push(canonicalize(descriptor.value, ancestors, encountered));
        }
        return `[${items.join(",")}]`;
      }

      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error("capability inputs must contain only plain JSON objects");
      }
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const symbolKeys = Object.getOwnPropertySymbols(value);
      if (symbolKeys.length > 0) {
        throw new Error("symbol-keyed capability input fields are not supported");
      }
      const entries = Object.keys(descriptors)
        .sort()
        .map((key) => {
          const descriptor = descriptors[key];
          if (
            descriptor === undefined ||
            !descriptor.enumerable ||
            !("value" in descriptor)
          ) {
            throw new Error("capability input fields must be enumerable data properties");
          }
          return `${JSON.stringify(key)}:${canonicalize(descriptor.value, ancestors, encountered)}`;
        });
      if (entries.length !== Reflect.ownKeys(value).length) {
        throw new Error("non-enumerable capability input fields are not supported");
      }
      return `{${entries.join(",")}}`;
    } finally {
      ancestors.delete(value);
    }
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
