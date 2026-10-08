// `label_regex`: a regular expression matched against stored labels.
//
// Upstream hands the pattern to the database's REGEXP, which on Dolt is Go's RE2: linear time, no
// backreferences, no lookaround. This server runs the JavaScript engine inside a Durable Object shared
// by every tracker, and that engine backtracks, so `^(a+)+$` against thirty `a`s and a `!` would burn the
// object's CPU for everyone. A pattern is therefore accepted only when it is in a subset both engines
// read the same way AND cannot backtrack badly:
//
//  - at most 128 characters, at most 3 quantifiers (so a match costs O(n^3) in a label of at most 255
//    characters, never exponential);
//  - no backreferences, lookaround, named or flagged groups: `(?:` is the only `(?` form;
//  - no quantified group that itself contains a quantifier or an alternation (`(a+)+`, `(a|a)*`);
//  - only escapes both engines agree on (`\d \D \w \W \s \S \b \B \t \n \r \f \v` and escaped punctuation).
//
// Anything else is `invalid_argument` on `label_regex`. This is a declared deviation (docs/profile.md).
import { invalid } from "./problem";

export const MAX_REGEX_LENGTH = 128;
export const MAX_REGEX_QUANTIFIERS = 3;
export const MAX_LABEL_LENGTH = 255;

const refuse = (detail: string) => invalid("label_regex", `unsupported label_regex: ${detail}`);

interface Group {
  quantifier: boolean;
  alternation: boolean;
}

/** Validates a pattern and returns the compiled expression; throws `invalid_argument` otherwise. */
export function compileLabelRegex(pattern: string): RegExp {
  if ([...pattern].length > MAX_REGEX_LENGTH) throw refuse(`longer than ${MAX_REGEX_LENGTH} characters`);
  const stack: Group[] = [{ quantifier: false, alternation: false }];
  let quantifiers = 0;
  const chars = [...pattern];
  const quantifierAt = (i: number): number => {
    // The length of the quantifier starting at i (including a lazy `?`), or 0.
    const c = chars[i];
    let len = 0;
    if (c === "*" || c === "+" || c === "?") len = 1;
    else if (c === "{") {
      const m = /^\{\d+(,\d*)?\}/.exec(chars.slice(i, i + 24).join(""));
      if (m) len = m[0].length;
    }
    if (len > 0 && chars[i + len] === "?") len++;
    return len;
  };

  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    const top = stack[stack.length - 1]!;
    if (c === "\\") {
      const next = chars[i + 1];
      if (next === undefined) throw refuse("a trailing backslash");
      if (/[0-9]/.test(next)) throw refuse("backreferences and octal escapes are not supported");
      if (/[A-Za-z]/.test(next) && !/[dDwWsSbBtnrfv]/.test(next)) throw refuse(`the escape \\${next} is not supported`);
      i++;
      continue;
    }
    if (c === "[") {
      // A character class: its content is literal for our purposes, except escapes and the closing bracket.
      let j = i + 1;
      if (chars[j] === "^") j++;
      if (chars[j] === "]") j++;
      for (; j < chars.length && chars[j] !== "]"; j++) {
        if (chars[j] === "\\") {
          const next = chars[j + 1];
          if (next === undefined) throw refuse("an unterminated character class");
          if (/[0-9]/.test(next) || (/[A-Za-z]/.test(next) && !/[dDwWsStnrfv]/.test(next))) throw refuse(`the escape \\${next} is not supported`);
          j++;
        } else if (chars[j] === "[" && chars[j + 1] === ":") throw refuse("POSIX classes are not supported");
      }
      if (j >= chars.length) throw refuse("an unterminated character class");
      i = j;
      continue;
    }
    if (c === "(") {
      if (chars[i + 1] === "?") {
        if (chars[i + 2] !== ":") throw refuse("only the plain group (?: ) is supported; lookaround, named groups and flags are not");
        i += 2;
      }
      stack.push({ quantifier: false, alternation: false });
      continue;
    }
    if (c === ")") {
      if (stack.length === 1) throw refuse("an unmatched )");
      const group = stack.pop()!;
      const parent = stack[stack.length - 1]!;
      const q = quantifierAt(i + 1);
      if (q > 0) {
        // `(...)?` is at most one repetition; every other quantifier on a group may repeat it.
        if (chars[i + 1] !== "?" && (group.quantifier || group.alternation)) {
          throw refuse("a repeated group may not itself contain a quantifier or an alternation");
        }
        quantifiers++;
        parent.quantifier = true;
        i += q;
      }
      parent.quantifier ||= group.quantifier;
      parent.alternation ||= group.alternation;
      continue;
    }
    if (c === "|") {
      top.alternation = true;
      continue;
    }
    const q = quantifierAt(i);
    if (q > 0) {
      quantifiers++;
      top.quantifier = true;
      i += q - 1;
      continue;
    }
    if (c === "{" || c === "}") continue;
  }
  if (stack.length !== 1) throw refuse("an unclosed (");
  if (quantifiers > MAX_REGEX_QUANTIFIERS) throw refuse(`more than ${MAX_REGEX_QUANTIFIERS} quantifiers`);
  try {
    return new RegExp(pattern);
  } catch {
    throw invalid("label_regex", `${JSON.stringify(pattern)} is not a valid regular expression`);
  }
}

/** Whether a label matches; a label longer than the storage bound never does. */
export const labelMatches = (re: RegExp, label: string): boolean => [...label].length <= MAX_LABEL_LENGTH && re.test(label);
