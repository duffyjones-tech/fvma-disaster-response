import { useCallback, useEffect, useMemo, useState } from "react";

const API_BASE_URL = "http://localhost:3001";
const FVMA_ORGANIZATION_ID = "02ff75f0-ad22-47df-a757-093953c3e882";
const ACCEPTED_FILE_TYPES = ".csv,.xls,.xlsx";

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

function parseMemberPreviewRows(rawRows) {
  return rawRows
    .map((rawRow) => {
      const row = Object.fromEntries(
        Object.entries(rawRow).map(([key, value]) => [
          String(key).trim().toLowerCase().replace(/\s+/g, "_"),
          value,
        ]),
      );

      const full_name =
        row.full_name || row.name || row.member_name || row["full_name_(required)"] || "";

      if (!String(full_name).trim()) {
        return null;
      }

      return {
        full_name: String(full_name).trim(),
        email: row.email || row.email_address || "",
        phone: row.phone || row.phone_number || "",
        role: row.role || row.member_role || "volunteer",
        credentials: row.credentials || row.license || row.license_number || "",
      };
    })
    .filter(Boolean);
}

function MemberUploadPanel({ onImportComplete }) {
  const [isDragActive, setIsDragActive] = useState(false);
  const [selectedFile, setSelectedFile] = useState(null);
  const [previewRows, setPreviewRows] = useState([]);
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
    const normalizedRows = parseMemberPreviewRows(rows);
    setPreviewRows(normalizedRows);
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
        setPreviewRows([]);
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

  const handleUpload = async () => {
    if (!selectedFile) {
      setUploadError("Please choose a CSV or Excel file first.");
      return;
    }

    const formData = new FormData();
    formData.append("organization_id", FVMA_ORGANIZATION_ID);
    formData.append("file", selectedFile);

    setIsUploading(true);
    setUploadError("");
    setUploadMessage("");

    try {
      const response = await fetch(`${API_BASE_URL}/api/members/import`, {
        method: "POST",
        body: formData,
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "Import failed.");
      }

      setUploadMessage(
        `Import complete: ${payload.importedRows} member(s) saved. Skipped ${payload.skippedRows.length} row(s).`,
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

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={handleUpload}
            disabled={!selectedFile || isUploading}
            className="rounded-md bg-teal-700 px-4 py-2 text-sm font-medium text-white hover:bg-teal-800 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            {isUploading ? "Uploading..." : "Save Members to Database"}
          </button>
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
                <th className="px-4 py-2 font-semibold text-slate-700">Name</th>
                <th className="px-4 py-2 font-semibold text-slate-700">Role</th>
                <th className="px-4 py-2 font-semibold text-slate-700">Email</th>
                <th className="px-4 py-2 font-semibold text-slate-700">Phone</th>
                <th className="px-4 py-2 font-semibold text-slate-700">Credentials</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {previewRows.slice(0, 20).map((row, index) => (
                <tr key={`${row.full_name}-${index}`}>
                  <td className="px-4 py-2 text-slate-900">{row.full_name}</td>
                  <td className="px-4 py-2 text-slate-700">{row.role || "-"}</td>
                  <td className="px-4 py-2 text-slate-700">{row.email || "-"}</td>
                  <td className="px-4 py-2 text-slate-700">{row.phone || "-"}</td>
                  <td className="px-4 py-2 text-slate-700">{row.credentials || "-"}</td>
                </tr>
              ))}
              {!previewRows.length ? (
                <tr>
                  <td colSpan={5} className="px-4 py-5 text-center text-slate-500">
                    Upload a file to preview members before saving.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        {previewRows.length > 20 ? (
          <p className="text-xs text-slate-500">
            Showing first 20 rows of {previewRows.length} parsed members.
          </p>
        ) : null}
      </div>
    </section>
  );
}

function Dashboard() {
  const [organization, setOrganization] = useState(null);
  const [members, setMembers] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");

  const loadDashboard = useCallback(async () => {
    setIsLoading(true);
    setError("");

    try {
      const [orgData, membersData] = await Promise.all([
        fetchJson(`${API_BASE_URL}/api/organizations/${FVMA_ORGANIZATION_ID}`),
        fetchJson(
          `${API_BASE_URL}/api/members?organization_id=${FVMA_ORGANIZATION_ID}`,
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
            Make sure the backend is running on <code>http://localhost:3001</code>.
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
      <MemberUploadPanel onImportComplete={loadDashboard} />
    </main>
  );
}

function App() {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4">
          <h1 className="text-lg font-semibold tracking-tight text-slate-800">
            FVMA Disaster Response
          </h1>
          <p className="text-sm text-slate-500">Florida Veterinary Medical Association</p>
        </div>
      </header>
      <Dashboard />
    </div>
  );
}

export default App;
