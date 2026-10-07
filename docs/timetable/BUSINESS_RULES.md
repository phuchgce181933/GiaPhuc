# Nghiệp vụ thời khóa biểu bộ môn Thuận Hưng

Phiên bản tích hợp GiaPhuc, ngày 07/10/2026. Báo cáo này mô tả chức năng và quy tắc đã được kiểm tra; không khẳng định mọi tình huống dữ liệu tương lai đều đã được kiểm thử.

## Phạm vi và dữ liệu

Hệ thống quản lý lịch hàng tuần của các môn bộ môn đang có dữ liệu, không phải lịch đầy đủ tất cả môn của lớp. Bộ dữ liệu hiện tại có 7 phân hiệu, 113 lớp, 40 giáo viên đang sử dụng, 5 môn đang sử dụng, 479 phân công và 802 tiết cần xếp. Công nghệ là môn ngừng sử dụng trong danh mục và không tạo nhu cầu xếp hiện tại.

Tài khoản, đăng nhập, vai trò và quyền thuộc database `giaphuc`. Danh mục trường, nguyện vọng, preview và lịch đã lưu thuộc database `thuanhung_tkb`, qua kết nối MongoDB riêng. Có thể dùng chung máy chủ MongoDB nhưng không dùng chung database hay connection mặc định. Cấu hình và adapter chặn việc lưu TKB vào database GiaPhuc.

## Người sử dụng và quyền

Mọi API TKB yêu cầu JWT còn hiệu lực và tài khoản active. Quyền lấy từ vai trò hiện tại trong database GiaPhuc, không tin quyền do client tự gửi trong JWT/body. Tài khoản locked/inactive bị từ chối.

| Quyền | Chức năng |
|---|---|
| `tkb:read` | Xem tổng quan, danh mục, nguyện vọng và lịch đã lưu |
| `tkb:catalog:manage` | Thêm/sửa/xóa giáo viên, môn và lớp |
| `tkb:preference:update` | Lưu nguyện vọng giáo viên |
| `tkb:generate` | Tạo các phương án xem trước |
| `tkb:commit` | Xác nhận lưu một phương án |

Các hành động ghi còn yêu cầu `tkb:read`. Administrator nhận đủ quyền qua cơ chế system role hiện có. Vai trò User mặc định không tự nhận quyền TKB; quản trị viên cấp quyền qua màn hình vai trò. Quyền TKB hiện áp dụng toàn feature, không triển khai một cổng tự phục vụ theo danh tính từng giáo viên.

## Quy tắc đã được chủ dự án xác nhận

1. Sau bước xếp tại phân hiệu chính, được đổi giáo viên để tối ưu tải, miễn vẫn đúng mọi ràng buộc đang áp dụng. Số liệu bước tại chỗ là số liệu trước tối ưu toàn trường.
2. Được lưu lịch với cảnh báo chưa kiểm tra thời gian di chuyển giữa phân hiệu. Không được diễn đạt “0 vi phạm đang kiểm tra” thành bảo đảm đi lại khả thi.
3. Chỉ quản lý các môn bộ môn đang có dữ liệu. Ô trống trên lưới không có nghĩa lớp không học các môn khác.
4. Mọi môn đều không được xếp hai tiết liên tiếp trong cùng buổi cho cùng lớp.
5. Khóa tiết 1 sáng thứ 2 và tiết 4 sáng thứ 6 tại mọi phân hiệu.

## Quy tắc xếp lịch

- Một lớp hoặc giáo viên không có hai tiết cùng thời điểm. Xung đột giáo viên được kiểm tra xuyên phân hiệu.
- Giáo viên phải đủ chuyên môn, đang sử dụng; môn cũng phải đang sử dụng.
- Mỗi nhu cầu lớp–môn phải được xếp đúng số tiết, tại phân hiệu của lớp và khung giờ hợp lệ.
- Một cặp lớp–môn dùng một giáo viên thống nhất.
- Giới hạn tiết/tuần chỉ là `capacityPeriodsPerWeek` đã khai báo rõ. `null` là chưa khai báo; `0` là không được nhận tiết. Số tiết lịch sử và placeholder chuyên môn không tự trở thành capacity.
- Các giới hạn buổi tối đa/ngày nghỉ cố định được kiểm tra khi có dữ liệu tương ứng. Nguyện vọng trên form là ưu tiên mềm, không phải các giới hạn này.
- Giáo viên không dạy hai tiết liên tiếp ở hai phân hiệu khác nhau trong cùng buổi. Thời gian di chuyển thực tế vẫn chưa được kiểm tra khi không có ma trận.
- Với `AUTO_SHORTAGE`, xếp tại chỗ trước, sau đó tự xét người đủ chuyên môn để bù thiếu/cân bằng. Danh sách giới hạn điều chuyển không rỗng vẫn là giới hạn bắt buộc. Với `EXPLICIT`, cần quyền điều chuyển đã khai báo. Nguyện vọng nơi muốn dạy không cấp quyền điều chuyển.
- Một buổi là một cặp ngày–ca có ít nhất một tiết: bốn tiết sáng cùng ngày tính một buổi; một tiết sáng và một tiết chiều cùng ngày tính hai buổi.

