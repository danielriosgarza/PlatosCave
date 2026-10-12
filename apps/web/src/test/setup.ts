import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/react';

// Lazily loaded route chunks are transformed on first use; on a cold start in a slow
// container that exceeds Testing Library's 1000 ms default, and on Windows the 5000 ms that
// is enough elsewhere. Assertions stay unchanged.
configure({ asyncUtilTimeout: process.platform === 'win32' ? 20000 : 5000 });
