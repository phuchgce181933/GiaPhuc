# GiaPhuc — RBAC và thời khóa biểu Thuận Hưng

Hai ứng dụng: `backend/` (Node >=20, Express, MongoDB) và `frontend/` (React, Vite). TKB là feature tích hợp; không chạy thêm ứng dụng thuanhung_tkb hay Python/AI service. Quy tắc tổ chức mã nằm trong [AGENTS.md](AGENTS.md).

## Chạy cục bộ

```powershell
cd backend
copy .env.example .env
# Điền MongoDB, JWT, mail và thông tin seed của bạn.
npm ci
npm start
```

Chỉ chạy `npm run seed` khi chủ động cần tạo/reset admin theo cấu hình seed. Startup cập nhật system-role permission catalog, không reset password. Không commit `.env` hoặc credentials.

```powershell
cd frontend
npm ci
npm run dev
```

Frontend: [localhost:5173](http://127.0.0.1:5173). API: `localhost:5001`; Vite proxy `/api` tới 5001. Cổng 5000 trên môi trường hiện tại có một dịch vụ TKB khác; cấu hình repo đã chuyển sang 5001 để tránh ảnh hưởng dịch vụ đó.

## Database và quyền

- `MONGODB_URI` + `MONGODB_DB=giaphuc`: user, role và đăng nhập GiaPhuc.
- `TKB_MONGODB_URI` tùy chọn + `TKB_MONGODB_DB=thuanhung_tkb`: dữ liệu TKB. Nếu URI TKB không đặt thì dùng cùng server URI với **connection/database riêng**.
- Cấu hình và adapter chặn TKB dùng database GiaPhuc. Các route TKB đều chạy qua JWT + RBAC hiện có.
- Quyền: `tkb:read`, `tkb:catalog:manage`, `tkb:preference:update`, `tkb:generate`, `tkb:commit`. Administrator nhận đủ quyền; User mặc định không tự nhận quyền TKB. Quản trị viên cấp quyền qua màn hình vai trò.

## Chức năng

GiaPhuc tiếp tục quản lý tài khoản, hồ sơ, vai trò, quyền và đăng nhập/refresh/change-password. TKB quản lý giáo viên/môn/lớp/phân hiệu, nguyện vọng, tạo các phương án, xác nhận lưu và mở lại lịch đã lưu theo lớp/giáo viên. Đây là TKB các môn bộ môn có dữ liệu, không phải tất cả môn của lớp.

Tạo lịch chỉ lưu preview. Commit kiểm tra lại dữ liệu hiện tại và ràng buộc trước khi lưu vào MongoDB, chống lưu trùng và giữ snapshot danh mục để xem lịch cũ. Thiếu thời gian di chuyển được hiển thị cảnh báo; được lưu với cảnh báo theo quy tắc chủ dự án đã xác nhận.

Solver xác định chạy trong worker thread để không chặn API RBAC. Không có nhánh AI/mock, không tải model/trọng số. Mã source/data TKB thuộc `backend/src/modules/timetable/` và `backend/data/timetable/`; UI thuộc `frontend/src/features/timetable/`. Frontend chỉ giao tiếp backend qua HTTP.

## Kiểm thử

```powershell
npm --prefix backend test
npm --prefix backend run test:integration
npm --prefix frontend test
npm --prefix frontend run build
```

Integration test tạo và dọn database `giaphuc_tkb_test_<random>` riêng trên server TKB cấu hình; không dùng database sản phẩm làm fixture. Pure regression không cần production secrets. Cần credentials có quyền tạo/drop database test để chạy integration.

## Tài liệu

- [Nghiệp vụ và quy tắc đã xác nhận](docs/timetable/BUSINESS_RULES.md)
- [Cấu trúc, MongoDB, migration và API](docs/timetable/OPERATIONS.md)
- [Báo cáo bảo trì, kiểm thử và bằng chứng UI](docs/timetable/MAINTENANCE_REPORT_2026-10-07.md)
- [QA trước tích hợp](docs/timetable/history/TESTER_UI_UX_REPORT_2026-10-06.md)
- [Progress Test: nghiệp vụ, database riêng, API, quyền và kiểm thử](docs/progress-test/README.md)

Dữ liệu nguồn và `legacy-state/` được giữ để phục hồi migration. Mã/cấu hình ứng dụng cũ và tài liệu phase cũ đã được nén vào `.backups/` cục bộ trước khi dọn; thư mục này không commit. Không xóa các dữ liệu vận hành chỉ vì chúng không phải mã nguồn.
