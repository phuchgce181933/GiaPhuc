# Báo cáo tích hợp, bảo trì và kiểm thử — 07/10/2026

## Kết quả

TKB đã tích hợp vào hai ứng dụng GiaPhuc với JWT/RBAC chung, API `/api/timetable` và MongoDB `thuanhung_tkb` riêng. Database `giaphuc` giữ tài khoản/vai trò. Không có app TKB riêng hay Python/AI service cần chạy. Luồng tạo → xác nhận lưu → mở lịch đã lưu → refresh đã được thực hiện qua trình duyệt thật.

Dữ liệu hiện tại vẫn có 7 phân hiệu, 113 lớp, 40 giáo viên active, 5 môn active, 479 phân công và 802 tiết. 6 preview cũ được chuyển sang MongoDB. Kiểm tra UI đã tạo/lưu **1 lịch hợp lệ, phiên bản 1, 802 tiết**, trong database TKB; mã lịch `sch-3d7d8c79c61f3693`. Không gửi email hay công bố lịch ra ngoài. Bản nháp nguyện vọng dùng để kiểm tra đã được hủy, không lưu vào database.

Năm quy tắc chủ dự án xác nhận được giữ nguyên và ghi trong [BUSINESS_RULES.md](BUSINESS_RULES.md). Không có câu hỏi nghiệp vụ đã gửi nào còn chờ trả lời. “0 vi phạm” trong kiểm thử là các ràng buộc có dữ liệu/đang áp dụng; thời gian đi lại chưa được kiểm chứng và luôn có cảnh báo.

## Đóng các phát hiện của báo cáo trước

| Phát hiện | Thay đổi và kiểm chứng |
|---|---|
| F01 — mất nguyện vọng khi lưu đồng thời | MongoDB mỗi giáo viên một document; revision CAS bảo vệ cập nhật khác process và merge các field cùng giáo viên. File adapter phục hồi/test có queue + tên temp UUID. Test cùng giáo viên và khác giáo viên đều đạt. |
| F02 — file hỏng bị coi là rỗng rồi ghi đè | Chỉ ENOENT là chưa có file; parse/schema lỗi được báo và chặn ghi. MongoDB snapshot cũng từ chối preference document hỏng. Test giữ nguyên file hỏng và lỗi Mongo document đạt. |
| F03 — không mở lại được lịch đã lưu | Danh sách có nút Xem lịch, API full và màn hình lịch riêng. Lưu directory/calendar snapshot; refresh vẫn mở đúng 802 tiết. Unit kiểm tra tên tại thời điểm lưu đạt. |
| F04 — mất bản nháp khi đổi trang | Data Router blocker + beforeunload + hộp thoại đổi giáo viên/phân hiệu; đăng xuất cũng đi qua guard. Unit và trình duyệt xác nhận “Ở lại” giữ số 3, hủy không ghi. |
| F05 — focus ra ngoài modal lưu | Dùng Modal native dialog chung GiaPhuc; initial focus nằm trong dialog, Tab vẫn trong dialog; Escape/close bị chặn khi busy, trả focus khi đóng. Trình duyệt thật đã xác nhận. |
| F06 — lọc phân hiệu giữ lớp sai, lưới trống | Lọc danh sách lớp và tự chọn lại lựa chọn hợp lệ. Điều chỉnh tương tự khi đổi chế độ giáo viên. Unit kiểm tra từ cơ sở 1 sang cơ sở 2 chọn lớp 2 đạt. |
| F07 — Chiều trước Sáng | Calendar và lưới sắp Sáng → Chiều, tiết tăng dần; ô khóa được chú thích. Trình duyệt hiển thị đúng. Lịch giáo viên hiện lớp học thay vì lặp lại tên giáo viên ở từng ô. |
| F08 — tràn ngang mobile | Bảng lịch lưu và lưới cuộn trong vùng riêng; layout/sidebar GiaPhuc responsive. 375px: trang lịch có scrollWidth 366px; danh sách lịch 375px, không tràn toàn trang. |
| F09 — mock được mô tả như AI thật | Bỏ nhánh AI/mock, provider/planner, Python service và control AI. Body generate chỉ còn candidateCount/optimizationMode; client test kiểm tra đúng hai key. |
| F10 — malformed JSON trả HTML | Handler lỗi cấp app trả JSON HTTP400 với thông báo rõ, không stack trace trong UI. |
| F11 — README/spec phase cũ | Thay bằng README hiện tại, nghiệp vụ và vận hành. 47 tài liệu phase cũ nén vào backup; QA ban đầu giữ trong history, ghi rõ là trạng thái trước tích hợp. |

Hai assertion “mọi phân công tại chỗ phải giữ giáo viên home” được đổi sang kiểm tra phân công đủ/được phép sau tối ưu, phù hợp xác nhận được đổi giáo viên. Kiểm tra đầy đủ tiết và evaluator cứng vẫn giữ. Chẩn đoán thiếu quyền được tách khỏi thiếu capacity bằng phân tích giả định chỉ để giải thích; không dùng quyền giả định để xếp bất kỳ tiết nào. Test từng thất bại trước đây đã đạt khi chạy lại.

## Kiểm thử và bằng chứng

