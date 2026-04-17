import express from "express";
import cors from "cors";
import multer from "multer";
import XLSX from "xlsx";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import sendgridMail from "@sendgrid/mail";
import { supabase } from "./supabaseClient.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "";
const SENDGRID_FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || "";
const OUTREACH_LINK_BASE_URL = process.env.OUTREACH_LINK_BASE_URL || "";
const DEFAULT_ORGANIZATION_ID = process.env.DEFAULT_ORGANIZATION_ID || "";
const BLAND_API_KEY = process.env.BLAND_API_KEY || "";
const BLAND_ENDPOINT = process.env.BLAND_ENDPOINT || "https://api.bland.ai";
const BLAND_WEB_AGENT_ID =
  process.env.BLAND_WEB_AGENT_ID || process.env.BLAND_AGENT_ID || "";
const ORGANIZATION_COLUMNS = [
  "id",
  "name",
  "org_type",
  "email",
  "phone",
  "address_line1",
  "address_line2",
  "city",
  "state",
  "postal_code",
  "country",
  "website",
  "notes",
  "created_at",
  "updated_at",
].join(",");
const ALLOWED_FILE_EXTENSIONS = new Set([".csv", ".xls", ".xlsx"]);
const ALLOWED_MEMBER_ROLES = new Set([
  "admin",
  "veterinarian",
  "vet_tech",
  "staff",
  "volunteer",
  "other",
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (_req, file, cb) => {
    const fileExt = path.extname(file.originalname || "").toLowerCase();
    if (!ALLOWED_FILE_EXTENSIONS.has(fileExt)) {
      cb(new Error("Only .csv, .xls, and .xlsx files are supported."));
      return;
    }
    cb(null, true);
  },
});

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

function normalizeHeader(value) {
  return String(value).trim().toLowerCase().replace(/\s+/g, "_");
}

function normalizeRowKeys(row) {
  const normalized = {};
  for (const [key, value] of Object.entries(row)) {
    normalized[normalizeHeader(key)] = value;
  }
  return normalized;
}

function firstPopulatedValue(row, keys) {
  for (const key of keys) {
    const value = row[key];
    if (value === undefined || value === null) {
      continue;
    }
    const asText = String(value).trim();
    if (asText !== "") {
      return asText;
    }
  }
  return null;
}

function parseBooleanOrDefault(value, defaultValue = true) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return defaultValue;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "y"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "n"].includes(normalized)) {
    return false;
  }

  return defaultValue;
}

function toNullableText(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const text = String(value).trim();
  return text === "" ? null : text;
}

function slugify(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function extractOutreachToken(notes) {
  const raw = toNullableText(notes);
  if (!raw) {
    return null;
  }
  const match = raw.match(/outreach_token:([0-9a-fA-F-]{16,})/);
  return match ? match[1] : null;
}

function buildOutreachLink(token) {
  if (!OUTREACH_LINK_BASE_URL) {
    return null;
  }
  const base = OUTREACH_LINK_BASE_URL.endsWith("/")
    ? OUTREACH_LINK_BASE_URL.slice(0, -1)
    : OUTREACH_LINK_BASE_URL;
  return `${base}?token=${encodeURIComponent(token)}`;
}

function normalizePhoneDigits(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const digits = String(value).replace(/\D/g, "");
  if (!digits) {
    return null;
  }
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

function memberMatchesOutreachContact(member, outreachRow) {
  const mEmail = member.email?.trim().toLowerCase();
  const oEmail = outreachRow.email?.trim().toLowerCase();
  if (mEmail && oEmail && mEmail === oEmail) {
    return true;
  }
  const mPhone = normalizePhoneDigits(member.phone);
  const oPhone = normalizePhoneDigits(outreachRow.phone);
  return Boolean(mPhone && oPhone && mPhone === oPhone);
}

function formatOutreachChannelsForMember(member, outreachRows) {
  const matched = outreachRows.filter((row) => memberMatchesOutreachContact(member, row));
  const channels = [
    ...new Set(
      matched
        .map((row) => String(row.channel || "").trim().toLowerCase())
        .filter((c) => c === "email" || c === "sms"),
    ),
  ].sort();
  if (!channels.length) {
    return null;
  }
  return channels.map((c) => (c === "email" ? "Email" : "SMS")).join(", ");
}

function formatReportChannelLabel(channel) {
  const c = String(channel || "")
    .trim()
    .toLowerCase();
  if (c === "email") {
    return "Email";
  }
  if (c === "sms") {
    return "SMS";
  }
  if (c === "voice") {
    return "Voice";
  }
  if (c === "web") {
    return "Web";
  }
  return channel ? String(channel) : null;
}

async function findMemberForOutreachContact(outreach, organizationId) {
  const email = outreach.email?.trim();
  if (email) {
    const { data, error } = await supabase
      .from("members")
      .select("*")
      .eq("organization_id", organizationId)
      .ilike("email", email)
      .maybeSingle();
    if (!error && data) {
      return data;
    }
  }

  const targetDigits = normalizePhoneDigits(outreach.phone);
  if (!targetDigits) {
    return null;
  }

  const { data: candidates, error: listError } = await supabase
    .from("members")
    .select("*")
    .eq("organization_id", organizationId);

  if (listError || !candidates?.length) {
    return null;
  }

  return candidates.find((m) => normalizePhoneDigits(m.phone) === targetDigits) || null;
}

function sanitizeSurveyAnswers(raw) {
  const out = {};
  for (let i = 1; i <= 8; i += 1) {
    const key = `q${i}`;
    const v = raw?.[key];
    out[key] = v === undefined || v === null ? "" : String(v);
  }
  return out;
}

function buildMemberRow(inputRow, organizationIdFromRequest) {
  const row = normalizeRowKeys(inputRow);
  const fullNameDirect = firstPopulatedValue(row, [
    "full_name",
    "name",
    "member_name",
    "full_name_(required)",
  ]);

  const firstName = firstPopulatedValue(row, ["first_name", "firstname", "first"]);
  const lastName = firstPopulatedValue(row, ["last_name", "lastname", "last"]);
  const combinedName =
    firstName || lastName
      ? [firstName, lastName].filter(Boolean).join(" ").trim()
      : null;

  const fullName = fullNameDirect || combinedName;
  if (!fullName) {
    return { skipReason: "missing_name" };
  }

  const rowOrganizationId = firstPopulatedValue(row, [
    "organization_id",
    "organizationid",
    "org_id",
    "orgid",
  ]);

  const organizationId =
    organizationIdFromRequest || rowOrganizationId || DEFAULT_ORGANIZATION_ID || null;
  if (!organizationId) {
    return { skipReason: "missing_organization_id" };
  }

  const roleInput = firstPopulatedValue(row, ["role", "member_role"]);
  const normalizedRole = roleInput ? roleInput.toLowerCase() : "volunteer";
  const role = ALLOWED_MEMBER_ROLES.has(normalizedRole)
    ? normalizedRole
    : "volunteer";

  return {
    record: {
      organization_id: organizationId,
      full_name: fullName,
      email: toNullableText(firstPopulatedValue(row, ["email", "email_address"])),
      phone: toNullableText(firstPopulatedValue(row, ["phone", "phone_number"])),
      role,
      credentials: toNullableText(
        firstPopulatedValue(row, ["credentials", "license", "license_number"]),
      ),
      is_active: parseBooleanOrDefault(
        firstPopulatedValue(row, ["is_active", "active"]),
        true,
      ),
    },
  };
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "fvma-disaster-response-api" });
});

