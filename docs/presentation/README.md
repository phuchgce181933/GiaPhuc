# Presentation module

## PowerPoint trực tiếp — không cần Canva

Sau khi AI tạo cấu trúc, mở bài thuyết trình và bấm **Tải PowerPoint (.pptx)**. Có thể tải cả khi chưa kết nối Canva hoặc bước Canva trước đó bị lỗi, miễn có outline hợp lệ. Nút dùng nội dung/ghi chú đang xem, kể cả chỉnh sửa chưa lưu. Bản xuất không thay đổi dữ liệu đã lưu.

`POST /api/presentations/:id/pptx` yêu cầu JWT, `presentation:read`, `presentation:export` và quyền sở hữu bài. Body tùy chọn `{outline:[{title,content,notes}],mediaIds:[]}`; không truyền outline thì dùng cấu trúc đã lưu. Trả binary PPTX với filename UTF-8, không trả link Canva. `includeImages` còn được hỗ trợ cho client cũ, nhưng giao diện mới tạo/xem trước minh họa riêng, không tự tạo khi xuất.

PptxGenJS dựng slide 16:9, chữ Arial có thể chỉnh sửa, giữ ghi chú vào Notes. Ba phong cách có màu riêng. Khi tắt ảnh, xuất file không gọi ModelAPI/Canva; bước đề xuất nội dung trước đó vẫn dùng ModelAPI.

Bật **Thêm minh họa** sau khi có kế hoạch. Mặc định tắt. Mỗi slide chọn Không đính kèm / Ảnh AI / Video AI, tùy chỉnh mô tả, bấm Tạo và kiểm tra bản xem trước. Vị trí được ghi rõ: theo bố cục slide. Không cần tạo cho mọi slide. Có thể tắt minh họa để xuất bản văn bản; bật không tự gọi API tạo media.

Nút **Tự thiết kế theo đề xuất AI** gọi AI nội dung đang cấu hình để chọn loại minh họa, viết prompt và giải thích theo từng slide. Đề xuất thay thế lựa chọn/mô tả hiện tại, có thể chỉnh tay, không tự tạo ảnh/video. `POST /:id/media-plan` nhận `{outline}`; cần quyền đọc/tạo và quyền sở hữu. Đề xuất phải đủ mọi slide, không trùng chỉ số và tối đa 20 slide có minh họa. Nếu outline thay đổi trong khi AI phân tích, UI yêu cầu lấy đề xuất lại.

Sau khi kiểm tra kế hoạch, bấm **Tạo toàn bộ minh họa theo kế hoạch** để gửi các yêu cầu lần lượt. Hệ thống bỏ qua minh họa đã hoàn tất hoặc video đã gửi, hiển thị tiến độ/lỗi từng slide và có nút dừng sau slide hiện tại. Video vẫn chạy nền ở nhà cung cấp. Tạo lại lượt sẽ dùng lại các kết quả thành công. Giữ trang mở trong khi hệ thống gửi lượt tạo; rời trang sẽ dừng gửi các slide tiếp theo.

