// Outbound mail for invites, resets, and the "your password changed" notice.
//
// Vietnamese because the recipients are the survey team, not the catalogue
// the desktop UI translates. Plain text and a matching HTML part, no images
// and no remote CSS: a tracking pixel is a request back to us that the
// recipient did not mean to make.

export interface OutboundEmail {
  to: string;
  from: string;
  subject: string;
  text: string;
  html: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function page(
  paragraphs: string[],
  link: { href: string; label: string },
): { text: string; html: string } {
  const text = [...paragraphs, link.href].join("\n\n");
  const html = `<!DOCTYPE html><html lang="vi"><body>${paragraphs
    .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
    .join(
      "",
    )}<p><a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a></p></body></html>`;
  return { text, html };
}

export function inviteEmail(to: string, from: string, registerUrl: string): OutboundEmail {
  const body = page(
    [
      "Bạn được mời tạo tài khoản GeoLibre.",
      "Liên kết có hiệu lực trong 72 giờ và chỉ dùng được một lần. Đừng chuyển tiếp thư này.",
    ],
    { href: registerUrl, label: "Tạo tài khoản" },
  );
  return { to, from, subject: "Lời mời tạo tài khoản GeoLibre", ...body };
}

export function resetEmail(to: string, from: string, resetUrl: string): OutboundEmail {
  const body = page(
    [
      "Có người yêu cầu đặt lại mật khẩu GeoLibre cho địa chỉ này.",
      "Liên kết có hiệu lực trong 30 phút và chỉ dùng được một lần. Nếu bạn không yêu cầu, hãy bỏ qua thư này.",
    ],
    { href: resetUrl, label: "Đặt lại mật khẩu" },
  );
  return { to, from, subject: "Đặt lại mật khẩu GeoLibre", ...body };
}

export function passwordChangedEmail(to: string, from: string): OutboundEmail {
  const text = [
    "Mật khẩu tài khoản GeoLibre của bạn vừa được đổi.",
    "Mọi phiên đăng nhập cũ đã bị thu hồi. Nếu bạn không thực hiện việc này, hãy liên hệ người quản trị ngay.",
  ].join("\n\n");
  const html = `<!DOCTYPE html><html lang="vi"><body><p>${escapeHtml(
    "Mật khẩu tài khoản GeoLibre của bạn vừa được đổi.",
  )}</p><p>${escapeHtml(
    "Mọi phiên đăng nhập cũ đã bị thu hồi. Nếu bạn không thực hiện việc này, hãy liên hệ người quản trị ngay.",
  )}</p></body></html>`;
  return { to, from, subject: "Mật khẩu GeoLibre vừa được đổi", text, html };
}
