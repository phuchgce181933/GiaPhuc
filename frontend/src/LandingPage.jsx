import React from 'react';
import './landing.css';
import phucProfile from './assets/phuc-profile.png';
import heroWork from './assets/hero-work.png';

const features = [
  { icon: '✦', title: 'Không gian làm việc thống nhất', body: 'Đưa mọi dự án, thông tin và thành viên vào một trung tâm điều phối trực quan.' },
  { icon: '↗', title: 'Biến ý tưởng thành hành động', body: 'Tự động hóa và bàn giao thông minh giúp công việc luôn tiến lên mà không cần thêm cuộc họp.' },
  { icon: '◈', title: 'Rõ ràng ngay từ đầu', body: 'Luôn biết việc gì cần làm tiếp theo với góc nhìn phù hợp cách làm việc của bạn.' },
];

const modules = [
  { icon: '⌘', tag: 'NỀN TẢNG', title: 'RBAC & phân quyền', body: 'Quản lý người dùng, vai trò và quyền truy cập theo đúng nghiệp vụ.', example: 'Ví dụ: Admin xem toàn hệ thống · Giáo viên quản lý lớp · Sinh viên chỉ xem phần của mình.' },
  { icon: '◷', tag: 'LỊCH VẬN HÀNH', title: 'Timetable', body: 'Xây dựng thời khóa biểu, phân công lịch và theo dõi lịch học rõ ràng.', example: 'Ví dụ: tạo lịch theo lớp, phòng, giảng viên và kiểm tra xung đột trước khi chốt.' },
  { icon: '✎', tag: 'ĐÁNH GIÁ', title: 'Bài kiểm tra', body: 'Tạo ngân hàng câu hỏi, tổ chức bài kiểm tra và theo dõi kết quả học tập.', example: 'Ví dụ: học viên làm bài theo mã đề, hệ thống chấm điểm và trả kết quả.' },
  { icon: '▱', tag: 'SÁNG TẠO', title: 'Presentations', body: 'Quản lý bài thuyết trình, lịch sử thiết kế và kết nối quy trình Canva.', example: 'Ví dụ: lưu phiên bản, theo dõi trạng thái và cộng tác trên từng bài trình bày.' },
  { icon: '♙', tag: 'QUẢN TRỊ', title: 'Người dùng và vai trò', body: 'Một nơi để quản lý tài khoản, vai trò, trạng thái và quyền hệ thống.', example: 'Ví dụ: cấp quyền theo vai trò mà không phải chỉnh từng tài khoản thủ công.' },
  { icon: '◉', tag: 'CÁ NHÂN', title: 'Hồ sơ & hoạt động', body: 'Mỗi người có hồ sơ, thông tin cá nhân và lịch sử hoạt động minh bạch.', example: 'Ví dụ: cập nhật hồ sơ, xem quyền hiện tại và theo dõi thao tác gần đây.' },
];