app.get("/api/organizations/:id", async (req, res) => {
  const organizationId = toNullableText(req.params.id);
  if (!organizationId) {
    res.status(400).json({ error: "Organization id is required." });
    return;
  }

  const { data, error } = await supabase
    .from("organizations")
    .select(ORGANIZATION_COLUMNS)
    .eq("id", organizationId)
    .maybeSingle();

  if (error) {
    res.status(500).json({
      error: "Failed to fetch organization from Supabase.",
      details: error.message,
    });
    return;
  }

  if (!data) {
    res.status(404).json({ error: "Organization not found." });
    return;
  }

  res.json(data);
});

app.get("/api/events", async (_req, res) => {
  const { data, error } = await supabase
    .from("events")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    res.status(500).json({ error: "Failed to fetch events.", details: error.message });
    return;
  }

  res.json({ count: data.length, events: data });
});

app.get("/api/events/:id", async (req, res) => {
  const eventId = toNullableText(req.params.id);
  if (!eventId) {
    res.status(400).json({ error: "Event id is required." });
    return;
  }

  const { data, error } = await supabase
    .from("events")
    .select("*")
    .eq("id", eventId)
    .maybeSingle();

  if (error) {
    res.status(500).json({ error: "Failed to fetch event.", details: error.message });
    return;
  }

  if (!data) {
    res.status(404).json({ error: "Event not found." });
    return;
  }

  res.json(data);
});

app.get("/api/events/:id/outreach-history", async (req, res) => {
  const eventId = toNullableText(req.params.id);
  const organizationId = toNullableText(req.query.organization_id);

  if (!eventId) {
    res.status(400).json({ error: "Event id is required." });
    return;
  }

  if (!organizationId) {
    res.status(400).json({ error: "organization_id query parameter is required." });
    return;
  }

  const { data, error } = await supabase
    .from("outreach_contacts")
    .select("id,event_id,organization_id,contact_name,email,phone,channel,notes,created_at")
    .eq("event_id", eventId)
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false });

  if (error) {
    res.status(500).json({
      error: "Failed to fetch outreach history.",
      details: error.message,
    });
    return;
  }

  const records = (data || []).map((row) => ({
    ...row,
    token: extractOutreachToken(row.notes),
  }));

  res.json({ count: records.length, records });
});

