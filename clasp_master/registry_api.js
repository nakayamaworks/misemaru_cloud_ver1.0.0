/**
 * registry_api.gs (clasp_master)
 * 店舗レジストリ管理専用 GAS
 *
 * - Spreadsheet への読み書きをこのプロジェクトに集約し、
 *   各テナント (clasp) からは Web API 経由で参照／更新する。
 *
 * ❗ 必要に応じて Script Properties に以下を設定してください。
 *   - REGISTRY_SPREADSHEET_ID : レジストリを保持するスプレッドシート ID
 *   - REGISTRY_SHEET_NAME     : 任意（未設定時は候補名から自動探索）
 */

const REGISTRY_BOOL_TRUE = new Set(["1", "true", "yes", "y", "ok", "verified", "公開", "有効", "enabled"]);

const REGISTRY_SHEET_NAME_CANDIDATES = [
  "店舗レジストリ",
  "StoreRegistry",
];

const STORE_REGISTRY_COLS = {
  GAS_ID:     ["GAS ID", "GasId", "gasId", "TenantID"],
  ID:         ["ID", "Id", "alias", "Alias", "FriendlyId", "friendlyId"],
  STORE_NAME: ["店舗名", "StoreName", "Name"],
  COUNTRY:    ["国", "Country", "Region"],
  SERVICES:   ["提供サービス", "Services", "ServiceList"],
  TAGS:       ["タグ", "Tags"],
  STATUS:     ["ステータス", "Status"],
  VERIFIED:   ["認証済み", "Verified", "Published", "公開"],
  IFRAME_URL: ["Iframe URL", "IframeUrl", "EmbedUrl"],
  PUBLIC_URL: ["公開URL", "PublicUrl", "PortalUrl"],
  UPDATED_AT: ["最終更新", "UpdatedAt", "LastUpdated"],
};

function getRegistrySpreadsheetId() {
  const id = PropertiesService.getScriptProperties().getProperty("REGISTRY_SPREADSHEET_ID");
  if (id) return id;
  throw new Error("REGISTRY_SPREADSHEET_ID が Script Properties に設定されていません");
}

function getRegistrySheet() {
  const ss = SpreadsheetApp.openById(getRegistrySpreadsheetId());
  const explicitName = PropertiesService.getScriptProperties().getProperty("REGISTRY_SHEET_NAME");
  if (explicitName) {
    const sh = ss.getSheetByName(explicitName);
    if (!sh) throw new Error(`レジストリシートが見つかりません: ${explicitName}`);
    return sh;
  }
  for (const name of REGISTRY_SHEET_NAME_CANDIDATES) {
    const sh = ss.getSheetByName(name);
    if (sh) return sh;
  }
  throw new Error("レジストリシートが見つかりません（候補: " + REGISTRY_SHEET_NAME_CANDIDATES.join(", ") + "）");
}

function readRegistryRows() {
  const sheet = getRegistrySheet();
  const values = sheet.getDataRange().getValues();
  if (!values.length) return [];
  const headers = values[0].map((cell) => String(cell || "").trim());
  const colIndex = buildColIndex(headers, STORE_REGISTRY_COLS);
  const baseUrl = ScriptApp.getService().getUrl() || "";
  return values.slice(1)
    .map((row) => normalizeRegistryRow(row, colIndex, baseUrl))
    .filter((row) => !!row);
}

function pickCell(row, idx) {
  if (idx == null || idx < 0) return "";
  return String(row[idx] ?? "").trim();
}

function buildColIndex(headers, definition) {
  const map = {};
  Object.entries(definition).forEach(([key, aliases]) => {
    map[key] = headers.findIndex((header) => aliases.includes(String(header || "").trim()));
  });
  return map;
}

function parseBool(value) {
  if (typeof value === "boolean") return value;
  const text = String(value || "").trim().toLowerCase();
  if (!text) return false;
  return REGISTRY_BOOL_TRUE.has(text);
}

function normalizeRegistryRow(row, COL, baseUrl) {
  const gasId = pickCell(row, COL.GAS_ID);
  if (!gasId) return null;

  const fallbackUrl = baseUrl ? `${baseUrl}?page=31_index` : "";
  return {
    gasId,
    ID: pickCell(row, COL.ID),
    storeName: pickCell(row, COL.STORE_NAME) || gasId,
    country: pickCell(row, COL.COUNTRY),
    services: splitMultiValue(pickCell(row, COL.SERVICES)),
    tags: splitMultiValue(pickCell(row, COL.TAGS)),
    status: String(pickCell(row, COL.STATUS) || "").toLowerCase(),
    verified: parseBool(pickCell(row, COL.VERIFIED)),
    iframeUrl: pickCell(row, COL.IFRAME_URL) || fallbackUrl,
    publicUrl: pickCell(row, COL.PUBLIC_URL) || fallbackUrl,
    verifiedAt: pickCell(row, COL.UPDATED_AT),
  };
}

function splitMultiValue(text) {
  if (!text) return [];
  return String(text)
    .split(/[\n,／、;]/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function getRegistryEntryByGasId(gasId) {
  if (!gasId) return null;
  const needle = String(gasId).trim().toLowerCase();
  return readRegistryRows().find((entry) => entry.gasId.toLowerCase() === needle) || null;
}

function getRegistryEntryByAlias(alias) {
  if (!alias) return null;
  const needle = String(alias).trim().toLowerCase();
  return readRegistryRows().find((entry) => {
    const candidates = [
      entry.ID,
      entry.id,
      entry.friendlyId,
      entry.alias,
      entry.storeId,
      entry.slug,
    ].filter(Boolean).map((v) => String(v).trim().toLowerCase());
    return candidates.includes(needle);
  }) || null;
}

function formatListResponse(entries) {
  const updatedAt = entries
    .map((entry) => entry.verifiedAt)
    .find((value) => !!value) || "";
  return createJsonResponse({
    ok: true,
    stores: entries,
    updatedAt,
    source: "registry",
  });
}

function createJsonResponse(payload, statusCode) {
  const output = ContentService.createTextOutput(JSON.stringify(payload || {}))
    .setMimeType(ContentService.MimeType.JSON);
  if (typeof statusCode === "number") {
    output.setHeader("X-Status", String(statusCode));
  }
  return output;
}

function doGet(e) {
  const action = (e.parameter.action || "").trim();

  if (!action || action === "list") {
    try {
      const entries = readRegistryRows();
      return formatListResponse(entries);
    } catch (err) {
      console.error("[REGISTRY][list] error", err);
      return createJsonResponse({ ok: false, error: "server_error" }, 500);
    }
  }

  if (action === "lookup") {
    const gasId = (e.parameter.gasId || e.parameter.GasId || "").trim();
    const friendly = (e.parameter.id || e.parameter.ID || e.parameter.friendlyId || "").trim();
    try {
      let entry = null;
      if (gasId) entry = getRegistryEntryByGasId(gasId);
      if (!entry && friendly) entry = getRegistryEntryByAlias(friendly);
      if (!entry) {
        return createJsonResponse({ ok: false, error: "not_found" }, 404);
      }
      return createJsonResponse({ ok: true, store: entry, updatedAt: entry.verifiedAt || "", source: "registry" });
    } catch (err) {
      console.error("[REGISTRY][lookup] error", err);
      return createJsonResponse({ ok: false, error: "server_error" }, 500);
    }
  }

  return createJsonResponse({ ok: false, error: "unsupported_action" }, 400);
}

function doPost(e) {
  return createJsonResponse({ ok: false, error: "write_not_implemented" }, 405);
}