| Hạng mục | Kết quả |
|---|---|
| Backend regression sau tích hợp | 545/546 đạt ở lần full; lỗi còn lại là test đọc đường dẫn file cũ. Đã sửa đường dẫn và chạy lại riêng: 1/1 đạt. Thêm test API truyền actor context: 1/1 đạt. Tổng 547 tình huống đã được kiểm tra thành công, không bỏ qua test. |
| JWT/RBAC | 5/5, nằm trong bộ regression: missing/expired/refresh token, locked user, quyền hiện tại từ DB, read-only và URL hoa/thường/trailing slash. |
| Frontend | 98/98 trong 6 file; có 5 regression mới cho bản nháp, readonly, bỏ AI, bộ lọc và snapshot lịch. |
| MongoDB thật, database test riêng | 1 integration scenario đạt, 24,6 giây; kiểm tra DB isolation, race preference, corrupt document, worker responsiveness/busy, durable preview, duplicate commit, unique versions, snapshot và hard revalidation. DB test đã drop sau test. |
| Production build | Đạt, 161 module. |
| Trình duyệt thật | Đăng nhập admin, menu RBAC, tạo/lưu 802 tiết, mở lại/refresh, focus modal, giữ draft, mobile/desktop; không có console error trong phiên đã quan sát. |

Các test chỉ thuộc AI/benchmark AI và preview API không còn triển khai đã được bỏ cùng tính năng. Giữ regression hiện tại của solver, independent evaluator, catalog và persistence; reference validator cũ chỉ là test helper, không có route sản phẩm. Không dùng việc giảm số lượng test để tuyên bố dữ liệu tương lai luôn đúng.

Bằng chứng: [commit modal](evidence-2026-10-07/commit-dialog.jpg), [lịch mở lại desktop](evidence-2026-10-07/saved-desktop.jpg), [mobile](evidence-2026-10-07/saved-mobile.jpg), [draft guard](evidence-2026-10-07/unsaved-dialog.jpg), [bảng lịch mobile](evidence-2026-10-07/saved-list-mobile.jpg). Log và snapshot API được lưu cùng thư mục evidence.

Actor context đã được bổ sung và kiểm tra qua đúng API commit (không chỉ service trực tiếp). Record UI test đầu tiên đã được điền actor của tài khoản admin đã thực hiện lần lưu, có cờ bảo trì; không đổi tiết học, snapshot hoặc content hash. Snapshot cuối xác nhận 1 lịch/802 tiết, actor đã ghi, hai connection khác nhau và không có collection sources/previews của TKB trong database GiaPhuc; User count vẫn 2, Role count vẫn 3.

## Cấu trúc và phần dọn bỏ

Mã feature nằm đúng backend module/frontend feature; không import xuyên hai ứng dụng. Auth/RBAC nằm trong middleware/common auth của GiaPhuc. TKB dùng native Mongo collection trên Mongoose connection riêng để nối datastore async với projection domain đã kiểm chứng. Không fallback file trong API sản phẩm.

Đã bỏ các app shell/frontend/backend riêng, route preview cũ, AI mock/planner/provider/AirLLM, Python runtime/venv/cache, benchmark AI, dead situation/explanation/legacy scorer/fixture loader và các probe không được dùng. Raw BSON/fixture phục vụ import và regression được giữ. `legacy-state` giữ dữ liệu phục hồi. Không xóa bản ghi nghiệp vụ đang tham chiếu để làm đẹp cây thư mục.

UI dùng palette/type/layout chung GiaPhuc theo skill UI/UX của repo; giao diện TKB có 3 bước, cảnh báo rõ, thông tin kỹ thuật thu gọn, bộ lọc phụ thuộc và tên/giờ lưu dễ đọc. Các truy vấn design-system trả pattern landing không phù hợp nên không áp dụng pattern đó; sử dụng các hướng dẫn dark contrast, semantic control, form validation và focus phù hợp sản phẩm quản trị.

Bộ phê duyệt tự động ban đầu chặn xóa trọn thư mục cũ. Sau khi lập inventory, ZIP 40 file có kiểm tra integrity, chứng minh source/data đã chuyển và không còn import cũ, thao tác dọn được thực hiện. Hai pytest cache cần quyền filesystem nâng cao đã được xóa trong đúng workspace. Không còn phần dọn bị chặn. Backup nằm ở `.backups/`, không commit.

## Vận hành và giới hạn

Frontend 5173, backend 5001. Cổng 5000 đang chạy dịch vụ TKB khác, không xác định là process repo nên không dừng. Port, proxy và cấu hình cục bộ/example đã đồng bộ. Admin system role có thêm 5 quyền TKB; không reset mật khẩu, không tự cấp quyền TKB cho User.

Mỗi backend process xử lý một worker xếp lịch; yêu cầu khác nhận HTTP429 để thử lại. Nhiều process ghi cùng database vẫn dùng revision/unique index/counter. Nghiệp vụ chỉ là các môn bộ môn; không có dữ liệu ma trận đi lại, không suy ra capacity từ workload lịch sử. Snapshot lịch là dữ liệu tại thời điểm kiểm tra/lưu, không tự cập nhật theo các chỉnh sửa sau đó.

Chưa làm load test nhiều người dùng, penetration test hoặc kiểm tra mọi thiết bị/trình duyệt. Không có đánh giá AI mới vì tính năng đã bỏ. Những giới hạn này không bị trình bày như đã kiểm chứng hoặc tối ưu tuyệt đối.
