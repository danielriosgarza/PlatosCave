import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { sessionQuery } from '../session/useSession';
import { CLASS_A, makeMe, studentIn } from '../test/render';
import type { ResultAttempt, Terms } from './api';
import { resultLine } from './Results';
import { TermsPanel } from './TermsPanel';

afterEach(cleanup);

const release = { results: 'manual', at: null, solutions: 'never', hiddenTestDetails: false };
const terms = { late: { policy: 'none' }, allowedMaterials: '', reportedGrade: 'latest', release };

function resultsRow(open: boolean) {
  const client = new QueryClient();
  const me = makeMe({ classes: [{ ...studentIn(CLASS_A, 'Class A'), open }] });
  client.setQueryData(sessionQuery.queryKey, me);
  render(
    <QueryClientProvider client={client}>
      <TermsPanel classId={CLASS_A} terms={terms as unknown as Terms} />
    </QueryClientProvider>,
  );
  return screen.getByText('Results').nextElementSibling?.textContent;
}

const line = (state: string, open?: boolean) =>
  resultLine({ status: 'pending', state, grade: null } as unknown as ResultAttempt, open);

it('A50 in an open class the terms and the attempt name no instructor who releases or reviews', () => {
  expect(resultsRow(true)).toBe('Released once scored');
  expect(line('graded', true)).toBe('Graded · the result is released when the terms say');
  expect(line('needs_review', true)).toBe('Grading could not finish. No score has been recorded.');
});

it('A50 a class that is not open keeps its instructor in the terms and the attempt', () => {
  expect(resultsRow(false)).toBe('Released by your instructor');
  expect(line('graded')).toBe('Graded · your instructor has not released the result yet');
});
