/**
 * Minimal line diff (longest common subsequence) for small files.
 * Returns [{ type: "same" | "add" | "remove", text }].
 */
export const diffLines = (before, after) => {
  const a = before.split("\n");
  const b = after.split("\n");
  const table = Array.from({ length: a.length + 1 }, () =>
    new Array(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] =
        a[i] === b[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const lines = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ type: "same", text: a[i] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      lines.push({ type: "remove", text: a[i] });
      i += 1;
    } else {
      lines.push({ type: "add", text: b[j] });
      j += 1;
    }
  }
  while (i < a.length) lines.push({ type: "remove", text: a[i++] });
  while (j < b.length) lines.push({ type: "add", text: b[j++] });
  return lines;
};

/** Keep changed lines plus `context` lines around them. */
export const hunk = (lines, context = 3) => {
  const keep = new Set();
  lines.forEach((line, index) => {
    if (line.type === "same") return;
    for (let k = index - context; k <= index + context; k += 1) keep.add(k);
  });
  const result = [];
  let previous = -1;
  lines.forEach((line, index) => {
    if (!keep.has(index)) return;
    if (previous >= 0 && index !== previous + 1)
      result.push({ type: "gap", text: "…" });
    result.push({ ...line, number: index + 1 });
    previous = index;
  });
  return result;
};
