import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as mail from "../workers/projects-api/src/email";

describe("security email builders", () => {
  const payload = '<script>alert("x")</script>&';
  const escaped = "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;";
  const link = `https://example.com/#token=${payload}`;
  for (const builder of [mail.inviteEmail, mail.resetEmail, mail.verifyEmailChangeEmail]) {
    it(`${builder.name} escapes the URL in HTML and preserves it in plain text`, () => {
      const message = builder("to@example.com", "from@example.com", link);
      assert.ok(message.html.includes(`href="https://example.com/#token=${escaped}"`));
      assert.ok(message.text.includes(link));
      assert.equal(message.html.includes("<script>"), false);
    });
  }
  it("escapes changed addresses and sign-in details without changing plain text", () => {
    for (const message of [
      mail.emailChangeNoticeEmail("to", "from", payload),
      mail.newSignInEmail("to", "from", { when: payload, device: payload, ip: payload }),
    ]) {
      assert.ok(message.text.includes(payload));
      assert.ok(message.html.includes(escaped));
      assert.equal(message.html.includes("<script>"), false);
    }
  });
  it("keeps recipient and sender out of the HTML body in every fixed notice", () => {
    const messages = [
      mail.passwordChangedEmail(payload, payload),
      ...(["enabled", "disabled", "reset", "recovery-used"] as const).map((change) =>
        mail.mfaChangedEmail(payload, payload, change),
      ),
    ];
    for (const message of messages) {
      assert.equal(message.to, payload);
      assert.equal(message.from, payload);
      assert.ok(message.html.includes('<html lang="vi">'));
      assert.equal(message.html.includes(payload), false);
      assert.ok(message.text.length > 0);
    }
    assert.equal(new Set(messages.map((m) => m.subject)).size, messages.length);
  });
});
