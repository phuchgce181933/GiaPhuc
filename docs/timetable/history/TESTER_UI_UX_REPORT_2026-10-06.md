# Báo cáo kiểm thử và đề xuất UI/UX — thuanhung_tkb

> Báo cáo lịch sử trước tích hợp. Các phát hiện được xử lý trong [báo cáo bảo trì ngày 07/10/2026](../MAINTENANCE_REPORT_2026-10-07.md). Đường dẫn, số lượng test và trạng thái dưới đây là tại thời điểm kiểm thử cũ.

Ngày kiểm thử: 06/10/2026. Vai trò: tester chức năng, đối chiếu nghiệp vụ và đánh giá khả năng sử dụng.

## 1. Kết luận

**Chưa đủ điều kiện chốt báo cáo nghiệp vụ hoàn chỉnh theo điều kiện “không phát sinh lỗi” của chủ dự án.** Luồng tạo → chọn → xác nhận lưu hoạt động trên dữ liệu hiện tại, nhưng đã tái hiện lỗi mất nguyện vọng khi lưu đồng thời, xử lý sai file nguyện vọng hỏng, mất bản nháp khi chuyển trang và thiếu chức năng mở lại lịch đã lưu trên UI.

Chưa tìm thấy lịch được chấp nhận có vi phạm các ràng buộc đang được kiểm tra trong phạm vi lần test này. Điều này không đồng nghĩa toàn bộ hệ thống đã hết lỗi hoặc thời gian đi lại đã được kiểm chứng. Thời gian di chuyển giữa phân hiệu vẫn chưa có dữ liệu; chủ dự án đã xác nhận được lưu với cảnh báo.

Báo cáo này là **báo cáo kiểm thử và đề xuất cải thiện**, không phải biên bản nghiệm thu hay báo cáo nghiệp vụ đã chốt. Chưa sửa mã nguồn ứng dụng và chưa triển khai thiết kế mới.

## 2. Phạm vi, dữ liệu và môi trường

- Kiểm tra mã nguồn, bộ test hiện có, tài liệu, API thật và thao tác trên trình duyệt.
- Dữ liệu: 7 phân hiệu, 113 lớp, 40 giáo viên đang sử dụng, 5 môn đang sử dụng, 479 phân công, 802 tiết cần xếp. Danh mục có thêm môn Công nghệ đang ngừng sử dụng.
- API vận hành ở cổng 4010 chỉ được đọc. API kiểm thử riêng ở `127.0.0.1:4011`, frontend riêng ở `127.0.0.1:5174`; catalog, nguyện vọng, preview và lịch lưu sử dụng kho tách riêng. Bản sao overlay hiện có được dùng khi có file nguồn.
- Đã thử giao diện ở chiều rộng 1440px, 375px và kích thước mặc định của trình duyệt trong ứng dụng. Đây là kiểm tra responsive, chưa phải chứng nhận trên thiết bị thật hoặc nhiều trình duyệt.
- AI cấu hình thực tế là `mock`. Đã thử tạo với `useAI=false` và chế độ mặc định `useAI=true`. Không chạy lại mô hình AirLLM/GPU hoặc benchmark dài; số liệu trong tài liệu Phase 35 không được tính là kết quả test mới.
- Không thực hiện kiểm thử tải nhiều người dùng, rà soát bảo mật toàn diện hoặc thử phục hồi sau mất điện. Các bài test persistence hiện có đã được chạy trong bộ backend.

## 3. Kết quả kiểm thử

