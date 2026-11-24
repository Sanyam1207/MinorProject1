// Argument validation for agent tools: a JSON-schema subset (AGENT-TOOLS.md §2/§3).
//
// Keywords: `type` (object | string | number | integer | boolean | array | null,
// or a list of them), `properties`, `required`, `additionalProperties`
// (true | schema; anything else → unknown keys are dropped), `items`, `enum`,
// `default`, `nullable`, `minimum` / `maximum` / `exclusiveMinimum` /
// `exclusiveMaximum`, `minLength` / `maxLength`, `pattern`, `minItems` /
// `maxItems`. `description` and every other keyword are ignored here.
//
// Arguments come from an LLM or a regex planner, so validation coerces where
// the intent is unambiguous. Coercion is idempotent: validating the output
// again returns the same value, so the normalised args echoed by a
// needs_confirmation answer are accepted unchanged by the confirmed re-run.
// - strings are trimmed; a number, boolean, Date (ISO) or ObjectId (hex) given
//   for a string becomes a string
// - numeric strings become numbers; integers must be whole numbers
// - "true"/"false", "yes"/"no", "on"/"off", "1"/"0" and 1/0 become booleans
// - a single value given for an array becomes a one-element array, and
//   comma-separated text becomes several items when the items are scalars;
//   a JSON array / object string is parsed when an array / object is expected
// - enum matching is case-insensitive and returns the declared member
// - null, undefined and blank strings mean "not provided" (kept as null only
//   when the schema allows null); declared defaults fill missing properties
// - unknown keys are dropped; `__proto__` / `constructor` / `prototype` never pass

const OMIT = Symbol("omit");
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const TRUE_WORDS = new Set(["true", "yes", "y", "on", "1"]);
const FALSE_WORDS = new Set(["false", "no", "n", "off", "0"]);
const NUMERIC_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
const MAX_DEPTH = 12;
const MAX_ENUM_SHOWN = 40;

export const isPlainObject = (value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
};

const isBlank = (value) => value === undefined || value === null || (typeof value === "string" && value.trim() === "");

const isObjectIdLike = (value) => Boolean(value) && typeof value === "object" && typeof value.toHexString === "function";

const tryJson = (text) => {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
};

const patternCache = new Map();
const compilePattern = (pattern) => {
    if (!patternCache.has(pattern)) {
        let compiled = null;
        try {
            compiled = new RegExp(pattern, "u");
        } catch {
            compiled = null; // an invalid pattern in a tool schema is ignored
        }
        patternCache.set(pattern, compiled);
    }
    return patternCache.get(pattern);
};

/**
 * Deep copy of a JSON-like value: drops functions, symbols and prototype keys,
 * turns Dates into ISO strings and ObjectIds into hex strings.
 */
export const toJsonSafe = (value, depth = 0) => {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
    if (isObjectIdLike(value)) return value.toHexString();
    if (depth >= MAX_DEPTH) return undefined;
    if (Array.isArray(value)) {
        return value.map((item) => toJsonSafe(item, depth + 1)).filter((item) => item !== undefined);
    }
    if (isPlainObject(value)) {
        const out = {};
        for (const [key, item] of Object.entries(value)) {
            if (FORBIDDEN_KEYS.has(key)) continue;
            const copy = toJsonSafe(item, depth + 1);
            if (copy !== undefined) out[key] = copy;
        }
        return out;
    }
    return undefined;
};

const typesOf = (schema) => {
    const { type } = schema;
    if (typeof type === "string") return [type];
    if (Array.isArray(type)) return type.filter((entry) => typeof entry === "string");
    if (isPlainObject(schema.properties)) return ["object"];
    if (schema.items !== undefined) return ["array"];
    return [];
};

const allowsNull = (schema) => schema.nullable === true || typesOf(schema).includes("null");

const TYPE_WORDS = {
    string: "text",
    number: "a number",
    integer: "a whole number",
    boolean: "true or false",
    array: "a list",
    object: "an object",
};

const name = (path) => path || "args";

const report = (errors, path, code, message) => {
    errors.push({ field: name(path), code, message });
    return OMIT;
};

const coerceString = (schema, value, path, errors) => {
    let text;
    if (typeof value === "string") text = value.trim();
    else if ((typeof value === "number" && Number.isFinite(value)) || typeof value === "boolean") text = String(value);
    else if (value instanceof Date && !Number.isNaN(value.getTime())) text = value.toISOString();
    else if (isObjectIdLike(value)) text = value.toHexString();
    else return report(errors, path, "TYPE", `${name(path)} must be text`);
    if (text === "") return OMIT;
    if (Number.isInteger(schema.minLength) && text.length < schema.minLength) {
        return report(errors, path, "LENGTH", `${name(path)} must be at least ${schema.minLength} characters`);
    }
    if (Number.isInteger(schema.maxLength) && text.length > schema.maxLength) {
        return report(errors, path, "LENGTH", `${name(path)} must be at most ${schema.maxLength} characters`);
    }
    if (typeof schema.pattern === "string") {
        const pattern = compilePattern(schema.pattern);
        if (pattern && !pattern.test(text)) return report(errors, path, "PATTERN", `${name(path)} has an invalid format`);
    }
    return text;
};

