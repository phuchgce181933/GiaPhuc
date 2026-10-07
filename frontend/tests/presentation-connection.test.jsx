import { test, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import CanvaConnectionBanner from '../src/features/presentation/components/CanvaConnectionBanner';
afterEach(cleanup);
test('configured but unauthenticated Canva clearly requires login and consent', () => {
  const connect = vi.fn(); render(<CanvaConnectionBanner status={{configured:true,connected:false}} onConnect={connect} canConnect />);
  expect(screen.getByText('Chưa kết nối tài khoản Canva')).toBeTruthy();
  expect(screen.getByText(/đăng nhập và cho phép GiaPhuc/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Kết nối Canva'})); expect(connect).toHaveBeenCalledOnce();
});
test('connected status has no connect action; read-only users cannot connect', () => {
  const { rerender } = render(<CanvaConnectionBanner status={{configured:true,connected:true}} onConnect={()=>{}} canConnect />);
  expect(screen.getByText('Đã kết nối tài khoản Canva')).toBeTruthy(); expect(screen.queryByRole('button')).toBeNull();
  rerender(<CanvaConnectionBanner status={{configured:true,connected:false}} onConnect={()=>{}} canConnect={false} />); expect(screen.queryByRole('button')).toBeNull();
});
