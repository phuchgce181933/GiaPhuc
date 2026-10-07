# Vận hành và cấu trúc TKB tích hợp

## Cấu trúc

```text
backend/src/modules/timetable/
  timetable.route.js       # mount sau JWT + RBAC chung
  timetable.controller.js  # HTTP controller, actor context và error boundary
  timetable.service.js     # connection/snapshot và wiring feature
  timetable.worker.js      # CPU worker, một lượt/process
  assistant/                # parse intent, planner, audit; preview -> confirm only
  engine/                  # ESM, không phải ứng dụng chạy riêng
    catalog/               # catalog.route.js + catalog.service.js + store
    api/                   # generate, commit, response mappers
    catalog/               # CRUD trường/lớp/môn và validation
    domain/                # solver, independent evaluator, scoring
    loader/                # projection và import BSON
    persistence/           # MongoDB và codec/integrity
frontend/src/features/timetable/
  TimetableRoutes.jsx
  service.js               # dùng Axios/JWT/refresh chung của GiaPhuc
  catalog/
  scheduling/
backend/tests/timetable/   # regression; helper Express chỉ dùng test
backend/tests/integration/ # MongoDB thật trong database test riêng
backend/data/timetable/    # nguồn import, fixture và legacy-state phục hồi
docs/timetable/            # tài liệu hiện tại + history QA
```

Backend GiaPhuc CommonJS; engine TKB ESM qua package scope riêng để giữ solver đã kiểm chứng. Không có server, port, package install hay frontend thứ ba. Frontend chỉ giao tiếp backend qua HTTP.

`domain/search-constraints.js` là kiểm tra/pruning của search; `domain/constraints/` là evaluator độc lập. Không gộp hai vai trò này làm mất kiểm chứng độc lập. File store còn lại chỉ phục vụ migration/regression; API sản phẩm bắt buộc nhận store được inject, không fallback sang file nếu MongoDB lỗi.

## Database

`MONGODB_URI`/`MONGODB_DB=giaphuc` giữ tài khoản và vai trò. `TKB_MONGODB_URI` tùy chọn chỉ định server khác; khi không đặt, dùng cùng server URI nhưng connection riêng và `TKB_MONGODB_DB=thuanhung_tkb`. Tên TKB không được trùng tên database GiaPhuc, kể cả khác hoa/thường.

Các collection TKB: `sources` (bản nguồn chuẩn hóa), `catalog` (thay đổi danh mục có revision), `preferences` (mỗi giáo viên một document), `previews`, `schedules`, `counters`, `migrations`. Update danh mục/nguyện vọng dùng optimistic revision để tránh mất cập nhật giữa process. Lịch dùng ID xác định + unique version index, counter atomic.

Startup import nguồn BSON và state cũ bằng `$setOnInsert`; giữ dữ liệu MongoDB đã có. Migration marker `legacy-state-v1` ngăn lặp import ghi đè. File nguyện vọng/preview/lịch hỏng chặn import; không tự tạo mặc định để thay dữ liệu hỏng. Nguồn và `legacy-state/` được giữ để khôi phục; không xóa dữ liệu vận hành chỉ vì chúng không phải mã nguồn.

TKB database lỗi không làm mất chức năng đăng nhập/RBAC GiaPhuc: startup ghi trạng thái chưa sẵn sàng, request TKB thử lại và trả lỗi có kiểm soát. JWT/RBAC chạy trước khi truy cập database TKB.

## Chạy và kiểm thử

Backend mặc định cổng **5001**, frontend **5173**, proxy `/api` tới 5001. Cổng 5000 trên máy hiện có một dịch vụ TKB khác nên không dừng nó. `.env.example`, `.env` cục bộ và Vite proxy đã được đồng bộ; thay deployment port phải cập nhật proxy/BACKEND_URL tương ứng.

```powershell
# backend/
npm ci
npm start
npm test
npm run test:integration
# frontend/
npm ci
npm run dev
npm test
npm run build
```

Node >=20. Backend `.env` cần các key đã có của GiaPhuc và các key TKB trong `.env.example`. Server cập nhật system-role permission catalog, không reset password admin. `npm run seed` chỉ dùng khi chủ động cần tạo/reset admin theo cấu hình seed.

Integration test dùng URI TKB cấu hình hiện có nhưng tạo database `giaphuc_tkb_test_<random>`, tối đa 38 byte tên để tương thích môi trường hiện tại, và dọn đúng database test đó. Không chạy integration test với principal không được tạo/drop database test. Pure tests dùng cấu hình giả và không cần secrets/DB sản phẩm.

`TKB_PREVIEW_LIMIT=6` giới hạn preview chưa commit; preview đã có lịch lưu được bảo vệ. `TKB_PREVIEW_TTL_SECONDS=0` là không hết hạn. Bật TTL thì preview quá hạn không được commit. Không xóa preview/lịch cũ bằng tay khi chưa có backup và chính sách giữ dữ liệu.

## API và quyền

Mọi endpoint dưới `/api/timetable` cần `tkb:read` cùng quyền hành động tương ứng.

| Endpoint | Quyền bổ sung |
|---|---|
| GET `/dashboard`, `/teachers`, `/subjects`, `/classes`, `/branches`, `/blocks` và detail | không |
| POST/PATCH/DELETE `/teachers`, `/subjects`, `/classes` | `tkb:catalog:manage` |
| GET `/teachers/:id/preferences` | không |
| PUT `/teachers/:id/preferences` | `tkb:preference:update` |
| GET `/schedules/health`, `/schedules/committed`, `/schedules/committed/:id/full` | không |
| POST `/schedules/generate` | `tkb:generate` |
| POST `/schedules/commit` | `tkb:commit` |
| DELETE `/schedules/committed/:id` | `tkb:delete` |
| POST `/assistant/preview` | `tkb:adjust` |
| POST `/assistant/confirm` | `tkb:adjust` |

