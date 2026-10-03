// Outbound mail for invites, resets, email changes, and security notices.
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
  link?: { href: string; label: string },
): { text: string; html: string } {
  const text = [...paragraphs, ...(link ? [link.href] : [])].join("\n\n");
  const anchor = link
    ? `<p><a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a></p>`
    : "";
  const html = `<!DOCTYPE html><html lang="vi"><body>${paragraphs
    .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
    .join("")}${anchor}</body></html>`;
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
  const body = page([
    "Mật khẩu tài khoản GeoLibre của bạn vừa được đổi.",
    "Mọi phiên đăng nhập cũ đã bị thu hồi. Nếu bạn không thực hiện việc này, hãy liên hệ người quản trị ngay.",
  ]);
  return { to, from, subject: "Mật khẩu GeoLibre vừa được đổi", ...body };
}

export function verifyEmailChangeEmail(to: string, from: string, verifyUrl: string): OutboundEmail {
  const body = page(
    [
      "Có yêu cầu dùng địa chỉ này cho một tài khoản GeoLibre.",
      "Liên kết có hiệu lực trong 24 giờ và chỉ dùng được một lần. Địa chỉ chỉ được đổi sau khi bạn bấm xác nhận trên trang mở ra. Nếu bạn không yêu cầu, hãy bỏ qua thư này.",
    ],
    { href: verifyUrl, label: "Xác nhận địa chỉ email" },
  );
  return { to, from, subject: "Xác nhận địa chỉ email GeoLibre", ...body };
}

/** Sent to the old address, so a hijacked session cannot move the account away silently. */
export function emailChangeNoticeEmail(
  to: string,
  from: string,
  newAddress: string,
): OutboundEmail {
  const body = page([
    `Có yêu cầu đổi email của tài khoản GeoLibre này sang ${newAddress}.`,
    "Địa chỉ chỉ đổi khi người nhận ở địa chỉ mới xác nhận. Nếu bạn không thực hiện việc này, hãy đổi mật khẩu và liên hệ người quản trị ngay.",
  ]);
  return { to, from, subject: "Yêu cầu đổi email tài khoản GeoLibre", ...body };
}

export function newSignInEmail(
  to: string,
  from: string,
  details: { when: string; device: string; ip: string },
): OutboundEmail {
  const body = page([
    "Tài khoản GeoLibre của bạn vừa đăng nhập từ một thiết bị chưa từng thấy.",
    `Thời điểm (UTC): ${details.when}`,
    `Thiết bị: ${details.device || "không rõ"}`,
    `Địa chỉ IP: ${details.ip || "không rõ"}`,
    "Nếu đó là bạn, không cần làm gì. Nếu không, hãy đổi mật khẩu và chọn “Đăng xuất mọi thiết bị” trong phần Bảo mật tài khoản.",
  ]);
  return { to, from, subject: "Có đăng nhập mới từ thiết bị lạ", ...body };
}

export function mfaChangedEmail(to: string, from: string, enabled: boolean): OutboundEmail {
  const body = page([
    enabled
      ? "Xác thực hai bước vừa được bật cho tài khoản GeoLibre của bạn."
      : "Xác thực hai bước vừa bị tắt cho tài khoản GeoLibre của bạn.",
    "Nếu bạn không thực hiện việc này, hãy đổi mật khẩu và liên hệ người quản trị ngay.",
  ]);
  return {
    to,
    from,
    subject: enabled ? "Đã bật xác thực hai bước GeoLibre" : "Đã tắt xác thực hai bước GeoLibre",
    ...body,
  };
}
