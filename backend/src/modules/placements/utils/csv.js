// CSV export (docs/contracts/PLACEMENTS.md §6.2): UTF-8 BOM, CRLF rows, formula-injection guard.
const FORMULA_START = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\r\n]/;

export const MAX_CSV_ROWS = 10_000;

/** Escape one cell value. */
export const csvCell = (value) => {
    if (value === null || value === undefined) return "";
    let text = value instanceof Date ? value.toISOString() : String(value);
    if (FORMULA_START.test(text)) text = `'${text}`;
    if (NEEDS_QUOTES.test(text)) text = `"${text.replace(/"/g, '""')}"`;
    return text;
};

/**
 * @param {Array<{header: string, value: (row: any) => any}>} columns
 * @param {any[]} rows
 * @returns {string} BOM + header + rows, joined by \r\n
 */
export const toCsv = (columns, rows) => {
    const lines = [columns.map((column) => csvCell(column.header)).join(",")];
    for (const row of rows.slice(0, MAX_CSV_ROWS)) {
        lines.push(columns.map((column) => csvCell(column.value(row))).join(","));
    }
    return `﻿${lines.join("\r\n")}`;
};

/** "Google India" → "google-india" (filenames). */
export const slug = (value, fallback = "export") => {
    const text = String(value ?? "")
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40);
    return text || fallback;
};