Bố cục PowerPoint áp dụng nguyên tắc từ [PPT Master](https://github.com/hugohe3/ppt-master), có kế hoạch `layout` và sáu kiểu: mở đầu, phân đoạn/kết thúc, nội dung, hai cột, nhóm ý, quy trình. Mỗi slide có `colorRole` (`anchor`, `cool`, `warm`, `fresh`, `neutral`) để tạo nhịp đa sắc trong một palette thống nhất. Ảnh có `placement`: tự động, nền toàn slide, trái, phải, trên hoặc điểm nhấn; ảnh nền được crop full-bleed và phủ scrim để giữ tương phản chữ. Video không dùng làm nền. Đổi placement dùng lại media đã tạo, không gọi provider lần nữa. Slide cũ không có các trường mới vẫn xuất theo quy tắc tự động. Xem phạm vi tích hợp và giấy phép trong [ppt-master.md](ppt-master.md). Đã kiểm tra deck mẫu bằng chuyển OOXML → SVG (không có chẩn đoán lỗi) và render trên trình duyệt; đây là kiểm tra gần đúng, chưa xác minh bằng PowerPoint desktop.

Kết quả AI được chuẩn hóa riêng với dữ liệu nhập: bỏ metadata phụ, ghi chú thiếu thành chuỗi rỗng, chỉ số dạng chuỗi số thành số và loại minh họa thành chữ thường. Không cắt ngắn nội dung vượt giới hạn hoặc tự đoán slide bị thiếu. JSON/schema sai được gửi lại cho AI sửa một lượt, dùng chung tổng thời gian chờ; nếu vẫn sai, lỗi trả đúng tên tác vụ cùng đường dẫn trường không hợp lệ.

Ảnh: backend gọi `MODEL_IMAGE_API_URL=https://modelapi.vn/v1/images/generations`, dùng `MODEL_IMAGE_API_KEY` và `MODEL_IMAGE_MODEL=gpt-image-2` trong `.env`. Key không gửi tới trình duyệt. Yêu cầu gửi `size:1024x1024,n:1`; ảnh PNG/JPEG từ `data[0].b64_json` được nhúng và giữ đúng tỷ lệ thực tế. Ảnh minh họa không dùng để bịa biểu đồ/số liệu thống kê.

Quy tắc ảnh được thêm bắt buộc vào mọi prompt ở backend, kể cả mô tả tùy chỉnh: ban ngày mặc định ánh sáng tự nhiên cân bằng khoảng 5500K; cảnh tối dùng ánh sáng nhân tạo trung tính 4000–4500K. Không ám vàng/xanh hoặc lệch màu; giữ màu vật thể trung thực. Giả lập 50mm F1.8, hậu cảnh mờ nhẹ, chủ thể và chi tiết cần thiết rõ. Ảnh sang trọng dùng minimalism, bỏ chi tiết thừa, bóng tự nhiên mềm và màu không quá rực. Đây là hướng dẫn model, không phải phép đo/đảm bảo màu vật lý của ảnh trả về. Phiên bản quy tắc tham gia khóa cache; ảnh cũ vẫn được lưu nhưng UI yêu cầu tạo lại để áp dụng quy tắc mới.

Tạo ảnh có thể phát sinh phí nhà cung cấp. Cache trong collection `slide_images` của database presentation theo người dùng, model và nội dung/phong cách; tải lại cùng nội dung sẽ dùng ảnh đã lưu. Mỗi ảnh chờ tối đa 120 giây. Khi một ảnh lỗi, API báo lỗi và không xuất bản thiếu ảnh; ảnh đã thành công vẫn được lưu để thử lại. Có thể tắt tùy chọn để tải bản văn bản. Nhà cung cấp phải trả base64, không hỗ trợ tải URL ảnh tùy ý từ backend.

Video: `MODEL_VIDEO_API_URL=https://modelapi.vn/v1/videos`, `MODEL_VIDEO_MODEL=grok-imagine-video-1.5`, `MODEL_VIDEO_API_KEY`. Nên dùng key video riêng vì quyền video có thể khác key ảnh. POST gửi `{model,prompt,size:"1280x720",seconds:"8"}`. Backend chấp nhận `id` hoặc `task_id` (nếu có cả hai thì phải khớp), kiểm tra `GET /videos/:id`, và khi completed tải `GET /videos/:id/content`. Cả POST/GET đều gửi Bearer token và `Content-Type: application/json`. Chỉ gọi endpoint ModelAPI cấu hình; không đi theo redirect hoặc tải URL bất kỳ. Video lưu GridFS trong database presentations và nhúng MP4 vào PPTX, không phụ thuộc link tạm thời. Phát bằng nút play trong PowerPoint hỗ trợ MP4; ảnh vẫn giữ văn bản và ghi chú có thể chỉnh sửa.

Mọi prompt video được bổ sung quy tắc chuyển động nội tại: chủ thể phải cử động thật trong một cảnh liên tục 8 giây, camera chỉ là chuyển động phụ. Không chấp nhận video chỉ pan/zoom/parallax một ảnh tĩnh. Nhân vật con rùa phải có chuyển động nhất quán của đầu, mắt, chân trước, trọng lượng cơ thể và hành động được yêu cầu; cấm biến dạng mai, mọc thêm chân hoặc chuyển cảnh slideshow. Phiên bản quy tắc tham gia khóa cache nên lượt tạo mới không dùng lại video cũ tạo theo kiểu ảnh tĩnh.

Media là tài sản riêng theo owner và presentation, metadata trong `slide_media`. Tác vụ được giữ qua reload/restart. UI kiểm tra trạng thái mỗi 10 giây, tải blob qua API có JWT để xem trước, thu hồi object URL khi đóng. Thay đổi nội dung slide làm minh họa cũ không còn phù hợp; cần tạo lại. Xuất không nhận media của người khác, media chưa hoàn tất, media sai nội dung hoặc nhiều media cùng slide. Tối đa 20 media, 50 MB/video và 150 MB media/bản xuất. ModelAPI có thể tính phí ảnh/video; tạo lại cùng yêu cầu dùng cache, lỗi có nút thử lại. Không tự tạo video để kiểm thử thật: quyền/hạn mức model thực tế phụ thuộc tài khoản nhà cung cấp.

API media: `GET /:id/media`, `POST /:id/media` body `{outline,slideIndex,kind:"image"|"video",prompt?}`, `POST /:id/media/:assetId/refresh`, `GET /:id/media/:assetId/content`. Tạo cần `presentation:read` + `presentation:create`; đọc và kiểm tra trạng thái cần `presentation:read`. Mọi endpoint kiểm tra quyền sở hữu.

Lịch sử thiết kế có nút xóa riêng cho tài khoản có quyền `presentation:delete`. Giao diện yêu cầu xác nhận tên bản thiết kế trước khi gọi `DELETE /:id`. Backend kiểm tra quyền sở hữu, xóa ảnh/video và file GridFS của bản thiết kế trước khi xóa bản ghi; nếu đang mở đúng bản vừa xóa, giao diện đóng bản đó và cập nhật danh sách ngay.

Kiểm thử: `node --require ./tests/setup.cjs --test tests/presentation/pptx.test.cjs`. File ZIP PowerPoint, số slide, chữ tiếng Việt, ghi chú, tỷ lệ và quyền sở hữu đã kiểm tra; không có công cụ render PowerPoint trên máy nên chưa kiểm tra bằng ảnh render trong PowerPoint/LibreOffice.

Luồng: Nhập nội dung → Sửa cấu trúc → Xác nhận tạo Canva → Kết quả.

## Cấu hình

`PRESENTATION_MONGODB_URI` (tùy chọn), `PRESENTATION_MONGODB_DB=presentations`. Phần AI mặc định dùng `TKB_AI_API_KEY`, `TKB_AI_MODEL` và `TKB_AI_BASE_URL` đã có trong `backend/.env`, giống trợ lý TKB. Không cần tạo key AI khác. Chỉ đặt `MODEL_API_KEY`, `MODEL_API_MODEL`, `MODEL_API_URL` khi muốn ghi đè riêng cho slide. `MODEL_API_TIMEOUT_MS=180000` (cho phép 1000–300000 ms); frontend chờ tối đa 330 giây để nhận kết quả hoặc lỗi từ backend. Lỗi timeout phân biệt tạo cấu trúc và đề xuất minh họa.

`sourceContent` không còn giới hạn 50.000 ký tự ở validation hoặc Mongoose. Route `/api/presentations` nhận JSON tối đa 12 MB thay vì giới hạn chung 1 MB. Giới hạn tài liệu 16 MB của MongoDB và giới hạn ngữ cảnh của model vẫn là giới hạn kỹ thuật bên ngoài; nội dung cực lớn có thể bị nhà cung cấp AI từ chối.

Thiết lập thiết kế tách thành ba lớp: `presentationType` (Corporate & Business, Education, Minigame / Event, Văn hóa & Truyền thống), `visualStyle` (Minimalism, Flat Design & Illustration, Glassmorphism, Editorial, Monochrome & Muted, Bold Geometric / Poster, Tech Wireframe) và hệ màu hiện có. Mặc định là Education + Flat Design & Illustration + Năng động thương hiệu. Minimalism tăng nền giấy/khoảng trắng; Flat dùng panel/card đa sắc; Glassmorphism mô phỏng kính bằng shape trong suốt và viền sáng (không có backdrop blur thật như CSS); Editorial tăng tỷ lệ tiêu đề, dùng Georgia và bố cục bất đối xứng; Monochrome chỉ giới hạn palette khi người dùng chọn. Bold Geometric dùng đen–cam–kem, Arial Black và các mảng bo góc xoay lệch; Tech Wireframe dùng nền indigo cùng các arc cyan/teal chỉnh sửa được. Ngữ cảnh Event xoay accent mạnh hơn; Corporate tiết chế nền; Culture ưu tiên sắc ấm khi slide không có vai trò màu rõ.

Nguồn tham khảo phương pháp: [Gitiho – xu hướng thiết kế PowerPoint](https://gitiho.com/blog/8-xu-huong-thiet-ke-powerpoint-duoc-ua-chuong-nam-2021.html), [SlideFactory – xu hướng thiết kế](https://www.slidefactory.vn/7-xu-huong-thiet-ke-powerpoint/), [Slide24h – phong cách slide](https://slide24h.com/blog/8-xu-huong-phong-cach-thiet-ke-slide-dep), [Tuyệt Kỹ PowerPoint – nhóm mẫu theo chủ đề](https://tuyetkypowerpoint.com/tin-tong-hop/bo-suu-tap-100-mau-slide-powerpoint-thuyet-trinh-dep/), [Envato Tuts+ – mẫu trình bày doanh nghiệp](https://business.tutsplus.com/vi/tutorials/powerpoint-slide-design-templates--cms-32297). Các nguồn là định hướng tham khảo; engine chuyển chúng thành quy tắc riêng và không sao chép template/asset.

Để tạo thiết kế trên Canva, cần thêm `CANVA_CLIENT_ID`, `CANVA_CLIENT_SECRET`, `CANVA_REDIRECT_URI`, `CANVA_SCOPES` và `PRESENTATION_TOKEN_ENCRYPTION_KEY`. Key ModelAPI không thay thế Canva OAuth. Key chỉ ở backend.

Canva dùng OAuth 2.0 Authorization Code + PKCE. App Canva cần scopes `design:content:write design:content:read` và capability `design_generation`. Plugin Canva trong Codex không được dùng làm token cho web.

Canva Portal yêu cầu callback local dùng IP: `http://127.0.0.1:5001/api/presentations/canva/callback`, không dùng `localhost`. Đăng ký đúng URL này trong Outside Canva → Redirect URLs và đặt cùng giá trị vào `CANVA_REDIRECT_URI` trong `backend/.env`. Không nhập Client Secret vào `.env.example`, vì file mẫu được commit; backend chỉ nạp `.env`. Sau khi cấu hình phải khởi động lại backend và bấm Kết nối Canva để hoàn tất cấp quyền.

## API và quyền

API nằm dưới `/api/presentations`, yêu cầu JWT và quyền `presentation:read`, `presentation:create`, `presentation:update`, `presentation:export`, `presentation:delete`. Người dùng chỉ truy cập bản ghi do chính họ tạo.

`GET /`, `POST /`, `GET /canva/connect`, `GET /canva/callback`, `GET /:id`, `PATCH /:id`, `POST /:id/canva`, `POST /:id/export`, `DELETE /:id`.

`GET /canva/status` trả `configured` và `connected` cho người dùng đăng nhập, không trả credential/token. Giao diện hiện rõ trạng thái và khóa nút tạo thiết kế khi chưa kết nối. Nếu cấu hình đã đủ nhưng chưa cấp quyền, bấm Kết nối Canva và hoàn tất đăng nhập/consent trên Canva. Mở URL API trực tiếp trong thanh địa chỉ không kèm JWT sẽ trả 401, không phải lỗi tạo thiết kế.

PDF/PPTX chỉ hiển thị khi Canva trả về export format tương ứng. Link design/export là link tạm thời của Canva.

## Database

Module dùng MongoDB connection riêng với `dbName=presentations`, không dùng chung `giaphuc` hoặc `thuanhung_tkb`. Bản ghi lưu owner, nội dung, outline, trạng thái, job id, link Canva, lỗi và thông tin export; secret không gửi xuống frontend.

OAuth refresh token được lưu AES-256-GCM theo owner trong collection `canva_accounts`, không chỉ lưu trong bộ nhớ hoặc trên các thiết kế đã tồn tại. Token vẫn dùng được sau restart và khi tạo thiết kế mới. Các refresh cùng tài khoản được tuần tự hóa trong process để tránh dùng lại refresh token đã xoay. Giữ nguyên `PRESENTATION_TOKEN_ENCRYPTION_KEY`; nếu đổi khóa thì cần kết nối lại tài khoản.

## Vận hành và kiểm thử

Thiếu ModelAPI/Canva OAuth trả lỗi có kiểm soát và không báo thành công giả. Tất cả controller async chuyển lỗi vào middleware Express, không làm dừng server. Test lỗi: `node --require ./tests/setup.cjs --test tests/presentation/presentation-errors.test.cjs` (3 test đạt). Kiểm thử provider thật: `node tests/presentation/modelapi-live.cjs`, đã tạo JSON 2 slide hợp lệ bằng cấu hình TKB, không ghi database/không tạo Canva design. Tạo thiết kế Canva thật vẫn cần OAuth được cấu hình và tài khoản cấp quyền.