| Hạng mục | Kết quả | Nhận xét |
|---|---:|---|
| Backend, `npm test` | 887/890 đạt; 3 thất bại | 168,3 giây. Không có bài bị bỏ qua. |
| Chạy lại riêng 3 bài thất bại, concurrency 1 | 0/3 đạt | Cả 3 tái hiện; không chỉ do tải máy. |
| Frontend, `npm test` | 98/98 đạt | 5 file test; 16,63 giây. |
| Python AI service, pytest | 93/93 đạt | 17,06 giây; 1 cảnh báo dependency, không gây thất bại. |
| Frontend production build | Đạt | 4,99 giây; 51 module. |
| API bổ sung trên kho riêng | 27/28 đạt | JSON sai cú pháp trả HTML, xem F10. |
| Tạo lịch bằng trình duyệt | Đạt | Trả 3 phương án, mỗi phương án đủ 802 tiết, báo 0 vi phạm cứng. |
| Xác nhận lưu bằng trình duyệt | Đạt | Lưu 1 lịch, phiên bản 1, đủ 802 tiết; đọc lại qua API được. |
| Lưu lặp cùng phương án | Đạt | `COMMITTED_DUPLICATE`, vẫn 1 lịch. |
| Kiểm tra trực tiếp 802 tiết đã đọc lại | Đạt | Không trùng giáo viên/lớp cùng ngày-tiết; không có hai ô bị khóa; ca phù hợp số tiết. Đây là kiểm tra độc lập đơn giản, không thay thế toàn bộ evaluator. |

Các API đã thử thêm: số phương án không hợp lệ, boolean sai kiểu, field ngoài hợp đồng, body array, endpoint không tồn tại, preview không tồn tại, thêm/sửa/xóa giáo viên/môn/lớp, mã trùng, phân hiệu chính bất biến và PATCH không áp dụng một phần, capacity âm, capacity 0, nguyện vọng sai, nguyện vọng hợp lệ đọc lại được, từ chối chọn phân hiệu chính làm nơi điều chuyển, chặn xóa giáo viên đang được tham chiếu và phục hồi số lượng danh mục sau thao tác test.

Ba bài backend thất bại:

1. `phase24_1_optimization_effectiveness.test.js:444` và `phase25_global_assignment_optimization.test.js:330`: lịch vẫn đủ 802 tiết và evaluator chấp nhận; assertion sau đó yêu cầu các phân công không thuộc danh sách chờ điều chuyển phải tiếp tục do giáo viên thuộc phân hiệu đó dạy. Có một phân công không còn thỏa assertion này. Đây là kiểm tra **tính địa phương của phân công**, không chỉ là so sánh ID giáo viên trước/sau. Với xác nhận mới cho phép đổi giáo viên để tối ưu tải, cần cập nhật hợp đồng của test và cách trình bày bước “xếp tại chỗ” sau tối ưu; chưa kết luận hai thất bại này là lịch sai nghiệp vụ.
2. `search_correctness.test.js:110`: khi bỏ quyền điều chuyển, solver vẫn từ chối tạo lịch như mong đợi, nhưng trả `INSUFFICIENT_CAPACITY` thay cho `UNRESOLVED`. Thất bại ở assertion mã chẩn đoán, không phải chấp nhận giáo viên không được phép. Cần thống nhất cách phân biệt thiếu năng lực và thiếu quyền ở chẩn đoán; không sửa assertion chỉ để làm bộ test xanh.

## 4. Quy tắc nghiệp vụ chủ dự án đã xác nhận

| Quy tắc | Xác nhận trong phiên kiểm thử | Ý nghĩa kiểm thử/UI |
|---|---|---|
| Tối ưu sau bước xếp tại phân hiệu chính | Được đổi giáo viên để tối ưu tải, miễn đúng ràng buộc | Không dùng “giữ nguyên mọi phân công tại chỗ” làm tiêu chí nghiệm thu. Cần phân biệt số liệu bước ban đầu với số liệu phương án cuối. |
| Thiếu thời gian di chuyển | Được lưu với cảnh báo chưa kiểm tra thời gian di chuyển | Không coi riêng H14 chưa hỗ trợ là lỗi chặn lưu. Cảnh báo phải rõ khi xem phương án và khi xác nhận lưu. |
| Phạm vi môn | Chỉ quản lý các môn bộ môn đang có dữ liệu | Nên gọi rõ “TKB các môn bộ môn”; ô trống không có nghĩa lớp không học các môn khác. |
| Hai tiết cùng môn liên tiếp | Không cho phép đối với mọi môn trong cùng buổi | H16 phù hợp xác nhận; không tự thêm ngoại lệ tiết đôi. |
| Hai ô khóa cố định | Khóa tiết 1 sáng thứ 2 và tiết 4 sáng thứ 6 ở mọi phân hiệu | H15 phù hợp xác nhận; nên hiển thị ô khóa bằng chú thích riêng. |