const coerceNumber = (schema, value, path, errors, integer) => {
    const expected = integer ? "a whole number" : "a number";
    let number;
    if (typeof value === "number") number = value;
    else if (typeof value === "string" && NUMERIC_RE.test(value.trim())) number = Number(value.trim());
    else return report(errors, path, "TYPE", `${name(path)} must be ${expected}`);
    if (!Number.isFinite(number)) return report(errors, path, "TYPE", `${name(path)} must be ${expected}`);
    if (integer && !Number.isInteger(number)) return report(errors, path, "TYPE", `${name(path)} must be a whole number`);
    if (typeof schema.minimum === "number" && number < schema.minimum) {
        return report(errors, path, "RANGE", `${name(path)} must be at least ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && number > schema.maximum) {
        return report(errors, path, "RANGE", `${name(path)} must be at most ${schema.maximum}`);
    }
    if (typeof schema.exclusiveMinimum === "number" && number <= schema.exclusiveMinimum) {
        return report(errors, path, "RANGE", `${name(path)} must be greater than ${schema.exclusiveMinimum}`);
    }
    if (typeof schema.exclusiveMaximum === "number" && number >= schema.exclusiveMaximum) {
        return report(errors, path, "RANGE", `${name(path)} must be less than ${schema.exclusiveMaximum}`);
    }
    return number;
};

const coerceBoolean = (value, path, errors) => {
    if (typeof value === "boolean") return value;
    if (value === 1) return true;
    if (value === 0) return false;
    if (typeof value === "string") {
        const word = value.trim().toLowerCase();
        if (TRUE_WORDS.has(word)) return true;
        if (FALSE_WORDS.has(word)) return false;
    }
    return report(errors, path, "TYPE", `${name(path)} must be true or false`);
};

const SCALAR_TYPES = new Set(["string", "number", "integer", "boolean"]);

// "a, b, c" given for a list of scalars means three items (like UI-ACTIONS idList).
const splitsCommaText = (itemSchema) => {
    if (!itemSchema) return true;
    const types = typesOf(itemSchema).filter((type) => type !== "null");
    return types.length > 0 && types.every((type) => SCALAR_TYPES.has(type));
};

const coerceArray = (schema, value, path, errors, depth) => {
    const itemSchema = isPlainObject(schema.items) ? schema.items : null;
    let list = value;
    if (typeof list === "string") {
        const trimmed = list.trim();
        const parsed = trimmed.startsWith("[") ? tryJson(trimmed) : undefined;
        if (Array.isArray(parsed)) list = parsed;
        else if (splitsCommaText(itemSchema)) list = trimmed.split(",").map((piece) => piece.trim());
    }
    if (!Array.isArray(list)) list = [list];
    const out = [];
    list.forEach((item, index) => {
        if (isBlank(item)) return;
        const coerced = itemSchema
            ? validateValue(itemSchema, item, `${name(path)}[${index}]`, errors, depth + 1)
            : toJsonSafe(item, depth + 1);
        if (coerced !== OMIT && coerced !== undefined) out.push(coerced);
    });
    if (Number.isInteger(schema.minItems) && out.length < schema.minItems) {
        return report(errors, path, "ITEMS", `${name(path)} must have at least ${schema.minItems} item(s)`);
    }
    if (Number.isInteger(schema.maxItems) && out.length > schema.maxItems) {
        return report(errors, path, "ITEMS", `${name(path)} must have at most ${schema.maxItems} item(s)`);
    }
    return out;
};

const coerceObject = (schema, value, path, errors, depth) => {
    let object = value;
    if (typeof object === "string" && object.trim().startsWith("{")) {
        const parsed = tryJson(object.trim());
        if (isPlainObject(parsed)) object = parsed;
    }
    if (!isPlainObject(object)) return report(errors, path, "TYPE", `${name(path)} must be an object`);
    // An object without declared properties is free-form (e.g. open_panel.params).
    if (!isPlainObject(schema.properties) && schema.additionalProperties === undefined) return toJsonSafe(object, depth);
    return validateProperties(schema, object, path, errors, depth);
};

const coerceAs = (type, schema, value, path, errors, depth) => {
    switch (type) {
        case "string": return coerceString(schema, value, path, errors);
        case "number": return coerceNumber(schema, value, path, errors, false);
        case "integer": return coerceNumber(schema, value, path, errors, true);
        case "boolean": return coerceBoolean(value, path, errors);
        case "array": return coerceArray(schema, value, path, errors, depth);
        case "object": return coerceObject(schema, value, path, errors, depth);
        default: return toJsonSafe(value, depth); // unknown type keyword: accept the value as-is
    }
};

const matchEnum = (options, value, path, errors) => {
    const exact = options.find((option) => option === value);
    if (exact !== undefined) return exact;
    if (value !== null && typeof value !== "object") {
        const wanted = String(value).trim().toLowerCase();
        const loose = options.find((option) => option !== null && typeof option !== "object"
            && String(option).toLowerCase() === wanted);
        if (loose !== undefined) return loose;
    }
    const shown = options.slice(0, MAX_ENUM_SHOWN).map(String).join(", ");
    const more = options.length > MAX_ENUM_SHOWN ? ", …" : "";
    return report(errors, path, "ENUM", `${name(path)} must be one of: ${shown}${more}`);
};

function validateValue(schema, value, path, errors, depth = 0) {
    if (depth > MAX_DEPTH) return report(errors, path, "TYPE", `${name(path)} is nested too deeply`);
    if (!isPlainObject(schema)) return toJsonSafe(value, depth);
    if (value === null) return allowsNull(schema) ? null : OMIT;

    const types = typesOf(schema).filter((type) => type !== "null");
    let result;
    if (types.length === 0) {
        result = toJsonSafe(value, depth);
    } else if (types.length === 1) {
        result = coerceAs(types[0], schema, value, path, errors, depth);
    } else {
        result = OMIT;
        for (const type of types) {
            const scratch = [];
            const attempt = coerceAs(type, schema, value, path, scratch, depth);
            if (scratch.length === 0 && attempt !== OMIT) {
                result = attempt;
                break;
            }
        }
        if (result === OMIT) {
            const expected = types.map((type) => TYPE_WORDS[type] || type).join(" or ");
            return report(errors, path, "TYPE", `${name(path)} must be ${expected}`);
        }
    }
    if (result === OMIT || result === undefined) return OMIT;
    if (Array.isArray(schema.enum) && schema.enum.length > 0) return matchEnum(schema.enum, result, path, errors);
    return result;
}

function validateProperties(schema, object, path, errors, depth) {
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    const required = new Set((Array.isArray(schema.required) ? schema.required : []).filter((key) => typeof key === "string"));
    const join = (key) => (path ? `${path}.${key}` : key);
    const out = {};

    for (const [key, rawSchema] of Object.entries(properties)) {
        if (FORBIDDEN_KEYS.has(key)) continue;
        const field = join(key);
        const propertySchema = isPlainObject(rawSchema) ? rawSchema : {};
        let value = Object.hasOwn(object, key) ? object[key] : undefined;
        if (value === null && allowsNull(propertySchema)) {
            out[key] = null;
            continue;
        }
        if (isBlank(value) && propertySchema.default !== undefined) value = structuredClone(propertySchema.default);
        if (isBlank(value)) {
            if (required.has(key)) report(errors, field, "REQUIRED", `${field} is required`);
            continue;
        }
        const coerced = validateValue(propertySchema, value, field, errors, depth + 1);
        if (coerced !== OMIT) out[key] = coerced;
    }

    // Required names that are not declared as properties are kept as given.
    for (const key of required) {
        if (Object.hasOwn(properties, key) || FORBIDDEN_KEYS.has(key)) continue;
        const value = Object.hasOwn(object, key) ? object[key] : undefined;
        if (isBlank(value)) {
            report(errors, join(key), "REQUIRED", `${join(key)} is required`);
            continue;
        }
        const copy = toJsonSafe(typeof value === "string" ? value.trim() : value, depth + 1);
        if (copy !== undefined) out[key] = copy;
    }

    const extra = schema.additionalProperties;
    if (extra === true || isPlainObject(extra)) {
        for (const [key, value] of Object.entries(object)) {
            if (Object.hasOwn(properties, key) || Object.hasOwn(out, key) || FORBIDDEN_KEYS.has(key) || isBlank(value)) continue;
            const coerced = extra === true
                ? toJsonSafe(value, depth + 1)
                : validateValue(extra, value, join(key), errors, depth + 1);
            if (coerced !== OMIT && coerced !== undefined) out[key] = coerced;
        }
    }
    return out;
}

/**
 * Validate and normalise tool arguments against an object schema.
 * `args` may be omitted (→ `{}`) or given as a JSON object string.
 * @returns {{ ok: true, value: object } | { ok: false, errors: Array<{ field: string, code: string, message: string }> }}
 */
export const validateArgs = (schema, args) => {
    let input = args;
    if (input === undefined || input === null) input = {};
    else if (typeof input === "string") {
        const text = input.trim();
        const parsed = text === "" ? {} : tryJson(text);
        if (isPlainObject(parsed)) input = parsed;
    }
    if (!isPlainObject(input)) {
        return { ok: false, errors: [{ field: "args", code: "TYPE", message: "args must be an object of named arguments" }] };
    }
    const root = isPlainObject(schema) ? schema : {};
    const errors = [];
    const value = validateProperties(root, input, "", errors, 0);
    return errors.length ? { ok: false, errors } : { ok: true, value };
};

/** One readable sentence for the LLM, e.g. "Invalid arguments for x: course is required." */
export const formatValidationMessage = (toolName, errors) => {
    const shown = errors.slice(0, 6).map((error) => error.message).join("; ");
    const more = errors.length > 6 ? ` (and ${errors.length - 6} more problems)` : "";
    return `Invalid arguments for ${toolName}: ${shown}${more}.`;
};