app.get("/api/events/:id/member-report", async (req, res) => {
  const eventId = toNullableText(req.params.id);
  const organizationId = toNullableText(req.query.organization_id);

  if (!eventId) {
    res.status(400).json({ error: "Event id is required." });
    return;
  }

  if (!organizationId) {
    res.status(400).json({ error: "organization_id query parameter is required." });
    return;
  }

  const { data: organization, error: organizationError } = await supabase
    .from("organizations")
    .select("id")
    .eq("id", organizationId)
    .maybeSingle();

  if (organizationError) {
    res.status(500).json({
      error: "Failed validating organization_id.",
      details: organizationError.message,
    });
    return;
  }

  if (!organization) {
    res.status(404).json({ error: "Organization not found." });
    return;
  }

  const { data: event, error: eventError } = await supabase
    .from("events")
    .select("*")
    .eq("id", eventId)
    .maybeSingle();

  if (eventError) {
    res.status(500).json({ error: "Failed to fetch event.", details: eventError.message });
    return;
  }

  if (!event) {
    res.status(404).json({ error: "Event not found." });
    return;
  }

  const { data: membersRaw, error: membersError } = await supabase
    .from("members")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("is_active", true)
    .order("full_name", { ascending: true });

  if (membersError) {
    res.status(500).json({
      error: "Failed to fetch members.",
      details: membersError.message,
    });
    return;
  }

  const { data: outreachRaw, error: outreachError } = await supabase
    .from("outreach_contacts")
    .select("id,email,phone,channel,created_at")
    .eq("event_id", eventId)
    .eq("organization_id", organizationId);

  if (outreachError) {
    res.status(500).json({
      error: "Failed to fetch outreach contacts.",
      details: outreachError.message,
    });
    return;
  }

  const { data: responsesRaw, error: responsesError } = await supabase
    .from("event_member_responses")
    .select("*")
    .eq("event_id", eventId)
    .eq("organization_id", organizationId);

  if (responsesError) {
    res.status(500).json({
      error: "Failed to fetch response records.",
      details: responsesError.message,
      hint:
        responsesError.message?.includes("event_member_responses") ||
        responsesError.code === "42P01"
          ? "Apply the SQL migration supabase/migrations/20260417120000_event_member_responses.sql in Supabase."
          : undefined,
    });
    return;
  }

  const outreachRows = outreachRaw || [];
  const responseByMember = new Map((responsesRaw || []).map((row) => [row.member_id, row]));

  const rows = (membersRaw || []).map((member) => {
    const record = responseByMember.get(member.id);
    const status = record ? record.status : "no_response";
    let channelContacted = formatOutreachChannelsForMember(member, outreachRows);
    if (!channelContacted && record?.channel) {
      channelContacted = formatReportChannelLabel(record.channel);
    }
    return {
      member: {
        id: member.id,
        full_name: member.full_name,
        email: member.email,
        phone: member.phone,
        role: member.role,
      },
      status,
      channel_contacted: channelContacted,
      date_responded: record?.responded_at || null,
      answers: sanitizeSurveyAnswers(record?.answers || {}),
    };
  });

  res.json({
    event,
    organization_id: organizationId,
    count: rows.length,
    rows,
  });
});

app.post("/api/outreach/submit-response", async (req, res) => {
  const token = toNullableText(req.body?.token);
  const status = toNullableText(req.body?.status)?.toLowerCase();
  const channelInput = toNullableText(req.body?.channel)?.toLowerCase() || "web";
  const answers = sanitizeSurveyAnswers(req.body?.answers || {});

  if (!token) {
    res.status(400).json({ error: "token is required." });
    return;
  }

  if (status !== "safe" && status !== "needs_help") {
    res.status(400).json({ error: "status must be safe or needs_help." });
    return;
  }

  const allowedChannels = new Set(["email", "sms", "voice", "web"]);
  if (!allowedChannels.has(channelInput)) {
    res.status(400).json({ error: "channel must be email, sms, voice, or web." });
    return;
  }

  const notesValue = `outreach_token:${token}`;
  const { data: outreach, error: outreachError } = await supabase
    .from("outreach_contacts")
    .select("id,event_id,organization_id,email,phone")
    .eq("notes", notesValue)
    .maybeSingle();

  if (outreachError) {
    res.status(500).json({
      error: "Failed to resolve outreach token.",
      details: outreachError.message,
    });
    return;
  }

  if (!outreach) {
    res.status(404).json({ error: "Invalid or unknown outreach token." });
    return;
  }

  const member = await findMemberForOutreachContact(outreach, outreach.organization_id);
  if (!member) {
    res.status(404).json({
      error: "Could not match this outreach record to a member (email/phone).",
    });
    return;
  }

  const respondedAt = new Date().toISOString();
  const row = {
    organization_id: outreach.organization_id,
    event_id: outreach.event_id,
    member_id: member.id,
    status,
    channel: channelInput,
    responded_at: respondedAt,
    answers,
    updated_at: respondedAt,
  };

  const { data: saved, error: saveError } = await supabase
    .from("event_member_responses")
    .upsert(row, { onConflict: "event_id,member_id" })
    .select("*")
    .maybeSingle();

  if (saveError) {
    res.status(500).json({
      error: "Failed to save response.",
      details: saveError.message,
      hint:
        saveError.message?.includes("event_member_responses") || saveError.code === "42P01"
          ? "Apply the SQL migration supabase/migrations/20260417120000_event_member_responses.sql in Supabase."
          : undefined,
    });
    return;
  }

  res.status(201).json({
    message: "Response recorded.",
    record: saved,
  });
});

