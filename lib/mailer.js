/* =========================================================
   Mailer — provider-agnostic email delivery
   EMAIL_PROVIDER: sendgrid | resend | console (default)
   Auto-detects from SENDGRID_API_KEY / RESEND_API_KEY.
   console mode logs the message and reports success — perfect
   for the pilot; flip one env var to go live.
   ========================================================= */
const PROVIDER =
  process.env.EMAIL_PROVIDER ||
  (process.env.SENDGRID_API_KEY ? "sendgrid" : process.env.RESEND_API_KEY ? "resend" : "console");
const FROM = process.env.EMAIL_FROM || "Landroll Leader <alerts@landrollleader.com>";

async function deliver({ to, subject, html }) {
  try {
    if (PROVIDER === "sendgrid") {
      const r = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: to }] }],
          from: parseFrom(FROM), subject,
          content: [{ type: "text/html", value: html }],
        }),
      });
      if (r.status === 202) return { ok: true, provider: PROVIDER };
      return { ok: false, provider: PROVIDER, error: `SendGrid ${r.status}: ${(await r.text()).slice(0, 300)}` };
    }
    if (PROVIDER === "resend") {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: FROM, to: [to], subject, html }),
      });
      if (r.ok) return { ok: true, provider: PROVIDER };
      return { ok: false, provider: PROVIDER, error: `Resend ${r.status}: ${(await r.text()).slice(0, 300)}` };
    }
    console.log(`[mailer:console] to=${to} subject="${subject}" (${html.length} bytes html)`);
    return { ok: true, provider: "console" };
  } catch (e) {
    return { ok: false, provider: PROVIDER, error: e.message };
  }
}

function parseFrom(s) {
  const m = s.match(/^(.*)<(.+)>$/);
  return m ? { name: m[1].trim(), email: m[2].trim() } : { email: s };
}

/* ---------- branded templates ---------- */
const PINE = "#17453B", AMBER = "#C8730F", PAPER = "#F7F6F1", SOFT = "#54615A";
const money = (n) => (n == null ? "—" : "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2 }));
const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

function shell(title, bodyHtml) {
  return `<!DOCTYPE html><html><body style="margin:0;background:${PAPER};font-family:Helvetica,Arial,sans-serif;color:#181F1B">
<div style="max-width:560px;margin:0 auto;padding:24px 16px">
  <div style="background:${PINE};border-radius:12px 12px 0 0;padding:18px 22px">
    <span style="display:inline-block;background:${AMBER};color:#fff;font-weight:800;border-radius:6px;padding:3px 9px;margin-right:8px">L</span>
    <span style="color:#fff;font-size:19px;font-weight:700">Landroll <span style="color:#E9C083">Leader</span></span>
  </div>
  <div style="background:#fff;border:1px solid #DDDCD2;border-top:0;border-radius:0 0 12px 12px;padding:22px">
    <h2 style="margin:0 0 10px;font-size:17px;color:${PINE}">${esc(title)}</h2>
    ${bodyHtml}
  </div>
  <p style="font-size:11px;color:#8A958E;margin-top:14px">Landroll Leader supplements, and does not replace, statutory tax-sale notice. Official county records remain authoritative. Not legal or investment advice.</p>
</div></body></html>`;
}

function alertEmail({ site, matches, filters, saleEvent }) {
  const rows = matches.slice(0, 8).map((m) =>
    `<tr><td style="padding:7px 8px;border-bottom:1px solid #EEE;font-family:monospace;font-size:12.5px">
       <a href="${site}/#parcel=${encodeURIComponent(m.parcel_number)}" style="color:${PINE};font-weight:700">${esc(m.parcel_display || m.parcel_number)}</a></td>
     <td style="padding:7px 8px;border-bottom:1px solid #EEE;font-size:12.5px;color:${SOFT}">${esc((m.owner_name_of_record || "").slice(0, 30))}</td>
     <td style="padding:7px 8px;border-bottom:1px solid #EEE;text-align:right;font-size:12.5px"><b>${money(m.total_opening_amount)}</b></td></tr>`).join("");
  return shell(`${matches.length} matching parcel${matches.length === 1 ? "" : "s"} just published`,
    `<p style="font-size:13.5px;color:${SOFT};margin:0 0 12px">A county just published new listings (${esc(saleEvent)}) matching your saved search${filters && Object.keys(filters).length > 1 ? ` <span style="font-family:monospace;font-size:11.5px">${esc(JSON.stringify(filters))}</span>` : ""}.</p>
     <table style="width:100%;border-collapse:collapse">${rows}</table>
     ${matches.length > 8 ? `<p style="font-size:12.5px;color:${SOFT}">…and ${matches.length - 8} more.</p>` : ""}
     <p style="margin:16px 0 0"><a href="${site}" style="background:${AMBER};color:#fff;text-decoration:none;font-weight:700;font-size:13.5px;padding:10px 18px;border-radius:8px;display:inline-block">View all matches</a></p>`);
}

function resetEmail({ site, link }) {
  return shell("Reset your password",
    `<p style="font-size:13.5px;color:${SOFT}">Someone (hopefully you) asked to reset the password for this Landroll Leader account. The link below works once and expires in 30 minutes.</p>
     <p style="margin:16px 0"><a href="${link}" style="background:${PINE};color:#fff;text-decoration:none;font-weight:700;font-size:13.5px;padding:10px 18px;border-radius:8px;display:inline-block">Choose a new password</a></p>
     <p style="font-size:12px;color:${SOFT}">If you didn't ask for this, ignore this email — your password is unchanged.</p>
     <p style="font-size:11px;color:#8A958E">Link: ${esc(link)}</p>`);
}

function welcomeEmail({ site, name, tier }) {
  const tierLine = {
    browse: "You're on the free Browse plan — search and map every published parcel.",
    investor: "Your Investor plan unlocks CSV export, saved-search alerts, and the yield tools.",
    pro: "Your Pro desk unlocks buyer intelligence, API access, and multi-county tracking.",
  }[tier] || "";
  return shell(`Welcome, ${esc(name)}`,
    `<p style="font-size:13.5px;color:${SOFT}">Your Landroll Leader account is ready. ${tierLine}</p>
     <p style="margin:16px 0 0"><a href="${site}" style="background:${AMBER};color:#fff;text-decoration:none;font-weight:700;font-size:13.5px;padding:10px 18px;border-radius:8px;display:inline-block">Start researching parcels</a></p>`);
}

module.exports = { deliver, alertEmail, resetEmail, welcomeEmail, PROVIDER };
