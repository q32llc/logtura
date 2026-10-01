type UnknownRecord = Record<string, unknown>;
/** Deterministic JSON: sort object keys, preserve ordered pipeline arrays,
 * reject values JSON would silently discard or coerce. No input mutation. */
export function canonicalConfigJson(value: unknown): string {
    const ancestors = new Set<object>();
    const visit = (item: unknown): unknown => {
        if (item === null || typeof item === "string" || typeof item === "boolean")
            return item;
        if (typeof item === "number" && Number.isFinite(item))
            return item;
        if (!item || typeof item !== "object")
            throw new Error("Configuration must contain only JSON values");
        if (ancestors.has(item))
            throw new Error("Configuration contains a cycle");
        ancestors.add(item);
        let result: unknown;
        if (Array.isArray(item))
            result = Array.from(item, visit);
        else {
            if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)
                throw new Error("Configuration must contain plain objects");
            result = Object.fromEntries(Object.keys(item).sort().map(key => [key, visit((item as UnknownRecord)[key])]));
        }
        ancestors.delete(item);
        return result;
    };
    return JSON.stringify(visit(value));
}
