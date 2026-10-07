# Progress Test — hướng dẫn và nghiệp vụ

## Đường dẫn

- Quản trị: `/progress-test` (menu GiaPhuc), `/progress-test/questions`, `/progress-test/exams`.
- Học sinh: `/tests` hiển thị bài đang mở; `/tests/<slug>` là đường dẫn riêng của từng bài.
- Kết quả: vào Lịch & kết quả → Xem kết quả → Chi tiết bài làm.

## Quy trình

1. Tạo môn học, rồi tạo các danh mục trong môn (ví dụ Tiếng Anh → Unit 1, Unit 2).
2. Thêm câu hỏi vào môn/danh mục. Trắc nghiệm có 2–8 lựa chọn, một đáp án đúng; tự luận nhập văn bản. Mỗi câu có điểm tối đa và giải thích không bắt buộc.
3. Công thức toán: Unicode `² √ π ≤ ≥ × ÷` hoặc LaTeX trong `$…$`/`$$…$$`, ví dụ `$\frac{1}{2}$`. Có thanh chèn ký hiệu và xem trước. KaTeX được đóng gói cùng ứng dụng, không cần CDN khi làm bài.
4. Tạo lịch: chọn môn, một hoặc nhiều danh mục, số câu (1–100), thời gian mở/đóng, thời lượng làm bài và mật khẩu. Các câu được chọn ngẫu nhiên từ ngân hàng của danh mục. Bộ câu hỏi cố định cho tất cả học sinh trong cùng bài kiểm tra.
5. Học sinh mở đường dẫn. Ngoài khoảng thời gian mở thì trang hiển thị đang khóa và backend từ chối vào bài. Đúng giờ: nhập mật khẩu → họ tên → Bắt đầu làm bài.
6. Đồng hồ tính theo thời gian máy chủ. Hạn nộp là giá trị nhỏ hơn giữa giờ đóng bài và thời điểm bắt đầu + thời lượng. Tự lưu mỗi 2 giây khi đáp án thay đổi, giữ nháp trong sessionStorage khi kết nối gián đoạn.
7. Nộp bài chốt câu trả lời; hết hạn backend chốt theo đáp án cuối đã nhận. Có bộ quét bài hết giờ mỗi 15 giây và kiểm tra lại thời gian ở tất cả endpoint ghi đáp án.
8. Trắc nghiệm chấm tự động theo đáp án ở backend. Bài có tự luận mang trạng thái Chờ chấm tự luận; giáo viên nhập điểm từng câu, điểm không vượt điểm tối đa. Hiển thị điểm đạt / tổng điểm, không mặc định quy đổi về thang 10.

## Giám sát

Ghi nhận visibilitychange (ẩn/chuyển tab), blur (mất tiêu điểm), pagehide (rời/tải lại), quay lại và thoát toàn màn hình. Mỗi sự kiện có ID chống lưu lặp và timestamp máy chủ. Đây là tín hiệu cần xem xét, không tự động trừ điểm hoặc kết luận gian lận. Việc khóa màn hình, thông báo hệ điều hành và một số thao tác điện thoại cũng có thể làm trang mất tiêu điểm.

Trình duyệt không bảo đảm phát hiện mọi thao tác rời bài, và không thể gửi sự kiện lên máy chủ khi mất mạng hoặc bị hệ điều hành đóng đột ngột. Không ghi các hoạt động ngoài trình duyệt, không dùng camera/microphone. Họ tên do học sinh tự khai báo, không phải danh tính đã xác minh; hai tên giống nhau vẫn là hai lượt làm riêng.

Trang kết quả lưu câu trả lời cuối, bộ câu hỏi snapshot, điểm, lịch sử các lần lưu thành công và nhật ký sự kiện trình duyệt gửi được. Lịch sử nằm ở collection riêng, không cắt bỏ sau một số lượt cố định. Đáp án đúng và giải thích không được gửi cho học sinh trong lúc làm bài. Bản snapshot giữ nguyên khi sửa/xóa câu hỏi gốc.

## Database và kiến trúc

