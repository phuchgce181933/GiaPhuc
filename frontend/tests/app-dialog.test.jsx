import { expect, test, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import AppDialog, { confirmDialog, promptDialog } from '../src/components/common/AppDialog';
afterEach(cleanup);
test('rename uses an app popup, supports cancel and returns the entered name', async () => {
  render(<AppDialog />); let result;
  act(() => { result = promptDialog('Tên mới', 'Toán'); });
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Tiếng Anh' } });
  fireEvent.click(screen.getByRole('button', { name: 'Xác nhận' }));
  expect(await result).toBe('Tiếng Anh');
  act(() => { result = promptDialog('Tên mới', 'Toán'); });
  fireEvent.click(screen.getByRole('button', { name: 'Hủy' }));
  expect(await result).toBeNull();
});
test('confirmation waits for the explicit popup choice', async () => {
  render(<AppDialog />); let result;
  act(() => { result = confirmDialog('Xóa câu hỏi?'); });
  expect(screen.getByText('Xóa câu hỏi?')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Hủy' }));
  expect(await result).toBe(false);
});
