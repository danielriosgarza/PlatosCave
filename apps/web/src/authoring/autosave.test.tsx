import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import { useAutosave } from './autosave';

interface Copy {
  revision: number;
  title: string;
  steps: string;
}

const toValues = (s: Copy) => ({ title: s.title, steps: s.steps });
const unchanged = (a: { title: string }, b: { title: string }) => a.title === b.title;
const partial = () => 'steps not saved yet';

describe('useAutosave resend rules', () => {
  it('Keep mine sends the title when it matches this editor’s last acknowledged copy but not the server’s', async () => {
    const save = vi
      .fn<(v: { title: string; steps: string }, rev: number) => Promise<Copy>>()
      .mockResolvedValueOnce({ revision: 2, title: 'T', steps: '' })
      .mockRejectedValueOnce(
        new ApiError(409, {
          error: 'revision_conflict',
          current: { revision: 3, title: 'U', steps: '' },
        }),
      )
      .mockResolvedValue({ revision: 4, title: 'T', steps: '' });
    const { result } = renderHook(() =>
      useAutosave({
        server: { revision: 1, title: 'S', steps: '' },
        toValues,
        save,
        delayMs: 5,
        partial,
        unchanged,
      }),
    );
    act(() => result.current.change({ title: 'T' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    act(() => result.current.change({ title: 'V' }));
    await waitFor(() => expect(result.current.state.kind).toBe('conflict'));
    // Back to what this editor last had acknowledged, while the server holds U.
    act(() => result.current.change({ title: 'T' }));
    act(() => result.current.keepMine({ revision: 3, title: 'U', steps: '' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(3));
    expect(save).toHaveBeenLastCalledWith({ title: 'T', steps: '' }, 3);
  });

  it('sends nothing while only withheld steps differ from the acknowledged copy', async () => {
    const save = vi.fn<(v: { title: string; steps: string }, rev: number) => Promise<Copy>>();
    const { result } = renderHook(() =>
      useAutosave({
        server: { revision: 1, title: 'S', steps: '' },
        toValues,
        save,
        delayMs: 5,
        partial,
        unchanged,
      }),
    );
    act(() => result.current.change({ steps: 'x' }));
    await waitFor(() => expect(result.current.state.kind).toBe('partial'));
    expect(save).not.toHaveBeenCalled();
  });
});
