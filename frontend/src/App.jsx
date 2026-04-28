import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Link,
  NavLink,
  Route,
  Routes,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { useWebchat } from "@blandsdk/client/react";

/**
 * API origin for fetch calls. Empty string = same origin (only if the SPA is served by the API).
 * Local dev: `frontend/.env.local` → e.g. http://localhost:3001
 * Production build: `frontend/.env.production` → Railway API URL (see repo).
 */
function getEnvApiBase() {
  const raw = import.meta.env.VITE_API_BASE_URL;
  if (raw === undefined || raw === null) {
    return "";
  }
  const t = String(raw).trim();
  return t === "" ? "" : t.replace(/\/$/, "");
}

const API_BASE_URL = getEnvApiBase();
const ORGANIZATION_ID = import.meta.env.VITE_ORGANIZATION_ID ?? "";
const ACCEPTED_FILE_TYPES = ".csv,.xls,.xlsx";

/** Labels for the eight check-in questions (stored as q1–q8 in API). */
const REPORT_QUESTION_LABELS = [
  "Are you and your household safe at this time?",
  "Is your practice or workplace operational?",
  "Do you need emergency assistance (medical, safety, or supplies)?",
  "Are you available to assist with animal response in the next 48 hours?",
  "What city or county are you currently located in?",
  "Do you have adequate veterinary supplies and medications on hand?",
  "Best alternate contact (phone or email) if we cannot reach you?",
  "Additional notes for coordinators?",
];

function statusLabel(status) {
  if (status === "safe") {
    return "Safe";
  }
  if (status === "needs_help") {
    return "Needs Help";
  }
  return "No Response";
}

