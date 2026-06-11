export function invalidParams(message) {
  const error = new Error(message);
  error.code = -32602;
  throw error;
}

function integerRange(min, max) {
  return max === undefined ? `>= ${min}` : `between ${min} and ${max}`;
}

export function validateInteger(value, name, min, max) {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    invalidParams(`${name} must be an integer ${integerRange(min, max)}`);
  }
  if (value < min || (max !== undefined && value > max)) {
    invalidParams(`${name} must be ${integerRange(min, max)}`);
  }
  return value;
}

export function savingsMeta(formatted) {
  return {
    returnedBytes: formatted.returnedBytes,
    savedBytes: formatted.savedBytes,
    savedPercent: formatted.savedPercent,
    estimatedTokensSaved: formatted.estimatedTokensSaved,
  };
}

export function savingsForText(originalText, returnedText) {
  const totalBytes = Buffer.byteLength(originalText, "utf8");
  const returnedBytes = Buffer.byteLength(returnedText, "utf8");
  const savedBytes = Math.max(0, totalBytes - returnedBytes);

  return {
    totalBytes,
    returnedBytes,
    savedBytes,
    savedPercent: totalBytes > 0 ? Math.round((savedBytes / totalBytes) * 100) : 0,
    estimatedTokensSaved: Math.ceil(savedBytes / 4),
  };
}
