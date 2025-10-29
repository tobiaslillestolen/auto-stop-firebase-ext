import { createRequest, getMonitoringClient } from "./cloudMonitoring.js";
import { log, error } from "firebase-functions/logger";
import getPrice from "./getPrice.js";

// NOTE: Firebase pricing page says 200k/400k but typical
// Cloud Run pricing is 180k/360k. I assume there
// is a special free tier for Firebase.
// https://cloud.google.com/run/pricing?hl=en
// https://firebase.google.com/pricing
const FREE_CPU_SECONDS_PER_MONTH = 200_000;
const FREE_MEMORY_GB_SECONDS_PER_MONTH = 400_000;
const FREE_NETWORK_EGRESS_BYTES_PER_MONTH = 5 * 1024 * 1024 * 1024; // 5 GB
const FREE_REQUESTS_PER_MONTH = 2_000_000;

const DEFAULT_CPU_SECOND_COST = 0.000024; // USD per vCPU second
const DEFAULT_MEMORY_GB_SECOND_COST = 0.0000025; // USD per GiB-second
const DEFAULT_EGRESS_BANDWIDTH_COST = 0.12; // USD per GB
const DEFAULT_REQUEST_COST = 0.4; // USD per million requests

export const getCloudFunctionsCost = async (projectId, startOfMonthTs) => {
  const monitoringClient = getMonitoringClient();

  const cpuRequest = createRequest(
    projectId,
    startOfMonthTs,
    "run.googleapis.com/container/cpu/allocation_time",
  );

  const memRequest = createRequest(
    projectId,
    startOfMonthTs,
    "run.googleapis.com/container/memory/allocation_time",
  );

  const netRequest = createRequest(
    projectId,
    startOfMonthTs,
    "run.googleapis.com/container/network/sent_bytes_count",
  );

  const reqRequest = createRequest(
    projectId,
    startOfMonthTs,
    "run.googleapis.com/request_count",
  );

  const [cpuResult, memResult, netResult, reqResult] = await Promise.all([
    monitoringClient.listTimeSeries(cpuRequest),
    monitoringClient.listTimeSeries(memRequest),
    monitoringClient.listTimeSeries(netRequest),
    monitoringClient.listTimeSeries(reqRequest),
  ]);

  log(`Allocated CPU time for Cloud Functions V2:`);
  let cpuSecondsV2 = 0;
  cpuResult[0].forEach((entry) => {
    let entrySeconds = 0;
    entry.points.forEach((point) => {
      if (point.value.doubleValue === "0") return;
      const parsedSeconds = parseFloat(point.value.doubleValue);

      if (!isFinite(parsedSeconds)) {
        throw new Error("Invalid CPU seconds - NaN/Infinite");
      } else if (parsedSeconds < 0) {
        throw new Error("Invalid CPU seconds - must be greater than 0");
      }

      entrySeconds += parsedSeconds;
    });

    const entryName =
      entry?.resource?.labels?.service_name ?? "unknown_function";
    const entryRevision =
      entry?.resource?.labels?.revision_name ?? "unknown_revision";
    log(
      `  Billable vCPU seconds ${entryName} (revision ${entryRevision}): ${entrySeconds} seconds`,
    );
    cpuSecondsV2 += entrySeconds;
  });

  log(`Allocated Memory time for Cloud Functions V2:`);
  let memGbSecondsV2 = 0;
  memResult[0].forEach((entry) => {
    let entrySeconds = 0;
    entry.points.forEach((point) => {
      if (point.value.doubleValue === "0") return;
      const parsedSeconds = parseFloat(point.value.doubleValue);

      if (!isFinite(parsedSeconds)) {
        throw new Error("Invalid memory GB-seconds - NaN/Infinite");
      } else if (parsedSeconds < 0) {
        throw new Error("Invalid memory GB-seconds - must be greater than 0");
      }

      entrySeconds += parsedSeconds;
    });

    const entryName =
      entry?.resource?.labels?.service_name ?? "unknown_function";
    const entryRevision =
      entry?.resource?.labels?.revision_name ?? "unknown_revision";
    log(
      `  Billable memory GB-seconds ${entryName} (revision ${entryRevision}): ${entrySeconds} seconds`,
    );
    memGbSecondsV2 += entrySeconds;
  });

  let neworkEgreessBytesV2 = 0;
  netResult[0].forEach((entry) => {
    let entryBytes = 0;
    entry.points.forEach((point) => {
      if (point.value.int64Value === "0") return;
      const parsedBytes = parseInt(point.value.int64Value, 10);

      if (!isFinite(parsedBytes)) {
        throw new Error("Invalid byte count - NaN/Infinite");
      } else if (parsedBytes < 0) {
        throw new Error("Invalid byte count - must be greater than 0");
      }

      entryBytes += parsedBytes;
    });

    const entryName =
      entry?.resource?.labels?.service_name ?? "unknown_function";
    const entryRevision =
      entry?.resource?.labels?.revision_name ?? "unknown_revision";
    const networkType = entry?.metric?.labels?.kind ?? "unknown_kind";
    const entryGb = entryBytes / (1024 * 1024 * 1024);
    log(
      `  Network egress for ${entryName}-${networkType} (revision ${entryRevision}): ${entryBytes} bytes. (${entryGb.toFixed(2)} GB)`,
    );

    neworkEgreessBytesV2 += entryBytes;
  });

  let requestCount = 0;
  reqResult[0].forEach((entry) => {
    let entryRequests = 0;
    entry.points.forEach((point) => {
      if (point.value.int64Value === "0") return;
      const parsedRequests = parseInt(point.value.int64Value, 10);

      if (!isFinite(parsedRequests)) {
        throw new Error("Invalid request count - NaN/Infinite");
      } else if (parsedRequests < 0) {
        throw new Error("Invalid request count - must be greater than 0");
      }

      entryRequests += parsedRequests;
    });

    const entryName =
      entry?.resource?.labels?.configuration_name ?? "unknown_function";
    const revisionName =
      entry?.resource?.labels?.revision_name ?? "unknown_revision";
    const responseCode = entry?.metric?.labels?.response_code ?? "unknown_code";
    log(
      `  Requests for ${entryName} (revision ${revisionName}, response code ${responseCode}): ${entryRequests} requests.`,
    );
    requestCount += entryRequests;
  });

  const cpuPrice = getPrice(
    "Cloud Functins (v2) vCPU time",
    process.env.MONITOR_CLOUD_FUNCTIONS_CPU_SECOND_COST,
    DEFAULT_CPU_SECOND_COST,
    0.000001, // USD per vCPU second
    0.1, // USD per vCPU second
  );

  const memPrice = getPrice(
    "Cloud Functions memory GB-second",
    process.env.MONITOR_CLOUD_FUNCTIONS_MEMORY_GB_SECOND_COST,
    DEFAULT_MEMORY_GB_SECOND_COST,
    0.000001, // USD per GB-second
    0.1, // USD per GB-second
  );

  const netPrice = getPrice(
    "Cloud Functions egress bandwidth",
    process.env.MONITOR_CLOUD_FUNCTIONS_EGRESS_BANDWIDTH_COST,
    DEFAULT_EGRESS_BANDWIDTH_COST,
    0.01, // USD per GB
    5, // USD per GB
  );

  const reqPrice = getPrice(
    "Cloud Functions requests",
    process.env.MONITOR_CLOUD_FUNCTIONS_REQUEST_COST,
    DEFAULT_REQUEST_COST,
    0.01, // USD per million requests
    5, // USD per million requests
  );

  const paidCpuSecondsV2 = Math.max(
    0,
    cpuSecondsV2 - FREE_CPU_SECONDS_PER_MONTH,
  );
  const paidMemGbSecondsV2 = Math.max(
    0,
    memGbSecondsV2 - FREE_MEMORY_GB_SECONDS_PER_MONTH,
  );
  const paidNetworkEgressBytesV2 = Math.max(
    0,
    neworkEgreessBytesV2 - FREE_NETWORK_EGRESS_BYTES_PER_MONTH,
  );
  const paidRequestCount = Math.max(0, requestCount - FREE_REQUESTS_PER_MONTH);

  const cpuCost = paidCpuSecondsV2 * cpuPrice;
  const memCost = paidMemGbSecondsV2 * memPrice;

  const paidEgressGb = paidNetworkEgressBytesV2 / (1024 * 1024 * 1024);
  const netCost = paidEgressGb * netPrice;

  const requestMillions = paidRequestCount / 1_000_000;
  const requestCost = requestMillions * reqPrice;

  log(`Cloud Functions V2 Cost Calculation:`);
  log(
    `  CPU: ${paidCpuSecondsV2.toFixed(2)} paid vCPU seconds @ $${cpuPrice}/vCPU-second = $${cpuCost.toFixed(2)}. Used ${Math.min(FREE_CPU_SECONDS_PER_MONTH, cpuSecondsV2.toFixed(2))}/${FREE_CPU_SECONDS_PER_MONTH} free vCPU seconds`,
  );
  log(
    `  Memory: ${paidMemGbSecondsV2.toFixed(2)} paid GB-seconds @ $${memPrice}/GB-second = $${memCost.toFixed(2)}. Used ${Math.min(FREE_MEMORY_GB_SECONDS_PER_MONTH, memGbSecondsV2.toFixed(2))}/${FREE_MEMORY_GB_SECONDS_PER_MONTH} free GB-seconds`,
  );
  log(
    `  Network Egress: ${paidNetworkEgressBytesV2.toFixed(2)} paid bytes (${paidEgressGb.toFixed(2)} GB) @ $${netPrice}/GB = $${netCost.toFixed(2)}. Used ${Math.min(FREE_NETWORK_EGRESS_BYTES_PER_MONTH, neworkEgreessBytesV2.toFixed(2))}/${FREE_NETWORK_EGRESS_BYTES_PER_MONTH} free bytes`,
  );
  log(
    `  Requests: ${paidRequestCount} paid requests (${requestMillions.toFixed(2)} million) @ $${reqPrice}/million = $${requestCost.toFixed(2)}. Used ${Math.min(FREE_REQUESTS_PER_MONTH, requestCount)}/${FREE_REQUESTS_PER_MONTH} free requests`,
  );

  const totalCost = cpuCost + memCost + netCost + requestCost;
  log(`  Total Cloud Functions V2 Cost: $${totalCost.toFixed(2)}`);

  return totalCost;
};
