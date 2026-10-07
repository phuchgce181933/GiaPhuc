# Presentation module

Luồng: Nhập nội dung → Sửa cấu trúc → Xác nhận tạo Canva → Kết quả.

## Cấu hình

`PRESENTATION_MONGODB_URI` (tùy chọn), `PRESENTATION_MONGODB_DB=presentations`. Phần AI mặc định dùng `TKB_AI_API_KEY`, `TKB_AI_MODEL` và `TKB_AI_BASE_URL` đã có trong `backend/.env`, giống trợ lý TKB. Không cần tạo key AI khác. Chỉ đặt `MODEL_API_KEY`, `MODEL_API_MODEL`, `MODEL_API_URL` khi muốn ghi đè riêng cho slide. `MODEL_API_TIMEOUT_MS=60000`; frontend chờ tối đa 90 giây để tạo cấu trúc.

Để tạo thiết kế trên Canva, cần thêm `CANVA_CLIENT_ID`, `CANVA_CLIENT_SECRET`, `CANVA_REDIRECT_URI`, `CANVA_SCOPES` và `PRESENTATION_TOKEN_ENCRYPTION_KEY`. Key ModelAPI không thay thế Canva OAuth. Key chỉ ở backend.

Canva dùng OAuth 2.0 Authorization Code + PKCE. App Canva cần scopes `design:content:write design:content:read` và capability `design_generation`. Plugin Canva trong Codex không được dùng làm token cho web.

## API và quyền

API nằm dưới `/api/presentations`, yêu cầu JWT và quyền `presentation:read`, `presentation:create`, `presentation:update`, `presentation:export`, `presentation:delete`. Người dùng chỉ truy cập bản ghi do chính họ tạo.

`GET /`, `POST /`, `GET /canva/connect`, `GET /canva/callback`, `GET /:id`, `PATCH /:id`, `POST /:id/canva`, `POST /:id/export`, `DELETE /:id`.

PDF/PPTX chỉ hiển thị khi Canva trả về export format tương ứng. Link design/export là link tạm thời của Canva.

## Database

Module dùng MongoDB connection riêng với `dbName=presentations`, không dùng chung `giaphuc` hoặc `thuanhung_tkb`. Bản ghi lưu owner, nội dung, outline, trạng thái, job id, link Canva, lỗi và thông tin export; secret không gửi xuống frontend.

## Vận hành và kiểm thử

Thiếu ModelAPI/Canva OAuth trả lỗi có kiểm soát và không báo thành công giả. Tất cả controller async chuyển lỗi vào middleware Express, không làm dừng server. Test lỗi: `node --require ./tests/setup.cjs --test tests/presentation/presentation-errors.test.cjs` (3 test đạt). Kiểm thử provider thật: `node tests/presentation/modelapi-live.cjs`, đã tạo JSON 2 slide hợp lệ bằng cấu hình TKB, không ghi database/không tạo Canva design. Tạo thiết kế Canva thật vẫn cần OAuth được cấu hình và tài khoản cấp quyền.