Các quy tắc khác đối chiếu được từ mã nguồn và test: giáo viên/lớp không trùng giờ; chuyên môn phù hợp; tiết học thuộc phân hiệu của lớp và lịch khả dụng; đủ định mức; giới hạn tiết/tuần chỉ áp dụng khi khai báo rõ `capacityPeriodsPerWeek`; nguyện vọng là ưu tiên mềm; một buổi là một cặp ngày–ca có ít nhất một tiết; phân hiệu chính của giáo viên không được đổi sau khi tạo; hai tiết liên tiếp trong cùng ca không được ở hai phân hiệu khác nhau; commit kiểm tra lại dữ liệu hiện tại và lưu lặp có tính idempotent.

Không còn câu hỏi nghiệp vụ đang chờ trả lời từ các câu hỏi đã gửi trong phiên này. Việc thống nhất chẩn đoán của bài test thứ ba và đồng bộ tài liệu vẫn là công việc cần xử lý trước nghiệm thu.

## 5. Phát hiện có bằng chứng và cách xử lý

Mức ưu tiên: **P1** cần xử lý trước sử dụng chính thức vì mất dữ liệu hoặc chặn luồng chính; **P2** ảnh hưởng thao tác, khả năng hiểu hoặc tính ổn định; **P3** cải thiện tài liệu/chất lượng thông báo.

### F01 — P1: Hai lần lưu nguyện vọng đồng thời có thể mất dữ liệu

- Nguồn: `backend/src/persistence/teacher-preference-store.js:12`.
- Tái hiện bằng hai giáo viên giả A/B, chạy `Promise.allSettled([store.put(A, ...), store.put(B, ...)])` trên cùng file tạm.
- Thực tế: **cả hai promise fulfilled**, nhưng file cuối chỉ còn giáo viên B. A bị mất dù thao tác báo thành công.
- Mong đợi: cả hai bản ghi đều còn sau khi đọc lại.
- Nguyên nhân thấy trong mã: hai thao tác cùng đọc snapshot trước khi ghi; cùng tên file tạm theo PID; không có hàng đợi bảo vệ chuỗi đọc–sửa–ghi.
- Đề xuất: tuần tự hóa cập nhật theo file trong một process, file tạm có tên riêng, kiểm tra đọc lại; nếu triển khai nhiều process thì cần cơ chế cập nhật an toàn giữa process. Có thể theo mẫu `CatalogStore.update` hiện có, tránh tạo tầng lưu trữ trùng mục đích. Cần regression test hai người lưu cùng lúc.
- Bằng chứng: [preference-probe.json](tester-evidence-2026-10-06/preference-probe.json).

### F02 — P1: File nguyện vọng hỏng bị coi như không có dữ liệu

- Nguồn: `backend/src/persistence/teacher-preference-store.js:8`.
- Tái hiện: file tạm chứa JSON bị cắt dở, gọi `readAll()`, sau đó lưu nguyện vọng giáo viên B.
- Thực tế: `readAll()` trả `{}`; lần lưu tiếp theo thay file bằng dữ liệu B, không báo tình trạng hỏng file.
- Mong đợi: file không tồn tại có thể coi là chưa cấu hình; lỗi parse/quyền truy cập phải được báo và chặn ghi đè, giữ dữ liệu để phục hồi.
- Đề xuất: chỉ bắt `ENOENT` như trường hợp thiếu file; trả lỗi rõ với các lỗi còn lại; test file hỏng và đọc không được. Không tự khôi phục giá trị mặc định.
- Bằng chứng: cùng [preference-probe.json](tester-evidence-2026-10-06/preference-probe.json).

