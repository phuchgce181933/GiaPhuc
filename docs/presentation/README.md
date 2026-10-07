# Presentation module

Luồng: Nhập nội dung → Sửa cấu trúc → Xác nhận tạo Canva → Kết quả.

## Cấu hình

`PRESENTATION_MONGODB_URI` (tùy chọn), `PRESENTATION_MONGODB_DB=presentations`, `MODEL_API_URL`, `MODEL_API_MODEL`, `MODEL_API_KEY`, `CANVA_CLIENT_ID`, `CANVA_CLIENT_SECRET`, `CANVA_REDIRECT_URI`, `CANVA_SCOPES`, và `PRESENTATION_TOKEN_ENCRYPTION_KEY` phải được đặt trong `backend/.env`. Key chỉ ở backend.

Canva dùng OAuth 2.0 Authorization Code + PKCE. App Canva cần scopes `design:content:write design:content:read` và capability `design_generation`. Plugin Canva trong Codex không được dùng làm token cho web.

## API và quyền

API nằm dưới `/api/presentations`, yêu cầu JWT và quyền `presentation:read`, `presentation:create`, `presentation:update`, `presentation:export`, `presentation:delete`. Người dùng chỉ truy cập bản ghi do chính họ tạo.

`GET /`, `POST /`, `GET /canva/connect`, `GET /canva/callback`, `GET /:id`, `PATCH /:id`, `POST /:id/canva`, `POST /:id/export`, `DELETE /:id`.

PDF/PPTX chỉ hiển thị khi Canva trả về export format tương ứng. Link design/export là link tạm thời của Canva.

## Database

Module dùng MongoDB connection riêng với `dbName=presentations`, không dùng chung `giaphuc` hoặc `thuanhung_tkb`. Bản ghi lưu owner, nội dung, outline, trạng thái, job id, link Canva, lỗi và thông tin export; secret không gửi xuống frontend.

## Vận hành và kiểm thử

Thiếu ModelAPI/Canva OAuth trả lỗi thật và không báo thành công giả. Generation/export được xử lý bất đồng bộ, có timeout và lưu lỗi. Frontend production build đã chạy thành công. Bộ test backend hiện hữu chạy qua các test TKB; kiểm thử integration ModelAPI/Canva thật còn bị chặn bởi thiếu API key, OAuth callback public và MongoDB presentation runtime.
