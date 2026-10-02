'use strict';

const nodemailer = require('nodemailer');
const env = require('../config');

let cachedTransport = null;

function getTransport() {
  if (cachedTransport) return cachedTransport;
  cachedTransport = nodemailer.createTransport({
    host: env.MAIL.HOST,
    port: env.MAIL.PORT,
    secure: env.MAIL.SECURE,
    auth: { user: env.MAIL.USER, pass: env.MAIL.PASS },
  });
  return cachedTransport;
}

/**
 * Send an email. Errors are logged but never thrown — email is best-effort.
 */
async function sendMail({ to, subject, html, text }) {
  try {
    const info = await getTransport().sendMail({
      from: `"${env.MAIL.FROM_NAME}" <${env.MAIL.FROM_EMAIL}>`,
      to,
      subject,
      html,
      text,
    });
    return info;
  } catch (err) {
    console.error('[mail] send failed:', err.message);
    return null;
  }
}

module.exports = { sendMail };