### F03 — P1: Chưa mở lại được TKB đã lưu trên UI

- Nguồn: `frontend/src/features/scheduling/components/CommittedPanel.jsx:35`.
- Tái hiện: tạo → lưu → tải lại trang `/generate`.
- Thực tế: có dòng “Đã lưu 1 thời khóa biểu” và bảng metadata, nhưng không có nút mở lịch và không có lưới TKB. API `/api/schedules/committed/:id/full` vẫn trả đủ 802 tiết.
- Mong đợi: người dùng chọn lịch đã lưu, xem lại theo lớp/giáo viên/phân hiệu mà không phải tạo lịch mới.
- Đề xuất: thêm hành động “Xem lịch”; sử dụng API hiện có, tái dùng `ScheduleGrid` trong feature scheduling; cung cấp tên lịch dễ nhớ và phiên bản. Giữ bản dữ liệu và danh mục tại thời điểm lưu để việc đổi tên/ngừng sử dụng sau này không khiến lịch cũ khó đọc.
- Bằng chứng: [saved-after-reload.jpg](tester-evidence-2026-10-06/saved-after-reload.jpg), API read-back trong `api-checks.json`.

### F04 — P2: Chuyển trang làm mất nguyện vọng chưa lưu, không cảnh báo

- Nguồn: `frontend/src/features/catalog/pages/CatalogPages.jsx:39` và xử lý navigation ở `frontend/src/App.jsx`.
- Tái hiện: chọn giáo viên, nhập số buổi `3`, nút lưu được bật; bấm “Tổng quan”; quay lại giáo viên đó.
- Thực tế: không có xác nhận rời trang; số `3` đã mất. Handler `beforeunload` không bảo vệ navigation nội bộ của SPA.
- Đề xuất: bảo vệ đổi route, đổi giáo viên và đổi bộ lọc nếu đang dirty; hộp thoại có “Lưu và tiếp tục / Bỏ thay đổi / Ở lại”. Giữ bản nháp khi lưu lỗi.

### F05 — P2: Focus bàn phím đi ra ngoài hộp thoại lưu

- Nguồn: `frontend/src/features/scheduling/components/CommitDialog.jsx:49`.
- Tái hiện: mở “Lưu phương án này…”, đọc activeElement; bấm Tab.
- Thực tế: focus vẫn ở nút phía sau modal; Tab chuyển tới “Đang xem” cũng nằm phía sau. `aria-modal=true` chưa đi kèm quản lý focus.
- Đề xuất: tái dùng cách dùng native `dialog.showModal()` đang có trong `CatalogEditor.jsx`, hoặc quản lý initial focus, focus trap, Escape và trả focus về nút mở. Chặn Escape/đóng trong khi lưu nếu cần giữ tính nhất quán.

### F06 — P2: Lọc phân hiệu có thể tạo lưới trống gây hiểu nhầm

- Nguồn: `frontend/src/features/scheduling/pages/SchedulePage.jsx:339`, `hooks.js:135`.
- Tái hiện: lớp `1A` thuộc Trường chính đang được chọn; đổi phân hiệu thành Phân hiệu 1.
- Thực tế: dropdown vẫn có 114 lựa chọn gồm placeholder và tất cả 113 lớp; vẫn giữ `1A`; lưới không có ô nào có tiết và không giải thích lý do.
- Đề xuất: lọc danh sách lớp theo phân hiệu, tự chọn lớp hợp lệ hoặc yêu cầu chọn lại; nếu không có dữ liệu thì nói “Lớp này không thuộc phân hiệu đang chọn”, tránh hiện lưới trống như lịch chưa xếp.
- Bằng chứng: [class-filter-empty.jpg](tester-evidence-2026-10-06/class-filter-empty.jpg).