function escapeCsvCell(value) {
  const s = value === null || value === undefined ? "" : String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function buildReportCsv(rows) {
  const headers = [
    "Name",
    "Status",
    "Channel contacted",
    "Date responded",
    ...REPORT_QUESTION_LABELS.map((_, i) => `Question ${i + 1}`),
  ];
  const lines = [headers.map(escapeCsvCell).join(",")];
  for (const row of rows) {
    const answerCells = REPORT_QUESTION_LABELS.map((_, i) =>
      escapeCsvCell(row.answers?.[`q${i + 1}`] ?? ""),
    );
    lines.push(
      [
        escapeCsvCell(row.member?.full_name),
        escapeCsvCell(statusLabel(row.status)),
        escapeCsvCell(row.channel_contacted || ""),
        escapeCsvCell(
          row.date_responded ? new Date(row.date_responded).toLocaleString() : "",
        ),
        ...answerCells,
      ].join(","),
    );
  }
  return `\uFEFF${lines.join("\r\n")}`;
}

function buildApiError(message, details = {}) {
  const error = new Error(message);
  error.details = details;
  return error;
}

async function fetchJson(url) {
  const response = await fetch(url);
  const rawBody = await response.text();
  const contentType = response.headers.get("content-type") || "";
  const isJson = contentType.includes("application/json");

  let parsed;
  if (isJson && rawBody) {
    parsed = JSON.parse(rawBody);
  } else {
    parsed = null;
  }

  if (!response.ok) {
    const message =
      parsed?.error ||
      (rawBody ? rawBody.slice(0, 180) : `HTTP ${response.status}`);
    throw buildApiError(message, {
      status: response.status,
      response: parsed,
      rawBody,
      url,
    });
  }

  if (!isJson) {
    throw new Error("API returned non-JSON response. Check backend route/server.");
  }

  return parsed;
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const rawBody = await response.text();
  const contentType = response.headers.get("content-type") || "";
  const isJson = contentType.includes("application/json");
  const parsed = isJson && rawBody ? JSON.parse(rawBody) : null;

  if (!response.ok) {
    const message =
      parsed?.error ||
      (rawBody ? rawBody.slice(0, 180) : `HTTP ${response.status}`);
    throw buildApiError(message, {
      status: response.status,
      response: parsed,
      rawBody,
      url,
      requestBody: body,
    });
  }

  if (!isJson) {
    throw new Error("API returned non-JSON response. Check backend route/server.");
  }

  return parsed;
}

async function patchJson(url, body) {
  const response = await fetch(url, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const rawBody = await response.text();
  const contentType = response.headers.get("content-type") || "";
  const isJson = contentType.includes("application/json");
  const parsed = isJson && rawBody ? JSON.parse(rawBody) : null;

  if (!response.ok) {
    const message =
      parsed?.error ||
      (rawBody ? rawBody.slice(0, 180) : `HTTP ${response.status}`);
    throw new Error(message);
  }

  if (!isJson) {
    throw new Error("API returned non-JSON response. Check backend route/server.");
  }

  return parsed;
}

function StatCard({ label, value, helpText }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-sm font-medium text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-slate-900">{value}</p>
      {helpText ? <p className="mt-1 text-xs text-slate-500">{helpText}</p> : null}
    </div>
  );
}

function normalizeHeaderForMatch(value) {
  return String(value).trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

const MEMBER_IMPORT_FIELDS = [
  { key: "email", label: "Email (required)" },
  { key: "first_name", label: "First name" },
  { key: "last_name", label: "Last name" },
  { key: "full_name", label: "Full name" },
  { key: "phone", label: "Phone" },
  { key: "role", label: "Role" },
  { key: "credentials", label: "Credentials" },
  { key: "is_active", label: "Active (true/false)" },
];

const FIELD_SYNONYMS = {
  email: ["email", "emailaddress", "e-mail", "mail", "email_address"],
  first_name: ["firstname", "first_name", "first name", "givenname", "given_name", "first"],
  last_name: ["lastname", "last_name", "last name", "surname", "familyname", "family_name", "last"],
  full_name: ["fullname", "full_name", "full name", "name", "membername", "member_name"],
  phone: ["phone", "phonenumber", "phone_number", "mobile", "cell", "cellphone", "cell_phone"],
  role: ["role", "memberrole", "member_role", "position", "member_type"],
  credentials: ["credentials", "license", "licensenumber", "license_number"],
  is_active: ["isactive", "is_active", "active", "enabled", "status"],
};

function tryAutoMap(headers) {
  const normalizedHeaders = headers.map((h) => ({
    original: h,
    normalized: normalizeHeaderForMatch(h),
  }));

  const mapping = {};
  for (const field of MEMBER_IMPORT_FIELDS) {
    const synonyms = (FIELD_SYNONYMS[field.key] || []).map(normalizeHeaderForMatch);
    const match = normalizedHeaders.find((h) => synonyms.includes(h.normalized));
    mapping[field.key] = match ? match.original : "";
  }
  return mapping;
}

function getCellValue(row, headerName) {
  if (!headerName) {
    return "";
  }
  return row?.[headerName] ?? "";
}

function toEmail(value) {
  const raw = value === undefined || value === null ? "" : String(value);
  const trimmed = raw.trim().toLowerCase();
  return trimmed;
}

function isValidEmailFormat(value) {
  const email = toEmail(value);
  if (!email) {
    return false;
  }
  // Intentionally simple/forgiving validation.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function parseBoolean(value, defaultValue = true) {
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

function buildMemberFromRow(row, mapping) {
  const email = toEmail(getCellValue(row, mapping.email));

  const firstNameRaw = String(getCellValue(row, mapping.first_name) ?? "").trim();
  const lastNameRaw = String(getCellValue(row, mapping.last_name) ?? "").trim();
  const fullNameRaw = String(getCellValue(row, mapping.full_name) ?? "").trim();
  const combinedName = [firstNameRaw, lastNameRaw].filter(Boolean).join(" ").trim();
  const full_name = fullNameRaw || combinedName || email;

  return {
    email,
    full_name,
    phone: String(getCellValue(row, mapping.phone) ?? "").trim() || null,
    role: String(getCellValue(row, mapping.role) ?? "").trim() || "volunteer",
    credentials: String(getCellValue(row, mapping.credentials) ?? "").trim() || null,
    is_active: parseBoolean(getCellValue(row, mapping.is_active), true),
  };
}

function MemberUploadPanel({ onImportComplete }) {
  const [isDragActive, setIsDragActive] = useState(false);
  const [selectedFile, setSelectedFile] = useState(null);
  const [rawRows, setRawRows] = useState([]);
  const [headers, setHeaders] = useState([]);
  const [mapping, setMapping] = useState(() => tryAutoMap([]));
  const [existingEmails, setExistingEmails] = useState(() => new Set());
  const [isCheckingExisting, setIsCheckingExisting] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadMessage, setUploadMessage] = useState("");
  const [uploadError, setUploadError] = useState("");

  const downloadCsvTemplate = () => {
    const headers = [
      "first_name",
      "last_name",
      "email",
      "phone",
      "practice_name",
      "practice_address",
      "county",
      "num_vets_employed",
    ];

    const exampleRows = [
      {
        first_name: "Alex",
        last_name: "Rivera",
        email: "alex.rivera@example.com",
        phone: "555-0101",
        practice_name: "Gulf Coast Animal Hospital",
        practice_address: "123 Main St, Tampa, FL 33602",
        county: "Hillsborough",
        num_vets_employed: "4",
      },
      {
        first_name: "Jordan",
        last_name: "Nguyen",
        email: "jordan.nguyen@example.com",
        phone: "555-0102",
        practice_name: "Palm Bay Veterinary Clinic",
        practice_address: "456 Ocean Ave, Melbourne, FL 32901",
        county: "Brevard",
        num_vets_employed: "2",
      },
      {
        first_name: "Taylor",
        last_name: "Patel",
        email: "taylor.patel@example.com",
        phone: "555-0103",
        practice_name: "Panhandle Emergency Vet",
        practice_address: "789 Pine Rd, Pensacola, FL 32501",
        county: "Escambia",
        num_vets_employed: "6",
      },
    ];

    const escapeCsv = (value) => {
      const text = value === undefined || value === null ? "" : String(value);
      if (/[",\n]/.test(text)) {
        return `"${text.replaceAll('"', '""')}"`;
      }
      return text;
    };

    const lines = [
      headers.join(","),
      ...exampleRows.map((row) => headers.map((h) => escapeCsv(row[h])).join(",")),
    ];

    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "fvma-members-template.csv";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  const parseFileForPreview = useCallback(async (file) => {
    const XLSX = await import("xlsx");
    const fileBuffer = await file.arrayBuffer();
    const workbook = XLSX.read(fileBuffer, { type: "array" });
    const firstSheetName = workbook.SheetNames[0];
    const firstSheet = workbook.Sheets[firstSheetName];

    if (!firstSheet) {
      throw new Error("The uploaded file does not contain a readable sheet.");
    }

    const rows = XLSX.utils.sheet_to_json(firstSheet, { defval: "" });
    const detectedHeaders =
      rows.length > 0 ? Object.keys(rows[0]) : XLSX.utils.sheet_to_json(firstSheet, { header: 1 })[0] || [];

    setRawRows(rows);
    setHeaders(detectedHeaders);
    setMapping(tryAutoMap(detectedHeaders));
  }, []);

  const handleFileSelection = useCallback(
    async (file) => {
      if (!file) {
        return;
      }

      setUploadError("");
      setUploadMessage("");
      setSelectedFile(file);

      try {
        await parseFileForPreview(file);
      } catch (error) {
        setRawRows([]);
        setHeaders([]);
        setUploadError(error.message || "Unable to preview file.");
      }
    },
    [parseFileForPreview],
  );

  const handleFileInputChange = async (event) => {
    const file = event.target.files?.[0];
    await handleFileSelection(file);
  };

  const handleDrop = async (event) => {
    event.preventDefault();
    setIsDragActive(false);

    const file = event.dataTransfer.files?.[0];
    await handleFileSelection(file);
  };

  const preview = useMemo(() => {
    const emailsInFile = new Map();
    const previewRows = rawRows.map((row, index) => {
      const member = buildMemberFromRow(row, mapping);
      const problems = [];

      if (!member.email) {
        problems.push("Missing email");
      } else if (!isValidEmailFormat(member.email)) {
        problems.push("Email looks invalid");
      }

      if (member.email) {
        const existingRow = emailsInFile.get(member.email);
        if (existingRow) {
          problems.push(`Duplicate email in file (also seen on row ${existingRow})`);
        } else {
          emailsInFile.set(member.email, index + 2);
        }
      }

      return {
        rowNumber: index + 2,
        member,
        problems,
        willUpdate: member.email ? existingEmails.has(member.email) : false,
      };
    });

    const valid = previewRows.filter((r) => r.problems.length === 0);
    const invalid = previewRows.filter((r) => r.problems.length > 0);
    return { previewRows, valid, invalid };
  }, [rawRows, mapping, existingEmails]);

  useEffect(() => {
    async function checkExisting() {
      if (!rawRows.length || !mapping.email) {
        setExistingEmails(new Set());
        return;
      }

      const emails = rawRows
        .map((row) => toEmail(getCellValue(row, mapping.email)))
        .filter(Boolean);

      if (!emails.length) {
        setExistingEmails(new Set());
        return;
      }

      setIsCheckingExisting(true);
      try {
        const result = await postJson(`${API_BASE_URL}/api/members/existing-emails`, {
          organization_id: ORGANIZATION_ID,
          emails,
        });
        setExistingEmails(new Set(result.existing_emails || []));
      } catch {
        // If this check fails, we still allow import—just won't show update/create status.
        setExistingEmails(new Set());
      } finally {
        setIsCheckingExisting(false);
      }
    }

    checkExisting();
  }, [rawRows, mapping.email]);

  const handleUpload = async () => {
    if (!selectedFile) {
      setUploadError("Please choose a CSV or Excel file first.");
      return;
    }

    if (!mapping.email) {
      setUploadError("Please map the Email column before importing.");
      return;
    }

    const membersToImport = preview.valid.map((row) => row.member);
    if (!membersToImport.length) {
      setUploadError("No valid rows to import. Email is required.");
      return;
    }

    setIsUploading(true);
    setUploadError("");
    setUploadMessage("");

    try {
      const response = await fetch(`${API_BASE_URL}/api/members/import-upsert`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organization_id: ORGANIZATION_ID,
          members: membersToImport,
        }),
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "Import failed.");
      }

      setUploadMessage(
        `Import complete: inserted ${payload.inserted}, updated ${payload.updated}. Skipped ${payload.skipped_count}.`,
      );
      await onImportComplete();
    } catch (error) {
      setUploadError(error.message || "Upload failed.");
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-200 px-6 py-4">
        <h3 className="text-lg font-semibold text-slate-900">Import Members</h3>
        <p className="mt-1 text-sm text-slate-600">
          Upload a CSV, XLS, or XLSX member list for FVMA.
        </p>
      </div>

      <div className="space-y-4 px-6 py-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-slate-600">
            Need a file format? Download a template and fill it in.
          </p>
          <button
            type="button"
            onClick={downloadCsvTemplate}
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Download CSV Template
          </button>
        </div>

        <label
          onDragOver={(event) => {
            event.preventDefault();
            setIsDragActive(true);
          }}
          onDragLeave={() => setIsDragActive(false)}
          onDrop={handleDrop}
          className={`block cursor-pointer rounded-xl border-2 border-dashed p-6 text-center transition ${
            isDragActive
              ? "border-teal-500 bg-teal-50"
              : "border-slate-300 bg-slate-50 hover:border-slate-400"
          }`}
        >
          <input
            type="file"
            accept={ACCEPTED_FILE_TYPES}
            className="hidden"
            onChange={handleFileInputChange}
          />
          <p className="font-medium text-slate-800">
            Drag and drop your file here, or click to browse
          </p>
          <p className="mt-1 text-sm text-slate-600">
            Accepted formats: CSV, XLS, XLSX
          </p>
          {selectedFile ? (
            <p className="mt-3 text-sm font-medium text-teal-700">
              Selected: {selectedFile.name}
            </p>
          ) : null}
        </label>

        {headers.length ? (
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <h4 className="text-sm font-semibold text-slate-800">Column mapping</h4>
            <p className="mt-1 text-sm text-slate-600">
              We auto-detected what we could. For anything blank, choose the correct column.
              Only <span className="font-medium">Email</span> is required.
            </p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {MEMBER_IMPORT_FIELDS.map((field) => (
                <label key={field.key} className="block">
                  <span className="text-xs font-medium text-slate-700">{field.label}</span>
                  <select
                    value={mapping[field.key] || ""}
                    onChange={(e) =>
                      setMapping((prev) => ({ ...prev, [field.key]: e.target.value }))
                    }
                    className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-2 text-sm text-slate-900 shadow-sm"
                  >
                    <option value="">— None —</option>
                    {headers.map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={handleUpload}
            disabled={!selectedFile || isUploading || !rawRows.length}
            className="rounded-md bg-teal-700 px-4 py-2 text-sm font-medium text-white hover:bg-teal-800 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            {isUploading ? "Uploading..." : "Save Members to Database"}
          </button>
          {rawRows.length ? (
            <p className="text-sm text-slate-600">
              Ready: <span className="font-medium text-slate-800">{preview.valid.length}</span>{" "}
              valid,{" "}
              <span className="font-medium text-slate-800">{preview.invalid.length}</span>{" "}
              flagged
            </p>
          ) : null}
          {rawRows.length ? (
            <p className="text-sm text-slate-500">
              {isCheckingExisting ? "Checking existing emails..." : "Preview shows create vs update."}
            </p>
          ) : null}
          {uploadMessage ? (
            <p className="text-sm font-medium text-emerald-700">{uploadMessage}</p>
          ) : null}
          {uploadError ? (
            <p className="text-sm font-medium text-rose-700">{uploadError}</p>
          ) : null}
        </div>

        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-4 py-2 font-semibold text-slate-700">Row</th>
                <th className="px-4 py-2 font-semibold text-slate-700">Action</th>
                <th className="px-4 py-2 font-semibold text-slate-700">Full name</th>
                <th className="px-4 py-2 font-semibold text-slate-700">Email</th>
                <th className="px-4 py-2 font-semibold text-slate-700">Phone</th>
                <th className="px-4 py-2 font-semibold text-slate-700">Problems</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {preview.previewRows.slice(0, 25).map((row) => (
                <tr key={row.rowNumber}>
                  <td className="px-4 py-2 text-slate-700">{row.rowNumber}</td>
                  <td className="px-4 py-2">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                        row.problems.length
                          ? "bg-rose-100 text-rose-700"
                          : row.willUpdate
                            ? "bg-amber-100 text-amber-800"
                            : "bg-emerald-100 text-emerald-700"
                      }`}
                    >
                      {row.problems.length
                        ? "Flagged"
                        : row.willUpdate
                          ? "Will be updated"
                          : "Will be created"}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-slate-900">{row.member.full_name || "-"}</td>
                  <td className="px-4 py-2 text-slate-700">{row.member.email || "-"}</td>
                  <td className="px-4 py-2 text-slate-700">{row.member.phone || "-"}</td>
                  <td className="px-4 py-2 text-slate-700">
                    {row.problems.length ? row.problems.join("; ") : "-"}
                  </td>
                </tr>
              ))}
              {!preview.previewRows.length ? (
                <tr>
                  <td colSpan={6} className="px-4 py-5 text-center text-slate-500">
                    Upload a file to preview members before saving.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        {preview.previewRows.length > 25 ? (
          <p className="text-xs text-slate-500">
            Showing first 25 rows of {preview.previewRows.length}.
          </p>
        ) : null}
      </div>
    </section>
  );
}

function DashboardPage() {
  const [organization, setOrganization] = useState(null);
  const [members, setMembers] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");

  const loadDashboard = useCallback(async () => {
    setIsLoading(true);
    setError("");

    try {
      const [orgData, membersData] = await Promise.all([
        fetchJson(`${API_BASE_URL}/api/organizations/${ORGANIZATION_ID}`),
        fetchJson(
          `${API_BASE_URL}/api/members?organization_id=${ORGANIZATION_ID}`,
        ),
      ]);

      setOrganization(orgData);
      setMembers(membersData.members || []);
    } catch (err) {
      setError(err.message || "Unexpected dashboard error.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDashboard();
  }, [loadDashboard]);

  const activeMembers = useMemo(
    () => members.filter((member) => member.is_active).length,
    [members],
  );
  const veterinarians = useMemo(
    () => members.filter((member) => member.role === "veterinarian").length,
    [members],
  );

  if (isLoading) {
    return (
      <main className="mx-auto max-w-6xl px-4 py-16">
        <p className="text-slate-600">Loading dashboard...</p>
      </main>
    );
  }

  if (error) {
    return (
      <main className="mx-auto max-w-6xl px-4 py-16">
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-rose-700">
          <p className="font-medium">Could not load dashboard.</p>
          <p className="mt-1 text-sm">{error}</p>
          <p className="mt-3 text-sm">
            {API_BASE_URL ? (
              <>
                Make sure the API is reachable at{" "}
                <code className="rounded bg-slate-100 px-1">{API_BASE_URL}</code>.
              </>
            ) : (
              <>
                Make sure this app&apos;s server is running (same host serves the API in
                production).
              </>
            )}
          </p>
        </div>
      </main>
    );
  }

  const location = [organization.city, organization.state]
    .filter(Boolean)
    .join(", ");

  return (
    <main className="mx-auto max-w-6xl space-y-6 px-4 py-8">
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-wide text-teal-700">
          Organization Dashboard
        </p>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-900">
          {organization.name}
        </h2>
        <div className="mt-4 grid gap-2 text-sm text-slate-600 sm:grid-cols-2">
          <p>
            <span className="font-medium text-slate-700">Organization ID:</span>{" "}
            {organization.id}
          </p>
          <p>
            <span className="font-medium text-slate-700">Type:</span>{" "}
            {organization.org_type || "N/A"}
          </p>
          <p>
            <span className="font-medium text-slate-700">Email:</span>{" "}
            {organization.email || "N/A"}
          </p>
          <p>
            <span className="font-medium text-slate-700">Phone:</span>{" "}
            {organization.phone || "N/A"}
          </p>
          <p>
            <span className="font-medium text-slate-700">Location:</span>{" "}
            {location || "N/A"}
          </p>
          <p>
            <span className="font-medium text-slate-700">Website:</span>{" "}
            {organization.website || "N/A"}
          </p>
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Total Members" value={members.length} />
        <StatCard label="Active Members" value={activeMembers} />
        <StatCard
          label="Veterinarians"
          value={veterinarians}
          helpText="Role equals veterinarian"
        />
      </section>

      <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 px-6 py-4">
          <h3 className="text-lg font-semibold text-slate-900">Members</h3>
          <p className="mt-1 text-sm text-slate-600">
            Showing all members assigned to this organization.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-6 py-3 font-semibold text-slate-700">Name</th>
                <th className="px-6 py-3 font-semibold text-slate-700">Role</th>
                <th className="px-6 py-3 font-semibold text-slate-700">Email</th>
                <th className="px-6 py-3 font-semibold text-slate-700">Phone</th>
                <th className="px-6 py-3 font-semibold text-slate-700">Active</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {members.map((member) => (
                <tr key={member.id}>
                  <td className="px-6 py-3 text-slate-900">{member.full_name}</td>
                  <td className="px-6 py-3 text-slate-700">{member.role}</td>
                  <td className="px-6 py-3 text-slate-700">{member.email || "-"}</td>
                  <td className="px-6 py-3 text-slate-700">{member.phone || "-"}</td>
                  <td className="px-6 py-3">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                        member.is_active
                          ? "bg-emerald-100 text-emerald-700"
                          : "bg-slate-200 text-slate-700"
                      }`}
                    >
                      {member.is_active ? "Yes" : "No"}
                    </span>
                  </td>
                </tr>
              ))}
              {!members.length ? (
                <tr>
                  <td colSpan={5} className="px-6 py-8 text-center text-slate-500">
                    No members found for this organization yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

function MembersPage() {
  const [members, setMembers] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");

  const loadMembers = useCallback(async () => {
    setIsLoading(true);
    setError("");

    try {
      const membersData = await fetchJson(
        `${API_BASE_URL}/api/members?organization_id=${ORGANIZATION_ID}`,
      );
      setMembers(membersData.members || []);
    } catch (err) {
      setError(err.message || "Unexpected members error.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadMembers();
  }, [loadMembers]);

  return (
    <main className="mx-auto max-w-6xl space-y-6 px-4 py-8">
      <MemberUploadPanel onImportComplete={loadMembers} />

      <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 px-6 py-4">
          <h2 className="text-lg font-semibold text-slate-900">All Members</h2>
          <p className="mt-1 text-sm text-slate-600">
            Members currently saved for FVMA ({members.length}).
          </p>
        </div>

        {isLoading ? (
          <div className="px-6 py-10 text-slate-600">Loading members...</div>
        ) : error ? (
          <div className="px-6 py-10 text-rose-700">{error}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-6 py-3 font-semibold text-slate-700">Name</th>
                  <th className="px-6 py-3 font-semibold text-slate-700">Role</th>
                  <th className="px-6 py-3 font-semibold text-slate-700">Email</th>
                  <th className="px-6 py-3 font-semibold text-slate-700">Phone</th>
                  <th className="px-6 py-3 font-semibold text-slate-700">Active</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {members.map((member) => (
                  <tr key={member.id}>
                    <td className="px-6 py-3 text-slate-900">{member.full_name}</td>
                    <td className="px-6 py-3 text-slate-700">{member.role}</td>
                    <td className="px-6 py-3 text-slate-700">{member.email || "-"}</td>
                    <td className="px-6 py-3 text-slate-700">{member.phone || "-"}</td>
                    <td className="px-6 py-3">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                          member.is_active
                            ? "bg-emerald-100 text-emerald-700"
                            : "bg-slate-200 text-slate-700"
                        }`}
                      >
                        {member.is_active ? "Yes" : "No"}
                      </span>
                    </td>
                  </tr>
                ))}
                {!members.length ? (
                  <tr>
                    <td colSpan={5} className="px-6 py-8 text-center text-slate-500">
                      No members found yet.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}

function EventsPage() {
  const [events, setEvents] = useState([]);
  const [name, setName] = useState("");
  const [activate, setActivate] = useState(true);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const loadEvents = useCallback(async () => {
    setIsLoading(true);
    setError("");

    try {
      const data = await fetchJson(`${API_BASE_URL}/api/events`);
      setEvents(data.events || []);
    } catch (err) {
      setError(err.message || "Failed to load events.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadEvents();
  }, [loadEvents]);

  const handleCreate = async (event) => {
    event.preventDefault();
    setIsSaving(true);
    setError("");
    setMessage("");

    try {
      const created = await postJson(`${API_BASE_URL}/api/events`, {
        name,
        activate,
      });
      setMessage(`Created event: ${created.name}`);
      setName("");
      await loadEvents();
    } catch (err) {
      setError(err.message || "Failed to create event.");
    } finally {
      setIsSaving(false);
    }
  };

  const handleActivate = async (eventId) => {
    setError("");
    setMessage("");
    try {
      await patchJson(`${API_BASE_URL}/api/events/${eventId}/activate`);
      setMessage("Event activated.");
      await loadEvents();
    } catch (err) {
      setError(err.message || "Failed to activate event.");
    }
  };

  return (
    <main className="mx-auto max-w-6xl space-y-6 px-4 py-8">
      <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 px-6 py-4">
          <h2 className="text-lg font-semibold text-slate-900">Create Disaster Event</h2>
          <p className="mt-1 text-sm text-slate-600">
            Example: Hurricane Milton
          </p>
        </div>
        <form onSubmit={handleCreate} className="space-y-4 px-6 py-5">
          <div>
            <label className="block text-sm font-medium text-slate-700">
              Event name
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Hurricane Milton"
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-teal-600 focus:outline-none focus:ring-2 focus:ring-teal-100"
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={activate}
              onChange={(e) => setActivate(e.target.checked)}
              className="h-4 w-4 accent-teal-700"
            />
            Activate immediately
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={!name.trim() || isSaving}
              className="rounded-md bg-teal-700 px-4 py-2 text-sm font-medium text-white hover:bg-teal-800 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              {isSaving ? "Creating..." : "Create Event"}
            </button>
            {message ? <p className="text-sm font-medium text-emerald-700">{message}</p> : null}
            {error ? <p className="text-sm font-medium text-rose-700">{error}</p> : null}
          </div>
        </form>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 px-6 py-4">
          <h3 className="text-lg font-semibold text-slate-900">Events</h3>
        </div>
        {isLoading ? (
          <div className="px-6 py-10 text-slate-600">Loading events...</div>
        ) : (
          <div className="divide-y divide-slate-100">
            {events.map((evt) => (
              <div key={evt.id} className="flex flex-wrap items-center justify-between gap-3 px-6 py-4">
                <div>
                  <p className="font-medium text-slate-900">{evt.name}</p>
                  <p className="text-sm text-slate-600">
                    Status: <span className="font-medium">{evt.status}</span>
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {evt.status !== "active" ? (
                    <button
                      type="button"
                      onClick={() => handleActivate(evt.id)}
                      className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                    >
                      Activate
                    </button>
                  ) : (
                    <>
                      <span className="rounded-full bg-emerald-100 px-2 py-1 text-xs font-medium text-emerald-700">
                        Active
                      </span>
                      <Link
                        to={`/events/${evt.id}/outreach`}
                        className="rounded-md border border-teal-300 bg-teal-50 px-3 py-2 text-sm font-medium text-teal-800 hover:bg-teal-100"
                      >
                        Launch Outreach
                      </Link>
                    </>
                  )}
                </div>
              </div>
            ))}
            {!events.length ? (
              <div className="px-6 py-10 text-slate-500">No events yet.</div>
            ) : null}
          </div>
        )}
      </section>
    </main>
  );
}

function OutreachLauncherPage() {
  const { eventId } = useParams();
  const [event, setEvent] = useState(null);
  const [members, setMembers] = useState([]);
  const [history, setHistory] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [useEmail, setUseEmail] = useState(true);
  const [useSms, setUseSms] = useState(false);
  const [isSending, setIsSending] = useState(false);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    setError("");

    try {
      const [eventData, membersData, historyData] = await Promise.all([
        fetchJson(`${API_BASE_URL}/api/events/${eventId}`),
        fetchJson(
          `${API_BASE_URL}/api/members?organization_id=${ORGANIZATION_ID}`,
        ),
        fetchJson(
          `${API_BASE_URL}/api/events/${eventId}/outreach-history?organization_id=${ORGANIZATION_ID}`,
        ),
      ]);

      const activeMembers = (membersData.members || []).filter(
        (member) => member.is_active,
      );

      setEvent(eventData);
      setMembers(activeMembers);
      setHistory(historyData.records || []);
    } catch (err) {
      setError(err.message || "Failed to load outreach preview.");
    } finally {
      setIsLoading(false);
    }
  }, [eventId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const sendOutreach = async () => {
    const channels = [];
    if (useEmail) {
      channels.push("email");
    }
    if (useSms) {
      channels.push("sms");
    }

    if (!channels.length) {
      setError("Please select at least one channel (Email or SMS).");
      return;
    }

    setIsSending(true);
    setError("");
    setMessage("");

    try {
      const result = await postJson(`${API_BASE_URL}/api/events/${eventId}/outreach-launch`, {
        organization_id: ORGANIZATION_ID,
        channels,
      });

      setMessage(
        `Success: ${result.created_count} outreach contact record(s) created. ${result.skipped_count} skipped.`,
      );
      await loadData();
    } catch (err) {
      setError(err.message || "Failed to send outreach.");
    } finally {
      setIsSending(false);
    }
  };

  if (isLoading) {
    return (
      <main className="mx-auto max-w-6xl px-4 py-10">
        <p className="text-slate-600">Loading outreach preview...</p>
      </main>
    );
  }

  if (error && !event) {
    return (
      <main className="mx-auto max-w-6xl px-4 py-10">
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-rose-700">
          <p className="font-medium">Could not load outreach page.</p>
          <p className="mt-1 text-sm">{error}</p>
        </div>
      </main>
    );
  }

  const emailEligible = members.filter((member) => Boolean(member.email)).length;
  const smsEligible = members.filter((member) => Boolean(member.phone)).length;
  const isEventActive = event?.status === "active";

  return (
    <main className="mx-auto max-w-6xl space-y-6 px-4 py-8">
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-teal-700">
              Outreach Campaign Launcher
            </p>
            <h2 className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">
              {event?.name}
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              Event status:{" "}
              <span className="font-medium text-slate-800">{event?.status}</span>
            </p>
          </div>
          <Link
            to="/events"
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Back to Events
          </Link>
        </div>

        {!isEventActive ? (
          <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            This event is not active yet. Activate it on the Events page before launching outreach.
          </div>
        ) : null}
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h3 className="text-lg font-semibold text-slate-900">Channels</h3>
        <p className="mt-1 text-sm text-slate-600">
          Choose which channels to use for this outreach campaign.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-5">
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={useEmail}
              onChange={(e) => setUseEmail(e.target.checked)}
              className="h-4 w-4 accent-teal-700"
            />
            Email ({emailEligible} with email)
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={useSms}
              onChange={(e) => setUseSms(e.target.checked)}
              className="h-4 w-4 accent-teal-700"
            />
            SMS ({smsEligible} with phone)
          </label>
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={sendOutreach}
            disabled={isSending || !isEventActive}
            className="rounded-md bg-teal-700 px-4 py-2 text-sm font-medium text-white hover:bg-teal-800 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            {isSending ? "Sending Outreach..." : "Send Outreach"}
          </button>
          {message ? <p className="text-sm font-medium text-emerald-700">{message}</p> : null}
          {error ? <p className="text-sm font-medium text-rose-700">{error}</p> : null}
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 px-6 py-4">
          <h3 className="text-lg font-semibold text-slate-900">Members to Contact</h3>
          <p className="mt-1 text-sm text-slate-600">
            {members.length} active member(s) are eligible for outreach consideration.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-6 py-3 font-semibold text-slate-700">Name</th>
                <th className="px-6 py-3 font-semibold text-slate-700">Email</th>
                <th className="px-6 py-3 font-semibold text-slate-700">Phone</th>
                <th className="px-6 py-3 font-semibold text-slate-700">Can Email</th>
                <th className="px-6 py-3 font-semibold text-slate-700">Can SMS</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {members.map((member) => (
                <tr key={member.id}>
                  <td className="px-6 py-3 text-slate-900">{member.full_name}</td>
                  <td className="px-6 py-3 text-slate-700">{member.email || "-"}</td>
                  <td className="px-6 py-3 text-slate-700">{member.phone || "-"}</td>
                  <td className="px-6 py-3 text-slate-700">{member.email ? "Yes" : "No"}</td>
                  <td className="px-6 py-3 text-slate-700">{member.phone ? "Yes" : "No"}</td>
                </tr>
              ))}
              {!members.length ? (
                <tr>
                  <td colSpan={5} className="px-6 py-8 text-center text-slate-500">
                    No active members found for this organization.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 px-6 py-4">
          <h3 className="text-lg font-semibold text-slate-900">Outreach History</h3>
          <p className="mt-1 text-sm text-slate-600">
            Records created for this event (most recent first).
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-6 py-3 font-semibold text-slate-700">Timestamp</th>
                <th className="px-6 py-3 font-semibold text-slate-700">Channel</th>
                <th className="px-6 py-3 font-semibold text-slate-700">Contact</th>
                <th className="px-6 py-3 font-semibold text-slate-700">Token</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {history.map((row) => (
                <tr key={row.id}>
                  <td className="px-6 py-3 text-slate-700">
                    {row.created_at ? new Date(row.created_at).toLocaleString() : "-"}
                  </td>
                  <td className="px-6 py-3 text-slate-700">{row.channel}</td>
                  <td className="px-6 py-3 text-slate-900">{row.contact_name}</td>
                  <td className="px-6 py-3 font-mono text-xs text-slate-700">
                    {row.token || "-"}
                  </td>
                </tr>
              ))}
              {!history.length ? (
                <tr>
                  <td colSpan={4} className="px-6 py-8 text-center text-slate-500">
                    No outreach records yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

function ReportsPage() {
  const [events, setEvents] = useState([]);
  const [reportPayload, setReportPayload] = useState(null);
  const [statusFilter, setStatusFilter] = useState("all");
  const [expanded, setExpanded] = useState(() => new Set());
  const [isLoadingEvents, setIsLoadingEvents] = useState(true);
  const [isLoadingReport, setIsLoadingReport] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function loadEvents() {
      setIsLoadingEvents(true);
      setError("");
      try {
        const data = await fetchJson(`${API_BASE_URL}/api/events`);
        if (!cancelled) {
          setEvents(data.events || []);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err.message || "Failed to load events.");
        }
      } finally {
        if (!cancelled) {
          setIsLoadingEvents(false);
        }
      }
    }
    loadEvents();
    return () => {
      cancelled = true;
    };
  }, []);

  const activeEvent = useMemo(
    () => (events || []).find((e) => e.status === "active") || null,
    [events],
  );

  useEffect(() => {
    if (!activeEvent?.id) {
      setReportPayload(null);
      return;
    }
    let cancelled = false;
    async function loadReport() {
      setIsLoadingReport(true);
      setError("");
      try {
        const data = await fetchJson(
          `${API_BASE_URL}/api/events/${activeEvent.id}/member-report?organization_id=${ORGANIZATION_ID}`,
        );
        if (!cancelled) {
          setReportPayload(data);
        }
      } catch (err) {
        if (!cancelled) {
          setReportPayload(null);
          setError(err.message || "Failed to load report.");
        }
      } finally {
        if (!cancelled) {
          setIsLoadingReport(false);
        }
      }
    }
    loadReport();
    return () => {
      cancelled = true;
    };
  }, [activeEvent?.id]);

  const filteredRows = useMemo(() => {
    const rows = reportPayload?.rows || [];
    if (statusFilter === "all") {
      return rows;
    }
    return rows.filter((r) => r.status === statusFilter);
  }, [reportPayload, statusFilter]);

  const toggleExpanded = useCallback((memberId) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(memberId)) {
        next.delete(memberId);
      } else {
        next.add(memberId);
      }
      return next;
    });
  }, []);

  const exportCsv = useCallback(() => {
    const csv = buildReportCsv(filteredRows);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const safeName = (activeEvent?.name || "event")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 60);
    a.href = url;
    a.download = `fvma-report-${safeName}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [filteredRows, activeEvent?.name]);

  const filterBtn = (id, label) => (
    <button
      key={id}
      type="button"
      onClick={() => setStatusFilter(id)}
      className={`rounded-md px-3 py-1.5 text-sm font-medium ${
        statusFilter === id
          ? "bg-teal-700 text-white"
          : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
      }`}
    >
      {label}
    </button>
  );

  return (
    <main className="mx-auto max-w-6xl space-y-6 px-4 py-8">
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-teal-700">
              Reports
            </p>
            <h2 className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">
              Member check-ins
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              Response summary for the{" "}
              <span className="font-medium text-slate-800">active</span> disaster event.
            </p>
          </div>
          <Link
            to="/events"
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Events
          </Link>
        </div>

        {isLoadingEvents ? (
          <p className="mt-4 text-sm text-slate-600">Loading events…</p>
        ) : !activeEvent ? (
          <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            There is no active event. Activate an event on the Events page to view reports.
          </div>
        ) : (
          <p className="mt-4 text-sm text-slate-600">
            Active event:{" "}
            <span className="font-semibold text-slate-900">{activeEvent.name}</span>
          </p>
        )}
      </section>

      {activeEvent ? (
        <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="flex flex-col gap-4 border-b border-slate-200 px-6 py-4 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
            <div>
              <h3 className="text-lg font-semibold text-slate-900">Responses</h3>
              <p className="mt-1 text-sm text-slate-600">
                {reportPayload?.count ?? "—"} active member
                {reportPayload?.count === 1 ? "" : "s"} for this event.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {filterBtn("all", "All")}
              {filterBtn("safe", "Safe")}
              {filterBtn("needs_help", "Needs Help")}
              {filterBtn("no_response", "No Response")}
              <button
                type="button"
                onClick={exportCsv}
                disabled={isLoadingReport || !filteredRows.length}
                className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Export to CSV
              </button>
            </div>
          </div>

          {isLoadingReport ? (
            <div className="px-6 py-10 text-sm text-slate-600">Loading report…</div>
          ) : error ? (
            <div className="px-6 py-10">
              <p className="text-sm font-medium text-rose-700">{error}</p>
              <p className="mt-2 text-sm text-slate-600">
                If the error mentions{" "}
                <code className="rounded bg-slate-100 px-1">event_member_responses</code>, run
                the SQL migration in{" "}
                <code className="rounded bg-slate-100 px-1">
                  supabase/migrations/20260417120000_event_member_responses.sql
                </code>{" "}
                in the Supabase SQL editor.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="w-10 px-4 py-3 font-semibold text-slate-700" aria-label="Expand" />
                    <th className="px-6 py-3 font-semibold text-slate-700">Name</th>
                    <th className="px-6 py-3 font-semibold text-slate-700">Status</th>
                    <th className="px-6 py-3 font-semibold text-slate-700">
                      Channel contacted
                    </th>
                    <th className="px-6 py-3 font-semibold text-slate-700">
                      Date responded
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white">
                  {filteredRows.map((row) => {
                    const isOpen = expanded.has(row.member.id);
                    const status = row.status;
                    const statusClass =
                      status === "safe"
                        ? "bg-emerald-100 text-emerald-800"
                        : status === "needs_help"
                          ? "bg-rose-100 text-rose-800"
                          : "bg-amber-100 text-amber-800";
                    return (
                      <Fragment key={row.member.id}>
                        <tr className="hover:bg-slate-50">
                          <td className="px-4 py-3 align-top">
                            <button
                              type="button"
                              onClick={() => toggleExpanded(row.member.id)}
                              className="rounded p-1 text-slate-500 hover:bg-slate-200 hover:text-slate-800"
                              aria-expanded={isOpen}
                              aria-label={isOpen ? "Collapse answers" : "Expand answers"}
                            >
                              {isOpen ? "▼" : "▶"}
                            </button>
                          </td>
                          <td className="px-6 py-3 font-medium text-slate-900">
                            <button
                              type="button"
                              onClick={() => toggleExpanded(row.member.id)}
                              className="text-left hover:underline"
                            >
                              {row.member.full_name}
                            </button>
                          </td>
                          <td className="px-6 py-3">
                            <span
                              className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${statusClass}`}
                            >
                              {statusLabel(status)}
                            </span>
                          </td>
                          <td className="px-6 py-3 text-slate-700">
                            {row.channel_contacted || "—"}
                          </td>
                          <td className="px-6 py-3 text-slate-700">
                            {row.date_responded
                              ? new Date(row.date_responded).toLocaleString()
                              : "—"}
                          </td>
                        </tr>
                        {isOpen ? (
                          <tr className="bg-slate-50">
                            <td colSpan={5} className="px-6 pb-5 pt-0">
                              <div className="rounded-lg border border-slate-200 bg-white p-4">
                                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                                  Check-in answers
                                </p>
                                <dl className="mt-3 space-y-3">
                                  {REPORT_QUESTION_LABELS.map((label, i) => {
                                    const key = `q${i + 1}`;
                                    const val = row.answers?.[key];
                                    const display =
                                      val !== undefined && val !== null && String(val).trim() !== ""
                                        ? String(val)
                                        : "—";
                                    return (
                                      <div key={key}>
                                        <dt className="text-sm font-medium text-slate-800">
                                          {i + 1}. {label}
                                        </dt>
                                        <dd className="mt-0.5 text-sm text-slate-600 whitespace-pre-wrap">
                                          {display}
                                        </dd>
                                      </div>
                                    );
                                  })}
                                </dl>
                              </div>
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
                  {!filteredRows.length ? (
                    <tr>
                      <td
                        colSpan={5}
                        className="px-6 py-10 text-center text-slate-500"
                      >
                        No members match this filter.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}
    </main>
  );
}

function FVMAWordmark() {
  return (
    <div className="flex items-center gap-3">
      <div className="flex h-11 w-11 items-center justify-center rounded-full bg-teal-700 text-sm font-bold text-white">
        FVMA
      </div>
      <div>
        <div className="text-sm font-semibold tracking-wide text-slate-900">
          Florida Veterinary Medical Association
        </div>
        <div className="text-xs text-slate-500">Disaster Response</div>
      </div>
    </div>
  );
}

function RespondPage({ token: tokenProp }) {
  const [searchParams] = useSearchParams();
  const token = tokenProp || searchParams.get("token") || "";

  const [resolved, setResolved] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [started, setStarted] = useState(false);
  const [voiceError, setVoiceError] = useState("");
  const [transcript, setTranscript] = useState("");
  const [callStartedAt, setCallStartedAt] = useState(null);
  const transcriptRef = useRef("");

  useEffect(() => {
    async function resolveToken() {
      setIsLoading(true);
      setError("");
      setResolved(null);
      setStarted(false);
      setTranscript("");

      if (!token) {
        setIsLoading(false);
        setError("Missing token in URL.");
        return;
      }

      try {
        const data = await fetchJson(
          `${API_BASE_URL}/api/outreach/resolve?token=${encodeURIComponent(
            token,
          )}`,
        );
        setResolved(data);
      } catch (err) {
        setError(err.message || "Failed to resolve token.");
      } finally {
        setIsLoading(false);
      }
    }

    resolveToken();
  }, [token]);

  const memberName = resolved?.contact_name || "FVMA member";
  const BLAND_WEB_AGENT_ID =
    import.meta.env.VITE_BLAND_WEB_AGENT_ID || "";

  const getWebCallToken = useCallback(async () => {
    if (!token) {
      throw new Error("Missing outreach token.");
    }
    const data = await postJson(`${API_BASE_URL}/api/voice/start-web-call`, {
      token,
      agent_id: BLAND_WEB_AGENT_ID,
    });
    if (!data?.session_token) {
      throw new Error(data?.error || "Failed to create Bland web call session.");
    }
    return { token: data.session_token };
  }, [token, BLAND_WEB_AGENT_ID]);

  const {
    state: webchatState,
    start: startWebchat,
    stop: stopWebchat,
    webchat,
  } = useWebchat({
    agentId: BLAND_WEB_AGENT_ID,
    getToken: getWebCallToken,
  });

  useEffect(() => {
    const unsubscribeMessage = webchat.on("message", (m) => {
      const who =
        m?.payload?.type === "assistant" ? "AI" : m?.payload?.type ? "You" : "Message";
      const msgText =
        typeof m?.payload?.text === "string" ? m.payload.text.trim() : null;
      if (!msgText) return;
      setTranscript((cur) => (cur ? `${cur}\n${who}: ${msgText}` : `${who}: ${msgText}`));
      const formatted = transcriptRef.current
        ? `${transcriptRef.current}\n${who}: ${msgText}`
        : `${who}: ${msgText}`;
      transcriptRef.current = formatted;
    });

    return () => {
      unsubscribeMessage();
    };
  }, [webchat]);

  useEffect(() => {
    const unsubscribeClosed = webchat.on("closed", () => {
      saveVoiceResponse("closed-event");
    });
    return () => unsubscribeClosed();
  }, [webchat]);

  const saveVoiceResponse = useCallback(async (trigger) => {
    const finalTranscript = transcriptRef.current?.trim();
    if (!finalTranscript) {
      console.log("[respond] No transcript to save, skipping");
      return;
    }
    if (!token) {
      console.warn("[respond] Missing token, cannot save response");
      return;
    }
    const endedAt = new Date().toISOString();
    const startedAt = callStartedAt ? callStartedAt.toISOString() : null;
    const callLengthSeconds = callStartedAt
      ? Math.max(0, Math.round((Date.now() - callStartedAt.getTime()) / 1000))
      : null;

    try {
      console.log("[respond] Saving voice response", {
        trigger,
        transcriptLength: finalTranscript.length,
      });
      await postJson(`${API_BASE_URL}/api/voice/save-response`, {
        token,
        transcript: finalTranscript,
        started_at: startedAt,
        ended_at: endedAt,
        call_length_seconds: callLengthSeconds,
      });
      console.log("[respond] Voice response saved");
    } catch (err) {
      console.error("[respond] Failed to save voice response", err);
    }
  }, [token, callStartedAt]);

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <section className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
        <FVMAWordmark />

        <h2 className="mt-6 text-2xl font-semibold tracking-tight text-slate-900">
          Hello, {memberName}.
        </h2>

        <p className="mt-3 text-sm text-slate-600">
          We&apos;re connecting you to a short conversation with an AI voice agent
          to coordinate disaster response next steps.
        </p>

        {!started ? (
          <div className="mt-7">
            <button
              type="button"
              onClick={async () => {
                setVoiceError("");
                setTranscript("");
                try {
                  if (!token) {
                    setVoiceError("Missing outreach token.");
                    return;
                  }
                  if (!BLAND_WEB_AGENT_ID) {
                    setVoiceError(
                      "Bland is not configured in frontend (.env): VITE_BLAND_WEB_AGENT_ID missing.",
                    );
                    return;
                  }
                  transcriptRef.current = "";
                  setCallStartedAt(new Date());
                  await startWebchat();
                  setStarted(true);
                } catch (e) {
                  console.error("[respond] Failed to start Bland web call", {
                    message: e?.message,
                    details: e?.details,
                    tokenPrefix: token ? token.slice(0, 8) : null,
                    agentId: BLAND_WEB_AGENT_ID,
                  });
                  setVoiceError(e?.message || "Failed to start voice session.");
                }
              }}
              className="w-full rounded-md bg-teal-700 px-6 py-3 text-center text-sm font-semibold text-white hover:bg-teal-800"
              disabled={isLoading || !resolved}
            >
              Start Conversation
            </button>
            {error ? (
              <p className="mt-3 text-sm font-medium text-rose-700">{error}</p>
            ) : null}
            {voiceError ? (
              <p className="mt-3 text-sm font-medium text-rose-700">{voiceError}</p>
            ) : null}
            {token ? (
              <p className="mt-2 text-xs text-slate-500">
                Token resolved: <span className="font-mono">{token.slice(0, 8)}…</span>
              </p>
            ) : null}
          </div>
        ) : (
          <div className="mt-7 rounded-xl border border-slate-200 bg-slate-50 p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm font-semibold text-slate-900">
                Voice Agent (Bland)
              </p>
              <button
                type="button"
                onClick={async () => {
                  await saveVoiceResponse("stop-button");
                  stopWebchat();
                  setStarted(false);
                }}
                className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Stop
              </button>
            </div>

            <p className="mt-2 text-sm text-slate-600">
              Conversation status:{" "}
              <span className="font-medium text-slate-800">{webchatState}</span>
            </p>

            <p className="mt-3 text-sm text-slate-600">
              Speak now. Your browser may ask for microphone permission.
            </p>

            <div className="mt-4 rounded-lg border border-slate-200 bg-white p-3">
              <p className="text-xs font-semibold text-slate-600">Transcript (placeholder)</p>
              <pre className="mt-2 whitespace-pre-wrap text-sm text-slate-800">
                {transcript || "Transcript will appear here as the conversation progresses."}
              </pre>
            </div>
          </div>
        )}

        {isLoading ? (
          <p className="mt-5 text-sm text-slate-600">Loading your request…</p>
        ) : null}
      </section>
    </main>
  );
}

function RootWithToken() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token");
  if (token) {
    return <RespondPage token={token} />;
  }
  return <DashboardPage />;
}

function SiteFooter() {
  const linkClass =
    "text-white/95 underline-offset-2 transition hover:text-white hover:underline";
  return (
    <footer
      className="border-t border-black/10 bg-[#1A3A5C] px-4 py-3 text-center text-sm text-white/90"
      role="contentinfo"
    >
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-center gap-x-3 gap-y-1">
        <span>Disaster Response Technology provided by dvmSuccess</span>
        <span className="hidden text-white/35 sm:inline" aria-hidden>
          |
        </span>
        <nav
          className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1"
          aria-label="dvmSuccess links"
        >
          <a href="https://dvm.com" className={linkClass} target="_blank" rel="noopener noreferrer">
            dvm.com
          </a>
          <a
            href="https://vettelligence.ai"
            className={linkClass}
            target="_blank"
            rel="noopener noreferrer"
          >
            vettelligence.ai
          </a>
          <a href="https://dvm.me" className={linkClass} target="_blank" rel="noopener noreferrer">
            dvm.me
          </a>
        </nav>
      </div>
    </footer>
  );
}

function Navigation() {
  const linkClass = ({ isActive }) =>
    `rounded-md px-3 py-2 text-sm font-medium ${
      isActive ? "bg-teal-50 text-teal-800" : "text-slate-600 hover:bg-slate-50"
    }`;

  return (
    <nav className="flex flex-wrap items-center gap-2">
      <NavLink to="/" end className={linkClass}>
        Dashboard
      </NavLink>
      <NavLink to="/members" className={linkClass}>
        Members
      </NavLink>
      <NavLink to="/events" className={linkClass}>
        Events
      </NavLink>
      <NavLink to="/reports" className={linkClass}>
        Reports
      </NavLink>
    </nav>
  );
}

function App() {
  return (
    <div className="flex min-h-screen flex-col bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4">
          <div className="space-y-0.5">
            <h1 className="text-lg font-semibold tracking-tight text-slate-800">
              FVMA Disaster Response
            </h1>
            <p className="text-sm text-slate-500">
              Florida Veterinary Medical Association
            </p>
          </div>
          <Navigation />
        </div>
      </header>
      {!ORGANIZATION_ID ? (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-center text-sm text-amber-900">
          Set <code className="rounded bg-amber-100 px-1">VITE_ORGANIZATION_ID</code> when
          building the app (see <code className="rounded bg-amber-100 px-1">frontend/.env.example</code>
          ).
        </div>
      ) : null}
      <div className="flex flex-1 flex-col">
        <Routes>
          <Route path="/" element={<RootWithToken />} />
          <Route path="/members" element={<MembersPage />} />
          <Route path="/events" element={<EventsPage />} />
          <Route path="/events/:eventId/outreach" element={<OutreachLauncherPage />} />
          <Route path="/respond" element={<RespondPage />} />
          <Route path="/reports" element={<ReportsPage />} />
        </Routes>
      </div>
      <SiteFooter />
    </div>
  );
}

export default App;
