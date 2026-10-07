import { MemoryRouter } from 'react-router-dom';
import { render as renderDom } from '@testing-library/react';
export * from '@testing-library/react';
export function render(ui, options = {}) { return renderDom(ui, { wrapper: MemoryRouter, ...options }); }