### F07 — P2: Lưới lịch hiện Chiều trước Sáng

- Nguồn: `backend/src/api/mappers.js:185` sắp xếp tên ca theo chữ; `frontend/src/features/scheduling/components/ScheduleGrid.jsx:120` giữ thứ tự đó.
- Thực tế trên lịch thật: `['Chiều', 'Sáng']`.
- Đề xuất: thứ tự nghiệp vụ cố định Sáng → Chiều; tiết tăng dần trong từng ca. Ô khóa thể hiện “Không xếp” có chú thích; ô không thuộc phạm vi môn bộ môn cần được giải thích riêng.

### F08 — P2: Trang có lịch đã lưu bị tràn ngang ở 375px

- Nguồn: bảng trong `CommittedPanel.jsx` và `.tkb-committed-table` trong `frontend/src/styles.css`.
- Đo trực tiếp: viewport 375px, main 360px nhưng document scrollWidth **693px**, bảng lịch đã lưu rộng khoảng **669px**.
- Đề xuất: bọc bảng trong vùng scroll riêng như `.tkb-grid-wrap` đã có, hoặc dùng card trên màn hình hẹp; trang không tràn ngang. Thu gọn ID/hash và chuyển chúng vào chi tiết kỹ thuật. Navigation mobile cần dễ phát hiện các mục đang nằm ngoài vùng nhìn.
- Bằng chứng: [generate-mobile.jpg](tester-evidence-2026-10-06/generate-mobile.jpg). Form nguyện vọng không có hiện tượng tràn toàn trang trong phép đo tương tự.

### F09 — P2: Nhãn “Đã dùng chiến lược AI” không phân biệt chế độ mock

- Nguồn: `backend/src/api/status.js:mapAiStatus` và `frontend/src/features/scheduling/components/StatusBanner.jsx:89`.
- Tái hiện: health báo provider `mock`, bật tùy chọn mặc định rồi tạo lịch.
- Thực tế: UI báo “Đã dùng chiến lược AI”, không nói đây là bộ đề xuất mô phỏng; chưa có inference mô hình thật trong lần chạy này.
- Đề xuất: giữ riêng các trạng thái “Chiến lược mô phỏng”, “Đã dùng mô hình AI” và “Xếp tự động dự phòng”. Khi provider là mock, giải thích trước khi người dùng bấm tạo. Không suy diễn rằng kết quả mock chứng minh chất lượng AirLLM.
- Bằng chứng: [ai-status.jpg](tester-evidence-2026-10-06/ai-status.jpg).

### F10 — P3: JSON sai cú pháp trả lỗi HTML

- Nguồn: `backend/src/app.js`, `express.json` chạy trước các router và handler lỗi hiện có.
- Tái hiện: `POST /api/teachers`, `Content-Type: application/json`, body `{`.
- Thực tế: HTTP 400, `text/html; charset=utf-8`, thay vì JSON có thông báo và field/code như các lỗi API thông thường.
- Đề xuất: handler lỗi JSON ở cấp app; không trả nội dung stack cho UI; test malformed JSON để duy trì định dạng lỗi ổn định.
- Bằng chứng: ca cuối trong [api-checks.json](tester-evidence-2026-10-06/api-checks.json).

### F11 — P3: Tài liệu đang mô tả nhiều hợp đồng cũ

