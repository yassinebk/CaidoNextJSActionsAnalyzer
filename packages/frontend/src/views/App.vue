<script setup lang="ts">
import type { ActionEntry, DiscoveryResult, ExportOptions } from "backend";
import Button from "primevue/button";
import InputText from "primevue/inputtext";
import Textarea from "primevue/textarea";
import { computed, onMounted, ref } from "vue";

import { useSDK } from "@/plugins/sdk";

const sdk = useSDK();

const status = ref("Ready");
const filterText = ref("");
const actions = ref<ActionEntry[]>([]);

const selectedActionId = ref<string | undefined>(undefined);
const selectedRequestId = ref<string | undefined>(undefined);

const reqEditor = sdk.ui.httpRequestEditor();
const respEditor = sdk.ui.httpResponseEditor();

const reqRoot = ref<HTMLElement | undefined>(undefined);
const respRoot = ref<HTMLElement | undefined>(undefined);

const actionNotes = ref("");

const discovery = ref<DiscoveryResult | undefined>(undefined);

const filteredActions = computed(() => {
  const q = filterText.value.trim().toLowerCase();
  if (!q) return actions.value;

  return actions.value.filter((a) => {
    return (
      a.url.toLowerCase().includes(q) ||
      a.actionId.toLowerCase().includes(q) ||
      a.parameters.toLowerCase().includes(q) ||
      a.securityNotes.toLowerCase().includes(q) ||
      a.actionNotes.toLowerCase().includes(q)
    );
  });
});

const refreshActions = async () => {
  actions.value = await sdk.backend.getActions();
};

const refreshDiscovery = async () => {
  discovery.value = await sdk.backend.getDiscovery();
};

const loadSelected = async () => {
  const requestId = selectedRequestId.value;
  if (requestId === undefined) return;

  const result = await sdk.backend.getRequestResponseRaw(requestId);
  if (result.kind === "Error") {
    sdk.window.showToast(result.error, { variant: "error" });
    return;
  }

  const reqView = reqEditor.getEditorView();
  reqView.dispatch({
    changes: {
      from: 0,
      to: reqView.state.doc.length,
      insert: result.value.requestRaw,
    },
  });

  const respView = respEditor.getEditorView();
  respView.dispatch({
    changes: {
      from: 0,
      to: respView.state.doc.length,
      insert: result.value.responseRaw,
    },
  });
};

const onRowClick = async (entry: ActionEntry) => {
  selectedRequestId.value = entry.requestId;
  selectedActionId.value = entry.actionId;
  actionNotes.value = entry.actionNotes;
  await loadSelected();
};

const copyActionId = async (actionId: string) => {
  try {
    await navigator.clipboard.writeText(actionId);
    sdk.window.showToast("Action ID copied", { variant: "success" });
  } catch {
    sdk.window.showToast(actionId, { variant: "info" });
  }
};

const openChunkForAction = async (actionId: string) => {
  const result = await sdk.backend.getChunkRequestIdForAction(actionId);
  if (result.kind === "Error") {
    sdk.window.showToast(result.error, { variant: "error" });
    return;
  }

  selectedRequestId.value = result.value.requestId;
  await loadSelected();
};

const createTestReplay = async (actionId: string) => {
  const result = await sdk.backend.createTestReplayForAction(actionId);
  if (result.kind === "Error") {
    sdk.window.showToast(result.error, { variant: "error" });
    return;
  }

  sdk.replay.openTab(result.value.sessionId);
  sdk.window.showToast("Replay session created", { variant: "success" });
};

const onSaveNotes = async () => {
  const actionId = selectedActionId.value;
  if (actionId === undefined) return;

  await sdk.backend.setActionNote(actionId, actionNotes.value);
  await refreshActions();
  await refreshDiscovery();

  sdk.window.showToast("Notes saved", { variant: "success" });
};

const onScanHistory = async () => {
  const result = await sdk.backend.scanProxyHistory();
  if (result.kind === "Error") {
    sdk.window.showToast(result.error, { variant: "error" });
    return;
  }

  await refreshActions();
  await refreshDiscovery();
};

const onExtractNames = async () => {
  const result = await sdk.backend.extractActionNames();
  if (result.kind === "Error") {
    sdk.window.showToast(result.error, { variant: "error" });
    return;
  }

  await refreshActions();
  await refreshDiscovery();
};

