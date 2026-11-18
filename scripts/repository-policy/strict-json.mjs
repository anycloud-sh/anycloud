function syntaxError(message, offset) {
  return new SyntaxError(`${message} at offset ${String(offset)}`);
}

/**
 * Parse JSON while rejecting duplicate object keys. JSON.parse silently keeps
 * the last duplicate, which is unsafe for byte-authoritative policy records.
 */
export function parseUniqueJson(source) {
  const text = String(source);
  let offset = 0;

  const whitespace = () => {
    while (/[ \t\n\r]/u.test(text[offset] ?? '')) offset += 1;
  };

  const string = () => {
    const start = offset;
    if (text[offset] !== '"') throw syntaxError('expected string', offset);
    offset += 1;
    while (offset < text.length) {
      const character = text[offset];
      if (character === '"') {
        offset += 1;
        return JSON.parse(text.slice(start, offset));
      }
      if (character === '\\') {
        offset += 1;
        if (text[offset] === 'u') {
          if (!/^[0-9a-fA-F]{4}$/u.test(text.slice(offset + 1, offset + 5))) {
            throw syntaxError('invalid unicode escape', offset);
          }
          offset += 5;
          continue;
        }
        if (!/["\\/bfnrt]/u.test(text[offset] ?? '')) {
          throw syntaxError('invalid string escape', offset);
        }
        offset += 1;
        continue;
      }
      if (character.charCodeAt(0) < 0x20) {
        throw syntaxError('unescaped control character', offset);
      }
      offset += 1;
    }
    throw syntaxError('unterminated string', start);
  };

  const value = () => {
    whitespace();
    const character = text[offset];
    if (character === '"') return string();
    if (character === '{') return object();
    if (character === '[') return array();
    for (const [token, parsed] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ]) {
      if (text.startsWith(token, offset)) {
        offset += token.length;
        return parsed;
      }
    }
    const number = text
      .slice(offset)
      .match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u)?.[0];
    if (!number) throw syntaxError('expected JSON value', offset);
    offset += number.length;
    return JSON.parse(number);
  };

  const array = () => {
    offset += 1;
    whitespace();
    const result = [];
    if (text[offset] === ']') {
      offset += 1;
      return result;
    }
    for (;;) {
      result.push(value());
      whitespace();
      if (text[offset] === ']') {
        offset += 1;
        return result;
      }
      if (text[offset] !== ',') throw syntaxError('expected comma', offset);
      offset += 1;
    }
  };

  const object = () => {
    offset += 1;
    whitespace();
    const result = {};
    const keys = new Set();
    if (text[offset] === '}') {
      offset += 1;
      return result;
    }
    for (;;) {
      whitespace();
      const keyOffset = offset;
      const key = string();
      if (keys.has(key)) throw syntaxError(`duplicate key ${key}`, keyOffset);
      keys.add(key);
      whitespace();
      if (text[offset] !== ':') throw syntaxError('expected colon', offset);
      offset += 1;
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        value: value(),
        writable: true,
      });
      whitespace();
      if (text[offset] === '}') {
        offset += 1;
        return result;
      }
      if (text[offset] !== ',') throw syntaxError('expected comma', offset);
      offset += 1;
    }
  };

  const parsed = value();
  whitespace();
  if (offset !== text.length) {
    throw syntaxError('unexpected trailing content', offset);
  }
  return parsed;
}