- `README.md` còn nói frontend stub, commit chưa ghi dữ liệu và 87/98 tests, trong khi đã có lưu file và bộ test hiện tại lớn hơn nhiều.
- `CONSTRAINT_SPECIFICATION.md` còn tổng cộng 14 hard constraints, gate H09 theo workload placeholder và nghỉ theo `thuNghi`; mã hiện tại có H15–H17, capacity rõ ràng, và phân biệt nghỉ mềm với nghỉ cố định.
- `REAL_DATA_BLOCKED.md` và `CATALOG_CRUD.md` còn một số kết luận về thiếu quyền/không suy ra quyền điều chuyển cần đối chiếu với cấu hình hiện tại `AUTO_SHORTAGE`.
- Đề xuất: cập nhật tài liệu mô tả trạng thái hiện tại, ghi lịch sử phase là lịch sử; không dùng báo cáo phase cũ làm cam kết triển khai hiện tại. Đồng bộ các test đang đỏ với hợp đồng đã được xác nhận.

## 6. Phương án UI dễ hiểu nhất cho người sử dụng

Khuyến nghị chọn **luồng 3 bước trên cùng màn hình**, giữ hướng Premium dark SaaS của dự án. Thay đổi bố cục/nhãn không tự thay đổi quy tắc nghiệp vụ.

| Phương án | Phù hợp | Ưu/nhược điểm | Khuyến nghị |
|---|---|---|---|
| A. Ba bước “Kiểm tra dữ liệu → Tạo và so sánh → Xem và lưu” | Người phụ trách xếp lịch, sử dụng không thường xuyên | Nêu rõ việc cần làm và trạng thái; ít phải đọc số liệu kỹ thuật | **Ưu tiên** |
| B. Một màn hình chuyên gia có mọi thông số | Người hiểu solver, thao tác thường xuyên | Nhanh khi quen nhưng nặng với người mới | Đặt thành chế độ nâng cao |
| C. Dashboard nhiều tab phân tích | Người quản lý theo dõi tải, nguyện vọng, điều chuyển | Hữu ích khi phân tích, dễ làm người nhập liệu phân tán | Thực hiện sau khi luồng A ổn định |

### Bước 1 — Kiểm tra dữ liệu

- Tổng quan hiển thị “802 tiết cần xếp”, “113 lớp”, “40 giáo viên đang sử dụng”, kèm trạng thái dữ liệu và nút “Kiểm tra trước khi tạo”.
- Đặt tên sản phẩm dễ hiểu: “Quản lý TKB bộ môn Thuận Hưng”. Thay `Active/Inactive`, `Assignment`, `Workload`, `Curriculum`, `Solution` bằng “Đang sử dụng/Ngừng sử dụng”, “Phân công”, “Số tiết”, “Định mức môn học”, “Phương án”.
- Tách “Giới hạn tiết/tuần” khỏi “Số tiết lịch sử” và “Số buổi mong muốn”; diễn giải ngắn ngay cạnh trường, giữ giá trị chưa khai báo là chưa khai báo.
- Trong form nguyện vọng: nhóm “Ca dạy”, “Ngày/ca muốn nghỉ”, “Nơi muốn dạy”, “Số buổi mong muốn”; không cho hiểu nguyện vọng là điều cấm hoặc là quyền điều chuyển. Ngày nghỉ là “Không” thì ca nghỉ nên được vô hiệu hóa/giải thích. Trường số buổi cần nêu tổng số buổi có thể có theo lịch trường, tránh nhập mục tiêu vượt lịch mà không được giải thích.
- Khi dữ liệu thiếu/sai, hiển thị rõ giáo viên/lớp/môn nào cần sửa và đường dẫn tới hồ sơ; lỗi nằm cạnh trường, có bản tóm tắt lỗi nhận focus khi gửi form thất bại.

### Bước 2 — Tạo và so sánh