app.post("/api/events", async (req, res) => {
  const name = toNullableText(req.body?.name);
  const activate = Boolean(req.body?.activate);
  const eventType = toNullableText(req.body?.event_type) || "other";
  const description = toNullableText(req.body?.description);

  if (!name) {
    res.status(400).json({ error: "Event name is required." });
    return;
  }

  const baseSlug = slugify(name);
  const eventRow = {
    name,
    slug: baseSlug || null,
    description,
    event_type: eventType,
    status: activate ? "active" : "draft",
    starts_at: activate ? new Date().toISOString() : null,
  };

  const { data, error } = await supabase
    .from("events")
    .insert(eventRow)
    .select("*")
    .single();

  if (error) {
    res.status(500).json({ error: "Failed to create event.", details: error.message });
    return;
  }

  res.status(201).json(data);
});

app.patch("/api/events/:id/activate", async (req, res) => {
  const eventId = toNullableText(req.params.id);
  if (!eventId) {
    res.status(400).json({ error: "Event id is required." });
    return;
  }

  const { data, error } = await supabase
    .from("events")
    .update({ status: "active", starts_at: new Date().toISOString() })
    .eq("id", eventId)
    .select("*")
    .maybeSingle();

  if (error) {
    res.status(500).json({ error: "Failed to activate event.", details: error.message });
    return;
  }

  if (!data) {
    res.status(404).json({ error: "Event not found." });
    return;
  }

  res.json(data);
});

