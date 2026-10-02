import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLASS_A, makeMe, renderApp, signedInWithTopics, stubApi, studentIn } from './render';

vi.mock('../topics/TopicIndex', () => ({
  TopicIndex: () => {
    throw new Error('render failure');
  },
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('route failures', () => {
  it('says the page could not be shown, not that the session failed, when a page throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    stubApi(signedInWithTopics(makeMe({ classes: [studentIn(CLASS_A, 'Class A')] })));
    renderApp(`/classes/${CLASS_A}/topics`);
    expect(await screen.findByText('This page could not be shown.')).toBeInTheDocument();
    expect(screen.queryByText(/session could not be checked/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
  });
});
