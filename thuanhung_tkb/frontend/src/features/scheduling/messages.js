const KNOWN_MESSAGES = new Map([
  ['Curriculum has no weekly period counts.', 'Chưa có số tiết mỗi tuần trong chương trình học.'],
  ['The server did not confirm that the schedule was saved.', 'Máy chủ chưa xác nhận lịch đã được lưu.'],
  ['The solution failed re-validation. The schedule was not saved.', 'Phương án không vượt qua bước kiểm tra lại nên chưa được lưu.'],
  ['This generation failed its integrity check and cannot be committed. Nothing was saved.', 'Phương án không vượt qua kiểm tra toàn vẹn nên chưa thể lưu.'],
  ['The server refused the commit.', 'Máy chủ từ chối lưu phương án.'],
]);

export function localizeSchedulingMessage(message) {
  if (typeof message !== 'string' || message.trim() === '') return 'Hệ thống chưa thể hoàn tất yêu cầu.';
  if (KNOWN_MESSAGES.has(message)) return KNOWN_MESSAGES.get(message);
  if (message.includes('configured lifetime')) return 'Bản xem trước đã hết thời hạn lưu. Hãy tạo phương án mới rồi thử lại.';
  if (message.includes('integrity check')) return 'Phương án không vượt qua kiểm tra toàn vẹn nên chưa thể lưu.';
  return message;
}