function LandingPage() {
  return (
    <main className="site-shell">
      <nav className="nav-bar">
        <a className="brand" href="#top" aria-label="GiaPhuc home"><span className="brand-mark">N</span><span>GiaPhuc</span></a>
        <div className="nav-links"><a href="#modules">Tính năng</a><a href="#workflow">Cách hoạt động</a><a href="#stories">Khách hàng</a></div>
        <div className="nav-actions"><a className="login" href="#login">Đăng nhập</a><a className="button button-small" href="#start">Bắt đầu miễn phí <span>↗</span></a></div>
      </nav>
      <section className="about-section" id="about"><div className="about-image"><img src={phucProfile} alt="Huỳnh Gia Phúc" /></div><div className="about-copy"><div className="section-kicker">NGƯỜI ĐỨNG SAU GIAPHUC</div><h2>Xin chào, mình là<br /><span>Huỳnh Gia Phúc.</span></h2><p>Mình là sinh viên Công nghệ Thông tin, yêu thích phát triển sản phẩm số, thiết kế trải nghiệm và biến những ý tưởng khó thành giao diện dễ dùng.</p><div className="contact-grid"><a href="tel:0833040158"><small>ĐIỆN THOẠI</small><b>0833 040 158</b></a><a href="mailto:huynhgiaphuchgp@gmail.com"><small>EMAIL</small><b>huynhgiaphuchgp@gmail.com</b></a><a href="https://github.com/phuchgce181933" target="_blank" rel="noreferrer"><small>GITHUB</small><b>github.com/phuchgce181933</b></a><div><small>ĐỊA ĐIỂM</small><b>Cần Thơ, Việt Nam</b></div></div><div className="education-card"><div className="education-icon">⌘</div><div><small>HỌC VẤN</small><h3>Đại học FPT Cần Thơ</h3><p>Ngành Công nghệ Thông tin · 2023 – 2026</p><span>OOP · Cấu trúc dữ liệu · Cơ sở dữ liệu · Lập trình Web · Công nghệ phần mềm</span></div></div></div></section>


      <section className="hero" id="top">
        <div className="hero-copy">
          <div className="eyebrow"><span className="pulse-dot" /> MỘT NỀN TẢNG · NHIỀU QUY TRÌNH</div>
          <h1>Làm việc nhẹ nhàng hơn,<br /><em>hiệu quả hơn.</em></h1>
          <p className="hero-lead">GiaPhuc gom những chức năng khác nhau vào một hệ thống có cấu trúc rõ ràng — từ phân quyền, lịch vận hành đến kiểm tra và thuyết trình — để công việc nhẹ nhàng hơn, hiệu quả hơn.</p>
          <div className="hero-actions"><a className="button" href="#start">Bắt đầu miễn phí <span>↗</span></a><a className="text-link" href="#demo"><span className="play">▶</span> Xem qua trong 90 giây</a></div>
        </div>
        <div className="hero-visual hero-ecosystem" aria-label="Các module vận hành của GiaPhuc"><div className="ecosystem-glow"></div><div className="portrait-frame"><img src={heroWork} alt="Phúc, người phát triển GiaPhuc" /><div className="portrait-caption"><b>GiaPhuc</b><span>Hệ thống vận hành đa chức năng</span></div></div><div className="module-orbit orbit-a"><span className="orbit-icon">⌘</span><div><b>RBAC</b><small>Phân quyền</small></div></div><div className="module-orbit orbit-b"><span className="orbit-icon">◷</span><div><b>Timetable</b><small>Lịch vận hành</small></div></div><div className="module-orbit orbit-c"><span className="orbit-icon">✎</span><div><b>Progress Test</b><small>Đánh giá</small></div></div><div className="module-orbit orbit-d"><span className="orbit-icon">▱</span><div><b>Presentations</b><small>Sáng tạo</small></div></div><div className="ecosystem-label"><span className="label-dot"></span><div><b>GiaPhuc</b><small>Hệ thống vận hành đa chức năng</small></div></div></div>
      </section>
      <section className="modules-section" id="modules"><div className="modules-heading"><div><div className="section-kicker">CÁC TÍNH NĂNG TRONG HỆ THỐNG</div><h2>Một nền tảng.<br /><span>Nhiều quy trình được kết nối.</span></h2></div><p>GiaPhuc được xây dựng như một hệ thống quản trị nội bộ có phân quyền rõ ràng, giúp mỗi vai trò làm đúng phần việc của mình.</p></div><div className="modules-grid">{modules.map((module) => <article className="module-card" key={module.title}><div className="module-top"><span className="module-icon">{module.icon}</span><span className="module-tag">{module.tag}</span></div><h3>{module.title}</h3><p>{module.body}</p><div className="module-example"><b>MINH HỌA</b><span>{module.example}</span></div></article>)}</div></section>
      <section className="quote-section" id="stories"><div className="quote-mark">“</div><blockquote>GiaPhuc giúp tôi biến những ý tưởng thành sản phẩm rõ ràng, đẹp mắt và có giá trị thực tế.</blockquote><div className="quote-author"><span className="author-avatar">EC</span><span><b>Emily Chen</b><small>Giám đốc Sản phẩm, Pollen</small></span></div></section>
      <footer><a className="brand" href="#top"><span className="brand-mark">N</span><span>GiaPhuc</span></a><span>© 2024 GiaPhuc Inc.</span><div><a href="#privacy">Riêng tư</a><a href="#terms">Điều khoản</a><a href="#contact">Liên hệ</a></div></footer>
    </main>
  );
}

export default LandingPage;