app.post("/api/events/:id/outreach-launch", async (req, res) => {
  const eventId = toNullableText(req.params.id);
  const organizationId = toNullableText(req.body?.organization_id);
  const channels = Array.isArray(req.body?.channels) ? req.body.channels : [];

  if (!eventId) {
    res.status(400).json({ error: "Event id is required." });
    return;
  }

  if (!organizationId) {
    res.status(400).json({ error: "organization_id is required." });
    return;
  }

  const normalizedChannels = channels
    .map((channel) => String(channel).trim().toLowerCase())
    .filter((channel) => channel === "email" || channel === "sms");

  if (!normalizedChannels.length) {
    res.status(400).json({ error: "Choose at least one channel: email or sms." });
    return;
  }

  const { data: event, error: eventError } = await supabase
    .from("events")
    .select("*")
    .eq("id", eventId)
    .maybeSingle();

  if (eventError) {
    res.status(500).json({ error: "Failed to fetch event.", details: eventError.message });
    return;
  }

  if (!event) {
    res.status(404).json({ error: "Event not found." });
    return;
  }

  if (event.status !== "active") {
    res.status(400).json({ error: "Outreach can only be launched for active events." });
    return;
  }

  const { data: members, error: membersError } = await supabase
    .from("members")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("is_active", true)
    .order("full_name", { ascending: true });

  if (membersError) {
    res.status(500).json({
      error: "Failed to fetch members for outreach.",
      details: membersError.message,
    });
    return;
  }

  const outreachRows = [];
  const skipped = [];
  const pendingEmailSends = [];
  let emailChannelRowCount = 0;
  let smsChannelRowCount = 0;

  members.forEach((member) => {
    normalizedChannels.forEach((channel) => {
      if (channel === "email" && !member.email) {
        skipped.push({
          member_id: member.id,
          full_name: member.full_name,
          channel,
          reason: "missing_email",
        });
        return;
      }

      if (channel === "sms" && !member.phone) {
        skipped.push({
          member_id: member.id,
          full_name: member.full_name,
          channel,
          reason: "missing_phone",
        });
        return;
      }

      const outreachToken = randomUUID();
      const outreachLink = buildOutreachLink(outreachToken);

      outreachRows.push({
        event_id: eventId,
        organization_id: organizationId,
        contact_name: member.full_name,
        email: member.email,
        phone: member.phone,
        channel,
        notes: `outreach_token:${outreachToken}`,
      });

      if (channel === "email") {
        emailChannelRowCount += 1;
        pendingEmailSends.push({
          to: member.email,
          contact_name: member.full_name,
          token: outreachToken,
          outreach_link: outreachLink,
        });
      } else if (channel === "sms") {
        smsChannelRowCount += 1;
      }
    });
  });

  if (!outreachRows.length) {
    res.status(400).json({
      error: "No outreach records created. Check member contact info and selected channels.",
      skipped,
    });
    return;
  }

  const { data: inserted, error: insertError } = await supabase
    .from("outreach_contacts")
    .insert(outreachRows)
    .select("id,contact_name,channel,notes");

  if (insertError) {
    res.status(500).json({
      error: "Failed to create outreach contact records.",
      details: insertError.message,
    });
    return;
  }

  let emailSendAttempted = false;
  let emailSendSucceeded = 0;
  let emailSendFailed = 0;
  const emailSendErrors = [];

  if (
    normalizedChannels.includes("email") &&
    SENDGRID_API_KEY &&
    SENDGRID_FROM_EMAIL &&
    pendingEmailSends.length
  ) {
    console.log(
      "[outreach-launch] SendGrid sending block entered",
      JSON.stringify({
        eventId,
        organizationId,
        wantsEmail: normalizedChannels.includes("email"),
        pendingEmailSends: pendingEmailSends.length,
        emailChannelRowCount,
        smsChannelRowCount,
        SENDGRID_API_KEY_present: Boolean(SENDGRID_API_KEY),
        SENDGRID_FROM_EMAIL_present: Boolean(SENDGRID_FROM_EMAIL),
        OUTREACH_LINK_BASE_URL_present: Boolean(OUTREACH_LINK_BASE_URL),
      }),
    );
    emailSendAttempted = true;
    sendgridMail.setApiKey(SENDGRID_API_KEY);

    const messages = pendingEmailSends.map((entry) => ({
      to: entry.to,
      from: SENDGRID_FROM_EMAIL,
      subject: `FVMA Disaster Response: ${event.name}`,
      text: [
        `Hello ${entry.contact_name},`,
        "",
        `FVMA has launched an outreach campaign for: ${event.name}.`,
        "",
        entry.outreach_link
          ? `Your link: ${entry.outreach_link}`
          : "Your link will be available once OUTREACH_LINK_BASE_URL is configured.",
        "",
        "Thank you,",
        "FVMA Disaster Response",
      ].join("\n"),
      html: `
        <p>Hello ${entry.contact_name},</p>
        <p><strong>FVMA</strong> has launched an outreach campaign for: <strong>${event.name}</strong>.</p>
        <p>
          ${
            entry.outreach_link
              ? `Your link: <a href="${entry.outreach_link}">${entry.outreach_link}</a>`
              : "Your link will be available once <code>OUTREACH_LINK_BASE_URL</code> is configured."
          }
        </p>
        <p>Thank you,<br/>FVMA Disaster Response</p>
      `,
    }));

    console.log(
      "[outreach-launch] SendGrid messages prepared",
      JSON.stringify({ count: messages.length }),
    );

    for (const msg of messages) {
      try {
        // eslint-disable-next-line no-await-in-loop
        console.log(
          "[outreach-launch] SendGrid sending to",
          JSON.stringify({ to: msg.to }),
        );
        const response = await sendgridMail.send(msg);
        console.log(
          "[outreach-launch] SendGrid send success",
          JSON.stringify({
            to: msg.to,
            statusCode: response?.[0]?.statusCode,
            messageId:
              response?.[0]?.headers?.["x-message-id"] ||
              response?.[0]?.headers?.["X-Message-Id"] ||
              null,
          }),
        );
        if (response?.[0]?.headers) {
          const keys = Object.keys(response[0].headers || {});
          console.log(
            "[outreach-launch] SendGrid response header keys (first 10)",
            JSON.stringify(keys.slice(0, 10)),
          );
        }
        emailSendSucceeded += 1;
      } catch (err) {
        console.log(
          "[outreach-launch] SendGrid send error",
          JSON.stringify({
            to: msg.to,
            errorMessage: err?.message,
            statusCode: err?.response?.statusCode,
            body: err?.response?.body,
          }),
        );
        emailSendFailed += 1;
        emailSendErrors.push(err?.message || "SendGrid send failed.");
      }
    }
  }
  else {
    console.log(
      "[outreach-launch] Email sending not attempted",
      JSON.stringify({
        wantsEmail: normalizedChannels.includes("email"),
        SENDGRID_API_KEY_present: Boolean(SENDGRID_API_KEY),
        SENDGRID_FROM_EMAIL_present: Boolean(SENDGRID_FROM_EMAIL),
        pendingEmailSends_length: pendingEmailSends.length,
        emailChannelRowCount,
        smsChannelRowCount,
      }),
    );
  }

  res.status(201).json({
    message:
      emailSendAttempted
        ? "Outreach launched. Contact records created and email sending attempted."
        : "Outreach launched. Contact records created successfully.",
    event_id: eventId,
    channels: normalizedChannels,
    created_count: inserted.length,
    skipped_count: skipped.length,
    skipped,
    records: inserted,
    email: {
      attempted: emailSendAttempted,
      succeeded: emailSendSucceeded,
      failed: emailSendFailed,
      errors: emailSendErrors.slice(0, 5),
    },
  });
});

