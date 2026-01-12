import type { DefineAPI, DefineEvents, SDK } from "caido:plugin";
import {
  Body,
  type Cursor,
  type ID,
  type Request,
  type RequestsConnection,
  type Response,
} from "caido:utils";

export type Result<T> =
  | { kind: "Ok"; value: T }
  | { kind: "Error"; error: string };

export type ExportOptions = {
  includeExecuted: boolean;
  includeUnused: boolean;
  includeSecurity: boolean;
  includeFullDetails: boolean;
};

export type ActionEntry = {
  id: number;
  requestId: ID;
  method: string;
  url: string;
  actionId: string;
  parameters: string;
  requestSize: number;
  responseSize: number;
  statusCode: number;
  timestamp: string;
  securityNotes: string;
  actionNotes: string;
};

export type DiscoveredAction = {
  actionId: string;
  functionName: string;
  status: string;
  chunkFile: string;
  executedCount: number;
  notes: string;
};

export type DiscoveryResult = {
  status: string;
  all: DiscoveredAction[];
  unused: DiscoveredAction[];
  unknown: DiscoveredAction[];
};

export type BackendEvents = DefineEvents<{
  "nextjs-actions.status": (status: string) => void;
  "nextjs-actions.action-added": (entry: ActionEntry) => void;
  "nextjs-actions.data-changed": () => void;
}>;

type DiscoveredActionInternal = {
  actionId: string;
  functionName: string;
  chunkFile: string;
  firstSeen: string;
  chunkRequestId: ID;
};

type ActionUsage = {
  timestamp: string;
  url: string;
  method: string;
  statusCode: number;
  parameters: string;
  securityNotes: string;
  requestId: ID;
};

let actions: ActionEntry[] = [];
const actionNotesById: Record<string, string> = {};
const actionNamesById: Record<string, string> = {};
let discoveredActionsById: Record<string, DiscoveredActionInternal> = {};
let actionUsagesById: Record<string, ActionUsage[]> = {};
let seenRequestIds = new Set<string>();

const sendStatus = (sdk: SDK<API, BackendEvents>, status: string) => {
  sdk.api.send("nextjs-actions.status", status);
};

const nowIso = () => new Date().toISOString();

const isNextChunkRequest = (request: Request): boolean => {
  const path = request.getPath();
  if (!path.includes("/_next/static/chunks/")) return false;

  const base = path.split("?")[0];
  return base !== undefined && base.endsWith(".js");
};

const getNextActionIdFromRequest = (request: Request): string | undefined => {
  const values = request.getHeader("Next-Action");
  const value = values?.[0];
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed !== "" ? trimmed : undefined;
};

const getTextBody = (body: Body | undefined): string => {
  if (body === undefined) return "";
  return body.toText();
};

