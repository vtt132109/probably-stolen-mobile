# Probably Stolen — bản web cho điện thoại

Bản chuyển đổi không chính thức, có cảm ứng, cài đặt hình ảnh/FPS và khả năng thêm vào Màn hình chính. Việt hóa dùng bản mod VietnameseTranslation của Hyu. Tên, nội dung và tài nguyên game thuộc các chủ sở hữu tương ứng; đây không phải bản phát hành chính thức.

## Chơi

Mở https://vtt132109.github.io/probably-stolen-mobile/ rồi bấm **Chơi**. Trên iPhone: Chia sẻ → Thêm vào Màn hình chính. Chọn **Tải để chơi offline** nếu muốn dùng không cần mạng sau khi tải đủ.

Save lưu riêng trong trình duyệt trên thiết bị. Chuyển từ địa chỉ cũ: xuất bản sao save ở trang cũ, rồi nhập tại trang mới trước khi bấm Chơi. Không xóa dữ liệu trang khi chưa sao lưu.

## Triển khai

Repo chỉ chứa bản web đã build và công cụ triển khai, không chứa save cá nhân, thông tin đăng nhập hoặc toàn bộ môi trường Unity. `payload/` chia gói tải thành các phần dưới giới hạn kích thước file Git; `payload.json` ghi hash SHA-256. Workflow kiểm tra từng phần, ghép và giải nén cho máy chủ tĩnh, rồi triển khai bằng GitHub Pages. Không cần máy tính chủ chạy liên tục.

Build local với Node 22 trở lên:

```sh
node tooling/build-pages-site.mjs . site
```

Nguồn bản chơi: v5, `6a2154cb403ebf45ba9091c1`. Mặc định hình ảnh Vừa / 60 FPS. Giới hạn FPS không đảm bảo máy đạt đúng tốc độ đó. Trải nghiệm trên iPhone thật và toàn bộ nội dung game chưa được kiểm chứng hết.