app.post("/api/members/import", upload.single("file"), async (req, res) => {
  const organizationId = toNullableText(req.body.organization_id);
  const uploadedFile = req.file;

  if (!uploadedFile) {
    res.status(400).json({ error: "No file uploaded. Use form field name 'file'." });
    return;
  }

  let rows = [];
  try {
    const workbook = XLSX.read(uploadedFile.buffer, { type: "buffer" });
    const firstSheetName = workbook.SheetNames[0];
    const firstSheet = workbook.Sheets[firstSheetName];

    if (!firstSheet) {
      res.status(400).json({ error: "The uploaded file does not contain any sheets." });
      return;
    }

    rows = XLSX.utils.sheet_to_json(firstSheet, { defval: "" });
  } catch (_error) {
    res.status(400).json({
      error:
        "Could not parse file. Make sure it is a valid CSV, XLS, or XLSX with a header row.",
    });
    return;
  }

  if (!rows.length) {
    res.status(400).json({ error: "File is empty or has no data rows." });
    return;
  }

  if (organizationId) {
    const { data: organization, error: organizationError } = await supabase
      .from("organizations")
      .select(ORGANIZATION_COLUMNS)
      .eq("id", organizationId)
      .maybeSingle();

    if (organizationError) {
      res.status(500).json({
        error: "Failed validating organization_id.",
        details: organizationError.message,
      });
      return;
    }

    if (!organization) {
      res.status(400).json({
        error: "The provided organization_id does not exist in organizations table.",
      });
      return;
    }
  }

  const memberRecords = [];
  const skippedRows = [];

  rows.forEach((row, index) => {
    const parsed = buildMemberRow(row, organizationId);
    if (!parsed.record) {
      skippedRows.push({
        rowNumber: index + 2, // +2 accounts for header row and 0-based index
        reason: parsed.skipReason || "invalid_row",
      });
      return;
    }
    memberRecords.push(parsed.record);
  });

  if (!memberRecords.length) {
    res.status(400).json({
      error:
        "No valid members found. Ensure rows include either full_name (or name) OR first_name/last_name. Organization_id is optional if provided in the request.",
      skippedRows,
    });
    return;
  }

  const chunkSize = 500;
  let insertedCount = 0;

  for (let start = 0; start < memberRecords.length; start += chunkSize) {
    const chunk = memberRecords.slice(start, start + chunkSize);
    const { error } = await supabase.from("members").insert(chunk);

    if (error) {
      res.status(500).json({
        error: "Failed to import members into Supabase.",
        details: error.message,
        insertedCount,
      });
      return;
    }

    insertedCount += chunk.length;
  }

  res.status(201).json({
    message: "Member import complete.",
    totalRowsInFile: rows.length,
    importedRows: insertedCount,
    skippedRows,
  });
});

app.post("/api/members/import-upsert", async (req, res) => {
  const organizationId =
    toNullableText(req.body?.organization_id) || DEFAULT_ORGANIZATION_ID || null;
  const members = Array.isArray(req.body?.members) ? req.body.members : [];

  if (!organizationId) {
    res.status(400).json({ error: "organization_id is required (or set DEFAULT_ORGANIZATION_ID)." });
    return;
  }

  if (!members.length) {
    res.status(400).json({ error: "members array is required." });
    return;
  }

  const normalizedByEmail = new Map();
  const skipped = [];

  for (const raw of members) {
    const emailRaw = toNullableText(raw?.email);
    if (!emailRaw) {
      skipped.push({ reason: "missing_email" });
      continue;
    }

    const email = emailRaw.trim().toLowerCase();
    const fullNameRaw = toNullableText(raw?.full_name);
    const fullName = (fullNameRaw && fullNameRaw.trim()) || email;

    const roleRaw = toNullableText(raw?.role);
    const normalizedRole = roleRaw ? roleRaw.trim().toLowerCase() : "volunteer";
    const role = ALLOWED_MEMBER_ROLES.has(normalizedRole) ? normalizedRole : "volunteer";

    const isActiveRaw = raw?.is_active;
    const isActive =
      typeof isActiveRaw === "boolean" ? isActiveRaw : parseBooleanOrDefault(isActiveRaw, true);

    normalizedByEmail.set(email, {
      organization_id: organizationId,
      full_name: fullName,
      email,
      phone: toNullableText(raw?.phone),
      role,
      credentials: toNullableText(raw?.credentials),
      is_active: isActive,
    });
  }

  const normalizedMembers = Array.from(normalizedByEmail.values());
  if (!normalizedMembers.length) {
    res.status(400).json({ error: "No valid members to import (email is required).", skipped });
    return;
  }

  const emailList = normalizedMembers.map((m) => m.email);
  const existingByEmail = new Map();

  const chunkSize = 500;
  for (let start = 0; start < emailList.length; start += chunkSize) {
    const chunk = emailList.slice(start, start + chunkSize);
    // eslint-disable-next-line no-await-in-loop
    const { data, error } = await supabase
      .from("members")
      .select("id,email")
      .eq("organization_id", organizationId)
      .in("email", chunk);

    if (error) {
      res.status(500).json({ error: "Failed to check existing members.", details: error.message });
      return;
    }

    (data || []).forEach((row) => {
      if (row.email) {
        existingByEmail.set(String(row.email).trim().toLowerCase(), row.id);
      }
    });
  }

  const toInsert = [];
  const toUpsertById = [];

  normalizedMembers.forEach((member) => {
    const existingId = existingByEmail.get(member.email);
    if (existingId) {
      toUpsertById.push({ id: existingId, ...member });
    } else {
      toInsert.push(member);
    }
  });

  let insertedCount = 0;
  let updatedCount = 0;

  // Update existing by primary key via upsert
  for (let start = 0; start < toUpsertById.length; start += chunkSize) {
    const chunk = toUpsertById.slice(start, start + chunkSize);
    // eslint-disable-next-line no-await-in-loop
    const { error } = await supabase.from("members").upsert(chunk);
    if (error) {
      res.status(500).json({ error: "Failed to update existing members.", details: error.message });
      return;
    }
    updatedCount += chunk.length;
  }

  // Insert new
  for (let start = 0; start < toInsert.length; start += chunkSize) {
    const chunk = toInsert.slice(start, start + chunkSize);
    // eslint-disable-next-line no-await-in-loop
    const { error } = await supabase.from("members").insert(chunk);
    if (error) {
      res.status(500).json({ error: "Failed to insert new members.", details: error.message });
      return;
    }
    insertedCount += chunk.length;
  }

  res.status(201).json({
    message: "Member import complete (upsert by email).",
    organization_id: organizationId,
    received: members.length,
    unique_emails: normalizedMembers.length,
    inserted: insertedCount,
    updated: updatedCount,
    skipped_count: skipped.length,
  });
});

