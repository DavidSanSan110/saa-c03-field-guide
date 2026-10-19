// Spec 029, AC-5 (review round 1): verificationState hashes with the shared questionDigest and
// with no other copy. vi.mock applies per file, hence this separate file.
import { describe, expect, test, vi } from 'vitest';
import { draft, verification } from './__mocks__/review-fixtures.ts';
import { verificationState } from './review.ts';

vi.mock('@field-guide/questions/verify', async (importOriginal) => {
  const original = await importOriginal<typeof import('@field-guide/questions/verify')>();
  return { ...original, questionDigest: () => 'sentinel-digest' };
});

describe('verificationState with a mocked shared questionDigest', () => {
  const d = draft({ id: 'd1-1.3-0007' });

  test('AC-5: a sidecar holding the mocked digest is verified', () => {
    const sidecar = { verification: verification(d, { digest: 'sentinel-digest' }) };
    expect(verificationState(d.question, sidecar)).toBe('verified');
  });

  test('AC-5: a sidecar holding another digest is changed', () => {
    const sidecar = { verification: verification(d, { digest: 'other' }) };
    expect(verificationState(d.question, sidecar)).toBe('changed');
  });
});
