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

  const fallbackUrl = gasId ? `https://script.google.com/macros/s/${gasId}/exec` : (baseUrl ? `${baseUrl}?page=31_index` : "");
  const fallbackIframeUrl = fallbackUrl ? `${fallbackUrl}?page=31_index` : "";
  return {
    gasId,
    ID: pickCell(row, COL.ID),
    storeName: pickCell(row, COL.STORE_NAME) || gasId,
    country: pickCell(row, COL.COUNTRY),
    services: splitMultiValue(pickCell(row, COL.SERVICES)),
    tags: splitMultiValue(pickCell(row, COL.TAGS)),
    status: String(pickCell(row, COL.STATUS) || "").toLowerCase(),
    verified: parseBool(pickCell(row, COL.VERIFIED)),
    iframeUrl: pickCell(row, COL.IFRAME_URL) || fallbackIframeUrl || fallbackUrl,
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

function makeResponse(payload, callbackName) {
  const json = JSON.stringify(payload || {});
  const useJsonp = callbackName && typeof callbackName === "string";
  const body = useJsonp ? `${callbackName}(${json});` : json;
  const mime = useJsonp
    ? ContentService.MimeType.JAVASCRIPT
    : ContentService.MimeType.JSON;

  // ✅ TextOutputにはsetHeaderが存在しないので削除
  return ContentService.createTextOutput(body).setMimeType(mime);
}

function doGet(e) {
  const params = e?.parameter || {};
  const action = (params.action || "list").trim();
  const callbackName = (params.callback || params.cb || "").trim();

  try {
    if (action === "lookup") {
      const gasId = (params.gasId || params.GasId || "").trim();
      const friendly = (params.id || params.ID || params.friendlyId || "").trim();
      const entry = gasId ? getRegistryEntryByGasId(gasId) : getRegistryEntryByAlias(friendly);
      if (!entry) {
        return makeResponse({ ok: false, error: "not_found" }, callbackName);
      }
      return makeResponse({ ok: true, store: entry, updatedAt: entry.verifiedAt || "", source: "registry" }, callbackName);
    }

    if (!action || action === "list") {
      const entries = readRegistryRows();
      const updatedAt = entries.find((r) => r.verifiedAt)?.verifiedAt || "";
      return makeResponse({ ok: true, stores: entries, updatedAt, source: "registry" }, callbackName);
    }

    return makeResponse({ ok: false, error: "unsupported_action" }, callbackName);
  } catch (err) {
    console.error("[REGISTRY] doGet error", err);
    return makeResponse({ ok: false, error: "server_error" }, callbackName);
  }
}

function doPost() {
  return makeResponse({ ok: false, error: "write_not_implemented" });
}

function doOptions() {
  return makeResponse({ ok: true });
}