app.post("/api/members/existing-emails", async (req, res) => {
  const organizationId =
    toNullableText(req.body?.organization_id) || DEFAULT_ORGANIZATION_ID || null;
  const emails = Array.isArray(req.body?.emails) ? req.body.emails : [];

  if (!organizationId) {
    res.status(400).json({ error: "organization_id is required (or set DEFAULT_ORGANIZATION_ID)." });
    return;
  }

  const normalizedEmails = Array.from(
    new Set(
      emails
        .map((value) => toNullableText(value))
        .filter(Boolean)
        .map((value) => value.trim().toLowerCase()),
    ),
  );

  if (!normalizedEmails.length) {
    res.json({ existing_emails: [] });
    return;
  }

  const existing = new Set();
  const chunkSize = 500;

  for (let start = 0; start < normalizedEmails.length; start += chunkSize) {
    const chunk = normalizedEmails.slice(start, start + chunkSize);
    // eslint-disable-next-line no-await-in-loop
    const { data, error } = await supabase
      .from("members")
      .select("email")
      .eq("organization_id", organizationId)
      .in("email", chunk);

    if (error) {
      res.status(500).json({ error: "Failed to check existing emails.", details: error.message });
      return;
    }

    (data || []).forEach((row) => {
      if (row.email) {
        existing.add(String(row.email).trim().toLowerCase());
      }
    });
  }

  res.json({ existing_emails: Array.from(existing) });
});

app.get("/api/outreach/resolve", async (req, res) => {
  const token = toNullableText(req.query.token);
  if (!token) {
    res.status(400).json({ error: "token query parameter is required." });
    return;
  }

  const notesValue = `outreach_token:${token}`;
  const { data: outreach, error } = await supabase
    .from("outreach_contacts")
    .select("id,contact_name,email,phone,channel,event_id,notes,created_at")
    .eq("notes", notesValue)
    .maybeSingle();

  if (error) {
    res.status(500).json({
      error: "Failed to resolve outreach token.",
      details: error.message,
    });
    return;
  }

  if (!outreach) {
    res.status(404).json({ error: "Invalid or expired token." });
    return;
  }

  const { data: event } = await supabase
    .from("events")
    .select("id,name,status")
    .eq("id", outreach.event_id)
    .maybeSingle();

  res.json({
    token,
    contact_name: outreach.contact_name,
    email: outreach.email,
    phone: outreach.phone,
    channel: outreach.channel,
    event: event ? { id: event.id, name: event.name, status: event.status } : null,
    created_at: outreach.created_at,
  });
});

async function blandApiRequest(pathname, options = {}) {
  const url = `${BLAND_ENDPOINT}${pathname}`;
  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        authorization: BLAND_API_KEY,
        "content-type": "application/json",
        ...(options.headers || {}),
      },
    });

    const rawText = await response.text();
    let payload = null;
    if (rawText) {
      try {
        payload = JSON.parse(rawText);
      } catch {
        payload = null;
      }
    }
    const headers = Object.fromEntries(response.headers.entries());

    return {
      ok: response.ok,
      status: response.status,
      payload,
      rawText,
      headers,
      url,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      payload: null,
      rawText: "",
      headers: {},
      url,
      networkError: error?.message || String(error),
    };
  }
}

