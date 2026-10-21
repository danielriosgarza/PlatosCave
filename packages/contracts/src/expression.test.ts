import { describe, expect, it } from 'vitest';
import {
  evaluate,
  expressionProblem,
  formatNumber,
  holds,
  interpolate,
  parseExpression,
  placeholders,
  quantityValue,
} from './expression';

const value = (source: string, scope: Record<string, number> = {}) => {
  const parsed = parseExpression(source);
  if (!parsed.ok) throw new Error(parsed.message);
  return evaluate(parsed.expr, scope);
};

describe('expressions', () => {
  it('A42 evaluates arithmetic with the usual precedence and right-associative powers', () => {
    expect(value('1 + 2 * 3')).toBe(7);
    expect(value('(1 + 2) * 3')).toBe(9);
    expect(value('2 ^ 3 ^ 2')).toBe(512);
    expect(value('-2 ^ 2')).toBe(-4);
    expect(value('10 % 4 - 1')).toBe(1);
    expect(value('2 * pi')).toBeCloseTo(Math.PI * 2);
    expect(value('m * x + c', { m: 2, x: 3, c: -1 })).toBe(5);
    expect(value('sqrt(16) + abs(-2) + round(2.345, 2)')).toBeCloseTo(8.35);
    expect(value('exp(0) + ln(e) + log(8, 2)')).toBe(5);
  });

  it('A42 reads point parameters, conditions and the conditional operator', () => {
    expect(value('P.y / P.x', { 'P.x': 2, 'P.y': 4 })).toBe(2);
    expect(value('x > 1 && x < 3 ? 10 : 20', { x: 2 })).toBe(10);
    expect(value('!(x == 2) || x != 2', { x: 2 })).toBe(0);
    expect(holds('near(a, 1, 0.01)', { a: 1.005 })).toBe(true);
    expect(holds('between(a, 0, 1)', { a: 2 })).toBe(false);
    // A name the scope does not hold reads as NaN, which no condition accepts.
    expect(holds('missing > 0 || missing <= 0', {})).toBe(false);
  });

  it('A42 names what is wrong with an expression in an author’s words', () => {
    expect(expressionProblem('m * x', ['m', 'x'])).toBeUndefined();
    expect(expressionProblem('k * x', ['m', 'x'])).toBe(
      '“k * x” uses k, which is not defined here (defined: m, x)',
    );
    expect(expressionProblem('2x', ['x'])).toMatch(/write \* between 2 and what follows it/);
    expect(expressionProblem('sin(x', ['x'])).toMatch(/“sin\(x”:/);
    expect(expressionProblem('log(x)', ['x'])).toMatch(/log/);
    expect(expressionProblem('', [])).toBe('“”: the expression is empty');
    expect(expressionProblem('1+'.repeat(200), [])).toMatch(/longer than 300 characters/);
  });

  it('A42 cannot reach JavaScript: object prototype names are neither functions nor values', () => {
    for (const source of ['constructor', 'toString(1)', '__proto__', 'hasOwnProperty(1)']) {
      const parsed = parseExpression(source);
      const read = parsed.ok ? evaluate(parsed.expr, {}) : Number.NaN;
      expect(Number.isNaN(read), source).toBe(true);
    }
    expect(quantityValue('constructor', { constructor: 3 })).toBe(3);
    expect(expressionProblem('alert(1)', [])).toMatch(/alert/);
  });

  it('A42 fills label placeholders with formatted values', () => {
    expect(placeholders('slope {P.y / P.x:2}, n = {n}')).toEqual([
      { source: 'P.y / P.x', digits: 2 },
      { source: 'n' },
    ]);
    expect(interpolate('slope {P.y / P.x:2}, n = {n}', { 'P.x': 3, 'P.y': 1, n: 7 })).toBe(
      'slope 0.33, n = 7',
    );
    expect(formatNumber(0.1 + 0.2)).toBe('0.3');
    expect(formatNumber(-0.0001)).toBe('0');
    expect(formatNumber(Number.NaN)).toBe('–');
  });
});