const onFindAllActions = async () => {
  const result = await sdk.backend.findAllActions();
  if (result.kind === "Error") {
    sdk.window.showToast(result.error, { variant: "error" });
    return;
  }

  discovery.value = result.value;
};

const onClear = async () => {
  await sdk.backend.clearAll();
  selectedRequestId.value = undefined;
  selectedActionId.value = undefined;
  actionNotes.value = "";
  await refreshActions();
  await refreshDiscovery();
};

const onExport = async () => {
  const options: ExportOptions = {
    includeExecuted: true,
    includeUnused: true,
    includeSecurity: true,
    includeFullDetails: false,
  };

  const result = await sdk.backend.exportAnalysis(options);
  if (result.kind === "Error") {
    sdk.window.showToast(result.error, { variant: "error" });
    return;
  }

  const file = new File([result.value.json], result.value.filename, {
    type: "application/json",
  });
  await sdk.files.create(file);

  sdk.window.showToast("Export created in Files", { variant: "success" });
};

onMounted(async () => {
  if (reqRoot.value) {
    const el = reqEditor.getElement();
    el.style.height = "100%";
    el.style.width = "100%";
    reqRoot.value.appendChild(el);
  }
  if (respRoot.value) {
    const el = respEditor.getElement();
    el.style.height = "100%";
    el.style.width = "100%";
    respRoot.value.appendChild(el);
  }

  await refreshActions();
  await refreshDiscovery();

  sdk.backend.onEvent("nextjs-actions.status", (s) => {
    status.value = s;
  });

  sdk.backend.onEvent("nextjs-actions.data-changed", async () => {
    await refreshActions();
    await refreshDiscovery();
  });

  sdk.backend.onEvent("nextjs-actions.action-added", (entry) => {
    actions.value = [...actions.value, entry];
  });

  await onFindAllActions();
});
</script>

