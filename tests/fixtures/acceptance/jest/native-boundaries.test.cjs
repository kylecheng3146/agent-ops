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