- Mặc định đề xuất 3 phương án; phần nâng cao chứa chọn AI/chế độ xếp và chi tiết điểm.
- Mỗi card ban đầu chỉ cần: “Đủ 802/802 tiết”, “0 vi phạm quy tắc đang kiểm tra”, chênh lệch tải, mức đáp ứng nguyện vọng **nếu có số liệu đã kiểm chứng**, số giáo viên/lượt điều chuyển và cảnh báo đi lại.
- Dùng “Được hệ thống xếp hạng cao nhất” thay cho “Tốt nhất” tuyệt đối. Điểm hiện tại phụ thuộc tiêu chí/pool; không biến `0.5840` thành “58,4% chất lượng” nếu chưa có hợp đồng thang điểm như vậy.
- Giải thích khác biệt giữa phương án bằng câu dễ đọc; độ khác nhau không được trình bày như chất lượng tốt hơn.
- Thu gọn diagnostics, UUID/hash, độ lệch chuẩn, trọng số và trạng thái H/S vào “Thông tin kiểm tra”. Cảnh báo chưa kiểm tra di chuyển vẫn cần hiện ở phần người dùng đọc.
- Số liệu “417/479 phân công tại chỗ” là kết quả bước ban đầu, trong khi phương án cuối có thể được tối ưu đổi giáo viên. Nhãn phải nói rõ thời điểm của số liệu; không dùng chúng như hai số cộng đơn giản nếu sau tối ưu có thay đổi.

### Bước 3 — Xem và lưu

- Đưa lưới TKB được chọn gần card phương án, trước các bảng điều chuyển dài. Hiển thị ca Sáng trước Chiều; giữ đầu cột ngày/cột tiết dễ theo dõi khi cuộn.
- Bộ lọc theo thứ tự “Xem theo → Phân hiệu → Lớp/Giáo viên”, các lựa chọn phụ thuộc nhau và không để lịch trống do lựa chọn mâu thuẫn.
- Hai hành động rõ: “Xem phương án” và “Lưu phương án”; chỉ một phương án đang được chọn.
- Hộp thoại lưu nhắc “802 tiết, phương án 1, chưa kiểm tra thời gian di chuyển” và xác nhận quy tắc đã được chủ dự án cho phép. Không diễn đạt “0 vi phạm” như bảo đảm đi lại khả thi.
- Sau lưu: hiển thị tên lịch, phiên bản, giờ Việt Nam/Bangkok dạng dễ đọc, nút “Xem lịch đã lưu”. UUID và thời gian UTC ISO hiện tại nằm trong chi tiết kỹ thuật. Xuất/in là cải tiến tiếp theo nếu trường cần, không coi là chức năng đã có.

Trên điện thoại, dùng card cho lịch đã lưu, bộ lọc một cột và vùng cuộn riêng cho lưới TKB. Giữ nền tối và một màu nhấn chính; dùng chữ/ký hiệu bên cạnh màu cảnh báo. Hướng dẫn UI/UX áp dụng: `.cursor/skills/ui-ux-pro-max/SKILL.md`, cùng các truy vấn `error summary validation` và `keyboard focus modal`.

## 7. Thứ tự thực hiện và tiêu chí kiểm tra lại

1. **Bảo vệ dữ liệu nguyện vọng:** F01/F02; test đồng thời không mất bản ghi, file hỏng báo lỗi và giữ nguyên file.
2. **Hoàn thiện vòng đời lịch:** F03; lưu → refresh → mở lại đúng phiên bản và 802 tiết; không tạo lịch mới chỉ để xem lịch đã lưu.
3. **Bảo vệ thao tác và bộ lọc:** F04/F05/F06; giữ bản nháp, focus trong modal, lọc lớp đúng phân hiệu.
4. **Sửa các điểm hiển thị:** F07/F08/F09/F10; ca đúng thứ tự, document không tràn ở 375px, phân biệt mock/model thật, lỗi API thống nhất.
5. **Chuẩn hóa tài liệu và test:** F11 và 3 bài đang đỏ; giữ kiểm tra đủ tiết/đúng chuyên môn/không trùng giờ/đúng quyền thay vì bỏ kiểm tra để đạt số lượng pass.
6. **Cải thiện bố cục 3 bước** sau khi các lỗi chính ổn định. Kiểm tra với người thực hiện xếp lịch: từ dữ liệu → tạo → chọn → xem → lưu → mở lại mà không cần đọc mã kỹ thuật. Chưa có dữ liệu thử nghiệm người dùng thật trong báo cáo này.