const safeJsonParse = (text: string): unknown => {
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

const analyzeSecurity = (
  request: Request,
  response: Response,
  actionId: string,
  parameters: string,
): string => {
  const notes: string[] = [];

  const headerKeys = Object.keys(request.getHeaders()).map((h) =>
    h.toLowerCase(),
  );
  const hasAuth =
    headerKeys.includes("authorization") || headerKeys.includes("cookie");
  if (!hasAuth) {
    notes.push("No auth headers");
  }

  const dangerousParams = [
    "id",
    "userId",
    "user_id",
    "role",
    "admin",
    "delete",
    "update",
    "team",
    "teamId",
  ];

  const lowerParams = parameters.toLowerCase();
  for (const danger of dangerousParams) {
    if (lowerParams.includes(danger.toLowerCase())) {
      notes.push(`Contains: ${danger}`);
    }
  }

  const bodyJson = safeJsonParse(parameters);
  if (Array.isArray(bodyJson) && bodyJson.length > 1) {
    for (const element of bodyJson.slice(1)) {
      if (
        element === null ||
        typeof element !== "object" ||
        Array.isArray(element)
      ) {
        continue;
      }
      for (const [key, value] of Object.entries(element)) {
        if (!key.toLowerCase().includes("id")) continue;
        if (typeof value === "number" && Number.isInteger(value)) {
          notes.push(`Direct ID: ${key}=${value}`);
        } else if (typeof value === "string" && /^\d+$/.test(value)) {
          notes.push(`Direct ID: ${key}=${value}`);
        }
      }
    }
  }

  const responseBody = getTextBody(response.getBody());
  const responseLower = responseBody.toLowerCase();

  if (
    responseLower.includes("development") ||
    responseBody.includes("__NEXT_DATA__")
  ) {
    notes.push("Dev mode indicators");
  }

  const errorPatterns: RegExp[] = [
    /"error"\s*:\s*"[^"]+/i,
    /"error"\s*:\s*\{/i,
    /"error"\s*:\s*\[/i,
    /exception/i,
    /stack\s*trace/i,
    /stacktrace/i,
    /at\s+\w+\.\w+\(/i,
    /File\s+"[^"]+",\s+line\s+\d+/i,
    /(TypeError:|ReferenceError:|SyntaxError:)/i,
    /undefined method/i,
    /Call to undefined function/i,
  ];

  if (errorPatterns.some((p) => p.test(responseBody))) {
    notes.push("Error in response");
  }

  if (
    ["mssql", "postgres", "mysql", "database error"].some((s) =>
      responseLower.includes(s),
    )
  ) {
    notes.push("DB mention");
  }

  const origin = request.getHeader("Origin")?.[0]?.trim();
  const host = request.getHeader("Host")?.[0]?.trim();
  if (
    origin !== undefined &&
    origin !== "" &&
    host !== undefined &&
    host !== ""
  ) {
    const originHost = origin.replace(/^https?:\/\//, "").split("/")[0] ?? "";
    if (originHost !== "" && originHost !== host) {
      notes.push("Origin/Host mismatch");
    }
  }

  const reusedCount = actionUsagesById[actionId]?.length ?? 0;
  if (reusedCount > 10) {
    notes.push(`Action reused ${reusedCount}x`);
  }

  if (parameters.includes(".bind(")) {
    notes.push("Potential .bind() usage");
  }

  if (request.getMethod().toUpperCase() !== "POST") {
    notes.push("Non-POST action");
  }

  return notes.join("; ");
};

const ensureActionNotes = (actionId: string) => {
  const existing = actionNotesById[actionId];
  const functionName = actionNamesById[actionId];
  if (functionName === undefined) return existing ?? "";

  const prefix = `Function: ${functionName}`;
  if (existing === undefined) {
    actionNotesById[actionId] = prefix;
    return prefix;
  }

  if (existing.includes(prefix)) {
    return existing;
  }

  const updated = `${prefix}\n${existing}`;
  actionNotesById[actionId] = updated;
  return updated;
};

const addActionEntry = (
  sdk: SDK<API, BackendEvents>,
  request: Request,
  response: Response,
  actionId: string,
) => {
  const requestId = request.getId();
  if (seenRequestIds.has(requestId)) return;
  seenRequestIds.add(requestId);

  const parameters = getTextBody(request.getBody());

  const requestSize = request.getRaw().toBytes().length;
  const responseSize = response.getRaw().toBytes().length;
  const statusCode = response.getCode();

  const timestamp = response.getCreatedAt().toISOString();
  const securityNotes = analyzeSecurity(
    request,
    response,
    actionId,
    parameters,
  );
  const actionNotes = ensureActionNotes(actionId);

  const entry: ActionEntry = {
    id: actions.length + 1,
    requestId,
    method: request.getMethod(),
    url: request.getUrl(),
    actionId,
    parameters,
    requestSize,
    responseSize,
    statusCode,
    timestamp,
    securityNotes,
    actionNotes,
  };

  actions = [...actions, entry];

  if (!actionUsagesById[actionId]) {
    actionUsagesById[actionId] = [];
  }

  actionUsagesById[actionId] = [
    ...actionUsagesById[actionId],
    {
      timestamp,
      url: entry.url,
      method: entry.method,
      statusCode,
      parameters,
      securityNotes,
      requestId,
    },
  ];

  sdk.api.send("nextjs-actions.action-added", entry);
};

const processRequestResponse = (
  sdk: SDK<API, BackendEvents>,
  request: Request,
  response: Response | undefined,
) => {
  if (response === undefined) return;

  const actionId = getNextActionIdFromRequest(request);
  if (actionId === undefined) return;

  addActionEntry(sdk, request, response, actionId);
};

const paginateAllRequests = async (
  sdk: SDK<API, BackendEvents>,
  onPage: (page: RequestsConnection) => void | Promise<void>,
): Promise<void> => {
  let cursor: Cursor | undefined = undefined;

  for (;;) {
    const query = sdk.requests.query().first(200);
    const page: RequestsConnection = cursor
      ? await query.after(cursor).execute()
      : await query.execute();

    await onPage(page);

    if (!page.pageInfo.hasNextPage) return;
    cursor = page.pageInfo.endCursor;
  }
};

const scanProxyHistory = async (
  sdk: SDK<API, BackendEvents>,
): Promise<Result<{ scanned: number; found: number }>> => {
  try {
    let scanned = 0;
    let found = 0;

    sendStatus(sdk, "Scanning requests...");

    await paginateAllRequests(sdk, (page) => {
      for (const item of page.items) {
        scanned += 1;
        processRequestResponse(sdk, item.request, item.response);

        const actionId = getNextActionIdFromRequest(item.request);
        if (actionId !== undefined) {
          found += 1;
        }
      }

      sendStatus(sdk, `Scanning requests... ${scanned}`);
    });

    sendStatus(sdk, `Scanned ${scanned} requests (${found} actions)`);
    sdk.api.send("nextjs-actions.data-changed");

    return { kind: "Ok", value: { scanned, found } };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    sendStatus(sdk, "Scan failed");
    return { kind: "Error", error: message };
  }
};

const extractActionNames = async (
  sdk: SDK<API, BackendEvents>,
): Promise<Result<{ scannedChunks: number; namesExtracted: number }>> => {
  try {
    let scannedChunks = 0;
    let namesExtracted = 0;

    const patterns: RegExp[] = [
      /createServerReference\)\s*\(\s*["']([a-fA-F0-9]{40,})["']\s*,\s*\w+\.callServer\s*,\s*void\s+0\s*,\s*\w+\.findSourceMapURL\s*,\s*["']([^"']+)["']\s*\)/g,
      /\(\d+\s*,\s*\w+\.createServerReference\)\s*\(\s*["']([a-fA-F0-9]{40,})["']\s*,\s*\w+\.callServer\s*,\s*void\s+0\s*,\s*\w+\.findSourceMapURL\s*,\s*["']([^"']+)["']\s*\)/g,
      /createServerReference\)\(\s*["']([a-fA-F0-9]{40,})["']\s*,\s*\w+\.callServer\s*,\s*void\s+0\s*,\s*\w+\.findSourceMapURL\s*,\s*["']([^"']+)["']\s*\)/g,
      /\(\d+\s*,\s*\w+\.createServerReference\)\s*\(\s*["']([a-fA-F0-9]{40,})["'](?:[^"']*?,){4}\s*["']([^"']+)["']\s*\)/g,
    ];

    sendStatus(sdk, "Scanning chunk files...");

    await paginateAllRequests(sdk, (page) => {
      for (const item of page.items) {
        const { request, response } = item;
        if (!response) continue;
        if (!isNextChunkRequest(request)) continue;

        const body = getTextBody(response.getBody());
        if (!body.includes("createServerReference")) continue;

        scannedChunks += 1;

        for (const pattern of patterns) {
          for (const match of body.matchAll(pattern)) {
            const actionId = match[1];
            const functionName = match[2];
            if (actionId === undefined || actionId === "") continue;
            if (functionName === undefined || functionName === "") continue;

            if (functionName.startsWith("$") || functionName.startsWith("_"))
              continue;

            const existing = actionNamesById[actionId];
            if (existing === undefined) {
              actionNamesById[actionId] = functionName;
              namesExtracted += 1;
            }
          }
        }
      }

      sendStatus(sdk, `Scanning chunk files... ${scannedChunks}`);
    });

    for (const actionId of Object.keys(actionNamesById)) {
      ensureActionNotes(actionId);
    }

    actions = actions.map((a) => {
      const notes = actionNotesById[a.actionId];
      if (notes === undefined) return a;
      return { ...a, actionNotes: notes };
    });

    sdk.api.send("nextjs-actions.data-changed");
    sendStatus(
      sdk,
      `Extracted ${namesExtracted} action names (${scannedChunks} chunks scanned)`,
    );

    return { kind: "Ok", value: { scannedChunks, namesExtracted } };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    sendStatus(sdk, "Action name extraction failed");
    return { kind: "Error", error: message };
  }
};

const findAllActions = async (
  sdk: SDK<API, BackendEvents>,
): Promise<Result<DiscoveryResult>> => {
  try {
    discoveredActionsById = {};

    const patterns: RegExp[] = [
      /createServerReference\)\("([a-f0-9]{40,})",\w+\.callServer,void 0,\w+\.findSourceMapURL,"([^"]+)"\)/g,
      /\(\d+,\s*\w+\.createServerReference\)\s*\(\s*"([a-f0-9]{40,})",\s*\w+\.callServer,\s*void\s+0,\s*\w+\.findSourceMapURL,\s*"([^"]+)"\s*\)/g,
      /createServerReference\)\s*\(\s*"([a-f0-9]{40,})",\s*\w+\.callServer,\s*void\s+0,\s*\w+\.findSourceMapURL,\s*"([^"]+)"\s*\)/g,
      /createServerReference[^"]*"([a-f0-9]{40,})"[^"]*"([^"]+)"\s*\)/g,
    ];

    let chunksFound = 0;

    sendStatus(sdk, "Scanning chunks for server actions...");

    await paginateAllRequests(sdk, (page) => {
      for (const item of page.items) {
        const { request, response } = item;
        if (!response) continue;
        if (!isNextChunkRequest(request)) continue;

        const body = getTextBody(response.getBody());
        if (!body.includes("createServerReference")) continue;

        chunksFound += 1;

        const chunkFile = request.getPath().split("/").pop() ?? "Unknown";

        for (const pattern of patterns) {
          for (const match of body.matchAll(pattern)) {
            const actionId = match[1];
            const functionName = match[2];
            if (actionId === undefined || actionId === "") continue;
            if (functionName === undefined || functionName === "") continue;

            if (functionName.startsWith("$") || functionName.startsWith("_"))
              continue;

            const existing = discoveredActionsById[actionId];
            if (existing !== undefined) continue;

            const firstSeen = nowIso();
            discoveredActionsById[actionId] = {
              actionId,
              functionName,
              chunkFile,
              firstSeen,
              chunkRequestId: request.getId(),
            };

            const existingName = actionNamesById[actionId];
            if (existingName === undefined) {
              actionNamesById[actionId] = functionName;
              ensureActionNotes(actionId);
            }
          }
        }
      }

      sendStatus(sdk, `Scanning chunks... ${chunksFound}`);
    });

    const executedActionIds = new Set(actions.map((a) => a.actionId));
    const executedFunctionNames = new Set(
      [...executedActionIds]
        .map((id) => actionNamesById[id])
        .filter((v): v is string => Boolean(v)),
    );

    const allRows: DiscoveredAction[] = [];
    const unusedRows: DiscoveredAction[] = [];

    for (const discovered of Object.values(discoveredActionsById)) {
      const executedCount = actionUsagesById[discovered.actionId]?.length ?? 0;
      const notes = actionNotesById[discovered.actionId] ?? "";

      let status = "Unused";
      if (executedActionIds.has(discovered.actionId)) {
        status = "Executed";
      } else if (executedFunctionNames.has(discovered.functionName)) {
        status = "Unused (Function executed with different ID)";
      } else {
        status = "Never Executed";
      }

      const row: DiscoveredAction = {
        actionId: discovered.actionId,
        functionName: discovered.functionName,
        status,
        chunkFile: discovered.chunkFile,
        executedCount,
        notes,
      };

      allRows.push(row);
      if (status === "Never Executed") {
        unusedRows.push(row);
      }
    }

    const unknownRows: DiscoveredAction[] = [];
    for (const executedId of executedActionIds) {
      if (discoveredActionsById[executedId]) continue;
      unknownRows.push({
        actionId: executedId,
        functionName: actionNamesById[executedId] ?? "Unknown",
        status: "Executed (No source found)",
        chunkFile: "Not found",
        executedCount: actionUsagesById[executedId]?.length ?? 0,
        notes: actionNotesById[executedId] ?? "",
      });
    }

    const status = `Found ${allRows.length} actions (${unusedRows.length} unused)`;
    sendStatus(sdk, status);

    sdk.api.send("nextjs-actions.data-changed");

    return {
      kind: "Ok",
      value: {
        status,
        all: allRows,
        unused: unusedRows,
        unknown: unknownRows,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    sendStatus(sdk, "Discovery failed");
    return { kind: "Error", error: message };
  }
};

const getActions = (): ActionEntry[] => {
  return actions;
};

const getChunkRequestIdForAction = (
  _sdk: SDK<API, BackendEvents>,
  actionId: string,
): Result<{ requestId: ID }> => {
  const discovered = discoveredActionsById[actionId];
  if (!discovered) {
    return { kind: "Error", error: "No chunk request found for action" };
  }

  return { kind: "Ok", value: { requestId: discovered.chunkRequestId } };
};

const getDiscovery = (): DiscoveryResult => {
  const executedActionIds = new Set(actions.map((a) => a.actionId));
  const executedFunctionNames = new Set(
    [...executedActionIds]
      .map((id) => actionNamesById[id])
      .filter((v): v is string => Boolean(v)),
  );

  const all: DiscoveredAction[] = [];
  const unused: DiscoveredAction[] = [];
  const unknown: DiscoveredAction[] = [];

  for (const discovered of Object.values(discoveredActionsById)) {
    const executedCount = actionUsagesById[discovered.actionId]?.length ?? 0;
    const notes = actionNotesById[discovered.actionId] ?? "";

    let status = "Unused";
    if (executedActionIds.has(discovered.actionId)) {
      status = "Executed";
    } else if (executedFunctionNames.has(discovered.functionName)) {
      status = "Unused (Function executed with different ID)";
    } else {
      status = "Never Executed";
    }

    const row: DiscoveredAction = {
      actionId: discovered.actionId,
      functionName: discovered.functionName,
      status,
      chunkFile: discovered.chunkFile,
      executedCount,
      notes,
    };

    all.push(row);
    if (status === "Never Executed") {
      unused.push(row);
    }
  }

  for (const executedId of executedActionIds) {
    if (discoveredActionsById[executedId]) continue;
    unknown.push({
      actionId: executedId,
      functionName: actionNamesById[executedId] ?? "Unknown",
      status: "Executed (No source found)",
      chunkFile: "Not found",
      executedCount: actionUsagesById[executedId]?.length ?? 0,
      notes: actionNotesById[executedId] ?? "",
    });
  }

  return {
    status: "",
    all,
    unused,
    unknown,
  };
};

const clearAll = (sdk: SDK<API, BackendEvents>): void => {
  actions = [];
  actionUsagesById = {};
  seenRequestIds = new Set<string>();
  sendStatus(sdk, "Cleared");
  sdk.api.send("nextjs-actions.data-changed");
};

const setActionNote = (
  sdk: SDK<API, BackendEvents>,
  actionId: string,
  note: string,
): void => {
  actionNotesById[actionId] = note;

  actions = actions.map((a) => {
    if (a.actionId !== actionId) return a;
    return { ...a, actionNotes: note };
  });

  sdk.api.send("nextjs-actions.data-changed");
};

const getRequestResponseRaw = async (
  sdk: SDK<API, BackendEvents>,
  requestId: ID,
): Promise<Result<{ requestRaw: string; responseRaw: string }>> => {
  try {
    const pair = await sdk.requests.get(requestId);
    if (!pair || !pair.response) {
      return { kind: "Error", error: "Request/response not found" };
    }

    return {
      kind: "Ok",
      value: {
        requestRaw: pair.request.getRaw().toText(),
        responseRaw: pair.response.getRaw().toText(),
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return { kind: "Error", error: message };
  }
};

const analyzeRequestsById = async (
  sdk: SDK<API, BackendEvents>,
  requestIds: ID[],
): Promise<Result<{ analyzed: number; found: number }>> => {
  try {
    let analyzed = 0;
    let found = 0;

    for (const id of requestIds) {
      const pair = await sdk.requests.get(id);
      analyzed += 1;
      if (!pair || !pair.response) continue;

      const actionId = getNextActionIdFromRequest(pair.request);
      if (actionId === undefined) continue;

      found += 1;
      addActionEntry(sdk, pair.request, pair.response, actionId);
    }

    sdk.api.send("nextjs-actions.data-changed");

    return { kind: "Ok", value: { analyzed, found } };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return { kind: "Error", error: message };
  }
};

const lookupActionForRequest = async (
  sdk: SDK<API, BackendEvents>,
  requestId: ID,
): Promise<Result<{ actionId: string; functionName: string }>> => {
  try {
    const pair = await sdk.requests.get(requestId);
    if (!pair) return { kind: "Error", error: "Request not found" };

    const actionId = getNextActionIdFromRequest(pair.request);
    if (actionId === undefined) {
      return { kind: "Error", error: "No Next-Action header" };
    }

    const functionName = actionNamesById[actionId] ?? "Unknown";
    return { kind: "Ok", value: { actionId, functionName } };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return { kind: "Error", error: message };
  }
};

const createReplaySessionFromRequest = async (
  sdk: SDK<API, BackendEvents>,
  requestId: ID,
): Promise<Result<{ sessionId: ID }>> => {
  try {
    const session = await sdk.replay.createSession(requestId);
    return { kind: "Ok", value: { sessionId: session.getId() } };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return { kind: "Error", error: message };
  }
};

const createTestReplayForAction = async (
  sdk: SDK<API, BackendEvents>,
  actionId: string,
): Promise<Result<{ sessionId: ID }>> => {
  try {
    const lastUsage = actionUsagesById[actionId]?.at(-1) ?? undefined;

    const templateUsage =
      lastUsage ??
      actions
        .slice()
        .reverse()
        .map((a) => ({ requestId: a.requestId }))
        .find((v) => v !== undefined);

    if (!templateUsage) {
      return { kind: "Error", error: "No template request available" };
    }

    const pair = await sdk.requests.get(templateUsage.requestId);
    if (!pair) {
      return { kind: "Error", error: "Template request not found" };
    }

    const spec = pair.request.toSpec();
    spec.setHeader("Next-Action", actionId);

    const bodyText = getTextBody(spec.getBody());
    const json = safeJsonParse(bodyText);
    if (Array.isArray(json) && json.length > 0) {
      const updated = [...json];
      updated[0] = actionId;
      spec.setBody(new Body(JSON.stringify(updated)), {
        updateContentLength: true,
      });
    }

    const session = await sdk.replay.createSession(spec);
    return { kind: "Ok", value: { sessionId: session.getId() } };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return { kind: "Error", error: message };
  }
};

const exportAnalysis = (
  sdk: SDK<API, BackendEvents>,
  options: ExportOptions,
): Result<{ json: string; filename: string }> => {
  try {
    const exportTime = nowIso();

    const executedActionIds = new Set(actions.map((a) => a.actionId));
    const executedFunctionNames = new Set(
      [...executedActionIds]
        .map((id) => actionNamesById[id])
        .filter((v): v is string => Boolean(v)),
    );

    const unusedActions: Record<string, unknown> = {};
    if (options.includeUnused) {
      for (const [id, info] of Object.entries(discoveredActionsById)) {
        if (executedFunctionNames.has(info.functionName)) continue;
        unusedActions[id] = {
          functionName: info.functionName,
          chunkFile: info.chunkFile,
          discoveryTime: info.firstSeen,
          status: "Never Executed",
        };
      }
    }

    const actionSummary: Record<string, unknown> = {};
    if (options.includeExecuted) {
      for (const [actionId, usages] of Object.entries(actionUsagesById)) {
        const endpoints = [...new Set(usages.map((u) => u.url))];
        const methods = [...new Set(usages.map((u) => u.method))];
        const statusCodes = [...new Set(usages.map((u) => u.statusCode))];

        const paramKeys = new Set<string>();
        for (const usage of usages) {
          const parsed = safeJsonParse(usage.parameters);
          if (
            parsed !== undefined &&
            parsed !== null &&
            typeof parsed === "object" &&
            !Array.isArray(parsed)
          ) {
            for (const key of Object.keys(parsed)) {
              paramKeys.add(key);
            }
          }
        }

        const summary: Record<string, unknown> = {
          functionName: actionNamesById[actionId] ?? "Unknown",
          count: usages.length,
          endpoints,
          methods,
          statusCodes,
          parameters: [...paramKeys],
          securityNotes: [
            ...new Set(usages.map((u) => u.securityNotes).filter((v) => v)),
          ],
          userNotes: actionNotesById[actionId] ?? "",
        };

        if (options.includeFullDetails) {
          summary.requests = usages.slice(0, 5).map((u) => ({
            timestamp: u.timestamp,
            url: u.url,
            method: u.method,
            statusCode: u.statusCode,
            parameters: u.parameters,
            requestId: u.requestId,
          }));
        }

        actionSummary[actionId] = summary;
      }
    }

    const payload = {
      exportTime,
      exportInfo: {
        description: "Next.js Server Actions Security Analysis",
        totalRequests: actions.length,
        uniqueActions: executedActionIds.size,
        totalDiscovered: Object.keys(discoveredActionsById).length,
        options,
      },
      actionSummary,
      unusedActions,
      notesByActionId: actionNotesById,
    };

    const json = JSON.stringify(payload, undefined, 2);
    const filename = `nextjs_actions_${exportTime.replace(/[:.]/g, "-")}.json`;

    return { kind: "Ok", value: { json, filename } };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return { kind: "Error", error: message };
  }
};

export type API = DefineAPI<{
  getActions: typeof getActions;
  getDiscovery: typeof getDiscovery;
  getChunkRequestIdForAction: typeof getChunkRequestIdForAction;
  clearAll: typeof clearAll;
  setActionNote: typeof setActionNote;
  scanProxyHistory: typeof scanProxyHistory;
  analyzeRequestsById: typeof analyzeRequestsById;
  extractActionNames: typeof extractActionNames;
  findAllActions: typeof findAllActions;
  getRequestResponseRaw: typeof getRequestResponseRaw;
  lookupActionForRequest: typeof lookupActionForRequest;
  createReplaySessionFromRequest: typeof createReplaySessionFromRequest;
  createTestReplayForAction: typeof createTestReplayForAction;
  exportAnalysis: typeof exportAnalysis;
}>;

export function init(sdk: SDK<API, BackendEvents>) {
  sdk.api.register("getActions", getActions);
  sdk.api.register("getDiscovery", getDiscovery);
  sdk.api.register("getChunkRequestIdForAction", getChunkRequestIdForAction);
  sdk.api.register("clearAll", clearAll);
  sdk.api.register("setActionNote", setActionNote);
  sdk.api.register("scanProxyHistory", scanProxyHistory);
  sdk.api.register("analyzeRequestsById", analyzeRequestsById);
  sdk.api.register("extractActionNames", extractActionNames);
  sdk.api.register("findAllActions", findAllActions);
  sdk.api.register("getRequestResponseRaw", getRequestResponseRaw);
  sdk.api.register("lookupActionForRequest", lookupActionForRequest);
  sdk.api.register(
    "createReplaySessionFromRequest",
    createReplaySessionFromRequest,
  );
  sdk.api.register("createTestReplayForAction", createTestReplayForAction);
  sdk.api.register("exportAnalysis", exportAnalysis);

  sdk.events.onInterceptResponse((s, request, response) => {
    processRequestResponse(s, request, response);

    const actionId = getNextActionIdFromRequest(request);
    if (actionId === undefined) return;

    const securityNotes = analyzeSecurity(
      request,
      response,
      actionId,
      getTextBody(request.getBody()),
    );
    if (!securityNotes.includes("No auth headers")) return;

    void s.findings.create({
      title: `Next.js Server Action without auth: ${actionId.slice(0, 8)}`,
      description: securityNotes,
      reporter: "Next.js Actions Analyzer",
      dedupeKey: `${request.getHost()}-${request.getPath()}-${actionId}`,
      request,
    });
  });

  sendStatus(sdk, "Ready");
}
