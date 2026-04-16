import dotenv from "dotenv";
import sendgridMail from "@sendgrid/mail";

dotenv.config();

const to = "duffyjones@gmail.com";
const from = process.env.SENDGRID_FROM_EMAIL;
const apiKey = process.env.SENDGRID_API_KEY;

if (!from) {
  console.error("Missing SENDGRID_FROM_EMAIL in backend/.env");
  process.exit(1);
}

if (!apiKey) {
  console.error("Missing SENDGRID_API_KEY in backend/.env");
  process.exit(1);
}

sendgridMail.setApiKey(apiKey);

const msg = {
  to,
  from,
  subject: "FVMA Disaster Response — email test successful.",
  text: "FVMA Disaster Response — email test successful.",
  html: "<p>FVMA Disaster Response — email test successful.</p>",
};

try {
  const res = await sendgridMail.send(msg);
  const headers = res?.[0]?.headers || {};
  const messageId =
    headers["x-message-id"] || headers["X-Message-Id"] || headers["x-messageid"];
  console.log(
    JSON.stringify(
      {
        to,
        statusCode: res?.[0]?.statusCode,
        messageId: messageId || null,
      },
      null,
      2,
    ),
  );
} catch (err) {
  console.error("SendGrid test failed:", err?.message || err);
  if (err?.response?.body) {
    console.error("SendGrid error body:", err.response.body);
  }
  process.exit(1);
}