<template>
  <div class="h-full flex flex-col gap-3 p-3">
    <div class="flex flex-wrap items-center gap-2">
      <div class="text-sm text-surface-400">Status: {{ status }}</div>
      <div class="text-xs text-surface-500">Made by fir3cr4ckers</div>
      <div class="flex-1" />
      <Button label="Scan Proxy History" size="small" @click="onScanHistory" />
      <Button
        label="Extract Action Names"
        size="small"
        severity="secondary"
        @click="onExtractNames"
      />
      <Button
        label="Find Unused Actions"
        size="small"
        severity="secondary"
        @click="onFindAllActions"
      />
      <Button
        label="Export Analysis"
        size="small"
        severity="secondary"
        @click="onExport"
      />
      <Button
        label="Clear"
        size="small"
        severity="secondary"
        @click="onClear"
      />
    </div>

    <div class="flex gap-2 items-center">
      <span class="text-sm">Action Filter:</span>
      <InputText v-model="filterText" class="w-96" />
    </div>

    <div class="flex-1 grid grid-cols-2 gap-3 min-h-0">
      <div class="min-h-0 flex flex-col gap-2">
        <div class="text-sm font-medium">All Requests</div>

        <div class="border rounded overflow-auto flex-1">
          <table class="w-full text-xs">
            <thead class="sticky top-0 bg-surface-900">
              <tr>
                <th class="text-left p-2">Method</th>
                <th class="text-left p-2">URL</th>
                <th class="text-left p-2">Action ID</th>
                <th class="text-left p-2">Status</th>
                <th class="text-left p-2">Security Notes</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="entry in filteredActions"
                :key="entry.requestId"
                class="cursor-pointer hover:bg-surface-800"
                @click="onRowClick(entry)"
              >
                <td class="p-2">{{ entry.method }}</td>
                <td class="p-2 break-all">{{ entry.url }}</td>
                <td class="p-2 break-all">
                  <div class="flex items-center gap-2">
                    <span class="break-all">{{ entry.actionId }}</span>
                    <Button
                      label="Copy ID"
                      size="small"
                      severity="secondary"
                      @click.stop="copyActionId(entry.actionId)"
                    />
                    <Button
                      label="Test Replay"
                      size="small"
                      severity="secondary"
                      @click.stop="createTestReplay(entry.actionId)"
                    />
                  </div>
                </td>
                <td class="p-2">{{ entry.statusCode }}</td>
                <td class="p-2 break-all">{{ entry.securityNotes }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="grid grid-cols-2 gap-2 min-h-0" style="height: 260px">
          <div ref="reqRoot" class="min-h-0 border rounded overflow-hidden" />
          <div ref="respRoot" class="min-h-0 border rounded overflow-hidden" />
        </div>

        <div class="flex flex-col gap-2">
          <div class="text-sm font-medium">Action Notes</div>
          <Textarea v-model="actionNotes" rows="4" class="w-full" />
          <Button label="Save Notes" size="small" @click="onSaveNotes" />
        </div>
      </div>

      <div class="min-h-0 flex flex-col gap-2">
        <div class="text-sm font-medium">Action Discovery</div>
        <div class="text-xs text-surface-400">{{ discovery?.status }}</div>
        <div class="text-xs text-surface-400">
          Tip: click a discovered action to open its chunk.
        </div>

        <div class="grid grid-rows-3 gap-2 min-h-0">
          <div class="min-h-0 border rounded overflow-auto">
            <div class="text-xs p-2 font-medium">All Discovered Actions</div>
            <table class="w-full text-xs">
              <thead class="sticky top-0 bg-surface-900">
                <tr>
                  <th class="text-left p-2">Function</th>
                  <th class="text-left p-2">Status</th>
                  <th class="text-left p-2">Executed</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="a in discovery?.all ?? []"
                  :key="a.actionId"
                  class="hover:bg-surface-800 cursor-pointer"
                  @click="openChunkForAction(a.actionId)"
                >
                  <td class="p-2 break-all">
                    <div class="flex items-center gap-2">
                      <span class="break-all">{{ a.functionName }}</span>
                      <Button
                        label="Copy ID"
                        size="small"
                        severity="secondary"
                        @click.stop="copyActionId(a.actionId)"
                      />
                      <Button
                        label="Test Replay"
                        size="small"
                        severity="secondary"
                        @click.stop="createTestReplay(a.actionId)"
                      />
                    </div>
                  </td>
                  <td class="p-2">{{ a.status }}</td>
                  <td class="p-2">{{ a.executedCount }}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="min-h-0 border rounded overflow-auto">
            <div class="text-xs p-2 font-medium">
              Unused Actions (Never Executed)
            </div>
            <table class="w-full text-xs">
              <thead class="sticky top-0 bg-surface-900">
                <tr>
                  <th class="text-left p-2">Function</th>
                  <th class="text-left p-2">Action ID</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="a in discovery?.unused ?? []"
                  :key="a.actionId"
                  class="hover:bg-surface-800 cursor-pointer"
                  @click="openChunkForAction(a.actionId)"
                >
                  <td class="p-2 break-all">
                    <div class="flex items-center gap-2">
                      <span class="break-all">{{ a.functionName }}</span>
                      <Button
                        label="Copy ID"
                        size="small"
                        severity="secondary"
                        @click.stop="copyActionId(a.actionId)"
                      />
                      <Button
                        label="Test Replay"
                        size="small"
                        severity="secondary"
                        @click.stop="createTestReplay(a.actionId)"
                      />
                    </div>
                  </td>
                  <td class="p-2 break-all">{{ a.actionId }}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="min-h-0 border rounded overflow-auto">
            <div class="text-xs p-2 font-medium">
              Unknown Actions (No Source Found)
            </div>
            <table class="w-full text-xs">
              <thead class="sticky top-0 bg-surface-900">
                <tr>
                  <th class="text-left p-2">Action ID</th>
                  <th class="text-left p-2">Executed</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="a in discovery?.unknown ?? []"
                  :key="a.actionId"
                  class="hover:bg-surface-800"
                >
                  <td class="p-2 break-all">
                    <div class="flex items-center gap-2">
                      <span class="break-all">{{ a.actionId }}</span>
                      <Button
                        label="Copy ID"
                        size="small"
                        severity="secondary"
                        @click.stop="copyActionId(a.actionId)"
                      />
                      <Button
                        label="Test Replay"
                        size="small"
                        severity="secondary"
                        @click.stop="createTestReplay(a.actionId)"
                      />
                    </div>
                  </td>
                  <td class="p-2">{{ a.executedCount }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
