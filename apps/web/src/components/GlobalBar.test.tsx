import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { GlobalBar } from './GlobalBar';

describe('GlobalBar', () => {
  it('shows the brand, the Courses and Topics links and the neighbouring-topics landmark', () => {
    render(<GlobalBar />);
    expect(screen.getByText('Parallax')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Courses' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Topics' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Neighbouring topics' })).toBeInTheDocument();
  });
});
