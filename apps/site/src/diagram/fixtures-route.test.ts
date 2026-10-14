import { describe, expect, test } from 'vitest';
import { shouldInjectFixtures } from './fixtures-route.ts';

describe('shouldInjectFixtures', () => {
  test('AC-14: FIELD_GUIDE_FIXTURES=1 injects the route in a build', () => {
    expect(shouldInjectFixtures({ FIELD_GUIDE_FIXTURES: '1' }, 'build')).toBe(true);
  });

  test('AC-14: the dev command injects the route without any variable', () => {
    expect(shouldInjectFixtures({}, 'dev')).toBe(true);
  });

  test('AC-14: a plain build does not inject the route', () => {
    expect(shouldInjectFixtures({}, 'build')).toBe(false);
  });

  test('AC-14: FIELD_GUIDE_FIXTURES=0 in a build does not inject the route', () => {
    expect(shouldInjectFixtures({ FIELD_GUIDE_FIXTURES: '0' }, 'build')).toBe(false);
  });

  test('AC-14: FIELD_GUIDE_FIXTURES=true (not 1) in preview does not inject the route', () => {
    expect(shouldInjectFixtures({ FIELD_GUIDE_FIXTURES: 'true' }, 'preview')).toBe(false);
  });

  test('AC-14: an undefined variable counts as not set', () => {
    expect(shouldInjectFixtures({ FIELD_GUIDE_FIXTURES: undefined }, 'build')).toBe(false);
  });

  test('AC-14: the variable also injects the route in dev and preview', () => {
    expect(shouldInjectFixtures({ FIELD_GUIDE_FIXTURES: '1' }, 'dev')).toBe(true);
    expect(shouldInjectFixtures({ FIELD_GUIDE_FIXTURES: '1' }, 'preview')).toBe(true);
  });
});