Solver và evaluator độc lập. Phương án vi phạm quy tắc cứng bị loại; điểm mềm không được bù cho vi phạm cứng. Ràng buộc thiếu dữ liệu được báo INACTIVE/UNSUPPORTED; không tự tạo dữ liệu đi lại, capacity hay nguyện vọng.

## Quản lý danh mục và nguyện vọng

Giáo viên có phân hiệu chính chọn khi tạo và cố định sau đó. Tên giáo viên có thể trùng; mã trùng bị từ chối. Tham chiếu môn, khối, phân hiệu, giáo viên chủ nhiệm được kiểm tra. Bản ghi đang được tham chiếu không được xóa; có thể chuyển sang ngừng sử dụng.

Môn và định mức của lớp lấy từ khối đã khai báo. Ngừng dùng giáo viên giữ nhu cầu để phân công lại. Ngừng dùng lớp/môn loại nhu cầu đó khỏi lần xếp hiện tại. Thay đổi danh mục không sửa ngược lịch đã lưu.

Nguyện vọng gồm ca dạy, số buổi mong muốn, ngày/ca muốn nghỉ và nơi muốn điều chuyển. Hai người lưu đồng thời phải giữ được cả hai bản ghi. Hai cập nhật khác trường của cùng giáo viên được merge với revision. Dữ liệu nguyện vọng hỏng phải báo lỗi, không coi như chưa có dữ liệu rồi ghi đè.

Rời trang, đổi giáo viên/phân hiệu gây mất bản nháp hoặc đăng xuất cần xử lý thay đổi chưa lưu. Chọn “Ở lại” giữ giá trị; hủy/bỏ thay đổi không ghi database.

## Tạo, lưu và xem lại

Luồng UI: kiểm tra dữ liệu → tạo/so sánh → xem/xác nhận lưu. Tạo chỉ lưu preview, chưa tạo lịch COMMITTED. Người dùng chọn số phương án 1/3/5/10 và chế độ xếp. Điểm xếp hạng, điểm chất lượng và độ khác nhau có ý nghĩa khác nhau; không coi điểm 0.5 là tỷ lệ hoàn thành 50%.

Không còn nhánh AI/mô phỏng trong sản phẩm. Solver xác định nhận chế độ được chọn; giao diện mặc định đề xuất cân bằng toàn trường. Công việc CPU chạy trong worker thread để không chặn API RBAC. Một lượt xếp đang chạy trên mỗi backend process; lượt khác nhận thông báo thử lại.

Commit chỉ nhận `requestId` và `solutionId`, kiểm tra integrity, tải dữ liệu hiện tại, kiểm tra lại ràng buộc, rồi lưu và đọc lại. Client không được gửi lịch tự dựng, teacherId, trọng số hoặc yêu cầu bỏ validation. Lưu lặp cùng cặp ID trả đúng lịch cũ, không tạo bản ghi mới. Phiên bản được cấp bằng counter MongoDB; số có thể bỏ qua khi có tranh chấp nhưng không trùng.

Lịch lưu chứa snapshot tên giáo viên/lớp/môn/phân hiệu và calendar. Mở lại hoặc refresh đọc đúng bản đó; đổi tên danh mục sau này không đổi nội dung lịch cũ. Audit ghi actor ID, revision danh mục, chiến lược, điểm và hash nội dung. Lịch lưu không đồng nghĩa gửi thông báo hay công bố ra ngoài.

## Kết quả kiểm chứng

Xem [báo cáo bảo trì và kiểm thử](MAINTENANCE_REPORT_2026-10-07.md) để đối chiếu F01–F11, log, ảnh UI, giới hạn kiểm thử và dữ liệu sau tích hợp. Năm quy tắc trên đã được xác nhận trong phiên làm việc; không còn câu hỏi đã gửi nào đang chờ trả lời.
