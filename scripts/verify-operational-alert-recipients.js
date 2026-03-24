const assert = require('node:assert/strict');

const loadRecipients = (raw) => {
  const normalized = (raw || '').trim();
  if (!normalized) {
    return [];
  }

  if (normalized.startsWith('[')) {
    try {
      const parsed = JSON.parse(normalized);
      if (Array.isArray(parsed)) {
        return parsed
          .map((value) => (typeof value === 'string' ? value.trim().toLowerCase() : ''))
          .filter(Boolean);
      }
    } catch {
      // Fall through to delimiter-based parsing for malformed JSON.
    }
  }

  return normalized
    .split(/[,\n;]/)
    .map((value) => value.trim().replace(/^['"]+|['"]+$/g, '').toLowerCase())
    .filter(Boolean);
};

assert.deepEqual(loadRecipients(''), []);
assert.deepEqual(loadRecipients('foo@example.com, bar@example.com'), ['foo@example.com', 'bar@example.com']);
assert.deepEqual(loadRecipients('foo@example.com\nbar@example.com'), ['foo@example.com', 'bar@example.com']);
assert.deepEqual(loadRecipients('["foo@example.com","bar@example.com"]'), ['foo@example.com', 'bar@example.com']);
assert.deepEqual(loadRecipients(' "foo@example.com" ; "bar@example.com" '), ['foo@example.com', 'bar@example.com']);

console.log('operational alert recipient parsing verification passed');
