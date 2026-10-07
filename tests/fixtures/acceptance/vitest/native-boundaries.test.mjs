import {beforeEach, afterEach, describe, expect, test, onTestFinished} from 'vitest';
describe('body', () => {
  test('green', () => expect(1).toBe(1));
  test('assertion', () => expect(1).toBe(2));
});
describe('before', () => {
  beforeEach(() => expect(1).toBe(2));
  test('hook', () => {});
});
describe('after', () => {
  afterEach(() => expect(1).toBe(2));
  test('hook', () => {});
});
describe('cleanup', () => {
  beforeEach(() => () => expect(1).toBe(2));
  test('fixture', () => {});
  test('finished', () => onTestFinished(() => expect(1).toBe(2)));
});
test('retried', {retry: 1}, () => expect(1).toBe(2));
test('repeated', {repeats: 1}, () => expect(1).toBe(1));