Database độc lập **`progress_test`**; tên MongoDB không chứa khoảng trắng. Kết nối riêng, không dùng database `giaphuc` hoặc `thuanhung_tkb`.

Backend config tập trung:

```env
PROGRESS_TEST_MONGODB_DB=progress_test
# Tùy chọn server MongoDB khác; không đặt thì dùng server URI hiện tại,
# vẫn chọn database riêng progress_test.
# PROGRESS_TEST_MONGODB_URI=...
```

Backend: `backend/src/modules/progress-test/` gồm route, controller, service, model và validation. Collections: `subjects`, `categories`, `questions`, `exams`, `attempts`, `answer_history`, `activities`.

Frontend: `frontend/src/features/progress-test/`. Trang học sinh dùng HTTP client riêng để lỗi token bài làm không gây đăng xuất tài khoản quản trị. Module và KaTeX tải riêng khi mở Progress Test.

Mật khẩu kiểm tra được hash bcrypt; token làm bài ngẫu nhiên 256 bit, database chỉ lưu hash token. Mỗi lần tự lưu dùng revision/CAS để tránh ghi đè cập nhật song song. Bản ghi lịch sử chờ ghi được lưu nguyên tử cùng đáp án rồi chuyển sang collection lịch sử, có thể phục hồi sau lần ghi gián đoạn.

API công khai: `/api/progress-test/public/exams`, `/exams/:slug`, `/exams/:slug/verify`, `/exams/:slug/join`, `/attempt`, `/attempt/answers`, `/attempt/events`, `/attempt/submit`. Các endpoint attempt cần header `X-Attempt-Token`.

## Phân quyền

| Quyền | Chức năng |
|---|---|
| `progress-test:read` | Mở module, xem danh mục và lịch |
| `progress-test:catalog:manage` | Tạo/sửa/xóa môn và danh mục |
| `progress-test:question:manage` | Xem và quản lý ngân hàng câu hỏi/đáp án |
| `progress-test:schedule:manage` | Lên lịch và tạo đường dẫn |
| `progress-test:result:read` | Xem bài làm, điểm và nhật ký |
| `progress-test:grade` | Chấm tự luận |

Mọi endpoint quản trị yêu cầu đăng nhập + quyền đọc và quyền chức năng tương ứng. System admin nhận catalog quyền khi backend khởi động, không reset mật khẩu. Vai trò tùy chỉnh cần được cấp quyền qua màn hình Roles & permissions.

## Điện thoại

Giao diện đã kiểm tra tại chiều rộng 390px: các nút tối thiểu 44px, lựa chọn là vùng bấm lớn, nội dung/form xếp một cột, thanh giờ/nộp bài gọn ở đầu trang.

`localhost` trên điện thoại là chính điện thoại, không phải máy đang chạy GiaPhuc. Khi kiểm tra từ điện thoại, dùng domain đã triển khai hoặc địa chỉ LAN của máy chủ. Với môi trường phát triển có thể chạy frontend `npm run dev -- --host 0.0.0.0` và mở `http://<IP-máy-chủ>:5173/tests`. Dùng HTTPS khi triển khai thật. Module có fallback UUID để nhật ký hoạt động vẫn dùng được trên HTTP nội bộ.

## Kiểm thử

- Backend unit: `cd backend; npm run test:progress`.
- MongoDB integration: `node --test tests/integration/progress-test.test.cjs`. Tạo database QA riêng và dọn đúng database đó sau test.
- Frontend: `cd frontend; npm test` và `npm run build`.
- Kết quả: 7 test nghiệp vụ/RBAC backend đạt; integration MongoDB/HTTP và phục hồi lịch sử đạt; toàn bộ frontend 106/106 test đạt.
- Kiểm tra browser thật: mật khẩu → tên → làm 2 câu trắc nghiệm/tự luận có công thức toán → tự lưu → nộp → hiện 2/5 điểm trắc nghiệm, Chờ chấm tự luận. Môi trường UI QA và database QA đã được dọn.
- Bằng chứng điện thoại: [mobile-qa.png](mobile-qa.png).