Chỉ chốt báo cáo nghiệp vụ hoàn chỉnh sau khi xử lý các lỗi gây mất dữ liệu/luồng chính, thống nhất các hợp đồng kiểm thử và kiểm tra lại. Không cần hỏi lại năm quy tắc đã được chủ dự án xác nhận ở mục 4.

## 8. Bằng chứng và tái hiện

Log: [backend-tests.log](tester-evidence-2026-10-06/backend-tests.log), [rerun.log](tester-evidence-2026-10-06/rerun.log), [frontend-tests.log](tester-evidence-2026-10-06/frontend-tests.log), [python-tests.log](tester-evidence-2026-10-06/python-tests.log), [build.log](tester-evidence-2026-10-06/build.log). API: [api-checks.json](tester-evidence-2026-10-06/api-checks.json). Snapshot số lượng và phép đo UI: [verification.json](tester-evidence-2026-10-06/verification.json).

Chạy bộ test từ đúng application:

```powershell
# backend/
npm test
node --test --test-concurrency=1 --test-name-pattern='preserves coverage under|preserves valid coverage|only unfinished demand' tests/phase24_1_optimization_effectiveness.test.js tests/phase25_global_assignment_optimization.test.js tests/search_correctness.test.js
# frontend/
npm test
npm run build
# ai-service/
.\.venv\Scripts\python.exe -m pytest -p no:cacheprovider
```

Tái hiện F01/F02 từ thư mục `backend/`, chỉ với file tạm và ID giả:

```javascript
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TeacherPreferenceStore } from './src/persistence/teacher-preference-store.js';
const file = join(mkdtempSync(join(tmpdir(), 'tkb-qa-')), 'preferences.json');
const store = new TeacherPreferenceStore(file);
writeFileSync(file, '{}');
console.log(await Promise.allSettled([
  store.put('TEST_TEACHER_A', { preferredSession: 'morning' }),
  store.put('TEST_TEACHER_B', { preferredSession: 'afternoon' }),
]));
console.log(store.readAll()); // mong đợi cả A và B
writeFileSync(file, '{"TEST_TEACHER_A":');
console.log(store.readAll()); // phải báo file hỏng
await store.put('TEST_TEACHER_B', { preferredSession: 'both' });
console.log(store.readAll()); // hiện tại ghi đè file hỏng
```

Lần xác nhận lưu ban đầu đã bị bộ phê duyệt tự động chặn vì quy tắc lưu khi thiếu dữ liệu đi lại chưa được chủ dự án xác nhận. Sau khi chủ dự án xác nhận **“Được lưu với cảnh báo chưa kiểm tra thời gian di chuyển”**, cùng thao tác đã được thực hiện thành công qua UI vào kho riêng. Không còn bước lưu bị chặn ở cuối lần test.

Trước khi dọn môi trường kiểm thử, API vận hành vẫn báo 0 lịch đã lưu, 6 preview và các số lượng danh mục ban đầu; API kiểm thử có 1 lịch, 2 preview và danh mục đã trở về số lượng ban đầu. Kho test và các process do tester tạo được dọn sau khi lưu bằng chứng. Ở lần kiểm tra sau khi dừng process test, cổng 4010 cũng không còn phản hồi; nguyên nhân dừng chưa được xác định. API được khởi động lại bằng `npm start` có sẵn của backend và kiểm tra lại thành công: health true, 0 lịch, 6 preview, 7 phân hiệu, 113 lớp, 40 giáo viên active, 5 môn active, 479 phân công, 802 tiết. API 4010 được để chạy khi bàn giao; cổng test 4011/5174 đã dừng. Log ghi giờ của host; ngày báo cáo dùng múi giờ Asia/Bangkok theo phiên làm việc.
