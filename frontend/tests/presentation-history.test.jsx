import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import DesignHistory from '../src/features/presentation/components/DesignHistory';
import { presentationApi } from '../src/features/presentation/service';

vi.mock('../src/features/presentation/service',()=>({
  presentationApi:{remove:vi.fn()},
  errorMessage:error=>error.message,
}));
afterEach(()=>{cleanup();vi.clearAllMocks();});

test('history opens separately and only deletes after confirmation',async()=>{
  const row={_id:'a'.repeat(24),title:'Bài trình bày cần xóa',status:'ready',createdAt:'2026-10-08T10:00:00Z'};
  const onOpen=vi.fn(),onDeleted=vi.fn();presentationApi.remove.mockResolvedValue({deleted:true});
  render(<DesignHistory rows={[row]} onOpen={onOpen} onDeleted={onDeleted}/>);
  fireEvent.click(screen.getByRole('button',{name:`Mở ${row.title}`}));expect(onOpen).toHaveBeenCalledWith(row);expect(presentationApi.remove).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:`Xóa ${row.title}`}));expect(screen.getByRole('heading',{name:'Xóa lịch sử thiết kế'})).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Hủy'}));expect(presentationApi.remove).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:`Xóa ${row.title}`}));fireEvent.click(screen.getByRole('button',{name:'Xóa'}));
  await waitFor(()=>expect(presentationApi.remove).toHaveBeenCalledWith(row._id));expect(onDeleted).toHaveBeenCalledWith(row._id);
});
