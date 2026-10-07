# Kiểm thử cân bằng tải giáo viên — 07/10/2026

Kiểm tra database TKB hiện tại, phiên bản nguồn 7. Script chỉ đọc dữ liệu sản phẩm; tối ưu và tạo mới chạy trong bộ nhớ, không lưu/ghi đè lịch.

## Lỗi đã tái hiện

- Giáo dục thể chất có tải 14–26 tiết, chênh 12, dù evaluator xác nhận lịch hợp lệ.
- Tăng ngân sách tìm kiếm đơn thuần không giải quyết được vấn đề.
- Có 61 phương án chuyển phân công từ nhóm 26 tiết sang nhóm 14 tiết được evaluator chấp nhận khi giữ giờ cũ. Vì vậy chênh lệch này không phải giới hạn bắt buộc của dữ liệu.

## Nguyên nhân và sửa chữa

1. Duyệt môn theo ID, quét toàn bộ trước khi áp dụng cải thiện làm các môn lệch lớn dễ bị bỏ qua khi hết thời gian. Ưu tiên nhóm có độ lệch lớn và áp dụng ngay cải thiện hợp lệ.
2. Chỉ đổi giáo viên và giữ khung giờ cũ; khi người nhận trùng giờ, phương án bị bỏ. Bổ sung tìm khung giờ khác cho nhóm phân công tối đa 4 tiết, giữ nguyên lớp/môn/số tiết và kiểm tra lại evaluator toàn lịch.
3. Nguyện vọng điều chuyển bị dùng làm điều kiện chặn bắt buộc. Loại bỏ quyền phủ quyết của nguyện vọng mềm; comparator tiếp tục ưu tiên cân bằng rồi mới đến nguyện vọng, các quyền/ràng buộc cứng vẫn được giữ.
4. Giữ nguyên nhóm phân công Tin học/Công nghệ theo quy tắc chung giáo viên của lớp; chỉ chuyển cả nhóm khi người nhận đủ chuyên môn.
5. Bỏ xét chuyển tải không thể giảm độ lệch và cấp ngân sách riêng 15 giây / 20.000 lượt / 100 vòng cho tối ưu sau coverage.

## Kết quả lượt tạo mới bằng API generate

| Môn | Khoảng tải trước (phiên bản 7) | Khoảng tải sau (lượt tạo mới) |
|---|---:|---:|
| Giáo dục thể chất | 14–26 | 20–22 |
| Tin học | 9–31 | 17–18 |
| Tiếng Anh | 20–28 | 20–24 |
| Âm nhạc | 17–21 | 18–19 |
| Mỹ thuật | 12–21 | 16–17 |

Lượt tạo mới trả OK. Evaluator kiểm tra toàn bộ candidate: 0 vi phạm cứng. Kiểm tra tối ưu nguồn giữ đủ 802 tiết. Đây là kết quả đo với dữ liệu và nguyện vọng hiện tại, không phải bảo đảm mọi tập dữ liệu đạt cùng mức lệch. Thời gian chạy có giới hạn nên không tuyên bố tối ưu toàn cục.

## Kiểm thử hồi quy

- 43/43 test cân bằng, lịch buổi/tiết và effective assignment đều đạt; gồm 9 test cân bằng.
- Bổ sung test chuyển giáo viên khi người nhận bận ở giờ cũ và test nguyện vọng mềm không chặn cải thiện tải hợp lệ.
- Không đổi quy tắc cấm tiết khóa, trùng giáo viên/lớp, cùng môn liên tiếp, điều chuyển liên tiếp giữa phân hiệu, khả năng nhận tiết hay ngày nghỉ cố định.
- Chưa có dữ liệu thời gian di chuyển nên chưa xác minh thời gian di chuyển thực tế. Giữ cảnh báo như nghiệp vụ đã xác nhận.

Chạy lại audit: `cd backend; node tests/balance-audit.cjs --generate`. Bằng chứng thô: `docs/timetable/balance-audit-2026-10-07.jsonl`. Phiên bản cũ giữ nguyên; tạo và xác nhận phiên bản mới để dùng thuật toán đã sửa.
