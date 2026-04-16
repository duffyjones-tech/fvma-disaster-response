import express from "express";
import cors from "cors";
import multer from "multer";
import XLSX from "xlsx";
import { extname } from "node:path";
import { supabase } from "./supabaseClient.js";

const app = express();
const PORT = process.env.PORT || 3001;
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
    const fileExt = extname(file.originalname || "").toLowerCase();
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

function buildMemberRow(inputRow, organizationIdFromRequest) {
  const row = normalizeRowKeys(inputRow);
  const fullName = firstPopulatedValue(row, [
    "full_name",
    "name",
    "member_name",
    "full_name_(required)",
  ]);

  if (!fullName) {
    return { skipReason: "missing_full_name" };
  }

  const rowOrganizationId = firstPopulatedValue(row, [
    "organization_id",
    "organizationid",
    "org_id",
    "orgid",
  ]);

  const organizationId = organizationIdFromRequest || rowOrganizationId || null;
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
        "No valid members found. Ensure rows include full_name (or name) and organization_id.",
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
  console.log(`API server listening on http://localhost:${PORT}`);
});