app.post("/api/voice/start-web-call", async (req, res) => {
  const outreachToken = toNullableText(req.body?.token);
  const requestedAgentId = toNullableText(req.body?.agent_id);
  const agentId = requestedAgentId || BLAND_WEB_AGENT_ID || null;

  if (!outreachToken) {
    res.status(400).json({ error: "token is required." });
    return;
  }

  if (!BLAND_API_KEY) {
    res.status(500).json({
      error: "Bland is not configured. Set BLAND_API_KEY in backend/.env.",
    });
    return;
  }

  const notesValue = `outreach_token:${outreachToken}`;
  const { data: outreach, error: outreachError } = await supabase
    .from("outreach_contacts")
    .select("id,contact_name,phone,event_id")
    .eq("notes", notesValue)
    .maybeSingle();

  if (outreachError) {
    res.status(500).json({
      error: "Failed to resolve outreach token.",
      details: outreachError.message,
    });
    return;
  }

  if (!outreach) {
    res.status(404).json({ error: "Invalid or expired outreach token." });
    return;
  }

  if (!agentId) {
    res.status(400).json({
      error:
        "Bland web call is not configured. Set BLAND_WEB_AGENT_ID (or BLAND_AGENT_ID) in backend/.env.",
    });
    return;
  }

  const { data: event } = await supabase
    .from("events")
    .select("id,name")
    .eq("id", outreach.event_id)
    .maybeSingle();

  const blandBody = {
    member_token: outreachToken,
    outreach_contact_id: outreach.id,
    event_id: outreach.event_id,
    event_name: event?.name || null,
    contact_name: outreach.contact_name,
    member_name: outreach.contact_name,
  };

  console.log("[voice-start-web-call] Bland request", {
    url: `${BLAND_ENDPOINT}/v1/agents/${agentId}/authorize`,
    agentId,
    outreachContactId: outreach.id,
    tokenPrefix: outreachToken.slice(0, 8),
    requestBody: blandBody,
  });

  const blandResponse = await blandApiRequest(`/v1/agents/${agentId}/authorize`, {
    method: "POST",
    body: JSON.stringify(blandBody),
  });

  if (!blandResponse.ok) {
    console.error("[voice-start-web-call] Bland API rejected request", {
      blandStatus: blandResponse.status,
      blandResponse: blandResponse.payload,
      blandRawText: blandResponse.rawText,
      blandHeaders: blandResponse.headers,
      blandUrl: blandResponse.url,
      blandNetworkError: blandResponse.networkError || null,
      agentId,
      outreachContactId: outreach.id,
      tokenPrefix: outreachToken.slice(0, 8),
    });

    const blandMessage =
      blandResponse.payload?.message ||
      blandResponse.payload?.error ||
      blandResponse.payload?.status ||
      "";
    const likelyUnpublishedAgent =
      /draft|modified|publish|unpublished/i.test(String(blandMessage));

    res.status(500).json({
      error: "Failed to start Bland call.",
      bland_status: blandResponse.status,
      bland_response: blandResponse.payload,
      bland_raw_text: blandResponse.rawText,
      bland_network_error: blandResponse.networkError || null,
      hint: likelyUnpublishedAgent
        ? "Your Bland agent appears not published. In Bland dashboard, open the agent and click Publish, then retry."
        : "Check Bland agent status and ensure it is published/live. Also verify BLAND_WEB_AGENT_ID is correct.",
    });
    return;
  }

  const sessionToken =
    blandResponse.payload?.token ||
    blandResponse.payload?.session_token ||
    blandResponse.payload?.sessionToken ||
    null;

  if (!sessionToken) {
    res.status(500).json({
      error: "Bland web call response did not include a session token.",
      bland_response: blandResponse.payload,
    });
    return;
  }

  console.log("[voice-start-web-call] Bland web call session created", {
    agentId,
    sessionTokenPresent: Boolean(sessionToken),
    outreachContactId: outreach.id,
    memberToken: outreachToken,
  });

  res.status(201).json({
    message: "Bland web call session created.",
    session_token: sessionToken,
    agent_id: agentId,
    bland_response: blandResponse.payload,
  });
});

app.get("/api/members", async (req, res) => {
  const organizationId = toNullableText(req.query.organization_id);

  if (!organizationId) {
    res.status(400).json({
      error: "organization_id query parameter is required.",
      example: "/api/members?organization_id=<organization-uuid>",
    });
    return;
  }

  const { data: organization, error: organizationError } = await supabase
    .from("organizations")
    .select(ORGANIZATION_COLUMNS)
    .eq("id", organizationId)
    .maybeSingle();

  if (organizationError) {
    res.status(500).json({
      error: "Failed validating organization_id.",
      details: organizationError.message,
    });
    return;
  }

  if (!organization) {
    res.status(404).json({ error: "Organization not found." });
    return;
  }

  const { data, error } = await supabase
    .from("members")
    .select("*")
    .eq("organization_id", organizationId)
    .order("full_name", { ascending: true });

  if (error) {
    res.status(500).json({
      error: "Failed to fetch members from Supabase.",
      details: error.message,
    });
    return;
  }

  res.json({
    organization,
    organization_id: organizationId,
    count: data.length,
    members: data,
  });
});

const frontendDistPath = path.join(__dirname, "..", "frontend", "dist");
if (fs.existsSync(frontendDistPath)) {
  app.use(
    express.static(frontendDistPath, {
      index: false,
      fallthrough: true,
    }),
  );
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api")) {
      next();
      return;
    }
    res.sendFile(path.join(frontendDistPath, "index.html"), (err) => {
      if (err) {
        next(err);
      }
    });
  });
}

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
    res.status(400).json({ error: "File too large. Max allowed size is 10MB." });
    return;
  }

  if (err?.message === "Only .csv, .xls, and .xlsx files are supported.") {
    res.status(400).json({ error: err.message });
    return;
  }

  res.status(500).json({
    error: "Unexpected server error.",
    details: err?.message || "Unknown error",
  });
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