Trợ lý điều chỉnh chỉ nhận yêu cầu đổi một giáo viên/một tiết ở giai đoạn đầu. Parser AI (nếu cấu hình `TKB_AI_API_KEY` và `TKB_AI_MODEL`) chỉ trả intent JSON; planner luôn dùng evaluator/solver hiện tại. Khi chưa cấu hình AI, parser cục bộ có whitelist cú pháp tiếng Việt được dùng để tránh phụ thuộc dịch vụ ngoài. Preview được giữ trong bộ nhớ tối đa 15 phút, xác minh lại content hash và toàn bộ hard constraints ở bước confirm. Confirm tạo schedule append-only mới; phiên bản nguồn không bị ghi đè. Không có endpoint nào cho phép client gửi trực tiếp `slots`, `teacherId`, `day` hoặc `solution` để ghi lịch.

Từ 08/10/2026, trợ lý dùng ModelAPI Chat Completions giống mini project Ai: `TKB_AI_BASE_URL=https://modelapi.vn/v1`, `TKB_AI_MODEL=codex-auto-review`, `TKB_AI_TIMEOUT_MS=60000`, key ở `backend/.env`. Backend gọi trực tiếp, không import source hoặc cần chạy server Next.js của Ai. Chỉ gửi câu yêu cầu cho nhà cung cấp; không gửi toàn bộ lịch/danh mục. Model trả `move_lesson`, `clarify` hoặc `unsupported`, schema được kiểm tra trước planner. Chỉ hỗ trợ chuyển một tiết, không chat chung, tạo/xóa lịch, đổi danh mục/nguyện vọng hoặc tối ưu hàng loạt. Thiếu thông tin phải hỏi lại, không tự tạo giờ/giáo viên.

Test parser: `node --require ./tests/setup.cjs --test tests/timetable/assistant-intent.test.js`. Kiểm thử thật: `node tests/timetable/assistant-live.cjs` (gọi nhà cung cấp có phí và đọc lịch sản phẩm, không commit). Kết quả: hiểu câu tự nhiên, từ chối yêu cầu ngoài phạm vi, hỏi lại khung giờ thiếu; preview trên phiên bản 8 có 1 thay đổi, 0 vi phạm cứng, không ghi phiên bản.

Generate body chỉ gồm `candidateCount`, `optimizationMode`; `useAI` đã bỏ và bị từ chối như field ngoài hợp đồng. Commit body chỉ gồm `requestId`, `solutionId`. API version `timetable-v1`. Lỗi JSON sai cú pháp trả JSON HTTP400. Busy worker trả HTTP429/BUSY, không giả là đã xếp nhưng không có lời giải.

## Dọn mã và khôi phục

### Chuyển nhiều tiết bằng trợ lý

Trợ lý hỗ trợ một tiết, danh sách tối đa 20 tiết có nguồn/đích cụ thể, hoặc toàn bộ tiết của một giáo viên trong ngày/buổi. Ví dụ: “Chuyển toàn bộ tiết thứ 4 của Nguyễn Thị Thu Kim sang thứ 5”. Intent `move_day` chỉ chứa tên và ngày/buổi; backend tự chọn tất cả tiết nguồn trong snapshot, model không được tự tạo danh sách tiết.

Chuyển cả ngày mặc định giữ buổi, ưu tiên giữ số tiết. Nếu xung đột thì tìm giờ khác trên ngày đích trong cùng buổi (tối đa 5.000 nút / 3 giây); giờ mới hiện đầy đủ trong preview. Chỉ điều chỉnh các tiết đã chọn, không tự đổi giáo viên hay di chuyển tiết của người khác trong nhánh nhiều tiết. Khi không tìm được lời giải, báo không có phương án hoặc hết giới hạn tìm kiếm, không lưu một phần. Nhiều nguồn/đích cụ thể được áp dụng đồng thời nên có thể hoán đổi tiết mà không bị lỗi ở bước trung gian.

Tất cả đề xuất được evaluator kiểm tra toàn lịch; confirm vẫn kiểm tra lại hash và quy tắc hiện tại, tạo một phiên bản mới cho cả nhóm. Thiếu nguồn, nguồn lặp hoặc tên giáo viên mơ hồ đều chặn yêu cầu. Quyền vẫn là `tkb:adjust`.

Kiểm thử: 13 test parser/planner đạt. `node tests/timetable/assistant-batch-live.cjs` đã gọi ModelAPI thật và lập preview trên phiên bản 8: chuyển 6/6 tiết của Nguyễn Thị Thu Kim từ thứ 4 sang thứ 5, 0 vi phạm cứng, không ghi lịch.

Ứng dụng `thuanhung_tkb/` độc lập, AI service/Python virtualenv/cache, mock/planner/provider, benchmark AI, preview API cũ và các màn hình shell cũ đã được bỏ. Không cài model hay tải trọng số mới. Giữ test solver/validator/CRUD/persistence và bổ sung test JWT/RBAC, MongoDB, worker và UI hồi quy.

Bản phục hồi cục bộ: `.backups/retired-thuanhung_tkb-2026-10-07.zip` (40 file mã/cấu hình), `.backups/timetable-phase-docs-2026-10-07.zip` (47 tài liệu phase cũ). Generated dependencies có thể cài lại; không lưu node_modules/venv trong ZIP. Các ZIP và legacy-state không commit. QA trước tích hợp nằm ở `history/`, không dùng làm mô tả trạng thái hiện tại.
