import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiscussionComposer, type PostProblem } from './DiscussionComposer';

afterEach(cleanup);

const setup = (over: { body?: string; problem?: PostProblem; posting?: boolean } = {}) => {
  const onPost = vi.fn();
  const onBody = vi.fn();
  const onAudience = vi.fn();
  render(
    <DiscussionComposer
      audience="instructor"
      onAudience={onAudience}
      body={over.body ?? ''}
      onBody={onBody}
      problem={over.problem ?? null}
      posting={over.posting ?? false}
      onPost={onPost}
      textareaId="q"
      placeholder="Ask about this"
    />,
  );
  return { onPost, onBody, onAudience };
};

describe('DiscussionComposer', () => {
  it('A05 posts only with text, and offers the audience choice', async () => {
    const user = userEvent.setup();
    const { onPost, onAudience } = setup({ body: 'Why?' });
    await user.selectOptions(screen.getByLabelText('Visible to'), 'class');
    expect(onAudience).toHaveBeenCalledWith('class');
    await user.click(screen.getByRole('button', { name: 'Post' }));
    expect(onPost).toHaveBeenCalledOnce();
  });

  it('A05 Post is disabled while empty or posting', () => {
    setup({ body: '  ' });
    expect(screen.getByRole('button', { name: 'Post' })).toBeDisabled();
    cleanup();
    setup({ body: 'x', posting: true });
    expect(screen.getByRole('button', { name: 'Post' })).toBeDisabled();
  });

  it('A05 an offline attempt keeps the text and the button becomes Retry', () => {
    setup({ body: 'x', problem: 'offline' });
    expect(screen.getByRole('status')).toHaveTextContent(
      'Offline · your text is kept on this device. Post when you are back online.',
    );
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled();
  });

  it('A05 a failed attempt says the text is kept', () => {
    setup({ body: 'x', problem: 'failed' });
    expect(screen.getByRole('status')).toHaveTextContent('Could not post. Your text is kept.');
  });
});
